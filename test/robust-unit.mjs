// OFFLINE unit checks for the robustness code (no Minecraft server): a fake bot over an in-memory block map.
//   node test/robust-unit.mjs
import './neutral-player.mjs'; // neutral human player (Robin / robin_mc), live ports blocked
import { Vec3 } from 'vec3';
import registryLoader from 'prismarine-registry';
import blockLoader from 'prismarine-block';
import recipeLoader from 'prismarine-recipe';
import { walkableArea, skyAbove, pillarItem, lookAroundText, ROBUST_ACTIONS } from '../bridge/engine/actions-robust.js';
import { diagnose, placeBlockAt, smartPlace } from '../bridge/engine/nav.js';
import { craftPlan, craftItem } from '../bridge/engine/craft.js';
import { placedBlockNames, roomFor, handDiggable, dirName, fullInventoryHint } from '../bridge/engine/util.js';
import { ACTIONS } from '../bridge/engine/index.js';

const VERSION = '1.21.1';
const registry = registryLoader(VERSION);
const Block = blockLoader(registry);
const Recipe = recipeLoader(registry).Recipe;
let pass = 0, fail = 0;
const ok = (c, m, extra = '') => { if (c) { pass++; console.log(`PASS  ${m}`); } else { fail++; console.log(`FAIL  ${m}${extra ? ' :: ' + String(extra).replace(/\n/g, ' | ').slice(0, 600) : ''}`); } };

function fakeBot({ blocks, pos, items = [] }) {
  const key = (p) => `${p.x},${p.y},${p.z}`;
  const map = new Map();
  const bot = {
    registry, username: 'Unit', entities: {}, players: {}, time: { timeOfDay: 6000, isDay: true }, health: 20, food: 20, isRaining: false,
    entity: { position: new Vec3(pos.x + 0.5, pos.y, pos.z + 0.5), onGround: true, isInWater: false, height: 1.8 },
    setBlock(p, name) { map.set(key(p), name); },
    blockAt(p) {
      const v = new Vec3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z));
      if (Math.abs(v.x) > 64 || Math.abs(v.z) > 64) return null; // "unloaded"
      const name = map.get(key(v)) || (v.y < 60 ? 'stone' : 'air');
      const b = Block.fromStateId(registry.blocksByName[name].defaultState, 0);
      b.position = v; b.light = 15; b.skyLight = 15;
      return b;
    },
    findBlock({ matching, maxDistance = 16, point }) { return bot.findBlocks({ matching, maxDistance, point, count: 1 }).map((p) => bot.blockAt(p))[0] || null; },
    findBlocks({ matching, maxDistance = 16, count = 1, point }) {
      const c = (point || bot.entity.position).floored(); const out = [];
      const test = (b) => (typeof matching === 'function' ? matching(b) : Array.isArray(matching) ? matching.includes(b.type) : b.type === matching);
      const R = Math.min(maxDistance, 12);
      for (let dx = -R; dx <= R; dx++) for (let dy = -R; dy <= R; dy++) for (let dz = -R; dz <= R; dz++) {
        const p = c.offset(dx, dy, dz); const b = bot.blockAt(p); if (b && test(b)) out.push(p);
      }
      return out.sort((a, b) => a.distanceTo(c) - b.distanceTo(c)).slice(0, count);
    },
    inventory: {
      _items: items.map((it, i) => ({ ...it, type: registry.itemsByName[it.name].id, slot: 9 + i, stackSize: registry.itemsByName[it.name].stackSize })),
      items() { return this._items; },
      emptySlotCount() { return 36 - this._items.length; },
      count(id) { return this._items.filter((i) => i.type === id).reduce((a, i) => a + i.count, 0); },
      slots: [],
    },
    recipesAll(id, meta, table) { return Recipe.find(id, meta).filter((r) => !r.requiresTable || table); },
    pathfinder: { movements: null },
  };
  for (const [p, n] of blocks || []) bot.setBlock(p, n);
  return bot;
}
const h = { nearbyBlocks: () => ({}), nearbyEntities: () => [] };
const ctxOf = (bot) => ({ bot, mcData: registry, h, signal: new AbortController().signal, race: (p) => p, sleep: () => Promise.resolve(), throwIfAborted() {}, checkpoint: async () => {}, deadline: (ms) => { const end = Date.now() + ms; return { left: () => end - Date.now(), expired: () => Date.now() >= end }; } });
const flat = (y = 63, top = 'grass_block', r = 20) => { const l = []; for (let x = -r; x <= r; x++) for (let z = -r; z <= r; z++) for (let yy = 60; yy <= y; yy++) l.push([new Vec3(x, yy, z), yy === y ? top : 'dirt']); return l; };

// ---- registry / MCP-facing shape ----
const names = ACTIONS.map((a) => a.name);
ok(['escape', 'hunt', 'look_around', 'nearest', 'inventory', 'blocks_at', 'use_block', 'use_item', 'craft_plan'].every((n) => names.includes(n)), `new actions in ACTIONS (${names.length} total)`);
ok(!ACTIONS.some((a) => a.name.startsWith('_')), 'internal defs hidden from ACTIONS');
ok(ROBUST_ACTIONS.every((a) => a.description.length > 80 && a.params?.type === 'object'), 'robust actions have descriptions + object schemas');

// ---- util ----
ok(placedBlockNames('wheat_seeds')[0] === 'wheat' && placedBlockNames('torch').includes('wall_torch') && placedBlockNames('oak_sign').includes('oak_wall_sign'), 'item -> placed block names');
ok(dirName(0, -5) === 'north' && dirName(5, 0) === 'east' && dirName(-3, 3) === 'south-west', 'compass directions');
const bFull = fakeBot({ pos: { x: 0, y: 64, z: 0 }, items: Array.from({ length: 36 }, (_, i) => ({ name: i === 0 ? 'oak_planks' : 'dirt', count: i === 0 ? 60 : 64 })) });
ok(roomFor(bFull, 'oak_planks', 4) && !roomFor(bFull, 'stick', 1), 'roomFor: partial stack has room, new item has none');
ok(/FULL/.test(fullInventoryHint(bFull)), 'full inventory hint');
const blk = (n) => { const b = Block.fromStateId(registry.blocksByName[n].defaultState, 0); return b; };
ok(handDiggable(blk('dirt')) && handDiggable(blk('oak_leaves')) && handDiggable(blk('gravel')) && !handDiggable(blk('stone')) && !handDiggable(blk('obsidian')), 'handDiggable');

// ---- terrain reasoning ----
{
  const bot = fakeBot({ blocks: flat(), pos: { x: 0, y: 64, z: 0 } });
  const a = walkableArea(bot, { limit: 400, farDist: 8 });
  ok(a.free && skyAbove(bot, new Vec3(0, 64, 0)), 'flat ground: free + sky', JSON.stringify(a));
}
{
  const l = flat(); for (let y = 60; y <= 63; y++) l.push([new Vec3(0, y, 0), 'air']); // 4-deep 1x1 pit, bot at the bottom (y 60)
  const bot = fakeBot({ blocks: l, pos: { x: 0, y: 60, z: 0 } });
  const a = walkableArea(bot, { limit: 400, farDist: 8 });
  ok(!a.free && a.cells <= 2, 'deep pit: not free', JSON.stringify(a));
  const d = diagnose(bot, new Vec3(20, 64, 20));
  ok(/boxed in|underground/.test(d) && /escape/.test(d), 'diagnose pit -> suggests escape', d);
  const la = lookAroundText(ctxOf(bot));
  ok(/TRAPPED|Small space/.test(la) && /north: wall/.test(la), 'look_around reports trapped + walls', la);
}
{
  const l = flat(); l.push([new Vec3(0, 63, 0), 'air'], [new Vec3(0, 62, 0), 'air']); // 2-deep: still a dip, can't step out (needs 1)
  const bot = fakeBot({ blocks: l, pos: { x: 0, y: 62, z: 0 } });
  ok(!walkableArea(bot, { limit: 400, farDist: 8 }).free, '2-deep pit is not walkable out');
  const l2 = flat(); l2.push([new Vec3(0, 63, 0), 'air']);
  const bot2 = fakeBot({ blocks: l2, pos: { x: 0, y: 63, z: 0 } });
  ok(walkableArea(bot2, { limit: 400, farDist: 8 }).free, '1-deep dip is walkable out');
}
{
  const bot = fakeBot({ blocks: flat(), pos: { x: 0, y: 64, z: 0 } });
  const l = []; for (let x = 3; x <= 5; x++) for (let y = 64; y <= 67; y++) for (let z = -5; z <= 5; z++) l.push([new Vec3(x, y, z), 'stone']);
  for (const [p, n] of l) bot.setBlock(p, n);
  const d = diagnose(bot, new Vec3(30, 64, 0));
  ok(/wall \(stone\)/.test(d) && /east/.test(d), 'diagnose: wall to the east', d);
  const bot2 = fakeBot({ blocks: flat(), pos: { x: 0, y: 64, z: 0 } });
  ok(/not loaded/.test(diagnose(bot2, new Vec3(300, 64, 0))), 'diagnose: unloaded chunks', diagnose(bot2, new Vec3(300, 64, 0)));
  const l3 = flat(); for (let x = 2; x <= 4; x++) for (let z = -3; z <= 3; z++) for (let y = 57; y <= 63; y++) l3.push([new Vec3(x, y, z), 'air']);
  const bot3 = fakeBot({ blocks: l3, pos: { x: 0, y: 64, z: 0 } });
  ok(/drop/.test(diagnose(bot3, new Vec3(30, 64, 0))), 'diagnose: cliff/ravine ahead', diagnose(bot3, new Vec3(30, 64, 0)));
}
{
  const bot = fakeBot({ pos: { x: 0, y: 64, z: 0 }, items: [{ name: 'diamond_block', count: 3 }, { name: 'oak_log', count: 5 }, { name: 'andesite', count: 2 }] });
  ok(pillarItem(bot)?.name === 'andesite', 'pillarItem prefers cheap blocks, never diamond_block/logs');
  const bot2 = fakeBot({ pos: { x: 0, y: 64, z: 0 }, items: [{ name: 'diamond_block', count: 3 }, { name: 'oak_log', count: 5 }] });
  ok(pillarItem(bot2) === null, 'pillarItem: nothing acceptable -> null');
}

// ---- placement decisions (errors before any movement) ----
{
  const bot = fakeBot({ blocks: flat(), pos: { x: 0, y: 64, z: 0 }, items: [{ name: 'wheat_seeds', count: 3 }] });
  try { await smartPlace(ctxOf(bot), 'wheat_seeds', new Vec3(2, 63, 2)); ok(false, 'seeds without hoe should fail'); } catch (e) { ok(/farmland/.test(e.message) && /wooden_hoe/.test(e.message), 'seeds without hoe -> farmland + hoe hint', e.message); }
  const bot2 = fakeBot({ blocks: [...flat(), [new Vec3(2, 64, 2), 'stone'], [new Vec3(2, 65, 2), 'stone']], pos: { x: 0, y: 64, z: 0 }, items: [{ name: 'oak_sapling', count: 1 }] });
  try { await smartPlace(ctxOf(bot2), 'oak_sapling', new Vec3(2, 66, 2)); ok(false, 'sapling on stone should fail'); } catch (e) { ok(/only grows on dirt/.test(e.message), 'sapling on stone -> soil error', e.message); }
  const l = flat(); for (let x = 1; x <= 3; x++) for (let z = 1; z <= 3; z++) if (!(x === 2 && z === 2)) l.push([new Vec3(x, 64, z), 'stone']);
  const bot3 = fakeBot({ blocks: l, pos: { x: 0, y: 64, z: 0 }, items: [{ name: 'white_bed', count: 1 }] });
  try { await smartPlace(ctxOf(bot3), 'white_bed', new Vec3(2, 64, 2)); ok(false, 'bed in a 1x1 gap should fail'); } catch (e) { ok(/No room for a bed/.test(e.message), 'bed with no room for the head -> clear error', e.message); }
  const bot4 = fakeBot({ blocks: flat(), pos: { x: 0, y: 64, z: 0 }, items: [{ name: 'torch', count: 1 }] });
  try { await placeBlockAt(ctxOf(bot4), 'torch', new Vec3(0, 70, 0)); ok(false, 'floating torch'); } catch (e) { ok(/floating|solid block underneath/.test(e.message), 'floating torch refused', e.message); }
}

// ---- crafting ----
{
  const bot = fakeBot({ pos: { x: 0, y: 64, z: 0 }, items: [{ name: 'oak_log', count: 1 }] });
  const r = await craftPlan(ctxOf(bot), 'iron_pickaxe', 1);
  ok(/MISSING\] iron_ingot: need 3/.test(r) && /smelt raw_iron/.test(r) && !/iron_nugget/.test(r), 'craft_plan iron_pickaxe: missing ingots via smelting, no nugget cycle', r);
  const r2 = await craftPlan(ctxOf(fakeBot({ pos: { x: 0, y: 64, z: 0 }, items: [{ name: 'oak_log', count: 3 }] })), 'wooden_pickaxe', 1);
  ok(/READY/.test(r2), 'craft_plan wooden_pickaxe from 3 logs: READY', r2);
  const r3 = await craftPlan(ctxOf(fakeBot({ pos: { x: 0, y: 64, z: 0 }, items: [{ name: 'oak_planks', count: 3 }] })), 'white_bed', 1);
  ok(/white_wool|string/.test(r3) && /sheep|spider/.test(r3), 'craft_plan bed: wool source named', r3);
  const r4 = await craftPlan(ctxOf(fakeBot({ pos: { x: 0, y: 64, z: 0 }, items: [] })), 'stone_pickaxe', 1);
  ok(/collect stone \(needs wooden_pickaxe\+\)/.test(r4), 'craft_plan names cobblestone source + tool tier', r4);
  const fail1 = await craftItem(ctxOf(fakeBot({ pos: { x: 0, y: 64, z: 0 }, items: [{ name: 'oak_log', count: 1 }] })), 'stone_pickaxe', 1);
  ok(!fail1.ok && /missing 3 more cobblestone/.test(fail1.error) && /collect stone/.test(fail1.error), 'craft error lists exact missing + source', fail1.error);
}

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
