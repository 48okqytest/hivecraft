// Build jobs on disk (data/blueprints/builds/<id>/): job.json (where/how), bp.json (frozen blueprint copy),
// sec-<n>.claim (atomic O_EXCL lock = which bot builds that section), sec-<n>.json (progress: scaffold, failures, done).
// All bots run in one bridge process (worker threads) on one machine, so exclusive file creation is a safe lock.
import fs from 'node:fs';
import path from 'node:path';
import { Blueprint, BUILDS_DIR, safeName } from './model.js';
import { targetsFor, boundsOf, makeSections } from './plan.js';

export const STALE_MS = 10 * 60 * 1000;
const dirOf = (id) => path.join(BUILDS_DIR, safeName(id));
const readJson = (f, d = null) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const writeJson = (f, v) => { const t = `${f}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`; fs.writeFileSync(t, JSON.stringify(v)); fs.renameSync(t, f); };

export function jobIdFor(name, origin, rotation = 0, mirror = null) {
  return safeName(`${name}_${origin.x}_${origin.y}_${origin.z}${rotation ? `_r${rotation}` : ''}${mirror ? `_m${mirror}` : ''}`);
}

export function createJob({ bp, origin, rotation = 0, mirror = null, parts = 1, by, clear = 'bbox', fill = true, id }) {
  const jid = id ? safeName(id) : jobIdFor(bp.name, origin, rotation, mirror);
  const dir = dirOf(jid);
  const existing = readJson(path.join(dir, 'job.json'));
  if (existing) return loadJob(jid);
  fs.mkdirSync(dir, { recursive: true });
  const targets = targetsFor(bp, { origin, rotation, mirror });
  const bounds = boundsOf(targets);
  const sections = makeSections(bounds, parts);
  const job = { id: jid, blueprint: bp.name, origin, rotation, mirror, parts: sections.length, sections, bounds, clear, fill, by, created: new Date().toISOString() };
  writeJson(path.join(dir, 'bp.json'), bp.toJSON());
  writeJson(path.join(dir, 'job.json'), job);
  return job;
}

export function loadJob(id) {
  const dir = dirOf(id);
  const job = readJson(path.join(dir, 'job.json'));
  if (!job) {
    const have = listJobs().map((j) => j.id);
    throw new Error(`No build job "${id}". Known builds: ${have.slice(0, 12).join(', ') || 'none'}.`);
  }
  return job;
}
export function jobBlueprint(job) { return Blueprint.fromJSON(readJson(path.join(dirOf(job.id), 'bp.json'))); }
export function listJobs() {
  if (!fs.existsSync(BUILDS_DIR)) return [];
  return fs.readdirSync(BUILDS_DIR).map((d) => readJson(path.join(BUILDS_DIR, d, 'job.json'))).filter(Boolean);
}
export function deleteJob(id) { fs.rmSync(dirOf(id), { recursive: true, force: true }); }

// ---------- progress ----------
const progFile = (job, s) => path.join(dirOf(job.id), `sec-${s}.json`);
const claimFile = (job, s) => path.join(dirOf(job.id), `sec-${s}.claim`);
export function readProgress(job, s) {
  return readJson(progFile(job, s), { section: s, scaffold: [], failed: {}, done: false, placed: 0, cleared: 0, filled: 0, runs: 0 });
}
export function writeProgress(job, s, prog) { writeJson(progFile(job, s), { ...prog, section: s, updated: Date.now() }); }

// ---------- claims ----------
export function readClaim(job, s) { return readJson(claimFile(job, s)); }
function tryCreateClaim(job, s, bot) {
  try { fs.writeFileSync(claimFile(job, s), JSON.stringify({ bot, ts: Date.now() }), { flag: 'wx' }); return true; } catch (e) { if (e.code === 'EEXIST') return false; throw e; }
}
export function heartbeat(job, s, bot) {
  const c = readClaim(job, s);
  if (c && c.bot === bot) writeJson(claimFile(job, s), { bot, ts: Date.now() });
}
export function releaseClaim(job, s, bot) {
  const c = readClaim(job, s);
  if (c && (!bot || c.bot === bot)) { try { fs.unlinkSync(claimFile(job, s)); } catch { /* */ } }
}

/**
 * Pick the section this bot should work on: one it already holds (not done), else claim a free one,
 * else take over a stale claim. Returns {section, takenOver?} or {section:null, others:[{section,bot}], allDone}.
 */
export function claimSection(job, bot, { prefer = null, staleMs = STALE_MS } = {}) {
  const ids = job.sections.map((s) => s.id);
  const order = prefer !== null && ids.includes(prefer) ? [prefer, ...ids.filter((i) => i !== prefer)] : ids;
  const done = new Set(ids.filter((i) => readProgress(job, i).done));
  for (const i of order) { if (done.has(i)) continue; const c = readClaim(job, i); if (c?.bot === bot) { heartbeat(job, i, bot); return { section: i }; } }
  for (const i of order) { if (done.has(i)) continue; if (tryCreateClaim(job, i, bot)) return { section: i }; }
  for (const i of order) {
    if (done.has(i)) continue;
    const c = readClaim(job, i);
    if (c && Date.now() - c.ts > staleMs) { writeJson(claimFile(job, i), { bot, ts: Date.now() }); return { section: i, takenOver: c.bot }; }
  }
  const others = order.filter((i) => !done.has(i)).map((i) => ({ section: i, bot: readClaim(job, i)?.bot || '?' }));
  return { section: null, others, allDone: done.size === ids.length };
}

export function jobSummary(job) {
  return job.sections.map((s) => {
    const p = readProgress(job, s.id), c = readClaim(job, s.id);
    return { section: s.id, done: !!p.done, bot: c?.bot || null, placed: p.placed || 0, remaining: p.remaining ?? null };
  });
}
