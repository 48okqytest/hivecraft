// Same interface as bridge/engine/index.js (ACTIONS + spawnBot -> handle), but every bot lives in its own
// worker thread (bridge/engine/worker.js). The bridge/hub code does not know the difference.
import { Worker } from 'node:worker_threads';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { ACTIONS } from './index.js';

export { ACTIONS };
const WORKER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'worker.js');

function toError({ message, name } = {}) {
  const e = new Error(message || 'error');
  if (name) e.name = name; // keeps StopError recognisable for the hub
  return e;
}

class ThreadedHandle extends EventEmitter {
  constructor(worker, name) {
    super();
    this.worker = worker;
    this.name = name;
    this.online = true;
    this.dead = false;
    this._state = { name, online: true };
    this._pending = new Map();
    this._nextId = 1;
    this._gone = false;
    // minimal stand-in for the mineflayer bot: the hub only uses bot.chat()
    this.bot = { username: name, chat: (text) => this._post({ type: 'chat', text }) };
    worker.on('message', (m) => this._onMessage(m));
    worker.on('error', (e) => this._lost(`worker crashed: ${e?.message || e}`));
    worker.on('exit', (code) => this._lost(`worker exited (${code})`));
  }

  _post(m) { if (!this._gone) { try { this.worker.postMessage(m); } catch { /* worker gone */ } } }

  _onMessage(m) {
    if (!m) return;
    if (m.type === 'state') { this._state = m.state; this.online = m.online; this.dead = m.dead; }
    else if (m.type === 'emit') {
      if (m.event === 'offline') this.online = false;
      if (m.event === 'error') this.emit('error', toError(m.payload));
      else this.emit(m.event, m.payload);
    } else if (m.type === 'result') {
      const p = this._pending.get(m.id);
      if (!p) return;
      this._pending.delete(m.id);
      if (m.ok) p.resolve(m.result); else p.reject(toError(m.error));
    } else if (m.type === 'log') {
      console.error(`[${this.name}] ${m.text}`);
    }
  }

  _lost(reason) {
    if (this._gone) return;
    this._gone = true;
    this.online = false;
    for (const p of this._pending.values()) p.reject(new Error(`bot thread ended: ${reason}`));
    this._pending.clear();
    this.emit('offline', { reason });
  }

  getState() { return this._state; }

  run(action, args = {}, { signal } = {}) {
    if (this._gone) return Promise.reject(new Error('bot is offline'));
    const id = this._nextId++;
    return new Promise((resolve, reject) => {
      this._pending.set(id, { resolve, reject });
      const onAbort = () => this._post({ type: 'abort', id, reason: signal.reason?.message || 'Stopped' });
      if (signal) {
        if (signal.aborted) onAbort(); else signal.addEventListener('abort', onAbort, { once: true });
      }
      this._post({ type: 'run', id, action, args });
    });
  }

  stop() { this._post({ type: 'stop' }); }

  async quit() {
    if (this._gone) return;
    const done = new Promise((r) => {
      const t = setTimeout(r, 3000);
      this.worker.on('message', (m) => { if (m?.type === 'quitted') { clearTimeout(t); r(); } });
    });
    this._post({ type: 'quit' });
    await done;
    this._gone = true; // a deliberate quit: no 'offline' event
    await this.worker.terminate().catch(() => {});
  }
}

export function spawnBot(opts = {}) {
  if (!opts.name) return Promise.reject(new Error('spawnBot: name is required'));
  return new Promise((resolve, reject) => {
    const worker = new Worker(WORKER, { workerData: opts });
    const onMsg = (m) => {
      if (m?.type === 'spawned') { cleanup(); resolve(new ThreadedHandle(worker, opts.name)); }
      else if (m?.type === 'spawnError') { cleanup(); worker.terminate().catch(() => {}); reject(toError(m.error)); }
    };
    const onErr = (e) => { cleanup(); reject(new Error(`bot thread for ${opts.name} failed to start: ${e?.message || e}`)); };
    const onExit = (code) => { cleanup(); reject(new Error(`bot thread for ${opts.name} exited during spawn (${code})`)); };
    function cleanup() { worker.off('message', onMsg); worker.off('error', onErr); worker.off('exit', onExit); }
    worker.on('message', onMsg); worker.on('error', onErr); worker.on('exit', onExit);
  });
}
