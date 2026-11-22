// Hub API test against the mock engine (no Minecraft needed).  node test/hub-api.mjs
import './neutral-player.mjs'; // neutral human player (Robin / robin_mc), set before the bridge reads config
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../bridge/hub/app.js';
import * as mock from './hub-mock-engine.mjs';
process.env.HIVE_EARNINGS_POLL = '0'; // tests never poll a live Minecraft server (earnings scoreboards/time)
const NO_RCON = { rcon: async (cmd) => { throw new Error(`no RCON in tests (${cmd})`); }, timers: false }; // never the real :25591

const PORT = Number(process.env.HIVE_PORT) || 47961;
const BASE = `http://127.0.0.1:${PORT}`;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-test-'));
let pass = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(method, p, body, raw = false) {
  const opts = { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined };
  let res;
  try { res = await fetch(BASE + p, opts); } catch { await sleep(100); res = await fetch(BASE + p, opts); } // stale keep-alive socket after a restart
  const text = await res.text();
  if (raw) return { status: res.status, text, res };
  let json;
  try { json = JSON.parse(text); } catch { json = { _raw: text }; }
  return { status: res.status, ...{ json } };
}
const get = (p) => api('GET', p);
const post = (p, b) => api('POST', p, b || {});

async function t(name, fn) {
  try {
    await fn();
    pass++;
    console.log('  ok  ', name);
  } catch (e) {
    console.log('  FAIL', name, '\n      ', e.message);
    process.exitCode = 1;
  }
}

let app = createApp({ engine: mock, dataDir, port: PORT, mc: { rconPort: 1 }, econOpts: NO_RCON });
await app.start();

await t('health + actions + static dashboard', async () => {
  assert.equal((await get('/health')).json.ok, true);
  const a = await get('/actions');
  assert.ok(a.json.some((x) => x.name === 'goto'));
  const idx = await api('GET', '/', null, true);
  assert.equal(idx.status, 200);
  assert.match(idx.text, /<html/i);
  assert.equal((await api('GET', '/../server.js', null, true)).status, 404);
  assert.equal((await api('GET', '/nope', null, true)).status, 404);
});

await t('bad requests never crash', async () => {
  const r = await fetch(BASE + '/msg', { method: 'POST', body: '{not json' });
  assert.equal(r.status, 400);
  assert.equal((await post('/bots', { name: 'bad name!' })).status, 400);
  assert.equal((await get('/bots/Nobody/state')).status, 404);
  assert.equal((await post('/bots/Nobody/act', { action: 'scan' })).status, 404);
  assert.equal((await post('/msg', { text: 'x' })).status, 400);
  assert.equal((await post('/board/999/claim', { by: 'A' })).status, 404);
  assert.equal((await get('/memory/..%2f..%2fx')).status, 400);
  assert.equal((await get('/health')).json.ok, true);
  const evil = await fetch(BASE + '/health', { headers: { Origin: 'http://evil.example' } });
  assert.equal(evil.status, 403);
});

await t('spawn bots idempotent, roles, list, state', async () => {
  const a = await post('/bots', { name: 'Ash', role: 'Lead' });
  assert.equal(a.json.name, 'Ash');
  assert.equal(a.json.online, true);
  await post('/bots', { name: 'Ash' });
  assert.equal(mock.spawnLog.filter((s) => s.name === 'Ash').length, 1, 'idempotent spawn');
  await post('/bots', { name: 'Birch', role: 'Miner' });
  const list = (await get('/bots')).json;
  assert.deepEqual(list.map((b) => b.name).sort(), ['Ash', 'Birch']);
  assert.equal(list.find((b) => b.name === 'Birch').role, 'Miner');
  const st = (await get('/bots/Ash/state')).json;
  assert.equal(st.health, 20);
  assert.ok(Array.isArray(st.recentEvents));
});

await t('act: ok, error, unknown action', async () => {
  const ok = (await post('/bots/Ash/act', { action: 'collect', args: { block: 'oak_log', count: 3 } })).json;
  assert.equal(ok.ok, true);
  assert.match(ok.result, /Collected 3/);
  assert.ok((await get('/bots/Ash/state')).json.inventory.some((i) => i.name === 'oak_log' && i.count === 3));
  const bad = (await post('/bots/Ash/act', { action: 'fail' })).json;
  assert.equal(bad.ok, false);
  assert.match(bad.error, /iron_ore/);
  const unk = (await post('/bots/Ash/act', { action: 'dance' })).json;
  assert.equal(unk.ok, false);
  assert.match(unk.error, /unknown action/);
});

await t('busy, interrupt, stop', async () => {
  const long = post('/bots/Ash/act', { action: 'wait', args: { seconds: 5 } });
  await sleep(150);
  assert.equal((await get('/bots')).json.find((b) => b.name === 'Ash').currentAction, 'wait');
  const busy = (await post('/bots/Ash/act', { action: 'scan' })).json;
  assert.equal(busy.ok, false);
  assert.equal(busy.error, 'busy: wait');
  const t0 = Date.now();
  const intr = (await post('/bots/Ash/act', { action: 'scan', interrupt: true })).json;
  assert.equal(intr.ok, true, JSON.stringify(intr));
  const first = (await long).json;
  assert.equal(first.ok, false);
  assert.match(first.error, /Stopped/);
  assert.ok(Date.now() - t0 < 2000, 'interrupt was fast');
  // /stop
  const l2 = post('/bots/Ash/act', { action: 'wait', args: { seconds: 5 } });
  await sleep(100);
  assert.equal((await post('/bots/Ash/stop')).json.ok, true);
  assert.equal((await l2).json.ok, false);
  // stop as an action works even when busy
  const l3 = post('/bots/Ash/act', { action: 'wait', args: { seconds: 5 } });
  await sleep(100);
  const sr = (await post('/bots/Ash/act', { action: 'stop' })).json;
  assert.equal(sr.ok, true);
  assert.match(sr.result, /was running wait/);
  await l3;
  assert.equal((await get('/bots')).json.find((b) => b.name === 'Ash').currentAction, null);
});

await t('act timeout aborts the action; engine that ignores abort cannot deadlock the bot', async () => {
  const r = (await post('/bots/Birch/act', { action: 'wait', args: { seconds: 30 }, timeoutMs: 1000 })).json;
  assert.equal(r.ok, false);
  assert.match(r.error, /timeout after 1s/);
  assert.equal((await post('/bots/Birch/act', { action: 'scan' })).json.ok, true, 'bot usable after timeout');
  const h = await post('/bots/Birch/act', { action: 'hang', timeoutMs: 1000 });
  assert.equal(h.json.ok, false);
  assert.match(h.json.error, /did not stop|timeout/);
  assert.equal((await post('/bots/Birch/act', { action: 'scan' })).json.ok, true, 'bot usable after hang');
});

await t('messages: send, long-poll wake-up, cursors, unread, no self-echo', async () => {
  const m = (await post('/msg', { from: 'Ash', to: 'Birch', text: 'need iron' })).json;
  assert.ok(m.id > 0);
  assert.deepEqual(mock.registry.get('Ash').chatLog.at(-1), '@Birch need iron', 'said in MC chat');
  const r1 = (await get('/msg/Birch?since=0')).json;
  assert.ok(r1.messages.some((x) => x.text === 'need iron'));
  assert.ok(!(await get('/msg/Ash?since=0')).json.messages.some((x) => x.text === 'need iron'), 'own message excluded');
  const cur = r1.cursor;
  assert.equal((await get(`/unread/Birch?since=${cur}`)).json.count, 0);
  // long-poll wakes up
  const t0 = Date.now();
  const lp = get(`/msg/Birch?since=${cur}&wait=20`);
  await sleep(300);
  await post('/msg', { from: 'Robin', to: 'all', text: 'hello team' });
  const w = (await lp).json;
  assert.ok(Date.now() - t0 < 3000, 'woke up early');
  assert.equal(w.messages.length, 1);
  assert.equal(w.messages[0].from, 'Robin');
  assert.equal(w.cursor, w.messages[0].id);
  assert.equal((await get(`/unread/Ash?since=${cur}`)).json.count, 1);
  // wait times out empty
  const t1 = Date.now();
  const e = (await get(`/msg/Birch?since=${w.cursor}&wait=1`)).json;
  assert.equal(e.messages.length, 0);
  assert.ok(Date.now() - t1 >= 900);
  // DM to other bot is not delivered to a third party
  await post('/bots', { name: 'Cedar' });
  await post('/msg', { from: 'Ash', to: 'Birch', text: 'secret' });
  assert.ok(!(await get('/msg/Cedar?since=0')).json.messages.some((x) => x.text === 'secret'));
  // typo'd recipient: case-insensitive match, unknown gets a warning
  assert.equal((await post('/msg', { from: 'Ash', to: 'birch', text: 'case' })).json.to, 'Birch');
  assert.match((await post('/msg', { from: 'Ash', to: 'Nobody', text: 'x' })).json.warning, /no agent named/);
});

await t('in-game human chat -> message from player to all; bot chat not re-ingested; dedupe', async () => {
  const before = (await get('/messages')).json.cursor;
  mock.registry.get('Ash').say('Robin', 'follow me please');
  mock.registry.get('Birch').say('Robin', 'follow me please'); // every bot hears it
  mock.registry.get('Ash').say('Birch', '@Ash echo?'); // bot chat line -> ignored
  mock.registry.get('Ash').say('Robin', '@Cedar dig down');
  await sleep(50);
  const msgs = (await get(`/messages?since=${before}`)).json.messages;
  assert.equal(msgs.filter((m) => m.text === 'follow me please').length, 1);
  assert.equal(msgs.find((m) => m.text === 'follow me please').from, 'Robin');
  assert.equal(msgs.find((m) => m.text === 'follow me please').to, 'all');
  assert.ok(!msgs.some((m) => m.text.includes('echo?')), 'bot chat ignored');
  const dm = msgs.find((m) => m.text === 'dig down');
  assert.equal(dm.to, 'Cedar');
});

await t('bot events -> system messages + recentEvents; noisy ones skipped', async () => {
  const before = (await get('/messages')).json.cursor;
  mock.registry.get('Cedar').event('death', 'Cedar was slain by Zombie');
  mock.registry.get('Cedar').event('item_picked_up', '1 dirt');
  await sleep(30);
  const r = (await get(`/msg/Cedar?since=${before}`)).json;
  assert.equal(r.messages.length, 1);
  assert.equal(r.messages[0].from, 'system');
  assert.match(r.messages[0].text, /death/);
  assert.equal((await get('/msg/Ash?since=' + before)).json.messages.some((m) => m.from === 'system'), false);
  const ev = (await get('/bots/Cedar/state')).json.recentEvents;
  assert.ok(ev.some((e) => e.kind === 'item_picked_up') && ev.some((e) => e.kind === 'death'));
});

await t('task board: add, claim, conflict 409, update, notes', async () => {
  const a = (await post('/board', { by: 'Ash', title: 'Get 20 logs', detail: 'oak', priority: 'high' })).json;
  assert.equal(a.status, 'open');
  assert.equal(a.priority, 'high');
  const c1 = await post(`/board/${a.id}/claim`, { by: 'Birch' });
  assert.equal(c1.status, 200);
  assert.equal(c1.json.owner, 'Birch');
  assert.equal(c1.json.status, 'claimed');
  const c2 = await post(`/board/${a.id}/claim`, { by: 'Cedar' });
  assert.equal(c2.status, 409);
  assert.match(c2.json.error, /Birch/);
  assert.equal((await post(`/board/${a.id}/claim`, { by: 'Birch' })).status, 200, 'owner re-claim ok');
  const u = (await post(`/board/${a.id}`, { by: 'Birch', status: 'done', note: 'got 22' })).json;
  assert.equal(u.status, 'done');
  assert.match(u.notes[0], /Birch: got 22/);
  assert.equal((await post(`/board/${a.id}/claim`, { by: 'Cedar' })).status, 409, 'done tasks cannot be claimed');
  assert.equal((await post(`/board/${a.id}`, { by: 'x', status: 'weird' })).status, 400);
  assert.equal((await post(`/board/${a.id}`, { by: 'Ash', status: 'open' })).json.owner, null, 'reopen clears owner');
  assert.equal((await post('/board', { by: 'x' })).status, 400);
  assert.equal((await get('/board')).json.length, 1);
});

await t('notes upsert, waypoints, goal, memory', async () => {
  await post('/notes', { by: 'Ash', key: 'iron', text: 'iron at -40 12 80' });
  await post('/notes', { by: 'Birch', key: 'iron', text: 'iron at -40 12 80 (confirmed)' });
  const notes = (await get('/notes')).json;
  assert.equal(notes.length, 1);
  assert.match(notes[0].text, /confirmed/);
  assert.equal(notes[0].by, 'Birch');
  const w = (await post('/waypoints', { by: 'Ash', name: 'base', x: 10.4, y: 64, z: -3, note: 'chest here' })).json;
  assert.equal(w.x, 10);
  assert.equal((await post('/waypoints', { by: 'Ash', name: 'bad', x: 'a', y: 1, z: 2 })).status, 400);
  assert.equal((await get('/waypoints')).json.length, 1);
  assert.equal((await post('/goal', { text: 'Build a base', by: 'Robin' })).json.text, 'Build a base');
  assert.equal((await get('/goal')).json.text, 'Build a base');
  assert.equal((await get('/memory/Ash')).json.text, '');
  await post('/memory/Ash', { text: '# me\nbase at 10,64,-3' });
  assert.match((await get('/memory/Ash')).json.text, /base at/);
  assert.ok(fs.existsSync(path.join(dataDir, 'memory', 'Ash.md')));
});

await t('log: post, read, lastThought on bot summary', async () => {
  await post('/log/Ash', { kind: 'thought', text: 'I should find iron' });
  await post('/log/Ash', { kind: 'tool', text: 'scan {}' });
  await post('/log/Ash', { kind: 'bogus', text: 'x' });
  const l = (await get('/log/Ash')).json.entries;
  assert.equal(l.length, 3);
  assert.equal(l[2].kind, 'system');
  assert.equal((await get('/bots')).json.find((b) => b.name === 'Ash').lastThought, 'I should find iron');
  assert.equal((await get(`/log/Ash?since=${l[1].id}`)).json.entries.length, 1);
});

await t('SSE: init, msg, board, bots snapshot', async () => {
  const res = await fetch(BASE + '/events');
  assert.equal(res.headers.get('content-type'), 'text/event-stream');
  const dec = new TextDecoder();
  let buf = '';
  const seen = new Set();
  const reader = res.body.getReader();
  const pump = (async () => {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      buf += dec.decode(value);
      for (const m of buf.matchAll(/event: (\w+)/g)) seen.add(m[1]);
    }
  })();
  await sleep(200);
  await post('/msg', { from: 'Robin', to: 'all', text: 'sse test' });
  await post('/board', { by: 'Ash', title: 'sse task' });
  await post('/log/Ash', { kind: 'thought', text: 'sse log' });
  await post('/notes', { by: 'Ash', key: 'k', text: 'v' });
  await post('/waypoints', { by: 'Ash', name: 'w', x: 1, y: 2, z: 3 });
  await sleep(1400);
  reader.cancel();
  await pump.catch(() => {});
  for (const k of ['init', 'msg', 'board', 'log', 'note', 'waypoint', 'bots']) assert.ok(seen.has(k), `missing SSE event ${k}; got ${[...seen]}`);
});

await t('offline bot -> state offline, act errors, auto-reconnect with backoff', async () => {
  const spawnsBefore = mock.spawnLog.filter((s) => s.name === 'Cedar').length;
  mock.registry.get('Cedar').drop('timed out');
  await sleep(50);
  const b = (await get('/bots')).json.find((x) => x.name === 'Cedar');
  assert.equal(b.online, false);
  assert.equal(b.status, 'offline');
  const a = (await post('/bots/Cedar/act', { action: 'scan' })).json;
  assert.equal(a.ok, false);
  assert.match(a.error, /offline/);
  assert.equal((await get('/bots/Cedar/state')).json.online, false);
  // first retry is after 2s
  await sleep(2600);
  assert.equal(mock.spawnLog.filter((s) => s.name === 'Cedar').length, spawnsBefore + 1, 'reconnected');
  assert.equal((await get('/bots')).json.find((x) => x.name === 'Cedar').online, true);
  assert.equal((await post('/bots/Cedar/act', { action: 'scan' })).json.ok, true);
});

await t('persistence across restart', async () => {
  await post('/memory/Birch', { text: 'birch memory' });
  const msgCount = (await get('/messages')).json.messages.length;
  const cursor = (await get('/messages')).json.cursor;
  await app.close();
  app = createApp({ engine: mock, dataDir, port: PORT, mc: { rconPort: 1 }, econOpts: NO_RCON });
  await app.start();
  assert.equal((await get('/board')).json.length, 2);
  assert.equal((await get('/notes')).json.find((n) => n.key === 'iron').by, 'Birch');
  assert.equal((await get('/waypoints')).json.find((w) => w.name === 'base').x, 10);
  assert.equal((await get('/goal')).json.text, 'Build a base');
  assert.equal((await get('/messages')).json.messages.length, msgCount);
  assert.equal((await get('/messages')).json.cursor, cursor);
  assert.equal((await get('/memory/Birch')).json.text, 'birch memory');
  assert.ok((await get('/log/Ash')).json.entries.length >= 3, 'logs persisted');
  assert.equal((await get('/bots')).json.length, 0, 'bots are not auto-hosted until POSTed');
  // ids keep increasing
  const m = (await post('/msg', { from: 'Robin', to: 'all', text: 'after restart' })).json;
  assert.ok(m.id > cursor);
  const nt = (await post('/board', { by: 'x', title: 'new' })).json;
  assert.equal(nt.id, 3);
  // known bot names (roles) persisted -> in-game chat from them is still ignored after restart
  assert.equal((await post('/bots', { name: 'Ash' })).json.role, 'Lead');
});

await t('DELETE bot quits it; rcon error path is clean', async () => {
  assert.equal((await api('DELETE', '/bots/Ash')).json.ok, true);
  assert.ok(!mock.registry.has('Ash'));
  assert.equal((await get('/bots')).json.length, 0);
  const r = await api('POST', '/admin/rcon', { cmd: 'list' });
  // /admin/rcon points at a dead port (1) in this test: a clean 502, never a crash, never the live server
  assert.equal(r.status, 502, `status ${r.status}`);
  assert.equal((await post('/admin/rcon', {})).status, 400);
});

await app.close();
fs.rmSync(dataDir, { recursive: true, force: true });
console.log(`\n${pass} passed${process.exitCode ? ' — WITH FAILURES' : ''}`);
process.exit(process.exitCode || 0);
