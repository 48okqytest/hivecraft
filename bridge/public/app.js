// Hivecraft dashboard — vanilla JS, one SSE stream.
'use strict';
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
// the human (hivecraft.config.json player.displayName); set from the bridge's init snapshot
let ME = 'Player';
window.HIVE_PLAYER = ME;

function el(tag, props = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else if (k === 'style') e.style.cssText = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(e.dataset, v);
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c !== null && c !== undefined && c !== false) e.append(c.nodeType ? c : document.createTextNode(String(c)));
  return e;
}
async function api(method, path, body) {
  const r = await fetch(path, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) console.warn(method, path, r.status, j.error);
  return j;
}
const hhmm = (ts) => new Date(ts).toTimeString().slice(0, 5);
const hhmmss = (ts) => new Date(ts).toTimeString().slice(0, 8);

// ---------- colours ----------
const PALETTE = ['#ffb547', '#4cc9f0', '#b794f6', '#4ade80', '#fb7185', '#e5e94b', '#ff8a4c', '#2dd4bf'];
const colorOf = new Map([[ME, '#f3f6fb'], ['system', '#6b7689'], ['all', '#9aa5b8']]);
function color(name) {
  if (colorOf.has(name)) return colorOf.get(name);
  let h = 5381;
  for (const ch of name) h = ((h << 5) + h + ch.charCodeAt(0)) >>> 0;
  const used = new Set(colorOf.values());
  let i = h % PALETTE.length, tries = 0;
  while (used.has(PALETTE[i]) && tries++ < PALETTE.length) i = (i + 1) % PALETTE.length;
  colorOf.set(name, PALETTE[i]);
  return PALETTE[i];
}

// ---------- state ----------
const S = { bots: [], messages: [], board: [], notes: [], waypoints: [], goal: { text: '' }, logs: {}, selected: null, trails: {}, memAgent: null, logKinds: { thought: true, tool: true, result: true, error: true, system: true } };

// ---------- SSE ----------
let es;
function connect() {
  es = new EventSource('/events');
  const on = (t, f) => es.addEventListener(t, (e) => { try { f(JSON.parse(e.data)); } catch (err) { console.error(t, err); } });
  es.onopen = () => setConn(true);
  es.onerror = () => setConn(false);
  on('init', (d) => {
    if (d.player?.name && d.player.name !== ME) { colorOf.delete(ME); ME = d.player.name; window.HIVE_PLAYER = ME; colorOf.set(ME, '#f3f6fb'); }
    S.messages = d.messages; S.board = d.board; S.notes = d.notes; S.waypoints = d.waypoints; S.goal = d.goal;
    [...d.bots.map((b) => b.name), ...S.messages.map((m) => m.from)].sort().forEach(color);
    setBots(d.bots);
    renderAll();
    if (S.selected) loadLog(S.selected, true);
  });
  on('bots', setBots);
  on('msg', (m) => { if (!S.messages.some((x) => x.id === m.id)) { S.messages.push(m); if (S.messages.length > 800) S.messages.shift(); appendMsg(m); renderChatTo(); } });
  on('board', (t) => { const i = S.board.findIndex((x) => x.id === t.id); i >= 0 ? (S.board[i] = t) : S.board.push(t); renderBoard(); });
  on('board_delete', ({ id }) => { S.board = S.board.filter((t) => t.id !== id); renderBoard(); });
  on('note', (n) => { S.notes = S.notes.filter((x) => x.key !== n.key).concat(n); renderNotes(); });
  on('note_delete', ({ key }) => { S.notes = S.notes.filter((x) => x.key !== key); renderNotes(); });
  on('waypoint', (w) => { S.waypoints = S.waypoints.filter((x) => x.name !== w.name).concat(w); renderWaypoints(); markMap(); });
  on('waypoint_delete', ({ name }) => { S.waypoints = S.waypoints.filter((x) => x.name !== name); renderWaypoints(); markMap(); });
  on('goal', (g) => { S.goal = g; renderGoal(); });
  on('log', (e) => {
    const arr = S.logs[e.name];
    if (!arr) { renderLogAgents(); return; }
    if (!arr.some((x) => x.id === e.id)) arr.push(e);
    if (arr.length > 800) arr.shift();
    if (S.selected === e.name) appendLog(e);
  });
  on('memory', ({ name }) => { if (S.memAgent === name && !$('#tab-memory').hidden) loadMemory(name); });
}
function setConn(ok) {
  const c = $('#conn');
  c.classList.toggle('bad', !ok);
  $('em', c).textContent = ok ? 'live' : 'reconnecting…';
}

// ---------- bots ----------
function setBots(list) {
  S.bots = list;
  if (!S.selected && list.length) S.selected = list[0].name;
  for (const b of list) {
    color(b.name);
    if (b.pos && b.online) {
      const tr = (S.trails[b.name] ||= []);
      const last = tr[tr.length - 1];
      if (!last || Math.hypot(last.x - b.pos.x, last.z - b.pos.z) > 0.8) { tr.push({ x: b.pos.x, z: b.pos.z }); if (tr.length > 400) tr.shift(); }
    }
  }
  renderBots();
  renderStats();
  renderChatTo();
  renderLogAgents();
  markMap();
}

const botSig = new Map();
function renderBots() {
  const box = $('#bots');
  $('#botCount').textContent = S.bots.length ? `${S.bots.filter((b) => b.online).length}/${S.bots.length} online` : '';
  if (!S.bots.length) { if (!box.querySelector('.empty')) { box.replaceChildren(el('div', { class: 'empty', text: 'No agents yet. The crew spawns them on start.' })); botSig.clear(); } return; }
  box.querySelector('.empty')?.remove();
  const names = S.bots.map((b) => b.name);
  for (const n of [...botSig.keys()]) if (!names.includes(n)) { box.querySelector(`[data-n="${n}"]`)?.remove(); botSig.delete(n); }
  S.bots.forEach((b, idx) => {
    const sig = JSON.stringify([b, S.selected === b.name, Math.round((b.reconnectInMs || 0) / 1000)]);
    let node = box.querySelector(`[data-n="${b.name}"]`);
    if (botSig.get(b.name) === sig && node) return;
    botSig.set(b.name, sig);
    const fresh = botCard(b);
    if (node) node.replaceWith(fresh); else box.append(fresh);
    if (box.children[idx] !== fresh) box.insertBefore(fresh, box.children[idx] || null);
  });
}
function botCard(b) {
  const c = color(b.name);
  const hp = Math.max(0, Math.min(20, b.health ?? 0)), fd = Math.max(0, Math.min(20, b.food ?? 0));
  const inv = [...(b.inventory || [])].sort((x, y) => y.count - x.count);
  const shown = inv.slice(0, 12);
  const p = b.pos;
  const status = b.status || (b.online ? 'online' : 'offline');
  return el('div', { class: `bot${b.online ? '' : ' off'}${S.selected === b.name ? ' sel' : ''}`, style: `--c:${c}`, dataset: { n: b.name }, onclick: () => selectBot(b.name) },
    el('div', { class: 'row1' },
      el('span', { class: `dot${status === 'online' ? '' : status === 'connecting' ? ' con' : ' off'}` }),
      el('span', { class: 'nm', text: b.name }),
      b.role ? el('span', { class: 'role', text: b.role }) : null,
      el('span', { class: `act${b.currentAction ? ' busy' : ''}`, text: b.currentAction ? `${b.currentAction}${b.currentArgs ? ' ' + shortArgs(b.currentArgs) : ''}` : status === 'online' ? 'idle' : status, title: b.currentAction ? JSON.stringify(b.currentArgs) : '' })),
    b.online ? el('div', { class: 'bars' },
      el('div', { class: 'bar', title: `health ${hp}/20` }, el('i', { style: `width:${hp * 5}%` }), el('span', { text: `♥ ${Math.round(hp)}` })),
      el('div', { class: 'bar food', title: `food ${fd}/20` }, el('i', { style: `width:${fd * 5}%` }), el('span', { text: `🍖 ${Math.round(fd)}` }))) : null,
    el('div', { class: 'meta' },
      p ? el('span', {}, 'xyz ', el('b', { text: `${Math.round(p.x)} ${Math.round(p.y)} ${Math.round(p.z)}` })) : el('span', { text: 'no position' }),
      b.held ? el('span', {}, '✋ ', el('b', { text: b.held })) : null,
      b.dimension && b.dimension !== 'overworld' ? el('span', { text: b.dimension }) : null,
      b.hostiles ? el('span', { style: 'color:var(--red)', text: `⚠ ${b.hostiles} hostile` }) : null),
    shown.length ? el('div', { class: 'inv' }, shown.map((i) => el('span', { class: 'chip' }, i.name.replace(/_/g, ' '), el('b', { text: i.count }))), inv.length > shown.length ? el('span', { class: 'chip', text: `+${inv.length - shown.length}` }) : null) : null,
    b.lastThought ? el('div', { class: 'thought', text: '“' + b.lastThought + '”' }) : el('div', { class: 'thought' }),
    !b.online && b.lastError ? el('div', { class: 'warn', text: `${b.lastError}${b.reconnectInMs ? ` · retry in ${Math.ceil(b.reconnectInMs / 1000)}s` : ''}` }) : null);
}
function shortArgs(a) {
  const s = Object.values(a || {}).filter((v) => typeof v !== 'object').join(',');
  return s.length > 26 ? s.slice(0, 25) + '…' : s;
}
function selectBot(n) {
  S.selected = n;
  botSig.clear(); renderBots();
  renderLogAgents();
  loadLog(n);
  markMap();
}
function renderStats() {
  const on = S.bots.filter((b) => b.online).length;
  $('#statBots').innerHTML = `<b>${on}</b>/${S.bots.length} agents`;
  const open = S.board.filter((t) => t.status !== 'done').length;
  $('#statTasks').innerHTML = `<b>${open}</b> open tasks`;
}

// ---------- goal ----------
function renderGoal() {
  const g = $('#goalText');
  g.textContent = S.goal.text || 'No goal set — click to set one for the team';
  g.classList.toggle('unset', !S.goal.text);
  g.title = S.goal.text || '';
}
function goalEdit(on) {
  $('#goalText').hidden = on;
  for (const id of ['#goalEdit', '#goalSave', '#goalCancel']) $(id).hidden = !on;
  if (on) { $('#goalEdit').value = S.goal.text || ''; $('#goalEdit').focus(); }
}
$('#goalText').onclick = () => goalEdit(true);
$('#goalCancel').onclick = () => goalEdit(false);
$('#goalSave').onclick = async () => { await api('POST', '/goal', { text: $('#goalEdit').value, by: ME }); goalEdit(false); };
$('#goalEdit').addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || !e.shiftKey)) { e.preventDefault(); $('#goalSave').click(); } if (e.key === 'Escape') goalEdit(false); });

// ---------- chat ----------
let showSys = false;
function msgNode(m) {
  const sys = m.from === 'system';
  const dm = m.to !== 'all';
  return el('div', { class: `msg${sys ? ' sys' : ''}${m.from === ME ? ' me' : ''}`, dataset: { id: m.id } },
    el('span', { class: 't', text: hhmm(m.ts) }),
    el('div', {},
      el('span', { class: 'who', style: `color:${color(m.from)}`, text: m.from }),
      dm || sys ? el('span', { class: `to${dm ? ' dm' : ''}` }, ' → ', el('span', { style: `color:${color(m.to)}`, text: m.to })) : null,
      ' ', el('span', { class: 'tx', text: m.text })));
}
function appendMsg(m) {
  if (m.from === 'system' && !showSys) return;
  const box = $('#chat');
  const stick = box.scrollHeight - box.scrollTop - box.clientHeight < 60;
  box.append(msgNode(m));
  while (box.children.length > 500) box.firstChild.remove();
  if (stick) box.scrollTop = box.scrollHeight;
}
function renderChat() {
  const box = $('#chat');
  box.replaceChildren(...S.messages.filter((m) => showSys || m.from !== 'system').slice(-400).map(msgNode));
  box.scrollTop = box.scrollHeight;
}
$('#showSys').onchange = (e) => { showSys = e.target.checked; renderChat(); };
function renderChatTo() {
  const sel = $('#chatTo');
  const want = ['all', ...S.bots.map((b) => b.name)];
  if ([...sel.options].map((o) => o.value).join() === want.join()) return;
  const cur = sel.value;
  sel.replaceChildren(...want.map((n) => el('option', { value: n, text: n === 'all' ? 'Everyone' : '→ ' + n })));
  if (want.includes(cur)) sel.value = cur;
}
$('#chatForm').onsubmit = async (e) => {
  e.preventDefault();
  const text = $('#chatText').value.trim();
  if (!text) return;
  $('#chatText').value = '';
  await api('POST', '/msg', { from: ME, to: $('#chatTo').value || 'all', text });
};

// ---------- board ----------
const COLS = [['open', 'Open'], ['claimed', 'In progress'], ['blocked', 'Blocked'], ['done', 'Done']];
const expanded = new Set();
const PRIO = { high: 0, normal: 1, low: 2 };
function renderBoard() {
  renderStats();
  const box = $('#board');
  const scrolls = Object.fromEntries($$('.cards', box).map((c) => [c.dataset.s, c.scrollTop]));
  box.replaceChildren(...COLS.map(([s, label]) => {
    const tasks = S.board.filter((t) => t.status === s).sort((a, b) => (PRIO[a.priority] ?? 1) - (PRIO[b.priority] ?? 1) || (s === 'done' ? b.updated - a.updated : a.id - b.id));
    const cards = el('div', { class: 'cards', dataset: { s } }, tasks.map(taskNode));
    if (!tasks.length) cards.append(el('div', { class: 'empty', text: '—' }));
    const col = el('div', { class: `col ${s}` }, el('h3', {}, label, el('em', { text: tasks.length })), cards);
    queueMicrotask(() => { cards.scrollTop = scrolls[s] || 0; });
    return col;
  }));
}
function taskNode(t) {
  const open = expanded.has(t.id);
  const mv = (status) => el('button', { class: 'btn tiny', text: status === 'open' ? 'reopen' : status, onclick: (e) => { e.stopPropagation(); api('POST', `/board/${t.id}`, { by: ME, status }); } });
  return el('div', { class: 'task', onclick: () => { open ? expanded.delete(t.id) : expanded.add(t.id); renderBoard(); } },
    el('div', { class: 'tt', text: t.title }),
    el('div', { class: 'tm' },
      el('span', { class: 'id', text: '#' + t.id }),
      el('span', { class: `prio ${t.priority}`, text: t.priority }),
      t.owner ? el('span', { class: 'own', style: `--c:${color(t.owner)}`, text: t.owner }) : null,
      t.notes?.length ? el('span', { text: `💬 ${t.notes.length}` }) : null),
    open ? el('div', { class: 'more' },
      t.detail ? el('div', { text: t.detail }) : null,
      (t.notes || []).map((n) => el('div', { class: 'nt', text: n })),
      el('div', { class: 'dim', style: 'margin-top:4px;font-size:10.5px', text: `by ${t.by} · updated ${hhmmss(t.updated)}` }),
      el('div', { class: 'acts' }, ['open', 'claimed', 'blocked', 'done'].filter((s) => s !== t.status && s !== 'claimed').map(mv),
        el('button', { class: 'btn tiny danger', text: 'delete', onclick: (e) => { e.stopPropagation(); if (confirm(`Delete task #${t.id}?`)) api('DELETE', `/board/${t.id}`); } }))) : null);
}
$('#taskForm').onsubmit = async (e) => {
  e.preventDefault();
  const title = $('#taskTitle').value.trim();
  if (!title) return;
  $('#taskTitle').value = '';
  await api('POST', '/board', { by: ME, title, priority: $('#taskPrio').value });
};

// ---------- notes / waypoints / memory ----------
function renderNotes() {
  const box = $('#notes');
  const list = [...S.notes].sort((a, b) => b.ts - a.ts);
  box.replaceChildren(...(list.length ? list.map((n) => el('div', { class: 'item' },
    el('button', { class: 'btn tiny danger x', text: '×', onclick: () => api('DELETE', '/notes/' + encodeURIComponent(n.key)) }),
    el('span', { class: 'k', text: n.key }), el('span', { class: 'by', style: `color:${color(n.by)}`, text: `${n.by} · ${hhmm(n.ts)}` }),
    el('div', { class: 'v', text: n.text }))) : [el('div', { class: 'empty', text: 'No shared notes yet.' })]));
}
$('#noteForm').onsubmit = async (e) => {
  e.preventDefault();
  const key = $('#noteKey').value.trim(), text = $('#noteText').value.trim();
  if (!key || !text) return;
  await api('POST', '/notes', { by: ME, key, text });
  $('#noteKey').value = ''; $('#noteText').value = '';
};
function renderWaypoints() {
  const box = $('#waypoints');
  const list = [...S.waypoints].sort((a, b) => a.name.localeCompare(b.name));
  box.replaceChildren(...(list.length ? list.map((w) => el('div', { class: 'item' },
    el('button', { class: 'btn tiny danger x', text: '×', onclick: () => api('DELETE', '/waypoints/' + encodeURIComponent(w.name)) }),
    el('span', { class: 'k', text: '◆ ' + w.name }), el('span', { class: 'by', style: `color:${color(w.by)}`, text: w.by }),
    el('div', { class: 'v mono', text: `${w.x} ${w.y} ${w.z}${w.dimension && w.dimension !== 'overworld' ? ' · ' + w.dimension : ''}` }),
    w.note ? el('div', { class: 'v dim', text: w.note }) : null)) : [el('div', { class: 'empty', text: 'No waypoints yet.' })]));
}
$('#wpForm').onsubmit = async (e) => {
  e.preventDefault();
  const name = $('#wpName').value.trim();
  if (!name) return;
  await api('POST', '/waypoints', { by: ME, name, x: $('#wpX').value, y: $('#wpY').value, z: $('#wpZ').value });
  for (const id of ['#wpName', '#wpX', '#wpY', '#wpZ']) $(id).value = '';
};
async function loadMemory(name) {
  S.memAgent = name;
  renderPills($('#memAgents'), (n) => loadMemory(n), name);
  const m = await api('GET', '/memory/' + name);
  $('#memText').textContent = m.text || '(empty — this agent has not saved any memory)';
}

// ---------- agent log ----------
function renderPills(box, onPick, selected) {
  box.replaceChildren(...S.bots.map((b) => el('button', { class: `pill${selected === b.name ? ' on' : ''}`, style: `--c:${color(b.name)}`, text: b.name, onclick: () => onPick(b.name) })));
}
function renderLogAgents() {
  renderPills($('#logAgents'), selectBot, S.selected);
  const f = $('#logFilters');
  if (!f.children.length) f.replaceChildren(...Object.keys(S.logKinds).map((k) => el('button', { class: `pill k${S.logKinds[k] ? ' on' : ''}`, text: k, onclick: (e) => { S.logKinds[k] = !S.logKinds[k]; e.target.classList.toggle('on', S.logKinds[k]); renderLog(); } })));
}
async function loadLog(name, force) {
  if (!name) return;
  if (!S.logs[name] || force) {
    const r = await api('GET', `/log/${name}?limit=300`);
    S.logs[name] = r.entries || [];
  }
  if (S.selected === name) renderLog();
}
function logNode(e) {
  return el('div', { class: `ll ${e.kind}`, dataset: { id: e.id } }, el('span', { class: 't', text: hhmm(e.ts) }), el('span', { class: 'tx', text: e.text }));
}
function renderLog() {
  const box = $('#log');
  const arr = (S.logs[S.selected] || []).filter((e) => S.logKinds[e.kind] !== false);
  box.replaceChildren(...(arr.length ? arr.slice(-300).map(logNode) : [el('div', { class: 'empty', text: S.selected ? 'No log lines yet for ' + S.selected : 'Select an agent' })]));
  box.scrollTop = box.scrollHeight;
}
function appendLog(e) {
  if (S.logKinds[e.kind] === false) return;
  const box = $('#log');
  box.querySelector('.empty')?.remove();
  const stick = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
  box.append(logNode(e));
  while (box.children.length > 500) box.firstChild.remove();
  if (stick) box.scrollTop = box.scrollHeight;
}

// ---------- tabs ----------
$$('.tab').forEach((t) => (t.onclick = () => {
  $$('.tab').forEach((x) => x.classList.toggle('on', x === t));
  $$('.tabbody').forEach((b) => (b.hidden = b.id !== 'tab-' + t.dataset.tab));
  if (t.dataset.tab === 'memory') loadMemory(S.memAgent || S.selected || S.bots[0]?.name);
  if (t.dataset.tab === 'log') $('#log').scrollTop = $('#log').scrollHeight;
}));

// ---------- map ----------
const cv = $('#map'), ctx = cv.getContext('2d');
let view = null, dirty = true, mouse = null, W = 0, H = 0, DPR = 1;
function markMap() { dirty = true; if (!raf) raf = requestAnimationFrame(drawMap); }
let raf = 0;
function resizeMap() {
  const r = cv.getBoundingClientRect();
  DPR = window.devicePixelRatio || 1;
  W = r.width; H = r.height;
  cv.width = Math.max(1, Math.round(W * DPR)); cv.height = Math.max(1, Math.round(H * DPR));
  markMap();
}
new ResizeObserver(resizeMap).observe($('#mapWrap'));
cv.addEventListener('mousemove', (e) => { const r = cv.getBoundingClientRect(); mouse = { x: e.clientX - r.left, y: e.clientY - r.top }; markMap(); });
cv.addEventListener('mouseleave', () => { mouse = null; $('#mapCoord').textContent = ''; markMap(); });

function targetView() {
  const pts = [];
  for (const b of S.bots) if (b.pos) pts.push([b.pos.x, b.pos.z]);
  for (const w of S.waypoints) pts.push([w.x, w.z]);
  for (const b of S.bots) for (const p of (S.trails[b.name] || []).slice(-120)) pts.push([p.x, p.z]);
  if (!pts.length) pts.push([-32, -32], [32, 32]);
  let minx = Infinity, maxx = -Infinity, minz = Infinity, maxz = -Infinity;
  for (const [x, z] of pts) { minx = Math.min(minx, x); maxx = Math.max(maxx, x); minz = Math.min(minz, z); maxz = Math.max(maxz, z); }
  const cx = (minx + maxx) / 2, cz = (minz + maxz) / 2;
  const span = 56;
  const sx = Math.max(maxx - minx, span) * 1.3, sz = Math.max(maxz - minz, span) * 1.3;
  const scale = Math.min(W / sx, H / sz);
  return { cx, cz, scale };
}
function niceStep(minPx, scale) {
  for (const s of [1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1024, 2048, 4096]) if (s * scale >= minPx) return s;
  return 8192;
}
function drawMap() {
  raf = 0;
  if (!W || !H) return;
  const tv = targetView();
  if (!view) view = { ...tv };
  const k = 0.18;
  view.cx += (tv.cx - view.cx) * k; view.cz += (tv.cz - view.cz) * k; view.scale += (tv.scale - view.scale) * k;
  const settled = Math.abs(tv.cx - view.cx) < 0.02 && Math.abs(tv.cz - view.cz) < 0.02 && Math.abs(tv.scale - view.scale) / tv.scale < 0.002;
  const sx = (x) => W / 2 + (x - view.cx) * view.scale, sy = (z) => H / 2 + (z - view.cz) * view.scale;
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  ctx.clearRect(0, 0, W, H);
  // grid
  const step = niceStep(46, view.scale);
  const x0 = Math.floor((view.cx - W / 2 / view.scale) / step) * step, x1 = view.cx + W / 2 / view.scale;
  const z0 = Math.floor((view.cz - H / 2 / view.scale) / step) * step, z1 = view.cz + H / 2 / view.scale;
  ctx.lineWidth = 1; ctx.font = '10px Cascadia Mono, Consolas, monospace'; ctx.textBaseline = 'top';
  for (let x = x0; x <= x1; x += step) {
    const px = Math.round(sx(x)) + 0.5;
    ctx.strokeStyle = x === 0 ? '#ffb54755' : x % (step * 4) === 0 ? '#243044' : '#161d29';
    ctx.beginPath(); ctx.moveTo(px, 0); ctx.lineTo(px, H); ctx.stroke();
    ctx.fillStyle = '#4b5567'; ctx.textAlign = 'left'; ctx.fillText(String(x), px + 3, 3);
  }
  for (let z = z0; z <= z1; z += step) {
    const py = Math.round(sy(z)) + 0.5;
    ctx.strokeStyle = z === 0 ? '#ffb54755' : z % (step * 4) === 0 ? '#243044' : '#161d29';
    ctx.beginPath(); ctx.moveTo(0, py); ctx.lineTo(W, py); ctx.stroke();
    ctx.fillStyle = '#4b5567'; ctx.textAlign = 'left'; ctx.fillText(String(z), 4, py + 3);
  }
  // scale bar
  const bar = niceStep(60, view.scale);
  ctx.strokeStyle = '#7c8799'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(W - 14 - bar * view.scale, H - 16); ctx.lineTo(W - 14, H - 16); ctx.stroke();
  ctx.fillStyle = '#7c8799'; ctx.textAlign = 'right'; ctx.textBaseline = 'bottom'; ctx.fillText(bar + ' blocks', W - 14, H - 20);
  // trails
  for (const b of S.bots) {
    const tr = S.trails[b.name] || [];
    if (tr.length < 2) continue;
    const c = color(b.name);
    ctx.lineWidth = 2; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    for (let i = 1; i < tr.length; i++) {
      ctx.strokeStyle = c + Math.round(18 + 150 * (i / tr.length)).toString(16).padStart(2, '0');
      ctx.beginPath(); ctx.moveTo(sx(tr[i - 1].x), sy(tr[i - 1].z)); ctx.lineTo(sx(tr[i].x), sy(tr[i].z)); ctx.stroke();
    }
  }
  // waypoints
  ctx.textBaseline = 'middle';
  for (const w of S.waypoints) {
    const x = sx(w.x), y = sy(w.z);
    ctx.fillStyle = '#ffb547'; ctx.strokeStyle = '#0a0d13'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(x, y - 6); ctx.lineTo(x + 6, y); ctx.lineTo(x, y + 6); ctx.lineTo(x - 6, y); ctx.closePath(); ctx.stroke(); ctx.fill();
    ctx.font = '11px "Segoe UI", sans-serif'; ctx.textAlign = 'center'; ctx.lineWidth = 3; ctx.strokeStyle = '#0a0d13e0'; ctx.strokeText(w.name, x, y + 16); ctx.fillStyle = '#ffd08a'; ctx.fillText(w.name, x, y + 16);
  }
  // bots
  const t = performance.now() / 700;
  for (const b of S.bots) {
    if (!b.pos) continue;
    const x = sx(b.pos.x), y = sy(b.pos.z), c = color(b.name);
    if (S.selected === b.name) { ctx.strokeStyle = c + '88'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(x, y, 12 + Math.sin(t) * 1.5, 0, 7); ctx.stroke(); }
    if (b.online) {
      const g = ctx.createRadialGradient(x, y, 0, x, y, 16); g.addColorStop(0, c + '55'); g.addColorStop(1, c + '00');
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, 16, 0, 7); ctx.fill();
      ctx.fillStyle = c; ctx.strokeStyle = '#0a0d13'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(x, y, 6, 0, 7); ctx.stroke(); ctx.fill();
    } else {
      ctx.strokeStyle = '#6b7689'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(x, y, 5, 0, 7); ctx.stroke();
    }
    ctx.font = '600 12px "Segoe UI", sans-serif'; ctx.textAlign = 'left'; ctx.lineWidth = 3; ctx.strokeStyle = '#0a0d13e8';
    ctx.strokeText(b.name, x + 11, y - 2); ctx.fillStyle = b.online ? c : '#6b7689'; ctx.fillText(b.name, x + 11, y - 2);
    if (b.currentAction) { ctx.font = '10px Cascadia Mono, Consolas, monospace'; ctx.fillStyle = '#7c8799'; ctx.strokeText(b.currentAction, x + 11, y + 10); ctx.fillText(b.currentAction, x + 11, y + 10); }
  }
  if (!S.bots.some((b) => b.pos) && !S.waypoints.length) { ctx.fillStyle = '#4b5567'; ctx.font = '13px "Segoe UI", sans-serif'; ctx.textAlign = 'center'; ctx.fillText('waiting for agents…', W / 2, H / 2); }
  if (mouse) {
    const wx = Math.round(view.cx + (mouse.x - W / 2) / view.scale), wz = Math.round(view.cz + (mouse.y - H / 2) / view.scale);
    $('#mapCoord').textContent = `x ${wx}  z ${wz}`;
  }
  dirty = false;
  if (!settled) raf = requestAnimationFrame(drawMap);
}

// ---------- boot ----------
function renderAll() { renderGoal(); renderChat(); renderBoard(); renderNotes(); renderWaypoints(); renderBots(); renderStats(); renderChatTo(); renderLogAgents(); markMap(); }
renderGoal(); renderNotes(); renderWaypoints(); renderBoard(); resizeMap();
connect();
