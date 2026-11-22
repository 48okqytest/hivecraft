// MCP tools/list check against the REAL engine registry (no Minecraft needed, no bots spawned):
// the bridge app serves GET /actions from bridge/engine, mc-mcp.js registers them, we list the tools.
//   node test/tools-list.mjs
import './neutral-player.mjs'; // neutral human player (Robin / robin_mc), live ports blocked
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createApp } from '../bridge/hub/app.js';
import * as engine from '../bridge/engine/index.js';
process.env.HIVE_EARNINGS_POLL = '0'; // tests never poll a live Minecraft server (earnings scoreboards/time)
const NO_RCON = { rcon: async (cmd) => { throw new Error(`no RCON in tests (${cmd})`); }, timers: false }; // never the real :25591

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.HIVE_PORT) || 47963;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-tools-'));
const app = createApp({ engine, dataDir, port: PORT, mc: { rconPort: 1 }, econOpts: NO_RCON });
await app.start();

const client = new Client({ name: 'tools-list', version: '0' });
await client.connect(new StdioClientTransport({
  command: process.execPath, args: [path.join(root, 'mcp', 'mc-mcp.js')],
  env: { ...process.env, HIVE_BOT: 'ToolsCheck', HIVE_URL: `http://127.0.0.1:${PORT}` }, stderr: 'pipe',
}));
const { tools } = await client.listTools();
const names = new Set(tools.map((t) => t.name));
const want = {
  robustness: ['escape', 'surface', 'goto', 'hunt', 'attack', 'look_around', 'nearest', 'inventory', 'blocks_at', 'use_block', 'use_item', 'craft_plan', 'craft', 'place', 'run_code'],
  viewer: ['survey', 'view', 'team_map', 'photo_share', 'photo_view'],
  builder: ['site_survey', 'find_build_site', 'blueprint_write', 'blueprint_list', 'blueprint_info', 'blueprint_preview', 'blueprint_check', 'blueprint_build', 'blueprint_verify', 'blueprint_capture'],
  team: ['send_message', 'check_messages', 'status', 'team_status', 'board', 'waypoints', 'memory_save', 'goal'],
};
let bad = 0;
for (const [group, list] of Object.entries(want)) {
  const miss = list.filter((n) => !names.has(n));
  console.log(`${miss.length ? 'FAIL' : 'PASS'}  ${group}: ${list.length - miss.length}/${list.length}${miss.length ? ' missing ' + miss.join(', ') : ''}`);
  bad += miss.length;
}
const internal = tools.filter((t) => t.name.startsWith('_'));
console.log(`${internal.length ? 'FAIL' : 'PASS'}  no internal tools exposed${internal.length ? ': ' + internal.map((t) => t.name).join(', ') : ''}`);
const noDesc = tools.filter((t) => !t.description || t.description.length < 20);
console.log(`${noDesc.length ? 'FAIL' : 'PASS'}  every tool has a real description${noDesc.length ? ': ' + noDesc.map((t) => t.name).join(', ') : ''}`);
const schemaBad = tools.filter((t) => t.inputSchema?.type !== 'object');
console.log(`${schemaBad.length ? 'FAIL' : 'PASS'}  every inputSchema is an object schema`);
console.log(`${tools.length} tools: ${[...names].sort().join(', ')}`);
await client.close();
await app.close();
fs.rmSync(dataDir, { recursive: true, force: true });
process.exit(bad || internal.length || noDesc.length || schemaBad.length ? 1 : 0);
