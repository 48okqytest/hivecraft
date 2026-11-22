// Voxel mesher (browser side, shared by the headless renderer and the dashboard live view).
// Input: decoded snapshot + baked palette (from bridge/viewer/assets.js bakePalette). Output: THREE.Group.
// Face culling against opaque full cubes, per-vertex ambient occlusion, MC-style face shading and sky/block light.

const DV = [[0, -1, 0], [0, 1, 0], [0, 0, -1], [0, 0, 1], [-1, 0, 0], [1, 0, 0]];
const SHADE = [0.5, 1.0, 0.8, 0.8, 0.6, 0.6];
const AO = [0.5, 0.68, 0.84, 1.0];
// tangent axes per face dir (for AO corner sampling)
const TAN = [[0, 2], [0, 2], [0, 1], [0, 1], [2, 1], [2, 1]];
const XRAY_GROUND = /^(stone|deepslate|cobbled_deepslate|tuff|granite|diorite|andesite|calcite|dirt|coarse_dirt|rooted_dirt|grass_block|podzol|mycelium|gravel|sand|red_sand|sandstone|red_sandstone|clay|netherrack|basalt|blackstone|smooth_basalt|dripstone_block|mud|terracotta|.*_terracotta|snow_block|packed_ice|moss_block|soul_sand|soul_soil|end_stone|bedrock)$/;
const XRAY_HOT = /(_ore$|ancient_debris|chest|barrel|spawner|shulker_box|amethyst|lava|budding)/;

export function b64ToBytes(b64) {
  const s = atob(b64); const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export function decodeSnapshot(s) {
  if (s.cells && typeof s.cells === 'string') {
    const cb = b64ToBytes(s.cells); s.cells = new Uint16Array(cb.buffer, cb.byteOffset, cb.byteLength / 2);
  }
  if (s.light && typeof s.light === 'string') s.light = b64ToBytes(s.light);
  return s;
}

function lightCurve(l) { const f = l / 15; return 0.16 + 0.84 * (f / (4 - 3 * f)) ** 0.6; } // floor 0.16: caves stay readable

/**
 * opts: { dayF (0.15..1), nightVision, sliceY (abs y or null), xray, ghosts: [{x,y,z,pi(baked index), cls:'ok'|'done'|'conflict'|color}],
 *         ghostBaked: baked list for ghosts, liquidUV: {water:[u0,v0,u1,v1], lava:[...]}, tints }
 */
export function buildWorld(THREE, snap, baked, atlas, opts = {}) {
  const { origin, size } = snap; const SX = size.x, SY = size.y, SZ = size.z, SXZ = SX * SZ;
  const cells = snap.cells, light = snap.light;
  const sliceY = opts.sliceY == null ? null : opts.sliceY - origin.y;
  const nv = !!opts.nightVision; const dayF = nv ? 1 : (opts.dayF ?? 1);
  const xray = !!opts.xray;
  const ground = baked.map((b) => (xray && XRAY_GROUND.test(b.n) ? 1 : 0));
  const hot = baked.map((b) => (xray && XRAY_HOT.test(b.n) ? 1 : 0));

  const idx = (x, y, z) => (y * SZ + z) * SX + x;
  const inside = (x, y, z) => x >= 0 && y >= 0 && z >= 0 && x < SX && y < SY && z < SZ && (sliceY == null || y <= sliceY);
  const pal = (x, y, z) => (inside(x, y, z) ? cells[idx(x, y, z)] : 0);
  const occAt = (x, y, z) => { const p = pal(x, y, z); return p !== 0 && baked[p].occ === 1; };

  // fallback sky light when the server sent no light data: open sky above the column = 15
  let skyTop = null;
  if (!snap.lightOk && !nv) {
    skyTop = new Int16Array(SXZ).fill(-1);
    for (let z = 0; z < SZ; z++) for (let x = 0; x < SX; x++) {
      for (let y = SY - 1; y >= 0; y--) { const p = cells[idx(x, y, z)]; if (p && baked[p].occ) { skyTop[z * SX + x] = y; break; } }
    }
  }
  const lightAt = (x, y, z) => {
    if (nv) return 1;
    if (x < 0 || y < 0 || z < 0 || x >= SX || z >= SZ) return lightCurve(15 * dayF);
    if (y >= SY || (sliceY != null && y > sliceY)) return lightCurve(15 * dayF);
    let sky, blk;
    if (skyTop) { sky = y > skyTop[z * SX + x] ? 15 : 5; blk = 0; } else { const l = light[idx(x, y, z)]; sky = l >> 4; blk = l & 15; }
    return lightCurve(Math.max(sky * dayF, blk));
  };

  // geometry buckets: 0 solid, 1 cutout, 2 translucent, 3 xray-ground, 4.. ghosts
  const B = () => ({ pos: [], uv: [], col: [], ind: [], n: 0 });
  const buckets = [B(), B(), B(), B()];
  const pushQuad = (bk, ox, oy, oz, p, uv, cols, alpha = 1) => {
    const n = bk.n;
    for (let i = 0; i < 4; i++) {
      bk.pos.push(ox + p[i * 3], oy + p[i * 3 + 1], oz + p[i * 3 + 2]);
      bk.uv.push(uv[i * 2], 1 - uv[i * 2 + 1]);
      bk.col.push(cols[i * 3], cols[i * 3 + 1], cols[i * 3 + 2], alpha);
    }
    bk.ind.push(n, n + 3, n + 2, n, n + 2, n + 1);
    bk.n += 4;
  };

  const cols = new Array(12);
  const aoVert = (x, y, z, d, px, py, pz) => {
    const v = DV[d]; const nx = x + v[0], ny = y + v[1], nz = z + v[2];
    const [a1, a2] = TAN[d]; const pc = [px, py, pz];
    const s1 = pc[a1] < 0.5 ? -1 : 1, s2 = pc[a2] < 0.5 ? -1 : 1;
    const o1 = [0, 0, 0], o2 = [0, 0, 0]; o1[a1] = s1; o2[a2] = s2;
    const side1 = occAt(nx + o1[0], ny + o1[1], nz + o1[2]) ? 1 : 0;
    const side2 = occAt(nx + o2[0], ny + o2[1], nz + o2[2]) ? 1 : 0;
    const corner = occAt(nx + o1[0] + o2[0], ny + o1[1] + o2[1], nz + o1[2] + o2[2]) ? 1 : 0;
    return AO[side1 && side2 ? 0 : 3 - (side1 + side2 + corner)];
  };

  let faces = 0;
  const liquidAt = (x, y, z, kind) => { const p = pal(x, y, z); if (!p) return false; const b = baked[p]; return b.liq === kind || (kind === 'water' && b.wl === 1); };

  for (let y = 0; y < SY; y++) {
    if (sliceY != null && y > sliceY) break;
    for (let z = 0; z < SZ; z++) {
      for (let x = 0; x < SX; x++) {
        const pi = cells[idx(x, y, z)];
        if (!pi) continue;
        const b = baked[pi];
        if (b.air) continue;
        const isGround = ground[pi] === 1;
        for (const q of b.q) {
          const [p, uv, d, c, tint, shade, bnd, L] = q;
          if (c >= 0) {
            const v = DV[c]; const np = pal(x + v[0], y + v[1], z + v[2]);
            if (np) {
              const nb = baked[np];
              if (nb.occ === 1 && (!xray || isGround || !ground[np])) continue;
              if (np === pi && b.sc === 1) continue;
              if (b.sc === 1 && nb.sc === 1 && nb.n === b.n) continue;
            }
          }
          const v = DV[d];
          const lf = hot[pi] ? 1 : bnd ? lightAt(x + v[0], y + v[1], z + v[2]) : lightAt(x, y, z);
          const sh = shade ? SHADE[d] : 0.9;
          const tr = tint ? tint[0] : 1, tg = tint ? tint[1] : 1, tb = tint ? tint[2] : 1;
          for (let i = 0; i < 4; i++) {
            const ao = bnd && !isGround ? aoVert(x, y, z, d, p[i * 3], p[i * 3 + 1], p[i * 3 + 2]) : (bnd ? aoVert(x, y, z, d, p[i * 3], p[i * 3 + 1], p[i * 3 + 2]) : 1);
            const k = lf * sh * ao;
            cols[i * 3] = tr * k; cols[i * 3 + 1] = tg * k; cols[i * 3 + 2] = tb * k;
          }
          const bucket = isGround ? 3 : (b.layer === 2 && L === 2 ? 2 : L >= 1 ? 1 : 0);
          pushQuad(buckets[bucket], x, y, z, p, uv, cols);
          faces++;
        }
        // liquids (water, lava, waterlogged blocks)
        const kind = b.liq || (b.wl ? 'water' : null);
        if (kind && opts.liquidUV?.[kind]) {
          const lvl = b.liq ? b.level : 0;
          const above = liquidAt(x, y + 1, z, kind);
          const h = above ? 1 : (lvl === 0 ? 0.889 : lvl >= 8 ? 0.889 : Math.max(0.12, (8 - lvl) / 9));
          const [u0, v0, u1, v1] = opts.liquidUV[kind];
          const tint = kind === 'water' ? (opts.tints?.water || [0.25, 0.46, 0.89]).map((v) => v * 0.85) : [1, 1, 1];
          for (let d = 0; d < 6; d++) {
            const v = DV[d]; const nx = x + v[0], ny = y + v[1], nz = z + v[2];
            if (d === 1 && above) continue;
            if (liquidAt(nx, ny, nz, kind)) continue;
            if (occAt(nx, ny, nz) && !(xray && ground[pal(nx, ny, nz)])) continue;
            if (sliceY == null && !inside(nx, ny, nz) && d !== 1) continue; // don't draw the box walls of the sea
            const P = liquidQuad(d, h);
            const lf = kind === 'lava' ? 1 : lightAt(nx, ny, nz);
            const sh = SHADE[d];
            for (let i = 0; i < 4; i++) { cols[i * 3] = tint[0] * lf * sh; cols[i * 3 + 1] = tint[1] * lf * sh; cols[i * 3 + 2] = tint[2] * lf * sh; }
            const U = [u0, v0, u1, v0, u1, v1, u0, v1];
            pushQuad(buckets[kind === 'lava' ? 0 : 2], x, y, z, P, U, cols, kind === 'water' ? 0.92 : 1);
            faces++;
          }
        }
      }
    }
  }

  // ---- ghosts
  const ghostBuckets = {};
  const ghostInfo = [];
  if (opts.ghosts?.length && opts.ghostBaked) {
    const gmap = new Map();
    for (const g of opts.ghosts) gmap.set(`${g.x},${g.y},${g.z}`, g);
    for (const g of opts.ghosts) {
      const gb = opts.ghostBaked[g.pi]; if (!gb || gb.air) continue;
      const cls = g.cls || 'ok';
      const bk = ghostBuckets[cls] || (ghostBuckets[cls] = B());
      const lx = g.x - origin.x, ly = g.y - origin.y, lz = g.z - origin.z;
      for (const q of gb.q) {
        const [p, uv, d, c, tint] = q;
        if (c >= 0) {
          const v = DV[c]; const ng = gmap.get(`${g.x + v[0]},${g.y + v[1]},${g.z + v[2]}`);
          if (ng && opts.ghostBaked[ng.pi]?.occ === 1 && (ng.cls || 'ok') === cls) continue;
        }
        const sh = SHADE[d];
        for (let i = 0; i < 4; i++) { cols[i * 3] = (tint ? tint[0] : 1) * sh; cols[i * 3 + 1] = (tint ? tint[1] : 1) * sh; cols[i * 3 + 2] = (tint ? tint[2] : 1) * sh; }
        pushQuad(bk, lx, ly, lz, p, uv, cols);
      }
      if (cls === 'conflict') ghostInfo.push([lx, ly, lz]);
    }
  }

  // ---- three objects
  const group = new THREE.Group();
  group.position.set(origin.x, origin.y, origin.z);
  const tex = atlas;
  const mk = (bk, mat, order = 0) => {
    if (!bk.n) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(bk.pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(bk.uv, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(bk.col, 4));
    g.setIndex(bk.ind.length > 65535 * 0.9 ? new THREE.Uint32BufferAttribute(bk.ind, 1) : new THREE.Uint16BufferAttribute(bk.ind, 1));
    const m = new THREE.Mesh(g, mat); m.renderOrder = order; group.add(m); return m;
  };
  const fogOn = opts.fog !== false;
  mk(buckets[0], new THREE.MeshBasicMaterial({ map: tex, vertexColors: true, fog: fogOn }), 0);
  mk(buckets[1], new THREE.MeshBasicMaterial({ map: tex, vertexColors: true, alphaTest: 0.5, side: THREE.DoubleSide, fog: fogOn }), 1);
  if (xray) mk(buckets[3], new THREE.MeshBasicMaterial({ map: tex, vertexColors: true, transparent: true, opacity: 0.09, depthWrite: false, fog: false }), 3);
  else mk(buckets[3], new THREE.MeshBasicMaterial({ map: tex, vertexColors: true, fog: fogOn }), 0);
  mk(buckets[2], new THREE.MeshBasicMaterial({ map: tex, vertexColors: true, transparent: true, depthWrite: false, side: THREE.DoubleSide, fog: fogOn }), 2);

  const GHOST_COL = { ok: [0.45, 0.9, 1.0, 0.62], done: [0.4, 1.0, 0.45, 0.28], conflict: [1.0, 0.25, 0.2, 0.75] };
  for (const [cls, bk] of Object.entries(ghostBuckets)) {
    let c = GHOST_COL[cls];
    if (!c && /^#?[0-9a-f]{6}$/i.test(cls)) { const h = parseInt(cls.replace('#', ''), 16); c = [((h >> 16) & 255) / 255, ((h >> 8) & 255) / 255, (h & 255) / 255, 0.6]; }
    c = c || GHOST_COL.ok;
    const mat = new THREE.MeshBasicMaterial({ map: tex, vertexColors: true, color: new THREE.Color(c[0], c[1], c[2]), transparent: true, opacity: c[3], depthWrite: false, alphaTest: 0.05, fog: false, side: THREE.DoubleSide });
    mk(bk, mat, 5);
  }
  if (ghostInfo.length) { // red boxes around blocks that are in the way, visible through terrain
    const pts = [];
    const e = 0.04;
    for (const [x, y, z] of ghostInfo) {
      const a = [x - e, y - e, z - e], b = [x + 1 + e, y + 1 + e, z + 1 + e];
      const C = [[a[0], a[1], a[2]], [b[0], a[1], a[2]], [b[0], a[1], b[2]], [a[0], a[1], b[2]], [a[0], b[1], a[2]], [b[0], b[1], a[2]], [b[0], b[1], b[2]], [a[0], b[1], b[2]]];
      for (const [i, j] of [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]]) pts.push(...C[i], ...C[j]);
    }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    const l = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: 0xff3030, depthTest: false, transparent: true, opacity: 0.95 }));
    l.renderOrder = 9; group.add(l);
  }
  return { group, faces };
}

function liquidQuad(d, h) {
  switch (d) { // TL,TR,BR,BL outward (same convention as assets.js)
    case 1: return [0, h, 0, 1, h, 0, 1, h, 1, 0, h, 1];
    case 0: return [0, 0, 1, 1, 0, 1, 1, 0, 0, 0, 0, 0];
    case 2: return [1, h, 0, 0, h, 0, 0, 0, 0, 1, 0, 0];
    case 3: return [0, h, 1, 1, h, 1, 1, 0, 1, 0, 0, 1];
    case 4: return [0, h, 0, 0, h, 1, 0, 0, 1, 0, 0, 0];
    case 5: return [1, h, 1, 1, h, 0, 1, 0, 0, 1, 0, 1];
  }
  return null;
}
