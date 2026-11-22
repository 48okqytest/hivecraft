// LIVE test of the blueprint planner + executor: a scripted mineflayer bot (no Claude) builds a small house with a
// stair roof, door, slabs, windows, logs, torches, trapdoor, ladder, furnace in SURVIVAL far from spawn, then the
// SERVER (RCON `execute if block ...`) confirms every block state. Then a rotated copy is split between two bots.
//   OPT-IN ONLY (edits the live world, connects bots): node test/blueprint-live.mjs --live [--no-render] [--only=house|split] [--x=600 --z=600]
// Needs the MC server on 25590 (RCON 25591). Uses blueprints dir data/blueprints-test (not the real one).
// The owner has said NO live tests unless they ask: do not run this without their OK.
if (!process.argv.includes('--live') && process.env.HIVE_LIVE_TESTS !== '1') {
  console.log('blueprint-live.mjs is a LIVE server test (scripted bots + RCON world edits). Skipped. Run with --live only when the owner allows it.');
  process.exit(0);
}
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.env.HIVE_BLUEPRINTS = process.env.HIVE_BLUEPRINTS || path.join(ROOT, 'data', 'blueprints-test');
process.env.HIVE_URL = process.env.HIVE_URL || 'http://127.0.0.1:1'; // no hub: base chest comes from the test
fs.rmSync(path.join(process.env.HIVE_BLUEPRINTS, 'builds'), { recursive: true, force: true });

const args = Object.fromEntries(process.argv.slice(2).map((a) => { const [k, v] = a.replace(/^--/, '').split('='); return [k, v ?? true]; }));
const { spawnBot } = await import('../bridge/engine/index.js');
const { rconConnect } = await import('./engine-rcon.mjs');
const { loadBlueprint } = await import('../bridge/engine/blueprint/model.js');
const { targetsFor, billOfMaterials } = await import('../bridge/engine/blueprint/plan.js');
const { getMcData } = await import('../bridge/engine/util.js');
const { isAutoPart } = await import('../bridge/engine/blueprint/states.js');
const mc = getMcData('1.21.1');

const OUT = path.join(ROOT, 'data', 'blueprint-live');
fs.mkdirSync(OUT, { recursive: true });
const rcon = await rconConnect();
const R = (c) => rcon.cmd(c);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, cond, info = '') => { results.push({ name, ok: !!cond }); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${info ? ' :: ' + String(info).replace(/\n/g, ' | ').slice(0, 600) : ''}`); };

const list = await R('list');
if (!/There are 0 of/.test(list)) console.log('NOTE: players online:', list, '(test area is far from spawn)');

const X = Number(args.x || 600), Y = 70, Z = Number(args.z || 600);
// ---------- site prep (flat platform with a mound, a hole and a log to exercise clear/fill) ----------
await R(`forceload add ${X - 12} ${Z - 12} ${X + 40} ${Z + 24}`);
await R(`fill ${X - 12} ${Y - 6} ${Z - 12} ${X + 40} ${Y - 2} ${Z + 24} dirt`);
await R(`fill ${X - 12} ${Y - 1} ${Z - 12} ${X + 40} ${Y - 1} ${Z + 24} grass_block`);
for (let y = Y; y <= Y + 24; y += 4) await R(`fill ${X - 12} ${y} ${Z - 12} ${X + 40} ${y + 3} ${Z + 24} air`); // /fill max 32768 blocks per call
await R(`fill ${X + 1} ${Y} ${Z + 1} ${X + 3} ${Y + 1} ${Z + 2} dirt`); // mound inside the house volume
await R(`fill ${X + 4} ${Y - 3} ${Z + 3} ${X + 5} ${Y - 1} ${Z + 4} air`); // hole under the floor
await R(`fill ${X + 7} ${Y} ${Z + 3} ${X + 7} ${Y + 3} ${Z + 3} oak_log`); // trunk under the roof overhang
await R('time set day');
// base chest for restocking (some stairs are left out of the bot's inventory on purpose)
const CH = { x: X - 6, y: Y, z: Z - 6 };
process.env.HIVE_BASE_CHEST = `${CH.x},${CH.y},${CH.z}`;
await R(`setblock ${CH.x} ${CH.y} ${CH.z} chest`);

const HOUSE = `
name('bp_test_house');
describe('7x6 test cottage: log frame, cobble walls, spruce gable roof');
floor(0,0,6,5,0,'oak_planks');
walls(0,1,0,6,3,5,'cobblestone');
for (const [x,z] of [[0,0],[6,0],[0,5],[6,5]]) for (let y=1;y<=3;y++) pillar(x,y,z,'oak','y');
for (let x=0;x<=6;x++) { pillar(x,4,0,'oak','x'); pillar(x,4,5,'oak','x'); }
for (let z=1;z<=4;z++) { pillar(0,4,z,'oak','z'); pillar(6,4,z,'oak','z'); }
clear(1,1,1,5,3,4);
door(3,1,0,'oak','south',{hinge:'left'});
window(1,2,0,2,2,0); window(4,2,0,5,2,0); window(0,2,2,0,2,3); window(6,2,2,6,2,3); window(2,2,5,4,2,5);
torch(3,3,1,'south'); torch(3,3,4,'north');
block(5,1,4,'furnace[facing=north]');
slab(1,1,4,'oak','bottom'); slab(1,1,3,'oak','double'); slab(2,1,4,'oak','top');
stairs(4,1,4,'oak','east'); stairs(4,1,3,'oak','west','top');
block(1,3,1,'oak_trapdoor[facing=south,half=top,open=false]');
ladder(5,2,4,'north'); ladder(5,3,4,'north');
roof(0,5,0,6,5,'spruce',{type:'gable',axis:'x'});
`;

async function mkBot(name) {
  await R(`kick ${name}`); await sleep(300);
  const h = await spawnBot({ name });
  await sleep(1000);
  await R(`gamemode survival ${name}`);
  await R(`clear ${name}`);
  await R(`effect give ${name} resistance 1800 4 true`);
  await R(`effect give ${name} saturation 1800 1 true`);
  await R(`effect give ${name} regeneration 1800 1 true`);
  h.on('event', (e) => { if (!/item_picked|night|day_broke/.test(e.kind)) console.log(`   [${name} event]`, e.kind, e.text.slice(0, 120)); });
  return h;
}

async function giveFor(name, bp, { exclude = {}, extra = {} } = {}) {
  const { need } = billOfMaterials(targetsFor(bp, { origin: { x: 0, y: 0, z: 0 } }).map((t) => ({ ...t, status: 'place' })), mc);
  for (const [item, n] of need) {
    const k = Math.ceil(n * 1.1) + 1 - (exclude[item] || 0);
    if (k > 0) await R(`give ${name} ${item} ${k}`);
  }
  for (const [item, n] of Object.entries(extra)) await R(`give ${name} ${item} ${n}`);
  return need;
}

// server-side truth: every blueprint block checked with `execute if block`
async function serverVerify(bp, place, label) {
  const targets = targetsFor(bp, place).filter((t) => !t.air);
  const bad = [];
  for (const t of targets) {
    const props = Object.entries(t.props).filter(([k]) => !['shape', 'waterlogged', 'powered', 'occupied'].includes(k));
    const spec = props.length ? `${t.name}[${props.map(([k, v]) => `${k}=${v}`).join(',')}]` : t.name;
    const r = await R(`execute if block ${t.x} ${t.y} ${t.z} minecraft:${spec}`);
    if (!/passed/i.test(r)) bad.push(`${spec} @${t.x},${t.y},${t.z}`);
  }
  const airBad = [];
  for (const t of targetsFor(bp, place).filter((q) => q.air)) {
    const r = await R(`execute if block ${t.x} ${t.y} ${t.z} minecraft:air`);
    if (!/passed/i.test(r)) airBad.push(`${t.x},${t.y},${t.z}`);
  }
  check(`${label}: server confirms all ${targets.length} block states`, !bad.length, bad.length ? `${bad.length} wrong: ${bad.slice(0, 12).join('; ')}` : 'stairs/slabs/door/logs/torches/trapdoor/ladder/furnace all exact');
  check(`${label}: interior air is empty`, !airBad.length, airBad.slice(0, 8).join('; '));
  return bad;
}

let render = null;
if (!args['no-render']) {
  try { render = (await import('../bridge/viewer/render.js')).renderView; } catch (e) { console.log('viewer not available:', e.message); }
}
async function snap(h, file, opts) {
  if (!render) return;
  try {
    const { png, meta } = await render({ handle: h, ...opts });
    fs.writeFileSync(path.join(OUT, file), png);
    console.log(`   render -> data/blueprint-live/${file} (${png.length} bytes${meta.ghosts ? `, ghosts ok ${meta.ghosts.ok} done ${meta.ghosts.done} conflict ${meta.ghosts.conflict}` : ''})`);
  } catch (e) { console.log(`   render ${file} failed: ${e.message}`); }
}

// ======================================================================
const A = await mkBot('BpTest');
const run = (a, p = {}, o = {}) => A.run(a, p, o);
await R(`tp BpTest ${X + 3} ${Y} ${Z - 5}`); await sleep(2500);

if (!args.only || args.only === 'house') {
  const w = await run('blueprint_write', { name: 'bp_test_house', code: HOUSE });
  check('blueprint_write', /Saved/.test(w), w.split('\n')[0]);
  const bp = loadBlueprint('bp_test_house');
  const sv = await run('site_survey', { x: X - 1, z: Z - 1, width: 9, depth: 8 });
  check('site_survey sees mound, hole and tree', /cut [1-9]/.test(sv) && /fill [1-9]/.test(sv), sv.split('\n')[0]);
  console.log(sv);
  const fs1 = await run('find_build_site', { width: 9, depth: 8, radius: 10, x: X + 3, z: Z + 3 });
  check('find_build_site returns sites', /origin x=/.test(fs1), fs1.split('\n').slice(0, 2).join(' / '));
  const pv = await A.run('blueprint_preview', { name: 'bp_test_house', x: X, y: Y, z: Z });
  check('blueprint_preview text + ghosts', pv && typeof pv === 'object' && pv.view.ghosts.length > 200 && /in conflict/.test(pv.text), typeof pv === 'object' ? pv.text : pv);
  if (typeof pv === 'object') {
    const confl = pv.view.ghosts.filter((g) => g.tint === 'conflict').length;
    check('preview marks the mound/log as conflicts', confl >= 3, `${confl} conflict ghosts`);
    await snap(A, 'preview.png', { ghosts: pv.view.ghosts, width: 1024, height: 640 });
  }

  // materials: hold back 12 spruce_stairs and put them in the base chest -> build must restock
  await giveFor('BpTest', bp, { exclude: { spruce_stairs: 30 }, extra: { dirt: 64, stone_pickaxe: 1, stone_shovel: 1, stone_axe: 1 } });
  await R(`data merge block ${CH.x} ${CH.y} ${CH.z} {Items:[{Slot:0b,id:"minecraft:spruce_stairs",count:40}]}`);
  await sleep(800);
  const ck = await run('blueprint_check', { name: 'bp_test_house', x: X, y: Y, z: Z });
  console.log(ck);
  check('blueprint_check counts inventory + base chest and site work', /spruce_stairs \d+\/\d+\/40/.test(ck) && /dig [1-9]/.test(ck), ck.split('\n')[1]);

  // --- interrupt mid-build, then resume
  const ac = new AbortController();
  const t0 = Date.now();
  setTimeout(() => ac.abort(), 25000);
  let firstErr = null;
  try { await A.run('blueprint_build', { name: 'bp_test_house', x: X, y: Y, z: Z }, { signal: ac.signal }); } catch (e) { firstErr = e.message; }
  check('interrupt stops blueprint_build quickly', firstErr && /Stopped/.test(firstErr) && Date.now() - t0 < 33000, `${firstErr} after ${Date.now() - t0} ms`);
  const jobsDir = path.join(process.env.HIVE_BLUEPRINTS, 'builds');
  const jid = fs.readdirSync(jobsDir)[0];
  const prog = JSON.parse(fs.readFileSync(path.join(jobsDir, jid, 'sec-0.json'), 'utf8'));
  check('progress saved on interrupt', prog && prog.updated && prog.runs === 1, JSON.stringify({ placed: prog.placed, runs: prog.runs, scaffold: prog.scaffold?.length }));

  // restock: the base chest comes from HIVE_BASE_CHEST (normally the hub's base_chest waypoint)
  let out = '', allOut = '';
  for (let i = 0; i < 10; i++) {
    out = await A.run('blueprint_build', { build_id: jid });
    allOut += `${out}\n`;
    console.log(`--- build call ${i + 1}:\n${out}`);
    if (/BUILD COMPLETE|finished/.test(out)) break;
    if (/OUT OF MATERIALS/.test(out) && i > 3) break;
  }
  check('blueprint_build completes', /BUILD COMPLETE/.test(out), out.split('\n').slice(-2).join(' / '));
  check('restocked missing stairs from the base chest', /Restocked: .*spruce_stairs/.test(allOut), (/Restocked: .*/.exec(allOut) || ['no restock line'])[0]);
  const vf = await run('blueprint_verify', { build_id: jid });
  check('blueprint_verify all good', /All good/.test(vf), vf);
  await serverVerify(bp, { origin: { x: X, y: Y, z: Z } }, 'house');
  // scaffolding gone + terrain inside the volume cleared
  const dirtLeft = [];
  for (let x = X - 1; x <= X + 7; x++) for (let z = Z - 1; z <= Z + 6; z++) for (let y = Y; y <= Y + 9; y++) {
    const r = await R(`execute if block ${x} ${y} ${z} #minecraft:dirt`);
    if (/passed/i.test(r)) dirtLeft.push(`${x},${y},${z}`);
  }
  check('no dirt/scaffold left in the build volume', !dirtLeft.length, dirtLeft.slice(0, 10).join('; '));
  // fix pass: break 3 blocks + flip a stair, verify finds them, fix repairs
  await R(`setblock ${X + 3} ${Y + 6} ${Z + 1} air`);
  await R(`setblock ${X + 2} ${Y + 4} ${Z} air`);
  await R(`setblock ${X + 1} ${Y + 5} ${Z - 1} spruce_stairs[facing=east]`);
  await sleep(800);
  const v2 = await run('blueprint_verify', { build_id: jid });
  check('verify finds damage', /MISSING \(2\)/.test(v2) && /WRONG STATE \(1\)/.test(v2), v2);
  const v3 = await run('blueprint_verify', { build_id: jid, fix: true });
  check('verify fix=true repairs it', /After fix: \d+\/\d+ blocks correct \(100%\)/.test(v3), v3.split('\n').slice(-2).join(' / '));
  await serverVerify(bp, { origin: { x: X, y: Y, z: Z } }, 'house after fix');
  await snap(A, 'house-built.png', { camera: { mode: 'orbit', target: { x: X + 3, y: Y + 3, z: Z + 2 }, distance: 16, angle: 210, elevation: 25 }, width: 1024, height: 640 });
  await snap(A, 'house-built-2.png', { camera: { mode: 'orbit', target: { x: X + 3, y: Y + 3, z: Z + 2 }, distance: 16, angle: 30, elevation: 30 }, width: 1024, height: 640 });
}

// ======================================================================
if (!args.only || args.only === 'split') {
  const bp = loadBlueprint('bp_test_house');
  const B = await mkBot('BpTest2');
  const X2 = X + 24, Z2 = Z + 2; // rotated 90: footprint x X2-6..X2+1, z Z2-1..Z2+7
  await R(`tp BpTest ${X2 - 3} ${Y} ${Z2 - 4}`); await R(`tp BpTest2 ${X2 - 3} ${Y} ${Z2 + 10}`); await sleep(2500);
  await R('clear BpTest'); await sleep(300);
  for (const n of ['BpTest', 'BpTest2']) await giveFor(n, bp, { extra: { dirt: 64, stone_pickaxe: 1, stone_shovel: 1 } });
  await sleep(800);
  const { createJob } = await import('../bridge/engine/blueprint/jobs.js');
  const job = createJob({ bp, origin: { x: X2, y: Y, z: Z2 }, rotation: 90, parts: 2, by: 'test' });
  const jid = job.id;
  check('split build: job with 2 sections', job.sections.length === 2, JSON.stringify(job.sections));
  const loop = async (h, label) => {
    let o = '';
    for (let i = 0; i < 10; i++) {
      o = await h.run('blueprint_build', { build_id: jid });
      console.log(`--- ${label} call ${i + 1}:\n${o}`);
      if (/BUILD COMPLETE|finished|being built by others|Still open/.test(o) && !/Time slice/.test(o)) break;
    }
    return o;
  };
  const [oa, ob] = await Promise.all([loop(A, 'BpTest'), loop(B, 'BpTest2')]);
  check('split build: bots took different sections', /section 1\/2/.test(oa) && /section 2\/2/.test(ob) || /section 2\/2/.test(oa) && /section 1\/2/.test(ob), `${oa.split('\n')[0]} || ${ob.split('\n')[0]}`);
  let fin = /BUILD COMPLETE/.test(oa + ob) ? oa + ob : await A.run('blueprint_build', { build_id: jid });
  if (!/BUILD COMPLETE|finished/.test(fin)) fin = await A.run('blueprint_verify', { build_id: jid, fix: true });
  console.log(fin);
  await serverVerify(bp, { origin: { x: X2, y: Y, z: Z2 }, rotation: 90 }, 'rotated split house');
  await snap(A, 'split-built.png', { camera: { mode: 'orbit', target: { x: X2 - 2, y: Y + 3, z: Z2 + 3 }, distance: 17, angle: 200, elevation: 28 }, width: 1024, height: 640 });
  B.quit();
}

A.quit();
const passed = results.filter((r) => r.ok).length;
console.log(`\n${passed}/${results.length} passed`);
try { const { closeViewer } = await import('../bridge/viewer/render.js'); await closeViewer(); } catch { /* */ }
rcon.close();
process.exit(passed === results.length ? 0 : 1);
