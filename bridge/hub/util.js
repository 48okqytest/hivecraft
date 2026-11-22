// Small shared helpers for the hub.
export class HttpError extends Error {
  constructor(status, message, extra) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

const NAME_RE = /^[A-Za-z0-9_]{1,16}$/;
export function validName(n) {
  return typeof n === 'string' && NAME_RE.test(n);
}
export function needName(n, what = 'name') {
  if (!validName(n)) throw new HttpError(400, `invalid ${what} "${String(n).slice(0, 40)}" (1-16 letters/digits/underscore)`);
  return n;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function clamp(n, lo, hi, dflt) {
  n = Number(n);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(hi, Math.max(lo, n));
}

export function str(v, max = 2000) {
  if (v === undefined || v === null) return '';
  return String(v).slice(0, max);
}

export function now() {
  return Date.now();
}

export function log(...a) {
  console.log(new Date().toISOString().slice(11, 23), ...a);
}
export function logErr(...a) {
  console.error(new Date().toISOString().slice(11, 23), ...a);
}

export function num(v, name) {
  const n = Number(v);
  if (v === undefined || v === null || v === '' || !Number.isFinite(n)) throw new HttpError(400, `${name} must be a number`);
  return n;
}
