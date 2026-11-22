// Import FIRST in every offline test:
//   import { PLAYER, PLAYER_MC, assertNoLiveConnects } from './neutral-player.mjs';
//  - the human is a neutral test player (Robin / robin_mc), never the real hivecraft.config.json
//  - RCON / Minecraft / bridge defaults point at a dead port (1), so nothing can reach a live server by accident
//  - every TCP connect to a live Hivecraft port (25590 MC, 25591 RCON, 47960 bridge) is refused and recorded;
//    assertNoLiveConnects() fails the test if one was attempted
// Sets env before any bridge module reads the config (bridge/config.js reads it lazily); child processes inherit it.
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

export const PLAYER = 'Robin';        // display name / economy account
export const PLAYER_MC = 'robin_mc';  // Minecraft username (economy alias)
process.env.HIVE_CONFIG = path.join(os.tmpdir(), `hivecraft-test-${process.pid}-no-config.json`); // never created
process.env.HIVE_PLAYER = PLAYER_MC;
process.env.HIVE_PLAYER_NAME = PLAYER;
process.env.HIVE_RCON_PORT = '1';
process.env.HIVE_RCON_PASSWORD = 'offline-test';
process.env.HIVE_SERVER_DIR = path.join(os.tmpdir(), `hivecraft-test-${process.pid}-no-server`); // no server.properties
process.env.HIVE_EARNINGS_POLL = '0';

const LIVE_PORTS = new Set([25590, 25591, 47960]);
export const liveConnects = [];
const portOf = (a) => {
  const o = a[0];
  if (typeof o === 'object' && o !== null && !Array.isArray(o)) return Number(o.port);
  return typeof o === 'number' || /^\d+$/.test(String(o)) ? Number(o) : NaN;
};
const origConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...a) {
  const port = portOf(Array.isArray(a[0]) ? a[0] : a); // net internals may pass [options, cb] as one array
  if (LIVE_PORTS.has(port)) {
    liveConnects.push(port);
    const e = new Error(`offline test tried to connect to live port ${port} (blocked)`);
    process.nextTick(() => this.destroy(e));
    return this;
  }
  return origConnect.apply(this, a);
};

/** throws when any code in this process tried to reach a live MC / RCON / bridge port */
export function assertNoLiveConnects() {
  if (liveConnects.length) throw new Error(`offline test attempted TCP connects to live ports: ${[...new Set(liveConnects)].join(', ')}`);
}
