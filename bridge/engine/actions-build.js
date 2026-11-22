// Build planner + executor actions (blueprints). Exported as BUILD_ACTIONS, same def shape as actions.js.
// Owner: Ursa (Builder). Code lives in ./blueprint/.
import { builtAt } from './protect.js';
import { playerDisplayName } from '../config.js';
import { Vec3 } from 'vec3';
import { isStop } from './util.js';
import { DSL_REFERENCE, runBlueprintCode } from './blueprint/dsl.js';
import { Blueprint, saveBlueprint, loadBlueprint, deleteBlueprint, listBlueprints, key3, MAX_BLOCKS, safeName } from './blueprint/model.js';
import { importFile, listImportFiles, IMPORT_DIR } from './blueprint/importers.js';
import { heightmap, footprintStats, asciiGrid, findBuildSites, cropHm, describeStats } from './blueprint/survey.js';
import { targetsFor, classify, billOfMaterials, materialCheck, terrainWork, boundsOf, estimateSeconds, fmtDuration, topView } from './blueprint/plan.js';
import { createJob, loadJob, listJobs, claimSection, jobSummary, readProgress, writeProgress, releaseClaim, jobIdFor, jobBlueprint } from './blueprint/jobs.js';
import { runSection, hubBaseChest, openChestAt, containerCounts } from './blueprint/executor.js';
import { verifyTargets, formatVerify, verifyOk } from './blueprint/verify.js';
import { worldState, formatState, AIRISH, isAutoPart } from './blueprint/states.js';

const int = (d) => ({ type: 'integer', description: d });
const str = (d, extra = {}) => ({ type: 'string', description: d, ...extra });
const bool = (d) => ({ type: 'boolean', description: d });
const obj = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const PLACE_PARAMS = {
  name: str('blueprint name'),
  x: int('origin x: where the blueprint\'s (0,0,0) goes'), y: int('origin y = first layer, usually ground level + 1'), z: int('origin z'),
  rotation: int('turn the build clockwise around the origin: 0, 90, 180 or 270 (block states rotate too)'),
  mirror: str('optional mirror before rotating', { enum: ['x', 'z'] }),
};

const blockAtFn = (bot) => (x, y, z) => bot.blockAt(new Vec3(x, y, z));
const fmtCounts = (m, n = 14) => [...m].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, c]) => `${k} x${c}`).join(', ') + (m.size > n ? ', …' : '');
const invMap = (bot) => { const m = new Map(); for (const it of bot.inventory.items()) m.set(it.name, (m.get(it.name) || 0) + it.count); return m; };
const place = (a) => ({ origin: { x: a.x, y: a.y, z: a.z }, rotation: a.rotation || 0, mirror: a.mirror || null });
function needOrigin(a, what) {
  if (a.x === undefined || a.y === undefined || a.z === undefined) throw new Error(`${what} needs x, y, z (the build origin). Use find_build_site to pick one, or your position from status.`);
}

function summarizeBlueprint(bp) {
  const b = bp.bounds();
  const counts = bp.counts();
  const air = [...bp.map.values()].filter((s) => AIRISH.has(s)).length;
  const targets = [...bp.entries()].map((e) => ({ ...e, name: e.state.split('[')[0], air: AIRISH.has(e.state) }));
  return `Blueprint "${bp.name}": ${bp.solidCount()} blocks${air ? ` (+${air} must-be-air cells)` : ''}, size ${b.size.x}x${b.size.y}x${b.size.z} (x ${b.min.x}..${b.max.x}, y ${b.min.y}..${b.max.y}, z ${b.min.z}..${b.max.z} relative).\n` +
    `Materials: ${fmtCounts(counts)}.\nTop view:\n${topView(targets)}`;
}

function layerView(bp, y) {
  const b = bp.bounds();
  if (b.size.x > 64 || b.size.z > 64) return `(layer too wide to print: ${b.size.x}x${b.size.z})`;
  const legend = new Map(); const used = new Set();
  const ch = (name) => {
    if (legend.has(name)) return legend.get(name);
    const pool = (name.replace(/^(oak|spruce|birch|jungle|acacia|dark_oak|mangrove|cherry|polished|mossy|cracked|smooth|cut)_/, '') + 'abcdefghijklmnopqrstuvwxyz0123456789').replace(/[^a-z0-9]/g, '');
    let c = [...pool].find((q) => !used.has(q)) || '?';
    used.add(c); legend.set(name, c); return c;
  };
  const rows = [];
  for (let z = b.min.z; z <= b.max.z; z++) {
    let s = '';
    for (let x = b.min.x; x <= b.max.x; x++) { const st = bp.get(x, y, z); s += !st ? '.' : AIRISH.has(st) ? ' ' : ch(st.split('[')[0]); }
    rows.push(s);
  }
  return `Layer y=${y} (north up, x ${b.min.x}..${b.max.x}):\n${rows.join('\n')}\nlegend: ${[...legend].map(([n, c]) => `${c}=${n}`).join(' ')} ('.' nothing, ' ' must be air)`;
}

function loadOrThrow(name) { return loadBlueprint(name); }

// ------------------------------------------------------------------
export const BUILD_ACTIONS = [];
const A = (d) => BUILD_ACTIONS.push(d);

A({
  name: 'site_survey',
  description: 'Look at the ground of a building site: ASCII heightmap (= base level, 1-9 higher, a-i lower (a=-1), ~ water, ! lava, T tree), flatness score, how many blocks to dig (cut) and to fill, trees/water/lava. x,z = north-west corner of the footprint (default: centred on you), width (x) and depth (z) default 12.',
  params: obj({ x: int('footprint min x (optional)'), z: int('footprint min z (optional)'), width: int('size along x, default 12'), depth: int('size along z, default 12'), base: int('optional ground y to measure against (default median)') }),
  async run(ctx, a) {
    const { bot } = ctx;
    const w = Math.min(Math.max(a.width || 12, 1), 64), d = Math.min(Math.max(a.depth || 12, 1), 64);
    const p = bot.entity.position.floored();
    const fx = a.x ?? p.x - Math.floor(w / 2), fz = a.z ?? p.z - Math.floor(d / 2);
    const m = 3;
    const hm = heightmap(blockAtFn(bot), fx - m, fz - m, w + 2 * m, d + 2 * m, { refY: p.y });
    const st = footprintStats(hm, fx, fz, w, d, a.base);
    return `Site x ${fx}..${fx + w - 1}, z ${fz}..${fz + d - 1} (${w}x${d}): ${describeStats(st)}.\n` +
      `Build origin for a floor on this ground: y=${st.base + 1} (ground ${st.base}). ${st.cut + st.fill === 0 ? 'Perfectly flat.' : `blueprint_build clears/fills it automatically (~${fmtDuration(estimateSeconds({ clear: st.cut, fill: st.fill }))}).`}\n` +
      asciiGrid(hm, st.base, { mark: { x: fx, z: fz, w, d } }) + `\n('.' = base level outside the footprint)`;
  },
});

A({
  name: 'find_build_site',
  description: 'Find the best nearby spot for a building footprint (width x depth): least digging/filling, no water/lava, few trees. Returns the top 3 with the origin to pass to blueprint_build (x,z = north-west corner, y = first layer) and an ASCII heightmap of the best one. Searches within radius (default 32) of x,z (default: you).',
  params: obj({ width: int('footprint size along x'), depth: int('footprint size along z'), radius: int('search radius, default 32, max 64'), x: int('search centre x (optional)'), z: int('search centre z (optional)') }, ['width', 'depth']),
  async run(ctx, a) {
    const { bot } = ctx;
    const w = Math.min(Math.max(a.width, 1), 48), d = Math.min(Math.max(a.depth, 1), 48);
    const p = bot.entity.position.floored();
    const radius = Math.min(Math.max(a.radius || 32, 4), 64);
    const avoid = listJobs().map((j) => ({ x: j.bounds.minX, z: j.bounds.minZ, w: j.bounds.maxX - j.bounds.minX + 1, d: j.bounds.maxZ - j.bounds.minZ + 1 }));
    const { sites, hm } = findBuildSites(blockAtFn(bot), { cx: a.x ?? p.x, cz: a.z ?? p.z, refY: p.y, w, d, radius, step: w * d > 400 ? 3 : 2, avoid });
    if (!sites.length) return `No usable ${w}x${d} site within ${radius} blocks (all have lava, are unloaded, or overlap other builds). Try a smaller footprint or another area.`;
    const lines = sites.map((s, i) => `${i + 1}. origin x=${s.x} y=${s.y} z=${s.z} (${Math.round(Math.hypot(s.x + w / 2 - p.x, s.z + d / 2 - p.z))} blocks away): ${describeStats(s.stats)}`);
    const b = sites[0];
    const m = 3;
    const grid = asciiGrid(cropHm(hm, b.x - m, b.z - m, w + 2 * m, d + 2 * m), b.stats.base, { mark: { x: b.x, z: b.z, w, d } });
    return `Best ${w}x${d} build sites near ${a.x ?? p.x},${a.z ?? p.z}:\n${lines.join('\n')}\nSite 1 heightmap (= ground ${b.stats.base}):\n${grid}`;
  },
});

A({
  name: 'blueprint_write',
  description: `Design a building with code and save it as a named blueprint (re-usable: "build another one like that"). ${DSL_REFERENCE}\nExample: hollow(0,0,0,6,4,6,'cobblestone',{ceiling:false}); floor(0,0,6,6,0,'oak_planks'); door(3,1,0,'oak','south'); window(1,2,0,1,3,0); window(5,2,0,5,3,0); torch(3,3,1,'south'); roof(0,5,0,6,6,'spruce',{type:'gable'});\nReturns size, materials and a top view. Then: blueprint_preview (see it on the terrain), blueprint_check (materials), blueprint_build.`,
  params: obj({ name: str('blueprint name (letters, digits, _)'), code: str('JS code using the helpers'), description: str('what it is (optional)'), base: str('optional existing blueprint to start from (edit/extend it)') }, ['name', 'code']),
  async run(ctx, a) {
    const base = a.base ? loadOrThrow(a.base) : null;
    const { bp, logs } = runBlueprintCode(a.code, ctx.mcData, { name: safeName(a.name), description: a.description || '', base, maxBlocks: MAX_BLOCKS });
    bp.name = safeName(a.name);
    if (a.description) bp.description = a.description;
    bp.meta = { ...bp.meta, source: 'code', code: String(a.code).slice(0, 20000), by: ctx.bot.username };
    const dropped = bp.ground();
    saveBlueprint(bp);
    const note = dropped ? `\nNOTE: your lowest blocks were at y=${dropped}, which would float ${dropped} block(s) above the ground. Moved everything down ${dropped} so it sits on the ground (y=0 is the layer resting ON the ground; the origin y from find_build_site is that layer).` : '';
    return `Saved. ${summarizeBlueprint(bp)}${note}${logs.length ? `\nlog: ${logs.join(' | ')}` : ''}\nNEXT: blueprint_preview {name:"${bp.name}", x, y, z} to SEE it standing on the real ground before you build.`;
  },
});

A({
  name: 'blueprint_list',
  description: 'List saved blueprints, build files waiting in the import folder, and build jobs (who is building which section, progress).',
  params: obj({}),
  quick: true,
  async run() {
    const bps = listBlueprints();
    const files = listImportFiles();
    const jobs = listJobs();
    const out = [];
    out.push(bps.length ? `Blueprints (${bps.length}): ${bps.map((b) => `${b.name} ${b.size?.x}x${b.size?.y}x${b.size?.z} ${b.count} blocks${b.description ? ` "${b.description.slice(0, 40)}"` : ''}`).join('; ')}` : 'No saved blueprints yet (blueprint_write / blueprint_import / blueprint_capture).');
    if (files.length) out.push(`Import folder (${IMPORT_DIR}): ${files.join(', ')} (use blueprint_import)`);
    for (const j of jobs.slice(-10)) {
      const s = jobSummary(j);
      out.push(`Build ${j.id}: ${j.blueprint} at ${j.origin.x},${j.origin.y},${j.origin.z} rot ${j.rotation}; sections: ${s.map((q) => `#${q.section} ${q.done ? 'done' : q.bot ? `by ${q.bot}` : 'free'}${q.remaining != null && !q.done ? ` (${q.remaining} left)` : ''}`).join(', ')}`);
    }
    return out.join('\n');
  },
});

A({
  name: 'blueprint_info',
  description: 'Show a saved blueprint: size, materials, top view, and optionally one horizontal layer as ASCII (layer = relative y, 0 = first layer).',
  params: obj({ name: str('blueprint name'), layer: int('optional relative y to print') }, ['name']),
  quick: true,
  async run(ctx, a) {
    const bp = loadOrThrow(a.name);
    let s = summarizeBlueprint(bp);
    if (bp.description) s = `${bp.description}\n${s}`;
    if (a.layer !== undefined) s += `\n${layerView(bp, a.layer)}`;
    return s;
  },
});

A({
  name: 'blueprint_delete',
  description: 'Delete a saved blueprint by name.',
  params: obj({ name: str('blueprint name') }, ['name']),
  quick: true,
  async run(ctx, a) { deleteBlueprint(a.name); return `Deleted blueprint ${a.name}.`; },
});

A({
  name: 'blueprint_import',
  description: `Import a Minecraft build file (Sponge .schem, structure .nbt, Litematica .litematic) from the import folder (${IMPORT_DIR}) as a blueprint. Air is dropped; the build is shifted so its min corner is (0,0,0).`,
  params: obj({ file: str('file name in the import folder'), name: str('blueprint name (default: file name)') }, ['file']),
  async run(ctx, a) {
    const { bp, report } = await importFile(a.file, ctx.mcData, { name: a.name ? safeName(a.name) : undefined });
    bp.name = safeName(a.name || bp.name);
    saveBlueprint(bp);
    return `Imported ${a.file}. ${report.length ? report.join('; ') + '. ' : ''}${summarizeBlueprint(bp)}`;
  },
});

A({
  name: 'blueprint_capture',
  description: 'Save blocks that already exist in the world (between two corners, inclusive) as a blueprint, so the team can "build another one like that". Air is skipped; (x1,y1,z1)-min corner becomes (0,0,0).',
  params: obj({ name: str('blueprint name'), x1: int('corner 1 x'), y1: int('corner 1 y'), z1: int('corner 1 z'), x2: int('corner 2 x'), y2: int('corner 2 y'), z2: int('corner 2 z'), include_terrain: bool('also keep dirt/grass/stone/sand (default false)') }, ['name', 'x1', 'y1', 'z1', 'x2', 'y2', 'z2']),
  async run(ctx, a) {
    const { bot } = ctx;
    const xa = Math.min(a.x1, a.x2), xb = Math.max(a.x1, a.x2), ya = Math.min(a.y1, a.y2), yb = Math.max(a.y1, a.y2), za = Math.min(a.z1, a.z2), zb = Math.max(a.z1, a.z2);
    if ((xb - xa + 1) * (yb - ya + 1) * (zb - za + 1) > 200000) throw new Error('Box too big (max 200k cells).');
    const bp = new Blueprint(safeName(a.name), { meta: { source: 'capture', from: { xa, ya, za, xb, yb, zb }, by: bot.username } });
    const TERRAIN = /^(dirt|grass_block|stone|deepslate|sand|gravel|coarse_dirt|podzol|andesite|diorite|granite|tuff|short_grass|tall_grass|fern|water|lava|snow|.*_leaves)$/;
    let unloaded = 0;
    for (let y = ya; y <= yb; y++) for (let x = xa; x <= xb; x++) for (let z = za; z <= zb; z++) {
      const b = bot.blockAt(new Vec3(x, y, z));
      if (!b) { unloaded++; continue; }
      if (AIRISH.has(b.name)) continue;
      if (!a.include_terrain && TERRAIN.test(b.name)) continue;
      const s = worldState(b);
      bp.set(x - xa, y - ya, z - za, formatState(s.name, s.props));
    }
    if (!bp.size) throw new Error(`No blocks found in that box${unloaded ? ` (${unloaded} cells unloaded: go closer)` : ''}.`);
    saveBlueprint(bp);
    return `Captured. ${unloaded ? `(${unloaded} cells were unloaded and skipped) ` : ''}${summarizeBlueprint(bp)}`;
  },
});

A({
  name: 'blueprint_preview',
  description: 'See a blueprint placed on the real terrain before building: returns a 3D render with ghost blocks (cyan = free, red = terrain in the way, green = already there) plus a text summary of conflicts. Same placement params as blueprint_build. camera optional: {mode:"orbit"|"free"|"map"|"slice"|"auto", yaw, pitch, distance, y}.',
  params: obj({ ...PLACE_PARAMS, camera: { type: 'object', description: 'optional camera settings for the render' } }, ['name', 'x', 'y', 'z']),
  async run(ctx, a) {
    const { bot } = ctx;
    const bp = loadOrThrow(a.name);
    const targets = targetsFor(bp, place(a));
    const by = classify(targets, blockAtFn(bot));
    const b = boundsOf(targets);
    const solid = targets.filter((t) => !t.air);
    const conflicts = [...by.conflict, ...by.wrong];
    const ghosts = [];
    const push = (t, tint, block = t.name, props = t.props) => { if (ghosts.length < 8000) ghosts.push({ x: t.x, y: t.y, z: t.z, block, props, tint }); };
    for (const t of conflicts) t.air ? push(t, 'conflict', t.actual, {}) : push(t, 'conflict');
    for (const t of by.place) if (!t.air) push(t, 'ok');
    for (const t of by.done) if (!t.air) push(t, 'done');
    const what = new Map(); for (const t of conflicts) what.set(t.actual, (what.get(t.actual) || 0) + 1);
    const tw = terrainWork(targets, blockAtFn(bot), { clear: 'bbox', fill: true, bounds: b, isBuilt: builtAt });
    const text = `Preview of ${bp.name} at ${a.x},${a.y},${a.z}${a.rotation ? ` rotated ${a.rotation}` : ''}${a.mirror ? ` mirrored ${a.mirror}` : ''}: ` +
      `${solid.length} blocks — ${by.place.filter((t) => !t.air).length} free, ${by.done.filter((t) => !t.air).length} already there, ${conflicts.length} in conflict${what.size ? ` (${fmtCounts(what, 6)})` : ''}` +
      `${by.unloaded.length ? `, ${by.unloaded.length} unloaded` : ''}. Footprint x ${b.minX}..${b.maxX}, y ${b.minY}..${b.maxY}, z ${b.minZ}..${b.maxZ}. ` +
      `Site work: dig ${tw.clear.length}, fill ${tw.fill.length} holes under the floor${tw.protected.length ? `, ${tw.protected.length} team blocks (chests/beds) in the way that will NOT be broken` : ''}.` +
      `${ghosts.length < solid.length ? ` (render shows ${ghosts.length} of ${solid.length})` : ''}`;
    const view = { ghosts };
    if (a.camera && typeof a.camera === 'object') view.camera = a.camera;
    return { text, view };
  },
});

A({
  name: 'blueprint_check',
  description: 'Plan check before building: bill of materials vs your inventory and the base chest (opens base_chest if it is within 24 blocks or chest=true), what has to be dug and filled, conflicts, and an estimated build time. Same placement params as blueprint_build.',
  params: obj({ ...PLACE_PARAMS, chest: bool('walk to the base chest to count it (default: only if within 24 blocks)') }, ['name', 'x', 'y', 'z']),
  timeoutMs: 120000,
  async run(ctx, a) {
    const { bot, mcData } = ctx;
    const bp = loadOrThrow(a.name);
    const targets = targetsFor(bp, place(a));
    const by = classify(targets, blockAtFn(bot));
    const { need, unplaceable } = billOfMaterials(targets, mcData);
    const inv = invMap(bot);
    let chest = null, chestNote = '';
    const cp = await hubBaseChest();
    if (cp) {
      const dist = bot.entity.position.distanceTo(new Vec3(cp.x, cp.y, cp.z));
      if (a.chest || dist <= 24) {
        try { const win = await openChestAt(ctx, cp); try { chest = containerCounts(win); } finally { try { win.close(); } catch { /* */ } } chestNote = `base chest ${cp.x},${cp.y},${cp.z} counted.`; }
        catch (e) { if (isStop(e)) throw e; chestNote = `base chest not counted: ${e.message}`; }
      } else chestNote = `base chest is ${Math.round(dist)} blocks away (not counted; pass chest=true to walk there).`;
    } else chestNote = 'no base_chest waypoint.';
    const rows = materialCheck(need, inv, chest);
    const missing = rows.filter((r) => r.missing > 0);
    const tw = terrainWork(targets, blockAtFn(bot), { clear: 'bbox', fill: true, isBuilt: builtAt });
    const placeN = [...need.values()].reduce((s, v) => s + v, 0);
    const eta = estimateSeconds({ place: placeN, clear: tw.clear.length, softClear: tw.clear.filter((c) => c.soft).length, fill: tw.fill.length, trips: missing.length ? 1 : 0 });
    const lines = [`Plan for ${bp.name} at ${a.x},${a.y},${a.z}: ${targets.filter((t) => !t.air).length} blocks, ${by.done.filter((t) => !t.air).length} already done.`];
    lines.push(`Materials (need / inventory / chest): ${rows.map((r) => `${r.item} ${r.need}/${r.inv}/${chest ? r.chest : '?'}${r.missing ? ` MISSING ${r.missing}` : ''}`).join(', ') || 'nothing'}.`);
    if (missing.length) lines.push(`Get first: ${missing.map((r) => `${r.missing} ${r.item}`).join(', ')} (craft/collect, or ask teammates to put them in the base chest).`);
    else lines.push('All materials available.');
    if (unplaceable.size) lines.push(`Cannot place from items (skipped): ${fmtCounts(unplaceable)}.`);
    const clearCounts = new Map(); for (const c of tw.clear) clearCounts.set(c.name, (clearCounts.get(c.name) || 0) + 1);
    lines.push(`Site: dig ${tw.clear.length}${tw.clear.length ? ` (${fmtCounts(clearCounts, 6)})` : ''}, fill ${tw.fill.length} holes (needs ${tw.fill.length} dirt/cobblestone).${tw.protected.length ? ` ${tw.protected.length} team blocks in the way (${tw.protected.slice(0, 3).map((p) => `${p.name} ${p.x},${p.y},${p.z}`).join(', ')}) will not be broken: move them or pick another spot.` : ''}`);
    lines.push(`Also carry ~16 dirt/cobblestone for scaffolding. Estimated time: ${fmtDuration(eta)} for one bot${placeN > 150 ? `; split it: blueprint_build parts=2 and a teammate joins with the same build_id` : ''}. ${chestNote}`);
    return lines.join('\n');
  },
});

A({
  name: 'blueprint_build',
  description: 'Build a saved blueprint for real: clears the site, fills holes under the floor, places blocks bottom-up with correct block states (stair facing, slab halves, door hinges, log axis, wall torches), scaffolds where needed and removes the scaffolding, fetches missing materials from base_chest. Works ~150 s per call and SAVES PROGRESS: call it again with the returned build_id until it says done (an interrupt or stop also keeps progress). Split work: start with parts=2 (or more); teammates call blueprint_build with the same build_id and automatically claim a different section. Carry the materials (see blueprint_check) plus dirt/cobblestone for scaffolding.',
  params: obj({
    ...PLACE_PARAMS,
    build_id: str('continue/join an existing build (returned by the first call)'),
    parts: int('split into this many sections for several bots (first call only, default 1)'),
    clear: str('what to dig first: bbox (everything in the way inside the building volume, default), blocks (only cells the blueprint uses), none', { enum: ['bbox', 'blocks', 'none'] }),
    fill: bool('fill holes under the bottom layer with dirt/cobblestone (default true)'),
    section: int('prefer this section number (optional)'),
  }),
  timeoutMs: 178000,
  async run(ctx, a) {
    const { bot } = ctx;
    const me = bot.username;
    let job;
    if (a.build_id) job = loadJob(a.build_id);
    else {
      if (!a.name) throw new Error('Give name + x,y,z for a new build, or build_id to continue one.');
      needOrigin(a, 'blueprint_build');
      const bp = loadOrThrow(a.name);
      const id = jobIdFor(bp.name, { x: a.x, y: a.y, z: a.z }, a.rotation || 0, a.mirror || null);
      try { job = loadJob(id); } catch { job = createJob({ bp, ...place(a), parts: Math.min(Math.max(a.parts || 1, 1), 8), by: me, clear: a.clear || 'bbox', fill: a.fill !== false }); }
    }
    const claim = claimSection(job, me, { prefer: a.section ?? null });
    if (claim.section === null) {
      if (claim.allDone) return `Build ${job.id} is finished (all ${job.sections.length} sections done). Run blueprint_verify build_id=${job.id} to check it.`;
      return `All open sections of ${job.id} are being built by others (${claim.others.map((o) => `#${o.section} ${o.bot}`).join(', ')}). Help by bringing materials to the base chest, or start another build.`;
    }
    const s = claim.section;
    const r = await runSection(ctx, job, s, {});
    const st = r.stats;
    const lines = [];
    lines.push(`Build ${job.id} (${job.blueprint}) section ${s + 1}/${job.sections.length}${claim.takenOver ? ` (taken over from ${claim.takenOver})` : ''}: placed ${st.placed} blocks this run` +
      `${st.cleared ? `, dug ${st.cleared}` : ''}${st.filled ? `, filled ${st.filled}` : ''}${st.scaffoldPlaced || st.scaffoldRemoved ? `, scaffold +${st.scaffoldPlaced}/-${st.scaffoldRemoved}` : ''}. ` +
      `${r.total - r.left.length}/${r.total} blocks of this section done.`);
    if (st.restocks.length) lines.push(`Restocked: ${st.restocks.join('; ')}.`);
    if (st.shortages.size) lines.push(`OUT OF MATERIALS: ${[...st.shortages].map(([n, c]) => `${n} (need ${c} more)`).join(', ')}. Get them (craft/collect/base chest), then call blueprint_build build_id=${job.id} again.`);
    if (st.wrong.length) lines.push(`Placed but state differs (${st.wrong.length}): ${st.wrong.slice(0, 5).join('; ')}.`);
    if (st.failed.length) lines.push(`Failed (${st.failed.length}): ${st.failed.slice(0, 6).join('; ')}.`);
    if (st.protected.length) lines.push(`Left alone (team blocks in the way): ${st.protected.slice(0, 4).map((p) => `${p.name} ${p.x},${p.y},${p.z}`).join(', ')}.`);
    if (st.notes.size) lines.push(`Notes: ${[...st.notes].slice(0, 4).join('; ')}.`);
    if (r.done) {
      const all = jobSummary(job);
      const openS = all.filter((q) => !q.done);
      if (openS.length) lines.push(`Section ${s + 1} DONE. Still open: ${openS.map((q) => `#${q.section + 1}${q.bot && q.bot !== me ? ` (${q.bot})` : ''}`).join(', ')} — call blueprint_build build_id=${job.id} to take the next free one.`);
      else {
        const v = verifyTargets(bot, targetsFor(jobBlueprint(job), { origin: job.origin, rotation: job.rotation, mirror: job.mirror }));
        lines.push(`BUILD COMPLETE. Verify: ${formatVerify(v, { limit: 6 })}${verifyOk(v) ? '' : ` Fix with blueprint_verify build_id=${job.id} fix=true.`}`);
      }
    } else if (r.timeUp) lines.push(`Time slice used up; progress saved. Call blueprint_build build_id=${job.id} again to continue.`);
    else if (!st.shortages.size) lines.push(`${r.left.length} blocks left${r.scaffoldLeft ? `, ${r.scaffoldLeft} scaffold blocks to remove` : ''}. Call blueprint_build build_id=${job.id} again (or blueprint_verify fix=true).`);

    // Always SHOW the build: agents rarely ask for a picture on their own.
    const b = job.bounds;
    const center = { x: Math.round((b.minX + b.maxX) / 2), y: Math.round((b.minY + b.maxY) / 2), z: Math.round((b.minZ + b.maxZ) / 2) };
    const span = Math.max(b.maxX - b.minX, b.maxY - b.minY, b.maxZ - b.minZ) + 1;
    const camera = { mode: 'orbit', target: { x: center.x + 0.5, y: center.y + 0.5, z: center.z + 0.5 }, distance: Math.round(span * 1.7 + 6), elevation: 32, angle: 35 };
    const radius = Math.min(48, Math.ceil(span / 2) + 8);
    const complete = r.done && !jobSummary(job).some((q) => !q.done);
    if (complete) {
      lines.push(`Here is the finished build (photo sent to ${playerDisplayName()}). Look at it: if something is off, fix it with blueprint_verify fix=true or mine_block/place.`);
      return { text: lines.join('\n'), view: { center, radius, camera, caption: `${job.blueprint} finished` }, share: { to: playerDisplayName(), note: `Finished ${job.blueprint} at ${job.origin.x},${job.origin.y},${job.origin.z}` } };
    }
    // progress shot: ghost blocks = still to place (cyan), placed ones show as real blocks, red = in the way
    const ghosts = targetsFor(jobBlueprint(job), { origin: job.origin, rotation: job.rotation, mirror: job.mirror })
      .filter((t) => !t.air).slice(0, 8000).map((t) => ({ x: t.x, y: t.y, z: t.z, block: t.name, props: t.props }));
    lines.push('Picture: the build so far (ghost = still to place, red = in the way). Check it looks right on the ground before continuing.');
    return { text: lines.join('\n'), view: { center, radius, camera, ghosts, caption: `${job.blueprint} in progress` } };
  },
});

A({
  name: 'blueprint_verify',
  description: 'Compare the world with a blueprint: lists missing blocks, wrong blocks, wrong states (facing/half/hinge) and blocks in the way, with coordinates. fix=true then repairs them (digs wrong ones, places missing ones; ~150 s per call). Give build_id, or name + x,y,z (+rotation/mirror).',
  params: obj({ build_id: str('build job id'), ...PLACE_PARAMS, fix: bool('repair what is wrong (default false)') }),
  timeoutMs: 178000,
  async run(ctx, a) {
    const { bot } = ctx;
    let job = null, targets;
    if (a.build_id) { job = loadJob(a.build_id); targets = targetsFor(jobBlueprint(job), { origin: job.origin, rotation: job.rotation, mirror: job.mirror }); }
    else { if (!a.name) throw new Error('Give build_id, or name + x,y,z.'); needOrigin(a, 'blueprint_verify'); targets = targetsFor(loadOrThrow(a.name), place(a)); }
    const v = verifyTargets(bot, targets);
    let out = `Verify ${job ? job.id : a.name}: ${formatVerify(v)}`;
    if (!a.fix || verifyOk(v)) return out + (verifyOk(v) ? '\nAll good.' : '\nRun again with fix=true to repair.');
    if (!job) {
      const bp = loadOrThrow(a.name);
      const id = jobIdFor(bp.name, { x: a.x, y: a.y, z: a.z }, a.rotation || 0, a.mirror || null);
      try { job = loadJob(id); } catch { job = createJob({ bp, ...place(a), parts: 1, by: bot.username, clear: 'blocks', fill: false }); }
    }
    const t0 = Date.now();
    let placed = 0; const msgs = [];
    for (const sec of job.sections) {
      const left = 150000 - (Date.now() - t0);
      if (left < 15000) break;
      const p = readProgress(job, sec.id);
      writeProgress(job, sec.id, { ...p, done: false, terrainDone: false, failed: {} });
      const r = await runSection(ctx, job, sec.id, { timeBudgetMs: left });
      placed += r.stats.placed;
      if (r.stats.failed.length) msgs.push(...r.stats.failed.slice(0, 3));
      if (r.stats.shortages.size) msgs.push(`out of ${[...r.stats.shortages.keys()].join(', ')}`);
    }
    const v2 = verifyTargets(bot, targets);
    out += `\nFix pass placed ${placed}.${msgs.length ? ` Problems: ${msgs.slice(0, 5).join('; ')}.` : ''}\nAfter fix: ${formatVerify(v2)}`;
    return out;
  },
});

export const BUILD_TOOL_NAMES = BUILD_ACTIONS.map((d) => d.name);
