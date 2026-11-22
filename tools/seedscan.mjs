// Find a seed whose spawn is in a friendly biome (plains/forest/meadow with animals), using a scratch server.
//   node tools/seedscan.mjs [tries=8]     -> prints the first good seed
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { rcon } from '../bridge/hub/rcon.js';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1')), '..');
const DIR = path.join(ROOT, 'server-seedscan');
const GOOD = ['plains', 'forest', 'birch_forest', 'flower_forest', 'meadow', 'sunflower_plains', 'dark_forest'];
const tries = Number(process.argv[2]) || 8;
fs.mkdirSync(DIR, { recursive: true });
fs.copyFileSync(path.join(ROOT, 'server', 'server.jar'), path.join(DIR, 'server.jar'));
fs.writeFileSync(path.join(DIR, 'eula.txt'), 'eula=true\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

for (let i = 0; i < tries; i++) {
  const seed = String(Math.floor(Math.random() * 2 ** 52) - 2 ** 51);
  fs.rmSync(path.join(DIR, 'world'), { recursive: true, force: true });
  fs.writeFileSync(path.join(DIR, 'server.properties'),
    `server-port=25600\nonline-mode=false\nlevel-seed=${seed}\nenable-rcon=true\nrcon.port=25601\nrcon.password=scan\nview-distance=4\nsimulation-distance=4\n`);
  const p = spawn('java', ['-Xmx2G', '-jar', 'server.jar', 'nogui'], { cwd: DIR, stdio: 'ignore', windowsHide: true });
  const opts = { port: 25601, password: 'scan' };
  let up = false;
  for (let t = 0; t < 90 && !up; t++) { await sleep(1000); try { await rcon('list', opts); up = true; } catch { /* still booting */ } }
  if (!up) { p.kill(); console.log(seed, 'server did not start'); continue; }
  const hits = [];
  for (const b of GOOD) {
    const out = await rcon(`execute positioned over world_surface run execute if biome ~ ~ ~ minecraft:${b}`, opts).catch((e) => e.message);
    if (/passed/i.test(out)) hits.push(b);
  }
  const animals = [];
  for (const m of ['cow', 'sheep', 'pig', 'chicken']) {
    const out = await rcon(`execute if entity @e[type=minecraft:${m},distance=..64]`, opts).catch(() => '');
    const n = Number((out.match(/Count: (\d+)/) || [])[1] || (/passed/i.test(out) ? 1 : 0));
    if (n) animals.push(`${m}:${n}`);
  }
  await rcon('stop', opts).catch(() => {});
  await new Promise((r) => p.once('exit', r));
  console.log(seed, hits.join(',') || 'other', animals.join(' ') || 'no animals');
  if (hits.length && animals.length >= 2) { console.log('GOOD SEED', seed); break; }
}
