# Hivecraft Overlay ⇄ bridge protocol (v1)

The Fabric client mod talks to the bridge at `127.0.0.1:47960` (same process as the dashboard).
Everything is JSON, UTF-8. Coordinates are integer block coordinates unless noted (bot `pos` is a float
`{x,y,z}` for smooth rendering; `bpos` is the integer block). Times are ms since epoch. `dim` is
`overworld` | `nether` | `end`.

Server code: `bridge/hub/mod-api.js` (WS + HTTP), `bridge/engine/ledger.js` (block ledger).

> The bridge refuses requests whose `Host` header is not `127.0.0.1:47960` / `localhost:47960`, and any
> request carrying an `Origin` header from another host. Java's `HttpClient` / OkHttp / `java.net.http.WebSocket`
> send `Host: 127.0.0.1:47960` by default and no `Origin` — that's fine. **Do not set an Origin header.**

---------------------------------------------------------------------------------------------------------

## 1. WebSocket `ws://127.0.0.1:47960/mod`

Connect, optionally send `hello`. The server immediately sends one `init`, then pushes updates.
Every server→client message is `{ "t": "<type>", ... }`. Unknown types must be ignored (forward compatible).
The server pings every 15 s (WS ping frames); reconnect with backoff (1 s, 2 s, 5 s…) if the socket closes.

### Client → server

| t | fields | effect |
|---|---|---|
| `hello` | `player` (string, the local player's Minecraft name), `version` (mod version), `want?` (array of topics, default all) | identifies the client; topics: `bots`,`paths`,`chat`,`board`,`goal`,`photos`,`ledger`,`ghosts`,`log`,`econ` |
| `player` | `name, x, y, z, dim, yaw?` | the local player's position (send ~1 Hz; used by `come`/`follow` and to sort ledger) |
| `command` | `id` (any, echoed back), `text`, `player?` `{name,x,y,z,dim}` | runs a terminal command → `command_result` |
| `ping` | `id?` | → `pong` |
| `ghosts` | | resend the full ghost list with blocks (e.g. after the client dropped its cache) |

```json
{"t":"hello","player":"Steve","version":"1.0.0"}
{"t":"player","name":"Steve","x":12.5,"y":64,"z":-3.2,"dim":"overworld","yaw":90}
{"t":"command","id":7,"text":"status Ash","player":{"name":"Steve","x":12,"y":64,"z":-3,"dim":"overworld"}}
```

### Server → client

#### `init` (once, on connect)
```json
{"t":"init","protocol":1,"serverTime":1763700000000,
 "player":{"name":"Steve","mc":"Steve"},   /* the human from hivecraft.config.json: name = account/display name, mc = Minecraft name */
 "bots":[ /* BotState, see "bots" */ ],
 "chat":[ /* last 60 ChatLine */ ],
 "board":[ /* Task */ ],
 "goal":{"text":"Build a castle","by":"Steve","ts":1763690000000},
 "waypoints":[{"name":"base","x":10,"y":64,"z":5,"by":"Ash","note":"","dimension":"overworld"}],
 "ghosts":[ /* Ghost (summary + blocks) */ ],
 "ledgerRecent":[ /* last 200 LedgerEvent */ ],
 "photos":[ /* last 20 Photo */ ],
 "commands":["help","bots","status", "..."]}
```

#### `bots` (~5 Hz, 200 ms) — full list every time (small; ≤ 8 bots)
```json
{"t":"bots","ts":1763700000200,"bots":[
 {"name":"Ash","color":"#F2B134","colorInt":15905076,"role":"Lead","online":true,"status":"online",
  "pos":{"x":12.31,"y":64.0,"z":-3.70},"bpos":{"x":12,"y":64,"z":-4},"yaw":1.57,"pitch":0.0,"dim":"overworld",
  "health":18.5,"food":17,"held":"iron_pickaxe","armor":["iron_helmet",null,null,null],
  "action":"collect","actionArgs":{"block":"iron_ore","count":24},
  "actionText":"mining iron_ore 12/24","busyMs":41000,
  "progress":{"done":12,"total":24},
  "task":{"id":4,"title":"Get 24 iron","status":"claimed"},
  "lastChat":{"text":"@all found iron at 40,12,-80","ts":1763699990000},
  "thought":"Iron is close, I'll mine the vein then smelt.",
  "dead":false}
]}
```
- `yaw`/`pitch` are radians, **mineflayer convention** (yaw 0 = facing −Z/north, increasing counter-clockwise
  seen from above). Minecraft degrees: `mcYaw = 180 - yaw * 180/π` (wrap to −180..180). `null` when unknown.
- `pos` comes from the 4 Hz worker snapshot; interpolate client-side.
- `action` = raw action name or `auto:<behaviour>` (e.g. `auto:eat`, `auto:defend`) or `null` (idle).
- `actionText` is always a short human string (`"idle"` when idle, `"offline"`, `"walking to 40,12,-80"`,
  `"building house_10_64_5 sec 1 · 63%"`, `"crafting 4 torch"`…). `progress` is `null` unless known.
- `task` = the board task this bot owns with status `claimed` (most recently updated), else `null`.
- `color` is stable per name (same palette as the dashboard legend; also sent as `colorInt` 0xRRGGBB).

#### `path` (on change, per bot) — the pathfinder's planned route
```json
{"t":"path","bot":"Ash","ts":1763700000300,"dim":"overworld",
 "goal":{"x":40,"y":12,"z":-80},"points":[[12,64,-4],[13,64,-4],[14,63,-5]],"status":"success"}
```
`points` = upcoming waypoints (block centres = `x+0.5,y,z+0.5`), at most 64. Empty `points` = path cleared
(arrived / stopped). `status`: `success` | `partial` | `timeout` | `noPath` | `cleared`.

#### `trail` (1 Hz) — recently walked positions (breadcrumbs, newest last)
```json
{"t":"trail","ts":1763700001000,"trails":{"Ash":[[12.3,64,-3.7,1763699999000],[11.0,64,-2.0,1763700000000]]}}
```
Each bot keeps the last 240 samples (one per ≥1 block moved, at most 3 min old). The message carries only
points added since the previous `trail` message (`init` does not include trails; request
`GET /mod/trails` for the full buffers).

#### `chat` — every team message (agents, the human player, in-game human chat, system events for bots)
```json
{"t":"chat","msg":{"id":512,"from":"Ash","to":"all","text":"found iron at 40,12,-80","ts":1763699990000,"color":"#F2B134"}}
```

#### `board` — task created/changed (`deleted:true` when removed)
```json
{"t":"board","task":{"id":4,"title":"Get 24 iron","detail":"","status":"claimed","owner":"Flint","priority":2,"by":"Ash","notes":[],"updated":1763699000000}}
{"t":"board","task":{"id":4},"deleted":true}
```

#### `goal`
```json
{"t":"goal","goal":{"text":"Build a castle","by":"Steve","ts":1763700000000}}
```

#### `waypoint` (`deleted:true` when removed)
```json
{"t":"waypoint","waypoint":{"name":"base","x":10,"y":64,"z":5,"by":"Ash","dimension":"overworld"}}
```

#### `photo` — a bot took a picture (album)
```json
{"t":"photo","photo":{"id":"Ash-1763700000000","agent":"Ash","ts":1763700000000,"caption":"the new house","mode":"orbit",
  "url":"/photos/Ash-1763700000000.png","width":768,"height":432}}
```
Image bytes: `GET http://127.0.0.1:47960/photos/<id>.png` (PNG).

#### `ledger` — blocks placed/broken by bots, live (batched, ≤ 10 Hz)
```json
{"t":"ledger","events":[
 {"id":9123,"ts":1763700000400,"bot":"Ash","op":"place","block":"oak_stairs","state":"facing=east,half=bottom,shape=straight,waterlogged=false",
  "prev":"air","x":11,"y":65,"z":6,"dim":"overworld","cause":"blueprint","action":"blueprint_build","build":"house_10_64_5","section":1,"phase":"place"},
 {"id":9124,"ts":1763700000600,"bot":"Flint","op":"break","block":"iron_ore","state":"","x":40,"y":12,"z":-80,"dim":"overworld","cause":"collect","action":"collect"}
]}
```
- `op`: `place` | `break`. For `break`, `block`/`state` = what was there before; for `place`, `prev` = what was there before.
- `cause` (why the block changed):
  `collect` (collect / gather actions), `mine` (mine_block), `place` (place / build actions), `blueprint`
  (blueprint executor; `phase` = `clear` | `fill` | `place` | `scaffold` | `unscaffold`), `scaffold`
  (pillar/escape/climb blocks the bot put down to get somewhere), `tunnel` (blocks dug by escape/surface/goto
  outside the pathfinder), `pathfinder-dig` (pathfinder dug through),
  `pathfinder-place` (pathfinder bridged/pillared), `auto` (auto behaviours), `code` (run_code), `idle` (no action
  running), or the raw action name for anything else (e.g. `craft` placing a crafting table). `action` = the action running at the time (or `null`).
- `build`/`section`/`phase` only for blueprint work (also set on pathfinder digs/places that happen during a build).

#### `ghosts` — planned/running builds changed (full list of summaries; blocks only when changed)
```json
{"t":"ghosts","ghosts":[
 {"id":"house_10_64_5","kind":"build","blueprint":"house","bot":"Wren","bots":["Wren","Moss"],
  "origin":{"x":10,"y":64,"z":5},"rotation":0,"dim":"overworld",
  "bounds":{"minX":10,"maxX":16,"minY":64,"maxY":70,"minZ":5,"maxZ":11},
  "total":312,"done":120,"remaining":192,"progress":38,"finished":false,"updated":1763700000000,
  "rev":17,
  "blocks":[[11,64,5,"cobblestone","",1],[11,65,6,"oak_stairs","facing=east,half=bottom",0]]},
 {"id":"preview:Wren:house:20:64:5","kind":"preview","blueprint":"house","bot":"Wren","origin":{"x":20,"y":64,"z":5},
  "rotation":90,"total":312,"done":0,"remaining":312,"progress":0,"expires":1763700600000,"rev":1,
  "blocks":[[21,64,5,"cobblestone","",0,"ok"],[22,64,5,"cobblestone","",0,"conflict"]]}
]}
```
- `blocks` rows: `[x, y, z, blockId, stateString, placed(0|1), tint?]`. `tint` only on previews:
  `ok` (free spot, cyan), `conflict` (terrain in the way, red), `done` (already there, green).
  For builds `placed=1` means the world (as last seen by the ledger / progress files) already has that block.
- `blocks` is omitted for a ghost whose `rev` did not change since the last message the client got; keep the
  previous blocks for that id. Ghost ids not in the list are gone (finished > 2 min ago, or preview expired).
- Previews expire 10 min after the `blueprint_preview` call, or when a build with the same blueprint+origin starts.
- At most 8000 blocks per ghost (big builds are truncated; `truncated:true`).
- Live updates of single cells come through `ledger` events (match `build` = ghost id), so a client can tick
  `placed` without waiting for the next `ghosts` message.

#### `log` — agent thoughts/tool calls (the dashboard's log feed), throttled per bot
```json
{"t":"log","bot":"Ash","kind":"tool","text":"collect {\"block\":\"iron_ore\",\"count\":24}","ts":1763700000000}
```
`kind`: `thought` | `tool` | `result` | `error` | `system`. `text` truncated to 300 chars.

#### `event` — bot events (death, respawn, hurt, joined, kicked, night_fell…)
```json
{"t":"event","bot":"Flint","kind":"death","text":"You died at 40,12,-80. ...","ts":1763700000000}
```

#### `command_result`
```json
{"t":"command_result","id":7,"ok":true,"lines":[
  [{"text":"Ash","color":"#F2B134","bold":true},{"text":"  online  ","color":"#55FF55"},{"text":"mining iron_ore 12/24","color":"#FFFFFF"}],
  [{"text":"  hp 18.5  food 17  at 12 64 -4","color":"#AAAAAA"}]]}
```
`lines` is an array of lines; each line is an array of segments `{text, color?, bold?, italic?, click?}`.
`color` is `#RRGGBB`. `click` (optional) is a command string the UI may run when the segment is clicked
(e.g. `"status Ash"`). On a bad command `ok:false` and lines explain it (red). Some commands also return
`data` (machine-readable, e.g. `who` returns `data.history`).

#### `hello_ok` (reply to `hello`)
```json
{"t":"hello_ok","protocol":1,"serverTime":1763700000000}
```

#### `error` (bad client message)
```json
{"t":"error","error":"invalid JSON"}
```

#### `pong`
```json
{"t":"pong","id":3,"serverTime":1763700000000}
```

---------------------------------------------------------------------------------------------------------

## 2. HTTP endpoints

All return JSON (`application/json`); errors are `{ok:false,error}` with a 4xx/5xx status.

| Method & path | Query / body | Returns |
|---|---|---|
| GET `/mod/hello` | | `{ok, protocol:1, bots:[names], wsUrl:"/mod", player:{name, mc}}` (cheap probe; `player` = the configured human) |
| GET `/mod/state` | | same object as WS `init` (without `t`) |
| GET `/mod/ledger` | `x1,y1,z1,x2,y2,z2` (box, optional; any missing axis = unbounded), `bot`, `since` (ms ts), `until`, `op` (place/break), `cause`, `dim`, `limit` (default 500, max 5000) | `{ok, events:[LedgerEvent], total, truncated}` newest first |
| GET `/mod/ledger/at` | `x,y,z`, `dim?` | `{ok, x,y,z, dim, history:[LedgerEvent] (oldest→newest), last: LedgerEvent|null}` |
| GET `/mod/ledger/stats` | `minutes?` (default 60) | `{ok, byBot:{Ash:{place:12,break:40}}, total}` |
| GET `/mod/ghosts` | `blocks=0` to omit blocks | `{ok, ghosts:[Ghost]}` (always with blocks unless `blocks=0`) |
| GET `/mod/ghosts/:id` | | `{ok, ghost}` with blocks |
| GET `/mod/photos` | `bot?`, `limit?` (default 30) | `{ok, photos:[Photo]}` newest first (image: `/photos/<id>.png`) |
| GET `/mod/trails` | | `{ok, trails:{bot:[[x,y,z,ts],...]}, paths:{bot: PathMsg}}` |
| POST `/mod/command` | `{text, player?:{name,x,y,z,dim}}` | `{ok, lines:[[Segment]], data?}` |

```http
GET /mod/ledger?x1=0&y1=60&z1=0&x2=20&y2=80&z2=20&bot=Ash&since=1763690000000
GET /mod/ledger/at?x=11&y=65&z=6
POST /mod/command  {"text":"come Ash","player":{"name":"Steve","x":12,"y":64,"z":-3,"dim":"overworld"}}
```

---------------------------------------------------------------------------------------------------------

## 3. Terminal commands (server-side; `POST /mod/command` or WS `command`)

Bot names are case-insensitive; `all` means every bot. The mod should send `player` with every command.

| Command | What it does |
|---|---|
| `help [cmd]` | list commands / usage |
| `bots` | one line per bot: name, online, hp/food, action text, position |
| `status <bot>` | detailed: vitals, position, held item, inventory top items, action + args, claimed task, last thought, last events |
| `say <bot\|all> <msg>` | message to the team as **the human player** (interrupts the receiving bots' current action, like dashboard chat) |
| `goal` / `goal <text>` | show / set the team goal (as the human player) |
| `board` | task list (open/claimed/blocked; done collapsed) |
| `board add <text>` | add a task (by the human player) |
| `board done|open|blocked <id>` | change a task's status |
| `stop <bot\|all>` | stop the current action now |
| `come <bot\|all>` | tells the bot(s) to come and walks them to your position (`goto`, interrupting). Uses the `player` sent with the command, else the last `player` message |
| `follow <bot>` | bot follows you (`follow` action); `stop <bot>` ends it |
| `who <x> <y> <z>` | history of that block: who placed/broke it, when, why (also `who` with no args = the block you look at, if the mod sends `look:{x,y,z}` in `player`) |
| `placed <bot\|all> [minutes]` | counts + last few blocks placed/broken by a bot in the last N minutes (default 10) |
| `photos [bot]` | latest photos (id, caption, age); each line has `click: "photo <id>"` |
| `photo <id>` | one photo; `data.open` = image URL (`/photos/<id>.png`) for the UI to show |
| `log <bot> [n]` | the bot's last n (default 8, max 30) tool calls/results/thoughts |
| `builds` | running build jobs + previews with progress % |
| `where <bot>` | position + distance/direction from you |

`pause`/`resume` are **not** implemented (the crew has no pause support).

---------------------------------------------------------------------------------------------------------

## 4. Types (summary)

- **BotState** — see `bots` message.
- **ChatLine** `{id, from, to, text, ts, color}` (`color` = sender bot colour, `#FFFF55` for the human player, `#AAAAAA` system).
- **Task** `{id, title, detail, status: open|claimed|done|blocked, owner, priority, by, notes:[{by,text,ts}], updated}`.
- **LedgerEvent** — see `ledger` message.
- **Ghost** — see `ghosts` message.
- **Photo** `{id, agent, ts, caption, mode, url, width?, height?}`.

Colour palette (picked by a stable hash of the bot name, so a bot keeps its colour across restarts; the server
always sends `color`, clients should not compute it):
`#F2B134 #4FC3F7 #81C784 #E57373 #BA68C8 #FFB74D #4DB6AC #F06292 #9575CD #AED581`.

---------------------------------------------------------------------------------------------------------

## 5. Economy (coins, server shop, player shops / market, auctions)

Server code: `bridge/hub/economy.js` (all money logic), routes in `bridge/hub/app.js`, ws topic in
`bridge/hub/mod-api.js`, terminal commands in `bridge/hub/mod-commands.js`. Catalog + settings:
`data/econ-catalog.json`. Test: `node test/econ-test.mjs` (offline, fake RCON).

### Basics
- Currency **coins**, **integers only** (fractional / negative / non-numeric amounts are refused).
- **One economy per world.** The world key is the basename of `level-name` in `server/server.properties`
  (`worlds/world-20261121-184302` → `world-20261121-184302`). State lives in `data/economy/<world-key>.json`
  (atomic tmp+rename writes). When the launcher starts a new world the bridge notices the new `level-name`
  (checked on every call and every 5 s) and switches to a fresh economy: everyone starts again with
  `startBalance` (default **100**). Ws clients get `{t:"econ",kind:"reset"}`.
- **Accounts**: every bot (any name the hub knows) and **the human player** from `hivecraft.config.json`. `who` accepts
  the bot name (case-insensitive) or the player's `displayName` / `mcName` (same account, always shown as the
  `displayName`; e.g. `Steve` / `steve_mc`). The mod sends `who` = `init.player.name`, else its Minecraft name.
  Accounts are created on first use with `startBalance`.
- **Items are real.** Items are ids like `oak_log` (`minecraft:` prefix optional, spaces → `_`, case-insensitive).
  Selling, listing and auctioning take the items **out of the player's real inventory** via RCON
  `clear <player> <item> <n>`; you are credited/escrowed **only for the count actually removed** (if you
  have 3 and offer 10, 3 are taken). Buying delivers with RCON `give` (a full inventory drops the items at
  the player's feet). Items move as plain items: **enchantments, custom names and damage are lost**, so don't
  sell enchanted gear. A delivery to an offline player is queued and given when they are next online.
- All money/escrow operations run one at a time (single queue), so nothing can double-spend. Nothing is paid
  unless the RCON step succeeded; every movement is in the transaction log.
- Notifications go to the people involved as hub chat messages **from `Market`** (sold, bought, outbid, won,
  auction ended/unsold, delivery done). The mod sees them on the `chat` topic like any message. Market
  messages do not interrupt bots.
- **Market news**: new listings and new auctions (by anyone) are collected for 20 s, then every bot except the
  seller gets ONE `Market` message, e.g. `new listings: Ash 16 oak_log @3 (#12), Steve 2 diamond @110 (#13) —
  market_buy {id} | new auctions: auction #5 by Flint: 1 diamond_sword, start 40, ends 15m — auction_bid {id, amount}`
  (max 6 per kind, then `+N more`). The human player gets none (the overlay shows the market live).

### HTTP endpoints (JSON; errors are `{ok:false,error}` with 4xx/5xx)
Every call takes `who` (query for GET, body for POST). Errors are plain sentences an agent can act on, e.g.
`not enough coins: have 40, need 64`, `you have no oak_log in your inventory`, `listing #7 has only 5 left`,
`bid too low: minimum next bid on auction #3 is 58`. Status: 400 bad input, 404 unknown
item/listing/auction/account, 409 not possible now (funds, sold out, own listing…), 502 Minecraft/RCON
unreachable (nothing changed).

| Method & path | Body / query | Returns |
|---|---|---|
| GET `/econ/state` | `who?` | full snapshot (below) |
| GET `/econ/catalog` | `item?` (substring filter) | `{ok, currency, items:[ShopItem]}` |
| POST `/econ/pay` | `{who, to, amount, note?}` | `{ok, balance, tx}` |
| POST `/econ/shop/buy` (alias `/econ/buy`) | `{who, item, count?=1}` | `{ok, item, count, cost, balance, tx}` |
| POST `/econ/shop/sell` (alias `/econ/sell`) | `{who, item, count?=1}` | `{ok, item, count (actually removed), earned, balance, tx}` |
| GET `/econ/shops` | | `{ok, shops:[Shop]}` |
| POST `/econ/shops` | `{who, name, description?}` | open your shop or rename it → `{ok, shop}` |
| POST `/econ/list` | `{who, item, count, price}` (`price` = coins **each**) | escrows the items → `{ok, listing, removed}` |
| POST `/econ/unlist` | `{who, id}` | items back to the seller → `{ok, id, returned, delivered}` |
| GET `/econ/market` | `item?`, `seller?` | `{ok, listings:[Listing]}` cheapest first |
| POST `/econ/market/buy` | `{who, id, count?=all}` | `{ok, listing, count, cost, balance, delivered, tx}` |
| GET `/econ/auctions` | `all=1` to include every ended one | `{ok, auctions:[Auction]}` |
| POST `/econ/auction` (alias `/econ/auction/create`) | `{who, item, count, start, minutes}` (or `durationSec`) | escrows items → `{ok, auction, removed}` |
| POST `/econ/bid` (alias `/econ/auction/bid`) | `{who, id, amount}` (total for the lot) | holds your coins, refunds the previous bidder → `{ok, auction, balance}` |
| POST `/econ/auction/cancel` | `{who, id}` | only the seller, only with no bids → items back |
| GET `/econ/history` | `who?`, `limit?` (default 50, max 500) | `{ok, tx:[Tx]}` newest first (everyone's when no `who`) |

`delivered:false` means the receiver was offline: the items are queued (see `deliveries`) and given automatically
when they're next online. Limits: count 1–640 per call; price/start/amount 1–1,000,000; auctions 1–1440 minutes.
Minimum next bid = `start` with no bids, else `bid + max(1, ceil(bid × 5%))`. **Anti-snipe**: a bid in the last
30 s pushes the end to now + 30 s. Auctions settle automatically (checked every 2 s): winner gets the items,
seller gets the coins; no bids → items back to the seller. You can't buy your own listing or bid on your own
auction. Raising your own winning bid is allowed (only the difference is taken).

#### `GET /econ/state?who=Steve`
```json
{"ok":true,"world":"world-20261121-184302","currency":"coins","rev":42,"startBalance":100,
 "me":{"name":"Steve","balance":136,"held":55},
 "wallets":{"Steve":136,"Ash":88,"Flint":100},
 "shop":[{"item":"bread","buy":6,"sell":2,"cat":"food"},{"item":"rotten_flesh","buy":null,"sell":1,"cat":"mob drops"}],
 "shops":[{"owner":"Ash","name":"Ash's Lumber","description":"logs and planks","created":1763700000000,"listings":2}],
 "listings":[{"id":7,"seller":"Ash","shop":"Ash's Lumber","item":"oak_log","count":32,"price":2,"ts":1763700000000}],
 "auctions":[{"id":3,"seller":"Flint","item":"diamond","count":3,"start":50,"bid":55,"bidder":"Steve","bids":2,
   "minNext":58,"created":1763700000000,"endsAt":1763700600000,"status":"open","ended":false,"winner":null}],
 "tx":[{"id":91,"ts":1763700000000,"kind":"market_buy","from":"Steve","to":"Ash","amount":20,"item":"oak_log","count":10,"note":"listing #7"}],
 "deliveries":[{"id":4,"to":"Steve","item":"oak_log","count":10,"reason":"listing #7","ts":1763700000000}]}
```
- `me` only when `who` is given; `held` = coins locked in your current highest bids (not in `balance`).
- `shop` = the server shop. `buy` = price you pay per item (`null` = not for sale); `sell` = what the server pays
  per item (`null` = the server doesn't buy it).
- `listings` = all open market listings; `auctions` = open ones plus those ended in the last 10 min.
- `tx` = last 50 involving `who` (everyone's when no `who`), newest first. `deliveries` = queued items not yet given
  (only `who`'s when `who` is given).

#### Types
- **ShopItem** `{item, buy:int|null, sell:int|null, cat}`
- **Shop** `{owner, name, description, created, listings}`
- **Listing** `{id, seller, shop, item, count (remaining), price (each), ts}`
- **Auction** `{id, seller, item, count, start, bid:int|null, bidder:string|null, bids, minNext, created, endsAt,
  status:"open"|"sold"|"unsold"|"cancelled", ended:bool, winner:string|null}`
- **Tx** `{id, ts, kind, from, to, amount, item?, count?, note?}`. `from`/`to` are account names or
  `Server` (shop), `Escrow` (market/auction escrow), `Bank` (starting grant). `kind`: `start`, `pay`, `shop_buy`,
  `shop_sell`, `list` (items into escrow, amount 0), `unlist`, `market_buy`, `auction_create`, `bid_hold`,
  `bid_refund`, `auction_sale`, `auction_unsold`, `auction_cancel`, `deliver` (queued items given).

### WebSocket topic `econ`
Topic name `econ` (in `hello.want`; default: all topics). `init` gains `econ` = the `GET /econ/state` object for
the human player (`init.player.name`). Then, on every change:
```json
{"t":"econ","kind":"wallet","rev":43,"who":"Ash","balance":108,"held":0}
{"t":"econ","kind":"tx","rev":43,"tx":{"id":92,"ts":1763700000000,"kind":"market_buy","from":"Steve","to":"Ash","amount":20,"item":"oak_log","count":10}}
{"t":"econ","kind":"listing","rev":44,"listing":{"id":7,"seller":"Ash","shop":"Ash's Lumber","item":"oak_log","count":22,"price":2,"ts":1763700000000}}
{"t":"econ","kind":"listing_removed","rev":45,"id":7,"reason":"sold"}
{"t":"econ","kind":"auction","rev":46,"auction":{"id":3,"status":"open","bid":58,"bidder":"Ash"}}
{"t":"econ","kind":"auction_ended","rev":47,"auction":{"id":3,"status":"sold","winner":"Ash"}}
{"t":"econ","kind":"shop","rev":48,"shop":{"owner":"Ash","name":"Ash's Lumber","description":"","created":1763700000000,"listings":1}}
{"t":"econ","kind":"sale","rev":49,"text":"Steve bought 10 oak log from Ash for 20 coins","who":["Steve","Ash"]}
{"t":"econ","kind":"reset","rev":0,"world":"world-20261122-090000","state":{"ok":true,"world":"world-20261122-090000"}}
```
`{"t":"econ","kind":"resync","rev":50,"reason":"..."}` = something was rolled back: re-`GET /econ/state`.
(`auction`/`listing` objects are always complete; shortened above.) `listing_removed.reason`: `sold` | `cancelled`.
`reset.state` = full `GET /econ/state` without `me`. `rev` increases by one per change within a world; on a gap,
re-`GET /econ/state`.

### Earning coins (bounties, server jobs, mob bounties, milestones, daily wage)
Server code: `bridge/hub/earnings.js` (uses the economy's money queue; state is per world, inside
`data/economy/<world>.json` under `earn`). Settings: the `earnings` block of `data/econ-catalog.json`
(reloaded live). Test: `node test/earnings-test.mjs` (offline, fake RCON). Every payment is a Tx with its own
`kind` and a ws `{t:"econ",kind:"earn"}` event; the person paid gets a `Market` chat message (doesn't interrupt bots).
All of it is off when the economy is off (`HIVE_ECONOMY=0`): no routes (404), no polling, no reward fields,
`POST /board` with a `reward` → 400. `HIVE_EARNINGS_POLL=0` keeps the economy but stops the scoreboard/time polling
(tests use it so they never touch a live server).

| Source | Who pays | Tx kind (from → to) | Defaults |
|---|---|---|---|
| **Board bounty** | the poster (escrowed) | `bounty_hold` (poster → Escrow), `bounty_paid` (Escrow → claimer), `bounty_refund` (Escrow → poster) | any amount 1–1,000,000 |
| **Server job** | the world | `job_pay` (Server → deliverer, `item`, `count`) | 3–5 jobs per Minecraft day, premium +50% over shop `sell` (min +1) |
| **Mob bounty** | the world | `mob_bounty` (Bank → killer, note "2 zombie, 1 skeleton") | zombie 3, skeleton 3, creeper 4, spider 2, enderman 6, witch 8 … cap 60 coins / player / minute |
| **Milestone** | the world | `milestone` (Bank → player), `world_first` (Bank → player) | first diamond 25, deepslate diamond 30, emerald 20, ancient debris 60, Nether 40, End 100; world-first bonus +50% |
| **Daily wage** | the world | `wage` (Bank → player) | 10 coins to everyone online at each Minecraft sunrise (0 = off) |

**Board bounties.** A board task can carry a reward. `POST /board {by,title,…,reward}` (and `board_add`) escrows
`reward` coins from `by` first: not enough coins → 409 and no task is created. Anyone can add coins to an existing
task (`POST /econ/bounty {who,task,amount}`). The task object gets `reward` (total coins), `rewardStatus`
(`open`|`paid`|`refunded`) and `rewardTo` (who was paid). When the task's status becomes `done` (whoever marks it):
the **owner** (claimer) is paid the whole reward; funders get a "paid" notice. Refunds (each funder gets their own
share back): task deleted; marked done with no owner; the owner is a funder (you can't pay yourself — their own share
comes back, the others' shares are paid to them); a funder withdraws with `POST /econ/bounty/cancel {who,task}`
(only while nobody else has claimed the task). A claimer releasing the task (status `open`) keeps the bounty open for
the next claimer.

**Server jobs.** The server posts 3–5 jobs from the catalog's pool each Minecraft day (when `time query day`
advances; every `fallbackMinutes`=30 real minutes if the day doesn't advance, e.g. daylight cycle off). Each job wants
`count` items in total and pays `pay` coins **each** (above the shop's sell price), first come first served. Deliver
with `POST /econ/jobs/deliver {who,id,count?}`: the items are taken from the deliverer's inventory with RCON `clear`
(at most what the job still wants) and you're paid only for what was actually removed. Unfilled jobs expire at the
next rotation (nothing is escrowed). The premium price is `max(sell+1, ceil(sell × (100+premiumPct)/100))`, capped at the shop's buy
price − 1 so buying from the shop to deliver never profits; a pool entry may set `pay` (coins each) instead.

**Mob bounties + milestones** are detected for every player (bots and the human) server-side with scoreboard
objectives the bridge creates over RCON on world load (`hm_<mob>` = `minecraft.killed:minecraft.<mob>`,
`hx_<block>` = `minecraft.mined:minecraft.<block>`; names ≤ 16 chars, longer ones = first 13 chars + a 3-char hash,
e.g. `hm_wither_skel` + hash). Creating is idempotent ("already exists" is fine). Every `pollSec`=25 s it reads
`scoreboard players list <player>` for each online player and pays the increase since the last read (last-seen
counts are saved, so a bridge restart never pays a kill twice; the first read of a player only sets the baseline).
Kills over the per-minute cap are not paid (and not carried over). Milestones are once per player per world; the
first player in the world to reach one also gets `world_first`. Nether/End: bots from their bot state, others from
RCON `data get entity <player> Dimension`.

**Daily wage** is paid once per Minecraft day (when the day number from `time query day` goes up) to every online
player with an account.

#### Earnings endpoints
| Method & path | Body / query | Returns |
|---|---|---|
| GET `/econ/jobs` | | `{ok, jobs:[Job], nextRotation}` |
| POST `/econ/jobs/deliver` | `{who, id, count?=all it still wants}` | `{ok, job, count (removed), earned, balance, tx}` |
| GET `/econ/bounties` | `all=1` to include paid/refunded | `{ok, bounties:[Bounty]}` |
| POST `/econ/bounty` | `{who, task, amount}` | escrows `amount` onto task `task` → `{ok, bounty, balance}` |
| POST `/econ/bounty/cancel` | `{who, task}` | refunds your share → `{ok, bounty, refunded, balance}` |
| GET `/econ/earnings` | `who?` | with `who`: `{ok, rates, day, nextSunrise, who, totals:{mob,job,bounty,milestone,wage,all,today}, milestones:[Milestone], recent:[Tx]}`; without: `{ok, rates, day, nextSunrise, totals:{name:{mob?,job?,…}}, today:{name:coins}}` |
| POST `/board` | `{by, title, detail?, priority?, reward?}` | the task (with `reward` when funded) |

`GET /econ/state` also carries `jobs`, `bounties` (open) and `earnings` (the `GET /econ/earnings` object for `who`).

- **Job** `{id, item, count (wanted in total), left, pay (each), shopSell, delivered:{name:n}, created, expiresAt, status:"open"|"filled"|"expired"}`
- **Bounty** `{task, title, total, funders:{name:coins}, status:"open"|"paid"|"refunded", owner, paidTo, created, ended?}`
- **Earn rates** (`rates`): `{mobs:{zombie:3,…}, mobCapPerMinute (0 = no cap), milestones:[{id,label,reward,first}], wage, jobPremiumPct, bounties:bool}`
- **Milestone** `{id, label, reward, first (world-first bonus coins), done:bool, ts?, firstBy? (who got the world first), worldFirst?:bool (it was you)}`
- `totals.today` = coins earned since the current Minecraft day began (last sunrise; local midnight while the bridge
  has never read MC time). `nextSunrise` = epoch-ms estimate from `time query daytime` (null if unknown); it is also
  when the next jobs are posted (`nextRotation`). `day` = Minecraft day number.
- New Tx kinds: `bounty_hold`, `bounty_paid`, `bounty_refund`, `job_pay`, `mob_bounty`, `milestone`, `world_first`, `wage`.
  New system account: none (`Bank` pays mob/milestone/wage, `Server` pays jobs, `Escrow` holds bounties).

ws (topic `econ`):
```json
{"t":"econ","kind":"earn","rev":51,"source":"mob","who":"Ash","amount":6,"balance":120,"text":"2 zombie"}
{"t":"econ","kind":"earn","rev":52,"source":"job","who":"Steve","amount":48,"balance":184,"text":"32 cobblestone for job #4"}
{"t":"econ","kind":"earn","rev":53,"source":"bounty","who":"Flint","amount":30,"balance":130,"text":"task #12 Mine 24 iron"}
{"t":"econ","kind":"earn","rev":54,"source":"milestone","who":"Ash","amount":25,"balance":145,"text":"first diamond","id":"diamond","worldFirst":true}
{"t":"econ","kind":"earn","rev":55,"source":"wage","who":"Ash","amount":10,"balance":155,"text":"day 5"}
{"t":"econ","kind":"jobs","rev":56,"jobs":[{"id":4,"item":"cobblestone","count":32,"left":0,"pay":2,"status":"filled"}],"nextRotation":1763701200000}
{"t":"econ","kind":"bounty","rev":57,"bounty":{"task":12,"title":"Mine 24 iron","total":30,"status":"paid","paidTo":"Flint"}}
```
(`wallet`/`tx` events are sent too, as for every money movement.)

Terminal commands (as the human player): `jobs` (clickable `deliver <id>`), `deliver <id> [n]`, `bounties`,
`bounty <taskId> <coins>` (add/raise), `bounty <taskId> cancel`, `earnings [who]`, `board add <text> [$coins]`
(e.g. `board add Build a bridge $50`).

### Terminal commands (as the human player; `POST /mod/command` or WS `command`)
| Command | What it does |
|---|---|
| `bal [who\|all]` | your balance (or someone's / everyone's) |
| `pay <who> <n> [note]` | give coins |
| `shop [item]` | server shop prices (filtered); lines click to `buy <item> 1` |
| `buy <item> [n]` / `sell <item> [n]` | trade with the server shop (sell takes items from your inventory) |
| `market [item]` | open listings (each line clickable `buyl <id>`) |
| `list <item> <n> <price-each>` | list items from your inventory on the market |
| `unlist <id>` | cancel your listing, items come back |
| `buyl <id> [n]` | buy from a listing (default: all of it) |
| `myshop <name…>` | open / rename your shop |
| `auctions` | open auctions |
| `auction <item> <n> <start> <minutes>` | start an auction |
| `bid <id> <amount>` | bid (total for the lot) |
| `econ` | summary: world, your balance, richest, open listings/auctions, recent sales |
| `jobs` | server jobs (lines click to `deliver <id>`) |
| `deliver <id> [n]` | deliver items from your inventory to a server job |
| `bounties` | board tasks with a coin reward |
| `bounty <taskId> <coins>` / `bounty <taskId> cancel` | add/raise a bounty / take your share back |
| `earnings [who]` | totals (today, by source), mob rates, milestones, daily wage |
| `board add <text> $<coins>` | add a task with a bounty (escrowed from you) |
