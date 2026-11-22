// BotHandle: one mineflayer bot + action runner + auto modes + observation.
import { EventEmitter } from 'node:events';
import { Vec3 } from 'vec3';
import { StopError, isStop, sleep, r1, fmtPos, getMcData, invCounts, summarizeError } from './util.js';
import { isJunkItem, halt, isHostile, itemEntities, pickupItems, fight, droppedItemName, inventoryFull, gotoGoal, isLiquidName, isSolid, isAirName } from './nav.js';
import { ACTION_DEFS, ACTION_MAP } from './actions.js';

import { DEFAULT_MODES, MODE_NAMES } from './modes.js';
import { installLedger } from './ledger.js';

export class BotHandle extends EventEmitter {
  constructor(bot, { name, host, port, version }) {
    super();
    this.bot = bot;
    this.name = name;
    this.conn = { host, port, version };
    this.mcData = getMcData(version);
    this.online = true;
    this.dead = false;
    this.modes = { ...DEFAULT_MODES };
    this.current = null;      // {name, ac, done}
    this.bg = null;           // background action (follow)
    this.autoBusy = null;     // promise while an auto behaviour is running
    this.autoLabel = null;
    this.lastActionEnd = Date.now();
    this.lastAutoAt = 0;
    this.lastHurtAt = 0;
    this.lastEventAt = {};
    this.lastDeath = null;
    this.ignoreItems = new Set();
    this.itemTries = new Map();
    this.tossZone = null;
    this.fighting = false;
    this.recent = [];
    this._stateCache = null;
    this._interesting = null;
    this._wire();
    this.ledgerCtx = null; // set by the blueprint executor
    try { installLedger(this); } catch (e) { console.error('ledger hook failed:', e?.message || e); }
    this._autoTimer = setInterval(() => { this._autoTick().catch(() => {}); }, 350);
  }

  // ---------- events ----------
  _event(kind, text, throttleMs = 0) {
    const now = Date.now();
    if (throttleMs && now - (this.lastEventAt[kind] || 0) < throttleMs) return;
    this.lastEventAt[kind] = now;
    this.recent.push({ kind, text, ts: now });
    if (this.recent.length > 20) this.recent.shift();
    this.emit('event', { kind, text });
  }

  _wire() {
    const bot = this.bot;
    bot.on('chat', (username, message) => { if (username !== bot.username) this.emit('chat', { username, message }); });
    bot.on('whisper', (username, message) => { if (username !== bot.username) this.emit('chat', { username, message: `(whisper) ${message}` }); });
    bot.on('error', () => { /* hideErrors; connection problems surface via 'end' */ });
    bot.on('kicked', (reason) => {
      let text = reason; try { text = typeof reason === 'string' ? reason : JSON.stringify(reason); } catch { /* */ }
      this._event('kicked', `Kicked from server: ${String(text).slice(0, 200)}`);
    });
    bot.on('end', (reason) => {
      this.online = false;
      clearInterval(this._autoTimer);
      this.stop();
      this.emit('offline', { reason: String(reason || 'disconnected') });
    });
    bot.on('death', () => {
      this.dead = true;
      const p = bot.entity?.position;
      this.lastDeath = p ? { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z), at: Date.now() } : null;
      this.stop();
      this._event('death', `You died${p ? ` at ${fmtPos(p)}` : ''}. Items dropped there (despawn in 5 min). Respawning...`);
      setTimeout(() => { if (this.dead && this.online) { try { bot.respawn(); } catch { /* */ } } }, 2500);
    });
    bot.on('spawn', () => {
      if (this.dead) {
        this.dead = false;
        const p = bot.entity?.position;
        this._event('respawn', `Respawned at ${p ? fmtPos(p) : '?'}${this.lastDeath ? `; your death spot was ${this.lastDeath.x},${this.lastDeath.y},${this.lastDeath.z} (items may still be there)` : ''}. Inventory is empty.`);
      }
    });
    bot.on('health', () => {
      if (bot.health < (this._lastHealth ?? 20) && !this.dead) {
        this.lastHurtAt = Date.now();
        const near = this._nearestHostile(8);
        this._event('hurt', `Took damage, health ${r1(bot.health)}/20${near ? `; nearest hostile: ${near.name} ${r1(near.dist)} blocks away` : ''}`, 4000);
      }
      this._lastHealth = bot.health;
      if (bot.food <= 6 && bot.food < (this._lastFood ?? 20)) this._event('low_food', `Hungry (food ${bot.food}/20). Eat something (eat) or find food.`, 60000);
      this._lastFood = bot.food;
      if (bot.health <= 6 && bot.health > 0) this._event('low_health', `Low health ${r1(bot.health)}/20. Retreat, eat, or sleep.`, 30000);
    });
    bot.on('time', () => {
      const t = bot.time.timeOfDay;
      const night = t >= 13000 && t < 23000;
      if (night && !this._wasNight) this._event('night_fell', 'Night has fallen; hostile mobs spawn in the dark. Stay lit/inside or sleep in a bed.');
      if (!night && this._wasNight) this._event('day_broke', 'Day has broken.');
      this._wasNight = night;
    });
    bot.on('entitySpawn', (e) => {
      const z = this.tossZone;
      if (e.name === 'item' && z && Date.now() < z.until && e.position.distanceTo(z.pos) < 8) this.ignoreItems.add(e.id);
    });
    bot.on('playerCollect', (collector, collected) => {
      if (collector === bot.entity && !this.current && this.autoLabel === 'pickup') { /* summarised by auto pickup */ }
    });
  }

  // ---------- observation ----------
  _interestingIds() {
    if (this._interesting) return this._interesting;
    const reg = this.bot.registry;
    const names = reg.blocksArray.map((b) => b.name).filter((n) =>
      (/_log$/.test(n) && !n.startsWith('stripped_')) || /_ore$/.test(n) || n === 'ancient_debris' ||
      /^(crafting_table|furnace|blast_furnace|smoker|chest|trapped_chest|barrel|ender_chest|water|lava|spawner|obsidian|sugar_cane|wheat|melon|pumpkin|anvil|enchanting_table|brewing_stand|nether_portal|bookshelf|cactus|sweet_berry_bush)$/.test(n) ||
      /_bed$/.test(n));
    this._interesting = { names, ids: names.map((n) => reg.blocksByName[n].id) };
    return this._interesting;
  }

  nearbyBlocks(radius = 16, count = 400) {
    const { ids } = this._interestingIds();
    const bot = this.bot;
    const me = bot.entity.position;
    const found = bot.findBlocks({ matching: ids, maxDistance: radius, count });
    const out = {};
    for (const p of found) {
      const b = bot.blockAt(p);
      if (!b) continue;
      if (b.name === 'water' && out.water?.count > 40) continue;
      const d = p.distanceTo(me);
      const e = out[b.name] || (out[b.name] = { count: 0, nearest: { x: p.x, y: p.y, z: p.z }, _d: d });
      e.count++;
      if (d < e._d) { e._d = d; e.nearest = { x: p.x, y: p.y, z: p.z }; }
    }
    for (const k of Object.keys(out)) delete out[k]._d;
    return out;
  }

  _nearestHostile(maxD = 8) {
    const me = this.bot.entity?.position; if (!me) return null;
    let best = null;
    for (const e of Object.values(this.bot.entities)) {
      if (!isHostile(this.bot, e)) continue;
      const d = e.position.distanceTo(me);
      if (d <= maxD && (!best || d < best.dist)) best = { name: e.name, dist: d, e };
    }
    return best;
  }

  nearbyEntities(radius = 24, limit = 12) {
    const bot = this.bot;
    const me = bot.entity.position;
    const list = [];
    const items = new Map();
    for (const e of Object.values(bot.entities)) {
      if (e === bot.entity || !e.position) continue;
      const d = e.position.distanceTo(me);
      if (d > radius) continue;
      if (e.name === 'item') {
        const di = droppedItemName(bot, e);
        const cur = items.get(di.name);
        if (!cur || d < cur.distance) items.set(di.name, { type: 'item', name: di.name, count: (cur?.count || 0) + (di.count || 1), distance: r1(d), pos: { x: Math.floor(e.position.x), y: Math.floor(e.position.y), z: Math.floor(e.position.z) } });
        else cur.count += di.count || 1;
        continue;
      }
      let type = 'other';
      if (e.type === 'player') type = 'player';
      else if (e.type === 'hostile') type = 'hostile';
      else if (e.type === 'animal' || e.type === 'passive' || e.type === 'mob') type = 'animal';
      else if (e.type === 'ambient' || e.name === 'experience_orb' || e.type === 'orb' || e.type === 'projectile') continue;
      else if (d > 10) continue;
      list.push({ type, name: type === 'player' ? e.username : (e.name || e.type), distance: r1(d), pos: { x: Math.floor(e.position.x), y: Math.floor(e.position.y), z: Math.floor(e.position.z) } });
    }
    const rank = { hostile: 0, player: 1, animal: 2, other: 3 };
    list.sort((a, b) => rank[a.type] - rank[b.type] || a.distance - b.distance);
    return [...list.slice(0, limit), ...[...items.values()].sort((a, b) => a.distance - b.distance).slice(0, 4)];
  }

  getState() {
    const bot = this.bot;
    const now = Date.now();
    if (!this.online || !bot.entity) {
      return { name: this.name, online: false, dead: this.dead, currentAction: null, modes: { ...this.modes } };
    }
    if (!this._stateCache || now - this._stateCache.t > 1500) {
      let nb = {};
      try { nb = this.nearbyBlocks(16); } catch { /* */ }
      this._stateCache = { t: now, nearbyBlocks: nb };
    }
    const p = bot.entity.position;
    const dim = String(bot.game?.dimension || 'overworld').replace('minecraft:', '').replace('the_', '');
    let biome = null;
    try { const b = bot.blockAt(p); biome = b?.biome?.name || null; } catch { /* */ }
    const slot = (i) => bot.inventory.slots[i]?.name || null;
    const inv = [...invCounts(bot)].map(([name, count]) => ({ name, count }));
    return {
      name: this.name, online: true, dead: this.dead,
      pos: { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) },
      dimension: dim === 'nether' ? 'nether' : dim,
      health: r1(bot.health ?? 20), food: bot.food ?? 20,
      time: { timeOfDay: bot.time?.timeOfDay ?? 0, isDay: bot.time?.isDay ?? true },
      biome, held: bot.heldItem?.name || null,
      inventory: inv, armor: [slot(5), slot(6), slot(7), slot(8)],
      nearbyEntities: this.nearbyEntities(),
      nearbyBlocks: this._stateCache.nearbyBlocks,
      currentAction: this.current?.name || this.bg?.name || (this.autoLabel ? `auto:${this.autoLabel}` : null),
      modes: { ...this.modes },
      warnings: this.warnings(),
      ...(this.lastDeath ? { lastDeath: { x: this.lastDeath.x, y: this.lastDeath.y, z: this.lastDeath.z } } : {}),
    };
  }

  /** Short survival warnings the model should act on (shown after every action result). */
  warnings() {
    const bot = this.bot, out = [];
    try {
      const items = bot.inventory.items();
      const foods = items.filter((i) => this.mcData.foodsByName[i.name] && !/rotten_flesh|spider_eye|poisonous_potato|pufferfish/.test(i.name));
      const foodCount = foods.reduce((a, i) => a + i.count, 0);
      const food = bot.food ?? 20;
      if (food <= 8) out.push(foodCount ? `HUNGRY (food ${food}): eat now` : `HUNGRY (food ${food}) and NO FOOD: get food from base_chest or a teammate before anything else`);
      else if (!foodCount && bot.entity.position.y < 50) out.push('no food in inventory while underground: bring 8+ cooked food next trip');
      if ((bot.health ?? 20) <= 8) out.push(`LOW HEALTH (${r1(bot.health)}): retreat, eat, rest`);
      for (const it of items.concat(bot.heldItem ? [] : [])) {
        if (!/_(pickaxe|axe|shovel|sword)$/.test(it.name) || !it.maxDurability) continue;
        const left = it.maxDurability - (it.durabilityUsed || 0);
        if (left <= Math.max(8, it.maxDurability * 0.15)) out.push(`${it.name} almost broken (${left} uses left): craft a spare now`);
      }
      if (!items.some((i) => /_pickaxe$/.test(i.name))) out.push('no pickaxe: craft one (sticks + planks/cobble/iron) before mining');
    } catch { /* warnings are best-effort; never break getState */ }
    return out;
  }

  // ---------- actions ----------
  _makeCtx(signal, { auto = false, timedOut } = {}) {
    const h = this;
    let rejectAbort;
    const abortP = new Promise((_, rej) => { rejectAbort = rej; });
    abortP.catch(() => {});
    const onAbort = () => rejectAbort(new StopError(timedOut?.() ? 'Timed out' : 'Stopped'));
    if (signal.aborted) onAbort(); else signal.addEventListener('abort', onAbort, { once: true });
    const ctx = {
      h, bot: this.bot, mcData: this.mcData, signal, auto,
      log: [],
      throwIfAborted() { if (signal.aborted) throw new StopError(timedOut?.() ? 'Timed out' : 'Stopped'); },
      race(p) { return Promise.race([p, abortP]); },
      sleep(ms) { return sleep(ms, signal); },
      async checkpoint() {
        // Always yield one macrotask: a loop that only awaits resolved promises starves the worker's
        // event loop, the bot stops answering keep-alives and the server kicks it ("Timed out").
        await new Promise((r) => setImmediate(r));
        if (auto) return;
        while (h.autoBusy) { await ctx.race(h.autoBusy.catch(() => {})); }
        ctx.throwIfAborted();
      },
      deadline(ms) { const end = Date.now() + ms; return { left: () => end - Date.now(), expired: () => Date.now() >= end }; },
    };
    return ctx;
  }

  async run(actionName, args = {}, { signal } = {}) {
    const def = ACTION_MAP.get(actionName);
    if (!def) throw new Error(`Unknown action "${actionName}". Available: ${ACTION_DEFS.map((a) => a.name).join(', ')}`);
    if (!this.online) throw new Error('Bot is offline (disconnected from the Minecraft server); wait for reconnect.');
    if (this.dead) {
      for (let i = 0; i < 20 && this.dead; i++) await sleep(250);
      if (this.dead) throw new Error('You are dead and respawning; try again in a few seconds.');
    }
    if (def.name !== 'stop' && !def.quick) {
      if (this.current) {
        this._abortCurrent();
        await Promise.race([this.current?.done, sleep(4000)]).catch(() => {});
      }
      if (this.bg) this._stopBg();
    }
    const ac = new AbortController();
    const outer = signal;
    const onOuter = () => ac.abort();
    if (outer) { if (outer.aborted) throw new StopError('Stopped'); outer.addEventListener('abort', onOuter, { once: true }); }
    let timedOut = false;
    const limit = def.timeoutMs ?? 170000;
    const timer = setTimeout(() => { timedOut = true; ac.abort(); }, limit);
    const ctx = this._makeCtx(ac.signal, { timedOut: () => timedOut });
    let doneResolve; const done = new Promise((r) => { doneResolve = r; });
    const rec = { name: def.name, ac, done };
    if (!def.quick) this.current = rec;
    try {
      const norm = this._normalizeArgs(def, args);
      const res = await def.run(ctx, norm);
      if (typeof res === 'string') return res;
      if (res === undefined) return 'Done.';
      // raw / rich results (viewer snapshots, {text, view} image requests) pass through untouched
      if (def.rawResult || (res && typeof res === 'object' && typeof res.text === 'string')) return res;
      return JSON.stringify(res);
    } catch (e) {
      if (isStop(e) || ac.signal.aborted) {
        halt(this.bot);
        if (timedOut && typeof ctx.partial === 'function') { try { return ctx.partial(); } catch { /* */ } }
        const why = timedOut ? `Timed out after ${Math.round(limit / 1000)}s (the action was cancelled; check status for progress).${def.name === 'goto' && this.bot.entity && this.bot.entity.position.y < 50 ? ' You are underground: call surface to climb straight out, then goto.' : ''}` : 'Stopped';
        throw new Error(why);
      }
      throw new Error(this._friendly(e));
    } finally {
      clearTimeout(timer);
      outer?.removeEventListener('abort', onOuter);
      if (!def.quick) {
        if (this.current === rec) { this.current = null; this.lastActionEnd = Date.now(); }
        if (!def.background) { try { this.bot.clearControlStates(); } catch { /* */ } }
      }
      doneResolve();
    }
  }

  _normalizeArgs(def, args) {
    const a = { ...(args || {}) };
    const props = def.params?.properties || {};
    for (const [k, spec] of Object.entries(props)) {
      if (a[k] === undefined || a[k] === null) { delete a[k]; continue; }
      if (spec.type === 'integer' || spec.type === 'number') {
        const n = Number(a[k]);
        if (Number.isNaN(n)) throw new Error(`Argument "${k}" must be a number, got ${JSON.stringify(a[k])}.`);
        a[k] = spec.type === 'integer' ? Math.round(n) : n;
      }
      if (spec.type === 'boolean' && typeof a[k] === 'string') a[k] = a[k] === 'true';
    }
    for (const r of def.params?.required || []) {
      if (a[r] === undefined) throw new Error(`Missing required argument "${r}" for ${def.name}. Expected: ${JSON.stringify(def.params.properties)}`);
    }
    return a;
  }

  _friendly(e) {
    const m = e?.message || String(e);
    if (/Event .* did not fire within timeout/.test(m)) return `${m}. (The server did not respond in time - are you in range / is the target still there?)`;
    return summarizeError(e);
  }

  _abortCurrent() {
    if (this.current) { try { this.current.ac.abort(); } catch { /* */ } }
    halt(this.bot);
  }

  _stopBg() {
    if (this.bg) { try { this.bg.ac.abort(); } catch { /* */ } this.bg = null; }
    halt(this.bot);
  }

  /** start a background action (follow). */
  startBackground(name, fn) {
    const ac = new AbortController();
    const ctx = this._makeCtx(ac.signal);
    const rec = { name, ac };
    this.bg = rec;
    Promise.resolve().then(() => fn(ctx)).catch((e) => {
      if (!isStop(e) && this.bg === rec) this._event('action_ended', `${name} ended: ${summarizeError(e)}`);
    }).finally(() => { if (this.bg === rec) this.bg = null; halt(this.bot); });
  }

  stop() {
    this._abortCurrent();
    this._stopBg();
    try { this.autoCtxAc?.abort(); } catch { /* */ }
    try { this.bot.autoEat?.cancelEat?.(); } catch { /* */ }
  }

  quit() {
    this.online = false;
    clearInterval(this._autoTimer);
    this.stop();
    try { this.bot.quit(); } catch { /* */ }
  }

  setMode(mode, on) {
    if (!(mode in DEFAULT_MODES)) throw new Error(`Unknown mode "${mode}". Modes: ${MODE_NAMES.join(', ')}`);
    this.modes[mode] = !!on;
    if (mode === 'auto_eat') { try { on ? this.bot.autoEat.enableAuto() : this.bot.autoEat.disableAuto(); } catch { /* */ } }
    return `Mode ${mode} is now ${on ? 'ON' : 'OFF'}. Modes: ${JSON.stringify(this.modes)}`;
  }

  // ---------- auto behaviours ----------
  _startAuto(label, fn) {
    if (this.autoBusy) return;
    this.autoLabel = label;
    if (this.current || this.bg) halt(this.bot);
    const ac = new AbortController();
    this.autoCtxAc = ac;
    const ctx = this._makeCtx(ac.signal, { auto: true });
    const guard = setTimeout(() => ac.abort(), 25000);
    this.autoBusy = (async () => { try { await fn(ctx); } catch { /* */ } })().finally(() => {
      clearTimeout(guard);
      this.autoBusy = null; this.autoLabel = null; this.lastAutoAt = Date.now(); this.autoCtxAc = null;
      try { this.bot.clearControlStates(); } catch { /* */ }
    });
  }

  async _autoTick() {
    const bot = this.bot;
    if (!this.online || this.dead || this.autoBusy || !bot.entity) return;
    const now = Date.now();
    if (this.modes.avoid_hazards) {
      const hz = this._hazard();
      if (hz) return this._startAuto('hazard', (ctx) => this._escapeHazard(ctx, hz));
    }
    const busy = !!this.current;
    if (this.windowBusy) return; // crafting/smelting clicks in progress: don't move items or swap the held item now
    if (this.modes.self_defense && !this.fighting && now >= (this.defendCooldown || 0)) {
      const hurtRecently = now - this.lastHurtAt < 2500;
      const near = this._nearestHostile(busy ? (hurtRecently ? 6 : 3.2) : 8);
      if (near && !bot.entity.isInWater) {
        return this._startAuto('self_defense', async (ctx) => {
          this._event('combat', `Fighting ${near.name} (${r1(near.dist)} blocks away).`, 5000);
          const reason = await fight(ctx, near.e, { maxMs: 20000, minHealth: 4 });
          if (reason === 'low_health') this._event('low_health', `Health ${r1(bot.health)} while fighting ${near.name}; stopped fighting. Retreat/eat/heal!`, 10000);
          if (reason !== 'dead') this.defendCooldown = Date.now() + 3000;
        });
      }
    }
    if (!busy && !this.bg && this.modes.pickup_items && now - this.lastActionEnd > 1500 && now - this.lastAutoAt > 400 && !inventoryFull(bot)) {
      const items = itemEntities(bot, 8, this.ignoreItems).filter((e) => (this.itemTries.get(e.id) || 0) < 2 && e.position.y > bot.entity.position.y - 6 && !isJunkItem(bot, droppedItemName(bot, e).name));
      if (items.length) {
        const e = items[0];
        this.itemTries.set(e.id, (this.itemTries.get(e.id) || 0) + 1);
        return this._startAuto('pickup', async (ctx) => {
          const before = invCounts(bot);
          await pickupItems(ctx, { radius: 8, maxMs: 7000 });
          const after = invCounts(bot);
          const gained = [];
          for (const [n, c] of after) { const d = c - (before.get(n) || 0); if (d > 0) gained.push(`${d} ${n}`); }
          if (gained.length) this._event('item_picked_up', `Picked up ${gained.join(', ')}.`);
          else if (itemEntities(bot, 3).length === 0) this.itemTries.delete(e.id);
        });
      }
    }
  }

  _hazard() {
    const bot = this.bot;
    const p = bot.entity.position;
    const feet = bot.blockAt(p.floored());
    if (feet && (feet.name === 'lava' || feet.name === 'fire' || feet.name === 'soul_fire' || feet.name === 'magma_block')) return 'fire';
    if (bot.entity.onFire && !feet?.name?.includes('water')) return 'burning';
    const head = bot.blockAt(p.offset(0, 1.6, 0));
    if (head && head.name === 'water' && typeof bot.oxygenLevel === 'number' && bot.oxygenLevel < 9) return 'drown';
    return null;
  }

  async _escapeHazard(ctx, kind) {
    const bot = this.bot;
    this._event('hazard', kind === 'drown' ? 'Drowning risk: swimming up for air.' : 'Standing in lava/fire: escaping!', 8000);
    const t0 = Date.now();
    const safe = () => {
      const p = bot.entity.position.floored();
      let best = null;
      for (let dx = -6; dx <= 6; dx++) for (let dz = -6; dz <= 6; dz++) for (let dy = -2; dy <= 3; dy++) {
        const c = p.offset(dx, dy, dz);
        const b = bot.blockAt(c), below = bot.blockAt(c.offset(0, -1, 0)), up = bot.blockAt(c.offset(0, 1, 0));
        if (!b || !below || !up) continue;
        const okFeet = isAirName(b.name) && isAirName(up.name);
        if (!okFeet || !isSolid(below) || below.name === 'magma_block' || below.name === 'cactus') continue;
        const d = Math.abs(dx) + Math.abs(dz) + Math.abs(dy) * 1.5;
        if (!best || d < best.d) best = { c, d };
      }
      return best?.c;
    };
    while (Date.now() - t0 < 9000) {
      ctx.throwIfAborted();
      const kindNow = this._hazard();
      if (!kindNow) break;
      const tgt = safe();
      if (tgt) {
        await bot.lookAt(tgt.offset(0.5, 1, 0.5), true).catch(() => {});
        bot.setControlState('forward', true); bot.setControlState('sprint', true);
      }
      bot.setControlState('jump', true);
      await sleep(250, ctx.signal);
    }
    bot.clearControlStates();
  }
}
