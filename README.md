# Hivecraft

AI agents that play Minecraft: Java Edition as a team — with you.

Each agent is an AI (Claude Code, or another model you choose) that controls one bot on a private Minecraft
server running on your PC. They plan together on a task board, talk in chat, mine, build and farm, and work on
whatever goal you give them. You watch from the dashboard or join the world in your own Minecraft and talk
to them in chat.

---

## 1. Before you install

You need:

1. **Windows 10 or 11, 64-bit**, ~2.5 GB free disk space, 8 GB RAM or more recommended.
2. **Minecraft: Java Edition** that you own, and the official **Minecraft Launcher** installed and logged in
   once. Hivecraft does not include or sell Minecraft. (The AI bots don't need accounts; they join your local
   server in offline mode.)
3. **An AI provider** for the agents — one of:
   | Option (in the setup) | What you need | Who you pay |
   |---|---|---|
   | **Claude subscription** | a Claude Pro, Max or Team plan; you log in once (`claude auth login`), no key | your subscription — agents use its usage limits |
   | **Anthropic API key** | a key from console.anthropic.com | Anthropic, per token |
   | **OpenRouter** | a key from openrouter.ai | OpenRouter, per token |
   | **Other API (Anthropic-compatible)** | base URL + key + model id (e.g. DeepSeek, Kimi, GLM, a LiteLLM proxy) | whoever runs it |
   | Advanced: **Amazon Bedrock**, **Google Vertex AI** | your cloud account set up for Claude | your cloud provider |

   Non-Claude models work but may play noticeably worse.

> ⚠ **Costs.** Every agent is a full AI session that keeps thinking and calling tools while it plays.
> With an API key, expect roughly a few dollars **per agent per hour** on a Sonnet-class model — more with bigger
> models, higher effort or more agents. Start with 1–2 agents and a short
> session, check your provider's usage page, and set a spending limit there. On a subscription, several agents
> drain your plan's usage limits fast. The provider **Test** button sends one tiny request (a fraction of a cent). **TERMINATE** in the launcher stops all agents immediately.

## 2. Install

1. Download `Hivecraft-Setup.exe` (and optionally `Hivecraft-Setup.exe.sha256` to check the download:
   `Get-FileHash .\Hivecraft-Setup.exe` in PowerShell must print the same hash).
2. Double-click it. Windows SmartScreen may warn about an unknown publisher: **More info → Run anyway**.
3. Follow the wizard:
   - **Folder** — default `%LOCALAPPDATA%\Programs\Hivecraft` (no admin rights needed; needs ~2.5 GB free).
   - **Minecraft EULA** — the server is Mojang's; you must accept their EULA to run it.
   - **You** — your Minecraft player name (so the agents recognise you in chat) and the name they call you.
   - **AI provider** — pick one of the options above, paste a key if needed, choose a model, press **Test**.
   - **Install** — downloads what's missing (below), then offers to open Hivecraft.

### What gets downloaded and why

Nothing is installed system-wide; everything lands in your Hivecraft folder.

| Download | Why | Approx. size | From | Goes to |
|---|---|---|---|---|
| Node.js (portable, current LTS) | runs the bots, bridge and dashboard | ~30 MB | nodejs.org | `<folder>untime
ode` |
| Java runtime (Eclipse Temurin 21 JRE) | runs the Minecraft server | ~45 MB | api.adoptium.net (file served from github.com/adoptium) | `<folder>untime\java` |
| Minecraft server 1.21.1 (`server.jar`) | the private world the agents play in | ~50 MB | Mojang (piston-data.mojang.com) | `<folder>pp\server` |
| Bot libraries (npm packages) | Minecraft bot engine (mineflayer), pathfinding, MCP | ~250 MB on disk | registry.npmjs.org | `<folder>pp
ode_modules` |
| Fabric Loader + Fabric API (first START, by the launcher) | lets your Minecraft load the Hivecraft overlay mod | ~5 MB | meta.fabricmc.net, Modrinth | `%APPDATA%\.minecraft` (a separate **Hivecraft** profile + `hivecraft` game folder) |
| Claude Code (only if you click *Install* on the Claude provider step) | the agent runtime | ~100 MB | Anthropic's official installer | `%USERPROFILE%\.localin` |

Total ≈ 375 MB of downloads; plan for ~2.5 GB of disk including worlds.

Node.js, Java and the Minecraft server are verified against their publishers' checksums (SHA-256 / SHA-1)
before use; npm packages are verified by npm against `package-lock.json`. If a runtime that is new enough is
already on your PC (Node 20+, Java 21+), the installer reuses it instead of downloading. The installer itself
contains only Hivecraft's own code and the overlay mod; it never bundles Minecraft files.

## 3. Play

1. Open **Hivecraft** (Start Menu or desktop shortcut).
2. Type your agents' names (or keep the suggestions), pick the model, press **START**.
   Hivecraft creates a world, starts the server and the agents, and opens the Minecraft Launcher with a
   **Hivecraft** installation selected.
3. Press **PLAY** in the Minecraft Launcher. You join the server automatically.
4. The agents join, introduce themselves and wait. **Tell them what to do in Minecraft chat**, e.g.
   *"build a wooden house with a farm next to the river"*. Your messages interrupt whatever they are doing.
5. Watch on the dashboard (the launcher has a button for it; it runs at `http://127.0.0.1:47960`) or in game.
   In game, press **H** for the control screen, **`** (backtick) for the terminal, **J** for the team HUD.
6. Press **TERMINATE** in the launcher to stop everything.

Your other Minecraft installations and worlds are not touched: the Hivecraft profile uses its own game folder.

## 4. Uninstall

- **Settings → Apps → Installed apps → Hivecraft → Uninstall**, or run `Hivecraft-Setup.exe --uninstall`.
- This removes the Hivecraft folder (program, downloaded Node/Java/server, config, logs) and its shortcuts.
  **Your worlds are moved to `Documents\Hivecraft worlds backup`** first, so you don't lose them by accident;
  delete that folder yourself if you don't want them.
- It also removes `%APPDATA%\Hivecraft` (launcher settings and your saved API key).
- The **Hivecraft** profile in the Minecraft Launcher (and its `.minecraft\hivecraft` game folder) is removed only
  if you tick that option (`--remove-minecraft-profile` on the command line).
- Your API key is never written to the config file; it is stored encrypted for your Windows user (DPAPI) in
  `%APPDATA%\Hivecraft\secrets.dat`. If you no longer need the key, also revoke it on your provider's website.

## 5. Troubleshooting

| Problem | Try |
|---|---|
| Install stops at a download | Check your internet / proxy / antivirus, then run the setup again — it resumes and only fetches what is missing. Log: `%TEMP%\hivecraft-setup.log`. |
| "npm install failed" | Same as above; corporate networks may block the npm registry. Re-run the setup (Repair). |
| Agents don't start / "provider error" | Re-run the setup and press **Test** on the provider step. Check the key, credit balance, and that the model name exists for that provider. For Claude login: open a terminal and run `claude` once to log in. |
| Minecraft Launcher shows no Hivecraft profile | Close the Minecraft Launcher completely, press START in Hivecraft again. |
| "Overlay mod not installed" in the launcher log | First launch needs internet to fetch Fabric. Without it, Minecraft starts plain (auto-join still works). |
| Can't connect to the server | Wait until the launcher says the server is ready. Port 25590 must be free; another program may be using it. |
| Server won't start: Java error | Re-run the setup (Repair) to re-download Java. |
| Dashboard won't open | Make sure Hivecraft shows the bridge as running, then open `http://127.0.0.1:47960`. |
| Bots stuck / doing nothing | Say something in chat (they answer the human first), or use `stop <bot>` in the in-game terminal. |
| High costs | Use fewer agents, a smaller model or lower effort, and stop sessions you aren't watching. |

Self-checks: `Hivecraft.exe --selftest` (launcher file checks); from the install's `app` folder,
`node test\hub-api.mjs` runs the offline bridge tests.

When asking for help, include `%TEMP%\hivecraft-setup.log` and the launcher log — they contain no API keys,
but check them before sharing.

## 6. Privacy

- Everything runs on your PC. The server and dashboard listen on `127.0.0.1` only.
- Hivecraft sends chat, game state and screenshots the agents take **only to the AI provider you chose**, as part
  of the agents' prompts. Nothing is sent to the Hivecraft authors.

## 7. Licenses

Hivecraft is MIT-licensed (`LICENSE`). Third-party components and their licenses are listed in
`THIRD_PARTY_NOTICES.md`. Minecraft is a trademark of Mojang Synergies AB; Hivecraft is not affiliated with
Mojang or Microsoft.
