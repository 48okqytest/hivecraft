// Action definitions. Each: { name, description, params (JSON Schema), run(ctx,args), quick?, background?, timeoutMs? }
import { Vec3 } from 'vec3';
import pathfinderPkg from 'mineflayer-pathfinder';
import {
  isStop, sleep, r1, fmtPos, posKey, resolveBlockNames, resolveItemNames, itemMatcher, invCounts, invSummary, countItem,
  TOOL_RE, ARMOR_RE, roomFor, fullInventoryHint,
} from './util.js';
import {
  gotoGoal, gotoPos, diagnose, nearGoal, mineAt, pickupItems, placeBlockAt, findPlaceRef, fight, findEntityByName, isHostile, itemEntities,
  droppedItemName, isReplaceable, isAirName, isSolid, halt, stepAway, logColumn, isJunkItem, isLiquidName, lavaNear, digBlock, smartPlace,
} from './nav.js';
import { craftItem, smelt, recipeInfo, findBlockNear, craftPlan, rememberChest } from './craft.js';
import { ROBUST_ACTIONS, escapeOut, skyAbove, huntMany, PASSIVE } from './actions-robust.js';
import { MODE_NAMES } from './modes.js';
import { isProtected, protectedReason, ready as protectReady } from './protect.js';

const { goals } = pathfinderPkg;
const int = (d) => ({ type: 'integer', description: d });
const str = (d, extra = {}) => ({ type: 'string', description: d, ...extra });
const obj = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });

const ORE_HINTS = {
  coal_ore: 'Coal is common in stone at any height (y 0-130), often on cave walls and mountain sides.',
  iron_ore: 'Iron is most common at y 0-64 (best y~16); look in caves / dig down into stone. Needs stone_pickaxe or better.',
  copper_ore: 'Copper is common at y 0-96 in stone/dripstone caves.',
  gold_ore: 'Gold is at y -64..32 (best y -16), also in badlands. Needs iron_pickaxe or better.',
  diamond_ore: 'Diamonds are at y -64..16 (best y -58). Dig down carefully (never straight down; watch for lava below y -54). Needs iron_pickaxe or better.',
  redstone_ore: 'Redstone is at y -64..16 (best y -58). Needs iron_pickaxe or better.',
  lapis_ore: 'Lapis is at y -64..64 (best y 0). Needs stone_pickaxe or better.',
  emerald_ore: 'Emerald only in mountain biomes (y -16..320).',
};

const sleepMs = (ctx, ms) => ctx.sleep(ms);
const vec = (a) => new Vec3(a.x, a.y, a.z);

function playerEntity(bot, name) {
  const p = bot.players[name] || Object.values(bot.players).find((q) => q.username.toLowerCase() === String(name).toLowerCase());
  return p?.entity || null;
}
function playerNotVisible(bot, name) {
  const known = Object.keys(bot.players).filter((n) => n !== bot.username);
  return new Error(`Player "${name}" is not within view range (or not online). Online players: ${known.join(', ') || 'none'}. Ask them to come closer or use goto with coordinates they gave you.`);
}

function gained(bot, before) {
  const after = invCounts(bot);
  const out = [];
  for (const [n, c] of after) { const d = c - (before.get(n) || 0); if (d > 0) out.push(`${n} x${d}`); }
  return out;
}

// ------------------------------------------------------------------
export const ACTION_DEFS = [];
const A = (def) => ACTION_DEFS.push(def);

const HOP = 48;
A({
  name: 'goto',
  description: 'Walk (pathfind) to coordinates — any distance. Far trips are split into ~48-block hops automatically (detours around blocked hops); if the trip needs more than ~2.5 minutes it returns your progress and you just call goto again with the same target. Digs/bridges/climbs short obstacles. y is optional (omit to reach x,z on the surface). range = how close is good enough (default 1, 0 = exact block). If you start deep underground and the target is far away it climbs out first. On failure it explains WHY (wall, water, cliff, unloaded chunks, boxed in, no pickaxe) and what to try (often: escape).',
  params: obj({ x: int('target x'), y: int('target y (optional)'), z: int('target z'), range: int('acceptable distance, default 1') }, ['x', 'z']),
  timeoutMs: 170000,
  async run(ctx, { x, y, z, range = 1 }) {
    const { bot } = ctx;
    const dl = ctx.deadline(150000);
    const start = bot.entity.position.clone();
    const label = `(${x},${y ?? '~'},${z})`;
    const notes = [];
    const hd = () => Math.hypot(x + 0.5 - bot.entity.position.x, z + 0.5 - bot.entity.position.z);
    const finalGoal = () => (y === undefined ? new goals.GoalNearXZ(x, z, Math.max(range, 1)) : (range <= 0 ? new goals.GoalBlock(x, y, z) : new goals.GoalNear(x, y, z, range)));
    const progress = (why) => `${why} Travelled ${Math.round(start.distanceTo(bot.entity.position))} blocks; now at ${fmtPos(bot.entity.position)}, ${Math.round(hd())} blocks (horizontal) from ${label}.${notes.length ? ' (' + notes.join('; ') + ')' : ''}`;
    // deep underground + far target on/above the surface: climb out first (long underground paths time out)
    const me0 = bot.entity.position.floored();
    if (hd() > 40 && me0.y < 56 && (y === undefined || y > me0.y + 12) && !skyAbove(bot, me0)) {
      const r = await escapeOut(ctx, { mode: 'surface', maxMs: Math.min(70000, dl.left() - 20000) });
      notes.push(`climbed out first: ${r.split(' Moved')[0]}`);
    }
    let detours = 0;
    while (hd() > Math.max(HOP, range + 2) && !dl.expired()) {
      await ctx.checkpoint();
      const me = bot.entity.position;
      const d = hd();
      const ux = (x + 0.5 - me.x) / d, uz = (z + 0.5 - me.z) / d;
      let ok = false, lastErr = null;
      for (const [ang, len] of [[0, HOP], [0.6, 36], [-0.6, 36], [1.2, 28], [-1.2, 28]]) {
        if (dl.left() < 5000) break;
        const c = Math.cos(ang), s = Math.sin(ang);
        const hx = Math.round(me.x + (ux * c - uz * s) * len), hz = Math.round(me.z + (ux * s + uz * c) * len);
        try {
          await gotoGoal(ctx, new goals.GoalNearXZ(hx, hz, 3), { maxMs: Math.min(50000, dl.left() - 2000), what: `hop toward ${label} at (${hx},~,${hz})` });
          ok = true; if (ang) detours++;
          break;
        } catch (e) {
          if (isStop(e)) throw e;
          lastErr = e;
          if (bot.entity.position.distanceTo(me) > 12) { ok = true; break; } // made real progress before failing: re-aim from here
        }
      }
      if (!ok) {
        if (dl.expired() || dl.left() < 5000) break;
        throw new Error(`${progress(`Could not get closer to ${label} (tried the direct hop and 4 detours).`)} ${lastErr ? lastErr.message.replace(/^.*?Why:/, 'Why:') : ''}`);
      }
    }
    if (dl.expired() || dl.left() < 4000) return progress('Still travelling (time limit of one call). Call goto again with the same target to continue.');
    if (detours) notes.push(`${detours} detour${detours > 1 ? 's' : ''} around blocked terrain`);
    try {
      const fg = finalGoal();
      await gotoGoal(ctx, fg, { maxMs: Math.max(5000, dl.left()), what: label });
      // the pathfinder can settle on the closest reachable spot (e.g. outside a sealed room) and still resolve: verify
      const here = bot.entity.position.floored();
      let reached = true;
      try { reached = fg.isEnd(here) || fg.isEnd(bot.entity.position.offset(0, 0.5, 0).floored()); } catch { /* keep true */ }
      if (!reached) throw new Error(`Got as close as ${fmtPos(bot.entity.position)} (${Math.round(hd())} blocks horizontally from ${label}) but could not reach it. ${diagnose(bot, new Vec3(x, y ?? NaN, z))}`);
    } catch (e) {
      if (isStop(e)) throw e;
      if (e.walkTimeout) return progress('Still travelling (time limit of one call). Call goto again with the same target to continue.');
      throw e;
    }
    return `Arrived at ${fmtPos(bot.entity.position)} (target ${x},${y ?? '~'},${z}).${notes.length ? ' (' + notes.join('; ') + ')' : ''}`;
  },
});

A({
  name: 'surface',
  description: 'Climb OUT of a cave/mine to open sky fast: walks to a nearby opening if there is one, otherwise digs straight up (best tool you have; soft blocks by hand) and pillars on any common block (dirt, cobblestone, cobbled_deepslate, diorite...), or digs a staircase if you have no blocks. Stops before water/lava above. y = optional height to stop at. Use instead of a long vertical goto. Same engine as escape.',
  params: obj({ y: int('optional: stop once you reach this y') }),
  timeoutMs: 170000,
  async run(ctx, { y } = {}) { return escapeOut(ctx, { untilY: y, mode: 'surface', maxMs: 155000 }); },
});

A({
  name: 'goto_player',
  description: 'Walk to a player (human or bot teammate) who is within view range (~100 blocks). range = how close to stop (default 2).',
  params: obj({ player: str('player name'), range: int('stop distance, default 2') }, ['player']),
  async run(ctx, { player, range = 2 }) {
    const { bot } = ctx;
    for (let i = 0; i < 4; i++) {
      const e = playerEntity(bot, player);
      if (!e) throw playerNotVisible(bot, player);
      if (e.position.distanceTo(bot.entity.position) <= range + 0.5) break;
      await gotoGoal(ctx, new goals.GoalNear(e.position.x, e.position.y, e.position.z, range), { maxMs: 90000, what: `player ${player}` });
    }
    const e = playerEntity(bot, player);
    return `Reached ${player}${e ? ` (distance ${r1(e.position.distanceTo(bot.entity.position))}, they are at ${fmtPos(e.position)})` : ''}.`;
  },
});

A({
  name: 'follow',
  description: 'Start following a player/teammate, staying within `distance` blocks (default 3). Returns immediately; you keep following until you call stop or start another action. Other actions interrupt it.',
  params: obj({ player: str('player name'), distance: int('keep within this many blocks, default 3') }, ['player']),
  background: true,
  async run(ctx, { player, distance = 3 }) {
    const { bot, h } = ctx;
    if (!playerEntity(bot, player)) throw playerNotVisible(bot, player);
    h.startBackground('follow', async (bctx) => {
      let lost = 0;
      while (!bctx.signal.aborted) {
        const e = playerEntity(bot, player);
        if (!e) { if (++lost > 30) throw new Error(`lost sight of ${player}`); await sleep(1000, bctx.signal); continue; }
        lost = 0;
        if (!bot.pathfinder.goal && !h.autoBusy) bot.pathfinder.setGoal(new goals.GoalFollow(e, distance), true);
        await sleep(1000, bctx.signal);
      }
    });
    return `Now following ${player} (staying within ${distance} blocks). Call stop or any other action to stop following.`;
  },
});

A({
  name: 'collect',
  description: 'Find the nearest matching block(s), walk there, mine them with the best tool in your inventory and pick up the drops, until `count` of the resulting item is actually in your inventory (it keeps mining/picking up drops until then). Block names can be generic: log / any_log (any tree trunk), planks, leaves, wool, ore, or exact names like oak_log, stone, cobblestone, iron_ore (deepslate variants included), sand, dirt, coal_ore. Stone gives cobblestone. If a tool is required (e.g. iron_ore needs a stone_pickaxe) it tells you. Returns the real count gained ("Got 2/4 jungle_log, 1 drop unreachable").',
  params: obj({ block: str('block name, e.g. "oak_log", "log", "stone", "iron_ore"'), count: int('how many items you want to end up with, default 1'), max_distance: int('search radius, default 48, max 96') }, ['block']),
  timeoutMs: 175000,
  async run(ctx, { block, count = 1, max_distance = 48 }) {
    const { bot, mcData, h } = ctx;
    let names = resolveBlockNames(mcData, block);
    // "cobblestone" is what stone drops: mine stone (and any placed cobblestone); cobbled_deepslate likewise
    if (names.length === 1 && names[0] === 'cobblestone') names = ['stone', 'cobblestone'];
    if (names.length === 1 && names[0] === 'cobbled_deepslate') names = ['deepslate', 'cobbled_deepslate'];
    const ids = names.map((n) => bot.registry.blocksByName[n].id);
    const maxD = Math.min(Math.max(max_distance, 8), 96);
    if (bot.inventory.emptySlotCount() === 0) {
      const anyRoom = names.some((n) => { const dr = mcData.blocksByName[n]?.drops?.map((id) => mcData.items[id]?.name) || [n]; return dr.some((d) => d && roomFor(bot, d, 1)); });
      if (!anyRoom) throw new Error(`Cannot collect ${block}: ${fullInventoryHint(bot)}`);
    }
    const before = invCounts(bot);
    const dl = ctx.deadline(125000);
    // what the blocks drop = what we actually count
    const targetItems = new Set();
    for (const n of names) {
      const b = mcData.blocksByName[n];
      for (const id of b?.drops || []) { const it = mcData.items[id]; if (it) targetItems.add(it.name); }
      if (!b?.drops?.length) targetItems.add(n);
    }
    const haveTarget = () => { let t = 0; for (const n of targetItems) t += countItem(bot, n); return t; };
    const startTarget = haveTarget();
    const got = () => haveTarget() - startTarget;
    const isTree = names.every((nm) => /_(log|wood)$/.test(nm));
    let floatingOnly = false;
    const minedTypes = new Map();
    let mined = 0, consecutiveFail = 0, retries = 0, vanished = 0, lostDrops = 0, skippedBuilt = 0;
    await protectReady();
    const lostAt = [];
    const bad = new Set();
    const errors = [];
    let fatal = null;
    const maxMined = count * 3 + 3;
    // drops grabbed by another player (often a teammate standing nearby) are not "lost": remember who took them
    const takenBy = new Map();
    const onCollect = (collector, collected) => {
      if (!collector || collector === bot.entity || collector.type !== 'player') return;
      const it = droppedItemName(bot, collected);
      if (targetItems.has(it.name)) takenBy.set(collector.username || collector.name, (takenBy.get(collector.username || collector.name) || 0) + (it.count || 1));
    };
    bot.on('playerCollect', onCollect);
    ctx.partial = () => `Got ${got()}/${count} ${[...minedTypes.keys()][0] || [...targetItems][0]} (mined ${mined} blocks) before the time limit; call collect again to continue.`;
    try {
    while (got() < count && mined < maxMined && !dl.expired()) {
      await ctx.checkpoint();
      const all = bot.findBlocks({ matching: ids, maxDistance: maxD, count: isTree ? 700 : 96 }).filter((p) => !bad.has(posKey(p)));
      // never harvest what the team built (bot-placed blocks, build sites, non-tree logs)
      const found = all.filter((p) => { if (!isProtected(bot, p)) return true; bad.add(posKey(p)); skippedBuilt++; return false; });
      if (!found.length) break;
      const me = bot.entity.position;
      let target;
      if (isTree) {
        // strongly prefer logs of trunks that reach the ground (trunk bases / low logs); floating canopy logs only as a last resort
        const scored = found.map((p) => {
          const c = logColumn(bot, p);
          const s = p.distanceTo(me) + (c.grounded ? 3 * Math.min(c.height, 12) : 1000 + 4 * Math.max(0, p.y - me.y));
          return { p, s, grounded: c.grounded };
        }).sort((x, y) => x.s - y.s);
        target = scored[0].p;
        if (!scored[0].grounded) floatingOnly = true;
      } else {
        const cands = found.slice(0, 24);
        const minY = Math.min(...cands.map((p) => p.y));
        const score = (p) => p.distanceTo(me) + 4 * (p.y - minY) + 3 * Math.max(0, p.y - me.y - 1);
        target = cands.sort((p, q) => score(p) - score(q))[0];
      }
      try {
        const tType = bot.blockAt(target)?.name;
        const dbgT = Date.now(); if (process.env.HIVE_DEBUG) console.log(`[dbg collect] target ${tType} ${fmtPos(target)} from ${fmtPos(me)} got=${got()} grounded=${isTree ? logColumn(bot, target).grounded : '-'}`);
        const r = await mineAt(ctx, target, { maxMs: Math.max(8000, Math.min(60000, dl.left())) });
        if (r.air) { vanished++; if (vanished > 6) break; continue; }
        if (process.env.HIVE_DEBUG) console.log(`[dbg collect] mined in ${Date.now() - dbgT}ms`);
        mined++;
        if (tType) minedTypes.set(tType, (minedTypes.get(tType) || 0) + 1);
        consecutiveFail = 0;
        const g0 = got();
        const recoverUntil = Date.now() + 7000;
        await pickupItems(ctx, { center: target, radius: 8, maxMs: 3500, names: targetItems });
        for (let i = 0; i < 10 && got() <= g0 && Date.now() < recoverUntil; i++) {
          const drops = itemEntities(bot, 14, h.ignoreItems).filter((en) => targetItems.has(droppedItemName(bot, en).name) && en.position.distanceTo(target) < 10);
          if (!drops.length) { await sleep(250, ctx.signal); continue; }
          const dp = drops[0].position.floored();
          const under = bot.blockAt(dp.offset(0, -1, 0));
          if (under && /_leaves$/.test(under.name)) {
            // drop is resting on leaves: break them so it falls / becomes reachable
            await mineAt(ctx, under.position, { maxMs: 6000 }).catch((e2) => { if (isStop(e2)) throw e2; });
          }
          await pickupItems(ctx, { center: drops[0].position, radius: 6, maxMs: Math.max(1500, recoverUntil - Date.now()), names: targetItems });
        }
        if (got() <= g0) {
          const left = itemEntities(bot, 14, h.ignoreItems).filter((en) => targetItems.has(droppedItemName(bot, en).name) && en.position.distanceTo(target) < 10);
          lostDrops++; lostAt.push(left[0] ? fmtPos(left[0].position) : fmtPos(target));
          for (const en of left) h.ignoreItems.add(en.id);
        }
      } catch (e) {
        if (isStop(e)) throw e;
        if ((h.autoBusy || Date.now() - h.lastAutoAt < 2000) && retries++ < 20) continue;
        if (e.needsTool) { fatal = e; break; }
        bad.add(posKey(target));
        errors.push(`${fmtPos(target)}: ${e.message}`);
        if (++consecutiveFail >= 5) break;
      }
    }
    await sleep(900, ctx.signal);
    } finally { bot.removeListener('playerCollect', onCollect); }
    const taken = [...takenBy].map(([who, n]) => `${n} picked up by ${who}`);
    const gain = gained(bot, before);
    if (mined === 0) {
      if (fatal) throw fatal;
      if (errors.length) throw new Error(`Found ${names.join('/')} but could not mine any: ${errors.slice(0, 3).join(' | ')}`);
      const near = h.nearbyBlocks(16);
      const keys = Object.keys(near).slice(0, 8).map((k) => `${k} x${near[k].count}`);
      const hint = names.map((n) => ORE_HINTS[n.replace('deepslate_', '')]).find(Boolean) || '';
      throw new Error(`No ${block} (${names.slice(0, 4).join('/')}${names.length > 4 ? '…' : ''}) within ${maxD} blocks of ${fmtPos(bot.entity.position)}. Nearby notable blocks: ${keys.join(', ') || 'none'}. ${hint} Explore by walking (goto) in some direction (try 60+ blocks) and retry, or check team waypoints/notes.`);
    }
    const g = got();
    let tname = [...minedTypes.entries()].sort((x, y) => y[1] - x[1])[0]?.[0];
    if (tname) { const dr = mcData.blocksByName[tname]?.drops?.map((id) => mcData.items[id]?.name).filter(Boolean)[0]; tname = dr || tname; } else tname = [...targetItems][0];
    const others = gain.filter((x) => { const n = x.split(' x')[0]; return !targetItems.has(n); });
    let msg = `Got ${g}/${count} ${tname} (mined ${mined} block${mined === 1 ? '' : 's'}; inventory now ${haveTarget()} ${targetItems.size > 1 ? "of those" : tname}).`;
    const takenCount = [...takenBy.values()].reduce((a, b) => a + b, 0);
    if (taken.length) msg += ` ${taken.join(', ')} (a teammate standing close grabbed them; ask them for the items, and don't mine right next to each other).`;
    const lost = Math.min(Math.max(0, lostDrops - takenCount), Math.max(0, mined - g - takenCount));
    if (lost) msg += ` ${lost} drop${lost === 1 ? '' : 's'} unreachable/lost (e.g. near ${lostAt[0]}).`;
    if (others.length) msg += ` Also picked up: ${others.slice(0, 3).join(', ')}${others.length > 3 ? ` (+${others.length - 3} more)` : ''}.`;
    if (skippedBuilt) msg += ` Left ${skippedBuilt} team-built ${block} block${skippedBuilt === 1 ? '' : 's'} alone (builds are never harvested).`;
    if (g < count) {
      if (fatal) msg += ` Stopped: ${fatal.message}`;
      else if (dl.expired()) msg += ' Ran out of time; call collect again to continue.';
      else if (floatingOnly && g < count) msg += ' Only floating canopy logs (no trunk reaching the ground) were left nearby; walk to another forest (goto 40+ blocks away) and retry.';
      else if (mined >= maxMined) msg += ' Stopped after too many blocks without enough drops; the drops may be stuck out of reach (canopy/water). Move closer to the base of the trees and retry.';
      else msg += ` Could not find more ${block} nearby${errors.length ? ` (${errors.length} unreachable: ${errors[0]})` : ''}.`;
    }
    return msg;
  },
});

A({
  name: 'mine_block',
  description: 'Mine the single block at x,y,z (walks into reach first, picks best tool, collects the drop). Refuses if lava is adjacent. Use for precise digging, clearing a spot, or digging down/forward. Refuses blocks the team BUILT (bot-placed blocks, build sites, non-tree logs) unless force:true; only use force when you really mean to tear down part of a build (e.g. the human player asked, or it is your own mistake).',
  params: obj({ x: int('x'), y: int('y'), z: int('z'), force: { type: 'boolean', description: 'true = deliberately break a team-built block' } }, ['x', 'y', 'z']),
  async run(ctx, { x, y, z, force = false }) {
    const { bot } = ctx;
    if (!force) {
      await protectReady();
      const why = protectedReason(bot, new Vec3(x, y, z));
      if (why) return `Did NOT mine ${x},${y},${z}: ${why}. Team builds are protected. If you really mean to break it, call mine_block again with force:true.`;
    }
    const before = invCounts(bot);
    const r = await mineAt(ctx, new Vec3(x, y, z));
    if (r.air) return `There is no block at ${x},${y},${z} (already ${r.name}).`;
    await pickupItems(ctx, { center: new Vec3(x, y, z), radius: 4, maxMs: 3000 });
    await sleep(400, ctx.signal);
    const gain = gained(bot, before);
    return `Mined ${r.name} at ${x},${y},${z}. Gained: ${gain.join(', ') || 'nothing (no drop, or wrong tool)'}.`;
  },
});

A({
  name: 'find_blocks',
  description: 'List positions of a block type near you (nearest first) without moving. Accepts generic names (log, ore, planks...). Use to locate trees, ore, water, chests, crafting tables.',
  params: obj({ block: str('block name'), max_distance: int('radius, default 32, max 96'), count: int('max results, default 10') }, ['block']),
  quick: true,
  async run(ctx, { block, max_distance = 32, count = 10 }) {
    const { bot, mcData } = ctx;
    const names = resolveBlockNames(mcData, block);
    const ids = names.map((n) => bot.registry.blocksByName[n].id);
    const found = bot.findBlocks({ matching: ids, maxDistance: Math.min(max_distance, 96), count: Math.min(count, 50) });
    if (!found.length) return `No ${block} within ${Math.min(max_distance, 96)} blocks of ${fmtPos(bot.entity.position)}.`;
    const me = bot.entity.position;
    const lines = found.map((p) => `${bot.blockAt(p)?.name} (${p.x},${p.y},${p.z}) d=${r1(p.distanceTo(me))}`);
    return `${found.length} found (nearest first):\n${lines.join('\n')}`;
  },
});

A({
  name: 'scan',
  description: 'Summarize your surroundings: biome, light, whether you are underground, standing block, resources (logs, ores, water, lava), stations/chests, mobs, players, dropped items - with coordinates. Call this when planning or when something fails.',
  params: obj({ radius: int('search radius, default 16, max 32') }),
  quick: true,
  async run(ctx, { radius = 16 }) {
    const { bot, h } = ctx;
    const R = Math.min(Math.max(radius, 4), 32);
    const p = bot.entity.position;
    const nb = h.nearbyBlocks(R, 800);
    const lines = [];
    const feet = bot.blockAt(p.floored());
    const below = bot.blockAt(p.offset(0, -1, 0));
    let sky = true;
    for (let dy = 2; dy < 40; dy++) { const b = bot.blockAt(p.offset(0, dy, 0).floored()); if (b && !isAirName(b.name) && b.boundingBox === 'block') { sky = false; break; } }
    let biome = null; try { biome = bot.blockAt(p)?.biome?.name; } catch { /* */ }
    lines.push(`At ${fmtPos(p)}${biome ? ` in ${biome}` : ''}; standing on ${below?.name}; ${sky ? 'open sky above' : 'UNDERGROUND/covered (no open sky)'}; ${bot.time.isDay ? 'daytime' : 'NIGHT'} (tick ${bot.time.timeOfDay}); light ${feet?.light ?? '?'}.`);
    const groups = { trees: [], ores: [], water: [], hazards: [], stations: [] };
    for (const [name, v] of Object.entries(nb)) {
      const s = `${name} x${v.count} (nearest ${v.nearest.x},${v.nearest.y},${v.nearest.z}, d=${r1(vec(v.nearest).distanceTo(p))})`;
      if (/_log$/.test(name)) groups.trees.push(s);
      else if (/_ore$|ancient_debris/.test(name)) groups.ores.push(s);
      else if (name === 'lava') groups.hazards.push(`LAVA ${s}`);
      else if (name === 'water') groups.water.push(s);
      else groups.stations.push(s);
    }
    if (groups.trees.length) lines.push('Trees: ' + groups.trees.join('; '));
    if (groups.ores.length) lines.push('Ores: ' + groups.ores.join('; '));
    if (groups.water.length) lines.push('Water: ' + groups.water.join('; '));
    if (groups.hazards.length) lines.push('DANGER: ' + groups.hazards.join('; '));
    if (groups.stations.length) lines.push('Other: ' + groups.stations.join('; '));
    if (!Object.keys(nb).length) lines.push(`No logs/ores/water/stations within ${R} blocks.`);
    const ents = h.nearbyEntities(Math.max(R, 24), 14);
    const mobs = ents.filter((e) => e.type !== 'item').map((e) => `${e.name}${e.type === 'hostile' ? '(HOSTILE)' : e.type === 'player' ? '(player)' : ''} ${e.distance}m at ${e.pos.x},${e.pos.y},${e.pos.z}`);
    if (mobs.length) lines.push('Entities: ' + mobs.join('; '));
    const items = ents.filter((e) => e.type === 'item').map((e) => `${e.name} x${e.count} at ${e.pos.x},${e.pos.y},${e.pos.z}`);
    if (items.length) lines.push('Dropped items: ' + items.join('; '));
    lines.push(`Inventory: ${invSummary(bot)}. Health ${r1(bot.health)}, food ${bot.food}.`);
    return lines.join('\n');
  },
});

A({
  name: 'recipe',
  description: 'Show how to craft an item: ingredients, whether a crafting table is needed, whether you can craft it right now (including intermediate steps like planks->sticks), and what raw materials are missing. Also says if the item must be smelted/mined instead.',
  params: obj({ item: str('item name, e.g. "stone_pickaxe", "furnace", "torch"') }, ['item']),
  quick: true,
  async run(ctx, { item }) { return recipeInfo(ctx, item); },
});

A({
  name: 'craft',
  description: 'Craft an item. Automatically crafts intermediate items (logs->planks->sticks) from what you carry, and places a crafting table (or walks to the nearest one) when the recipe needs a 3x3 grid; if you have none it crafts one from 4 planks. If ingredients are missing it fails and lists exactly what is missing. count = number of items you want (default 1). Generic: "planks" works with any log type.',
  params: obj({ item: str('item to craft, e.g. "oak_planks", "stick", "crafting_table", "wooden_pickaxe"'), count: int('how many to craft, default 1') }, ['item']),
  timeoutMs: 100000,
  async run(ctx, { item, count = 1 }) {
    const r = await craftItem(ctx, item, Math.max(1, count));
    if (!r.ok) throw new Error(r.error);
    return `Crafted ${r.crafted} ${r.name} (inventory now ${r.total}).${r.notes.length ? ' ' + r.notes.join('; ') + '.' : ''}`;
  },
});

A({
  name: 'smelt',
  description: 'Smelt items in a furnace (uses/places a furnace; crafts one from 8 cobblestone if you have none). item = the INPUT (raw_iron, iron_ore, sand, cobblestone, raw_beef, potato, any log -> charcoal...). Fuel auto-picks coal/charcoal/planks/logs or pass fuel. Waits until done (~10 s per item); if too long, returns what finished and leaves the rest cooking - call again to collect.',
  params: obj({ item: str('input item, e.g. "raw_iron"'), count: int('how many, default 1'), fuel: str('fuel item name, optional') }, ['item']),
  timeoutMs: 178000,
  async run(ctx, { item, count = 1, fuel }) { return smelt(ctx, { item, count: Math.max(1, count), fuel }); },
});

A({
  name: 'place',
  description: 'Place one block/item from your inventory at x,y,z (walks into reach). Fixes common mistakes for you: if x,y,z is the ground block itself it places on top; seeds are planted on farmland (tills dirt/grass first if you carry a hoe); saplings need dirt/grass below; beds get a facing with room for both halves; torches need a floor or wall. Use for torches, doors, chests, crafting_table, furnace, beds, seeds, saplings, single blocks (use build for many).',
  params: obj({ block: str('item/block name in inventory'), x: int('x'), y: int('y'), z: int('z') }, ['block', 'x', 'y', 'z']),
  async run(ctx, { block, x, y, z }) {
    const { result, pos, notes } = await smartPlace(ctx, block, new Vec3(x, y, z));
    const at = `${pos.x},${pos.y},${pos.z}`;
    return (result === 'already' ? `${block} is already at ${at}.` : `Placed ${block} at ${at}. (${countItem(ctx.bot, block)} left)`) + (notes.length ? ` Note: ${notes.join('; ')}.` : '');
  },
});

A({
  name: 'build',
  description: 'Place many blocks: blocks=[{x,y,z,block}]. Sorted bottom-up automatically (so supports go first) and nearest-first within a layer; walks as needed. Blocks that cannot attach yet are retried after others. Reports placed count and each failure. Make sure you carry enough blocks (check shortage line).',
  params: obj({ blocks: { type: 'array', description: 'blocks to place', items: obj({ x: int('x'), y: int('y'), z: int('z'), block: str('block name') }, ['x', 'y', 'z', 'block']) } }, ['blocks']),
  timeoutMs: 178000,
  async run(ctx, { blocks }) {
    const { bot } = ctx;
    if (!Array.isArray(blocks) || !blocks.length) throw new Error('blocks must be a non-empty array of {x,y,z,block}.');
    const need = new Map();
    for (const b of blocks) need.set(b.block, (need.get(b.block) || 0) + 1);
    const short = [];
    for (const [n, c] of need) { const h = countItem(bot, n); if (h < c) short.push(`${n}: need ${c}, have ${h}`); }
    let queue = blocks.map((b) => ({ ...b, x: Math.floor(b.x), y: Math.floor(b.y), z: Math.floor(b.z) })).sort((a, b) => a.y - b.y);
    // nearest-neighbour within layers
    const ordered = [];
    let cur = bot.entity.position;
    const layers = new Map();
    for (const b of queue) { if (!layers.has(b.y)) layers.set(b.y, []); layers.get(b.y).push(b); }
    for (const y of [...layers.keys()].sort((a, b) => a - b)) {
      const rest = layers.get(y);
      while (rest.length) {
        let bi = 0, bd = Infinity;
        rest.forEach((b, i) => { const d = Math.abs(b.x - cur.x) + Math.abs(b.z - cur.z); if (d < bd) { bd = d; bi = i; } });
        const [b] = rest.splice(bi, 1);
        ordered.push(b); cur = new Vec3(b.x, b.y, b.z);
      }
    }
    queue = ordered;
    const dl = ctx.deadline(165000);
    let placed = 0, already = 0;
    let failures = [];
    for (let pass = 0; pass < 3 && queue.length; pass++) {
      const next = [];
      for (const b of queue) {
        await ctx.checkpoint();
        if (dl.expired()) { next.push({ ...b, why: 'ran out of time' }); continue; }
        try {
          const r = await placeBlockAt(ctx, b.block, new Vec3(b.x, b.y, b.z));
          if (r === 'already') already++; else placed++;
        } catch (e) {
          if (isStop(e)) throw e;
          next.push({ ...b, why: e.message });
        }
      }
      if (next.length === queue.length) { failures = next; queue = []; break; }
      queue = next; failures = next;
    }
    if (!queue.length && failures.length && failures.length === 0) failures = [];
    const fl = failures.slice(0, 8).map((b) => `(${b.x},${b.y},${b.z}) ${b.block}: ${String(b.why).slice(0, 110)}`);
    let msg = `Placed ${placed}/${blocks.length}${already ? ` (+${already} already in place)` : ''}.`;
    if (failures.length) msg += ` ${failures.length} failed:\n${fl.join('\n')}${failures.length > 8 ? '\n…' : ''}`;
    if (short.length) msg += `\nShortage: ${short.join('; ')}`;
    return msg;
  },
});

const SLOTS = { hand: 'hand', 'off-hand': 'off-hand', offhand: 'off-hand', head: 'head', torso: 'torso', chest: 'torso', legs: 'legs', feet: 'feet' };
A({
  name: 'equip',
  description: 'Equip an item from inventory: tools/weapons to hand, armor to the right slot automatically, shield to off-hand. slot optional: hand, off-hand, head, torso, legs, feet.',
  params: obj({ item: str('item name, e.g. "iron_sword", "iron_chestplate"'), slot: str('optional slot', { enum: ['hand', 'off-hand', 'head', 'torso', 'legs', 'feet'] }) }, ['item']),
  quick: false,
  async run(ctx, { item, slot }) {
    const { bot, mcData } = ctx;
    const m = itemMatcher(mcData, item);
    const it = bot.inventory.items().find((i) => m(i.name));
    if (!it) throw new Error(`You don't have ${item}. Inventory: ${invSummary(bot)}.`);
    let dest = slot ? SLOTS[slot] : 'hand';
    if (!slot) {
      if (/_helmet$/.test(it.name) || it.name === 'turtle_helmet') dest = 'head';
      else if (/_chestplate$|^elytra$/.test(it.name)) dest = 'torso';
      else if (/_leggings$/.test(it.name)) dest = 'legs';
      else if (/_boots$/.test(it.name)) dest = 'feet';
      else if (it.name === 'shield') dest = 'off-hand';
    }
    await ctx.race(bot.equip(it, dest));
    return `Equipped ${it.name} in ${dest}.`;
  },
});

A({
  name: 'eat',
  description: 'Eat food now. item optional (default: best food in inventory). Fails if you are not hungry or carry no food.',
  params: obj({ item: str('food item name, optional') }),
  async run(ctx, { item }) {
    const { bot, mcData } = ctx;
    const foods = bot.inventory.items().filter((i) => mcData.foodsByName[i.name]);
    if (!foods.length) throw new Error('No food in inventory. Kill animals (attack cow/pig/chicken/sheep -> cook with smelt), pick sweet berries, or ask teammates.');
    if (bot.food >= 20) throw new Error('Not hungry (food 20/20).');
    const before = bot.food;
    const pick = item ? foods.find((f) => f.name === item) : null;
    if (item && !pick) throw new Error(`You have no ${item}. Food you carry: ${foods.map((f) => `${f.name} x${f.count}`).join(', ')}`);
    // auto_eat may already be eating: wait for it instead of failing with "Already eating!"
    const busyEating = () => bot.autoEat?.isEating || bot.autoEat?._eating || false;
    for (let i = 0; i < 40 && busyEating(); i++) await sleep(100, ctx.signal);
    try {
      await ctx.race(bot.autoEat.eat(pick ? { food: pick.name } : {}));
    } catch (e) {
      if (isStop(e)) throw e;
      if (/already eating/i.test(e.message)) await sleep(2000, ctx.signal);
      else {
        // auto-eat refuses some foods (rotten_flesh, spider_eye...) or finds "no choice": eat directly
        const order = (f) => (/rotten_flesh|spider_eye|poisonous_potato|pufferfish|suspicious_stew/.test(f.name) ? 10 : 0) - (mcData.foodsByName[f.name]?.foodPoints || 0) / 10;
        const f = pick || foods.slice().sort((a, b) => order(a) - order(b))[0];
        await ctx.race(bot.equip(f, 'hand'));
        try { await ctx.race(bot.consume()); } catch (e2) { if (isStop(e2)) throw e2; throw new Error(`Could not eat ${f.name}: ${e2.message}`); }
      }
    }
    return `Ate ${pick?.name || 'food'}; food ${before} -> ${bot.food}.`;
  },
});

A({
  name: 'attack',
  description: 'Fight a mob type (e.g. "zombie", "skeleton", "cow", "pig") or a player by name. Equips your best sword/axe, chases and hits until it dies. count = how many to kill (default 1). Use "hostile" for the nearest hostile mob. Stops if your health gets low (<5).',
  params: obj({ target: str('mob type or player name, or "hostile"'), count: int('how many kills, default 1') }, ['target']),
  timeoutMs: 175000,
  async run(ctx, { target, count = 1 }) {
    const { bot, h } = ctx;
    const tl = String(target).toLowerCase().trim();
    if (PASSIVE.has(tl) || tl === 'animal' || tl === 'food') {
      const r = await huntMany(ctx, tl, Math.max(1, count), { maxMs: 160000 });
      if (r.kills === 0 && !r.fails.length) {
        const near = h.nearbyEntities(64, 8).filter((x) => x.type !== 'item').map((x) => `${x.name} ${x.distance}m`);
        throw new Error(`No "${target}" within 64 blocks. Nearby: ${near.join(', ') || 'nothing'}. Walk 60+ blocks into open grassland and try hunt again.`);
      }
      let msg = `Killed ${r.kills}/${count} ${target}.${r.gained ? ` Picked up: ${r.gained}.` : ''}`;
      if (r.stopped) msg += ` Stopped: ${r.stopped}.`;
      if (r.fails.length) msg += ` Got away / unreachable: ${r.fails.slice(0, 3).join('; ')}.`;
      return `${msg} Health ${r1(bot.health)}/20.`;
    }
    let kills = 0, lostTries = 0;
    const dl = ctx.deadline(165000);
    const startHp = bot.health;
    while (kills < count && !dl.expired()) {
      await ctx.checkpoint();
      let e;
      if (target === 'hostile') {
        const n = h._nearestHostile(48); e = n?.e;
      } else e = findEntityByName(bot, target, 48);
      if (!e) {
        if (kills > 0) break;
        const near = h.nearbyEntities(48, 8).filter((x) => x.type !== 'item').map((x) => `${x.name} ${x.distance}m`);
        throw new Error(`No "${target}" within 48 blocks. Nearby: ${near.join(', ') || 'nothing'}.${Date.now() - h.lastAutoAt < 15000 ? ' (self-defense may have just killed it)' : ''}`);
      }
      const reason = await fight(ctx, e, { maxMs: 40000, minHealth: 5 });
      if (reason === 'dead') { kills++; await sleep(300, ctx.signal); await pickupItems(ctx, { radius: 6, maxMs: 3000 }).catch(() => {}); }
      else if (reason === 'low_health') return `Stopped fighting: health ${r1(bot.health)}/20. Killed ${kills}/${count} ${target}. Retreat, eat or heal before re-engaging.`;
      else if (reason === 'timeout' || reason === 'lost') { if (++lostTries >= 4) { if (kills === 0) throw new Error(`Could not finish ${target} (${reason}); it ${reason === 'lost' ? 'got more than 24 blocks away' : 'could not be reached in time'} (at ${e?.position ? fmtPos(e.position) : '?'}). Use nearest to check the path, or let it come to you (hostiles approach on their own).`); break; } }
    }
    return `Killed ${kills}/${count} ${target}. Health ${r1(bot.health)}/20 (was ${r1(startHp)}). Inventory: ${invSummary(bot)}.`;
  },
});

A({
  name: 'give',
  description: 'Walk to a player/teammate and toss items to them. count defaults to 1 (0 = all you have of that item). The receiver should stand still nearby; their bot picks items up automatically when idle.',
  params: obj({ player: str('recipient name'), item: str('item name (generic ok, e.g. "log")'), count: int('how many, default 1; 0 = all') }, ['player', 'item']),
  async run(ctx, { player, item, count = 1 }) {
    const { bot, mcData, h } = ctx;
    const m = itemMatcher(mcData, item);
    const stacks = bot.inventory.items().filter((i) => m(i.name));
    if (!stacks.length) throw new Error(`You don't have ${item}. Inventory: ${invSummary(bot)}.`);
    const total = stacks.reduce((a, i) => a + i.count, 0);
    let want = count <= 0 ? total : Math.min(count, total);
    for (let i = 0; i < 4; i++) {
      const e = playerEntity(bot, player);
      if (!e) throw playerNotVisible(bot, player);
      if (e.position.distanceTo(bot.entity.position) <= 2.6) break;
      await gotoGoal(ctx, new goals.GoalNear(e.position.x, e.position.y, e.position.z, 2), { maxMs: 90000, what: `player ${player}` });
    }
    const e = playerEntity(bot, player);
    if (!e) throw playerNotVisible(bot, player);
    await ctx.race(bot.lookAt(e.position.offset(0, 1.5, 0), true));
    h.tossZone = { pos: bot.entity.position.clone(), until: Date.now() + 25000 };
    let given = 0; const names = new Set();
    for (const st of stacks) {
      if (want <= 0) break;
      const n = Math.min(want, bot.inventory.count(st.type));
      await ctx.race(bot.toss(st.type, null, n));
      given += n; want -= n; names.add(st.name);
      await sleep(150, ctx.signal);
    }
    await sleep(600, ctx.signal);
    await stepAway(ctx, e.position, 3);
    return `Tossed ${given} ${[...names].join('/')} toward ${player} (at ${fmtPos(e.position)}, ${r1(e.position.distanceTo(bot.entity.position))} blocks away). They need to be nearby to pick it up; ask them to check inventory.`;
  },
});

A({
  name: 'drop',
  description: 'Drop items on the ground (toss). count defaults to 1; 0 = all of that item. Items you drop are not auto-picked up by you.',
  params: obj({ item: str('item name (generic ok)'), count: int('how many, default 1; 0 = all') }, ['item']),
  async run(ctx, { item, count = 1 }) {
    const { bot, mcData, h } = ctx;
    const m = itemMatcher(mcData, item);
    const stacks = bot.inventory.items().filter((i) => m(i.name));
    if (!stacks.length) throw new Error(`You don't have ${item}. Inventory: ${invSummary(bot)}.`);
    let want = count <= 0 ? stacks.reduce((a, i) => a + i.count, 0) : count;
    const where = bot.entity.position.clone();
    h.tossZone = { pos: where, until: Date.now() + 25000 };
    let dropped = 0;
    for (const st of stacks) {
      if (want <= 0) break;
      const n = Math.min(want, bot.inventory.count(st.type));
      await ctx.race(bot.toss(st.type, null, n));
      dropped += n; want -= n;
      await sleep(100, ctx.signal);
    }
    await sleep(500, ctx.signal);
    await stepAway(ctx, where, 4);
    return `Dropped ${dropped} ${item} at ${fmtPos(where)} (stepped away; pick them up again with goto + wait if you want them back).`;
  },
});

// ---------- containers ----------
const CONTAINER_RE = /^(chest|trapped_chest|barrel|ender_chest|(.*_)?shulker_box)$/;
async function openContainerAt(ctx, x, y, z) {
  const { bot } = ctx;
  const pos = new Vec3(x, y, z);
  const blk = bot.blockAt(pos);
  if (!blk) throw new Error(`Block at ${x},${y},${z} is not loaded; goto closer first.`);
  if (!CONTAINER_RE.test(blk.name)) {
    const near = bot.findBlocks({ matching: [bot.registry.blocksByName.chest.id, bot.registry.blocksByName.barrel.id], maxDistance: 24, count: 4 }).map((p) => `${p.x},${p.y},${p.z}`);
    throw new Error(`Block at ${x},${y},${z} is ${blk.name}, not a chest/barrel.${near.length ? ' Containers nearby: ' + near.join(' | ') : ' No containers nearby: place one (craft chest from 8 planks).'}`);
  }
  if (bot.entity.position.distanceTo(pos.offset(0.5, 0.5, 0.5)) > 3.8) await gotoPos(ctx, pos, 3, { maxMs: 60000 });
  for (let attempt = 0; ; attempt++) {
    try {
      await ctx.race(bot.lookAt(pos.offset(0.5, 0.5, 0.5), true)).catch(() => {});
      const win = await ctx.race(bot.openContainer(bot.blockAt(pos)));
      try { rememberChest(bot, pos, win); } catch { /* best effort */ }
      return win;
    } catch (e) {
      if (isStop(e) || attempt >= 1) {
        if (!isStop(e) && /windowOpen/.test(e.message)) {
          const above = bot.blockAt(pos.offset(0, 1, 0));
          throw new Error(`The ${blk.name} at ${x},${y},${z} did not open${above && isSolid(above) ? ` — the block above it (${above.name}) blocks the lid; mine_block it` : ' (server did not answer; try again from right next to it)'}.`);
        }
        throw e;
      }
      try { if (bot.currentWindow) bot.closeWindow(bot.currentWindow); } catch { /* */ }
      await gotoPos(ctx, pos, 2, { maxMs: 20000 }).catch((e2) => { if (isStop(e2)) throw e2; });
      await sleep(400, ctx.signal);
    }
  }
}
function chestContents(win) {
  const m = new Map();
  for (const it of win.containerItems()) m.set(it.name, (m.get(it.name) || 0) + it.count);
  return m;
}
const fmtMap = (m) => [...m].map(([n, c]) => `${n} x${c}`).join(', ') || 'empty';

A({
  name: 'chest_view',
  description: 'Open the chest/barrel at x,y,z (walks there) and list its contents and free slots.',
  params: obj({ x: int('x'), y: int('y'), z: int('z') }, ['x', 'y', 'z']),
  async run(ctx, { x, y, z }) {
    const win = await openContainerAt(ctx, x, y, z);
    try {
      const c = chestContents(win);
      const free = win.containerItems().length;
      return `Chest at ${x},${y},${z}: ${fmtMap(c)}. (${win.slots.length - 36 - free} free slots)`;
    } finally { try { win.close(); } catch { /* */ } }
  },
});

A({
  name: 'chest_deposit',
  description: 'Put items into the chest/barrel at x,y,z. items optional: list of {name,count?} (generic names ok). If omitted, deposits everything except tools, weapons, armor, food and torches. Use this to share resources with the team (the base chest).',
  params: obj({ x: int('x'), y: int('y'), z: int('z'), items: { type: 'array', description: 'optional [{name,count?}]', items: obj({ name: str('item'), count: int('how many (omit = all)') }, ['name']) } }, ['x', 'y', 'z']),
  async run(ctx, { x, y, z, items }) {
    const { bot, mcData } = ctx;
    const win = await openContainerAt(ctx, x, y, z);
    const done = []; const failed = [];
    try {
      let jobs = [];
      if (Array.isArray(items) && items.length) {
        for (const spec of items) {
          const name = typeof spec === 'string' ? spec : spec.name;
          const m = itemMatcher(mcData, name);
          const stacks = bot.inventory.items().filter((i) => m(i.name));
          if (!stacks.length) { failed.push(`${name}: not in inventory`); continue; }
          let want = typeof spec === 'object' && spec.count ? spec.count : Infinity;
          for (const st of stacks) { if (want <= 0) break; const n = Math.min(want, bot.inventory.count(st.type)); jobs.push({ st, n }); want -= n; }
        }
      } else {
        const seen = new Set();
        for (const st of bot.inventory.items()) {
          if (seen.has(st.type)) continue; seen.add(st.type);
          if (TOOL_RE.test(st.name) || ARMOR_RE.test(st.name) || mcData.foodsByName[st.name]) continue;
          jobs.push({ st, n: bot.inventory.count(st.type) });
        }
      }
      for (const { st, n } of jobs) {
        try { await ctx.race(win.deposit(st.type, null, n)); done.push(`${st.name} x${n}`); }
        catch (e) { if (isStop(e)) throw e; failed.push(`${st.name}: ${e.message.slice(0, 60)}`); }
      }
      return `Deposited into ${x},${y},${z}: ${done.join(', ') || 'nothing'}.${failed.length ? ' Could not: ' + failed.join('; ') + '. (chest may be full)' : ''} Chest now: ${fmtMap(chestContents(win))}.`;
    } finally { try { win.close(); } catch { /* */ } }
  },
});

A({
  name: 'chest_withdraw',
  description: 'Take items out of the chest/barrel at x,y,z. items = [{name,count}] (generic names ok). Fails listing the chest contents if something is not there.',
  params: obj({ x: int('x'), y: int('y'), z: int('z'), items: { type: 'array', description: '[{name,count}]', items: obj({ name: str('item'), count: int('how many, default 1') }, ['name']) } }, ['x', 'y', 'z', 'items']),
  async run(ctx, { x, y, z, items }) {
    const { bot, mcData } = ctx;
    if (!Array.isArray(items) || !items.length) throw new Error('items must be [{name,count}]. Use chest_view first to see contents.');
    const win = await openContainerAt(ctx, x, y, z);
    const got = []; const failed = [];
    try {
      for (const spec of items) {
        const name = typeof spec === 'string' ? spec : spec.name;
        let want = typeof spec === 'object' && spec.count ? spec.count : 1;
        const m = itemMatcher(mcData, name);
        const stacks = win.containerItems().filter((i) => m(i.name));
        if (!stacks.length) { failed.push(`${name}: not in chest`); continue; }
        for (const st of stacks) {
          if (want <= 0) break;
          const have = win.containerCount(st.type);
          const n = Math.min(want, have);
          try { await ctx.race(win.withdraw(st.type, null, n)); got.push(`${st.name} x${n}`); want -= n; }
          catch (e) { if (isStop(e)) throw e; failed.push(`${st.name}: ${e.message.slice(0, 60)}`); break; }
        }
      }
      return `Withdrew: ${got.join(', ') || 'nothing'}.${failed.length ? ' Problems: ' + failed.join('; ') + '.' : ''} Chest now: ${fmtMap(chestContents(win))}. Inventory: ${invSummary(bot)}.`;
    } finally { try { win.close(); } catch { /* */ } }
  },
});

A({
  name: 'sleep',
  description: 'Sleep in the nearest bed (within 48 blocks; walks to it). Only possible at night (tick 12542-23460) or during thunderstorms. Crafts nothing: you need a bed (3 wool + 3 planks) placed somewhere. Skips the night and sets respawn point.',
  params: obj({}),
  timeoutMs: 120000,
  async run(ctx) {
    const { bot } = ctx;
    const t = bot.time.timeOfDay;
    const isNight = t >= 12542 && t < 23460;
    if (!isNight && !bot.isRaining) throw new Error(`Can't sleep now (tick ${t}); beds only work at night (tick 12542-23460) or in thunderstorms. Do something else until night.`);
    const beds = bot.findBlocks({ matching: (b) => /_bed$/.test(b.name), maxDistance: 48, count: 24 })
      .map((p) => bot.blockAt(p)).filter((b) => b && (b.getProperties?.().part ?? 'head') === 'head')
      .sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position));
    if (!beds.length) throw new Error('No bed within 48 blocks. Craft one (3 wool of one color + 3 planks, needs crafting table), place it (place picks a valid spot and facing), then sleep.');
    const errs = [];
    let slept = false;
    for (const bed of beds.slice(0, 5)) {
      const occ = bed.getProperties?.().occupied;
      if (occ === true || occ === 'true') { errs.push(`${fmtPos(bed.position)} occupied`); continue; }
      try {
        await gotoPos(ctx, bed.position, 2, { maxMs: 45000 });
        for (let k = 0; k < 2 && !slept; k++) {
          try { await ctx.race(bot.sleep(bot.blockAt(bed.position))); slept = true; } catch (e) {
            if (isStop(e)) throw e;
            if (/not sleeping/i.test(e.message)) { await sleep(800, ctx.signal); if (bot.isSleeping) slept = true; continue; }
            if (/monsters|unsafe/i.test(e.message)) throw new Error(`Could not sleep: monsters nearby (${e.message}). Kill them or wall yourself in, then retry.`);
            errs.push(`${fmtPos(bed.position)}: ${e.message}`); break;
          }
        }
      } catch (e) { if (isStop(e)) throw e; if (/^Could not sleep: monsters/.test(e.message)) throw e; errs.push(`${fmtPos(bed.position)}: ${e.message.slice(0, 80)}`); }
      if (slept) break;
    }
    if (!slept) throw new Error(`Could not sleep in any of ${Math.min(beds.length, 5)} nearby beds (${errs.join('; ')}). A bed is occupied when a teammate uses it: place your own bed next to it (place white_bed ...), then sleep.`);
    const t0 = Date.now();
    try {
      while (bot.isSleeping && Date.now() - t0 < 60000) await sleep(500, ctx.signal);
    } finally { if (bot.isSleeping) { try { await bot.wake(); } catch { /* */ } } }
    return `Slept; time is now tick ${bot.time.timeOfDay}. Respawn point set to the bed.`;
  },
});

A({
  name: 'set_mode',
  description: `Toggle an automatic behavior. Modes: ${MODE_NAMES.join(', ')}. self_defense fights hostile mobs that come close; auto_eat eats when hungry; pickup_items collects nearby dropped items when idle; unstuck frees you when pathing stalls; avoid_hazards escapes lava/fire/drowning.`,
  params: obj({ mode: str('mode name', { enum: MODE_NAMES }), on: { type: 'boolean', description: 'true = enable, false = disable' } }, ['mode', 'on']),
  quick: true,
  async run(ctx, { mode, on }) { return ctx.h.setMode(mode, on); },
});

A({
  name: 'wait',
  description: 'Do nothing for N seconds (max 120). Auto modes (defense, eating, pickup) still work. Use sparingly, e.g. while waiting for a teammate.',
  params: obj({ seconds: int('seconds, 1-120') }, ['seconds']),
  timeoutMs: 125000,
  async run(ctx, { seconds }) {
    const s = Math.min(Math.max(seconds, 1), 120);
    await ctx.sleep(s * 1000);
    return `Waited ${s}s.`;
  },
});

A({
  name: 'stop',
  description: 'Cancel whatever you are doing right now (walking, mining, following, fighting) and stand still.',
  params: obj({}),
  quick: true,
  async run(ctx) {
    const h = ctx.h;
    const what = h.current?.name || h.bg?.name || null;
    h.stop();
    return what ? `Stopped ${what}.` : 'Nothing was running.';
  },
});

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
A({
  name: 'run_code',
  description: 'ESCAPE HATCH: run an async JavaScript function body with `bot` (mineflayer), `Vec3`, `goals` (pathfinder goals), `mcData`, `log(...)` and `sleep(ms)` in scope. 60 s time limit; stops when aborted. Return value and everything you log() are returned. Example: `const b = bot.findBlock({matching: mcData.blocksByName.chest.id, maxDistance: 20}); log(b?.position); await bot.pathfinder.goto(new goals.GoalNear(b.position.x,b.position.y,b.position.z,2));`. Prefer the normal actions; use this for things they cannot do.',
  params: obj({ code: str('async function body') }, ['code']),
  timeoutMs: 60000,
  async run(ctx, { code }) {
    const { bot, mcData } = ctx;
    const out = [];
    const log = (...a) => out.push(a.map((x) => (typeof x === 'string' ? x : (() => { try { return JSON.stringify(x); } catch { return String(x); } })())).join(' '));
    let fn;
    try { fn = new AsyncFunction('bot', 'Vec3', 'goals', 'mcData', 'log', 'sleep', 'signal', code); }
    catch (e) { throw new Error(`Syntax error in code: ${e.message}`); }
    let ret;
    try { ret = await ctx.race(fn(bot, Vec3, goals, mcData, log, (ms) => sleep(ms, ctx.signal), ctx.signal)); }
    catch (e) { if (isStop(e)) throw e; throw new Error(`run_code error: ${e?.message || e}${out.length ? '\nlogs so far: ' + out.join(' | ') : ''}`); }
    let s = out.join('\n');
    if (ret !== undefined) { let r; try { r = typeof ret === 'string' ? ret : JSON.stringify(ret); } catch { r = String(ret); } s += (s ? '\n' : '') + `=> ${r}`; }
    return (s || 'Done (no output).').slice(0, 4000);
  },
});

A({
  name: 'craft_plan',
  description: 'Plan a craft BEFORE gathering: resolves the full recipe tree for item x count against your inventory (and chests you opened this session), shows each intermediate step (logs -> planks -> sticks ...), marks what you already have, and lists exactly which raw materials are still missing with where to get them (mine X with tool Y, smelt Z, kill cow, chest at x,y,z has N). Does not move or craft.',
  params: obj({ item: str('item to make, e.g. "iron_pickaxe", "bed", "torch"'), count: int('how many, default 1') }, ['item']),
  quick: true,
  async run(ctx, { item, count = 1 }) { return craftPlan(ctx, item, Math.max(1, count)); },
});

for (const d of ROBUST_ACTIONS) A(d);

// ---------- teammates' action files (tolerant: the engine still starts if a file is missing or broken) ----------
async function importActions(file, names) {
  try {
    const m = await import(file);
    for (const n of names) if (Array.isArray(m[n])) return m[n];
    if (Array.isArray(m.default)) return m.default;
    console.error(`[engine] ${file} has none of the exports ${names.join('/')}; skipped`);
  } catch (e) {
    if (e?.code !== 'ERR_MODULE_NOT_FOUND' || !String(e.message).includes(file.replace('./', ''))) console.error(`[engine] could not load ${file}: ${e?.message || e}`);
  }
  return [];
}
const EXTRA = [
  ...(await importActions('./actions-viewer.js', ['VIEWER_ACTIONS', 'ACTIONS'])),
  ...(await importActions('./actions-build.js', ['BUILD_ACTIONS', 'ACTIONS'])),
];
for (const d of EXTRA) {
  if (!d || typeof d.name !== 'string' || typeof d.run !== 'function') { console.error('[engine] skipped a malformed action def', d?.name); continue; }
  const i = ACTION_DEFS.findIndex((x) => x.name === d.name);
  if (i >= 0) { console.error(`[engine] action "${d.name}" from a teammate file replaces the built-in one`); ACTION_DEFS[i] = d; } else A(d);
}

export const ACTION_MAP = new Map(ACTION_DEFS.map((a) => [a.name, a]));
export { sleepMs, resolveItemNames, isHostile, itemEntities, droppedItemName, isReplaceable, findPlaceRef, nearGoal, findBlockNear, halt };
