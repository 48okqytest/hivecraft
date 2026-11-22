// Block ledger: which bot placed / broke which block, when and why.
//
// Two halves in one file:
//   installLedger(handle)  ENGINE side (runs in the bot's worker thread). Wraps bot.dig / bot.placeBlock /
//                          bot.activateBlock so every block change the bot itself causes (actions, blueprint
//                          executor, pathfinder digging + scaffolding, escape pillars, auto behaviours) is reported
//                          as handle.emit('ledger', event). Also emits 'path' (pathfinder route) and 'pose'
//                          (float position + yaw/pitch, ~5 Hz) for the overlay mod. Never throws into the engine.
//   LedgerStore            HUB side (main thread). Appends events to <dataDir>/ledger/YYYY-MM-DD.jsonl,
//                          keeps a capped in-memory ring + per-position index for area / block-history queries.
//
// Blueprint executor sets handle.ledgerCtx = {build, section, phase} while it works (see executor.js).
import fs from 'node:fs';
import path from 'node:path';

// ===================================================================================== engine side

const stateStr = (b) => {
  try {
    const p = b?.getProperties?.();
    if (!p) return '';
    const keys = Object.keys(p).sort();
    return keys.map((k) => `${k}=${p[k]}`).join(',');
  } catch { return ''; }
};
const AIR = new Set(['air', 'cave_air', 'void_air']);
const isAir = (n) => !n || AIR.has(n);
const fl = Math.floor;

/** Map the running action (and op) to a short cause tag. */
export function causeFor(action, op) {
  if (!action) return 'idle';
  if (action.startsWith('auto:')) return 'auto';
  switch (action) {
    case 'collect': return 'collect';
    case 'mine_block': return 'mine';
    case 'place': case 'build': return 'place';
    case 'run_code': return 'code';
    case 'escape': case 'surface': case 'goto': case 'goto_player': case 'follow': case 'hunt': case 'attack':
      return op === 'place' ? 'scaffold' : 'tunnel';
    default:
      if (action.startsWith('blueprint_')) return 'blueprint';
      return action;
  }
}

/** Hook a BotHandle (bridge/engine/handle.js). Safe to call twice; safe if pathfinder isn't loaded yet. */
export function installLedger(h) {
  const bot = h?.bot;
  if (!bot || bot.__hiveLedger) return;
  bot.__hiveLedger = true;
  const emit = (kind, ev) => { try { h.emit(kind, ev); } catch { /* listener errors never reach the engine */ } };
  const dim = () => {
    const d = String(bot.game?.dimension || 'overworld').replace('minecraft:', '').replace('the_', '');
    return d === 'nether' ? 'nether' : d;
  };
  const context = (op) => {
    const action = h.current?.name || h.bg?.name || (h.autoLabel ? `auto:${h.autoLabel}` : null);
    const L = h.ledgerCtx;
    const pf = bot.pathfinder;
    let cause;
    if (op === 'break' && pf?.isMining?.()) cause = 'pathfinder-dig';
    else if (op === 'place' && pf?.isBuilding?.()) cause = 'pathfinder-place';
    else if (L?.build) cause = 'blueprint';
    else cause = causeFor(action, op);
    const c = { cause, action };
    if (L?.build) { c.build = L.build; c.section = L.section ?? null; c.phase = L.phase || null; }
    return c;
  };
  const record = (op, pos, blockName, state, prev, ctx) => {
    const ev = { ts: Date.now(), bot: h.name, op, block: blockName, state: state || '', x: fl(pos.x), y: fl(pos.y), z: fl(pos.z), dim: dim(), ...ctx };
    if (op === 'place') ev.prev = prev || 'air';
    emit('ledger', ev);
  };

  // --- dig: what was there before, confirmed gone after
  const origDig = bot.dig;
  if (typeof origDig === 'function') {
    bot.dig = function hiveLedgerDig(block, ...rest) {
      let before = null, ctx = null;
      try { if (block?.position) { before = { pos: block.position.clone ? block.position.clone() : block.position, name: block.name, state: stateStr(block) }; ctx = context('break'); } } catch { /* */ }
      const p = origDig.call(this, block, ...rest);
      if (!before || !p?.then) return p;
      return p.then((r) => {
        try {
          const now = bot.blockAt(before.pos);
          if (!isAir(before.name) && (!now || now.name !== before.name)) record('break', before.pos, before.name, before.state, null, ctx);
        } catch { /* */ }
        return r;
      });
    };
  }

  // --- placeBlock: destination = reference + face; record the new block (with state) after the server confirms
  const origPlace = bot.placeBlock;
  if (typeof origPlace === 'function') {
    bot.placeBlock = function hiveLedgerPlace(ref, face, ...rest) {
      let dest = null, prev = null, ctx = null;
      try {
        if (ref?.position && face) {
          dest = ref.position.plus(face);
          prev = bot.blockAt(dest)?.name || 'air';
          ctx = context('place');
        }
      } catch { /* */ }
      const p = origPlace.call(this, ref, face, ...rest);
      if (!dest || !p?.then) return p;
      const after = () => {
        try {
          const now = bot.blockAt(dest);
          if (now && !isAir(now.name) && now.name !== prev) record('place', dest, now.name, stateStr(now), prev, ctx);
        } catch { /* */ }
      };
      // a failed place may still have placed (server slow to confirm): check both ways
      return p.then((r) => { after(); return r; }, (e) => { after(); throw e; });
    };
  }

  // --- activateBlock / useOn: seeds on farmland, hoe tilling, buckets... only count a real block-name change
  // at the clicked block or the one in front of the clicked face, within 1.5 s.
  const watch = []; // {pos, names:Map(key->name), until, ctx}
  const keyOf = (p) => `${p.x},${p.y},${p.z}`;
  const origAct = bot.activateBlock;
  if (typeof origAct === 'function') {
    bot.activateBlock = function hiveLedgerActivate(block, direction, ...rest) {
      try {
        if (block?.position && bot.heldItem) {
          const dir = direction || { x: 0, y: 1, z: 0 };
          const front = block.position.offset(dir.x, dir.y, dir.z);
          const names = new Map([[keyOf(block.position), block.name], [keyOf(front), bot.blockAt(front)?.name || 'air']]);
          watch.push({ names, until: Date.now() + 1500, ctx: null });
          watch.at(-1).ctx = context('place');
          if (watch.length > 8) watch.shift();
        }
      } catch { /* */ }
      return origAct.call(this, block, direction, ...rest);
    };
  }
  const onBlockUpdate = (oldB, newB) => {
    if (!watch.length || !newB?.position) return;
    const now = Date.now();
    while (watch.length && watch[0].until < now) watch.shift();
    const k = keyOf(newB.position);
    for (const w of watch) {
      if (!w.names.has(k)) continue;
      const was = w.names.get(k);
      if (was === newB.name) return;
      w.names.set(k, newB.name);
      if (isAir(newB.name)) { if (!isAir(was)) record('break', newB.position, was, stateStr(oldB), null, { ...w.ctx, cause: w.ctx.cause === 'idle' ? 'use' : w.ctx.cause }); }
      else record('place', newB.position, newB.name, stateStr(newB), was, w.ctx);
      return;
    }
  };
  bot.on('blockUpdate', onBlockUpdate);

  // --- pathfinder route (for path ribbons in the overlay), throttled
  let lastPathAt = 0, pathTimer = null, pendingPath = null;
  const flushPath = () => { pathTimer = null; if (pendingPath) { emit('path', pendingPath); pendingPath = null; lastPathAt = Date.now(); } };
  const queuePath = (msg) => {
    pendingPath = msg;
    const wait = 250 - (Date.now() - lastPathAt);
    if (wait <= 0) flushPath();
    else if (!pathTimer) pathTimer = setTimeout(flushPath, wait);
  };
  const goalPos = () => {
    const g = bot.pathfinder?.goal;
    if (!g) return null;
    const x = g.x ?? g.pos?.x, y = g.y ?? g.pos?.y, z = g.z ?? g.pos?.z;
    if (Number.isFinite(x) && Number.isFinite(z)) return { x: fl(x), y: Number.isFinite(y) ? fl(y) : null, z: fl(z) };
    const e = g.entity?.position;
    return e ? { x: fl(e.x), y: fl(e.y), z: fl(e.z) } : null;
  };
  bot.on('path_update', (r) => {
    try {
      const pts = (r?.path || []).slice(0, 64).map((p) => [fl(p.x), fl(p.y), fl(p.z)]);
      queuePath({ ts: Date.now(), dim: dim(), goal: goalPos(), points: pts, status: r?.status || 'success' });
    } catch { /* */ }
  });
  const cleared = () => queuePath({ ts: Date.now(), dim: dim(), goal: null, points: [], status: 'cleared' });
  bot.on('goal_reached', cleared);
  bot.on('path_stop', cleared);

  // --- pose: float position + look, only when it changed (~5 Hz)
  let last = '';
  const poseTimer = setInterval(() => {
    try {
      const e = bot.entity;
      if (!e?.position) return;
      const r2 = (v) => Math.round(v * 100) / 100;
      const pose = { x: r2(e.position.x), y: r2(e.position.y), z: r2(e.position.z), yaw: r2(e.yaw ?? 0), pitch: r2(e.pitch ?? 0), dim: dim() };
      const k = `${pose.x},${pose.y},${pose.z},${pose.yaw},${pose.pitch}`;
      if (k === last) return;
      last = k;
      emit('pose', pose);
    } catch { /* */ }
  }, 200);
  poseTimer.unref?.();
  bot.once('end', () => { clearInterval(poseTimer); clearTimeout(pathTimer); });
}

// ===================================================================================== hub side

const DAY = (ts) => new Date(ts).toISOString().slice(0, 10);
const posKey = (dim, x, y, z) => `${dim || 'overworld'}:${x},${y},${z}`;
const MAX_LINE = 600;

export class LedgerStore {
  /**
   * @param dir      <dataDir>/ledger
   * @param ringMax  newest events kept in memory for area queries
   * @param posMax   positions kept in the per-block history index (each ≤ perPos events)
   */
  constructor(dir, { ringMax = 50000, posMax = 120000, perPos = 4, loadDays = 3 } = {}) {
    this.dir = dir;
    this.ringMax = ringMax;
    this.posMax = posMax;
    this.perPos = perPos;
    this.ring = [];
    this.byPos = new Map(); // key -> [ev] oldest..newest (Map order = least recently touched first)
    this.nextId = 1;
    this.pending = [];
    this.timer = null;
    this.listeners = new Set();
    fs.mkdirSync(dir, { recursive: true });
    this._load(loadDays);
  }

  _load(days) {
    let files = [];
    try { files = fs.readdirSync(this.dir).filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort().slice(-days); } catch { return; }
    const evs = [];
    for (const f of files) {
      let text = '';
      try { text = fs.readFileSync(path.join(this.dir, f), 'utf8'); } catch { continue; }
      for (const line of text.split('\n')) {
        if (!line) continue;
        try { const e = JSON.parse(line); if (e && e.op && Number.isFinite(e.x)) evs.push(e); } catch { /* torn line */ }
      }
    }
    for (const e of evs.slice(-Math.max(this.ringMax, 1))) this._index(e);
    const maxId = evs.reduce((m, e) => Math.max(m, e.id || 0), 0);
    this.nextId = maxId + 1;
  }

  _index(e) {
    this.ring.push(e);
    if (this.ring.length > this.ringMax) this.ring.splice(0, this.ring.length - this.ringMax);
    const k = posKey(e.dim, e.x, e.y, e.z);
    let l = this.byPos.get(k);
    if (l) this.byPos.delete(k); else l = [];
    l.push(e);
    if (l.length > this.perPos) l.shift();
    this.byPos.set(k, l);
    if (this.byPos.size > this.posMax) {
      const drop = this.byPos.size - this.posMax;
      let i = 0;
      for (const key of this.byPos.keys()) { if (i++ >= drop) break; this.byPos.delete(key); }
    }
  }

  /** Add one engine event (bot, op, block, state, x,y,z, dim, cause, action, build?, section?, phase?, prev?). */
  add(raw) {
    if (!raw || (raw.op !== 'place' && raw.op !== 'break')) return null;
    const x = Number(raw.x), y = Number(raw.y), z = Number(raw.z);
    if (![x, y, z].every(Number.isFinite)) return null;
    const e = {
      id: this.nextId++, ts: Number(raw.ts) || Date.now(), bot: String(raw.bot || '?').slice(0, 24), op: raw.op,
      block: String(raw.block || '?').slice(0, 64), state: String(raw.state || '').slice(0, 300), x, y, z,
      dim: String(raw.dim || 'overworld').slice(0, 24), cause: String(raw.cause || 'unknown').slice(0, 32), action: raw.action ? String(raw.action).slice(0, 40) : null,
    };
    if (raw.op === 'place') e.prev = String(raw.prev || 'air').slice(0, 64);
    if (raw.build) { e.build = String(raw.build).slice(0, 120); e.section = raw.section ?? null; e.phase = raw.phase || null; }
    this._index(e);
    const line = JSON.stringify(e);
    if (line.length <= MAX_LINE) this.pending.push(line);
    if (!this.timer) { this.timer = setTimeout(() => this.flush(), 1000); this.timer.unref?.(); }
    for (const fn of this.listeners) { try { fn(e); } catch { /* */ } }
    return e;
  }

  onEvent(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  flush() {
    clearTimeout(this.timer);
    this.timer = null;
    if (!this.pending.length) return;
    const lines = this.pending;
    this.pending = [];
    // group by day of the event (usually one)
    const byDay = new Map();
    for (const l of lines) {
      let d = DAY(Date.now());
      try { d = DAY(JSON.parse(l).ts); } catch { /* */ }
      (byDay.get(d) || byDay.set(d, []).get(d)).push(l);
    }
    for (const [d, ls] of byDay) {
      try { fs.appendFileSync(path.join(this.dir, `${d}.jsonl`), ls.join('\n') + '\n'); } catch (e) { console.error('ledger write failed:', e.message); }
    }
  }

  close() { this.flush(); this.listeners.clear(); }

  /** History of one block, oldest -> newest. */
  at(x, y, z, dim = 'overworld') {
    return [...(this.byPos.get(posKey(dim, Math.floor(x), Math.floor(y), Math.floor(z))) || [])];
  }

  /** Latest event at a position, or null. */
  last(x, y, z, dim = 'overworld') {
    const l = this.byPos.get(posKey(dim, x, y, z));
    return l ? l[l.length - 1] : null;
  }

  /**
   * Area / filter query, newest first.
   * box: {x1,y1,z1,x2,y2,z2} (any missing pair = unbounded on that axis)
   */
  query({ box = null, bot = null, since = 0, until = 0, op = null, cause = null, dim = null, build = null, limit = 500 } = {}) {
    const lim = Math.max(1, Math.min(5000, Number(limit) || 500));
    const rng = (a, b) => {
      const A = Number(a), B = Number(b);
      if (!Number.isFinite(A) && !Number.isFinite(B)) return null;
      const lo = Number.isFinite(A) ? A : -Infinity, hi = Number.isFinite(B) ? B : Infinity;
      return [Math.min(lo, hi), Math.max(lo, hi)];
    };
    const bx = box ? rng(box.x1, box.x2) : null, by = box ? rng(box.y1, box.y2) : null, bz = box ? rng(box.z1, box.z2) : null;
    const botL = bot && bot !== 'all' ? String(bot).toLowerCase() : null;
    const out = [];
    let total = 0;
    for (let i = this.ring.length - 1; i >= 0; i--) {
      const e = this.ring[i];
      if (since && e.ts < since) break; // ring is in time order
      if (until && e.ts > until) continue;
      if (botL && e.bot.toLowerCase() !== botL) continue;
      if (op && e.op !== op) continue;
      if (cause && e.cause !== cause) continue;
      if (dim && e.dim !== dim) continue;
      if (build && e.build !== build) continue;
      if (bx && (e.x < bx[0] || e.x > bx[1])) continue;
      if (by && (e.y < by[0] || e.y > by[1])) continue;
      if (bz && (e.z < bz[0] || e.z > bz[1])) continue;
      total++;
      if (out.length < lim) out.push(e);
    }
    return { events: out, total, truncated: total > out.length, oldestInMemory: this.ring[0]?.ts ?? null };
  }

  recent(n = 200) { return this.ring.slice(-n); }

  /**
   * Blocks a bot deliberately placed that are still standing (last event at the spot is a place),
   * overworld only: [[x,y,z,block]]. Scaffolding and pathfinder pillars are temporary junk, not builds.
   */
  standing() {
    const out = [];
    for (const l of this.byPos.values()) {
      const e = l[l.length - 1];
      if (e.op !== 'place' || e.dim !== 'overworld') continue;
      if (e.cause === 'scaffold' || e.cause === 'auto' || e.cause === 'tunnel' || /pathfinder/.test(e.cause)) continue;
      if (e.phase === 'scaffold' || e.phase === 'unscaffold') continue;
      out.push([e.x, e.y, e.z, e.block]);
    }
    return out;
  }

  stats(sinceTs = 0) {
    const byBot = {};
    let total = 0;
    for (let i = this.ring.length - 1; i >= 0; i--) {
      const e = this.ring[i];
      if (e.ts < sinceTs) break;
      const b = (byBot[e.bot] ||= { place: 0, break: 0 });
      b[e.op]++;
      total++;
    }
    return { byBot, total };
  }
}
