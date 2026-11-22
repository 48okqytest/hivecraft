// Hivecraft bridge entry: node bridge/server.js
//   config: hivecraft.config.json (bridge/config.js); env overrides: HIVE_PORT (47960)  HIVE_DATA (<root>/data)
//   HIVE_ENGINE=mock|real  MC_HOST MC_PORT MC_VERSION  (see bridge/config.js for the rest)
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createApp } from './hub/app.js';
import { logErr, log } from './hub/util.js';
import { loadConfig } from './config.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function main() {
  const cfg = loadConfig();
  log(`config: ${cfg.file || '(no hivecraft.config.json, defaults)'}; player ${cfg.player.displayName}${cfg.player.mcName && cfg.player.mcName !== cfg.player.displayName ? ` (${cfg.player.mcName})` : ''}`);
  const useMock = process.env.HIVE_ENGINE === 'mock';
  let engine;
  try {
    // default: one worker thread per bot (smooth movement); HIVE_THREADS=0 = all bots on the main thread
    engine = useMock ? await import(pathToFileURL(path.join(ROOT, 'test', 'hub-mock-engine.mjs')).href)
      : process.env.HIVE_THREADS === '0' ? await import('./engine/index.js') : await import('./engine/threaded.js');
  } catch (e) {
    logErr(`cannot load ${useMock ? 'mock' : 'real'} engine:`, e.message);
    process.exit(1);
  }
  let bye = () => {};
  const app = createApp({
    onShutdown: (why) => bye(why),
    engine,
    dataDir: process.env.HIVE_DATA || path.join(ROOT, 'data'),
    port: cfg.bridge.port,
    mc: { host: cfg.server.host, port: cfg.server.port, version: process.env.MC_VERSION },
  });
  await app.start();
  log(`engine: ${useMock ? 'MOCK' : 'mineflayer'}; actions: ${engine.ACTIONS.length}`);

  let closing = false;
  bye = async (sig) => {
    if (closing) return;
    closing = true;
    log(`${sig}: shutting down`);
    const t = setTimeout(() => process.exit(0), 8000);
    try { await app.close(); } catch (e) { logErr(e.message); }
    clearTimeout(t);
    process.exit(0);
  };
  process.on('SIGINT', () => bye('SIGINT'));
  process.on('SIGTERM', () => bye('SIGTERM'));
}

// a bad bot event must never take the whole bridge (and every agent) down
process.on('uncaughtException', (e) => logErr('uncaughtException:', e?.stack || e));
process.on('unhandledRejection', (e) => logErr('unhandledRejection:', e?.stack || e));

main().catch((e) => {
  logErr('fatal:', e?.stack || e);
  process.exit(1);
});
