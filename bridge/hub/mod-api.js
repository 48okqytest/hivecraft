// Hivecraft Overlay (Fabric client mod) API: WebSocket ws://127.0.0.1:47960/mod + HTTP /mod/*.
// Protocol: MOD_PROTOCOL.md (keep the two in sync). Hooked in by app.js:
//   const modApi = attachModApi({ route, bots, store, dataDir, port });   // before the server is created
//   modApi.onBroadcast(type, data)   // photo events from the viewer routes
//   modApi.onAct(name, body, outcome) // after POST /bots/:name/act (blueprint_preview ghosts)
//   modApi.attach(server)            // after http.createServer (WS upgrade)
//   await modApi.close()
// Data sources: BotManager (bot list + 'mod:ledger'/'mod:path'/'mod:pose' events from engine/ledger.js), Store
// ('change' events), build jobs on disk (data/blueprints/builds), the photo album.
import fs from 'node:fs';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import { LedgerStore } from '../engine/ledger.js';
import { Album } from '../viewer/album.js';
import { Blueprint } from '../engine/blueprint/model.js';
import { targetsFor, inSection } from '../engine/blueprint/plan.js';
import { isAutoPart } from '../engine/blueprint/states.js';
import { runCommand, COMMANDS, actionText } from './mod-commands.js';
import { HttpError, clamp, logErr, log } from './util.js';
import { playerDisplayName, playerMcName, isPlayerName } from '../config.js';

export const PROTOCOL = 1;
const PALETTE = ['#F2B134', '#4FC3F7', '#81C784', '#E57373', '#BA68C8', '#FFB74D', '#4DB6AC', '#F06292', '#9575CD', '#AED581'];
export function botColor(name) {
  let h = 0;
  for (const c of String(name || '')) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return PALETTE[h % PALETTE.length];
}
export const PLAYER_COLOR = '#FFFF55'; // the human player's chat colour
export const SYSTEM_COLOR = '#AAAAAA';

const BOTS_MS = 200;          // ~5 Hz bot states
const TRAIL_MS = 1000;        // trail deltas
const LEDGER_FLUSH_MS = 100;  // ledger batches
const GHOST_MS = 3000;        // build job re-scan
const TRAIL_MAX = 240, TRAIL_AGE_MS = 180000, TRAIL_STEP = 1.0;
const PREVIEW_TTL_MS = 10 * 60 * 1000;
const FINISHED_KEEP_MS = 2 * 60 * 1000;
const STALE_JOB_MS = 12 * 3600 * 1000;
const MAX_GHOST_BLOCKS = 8000;
const MAX_BUFFERED = 4 * 1024 * 1024; // skip bots/trail frames to a client that can't keep up
const TOPICS = ['bots', 'paths', 'chat', 'board', 'goal', 'photos', 'ledger', 'ghosts', 'log', 'econ'];

const r2 = (v) => Math.round(v * 100) / 100;
const readJson = (f, d = null) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };

// ====================================================================================== ghosts

export class GhostTracker {
  constructor({ buildsDir, ledger }) {
    this.dir = buildsDir;
    this.ledger = ledger;
    this.jobs = new Map();      // id -> {job, targets, truncated, bySection}
    this.previews = new Map();  // id -> ghost
    this.list = [];             // current ghosts (with blocks)
    this.revs = new Map();      // id -> {sig, rev}
    this.dirty = true;
  }

  _rev(id, sig) {
    const r = this.revs.get(id);
    if (r && r.sig === sig) return r.rev;
    const rev = (r?.rev || 0) + 1;
    this.revs.set(id, { sig, rev });
    return rev;
  }

  _loadJob(id) {
    const d = path.join(this.dir, id);
    const job = readJson(path.join(d, 'job.json'));
    if (!job) return null;
    let c = this.jobs.get(id);
    if (c && c.created === job.created) return c;
    let targets = [];
    try {
      const bp = Blueprint.fromJSON(readJson(path.join(d, 'bp.json')));
      targets = targetsFor(bp, { origin: job.origin, rotation: job.rotation || 0, mirror: job.mirror || null }).filter((t) => !t.air && !isAutoPart(t.name, t.props));
    } catch (e) { logErr(`mod-api: build ${id} unreadable: ${e.message}`); }
    const total = targets.length;
    const truncated = targets.length > MAX_GHOST_BLOCKS;
    if (truncated) targets = targets.slice(0, MAX_GHOST_BLOCKS);
    const st = (t) => Object.keys(t.props || {}).sort().map((k) => `${k}=${t.props[k]}`).join(',');
    for (const t of targets) t.stateStr = st(t);
    const secTotals = new Map();
    for (const s of job.sections || []) secTotals.set(s.id, 0);
    c = { job, created: job.created, targets, total, truncated, secTotals };
    // section totals on the full target list (not truncated)
    this.jobs.set(id, c);
    return c;
  }

  /** Re-scan build jobs on disk and expire previews. Returns true when anything changed. */
  refresh() {
    const now = Date.now();
    const out = [];
    let ids = [];
    try { ids = fs.existsSync(this.dir) ? fs.readdirSync(this.dir) : []; } catch { ids = []; }
    for (const id of ids) {
      let c;
      try { c = this._loadJob(id); } catch { c = null; }
      if (!c) continue;
      const { job, targets } = c;
      const secs = job.sections || [];
      const progs = secs.map((s) => readJson(path.join(this.dir, id, `sec-${s.id}.json`), null));
      const claims = secs.map((s) => readJson(path.join(this.dir, id, `sec-${s.id}.claim`), null));
      const created = Date.parse(job.created) || 0;
      const updated = Math.max(created, ...progs.map((p) => p?.updated || 0), ...claims.map((x) => x?.ts || 0));
      const finished = secs.length > 0 && progs.every((p) => p?.done);
      if (finished ? now - updated > FINISHED_KEEP_MS : now - updated > STALE_JOB_MS) continue;
      // per-block placed flags: section done -> all placed; else the ledger's last event at that cell
      const secDone = new Map(secs.map((s, i) => [s.id, !!progs[i]?.done]));
      const secOf = (t) => secs.find((s) => inSection(s, t.x, t.z))?.id ?? null;
      let placedN = 0;
      const ledgerBySec = new Map();
      const blocks = targets.map((t) => {
        const sid = secOf(t);
        let placed = 0;
        if (sid !== null && secDone.get(sid)) placed = 1;
        else {
          const e = this.ledger.last(t.x, t.y, t.z, 'overworld');
          if (e && e.op === 'place' && e.block === t.name) { placed = 1; ledgerBySec.set(sid, (ledgerBySec.get(sid) || 0) + 1); }
        }
        placedN += placed;
        return [t.x, t.y, t.z, t.name, t.stateStr, placed];
      });
      // done count: max(blocks known placed, progress files' snapshot), per section
      let done = 0;
      const scale = c.total / Math.max(1, targets.length);
      secs.forEach((s, i) => {
        const secTargets = Math.round(targets.filter((t) => inSection(s, t.x, t.z)).length * scale);
        const p = progs[i];
        let d = (ledgerBySec.get(s.id) || 0);
        if (p?.done) d = secTargets;
        else if (Number.isFinite(p?.remaining)) d = Math.max(d, secTargets - p.remaining);
        done += Math.min(secTargets, Math.max(0, d));
      });
      if (!secs.length) done = placedN;
      done = Math.min(c.total, Math.max(done, placedN));
      const botsOn = claims.map((x) => x?.bot).filter(Boolean);
      const latest = claims.filter(Boolean).sort((a, b) => b.ts - a.ts)[0];
      const g = {
        id: job.id || id, kind: 'build', blueprint: job.blueprint, bot: latest?.bot || job.by || null, bots: [...new Set(botsOn)],
        origin: job.origin, rotation: job.rotation || 0, mirror: job.mirror || null, dim: 'overworld', bounds: job.bounds,
        total: c.total, done, remaining: c.total - done, progress: c.total ? Math.round((done / c.total) * 100) : 100,
        finished, updated, parts: secs.length,
        sections: secs.map((s, i) => ({ id: s.id, done: !!progs[i]?.done, bot: claims[i]?.bot || null, remaining: progs[i]?.remaining ?? null })),
        ...(c.truncated ? { truncated: true } : {}),
        blocks,
      };
      g.rev = this._rev(g.id, `${done}|${placedN}|${finished}|${g.bots.join(',')}|${g.bot}`);
      out.push(g);
    }
    for (const [id, p] of this.previews) {
      if (p.expires < now) { this.previews.delete(id); continue; }
      out.push(p);
    }
    const sig = out.map((g) => `${g.id}:${g.rev}`).join(';');
    const changed = sig !== this._sig;
    this._sig = sig;
    for (const id of this.revs.keys()) if (!out.some((g) => g.id === id)) this.revs.delete(id);
    this.list = out;
    this.dirty = false;
    return changed;
  }

  /** A blueprint_preview result: {text, view:{ghosts:[{x,y,z,block,props,tint}]}} */
  addPreview(bot, args = {}, result) {
    const gs = result?.view?.ghosts;
    if (!Array.isArray(gs)) return null;
    const ox = Math.round(Number(args.x)), oy = Math.round(Number(args.y)), oz = Math.round(Number(args.z));
    const id = `preview:${bot}:${args.name}:${ox}:${oy}:${oz}`;
    const st = (p) => Object.keys(p || {}).sort().map((k) => `${k}=${p[k]}`).join(',');
    const blocks = gs.slice(0, MAX_GHOST_BLOCKS).map((g) => [g.x, g.y, g.z, g.block, st(g.props), g.tint === 'done' ? 1 : 0, g.tint || 'ok']);
    let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (const b of blocks) { minX = Math.min(minX, b[0]); maxX = Math.max(maxX, b[0]); minY = Math.min(minY, b[1]); maxY = Math.max(maxY, b[1]); minZ = Math.min(minZ, b[2]); maxZ = Math.max(maxZ, b[2]); }
    const done = blocks.filter((b) => b[6] === 'done').length;
    const now = Date.now();
    const g = {
      id, kind: 'preview', blueprint: String(args.name || '?'), bot, bots: [bot], origin: { x: ox, y: oy, z: oz },
      rotation: Number(args.rotation) || 0, mirror: args.mirror || null, dim: 'overworld',
      bounds: blocks.length ? { minX, maxX, minY, maxY, minZ, maxZ } : null,
      total: blocks.length, done, remaining: blocks.length - done, progress: 0, finished: false,
      conflicts: blocks.filter((b) => b[6] === 'conflict').length,
      updated: now, expires: now + PREVIEW_TTL_MS, blocks,
    };
    g.rev = this._rev(id, `${now}`);
    this.previews.set(id, g);
    this.dirty = true;
    return g;
  }

  /** a build started: drop previews of the same blueprint at the same origin */
  dropPreviewsFor(args = {}) {
    for (const [id, p] of this.previews) {
      if (p.blueprint === args.name && p.origin.x === Math.round(Number(args.x)) && p.origin.y === Math.round(Number(args.y)) && p.origin.z === Math.round(Number(args.z))) { this.previews.delete(id); this.dirty = true; }
    }
  }

  get(id) { return this.list.find((g) => g.id === id) || null; }
}

const summaryOf = (g) => { const { blocks, ...rest } = g; return rest; };

// ====================================================================================== attach

export function attachModApi({ route, bots, store, dataDir, port = 47960, econ = null, player: human = null }) {
  // the human (hivecraft.config.json player): ME = display name / economy account, ME_MC = Minecraft name
  const ME = human?.displayName || playerDisplayName();
  const ME_MC = human?.mcName || playerMcName() || ME;
  const isMe = (n) => isPlayerName(n, { player: { displayName: ME, mcName: ME_MC } });
  const ledger = new LedgerStore(path.join(dataDir, 'ledger'));
  const buildsDir = process.env.HIVE_BLUEPRINTS ? path.join(process.env.HIVE_BLUEPRINTS, 'builds') : path.join(dataDir, 'blueprints', 'builds');
  const ghosts = new GhostTracker({ buildsDir, ledger });
  let album = null;
  const photosList = () => { try { return (album ||= new Album(dataDir)).list({ limit: 200 }); } catch { return []; } };
  let photos = photosList().slice(0, 200).map(photoOut); // newest first; kept fresh by 'photo' broadcasts
  const clients = new Set();
  const poses = new Map();     // bot -> {x,y,z,yaw,pitch,dim,ts}
  const paths = new Map();     // bot -> path msg
  const trails = new Map();    // bot -> [[x,y,z,ts]]
  const trailNew = new Map();  // bot -> points since last trail message
  const lastChat = new Map();  // bot -> {text, ts}
  const counters = new Map();  // bot -> {started, place, break, byCause}
  const logGate = new Map();   // bot -> [ts] for log throttling
  let player = null;           // latest {name,x,y,z,dim,yaw,ts} from any client
  let ledgerBatch = [];

  for (const m of store.messages.slice(-400)) if (bots.has(m.from) || store.botRoles?.[m.from] !== undefined) lastChat.set(m.from, { text: m.text, ts: m.ts });

  function photoOut(r) {
    if (!r) return null;
    return { id: r.id, agent: r.agent, ts: r.ts, caption: r.caption || '', mode: r.mode || null, url: `/photos/${r.id}.png`,
      ...(r.meta?.width ? { width: r.meta.width, height: r.meta.height } : {}) };
  }
  const chatOut = (m) => ({ id: m.id, from: m.from, to: m.to, text: m.text, ts: m.ts,
    color: m.from === 'system' ? SYSTEM_COLOR : bots.has(m.from) ? botColor(m.from) : isMe(m.from) ? PLAYER_COLOR : '#FFFFFF' });

  // ---------- per-action counters (for "mining iron 12/24") ----------
  function counterFor(name, started) {
    let c = counters.get(name);
    if (c && c.started === started) return c;
    c = { started, place: 0, break: 0, byCause: {} };
    if (started) for (const e of ledger.query({ bot: name, since: started, limit: 5000 }).events) { c[e.op]++; c.byCause[e.cause] = (c.byCause[e.cause] || 0) + 1; }
    counters.set(name, c);
    return c;
  }
  ledger.onEvent((e) => {
    const c = counters.get(e.bot);
    if (c && c.started && e.ts >= c.started) { c[e.op]++; c.byCause[e.cause] = (c.byCause[e.cause] || 0) + 1; }
    ledgerBatch.push(e);
    if (e.build) ghosts.dirty = true;
  });

  // ---------- bot states ----------
  function claimedTask(name) {
    const l = store.tasks.filter((t) => t.status === 'claimed' && String(t.owner || '').toLowerCase() === name.toLowerCase());
    if (!l.length) return null;
    const t = l.sort((a, b) => (b.updated || 0) - (a.updated || 0))[0];
    return { id: t.id, title: t.title, status: t.status };
  }

  function botStates() {
    const now = Date.now();
    return bots.list(true).map((b) => {
      const s = bots.slots.get(b.name);
      const st = s?.lastState || {};
      const pose = poses.get(b.name);
      const fresh = pose && now - pose.ts < 3000;
      const pos = fresh ? { x: pose.x, y: pose.y, z: pose.z } : b.pos ? { x: b.pos.x + 0.5, y: b.pos.y, z: b.pos.z + 0.5 } : null;
      const action = b.currentAction || st.currentAction || null;
      const args = b.currentArgs || null;
      const started = s?.current?.started || 0;
      const cnt = started ? counterFor(b.name, started) : null;
      const at = actionText({ action, args, online: b.online, status: b.status, counter: cnt, ghosts: ghosts.list, bot: b.name, dead: !!st.dead });
      const color = botColor(b.name);
      return {
        name: b.name, color, colorInt: parseInt(color.slice(1), 16), role: b.role || null, online: b.online, status: b.status,
        pos, bpos: pos ? { x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z) } : null,
        yaw: fresh ? pose.yaw : null, pitch: fresh ? pose.pitch : null, dim: (fresh && pose.dim) || b.dimension || 'overworld',
        health: b.health, food: b.food, held: b.held || null, armor: b.armor || [],
        action, actionArgs: args, actionText: at.text, progress: at.progress, busyMs: b.busyForMs || 0,
        task: claimedTask(b.name), lastChat: lastChat.get(b.name) || null,
        thought: b.lastThought ? String(b.lastThought).slice(0, 240) : null,
        dead: !!st.dead, hostiles: b.hostiles ?? 0,
      };
    });
  }

  // ---------- trails ----------
  function addTrail(name, x, y, z, ts) {
    const l = trails.get(name) || (trails.set(name, []), trails.get(name));
    const last = l[l.length - 1];
    if (last && Math.hypot(last[0] - x, last[1] - y, last[2] - z) < TRAIL_STEP) return;
    const p = [r2(x), r2(y), r2(z), ts];
    l.push(p);
    while (l.length > TRAIL_MAX || (l.length && ts - l[0][3] > TRAIL_AGE_MS)) l.shift();
    (trailNew.get(name) || (trailNew.set(name, []), trailNew.get(name))).push(p);
  }

  // ---------- engine feeds ----------
  bots.on('mod:ledger', (name, ev) => { try { ledger.add({ ...ev, bot: name }); } catch (e) { logErr('ledger add:', e.message); } });
  bots.on('mod:pose', (name, p) => {
    if (!p) return;
    const ts = Date.now();
    poses.set(name, { ...p, ts });
    addTrail(name, p.x, p.y, p.z, ts);
  });
  bots.on('mod:path', (name, p) => {
    const msg = { t: 'path', bot: name, ts: p?.ts || Date.now(), dim: p?.dim || 'overworld', goal: p?.goal || null, points: Array.isArray(p?.points) ? p.points.slice(0, 64) : [], status: p?.status || 'success' };
    paths.set(name, msg);
    sendAll(msg, 'paths');
  });
  bots.on('event', (name, ev) => sendAll({ t: 'event', bot: name, kind: ev?.kind, text: String(ev?.text || '').slice(0, 400), ts: ev?.ts || Date.now() }, 'bots'));

  store.on('change', ({ type, data }) => {
    try {
      if (type === 'msg') {
        if (data?.from) lastChat.set(data.from, { text: data.text, ts: data.ts });
        sendAll({ t: 'chat', msg: chatOut(data) }, 'chat');
      } else if (type === 'board') sendAll({ t: 'board', task: data }, 'board');
      else if (type === 'board_delete') sendAll({ t: 'board', task: { id: data.id }, deleted: true }, 'board');
      else if (type === 'goal') sendAll({ t: 'goal', goal: data }, 'goal');
      else if (type === 'waypoint') sendAll({ t: 'waypoint', waypoint: data }, 'board');
      else if (type === 'waypoint_delete') sendAll({ t: 'waypoint', waypoint: { name: data.name }, deleted: true }, 'board');
      else if (type === 'log') {
        const now = Date.now();
        const l = (logGate.get(data.name) || []).filter((t) => now - t < 1000);
        if (l.length >= 4) { logGate.set(data.name, l); return; }
        l.push(now); logGate.set(data.name, l);
        sendAll({ t: 'log', bot: data.name, kind: data.kind, text: String(data.text || '').slice(0, 300), ts: data.ts }, 'log');
      }
    } catch (e) { logErr('mod-api store change:', e.message); }
  });

  // ---------- sending ----------
  function send(c, msg, topic) {
    if (c.ws.readyState !== 1) return;
    if (topic && c.want && !c.want.has(topic)) return;
    if ((topic === 'bots' || topic === 'trail') && c.ws.bufferedAmount > MAX_BUFFERED) return;
    try { c.ws.send(typeof msg === 'string' ? msg : JSON.stringify(msg)); } catch { /* closed */ }
  }
  function sendAll(msg, topic) {
    if (!clients.size) return;
    const s = JSON.stringify(msg);
    for (const c of clients) send(c, s, topic);
  }
  function ghostsMsgFor(c) {
    const list = ghosts.list.map((g) => {
      if (c.ghostRevs.get(g.id) === g.rev) return summaryOf(g);
      c.ghostRevs.set(g.id, g.rev);
      return g;
    });
    for (const id of [...c.ghostRevs.keys()]) if (!ghosts.list.some((g) => g.id === id)) c.ghostRevs.delete(id);
    return { t: 'ghosts', ghosts: list };
  }

  function initMsg() {
    if (ghosts.dirty) ghosts.refresh();
    return {
      protocol: PROTOCOL, serverTime: Date.now(),
      player: { name: ME, mc: ME_MC },
      bots: botStates(),
      chat: store.messages.slice(-60).map(chatOut),
      board: store.tasks,
      goal: store.goal,
      waypoints: Object.values(store.waypoints || {}),
      ghosts: ghosts.list,
      ledgerRecent: ledger.recent(200),
      photos: photos.slice(0, 20),
      commands: COMMANDS.map((c) => c.name),
      ...(econ ? { econ: econState() } : {}),
    };
  }

  // ---------- economy (MOD_PROTOCOL.md §5): live changes on topic 'econ' ----------
  function econState() {
    try { return econ.state(ME); } catch (e) { logErr('mod-api econ state:', e.message); return null; }
  }
  if (econ) econ.on('econ', (m) => sendAll({ t: 'econ', ...m }, 'econ'));

  // ---------- timers ----------
  const tBots = setInterval(() => {
    if (!clients.size) return;
    try {
      const list = botStates();
      const now = Date.now();
      // trail fallback for bots without pose events (mock engine / HIVE_THREADS=0 handles without the hook)
      for (const b of list) if (b.pos && !(poses.get(b.name) && now - poses.get(b.name).ts < 3000)) addTrail(b.name, b.pos.x, b.pos.y, b.pos.z, now);
      sendAll({ t: 'bots', ts: now, bots: list }, 'bots');
    } catch (e) { logErr('mod-api bots tick:', e.message); }
  }, BOTS_MS);
  const tTrail = setInterval(() => {
    if (!clients.size || !trailNew.size) { trailNew.clear(); return; }
    const out = Object.fromEntries(trailNew);
    trailNew.clear();
    sendAll({ t: 'trail', ts: Date.now(), trails: out }, 'paths');
  }, TRAIL_MS);
  const tLedger = setInterval(() => {
    if (!ledgerBatch.length) return;
    const evs = ledgerBatch; ledgerBatch = [];
    sendAll({ t: 'ledger', events: evs }, 'ledger');
  }, LEDGER_FLUSH_MS);
  let lastGhostScan = 0;
  const tGhost = setInterval(() => {
    const now = Date.now();
    if (!clients.size && !ghosts.dirty) return;
    if (!ghosts.dirty && now - lastGhostScan < GHOST_MS) return;
    lastGhostScan = now;
    try {
      if (ghosts.refresh()) for (const c of clients) send(c, ghostsMsgFor(c), 'ghosts');
    } catch (e) { logErr('mod-api ghosts:', e.message); }
  }, 500);
  for (const t of [tBots, tTrail, tLedger, tGhost]) t.unref?.();

  // ---------- commands ----------
  const cmdCtx = {
    bots, store, ledger, ghosts, botColor, botStates, econ, me: ME, meMc: ME_MC,
    photos: () => photos,
    player: () => player,
    refreshGhosts: () => { ghosts.refresh(); return ghosts.list; },
  };
  async function command(text, p) {
    if (p && typeof p === 'object' && Number.isFinite(Number(p.x))) player = { ...normPlayer(p), ts: Date.now() };
    try {
      return await runCommand(cmdCtx, String(text || ''), p ? normPlayer(p) : player);
    } catch (e) {
      logErr('mod command failed:', e?.stack || e);
      return { ok: false, lines: [[{ text: `error: ${e?.message || e}`, color: '#FF5555' }]] };
    }
  }
  function normPlayer(p) {
    if (!p || !Number.isFinite(Number(p.x))) return null;
    const o = { name: String(p.name || ME_MC).slice(0, 24), x: Number(p.x), y: Number(p.y), z: Number(p.z), dim: String(p.dim || 'overworld').replace('minecraft:', '').replace('the_', '') };
    if (Number.isFinite(Number(p.yaw))) o.yaw = Number(p.yaw);
    if (p.look && Number.isFinite(Number(p.look.x))) o.look = { x: Math.floor(p.look.x), y: Math.floor(p.look.y), z: Math.floor(p.look.z) };
    return o;
  }

  // ---------- HTTP ----------
  const qnum = (v) => (v === undefined || v === '' ? undefined : Number(v));
  route('GET', '/mod/hello', () => ({ ok: true, protocol: PROTOCOL, bots: bots.names(), wsUrl: '/mod', player: { name: ME, mc: ME_MC } }));
  route('GET', '/mod/state', () => initMsg());
  route('GET', '/mod/ledger', ({ query: q }) => {
    const box = ['x1', 'y1', 'z1', 'x2', 'y2', 'z2'].some((k) => q[k] !== undefined) ? { x1: qnum(q.x1), y1: qnum(q.y1), z1: qnum(q.z1), x2: qnum(q.x2), y2: qnum(q.y2), z2: qnum(q.z2) } : null;
    const r = ledger.query({ box, bot: q.bot, since: Number(q.since) || 0, until: Number(q.until) || 0, op: q.op || null, cause: q.cause || null, dim: q.dim || null, build: q.build || null, limit: clamp(q.limit, 1, 5000, 500) });
    return { ok: true, ...r };
  });
  route('GET', '/mod/ledger/at', ({ query: q }) => {
    const x = Number(q.x), y = Number(q.y), z = Number(q.z);
    if (![x, y, z].every(Number.isFinite)) throw new HttpError(400, 'x, y, z are required numbers');
    const dim = q.dim || 'overworld';
    const history = ledger.at(x, y, z, dim);
    return { ok: true, x: Math.floor(x), y: Math.floor(y), z: Math.floor(z), dim, history, last: history.at(-1) || null };
  });
  route('GET', '/mod/ledger/stats', ({ query: q }) => ({ ok: true, minutes: clamp(q.minutes, 1, 100000, 60), ...ledger.stats(Date.now() - clamp(q.minutes, 1, 100000, 60) * 60000) }));
  route('GET', '/mod/ghosts', ({ query: q }) => {
    ghosts.refresh();
    return { ok: true, ghosts: q.blocks === '0' ? ghosts.list.map(summaryOf) : ghosts.list };
  });
  route('GET', '/mod/ghosts/:id', ({ params }) => {
    ghosts.refresh();
    const g = ghosts.get(params.id);
    if (!g) throw new HttpError(404, `no ghost "${params.id}"`);
    return { ok: true, ghost: g };
  });
  route('GET', '/mod/photos', ({ query: q }) => {
    const lim = clamp(q.limit, 1, 200, 30);
    const l = q.bot ? photos.filter((p) => p.agent.toLowerCase() === String(q.bot).toLowerCase()) : photos;
    return { ok: true, photos: l.slice(0, lim) };
  });
  route('GET', '/mod/trails', () => ({ ok: true, trails: Object.fromEntries(trails), paths: Object.fromEntries(paths) }));
  // team-built blocks still standing (engine/protect.js: collect / mine_block / pathfinder never break these)
  route('GET', '/mod/protected', () => ({ ok: true, blocks: ledger.standing() }));
  route('POST', '/mod/command', async ({ body }) => command(body.text, body.player));

  // ---------- WebSocket ----------
  const hostOk = new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);
  const wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 });
  const pinger = setInterval(() => {
    for (const c of clients) {
      if (!c.alive) { try { c.ws.terminate(); } catch { /* */ } clients.delete(c); continue; }
      c.alive = false;
      try { c.ws.ping(); } catch { /* */ }
    }
  }, 15000);
  pinger.unref?.();

  wss.on('connection', (ws) => {
    const c = { ws, want: null, alive: true, ghostRevs: new Map(), name: null };
    clients.add(c);
    log(`overlay mod connected (${clients.size} client${clients.size === 1 ? '' : 's'})`);
    ws.on('pong', () => { c.alive = true; });
    ws.on('close', () => { clients.delete(c); });
    ws.on('error', () => { clients.delete(c); });
    const init = initMsg();
    for (const g of init.ghosts) c.ghostRevs.set(g.id, g.rev);
    send(c, { t: 'init', ...init });
    ws.on('message', async (raw) => {
      c.alive = true;
      let m;
      try { m = JSON.parse(String(raw)); } catch { return send(c, { t: 'error', error: 'invalid JSON' }); }
      if (!m || typeof m !== 'object') return;
      try {
        if (m.t === 'hello') {
          c.name = m.player ? String(m.player).slice(0, 24) : null;
          if (Array.isArray(m.want) && m.want.length) c.want = new Set(m.want.filter((t) => TOPICS.includes(t)));
          send(c, { t: 'hello_ok', protocol: PROTOCOL, serverTime: Date.now() });
        } else if (m.t === 'player') {
          const p = normPlayer(m);
          if (p) player = { ...p, ts: Date.now() };
        } else if (m.t === 'command') {
          const r = await command(m.text, m.player);
          send(c, { t: 'command_result', id: m.id ?? null, ...r });
        } else if (m.t === 'ping') {
          send(c, { t: 'pong', id: m.id ?? null, serverTime: Date.now() });
        } else if (m.t === 'ghosts') {
          ghosts.refresh();
          c.ghostRevs.clear();
          send(c, ghostsMsgFor(c));
        }
      } catch (e) {
        logErr('mod ws message:', e?.message || e);
        send(c, { t: 'error', error: String(e?.message || e) });
      }
    });
  });

  return {
    ledger,
    ghosts,
    clients,
    /** viewer routes' broadcast (photo events) */
    onBroadcast(type, data) {
      if (type !== 'photo' || !data?.id) return;
      const p = photoOut(data);
      photos = [p, ...photos.filter((x) => x.id !== p.id)].slice(0, 200);
      sendAll({ t: 'photo', photo: p }, 'photos');
    },
    /** after an action: blueprint_preview results become preview ghosts; blueprint_build drops them */
    onAct(name, body, out) {
      try {
        const action = body?.action;
        if (action === 'blueprint_preview' && out?.ok) { if (ghosts.addPreview(name, body.args || {}, out.result)) ghosts.dirty = true; }
        else if (action === 'blueprint_build') { ghosts.dropPreviewsFor(body.args || {}); ghosts.dirty = true; }
      } catch (e) { logErr('mod-api onAct:', e.message); }
    },
    attach(server) {
      server.on('upgrade', (req, socket, head) => {
        let pathname = '';
        try { pathname = new URL(req.url, 'http://x').pathname; } catch { /* */ }
        const bad = (code, why) => { try { socket.end(`HTTP/1.1 ${code} ${why}\r\nConnection: close\r\n\r\n`); } catch { /* */ } };
        // not ours: refuse it unless another upgrade handler is installed (none today), so it can't hang
        if (pathname !== '/mod' && pathname !== '/mod/') { if (server.listenerCount('upgrade') <= 1) bad(404, 'Not Found'); return; }
        if (req.headers.host && !hostOk.has(req.headers.host)) return bad(403, 'Forbidden');
        const origin = req.headers.origin;
        if (origin) {
          try { if (!hostOk.has(new URL(origin).host)) return bad(403, 'Forbidden'); } catch { return bad(403, 'Forbidden'); }
        }
        wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
      });
    },
    async close() {
      for (const t of [tBots, tTrail, tLedger, tGhost, pinger]) clearInterval(t);
      for (const c of clients) { try { c.ws.close(1001, 'bridge shutting down'); } catch { /* */ } }
      clients.clear();
      await new Promise((r) => wss.close(() => r()));
      ledger.close();
    },
  };
}
