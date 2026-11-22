// 2D top-down team map (Minecraft-map style): surface colours shaded by height, explored chunks, waypoints, bots.
// payload = { surfaces:[{origin:{x,z}, size:{x,z}, top(b64 u16), height(b64 i16), colors:[[r,g,b],...] }],
//             bounds:{minX,minZ,maxX,maxZ}, explored:[[cx,cz],...], bots:[{name,pos,yaw,online,me}], waypoints:[{name,x,y,z}],
//             width, height, title }
import { b64ToBytes } from './mesher.js';

export function drawTeamMap(canvas, P) {
  const W = P.width || 1024, H = P.height || 640;
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');
  const b = P.bounds;
  const bw = b.maxX - b.minX + 1, bh = b.maxZ - b.minZ + 1;
  const pad = 28;
  const s = Math.min((W - pad * 2) / bw, (H - pad * 2 - 20) / bh);
  const ox = (W - bw * s) / 2, oy = (H - 20 - bh * s) / 2 + 4;
  const sx = (x) => ox + (x - b.minX) * s, sy = (z) => oy + (z - b.minZ) * s;
  ctx.fillStyle = '#15171c'; ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = '#1e222a'; ctx.fillRect(ox, oy, bw * s, bh * s);
  // explored chunks (where a bot has been)
  ctx.fillStyle = '#343a46';
  for (const [cx, cz] of P.explored || []) ctx.fillRect(sx(cx * 16), sy(cz * 16), 16 * s + 0.5, 16 * s + 0.5);

  // surface pixels at 1 px per block in an offscreen image, then scaled
  const img = ctx.createImageData(bw, bh);
  for (const S of P.surfaces || []) {
    const top = new Uint16Array(b64ToBytes(S.top).buffer), hgt = new Int16Array(b64ToBytes(S.height).buffer);
    const n = S.size.x;
    for (let z = 0; z < S.size.z; z++) for (let x = 0; x < n; x++) {
      const i = z * n + x; const h = hgt[i]; if (h === -32768) continue;
      const wx = S.origin.x + x, wz = S.origin.z + z;
      if (wx < b.minX || wx > b.maxX || wz < b.minZ || wz > b.maxZ) continue;
      const c = S.colors[top[i]] || [0.5, 0.5, 0.5];
      const hn = z > 0 ? hgt[i - n] : h;
      const k = hn === -32768 ? 1 : h > hn ? 1.12 : h < hn ? 0.8 : 0.97;
      const o = ((wz - b.minZ) * bw + (wx - b.minX)) * 4;
      img.data[o] = Math.min(255, c[0] * 255 * k); img.data[o + 1] = Math.min(255, c[1] * 255 * k); img.data[o + 2] = Math.min(255, c[2] * 255 * k); img.data[o + 3] = 255;
    }
  }
  const off = document.createElement('canvas'); off.width = bw; off.height = bh; off.getContext('2d').putImageData(img, 0, 0);
  ctx.imageSmoothingEnabled = false; ctx.drawImage(off, ox, oy, bw * s, bh * s);

  // chunk grid + coordinate labels
  const step = [16, 32, 64, 128, 256, 512].find((st) => st * s >= 60) || 512;
  ctx.strokeStyle = 'rgba(255,255,255,0.12)'; ctx.lineWidth = 1;
  ctx.font = '11px monospace'; ctx.fillStyle = '#cfd6e0'; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  for (let x = Math.ceil(b.minX / step) * step; x <= b.maxX; x += step) { ctx.beginPath(); ctx.moveTo(sx(x), oy); ctx.lineTo(sx(x), oy + bh * s); ctx.stroke(); ctx.fillText(`x${x}`, sx(x), oy + bh * s + 2); }
  ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
  for (let z = Math.ceil(b.minZ / step) * step; z <= b.maxZ; z += step) { ctx.beginPath(); ctx.moveTo(ox, sy(z)); ctx.lineTo(ox + bw * s, sy(z)); ctx.stroke(); ctx.fillText(`z${z}`, ox - 3, sy(z)); }

  // waypoints
  ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
  const placed = [];
  const label = (text, x, y, color) => {
    ctx.font = 'bold 12px sans-serif';
    const tw = ctx.measureText(text).width + 6;
    let yy = y; for (let t = 0; t < 4 && placed.some((p) => Math.abs(p[0] - x) < (tw + p[2]) / 2 + 4 && Math.abs(p[1] - yy) < 15); t++) yy += 15;
    placed.push([x + tw / 2, yy, tw]);
    ctx.fillStyle = 'rgba(0,0,0,0.65)'; ctx.fillRect(x, yy - 8, tw, 16); ctx.fillStyle = color; ctx.fillText(text, x + 3, yy + 1);
  };
  for (const w of P.waypoints || []) {
    const x = sx(w.x + 0.5), y = sy(w.z + 0.5);
    ctx.fillStyle = '#ff7ae0'; ctx.strokeStyle = '#000'; ctx.lineWidth = 1.5;
    star(ctx, x, y, 7); ctx.fill(); ctx.stroke();
    label(`${w.name} ${w.x},${w.y},${w.z}`, x + 9, y, '#ffb3ef');
  }
  // bots
  const COLS = ['#ffd54a', '#4fc3ff', '#9cff7a', '#ff9a4a', '#d28cff', '#ff6b8b', '#6bffe0', '#ffffff'];
  (P.bots || []).forEach((bt, i) => {
    if (!bt.pos) return;
    const x = sx(bt.pos.x), y = sy(bt.pos.z); const col = bt.me ? '#ffffff' : COLS[i % COLS.length];
    ctx.fillStyle = col; ctx.strokeStyle = '#000'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(x, y, 6, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    if (bt.yaw != null) { const a = bt.yaw; ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x - Math.sin(a) * 13, y - Math.cos(a) * 13); ctx.strokeStyle = col; ctx.lineWidth = 2.5; ctx.stroke(); }
    label(`${bt.name}${bt.me ? ' (you)' : ''} ${Math.floor(bt.pos.x)},${Math.floor(bt.pos.y)},${Math.floor(bt.pos.z)}${bt.online === false ? ' offline' : ''}`, x + 9, y, col);
  });
  // north arrow, scale bar, title
  ctx.fillStyle = 'rgba(0,0,0,0.55)'; ctx.beginPath(); ctx.arc(W - 34, 34, 22, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = '#ff5050'; ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(W - 34, 46); ctx.lineTo(W - 34, 20); ctx.stroke();
  ctx.fillStyle = '#fff'; ctx.font = 'bold 13px sans-serif'; ctx.textAlign = 'center'; ctx.fillText('N', W - 34, 14);
  const sb = step; ctx.fillStyle = '#fff'; ctx.fillRect(W - 30 - sb * s, H - 20, sb * s, 3); ctx.font = '11px sans-serif'; ctx.fillText(`${sb} blocks`, W - 30 - (sb * s) / 2, H - 30);
  ctx.textAlign = 'left'; ctx.font = '13px sans-serif'; ctx.fillStyle = '#fff';
  ctx.fillText(P.title || 'Team map', 10, H - 12);
  return { scale: s, bounds: b };
}

function star(ctx, x, y, r) {
  ctx.beginPath();
  for (let i = 0; i < 10; i++) { const a = (i * Math.PI) / 5 - Math.PI / 2; const rr = i % 2 ? r * 0.45 : r; ctx[i ? 'lineTo' : 'moveTo'](x + Math.cos(a) * rr, y + Math.sin(a) * rr); }
  ctx.closePath();
}
