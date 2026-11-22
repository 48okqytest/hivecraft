// Minecraft block assets for the viewer (MAIN bridge process only).
// Reads blockstates / block models / textures straight out of the local Minecraft 1.21.1 client jar
// (env HIVE_MC_JAR, else %APPDATA%\.minecraft\versions\1.21.1\1.21.1.jar), packs every block texture into one
// atlas PNG and "bakes" block states into quads the browser mesher (web/mesher.js) can draw.
//
//   const A = await loadAssets();   // cached; ~1 s the first time
//   A.atlasPng (Buffer), A.atlasW, A.atlasH, A.tints, A.bake(stateKey) -> baked
//
// stateKey = 'oak_stairs[facing=north,half=bottom,shape=straight]' (props sorted) or just 'stone'.
// baked = { name, quads:[{p:[12], uv:[8], d, c, t, s, b, L}], occ, layer, liquid, wl, emit, cube, selfCull }
//   p   4 corners (block-local, 0..1)  uv  atlas uv (0..1) per corner   d face dir 0..5 (D,U,N,S,W,E)
//   c   cullface dir or -1             t   tint index or -1            s  shade (bool)
//   b   face lies on the block boundary plane in direction d (for neighbour light/AO)
//   L   layer of this quad: 0 solid, 1 cutout, 2 translucent
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import yauzl from 'yauzl';
import { PNG } from 'pngjs';
import minecraftData from 'minecraft-data';

const DIRS = ['down', 'up', 'north', 'south', 'west', 'east'];
const DIR_VEC = [[0, -1, 0], [0, 1, 0], [0, 0, -1], [0, 0, 1], [-1, 0, 0], [1, 0, 0]];
export { DIRS, DIR_VEC };

export function jarPath() {
  if (process.env.HIVE_MC_JAR) return process.env.HIVE_MC_JAR;
  const appdata = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  const cands = [
    path.join(appdata, '.minecraft', 'versions', '1.21.1', '1.21.1.jar'),
    path.join(appdata, '.minecraft', 'versions', 'hivecraft-1.21.1', 'hivecraft-1.21.1.jar'),
  ];
  for (const c of cands) if (fs.existsSync(c)) return c;
  throw new Error(`Minecraft 1.21.1 client jar not found (looked in ${cands.join(', ')}); set HIVE_MC_JAR`);
}

function readJar(file, want) {
  return new Promise((resolve, reject) => {
    const out = new Map();
    yauzl.open(file, { lazyEntries: true }, (err, zip) => {
      if (err) return reject(err);
      zip.on('entry', (e) => {
        if (!want(e.fileName)) return zip.readEntry();
        zip.openReadStream(e, (er, rs) => {
          if (er) return reject(er);
          const chunks = [];
          rs.on('data', (c) => chunks.push(c));
          rs.on('end', () => { out.set(e.fileName, Buffer.concat(chunks)); zip.readEntry(); });
          rs.on('error', reject);
        });
      });
      zip.on('end', () => resolve(out));
      zip.on('error', reject);
      zip.readEntry();
    });
  });
}

const PREFIX = 'assets/minecraft/';
const strip = (n) => String(n).replace(/^minecraft:/, '');

// ---------------------------------------------------------------- atlas
function packAtlas(textures) {
  // textures: [{name, png}] -> shelf pack; every texture is cropped to its first square frame (animations)
  const items = textures.map((t) => {
    const w = t.png.width; const h = Math.min(t.png.height, t.png.width);
    return { ...t, w, h };
  }).sort((a, b) => b.h - a.h || a.name.localeCompare(b.name));
  const W = 2048; let x = 0, y = 0, rowH = 0;
  for (const it of items) {
    if (x + it.w > W) { x = 0; y += rowH; rowH = 0; }
    it.x = x; it.y = y; x += it.w; rowH = Math.max(rowH, it.h);
  }
  let H = 1; while (H < y + rowH) H *= 2;
  const atlas = new PNG({ width: W, height: H });
  atlas.data.fill(0);
  const rects = new Map();
  for (const it of items) {
    let anyCut = false, anyTrans = 0;
    const n = it.w * it.h;
    for (let yy = 0; yy < it.h; yy++) {
      for (let xx = 0; xx < it.w; xx++) {
        const si = (yy * it.png.width + xx) * 4; const di = ((it.y + yy) * W + it.x + xx) * 4;
        const a = it.png.data[si + 3];
        atlas.data[di] = it.png.data[si]; atlas.data[di + 1] = it.png.data[si + 1]; atlas.data[di + 2] = it.png.data[si + 2]; atlas.data[di + 3] = a;
        if (a < 250 && a > 5) anyTrans++; else if (a <= 5) anyCut = true;
      }
    }
    // flag: 0 solid, 1 cutout (has holes), 2 translucent (real partial alpha)
    const flag = anyTrans > n * 0.1 ? 2 : (anyCut || anyTrans) ? 1 : 0;
    rects.set(it.name, { x: it.x, y: it.y, w: it.w, h: it.h, flag });
  }
  return { png: PNG.sync.write(atlas), W, H, rects, atlasData: atlas.data };
}

function avgColor(atlas, r) {
  let R = 0, G = 0, B = 0, n = 0;
  for (let yy = 0; yy < r.h; yy++) for (let xx = 0; xx < r.w; xx++) {
    const i = ((r.y + yy) * atlas.W + r.x + xx) * 4;
    if (atlas.atlasData[i + 3] < 128) continue;
    R += atlas.atlasData[i]; G += atlas.atlasData[i + 1]; B += atlas.atlasData[i + 2]; n++;
  }
  return n ? [R / n / 255, G / n / 255, B / n / 255] : [0.5, 0.5, 0.5];
}

// ---------------------------------------------------------------- geometry helpers
function faceCorners(dir, f, t) {
  const [x0, y0, z0] = f, [x1, y1, z1] = t;
  switch (dir) { // TL, TR, BR, BL as seen from outside (texture space)
    case 'up': return [[x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1]];
    case 'down': return [[x0, y0, z1], [x1, y0, z1], [x1, y0, z0], [x0, y0, z0]];
    case 'north': return [[x1, y1, z0], [x0, y1, z0], [x0, y0, z0], [x1, y0, z0]];
    case 'south': return [[x0, y1, z1], [x1, y1, z1], [x1, y0, z1], [x0, y0, z1]];
    case 'west': return [[x0, y1, z0], [x0, y1, z1], [x0, y0, z1], [x0, y0, z0]];
    case 'east': return [[x1, y1, z1], [x1, y1, z0], [x1, y0, z0], [x1, y0, z1]];
  }
  return null;
}
function defaultUV(dir, f, t) {
  const [x0, y0, z0] = f, [x1, y1, z1] = t;
  switch (dir) {
    case 'up': return [x0, z0, x1, z1];
    case 'down': return [x0, 16 - z1, x1, 16 - z0];
    case 'north': return [16 - x1, 16 - y1, 16 - x0, 16 - y0];
    case 'south': return [x0, 16 - y1, x1, 16 - y0];
    case 'west': return [z0, 16 - y1, z1, 16 - y0];
    case 'east': return [16 - z1, 16 - y1, 16 - z0, 16 - y0];
  }
  return [0, 0, 16, 16];
}
function projUV(d, p) { // uvlock: world-aligned uv for a point on a face pointing d
  const [x, y, z] = p;
  switch (d) {
    case 1: return [x, z];
    case 0: return [x, 16 - z];
    case 2: return [16 - x, 16 - y];
    case 3: return [x, 16 - y];
    case 4: return [z, 16 - y];
    case 5: return [16 - z, 16 - y];
  }
  return [0, 0];
}
function rotAxis(p, axis, deg, o = [8, 8, 8], rescale = false) {
  const a = (deg * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
  let [x, y, z] = [p[0] - o[0], p[1] - o[1], p[2] - o[2]];
  const k = rescale ? 1 / Math.cos(Math.abs(a)) : 1;
  if (axis === 'x') { const ny = y * c - z * s, nz = y * s + z * c; y = ny * k; z = nz * k; }
  else if (axis === 'y') { const nx = x * c + z * s, nz = -x * s + z * c; x = nx * k; z = nz * k; }
  else { const nx = x * c - y * s, ny = x * s + y * c; x = nx * k; y = ny * k; }
  return [x + o[0], y + o[1], z + o[2]];
}
// blockstate rotations: x then y, in 90° steps (MC: y:90 turns north -> east; x:90 turns north -> down)
function rotVariant(p, rx, ry) {
  let [x, y, z] = [p[0] - 8, p[1] - 8, p[2] - 8];
  for (let i = 0; i < ((rx / 90) & 3); i++) { const ny = z, nz = -y; y = ny; z = nz; }
  for (let i = 0; i < ((ry / 90) & 3); i++) { const nx = -z, nz = x; x = nx; z = nz; }
  return [x + 8, y + 8, z + 8];
}
function rotDir(d, rx, ry) {
  if (d < 0) return d;
  const v = rotVariant([8 + DIR_VEC[d][0], 8 + DIR_VEC[d][1], 8 + DIR_VEC[d][2]], rx, ry).map((q) => Math.round(q - 8));
  return vecDir(v);
}
function vecDir(v) {
  const ax = Math.abs(v[0]), ay = Math.abs(v[1]), az = Math.abs(v[2]);
  if (ay >= ax && ay >= az) return v[1] < 0 ? 0 : 1;
  if (az >= ax) return v[2] < 0 ? 2 : 3;
  return v[0] < 0 ? 4 : 5;
}
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

// ---------------------------------------------------------------- loader
let loading = null;
export function loadAssets() {
  if (!loading) loading = doLoad().catch((e) => { loading = null; throw e; });
  return loading;
}

async function doLoad() {
  const t0 = Date.now();
  const jar = jarPath();
  const files = await readJar(jar, (n) => n.startsWith(PREFIX + 'blockstates/') || n.startsWith(PREFIX + 'models/block/') ||
    (n.startsWith(PREFIX + 'textures/block/') && n.endsWith('.png')) || n.startsWith(PREFIX + 'textures/entity/chest/') ||
    n.startsWith(PREFIX + 'textures/colormap/'));
  const json = (n) => { const b = files.get(PREFIX + n); return b ? JSON.parse(b.toString('utf8')) : null; };
  const texList = [];
  for (const [n, buf] of files) {
    const m = /^assets\/minecraft\/textures\/((block|entity\/chest)\/.+)\.png$/.exec(n);
    if (!m) continue;
    try { texList.push({ name: m[1], png: PNG.sync.read(buf) }); } catch { /* skip odd png */ }
  }
  const atlas = packAtlas(texList);
  const mc = minecraftData('1.21.1');

  // biome-ish tints (plains): colormap sample at temperature 0.8, downfall 0.4
  const tintFrom = (file, temp = 0.8, rain = 0.4) => {
    const b = files.get(PREFIX + `textures/colormap/${file}.png`); if (!b) return null;
    const p = PNG.sync.read(b); rain *= temp;
    const x = Math.round((1 - temp) * 255), y = Math.round((1 - rain) * 255);
    const i = (y * p.width + x) * 4; return [p.data[i] / 255, p.data[i + 1] / 255, p.data[i + 2] / 255];
  };
  const hex = (h) => [((h >> 16) & 255) / 255, ((h >> 8) & 255) / 255, (h & 255) / 255];
  const tints = {
    grass: tintFrom('grass') || hex(0x91bd59), foliage: tintFrom('foliage') || hex(0x77ab2f),
    water: hex(0x3f76e4), spruce: hex(0x619961), birch: hex(0x80a755), lily: hex(0x208030), stem: hex(0x9fd03b),
    redstone: hex(0xc80000), mangrove: hex(0x8db127),
  };

  // ---------- models
  const modelCache = new Map();
  function model(name) {
    name = strip(name).replace(/^block\//, 'block/');
    if (modelCache.has(name)) return modelCache.get(name);
    let m = json(`models/${name}.json`);
    let res;
    if (!m) res = { textures: {}, elements: null, builtin: true };
    else {
      const parent = m.parent ? model(m.parent) : { textures: {}, elements: null };
      res = { textures: { ...parent.textures, ...(m.textures || {}) }, elements: m.elements || parent.elements, ao: m.ambientocclusion ?? parent.ao, builtin: !m.elements && parent.builtin };
    }
    modelCache.set(name, res);
    return res;
  }
  function resolveTex(m, ref, depth = 0) {
    if (!ref) return null;
    if (ref.startsWith('#')) { if (depth > 8) return null; return resolveTex(m, m.textures[ref.slice(1)], depth + 1); }
    return strip(ref);
  }

  const rect = (tex) => atlas.rects.get(tex) || null;
  function toAtlasUV(r, u, v) { // u,v in 0..16 texture space
    const eps = 0.02;
    const uu = Math.min(Math.max(u / 16 * r.w, eps), r.w - eps), vv = Math.min(Math.max(v / 16 * r.h, eps), r.h - eps);
    return [(r.x + uu) / atlas.W, (r.y + vv) / atlas.H];
  }

  // emit one element list (16-space) through a variant rotation into quads
  function bakeElements(elements, texOf, { x: rx = 0, y: ry = 0, uvlock = false } = {}, out) {
    for (const el of elements) {
      for (const dir of DIRS) {
        const face = el.faces?.[dir]; if (!face) continue;
        const tex = texOf(face.texture); const r = tex && rect(tex); if (!r) continue;
        let corners = faceCorners(dir, el.from, el.to);
        if (el.rotation && el.rotation.angle) corners = corners.map((p) => rotAxis(p, el.rotation.axis, el.rotation.angle, el.rotation.origin, el.rotation.rescale));
        corners = corners.map((p) => rotVariant(p, rx, ry));
        const nrm = cross(sub(corners[3], corners[0]), sub(corners[1], corners[0]));
        const d = vecDir(nrm);
        // uv corners
        let uvs;
        if (uvlock && (rx || ry)) uvs = corners.map((p) => projUV(d, p));
        else {
          const [u0, v0, u1, v1] = face.uv || defaultUV(dir, el.from, el.to);
          const base = [[u0, v0], [u1, v0], [u1, v1], [u0, v1]];
          const k = ((face.rotation || 0) / 90) & 3;
          uvs = base.map((_, i) => base[(i + k) & 3]);
        }
        const p = []; const uv = [];
        for (let i = 0; i < 4; i++) { p.push(corners[i][0] / 16, corners[i][1] / 16, corners[i][2] / 16); const a = toAtlasUV(r, uvs[i][0], uvs[i][1]); uv.push(a[0], a[1]); }
        const pc = corners.map((q) => q[[1, 1, 2, 2, 0, 0][d]]);
        const plane = [0, 16, 0, 16, 0, 16][d];
        const b = pc.every((q) => Math.abs(q - plane) < 0.01);
        out.push({ p, uv, d, c: face.cullface ? rotDir(DIRS.indexOf(face.cullface === 'bottom' ? 'down' : face.cullface), rx, ry) : -1, t: face.tintindex ?? -1, s: el.shade !== false, b, L: r.flag });
      }
    }
  }

  // ---------- state matching
  const matchWhen = (when, props) => {
    if (!when) return true;
    if (when.OR) return when.OR.some((w) => matchWhen(w, props));
    if (when.AND) return when.AND.every((w) => matchWhen(w, props));
    return Object.entries(when).every(([k, v]) => String(v).split('|').includes(String(props[k])));
  };
  const pickVariant = (v) => (Array.isArray(v) ? v[0] : v);

  const AIR = /^(air|cave_air|void_air|light|barrier|structure_void|moving_piston)$/;
  const IMPLICIT_WATER = /^(water|bubble_column|kelp|kelp_plant|seagrass|tall_seagrass)$/;
  const SELF_CULL = /(glass|glass_pane|ice|slime_block|honey_block)$/;
  const blocksByName = mc.blocksByName;

  function parseKey(key) {
    const m = /^([a-z0-9_]+)(?:\[(.*)\])?$/.exec(strip(key));
    const props = {};
    if (m && m[2]) for (const kv of m[2].split(',')) { const [k, v] = kv.split('='); if (k) props[k] = v; }
    return { name: m ? m[1] : strip(key), props };
  }

  function tintFor(name) {
    if (/^(birch_leaves)$/.test(name)) return 'birch';
    if (/^(spruce_leaves)$/.test(name)) return 'spruce';
    if (/^mangrove_leaves$/.test(name)) return 'mangrove';
    if (/_leaves$|^vine$/.test(name)) return 'foliage';
    if (/^(water|bubble_column|water_cauldron)$/.test(name)) return 'water';
    if (name === 'lily_pad') return 'lily';
    if (/_stem$/.test(name)) return 'stem';
    if (name === 'redstone_wire') return 'redstone';
    return 'grass';
  }

  // hand-made geometry for blocks drawn by entity renderers in the real client
  function special(name, props) {
    const facingY = { north: 0, east: 90, south: 180, west: 270 }[props.facing] ?? 0;
    if (/^(chest|trapped_chest|ender_chest)$/.test(name)) {
      const t = name === 'ender_chest' ? 'entity/chest/ender' : name === 'trapped_chest' ? 'entity/chest/trapped' : 'entity/chest/normal';
      const q = (a) => a.map((v) => v / 4);
      const box = (from, to, u, v, w, h, d) => ({
        from, to, faces: {
          up: { texture: t, uv: q([u + d + w, v + d, u + d, v]) }, down: { texture: t, uv: q([u + d + 2 * w, v, u + d + w, v + d]) },
          north: { texture: t, uv: q([u + d, v + d + h, u + d + w, v + d]) }, south: { texture: t, uv: q([u + 2 * d + w, v + d + h, u + 2 * d + 2 * w, v + d]) },
          west: { texture: t, uv: q([u + d + w, v + d + h, u + 2 * d + w, v + d]) }, east: { texture: t, uv: q([u, v + d + h, u + d, v + d]) },
        },
      });
      return { elements: [box([1, 0, 1], [15, 10, 15], 0, 19, 14, 10, 14), box([1, 10, 1], [15, 14, 15], 0, 0, 14, 4, 14), box([7, 7, 0], [9, 11, 1], 0, 0, 2, 4, 1)], rot: { y: facingY } };
    }
    if (/_bed$/.test(name)) {
      const wool = `block/${name.replace(/_bed$/, '')}_wool`;
      const side = { texture: wool }; const legs = { texture: 'block/oak_planks' };
      return { elements: [{ from: [0, 3, 0], to: [16, 9, 16], faces: { up: { texture: wool }, north: side, south: side, east: side, west: side, down: legs } },
        { from: [0, 0, 0], to: [3, 3, 3], faces: { north: legs, south: legs, east: legs, west: legs } }, { from: [13, 0, 13], to: [16, 3, 16], faces: { north: legs, south: legs, east: legs, west: legs } }], rot: {} };
    }
    if (/_wall_sign$|_wall_hanging_sign$/.test(name)) {
      const wood = `block/${name.replace(/_wall(_hanging)?_sign$/, '')}_planks`; const f = { texture: wood };
      return { elements: [{ from: [0, 4.5, 14], to: [16, 12.5, 16], faces: { north: f, south: f, east: f, west: f, up: f, down: f } }], rot: { y: facingY } };
    }
    if (/_sign$|_hanging_sign$/.test(name)) {
      const wood = `block/${name.replace(/(_hanging)?_sign$/, '')}_planks`; const f = { texture: wood }; const lg = { texture: `block/${name.replace(/(_hanging)?_sign$/, '')}_log` };
      return { elements: [{ from: [0, 8, 7], to: [16, 16, 9], faces: { north: f, south: f, east: f, west: f, up: f, down: f } }, { from: [7, 0, 7], to: [9, 8, 9], faces: { north: lg, south: lg, east: lg, west: lg } }], rot: { y: (Number(props.rotation) || 0) * 22.5 >= 0 ? Math.round(((Number(props.rotation) || 0) * 22.5) / 90) * 90 % 360 : 0 } };
    }
    return null;
  }

  const bakedCache = new Map();
  function bake(key) {
    if (bakedCache.has(key)) return bakedCache.get(key);
    const { name, props } = parseKey(key);
    const info = blocksByName[name];
    const res = { name, quads: [], occ: false, layer: 0, liquid: null, wl: false, emit: info?.emitLight || 0, cube: false, selfCull: SELF_CULL.test(name), air: AIR.test(name) };
    if (res.air) { bakedCache.set(key, res); return res; }
    if (name === 'water' || name === 'bubble_column') res.liquid = 'water';
    else if (name === 'lava') res.liquid = 'lava';
    res.wl = props.waterlogged === 'true' || IMPLICIT_WATER.test(name);
    const tint = tintFor(name);
    if (!res.liquid) {
      const sp = special(name, props);
      if (sp) {
        bakeElements(sp.elements, (t) => strip(t), sp.rot, res.quads);
      } else {
        const bs = json(`blockstates/${name}.json`);
        const parts = [];
        if (bs?.variants) {
          const entries = Object.entries(bs.variants);
          const hit = entries.find(([k]) => k === '' || k.split(',').every((kv) => { const [a, b] = kv.split('='); return String(props[a]) === b; })) || entries[0];
          if (hit) parts.push(pickVariant(hit[1]));
        } else if (bs?.multipart) {
          for (const part of bs.multipart) if (matchWhen(part.when, props)) parts.push(pickVariant(part.apply));
        }
        for (const v of parts) {
          const m = model(v.model);
          if (!m.elements) continue;
          bakeElements(m.elements, (ref) => resolveTex(m, ref), v, res.quads);
        }
        if (!res.quads.length && parts.length) { // builtin / entity-rendered: small cube with the particle texture
          const m = model(parts[0].model); const pt = resolveTex(m, '#particle');
          if (pt && rect(pt)) {
            const f = { texture: pt };
            bakeElements([{ from: [3, 0, 3], to: [13, 12, 13], faces: { up: f, down: f, north: f, south: f, west: f, east: f } }], (t) => t, {}, res.quads);
          }
        }
      }
    }
    for (const q of res.quads) q.tint = q.t >= 0 ? tint : null;
    // occludes neighbours only if it is a full opaque cube (6 boundary faces, all solid, covering the whole side)
    const full = [0, 0, 0, 0, 0, 0];
    for (const q of res.quads) {
      if (!q.b || q.L !== 0) continue;
      const xs = [], ys = [], zs = [];
      for (let i = 0; i < 4; i++) { xs.push(q.p[i * 3]); ys.push(q.p[i * 3 + 1]); zs.push(q.p[i * 3 + 2]); }
      const span = (a) => Math.max(...a) - Math.min(...a);
      const area = q.d < 2 ? span(xs) * span(zs) : q.d < 4 ? span(xs) * span(ys) : span(zs) * span(ys);
      if (area > 0.999) full[q.d] = 1;
    }
    res.cube = full.every(Boolean);
    res.occ = res.cube && !res.liquid;
    res.layer = res.liquid === 'water' ? 2 : res.quads.reduce((m, q) => Math.max(m, q.L), 0);
    if (res.layer > 0 && res.quads.every((q) => q.L === 0)) res.layer = 0;
    // a cube whose base faces are solid but carries a cutout overlay (grass_block) still occludes
    bakedCache.set(key, res);
    return res;
  }

  // flat map colour per block (team map): average of the top texture
  const colorCache = new Map();
  function mapColor(key) {
    if (colorCache.has(key)) return colorCache.get(key);
    const b = bake(key);
    let c = [0, 0, 0];
    if (b.liquid === 'water') c = tints.water.map((v) => v * 0.9);
    else if (b.liquid === 'lava') c = [0.85, 0.35, 0.05];
    else {
      const top = b.quads.filter((q) => q.d === 1 && q.L !== 2).sort((a, z) => (a.t >= 0) - (z.t >= 0))[0] || b.quads[0];
      if (top) {
        const u = (top.uv[0] + top.uv[4]) / 2 * atlas.W, v = (top.uv[1] + top.uv[5]) / 2 * atlas.H;
        const r = [...atlas.rects.values()].find((rr) => u >= rr.x && u < rr.x + rr.w && v >= rr.y && v < rr.y + rr.h);
        c = r ? avgColor(atlas, r) : [0.5, 0.5, 0.5];
        if (top.t >= 0 && top.tint) c = c.map((v2, i) => v2 * tints[top.tint][i]);
        if (name0(key) === 'grass_block') c = tints.grass.map((v2) => v2 * 0.75);
      }
    }
    colorCache.set(key, c);
    return c;
  }
  const name0 = (k) => parseKey(k).name;

  const uvRect = (tex) => { const r = rect(tex); return r ? [(r.x + 0.02) / atlas.W, (r.y + 0.02) / atlas.H, (r.x + r.w - 0.02) / atlas.W, (r.y + Math.min(r.h, r.w) - 0.02) / atlas.H] : null; };
  const res = { uvRect, atlasPng: atlas.png, atlasW: atlas.W, atlasH: atlas.H, tints, bake, mapColor, parseKey, jar, ms: Date.now() - t0, textureCount: atlas.rects.size };
  return res;
}

/** Bake a whole palette for the browser: [{...baked}] with quads flattened for transfer. */
export function bakePalette(A, palette) {
  return palette.map((key) => {
    const b = A.bake(key);
    return { n: b.name, q: b.quads.map((q) => [q.p, q.uv, q.d, q.c, q.tint ? A.tints[q.tint] : null, q.s ? 1 : 0, q.b ? 1 : 0, q.L]), occ: b.occ ? 1 : 0, layer: b.layer, liq: b.liquid, wl: b.wl ? 1 : 0, emit: b.emit, sc: b.selfCull ? 1 : 0, air: b.air ? 1 : 0, cube: b.cube ? 1 : 0, level: Number(A.parseKey(key).props.level ?? 0) };
  });
}
