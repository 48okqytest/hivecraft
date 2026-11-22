// Earnings test, fully offline (no Minecraft, no RCON, no bots): node test/earnings-test.mjs
//  1. Earnings unit tests (bounties, server jobs, mob bounties, milestones, daily wage) against a FAKE RCON that
//     simulates inventories, online players, scoreboards (objectives add / players list / get), time query, dimensions
//  2. the hub on a spare port (mock engine): /econ/jobs|bounty|earnings, POST /board reward, ws 'earn', terminal
//     commands, the bot MCP tools; and the economy OFF (nothing runs, nothing shows)
import { assertNoLiveConnects } from './neutral-player.mjs'; // neutral player Robin/robin_mc + live ports blocked
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
process.env.HIVE_EARNINGS_POLL = '0'; // tests never poll a live Minecraft server (earnings scoreboards/time)

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CATALOG = path.join(ROOT, 'data', 'econ-catalog.json');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-earn-test-'));
const { Economy } = await import('../bridge/hub/economy.js');
const { Earnings, parseTime, parseScoreList, parseScoreGet, parseDimension, objName, earnSettings } = await import('../bridge/hub/earnings.js');
const { Store } = await import('../bridge/hub/store.js');

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); pass++; console.log('  ok  ', name); }
  catch (e) { fail++; console.log('  FAIL', name, '\n      ', e?.stack?.split('\n').slice(0, 5).join('\n       ') || e); process.exitCode = 1; }
}
async function rejects(p, status, re) {
  let e = null;
  try { await p; } catch (x) { e = x; }
  assert.ok(e, `expected an error matching ${re}`);
  if (status) assert.equal(e.status, status, `status ${e.status} (${e.message})`);
  if (re) assert.match(e.message, re);
  return e;
}

// ------------------------------------------------------------------------------------------ fake Minecraft
class FakeMC {
  constructor() {
    this.inv = new Map();
    this.online = new Set();
    this.down = false;
    this.cmds = [];
    this.objectives = new Map();   // name -> criterion
    this.scores = new Map();       // player -> Map(objective -> n)
    this.day = 3;
    this.daytime = 1000;
    this.dims = new Map();         // player -> 'minecraft:overworld'
    this.glue = '';                // how RCON joins the lines of `scoreboard players list` ('' or '\n')
    this.listFormat = 'normal';    // 'weird' = unrecognised reply -> fallback to `players get`
  }
  has(p, item) { return this.inv.get(p)?.get(item) || 0; }
  put(p, item, n) { const m = this.inv.get(p) || (this.inv.set(p, new Map()), this.inv.get(p)); m.set(item, (m.get(item) || 0) + n); }
  _bump(p, crit, n) {
    for (const [name, c] of this.objectives) if (c === crit) {
      const m = this.scores.get(p) || (this.scores.set(p, new Map()), this.scores.get(p));
      m.set(name, (m.get(name) || 0) + n);
    }
  }
  kill(p, mob, n = 1) { this._bump(p, `minecraft.killed:minecraft.${mob}`, n); }
  mine(p, block, n = 1) { this._bump(p, `minecraft.mined:minecraft.${block}`, n); }
  count(prefix) { return this.cmds.filter((c) => c.startsWith(prefix)).length; }
  rcon = async (cmd) => {
    this.cmds.push(cmd);
    await new Promise((r) => setTimeout(r, 1));
    if (this.down) throw new Error('rcon: connect ECONNREFUSED (fake RCON is down)');
    const w = cmd.split(' ');
    if (w[0] === 'list') return `There are ${this.online.size} of a max of 20 players online: ${[...this.online].join(', ')}`;
    if (w[0] === 'time' && w[1] === 'query') return `The time is ${w[2] === 'day' ? this.day : this.daytime}`;
    if (w[0] === 'scoreboard' && w[1] === 'objectives' && w[2] === 'add') {
      const [, , , name, crit] = w;
      if (name.length > 16) return `The objective name '${name}' is too long`;
      if (!/^minecraft\.(killed|mined):minecraft\.[a-z_]+$/.test(crit)) return `Unknown criterion '${crit}'`;
      if (this.objectives.has(name)) return 'An objective already exists by that name';
      this.objectives.set(name, crit);
      return `Created new objective [${name}]`;
    }
    if (w[0] === 'scoreboard' && w[1] === 'players' && w[2] === 'list') {
      const p = w[3];
      if (this.listFormat === 'weird') return '???';
      const m = [...(this.scores.get(p) || new Map())].filter(([o]) => this.objectives.has(o));
      if (!m.length) return `${p} has no scores to show`;
      return `${p} has ${m.length} scores:${this.glue}` + m.map(([o, n]) => `[${o}]: ${n}`).join(this.glue);
    }
    if (w[0] === 'scoreboard' && w[1] === 'players' && w[2] === 'get') {
      const [, , , p, o] = w;
      const v = this.scores.get(p)?.get(o);
      return v === undefined ? `Can't get value of ${o} for ${p}; none is set` : `${p} has ${v} [${o}]`;
    }
    if (w[0] === 'data' && w[1] === 'get' && w[2] === 'entity') {
      const p = w[3];
      if (!this.online.has(p)) return 'No entity was found';
      return `${p} has the following entity data: "${this.dims.get(p) || 'minecraft:overworld'}"`;
    }
    const [op, p, rawItem, nStr] = w;
    if (op !== 'give' && op !== 'clear') return 'Unknown or incomplete command';
    const item = rawItem.replace('minecraft:', '');
    const n = Number(nStr);
    if (!this.online.has(p)) return 'No player was found';
    if (op === 'give') { this.put(p, item, n); return `Gave ${n} [${item}] to ${p}`; }
    const have = this.has(p, item);
    const take = Math.min(have, n);
    if (!take) return `No items were found on player ${p}`;
    this.inv.get(p).set(item, have - take);
    return `Removed ${take} item(s) from player ${p}`;
  };
}

function seeded(seed = 7) { return () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x80000000; }; }

/** economy + board + earnings in a temp dir; catalog = the shipped one with optional earnings overrides */
function makeWorld({ dir = path.join(tmp, `w${Math.random().toString(36).slice(2, 8)}`), mc = new FakeMC(), names = ['Ash', 'Flint'], clock, earnings, dims = {} } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const propsFile = path.join(dir, 'server.properties');
  if (!fs.existsSync(propsFile)) fs.writeFileSync(propsFile, 'level-name=worlds/world-earn-test\n');
  let catalogFile = CATALOG;
  if (earnings) {
    const j = JSON.parse(fs.readFileSync(CATALOG, 'utf8'));
    j.earnings = { ...j.earnings, ...earnings };
    catalogFile = path.join(dir, 'catalog.json');
    fs.writeFileSync(catalogFile, JSON.stringify(j));
  }
  const notes = [];
  const c = clock || { t: 1_800_000_000_000 };
  const econ = new Economy({ dataDir: dir, rcon: mc.rcon, knownNames: () => names, notify: (to, text) => notes.push({ to, text }),
    propsFile, catalogFile, timers: false, now: () => c.t });
  const store = new Store(dir);
  const earn = new Earnings({ econ, store, timers: false, random: seeded(), botDims: () => dims });
  const events = [];
  econ.on('econ', (m) => events.push(m));
  return { econ, store, earn, mc, notes, dir, clock: c, events, dims, close: () => { econ.close(); store.close(); } };
}
const bal = (w, n) => w.econ.balance(n);
const totalCoins = (w) => Object.values(w.econ.state().wallets).reduce((a, b) => a + b, 0) + Object.values(w.earn.e.bounties).filter((b) => b.status === 'open').reduce((s, b) => s + b.total, 0);
const kinds = (w) => w.econ.history(null, 500).map((x) => x.kind);

// ------------------------------------------------------------------------------------------ 1. unit
console.log('parsers + settings');
await t('parseTime / parseScoreList / parseScoreGet / parseDimension / objName', () => {
  assert.equal(parseTime('The time is 1234'), 1234);
  assert.equal(parseTime('nope'), null);
  assert.deepEqual(parseScoreList('Ash has no scores to show'), {});
  assert.deepEqual(parseScoreList('Ash has 2 scores:[hm_zombie]: 2[hm_skeleton]: 11'), { hm_zombie: 2, hm_skeleton: 11 });
  assert.deepEqual(parseScoreList('Ash has 1 score:\n[hm_zombie]: 4'), { hm_zombie: 4 });
  assert.equal(parseScoreList('Unknown or incomplete command'), null);
  assert.equal(parseScoreGet('Ash has 5 [hm_zombie]'), 5);
  assert.equal(parseScoreGet("Can't get value of hm_zombie for Ash; none is set"), 0);
  assert.equal(parseScoreGet('???'), null);
  assert.equal(parseDimension('robin_mc has the following entity data: "minecraft:the_nether"'), 'the_nether');
  assert.equal(parseDimension('No entity was found'), null);
  const names = Object.keys(earnSettings({}).mobs.values).map((m) => objName('hm_', m, `minecraft.killed:minecraft.${m}`));
  assert.ok(names.every((n) => n.length <= 16 && /^[a-z0-9_]+$/.test(n)), names.join(','));
  assert.equal(new Set(names).size, names.length, 'objective names unique');
  assert.equal(objName('hm_', 'zombie', 'x'), 'hm_zombie');
  assert.notEqual(objName('hx_', 'deepslate_diamond_ore', 'minecraft.mined:minecraft.deepslate_diamond_ore'), objName('hx_', 'deepslate_emerald_ore', 'minecraft.mined:minecraft.deepslate_emerald_ore'));
});
await t('shipped catalog: earnings block parses; every job pays above the shop sell price and below its buy price', () => {
  const j = JSON.parse(fs.readFileSync(CATALOG, 'utf8'));
  const s = earnSettings(j.earnings);
  assert.equal(s.wage.amount, 10);
  assert.equal(s.mobs.values.zombie, 3);
  assert.equal(s.mobs.capPerMinute, 60);
  assert.ok(s.milestones.list.find((m) => m.id === 'nether' && m.dimension === 'the_nether'));
  const w = makeWorld();
  for (const p of s.jobs.pool) {
    const pr = w.earn._jobPay(p, s.jobs.premiumPct);
    assert.ok(pr, `job ${p.item} has a price`);
    const it = j.items[p.item];
    if (!p.pay) { assert.ok(pr.pay > it.sell, `${p.item} pay ${pr.pay} > sell ${it.sell}`); if (it.buy) assert.ok(pr.pay < it.buy, `${p.item} pay ${pr.pay} < buy ${it.buy}`); }
  }
  w.close();
});

console.log('board bounties');
await t('reward escrowed on board_add; not enough coins -> rejected and no task; done -> claimer paid; notices', async () => {
  const w = makeWorld();
  const before = totalCoins(w);
  const task = await w.earn.postTask({ by: 'Ash', title: 'Mine 24 iron', reward: 30 });
  assert.equal(bal(w, 'Ash'), 70);
  assert.equal(task.reward, 30); assert.equal(task.rewardStatus, 'open');
  const n = w.store.tasks.length;
  await rejects(w.earn.postTask({ by: 'Ash', title: 'too rich', reward: 500 }), 409, /not enough coins: have 70, need 500/);
  assert.equal(w.store.tasks.length, n, 'no task created when the escrow fails');
  await rejects(w.earn.postTask({ by: 'Ash', title: 'x', reward: -5 }), 400, /reward/);
  await rejects(w.earn.postTask({ by: 'Ghost', title: 'x', reward: 5 }), 404, /unknown player/);
  assert.equal(totalCoins(w), before, 'escrow keeps coins in the system');
  w.store.claimTask(task.id, 'Flint');
  await w.econ.idle();
  assert.equal(bal(w, 'Flint'), 100, 'claim alone pays nothing');
  w.store.updateTask(task.id, { by: 'Flint', status: 'done', note: '24 iron in chest' });
  await w.econ.idle();
  assert.equal(bal(w, 'Flint'), 130);
  assert.equal(bal(w, 'Ash'), 70);
  const t2 = w.store.task(task.id);
  assert.equal(t2.rewardStatus, 'paid'); assert.equal(t2.rewardTo, 'Flint'); assert.equal(t2.reward, 30);
  assert.ok(kinds(w).includes('bounty_hold') && kinds(w).includes('bounty_paid'));
  const paid = w.econ.history(null, 50).find((x) => x.kind === 'bounty_paid');
  assert.equal(paid.from, 'Escrow'); assert.equal(paid.to, 'Flint'); assert.equal(paid.amount, 30);
  assert.ok(w.notes.some((m) => m.to === 'Flint' && /Bounty: \+30 coins for task #\d+ "Mine 24 iron"/.test(m.text)));
  assert.ok(w.notes.some((m) => m.to === 'Ash' && /Flint got your 30 coins/.test(m.text)));
  assert.ok(w.events.some((e) => e.kind === 'earn' && e.source === 'bounty' && e.who === 'Flint' && e.amount === 30));
  // done again / reopened + done: never paid twice
  w.store.updateTask(task.id, { by: 'Flint', status: 'open' });
  w.store.updateTask(task.id, { by: 'Flint', status: 'done' });
  await w.econ.idle();
  assert.equal(bal(w, 'Flint'), 130);
  assert.equal(totalCoins(w), before);
  w.close();
});
await t('self-claim: the poster finishing their own bounty gets a refund, not a payment', async () => {
  const w = makeWorld();
  const task = await w.earn.postTask({ by: 'Ash', title: 'Self job', reward: 25 });
  w.store.claimTask(task.id, 'Ash');
  w.store.updateTask(task.id, { by: 'Ash', status: 'done' });
  await w.econ.idle();
  assert.equal(bal(w, 'Ash'), 100);
  assert.ok(!kinds(w).includes('bounty_paid'));
  assert.ok(kinds(w).includes('bounty_refund'));
  assert.equal(w.store.task(task.id).rewardStatus, 'refunded');
  w.close();
});
await t('several funders: claimer who also funded gets their own share back + everyone else\'s as payment', async () => {
  const w = makeWorld();
  w.econ._ensureAccounts();
  const task = w.store.addTask({ by: 'Robin', title: 'Build a bridge' });
  let r = await w.earn.addBounty({ who: 'Ash', task: task.id, amount: 20 });
  assert.equal(r.bounty.total, 20); assert.equal(r.balance, 80);
  r = await w.earn.addBounty({ who: 'Flint', task: task.id, amount: 10 });
  r = await w.earn.addBounty({ who: 'Robin', task: task.id, amount: 5 });
  assert.equal(r.bounty.total, 35);
  assert.equal(w.store.task(task.id).reward, 35);
  w.store.claimTask(task.id, 'Flint');
  w.store.updateTask(task.id, { by: 'Robin', status: 'done' }); // the poster marks it done for the claimer
  await w.econ.idle();
  assert.equal(bal(w, 'Flint'), 100 - 10 + 10 + 25);
  assert.equal(bal(w, 'Ash'), 80); assert.equal(bal(w, 'Robin'), 95);
  assert.equal(w.store.task(task.id).reward, 25, 'reward shows what was paid');
  w.close();
});
await t('refunds: task deleted; done with nobody claimed; cancel only while nobody else claimed it', async () => {
  const w = makeWorld();
  const a = await w.earn.postTask({ by: 'Ash', title: 'A', reward: 10 });
  w.store.deleteTask(a.id);
  await w.econ.idle();
  assert.equal(bal(w, 'Ash'), 100);
  assert.ok(w.notes.some((m) => m.to === 'Ash' && /refunded: 10 coins back.*deleted/.test(m.text)));
  const b = await w.earn.postTask({ by: 'Ash', title: 'B', reward: 10 });
  w.store.updateTask(b.id, { by: 'Ash', status: 'done' });
  await w.econ.idle();
  assert.equal(bal(w, 'Ash'), 100);
  assert.equal(w.store.task(b.id).rewardStatus, 'refunded');
  const c = await w.earn.postTask({ by: 'Robin', title: 'C', reward: 15 });
  w.store.claimTask(c.id, 'Ash');
  await rejects(w.earn.cancelBounty({ who: 'Robin', task: c.id }), 409, /Ash has claimed task/);
  await rejects(w.earn.cancelBounty({ who: 'Flint', task: c.id }), 409, /no coins on the bounty/);
  w.store.updateTask(c.id, { by: 'Ash', status: 'open' }); // the claimer releases it: bounty stays open
  await w.econ.idle();
  assert.equal(w.earn.bounties().length, 1);
  const r = await w.earn.cancelBounty({ who: 'Robin', task: c.id });
  assert.equal(r.refunded, 15); assert.equal(r.balance, 100);
  assert.equal(w.earn.bounties().length, 0);
  await rejects(w.earn.addBounty({ who: 'Ash', task: 999, amount: 5 }), 404, /no board task #999/);
  w.store.updateTask(c.id, { by: 'Ash', status: 'done' });
  await rejects(w.earn.addBounty({ who: 'Ash', task: c.id, amount: 5 }), 409, /already done/);
  w.close();
});

console.log('server jobs');
await t('jobs rotate each Minecraft day; deliver takes only what was removed; first come first served', async () => {
  const w = makeWorld();
  w.mc.online = new Set(['Ash', 'Flint']);
  await w.earn.poll();
  let jobs = w.earn.jobs();
  assert.ok(jobs.length >= 3 && jobs.length <= 5, `3-5 jobs (got ${jobs.length})`);
  assert.ok(w.events.some((e) => e.kind === 'jobs'));
  const j = jobs.find((x) => x.item !== 'cobblestone') || jobs[0];
  const sell = w.econ.items.get(j.item)?.sell;
  if (sell) assert.ok(j.pay > sell, 'premium over the shop sell price');
  w.mc.put('Ash', j.item, 5);
  let r = await w.earn.deliver({ who: 'Ash', id: j.id, count: j.count });
  assert.equal(r.count, 5, 'partial clear: only what Ash had');
  assert.equal(r.earned, 5 * j.pay); assert.equal(r.balance, 100 + 5 * j.pay);
  assert.equal(r.job.left, j.count - 5);
  assert.match(r.note, /only had 5/);
  assert.equal(w.mc.has('Ash', j.item), 0);
  const tx = w.econ.history('Ash', 5).find((x) => x.kind === 'job_pay');
  assert.equal(tx.from, 'Server'); assert.equal(tx.item, j.item); assert.equal(tx.count, 5);
  await rejects(w.earn.deliver({ who: 'Ash', id: j.id }), 409, /you have no/);
  w.mc.put('Flint', j.item, j.count + 10);
  r = await w.earn.deliver({ who: 'Flint', id: j.id });
  assert.equal(r.count, j.count - 5, 'only what the job still wants');
  assert.equal(r.job.status, 'filled');
  assert.equal(w.mc.has('Flint', j.item), 15);
  await rejects(w.earn.deliver({ who: 'Flint', id: j.id, count: 1 }), 409, /already filled/);
  await rejects(w.earn.deliver({ who: 'Flint', id: 9999 }), 404, /no server job/);
  w.mc.online.delete('Flint');
  const k = jobs.find((x) => x.id !== j.id);
  await rejects(w.earn.deliver({ who: 'Flint', id: k.id, count: 1 }), 409, /not online/);
  // same day: no rotation; next day: old ones expire, new ones posted
  await w.earn.poll();
  assert.deepEqual(w.earn.jobs().map((x) => x.id), jobs.map((x) => x.id));
  w.mc.day = 4;
  await w.earn.poll();
  const fresh = w.earn.jobs();
  assert.ok(fresh.every((x) => x.id > Math.max(...jobs.map((y) => y.id)) && x.status === 'open'));
  await rejects(w.earn.deliver({ who: 'Ash', id: k.id }), 404);
  w.close();
});
await t('jobs fall back to real time when the Minecraft day does not move', async () => {
  const w = makeWorld();
  await w.earn.poll();
  const first = w.earn.jobs().map((x) => x.id);
  w.clock.t += 29 * 60000; await w.earn.poll();
  assert.deepEqual(w.earn.jobs().map((x) => x.id), first);
  w.clock.t += 2 * 60000; await w.earn.poll();
  assert.notDeepEqual(w.earn.jobs().map((x) => x.id), first);
  w.close();
});

console.log('mob bounties');
await t('objectives created once (idempotent, names <=16); kill deltas paid; baseline survives a bridge restart', async () => {
  const dir = path.join(tmp, 'mobs');
  const mc = new FakeMC();
  mc.online = new Set(['Ash', 'robin_mc']);
  let w = makeWorld({ dir, mc });
  await w.earn.poll();
  const adds = mc.count('scoreboard objectives add');
  assert.ok(adds >= 30, `objectives added (${adds})`);
  assert.ok([...mc.objectives.keys()].every((n) => n.length <= 16));
  assert.ok([...mc.objectives.values()].includes('minecraft.killed:minecraft.zombie'));
  assert.ok([...mc.objectives.values()].includes('minecraft.mined:minecraft.diamond_ore'));
  await w.earn.poll();
  assert.equal(mc.count('scoreboard objectives add'), adds, 'not re-created every poll');
  mc.kill('Ash', 'zombie', 2); mc.kill('Ash', 'skeleton', 1); mc.kill('robin_mc', 'creeper', 1);
  await w.earn.poll();
  assert.equal(bal(w, 'Ash'), 100 + 2 * 3 + 3);
  assert.equal(bal(w, 'Robin'), 104, 'Robin (robin_mc) is paid too');
  const tx = w.econ.history('Ash', 5).find((x) => x.kind === 'mob_bounty');
  assert.equal(tx.from, 'Bank'); assert.equal(tx.amount, 9); assert.match(tx.note, /2 zombie, 1 skeleton/);
  assert.ok(w.notes.some((m) => m.to === 'Ash' && /Mob bounty: \+9 coins \(2 zombie, 1 skeleton\)/.test(m.text)));
  assert.ok(w.events.some((e) => e.kind === 'earn' && e.source === 'mob' && e.who === 'Robin' && e.amount === 4));
  await w.earn.poll();
  assert.equal(bal(w, 'Ash'), 109, 'no new kills, nothing paid');
  w.close();
  // bridge restart: new Economy/Earnings on the same files, server scores unchanged -> nothing paid twice
  w = makeWorld({ dir, mc });
  await w.earn.poll();
  assert.equal(bal(w, 'Ash'), 109);
  assert.equal(mc.count('scoreboard objectives add'), adds * 2, 'ensured again once after restart (already exists)');
  mc.kill('Ash', 'zombie', 1);
  await w.earn.poll();
  assert.equal(bal(w, 'Ash'), 112);
  // glued vs newline RCON output, and the per-objective fallback for an unrecognised reply
  mc.glue = '\n'; mc.kill('Ash', 'spider', 1); await w.earn.poll();
  assert.equal(bal(w, 'Ash'), 114);
  mc.listFormat = 'weird'; mc.kill('Ash', 'witch', 1); await w.earn.poll();
  assert.equal(bal(w, 'Ash'), 122);
  assert.ok(mc.count('scoreboard players get') > 0);
  w.close();
});
await t('first sight of an objective that was already on the server sets the baseline (old kills not paid)', async () => {
  const mc = new FakeMC();
  mc.online = new Set(['Ash']);
  mc.objectives.set('hm_zombie', 'minecraft.killed:minecraft.zombie');
  mc.kill('Ash', 'zombie', 50);
  const w = makeWorld({ mc });
  await w.earn.poll();
  assert.equal(bal(w, 'Ash'), 100);
  mc.kill('Ash', 'zombie', 1);
  await w.earn.poll();
  assert.equal(bal(w, 'Ash'), 103);
  w.close();
});
await t('per-player cap per minute: kills over the cap are not paid and not carried over', async () => {
  const mc = new FakeMC();
  mc.online = new Set(['Ash', 'Flint']);
  const w = makeWorld({ mc, earnings: { mobs: { capPerMinute: 20, values: { zombie: 3, creeper: 4 } } } });
  await w.earn.poll();
  mc.kill('Ash', 'creeper', 10); mc.kill('Flint', 'zombie', 2);
  await w.earn.poll();
  assert.equal(bal(w, 'Ash'), 120, '40 earned, capped at 20');
  assert.equal(bal(w, 'Flint'), 106, 'the cap is per player');
  assert.ok(w.notes.some((m) => m.to === 'Ash' && /20 more not paid: the cap is 20 coins a minute/.test(m.text)));
  w.clock.t += 30000; mc.kill('Ash', 'zombie', 1); await w.earn.poll();
  assert.equal(bal(w, 'Ash'), 120, 'still inside the minute');
  w.clock.t += 31000; mc.kill('Ash', 'zombie', 1); await w.earn.poll();
  assert.equal(bal(w, 'Ash'), 123, 'a minute later: paid again; the capped kills were not carried over');
  w.close();
});

console.log('milestones');
await t('mined milestones once per player; world-first bonus only for the first; dimensions (RCON + bot state)', async () => {
  const mc = new FakeMC();
  mc.online = new Set(['Ash', 'Flint', 'robin_mc']);
  const w = makeWorld({ mc, dims: { Ash: 'overworld', Flint: 'overworld' } }); // bots report their dimension (app.js: bots.list)
  await w.earn.poll();
  mc.mine('Ash', 'diamond_ore', 1);
  await w.earn.poll();
  assert.equal(bal(w, 'Ash'), 100 + 25 + 13, 'first diamond 25 + world first 50% (13)');
  assert.ok(kinds(w).includes('milestone') && kinds(w).includes('world_first'));
  assert.ok(w.events.some((e) => e.kind === 'earn' && e.source === 'milestone' && e.worldFirst));
  mc.mine('Ash', 'diamond_ore', 3); await w.earn.poll();
  assert.equal(bal(w, 'Ash'), 138, 'once per player');
  mc.mine('Flint', 'deepslate_diamond_ore', 1); await w.earn.poll();
  assert.equal(bal(w, 'Flint'), 100 + 25 + 30 + 15, 'Flint: first diamond (no world first) + deepslate diamond with world first');
  // Robin in the Nether via RCON `data get entity robin_mc Dimension`; Ash in the End via bot state
  mc.dims.set('robin_mc', 'minecraft:the_nether');
  w.dims.Ash = 'the_end';
  await w.earn.poll();
  assert.equal(bal(w, 'Robin'), 100 + 40 + 20);
  assert.equal(bal(w, 'Ash'), 138 + 100 + 50);
  assert.ok(mc.cmds.includes('data get entity robin_mc Dimension'));
  assert.ok(!mc.cmds.includes('data get entity Ash Dimension'), 'bots use their bot state');
  await w.earn.poll();
  assert.equal(bal(w, 'Robin'), 160);
  const e = w.earn.earnings('Robin');
  assert.ok(e.milestones.find((m) => m.id === 'nether').done);
  assert.equal(e.milestones.find((m) => m.id === 'diamond').firstBy, 'Ash');
  assert.equal(e.totals.milestone, 60);
  w.close();
});

console.log('daily wage');
await t('wage once per Minecraft sunrise to everyone online; not on first sight; time set back pays nothing', async () => {
  const mc = new FakeMC();
  mc.online = new Set(['Ash', 'robin_mc']);
  const w = makeWorld({ mc });
  await w.earn.poll();
  assert.equal(bal(w, 'Ash'), 100, 'first read of the day only sets it');
  mc.day = 4; await w.earn.poll();
  assert.equal(bal(w, 'Ash'), 110); assert.equal(bal(w, 'Robin'), 110); assert.equal(bal(w, 'Flint'), 100, 'offline: no wage');
  assert.ok(w.notes.some((m) => m.to === 'Ash' && /Daily wage: \+10 coins \(day 4\)/.test(m.text)));
  await w.earn.poll(); await w.earn.poll();
  assert.equal(bal(w, 'Ash'), 110, 'once per day');
  mc.day = 2; await w.earn.poll();
  mc.day = 3; await w.earn.poll();
  assert.equal(bal(w, 'Ash'), 120, 'after /time set back the next real sunrise pays once');
  const e = w.earn.earnings('Ash');
  assert.equal(e.totals.wage, 20); assert.equal(e.totals.today, 10);
  assert.ok(e.nextSunrise > w.clock.t);
  w.close();
});
await t('wage 0 = off; RCON down = nothing paid, nothing thrown', async () => {
  const mc = new FakeMC();
  mc.online = new Set(['Ash']);
  const w = makeWorld({ mc, earnings: { wage: { amount: 0 } } });
  await w.earn.poll(); mc.day = 9; await w.earn.poll();
  assert.equal(bal(w, 'Ash'), 100);
  mc.down = true;
  const r = await w.earn.poll();
  assert.equal(r.ok, false);
  w.close();
});

// ------------------------------------------------------------------------------------------ 2. hub
console.log('hub: routes, ws, commands, bot tools');
const { createApp } = await import('../bridge/hub/app.js');
const mock = await import('./hub-mock-engine.mjs');
const { WebSocket } = await import('ws');
const PORT = Number(process.env.HIVE_EARN_TEST_PORT) || 47983;
const BASE = `http://127.0.0.1:${PORT}`;
const hubDir = path.join(tmp, 'hub');
fs.mkdirSync(hubDir, { recursive: true });
const hubProps = path.join(hubDir, 'server.properties');
fs.writeFileSync(hubProps, 'level-name=worlds/world-hub-earn\n');
const hmc = new FakeMC();
hmc.online = new Set(['robin_mc']);
const app = createApp({ engine: mock, dataDir: hubDir, port: PORT, econOpts: { rcon: hmc.rcon, propsFile: hubProps, catalogFile: CATALOG, timers: false, random: seeded(3) } });
await app.start();
const api = async (method, p, body) => {
  const r = await fetch(BASE + p, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, json: await r.json() };
};
const cmd = async (text) => (await api('POST', '/mod/command', { text })).json;
const txt = (r) => r.lines.map((l) => l.map((s) => s.text).join('')).join('\n');

await t('HTTP: board reward, claim/done reply shows the payout, bounties, jobs, deliver, earnings, state extras', async () => {
  await api('POST', '/bots', { name: 'Ash' });
  hmc.online.add('Ash');
  let r = await api('POST', '/board', { by: 'Robin', title: 'Fence the farm', reward: 40 });
  assert.equal(r.status, 200, JSON.stringify(r.json)); assert.equal(r.json.reward, 40);
  const id = r.json.id;
  r = await api('POST', '/board', { by: 'Robin', title: 'too much', reward: 5000 });
  assert.equal(r.status, 409);
  r = await api('POST', '/board', { by: 'Robin', title: 'plain task' });
  assert.equal(r.status, 200); assert.equal(r.json.reward, undefined);
  r = await api('POST', '/econ/bounty', { who: 'Ash', task: id, amount: 5 });
  assert.equal(r.status, 200); assert.equal(r.json.bounty.total, 45); assert.equal(r.json.balance, 95);
  r = await api('GET', '/econ/bounties');
  assert.equal(r.json.bounties.length, 1);
  r = await api('POST', `/board/${id}/claim`, { by: 'Ash' });
  assert.equal(r.status, 200);
  r = await api('POST', `/board/${id}`, { by: 'Ash', status: 'done', note: 'fenced' });
  assert.equal(r.json.rewardStatus, 'paid', JSON.stringify(r.json)); assert.equal(r.json.rewardTo, 'Ash'); assert.equal(r.json.reward, 40);
  r = await api('GET', '/econ/state?who=Ash');
  assert.equal(r.json.me.balance, 140, 'Ash: 95 + own 5 back + 40 from Robin');
  assert.ok(Array.isArray(r.json.jobs) && Array.isArray(r.json.bounties) && r.json.earnings.who === 'Ash');
  assert.equal(r.json.earnings.totals.bounty, 40);
  await app.earn.poll();
  r = await api('GET', '/econ/jobs');
  assert.ok(r.json.jobs.length >= 3);
  const j = r.json.jobs[0];
  hmc.put('robin_mc', j.item, 3);
  r = await api('POST', '/econ/jobs/deliver', { who: 'Robin', id: j.id, count: 3 });
  assert.equal(r.status, 200, JSON.stringify(r.json)); assert.equal(r.json.count, 3); assert.equal(r.json.earned, 3 * j.pay);
  r = await api('GET', '/econ/earnings?who=Robin');
  assert.equal(r.json.totals.job, 3 * j.pay);
  assert.ok(r.json.rates.mobs.zombie === 3 && r.json.rates.wage === 10);
  r = await api('POST', '/econ/jobs/deliver', { who: 'Robin', id: 99999 });
  assert.equal(r.status, 404);
});

await t('ws topic econ: earn + jobs + bounty events', async () => {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/mod`);
  const got = [];
  ws.on('message', (d) => got.push(JSON.parse(String(d))));
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  ws.send(JSON.stringify({ t: 'hello', player: 'Robin', want: ['econ', 'board'] }));
  await new Promise((r) => setTimeout(r, 100));
  const init = got.find((m) => m.t === 'init');
  assert.ok(init?.econ?.jobs && init.econ.earnings, 'init.econ carries jobs + earnings');
  hmc.kill('robin_mc', 'zombie', 1);
  await app.earn.poll();
  await api('POST', '/board', { by: 'Robin', title: 'ws bounty', reward: 3 });
  hmc.day += 1; await app.earn.poll();
  await new Promise((r) => setTimeout(r, 100));
  const ev = got.filter((m) => m.t === 'econ');
  assert.ok(ev.some((m) => m.kind === 'earn' && m.source === 'mob' && m.who === 'Robin' && m.amount === 3), 'mob earn event');
  assert.ok(ev.some((m) => m.kind === 'earn' && m.source === 'wage'), 'wage earn event');
  assert.ok(ev.some((m) => m.kind === 'jobs' && Array.isArray(m.jobs)), 'jobs event');
  assert.ok(ev.some((m) => m.kind === 'bounty' && m.bounty.title === 'ws bounty'), 'bounty event');
  assert.ok(got.some((m) => m.t === 'board' && m.task?.title === 'ws bounty' && m.task.reward === 3), 'board task carries the reward');
  ws.close();
});

await t('terminal: jobs, deliver, bounties, bounty, board add $n, board shows rewards, earnings, help', async () => {
  let r = await cmd('jobs');
  assert.ok(r.ok, txt(r)); assert.match(txt(r), /Server jobs/);
  const j = r.data.jobs.find((x) => x.status === 'open');
  hmc.put('robin_mc', j.item, 2);
  r = await cmd(`deliver ${j.id} 2`);
  assert.ok(r.ok, txt(r)); assert.match(txt(r), new RegExp(`delivered 2 ${j.item.replace(/_/g, ' ')} for job #${j.id}`));
  r = await cmd('deliver x');
  assert.equal(r.ok, false); assert.match(txt(r), /usage: deliver/);
  r = await cmd('board add Dig a moat $12');
  assert.ok(r.ok, txt(r)); assert.match(txt(r), /added #\d+ Dig a moat\s+bounty 12¢/);
  const tid = r.data.task.id;
  assert.equal(r.data.task.title, 'Dig a moat');
  r = await cmd('board');
  assert.match(txt(r), /Dig a moat\s+bounty 12¢/);
  r = await cmd(`bounty ${tid} 8`);
  assert.ok(r.ok, txt(r)); assert.match(txt(r), /now 20¢/);
  r = await cmd('bounties');
  assert.match(txt(r), new RegExp(`#${tid}\\s+20¢\\s+Dig a moat`));
  r = await cmd(`bounty ${tid} cancel`);
  assert.ok(r.ok, txt(r)); assert.match(txt(r), /withdrawn 20¢/);
  r = await cmd('board add Too pricey $999999');
  assert.equal(r.ok, false); assert.match(txt(r), /not enough coins/);
  r = await cmd('earnings');
  assert.ok(r.ok, txt(r)); assert.match(txt(r), /Earnings: Robin/); assert.match(txt(r), /first diamond/); assert.match(txt(r), /daily wage 10¢/);
  r = await cmd('earnings Ash');
  assert.match(txt(r), /Earnings: Ash/);
  r = await cmd('help');
  assert.match(txt(r), /jobs/); assert.match(txt(r), /bounty <task-id>/);
});

await t('bot MCP tools: jobs, job_deliver, bounties, bounty_add, bounty_cancel, earnings', async () => {
  const { makeEconTools } = await import('../mcp/econ-tools.js');
  const http = async (method, p, body) => {
    const r = await fetch(BASE + p, { method, headers: body ? { 'content-type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
    const data = await r.json();
    if (!r.ok) { const e = new Error(data.error); e.status = r.status; throw e; }
    return data;
  };
  const { tools } = makeEconTools({ BOT: 'Ash', get: (p) => http('GET', p), post: (p, b) => http('POST', p, b), enc: encodeURIComponent });
  const run = (name, a = {}) => tools.find((x) => x.name === name).run(a);
  for (const n of ['jobs', 'job_deliver', 'bounties', 'bounty_add', 'bounty_cancel', 'earnings']) assert.ok(tools.find((x) => x.name === n), n);
  let out = await run('jobs');
  assert.match(out, /#\d+ deliver \d+ \w+.* each/);
  const j = (await http('GET', '/econ/jobs')).jobs.find((x) => x.status === 'open');
  hmc.put('Ash', j.item, 1);
  out = await run('job_deliver', { id: String(j.id), count: '1' });
  assert.match(out, new RegExp(`Delivered 1 ${j.item} for job #${j.id}: \\+${j.pay} coin`)); assert.match(out, /💰 balance: \d+ coins/);
  await assert.rejects(run('job_deliver', { id: j.id }), /you have no .* — Check `inventory`/);
  const task = (await http('POST', '/board', { by: 'Robin', title: 'Bring 16 torches' }));
  out = await run('bounty_add', { task: task.id, amount: 6 });
  assert.match(out, /Bounty on task #\d+ "Bring 16 torches" is now 6 coins/); assert.match(out, /balance/);
  out = await run('bounties');
  assert.match(out, /💰6 Bring 16 torches — open \(from you\)/);
  out = await run('bounty_cancel', { task: task.id });
  assert.match(out, /Withdrew 6 coins/);
  await assert.rejects(run('bounty_add', { task: 99999, amount: 1 }), /no board task #99999/);
  out = await run('earnings');
  assert.match(out, /Earned today \d+ coins/); assert.match(out, /zombie 3/); assert.match(out, /first diamond/); assert.match(out, /Daily wage: 10/);
});

await t('MCP board_add has `reward` only with the economy on; board lines show the bounty', async () => {
  const src = fs.readFileSync(path.join(ROOT, 'mcp', 'mc-mcp.js'), 'utf8');
  assert.match(src, /\.\.\.\(ECON_ON \? \{ reward:/);
  assert.match(src, /process\.env\.HIVE_ECONOMY === '0' \? \[\] : ECON\.tools/);
});

await app.close();

console.log('economy OFF');
await t('HIVE_ECONOMY off: no earnings, /econ/* 404, board reward refused, no RCON polling', async () => {
  const offDir = path.join(tmp, 'off');
  fs.mkdirSync(offDir, { recursive: true });
  const omc = new FakeMC();
  omc.online = new Set(['robin_mc']);
  const off = createApp({ engine: mock, dataDir: offDir, port: PORT + 1, econOpts: { enabled: false, rcon: omc.rcon, propsFile: hubProps, catalogFile: CATALOG } });
  await off.start();
  try {
    assert.equal(off.earn, null); assert.equal(off.econ, null);
    const a = async (m, p, b) => { const r = await fetch(`http://127.0.0.1:${PORT + 1}${p}`, { method: m, headers: { 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined }); return { status: r.status, json: await r.json() }; };
    for (const p of ['/econ/jobs', '/econ/bounties', '/econ/earnings']) assert.equal((await a('GET', p)).status, 404, p);
    assert.equal((await a('POST', '/econ/jobs/deliver', { who: 'Robin', id: 1 })).status, 404);
    let r = await a('POST', '/board', { by: 'Robin', title: 'x', reward: 5 });
    assert.equal(r.status, 400); assert.match(r.json.error, /economy/);
    assert.equal((await a('GET', '/board')).json.length, 0, 'no task created');
    r = await a('POST', '/board', { by: 'Robin', title: 'plain' });
    assert.equal(r.status, 200); assert.equal(r.json.reward, undefined);
    r = await a('POST', '/mod/command', { text: 'jobs' });
    assert.equal(r.json.ok, false); assert.match(txt(r.json), /economy is not running/);
    r = await a('POST', '/mod/command', { text: 'board add Thing $5' });
    assert.equal(r.json.ok, false);
    await new Promise((res) => setTimeout(res, 200));
    assert.equal(omc.cmds.length, 0, 'no RCON at all');
  } finally { await off.close(); }
});

await t('no TCP connect to a live Minecraft / RCON / bridge port happened', () => assertNoLiveConnects());

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(process.exitCode || 0);
