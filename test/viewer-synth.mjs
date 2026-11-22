// Offline viewer test: renders a synthetic snapshot (no Minecraft server needed).
import './neutral-player.mjs'; // neutral human player (Robin / robin_mc), live ports blocked
import fs from 'node:fs';
import path from 'node:path';
import { renderView, closeViewer } from '../bridge/viewer/render.js';

export function synthSnapshot() {
  const origin = { x: 400, y: 56, z: 400 }, size = { x: 33, y: 24, z: 33 };
  const palette = ['air', 'stone', 'dirt', 'grass_block[snowy=false]', 'oak_log[axis=y]', 'oak_leaves[distance=1,persistent=false,waterlogged=false]',
    'water[level=0]', 'oak_planks', 'oak_stairs[facing=north,half=bottom,shape=straight,waterlogged=false]', 'chest[facing=south,type=single,waterlogged=false]',
    'torch', 'glass', 'iron_ore', 'short_grass', 'poppy', 'cobblestone', 'oak_fence[east=true,north=false,south=false,waterlogged=false,west=true]', 'sand', 'diamond_ore', 'lava[level=0]', 'red_bed[facing=north,occupied=false,part=head]', 'red_bed[facing=north,occupied=false,part=foot]', 'oak_door[facing=south,half=lower,hinge=left,open=false,powered=false]', 'oak_door[facing=south,half=upper,hinge=left,open=false,powered=false]', 'crafting_table', 'furnace[facing=south,lit=false]',
    'oak_stairs[facing=south,half=bottom,shape=straight,waterlogged=false]', 'oak_slab[type=bottom,waterlogged=false]', 'glass_pane[east=true,north=false,south=false,waterlogged=false,west=true]', 'wall_torch[facing=south]', 'lantern[hanging=false,waterlogged=false]', 'stone_brick_stairs[facing=east,half=bottom,shape=straight,waterlogged=false]', 'oak_trapdoor[facing=north,half=top,open=false,powered=false,waterlogged=false]'];
  const P = {}; palette.forEach((k, i) => { const n = k.split('[')[0]; if (P[n] === undefined) P[n] = i; });
  P.stairs_s = palette.indexOf('oak_stairs[facing=south,half=bottom,shape=straight,waterlogged=false]');
  const cells = new Uint16Array(size.x * size.y * size.z); const light = new Uint8Array(cells.length);
  const I = (x, y, z) => (y * size.z + z) * size.x + x;
  const set = (x, y, z, n) => { if (x >= 0 && y >= 0 && z >= 0 && x < size.x && y < size.y && z < size.z) cells[I(x, y, z)] = P[n]; };
  const G = 8; // ground y index (world 64)
  for (let z = 0; z < size.z; z++) for (let x = 0; x < size.x; x++) {
    const h = G + Math.round(Math.sin(x / 5) * 1.2 + Math.cos(z / 6));
    for (let y = 0; y <= h; y++) set(x, y, z, y < h - 3 ? 'stone' : y < h ? 'dirt' : 'grass_block');
    if ((x * 7 + z * 13) % 11 === 0) set(x, h + 1, z, 'short_grass');
    if ((x * 5 + z * 3) % 29 === 0) set(x, h + 1, z, 'poppy');
  }
  // pond
  for (let z = 20; z < 27; z++) for (let x = 4; x < 12; x++) { set(x, G + 1, z, 'air'); set(x, G + 2, z, 'air'); for (let y = G - 1; y <= G; y++) set(x, y, z, 'water'); set(x, G - 2, z, 'sand'); }
  // tree
  const tx = 22, tz = 8; for (let y = G + 1; y < G + 6; y++) set(tx, y, tz, 'oak_log');
  for (let y = G + 4; y < G + 8; y++) for (let dz = -2; dz <= 2; dz++) for (let dx = -2; dx <= 2; dx++) { if (Math.abs(dx) + Math.abs(dz) > (y > G + 5 ? 2 : 3)) continue; if (dx === 0 && dz === 0 && y < G + 6) continue; set(tx + dx, y, tz + dz, 'oak_leaves'); }
  // house
  for (let z = 8; z < 14; z++) for (let x = 6; x < 13; x++) { for (let y = G + 1; y < G + 15; y++) set(x, y, z, 'air'); set(x, G, z, 'oak_planks'); }
  for (let y = G + 1; y < G + 4; y++) for (let z = 8; z < 14; z++) for (let x = 6; x < 13; x++) if (x === 6 || x === 12 || z === 8 || z === 13) set(x, y, z, (x === 6 || x === 12) && (z === 8 || z === 13) ? 'oak_log' : 'cobblestone');
  set(9, G + 2, 8, 'glass'); set(9, G + 2, 13, 'air'); set(9, G + 1, 13, 'oak_door'); set(9, G + 2, 13, 'oak_door'); cells[I(9, G + 2, 13)] = P.oak_door + 1;
  set(11, G + 2, 10, 'glass'); set(6, G + 2, 11, 'glass');
  // pitched roof: stairs climb toward the ridge (facing=south on the north half, facing=north on the south half), slab ridge
  for (let x = 5; x < 14; x++) {
    for (let k = 0; k < 3; k++) { cells[I(x, G + 4 + k, 7 + k)] = P.stairs_s; set(x, G + 4 + k, 14 - k, 'oak_stairs'); }
    set(x, G + 7, 10, 'oak_slab'); set(x, G + 7, 11, 'oak_slab');
  }
  for (let k = 0; k < 3; k++) for (let z = 8 + k; z <= 13 - k; z++) { set(6, G + 4 + k, z, 'oak_planks'); set(12, G + 4 + k, z, 'oak_planks'); }
  set(9, G + 2, 8, 'glass_pane'); set(8, G + 2, 8, 'glass_pane'); set(10, G + 2, 8, 'glass_pane');
  set(10, G + 2, 14, 'wall_torch'); set(8, G + 2, 14, 'wall_torch');
  set(14, G + 2, 14, 'lantern'); for (let z = 15; z < 18; z++) set(9, G + 1, z, 'stone_brick_stairs'); set(15, G + 1, 12, 'oak_trapdoor');
  set(7, G + 1, 9, 'chest'); set(8, G + 1, 9, 'crafting_table'); set(10, G + 1, 9, 'furnace'); set(11, G + 2, 12, 'torch');
  set(11, G + 1, 11, 'red_bed'); set(11, G + 1, 12, 'red_bed'); cells[I(11, G + 1, 12)] = P.red_bed + 1;
  // fence + ores + cave
  for (let x = 14; x < 20; x++) set(x, G + 2, 18, 'oak_fence');
  for (let x = 18; x < 30; x++) for (let y = 2; y < 5; y++) set(x, y, 20, 'air');
  set(20, 1, 20, 'iron_ore'); set(24, 5, 21, 'diamond_ore'); set(26, 1, 20, 'lava'); set(21, 3, 19, 'iron_ore');
  // light: sky 15 straight down from open sky, then spread sideways (-1 per step) like the real game
  const clear = (p) => !p || /leaves|water|glass|grass$|poppy|torch|fence|door|pane|lantern|slab|stairs|trapdoor/.test(palette[p]);
  const sky = new Uint8Array(cells.length); const q = [];
  for (let z = 0; z < size.z; z++) for (let x = 0; x < size.x; x++) for (let y = size.y - 1; y >= 0 && clear(cells[I(x, y, z)]); y--) { sky[I(x, y, z)] = 15; q.push(x, y, z); }
  while (q.length) { const z = q.pop(), y = q.pop(), x = q.pop(); const l = sky[I(x, y, z)]; if (l <= 1) continue;
    for (const [dx, dy, dz] of [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]]) { const a = x + dx, b = y + dy, c = z + dz; if (a < 0 || b < 0 || c < 0 || a >= size.x || b >= size.y || c >= size.z) continue; const j = I(a, b, c); if (!clear(cells[j]) || sky[j] >= l - 1) continue; sky[j] = l - 1; q.push(a, b, c); } }
  for (let i = 0; i < cells.length; i++) light[i] = sky[i] << 4;
  for (let y = G + 1; y < G + 4; y++) for (let z = 9; z < 13; z++) for (let x = 7; x < 12; x++) light[I(x, y, z)] |= 13;
  for (let x = 18; x < 30; x++) for (let y = 2; y < 5; y++) light[I(x, y, 20)] |= x > 23 ? 12 : 3;
  return { v: 1, kind: 'blocks', origin, size, palette, cells, light, lightOk: true,
    entities: [{ id: 1, kind: 'player', name: 'Flint', pos: { x: 418.5, y: 65, z: 416.5 }, yaw: 1, pitch: 0, h: 1.8, w: 0.6 }, { id: 2, kind: 'hostile', name: 'zombie', pos: { x: 424.5, y: 65, z: 420.5 }, yaw: 0, pitch: 0, h: 1.95, w: 0.6 }, { id: 3, kind: 'animal', name: 'cow', pos: { x: 413.5, y: 65, z: 425.5 }, yaw: 0, pitch: 0, h: 1.4, w: 0.9 }],
    chests: [{ x: 407, y: 65, z: 409, name: 'chest' }],
    bot: { name: 'Ash', pos: { x: 416.5, y: 65, z: 418.5 }, eye: { x: 416.5, y: 66.62, z: 418.5 }, yaw: 0.6, pitch: -0.15 }, center: { x: 416, y: 65, z: 416 }, time: { timeOfDay: 6000, isDay: true }, dimension: 'overworld', unloaded: 0, ms: 0 };
}

if ((process.argv[1] || '').endsWith('viewer-synth.mjs')) {
  const out = path.resolve('data/viewer-test'); fs.mkdirSync(out, { recursive: true });
  const snap = synthSnapshot();
  const runs = [
    ['orbit', { camera: { mode: 'orbit' } }],
    ['closeup', { camera: { mode: 'orbit', target: { x: 409.5, y: 67, z: 414 }, from: 'southeast', distance: 9, elevation: 22 } }],
    ['closeup-n', { camera: { mode: 'orbit', target: { x: 409.5, y: 67, z: 408 }, from: 'northwest', distance: 9, elevation: 25 } }],
    ['night', { camera: { mode: 'orbit', target: { x: 409.5, y: 67, z: 414 }, from: 'south', distance: 12, elevation: 25 }, snapPatch: { time: { timeOfDay: 18000, isDay: false } } }],
    ['slice', { camera: { mode: 'slice', y: 66 }, toggles: { grid: true } }],
    ['first', { camera: { mode: 'first_person' } }],
    ['map', { camera: { mode: 'map' }, toggles: { grid: true } }],
    ['xray', { camera: { mode: 'orbit', from: 'southeast', elevation: 30 }, toggles: { xray: true, highlight: true } }],
    ['ghost', { ghosts: Array.from({ length: 5 }, (_, i) => ({ x: 414 + i, y: 66, z: 412, block: 'stone_bricks' })).concat([{ x: 418, y: 65, z: 412, block: 'oak_stairs', props: { facing: 'west', half: 'bottom', shape: 'straight' } }, { x: 407, y: 65, z: 409, block: 'stone' }]) }],
  ];
  for (const [name, o] of runs) {
    const t = Date.now();
    const { png, meta } = await renderView({ snapshot: Object.assign(structuredClone(snap), o.snapPatch || {}), ...o });
    fs.writeFileSync(path.join(out, `synth-${name}.png`), png);
    console.log(name, png.length, 'bytes', Date.now() - t, 'ms', meta.view, meta.faces, JSON.stringify(meta.ghosts || ''));
  }
  await closeViewer();
}
