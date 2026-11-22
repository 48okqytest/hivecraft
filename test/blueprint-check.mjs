// Unit tests for the blueprint system (no server needed): node test/blueprint-check.mjs
import './neutral-player.mjs'; // neutral human player (Robin / robin_mc), live ports blocked
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-bp-'));
process.env.HIVE_BLUEPRINTS = TMP; // model.js reads this at import time
const { getMcData } = await import('../bridge/engine/util.js');
const S = await import('../bridge/engine/blueprint/states.js');
const M = await import('../bridge/engine/blueprint/model.js');
const D = await import('../bridge/engine/blueprint/dsl.js');
const R = await import('../bridge/engine/blueprint/rules.js');
const SV = await import('../bridge/engine/blueprint/survey.js');
const P = await import('../bridge/engine/blueprint/plan.js');
const J = await import('../bridge/engine/blueprint/jobs.js');
const I = await import('../bridge/engine/blueprint/importers.js');
const nbt = (await import('prismarine-nbt')).default;
const mc = getMcData('1.21.1');

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); pass++; console.log(`PASS ${name}`); } catch (e) { fail++; console.log(`FAIL ${name}: ${e.stack?.split('\n').slice(0, 3).join(' | ')}`); }
}
const eq = (a, b, m = '') => { const sa = JSON.stringify(a), sb = JSON.stringify(b); if (sa !== sb) throw new Error(`${m} expected ${sb}, got ${sa}`); };
const ok = (c, m) => { if (!c) throw new Error(m || 'assert'); };
const throws = (fn, re) => { try { fn(); } catch (e) { if (re && !re.test(e.message)) throw new Error(`wrong error: ${e.message}`); return; } throw new Error('expected an error'); };

// ---------- states ----------
await t('parse/format states', () => {
  eq(S.parseState('minecraft:oak_stairs[facing=north, half=top]'), { name: 'oak_stairs', props: { facing: 'north', half: 'top' } });
  eq(S.formatState('oak_stairs', { half: 'top', facing: 'north' }), 'oak_stairs[facing=north,half=top]');
  eq(S.normalizeState(mc, 'oak_log[axis=X]'), { name: 'oak_log', props: { axis: 'x' } });
  eq(S.normalizeState(mc, { name: 'oak_door', props: { open: true } }).props.open, 'true');
});
await t('validation errors are helpful', () => {
  throws(() => S.normalizeState(mc, 'oak_stairz'), /Unknown block "oak_stairz".*oak/);
  throws(() => S.normalizeState(mc, 'oak_stairs[facing=up]'), /Valid: north, south, west, east/);
  throws(() => S.normalizeState(mc, 'stone[facing=north]'), /has no state "facing"/);
});
await t('rotate props: facing, axis, rotation16, connections', () => {
  eq(S.rotateProps('oak_stairs', { facing: 'north', half: 'top' }, 1), { facing: 'east', half: 'top' });
  eq(S.rotateProps('oak_stairs', { facing: 'north' }, 2).facing, 'south');
  eq(S.rotateProps('oak_stairs', { facing: 'north' }, 3).facing, 'west');
  eq(S.rotateProps('oak_stairs', { facing: 'west' }, 4).facing, 'west');
  eq(S.rotateProps('oak_log', { axis: 'x' }, 1).axis, 'z');
  eq(S.rotateProps('oak_log', { axis: 'y' }, 1).axis, 'y');
  eq(S.rotateProps('oak_sign', { rotation: '0' }, 1).rotation, '4');
  eq(S.rotateProps('oak_sign', { rotation: '14' }, 1).rotation, '2');
  eq(S.rotateProps('oak_fence', { north: 'true', east: 'false', south: 'false', west: 'false' }, 1), { east: 'true', south: 'false', west: 'false', north: 'false' });
  eq(S.rotateProps('rail', { shape: 'north_east' }, 1).shape, 'south_east');
  eq(S.rotateProps('rail', { shape: 'ascending_north' }, 1).shape, 'ascending_east');
  eq(S.rotateProps('piston', { facing: 'up' }, 1).facing, 'up');
});
await t('mirror props: facing, hinge, stairs shape, rotation16', () => {
  eq(S.mirrorProps('oak_door', { facing: 'east', hinge: 'left' }, 'x'), { facing: 'west', hinge: 'right' });
  eq(S.mirrorProps('oak_door', { facing: 'north', hinge: 'left' }, 'x').facing, 'north');
  eq(S.mirrorProps('oak_stairs', { facing: 'north', shape: 'inner_left' }, 'z'), { facing: 'south', shape: 'inner_right' });
  eq(S.mirrorProps('oak_sign', { rotation: '4' }, 'x').rotation, '12');
  eq(S.mirrorProps('oak_sign', { rotation: '0' }, 'z').rotation, '8');
});
await t('items and counts', () => {
  eq(S.itemForBlock(mc, 'wall_torch'), 'torch');
  eq(S.itemForBlock(mc, 'oak_wall_sign'), 'oak_sign');
  eq(S.itemForBlock(mc, 'redstone_wire'), 'redstone');
  eq(S.itemForBlock(mc, 'white_wall_banner'), 'white_banner');
  eq(S.itemForBlock(mc, 'skeleton_wall_skull'), 'skeleton_skull');
  eq(S.itemForBlock(mc, 'water'), 'water_bucket');
  eq(S.itemForBlock(mc, 'piston_head'), null);
  eq(S.itemCount('oak_door', { half: 'upper' }), 0);
  eq(S.itemCount('oak_slab', { type: 'double' }), 2);
  eq(S.itemCount('red_bed', { part: 'head' }), 0);
});
await t('state diff ignores derived props', () => {
  eq(S.stateDiff({ name: 'oak_stairs', props: { facing: 'north', half: 'bottom', shape: 'straight' } }, { name: 'oak_stairs', props: { facing: 'north', half: 'bottom', shape: 'outer_left', waterlogged: 'false' } }), null);
  ok(/facing=east/.test(S.stateDiff({ name: 'oak_stairs', props: { facing: 'north' } }, { name: 'oak_stairs', props: { facing: 'east' } })));
  eq(S.stateDiff({ name: 'oak_fence', props: { north: 'true' } }, { name: 'oak_fence', props: { north: 'false' } }), null);
  ok(S.stateDiff({ name: 'oak_planks', props: {} }, { name: 'stone', props: {} }));
});

// ---------- model + transform ----------
await t('worldBlocks rotation/mirror move positions and states together', () => {
  const bp = new M.Blueprint('t');
  bp.set(1, 0, 0, 'oak_stairs[facing=east,half=bottom]');
  bp.set(0, 2, 3, 'oak_log[axis=z]');
  const o = { x: 100, y: 64, z: 200 };
  const r0 = M.worldBlocks(bp, { origin: o });
  eq([r0[0].x, r0[0].y, r0[0].z, r0[0].props.facing], [101, 64, 200, 'east']);
  const r90 = M.worldBlocks(bp, { origin: o, rotation: 90 });
  eq([r90[0].x, r90[0].z, r90[0].props.facing], [100, 201, 'south']); // east -> south when turned clockwise
  eq([r90[1].x, r90[1].z, r90[1].props.axis], [97, 200, 'x']);
  const r180 = M.worldBlocks(bp, { origin: o, rotation: 180 });
  eq([r180[0].x, r180[0].z, r180[0].props.facing], [99, 200, 'west']);
  const mx = M.worldBlocks(bp, { origin: o, mirror: 'x' });
  eq([mx[0].x, mx[0].props.facing], [99, 'west']);
  // the relationship "stair faces toward +x neighbour" must survive any rotation: stair at (1,0,0) facing east = facing away from origin
  for (const rot of [0, 90, 180, 270]) {
    const w = M.worldBlocks(bp, { origin: o, rotation: rot })[0];
    const v = S.DIR_VEC[w.props.facing];
    eq([o.x + v[0], o.z + v[2]].map((n, i) => n + (i ? w.z - o.z : w.x - o.x)), [w.x + v[0], w.z + v[2]]);
    eq([w.x - o.x, w.z - o.z], [v[0], v[2]], `rot ${rot}`);
  }
});
await t('save / load / list / delete', () => {
  const bp = new M.Blueprint('My Hut!', { description: 'test' });
  bp.set(0, 0, 0, 'stone'); bp.set(0, 1, 0, 'oak_stairs[facing=north,half=bottom]');
  M.saveBlueprint(bp);
  eq(bp.name, 'my_hut');
  const l = M.loadBlueprint('my_hut');
  eq(l.get(0, 1, 0), 'oak_stairs[facing=north,half=bottom]');
  ok(M.listBlueprints().some((b) => b.name === 'my_hut' && b.count === 2));
  throws(() => M.loadBlueprint('nope'), /Saved blueprints: my_hut/);
  M.deleteBlueprint('my_hut');
  eq(M.listBlueprints().length, 0);
});

// ---------- DSL ----------
const HOUSE = `
name('cottage');
floor(0,0,6,5,0,'oak_planks');
walls(0,1,0,6,3,5,'cobblestone');
clear(1,1,1,5,3,4);
door(3,1,0,'oak','south');
window(1,2,0,1,2,0); window(5,2,0,5,2,0); window(0,2,2,0,2,3); window(6,2,2,6,2,3);
torch(3,3,1,'south');
roof(0,4,0,6,5,'spruce',{type:'gable',axis:'x'});
slab(2,4,1,'oak','top');
`;
await t('DSL house: walls, door parts, roof stair facings, gable fill', () => {
  const { bp } = D.runBlueprintCode(HOUSE, mc);
  eq(bp.name, 'cottage');
  eq(bp.get(3, 1, 0), 'oak_door[facing=south,half=lower,hinge=left,open=false]');
  eq(bp.get(3, 2, 0), 'oak_door[facing=south,half=upper,hinge=left,open=false]');
  // ridge along x, overhang 1: z -1..6 = 8 wide -> 4 rows each side, no ridge slab
  eq(bp.get(3, 4, -1), 'spruce_stairs[facing=south,half=bottom]', 'north eave');
  eq(bp.get(3, 4, 6), 'spruce_stairs[facing=north,half=bottom]', 'south eave');
  eq(bp.get(3, 7, 2), 'spruce_stairs[facing=south,half=bottom]', 'top north row');
  eq(bp.get(3, 7, 3), 'spruce_stairs[facing=north,half=bottom]', 'top south row');
  eq(bp.get(0, 5, 2), 'spruce_planks', 'gable fill');
  eq(bp.get(-1, 4, 2), undefined, 'gable end overhang is stairs-only at eaves');
  eq(bp.get(2, 4, 1), 'oak_slab[type=top]');
  eq(bp.get(3, 3, 1), 'wall_torch[facing=south]');
  eq(bp.get(2, 2, 2), 'air');
});
await t('DSL hip roof, odd width ridge slab', () => {
  const { bp } = D.runBlueprintCode(`roof(0,0,0,4,4,'oak',{type:'hip',overhang:0})`, mc);
  eq(bp.get(2, 0, 0), 'oak_stairs[facing=south,half=bottom]');
  eq(bp.get(0, 0, 2), 'oak_stairs[facing=east,half=bottom]');
  eq(bp.get(4, 0, 2), 'oak_stairs[facing=west,half=bottom]');
  eq(bp.get(2, 2, 2), 'oak_slab[type=bottom]');
  const { bp: g } = D.runBlueprintCode(`roof(0,0,0,4,4,'oak',{overhang:0,axis:'z'})`, mc);
  eq(g.get(0, 0, 3), 'oak_stairs[facing=east,half=bottom]');
  eq(g.get(2, 2, 1), 'oak_slab[type=bottom]');
});
await t('DSL shapes: cylinder, sphere, dome, pyramid, line, layers, bed', () => {
  const { bp } = D.runBlueprintCode(`cylinder(0,0,0,3,4,'stone',{hollow:true}); `, mc);
  ok(bp.get(3, 0, 0) === 'stone' && !bp.get(0, 0, 0), 'hollow cylinder');
  eq(new Set([...bp.entries()].map((e) => e.y)).size, 4);
  const { bp: s } = D.runBlueprintCode(`sphere(0,0,0,4,'glass')`, mc);
  ok(s.size > 200 && s.size < 400, `sphere size ${s.size}`);
  const { bp: dm } = D.runBlueprintCode(`dome(0,0,0,4,'glass',{hollow:true})`, mc);
  ok([...dm.entries()].every((e) => e.y >= 0));
  const { bp: py } = D.runBlueprintCode(`pyramid(0,0,0,4,4,'sandstone')`, mc);
  eq(py.size, 25 + 9 + 1);
  const { bp: ln } = D.runBlueprintCode(`line(0,0,0,5,5,0,'stone')`, mc);
  eq(ln.size, 6);
  const { bp: ly } = D.runBlueprintCode(`layers(0,0,0,{'#':'cobblestone','.':'air','P':'oak_planks'},[['###','#.#','###'],['P P']])`, mc);
  eq([ly.get(0, 1, 0), ly.get(1, 1, 0), ly.get(2, 1, 0), ly.get(0, 0, 0)], ['oak_planks', undefined, 'oak_planks', 'cobblestone']);
  eq(ly.get(1, 0, 1), 'air');
  const { bp: bd } = D.runBlueprintCode(`bed(0,0,0,'blue','east')`, mc);
  eq(bd.get(1, 0, 0), 'blue_bed[facing=east,part=head]');
});
await t('DSL replace keeps states, mirror + rotate transform states', () => {
  const { bp } = D.runBlueprintCode(`stairs(0,0,0,'oak','north'); replace('oak_stairs','spruce_stairs');`, mc);
  eq(bp.get(0, 0, 0), 'spruce_stairs[facing=north,half=bottom]');
  const { bp: m } = D.runBlueprintCode(`stairs(2,0,0,'oak','east'); door(2,1,0,'oak','east',{hinge:'left'}); mirror('x',0);`, mc);
  eq(m.get(-2, 0, 0), 'oak_stairs[facing=west,half=bottom]');
  eq(m.get(-2, 1, 0), 'oak_door[facing=west,half=lower,hinge=right,open=false]');
  const { bp: r } = D.runBlueprintCode(`stairs(2,0,0,'oak','east'); rotate(1);`, mc);
  eq(r.get(0, 0, 2), 'oak_stairs[facing=south,half=bottom]');
});
await t('DSL safety: timeout, cap, syntax, unknown block, empty', () => {
  throws(() => D.runBlueprintCode('for(;;){}', mc, { timeoutMs: 300 }), /longer than 300 ms/);
  throws(() => D.runBlueprintCode(`fill(0,0,0,40,40,40,'stone')`, mc), /more than 20000/);
  throws(() => D.runBlueprintCode('block(0,0,', mc), /Syntax error/);
  throws(() => D.runBlueprintCode(`block(0,0,0,'oak_plank')`, mc), /Unknown block "oak_plank".*oak_planks/);
  throws(() => D.runBlueprintCode(`log('hi')`, mc), /placed no blocks/);
  throws(() => D.runBlueprintCode(`block(0,0,0,'stone'); process.exit()`, mc), /process is not defined/);
});

// ---------- placement rules vs a mini model of vanilla getStateForPlacement ----------
// Simulates what the server does with (clicked face, player facing, pitch, click y) for the families we care about.
function vanilla(name, o, cur) {
  const face = o.face, look = o.look, hitY = face === 'up' ? 0 : face === 'down' ? 1 : cur.y;
  const half = face !== 'down' && (face === 'up' || !(hitY > 0.5)) ? 'bottom' : 'top';
  if (/_stairs$/.test(name)) return { facing: look, half };
  if (/_slab$/.test(name)) return { type: half };
  if (/_trapdoor$/.test(name)) return ['up', 'down'].includes(face) ? { facing: S.OPP[look], half: face === 'up' ? 'bottom' : 'top' } : { facing: face, half: hitY > 0.5 ? 'top' : 'bottom' };
  if (/_log$/.test(name)) return { axis: ['up', 'down'].includes(face) ? 'y' : ['east', 'west'].includes(face) ? 'x' : 'z' };
  if (name === 'wall_torch') return { facing: face };
  if (/_door$/.test(name)) { const [j, , k] = S.DIR_VEC[look]; return { facing: look, hinge: R.predictDoorHingeByClick(j, k, cur.x, cur.z) }; }
  if (name === 'furnace') return { facing: S.OPP[look] };
  return {};
}
await t('every placement option yields the wanted state (simulated vanilla rules)', () => {
  const cases = [];
  for (const f of S.HORIZ) for (const h of ['top', 'bottom']) cases.push(['oak_stairs', { facing: f, half: h }], ['oak_trapdoor', { facing: f, half: h }]);
  for (const ty of ['top', 'bottom']) cases.push(['oak_slab', { type: ty }]);
  for (const a of ['x', 'y', 'z']) cases.push(['oak_log', { axis: a }]);
  for (const f of S.HORIZ) cases.push(['wall_torch', { facing: f }], ['furnace', { facing: f }]);
  for (const f of S.HORIZ) for (const hg of ['left', 'right']) cases.push(['oak_door', { facing: f, half: 'lower', hinge: hg }]);
  let n = 0;
  for (const [name, want] of cases) {
    const opts = R.placementOptions(name, want);
    ok(opts.length, `${name} has options`);
    for (const o of opts) {
      const got = vanilla(name, o, R.cursorFor(o));
      for (const [k, v] of Object.entries(want)) if (k !== 'half' || !/_door$/.test(name)) eq(got[k], v, `${name} ${JSON.stringify(want)} via ${JSON.stringify(o)} -> ${k}`);
      n++;
    }
  }
  ok(n > 60, `checked ${n} options`);
});
await t('door hinge: neighbours that force it are detected', () => {
  // facing north: ccw = west, cw = east. vanilla: solid on the cw side (i>0) -> RIGHT hinge, on the ccw side -> LEFT
  eq(R.forcedDoorHinge('north', (dx) => dx === 1, () => false), 'right');
  eq(R.forcedDoorHinge('north', (dx) => dx === -1, () => false), 'left');
  eq(R.forcedDoorHinge('north', () => true, () => false), null);
  eq(R.placementOptions('oak_door', { half: 'upper' }).length, 0);
});
await t('sign rotation picks yaw', () => {
  const [o] = R.placementOptions('oak_sign', { rotation: '8' });
  // rotation = round((yaw+180)/22.5) & 15
  eq(Math.round((o.yawDeg + 180) / 22.5) & 15, 8);
});

// ---------- survey ----------
function fakeWorld(fn) { return (x, y, z) => ({ name: fn(x, y, z), boundingBox: 'block' }); }
// ground y=64 everywhere, hill (y up to 70) at x<0, pond at 20..25, tree at 10,10
const world = fakeWorld((x, y, z) => {
  let g = 64;
  if (x < 0) g = 64 + Math.min(6, -x);
  if (x >= 20 && x <= 25 && z >= 0 && z <= 5) { if (y > 61 && y <= 64) return 'water'; g = 61; }
  if (x === 10 && z === 10 && y > 64 && y <= 69) return 'oak_log';
  if (x >= 9 && x <= 11 && z >= 9 && z <= 11 && y >= 68 && y <= 70) return 'oak_leaves';
  return y <= g ? (y === g ? 'grass_block' : 'dirt') : 'air';
});
await t('heightmap + footprint stats', () => {
  const hm = SV.heightmap(world, -4, 0, 8, 4, { refY: 64 });
  eq(hm.cols[0][0].ground, 68);
  eq(hm.cols[0][7].ground, 64);
  const st = SV.footprintStats(hm, 0, 0, 4, 4);
  eq([st.base, st.cut, st.fill, st.flatness], [64, 0, 0, 100]);
  const st2 = SV.footprintStats(hm, -4, 0, 8, 4);
  ok(st2.cut + st2.fill > 0 && st2.flatness < 100);
  const pond = SV.heightmap(world, 20, 0, 2, 2, { refY: 64 });
  eq([pond.cols[0][0].surface, pond.cols[0][0].ground, pond.cols[0][0].liquidDepth], ['water', 61, 3]);
  const tr = SV.heightmap(world, 10, 10, 1, 1, { refY: 64 });
  eq([tr.cols[0][0].ground, tr.cols[0][0].tree], [64, true]);
  const g = SV.asciiGrid(hm, 64);
  ok(g.includes('4321===='), g);
});
await t('find_build_site prefers flat dry treeless ground', () => {
  const { sites } = SV.findBuildSites(world, { cx: 0, cz: 0, refY: 64, w: 6, d: 6, radius: 16 });
  ok(sites.length === 3, 'three sites');
  const b = sites[0];
  ok(b.x >= 0 && b.stats.water === 0 && b.stats.trees === 0 && b.stats.cut === 0, JSON.stringify(b));
  eq(b.y, 65);
});

// ---------- plan ----------
await t('targets, BOM, terrain work, sections, order', () => {
  const { bp } = D.runBlueprintCode(HOUSE, mc);
  const targets = P.targetsFor(bp, { origin: { x: 0, y: 65, z: 0 } });
  const blockAt = (x, y, z) => { const n = world(x, y, z).name; return { name: n, getProperties: () => ({}) }; };
  const by = P.classify(targets, blockAt);
  ok(by.place.length > 100 && !by.conflict.length, `place ${by.place.length} conflict ${by.conflict.length}`);
  const { need } = P.billOfMaterials(targets, mc);
  eq(need.get('oak_door'), 1);
  eq(need.get('torch'), 1);
  eq(need.get('glass_pane'), 6);
  // build it over the hill: lots to clear
  const hill = P.targetsFor(bp, { origin: { x: -6, y: 65, z: 0 } });
  const tw = P.terrainWork(hill, blockAt, { clear: 'bbox' });
  ok(tw.clear.length > 20 && tw.clear[0].y >= tw.clear[tw.clear.length - 1].y, 'clear top-down');
  // over the pond: fill needed? water is replaceable -> floor placed in water, no fill below water... pond bottom at 61, floor at 65 -> fill 64..62? those are water: fill list counts them
  const pond = P.targetsFor(bp, { origin: { x: 20, y: 65, z: 0 } });
  const tw2 = P.terrainWork(pond, blockAt, { fill: true });
  ok(tw2.fill.length > 0, 'fills under the floor over water');
  const secs = P.makeSections(P.boundsOf(targets), 2);
  eq(secs.length, 2);
  eq(secs[0].maxX + 1, secs[1].minX);
  const o = P.buildOrder(targets);
  ok(o.attach.some((t) => t.name === 'oak_door') && !o.structural.some((t) => t.name === 'wall_torch'));
  ok(!o.attach.some((t) => t.props.half === 'upper'), 'door top skipped (auto part)');
  ok(P.topView(targets).includes('legend'));
});

// ---------- jobs / claims ----------
await t('jobs: create, claim sections for two bots, stale takeover', () => {
  const { bp } = D.runBlueprintCode(HOUSE, mc);
  M.saveBlueprint(bp);
  const job = J.createJob({ bp, origin: { x: 600, y: 70, z: 600 }, parts: 2, by: 'A' });
  eq(job.sections.length, 2);
  const a = J.claimSection(job, 'A');
  const b = J.claimSection(job, 'B');
  eq([a.section, b.section], [0, 1]);
  eq(J.claimSection(job, 'A').section, 0, 'A keeps its section');
  const c = J.claimSection(job, 'C');
  eq(c.section, null);
  eq(c.others.map((o) => o.bot), ['A', 'B']);
  const d = J.claimSection(job, 'C', { staleMs: -1 });
  eq([d.section, d.takenOver], [0, 'A']);
  J.writeProgress(job, 0, { ...J.readProgress(job, 0), done: true });
  J.writeProgress(job, 1, { ...J.readProgress(job, 1), done: true });
  eq(J.claimSection(job, 'Z').allDone, true);
  eq(J.loadJob(job.id).id, job.id);
  eq(J.jobBlueprint(job).size, bp.size);
});

// ---------- importers ----------
function varints(arr) { const out = []; for (let v of arr) { do { let b = v & 0x7f; v >>>= 7; if (v) b |= 0x80; out.push(b > 127 ? b - 256 : b); } while (v); } return out; }
await t('import Sponge .schem v2 (gzip)', async () => {
  // 2x2x2: stone floor, oak_stairs facing east + air on top
  const pal = { 'minecraft:air': 0, 'minecraft:stone': 1, 'minecraft:oak_stairs[facing=east,half=bottom,shape=straight,waterlogged=false]': 2 };
  const ids = [1, 1, 1, 1, 2, 0, 0, 200 % 1]; // index x + z*W + y*W*L
  const root = nbt.comp({
    Version: nbt.int(2), DataVersion: nbt.int(3955), Width: nbt.short(2), Height: nbt.short(2), Length: nbt.short(2),
    Palette: nbt.comp(Object.fromEntries(Object.entries(pal).map(([k, v]) => [k, nbt.int(v)]))), PaletteMax: nbt.int(3),
    BlockData: { type: 'byteArray', value: varints(ids) },
  }, 'Schematic');
  const buf = zlib.gzipSync(nbt.writeUncompressed(root));
  const { bp, report } = await I.importBuffer(buf, mc, { filename: 'x.schem', name: 'sch' });
  eq(bp.size, 5, JSON.stringify(report));
  eq(bp.get(0, 1, 0), 'oak_stairs[facing=east,half=bottom,shape=straight,waterlogged=false]');
});
await t('import Sponge .schem v3 + palette > 127 (multi-byte varints)', async () => {
  const names = mc.blocksArray.filter((b) => b.boundingBox === 'block' && !(b.states || []).length).slice(0, 200).map((b) => `minecraft:${b.name}`);
  const pal = Object.fromEntries(names.map((n, i) => [n, nbt.int(i)]));
  const ids = [150, 199, 3];
  const root = nbt.comp({ Schematic: nbt.comp({ Version: nbt.int(3), DataVersion: nbt.int(3955), Width: nbt.short(3), Height: nbt.short(1), Length: nbt.short(1), Blocks: nbt.comp({ Palette: nbt.comp(pal), Data: { type: 'byteArray', value: varints(ids) } }) }) }, '');
  const { bp } = await I.importBuffer(zlib.gzipSync(nbt.writeUncompressed(root)), mc, { filename: 'y.schem' });
  eq([bp.get(0, 0, 0), bp.get(1, 0, 0), bp.get(2, 0, 0)], [names[150], names[199], names[3]].map((n) => n.replace('minecraft:', '')));
});
await t('import structure .nbt', async () => {
  const root = nbt.comp({
    DataVersion: nbt.int(3955), size: nbt.list(nbt.int([2, 2, 1])),
    palette: nbt.list(nbt.comp([{ Name: nbt.string('minecraft:oak_log'), Properties: nbt.comp({ axis: nbt.string('x') }) }, { Name: nbt.string('minecraft:air') }])),
    blocks: nbt.list(nbt.comp([{ pos: nbt.list(nbt.int([5, 3, 0])), state: nbt.int(0) }, { pos: nbt.list(nbt.int([6, 4, 0])), state: nbt.int(1) }])),
  }, '');
  const { bp } = await I.importBuffer(zlib.gzipSync(nbt.writeUncompressed(root)), mc, { filename: 'z.nbt' });
  eq(bp.size, 1);
  eq(bp.get(0, 0, 0), 'oak_log[axis=x]');
});
await t('import .litematic (bit-packed longs spanning words)', async () => {
  // palette of 5 -> 3 bits; 30 cells -> 90 bits -> 2 longs, cell 21 spans the boundary (bits 63..65)
  const pal = ['air', 'stone', 'oak_planks', 'glass', 'oak_log'];
  const W = 5, H = 2, L = 3, vol = W * H * L;
  const ids = Array.from({ length: vol }, (_, i) => (i * 7 + 1) % 5);
  let big = 0n; ids.forEach((v, i) => { big |= BigInt(v) << BigInt(i * 3); });
  const longs = [];
  for (let k = 0; k < Math.ceil((vol * 3) / 64); k++) { const v = (big >> BigInt(64 * k)) & ((1n << 64n) - 1n); longs.push([Number(BigInt.asIntN(32, v >> 32n)), Number(BigInt.asIntN(32, v & 0xffffffffn))]); }
  const root = nbt.comp({
    Version: nbt.int(6), Regions: nbt.comp({ main: nbt.comp({
      Position: nbt.comp({ x: nbt.int(0), y: nbt.int(0), z: nbt.int(0) }), Size: nbt.comp({ x: nbt.int(W), y: nbt.int(H), z: nbt.int(L) }),
      BlockStatePalette: nbt.list(nbt.comp(pal.map((n) => ({ Name: nbt.string(`minecraft:${n}`) })))),
      BlockStates: { type: 'longArray', value: longs },
    }) }),
  }, '');
  const { bp } = await I.importBuffer(zlib.gzipSync(nbt.writeUncompressed(root)), mc, { filename: 'w.litematic' });
  let bad = 0;
  for (let i = 0; i < vol; i++) { const x = i % W, z = Math.floor(i / W) % L, y = Math.floor(i / (W * L)); const want = pal[ids[i]]; const got = bp.get(x, y, z) || 'air'; if (want !== got) bad++; }
  eq(bad, 0, 'all cells decoded');
});

// ---------- executor support logic on a fake world (no server) ----------
const EX = await import('../bridge/engine/blueprint/executor.js');
const { Vec3 } = await import('vec3');
function fakeBot(solidFn) {
  return { blockAt: (p) => { const n = solidFn(p.x, p.y, p.z); return { name: n, position: new Vec3(p.x, p.y, p.z), boundingBox: n === 'air' ? 'empty' : 'block', getProperties: () => ({}) }; } };
}
await t('executor: double slab finds a support; a beam row gets one scaffold chain at its end', () => {
  const world = (x, y, z) => (y < 0 ? 'dirt' : (z === 5 && y <= 3 && x >= 0 && x <= 6 ? 'cobblestone' : 'air'));
  const bot = fakeBot(world);
  const dbl = { x: 2, y: 0, z: 2, name: 'oak_slab', props: { type: 'double' }, key: '2,0,2', air: false };
  ok(EX.placeCandidates(bot, dbl).length > 0, 'double slab attaches to the ground');
  const beams = [];
  for (let x = 0; x <= 6; x++) beams.push({ x, y: 4, z: 5, name: 'oak_log', props: { axis: 'x' }, key: `${x},4,5`, air: false });
  const want = new Map(beams.map((b) => [b.key, b]));
  ok(beams.every((b) => EX.placeCandidates(bot, b).length === 0), 'x-axis beams cannot attach to the wall top (needs an east/west neighbour)');
  eq(EX.scaffoldChain(bot, beams[3], want), null, 'middle beam: both sides are build cells');
  const ch = EX.scaffoldChain(bot, beams[0], want);
  ok(ch && ch.length === 5 && ch[ch.length - 1].x === -1 && ch[ch.length - 1].y === 4, `end beam chain ${JSON.stringify(ch)}`);
  // a bottom stair beside a placed stair attaches to its side with a low click, player facing the stair's facing
  const w2 = (x, y, z) => (x === 0 && y === 5 && z === 0 ? 'spruce_stairs' : 'air');
  const c2 = EX.placeCandidates(fakeBot(w2), { x: 0, y: 5, z: -1, name: 'spruce_stairs', props: { facing: 'south', half: 'bottom' } });
  ok(c2.length === 1 && c2[0].o.face === 'north' && c2[0].o.hitY === 'low' && c2[0].o.look === 'south', JSON.stringify(c2.map((c) => c.o)));
  // a chest as the only neighbour needs sneaking (else the click opens it)
  const w3 = (x, y, z) => (x === 0 && y === 0 && z === 0 ? 'chest' : 'air');
  const c3 = EX.placeCandidates(fakeBot(w3), { x: 0, y: 1, z: 0, name: 'stone', props: {} });
  ok(c3.length === 1 && c3[0].sneak === true, 'sneak');
  // a bottom slab must not be clicked on top of a same-type bottom slab (it would merge into a double)
  const w4 = (x, y, z) => (x === 0 && y === 0 && z === 0 ? 'oak_slab' : 'air');
  const b4 = fakeBot(w4); const blk = b4.blockAt; b4.blockAt = (p) => { const b = blk(p); if (b.name === 'oak_slab') b.getProperties = () => ({ type: 'bottom' }); return b; };
  eq(EX.placeCandidates(b4, { x: 0, y: 1, z: 0, name: 'oak_slab', props: { type: 'bottom' } }).length, 0);
});

console.log(`\n${pass} passed, ${fail} failed`);
fs.rmSync(TMP, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
