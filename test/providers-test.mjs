// Unit tests for crew/providers.js (no network, no claude runs).   node test/providers-test.mjs
import assert from 'node:assert/strict';
import { resolveProvider, buildClaudeEnv, providerSetup, toOpenRouterModel, describe, redactor, CONFLICTING_VARS, OPENROUTER_BASE } from '../crew/providers.js';

let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; console.log(`ok   ${name}`); } catch (e) { fail++; console.log(`FAIL ${name}\n     ${e.message}`); } };

const KEY = ['sk', 'or', 'v1', 'FAKE0TEST0SECRET0123456789'].join('-');   // fake, built so release scans don't flag it
// a "dirty" shell: stray vars from another setup must never reach the agents for an explicit provider
const DIRTY = {
  PATH: 'C:\\Windows', USERPROFILE: 'C:\\Users\\x', HIVE_PROVIDER_KEY: KEY,
  anthropic_api_key: 'fake-stray-lowercase-key', ANTHROPIC_BASE_URL: 'https://evil.example', ANTHROPIC_MODEL: 'claude-opus-5-5',
  CLAUDE_CODE_USE_BEDROCK: '1', ANTHROPIC_SMALL_FAST_MODEL: 'x', CLAUDE_CODE_OAUTH_TOKEN: 'oauth-setup-token-123456',
};
const keys = env => Object.keys(env).map(k => k.toLowerCase());
const cfg = (provider, file = 'C:\\app\\hivecraft.config.json') => ({ file, provider });

t('no config file -> inherit: env untouched except HIVE_PROVIDER_KEY', () => {
  const ps = providerSetup(cfg({ kind: 'claude-login', model: '' }, null), DIRTY);
  assert.equal(ps.provider.kind, 'inherit');
  const r = ps.build();
  assert.equal(r.env.ANTHROPIC_BASE_URL, 'https://evil.example');
  assert.equal(r.env.anthropic_api_key, 'fake-stray-lowercase-key');
  assert.ok(!keys(r.env).includes('hive_provider_key'));
  assert.deepEqual(r.errors, []);
});

t('claude-login clears every API var (any casing), keeps CLAUDE_CODE_OAUTH_TOKEN', () => {
  const r = providerSetup(cfg({ kind: 'claude-login', model: 'claude-opus-5-5' }), DIRTY).build();
  for (const v of CONFLICTING_VARS.filter(v => v !== 'CLAUDE_CODE_OAUTH_TOKEN')) assert.ok(!keys(r.env).includes(v.toLowerCase()), v);
  assert.equal(r.env.CLAUDE_CODE_OAUTH_TOKEN, 'oauth-setup-token-123456');
  assert.deepEqual(r.args, ['--model', 'claude-opus-5-5']);
  assert.equal(r.env.PATH, 'C:\\Windows');
  assert.ok(!JSON.stringify(r.env).includes(KEY), 'key leaked into claude-login env');
});

t('anthropic-key sets ANTHROPIC_API_KEY only', () => {
  const r = providerSetup(cfg({ kind: 'anthropic-key', model: '' }), { ...DIRTY, HIVE_PROVIDER_KEY: 'fake-anthropic-key-1' }).build();
  assert.equal(r.env.ANTHROPIC_API_KEY, 'fake-anthropic-key-1');
  assert.ok(!('ANTHROPIC_BASE_URL' in r.env) && !('ANTHROPIC_AUTH_TOKEN' in r.env) && !('CLAUDE_CODE_USE_BEDROCK' in r.env) && !('CLAUDE_CODE_OAUTH_TOKEN' in r.env));
  assert.equal(r.model, 'claude-sonnet-5-5');
  assert.deepEqual(r.errors, []);
});

t('anthropic-key without key -> error', () => {
  const r = providerSetup(cfg({ kind: 'anthropic-key' }), { PATH: 'x' }).build();
  assert.equal(r.errors.length, 1);
});

t('anthropic-key falls back to an exported ANTHROPIC_API_KEY (hand-run)', () => {
  const ps = providerSetup(cfg({ kind: 'anthropic-key' }), { ANTHROPIC_API_KEY: 'fake-anthropic-key-shell' });
  assert.equal(ps.build().env.ANTHROPIC_API_KEY, 'fake-anthropic-key-shell');
});

t('openrouter: base URL, Bearer token, empty ANTHROPIC_API_KEY, pinned aliases', () => {
  const r = providerSetup(cfg({ kind: 'openrouter', model: 'claude-sonnet-5-5' }), DIRTY).build();
  assert.equal(r.env.ANTHROPIC_BASE_URL, OPENROUTER_BASE);
  assert.equal(r.env.ANTHROPIC_AUTH_TOKEN, KEY);
  assert.equal(r.env.ANTHROPIC_API_KEY, '');
  assert.equal(keys(r.env).filter(k => k === 'anthropic_api_key').length, 1, 'stray lowercase anthropic_api_key survived');
  assert.equal(r.model, 'anthropic/claude-sonnet-5.5');
  assert.deepEqual(r.args, ['--model', 'anthropic/claude-sonnet-5.5']);
  assert.equal(r.env.ANTHROPIC_DEFAULT_HAIKU_MODEL, 'anthropic/claude-haiku-5.5');
  assert.equal(r.env.ANTHROPIC_DEFAULT_SONNET_MODEL, 'anthropic/claude-sonnet-5.5');
  assert.ok(!('CLAUDE_CODE_USE_BEDROCK' in r.env) && !('ANTHROPIC_MODEL' in r.env) && !('CLAUDE_CODE_OAUTH_TOKEN' in r.env));
  assert.deepEqual(r.warnings, []);
});

t('openrouter non-Claude model -> warning, still builds', () => {
  const r = providerSetup(cfg({ kind: 'openrouter', model: 'deepseek/deepseek-v4.1-flash' }), DIRTY).build();
  assert.equal(r.model, 'deepseek/deepseek-v4.1-flash');
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0], /not a Claude model/);
  assert.equal(r.env.ANTHROPIC_DEFAULT_HAIKU_MODEL, 'anthropic/claude-haiku-5.5');
});

t('openrouter without key -> error', () => {
  assert.equal(providerSetup(cfg({ kind: 'openrouter' }), { PATH: 'x' }).build().errors.length, 1);
});

t('custom: base URL + Bearer, betas stripped, aliases pinned', () => {
  const r = providerSetup(cfg({ kind: 'custom', baseUrl: 'https://api.deepseek.com/anthropic/', model: 'deepseek-v4', smallModel: 'deepseek-v4-flash' }), DIRTY).build();
  assert.equal(r.env.ANTHROPIC_BASE_URL, 'https://api.deepseek.com/anthropic');
  assert.equal(r.env.ANTHROPIC_AUTH_TOKEN, KEY);
  assert.equal(r.env.ANTHROPIC_API_KEY, '');
  assert.equal(r.env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS, '1');
  assert.equal(r.env.ANTHROPIC_DEFAULT_HAIKU_MODEL, 'deepseek-v4-flash');
  assert.equal(r.env.ANTHROPIC_DEFAULT_OPUS_MODEL, 'deepseek-v4');
  assert.deepEqual(r.args, ['--model', 'deepseek-v4']);
  assert.deepEqual(r.errors, []);
});

t('custom without key never falls back to the Claude login (placeholder token)', () => {
  const r = providerSetup(cfg({ kind: 'custom', baseUrl: 'http://localhost:4000', model: 'm' }), { CLAUDE_CODE_OAUTH_TOKEN: 'oauth-xyz-123456' }).build();
  assert.equal(r.env.ANTHROPIC_AUTH_TOKEN, 'hivecraft-no-key');
  assert.ok(!('CLAUDE_CODE_OAUTH_TOKEN' in r.env));
});

t('custom x-api-key header mode', () => {
  const r = providerSetup(cfg({ kind: 'custom', baseUrl: 'https://gw.example/v', model: 'm', authHeader: 'x-api-key' }), DIRTY).build();
  assert.equal(r.env.ANTHROPIC_API_KEY, KEY);
  assert.ok(!('ANTHROPIC_AUTH_TOKEN' in r.env));
});

t('custom validation: bad URL / no model', () => {
  const r = providerSetup(cfg({ kind: 'custom', baseUrl: 'api.example.com' }), DIRTY).build();
  assert.equal(r.errors.length, 2);
});

t('bedrock + vertex', () => {
  const b = providerSetup(cfg({ kind: 'bedrock', region: 'us-west-2', model: 'us.anthropic.claude-sonnet-5-5' }), DIRTY).build();
  assert.equal(b.env.CLAUDE_CODE_USE_BEDROCK, '1'); assert.equal(b.env.AWS_REGION, 'us-west-2');
  assert.equal(b.env.AWS_BEARER_TOKEN_BEDROCK, KEY); assert.ok(!('ANTHROPIC_BASE_URL' in b.env));
  const v = providerSetup(cfg({ kind: 'vertex', projectId: 'proj-1', model: 'claude-sonnet-5-5' }), DIRTY).build();
  assert.equal(v.env.CLAUDE_CODE_USE_VERTEX, '1'); assert.equal(v.env.CLOUD_ML_REGION, 'global');
  assert.equal(v.env.ANTHROPIC_VERTEX_PROJECT_ID, 'proj-1'); assert.ok(!('CLAUDE_CODE_USE_BEDROCK' in v.env));
  assert.equal(providerSetup(cfg({ kind: 'vertex' }), {}).build().errors.length, 1);
});

t('per-agent model override', () => {
  const ps = providerSetup(cfg({ kind: 'openrouter', model: 'anthropic/claude-sonnet-5.5' }), DIRTY);
  assert.deepEqual(ps.build({ model: 'claude-haiku-5-5' }).args, ['--model', 'anthropic/claude-haiku-5.5']);
  assert.deepEqual(ps.build().args, ['--model', 'anthropic/claude-sonnet-5.5']);
});

t('provider.env extras: non-secret applied, secret-looking names refused', () => {
  const r = providerSetup(cfg({ kind: 'claude-login', env: { CLAUDE_CODE_MAX_OUTPUT_TOKENS: 8000, MY_API_KEY: 'x', GW_TOKEN: 'y', 'bad name': 1 } }), {}).build();
  assert.equal(r.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS, '8000');
  assert.ok(!('MY_API_KEY' in r.env) && !('GW_TOKEN' in r.env));
  assert.equal(r.warnings.length, 3);
});

t('HIVE_PROVIDER_KEY never forwarded, for every kind', () => {
  for (const kind of ['claude-login', 'anthropic-key', 'openrouter', 'custom', 'bedrock', 'vertex']) {
    const r = providerSetup(cfg({ kind, baseUrl: 'https://x.example', model: 'm', projectId: 'p' }), DIRTY).build();
    assert.ok(!keys(r.env).includes('hive_provider_key'), kind);
  }
});

t('describe() / warnings / errors never contain the key', () => {
  for (const kind of ['claude-login', 'anthropic-key', 'openrouter', 'custom', 'bedrock', 'vertex']) {
    const ps = providerSetup(cfg({ kind, baseUrl: 'https://gw.example', model: kind === 'openrouter' ? 'openai/gpt-6' : 'm' }), DIRTY);
    const r = ps.build();
    const text = ps.describe(r.model) + JSON.stringify(r.warnings) + JSON.stringify(r.errors) + JSON.stringify(r.args);
    assert.ok(!text.includes(KEY), kind);
  }
  assert.match(describe(resolveProvider({ kind: 'openrouter' }), KEY), /key set/);
  assert.match(describe(resolveProvider({ kind: 'custom', baseUrl: 'https://gw.example/x', model: 'm' }), ''), /gw\.example.*key not set/);
});

t('redactor scrubs the key from log text', () => {
  const r = redactor(KEY, '', 'abc');
  assert.equal(r(`error: invalid token ${KEY} for ${KEY}`), 'error: invalid token *** for ***');
  assert.equal(r('abc stays (too short to be a key)'), 'abc stays (too short to be a key)');
  assert.equal(redactor('')('plain'), 'plain');
});

t('toOpenRouterModel', () => {
  assert.equal(toOpenRouterModel('claude-sonnet-5-5'), 'anthropic/claude-sonnet-5.5');
  assert.equal(toOpenRouterModel('claude-opus-5'), 'anthropic/claude-opus-5');
  assert.equal(toOpenRouterModel('claude-fable-5-2[1m]'), 'anthropic/claude-fable-5.2[1m]');
  assert.equal(toOpenRouterModel('anthropic/claude-haiku-5.5'), 'anthropic/claude-haiku-5.5');
  assert.equal(toOpenRouterModel('gpt-6'), 'gpt-6');
});

t('unknown kind -> claude-login; input env object not mutated', () => {
  const base = { ...DIRTY };
  const ps = providerSetup(cfg({ kind: 'weird' }), base);
  assert.equal(ps.provider.kind, 'claude-login');
  ps.build();
  assert.deepEqual(base, DIRTY);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
