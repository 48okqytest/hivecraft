// Navigation, digging, placing, picking up, fighting helpers. All take an action ctx (see handle.js).
import { Vec3 } from 'vec3';
import pathfinderPkg from 'mineflayer-pathfinder';
import { patchMovements } from './doors.js';
import { StopError, isStop, sleep, fmtPos, r1, dirName, handDiggable, placedBlockNames, SEED_ITEMS, SAPLING_SOIL } from './util.js';

const { goals, Movements } = pathfinderPkg;

export const HOSTILE_IGNORE = new Set(['enderman', 'zombified_piglin', 'piglin', 'piglin_brute', 'iron_golem', 'wolf', 'bee',
  'llama', 'polar_bear', 'panda', 'dolphin', 'goat', 'snow_golem', 'villager', 'warden']);

export function halt(bot) {
  try { bot.pathfinder.setGoal(null); } catch { /* ignore */ }
  try { bot.stopDigging(); } catch { /* ignore */ }
  try { bot.pvp.stop(); } catch { /* ignore */ }
  try { bot.clearControlStates(); } catch { /* ignore */ }
}

// ---------- pathfinding ----------
export async function gotoGoal(ctx, goal, { maxMs = 120000, what = 'target' } = {}) {
  const { bot, h } = ctx;
  const t0 = Date.now();
  let stuckCount = 0, interrupts = 0, lastErr = null, swamOut = false;
  while (true) {
    ctx.throwIfAborted();
    await ctx.checkpoint();
    if (Date.now() - t0 > maxMs) {
      halt(bot);
      const e = new Error(`Timed out after ${Math.round((Date.now() - t0) / 1000)}s walking to ${what} (now at ${fmtPos(bot.entity.position)}). ${diagnose(bot, goalPos(goal))}`);
      e.walkTimeout = true;
      throw e;
    }
    const wd = { stuck: false };
    const p = bot.pathfinder.goto(goal);
    p.catch(() => {});
    let lastPos = bot.entity.position.clone();
    let lastMove = Date.now();
    const iv = setInterval(() => {
      const pos = bot.entity.position;
      if (pos.distanceTo(lastPos) > 0.7 || bot.pathfinder.isMining() || bot.pathfinder.isBuilding()) {
        lastPos = pos.clone(); lastMove = Date.now();
      } else if (Date.now() - lastMove > 8000 && h.modes.unstuck && !wd.stuck && bot.pathfinder.isMoving()) {
        if (process.env.HIVE_DEBUG) console.log('[dbg] stuck at', fmtPos(pos), 'below', bot.blockAt(pos.offset(0, -1, 0))?.name, 'feet', bot.blockAt(pos.floored())?.name, 'head', bot.blockAt(pos.offset(0, 1, 0))?.name, 'controls', JSON.stringify(bot.controlState));
        wd.stuck = true;
        try { bot.pathfinder.setGoal(null); } catch { /* ignore */ }
      }
    }, 500);
    try {
      await ctx.race(p);
      return;
    } catch (e) {
      if (isStop(e)) { halt(bot); throw e; }
      lastErr = e;
      const cancelled = e?.name === 'PathStopped' || e?.name === 'GoalChanged';
      if (cancelled && !wd.stuck && (h.autoBusy || Date.now() - h.lastAutoAt < 2500) && interrupts < 12) { interrupts++; continue; }
      if (cancelled && wd.stuck) {
        stuckCount++;
        if (stuckCount > 4) {
          halt(bot);
          throw new Error(`Stuck at ${fmtPos(bot.entity.position)} while walking to ${what} (tried ${stuckCount - 1} unstuck maneuvers incl. digging free). ${diagnose(bot, goalPos(goal))}`);
        }
        if (stuckCount <= 2) await unstuckMove(ctx, stuckCount);
        else await unstickDig(ctx, goalPos(goal));
        continue;
      }
      if (e?.name === 'NoPath' && bot.entity.isInWater && !swamOut && (swamOut = true)) {
        // the pathfinder often finds no path out of water onto a 1-block ledge: swim at the target holding jump, then retry
        await swimToward(ctx, goalPos(goal));
        continue;
      }
      if (e?.name === 'NoPath') {
        throw new Error(`No path to ${what} from ${fmtPos(bot.entity.position)}. ${diagnose(bot, goalPos(goal))}`);
      }
      if (e?.name === 'Timeout' && !wd.retriedThink && (wd.retriedThink = true)) {
        // one more try with a much longer A* budget
        const old = bot.pathfinder.thinkTimeout;
        bot.pathfinder.thinkTimeout = 20000;
        try { await gotoGoal(ctx, goal, { maxMs: Math.max(5000, maxMs - (Date.now() - t0)), what }); return; } finally { bot.pathfinder.thinkTimeout = old; }
      }
      if (e?.name === 'Timeout') {
        const e2 = new Error(`Pathfinding to ${what} took too long (very far or complex terrain). ${diagnose(bot, goalPos(goal))}`);
        e2.thinkTimeout = true;
        throw e2;
      }
      if (cancelled) throw new Error(`Movement to ${what} was interrupted (${e.message}).`);
      throw e;
    } finally {
      clearInterval(iv);
    }
  }
}

/** swim toward a point (no sprint: sprint-swimming dives); pushing into a ledge while jumping climbs out of water */
export async function swimToward(ctx, target, maxMs = 5000) {
  const { bot } = ctx;
  halt(bot);
  await sleep(100, ctx.signal);
  const t0 = Date.now();
  bot.setControlState('forward', true); bot.setControlState('jump', true);
  try {
    while (Date.now() - t0 < maxMs && !(bot.entity.onGround && !bot.entity.isInWater)) {
      if (target && Number.isFinite(target.x)) await bot.look(Math.atan2(-(target.x + 0.5 - bot.entity.position.x), -(target.z + 0.5 - bot.entity.position.z)), 0, true).catch(() => {});
      await sleep(110, ctx.signal);
    }
    await sleep(300, ctx.signal);
  } finally { bot.clearControlStates(); }
}

async function unstuckMove(ctx, n) {
  const { bot } = ctx;
  halt(bot);
  const dirs = ['forward', 'back', 'left', 'right'];
  const dir = dirs[n % 4];
  bot.setControlState('jump', true);
  bot.setControlState(dir, true);
  bot.setControlState('sprint', true);
  try { await sleep(900, ctx.signal); } finally { bot.clearControlStates(); }
}

/** best-effort target position of a pathfinder goal (for diagnostics) */
export function goalPos(goal) {
  if (!goal) return null;
  if (goal.goals) { for (const g of goal.goals) { const p = goalPos(g); if (p) return p; } return null; }
  if (goal.entity?.position) return goal.entity.position;
  if (goal.x !== undefined && goal.z !== undefined) return new Vec3(goal.x, goal.y ?? NaN, goal.z);
  return null;
}

const hasPickaxe = (bot) => bot.inventory.items().some((i) => /_pickaxe$/.test(i.name));

/** Explain WHY the bot cannot get somewhere and what to try. Cheap, sync. */
export function diagnose(bot, target) {
  const me = bot.entity.position;
  const f = me.floored();
  const at = (dx, dy, dz) => bot.blockAt(f.offset(dx, dy, dz));
  const out = [];
  const tips = [];
  const feet = at(0, 0, 0), head = at(0, 1, 0);
  if (feet && isLiquidName(feet.name) || bot.entity.isInWater) out.push('you are in water');
  // enclosure: solid on all 4 sides at feet or head level and something solid above
  const sides = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  const walled = sides.filter(([dx, dz]) => isSolid(at(dx, 0, dz)) || isSolid(at(dx, 1, dz))).length;
  let roof = null;
  for (let dy = 2; dy < 12; dy++) { const b = at(0, dy, 0); if (b && isSolid(b)) { roof = dy; break; } }
  let sky = true;
  for (let dy = 2; dy < 64; dy++) { const b = at(0, dy, 0); if (b && isSolid(b) && !/_leaves$/.test(b.name)) { sky = false; break; } }
  if (walled === 4) {
    out.push(`you are boxed in (solid blocks on all 4 sides${roof ? `, roof ${roof - 1} block${roof > 2 ? 's' : ''} above` : ''})`);
    tips.push('call escape (digs/pillars/swims out, even without a pickaxe)');
  } else if (!sky && me.y < 60) {
    out.push(`you are underground (y ${Math.floor(me.y)}, no open sky)`);
    tips.push('call escape or surface to climb out first, then goto');
  }
  if (!hasPickaxe(bot)) {
    const stoneNear = sides.some(([dx, dz]) => { const b = at(dx, 0, dz) || at(dx, 1, dz); return b && isSolid(b) && !handDiggable(b); });
    if (stoneNear) { out.push('no pickaxe and stone around you'); tips.push('escape can still hand-dig dirt/gravel/sand or pillar with any block; craft a wooden_pickaxe if you carry 3 planks + 2 sticks'); }
  }
  if (target && Number.isFinite(target.x)) {
    const dx = target.x - me.x, dz = target.z - me.z, hd = Math.hypot(dx, dz);
    const dir = dirName(dx, dz);
    const tb = bot.blockAt(new Vec3(Math.floor(target.x), Number.isFinite(target.y) ? Math.floor(target.y) : Math.floor(me.y), Math.floor(target.z)));
    if (!tb) { out.push(`the target is ${Math.round(hd)} blocks ${dir} in chunks that are not loaded yet`); tips.push('goto moves in hops automatically; call goto again to continue, or pick a waypoint on the way'); }
    if (Number.isFinite(target.y) && target.y - me.y > 6 && hd < 12) { out.push(`target is ${Math.round(target.y - me.y)} blocks above you`); tips.push('climb with escape/surface or pillar with place'); }
    if (Number.isFinite(target.y) && me.y - target.y > 6 && hd < 12) out.push(`target is ${Math.round(me.y - target.y)} blocks below you`);
    // what is in the way 2-4 blocks toward the target
    if (hd > 1.5) {
      const ux = dx / hd, uz = dz / hd;
      for (let k = 1; k <= 4; k++) {
        const p = new Vec3(Math.floor(me.x + ux * k), f.y, Math.floor(me.z + uz * k));
        const b0 = bot.blockAt(p), b1 = bot.blockAt(p.offset(0, 1, 0)), b2 = bot.blockAt(p.offset(0, 2, 0));
        if (!b0) break;
        if (isLiquidName(b0.name) || isLiquidName(b1?.name)) { out.push(`${b0.name === 'lava' || b1?.name === 'lava' ? 'LAVA' : 'water'} ${k} block${k > 1 ? 's' : ''} ${dir}`); if (b0.name !== 'lava') tips.push('water is slow to path through: go around it or bridge with place'); break; }
        if (isSolid(b0) && isSolid(b1) && isSolid(b2)) { out.push(`a wall (${b1.name}) ${k} block${k > 1 ? 's' : ''} ${dir} of you`); tips.push(hasPickaxe(bot) || handDiggable(b1) ? 'mine_block through it or go around' : 'go around it (you cannot dig it without a pickaxe)'); break; }
        let drop = 0;
        for (let dy = -1; dy >= -12; dy--) { const b = bot.blockAt(p.offset(0, dy, 0)); if (!b || isSolid(b) || isLiquidName(b.name)) break; drop++; }
        if (drop >= 4) { out.push(`a ${drop}+ block drop (cliff/ravine) ${k} block${k > 1 ? 's' : ''} ${dir}`); tips.push('go around the cliff or bridge across with place'); break; }
      }
    }
  }
  const lava = bot.findBlock({ matching: bot.registry.blocksByName.lava.id, maxDistance: 5 });
  if (lava) out.push(`lava nearby at ${fmtPos(lava.position)}`);
  if (!out.length) out.push('terrain looks passable nearby; the route may be long or blocked further on');
  if (!tips.length) tips.push('try goto to a closer point first, use look_around to see what is around you, or pick another route');
  return `Why: ${out.join('; ')}. Try: ${[...new Set(tips)].join('; ')}.`;
}

/** Dig the blocks that box the bot in at feet/head level (toward the target if known) and jump out. Hand-digs soft blocks, uses a pickaxe otherwise. */
export async function unstickDig(ctx, target) {
  const { bot } = ctx;
  halt(bot);
  const f = bot.entity.position.floored();
  let dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  if (target && Number.isFinite(target.x)) {
    const dx = target.x - bot.entity.position.x, dz = target.z - bot.entity.position.z;
    dirs = dirs.sort((a, b) => (b[0] * dx + b[1] * dz) - (a[0] * dx + a[1] * dz));
  }
  // automatic unstuck only breaks NATURAL terrain, never what someone built (planks, glass, bricks, doors, stations...)
  const natural = (b) => /^(dirt|grass_block|coarse_dirt|podzol|rooted_dirt|mud|gravel|sand|red_sand|clay|snow|snow_block|stone|deepslate|andesite|diorite|granite|tuff|calcite|netherrack|dripstone_block|moss_block|sandstone|red_sandstone|terracotta|.*_terracotta|soul_sand|soul_soil|blackstone|basalt|short_grass|tall_grass|fern|vine|.*_leaves|.*_ore)$/.test(b.name);
  const canBreak = (b) => b && isSolid(b) && b.diggable && natural(b) && !lavaNear(bot, b.position) && (handDiggable(b) || hasPickaxe(bot) || b.hardness <= 0.8);
  // head-room first (often a block above keeps us from jumping), then the best side
  { const b = bot.blockAt(f.offset(0, 2, 0)); if (canBreak(b) && !isSolid(bot.blockAt(f.offset(0, 1, 0)))) await digAny(ctx, b).catch((e) => { if (isStop(e)) throw e; }); }
  for (const [dx, dz] of dirs) {
    const b0 = bot.blockAt(f.offset(dx, 0, dz)), b1 = bot.blockAt(f.offset(dx, 1, dz));
    if ((b0 && !isSolid(b0) || canBreak(b0)) && (b1 && !isSolid(b1) || canBreak(b1))) {
      for (const b of [b1, b0]) if (isSolid(b)) await digAny(ctx, b).catch((e) => { if (isStop(e)) throw e; });
      await ctx.race(bot.lookAt(f.offset(dx + 0.5, 1.6, dz + 0.5), true)).catch(() => {});
      bot.setControlState('forward', true); bot.setControlState('jump', true);
      try { await sleep(700, ctx.signal); } finally { bot.clearControlStates(); }
      return true;
    }
  }
  return false;
}

/** dig a block with the best tool we have, even if it will not drop anything (for escaping). */
export async function digAny(ctx, block) {
  const { bot } = ctx;
  try { await ctx.race(bot.tool.equipForBlock(block, { requireHarvest: false })); } catch (e) { if (isStop(e)) throw e; }
  try { await ctx.race(bot.dig(block, true)); } catch (e) { if (isStop(e)) { try { bot.stopDigging(); } catch { /* */ } } throw e; }
}

// ---------- movement profile for chasing mobs (no digging/towering: fast paths that follow the mob) ----------
const chaseMoves = new WeakMap();
export function chaseMovements(bot) {
  if (chaseMoves.has(bot)) return chaseMoves.get(bot);
  const base = bot.pathfinder.movements;
  const m = new Movements(bot);
  m.canDig = false; m.allow1by1towers = false; m.allowParkour = true; m.allowSprinting = true; m.maxDropDown = 3;
  m.scafoldingBlocks = [];
  if (base) { for (const id of base.blocksToAvoid || []) m.blocksToAvoid.add(id); m.liquidCost = 6; }
  patchMovements(bot, m); // chase through open/closed wooden doors and gates too
  chaseMoves.set(bot, m);
  return m;
}

export const nearGoal = (p, range = 2) => new goals.GoalNear(p.x, p.y, p.z, range);

export async function gotoPos(ctx, pos, range = 1, opts = {}) {
  const what = `(${Math.floor(pos.x)},${Math.floor(pos.y)},${Math.floor(pos.z)})`;
  const g = range <= 0 ? new goals.GoalBlock(pos.x, pos.y, pos.z) : nearGoal(pos, range);
  await gotoGoal(ctx, g, { what, ...opts });
}

// ---------- blocks ----------
export const isAirName = (n) => n === 'air' || n === 'cave_air' || n === 'void_air';
export const isLiquidName = (n) => n === 'water' || n === 'lava' || n === 'bubble_column';
const REPLACEABLE = new Set(['air', 'cave_air', 'void_air', 'water', 'lava', 'short_grass', 'tall_grass', 'grass', 'fern', 'large_fern', 'snow', 'dead_bush', 'seagrass', 'tall_seagrass', 'vine', 'light']);
export const isReplaceable = (b) => !b || REPLACEABLE.has(b.name);
export const isSolid = (b) => !!b && b.boundingBox === 'block' && !isLiquidName(b.name);

const NEIGH = [[0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0]];

export function lavaNear(bot, pos) {
  for (const [dx, dy, dz] of [...NEIGH, [0, 0, 0]]) {
    const b = bot.blockAt(new Vec3(pos.x + dx, pos.y + dy, pos.z + dz));
    if (b && b.name === 'lava') return true;
  }
  return false;
}

export async function equipToolFor(ctx, block) {
  const { bot, mcData } = ctx;
  try { await ctx.race(bot.tool.equipForBlock(block, { requireHarvest: false })); } catch (e) { if (isStop(e)) throw e; }
  if (block.harvestTools) {
    const held = bot.heldItem;
    if (!held || !block.harvestTools[held.type]) {
      const need = Object.keys(block.harvestTools).map((id) => mcData.items[id]?.name).filter(Boolean);
      const best = need.sort((a, b) => tierOf(a) - tierOf(b))[0];
      const err = new Error(`${block.name} needs ${best || need.join(' / ')} (or better) to drop anything; you hold ${held?.name || 'nothing'}. Craft/obtain that tool first.`);
      err.needsTool = true;
      throw err;
    }
  }
}
const TIERS = ['wooden', 'golden', 'stone', 'iron', 'diamond', 'netherite'];
const tierOf = (n) => { const i = TIERS.findIndex((t) => n.startsWith(t)); return i < 0 ? 9 : i; };

export async function digBlock(ctx, block) {
  const { bot } = ctx;
  await equipToolFor(ctx, block);
  try {
    await ctx.race(bot.dig(block, true));
  } catch (e) {
    if (isStop(e)) { try { bot.stopDigging(); } catch { /* */ } }
    throw e;
  }
}

/** walk to a spot with line of sight / reach to the block, then dig it. Returns true when mined. */
export async function mineAt(ctx, pos, { maxMs = 60000 } = {}) {
  const { bot } = ctx;
  const p = new Vec3(Math.floor(pos.x), Math.floor(pos.y), Math.floor(pos.z));
  let block = bot.blockAt(p);
  if (!block) throw new Error(`Block at ${fmtPos(p)} is in an unloaded chunk; goto closer first.`);
  if (isAirName(block.name)) return { air: true, name: block.name };
  if (!block.diggable) throw new Error(`${block.name} at ${fmtPos(p)} cannot be mined (unbreakable).`);
  if (lavaNear(bot, p)) throw new Error(`Refusing to mine ${block.name} at ${fmtPos(p)}: lava is adjacent. Pick another block or place a block against the lava first.`);
  const eye = () => bot.entity.position.offset(0, 1.62, 0);
  const inReach = () => eye().distanceTo(p.offset(0.5, 0.5, 0.5)) <= 4.4;
  if (!inReach()) {
    await gotoGoal(ctx, new goals.GoalNear(p.x, p.y, p.z, 3), { maxMs, what: `${block.name} at ${fmtPos(p)}` });
  }
  block = bot.blockAt(p);
  if (!block || isAirName(block.name)) return { air: true, name: block?.name };
  await digBlock(ctx, block);
  return { air: false, name: block.name };
}

// ---------- items on the ground ----------
export function droppedItemName(bot, e) {
  try {
    const it = e.getDroppedItem?.();
    if (it) return { name: it.name, count: it.count };
  } catch { /* fall through */ }
  try {
    const md = e.metadata?.find((m) => m && typeof m === 'object' && m.itemId !== undefined);
    if (md) return { name: bot.registry.items[md.itemId]?.name || 'item', count: md.itemCount };
  } catch { /* ignore */ }
  return { name: 'item', count: 1 };
}

export function itemEntities(bot, radius = 8, ignore) {
  const me = bot.entity.position;
  return Object.values(bot.entities).filter((e) => e.name === 'item' && e.position && e.position.distanceTo(me) <= radius && !(ignore && ignore.has(e.id)))
    .sort((a, b) => a.position.distanceTo(me) - b.position.distanceTo(me));
}

// items the auto-pickup / collect should not chase
export function isJunkItem(bot, name) {
  if (name === 'bamboo' || /_leaves$/.test(name) || name === 'poisonous_potato' || name === 'spider_eye' || name === 'pufferfish') return true;
  if (name === 'rotten_flesh' && (bot.food ?? 20) > 8) return true;
  return false;
}

/** For tree logs: is the trunk column connected to solid ground? and how high above it is this block? */
export function logColumn(bot, p) {
  let y = p.y - 1;
  for (let i = 0; i < 48; i++) {
    const b = bot.blockAt(new Vec3(p.x, y, p.z));
    if (!b) return { grounded: false, height: 99 };
    if (/_(log|wood)$/.test(b.name)) { y--; continue; }
    const solid = isSolid(b) && !/_leaves$/.test(b.name);
    return { grounded: solid, height: p.y - y - 1 };
  }
  return { grounded: false, height: 99 };
}

export function inventoryFull(bot) { return bot.inventory.emptySlotCount() === 0; }

export async function pickupItems(ctx, { radius = 7, maxMs = 5000, center, names } = {}) {
  const { bot, h } = ctx;
  const t0 = Date.now();
  let got = 0;
  const failed = new Set();
  while (Date.now() - t0 < maxMs) {
    ctx.throwIfAborted();
    if (inventoryFull(bot)) break;
    const c = center || bot.entity.position;
    const list = itemEntities(bot, radius + 3, h.ignoreItems).filter((e) => { if (failed.has(e.id) || e.position.distanceTo(c) > radius) return false; const nm = droppedItemName(bot, e).name; return names ? names.has(nm) : !isJunkItem(bot, nm); });
    if (!list.length) break;
    const e = list[0];
    try {
      if (e.position.distanceTo(bot.entity.position) > 1.2) {
        await gotoGoal(ctx, new goals.GoalNear(e.position.x, e.position.y, e.position.z, 0.8), { maxMs: Math.max(1500, maxMs - (Date.now() - t0)), what: 'a dropped item' });
      }
      await sleep(250, ctx.signal);
      if (bot.entities[e.id]) failed.add(e.id); else got++;
    } catch (err) {
      if (isStop(err)) throw err;
      failed.add(e.id);
    }
  }
  return got;
}

// ---------- placing ----------
export function findPlaceRef(bot, T) {
  for (const [dx, dy, dz] of NEIGH) {
    const ref = bot.blockAt(new Vec3(T.x + dx, T.y + dy, T.z + dz));
    if (isSolid(ref) && ref.name !== 'crafting_table' && !/chest|furnace|door|button|lever|bed$/.test(ref.name)) {
      return { ref, face: new Vec3(-dx, -dy, -dz) };
    }
  }
  return null;
}

const PLANT_RE = /_sapling$|^(short_grass|fern|dandelion|poppy|blue_orchid|allium|azure_bluet|.*_tulip|oxeye_daisy|cornflower|lily_of_the_valley|sunflower|lilac|rose_bush|peony|sweet_berries|.*_mushroom|bamboo|sugar_cane|azalea|flowering_azalea)$/;
const NEEDS_FLOOR_RE = /_bed$|_carpet$|_pressure_plate$|^(rail|powered_rail|detector_rail|activator_rail|redstone|repeater|comparator|flower_pot|candle|.*_candle|cake|snow)$/;

export async function placeBlockAt(ctx, itemName, pos, { moveRange = 3.5, ref: forcedRef = null, face: forcedFace = null, standAt = null } = {}) {
  const { bot } = ctx;
  const T = new Vec3(Math.floor(pos.x), Math.floor(pos.y), Math.floor(pos.z));
  const item = bot.inventory.items().find((i) => i.name === itemName);
  if (!item) throw new Error(`You have no ${itemName} in inventory.`);
  const okNames = placedBlockNames(itemName);
  const cur = bot.blockAt(T);
  if (!cur) throw new Error(`(${fmtPos(T)}) is in an unloaded chunk; goto closer first.`);
  if (okNames.includes(cur.name)) return 'already';
  if (!isReplaceable(cur)) throw new Error(`Cannot place ${itemName} at ${fmtPos(T)}: occupied by ${cur.name}. mine_block it first.`);
  let found = forcedRef ? { ref: forcedRef, face: forcedFace || new Vec3(0, 1, 0) } : null;
  if (!found && (SEED_ITEMS.has(itemName) || PLANT_RE.test(itemName) || NEEDS_FLOOR_RE.test(itemName))) {
    const below = bot.blockAt(T.offset(0, -1, 0));
    if (isSolid(below) || below?.name === 'farmland') found = { ref: below, face: new Vec3(0, 1, 0) };
    else throw new Error(`Cannot place ${itemName} at ${fmtPos(T)}: it needs a solid block underneath (below is ${below?.name || 'nothing'}).`);
  }
  if (!found) found = findPlaceRef(bot, T);
  if (!found) throw new Error(`Cannot place ${itemName} at ${fmtPos(T)}: no solid block next to it to attach to (floating). Place a supporting block first (build bottom-up).`);
  const me = () => bot.entity.position;
  const dist = () => me().offset(0, 1.62, 0).distanceTo(T.offset(0.5, 0.5, 0.5));
  const overlapping = () => {
    const f = me().floored();
    return (f.x === T.x && f.z === T.z && (f.y === T.y || f.y + 1 === T.y));
  };
  if (standAt) {
    const f = me().floored();
    if (f.x !== standAt.x || f.z !== standAt.z || f.y !== standAt.y) await gotoGoal(ctx, new goals.GoalBlock(standAt.x, standAt.y, standAt.z), { maxMs: 30000, what: `standing spot ${fmtPos(standAt)}` });
  } else if (dist() > 4.4 || overlapping() || dist() < 1.0) {
    const goal = new goals.GoalCompositeAll([
      new goals.GoalNear(T.x, T.y, T.z, moveRange),
      new goals.GoalInvert(new goals.GoalNear(T.x, T.y, T.z, 1.3)),
    ]);
    await gotoGoal(ctx, goal, { maxMs: 30000, what: `placement spot near ${fmtPos(T)}` });
  }
  await ctx.race(bot.equip(item, 'hand'));
  try {
    await ctx.race(bot.lookAt(T.offset(0.5, standAt ? 0.1 : 0.5, 0.5), true));
    await ctx.race(bot.placeBlock(found.ref, found.face));
  } catch (e) {
    if (isStop(e)) throw e;
    // verify – sometimes the update packet is late
    await sleep(350, ctx.signal);
    const after = bot.blockAt(T);
    if (after && okNames.includes(after.name)) return 'ok';
    throw new Error(`Failed to place ${itemName} at ${fmtPos(T)}: ${e.message}`);
  }
  return 'ok';
}

const H4 = [[1, 0], [0, 1], [-1, 0], [0, -1]];
const standable = (bot, p) => { const b = bot.blockAt(p), u = bot.blockAt(p.offset(0, 1, 0)), d = bot.blockAt(p.offset(0, -1, 0)); return b && u && isReplaceable(b) && !isLiquidName(b.name) && isReplaceable(u) && !isLiquidName(u.name) && isSolid(d); };

/**
 * Agent-facing placement: fixes the common mistakes before placing.
 *  - target is the ground block itself (grass/dirt/farmland) -> place on top
 *  - seeds need farmland (tills dirt with a hoe if you carry one), saplings need soil
 *  - beds need 2 free floor blocks: picks a facing whose head block is free, stands behind it
 * Returns { result: 'ok'|'already', pos: Vec3, notes: [] }
 */
export async function smartPlace(ctx, itemName, pos) {
  const { bot } = ctx;
  const notes = [];
  let T = new Vec3(Math.floor(pos.x), Math.floor(pos.y), Math.floor(pos.z));
  const okNames = placedBlockNames(itemName);
  let cur = bot.blockAt(T);
  if (!cur) throw new Error(`(${fmtPos(T)}) is in an unloaded chunk; goto closer first.`);
  if (okNames.includes(cur.name)) return { result: 'already', pos: T, notes };
  const above = bot.blockAt(T.offset(0, 1, 0));
  if (!isReplaceable(cur) && above && isReplaceable(above) && !isLiquidName(above.name)) {
    notes.push(`${fmtPos(T)} is ${cur.name} (the ground), so placed on top of it at ${fmtPos(T.offset(0, 1, 0))}`);
    T = T.offset(0, 1, 0); cur = above;
    if (okNames.includes(cur.name)) return { result: 'already', pos: T, notes };
  }
  if (SEED_ITEMS.has(itemName)) {
    const soil = bot.blockAt(T.offset(0, -1, 0));
    if (soil && soil.name !== 'farmland') {
      if (!/^(dirt|grass_block|dirt_path|coarse_dirt|rooted_dirt)$/.test(soil.name)) throw new Error(`${itemName} must be planted on farmland; ${fmtPos(soil.position)} is ${soil.name}. Pick a dirt/grass block near water, till it with a hoe (use_item with a hoe at it), then place the seeds on top.`);
      const hoe = bot.inventory.items().find((i) => /_hoe$/.test(i.name));
      if (!hoe) throw new Error(`${itemName} must be planted on farmland, and ${fmtPos(soil.position)} is ${soil.name}. Craft a wooden_hoe (2 planks + 2 sticks) and call place again (it tills automatically).`);
      if (bot.entity.position.offset(0, 1.62, 0).distanceTo(soil.position.offset(0.5, 1, 0.5)) > 4.2) await gotoGoal(ctx, new goals.GoalNear(soil.position.x, soil.position.y + 1, soil.position.z, 3), { maxMs: 30000, what: `soil at ${fmtPos(soil.position)}` });
      await ctx.race(bot.equip(hoe, 'hand'));
      await ctx.race(bot.lookAt(soil.position.offset(0.5, 1, 0.5), true));
      await ctx.race(bot.activateBlock(soil, new Vec3(0, 1, 0))).catch((e) => { if (isStop(e)) throw e; });
      for (let i = 0; i < 8 && bot.blockAt(soil.position)?.name !== 'farmland'; i++) await sleep(100, ctx.signal);
      if (bot.blockAt(soil.position)?.name !== 'farmland') throw new Error(`Tried to till ${soil.name} at ${fmtPos(soil.position)} with ${hoe.name} but it did not turn into farmland (it must have air above it).`);
      notes.push(`tilled ${fmtPos(soil.position)} into farmland`);
      if (!bot.findBlock({ point: soil.position, matching: bot.registry.blocksByName.water.id, maxDistance: 5 })) notes.push('no water within 4 blocks: the farmland may dry out and the crop grows slowly');
    }
  } else if (/_sapling$/.test(itemName) || itemName === 'azalea' || itemName === 'flowering_azalea') {
    const soil = bot.blockAt(T.offset(0, -1, 0));
    if (!soil || !SAPLING_SOIL.has(soil.name)) throw new Error(`${itemName} only grows on dirt/grass/podzol/moss; ${fmtPos(T.offset(0, -1, 0))} is ${soil?.name || 'nothing'}. Give the coordinates of a grass or dirt block (the sapling goes on top).`);
  } else if (/_bed$/.test(itemName)) {
    // the bed foot goes at T, the head one block in the direction the player faces -> stand behind the foot looking at it
    const me = bot.entity.position;
    const cands = [];
    for (const [dx, dz] of H4) {
      const head = T.offset(dx, 0, dz);
      const hb = bot.blockAt(head), hf = bot.blockAt(head.offset(0, -1, 0)), ff = bot.blockAt(T.offset(0, -1, 0));
      if (!hb || !isReplaceable(hb) || isLiquidName(hb.name) || !isSolid(hf) || !isSolid(ff)) continue;
      for (const k of [1, 2]) {
        const s = T.offset(-dx * k, 0, -dz * k);
        if (standable(bot, s)) { cands.push({ dx, dz, s, d: s.distanceTo(me) + (k - 1) }); break; }
      }
    }
    if (!cands.length) throw new Error(`No room for a bed at ${fmtPos(T)}: a bed needs 2 free blocks side by side on a solid floor, and a free spot to stand behind it. Pick an open flat spot (look_around shows the floor around you).`);
    cands.sort((a, b) => a.d - b.d);
    let lastErr = null;
    for (const c of cands.slice(0, 3)) {
      try {
        const r = await placeBlockAt(ctx, itemName, T, { ref: bot.blockAt(T.offset(0, -1, 0)), face: new Vec3(0, 1, 0), standAt: c.s });
        notes.push(`bed foot at ${fmtPos(T)}, head at ${fmtPos(T.offset(c.dx, 0, c.dz))} (facing ${dirName(c.dx, c.dz)})`);
        return { result: r, pos: T, notes };
      } catch (e) { if (isStop(e)) throw e; lastErr = e; }
    }
    throw lastErr;
  } else if (/torch$/.test(itemName) && !findPlaceRef(bot, T)) {
    throw new Error(`A torch at ${fmtPos(T)} would float: put it on top of a solid block or against a wall.`);
  }
  const r = await placeBlockAt(ctx, itemName, T);
  return { result: r, pos: T, notes };
}

/** find a free standing-adjacent spot near the bot for a 1x1 utility block (table/furnace/chest). */
export function findFreeSpotNear(bot) {
  const base = bot.entity.position.floored();
  const cands = [];
  for (let dx = -3; dx <= 3; dx++) for (let dz = -3; dz <= 3; dz++) for (let dy = -2; dy <= 2; dy++) {
    if (dx === 0 && dz === 0) continue;
    const T = base.offset(dx, dy, dz);
    const b = bot.blockAt(T);
    if (T.distanceTo(bot.entity.position) > 4) continue;
    const below = bot.blockAt(T.offset(0, -1, 0));
    const above = bot.blockAt(T.offset(0, 1, 0));
    if (b && isReplaceable(b) && !isLiquidName(b.name) && isSolid(below) && (!above || isReplaceable(above))) {
      cands.push({ T, d: Math.abs(dx) + Math.abs(dz) + Math.abs(dy) });
    }
  }
  cands.sort((a, b) => a.d - b.d);
  return cands[0]?.T || null;
}

export async function placeUtility(ctx, itemName) {
  const { bot } = ctx;
  let T = findFreeSpotNear(bot);
  for (let i = 0; i < 3 && !T; i++) {
    const p = bot.entity.position;
    const a = Math.random() * Math.PI * 2;
    await gotoGoal(ctx, new goals.GoalNear(p.x + Math.cos(a) * 6, p.y, p.z + Math.sin(a) * 6, 2), { maxMs: 15000, what: 'an open spot' }).catch((e) => { if (isStop(e)) throw e; });
    T = findFreeSpotNear(bot);
  }
  if (!T) throw new Error(`No free flat space near ${fmtPos(bot.entity.position)} to place ${itemName} (dense terrain). Move to open ground (goto) and retry.`);
  await placeBlockAt(ctx, itemName, T);
  return T;
}

// ---------- fighting ----------
const WEAPON_ORDER = ['netherite_sword', 'diamond_sword', 'iron_sword', 'stone_sword', 'golden_sword', 'wooden_sword',
  'netherite_axe', 'diamond_axe', 'iron_axe', 'stone_axe', 'golden_axe', 'wooden_axe'];
export async function equipBestWeapon(ctx) {
  const { bot } = ctx;
  for (const n of WEAPON_ORDER) {
    const it = bot.inventory.items().find((i) => i.name === n);
    if (it) { if (bot.heldItem?.type !== it.type) await bot.equip(it, 'hand').catch(() => {}); return n; }
  }
  return null;
}

export function isHostile(bot, e) {
  if (!e || e === bot.entity || !e.position) return false;
  if (e.type !== 'hostile') return false;
  if (HOSTILE_IGNORE.has(e.name)) return false;
  return true;
}

export function findEntityByName(bot, target, maxDist = 64) {
  const me = bot.entity.position;
  const t = String(target).toLowerCase();
  let best = null, bd = Infinity;
  for (const e of Object.values(bot.entities)) {
    if (e === bot.entity || !e.position) continue;
    const nm = (e.type === 'player' ? e.username : e.name)?.toLowerCase();
    const dn = e.displayName?.toLowerCase();
    if (nm === t || dn === t || (e.type !== 'player' && nm?.replace(/_/g, ' ') === t)) {
      const d = e.position.distanceTo(me);
      if (d < bd && d <= maxDist) { best = e; bd = d; }
    }
  }
  return best;
}

/** fight one entity until it is dead / gone / timeout / our health gets low. Returns reason string. */
export async function fight(ctx, entity, { maxMs = 30000, minHealth = 5 } = {}) {
  const { bot } = ctx;
  await equipBestWeapon(ctx).catch(() => {});
  const t0 = Date.now();
  ctx.h.fighting = true;
  bot.pvp.attack(entity);
  try {
    while (true) {
      if (ctx.signal.aborted) throw new StopError();
      if (!bot.entities[entity.id] || entity.isValid === false) return 'dead';
      if (bot.health <= minHealth) return 'low_health';
      if (Date.now() - t0 > maxMs) return 'timeout';
      if (entity.position.distanceTo(bot.entity.position) > 24) return 'lost';
      await sleep(200, ctx.signal);
    }
  } finally {
    ctx.h.fighting = false;
    try { bot.pvp.stop(); } catch { /* */ }
    try { bot.pathfinder.setGoal(null); } catch { /* */ }
    bot.clearControlStates();
  }
}

export { r1 };

/** walk away from a point so we do not re-pick up what we just dropped */
export async function stepAway(ctx, from, dist = 4) {
  const { bot } = ctx;
  const me = bot.entity.position;
  let dx = me.x - from.x, dz = me.z - from.z;
  const l = Math.hypot(dx, dz) || 1;
  if (l < 0.5) { dx = 1; dz = 0; } else { dx /= l; dz /= l; }
  await gotoGoal(ctx, new goals.GoalNear(me.x + dx * dist, me.y, me.z + dz * dist, 1.5), { maxMs: 8000, what: 'a spot away from the dropped items' }).catch((e) => { if (isStop(e)) throw e; });
}
