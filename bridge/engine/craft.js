// Crafting planner/executor, crafting-table + furnace handling, smelting.
import { Vec3 } from 'vec3';
import { isStop, sleep, fmtPos, resolveItemNames, resolveBlockNames, invCounts, countItem, roomFor, fullInventoryHint } from './util.js';
import { gotoPos, placeUtility, isSolid } from './nav.js';

const MAX_DEPTH = 4;
// when a recipe has many variants and none works, report the commonest one
const PREFERRED = new Set(['cobblestone', 'oak_planks', 'oak_log', 'stick', 'iron_ingot', 'diamond', 'coal', 'string', 'leather', 'white_wool', 'gold_ingot']);

function inventoryMapById(bot) {
  const m = new Map();
  for (const it of bot.inventory.items()) m.set(it.type, (m.get(it.type) || 0) + it.count);
  return m;
}
const recipeIngredients = (r) => (r.delta || []).filter((d) => d.count < 0 && d.id !== r.result.id).map((d) => ({ id: d.id, count: -d.count }));

/**
 * Plan how to obtain `need` more of itemId using only the (virtual) inventory.
 * Returns {ok, steps:[{recipe,times,itemId}], missing:Map(id->count)}
 */
function plan(bot, itemId, need, inv, depth, chain) {
  const missingAll = new Map();
  if (depth > MAX_DEPTH || chain.has(itemId)) { missingAll.set(itemId, need); return { ok: false, steps: [], missing: missingAll }; }
  const recipes = bot.recipesAll(itemId, null, true);
  if (!recipes.length) { missingAll.set(itemId, need); return { ok: false, steps: [], missing: missingAll }; }
  // rank recipes by how much of their ingredients we already have
  const scored = recipes.map((r) => {
    const times = Math.ceil(need / r.result.count);
    let short = 0;
    for (const ing of recipeIngredients(r)) short += Math.max(0, ing.count * times - (inv.get(ing.id) || 0));
    if (recipeIngredients(r).some((i) => bot.registry.items[i.id]?.name === 'bamboo')) short += 0.5;
    return { r, times, short };
  }).sort((a, b) => a.short - b.short);
  let bestFail = null;
  const nextChain = new Set(chain); nextChain.add(itemId);
  for (const { r, times } of scored) {
    const trial = new Map(inv);
    const steps = [];
    const missing = new Map();
    let ok = true;
    for (const ing of recipeIngredients(r)) {
      const needed = ing.count * times;
      const have = trial.get(ing.id) || 0;
      if (have < needed) {
        const sub = plan(bot, ing.id, needed - have, trial, depth + 1, nextChain);
        if (!sub.ok) {
          ok = false;
          for (const [k, v] of sub.missing) missing.set(k, (missing.get(k) || 0) + v);
          continue;
        }
        steps.push(...sub.steps);
      }
      trial.set(ing.id, (trial.get(ing.id) || 0) - needed);
    }
    if (ok) {
      for (const d of r.delta || []) if (d.count > 0) trial.set(d.id, (trial.get(d.id) || 0) + d.count * times);
      // write back consumed inventory
      for (const [k, v] of trial) inv.set(k, v);
      steps.push({ recipe: r, times, itemId });
      return { ok: true, steps, missing: new Map() };
    }
    let total = [...missing.values()].reduce((a, b) => a + b, 0);
    for (const id of missing.keys()) if (!PREFERRED.has(bot.registry.items[id]?.name)) total += 0.01;
    if (!bestFail || total < bestFail.total) bestFail = { total, missing };
  }
  return { ok: false, steps: [], missing: bestFail?.missing || missingAll };
}

function describeMissing(bot, missing) {
  const parts = [];
  for (const [id, n] of missing) {
    const name = bot.registry.items[id]?.name || `#${id}`;
    parts.push(`${n} more ${name}`);
  }
  return parts.join(', ');
}

function describeShort(bot, step) {
  const r = step.recipe;
  const parts = [];
  for (const ing of recipeIngredients(r)) {
    const need = ing.count * step.times;
    const have = bot.inventory.items().filter((i) => i.type === ing.id).reduce((a, i) => a + i.count, 0);
    parts.push(`${bot.registry.items[ing.id]?.name} ${have}/${need}`);
  }
  return `Ingredients for ${bot.registry.items[r.result.id]?.name} (have/need): ${parts.join(', ')}. `;
}

// ---------- tables / furnaces ----------
export function findBlockNear(bot, name, maxDist) {
  const id = bot.registry.blocksByName[name]?.id;
  if (id === undefined) return null;
  return bot.findBlock({ matching: id, maxDistance: maxDist });
}

async function ensureStation(ctx, blockName, itemName, { reach = 3.8, search = 40 } = {}) {
  const { bot } = ctx;
  let blk = findBlockNear(bot, blockName, reach);
  if (blk) return { block: blk, note: null };
  blk = findBlockNear(bot, blockName, search);
  if (blk) {
    await gotoPos(ctx, blk.position, 2.5, { maxMs: 60000 });
    blk = bot.blockAt(blk.position);
    if (blk?.name === blockName) return { block: blk, note: `walked to the ${blockName} at ${fmtPos(blk.position)}` };
  }
  if (!bot.inventory.items().find((i) => i.name === itemName)) {
    // try crafting it from inventory (table needs 4 planks; furnace needs 8 cobblestone + table)
    const r = await craftItem(ctx, itemName, 1, { noPlaceTable: false });
    if (!r.ok) throw new Error(`No ${blockName} within ${search} blocks and cannot make one: ${r.error}`);
  }
  const T = await placeUtility(ctx, itemName);
  const placed = bot.blockAt(T);
  return { block: placed, note: `placed a ${itemName} at ${fmtPos(T)}` };
}

export const ensureTable = (ctx) => ensureStation(ctx, 'crafting_table', 'crafting_table');

// ---------- craft ----------
export async function craftItem(ctx, item, count = 1, { noPlaceTable = false, retry = true } = {}) {
  const { bot, mcData } = ctx;
  let names = resolveItemNames(mcData, item);
  const requested = names.length === 1 ? names[0] : null;
  // 'oak_planks' with only jungle logs -> any planks variant that works (the requested one first)
  if (names.length === 1 && /_planks$/.test(names[0])) names = [names[0], ...resolveItemNames(mcData, 'planks').filter((n) => n !== names[0])];
  // candidates: prefer ones we hold ingredients for, but try all
  let best = null;
  for (const name of names) {
    const id = mcData.itemsByName[name].id;
    const inv = inventoryMapById(bot);
    // does the chain need a table? plan twice: with and without placing a table
    let p = plan(bot, id, count, new Map(inv), 0, new Set());
    let tablePlan = null;
    if (p.ok && p.steps.some((s) => s.recipe.requiresTable) && !findBlockNear(bot, 'crafting_table', 48) && !(inv.get(mcData.itemsByName.crafting_table.id) > 0)) {
      const inv2 = new Map(inv);
      const tp = plan(bot, mcData.itemsByName.crafting_table.id, 1, inv2, 0, new Set());
      if (!tp.ok) { p = { ok: false, steps: [], missing: tp.missing, tableMissing: true }; }
      else {
        const p2 = plan(bot, id, count, inv2, 0, new Set());
        if (p2.ok) { p = p2; tablePlan = tp; } else p = { ...p2, tableMissing: true };
      }
    }
    if (p.ok) { best = { name, id, p, tablePlan }; break; }
    const total = [...p.missing.values()].reduce((a, b) => a + b, 0);
    if (!best || (best.fail && total < best.total)) best = { fail: true, name, id, p, total };
  }
  if (!best || best.fail) {
    const bp = best?.p;
    const need = bp ? describeMissing(bot, bp.missing) : 'unknown';
    const targetName = best?.name || item;
    const hasRecipe = best ? bot.recipesAll(best.id, null, true).length > 0 : false;
    let msg;
    if (!hasRecipe) msg = `${targetName} has no crafting recipe${smeltHint(targetName)}`;
    else {
      const srcs = bp ? [...bp.missing.keys()].map((id) => { const n = bot.registry.items[id]?.name; const ch = knownChests(bot).find((c) => c.items.get(n) > 0); return n ? `${n}: ${ch ? `chest ${ch.pos.x},${ch.pos.y},${ch.pos.z} has ${ch.items.get(n)}, or ` : ''}${sourceOf(mcData, n)}` : null; }).filter(Boolean) : [];
      msg = `Cannot craft ${count} ${targetName}: missing ${need}${bp?.tableMissing ? ' (also needed to build a crafting table: 4 planks)' : ''}.${srcs.length ? ` Get it: ${srcs.join('; ')}.` : ''} You have: ${[...invCounts(bot)].map(([n, c]) => `${n} x${c}`).join(', ') || 'nothing'}. craft_plan shows the full tree.`;
    }
    return { ok: false, error: msg };
  }
  // execute
  const notes = [];
  let table = null;
  const before = countItem(bot, best.name);
  const allSteps = [...(best.tablePlan?.steps || []), ...best.p.steps];
  return withInventoryLock(ctx, () => runSteps(ctx, { best, allSteps, notes, before, requested, item, count, retry }));
}

/** pause auto-eat / auto-equip while we click inventory windows (they move items and desync the crafting grid) */
export async function withInventoryLock(ctx, fn) {
  const { bot, h } = ctx;
  const autoEatOn = !!h?.modes?.auto_eat;
  h.windowBusy = (h.windowBusy || 0) + 1;
  try { if (autoEatOn) bot.autoEat?.disableAuto?.(); } catch { /* */ }
  try {
    for (let i = 0; i < 40 && bot.autoEat?.isEating; i++) await sleep(100, ctx.signal);
    return await fn();
  } finally {
    h.windowBusy = Math.max(0, (h.windowBusy || 1) - 1);
    try { if (autoEatOn && !h.windowBusy) bot.autoEat?.enableAuto?.(); } catch { /* */ }
  }
}

/** after a failed click sequence: give the server a moment and close the player inventory so it resyncs the slots */
async function resyncInventory(ctx) {
  const { bot } = ctx;
  try { if (bot.currentWindow) bot.closeWindow(bot.currentWindow); } catch { /* */ }
  try { bot.closeWindow(bot.inventory); } catch { /* */ }
  await sleep(700, ctx.signal);
}

async function runSteps(ctx, { best, allSteps, notes, before, requested, item, count, retry }) {
  const { bot } = ctx;
  let table = null;
  for (const step of allSteps) {
    ctx.throwIfAborted();
    const r = step.recipe;
    let tableBlock = null;
    if (r.requiresTable) {
      if (!table || !bot.blockAt(table.position) || bot.blockAt(table.position).name !== 'crafting_table' || bot.entity.position.distanceTo(table.position) > 4.2) {
        const st = await ensureTable(ctx);
        table = st.block;
        if (st.note) notes.push(st.note);
      }
      tableBlock = table;
    }
    const rid = r.result.id;
    const rname = bot.registry.items[rid].name;
    try {
      // craft one at a time: mineflayer's multi-count crafting races the server's inventory updates
      for (let k = 0; k < step.times; k++) {
        // a crafted item with no free slot stays stuck in the grid and the ingredients are gone: check first
        if (!roomFor(bot, rname, r.result.count)) {
          const freesSlot = recipeIngredients(r).some((ing) => bot.inventory.items().filter((i) => i.type === ing.id).reduce((a, i) => a + i.count, 0) <= ing.count);
          if (!freesSlot) return { ok: false, inventoryFull: true, error: `Cannot craft ${rname}: ${fullInventoryHint(bot)}` };
        }
        const expect = bot.inventory.count(rid) + r.result.count;
        await ctx.race(bot.craft(r, 1, tableBlock || undefined));
        for (let i = 0; i < 30 && bot.inventory.count(rid) < expect; i++) await sleep(100, ctx.signal);
        if (bot.inventory.count(rid) < expect) throw new Error(`server did not deliver ${rname} (have ${bot.inventory.count(rid)}, expected ${expect})`);
        await sleep(100, ctx.signal);
      }
    } catch (e) {
      if (isStop(e)) throw e;
      await resyncInventory(ctx);
      if (retry) {
        // re-plan from the (resynced) inventory once: fixes stale-slot "missing ingredient" / "did not deliver"
        const again = await craftItem(ctx, item, Math.max(1, count - (countItem(bot, best.name) - before)), { retry: false });
        if (again.ok) { again.notes.unshift(`retried after a sync hiccup (${e.message.slice(0, 60)})`); again.crafted = countItem(bot, again.name) - before; return again; }
        return { ok: false, error: `Crafting ${rname} failed twice (${e.message}; then: ${again.error})` };
      }
      return { ok: false, error: `Crafting ${rname} failed: ${e.message}. ${/missing ingredient/.test(e.message) ? describeShort(bot, step) : ''}Notes: ${notes.join('; ') || 'none'}.` };
    }
  }
  const after = countItem(bot, best.name);
  if (requested && best.name !== requested && /_planks$/.test(requested)) notes.push(`made ${best.name} instead of ${requested} to match the logs you carry`);
  return { ok: true, name: best.name, crafted: after - before, total: after, notes };
}

function smeltHint(name) {
  const src = SMELT_SOURCES[name];
  return src ? `; it is made by smelting ${src} in a furnace (use the smelt action).` : '; it comes from mining/loot/mobs, not crafting.';
}

// ---------- smelting ----------
export const SMELTS = {
  raw_iron: 'iron_ingot', raw_gold: 'gold_ingot', raw_copper: 'copper_ingot',
  iron_ore: 'iron_ingot', deepslate_iron_ore: 'iron_ingot', gold_ore: 'gold_ingot', deepslate_gold_ore: 'gold_ingot',
  copper_ore: 'copper_ingot', deepslate_copper_ore: 'copper_ingot',
  sand: 'glass', red_sand: 'glass', cobblestone: 'stone', stone: 'smooth_stone', cobbled_deepslate: 'deepslate',
  clay_ball: 'brick', clay: 'terracotta', netherrack: 'nether_brick', ancient_debris: 'netherite_scrap',
  beef: 'cooked_beef', porkchop: 'cooked_porkchop', chicken: 'cooked_chicken', mutton: 'cooked_mutton', rabbit: 'cooked_rabbit',
  cod: 'cooked_cod', salmon: 'cooked_salmon', potato: 'baked_potato', kelp: 'dried_kelp', cactus: 'green_dye',
  coal_ore: 'coal', deepslate_coal_ore: 'coal', lapis_ore: 'lapis_lazuli', redstone_ore: 'redstone', diamond_ore: 'diamond', emerald_ore: 'emerald',
  oak_log: 'charcoal', spruce_log: 'charcoal', birch_log: 'charcoal', jungle_log: 'charcoal', acacia_log: 'charcoal', dark_oak_log: 'charcoal', mangrove_log: 'charcoal', cherry_log: 'charcoal',
};
const SMELT_SOURCES = {};
for (const [i, o] of Object.entries(SMELTS)) if (!SMELT_SOURCES[o] || /^raw_/.test(i)) SMELT_SOURCES[o] = i;

const FUEL_TICKS = { coal: 1600, charcoal: 1600, coal_block: 16000, blaze_rod: 2400, lava_bucket: 20000, dried_kelp_block: 4000, bamboo: 50, stick: 100 };
function fuelTicks(name) {
  if (FUEL_TICKS[name]) return FUEL_TICKS[name];
  if (/_planks$/.test(name) || /_log$/.test(name) || /_wood$/.test(name)) return 300;
  if (/^wooden_/.test(name)) return 200;
  return 0;
}
const FUEL_PREF = (n) => (n === 'coal' || n === 'charcoal' ? 0 : n === 'coal_block' ? 1 : /_planks$/.test(n) ? 2 : n === 'stick' ? 3 : /_log$/.test(n) ? 4 : 9);

export async function smelt(ctx, { item, count = 1, fuel }) {
  const { bot, mcData } = ctx;
  // resolve input
  let q = String(item).toLowerCase().replace(/^minecraft:/, '').replace(/^raw_(beef|porkchop|chicken|mutton|rabbit|cod|salmon)$/, 'raw_$1');
  let inputName = null;
  const rawFood = { raw_beef: 'beef', raw_porkchop: 'porkchop', raw_chicken: 'chicken', raw_mutton: 'mutton', raw_rabbit: 'rabbit', raw_cod: 'cod', raw_salmon: 'salmon' };
  const invNames = new Set(bot.inventory.items().map((i) => i.name));
  const cands = [];
  if (SMELTS[q] && mcData.itemsByName[q]) cands.push(q);
  for (const [k, v] of Object.entries(rawFood)) if (q === k || q === v) cands.push(k);
  if (q === 'log' || q === 'wood') cands.push(...[...invNames].filter((n) => /_log$/.test(n)));
  if (!cands.length) {
    // maybe the user named the output (iron_ingot) -> find input in inventory
    for (const [i, o] of Object.entries(SMELTS)) if (o === q && invNames.has(i)) cands.push(i);
    const rf = Object.entries(rawFood).find(([k]) => `cooked_${k.replace('raw_', '')}` === q);
    if (rf) cands.push(rf[0]);
  }
  inputName = cands.find((n) => invNames.has(n)) || cands[0];
  if (!inputName) throw new Error(`Don't know how to smelt "${item}". Smeltable: raw_iron, raw_gold, raw_copper, iron_ore, sand, cobblestone, clay_ball, raw_beef/porkchop/chicken/mutton/cod/salmon, potato, kelp, logs (charcoal)...`);
  const itemDef = mcData.itemsByName[inputName] || mcData.itemsByName[rawFood[inputName]];
  const have = (itemDef ? bot.inventory.items().filter((i) => i.type === itemDef.id) : []).reduce((a, i) => a + i.count, 0);
  if (have <= 0) throw new Error(`You have no ${inputName} to smelt. Inventory: ${[...invCounts(bot)].map(([n, c]) => `${n} x${c}`).join(', ') || 'empty'}.`);
  const n = Math.min(count, have);
  const outName = SMELTS[inputName];
  // fuel
  let fuelItem = null;
  if (fuel) {
    const f = bot.inventory.items().find((i) => i.name === fuel || (fuel === 'log' && /_log$/.test(i.name)) || (fuel === 'planks' && /_planks$/.test(i.name)));
    if (!f) throw new Error(`You don't have fuel "${fuel}".`);
    fuelItem = f;
  } else {
    const opts = bot.inventory.items().filter((i) => fuelTicks(i.name) > 0 && i.type !== itemDef.id).sort((a, b) => FUEL_PREF(a.name) - FUEL_PREF(b.name));
    fuelItem = opts[0];
  }
  if (!fuelItem) throw new Error('No fuel in inventory. Collect coal (coal_ore), or use logs/planks as fuel (craft planks from logs), then retry.');
  const fuelNeeded = Math.ceil((n * 200) / fuelTicks(fuelItem.name));
  if (fuelItem.count < fuelNeeded) {
    // allow partial: fewer smelts
  }
  const station = await ensureStation(ctx, 'furnace', 'furnace', { reach: 3.8, search: 16 });
  const notes = [];
  if (station.note) notes.push(station.note);
  const fblock = bot.blockAt(station.block.position);
  if (!roomFor(bot, outName, 1)) throw new Error(`Cannot smelt: no room for the ${outName}. ${fullInventoryHint(bot)}`);
  return withInventoryLock(ctx, async () => {
  const furnace = await ctx.race(bot.openFurnace(fblock));
  let collected = 0;
  let softTimeout = false;
  try {
    // take stale output first (anything, also a teammate's: it blocks the furnace)
    if (furnace.outputItem()) {
      const o = furnace.outputItem();
      if (!roomFor(bot, o.name, o.count)) throw new Error(`The furnace output holds ${o.name} x${o.count} and you have no room to take it. ${fullInventoryHint(bot)}`);
      await furnace.takeOutput();
      if (o.name === outName) collected += o.count; else notes.push(`took ${o.count} ${o.name} that was left in the furnace`);
    }
    // a different item already in the input slot ("destination full"): take it out first
    const oldIn = furnace.inputItem();
    if (oldIn && oldIn.type !== itemDef.id) {
      if (!roomFor(bot, oldIn.name, oldIn.count)) throw new Error(`The furnace at ${fmtPos(fblock.position)} is busy smelting ${oldIn.name} x${oldIn.count} (someone else's?) and you have no room to take it out. Use another furnace or free inventory space.`);
      await furnace.takeInput();
      notes.push(`took ${oldIn.count} ${oldIn.name} out of the input slot`);
    }
    const f2 = bot.inventory.items().find((i) => i.type === fuelItem.type);
    const fuelCount = Math.min(f2.count, fuelNeeded);
    const existingFuel = furnace.fuelItem();
    if (!existingFuel || existingFuel.type === f2.type) await furnace.putFuel(f2.type, null, Math.min(fuelCount, 64 - (existingFuel?.count || 0)));
    const room = 64 - (furnace.inputItem()?.count || 0);
    const haveNow = bot.inventory.items().filter((i) => i.type === itemDef.id).reduce((a, i) => a + i.count, 0);
    const put = Math.min(n, room, haveNow);
    if (put <= 0) throw new Error(`No ${inputName} left in your inventory to put in (have ${haveNow}).`);
    await furnace.putInput(itemDef.id, null, put);
    const maxMs = Math.min(n * 10500 + 8000, 150000);
    const t0 = Date.now();
    while (collected < n) {
      ctx.throwIfAborted();
      const o = furnace.outputItem();
      if (o) {
        if (!roomFor(bot, o.name, o.count)) { notes.push(`inventory full: ${o.count} ${o.name} left in the furnace output`); break; }
        await furnace.takeOutput(); collected += o.count; continue;
      }
      const inp = furnace.inputItem();
      if (!inp && !o && furnace.progress === 0 && furnace.fuel === 0 && collected < n) break; // nothing left cooking
      if (Date.now() - t0 > maxMs) { softTimeout = true; break; }
      await sleep(600, ctx.signal);
    }
  } finally {
    try { furnace.close(); } catch { /* */ }
  }
  const left = n - collected;
  const outDisplay = outName;
  let msg = `Smelted ${collected}/${n} ${inputName} -> ${outDisplay} (inventory now ${countItem(bot, outDisplay)} ${outDisplay}). Furnace at ${fmtPos(station.block.position)}${notes.length ? ' (' + notes.join('; ') + ')' : ''}.`;
  if (softTimeout || left > 0) msg += ` ${left} still cooking/pending in the furnace; call smelt again with the same item to collect the rest, or come back later.`;
  return msg;
  });
}

// ---------- recipe info ----------
export function recipeInfo(ctx, item) {
  const { bot, mcData } = ctx;
  const names = resolveItemNames(mcData, item);
  const out = [];
  for (const name of names.slice(0, 1)) {
    const id = mcData.itemsByName[name].id;
    const rs = bot.recipesAll(id, null, true);
    if (!rs.length) {
      out.push(`${name}: no crafting recipe${smeltHint(name)}`);
      continue;
    }
    // show up to 3 distinct recipes, preferring ones we hold ingredients for
    const have = inventoryMapById(bot);
    const scored = rs.map((r) => ({ r, short: recipeIngredients(r).reduce((a, i) => a + Math.max(0, i.count - (have.get(i.id) || 0)), 0) })).sort((a, b) => a.short - b.short);
    const seen = new Set();
    let shown = 0;
    for (const { r } of scored) {
      const ing = recipeIngredients(r).map((i) => `${i.count} ${bot.registry.items[i.id].name}`).join(' + ');
      if (seen.has(ing)) continue;
      seen.add(ing);
      out.push(`${name}: ${ing} -> ${r.result.count} ${name}${r.requiresTable ? ' (needs crafting_table)' : ' (2x2, no table)'}`);
      if (++shown >= 3) break;
    }
    const p = plan(bot, id, 1, inventoryMapById(bot), 0, new Set());
    if (p.ok) {
      const stepNames = p.steps.map((s) => `${bot.registry.items[s.itemId].name}${s.times > 1 ? ' x' + s.times : ''}`);
      const needTable = p.steps.some((s) => s.recipe.requiresTable);
      out.push(`You CAN craft 1 ${name} now${stepNames.length > 1 ? ' (via ' + stepNames.join(' -> ') + ')' : ''}${needTable ? '; uses a crafting table (placed/walked to automatically)' : ''}.`);
    } else {
      out.push(`You can NOT craft ${name} yet: still need ${describeMissing(bot, p.missing)} (raw materials; collect them first).`);
    }
  }
  if (names.length > 1) out.push(`(generic name matched ${names.length} variants; showed ${names[0]})`);
  return out.join('\n');
}

export { resolveBlockNames, Vec3, isSolid };

// ---------- chest memory (what the bot saw in chests; used by craft_plan) ----------
const chestMem = new WeakMap(); // bot -> Map(posKey -> {pos, items: Map(name->count), ts})
export function rememberChest(bot, pos, win) {
  if (!chestMem.has(bot)) chestMem.set(bot, new Map());
  const mem = chestMem.get(bot);
  const snap = () => {
    const items = new Map();
    for (const it of win.containerItems()) items.set(it.name, (items.get(it.name) || 0) + it.count);
    mem.set(`${pos.x},${pos.y},${pos.z}`, { pos: { x: pos.x, y: pos.y, z: pos.z }, items, ts: Date.now() });
  };
  snap();
  const origClose = win.close?.bind(win);
  if (origClose) win.close = (...a) => { try { snap(); } catch { /* */ } return origClose(...a); };
}
export function knownChests(bot) { return [...(chestMem.get(bot)?.values() || [])]; }

// ---------- craft_plan: full recipe tree from what you have ----------
const MOB_DROPS = {
  leather: 'kill cows (hunt cow)', beef: 'kill cows (hunt cow)', porkchop: 'kill pigs (hunt pig)', mutton: 'kill sheep (hunt sheep)', chicken: 'kill chickens (hunt chicken)',
  feather: 'kill chickens (hunt chicken)', egg: 'chickens lay them', rabbit_hide: 'kill rabbits', rabbit: 'kill rabbits',
  string: 'kill spiders (at night) or break cobwebs (collect cobweb, needs a sword)', spider_eye: 'kill spiders', bone: 'kill skeletons', arrow: 'kill skeletons',
  gunpowder: 'kill creepers', rotten_flesh: 'kill zombies', ender_pearl: 'kill endermen', slime_ball: 'kill slimes', blaze_rod: 'kill blazes (Nether fortress)',
  ink_sac: 'kill squid', milk_bucket: 'use_item bucket on a cow', white_wool: 'kill or shear sheep (hunt sheep)', wheat: 'harvest grown wheat (collect wheat) / farm it',
  sugar_cane: 'collect sugar_cane near water', apple: 'break oak leaves', flint: 'mine gravel', clay_ball: 'mine clay under shallow water',
  water_bucket: 'use_item bucket on a water source', lava_bucket: 'use_item bucket on a lava source',
};
let dropIndex = null;
function blocksDropping(mcData, itemName) {
  if (!dropIndex) {
    dropIndex = new Map();
    for (const b of mcData.blocksArray) for (const id of b.drops || []) {
      const n = mcData.items[typeof id === 'object' ? (id.drop ?? id.id) : id]?.name;
      if (!n) continue;
      if (!dropIndex.has(n)) dropIndex.set(n, []);
      dropIndex.get(n).push(b.name);
    }
  }
  const l = dropIndex.get(itemName) || [];
  const pref = l.filter((n) => !/^(infested_|potted_)|_wall_|_hanging_|_stairs$|_slab$/.test(n));
  return (pref.length ? pref : l).sort((a, b) => a.length - b.length).slice(0, 3);
}
function toolHint(mcData, blockName) {
  const b = mcData.blocksByName[blockName];
  if (!b?.harvestTools) return '';
  const tiers = ['wooden', 'stone', 'iron', 'diamond', 'netherite', 'golden'];
  const tools = Object.keys(b.harvestTools).map((id) => mcData.items[id]?.name).filter(Boolean)
    .sort((a, c) => tiers.findIndex((t) => a.startsWith(t)) - tiers.findIndex((t) => c.startsWith(t)));
  return tools[0] ? ` (needs ${tools[0]}+)` : '';
}
function sourceOf(mcData, name) {
  if (SMELT_SOURCES[name]) return `smelt ${SMELT_SOURCES[name]}`;
  if (MOB_DROPS[name]) return MOB_DROPS[name];
  const bl = blocksDropping(mcData, name);
  if (bl.length) return `collect ${bl[0]}${toolHint(mcData, bl[0])}`;
  return 'loot chests / trading (no recipe)';
}

export async function craftPlan(ctx, item, count = 1) {
  const { bot, mcData } = ctx;
  const names = resolveItemNames(mcData, item);
  const name = names[0];
  const inv = inventoryMapById(bot);
  const chests = knownChests(bot);
  const inChests = (n) => chests.map((c) => ({ c, k: c.items.get(n) || 0 })).filter((x) => x.k > 0);
  const lines = [];
  const raw = new Map(); // name -> {need, src, chest}
  const crafts = [];
  let needTable = false;
  const walk = (id, need, depth, chain) => {
    const nm = bot.registry.items[id].name;
    const pad = '  '.repeat(depth);
    const have = inv.get(id) || 0;
    const use = Math.min(have, need);
    inv.set(id, have - use);
    const rem = need - use;
    if (rem <= 0) { lines.push(`${pad}[have] ${nm} x${need}`); return; }
    // skip recipe cycles (iron_ingot <- iron_nugget <- iron_ingot, ingot <- iron_block): an ingredient we lack whose every recipe needs this item
    const cyclic = (r) => recipeIngredients(r).some((ing) => chain.has(ing.id) || ing.id === id || (!(inv.get(ing.id) > 0) && (() => { const rs = bot.recipesAll(ing.id, null, true); return rs.length > 0 && rs.every((r2) => recipeIngredients(r2).some((x) => x.id === id)); })()));
    // re-colour recipes (white_bed <- black_bed + dye, wool/carpet/glass dyeing) only when we already hold the coloured input
    const suffix = (nm.match(/_(bed|wool|carpet|terracotta|stained_glass|stained_glass_pane|concrete_powder|candle|banner|shulker_box)$/) || [])[0];
    const recolor = (r) => suffix && recipeIngredients(r).some((ing) => bot.registry.items[ing.id]?.name.endsWith(suffix) && !(inv.get(ing.id) > 0));
    let recipes = depth < 6 && !chain.has(id) ? bot.recipesAll(id, null, true).filter((r) => !cyclic(r) && !recolor(r)) : [];
    // things you normally get raw (wool from sheep, ...) unless you can already craft them from what you carry
    if (recipes.length && MOB_DROPS[nm] && !plan(bot, id, rem, new Map(inv), 0, new Set()).ok) {
      const alt = recipes.map((r) => recipeIngredients(r).map((i) => `${i.count} ${bot.registry.items[i.id].name}`).join(' + '))[0];
      const src = `${MOB_DROPS[nm]}${alt ? ` (or craft from ${alt} each)` : ''}`;
      lines.push(`${pad}[MISSING] ${nm}: need ${rem} more${use ? ` (have ${use})` : ''} - ${src}`);
      const r0 = raw.get(nm) || { need: 0, src, chest: inChests(nm)[0] };
      r0.need += rem; raw.set(nm, r0);
      return;
    }
    if (!recipes.length) {
      const ch = inChests(nm);
      const src = sourceOf(mcData, nm);
      const chestTxt = ch.length ? `; seen in chest ${ch.map((x) => `${x.c.pos.x},${x.c.pos.y},${x.c.pos.z} (x${x.k})`).join(', ')}` : '';
      lines.push(`${pad}[MISSING] ${nm}: need ${rem} more${use ? ` (have ${use})` : ''} - ${src}${chestTxt}`);
      const r0 = raw.get(nm) || { need: 0, src, chest: ch[0] };
      r0.need += rem; raw.set(nm, r0);
      return;
    }
    // choose the recipe with the smallest shortfall given what is left
    let best = null;
    for (const r of recipes) {
      const times = Math.ceil(rem / r.result.count);
      let short = 0;
      for (const ing of recipeIngredients(r)) {
        const lack = Math.max(0, ing.count * times - (inv.get(ing.id) || 0));
        if (!lack) continue;
        const sub = plan(bot, ing.id, lack, new Map(inv), 0, new Set([id]));
        short += sub.ok ? lack * 0.1 : [...sub.missing.values()].reduce((a, b) => a + b, 0);
      }
      if (recipeIngredients(r).some((ing) => !PREFERRED.has(bot.registry.items[ing.id]?.name) && !(inv.get(ing.id) > 0))) short += 0.05;
      if (!best || short < best.short) best = { r, times, short };
    }
    const { r, times } = best;
    if (r.requiresTable) needTable = true;
    const ings = recipeIngredients(r).map((i) => `${i.count * times} ${bot.registry.items[i.id].name}`).join(' + ');
    lines.push(`${pad}${nm} x${rem}${use ? ` (+${use} you have)` : ''} = craft ${times}x [${ings}]${r.requiresTable ? ' at a crafting_table' : ''}`);
    const nc = new Set(chain); nc.add(id);
    for (const ing of recipeIngredients(r)) walk(ing.id, ing.count * times, depth + 1, nc);
    crafts.push(nm);
    const made = times * r.result.count - rem;
    if (made > 0) inv.set(id, (inv.get(id) || 0) + made);
  };
  walk(mcData.itemsByName[name].id, count, 0, new Set());
  const hasTable = findBlockNear(bot, 'crafting_table', 32) || (inventoryMapById(bot).get(mcData.itemsByName.crafting_table.id) || 0) > 0;
  const out = [`Plan for ${count} ${name}${names.length > 1 ? ` (generic "${item}": using ${name})` : ''}:`, ...lines];
  if (!raw.size) {
    out.push(`READY: you have everything. Call craft {item:"${name}", count:${count}}; it does all ${crafts.length} craft step${crafts.length === 1 ? '' : 's'} itself${needTable && !hasTable ? ' (and makes/places a crafting_table)' : ''}.`);
  } else {
    out.push('Still missing (raw materials):');
    for (const [n, v] of raw) out.push(`- ${v.need} ${n}: ${v.chest ? `take from chest ${v.chest.c.pos.x},${v.chest.c.pos.y},${v.chest.c.pos.z} (chest_withdraw), or ` : ''}${v.src}`);
    out.push(`Then call craft {item:"${name}", count:${count}}; it crafts the steps (${crafts.join(' -> ')}) automatically.`);
    if (needTable && !hasTable) out.push('It needs a crafting_table: craft makes and places one from 4 planks if you have none.');
  }
  if (!chests.length) out.push('(No chests opened yet this session: chest_view the base chest so craft_plan also counts what is stored there.)');
  return out.join('\n');
}
