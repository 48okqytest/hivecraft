// Live robustness scenarios (needs the MC server on 25590 + RCON 25591). Builds small test arenas far from spawn (x -500..-560).
//   node test/robust-check.mjs [onlyStepSubstring]
// Refuses to run when a non-test player is online (the human may be playing).
import { spawnBot, ACTIONS } from '../bridge/engine/index.js';
import { rconConnect } from './engine-rcon.mjs';

const only = process.argv[2];
const rcon = await rconConnect();
const R = (c) => rcon.cmd(c);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const BOT = 'RobCheck';

const list = await R('list');
// teammates' scripted test bots (BpTest, RobProbe, ...) are fine; any other name may be the human or a crew agent
const online = (list.split(':')[1] || '').split(',').map((s) => s.trim()).filter(Boolean).filter((n) => n !== BOT && !/test|probe|check|view/i.test(n));
if (online.length) { console.log(`ABORT: players online (${online.join(', ')}); not running live scenarios.`); process.exit(3); }

async function step(name, fn) {
  if (only && !name.includes(only)) return;
  const t0 = Date.now();
  try {
    const out = await fn();
    results.push({ name, ok: true });
    console.log(`PASS  ${name} (${((Date.now() - t0) / 1000).toFixed(1)}s) :: ${String(out).replace(/\n/g, ' | ').slice(0, 700)}`);
  } catch (e) {
    results.push({ name, ok: false, err: e.message });
    console.log(`FAIL  ${name} (${((Date.now() - t0) / 1000).toFixed(1)}s) :: ${String(e.message).replace(/\n/g, ' | ').slice(0, 700)}`);
  }
}
const assert = (c, m) => { if (!c) throw new Error('assert: ' + m); };

const names = ACTIONS.map((a) => a.name);
for (const n of ['escape', 'hunt', 'look_around', 'nearest', 'inventory', 'blocks_at', 'use_block', 'use_item', 'craft_plan']) assert(names.includes(n), `action ${n} registered`);
console.log(`ACTIONS (${names.length}): ${names.join(', ')}`);

await R('gamerule doMobSpawning false'); await R('gamerule doDaylightCycle false'); await R('time set day'); await R('weather clear');
await R('forceload add -570 -570 -480 -480');
await R(`kick ${BOT}`); await sleep(500);
const h = await spawnBot({ name: BOT });
h.on('event', (e) => { if (!/item_picked_up/.test(e.kind)) console.log('   [event]', e.kind, String(e.text).slice(0, 120)); });
const run = (a, args = {}) => h.run(a, args);
const pos = () => h.bot.entity.position;
const tp = async (x, y, z) => { await R(`tp ${BOT} ${x} ${y} ${z}`); await sleep(1800); };
await R(`effect give ${BOT} resistance 3000 4 true`); await R(`effect give ${BOT} saturation 3000 1 true`);
const clear = async () => { await R(`clear ${BOT}`); await sleep(400); };
const give = async (item, n = 1) => { await R(`give ${BOT} ${item} ${n}`); await sleep(250); };

// --- arena: stone slab -570..-480 at y 99 (air above) ---
async function arena(x1, z1, x2, z2, floor = 'stone', top = 'grass_block') {
  await R(`fill ${x1} 90 ${z1} ${x2} 98 ${z2} ${floor}`); await R(`fill ${x1} 99 ${z1} ${x2} 99 ${z2} ${top}`); await R(`fill ${x1} 100 ${z1} ${x2} 110 ${z2} air`);
}

// 1. pit in STONE, no pickaxe, no blocks: hand-dig staircase out (slow but must work)
await step('escape: 3-deep stone pit, no pickaxe, no blocks', async () => {
  await arena(-510, -510, -490, -490, 'stone', 'stone');
  await R('fill -500 97 -500 -500 99 -500 air'); // 1x1 shaft, bot stands on y 96 -> head 98, top 99
  await clear(); await tp(-500, 97, -500);
  const r = await run('escape');
  const y = Math.floor(pos().y);
  assert(y >= 100, `ended at y ${y}: ${r}`);
  return `${r}`;
});

// 2. pit in stone with dirt blocks to pillar
await step('escape: 6-deep stone pit, pillar with dirt', async () => {
  await arena(-510, -510, -490, -490, 'stone', 'stone');
  await R('fill -500 94 -500 -500 99 -500 air');
  await clear(); await give('dirt', 16); await tp(-500, 94, -500);
  const r = await run('escape');
  assert(Math.floor(pos().y) >= 100, r);
  return r;
});

// 3. sealed underground room (roof of dirt): walk out impossible, dig roof by hand + pillar
await step('escape: sealed room under dirt roof, no pickaxe, has cobblestone', async () => {
  await R('fill -530 88 -530 -520 99 -520 stone'); await R('fill -527 92 -527 -523 94 -523 air'); await R('fill -527 95 -527 -523 99 -523 dirt'); await R('fill -530 100 -530 -520 106 -520 air');
  await clear(); await give('cobblestone', 12); await tp(-525, 92, -525);
  const before = await run('look_around');
  assert(/TRAPPED|Small space|Underground/.test(before), 'look_around should report trapped: ' + before);
  const r = await run('escape');
  assert(Math.floor(pos().y) >= 100, r);
  return `look_around said: ${before.split('\n').find((l) => /TRAPPED|Small|Underground/.test(l))} || escape: ${r}`;
});

// 4. water hole
await step('escape: in a 4-deep water hole', async () => {
  await arena(-510, -510, -490, -490, 'stone', 'stone');
  await R('fill -501 96 -501 -499 99 -499 water');
  await clear(); await tp(-500, 96, -500);
  const r = await run('escape');
  assert(pos().y >= 99.5 && !h.bot.entity.isInWater, `y ${pos().y} water=${h.bot.entity.isInWater} ${r}`);
  return r;
});

// 5. goto into a sealed box: must explain why
await step('goto: unreachable target gives a WHY', async () => {
  await arena(-510, -510, -490, -490, 'stone', 'grass_block');
  await R('fill -496 100 -496 -492 104 -492 obsidian'); await R('fill -495 101 -495 -493 103 -493 air');
  await clear(); await tp(-505, 100, -505);
  await sleep(600);
  let r;
  try { r = await run('goto', { x: -494, y: 101, z: -494, range: 0 }); } catch (e) { assert(/Why:|Try:/.test(e.message), e.message); return e.message; }
  throw new Error(`goto into a sealed obsidian box should fail; got: ${r}; block there: ${h.bot.blockAt(h.bot.entity.position.floored().offset(0, 1, 0))?.name}`);
});

// 6. hunting
await step('hunt: 2 pigs on open grass, no weapon', async () => {
  await arena(-560, -560, -520, -520, 'dirt', 'grass_block');
  await R('kill @e[type=!player,x=-540,y=100,z=-540,distance=..60]');
  await R('fill -560 100 -560 -520 100 -560 oak_fence'); await R('fill -560 100 -520 -520 100 -520 oak_fence'); await R('fill -560 100 -560 -560 100 -520 oak_fence'); await R('fill -520 100 -560 -520 100 -520 oak_fence'); // a pasture fence
  await clear(); await tp(-540, 100, -540);
  await R('summon pig -530 100 -530'); await R('summon pig -548 100 -534'); await sleep(1000);
  const r = await run('hunt', { target: 'pig', count: 2 });
  assert(/Killed 2\/2/.test(r), r);
  const pork = h.bot.inventory.items().filter((i) => i.name === 'porkchop').reduce((a, i) => a + i.count, 0);
  assert(pork >= 1, 'picked up porkchop: ' + r);
  return r;
});
await step('attack: sheep uses the hunt engine (with sword)', async () => {
  await R('kill @e[type=!player,x=-540,y=100,z=-540,distance=..60]');
  await clear(); await give('stone_sword'); await tp(-540, 100, -540);
  await R('summon sheep -526 100 -548'); await sleep(800);
  const r = await run('attack', { target: 'sheep' });
  assert(/Killed 1\/1/.test(r), r);
  return r;
});
await step('hunt: none around -> helpful error', async () => {
  await R('kill @e[type=!player,x=-540,y=100,z=-540,distance=..80]');
  try { await run('hunt', { target: 'cow' }); } catch (e) { assert(/No cow/.test(e.message), e.message); return e.message; }
  throw new Error('expected failure');
});

// 7. crafting
await step('craft: missing ingredients -> exact list + sources', async () => {
  await clear(); await give('oak_log', 1);
  try { await run('craft', { item: 'stone_pickaxe' }); } catch (e) { assert(/missing/.test(e.message) && /cobblestone/.test(e.message), e.message); return e.message; }
  throw new Error('expected failure');
});
await step('craft_plan: iron_pickaxe from 1 log', async () => {
  const r = await run('craft_plan', { item: 'iron_pickaxe' });
  assert(/MISSING/.test(r) && /iron_ingot/.test(r) && /smelt raw_iron/.test(r), r);
  return r;
});
await step('craft_plan: ready case', async () => {
  await clear(); await give('oak_log', 3);
  const r = await run('craft_plan', { item: 'wooden_pickaxe' });
  assert(/READY/.test(r), r);
  return r;
});
await step('craft: full inventory -> clear error, nothing lost', async () => {
  await clear();
  const junk = ['dirt', 'cobblestone', 'andesite', 'diorite', 'granite', 'gravel', 'sand', 'oak_sapling', 'bone', 'string', 'feather', 'flint', 'clay_ball', 'moss_block', 'tuff', 'calcite', 'dripstone_block', 'pointed_dripstone', 'glass', 'stone', 'deepslate', 'cobbled_deepslate', 'sandstone', 'red_sand', 'snowball', 'egg', 'wheat_seeds', 'beetroot_seeds', 'pumpkin_seeds', 'melon_seeds', 'rotten_flesh', 'spider_eye', 'gunpowder', 'arrow', 'bowl'];
  for (const j of junk) await R(`give ${BOT} ${j} 1`);
  await give('dark_oak_log', 8); await sleep(800);
  try { await run('craft', { item: 'dark_oak_planks', count: 4 }); } catch (e) {
    const logs = h.bot.inventory.items().filter((i) => i.name === 'dark_oak_log').reduce((a, i) => a + i.count, 0);
    assert(/FULL/.test(e.message) && logs === 8, `logs ${logs}: ${e.message}`);
    return e.message;
  }
  throw new Error('expected an inventory-full error');
});
await step('craft: planks/sticks/table chain (was "server did not deliver")', async () => {
  await clear(); await give('dark_oak_log', 4);
  const r = await run('craft', { item: 'wooden_pickaxe' });
  assert(/Crafted 1 wooden_pickaxe/.test(r), r);
  return r;
});

// 8. placement
await step('place: bed on flat floor (valid facing)', async () => {
  await arena(-510, -510, -490, -490, 'stone', 'grass_block');
  await clear(); await give('white_bed'); await tp(-500, 100, -505);
  const r = await run('place', { block: 'white_bed', x: -500, y: 100, z: -500 });
  await sleep(700);
  const b = h.bot.blockAt(h.bot.entity.position.floored().offset(0, 0, 0));
  const beds = h.bot.findBlocks({ matching: (bb) => bb.name === 'white_bed', maxDistance: 10, count: 4 });
  assert(beds.length === 2, `bed blocks ${beds.length}: ${r}`);
  return r + (b ? '' : '');
});
await step('place: bed against a wall picks another facing', async () => {
  await R('fill -496 100 -510 -496 102 -490 stone'); // wall at x -496
  await clear(); await give('red_bed'); await tp(-500, 100, -496);
  const r = await run('place', { block: 'red_bed', x: -497, y: 100, z: -496 });
  await sleep(700);
  const beds = h.bot.findBlocks({ matching: (bb) => bb.name === 'red_bed', maxDistance: 10, count: 4 });
  assert(beds.length === 2, `bed blocks ${beds.length}: ${r}`);
  return r;
});
await step('place: wheat_seeds on grass with a hoe (tills, plants)', async () => {
  await clear(); await give('wheat_seeds', 4); await give('wooden_hoe'); await tp(-505, 100, -505);
  await R('setblock -503 99 -508 water');
  const r = await run('place', { block: 'wheat_seeds', x: -504, y: 99, z: -508 });
  const b = h.bot.blockAt(new (await import('vec3')).Vec3(-504, 100, -508));
  assert(b?.name === 'wheat', `block is ${b?.name}: ${r}`);
  return r;
});
await step('place: seeds without hoe -> explains farmland', async () => {
  await clear(); await give('wheat_seeds', 2);
  try { await run('place', { block: 'wheat_seeds', x: -506, y: 100, z: -508 }); } catch (e) { assert(/farmland/.test(e.message), e.message); return e.message; }
  throw new Error('expected failure');
});
await step('place: sapling given the grass block coords -> on top', async () => {
  await clear(); await give('oak_sapling'); await tp(-505, 100, -500);
  const r = await run('place', { block: 'oak_sapling', x: -507, y: 99, z: -500 });
  const b = h.bot.blockAt(new (await import('vec3')).Vec3(-507, 100, -500));
  assert(b?.name === 'oak_sapling', `${b?.name}: ${r}`);
  return r;
});
await step('place: torch on a wall (wall_torch counts as success)', async () => {
  await clear(); await give('torch', 2); await tp(-498, 100, -500);
  const r = await run('place', { block: 'torch', x: -497, y: 101, z: -500 });
  assert(/Placed torch/.test(r), r);
  return r;
});

// 9. perception
await step('perception: look_around / nearest / inventory / blocks_at', async () => {
  await clear(); await give('stone_pickaxe'); await give('bread', 5); await tp(-505, 100, -505);
  await R('setblock -503 100 -503 chest'); await sleep(700);
  const la = await run('look_around');
  assert(/north:/.test(la) && /Above:/.test(la), la);
  const nn = await run('nearest', { what: 'chest' });
  assert(/chest at -503,100,-503/.test(nn), nn);
  const inv = await run('inventory');
  assert(/stone_pickaxe x1 \[/.test(inv) && /bread x5/.test(inv), inv);
  const ba = await run('blocks_at', { x: -503, y: 100, z: -503 });
  assert(/chest/.test(ba), ba);
  const box = await run('blocks_at', { x: -506, y: 99, z: -506, x2: -503, y2: 100, z2: -503 });
  assert(/Box/.test(box), box);
  return `${la.split('\n').slice(0, 3).join(' / ')} || ${nn} || ${inv.split('\n')[2]} || ${ba}`;
});
await step('use_block: open a door', async () => {
  await R('setblock -500 100 -502 oak_door[half=lower,open=false]'); await R('setblock -500 101 -502 oak_door[half=upper,open=false]'); await sleep(700);
  const r = await run('use_block', { x: -500, y: 100, z: -502 });
  assert(/open=true/.test(r), r);
  return r;
});

// 10. smelt with a teammate's item stuck in the input slot (was "destination full")
await step('smelt: furnace input holds another item', async () => {
  await clear(); await give('raw_iron', 2); await give('coal', 2); await tp(-505, 100, -505);
  console.log('   setblock furnace:', await R('setblock -506 100 -506 furnace{Items:[{Slot:0b,id:"minecraft:sand",count:5}]}')); await sleep(700);
  const r = await run('smelt', { item: 'raw_iron', count: 2 });
  assert(/Smelted 2\/2/.test(r) && /sand/.test(r), r);
  return r;
});

// 11. eat odd food
await step('eat: only rotten_flesh in inventory', async () => {
  await clear(); await give('rotten_flesh', 2); await R(`effect clear ${BOT} saturation`); await R(`effect give ${BOT} hunger 6 120 true`); await sleep(6500);
  const f0 = h.bot.food;
  const r = await run('eat');
  assert(h.bot.food > f0 || /Ate/.test(r), `food ${f0} -> ${h.bot.food}: ${r}`);
  await R(`effect give ${BOT} saturation 3000 1 true`);
  return `food ${f0} -> ${h.bot.food}: ${r}`;
});

// 12. long goto: 220 blocks over real terrain must not time out (arrive or report progress)
await step('goto: 220 blocks far (hops)', async () => {
  await clear(); await give('dirt', 32); await tp(-500, 100, -500);
  const t0 = Date.now();
  const r = await run('goto', { x: -500, z: -720 });
  assert(/Arrived|Still travelling/.test(r), r);
  return `${Math.round((Date.now() - t0) / 1000)}s: ${r}`;
});

console.log(`\n${results.filter((r) => r.ok).length}/${results.length} passed`);
for (const r of results.filter((x) => !x.ok)) console.log(`  FAILED: ${r.name}: ${String(r.err).slice(0, 200)}`);
try { await R('forceload remove -570 -570 -480 -480'); } catch { /* */ }
h.quit(); rcon.close();
setTimeout(() => process.exit(results.every((r) => r.ok) ? 0 : 1), 500);
