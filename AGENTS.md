# AGENTS.md: installing Hivecraft for someone

This file is for **AI coding agents** (Claude Code, Codex, Cursor, etc.) asked to *"install Hivecraft for me"*.
Follow it top to bottom. It uses the official installer in unattended mode, so you never have to drive the GUI.
Human-readable docs are in [README.md](README.md).

## Ground rules

- **Ask before anything that costs money or touches accounts.** Hivecraft's agents use the person's AI provider.
  Confirm which provider they want, and never invent, guess or reuse an API key you weren't given for this purpose.
- **Never print, log or commit an API key.** Pass it through the `HIVE_API_KEY` environment variable, not a command-line
  argument (arguments show up in process lists). The installer stores it encrypted (Windows DPAPI) in
  `%APPDATA%\Hivecraft\secrets.dat`.
- **The Minecraft EULA is the user's decision.** Show them https://aka.ms/MinecraftEULA and get a clear "yes" before
  passing `--accept-eula`.
- Don't port-forward or expose the server: it runs in offline mode and is meant for this PC only.
- Don't modify their existing Minecraft installations. Hivecraft uses its own launcher profile and game folder.

## 1. Check requirements

Run these in PowerShell and stop if a hard requirement fails.

```powershell
[Environment]::Is64BitOperatingSystem                       # must be True (Windows 10/11 x64)
(Get-PSDrive ($env:LOCALAPPDATA.Substring(0,1))).Free / 1GB # want >= 2.5
(Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory / 1GB  # 8+ recommended
Test-Path "$env:APPDATA\.minecraft"                         # Minecraft Java has been run at least once
```

Ask the user to confirm:
1. They **own Minecraft: Java Edition** and have opened the official Minecraft Launcher and logged in at least once.
2. Their **Minecraft username** (3–16 letters, digits or `_`). The agents use it to recognise them in chat.
3. Which **AI provider** they want for the agents:

| `--provider` | Needs | Notes |
|---|---|---|
| `claude-login` (default) | a Claude Pro/Max/Team subscription; Claude Code installed and logged in | no key; uses the subscription's limits |
| `anthropic-key` | Anthropic API key | pay per token |
| `openrouter` | OpenRouter API key | pay per token; any model id from openrouter.ai |
| `custom` | `--base-url` + key + `--model` | any Anthropic-compatible endpoint |
| `bedrock` / `vertex` | the user's cloud already set up for Claude | advanced |

For `claude-login`, check Claude Code: `claude --version`. If it's missing, install it with Anthropic's official
installer (`irm https://claude.ai/install.ps1 | iex`) and have the **user** run `claude` once to log in themselves.
Never log in on their behalf with credentials they paste to you.

## 2. Download and verify the installer

```powershell
$dl = "$env:TEMP\hivecraft-dl"; New-Item -ItemType Directory -Force $dl | Out-Null
$base = "https://github.com/48okqytest/hivecraft/releases/latest/download"
Invoke-WebRequest "$base/Hivecraft-Setup.exe"        -OutFile "$dl\Hivecraft-Setup.exe"
Invoke-WebRequest "$base/Hivecraft-Setup.exe.sha256" -OutFile "$dl\Hivecraft-Setup.exe.sha256"
$want = ((Get-Content "$dl\Hivecraft-Setup.exe.sha256" -Raw).Trim() -split '\s+')[0].ToLower()
$got  = (Get-FileHash "$dl\Hivecraft-Setup.exe" -Algorithm SHA256).Hash.ToLower()
if ($want -ne $got) { throw "Checksum mismatch: do not run this file" }
```

## 3. Run the unattended install

Example with a Claude subscription:

```powershell
$p = Start-Process "$dl\Hivecraft-Setup.exe" -Wait -PassThru -ArgumentList @(
  '--unattended', '--accept-eula',
  '--player', 'TheirMcName', '--display-name', 'Sam',
  '--provider', 'claude-login', '--model', 'claude-sonnet-5-5',
  '--test-connection', '--no-launch')
"exit code: $($p.ExitCode)"   # 0 = OK
```

With an API key, set it in the environment for the installer only:

```powershell
$env:HIVE_API_KEY = '<key the user gave you for this>'
$p = Start-Process "$dl\Hivecraft-Setup.exe" -Wait -PassThru -ArgumentList @(
  '--unattended', '--accept-eula', '--player', 'TheirMcName',
  '--provider', 'anthropic-key', '--model', 'claude-sonnet-5-5', '--test-connection', '--no-launch')
Remove-Item Env:HIVE_API_KEY
```

All options (from `Hivecraft-Setup.exe` itself):

```
--unattended --dir <path> --accept-eula --player <mcName> [--display-name <name>]
    --provider claude-login|anthropic-key|openrouter|custom|bedrock|vertex [--api-key <k> | env HIVE_API_KEY]
    [--base-url <url>] --model <id> [--small-model <id>] [--claude <claude.exe>]
    [--no-launch] [--no-shortcuts] [--no-reuse-runtimes] [--test-connection] [--mc-dir <dir>] [--log <file>]
--repair [--dir <path>]          rerun setup on an existing install (keeps settings, worlds, memory)
--uninstall [--unattended] [--dir <path>] [--remove-minecraft-profile] [--keep-user-data] [--no-keep-worlds]
```

Default folder: `%LOCALAPPDATA%\Programs\Hivecraft`. The install downloads about 375 MB (Node.js, Java 21,
Minecraft server 1.21.1, npm packages), each verified against its publisher's checksum.

## 4. Verify

```powershell
$log = "$env:TEMP\hivecraft-setup.log"
Select-String -Path $log -Pattern 'FAILED|connection test' | Select-Object -Last 5
$dir = "$env:LOCALAPPDATA\Programs\Hivecraft"
Test-Path "$dir\app\Hivecraft.exe"
$t = Start-Process "$dir\app\Hivecraft.exe" -ArgumentList '--selftest' -Wait -PassThru
"launcher selftest exit: $($t.ExitCode)"   # 0 = OK
```

- Exit code `0` and no `FAILED` line in the log = installed.
- Exit code `3` = a required option is missing or invalid (EULA, player name). The log says which.
- `connection test: FAILED` = provider problem (wrong key, no credit, unknown model, Claude not logged in).
  Fix it, then rerun the same command with `--repair`, or let the user change it in the launcher.
- Downloads failed (firewall/proxy/antivirus)? Rerun; it resumes and only fetches what's missing.

## 5. Hand over to the user

Tell them, in plain words:
1. Open **Hivecraft** from the Start menu or desktop.
2. Name the agents (and give them personalities if they like), pick the model, press **START**.
3. Press **PLAY** in the Minecraft Launcher that opens. They join automatically.
4. Type a task in Minecraft chat, e.g. *"make a society and build a town"*.
5. Press **TERMINATE** in Hivecraft to stop. **Running agents costs money or subscription usage**: a few dollars
   per agent per hour on an API key. Start with 1–2 agents.

Don't start a session yourself unless they asked you to. It spends their credits.

## Uninstall

```powershell
& "$env:LOCALAPPDATA\Programs\Hivecraft\Hivecraft-Setup.exe" --uninstall --unattended
```

Worlds are moved to `Documents\Hivecraft worlds backup` first. Add `--remove-minecraft-profile` to also remove the
Hivecraft profile from the Minecraft Launcher.

## Running from source instead (developers)

See [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md). In short: Node 20+, Java 21+, `npm ci`, put a Minecraft 1.21.1
`server.jar` in `server/`, then `.\start.ps1`, or drop the release's `Hivecraft.exe` into the repo folder and use it.
