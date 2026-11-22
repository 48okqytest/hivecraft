// Terminal commands for the Hivecraft Overlay mod (POST /mod/command, WS "command"). See MOD_PROTOCOL.md §3.
// Every command returns {ok, lines:[[{text,color,bold?,italic?,click?}]], data?}. Human-facing, short, coloured.
// Messages and goal/board changes are made as the human player (ctx.me = hivecraft.config.json player.displayName;
// same paths as the dashboard: a message to a bot interrupts its current action, see BotManager).

const C = {
  ok: '#55FF55', err: '#FF5555', warn: '#FFAA00', dim: '#AAAAAA', white: '#FFFFFF', head: '#FFAA00',
  aqua: '#55FFFF', yellow: '#FFFF55', blue: '#5599FF', green: '#55FF55', pink: '#FF77CC',
};

const seg = (text, color = C.white, extra = {}) => ({ text: String(text), color, ...extra });
const line = (...segs) => segs.flat().filter(Boolean);
const err = (text) => ({ ok: false, lines: [[seg(text, C.err)]] });
const okLines = (lines, data) => ({ ok: true, lines, ...(data !== undefined ? { data } : {}) });

export function ago(ts, now = Date.now()) {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, '0')} ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
const fmtP = (p) => (p ? `${Math.floor(p.x)} ${Math.floor(p.y)} ${Math.floor(p.z)}` : '?');
const pretty = (n) => String(n || '').replace(/^minecraft:/, '').replace(/_/g, ' ');
const short = (t, n = 80) => { t = String(t ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };

const DIRS = ['south', 'south-west', 'west', 'north-west', 'north', 'north-east', 'east', 'south-east'];
/** compass direction from a to b (Minecraft: +z = south, +x = east) */
export function compass(a, b) {
  const dx = b.x - a.x, dz = b.z - a.z;
  if (Math.abs(dx) < 1 && Math.abs(dz) < 1) return 'here';
  const ang = Math.atan2(-dx, dz); // 0 = south, +pi/2 = west
  const i = ((Math.round(ang / (Math.PI / 4)) % 8) + 8) % 8;
  return DIRS[i];
}

// --------------------------------------------------------------------------- action text (also used by mod-api)

const VERB = (block) => (/_log$|_wood$|^log$|any_log/.test(block || '') ? 'chopping' : /ore|stone|deepslate|cobble|debris|coal|iron|gold|diamond|copper|redstone|lapis|emerald/.test(block || '') ? 'mining' : 'collecting');

/**
 * Short human text for what a bot is doing.
 * @returns {{text:string, progress:{done:number,total:number}|null}}
 */
export function actionText({ action, args, online = true, status, counter, ghosts = [], bot, dead = false } = {}) {
  if (!online) return { text: status === 'connecting' ? 'joining…' : 'offline', progress: null };
  if (dead) return { text: 'dead (respawning)', progress: null };
  if (!action) return { text: 'idle', progress: null };
  const a = args || {};
  const brk = counter?.break || 0, plc = counter?.place || 0;
  const xyz = (o) => [o.x, o.y, o.z].filter((v) => v !== undefined && v !== null).join(',');
  switch (action) {
    case 'collect': {
      const total = Number(a.count) || 0;
      const done = Math.min(brk, total || brk);
      return { text: `${VERB(a.block)} ${pretty(a.block)}${total ? ` ${done}/${total}` : ''}`, progress: total ? { done, total } : null };
    }
    case 'mine_block': return { text: `mining block at ${xyz(a)}`, progress: null };
    case 'goto': return { text: `walking to ${xyz(a)}`, progress: null };
    case 'goto_player': return { text: `going to ${a.player || '?'}`, progress: null };
    case 'follow': return { text: `following ${a.player || '?'}`, progress: null };
    case 'craft': return { text: `crafting ${a.count || 1} ${pretty(a.item)}`, progress: null };
    case 'craft_plan': return { text: `planning ${pretty(a.item)}`, progress: null };
    case 'smelt': return { text: `smelting ${a.count || ''} ${pretty(a.item)}`.replace(/\s+/g, ' '), progress: null };
    case 'place': return { text: `placing ${pretty(a.block)} at ${xyz(a)}`, progress: null };
    case 'build': {
      const total = Array.isArray(a.blocks) ? a.blocks.length : 0;
      return { text: `building ${total ? `${Math.min(plc, total)}/${total} blocks` : 'blocks'}`, progress: total ? { done: Math.min(plc, total), total } : null };
    }
    case 'blueprint_build': {
      const g = ghosts.find((x) => x.kind === 'build' && (x.id === a.build_id || (x.blueprint === a.name && x.bots?.includes(bot)))) ||
        ghosts.find((x) => x.kind === 'build' && x.bots?.includes(bot));
      const name = g?.blueprint || a.name || a.build_id || 'blueprint';
      if (g) return { text: `building ${pretty(name)} · ${g.progress}%`, progress: { done: g.done, total: g.total } };
      return { text: `building ${pretty(name)}${plc ? ` (+${plc})` : ''}`, progress: null };
    }
    case 'blueprint_preview': return { text: `previewing ${pretty(a.name)}`, progress: null };
    case 'blueprint_check': return { text: `checking materials for ${pretty(a.name)}`, progress: null };
    case 'blueprint_verify': return { text: `verifying build ${a.build_id || ''}`.trim(), progress: null };
    case 'blueprint_write': return { text: `designing ${pretty(a.name)}`, progress: null };
    case 'blueprint_capture': return { text: `copying a building`, progress: null };
    case 'find_build_site': case 'site_survey': return { text: 'looking for a build site', progress: null };
    case 'attack': return { text: `fighting ${pretty(a.target)}`, progress: null };
    case 'hunt': return { text: `hunting ${pretty(a.animal || a.target || a.mob || 'animals')}`, progress: null };
    case 'eat': return { text: `eating${a.item ? ` ${pretty(a.item)}` : ''}`, progress: null };
    case 'sleep': return { text: 'sleeping', progress: null };
    case 'give': return { text: `giving ${pretty(a.item)} to ${a.player}`, progress: null };
    case 'drop': return { text: `dropping ${pretty(a.item)}`, progress: null };
    case 'equip': return { text: `equipping ${pretty(a.item)}`, progress: null };
    case 'chest_view': return { text: `looking in a chest`, progress: null };
    case 'chest_deposit': return { text: `storing items in the chest`, progress: null };
    case 'chest_withdraw': return { text: `taking items from the chest`, progress: null };
    case 'escape': return { text: 'escaping', progress: null };
    case 'surface': return { text: 'climbing to the surface', progress: null };
    case 'wait': return { text: `waiting ${a.seconds ?? ''}s`.replace(' s', 's'), progress: null };
    case 'scan': case 'look_around': case 'survey': case 'nearest': case 'find_blocks': case 'blocks_at': case '_snapshot':
      return { text: 'looking around', progress: null };
    case 'use_block': case 'use_item': return { text: `using ${pretty(a.item || a.block || 'item')}`, progress: null };
    case 'run_code': return { text: 'running code', progress: null };
    default:
      if (action.startsWith('auto:')) {
        const k = action.slice(5);
        const t = { eat: 'eating', defend: 'fighting back', self_defense: 'fighting back', pickup: 'picking up items', unstuck: 'getting unstuck', escape_water: 'swimming out', avoid: 'avoiding danger' }[k] || pretty(k);
        return { text: `${t} (auto)`, progress: null };
      }
      return { text: pretty(action), progress: null };
  }
}

// --------------------------------------------------------------------------- helpers

function resolveBots(ctx, who) {
  if (!who) throw new UserError('which bot? (name or all)');
  if (who.toLowerCase() === 'all') {
    const n = ctx.bots.names();
    if (!n.length) throw new UserError('no bots yet');
    return n;
  }
  const names = ctx.bots.names();
  const hit = names.find((n) => n.toLowerCase() === who.toLowerCase()) || names.find((n) => n.toLowerCase().startsWith(who.toLowerCase()));
  if (!hit) throw new UserError(`no bot named "${who}". Bots: ${names.join(', ') || 'none'}`);
  return [hit];
}
class UserError extends Error {}

const botSeg = (ctx, name, extra = {}) => seg(name, ctx.botColor(name), { bold: true, click: `status ${name}`, ...extra });
const stateOf = (ctx, name) => ctx.botStates().find((b) => b.name === name) || null;

function needPlayer(player) {
  if (!player || !Number.isFinite(player.x)) throw new UserError('I need your position: the mod sends it with each command (player:{x,y,z}).');
  return player;
}

function ledgerLine(ctx, e, now = Date.now(), { withPos = false } = {}) {
  const verb = e.op === 'place' ? 'placed' : 'broke';
  const why = e.build ? `${e.cause === 'blueprint' ? '' : `${e.cause}, `}build ${e.build}${e.section !== null && e.section !== undefined ? ` sec ${e.section}` : ''}${e.phase ? ` (${e.phase})` : ''}` : e.cause;
  return line(
    seg(`${ago(e.ts, now).padEnd(8)} `, C.dim),
    botSeg(ctx, e.bot), seg(` ${verb} `, e.op === 'place' ? C.green : C.warn),
    seg(pretty(e.block), C.white),
    withPos ? seg(` at ${e.x} ${e.y} ${e.z}`, C.aqua) : null,
    seg(`  ${why}`, C.dim),
  );
}

// --------------------------------------------------------------------------- commands

export const COMMANDS = [
  { name: 'help', usage: 'help [command]', about: 'list commands' },
  { name: 'bots', usage: 'bots', about: 'one line per bot' },
  { name: 'status', usage: 'status <bot>', about: 'details of one bot' },
  { name: 'where', usage: 'where <bot>', about: 'position + direction from you' },
  { name: 'say', usage: 'say <bot|all> <message>', about: 'message the team as you (interrupts them)' },
  { name: 'goal', usage: 'goal [new goal]', about: 'show / set the team goal' },
  { name: 'board', usage: 'board | board add <text> [$coins] | board done <id>', about: 'task board ($coins = bounty)' },
  { name: 'stop', usage: 'stop <bot|all>', about: 'stop the current action' },
  { name: 'come', usage: 'come <bot|all>', about: 'bot walks to you' },
  { name: 'follow', usage: 'follow <bot>', about: 'bot follows you (stop <bot> ends it)' },
  { name: 'who', usage: 'who <x> <y> <z>', about: 'who placed/broke that block' },
  { name: 'placed', usage: 'placed <bot|all> [minutes]', about: 'blocks placed/broken lately' },
  { name: 'builds', usage: 'builds', about: 'running builds + previews' },
  { name: 'photos', usage: 'photos [bot]', about: 'latest photos' },
  { name: 'photo', usage: 'photo <id>', about: 'one photo (the UI opens it)' },
  { name: 'log', usage: 'log <bot> [n]', about: 'recent tool calls / thoughts' },
  // economy (MOD_PROTOCOL.md section 5), all as the human player
  { name: 'econ', usage: 'econ', about: 'economy summary' },
  { name: 'bal', usage: 'bal [who|all]', about: 'coin balance' },
  { name: 'pay', usage: 'pay <who> <n> [note]', about: 'give coins' },
  { name: 'shop', usage: 'shop [item]', about: 'server shop prices' },
  { name: 'buy', usage: 'buy <item> [n]', about: 'buy from the server shop' },
  { name: 'sell', usage: 'sell <item> [n]', about: 'sell to the server shop (from your inventory)' },
  { name: 'market', usage: 'market [item]', about: 'player listings' },
  { name: 'list', usage: 'list <item> <n> <price-each>', about: 'list items on the market' },
  { name: 'unlist', usage: 'unlist <id>', about: 'cancel your listing' },
  { name: 'buyl', usage: 'buyl <id> [n]', about: 'buy from a listing' },
  { name: 'myshop', usage: 'myshop <name>', about: 'open / rename your shop' },
  { name: 'auctions', usage: 'auctions', about: 'open auctions' },
  { name: 'auction', usage: 'auction <item> <n> <start> <minutes>', about: 'start an auction' },
  { name: 'bid', usage: 'bid <id> <amount>', about: 'bid on an auction (total)' },
  { name: 'jobs', usage: 'jobs', about: 'server jobs: deliver items for coins' },
  { name: 'deliver', usage: 'deliver <job-id> [n]', about: 'deliver items from your inventory to a job' },
  { name: 'bounties', usage: 'bounties', about: 'board tasks with a coin reward' },
  { name: 'bounty', usage: 'bounty <task-id> <coins|cancel>', about: 'put / raise / withdraw a bounty' },
  { name: 'earnings', usage: 'earnings [who]', about: 'what you earned + rates (mobs, milestones, wage)' },
];

/** Split a command line into words; "quoted words" stay together. */
export function splitArgs(text) {
  const out = [];
  const re = /"([^"]*)"|(\S+)/g;
  let m;
  while ((m = re.exec(text))) out.push(m[1] ?? m[2]);
  return out;
}

export async function runCommand(ctx, text, player) {
  const raw = String(text || '').trim().replace(/^[/!.]/, '');
  if (!raw) return err('type a command (help for the list)');
  const words = splitArgs(raw);
  const cmd = words[0].toLowerCase();
  const rest = raw.slice(raw.indexOf(words[0]) + words[0].length).trim();
  const args = words.slice(1);
  try {
    switch (cmd) {
      case 'help': case '?': return help(args[0]);
      case 'bots': case 'team': return cmdBots(ctx, player);
      case 'status': case 'st': return cmdStatus(ctx, args[0], player);
      case 'where': return cmdWhere(ctx, args[0], player);
      case 'say': case 'tell': case 'msg': return cmdSay(ctx, args[0], rest.slice(rest.indexOf(args[0] ?? '') + (args[0]?.length || 0)).trim());
      case 'goal': return cmdGoal(ctx, rest);
      case 'board': case 'tasks': return await cmdBoard(ctx, args, rest);
      case 'stop': return await cmdStop(ctx, args[0]);
      case 'come': return cmdCome(ctx, args[0], player);
      case 'follow': return await cmdFollow(ctx, args[0], player);
      case 'who': return cmdWho(ctx, args, player);
      case 'placed': return cmdPlaced(ctx, args);
      case 'builds': return cmdBuilds(ctx);
      case 'photos': return cmdPhotos(ctx, args[0]);
      case 'photo': return cmdPhoto(ctx, args[0]);
      case 'log': case 'logs': return cmdLog(ctx, args[0], args[1]);
      case 'econ': case 'economy': return await econCmd(ctx, () => cmdEcon(ctx));
      case 'bal': case 'balance': case 'coins': return await econCmd(ctx, () => cmdBal(ctx, args[0]));
      case 'pay': return await econCmd(ctx, () => cmdPay(ctx, args));
      case 'shop': return await econCmd(ctx, () => cmdShop(ctx, args.join('_')));
      case 'buy': return await econCmd(ctx, () => cmdShopTrade(ctx, 'buy', args));
      case 'sell': return await econCmd(ctx, () => cmdShopTrade(ctx, 'sell', args));
      case 'market': return await econCmd(ctx, () => cmdMarket(ctx, args.join('_')));
      case 'list': return await econCmd(ctx, () => cmdList(ctx, args));
      case 'unlist': return await econCmd(ctx, () => cmdUnlist(ctx, args[0]));
      case 'buyl': return await econCmd(ctx, () => cmdBuyListing(ctx, args[0], args[1]));
      case 'myshop': return await econCmd(ctx, () => cmdMyShop(ctx, rest));
      case 'auctions': return await econCmd(ctx, () => cmdAuctions(ctx));
      case 'auction': return await econCmd(ctx, () => cmdAuction(ctx, args));
      case 'bid': return await econCmd(ctx, () => cmdBid(ctx, args[0], args[1]));
      case 'jobs': return await earnCmd(ctx, (earn) => cmdJobs(ctx, earn));
      case 'deliver': return await earnCmd(ctx, (earn) => cmdDeliver(ctx, earn, args[0], args[1]));
      case 'bounties': return await earnCmd(ctx, (earn) => cmdBounties(ctx, earn));
      case 'bounty': return await earnCmd(ctx, (earn) => cmdBounty(ctx, earn, args[0], args[1]));
      case 'earnings': case 'earned': return await earnCmd(ctx, (earn) => cmdEarnings(ctx, earn, args[0]));
      case 'pause': case 'resume': return err(`${cmd} is not supported (the crew has no pause). Use stop <bot> to halt an action.`);
      default: {
        const close = COMMANDS.filter((c) => c.name.startsWith(cmd.slice(0, 2))).map((c) => c.name);
        return err(`unknown command "${cmd}".${close.length ? ` Did you mean: ${close.join(', ')}?` : ''} Type help.`);
      }
    }
  } catch (e) {
    if (e instanceof UserError || e?.status === 404 || e?.status === 400 || e?.status === 409) return err(e.message);
    throw e;
  }
}

function help(which) {
  if (which) {
    const c = COMMANDS.find((x) => x.name === which.toLowerCase());
    if (!c) return err(`no command "${which}"`);
    return okLines([[seg(c.usage, C.yellow, { bold: true })], [seg(c.about, C.white)]]);
  }
  const lines = [[seg('Hivecraft terminal', C.head, { bold: true }), seg('  — commands:', C.dim)]];
  for (const c of COMMANDS) lines.push([seg(c.usage.padEnd(30), C.yellow, { click: `help ${c.name}` }), seg(c.about, C.dim)]);
  return okLines(lines);
}

function hpColor(h) { return h === null || h === undefined ? C.dim : h <= 6 ? C.err : h <= 12 ? C.warn : C.ok; }

function cmdBots(ctx, player) {
  const list = ctx.botStates();
  if (!list.length) return okLines([[seg('no bots yet', C.dim)]]);
  const lines = [[seg(`${list.length} bot${list.length === 1 ? '' : 's'}`, C.head, { bold: true })]];
  for (const b of list) {
    const dist = player && b.pos && player.dim === b.dim ? ` ${Math.round(Math.hypot(b.pos.x - player.x, b.pos.y - player.y, b.pos.z - player.z))}m` : '';
    lines.push(line(
      botSeg(ctx, b.name), seg(b.role ? ` (${b.role})` : '', C.dim),
      seg(b.online ? '  ● ' : '  ○ ', b.online ? C.ok : C.err),
      b.online ? [seg(`♥${b.health ?? '?'} `, hpColor(b.health)), seg(`🍗${b.food ?? '?'} `, C.dim)] : null,
      seg(b.actionText, b.action ? C.white : C.dim),
      seg(`  ${fmtP(b.bpos)}${dist}`, C.aqua),
    ));
  }
  return okLines(lines);
}

function cmdStatus(ctx, who, player) {
  const [name] = resolveBots(ctx, who);
  const b = stateOf(ctx, name);
  const full = ctx.bots.state(name);
  const lines = [line(botSeg(ctx, name), seg(b.role ? ` (${b.role})` : '', C.dim), seg(`  ${b.status}`, b.online ? C.ok : C.err))];
  if (b.online) {
    lines.push(line(seg('  health ', C.dim), seg(`${b.health}/20`, hpColor(b.health)), seg('  food ', C.dim), seg(`${b.food}/20`, b.food <= 6 ? C.err : C.white),
      seg('  at ', C.dim), seg(fmtP(b.bpos), C.aqua, { click: `where ${name}` }), seg(` ${b.dim}`, C.dim),
      player && b.pos && player.dim === b.dim ? seg(`  (${Math.round(Math.hypot(b.pos.x - player.x, b.pos.z - player.z))}m ${compass(player, b.pos)})`, C.dim) : null));
    lines.push(line(seg('  doing ', C.dim), seg(b.actionText, C.white), b.busyMs > 1000 ? seg(` for ${Math.round(b.busyMs / 1000)}s`, C.dim) : null));
    lines.push(line(seg('  holding ', C.dim), seg(pretty(b.held) || 'nothing', C.white),
      (b.armor || []).some(Boolean) ? seg(`  armor ${(b.armor || []).filter(Boolean).map(pretty).join(', ')}`, C.dim) : null));
    const inv = (full.inventory || []).slice().sort((x, y) => y.count - x.count).slice(0, 10);
    if (inv.length) lines.push(line(seg('  inventory ', C.dim), seg(inv.map((i) => `${pretty(i.name)} ${i.count}`).join(', '), C.white)));
    if ((full.warnings || []).length) lines.push(line(seg('  ⚠ ', C.warn), seg(full.warnings.join('; '), C.warn)));
  } else if (full.lastError) lines.push([seg(`  ${full.lastError}`, C.err)]);
  if (b.task) lines.push(line(seg('  task ', C.dim), seg(`#${b.task.id} ${b.task.title}`, C.yellow)));
  if (b.thought) lines.push(line(seg('  thinking ', C.dim), seg(`"${short(b.thought, 160)}"`, C.white, { italic: true })));
  if (b.lastChat) lines.push(line(seg('  said ', C.dim), seg(short(b.lastChat.text, 140), C.white), seg(`  ${ago(b.lastChat.ts)}`, C.dim)));
  for (const e of (full.recentEvents || []).slice(-3)) lines.push(line(seg(`  ${ago(e.ts)} `, C.dim), seg(short(e.text, 120), e.kind === 'death' || e.kind === 'hurt' ? C.err : C.dim)));
  return okLines(lines, { bot: b });
}

function cmdWhere(ctx, who, player) {
  const [name] = resolveBots(ctx, who);
  const b = stateOf(ctx, name);
  if (!b?.pos) return err(`${name} has no known position (${b?.status || 'offline'})`);
  const segs = [botSeg(ctx, name), seg(' is at ', C.dim), seg(fmtP(b.bpos), C.aqua), seg(` (${b.dim})`, C.dim)];
  if (player) {
    if (player.dim !== b.dim) segs.push(seg(`  — in another dimension`, C.warn));
    else segs.push(seg(`  ${Math.round(Math.hypot(b.pos.x - player.x, b.pos.z - player.z))} blocks ${compass(player, b.pos)}, ${Math.round(b.pos.y - player.y) >= 0 ? '+' : ''}${Math.round(b.pos.y - player.y)} y`, C.white));
  }
  return okLines([segs], { pos: b.bpos, dim: b.dim });
}

function cmdSay(ctx, who, text) {
  if (!who) return err('usage: say <bot|all> <message>');
  if (!text) return err('say what?');
  const to = who.toLowerCase() === 'all' ? 'all' : resolveBots(ctx, who)[0];
  const m = ctx.store.addMessage({ from: ctx.me, to, text });
  return okLines([[seg('you → ', C.yellow), to === 'all' ? seg('all', C.white, { bold: true }) : botSeg(ctx, to), seg(`: ${text}`, C.white)]], { message: m });
}

function cmdGoal(ctx, text) {
  if (!text) {
    const g = ctx.store.goal || {};
    return okLines([[seg('goal: ', C.head, { bold: true }), seg(g.text || '(none)', g.text ? C.white : C.dim)], g.ts ? [seg(`  set by ${g.by || '?'} ${ago(g.ts)}`, C.dim)] : []].filter((l) => l.length));
  }
  const g = ctx.store.setGoal({ text, by: ctx.me });
  return okLines([[seg('goal set: ', C.ok), seg(g.text, C.white)]], { goal: g });
}

const STATUS_COLOR = { open: C.white, claimed: C.yellow, blocked: C.err, done: C.dim };
async function cmdBoard(ctx, args, rest) {
  const sub = (args[0] || '').toLowerCase();
  if (sub === 'add') {
    let title = rest.replace(/^add\s*/i, '').trim();
    // "board add Build a bridge $50" -> a 50-coin bounty (escrowed from the player, paid to whoever finishes it)
    const m = /\s*\$(\d+)\s*$/.exec(title);
    const reward = m ? Number(m[1]) : 0;
    if (m) title = title.slice(0, m.index).trim();
    if (!title) return err('usage: board add <task text> [$coins]');
    if (reward > 0) {
      const earn = ctx.econ?.earnings;
      if (!earn) return err('bounties need the economy, which is not running');
      try {
        const t = await earn.postTask({ by: ctx.me, title: title.slice(0, 200), priority: 2, reward });
        return okLines([[seg('added ', C.ok), seg(`#${t.id} `, C.yellow), seg(t.title, C.white), seg('  bounty ', C.dim), coins(reward)],
          [seg('balance ', C.dim), coins(ctx.econ.balance(ctx.me)), seg('  (paid to whoever finishes it)', C.dim)]], { task: t });
      } catch (e) { if (e?.status) return err(e.message); throw e; }
    }
    const t = ctx.store.addTask({ by: ctx.me, title: title.slice(0, 200), priority: 2 });
    return okLines([[seg('added ', C.ok), seg(`#${t.id} `, C.yellow), seg(t.title, C.white)]], { task: t });
  }
  if (sub === 'done' || sub === 'open' || sub === 'blocked') {
    const id = Number(args[1]);
    if (!Number.isFinite(id)) return err(`usage: board ${sub} <id>`);
    const t = ctx.store.updateTask(id, { by: ctx.me, status: sub });
    return okLines([[seg(`#${t.id} `, C.yellow), seg(t.title, C.white), seg(` → ${sub}`, STATUS_COLOR[sub])]], { task: t });
  }
  const tasks = ctx.store.tasks;
  if (!tasks.length) return okLines([[seg('board is empty — board add <text>', C.dim)]]);
  const order = { claimed: 0, open: 1, blocked: 2, done: 3 };
  const live = tasks.filter((t) => t.status !== 'done').sort((a, b) => order[a.status] - order[b.status] || (a.priority ?? 9) - (b.priority ?? 9) || a.id - b.id);
  const done = tasks.filter((t) => t.status === 'done');
  const lines = [[seg('board', C.head, { bold: true }), seg(`  ${live.length} active, ${done.length} done`, C.dim)]];
  for (const t of live.slice(0, 25)) {
    lines.push(line(seg(`#${t.id} `.padEnd(5), C.yellow), seg(`${t.status.padEnd(8)}`, STATUS_COLOR[t.status] || C.white),
      t.owner ? botSeg(ctx, t.owner) : null, t.owner ? seg(' ') : null, seg(short(t.title, 90), C.white),
      t.reward && t.rewardStatus === 'open' ? [seg('  bounty ', C.dim), coins(t.reward)] : null));
  }
  if (done.length) lines.push([seg(`done: ${done.slice(-5).map((t) => `#${t.id} ${short(t.title, 30)}`).join(', ')}${done.length > 5 ? ', …' : ''}`, C.dim)]);
  return okLines(lines);
}

async function cmdStop(ctx, who) {
  const names = resolveBots(ctx, who);
  const lines = [];
  for (const n of names) {
    try {
      const r = await ctx.bots.stop(n);
      lines.push([botSeg(ctx, n), seg(r.was ? ` stopped (was ${r.was})` : ' was idle', r.was ? C.ok : C.dim)]);
    } catch (e) { lines.push([botSeg(ctx, n), seg(` ${e.message}`, C.err)]); }
  }
  return okLines(lines);
}

function cmdCome(ctx, who, player) {
  const p = needPlayer(player);
  const names = resolveBots(ctx, who);
  const target = { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) };
  const lines = [];
  // tell the agents first (the message interrupts what they were doing), then walk them over
  ctx.store.addMessage({ from: ctx.me, to: names.length > 1 ? 'all' : names[0], text: `come to me — I'm at ${target.x} ${target.y} ${target.z} (walking you there now)` });
  for (const n of names) {
    const b = stateOf(ctx, n);
    if (!b?.online) { lines.push([botSeg(ctx, n), seg(` is ${b?.status || 'offline'}`, C.err)]); continue; }
    if (b.dim && p.dim && b.dim !== p.dim) { lines.push([botSeg(ctx, n), seg(` is in the ${b.dim}, you are in the ${p.dim}`, C.err)]); continue; }
    ctx.bots.act(n, { action: 'goto', args: { ...target, range: names.length > 1 ? 3 : 2 }, interrupt: true })
      .catch(() => {});
    const d = b.pos ? Math.round(Math.hypot(b.pos.x - p.x, b.pos.y - p.y, b.pos.z - p.z)) : null;
    lines.push([botSeg(ctx, n), seg(' is coming', C.ok), seg(d !== null ? ` (${d} blocks away)` : '', C.dim)]);
  }
  return okLines(lines, { target });
}

function cmdFollow(ctx, who, player) {
  if (who?.toLowerCase() === 'all') return err('follow one bot at a time: follow <bot>');
  const [n] = resolveBots(ctx, who);
  const me = player?.name || ctx.meMc || ctx.me;
  const b = stateOf(ctx, n);
  if (!b?.online) return err(`${n} is ${b?.status || 'offline'}`);
  ctx.store.addMessage({ from: ctx.me, to: n, text: `follow me (${me}) until I say stop` });
  const res = ctx.bots.act(n, { action: 'follow', args: { player: me, distance: 3 }, interrupt: true });
  return res.then((r) => (r.ok
    ? okLines([[botSeg(ctx, n), seg(` is following ${me}`, C.ok), seg(`  (stop ${n} to end)`, C.dim, { click: `stop ${n}` })]])
    : err(`${n} can't follow: ${short(r.error, 200)}`)));
}

function cmdWho(ctx, args, player) {
  let x, y, z;
  if (args.length >= 3) [x, y, z] = args.slice(0, 3).map((v, i) => (v === '~' && player ? Math.floor([player.x, player.y, player.z][i]) : Number(v)));
  else if (player?.look) ({ x, y, z } = player.look);
  else return err('usage: who <x> <y> <z>   (or look at a block: the mod sends player.look)');
  if (![x, y, z].every(Number.isFinite)) return err('x y z must be numbers');
  x = Math.floor(x); y = Math.floor(y); z = Math.floor(z);
  const dim = player?.dim || 'overworld';
  const hist = ctx.ledger.at(x, y, z, dim);
  const head = [seg(`block ${x} ${y} ${z}`, C.aqua, { bold: true })];
  if (!hist.length) return okLines([[...head, seg('  — no bot has touched it (since the ledger started)', C.dim)]], { x, y, z, dim, history: [] });
  const now = Date.now();
  const lines = [head];
  for (const e of hist.slice().reverse()) lines.push(ledgerLine(ctx, e, now));
  return okLines(lines, { x, y, z, dim, history: hist });
}

function cmdPlaced(ctx, args) {
  const who = args[0] || 'all';
  const minutes = Math.max(1, Math.min(24 * 60, Number(args[1]) || 10));
  const names = who.toLowerCase() === 'all' ? null : resolveBots(ctx, who);
  const since = Date.now() - minutes * 60000;
  const r = ctx.ledger.query({ bot: names?.[0] || null, since, limit: 5000 });
  const by = new Map();
  for (const e of r.events) {
    const k = `${e.bot}|${e.op}|${e.block}`;
    by.set(k, (by.get(k) || 0) + 1);
  }
  const perBot = new Map();
  for (const [k, n] of by) {
    const [bot, op, block] = k.split('|');
    const pb = perBot.get(bot) || (perBot.set(bot, { place: [], break: [], np: 0, nb: 0 }), perBot.get(bot));
    pb[op].push([block, n]);
    if (op === 'place') pb.np += n; else pb.nb += n;
  }
  const lines = [[seg(`last ${minutes} min`, C.head, { bold: true }), seg(`  ${r.total} block changes${names ? ` by ${names[0]}` : ''}`, C.dim)]];
  if (!r.total) lines.push([seg('nothing placed or broken', C.dim)]);
  for (const [bot, pb] of perBot) {
    const top = (l) => l.sort((a, b) => b[1] - a[1]).slice(0, 5).map(([b, n]) => `${pretty(b)} ${n}`).join(', ');
    lines.push(line(botSeg(ctx, bot), seg(`  +${pb.np} placed`, C.green), pb.place.length ? seg(` (${top(pb.place)})`, C.dim) : null,
      seg(`  −${pb.nb} broken`, C.warn), pb.break.length ? seg(` (${top(pb.break)})`, C.dim) : null));
  }
  const now = Date.now();
  for (const e of r.events.slice(0, 6)) lines.push(ledgerLine(ctx, e, now, { withPos: true }));
  return okLines(lines, { total: r.total, events: r.events.slice(0, 50) });
}

function cmdBuilds(ctx) {
  const list = ctx.refreshGhosts();
  if (!list.length) return okLines([[seg('no builds or previews right now', C.dim)]]);
  const lines = [[seg('builds', C.head, { bold: true })]];
  for (const g of list) {
    const bar = '█'.repeat(Math.round(g.progress / 10)).padEnd(10, '░');
    if (g.kind === 'preview') {
      lines.push(line(seg('preview ', C.blue), seg(pretty(g.blueprint), C.white, { bold: true }), seg(` at ${fmtP(g.origin)} by `, C.dim), botSeg(ctx, g.bot),
        seg(`  ${g.total} blocks${g.conflicts ? `, ${g.conflicts} in the way` : ''}`, C.dim), seg(`  expires ${Math.max(0, Math.round((g.expires - Date.now()) / 60000))}m`, C.dim)));
    } else {
      lines.push(line(seg(g.finished ? 'done    ' : 'build   ', g.finished ? C.ok : C.yellow), seg(pretty(g.blueprint), C.white, { bold: true }), seg(` ${g.id}`, C.dim),
        seg(`  ${bar} ${g.progress}%`, g.finished ? C.ok : C.aqua), seg(`  ${g.done}/${g.total}`, C.dim),
        g.bots?.length ? seg('  ', C.dim) : null, ...(g.bots || []).map((b) => botSeg(ctx, b, { text: `${b} ` }))));
    }
  }
  return okLines(lines, { ghosts: list.map(({ blocks, ...s }) => s) });
}

function cmdPhotos(ctx, who) {
  let l = ctx.photos();
  if (who) { const [n] = resolveBots(ctx, who); l = l.filter((p) => p.agent.toLowerCase() === n.toLowerCase()); }
  if (!l.length) return okLines([[seg('no photos yet', C.dim)]]);
  const lines = [[seg('photos', C.head, { bold: true }), seg(`  ${l.length}${l.length >= 200 ? '+' : ''} total, newest first (click to open)`, C.dim)]];
  for (const p of l.slice(0, 8)) {
    lines.push(line(seg(`${ago(p.ts).padEnd(8)} `, C.dim), botSeg(ctx, p.agent, { click: `photo ${p.id}` }), seg(`  ${short(p.caption || p.mode || 'photo', 70)}`, C.white, { click: `photo ${p.id}` })));
  }
  return okLines(lines, { photos: l.slice(0, 30) });
}

function cmdPhoto(ctx, id) {
  if (!id) return err('usage: photo <id>');
  const p = ctx.photos().find((x) => x.id === id);
  if (!p) return err(`no photo "${id}"`);
  return okLines([[botSeg(ctx, p.agent), seg(`  ${ago(p.ts)}  `, C.dim), seg(p.caption || '(no caption)', C.white)], [seg(p.url, C.blue)]], { photo: p, open: p.url });
}

function cmdLog(ctx, who, nArg) {
  const [name] = resolveBots(ctx, who);
  const n = Math.max(1, Math.min(30, Number(nArg) || 8));
  const entries = ctx.store.getLog(name, { limit: 600 }).filter((e) => e.kind !== 'system').slice(-n);
  if (!entries.length) return okLines([[botSeg(ctx, name), seg(' has no log yet', C.dim)]]);
  const KC = { tool: C.yellow, result: C.white, thought: C.aqua, error: C.err };
  const lines = [[botSeg(ctx, name), seg(`  last ${entries.length}`, C.dim)]];
  for (const e of entries) lines.push(line(seg(`${ago(e.ts).padEnd(8)} `, C.dim), seg(`${e.kind.padEnd(7)} `, KC[e.kind] || C.dim), seg(short(e.text, 160), e.kind === 'thought' ? C.aqua : C.white, e.kind === 'thought' ? { italic: true } : {})));
  return okLines(lines);
}

// --------------------------------------------------------------------------- economy (as the human player)

const COIN = '#FFD24A';
const coins = (n) => seg(`${n}¢`, COIN, { bold: true });
const isInt = (v) => /^\d+$/.test(String(v ?? ''));

/** run an economy command; economy errors (HttpError with a status) become a red line */
async function econCmd(ctx, fn) {
  if (!ctx.econ) return err('the economy is not running on this bridge');
  try {
    return await fn();
  } catch (e) {
    if (e?.status) return err(e.message);
    throw e;
  }
}

/** "oak log 5" -> {item:'oak_log', nums:[5]} taking up to `want` trailing numbers */
function itemAndNums(args, want, usage) {
  const nums = [];
  const a = [...args];
  while (nums.length < want && a.length > 1 && isInt(a[a.length - 1])) nums.unshift(Number(a.pop()));
  if (!a.length) throw new UserError(`usage: ${usage}`);
  return { item: a.join('_'), nums };
}

function txLine(t) {
  const what = t.item ? ` ${t.count ?? ''} ${pretty(t.item)}`.replace(/\s+/g, ' ') : '';
  return line(seg(`${ago(t.ts).padEnd(8)} `, C.dim), seg(`${t.kind} `, C.yellow), seg(`${t.from} → ${t.to}`, C.white), seg(what, C.aqua), t.amount ? [seg(' ', C.dim), coins(t.amount)] : null);
}

function cmdEcon(ctx) {
  const st = ctx.econ.state(ctx.me);
  const rich = Object.entries(st.wallets).sort((a, b) => b[1] - a[1]).slice(0, 5);
  const sales = ctx.econ.history(null, 300).filter((t) => ['market_buy', 'auction_sale'].includes(t.kind)).slice(0, 4);
  const lines = [
    [seg('Economy', C.head, { bold: true }), seg(`  world ${st.world}`, C.dim)],
    line(seg('you: ', C.dim), coins(st.me.balance), st.me.held ? seg(`  (+${st.me.held} held in bids)`, C.dim) : null),
    line(seg('richest: ', C.dim), rich.map(([n, b], i) => [seg(`${i ? ', ' : ''}${n} `, C.white), coins(b)])),
    [seg(`${st.listings.length} listing${st.listings.length === 1 ? '' : 's'}`, C.aqua, { click: 'market' }), seg(' · ', C.dim),
      seg(`${st.auctions.filter((a) => !a.ended).length} open auction(s)`, C.aqua, { click: 'auctions' }), seg(' · ', C.dim),
      seg(`${st.shop.length} shop items`, C.aqua, { click: 'shop' })],
  ];
  if (sales.length) lines.push([seg('recent sales:', C.dim)]);
  for (const t of sales) lines.push(txLine(t));
  if (st.deliveries.length) lines.push([seg(`${st.deliveries.length} delivery(ies) waiting for you to be online`, C.warn)]);
  return okLines(lines, { econ: st });
}

function cmdBal(ctx, who) {
  if (who && who.toLowerCase() === 'all') {
    const st = ctx.econ.state(ctx.me);
    const lines = [[seg('Balances', C.head, { bold: true })]];
    for (const [n, b] of Object.entries(st.wallets).sort((a, x) => x[1] - a[1])) lines.push([seg(n.padEnd(16), C.white), coins(b)]);
    return okLines(lines, { wallets: st.wallets });
  }
  const name = ctx.econ.resolve(who || ctx.me);
  const st = ctx.econ.state(name);
  return okLines([line(seg(`${name}: `, C.white, { bold: true }), coins(st.me.balance), st.me.held ? seg(`  +${st.me.held} held in bids`, C.dim) : null)], { me: st.me });
}

async function cmdPay(ctx, args) {
  if (args.length < 2 || !isInt(args[1])) throw new UserError('usage: pay <who> <n> [note]');
  const r = await ctx.econ.pay({ who: ctx.me, to: args[0], amount: Number(args[1]), note: args.slice(2).join(' ') });
  return okLines([[seg('paid ', C.ok), coins(r.amount), seg(` to ${r.to}`, C.white), seg('  balance ', C.dim), coins(r.balance)]], r);
}

function cmdShop(ctx, filter) {
  const items = ctx.econ.catalog(filter || '');
  if (!items.length) return err(`the server shop has nothing matching "${filter}"`);
  const lines = [[seg('Server shop', C.head, { bold: true }), seg('  price each (click to trade 1)', C.dim)]];
  let cat = null;
  for (const i of items) {
    if (i.cat !== cat) { cat = i.cat; lines.push([seg(`— ${cat}`, C.dim, { italic: true })]); }
    lines.push(line(
      seg(pretty(i.item).padEnd(22), C.white, i.buy !== null ? { click: `buy ${i.item} 1` } : {}),
      i.buy !== null ? seg(`buy ${i.buy}¢`.padEnd(11), COIN, { click: `buy ${i.item} 1` }) : seg('—'.padEnd(11), C.dim),
      i.sell !== null ? seg(`sell ${i.sell}¢`, C.green, { click: `sell ${i.item} 1` }) : seg('—', C.dim),
    ));
  }
  return okLines(lines, { items });
}

async function cmdShopTrade(ctx, op, args) {
  const { item, nums } = itemAndNums(args, 1, `${op} <item> [n]`);
  const count = nums[0] ?? 1;
  if (op === 'buy') {
    const r = await ctx.econ.shopBuy({ who: ctx.me, item, count });
    return okLines([line(seg('bought ', C.ok), seg(`${r.count} ${pretty(r.item)}`, C.white), seg(' for ', C.dim), coins(r.cost), seg('  balance ', C.dim), coins(r.balance)),
      ...(r.warning ? [[seg(r.warning, C.warn)]] : [])], r);
  }
  const r = await ctx.econ.shopSell({ who: ctx.me, item, count });
  return okLines([line(seg('sold ', C.ok), seg(`${r.count} ${pretty(r.item)}`, C.white), seg(' for ', C.dim), coins(r.earned), seg('  balance ', C.dim), coins(r.balance)),
    ...(r.note ? [[seg(r.note, C.dim)]] : [])], r);
}

function cmdMarket(ctx, filter) {
  const l = ctx.econ.market({ item: filter || undefined });
  if (!l.length) return okLines([[seg(filter ? `no listings for "${filter}"` : 'the market is empty', C.dim)], [seg('list <item> <n> <price-each> to sell yours', C.dim)]], { listings: [] });
  const lines = [[seg('Market', C.head, { bold: true }), seg(`  ${l.length} listing${l.length === 1 ? '' : 's'}, cheapest first`, C.dim)]];
  for (const x of l.slice(0, 40)) {
    lines.push(line(
      seg(`#${x.id} `.padEnd(6), C.dim),
      seg(`${x.count} ${pretty(x.item)}`.padEnd(24), C.white, { click: `buyl ${x.id}` }),
      seg(`${x.price}¢ each`.padEnd(12), COIN, { click: `buyl ${x.id} 1` }),
      seg(` ${x.seller}`, ctx.botColor(x.seller)), seg(` · ${x.shop}`, C.dim),
    ));
  }
  return okLines(lines, { listings: l });
}

async function cmdList(ctx, args) {
  const usage = 'list <item> <n> <price-each>';
  const { item, nums } = itemAndNums(args, 2, usage);
  if (nums.length < 2) throw new UserError(`usage: ${usage}`);
  const r = await ctx.econ.list({ who: ctx.me, item, count: nums[0], price: nums[1] });
  return okLines([line(seg('listed ', C.ok), seg(`#${r.listing.id} `, C.dim), seg(`${r.listing.count} ${pretty(r.listing.item)}`, C.white), seg(' at ', C.dim), coins(r.listing.price), seg(' each', C.dim)),
    ...(r.note ? [[seg(r.note, C.dim)]] : []), [seg(`unlist ${r.listing.id}`, C.dim, { click: `unlist ${r.listing.id}` }), seg(' to cancel', C.dim)]], r);
}

async function cmdUnlist(ctx, id) {
  if (!isInt(id)) throw new UserError('usage: unlist <id>  (ids: market)');
  const r = await ctx.econ.unlist({ who: ctx.me, id: Number(id) });
  return okLines([[seg(`listing #${r.id} cancelled: `, C.ok), seg(`${r.returned} items ${r.delivered ? 'back in your inventory' : 'queued until you are online'}`, C.white)]], r);
}

async function cmdBuyListing(ctx, id, n) {
  if (!isInt(id) || (n !== undefined && !isInt(n))) throw new UserError('usage: buyl <id> [n]  (ids: market)');
  const r = await ctx.econ.marketBuy({ who: ctx.me, id: Number(id), count: n === undefined ? undefined : Number(n) });
  return okLines([line(seg('bought ', C.ok), seg(`${r.count} ${pretty(r.item)}`, C.white), seg(` from ${r.listing.seller} for `, C.dim), coins(r.cost), seg('  balance ', C.dim), coins(r.balance)),
    ...(r.note ? [[seg(r.note, C.warn)]] : [])], r);
}

async function cmdMyShop(ctx, name) {
  if (!name) {
    const sh = ctx.econ.shops().find((x) => x.owner === ctx.me);
    return okLines([[seg(sh ? `your shop: ${sh.name} (${sh.listings} listings)` : 'you have no shop yet: myshop <name>', C.white)]], { shop: sh || null });
  }
  const r = await ctx.econ.openShop({ who: ctx.me, name });
  return okLines([[seg(r.opened ? 'opened ' : 'renamed to ', C.ok), seg(r.shop.name, C.white, { bold: true })]], r);
}

function cmdAuctions(ctx) {
  const l = ctx.econ.auctions();
  if (!l.length) return okLines([[seg('no auctions', C.dim)], [seg('auction <item> <n> <start> <minutes> to start one', C.dim)]], { auctions: [] });
  const now = Date.now();
  const lines = [[seg('Auctions', C.head, { bold: true })]];
  for (const a of l) {
    const left = Math.max(0, Math.round((a.endsAt - now) / 1000));
    const time = a.ended ? a.status : left >= 120 ? `${Math.round(left / 60)}m left` : `${left}s left`;
    lines.push(line(
      seg(`#${a.id} `.padEnd(6), C.dim),
      seg(`${a.count} ${pretty(a.item)}`.padEnd(22), C.white),
      a.bid !== null ? [seg('bid ', C.dim), coins(a.bid), seg(` ${a.bidder}`, C.white)] : [seg('start ', C.dim), coins(a.start)],
      seg(`  ${time}`, a.ended ? C.dim : C.aqua),
      a.ended ? null : seg(`  [bid ${a.minNext}]`, C.yellow, { click: `bid ${a.id} ${a.minNext}` }),
      seg(`  by ${a.seller}`, C.dim),
    ));
  }
  return okLines(lines, { auctions: l });
}

async function cmdAuction(ctx, args) {
  const usage = 'auction <item> <n> <start> <minutes>';
  const { item, nums } = itemAndNums(args, 3, usage);
  if (nums.length < 3) throw new UserError(`usage: ${usage}`);
  const r = await ctx.econ.createAuction({ who: ctx.me, item, count: nums[0], start: nums[1], minutes: nums[2] });
  return okLines([line(seg('auction ', C.ok), seg(`#${r.auction.id} `, C.dim), seg(`${r.auction.count} ${pretty(r.auction.item)}`, C.white), seg(' from ', C.dim), coins(r.auction.start), seg(`, ends in ${nums[2]} min`, C.dim)),
    ...(r.note ? [[seg(r.note, C.dim)]] : [])], r);
}

async function cmdBid(ctx, id, amount) {
  if (!isInt(id) || !isInt(amount)) throw new UserError('usage: bid <id> <amount>  (ids: auctions)');
  const r = await ctx.econ.bid({ who: ctx.me, id: Number(id), amount: Number(amount) });
  return okLines([line(seg('bid ', C.ok), coins(r.auction.bid), seg(` on #${r.auction.id} (${r.auction.count} ${pretty(r.auction.item)})`, C.white), seg('  balance ', C.dim), coins(r.balance)),
    ...(r.note ? [[seg(r.note, C.warn)]] : [])], r);
}

// --------------------------------------------------------------------------- earnings (jobs, bounties, mobs, milestones, wage)

const mins = (ts) => Math.max(1, Math.round((ts - Date.now()) / 60000));

async function earnCmd(ctx, fn) {
  if (!ctx.econ) return err('the economy is not running on this bridge');
  if (!ctx.econ.earnings) return err('earnings are not running on this bridge');
  return econCmd(ctx, () => fn(ctx.econ.earnings));
}

function cmdJobs(ctx, earn) {
  const jobs = earn.jobs();
  const open = jobs.filter((j) => j.status === 'open');
  const nr = earn._nextRotation();
  const lines = [[seg('Server jobs', C.head, { bold: true }), seg(`  deliver from your inventory, paid above the shop price${nr ? ` · new jobs ${nr > Date.now() ? `in ${mins(nr)}m` : 'soon'}` : ''}`, C.dim)]];
  if (!jobs.length) lines.push([seg('no jobs posted yet (they appear within a minute of the server being up)', C.dim)]);
  for (const j of jobs) {
    const done = j.status !== 'open';
    const click = done ? {} : { click: `deliver ${j.id}` };
    lines.push(line(
      seg(`#${j.id} `.padEnd(6), C.dim),
      seg(`${j.left}/${j.count} ${pretty(j.item)}`.padEnd(24), done ? C.dim : C.white, click),
      seg(`${j.pay}¢ each`.padEnd(11), done ? C.dim : COIN, click),
      j.shopSell ? seg(`(shop ${j.shopSell}¢)`, C.dim) : null,
      done ? seg(`  ${j.status}`, C.dim) : seg('  [deliver]', C.yellow, click),
    ));
  }
  if (open.length) lines.push([seg('deliver <id> [n] takes the items from your inventory', C.dim)]);
  return okLines(lines, { jobs, nextRotation: nr });
}

async function cmdDeliver(ctx, earn, id, n) {
  if (!isInt(id) || (n !== undefined && !isInt(n))) throw new UserError('usage: deliver <job-id> [n]  (ids: jobs)');
  const r = await earn.deliver({ who: ctx.me, id: Number(id), count: n === undefined ? undefined : Number(n) });
  return okLines([line(seg('delivered ', C.ok), seg(`${r.count} ${pretty(r.job.item)}`, C.white), seg(` for job #${r.job.id}: `, C.dim), coins(r.earned),
    seg('  balance ', C.dim), coins(r.balance)), ...(r.job.status === 'filled' ? [[seg('job filled', C.dim)]] : []), ...(r.note ? [[seg(r.note, C.dim)]] : [])], r);
}

function cmdBounties(ctx, earn) {
  const bs = earn.bounties();
  if (!bs.length) return okLines([[seg('no bounties', C.dim)], [seg('board add <task> $<coins>  or  bounty <task-id> <coins>', C.dim)]], { bounties: [] });
  const lines = [[seg('Bounties', C.head, { bold: true }), seg('  paid to whoever claims the task and marks it done', C.dim)]];
  for (const b of bs) {
    let t = null;
    try { t = ctx.store.task(b.task); } catch { /* deleted */ }
    lines.push(line(seg(`#${b.task} `.padEnd(6), C.yellow), coins(b.total), seg(`  ${short(b.title, 60)}`, C.white),
      t?.owner ? [seg('  claimed by ', C.dim), botSeg(ctx, t.owner)] : seg('  open', C.ok),
      seg(`  from ${Object.keys(b.funders).join(', ')}`, C.dim)));
  }
  return okLines(lines, { bounties: bs });
}

async function cmdBounty(ctx, earn, id, what) {
  const usage = 'usage: bounty <task-id> <coins>  |  bounty <task-id> cancel';
  if (!isInt(id) || !what) throw new UserError(usage);
  if (what.toLowerCase() === 'cancel') {
    const r = await earn.cancelBounty({ who: ctx.me, task: Number(id) });
    return okLines([line(seg('withdrawn ', C.ok), coins(r.refunded), seg(` from task #${id}`, C.white), seg('  balance ', C.dim), coins(r.balance))], r);
  }
  const amt = String(what).replace(/^\$/, '');
  if (!isInt(amt)) throw new UserError(usage);
  const r = await earn.addBounty({ who: ctx.me, task: Number(id), amount: Number(amt) });
  return okLines([line(seg('bounty on ', C.ok), seg(`#${id} `, C.yellow), seg(short(r.bounty.title, 60), C.white), seg(' now ', C.dim), coins(r.bounty.total),
    seg('  balance ', C.dim), coins(r.balance))], r);
}

function cmdEarnings(ctx, earn, who) {
  const name = ctx.econ.resolve(who || ctx.me);
  const r = earn.earnings(name);
  const t = r.totals;
  const lines = [
    [seg(`Earnings: ${name}`, C.head, { bold: true }), seg('  today ', C.dim), coins(t.today), seg('  total ', C.dim), coins(t.all)],
    line(seg('mobs ', C.dim), coins(t.mob), seg('  jobs ', C.dim), coins(t.job), seg('  bounties ', C.dim), coins(t.bounty),
      seg('  milestones ', C.dim), coins(t.milestone), seg('  wage ', C.dim), coins(t.wage)),
  ];
  const mobs = Object.entries(r.rates.mobs).sort((a, b) => b[1] - a[1]);
  if (mobs.length) lines.push([seg('mob bounty: ', C.dim), seg(mobs.slice(0, 12).map(([m, v]) => `${pretty(m)} ${v}`).join(', ') + (mobs.length > 12 ? ', …' : ''), C.white),
    seg(r.rates.mobCapPerMinute ? `  (max ${r.rates.mobCapPerMinute}¢/min)` : '', C.dim)]);
  for (const m of r.milestones || []) {
    lines.push(line(seg(m.done ? '  ✔ ' : '  ○ ', m.done ? C.ok : C.dim), seg(m.label, m.done ? C.dim : C.white), seg(' ', C.dim), coins(m.reward),
      m.firstBy ? seg(`  world first: ${m.firstBy}`, C.dim) : seg(`  +${m.first} world first`, C.dim)));
  }
  if (r.rates.wage) lines.push([seg(`daily wage ${r.rates.wage}¢ to everyone online at sunrise`, C.dim), seg(r.nextSunrise ? ` (in ${mins(r.nextSunrise)}m)` : '', C.dim)]);
  lines.push([seg('jobs', C.aqua, { click: 'jobs' }), seg(' · ', C.dim), seg('bounties', C.aqua, { click: 'bounties' })]);
  return okLines(lines, r);
}
