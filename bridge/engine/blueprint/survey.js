// Site analysis: ground heightmap, flatness, trees / water / lava, cut & fill volumes, best build site.
// Works on a blockAt(x,y,z) -> {name, boundingBox} | null function (bot world or a fake world in tests).

const PLANT = /(_leaves|_log|_wood|_stem|_hyphae|^short_grass|^tall_grass|^grass$|^fern|^large_fern|_sapling|^dead_bush|^vine|^sugar_cane|^bamboo|_mushroom$|^cactus|^sweet_berry_bush|^snow$|^pink_petals|^lily_pad|^cocoa|^dandelion|^poppy|_tulip|^azure_bluet|^allium|^blue_orchid|^oxeye_daisy|^cornflower|^lily_of_the_valley|^sunflower|^lilac|^rose_bush|^peony|^seagrass|^tall_seagrass|^kelp|^kelp_plant|^moss_carpet|^glow_lichen|^hanging_roots|_roots$|^big_dripleaf|^small_dripleaf|^torchflower|^pitcher_plant|^mangrove_propagule)/;
const TREE = /(_leaves|_log|_wood|_stem|_hyphae|^bamboo|^mangrove_roots)$/;
const AIR = new Set(['air', 'cave_air', 'void_air']);

/**
 * Column info: ground = y of the top "ground" block (not plants/trees/liquids), surface = what's on top
 * ('ground' | 'water' | 'lava'), liquidDepth, tree (trunk/leaves over the column), plant.
 */
export function columnInfo(blockAt, x, z, { top, bottom, hint }) {
  let start = top;
  if (hint !== undefined) start = Math.min(top, hint + 12);
  let tree = false, plant = false, liquid = null, liquidDepth = 0;
  // if the start block is already solid ground, look up a bit to find the real top
  let b = blockAt(x, start, z);
  if (b === null) return null;
  if (b && !AIR.has(b.name) && start < top) {
    for (let y = start + 1; y <= top; y++) { const u = blockAt(x, y, z); if (!u) return null; if (AIR.has(u.name)) { start = y; break; } if (y === top) start = top; }
  }
  for (let y = start; y >= bottom; y--) {
    b = blockAt(x, y, z);
    if (!b) return null;
    const n = b.name;
    if (AIR.has(n)) continue;
    if (n === 'water' || n === 'lava' || n === 'bubble_column') { if (!liquid) liquid = n === 'lava' ? 'lava' : 'water'; liquidDepth++; continue; }
    if (TREE.test(n)) { tree = true; continue; }
    if (PLANT.test(n)) { plant = true; continue; }
    return { x, z, ground: y, block: n, surface: liquid || 'ground', liquidDepth, tree, plant };
  }
  return { x, z, ground: bottom, block: 'unknown', surface: liquid || 'void', liquidDepth, tree, plant };
}

/** heightmap for the rectangle x0..x0+w-1, z0..z0+d-1 */
export function heightmap(blockAt, x0, z0, w, d, { refY = 64, range = 48 } = {}) {
  const top = Math.min(319, refY + range), bottom = Math.max(-63, refY - range);
  const cols = [];
  let unloaded = 0;
  for (let dz = 0; dz < d; dz++) {
    const row = [];
    let hint;
    for (let dx = 0; dx < w; dx++) {
      const c = columnInfo(blockAt, x0 + dx, z0 + dz, { top, bottom, hint: hint ?? (dz > 0 ? cols[dz - 1][dx]?.ground : undefined) });
      if (!c) unloaded++;
      row.push(c);
      if (c) hint = c.ground;
    }
    cols.push(row);
  }
  return { x0, z0, w, d, cols, unloaded };
}

const median = (a) => { if (!a.length) return 0; const s = [...a].sort((p, q) => p - q); return s[Math.floor(s.length / 2)]; };

/** stats for a footprint (sub-rectangle of a heightmap) at a given base ground level (the floor sits on base) */
export function footprintStats(hm, fx, fz, w, d, base) {
  const hs = [];
  let water = 0, lava = 0, trees = 0, plants = 0, unloaded = 0, cut = 0, fill = 0, maxCut = 0, maxFill = 0;
  for (let z = fz; z < fz + d; z++) for (let x = fx; x < fx + w; x++) {
    const c = hm.cols[z - hm.z0]?.[x - hm.x0];
    if (!c) { unloaded++; continue; }
    hs.push(c.ground);
    if (c.surface === 'water') water++;
    if (c.surface === 'lava') lava++;
    if (c.tree) trees++;
    if (c.plant) plants++;
  }
  const b = base ?? median(hs);
  for (const h of hs) { if (h > b) { cut += h - b; maxCut = Math.max(maxCut, h - b); } else if (h < b) { fill += b - h; maxFill = Math.max(maxFill, b - h); } }
  const mean = hs.reduce((a, v) => a + v, 0) / (hs.length || 1);
  const sd = Math.sqrt(hs.reduce((a, v) => a + (v - mean) ** 2, 0) / (hs.length || 1));
  const n = w * d;
  // 100 = perfectly flat dry clear ground; minus terrain work
  const flatness = Math.max(0, Math.round(100 - (cut + fill) * 100 / (n * 2) - sd * 8));
  const cost = cut * 1.2 + fill * 1.0 + water * 6 + lava * 400 + trees * 5 + unloaded * 1000;
  return { base: b, min: hs.length ? Math.min(...hs) : null, max: hs.length ? Math.max(...hs) : null, sd: Math.round(sd * 10) / 10, cut, fill, maxCut, maxFill, water, lava, trees, plants, unloaded, flatness, cost: Math.round(cost) };
}

/**
 * ASCII grid: '=' at base level, 1-9 = blocks above base, a-i = below base (a=-1), '~' water, '!' lava, 'T' tree,
 * '?' unloaded, '#' >9 above, '_' >9 below. Optional mark rectangle drawn with uppercase-free border markers.
 */
export function asciiGrid(hm, base, { mark } = {}) {
  const lines = [];
  const header = `   x ${hm.x0}..${hm.x0 + hm.w - 1} (east ->), z ${hm.z0}..${hm.z0 + hm.d - 1} (south v)`;
  lines.push(header);
  for (let dz = 0; dz < hm.d; dz++) {
    let s = '';
    for (let dx = 0; dx < hm.w; dx++) {
      const c = hm.cols[dz][dx];
      let ch;
      if (!c) ch = '?';
      else if (c.surface === 'lava') ch = '!';
      else if (c.surface === 'water') ch = '~';
      else if (c.tree) ch = 'T';
      else {
        const d = c.ground - base;
        ch = d === 0 ? '=' : d > 0 ? (d > 9 ? '#' : String(d)) : (d < -9 ? '_' : String.fromCharCode(96 - d));
      }
      if (mark) {
        const x = hm.x0 + dx, z = hm.z0 + dz;
        const inside = x >= mark.x && x < mark.x + mark.w && z >= mark.z && z < mark.z + mark.d;
        if (!inside && ch === '=') ch = '.';
      }
      s += ch;
    }
    lines.push(`${String(hm.z0 + dz).padStart(5)} ${s}`);
  }
  return lines.join('\n');
}

/**
 * Best place for a w x d footprint within radius of (cx,cz). Returns sorted candidates [{x,z,y,stats}]:
 * x,z = min corner, y = first build layer (ground + 1).
 */
export function findBuildSites(blockAt, { cx, cz, refY, w, d, radius = 32, step = 2, avoid = [] }) {
  const x0 = cx - radius - w, z0 = cz - radius - d;
  const W = radius * 2 + w * 2, D = radius * 2 + d * 2;
  const hm = heightmap(blockAt, x0, z0, W, D, { refY });
  const cands = [];
  for (let fz = cz - radius - Math.floor(d / 2); fz <= cz + radius - Math.floor(d / 2); fz += step) {
    for (let fx = cx - radius - Math.floor(w / 2); fx <= cx + radius - Math.floor(w / 2); fx += step) {
      if (avoid.some((a) => fx < a.x + a.w + 2 && fx + w + 2 > a.x && fz < a.z + a.d + 2 && fz + d + 2 > a.z)) continue;
      const st = footprintStats(hm, fx, fz, w, d);
      if (st.unloaded || st.lava) continue;
      const dist = Math.hypot(fx + w / 2 - cx, fz + d / 2 - cz);
      cands.push({ x: fx, z: fz, y: st.base + 1, stats: st, score: st.cost + dist * 0.5 });
    }
  }
  cands.sort((a, b) => a.score - b.score);
  // drop heavy overlaps so the top 3 are distinct places
  const out = [];
  for (const c of cands) {
    if (out.some((o) => Math.abs(o.x - c.x) < w && Math.abs(o.z - c.z) < d)) continue;
    out.push(c);
    if (out.length >= 3) break;
  }
  return { sites: out, hm };
}

/** crop a heightmap to a rectangle (for printing) */
export function cropHm(hm, x, z, w, d) {
  const cols = [];
  for (let dz = 0; dz < d; dz++) cols.push(hm.cols[z - hm.z0 + dz]?.slice(x - hm.x0, x - hm.x0 + w) || []);
  return { x0: x, z0: z, w, d, cols };
}

export function describeStats(st) {
  const parts = [`ground y ${st.min}..${st.max} (base ${st.base}, sd ${st.sd})`, `flatness ${st.flatness}/100`, `cut ${st.cut} / fill ${st.fill} blocks`];
  if (st.water) parts.push(`${st.water} water columns`);
  if (st.lava) parts.push(`${st.lava} LAVA columns`);
  if (st.trees) parts.push(`${st.trees} tree columns`);
  if (st.unloaded) parts.push(`${st.unloaded} unloaded`);
  return parts.join(', ');
}
