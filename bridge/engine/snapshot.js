// World snapshot for the viewer. Runs INSIDE the bot's worker thread (reads bot.world directly, no packets).
//
//   await takeSnapshot(bot, { center, radius=24, up=20, down=16, box, entities=true, surface=false })
//
// Full mode -> {
//   v:1, kind:'blocks', origin:{x,y,z}, size:{x,y,z}, palette:['air','stone','oak_stairs[facing=north,...]',...],
//   cells: Uint16Array(size.x*size.y*size.z)  index ((y-oy)*size.z + (z-oz))*size.x + (x-ox) -> palette index (0 = air / not loaded)
//   light: Uint8Array same layout, (skyLight<<4)|blockLight, lightOk (server sent light data)
//   entities:[{id,kind:'player'|'hostile'|'animal'|'item'|'other',name,pos,yaw,pitch,h,w,item?}], chests:[{x,y,z,name}],
//   bot:{name,pos,eye,yaw,pitch,held,health,food}, time:{timeOfDay,isDay}, dimension, unloaded:<columns missing>, ms }
// Surface mode (team map) -> { kind:'surface', origin:{x,z}, size:{x,z}, palette, top:Uint16Array, height:Int16Array, ... }
//
// Caps: radius <= 48 (box <= 97 wide; an explicit box may be up to 97x96x97), <= 1.6M cells; the scan yields to the
// event loop after every chunk column, so physics keeps ticking.
import prismarineBlock from 'prismarine-block';
import { isHostile } from './nav.js';

const MAX_R = 48, MAX_SPAN = 97, MAX_H = 96, MAX_CELLS = 1_600_000;
const AIRS = new Set(['air', 'cave_air', 'void_air']);
const CONTAINER = /^(chest|trapped_chest|barrel|ender_chest|.*shulker_box|furnace|blast_furnace|smoker|crafting_table|hopper)$/;
const tick = () => new Promise((r) => setImmediate(r));
const clampI = (v, lo, hi) => Math.max(lo, Math.min(hi, Math.round(v)));

const keyCaches = new WeakMap(); // registry -> Map(stateId -> key)
function stateKeyFn(bot) {
  let c = keyCaches.get(bot.registry);
  if (!c) { c = { map: new Map(), Block: prismarineBlock(bot.registry) }; keyCaches.set(bot.registry, c); }
  return (sid) => {
    let k = c.map.get(sid);
    if (k !== undefined) return k;
    const def = bot.registry.blocksByStateId[sid];
    if (!def) k = 'air';
    else {
      let props = {};
      try { props = c.Block.fromStateId(sid, 0).getProperties() || {}; } catch { /* stateless */ }
      const ks = Object.keys(props).sort();
      k = ks.length ? `${def.name}[${ks.map((p) => `${p}=${props[p]}`).join(',')}]` : def.name;
      if (AIRS.has(def.name)) k = 'air';
    }
    c.map.set(sid, k);
    return k;
  };
}

function entityKind(bot, e) {
  if (e.type === 'player') return 'player';
  if (e.name === 'item') return 'item';
  if (isHostile(bot, e) || e.type === 'hostile') return 'hostile';
  if (['animal', 'passive', 'water_creature', 'ambient', 'mob'].includes(e.type)) return 'animal';
  return 'other';
}

function listEntities(bot, min, max) {
  const out = [];
  for (const e of Object.values(bot.entities || {})) {
    if (!e?.position || e === bot.entity) continue;
    const p = e.position;
    if (p.x < min.x - 1 || p.x > max.x + 1 || p.y < min.y - 2 || p.y > max.y + 2 || p.z < min.z - 1 || p.z > max.z + 1) continue;
    const kind = entityKind(bot, e);
    const rec = { id: e.id, kind, name: (kind === 'player' ? e.username : e.name) || e.displayName || 'entity', pos: { x: +p.x.toFixed(2), y: +p.y.toFixed(2), z: +p.z.toFixed(2) }, yaw: +(e.yaw || 0).toFixed(3), pitch: +(e.pitch || 0).toFixed(3), h: e.height || (kind === 'item' ? 0.25 : 1.8), w: e.width || (kind === 'item' ? 0.25 : 0.6) };
    if (kind === 'item') { try { rec.item = e.getDroppedItem?.()?.name || null; } catch { /* */ } }
    if (kind === 'player') rec.name = e.username || rec.name;
    out.push(rec);
    if (out.length >= 200) break;
  }
  return out;
}

function botInfo(bot) {
  const p = bot.entity?.position;
  return {
    name: bot.username, pos: p ? { x: +p.x.toFixed(2), y: +p.y.toFixed(2), z: +p.z.toFixed(2) } : null,
    eye: p ? { x: +p.x.toFixed(2), y: +(p.y + (bot.entity.height > 1.7 ? 1.62 : 1.27)).toFixed(2), z: +p.z.toFixed(2) } : null,
    yaw: bot.entity?.yaw ?? 0, pitch: bot.entity?.pitch ?? 0, held: bot.heldItem?.name || null, health: bot.health, food: bot.food,
  };
}

export async function takeSnapshot(bot, opts = {}) {
  const t0 = Date.now();
  if (!bot?.entity?.position) throw new Error('bot has not spawned yet');
  const bp = bot.entity.position;
  const c = opts.center ? { x: Math.floor(opts.center.x), y: Math.floor(opts.center.y ?? bp.y), z: Math.floor(opts.center.z) } : { x: Math.floor(bp.x), y: Math.floor(bp.y), z: Math.floor(bp.z) };
  const minY = bot.game?.minY ?? -64, maxY = minY + (bot.game?.height ?? 384) - 1;
  if (opts.surface) return surfaceSnapshot(bot, c, opts, t0, minY, maxY);

  let min, max;
  if (opts.box?.min && opts.box?.max) {
    const b = opts.box;
    min = { x: Math.floor(Math.min(b.min.x, b.max.x)), y: Math.floor(Math.min(b.min.y, b.max.y)), z: Math.floor(Math.min(b.min.z, b.max.z)) };
    max = { x: Math.floor(Math.max(b.min.x, b.max.x)), y: Math.floor(Math.max(b.min.y, b.max.y)), z: Math.floor(Math.max(b.min.z, b.max.z)) };
    // clamp spans around the box centre
    for (const [a, cap] of [['x', MAX_SPAN], ['y', MAX_H], ['z', MAX_SPAN]]) {
      if (max[a] - min[a] + 1 > cap) { const mid = Math.floor((min[a] + max[a]) / 2); min[a] = mid - Math.floor(cap / 2); max[a] = min[a] + cap - 1; }
    }
  } else {
    const r = clampI(opts.radius ?? 24, 2, MAX_R);
    const up = clampI(opts.up ?? 20, 2, MAX_H), down = clampI(opts.down ?? 16, 2, MAX_H);
    min = { x: c.x - r, y: c.y - down, z: c.z - r };
    max = { x: c.x + r, y: c.y + up, z: c.z + r };
  }
  min.y = Math.max(min.y, minY); max.y = Math.min(max.y, maxY);
  const size = { x: max.x - min.x + 1, y: max.y - min.y + 1, z: max.z - min.z + 1 };
  while (size.x * size.y * size.z > MAX_CELLS && size.y > 8) { max.y--; size.y--; if (size.x * size.y * size.z > MAX_CELLS && size.y > 8) { min.y++; size.y--; } }

  const SX = size.x, SZ = size.z, SXZ = SX * SZ;
  const cells = new Uint16Array(SX * size.y * SZ);
  const light = new Uint8Array(cells.length);
  const keyOf = stateKeyFn(bot);
  const palette = ['air'];
  const palIdx = new Map([['air', 0]]);
  const sidToPal = new Map();
  const chests = [];
  let unloaded = 0, lightAny = 0;
  const lp = { x: 0, y: 0, z: 0 };

  for (let cx = min.x >> 4; cx <= max.x >> 4; cx++) {
    for (let cz = min.z >> 4; cz <= max.z >> 4; cz++) {
      const col = bot.world.getColumn(cx, cz);
      if (!col) { unloaded++; continue; }
      const x0 = Math.max(min.x, cx * 16), x1 = Math.min(max.x, cx * 16 + 15);
      const z0 = Math.max(min.z, cz * 16), z1 = Math.min(max.z, cz * 16 + 15);
      for (let y = min.y; y <= max.y; y++) {
        lp.y = y;
        const yo = (y - min.y) * SXZ;
        for (let z = z0; z <= z1; z++) {
          lp.z = z & 15;
          const zo = yo + (z - min.z) * SX;
          for (let x = x0; x <= x1; x++) {
            lp.x = x & 15;
            const sid = col.getBlockStateId(lp);
            let pi = sidToPal.get(sid);
            if (pi === undefined) {
              const k = keyOf(sid);
              pi = palIdx.get(k);
              if (pi === undefined) { pi = palette.length; palette.push(k); palIdx.set(k, pi); }
              sidToPal.set(sid, pi);
            }
            const i = zo + (x - min.x);
            cells[i] = pi;
            if (pi !== 0) {
              const k = palette[pi];
              if (chests.length < 200 && CONTAINER.test(k.split('[')[0])) chests.push({ x, y, z, name: k.split('[')[0] });
            }
            const l = ((col.getSkyLight(lp) & 15) << 4) | (col.getBlockLight(lp) & 15);
            light[i] = l; lightAny |= l;
          }
        }
      }
      if (opts.signal?.aborted) throw new Error('Stopped');
      await tick();
    }
  }
  return {
    v: 1, kind: 'blocks', origin: min, size, palette, cells, light, lightOk: lightAny !== 0,
    entities: opts.entities === false ? [] : listEntities(bot, min, max), chests,
    bot: botInfo(bot), center: c, time: { timeOfDay: bot.time?.timeOfDay ?? 6000, isDay: bot.time ? bot.time.isDay !== false : true },
    dimension: (bot.game?.dimension || 'overworld').replace(/^minecraft:/, ''), unloaded, ms: Date.now() - t0,
  };
}

// top block per column, for the team map (cheap: scans down from the highest loaded section)
async function surfaceSnapshot(bot, c, opts, t0, minY, maxY) {
  const r = clampI(opts.radius ?? 96, 8, 160);
  const min = { x: c.x - r, z: c.z - r };
  const S = 2 * r + 1;
  const top = new Uint16Array(S * S), height = new Int16Array(S * S).fill(-32768);
  const keyOf = stateKeyFn(bot);
  const palette = ['air']; const palIdx = new Map([['air', 0]]); const sidToPal = new Map();
  const yHi = Math.min(maxY, clampI(opts.top ?? c.y + 80, minY, maxY)), yLo = Math.max(minY, c.y - 64);
  const lp = { x: 0, y: 0, z: 0 };
  let loaded = 0;
  for (let cx = min.x >> 4; cx <= (min.x + S - 1) >> 4; cx++) {
    for (let cz = min.z >> 4; cz <= (min.z + S - 1) >> 4; cz++) {
      const col = bot.world.getColumn(cx, cz);
      if (!col) continue;
      loaded++;
      for (let z = Math.max(min.z, cz * 16); z <= Math.min(min.z + S - 1, cz * 16 + 15); z++) {
        for (let x = Math.max(min.x, cx * 16); x <= Math.min(min.x + S - 1, cx * 16 + 15); x++) {
          lp.x = x & 15; lp.z = z & 15;
          for (let y = yHi; y >= yLo; y--) {
            lp.y = y;
            const sid = col.getBlockStateId(lp);
            let pi = sidToPal.get(sid);
            if (pi === undefined) {
              const k = keyOf(sid); pi = palIdx.get(k);
              if (pi === undefined) { pi = palette.length; palette.push(k); palIdx.set(k, pi); }
              sidToPal.set(sid, pi);
            }
            if (pi === 0) continue;
            const k = palette[pi];
            if (/^(short_grass|tall_grass|fern|large_fern|light|barrier)\b/.test(k)) continue; // see the ground under grass
            const i = (z - min.z) * S + (x - min.x);
            top[i] = pi; height[i] = y; break;
          }
        }
      }
      await tick();
    }
  }
  return { v: 1, kind: 'surface', origin: min, size: { x: S, z: S }, palette, top, height, bot: botInfo(bot), center: c, loadedColumns: loaded, entities: opts.entities === false ? [] : listEntities(bot, { x: min.x, y: yLo, z: min.z }, { x: min.x + S, y: yHi, z: min.z + S }), ms: Date.now() - t0 };
}
