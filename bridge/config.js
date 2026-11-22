// Hivecraft install config: <app root>/hivecraft.config.json (or the file named by HIVE_CONFIG).
// Shared by the bridge, the MCP server, the crew launcher and (in C#) Hivecraft.exe / the setup wizard.
// A missing or broken file never crashes anything: every value has a default, and env vars win over the file.
//
//   { "version": 1,
//     "player":    { "mcName": "<Minecraft username>", "displayName": "<what the agents call the human>" },
//     "provider":  { "kind": "claude-login"|"anthropic-key"|"openrouter"|"custom"|"bedrock"|"vertex", "baseUrl": "", "model": "", "smallModel": "" },
//     "runtime":   { "node": "node", "java": "java", "claude": "" },
//     "server":    { "dir": "server", "port": 25590, "rconPort": 25591, "rconPassword": "<random per install>" },
//     "bridge":    { "port": 47960 },
//     "minecraft": { "dir": "" } }
//
// API keys are NEVER stored here (the launcher passes them to the crew as env vars).
// Env overrides: HIVE_CONFIG (file path), HIVE_PLAYER (mcName), HIVE_PLAYER_NAME (displayName), HIVE_PORT,
//   MC_HOST, MC_PORT, HIVE_RCON_PORT, HIVE_RCON_PASSWORD, HIVE_SERVER_DIR, HIVE_NODE, HIVE_JAVA, CLAUDE_BIN, HIVE_MC_DIR.
// Relative paths (server.dir, runtime.*) are relative to the app root.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const CONFIG_NAME = 'hivecraft.config.json';
export const DEFAULT_PLAYER = 'Player';

const DEFAULTS = Object.freeze({
  version: 1,
  player: { mcName: '', displayName: '' },
  provider: { kind: 'claude-login', baseUrl: '', model: '', smallModel: '' },
  runtime: { node: 'node', java: 'java', claude: '' },
  server: { dir: 'server', host: '127.0.0.1', port: 25590, rconPort: 25591, rconPassword: '' },
  bridge: { port: 47960 },
  minecraft: { dir: '' },
});

export const PROVIDER_KINDS = ['claude-login', 'anthropic-key', 'openrouter', 'custom', 'bedrock', 'vertex'];
const MC_NAME_RE = /^[A-Za-z0-9_]{1,16}$/;
const s = (v) => (typeof v === 'string' ? v.trim() : v === undefined || v === null ? '' : String(v).trim());
const port = (v, d) => { const n = Number(v); return Number.isInteger(n) && n > 0 && n < 65536 ? n : d; };
const env = (k) => { const v = process.env[k]; return v === undefined || v === '' ? undefined : v; };

export function configPath() {
  return env('HIVE_CONFIG') ? path.resolve(env('HIVE_CONFIG')) : path.join(APP_ROOT, CONFIG_NAME);
}

/** absolute path; relative ones are resolved against the app root ('' stays '') */
export function appPath(p) {
  const v = s(p);
  return !v ? '' : path.isAbsolute(v) ? v : path.resolve(APP_ROOT, v);
}

/** key=value lines of a server.properties file ({} when unreadable) */
export function readProps(file) {
  const out = {};
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { return out; }
  for (const raw of text.split(/\r?\n/)) {
    const l = raw.trim();
    if (!l || l.startsWith('#') || l.startsWith('!')) continue;
    const i = l.search(/[=:]/);
    if (i > 0) out[l.slice(0, i).trim()] = l.slice(i + 1).trim().replace(/\\(.)/g, '$1');
  }
  return out;
}

function readFile(file) {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
    return j && typeof j === 'object' && !Array.isArray(j) ? { json: j, error: null } : { json: {}, error: 'not a JSON object' };
  } catch (e) {
    return { json: {}, error: e.code === 'ENOENT' ? null : e.message };
  }
}

/**
 * Build a full config from a parsed file object (+ env). Pure apart from env and the server.properties
 * fallback for RCON values, so tests can call it directly.
 */
export function normalize(raw = {}, { envOn = true, file = null } = {}) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const sec = (k) => (r[k] && typeof r[k] === 'object' && !Array.isArray(r[k]) ? r[k] : {});
  const E = envOn ? env : () => undefined;
  const pl = sec('player'), pr = sec('provider'), rt = sec('runtime'), sv = sec('server'), br = sec('bridge'), mc = sec('minecraft');

  let mcName = s(E('HIVE_PLAYER') ?? pl.mcName);
  if (mcName && !MC_NAME_RE.test(mcName)) mcName = mcName.replace(/[^A-Za-z0-9_]/g, '').slice(0, 16);
  let displayName = s(E('HIVE_PLAYER_NAME') ?? pl.displayName).replace(/[\r\n\t,]/g, ' ').replace(/\s+/g, ' ').slice(0, 24).trim();
  if (!displayName) displayName = mcName || DEFAULT_PLAYER;

  const serverDir = appPath(E('HIVE_SERVER_DIR') ?? (s(sv.dir) || DEFAULTS.server.dir));
  // RCON / ports fall back to the server's own server.properties, so an older install without these keys still works
  const props = readProps(env('HIVE_SERVER_PROPS') || path.join(serverDir, 'server.properties'));
  const rconPassword = s(E('HIVE_RCON_PASSWORD') ?? (s(sv.rconPassword) || props['rcon.password'] || ''));

  return {
    version: Number(r.version) || 1,
    file,
    root: APP_ROOT,
    player: { mcName, displayName },
    // other provider keys (region, projectId, profile, authHeader, env, ...) are kept as they are (crew/providers.js)
    provider: {
      ...pr,
      kind: PROVIDER_KINDS.includes(s(pr.kind)) ? s(pr.kind) : DEFAULTS.provider.kind,
      baseUrl: s(pr.baseUrl), model: s(pr.model), smallModel: s(pr.smallModel),
    },
    runtime: {
      node: s(E('HIVE_NODE') ?? rt.node) || DEFAULTS.runtime.node,
      java: s(E('HIVE_JAVA') ?? rt.java) || DEFAULTS.runtime.java,
      claude: s(E('CLAUDE_BIN') ?? rt.claude),
    },
    server: {
      dir: serverDir,
      host: s(E('MC_HOST') ?? sv.host) || DEFAULTS.server.host,
      port: port(E('MC_PORT') ?? sv.port ?? props['server-port'], DEFAULTS.server.port),
      rconPort: port(E('HIVE_RCON_PORT') ?? sv.rconPort ?? props['rcon.port'], DEFAULTS.server.rconPort),
      rconPassword,
    },
    bridge: { port: port(E('HIVE_PORT') ?? br.port, DEFAULTS.bridge.port) },
    minecraft: { dir: appPath(E('HIVE_MC_DIR') ?? mc.dir) },
  };
}

let cached = null;
let warned = '';

/**
 * The config (cached; reload=true re-reads the file and env). Never throws.
 * @returns {{version:number,file:string|null,root:string,player:{mcName:string,displayName:string},
 *   provider:{kind:string,baseUrl:string,model:string,smallModel:string},runtime:{node:string,java:string,claude:string},
 *   server:{dir:string,host:string,port:number,rconPort:number,rconPassword:string},bridge:{port:number},minecraft:{dir:string}}}
 */
export function loadConfig({ reload = false } = {}) {
  if (cached && !reload) return cached;
  const file = configPath();
  const { json, error } = readFile(file);
  if (error && warned !== file + error) {
    warned = file + error;
    console.error(`[hivecraft] could not read ${file} (${error}); using defaults`);
  }
  try {
    cached = normalize(json, { file: fs.existsSync(file) ? file : null });
  } catch (e) {
    console.error(`[hivecraft] bad config ${file}: ${e.message}; using defaults`);
    cached = normalize({}, { file: null });
  }
  return cached;
}

// ------------------------------------------------------------------ helpers

/** The human's Minecraft username ('' when not configured). */
export const playerMcName = (c = loadConfig()) => c.player.mcName;
/** What the agents and the economy call the human (displayName, else mcName, else 'Player'). */
export const playerDisplayName = (c = loadConfig()) => c.player.displayName;
/** Every name the human goes by (display name first), deduped case-insensitively. */
export function playerNames(c = loadConfig()) {
  const out = [];
  for (const n of [c.player.displayName, c.player.mcName]) if (n && !out.some((x) => x.toLowerCase() === n.toLowerCase())) out.push(n);
  return out;
}
/** True if `name` is the configured human (display name or Minecraft name, any case). */
export function isPlayerName(name, c = loadConfig()) {
  const l = s(name).toLowerCase();
  return !!l && playerNames(c).some((n) => n.toLowerCase() === l);
}
/** Economy `players` map: { displayName: mcName } (account name -> MC alias). */
export function econPlayers(c = loadConfig()) {
  return { [c.player.displayName]: c.player.mcName || c.player.displayName };
}

export const bridgePort = (c = loadConfig()) => c.bridge.port;
export const bridgeUrl = (c = loadConfig()) => (env('HIVE_URL') || `http://127.0.0.1:${c.bridge.port}`).replace(/\/+$/, '');
/** options for rcon() in bridge/hub/rcon.js */
export const rconOpts = (c = loadConfig()) => ({ host: c.server.host, port: c.server.rconPort, password: c.server.rconPassword });
/** where the bots connect */
export const mcServer = (c = loadConfig()) => ({ host: c.server.host, port: c.server.port });
export const serverPropsFile = (c = loadConfig()) => env('HIVE_SERVER_PROPS') || path.join(c.server.dir, 'server.properties');

function exists(p) { try { return !!p && fs.statSync(p).isFile(); } catch { return false; } }

/** First file named `name` (+ Windows extensions) on PATH, or ''. */
export function whichOnPath(name) {
  const exts = process.platform === 'win32' ? ['', ...(process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';').map((e) => e.toLowerCase())] : [''];
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    for (const e of exts) {
      const f = path.join(dir.replace(/^"|"$/g, ''), name + e);
      if (exists(f)) return f;
    }
  }
  return '';
}

/**
 * Claude Code executable: config runtime.claude / CLAUDE_BIN, else PATH, else the native installer's
 * ~/.local/bin, else the npm global prefix. '' = not found.
 */
export function findClaude(c = loadConfig()) {
  const want = c.runtime.claude;
  if (want) {
    const abs = appPath(want);
    if (exists(abs)) return abs;
    if (!/[\\/]/.test(want)) { const w = whichOnPath(want); if (w) return w; }
  }
  const home = os.homedir();
  const win = process.platform === 'win32';
  const cands = [whichOnPath('claude'),
    path.join(home, '.local', 'bin', win ? 'claude.exe' : 'claude'),
    win && process.env.APPDATA ? path.join(process.env.APPDATA, 'npm', 'claude.cmd') : '',
    !win ? '/usr/local/bin/claude' : ''];
  return cands.find(exists) || '';
}

/**
 * How to spawn Claude Code without a shell: {command, args} (prepend args to the CLI arguments).
 * An npm-installed claude.cmd can't be spawned directly on Windows, so it is resolved to its package
 * (native bin/claude.exe, else `node cli.js`). null = Claude Code not found.
 */
export function claudeSpawn(c = loadConfig()) {
  const f = findClaude(c);
  if (!f) return null;
  if (/\.(cmd|bat)$/i.test(f)) {
    const pkg = path.join(path.dirname(f), 'node_modules', '@anthropic-ai', 'claude-code');
    for (const exe of [path.join(pkg, 'bin', 'claude.exe'), path.join(pkg, 'claude.exe')]) if (exists(exe)) return { command: exe, args: [] };
    const cli = path.join(pkg, 'cli.js');
    if (exists(cli)) return { command: process.execPath, args: [cli] };
  }
  return { command: f, args: [] };
}

/** Replace {{key}} placeholders (unknown keys are left as they are). */
export function fillTemplate(text, vars) {
  return String(text).replace(/\{\{(\w+)\}\}/g, (m, k) => (vars[k] !== undefined && vars[k] !== null ? String(vars[k]) : m));
}
