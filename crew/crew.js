#!/usr/bin/env node
// Hivecraft crew launcher: runs one headless Claude Code session per bot (model claude-sonnet-5-5) that
// plays through the mcp/mc-mcp.js tools. Relaunches sessions that end, resumes or reseeds from memory.
//   node crew/crew.js [--agents 3] [--minutes 60] [--goal "..."] [--url http://127.0.0.1:47960] [--model ...]
//                     [--max-resumes 3] [--stagger 6] [--roster crew/roster.json] [--effort low|medium|high]
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, bridgeUrl, claudeSpawn, fillTemplate } from '../bridge/config.js';
import { providerSetup } from './providers.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d; };
const has = k => argv.includes('--' + k);

const roster = JSON.parse(fs.readFileSync(path.resolve(arg('roster', path.join(HERE, 'roster.json'))), 'utf8'));
const CFG = loadConfig(); // hivecraft.config.json (bridge/config.js): player name, bridge port, claude path
const BASE = (arg('url', bridgeUrl(CFG))).replace(/\/+$/, '');
// AI provider (config provider + HIVE_PROVIDER_KEY from Hivecraft.exe) -> per-agent env + --model; no config file = env untouched
const PROV = providerSetup(CFG, process.env);
const MODEL = arg('model', (PROV.provider.kind !== 'inherit' && PROV.provider.model) || roster.model || 'claude-sonnet-5-5');
const MINUTES = Number(arg('minutes', 0));                       // 0 = run until Ctrl-C
const N = Math.max(1, Number(arg('agents', 3)));
const MAX_RESUMES = Number(arg('max-resumes', roster.maxResumes ?? 3));
const STAGGER = Number(arg('stagger', roster.staggerSeconds ?? 6)) * 1000;
const EFFORT = arg('effort', roster.effort || '');
const GOAL_ARG = arg('goal', '');
const DEFAULT_GOAL = roster.goal || 'Survive and thrive together.';
const CLAUDE_CMD = claudeSpawn(CFG); // CLAUDE_BIN / config runtime.claude, else PATH, ~/.local/bin, npm global (null = not found)
const CLAUDE = CLAUDE_CMD ? CLAUDE_CMD.command : '';
// the human: what the agents call them (player.displayName) and their Minecraft name (player.mcName)
const PLAYER = CFG.player.displayName, PLAYER_MC = CFG.player.mcName || CFG.player.displayName;
const P = { player: PLAYER, playerMc: PLAYER_MC, PLAYER: PLAYER.toUpperCase() };
const MCP_JS = path.join(ROOT, 'mcp', 'mc-mcp.js');
const WORK = path.join(HERE, 'work'), LOGS = path.join(HERE, 'logs'), PROMPTS = path.join(HERE, 'prompts');
fs.mkdirSync(WORK, { recursive: true }); fs.mkdirSync(LOGS, { recursive: true });

// ---- agents ----
// --names A,B,C: custom players with NO roles (they decide what to do by talking; prompt teammate.md).
// Otherwise the classic roster with fixed roles.
const NAMES_ARG = arg('names', '');
let agents;
if (NAMES_ARG) {
  const list = [...new Set(NAMES_ARG.split(',').map(s => s.trim()).filter(Boolean))];
  const bad = list.filter(n => !/^[A-Za-z0-9_]{3,16}$/.test(n));
  if (bad.length) { console.error(`Invalid Minecraft name(s): ${bad.join(', ')} (3-16 letters, digits or _)`); process.exit(2); }
  agents = list.map(name => ({ name, role: '', prompt: 'teammate.md', open: true }));
} else {
  const base = roster.agents || [];
  agents = base.slice(0, N).map(a => ({ ...a }));
  for (let i = 0; agents.length < N; i++) agents.push({ ...(roster.overflow?.[i] || { name: `Bot${agents.length + 1}`, role: 'Gatherer', prompt: 'gatherer.md' }) });
}
const names = agents.map(a => a.name);

// --personas file.json: {"Ash":"grumpy perfectionist", ...} (optional; missing/bad file = no personalities)
const PERSONAS_ARG = arg('personas', '');
let personas = {};
if (PERSONAS_ARG) {
  try { personas = JSON.parse(fs.readFileSync(path.resolve(PERSONAS_ARG), 'utf8')) || {}; } catch (e) { console.error(`personas file ignored: ${e.message}`); }
}
for (const a of agents) {
  const key = Object.keys(personas).find(k => k.toLowerCase() === a.name.toLowerCase());
  const p = key ? String(personas[key] || '').trim().slice(0, 300) : '';
  if (p) a.persona = p;
}

// ---- http ----
async function http(method, p, body, timeoutMs = 10000) {
  const res = await fetch(BASE + p, { method, headers: body !== undefined ? { 'content-type': 'application/json' } : undefined, body: body !== undefined ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(timeoutMs) });
  const t = await res.text(); let d; try { d = t ? JSON.parse(t) : null; } catch { d = t; }
  if (!res.ok) throw new Error(`${method} ${p} -> ${res.status} ${t.slice(0, 200)}`);
  return d;
}
const safe = async (fn, dflt = null) => { try { return await fn(); } catch { return dflt; } };
const postLog = (name, kind, text) => safe(() => http('POST', `/log/${encodeURIComponent(name)}`, { kind, text: String(text).slice(0, 1500) }, 4000));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const trunc = (s, n) => (s.length > n ? s.slice(0, n) + '…' : s);
const stamp = () => new Date().toTimeString().slice(0, 8);
const say = (name, msg) => console.log(`${stamp()} [${name}] ${msg}`);

// ---- prompts ----
const readPrompt = f => fillTemplate(fs.readFileSync(path.join(PROMPTS, f), 'utf8').trim(), P); // {{player}} {{playerMc}} {{PLAYER}}
function systemPrompt(a, goal) {
  const others = agents.filter(x => x.name !== a.name).map(x => (x.open ? x.name : `${x.name} (${x.role})`));
  return teamPrompt().replaceAll('{{name}}', a.name).replaceAll('{{role}}', a.role)
    .replaceAll('{{teammates}}', others.length ? others.join(', ') : 'none yet').replaceAll('{{goal}}', goal)
    + '\n\n' + readPrompt(a.prompt || 'gatherer.md')
    + (a.persona ? `\n\nYOUR PERSONALITY: ${a.persona}\nStay in character: it should show in how you talk in chat (word choice, jokes, attitude) and in what you like to do. But it never stops you from being a good teammate or from doing what ${PLAYER} asks. Keep messages short even in character.` : '');
}
const START_PROMPT = a => a.open
  ? `You just joined the world as ${a.name}. Your teammates: ${names.filter(n => n !== a.name).join(', ') || 'none'}. There are no roles. Say hi in ONE short line, then WAIT for ${PLAYER}'s task: do nothing in the world, just call check_messages(wait_seconds=60) repeatedly until they tell the team what to do. When they do, decide together in chat who does what, then work. Keep playing until stopped; do not end your turn.`
  : `The game is live. You are ${a.name} (${a.role}). Start now: call memory_read, goal, board, notes, waypoints and team_status once to orient yourself, then check_messages(wait_seconds=0), then begin working on your role. Keep playing until stopped; do not end your turn.`;
// --continue: pick up each agent's previous Claude session (same conversation) after a restart
const CONTINUE = has('continue');
// economy off (HIVE_ECONOMY=0, Hivecraft.exe setting): drop the ECONOMY section so agents don't look for coins
function teamPrompt() {
  const t = readPrompt('team.md');
  if (process.env.HIVE_ECONOMY !== '0') return t;
  const NL = String.fromCharCode(10);
  const lines = t.split(NL);
  const i = lines.findIndex((l) => l.startsWith('ECONOMY'));
  if (i < 0) return t;
  let j = i + 1;
  while (j < lines.length && lines[j].startsWith('- ')) j++;
  lines.splice(i, j - i);
  return lines.join(NL);
}

const CONTINUE_PROMPT = `The game server was just restarted (${PLAYER} may have changed a setting) and you have been reconnected to the SAME world, with your inventory and your full memory of everything so far. Call status and check_messages(wait_seconds=0) to re-orient (things near you may have shifted slightly), then carry on exactly where you left off: same task, same plans, same relationships and personality. Do not end your turn.`;
function savedSession(name) {
  try { const j = JSON.parse(fs.readFileSync(path.join(WORK, name, 'session.json'), 'utf8')); if (j.session) return j.session; } catch { /* fall back to the log */ }
  try {
    const lines = fs.readFileSync(path.join(LOGS, `${name}.jsonl`), 'utf8').trim().split(/\r?\n/);
    for (let i = lines.length - 1; i >= 0 && i >= lines.length - 5000; i--) {
      const m = /"session_id":"([0-9a-f-]{36})"/.exec(lines[i]);
      if (m) return m[1];
    }
  } catch { /* no log */ }
  return null;
}
const RESUME_PROMPT = `Keep playing. Your previous turn ended. Call check_messages(wait_seconds=0), board and status to catch up, then continue your task. Do not end your turn.`;
const freshPrompt = (a, memory) => `You are RESTARTING with a fresh session (you lost your conversation, but the world, team and board continue). Your saved private memory:\n---\n${memory || '(empty)'}\n---\nCall check_messages(wait_seconds=0), board, status and waypoints to catch up, then continue your work. Keep playing until stopped; do not end your turn.`;

// ---- children ----
const TOOLS = ['mcp__mc'];  // whole mc MCP server; built-in tools are removed with --tools ""
const state = {};           // name -> { proc, session, resumes, lastStart, failures, cost, turns }
let stopping = false;
const startedAt = Date.now();

function writeMcpConfig(a) {
  const dir = path.join(WORK, a.name); fs.mkdirSync(dir, { recursive: true });
  const cfg = { mcpServers: { mc: { command: process.execPath, args: [MCP_JS], env: { HIVE_BOT: a.name, HIVE_URL: BASE, HIVE_CURSOR_FILE: path.join(dir, 'cursor.json'), HIVE_ECONOMY: process.env.HIVE_ECONOMY === '0' ? '0' : '1', HIVE_PLAYER: PLAYER_MC, HIVE_PLAYER_NAME: PLAYER, ...(process.env.HIVE_CONFIG ? { HIVE_CONFIG: process.env.HIVE_CONFIG } : {}) } } } };
  const f = path.join(dir, 'mcp.json'); fs.writeFileSync(f, JSON.stringify(cfg, null, 2));
  return { dir, file: f };
}

function describeTool(name, input) {
  const short = name.replace(/^mcp__mc__/, '');
  let a = ''; try { a = JSON.stringify(input); } catch { /* */ }
  return `${short} ${a === '{}' ? '' : trunc(a || '', 300)}`.trim();
}

async function launch(a, mode /* 'new' | 'resume' | 'fresh' */) {
  const st = state[a.name] ||= { session: null, resumes: 0, failures: 0, cost: 0, turns: 0 };
  if (stopping) return;
  const { dir, file } = writeMcpConfig(a);
  const goalNow = (await safe(() => http('GET', '/goal'))) ;
  const goal = (goalNow && (typeof goalNow === 'string' ? goalNow : goalNow.text)) || GOAL_ARG || DEFAULT_GOAL;
  let prompt = START_PROMPT(a), resume = null;
  if (mode === 'continue') {
    const prev = savedSession(a.name);
    if (prev) { st.session = prev; prompt = CONTINUE_PROMPT; resume = prev; }
    else say(a.name, 'no previous session found; starting a new one');
  } else if (mode === 'resume' && st.session) { prompt = RESUME_PROMPT; resume = st.session; st.resumes++; }
  else if (mode === 'fresh') {
    const m = await safe(() => http('GET', `/memory/${encodeURIComponent(a.name)}`));
    prompt = freshPrompt(a, typeof m === 'string' ? m : m && (m.text ?? m.memory)); st.resumes = 0; st.session = null;
  }
  const pe = PROV.build({ model: a.model || MODEL });   // roster agents may set their own "model"
  const args = ['-p', prompt, ...pe.args, '--output-format', 'stream-json', '--verbose',
    '--mcp-config', file, '--strict-mcp-config',
    '--tools', '',                                   // no built-in tools at all (Bash/Edit/Write/Web/Task...)
    '--allowedTools', ...TOOLS,
    '--disallowedTools', 'Bash', 'PowerShell', 'Edit', 'Write', 'Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'Agent', 'Task', 'NotebookEdit',
    '--permission-mode', 'dontAsk', '--disable-slash-commands',
    '--append-system-prompt', systemPrompt(a, goal)];
  if (EFFORT) args.push('--effort', EFFORT);
  if (resume) args.push('--resume', resume);
  const logf = fs.createWriteStream(path.join(LOGS, `${a.name}.jsonl`), { flags: 'a' });
  logf.write(JSON.stringify({ crew: 'launch', mode, session: resume, ts: new Date().toISOString() }) + '\n');
  const cp = spawn(CLAUDE, [...CLAUDE_CMD.args, ...args], { cwd: dir, env: { ...pe.env, HIVE_BOT: a.name, HIVE_URL: BASE }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  st.proc = cp; st.lastStart = Date.now(); st.gotResult = null; st.toolCalls = 0;
  say(a.name, `launched claude (${pe.model || 'default model'}) mode=${mode} pid=${cp.pid}`);
  postLog(a.name, 'system', `session launched (${mode}${resume ? ' ' + resume.slice(0, 8) : ''})`);

  const toolNames = {};
  let buf = '';
  const onLine = line => {
    logf.write(line + '\n');
    let ev; try { ev = JSON.parse(line); } catch { return; }
    if (ev.type === 'system' && ev.subtype === 'init') {
      st.session = ev.session_id || st.session;
      if (st.session) safe(async () => fs.writeFileSync(path.join(WORK, a.name, 'session.json'), JSON.stringify({ session: st.session, ts: new Date().toISOString() })));
      const mc = (ev.tools || []).filter(t => t.startsWith('mcp__mc__')).length, other = (ev.tools || []).filter(t => !t.startsWith('mcp__mc__'));
      say(a.name, `session ${String(ev.session_id).slice(0, 8)} tools: ${mc} mc, other: [${other.join(',')}]`);
      const failed = (ev.mcp_servers || []).filter(s => s.status !== 'connected');
      if (failed.length) { say(a.name, `MCP problem: ${JSON.stringify(failed)}`); postLog(a.name, 'error', `MCP server not connected: ${JSON.stringify(failed)}`); }
    } else if (ev.type === 'assistant' && ev.message?.content) {
      for (const c of ev.message.content) {
        if (c.type === 'text' && c.text.trim()) { postLog(a.name, 'thought', c.text.trim()); say(a.name, `💭 ${trunc(c.text.trim().replace(/\s+/g, ' '), 160)}`); }
        else if (c.type === 'tool_use') {
          st.toolCalls++; st.totalTools = (st.totalTools || 0) + 1; toolNames[c.id] = c.name;
          const d = describeTool(c.name, c.input); postLog(a.name, 'tool', d); say(a.name, `🔧 ${d}`);
        }
      }
    } else if (ev.type === 'user' && Array.isArray(ev.message?.content)) {
      for (const c of ev.message.content) if (c.type === 'tool_result') {
        const t = Array.isArray(c.content) ? c.content.map(x => x.text || '').join('\n') : String(c.content ?? '');
        postLog(a.name, c.is_error ? 'error' : 'result', trunc(t, 700));
        if (c.is_error) say(a.name, `⚠ ${trunc(t.replace(/\s+/g, ' '), 140)}`);
      }
    } else if (ev.type === 'result') {
      st.gotResult = ev; st.cost += ev.total_cost_usd || 0; st.turns += ev.num_turns || 0;
      say(a.name, `turn ended: ${ev.subtype}${ev.is_error ? ' (error)' : ''} · ${ev.num_turns} turns · $${(ev.total_cost_usd || 0).toFixed(3)}`);
      postLog(a.name, ev.is_error ? 'error' : 'system', `session ended: ${ev.subtype} ${trunc(String(ev.result || ''), 300)}`);
    }
  };
  cp.stdout.on('data', d => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (l) onLine(l); } });
  cp.stderr.on('data', d => { const s = PROV.redact(String(d).trim()); logf.write(JSON.stringify({ stderr: s }) + '\n'); if (s) say(a.name, `stderr: ${trunc(s, 200)}`); });
  cp.on('error', e => say(a.name, `spawn error: ${e.message}`));
  cp.on('exit', code => {
    logf.write(JSON.stringify({ crew: 'exit', code, ts: new Date().toISOString() }) + '\n'); logf.end();
    st.proc = null;
    say(a.name, `claude exited (${code})`);
    if (stopping) return;
    const ranMs = Date.now() - st.lastStart;
    const bad = !st.gotResult || st.gotResult.is_error || code !== 0;
    st.failures = bad && ranMs < 60000 ? st.failures + 1 : 0;
    // decide next mode: resume normally; reseed from memory after N resumes or on errors
    let next = 'resume';
    if (!st.session || bad || st.resumes >= MAX_RESUMES) next = 'fresh';
    if (mode === 'resume' && bad) next = 'fresh';
    const delay = Math.min(60000, 3000 * 2 ** Math.min(st.failures, 5));
    say(a.name, `relaunch in ${Math.round(delay / 1000)}s as ${next} (resumes ${st.resumes}/${MAX_RESUMES}, fast failures ${st.failures})`);
    setTimeout(() => launch(a, next), delay);
  });
}

// ---- lifecycle ----
function killTree(cp) {
  if (!cp || cp.exitCode !== null) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(cp.pid), '/T', '/F'], { stdio: 'ignore' });
  else try { cp.kill('SIGTERM'); } catch { /* */ }
}
async function shutdown(why) {
  if (stopping) return; stopping = true;
  console.log(`\n${stamp()} crew stopping: ${why}`);
  for (const a of agents) killTree(state[a.name]?.proc);
  await Promise.all(agents.map(a => safe(() => http('POST', `/bots/${encodeURIComponent(a.name)}/stop`, {}, 3000))));
  let total = 0; for (const a of agents) { const s = state[a.name]; if (s) { total += s.cost; console.log(`  ${a.name}: ${s.totalTools || 0} tool calls, ${s.turns} turns in finished sessions, ~$${s.cost.toFixed(2)}, ${s.resumes} resumes`); } }
  console.log(`  total ~$${total.toFixed(2)} (only sessions that finished on their own report cost) · logs in ${LOGS}`);
  process.exit(0);
}

async function main() {
  if (!CLAUDE) { console.error('Claude Code not found: install it (https://claude.com/claude-code), or set runtime.claude in hivecraft.config.json / CLAUDE_BIN'); process.exit(1); }
  const chk = PROV.build({ model: MODEL });
  for (const w of chk.warnings) console.log(`provider warning: ${w}`);
  if (chk.errors.length) { console.error(`AI provider not ready (${PROV.describe(chk.model)}):`); for (const e of chk.errors) console.error(`  ${e}`); process.exit(2); }
  // wait for bridge
  let up = false;
  for (let i = 0; i < 30 && !up; i++) { up = !!(await safe(() => http('GET', '/health', undefined, 2000))); if (!up) { if (i === 0) console.log(`waiting for bridge at ${BASE} ...`); await sleep(1000); } }
  if (!up) { console.error(`Bridge not reachable at ${BASE}. Start it: node bridge/server.js`); process.exit(1); }
  // goal: explicit --goal wins; else keep whatever is set, else the default
  const cur = await safe(() => http('GET', '/goal'));
  const curText = cur && (typeof cur === 'string' ? cur : cur.text);
  if (GOAL_ARG) await safe(() => http('POST', '/goal', { text: GOAL_ARG }));
  else if (!curText) await safe(() => http('POST', '/goal', { text: DEFAULT_GOAL }));
  console.log(`Hivecraft crew: ${agents.map(a => `${a.name}(${a.role})`).join(', ')} · ${PROV.describe(chk.model)}${MINUTES ? ` · ${MINUTES} min` : ''}`);
  console.log(`goal: ${GOAL_ARG || curText || DEFAULT_GOAL}`);
  for (const a of agents) await safe(() => http('POST', '/bots', (a.open ? { name: a.name } : { name: a.name, role: a.role }), 60000));
  agents.forEach((a, i) => setTimeout(() => launch(a, CONTINUE ? 'continue' : 'new'), i * STAGGER));
  if (MINUTES) setTimeout(() => shutdown(`time limit (${MINUTES} min)`), MINUTES * 60000);
  process.on('SIGINT', () => shutdown('Ctrl-C'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}
main().catch(e => { console.error(e); process.exit(1); });
