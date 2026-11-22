// Robustness actions: escape (get out of holes/caves without a pickaxe), hunt (reliable passive-mob kills),
// perception without run_code (look_around, nearest, inventory, blocks_at), use_block / use_item.
// Same def shape as actions.js: { name, description, params, run(ctx,args), quick?, timeoutMs? }.
import { Vec3 } from 'vec3';
import pathfinderPkg from 'mineflayer-pathfinder';
import {
  isStop, sleep, r1, fmtPos, invCounts, invSummary, itemMatcher, resolveBlockNames, dirName, handDiggable,
} from './util.js';
import {
  gotoGoal, halt, isSolid, isLiquidName, isAirName, isReplaceable, lavaNear, digAny, equipBestWeapon, pickupItems,
  chaseMovements, droppedItemName, itemEntities, findPlaceRef,
} from './nav.js';

const { goals } = pathfinderPkg;
const int = (d) => ({ type: 'integer', description: d });
const str = (d, extra = {}) => ({ type: 'string', description: d, ...extra });
const obj = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const H4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];

// ------------------------------------------------------------------ terrain reasoning
const passable = (b) => !!b && !isSolid(b) && b.name !== 'lava' && b.name !== 'fire' && b.name !== 'sweet_berry_bush' && b.name !== 'powder_snow';
const climbable = (b) => !!b && /^(ladder|vine|scaffolding|twisting_vines|weeping_vines|cave_vines)/.test(b.name);
function standableAt(bot, p) {
  const b = bot.blockAt(p), u = bot.blockAt(p.offset(0, 1, 0)), d = bot.blockAt(p.offset(0, -1, 0));
  if (!b || !u || !d) return false;
  if (!passable(b) || !passable(u)) return false;
  return isSolid(d) || climbable(b) || b.name === 'water' || d.name === 'water';
}
export function skyAbove(bot, p, maxUp = 96) {
  for (let y = p.y + 2; y < Math.min(p.y + maxUp, 320); y++) {
    const b = bot.blockAt(new Vec3(p.x, y, p.z));
    if (!b) return true;
    if (isSolid(b) && !/_leaves$/.test(b.name)) return false;
    if (isLiquidName(b.name)) return false;
  }
  return true;
}

/**
 * Flood-fill the cells the bot can WALK to (no digging/placing): step up 1, drop up to 3, swim, ladders.
 * Returns { cells, free (reached >= farDist horizontally), sky (nearest reachable cell with open sky) }.
 */
export function walkableArea(bot, { limit = 600, farDist = 8 } = {}) {
  const start = bot.entity.position.floored();
  let s = start;
  if (!standableAt(bot, s) && standableAt(bot, s.offset(0, 1, 0))) s = s.offset(0, 1, 0);
  const key = (p) => `${p.x},${p.y},${p.z}`;
  const seen = new Set([key(s)]);
  const q = [s];
  let free = false, sky = null, maxH = 0, open = null;
  for (let i = 0; i < q.length && seen.size < limit; i++) {
    const c = q[i];
    const h = Math.hypot(c.x - start.x, c.z - start.z);
    if (h > maxH) maxH = h;
    if (h >= farDist) free = true;
    // "open ground": dry, solid floor, not in a dip (at most 1 solid side at feet level), 2+ blocks from the start
    if (!open && h >= 2 && bot.blockAt(c)?.name !== 'water' && isSolid(bot.blockAt(c.offset(0, -1, 0))) &&
      H4.filter(([dx, dz]) => isSolid(bot.blockAt(c.offset(dx, 0, dz)))).length <= 1 && skyAbove(bot, c, 48)) open = c;
    if (!sky && skyAbove(bot, c, 64)) sky = c;
    const cur = bot.blockAt(c);
    const nexts = [];
    if (climbable(cur) || cur?.name === 'water') nexts.push(c.offset(0, 1, 0));
    for (const [dx, dz] of H4) {
      const n = c.offset(dx, 0, dz);
      nexts.push(n);
      if (passable(bot.blockAt(c.offset(0, 2, 0)))) nexts.push(n.offset(0, 1, 0)); // step/jump up 1
      for (let dy = -1; dy >= -3; dy--) { // drop down
        if (!passable(bot.blockAt(n.offset(0, dy + 1, 0)))) break;
        nexts.push(n.offset(0, dy, 0));
      }
    }
    for (const n of nexts) {
      const k = key(n);
      if (seen.has(k)) continue;
      if (!standableAt(bot, n)) continue;
      seen.add(k); q.push(n);
    }
  }
  return { cells: seen.size, free, sky, open, maxH: r1(maxH), start: s };
}

/** once free: if we are still in a dip / the top of our shaft / water, walk onto nearby open dry ground */
async function stepOut(ctx) {
  const { bot } = ctx;
  const p = bot.entity.position.floored();
  const inDip = H4.filter(([dx, dz]) => isSolid(bot.blockAt(p.offset(dx, 0, dz)))).length >= 2;
  const wet = bot.entity.isInWater || bot.blockAt(p)?.name === 'water';
  if (!inDip && !wet) return null;
  const a = walkableArea(bot, { limit: 600, farDist: 6 });
  if (process.env.HIVE_DEBUG) console.log('[dbg stepOut]', { inDip, wet, open: a.open && fmtPos(a.open), cells: a.cells });
  if (!a.open) return null;
  try {
    await gotoGoal(ctx, new goals.GoalBlock(a.open.x, a.open.y, a.open.z), { maxMs: 20000, what: `open ground at ${fmtPos(a.open)}` });
    return a.open;
  } catch (e) {
    if (isStop(e)) throw e;
    if (process.env.HIVE_DEBUG) console.log('[dbg stepOut] goto failed', e.message);
    if (!wet) return null;
    // pathfinder is bad at leaving water onto a ledge: swim at it holding jump
    await ctx.race(bot.lookAt(a.open.offset(0.5, 1, 0.5), true)).catch(() => {});
    // no sprint: sprint-swimming dives. Pushing into the wall while jumping gives the "climb out of water" boost.
    halt(bot); await sleep(100, ctx.signal);
    if (process.env.HIVE_DEBUG) console.log('[dbg stepOut] swim to', fmtPos(a.open), 'from', fmtPos(bot.entity.position));
    bot.setControlState('forward', true); bot.setControlState('jump', true);
    const landed = () => bot.entity.onGround && !bot.entity.isInWater && bot.entity.position.y >= a.open.y - 0.2; // isInWater flickers while bobbing
    try { for (let i = 0; i < 45 && !landed(); i++) { await bot.look(Math.atan2(-(a.open.x + 0.5 - bot.entity.position.x), -(a.open.z + 0.5 - bot.entity.position.z)), 0, true).catch(() => {}); await sleep(110, ctx.signal); } } finally { bot.clearControlStates(); }
    if (landed()) await gotoGoal(ctx, new goals.GoalBlock(a.open.x, a.open.y, a.open.z), { maxMs: 8000, what: 'open ground' }).catch((e2) => { if (isStop(e2)) throw e2; });
    return landed() ? a.open : null;
  }
}

// blocks we may pillar with (never valuables / containers / stations)
const NO_PILLAR = /_ore$|ancient_debris|^(diamond|emerald|gold|iron|netherite|lapis|redstone|copper|coal)_block$|chest|barrel|shulker|crafting_table|furnace|smoker|anvil|tnt|bed$|beacon|spawner|enchanting|bookshelf|_log$|_wood$|glass|leaves|ice$|obsidian|slime|honey|sponge|_door$|trapdoor|scaffolding/;
const PILLAR_PREF = ['dirt', 'cobblestone', 'cobbled_deepslate', 'netherrack', 'andesite', 'diorite', 'granite', 'tuff', 'stone', 'deepslate', 'gravel', 'sand', 'blackstone', 'calcite', 'moss_block'];
export function pillarItem(bot) {
  const items = bot.inventory.items();
  for (const n of PILLAR_PREF) { const it = items.find((i) => i.name === n); if (it) return it; }
  return items.find((i) => { const b = bot.registry.blocksByName[i.name]; return b && b.boundingBox === 'block' && !NO_PILLAR.test(i.name); }) || null;
}
const hasPickaxe = (bot) => bot.inventory.items().some((i) => /_pickaxe$/.test(i.name));
// can we break this block to escape? bare hands are OK for soft blocks and (slowly) stone; never bedrock/obsidian
function breakable(bot, b) {
  if (!b || !isSolid(b) || !b.diggable) return false;
  if (lavaNear(bot, b.position)) return false;
  if (handDiggable(b) || hasPickaxe(bot)) return b.hardness < 20;
  return b.hardness <= 3.5; // stone 1.5 / deepslate 3: slow by hand, but it works
}
function aboveIsLiquid(bot, p) { for (const dy of [1, 2, 3]) { const b = bot.blockAt(p.offset(0, dy, 0)); if (b && isLiquidName(b.name)) return b; } return null; }

async function swimUp(ctx, maxMs = 8000) {
  const { bot } = ctx;
  const t0 = Date.now();
  // look toward the nearest standable land and swim
  let land = null;
  const f = bot.entity.position.floored();
  for (let r = 1; r <= 8 && !land; r++) for (let dx = -r; dx <= r && !land; dx++) for (let dz = -r; dz <= r && !land; dz++) {
    if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
    for (let dy = 2; dy >= -1; dy--) { const p = f.offset(dx, dy, dz); const d = bot.blockAt(p.offset(0, -1, 0)); if (standableAt(bot, p) && isSolid(d) && bot.blockAt(p)?.name !== 'water') { land = p; break; } }
  }
  try {
    while (Date.now() - t0 < maxMs) {
      ctx.throwIfAborted();
      bot.setControlState('jump', true);
      if (land) { await bot.lookAt(land.offset(0.5, 1, 0.5), true).catch(() => {}); bot.setControlState('forward', true); bot.setControlState('sprint', true); }
      await sleep(250, ctx.signal);
      const now = bot.entity.position.floored();
      if (land && now.distanceTo(land) < 1.5) break;
      if (!bot.entity.isInWater && bot.entity.onGround) break;
    }
  } finally { bot.clearControlStates(); }
  return land;
}

async function openNearbyDoor(ctx) {
  const { bot } = ctx;
  const f = bot.entity.position.floored();
  for (let dx = -2; dx <= 2; dx++) for (let dy = -1; dy <= 2; dy++) for (let dz = -2; dz <= 2; dz++) {
    const b = bot.blockAt(f.offset(dx, dy, dz));
    if (!b || !/(_door|_trapdoor|_fence_gate)$/.test(b.name) || /^iron_/.test(b.name)) continue;
    const props = b.getProperties?.() || {};
    if (props.open === true || props.open === 'true') continue;
    await ctx.race(bot.lookAt(b.position.offset(0.5, 0.5, 0.5), true)).catch(() => {});
    await ctx.race(bot.activateBlock(b)).catch((e) => { if (isStop(e)) throw e; });
    await sleep(300, ctx.signal);
    return b;
  }
  return null;
}

async function pillarStep(ctx, item) {
  const { bot } = ctx;
  // still falling / settling (just teleported, or a block below just broke): wait to land first
  for (let i = 0; i < 20 && !bot.entity.onGround; i++) await sleep(100, ctx.signal);
  const p = bot.entity.position.floored();
  const below = bot.blockAt(p.offset(0, -1, 0));
  if (!isSolid(below)) return false;
  await ctx.race(bot.equip(item, 'hand'));
  await ctx.race(bot.look(bot.entity.yaw, -Math.PI / 2, true));
  bot.setControlState('jump', true);
  const t0 = Date.now();
  while (bot.entity.position.y < p.y + 1.0 && Date.now() - t0 < 1500) await sleep(30, ctx.signal);
  try { await ctx.race(bot.placeBlock(below, new Vec3(0, 1, 0))); } catch (e) { if (isStop(e)) { bot.setControlState('jump', false); throw e; } }
  bot.setControlState('jump', false);
  await sleep(250, ctx.signal);
  return isSolid(bot.blockAt(p));
}

/** one staircase step up in direction (dx,dz): clear (d,+1),(d,+2) and our own +2, then jump onto (d,0). */
async function stairStep(ctx, dx, dz) {
  const { bot } = ctx;
  const p = bot.entity.position.floored();
  const front = bot.blockAt(p.offset(dx, 0, dz));
  for (const off of [[0, 2, 0], [dx, 2, dz], [dx, 1, dz]]) {
    const b = bot.blockAt(p.offset(...off));
    if (b && isSolid(b)) { if (!breakable(bot, b)) return false; await digAny(ctx, b); await sleep(120, ctx.signal); }
  }
  if (!isSolid(front)) {
    // nothing to step onto: a block to place there would help; else just walk forward (it may be a way out)
    const it = pillarItem(bot);
    const ref = it && findPlaceRef(bot, p.offset(dx, 0, dz));
    if (it && ref) { await ctx.race(bot.equip(it, 'hand')); await ctx.race(bot.placeBlock(ref.ref, ref.face)).catch((e) => { if (isStop(e)) throw e; }); }
  }
  await ctx.race(bot.lookAt(p.offset(dx + 0.5, 1.6, dz + 0.5), true)).catch(() => {});
  bot.setControlState('forward', true); bot.setControlState('jump', true);
  try { await sleep(650, ctx.signal); } finally { bot.clearControlStates(); }
  await sleep(150, ctx.signal);
  return bot.entity.position.y >= p.y + 0.9;
}

/**
 * Get out of a hole / cave / box / water. Strategy, cheapest first:
 * swim up -> walk out (flood fill finds open sky) -> open a door -> dig head room + pillar with any block ->
 * staircase up (hand-digs dirt/gravel/sand/leaves; slowly even stone) -> report and suggest asking teammates.
 */
export async function escapeOut(ctx, { untilY, maxMs = 150000, mode = 'escape' } = {}) {
  const { bot } = ctx;
  halt(bot);
  const t0 = Date.now();
  const left = () => maxMs - (Date.now() - t0);
  const startPos = bot.entity.position.clone();
  const log = [];
  const done = () => {
    const p = bot.entity.position.floored();
    if (untilY !== undefined) return p.y >= untilY;
    if (!skyAbove(bot, p)) return false;
    return mode === 'surface' ? true : walkableArea(bot, { limit: 250, farDist: 6 }).free;
  };
  const report = (why) => {
    const p = bot.entity.position;
    const climbed = Math.floor(p.y) - Math.floor(startPos.y);
    return `${why} ${log.length ? `(${log.join(', ')}) ` : ''}Moved ${r1(p.distanceTo(startPos))} blocks${climbed ? `, ${climbed > 0 ? 'up' : 'down'} ${Math.abs(climbed)}` : ''}; now at ${fmtPos(p)}.`;
  };
  const finish = async (msg) => {
    if (untilY === undefined) { const o = await stepOut(ctx); if (o) log.push(`stepped onto open ground at ${fmtPos(o)}`); }
    return report(msg);
  };
  if (bot.entity.isInWater || isLiquidName(bot.blockAt(bot.entity.position.floored().offset(0, 1, 0))?.name)) {
    await swimUp(ctx); log.push('swam up');
  }
  if (done()) return finish(untilY !== undefined ? `Reached y=${untilY}.` : 'You are free: open sky above and room to walk.');
  // 1. walk out if the cave/hole already has an exit to the sky
  const area = walkableArea(bot, { limit: 2500, farDist: 12 });
  if (area.sky && untilY === undefined && area.sky.distanceTo(bot.entity.position) > 1.5) {
    try {
      await gotoGoal(ctx, new goals.GoalBlock(area.sky.x, area.sky.y, area.sky.z), { maxMs: Math.min(60000, left()), what: `the opening to the sky at ${fmtPos(area.sky)}` });
      log.push(`walked to the opening at ${fmtPos(area.sky)}`);
      if (done()) return finish('Walked out to open sky.');
    } catch (e) { if (isStop(e)) throw e; log.push('walking out failed'); }
  }
  // 2. doors / trapdoors / gates
  if (!area.free) {
    const d = await openNearbyDoor(ctx);
    if (d) {
      log.push(`opened ${d.name}`);
      const a2 = walkableArea(bot, { limit: 800, farDist: 8 });
      if (a2.sky) { await gotoGoal(ctx, new goals.GoalBlock(a2.sky.x, a2.sky.y, a2.sky.z), { maxMs: Math.min(40000, left()), what: 'out through the door' }).catch((e) => { if (isStop(e)) throw e; }); if (done()) return finish('Went out through the door.'); }
    }
  }
  // 3. climb: dig head room, pillar with blocks if we have any, otherwise staircase
  let fails = 0, steps = 0, dirIdx = 0, lastY = Math.floor(bot.entity.position.y);
  let pillared = 0, stairs = 0, dug = 0;
  const dirs = H4.slice();
  while (!done() && left() > 2000) {
    ctx.throwIfAborted();
    if (++steps > 400) break;
    // falling / settling (just teleported, a block below broke, mid-jump): wait to land before judging the terrain
    if (!bot.entity.onGround && !bot.entity.isInWater) {
      for (let i = 0; i < 15 && !bot.entity.onGround && !bot.entity.isInWater; i++) await sleep(100, ctx.signal);
      if (!bot.entity.onGround && !bot.entity.isInWater) { fails++; continue; }
    }
    const p = bot.entity.position.floored();
    const liq = aboveIsLiquid(bot, p);
    if (liq && liq.name === 'lava') return report(`Stopped: LAVA above at ${fmtPos(liq.position)}. Move sideways (goto a few blocks away) and call escape again.`);
    if (bot.entity.isInWater) { await swimUp(ctx, 4000); continue; }
    // head room
    let blocked = false;
    for (const dy of [1, 2]) {
      const b = bot.blockAt(p.offset(0, dy, 0));
      if (b && isSolid(b)) {
        if (!breakable(bot, b)) { blocked = true; break; }
        try { await digAny(ctx, b); dug++; } catch (e) { if (isStop(e)) throw e; fails++; }
        await sleep(120, ctx.signal);
      }
    }
    const item = pillarItem(bot);
    if (!blocked && item && !aboveIsLiquid(bot, p) && !isSolid(bot.blockAt(p.offset(0, 1, 0))) && !isSolid(bot.blockAt(p.offset(0, 2, 0)))) {
      if (await pillarStep(ctx, item)) { pillared++; fails = 0; continue; }
      fails++;
    } else {
      // staircase toward the direction with the softest / most open blocks
      const order = dirs.map((d, i) => {
        const a = bot.blockAt(p.offset(d[0], 1, d[1])), b2 = bot.blockAt(p.offset(d[0], 2, d[1]));
        const cost = [a, b2].reduce((s, b) => s + (!b || !isSolid(b) ? 0 : handDiggable(b) ? 1 : breakable(bot, b) ? 4 : 99), 0);
        return { d, cost: cost + (i === dirIdx ? -0.5 : 0) };
      }).sort((x, y) => x.cost - y.cost);
      if (order[0].cost >= 99) { fails += 3; } else {
        dirIdx = dirs.indexOf(order[0].d);
        try { if (await stairStep(ctx, order[0].d[0], order[0].d[1])) { stairs++; fails = 0; } else fails++; } catch (e) { if (isStop(e)) throw e; fails++; }
      }
    }
    const y = Math.floor(bot.entity.position.y);
    if (y > lastY) lastY = y;
    if (fails > 8) break;
  }
  if (pillared) log.push(`pillared ${pillared}`);
  if (stairs) log.push(`dug ${stairs} stair steps`);
  if (dug) log.push(`broke ${dug} blocks overhead`);
  if (done()) return finish(untilY !== undefined ? `Reached y=${untilY}.` : 'Out: open sky above and room to walk.');
  const p = bot.entity.position.floored();
  const why = [];
  if (!hasPickaxe(bot)) why.push('no pickaxe (hand-digging stone is very slow)');
  if (!pillarItem(bot)) why.push('no blocks to pillar with');
  const over = [1, 2].map((dy) => bot.blockAt(p.offset(0, dy, 0))).find((b) => b && isSolid(b) && !breakable(bot, b));
  if (over) why.push(`${over.name} above cannot be broken`);
  const tl = left() <= 2000;
  return report(`${tl ? 'Out of time, still not out' : 'Could not get out yet'}${why.length ? ` (${why.join('; ')})` : ''}. ${tl ? 'Call escape again to keep climbing. ' : ''}Next: craft a wooden_pickaxe if you have logs/planks, collect a few dirt/cobblestone to pillar with, or send_message a teammate: "stuck at ${fmtPos(p)}, need a pickaxe/blocks".`);
}

// ------------------------------------------------------------------ hunting
const PASSIVE_FOOD = { cow: ['wheat'], mooshroom: ['wheat'], sheep: ['wheat'], goat: ['wheat'], pig: ['carrot', 'potato', 'beetroot'], chicken: ['wheat_seeds', 'beetroot_seeds', 'melon_seeds', 'pumpkin_seeds'], rabbit: ['carrot', 'dandelion', 'golden_carrot'], horse: ['wheat', 'apple'], llama: ['hay_block'] };
export const PASSIVE = new Set(['cow', 'pig', 'sheep', 'chicken', 'rabbit', 'mooshroom', 'goat', 'horse', 'donkey', 'mule', 'llama', 'cod', 'salmon', 'turtle', 'squid', 'glow_squid', 'fox', 'cat', 'ocelot', 'parrot', 'frog', 'armadillo', 'camel', 'sniffer']);
const FOOD_ANIMALS = ['cow', 'pig', 'sheep', 'chicken', 'rabbit', 'mooshroom'];

function matchesTarget(e, t) {
  if (!e || !e.position || e.type === 'player' || e.name === 'item') return false;
  if (t === 'animal' || t === 'food' || t === 'any') return FOOD_ANIMALS.includes(e.name);
  return e.name === t || e.name === t.replace(/s$/, '') || e.displayName?.toLowerCase() === t;
}

/** path length in blocks (or null) with the chase profile; budget in ms */
async function pathLen(bot, movements, goal, budget = 1200) {
  try {
    const gen = bot.pathfinder.getPathFromTo(movements, bot.entity.position, goal, { timeout: budget });
    const t0 = Date.now();
    let res = null;
    while (Date.now() - t0 < budget + 500) {
      const { value, done } = gen.next();
      res = value?.result;
      if (done || (res && res.status !== 'partial')) break;
      await new Promise((r) => setImmediate(r));
    }
    if (!res) return null;
    return { ok: res.status === 'success', len: res.path?.length ?? 0, status: res.status };
  } catch { return null; }
}

/** nearest candidates sorted by straight distance, then the first few re-ranked by real path length */
async function pickReachable(ctx, cands, { tries = 4 } = {}) {
  const { bot } = ctx;
  const me = bot.entity.position;
  const sorted = cands.sort((a, b) => a.position.distanceTo(me) - b.position.distanceTo(me));
  const mv = chaseMovements(bot);
  let best = null;
  for (const e of sorted.slice(0, tries)) {
    const d = e.position.distanceTo(me);
    if (d < 3) return { e, len: d, ok: true };
    const pl = await pathLen(bot, mv, new goals.GoalNear(e.position.x, e.position.y, e.position.z, 2), 900);
    if (pl?.ok) { const sc = pl.len + (Math.abs(e.position.y - me.y) > 3 ? 6 : 0); if (!best || sc < best.len) best = { e, len: sc, ok: true }; }
  }
  return best || (sorted[0] ? { e: sorted[0], len: sorted[0].position.distanceTo(me), ok: false } : null);
}

/** chase + hit one mob until dead. Returns 'dead' | 'lost' | 'timeout' | 'low_health' | 'unreachable' */
export async function huntOne(ctx, e, { maxMs = 45000, minHealth = 5, lure = true } = {}) {
  const { bot, h } = ctx;
  const weapon = await equipBestWeapon(ctx).catch(() => null);
  const old = bot.pathfinder.movements;
  bot.pathfinder.setMovements(chaseMovements(bot));
  h.fighting = true;
  const t0 = Date.now();
  let lastHit = 0, bestD = Infinity, lastProgress = Date.now(), lured = false, hits = 0;
  const lureItem = lure ? bot.inventory.items().find((i) => (PASSIVE_FOOD[e.name] || []).includes(i.name)) : null;
  // hits inside the target's 0.5 s invulnerability window do nothing: never swing faster than that
  const cooldown = /_axe$/.test(weapon || '') ? 1000 : 640;
  try {
    bot.pathfinder.setGoal(new goals.GoalFollow(e, 1), true);
    while (true) {
      ctx.throwIfAborted();
      if (!bot.entities[e.id] || e.isValid === false) return { reason: 'dead', hits, pos: e.position.clone() };
      if (bot.health <= minHealth) return { reason: 'low_health', hits };
      if (Date.now() - t0 > maxMs) return { reason: 'timeout', hits };
      const d = e.position.distanceTo(bot.entity.position);
      if (d > 48 || Math.abs(e.position.y - bot.entity.position.y) > 12) return { reason: d > 48 ? 'lost' : 'fell/climbed out of reach', hits };
      if (d < bestD - 0.5) { bestD = d; lastProgress = Date.now(); }
      if (d <= 3.1) {
        lastProgress = Date.now(); bestD = d;
        if (Date.now() - lastHit >= cooldown) {
          await bot.lookAt(e.position.offset(0, (e.height || 0.9) * 0.6, 0), true).catch(() => {});
          try { bot.attack(e); hits++; } catch { /* entity gone */ }
          lastHit = Date.now();
        }
      } else if (!bot.pathfinder.goal) bot.pathfinder.setGoal(new goals.GoalFollow(e, 1), true);
      // no progress for 7 s: lure with its food if we carry some, else give up on this one
      if (Date.now() - lastProgress > 7000) {
        if (lureItem && !lured) {
          lured = true;
          bot.pathfinder.setGoal(null);
          await ctx.race(bot.equip(lureItem, 'hand')).catch(() => {});
          const tl = Date.now();
          while (Date.now() - tl < 8000 && bot.entities[e.id] && e.position.distanceTo(bot.entity.position) > 2.5) { await bot.lookAt(e.position.offset(0, 0.6, 0), true).catch(() => {}); await sleep(250, ctx.signal); }
          await equipBestWeapon(ctx).catch(() => {});
          lastProgress = Date.now(); bestD = Infinity;
          bot.pathfinder.setGoal(new goals.GoalFollow(e, 1), true);
          continue;
        }
        return { reason: 'unreachable', hits };
      }
      await sleep(100, ctx.signal);
    }
  } finally {
    h.fighting = false;
    try { bot.pathfinder.setGoal(null); } catch { /* */ }
    bot.pathfinder.setMovements(old);
    bot.clearControlStates();
  }
}

/** kill `count` mobs of a type, nearest REACHABLE first, picking up the drops. */
export async function huntMany(ctx, target, count = 1, { maxMs = 160000 } = {}) {
  const { bot, h } = ctx;
  const t = String(target).toLowerCase().trim().replace(/\s+/g, '_');
  const dl = ctx.deadline(maxMs);
  const before = invCounts(bot);
  const skip = new Set();
  const tries = new Map(); // a hurt animal that ran off is worth one more chase
  const fails = [];
  let kills = 0, lastDeath = null;
  while (kills < count && !dl.expired()) {
    await ctx.checkpoint();
    const cands = Object.values(bot.entities).filter((e) => matchesTarget(e, t) && !skip.has(e.id) && e.position.distanceTo(bot.entity.position) <= 64);
    if (!cands.length) break;
    const pick = await pickReachable(ctx, cands);
    if (!pick) break;
    const r = await huntOne(ctx, pick.e, { maxMs: Math.min(45000, dl.left()) });
    if (r.reason === 'dead') {
      kills++; lastDeath = r.pos;
      await sleep(400, ctx.signal);
      await pickupItems(ctx, { center: r.pos, radius: 7, maxMs: 4000 }).catch((e) => { if (isStop(e)) throw e; });
    } else if (r.reason === 'low_health') {
      return { kills, stopped: `health ${r1(bot.health)}/20 is low; retreat, eat or heal first`, gained: gainedStr(bot, before), fails };
    } else {
      tries.set(pick.e.id, (tries.get(pick.e.id) || 0) + 1);
      if (tries.get(pick.e.id) >= 2 || r.reason !== 'unreachable' && r.reason !== 'timeout' && !r.hits) skip.add(pick.e.id);
      fails.push(`${pick.e.name} at ${fmtPos(pick.e.position)}: ${r.reason}${r.hits ? ` after ${r.hits} hits` : ''}`);
      if (fails.length >= 5) break;
    }
  }
  return { kills, gained: gainedStr(bot, before), fails, lastDeath, timedOut: dl.expired() };
}
function gainedStr(bot, before) {
  const out = [];
  for (const [n, c] of invCounts(bot)) { const d = c - (before.get(n) || 0); if (d > 0) out.push(`${n} x${d}`); }
  return out.join(', ');
}

// ------------------------------------------------------------------ perception helpers
function describeColumn(bot, p, dx, dz) {
  const f = bot.blockAt(p.offset(dx, 0, dz)), hd = bot.blockAt(p.offset(dx, 1, dz)), fl = bot.blockAt(p.offset(dx, -1, dz));
  if (!f) return 'unloaded';
  if (f.name === 'lava' || hd?.name === 'lava') return 'LAVA';
  if (isLiquidName(f.name)) return 'water';
  if (isSolid(f) && isSolid(hd)) return `wall (${hd.name === f.name ? f.name : `${f.name}/${hd.name}`})`;
  if (isSolid(f) && !isSolid(hd)) return `1-block step up (${f.name})`;
  if (!isSolid(f) && isSolid(hd)) return `low gap (${hd.name} at head height)`;
  if (!isSolid(fl)) {
    let drop = 1;
    for (let dy = -2; dy >= -20; dy--) { const b = bot.blockAt(p.offset(dx, dy, dz)); if (!b || isSolid(b) || isLiquidName(b.name)) break; drop++; }
    return drop >= 3 ? `${drop}-block DROP` : `open, 1-${drop} block down`;
  }
  return `open (floor ${fl.name})`;
}
const CONTAINER = /^(chest|trapped_chest|barrel|ender_chest|furnace|blast_furnace|smoker|crafting_table|.*_bed|.*_door)$/;

export function lookAroundText(ctx, { radius = 24 } = {}) {
  const { bot, h } = ctx;
  const me = bot.entity.position;
  const p = me.floored();
  const lines = [];
  const feet = bot.blockAt(p), below = bot.blockAt(p.offset(0, -1, 0));
  let biome = null; try { biome = feet?.biome?.name; } catch { /* */ }
  const sky = skyAbove(bot, p);
  let roof = null; for (let dy = 2; dy < 40; dy++) { const b = bot.blockAt(p.offset(0, dy, 0)); if (b && isSolid(b) && !/_leaves$/.test(b.name)) { roof = { dy, name: b.name }; break; } }
  const t = bot.time.timeOfDay;
  lines.push(`You: ${fmtPos(me)}${biome ? ` (${biome})` : ''}, ${bot.entity.isInWater ? 'IN WATER' : `standing on ${below?.name}`}; ${bot.time.isDay ? 'day' : 'NIGHT'} (tick ${t})${bot.isRaining ? ', raining' : ''}; light ${feet?.light ?? '?'} (sky light ${feet?.skyLight ?? '?'}); hp ${r1(bot.health)} food ${bot.food}.`);
  lines.push(`Above: ${sky ? 'open sky' : roof ? `${roof.name} ${roof.dy - 1} block${roof.dy > 2 ? 's' : ''} over your head` : 'covered'}. Below you: ${below?.name}${bot.blockAt(p.offset(0, -2, 0)) ? `, then ${bot.blockAt(p.offset(0, -2, 0)).name}` : ''}.`);
  lines.push('Around (feet/head level): ' + [['north', 0, -1], ['east', 1, 0], ['south', 0, 1], ['west', -1, 0]].map(([n, dx, dz]) => `${n}: ${describeColumn(bot, p, dx, dz)}`).join('; ') + '.');
  const area = walkableArea(bot, { limit: 700, farDist: 10 });
  if (!area.free && !sky) lines.push(`⚠ TRAPPED/ENCLOSED: you can only walk to ${area.cells} spots (max ${area.maxH} blocks away) and there is no open sky. Call escape.`);
  else if (!area.free) lines.push(`⚠ Small space: you can only walk ${area.maxH} blocks away without digging/climbing.${area.sky ? '' : ' Call escape to get out.'}`);
  else if (!sky) lines.push(`Underground but you can walk around (${area.cells}+ spots reachable)${area.sky ? `; nearest walkable opening to the sky at ${fmtPos(area.sky)}` : '; no walkable exit to the sky nearby (escape climbs out)'}.`);
  // blocks of interest
  const nb = h.nearbyBlocks(Math.min(radius, 32), 900);
  const groups = { ores: [], trees: [], water: [], danger: [], stations: [] };
  for (const [name, v] of Object.entries(nb)) {
    const d = r1(new Vec3(v.nearest.x, v.nearest.y, v.nearest.z).distanceTo(me));
    const s = `${name} x${v.count} (nearest ${v.nearest.x},${v.nearest.y},${v.nearest.z}, ${d}m ${dirName(v.nearest.x + 0.5 - me.x, v.nearest.z + 0.5 - me.z)})`;
    if (/_ore$|ancient_debris/.test(name)) groups.ores.push(s);
    else if (/_log$/.test(name)) groups.trees.push(s);
    else if (name === 'water') groups.water.push(s);
    else if (name === 'lava') groups.danger.push(`LAVA ${s}`);
    else groups.stations.push(s);
  }
  if (groups.danger.length) lines.push('DANGER: ' + groups.danger.join('; '));
  if (groups.ores.length) lines.push('Ores: ' + groups.ores.join('; '));
  if (groups.trees.length) lines.push('Trees: ' + groups.trees.slice(0, 4).join('; '));
  if (groups.water.length) lines.push('Water: ' + groups.water.join('; '));
  if (groups.stations.length) lines.push('Stations/containers/beds: ' + groups.stations.join('; '));
  // entities
  const ents = h.nearbyEntities(Math.max(radius, 24), 16);
  const mobs = ents.filter((e) => e.type !== 'item').map((e) => `${e.name}${e.type === 'hostile' ? ' (HOSTILE)' : e.type === 'player' ? ' (player)' : ''} ${e.distance}m ${dirName(e.pos.x + 0.5 - me.x, e.pos.z + 0.5 - me.z)} at ${e.pos.x},${e.pos.y},${e.pos.z}`);
  lines.push(mobs.length ? 'Creatures: ' + mobs.join('; ') : 'Creatures: none nearby.');
  const items = ents.filter((e) => e.type === 'item').map((e) => `${e.name} x${e.count} at ${e.pos.x},${e.pos.y},${e.pos.z}`);
  if (items.length) lines.push('Dropped items: ' + items.join('; '));
  const warn = [];
  const hostile = ents.find((e) => e.type === 'hostile' && e.distance < 12);
  if (hostile) warn.push(`${hostile.name} ${hostile.distance}m away`);
  if (bot.health <= 8) warn.push('low health');
  if (bot.food <= 6) warn.push('hungry');
  if (!bot.time.isDay && sky) warn.push('night outside (hostiles spawn)');
  if (warn.length) lines.push('⚠ ' + warn.join('; ') + '.');
  return lines.join('\n');
}

function invText(bot) {
  const slots = bot.inventory.slots;
  const lines = [];
  const items = bot.inventory.items();
  const held = bot.heldItem;
  const dura = (it) => (it.maxDurability ? ` [${it.maxDurability - (it.durabilityUsed || 0)}/${it.maxDurability} uses left]` : '');
  lines.push(`Holding: ${held ? `${held.name} x${held.count}${dura(held)}` : 'nothing'} (hotbar slot ${bot.quickBarSlot}). Off-hand: ${slots[45]?.name || 'empty'}.`);
  lines.push(`Armor: head ${slots[5]?.name || '-'}, chest ${slots[6]?.name || '-'}, legs ${slots[7]?.name || '-'}, feet ${slots[8]?.name || '-'}.`);
  const cnt = invCounts(bot);
  const cat = { tools: [], food: [], blocks: [], other: [] };
  for (const [n, c] of [...cnt].sort((a, b) => b[1] - a[1])) {
    const it = items.find((i) => i.name === n);
    const s = `${n} x${c}${dura(it)}`;
    if (/_(pickaxe|axe|shovel|hoe|sword)$|^(bow|crossbow|shield|shears|fishing_rod|flint_and_steel|bucket|water_bucket|lava_bucket)$|_(helmet|chestplate|leggings|boots)$/.test(n)) cat.tools.push(s);
    else if (bot.registry.foodsByName[n]) cat.food.push(s);
    else if (bot.registry.blocksByName[n]) cat.blocks.push(s);
    else cat.other.push(s);
  }
  if (cat.tools.length) lines.push('Tools/weapons/armor: ' + cat.tools.join(', '));
  if (cat.food.length) lines.push('Food: ' + cat.food.join(', ') + ` (${[...cnt].filter(([n]) => bot.registry.foodsByName[n]).reduce((a, [n, c]) => a + c * (bot.registry.foodsByName[n].foodPoints || 0), 0)} food points)`);
  if (cat.blocks.length) lines.push('Blocks: ' + cat.blocks.join(', '));
  if (cat.other.length) lines.push('Materials/other: ' + cat.other.join(', '));
  if (!items.length) lines.push('Inventory is EMPTY.');
  const free = bot.inventory.emptySlotCount();
  lines.push(`${36 - free}/36 slots used, ${free} free${free === 0 ? ' — FULL: deposit or drop junk before collecting/crafting' : ''}.`);
  return lines.join('\n');
}

// ------------------------------------------------------------------ actions
export const ROBUST_ACTIONS = [
  {
    name: 'escape',
    description: 'GET UNSTUCK: climbs/digs/swims you out of a hole, pit, cave, box or water to open ground — works WITHOUT a pickaxe. Order: swim up, walk out through an existing opening, open a door/trapdoor, break blocks overhead (hand-digs dirt/gravel/sand/leaves; stone slowly by hand), pillar up with ANY block you carry, or dig a staircase up. Use it whenever goto says Stuck/No path/underground, after falling into a hole, or when look_around says TRAPPED. If it cannot finish it says why and what to do next.',
    params: obj({}),
    timeoutMs: 170000,
    async run(ctx) { return escapeOut(ctx, { maxMs: 155000 }); },
  },
  {
    name: 'hunt',
    description: 'Hunt passive animals reliably: picks the nearest one you can actually reach (path check), chases it with sprinting (no digging detours), hits on cooldown, lures it with its favourite food if it gets away (wheat for cow/sheep, carrot/potato for pig, seeds for chicken), then collects the drops. target = cow, pig, sheep, chicken, rabbit, or "food" (any of them). count = kills wanted (default 1). Returns kills, what dropped, and why any got away.',
    params: obj({ target: str('animal type: cow, pig, sheep, chicken, rabbit, mooshroom, or "food" for any food animal'), count: int('how many to kill, default 1') }, ['target']),
    timeoutMs: 175000,
    async run(ctx, { target, count = 1 }) {
      const { bot, h } = ctx;
      const t = String(target).toLowerCase();
      const r = await huntMany(ctx, t, Math.max(1, count), { maxMs: 160000 });
      if (r.kills === 0 && !r.fails.length) {
        const near = h.nearbyEntities(64, 10).filter((x) => x.type === 'animal').map((x) => `${x.name} ${x.distance}m`);
        throw new Error(`No ${target} within 64 blocks of ${fmtPos(bot.entity.position)}. Animals nearby: ${near.join(', ') || 'none'}. Animals live on grass in plains/forests: goto 60-100 blocks in some direction (open grassland) and hunt again.`);
      }
      let msg = `Killed ${r.kills}/${count} ${target}.${r.gained ? ` Picked up: ${r.gained}.` : ' (no drops picked up)'}`;
      if (r.stopped) msg += ` Stopped: ${r.stopped}.`;
      if (r.fails.length) msg += ` Got away / unreachable: ${r.fails.slice(0, 3).join('; ')}.`;
      if (r.kills < count && r.timedOut) msg += ' Ran out of time: call hunt again.';
      else if (r.kills < count && !r.stopped) msg += ' No more reachable ones nearby: move to another grassy area.';
      if (/beef|porkchop|mutton|chicken|rabbit/.test(r.gained || '')) msg += ' Cook raw meat with smelt (e.g. smelt beef) before eating.';
      return msg;
    },
  },
  {
    name: 'look_around',
    description: 'SEE your surroundings as text (no run_code needed): what is north/east/south/west of you at feet/head level (wall, open, drop, water, lava), what is above/below, whether you are TRAPPED or underground and where the way out is, light level, ores/trees/water/lava/chests/beds/stations nearby with coordinates and direction, creatures (hostile flagged) and dropped items, plus danger warnings. Use it when stuck, after arriving somewhere new, before digging, and whenever an action fails and you do not know why.',
    params: obj({ radius: int('search radius for blocks/creatures, default 24, max 32') }),
    quick: true,
    async run(ctx, { radius = 24 } = {}) { return lookAroundText(ctx, { radius: Math.min(Math.max(radius, 8), 32) }); },
  },
  {
    name: 'nearest',
    description: 'Find the nearest thing of a kind WITH the real walking distance (path length) and direction, without moving: a block (oak_log, log, iron_ore, crafting_table, chest, water, bed...), a creature (cow, zombie, "hostile", "animal"), a player name, or a dropped item ("item:raw_iron" or "item" for any). count = how many results (default 3). Tells you if something is close but unreachable (e.g. behind a wall or across water).',
    params: obj({ what: str('block name, mob type, player name, "hostile", "animal", or "item:<name>"'), count: int('results, default 3, max 8'), max_distance: int('search radius, default 64, max 128') }, ['what']),
    quick: true,
    async run(ctx, { what, count = 3, max_distance = 64 }) {
      const { bot, mcData } = ctx;
      const q = String(what).toLowerCase().trim().replace(/\s+/g, '_');
      const n = Math.min(Math.max(count, 1), 8);
      const maxD = Math.min(Math.max(max_distance, 8), 128);
      const me = bot.entity.position;
      const mv = bot.pathfinder.movements;
      let list = [];
      let kind = '';
      const players = Object.keys(bot.players).filter((p) => p !== bot.username);
      const ents = Object.values(bot.entities).filter((e) => e !== bot.entity && e.position && e.position.distanceTo(me) <= maxD);
      if (q.startsWith('item')) {
        const want = q.split(':')[1];
        kind = 'dropped item';
        list = ents.filter((e) => e.name === 'item' && (!want || droppedItemName(bot, e).name === want)).map((e) => ({ name: droppedItemName(bot, e).name, pos: e.position }));
      } else if (players.some((p) => p.toLowerCase() === q)) {
        kind = 'player';
        list = ents.filter((e) => e.type === 'player' && e.username?.toLowerCase() === q).map((e) => ({ name: e.username, pos: e.position }));
        if (!list.length) return `${what} is online but not within ${maxD} blocks / view range.`;
      } else if (q === 'hostile' || q === 'animal' || mcData.entitiesByName[q]) {
        kind = 'creature';
        list = ents.filter((e) => (q === 'hostile' ? e.type === 'hostile' : q === 'animal' ? (e.type === 'animal' || e.type === 'passive') : e.name === q)).map((e) => ({ name: e.name, pos: e.position }));
      } else {
        kind = 'block';
        const names = resolveBlockNames(mcData, q);
        const ids = names.map((nm) => bot.registry.blocksByName[nm].id);
        list = bot.findBlocks({ matching: ids, maxDistance: maxD, count: 40 }).map((p) => ({ name: bot.blockAt(p)?.name, pos: p, block: true }));
      }
      if (!list.length) return `No ${what} (${kind}) within ${maxD} blocks of ${fmtPos(me)}.`;
      list.sort((a, b) => a.pos.distanceTo(me) - b.pos.distanceTo(me));
      const out = [];
      for (const it of list.slice(0, n)) {
        const p = it.pos;
        const straight = r1(it.block ? p.offset(0.5, 0.5, 0.5).distanceTo(me) : p.distanceTo(me));
        let path = '';
        if (straight > 2.5) {
          const goal = it.block ? new goals.GoalNear(p.x, p.y, p.z, 2) : new goals.GoalNear(p.x, p.y, p.z, 1.5);
          const pl = await pathLen(bot, mv, goal, straight > 48 ? 1500 : 900);
          path = !pl ? ', path unknown' : pl.ok ? `, walk ~${pl.len} blocks` : pl.status === 'noPath' ? ', NO walking path (blocked/across water; dig or go around)' : ', far/complex path (more than the quick check)';
        }
        out.push(`${it.name} at ${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)} — ${straight}m ${dirName(p.x - me.x, p.z - me.z)}${Math.abs(p.y - me.y) >= 2 ? `, ${Math.round(Math.abs(p.y - me.y))} ${p.y > me.y ? 'up' : 'down'}` : ''}${path}`);
      }
      return `Nearest ${what} (${list.length} found within ${maxD}):\n${out.join('\n')}`;
    },
  },
  {
    name: 'inventory',
    description: 'Your full inventory with exact counts, grouped (tools with uses left, food with total food points, blocks, materials), what you hold, off-hand, armor, and free slots. Cheap; use it instead of run_code/status when you need exact counts.',
    params: obj({}),
    quick: true,
    async run(ctx) { return invText(ctx.bot); },
  },
  {
    name: 'blocks_at',
    description: 'Read the actual blocks at coordinates without moving: one block (x,y,z) shows it and its 6 neighbours; a box (x,y,z + x2,y2,z2, max 4096 blocks) gives counts per block type and lists the non-air blocks (up to 80) — use it to check a build area, what is under/above something, or whether a spot is clear.',
    params: obj({ x: int('x'), y: int('y'), z: int('z'), x2: int('optional box corner x'), y2: int('optional box corner y'), z2: int('optional box corner z') }, ['x', 'y', 'z']),
    quick: true,
    async run(ctx, { x, y, z, x2, y2, z2 }) {
      const { bot } = ctx;
      const nm = (p) => { const b = bot.blockAt(p); if (!b) return 'unloaded'; const pr = b.getProperties?.() || {}; const keys = Object.keys(pr).filter((k) => ['facing', 'half', 'open', 'age', 'type', 'part', 'axis', 'waterlogged'].includes(k)); return keys.length ? `${b.name}[${keys.map((k) => `${k}=${pr[k]}`).join(',')}]` : b.name; };
      if (x2 === undefined && y2 === undefined && z2 === undefined) {
        const p = new Vec3(x, y, z);
        const nb = [['up', 0, 1, 0], ['down', 0, -1, 0], ['north', 0, 0, -1], ['south', 0, 0, 1], ['east', 1, 0, 0], ['west', -1, 0, 0]].map(([n, dx, dy, dz]) => `${n}: ${nm(p.offset(dx, dy, dz))}`);
        const b = bot.blockAt(p);
        return `${x},${y},${z}: ${nm(p)}${b ? ` (light ${b.light ?? '?'})` : ''}. Neighbours — ${nb.join('; ')}.`;
      }
      const ax = Math.min(x, x2 ?? x), bx = Math.max(x, x2 ?? x), ay = Math.min(y, y2 ?? y), by = Math.max(y, y2 ?? y), az = Math.min(z, z2 ?? z), bz = Math.max(z, z2 ?? z);
      const vol = (bx - ax + 1) * (by - ay + 1) * (bz - az + 1);
      if (vol > 4096) throw new Error(`Box is ${vol} blocks; max 4096. Use a smaller box (e.g. 16x16x16).`);
      const counts = new Map(); const list = [];
      for (let yy = ay; yy <= by; yy++) for (let xx = ax; xx <= bx; xx++) for (let zz = az; zz <= bz; zz++) {
        const p = new Vec3(xx, yy, zz); const b = bot.blockAt(p); const n = b ? b.name : 'unloaded';
        counts.set(n, (counts.get(n) || 0) + 1);
        if (!isAirName(n) && list.length < 80) list.push(`${xx},${yy},${zz} ${nm(p)}`);
      }
      const c = [...counts].sort((a, b) => b[1] - a[1]).map(([n, k]) => `${n} x${k}`).join(', ');
      const nonAir = vol - ['air', 'cave_air', 'void_air'].reduce((a, n) => a + (counts.get(n) || 0), 0);
      return `Box ${ax},${ay},${az} .. ${bx},${by},${bz} (${vol} blocks): ${c}.\n${nonAir ? `Non-air (${nonAir}${nonAir > 80 ? ', first 80' : ''}):\n${list.join('\n')}` : 'All air: the box is clear.'}`;
    },
  },
  {
    name: 'use_block',
    description: 'Right-click (activate) the block at x,y,z: open/close doors, trapdoors and fence gates, flip levers, press buttons, ring bells, etc. Walks into reach first. Reports the new state (e.g. open=true). For chests use chest_view; for beds use sleep; for crafting use craft.',
    params: obj({ x: int('x'), y: int('y'), z: int('z') }, ['x', 'y', 'z']),
    async run(ctx, { x, y, z }) {
      const { bot } = ctx;
      const p = new Vec3(x, y, z);
      let b = bot.blockAt(p);
      if (!b) throw new Error(`${x},${y},${z} is not loaded; goto closer first.`);
      if (isAirName(b.name)) throw new Error(`There is no block at ${x},${y},${z} (air). blocks_at shows what is there.`);
      if (bot.entity.position.offset(0, 1.62, 0).distanceTo(p.offset(0.5, 0.5, 0.5)) > 4.2) await gotoGoal(ctx, new goals.GoalNear(x, y, z, 2.5), { maxMs: 40000, what: `${b.name} at ${x},${y},${z}` });
      b = bot.blockAt(p);
      const before = JSON.stringify(b.getProperties?.() || {});
      await ctx.race(bot.lookAt(p.offset(0.5, 0.5, 0.5), true));
      await ctx.race(bot.activateBlock(b));
      await sleep(350, ctx.signal);
      const after = bot.blockAt(p);
      const props = after.getProperties?.() || {};
      const changed = JSON.stringify(props) !== before;
      const st = Object.entries(props).filter(([k]) => ['open', 'powered', 'facing', 'half', 'lit'].includes(k)).map(([k, v]) => `${k}=${v}`).join(', ');
      return `Used ${after.name} at ${x},${y},${z}${st ? ` (now ${st})` : ''}.${changed ? '' : ' Nothing visibly changed (iron doors need redstone; some blocks do nothing).'}`;
    },
  },
  {
    name: 'use_item',
    description: 'Use (right-click) an item: on a block (x,y,z) — hoe tills dirt/grass into farmland, bone_meal grows crops/saplings, flint_and_steel lights, bucket picks up water/lava, water_bucket places water; on a creature (entity = cow/sheep/pig...) — shears a sheep, milks a cow with a bucket, feeds/breeds animals with wheat/carrots/seeds; or with no target — drinks/throws/uses the item (e.g. a potion, ender pearl, fishing rod, shield).',
    params: obj({ item: str('item name in inventory'), x: int('optional target block x'), y: int('optional target block y'), z: int('optional target block z'), entity: str('optional creature type to use the item on (nearest one)') }, ['item']),
    async run(ctx, { item, x, y, z, entity }) {
      const { bot, mcData } = ctx;
      const m = itemMatcher(mcData, item);
      const it = bot.inventory.items().find((i) => m(i.name));
      if (!it) throw new Error(`You don't have ${item}. Inventory: ${invSummary(bot)}.`);
      const before = invCounts(bot);
      if (entity) {
        const t = String(entity).toLowerCase();
        const e = Object.values(bot.entities).filter((en) => en !== bot.entity && en.position && en.name === t && en.position.distanceTo(bot.entity.position) < 32).sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))[0];
        if (!e) throw new Error(`No ${entity} within 32 blocks.`);
        if (e.position.distanceTo(bot.entity.position) > 3) await gotoGoal(ctx, new goals.GoalFollow(e, 1.5), { maxMs: 30000, what: `${entity}` });
        await ctx.race(bot.equip(it, 'hand'));
        await ctx.race(bot.lookAt(e.position.offset(0, (e.height || 1) * 0.6, 0), true));
        await ctx.race(bot.useOn(e));
        await sleep(600, ctx.signal);
        return `Used ${it.name} on ${entity} at ${fmtPos(e.position)}. ${gainedStr(bot, before) ? `Got ${gainedStr(bot, before)}.` : ''}`;
      }
      await ctx.race(bot.equip(it, 'hand'));
      if (x !== undefined && y !== undefined && z !== undefined) {
        const p = new Vec3(x, y, z);
        const b = bot.blockAt(p);
        if (!b) throw new Error(`${x},${y},${z} is not loaded; goto closer first.`);
        if (bot.entity.position.offset(0, 1.62, 0).distanceTo(p.offset(0.5, 0.5, 0.5)) > 4.2) { await gotoGoal(ctx, new goals.GoalNear(x, y, z, 2.5), { maxMs: 40000, what: `${b.name} at ${x},${y},${z}` }); await ctx.race(bot.equip(it, 'hand')); }
        const was = b.name;
        await ctx.race(bot.lookAt(p.offset(0.5, isLiquidName(b.name) ? 0.2 : 1, 0.5), true));
        if (/bucket$/.test(it.name) || isLiquidName(b.name)) { bot.activateItem(); await sleep(300, ctx.signal); bot.deactivateItem(); }
        else await ctx.race(bot.activateBlock(b, new Vec3(0, 1, 0)));
        await sleep(400, ctx.signal);
        const now = bot.blockAt(p)?.name;
        const above = bot.blockAt(p.offset(0, 1, 0))?.name;
        const g = gainedStr(bot, before);
        return `Used ${it.name} on ${was} at ${x},${y},${z}: block is now ${now}${above && !isAirName(above) ? ` (above: ${above})` : ''}.${g ? ` Got ${g}.` : ''}${now === was && !g ? ' Nothing changed — wrong target? (hoes need dirt/grass with air above; buckets need a source block)' : ''}`;
      }
      bot.activateItem();
      await sleep(/potion|bucket|bow|shield/.test(it.name) ? 1800 : 300, ctx.signal);
      bot.deactivateItem();
      const g = gainedStr(bot, before);
      return `Used ${it.name}.${g ? ` Got ${g}.` : ''}`;
    },
  },
];

export { invText, PASSIVE_FOOD, isReplaceable };
