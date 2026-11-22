// Hivecraft AI providers: turns hivecraft.config.json `provider` + one secret into the environment and
// --model args for each headless `claude -p` agent. The agent runtime is always Claude Code (it gives the
// agents the MCP tool loop); only the backend changes, through Claude Code's documented env vars:
//   https://code.claude.com/docs/en/env-vars · https://code.claude.com/docs/en/llm-gateway
//   https://code.claude.com/docs/en/authentication (precedence: Bedrock/Vertex > ANTHROPIC_AUTH_TOKEN >
//   ANTHROPIC_API_KEY > apiKeyHelper > CLAUDE_CODE_OAUTH_TOKEN > /login subscription)
//   OpenRouter: https://openrouter.ai/docs/guides/guides/claude-code-integration
//
// kinds:
//   claude-login   the user's Claude subscription (`claude auth login`); no key; all API vars cleared
//   anthropic-key  ANTHROPIC_API_KEY=<key> (Anthropic Console key, pay per token)
//   openrouter     ANTHROPIC_BASE_URL=https://openrouter.ai/api, ANTHROPIC_AUTH_TOKEN=<key>, ANTHROPIC_API_KEY=""
//   custom         any Anthropic-Messages-compatible endpoint: ANTHROPIC_BASE_URL=<baseUrl> + key as Bearer
//                  (or x-api-key with provider.authHeader='x-api-key'); experimental betas stripped
//   bedrock        CLAUDE_CODE_USE_BEDROCK=1 (+ AWS_REGION / AWS_PROFILE / AWS_BEARER_TOKEN_BEDROCK=<key>)
//   vertex         CLAUDE_CODE_USE_VERTEX=1, CLOUD_ML_REGION, ANTHROPIC_VERTEX_PROJECT_ID (gcloud ADC login)
//   inherit        no config file (dev setups): the environment is passed through untouched
//
// The secret comes from env HIVE_PROVIDER_KEY (set by Hivecraft.exe from its DPAPI store), falling back to
// OPENROUTER_API_KEY / ANTHROPIC_API_KEY / AWS_BEARER_TOKEN_BEDROCK for hand-run setups. It is never logged:
// describe() and warnings never contain it, and redactor() scrubs it from any text.

export const KINDS = ['claude-login', 'anthropic-key', 'openrouter', 'custom', 'bedrock', 'vertex', 'inherit'];
export const OPENROUTER_BASE = 'https://openrouter.ai/api';
export const DEFAULT_MODELS = Object.freeze({
  'claude-login': { model: 'claude-sonnet-5-5', smallModel: '' },
  'anthropic-key': { model: 'claude-sonnet-5-5', smallModel: '' },
  openrouter: { model: 'anthropic/claude-sonnet-5.5', smallModel: 'anthropic/claude-haiku-5.5' },
  custom: { model: '', smallModel: '' },
  bedrock: { model: '', smallModel: '' },
  vertex: { model: '', smallModel: '' },
  inherit: { model: 'claude-sonnet-5-5', smallModel: '' },
});

const TIERS = ['OPUS', 'SONNET', 'HAIKU', 'FABLE'];
/** Every backend-selecting variable. All are removed before a kind sets its own, so a stray
 *  ANTHROPIC_API_KEY in the user's shell can't silently bill an account they didn't pick. */
export const CONFLICTING_VARS = [
  'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_CUSTOM_HEADERS',
  'ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_MODEL', 'ANTHROPIC_SMALL_FAST_MODEL', 'ANTHROPIC_PROFILE',
  ...TIERS.flatMap(t => [`ANTHROPIC_DEFAULT_${t}_MODEL`, `ANTHROPIC_DEFAULT_${t}_MODEL_NAME`,
    `ANTHROPIC_DEFAULT_${t}_MODEL_DESCRIPTION`, `ANTHROPIC_DEFAULT_${t}_MODEL_SUPPORTED_CAPABILITIES`]),
  'CLAUDE_CODE_SUBAGENT_MODEL', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY',
  'ANTHROPIC_BEDROCK_BASE_URL', 'ANTHROPIC_VERTEX_BASE_URL', 'ANTHROPIC_VERTEX_PROJECT_ID', 'CLOUD_ML_REGION',
  'AWS_BEARER_TOKEN_BEDROCK', 'CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS', 'CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY',
  'CLAUDE_CODE_OAUTH_TOKEN', 'OPENROUTER_API_KEY',
];
/** Never forwarded to claude (and so never to the MCP servers it spawns). */
const HIVE_SECRET_VARS = ['HIVE_PROVIDER_KEY'];
const SECRETISH = /(API_?KEY|(^|_)KEY($|_)|SECRET|PASSWORD|PASSWD|CREDENTIAL|BEARER|(^|_)TOKEN($|_))/i;   // not MAX_OUTPUT_TOKENS

const s = v => (typeof v === 'string' ? v.trim() : v === undefined || v === null ? '' : String(v).trim());

/** Windows env names are case-insensitive: delete every casing of `name` from a plain object. */
function del(env, name) {
  const l = name.toLowerCase();
  for (const k of Object.keys(env)) if (k.toLowerCase() === l) delete env[k];
}
function set(env, name, value) { del(env, name); env[name] = value; }
function get(env, name) {
  const l = name.toLowerCase();
  for (const k of Object.keys(env)) if (k.toLowerCase() === l && env[k] !== undefined && env[k] !== '') return env[k];
  return '';
}

/** Claude-style id -> OpenRouter slug: 'claude-sonnet-5-5' -> 'anthropic/claude-sonnet-5.5'. Others unchanged. */
export function toOpenRouterModel(id) {
  const m = s(id);
  if (!m || m.includes('/')) return m;
  const r = /^(claude-[a-z]+)-(\d+)(?:-(\d{1,2}))?(\[1m\])?$/i.exec(m);
  if (r) return `anthropic/${r[1].toLowerCase()}-${r[2]}${r[3] ? '.' + r[3] : ''}${r[4] || ''}`;
  return m;
}

/**
 * Provider settings from a loaded config (bridge/config.js loadConfig()) or a raw provider object.
 * hasFile=false (no hivecraft.config.json) -> 'inherit', which keeps the legacy behaviour exactly.
 */
export function resolveProvider(provider, { hasFile = true } = {}) {
  const p = provider && typeof provider === 'object' ? provider : {};
  let kind = hasFile ? s(p.kind).toLowerCase() : 'inherit';   // no file: config.js defaults are not a real choice
  if (!KINDS.includes(kind)) kind = 'claude-login';
  const d = DEFAULT_MODELS[kind];
  let model = s(p.model) || d.model, smallModel = s(p.smallModel) || d.smallModel;
  if (kind === 'openrouter') { model = toOpenRouterModel(model); smallModel = toOpenRouterModel(smallModel); }
  const env = p.env && typeof p.env === 'object' && !Array.isArray(p.env) ? p.env : {};
  return {
    kind, model, smallModel,
    baseUrl: s(p.baseUrl).replace(/\/+$/, ''),
    authHeader: s(p.authHeader).toLowerCase() === 'x-api-key' ? 'x-api-key' : 'bearer',
    region: s(p.region), projectId: s(p.projectId), profile: s(p.profile),
    betas: p.betas === true,
    env,
  };
}

/** The secret for this provider: HIVE_PROVIDER_KEY, else a kind-specific variable a hand-run setup may export. */
export function secretFrom(baseEnv, kind) {
  const direct = get(baseEnv, 'HIVE_PROVIDER_KEY');
  if (direct) return direct;
  if (kind === 'openrouter') return get(baseEnv, 'OPENROUTER_API_KEY') || get(baseEnv, 'ANTHROPIC_AUTH_TOKEN');
  if (kind === 'anthropic-key') return get(baseEnv, 'ANTHROPIC_API_KEY');
  if (kind === 'custom') return get(baseEnv, 'ANTHROPIC_AUTH_TOKEN') || get(baseEnv, 'ANTHROPIC_API_KEY');
  if (kind === 'bedrock') return get(baseEnv, 'AWS_BEARER_TOKEN_BEDROCK');
  return '';
}

/** Problems that stop the crew from starting (plain words, never the secret). */
export function validate(p, secret) {
  const errs = [];
  if (p.kind === 'anthropic-key' && !secret) errs.push('Anthropic API key missing: add it in Hivecraft (AI provider → Change…).');
  if (p.kind === 'openrouter' && !secret) errs.push('OpenRouter API key missing: add it in Hivecraft (AI provider → Change…).');
  if (p.kind === 'custom') {
    if (!/^https?:\/\/[^\s/]+/i.test(p.baseUrl)) errs.push('Custom provider needs a base URL such as https://api.example.com/anthropic');
    if (!p.model) errs.push('Custom provider needs a model id.');
  }
  if (p.kind === 'vertex' && !p.projectId) errs.push('Vertex needs provider.projectId (your Google Cloud project id).');
  if (p.kind !== 'inherit' && /\s/.test(p.model)) errs.push(`Model id "${p.model}" contains spaces.`);
  return errs;
}

/**
 * Build the child environment for one claude process.
 * @param baseEnv  usually process.env (copied, never mutated)
 * @param provider resolveProvider() result
 * @param secret   API key / token ('' if none)
 * @param opts.model per-agent model override
 * @returns {{ env: object, model: string, args: string[], warnings: string[], errors: string[] }}
 */
export function buildClaudeEnv(baseEnv, provider, secret = '', { model: modelOverride } = {}) {
  const p = provider && provider.kind ? provider : resolveProvider(provider);
  const env = { ...baseEnv };
  const warnings = [];
  for (const k of HIVE_SECRET_VARS) del(env, k);
  let model = s(modelOverride) || p.model;
  if (p.kind === 'openrouter') model = toOpenRouterModel(model);
  const errors = validate({ ...p, model }, secret);

  if (p.kind !== 'inherit') {
    const keepOauth = p.kind === 'claude-login' ? get(env, 'CLAUDE_CODE_OAUTH_TOKEN') : '';
    for (const k of CONFLICTING_VARS) del(env, k);
    if (keepOauth) set(env, 'CLAUDE_CODE_OAUTH_TOKEN', keepOauth);   // `claude setup-token` login is still the subscription
  }
  const pinAliases = (m, small) => {
    // the opus/sonnet aliases and background (haiku) calls must resolve to ids this backend knows
    if (m) { set(env, 'ANTHROPIC_DEFAULT_OPUS_MODEL', m); set(env, 'ANTHROPIC_DEFAULT_SONNET_MODEL', m); set(env, 'CLAUDE_CODE_SUBAGENT_MODEL', m); }
    if (small || m) set(env, 'ANTHROPIC_DEFAULT_HAIKU_MODEL', small || m);
  };

  switch (p.kind) {
    case 'inherit':
      break;
    case 'claude-login':
      if (secret) warnings.push('a key was supplied but the provider is Claude login; the key is ignored');
      if (p.smallModel) set(env, 'ANTHROPIC_DEFAULT_HAIKU_MODEL', p.smallModel);
      break;
    case 'anthropic-key':
      if (secret) set(env, 'ANTHROPIC_API_KEY', secret);
      if (p.smallModel) set(env, 'ANTHROPIC_DEFAULT_HAIKU_MODEL', p.smallModel);
      break;
    case 'openrouter':
      set(env, 'ANTHROPIC_BASE_URL', p.baseUrl || OPENROUTER_BASE);
      if (secret) set(env, 'ANTHROPIC_AUTH_TOKEN', secret);
      set(env, 'ANTHROPIC_API_KEY', '');                      // OpenRouter guide: "must be explicitly empty"
      pinAliases(model, p.smallModel);
      if (model && !/^~?anthropic\//i.test(model)) warnings.push(`"${model}" is not a Claude model: Claude Code is tuned for Claude, so agents may play worse or fail tool calls`);
      break;
    case 'custom':
      set(env, 'ANTHROPIC_BASE_URL', p.baseUrl);
      if (p.authHeader === 'x-api-key') { set(env, 'ANTHROPIC_API_KEY', secret || 'hivecraft-no-key'); }
      else {
        // a placeholder when there is no key: otherwise Claude Code would fall back to the user's Claude
        // login and send that OAuth token to a third-party URL
        set(env, 'ANTHROPIC_AUTH_TOKEN', secret || 'hivecraft-no-key');
        set(env, 'ANTHROPIC_API_KEY', '');
      }
      if (!p.betas) set(env, 'CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS', '1');   // gateways reject unknown anthropic-beta values
      pinAliases(model, p.smallModel);
      break;
    case 'bedrock':
      set(env, 'CLAUDE_CODE_USE_BEDROCK', '1');
      if (p.region) set(env, 'AWS_REGION', p.region);
      if (p.profile) set(env, 'AWS_PROFILE', p.profile);
      if (secret) set(env, 'AWS_BEARER_TOKEN_BEDROCK', secret);
      if (model) pinAliases(model, p.smallModel);
      break;
    case 'vertex':
      set(env, 'CLAUDE_CODE_USE_VERTEX', '1');
      set(env, 'CLOUD_ML_REGION', p.region || 'global');
      if (p.projectId) set(env, 'ANTHROPIC_VERTEX_PROJECT_ID', p.projectId);
      if (model) pinAliases(model, p.smallModel);
      break;
  }

  // provider.env: extra NON-secret variables from the config file (secrets belong in the key store)
  for (const [k, v] of Object.entries(p.env || {})) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) { warnings.push(`provider.env: skipped invalid name "${k}"`); continue; }
    if (SECRETISH.test(k)) { warnings.push(`provider.env: skipped ${k} (keys/tokens must not live in hivecraft.config.json)`); continue; }
    set(env, k, v === null || v === undefined ? '' : String(v));
  }

  const args = model ? ['--model', model] : [];
  return { env, model, args, warnings, errors };
}

/** One safe line for logs: kind, endpoint host, model, whether a key is present. Never the key. */
export function describe(p, secret, model = p.model) {
  const host = p.kind === 'openrouter' ? 'openrouter.ai' : p.kind === 'custom' ? (() => { try { return new URL(p.baseUrl).host; } catch { return '?'; } })() : '';
  const label = { 'claude-login': 'Claude login', 'anthropic-key': 'Anthropic API key', openrouter: 'OpenRouter', custom: 'custom endpoint', bedrock: 'Amazon Bedrock', vertex: 'Google Vertex AI', inherit: 'environment (no hivecraft.config.json)' }[p.kind] || p.kind;
  return `${label}${host && p.kind === 'custom' ? ` ${host}` : ''} · model ${model || '(Claude Code default)'}${p.smallModel ? ` · small ${p.smallModel}` : ''}${['anthropic-key', 'openrouter', 'custom', 'bedrock'].includes(p.kind) ? ` · key ${secret ? 'set' : 'not set'}` : ''}`;
}

/** text -> text with every secret (6+ chars) replaced by ***. */
export function redactor(...secrets) {
  const list = secrets.map(s).filter(x => x.length >= 6).sort((a, b) => b.length - a.length);
  if (!list.length) return t => String(t);
  return t => { let out = String(t); for (const x of list) out = out.split(x).join('***'); return out; };
}

/** Everything crew.js needs, from a loadConfig() result and process.env. */
export function providerSetup(config, baseEnv = process.env) {
  const p = resolveProvider(config?.provider, { hasFile: !!config?.file });
  const secret = secretFrom(baseEnv, p.kind);
  return {
    provider: p, secret,
    redact: redactor(secret),
    describe: (model) => describe(p, secret, model),
    build: (opts) => buildClaudeEnv(baseEnv, p, secret, opts),
  };
}
