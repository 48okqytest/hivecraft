// Blueprint data model + persistence (data/blueprints/<name>.json) + world transform (origin, rotation, mirror).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseState, formatState, rotateProps, mirrorProps, rotatePos, AIRISH } from './states.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
export const DATA_DIR = process.env.HIVE_DATA || path.join(ROOT, 'data');
export const BP_DIR = process.env.HIVE_BLUEPRINTS || path.join(DATA_DIR, 'blueprints');
export const BUILDS_DIR = path.join(BP_DIR, 'builds');

export const MAX_BLOCKS = 20000;
export const key3 = (x, y, z) => `${x},${y},${z}`;

export class Blueprint {
  constructor(name = 'untitled', { description = '', meta = {} } = {}) {
    this.name = name;
    this.description = description;
    this.meta = meta;
    this.map = new Map(); // "x,y,z" -> canonical state string ('air' = must be empty)
    this.maxBlocks = MAX_BLOCKS;
  }
  set(x, y, z, state) {
    const k = key3(x, y, z);
    if (!this.map.has(k) && this.map.size >= this.maxBlocks) throw new Error(`Blueprint too big: more than ${this.maxBlocks} blocks.`);
    this.map.set(k, state);
  }
  get(x, y, z) { return this.map.get(key3(x, y, z)); }
  delete(x, y, z) { this.map.delete(key3(x, y, z)); }
  get size() { return this.map.size; }
  *entries() {
    for (const [k, s] of this.map) { const [x, y, z] = k.split(',').map(Number); yield { x, y, z, state: s }; }
  }
  /** non-air entries */
  solidCount() { let n = 0; for (const s of this.map.values()) if (!AIRISH.has(s)) n++; return n; }
  bounds() {
    let min = null, max = null;
    for (const { x, y, z } of this.entries()) {
      if (!min) { min = { x, y, z }; max = { x, y, z }; continue; }
      min.x = Math.min(min.x, x); min.y = Math.min(min.y, y); min.z = Math.min(min.z, z);
      max.x = Math.max(max.x, x); max.y = Math.max(max.y, y); max.z = Math.max(max.z, z);
    }
    if (!min) return { min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 0 }, size: { x: 0, y: 0, z: 0 } };
    return { min, max, size: { x: max.x - min.x + 1, y: max.y - min.y + 1, z: max.z - min.z + 1 } };
  }
  counts() {
    const m = new Map();
    for (const s of this.map.values()) { const n = parseState(s).name; if (AIRISH.has(n)) continue; m.set(n, (m.get(n) || 0) + 1); }
    return m;
  }
  toJSON() {
    const palette = [], idx = new Map(), blocks = [];
    for (const { x, y, z, state } of this.entries()) {
      if (!idx.has(state)) { idx.set(state, palette.length); palette.push(state); }
      blocks.push([x, y, z, idx.get(state)]);
    }
    const b = this.bounds();
    return { format: 'hivecraft-blueprint', version: 1, name: this.name, description: this.description, size: b.size, min: b.min, max: b.max, count: blocks.length, meta: this.meta, palette, blocks };
  }
  static fromJSON(j) {
    if (!j || j.format !== 'hivecraft-blueprint') throw new Error('Not a hivecraft blueprint file.');
    const bp = new Blueprint(j.name, { description: j.description || '', meta: j.meta || {} });
    bp.maxBlocks = Math.max(MAX_BLOCKS, j.blocks.length);
    for (const [x, y, z, i] of j.blocks) bp.map.set(key3(x, y, z), j.palette[i]);
    return bp;
  }
  clone(name = this.name) {
    const bp = new Blueprint(name, { description: this.description, meta: { ...this.meta } });
    bp.maxBlocks = this.maxBlocks;
    for (const [k, v] of this.map) bp.map.set(k, v);
    return bp;
  }
  /**
   * y=0 is the layer that rests ON the ground. If the lowest solid block is above y=0 (agents often
   * start walls/posts at y=1 with no floor), the whole build would float; drop it so it sits on the
   * ground. Returns the number of layers dropped (0 = unchanged). Blueprints with meta.float keep their height.
   */
  ground() {
    if (this.meta?.float) return 0;
    let minY = Infinity;
    for (const { y, state } of this.entries()) if (!AIRISH.has(parseState(state).name) && y < minY) minY = y;
    if (!Number.isFinite(minY) || minY <= 0) return 0;
    const moved = new Map();
    for (const { x, y, z, state } of this.entries()) moved.set(key3(x, y - minY, z), state);
    this.map = moved;
    return minY;
  }
  /** shift so the min corner of the footprint is at (0, minY->0, 0) */
  normalized() {
    const { min } = this.bounds();
    const bp = new Blueprint(this.name, { description: this.description, meta: { ...this.meta } });
    bp.maxBlocks = this.maxBlocks;
    for (const { x, y, z, state } of this.entries()) bp.map.set(key3(x - min.x, y - min.y, z - min.z), state);
    return bp;
  }
}

/** transform a state string with mirror then rotation */
export function transformState(state, { rotation = 0, mirror = null } = {}) {
  if (!rotation && !mirror) return state;
  let { name, props } = parseState(state);
  if (!Object.keys(props).length) return state;
  if (mirror) props = mirrorProps(name, props, mirror);
  if (rotation) props = rotateProps(name, props, rotation);
  return formatState(name, props);
}

export const rotationTurns = (deg = 0) => {
  const d = ((Math.round(Number(deg) / 90) * 90) % 360 + 360) % 360;
  return d / 90;
};

/**
 * World blocks for a blueprint placed at origin with rotation (degrees clockwise: 0/90/180/270) and mirror ('x'|'z').
 * Relative (0,0,0) lands on origin. Returns [{x,y,z,state,name,props}].
 */
export function worldBlocks(bp, { origin, rotation = 0, mirror = null }) {
  const turns = rotationTurns(rotation);
  const cache = new Map();
  const out = [];
  for (const e of bp.entries()) {
    let x = e.x, z = e.z;
    if (mirror === 'x') x = -x; else if (mirror === 'z') z = -z;
    [x, z] = rotatePos(x, z, turns);
    let st = cache.get(e.state);
    if (!st) {
      const s = transformState(e.state, { rotation: turns, mirror });
      st = { state: s, ...parseState(s) };
      cache.set(e.state, st);
    }
    out.push({ x: origin.x + x, y: origin.y + e.y, z: origin.z + z, state: st.state, name: st.name, props: st.props });
  }
  return out;
}

// ---------- store ----------
export const safeName = (n) => {
  const s = String(n || '').trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60);
  if (!s) throw new Error('blueprint name is required (letters, digits, _ or -).');
  return s;
};
const file = (n) => path.join(BP_DIR, `${safeName(n)}.json`);

export function saveBlueprint(bp) {
  fs.mkdirSync(BP_DIR, { recursive: true });
  bp.name = safeName(bp.name);
  bp.meta = { ...bp.meta, saved: new Date().toISOString() };
  const tmp = file(bp.name) + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(bp.toJSON()));
  fs.renameSync(tmp, file(bp.name));
  return file(bp.name);
}
export function loadBlueprint(name) {
  const f = file(name);
  if (!fs.existsSync(f)) {
    const have = listBlueprints().map((b) => b.name);
    throw new Error(`No blueprint "${name}". Saved blueprints: ${have.join(', ') || 'none'}. Create one with blueprint_write or blueprint_import.`);
  }
  const bp = Blueprint.fromJSON(JSON.parse(fs.readFileSync(f, 'utf8')));
  bp.ground(); // older saves may float one layer above the ground
  return bp;
}
export function deleteBlueprint(name) {
  const f = file(name);
  if (!fs.existsSync(f)) throw new Error(`No blueprint "${name}".`);
  fs.unlinkSync(f);
}
export function listBlueprints() {
  if (!fs.existsSync(BP_DIR)) return [];
  const out = [];
  for (const f of fs.readdirSync(BP_DIR)) {
    if (!f.endsWith('.json')) continue;
    try {
      const j = JSON.parse(fs.readFileSync(path.join(BP_DIR, f), 'utf8'));
      if (j.format !== 'hivecraft-blueprint') continue;
      out.push({ name: j.name, description: j.description || '', size: j.size, count: j.count, source: j.meta?.source || 'code', saved: j.meta?.saved });
    } catch { /* skip broken */ }
  }
  return out.sort((a, b) => String(b.saved).localeCompare(String(a.saved)));
}
