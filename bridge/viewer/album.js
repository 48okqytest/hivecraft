// Photo album: every render is saved to data/photos/<agent>/<ts>.png + <ts>.json; shared photos queue in an inbox
// (data/photos/_inbox.json) so the recipient gets the image attached to its next tool result.
import fs from 'node:fs';
import path from 'node:path';

const SAFE = /^[A-Za-z0-9_]{1,24}$/;

export class Album {
  constructor(dataDir) {
    this.dir = path.join(dataDir, 'photos');
    fs.mkdirSync(this.dir, { recursive: true });
    this.inboxFile = path.join(this.dir, '_inbox.json');
    this.exploredFile = path.join(this.dir, '_explored.json');
    try { this.inbox = JSON.parse(fs.readFileSync(this.inboxFile, 'utf8')); } catch { this.inbox = []; }
    try { this.explored = new Set(JSON.parse(fs.readFileSync(this.exploredFile, 'utf8'))); } catch { this.explored = new Set(); }
    this.index = null; // lazy: newest first
    this._expTimer = null;
  }

  static parseId(id) {
    const m = /^([A-Za-z0-9_]{1,24})-(\d{10,16})$/.exec(String(id || ''));
    return m ? { agent: m[1], ts: Number(m[2]) } : null;
  }

  _load() {
    if (this.index) return this.index;
    const out = [];
    for (const a of fs.readdirSync(this.dir, { withFileTypes: true })) {
      if (!a.isDirectory() || !SAFE.test(a.name)) continue;
      for (const f of fs.readdirSync(path.join(this.dir, a.name))) {
        if (!f.endsWith('.json')) continue;
        try { out.push(JSON.parse(fs.readFileSync(path.join(this.dir, a.name, f), 'utf8'))); } catch { /* skip broken */ }
      }
    }
    out.sort((x, y) => y.ts - x.ts);
    this.index = out;
    return out;
  }

  save(agent, png, meta = {}, caption = '') {
    agent = SAFE.test(agent || '') ? agent : 'team';
    const index = this._load(); // load BEFORE writing, or the new photo is indexed twice
    let ts = Date.now();
    const d = path.join(this.dir, agent);
    fs.mkdirSync(d, { recursive: true });
    while (fs.existsSync(path.join(d, `${ts}.png`))) ts++;
    const rec = { id: `${agent}-${ts}`, agent, ts, caption: String(caption || '').slice(0, 400), mode: meta.mode || null, bytes: png.length, file: `photos/${agent}/${ts}.png`, meta };
    fs.writeFileSync(path.join(d, `${ts}.png`), png);
    fs.writeFileSync(path.join(d, `${ts}.json`), JSON.stringify(rec, null, 1));
    index.unshift(rec);
    return rec;
  }

  list({ agent, limit = 60, before } = {}) {
    let l = this._load();
    if (agent) l = l.filter((r) => r.agent.toLowerCase() === String(agent).toLowerCase());
    if (before) l = l.filter((r) => r.ts < Number(before));
    return l.slice(0, Math.max(1, Math.min(500, Number(limit) || 60)));
  }

  get(id) {
    const p = Album.parseId(id);
    if (!p) return null;
    return this._load().find((r) => r.id === id) || null;
  }

  pngPath(id) {
    const p = Album.parseId(id);
    if (!p) return null;
    const f = path.join(this.dir, p.agent, `${p.ts}.png`);
    return fs.existsSync(f) ? f : null;
  }

  png(id) { const f = this.pngPath(id); return f ? fs.readFileSync(f) : null; }

  latest(agent) { return this.list({ agent, limit: 1 })[0] || null; }

  share({ from, to, id, note }) {
    const rec = id ? this.get(id) : this.latest(from);
    if (!rec) throw new Error(id ? `no photo "${id}"` : `${from} has no photos yet (take one with view)`);
    const names = String(to || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (!names.length) throw new Error('to is required');
    for (const n of names) this.inbox.push({ to: n, from, id: rec.id, note: String(note || '').slice(0, 300), ts: Date.now() });
    if (this.inbox.length > 500) this.inbox.splice(0, this.inbox.length - 500);
    this._saveInbox();
    return { rec, to: names };
  }

  /** next undelivered shared photo for `name` (removed from the inbox), or null */
  take(name) {
    const lower = String(name).toLowerCase();
    const i = this.inbox.findIndex((x) => x.to.toLowerCase() === lower || x.to === 'all' && x.from.toLowerCase() !== lower);
    if (i < 0) return null;
    const item = this.inbox[i];
    if (item.to === 'all') { // deliver once per reader
      item.seen = item.seen || [];
      if (item.seen.includes(lower)) return null;
      item.seen.push(lower);
    } else this.inbox.splice(i, 1);
    this._saveInbox();
    return { ...item, photo: this.get(item.id) };
  }

  pending(name) {
    const lower = String(name).toLowerCase();
    return this.inbox.filter((x) => x.to.toLowerCase() === lower || (x.to === 'all' && x.from.toLowerCase() !== lower && !(x.seen || []).includes(lower))).length;
  }

  _saveInbox() { try { fs.writeFileSync(this.inboxFile, JSON.stringify(this.inbox)); } catch { /* */ } }

  markExplored(x, z) {
    const k = `${Math.floor(x) >> 4},${Math.floor(z) >> 4}`;
    if (this.explored.has(k)) return;
    if (this.explored.size > 40000) return;
    this.explored.add(k);
    clearTimeout(this._expTimer);
    this._expTimer = setTimeout(() => { try { fs.writeFileSync(this.exploredFile, JSON.stringify([...this.explored])); } catch { /* */ } }, 3000);
    this._expTimer.unref?.();
  }

  exploredList() { return [...this.explored].map((k) => k.split(',').map(Number)); }
}
