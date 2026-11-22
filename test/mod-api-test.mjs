// Overlay mod API test — fully offline (no Minecraft, no claude): node test/mod-api-test.mjs
//  1. LedgerStore unit tests (add/query/at/persist/caps)
//  2. installLedger on a fake mineflayer bot (dig/place/activate wrappers, causes, blueprint tags, path/pose)
//  3. the hub on a spare port with the mock engine + a fake build job: ws /mod messages, HTTP /mod/*, commands
import './neutral-player.mjs'; // neutral human player (Robin / robin_mc), set before the bridge reads config
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
process.env.HIVE_EARNINGS_POLL = '0'; // tests never poll a live Minecraft server (earnings scoreboards/time)
const NO_RCON = { rcon: async (cmd) => { throw new Error(`no RCON in tests (${cmd})`); }, timers: false }; // never the real :25591

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-mod-test-'));
process.env.HIVE_BLUEPRINTS = path.join(dataDir, 'blueprints'); // before the blueprint modules load
const { LedgerStore, installLedger, causeFor } = await import('../bridge/engine/ledger.js');
const { createApp } = await import('../bridge/hub/app.js');
const { Blueprint } = await import('../bridge/engine/blueprint/model.js');
const { createJob, writeProgress } = await import('../bridge/engine/blueprint/jobs.js');
const { actionText, splitArgs, compass } = await import('../bridge/hub/mod-commands.js');
const mock = await import('./hub-mock-engine.mjs');
const { WebSocket } = await import('ws');

const PORT = Number(process.env.HIVE_MOD_TEST_PORT) || 47975;
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); pass++; console.log('  ok  ', name); }
  catch (e) { fail++; console.log('  FAIL', name, '\n      ', e?.stack?.split('\n').slice(0, 3).join('\n       ') || e); process.exitCode = 1; }
}

// ------------------------------------------------------------------------------------------ 1. ledger store
console.log('ledger store');
await t('add / query box+bot+since / at / last', () => {
  const dir = path.join(dataDir, 'l1');
  const L = new LedgerStore(dir);
  const t0 = Date.now() - 60000;
  L.add({ ts: t0, bot: 'Ash', op: 'break', block: 'stone', x: 1, y: 60, z: 1, cause: 'collect', action: 'collect' });
  L.add({ ts: t0 + 1000, bot: 'Ash', op: 'place', block: 'cobblestone', state: '', prev: 'air', x: 1, y: 60, z: 1, cause: 'place', action: 'place' });
  L.add({ ts: t0 + 2000, bot: 'Flint', op: 'place', block: 'oak_planks', x: 50, y: 70, z: -5, cause: 'blueprint', build: 'hut_1', section: 0, phase: 'place' });
  assert.equal(L.add({ op: 'nonsense', x: 1, y: 2, z: 3 }), null);
  assert.equal(L.add({ op: 'place', x: 'a', y: 2, z: 3 }), null);
  assert.equal(L.query().total, 3);
  assert.equal(L.query({ bot: 'ash' }).total, 2, 'bot filter is case-insensitive');
  assert.equal(L.query({ box: { x1: 0, y1: 0, z1: 0, x2: 10, y2: 100, z2: 10 } }).total, 2);
  assert.equal(L.query({ box: { x1: 40, x2: 60 } }).total, 1, 'partial box = unbounded other axes');
  assert.equal(L.query({ since: t0 + 1500 }).total, 1);
  assert.equal(L.query({ build: 'hut_1' }).events[0].phase, 'place');
  const h = L.at(1, 60, 1);
  assert.deepEqual(h.map((e) => e.op), ['break', 'place']);
  assert.equal(L.last(1, 60, 1).block, 'cobblestone');
  assert.equal(L.at(1, 60, 1, 'nether').length, 0, 'dimension separates positions');
  assert.equal(L.query()[0], undefined);
  assert.equal(L.query().events[0].bot, 'Flint', 'newest first');
  const st = L.stats(0);
  assert.deepEqual(st.byBot.Ash, { place: 1, break: 1 });
  L.close();
});
await t('persists to jsonl and reloads; ids continue', () => {
  const dir = path.join(dataDir, 'l1');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
  assert.equal(files.length, 1);
  const lines = fs.readFileSync(path.join(dir, files[0]), 'utf8').trim().split('\n');
  assert.equal(lines.length, 3);
  const L2 = new LedgerStore(dir);
  assert.equal(L2.query().total, 3);
  assert.equal(L2.at(1, 60, 1).length, 2);
  const e = L2.add({ bot: 'Ash', op: 'break', block: 'dirt', x: 2, y: 60, z: 2, cause: 'tunnel' });
  assert.equal(e.id, 4);
  L2.close();
});
await t('memory caps: ring, per-position history, position count', () => {
  const L = new LedgerStore(path.join(dataDir, 'l2'), { ringMax: 100, posMax: 50, perPos: 3 });
  for (let i = 0; i < 500; i++) L.add({ bot: 'Ash', op: i % 2 ? 'place' : 'break', block: 'dirt', x: i % 80, y: 64, z: 0 });
  for (let i = 0; i < 10; i++) L.add({ bot: 'Ash', op: 'place', block: 'stone', x: 1000, y: 64, z: 0 });
  assert.equal(L.ring.length, 100);
  assert.ok(L.byPos.size <= 50);
  assert.equal(L.at(1000, 64, 0).length, 3);
  L.close();
});

// ------------------------------------------------------------------------------------------ 2. engine hook
console.log('engine hook (fake bot)');
class V { constructor(x, y, z) { this.x = x; this.y = y; this.z = z; } plus(o) { return new V(this.x + o.x, this.y + o.y, this.z + o.z); } offset(a, b, c) { return new V(this.x + a, this.y + b, this.z + c); } clone() { return new V(this.x, this.y, this.z); } }
function fakeBot() {
  const bot = new EventEmitter();
  const world = new Map();
  const k = (p) => `${p.x},${p.y},${p.z}`;
  const mk = (p, name, props = {}) => ({ name, position: new V(p.x, p.y, p.z), getProperties: () => props });
  bot.world = world;
  bot.setBlock = (p, name, props) => { world.set(k(p), mk(p, name, props)); };
  bot.blockAt = (p) => world.get(k(p)) || mk(p, 'air');
  bot.game = { dimension: 'minecraft:overworld' };
  bot.entity = { position: new V(0.5, 64, 0.5), yaw: 1.2, pitch: 0 };
  bot.heldItem = { name: 'wheat_seeds' };
  let digging = false, placing = false;
  bot.pathfinder = { isMining: () => digging, isBuilding: () => placing, goal: { x: 10, y: 64, z: 10 } };
  bot.setPf = (d, p) => { digging = d; placing = p; };
  bot.dig = async (b) => { await sleep(5); bot.setBlock(b.position, 'air'); };
  bot.placeBlock = async (ref, face) => { await sleep(5); bot.setBlock(ref.position.plus(face), bot.nextPlace || 'cobblestone', bot.nextProps || {}); };
  bot.activateBlock = async () => {};
  return bot;
}
await t('dig/place recorded with causes, state, prev, blueprint tags, pathfinder flags', async () => {
  const bot = fakeBot();
  const h = new EventEmitter();
  h.name = 'Ash'; h.bot = bot; h.current = { name: 'collect' }; h.bg = null; h.autoLabel = null; h.ledgerCtx = null;
  const got = [];
  h.on('ledger', (e) => got.push(e));
  installLedger(h);
  installLedger(h); // idempotent
  bot.setBlock(new V(3, 63, 3), 'iron_ore');
  await bot.dig(bot.blockAt(new V(3, 63, 3)), true);
  assert.equal(got.length, 1);
  assert.equal(got[0].op, 'break'); assert.equal(got[0].block, 'iron_ore'); assert.equal(got[0].cause, 'collect'); assert.equal(got[0].bot, 'Ash');
  assert.equal(got[0].dim, 'overworld');
  // dig of air = nothing
  await bot.dig(bot.blockAt(new V(9, 9, 9)), true);
  assert.equal(got.length, 1);
  // place with state, in a blueprint phase
  h.current = { name: 'blueprint_build' };
  h.ledgerCtx = { build: 'hut_1', section: 1, phase: 'place' };
  bot.nextPlace = 'oak_stairs'; bot.nextProps = { half: 'bottom', facing: 'east' };
  bot.setBlock(new V(5, 63, 5), 'grass_block');
  await bot.placeBlock(bot.blockAt(new V(5, 63, 5)), new V(0, 1, 0));
  const p = got[1];
  assert.equal(p.op, 'place'); assert.equal(p.block, 'oak_stairs'); assert.equal(p.state, 'facing=east,half=bottom'); assert.equal(p.prev, 'air');
  assert.deepEqual([p.x, p.y, p.z], [5, 64, 5]);
  assert.equal(p.cause, 'blueprint'); assert.equal(p.build, 'hut_1'); assert.equal(p.section, 1); assert.equal(p.phase, 'place');
  // pathfinder digging during a build: cause pathfinder-dig, still tagged with the build
  bot.setPf(true, false);
  bot.setBlock(new V(6, 64, 6), 'dirt');
  await bot.dig(bot.blockAt(new V(6, 64, 6)));
  assert.equal(got[2].cause, 'pathfinder-dig'); assert.equal(got[2].build, 'hut_1');
  bot.setPf(false, true); h.ledgerCtx = null; h.current = { name: 'goto' };
  bot.nextPlace = 'dirt'; bot.nextProps = {};
  await bot.placeBlock(bot.blockAt(new V(6, 63, 6)), new V(0, 1, 0));
  assert.equal(got[3].cause, 'pathfinder-place');
  bot.setPf(false, false);
  // escape pillar = scaffold
  h.current = { name: 'escape' };
  await bot.placeBlock(bot.blockAt(new V(0, 63, 0)), new V(0, 1, 0));
  assert.equal(got[4].cause, 'scaffold');
  // a failed placeBlock that did place is still recorded, error still thrown
  // activateBlock (seeds on farmland): change seen via blockUpdate
  h.current = { name: 'place' };
  const soil = bot.blockAt(new V(8, 63, 8)); bot.setBlock(soil.position, 'farmland');
  await bot.activateBlock(bot.blockAt(new V(8, 63, 8)), new V(0, 1, 0));
  const nb = { name: 'wheat', position: new V(8, 64, 8), getProperties: () => ({ age: 0 }) };
  bot.emit('blockUpdate', { name: 'air', position: nb.position }, nb);
  assert.equal(got[5].op, 'place'); assert.equal(got[5].block, 'wheat'); assert.equal(got[5].state, 'age=0'); assert.equal(got[5].cause, 'place');
  bot.emit('end');
});
await t('placeBlock rejection still checks the world and rethrows', async () => {
  const bot = fakeBot();
  bot.placeBlock = async (ref, face) => { bot.setBlock(ref.position.plus(face), 'torch'); throw new Error('Event blockUpdate did not fire within timeout'); };
  const h = new EventEmitter(); h.name = 'Wren'; h.bot = bot; h.current = { name: 'place' };
  const got = []; h.on('ledger', (e) => got.push(e));
  installLedger(h);
  await assert.rejects(bot.placeBlock(bot.blockAt(new V(1, 1, 1)), new V(0, 1, 0)), /did not fire/);
  assert.equal(got.length, 1); assert.equal(got[0].block, 'torch');
  bot.emit('end');
});
await t('path + pose events', async () => {
  const bot = fakeBot();
  const h = new EventEmitter(); h.name = 'Lark'; h.bot = bot;
  const paths = [], poses = [];
  h.on('path', (p) => paths.push(p)); h.on('pose', (p) => poses.push(p));
  installLedger(h);
  bot.emit('path_update', { status: 'success', path: [new V(1.5, 64, 1.5), new V(2.5, 64, 1.5)] });
  await sleep(20);
  assert.equal(paths.length, 1);
  assert.deepEqual(paths[0].points, [[1, 64, 1], [2, 64, 1]]);
  assert.deepEqual(paths[0].goal, { x: 10, y: 64, z: 10 });
  bot.emit('goal_reached');
  await sleep(300);
  assert.equal(paths.at(-1).status, 'cleared'); assert.equal(paths.at(-1).points.length, 0);
  await sleep(250);
  assert.ok(poses.length >= 1, 'pose emitted');
  assert.equal(poses[0].yaw, 1.2);
  const n = poses.length; await sleep(450); assert.equal(poses.length, n, 'no pose spam while standing still');
  bot.emit('end');
});
await t('causeFor + actionText + helpers', () => {
  assert.equal(causeFor('collect', 'break'), 'collect');
  assert.equal(causeFor('auto:eat', 'place'), 'auto');
  assert.equal(causeFor('surface', 'place'), 'scaffold');
  assert.equal(causeFor('surface', 'break'), 'tunnel');
  assert.equal(causeFor('blueprint_verify', 'place'), 'blueprint');
  assert.equal(causeFor('craft', 'place'), 'craft');
  assert.equal(causeFor(null, 'place'), 'idle');
  assert.equal(actionText({ action: 'collect', args: { block: 'iron_ore', count: 24 }, counter: { break: 12 } }).text, 'mining iron ore 12/24');
  assert.equal(actionText({ action: 'collect', args: { block: 'oak_log', count: 5 }, counter: { break: 1 } }).text, 'chopping oak log 1/5');
  assert.equal(actionText({ action: null }).text, 'idle');
  assert.equal(actionText({ online: false }).text, 'offline');
  assert.equal(actionText({ action: 'goto', args: { x: 1, y: 2, z: 3 } }).text, 'walking to 1,2,3');
  assert.equal(actionText({ action: 'auto:eat' }).text, 'eating (auto)');
  assert.deepEqual(splitArgs('say Ash "hello there" now'), ['say', 'Ash', 'hello there', 'now']);
  assert.equal(compass({ x: 0, z: 0 }, { x: 0, z: 10 }), 'south');
  assert.equal(compass({ x: 0, z: 0 }, { x: 10, z: 0 }), 'east');
  assert.equal(compass({ x: 0, z: 0 }, { x: -10, z: -10 }), 'north-west');
});

// ------------------------------------------------------------------------------------------ 3. hub + ws
console.log(`hub on :${PORT} with the mock engine`);
// a fake running build job on disk (real job format via jobs.js)
const bp = new Blueprint('hut');
for (let x = 0; x < 3; x++) for (let z = 0; z < 3; z++) bp.set(x, 0, z, 'cobblestone');
bp.set(1, 1, 1, 'oak_stairs[facing=east,half=bottom]');
const job = createJob({ bp, origin: { x: 100, y: 64, z: 100 }, parts: 1, by: 'Flint' });
writeProgress(job, 0, { scaffold: [], failed: {}, done: false, placed: 2, remaining: 8, runs: 1 });
fs.writeFileSync(path.join(process.env.HIVE_BLUEPRINTS, 'builds', job.id, 'sec-0.claim'), JSON.stringify({ bot: 'Flint', ts: Date.now() }));
// an old finished job that must NOT show
const old = createJob({ bp, origin: { x: 0, y: 64, z: 0 }, parts: 1, by: 'Ash' });
writeProgress(old, 0, { done: true, placed: 10, remaining: 0 });
const oldProg = path.join(process.env.HIVE_BLUEPRINTS, 'builds', old.id, 'sec-0.json');
const oj = JSON.parse(fs.readFileSync(oldProg, 'utf8')); oj.updated = Date.now() - 3600000; fs.writeFileSync(oldProg, JSON.stringify(oj));
const oldJob = path.join(process.env.HIVE_BLUEPRINTS, 'builds', old.id, 'job.json');
const ojj = JSON.parse(fs.readFileSync(oldJob, 'utf8')); ojj.created = new Date(Date.now() - 7200000).toISOString(); fs.writeFileSync(oldJob, JSON.stringify(ojj));

const app = createApp({ engine: mock, dataDir, port: PORT, mc: { rconPort: 1 }, econOpts: NO_RCON });
await app.start();
const api = async (method, p, body) => {
  const r = await fetch(BASE + p, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, json: await r.json() };
};
await api('POST', '/bots', { name: 'Ash', role: 'Lead' });
await api('POST', '/bots', { name: 'Flint' });
const ash = mock.registry.get('Ash');
ash.pos = { x: 10, y: 64, z: 10 };

function client(headers = {}) {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/mod`, { headers });
  const msgs = [];
  const waiters = [];
  ws.on('message', (d) => {
    const m = JSON.parse(String(d));
    msgs.push(m);
    for (const w of [...waiters]) if (w.pred(m)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(m); }
  });
  const next = (pred, ms = 4000) => {
    const hit = msgs.find(pred);
    if (hit) { msgs.splice(msgs.indexOf(hit), 1); return Promise.resolve(hit); }
    return new Promise((resolve, reject) => {
      const w = { pred, resolve: (m) => { clearTimeout(timer); msgs.splice(msgs.indexOf(m), 1); resolve(m); } };
      const timer = setTimeout(() => { waiters.splice(waiters.indexOf(w), 1); reject(new Error('timeout waiting for message')); }, ms);
      waiters.push(w);
    });
  };
  const open = new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); ws.once('unexpected-response', (_q, r) => rej(new Error(`HTTP ${r.statusCode}`))); });
  let cid = 0;
  const cmd = async (text, player = { name: 'Robin', x: 0, y: 64, z: 0, dim: 'overworld' }) => {
    const id = ++cid;
    ws.send(JSON.stringify({ t: 'command', id, text, player }));
    return next((m) => m.t === 'command_result' && m.id === id, 8000);
  };
  return { ws, msgs, next, open, cmd };
}
const flat = (r) => r.lines.map((l) => l.map((s) => s.text).join('')).join('\n');

const C1 = client();
await t('ws connects; init has bots, ghosts (running job only), commands', async () => {
  await C1.open;
  const init = await C1.next((m) => m.t === 'init');
  assert.equal(init.protocol, 1);
  assert.deepEqual(init.bots.map((b) => b.name).sort(), ['Ash', 'Flint']);
  const a = init.bots.find((b) => b.name === 'Ash');
  assert.match(a.color, /^#[0-9A-F]{6}$/i); assert.equal(a.colorInt, parseInt(a.color.slice(1), 16));
  assert.equal(a.role, 'Lead'); assert.equal(a.actionText, 'idle');
  assert.equal(init.ghosts.length, 1, `only the live job: ${init.ghosts.map((g) => g.id)}`);
  const g = init.ghosts[0];
  assert.equal(g.id, job.id); assert.equal(g.kind, 'build'); assert.equal(g.total, 10); assert.equal(g.done, 2); assert.equal(g.progress, 20);
  assert.equal(g.bot, 'Flint'); assert.equal(g.blocks.length, 10);
  assert.ok(g.blocks.some((b) => b[3] === 'oak_stairs' && b[4] === 'facing=east,half=bottom'));
  assert.ok(init.commands.includes('who'));
  C1.ws.send(JSON.stringify({ t: 'hello', player: 'Robin', version: 'test' }));
  await C1.next((m) => m.t === 'hello_ok');
});
await t('bots message at ~5 Hz with pose/yaw from engine', async () => {
  ash.emit('pose', { x: 10.25, y: 64, z: 10.75, yaw: 3.14, pitch: 0.1, dim: 'overworld' });
  const t0 = Date.now();
  let m;
  for (let i = 0; i < 3; i++) m = await C1.next((x) => x.t === 'bots');
  const dt = Date.now() - t0;
  assert.ok(dt < 1500, `3 bots frames took ${dt}ms`);
  const a = m.bots.find((b) => b.name === 'Ash');
  assert.deepEqual(a.pos, { x: 10.25, y: 64, z: 10.75 }); assert.equal(a.yaw, 3.14); assert.deepEqual(a.bpos, { x: 10, y: 64, z: 10 });
});
await t('ledger events: live ws batch + HTTP area/at queries + action progress text', async () => {
  const act = api('POST', '/bots/Ash/act', { action: 'collect', args: { block: 'iron_ore', count: 4, ms: 1500 } });
  await sleep(150);
  for (let i = 0; i < 2; i++) ash.emit('ledger', { ts: Date.now(), bot: 'Ash', op: 'break', block: 'iron_ore', state: '', x: 20 + i, y: 12, z: -80, dim: 'overworld', cause: 'collect', action: 'collect' });
  const lm = await C1.next((m) => m.t === 'ledger');
  assert.ok(lm.events.length >= 1); assert.equal(lm.events[0].bot, 'Ash'); assert.equal(lm.events[0].block, 'iron_ore');
  const bm = await C1.next((m) => m.t === 'bots' && m.bots.find((b) => b.name === 'Ash')?.actionText === 'mining iron ore 2/4');
  assert.deepEqual(bm.bots.find((b) => b.name === 'Ash').progress, { done: 2, total: 4 });
  await act;
  const q = await api('GET', '/mod/ledger?x1=0&y1=0&z1=-100&x2=30&y2=100&z2=0&bot=Ash');
  assert.equal(q.json.ok, true); assert.equal(q.json.total, 2);
  const at = await api('GET', '/mod/ledger/at?x=21&y=12&z=-80');
  assert.equal(at.json.history.length, 1); assert.equal(at.json.last.op, 'break');
  const bad = await api('GET', '/mod/ledger/at?x=1');
  assert.equal(bad.status, 400);
  const stats = await api('GET', '/mod/ledger/stats?minutes=5');
  assert.equal(stats.json.byBot.Ash.break, 2);
  assert.ok(fs.existsSync(path.join(dataDir, 'ledger')), 'ledger dir created');
});
await t('build ghost: ledger place on a target cell flips placed + rev; blocks omitted when unchanged', async () => {
  const g0 = (await api('GET', '/mod/ghosts')).json.ghosts.find((g) => g.id === job.id);
  mock.registry.get('Flint').emit('ledger', { bot: 'Flint', op: 'place', block: 'oak_stairs', state: 'facing=east,half=bottom', x: 101, y: 65, z: 101, dim: 'overworld', cause: 'blueprint', build: job.id, section: 0, phase: 'place' });
  const gm = await C1.next((m) => m.t === 'ghosts' && m.ghosts.some((g) => g.id === job.id && g.blocks), 6000);
  const g = gm.ghosts.find((x) => x.id === job.id);
  assert.ok(g.rev > g0.rev);
  assert.equal(g.blocks.find((b) => b[0] === 101 && b[1] === 65 && b[2] === 101)[5], 1);
  // unchanged ghost on the next push carries no blocks
  writeProgress(job, 0, { scaffold: [], failed: {}, done: false, placed: 3, remaining: 7, runs: 2 });
  const gm2 = await C1.next((m) => m.t === 'ghosts', 6000);
  const g2 = gm2.ghosts.find((x) => x.id === job.id);
  assert.equal(g2.done, 3);
  assert.ok(g2.blocks, 'rev changed (done count), so blocks resent');
  const one = await api('GET', `/mod/ghosts/${encodeURIComponent(job.id)}`);
  assert.equal(one.json.ghost.blocks.length, 10);
  const nob = await api('GET', '/mod/ghosts?blocks=0');
  assert.equal(nob.json.ghosts[0].blocks, undefined);
});
await t('blueprint_preview result becomes a preview ghost; blueprint_build drops it', async () => {
  app.modApi.onAct('Ash', { action: 'blueprint_preview', args: { name: 'hut', x: 200, y: 64, z: 200 } },
    { ok: true, result: { text: 'Preview…', view: { ghosts: [{ x: 200, y: 64, z: 200, block: 'cobblestone', props: {}, tint: 'ok' }, { x: 201, y: 64, z: 200, block: 'dirt', props: {}, tint: 'conflict' }] } } });
  const gm = await C1.next((m) => m.t === 'ghosts' && m.ghosts.some((g) => g.kind === 'preview'), 6000);
  const p = gm.ghosts.find((g) => g.kind === 'preview');
  assert.equal(p.id, 'preview:Ash:hut:200:64:200'); assert.equal(p.conflicts, 1); assert.equal(p.blocks[1][6], 'conflict');
  assert.ok(p.expires > Date.now() + 9 * 60000);
  app.modApi.onAct('Ash', { action: 'blueprint_build', args: { name: 'hut', x: 200, y: 64, z: 200 } }, { ok: true, result: 'x' });
  await C1.next((m) => m.t === 'ghosts' && !m.ghosts.some((g) => g.kind === 'preview'), 6000);
});
await t('path + trail + chat + board + goal + photo + log + event pushes', async () => {
  ash.emit('path', { ts: Date.now(), dim: 'overworld', goal: { x: 40, y: 64, z: 40 }, points: [[10, 64, 10], [11, 64, 10]], status: 'success' });
  const pm = await C1.next((m) => m.t === 'path');
  assert.equal(pm.bot, 'Ash'); assert.equal(pm.points.length, 2);
  ash.emit('pose', { x: 14, y: 64, z: 10, yaw: 0, pitch: 0, dim: 'overworld' });
  const tm = await C1.next((m) => m.t === 'trail' && m.trails.Ash);
  assert.ok(tm.trails.Ash.length >= 1);
  const tr = await api('GET', '/mod/trails');
  assert.ok(tr.json.trails.Ash.length >= 2); assert.equal(tr.json.paths.Ash.points.length, 2);
  await api('POST', '/msg', { from: 'Ash', to: 'all', text: 'found iron at 40,12,-80' });
  const cm = await C1.next((m) => m.t === 'chat' && m.msg.from === 'Ash');
  assert.match(cm.msg.color, /^#/);
  const bm = await C1.next((m) => m.t === 'bots' && m.bots.find((b) => b.name === 'Ash')?.lastChat?.text === 'found iron at 40,12,-80');
  assert.ok(bm);
  const task = (await api('POST', '/board', { by: 'Ash', title: 'Get 24 iron' })).json;
  await C1.next((m) => m.t === 'board' && m.task.id === task.id);
  await api('POST', `/board/${task.id}/claim`, { by: 'Ash' });
  await C1.next((m) => m.t === 'bots' && m.bots.find((b) => b.name === 'Ash')?.task?.id === task.id);
  await api('POST', '/goal', { text: 'Build a castle', by: 'Robin' });
  await C1.next((m) => m.t === 'goal' && m.goal.text === 'Build a castle');
  app.modApi.onBroadcast('photo', { id: 'Ash-1763700000000', agent: 'Ash', ts: 1763700000000, caption: 'the hut', mode: 'orbit', meta: { width: 768, height: 432 } });
  const ph = await C1.next((m) => m.t === 'photo');
  assert.equal(ph.photo.url, '/photos/Ash-1763700000000.png'); assert.equal(ph.photo.width, 768);
  await api('POST', '/log/Ash', { kind: 'tool', text: 'collect {"block":"iron_ore","count":24}' });
  const lg = await C1.next((m) => m.t === 'log' && m.bot === 'Ash');
  assert.equal(lg.kind, 'tool');
  ash.event('hurt', 'Took damage');
  const ev = await C1.next((m) => m.t === 'event' && m.bot === 'Ash');
  assert.equal(ev.kind, 'hurt');
});
await t('commands: help, bots, status, where, goal, board, board add/done', async () => {
  let r = await C1.cmd('help');
  assert.equal(r.ok, true); assert.match(flat(r), /who <x> <y> <z>/);
  assert.ok(r.lines.every((l) => Array.isArray(l) && l.every((s) => typeof s.text === 'string')));
  r = await C1.cmd('bots'); assert.match(flat(r), /Ash/); assert.match(flat(r), /Flint/);
  r = await C1.cmd('status ash'); assert.equal(r.ok, true); assert.match(flat(r), /Ash/); assert.match(flat(r), /task.*Get 24 iron/);
  r = await C1.cmd('status Nobody'); assert.equal(r.ok, false); assert.match(flat(r), /no bot named/);
  r = await C1.cmd('where Ash'); assert.match(flat(r), /blocks (south|south-east|east)/);
  r = await C1.cmd('goal'); assert.match(flat(r), /Build a castle/);
  r = await C1.cmd('goal Get diamonds'); assert.equal(app.store.goal.text, 'Get diamonds'); assert.equal(app.store.goal.by, 'Robin');
  r = await C1.cmd('board add Build a wall'); assert.equal(r.ok, true);
  const id = r.data.task.id;
  assert.equal(app.store.task(id).by, 'Robin');
  r = await C1.cmd('board'); assert.match(flat(r), /Build a wall/);
  r = await C1.cmd(`board done ${id}`); assert.equal(app.store.task(id).status, 'done');
});
await t('say interrupts the bot (existing human-message path); stop; come walks to the player; follow', async () => {
  const running = api('POST', '/bots/Ash/act', { action: 'wait', args: { seconds: 6 } });
  await sleep(150);
  let r = await C1.cmd('say Ash please come help');
  assert.equal(r.ok, true);
  const out = (await running).json;
  assert.equal(out.ok, false); assert.match(out.error, /Robin/);
  const m = app.store.messages.at(-1); assert.equal(m.from, 'Robin'); assert.equal(m.to, 'Ash');
  r = await C1.cmd('say all hello team'); assert.equal(app.store.messages.at(-1).to, 'all');
  const running2 = api('POST', '/bots/Flint/act', { action: 'wait', args: { seconds: 6 } });
  await sleep(150);
  r = await C1.cmd('stop Flint'); assert.match(flat(r), /stopped \(was wait\)/);
  await running2;
  r = await C1.cmd('come Ash', { name: 'Robin', x: 33.7, y: 70, z: -12.2, dim: 'overworld' });
  assert.equal(r.ok, true); assert.match(flat(r), /coming/);
  for (let i = 0; i < 30 && ash.pos.x !== 33; i++) await sleep(100);
  assert.deepEqual(ash.pos, { x: 33, y: 70, z: -13 });
  r = await C1.cmd('come Ash', null); assert.equal(r.ok, true, 'falls back to the last position the mod sent');
  r = await C1.cmd('follow Ash'); // the mock engine has no follow action: the command must reach act and report it
  assert.match(app.store.messages.at(-1).text, /^follow me \(Robin\)/); assert.match(flat(r), mock.ACTIONS.some((a) => a.name === 'follow') ? /following Robin/ : /can't follow: unknown action/);
  r = await C1.cmd('follow all'); assert.equal(r.ok, false);
  r = await C1.cmd('stop all'); assert.equal(r.ok, true); assert.equal(r.lines.length, 2);
});
await t('commands: who, placed, builds, photos, photo, log, unknown, pause', async () => {
  let r = await C1.cmd('who 21 12 -80'); assert.match(flat(r), /Ash broke iron ore/); assert.equal(r.data.history.length, 1);
  r = await C1.cmd('who 5 5 5'); assert.match(flat(r), /no bot has touched/);
  r = await C1.cmd('who', { name: 'Robin', x: 0, y: 64, z: 0, dim: 'overworld', look: { x: 101, y: 65, z: 101 } }); assert.match(flat(r), /Flint placed oak stairs/);
  r = await C1.cmd('placed Ash 10'); assert.match(flat(r), /−2 broken/); assert.match(flat(r), /iron ore 2/);
  r = await C1.cmd('placed all'); assert.match(flat(r), /Flint/);
  r = await C1.cmd('builds'); assert.match(flat(r), /hut/); assert.match(flat(r), /\d+%/);
  r = await C1.cmd('photos'); assert.match(flat(r), /the hut/); assert.equal(r.lines[1][1].click, 'photo Ash-1763700000000');
  r = await C1.cmd('photo Ash-1763700000000'); assert.equal(r.data.open, '/photos/Ash-1763700000000.png');
  r = await C1.cmd('log Ash 3'); assert.match(flat(r), /collect/);
  r = await C1.cmd('dance'); assert.equal(r.ok, false); assert.match(flat(r), /unknown command/);
  r = await C1.cmd('pause Ash'); assert.equal(r.ok, false); assert.match(flat(r), /not supported/);
  r = await C1.cmd(''); assert.equal(r.ok, false);
});
await t('HTTP: /mod/hello, /mod/state, /mod/photos, POST /mod/command', async () => {
  const h = await api('GET', '/mod/hello'); assert.equal(h.json.protocol, 1); assert.deepEqual(h.json.bots.sort(), ['Ash', 'Flint']);
  const s = await api('GET', '/mod/state'); assert.equal(s.json.bots.length, 2); assert.ok(Array.isArray(s.json.ledgerRecent));
  const p = await api('GET', '/mod/photos?bot=ash'); assert.equal(p.json.photos.length, 1);
  const c = await api('POST', '/mod/command', { text: 'bots', player: { x: 0, y: 64, z: 0 } }); assert.equal(c.json.ok, true); assert.ok(c.json.lines.length >= 3);
});
await t('ws refuses a foreign Origin and a bad Host; other paths are not upgraded', async () => {
  const evil = client({ Origin: 'http://evil.example' });
  await assert.rejects(evil.open, /403/);
  const badHost = client({ Host: 'evil.example:47975' });
  await assert.rejects(badHost.open, /403/);
  const other = new WebSocket(`ws://127.0.0.1:${PORT}/events`);
  await assert.rejects(new Promise((res, rej) => { other.once('open', res); other.once('error', rej); }));
});
await t('existing routes still work (dashboard state, act passthrough)', async () => {
  const st = await api('GET', '/state'); assert.equal(st.json.bots.length, 2);
  const r = await api('POST', '/bots/Flint/act', { action: 'scan', args: {} }); assert.equal(r.json.ok, true);
});

C1.ws.close();
await app.close();
console.log(`\n${pass} passed, ${fail} failed`);
fs.rmSync(dataDir, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
