# Hivecraft

Several headless Claude Code agents (model `claude-sonnet-5-5`) each control one Minecraft bot, talk to each other, share a task board, and work toward a long goal. You watch on a dashboard and can join the server or type to the team.

```
Minecraft server (1.21.1, :25590) <- bridge (bots + hub + dashboard, :47960) <- MCP server (one per agent) <- claude.exe (one per agent) <- crew.js
```

## Easiest: Hivecraft.exe

Double-click `Hivecraft.exe`: type the agents' names, pick the model, press **START**. It makes a new world, starts the server, bridge and agents, and opens the Minecraft Launcher with a **Hivecraft** installation that joins the server automatically when you press PLAY. The agents join, agree roles among themselves in chat, greet you and wait. Tell them their task in Minecraft chat; your messages interrupt whatever they're doing. No time limit; **TERMINATE** stops everything.

Under the hood that's `node crew/crew.js --names Ash,Flint,Wren --minutes 0` (agents with no preset roles, prompts `team.md` + `teammate.md`).

## Run it by hand

```powershell
cd <your Hivecraft folder>        # the folder with bridge/, crew/, hivecraft.config.json
.\start.ps1                       # server -> bridge -> crew (all in one), or start them separately:

# 1. Minecraft server (offline mode, port 25590)
cd server; java -Xmx3G -jar server.jar nogui
# 2. Bridge + dashboard  ->  http://127.0.0.1:47960
node bridge/server.js
# 3. The team
node crew/crew.js                                  # Ash (Lead), Flint (Miner), Wren (Gatherer)
node crew/crew.js --agents 5 --minutes 90          # + Moss (Builder), Lark (Scout), stop after 90 min
node crew/crew.js --goal "Build a castle with a wall and a farm"
```

Join the game yourself: Minecraft Java **1.21.1**, server `localhost:25590`.
Talk to the agents: type in the dashboard (as your player name from `hivecraft.config.json`) or in Minecraft chat. They answer you first. Set a new goal from the dashboard too (`/goal`). Ctrl-C in the crew window stops everyone cleanly.

`crew.js` options: `--agents N` (1-5 named roster, more = extras), `--minutes N` (0 = until Ctrl-C), `--goal "..."`, `--model`, `--effort low|medium|high`, `--max-resumes 3`, `--stagger 6` (seconds between agent starts), `--url` (bridge), `--roster file`. Claude Code is found via `runtime.claude` in `hivecraft.config.json`, else `PATH`, `~/.local/bin`, or the npm global install; env `CLAUDE_BIN` overrides it.

### hivecraft.config.json

One file in the app folder (written by the setup wizard / `Hivecraft.exe`; read by the bridge, MCP server and crew through `bridge/config.js`). A missing file means defaults (player `Player`). Env vars override it (`HIVE_PLAYER`, `HIVE_PLAYER_NAME`, `HIVE_PORT`, `MC_PORT`, `HIVE_RCON_PORT`, `HIVE_RCON_PASSWORD`, `CLAUDE_BIN`, `HIVE_CONFIG` = another file). API keys are never stored in it.

```json
{ "version": 1,
  "player":    { "mcName": "Steve", "displayName": "Steve" },
  "provider":  { "kind": "claude-login", "baseUrl": "", "model": "claude-sonnet-5-5", "smallModel": "" },
  "runtime":   { "node": "node", "java": "java", "claude": "" },
  "server":    { "dir": "server", "port": 25590, "rconPort": 25591, "rconPassword": "<random per install>" },
  "bridge":    { "port": 47960 },
  "minecraft": { "dir": "" } }
```

`player.displayName` is what the agents (and the economy) call you; `player.mcName` is your Minecraft username (an alias for the same account). `server.rconPassword` must match `rcon.password` in `server/server.properties` (if it is missing from the config, the bridge reads it from there).

## How the team works

- **Agents only have the `mcp__mc__*` tools** (no Bash/files/web). `mcp/mc-mcp.js` turns every engine action (goto, collect, craft, smelt, build, chest_*, ...) into a tool and adds team tools: `send_message`, `check_messages` (long-poll), `board*`, `notes`, `waypoints`, `memory_*`, `goal`. Every result ends with an unread-messages line.
- **The Lead plans** as board tasks; everyone claims a task before working, reports briefly in chat with coordinates, saves waypoints (base, base_chest, mines), and deposits surplus in the base chest.
- **Sessions end sometimes.** crew.js relaunches the agent with `--resume <session>`; after 3 resumes or on errors it starts fresh seeded from the agent's saved `memory`, so agents save memory before long tasks.
- **Survival help from the engine:** every action result ends with a `⚠` line when the bot is hungry, low on health, has no pickaxe or a tool about to break. `collect` reports drops a teammate grabbed ("3 picked up by Ash").

## Agent tools added for robustness (Nov 2026)

Engine actions live in `bridge/engine/actions.js` (core), `actions-robust.js` (escape/hunt/perception), `actions-viewer.js` (eyes) and `actions-build.js` (blueprints); `actions.js` imports the last two tolerantly (the engine still starts if one is missing or broken). Defs with `internal:true` are hidden from `GET /actions`.

| Tool | What it does |
|---|---|
| `escape` | Gets out of a hole / pit / cave / box / water **without a pickaxe**: swim up, walk to an existing opening, open doors, hand-dig dirt/gravel/sand/leaves (stone slowly), pillar with any block, staircase up; then steps onto open ground. Says what is missing if it can't. |
| `surface` | Same engine, aimed straight up (optional `y`). |
| `goto` | Any distance: splits far trips into ~48-block hops with detours, climbs out first when deep underground, returns progress ("call goto again") instead of timing out; failures end with `Why: … Try: …` (wall, water, cliff, unloaded chunks, boxed in, no pickaxe). Stuck detection now digs itself free before giving up; swims out of water when the pathfinder can't. |
| `hunt` | Reliable passive-mob kills: nearest *reachable* animal (path check), sprint chase without digging detours, hits on cooldown, lures with wheat/carrots/seeds, collects drops. `attack` on passive mobs uses it too. |
| `look_around` | Text "eyes": N/E/S/W at feet/head (wall/open/drop/water/lava), above/below, TRAPPED/underground detection + way out, ores/trees/chests/beds, creatures, dangers. |
| `nearest` | Nearest block / mob / player / dropped item with real walking distance (flags unreachable). |
| `inventory` | Exact counts, tool durability, food points, armor, free slots. |
| `blocks_at` | Real blocks at a point (with neighbours) or in a box (≤4096). |
| `use_block` / `use_item` | Doors, levers, trapdoors, gates / hoe, bucket, bone meal, shears, feeding, potions. |
| `craft_plan` | Full recipe tree vs inventory + chests opened this session; lists missing raw materials and where they come from. |

Fixes: crafting with a full inventory used to lose the result ("server did not deliver …"): now checked up front, and auto-eat/auto-equip pause while crafting/smelting; a failed craft resyncs the inventory and re-plans once. `craft` errors name each missing item and its source. `place` puts things on top when given the ground block, tills farmland for seeds (with a hoe), finds a valid facing for beds, checks sapling soil, accepts wall torches. `sleep` tries other beds when one is occupied. `smelt` clears a furnace input slot holding another item (was "destination full") and checks room for the output. `eat` falls back to eating directly when auto-eat refuses. `collect cobblestone` mines stone. Chest opening retries once and explains a blocked lid.
Viewer (`survey`, `view`, `team_map`, `photo_*`; images are limited to ~20/min per agent, `HIVE_VIEW_RATE` overrides; `view` shows any angle: orbit `angle` 0-360 + `elevation` -89..89 around any point, or a free camera anywhere with `look_x/y/z` or `yaw`/`pitch`, plus `zoom`/`fov`) and blueprint tools (`find_build_site`, `site_survey`, `blueprint_*`) are documented in their own sections / the prompts. `node tools/logmine.mjs [uses|errs|rc]` summarizes tool use and failures in `crew/logs`.
- Prompts are plain Markdown: `crew/prompts/team.md` (rules for all) + `lead|miner|gatherer|builder|scout.md`. Edit them to change behaviour; roster/names/goal in `crew/roster.json`.

## Files

- `crew/logs/<name>.jsonl` raw Claude stream per agent (all tool calls and results); `crew/work/<name>/` generated `mcp.json` + message cursor.
- Dashboard shows each agent's thoughts and tool calls live (the crew posts them to the bridge).
- Cost: each agent is a continuously running Sonnet session; budget roughly a few dollars per agent-hour. Use `--minutes`.

## Stop / watch / world

- `.\stop.ps1` stops crew, bridge and server (`-KeepServer` keeps Minecraft up). `.\start.ps1 -NoCrew` = server + bridge + dashboard only.
- `node test/peek.mjs` prints bots, chat, board, waypoints and each agent's last log lines in the terminal.
- World: seed `153324740045603` (plains spawn with animals). The first jungle test world is kept as `server/world-jungle-test`; old hub state in `data/archive-jungle-test`. For a new world: stop, rename `server/world`, change `level-seed` in `server/server.properties` (`node tools/seedscan.mjs` finds a plains/forest seed with animals), start.

## Tests

```powershell
node test/mcp-test.mjs          # MCP server vs a mock bridge, with a real MCP client
node test/crew-test.mjs         # crew.js + one real claude agent against the mock for ~1.5 min (costs ~$0.10)
node test/hub-api.mjs           # bridge/hub API vs a mock engine (16 checks)
node test/engine-smoke.mjs      # engine vs the LIVE server (needs it running; builds a test arena at x 200..232 via RCON)
node test/robust-check.mjs      # LIVE robustness scenarios at x -490..-560 (pits without pickaxe, water, sealed room, hunting, crafting, beds/seeds, far goto); refuses if a human is online
```

## Hivecraft Overlay mod

A Fabric client mod (`mod/`, 1.21.1) that shows what the bots are doing inside Minecraft and lets you command them. It talks to the bridge at `127.0.0.1:47960` (WebSocket `/mod` + HTTP `/mod/*`, protocol in `MOD_PROTOCOL.md`; server side `bridge/hub/mod-api.js`, `bridge/hub/mod-commands.js`, block ledger `bridge/engine/ledger.js`).

**Install (automatic).** When Hivecraft.exe opens Minecraft it makes the **Hivecraft** profile run **Fabric Loader** (latest stable for 1.21.1 from meta.fabricmc.net; libraries go to `.minecraft\libraries`) with its own game folder `%APPDATA%\.minecraft\hivecraft`. Its `mods\` gets **Fabric API** (latest 1.21.1 release from Modrinth, checksum-verified) and the newest jar from `mod\build\libs` (copied as `hivecraft-overlay.jar`). Your `options.txt` is copied into that folder the first time. Auto-join to `localhost:25590` still works. Other profiles and the default game folder are not touched. Offline it reuses what is already installed. If anything is missing (mod not built, no network on the first run…) the launcher log says `Overlay mod not installed: <reason>` and the profile starts plain Minecraft with auto-join. Build the mod first: `cd mod; .\gradlew build`. Config: `.minecraft\hivecraft\config\hivecraft.json` (`bridgeUrl`, `playerName`, every overlay toggle, keys).

**Keys** (Options → Controls → **Hivecraft**):

| Key | What |
|---|---|
| `` ` `` (grave) | Terminal |
| `H` | Control screen: tabs **Bots · Board · Album · Map · Ledger · Toggles** (`1`-`6` switch tabs) |
| `J` | Toggle the team HUD |
| `K` | Cycle the focused bot |
| `O` | Toggle the whole world overlay |
| `I` | Block attribution filter: all bots → Ash → Flint → … → all |
| unbound | Spectate focused bot (also the **Watch** button on a bot card, or `spectate <bot>`; again = back), toggle bot labels, trails & paths, block attribution, ghost builds, labels through walls |

Move the HUD: Control → Toggles → **Move HUD…** (drag the panels). All overlay toggles are also in Control → Toggles.

**In the world:** bots glow in their colour through walls with a label (name, role, current action like `mining iron ore 12/24`, health/food bars, progress, held item); fading trail ribbons, the planned path as a pulsing line and a beacon at the target; blocks a bot placed get a tint and broken blocks an outline (fading over 5 min); look at a block for `Placed by Ash · 3m ago · house build …`; planned builds and `blueprint_preview`s show as ghost blocks with real textures (current layer pulsing, conflicts red, progress %); waypoint beams with labels and distance; little icons when a bot places, mines, crafts or attacks.

**Terminal:** Tab completes, ↑/↓ history, PgUp/PgDn/wheel scroll, click underlined output to run it, `Ctrl+T` or `chat [bot]` = chat-to-team mode; local commands `clear`, `history`, `chat`, `spectate`, `exit`. Server commands (you act as **your player**; your position is sent with each command):

| Command | What it does |
|---|---|
| `help [cmd]` | list commands / usage |
| `bots` | one line per bot: online, ♥/food, what it is doing, position, distance |
| `status <bot>` | vitals, position, held item, inventory, action, claimed task, last thought/chat/events |
| `where <bot>` | position + distance and compass direction from you |
| `say <bot\|all> <msg>` | message the team as you (interrupts their current action, like dashboard chat) |
| `goal [text]` | show / set the team goal |
| `board` · `board add <text>` · `board done\|open\|blocked <id>` | task board |
| `stop <bot\|all>` | stop the current action |
| `come <bot\|all>` | tells them and walks them to you (`goto`) |
| `follow <bot>` | the bot follows you (`stop <bot>` ends it) |
| `who <x> <y> <z>` | which bot placed/broke that block, when and why (bare `who` = the block you look at) |
| `placed <bot\|all> [minutes]` | blocks placed/broken lately (default 10 min) |
| `builds` | running builds and previews with progress |
| `photos [bot]` · `photo <id>` | latest album photos / open one |
| `log <bot> [n]` | the bot's recent tool calls, results and thoughts |

`pause`/`resume` don't exist (the crew can't pause an agent); use `stop`.

**Block ledger:** every block a bot places or breaks (actions, blueprint builds incl. scaffolding, pathfinder digging/bridging, escape pillars, auto behaviours) is logged with bot, block + state, position, time and cause in `data\ledger\YYYY-MM-DD.jsonl` (last 3 days loaded into memory, capped). Query: `GET /mod/ledger?x1=&y1=&z1=&x2=&y2=&z2=&bot=&since=`, `GET /mod/ledger/at?x=&y=&z=`.

Tests (offline): `node test/mod-api-test.mjs` (ledger, engine hook on a fake bot, the mod API + every command against the mock engine on :47975); `Hivecraft.exe --selftest` (launcher file transforms incl. Fabric/profile; `--selftest-net` also installs Fabric + Fabric API into a temp folder).
