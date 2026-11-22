import { spawnBot } from '../bridge/engine/index.js';
import { rconConnect } from './engine-rcon.mjs';
const rcon = await rconConnect();
await rcon.cmd('kick EngTest1'); await new Promise(r=>setTimeout(r,800));
await rcon.cmd('tp EngTest1 0 95 0');
const h = await spawnBot({ name: 'EngTest1' });
await rcon.cmd('effect give EngTest1 resistance 1000 4 true');
for (let k=0;k<4;k++) {
  await rcon.cmd('tp EngTest1 0 85 0'); await new Promise(r=>setTimeout(r,4000));
  await rcon.cmd('clear EngTest1'); await new Promise(r=>setTimeout(r,500));
  const t0=Date.now();
  try { console.log(k, (await h.run('collect', { block: 'log', count: 4 })).slice(0,200)); } catch (e) { console.log(k,'ERR', e.message.slice(0,300)); }
  console.log('  ', (Date.now()-t0)/1000, JSON.stringify(h.getState().pos));
}
h.quit(); process.exit(0);
