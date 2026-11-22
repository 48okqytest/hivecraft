// Drive N bots with heavy actions through the bridge API (no Claude agents) for a fixed time.
//   node tools/load-test.mjs [seconds=75] [names=L1,L2,...]
import { bridgeUrl } from '../bridge/config.js';
const B = bridgeUrl(); // HIVE_URL, else hivecraft.config.json bridge.port
const SECS = Number(process.argv[2]) || 75;
const names = (process.argv[3] || 'Load1,Load2,Load3,Load4,Load5,Load6,Load7').split(',');
const post = (p, b) => fetch(B + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then((r) => r.json());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await Promise.all(names.map((name) => post('/bots', { name })));
await sleep(3000);
const end = Date.now() + SECS * 1000;
const counts = {};
await Promise.all(names.map(async (name, i) => {
  const st = await (await fetch(`${B}/bots/${name}/state`)).json();
  const home = st.pos || { x: 0, z: 0 };
  let k = 0;
  while (Date.now() < end) {
    const left = Math.max(3000, end - Date.now());
    const a = [
      { action: 'goto', args: { x: home.x + Math.round(Math.cos(i + k) * 70), z: home.z + Math.round(Math.sin(i + k) * 70) } },
      { action: 'collect', args: { block: 'log', count: 4 } },
      { action: 'scan', args: { radius: 32 } },
    ][k++ % 3];
    const r = await post(`/bots/${name}/act`, { ...a, timeoutMs: Math.min(left, 60000), interrupt: true });
    counts[name] = (counts[name] || 0) + 1;
    if (!r.ok && /offline|joining/.test(r.error || '')) await sleep(2000);
  }
}));
console.log('actions run:', JSON.stringify(counts));
await Promise.all(names.map((n) => fetch(`${B}/bots/${n}`, { method: 'DELETE' })));
