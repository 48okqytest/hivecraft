// Blueprint-by-code: run agent-written JS in a node:vm context with shape helpers. Synchronous code only,
// time limit + block cap. (node:vm is a robustness sandbox, not a security boundary; agents already have run_code.)
import vm from 'node:vm';
import { Blueprint, MAX_BLOCKS } from './model.js';
import { normalizeState, formatState, parseState, rotateProps, mirrorProps, rotatePos, DIR_VEC, HORIZ, OPP } from './states.js';

export const DSL_REFERENCE = `Blueprint JS (sync code; coordinates are RELATIVE to the build origin, y=0 = first layer ON the ground; x=east, z=south; ranges inclusive).
Blocks: "oak_planks" or with states "oak_stairs[facing=north,half=top]", "oak_slab[type=top]", "oak_log[axis=x]".
block(x,y,z,b) | fill(x1,y1,z1,x2,y2,z2,b) (=box) | hollow(x1,y1,z1,x2,y2,z2,b,{floor:true,ceiling:true,air:true}) shell, inside air
walls(x1,y1,z1,x2,y2,z2,b) 4 walls only | floor(x1,z1,x2,z2,y,b) | line(x1,y1,z1,x2,y2,z2,b) | clear(x1,y1,z1,x2,y2,z2) = must be air
cylinder(cx,y,cz,r,h,b,{hollow}) | sphere(cx,cy,cz,r,b,{hollow}) | dome(cx,y,cz,r,b,{hollow}) | pyramid(x1,y,z1,x2,z2,b,{hollow})
roof(x1,y,z1,x2,z2,mat,{type:'gable'|'hip',axis:'x'|'z',overhang:1,fill:'oak_planks',ridge:'slab'|'block'}) x1..z2 = wall footprint, y = first roof layer; mat 'oak' / 'spruce' / 'stone_brick' / 'cobblestone' (or an exact *_stairs)
stairs(x,y,z,mat,facing,half='bottom') facing = side of the tall back (you walk UP toward facing) | slab(x,y,z,mat,type='bottom')
door(x,y,z,mat='oak',facing='south',{hinge:'left',open:false}) facing = direction you face when walking IN through it (door in the north wall of a room -> 'south')
window(x1,y1,z1,x2,y2,z2,glass='glass_pane') | torch(x,y,z,facing?) (wall torch pointing facing) | lantern(x,y,z,hanging=false)
ladder(x,y,z,facing) | bed(x,y,z,color='red',facing='north') foot at x,y,z, head toward facing | pillar(x,y,z,'oak',axis) (oak_log / any axis block)
layers(x0,y0,z0,{ '#':'cobblestone', 'P':'oak_planks', '.':'air' }, [ ['#####','#...#'], [...] ]) layer i at y0+i, row r at z0+r, char c at x0+c; ' ' = skip
replace(from,to,[x1,y1,z1,x2,y2,z2]) | remove(x,y,z) | mirror('x'|'z',about=0) | rotate(turns=1,px=0,pz=0) clockwise incl. block states
translate(dx,dy,dz) | copy(x1,y1,z1,x2,y2,z2,dx,dy,dz) | get(x,y,z) | count() | state(name,{props}) -> string | log(...)
name('my_house') / describe('text') set metadata. DIRS = ['north','east','south','west']; cw(d)/ccw(d)/opp(d). rand() is seeded.`;

function stairsMaterial(mcData, mat) {
  const m = String(mat || 'oak').toLowerCase().replace(/^minecraft:/, '');
  if (/_stairs$/.test(m)) return m;
  for (const c of [`${m}_stairs`, `${m.replace(/s$/, '')}_stairs`, `${m.replace(/_planks$/, '')}_stairs`, `${m.replace(/_bricks$/, '_brick')}_stairs`]) if (mcData.blocksByName[c]) return c;
  throw new Error(`No stairs block for material "${mat}" (try oak, spruce, cobblestone, stone_brick, brick, sandstone...).`);
}
function slabMaterial(mcData, mat) {
  const s = stairsMaterial(mcData, mat).replace(/_stairs$/, '');
  for (const c of [`${s}_slab`, `${s.replace(/_brick$/, '_brick')}_slab`]) if (mcData.blocksByName[c]) return c;
  throw new Error(`No slab block for material "${mat}".`);
}
function fullMaterial(mcData, mat) {
  const s = stairsMaterial(mcData, mat).replace(/_stairs$/, '');
  for (const c of [`${s}_planks`, `${s}s`, s, `${s}_block`]) if (mcData.blocksByName[c]) return c;
  return 'oak_planks';
}

function seeded(seed = 1234567) {
  let s = seed >>> 0;
  return () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/** Create the helper API writing into bp. Exported for unit tests. */
export function makeApi(bp, mcData, { log = () => {} } = {}) {
  const cache = new Map();
  const norm = (b) => {
    if (b === null || b === undefined) throw new Error('block is missing');
    const k = typeof b === 'string' ? b : JSON.stringify(b);
    let s = cache.get(k);
    if (!s) { const n = normalizeState(mcData, b); s = formatState(n.name, n.props); cache.set(k, s); }
    return s;
  };
  const I = (v, what = 'coordinate') => {
    const n = Number(v);
    if (!Number.isFinite(n)) throw new Error(`${what} must be a number, got ${JSON.stringify(v)}`);
    const r = Math.round(n);
    if (Math.abs(r) > 512) throw new Error(`${what} ${r} is too far from the origin (max 512).`);
    return r;
  };
  const put = (x, y, z, b) => bp.set(I(x), I(y), I(z), norm(b));
  const range = (a, b) => { a = I(a); b = I(b); const lo = Math.min(a, b), hi = Math.max(a, b); const out = []; for (let i = lo; i <= hi; i++) out.push(i); return out; };
  const withProps = (name, props) => formatState(name, props);

  const api = {
    DIRS: [...HORIZ],
    cw: (d) => HORIZ[(HORIZ.indexOf(d) + 1) % 4], ccw: (d) => HORIZ[(HORIZ.indexOf(d) + 3) % 4], opp: (d) => OPP[d],
    log: (...a) => log(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')),
    rand: seeded(),
    name: (n) => { bp.name = String(n); },
    describe: (t) => { bp.description = String(t); },
    state: (name, props = {}) => norm(withProps(String(name), props)),
    block: (x, y, z, b) => put(x, y, z, b),
    get: (x, y, z) => bp.get(I(x), I(y), I(z)) || null,
    remove: (x, y, z) => bp.delete(I(x), I(y), I(z)),
    count: () => bp.size,
    fill(x1, y1, z1, x2, y2, z2, b) { const s = norm(b); for (const x of range(x1, x2)) for (const y of range(y1, y2)) for (const z of range(z1, z2)) bp.set(x, y, z, s); },
    clear(x1, y1, z1, x2, y2, z2) { api.fill(x1, y1, z1, x2, y2, z2, 'air'); },
    hollow(x1, y1, z1, x2, y2, z2, b, { floor = true, ceiling = true, air = true } = {}) {
      const s = norm(b);
      const [xa, xb] = [Math.min(I(x1), I(x2)), Math.max(I(x1), I(x2))], [ya, yb] = [Math.min(I(y1), I(y2)), Math.max(I(y1), I(y2))], [za, zb] = [Math.min(I(z1), I(z2)), Math.max(I(z1), I(z2))];
      for (let x = xa; x <= xb; x++) for (let y = ya; y <= yb; y++) for (let z = za; z <= zb; z++) {
        const edge = x === xa || x === xb || z === za || z === zb || (floor && y === ya) || (ceiling && y === yb);
        if (edge) bp.set(x, y, z, s); else if (air) bp.set(x, y, z, 'air');
      }
    },
    walls(x1, y1, z1, x2, y2, z2, b) { api.hollow(x1, y1, z1, x2, y2, z2, b, { floor: false, ceiling: false, air: false }); },
    floor(x1, z1, x2, z2, y, b) { api.fill(x1, y, z1, x2, y, z2, b); },
    line(x1, y1, z1, x2, y2, z2, b) {
      const s = norm(b);
      const a = [I(x1), I(y1), I(z1)], c = [I(x2), I(y2), I(z2)];
      const n = Math.max(...a.map((v, i) => Math.abs(c[i] - v)));
      for (let i = 0; i <= n; i++) { const t = n ? i / n : 0; bp.set(Math.round(a[0] + (c[0] - a[0]) * t), Math.round(a[1] + (c[1] - a[1]) * t), Math.round(a[2] + (c[2] - a[2]) * t), s); }
    },
    cylinder(cx, y, cz, r, h, b, { hollow = false } = {}) {
      const s = norm(b); cx = I(cx); y = I(y); cz = I(cz); r = Number(r); h = I(h, 'height');
      for (let dx = -Math.ceil(r); dx <= Math.ceil(r); dx++) for (let dz = -Math.ceil(r); dz <= Math.ceil(r); dz++) {
        const d = Math.sqrt(dx * dx + dz * dz);
        if (d > r + 0.5) continue;
        if (hollow && d < r - 0.5) continue;
        for (let k = 0; k < h; k++) bp.set(cx + dx, y + k, cz + dz, s);
      }
    },
    sphere(cx, cy, cz, r, b, { hollow = false, minY = -Infinity } = {}) {
      const s = norm(b); cx = I(cx); cy = I(cy); cz = I(cz); r = Number(r);
      const R = Math.ceil(r);
      for (let dx = -R; dx <= R; dx++) for (let dy = -R; dy <= R; dy++) for (let dz = -R; dz <= R; dz++) {
        if (cy + dy < minY) continue;
        const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (d > r + 0.5) continue;
        if (hollow && d < r - 0.5) continue;
        bp.set(cx + dx, cy + dy, cz + dz, s);
      }
    },
    dome(cx, y, cz, r, b, opts = {}) { api.sphere(cx, y, cz, r, b, { ...opts, minY: I(y) }); },
    pyramid(x1, y, z1, x2, z2, b, { hollow = false } = {}) {
      const s = norm(b);
      let [xa, xb] = [Math.min(I(x1), I(x2)), Math.max(I(x1), I(x2))], [za, zb] = [Math.min(I(z1), I(z2)), Math.max(I(z1), I(z2))];
      for (let k = 0; xa <= xb && za <= zb; k++, xa++, xb--, za++, zb--) {
        for (let x = xa; x <= xb; x++) for (let z = za; z <= zb; z++) {
          if (hollow && x !== xa && x !== xb && z !== za && z !== zb) continue;
          bp.set(x, I(y) + k, z, s);
        }
      }
    },
    stairs(x, y, z, mat, facing = 'north', half = 'bottom') { put(x, y, z, withProps(stairsMaterial(mcData, mat), { facing, half })); },
    slab(x, y, z, mat, type = 'bottom') { put(x, y, z, withProps(slabMaterial(mcData, mat), { type })); },
    door(x, y, z, mat = 'oak', facing = 'south', { hinge = 'left', open = false } = {}) {
      const n = /_door$/.test(mat) ? mat : `${String(mat).replace(/_planks$/, '')}_door`;
      put(x, y, z, withProps(n, { facing, half: 'lower', hinge, open: String(!!open) }));
      put(x, I(y) + 1, z, withProps(n, { facing, half: 'upper', hinge, open: String(!!open) }));
    },
    window(x1, y1, z1, x2, y2, z2, glass = 'glass_pane') { api.fill(x1, y1, z1, x2, y2, z2, glass); },
    torch(x, y, z, facing) { put(x, y, z, facing ? withProps('wall_torch', { facing }) : 'torch'); },
    lantern(x, y, z, hanging = false) { put(x, y, z, withProps('lantern', { hanging: String(!!hanging) })); },
    ladder(x, y, z, facing = 'north') { put(x, y, z, withProps('ladder', { facing })); },
    pillar(x, y, z, wood = 'oak', axis = 'y') {
      const n = /_(log|wood|stem|pillar)$/.test(wood) || mcData.blocksByName[wood] ? wood : `${wood}_log`;
      put(x, y, z, withProps(n, { axis }));
    },
    bed(x, y, z, color = 'red', facing = 'north') {
      const n = /_bed$/.test(color) ? color : `${color}_bed`;
      const [dx, , dz] = DIR_VEC[facing] || DIR_VEC.north;
      put(x, y, z, withProps(n, { facing, part: 'foot' }));
      put(I(x) + dx, y, I(z) + dz, withProps(n, { facing, part: 'head' }));
    },
    roof(x1, y, z1, x2, z2, mat = 'oak', { type = 'gable', axis, overhang = 1, fill, ridge = 'slab' } = {}) {
      const st = stairsMaterial(mcData, mat), sl = slabMaterial(mcData, mat);
      const full = fill ? norm(fill) : fullMaterial(mcData, mat);
      y = I(y); overhang = Math.max(0, I(overhang, 'overhang'));
      const xa0 = Math.min(I(x1), I(x2)), xb0 = Math.max(I(x1), I(x2)), za0 = Math.min(I(z1), I(z2)), zb0 = Math.max(I(z1), I(z2));
      const xa = xa0 - overhang, xb = xb0 + overhang, za = za0 - overhang, zb = zb0 + overhang;
      const S = (facing) => norm(withProps(st, { facing, half: 'bottom' }));
      const ridgeBlock = ridge === 'block' ? norm(full) : norm(withProps(sl, { type: 'bottom' }));
      if (type === 'hip') {
        for (let k = 0; ; k++) {
          const x0 = xa + k, x1b = xb - k, z0 = za + k, z1b = zb - k;
          if (x0 > x1b || z0 > z1b) break;
          const yy = y + k;
          if (x0 === x1b || z0 === z1b) { for (let x = x0; x <= x1b; x++) for (let z = z0; z <= z1b; z++) bp.set(x, yy, z, ridgeBlock); break; }
          for (let x = x0; x <= x1b; x++) { bp.set(x, yy, z0, S('south')); bp.set(x, yy, z1b, S('north')); }
          for (let z = z0 + 1; z < z1b; z++) { bp.set(x0, yy, z, S('east')); bp.set(x1b, yy, z, S('west')); }
        }
        return;
      }
      const ax = axis || ((xb0 - xa0) >= (zb0 - za0) ? 'x' : 'z'); // ridge runs along ax
      if (ax === 'x') {
        for (let k = 0; ; k++) {
          const zn = za + k, zs = zb - k, yy = y + k;
          if (zn > zs) break;
          for (let x = xa; x <= xb; x++) {
            if (zn === zs) bp.set(x, yy, zn, ridgeBlock);
            else { bp.set(x, yy, zn, S('south')); bp.set(x, yy, zs, S('north')); }
          }
          for (const gx of [xa0, xb0]) for (let z = Math.max(zn + 1, za0); z <= Math.min(zs - 1, zb0); z++) bp.set(gx, yy, z, full);
          if (zn === zs) break;
        }
      } else {
        for (let k = 0; ; k++) {
          const xw = xa + k, xe = xb - k, yy = y + k;
          if (xw > xe) break;
          for (let z = za; z <= zb; z++) {
            if (xw === xe) bp.set(xw, yy, z, ridgeBlock);
            else { bp.set(xw, yy, z, S('east')); bp.set(xe, yy, z, S('west')); }
          }
          for (const gz of [za0, zb0]) for (let x = Math.max(xw + 1, xa0); x <= Math.min(xe - 1, xb0); x++) bp.set(x, yy, gz, full);
          if (xw === xe) break;
        }
      }
    },
    layers(x0, y0, z0, legend, layerList) {
      if (!Array.isArray(layerList)) throw new Error('layers(x0,y0,z0,legend,[[rows...],...]) needs an array of layers');
      const leg = {};
      for (const [ch, b] of Object.entries(legend || {})) leg[ch] = norm(b);
      layerList.forEach((rows, i) => {
        if (typeof rows === 'string') rows = rows.split('\n');
        rows.forEach((row, r) => {
          [...String(row)].forEach((ch, c) => {
            if (ch === ' ') return;
            const s = leg[ch];
            if (!s) throw new Error(`layers: character "${ch}" (layer ${i}, row ${r}) is not in the legend`);
            bp.set(I(x0) + c, I(y0) + i, I(z0) + r, s);
          });
        });
      });
    },
    replace(from, to, region) {
      const f = parseState(from).name, ff = from.includes('[') ? norm(from) : null, t = norm(to);
      let reg = null;
      if (Array.isArray(region) && region.length === 6) { const r = region.map((v) => I(v)); reg = { xa: Math.min(r[0], r[3]), xb: Math.max(r[0], r[3]), ya: Math.min(r[1], r[4]), yb: Math.max(r[1], r[4]), za: Math.min(r[2], r[5]), zb: Math.max(r[2], r[5]) }; }
      let n = 0;
      for (const e of [...bp.entries()]) {
        if (reg && (e.x < reg.xa || e.x > reg.xb || e.y < reg.ya || e.y > reg.yb || e.z < reg.za || e.z > reg.zb)) continue;
        if (ff ? e.state !== ff : parseState(e.state).name !== f) continue;
        // keep compatible states (e.g. replace oak_stairs -> spruce_stairs keeps facing)
        let out = t;
        if (!to.includes('[')) {
          const p = parseState(e.state).props, tn = parseState(t).name;
          const valid = new Set((mcData.blocksByName[tn].states || []).map((s) => s.name));
          const keep = Object.fromEntries(Object.entries(p).filter(([k]) => valid.has(k)));
          out = formatState(tn, keep);
        }
        bp.set(e.x, e.y, e.z, out); n++;
      }
      return n;
    },
    mirror(axis = 'x', about = 0) {
      if (axis !== 'x' && axis !== 'z') throw new Error("mirror axis must be 'x' or 'z'");
      const a = Number(about) * 2;
      const all = [...bp.entries()]; bp.map.clear();
      for (const e of all) {
        const { name, props } = parseState(e.state);
        const s = Object.keys(props).length ? formatState(name, mirrorProps(name, props, axis)) : e.state;
        if (axis === 'x') bp.set(Math.round(a - e.x), e.y, e.z, s); else bp.set(e.x, e.y, Math.round(a - e.z), s);
      }
    },
    rotate(turns = 1, px = 0, pz = 0) {
      const all = [...bp.entries()]; bp.map.clear();
      for (const e of all) {
        const [rx, rz] = rotatePos(e.x - px, e.z - pz, turns);
        const { name, props } = parseState(e.state);
        const s = Object.keys(props).length ? formatState(name, rotateProps(name, props, turns)) : e.state;
        bp.set(Math.round(rx + px), e.y, Math.round(rz + pz), s);
      }
    },
    translate(dx = 0, dy = 0, dz = 0) {
      const all = [...bp.entries()]; bp.map.clear();
      for (const e of all) bp.set(e.x + I(dx), e.y + I(dy), e.z + I(dz), e.state);
    },
    copy(x1, y1, z1, x2, y2, z2, dx, dy, dz) {
      const xa = Math.min(I(x1), I(x2)), xb = Math.max(I(x1), I(x2)), ya = Math.min(I(y1), I(y2)), yb = Math.max(I(y1), I(y2)), za = Math.min(I(z1), I(z2)), zb = Math.max(I(z1), I(z2));
      for (const e of [...bp.entries()]) if (e.x >= xa && e.x <= xb && e.y >= ya && e.y <= yb && e.z >= za && e.z <= zb) bp.set(e.x + I(dx), e.y + I(dy), e.z + I(dz), e.state);
    },
  };
  api.box = api.fill;
  return api;
}

/**
 * Run blueprint code. Returns {bp, logs}. Throws Error with a helpful message (syntax error, runtime error + line).
 */
export function runBlueprintCode(code, mcData, { name = 'untitled', description = '', timeoutMs = 3000, maxBlocks = MAX_BLOCKS, base = null } = {}) {
  const bp = base ? base.clone(name) : new Blueprint(name, { description });
  bp.maxBlocks = maxBlocks;
  const logs = [];
  const api = makeApi(bp, mcData, { log: (s) => { if (logs.length < 50) logs.push(s.slice(0, 300)); } });
  const sandbox = Object.create(null);
  for (const [k, v] of Object.entries(api)) sandbox[k] = v;
  sandbox.Math = Math;
  sandbox.JSON = JSON;
  sandbox.console = { log: api.log };
  const ctx = vm.createContext(sandbox, { codeGeneration: { strings: false, wasm: false }, name: 'blueprint' });
  let script;
  try { script = new vm.Script(String(code), { filename: 'blueprint.js' }); } catch (e) { throw new Error(`Syntax error in blueprint code: ${e.message}`); }
  try { script.runInContext(ctx, { timeout: timeoutMs, breakOnSigint: false }); } catch (e) {
    if (/Script execution timed out/.test(e?.message)) throw new Error(`Blueprint code took longer than ${timeoutMs} ms (infinite loop?).`);
    const line = /blueprint\.js:(\d+)/.exec(e?.stack || '')?.[1];
    throw new Error(`Blueprint code error${line ? ` (line ${line})` : ''}: ${e?.message || e}`);
  }
  if (!bp.size) throw new Error('Blueprint code placed no blocks. Use block()/fill()/walls()/roof()... (see the DSL reference in the tool description).');
  return { bp, logs };
}
