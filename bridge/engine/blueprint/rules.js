// How to place a block so the server gives it the wanted block state. Mirrors vanilla getStateForPlacement:
// which face of which neighbour to click, which way the player must face (yaw), look up/down (pitch), and where
// on the face to click (hit point: upper/lower half for stairs/slabs/trapdoors, left/right for door hinges).
//
// An option: { face, look?, vlook?, hitY?, hitXZ?:[x,z], merge?, note? }
//   face  = clicked face of the reference block = direction from the reference block to the target
//           ('up' = click the top of the block below the target)
//   look  = required horizontal facing of the player ('north'...), null = any
//   vlook = 'up' | 'down' | 'level' (pitch), null = any
//   hitY  = 'low' | 'high' (where on a side face), null = middle
//   yawDeg= exact notchian yaw (signs/banners rotation)
import { HORIZ, OPP, DIR_VEC, cw, ccw, isTallPlant } from './states.js';

const SIDES = HORIZ;
const ALL6 = ['up', 'north', 'east', 'south', 'west', 'down'];

const FACE_PLAYER = /^(furnace|blast_furnace|smoker|chest|trapped_chest|ender_chest|carved_pumpkin|jack_o_lantern|lectern|loom|stonecutter|beehive|bee_nest|repeater|comparator|end_portal_frame|chiseled_bookshelf|crafting_table|vault|trial_spawner)$|_glazed_terracotta$/;
const SAME_AS_LOOK = /(_stairs|_door|_bed|_fence_gate)$|^(campfire|soul_campfire|decorated_pot|calibrated_sculk_sensor|big_dripleaf|small_dripleaf|pink_petals|piglin_head|bell)$/;
const LOOK_OPPOSITE_6 = /^(piston|sticky_piston|dispenser|dropper|barrel|command_block|chain_command_block|repeating_command_block|crafter)$/;
const LOOK_SAME_6 = /^(observer)$/;
const CLICKED_FACE_6 = /^(end_rod|lightning_rod|amethyst_cluster|large_amethyst_bud|medium_amethyst_bud|small_amethyst_bud)$|shulker_box$/;
const FACE_ATTACHED = /(_button|^lever|^grindstone)$/;
const ROTATION16 = /(_sign|_banner|_skull|_head)$/;

/** yaw (notchian degrees) for a horizontal direction: south 0, west 90, north 180, east 270 */
export const NOTCH_YAW = { south: 0, west: 90, north: 180, east: 270 };
/** mineflayer yaw radians for a horizontal direction (mineflayer: 0 = north, pi/2 = west, pi = south, -pi/2 = east) */
export const MF_YAW = { north: 0, west: Math.PI / 2, south: Math.PI, east: -Math.PI / 2 };
export const mfYawFromNotch = (deg) => Math.PI - (deg * Math.PI) / 180;

const hit = (h) => (h === 'top' ? 'high' : 'low');

/**
 * Placement options for a wanted block state, best first. Returns [] for parts that the game places itself
 * (door top half, bed head) — caller should skip those.
 */
export function placementOptions(name, props = {}) {
  const p = props;
  const F = p.facing;
  // --- auto parts
  if (p.half === 'upper' && (/_door$/.test(name) || isTallPlant(name))) return [];
  if (p.part === 'head' && /_bed$/.test(name)) return [];
  // --- stairs
  if (/_stairs$/.test(name)) {
    const look = F || null;
    if (p.half === 'top') return [{ face: 'down', look }, ...SIDES.map((s) => ({ face: s, look, hitY: 'high' }))];
    return [{ face: 'up', look }, ...SIDES.map((s) => ({ face: s, look, hitY: 'low' }))];
  }
  // --- slabs
  if (/_slab$/.test(name)) {
    if (p.type === 'top') return [{ face: 'down' }, ...SIDES.map((s) => ({ face: s, hitY: 'high' }))];
    if (p.type === 'double') return [{ face: 'up', merge: true, note: 'double slab = bottom slab + second slab clicked onto it' }];
    return [{ face: 'up' }, ...SIDES.map((s) => ({ face: s, hitY: 'low' }))];
  }
  // --- trapdoors
  if (/_trapdoor$/.test(name)) {
    const half = p.half || 'bottom';
    const out = [];
    if (F) out.push({ face: F, hitY: hit(half) });
    out.push({ face: half === 'top' ? 'down' : 'up', look: F ? OPP[F] : null });
    return out;
  }
  // --- doors (placed on the block below; hinge from click position when neighbours don't decide)
  if (/_door$/.test(name)) {
    return [{ face: 'up', look: F || null, hitXZ: doorHit(F || 'north', p.hinge || 'left') }];
  }
  // --- beds: target is the foot; head goes toward facing
  if (/_bed$/.test(name)) return [{ face: 'up', look: F || null }];
  // --- fence gates and other "same as player" horizontal blocks
  if (SAME_AS_LOOK.test(name) && F && SIDES.includes(F)) return ALL6.filter((f) => f !== 'down').map((face) => ({ face, look: F }));
  // --- wall-mounted variants (wall_torch, oak_wall_sign, *_wall_banner, *_wall_head...): facing = clicked side face
  if (/(^|_)wall_/.test(name) && F && SIDES.includes(F)) return [{ face: F, look: OPP[F], vlook: 'level' }];
  if (name === 'ladder' || /^(cocoa)$/.test(name)) return F ? [{ face: name === 'cocoa' ? OPP[F] : F, look: OPP[F], vlook: 'level' }] : [];
  // --- levers / buttons / grindstone (use nearest looking direction)
  if (FACE_ATTACHED.test(name)) {
    const face = p.face || 'wall';
    if (face === 'wall') return [{ face: F || 'north', look: OPP[F || 'north'], vlook: 'level' }];
    if (face === 'floor') return [{ face: 'up', look: F || null, vlook: 'down' }];
    return [{ face: 'down', look: F || null, vlook: 'up' }];
  }
  // --- lanterns: hanging from the block above
  if (/lantern$/.test(name) && p.hanging !== undefined) {
    return p.hanging === 'true' ? [{ face: 'down', vlook: 'up' }] : [{ face: 'up', vlook: 'down' }];
  }
  // --- logs, pillars, chains, basalt, hay...: axis = clicked face axis
  if (p.axis && /^(x|y|z)$/.test(p.axis)) {
    const faces = p.axis === 'y' ? ['up', 'down'] : p.axis === 'x' ? ['east', 'west'] : ['south', 'north'];
    return faces.map((face) => ({ face }));
  }
  // --- 6-way blocks
  if (F && LOOK_OPPOSITE_6.test(name)) return ALL6.map((face) => ({ face, ...lookToward(OPP[F]) }));
  if (F && LOOK_SAME_6.test(name)) return ALL6.map((face) => ({ face, ...lookToward(F) }));
  if (F && CLICKED_FACE_6.test(name)) return [{ face: F }];
  if (name === 'hopper' && F) return F === 'down' ? [{ face: 'up' }, { face: 'down' }] : [{ face: OPP[F] }];
  // --- standing signs/banners/heads: rotation 0..15 from the player's yaw
  if (ROTATION16.test(name) && p.rotation !== undefined) {
    const r = Number(p.rotation);
    return [{ face: 'up', yawDeg: r * 22.5 - 180, vlook: 'down' }];
  }
  if (name === 'anvil' || /_anvil$/.test(name)) return F ? ALL6.filter((f) => f !== 'down').map((face) => ({ face, look: ccw(F) })) : [{ face: 'up' }];
  // --- generic horizontal "faces the player" blocks
  // (FACE_PLAYER lists the known ones; any other horizontal-facing block defaults to this too, verify+retry catches exceptions)
  if (F && SIDES.includes(F)) return ALL6.filter((f) => f !== 'down').map((face) => ({ face, look: OPP[F] }));
  // --- torches, rails, carpets, plates, flowers, redstone...: on the block below
  if (/(^torch$|^soul_torch$|^redstone_torch$|rail$|_carpet$|_pressure_plate$|^redstone_wire$|^repeater$|^comparator$|_sapling$|^flower_pot$|_candle$|^candle$|^snow$|^lily_pad$)/.test(name)) return [{ face: 'up' }];
  return ALL6.map((face) => ({ face }));
}

/** horizontal look + pitch so the nearest looking direction is d */
function lookToward(d) {
  if (d === 'up') return { vlook: 'up' };
  if (d === 'down') return { vlook: 'down' };
  return { look: d, vlook: 'level' };
}

/**
 * Click position (x,z inside the target column, 0..1) on the top face of the block below so a door facing F gets
 * the wanted hinge (vanilla DoorBlock.getHinge tie-break by click position).
 */
export function doorHit(F, hinge) {
  const [j, , k] = DIR_VEC[F];
  const cands = [[0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]];
  for (const [d, e] of cands) if (predictDoorHingeByClick(j, k, d, e) === hinge) return [d, e];
  return [0.5, 0.5];
}
export function predictDoorHingeByClick(j, k, d, e) {
  return (j >= 0 || !(e < 0.5)) && (j <= 0 || !(e > 0.5)) && (k >= 0 || !(d > 0.5)) && (k <= 0 || !(d < 0.5)) ? 'left' : 'right';
}
/**
 * Hinge the game will force from neighbours (vanilla getHinge), or null when the click position decides.
 * fullAt(dx,dy,dz) -> true when the block at target+offset has a full collision box; doorLowerAt(dx,dz,name) -> true for same-door lower half.
 */
export function forcedDoorHinge(F, fullAt, doorLowerAt) {
  const L = DIR_VEC[ccw(F)], R = DIR_VEC[cw(F)];
  const i = (fullAt(L[0], 0, L[2]) ? -1 : 0) + (fullAt(L[0], 1, L[2]) ? -1 : 0) + (fullAt(R[0], 0, R[2]) ? 1 : 0) + (fullAt(R[0], 1, R[2]) ? 1 : 0);
  const dl = doorLowerAt(L[0], L[2]), dr = doorLowerAt(R[0], R[2]);
  if ((!dl || dr) && i <= 0) {
    if ((!dr || dl) && i >= 0) return null;
    return 'left';
  }
  return 'right';
}

/** cursor position on the clicked face of the reference block (0..1 in the ref block's coords) */
export function cursorFor(opt) {
  const f = opt.face;
  const yv = opt.hitY === 'high' ? 0.8 : opt.hitY === 'low' ? 0.2 : 0.5;
  if (f === 'up') return { x: opt.hitXZ ? opt.hitXZ[0] : 0.5, y: 1, z: opt.hitXZ ? opt.hitXZ[1] : 0.5 };
  if (f === 'down') return { x: 0.5, y: 0, z: 0.5 };
  const [dx, , dz] = DIR_VEC[f];
  return { x: dx > 0 ? 1 : dx < 0 ? 0 : 0.5, y: yv, z: dz > 0 ? 1 : dz < 0 ? 0 : 0.5 };
}

/** does the state depend on how it's placed (so a wrong placement should be retried)? */
export function hasControlledState(name, props) {
  return ['facing', 'half', 'type', 'axis', 'hinge', 'rotation', 'face', 'hanging'].some((k) => props[k] !== undefined);
}

/** blocks that must go after everything else in their layer (need a support face to exist) */
export function isAttachment(name) {
  return /(torch|_sign|_banner|_button|^lever|^ladder|_door$|_bed$|_carpet$|_pressure_plate$|rail$|^redstone_wire$|^repeater$|^comparator$|lantern$|_trapdoor$|^flower_pot$|^potted_|_sapling$|^vine$|^cocoa$|_head$|_skull$|^tripwire_hook$|^bell$|candle)/.test(name)
    || /^(dandelion|poppy|blue_orchid|allium|azure_bluet|oxeye_daisy|cornflower|lily_of_the_valley|short_grass|fern)$/.test(name) || /_tulip$/.test(name);
}
/** gravity blocks need something under them before placing */
export const isGravity = (name) => /^(sand|red_sand|gravel|suspicious_sand|suspicious_gravel|anvil|chipped_anvil|damaged_anvil|scaffolding|pointed_dripstone)$|_concrete_powder$/.test(name);

/** blocks a bot must not click as a reference without sneaking (they open a GUI / toggle) */
export const INTERACTIVE = /(chest|barrel|furnace|smoker|crafting_table|_door|_trapdoor|_fence_gate|_button|^lever|_bed|anvil|enchanting_table|brewing_stand|beacon|hopper|dispenser|dropper|shulker_box|loom|stonecutter|grindstone|cartography_table|smithing_table|lectern|bell|note_block|repeater|comparator|daylight_detector|_sign|cake|crafter|jukebox|campfire|composter|respawn_anchor|decorated_pot|chiseled_bookshelf|flower_pot|^potted_)/;
