#!/usr/bin/env node
// scrub-scan.mjs — find personal / machine-specific strings and secrets in what would ship.
//
//   node tools/scrub-scan.mjs                 scan the source tree (repo root) minus local-only folders
//   node tools/scrub-scan.mjs --root dist/payload/app --payload
//                                             scan a release payload: every file, incl. binaries & zip/jar entries
//   options: --json (machine output)  --strict (warnings fail too)  --quiet (summary only)
//            --max N (max hits printed per rule, default 200)
//
// Exit code: 0 = clean (warnings allowed unless --strict), 1 = findings, 2 = usage/internal error.
// A line containing the marker  scrub-ok  is ignored (use sparingly, e.g. test fixtures that check scrubbing).
//
// The machine's own user name, home dir and host name are added to the rules at run time, so the
// scanner also works for anyone else who builds a release.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const REPO = path.resolve(path.dirname(SELF), '..');

// ---------- args ----------
const argv = process.argv.slice(2);
const opt = { root: REPO, payload: false, json: false, strict: false, quiet: false, max: 200 };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--root') opt.root = path.resolve(argv[++i]);
  else if (a === '--payload') opt.payload = true;
  else if (a === '--json') opt.json = true;
  else if (a === '--strict') opt.strict = true;
  else if (a === '--quiet') opt.quiet = true;
  else if (a === '--max') opt.max = Number(argv[++i]) || 200;
  else if (a === '-h' || a === '--help') { console.log(fs.readFileSync(SELF, 'utf8').split('\n').slice(1, 15).join('\n')); process.exit(0); }
  else { console.error('unknown arg ' + a); process.exit(2); }
}
if (!fs.existsSync(opt.root)) { console.error('root not found: ' + opt.root); process.exit(2); }

// ---------- rules ----------
// Personal tokens are written split so this file never matches itself if it is scanned.
const j = (...p) => p.join('');
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const rules = [];
const rule = (id, severity, re, opts = {}) => rules.push({ id, severity, re, binary: opts.binary !== false, mask: !!opts.mask, allow: opts.allow || null, binarySeverity: opts.binarySeverity || severity });

// Personal tokens (also searched in binaries). They are NOT in this file: put the owner's own terms in
// tools/scrub-terms.local.json (git-ignored), e.g. {"owner-name":["YourName"],"owner-mc-name":["your_mc"],
// "owner-winuser":["winuser"],"owner-host":["PC-NAME"],"owner-email":["you.name"]}, or set SCRUB_TERMS to such JSON.
{
  let local = {};
  const lf = new URL('./scrub-terms.local.json', import.meta.url);
  try { local = JSON.parse(fs.readFileSync(lf, 'utf8')); } catch { /* no local terms file: only generic rules run */ }
  try { if (process.env.SCRUB_TERMS) Object.assign(local, JSON.parse(process.env.SCRUB_TERMS)); } catch (e) { console.error('SCRUB_TERMS is not valid JSON:', e.message); }
  for (const [id, terms] of Object.entries(local)) {
    for (const t of [].concat(terms || [])) {
      if (!t) continue;
      const word = /^[A-Za-z0-9_]+$/.test(t);
      rule(id, 'error', new RegExp((word ? '(?<![A-Za-z0-9_])' : '') + esc(t) + (word ? '(?![A-Za-z0-9_])' : ''), 'gi'));
    }
  }
}
// In binaries this is only a warning: the one allowed source occurrence is the scrub-ok'd legacy-default constant
// (HiveConfig.LegacyRconPassword) and the source scan fails on any other; compiled code can't carry the marker.
rule('rcon-default-pw', 'error', new RegExp(j('hivecraft', '-local'), 'gi'), { binarySeverity: 'warn' });

// Current machine (whoever runs the build)
const me = (() => { try { return os.userInfo().username; } catch { return ''; } })();
const host = os.hostname();
if (me && me.length >= 3 && !/^(user|admin|runner|root)$/i.test(me)) rule('this-user', 'error', new RegExp('\\b' + esc(me) + '\\b', 'gi'));
if (host && host.length >= 3) rule('this-host', 'error', new RegExp('\\b' + esc(host) + '\\b', 'gi'));

// Secrets
// obviously fake test keys (e.g. sk-ant-selftest-0000000000) are fine everywhere
const fakeKey = (m) => /(selftest|example|fake|dummy|placeholder|test-?0{4,}|x{8,}|0{10,})/i.test(m[0]);
rule('anthropic-key', 'error', /sk-ant-[A-Za-z0-9_\-]{12,}/g, { mask: true, allow: fakeKey });
rule('openrouter-key', 'error', /sk-or-(?:v1-)?[A-Za-z0-9_\-]{12,}/g, { mask: true, allow: fakeKey });
rule('openai-key', 'error', /\bsk-(?:proj-)?[A-Za-z0-9]{32,}\b/g, { mask: true });
rule('github-token', 'error', /\b(?:ghp|gho|ghu|ghs|github_pat)_[A-Za-z0-9_]{20,}\b/g, { mask: true });
rule('google-key', 'error', /\bAIza[0-9A-Za-z_\-]{35}\b/g, { mask: true });
rule('aws-key', 'error', /\bAKIA[0-9A-Z]{16}\b/g, { mask: true });
rule('telegram-token', 'error', /\b\d{8,10}:AA[A-Za-z0-9_\-]{33}\b/g, { mask: true });
rule('private-key', 'error', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g);

// Machine-specific
const userPathAllow = /^(?:(?:[a-z]{1,2}|test(?:user)?|example|someone|Public|Default|All Users|USERNAME|YourName|you|me|user|username|name|NAME|\*|\.\.\.)$|%[A-Z_]+%|\$env|\$\{|\$\(|<|\{)/i;
rule('win-user-path', 'error', /\b[A-Za-z]:(?:\\\\|\\|\/)Users(?:\\\\|\\|\/)([^\\\/\s"'`<>|:*?;,)\]]+)/g, { allow: (m) => userPathAllow.test(m[1]) });
rule('posix-user-path', 'error', /(?:^|[\s"'`(=])\/(?:c\/Users|home|Users)\/([^\/\s"'`<>|:;,)\]]+)/g, { allow: (m) => userPathAllow.test(m[1]) || /^(runner|node)$/.test(m[1]) });
rule('tailscale-ip', 'error', /\b100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}\b/g);
rule('tailscale-host', 'error', /\b[a-z0-9-]+\.[a-z0-9-]+\.ts\.net\b/gi);
rule('lan-ip', 'warn', /\b(?:192\.168|10\.\d{1,3})\.\d{1,3}\.\d{1,3}\b/g, { binary: false });

// Generic emails (text only; binaries/deps are full of maintainer addresses)
const emailAllow = /@(?:example\.(?:com|org|net)|anthropic\.com|users\.noreply\.github\.com|localhost)$|^(?:noreply|no-reply|user|you|name)@/i;
rule('email', 'error', /\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9\-]+(?:\.[A-Za-z0-9\-]+)*\.[A-Za-z]{2,}\b/g, { binary: false, allow: (m) => emailAllow.test(m[0]) || /\.(png|jpe?g|gif|svg|js|mjs|css|json|md)$/i.test(m[0]) || /@\d+x\./.test(m[0]) });

// Built-in default agent names: allowed as shipped defaults, but reported so a human decides.
rule('preset-agent-names', 'warn', /\b(?:Ash|Flint|Wren|Moss|Lark|Reed|Fern|Slate)\b/g, { binary: false });

// ---------- what to scan ----------
// Source mode: skip local-only / generated content. Paths are relative to root, forward slashes.
const SOURCE_SKIP = [
  /^\.git(\/|$)/, /(^|\/)node_modules(\/|$)/, /^data(\/|$)/, /^server(\/|$)/,
  /^crew\/(logs|logs-archive|work)(\/|$)/, /^dist(\/|$)/, /^tools\/out(\/|$)/,
  /^mod\/(build|\.gradle|run|bin|out)(\/|$)/, /^launcher\/(bin|obj|publish|screenshots)(\/|$)/,
  /^installer\/(bin|obj|publish)(\/|$)/, /^Hivecraft(\.old)?\.exe$/, /^hivecraft\.config\.json$/,
  /^tools\/scrub-scan\.mjs$/, /^tools\/scrub-terms\.local\.json$/, /\.log$/, /\.pid$/,
];
// Payload mode still skips node_modules contents (third-party; only strong tokens would matter and the
// installer normally runs npm itself). Use --strict with -BundleNodeModules builds if you want them.
const PAYLOAD_SKIP = [/(^|\/)node_modules(\/|$)/];

const TEXT_EXT = new Set(['.js', '.mjs', '.cjs', '.ts', '.json', '.md', '.txt', '.ps1', '.psm1', '.bat', '.cmd', '.sh',
  '.cs', '.xaml', '.csproj', '.props', '.targets', '.manifest', '.java', '.gradle', '.properties', '.toml', '.yml', '.yaml',
  '.html', '.htm', '.css', '.xml', '.iss', '.py', '.spec', '.cfg', '.ini', '.lang', '.mcmeta', '.svg', '.csv', '.env']);
const ZIP_EXT = new Set(['.jar', '.zip', '.nupkg']);
const MAX_FILE = 400 * 1024 * 1024;

const findings = [];
const counts = {};
let filesScanned = 0, bytesScanned = 0;

function rel(p) { return path.relative(opt.root, p).split(path.sep).join('/'); }

function* walk(dir) {
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    const full = path.join(dir, e.name);
    const r = rel(full);
    const skip = opt.payload ? PAYLOAD_SKIP : SOURCE_SKIP;
    if (skip.some((re) => re.test(r))) continue;
    if (e.isSymbolicLink()) continue;
    if (e.isDirectory()) yield* walk(full);
    else if (e.isFile()) yield full;
  }
}

function isBinary(buf) {
  const n = Math.min(buf.length, 8192);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

function record(where, line, r, text) {
  counts[r.id] = (counts[r.id] || 0) + 1;
  findings.push({ file: where, line, rule: r.id, severity: r.severity, text });
}

function snippet(s, idx, len, mask) {
  const a = Math.max(0, idx - 40), b = Math.min(s.length, idx + len + 40);
  let hit = s.slice(idx, idx + len);
  if (mask) hit = hit.slice(0, 8) + '…[masked]';
  return (s.slice(a, idx) + hit + s.slice(idx + len, b)).replace(/[\r\n\t]+/g, ' ').replace(/[^\x20-\x7e -￿]/g, '.').trim();
}

function scanText(where, text) {
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    if (ln.includes('scrub-ok')) continue;
    if (ln.length > 20000) { scanBlob(where + ` (line ${i + 1}, minified)`, ln, true); continue; }
    for (const r of rules) {
      r.re.lastIndex = 0;
      let m;
      while ((m = r.re.exec(ln))) {
        if (m[0].length === 0) { r.re.lastIndex++; continue; }
        if (r.allow && r.allow(m)) continue;
        record(where, i + 1, r, snippet(ln, m.index, m[0].length, r.mask));
      }
    }
  }
}

// Binary / huge text: search latin1 view and UTF-16LE view, report byte offsets.
function scanBlob(where, str, textRules = false) {
  for (const r of rules) {
    if (!textRules && !r.binary) continue;
    r.re.lastIndex = 0;
    let m, hits = 0;
    while ((m = r.re.exec(str))) {
      if (m[0].length === 0) { r.re.lastIndex++; continue; }
      if (r.allow && r.allow(m)) continue;
      record(where, '@' + m.index, textRules ? r : { ...r, severity: r.binarySeverity }, snippet(str, m.index, m[0].length, r.mask));
      if (++hits >= 50) break;
    }
  }
}

function scanBinary(where, buf) {
  scanBlob(where, buf.toString('latin1'));
  // UTF-16LE (.NET string literals, PE resources)
  const even = buf.length - (buf.length % 2);
  scanBlob(where + ' [utf16]', buf.subarray(0, even).toString('utf16le'));
  // .NET single-file bundles may store files compressed; we can't inflate those generically here.
}

// Minimal zip reader (central directory) — no deps, handles stored + deflate entries.
function scanZip(where, buf, depth = 0) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 70000); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) { scanBinary(where, buf); return; }
  let count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  if (off === 0xffffffff || count === 0xffff) { scanBinary(where, buf); return; } // zip64: fall back
  for (let k = 0; k < count && off + 46 <= buf.length; k++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) break;
    const method = buf.readUInt16LE(off + 10);
    const csize = buf.readUInt32LE(off + 20);
    const nlen = buf.readUInt16LE(off + 28), xlen = buf.readUInt16LE(off + 30), clen = buf.readUInt16LE(off + 32);
    const lho = buf.readUInt32LE(off + 42);
    const name = buf.subarray(off + 46, off + 46 + nlen).toString('utf8');
    off += 46 + nlen + xlen + clen;
    if (name.endsWith('/')) continue;
    const entryWhere = `${where}!/${name}`;
    // the entry name itself can leak (e.g. a path)
    scanText(entryWhere + ' (name)', name);
    if (buf.readUInt32LE(lho) !== 0x04034b50) continue;
    const lnlen = buf.readUInt16LE(lho + 26), lxlen = buf.readUInt16LE(lho + 28);
    const start = lho + 30 + lnlen + lxlen;
    const raw = buf.subarray(start, start + csize);
    let data;
    try { data = method === 0 ? raw : method === 8 ? zlib.inflateRawSync(raw) : null; } catch { data = null; }
    if (!data) { record(entryWhere, 0, { id: 'unreadable-entry', severity: 'warn' }, `compression method ${method}`); continue; }
    scanBuffer(entryWhere, name, data, depth + 1);
  }
}

function scanBuffer(where, name, buf, depth = 0) {
  filesScanned++; bytesScanned += buf.length;
  const ext = path.extname(name).toLowerCase();
  if (ZIP_EXT.has(ext) && depth < 3) return scanZip(where, buf, depth);
  if (TEXT_EXT.has(ext) || (!isBinary(buf) && buf.length < 20 * 1024 * 1024)) return scanText(where, buf.toString('utf8'));
  return scanBinary(where, buf);
}

// ---------- run ----------
const t0 = Date.now();
for (const f of walk(opt.root)) {
  const r = rel(f);
  scanText(r + ' (path)', r); // file names count too
  let st;
  try { st = fs.statSync(f); } catch { continue; }
  if (st.size > MAX_FILE) { record(r, 0, { id: 'too-big-to-scan', severity: 'warn' }, `${(st.size / 1048576).toFixed(0)} MB`); continue; }
  let buf;
  try { buf = fs.readFileSync(f); } catch (e) { record(r, 0, { id: 'unreadable', severity: 'warn' }, e.message); continue; }
  scanBuffer(r, f, buf);
}

const errors = findings.filter((f) => f.severity === 'error');
const warns = findings.filter((f) => f.severity !== 'error');
const failed = errors.length > 0 || (opt.strict && warns.length > 0);

if (opt.json) {
  console.log(JSON.stringify({ root: opt.root, mode: opt.payload ? 'payload' : 'source', filesScanned, bytesScanned, ms: Date.now() - t0, counts, errors: errors.length, warnings: warns.length, failed, findings }, null, 1));
} else {
  if (!opt.quiet) {
    const per = {};
    for (const f of [...errors, ...warns]) {
      per[f.rule] = (per[f.rule] || 0) + 1;
      if (per[f.rule] > opt.max) continue;
      console.log(`${f.severity === 'error' ? 'ERR ' : 'warn'} ${f.file}:${f.line} [${f.rule}] ${f.text}`);
    }
    for (const [k, v] of Object.entries(per)) if (v > opt.max) console.log(`     ... ${v - opt.max} more [${k}] (raise --max)`);
  }
  console.log(`\nscrub-scan ${opt.payload ? 'payload' : 'source'} ${opt.root}`);
  console.log(`  ${filesScanned} files, ${(bytesScanned / 1048576).toFixed(1)} MB, ${Date.now() - t0} ms`);
  console.log(`  ${errors.length} error(s), ${warns.length} warning(s)` + (Object.keys(counts).length ? '  by rule: ' + Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(' ') : ''));
  console.log(failed ? '  RESULT: FAIL' : '  RESULT: CLEAN');
}
process.exit(failed ? 1 : 0);
