# Hivecraft — Claude Code agents playing Minecraft as a team

Goal: several headless **Claude Code** sessions (model `claude-sonnet-5-5`) each control one Minecraft bot,
talk to each other, share a task board, and cooperate well on long goals (e.g. "build a base, get iron gear,
find diamonds"). The human player watches on a web dashboard and can join the server themselves.

Root: the app folder (ESM Node project, `"type":"module"`, Node 24). Deps already installed:
mineflayer 4.39, mineflayer-pathfinder, mineflayer-collectblock, mineflayer-pvp, mineflayer-tool,
mineflayer-auto-eat, vec3, minecraft-data, @modelcontextprotocol/sdk, zod 4, ws. Ask the lead to add others.

## Processes

| Process | Command | Port |
|---|---|---|
| Minecraft server (vanilla **1.21.1**, offline mode) | `server/` — `java -Xmx3G -jar server.jar nogui` | **25590**, RCON 25591 (password = `server.rconPassword` in `hivecraft.config.json`, random per install) |
| Bridge (all bots + hub + dashboard) | `node bridge/server.js` | **47960** (127.0.0.1) |
| Crew (launches the Claude Code players) | `node crew/crew.js` | — |
| MCP server (one per player, started by Claude Code) | `node mcp/mc-mcp.js` with env `HIVE_BOT=<name>`, `HIVE_URL=http://127.0.0.1:47960` | stdio |

Note: mineflayer prints one harmless `PartialReadError ... ArmorTrimMaterial` on join with 1.21.1. Bots still work
(health/food/recipes OK). Filter that noise, don't chase it.

## 1. Engine — `bridge/engine/` (mineflayer)

`bridge/engine/index.js` exports:

```js
export const ACTIONS   // array of { name, description, params }  params = JSON Schema object ({type:'object', properties, required})
export async function spawnBot({ name, host='127.0.0.1', port=25590, version='1.21.1' }) // -> BotHandle, resolves after 'spawn'
```

`BotHandle`:
- `name`, `bot` (the mineflayer bot), `online` (bool)
- `getState()` → plain JSON observation (see below), cheap, sync
- `async run(actionName, args, { signal })` → resolves to a **short plain-text or JSON result** that tells the model what
  happened (e.g. `"Collected 5 oak_log (inventory now 7)."`), throws `Error` with a helpful message on failure
  (e.g. `"No iron_ore within 64 blocks. Nearest stone at ..."`). Must respect `signal` (abort → stop pathfinder/digging, throw "Stopped").
- `stop()` – abort current action, clear pathfinder goal, stop digging/attacking
- `quit()`
- it is an EventEmitter: `'chat' {username, message}` (all player chat, including other bots), `'event' {kind, text}`
  (death, respawn, hurt, low_food, kicked, item_picked_up, night_fell, etc.), `'offline' {reason}`.

`getState()` shape (keep it compact, the model reads it often):
```json
{ "name":"Ash", "online":true, "pos":{"x":1,"y":64,"z":2}, "dimension":"overworld", "health":20, "food":18,
  "time":{"timeOfDay":6000,"isDay":true}, "biome":"forest", "held":"stone_pickaxe",
  "inventory":[{"name":"oak_log","count":7}], "armor":["iron_helmet",null,null,null],
  "nearbyEntities":[{"type":"player|hostile|animal|item|other","name":"zombie","distance":7.2,"pos":{...}}],
  "nearbyBlocks":{"oak_log":{"count":12,"nearest":{"x":..}},"iron_ore":{...}},   // interesting blocks within ~16
  "currentAction":"collect", "modes":{"self_defense":true,"auto_eat":true,"pickup_items":true} }
```

Required actions (names exact; params in JSON Schema; all positions integers):
`goto {x,y,z,range?}`, `goto_player {player,range?}`, `follow {player, distance?}` (until stopped / next action),
`collect {block, count}` (find, path, pick best tool, mine, pick up drops; accepts generic names like `log`/`any_log`),
`mine_block {x,y,z}`, `find_blocks {block, max_distance?, count?}`, `scan {radius?}` (summary of surroundings),
`craft {item, count?}` (auto place/walk to crafting table if needed, crafts planks/sticks prerequisites? — at minimum
explain exactly what is missing), `recipe {item}` (ingredients + can-craft-now), `smelt {item, count?, fuel?}`,
`place {block, x,y,z}`, `build {blocks:[{x,y,z,block}]}` (batch place in a sensible order, report failures),
`equip {item, slot?}`, `eat {item?}`, `attack {target, count?}` (mob type or player), `give {player, item, count?}`
(walk to player, toss), `drop {item, count?}`, `chest_view {x,y,z}`, `chest_deposit {x,y,z, items?}` (omit = all but tools/food),
`chest_withdraw {x,y,z, items:[{name,count}]}`, `sleep {}` (nearest bed), `set_mode {mode, on}`, `wait {seconds}`,
`stop {}`, `run_code {code}` (escape hatch: async JS body with `bot, Vec3, goals, mcData, log` in scope, 60 s timeout,
returns what it `log()`s).
Auto modes run while idle/between actions: self_defense (fight hostiles that come close), auto_eat, pickup_items,
unstuck (detect no progress while pathing), avoid lava/drowning. Engine must survive night and deaths (respawn automatically).

## 2. Bridge + hub — `bridge/server.js`, `bridge/hub/`, `bridge/public/`

HTTP JSON API on 127.0.0.1:47960. Hosts BotHandles from the engine. One action at a time per bot: a second `/act`
while busy returns `{ok:false,error:"busy: <action>"}` unless `interrupt:true`. Auto-reconnect a bot that goes offline.
Persists hub state to `data/hub.json`, agent memory to `data/memory/<name>.md`.

| Method & path | Body / query | Returns |
|---|---|---|
| GET `/health` | | `{ok:true}` |
| GET `/actions` | | engine `ACTIONS` |
| POST `/bots` | `{name, role?}` | spawns (idempotent) → summary |
| GET `/bots` | | `[{name, role, online, pos, health, food, currentAction}]` |
| DELETE `/bots/:name` | | quits bot |
| GET `/bots/:name/state` | | engine `getState()` + `recentEvents` (last 10) |
| POST `/bots/:name/act` | `{action, args, timeoutMs?=180000, interrupt?}` | `{ok:true,result}` / `{ok:false,error}` |
| POST `/bots/:name/stop` | | `{ok:true}` |
| POST `/msg` | `{from, to:"all"|name, text}` | message (also said in MC chat by the `from` bot as `@to text`; non-bot senders like the human player allowed) |
| GET `/msg/:name` | `?since=<id>&wait=<sec 0-60>` | `{messages:[{id,from,to,text,ts}], cursor}` long-poll; to name or all, excluding own. **In-game chat from human players is also delivered as messages** (from = player name, to = "all"). Bot `event`s for this bot are included as `{from:"system"}` messages. |
| GET `/unread/:name` | `?since=<id>` | `{count}` |
| GET `/board` | | tasks `[{id,title,detail,status:open|claimed|done|blocked,owner,priority,by,notes[],updated}]` |
| POST `/board` | `{by,title,detail?,priority?}` | task |
| POST `/board/:id/claim` | `{by}` | task, or 409 if claimed by another |
| POST `/board/:id` | `{by,status?,note?,owner?}` | task |
| GET/POST `/notes` | POST `{by,key,text}` (upsert) | shared team knowledge |
| GET/POST `/waypoints` | POST `{by,name,x,y,z,note?}` | named places (base, chest, mine…) |
| GET/POST `/memory/:name` | POST `{text}` (replace) | private persistent memory for one agent |
| GET/POST `/goal` | POST `{text}` | team goal |
| POST `/log/:name` | `{kind: thought|tool|result|error|system, text}` | crew posts each agent's stream here |
| GET `/events` | SSE | every msg, board/note/waypoint change, log line, and a bots snapshot each second |
| POST `/admin/rcon` | `{cmd}` | RCON passthrough (for crew/setup only — never exposed as an agent tool) |

Dashboard at `/` (`bridge/public/`): per-bot cards (health, food, pos, held, inventory, current action, last thought),
team chat feed, task board, notes/waypoints, a top-down map of bot positions + waypoints, and a per-agent log of
thoughts/tool calls. The human must be able to post to the team (as their `player.displayName`) and set the goal from the dashboard.

## 3. MCP + crew — `mcp/`, `crew/`

`mcp/mc-mcp.js`: stdio MCP server for ONE bot (`HIVE_BOT`). On start it fetches `GET /actions` and registers each action
as a tool (same name, JSON schema → tool inputSchema), calling `POST /bots/:name/act`. Plus team tools:
`status` (own state), `team_status` (all bots), `send_message {to,text}`, `check_messages {wait_seconds?}` (long-poll,
cursor kept in-process), `board`, `board_add`, `board_claim`, `board_update`, `notes`, `note_write`, `waypoints`,
`waypoint_save` (default to current position), `memory_read`, `memory_save`, `goal`.
**Every tool result ends with an unread-messages line** (e.g. `📨 2 unread messages — call check_messages`) so agents never miss teammates.

`crew/crew.js`: reads `crew/roster.json` (names, roles, model) and goal; ensures bridge up; `POST /bots` per agent;
launches one Claude Code per agent (path from `hivecraft.config.json` `runtime.claude`, else PATH / `~/.local/bin` / npm global;
see `claudeSpawn` in `bridge/config.js`): `-p`, `--model claude-sonnet-5-5`, `--output-format stream-json --verbose`,
`--mcp-config <generated file> --strict-mcp-config`, only the `mcp__mc__*` tools allowed (no Bash/Edit/Write/Web),
role prompt via `--append-system-prompt`, cwd `crew/work/<name>/`. Streams each agent's thoughts/tool calls to
`POST /log/:name`. When a session ends, relaunch it with `--resume <session_id>` and a "keep playing" prompt; after
N resumes (context bloat) start fresh, seeding from the agent's `memory`. `--minutes` cap, clean shutdown on Ctrl-C.
`crew/prompts/` = shared team rules + role prompts (Lead/planner, Miner, Builder, Gatherer/Farmer).

Teamwork rules baked into prompts: lead posts a plan as board tasks; everyone claims before working; report results
in chat briefly; share coordinates via waypoints; put shared resources in the base chest; ask teammates instead of
duplicating; check messages between actions; keep messages short; save memory before long tasks.

## Top level
`start.ps1` (server → bridge → crew), `stop.ps1`, `README.md`.
