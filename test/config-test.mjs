// Offline test of bridge/config.js (hivecraft.config.json loader): node test/config-test.mjs
import './neutral-player.mjs'; // neutral player + live ports blocked (env below is reset per case)
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-config-test-'));
const C = await import('../bridge/config.js');
const ENV_KEYS = ['HIVE_CONFIG', 'HIVE_PLAYER', 'HIVE_PLAYER_NAME', 'HIVE_PORT', 'MC_HOST', 'MC_PORT', 'HIVE_RCON_PORT', 'HIVE_RCON_PASSWORD',
  'HIVE_SERVER_DIR', 'HIVE_SERVER_PROPS', 'HIVE_NODE', 'HIVE_JAVA', 'CLAUDE_BIN', 'HIVE_MC_DIR', 'HIVE_URL'];
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
const clean = () => { for (const k of ENV_KEYS) delete process.env[k]; process.env.HIVE_SERVER_DIR = path.join(tmp, 'no-server'); };

let pass = 0, fail = 0;
async function t(name, fn) {
  clean();
  try { await fn(); pass++; console.log('  ok  ', name); }
  catch (e) { fail++; console.log('  FAIL', name, '\n      ', e?.stack?.split('\n').slice(0, 4).join('\n       ') || e); process.exitCode = 1; }
}
const write = (name, obj) => { const f = path.join(tmp, name); fs.writeFileSync(f, typeof obj === 'string' ? obj : JSON.stringify(obj)); return f; };
const load = (file) => { process.env.HIVE_CONFIG = file; return C.loadConfig({ reload: true }); };

await t('missing file: defaults, player "Player", never throws', () => {
  const c = load(path.join(tmp, 'nope.json'));
  assert.equal(c.file, null);
  assert.deepEqual(c.player, { mcName: '', displayName: 'Player' });
  assert.equal(c.bridge.port, 47960); assert.equal(c.server.port, 25590); assert.equal(c.server.rconPort, 25591);
  assert.equal(c.server.rconPassword, '');
  assert.equal(c.provider.kind, 'claude-login');
  assert.deepEqual(C.playerNames(c), ['Player']);
});

await t('broken JSON: defaults (no crash)', () => {
  const c = load(write('bad.json', '{ "player": '));
  assert.equal(c.player.displayName, 'Player');
});

await t('full file: values, relative server dir resolved against the app root, unknown provider keys kept', () => {
  delete process.env.HIVE_SERVER_DIR;
  const c = load(write('full.json', {
    version: 1, player: { mcName: 'steve_mc', displayName: 'Steve' },
    provider: { kind: 'bedrock', baseUrl: '', model: 'm1', smallModel: 's1', region: 'us-east-1', env: { A: '1' } },
    runtime: { node: 'node', java: 'java', claude: '' }, server: { dir: 'server', port: 25600, rconPort: 25601, rconPassword: 'pw123' },
    bridge: { port: 47999 }, minecraft: { dir: '' },
  }));
  assert.ok(c.file && c.file.endsWith('full.json'));
  assert.deepEqual(c.player, { mcName: 'steve_mc', displayName: 'Steve' });
  assert.equal(c.provider.kind, 'bedrock'); assert.equal(c.provider.region, 'us-east-1'); assert.deepEqual(c.provider.env, { A: '1' });
  assert.equal(c.server.dir, path.join(C.APP_ROOT, 'server'));
  assert.deepEqual(C.rconOpts(c), { host: '127.0.0.1', port: 25601, password: 'pw123' });
  assert.equal(C.bridgeUrl(c), 'http://127.0.0.1:47999');
  assert.deepEqual(C.econPlayers(c), { Steve: 'steve_mc' });
  assert.ok(C.isPlayerName('STEVE_MC', c) && C.isPlayerName('steve', c) && !C.isPlayerName('Ash', c));
});

await t('displayName falls back to mcName; bad chars cleaned; unknown provider kind -> claude-login', () => {
  const c = load(write('min.json', { player: { mcName: 'Al ex!' }, provider: { kind: 'nope' } }));
  assert.equal(c.player.mcName, 'Alex'); assert.equal(c.player.displayName, 'Alex');
  assert.equal(c.provider.kind, 'claude-login');
});

await t('env overrides win over the file', () => {
  const f = write('env.json', { player: { mcName: 'a', displayName: 'A' }, bridge: { port: 47990 }, server: { rconPort: 1111, rconPassword: 'x' } });
  Object.assign(process.env, { HIVE_PLAYER: 'envmc', HIVE_PLAYER_NAME: 'Env Name', HIVE_PORT: '47991', HIVE_RCON_PORT: '2222', HIVE_RCON_PASSWORD: 'y', CLAUDE_BIN: 'C:/x/claude.exe' });
  const c = load(f);
  assert.deepEqual(c.player, { mcName: 'envmc', displayName: 'Env Name' });
  assert.equal(c.bridge.port, 47991); assert.equal(c.server.rconPort, 2222); assert.equal(c.server.rconPassword, 'y');
  assert.equal(c.runtime.claude, 'C:/x/claude.exe');
});

await t('RCON values fall back to server.properties when the config has none', () => {
  const dir = path.join(tmp, 'srv'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'server.properties'), '#x\nserver-port=25700\nrcon.port=25701\nrcon.password=from-props\n');
  process.env.HIVE_SERVER_DIR = dir;
  const c = load(write('noprops.json', { player: { mcName: 'p' } }));
  assert.equal(c.server.port, 25700); assert.equal(c.server.rconPort, 25701); assert.equal(c.server.rconPassword, 'from-props');
});

await t('fillTemplate + findClaude', () => {
  assert.equal(C.fillTemplate('hi {{player}} ({{playerMc}}) {{x}}', { player: 'Steve', playerMc: 'steve_mc' }), 'hi Steve (steve_mc) {{x}}');
  const fake = write('claude.exe', 'x');
  process.env.CLAUDE_BIN = fake;
  const c = load(path.join(tmp, 'nope.json'));
  assert.equal(C.findClaude(c), fake);
  assert.deepEqual(C.claudeSpawn(c), { command: fake, args: [] });
});

for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(process.exitCode || 0);
