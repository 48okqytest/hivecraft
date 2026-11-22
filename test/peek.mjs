// Quick text view of a running Hivecraft team:  node test/peek.mjs [messages=25]
import { bridgeUrl } from '../bridge/config.js';
const B = bridgeUrl(); // HIVE_URL, else hivecraft.config.json bridge.port
const get = (p) => fetch(B + p).then((r) => r.json());
const n = Number(process.argv[2]) || 25;
const t = (ts) => new Date(ts).toTimeString().slice(0, 8);
const [bots, msgs, board, wps] = await Promise.all([get('/bots'), get(`/messages?limit=${n}`), get('/board'), get('/waypoints')]);
console.log('== BOTS');
for (const b of bots) console.log(`${b.name.padEnd(6)} ${b.online ? 'on ' : 'OFF'} hp${b.health} food${b.food} @${b.pos ? `${b.pos.x},${b.pos.y},${b.pos.z}` : '?'} act=${b.currentAction || '-'}`);
console.log('== CHAT');
for (const m of msgs.messages || msgs) if (m.from !== 'system') console.log(`${t(m.ts)} ${m.from}→${m.to}: ${m.text.slice(0, 200)}`);
console.log('== BOARD');
for (const x of board) console.log(`#${x.id} [${x.status}] ${x.owner || '-'}: ${x.title}`);
console.log('== WAYPOINTS');
for (const w of Array.isArray(wps) ? wps : Object.values(wps)) console.log(`${w.name} ${w.x},${w.y},${w.z} (${w.by})`);
for (const name of bots.map((b) => b.name)) {
  const l = await get(`/log/${name}?limit=6`);
  const entries = l.entries || l.log || l;
  console.log(`== LOG ${name}`);
  if (Array.isArray(entries)) for (const e of entries) console.log(`  ${e.kind}: ${String(e.text).replace(/\s+/g, ' ').slice(0, 180)}`);
}
