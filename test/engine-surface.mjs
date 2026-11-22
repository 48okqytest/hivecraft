// Live test for the `surface` action: bury a test bot ~30 blocks underground and let it climb out.
//   node test/engine-surface.mjs     (needs the MC server on 25590 + RCON)
import { spawnBot } from '../bridge/engine/index.js';
import { rconConnect } from './engine-rcon.mjs';

const rcon = await rconConnect();
const R = (c) => rcon.cmd(c);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const h = await spawnBot({ name: 'EngSurf' });
await sleep(1500);
// a spot away from the agents' base, inside solid stone ~30 below the surface
const X = -120, Z = 140;
await R(`forceload add ${X - 16} ${Z - 16} ${X + 16} ${Z + 16}`);
await R(`tp EngSurf ${X} 120 ${Z}`); await sleep(2500);
const top = await R(`execute positioned ${X} 0 ${Z} run execute positioned over world_surface run tp EngSurf ~ ~ ~`); await sleep(1500);
const surfaceY = Math.floor(h.bot.entity.position.y);
const startY = surfaceY - 30;
await R(`fill ${X - 1} ${startY - 1} ${Z - 1} ${X + 1} ${startY + 1} ${Z + 1} stone`);
await R(`fill ${X} ${startY} ${Z} ${X} ${startY + 1} ${Z} air`);
await R(`tp EngSurf ${X} ${startY} ${Z}`);
await R('clear EngSurf'); await R('give EngSurf iron_pickaxe 1'); await R('give EngSurf cobblestone 64');
await sleep(2000);
console.log('surface y', surfaceY, 'start y', Math.floor(h.bot.entity.position.y));
const t0 = Date.now();
let ok = false, res;
try {
  res = await h.run('surface', {}, {});
  const endY = Math.floor(h.bot.entity.position.y);
  ok = endY >= surfaceY - 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  surface (${Math.round((Date.now() - t0) / 1000)}s) :: ${res}`);
} catch (e) {
  console.log(`FAIL  surface :: ${e.message}`);
}
await R(`forceload remove ${X - 16} ${Z - 16} ${X + 16} ${Z + 16}`);
h.quit(); rcon.close?.();
process.exit(ok ? 0 : 1);
