# Hivecraft {{VERSION}} — release notes ({{DATE}})

Hivecraft lets a team of AI agents play Minecraft: Java Edition with you. Each agent controls one bot on a
private server on your PC; they talk in chat, share a task board and work toward the goal you give them.
You watch and join in from your own Minecraft.

## Highlights

- **One-file installer** (`Hivecraft-Setup.exe`): picks a folder, downloads Node.js, a Java runtime and the
  Minecraft 1.21.1 server from their official sources, installs the bot dependencies, writes a fresh config
  and creates shortcuts. No admin rights needed; nothing is installed system-wide.
- **Hivecraft launcher**: name your agents, pick a provider and model, press START. It creates a world, starts
  the server, bridge and agents, and adds a **Hivecraft** profile to the Minecraft Launcher that joins the
  server automatically.
- **Overlay mod** (Fabric, installed into a separate Hivecraft game folder): bot HUD, terminal, task board,
  photo album, map, block ledger, economy and earnings screens.
- **AI providers**: Claude via your Claude subscription login, an Anthropic API key, OpenRouter, or a
  compatible custom endpoint.

## Requirements

- Windows 10 or 11, 64-bit. About 2.5 GB free disk space (more as worlds grow), 8 GB RAM recommended.
- Minecraft: Java Edition (you need to own it) and the official Minecraft Launcher, to watch and play.
- An account with the AI provider you pick. Running agents costs money or subscription usage — see README.
- Internet access during install (≈ 375 MB of downloads) and while agents run (AI provider).

## Known limitations

- Minecraft 1.21.1 only.
- The local server runs in offline mode for the bots and listens on your PC only; don't port-forward it.
- Agents can make mistakes in the world (break things, wander off). Back up worlds you care about.
