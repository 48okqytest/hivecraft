// Minimal RCON client for tests.
import net from 'node:net';
import { rconOpts } from '../bridge/config.js';
// defaults: hivecraft.config.json server.rconPort / server.rconPassword (bridge/config.js)
export async function rconConnect({ host = rconOpts().host, port = rconOpts().port, password = rconOpts().password } = {}) {
  const sock = net.connect(port, host);
  await new Promise((res, rej) => { sock.once('connect', res); sock.once('error', rej); });
  let buf = Buffer.alloc(0); const waiters = new Map(); let id = 1;
  sock.on('data', (d) => {
    buf = Buffer.concat([buf, d]);
    while (buf.length >= 4) {
      const len = buf.readInt32LE(0); if (buf.length < len + 4) break;
      const rid = buf.readInt32LE(4); const body = buf.toString('utf8', 12, 4 + len - 2);
      buf = buf.subarray(4 + len);
      const w = waiters.get(rid); if (w) { waiters.delete(rid); w(body); }
    }
  });
  const send = (type, body) => new Promise((resolve) => {
    const rid = id++; const b = Buffer.from(body, 'utf8');
    const p = Buffer.alloc(14 + b.length); p.writeInt32LE(10 + b.length, 0); p.writeInt32LE(rid, 4); p.writeInt32LE(type, 8); b.copy(p, 12);
    waiters.set(rid, resolve); sock.write(p);
    setTimeout(() => { if (waiters.delete(rid)) resolve('(rcon timeout)'); }, 5000);
  });
  await send(3, password);
  return { cmd: (c) => send(2, c), close: () => sock.end() };
}
