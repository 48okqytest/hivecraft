// Economy tools for mc-mcp.js: wallet, pay, server shop, market (player shops), auctions.
// Talks to the bridge's /econ/* API (MOD_PROTOCOL.md §5). Every call passes who=<this bot>.
// Results are short, end with the balance after the action, and errors carry a hint on what to do next.

export function makeEconTools({ BOT, get, post, enc, PLAYER = 'the player' }) {
  const obj = (properties = {}, required = []) => ({ type: 'object', properties, ...(required.length ? { required } : {}) });
  const str = (description) => ({ type: 'string', description });
  const int = (description) => ({ type: 'integer', description });
  const idT = { type: ['integer', 'string'], description: 'id number (from market / auctions)' };
  const W = `who=${enc(BOT)}`;

  // numbers may arrive as strings ("10"); the backend refuses anything that isn't a whole number
  const n = (v) => (v === undefined || v === null || v === '' ? undefined : Number.isFinite(Number(v)) ? Number(v) : v);
  const item = (v) => String(v ?? '').trim().toLowerCase().replace(/^minecraft:/, '').replace(/\s+/g, '_');
  const c = (v) => `${v} coin${v === 1 ? '' : 's'}`;
  const ago = (ts) => { const s = Math.max(0, Math.round((Date.now() - ts) / 1000)); return s < 90 ? `${s}s ago` : s < 5400 ? `${Math.round(s / 60)}m ago` : `${Math.round(s / 3600)}h ago`; };
  const left = (ts) => { const s = Math.round((ts - Date.now()) / 1000); return s <= 0 ? 'ending now' : s < 90 ? `${s}s left` : `${Math.round(s / 60)}m left`; };
  const me = (name) => String(name || '').toLowerCase() === BOT.toLowerCase();

  async function state() { return get(`/econ/state?${W}`); }
  /** "💰 balance: 88 coins (+20 held in bids)" — from a response that has `balance`, else from /econ/state */
  async function balLine(r) {
    let b = r && Number.isFinite(r.balance) ? r.balance : null;
    let held = (r && Number.isFinite(r.held) && r.held) || 0;
    if (b == null) { try { const s = await state(); b = s.me?.balance; held = s.me?.held || 0; } catch { /* the action itself succeeded */ } }
    return b == null ? '' : `\n💰 balance: ${c(b)}${held ? ` (+${held} held in your bids)` : ''}`;
  }

  const HINTS = [
    [/not enough coins/i, 'Sell something (shop_sell / market_list) or ask to be paid for work.'],
    [/no \S+ in your inventory|you have no/i, 'Check `inventory` for the exact item id; items must be in YOUR inventory (not a chest).'],
    [/unknown item|no such item|not (for sale|sold)|doesn'?t (sell|buy)|does not (sell|buy)/i, 'See `shop_catalog {filter}` for item ids and prices, or try the market.'],
    [/not online in Minecraft/i, 'Nothing changed. Wait until you are back in the game (check `status`), then retry.'],
    [/bid too low/i, 'Bid at least the minimum shown (see `auctions`).'],
    [/own (listing|auction)|is your own/i, 'You can\'t trade with yourself.'],
    [/listing #?\d+|no listing/i, 'Call `market` for current listings and ids.'],
    [/auction #?\d+|no auction/i, 'Call `auctions` for current auctions and ids.'],
    [/job #?\d+|server job/i, 'Call `jobs` for the current jobs and ids.'],
    [/bounty|board task #?\d+/i, 'Call `bounties` or `board` for task ids.'],
    [/no (account|player)|unknown (account|player|who)/i, 'Use a teammate\'s exact name, or "' + PLAYER + '".'],
  ];
  // the backend's errors point at HTTP routes; agents know tool names
  const ROUTE_TOOL = [[/(GET|POST) \/econ\/jobs\/deliver/g, '`job_deliver`'], [/(GET|POST) \/econ\/jobs/g, '`jobs`'], [/(GET|POST) \/econ\/bount(y|ies)/g, '`bounties`'], [/(GET|POST) \/econ\/catalog/g, '`shop_catalog`'], [/(GET|POST) \/econ\/market\/buy/g, '`market_buy`'], [/(GET|POST) \/econ\/market/g, '`market`'],
    [/(GET|POST) \/econ\/list/g, '`market_list`'], [/(GET|POST) \/econ\/unlist/g, '`market_unlist`'], [/(GET|POST) \/econ\/auctions?/g, '`auctions`'],
    [/(GET|POST) \/econ\/bid/g, '`auction_bid`'], [/(GET|POST) \/econ\/shops/g, '`my_shop`'], [/(GET|POST) \/econ\/pay/g, '`pay`'], [/(GET|POST) \/econ\/state/g, '`wallet`'],
    [/\buse unlist (\d+)/g, 'use `market_unlist {id:$1}`'], [/\buse unlist\b/g, 'use `market_unlist`']];
  const toolWords = (msg) => ROUTE_TOOL.reduce((m, [re, t]) => m.replace(re, t), String(msg));
  /** backend's explanation of a partial result ("you only had 3 oak_log; sold all of them") */
  const extra = (r, fallback = '') => (r && (r.note || r.warning) ? ` (${toolWords([r.note, r.warning].filter(Boolean).join('; '))})` : fallback);

  /** run an /econ call; on failure rethrow with an actionable hint */
  async function call(fn) {
    try { return await fn(); } catch (e) {
      const msg = toolWords(e?.message || String(e));
      if (e?.name === 'TimeoutError' || e?.cause?.code === 'ECONNREFUSED') throw e; // mc-mcp formats these
      let hint = e?.status === 502 ? 'Minecraft/RCON is unreachable right now; nothing changed. Try again in a minute.'
        : e?.status === 404 && /no route/i.test(msg) ? 'The economy is not available on this bridge yet.'
          : /`[\w {}:$]+`/.test(msg) ? null // the backend already names the tool to use
            : (HINTS.find(([re]) => re.test(msg)) || [])[1];
      const err = new Error(hint ? `${msg} — ${hint}` : msg);
      err.status = e?.status;
      throw err;
    }
  }

  const fmtTx = (t) => {
    const out = me(t.from); const other = out ? t.to : t.from;
    const amt = t.amount ? `${out ? '-' : '+'}${t.amount}` : '±0';
    const what = t.item ? ` ${t.count ?? ''} ${t.item}`.replace(/\s+/g, ' ') : '';
    return `  ${amt} ${t.kind}${what} ${out ? 'to' : 'from'} ${other}${t.note ? ` "${t.note}"` : ''} (${ago(t.ts)})`;
  };
  const fmtListing = (l) => `#${l.id} ${l.count} ${l.item} @ ${l.price} each — ${me(l.seller) ? 'YOURS' : l.seller}${l.shop ? ` (${l.shop})` : ''}`;
  const fmtAuction = (a) => {
    const bid = a.bid != null ? `bid ${a.bid} by ${me(a.bidder) ? 'YOU' : a.bidder}` : `no bids (start ${a.start})`;
    const end = a.ended || a.status !== 'open' ? `${a.status}${a.winner ? ` → ${me(a.winner) ? 'YOU' : a.winner}` : ''}` : `min next bid ${a.minNext}, ${left(a.endsAt)}`;
    return `#${a.id} ${a.count} ${a.item} by ${me(a.seller) ? 'YOU' : a.seller} — ${bid}; ${end}`;
  };
  const delivered = (r) => (r && r.delivered === false ? ' (you look offline: items are queued and given when you are online)' : '');

  const tools = [
    {
      name: 'wallet',
      description: 'Your coins (the money of this world), coins held in your open auction bids, your last transactions and any items still waiting to be delivered.',
      inputSchema: obj(),
      run: async () => call(async () => {
        const s = await state();
        const m = s.me || {};
        const tx = (s.tx || []).slice(0, 8).map(fmtTx);
        const dl = (s.deliveries || []).map((d) => `${d.count} ${d.item} (${d.reason})`);
        const mine = (s.listings || []).filter((l) => me(l.seller)).length;
        return [`💰 ${c(m.balance ?? 0)}${m.held ? ` (+${m.held} held in your bids)` : ''} — ${mine} market listing${mine === 1 ? '' : 's'} of yours`,
          tx.length ? `recent:\n${tx.join('\n')}` : 'no transactions yet',
          dl.length ? `waiting for delivery: ${dl.join(', ')}` : ''].filter(Boolean).join('\n');
      }),
    },
    {
      name: 'pay',
      description: 'Give coins to a teammate or ' + PLAYER + ': for work (building a house, delivering iron), a deal agreed in chat, or a gift. Whole coins only. Agree the price in chat first; pay when the job is done.',
      inputSchema: obj({ to: str('teammate name or "' + PLAYER + '"'), amount: int('whole coins, > 0'), note: str('what it is for, e.g. "house at 40,70,10"') }, ['to', 'amount']),
      run: async (a) => call(async () => {
        const r = await post('/econ/pay', { who: BOT, to: String(a.to || '').trim(), amount: n(a.amount), note: a.note ? String(a.note).slice(0, 200) : undefined });
        return `Paid ${c(r.tx?.amount ?? n(a.amount))} to ${r.tx?.to || a.to}${a.note ? ` ("${a.note}")` : ''}.${await balLine(r)}`;
      }),
    },
    {
      name: 'shop_catalog',
      description: 'The server shop price list: "buy" = what you pay per item, "sell" = what the server pays you per item ("-" = not traded). The server always trades, but teammates on the market usually beat these prices.',
      inputSchema: obj({ filter: str('optional part of an item name, e.g. "iron", "log", "food"') }),
      run: async (a) => call(async () => {
        const f = a.filter ? String(a.filter).trim() : '';
        let r = await get(`/econ/catalog${f ? `?item=${enc(item(f))}` : ''}`);
        let items = r.items || [];
        if (f && !items.length) { // maybe it's a category ("food")
          const all = (await get('/econ/catalog')).items || [];
          items = all.filter((x) => String(x.cat || '').toLowerCase().includes(f.toLowerCase()));
        }
        if (!items.length) return `No shop items match "${f}". Try a shorter filter, or shop_catalog without filter.`;
        const shown = items.slice(0, 60);
        return `Server shop (${r.currency || 'coins'}, per item)${f ? ` matching "${f}"` : ''}:\n` +
          shown.map((x) => `${x.item}: buy ${x.buy ?? '-'} / sell ${x.sell ?? '-'}${x.cat ? ` [${x.cat}]` : ''}`).join('\n') +
          (items.length > shown.length ? `\n… ${items.length - shown.length} more — use a filter` : '');
      }),
    },
    {
      name: 'shop_buy',
      description: 'Buy items from the server shop with coins; they are given to you right away. Check the market first: a teammate may sell cheaper.',
      inputSchema: obj({ item: str('item id, e.g. bread, oak_log, iron_ingot'), count: int('how many (default 1)') }, ['item']),
      run: async (a) => call(async () => {
        const r = await post('/econ/shop/buy', { who: BOT, item: item(a.item), count: n(a.count) ?? 1 });
        return `Bought ${r.count} ${r.item} from the server shop for ${c(r.cost)}${extra(r)}.${await balLine(r)}`;
      }),
    },
    {
      name: 'shop_sell',
      description: 'Sell items from YOUR inventory to the server shop for coins (always works for items it buys, at the "sell" price). For better prices list them on the market instead.',
      inputSchema: obj({ item: str('item id, e.g. cobblestone, rotten_flesh'), count: int('how many (default 1); only what you actually carry is taken') }, ['item']),
      run: async (a) => call(async () => {
        const want = n(a.count) ?? 1;
        const r = await post('/econ/shop/sell', { who: BOT, item: item(a.item), count: want });
        return `Sold ${r.count} ${r.item} to the server shop for ${c(r.earned)}${extra(r, r.count < want ? ` (you only had ${r.count})` : '')}.${await balLine(r)}`;
      }),
    },
    {
      name: 'market',
      description: 'Items players and teammates are selling (all shops), cheapest first: listing id, count, price each, seller. Buy with market_buy {id}.',
      inputSchema: obj({ item: str('optional part of an item name'), seller: str('optional: only this seller\'s listings') }),
      run: async (a) => call(async () => {
        const q = [a.item ? `item=${enc(item(a.item))}` : '', a.seller ? `seller=${enc(a.seller)}` : ''].filter(Boolean).join('&');
        const r = await get(`/econ/market${q ? '?' + q : ''}`);
        const ls = r.listings || [];
        if (!ls.length) return `Nothing listed${a.item ? ` for "${a.item}"` : ''}${a.seller ? ` by ${a.seller}` : ''}. The server shop (shop_catalog) always sells basics.`;
        const shown = ls.slice(0, 40);
        return shown.map(fmtListing).join('\n') + (ls.length > shown.length ? `\n… ${ls.length - shown.length} more — filter by item` : '');
      }),
    },
    {
      name: 'market_list',
      description: 'Put items from YOUR inventory up for sale on the market at a price per item (they are held in escrow until sold; you get the coins and a 💰Market message when someone buys). Price it between the server shop\'s sell and buy price so it beats the shop for both sides.',
      inputSchema: obj({ item: str('item id'), count: int('how many to list (only what you carry is taken)'), price_each: int('coins per item'), shop: str('optional: open/rename your shop with this name first') }, ['item', 'count', 'price_each']),
      run: async (a) => call(async () => {
        if (a.shop) await post('/econ/shops', { who: BOT, name: String(a.shop).slice(0, 40) });
        const want = n(a.count);
        const r = await post('/econ/list', { who: BOT, item: item(a.item), count: want, price: n(a.price_each) });
        const l = r.listing || {};
        const got = r.removed ?? l.count;
        return `Listed #${l.id}: ${got} ${l.item || item(a.item)} @ ${l.price ?? a.price_each} each${l.shop ? ` in ${l.shop}` : ''}${extra(r, Number.isFinite(want) && got < want ? ` (you only had ${got})` : '')}. Remove it with market_unlist {id:${l.id}}.${await balLine(r)}`;
      }),
    },
    {
      name: 'market_unlist',
      description: 'Take one of YOUR market listings down; the unsold items come back to your inventory.',
      inputSchema: obj({ id: idT }, ['id']),
      run: async (a) => call(async () => {
        const r = await post('/econ/unlist', { who: BOT, id: n(a.id) });
        const ret = r.returned;
        const what = ret && typeof ret === 'object' ? `${ret.count ?? ''} ${ret.item ?? ''}`.trim() : ret != null ? `${ret} item${ret === 1 ? '' : 's'}` : 'the items';
        return `Listing #${r.id ?? a.id} removed; ${what} returned to you${extra(r, delivered(r))}.${await balLine(r)}`;
      }),
    },
    {
      name: 'market_buy',
      description: 'Buy from a market listing (id from `market`); coins go to the seller and the items are given to you. count defaults to the whole listing.',
      inputSchema: obj({ id: idT, count: int('how many (default: all of it)') }, ['id']),
      run: async (a) => call(async () => {
        const r = await post('/econ/market/buy', { who: BOT, id: n(a.id), count: n(a.count) });
        const l = r.listing || {};
        return `Bought ${r.count} ${l.item || ''} from ${l.seller || 'the seller'} (#${l.id ?? a.id}) for ${c(r.cost)}${extra(r, delivered(r))}.${await balLine(r)}`;
      }),
    },
    {
      name: 'my_shop',
      description: 'Your shop on the market. With name: opens it (or renames it), e.g. "Flint\'s Ores". Without: shows your shop and your current listings. Pick a name that fits your role.',
      inputSchema: obj({ name: str('optional new shop name'), description: str('optional one-line description, e.g. "iron, coal and gold"') }),
      run: async (a) => call(async () => {
        let shop;
        if (a.name) shop = (await post('/econ/shops', { who: BOT, name: String(a.name).slice(0, 40), description: a.description ? String(a.description).slice(0, 120) : undefined })).shop;
        else shop = ((await get('/econ/shops')).shops || []).find((s) => me(s.owner));
        const ls = ((await get(`/econ/market?seller=${enc(BOT)}`)).listings || []).filter((l) => me(l.seller));
        const head = shop ? `🏪 ${a.name ? 'Your shop is now' : 'Your shop:'} "${shop.name}"${shop.description ? ` — ${shop.description}` : ''}` : '🏪 You have no shop yet: my_shop {name:"..."} opens one (listing items works without it too).';
        return `${head}\n${ls.length ? `your listings:\n${ls.map(fmtListing).join('\n')}` : 'no listings — add some with market_list'}${await balLine()}`;
      }),
    },
    {
      name: 'auctions',
      description: 'Open auctions (and ones that just ended): id, lot, current bid and bidder, minimum next bid, time left. Bid with auction_bid.',
      inputSchema: obj(),
      run: async () => call(async () => {
        const as = (await get('/econ/auctions')).auctions || [];
        return as.length ? as.slice(0, 30).map(fmtAuction).join('\n') : 'No auctions right now. Start one with auction_start for rare items.';
      }),
    },
    {
      name: 'auction_start',
      description: 'Auction items from YOUR inventory (best for rare things: diamonds, netherite, rare drops). Items go into escrow; the highest bidder gets them when time runs out and you get the coins (no bids: items come back). Note: only plain items move, enchantments are lost.',
      inputSchema: obj({ item: str('item id'), count: int('how many'), start_price: int('minimum first bid for the whole lot'), minutes: int('duration 1-1440 (e.g. 10)') }, ['item', 'count', 'start_price', 'minutes']),
      run: async (a) => call(async () => {
        const want = n(a.count);
        const r = await post('/econ/auction', { who: BOT, item: item(a.item), count: want, start: n(a.start_price), minutes: n(a.minutes) });
        const au = r.auction || {};
        const got = r.removed ?? au.count;
        return `Auction #${au.id} started: ${got} ${au.item || item(a.item)}, start ${au.start ?? a.start_price}, ${au.endsAt ? left(au.endsAt) : `${a.minutes}m`}${extra(r, Number.isFinite(want) && got < want ? ` (you only had ${got})` : '')}. Tell people about it!${await balLine(r)}`;
      }),
    },
    {
      name: 'auction_bid',
      description: 'Bid on an auction (amount = your TOTAL offer for the whole lot, at least the minimum next bid). The coins are held until you are outbid (then refunded) or win.',
      inputSchema: obj({ id: idT, amount: int('total coins for the lot') }, ['id', 'amount']),
      run: async (a) => call(async () => {
        const r = await post('/econ/bid', { who: BOT, id: n(a.id), amount: n(a.amount) });
        const au = r.auction || {};
        return `You lead auction #${au.id ?? a.id} (${au.count ?? ''} ${au.item ?? ''}) with ${c(au.bid ?? n(a.amount))}${au.endsAt ? `, ${left(au.endsAt)}` : ''}. A 💰Market message tells you if you're outbid.${await balLine(r)}`.replace(/\(\s+\)/, '');
      }),
    },
    // ---- earning coins (MOD_PROTOCOL.md §5 "Earning coins")
    {
      name: 'jobs',
      description: 'Server jobs: the world pays coins for deliveries ("32 cobblestone", "8 iron_ingot"), ABOVE the shop sell price. New jobs every Minecraft day, first come first served. Deliver from your inventory with job_deliver.',
      inputSchema: obj(),
      run: async () => call(async () => {
        const r = await get('/econ/jobs');
        const js = r.jobs || [];
        const open = js.filter((j) => j.status === 'open');
        const nr = r.nextRotation ? ` New jobs ${r.nextRotation > Date.now() ? `in ~${Math.max(1, Math.round((r.nextRotation - Date.now()) / 60000))}m` : 'soon'}.` : '';
        if (!open.length) return `No open server jobs right now.${nr}`;
        return open.map((j) => `#${j.id} deliver ${j.left} ${j.item}${j.left < j.count ? ` (of ${j.count})` : ''} — ${j.pay} each${j.shopSell ? ` (shop pays ${j.shopSell})` : ''}`).join('\n') +
          `\nDeliver with job_deliver {id, count}: the items are taken from YOUR inventory.${nr}`;
      }),
    },
    {
      name: 'job_deliver',
      description: 'Deliver items from YOUR inventory to a server job (id from `jobs`) and get paid for each item actually taken. count defaults to what the job still wants.',
      inputSchema: obj({ id: { type: ['integer', 'string'], description: 'job id from `jobs`' }, count: int('how many (default: all the job still wants; only what you carry is taken)') }, ['id']),
      run: async (a) => call(async () => {
        const r = await post('/econ/jobs/deliver', { who: BOT, id: n(a.id), count: n(a.count) });
        const j = r.job || {};
        return `Delivered ${r.count} ${j.item || ''} for job #${j.id ?? a.id}: +${c(r.earned)}${j.status === 'filled' ? ' (job filled)' : `, it still wants ${j.left}`}${extra(r)}.${await balLine(r)}`;
      }),
    },
    {
      name: 'bounties',
      description: 'Board tasks with a coin reward (bounties). Claim one with board_claim, do it, mark it done with board_update and the reward is paid to you. Post your own with board_add {reward} or bounty_add.',
      inputSchema: obj(),
      run: async () => call(async () => {
        const bs = (await get('/econ/bounties')).bounties || [];
        if (!bs.length) return 'No bounties right now. Post one for work you want done: board_add {title, reward} or bounty_add {task, amount}.';
        return bs.slice(0, 30).map((b) => `#${b.task} 💰${b.total} ${b.title}${b.owner ? ` — claimed by ${me(b.owner) ? 'YOU' : b.owner}` : ' — open'} (from ${Object.keys(b.funders || {}).map((f) => (me(f) ? 'you' : f)).join(', ')})`).join('\n');
      }),
    },
    {
      name: 'bounty_add',
      description: 'Put coins on a board task (or raise its reward). Your coins are held until the task is done, then paid to whoever claimed and finished it; refunded if it is deleted or nobody claimed it. Use it to get work done: "Mine 24 iron" + 30 coins.',
      inputSchema: obj({ task: { type: ['integer', 'string'], description: 'board task id' }, amount: int('coins to add') }, ['task', 'amount']),
      run: async (a) => call(async () => {
        const r = await post('/econ/bounty', { who: BOT, task: n(a.task), amount: n(a.amount) });
        const b = r.bounty || {};
        return `Bounty on task #${b.task ?? a.task} "${b.title || ''}" is now ${c(b.total)} (held until it is done).${await balLine(r)}`;
      }),
    },
    {
      name: 'bounty_cancel',
      description: 'Take back the coins YOU put on a task\'s bounty (only while nobody else has claimed it).',
      inputSchema: obj({ task: { type: ['integer', 'string'], description: 'board task id' } }, ['task']),
      run: async (a) => call(async () => {
        const r = await post('/econ/bounty/cancel', { who: BOT, task: n(a.task) });
        return `Withdrew ${c(r.refunded)} from the bounty on task #${a.task}${r.bounty?.total ? ` (${r.bounty.total} still on it from others)` : ''}.${await balLine(r)}`;
      }),
    },
    {
      name: 'earnings',
      description: 'How you earn coins from the world and what you earned: mob bounty per kill, milestones (first diamond, Nether...) done or not, the daily wage, plus your totals.',
      inputSchema: obj(),
      run: async () => call(async () => {
        const r = await get(`/econ/earnings?${W}`);
        const t = r.totals || {}, rt = r.rates || {};
        const mobs = Object.entries(rt.mobs || {}).sort((x, y) => y[1] - x[1]).map(([m, v]) => `${m} ${v}`).join(', ');
        const ms = (r.milestones || []).map((m) => `${m.done ? '✔' : '○'} ${m.label} ${m.reward}${m.done ? '' : m.firstBy ? '' : ` (+${m.first} if you are first)`}`).join('; ');
        return [`Earned today ${c(t.today || 0)}, total ${c(t.all || 0)} (mobs ${t.mob || 0}, jobs ${t.job || 0}, bounties ${t.bounty || 0}, milestones ${t.milestone || 0}, wage ${t.wage || 0}).`,
          mobs ? `Mob bounty per kill: ${mobs}${rt.mobCapPerMinute ? ` (max ${rt.mobCapPerMinute}/min)` : ''}.` : '',
          ms ? `Milestones: ${ms}.` : '',
          rt.wage ? `Daily wage: ${rt.wage} to everyone online at sunrise.` : '',
          'Also: `jobs` (deliveries) and `bounties` (board tasks with rewards).'].filter(Boolean).join('\n') + await balLine();
      }),
    },
  ];

  return { tools };
}
