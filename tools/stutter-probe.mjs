// Read-only stutter probe for a running Hivecraft bridge (changes nothing).
//   node tools/stutter-probe.mjs [seconds=90]
import { bridgeUrl } from '../bridge/config.js';
const B = bridgeUrl(); // HIVE_URL, else hivecraft.config.json bridge.port
const SECS = Number(process.argv[2]) || 90;
const end = Date.now() + SECS * 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const lat = [];
const samples = {}; // name -> [{t,x,z,act}]
async function pingLoop() {
  while (Date.now() < end) {
    const t0 = performance.now();
    try { await fetch(B + '/health'); } catch { /* ignore */ }
    lat.push(performance.now() - t0);
    await sleep(25);
  }
}
async function posLoop() {
  while (Date.now() < end) {
    const t = Date.now();
    try {
      for (const b of await (await fetch(B + '/bots')).json()) {
        if (!b.pos) continue;
        (samples[b.name] ||= []).push({ t, x: b.pos.x, z: b.pos.z, act: b.currentAction });
      }
    } catch { /* ignore */ }
    await sleep(100);
  }
}
const since = Date.now();
await Promise.all([pingLoop(), posLoop()]);
lat.sort((a, b) => a - b);
const q = (p) => lat[Math.floor(lat.length * p)].toFixed(0);
const stalls = lat.filter((x) => x > 100).length, big = lat.filter((x) => x > 250).length;
console.log(`BRIDGE EVENT LOOP (${lat.length} pings over ${SECS}s): median ${q(0.5)}ms, p95 ${q(0.95)}ms, p99 ${q(0.99)}ms, max ${lat.at(-1).toFixed(0)}ms`);
console.log(`  pings delayed >100ms (bots miss 2+ physics ticks): ${stalls} (${(100 * stalls / lat.length).toFixed(1)}%), >250ms (visible freeze): ${big}`);
console.log('MOVEMENT while walking (goto/collect/follow): freezes = position unchanged >=0.5s then jumps >=2 blocks');
for (const [n, s] of Object.entries(samples)) {
  let freezes = 0, moving = 0;
  for (let i = 1; i < s.length; i++) {
    if (!/goto|collect|follow/.test(s[i].act || '')) continue;
    moving++;
    let j = i; while (j < s.length && s[j].x === s[i - 1].x && s[j].z === s[i - 1].z) j++;
    if (j < s.length && s[j].t - s[i - 1].t >= 500 && Math.hypot(s[j].x - s[i - 1].x, s[j].z - s[i - 1].z) >= 2) { freezes++; i = j; }
  }
  console.log(`  ${n.padEnd(6)} ${moving} walking samples, freeze-then-jump events: ${freezes}`);
}
// think gaps: action result -> next action call, from the bridge log (last 10 min)
console.log('THINK GAPS (bot idle between one action finishing and the next starting), last 10 min:');
for (const n of Object.keys(samples)) {
  const l = await (await fetch(`${B}/log/${n}?limit=600`)).json();
  const e = (l.entries || l.log || l).filter((x) => x.ts > since - 600000);
  const gaps = [];
  for (let i = 0; i < e.length; i++) {
    if (e[i].kind !== 'result' && e[i].kind !== 'error') continue;
    const nx = e.slice(i + 1).find((x) => x.kind === 'tool');
    if (nx && !/check_messages|status|board|notes|waypoints|team_status|goal|memory/.test(nx.text)) gaps.push((nx.ts - e[i].ts) / 1000);
  }
  gaps.sort((a, b) => a - b);
  if (gaps.length) console.log(`  ${n.padEnd(6)} ${gaps.length} gaps, median ${gaps[Math.floor(gaps.length / 2)].toFixed(1)}s, p90 ${gaps[Math.floor(gaps.length * 0.9)].toFixed(1)}s`);
}
