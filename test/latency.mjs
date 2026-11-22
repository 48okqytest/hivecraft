// Measure agent action durations and how long human messages take to reach each agent.
import { bridgeUrl } from '../bridge/config.js';
const B = bridgeUrl(); // HIVE_URL, else hivecraft.config.json bridge.port
const get = (p) => fetch(B + p).then((r) => r.json());
const msgs = (await get('/messages?limit=400')).messages || [];
const human = msgs.filter((m) => !['Ash', 'Flint', 'Wren', 'system'].includes(m.from));
const since = Date.now() - 90 * 60000;
const t = (ts) => new Date(ts).toTimeString().slice(0, 8);
for (const name of ['Ash', 'Flint', 'Wren']) {
  const l = await get(`/log/${name}?limit=2000`);
  const e = (l.entries || l.log || l).filter((x) => x.ts > since);
  // action durations: tool -> next result/error
  const durs = {}; let open = null;
  for (const x of e) {
    if (x.kind === 'tool') open = x;
    else if ((x.kind === 'result' || x.kind === 'error') && open) {
      const tool = open.text.split(' ')[0];
      (durs[tool] ||= []).push((x.ts - open.ts) / 1000); open = null;
    }
  }
  const all = Object.values(durs).flat().sort((a, b) => a - b);
  const pct = (p) => all[Math.floor(all.length * p)]?.toFixed(1);
  console.log(`\n== ${name}: ${all.length} tool calls, median ${pct(0.5)}s, p90 ${pct(0.9)}s, max ${all.at(-1)?.toFixed(0)}s`);
  const slow = Object.entries(durs).map(([k, v]) => [k, v.length, v.reduce((a, b) => a + b, 0) / v.length, Math.max(...v)]).sort((a, b) => b[2] - a[2]).slice(0, 6);
  for (const [k, n, avg, mx] of slow) console.log(`   ${k.padEnd(16)} x${n}  avg ${avg.toFixed(0)}s  max ${mx.toFixed(0)}s`);
  for (const m of human.filter((m) => m.ts > since)) {
    const words = m.text.slice(0, 25);
    const seen = e.find((x) => x.ts >= m.ts && (x.kind === 'result' || x.kind === 'error') && (x.text.includes(words) || /unread/.test(x.text) && x.ts > m.ts));
    const read = e.find((x) => x.ts >= m.ts && x.kind === 'result' && x.text.includes(words));
    console.log(`   msg ${t(m.ts)} from ${m.from} "${m.text.slice(0, 40)}" -> noticed +${seen ? ((seen.ts - m.ts) / 1000).toFixed(0) + 's' : 'never'}, read +${read ? ((read.ts - m.ts) / 1000).toFixed(0) + 's' : 'never'}`);
  }
}
