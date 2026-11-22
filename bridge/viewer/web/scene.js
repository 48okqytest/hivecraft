// Scene builder shared by the headless renderer (render.html) and the dashboard live view.
// payload = { snap, baked, ghosts, ghostBaked, liquidUV, tints, camera, toggles, waypoints, team, width, height, title }
import { buildWorld, decodeSnapshot } from './mesher.js';

const D2R = Math.PI / 180;
export const KIND_COL = { player: '#4fc3ff', teammate: '#ffd54a', hostile: '#ff4a4a', animal: '#9cff7a', item: '#e0c070', other: '#c0c0c0', chest: '#ffb347', waypoint: '#ff7ae0' };
const MOB_COL = { zombie: 0x3f7a3a, husk: 0x8a7a50, drowned: 0x3a7a7a, skeleton: 0xcfcfcf, stray: 0xa8c0c8, creeper: 0x4fd24f, spider: 0x3a3030, cave_spider: 0x1f4040, enderman: 0x161616, witch: 0x553366, slime: 0x7acc6a, cow: 0x5a4030, pig: 0xf0a0a0, sheep: 0xf0f0f0, chicken: 0xffffff, horse: 0x8a5a30, villager: 0x9a7050, wolf: 0xd8d8d8, cat: 0xe0a050, rabbit: 0xa08060, fox: 0xe07030, squid: 0x304a70, bat: 0x403020 };

// Minecraft F3 yaw (0 = south/+z, 90 = west, 180 = north, -90 = east) and pitch (+ = down) -> direction
export function mcDir(yawDeg, pitchDeg) {
  const y = yawDeg * D2R, p = pitchDeg * D2R;
  return { x: -Math.sin(y) * Math.cos(p), y: -Math.sin(p), z: Math.cos(y) * Math.cos(p) };
}
// mineflayer radians (yaw 0 = north, ccw; pitch + = up) -> MC degrees
export const mfToMc = (yaw, pitch) => ({ yaw: (yaw * 180) / Math.PI + 180, pitch: -(pitch * 180) / Math.PI });
const FROM = { south: 0, southwest: 45, west: 90, northwest: 135, north: 180, northeast: 225, east: 270, southeast: 315 };

function dayFactor(t) {
  if (t == null) return 1;
  t = ((t % 24000) + 24000) % 24000;
  if (t < 12000) return 1;
  if (t < 13800) return 1 - ((t - 12000) / 1800) * 0.75;
  if (t < 22200) return 0.25;
  return 0.25 + ((t - 22200) / 1800) * 0.75;
}

export function buildScene(THREE, payload, atlasTex) {
  const P = payload;
  const snap = decodeSnapshot(P.snap);
  const T = { labels: true, ...(P.toggles || {}) };
  const cam = { mode: 'orbit', ...(P.camera || {}) };
  const W = P.width || 1024, H = P.height || 640;
  const dayF = T.night_vision ? 1 : dayFactor(snap.time?.timeOfDay);
  const scene = new THREE.Scene();
  const sky = new THREE.Color().setRGB(0.47 * dayF + 0.02, 0.65 * dayF + 0.03, 1.0 * dayF + 0.06);
  scene.background = sky;
  const sliceY = cam.mode === 'slice' ? (cam.y ?? Math.floor(snap.bot?.pos?.y ?? snap.center.y) + 1) : (cam.slice_y ?? null);

  const { origin, size } = snap;
  const ctr = { x: origin.x + size.x / 2, y: snap.center?.y ?? origin.y + size.y / 2, z: origin.z + size.z / 2 };
  const R = Math.max(size.x, size.z) / 2;
  if (cam.mode !== 'map' && !T.xray) scene.fog = new THREE.Fog(sky, R * 1.6, R * 3.2);

  const world = buildWorld(THREE, snap, P.baked, atlasTex, { dayF, nightVision: !!T.night_vision, sliceY, xray: !!T.xray, ghosts: P.ghosts, ghostBaked: P.ghostBaked, liquidUV: P.liquidUV, tints: P.tints, fog: cam.mode !== 'map' && !T.xray });
  scene.add(world.group);

  // ---- entities
  const labels = []; // {pos:{x,y,z}, text, color, kind}
  const team = new Set(P.team || []);
  const me = snap.bot?.name;
  const box = (w, h, d, color, x, y, z, opts = {}) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), new THREE.MeshBasicMaterial({ color, fog: true, ...opts }));
    m.position.set(x, y, z); scene.add(m); return m;
  };
  const shade = (hex, k) => { const c = new THREE.Color(hex); c.multiplyScalar(k); return c; };
  const dl = T.night_vision ? 1 : Math.max(0.35, dayF);
  for (const e of snap.entities || []) {
    if (sliceY != null && e.pos.y > sliceY + 1) continue;
    const { x, y, z } = e.pos;
    if (e.kind === 'player') {
      const isTeam = team.has(e.name);
      const col = isTeam ? 0xffd54a : 0x4fc3ff;
      const g = new THREE.Group(); g.position.set(x, y, z); g.rotation.y = e.yaw || 0;
      const part = (w, h, d, c, py, px = 0) => { const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), new THREE.MeshBasicMaterial({ color: c })); m.position.set(px, py, 0); g.add(m); return m; };
      part(0.25, 0.75, 0.25, shade(0x2a3a8a, dl), 0.375, -0.125); part(0.25, 0.75, 0.25, shade(0x2a3a8a, dl * 0.85), 0.375, 0.125);
      part(0.5, 0.75, 0.25, shade(col, dl), 1.125);
      part(0.2, 0.7, 0.2, shade(0xc89a70, dl * 0.9), 1.1, -0.35); part(0.2, 0.7, 0.2, shade(0xc89a70, dl * 0.9), 1.1, 0.35);
      const head = part(0.5, 0.5, 0.5, shade(0xc89a70, dl), 1.75);
      const eye = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.08, 0.02), new THREE.MeshBasicMaterial({ color: 0x202060 })); eye.position.set(0, 0.05, -0.26); head.add(eye);
      scene.add(g);
      labels.push({ pos: { x, y: y + 2.3, z }, text: e.name, kind: isTeam ? 'teammate' : 'player' });
    } else if (e.kind === 'item') {
      box(0.25, 0.25, 0.25, shade(0xe0c070, dl), x, y + 0.15, z);
      if (T.highlight) labels.push({ pos: { x, y: y + 0.5, z }, text: e.item || 'item', kind: 'item', small: true });
    } else {
      const c = MOB_COL[e.name] ?? (e.kind === 'hostile' ? 0x7a2a2a : 0x8a8a6a);
      const w = Math.max(0.3, e.w || 0.6), h = Math.max(0.3, e.h || 1);
      box(w, h * 0.7, w * (h > 1.2 ? 0.6 : 1.4), shade(c, dl), x, y + h * 0.35, z);
      box(w * 0.8, h * 0.3, w * 0.8, shade(c, dl * 1.15), x, y + h * 0.85, z);
      if (T.labels && (e.kind === 'hostile' || T.highlight)) labels.push({ pos: { x, y: y + h + 0.35, z }, text: e.name, kind: e.kind, small: true });
    }
  }
  // the viewing bot itself (not in its own entity list)
  if (snap.bot?.pos && cam.mode !== 'first_person') {
    const { x, y, z } = snap.bot.pos;
    const g = new THREE.Group(); g.position.set(x, y, z); g.rotation.y = snap.bot.yaw || 0;
    const add = (w, h, d, c, py, px = 0) => { const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), new THREE.MeshBasicMaterial({ color: c })); m.position.set(px, py, 0); g.add(m); };
    add(0.25, 0.75, 0.25, shade(0x2a3a8a, dl), 0.375, -0.125); add(0.25, 0.75, 0.25, shade(0x2a3a8a, dl * 0.85), 0.375, 0.125);
    add(0.5, 0.75, 0.25, shade(0xffd54a, dl), 1.125); add(0.5, 0.5, 0.5, shade(0xc89a70, dl), 1.75);
    add(0.2, 0.7, 0.2, shade(0xc89a70, dl * 0.9), 1.1, -0.35); add(0.2, 0.7, 0.2, shade(0xc89a70, dl * 0.9), 1.1, 0.35);
    scene.add(g);
    labels.push({ pos: { x, y: y + 2.3, z }, text: `${me} (me)`, kind: 'teammate' });
  }
  // chests / containers
  if (T.highlight || T.xray) {
    const pts = [];
    for (const c of snap.chests || []) {
      if (sliceY != null && c.y > sliceY) continue;
      const a = [c.x + 0.02, c.y + 0.02, c.z + 0.02], b = [c.x + 0.98, c.y + 0.9, c.z + 0.98];
      const C = [[a[0], a[1], a[2]], [b[0], a[1], a[2]], [b[0], a[1], b[2]], [a[0], a[1], b[2]], [a[0], b[1], a[2]], [b[0], b[1], a[2]], [b[0], b[1], b[2]], [a[0], b[1], b[2]]];
      for (const [i, j] of [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]]) pts.push(...C[i], ...C[j]);
      if (/chest|barrel|shulker/.test(c.name)) labels.push({ pos: { x: c.x + 0.5, y: c.y + 1.2, z: c.z + 0.5 }, text: c.name, kind: 'chest', small: true });
    }
    if (pts.length) {
      const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
      const l = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: 0xffb347, depthTest: false, transparent: true })); l.renderOrder = 8; scene.add(l);
    }
    for (const e of snap.entities || []) {
      if (e.kind === 'item' || e.kind === 'other') continue;
      const h = e.h || 1.8, w = (e.w || 0.6) / 2 + 0.05;
      const g = new THREE.BoxGeometry(w * 2, h + 0.1, w * 2);
      const l = new THREE.LineSegments(new THREE.EdgesGeometry(g), new THREE.LineBasicMaterial({ color: new THREE.Color(KIND_COL[team.has(e.name) ? 'teammate' : e.kind] || '#fff'), depthTest: false, transparent: true }));
      l.position.set(e.pos.x, e.pos.y + h / 2, e.pos.z); l.renderOrder = 8; scene.add(l);
    }
  }
  // waypoints: beacon beams
  if (T.waypoints && P.waypoints?.length) {
    for (const w of P.waypoints) {
      const beam = new THREE.Mesh(new THREE.BoxGeometry(0.3, 40, 0.3), new THREE.MeshBasicMaterial({ color: 0xff7ae0, transparent: true, opacity: 0.45, depthWrite: false, fog: false }));
      beam.position.set(w.x + 0.5, w.y + 20, w.z + 0.5); beam.renderOrder = 6; scene.add(beam);
      const base = new THREE.Mesh(new THREE.OctahedronGeometry(0.45), new THREE.MeshBasicMaterial({ color: 0xff7ae0, depthTest: false, fog: false }));
      base.position.set(w.x + 0.5, w.y + 1, w.z + 0.5); base.renderOrder = 7; scene.add(base);
      labels.push({ pos: { x: w.x + 0.5, y: w.y + 2, z: w.z + 0.5 }, text: `★ ${w.name} ${w.x},${w.y},${w.z}`, kind: 'waypoint' });
    }
  }
  // ghost bbox outline + labels for conflicts are in meta; outline the build area
  if (P.ghostBox) {
    const { min, max } = P.ghostBox;
    const g = new THREE.BoxGeometry(max.x - min.x + 1, max.y - min.y + 1, max.z - min.z + 1);
    const l = new THREE.LineSegments(new THREE.EdgesGeometry(g), new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.55, depthTest: false }));
    l.position.set((min.x + max.x + 1) / 2, (min.y + max.y + 1) / 2, (min.z + max.z + 1) / 2); l.renderOrder = 7; scene.add(l);
  }

  // ---- grid + axes
  const gridY = sliceY != null ? sliceY + 1.01 : Math.floor(snap.bot?.pos?.y ?? ctr.y) + 0.02;
  const axisLabels = [];
  if (T.grid) {
    const pts = [], strong = [];
    const x0 = origin.x, x1 = origin.x + size.x, z0 = origin.z, z1 = origin.z + size.z;
    for (let x = x0; x <= x1; x++) (x % 8 === 0 ? strong : pts).push(x, gridY, z0, x, gridY, z1);
    for (let z = z0; z <= z1; z++) (z % 8 === 0 ? strong : pts).push(x0, gridY, z, x1, gridY, z);
    const mkL = (arr, color, op) => { const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(arr, 3)); const l = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color, transparent: true, opacity: op, depthTest: cam.mode !== 'map' })); l.renderOrder = 4; scene.add(l); };
    mkL(pts, 0xffffff, cam.mode === 'map' ? 0.12 : 0.18); mkL(strong, 0xffff80, 0.55);
    for (let x = Math.ceil(x0 / 8) * 8; x <= x1; x += 8) axisLabels.push({ pos: { x, y: gridY, z: z0 }, text: `x${x}`, kind: 'axis' });
    for (let z = Math.ceil(z0 / 8) * 8; z <= z1; z += 8) axisLabels.push({ pos: { x: x0, y: gridY, z }, text: `z${z}`, kind: 'axis' });
    // axis gizmo at the centre: +X red, +Y green, +Z blue
    const c0 = snap.bot?.pos ? { x: Math.floor(snap.bot.pos.x), y: gridY, z: Math.floor(snap.bot.pos.z) } : { x: Math.floor(ctr.x), y: gridY, z: Math.floor(ctr.z) };
    for (const [dx, dy, dz, col, name] of [[4, 0, 0, 0xff4040, '+X east'], [0, 4, 0, 0x40ff40, '+Y up'], [0, 0, 4, 0x4080ff, '+Z south']]) {
      const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute([c0.x, c0.y, c0.z, c0.x + dx, c0.y + dy, c0.z + dz], 3));
      const l = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: col, depthTest: false })); l.renderOrder = 9; scene.add(l);
      axisLabels.push({ pos: { x: c0.x + dx, y: c0.y + dy, z: c0.z + dz }, text: name, kind: 'axis', color: '#' + col.toString(16).padStart(6, '0') });
    }
  }

  // ---- camera
  // Any angle: orbit = angle (0 = camera south of the target, clockwise seen from above) + elevation (-89 below .. 89 above),
  // or yaw/pitch = the direction the camera looks (F3 convention; angle = yaw-180, elevation = pitch). free = pos + look_at or yaw/pitch.
  let camera; let viewDesc = '';
  const aspect = W / H;
  const baseFocus = (P.ghostBox ? { x: (P.ghostBox.min.x + P.ghostBox.max.x + 1) / 2, y: (P.ghostBox.min.y + P.ghostBox.max.y + 1) / 2, z: (P.ghostBox.min.z + P.ghostBox.max.z + 1) / 2 } : null) || (snap.bot?.pos ? { x: snap.bot.pos.x, y: snap.bot.pos.y + 1, z: snap.bot.pos.z } : ctr);
  const tgt = cam.target || cam.look_at;
  const focus = tgt ? { x: tgt.x, y: tgt.y ?? baseFocus.y, z: tgt.z } : baseFocus;
  const zoom = Math.max(0.2, Math.min(16, Number(cam.zoom) || 1));
  if (cam.mode === 'map') {
    const half = (cam.half ?? (Math.max(size.x / aspect, size.z) / 2 + 0.5)) / zoom;
    camera = new THREE.OrthographicCamera(-half * aspect, half * aspect, half, -half, 0.1, 1000);
    const cx = cam.target?.x ?? origin.x + size.x / 2, cz = cam.target?.z ?? origin.z + size.z / 2;
    camera.position.set(cx, (sliceY ?? origin.y + size.y) + 50, cz);
    // screen-up = north by default; yaw rotates the map so that the direction of that yaw (F3: 0 south, 180 north) is up
    if (cam.yaw != null) { const d = mcDir(cam.yaw, 0); camera.up.set(d.x, 0, d.z); } else camera.up.set(0, 0, -1);
    camera.lookAt(cx, 0, cz);
    viewDesc = `top-down map ${cam.yaw != null ? `rotated (${compass(cam.yaw)} up)` : 'north up, x→right'}${sliceY != null ? `, cut at y ${sliceY}` : ''}${zoom !== 1 ? `, zoom x${zoom}` : ''}`;
  } else {
    // zoom narrows the field of view (zoom 2 = half the view angle); fov is clamped to a sane range
    const fov = Math.max(8, Math.min(120, cam.zoom ? (2 * Math.atan(Math.tan(((cam.fov || 70) * D2R) / 2) / zoom)) / D2R : (cam.fov || 70)));
    camera = new THREE.PerspectiveCamera(fov, aspect, 0.05, 600);
    let pos, dir, hintYaw = null; // hintYaw: heading to use as "screen up" when looking straight up/down
    if (cam.mode === 'first_person') {
      const b = snap.bot;
      pos = b.eye || { x: b.pos.x, y: b.pos.y + 1.62, z: b.pos.z };
      const own = mfToMc(b.yaw, b.pitch);
      const mc = { yaw: cam.yaw ?? own.yaw, pitch: Math.max(-90, Math.min(90, cam.pitch ?? (cam.yaw != null ? 0 : own.pitch))) };
      dir = mcDir(mc.yaw, mc.pitch); hintYaw = mc.yaw;
      viewDesc = `first person from ${me}'s eyes, facing ${compass(mc.yaw)}${mc.pitch ? `, pitch ${Math.round(mc.pitch)}` : ''}`;
    } else if (cam.mode === 'free') {
      const b = snap.bot;
      pos = cam.pos || (b?.eye || (b?.pos ? { x: b.pos.x, y: b.pos.y + 1.62, z: b.pos.z } : ctr));
      if (cam.look_at) { dir = { x: cam.look_at.x - pos.x, y: (cam.look_at.y ?? pos.y) - pos.y, z: cam.look_at.z - pos.z }; if (Math.hypot(dir.x, dir.y, dir.z) < 1e-3) dir = mcDir(cam.yaw ?? 180, cam.pitch ?? 0); hintYaw = cam.yaw ?? 180; }
      else { const pit = Math.max(-90, Math.min(90, cam.pitch ?? 20)); dir = mcDir(cam.yaw ?? 180, pit); hintYaw = cam.yaw ?? 180; }
      viewDesc = `free camera at ${fmt(pos)}${cam.look_at ? ` looking at ${fmt(cam.look_at)}` : ` facing ${compass(cam.yaw ?? 180)}, pitch ${Math.round(cam.pitch ?? 20)}`}`;
    } else { // orbit / slice / auto
      let az = typeof cam.from === 'string' ? (FROM[cam.from] ?? 0) : (cam.angle ?? 30);
      let elDeg = cam.elevation ?? (cam.mode === 'slice' ? 55 : 38);
      if (cam.yaw != null) { az = cam.yaw - 180; if (cam.pitch != null) elDeg = cam.pitch; } // yaw/pitch = the direction the camera looks
      else if (cam.pitch != null && cam.elevation == null) elDeg = cam.pitch;
      elDeg = Math.max(-89, Math.min(89, elDeg));
      const el = elDeg * D2R;
      const ext = P.ghostBox ? Math.max(P.ghostBox.max.x - P.ghostBox.min.x, P.ghostBox.max.y - P.ghostBox.min.y, P.ghostBox.max.z - P.ghostBox.min.z) + 1 : 0;
      const dist = Math.max(1, cam.distance ?? (ext ? Math.max(8, ext * 1.6) : Math.min(R * 1.25, 40)));
      // az: compass position of the camera relative to the target (0 = south of it, looking north)
      const azr = az * D2R;
      pos = { x: focus.x - Math.sin(azr) * Math.cos(el) * dist, y: focus.y + Math.sin(el) * dist, z: focus.z + Math.cos(azr) * Math.cos(el) * dist };
      dir = { x: focus.x - pos.x, y: focus.y - pos.y, z: focus.z - pos.z };
      hintYaw = az + 180;
      viewDesc = `${sliceY != null ? `cutaway at y ${sliceY}, ` : ''}orbit around ${fmt(focus)} from the ${compass(az + 180, true)}, ${Math.round(dist)} blocks away, ${elDeg < 0 ? `${Math.round(-elDeg)}° BELOW looking up` : `${Math.round(elDeg)}° above`}`;
    }
    // keep the aim point out of the fog when the camera is far from it (free camera far away, large orbit distance)
    if (scene.fog && (cam.look_at || cam.mode !== 'free')) { const d = Math.hypot(focus.x - pos.x, focus.y - pos.y, focus.z - pos.z); scene.fog.near = Math.max(scene.fog.near, d * 1.4); scene.fog.far = Math.max(scene.fog.far, d * 2.8); }
    camera.position.set(pos.x, pos.y, pos.z);
    aim(THREE, camera, pos, dir, hintYaw);
  }
  camera.updateMatrixWorld(); camera.updateProjectionMatrix();
  const allLabels = T.labels ? labels.concat(axisLabels) : axisLabels;

  function drawOverlay(ctx, w, h, camOverride) {
    const c = camOverride || camera;
    const v = new THREE.Vector3();
    ctx.textBaseline = 'middle'; ctx.textAlign = 'center';
    const placed = [];
    for (const L of allLabels) {
      v.set(L.pos.x, L.pos.y, L.pos.z).project(c);
      if (v.z > 1 || v.z < -1) continue;
      const sx = (v.x * 0.5 + 0.5) * w, sy = (-v.y * 0.5 + 0.5) * h;
      if (sx < -50 || sx > w + 50 || sy < -20 || sy > h + 20) continue;
      const font = L.kind === 'axis' ? 'bold 12px monospace' : L.small ? 'bold 12px sans-serif' : 'bold 15px sans-serif';
      ctx.font = font;
      const tw = ctx.measureText(L.text).width + 8, th = L.small || L.kind === 'axis' ? 16 : 20;
      if (placed.some((p) => Math.abs(p[0] - sx) < (tw + p[2]) / 2 && Math.abs(p[1] - sy) < th)) continue;
      placed.push([sx, sy, tw]);
      ctx.fillStyle = 'rgba(0,0,0,0.6)'; ctx.fillRect(sx - tw / 2, sy - th / 2, tw, th);
      ctx.fillStyle = L.color || KIND_COL[L.kind] || '#fff'; ctx.fillText(L.text, sx, sy + 1);
    }
    // compass rose (perspective) / north arrow (map). Works for any camera orientation, incl. straight up/down.
    const north = new THREE.Vector3(0, 0, -1);
    const camRight = new THREE.Vector3(1, 0, 0).applyQuaternion(c.quaternion), camUp = new THREE.Vector3(0, 1, 0).applyQuaternion(c.quaternion);
    c.getWorldDirection(v);
    const cx = w - 44, cy = 44;
    ctx.fillStyle = 'rgba(0,0,0,0.5)'; ctx.beginPath(); ctx.arc(cx, cy, 30, 0, Math.PI * 2); ctx.fill();
    let ax, ay;
    if (c.isOrthographicCamera) { ax = north.dot(camRight); ay = -north.dot(camUp); }
    else {
      const fwd = new THREE.Vector3(v.x, 0, v.z);
      if (fwd.length() < 0.05) fwd.set(camUp.x, 0, camUp.z).multiplyScalar(v.y < 0 ? 1 : -1);
      fwd.normalize();
      const rt = new THREE.Vector3(camRight.x, 0, camRight.z).normalize();
      ax = north.dot(rt); ay = -north.dot(fwd);
    }
    if (Number.isNaN(ax) || Number.isNaN(ay)) { ax = 0; ay = -1; }
    ctx.strokeStyle = '#ff5050'; ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + ax * 22, cy + ay * 22); ctx.stroke();
    ctx.fillStyle = '#fff'; ctx.font = 'bold 13px sans-serif'; ctx.fillText('N', cx + ax * 22 * 1.25, cy + ay * 22 * 1.25);
    // caption
    if (P.title !== false) {
      const t = P.title || `${me || ''}  ${viewDesc}`;
      ctx.font = '13px sans-serif'; ctx.textAlign = 'left';
      const tw = ctx.measureText(t).width + 12;
      ctx.fillStyle = 'rgba(0,0,0,0.55)'; ctx.fillRect(6, h - 26, tw, 20); ctx.fillStyle = '#fff'; ctx.fillText(t, 12, h - 15);
      ctx.textAlign = 'center';
    }
  }
  return { scene, camera, drawOverlay, viewDesc, faces: world.faces, focus };
}

/** point the camera along dir; when dir is (nearly) vertical lookAt's default up-vector degenerates (roll flips / NaN),
 *  so use the heading hintYaw (F3 yaw) as the screen-up direction instead: looking down, up = forward; looking up, up = backward. */
function aim(THREE, camera, pos, dir, hintYaw) {
  const len = Math.hypot(dir.x, dir.y, dir.z) || 1, hl = Math.hypot(dir.x, dir.z);
  if (hl / len < 0.01) {
    const h = mcDir(hintYaw ?? 180, 0), k = dir.y < 0 ? 1 : -1;
    camera.up.set(h.x * k, 0, h.z * k);
  } else camera.up.set(0, 1, 0);
  camera.lookAt(pos.x + dir.x, pos.y + dir.y, pos.z + dir.z);
}
function fmt(p) { return `${Math.round(p.x)},${Math.round(p.y)},${Math.round(p.z)}`; }
function compass(mcYaw, from) {
  const names = ['south', 'southwest', 'west', 'northwest', 'north', 'northeast', 'east', 'southeast'];
  const i = Math.round((((mcYaw % 360) + 360) % 360) / 45) % 8;
  return from ? names[(i + 4) % 8] : names[i];
}
