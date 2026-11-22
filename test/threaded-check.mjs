// Functional check of the threaded engine through the live bridge (no agents).
import { bridgeUrl, playerDisplayName } from '../bridge/config.js';
const B = bridgeUrl();
const HUMAN = playerDisplayName(); // hivecraft.config.json player
const j = (r) => r.json();
const post = (p, b) => fetch(B + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b ?? {}) }).then(j);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ok = true; const check = (name, cond, info) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${info ? ' :: ' + String(info).slice(0, 160) : ''}`); ok &&= !!cond; };
await post('/bots', { name: 'ThrA' }); await post('/bots', { name: 'ThrB' }); await sleep(2500);
const st = await (await fetch(B + '/bots/ThrA/state')).json();
check('state from worker', st.online && st.pos && Array.isArray(st.inventory), JSON.stringify(st.pos));
const sc = await post('/bots/ThrA/act', { action: 'scan', args: {} });
check('action result', sc.ok && /At /.test(sc.result), sc.result);
const bad = await post('/bots/ThrA/act', { action: 'craft', args: { item: 'diamond_pickaxe' } });
check('engine error text survives thread hop', !bad.ok && /Cannot craft/.test(bad.error), bad.error);
const t0 = Date.now(); const long = post('/bots/ThrA/act', { action: 'wait', args: { seconds: 30 } });
await sleep(800); await post('/bots/ThrA/stop');
const lr = await long; check('stop aborts a running action fast', !lr.ok && Date.now() - t0 < 5000, lr.error);
const t1 = Date.now(); const long2 = post('/bots/ThrB/act', { action: 'wait', args: { seconds: 30 } });
await sleep(800); await post('/msg', { from: HUMAN, to: 'ThrB', text: 'come here' });
const lr2 = await long2; check('human message interrupts', !lr2.ok && lr2.error.includes(`${HUMAN} (human)`) && Date.now() - t1 < 5000, lr2.error);
const m = await post('/msg', { from: 'ThrA', to: `ThrB,${HUMAN}`, text: 'multi test' });
check('multi-recipient message', m.to === `ThrB,${HUMAN}` && !m.warning, JSON.stringify(m).slice(0, 120));
const inbox = await (await fetch(B + '/msg/ThrB?since=0')).json();
check('recipient in list receives it', inbox.messages.some((x) => x.text === 'multi test'));
await post('/admin/rcon', { cmd: 'kick ThrA testing reconnect' });
let back = false; for (let i = 0; i < 30 && !back; i++) { await sleep(1000); const s = await (await fetch(B + '/bots/ThrA/state')).json(); back = s.online && s.pos; }
check('kicked bot reconnects (new worker)', back);
const sc2 = await post('/bots/ThrA/act', { action: 'scan', args: {} });
check('actions work after reconnect', sc2.ok, sc2.result || sc2.error);
await fetch(B + '/bots/ThrA', { method: 'DELETE' }); await fetch(B + '/bots/ThrB', { method: 'DELETE' });
process.exit(ok ? 0 : 1);
