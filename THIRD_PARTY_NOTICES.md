# Third-party notices

Hivecraft itself is released under the MIT License (see `LICENSE`). It uses, downloads or talks to the
third-party software and services below. Each keeps its own license; nothing here changes those terms.

## What is inside Hivecraft-Setup.exe

| Component | License | Notes |
|---|---|---|
| Hivecraft (bridge, MCP server, crew, launcher, installer, overlay mod) | MIT | this project |
| .NET runtime (self-contained in `Hivecraft.exe` and `Hivecraft-Setup.exe`) | MIT | © .NET Foundation and contributors, https://github.com/dotnet/runtime |
| WPF (Windows Presentation Foundation) | MIT | © .NET Foundation and contributors, https://github.com/dotnet/wpf |

The overlay mod jar (`mod/hivecraft-overlay.jar`) contains only Hivecraft code. It does **not** contain
Minecraft, Fabric Loader or Fabric API; those are downloaded separately (below).

## Downloaded by the installer on your PC (not shipped by us)

These are fetched from their official sources at install time, checked against published checksums
where the source provides them, and stored inside your Hivecraft install folder.

| Component | License | Source |
|---|---|---|
| Node.js (portable, Windows x64) | MIT (Node.js) + bundled third-party licenses (see `LICENSE` in the Node folder) | https://nodejs.org |
| npm (comes with Node.js) | Artistic License 2.0 | https://github.com/npm/cli |
| Eclipse Temurin Java runtime (OpenJDK) | GPL-2.0 with Classpath Exception | Eclipse Adoptium, https://adoptium.net |
| Minecraft Java Edition **server** (`server.jar`, 1.21.1) | Proprietary — Minecraft EULA | downloaded from Mojang's servers (see below) |
| Fabric Loader + Fabric Installer | Apache-2.0 | https://fabricmc.net |
| Fabric API (1.21.1) | Apache-2.0 | https://modrinth.com/mod/fabric-api |
| Claude Code CLI (only if you choose a Claude provider and don't have it yet) | Anthropic Commercial Terms / Claude Code license | https://claude.com/claude-code |
| npm packages listed in `package-lock.json` (installed with `npm ci`) | see the table at the end of this file | https://www.npmjs.com |

### Minecraft and the Minecraft EULA

Hivecraft is **not** an official Minecraft product and is not approved by or associated with Mojang or
Microsoft. Hivecraft never bundles or redistributes any Minecraft code, server jar, client, textures,
sounds or other game assets. The Minecraft server jar is downloaded directly from Mojang when you install,
and the installer asks you to accept the Minecraft EULA (https://aka.ms/MinecraftEULA) first; it writes
`eula=true` only after you accept. Textures the dashboard viewer shows are read from your own Minecraft
installation / the downloaded jar on your PC and are never uploaded or redistributed.

To play you need your own legitimate copy of **Minecraft: Java Edition** (a Microsoft account that owns it).
The local server runs in offline mode so the AI bots can join; it binds to your PC only. Do not open the
port to the internet.

### AI providers

Hivecraft's agents run on the AI provider you choose (Anthropic / Claude, OpenRouter, or a compatible
endpoint). Your use of those services is governed by that provider's terms and pricing, and you pay them
directly. API keys you enter are stored only on your PC, encrypted for your Windows user (DPAPI), in `%APPDATA%\Hivecraft\secrets.dat`, and are never written to `hivecraft.config.json`.

## Notable npm dependency licenses

All npm dependencies are installed from the public npm registry using the versions pinned in
`package-lock.json`. Each package's own license text is in `node_modules/<package>/LICENSE` after install.
Most are MIT; the non-MIT ones are:

- **GPL-3.0**: `@nxg-org/mineflayer-util-plugin`, `node-aabb` (pulled in by `mineflayer-auto-eat`). Installed on your
  PC from npm, not redistributed by Hivecraft. Anyone who redistributes a bundle that includes them must follow GPL-3.0.
- **Apache-2.0**: `puppeteer-core`, `@puppeteer/browsers`, `chromium-bidi`, `rxjs`, `@xboxreplay/xboxlive-auth`, `ecdsa-sig-formatter`, …
- **BSD-2/3-Clause, ISC, 0BSD, CC0-1.0**: `minecraft-protocol`, `devtools-protocol`, `vec3`, `semver`, `tslib`, …

The complete list (package, version, license) generated from `package-lock.json` at build time follows.

<!-- NPM-TABLE -->
