// Block states for blueprints: parse/format "oak_stairs[facing=north,half=bottom]", validate against minecraft-data,
// rotate/mirror block states, map blocks to the items that place them, and decide which props matter when verifying.

export const HORIZ = ['north', 'east', 'south', 'west']; // clockwise order seen from above
export const DIR_VEC = {
  north: [0, 0, -1], south: [0, 0, 1], east: [1, 0, 0], west: [-1, 0, 0], up: [0, 1, 0], down: [0, -1, 0],
};
export const OPP = { north: 'south', south: 'north', east: 'west', west: 'east', up: 'down', down: 'up' };
export const vecToDir = (dx, dy, dz) => Object.keys(DIR_VEC).find((k) => DIR_VEC[k][0] === dx && DIR_VEC[k][1] === dy && DIR_VEC[k][2] === dz);
export const cw = (d) => (HORIZ.includes(d) ? HORIZ[(HORIZ.indexOf(d) + 1) % 4] : d);
export const ccw = (d) => (HORIZ.includes(d) ? HORIZ[(HORIZ.indexOf(d) + 3) % 4] : d);

/** "minecraft:oak_stairs[facing=north, half=top]" -> {name:'oak_stairs', props:{facing:'north',half:'top'}} */
export function parseState(s) {
  if (s && typeof s === 'object') return { name: cleanName(s.name || s.block), props: { ...(s.props || s.properties || {}) } };
  const str = String(s || '').trim();
  const m = /^([^[\s]+)\s*(?:\[(.*)\])?$/.exec(str);
  if (!m) throw new Error(`Bad block "${s}". Use a name like "oak_planks" or "oak_stairs[facing=north,half=bottom]".`);
  const props = {};
  if (m[2]) {
    for (const part of m[2].split(',')) {
      if (!part.trim()) continue;
      const [k, v] = part.split('=').map((x) => x?.trim());
      if (!k || v === undefined) throw new Error(`Bad block state "${part}" in "${s}" (want key=value).`);
      props[k] = v;
    }
  }
  return { name: cleanName(m[1]), props };
}
export const cleanName = (n) => String(n || '').trim().toLowerCase().replace(/^minecraft:/, '').replace(/\s+/g, '_');

/** canonical string, props sorted */
export function formatState(name, props = {}) {
  const keys = Object.keys(props).sort();
  return keys.length ? `${name}[${keys.map((k) => `${k}=${props[k]}`).join(',')}]` : name;
}

function suggest(names, q) {
  const hits = names.filter((n) => n.includes(q)).slice(0, 6);
  if (hits.length) return hits;
  const parts = q.split('_').filter((p) => p.length > 2);
  return names.filter((n) => parts.some((p) => n.includes(p))).slice(0, 6);
}

const ALIASES = { cobble: 'cobblestone', planks: 'oak_planks', log: 'oak_log', wood_planks: 'oak_planks', grass: 'grass_block', glass_panes: 'glass_pane', door: 'oak_door', stairs: 'oak_stairs', slab: 'oak_slab', fence: 'oak_fence', torch_wall: 'wall_torch' };

/**
 * Validate + normalize a block spec against minecraft-data. Returns {name, props} with props as strings,
 * only valid keys. Throws a helpful Error on unknown block / prop / value.
 */
export function normalizeState(mcData, spec) {
  let { name, props } = parseState(spec);
  if (!mcData.blocksByName[name] && ALIASES[name]) name = ALIASES[name];
  const b = mcData.blocksByName[name];
  if (!b) {
    const sug = suggest(mcData.blocksArray.map((x) => x.name), name);
    throw new Error(`Unknown block "${name}".${sug.length ? ' Did you mean: ' + sug.join(', ') + '?' : ''}`);
  }
  const out = {};
  const defs = new Map((b.states || []).map((s) => [s.name, s]));
  for (const [k, v0] of Object.entries(props)) {
    const d = defs.get(k);
    if (!d) throw new Error(`Block ${name} has no state "${k}". Valid states: ${[...defs.keys()].join(', ') || 'none'}.`);
    const v = String(v0).toLowerCase();
    const vals = d.type === 'bool' ? ['true', 'false'] : (d.values || []).map(String);
    if (!vals.includes(v)) throw new Error(`Bad value ${k}=${v0} for ${name}. Valid: ${vals.join(', ')}.`);
    out[k] = v;
  }
  return { name, props: out };
}

export function blockStateDefs(mcData, name) { return mcData.blocksByName[name]?.states || []; }

// ---------- rotation / mirror ----------
const rotDirN = (d, n) => { let x = d; for (let i = 0; i < ((n % 4) + 4) % 4; i++) x = cw(x); return x; };
const RAIL_SHAPES = {
  north_south: ['north', 'south'], east_west: ['east', 'west'], north_east: ['north', 'east'], north_west: ['north', 'west'],
  south_east: ['south', 'east'], south_west: ['south', 'west'],
};
function railShape(shape, mapDir) {
  if (shape.startsWith('ascending_')) return 'ascending_' + mapDir(shape.slice(10));
  const pair = RAIL_SHAPES[shape];
  if (!pair) return shape;
  const [a, b] = pair.map(mapDir);
  for (const [k, [p, q]] of Object.entries(RAIL_SHAPES)) if ((p === a && q === b) || (p === b && q === a)) return k;
  return shape;
}

/** Transform props with a direction mapping. flip=true for mirrors (handedness changes). */
function mapProps(name, props, mapDir, { flip = false, rotSteps16 = (r) => r } = {}) {
  const out = {};
  // connection-style props keyed by direction name (fences, panes, walls, vines, redstone, mushroom blocks)
  for (const [k, v] of Object.entries(props)) {
    if (HORIZ.includes(k)) out[mapDir(k)] = v;
    else out[k] = v;
  }
  if (out.facing) out.facing = mapDir(out.facing);
  if (out.axis && (out.axis === 'x' || out.axis === 'z')) {
    const d = mapDir(out.axis === 'x' ? 'east' : 'south');
    out.axis = d === 'east' || d === 'west' ? 'x' : 'z';
  }
  if (out.rotation !== undefined) out.rotation = String(((rotSteps16(Number(out.rotation)) % 16) + 16) % 16);
  if (out.shape && /_rail$|^rail$/.test(name)) out.shape = railShape(out.shape, mapDir);
  if (flip) {
    if (out.hinge) out.hinge = out.hinge === 'left' ? 'right' : 'left';
    if (out.shape && /_stairs$/.test(name)) out.shape = out.shape.replace(/left|right/, (s) => (s === 'left' ? 'right' : 'left'));
    if (out.type && /chest$/.test(name) && out.type !== 'single') out.type = out.type === 'left' ? 'right' : 'left';
  }
  return out;
}

/** rotate props by n quarter turns clockwise (seen from above). */
export function rotateProps(name, props, n) {
  const k = ((n % 4) + 4) % 4;
  if (!k) return { ...props };
  return mapProps(name, props, (d) => rotDirN(d, k), { rotSteps16: (r) => r + 4 * k });
}
/** mirror across an axis: 'x' flips east<->west (x -> -x), 'z' flips north<->south. */
export function mirrorProps(name, props, axis) {
  const map = axis === 'x' ? { east: 'west', west: 'east' } : { north: 'south', south: 'north' };
  return mapProps(name, props, (d) => map[d] || d, { flip: true, rotSteps16: (r) => (axis === 'x' ? 16 - r : 8 - r) });
}
/** rotate a relative position (x,z) n quarter turns clockwise around the origin. */
export function rotatePos(x, z, n) {
  let a = x, b = z;
  for (let i = 0; i < ((n % 4) + 4) % 4; i++) { const t = a; a = -b; b = t; }
  return [a, b];
}

// ---------- items ----------
const ITEM_OVERRIDES = {
  redstone_wire: 'redstone', tripwire: 'string', potatoes: 'potato', carrots: 'carrot', wheat: 'wheat_seeds',
  beetroots: 'beetroot_seeds', cocoa: 'cocoa_beans', sweet_berry_bush: 'sweet_berries', water: 'water_bucket', lava: 'lava_bucket',
  pumpkin_stem: 'pumpkin_seeds', melon_stem: 'melon_seeds', attached_pumpkin_stem: 'pumpkin_seeds', attached_melon_stem: 'melon_seeds',
  bamboo_sapling: 'bamboo', cave_vines: 'glow_berries', cave_vines_plant: 'glow_berries', kelp_plant: 'kelp',
  twisting_vines_plant: 'twisting_vines', weeping_vines_plant: 'weeping_vines', big_dripleaf_stem: 'big_dripleaf',
  tall_seagrass: 'seagrass', powder_snow: 'powder_snow_bucket', bubble_column: null, fire: null, soul_fire: null,
  piston_head: null, moving_piston: null, nether_portal: null, end_portal: null, end_gateway: null, frosted_ice: null,
  farmland: 'dirt', dirt_path: 'dirt', air: null, cave_air: null, void_air: null, light: null, barrier: 'barrier',
};

/** item that places this block state, or null if not placeable from an item. */
export function itemForBlock(mcData, name) {
  if (name in ITEM_OVERRIDES) return ITEM_OVERRIDES[name];
  if (mcData.itemsByName[name]) return name;
  const unwall = name.replace('_wall_', '_').replace(/^wall_/, '');
  if (unwall !== name && mcData.itemsByName[unwall]) return unwall;
  if (/^potted_/.test(name)) return null; // flower pot + flower: place pot then use flower
  return null;
}

/** how many items one block state consumes (0 for door tops, bed heads, upper plant halves...). */
export function itemCount(name, props) {
  if (props.half === 'upper' && (/_door$/.test(name) || isTallPlant(name))) return 0;
  if (props.part === 'head' && /_bed$/.test(name)) return 0;
  if (/_slab$/.test(name) && props.type === 'double') return 2;
  if (props.candles) return Number(props.candles) || 1;
  if (props.pickles) return Number(props.pickles) || 1;
  if (name === 'snow' && props.layers) return Number(props.layers) || 1;
  if (name === 'turtle_egg' && props.eggs) return Number(props.eggs) || 1;
  return 1;
}
export const isTallPlant = (n) => /^(tall_grass|large_fern|sunflower|lilac|rose_bush|peony|pitcher_plant|tall_seagrass|small_dripleaf)$/.test(n);

/** true when the block is a secondary part that the game places automatically with its partner. */
export function isAutoPart(name, props) {
  return (props.half === 'upper' && (/_door$/.test(name) || isTallPlant(name))) || (props.part === 'head' && /_bed$/.test(name));
}

// ---------- which props matter when verifying ----------
const CONNECT = /(_fence|_pane|^glass_pane|_wall|^iron_bars|^redstone_wire|^tripwire|^vine|^glow_lichen|^sculk_vein|_mushroom_block|^mushroom_stem|^chorus_plant|^fire)$/;
/** props the game decides by itself (neighbour connections, power, water...). Ignored when comparing. */
export function isDerivedProp(name, key) {
  if (['waterlogged', 'powered', 'distance', 'persistent', 'snowy', 'occupied', 'lit', 'triggered', 'in_wall', 'attached',
    'disarmed', 'note', 'instrument', 'enabled', 'has_book', 'has_record', 'signal_fire', 'bottom', 'level', 'age', 'stage',
    'moisture', 'bites', 'honey_level', 'power', 'locked', 'delay', 'mode', 'inverted', 'extended', 'short', 'unstable',
    'drag', 'berries', 'hatch', 'tilt', 'thickness', 'vertical_direction'].includes(key)) return true;
  if (key === 'shape' && /_stairs$/.test(name)) return true; // stairs corners are computed from neighbours
  if (key === 'shape' && /rail$/.test(name)) return true;
  if (key === 'type' && /chest$/.test(name)) return true;
  if (CONNECT.test(name) && (HORIZ.includes(key) || key === 'up' || key === 'down')) return true;
  return false;
}

/** compare a wanted state with a world state, ignoring derived props. Returns null if equal, else a reason string. */
export function stateDiff(want, have) {
  if (!have) return 'unloaded';
  if (want.name !== have.name) return `is ${have.name}`;
  const bad = [];
  for (const [k, v] of Object.entries(want.props || {})) {
    if (isDerivedProp(want.name, k)) continue;
    const hv = have.props?.[k];
    if (hv !== undefined && String(hv) !== String(v)) bad.push(`${k}=${hv} (want ${v})`);
  }
  return bad.length ? bad.join(', ') : null;
}

/** props of a prismarine block as strings */
export function worldState(block) {
  if (!block) return null;
  let p = {};
  try { p = block.getProperties() || {}; } catch { /* */ }
  const props = {};
  for (const [k, v] of Object.entries(p)) props[k] = String(v);
  return { name: block.name, props };
}

export const AIRISH = new Set(['air', 'cave_air', 'void_air']);
const REPLACEABLE_RE = /^(air|cave_air|void_air|water|lava|short_grass|grass|tall_grass|fern|large_fern|dead_bush|vine|snow|seagrass|tall_seagrass|fire|soul_fire|light|structure_void|glow_lichen|hanging_roots|crimson_roots|warped_roots|nether_sprouts|bubble_column)$/;
export const isReplaceableName = (n) => REPLACEABLE_RE.test(n);
/** plants/flowers that break instantly and need no clearing tool */
export const isSoftName = (n) => isReplaceableName(n) || /(_flower|^dandelion|^poppy|^blue_orchid|^allium|^azure_bluet|_tulip|^oxeye_daisy|^cornflower|^lily_of_the_valley|^sunflower|^lilac|^rose_bush|^peony|_sapling|_mushroom|^sugar_cane|^sweet_berry_bush|^pink_petals|^torchflower)$/.test(n);
