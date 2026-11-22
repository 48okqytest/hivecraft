// Plan a build: world targets, status of each vs the real world, bill of materials, what to clear / fill,
// build order, sections (for splitting between bots) and a time estimate.
import { worldBlocks, key3 } from './model.js';
import { AIRISH, itemForBlock, itemCount, isAutoPart, isReplaceableName, isSoftName, stateDiff, worldState } from './states.js';
import { isAttachment } from './rules.js';

export const PROTECTED = /^(chest|trapped_chest|barrel|ender_chest|furnace|blast_furnace|smoker|.*_bed|.*shulker_box|enchanting_table|anvil|brewing_stand|beacon|spawner|bedrock|end_portal_frame|reinforced_deepslate|command_block|barrier)$/;

/** world targets with keys; air entries kept (they mean "must be empty") */
export function targetsFor(bp, place) {
  return worldBlocks(bp, place).map((t) => ({ ...t, key: key3(t.x, t.y, t.z), air: AIRISH.has(t.name) }));
}

export function boundsOf(targets) {
  const b = { minX: Infinity, minY: Infinity, minZ: Infinity, maxX: -Infinity, maxY: -Infinity, maxZ: -Infinity };
  for (const t of targets) {
    b.minX = Math.min(b.minX, t.x); b.minY = Math.min(b.minY, t.y); b.minZ = Math.min(b.minZ, t.z);
    b.maxX = Math.max(b.maxX, t.x); b.maxY = Math.max(b.maxY, t.y); b.maxZ = Math.max(b.maxZ, t.z);
  }
  return b;
}

/**
 * status of one target vs a world block (prismarine block or {name, getProperties}):
 * done | place (empty, can place now) | conflict (other block in the way) | wrong (right block, wrong state) | unloaded
 */
export function targetStatus(t, wb) {
  if (!wb) return 'unloaded';
  if (t.air) return isReplaceableName(wb.name) ? 'done' : 'conflict';
  const have = worldState(wb);
  const d = stateDiff(t, have);
  if (d === null) return 'done';
  if (have.name === t.name) return 'wrong';
  if (isReplaceableName(wb.name)) return 'place';
  return 'conflict';
}

/** classify all targets; blockAt(x,y,z) -> world block */
export function classify(targets, blockAt) {
  const by = { done: [], place: [], conflict: [], wrong: [], unloaded: [] };
  for (const t of targets) {
    const wb = blockAt(t.x, t.y, t.z);
    const s = targetStatus(t, wb);
    t.status = s;
    t.actual = wb ? wb.name : null;
    by[s].push(t);
  }
  return by;
}

/** bill of materials for targets that still need placing: Map item -> count; plus unplaceable list */
export function billOfMaterials(targets, mcData) {
  const need = new Map(), unplaceable = new Map();
  for (const t of targets) {
    if (t.air || t.status === 'done') continue;
    const n = itemCount(t.name, t.props);
    if (!n) continue;
    const item = itemForBlock(mcData, t.name);
    if (!item) { unplaceable.set(t.name, (unplaceable.get(t.name) || 0) + 1); continue; }
    // a double slab that already has its bottom half only needs one more
    const k = t.status === 'wrong' && /_slab$/.test(t.name) && t.props.type === 'double' && t.actual === t.name ? 1 : n;
    need.set(item, (need.get(item) || 0) + k);
  }
  return { need, unplaceable };
}

/** compare need vs have maps -> [{item, need, inv, chest, missing}] */
export function materialCheck(need, inv, chest = null) {
  const rows = [];
  for (const [item, n] of [...need].sort((a, b) => b[1] - a[1])) {
    const i = inv.get(item) || 0, c = chest ? chest.get(item) || 0 : 0;
    rows.push({ item, need: n, inv: i, chest: c, missing: Math.max(0, n - i - c) });
  }
  return rows;
}

/**
 * Terrain work inside the build volume:
 *  clear = solid blocks in the way (conflicts + with mode 'bbox' everything non-air in the bbox that the blueprint
 *          does not want, from the first layer up), fill = holes under the bottom layer down to the ground (max depth).
 */
export function terrainWork(targets, blockAt, { clear = 'bbox', fill = true, maxFillDepth = 6, bounds, isBuilt = null } = {}) {
  const b = bounds || boundsOf(targets);
  const want = new Map(targets.map((t) => [t.key, t]));
  const clearList = [], protectedHits = [];
  const addClear = (x, y, z, wb) => {
    // team blocks (chests/beds) and anything another build placed are never cleared for a new site
    if (PROTECTED.test(wb.name) || isBuilt?.(x, y, z, wb.name)) { protectedHits.push({ x, y, z, name: wb.name }); return; }
    clearList.push({ x, y, z, name: wb.name, soft: isSoftName(wb.name) });
  };
  if (clear === 'bbox') {
    for (let y = b.minY; y <= b.maxY; y++) for (let x = b.minX; x <= b.maxX; x++) for (let z = b.minZ; z <= b.maxZ; z++) {
      const wb = blockAt(x, y, z);
      if (!wb || AIRISH.has(wb.name)) continue;
      const t = want.get(key3(x, y, z));
      if (t && !t.air) {
        const s = targetStatus(t, wb);
        if (s === 'conflict' || (s === 'wrong' && !/_slab$/.test(t.name))) addClear(x, y, z, wb);
        continue;
      }
      if (wb.name === 'water' || wb.name === 'lava') continue; // filled over by placing blocks
      addClear(x, y, z, wb);
    }
  } else if (clear !== 'none') {
    for (const t of targets) {
      const wb = blockAt(t.x, t.y, t.z);
      if (!wb || AIRISH.has(wb.name)) continue;
      const s = targetStatus(t, wb);
      if (s === 'conflict' || (s === 'wrong' && !/_slab$/.test(t.name))) addClear(t.x, t.y, t.z, wb);
    }
  }
  const fillList = [];
  if (fill) {
    // bottom-layer targets standing on nothing: fill down to solid ground
    const cols = new Map();
    for (const t of targets) {
      if (t.air) continue;
      const ck = `${t.x},${t.z}`;
      const c = cols.get(ck);
      if (!c || t.y < c.y) cols.set(ck, t);
    }
    for (const t of cols.values()) {
      if (t.y !== b.minY) continue; // only the foundation layer
      for (let y = t.y - 1, d = 0; d < maxFillDepth; y--, d++) {
        const wb = blockAt(t.x, y, t.z);
        if (!wb) break;
        if (!(AIRISH.has(wb.name) || isReplaceableName(wb.name) || /_leaves$/.test(wb.name))) break;
        if (want.has(key3(t.x, y, t.z))) break;
        fillList.push({ x: t.x, y, z: t.z, replacing: wb.name });
      }
    }
  }
  clearList.sort((p, q) => q.y - p.y); // top-down
  fillList.sort((p, q) => p.y - q.y); // bottom-up
  return { clear: clearList, fill: fillList, protected: protectedHits };
}

/** split the footprint into n strips along the longer horizontal axis -> [{id, minX,maxX,minZ,maxZ}] */
export function makeSections(bounds, n = 1) {
  const b = bounds;
  const W = b.maxX - b.minX + 1, D = b.maxZ - b.minZ + 1;
  const parts = Math.max(1, Math.min(n, Math.max(W, D)));
  const out = [];
  const alongX = W >= D;
  const len = alongX ? W : D;
  for (let i = 0; i < parts; i++) {
    const a = Math.floor((i * len) / parts), c = Math.floor(((i + 1) * len) / parts) - 1;
    out.push(alongX
      ? { id: i, minX: b.minX + a, maxX: b.minX + c, minZ: b.minZ, maxZ: b.maxZ }
      : { id: i, minX: b.minX, maxX: b.maxX, minZ: b.minZ + a, maxZ: b.minZ + c });
  }
  return out;
}
export const inSection = (s, x, z) => !s || (x >= s.minX && x <= s.maxX && z >= s.minZ && z <= s.maxZ);

/** sort for placing: structural layer by layer, then attachments; auto parts dropped */
export function buildOrder(targets) {
  const solid = targets.filter((t) => !t.air && !isAutoPart(t.name, t.props));
  const structural = solid.filter((t) => !isAttachment(t.name));
  const attach = solid.filter((t) => isAttachment(t.name));
  const byY = (a) => a.sort((p, q) => p.y - q.y || p.x - q.x || p.z - q.z);
  return { structural: byY(structural), attach: byY(attach) };
}

/** rough seconds for the remaining work */
export function estimateSeconds({ place = 0, clear = 0, softClear = 0, fill = 0, trips = 0 }) {
  return Math.round(place * 0.9 + (clear - softClear) * 1.6 + softClear * 0.4 + fill * 0.9 + trips * 40 + 5);
}
export const fmtDuration = (s) => (s < 90 ? `${s}s` : s < 5400 ? `${Math.round(s / 60)} min` : `${(s / 3600).toFixed(1)} h`);

/** top-down ASCII of a set of targets: highest block's first letter per column (legend returned) */
export function topView(targets, { maxW = 48, maxD = 48 } = {}) {
  const solid = targets.filter((t) => !t.air);
  if (!solid.length) return '(empty)';
  const b = boundsOf(solid);
  const W = b.maxX - b.minX + 1, D = b.maxZ - b.minZ + 1;
  if (W > maxW || D > maxD) return `(top view skipped: ${W}x${D} is too big to print)`;
  const top = new Map();
  for (const t of solid) { const k = `${t.x},${t.z}`; const c = top.get(k); if (!c || t.y > c.y) top.set(k, t); }
  const legend = new Map(), used = new Set();
  const charFor = (name) => {
    if (legend.has(name)) return legend.get(name);
    const base = name.replace(/^(oak|spruce|birch|jungle|acacia|dark_oak|mangrove|cherry|bamboo|crimson|warped|polished|mossy|cracked|smooth|cut|chiseled)_/, '');
    let ch = [...(base[0] || '?') + base.replace(/[^a-z]/g, '') + 'xyzwvqk'].map((c) => c).find((c) => !used.has(c)) || '?';
    if (/_stairs$/.test(name) && !used.has('^')) ch = '^';
    else if (/_slab$/.test(name) && !used.has('_')) ch = '_';
    else if (/_door$/.test(name) && !used.has('D')) ch = 'D';
    else if (/glass/.test(name) && !used.has('o')) ch = 'o';
    used.add(ch); legend.set(name, ch); return ch;
  };
  const lines = [];
  for (let z = b.minZ; z <= b.maxZ; z++) {
    let s = '';
    for (let x = b.minX; x <= b.maxX; x++) { const t = top.get(`${x},${z}`); s += t ? charFor(t.name) : '.'; }
    lines.push(s);
  }
  return `${lines.join('\n')}\nlegend: ${[...legend].map(([n, c]) => `${c}=${n}`).join(' ')} (top block per column; north is up)`;
}
