// Import Minecraft build files into blueprints: Sponge .schem (v1/v2/v3), vanilla structure .nbt, Litematica .litematic.
// Air / structure_void are dropped (the build's clear phase empties the bounding box anyway).
import fs from 'node:fs';
import path from 'node:path';
import nbt from 'prismarine-nbt';
import { Blueprint, MAX_BLOCKS, BP_DIR } from './model.js';
import { normalizeState, formatState, parseState } from './states.js';

export const IMPORT_DIR = path.join(BP_DIR, 'import');
const SKIP = new Set(['air', 'cave_air', 'void_air', 'structure_void']);

function decodeVarints(bytes, n) {
  const out = new Array(n);
  let i = 0, idx = 0;
  while (idx < n && i < bytes.length) {
    let v = 0, shift = 0, b;
    do { b = bytes[i++] & 0xff; v |= (b & 0x7f) << shift; shift += 7; } while (b & 0x80);
    out[idx++] = v;
  }
  return out;
}

function addState(bp, mcData, x, y, z, raw, stats) {
  const { name } = parseState(raw);
  if (SKIP.has(name)) return;
  let s = stats.cache.get(raw);
  if (s === undefined) {
    try { const n = normalizeState(mcData, raw); s = formatState(n.name, n.props); }
    catch {
      // unknown props (other version): keep the block name only, if it exists
      s = mcData.blocksByName[name] ? name : null;
      if (s) stats.downgraded.add(name); else stats.unknown.add(name);
    }
    stats.cache.set(raw, s);
  }
  if (!s) return;
  if (bp.size >= stats.max) { stats.truncated = true; return; }
  bp.set(x, y, z, s);
}

const asStateString = (p) => formatState(String(p.Name).replace(/^minecraft:/, ''), Object.fromEntries(Object.entries(p.Properties || {}).map(([k, v]) => [k, String(v)])));

function fromSponge(root, bp, mcData, stats) {
  const S = root.Schematic || root;
  const W = S.Width, H = S.Height, L = S.Length;
  const blocks = S.Blocks || S; // v3 nests Palette/Data in Blocks
  const palette = blocks.Palette;
  const data = blocks.Data || blocks.BlockData || S.BlockData;
  if (!palette || !data) throw new Error('Not a Sponge schematic (missing Palette/BlockData). Legacy MCEdit .schematic files (numeric ids) are not supported.');
  const inv = [];
  for (const [k, v] of Object.entries(palette)) inv[v] = k.replace(/^minecraft:/, '');
  const ids = decodeVarints(data, W * H * L);
  for (let y = 0; y < H; y++) for (let z = 0; z < L; z++) for (let x = 0; x < W; x++) {
    const id = ids[x + z * W + y * W * L];
    if (id === undefined) continue;
    addState(bp, mcData, x, y, z, inv[id] || 'air', stats);
  }
  bp.meta.dataVersion = S.DataVersion;
}

function fromStructure(root, bp, mcData, stats) {
  const pal = root.palette || root.palettes?.[0];
  if (!pal || !root.blocks) throw new Error('Not a structure .nbt (missing palette/blocks).');
  const names = pal.map(asStateString);
  for (const b of root.blocks) addState(bp, mcData, b.pos[0], b.pos[1], b.pos[2], names[b.state], stats);
  bp.meta.dataVersion = root.DataVersion;
}

function longToBig(l) {
  if (typeof l === 'bigint') return BigInt.asUintN(64, l);
  if (Array.isArray(l)) return (BigInt.asUintN(32, BigInt(l[0])) << 32n) | BigInt.asUintN(32, BigInt(l[1]));
  return BigInt.asUintN(64, BigInt(l));
}

function fromLitematic(root, bp, mcData, stats) {
  const regions = root.Regions;
  if (!regions) throw new Error('Not a litematic (missing Regions).');
  for (const [, r] of Object.entries(regions)) {
    const sx = r.Size.x, sy = r.Size.y, sz = r.Size.z;
    const W = Math.abs(sx), H = Math.abs(sy), L = Math.abs(sz);
    const px = r.Position.x + (sx < 0 ? sx + 1 : 0), py = r.Position.y + (sy < 0 ? sy + 1 : 0), pz = r.Position.z + (sz < 0 ? sz + 1 : 0);
    const pal = r.BlockStatePalette.map(asStateString);
    const bits = Math.max(2, Math.ceil(Math.log2(pal.length)));
    const longs = (r.BlockStates || []).map(longToBig);
    const mask = (1n << BigInt(bits)) - 1n;
    const vol = W * H * L;
    for (let i = 0; i < vol; i++) {
      const bitIdx = BigInt(i * bits);
      const li = Number(bitIdx >> 6n), off = bitIdx & 63n;
      let v = (longs[li] >> off) & mask;
      if (off + BigInt(bits) > 64n && li + 1 < longs.length) v = (v | (longs[li + 1] << (64n - off))) & mask;
      const id = Number(v);
      const x = i % W, z = Math.floor(i / W) % L, y = Math.floor(i / (W * L));
      addState(bp, mcData, px + x, py + y, pz + z, pal[id] || 'air', stats);
    }
  }
}

/** Parse a build file buffer. Returns {bp, report}. */
export async function importBuffer(buf, mcData, { name, filename = '', maxBlocks = MAX_BLOCKS } = {}) {
  let parsed;
  try { ({ parsed } = await nbt.parse(buf)); } catch (e) { throw new Error(`Could not read ${filename || 'file'} as NBT: ${e.message}`); }
  const root = nbt.simplify(parsed);
  const bp = new Blueprint(name || path.basename(filename).replace(/\.[^.]+$/, '') || 'imported', { meta: { source: 'import', file: path.basename(filename) } });
  bp.maxBlocks = maxBlocks;
  const stats = { cache: new Map(), unknown: new Set(), downgraded: new Set(), truncated: false, max: maxBlocks };
  const ext = path.extname(filename).toLowerCase();
  if (ext === '.litematic' || root.Regions) fromLitematic(root, bp, mcData, stats);
  else if (root.Schematic || (root.Palette && (root.BlockData || root.Blocks)) || root.Blocks?.Palette) fromSponge(root, bp, mcData, stats);
  else if (root.palette || root.palettes) fromStructure(root, bp, mcData, stats);
  else throw new Error(`Unknown build file format (${filename}). Supported: Sponge .schem, structure .nbt, .litematic.`);
  if (!bp.size) throw new Error(`${filename}: no blocks found (only air?).`);
  const out = bp.normalized();
  out.meta = bp.meta;
  const report = [];
  if (stats.truncated) report.push(`TRUNCATED at ${maxBlocks} blocks (file is bigger)`);
  if (stats.unknown.size) report.push(`skipped unknown blocks: ${[...stats.unknown].slice(0, 10).join(', ')}`);
  if (stats.downgraded.size) report.push(`dropped unknown states on: ${[...stats.downgraded].slice(0, 10).join(', ')}`);
  return { bp: out, report };
}

/** Resolve an import path: a bare file name is looked up in data/blueprints/import/. */
export function resolveImportFile(file) {
  const f = String(file || '').trim();
  if (!f) throw new Error('file is required');
  const cands = path.isAbsolute(f) ? [f] : [path.join(IMPORT_DIR, f), path.join(BP_DIR, f)];
  for (const c of cands) if (fs.existsSync(c)) return c;
  const have = listImportFiles();
  throw new Error(`File "${f}" not found in ${IMPORT_DIR}. Files there: ${have.join(', ') || 'none'} (ask the human player to drop .schem/.nbt/.litematic files there).`);
}
export function listImportFiles() {
  if (!fs.existsSync(IMPORT_DIR)) return [];
  return fs.readdirSync(IMPORT_DIR).filter((f) => /\.(schem|schematic|nbt|litematic)$/i.test(f));
}
export async function importFile(file, mcData, opts = {}) {
  const p = resolveImportFile(file);
  return importBuffer(fs.readFileSync(p), mcData, { ...opts, filename: p });
}
