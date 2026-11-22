// Tests mcp/mc-mcp.js with a real MCP SDK client over stdio against the mock bridge.
//   node test/mcp-test.mjs
import './neutral-player.mjs'; // neutral human player (Robin / robin_mc), set before the bridge reads config
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMock } from './mcp-mock-bridge.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 47969;
const mock = await startMock(PORT);
let fails = 0;
const ok = (c, msg) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${msg}`); if (!c) fails++; };

const client = new Client({ name: 'test', version: '0' });
await client.connect(new StdioClientTransport({
  command: process.execPath, args: [path.join(root, 'mcp', 'mc-mcp.js')],
  env: { ...process.env, HIVE_BOT: 'Ash', HIVE_URL: `http://127.0.0.1:${PORT}` }, stderr: 'inherit',
}));
const call = async (name, args = {}) => { const r = await client.callTool({ name, arguments: args }); return { err: !!r.isError, text: r.content.map(c => c.text).join('\n') }; };

const { tools } = await client.listTools();
const names = tools.map(t => t.name);
ok(['goto', 'collect', 'craft', 'send_message', 'check_messages', 'board_claim', 'waypoint_save', 'memory_save', 'goal', 'status', 'team_status'].every(n => names.includes(n)), `tools listed (${names.length}): ${names.join(', ')}`);
const goto = tools.find(t => t.name === 'goto');
ok(goto.inputSchema.required?.includes('x') && goto.inputSchema.properties.interrupt, 'goto keeps raw JSON schema (+interrupt)');

let r = await call('goto', { x: 5, y: 64, z: 5 });
ok(!r.err && r.text.includes('OK goto') && r.text.includes('[hp 20') && r.text.includes('no unread'), 'action works, vitals + unread line appended\n' + r.text);
ok(mock.S.acts.at(-1).args.x === 5 && mock.S.acts.at(-1).args.interrupt === undefined, 'interrupt not leaked into engine args');
r = await call('collect', { block: 'diamond_ore', count: 1 });
ok(r.err && r.text.includes('No diamond_ore'), 'engine failure -> isError result: ' + r.text.split('\n')[0]);
r = await call('goto', { x: 999, y: 1, z: 1 });
ok(r.err && /busy/.test(r.text) && /stop/.test(r.text), 'busy -> hint: ' + r.text.split('\n')[0]);
r = await call('stop');
ok(!r.err && mock.S.acts.at(-1).action === 'STOP', 'stop uses POST /stop');

// messaging: Flint talks to Ash
await fetch(`http://127.0.0.1:${PORT}/msg`, { method: 'POST', body: JSON.stringify({ from: 'Flint', to: 'all', text: 'found iron at 120,40,-33' }) });
r = await call('status');
ok(r.text.includes('1 unread'), 'unread line shows 1: ' + r.text.split('\n').pop());
r = await call('check_messages', { wait_seconds: 0 });
ok(r.text.startsWith('[Flint→all] found iron at 120,40,-33'), 'check_messages compact format: ' + r.text.split('\n')[0]);
r = await call('check_messages', { wait_seconds: 0 });
ok(r.text.includes('No new messages'), 'cursor advanced');
// long-poll wakes on message
const t0 = Date.now();
setTimeout(() => fetch(`http://127.0.0.1:${PORT}/msg`, { method: 'POST', body: JSON.stringify({ from: 'Robin', to: 'Ash', text: 'hi' }) }), 700);
r = await call('check_messages', { wait_seconds: 10 });
ok(Date.now() - t0 < 5000 && r.text.includes('[Robin→you] hi'), `long-poll woke early (${Date.now() - t0}ms): ` + r.text);
r = await call('send_message', { to: 'Flint', text: 'on my way' });
ok(mock.S.msgs.at(-1).from === 'Ash' && mock.S.msgs.at(-1).to === 'Flint', 'send_message posts');

// board
r = await call('board_add', { title: 'Mine 24 iron', priority: 1 }); ok(r.text.includes('#1'), 'board_add: ' + r.text.split('\n')[0]);
r = await call('board_claim', { id: 1 }); ok(r.text.includes('claimed:Ash'), 'board_claim');
mock.S.board[0].owner = 'Flint';
r = await call('board_claim', { id: 1 }); ok(r.err && r.text.includes('already claimed'), 'claim conflict -> isError: ' + r.text.split('\n')[0]);
r = await call('board_update', { id: 1, status: 'done', note: '12 ingots' }); ok(r.text.includes('done'), 'board_update');
r = await call('board'); ok(r.text.includes('Mine 24 iron'), 'board');
// waypoints / notes / memory / goal
r = await call('waypoint_save', { name: 'base' }); ok(mock.S.waypoints.base?.x === 1 && mock.S.waypoints.base?.y === 64, 'waypoint_save defaults to current position: ' + r.text.split('\n')[0]);
r = await call('waypoints'); ok(r.text.includes('base: 1,64,2'), 'waypoints');
await call('note_write', { key: 'iron', text: 'at 120,40,-33' }); r = await call('notes'); ok(r.text.includes('iron'), 'notes');
await call('memory_save', { text: 'doing X' }); r = await call('memory_read'); ok(r.text.includes('doing X'), 'memory roundtrip');
r = await call('goal'); ok(r.text.includes('no goal'), 'goal');
r = await call('team_status'); ok(!r.err, 'team_status: ' + r.text.split('\n')[0]);

// bridge down -> error result, not crash
mock.close(); mock.server.closeAllConnections?.();
r = await call('goto', { x: 1, y: 1, z: 1 });
ok(r.err, 'bridge down -> isError result, server survives: ' + r.text.split('\n')[0]);
await client.close();
console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
process.exit(fails ? 1 : 0);
