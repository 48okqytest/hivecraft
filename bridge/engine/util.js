// Shared helpers for the Hivecraft engine: errors, sleeping, generic-name resolution.
import minecraftData from 'minecraft-data';

export class StopError extends Error {
  constructor(msg = 'Stopped') { super(msg); this.name = 'StopError'; }
}
export const isStop = (e) => e instanceof StopError || e?.name === 'StopError';

export const sleep = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) return reject(new StopError());
  const t = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
  const onAbort = () => { clearTimeout(t); reject(new StopError()); };
  signal?.addEventListener('abort', onAbort, { once: true });
});

export const r1 = (n) => Math.round(n * 10) / 10;
export const ipos = (v) => ({ x: Math.floor(v.x), y: Math.floor(v.y), z: Math.floor(v.z) });
export const fmtPos = (v) => `${Math.floor(v.x)},${Math.floor(v.y)},${Math.floor(v.z)}`;
export const posKey = (v) => `${v.x},${v.y},${v.z}`;

const mdCache = new Map();
export function getMcData(version) {
  if (!mdCache.has(version)) mdCache.set(version, minecraftData(version));
  return mdCache.get(version);
}

// ---------- generic names ----------
// alias -> predicate over a registry name.
const SUFFIX = (s) => (n) => n.endsWith(s);
const GENERIC = {
  log: (n) => /_log$/.test(n) && !n.startsWith('stripped_'),
  logs: (n) => /_log$/.test(n) && !n.startsWith('stripped_'),
  any_log: (n) => /_log$/.test(n) && !n.startsWith('stripped_'),
  wood: (n) => /_(log|wood)$/.test(n) && !n.startsWith('stripped_'),
  planks: SUFFIX('_planks'),
  any_planks: SUFFIX('_planks'),
  leaves: SUFFIX('_leaves'),
  sapling: SUFFIX('_sapling'),
  wool: SUFFIX('_wool'),
  bed: SUFFIX('_bed'),
  door: (n) => /_door$/.test(n),
  slab: SUFFIX('_slab'),
  stairs: SUFFIX('_stairs'),
  fence: (n) => /_fence$/.test(n),
  glass: (n) => n === 'glass' || /_stained_glass$/.test(n),
  ore: (n) => /_ore$/.test(n) || n === 'ancient_debris',
  any_ore: (n) => /_ore$/.test(n) || n === 'ancient_debris',
  pickaxe: SUFFIX('_pickaxe'), axe: SUFFIX('_axe'), shovel: SUFFIX('_shovel'), hoe: SUFFIX('_hoe'),
  sword: SUFFIX('_sword'), helmet: SUFFIX('_helmet'), chestplate: SUFFIX('_chestplate'),
  leggings: SUFFIX('_leggings'), boots: SUFFIX('_boots'),
  shulker_box: (n) => n === 'shulker_box' || /_shulker_box$/.test(n),
};
// "iron" -> iron_ore (+deepslate variant) when no block/item has that exact name.
const ORE_SHORT = ['coal', 'iron', 'copper', 'gold', 'diamond', 'emerald', 'lapis', 'redstone'];

function suggest(names, q) {
  const s = q.toLowerCase();
  const hits = names.filter((n) => n.includes(s)).slice(0, 8);
  if (hits.length) return hits;
  const parts = s.split('_').filter((p) => p.length > 2);
  return names.filter((n) => parts.some((p) => n.includes(p))).slice(0, 8);
}

/** Resolve a block name (possibly generic) to registry block names. Throws helpful error. */
export function resolveBlockNames(mcData, name) {
  const q = String(name || '').toLowerCase().trim().replace(/^minecraft:/, '').replace(/\s+/g, '_');
  if (!q) throw new Error('block name is required');
  const all = mcData.blocksArray.map((b) => b.name);
  const set = new Set(all);
  let names = [];
  if (GENERIC[q]) names = all.filter(GENERIC[q]);
  else if (q === 'stone') names = ['stone'];
  else if (q === 'cobble' || q === 'cobblestone') names = ['cobblestone'];
  else if (q === 'dirt') names = ['dirt', 'grass_block', 'coarse_dirt', 'podzol', 'rooted_dirt'];
  else if (q === 'grass') names = ['grass_block'];
  else if (q === 'sand') names = ['sand'];
  else if (q === 'water' || q === 'lava') names = [q];
  else if (set.has(q)) names = [q];
  else if (ORE_SHORT.includes(q) && set.has(`${q}_ore`)) names = [`${q}_ore`];
  else if (set.has(`${q}_block`) && false) names = [`${q}_block`];
  if (!names.length) {
    const sug = suggest(all, q);
    throw new Error(`Unknown block "${name}".${sug.length ? ' Did you mean: ' + sug.join(', ') + '?' : ''}`);
  }
  // ores: include deepslate variant
  const out = new Set(names);
  for (const n of names) if (/_ore$/.test(n) && set.has(`deepslate_${n}`)) out.add(`deepslate_${n}`);
  if (names.includes('stone')) { /* stone only; deepslate is a separate target */ }
  return [...out];
}

/** Resolve an item name (possibly generic) to registry item names. */
export function resolveItemNames(mcData, name) {
  const q = String(name || '').toLowerCase().trim().replace(/^minecraft:/, '').replace(/\s+/g, '_');
  if (!q) throw new Error('item name is required');
  const all = mcData.itemsArray.map((i) => i.name);
  const set = new Set(all);
  if (set.has(q)) return [q];
  if (GENERIC[q]) { const l = all.filter(GENERIC[q]); if (l.length) return l; }
  if (q === 'food') return mcData.foodsArray.map((f) => f.name);
  if (q === 'cobble') return ['cobblestone'];
  if (q === 'sticks') return ['stick'];
  if (q === 'table' || q === 'workbench') return ['crafting_table'];
  const sug = suggest(all, q);
  throw new Error(`Unknown item "${name}".${sug.length ? ' Did you mean: ' + sug.join(', ') + '?' : ''}`);
}

/** Predicate for inventory items matching a (possibly generic) name; never throws. */
export function itemMatcher(mcData, name) {
  const q = String(name || '').toLowerCase().trim().replace(/^minecraft:/, '').replace(/\s+/g, '_');
  if (GENERIC[q]) return (n) => GENERIC[q](n);
  if (q === 'food') return (n) => !!mcData.foodsByName[n];
  return (n) => n === q;
}

export function invCounts(bot) {
  const m = new Map();
  for (const it of bot.inventory.items()) m.set(it.name, (m.get(it.name) || 0) + it.count);
  return m;
}
export const countItem = (bot, name) => invCounts(bot).get(name) || 0;
export const invSummary = (bot) => {
  const c = [...invCounts(bot)].sort((a, b) => b[1] - a[1]).map(([n, k]) => `${n} x${k}`);
  return c.length ? c.join(', ') : 'empty';
};

export const TOOL_RE = /_(pickaxe|axe|shovel|hoe|sword)$|^(bow|crossbow|shield|fishing_rod|shears|flint_and_steel|bucket|water_bucket|lava_bucket|trident|elytra|spyglass|compass|clock|torch)$/;
export const ARMOR_RE = /_(helmet|chestplate|leggings|boots)$/;

export function summarizeError(e) {
  const m = e?.message || String(e);
  return m.length > 400 ? m.slice(0, 400) + '…' : m;
}

// ---------- robustness helpers (shared by nav/craft/actions and teammates' action files) ----------
/** compass direction of a horizontal offset, e.g. "north-east" (MC: -z = north, +x = east) */
export function dirName(dx, dz) {
  if (Math.abs(dx) < 0.5 && Math.abs(dz) < 0.5) return 'here';
  const a = (Math.atan2(dx, -dz) * 180) / Math.PI; // 0 = north, 90 = east
  const names = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'];
  return names[((Math.round(a / 45) % 8) + 8) % 8];
}

/** block name that appears in the world when an item is placed (wheat_seeds -> wheat, torch -> torch|wall_torch) */
const PLACED_AS = {
  wheat_seeds: ['wheat'], beetroot_seeds: ['beetroots'], carrot: ['carrots'], potato: ['potatoes'], melon_seeds: ['melon_stem'],
  pumpkin_seeds: ['pumpkin_stem'], sweet_berries: ['sweet_berry_bush'], glow_berries: ['cave_vines'], redstone: ['redstone_wire'],
  string: ['tripwire'], torch: ['torch', 'wall_torch'], soul_torch: ['soul_torch', 'soul_wall_torch'], redstone_torch: ['redstone_torch', 'redstone_wall_torch'],
  cocoa_beans: ['cocoa'], kelp: ['kelp'], water_bucket: ['water'], lava_bucket: ['lava'], powder_snow_bucket: ['powder_snow'],
};
export function placedBlockNames(itemName) {
  if (PLACED_AS[itemName]) return PLACED_AS[itemName];
  if (/_sign$/.test(itemName) && !/hanging/.test(itemName)) return [itemName, itemName.replace(/_sign$/, '_wall_sign')];
  if (/_banner$/.test(itemName)) return [itemName, itemName.replace(/_banner$/, '_wall_banner')];
  if (/_(head|skull)$/.test(itemName)) return [itemName, itemName.replace(/_(head|skull)$/, '_wall_$1')];
  if (/_coral_fan$/.test(itemName)) return [itemName, itemName.replace(/_coral_fan$/, '_coral_wall_fan')];
  return [itemName];
}

export const SEED_ITEMS = new Set(['wheat_seeds', 'beetroot_seeds', 'carrot', 'potato', 'melon_seeds', 'pumpkin_seeds']);
export const SAPLING_SOIL = new Set(['dirt', 'grass_block', 'podzol', 'coarse_dirt', 'rooted_dirt', 'moss_block', 'mud', 'muddy_mangrove_roots', 'farmland', 'mycelium']);

/** blocks a bot can break quickly with bare hands (or any tool) */
export function handDiggable(block) {
  if (!block || !block.diggable) return false;
  const n = block.name;
  if (/_leaves$|_wool$|_carpet$|^(short_grass|tall_grass|fern|large_fern|vine|snow|snow_block|dead_bush|seagrass|sugar_cane|bamboo|kelp|cobweb|hay_block|pumpkin|melon|cactus)$/.test(n)) return true;
  if (/^(dirt|grass_block|coarse_dirt|podzol|rooted_dirt|mud|mycelium|farmland|dirt_path|gravel|sand|red_sand|clay|soul_sand|soul_soil|moss_block|powder_snow|suspicious_sand|suspicious_gravel)$/.test(n)) return true;
  if (/_(log|wood|planks|slab|stairs|fence|fence_gate|door|trapdoor)$/.test(n) && !/(stone|brick|deepslate|copper|iron|quartz|prismarine|purpur|sandstone|blackstone|tuff)/.test(n)) return true; // wood: slow-ish by hand but fine
  if (/^(glass|glass_pane|.*_stained_glass|.*_stained_glass_pane|torch|wall_torch|ladder|scaffolding|crafting_table|bookshelf|note_block|chest|barrel)$/.test(n)) return true;
  return false;
}

/** can `count` more of item fit in the inventory (empty slot or a stack with room)? */
export function roomFor(bot, itemName, count = 1) {
  const reg = bot.registry.itemsByName[itemName];
  const stack = reg?.stackSize || 64;
  let room = bot.inventory.emptySlotCount() * stack;
  for (const it of bot.inventory.items()) if (it.name === itemName) room += Math.max(0, stack - it.count);
  return room >= count;
}

/** Items agents usually do not need, listed when the inventory is full. */
export const JUNK_RE = /^(dirt|gravel|andesite|diorite|granite|tuff|calcite|netherrack|rotten_flesh|poisonous_potato|spider_eye|moss_block|moss_carpet|azalea|flowering_azalea|dripstone_block|pointed_dripstone|cobbled_deepslate|deepslate|sand|red_sand|bone|.*_sapling|wheat_seeds|beetroot_seeds|short_grass|dead_bush|kelp|seagrass|lily_pad|vine|stick)$/;
export function fullInventoryHint(bot) {
  const junk = [...invCounts(bot)].filter(([n]) => JUNK_RE.test(n)).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([n, c]) => `${n} x${c}`);
  return `Your inventory is FULL (${bot.inventory.items().length}/36 slots). Free a slot first: chest_deposit at the base chest, or drop junk (drop {item, count:0})${junk.length ? ` — e.g. ${junk.join(', ')}` : ''}.`;
}
