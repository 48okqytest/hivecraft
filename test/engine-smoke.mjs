// Live smoke test for the Hivecraft engine. Needs the MC server on 25590 (RCON 25591).
//   node test/engine-smoke.mjs [onlyStepSubstring]
import { spawnBot, ACTIONS } from '../bridge/engine/index.js';
import { rconConnect } from './engine-rcon.mjs';

const only = process.argv[2];
const rcon = await rconConnect();
const R = (c) => rcon.cmd(c);
const results = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const events1 = [];

async function step(name, fn) {
  if (only && !name.includes(only)) return;
  const t0 = Date.now();
  try {
    const out = await fn();
    const s = typeof out === 'string' ? out : JSON.stringify(out);
    results.push({ name, ok: true });
    console.log(`PASS  ${name} (${Date.now() - t0}ms) :: ${String(s).replace(/\n/g, ' | ').slice(0, 260)}`);
  } catch (e) {
    results.push({ name, ok: false, err: e.message });
    console.log(`FAIL  ${name} (${Date.now() - t0}ms) :: ${e.message.replace(/\n/g, ' | ').slice(0, 400)}`);
  }
}
const assert = (c, m) => { if (!c) throw new Error('assert: ' + m); };

console.log('ACTIONS:', ACTIONS.length);
await R('gamerule doMobSpawning false'); await R('time set day'); await R('gamerule doDaylightCycle false');
await R('kick EngTest1'); await R('kick EngTest2');
// flat test arena high above the jungle (chunks forceloaded)
await R('forceload add 200 200 232 232');
await R('fill 200 90 200 232 98 232 dirt'); await R('fill 200 99 200 232 99 232 grass_block'); await R('fill 200 100 200 232 112 232 air');
const toArena = async () => { await R('tp EngTest1 215 100 215'); await sleep(1500); };
await sleep(800);

const h = await spawnBot({ name: 'EngTest1' });
h.on('event', (e) => { events1.push(e); console.log('   [event]', e.kind, e.text.slice(0, 140)); });
h.on('chat', (c) => console.log('   [chat]', c.username, c.message));
const run = (a, args = {}, opts) => h.run(a, args, opts);
await R('clear EngTest1');
await R('effect give EngTest1 resistance 1000 4 true');
await sleep(500);
const p0 = h.getState().pos;
console.log('spawned at', p0, 'state keys', Object.keys(h.getState()).join(','), 'state bytes', JSON.stringify(h.getState()).length);

await R('tp EngTest1 0 95 0'); await sleep(4000);
await step('state shape', async () => {
  const s = h.getState();
  for (const k of ['name', 'online', 'pos', 'dimension', 'health', 'food', 'time', 'held', 'inventory', 'armor', 'nearbyEntities', 'nearbyBlocks', 'currentAction', 'modes']) assert(k in s, 'missing ' + k);
  return `biome=${s.biome} nearbyBlocks=${Object.keys(s.nearbyBlocks).join(',')} ents=${s.nearbyEntities.length}`;
});
await step('scan', async () => run('scan'));
await step('find_blocks log', async () => run('find_blocks', { block: 'log', count: 3 }));
for (const k of [1, 2]) {
  await step(`collect log x4 near spawn (cut trees) run ${k}`, async () => {
    if (k === 2) { await R('tp EngTest1 0 85 0'); await sleep(4000); }
    const before = h.bot.inventory.items().filter((i) => /_log$/.test(i.name)).reduce((a, i) => a + i.count, 0);
    const t0 = Date.now();
    const r = await run('collect', { block: 'log', count: 4 });
    const dt = Date.now() - t0;
    const n = h.bot.inventory.items().filter((i) => /_log$/.test(i.name)).reduce((a, i) => a + i.count, 0) - before;
    assert(n >= 4, `only ${n} logs; ${r}`);
    assert(/Got [4-9]\/4 [a-z_]+_log/.test(r), 'result must name the real item and gain: ' + r);
    assert(dt < 90000, `took ${dt}ms; ${r}`);
    return r;
  });
}
await toArena();
await step('recipe wooden_pickaxe', async () => run('recipe', { item: 'wooden_pickaxe' }));
await step('craft planks x4', async () => {
  const r = await run('craft', { item: 'planks', count: 4 });
  const n = h.bot.inventory.items().filter((i) => /_planks$/.test(i.name)).reduce((a, i) => a + i.count, 0);
  assert(n >= 4, 'planks ' + n);
  return r;
});
await step('craft crafting_table', async () => {
  const r = await run('craft', { item: 'crafting_table' });
  assert(h.bot.inventory.items().some((i) => i.name === 'crafting_table'), 'no table in inv');
  return r;
});
await step('craft wooden_pickaxe (table placement)', async () => {
  const r = await run('craft', { item: 'wooden_pickaxe' });
  assert(h.bot.inventory.items().some((i) => i.name === 'wooden_pickaxe'), 'no pickaxe');
  return r;
});
await step('craft failure message', async () => {
  try { await run('craft', { item: 'diamond_pickaxe' }); } catch (e) { assert(/missing/i.test(e.message), e.message); return e.message; }
  throw new Error('expected failure');
});
// stone patch next to the bot
await step('collect stone x3', async () => {
  const p = h.getState().pos;
  await R(`fill ${p.x + 3} ${p.y} ${p.z + 3} ${p.x + 5} ${p.y + 1} ${p.z + 5} stone`);
  await sleep(500);
  const r = await run('collect', { block: 'stone', count: 3 });
  assert(h.bot.inventory.items().find((i) => i.name === 'cobblestone')?.count >= 3, 'no cobblestone');
  return r;
});
await step('craft stone_pickaxe', async () => {
  const r = await run('craft', { item: 'stone_pickaxe' });
  assert(h.bot.inventory.items().some((i) => i.name === 'stone_pickaxe'), 'no stone pickaxe');
  return r;
});
await step('collect iron_ore needs tool msg / works', async () => {
  const p = h.getState().pos;
  await R(`setblock ${p.x - 3} ${p.y} ${p.z - 3} iron_ore`);
  await sleep(300);
  const r = await run('collect', { block: 'iron_ore', count: 1 });
  await sleep(500);
  assert(h.bot.inventory.items().some((i) => i.name === 'raw_iron'), 'no raw iron; ' + r + ' inv ' + JSON.stringify(h.getState().inventory));
  return r;
});
await R('give EngTest1 cobblestone 40'); await R('give EngTest1 chest 1'); await R('give EngTest1 torch 4');
await sleep(500);
await step('place + build', async () => {
  const p = h.getState().pos;
  const bx = p.x - 4, bz = p.z + 2, by = p.y;
  const r1 = await run('place', { block: 'cobblestone', x: bx, y: by, z: bz });
  const blocks = [];
  for (let x = 0; x < 3; x++) for (let z = 0; z < 3; z++) for (let y = 0; y < 2; y++) if (x + z + y > 0) blocks.push({ x: bx + x, y: by + y, z: bz + z, block: 'cobblestone' });
  const r2 = await run('build', { blocks });
  const b = h.bot.blockAt({ x: bx + 2, y: by + 1, z: bz + 2, floored() { return this; } });
  return r1 + ' || ' + r2;
});
let chestPos;
await step('chest place + deposit + view + withdraw', async () => {
  const p = h.getState().pos;
  chestPos = { x: p.x + 2, y: p.y, z: p.z - 3 };
  await run('place', { block: 'chest', ...chestPos });
  const d = await run('chest_deposit', { ...chestPos });
  const v = await run('chest_view', chestPos);
  assert(/cobblestone/.test(v), 'chest view: ' + v);
  const w = await run('chest_withdraw', { ...chestPos, items: [{ name: 'cobblestone', count: 10 }] });
  return `${d} || ${v} || ${w}`;
});
await step('give item to second bot', async () => {
  const h2 = await spawnBot({ name: 'EngTest2' });
  globalThis.h2 = h2;
  await R('clear EngTest2');
  const p = h.getState().pos;
  await R('tp EngTest1 216 100 216'); await R('tp EngTest2 210 100 210');
  await sleep(1500);
  const r = await run('give', { player: 'EngTest2', item: 'cobblestone', count: 5 });
  await sleep(2500);
  const got = h2.getState().inventory.find((i) => i.name === 'cobblestone')?.count || 0;
  assert(got >= 5, `EngTest2 got ${got} cobblestone; ${r}; h2 action=${h2.getState().currentAction}`);
  return `${r} -> bot2 has ${got}`;
});
await step('smelt raw_iron (furnace auto-craft)', async () => {
  await R('give EngTest1 coal 2'); await R('give EngTest1 raw_iron 2'); await R('give EngTest1 cobblestone 10'); await R('tp EngTest1 216 100 216');
  await sleep(400);
  const r = await run('smelt', { item: 'raw_iron', count: 2 });
  assert(h.bot.inventory.items().find((i) => i.name === 'iron_ingot')?.count >= 2, 'no ingots; ' + r);
  return r;
});
await step('attack zombie', async () => {
  await run('set_mode', { mode: 'self_defense', on: false });
  await R('time set midnight');
  await R('give EngTest1 iron_sword 1'); await R('give EngTest1 iron_helmet 1');
  await sleep(300);
  await run('equip', { item: 'iron_helmet' });
  const p = h.getState().pos;
  await R(`summon zombie ${p.x + 5} ${p.y} ${p.z + 5} {PersistenceRequired:1b}`);
  await sleep(800);
  let r;
  try { r = await run('attack', { target: 'zombie', count: 1 }); } finally { await run('set_mode', { mode: 'self_defense', on: true }); }
  assert(/Killed 1\/1/.test(r), r);
  await R('time set day');
  return r;
});
await step('self_defense auto (idle)', async () => {
  await R('time set midnight');
  await R('tp EngTest1 216 100 216'); await sleep(800);
  const p = h.getState().pos;
  await R(`summon skeleton ${p.x + 4} ${p.y} ${p.z + 4} {PersistenceRequired:1b,ArmorItems:[{},{},{},{id:"minecraft:iron_helmet",count:1}]}`);
  await R(`summon zombie ${p.x - 4} ${p.y} ${p.z - 4} {PersistenceRequired:1b}`);
  for (let i = 0; i < 30 && h.getState().nearbyEntities.some((e) => e.type === 'hostile'); i++) await sleep(1000);
  const s = h.getState();
  const hostile = s.nearbyEntities.filter((e) => e.type === 'hostile');
  await R('kill @e[type=zombie]'); await R('kill @e[type=skeleton]'); await R('time set day');
  assert(s.health > 5, 'health ' + s.health);
  assert(hostile.length === 0, 'hostiles still alive: ' + JSON.stringify(hostile) + ' me=' + JSON.stringify(s.pos));
  return `hostiles left=${hostile.length}, health=${s.health}`;
});
await step('abort goto', async () => {
  await run('set_mode', { mode: 'pickup_items', on: false });
  const p = h.getState().pos;
  const t0 = Date.now();
  const ac = new AbortController();
  const pr = run('goto', { x: p.x + 300, z: p.z + 300 }, { signal: ac.signal });
  setTimeout(() => ac.abort(), 2000);
  let err = null;
  try { await pr; } catch (e) { err = e; }
  const dt = Date.now() - t0;
  assert(err && /Stopped/.test(err.message), 'err=' + err?.message);
  assert(dt < 6000, 'took ' + dt);
  await sleep(1000); const a = h.bot.entity.position.clone(); await sleep(1200); const b = h.bot.entity.position;
  await run('set_mode', { mode: 'pickup_items', on: true });
  assert(Math.hypot(a.x - b.x, a.z - b.z) < 0.8, 'still moving ' + a.distanceTo(b));
  return `aborted after ${dt}ms`;
});
await step('stop() via action', async () => {
  const p = h.getState().pos;
  const pr = run('goto', { x: p.x - 200, z: p.z }).catch((e) => e.message);
  await sleep(1500);
  const s = await run('stop');
  const r = await pr;
  assert(/Stopped/.test(String(r)), String(r));
  return s + ' / ' + r;
});
await step('goto_player + follow', async () => {
  await R('tp EngTest1 216 100 216'); await R('tp EngTest2 224 100 224'); await sleep(2000);
  const h2 = globalThis.h2;
  const p2 = h2.getState().pos;
  const r = await run('goto_player', { player: 'EngTest2', range: 3 });
  const f = await run('follow', { player: 'EngTest2', distance: 3 });
  assert(h.getState().currentAction === 'follow', 'currentAction=' + h.getState().currentAction);
  await run('stop');
  return r + ' || ' + f;
});
await step('run_code', async () => run('run_code', { code: 'log(bot.username, bot.entity.position.floored()); return bot.inventory.items().length;' }));
await step('run_code abort/timeout', async () => {
  const t0 = Date.now();
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 1000);
  try { await run('run_code', { code: 'await sleep(30000)' }, { signal: ac.signal }); } catch (e) { assert(Date.now() - t0 < 4000, 'slow'); return e.message; }
  throw new Error('no throw');
});
await step('set_mode + eat', async () => {
  const m = await run('set_mode', { mode: 'pickup_items', on: false });
  await run('set_mode', { mode: 'pickup_items', on: true });
  await R('give EngTest1 cooked_beef 3'); await R('effect give EngTest1 hunger 6 30 true');
  await sleep(5000);
  const f = h.bot.food;
  let r; try { r = await run('eat'); } catch (e) { r = 'eat err: ' + e.message; }
  return `${m} | food was ${f} | ${r}`;
});
await step('craft planks variant matching logs', async () => {
  await R('clear EngTest1'); await R('give EngTest1 jungle_log 30'); await sleep(600);
  const out = [];
  out.push(await run('craft', { item: 'oak_planks', count: 16 }));
  assert(h.bot.inventory.count(h.bot.registry.itemsByName.jungle_planks.id) >= 4, 'no jungle_planks: ' + out[0]);
  out.push(await run('craft', { item: 'planks', count: 4 }));
  out.push(await run('craft', { item: 'stick', count: 4 }));
  assert(h.bot.inventory.items().some((i) => i.name === 'stick'), 'no sticks');
  out.push(await run('craft', { item: 'wooden_axe' }));
  assert(h.bot.inventory.items().some((i) => i.name === 'wooden_axe'), 'no wooden_axe');
  return out.join(' || ');
});
await step('death + respawn event', async () => {
  const n0 = events1.length;
  await R('effect clear EngTest1');
  await R('kill EngTest1');
  await sleep(5000);
  const kinds = events1.slice(n0).map((e) => e.kind);
  assert(kinds.includes('death') && kinds.includes('respawn'), 'events: ' + kinds.join(','));
  assert(h.getState().health > 0 && !h.dead, 'not alive');
  const r = await run('scan');
  return kinds.join(',');
});
await step('invalid args message', async () => {
  try { await run('collect', { block: 'iron_oar' }); } catch (e) { return e.message; }
  throw new Error('no throw');
});

const failed = results.filter((r) => !r.ok);
console.log(`\n=== ${results.length - failed.length}/${results.length} passed ===`);
for (const f of failed) console.log('  FAILED:', f.name, '-', f.err.slice(0, 200));
try { globalThis.h2?.quit(); h.quit(); rcon.close(); } catch { /* */ }
setTimeout(() => process.exit(failed.length ? 1 : 0), 500);
