// Hivecraft engine: mineflayer bots driven by LLM-friendly actions.
import { pathfinderGuard } from './protect.js';
import { patchMovements, installDoorOpener } from './doors.js';
import mineflayer from 'mineflayer';
import pathfinderPkg from 'mineflayer-pathfinder';
import toolPkg from 'mineflayer-tool';
import pvpPkg from 'mineflayer-pvp';
import { loader as autoEat } from 'mineflayer-auto-eat';
import { BotHandle } from './handle.js';
import { ACTION_DEFS } from './actions.js';

const { pathfinder, Movements } = pathfinderPkg;

/** Public action list: [{name, description, params}] */
export const ACTIONS = ACTION_DEFS.filter((a) => !a.internal).map(({ name, description, params, timeoutMs }) => ({ name, description, params, ...(timeoutMs ? { timeoutMs } : {}) }));

const CANT_BREAK = /^(chest|trapped_chest|barrel|ender_chest|crafting_table|furnace|blast_furnace|smoker|.*_bed|.*_door|.*shulker_box|enchanting_table|anvil|brewing_stand|bookshelf|lectern|beacon|spawner)$/;

function configureMovements(bot) {
  const m = new Movements(bot);
  m.canDig = true;
  m.allow1by1towers = true;
  m.allowParkour = true;
  m.allowSprinting = true;
  m.maxDropDown = 4;
  m.liquidCost = 3;
  const items = bot.registry.itemsByName;
  m.scafoldingBlocks = ['dirt', 'cobblestone', 'netherrack', 'stone', 'cobbled_deepslate', 'andesite', 'diorite', 'granite', 'tuff', 'sand']
    .map((n) => items[n]?.id).filter((x) => x !== undefined);
  for (const b of bot.registry.blocksArray) if (CANT_BREAK.test(b.name)) m.blocksCantBreak.add(b.id);
  for (const n of ['campfire', 'soul_campfire', 'magma_block', 'sweet_berry_bush', 'cactus', 'wither_rose', 'powder_snow', 'fire', 'soul_fire', 'lava']) {
    const b = bot.registry.blocksByName[n]; if (b) m.blocksToAvoid.add(b.id);
  }
  // make the pathfinder walk around bamboo thickets / leaves instead of chopping through them (slow + junk drops)
  m.exclusionAreasBreak.push((b) => (b.name === 'bamboo' ? 8 : /_leaves$/.test(b.name) ? 2 : 0));
  // never dig through team builds (>= 100 = unbreakable for the pathfinder); see protect.js
  m.exclusionAreasBreak.push(pathfinderGuard);
  // walk through wooden doors / fence gates (open ahead, close behind); see doors.js
  patchMovements(bot, m);
  installDoorOpener(bot);
  bot.pathfinder.setMovements(m);
  bot.pathfinder.thinkTimeout = 6000;
  return m;
}

/**
 * Spawn a bot and resolve with a BotHandle once it has spawned in the world.
 */
export async function spawnBot({ name, host = '127.0.0.1', port = 25590, version = '1.21.1' } = {}) {
  if (!name) throw new Error('spawnBot: name is required');
  const bot = mineflayer.createBot({
    host, port, username: name, version, auth: 'offline',
    hideErrors: true, viewDistance: 'normal', checkTimeoutInterval: 120000, brand: 'vanilla',
  });
  bot.loadPlugin(pathfinder);
  bot.loadPlugin(toolPkg.plugin);
  bot.loadPlugin(pvpPkg.plugin);
  bot.loadPlugin(autoEat);

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); try { bot.quit(); } catch { /* */ } reject(new Error(`spawnBot(${name}): no spawn within 45s (is the server up at ${host}:${port}?)`)); }, 45000);
    const onSpawn = () => { cleanup(); resolve(); };
    const onErr = (e) => { cleanup(); reject(new Error(`spawnBot(${name}) connection error: ${e?.message || e}`)); };
    const onEnd = (r) => { cleanup(); reject(new Error(`spawnBot(${name}) disconnected before spawn: ${r}`)); };
    const onKick = (r) => { cleanup(); reject(new Error(`spawnBot(${name}) was kicked: ${typeof r === 'string' ? r : JSON.stringify(r)}`)); };
    function cleanup() { clearTimeout(timer); bot.removeListener('spawn', onSpawn); bot.removeListener('error', onErr); bot.removeListener('end', onEnd); bot.removeListener('kicked', onKick); }
    bot.once('spawn', onSpawn); bot.once('error', onErr); bot.once('end', onEnd); bot.once('kicked', onKick);
  });

  configureMovements(bot);
  bot.autoEat.setOpts({
    minHunger: 14, minHealth: 12, priority: 'foodPoints', returnToLastItem: true, strictErrors: false,
    bannedFood: ['rotten_flesh', 'pufferfish', 'chorus_fruit', 'poisonous_potato', 'spider_eye', 'golden_apple', 'enchanted_golden_apple', 'suspicious_stew'],
  });
  bot.autoEat.on?.('eatFail', () => {});
  bot.autoEat.enableAuto();
  bot.pvp.attackRange = 3.2;
  if (process.env.HIVE_DEBUG) debugTrace(bot);

  return new BotHandle(bot, { name, host, port, version });
}

export { BotHandle };

// debug helper (HIVE_DEBUG=1): trace who changes the pathfinder goal
export function debugTrace(bot) {
  const orig = bot.pathfinder.setGoal;
  bot.pathfinder.setGoal = (g, d) => {
    console.log(`[dbg ${bot.username}] setGoal(${g ? g.constructor.name : 'null'})`, new Error().stack.split('\n').slice(2, 5).map((s) => s.trim().replace(/\(.*[\/]/, '(')).join(' < '));
    return orig(g, d);
  };
}
