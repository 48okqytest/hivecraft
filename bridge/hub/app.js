// HTTP API + SSE + static dashboard. createApp() is used by bridge/server.js and by tests.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from './store.js';
import { BotManager } from './botmanager.js';
import { rcon } from './rcon.js';
import { attachViewer } from './viewer-routes.js';
import { attachModApi } from './mod-api.js';
import { Economy, attachEconRoutes } from './economy.js';
import { Earnings, attachEarnRoutes } from './earnings.js';
import { HttpError, needName, validName, clamp, str, log, logErr, num } from './util.js';
import { loadConfig, isPlayerName, econPlayers } from '../config.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.resolve(HERE, '..', 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.woff2': 'font/woff2' };

// player = {displayName, mcName} of the human (default: hivecraft.config.json via bridge/config.js)
export function createApp({ engine, dataDir, port = 47960, host = '127.0.0.1', mc = {}, rconOpts = {}, econOpts = {}, player = null, onShutdown = null } = {}) {
  const cfgPlayer = loadConfig().player;
  const human = { player: { displayName: player?.displayName || cfgPlayer.displayName, mcName: player?.mcName ?? (player?.displayName || cfgPlayer.mcName) } };
  const ME = human.player.displayName; // the human's name on the hub (dashboard, terminal, economy account)
  const rconCall = (cmd) => rcon(cmd, { ...(mc.rconPort ? { port: mc.rconPort } : {}), ...(mc.rconPassword ? { password: mc.rconPassword } : {}), ...rconOpts });
  const store = new Store(dataDir);
  const bots = new BotManager({ engine, store, spawnOpts: { host: mc.host || '127.0.0.1', port: mc.port || 25590, version: mc.version || '1.21.1' } });
  const sse = new Set();

  // ---------- SSE ----------
  function send(res, type, data) {
    res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
  }
  function broadcast(type, data) {
    for (const res of sse) {
      try { send(res, type, data); } catch { sse.delete(res); }
    }
  }
  store.on('change', ({ type, data }) => broadcast(type, data));
  let lastBotsPush = 0;
  let botsPushTimer = null;
  function pushBots() {
    lastBotsPush = Date.now();
    if (sse.size) broadcast('bots', bots.list(true));
  }
  bots.on('bots', () => {
    // coalesce: at most one extra snapshot per 250ms for status/action changes
    if (botsPushTimer || Date.now() - lastBotsPush < 250) return;
    botsPushTimer = setTimeout(() => { botsPushTimer = null; pushBots(); }, 250);
  });
  bots.on('event', (name, ev) => broadcast('bot_event', { name, ...ev }));
  const tick = setInterval(() => {
    try {
      for (const s of bots.slots.values()) {
        if (s.status === 'online' && s.handle && s.handle.online === false) bots._onOffline(s, 'engine reported offline');
      }
      pushBots();
      for (const res of sse) res.write(': ping\n\n');
    } catch (e) {
      logErr('tick:', e.message);
    }
  }, 1000);
  tick.unref?.();

  // ---------- routes ----------
  const routes = [];
  const route = (method, pattern, handler) => {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => (keys.push(k), '([^/]+)')) + '/?$');
    routes.push({ method, re, keys, handler });
  };

  route('GET', '/health', () => ({ ok: true, bots: bots.names().length, uptime: Math.round(process.uptime()), player: ME }));
  // who the human is (hivecraft.config.json player): the dashboard and the overlay mod speak as `name`
  route('GET', '/player', () => ({ name: ME, mc: human.player.mcName || ME }));
  route('GET', '/actions', () => bots.actions);

  route('POST', '/bots', async ({ body }) => {
    const name = needName(body.name, 'bot name');
    const s = await bots.ensure(name, body.role ? str(body.role, 40) : undefined);
    return bots.summary(s, true);
  });
  route('GET', '/bots', () => bots.list(!!0));
  route('DELETE', '/bots/:name', async ({ params }) => {
    await bots.remove(params.name);
    return { ok: true };
  });
  route('GET', '/bots/:name/state', ({ params }) => bots.state(params.name));
  route('POST', '/bots/:name/act', async ({ params, body }) => {
    const out = await bots.act(params.name, { action: body.action, args: body.args, timeoutMs: body.timeoutMs, interrupt: !!body.interrupt });
    modApi.onAct(params.name, body, out); // overlay mod: blueprint_preview ghosts
    return out;
  });
  route('POST', '/bots/:name/stop', async ({ params }) => bots.stop(params.name));

  route('POST', '/msg', ({ body }) => {
    const from = str(body.from, 40).trim();
    if (!from) throw new HttpError(400, 'from is required');
    const m = store.addMessage({ from, to: body.to || 'all', text: body.text });
    const out = { ...m };
    if (bots.has(from)) bots.say(from, m.to, m.text);
    const unknown = m.to === 'all' ? [] : m.to.split(',').filter((n) => !bots.isBotName(n) && !isPlayerName(n, human));
    if (unknown.length) {
      const known = [...new Set([...Object.keys(store.botRoles), ME])];
      out.warning = `no agent named "${unknown.join('", "')}" — nobody will read this. Known: ${known.join(', ')}`;
    }
    return out;
  });
  route('GET', '/msg/:name', async ({ params, query, signal }) => {
    const name = needName(params.name, 'agent name');
    const since = clamp(query.since, 0, Number.MAX_SAFE_INTEGER, 0);
    const wait = clamp(query.wait, 0, 60, 0);
    return store.pollMessages(name, since, wait, signal);
  });
  route('GET', '/unread/:name', ({ params, query }) => ({ count: store.unread(params.name, clamp(query.since, 0, Number.MAX_SAFE_INTEGER, 0)) }));
  route('GET', '/messages', ({ query }) => ({ messages: store.messages.filter((m) => m.id > clamp(query.since, 0, Number.MAX_SAFE_INTEGER, 0)).slice(-clamp(query.limit, 1, 1000, 200)), cursor: store.lastMsgId }));

  // board bounties (earnings.js): a reward escrows the poster's coins first; a change to a task with an open bounty
  // waits for the payout/refund so the reply shows it (`earn` is set below when the economy is on)
  let earn = null;
  const hasReward = (r) => r !== undefined && r !== null && r !== '' && r !== 0 && r !== '0';
  const settled = async (id, t) => { if (earn && earn.hasBounty(id)) await earn.econ.idle(); return t; };
  route('GET', '/board', () => store.tasks);
  route('POST', '/board', ({ body }) => {
    if (!hasReward(body.reward)) return store.addTask(body);
    if (!earn) throw new HttpError(400, 'rewards need the economy, which is turned off for this game');
    return earn.postTask(body);
  });
  route('POST', '/board/:id/claim', ({ params, body }) => settled(params.id, store.claimTask(params.id, body.by)));
  route('POST', '/board/:id', ({ params, body }) => { const had = earn?.hasBounty(params.id); const t = store.updateTask(params.id, body); return had ? earn.econ.idle().then(() => t) : t; });
  route('DELETE', '/board/:id', ({ params }) => { const had = earn?.hasBounty(params.id); const t = store.deleteTask(params.id); return had ? earn.econ.idle().then(() => t) : t; });

  route('GET', '/notes', () => Object.values(store.notes));
  route('POST', '/notes', ({ body }) => store.setNote(body));
  route('DELETE', '/notes/:key', ({ params }) => (store.deleteNote(decodeURIComponent(params.key)), { ok: true }));
  route('GET', '/waypoints', () => Object.values(store.waypoints));
  route('POST', '/waypoints', ({ body }) => store.setWaypoint(body));
  route('DELETE', '/waypoints/:name', ({ params }) => (store.deleteWaypoint(decodeURIComponent(params.name)), { ok: true }));

  route('GET', '/memory/:name', ({ params }) => store.getMemory(params.name));
  route('POST', '/memory/:name', ({ params, body }) => store.setMemory(params.name, body.text ?? ''));
  route('GET', '/goal', () => store.goal);
  route('POST', '/goal', ({ body }) => store.setGoal(body));

  route('POST', '/log/:name', ({ params, body }) => {
    const e = store.addLog(params.name, body.kind, body.text);
    return { ok: true, id: e.id };
  });
  route('GET', '/log/:name', ({ params, query }) => ({ entries: store.getLog(params.name, { since: clamp(query.since, 0, Number.MAX_SAFE_INTEGER, 0), limit: clamp(query.limit, 1, 600, 200) }) }));

  route('POST', '/admin/rcon', async ({ body }) => {
    const cmd = str(body.cmd, 500).trim().replace(/^\//, '');
    if (!cmd) throw new HttpError(400, 'cmd is required');
    try {
      return { ok: true, output: await rconCall(cmd) };
    } catch (e) {
      throw new HttpError(502, e.message);
    }
  });

  route('POST', '/admin/shutdown', () => {
    log('shutdown requested via /admin/shutdown');
    if (!onShutdown) throw new HttpError(501, 'shutdown not supported here');
    setTimeout(() => onShutdown('admin'), 100);
    return { ok: true };
  });

  function snapshot() {
    return {
      bots: bots.list(true),
      messages: store.messages.slice(-250),
      board: store.tasks,
      notes: Object.values(store.notes),
      waypoints: Object.values(store.waypoints),
      goal: store.goal,
      cursor: store.lastMsgId,
      player: { name: ME, mc: human.player.mcName || ME },
    };
  }
  route('GET', '/state', () => snapshot());
  // economy: coins, server shop, market, auctions (bridge/hub/economy.js, MOD_PROTOCOL.md §5); econOpts.rcon = fake RCON in tests
  // HIVE_ECONOMY=0 (Hivecraft.exe "Economy: Off") = no economy at all for this run
  const econOn = econOpts.enabled ?? process.env.HIVE_ECONOMY !== '0';
  const econ = econOn ? new Economy({
    dataDir, propsFile: econOpts.propsFile, catalogFile: econOpts.catalogFile, timers: econOpts.timers,
    rcon: econOpts.rcon || rconCall,
    players: econPlayers(human),
    knownNames: () => [...new Set([...bots.names(), ...Object.keys(store.botRoles)])],
    notify: (to, text) => store.addMessage({ from: 'Market', to, text }),
  }) : null;
  if (econ) {
    attachEconRoutes({ route, econ });
    // ways to earn coins: board bounties, server jobs, mob bounties, milestones, daily wage (earnings.js)
    earn = new Earnings({ econ, store, timers: econOpts.timers, random: econOpts.random,
      botDims: () => Object.fromEntries(bots.list(false).filter((b) => b.online && b.dimension).map((b) => [b.name, b.dimension])) });
    attachEarnRoutes({ route, earn });
  } else {
    log('economy is OFF for this run (HIVE_ECONOMY=0)');
    const off = () => { throw new HttpError(404, 'the economy is turned off for this game (Hivecraft.exe setting)'); };
    for (const m of ['GET', 'POST']) route(m, '/econ/.*', off);
  }
  // world viewer + photo album (bridge/hub/viewer-routes.js)
  // Hivecraft Overlay mod API: ws /mod + /mod/* (bridge/hub/mod-api.js, MOD_PROTOCOL.md)
  const modApi = attachModApi({ route, bots, store, dataDir, port, econ, player: human.player });
  const viewer = attachViewer({ route, bots, store, broadcast: (type, data) => { broadcast(type, data); modApi.onBroadcast(type, data); }, dataDir });

  // ---------- server ----------
  const hostOk = new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);
  function readBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      req.on('data', (c) => {
        size += c.length;
        if (size > 1_000_000) {
          reject(new HttpError(413, 'body too large'));
          req.destroy();
          return;
        }
        chunks.push(c);
      });
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        if (!raw.trim()) return resolve({});
        try {
          const j = JSON.parse(raw);
          resolve(j && typeof j === 'object' ? j : {});
        } catch {
          reject(new HttpError(400, 'invalid JSON body'));
        }
      });
      req.on('error', reject);
    });
  }

  function json(res, status, obj) {
    const data = JSON.stringify(obj);
    if (res.headersSent || res.writableEnded) return;
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(data);
  }

  function serveStatic(req, res, pathname) {
    let rel = decodeURIComponent(pathname);
    if (rel === '/') rel = '/index.html';
    const file = path.normalize(path.join(PUBLIC, rel));
    if (!file.startsWith(PUBLIC)) return json(res, 403, { ok: false, error: 'forbidden' });
    fs.readFile(file, (err, buf) => {
      if (err) return json(res, 404, { ok: false, error: 'not found' });
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      res.end(buf);
    });
  }

  const server = http.createServer(async (req, res) => {
    const ac = new AbortController();
    res.on('close', () => ac.abort());
    try {
      // guard against DNS-rebinding / cross-site requests hitting the local admin API
      if (req.headers.host && !hostOk.has(req.headers.host)) return json(res, 403, { ok: false, error: 'bad Host header' });
      const origin = req.headers.origin;
      if (origin) {
        try {
          if (!hostOk.has(new URL(origin).host)) return json(res, 403, { ok: false, error: 'cross-origin request refused' });
        } catch {
          return json(res, 403, { ok: false, error: 'bad Origin' });
        }
      }
      const url = new URL(req.url, 'http://x');
      const pathname = url.pathname;
      if (req.method === 'GET' && pathname === '/events') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
        res.write('retry: 2000\n\n');
        send(res, 'init', snapshot());
        sse.add(res);
        res.on('close', () => sse.delete(res));
        return;
      }
      if (await viewer.handleRaw(req, res, pathname)) return;
      for (const r of routes) {
        if (r.method !== req.method) continue;
        const m = r.re.exec(pathname);
        if (!m) continue;
        const params = {};
        r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));
        const query = Object.fromEntries(url.searchParams);
        const body = req.method === 'POST' || req.method === 'PUT' ? await readBody(req) : {};
        const out = await r.handler({ params, query, body, req, signal: ac.signal });
        return json(res, 200, out);
      }
      if (req.method === 'GET' || req.method === 'HEAD') {
        if (routes.some((r) => r.re.test(pathname))) return json(res, 405, { ok: false, error: 'method not allowed' });
        return serveStatic(req, res, pathname);
      }
      json(res, routes.some((r) => r.re.test(pathname)) ? 405 : 404, { ok: false, error: `no route ${req.method} ${pathname}` });
    } catch (e) {
      if (e instanceof HttpError) json(res, e.status, { ok: false, error: e.message, ...(e.extra || {}) });
      else {
        logErr(`${req.method} ${req.url} failed:`, e?.stack || e);
        json(res, 500, { ok: false, error: `internal error: ${e?.message || e}` });
      }
    }
  });
  modApi.attach(server);
  server.on('clientError', (err, sock) => {
    try { sock.end('HTTP/1.1 400 Bad Request\r\n\r\n'); } catch {}
  });

  return {
    store,
    bots,
    server,
    modApi,
    econ,
    get earn() { return earn; },
    port,
    start() {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          server.off('error', reject);
          log(`hivecraft bridge listening on http://${host}:${port}  (data: ${dataDir})`);
          resolve();
        });
      });
    },
    async close() {
      clearInterval(tick);
      clearTimeout(botsPushTimer);
      for (const res of sse) { try { res.end(); } catch {} }
      sse.clear();
      try { await viewer.close(); } catch {}
      try { await modApi.close(); } catch {}
      try { econ?.close(); } catch (e) { logErr('economy close:', e.message); }
      await bots.shutdown();
      store.close();
      await new Promise((r) => { server.close(() => r()); server.closeAllConnections?.(); });
    },
  };
}
