// Viewer + photo album routes for the bridge (hooked in by app.js: attachViewer(...) + viewer.handleRaw(...)).
//
// POST /bots/:name/view      {camera?, toggles?, ghosts?, center?, radius?, up?, down?, width?, height?, caption?, agent?, save?=true}
//                             -> {ok, id, caption, meta, png(base64)}  (agent set = counts against that agent's render rate limit)
// GET  /bots/:name/snapshot  ?radius&up&down  -> data for the dashboard live 3D view {snap, baked, liquidUV, tints, waypoints, team}
// POST /team_map             {agent?, radius?, width?, height?} -> {ok, id, caption, meta, png}
// GET  /photos               ?agent&limit&before -> [photo records]   GET /photos/:id -> record   GET /photos/:id.png -> image
// POST /photos/share         {from, to, id?, note?}  (id defaults to from's latest photo; also posts a chat message)
// GET  /photos/inbox/:name   ?peek=1 -> {pending, item:{from,id,note,photo}|null, png?}  (takes the next shared photo)
// GET  /viewer/limits/:name  -> {limit, used, resetInMs}
// GET  /viewer/*             static: render.html, scene.js, mesher.js, map.js, atlas.png, three/*
import fs from 'node:fs';
import { HttpError, clamp, logErr, log } from './util.js';
import { Album } from '../viewer/album.js';

const num = (v) => (v === undefined || v === null || v === '' ? undefined : Number(v));

export function attachViewer({ route, bots, store, broadcast, dataDir }) {
  const album = new Album(dataDir);
  let R = null; // lazy: the viewer module (puppeteer etc.) loads on first use
  const viewer = async () => (R ||= await import('../viewer/render.js'));
  const LIMIT = Math.max(1, Number(process.env.HIVE_VIEW_RATE) || 20); // renders per agent per minute
  const hits = new Map(); // agent -> [ts]

  function rate(agent, cost = 1) {
    if (!agent) return;
    const now = Date.now();
    const l = (hits.get(agent) || []).filter((t) => now - t < 60000);
    if (l.length + cost > LIMIT) {
      const wait = Math.ceil((60000 - (now - l[0])) / 1000);
      hits.set(agent, l);
      throw new HttpError(429, `render limit reached (${LIMIT} images per minute per agent). Try again in ${wait}s, or use survey (free text map) meanwhile.`, { retryInS: wait });
    }
    for (let i = 0; i < cost; i++) l.push(now);
    hits.set(agent, l);
  }

  const onlineHandle = (name) => {
    const s = bots.slot(name);
    if (s.status !== 'online' || !s.handle) throw new HttpError(409, `${s.name} is offline`);
    return { s, handle: s.handle };
  };
  const waypointsList = () => Object.values(store.waypoints || {});
  const teamNames = () => bots.names();

  // explored area: sample bot positions
  const sampler = setInterval(() => {
    try { for (const b of bots.list()) if (b.online && b.pos) album.markExplored(b.pos.x, b.pos.z); } catch { /* */ }
  }, 2000);
  sampler.unref?.();

  function publish(rec) {
    try { broadcast('photo', rec); } catch { /* */ }
  }

  function vec(v) {
    if (!v || typeof v !== 'object') return undefined;
    const o = { x: Number(v.x), y: Number(v.y), z: Number(v.z) };
    return Number.isFinite(o.x) && Number.isFinite(o.z) ? { ...o, y: Number.isFinite(o.y) ? o.y : undefined } : undefined;
  }

  route('POST', '/bots/:name/view', async ({ params, body }) => {
    const { s, handle } = onlineHandle(params.name);
    const agent = body.agent ? String(body.agent) : null;
    rate(agent);
    const toggles = { ...(body.toggles || {}) };
    const R2 = await viewer();
    let out;
    try {
      out = await R2.renderView({
        handle, center: vec(body.center), radius: num(body.radius), up: num(body.up), down: num(body.down),
        camera: body.camera || {}, toggles, ghosts: Array.isArray(body.ghosts) ? body.ghosts : undefined,
        waypoints: toggles.waypoints ? waypointsList() : [], team: teamNames(), width: num(body.width), height: num(body.height), title: body.title, agent: agent || s.name,
      });
    } catch (e) {
      if (agent) { const l = hits.get(agent) || []; l.pop(); hits.set(agent, l); } // failed renders don't count
      throw new HttpError(500, `render failed: ${e?.message || e}`);
    }
    const caption = String(body.caption || out.meta.view || '').slice(0, 300);
    let rec = null;
    const owner = /^[A-Za-z0-9_]{1,24}$/.test(String(body.owner || '')) ? body.owner : null; // e.g. the player's name for dashboard snaps
    if (body.save !== false) { rec = album.save(agent || owner || s.name, out.png, out.meta, caption); publish(rec); }
    return { ok: true, id: rec?.id || null, caption, meta: out.meta, png: out.png.toString('base64') };
  });

  route('GET', '/bots/:name/snapshot', async ({ params, query }) => {
    const { handle } = onlineHandle(params.name);
    const R2 = await viewer();
    const { loadAssets, bakePalette } = await import('../viewer/assets.js');
    const A = await loadAssets();
    const snap = await R2.snapshotFrom(handle, { radius: clamp(query.radius, 4, 48, 24), up: clamp(query.up, 2, 64, 20), down: clamp(query.down, 2, 64, 14) });
    const b64 = (ta) => Buffer.from(ta.buffer, ta.byteOffset, ta.byteLength).toString('base64');
    return {
      snap: { ...snap, cells: b64(snap.cells), light: b64(snap.light) }, baked: bakePalette(A, snap.palette),
      liquidUV: { water: A.uvRect('block/water_still'), lava: A.uvRect('block/lava_still') }, tints: A.tints, waypoints: waypointsList(), team: teamNames(),
    };
  });

  route('POST', '/team_map', async ({ body }) => {
    const agent = body.agent ? String(body.agent) : null;
    rate(agent);
    const R2 = await viewer();
    const list = bots.list();
    const radius = clamp(body.radius, 16, 160, 96);
    const surfaces = [];
    for (const b of list) {
      if (!b.online) continue;
      try {
        const { handle } = onlineHandle(b.name);
        surfaces.push(await handle.run('_snapshot', { surface: true, radius, entities: false }));
      } catch (e) { logErr(`team_map: surface from ${b.name} failed:`, e.message); }
    }
    let out;
    try {
      out = await R2.renderTeamMap({
        surfaces, bots: list.map((b) => ({ name: b.name, pos: b.pos, online: b.online })), waypoints: waypointsList(), explored: album.exploredList(), me: agent,
        width: num(body.width) || 1024, height: num(body.height) || 640, title: `Team map — ${list.filter((b) => b.online).length} bots, ${Object.keys(store.waypoints || {}).length} waypoints (grey = explored, colour = loaded terrain)`,
      });
    } catch (e) {
      if (agent) { const l = hits.get(agent) || []; l.pop(); hits.set(agent, l); }
      throw new HttpError(500, `team map failed: ${e?.message || e}`);
    }
    const caption = 'team map';
    const rec = body.save === false ? null : album.save(agent || 'team', out.png, { mode: 'team_map', ...out.meta }, caption);
    if (rec) publish(rec);
    return { ok: true, id: rec?.id || null, caption, meta: out.meta, png: out.png.toString('base64') };
  });

  route('GET', '/photos', ({ query }) => album.list({ agent: query.agent, limit: query.limit, before: query.before }));
  route('GET', '/photos/inbox/:name', ({ params, query }) => {
    if (query.peek) return { pending: album.pending(params.name) };
    const item = album.take(params.name);
    if (!item) return { pending: 0, item: null };
    const png = album.png(item.id);
    return { pending: album.pending(params.name), item, png: png ? png.toString('base64') : null };
  });
  route('GET', '/photos/:id', ({ params }) => {
    const r = album.get(params.id);
    if (!r) throw new HttpError(404, `no photo "${params.id}"`);
    return { ...r, png: undefined };
  });
  route('POST', '/photos/share', ({ body }) => {
    const from = String(body.from || '').trim();
    if (!from) throw new HttpError(400, 'from is required');
    let r;
    try { r = album.share({ from, to: body.to, id: body.id, note: body.note }); } catch (e) { throw new HttpError(404, e.message); }
    const text = `📷 shared photo ${r.rec.id}${body.note ? `: ${String(body.note).slice(0, 200)}` : r.rec.caption ? ` (${r.rec.caption.slice(0, 120)})` : ''} — it arrives with your next tool result (or photo_view id:"${r.rec.id}")`;
    try { store.addMessage({ from, to: r.to.join(','), text }); } catch (e) { logErr('share message:', e.message); }
    broadcast('photo_share', { from, to: r.to, id: r.rec.id, note: body.note || '' });
    return { ok: true, id: r.rec.id, to: r.to };
  });
  route('GET', '/viewer/limits/:name', ({ params }) => {
    const l = (hits.get(params.name) || []).filter((t) => Date.now() - t < 60000);
    return { limit: LIMIT, used: l.length, resetInMs: l.length ? 60000 - (Date.now() - l[0]) : 0 };
  });

  return {
    album,
    /** raw (non-JSON) responses: photo PNGs and viewer static files. Returns true if handled. */
    async handleRaw(req, res, pathname) {
      if (req.method !== 'GET') return false;
      let m = /^\/photos\/([A-Za-z0-9_]{1,24}-\d{10,16})\.png$/.exec(pathname);
      if (m) {
        const f = album.pngPath(m[1]);
        if (!f) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('no such photo'); return true; }
        res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'max-age=86400' });
        fs.createReadStream(f).pipe(res);
        return true;
      }
      m = /^\/viewer\/(.+)$/.exec(pathname);
      if (m && !/^limits\//.test(m[1])) {
        const R2 = await viewer();
        if (await R2.serveViewerAsset(m[1], res)) return true;
        res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('not found'); return true;
      }
      return false;
    },
    async close() {
      clearInterval(sampler);
      if (R) { try { await R.closeViewer(); } catch { /* */ } }
    },
  };
}
