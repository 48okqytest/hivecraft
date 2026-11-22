// Hub state: messages, task board, notes, waypoints, goal, per-agent logs + memory. Persisted to <dataDir>/hub.json.
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { HttpError, str, now, logErr, needName } from './util.js';

const MAX_MESSAGES = 1500;
const MAX_LOG_RING = 600;
export const STATUSES = ['open', 'claimed', 'done', 'blocked'];
export const LOG_KINDS = ['thought', 'tool', 'result', 'error', 'system'];
const ALL_WORDS = new Set(['all', 'everyone', 'everybody', 'team']);

/**
 * @mention routing for human messages. Finds "@Name" tokens (case-insensitive, any position, punctuation after the
 * name is fine; "mail@x" is not a mention). `canon(name)` returns the canonical bot name or null for non-bots.
 * Returns { to: 'all' | 'Stella' | 'Stella,Colin', text }. @all/@everyone (or no bot mention) -> 'all'.
 * Only a LEADING address ("@Stella hi", "@Stella: hi", "@Stella, @Colin - hi") is stripped from the text.
 */
export function routeMentions(text, canon) {
  text = String(text ?? '');
  const re = /(^|[^\w@])@(\w{1,16})/g;
  const names = [];
  let all = false;
  for (let m; (m = re.exec(text)); ) {
    if (ALL_WORDS.has(m[2].toLowerCase())) { all = true; continue; }
    const c = canon(m[2]);
    if (c && !names.includes(c)) names.push(c);
  }
  // strip the leading run of addresses (only if every one of them is a bot or @all) and a separator after it
  const lead = /^\s*((?:@\w{1,16}(?:[\s:,;.!?\-–—]+|$))+)/.exec(text);
  let body = text;
  if (lead) {
    const leadNames = [...lead[1].matchAll(/@(\w{1,16})/g)].map((x) => x[1]);
    if (leadNames.every((n) => ALL_WORDS.has(n.toLowerCase()) || canon(n))) body = text.slice(lead[0].length).trim() || text.trim();
  }
  return { to: all || !names.length ? 'all' : names.join(','), text: body };
}

export class Store extends EventEmitter {
  constructor(dataDir) {
    super();
    this.dir = dataDir;
    this.file = path.join(dataDir, 'hub.json');
    fs.mkdirSync(path.join(dataDir, 'memory'), { recursive: true });
    fs.mkdirSync(path.join(dataDir, 'logs'), { recursive: true });
    this.messages = [];
    this.nextMsgId = 1;
    this.tasks = [];
    this.nextTaskId = 1;
    this.notes = {}; // key -> {key,text,by,ts}
    this.waypoints = {}; // name -> {...}
    this.goal = { text: '', by: null, ts: 0 };
    this.botRoles = {}; // name -> role (also the set of known bot names)
    this.logs = {}; // name -> ring of entries
    this.nextLogId = 1;
    this.waiters = new Set(); // long-pollers
    this._saveTimer = null;
    this._logPending = {}; // name -> lines to append
    this._logTimer = null;
    this._load();
  }

  // ---------- persistence ----------
  _load() {
    try {
      const j = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.messages = Array.isArray(j.messages) ? j.messages : [];
      this.nextMsgId = j.nextMsgId || (this.messages.at(-1)?.id || 0) + 1;
      this.tasks = Array.isArray(j.tasks) ? j.tasks : [];
      this.nextTaskId = j.nextTaskId || Math.max(0, ...this.tasks.map((t) => t.id)) + 1;
      this.notes = j.notes || {};
      this.waypoints = j.waypoints || {};
      this.goal = j.goal || this.goal;
      this.botRoles = j.botRoles || {};
    } catch (e) {
      if (e.code !== 'ENOENT') logErr('hub.json load failed (starting fresh):', e.message);
    }
    // logs: tail of per-agent jsonl
    try {
      for (const f of fs.readdirSync(path.join(this.dir, 'logs'))) {
        if (!f.endsWith('.jsonl')) continue;
        const name = f.slice(0, -6);
        const lines = fs.readFileSync(path.join(this.dir, 'logs', f), 'utf8').split('\n').filter(Boolean);
        const ring = [];
        for (const l of lines.slice(-MAX_LOG_RING)) {
          try {
            const e = JSON.parse(l);
            e.id = this.nextLogId++;
            ring.push(e);
          } catch {}
        }
        this.logs[name] = ring;
        if (lines.length > MAX_LOG_RING * 8) {
          fs.writeFileSync(path.join(this.dir, 'logs', f), ring.map((e) => JSON.stringify({ ts: e.ts, kind: e.kind, text: e.text })).join('\n') + '\n');
        }
      }
    } catch (e) {
      logErr('log load failed:', e.message);
    }
  }

  save() {
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      this.flush();
    }, 400);
  }

  flush() {
    clearTimeout(this._saveTimer);
    this._saveTimer = null;
    const data = {
      nextMsgId: this.nextMsgId,
      messages: this.messages.slice(-MAX_MESSAGES),
      nextTaskId: this.nextTaskId,
      tasks: this.tasks,
      notes: this.notes,
      waypoints: this.waypoints,
      goal: this.goal,
      botRoles: this.botRoles,
    };
    try {
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(data));
      fs.renameSync(tmp, this.file);
    } catch (e) {
      logErr('hub.json save failed:', e.message);
    }
    this._flushLogs();
  }

  _flushLogs() {
    clearTimeout(this._logTimer);
    this._logTimer = null;
    for (const [name, lines] of Object.entries(this._logPending)) {
      if (!lines.length) continue;
      try {
        fs.appendFileSync(path.join(this.dir, 'logs', name + '.jsonl'), lines.join(''));
      } catch (e) {
        logErr('log append failed:', e.message);
      }
      this._logPending[name] = [];
    }
  }

  emitChange(type, data) {
    this.emit('change', { type, data });
  }

  // ---------- messages ----------
  knownNames() {
    return new Set(Object.keys(this.botRoles));
  }

  canonName(n) {
    if (typeof n !== 'string') return n;
    if (n.toLowerCase() === 'all') return 'all';
    for (const k of Object.keys(this.botRoles)) if (k.toLowerCase() === n.toLowerCase()) return k;
    return n;
  }

  /** canonical bot name for `n` (case-insensitive), or null if `n` is not a bot */
  botName(n) {
    if (typeof n !== 'string' || !n) return null;
    const l = n.toLowerCase();
    for (const k of Object.keys(this.botRoles)) if (k.toLowerCase() === l) return k;
    return null;
  }

  addMessage({ from, to, text }) {
    from = str(from, 40).trim();
    // to: 'all', one name, or a few names separated by commas ("Flint,Wren")
    to = str(to || 'all', 120).split(',').map((x) => this.canonName(x.trim())).filter(Boolean);
    to = to.includes('all') || !to.length ? 'all' : [...new Set(to)].join(',');
    text = str(text, 4000).trim();
    // a HUMAN's message to everyone that @mentions bots goes ONLY to those bots (MC chat, dashboard, mod `say all`);
    // the interrupt in BotManager follows m.to, so only the addressed bots are interrupted too
    if (to === 'all' && from && from !== 'system' && from !== 'Market' && !this.botName(from)) ({ to, text } = routeMentions(text, (n) => this.botName(n)));
    if (!from) throw new HttpError(400, 'from is required');
    if (!text) throw new HttpError(400, 'text is required');
    const m = { id: this.nextMsgId++, from, to, text, ts: now() };
    this.messages.push(m);
    if (this.messages.length > MAX_MESSAGES + 200) this.messages.splice(0, this.messages.length - MAX_MESSAGES);
    this.save();
    this.emitChange('msg', m);
    this._wake();
    return m;
  }

  get lastMsgId() {
    return this.nextMsgId - 1;
  }

  _forName(name, since) {
    return this.messages.filter((m) => m.id > since && m.from !== name && (m.to === 'all' || m.to === name || (m.to.includes(',') && m.to.split(',').includes(name))));
  }

  /** messages for `name` after `since`; if none and wait>0, long-poll. */
  pollMessages(name, since, waitSec, signal) {
    const first = this._forName(name, since);
    if (first.length || !waitSec) return Promise.resolve({ messages: first.slice(-100), cursor: this.lastMsgId });
    return new Promise((resolve) => {
      const w = {
        name,
        since,
        fire: () => {
          const ms = this._forName(name, since);
          if (!ms.length) return;
          cleanup();
          resolve({ messages: ms.slice(-100), cursor: this.lastMsgId });
        },
      };
      const timer = setTimeout(() => {
        cleanup();
        resolve({ messages: [], cursor: this.lastMsgId });
      }, waitSec * 1000);
      const onAbort = () => {
        cleanup();
        resolve({ messages: [], cursor: this.lastMsgId });
      };
      const cleanup = () => {
        clearTimeout(timer);
        this.waiters.delete(w);
        signal?.removeEventListener('abort', onAbort);
      };
      signal?.addEventListener('abort', onAbort);
      this.waiters.add(w);
    });
  }

  _wake() {
    for (const w of [...this.waiters]) w.fire();
  }

  unread(name, since) {
    return this._forName(name, since).length;
  }

  // ---------- board ----------
  task(id) {
    const t = this.tasks.find((t) => t.id === Number(id));
    if (!t) throw new HttpError(404, `no task ${id}`);
    return t;
  }

  addTask({ by, title, detail, priority }) {
    title = str(title, 200).trim();
    if (!title) throw new HttpError(400, 'title is required');
    const t = {
      id: this.nextTaskId++,
      title,
      detail: str(detail, 2000),
      status: 'open',
      owner: null,
      priority: priority === undefined || priority === null || priority === '' ? 'normal' : priority,
      by: str(by, 40) || 'unknown',
      notes: [],
      created: now(),
      updated: now(),
    };
    this.tasks.push(t);
    this.save();
    this.emitChange('board', t);
    return t;
  }

  claimTask(id, by) {
    by = str(by, 40).trim();
    if (!by) throw new HttpError(400, 'by is required');
    const t = this.task(id);
    if (t.status === 'done') throw new HttpError(409, `task ${t.id} is already done`, { task: t });
    if (t.owner && t.owner !== by && t.status === 'claimed') throw new HttpError(409, `task ${t.id} already claimed by ${t.owner}`, { task: t });
    t.owner = by;
    t.status = 'claimed';
    t.updated = now();
    this.save();
    this.emitChange('board', t);
    return t;
  }

  updateTask(id, { by, status, note, owner, title, detail, priority }) {
    const t = this.task(id);
    if (status !== undefined && status !== null && status !== '') {
      if (!STATUSES.includes(status)) throw new HttpError(400, `status must be one of ${STATUSES.join('|')}`);
      t.status = status;
      if (status === 'open' && owner === undefined) t.owner = null;
      if ((status === 'claimed' || status === 'blocked') && !t.owner && by) t.owner = str(by, 40);
    }
    if (owner !== undefined) {
      t.owner = owner ? str(owner, 40) : null;
      if (t.owner && (status === undefined || status === null) && t.status === 'open') t.status = 'claimed';
    }
    if (typeof title === 'string' && title.trim()) t.title = str(title, 200).trim();
    if (typeof detail === 'string') t.detail = str(detail, 2000);
    if (priority !== undefined && priority !== null && priority !== '') t.priority = priority;
    if (note) t.notes.push(`${str(by, 40) || '?'}: ${str(note, 1000)}`);
    if (t.notes.length > 40) t.notes.splice(0, t.notes.length - 40);
    t.updated = now();
    this.save();
    this.emitChange('board', t);
    return t;
  }

  /** set/clear extra task fields (economy bounty: reward, rewardStatus, rewardTo); undefined removes a field */
  patchTask(id, fields = {}) {
    const t = this.task(id);
    for (const [k, v] of Object.entries(fields)) {
      if (['id', 'created', 'by', 'notes'].includes(k)) continue;
      if (v === undefined) delete t[k];
      else t[k] = v;
    }
    this.save();
    this.emitChange('board', t);
    return t;
  }

  deleteTask(id) {
    const t = this.task(id);
    this.tasks = this.tasks.filter((x) => x !== t);
    this.save();
    this.emitChange('board_delete', { id: t.id, created: t.created });
    return t;
  }

  // ---------- notes / waypoints / goal ----------
  setNote({ by, key, text }) {
    key = str(key, 80).trim();
    if (!key) throw new HttpError(400, 'key is required');
    if (text === undefined || text === null) throw new HttpError(400, 'text is required');
    const n = { key, text: str(text, 4000), by: str(by, 40) || 'unknown', ts: now() };
    this.notes[key] = n;
    this.save();
    this.emitChange('note', n);
    return n;
  }

  deleteNote(key) {
    if (!this.notes[key]) throw new HttpError(404, 'no such note');
    delete this.notes[key];
    this.save();
    this.emitChange('note_delete', { key });
  }

  setWaypoint({ by, name, x, y, z, note, dimension }) {
    name = str(name, 60).trim();
    if (!name) throw new HttpError(400, 'name is required');
    for (const [k, v] of Object.entries({ x, y, z })) if (!Number.isFinite(Number(v)) || v === null || v === '' || v === undefined) throw new HttpError(400, `${k} must be a number`);
    const w = { name, x: Math.round(Number(x)), y: Math.round(Number(y)), z: Math.round(Number(z)), note: str(note, 500), by: str(by, 40) || 'unknown', dimension: dimension || 'overworld', ts: now() };
    this.waypoints[name] = w;
    this.save();
    this.emitChange('waypoint', w);
    return w;
  }

  deleteWaypoint(name) {
    if (!this.waypoints[name]) throw new HttpError(404, 'no such waypoint');
    delete this.waypoints[name];
    this.save();
    this.emitChange('waypoint_delete', { name });
  }

  setGoal({ text, by }) {
    this.goal = { text: str(text, 6000), by: str(by, 40) || null, ts: now() };
    this.save();
    this.emitChange('goal', this.goal);
    return this.goal;
  }

  // ---------- memory ----------
  memoryPath(name) {
    return path.join(this.dir, 'memory', needName(name, 'agent name') + '.md');
  }
  getMemory(name) {
    try {
      const p = this.memoryPath(name);
      return { name, text: fs.readFileSync(p, 'utf8'), updated: fs.statSync(p).mtimeMs };
    } catch (e) {
      if (e instanceof HttpError) throw e;
      return { name, text: '', updated: 0 };
    }
  }
  setMemory(name, text) {
    const p = this.memoryPath(name);
    fs.writeFileSync(p, str(text, 60000));
    this.emitChange('memory', { name, size: str(text, 60000).length });
    return { ok: true, name, bytes: Buffer.byteLength(str(text, 60000)) };
  }

  // ---------- logs ----------
  addLog(name, kind, text) {
    needName(name, 'agent name');
    if (!LOG_KINDS.includes(kind)) kind = 'system';
    const e = { id: this.nextLogId++, ts: now(), kind, text: str(text, 6000) };
    const ring = (this.logs[name] ||= []);
    ring.push(e);
    if (ring.length > MAX_LOG_RING) ring.splice(0, ring.length - MAX_LOG_RING);
    (this._logPending[name] ||= []).push(JSON.stringify({ ts: e.ts, kind: e.kind, text: e.text }) + '\n');
    if (!this._logTimer) this._logTimer = setTimeout(() => this._flushLogs(), 1500);
    this.emitChange('log', { name, ...e });
    return e;
  }

  getLog(name, { since = 0, limit = 200 } = {}) {
    return (this.logs[name] || []).filter((e) => e.id > since).slice(-limit);
  }

  lastThought(name) {
    const ring = this.logs[name];
    if (!ring) return null;
    for (let i = ring.length - 1; i >= 0; i--) if (ring[i].kind === 'thought') return ring[i].text;
    return null;
  }

  close() {
    this.flush();
  }
}
