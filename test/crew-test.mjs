// Runs crew/crew.js against the mock bridge with ONE real claude agent for ~1.5 minutes (costs ~$0.10)
// and checks the jsonl log: only mcp__mc__* tools exist, the agent called some, logs reached the bridge.
//   node test/crew-test.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMock } from './mcp-mock-bridge.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 47969;
const mock = await startMock(PORT);
const logf = path.join(root, 'crew', 'logs', 'Ash.jsonl');
try { fs.unlinkSync(logf); } catch { /* none */ }
const cp = spawn(process.execPath, [path.join(root, 'crew', 'crew.js'), '--agents', '1', '--minutes', '1.5', '--url', `http://127.0.0.1:${PORT}`], { stdio: 'inherit' });
await new Promise(r => cp.on('exit', r));
let fails = 0; const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) fails++; };
const ev = fs.readFileSync(logf, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return {}; } });
const init = ev.find(e => e.type === 'system' && e.subtype === 'init');
const used = ev.flatMap(e => e.type === 'assistant' ? (e.message?.content || []).filter(c => c.type === 'tool_use').map(c => c.name) : []);
ok(init && init.tools.length > 0 && init.tools.every(t => t.startsWith('mcp__mc__')), `only mcp__mc__* tools available (${init?.tools.length})`);
ok(used.length > 0 && used.every(t => t.startsWith('mcp__mc__')), `agent called ${used.length} mc tools`);
ok(mock.S.logs.some(l => l.kind === 'tool') && mock.S.logs.some(l => l.kind === 'result'), `log lines posted to bridge (${mock.S.logs.length})`);
ok(mock.S.bots.Ash?.role === 'Lead', 'POST /bots registered Ash as Lead');
console.log(fails ? `${fails} FAILED` : 'ALL PASSED'); mock.close(); process.exit(fails ? 1 : 0);
