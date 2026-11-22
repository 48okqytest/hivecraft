// Build executor: clear the site, fill holes, place blocks layer by layer with the right block states, scaffold where
// nothing to attach to, restock from the base chest, clean up scaffolding, save progress. Respects ctx.signal.
import { builtAt } from '../protect.js';
import { Vec3 } from 'vec3';
import pathfinderPkg from 'mineflayer-pathfinder';
import { isStop, sleep } from '../util.js';
import { gotoGoal, halt, lavaNear, pickupItems } from '../nav.js';
import { DIR_VEC, AIRISH, itemForBlock, isReplaceableName, worldState, stateDiff, isAutoPart, parseState } from './states.js';
import { placementOptions, cursorFor, MF_YAW, mfYawFromNotch, INTERACTIVE, forcedDoorHinge, hasControlledState, isGravity } from './rules.js';
import { targetsFor, targetStatus, terrainWork, buildOrder, inSection, billOfMaterials, PROTECTED } from './plan.js';
import { key3 } from './model.js';
import { jobBlueprint, readProgress, writeProgress, heartbeat } from './jobs.js';
import { bridgeUrl } from '../../config.js';

const { goals } = pathfinderPkg;
export const SCAFFOLD_ITEMS = ['dirt', 'cobblestone', 'cobbled_deepslate', 'netherrack', 'andesite', 'diorite', 'granite', 'tuff', 'stone', 'coarse_dirt', 'blackstone'];
const FILLER_ITEMS = ['dirt', 'cobblestone', 'cobbled_deepslate', 'stone', 'andesite', 'diorite', 'granite', 'tuff', 'coarse_dirt', 'netherrack', 'blackstone', 'sandstone'];
const REACH = 4.3;

class BuildError extends Error {
  constructor(code, msg, extra = {}) { super(msg); this.code = code; Object.assign(this, extra); }
}

const V = (p) => new Vec3(p.x, p.y, p.z);
const clickable = (b) => !!b && !AIRISH.has(b.name) && !isReplaceableName(b.name) && b.boundingBox !== 'empty';
const isFullCube = (b) => !!b && b.boundingBox === 'block' && Array.isArray(b.shapes) && b.shapes.length === 1 && b.shapes[0].join(',') === '0,0,0,1,1,1';

/** custom pathfinder goal: stand where the eye can reach `point`, not inside any of `avoid` cells */
class GoalReach extends goals.Goal {
  constructor(point, reach = REACH, avoid = []) {
    super();
    this.p = point; this.reach = reach;
    this.avoid = new Set(avoid.map((v) => `${v.x},${v.y},${v.z}`));
    this.x = Math.floor(point.x); this.y = Math.floor(point.y); this.z = Math.floor(point.z);
  }
  _d(n) { const dx = n.x + 0.5 - this.p.x, dy = n.y + 1.62 - this.p.y, dz = n.z + 0.5 - this.p.z; return Math.sqrt(dx * dx + dy * dy + dz * dz); }
  heuristic(n) { return Math.max(0, this._d(n) - this.reach + 0.5); }
  isEnd(n) {
    if (this._d(n) > this.reach) return false;
    return !this.avoid.has(`${n.x},${n.y},${n.z}`) && !this.avoid.has(`${n.x},${n.y + 1},${n.z}`);
  }
}

function eyeDist(bot, p) { return bot.entity.position.offset(0, 1.62, 0).distanceTo(p); }
function overlapsBot(bot, cells) {
  const f = bot.entity.position;
  const bx0 = f.x - 0.3, bx1 = f.x + 0.3, bz0 = f.z - 0.3, bz1 = f.z + 0.3, by0 = f.y, by1 = f.y + 1.8;
  return cells.some((c) => bx1 > c.x && bx0 < c.x + 1 && bz1 > c.z && bz0 < c.z + 1 && by1 > c.y && by0 < c.y + 1);
}

function waitBlockUpdate(bot, pos, ms) {
  return new Promise((resolve) => {
    const ev = `blockUpdate:${pos}`;
    const t = setTimeout(() => { bot.removeListener(ev, on); resolve(false); }, ms);
    const on = () => { clearTimeout(t); bot.removeListener(ev, on); resolve(true); };
    bot.on(ev, on);
  });
}

async function moveIntoReach(ctx, T, clickPoint, avoidCells) {
  const { bot } = ctx;
  if (eyeDist(bot, clickPoint) <= REACH && !overlapsBot(bot, avoidCells)) return;
  await gotoGoal(ctx, new GoalReach(clickPoint, REACH - 0.2, avoidCells), { maxMs: 40000, what: `a spot to reach ${T.x},${T.y},${T.z}` });
  halt(ctx.bot);
}

/** dig the block at p (walks into reach). Returns the name dug or null if it was already empty. */
export async function digPos(ctx, p, { allowProtected = false } = {}) {
  const { bot } = ctx;
  const P = V(p);
  let b = bot.blockAt(P);
  if (!b) throw new BuildError('unloaded', `${P} is not loaded`);
  if (AIRISH.has(b.name) || b.name === 'water' || b.name === 'lava') return null;
  if (!allowProtected && PROTECTED.test(b.name)) throw new BuildError('protected', `won't break ${b.name} at ${P.x},${P.y},${P.z} (team block)`);
  if (!b.diggable) throw new BuildError('unbreakable', `${b.name} at ${P.x},${P.y},${P.z} is unbreakable`);
  if (lavaNear(bot, P)) throw new BuildError('lava', `lava next to ${P.x},${P.y},${P.z}`);
  const c = P.offset(0.5, 0.5, 0.5);
  if (eyeDist(bot, c) > REACH) { await gotoGoal(ctx, new GoalReach(c, REACH - 0.2, []), { maxMs: 40000, what: `${b.name} at ${P.x},${P.y},${P.z}` }); halt(bot); }
  b = bot.blockAt(P);
  if (!b || AIRISH.has(b.name)) return null;
  try { await ctx.race(bot.tool.equipForBlock(b, { requireHarvest: false })); } catch (e) { if (isStop(e)) throw e; }
  try { await ctx.race(bot.dig(b, true)); } catch (e) { if (isStop(e)) { try { bot.stopDigging(); } catch { /* */ } } throw e; }
  return b.name;
}

/** would clicking ref (same slab type) with this option merge into a double slab instead of placing at the target? */
function wouldMergeSlab(rb, name, o) {
  if (!/_slab$/.test(name) || rb.name !== name) return false;
  const type = String(worldState(rb).props.type);
  if (type === 'double') return false;
  if (type === 'bottom') return o.face === 'up' || (o.hitY === 'high' && !['up', 'down'].includes(o.face));
  return o.face === 'down' || (o.hitY !== 'high' && !['up', 'down'].includes(o.face));
}

/** options used to find something to attach to (a double slab starts as a bottom slab) */
function attachOptions(t) {
  const props = /_slab$/.test(t.name) && t.props.type === 'double' ? { ...t.props, type: 'bottom' } : t.props;
  return placementOptions(t.name, props);
}

/** candidate (option, reference block) pairs for placing target t right now */
export function placeCandidates(bot, t) {
  const T = V(t);
  const out = [];
  for (const o of attachOptions(t)) {
    if (o.merge) continue;
    const [dx, dy, dz] = DIR_VEC[o.face];
    const R = T.offset(-dx, -dy, -dz);
    const rb = bot.blockAt(R);
    if (!clickable(rb)) continue;
    if (wouldMergeSlab(rb, t.name, o)) continue;
    out.push({ o, R, rb, sneak: INTERACTIVE.test(rb.name) });
  }
  return out.sort((a, b) => Number(a.sneak) - Number(b.sneak));
}

async function clickPlace(ctx, item, rb, o, { sneak = false, cursor } = {}) {
  const { bot } = ctx;
  const cur = cursor || cursorFor(o);
  const cp = rb.position.offset(cur.x, cur.y, cur.z);
  if (!bot.heldItem || bot.heldItem.name !== item.name) await ctx.race(bot.equip(item, 'hand'));
  const eye = bot.entity.position.offset(0, 1.62, 0);
  const d = cp.minus(eye);
  let yaw = Math.atan2(-d.x, -d.z);
  let pitch = Math.atan2(d.y, Math.sqrt(d.x * d.x + d.z * d.z));
  if (o.yawDeg !== undefined) yaw = mfYawFromNotch(o.yawDeg);
  else if (o.look) yaw = MF_YAW[o.look];
  if (o.vlook === 'up') pitch = 1.5; else if (o.vlook === 'down') pitch = -1.5; else if (o.vlook === 'level' || o.look) pitch = Math.max(-0.6, Math.min(0.6, pitch));
  await bot.look(yaw, pitch, true);
  if (sneak) bot.setControlState('sneak', true);
  await sleep(sneak ? 160 : 110, ctx.signal); // let the physics tick send the new rotation (and sneak) to the server
  const dest = rb.position.offset(...DIR_VEC[o.face]);
  const watch = waitBlockUpdate(bot, o.merge ? rb.position : dest, 1500);
  try {
    await bot._genericPlace(rb, new Vec3(...DIR_VEC[o.face]), { delta: new Vec3(cur.x, cur.y, cur.z), forceLook: 'ignore', swingArm: 'right' });
    await ctx.race(watch);
    await sleep(60, ctx.signal);
  } finally { if (sneak) bot.setControlState('sneak', false); }
}

/**
 * Place one target with its block state. Returns 'already' | 'placed' | 'placed_wrong' (+ .why). Throws BuildError
 * codes: no_item, no_support, unplaceable, unloaded, failed, protected.
 */
export async function placeTarget(ctx, t, { inv } = {}) {
  const { bot, mcData } = ctx;
  const T = V(t);
  let wb = bot.blockAt(T);
  if (!wb) throw new BuildError('unloaded', `(${t.x},${t.y},${t.z}) is not loaded`);
  let st = targetStatus(t, wb);
  if (st === 'done') return 'already';
  const isDouble = /_slab$/.test(t.name) && t.props.type === 'double';
  if (st === 'conflict' || (st === 'wrong' && !(isDouble && wb.name === t.name))) {
    await digPos(ctx, T);
    wb = bot.blockAt(T);
  }
  const itemName = itemForBlock(mcData, t.name);
  if (!itemName) throw new BuildError('unplaceable', `${t.name} cannot be placed from an item`);
  const item = bot.inventory.items().find((i) => i.name === itemName);
  if (!item) throw new BuildError('no_item', `no ${itemName}`, { item: itemName });

  if (isDouble) {
    // first half
    if (!(wb && wb.name === t.name)) {
      const half = { ...t, props: { ...t.props, type: 'bottom' } };
      await placeTarget(ctx, half, { inv });
      wb = bot.blockAt(T);
    }
    const it2 = bot.inventory.items().find((i) => i.name === itemName);
    if (!it2) throw new BuildError('no_item', `no ${itemName} for the second slab half`, { item: itemName });
    const ty = String(worldState(wb).props.type);
    const o = { face: ty === 'top' ? 'down' : 'up', merge: true };
    const cursor = { x: 0.5, y: 0.5, z: 0.5 };
    await moveIntoReach(ctx, T, T.offset(0.5, 0.5, 0.5), []);
    await clickPlace(ctx, it2, wb, o, { cursor });
    return targetStatus(t, bot.blockAt(T)) === 'done' ? 'placed' : Object.assign(new String('placed_wrong'), { why: stateDiff(t, worldState(bot.blockAt(T))) });
  }

  const cands = placeCandidates(bot, t);
  if (!cands.length) throw new BuildError('no_support', `nothing to attach ${t.name} to at ${t.x},${t.y},${t.z}`);
  // cells the bot must not stand in: the target (and door top / bed head)
  const avoid = [T];
  if (/_door$/.test(t.name) || /^(tall_grass|large_fern|sunflower|lilac|rose_bush|peony)$/.test(t.name)) avoid.push(T.offset(0, 1, 0));
  if (/_bed$/.test(t.name) && t.props.facing) avoid.push(T.offset(...DIR_VEC[t.props.facing]));
  let lastWhy = '', tries = 0;
  for (const c of cands) {
    if (tries++ >= 3) break;
    await ctx.checkpoint();
    const cur = cursorFor(c.o);
    const cp = c.R.offset(cur.x, cur.y, cur.z);
    await moveIntoReach(ctx, T, cp, avoid);
    const rb = bot.blockAt(c.R);
    if (!clickable(rb)) { lastWhy = 'reference block changed'; continue; }
    const it = bot.inventory.items().find((i) => i.name === itemName);
    if (!it) throw new BuildError('no_item', `no ${itemName}`, { item: itemName });
    if (/_door$/.test(t.name) && t.props.hinge && t.props.facing) {
      const fullAt = (dx, dy, dz) => isFullCube(bot.blockAt(T.offset(dx, dy, dz)));
      const doorLowerAt = (dx, dz) => { const b = bot.blockAt(T.offset(dx, 0, dz)); return b?.name === t.name && String(worldState(b).props.half) === 'lower'; };
      const forced = forcedDoorHinge(t.props.facing, fullAt, doorLowerAt);
      if (forced && forced !== t.props.hinge) lastWhy = `neighbours force hinge=${forced}`;
    }
    try {
      await clickPlace(ctx, it, rb, c.o, { sneak: c.sneak });
    } catch (e) { if (isStop(e)) throw e; lastWhy = e.message; continue; }
    let now = bot.blockAt(T);
    let s = targetStatus(t, now);
    if (s === 'done') return 'placed';
    // open doors / trapdoors / gates: place closed, then toggle
    if (now && now.name === t.name && t.props.open === 'true' && String(worldState(now).props.open) === 'false') {
      try { await ctx.race(bot.activateBlock(now)); await sleep(250, ctx.signal); } catch (e) { if (isStop(e)) throw e; }
      now = bot.blockAt(T); s = targetStatus(t, now);
      if (s === 'done') return 'placed';
    }
    if (now && now.name === t.name) {
      lastWhy = stateDiff(t, worldState(now)) || lastWhy;
      if (!hasControlledState(t.name, t.props) || c === cands[cands.length - 1] || tries >= 3) return Object.assign(new String('placed_wrong'), { why: lastWhy });
      // wrong facing/half: break it and try the next way of placing
      try { await digPos(ctx, T); } catch (e) { if (isStop(e)) throw e; return Object.assign(new String('placed_wrong'), { why: lastWhy }); }
      continue;
    }
    lastWhy = now ? `still ${now.name} after clicking` : 'no answer from server';
  }
  throw new BuildError('failed', `could not place ${t.name} at ${t.x},${t.y},${t.z}: ${lastWhy || 'server refused'}`);
}

// ---------- scaffolding ----------
function scaffoldItem(bot, avoidNames) {
  const items = bot.inventory.items();
  for (const n of SCAFFOLD_ITEMS) { if (avoidNames.has(n)) continue; const it = items.find((i) => i.name === n); if (it) return it; }
  for (const n of SCAFFOLD_ITEMS) { const it = items.find((i) => i.name === n); if (it) return it; }
  return null;
}
/** positions to fill with scaffold (bottom-up) so that t gets something to attach to; null if impossible */
export function scaffoldChain(bot, t, wantMap, maxLen = 10) {
  const T = V(t);
  let best = null;
  for (const o of attachOptions(t)) {
    if (o.merge) continue;
    const [dx, dy, dz] = DIR_VEC[o.face];
    const S = T.offset(-dx, -dy, -dz);
    const sk = key3(S.x, S.y, S.z);
    const want = wantMap.get(sk);
    if (want && !want.air) continue; // that cell is part of the build: it gets built itself
    const sb = bot.blockAt(S);
    if (!sb || !isReplaceableName(sb.name)) continue;
    const hasNeighbour = (P, except) => Object.values(DIR_VEC).some(([a, b, c]) => {
      const Q = P.offset(a, b, c);
      if (except && Q.equals(except)) return false;
      return clickable(bot.blockAt(Q));
    });
    let chain = null;
    if (hasNeighbour(S, T)) chain = [S];
    else {
      for (let k = 1; k <= maxLen; k++) {
        const P = S.offset(0, -k, 0);
        const pb = bot.blockAt(P);
        if (!pb) break;
        if (clickable(pb)) { chain = []; for (let j = k - 1; j >= 0; j--) chain.push(S.offset(0, -j, 0)); break; }
        const w = wantMap.get(key3(P.x, P.y, P.z));
        if (w && !w.air) break;
        if (!isReplaceableName(pb.name)) break;
      }
    }
    if (chain && chain.length <= maxLen && (!best || chain.length < best.length)) best = chain;
  }
  return best;
}

// ---------- chests ----------
export async function openChestAt(ctx, pos) {
  const { bot } = ctx;
  const P = V(pos);
  let b = bot.blockAt(P);
  if (!b || eyeDist(bot, P.offset(0.5, 0.5, 0.5)) > 4) { await gotoGoal(ctx, new GoalReach(P.offset(0.5, 0.5, 0.5), 3.8, []), { maxMs: 90000, what: `chest at ${P.x},${P.y},${P.z}` }); halt(bot); b = bot.blockAt(P); }
  if (!b || !/chest|barrel|shulker_box/.test(b.name)) throw new BuildError('no_chest', `no chest at ${P.x},${P.y},${P.z} (found ${b?.name || 'nothing'})`);
  return ctx.race(bot.openContainer(b));
}
export function containerCounts(win) {
  const m = new Map();
  for (const it of win.containerItems()) m.set(it.name, (m.get(it.name) || 0) + it.count);
  return m;
}
/** withdraw what is needed (Map item->count). Returns {got: Map, chest: Map(after)} */
export async function restockFrom(ctx, pos, need) {
  const { bot } = ctx;
  const win = await openChestAt(ctx, pos);
  const got = new Map();
  try {
    for (const [name, n] of need) {
      let want = n;
      for (const st of win.containerItems().filter((i) => i.name === name)) {
        if (want <= 0) break;
        const free = bot.inventory.emptySlotCount();
        if (free <= 1) break;
        const k = Math.min(want, win.containerCount(st.type), (free - 1) * st.stackSize);
        if (k <= 0) break;
        try { await ctx.race(win.withdraw(st.type, null, k)); got.set(name, (got.get(name) || 0) + k); want -= k; } catch (e) { if (isStop(e)) throw e; break; }
      }
    }
    return { got, chest: containerCounts(win) };
  } finally { try { win.close(); } catch { /* */ } }
}

export async function hubBaseChest() {
  const env = process.env.HIVE_BASE_CHEST; // "x,y,z" override (tests / no hub)
  if (env) { const [x, y, z] = env.split(',').map(Number); if ([x, y, z].every(Number.isFinite)) return { x, y, z, name: 'base_chest' }; }
  const base = bridgeUrl();
  try {
    const r = await fetch(`${base}/waypoints`, { signal: AbortSignal.timeout(3000) });
    const wps = await r.json();
    const list = Array.isArray(wps) ? wps : Object.values(wps || {});
    const wp = list.find((w) => w.name === 'base_chest') || list.find((w) => /chest/i.test(w.name));
    return wp ? { x: Math.floor(wp.x), y: Math.floor(wp.y), z: Math.floor(wp.z), name: wp.name } : null;
  } catch { return null; }
}

// ---------- the build ----------
/**
 * Run (part of) a build section until done or the time budget runs out.
 * opts: { timeBudgetMs, chest:{x,y,z}|null, filler, onProgress }
 */
export async function runSection(ctx, job, sectionId, opts = {}) {
  const { bot, mcData } = ctx;
  const t0 = Date.now();
  const budget = opts.timeBudgetMs ?? 150000;
  const timeUp = () => Date.now() - t0 > budget;
  const bp = jobBlueprint(job);
  const all = targetsFor(bp, { origin: job.origin, rotation: job.rotation, mirror: job.mirror });
  const wantMap = new Map(all.map((t) => [t.key, t]));
  const sec = job.sections.find((s) => s.id === sectionId);
  const mine = all.filter((t) => inSection(sec, t.x, t.z));
  const prog = readProgress(job, sectionId);
  prog.runs = (prog.runs || 0) + 1;
  const scaffold = new Map(prog.scaffold || []); // key -> block name
  const stats = { placed: 0, wrong: [], cleared: 0, filled: 0, scaffoldPlaced: 0, scaffoldRemoved: 0, failed: [], shortages: new Map(), restocks: [], protected: [], notes: new Set() };
  const blockAt = (x, y, z) => bot.blockAt(new Vec3(x, y, z));
  const me = bot.username;
  const ledgerPhase = (phase) => { if (ctx.h) ctx.h.ledgerCtx = phase ? { build: job.id, section: sectionId, phase } : null; }; // block ledger tags (engine/ledger.js)

  // --- guards: the pathfinder must not dig finished build blocks; record blocks it places (pillars) as scaffold
  const mv = bot.pathfinder.movements;
  const guard = (b) => { const w = wantMap.get(key3(b.position.x, b.position.y, b.position.z)); return w && !w.air ? 100 : 0; };
  mv?.exclusionAreasBreak?.push(guard);
  const b0 = job.bounds;
  const onPlaced = (oldB, newB) => {
    if (!newB) return;
    const p = newB.position;
    if (p.x < b0.minX - 3 || p.x > b0.maxX + 3 || p.z < b0.minZ - 3 || p.z > b0.maxZ + 3 || p.y < b0.minY - 3 || p.y > b0.maxY + 3) return;
    const k = key3(p.x, p.y, p.z);
    const w = wantMap.get(k);
    if (w && !w.air && w.name === newB.name) return;
    scaffold.set(k, newB.name);
  };
  bot.on('blockPlaced', onPlaced);
  let lastSave = Date.now();
  const save = (extra = {}) => {
    Object.assign(prog, extra, { scaffold: [...scaffold], by: me });
    writeProgress(job, sectionId, prog);
    heartbeat(job, sectionId, me);
    lastSave = Date.now();
  };
  const maybeSave = () => { if (Date.now() - lastSave > 8000) save(); };
  let restockTried = false;
  const chestPos = opts.chest === undefined ? await hubBaseChest() : opts.chest;

  const doRestock = async (pending) => {
    if (restockTried || !chestPos) return false;
    restockTried = true;
    const { need } = billOfMaterials(pending.map((t) => ({ ...t, status: targetStatus(t, blockAt(t.x, t.y, t.z)) })), mcData);
    const have = new Map(); for (const it of bot.inventory.items()) have.set(it.name, (have.get(it.name) || 0) + it.count);
    const short = new Map();
    for (const [n, c] of need) if (c > (have.get(n) || 0)) short.set(n, c - (have.get(n) || 0));
    if (!scaffoldItem(bot, new Set())) short.set('dirt', 16);
    if (!short.size) return false;
    try {
      const r = await restockFrom(ctx, chestPos, short);
      stats.restocks.push(`${[...r.got].map(([n, c]) => `${n} x${c}`).join(', ') || 'nothing useful'} from ${chestPos.name || 'chest'} ${chestPos.x},${chestPos.y},${chestPos.z}`);
      return r.got.size > 0;
    } catch (e) { if (isStop(e)) throw e; stats.notes.add(`restock failed: ${e.message}`); return false; }
  };

  const placeScaffoldAt = async (P) => {
    const it = scaffoldItem(bot, new Set());
    if (!it) throw new BuildError('no_item', 'no scaffold blocks (dirt/cobblestone)', { item: 'dirt' });
    const s = { x: P.x, y: P.y, z: P.z, name: it.name, props: {}, key: key3(P.x, P.y, P.z), air: false };
    ledgerPhase('scaffold');
    const r = await placeTarget(ctx, s).finally(() => ledgerPhase('place'));
    if (r !== 'already') { scaffold.set(s.key, it.name); stats.scaffoldPlaced++; }
  };

  try {
    // ---------- 1. clear + fill ----------
    const secBounds = { minX: sec.minX, maxX: sec.maxX, minZ: sec.minZ, maxZ: sec.maxZ, minY: b0.minY, maxY: b0.maxY };
    if (!prog.terrainDone) {
      const tw = terrainWork(mine, blockAt, { clear: job.clear, fill: job.fill, bounds: secBounds, isBuilt: builtAt });
      stats.protected = tw.protected;
      let fails = 0;
      ledgerPhase('clear');
      for (const c of tw.clear) {
        if (timeUp()) break;
        await ctx.checkpoint();
        try { if (await digPos(ctx, c)) stats.cleared++; } catch (e) { if (isStop(e)) throw e; if (++fails > 25) { stats.notes.add(`clearing: ${e.message}`); break; } }
        maybeSave();
      }
      ledgerPhase('fill');
      for (const f of tw.fill) {
        if (timeUp()) break;
        await ctx.checkpoint();
        const items = bot.inventory.items();
        const fi = (opts.filler && items.find((i) => i.name === opts.filler)) || FILLER_ITEMS.map((n) => items.find((i) => i.name === n)).find(Boolean);
        if (!fi) { stats.notes.add(`no filler blocks (dirt/cobblestone) for ${tw.fill.length - stats.filled} holes under the floor`); break; }
        try { const r = await placeTarget(ctx, { ...f, name: fi.name, props: {}, key: key3(f.x, f.y, f.z), air: false }); if (r !== 'already') stats.filled++; } catch (e) { if (isStop(e)) throw e; }
        maybeSave();
      }
      if (stats.cleared) { try { await pickupItems(ctx, { center: new Vec3((sec.minX + sec.maxX) / 2, b0.minY, (sec.minZ + sec.maxZ) / 2), radius: 12, maxMs: 6000 }); } catch (e) { if (isStop(e)) throw e; } }
      if (!timeUp()) {
        const again = terrainWork(mine, blockAt, { clear: job.clear, fill: false, bounds: secBounds, isBuilt: builtAt });
        prog.terrainDone = again.clear.length <= again.protected.length + 3;
      }
    }

    // ---------- 2. place: structural layer by layer, then attachments ----------
    const order = buildOrder(mine);
    ledgerPhase('place');
    const failCount = new Map();
    for (const phase of ['structural', 'attach']) {
      let pending = order[phase].filter((t) => targetStatus(t, blockAt(t.x, t.y, t.z)) !== 'done');
      const skipItems = new Set();
      while (pending.length && !timeUp()) {
        await ctx.checkpoint();
        pending = pending.filter((t) => !skipItems.has(itemForBlock(mcData, t.name)));
        if (!pending.length) break;
        const y0 = pending[0].y;
        const layer = pending.filter((t) => t.y === y0);
        const pos = bot.entity.position;
        layer.sort((a, b) => pos.distanceSquared(V(a)) - pos.distanceSquared(V(b)));
        let t = layer.find((c) => placeCandidates(bot, c).length > 0 || targetStatus(c, blockAt(c.x, c.y, c.z)) === 'done');
        let chain = null;
        if (!t) {
          // nothing in this layer can attach: scaffold the nearest one that has room for a scaffold chain
          // (e.g. a row of x-axis beams needs one start block beside its end)
          for (const c of layer) { const ch = scaffoldChain(bot, c, wantMap); if (ch) { t = c; chain = ch; break; } }
          if (!t) t = layer[0];
        }
        try {
          if (chain) for (const P of chain) await placeScaffoldAt(P);
          else if (!placeCandidates(bot, t).length && targetStatus(t, blockAt(t.x, t.y, t.z)) !== 'done') {
            throw new BuildError('no_support', `nothing to attach ${t.name} at ${t.x},${t.y},${t.z} to and no room for scaffolding`);
          }
          const r = await placeTarget(ctx, t);
          if (r === 'placed') stats.placed++;
          else if (String(r) === 'placed_wrong') { stats.placed++; stats.wrong.push(`${t.name} at ${t.x},${t.y},${t.z}: ${r.why}`); }
          pending = pending.filter((p) => p !== t);
        } catch (e) {
          if (isStop(e)) throw e;
          if (e.code === 'no_item') {
            if (await doRestock(pending)) continue;
            skipItems.add(e.item);
            stats.shortages.set(e.item, 0);
            // The missing item may be scaffolding (dirt/cobblestone) that no pending block uses, so
            // skipItems doesn't shrink `pending`: give up on this block instead of retrying it forever.
            if (itemForBlock(mcData, t.name) !== e.item) {
              stats.failed.push(`${t.name} at ${t.x},${t.y},${t.z}: needs ${e.item} for scaffolding (none carried)`);
              prog.failed = { ...(prog.failed || {}), [t.key]: `needs ${e.item} for scaffolding` };
              pending = pending.filter((p) => p !== t);
            }
            continue;
          }
          const n = (failCount.get(t.key) || 0) + 1;
          failCount.set(t.key, n);
          if (n >= 3 || e.code === 'unplaceable' || e.code === 'protected' || e.code === 'unloaded') {
            stats.failed.push(`${t.name} at ${t.x},${t.y},${t.z}: ${e.message}`);
            prog.failed = { ...(prog.failed || {}), [t.key]: e.message.slice(0, 160) };
            pending = pending.filter((p) => p !== t);
          } else {
            // move it to the back of its layer and try others first
            pending = pending.filter((p) => p !== t);
            const idx = pending.findIndex((p) => p.y > t.y);
            pending.splice(idx < 0 ? pending.length : idx, 0, t);
          }
        }
        maybeSave();
      }
      if (timeUp()) break;
    }

    // shortages: count how many of each item are still needed
    if (stats.shortages.size) {
      const remain = mine.filter((t) => !t.air && !isAutoPart(t.name, t.props)).map((t) => ({ ...t, status: targetStatus(t, blockAt(t.x, t.y, t.z)) }));
      const { need } = billOfMaterials(remain, mcData);
      for (const k of stats.shortages.keys()) stats.shortages.set(k, need.get(k) || 0);
    }

    // ---------- 3. remove scaffolding (top-down), only when the section's blocks are all placed ----------
    const remaining = mine.filter((t) => !t.air && !isAutoPart(t.name, t.props) && targetStatus(t, blockAt(t.x, t.y, t.z)) !== 'done' && !prog.failed?.[t.key]);
    if (!remaining.length && !timeUp()) {
      ledgerPhase('unscaffold');
      const list = [...scaffold].map(([k, name]) => { const [x, y, z] = k.split(',').map(Number); return { x, y, z, name, k }; }).sort((a, b) => b.y - a.y);
      for (const s of list) {
        if (timeUp()) break;
        await ctx.checkpoint();
        const w = wantMap.get(s.k);
        const b = blockAt(s.x, s.y, s.z);
        if (!b || b.name !== s.name || (w && !w.air && w.name === b.name)) { scaffold.delete(s.k); continue; }
        try { await digPos(ctx, s); scaffold.delete(s.k); stats.scaffoldRemoved++; } catch (e) { if (isStop(e)) throw e; stats.notes.add(`scaffold at ${s.k}: ${e.message}`); scaffold.delete(s.k); }
      }
    }
    const left = mine.filter((t) => !t.air && !isAutoPart(t.name, t.props) && targetStatus(t, blockAt(t.x, t.y, t.z)) !== 'done');
    const done = !timeUp() && scaffold.size === 0 && left.length === 0;
    prog.placed = (prog.placed || 0) + stats.placed;
    prog.cleared = (prog.cleared || 0) + stats.cleared;
    prog.filled = (prog.filled || 0) + stats.filled;
    prog.remaining = left.length;
    prog.done = done || (left.length > 0 && left.every((t) => prog.failed?.[t.key]) && scaffold.size === 0 && !stats.shortages.size);
    return { stats, left, done: prog.done, timeUp: timeUp(), total: mine.filter((t) => !t.air && !isAutoPart(t.name, t.props)).length, scaffoldLeft: scaffold.size };
  } finally {
    ledgerPhase(null);
    bot.removeListener('blockPlaced', onPlaced);
    if (mv?.exclusionAreasBreak) { const i = mv.exclusionAreasBreak.indexOf(guard); if (i >= 0) mv.exclusionAreasBreak.splice(i, 1); }
    try { save(); } catch { /* disk */ }
    halt(bot);
  }
}

export { BuildError, parseState };
