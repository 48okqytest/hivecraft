#!/usr/bin/env node
// Hivecraft MCP server — ONE Minecraft bot per process (env HIVE_BOT), talking to the bridge over HTTP.
// Registers every engine action from GET /actions plus the team tools. Logs go to stderr only (stdout = MCP).
import fs from 'node:fs';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { makeViewerTools } from './viewer-tools.js';
import { makeEconTools } from './econ-tools.js';
import { bridgeUrl, playerDisplayName, isPlayerName } from '../bridge/config.js';

const BOT = process.env.HIVE_BOT;
const URL_BASE = bridgeUrl(); // HIVE_URL, else the config's bridge port
const PLAYER = playerDisplayName(); // the human (hivecraft.config.json player.displayName; HIVE_PLAYER_NAME)
const CURSOR_FILE = process.env.HIVE_CURSOR_FILE || '';   // optional: persist the message cursor across relaunches
const log = (...a) => console.error('[mc-mcp]', ...a);
if (!BOT) { log('HIVE_BOT env var is required'); process.exit(1); }

// ---------- http ----------
async function http(method, path, body, timeoutMs = 20000) {
  const res = await fetch(URL_BASE + path, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let data; try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) {
    const msg = (data && typeof data === 'object' && (data.error || data.message)) || (typeof data === 'string' && data) || `HTTP ${res.status}`;
    const e = new Error(msg); e.status = res.status; e.data = data; throw e;
  }
  return data;
}
const get = (p, t) => http('GET', p, undefined, t);
const post = (p, b, t) => http('POST', p, b ?? {}, t);
const enc = encodeURIComponent;
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------- message cursor ----------
let cursor = 0;
try { if (CURSOR_FILE) cursor = Number(JSON.parse(fs.readFileSync(CURSOR_FILE, 'utf8')).cursor) || 0; } catch { /* first run */ }
function setCursor(c) {
  if (c == null || Number(c) <= cursor) return;
  cursor = Number(c);
  try { if (CURSOR_FILE) fs.writeFileSync(CURSOR_FILE, JSON.stringify({ cursor })); } catch { /* ignore */ }
}

// ---------- formatting ----------
const SERVICE = new Set(['system', 'Market']); // hub services, not humans (Market = economy notices: sales, outbids, auctions)
const trunc = (s, n) => (s.length > n ? s.slice(0, n) + `… [+${s.length - n} chars]` : s);
const asText = v => (typeof v === 'string' ? v : JSON.stringify(v));
function fmtMsg(m) {
  const to = m.to === BOT ? 'you' : m.to;
  const tag = m.from === 'system' ? '[system]' : m.from === 'Market' ? '[💰Market]' : `[${m.from}→${to}]`;
  const human = !SERVICE.has(m.from) && botNamesAt && !botNames.has(m.from) ? ` ⚠HUMAN (${PLAYER}) — answer them first` : (isPlayerName(m.from) ? ' ⚠HUMAN BOSS — answer them first' : '');
  return `${tag} ${m.text}${human}`;
}
const pos = p => (p ? `${p.x},${p.y},${p.z}` : '?');
const ECON_ON = process.env.HIVE_ECONOMY !== '0';
/** bounty part of a task line: " 💰30" while open, " 💰30 paid to Flint" after */
const fmtReward = t => (!ECON_ON || !t.reward && t.rewardStatus !== 'refunded' ? '' : t.rewardStatus === 'paid' ? ` 💰${t.reward} paid to ${t.rewardTo}` : t.rewardStatus === 'refunded' ? ' (bounty refunded)' : ` 💰${t.reward} bounty`);
function fmtTask(t) {
  const notes = (t.notes || []).slice(-2).map(n => (typeof n === 'string' ? n : `${n.by || ''}: ${n.text || n.note || ''}`)).join(' | ');
  return `#${t.id} [${t.status}${t.owner ? ':' + t.owner : ''}] ${t.priority != null ? 'P' + t.priority + ' ' : ''}${t.title}${fmtReward(t)}` +
    (t.detail ? ` — ${trunc(t.detail, 200)}` : '') + (notes ? `  (notes: ${trunc(notes, 160)})` : '') + (t.by ? `  (by ${t.by})` : '');
}
const fmtVitals = s => (s && s.pos ? `[hp ${s.health} food ${s.food} @${pos(s.pos)} ${s.dimension === 'overworld' || !s.dimension ? '' : s.dimension + ' '}holding ${s.held || 'nothing'}${s.time && s.time.isDay === false ? ' NIGHT' : ''}]` + (Array.isArray(s.warnings) && s.warnings.length ? `\n⚠ ${s.warnings.join(' | ')}` : '') : '');

// names of the bot team (so we can tell human messages apart); refreshed every 60 s
let botNames = new Set(); let botNamesAt = 0;
async function teamNames() {
  if (Date.now() - botNamesAt > 60000) {
    try { const b = await get('/bots', 4000); botNames = new Set((b || []).map(x => x.name)); botNamesAt = Date.now(); } catch { /* keep old */ }
  }
  return botNames;
}
const isHuman = (from, names) => !SERVICE.has(from) && !names.has(from);
async function unreadLine() {
  try {
    const r = await get(`/unread/${enc(BOT)}?since=${cursor}`, 5000);
    const n = r && r.count || 0;
    if (!n) return '📭 no unread messages';
    // show messages from the human (the player / in-game players) inline so they are never missed
    let inline = '';
    try {
      const names = await teamNames();
      const m = await get(`/msg/${enc(BOT)}?since=${cursor}&wait=0`, 5000);
      const hum = (m && m.messages || []).filter(x => isHuman(x.from, names)).slice(-3);
      if (hum.length) inline = '\n🔔 FROM THE HUMAN (answer/act on this first): ' + hum.map(x => `${x.from}: "${trunc(x.text, 300)}"`).join(' | ');
    } catch { /* inline preview is best-effort */ }
    return `📨 ${n} unread message${n === 1 ? '' : 's'} — call check_messages${inline}`;
  } catch { return ''; }
}

// ---------- tool definitions ----------
const obj = (properties = {}, required = []) => ({ type: 'object', properties, ...(required.length ? { required } : {}) });
const str = description => ({ type: 'string', description });
const num = description => ({ type: 'number', description });

// Extra advice appended to engine action descriptions (the engine owns the base description).
const ACTION_HINTS = {
  goto: 'Long trips are fine (it hops by itself; if it returns progress, call it again). Use waypoints() for saved places. Stuck / No path / underground: call escape.',
  collect: 'Give the block name (e.g. oak_log, cobblestone, iron_ore, coal_ore); it finds, mines and picks up drops. Collect in batches of ~5-16 and read the result (inventory count) — don\'t assume success.',
  craft: 'If it fails the error says what is missing and where to get it. Use craft_plan first for anything new. Keep a free inventory slot.',
  smelt: 'Needs a furnace (or it places one if you carry it) plus fuel (coal, charcoal, planks). Raw iron → iron_ingot.',
  sleep: 'Only works at night/thunder with a bed nearby; sets spawn. Everyone sleeping through the night is safest.',
  chest_deposit: 'Use at the team base chest (see waypoints). Omitting items deposits everything except tools/food.',
  chest_view: 'Look before you withdraw; tell teammates what is stored via note_write or chat.',
  run_code: 'Escape hatch for anything the other actions can\'t do. To LOOK use look_around / nearest / inventory / blocks_at instead; doors/levers: use_block; hoe/bucket/shears: use_item. Keep scripts short.',
  attack: 'For food animals prefer hunt (reachable target, lures, picks up drops).',
  wait: 'Prefer check_messages(wait_seconds) when waiting for teammates — it wakes when someone speaks.',
  stop: 'Aborts the current action. Call this before starting a different action if the bot is busy.',
};

const TEAM_TOOLS = [
  {
    name: 'status', description: 'Your own bot state: position, health, food, time of day, held item, inventory, armor, nearby entities/blocks, current action. Call it after long actions or when deciding what to do next.',
    inputSchema: obj(),
    run: async () => asText(await get(`/bots/${enc(BOT)}/state`)),
  },
  {
    name: 'team_status', description: 'Where every teammate is and what they are doing (online, position, health, food, current action). Check before asking for help or deciding who should do a task.',
    inputSchema: obj(),
    run: async () => {
      const bots = await get('/bots');
      return (bots || []).map(b => `${b.name}${b.name === BOT ? ' (you)' : ''} [${b.role || '?'}] ${b.online ? 'online' : 'OFFLINE'} @${pos(b.pos)} hp ${b.health} food ${b.food} doing: ${b.currentAction || 'idle'}`).join('\n') || 'No bots registered.';
    },
  },
  {
    name: 'send_message', description: 'Message the teammate(s) who need to hear it: "to" = one name ("Flint") or a few names separated by commas ("Flint,Wren"). Use "all" ONLY for real announcements that concern everyone (the plan for ' + PLAYER + '\'s task, base location, danger) — not for status chatter. Keep it SHORT (one line), include coordinates and item counts: "Flint: iron at 120,40,-33 if you need it" / "Wren, can you bring 8 cobblestone to base?". Don\'t narrate every step and don\'t repeat yourself. Reply to ' + PLAYER + ' with to:"' + PLAYER + '".',
    inputSchema: obj({ to: str('who needs it: "Flint", "Flint,Wren", "' + PLAYER + '"; "all" only for announcements'), text: str('one short line with coordinates/counts') }, ['to', 'text']),
    run: async a => { await post('/msg', { from: BOT, to: a.to || 'all', text: String(a.text || '').slice(0, 500) }); return `Sent to ${a.to || 'all'}.`; },
  },
  {
    name: 'check_messages', description: 'Read new messages from teammates, ' + PLAYER + ' (human) and game events. Long-polls: with wait_seconds (default 20, max 60) it returns as soon as something arrives, so USE THIS INSTEAD OF IDLING when you are waiting for someone. Call it between long actions. If ' + PLAYER + ' speaks, answer them right away.',
    inputSchema: obj({ wait_seconds: num('seconds to wait for new messages (0-60, default 20); 0 = check instantly') }),
    run: async a => {
      const w = Math.max(0, Math.min(60, a.wait_seconds == null ? 20 : Number(a.wait_seconds) || 0));
      const r = await get(`/msg/${enc(BOT)}?since=${cursor}&wait=${w}`, (w + 10) * 1000);
      const msgs = (r && r.messages) || [];
      setCursor(r && r.cursor != null ? r.cursor : msgs.reduce((m, x) => Math.max(m, x.id || 0), cursor));
      if (!msgs.length) return `No new messages${w ? ` (waited ${w}s)` : ''}.`;
      const shown = msgs.slice(-40);
      return (msgs.length > shown.length ? `(${msgs.length - shown.length} older messages skipped)\n` : '') + shown.map(fmtMsg).join('\n');
    },
    noUnread: false,
  },
  {
    name: 'board', description: 'The shared task board: open/claimed/done/blocked tasks with owners. Look at it when you start, when you finish something, and when idle — pick the highest-priority open task that matches your role.',
    inputSchema: obj({ status: str('optional filter: open | claimed | done | blocked') }),
    run: async a => {
      let tasks = (await get('/board')) || [];
      if (a.status) tasks = tasks.filter(t => t.status === a.status);
      else tasks = tasks.filter(t => t.status !== 'done').concat(tasks.filter(t => t.status === 'done').slice(-5));
      return tasks.length ? tasks.map(fmtTask).join('\n') : 'Board is empty.';
    },
  },
  {
    name: 'board_add', description: 'Add a task to the shared board (title short and concrete, e.g. "Mine 24 iron ore", detail with where/why/target counts). The lead plans the whole goal as tasks; anyone may add tasks they discover. Priority 1 = most urgent.' + (ECON_ON ? ' Optional reward = coins from YOUR wallet, held until the task is done and then paid to whoever claimed and finished it (a bounty).' : ''),
    inputSchema: obj({ title: str('short, concrete, with a target count'), detail: str('where/how/why, coordinates'), priority: num('1 (urgent) .. 5 (someday)'),
      ...(ECON_ON ? { reward: { type: ['integer', 'string'], description: 'optional bounty in coins (held from your wallet until done)' } } : {}) }, ['title']),
    run: async a => {
      const reward = ECON_ON && a.reward != null && a.reward !== '' && Number(a.reward) !== 0 ? (Number.isFinite(Number(a.reward)) ? Number(a.reward) : a.reward) : undefined;
      const t = await post('/board', { by: BOT, title: a.title, detail: a.detail, priority: a.priority, ...(reward !== undefined ? { reward } : {}) });
      if (reward === undefined) return fmtTask(t);
      let bal = '';
      try { const s = await get(`/econ/state?who=${enc(BOT)}`); if (s && s.me) bal = `
💰 balance: ${s.me.balance} coins`; } catch { /* the task is posted anyway */ }
      return `${fmtTask(t)}
The ${reward} coins are held until it is done, then paid to whoever finishes it.${bal}`;
    },
  },
  {
    name: 'board_claim', description: 'Claim an OPEN task BEFORE you start working on it so nobody duplicates it. Fails if a teammate already claimed it — then pick another task. One claimed task at a time.',
    inputSchema: obj({ id: { type: ['number', 'string'], description: 'task id' } }, ['id']),
    run: async a => fmtTask(await post(`/board/${enc(a.id)}/claim`, { by: BOT })),
  },
  {
    name: 'board_update', description: 'Update a task you own: status (done | blocked | open to release it) and a short note with the RESULT ("done: 12 iron ingots in base chest"). Mark done as soon as you finish, then tell the team in chat and pick the next task. Use owner to hand a task over.',
    inputSchema: obj({ id: { type: ['number', 'string'], description: 'task id' }, status: str('open | claimed | done | blocked'), note: str('short result or blocker'), owner: str('optional: reassign to a teammate') }, ['id']),
    run: async a => fmtTask(await post(`/board/${enc(a.id)}`, { by: BOT, status: a.status, note: a.note, owner: a.owner })),
  },
  {
    name: 'notes', description: 'Read the shared team knowledge base (facts anyone wrote with note_write: where things are, recipes learned, dangers, base layout). Read it at the start.',
    inputSchema: obj(),
    run: async () => {
      const n = await get('/notes');
      const list = Array.isArray(n) ? n : Object.entries(n || {}).map(([key, v]) => ({ key, ...(typeof v === 'object' ? v : { text: v }) }));
      return list.length ? list.map(x => `• ${x.key}${x.by ? ` (${x.by})` : ''}: ${x.text}`).join('\n') : 'No notes yet.';
    },
  },
  {
    name: 'note_write', description: 'Write/replace a shared team note under a short key (e.g. "base-layout", "iron-location", "danger-lava-cave"). For durable facts the whole team needs; not for chat. Re-using a key overwrites it.',
    inputSchema: obj({ key: str('short key'), text: str('the fact, with coordinates') }, ['key', 'text']),
    run: async a => { await post('/notes', { by: BOT, key: a.key, text: a.text }); return `Note "${a.key}" saved.`; },
  },
  {
    name: 'waypoints', description: 'List the team\'s named places (base, chest, farm, mine, iron, village...). Use these with goto instead of remembering coordinates.',
    inputSchema: obj(),
    run: async () => {
      const w = await get('/waypoints');
      const list = Array.isArray(w) ? w : Object.entries(w || {}).map(([name, v]) => ({ name, ...v }));
      return list.length ? list.map(p => `• ${p.name}: ${p.x},${p.y},${p.z}${p.note ? ` — ${p.note}` : ''}${p.by ? ` (${p.by})` : ''}`).join('\n') : 'No waypoints yet.';
    },
  },
  {
    name: 'waypoint_save', description: 'Save a named place. With no x/y/z it saves YOUR CURRENT POSITION — stand at the spot and call it. Save: base, base_chest (stand next to it), farm, mine entrance, ore finds, villages, dangers. Teammates can goto any waypoint.',
    inputSchema: obj({ name: str('short name, e.g. base_chest, iron_cave'), x: num('optional, default current x'), y: num('optional, default current y'), z: num('optional, default current z'), note: str('optional short note') }, ['name']),
    run: async a => {
      let { x, y, z } = a;
      if (x == null || y == null || z == null) {
        const s = await get(`/bots/${enc(BOT)}/state`);
        x = x ?? Math.floor(s.pos.x); y = y ?? Math.floor(s.pos.y); z = z ?? Math.floor(s.pos.z);
      }
      await post('/waypoints', { by: BOT, name: a.name, x: Math.round(x), y: Math.round(y), z: Math.round(z), note: a.note });
      return `Waypoint "${a.name}" saved at ${Math.round(x)},${Math.round(y)},${Math.round(z)}.`;
    },
  },
  {
    name: 'memory_read', description: 'Read YOUR private persistent memory (survives restarts of your session). Read it first thing after a restart.',
    inputSchema: obj(),
    run: async () => {
      const m = await get(`/memory/${enc(BOT)}`);
      const t = typeof m === 'string' ? m : (m && (m.text ?? m.memory)) || '';
      return t.trim() ? t : '(memory is empty)';
    },
  },
  {
    name: 'memory_save', description: 'REPLACE your private memory with a compact summary: current task, what you have/need, key coordinates, lessons, what teammates are doing. Save before any long task and after milestones — if your session restarts this is all you will remember. Keep under ~30 lines.',
    inputSchema: obj({ text: str('the full new memory text') }, ['text']),
    run: async a => { await post(`/memory/${enc(BOT)}`, { text: String(a.text || '') }); return 'Memory saved.'; },
  },
  {
    name: 'goal', description: 'The team\'s overall goal (set by ' + PLAYER + '). Re-read it when unsure what matters.',
    inputSchema: obj(),
    run: async () => { const g = await get('/goal'); return (typeof g === 'string' ? g : g && g.text) || '(no goal set)'; },
  },
  {
    name: 'set_goal', description: 'Record the team task ' + PLAYER + ' just gave (in their words, plus a one-line plan). Only do this when ' + PLAYER + ' gives or changes the task; it is what everyone (and restarted sessions) will read with `goal`.',
    inputSchema: obj({ text: { type: 'string', description: 'the task, e.g. "' + PLAYER + ': build a castle on the hill at 40,70,10. Plan: ..."' } }, ['text']),
    run: async ({ text }) => { await post('/goal', { text, by: BOT }); return `Team goal set: ${text}`; },
  },
];

// ---------- viewer (image tools: view, team_map, photo_share, photo_view) ----------
const VIEWER = makeViewerTools({ BOT, URL_BASE, get, post, enc, trunc, PLAYER });

// ---------- economy (coins: wallet, pay, server shop, market, auctions) ----------
const ECON = makeEconTools({ BOT, get, post, enc, PLAYER });

// ---------- engine actions ----------
let ACTION_TOOLS = [];
async function loadActions() {
  const deadline = Date.now() + 30000;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      const acts = await get('/actions', 5000);
      if (Array.isArray(acts) && acts.length) return acts;
      lastErr = new Error('empty /actions');
    } catch (e) { lastErr = e; }
    await sleep(1000);
  }
  throw new Error(`bridge at ${URL_BASE} did not answer GET /actions within 30s (${lastErr && lastErr.message})`);
}

function actionTool(a) {
  const schema = JSON.parse(JSON.stringify(a.params || { type: 'object', properties: {} }));
  if (!schema.type) schema.type = 'object';
  schema.properties = schema.properties || {};
  if (a.name !== 'stop' && !schema.properties.interrupt) {
    schema.properties.interrupt = { type: 'boolean', description: 'set true to cancel whatever the bot is currently doing and run this instead (default: error if busy)' };
  }
  const hint = ACTION_HINTS[a.name];
  return {
    name: a.name,
    description: `${a.description || a.name}${hint ? ' ' + hint : ''}`,
    inputSchema: schema,
    run: async (args, extra) => {
      if (a.name === 'stop') { await post(`/bots/${enc(BOT)}/stop`); return 'Stopped current action.'; }
      const { interrupt, ...rest } = args || {};
      const timeoutMs = 180000;
      const r = await post(`/bots/${enc(BOT)}/act`, { action: a.name, args: rest, timeoutMs, interrupt: !!interrupt }, timeoutMs + 20000);
      if (!r || r.ok === false) {
        const err = new Error((r && r.error) || 'action failed');
        err.engine = true;
        throw err;
      }
      // {text, view:{...}} results (e.g. blueprint_preview) are rendered into an image here
      const res = await VIEWER.expandActionResult(r.result);
      const images = res && typeof res === 'object' && Array.isArray(res.images) ? res.images : [];
      let out = res == null ? 'Done.' : asText(images.length ? res.text : res);
      out = trunc(out, 6000);
      let vit = '';
      try { vit = fmtVitals(await get(`/bots/${enc(BOT)}/state`, 4000)); } catch { /* ignore */ }
      out = vit ? `${out}\n${vit}` : out;
      return images.length ? { text: out, images } : out;
    },
  };
}

// ---------- server ----------
const server = new Server({ name: 'hivecraft-mc', version: '0.1.0' }, { capabilities: { tools: {} } });
let ALL = new Map();

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [...ALL.values()].map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
}));

server.setRequestHandler(CallToolRequestSchema, async req => {
  const { name, arguments: args } = req.params;
  const tool = ALL.get(name);
  if (!tool) return { isError: true, content: [{ type: 'text', text: `Unknown tool "${name}".` }] };
  let text, isError = false, images = [];
  try {
    text = await tool.run(args || {});
    if (text && typeof text === 'object') { images = Array.isArray(text.images) ? text.images : []; text = text.text ?? ''; }
  } catch (e) {
    isError = true;
    let msg = e && e.message || String(e);
    if (e && e.name === 'TimeoutError') msg = `Timed out talking to the bridge (${name}). The action may still be running — call status, or stop.`;
    else if (e && e.cause && e.cause.code === 'ECONNREFUSED') msg = `Bridge not reachable at ${URL_BASE} (connection refused). Wait a few seconds and retry.`;
    else if (e && e.status === 409) msg = `Conflict: ${msg}`;
    text = String(msg).startsWith('busy') ?`${msg} — call stop first, or pass interrupt:true.` : `Error: ${msg}`;
    log(`${name} failed:`, msg);
    // stuck / can't get there: show the agent the spot instead of making it guess from text
    if (e && e.engine && /stuck|no path|unreachable|can't reach|cannot reach|could not reach|timed out|trapped|boxed in/i.test(msg)) {
      try {
        const v = await VIEWER.lookHere('where you are stuck (orbit, highlight on)');
        if (v) { images = v.images; text += `\n${v.text}\nLOOK at the picture: find the wall/gap/water in the way, then goto around it, escape, or mine_block the block in the way.`; }
      } catch { /* picture is a bonus; the error text stands on its own */ }
    }
  }
  const unread = await unreadLine();
  const shared = await VIEWER.sharedPhoto(); // a teammate's shared photo rides along with this result
  const content = [{ type: 'text', text: `${trunc(String(text), 8000)}${unread ? `\n${unread}` : ''}${shared ? `\n${shared.text}` : ''}` }];
  for (const im of images) if (im && im.data) content.push({ type: 'image', data: im.data, mimeType: im.mimeType || 'image/png' });
  if (shared) content.push({ type: 'image', data: shared.image.data, mimeType: shared.image.mimeType });
  return { isError, content };
});

async function main() {
  let acts;
  try { acts = await loadActions(); } catch (e) { log(e.message); process.exit(2); }
  ACTION_TOOLS = acts.filter(a => a && a.name && !a.internal && !String(a.name).startsWith('_')).map(actionTool);
  for (const t of [...ACTION_TOOLS, ...VIEWER.tools, ...(process.env.HIVE_ECONOMY === '0' ? [] : ECON.tools), ...TEAM_TOOLS]) ALL.set(t.name, t); // team tools win a name clash
  log(`bot=${BOT} bridge=${URL_BASE} tools=${ALL.size} (${ACTION_TOOLS.length} actions + ${TEAM_TOOLS.length} team) cursor=${cursor}`);
  await server.connect(new StdioServerTransport());
}
main().catch(e => { log('fatal', e); process.exit(1); });
