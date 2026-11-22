// MCP-level test of the economy tools (mcp/econ-tools.js via mcp/mc-mcp.js) against a fake bridge with /econ/* routes
// shaped like MOD_PROTOCOL.md §5. Offline: no Minecraft, no RCON.   node test/econ-tools-test.mjs
import './neutral-player.mjs'; // neutral human player (Robin / robin_mc), set before the bridge reads config
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
process.env.HIVE_EARNINGS_POLL = '0'; // tests never poll a live Minecraft server (earnings scoreboards/time)

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 47973;
let fails = 0;
const ok = (c, msg) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${msg}`); if (!c) fails++; };

// ---------- fake bridge ----------
const E = { wallets: { Ash: 100, Flint: 100, Robin: 100 }, inv: { Ash: { cobblestone: 3, diamond: 2 }, Flint: { oak_log: 32 } }, shops: [], listings: [], auctions: [], tx: [], nextId: 1, calls: [] };
const CATALOG = [{ item: 'bread', buy: 6, sell: 2, cat: 'food' }, { item: 'cobblestone', buy: 2, sell: 1, cat: 'blocks' }, { item: 'iron_ingot', buy: 12, sell: 5, cat: 'ores' }, { item: 'rotten_flesh', buy: null, sell: 1, cat: 'mob drops' }];
const fail = (status, error) => { const e = new Error(error); e.status = status; throw e; };
const take = (who, item, count) => { const have = E.inv[who]?.[item] || 0; if (!have) fail(409, `you have no ${item} in your inventory`); const k = Math.min(have, count); E.inv[who][item] -= k; return k; };
const give = (who, item, k) => { (E.inv[who] ||= {})[item] = (E.inv[who][item] || 0) + k; };
const tx = (o) => { const t = { id: E.nextId++, ts: Date.now(), ...o }; E.tx.unshift(t); return t; };
const spend = (who, amt) => { if (E.wallets[who] < amt) fail(409, `not enough coins: have ${E.wallets[who]}, need ${amt}`); E.wallets[who] -= amt; };
const intOk = (v, what) => { if (!Number.isInteger(v) || v < 1) fail(400, `${what} must be a whole number of at least 1`); return v; };
function econ(m, p, q, b) {
  const who = b.who ?? q.get('who');
  if (who) E.calls.push({ path: p, who });
  switch (`${m} ${p}`) {
    case 'GET /econ/state': return { ok: true, currency: 'coins', me: who ? { name: who, balance: E.wallets[who], held: E.auctions.filter((a) => a.bidder === who && !a.ended).reduce((s, a) => s + a.bid, 0) } : undefined, wallets: E.wallets, shop: CATALOG, shops: E.shops, listings: E.listings, auctions: E.auctions, tx: E.tx.filter((t) => !who || t.from === who || t.to === who).slice(0, 50), deliveries: [] };
    case 'GET /econ/catalog': { const f = q.get('item'); return { ok: true, currency: 'coins', items: CATALOG.filter((x) => !f || x.item.includes(f)) }; }
    case 'POST /econ/pay': {
      if (!E.wallets[b.to] && E.wallets[b.to] !== 0) fail(404, `no account named "${b.to}"`);
      intOk(b.amount, 'amount'); spend(who, b.amount); E.wallets[b.to] += b.amount;
      return { ok: true, balance: E.wallets[who], tx: tx({ kind: 'pay', from: who, to: b.to, amount: b.amount, note: b.note }) };
    }
    case 'POST /econ/shop/buy': {
      const it = CATALOG.find((x) => x.item === b.item); if (!it) fail(404, `unknown item "${b.item}"`); if (it.buy == null) fail(409, `the server shop does not sell ${b.item}`);
      const cost = it.buy * b.count; spend(who, cost); give(who, b.item, b.count);
      return { ok: true, item: b.item, count: b.count, cost, balance: E.wallets[who], tx: tx({ kind: 'shop_buy', from: who, to: 'Server', amount: cost, item: b.item, count: b.count }) };
    }
    case 'POST /econ/shop/sell': {
      const it = CATALOG.find((x) => x.item === b.item); if (!it) fail(404, `unknown item "${b.item}"`);
      const k = take(who, b.item, b.count); const earned = k * it.sell; E.wallets[who] += earned;
      return { ok: true, item: b.item, count: k, earned, balance: E.wallets[who], tx: tx({ kind: 'shop_sell', from: 'Server', to: who, amount: earned, item: b.item, count: k }) };
    }
    case 'GET /econ/shops': return { ok: true, shops: E.shops };
    case 'POST /econ/shops': {
      let s = E.shops.find((x) => x.owner === who); if (!s) E.shops.push((s = { owner: who, created: Date.now(), listings: 0 }));
      s.name = b.name; s.description = b.description || ''; return { ok: true, shop: s };
    }
    case 'POST /econ/list': {
      intOk(b.price, 'price'); const k = take(who, b.item, b.count);
      const l = { id: E.nextId++, seller: who, shop: E.shops.find((x) => x.owner === who)?.name || null, item: b.item, count: k, price: b.price, ts: Date.now() };
      E.listings.push(l); return { ok: true, listing: l, removed: k };
    }
    case 'POST /econ/unlist': {
      const l = E.listings.find((x) => x.id === b.id); if (!l) fail(404, `no listing #${b.id}`); if (l.seller !== who) fail(409, `listing #${b.id} is not yours`);
      E.listings = E.listings.filter((x) => x !== l); give(who, l.item, l.count); return { ok: true, id: l.id, returned: l.count, delivered: true };
    }
    case 'GET /econ/market': { const f = q.get('item'), s = q.get('seller'); return { ok: true, listings: E.listings.filter((l) => (!f || l.item.includes(f)) && (!s || l.seller === s)).sort((x, y) => x.price - y.price) }; }
    case 'POST /econ/market/buy': {
      const l = E.listings.find((x) => x.id === b.id); if (!l) fail(404, `no listing #${b.id}`); if (l.seller === who) fail(409, 'you can\'t buy your own listing');
      const k = b.count ?? l.count; if (k > l.count) fail(409, `listing #${l.id} has only ${l.count} left`);
      const cost = k * l.price; spend(who, cost); E.wallets[l.seller] += cost; l.count -= k; give(who, l.item, k);
      if (!l.count) E.listings = E.listings.filter((x) => x !== l);
      return { ok: true, listing: l, count: k, cost, balance: E.wallets[who], delivered: false, tx: tx({ kind: 'market_buy', from: who, to: l.seller, amount: cost, item: l.item, count: k }) };
    }
    case 'GET /econ/auctions': return { ok: true, auctions: E.auctions };
    case 'POST /econ/auction': {
      if (!(b.minutes >= 1 && b.minutes <= 1440)) fail(400, 'minutes must be 1-1440');
      const k = take(who, b.item, b.count);
      const a = { id: E.nextId++, seller: who, item: b.item, count: k, start: b.start, bid: null, bidder: null, bids: 0, minNext: b.start, created: Date.now(), endsAt: Date.now() + b.minutes * 60000, status: 'open', ended: false, winner: null };
      E.auctions.push(a); return { ok: true, auction: a, removed: k };
    }
    case 'POST /econ/bid': {
      const a = E.auctions.find((x) => x.id === b.id); if (!a) fail(404, `no auction #${b.id}`); if (a.seller === who) fail(409, 'you can\'t bid on your own auction');
      if (b.amount < a.minNext) fail(409, `bid too low: minimum next bid on auction #${a.id} is ${a.minNext}`);
      spend(who, b.amount); if (a.bidder) E.wallets[a.bidder] += a.bid;
      Object.assign(a, { bid: b.amount, bidder: who, bids: a.bids + 1, minNext: b.amount + Math.max(1, Math.ceil(b.amount * 0.05)) });
      return { ok: true, auction: a, balance: E.wallets[who] };
    }
  }
  return null;
}
const ACTIONS = [{ name: 'wait', description: 'Wait N seconds.', params: { type: 'object', properties: { seconds: { type: 'number' } } } }];
const server = http.createServer((req, res) => {
  let body = ''; req.on('data', (c) => (body += c));
  req.on('end', () => {
    const u = new URL(req.url, 'http://x'); const p = u.pathname; let b = {}; try { b = body ? JSON.parse(body) : {}; } catch {}
    const send = (code, o) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
    try {
      if (p === '/actions') return send(200, ACTIONS);
      if (p === '/bots') return send(200, [{ name: 'Ash' }, { name: 'Flint' }]);
      if (/^\/bots\/[^/]+\/state$/.test(p)) return send(200, { name: 'Ash', pos: { x: 0, y: 64, z: 0 }, health: 20, food: 20 });
      if (p.startsWith('/unread/')) return send(200, { count: 0 });
      if (p.startsWith('/msg/')) return send(200, { messages: [], cursor: 0 });
      if (p.startsWith('/econ/')) { const r = econ(req.method, p, u.searchParams, b); if (r) return send(200, r); }
      send(404, { ok: false, error: `mock: no route ${req.method} ${p}` });
    } catch (e) { send(e.status || 500, { ok: false, error: e.message }); }
  });
});
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

// ---------- MCP client ----------
const client = new Client({ name: 'econ-test', version: '0' });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(root, 'mcp', 'mc-mcp.js')], env: { ...process.env, HIVE_BOT: 'Ash', HIVE_URL: `http://127.0.0.1:${PORT}` }, stderr: 'pipe' }));
const call = async (name, args = {}) => { const r = await client.callTool({ name, arguments: args }); return { err: !!r.isError, text: r.content.map((c) => c.text).join('\n') }; };
const first = (t) => t.split('\n').filter((l) => !l.startsWith('📭')).join(' | ');

const { tools } = await client.listTools();
const names = tools.map((t) => t.name);
const ECON = ['wallet', 'pay', 'shop_catalog', 'shop_buy', 'shop_sell', 'market', 'market_list', 'market_unlist', 'market_buy', 'my_shop', 'auctions', 'auction_start', 'auction_bid'];
ok(ECON.every((n) => names.includes(n)), `all ${ECON.length} econ tools listed (missing: ${ECON.filter((n) => !names.includes(n)).join(',') || 'none'})`);
ok(['wait', 'send_message', 'check_messages', 'view'].every((n) => names.includes(n)), 'engine, team and viewer tools still listed');
ok(tools.find((t) => t.name === 'pay').inputSchema.required.join() === 'to,amount', 'pay schema requires to, amount');

let r = await call('wallet');
ok(!r.err && /100 coins/.test(r.text) && /no transactions/.test(r.text), 'wallet: ' + first(r.text));
r = await call('shop_catalog', { filter: 'iron' });
ok(!r.err && /iron_ingot: buy 12 \/ sell 5/.test(r.text) && !/bread/.test(r.text), 'shop_catalog filter: ' + first(r.text));
r = await call('shop_catalog', { filter: 'food' });
ok(!r.err && /bread/.test(r.text), 'shop_catalog falls back to category: ' + first(r.text));
r = await call('shop_buy', { item: 'Bread', count: 2 });
ok(!r.err && /Bought 2 bread .* 12 coins/.test(r.text) && /balance: 88 coins/.test(r.text), 'shop_buy (case-normalised id) + balance: ' + first(r.text));
r = await call('shop_buy', { item: 'iron_ingot', count: 50 });
ok(r.err && /not enough coins: have 88, need 600/.test(r.text) && /shop_sell|market_list/.test(r.text), 'shop_buy no funds -> actionable error: ' + first(r.text));
r = await call('shop_sell', { item: 'minecraft:cobblestone', count: 10 });
ok(!r.err && /Sold 3 cobblestone/.test(r.text) && /only had 3/.test(r.text) && /balance: 91/.test(r.text), 'shop_sell partial: ' + first(r.text));
r = await call('shop_sell', { item: 'cobblestone', count: 1 });
ok(r.err && /no cobblestone in your inventory/.test(r.text) && /inventory/.test(r.text), 'shop_sell nothing -> hint: ' + first(r.text));
r = await call('shop_buy', { item: 'unobtainium' });
ok(r.err && /unknown item/.test(r.text) && /shop_catalog/.test(r.text), 'unknown item -> hint: ' + first(r.text));

r = await call('pay', { to: 'Flint', amount: 10, note: 'house at 40,70,10' });
ok(!r.err && /Paid 10 coins to Flint/.test(r.text) && /balance: 81/.test(r.text), 'pay: ' + first(r.text));
r = await call('pay', { to: 'Flint', amount: '5' });
ok(!r.err && /Paid 5 coins/.test(r.text), 'pay with numeric string amount');
r = await call('pay', { to: 'Flint', amount: 2.5 });
ok(r.err && /whole number/.test(r.text), 'pay fractional refused by backend: ' + first(r.text));
r = await call('pay', { to: 'Nobody', amount: 1 });
ok(r.err && /no account/.test(r.text) && /Robin/.test(r.text), 'pay unknown -> hint: ' + first(r.text));

r = await call('my_shop');
ok(!r.err && /no shop yet/.test(r.text) && /balance: 76/.test(r.text), 'my_shop empty: ' + first(r.text));
r = await call('my_shop', { name: "Ash's Gems", description: 'diamonds' });
ok(!r.err && /Ash's Gems/.test(r.text), 'my_shop open: ' + first(r.text));
r = await call('market_list', { item: 'diamond', count: 1, price_each: 40 });
const lid = Number(/#(\d+)/.exec(r.text)?.[1]);
ok(!r.err && /Listed #\d+: 1 diamond @ 40 each in Ash's Gems/.test(r.text) && /balance: 76/.test(r.text), 'market_list: ' + first(r.text));
const flintList = { id: E.nextId++, seller: 'Flint', shop: "Flint's Lumber", item: 'oak_log', count: 32, price: 2, ts: Date.now() };
E.listings.push(flintList); E.inv.Flint.oak_log = 0;
r = await call('market');
ok(!r.err && r.text.indexOf('oak_log') < r.text.indexOf('diamond') && /YOURS/.test(r.text) && /Flint \(Flint's Lumber\)/.test(r.text), 'market cheapest first, own marked: ' + first(r.text));
r = await call('market', { item: 'log' });
ok(!r.err && /oak_log/.test(r.text) && !/diamond/.test(r.text), 'market item filter');
r = await call('market_buy', { id: flintList.id, count: 10 });
ok(!r.err && /Bought 10 oak_log from Flint .* 20 coins/.test(r.text) && /queued/.test(r.text) && /balance: 56/.test(r.text), 'market_buy (+offline delivery note): ' + first(r.text));
r = await call('market_buy', { id: flintList.id, count: 50 });
ok(r.err && /only 22 left/.test(r.text) && /market/.test(r.text), 'market_buy too many -> hint: ' + first(r.text));
r = await call('market_buy', { id: lid });
ok(r.err && /own listing/.test(r.text), 'market_buy own -> refused: ' + first(r.text));
r = await call('my_shop');
ok(!r.err && /Your shop: "Ash's Gems"/.test(r.text) && /1 diamond @ 40/.test(r.text), 'my_shop shows listings: ' + first(r.text));
r = await call('market_unlist', { id: String(lid) });
ok(!r.err && new RegExp(`#${lid} removed; 1 item returned`).test(r.text) && E.inv.Ash.diamond === 2, 'market_unlist (string id): ' + first(r.text));

r = await call('auction_start', { item: 'diamond', count: 2, start_price: 30, minutes: 10 });
const aid = Number(/#(\d+)/.exec(r.text)?.[1]);
ok(!r.err && /Auction #\d+ started: 2 diamond, start 30, 10m left/.test(r.text), 'auction_start: ' + first(r.text));
r = await call('auction_start', { item: 'diamond', count: 1, start_price: 30, minutes: 5000 });
ok(r.err && /1-1440/.test(r.text), 'auction_start bad minutes: ' + first(r.text));
r = await call('auction_bid', { id: aid, amount: 35 });
ok(r.err && /own auction/.test(r.text), 'bid on own auction refused: ' + first(r.text));
const fl = { id: E.nextId++, seller: 'Flint', item: 'netherite_ingot', count: 1, start: 20, bid: null, bidder: null, bids: 0, minNext: 20, created: Date.now(), endsAt: Date.now() + 300000, status: 'open', ended: false, winner: null };
E.auctions.push(fl);
r = await call('auction_bid', { id: fl.id, amount: 10 });
ok(r.err && /minimum next bid .* is 20/.test(r.text) && /auctions/.test(r.text), 'bid too low -> hint: ' + first(r.text));
r = await call('auction_bid', { id: fl.id, amount: 25 });
ok(!r.err && new RegExp(`lead auction #${fl.id} \\(1 netherite_ingot\\) with 25 coins`).test(r.text) && /balance: 31/.test(r.text), 'auction_bid: ' + first(r.text));
r = await call('auctions');
ok(!r.err && /2 diamond by YOU — no bids \(start 30\)/.test(r.text) && /bid 25 by YOU; min next bid 27/.test(r.text), 'auctions list: ' + first(r.text));
r = await call('wallet');
ok(!r.err && /31 coins \(\+25 held/.test(r.text) && /-20 market_buy 10 oak_log to Flint/.test(r.text) && /-10 pay to Flint "house at 40,70,10"/.test(r.text), 'wallet balance/held/tx: ' + first(r.text));

ok(E.calls.length > 20 && E.calls.every((x) => x.who === 'Ash'), `every econ call passed who=Ash (${E.calls.length} calls)`);

server.close(); server.closeAllConnections?.();
r = await call('wallet');
ok(r.err && /not reachable|refused/i.test(r.text), 'bridge down -> clean error: ' + first(r.text));
await client.close();

// =====================================================================================================================
// PHASE 2: the same tools against the REAL hub + bridge/hub/economy.js (mock engine, fake RCON, temp data dir, spare port)
// =====================================================================================================================
console.log('\n--- phase 2: real hub + economy.js (fake RCON) ---');
const fs = await import('node:fs'); const os = await import('node:os');
const { createApp } = await import('../bridge/hub/app.js');
const mockEngine = await import('./hub-mock-engine.mjs');
const CAT = JSON.parse(fs.readFileSync(path.join(root, 'data', 'econ-catalog.json'), 'utf8'));
const price = (it) => CAT.items[it];
const START = CAT.startBalance ?? 100;
// fake Minecraft behind RCON: inventories + who is online (same replies as vanilla 1.21)
const MC = { inv: new Map(), online: new Set(['Ash', 'Flint']), cmds: [] };
const has = (p, it) => MC.inv.get(p)?.get(it) || 0;
const put = (p, it, k) => { const m = MC.inv.get(p) || (MC.inv.set(p, new Map()), MC.inv.get(p)); m.set(it, (m.get(it) || 0) + k); };
const fakeRcon = async (cmd) => {
  MC.cmds.push(cmd);
  const w = cmd.split(' ');
  if (w[0] === 'list') return `There are ${MC.online.size} of a max of 20 players online: ${[...MC.online].join(', ')}`;
  const [op, pl, raw, ns] = w; const it = String(raw).replace('minecraft:', ''); const k = Number(ns);
  if (!MC.online.has(pl)) return 'No player was found';
  if (op === 'give') { put(pl, it, k); return `Gave ${k} [${it}] to ${pl}`; }
  if (op === 'clear') { const t = Math.min(has(pl, it), k); if (!t) return `No items were found on player ${pl}`; MC.inv.get(pl).set(it, has(pl, it) - t); return `Removed ${t} item(s) from player ${pl}`; }
  return 'Unknown command';
};
const HPORT = 47978, HB = `http://127.0.0.1:${HPORT}`;
const hubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-econtools-'));
const props = path.join(hubDir, 'server.properties');
fs.writeFileSync(props, 'level-name=worlds/world-econtools-test\n');
const hub = createApp({ engine: mockEngine, dataDir: hubDir, port: HPORT, econOpts: { rcon: fakeRcon, propsFile: props, catalogFile: path.join(root, 'data', 'econ-catalog.json'), timers: false } });
await hub.start();
const api = async (method, p, body) => (await fetch(HB + p, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })).json();
await api('POST', '/bots', { name: 'Ash' }); await api('POST', '/bots', { name: 'Flint' });
put('Ash', 'rotten_flesh', 3); put('Ash', 'diamond', 2); put('Ash', 'cobblestone', 5); put('Flint', 'oak_log', 32); put('Flint', 'iron_ingot', 4);

const c2 = new Client({ name: 'econ-test-real', version: '0' });
await c2.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(root, 'mcp', 'mc-mcp.js')], env: { ...process.env, HIVE_BOT: 'Ash', HIVE_URL: HB }, stderr: 'pipe' }));
const call2 = async (name, args = {}) => { const x = await c2.callTool({ name, arguments: args }); return { err: !!x.isError, text: x.content.map((q) => q.text).join('\n') }; };
const noRoutes = (t) => !/(GET|POST) \/econ/.test(t);
let bal = START;
const balIs = (t) => new RegExp(`balance: ${bal} coins`).test(t);

r = await call2('wallet');
ok(!r.err && new RegExp(`💰 ${START} coins`).test(r.text), 'R wallet: ' + first(r.text));
r = await call2('shop_catalog', { filter: 'iron' });
ok(!r.err && new RegExp(`iron_ingot: buy ${price('iron_ingot').buy} / sell ${price('iron_ingot').sell}`).test(r.text), 'R shop_catalog: ' + first(r.text).slice(0, 160));
r = await call2('shop_catalog', { filter: 'food' });
ok(!r.err && /bread/.test(r.text), 'R shop_catalog category fallback');
r = await call2('shop_buy', { item: 'Bread', count: 2 }); bal -= 2 * price('bread').buy;
ok(!r.err && /Bought 2 bread/.test(r.text) && balIs(r.text) && has('Ash', 'bread') === 2, 'R shop_buy (items given via RCON): ' + first(r.text));
r = await call2('shop_buy', { item: 'diamond', count: 5 });
ok(r.err && /not enough coins/.test(r.text) && /shop_sell|market_list/.test(r.text), 'R shop_buy no funds -> hint: ' + first(r.text));
r = await call2('shop_sell', { item: 'rotten_flesh', count: 10 }); bal += 3 * price('rotten_flesh').sell;
ok(!r.err && /Sold 3 rotten_flesh/.test(r.text) && /only had 3/.test(r.text) && balIs(r.text) && has('Ash', 'rotten_flesh') === 0, 'R shop_sell partial (note): ' + first(r.text));
r = await call2('shop_sell', { item: 'cobblestone', count: 1 });
ok(r.err && /doesn't buy cobblestone/.test(r.text) && /market_list/.test(r.text) && noRoutes(r.text), 'R shop_sell not bought -> tool names, no HTTP routes: ' + first(r.text));
r = await call2('shop_sell', { item: 'rotten_flesh', count: 1 });
ok(r.err && /no rotten_flesh in your inventory/.test(r.text) && /inventory/.test(r.text), 'R shop_sell nothing: ' + first(r.text));
r = await call2('shop_buy', { item: 'netherite_ingot' });
ok(r.err && /doesn't sell/.test(r.text) && /shop_catalog/.test(r.text) && noRoutes(r.text), 'R shop_buy unknown -> hint: ' + first(r.text));

r = await call2('pay', { to: 'flint', amount: 10, note: 'house at 40,70,10' }); bal -= 10;
ok(!r.err && /Paid 10 coins to Flint/.test(r.text) && balIs(r.text), 'R pay (case-insensitive name): ' + first(r.text));
r = await call2('pay', { to: 'Nobody', amount: 1 });
ok(r.err && /unknown player "Nobody"/.test(r.text) && /Robin/.test(r.text), 'R pay unknown -> hint: ' + first(r.text));
r = await call2('pay', { to: 'Flint', amount: 2.5 });
ok(r.err && /amount/.test(r.text), 'R pay fractional refused: ' + first(r.text));
r = await call2('pay', { to: 'robin_mc', amount: 1 }); bal -= 1;
ok(!r.err && /Paid 1 coin to Robin/.test(r.text) && balIs(r.text), 'R pay to Robin via MC name: ' + first(r.text));

r = await call2('my_shop');
ok(!r.err && /no shop yet|Your shop/.test(r.text) && balIs(r.text), 'R my_shop (none): ' + first(r.text));
r = await call2('my_shop', { name: "Ash's Gems", description: 'diamonds' });
ok(!r.err && /Your shop is now "Ash's Gems" — diamonds/.test(r.text), 'R my_shop open: ' + first(r.text));
r = await call2('market_list', { item: 'diamond', count: 1, price_each: 40 });
const rl = Number(/#(\d+)/.exec(r.text)?.[1]);
ok(!r.err && /Listed #\d+: 1 diamond @ 40 each in Ash's Gems/.test(r.text) && has('Ash', 'diamond') === 1 && balIs(r.text), 'R market_list (escrowed via clear): ' + first(r.text));
const fl2 = await api('POST', '/econ/list', { who: 'Flint', item: 'oak_log', count: 32, price: 2 });
ok(fl2.ok && fl2.listing?.id, 'R Flint lists 32 oak_log via HTTP');
r = await call2('market');
ok(!r.err && r.text.indexOf('oak_log') < r.text.indexOf('diamond') && /YOURS \(Ash's Gems\)/.test(r.text) && /— Flint/.test(r.text), 'R market: ' + first(r.text));
r = await call2('market', { item: 'log' });
ok(!r.err && /oak_log/.test(r.text) && !/diamond/.test(r.text), 'R market filter');
r = await call2('market_buy', { id: fl2.listing.id, count: 10 }); bal -= 20;
ok(!r.err && /Bought 10 oak_log from Flint/.test(r.text) && /20 coins/.test(r.text) && !/queued/.test(r.text) && balIs(r.text) && has('Ash', 'oak_log') === 10, 'R market_buy: ' + first(r.text));
MC.online.delete('Ash');
r = await call2('market_buy', { id: fl2.listing.id, count: 5 }); bal -= 10;
ok(!r.err && /queued/.test(r.text) && balIs(r.text), 'R market_buy while offline -> queued note: ' + first(r.text));
MC.online.add('Ash');
r = await call2('market_buy', { id: fl2.listing.id, count: 500 });
ok(r.err && /17/.test(r.text), 'R market_buy too many: ' + first(r.text));
r = await call2('market_buy', { id: 9999 });
ok(r.err && /no open listing #9999/.test(r.text) && /`market`/.test(r.text) && noRoutes(r.text), 'R market_buy bad id -> tool name: ' + first(r.text));
r = await call2('market_buy', { id: rl });
ok(r.err && /own/.test(r.text), 'R market_buy own refused: ' + first(r.text));
r = await call2('my_shop');
ok(!r.err && /Your shop: "Ash's Gems"/.test(r.text) && /1 diamond @ 40/.test(r.text), 'R my_shop listings: ' + first(r.text));
r = await call2('market_unlist', { id: String(rl) });
ok(!r.err && new RegExp(`#${rl} removed; 1 item returned`).test(r.text) && has('Ash', 'diamond') === 2, 'R market_unlist (items given back): ' + first(r.text));

r = await call2('auction_start', { item: 'diamond', count: 2, start_price: 30, minutes: 10 });
const ra = Number(/#(\d+)/.exec(r.text)?.[1]);
ok(!r.err && /Auction #\d+ started: 2 diamond, start 30, (10m|9m|600s)/.test(r.text) && has('Ash', 'diamond') === 0, 'R auction_start: ' + first(r.text));
r = await call2('auction_start', { item: 'oak_log', count: 1, start_price: 5, minutes: 5000 });
ok(r.err && /minutes|1440/.test(r.text), 'R auction_start bad minutes: ' + first(r.text));
r = await call2('auction_bid', { id: ra, amount: 35 });
ok(r.err && /own/.test(r.text), 'R bid own refused: ' + first(r.text));
const fa = await api('POST', '/econ/auction', { who: 'Flint', item: 'iron_ingot', count: 4, start: 20, minutes: 5 });
ok(fa.ok && fa.auction?.id, 'R Flint auctions 4 iron_ingot via HTTP');
r = await call2('auction_bid', { id: fa.auction.id, amount: 10 });
ok(r.err && /bid too low/.test(r.text) && /20/.test(r.text) && /auctions/.test(r.text), 'R bid too low -> hint: ' + first(r.text));
r = await call2('auction_bid', { id: fa.auction.id, amount: 25 }); bal -= 25;
ok(!r.err && new RegExp(`lead auction #${fa.auction.id} \\(4 iron_ingot\\) with 25 coins`).test(r.text) && balIs(r.text) && /\+25 held/.test(r.text), 'R auction_bid: ' + first(r.text));
r = await call2('auctions');
ok(!r.err && /2 diamond by YOU — no bids \(start 30\)/.test(r.text) && /4 iron_ingot by Flint — bid 25 by YOU; min next bid 27/.test(r.text), 'R auctions: ' + first(r.text));
r = await call2('wallet');
ok(!r.err && new RegExp(`💰 ${bal} coins \\(\\+25 held`).test(r.text) && /pay to Flint "house at 40,70,10"/.test(r.text) && /market_buy/.test(r.text), 'R wallet after everything: ' + first(r.text));
const hist = await api('GET', '/econ/history?who=Ash&limit=100');
ok(hist.ok && hist.tx.length >= 8 && hist.tx.every((t) => t.from === 'Ash' || t.to === 'Ash'), `R backend tx log has Ash's ${hist.tx.length} transactions (who=Ash on every call)`);
// Market notices reach Flint (and BotManager never interrupts for from=Market)
const fm = await api('GET', '/msg/Flint?since=0');
const mk = (fm.messages || []).filter((m) => m.from === 'Market');
ok(mk.length >= 2, 'R Flint got Market notices: ' + mk.map((m) => m.text).join(' | ').slice(0, 220));
await c2.close();
await hub.stop?.();
console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
process.exit(fails ? 1 : 0);
