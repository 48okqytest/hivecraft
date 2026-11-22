// Hivecraft world viewer — MAIN bridge process only (headless Chromium + three.js; never import this in a bot worker).
//
//   import { renderView, renderTeamMap, closeViewer } from './bridge/viewer/render.js'
//
//   const { png, meta } = await renderView({
//     handle,            // a BotHandle / ThreadedHandle (runs the internal '_snapshot' action in the bot's worker)
//     snapshot,          // ...or a ready snapshot from bridge/engine/snapshot.js (then handle is not needed)
//     center: {x,y,z},   // default: the bot's position
//     radius: 24,        // horizontal half-size of the block box (<= 48); up/down: vertical extent (defaults 20/16)
//     camera: { mode: 'first_person'|'free'|'orbit'|'map'|'slice'|'auto',
//               pos:{x,y,z}, yaw, pitch,        // free: Minecraft F3 degrees (yaw 0=south 90=west 180=north -90=east; pitch 90=down)
//               look_at:{x,y,z},                 // free: aim at a point instead of yaw/pitch
//               target:{x,y,z}, distance, angle, from:'south'|'north'|..., elevation,   // orbit (angle 0 = camera south of target, clockwise from above; elevation -89 below .. 89 above; yaw/pitch = view direction instead)
//               zoom (narrower fov; map: closer), fov, yaw (map: rotates the map),
//               y,                               // slice: hide everything above this y (default feet+1)
//               slice_y, fov },
//     toggles: { grid, xray, labels (default on), highlight, night_vision, waypoints },
//     ghosts: [{ x,y,z, block:'oak_stairs', props:{facing:'north'}, tint?:'ok'|'done'|'conflict'|'#rrggbb' }],  // <= 20000
//     waypoints: [{name,x,y,z}], team: ['Ash','Flint'],   // for waypoint beams / teammate colours
//     width: 1024, height: 640, title })
//   -> png: Buffer (PNG), meta: { mode, view, origin, size, faces, ms:{snapshot,render}, ghosts:{total,ok,done,conflict,clipped,conflicts:[...]},
//                                  entities:[...], chests, time, unloaded }
//
//   renderTeamMap({ surfaces:[surfaceSnapshot...], bots:[{name,pos,yaw,online}], waypoints, explored:[[cx,cz]], me, width, height })
//
// The browser is launched once (puppeteer-core with a local Chromium: env HIVE_CHROME, the Playwright Chromium in
// %LOCALAPPDATA%\ms-playwright, Chrome or Edge) and reused; renders are serialised through one page.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { loadAssets, bakePalette } from './assets.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.join(HERE, 'web');
const ROOT = path.resolve(HERE, '..', '..');
const THREE_DIR = path.join(ROOT, 'node_modules', 'three');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.png': 'image/png', '.json': 'application/json' };
const MAX_GHOSTS = 20000;
const REPLACEABLE = /^(air|cave_air|void_air|water|lava|short_grass|tall_grass|fern|large_fern|dead_bush|snow|vine|glow_lichen|seagrass|tall_seagrass|fire|soul_fire|light|structure_void|.*_flower|dandelion|poppy|blue_orchid|allium|azure_bluet|.*_tulip|oxeye_daisy|cornflower|lily_of_the_valley|bubble_column)$/;

// ------------------------------------------------------------ static server for the page (and the dashboard)
/** Resolve a /viewer/... asset path to a file (used by the internal server and by the bridge's dashboard routes). */
export function viewerFile(rel) {
  rel = decodeURIComponent(rel).replace(/^\/+/, '');
  if (rel.startsWith('three/')) {
    const f = path.normalize(path.join(THREE_DIR, 'build', rel.slice(6)));
    const f2 = path.normalize(path.join(THREE_DIR, 'examples', 'jsm', rel.slice(6)));
    if (f.startsWith(THREE_DIR) && fs.existsSync(f)) return f;
    if (f2.startsWith(THREE_DIR) && fs.existsSync(f2)) return f2;
    return null;
  }
  const f = path.normalize(path.join(WEB, rel));
  return f.startsWith(WEB) && fs.existsSync(f) && fs.statSync(f).isFile() ? f : null;
}

/** Serve atlas.png / web files / three; returns true if handled. */
export async function serveViewerAsset(rel, res) {
  rel = rel.replace(/^\/+/, '').split('?')[0];
  if (rel === 'atlas.png') {
    const A = await loadAssets();
    res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'max-age=3600' });
    res.end(A.atlasPng); return true;
  }
  const f = viewerFile(rel);
  if (!f) return false;
  res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  fs.createReadStream(f).pipe(res);
  return true;
}

let srv = null;
function startServer() {
  if (srv) return srv;
  srv = new Promise((resolve, reject) => {
    const s = http.createServer(async (req, res) => {
      try {
        const u = new URL(req.url, 'http://x');
        if (!(await serveViewerAsset(u.pathname, res))) { res.writeHead(404); res.end('not found'); }
      } catch (e) { try { res.writeHead(500); res.end(String(e?.message || e)); } catch { /* */ } }
    });
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { s.unref(); resolve({ server: s, port: s.address().port }); });
  });
  return srv;
}

// ------------------------------------------------------------ browser
export function findChrome() {
  if (process.env.HIVE_CHROME && fs.existsSync(process.env.HIVE_CHROME)) return process.env.HIVE_CHROME;
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const pw = path.join(local, 'ms-playwright');
  const cands = [];
  try {
    for (const d of fs.readdirSync(pw).filter((n) => /^chromium-\d+$/.test(n)).sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]))) {
      for (const sub of ['chrome-win64', 'chrome-win']) cands.push(path.join(pw, d, sub, 'chrome.exe'));
    }
  } catch { /* none */ }
  cands.push('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    '/usr/bin/chromium', '/usr/bin/google-chrome');
  const hit = cands.find((c) => fs.existsSync(c));
  if (!hit) throw new Error('no Chromium/Chrome/Edge found for the viewer (set HIVE_CHROME)');
  return hit;
}

let browserP = null, pageP = null, userDataDir = null;
async function getPage() {
  if (pageP) {
    try { const p = await pageP; if (!p.isClosed() && p.browser().connected) return p; } catch { /* relaunch */ }
    pageP = null; browserP = null;
  }
  pageP = (async () => {
    const { default: puppeteer } = await import('puppeteer-core');
    const { port } = await startServer();
    // one profile per process: several bridges/tests may render at the same time
    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hivecraft-viewer-'));
    browserP = puppeteer.launch({
      executablePath: findChrome(), headless: true, userDataDir,
      args: ['--no-first-run', '--no-default-browser-check', '--disable-extensions', '--mute-audio', '--enable-webgl', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader', '--use-angle=swiftshader'],
    });
    const browser = await browserP;
    const page = await browser.newPage();
    page.on('pageerror', (e) => console.error('[viewer page]', e.message));
    page.on('console', (m) => { if (m.type() === 'error') console.error('[viewer page]', m.text()); });
    await page.goto(`http://127.0.0.1:${port}/render.html`, { waitUntil: 'load' });
    await page.waitForFunction('window.hcReady === true', { timeout: 20000 });
    return page;
  })();
  try { return await pageP; } catch (e) { pageP = null; browserP = null; throw e; }
}

let queue = Promise.resolve();
function serial(fn) { const p = queue.then(fn, fn); queue = p.catch(() => {}); return p; }

export async function closeViewer() {
  try { const b = await browserP; await b?.close(); } catch { /* */ }
  browserP = null; pageP = null;
  if (userDataDir) { try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch { /* chrome may still hold files */ } userDataDir = null; }
  try { const s = await srv; s?.server.close(); } catch { /* */ }
  srv = null;
}

// ------------------------------------------------------------ helpers
const b64 = (ta) => Buffer.from(ta.buffer, ta.byteOffset, ta.byteLength).toString('base64');
function asTyped(v, T) {
  if (v instanceof T) return v;
  if (v && typeof v === 'object' && v.type === 'Buffer') return new T(new Uint8Array(v.data).buffer);
  if (v && typeof v === 'object') { const vals = Object.values(v); return T.from(vals); }
  return new T(0);
}
export function normalizeSnapshot(s) {
  if (typeof s === 'string') s = JSON.parse(s);
  if (!s || typeof s !== 'object') throw new Error('bad snapshot');
  if (s.kind === 'surface') { s.top = asTyped(s.top, Uint16Array); s.height = asTyped(s.height, Int16Array); return s; }
  s.cells = asTyped(s.cells, Uint16Array); s.light = asTyped(s.light, Uint8Array);
  return s;
}
const keyOf = (block, props) => {
  const name = String(block || '').replace(/^minecraft:/, '');
  const ks = props ? Object.keys(props).sort() : [];
  return ks.length ? `${name}[${ks.map((k) => `${k}=${props[k]}`).join(',')}]` : name;
};

function ghostBox(ghosts) {
  const min = { x: Infinity, y: Infinity, z: Infinity }, max = { x: -Infinity, y: -Infinity, z: -Infinity };
  for (const g of ghosts) for (const a of ['x', 'y', 'z']) { if (g[a] < min[a]) min[a] = g[a]; if (g[a] > max[a]) max[a] = g[a]; }
  return { min, max };
}

// One axis of the free-camera snapshot box: spans the look target `a` and the camera `b` plus a margin; when that is wider than
// the cap, a cap-wide window that keeps the target (with margin) inside and sits as close to the camera as possible.
function fitAxis(a, b, margin, cap) {
  const lo = Math.floor(Math.min(a, b) - margin), hi = Math.ceil(Math.max(a, b) + margin);
  if (hi - lo + 1 <= cap) return [lo, hi];
  let start = Math.round((a + b) / 2 - cap / 2);
  start = Math.max(Math.ceil(a) - cap + 1 + margin, Math.min(Math.floor(a) - margin, start));
  return [start, start + cap - 1];
}
/** snapshot box for a free camera: covers camera position + look target (look_at, or 24 blocks along yaw/pitch) */
export function freeBox(camera) {
  const p = camera.pos;
  let t = camera.look_at;
  if (!t) {
    const y = ((camera.yaw ?? 180) * Math.PI) / 180, pt = ((camera.pitch ?? 20) * Math.PI) / 180;
    t = { x: p.x - Math.sin(y) * Math.cos(pt) * 24, y: p.y - Math.sin(pt) * 24, z: p.z + Math.cos(y) * Math.cos(pt) * 24 };
  }
  const [x0, x1] = fitAxis(t.x, p.x, 12, 97), [z0, z1] = fitAxis(t.z, p.z, 12, 97), [y0, y1] = fitAxis(t.y ?? p.y, p.y, 10, 96);
  return { min: { x: x0, y: y0, z: z0 }, max: { x: x1, y: y1, z: z1 } };
}

/** Ask a bot handle for a snapshot (works with the threaded and the in-process engine). */
export async function snapshotFrom(handle, args) {
  if (!handle?.run) throw new Error('no bot handle to snapshot from');
  return normalizeSnapshot(await handle.run('_snapshot', args));
}

// ------------------------------------------------------------ renderView
export async function renderView(opts = {}) {
  const t0 = Date.now();
  const A = await loadAssets();
  let ghosts = Array.isArray(opts.ghosts) ? opts.ghosts.filter((g) => g && Number.isFinite(+g.x) && Number.isFinite(+g.y) && Number.isFinite(+g.z) && g.block) : [];
  const totalGhosts = ghosts.length;
  if (ghosts.length > MAX_GHOSTS) ghosts = ghosts.slice(0, MAX_GHOSTS);
  ghosts = ghosts.map((g) => ({ ...g, x: Math.floor(g.x), y: Math.floor(g.y), z: Math.floor(g.z) }));
  const gb = ghosts.length ? ghostBox(ghosts) : null;
  const camera = { ...(opts.camera || {}) };
  if (!camera.mode) camera.mode = gb ? 'auto' : 'orbit';

  let snap = opts.snapshot ? normalizeSnapshot(opts.snapshot) : null;
  let snapMs = 0;
  if (!snap) {
    const args = { radius: opts.radius, up: opts.up, down: opts.down };
    if (opts.center) args.center = opts.center;
    if (gb && opts.radius == null) {
      args.box = { min: { x: gb.min.x - 6, y: gb.min.y - 4, z: gb.min.z - 6 }, max: { x: gb.max.x + 6, y: gb.max.y + 6, z: gb.max.z + 6 } };
    } else if (camera.mode === 'free' && camera.pos && opts.radius == null) {
      args.box = freeBox(camera); // cover the camera position AND the look target (within the 97x96x97 snapshot cap)
    } else if (camera.mode === 'first_person' && opts.radius == null) {
      args.radius = 32; args.up = 24; args.down = 12;
    } else if (camera.mode === 'map' && opts.radius == null) {
      args.radius = 32; args.up = opts.up ?? 30; args.down = opts.down ?? 12;
    }
    const ts = Date.now();
    snap = await snapshotFrom(opts.handle, args);
    snapMs = Date.now() - ts;
  }
  if (snap.kind !== 'blocks') throw new Error('renderView needs a blocks snapshot');

  // ghosts: classify against the real terrain
  const { origin, size } = snap; const SX = size.x, SZ = size.z;
  const gPalette = []; const gIdx = new Map();
  const gOut = []; const counts = { total: totalGhosts, ok: 0, done: 0, conflict: 0, clipped: totalGhosts - ghosts.length, conflicts: [] };
  for (const g of ghosts) {
    const k = keyOf(g.block, g.props || g.state);
    let pi = gIdx.get(k); if (pi === undefined) { pi = gPalette.length; gPalette.push(k); gIdx.set(k, pi); }
    const lx = g.x - origin.x, ly = g.y - origin.y, lz = g.z - origin.z;
    const inside = lx >= 0 && ly >= 0 && lz >= 0 && lx < SX && ly < size.y && lz < SZ;
    if (!inside) { counts.clipped++; continue; }
    let cls = g.tint;
    const actualKey = snap.palette[snap.cells[(ly * SZ + lz) * SX + lx]] || 'air';
    const actual = actualKey.split('[')[0];
    if (!cls) cls = actual === String(g.block).replace(/^minecraft:/, '') ? 'done' : REPLACEABLE.test(actual) ? 'ok' : 'conflict';
    if (cls === 'ok' || cls === 'done' || cls === 'conflict') counts[cls]++;
    if (cls === 'conflict' && counts.conflicts.length < 30) counts.conflicts.push({ x: g.x, y: g.y, z: g.z, ghost: g.block, actual });
    gOut.push({ x: g.x, y: g.y, z: g.z, pi, cls });
  }

  const W = Math.max(256, Math.min(1600, Math.round(opts.width || 1024))), H = Math.max(160, Math.min(1200, Math.round(opts.height || 640)));
  const payload = {
    snap: { ...snap, cells: b64(snap.cells), light: b64(snap.light) },
    baked: bakePalette(A, snap.palette),
    ghosts: gOut, ghostBaked: gOut.length ? bakePalette(A, gPalette) : null, ghostBox: gb,
    liquidUV: { water: A.uvRect('block/water_still'), lava: A.uvRect('block/lava_still') }, tints: A.tints,
    camera, toggles: opts.toggles || {}, waypoints: opts.waypoints || [], team: opts.team || [], width: W, height: H, title: opts.title,
  };
  const r = await serial(async () => {
    const page = await getPage();
    return page.evaluate((p) => window.hcRender(p), payload);
  });
  const png = Buffer.from(r.png, 'base64');
  const meta = {
    agent: opts.agent || snap.bot?.name || null, mode: camera.mode, view: r.view, camera, toggles: opts.toggles || {},
    origin, size, faces: r.faces, bot: snap.bot, center: snap.center, time: snap.time, dimension: snap.dimension, unloaded: snap.unloaded,
    entities: (snap.entities || []).filter((e) => e.kind !== 'item').slice(0, 30).map((e) => ({ kind: e.kind, name: e.name, x: Math.floor(e.pos.x), y: Math.floor(e.pos.y), z: Math.floor(e.pos.z) })),
    chests: (snap.chests || []).length, ghosts: gOut.length || totalGhosts ? counts : undefined,
    ms: { snapshot: snapMs || snap.ms || 0, render: r.ms, total: Date.now() - t0 }, width: W, height: H,
  };
  return { png, meta };
}

// ------------------------------------------------------------ team map
export async function renderTeamMap({ surfaces = [], bots = [], waypoints = [], explored = [], me = null, width = 1024, height = 640, title } = {}) {
  const A = await loadAssets();
  const pts = [];
  for (const s of surfaces) { pts.push([s.origin.x, s.origin.z], [s.origin.x + s.size.x - 1, s.origin.z + s.size.z - 1]); }
  for (const b of bots) if (b.pos) pts.push([b.pos.x, b.pos.z]);
  for (const w of waypoints) pts.push([w.x, w.z]);
  // explored chunks only widen the map near the team (old trips far away would shrink everything to a dot)
  const anchors = bots.filter((b) => b.pos).map((b) => [b.pos.x, b.pos.z]);
  for (const [cx, cz] of explored) {
    const x = cx * 16 + 8, z = cz * 16 + 8;
    if (!anchors.length || anchors.some(([ax, az]) => Math.abs(ax - x) < 256 && Math.abs(az - z) < 256)) pts.push([cx * 16, cz * 16], [cx * 16 + 15, cz * 16 + 15]);
  }
  if (!pts.length) pts.push([-32, -32], [32, 32]);
  let minX = Math.min(...pts.map((p) => p[0])) - 8, maxX = Math.max(...pts.map((p) => p[0])) + 8;
  let minZ = Math.min(...pts.map((p) => p[1])) - 8, maxZ = Math.max(...pts.map((p) => p[1])) + 8;
  // cap the map at 2048 blocks across, centred on the bots
  const cap = 2048;
  if (maxX - minX > cap) { const c = (minX + maxX) / 2; minX = Math.floor(c - cap / 2); maxX = minX + cap; }
  if (maxZ - minZ > cap) { const c = (minZ + maxZ) / 2; minZ = Math.floor(c - cap / 2); maxZ = minZ + cap; }
  const payload = {
    surfaces: surfaces.map((s0) => {
      const s = normalizeSnapshot(s0);
      return { origin: s.origin, size: s.size, top: b64(s.top), height: b64(s.height), colors: s.palette.map((k) => A.mapColor(k)) };
    }),
    bounds: { minX: Math.floor(minX), minZ: Math.floor(minZ), maxX: Math.ceil(maxX), maxZ: Math.ceil(maxZ) },
    explored, bots: bots.map((b) => ({ ...b, me: b.name === me })), waypoints, width, height, title,
  };
  const r = await serial(async () => {
    const page = await getPage();
    return page.evaluate((p) => window.hcMap(p), payload);
  });
  return { png: Buffer.from(r.png, 'base64'), meta: { bounds: payload.bounds, bots: bots.map((b) => b.name), waypoints: waypoints.length, explored: explored.length, scale: r.scale } };
}
