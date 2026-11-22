// smelt with no furnace within 16 blocks: the bot must craft + place its own furnace instead of walking far.
import { spawnBot } from '../bridge/engine/index.js';
import { rconConnect } from './engine-rcon.mjs';
const rcon = await rconConnect(); const R = (c) => rcon.cmd(c);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const h = await spawnBot({ name: 'EngSmelt' }); await sleep(1500);
await R('forceload add 300 300 330 330'); await R('fill 300 99 300 330 99 330 stone'); await R('fill 300 100 300 330 104 330 air');
await R('tp EngSmelt 315 100 315'); await R('clear EngSmelt');
for (const g of ['cobblestone 10', 'oak_log 2', 'raw_iron 2', 'coal 2']) await R(`give EngSmelt ${g}`);
await R('time set day'); await sleep(1500);
const p0 = h.bot.entity.position.clone(); const t0 = Date.now();
try {
  const r = await h.run('smelt', { item: 'raw_iron', count: 2 }, {});
  const ingots = h.bot.inventory.items().find((i) => i.name === 'iron_ingot')?.count || 0;
  const moved = h.bot.entity.position.distanceTo(p0);
  console.log(`${ingots >= 2 && moved < 10 ? 'PASS' : 'FAIL'}  smelt far from furnaces (${Math.round((Date.now() - t0) / 1000)}s, moved ${moved.toFixed(1)} blocks, ingots ${ingots}) :: ${r}`);
} catch (e) { console.log('FAIL  smelt :: ' + e.message); }
await R('forceload remove 300 300 330 330'); h.quit(); process.exit(0);
