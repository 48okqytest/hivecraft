// Fill a running (mock-engine) bridge with demo data for dashboard screenshots:  HIVE_PORT=47962 node test/hub-seed.mjs
import './neutral-player.mjs'; // neutral human player (Robin / robin_mc), set before the bridge reads config
const B = `http://127.0.0.1:${process.env.HIVE_PORT || 47960}`;
const post = (p, b) => fetch(B + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then((r) => r.json());

for (const [n, role] of [['Ash', 'Lead'], ['Birch', 'Miner'], ['Cedar', 'Builder'], ['Dune', 'Gatherer']]) await post('/bots', { name: n, role });
await post('/goal', { text: 'Build a base near spawn, get a full set of iron gear, then find diamonds.', by: 'Robin' });
const path = async (n, pts) => { for (const [x, z] of pts) await post(`/bots/${n}/act`, { action: 'goto', args: { x, y: 64, z, ms: 80 } }); };
await Promise.all([
  path('Ash', [[0, 0], [8, 3], [14, 9], [20, 12], [26, 20]]),
  path('Birch', [[-5, 5], [-12, 14], [-20, 22], [-34, 30], [-41, 38]]),
  path('Cedar', [[3, -4], [6, -10], [12, -14], [18, -20]]),
  path('Dune', [[-8, -6], [-14, -3], [-22, -9]]),
]);
for (const [n, block, count] of [['Ash', 'oak_log', 14], ['Ash', 'cobblestone', 32], ['Ash', 'apple', 3], ['Birch', 'iron_ore', 9], ['Birch', 'coal', 17], ['Cedar', 'oak_planks', 40]]) {
  await post(`/bots/${n}/act`, { action: 'collect', args: { block, count } });
}
await post('/waypoints', { by: 'Ash', name: 'base', x: 14, y: 64, z: 9, note: 'main chest + crafting table' });
await post('/waypoints', { by: 'Birch', name: 'iron-vein', x: -41, y: 14, z: 38, note: 'y=14, lots of iron' });
await post('/waypoints', { by: 'Dune', name: 'farm', x: -22, y: 64, z: -9 });
await post('/notes', { by: 'Birch', key: 'iron', text: 'Iron vein at -41 14 38, about 20 ore visible. Lava pool 6 blocks east, careful.' });
await post('/notes', { by: 'Ash', key: 'rules', text: 'All shared items go in the base chest. Save memory before long tasks.' });
const t1 = await post('/board', { by: 'Ash', title: 'Gather 40 oak logs', detail: 'for planks, tools and the first house', priority: 'high' });
const t2 = await post('/board', { by: 'Ash', title: 'Mine 24 iron ore', detail: 'iron-vein waypoint. Bring torches.', priority: 'high' });
const t3 = await post('/board', { by: 'Ash', title: 'Build 7x7 starter house at base', priority: 'normal' });
const t4 = await post('/board', { by: 'Ash', title: 'Set up wheat farm', priority: 'low' });
const t5 = await post('/board', { by: 'Ash', title: 'Craft stone tools for everyone', priority: 'normal' });
await post('/board', { by: 'Ash', title: 'Find a village for trading', priority: 'low' });
await post(`/board/${t1.id}/claim`, { by: 'Ash' });
await post(`/board/${t2.id}/claim`, { by: 'Birch' });
await post(`/board/${t2.id}`, { by: 'Birch', note: '9/24 so far' });
await post(`/board/${t3.id}/claim`, { by: 'Cedar' });
await post(`/board/${t4.id}`, { by: 'Dune', status: 'blocked', note: 'need seeds, none seen yet' });
await post(`/board/${t5.id}`, { by: 'Ash', status: 'done', note: 'done, all have stone pickaxes' });
const say = (from, to, text) => post('/msg', { from, to, text });
await say('Ash', 'all', 'Plan is on the board. Claim a task before you start. Base is at 14 64 9.');
await say('Birch', 'all', 'Heading to the iron vein at -41 14 38. Will drop ore in the base chest.');
await say('Cedar', 'Ash', 'Need 40 planks for the house, I have 40 now. Starting walls.');
await say('Robin', 'all', 'Nice, keep going. Dune, any seeds yet?');
await say('Dune', 'Robin', 'No seeds yet, checking the grass near the farm waypoint.');
await say('Robin', 'Dune', 'ok, try breaking tall grass');
const L = (n, kind, text) => post(`/log/${n}`, { kind, text });
await L('Ash', 'system', 'Session started (claude-sonnet-5-5)');
await L('Ash', 'thought', 'I need logs first: wooden tools unlock everything else. Oak trees are close to the base.');
await L('Ash', 'tool', 'collect {"block":"oak_log","count":14}');
await L('Ash', 'result', 'Collected 14 oak_log (inventory now 14).');
await L('Ash', 'tool', 'check_messages {}');
await L('Ash', 'result', 'Birch: Heading to the iron vein at -41 14 38.');
await L('Ash', 'thought', 'Birch is on iron. I should finish logs, then craft a furnace and smelt once ore arrives.');
await L('Ash', 'error', 'craft failed: missing 3 cobblestone for furnace (have 0)');
await L('Birch', 'thought', 'Iron vein is a long walk. I will pathfind there and mine downward carefully because of the lava.');
await L('Cedar', 'thought', 'Walls first, then the roof, then a door and torches inside.');
await L('Dune', 'thought', 'No seeds yet. Breaking grass is the fastest route.');
// leave two bots mid-action so the cards show activity
post('/bots/Birch/act', { action: 'wait', args: { seconds: 600 }, timeoutMs: 600000 }).catch(() => {});
post('/bots/Cedar/act', { action: 'wait', args: { seconds: 600 }, timeoutMs: 600000 }).catch(() => {});
await new Promise((r) => setTimeout(r, 500));
console.log('seeded');
process.exit(0);
