// Minimal Source-RCON client (Minecraft flavour). One connection per command; plenty for admin use.
import net from 'node:net';
import { rconOpts } from '../config.js';

const T_AUTH = 3;
const T_CMD = 2;

function pack(id, type, body) {
  const b = Buffer.from(body, 'utf8');
  const buf = Buffer.alloc(14 + b.length);
  buf.writeInt32LE(10 + b.length, 0);
  buf.writeInt32LE(id, 4);
  buf.writeInt32LE(type, 8);
  b.copy(buf, 12);
  return buf; // trailing two zero bytes already zeroed
}

// host/port/password default to hivecraft.config.json (server.rconPort / server.rconPassword, see bridge/config.js)
export function rcon(cmd, opts = {}) {
  const d = rconOpts();
  const { host = d.host, port = d.port, password = d.password, timeoutMs = 6000 } = opts;
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host, port });
    let buf = Buffer.alloc(0);
    let authed = false;
    let out = '';
    let done = false;
    let idleTimer = null;
    const CMD_ID = 7;
    const finish = (err, val) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearTimeout(idleTimer);
      try { sock.destroy(); } catch {}
      err ? reject(err) : resolve(val);
    };
    const timer = setTimeout(() => finish(new Error(`rcon timeout after ${timeoutMs}ms (is the server up on ${host}:${port}?)`)), timeoutMs);
    sock.on('error', (e) => finish(new Error(`rcon: ${e.message}`)));
    sock.on('close', () => finish(authed ? null : new Error('rcon connection closed'), out));
    sock.on('connect', () => sock.write(pack(1, T_AUTH, password)));
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      while (buf.length >= 4) {
        const len = buf.readInt32LE(0);
        if (len < 10 || len > 8192) return finish(new Error('rcon: bad packet'));
        if (buf.length < 4 + len) break;
        const id = buf.readInt32LE(4);
        const type = buf.readInt32LE(8);
        const body = buf.subarray(12, 4 + len - 2).toString('utf8');
        buf = buf.subarray(4 + len);
        if (!authed) {
          if (type === 2 || type === 0) {
            if (id === -1) return finish(new Error('rcon: bad password'));
            if (id === 1 && type === 2) {
              authed = true;
              sock.write(pack(CMD_ID, T_CMD, cmd));
            }
          }
        } else if (id === CMD_ID) {
          out += body;
          // long replies come in several 4096-byte packets: wait briefly for more, then finish
          clearTimeout(idleTimer);
          idleTimer = setTimeout(() => finish(null, out), 80);
        }
      }
    });
  });
}
