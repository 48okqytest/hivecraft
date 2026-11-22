// Protected blocks: things the team BUILT must never be harvested by collect/mine_block or dug through
// by the pathfinder. Runs inside each bot worker.
//
// Sources (refreshed every 10 s, never blocking an action):
//  1. the hub's block ledger: every block a bot deliberately placed that is still standing
//     (GET /mod/protected; scaffolding / pathfinder pillars are excluded, they are junk);
//  2. blueprint build jobs on disk: the whole bounding box (+1) of every build site;
//  3. logs/wood must belong to a natural tree (non-persistent leaves at the top of the trunk),
//     which also keeps the human player's own log builds safe even though they aren't in the ledger.
import fs from 'node:fs';
import path from 'node:path';
import { BUILDS_DIR } from './blueprint/model.js';
import { bridgePort } from '../config.js';

const HUB = `http://127.0.0.1:${bridgePort()}`; // HIVE_PORT, else hivecraft.config.json bridge.port
const REFRESH_MS = 10000;
const key = (x, y, z) => `${x},${y},${z}`;

let placed = new Map(); // "x,y,z" -> block name placed by a bot
let boxes = [];         // [{minX..maxZ, id}]
let lastRefresh = 0;
let refreshing = null;

async function refresh() {
  lastRefresh = Date.now();
  try {
    const res = await fetch(`${HUB}/mod/protected`, { signal: AbortSignal.timeout(3000) });
    if (res.ok) {
      const j = await res.json();
      const m = new Map();
      for (const [x, y, z, name] of j.blocks || []) m.set(key(x, y, z), name);
      placed = m;
    }
  } catch { /* hub busy or down: keep the last list */ }
  try {
    const out = [];
    if (fs.existsSync(BUILDS_DIR)) {
      for (const d of fs.readdirSync(BUILDS_DIR)) {
        try {
          const j = JSON.parse(fs.readFileSync(path.join(BUILDS_DIR, d, 'job.json'), 'utf8'));
          const b = j.bounds;
          if (b && Number.isFinite(b.minX)) out.push({ id: j.id, minX: b.minX - 1, minY: b.minY - 1, minZ: b.minZ - 1, maxX: b.maxX + 1, maxY: b.maxY + 1, maxZ: b.maxZ + 1 });
        } catch { /* half-written job: skip */ }
      }
    }
    boxes = out;
  } catch { /* keep last */ }
}

/** Kick a background refresh if the data is stale. Cheap; call often. */
export function touch() {
  if (!refreshing && Date.now() - lastRefresh > REFRESH_MS) refreshing = refresh().finally(() => { refreshing = null; });
  return refreshing;
}

/** Make sure we have data at least once (first collect after a restart). */
export async function ready() { touch(); if (!lastRefresh || refreshing) await refreshing; }

const inBox = (p) => boxes.find((b) => p.x >= b.minX && p.x <= b.maxX && p.y >= b.minY && p.y <= b.maxY && p.z >= b.minZ && p.z <= b.maxZ);
const isLog = (n) => /_(log|wood|stem|hyphae)$/.test(n) && !n.startsWith('stripped_');
const isLeaves = (n) => /_leaves$|^(nether_wart_block|warped_wart_block|shroomlight)$/.test(n);

/** True if a log at p is part of a natural tree: walk up the trunk and look for natural (non-persistent) leaves. */
export function naturalLog(bot, p) {
  let top = p;
  for (let i = 0; i < 24; i++) {
    const b = bot.blockAt(top.offset(0, 1, 0));
    if (!b || !isLog(b.name)) break;
    top = top.offset(0, 1, 0);
  }
  for (let dy = -1; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) {
    const b = bot.blockAt(top.offset(dx, dy, dz));
    if (!b || !isLeaves(b.name)) continue;
    if (!/_leaves$/.test(b.name)) return true; // nether "trees": wart blocks are never persistent-flagged
    const pr = b.getProperties?.() || {};
    if (pr.persistent === false || pr.persistent === 'false') return true;
  }
  return false;
}

/**
 * Why the block at p must not be harvested, or null if it's fair game.
 * opts.self: build ids this bot is building right now (its own site may be cleared).
 */
export function protectedReason(bot, p, { checkTree = true } = {}) {
  touch();
  const b = bot.blockAt(p);
  if (!b) return null;
  const who = placed.get(key(p.x, p.y, p.z));
  if (who && who === b.name) return `the team built it (placed ${b.name})`;
  const box = inBox(p);
  if (box) return `it's inside the build site of ${box.id}`;
  if (checkTree && isLog(b.name) && !naturalLog(bot, p)) return `that ${b.name} isn't part of a natural tree (looks built)`;
  return null;
}

/** True if a bot placed this exact block here (ledger) and it is still standing. */
export const builtAt = (x, y, z, name) => { touch(); const w = placed.get(key(x, y, z)); return !!w && (!name || w === name); };

export const isProtected = (bot, p, o) => protectedReason(bot, p, o) != null;

/**
 * Pathfinder break exclusion. mineflayer-pathfinder treats a weight >= 100 as "never break this block",
 * so team-built blocks are never dug through; other blocks inside build sites only get a big detour cost.
 */
export function pathfinderGuard(block) {
  if (!block?.position) return 0;
  touch();
  const p = block.position;
  const who = placed.get(key(p.x, p.y, p.z));
  if (who && who === block.name) return 100;
  if (inBox(p)) return 40;
  return 0;
}

export function stats() { return { placed: placed.size, sites: boxes.length, age: Date.now() - lastRefresh }; }
