// A human message must interrupt the receiving bot's long action within a few seconds.
import './neutral-player.mjs'; // neutral human player (Robin / robin_mc), set before the bridge reads config
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { createApp } from '../bridge/hub/app.js';
import * as mock from './hub-mock-engine.mjs';
process.env.HIVE_EARNINGS_POLL = '0'; // tests never poll a live Minecraft server (earnings scoreboards/time)
const NO_RCON = { rcon: async (cmd) => { throw new Error(`no RCON in tests (${cmd})`); }, timers: false }; // never the real :25591
const PORT = 47964, B = `http://127.0.0.1:${PORT}`;
const app = createApp({ engine: mock, dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'hive-int-')), port: PORT, mc: { rconPort: 1 }, econOpts: NO_RCON });
await app.start();
const post = (p, b) => fetch(B + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then((r) => r.json());
await new Promise((r) => setTimeout(r, 500));
await post('/bots', { name: 'Ash' }); await post('/bots', { name: 'Flint' });
let ok = true;
// 1) human message to all interrupts a long wait
const t0 = Date.now();
const act = post('/bots/Ash/act', { action: 'wait', args: { seconds: 60 } });
setTimeout(() => post('/msg', { from: 'Robin', to: 'all', text: 'build a castle' }), 1000);
const r = await act; const dt = (Date.now() - t0) / 1000;
const pass1 = !r.ok && /Robin \(human\).*build a castle/.test(r.error) && dt < 8;
console.log(`${pass1 ? 'PASS' : 'FAIL'}  human msg interrupts long action in ${dt.toFixed(1)}s :: ${r.error}`); ok &&= pass1;
// 2) a bot-to-bot message must NOT interrupt
const t1 = Date.now();
const act2 = post('/bots/Ash/act', { action: 'wait', args: { seconds: 3 } });
setTimeout(() => post('/msg', { from: 'Flint', to: 'Ash', text: 'hi' }), 500);
const r2 = await act2; const pass2 = r2.ok && (Date.now() - t1) / 1000 >= 2.5;
console.log(`${pass2 ? 'PASS' : 'FAIL'}  bot message does not interrupt :: ${JSON.stringify(r2).slice(0, 120)}`); ok &&= pass2;
process.exit(ok ? 0 : 1);
