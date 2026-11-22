// Hivecraft economy: coins, server shop, player shops + market, auctions. One economy per Minecraft world.
// Spec: MOD_PROTOCOL.md §5. Hooked in by app.js:
//   const econ = new Economy({ dataDir, rcon, knownNames, notify });   attachEconRoutes({ route, econ });
//   econ.on('econ', (msg) => ...)   // {kind, rev, ...} live changes (mod-api forwards them as {t:'econ', ...})
//   econ.close()
// Items are real: sell/list/auction take them with RCON `clear`, buys deliver with RCON `give`.
// Every money/escrow operation runs through one promise queue (_run), so nothing double-spends.
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { HttpError, str, log, logErr } from './util.js';
import { econPlayers, serverPropsFile } from '../config.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const SHIPPED_CATALOG = path.join(ROOT, 'data', 'econ-catalog.json');

const MAX_COUNT = 640;
const MAX_PRICE = 1_000_000;
const GIVE_CHUNK = 64;          // give in stacks (unstackables cap at 100 per give)
const MAX_TX_KEEP = 5000;
const ENDED_SHOW_MS = 10 * 60 * 1000;
const TICK_MS = 2000;
const DELIVERY_EVERY_MS = 15000;
const NEWS_BATCH_MS = 20000;   // new listings/auctions are collected this long, then ONE 'Market' message per bot
const NEWS_MAX_ITEMS = 6;
const BANK = 'Bank', SERVER = 'Server', ESCROW = 'Escrow';
const SYSTEM_NAMES = new Set([BANK, SERVER, ESCROW, 'market', 'system', 'all'].map((s) => s.toLowerCase()));

// players: human account name -> Minecraft name. Comes from hivecraft.config.json (player.displayName -> player.mcName);
// a catalog `players` object adds more humans.
const DEFAULT_SETTINGS = { currency: 'coins', startBalance: 100, players: {}, auction: { minIncrementPct: 5, antiSnipeSec: 30, maxMinutes: 1440 } };

export const pretty = (item) => String(item || '').replace(/_/g, ' ');
const bad = (msg) => new HttpError(400, msg);
const notFound = (msg) => new HttpError(404, msg);
const conflict = (msg) => new HttpError(409, msg);

/** 'Oak Log' / 'minecraft:oak_log' -> 'oak_log' */
export function normItem(v) {
  const s = str(v, 80).trim().toLowerCase().replace(/^minecraft:/, '').replace(/[\s-]+/g, '_');
  if (!s) throw bad('item is required (an item id like oak_log)');
  if (!/^[a-z0-9_]{1,64}$/.test(s)) throw bad(`bad item "${str(v, 40)}": use an item id like oak_log`);
  return s;
}

/** whole number in [lo, hi]; dflt when missing (undefined = required) */
export function intArg(v, name, lo, hi, dflt) {
  if (v === undefined || v === null || v === '') {
    if (dflt !== undefined) return dflt;
    throw bad(`${name} is required (a whole number ${lo}-${hi})`);
  }
  const n = Number(v);
  if (!Number.isInteger(n)) throw bad(`${name} must be a whole number (got "${str(v, 20)}")`);
  if (n < lo || n > hi) throw bad(`${name} must be between ${lo} and ${hi} (got ${n})`);
  return n;
}

/** parse RCON `clear <p> <item> <n>` reply -> removed count, or a tagged failure */
export function parseClear(reply) {
  const r = String(reply ?? '');
  let m = /Removed (\d+) item/i.exec(r);
  if (m) return { removed: Number(m[1]) };
  if (/No items were found/i.test(r)) return { removed: 0 };
  if (/No player was found|player not found|That player does not exist/i.test(r)) return { offline: true };
  if (/Unknown item|Unknown or incomplete|Incorrect argument|Invalid/i.test(r)) return { badItem: true, reply: r };
  return { error: r || '(empty reply)' };
}
/** parse RCON `give` reply */
export function parseGive(reply) {
  const r = String(reply ?? '');
  if (/^\s*Gave\b/i.test(r) || /\bGave \d+/i.test(r)) return { ok: true };
  if (/No player was found|player not found/i.test(r)) return { offline: true };
  if (/Unknown item|Unknown or incomplete|Incorrect argument|Invalid/i.test(r)) return { badItem: true, reply: r };
  return { error: r || '(empty reply)' };
}
/** parse RCON `list` reply -> lowercase names online */
export function parseList(reply) {
  const r = String(reply ?? '');
  const i = r.indexOf(':');
  if (i < 0) return new Set();
  return new Set(r.slice(i + 1).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));
}

function readJson(f) {
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return undefined; throw e; }
}

function freshState(world, rev = 0) {
  return { version: 1, world, created: Date.now(), rev, accounts: {}, nextTx: 1, tx: [], shops: {},
    nextListing: 1, listings: [], nextAuction: 1, auctions: [], nextDelivery: 1, deliveries: [] };
}

export class Economy extends EventEmitter {
  /**
   * @param {object} o
   * @param {string} o.dataDir            state goes to <dataDir>/economy/<world>.json
   * @param {(cmd:string)=>Promise<string>} o.rcon  RCON command -> reply text (throws when unreachable)
   * @param {()=>string[]} [o.knownNames] bot names that get accounts
   * @param {(to:string,text:string)=>void} [o.notify] hub message from 'Market'
   * @param {string} [o.propsFile]        server.properties (level-name = world key)
   * @param {string} [o.catalogFile]      default <dataDir>/econ-catalog.json, then the shipped data/econ-catalog.json
   * @param {boolean} [o.timers=true]     auction settle + delivery retry timers
   * @param {()=>number} [o.now]
   * @param {Object<string,string>} [o.players] human account -> MC name (default: the config's player)
   */
  constructor({ dataDir, rcon, knownNames = () => [], notify = () => {}, propsFile, catalogFile, timers = true, now, players } = {}) {
    super();
    if (typeof rcon !== 'function') throw new Error('Economy needs an rcon(cmd) function');
    this.dir = path.join(dataDir, 'economy');
    fs.mkdirSync(this.dir, { recursive: true });
    this.rcon = rcon;
    this.knownNames = knownNames;
    this.notifyFn = notify;
    this.propsFile = propsFile || serverPropsFile();
    this.basePlayers = players && typeof players === 'object' ? { ...players } : econPlayers();
    this._news = [];      // new listings/auctions waiting for the batched bot notice
    this._newsAt = 0;
    this.catalogFiles = catalogFile ? [catalogFile] : [path.join(dataDir, 'econ-catalog.json'), SHIPPED_CATALOG];
    this.now = now || (() => Date.now());
    this._q = Promise.resolve();
    this._propsSig = null;
    this._worldKey = null;
    this._catSig = null;
    this.settings = { ...DEFAULT_SETTINGS, players: { ...this.basePlayers } };
    this.items = new Map();
    this.earnCfg = {};    // `earnings` block of the catalog (earnings.js reads it)
    this.earnings = null; // Earnings instance (set by earnings.js when attached)
    this.s = null;        // current world state
    this.world = null;
    this._lastDelivery = 0;
    this._tickQueued = false;
    this._loadCatalog();
    this._ensureWorld();
    this.timer = null;
    if (timers) {
      this.timer = setInterval(() => this.tick().catch((e) => logErr('econ tick:', e?.message || e)), TICK_MS);
      this.timer.unref?.();
    }
  }

  // ================================================================================ plumbing

  /** serialize every mutating operation */
  _run(fn) {
    const p = this._q.then(() => { this._ensureWorld(); this._loadCatalog(); return fn(); });
    this._q = p.catch(() => { /* not swallowed: the caller gets the error through p; this only keeps the queue going */ });
    return p;
  }

  _readWorldKey() {
    let st;
    try { st = fs.statSync(this.propsFile); } catch { return this._worldKey || 'default'; }
    const sig = `${st.mtimeMs}:${st.size}`;
    if (sig === this._propsSig && this._worldKey) return this._worldKey;
    this._propsSig = sig;
    let key = 'default';
    try {
      const m = /^\s*level-name\s*=\s*(.*?)\s*$/m.exec(fs.readFileSync(this.propsFile, 'utf8'));
      if (m && m[1]) key = m[1].split(/[\\/]/).filter(Boolean).pop() || 'default';
    } catch { /* keep default */ }
    key = key.replace(/[^A-Za-z0-9_.-]/g, '_').replace(/^\.+/, '') || 'default';
    this._worldKey = key;
    return key;
  }

  _file(world = this.world) { return path.join(this.dir, `${world}.json`); }

  /** switch economies when the server's level-name changed (new world from the launcher) */
  _ensureWorld() {
    const key = this._readWorldKey();
    if (key === this.world && this.s) return false;
    const prev = this.world;
    if (prev && this.s) this._save();
    let s;
    try { s = readJson(this._file(key)); } catch (e) {
      logErr(`economy ${key}.json unreadable (${e.message}); keeping a copy and starting fresh`);
      try { fs.copyFileSync(this._file(key), this._file(key) + `.bad-${Date.now()}`); } catch (e2) { logErr(`economy: could not back up bad ${key}.json: ${e2.message}`); }
    }
    this.s = s && typeof s === 'object' && s.accounts ? { ...freshState(key), ...s, world: key } : freshState(key);
    this.world = key;
    if (prev) {
      log(`economy: world changed ${prev} -> ${key} (${s ? 'loaded' : 'fresh economy'})`);
      this._emit('reset', { world: key, state: this.state() });
    } else log(`economy: world ${key} (${s ? 'loaded' : 'fresh'})`);
    return true;
  }

  _save() {
    if (!this.s) return;
    if (this.s.tx.length > MAX_TX_KEEP) this.s.tx = this.s.tx.slice(-MAX_TX_KEEP);
    const f = this._file();
    const tmp = `${f}.tmp`;
    const data = JSON.stringify(this.s);
    for (let i = 0; ; i++) {
      try {
        fs.writeFileSync(tmp, data);
        fs.renameSync(tmp, f);
        return;
      } catch (e) {
        if (i >= 2) { logErr('economy save failed:', e.message); return; }
      }
    }
  }

  _loadCatalog() {
    let file = null, st = null;
    for (const f of this.catalogFiles) { try { st = fs.statSync(f); file = f; break; } catch { /* next */ } }
    const sig = file ? `${file}:${st.mtimeMs}:${st.size}` : 'none';
    if (sig === this._catSig) return;
    this._catSig = sig;
    if (!file) { logErr('economy: no econ-catalog.json found; the server shop is empty'); return; }
    let j;
    try { j = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { logErr(`economy: ${file} is not valid JSON (${e.message}); keeping the previous catalog`); return; }
    const price = (v) => (Number.isInteger(v) && v > 0 && v <= MAX_PRICE ? v : null);
    this.settings = {
      currency: typeof j.currency === 'string' ? j.currency : DEFAULT_SETTINGS.currency,
      startBalance: Number.isInteger(j.startBalance) && j.startBalance >= 0 ? j.startBalance : DEFAULT_SETTINGS.startBalance,
      players: { ...this.basePlayers, ...(j.players && typeof j.players === 'object' && !Array.isArray(j.players) ? j.players : {}) },
      auction: { ...DEFAULT_SETTINGS.auction, ...(j.auction || {}) },
    };
    this.earnCfg = j.earnings && typeof j.earnings === 'object' ? j.earnings : {};
    const items = new Map();
    for (const [k, v] of Object.entries(j.items || {})) {
      let id;
      try { id = normItem(k); } catch { logErr(`economy: catalog item "${k}" is not a valid item id; skipped`); continue; }
      const buy = price(v?.buy), sell = price(v?.sell);
      if (buy === null && sell === null) continue;
      items.set(id, { item: id, buy, sell, cat: str(v?.cat || 'misc', 30) });
    }
    this.items = items;
  }

  _emit(kind, payload = {}) {
    if (this.s) this.s.rev = (this.s.rev || 0) + 1;
    const msg = { kind, rev: this.s?.rev || 0, ...payload };
    try { this.emit('econ', msg); } catch (e) { logErr('econ listener:', e.message); }
  }

  _notify(to, text) {
    if (!to || SYSTEM_NAMES.has(String(to).toLowerCase())) return;
    try { this.notifyFn(to, text); } catch (e) { logErr('econ notify:', e.message); }
  }

  _tx(kind, from, to, amount, extra = {}) {
    const t = { id: this.s.nextTx++, ts: this.now(), kind, from, to, amount };
    for (const k of ['item', 'count', 'note']) if (extra[k] !== undefined && extra[k] !== null && extra[k] !== '') t[k] = extra[k];
    this.s.tx.push(t);
    this._emit('tx', { tx: t });
    return t;
  }

  // ================================================================================ accounts

  /** [[human account name, MC player name]] (from the config player: displayName -> mcName) */
  _humans() { return Object.entries(this.settings.players || {}); }

  /** the (first) human's account name */
  humanName() { return this._humans()[0]?.[0] || 'Player'; }

  mcName(acct) {
    for (const [a, mc] of this._humans()) if (a === acct) return String(mc);
    return acct;
  }

  /** resolve `who` to an account name; throws a clear error for unknown names */
  resolve(who, what = 'who') {
    const s = str(who, 40).trim();
    if (!s) throw bad(`${what} is required: your bot name, or ${this.humanName()}`);
    const l = s.toLowerCase();
    for (const [a, mc] of this._humans()) if (l === a.toLowerCase() || l === String(mc).toLowerCase()) return a;
    let names = [];
    try { names = this.knownNames() || []; } catch (e) { logErr('economy: knownNames failed:', e.message); names = []; }
    const hit = names.find((n) => String(n).toLowerCase() === l) || Object.keys(this.s.accounts).find((n) => n.toLowerCase() === l);
    if (hit) return hit;
    const known = [...new Set([...names, ...this._humans().map(([a]) => a)])];
    throw notFound(`unknown player "${s}": accounts are ${known.join(', ') || 'none yet'}`);
  }

  _acct(name) {
    let a = this.s.accounts[name];
    if (!a) {
      a = this.s.accounts[name] = { balance: 0, created: this.now() };
      const start = this.settings.startBalance;
      if (start > 0) {
        a.balance = start;
        this._tx('start', BANK, name, start, { note: 'starting balance' });
      }
      this._emit('wallet', { who: name, balance: a.balance, held: 0 });
    }
    return a;
  }

  /** make sure every known bot + the human(s) have an account (sync, safe outside the queue) */
  _ensureAccounts() {
    let made = false;
    let names = [];
    try { names = this.knownNames() || []; } catch (e) { logErr('economy: knownNames failed:', e.message); names = []; }
    for (const n of [...this._humans().map(([a]) => a), ...names]) {
      if (!n || SYSTEM_NAMES.has(String(n).toLowerCase()) || this.s.accounts[n]) continue;
      if (Object.keys(this.s.accounts).some((k) => k.toLowerCase() === String(n).toLowerCase())) continue;
      this._acct(n);
      made = true;
    }
    if (made) this._save();
  }

  held(name) {
    return this.s.auctions.filter((a) => a.status === 'open' && a.bidder === name).reduce((s, a) => s + a.bid, 0);
  }

  balance(name) { return this._acct(name).balance; }

  _move(from, to, amount) {
    if (from && !SYSTEM_NAMES.has(from.toLowerCase())) {
      const a = this._acct(from);
      if (a.balance < amount) throw conflict(`not enough coins: have ${a.balance}, need ${amount}`);
      a.balance -= amount;
      this._emit('wallet', { who: from, balance: a.balance, held: this.held(from) });
    }
    if (to && !SYSTEM_NAMES.has(to.toLowerCase())) {
      const b = this._acct(to);
      b.balance += amount;
      this._emit('wallet', { who: to, balance: b.balance, held: this.held(to) });
    }
  }

  _needCoins(name, need, why = '') {
    const have = this._acct(name).balance;
    if (have < need) throw conflict(`not enough coins: have ${have}, need ${need}${why ? ` (${why})` : ''}`);
  }

  // ================================================================================ RCON items

  async _rconCall(cmd) {
    try {
      return await this.rcon(cmd);
    } catch (e) {
      throw new HttpError(502, `Minecraft server not reachable (${e?.message || e}); nothing changed`);
    }
  }

  /**
   * run the bookkeeping after items were taken with clear; if it throws, the items go back to the player
   * (or the delivery queue) and the error is logged and re-thrown.
   */
  async _afterClear(acct, item, removed, op, fn) {
    const snap = JSON.stringify(this.s);
    try { return fn(); } catch (e) {
      logErr(`econ: ${op} by ${acct} failed after taking ${removed} ${item}: ${e?.stack || e}; rolling back and returning the items`);
      const rev = this.s.rev;
      this.s = JSON.parse(snap); // undo half-done bookkeeping (e.g. a listing pushed before the failure)
      this.s.rev = rev;
      await this._deliverOrQueue(acct, item, removed, `${op} failed, items returned`);
      this._save();
      this._emit('resync', { reason: `${op} failed and was rolled back` });
      throw e;
    }
  }

  /** take up to n items from the player's inventory; returns the count actually removed */
  async _clear(acct, item, n) {
    const reply = await this._rconCall(`clear ${this.mcName(acct)} minecraft:${item} ${n}`);
    const r = parseClear(reply);
    if (r.offline) throw conflict(`${acct} is not online in Minecraft, so no items could be taken; try again when in the game`);
    if (r.badItem) throw notFound(`unknown item "${item}" (Minecraft said: ${short(r.reply)})`);
    if (r.error !== undefined) throw new HttpError(502, `unexpected server reply to clear: "${short(r.error)}"; nothing changed`);
    return Math.max(0, Math.min(n, r.removed));
  }

  /**
   * give n items in stacks. Throws 502 only if the very first RCON call can't reach the server.
   * @returns {{given:number, offline:boolean, error:string|null}}
   */
  async _give(acct, item, n, { mustReach = true } = {}) {
    let given = 0;
    while (given < n) {
      const k = Math.min(GIVE_CHUNK, n - given);
      let reply;
      try {
        reply = await this.rcon(`give ${this.mcName(acct)} minecraft:${item} ${k}`);
      } catch (e) {
        if (given === 0 && mustReach) throw new HttpError(502, `Minecraft server not reachable (${e?.message || e}); nothing changed`);
        return { given, offline: false, error: String(e?.message || e) };
      }
      const r = parseGive(reply);
      if (r.ok) { given += k; continue; }
      if (r.offline) return { given, offline: true, error: null };
      if (r.badItem && given === 0) throw notFound(`unknown item "${item}" (Minecraft said: ${short(r.reply)})`);
      return { given, offline: false, error: r.reply || r.error };
    }
    return { given, offline: false, error: null };
  }

  /** deliver items, queueing whatever could not be given now (offline / server down). Never throws. */
  async _deliverOrQueue(acct, item, n, reason) {
    let g;
    try { g = await this._give(acct, item, n, { mustReach: false }); } catch (e) {
      logErr(`econ: give ${n} ${item} to ${acct} (${reason}) failed: ${e.message}; queueing`);
      g = { given: 0, offline: false, error: e.message };
    }
    const left = n - g.given;
    if (left > 0) {
      this.s.deliveries.push({ id: this.s.nextDelivery++, to: acct, item, count: left, reason, ts: this.now() });
      logErr(`econ: delivery of ${left} ${item} to ${acct} (${reason}) queued: ${g.error || (g.offline ? 'player offline' : 'partial give')}`);
    }
    return { given: g.given, queued: left };
  }

  // ================================================================================ views

  catalog(filter) {
    const f = filter ? String(filter).toLowerCase().replace(/^minecraft:/, '').replace(/\s+/g, '_') : '';
    return [...this.items.values()].filter((i) => !f || i.item.includes(f) || i.cat.toLowerCase().includes(f));
  }

  _suggest(item, pred = () => true) {
    const parts = item.split('_').filter((p) => p.length > 2);
    return [...this.items.values()].filter(pred).filter((i) => i.item.includes(item) || item.includes(i.item) || parts.some((p) => i.item.includes(p))).slice(0, 6).map((i) => i.item);
  }

  _minNext(a) {
    if (a.bid === null || a.bid === undefined) return a.start;
    return a.bid + Math.max(1, Math.ceil(a.bid * (Number(this.settings.auction.minIncrementPct) || 5) / 100));
  }

  auctionOut(a) {
    return { id: a.id, seller: a.seller, item: a.item, count: a.count, start: a.start, bid: a.bid ?? null, bidder: a.bidder ?? null,
      bids: a.bids || 0, minNext: this._minNext(a), created: a.created, endsAt: a.endsAt, status: a.status,
      ended: a.status !== 'open', winner: a.winner ?? null, ...(a.endedAt ? { endedAt: a.endedAt } : {}) };
  }

  shopOut(sh) {
    return { owner: sh.owner, name: sh.name, description: sh.description || '', created: sh.created,
      listings: this.s.listings.filter((l) => l.seller === sh.owner).length };
  }

  shops() {
    this._ensureWorld();
    return Object.values(this.s.shops).map((sh) => this.shopOut(sh));
  }

  market({ item, seller } = {}) {
    this._ensureWorld();
    let l = this.s.listings;
    if (item) { const f = String(item).toLowerCase().replace(/^minecraft:/, '').replace(/\s+/g, '_'); l = l.filter((x) => x.item.includes(f)); }
    if (seller) {
      let s = String(seller);
      try { s = this.resolve(s); } catch { /* unknown name: plain compare */ }
      l = l.filter((x) => x.seller.toLowerCase() === s.toLowerCase());
    }
    return [...l].sort((a, b) => a.price - b.price || a.id - b.id).map((x) => ({ ...x }));
  }

  auctions({ all = false } = {}) {
    this._ensureWorld();
    const now = this.now();
    const open = (a) => (a.status === 'open' ? 0 : 1);
    // open ones first (ending soonest first), then ended ones (most recent first)
    return this.s.auctions.filter((a) => all || a.status === 'open' || now - (a.endedAt || 0) < ENDED_SHOW_MS)
      .sort((a, b) => open(a) - open(b) || (open(a) ? (b.endedAt || 0) - (a.endedAt || 0) : a.endsAt - b.endsAt))
      .map((a) => this.auctionOut(a));
  }

  history(who, limit = 50) {
    this._ensureWorld();
    const n = Math.max(1, Math.min(500, Number(limit) || 50));
    const name = who ? this.resolve(who) : null;
    const l = name ? this.s.tx.filter((t) => t.from === name || t.to === name) : this.s.tx;
    return l.slice(-n).reverse();
  }

  state(who) {
    this._ensureWorld();
    this._loadCatalog();
    this._ensureAccounts();
    const me = who ? this.resolve(who) : null;
    const wallets = {};
    for (const [n, a] of Object.entries(this.s.accounts)) wallets[n] = a.balance;
    return {
      ok: true, world: this.world, currency: this.settings.currency, rev: this.s.rev || 0, startBalance: this.settings.startBalance,
      ...(me ? { me: { name: me, balance: this.balance(me), held: this.held(me) } } : {}),
      wallets,
      shop: this.catalog(),
      shops: this.shops(),
      listings: this.market(),
      auctions: this.auctions(),
      tx: this.history(me, 50),
      deliveries: this.s.deliveries.filter((d) => !me || d.to === me).map((d) => ({ ...d })),
      ...(this.earnings ? this.earnings.stateExtra(me) : {}), // jobs, bounties, earnings (earnings.js)
    };
  }

  // ================================================================================ operations

  pay({ who, to, amount, note } = {}) {
    return this._run(() => {
      const from = this.resolve(who);
      const dest = this.resolve(to, 'to');
      if (from === dest) throw bad('you can\'t pay yourself');
      const n = intArg(amount, 'amount', 1, MAX_PRICE);
      this._needCoins(from, n);
      this._move(from, dest, n);
      const t = this._tx('pay', from, dest, n, { note: str(note, 120).trim() });
      this._save();
      this._notify(dest, `${from} paid you ${n} coins${t.note ? ` ("${t.note}")` : ''}. Balance: ${this.balance(dest)}.`);
      return { ok: true, from, to: dest, amount: n, balance: this.balance(from), tx: t };
    });
  }

  shopBuy({ who, item, count } = {}) {
    return this._run(async () => {
      const name = this.resolve(who);
      const id = normItem(item);
      const n = intArg(count, 'count', 1, MAX_COUNT, 1);
      const c = this.items.get(id);
      if (!c) {
        const s = this._suggest(id, (i) => i.buy !== null);
        throw notFound(`the server shop doesn't sell "${id}".${s.length ? ` Did you mean: ${s.join(', ')}?` : ''} See GET /econ/catalog`);
      }
      if (c.buy === null) throw conflict(`the server shop doesn't sell ${id} (it only buys it, for ${c.sell} each)`);
      const cost = c.buy * n;
      this._needCoins(name, cost, `${n} × ${c.buy}`);
      const g = await this._give(name, id, n);
      if (g.given === 0) {
        if (g.offline) throw conflict(`${name} is not online in Minecraft, so nothing was bought; buy again when in the game`);
        throw new HttpError(502, `the server refused to give ${id}: ${short(g.error)}; nothing was charged`);
      }
      const paid = g.given * c.buy;
      let t;
      try {
        this._move(name, SERVER, paid);
        t = this._tx('shop_buy', name, SERVER, paid, { item: id, count: g.given });
        this._save();
      } catch (e) {
        // the items are already in the player's inventory and can't be taken back safely: log loudly
        logErr(`econ: shop buy by ${name}: gave ${g.given} ${id} but charging ${paid} coins failed: ${e?.stack || e}`);
        throw e;
      }
      this._emit('sale', { text: `${name} bought ${g.given} ${pretty(id)} from the server shop for ${paid} coins`, who: [name] });
      return { ok: true, item: id, count: g.given, cost: paid, balance: this.balance(name), tx: t,
        ...(g.given < n ? { warning: `only ${g.given} of ${n} could be delivered; you paid for ${g.given}` } : {}) };
    });
  }

  shopSell({ who, item, count } = {}) {
    return this._run(async () => {
      const name = this.resolve(who);
      const id = normItem(item);
      const n = intArg(count, 'count', 1, MAX_COUNT, 1);
      const c = this.items.get(id);
      if (!c || c.sell === null) {
        const s = this._suggest(id, (i) => i.sell !== null);
        throw conflict(`the server shop doesn't buy ${id}.${s.length ? ` It buys e.g.: ${s.join(', ')}.` : ''} You can list it on the market instead (POST /econ/list)`);
      }
      const removed = await this._clear(name, id, n);
      if (!removed) throw conflict(`you have no ${id} in your inventory`);
      const earned = removed * c.sell;
      const t = await this._afterClear(name, id, removed, 'shop sell', () => {
        this._move(SERVER, name, earned);
        const tx = this._tx('shop_sell', SERVER, name, earned, { item: id, count: removed });
        this._save();
        return tx;
      });
      this._emit('sale', { text: `${name} sold ${removed} ${pretty(id)} to the server shop for ${earned} coins`, who: [name] });
      return { ok: true, item: id, count: removed, requested: n, earned, balance: this.balance(name), tx: t,
        ...(removed < n ? { note: `you only had ${removed} ${id}; sold all of them` } : {}) };
    });
  }

  _shopOf(name) {
    let sh = this.s.shops[name];
    if (!sh) {
      sh = this.s.shops[name] = { owner: name, name: `${name}'s shop`, description: '', created: this.now() };
      this._emit('shop', { shop: this.shopOut(sh) });
    }
    return sh;
  }

  openShop({ who, name: shopName, description } = {}) {
    return this._run(() => {
      const owner = this.resolve(who);
      const nm = str(shopName, 40).trim().replace(/\s+/g, ' ');
      if (!nm) throw bad('name is required (your shop\'s name, up to 40 characters)');
      const taken = Object.values(this.s.shops).find((s) => s.owner !== owner && s.name.toLowerCase() === nm.toLowerCase());
      if (taken) throw conflict(`the shop name "${nm}" is taken by ${taken.owner}; pick another`);
      const existed = !!this.s.shops[owner];
      const sh = this._shopOf(owner);
      sh.name = nm;
      if (description !== undefined) sh.description = str(description, 160).trim();
      for (const l of this.s.listings) if (l.seller === owner) l.shop = nm;
      this._emit('shop', { shop: this.shopOut(sh) });
      this._save();
      return { ok: true, opened: !existed, shop: this.shopOut(sh) };
    });
  }

  list({ who, item, count, price } = {}) {
    return this._run(async () => {
      const name = this.resolve(who);
      const id = normItem(item);
      const n = intArg(count, 'count', 1, MAX_COUNT);
      const p = intArg(price, 'price (coins each)', 1, MAX_PRICE);
      const removed = await this._clear(name, id, n);
      if (!removed) throw conflict(`you have no ${id} in your inventory`);
      const l = await this._afterClear(name, id, removed, 'list', () => {
        const sh = this._shopOf(name);
        const x = { id: this.s.nextListing++, seller: name, shop: sh.name, item: id, count: removed, price: p, ts: this.now() };
        this.s.listings.push(x);
        this._tx('list', name, ESCROW, 0, { item: id, count: removed, note: `listing #${x.id} at ${p} each` });
        this._emit('listing', { listing: { ...x } });
        this._queueNews({ kind: 'listing', seller: name, id: x.id, item: id, count: removed, price: p });
        this._save();
        return x;
      });
      return { ok: true, listing: { ...l }, removed,
        ...(removed < n ? { note: `you only had ${removed} ${id}; listed all of them` } : {}) };
    });
  }

  _listing(id) {
    const n = intArg(id, 'id', 1, Number.MAX_SAFE_INTEGER);
    const l = this.s.listings.find((x) => x.id === n);
    if (!l) throw notFound(`no open listing #${n} (it may have sold out); see GET /econ/market`);
    return l;
  }

  unlist({ who, id } = {}) {
    return this._run(async () => {
      const name = this.resolve(who);
      const l = this._listing(id);
      if (l.seller !== name) throw conflict(`listing #${l.id} belongs to ${l.seller}; only they can cancel it`);
      this.s.listings = this.s.listings.filter((x) => x !== l);
      this._emit('listing_removed', { id: l.id, reason: 'cancelled' });
      this._tx('unlist', ESCROW, name, 0, { item: l.item, count: l.count, note: `listing #${l.id} cancelled` });
      this._save();
      const d = await this._deliverOrQueue(name, l.item, l.count, `listing #${l.id} cancelled`);
      this._save();
      return { ok: true, id: l.id, returned: l.count, delivered: d.queued === 0,
        ...(d.queued ? { note: `${d.queued} ${l.item} queued: they will be given when you are next online` } : {}) };
    });
  }

  marketBuy({ who, id, count } = {}) {
    return this._run(async () => {
      const name = this.resolve(who);
      const l = this._listing(id);
      if (l.seller === name) throw conflict(`listing #${l.id} is your own; use unlist ${l.id} to take it back`);
      const n = intArg(count, 'count', 1, MAX_COUNT, l.count);
      if (n > l.count) throw conflict(`listing #${l.id} has only ${l.count} left`);
      const cost = n * l.price;
      this._needCoins(name, cost, `${n} × ${l.price}`);
      // first give must reach the server (else 502, nothing changed); offline buyer -> queued, sale still completes
      const g = await this._give(name, l.item, n);
      if (g.given === 0 && !g.offline) throw new HttpError(502, `the server refused to give ${l.item}: ${short(g.error)}; nothing was charged`);
      const left = n - g.given;
      let t;
      try {
        if (left > 0) {
          this.s.deliveries.push({ id: this.s.nextDelivery++, to: name, item: l.item, count: left, reason: `listing #${l.id}`, ts: this.now() });
          logErr(`econ: market buy #${l.id}: ${left} ${l.item} for ${name} queued (${g.offline ? 'player offline' : g.error})`);
        }
        this._move(name, l.seller, cost);
        l.count -= n;
        t = this._tx('market_buy', name, l.seller, cost, { item: l.item, count: n, note: `listing #${l.id}` });
        if (l.count <= 0) {
          this.s.listings = this.s.listings.filter((x) => x !== l);
          this._emit('listing_removed', { id: l.id, reason: 'sold' });
        } else this._emit('listing', { listing: { ...l } });
        this._save();
      } catch (e) {
        logErr(`econ: market buy #${l.id} by ${name} (${n} ${l.item}, ${cost} coins): bookkeeping failed after giving ${g.given}: ${e?.stack || e}`);
        throw e;
      }
      const text = `${name} bought ${n} ${pretty(l.item)} from ${l.seller} for ${cost} coins`;
      this._emit('sale', { text, who: [name, l.seller] });
      this._notify(l.seller, `Sold: ${name} bought ${n} ${pretty(l.item)} from your listing #${l.id} for ${cost} coins${l.count > 0 ? ` (${l.count} left)` : ' (sold out)'}. Balance: ${this.balance(l.seller)}.`);
      return { ok: true, listing: { ...l }, item: l.item, count: n, cost, balance: this.balance(name), delivered: left === 0, tx: t,
        ...(left ? { note: `${left} ${l.item} queued: they will be given when you are next online` } : {}) };
    });
  }

  createAuction({ who, item, count, start, minutes, durationSec } = {}) {
    return this._run(async () => {
      const name = this.resolve(who);
      const id = normItem(item);
      const n = intArg(count, 'count', 1, MAX_COUNT);
      const st = intArg(start, 'start (starting price for the lot)', 1, MAX_PRICE);
      const maxMin = Number(this.settings.auction.maxMinutes) || 1440;
      const ms = (durationSec !== undefined && durationSec !== '' && minutes === undefined)
        ? intArg(durationSec, 'durationSec', 30, maxMin * 60) * 1000
        : intArg(minutes, 'minutes', 1, maxMin) * 60000;
      const removed = await this._clear(name, id, n);
      if (!removed) throw conflict(`you have no ${id} in your inventory`);
      const a = await this._afterClear(name, id, removed, 'auction create', () => {
        const now = this.now();
        const x = { id: this.s.nextAuction++, seller: name, item: id, count: removed, start: st, bid: null, bidder: null, bids: 0,
          created: now, endsAt: now + ms, status: 'open', winner: null };
        this.s.auctions.push(x);
        this._tx('auction_create', name, ESCROW, 0, { item: id, count: removed, note: `auction #${x.id}, start ${st}` });
        this._emit('auction', { auction: this.auctionOut(x) });
        this._queueNews({ kind: 'auction', seller: name, id: x.id, item: id, count: removed, start: st });
        this._save();
        return x;
      });
      return { ok: true, auction: this.auctionOut(a), removed,
        ...(removed < n ? { note: `you only had ${removed} ${id}; auctioning all of them` } : {}) };
    });
  }

  _auction(id) {
    const n = intArg(id, 'id', 1, Number.MAX_SAFE_INTEGER);
    const a = this.s.auctions.find((x) => x.id === n);
    if (!a) throw notFound(`no auction #${n}; see GET /econ/auctions`);
    return a;
  }

  bid({ who, id, amount } = {}) {
    return this._run(() => {
      const name = this.resolve(who);
      const a = this._auction(id);
      const now = this.now();
      if (a.status !== 'open' || now >= a.endsAt) throw conflict(`auction #${a.id} has ended`);
      if (a.seller === name) throw conflict(`auction #${a.id} is your own; you can't bid on it`);
      const amt = intArg(amount, 'amount', 1, MAX_PRICE);
      const min = this._minNext(a);
      if (amt < min) throw conflict(`bid too low: minimum next bid on auction #${a.id} is ${min}`);
      const prev = a.bidder, prevBid = a.bid;
      if (prev === name) {
        const extra = amt - prevBid;
        this._needCoins(name, extra, `raising your bid from ${prevBid} to ${amt}`);
        this._move(name, ESCROW, extra);
        this._tx('bid_hold', name, ESCROW, extra, { item: a.item, count: a.count, note: `auction #${a.id} raise to ${amt}` });
      } else {
        this._needCoins(name, amt);
        this._move(name, ESCROW, amt);
        this._tx('bid_hold', name, ESCROW, amt, { item: a.item, count: a.count, note: `auction #${a.id}` });
        if (prev) {
          this._move(ESCROW, prev, prevBid);
          this._tx('bid_refund', ESCROW, prev, prevBid, { item: a.item, count: a.count, note: `auction #${a.id} outbid by ${name}` });
        }
      }
      a.bid = amt;
      a.bidder = name;
      a.bids = (a.bids || 0) + 1;
      const snipe = (Number(this.settings.auction.antiSnipeSec) || 0) * 1000;
      let extended = false;
      if (snipe > 0 && a.endsAt - now < snipe) { a.endsAt = now + snipe; extended = true; }
      this._emit('wallet', { who: name, balance: this.balance(name), held: this.held(name) });
      if (prev && prev !== name) this._emit('wallet', { who: prev, balance: this.balance(prev), held: this.held(prev) });
      this._emit('auction', { auction: this.auctionOut(a) });
      this._save();
      if (prev && prev !== name) this._notify(prev, `Outbid on auction #${a.id} (${a.count} ${pretty(a.item)}): ${name} bid ${amt}. Your ${prevBid} coins are back. Min next bid: ${this._minNext(a)}.`);
      this._notify(a.seller, `New bid on your auction #${a.id} (${a.count} ${pretty(a.item)}): ${amt} by ${name}.`);
      return { ok: true, auction: this.auctionOut(a), balance: this.balance(name), held: this.held(name),
        ...(extended ? { note: `late bid: auction #${a.id} extended to end in ${Math.round(snipe / 1000)}s` } : {}) };
    });
  }

  cancelAuction({ who, id } = {}) {
    return this._run(async () => {
      const name = this.resolve(who);
      const a = this._auction(id);
      if (a.seller !== name) throw conflict(`auction #${a.id} belongs to ${a.seller}; only they can cancel it`);
      if (a.status !== 'open') throw conflict(`auction #${a.id} has already ended`);
      if (a.bids > 0) throw conflict(`auction #${a.id} already has bids; it can't be cancelled`);
      a.status = 'cancelled';
      a.endedAt = this.now();
      this._tx('auction_cancel', ESCROW, name, 0, { item: a.item, count: a.count, note: `auction #${a.id} cancelled` });
      this._emit('auction_ended', { auction: this.auctionOut(a) });
      this._save();
      const d = await this._deliverOrQueue(name, a.item, a.count, `auction #${a.id} cancelled`);
      this._save();
      return { ok: true, auction: this.auctionOut(a), returned: a.count, delivered: d.queued === 0 };
    });
  }

  // ================================================================================ timers

  async _settle(a) {
    a.status = a.bidder ? 'sold' : 'unsold';
    a.endedAt = this.now();
    if (a.bidder) {
      a.winner = a.bidder;
      this._move(ESCROW, a.seller, a.bid);
      this._tx('auction_sale', a.winner, a.seller, a.bid, { item: a.item, count: a.count, note: `auction #${a.id}` });
      this._emit('auction_ended', { auction: this.auctionOut(a) });
      this._emit('wallet', { who: a.winner, balance: this.balance(a.winner), held: this.held(a.winner) });
      this._save();
      const d = await this._deliverOrQueue(a.winner, a.item, a.count, `auction #${a.id} won`);
      this._save();
      this._emit('sale', { text: `${a.winner} won auction #${a.id}: ${a.count} ${pretty(a.item)} from ${a.seller} for ${a.bid} coins`, who: [a.winner, a.seller] });
      this._notify(a.winner, `You won auction #${a.id}: ${a.count} ${pretty(a.item)} for ${a.bid} coins.${d.queued ? ' The items will be given when you are next online.' : ' The items are in your inventory.'}`);
      this._notify(a.seller, `Auction #${a.id} sold: ${a.count} ${pretty(a.item)} to ${a.winner} for ${a.bid} coins. Balance: ${this.balance(a.seller)}.`);
    } else {
      this._tx('auction_unsold', ESCROW, a.seller, 0, { item: a.item, count: a.count, note: `auction #${a.id} had no bids` });
      this._emit('auction_ended', { auction: this.auctionOut(a) });
      this._save();
      const d = await this._deliverOrQueue(a.seller, a.item, a.count, `auction #${a.id} unsold`);
      this._save();
      this._notify(a.seller, `Auction #${a.id} ended with no bids: your ${a.count} ${pretty(a.item)} ${d.queued ? 'will be returned when you are next online' : 'are back in your inventory'}.`);
    }
  }

  async _flushDeliveries() {
    if (!this.s.deliveries.length) return 0;
    let online;
    try { online = parseList(await this.rcon('list')); } catch (e) {
      const msg = `econ: ${this.s.deliveries.length} queued deliveries waiting, server not reachable (${e?.message || e})`;
      if (msg !== this._lastFlushErr) logErr(msg);
      this._lastFlushErr = msg;
      return 0;
    }
    this._lastFlushErr = null;
    let n = 0;
    for (const d of [...this.s.deliveries]) {
      if (!online.has(this.mcName(d.to).toLowerCase())) continue;
      let g;
      try { g = await this._give(d.to, d.item, d.count, { mustReach: false }); } catch (e) { logErr(`econ delivery #${d.id}: ${e.message}`); continue; }
      if (!g.given) continue;
      d.count -= g.given;
      if (d.count <= 0) this.s.deliveries = this.s.deliveries.filter((x) => x !== d);
      this._tx('deliver', ESCROW, d.to, 0, { item: d.item, count: g.given, note: d.reason });
      this._save();
      this._notify(d.to, `Delivered: ${g.given} ${pretty(d.item)} (${d.reason}).`);
      n++;
    }
    return n;
  }

  /** settle ended auctions + retry queued deliveries (also called by the timer) */
  tick({ forceDeliveries = false } = {}) {
    if (this._tickQueued) return this._tickPromise;
    this._tickQueued = true;
    const p = this._run(async () => {
      const now = this.now();
      for (const a of this.s.auctions) {
        if (a.status !== 'open' || a.endsAt > now) continue;
        try { await this._settle(a); } catch (e) {
          logErr(`econ: settling auction #${a.id} (${a.count} ${a.item}, seller ${a.seller}, bid ${a.bid} by ${a.bidder}) failed: ${e?.stack || e}`);
        }
      }
      if (this._news.length && now - this._newsAt >= NEWS_BATCH_MS) this.flushNews();
      if (this.s.deliveries.length && (forceDeliveries || Date.now() - this._lastDelivery >= DELIVERY_EVERY_MS)) {
        this._lastDelivery = Date.now();
        await this._flushDeliveries();
      }
    });
    this._tickPromise = p.finally(() => { this._tickQueued = false; });
    return this._tickPromise;
  }

  /** wait for queued operations (tests) */
  idle() { return this._q; }

  // ================================================================================ market news

  _queueNews(n) {
    if (!this._news.length) this._newsAt = this.now();
    this._news.push({ ...n, world: this.world });
  }

  /**
   * Send the batched new-listings/new-auctions notice: ONE 'Market' message to every bot except the seller(s)
   * of everything in it (non-interrupting: 'Market' is a hub service). Called by tick() ~20 s after the first one.
   * @returns {number} messages sent
   */
  flushNews() {
    const news = this._news.filter((n) => n.world === this.world);
    this._news = [];
    this._newsAt = 0;
    if (!news.length) return 0;
    let names = [];
    try { names = this.knownNames() || []; } catch (e) { logErr('economy: knownNames failed:', e.message); }
    const humans = new Set(this._humans().flatMap(([a, mc]) => [a.toLowerCase(), String(mc).toLowerCase()]));
    const bots = [...new Set(names.map(String))].filter((b) => b && !SYSTEM_NAMES.has(b.toLowerCase()) && !humans.has(b.toLowerCase()));
    const now = this.now();
    const left = (id) => { const a = this.s.auctions.find((x) => x.id === id); return a ? Math.max(0, a.endsAt - now) : 0; };
    const dur = (ms) => (ms >= 7_200_000 ? `${Math.round(ms / 3_600_000)}h` : `${Math.max(1, Math.round(ms / 60000))}m`);
    const more = (n) => (n > NEWS_MAX_ITEMS ? ` +${n - NEWS_MAX_ITEMS} more` : '');
    let sent = 0;
    for (const bot of bots) {
      const mine = (n) => n.seller.toLowerCase() === bot.toLowerCase();
      const ls = news.filter((n) => n.kind === 'listing' && !mine(n));
      const as = news.filter((n) => n.kind === 'auction' && !mine(n));
      const parts = [];
      if (ls.length) parts.push(`new listings: ${ls.slice(0, NEWS_MAX_ITEMS).map((n) => `${n.seller} ${n.count} ${n.item} @${n.price} (#${n.id})`).join(', ')}${more(ls.length)} — market_buy {id}`);
      if (as.length) parts.push(`new auctions: ${as.slice(0, NEWS_MAX_ITEMS).map((n) => `auction #${n.id} by ${n.seller}: ${n.count} ${n.item}, start ${n.start}, ends ${dur(left(n.id))}`).join('; ')}${more(as.length)} — auction_bid {id, amount}`);
      if (!parts.length) continue;
      this._notify(bot, parts.join(' | '));
      sent++;
    }
    return sent;
  }

  close() {
    clearInterval(this.timer);
    this.timer = null;
    try { if (this._news.length) this.flushNews(); } catch (e) { logErr('econ news flush:', e.message); }
    try { this.earnings?.close(); } catch (e) { logErr('earnings close:', e.message); }
    this._save();
  }
}

function short(t, n = 160) { t = String(t ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; }

// ================================================================================ HTTP routes

/** mount /econ/* on the hub's router (app.js) */
export function attachEconRoutes({ route, econ }) {
  const b = (fn) => ({ body }) => fn(body || {});
  route('GET', '/econ/state', ({ query }) => econ.state(query.who || null));
  route('GET', '/econ/catalog', ({ query }) => ({ ok: true, currency: econ.settings.currency, items: econ.catalog(query.item) }));
  route('POST', '/econ/pay', b((x) => econ.pay(x)));
  for (const p of ['/econ/shop/buy', '/econ/buy']) route('POST', p, b((x) => econ.shopBuy(x)));
  for (const p of ['/econ/shop/sell', '/econ/sell']) route('POST', p, b((x) => econ.shopSell(x)));
  route('GET', '/econ/shops', () => ({ ok: true, shops: econ.shops() }));
  route('POST', '/econ/shops', b((x) => econ.openShop(x)));
  route('POST', '/econ/list', b((x) => econ.list(x)));
  route('POST', '/econ/unlist', b((x) => econ.unlist(x)));
  route('GET', '/econ/market', ({ query }) => ({ ok: true, listings: econ.market({ item: query.item, seller: query.seller }) }));
  route('POST', '/econ/market/buy', b((x) => econ.marketBuy(x)));
  route('GET', '/econ/auctions', ({ query }) => ({ ok: true, auctions: econ.auctions({ all: query.all === '1' || query.all === 'true' }) }));
  for (const p of ['/econ/auction', '/econ/auction/create']) route('POST', p, b((x) => econ.createAuction(x)));
  for (const p of ['/econ/bid', '/econ/auction/bid']) route('POST', p, b((x) => econ.bid(x)));
  route('POST', '/econ/auction/cancel', b((x) => econ.cancelAuction(x)));
  route('GET', '/econ/history', ({ query }) => ({ ok: true, tx: econ.history(query.who || null, query.limit) }));
}
