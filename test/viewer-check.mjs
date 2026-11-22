// World viewer check.   node test/viewer-check.mjs            (offline only, default)
//                        node test/viewer-check.mjs --live     (ONLY with the owner's OK: scripted bots on the live server) [--force]
//  1. offline: renders a synthetic snapshot in every camera mode / toggle + ghosts (no server needed)
//  2. live, opt-in with --live (needs the MC server on :25590, RCON :25591; skipped when a human is online unless --force):
//     own bridge on :47961 (data/viewer-live), two scripted bots teleported to x~420 z~420, a tiny test build placed and
//     removed again via RCON, every camera mode + toggle + ghost layer through POST /bots/:name/view, team_map, album,
//     share/inbox, rate limit, survey, and an MCP-level check (real MCP client -> mc-mcp.js) that view returns image content.
// Output PNGs: data/viewer-test/  (look at them!)
import './neutral-player.mjs'; // neutral human player (Robin / robin_mc), set before the bridge reads config
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { renderView, closeViewer } from '../bridge/viewer/render.js';
import { synthSnapshot } from './viewer-synth.mjs';
import { makeViewerTools } from '../mcp/viewer-tools.js';
process.env.HIVE_EARNINGS_POLL = '0'; // tests never poll a live Minecraft server (earnings scoreboards/time)
const NO_RCON = { rcon: async (cmd) => { throw new Error(`no RCON in tests (${cmd})`); }, timers: false }; // never the real :25591

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'data', 'viewer-test');
fs.mkdirSync(OUT, { recursive: true });
const argv = new Set(process.argv.slice(2));
const PNG_SIG = '89504e470d0a1a0a';
let pass = 0, fail = 0;
const ok = (c, msg) => { if (c) { pass++; console.log('  ok  ', msg); } else { fail++; console.log('  FAIL', msg); } };
const isPng = (buf) => buf && buf.length > 1000 && buf.subarray(0, 8).toString('hex') === PNG_SIG;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ 1. offline
console.log('== offline (synthetic snapshot)');
{
  const snap = synthSnapshot();
  const cases = [
    ['orbit', { camera: { mode: 'orbit' } }],
    ['first_person', { camera: { mode: 'first_person' } }],
    ['free', { camera: { mode: 'free', pos: { x: 430, y: 75, z: 432 }, look_at: { x: 410, y: 65, z: 410 } } }],
    ['map-grid', { camera: { mode: 'map' }, toggles: { grid: true } }],
    ['slice', { camera: { mode: 'slice', y: 66 } }],
    ['xray-highlight', { camera: { mode: 'orbit', from: 'southeast' }, toggles: { xray: true, highlight: true } }],
    ['night', { camera: { mode: 'orbit' }, patch: { time: { timeOfDay: 18000 } } }],
    ['night-vision', { camera: { mode: 'orbit' }, toggles: { night_vision: true }, patch: { time: { timeOfDay: 18000 } } }],
    ['waypoints', { camera: { mode: 'orbit', distance: 30 }, toggles: { waypoints: true }, waypoints: [{ name: 'base', x: 409, y: 65, z: 410 }, { name: 'pond', x: 407, y: 64, z: 423 }] }],
    ['ghosts', { ghosts: [...Array(5).keys()].flatMap((i) => [{ x: 414 + i, y: 66, z: 420, block: 'stone_bricks' }, { x: 414 + i, y: 67, z: 420, block: 'oak_planks' }]).concat([{ x: 407, y: 65, z: 409, block: 'oak_log', props: { axis: 'y' } }]) }], // last one sits on the chest -> conflict
  ];
  for (const [name, o] of cases) {
    try {
      const { png, meta } = await renderView({ snapshot: Object.assign(structuredClone(snap), o.patch || {}), ...o });
      fs.writeFileSync(path.join(OUT, `offline-${name}.png`), png);
      ok(isPng(png) && meta.faces > 1000, `offline ${name}: ${png.length} B, ${meta.faces} faces, ${meta.ms.render} ms — ${meta.view}`);
      if (name === 'ghosts') ok(meta.ghosts.total === 11 && meta.ghosts.conflict >= 1, `ghost classification ${JSON.stringify({ ok: meta.ghosts.ok, done: meta.ghosts.done, conflict: meta.ghosts.conflict })}`);
    } catch (e) { ok(false, `offline ${name}: ${e.stack || e}`); }
  }
}
// any-angle camera: orbit angle/elevation (incl. from below), yaw/pitch, far free camera; built through the MCP viewBody like an agent would
{
  const snap = synthSnapshot();
  const VT = makeViewerTools({ BOT: 'X', URL_BASE: 'http://x', enc: encodeURIComponent, trunc: (s) => s, get: async () => null, post: async () => ({}) });
  const T = { x: 409, y: 66, z: 410 }; // the house
  const angleCases = [
    ['angle-0', { mode: 'orbit', ...T, angle: 0, elevation: 20, distance: 16 }],
    ['angle-90', { mode: 'orbit', ...T, angle: 90, elevation: 20, distance: 16 }],
    ['angle-180', { mode: 'orbit', ...T, angle: 180, elevation: 20, distance: 16 }],
    ['angle-270', { mode: 'orbit', ...T, angle: 270, elevation: 20, distance: 16 }],
    ['elev-0', { mode: 'orbit', ...T, angle: 30, elevation: 0, distance: 16 }],
    ['elev-85', { mode: 'orbit', ...T, angle: 30, elevation: 85, distance: 16 }],
    ['elev-neg60', { mode: 'orbit', ...T, angle: 30, elevation: -60, distance: 16, xray: true }],
    ['elev-neg60-cave', { mode: 'orbit', x: 424, y: 59, z: 420, angle: 200, elevation: -40, distance: 8, xray: true }],
    ['elev-neg89', { mode: 'orbit', ...T, angle: 0, elevation: -89, distance: 14, xray: true }],
    ['elev-pos89', { mode: 'orbit', ...T, angle: 0, elevation: 89, distance: 14 }],
    ['orbit-yawpitch', { mode: 'orbit', ...T, yaw: 90, pitch: 25, distance: 16 }],
    ['orbit-zoom', { mode: 'orbit', ...T, angle: 20, elevation: 30, distance: 30, zoom: 3 }],
    ['free-far', { mode: 'free', x: 470, y: 90, z: 470, look_x: 409, look_y: 66, look_z: 410 }],
    ['free-yawpitch', { mode: 'free', x: 409, y: 75, z: 425, yaw: 180, pitch: 30 }],
    ['free-straight-down', { mode: 'free', x: 409, y: 90, z: 410, pitch: 90, yaw: 0 }],
    ['free-straight-up', { mode: 'free', x: 409, y: 66, z: 410, pitch: -90, yaw: 0 }],
    ['fp-lookup', { mode: 'first_person', yaw: 180, pitch: -45 }],
    ['map-rot-zoom', { mode: 'map', look_x: 409, look_z: 410, yaw: 90, zoom: 2.5, grid: true }],
  ];
  for (const [name, a] of angleCases) {
    try {
      const body = VT.viewBody(a);
      const { png, meta } = await renderView({ snapshot: structuredClone(snap), camera: body.camera, toggles: body.toggles });
      fs.writeFileSync(path.join(OUT, `offline-${name}.png`), png);
      ok(isPng(png) && meta.faces > 1000, `any-angle ${name}: ${png.length} B — ${meta.view}`);
    } catch (e) { ok(false, `any-angle ${name}: ${e.stack || e}`); }
  }
  // the camera maths: angle convention, negative elevation, tool param mapping
  ok(VT.viewBody({ mode: 'orbit', x: 1, y: 2, z: 3, from: '90', elevation: -60 }).camera.angle === 90 && VT.viewBody({ mode: 'orbit', x: 1, z: 3, angle: 450, elevation: -60 }).camera.elevation === -60, 'viewBody: from degrees / angle / negative elevation pass through');
  ok(VT.viewBody({ mode: 'orbit', x: 1, y: 2, z: 3, look_x: 9, look_y: 8, look_z: 7 }).camera.target.x === 9.5, 'viewBody: look_x/y/z is the orbit target');
  const fr = VT.viewBody({ mode: 'free', x: 10, y: 70, z: 10, look_x: 300, look_y: 60, look_z: 300 });
  const { freeBox } = await import('../bridge/viewer/render.js');
  const fb = freeBox(fr.camera);
  ok(fb.max.x - fb.min.x + 1 <= 97 && fb.max.z - fb.min.z + 1 <= 97 && fb.min.x <= 300 && fb.max.x >= 300 && fb.min.z <= 300 && fb.max.z >= 300, `freeBox far target stays in the 97 cap and keeps the target: ${JSON.stringify(fb)}`);
  const fb2 = freeBox({ pos: { x: 100, y: 80, z: 100 }, look_at: { x: 130, y: 64, z: 90 } });
  ok(fb2.min.x <= 100 && fb2.max.x >= 130 && fb2.min.z <= 90 && fb2.max.z >= 100 && fb2.min.y <= 64 && fb2.max.y >= 80, `freeBox covers camera + target: ${JSON.stringify(fb2)}`);
}
// expandActionResult (the {text, view} contract for engine actions like blueprint_preview) — with a fake bridge call
{
  let sent = null;
  const VT = makeViewerTools({ BOT: 'X', URL_BASE: 'http://x', enc: encodeURIComponent, trunc: (s) => s, get: async () => null, post: async (p, b) => { sent = { p, b }; return { ok: true, id: 'X-1', meta: { ghosts: { total: 2, ok: 1, done: 0, conflict: 1, conflicts: [{ x: 1, y: 2, z: 3, actual: 'stone' }] } }, png: 'AAAA' }; } });
  const r = await VT.expandActionResult({ text: 'preview of hut', view: { ghosts: [{ x: 1, y: 2, z: 3, block: 'oak_planks' }] } });
  ok(sent?.p === '/bots/X/view' && sent.b.agent === 'X' && sent.b.ghosts?.length === 1 && r.images?.length === 1 && /CONFLICT 1/.test(r.text), 'engine result {text, view} -> render request + image');
  ok((await VT.expandActionResult('plain')) === 'plain' && (await VT.expandActionResult({ text: 'only text' })) === 'only text', 'plain / text-only results unchanged');
}

// ------------------------------------------------------------------ 1b. offline bridge (mock engine): routes, album, share, MCP, rate limit, dashboard
function synthSurface(snap) {
  const { origin, size, cells, palette } = snap; const S = Math.max(size.x, size.z);
  const top = new Uint16Array(size.x * size.z), height = new Int16Array(size.x * size.z).fill(-32768);
  for (let z = 0; z < size.z; z++) for (let x = 0; x < size.x; x++) for (let y = size.y - 1; y >= 0; y--) {
    const p = cells[(y * size.z + z) * size.x + x];
    if (p && !/short_grass|poppy/.test(palette[p])) { top[z * size.x + x] = p; height[z * size.x + x] = origin.y + y; break; }
  }
  return { v: 1, kind: 'surface', origin: { x: origin.x, z: origin.z }, size: { x: size.x, z: size.z }, palette, top, height, bot: snap.bot, center: snap.center, entities: [], ms: 0, S };
}
async function offlineBridge() {
  console.log('== offline bridge (mock engine + synthetic world)');
  const mock = await import('./hub-mock-engine.mjs');
  const engine = {
    ACTIONS: mock.ACTIONS,
    async spawnBot(o) {
      const h = await mock.spawnBot(o);
      const orig = h.run.bind(h);
      h.run = (a, args = {}, opt) => {
        if (a !== '_snapshot') return orig(a, args, opt);
        const s = synthSnapshot();
        s.bot = { ...s.bot, name: o.name };
        return Promise.resolve(args.surface ? synthSurface(s) : s);
      };
      return h;
    },
  };
  const { createApp } = await import('../bridge/hub/app.js');
  const PORT = 47962;
  const dataDir = path.join(ROOT, 'data', 'viewer-offline');
  fs.rmSync(path.join(dataDir, 'photos'), { recursive: true, force: true });
  fs.mkdirSync(dataDir, { recursive: true });
  const app = createApp({ engine, dataDir, port: PORT, mc: { rconPort: 1 }, econOpts: NO_RCON });
  await app.start();
  const U = `http://127.0.0.1:${PORT}`;
  const http = async (method, p, body, t = 90000) => {
    const r = await fetch(U + p, { method, headers: body ? { 'content-type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(t) });
    return { status: r.status, j: await r.json().catch(() => null) };
  };
  let mcp = null;
  try {
    for (const n of ['Ash', 'Flint']) ok((await http('POST', '/bots', { name: n })).status === 200, `mock spawn ${n}`);
    await http('POST', '/waypoints', { by: 'Ash', name: 'base', x: 409, y: 65, z: 410 });
    for (const [name, body] of [['view-orbit', { camera: { mode: 'orbit' }, toggles: { waypoints: true, highlight: true } }], ['view-map', { camera: { mode: 'map' }, toggles: { grid: true } }]]) {
      const r = await http('POST', '/bots/Ash/view', body);
      const png = r.j?.png ? Buffer.from(r.j.png, 'base64') : null;
      if (png) fs.writeFileSync(path.join(OUT, `bridge-${name}.png`), png);
      ok(r.status === 200 && isPng(png) && r.j.id?.startsWith('Ash-'), `POST /bots/Ash/view ${name} -> photo ${r.j?.id}${r.status !== 200 ? ' ' + JSON.stringify(r.j) : ''}`);
    }
    const g = await http('POST', '/bots/Ash/view', { ghosts: [{ x: 407, y: 65, z: 409, block: 'stone' }, { x: 414, y: 66, z: 420, block: 'oak_planks' }], caption: 'ghost test' });
    ok(g.status === 200 && g.j.meta.ghosts.conflict === 1 && g.j.meta.ghosts.ok === 1, `ghosts via route: ${JSON.stringify({ ok: g.j?.meta?.ghosts?.ok, conflict: g.j?.meta?.ghosts?.conflict })}`);
    const tm = await http('POST', '/team_map', { radius: 32 });
    const tp = tm.j?.png ? Buffer.from(tm.j.png, 'base64') : null;
    if (tp) fs.writeFileSync(path.join(OUT, 'bridge-team_map.png'), tp);
    ok(tm.status === 200 && isPng(tp), `POST /team_map ${tp?.length} B`);
    const sn = await http('GET', '/bots/Ash/snapshot?radius=16');
    ok(sn.status === 200 && typeof sn.j.snap.cells === 'string' && sn.j.baked.length === sn.j.snap.palette.length, 'GET /bots/Ash/snapshot (dashboard data)');
    const photos = (await http('GET', '/photos?agent=Ash')).j;
    ok(Array.isArray(photos) && photos.length === 3, `album lists ${photos?.length} Ash photos`);
    const raw = await fetch(`${U}/photos/${photos[0].id}.png`);
    ok(raw.ok && raw.headers.get('content-type') === 'image/png', 'GET /photos/:id.png serves the image');
    ok((await fetch(`${U}/viewer/atlas.png`)).ok && (await fetch(`${U}/viewer/three/three.module.js`)).ok && (await fetch(`${U}/viewer/three/controls/OrbitControls.js`)).ok, 'viewer static files (atlas, three, OrbitControls) are served');
    ok((await fetch(`${U}/viewer/../hub/app.js`)).status !== 200, 'viewer static path traversal refused');
    const sh = await http('POST', '/photos/share', { from: 'Ash', to: 'Flint', note: 'our base' });
    ok(sh.status === 200 && (await http('GET', '/photos/inbox/Flint?peek=1')).j.pending === 1, 'share queues the photo for Flint');
    const chat = (await http('GET', '/messages')).j.messages;
    ok(chat.some((m) => m.from === 'Ash' && /shared photo/.test(m.text)), 'share also posts a chat message');

    mcp = new Client({ name: 'viewer-check', version: '0' });
    await mcp.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(ROOT, 'mcp', 'mc-mcp.js')], env: { ...process.env, HIVE_BOT: 'Flint', HIVE_URL: U }, stderr: 'inherit' }));
    const tools = (await mcp.listTools()).tools.map((t) => t.name);
    ok(['view', 'team_map', 'photo_share', 'photo_view'].every((n) => tools.includes(n)) && !tools.includes('_snapshot'), `MCP lists view/team_map/photo_share/photo_view (${tools.length} tools)`);
    const r1 = await mcp.callTool({ name: 'goal', arguments: {} });
    const img1 = r1.content.find((c) => c.type === 'image');
    ok(img1 && isPng(Buffer.from(img1.data, 'base64')) && /shared photo/.test(r1.content[0].text), 'MCP: shared photo arrives as image content with the next tool result');
    const r2 = await mcp.callTool({ name: 'goal', arguments: {} });
    ok(!r2.content.some((c) => c.type === 'image'), 'MCP: a shared photo is delivered only once');
    const v = await mcp.callTool({ name: 'view', arguments: { mode: 'orbit', x: 409, y: 65, z: 410, from: 'south', distance: 10, highlight: true } });
    const vi = v.content.find((c) => c.type === 'image');
    if (vi) fs.writeFileSync(path.join(OUT, 'bridge-mcp-view.png'), Buffer.from(vi.data, 'base64'));
    ok(!v.isError && vi?.mimeType === 'image/png' && isPng(Buffer.from(vi.data, 'base64')) && /photo Flint-/.test(v.content[0].text), `MCP view -> text + image content: "${v.content[0].text.split('\n')[0]}"`);
    const pv = await mcp.callTool({ name: 'photo_view', arguments: { id: photos[0].id } });
    ok(pv.content.some((c) => c.type === 'image'), 'MCP photo_view returns the image');
    const pl = await mcp.callTool({ name: 'photo_view', arguments: {} });
    ok(/Ash-\d+/.test(pl.content[0].text), 'MCP photo_view without id lists photos');
    const tmm = await mcp.callTool({ name: 'team_map', arguments: { radius: 32 } });
    ok(tmm.content.some((c) => c.type === 'image'), 'MCP team_map returns an image');
    let limited = null;
    for (let i = 0; i < 26 && limited == null; i++) {
      const r = await mcp.callTool({ name: 'view', arguments: { mode: 'map' } });
      if (r.isError && /render limit/.test(r.content[0].text)) limited = i;
    }
    ok(limited === 18, `rate limit: 20 renders/min per agent (view + team_map used 2, blocked on the 19th more): ${limited}`);

    // dashboard in a headless browser: 3D view, snap, album
    const { default: puppeteer } = await import('puppeteer-core');
    const { findChrome } = await import('../bridge/viewer/render.js');
    const br = await puppeteer.launch({ executablePath: findChrome(), headless: true, args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--ignore-gpu-blocklist'], defaultViewport: { width: 1600, height: 900 } });
    try {
      const pg = await br.newPage();
      const errs = [];
      pg.on('pageerror', (e) => errs.push(e.message));
      pg.on('console', (m) => { if (m.type() === 'error' && !/favicon|404/.test(m.text())) errs.push(m.text()); });
      await pg.goto(U + '/', { waitUntil: 'networkidle2' });
      await pg.waitForFunction(() => document.querySelector('#v3bot')?.options.length > 0, { timeout: 15000 });
      await pg.click('.vtab[data-vtab="view3d"]');
      await pg.waitForFunction(() => document.querySelector('#v3msg').textContent === '', { timeout: 30000 });
      await sleep(1200);
      await pg.screenshot({ path: path.join(OUT, 'dashboard-3d.png') });
      const box = await (await pg.$('#v3wrap')).boundingBox();
      await pg.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await pg.mouse.down(); await pg.mouse.move(box.x + box.width / 2 + 160, box.y + box.height / 2 + 40, { steps: 8 }); await pg.mouse.up();
      await sleep(800);
      await pg.screenshot({ path: path.join(OUT, 'dashboard-3d-orbited.png') });
      await pg.click('#v3snap');
      await pg.waitForFunction(() => /saved|✗/.test(document.querySelector('#v3snap').textContent), { timeout: 30000 });
      ok(/saved/.test(await pg.$eval('#v3snap', (b) => b.textContent)), 'dashboard 📷 Snap saves a photo');
      await pg.click('.vtab[data-vtab="album"]');
      await pg.waitForFunction(() => document.querySelectorAll('.albcard img').length > 3 && [...document.querySelectorAll('.albcard img')].slice(0, 3).every((i) => i.complete && i.naturalWidth > 0), { timeout: 15000 });
      await pg.click('.albcard');
      await sleep(300);
      await pg.screenshot({ path: path.join(OUT, 'dashboard-album-lightbox.png') });
      await pg.keyboard.press('Escape');
      await pg.screenshot({ path: path.join(OUT, 'dashboard-album.png') });
      const caps = await pg.$$eval('.albcard .cap b', (l) => l.map((b) => b.textContent));
      ok(caps.length >= 6 && caps.includes('Robin'), `dashboard album shows ${caps.length} photos incl. Robin's snap`);
      await pg.click('.vtab[data-vtab="map"]');
      await sleep(500);
      await pg.screenshot({ path: path.join(OUT, 'dashboard-map.png') });
      ok(!errs.length, `dashboard: no page errors${errs.length ? ': ' + errs.slice(0, 3).join(' | ') : ''}`);
    } finally { await br.close(); }
  } finally {
    try { await mcp?.close(); } catch { /* */ }
    await app.close();
  }
}
try { await offlineBridge(); } catch (e) { ok(false, `offline bridge: ${e.stack || e}`); }

// ------------------------------------------------------------------ 2. live
async function live() {
  const { rcon } = await import('../bridge/hub/rcon.js');
  let list;
  try { list = await rcon('list'); } catch (e) { console.log(`== live skipped: RCON not reachable (${e.message})`); return; }
  // teammates' scripted test bots are not humans (HIVE_TEST_BOTS overrides the list)
  const testBots = new Set((process.env.HIVE_TEST_BOTS || 'RobCheck,BpTest,Viewer1,Viewer2').split(',').map((s) => s.trim().toLowerCase()));
  const humans = (list.split(':')[1] || '').split(',').map((s) => s.trim()).filter((n) => n && !testBots.has(n.toLowerCase()));
  if (humans.length && !argv.has('--force')) { console.log(`== live skipped: players online (${humans.join(', ')}); use --force`); return; }
  console.log('== live (scripted bots at x~420 z~420)');
  const engine = await import('../bridge/engine/threaded.js');
  const { createApp } = await import('../bridge/hub/app.js');
  const PORT = 47961;
  const dataDir = path.join(ROOT, 'data', 'viewer-live');
  fs.mkdirSync(dataDir, { recursive: true });
  const app = createApp({ engine, dataDir, port: PORT, econOpts: { enabled: false } }); // opt-in live run: no economy/earnings
  await app.start();
  const U = `http://127.0.0.1:${PORT}`;
  const http = async (method, p, body, t = 90000) => {
    const r = await fetch(U + p, { method, headers: body ? { 'content-type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(t) });
    const j = await r.json().catch(() => null);
    return { status: r.status, j };
  };
  const BX = 420, BZ = 420;
  const placed = [];
  let mcp = null;
  try {
    for (const n of ['Viewer1', 'Viewer2']) { const r = await http('POST', '/bots', { name: n }); ok(r.status === 200, `spawn ${n}`); }
    // creative (no fall damage / mobs), then drop in from above at x~420 z~420 and wait until both bots really are there
    await rcon('gamemode creative Viewer1'); await rcon('gamemode creative Viewer2');
    await rcon(`forceload add ${BX - 32} ${BZ - 32} ${BX + 32} ${BZ + 32}`);
    console.log('   ', await rcon(`tp Viewer1 ${BX} 140 ${BZ}`), '|', await rcon(`tp Viewer2 ${BX + 3} 140 ${BZ + 3}`));
    let st = null, lastY = -999;
    for (let i = 0; i < 40; i++) {
      await sleep(1000);
      st = (await http('GET', '/bots/Viewer1/state')).j;
      const st2 = (await http('GET', '/bots/Viewer2/state')).j;
      const near = (s, x, z) => s?.pos && Math.abs(s.pos.x - x) < 4 && Math.abs(s.pos.z - z) < 4;
      const landed = st?.pos && Math.abs(st.pos.y - lastY) < 0.01 && st.pos.y < 139;
      if (near(st, BX, BZ) && near(st2, BX + 3, BZ + 3) && i > 3 && landed) break;
      if (st?.pos) lastY = st.pos.y;
    }
    if (!st?.pos || Math.abs(st.pos.x - BX) > 4 || Math.abs(st.pos.z - BZ) > 4) throw new Error(`Viewer1 is not at the test site (pos ${JSON.stringify(st?.pos)}) - refusing to build anything`);
    const p = { x: Math.floor(st.pos.x), y: Math.floor(st.pos.y), z: Math.floor(st.pos.z) };
    console.log('   Viewer1 at', p);
    // tiny test build next to the bot (removed at the end): stairs, slab, chest, glass, torch, door
    const put = async (x, y, z, b) => { await rcon(`setblock ${x} ${y} ${z} ${b}`); placed.push([x, y, z]); };
    await put(p.x + 3, p.y, p.z - 2, 'minecraft:oak_stairs[facing=west]');
    await put(p.x + 4, p.y, p.z - 2, 'minecraft:oak_planks');
    await put(p.x + 4, p.y + 1, p.z - 2, 'minecraft:oak_slab[type=bottom]');
    await put(p.x + 2, p.y, p.z - 4, 'minecraft:chest[facing=south]');
    await put(p.x + 5, p.y, p.z - 4, 'minecraft:glass');
    await put(p.x + 5, p.y + 1, p.z - 4, 'minecraft:torch');
    await rcon(`summon minecraft:zombie ${p.x - 3} ${p.y} ${p.z - 4} {NoAI:1b,PersistenceRequired:1b,Tags:["hcview"],DeathLootTable:"minecraft:empty"}`);
    await rcon(`summon minecraft:cow ${p.x - 4} ${p.y} ${p.z + 2} {NoAI:1b,Tags:["hcview"],DeathLootTable:"minecraft:empty"}`);
    await rcon(`tp Viewer1 ${p.x} ${p.y} ${p.z} -135 15`); // face north-east toward the build
    await sleep(1500);

    // snapshot (dashboard route) — speed and content
    const t0 = Date.now();
    const sn = await http('GET', '/bots/Viewer1/snapshot?radius=32');
    ok(sn.status === 200 && sn.j.snap.palette.length > 5, `snapshot r32: ${sn.j?.snap?.size?.x}x${sn.j?.snap?.size?.y}x${sn.j?.snap?.size?.z}, palette ${sn.j?.snap?.palette?.length}, worker ${sn.j?.snap?.ms} ms, round trip ${Date.now() - t0} ms, lightOk ${sn.j?.snap?.lightOk}`);
    ok(sn.j?.snap?.entities?.some((e) => e.name === 'zombie' && e.kind === 'hostile') && sn.j?.snap?.entities?.some((e) => e.name === 'Viewer2' && e.kind === 'player'), `snapshot sees the zombie and teammate Viewer2 (${(sn.j?.snap?.entities || []).map((e) => e.kind + ':' + e.name).join(', ')})`);
    ok(sn.j?.snap?.chests?.some((c) => c.name === 'chest'), 'snapshot lists the chest');

    await http('POST', '/waypoints', { by: 'Viewer1', name: 'test_base', x: p.x + 4, y: p.y, z: p.z - 2 });
    const views = [
      ['first_person', { camera: { mode: 'first_person' } }],
      ['orbit', { camera: { mode: 'orbit', from: 'southwest' } }],
      ['orbit-build-closeup', { camera: { mode: 'orbit', target: { x: p.x + 3.5, y: p.y + 0.5, z: p.z - 3 }, from: 'south', distance: 7, elevation: 30 } }],
      ['map-grid', { camera: { mode: 'map' }, toggles: { grid: true } }],
      ['slice', { camera: { mode: 'slice', y: p.y - 4 }, radius: 20 }],
      ['free', { camera: { mode: 'free', pos: { x: p.x + 12, y: p.y + 10, z: p.z + 12 }, look_at: { x: p.x, y: p.y, z: p.z } } }],
      ['xray-highlight', { camera: { mode: 'orbit', from: 'south', elevation: 30 }, toggles: { xray: true, highlight: true }, center: { x: p.x, y: p.y - 12, z: p.z }, radius: 20, down: 24 }],
      ['night-vision', { camera: { mode: 'orbit' }, toggles: { night_vision: true, highlight: true } }],
      ['waypoints', { camera: { mode: 'orbit', distance: 28 }, toggles: { waypoints: true, grid: true } }],
    ];
    for (const [name, body] of views) {
      const r = await http('POST', '/bots/Viewer1/view', { ...body, caption: `test ${name}` });
      const png = r.j?.png ? Buffer.from(r.j.png, 'base64') : null;
      if (png) fs.writeFileSync(path.join(OUT, `live-${name}.png`), png);
      ok(r.status === 200 && isPng(png) && r.j.id, `live ${name}: ${png?.length} B, ${r.j?.meta?.faces} faces, snapshot ${r.j?.meta?.ms?.snapshot} ms + render ${r.j?.meta?.ms?.render} ms, photo ${r.j?.id}${r.status !== 200 ? ' ' + JSON.stringify(r.j) : ''}`);
    }
    // ghost layer: a 5x4x5 hut shell right where the test build is (some blocks conflict / are already there)
    const ghosts = [];
    for (let y = 0; y < 4; y++) for (let dz = 0; dz < 5; dz++) for (let dx = 0; dx < 5; dx++) {
      const wall = dx === 0 || dx === 4 || dz === 0 || dz === 4;
      if (!wall && y < 3) continue;
      if (y === 3) { ghosts.push({ x: p.x + 1 + dx, y: p.y + y, z: p.z - 6 + dz, block: 'oak_slab', props: { type: 'bottom' } }); continue; }
      if (dz === 4 && dx === 2 && y < 2) continue;
      ghosts.push({ x: p.x + 1 + dx, y: p.y + y, z: p.z - 6 + dz, block: y === 1 && dx === 2 ? 'glass' : 'cobblestone' });
    }
    ghosts.push({ x: p.x + 4, y: p.y, z: p.z - 2, block: 'oak_planks' }); // already placed -> done
    const g = await http('POST', '/bots/Viewer1/view', { ghosts, caption: 'ghost hut' });
    const gp = g.j?.png ? Buffer.from(g.j.png, 'base64') : null;
    if (gp) fs.writeFileSync(path.join(OUT, 'live-ghosts.png'), gp);
    ok(g.status === 200 && isPng(gp) && g.j.meta.ghosts.total === ghosts.length, `ghosts: ${JSON.stringify({ ...g.j?.meta?.ghosts, conflicts: g.j?.meta?.ghosts?.conflicts?.slice(0, 3) })}`);
    ok(g.j?.meta?.ghosts?.done >= 1 && g.j?.meta?.ghosts?.conflict >= 1, 'ghosts: at least one done (planks) and one conflict (chest/stairs in the way)');

    // team map
    const tm = await http('POST', '/team_map', { radius: 64 });
    const tp = tm.j?.png ? Buffer.from(tm.j.png, 'base64') : null;
    if (tp) fs.writeFileSync(path.join(OUT, 'live-team_map.png'), tp);
    ok(tm.status === 200 && isPng(tp), `team_map: ${tp?.length} B bounds ${JSON.stringify(tm.j?.meta?.bounds)}`);

    // album + share + inbox
    const photos = (await http('GET', '/photos?agent=Viewer1&limit=50')).j;
    ok(Array.isArray(photos) && photos.length >= views.length, `album lists ${photos?.length} Viewer1 photos`);
    const raw = await fetch(`${U}/photos/${photos[0].id}.png`);
    ok(raw.ok && raw.headers.get('content-type') === 'image/png', `GET /photos/${photos[0].id}.png`);
    const sh = await http('POST', '/photos/share', { from: 'Viewer1', to: 'Viewer2', note: 'look at this' });
    ok(sh.status === 200 && sh.j.to[0] === 'Viewer2', `share -> ${JSON.stringify(sh.j)}`);
    const peek = (await http('GET', '/photos/inbox/Viewer2?peek=1')).j;
    ok(peek.pending === 1, 'Viewer2 inbox has 1 pending photo');

    // MCP level: real MCP client -> mc-mcp.js as Viewer2: the shared photo arrives as image content on the next call
    mcp = new Client({ name: 'viewer-check', version: '0' });
    await mcp.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(ROOT, 'mcp', 'mc-mcp.js')], env: { ...process.env, HIVE_BOT: 'Viewer2', HIVE_URL: U }, stderr: 'inherit' }));
    const tools = (await mcp.listTools()).tools.map((t) => t.name);
    ok(['view', 'team_map', 'photo_share', 'photo_view', 'survey'].every((n) => tools.includes(n)) && !tools.includes('_snapshot'), `MCP tools include view/team_map/photo_share/photo_view/survey, not _snapshot (${tools.length} tools)`);
    const r1 = await mcp.callTool({ name: 'goal', arguments: {} });
    const img1 = r1.content.find((c) => c.type === 'image');
    ok(img1 && isPng(Buffer.from(img1.data, 'base64')) && /shared photo/.test(r1.content[0].text), 'shared photo delivered as image content with the next tool result');
    const v = await mcp.callTool({ name: 'view', arguments: { mode: 'orbit', from: 'east', highlight: true } });
    const vi = v.content.find((c) => c.type === 'image');
    if (vi) fs.writeFileSync(path.join(OUT, 'live-mcp-view.png'), Buffer.from(vi.data, 'base64'));
    ok(!v.isError && vi && vi.mimeType === 'image/png' && isPng(Buffer.from(vi.data, 'base64')), `MCP view returns image content + caption: "${v.content[0].text.split('\n')[0]}"`);
    const pv = await mcp.callTool({ name: 'photo_view', arguments: { id: photos[0].id } });
    ok(pv.content.some((c) => c.type === 'image'), 'MCP photo_view returns the image');
    const sv = await mcp.callTool({ name: 'survey', arguments: { radius: 8 } });
    ok(!sv.isError && /TOP BLOCKS/.test(sv.content[0].text), 'MCP survey returns the text map');
    console.log(sv.content[0].text.split('\n').slice(0, 22).join('\n'));
    // rate limit: Viewer2 has used 1 render via MCP; burn the rest of its minute
    let limited = null;
    for (let i = 0; i < 26 && !limited; i++) {
      const r = await mcp.callTool({ name: 'view', arguments: { mode: 'map', radius: 8 } });
      if (r.isError && /render limit/.test(r.content[0].text)) limited = { i, text: r.content[0].text.split('\n')[0] };
    }
    ok(limited && limited.i === 19, `rate limit kicks in after 20 renders/min: ${JSON.stringify(limited)}`);

    // dashboard: 3D view tab + album tab in a real (headless) browser
    const { default: puppeteer } = await import('puppeteer-core');
    const { findChrome } = await import('../bridge/viewer/render.js');
    const br = await puppeteer.launch({ executablePath: findChrome(), headless: true, args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--ignore-gpu-blocklist'], defaultViewport: { width: 1600, height: 900 } });
    try {
      const pg = await br.newPage();
      const errs = [];
      pg.on('pageerror', (e) => errs.push(e.message));
      pg.on('console', (m) => { if (m.type() === 'error' && !/favicon|404/.test(m.text())) errs.push(m.text()); });
      await pg.goto(U + '/', { waitUntil: 'networkidle2' });
      await pg.waitForFunction(() => document.querySelector('#v3bot')?.options.length > 0, { timeout: 15000 });
      await pg.click('.vtab[data-vtab="view3d"]');
      await pg.waitForFunction(() => document.querySelector('#v3msg').textContent === '', { timeout: 30000 });
      await sleep(1500);
      await pg.screenshot({ path: path.join(OUT, 'live-dashboard-3d.png') });
      // orbit the camera with a mouse drag, then snap from the dashboard
      const box = await (await pg.$('#v3wrap')).boundingBox();
      await pg.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await pg.mouse.down(); await pg.mouse.move(box.x + box.width / 2 + 160, box.y + box.height / 2 + 40, { steps: 8 }); await pg.mouse.up();
      await sleep(800);
      await pg.screenshot({ path: path.join(OUT, 'live-dashboard-3d-orbited.png') });
      await pg.click('#v3snap');
      await pg.waitForFunction(() => /saved|✗/.test(document.querySelector('#v3snap').textContent), { timeout: 30000 });
      const snapTxt = await pg.$eval('#v3snap', (b) => b.textContent);
      ok(/saved/.test(snapTxt), `dashboard Snap saves a photo (${snapTxt})`);
      await pg.click('.vtab[data-vtab="album"]');
      await pg.waitForFunction(() => document.querySelectorAll('.albcard img').length > 3 && [...document.querySelectorAll('.albcard img')].slice(0, 3).every((i) => i.complete && i.naturalWidth > 0), { timeout: 15000 });
      await pg.screenshot({ path: path.join(OUT, 'live-dashboard-album.png') });
      const cards = await pg.$$eval('.albcard', (l) => l.length);
      const robin = await pg.$$eval('.albcard .cap b', (l) => l.some((b) => b.textContent === 'Robin'));
      ok(cards >= 10 && robin, `dashboard album shows ${cards} photos incl. Robin's snap`);
      await pg.click('.vtab[data-vtab="map"]');
      await sleep(500);
      await pg.screenshot({ path: path.join(OUT, 'live-dashboard-map.png') });
      ok(!errs.length, `dashboard has no page errors${errs.length ? ': ' + errs.slice(0, 3).join(' | ') : ''}`);
    } finally { await br.close(); }
  } finally {
    try { await mcp?.close(); } catch { /* */ }
    for (const [x, y, z] of placed.reverse()) { try { await rcon(`setblock ${x} ${y} ${z} minecraft:air`); } catch { /* */ } }
    try { await rcon('kill @e[tag=hcview]'); await rcon(`kill @e[type=item,x=${BX},y=64,z=${BZ},distance=..48]`); await rcon(`forceload remove ${BX - 32} ${BZ - 32} ${BX + 32} ${BZ + 32}`); } catch { /* */ }
    await app.close();
  }
}

if (argv.has('--live')) { // live server tests are OFF by default (no live tests without asking)
  try { await live(); } catch (e) { ok(false, `live: ${e.stack || e}`); }
}
await closeViewer();
console.log(`\n${pass} passed, ${fail} failed. PNGs in ${OUT}`);
process.exit(fail ? 1 : 0);
