// Tiny fake of the SPEC bridge (section 2) for testing mcp/ and crew/ without Minecraft.
//   node test/mcp-mock-bridge.mjs [port=47969]
import http from 'node:http';

export const ACTIONS = [
  { name: 'goto', description: 'Walk to x,y,z.', params: { type: 'object', properties: { x: { type: 'integer' }, y: { type: 'integer' }, z: { type: 'integer' }, range: { type: 'integer' } }, required: ['x', 'y', 'z'] } },
  { name: 'collect', description: 'Collect blocks of a type.', params: { type: 'object', properties: { block: { type: 'string' }, count: { type: 'integer' } }, required: ['block', 'count'] } },
  { name: 'craft', description: 'Craft an item.', params: { type: 'object', properties: { item: { type: 'string' }, count: { type: 'integer' } }, required: ['item'] } },
  { name: 'wait', description: 'Wait N seconds.', params: { type: 'object', properties: { seconds: { type: 'number' } }, required: ['seconds'] } },
  { name: 'stop', description: 'Stop the current action.', params: { type: 'object', properties: {} } },
];

export function startMock(port = 47969) {
  const S = { bots: {}, msgs: [], nextMsg: 1, board: [], nextTask: 1, notes: {}, waypoints: {}, memory: {}, goal: '', logs: [], acts: [] };
  const waiters = [];
  const send = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
  const visible = (name, since) => S.msgs.filter(m => m.id > since && m.from !== name && (m.to === 'all' || m.to === name));
  const state = n => ({ name: n, online: true, pos: { x: 1, y: 64, z: 2 }, dimension: 'overworld', health: 20, food: 18, time: { timeOfDay: 6000, isDay: true }, held: 'stone_pickaxe', inventory: [{ name: 'oak_log', count: 7 }], currentAction: null });
  const wake = () => { for (const w of waiters.splice(0)) w(); };

  const server = http.createServer((req, res) => {
    let body = ''; req.on('data', c => body += c);
    req.on('end', () => {
      const u = new URL(req.url, 'http://x'); const p = u.pathname.split('/').filter(Boolean);
      let b = {}; try { b = body ? JSON.parse(body) : {}; } catch { /* */ }
      const m = req.method;
      if (m === 'GET' && p[0] === 'health') return send(res, 200, { ok: true });
      if (m === 'GET' && p[0] === 'actions') return send(res, 200, ACTIONS);
      if (p[0] === 'bots') {
        if (m === 'POST' && !p[1]) { S.bots[b.name] = { name: b.name, role: b.role }; return send(res, 200, S.bots[b.name]); }
        if (m === 'GET' && !p[1]) return send(res, 200, Object.values(S.bots).map(x => ({ ...x, online: true, pos: { x: 1, y: 64, z: 2 }, health: 20, food: 18, currentAction: null })));
        if (m === 'DELETE') { delete S.bots[p[1]]; return send(res, 200, { ok: true }); }
        if (m === 'GET' && p[2] === 'state') return send(res, 200, { ...state(p[1]), recentEvents: [] });
        if (m === 'POST' && p[2] === 'stop') { S.acts.push({ bot: p[1], action: 'STOP' }); return send(res, 200, { ok: true }); }
        if (m === 'POST' && p[2] === 'act') {
          S.acts.push({ bot: p[1], ...b });
          if (b.action === 'goto' && b.args.x === 999) return send(res, 200, { ok: false, error: 'busy: collect' });
          if (b.action === 'collect' && b.args.block === 'diamond_ore') return send(res, 200, { ok: false, error: 'No diamond_ore within 64 blocks.' });
          return send(res, 200, { ok: true, result: `OK ${b.action} ${JSON.stringify(b.args)}` });
        }
      }
      if (p[0] === 'msg') {
        if (m === 'POST') { const msg = { id: S.nextMsg++, from: b.from, to: b.to || 'all', text: b.text, ts: Date.now() }; S.msgs.push(msg); wake(); return send(res, 200, msg); }
        if (m === 'GET') {
          const since = +u.searchParams.get('since') || 0, wait = Math.min(60, +u.searchParams.get('wait') || 0);
          const reply = () => { const ms = visible(p[1], since); send(res, 200, { messages: ms, cursor: ms.length ? ms[ms.length - 1].id : since }); };
          if (visible(p[1], since).length || !wait) return reply();
          const t = setTimeout(() => { const i = waiters.indexOf(f); if (i >= 0) waiters.splice(i, 1); reply(); }, wait * 1000);
          const f = () => { clearTimeout(t); reply(); }; waiters.push(f); return;
        }
      }
      if (m === 'GET' && p[0] === 'unread') return send(res, 200, { count: visible(p[1], +u.searchParams.get('since') || 0).length });
      if (p[0] === 'board') {
        if (m === 'GET') return send(res, 200, S.board);
        if (m === 'POST' && !p[1]) { const t = { id: S.nextTask++, title: b.title, detail: b.detail, status: 'open', owner: null, priority: b.priority ?? 3, by: b.by, notes: [], updated: Date.now() }; S.board.push(t); return send(res, 200, t); }
        const t = S.board.find(x => x.id === +p[1]); if (!t) return send(res, 404, { error: 'no such task' });
        if (p[2] === 'claim') { if (t.owner && t.owner !== b.by) return send(res, 409, { error: `already claimed by ${t.owner}` }); t.owner = b.by; t.status = 'claimed'; return send(res, 200, t); }
        if (b.status) t.status = b.status; if (b.note) t.notes.push(`${b.by}: ${b.note}`); if (b.owner) t.owner = b.owner; return send(res, 200, t);
      }
      if (p[0] === 'notes') { if (m === 'POST') { S.notes[b.key] = { by: b.by, text: b.text }; return send(res, 200, { ok: true }); } return send(res, 200, Object.entries(S.notes).map(([key, v]) => ({ key, ...v }))); }
      if (p[0] === 'waypoints') { if (m === 'POST') { S.waypoints[b.name] = b; return send(res, 200, { ok: true }); } return send(res, 200, Object.values(S.waypoints)); }
      if (p[0] === 'memory') { if (m === 'POST') { S.memory[p[1]] = b.text; return send(res, 200, { ok: true }); } return send(res, 200, { text: S.memory[p[1]] || '' }); }
      if (p[0] === 'goal') { if (m === 'POST') { S.goal = b.text; return send(res, 200, { ok: true }); } return send(res, 200, { text: S.goal }); }
      if (m === 'POST' && p[0] === 'log') { S.logs.push({ name: p[1], ...b }); return send(res, 200, { ok: true }); }
      if (m === 'GET' && p[0] === '_debug') return send(res, 200, S);
      send(res, 404, { error: `mock: no route ${m} ${u.pathname}` });
    });
  });
  return new Promise(r => server.listen(port, '127.0.0.1', () => r({ server, S, port, close: () => server.close() })));
}

if (import.meta.url === `file:///${process.argv[1].replace(/\\/g, '/')}`) {
  const port = +(process.argv[2] || 47969);
  await startMock(port);
  console.log(`mock bridge on http://127.0.0.1:${port}  (GET /_debug dumps state)`);
}
