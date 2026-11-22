// One bot per worker thread: mineflayer physics + pathfinding run on their own event loop, so one bot's
// heavy work (A* paths, block scans) can't freeze the others. Talks to bridge/engine/threaded.js.
import { parentPort, workerData } from 'node:worker_threads';
import { spawnBot } from './index.js';

const send = (m) => { try { parentPort.postMessage(m); } catch { /* parent gone */ } };
const errOut = (e) => ({ message: e?.message || String(e), name: e?.name || 'Error' });
const runs = new Map(); // id -> AbortController
let h = null;
let stateTimer = null;

function pushState() {
  if (!h) return;
  try { send({ type: 'state', state: h.getState(), online: !!h.online, dead: !!h.dead }); }
  catch (e) { send({ type: 'log', text: `getState failed: ${e.message}` }); }
}

async function start() {
  try {
    h = await spawnBot(workerData);
  } catch (e) {
    send({ type: 'spawnError', error: errOut(e) });
    return;
  }
  h.on('chat', (c) => send({ type: 'emit', event: 'chat', payload: { username: c?.username, message: c?.message } }));
  h.on('event', (ev) => send({ type: 'emit', event: 'event', payload: { kind: ev?.kind, text: ev?.text } }));
  h.on('offline', (info) => { pushState(); send({ type: 'emit', event: 'offline', payload: { reason: info?.reason ?? String(info ?? '') } }); });
  for (const ev of ['ledger', 'path', 'pose']) h.on(ev, (p) => send({ type: 'emit', event: ev, payload: p })); // overlay mod feed (engine/ledger.js)
  h.on('error', (e) => send({ type: 'emit', event: 'error', payload: errOut(e) }));
  pushState();
  stateTimer = setInterval(pushState, 250);
  send({ type: 'spawned', username: h.bot?.username || workerData.name });
}

parentPort.on('message', async (m) => {
  if (!m || !h) return;
  if (m.type === 'run') {
    const ac = new AbortController();
    runs.set(m.id, ac);
    try {
      const result = await h.run(m.action, m.args || {}, { signal: ac.signal });
      pushState(); // fresh vitals before the result, so status right after an action is current
      send({ type: 'result', id: m.id, ok: true, result });
    } catch (e) {
      pushState();
      send({ type: 'result', id: m.id, ok: false, error: errOut(e) });
    } finally {
      runs.delete(m.id);
    }
  } else if (m.type === 'abort') {
    runs.get(m.id)?.abort(new Error(m.reason || 'Stopped'));
  } else if (m.type === 'stop') {
    try { h.stop(); } catch (e) { send({ type: 'log', text: `stop failed: ${e.message}` }); }
  } else if (m.type === 'chat') {
    try { h.bot?.chat(String(m.text)); } catch (e) { send({ type: 'log', text: `chat failed: ${e.message}` }); }
  } else if (m.type === 'quit') {
    clearInterval(stateTimer);
    try { await h.quit(); } catch { /* already gone */ }
    send({ type: 'quitted' });
  }
});

start();
