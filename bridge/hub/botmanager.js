// Hosts engine BotHandles: one action at a time per bot, timeouts, interrupt, auto-reconnect, event ring buffer.
import { EventEmitter } from 'node:events';
import { HttpError, sleep, log, logErr, clamp, str, now } from './util.js';

const SPAWN_TIMEOUT_MS = 60000;
const EVENT_RING = 50;
const NOISY_KINDS = new Set(['item_picked_up']); // kept in recentEvents but not turned into system messages
const ABORT_GRACE_MS = 5000;
// hub services that post messages but are not humans: their notices (sales, outbids...) never interrupt a bot
const SERVICE_SENDERS = new Set(['system', 'Market']);

class Slot {
  constructor(name, role) {
    this.name = name;
    this.role = role || null;
    this.handle = null;
    this.status = 'connecting'; // connecting | online | offline
    this.current = null; // {action,args,started,controller,done:Promise}
    this.recentEvents = [];
    this.lastState = null;
    this.lastError = null;
    this.reconnectAttempt = 0;
    this.reconnectTimer = null;
    this.reconnectAt = 0;
    this.removed = false;
    this.spawning = null;
    this.lastAction = null; // {action, ok, ts}
  }
}

export class BotManager extends EventEmitter {
  constructor({ engine, store, spawnOpts = {} }) {
    super();
    this.engine = engine;
    this.store = store;
    this.spawnOpts = spawnOpts;
    this.slots = new Map();
    this._recentChat = new Map(); // dedupe key -> ts
    this._recentSys = new Map();
    // A message from a human (the player on the dashboard, or any non-bot player in game) interrupts the
    // receiving bots' current action, so the agent's blocked tool call returns at once with the text
    // instead of the message waiting up to ~3 minutes behind a long goto/collect/smelt.
    store.on('change', ({ type, data }) => {
      if (type !== 'msg' || !data || SERVICE_SENDERS.has(data.from) || this.has(data.from)) return;
      const targets = data.to === 'all' ? [...this.slots.values()]
        : [...this.slots.values()].filter((x) => String(data.to).toLowerCase().split(',').includes(x.name.toLowerCase()));
      for (const s of targets) {
        if (!s.current) continue;
        log(`interrupting ${s.name}'s ${s.current.action}: message from ${data.from}`);
        this._abortCurrent(s, `interrupted because ${data.from} (human) sent you a message: "${String(data.text).slice(0, 300)}". Answer/act on it now`).catch((e) => logErr('interrupt failed:', e.message));
      }
    });
  }

  get actions() {
    return this.engine.ACTIONS;
  }

  slot(name) {
    const s = this.slots.get(name) || [...this.slots.values()].find((x) => x.name.toLowerCase() === String(name).toLowerCase());
    if (!s) throw new HttpError(404, `no bot named "${name}" (spawn it with POST /bots)`);
    return s;
  }

  has(name) {
    return this.slots.has(name);
  }

  names() {
    return [...this.slots.keys()];
  }

  // ---------- lifecycle ----------
  async ensure(name, role) {
    let s = this.slots.get(name);
    if (!s) {
      s = new Slot(name, role);
      this.slots.set(name, s);
      this.store.botRoles[name] = role || this.store.botRoles[name] || null;
      this.store.save();
    } else if (role) {
      s.role = role;
      this.store.botRoles[name] = role;
      this.store.save();
    }
    if (!s.role) s.role = this.store.botRoles[name] || null;
    if (s.status === 'online') return s;
    if (!s.spawning) s.spawning = this._connect(s).finally(() => (s.spawning = null));
    try {
      await s.spawning;
    } catch (e) {
      // _connect already scheduled a reconnect; report to the caller
      throw new HttpError(502, `bot ${name} failed to join: ${e.message} (will keep retrying in background)`);
    }
    return s;
  }

  async _connect(s) {
    s.status = 'connecting';
    this._emitBots();
    clearTimeout(s.reconnectTimer);
    try {
      const handle = await Promise.race([
        this.engine.spawnBot({ name: s.name, ...this.spawnOpts }),
        sleep(SPAWN_TIMEOUT_MS).then(() => {
          throw new Error(`spawn timed out after ${SPAWN_TIMEOUT_MS / 1000}s`);
        }),
      ]);
      if (s.removed) {
        try { await handle.quit(); } catch {}
        return;
      }
      this._attach(s, handle);
      s.status = 'online';
      s.reconnectAttempt = 0;
      s.lastError = null;
      log(`bot ${s.name} online`);
      this._pushEvent(s, 'joined', `${s.name} joined the game`, false);
      this._emitBots();
    } catch (e) {
      s.status = 'offline';
      s.lastError = e.message;
      logErr(`bot ${s.name} spawn failed:`, e.message);
      this._scheduleReconnect(s);
      this._emitBots();
      throw e;
    }
  }

  _attach(s, handle) {
    s.handle = handle;
    handle.on?.('chat', (c) => {
      try { this._onChat(s, c); } catch (e) { logErr('chat handler:', e.message); }
    });
    handle.on?.('event', (ev) => {
      try { this._onEvent(s, handle, ev); } catch (e) { logErr('event handler:', e.message); }
    });
    handle.on?.('offline', (info) => {
      if (s.handle !== handle) return; // stale
      this._onOffline(s, info?.reason || info?.message || 'disconnected');
    });
    handle.on?.('error', (e) => logErr(`bot ${s.name} error:`, e?.message || e));
    for (const ev of ['ledger', 'path', 'pose']) handle.on?.(ev, (p) => { if (s.handle === handle) this.emit(`mod:${ev}`, s.name, p); }); // hub/mod-api.js
  }

  _onOffline(s, reason) {
    if (s.status === 'offline' && !s.handle) return;
    log(`bot ${s.name} offline: ${reason}`);
    if (s.lastState) s.lastState = { ...s.lastState, online: false }; // keep last known position/inventory for the dashboard
    s.status = 'offline';
    s.lastError = String(reason);
    const h = s.handle;
    s.handle = null;
    try { h?.quit?.(); } catch {}
    if (s.current) s.current.controller.abort(new Error('bot went offline'));
    this._pushEvent(s, 'offline', `disconnected: ${reason}`, false);
    this._scheduleReconnect(s);
    this._emitBots();
  }

  _scheduleReconnect(s) {
    if (s.removed || s.reconnectTimer) return;
    const delay = Math.min(60000, 2000 * 2 ** s.reconnectAttempt);
    s.reconnectAttempt++;
    s.reconnectAt = now() + delay;
    s.reconnectTimer = setTimeout(async () => {
      s.reconnectTimer = null;
      if (s.removed || s.status === 'online') return;
      log(`bot ${s.name} reconnecting (attempt ${s.reconnectAttempt})`);
      if (!s.spawning) s.spawning = this._connect(s).catch(() => {}).finally(() => (s.spawning = null));
    }, delay);
  }

  async remove(name) {
    const s = this.slot(name);
    s.removed = true;
    clearTimeout(s.reconnectTimer);
    s.reconnectTimer = null;
    if (s.current) s.current.controller.abort(new Error('bot removed'));
    const h = s.handle;
    s.handle = null;
    s.status = 'offline';
    this.slots.delete(s.name);
    try { await h?.quit?.(); } catch (e) { logErr('quit failed:', e.message); }
    this._emitBots();
  }

  async shutdown() {
    await Promise.allSettled([...this.slots.keys()].map((n) => this.remove(n)));
  }

  // ---------- events & chat ----------
  _pushEvent(s, kind, text, toMessage = true) {
    const ev = { ts: now(), kind, text: str(text, 400) };
    s.recentEvents.push(ev);
    if (s.recentEvents.length > EVENT_RING) s.recentEvents.shift();
    this.emit('event', s.name, ev);
    if (toMessage && !NOISY_KINDS.has(kind)) {
      const key = s.name + kind + ev.text;
      const last = this._recentSys.get(key);
      if (!last || ev.ts - last > 3000) {
        this._recentSys.set(key, ev.ts);
        this.store.addMessage({ from: 'system', to: s.name, text: `[${kind}] ${ev.text}` });
      }
      if (this._recentSys.size > 300) for (const [k, t] of this._recentSys) if (ev.ts - t > 10000) this._recentSys.delete(k);
    }
  }

  _onEvent(s, handle, ev) {
    if (s.handle !== handle) return;
    this._pushEvent(s, ev?.kind || 'event', ev?.text || '');
  }

  isBotName(n) {
    if (!n) return false;
    const l = String(n).toLowerCase();
    for (const k of this.slots.keys()) if (k.toLowerCase() === l) return true;
    for (const k of Object.keys(this.store.botRoles)) if (k.toLowerCase() === l) return true;
    return false;
  }

  _onChat(s, { username, message }) {
    if (!username || !message) return;
    if (this.isBotName(username)) return; // bot chat is mirrored from /msg; never re-ingest (no echo loops)
    // every online bot hears the same line: ingest once
    const key = username + '\u0000' + message;
    const t = now();
    const last = this._recentChat.get(key);
    this._recentChat.set(key, t);
    if (last && t - last < 3000) return;
    if (this._recentChat.size > 200) for (const [k, v] of this._recentChat) if (t - v > 10000) this._recentChat.delete(k);
    // @mentions anywhere in the line ("@Stella hi", "hi @stella!", "@Stella @Colin ...") are resolved by
    // store.addMessage (routeMentions): only the mentioned bots receive it and only they are interrupted.
    this.store.addMessage({ from: username, to: 'all', text: String(message) });
  }

  /** Make a bot say `@to text` in MC chat (long text split). */
  say(fromName, to, text) {
    const s = this.slots.get(fromName);
    if (!s?.handle?.bot || s.status !== 'online') return false;
    const line = `@${to} ${text}`.replace(/\s*\n+\s*/g, ' ');
    const chunks = [];
    for (let i = 0; i < line.length && chunks.length < 3; i += 220) chunks.push(line.slice(i, i + 220));
    try {
      const speak = (c) => { try { s.handle?.bot?.chat(c); } catch (e) { logErr(`chat by ${fromName} failed:`, e.message); } };
      chunks.forEach((c, i) => (i === 0 ? speak(c) : setTimeout(() => speak(c), i * 400)));
      return true;
    } catch (e) {
      logErr(`say failed for ${fromName}:`, e.message);
      return false;
    }
  }

  // ---------- actions ----------
  /** Run an action. Always resolves to {ok, result|error}; throws HttpError only for unknown bot. */
  async act(name, { action, args = {}, timeoutMs = 180000, interrupt = false } = {}) {
    const s = this.slot(name);
    if (typeof action !== 'string' || !action) return { ok: false, error: 'action is required' };
    if (action === 'stop') return this.stop(name, true);
    if (s.status !== 'online' || !s.handle) {
      return { ok: false, error: `bot ${s.name} is ${s.status}${s.lastError ? ' (' + s.lastError + ')' : ''}; ${s.status === 'offline' ? 'reconnecting automatically, try again in a few seconds' : 'still joining'}` };
    }
    if (!this.actions.some((a) => a.name === action)) {
      return { ok: false, error: `unknown action "${action}". Known: ${this.actions.map((a) => a.name).join(', ')}` };
    }
    if (s.current) {
      if (!interrupt) return { ok: false, busy: true, error: `busy: ${s.current.action}` };
      await this._abortCurrent(s, `interrupted by ${action}`);
    }
    const timeout = clamp(timeoutMs, 1000, 900000, 180000);
    const controller = new AbortController();
    const cur = { action, args, started: now(), controller, done: null };
    s.current = cur;
    this._emitBots();
    const timer = setTimeout(() => controller.abort(new Error(`timeout after ${Math.round(timeout / 1000)}s`)), timeout);
    const handle = s.handle;
    cur.done = (async () => {
      try {
        const result = await handle.run(action, args || {}, { signal: controller.signal });
        if (controller.signal.aborted && /^Stopped/i.test(String(result))) throw controller.signal.reason;
        return { ok: true, result };
      } catch (e) {
        const reason = controller.signal.aborted ? controller.signal.reason : null;
        let msg = e?.message || String(e);
        if (reason && /timeout/.test(reason.message)) msg = `${reason.message} while running ${action} (action was stopped). ${/^Stopped/i.test(msg) ? '' : msg}`.trim();
        else if (reason && !/^Stopped/i.test(msg)) msg = `${msg} (${reason.message})`;
        else if (reason && /^Stopped/i.test(msg)) msg = `Stopped: ${reason.message}`;
        return { ok: false, error: msg };
      }
    })();
    // never wait forever for an engine that ignores abort
    const outcome = await Promise.race([
      cur.done,
      new Promise((res) => {
        controller.signal.addEventListener('abort', () => {
          setTimeout(() => res({ ok: false, error: `${controller.signal.reason?.message || 'aborted'}; engine did not stop within ${ABORT_GRACE_MS / 1000}s` }), ABORT_GRACE_MS);
        });
      }),
    ]);
    clearTimeout(timer);
    if (s.current === cur) {
      s.current = null;
      s.lastAction = { action, ok: outcome.ok, ts: now() };
      this._emitBots();
    }
    return outcome;
  }

  async _abortCurrent(s, why) {
    const cur = s.current;
    if (!cur) return;
    cur.controller.abort(new Error(why));
    try { s.handle?.stop?.(); } catch (e) { logErr('handle.stop failed:', e.message); }
    await Promise.race([cur.done.catch(() => {}), sleep(ABORT_GRACE_MS)]);
    if (s.current === cur) s.current = null;
  }

  async stop(name, viaAct = false) {
    const s = this.slot(name);
    const was = s.current?.action;
    if (s.current) await this._abortCurrent(s, 'stopped by request');
    else try { s.handle?.stop?.(); } catch (e) { logErr('handle.stop failed:', e.message); }
    this._emitBots();
    return viaAct ? { ok: true, result: was ? `Stopped (was running ${was}).` : 'Stopped (nothing was running).' } : { ok: true, was: was || null };
  }

  // ---------- views ----------
  _safeState(s) {
    if (s.handle && s.status === 'online') {
      try {
        const st = s.handle.getState();
        s.lastState = st;
        return st;
      } catch (e) {
        logErr(`getState(${s.name}) failed:`, e.message);
      }
    }
    return s.lastState ? { ...s.lastState, online: false } : { name: s.name, online: false };
  }

  state(name) {
    const s = this.slot(name);
    const st = this._safeState(s);
    return { ...st, name: s.name, online: s.status === 'online', status: s.status, role: s.role, currentAction: s.current?.action || null, recentEvents: s.recentEvents.slice(-10) };
  }

  summary(s, full = false) {
    const st = this._safeState(s);
    const o = {
      name: s.name,
      role: s.role,
      online: s.status === 'online',
      status: s.status,
      pos: st.pos || null,
      health: st.health ?? null,
      food: st.food ?? null,
      currentAction: s.current?.action || null,
      busyForMs: s.current ? now() - s.current.started : 0,
      held: st.held || null,
      dimension: st.dimension || null,
      lastThought: this.store.lastThought(s.name),
    };
    if (s.status === 'offline') {
      o.lastError = s.lastError;
      o.reconnectInMs = s.reconnectAt ? Math.max(0, s.reconnectAt - now()) : null;
    }
    if (full) {
      o.inventory = st.inventory || [];
      o.armor = st.armor || [];
      o.time = st.time || null;
      o.biome = st.biome || null;
      o.currentArgs = s.current?.args || null;
      o.lastAction = s.lastAction;
      const near = st.nearbyEntities || [];
      o.hostiles = near.filter((e) => e.type === 'hostile').length;
      o.lastEvent = s.recentEvents.at(-1) || null;
    }
    return o;
  }

  list(full = false) {
    return [...this.slots.values()].map((s) => this.summary(s, full));
  }

  _emitBots() {
    this.emit('bots');
  }
}
