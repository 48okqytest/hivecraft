// Dashboard: live orbit-able 3D view per bot (same mesher/scene as the agents' renderer) + photo album.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { buildScene } from '/viewer/scene.js';

THREE.ColorManagement.enabled = false;
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ---------------------------------------------------------------- tabs
let active = 'map';
document.querySelectorAll('.vtab').forEach((b) => (b.onclick = () => {
  active = b.dataset.vtab;
  document.querySelectorAll('.vtab').forEach((x) => x.classList.toggle('on', x === b));
  $('#mapWrap').hidden = active !== 'map';
  $('#view3d').hidden = active !== 'view3d';
  $('#album').hidden = active !== 'album';
  $('#mapHint').hidden = active !== 'map'; $('#mapCoord').hidden = active !== 'map';
  if (active === 'view3d') { resize3d(); if (!built && $('#v3bot').value) load3d(); kick(); }
  if (active === 'album') { $('#albumCount').textContent = ''; seen = Date.now(); loadAlbum(); }
}));

// ---------------------------------------------------------------- live data (own SSE: bots + photos)
let bots = [];
function connect() {
  const es = new EventSource('/events');
  es.addEventListener('init', (e) => { try { setBots(JSON.parse(e.data).bots || []); } catch { /* */ } });
  es.addEventListener('bots', (e) => { try { setBots(JSON.parse(e.data)); } catch { /* */ } });
  es.addEventListener('photo', (e) => { try { onPhoto(JSON.parse(e.data)); } catch { /* */ } });
  es.onerror = () => { es.close(); setTimeout(connect, 3000); };
}
function setBots(list) {
  if (!Array.isArray(list)) return;
  bots = list;
  const sel = $('#v3bot');
  const names = list.map((b) => b.name);
  const cur = sel.value;
  if (names.join() !== [...sel.options].map((o) => o.value).join()) {
    sel.innerHTML = names.map((n) => `<option value="${esc(n)}">${esc(n)}</option>`).join('');
    if (names.includes(cur)) sel.value = cur;
  }
  if (!sel.value && names.length) sel.value = names[0];
}

// ---------------------------------------------------------------- 3D view
const glc = $('#v3gl'), ovc = $('#v3ov'), msg = $('#v3msg');
let renderer = null, atlas = null, built = null, scene = null, camera = null, controls = null, loadedBot = null, busy = false;
function ensureGL() {
  if (renderer) return;
  renderer = new THREE.WebGLRenderer({ canvas: glc, antialias: true });
  renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
  camera = new THREE.PerspectiveCamera(70, 1.6, 0.05, 800);
  controls = new OrbitControls(camera, glc);
  controls.enableDamping = true; controls.dampingFactor = 0.12;
  controls.addEventListener('change', kick);
  new ResizeObserver(resize3d).observe($('#v3wrap'));
}
function resize3d() {
  if (!renderer) return;
  const r = $('#v3wrap').getBoundingClientRect();
  if (!r.width || !r.height) return;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  renderer.setPixelRatio(dpr); renderer.setSize(r.width, r.height, false);
  ovc.width = Math.round(r.width * dpr); ovc.height = Math.round(r.height * dpr);
  camera.aspect = r.width / r.height; camera.updateProjectionMatrix();
  kick();
}
async function getAtlas() {
  if (atlas) return atlas;
  const t = await new THREE.TextureLoader().loadAsync('/viewer/atlas.png');
  t.magFilter = THREE.NearestFilter; t.minFilter = THREE.NearestFilter; t.generateMipmaps = false; t.colorSpace = THREE.NoColorSpace;
  atlas = t; return t;
}
const toggles = () => Object.fromEntries([...document.querySelectorAll('#view3d input[data-t]')].map((i) => [i.dataset.t, i.checked]));
function disposeScene(s) {
  s?.traverse((o) => { o.geometry?.dispose?.(); if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => m.dispose()); });
}
async function load3d() {
  const name = $('#v3bot').value;
  if (!name || busy) return;
  busy = true;
  ensureGL();
  msg.textContent = built ? '' : `loading ${name}…`;
  try {
    const radius = $('#v3radius').value;
    const res = await fetch(`/bots/${encodeURIComponent(name)}/snapshot?radius=${radius}&up=24&down=16`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    const tex = await getAtlas();
    const r = $('#v3wrap').getBoundingClientRect();
    const b = buildScene(THREE, { ...data, camera: { mode: 'orbit' }, toggles: toggles(), width: r.width || 800, height: r.height || 500, title: false }, tex);
    disposeScene(scene);
    scene = b.scene; built = b;
    if (loadedBot !== name) { // new bot: take the scene's default orbit pose
      camera.position.copy(b.camera.position);
      controls.target.set(b.focus.x, b.focus.y, b.focus.z);
      loadedBot = name;
    }
    controls.update();
    msg.textContent = '';
    resize3d();
  } catch (e) {
    msg.textContent = `${name}: ${e.message}`;
  } finally { busy = false; }
}
let raf = 0, frames = 0;
function kick() { frames = 30; if (!raf) raf = requestAnimationFrame(loop); }
function loop() {
  raf = 0;
  if (active !== 'view3d' || !renderer || !scene) return;
  controls.update();
  renderer.render(scene, camera);
  const ctx = ovc.getContext('2d');
  const dpr = ovc.width / Math.max(1, ovc.clientWidth);
  ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, ovc.width, ovc.height);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  built.drawOverlay(ctx, ovc.clientWidth, ovc.clientHeight, camera);
  if (--frames > 0) raf = requestAnimationFrame(loop);
}
$('#v3bot').onchange = () => { loadedBot = null; load3d(); };
$('#v3radius').onchange = load3d;
$('#v3reload').onclick = load3d;
document.querySelectorAll('#view3d input[data-t]').forEach((i) => (i.onchange = load3d));
setInterval(() => { if (active === 'view3d' && $('#v3auto').checked) load3d(); }, 10000);
$('#v3snap').onclick = async () => {
  const name = $('#v3bot').value; if (!name || !camera) return;
  const btn = $('#v3snap'); btn.disabled = true; btn.textContent = '…';
  try {
    const p = camera.position, t = controls.target;
    const r = await fetch(`/bots/${encodeURIComponent(name)}/view`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ camera: { mode: 'free', pos: { x: p.x, y: p.y, z: p.z }, look_at: { x: t.x, y: t.y, z: t.z } }, center: { x: t.x, y: t.y, z: t.z }, radius: Number($('#v3radius').value), toggles: toggles(), owner: window.HIVE_PLAYER || 'Player', caption: `dashboard snap of ${name}'s area` }),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || r.status);
    btn.textContent = '✓ saved';
  } catch (e) { btn.textContent = '✗ ' + e.message.slice(0, 30); }
  setTimeout(() => { btn.disabled = false; btn.textContent = '📷 Snap'; }, 1800);
};

// ---------------------------------------------------------------- album
let photos = [], seen = Date.now(), unseen = 0;
async function loadAlbum() {
  const agent = $('#albAgent').value;
  try {
    const r = await fetch(`/photos?limit=150${agent ? `&agent=${encodeURIComponent(agent)}` : ''}`);
    photos = await r.json();
    if (!agent) {
      const agents = [...new Set(photos.map((p) => p.agent))].sort();
      const sel = $('#albAgent'); const cur = sel.value;
      sel.innerHTML = '<option value="">all agents</option>' + agents.map((a) => `<option>${esc(a)}</option>`).join('');
      sel.value = cur;
    }
    renderAlbum();
  } catch { /* bridge down */ }
}
function card(p, isNew) {
  const d = document.createElement('div');
  d.className = 'albcard' + (isNew ? ' new' : '');
  d.innerHTML = `<img loading="lazy" src="/photos/${esc(p.id)}.png" alt=""><div class="cap"><b>${esc(p.agent)}</b>${esc(new Date(p.ts).toLocaleTimeString())} · ${esc(p.caption || p.mode || '')}</div>`;
  d.onclick = () => { $('#lbImg').src = `/photos/${p.id}.png`; $('#lbCap').textContent = `${p.agent} · ${new Date(p.ts).toLocaleString()} · ${p.caption || p.mode || ''} · ${p.id}`; $('#lightbox').hidden = false; };
  return d;
}
function renderAlbum() {
  const g = $('#albGrid'); g.innerHTML = '';
  if (!photos.length) { g.innerHTML = '<div class="dim" style="padding:10px">No photos yet. They appear here as soon as an agent uses view or team_map.</div>'; return; }
  for (const p of photos) g.appendChild(card(p, p.ts > seen - 15000 && active === 'album'));
}
function onPhoto(p) {
  const agent = $('#albAgent').value;
  if (agent && agent !== p.agent) return;
  photos.unshift(p);
  if (active === 'album') { const g = $('#albGrid'); if (g.firstChild?.classList?.contains('albcard')) g.insertBefore(card(p, true), g.firstChild); else renderAlbum(); }
  else { unseen++; $('#albumCount').textContent = unseen; }
}
$('#albAgent').onchange = loadAlbum;
$('#lightbox').onclick = () => { $('#lightbox').hidden = true; };
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') $('#lightbox').hidden = true; });
document.querySelector('.vtab[data-vtab="album"]').addEventListener('click', () => { unseen = 0; });

connect();
loadAlbum();
