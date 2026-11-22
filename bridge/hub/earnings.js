// Hivecraft earnings: ways to EARN coins from the world, on top of the economy (economy.js).
// Spec: MOD_PROTOCOL.md §5 "Earning coins". Hooked in by app.js (only when the economy is on):
//   const earn = new Earnings({ econ, store, botDims });   attachEarnRoutes({ route, earn });
// Sources (every payment is a Tx with its own kind + a ws {kind:'earn', source}):
//   1. board bounties   (player funded, escrowed)  bounty_hold / bounty_paid / bounty_refund
//   2. server jobs      (world funded)             job_pay       deliver items (RCON clear) above the shop price
//   3. mob bounties     (world funded)             mob_bounty    scoreboard minecraft.killed:<mob>, per-minute cap
//   4. milestones       (world funded, once)       milestone / world_first   scoreboard minecraft.mined:<block>, dimension
//   5. daily wage       (world funded)             wage          everyone online at each Minecraft sunrise
// State is per world: econ.s.earn (saved in data/economy/<world>.json). All money moves run in econ._run (one queue).
import { HttpError, str, log, logErr } from './util.js';
import { intArg, normItem, parseList, pretty } from './economy.js';

const BANK = 'Bank', SERVER = 'Server', ESCROW = 'Escrow';
const MAX_AMOUNT = 1_000_000;
const MAX_COUNT = 640;
const MIN_POLL_SEC = 5;
const TICKS_PER_DAY = 24000;
const MS_PER_TICK = 50;
const PAST_KEEP = 300;
const bad = (m) => new HttpError(400, m);
const notFound = (m) => new HttpError(404, m);
const conflict = (m) => new HttpError(409, m);
const c = (n) => `${n} coin${n === 1 ? '' : 's'}`;
const posInt = (v, d, lo = 0, hi = MAX_AMOUNT) => (Number.isInteger(v) && v >= lo && v <= hi ? v : d);

// ------------------------------------------------------------------------------------------ RCON reply parsers

/** `time query day|daytime` -> number or null ("The time is 1234") */
export function parseTime(reply) {
  const m = /time is (-?\d+)/i.exec(String(reply ?? ''));
  return m ? Number(m[1]) : null;
}

/**
 * `scoreboard players list <player>` -> {objective: value} or null when the reply isn't recognised.
 * 1.21: "Ash has 2 scores:" then one "[obj]: n" per score (RCON may glue them with or without newlines);
 * "Ash has no scores to show" when none.
 */
export function parseScoreList(reply) {
  const r = String(reply ?? '');
  if (/has no scores/i.test(r)) return {};
  if (!/has \d+ scores?/i.test(r)) return null;
  const out = {};
  for (const m of r.matchAll(/\[([A-Za-z0-9_.+-]{1,16})\]\s*:\s*(-?\d+)/g)) out[m[1]] = Number(m[2]);
  return out;
}

/** `scoreboard players get <p> <obj>` -> number, 0 when "none is set", null when unrecognised */
export function parseScoreGet(reply) {
  const r = String(reply ?? '');
  const m = /has (-?\d+) \[/i.exec(r);
  if (m) return Number(m[1]);
  if (/none is set|can'?t get value/i.test(r)) return 0;
  return null;
}

/** `data get entity <p> Dimension` -> 'overworld' | 'the_nether' | 'the_end' | other id, or null */
export function parseDimension(reply) {
  const m = /entity data:\s*"([a-z0-9_.:/-]+)"/i.exec(String(reply ?? ''));
  return m ? m[1].replace(/^minecraft:/, '') : null;
}

/** objective name (<= 16 chars) for a criterion; long ones get a short stable hash so names never collide */
export function objName(prefix, id, crit) {
  const full = `${prefix}${id}`;
  if (full.length <= 16) return full;
  let h = 0;
  for (const ch of crit) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return `${full.slice(0, 13)}${(h % 46656).toString(36).padStart(3, '0')}`;
}

// ------------------------------------------------------------------------------------------ settings

const DEFAULT_MOBS = { zombie: 3, husk: 3, drowned: 3, zombie_villager: 3, skeleton: 3, stray: 3, bogged: 3, creeper: 4,
  spider: 2, cave_spider: 3, enderman: 6, witch: 8, slime: 1, magma_cube: 2, phantom: 5, pillager: 5, vindicator: 8,
  evoker: 15, ravager: 20, vex: 2, silverfish: 1, endermite: 1, guardian: 6, blaze: 6, ghast: 8, wither_skeleton: 10,
  hoglin: 5, zoglin: 5, piglin_brute: 10, shulker: 6, breeze: 8 };
const DEFAULT_MILESTONES = [
  { id: 'diamond', label: 'first diamond', reward: 25, mined: ['diamond_ore', 'deepslate_diamond_ore'] },
  { id: 'deepslate_diamond', label: 'first deepslate diamond', reward: 30, mined: ['deepslate_diamond_ore'] },
  { id: 'emerald', label: 'first emerald', reward: 20, mined: ['emerald_ore', 'deepslate_emerald_ore'] },
  { id: 'ancient_debris', label: 'first ancient debris', reward: 60, mined: ['ancient_debris'] },
  { id: 'nether', label: 'first trip to the Nether', reward: 40, dimension: 'the_nether' },
  { id: 'end', label: 'first trip to the End', reward: 100, dimension: 'the_end' },
];
const DEFAULT_JOB_POOL = [
  { item: 'cobblestone', count: 32 }, { item: 'wheat', count: 12 }, { item: 'iron_ingot', count: 8 }, { item: 'oak_log', count: 32 },
  { item: 'coal', count: 16 }, { item: 'bread', count: 8 }, { item: 'rotten_flesh', count: 16 }, { item: 'bone', count: 12 },
];

/** normalise the `earnings` block of econ-catalog.json (missing/bad values -> defaults) */
export function earnSettings(raw = {}) {
  const j = raw && typeof raw === 'object' ? raw : {};
  const jobs = j.jobs || {}, mobs = j.mobs || {}, ms = j.milestones || {}, wage = j.wage || {}, b = j.bounties || {};
  const mobValues = {};
  for (const [k, v] of Object.entries(mobs.values && typeof mobs.values === 'object' ? mobs.values : DEFAULT_MOBS)) {
    let id; try { id = normItem(k); } catch { continue; }
    if (Number.isInteger(v) && v > 0 && v <= MAX_AMOUNT) mobValues[id] = v;
  }
  const milestones = [];
  for (const m of Array.isArray(ms.list) ? ms.list : DEFAULT_MILESTONES) {
    if (!m || typeof m !== 'object' || !/^[a-z0-9_]{1,32}$/.test(String(m.id || ''))) continue;
    const reward = posInt(m.reward, null, 1);
    if (reward === null) continue;
    const mined = (Array.isArray(m.mined) ? m.mined : m.mined ? [m.mined] : []).map((x) => { try { return normItem(x); } catch { return null; } }).filter(Boolean);
    const dimension = m.dimension ? String(m.dimension).replace(/^minecraft:/, '') : null;
    if (!mined.length && !dimension) continue;
    milestones.push({ id: m.id, label: str(m.label || m.id, 60), reward, mined, dimension, first: Number.isInteger(m.first) ? m.first : null });
  }
  const pool = [];
  for (const p of Array.isArray(jobs.pool) ? jobs.pool : DEFAULT_JOB_POOL) {
    let item; try { item = normItem(p?.item); } catch { continue; }
    const count = posInt(p?.count, null, 1, MAX_COUNT);
    if (count === null) continue;
    pool.push({ item, count, pay: posInt(p?.pay, null, 1) });
  }
  const per = Array.isArray(jobs.perDay) ? jobs.perDay : [jobs.perDay ?? 3, jobs.perDay ?? 5];
  const lo = posInt(per[0], 3, 0, 20), hi = Math.max(lo, posInt(per[1], 5, 0, 20));
  return {
    pollSec: Math.max(MIN_POLL_SEC, posInt(j.pollSec, 25, 1, 3600)),
    bounties: { enabled: b.enabled !== false },
    jobs: { enabled: jobs.enabled !== false, perDay: [lo, hi], premiumPct: posInt(jobs.premiumPct, 50, 0, 1000), fallbackMinutes: posInt(jobs.fallbackMinutes, 30, 1, 1440), pool },
    mobs: { enabled: mobs.enabled !== false, capPerMinute: posInt(mobs.capPerMinute, 60), values: mobValues },
    milestones: { enabled: ms.enabled !== false, worldFirstPct: posInt(ms.worldFirstPct, 50, 0, 1000), list: milestones },
    wage: { amount: posInt(wage.amount, 10) },
  };
}

function freshEarn() {
  return { bounties: {}, pastBounties: [], jobs: [], nextJob: 1, jobsDay: null, jobsAt: 0, scores: {}, objCreated: {}, mobWin: {},
    milestones: {}, firsts: {}, wageDay: null, day: null, dayAt: 0, today: {}, totals: {} };
}

// ------------------------------------------------------------------------------------------ Earnings

export class Earnings {
  /**
   * @param {object} o
   * @param {import('./economy.js').Economy} o.econ
   * @param {import('./store.js').Store} o.store     the hub board (bounties)
   * @param {()=>Map<string,string>|object} [o.botDims] bot name -> dimension ('overworld' | 'the_nether' | 'the_end')
   * @param {boolean} [o.timers=true]   poll timer (scoreboards, time, wage, job rotation)
   * @param {()=>number} [o.random]
   */
  constructor({ econ, store, botDims = () => ({}), timers = true, random = Math.random } = {}) {
    if (!econ) throw new Error('Earnings needs the economy');
    this.econ = econ;
    this.store = store;
    this.botDims = botDims;
    this.random = random;
    this._raw = null;
    this._cfg = null;
    this._objKey = null;      // world|objective set that is known to exist on the server
    this._objs = [];
    this._polling = null;
    this._nextSunrise = null;
    this._warned = new Set();
    econ.earnings = this;
    if (store) {
      this._onChange = ({ type, data }) => {
        try {
          if (type === 'board' && data && this._openBounty(data.id)) this.econ._run(() => this._settleTask(data)).catch((e) => logErr('bounty settle:', e?.message || e));
          else if (type === 'board_delete' && data && this._openBounty(data.id)) this.econ._run(() => this._refundAll(this._openBounty(data.id), 'the task was deleted')).catch((e) => logErr('bounty refund:', e?.message || e));
        } catch (e) { logErr('earnings board hook:', e?.message || e); }
      };
      store.on('change', this._onChange);
    }
    this._onEcon = (m) => { if (m.kind === 'reset') { this._objKey = null; this._syncTasks(); } };
    econ.on('econ', this._onEcon);
    this._syncTasks();
    this.timer = null;
    // HIVE_EARNINGS_POLL=0: no scoreboard/time polling (tests that use the default RCON must not touch a live server)
    if (timers && process.env.HIVE_EARNINGS_POLL !== '0') this._schedule();
  }

  _schedule() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.poll().catch((e) => logErr('earnings poll:', e?.message || e)).finally(() => this.timer && this._schedule()); }, this.cfg().pollSec * 1000);
    this.timer.unref?.();
  }

  close() {
    clearTimeout(this.timer);
    this.timer = null;
    this.store?.off?.('change', this._onChange);
    this.econ.off?.('econ', this._onEcon);
  }

  /** settings from the `earnings` block of econ-catalog.json (re-parsed when the catalog was reloaded) */
  cfg() {
    const raw = this.econ.earnCfg || {};
    if (!this._cfg || raw !== this._raw) { this._raw = raw; this._cfg = earnSettings(raw); }
    return this._cfg;
  }

  get e() {
    const s = this.econ.s;
    if (!s.earn || typeof s.earn !== 'object') s.earn = freshEarn();
    else for (const [k, v] of Object.entries(freshEarn())) if (s.earn[k] === undefined) s.earn[k] = v;
    return s.earn;
  }

  _warnOnce(key, ...msg) { if (this._warned.has(key)) return; this._warned.add(key); logErr(...msg); }

  /** credit an earning from a world account: tx + totals + ws 'earn' + (optional) Market notice */
  _earn(source, kind, from, who, amount, { text, note, item, count, notify, extra = {} } = {}) {
    if (!(amount > 0)) return null;
    const ec = this.econ;
    ec._move(from, who, amount);
    const t = ec._tx(kind, from, who, amount, { note: note ?? text, item, count });
    const e = this.e;
    this._rollToday();
    const tot = (e.totals[who] ||= {});
    tot[source] = (tot[source] || 0) + amount;
    e.today[who] = (e.today[who] || 0) + amount;
    const balance = ec.balance(who);
    ec._emit('earn', { source, who, amount, balance, text: text || note || '', ...extra });
    if (notify) ec._notify(who, `${notify} Balance: ${balance}.`);
    return t;
  }

  /** "today" = since the current Minecraft day began; local midnight while the bridge has never read MC time */
  _rollToday() {
    const e = this.e;
    if (e.day !== null) return;
    const d = new Date(this.econ.now());
    const key = `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
    if (e.todayKey !== key) { e.todayKey = key; e.today = {}; }
  }

  // ================================================================================ 1. board bounties

  _openBounty(id) {
    const s = this.econ.s;
    const b = s?.earn?.bounties?.[String(id)];
    return b && b.status === 'open' ? b : null;
  }

  hasBounty(id) { return !!this._openBounty(id); }

  _bountyOut(b) { return { task: b.task, title: b.title, total: b.total, funders: { ...b.funders }, status: b.status, owner: b.owner ?? null, paidTo: b.paidTo ?? null, created: b.created, ...(b.ended ? { ended: b.ended } : {}) }; }

  _patchTask(id, b) {
    if (!this.store) return;
    let t; try { t = this.store.task(id); } catch { return; }
    const f = b ? { reward: b.total, rewardStatus: b.status, rewardTo: b.paidTo ?? null } : { reward: undefined, rewardStatus: undefined, rewardTo: undefined };
    if (t.reward === f.reward && t.rewardStatus === f.rewardStatus && (t.rewardTo ?? null) === (f.rewardTo ?? null)) return;
    this.store.patchTask(id, f);
  }

  /** task reward fields follow the current world's bounties (world switch, bridge start) */
  _syncTasks() {
    if (!this.store) return;
    try {
      const bs = this.e.bounties;
      for (const t of this.store.tasks) {
        const b = bs[String(t.id)];
        const mine = b && (!b.created || !t.created || b.created === t.created) ? b : null;
        if (mine || t.reward !== undefined) this._patchTask(t.id, mine);
      }
    } catch (e) { logErr('earnings: task reward sync:', e?.message || e); }
  }

  _emitBounty(b) { this.econ._emit('bounty', { bounty: this._bountyOut(b) }); }

  _fund(t, who, amount) {
    const e = this.e;
    let b = e.bounties[String(t.id)];
    if (b && b.status !== 'open') { e.pastBounties.push(b); if (e.pastBounties.length > PAST_KEEP) e.pastBounties.splice(0, e.pastBounties.length - PAST_KEEP); b = null; }
    if (!b) b = e.bounties[String(t.id)] = { task: t.id, title: t.title, created: t.created || null, by: who, total: 0, funders: {}, status: 'open', owner: null, paidTo: null };
    this.econ._move(who, ESCROW, amount);
    b.funders[who] = (b.funders[who] || 0) + amount;
    b.total += amount;
    this.econ._tx('bounty_hold', who, ESCROW, amount, { note: `bounty on task #${t.id} ${str(t.title, 60)}` });
    this._patchTask(t.id, b);
    this._emitBounty(b);
    return b;
  }

  /** POST /board with a reward: escrow first, then create the task (not enough coins -> no task) */
  postTask(body = {}) {
    return this.econ._run(() => {
      if (!this.cfg().bounties.enabled) throw conflict('board bounties are turned off in econ-catalog.json');
      const amount = intArg(body.reward, 'reward (coins)', 1, MAX_AMOUNT);
      const who = this.econ.resolve(body.by, 'by');
      if (!str(body.title, 200).trim()) throw bad('title is required');
      this.econ._needCoins(who, amount, 'the reward is held until the task is done');
      const t = this.store.addTask({ by: who, title: body.title, detail: body.detail, priority: body.priority });
      this._fund(t, who, amount);
      this.econ._save();
      return this.store.task(t.id);
    });
  }

  /** add coins to a task's bounty (or put a bounty on it) */
  addBounty({ who, task, amount } = {}) {
    return this.econ._run(() => {
      if (!this.cfg().bounties.enabled) throw conflict('board bounties are turned off in econ-catalog.json');
      const name = this.econ.resolve(who);
      const id = intArg(task, 'task (board task id)', 1, Number.MAX_SAFE_INTEGER);
      const n = intArg(amount, 'amount', 1, MAX_AMOUNT);
      let t; try { t = this.store.task(id); } catch { throw notFound(`no board task #${id}; see the board`); }
      if (t.status === 'done') throw conflict(`task #${id} is already done`);
      this.econ._needCoins(name, n, 'the reward is held until the task is done');
      const b = this._fund(t, name, n);
      this.econ._save();
      const others = Object.keys(b.funders).filter((f) => f !== name);
      for (const f of others) this.econ._notify(f, `${name} added ${c(n)} to the bounty on task #${id} "${str(t.title, 60)}" (now ${b.total}).`);
      if (t.owner && t.owner !== name && !others.includes(t.owner)) { try { this.econ._notify(this.econ.resolve(t.owner), `${name} put ${c(n)} on your task #${id} "${str(t.title, 60)}" (bounty now ${b.total}). Finish it and mark it done to get paid.`); } catch { /* owner has no account */ } }
      return { ok: true, bounty: this._bountyOut(b), task: { ...this.store.task(id) }, balance: this.econ.balance(name) };
    });
  }

  /** a funder takes their share back (only while nobody else has claimed the task) */
  cancelBounty({ who, task } = {}) {
    return this.econ._run(() => {
      const name = this.econ.resolve(who);
      const id = intArg(task, 'task (board task id)', 1, Number.MAX_SAFE_INTEGER);
      const b = this._openBounty(id);
      if (!b) throw notFound(`task #${id} has no open bounty`);
      const share = b.funders[name] || 0;
      if (!share) throw conflict(`you have no coins on the bounty for task #${id}`);
      let t = null; try { t = this.store.task(id); } catch { /* deleted: refund anyway */ }
      if (t && t.owner && t.status !== 'open' && t.owner.toLowerCase() !== name.toLowerCase()) throw conflict(`${t.owner} has claimed task #${id} and may be working on it; ask them to release it (status open) first`);
      this._refundShare(b, name, `bounty on task #${id} withdrawn`);
      if (b.total <= 0) { b.status = 'refunded'; b.ended = this.econ.now(); }
      this._patchTask(id, b.total > 0 || b.status !== 'open' ? b : null);
      this._emitBounty(b);
      this.econ._save();
      if (t?.owner && t.owner.toLowerCase() !== name.toLowerCase()) { try { this.econ._notify(this.econ.resolve(t.owner), `${name} withdrew ${c(share)} from the bounty on task #${id} (now ${b.total}).`); } catch { /* no account */ } }
      return { ok: true, bounty: this._bountyOut(b), refunded: share, balance: this.econ.balance(name) };
    });
  }

  _refundShare(b, f, note) {
    const amt = b.funders[f] || 0;
    if (!amt) return 0;
    delete b.funders[f];
    b.total -= amt;
    this.econ._move(ESCROW, f, amt);
    this.econ._tx('bounty_refund', ESCROW, f, amt, { note });
    return amt;
  }

  _refundAll(b, why) {
    if (!b || b.status !== 'open') return;
    for (const f of Object.keys(b.funders)) {
      const amt = this._refundShare(b, f, `task #${b.task}: ${why}`);
      if (amt) this.econ._notify(f, `Bounty refunded: ${c(amt)} back for task #${b.task} "${str(b.title, 60)}" (${why}). Balance: ${this.econ.balance(f)}.`);
    }
    b.total = 0;
    b.status = 'refunded';
    b.ended = this.econ.now();
    this._patchTask(b.task, b);
    this._emitBounty(b);
    this.econ._save();
  }

  /** board change: a task with an open bounty became done -> pay the owner (or refund) */
  _settleTask(task) {
    const b = this._openBounty(task.id);
    if (!b) return;
    let t; try { t = this.store.task(task.id); } catch { return; }
    if (b.created && t.created && b.created !== t.created) return; // another task reusing the id (hub.json was reset)
    if (t.title && t.title !== b.title) b.title = t.title;
    if (t.status !== 'done') {
      if ((b.owner ?? null) !== (t.owner ?? null)) { b.owner = t.owner ?? null; this.econ._save(); }
      return;
    }
    let owner = null;
    if (t.owner) { try { owner = this.econ.resolve(t.owner); } catch { owner = null; } }
    if (!owner) return this._refundAll(b, t.owner ? `${t.owner} has no coin account` : 'it was marked done but nobody had claimed it');
    b.owner = owner;
    let paid = 0;
    const payers = [];
    // the owner's own share comes back (you can't pay yourself); every other funder's share is paid to the owner
    if (b.funders[owner]) this._refundShare(b, owner, `task #${b.task}: you can't pay yourself, your share comes back`);
    for (const [f, amt] of Object.entries(b.funders)) {
      paid += amt;
      payers.push([f, amt]);
      this._earn('bounty', 'bounty_paid', ESCROW, owner, amt, { note: `task #${b.task} ${str(b.title, 60)} (from ${f})`, text: `task #${b.task} ${str(b.title, 60)}`, extra: { task: b.task, from: f } });
    }
    b.status = paid > 0 ? 'paid' : 'refunded';
    b.paidTo = paid > 0 ? owner : null;
    b.total = paid;
    b.ended = this.econ.now();
    if (paid > 0) {
      this.econ._notify(owner, `Bounty: +${c(paid)} for task #${b.task} "${str(b.title, 60)}" (from ${payers.map(([f]) => f).join(', ')}). Balance: ${this.econ.balance(owner)}.`);
      for (const [f, amt] of payers) this.econ._notify(f, `Bounty paid: ${owner} got your ${c(amt)} for task #${b.task} "${str(b.title, 60)}".`);
    } else this.econ._notify(owner, `Task #${b.task} done: it was your own bounty, so your coins came back. Balance: ${this.econ.balance(owner)}.`);
    this._patchTask(b.task, b);
    this._emitBounty(b);
    this.econ._save();
  }

  bounties({ all = false } = {}) {
    this.econ._ensureWorld();
    const e = this.e;
    const open = Object.values(e.bounties).filter((b) => all || b.status === 'open');
    const past = all ? e.pastBounties : [];
    return [...open, ...past].sort((a, b) => (a.status === 'open' ? 0 : 1) - (b.status === 'open' ? 0 : 1) || b.total - a.total || a.task - b.task).map((b) => this._bountyOut(b));
  }

  // ================================================================================ 2. server jobs

  _jobOut(j) { return { ...j, delivered: { ...j.delivered } }; }

  jobs() {
    this.econ._ensureWorld();
    return this.e.jobs.map((j) => this._jobOut(j));
  }

  _nextRotation() {
    if (this._nextSunrise) return this._nextSunrise;
    const e = this.e;
    return e.jobsAt ? e.jobsAt + this.cfg().jobs.fallbackMinutes * 60000 : null;
  }

  _emitJobs() { this.econ._emit('jobs', { jobs: this.jobs(), nextRotation: this._nextRotation() }); }

  _jobPay(p, premiumPct) {
    if (p.pay) return { pay: p.pay, shopSell: this.econ.items.get(p.item)?.sell ?? null };
    const it = this.econ.items.get(p.item);
    const sell = it?.sell;
    if (!sell) return null;
    let pay = Math.max(sell + 1, Math.ceil(sell * (100 + premiumPct) / 100));
    if (it.buy) pay = Math.min(pay, it.buy - 1); // never more than the shop charges (no buy-from-shop-and-deliver profit)
    return pay > 0 ? { pay, shopSell: sell } : null;
  }

  /** post a new set of jobs (old open ones expire) */
  _rotateJobs(day) {
    const cfg = this.cfg().jobs, e = this.e, now = this.econ.now();
    for (const j of e.jobs) if (j.status === 'open') { j.status = 'expired'; j.ended = now; }
    const pool = [];
    for (const p of cfg.pool) {
      const pr = this._jobPay(p, cfg.premiumPct);
      if (!pr) { this._warnOnce(`job:${p.item}`, `earnings: job pool item ${p.item} has no shop sell price and no "pay"; skipped`); continue; }
      pool.push({ ...p, ...pr });
    }
    const [lo, hi] = cfg.perDay;
    const want = Math.min(pool.length, lo + Math.floor(this.random() * (hi - lo + 1)));
    const pick = [];
    while (pick.length < want && pool.length) pick.push(pool.splice(Math.floor(this.random() * pool.length), 1)[0]);
    e.jobs = pick.map((p) => ({ id: e.nextJob++, item: p.item, count: p.count, left: p.count, pay: p.pay, shopSell: p.shopSell,
      delivered: {}, created: now, expiresAt: null, status: 'open' }));
    e.jobsDay = day ?? null;
    e.jobsAt = now;
    const nr = this._nextRotation();
    for (const j of e.jobs) j.expiresAt = nr;
    this._emitJobs();
    if (e.jobs.length) log(`earnings: new server jobs${day != null ? ` for day ${day}` : ''}: ${e.jobs.map((j) => `#${j.id} ${j.count} ${j.item} @${j.pay}`).join(', ')}`);
  }

  deliver({ who, id, count } = {}) {
    return this.econ._run(async () => {
      const name = this.econ.resolve(who);
      const jid = intArg(id, 'id (job id from jobs)', 1, Number.MAX_SAFE_INTEGER);
      const j = this.e.jobs.find((x) => x.id === jid);
      if (!j) throw notFound(`no server job #${jid}; see the current jobs (GET /econ/jobs)`);
      if (j.status !== 'open') throw conflict(`job #${jid} is ${j.status === 'filled' ? 'already filled' : 'over (new jobs were posted)'}; see the current jobs`);
      const n = Math.min(intArg(count, 'count', 1, MAX_COUNT, j.left), j.left);
      const removed = await this.econ._clear(name, j.item, n);
      if (!removed) throw conflict(`you have no ${j.item} in your inventory`);
      const earned = removed * j.pay;
      const tx = await this.econ._afterClear(name, j.item, removed, 'job delivery', () => {
        j.left -= removed;
        j.delivered[name] = (j.delivered[name] || 0) + removed;
        if (j.left <= 0) { j.status = 'filled'; j.ended = this.econ.now(); }
        const t = this._earn('job', 'job_pay', SERVER, name, earned, { item: j.item, count: removed, note: `job #${j.id}`, text: `${removed} ${pretty(j.item)} for job #${j.id}`, extra: { job: j.id } });
        this._emitJobs();
        this.econ._save();
        return t;
      });
      this.econ._emit('sale', { text: `${name} delivered ${removed} ${pretty(j.item)} for server job #${j.id} and earned ${earned} coins`, who: [name] });
      return { ok: true, job: this._jobOut(j), count: removed, requested: n, earned, balance: this.econ.balance(name), tx,
        ...(removed < n ? { note: `you only had ${removed} ${j.item}; delivered all of them` } : {}) };
    });
  }

  // ================================================================================ 3+4+5. world polling

  /** online players that have (or can get) an account: [{acct, mc}] */
  _onlineAccounts(onlineLower) {
    const out = [];
    const seen = new Set();
    for (const lname of onlineLower) {
      let acct;
      try { acct = this.econ.resolve(lname); } catch { continue; }
      if (seen.has(acct)) continue;
      seen.add(acct);
      out.push({ acct, mc: this.econ.mcName(acct) });
    }
    return out;
  }

  /** every scoreboard objective we need: [{name, crit, mob?|block?}] */
  _wantedObjectives() {
    const cfg = this.cfg();
    const out = new Map();
    if (cfg.mobs.enabled) for (const mob of Object.keys(cfg.mobs.values)) {
      const crit = `minecraft.killed:minecraft.${mob}`;
      out.set(crit, { name: objName('hm_', mob, crit), crit, mob });
    }
    if (cfg.milestones.enabled) for (const m of cfg.milestones.list) for (const block of m.mined) {
      const crit = `minecraft.mined:minecraft.${block}`;
      if (!out.has(crit)) out.set(crit, { name: objName('hx_', block, crit), crit, block });
    }
    return [...out.values()];
  }

  async _ensureObjectives() {
    const want = this._wantedObjectives();
    const key = `${this.econ.world}|${want.map((o) => o.name).join(',')}`;
    if (key === this._objKey) return this._objs;
    const ok = [];
    const e = this.e;
    for (const o of want) {
      const r = String(await this.econ.rcon(`scoreboard objectives add ${o.name} ${o.crit}`) ?? '');
      if (/created new objective/i.test(r)) { e.objCreated[o.crit] = this.econ.now(); ok.push(o); }
      else if (/already exists/i.test(r)) ok.push(o);
      else this._warnOnce(`obj:${o.crit}`, `earnings: could not create scoreboard objective ${o.name} (${o.crit}): "${str(r, 160)}"`);
    }
    this._objs = ok;
    this._objKey = key;
    log(`earnings: ${ok.length}/${want.length} scoreboard objectives ready in ${this.econ.world}`);
    return ok;
  }

  /** current scores of one player for our objectives -> {crit: n} (missing = unknown this round) */
  async _readScores(mc, objs) {
    const list = parseScoreList(await this.econ.rcon(`scoreboard players list ${mc}`));
    const out = {};
    if (list) {
      for (const o of objs) out[o.crit] = list[o.name] ?? 0;
      return out;
    }
    this._warnOnce('scorelist', 'earnings: unrecognised `scoreboard players list` reply; falling back to one `scoreboard players get` per objective');
    for (const o of objs) {
      const v = parseScoreGet(await this.econ.rcon(`scoreboard players get ${mc} ${o.name}`));
      if (v !== null) out[o.crit] = v;
    }
    return out;
  }

  /** score increases since the last read; the first read of a player sets the baseline */
  _deltas(acct, cur) {
    const e = this.e;
    const base = (e.scores[acct] ||= {});
    const d = {};
    for (const [crit, v] of Object.entries(cur)) {
      const prev = base[crit];
      // no baseline yet: count from 0 if we created this objective in this world (all of its scores are new),
      // else (objective was already there, e.g. economy file lost) start from what it shows now
      const from = prev ?? (e.objCreated[crit] ? 0 : v);
      if (v > from) d[crit] = v - from;
      base[crit] = v;
    }
    return d;
  }

  _payMobs(acct, deltas) {
    const cfg = this.cfg().mobs;
    if (!cfg.enabled) return;
    let coins = 0;
    const parts = [];
    for (const [crit, n] of Object.entries(deltas)) {
      const mob = /^minecraft\.killed:minecraft\.(.+)$/.exec(crit)?.[1];
      const v = mob && cfg.values[mob];
      if (!v) continue;
      coins += n * v;
      parts.push(`${n} ${pretty(mob)}`);
    }
    if (!coins) return;
    const now = this.econ.now();
    const win = (this.e.mobWin[acct] || []).filter(([ts]) => now - ts < 60000);
    const recent = win.reduce((s, [, a]) => s + a, 0);
    const pay = cfg.capPerMinute > 0 ? Math.max(0, Math.min(coins, cfg.capPerMinute - recent)) : coins;
    const lost = coins - pay;
    if (pay > 0) win.push([now, pay]);
    this.e.mobWin[acct] = win;
    const what = parts.join(', ');
    if (pay > 0) this._earn('mob', 'mob_bounty', BANK, acct, pay, { note: what, text: what,
      notify: `Mob bounty: +${c(pay)} (${what})${lost ? `; ${lost} more not paid: the cap is ${cfg.capPerMinute} coins a minute` : ''}.` });
    else this._warnOnce(`cap:${acct}:${Math.floor(now / 600000)}`, `earnings: ${acct} hit the mob bounty cap (${what} not paid)`);
  }

  _milestoneDone(acct, m, now) {
    const e = this.e;
    const mine = (e.milestones[acct] ||= {});
    if (mine[m.id]) return;
    mine[m.id] = now;
    this._earn('milestone', 'milestone', BANK, acct, m.reward, { note: m.label, text: m.label, extra: { id: m.id },
      notify: `Milestone: ${m.label}! +${c(m.reward)}.` });
    if (!e.firsts[m.id]) {
      e.firsts[m.id] = { who: acct, ts: now };
      const bonus = m.first ?? Math.round(m.reward * this.cfg().milestones.worldFirstPct / 100);
      if (bonus > 0) {
        this._earn('milestone', 'world_first', BANK, acct, bonus, { note: `world first: ${m.label}`, text: `world first: ${m.label}`, extra: { id: m.id, worldFirst: true },
          notify: `World first: you are the first in this world to get "${m.label}"! +${c(bonus)}.` });
        this.econ._emit('sale', { text: `${acct} is the first in this world to get "${m.label}"`, who: [acct] });
      }
    }
  }

  _dimOfBot(acct) {
    let d;
    try { d = this.botDims(); } catch { return undefined; }
    const v = d instanceof Map ? d.get(acct) : d?.[acct];
    return v ? String(v).replace(/^minecraft:/, '') : undefined;
  }

  /** one round: time (wage, jobs), scoreboards (mobs, mined milestones), dimensions. Never throws for RCON trouble. */
  poll() {
    if (this._polling) return this._polling;
    this._polling = this.econ._run(() => this._poll()).finally(() => { this._polling = null; });
    return this._polling;
  }

  async _poll() {
    const ec = this.econ;
    const cfg = this.cfg();
    const e = this.e;
    const now = ec.now();
    let onlineLower;
    try { onlineLower = parseList(await ec.rcon('list')); } catch (err) {
      this._warnOnce(`down:${Math.floor(now / 600000)}`, `earnings: Minecraft not reachable (${err?.message || err}); earnings wait`);
      if (cfg.jobs.enabled && !e.jobsAt) { this._rotateJobs(null); ec._save(); } // first jobs don't need the server
      return { ok: false };
    }
    ec._ensureAccounts();
    const online = this._onlineAccounts(onlineLower);
    // ---- time: sunrise = the day number went up
    let day = null, daytime = null;
    try { day = parseTime(await ec.rcon('time query day')); daytime = parseTime(await ec.rcon('time query daytime')); } catch { /* jobs fall back to real time */ }
    this._nextSunrise = daytime !== null ? now + (TICKS_PER_DAY - (((daytime % TICKS_PER_DAY) + TICKS_PER_DAY) % TICKS_PER_DAY)) * MS_PER_TICK : null;
    let newDay = false;
    if (day !== null) {
      if (e.day === null || day < e.day) { e.day = day; e.dayAt = now; e.wageDay = day; }
      else if (day > e.day) { e.day = day; e.dayAt = now; e.today = {}; newDay = true; }
    }
    if (newDay && e.wageDay !== day) {
      e.wageDay = day;
      const w = cfg.wage.amount;
      if (w > 0) for (const { acct } of online) this._earn('wage', 'wage', BANK, acct, w, { note: `day ${day}`, text: `day ${day}`, extra: { day }, notify: `Daily wage: +${c(w)} (day ${day}).` });
    }
    // ---- jobs: a new set every Minecraft day (real-time fallback when the day doesn't move)
    if (cfg.jobs.enabled) {
      const open = e.jobs.some((j) => j.status === 'open');
      const stale = now - (e.jobsAt || 0) >= cfg.jobs.fallbackMinutes * 60000;
      if (!e.jobsAt || (newDay && e.jobsDay !== day) || stale || (!open && day !== null && e.jobsDay !== day)) this._rotateJobs(day);
    }
    // ---- scoreboards
    let objs = [];
    if (online.length && (cfg.mobs.enabled || cfg.milestones.enabled)) {
      try { objs = await this._ensureObjectives(); } catch (err) { logErr('earnings: scoreboard setup failed:', err?.message || err); objs = []; }
    }
    for (const { acct, mc } of online) {
      try {
        if (objs.length) {
          const d = this._deltas(acct, await this._readScores(mc, objs));
          this._payMobs(acct, d);
          if (cfg.milestones.enabled) for (const m of cfg.milestones.list) if (m.mined.some((b) => d[`minecraft.mined:minecraft.${b}`] > 0)) this._milestoneDone(acct, m, now);
        }
        const dimMs = cfg.milestones.enabled ? cfg.milestones.list.filter((m) => m.dimension && !e.milestones[acct]?.[m.id]) : [];
        if (dimMs.length) {
          let dim = this._dimOfBot(acct);
          if (dim === undefined) dim = parseDimension(await ec.rcon(`data get entity ${mc} Dimension`));
          for (const m of dimMs) if (dim === m.dimension) this._milestoneDone(acct, m, now);
        }
      } catch (err) { logErr(`earnings: reading ${acct} failed: ${err?.message || err}`); }
    }
    ec._save();
    return { ok: true, online: online.map((o) => o.acct), day };
  }

  // ================================================================================ views

  rates() {
    const cfg = this.cfg();
    return { mobs: cfg.mobs.enabled ? { ...cfg.mobs.values } : {}, mobCapPerMinute: cfg.mobs.capPerMinute,
      milestones: cfg.milestones.enabled ? cfg.milestones.list.map((m) => ({ id: m.id, label: m.label, reward: m.reward, first: m.first ?? Math.round(m.reward * cfg.milestones.worldFirstPct / 100) })) : [],
      wage: cfg.wage.amount, jobPremiumPct: cfg.jobs.premiumPct, bounties: cfg.bounties.enabled };
  }

  earnings(who) {
    this.econ._ensureWorld();
    const e = this.e;
    const name = who ? this.econ.resolve(who) : null;
    const rates = this.rates();
    this._rollToday();
    const out = { ok: true, rates, nextSunrise: this._nextSunrise, day: e.day };
    if (!name) {
      out.totals = {};
      for (const [n, t] of Object.entries(e.totals)) out.totals[n] = { ...t };
      out.today = { ...e.today };
      return out;
    }
    const t = e.totals[name] || {};
    out.who = name;
    out.totals = { mob: t.mob || 0, job: t.job || 0, bounty: t.bounty || 0, milestone: t.milestone || 0, wage: t.wage || 0,
      today: e.today[name] || 0 };
    out.totals.all = out.totals.mob + out.totals.job + out.totals.bounty + out.totals.milestone + out.totals.wage;
    const mine = e.milestones[name] || {};
    out.milestones = rates.milestones.map((m) => ({ ...m, done: !!mine[m.id], ...(mine[m.id] ? { ts: mine[m.id] } : {}),
      ...(e.firsts[m.id] ? { firstBy: e.firsts[m.id].who, worldFirst: e.firsts[m.id].who === name } : {}) }));
    const kinds = new Set(['mob_bounty', 'job_pay', 'bounty_paid', 'milestone', 'world_first', 'wage']);
    out.recent = this.econ.s.tx.filter((x) => kinds.has(x.kind) && x.to === name).slice(-20).reverse();
    return out;
  }

  /** extra fields for GET /econ/state */
  stateExtra(me) {
    return { jobs: this.jobs(), nextRotation: this._nextRotation(), bounties: this.bounties(), earnings: this.earnings(me || null) };
  }
}

// ================================================================================ HTTP routes

export function attachEarnRoutes({ route, earn }) {
  const b = (fn) => ({ body }) => fn(body || {});
  route('GET', '/econ/jobs', () => ({ ok: true, jobs: earn.jobs(), nextRotation: earn._nextRotation() }));
  route('POST', '/econ/jobs/deliver', b((x) => earn.deliver(x)));
  route('GET', '/econ/bounties', ({ query }) => ({ ok: true, bounties: earn.bounties({ all: query.all === '1' || query.all === 'true' }) }));
  route('POST', '/econ/bounty', b((x) => earn.addBounty(x)));
  route('POST', '/econ/bounty/cancel', b((x) => earn.cancelBounty(x)));
  route('GET', '/econ/earnings', ({ query }) => earn.earnings(query.who || null));
}
