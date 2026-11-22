// Fake engine with the same interface as bridge/engine/index.js, for testing the hub without Minecraft.
//   import * as mock from './hub-mock-engine.mjs'  -> mock.ACTIONS, mock.spawnBot, mock.registry (name -> handle)
import { EventEmitter } from 'node:events';

const obj = (properties = {}, required = []) => ({ type: 'object', properties, required });
const int = { type: 'integer' };
export const ACTIONS = [
  { name: 'goto', description: 'Walk to x,y,z', params: obj({ x: int, y: int, z: int, range: int }, ['x', 'y', 'z']) },
  { name: 'collect', description: 'Collect blocks', params: obj({ block: { type: 'string' }, count: int }, ['block', 'count']) },
  { name: 'scan', description: 'Look around', params: obj({ radius: int }) },
  { name: 'craft', description: 'Craft an item', params: obj({ item: { type: 'string' }, count: int }, ['item']) },
  { name: 'wait', description: 'Wait seconds', params: obj({ seconds: { type: 'number' } }, ['seconds']) },
  { name: 'fail', description: 'Mock: always throws', params: obj() },
  { name: 'hang', description: 'Mock: ignores abort for 8s', params: obj() },
  { name: 'stop', description: 'Stop the current action', params: obj() },
];

export const registry = new Map();
export const spawnLog = [];
export const failNextSpawn = { count: 0 };

function abortable(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('Stopped'));
    const t = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(t); reject(new Error('Stopped')); };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

class MockBot extends EventEmitter {
  constructor(name) {
    super();
    this.name = name;
    this.online = true;
    this.chatLog = [];
    this.pos = { x: Math.round(Math.random() * 20), y: 64, z: Math.round(Math.random() * 20) };
    this.inv = { oak_log: 0 };
    this.currentAction = null;
    this.stopped = 0;
    this.bot = { chat: (m) => { this.chatLog.push(m); } };
  }
  getState() {
    return {
      name: this.name, online: this.online, pos: { ...this.pos }, dimension: 'overworld', health: 20, food: 18,
      time: { timeOfDay: 6000, isDay: true }, biome: 'plains', held: 'wooden_pickaxe',
      inventory: Object.entries(this.inv).filter(([, c]) => c > 0).map(([n, c]) => ({ name: n, count: c })),
      armor: [null, null, null, null], nearbyEntities: [{ type: 'hostile', name: 'zombie', distance: 9, pos: this.pos }], nearbyBlocks: {},
      currentAction: this.currentAction, modes: { self_defense: true },
    };
  }
  async run(action, args, { signal } = {}) {
    if (!this.online) throw new Error('offline');
    this.currentAction = action;
    try {
      switch (action) {
        case 'goto':
          await abortable(args.ms ?? 400, signal);
          this.pos = { x: args.x, y: args.y, z: args.z };
          return `Arrived at ${args.x},${args.y},${args.z}.`;
        case 'collect':
          await abortable(args.ms ?? 300, signal);
          this.inv[args.block] = (this.inv[args.block] || 0) + (args.count || 1);
          return `Collected ${args.count || 1} ${args.block} (inventory now ${this.inv[args.block]}).`;
        case 'scan':
          return JSON.stringify({ blocks: { oak_log: 12 }, entities: [] });
        case 'wait':
          await abortable((args.seconds ?? 1) * 1000, signal);
          return `Waited ${args.seconds}s`;
        case 'fail':
          throw new Error('No iron_ore within 64 blocks.');
        case 'hang':
          await new Promise((r) => setTimeout(r, 8000));
          return 'finally done';
        default:
          await abortable(50, signal);
          return `mock ${action} ok`;
      }
    } finally {
      this.currentAction = null;
    }
  }
  stop() { this.stopped++; }
  async quit() { this.online = false; registry.delete(this.name); }

  // ---- test controls ----
  say(username, message) { this.emit('chat', { username, message }); }
  event(kind, text) { this.emit('event', { kind, text }); }
  drop(reason = 'mock kicked') { this.online = false; this.emit('offline', { reason }); }
}

export async function spawnBot({ name, host, port, version } = {}) {
  spawnLog.push({ name, host, port, version, ts: Date.now() });
  await new Promise((r) => setTimeout(r, 20));
  if (failNextSpawn.count > 0) {
    failNextSpawn.count--;
    throw new Error('mock: connection refused');
  }
  const b = new MockBot(name);
  registry.set(name, b);
  return b;
}
