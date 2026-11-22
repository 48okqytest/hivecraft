// Economy test, fully offline (no Minecraft, no RCON, no bots): node test/econ-test.mjs
//  1. Economy unit tests against a FAKE RCON that simulates inventories / online players / failures
//  2. the hub on a spare port (mock engine) with the fake RCON: /econ/* HTTP, ws topic 'econ', terminal commands
import { assertNoLiveConnects, liveConnects } from './neutral-player.mjs'; // neutral player Robin/robin_mc + live ports blocked
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
process.env.HIVE_EARNINGS_POLL = '0'; // tests never poll a live Minecraft server (earnings scoreboards/time)

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CATALOG = path.join(ROOT, 'data', 'econ-catalog.json');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-econ-test-'));

const { Economy, normItem, parseClear, parseGive, parseList } = await import('../bridge/hub/economy.js');

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); pass++; console.log('  ok  ', name); }
  catch (e) { fail++; console.log('  FAIL', name, '\n      ', e?.stack?.split('\n').slice(0, 4).join('\n       ') || e); process.exitCode = 1; }
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
    this.inv = new Map();       // player -> Map(item -> n)
    this.online = new Set();
    this.down = false;          // RCON unreachable
    this.giveFailAfter = null;  // number of successful give calls before a weird error
    this.clearReply = null;     // override the clear reply
    this.cmds = [];
    this.gives = 0;
  }
  has(p, item) { return this.inv.get(p)?.get(item) || 0; }
  put(p, item, n) {
    const m = this.inv.get(p) || (this.inv.set(p, new Map()), this.inv.get(p));
    m.set(item, (m.get(item) || 0) + n);
  }
  rcon = async (cmd) => {
    this.cmds.push(cmd);
    await new Promise((r) => setTimeout(r, 1)); // real async gap so races would show
    if (this.down) throw new Error('rcon: connect ECONNREFUSED (fake RCON is down)');
    const w = cmd.split(' ');
    if (w[0] === 'list') return `There are ${this.online.size} of a max of 20 players online: ${[...this.online].join(', ')}`;
    const [op, p, rawItem, nStr] = w;
    const item = rawItem.replace('minecraft:', '');
    const n = Number(nStr);
    if (!this.online.has(p)) return 'No player was found';
    if (item === 'bogus_item') return `Unknown item 'minecraft:bogus_item'`;
    if (op === 'give') {
      if (this.giveFailAfter !== null && this.gives >= this.giveFailAfter) return 'An unexpected error occurred trying to execute that command';
      this.gives++;
      this.put(p, item, n);
      return `Gave ${n} [${item}] to ${p}`;
    }
    if (op === 'clear') {
      if (this.clearReply) return this.clearReply;
      const have = this.has(p, item);
      const take = Math.min(have, n);
      if (!take) return `No items were found on player ${p}`;
      this.inv.get(p).set(item, have - take);
      return `Removed ${take} item(s) from player ${p}`;
    }
    return 'Unknown command';
  };
}

function makeEcon({ dir = path.join(tmp, `e${Math.random().toString(36).slice(2, 8)}`), props, mc = new FakeMC(), names = ['Ash', 'Flint'], clock } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const propsFile = props || path.join(dir, 'server.properties');
  if (!props) fs.writeFileSync(propsFile, 'motd=x\nlevel-name=worlds/world-20261121-000000\n');
  const notes = [];
  const c = clock || { t: 1_800_000_000_000 };
  const econ = new Economy({ dataDir: dir, rcon: mc.rcon, knownNames: () => names, notify: (to, text) => notes.push({ to, text }),
    propsFile, catalogFile: CATALOG, timers: false, now: () => c.t });
  return { econ, mc, notes, dir, propsFile, clock: c };
}

const total = (econ) => {
  const st = econ.state();
  const held = Object.keys(st.wallets).reduce((s, n) => s + econ.held(n), 0);
  return Object.values(st.wallets).reduce((a, b) => a + b, 0) + held;
};
const serverNet = (econ) => econ.history(null, 500).reduce((s, x) => s + (x.kind === 'shop_sell' ? x.amount : x.kind === 'shop_buy' ? -x.amount : 0), 0);

// ------------------------------------------------------------------------------------------ 1. unit
console.log('parsers');
await t('normItem / parseClear / parseGive / parseList', () => {
  assert.equal(normItem('Oak Log'), 'oak_log');
  assert.equal(normItem('minecraft:OAK_LOG'), 'oak_log');
  assert.throws(() => normItem('oak;log'), /bad item/);
  assert.deepEqual(parseClear('Removed 12 item(s) from player Ash'), { removed: 12 });
  assert.deepEqual(parseClear('No items were found on player Ash'), { removed: 0 });
  assert.ok(parseClear('No player was found').offline);
  assert.ok(parseClear("Unknown item 'minecraft:x'").badItem);
  assert.ok(parseClear('weird').error);
  assert.ok(parseGive('Gave 5 [Bread] to Ash').ok);
  assert.ok(parseGive('No player was found').offline);
  assert.deepEqual([...parseList('There are 2 of a max of 20 players online: Ash, robin_mc')], ['ash', 'robin_mc']);
  assert.equal(parseList('There are 0 of a max of 20 players online: ').size, 0);
});

console.log('economy');
const E = makeEcon();
const { econ, mc, notes } = E;
mc.online = new Set(['Ash', 'Flint', 'robin_mc']);

await t('accounts: every bot + Robin start with 100; robin_mc is Robin', async () => {
  const st = econ.state('robin_mc');
  assert.equal(st.world, 'world-20261121-000000');
  assert.deepEqual(st.wallets, { Robin: 100, Ash: 100, Flint: 100 });
  assert.equal(st.me.name, 'Robin');
  assert.equal(econ.resolve('ash'), 'Ash');
  assert.ok(st.shop.length > 60, 'catalog loaded');
  assert.equal(st.shop.find((i) => i.item === 'bread').buy, 6);
  assert.equal(econ.history('Ash')[0].kind, 'start');
  await rejects(econ.pay({ who: 'Nobody', to: 'Ash', amount: 1 }), 404, /unknown player "Nobody": accounts are Ash, Flint, Robin/);
});

await t('shop buy: coins taken, give sent', async () => {
  const r = await econ.shopBuy({ who: 'Ash', item: 'Bread', count: 5 });
  assert.equal(r.count, 5); assert.equal(r.cost, 30); assert.equal(r.balance, 70);
  assert.equal(mc.has('Ash', 'bread'), 5);
  assert.ok(mc.cmds.includes('give Ash minecraft:bread 5'));
});

await t('insufficient funds: clear message, nothing given', async () => {
  const before = mc.cmds.length;
  await rejects(econ.shopBuy({ who: 'Ash', item: 'diamond', count: 1 }), 409, /^not enough coins: have 70, need 120/);
  assert.equal(mc.cmds.length, before, 'no RCON call');
  assert.equal(econ.balance('Ash'), 70);
});

await t('shop errors: unknown item suggests, buy-only / sell-only, bad counts', async () => {
  await rejects(econ.shopBuy({ who: 'Ash', item: 'oak', count: 1 }), 404, /doesn't sell "oak".*Did you mean: .*oak_log/);
  await rejects(econ.shopBuy({ who: 'Ash', item: 'rotten_flesh' }), 409, /only buys it, for 1 each/);
  await rejects(econ.shopSell({ who: 'Ash', item: 'torch' }), 409, /doesn't buy torch/);
  await rejects(econ.shopBuy({ who: 'Ash', item: 'bread', count: 1.5 }), 400, /count must be a whole number/);
  await rejects(econ.shopBuy({ who: 'Ash', item: 'bread', count: 0 }), 400, /between 1 and 640/);
  await rejects(econ.shopBuy({ who: '', item: 'bread' }), 400, /who is required/);
});

await t('sell with partial clear: paid only for what was removed', async () => {
  mc.put('Ash', 'rotten_flesh', 3);
  const r = await econ.shopSell({ who: 'Ash', item: 'rotten_flesh', count: 10 });
  assert.equal(r.count, 3); assert.equal(r.earned, 3); assert.equal(r.balance, 73);
  assert.match(r.note, /only had 3/);
  assert.equal(mc.has('Ash', 'rotten_flesh'), 0);
  await rejects(econ.shopSell({ who: 'Ash', item: 'rotten_flesh', count: 1 }), 409, /you have no rotten_flesh/);
  assert.equal(econ.balance('Ash'), 73);
});

await t('offline player / RCON down / weird reply: nothing changes', async () => {
  mc.online.delete('Ash');
  await rejects(econ.shopBuy({ who: 'Ash', item: 'bread' }), 409, /not online in Minecraft/);
  await rejects(econ.shopSell({ who: 'Ash', item: 'bread' }), 409, /not online/);
  mc.online.add('Ash');
  mc.down = true;
  await rejects(econ.shopBuy({ who: 'Ash', item: 'bread' }), 502, /not reachable.*nothing changed/);
  await rejects(econ.list({ who: 'Ash', item: 'bread', count: 1, price: 5 }), 502, /not reachable/);
  mc.down = false;
  mc.clearReply = 'Something odd';
  await rejects(econ.shopSell({ who: 'Ash', item: 'bread' }), 502, /unexpected server reply/);
  mc.clearReply = null;
  await rejects(econ.list({ who: 'Ash', item: 'bogus_item', count: 1, price: 5 }), 404, /unknown item "bogus_item"/);
  assert.equal(econ.balance('Ash'), 73);
  assert.equal(mc.has('Ash', 'bread'), 5);
});

await t('partial give: only delivered items are charged', async () => {
  mc.giveFailAfter = mc.gives + 1; // first 64-stack works, second fails
  const r = await econ.shopBuy({ who: 'Robin', item: 'torch', count: 100 });
  mc.giveFailAfter = null;
  assert.equal(r.count, 64); assert.equal(r.cost, 64);
  assert.match(r.warning, /only 64 of 100/);
  assert.equal(mc.has('robin_mc', 'torch'), 64);
  assert.equal(econ.balance('Robin'), 36);
});

await t('pay: transfer, aliases, notifications, errors', async () => {
  const r = await econ.pay({ who: 'robin_mc', to: 'ash', amount: 6, note: 'for bread' });
  assert.equal(r.balance, 30); assert.equal(r.to, 'Ash');
  assert.equal(econ.balance('Ash'), 79);
  assert.ok(notes.some((n) => n.to === 'Ash' && /Robin paid you 6 coins/.test(n.text)));
  await rejects(econ.pay({ who: 'Ash', to: 'Ash', amount: 1 }), 400, /yourself/);
  await rejects(econ.pay({ who: 'Ash', to: 'Flint', amount: -5 }), 400, /between 1/);
  await rejects(econ.pay({ who: 'Ash', to: 'Flint', amount: 'lots' }), 400, /whole number/);
  await rejects(econ.pay({ who: 'Robin', to: 'Flint', amount: 31 }), 409, /not enough coins: have 30, need 31/);
});

let lid;
await t('shops + list: items escrowed (exact removed count)', async () => {
  const o = await econ.openShop({ who: 'Flint', name: 'Flint Lumber', description: 'logs' });
  assert.equal(o.opened, true);
  await rejects(econ.openShop({ who: 'Ash', name: 'flint lumber' }), 409, /taken by Flint/);
  mc.put('Flint', 'oak_log', 20);
  const r = await econ.list({ who: 'Flint', item: 'oak_log', count: 30, price: 2 });
  lid = r.listing.id;
  assert.equal(r.removed, 20); assert.equal(r.listing.count, 20); assert.equal(r.listing.shop, 'Flint Lumber');
  assert.equal(mc.has('Flint', 'oak_log'), 0);
  assert.equal(econ.market({ item: 'oak' }).length, 1);
  assert.equal(econ.shops()[0].listings, 1);
  await rejects(econ.list({ who: 'Flint', item: 'oak_log', count: 1, price: 2 }), 409, /you have no oak_log/);
});

await t('market buy: buyer pays seller, items delivered, seller notified', async () => {
  const r = await econ.marketBuy({ who: 'Ash', id: lid, count: 5 });
  assert.equal(r.cost, 10); assert.equal(r.balance, 69); assert.equal(r.delivered, true);
  assert.equal(econ.balance('Flint'), 110);
  assert.equal(mc.has('Ash', 'oak_log'), 5);
  assert.equal(econ.market()[0].count, 15);
  assert.ok(notes.some((n) => n.to === 'Flint' && /Ash bought 5 oak log from your listing/.test(n.text)));
  await rejects(econ.marketBuy({ who: 'Flint', id: lid }), 409, /your own; use unlist/);
  await rejects(econ.marketBuy({ who: 'Ash', id: lid, count: 16 }), 409, /has only 15 left/);
  await rejects(econ.marketBuy({ who: 'Ash', id: 999 }), 404, /no open listing #999/);
});

await t('market buy for an offline buyer queues delivery; delivered when online', async () => {
  mc.online.delete('robin_mc');
  const r = await econ.marketBuy({ who: 'Robin', id: lid, count: 3 });
  assert.equal(r.delivered, false);
  assert.equal(econ.state('Robin').deliveries.length, 1);
  assert.equal(mc.has('robin_mc', 'oak_log'), 0);
  await econ.tick({ forceDeliveries: true });
  assert.equal(econ.state('Robin').deliveries.length, 1, 'still offline: stays queued');
  mc.online.add('robin_mc');
  await econ.tick({ forceDeliveries: true });
  assert.equal(econ.state('Robin').deliveries.length, 0);
  assert.equal(mc.has('robin_mc', 'oak_log'), 3);
  assert.equal(econ.history('Robin')[0].kind, 'deliver');
});

await t('market buy with RCON down: 502, nothing changes', async () => {
  const bal = econ.balance('Ash'), cnt = econ.market()[0].count;
  mc.down = true;
  await rejects(econ.marketBuy({ who: 'Ash', id: lid, count: 1 }), 502, /not reachable/);
  mc.down = false;
  assert.equal(econ.balance('Ash'), bal); assert.equal(econ.market()[0].count, cnt);
});

await t('unlist (cancel) returns the remaining items; only the seller can', async () => {
  await rejects(econ.unlist({ who: 'Ash', id: lid }), 409, /belongs to Flint/);
  const r = await econ.unlist({ who: 'Flint', id: lid });
  assert.equal(r.returned, 12); assert.equal(r.delivered, true);
  assert.equal(mc.has('Flint', 'oak_log'), 12);
  assert.equal(econ.market().length, 0);
});

await t('sold-out listing disappears', async () => {
  mc.put('Flint', 'coal', 4);
  const { listing } = await econ.list({ who: 'Flint', item: 'coal', count: 4, price: 3 });
  const r = await econ.marketBuy({ who: 'Ash', id: listing.id });
  assert.equal(r.count, 4);
  assert.equal(econ.market().length, 0);
});

let aid;
await t('auction: create escrows items; bids hold coins; outbid refunds; anti-snipe', async () => {
  mc.put('Flint', 'diamond', 3);
  const c = await econ.createAuction({ who: 'Flint', item: 'diamond', count: 3, start: 50, durationSec: 120 });
  aid = c.auction.id;
  assert.equal(c.removed, 3); assert.equal(mc.has('Flint', 'diamond'), 0);
  assert.equal(c.auction.endsAt, E.clock.t + 120000);
  await rejects(econ.bid({ who: 'Flint', id: aid, amount: 60 }), 409, /your own/);
  await rejects(econ.bid({ who: 'Ash', id: aid, amount: 40 }), 409, /minimum next bid on auction #\d+ is 50/);
  await econ.pay({ who: 'Flint', to: 'Ash', amount: 50 }); // enough for the late 74 bid
  const ashBefore = econ.balance('Ash');
  await econ.bid({ who: 'Ash', id: aid, amount: 50 });
  assert.equal(econ.balance('Ash'), ashBefore - 50); assert.equal(econ.held('Ash'), 50);
  await econ.pay({ who: 'Flint', to: 'Robin', amount: 70 }); // give Robin bidding money (Robin 30 -> 100)
  await rejects(econ.bid({ who: 'Robin', id: aid, amount: 52 }), 409, /is 53/);
  await econ.bid({ who: 'Robin', id: aid, amount: 60 });
  assert.equal(econ.balance('Ash'), ashBefore, 'outbid refunded');
  assert.equal(econ.held('Ash'), 0);
  assert.ok(notes.some((n) => n.to === 'Ash' && /Outbid on auction/.test(n.text)));
  const chBefore = econ.balance('Robin');
  await econ.bid({ who: 'Robin', id: aid, amount: 70 }); // raise own bid: only +10
  assert.equal(econ.balance('Robin'), chBefore - 10);
  assert.equal(econ.held('Robin'), 70);
  E.clock.t += 110000; // 10 s left
  const r = await econ.bid({ who: 'Ash', id: aid, amount: 74 });
  assert.equal(r.auction.endsAt, E.clock.t + 30000, 'extended');
  assert.match(r.note, /extended/);
  assert.equal(econ.balance('Robin'), chBefore + 60, 'Robin refunded 70');
});

await t('auction settles on the timer: winner gets items, seller gets coins', async () => {
  const flint = econ.balance('Flint');
  E.clock.t += 20000;
  await econ.tick();
  assert.equal(econ.auctions()[0].status, 'open', 'not yet');
  E.clock.t += 11000;
  await econ.tick();
  const a = econ.auctions({ all: true }).find((x) => x.id === aid);
  assert.equal(a.status, 'sold'); assert.equal(a.winner, 'Ash'); assert.equal(a.ended, true);
  assert.equal(mc.has('Ash', 'diamond'), 3);
  assert.equal(econ.balance('Flint'), flint + 74);
  assert.equal(econ.held('Ash'), 0);
  assert.ok(notes.some((n) => n.to === 'Ash' && /You won auction/.test(n.text)));
  await rejects(econ.bid({ who: 'Robin', id: aid, amount: 100 }), 409, /has ended/);
});

await t('auction with no bids: items back to the seller; cancel rules', async () => {
  mc.put('robin_mc', 'gold_ingot', 2);
  const c = await econ.createAuction({ who: 'Robin', item: 'gold_ingot', count: 2, start: 30, minutes: 1 });
  E.clock.t += 61000;
  await econ.tick();
  assert.equal(econ.auctions({ all: true }).find((x) => x.id === c.auction.id).status, 'unsold');
  assert.equal(mc.has('robin_mc', 'gold_ingot'), 2);
  const d = await econ.createAuction({ who: 'Robin', item: 'gold_ingot', count: 1, start: 5, minutes: 5 });
  await econ.bid({ who: 'Ash', id: d.auction.id, amount: 5 });
  await rejects(econ.cancelAuction({ who: 'Robin', id: d.auction.id }), 409, /already has bids/);
  const e = await econ.createAuction({ who: 'Robin', item: 'gold_ingot', count: 1, start: 5, minutes: 5 });
  await rejects(econ.cancelAuction({ who: 'Ash', id: e.auction.id }), 409, /belongs to Robin/);
  const r = await econ.cancelAuction({ who: 'Robin', id: e.auction.id });
  assert.equal(r.auction.status, 'cancelled'); assert.equal(mc.has('robin_mc', 'gold_ingot'), 1);
  await rejects(econ.createAuction({ who: 'Robin', item: 'gold_ingot', count: 1, start: 5, minutes: 0 }), 400, /minutes must be between 1/);
});

await t('coins are conserved (wallets + held = grants + shop net)', () => {
  const grants = econ.history(null, 500).filter((x) => x.kind === 'start').reduce((s, x) => s + x.amount, 0);
  assert.equal(total(econ), grants + serverNet(econ));
});

await t('concurrency: 10 parallel buys with money for 3 -> exactly 3 succeed, never negative', async () => {
  const x = makeEcon({ names: ['Rook'] });
  x.mc.online = new Set(['Rook']);
  await x.econ.pay({ who: 'Rook', to: 'Robin', amount: 100 - 3 * 25 }); // Rook keeps 75 = 3 beds
  const rs = await Promise.allSettled(Array.from({ length: 10 }, () => x.econ.shopBuy({ who: 'Rook', item: 'white_bed', count: 1 })));
  assert.equal(rs.filter((r) => r.status === 'fulfilled').length, 3);
  assert.ok(rs.filter((r) => r.status === 'rejected').every((r) => /not enough coins: have 0, need 25/.test(r.reason.message)));
  assert.equal(x.econ.balance('Rook'), 0);
  assert.equal(x.mc.has('Rook', 'white_bed'), 3);
  // parallel market buys of the same listing never oversell
  x.mc.put('Rook', 'oak_log', 4);
  x.mc.online.add('robin_mc');
  const { listing } = await x.econ.list({ who: 'Rook', item: 'oak_log', count: 4, price: 1 });
  const rb = await Promise.allSettled(Array.from({ length: 6 }, () => x.econ.marketBuy({ who: 'Robin', id: listing.id, count: 1 })));
  assert.equal(rb.filter((r) => r.status === 'fulfilled').length, 4);
  assert.equal(x.mc.has('robin_mc', 'oak_log'), 4);
  assert.equal(x.econ.balance('Rook'), 4);
});

await t('persistence: atomic file, reload gives the same state', async () => {
  const f = path.join(E.dir, 'economy', 'world-20261121-000000.json');
  assert.ok(fs.existsSync(f)); assert.ok(!fs.existsSync(`${f}.tmp`));
  const again = new Economy({ dataDir: E.dir, rcon: mc.rcon, knownNames: () => ['Ash', 'Flint'], propsFile: E.propsFile, catalogFile: CATALOG, timers: false, now: () => E.clock.t });
  assert.deepEqual(again.state().wallets, econ.state().wallets);
  assert.equal(again.history(null, 500).length, econ.history(null, 500).length);
});

await t('world reset: new level-name -> fresh economy; old world kept on disk', async () => {
  const events = [];
  econ.on('econ', (m) => events.push(m));
  const oldWallets = econ.state().wallets;
  fs.writeFileSync(E.propsFile, 'motd=x\nlevel-name=worlds/world-20261122-090000\n');
  const st = econ.state('Ash');
  assert.equal(st.world, 'world-20261122-090000');
  assert.deepEqual(st.wallets, { Robin: 100, Ash: 100, Flint: 100 });
  assert.equal(st.listings.length, 0); assert.equal(st.auctions.length, 0);
  assert.ok(events.some((m) => m.kind === 'reset' && m.world === 'world-20261122-090000'));
  await econ.shopBuy({ who: 'Ash', item: 'bread', count: 1 });
  assert.ok(fs.existsSync(path.join(E.dir, 'economy', 'world-20261122-090000.json')));
  fs.writeFileSync(E.propsFile, 'motd=x\nlevel-name=worlds/world-20261121-000000\n# back\n');
  assert.deepEqual(econ.state().wallets, oldWallets, 'switching back loads the old world');
});

await t('live events carry rev and kinds', async () => {
  const ev = [];
  econ.on('econ', (m) => ev.push(m));
  mc.put('Ash', 'iron_ingot', 2);
  await econ.list({ who: 'Ash', item: 'iron_ingot', count: 2, price: 9 });
  const kinds = ev.map((m) => m.kind);
  assert.ok(kinds.includes('listing') && kinds.includes('tx'));
  for (let i = 1; i < ev.length; i++) assert.equal(ev[i].rev, ev[i - 1].rev + 1);
});

await t('bookkeeping failure after clear returns the items (no silent loss)', async () => {
  mc.put('Ash', 'lapis_lazuli', 6);
  const orig = econ._tx;
  econ._tx = function (kind, ...a) { if (kind === 'list') { econ._tx = orig; throw new Error('boom'); } return orig.call(this, kind, ...a); };
  await rejects(econ.list({ who: 'Ash', item: 'lapis_lazuli', count: 6, price: 3 }), undefined, /boom/);
  assert.equal(mc.has('Ash', 'lapis_lazuli'), 6, 'items given back');
  assert.ok(!econ.market().some((l) => l.item === 'lapis_lazuli'));
});

await t('unlist while RCON is down: items queued as a pending delivery, then delivered', async () => {
  mc.put('Ash', 'redstone', 4);
  const { listing } = await econ.list({ who: 'Ash', item: 'redstone', count: 4, price: 2 });
  mc.down = true;
  const r = await econ.unlist({ who: 'Ash', id: listing.id });
  assert.equal(r.delivered, false);
  assert.equal(econ.state('Ash').deliveries[0].count, 4);
  await econ.tick({ forceDeliveries: true }); // still down: stays queued
  assert.equal(econ.state('Ash').deliveries.length, 1);
  mc.down = false;
  await econ.tick({ forceDeliveries: true });
  assert.equal(econ.state('Ash').deliveries.length, 0);
  assert.equal(mc.has('Ash', 'redstone'), 4);
});

await t('market news: new listings/auctions batched ~20 s, ONE message per bot, never to the seller or the human', async () => {
  const x = makeEcon({ names: ['Ash', 'Flint', 'Rook'] });
  x.mc.online = new Set(['Ash', 'Flint', 'Rook', 'robin_mc']);
  x.mc.put('Ash', 'oak_log', 16); x.mc.put('robin_mc', 'diamond', 2); x.mc.put('Flint', 'diamond_sword', 1);
  const a = await x.econ.list({ who: 'Ash', item: 'oak_log', count: 16, price: 3 });
  const b = await x.econ.list({ who: 'robin_mc', item: 'diamond', count: 2, price: 110 });
  const c = await x.econ.createAuction({ who: 'Flint', item: 'diamond_sword', count: 1, start: 40, minutes: 15 });
  x.notes.length = 0; // (start-balance etc. are not market news)
  x.clock.t += 19_000; await x.econ.tick();
  assert.equal(x.notes.length, 0, 'nothing before the batch window ends');
  x.clock.t += 1_000; await x.econ.tick();
  const to = (n) => x.notes.filter((m) => m.to === n);
  assert.deepEqual(x.notes.map((m) => m.to).sort(), ['Ash', 'Flint', 'Rook'], 'one message per bot, none to the human');
  for (const n of ['Ash', 'Flint', 'Rook']) assert.equal(to(n).length, 1);
  const L = `Ash 16 oak_log @3 (#${a.listing.id})`, D = `Robin 2 diamond @110 (#${b.listing.id})`, A = `auction #${c.auction.id} by Flint: 1 diamond_sword, start 40, ends 15m`;
  assert.equal(to('Rook')[0].text, `new listings: ${L}, ${D} — market_buy {id} | new auctions: ${A} — auction_bid {id, amount}`);
  assert.ok(!to('Ash')[0].text.includes(L) && to('Ash')[0].text.includes(D) && to('Ash')[0].text.includes(A), 'Ash: not their own listing');
  assert.ok(!to('Flint')[0].text.includes('new auctions') && to('Flint')[0].text.includes(L), 'Flint: not their own auction');
  // nothing new -> nothing sent; a batch with only the receiver's own items -> no message to them
  x.notes.length = 0; x.clock.t += 30_000; await x.econ.tick();
  assert.equal(x.notes.length, 0);
  x.mc.put('Rook', 'cobblestone', 64);
  for (let i = 0; i < 8; i++) await x.econ.list({ who: 'Rook', item: 'cobblestone', count: 8, price: 1 + i });
  x.clock.t += 20_000; await x.econ.tick();
  assert.deepEqual(x.notes.map((m) => m.to).sort(), ['Ash', 'Flint']);
  assert.match(x.notes[0].text, /^new listings: (Rook 8 cobblestone @\d \(#\d+\), ){5}Rook 8 cobblestone @6 \(#\d+\) \+2 more — market_buy \{id\}$/);
  x.econ.close();
});

econ.close();

// ------------------------------------------------------------------------------------------ 2. hub integration
console.log('hub /econ + ws + commands');
const { createApp } = await import('../bridge/hub/app.js');
const mock = await import('./hub-mock-engine.mjs');
const { WebSocket } = await import('ws');
const PORT = Number(process.env.HIVE_ECON_TEST_PORT) || 47977;
const BASE = `http://127.0.0.1:${PORT}`;
const hubDir = path.join(tmp, 'hub');
fs.mkdirSync(hubDir, { recursive: true });
const hubProps = path.join(hubDir, 'server.properties');
fs.writeFileSync(hubProps, 'level-name=worlds/world-hub-test\n');
const hmc = new FakeMC();
hmc.online = new Set(['robin_mc']);
const app = createApp({ engine: mock, dataDir: hubDir, port: PORT, econOpts: { rcon: hmc.rcon, propsFile: hubProps, catalogFile: CATALOG, timers: false } });
await app.start();
const api = async (method, p, body) => {
  const r = await fetch(BASE + p, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, json: await r.json() };
};

await t('HTTP: state, catalog, buy, errors', async () => {
  let r = await api('GET', '/econ/state?who=Robin');
  assert.equal(r.status, 200); assert.equal(r.json.me.balance, 100); assert.equal(r.json.world, 'world-hub-test');
  r = await api('GET', '/econ/catalog?item=log');
  assert.ok(r.json.items.every((i) => i.item.includes('log') || i.cat.includes('log')) && r.json.items.length >= 6);
  r = await api('POST', '/econ/shop/buy', { who: 'Robin', item: 'bread', count: 2 });
  assert.equal(r.status, 200); assert.equal(r.json.balance, 88);
  r = await api('POST', '/econ/buy', { who: 'Robin', item: 'diamond' });
  assert.equal(r.status, 409); assert.equal(r.json.ok, false); assert.match(r.json.error, /not enough coins: have 88, need 120/);
  r = await api('POST', '/econ/pay', { who: 'Robin', to: 'Ghost', amount: 1 });
  assert.equal(r.status, 404);
  r = await api('GET', '/econ/history?who=Robin');
  assert.equal(r.json.tx[0].kind, 'shop_buy');
});

await t('ws topic econ: init.econ + live events', async () => {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/mod`);
  const got = [];
  ws.on('message', (d) => got.push(JSON.parse(String(d))));
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  ws.send(JSON.stringify({ t: 'hello', player: 'Robin', want: ['econ'] }));
  await new Promise((r) => setTimeout(r, 100));
  const init = got.find((m) => m.t === 'init');
  assert.ok(init?.econ && init.econ.me.name === 'Robin', 'init has econ');
  hmc.put('robin_mc', 'oak_log', 8);
  const r = await api('POST', '/econ/list', { who: 'Robin', item: 'oak_log', count: 8, price: 3 });
  assert.equal(r.status, 200);
  await new Promise((res) => setTimeout(res, 100));
  const ev = got.filter((m) => m.t === 'econ');
  assert.ok(ev.some((m) => m.kind === 'listing' && m.listing.item === 'oak_log'));
  assert.ok(!got.some((m) => m.t === 'bots'), 'want filter respected');
  ws.close();
});

await t('terminal commands: bal, shop, buy, sell, market, list, unlist, myshop, auction, bid, econ', async () => {
  const cmd = async (text) => (await api('POST', '/mod/command', { text })).json;
  const txt = (r) => r.lines.map((l) => l.map((s) => s.text).join('')).join('\n');
  let r = await cmd('bal');
  assert.ok(r.ok); assert.match(txt(r), /Robin: 88¢/);
  r = await cmd('shop bread');
  assert.match(txt(r), /bread.*buy 6¢.*sell 2¢/);
  r = await cmd('buy oak log 2');
  assert.ok(r.ok, txt(r)); assert.match(txt(r), /bought 2 oak log for 8¢/);
  r = await cmd('buy diamond');
  assert.equal(r.ok, false); assert.match(txt(r), /not enough coins/);
  hmc.put('robin_mc', 'rotten_flesh', 4);
  r = await cmd('sell rotten_flesh 10');
  assert.ok(r.ok); assert.match(txt(r), /sold 4 rotten flesh for 4¢/);
  r = await cmd('market');
  assert.match(txt(r), /8 oak log/);
  const lidH = r.data.listings[0].id;
  r = await cmd('myshop Robin Mart');
  assert.match(txt(r), /Robin Mart/);
  hmc.put('robin_mc', 'stone', 5);
  r = await cmd('list stone 5 4');
  assert.ok(r.ok, txt(r)); assert.match(txt(r), /listed #\d+ 5 stone at 4¢/);
  r = await cmd(`unlist ${lidH}`);
  assert.ok(r.ok, txt(r));
  r = await cmd('buyl 1');
  assert.equal(r.ok, false);
  hmc.put('robin_mc', 'emerald', 1);
  r = await cmd('auction emerald 1 20 10');
  assert.ok(r.ok, txt(r));
  r = await cmd('auctions');
  assert.match(txt(r), /1 emerald.*start 20¢/);
  r = await cmd(`bid ${r.data.auctions[0].id} 25`);
  assert.equal(r.ok, false); assert.match(txt(r), /your own/);
  r = await cmd('pay nobody 5');
  assert.equal(r.ok, false); assert.match(txt(r), /unknown player/);
  r = await cmd('econ');
  assert.ok(r.ok); assert.match(txt(r), /Economy/);
  r = await cmd('list');
  assert.equal(r.ok, false); assert.match(txt(r), /usage: list/);
});

await t('Market notifications land in hub messages', async () => {
  // a bot account: a mock bot named Ash, online in the fake MC
  await api('POST', '/bots', { name: 'Ash' });
  hmc.online.add('Ash');
  const m = (await api('GET', '/econ/market')).json.listings.find((l) => l.item === 'stone');
  const r = await api('POST', '/econ/market/buy', { who: 'Ash', id: m.id, count: 2 });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const msgs = (await api('GET', '/messages')).json.messages;
  assert.ok(msgs.some((x) => x.from === 'Market' && x.to === 'Robin' && /Ash bought 2 stone/.test(x.text)));
});

await app.close();
await t('the real rcon() defaults to the dead test port (never the live 25591)', async () => {
  const { rcon } = await import('../bridge/hub/rcon.js');
  const { rconOpts } = await import('../bridge/config.js');
  assert.equal(rconOpts().port, 1);
  await assert.rejects(rcon('list', { timeoutMs: 2000 }));
  await assert.rejects(rcon('list', { port: 25591, timeoutMs: 2000 }), /blocked/); // the guard itself works
  liveConnects.length = 0; // (that one was on purpose)
});
await t('no TCP connect to a live Minecraft / RCON / bridge port happened', () => assertNoLiveConnects());

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(process.exitCode || 0);
