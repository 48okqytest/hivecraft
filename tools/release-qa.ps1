<#
  release-qa.ps1 - end-to-end QA of a built Hivecraft-Setup.exe, fully sandboxed (Windows PowerShell 5.1).

    powershell -ExecutionPolicy Bypass -File tools\release-qa.ps1 [-Setup dist\Hivecraft-Setup.exe] [-Keep] [-ReuseRuntimes]

  Installs into a fresh %TEMP%\hivecraft-qa-<stamp>\ with every profile path redirected:
    --dir <qa>\inst, --mc-dir <qa>\sandbox\.minecraft, HIVECRAFT_TEST_SANDBOX=<qa>\sandbox (shortcuts, uninstall
    "registry" json, Documents), HIVECRAFT_DATA_DIR=<qa>\sandbox\AppData\Hivecraft (DPAPI secrets),
    TEMP/TMP/APPDATA/LOCALAPPDATA env -> <qa>\env\* (for child processes that honour env vars).
  Fingerprints the real profile locations before and after (existence + size + mtime + hash only, never contents)
  and fails if any of them changed. No game, no claude, no agents; uses a fake "custom" provider at a dead port.

  Checks: setup --selftest; unattended install (timed); layout; config (player, random rcon pw, ports);
  server.properties + eula; Node / Java run; server.jar SHA-1 == Mojang manifest; npm deps resolvable;
  installed launcher --selftest; offline node tests from the installed app; uninstall removes everything.
  Writes <qa>\qa-report.json and dist\qa-report.json. Exit 0 = all checks passed.
#>
[CmdletBinding()]
param(
  [string]$Setup = '',
  [string]$Player = 'QaTester',
  [switch]$Keep,
  [switch]$ReuseRuntimes,
  [int]$InstallTimeoutMin = 30
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2
$Root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
if (-not $Setup) { $Setup = Join-Path $Root 'dist\Hivecraft-Setup.exe' }
$Setup = (Resolve-Path $Setup).Path

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$QA    = Join-Path ([System.IO.Path]::GetTempPath()) "hivecraft-qa-$stamp"
$Inst  = Join-Path $QA 'inst'
$SB    = Join-Path $QA 'sandbox'
$McDir = Join-Path $SB '.minecraft'
$DataD = Join-Path $SB 'AppData\Hivecraft'
$EnvD  = Join-Path $QA 'env'
$Log   = Join-Path $QA 'setup.log'
New-Item -ItemType Directory -Force $QA, $SB, $McDir, (Join-Path $EnvD 'Temp'), (Join-Path $EnvD 'Roaming'), (Join-Path $EnvD 'Local') | Out-Null
# a fake .minecraft with a launcher_profiles.json so profile add/remove can be checked
'{"profiles":{"other":{"name":"Other","type":"custom","lastVersionId":"1.21.1"}},"settings":{},"version":3}' |
  Set-Content -Encoding ASCII (Join-Path $McDir 'launcher_profiles.json')

$results = New-Object System.Collections.ArrayList
$timings = [ordered]@{}
function Check([string]$name, [bool]$ok, [string]$detail = '') {
  [void]$results.Add([ordered]@{ check = $name; ok = $ok; detail = $detail })
  $c = if ($ok) { 'Green' } else { 'Red' }
  Write-Host ("  [{0}] {1}{2}" -f $(if ($ok) { 'PASS' } else { 'FAIL' }), $name, $(if ($detail) { " - $detail" } else { '' })) -ForegroundColor $c
}
function Section([string]$s) { Write-Host ''; Write-Host "== $s" -ForegroundColor Cyan }
function SizeMB([string]$p) { if (-not (Test-Path -LiteralPath $p)) { return 0 }; $s = (Get-ChildItem -LiteralPath $p -Recurse -File -Force -ErrorAction SilentlyContinue | Measure-Object Length -Sum).Sum; if (-not $s) { $s = 0 }; [math]::Round($s / 1MB, 1) }

# ---------------------------------------------------------------- real-profile fingerprint (read-only)
$realAppData = [Environment]::GetFolderPath('ApplicationData')
$realLocal   = [Environment]::GetFolderPath('LocalApplicationData')
$realDesktop = [Environment]::GetFolderPath('Desktop')
$realStart   = [Environment]::GetFolderPath('Programs')
$watch = @(
  (Join-Path $realAppData '.minecraft\launcher_profiles.json'),
  (Join-Path $realAppData '.minecraft\hivecraft'),
  (Join-Path $realAppData 'Hivecraft'),
  (Join-Path $realLocal 'Hivecraft'),
  (Join-Path $realDesktop 'Hivecraft.lnk'),
  (Join-Path $realStart 'Hivecraft'),
  (Join-Path $Root 'Hivecraft.exe'),
  (Join-Path $Root 'hivecraft.config.json')
)
function Get-Fingerprint {
  $fp = [ordered]@{}
  foreach ($p in $watch) {
    if (-not (Test-Path -LiteralPath $p)) { $fp[$p] = 'absent'; continue }
    $it = Get-Item -LiteralPath $p -Force
    if ($it.PSIsContainer) {
      $files = @(Get-ChildItem -LiteralPath $p -Recurse -File -Force -ErrorAction SilentlyContinue)
      $latest = ($files | Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1)
      $fp[$p] = "dir files=$($files.Count) latest=$(if ($latest) { $latest.LastWriteTimeUtc.Ticks } else { 0 })"
    } else {
      $fp[$p] = "file len=$($it.Length) mtime=$($it.LastWriteTimeUtc.Ticks)"
    }
  }
  $key = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\Hivecraft'
  $fp[$key] = if (Test-Path $key) { 'present' } else { 'absent' }
  $fp
}
$before = Get-Fingerprint

# environment for every child process
$env:HIVECRAFT_TEST_SANDBOX = $SB
$env:HIVECRAFT_DATA_DIR = $DataD
# (no HIVECRAFT_MC_DIR: --mc-dir is passed explicitly; the env var would also override setup --selftest's own sandbox)
Remove-Item Env:HIVECRAFT_MC_DIR -ErrorAction SilentlyContinue
$env:HIVE_API_KEY = 'qa-fake-key-not-real'
$env:TEMP = Join-Path $EnvD 'Temp'; $env:TMP = $env:TEMP
$env:APPDATA = Join-Path $EnvD 'Roaming'; $env:LOCALAPPDATA = Join-Path $EnvD 'Local'
$env:HIVE_EARNINGS_POLL = '0'
Remove-Item Env:HIVE_CONFIG -ErrorAction SilentlyContinue

function Run-Exe([string]$exe, [string[]]$a, [int]$timeoutSec, [string]$outFile, [string]$cwd = $QA) {
  $p = Start-Process -FilePath $exe -ArgumentList $a -WorkingDirectory $cwd -PassThru -NoNewWindow -RedirectStandardOutput "$outFile.out" -RedirectStandardError "$outFile.err"
  $null = $p.Handle  # PS 5.1: cache the handle or ExitCode can come back empty
  if (-not $p.WaitForExit($timeoutSec * 1000)) { try { $p.Kill() } catch {}; return -999 }
  return $p.ExitCode
}

Write-Host "QA dir: $QA"
Write-Host "Setup:  $Setup ($([math]::Round((Get-Item $Setup).Length/1MB,1)) MB)"

# ---------------------------------------------------------------- 1. setup selftest
Section 'Setup --selftest'
$t = Get-Date
$code = Run-Exe $Setup @('--selftest') 300 (Join-Path $QA 'setup-selftest')
$timings['setupSelftest'] = [math]::Round(((Get-Date) - $t).TotalSeconds, 1)
Check 'setup --selftest exit 0' ($code -eq 0) "exit $code"

# ---------------------------------------------------------------- 2. unattended install
Section 'Unattended install'
$instArgs = @('--unattended', '--dir', "`"$Inst`"", '--accept-eula', '--player', $Player, '--display-name', '"Qa Tester"',
          '--provider', 'custom', '--base-url', 'http://127.0.0.1:9', '--model', 'qa-test-model',
          '--no-launch', '--mc-dir', "`"$McDir`"", '--log', "`"$Log`"")
if (-not $ReuseRuntimes) { $instArgs += '--no-reuse-runtimes' }
$t = Get-Date
$code = Run-Exe $Setup $instArgs ($InstallTimeoutMin * 60) (Join-Path $QA 'install')
$timings['install'] = [math]::Round(((Get-Date) - $t).TotalSeconds, 1)
Check 'install exit 0' ($code -eq 0) "exit $code in $($timings['install'])s (log $Log)"

$App = Join-Path $Inst 'app'
if (-not (Test-Path $App)) { $App = $Inst }   # tolerate a flat layout, reported below
Section 'Layout'
foreach ($rel in 'Hivecraft.exe', 'package.json', 'package-lock.json', 'bridge\server.js', 'bridge\config.js', 'mcp\mc-mcp.js',
                 'crew\crew.js', 'crew\roster.json', 'crew\prompts', 'mod\hivecraft-overlay.jar', 'data\econ-catalog.json',
                 'manifest.json', 'README.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'node_modules\mineflayer\package.json') {
  Check "has $rel" (Test-Path (Join-Path $App $rel))
}
foreach ($rel in 'crew\logs', 'crew\work', 'data\hub.json', 'data\ledger', 'data\photos', 'data\personalities.json') {
  $pp = Join-Path $App $rel   # the installer may create empty dirs; nothing from the dev tree may be inside
  Check "no $rel content from payload" (-not (Test-Path $pp) -or @(Get-ChildItem -LiteralPath $pp -Recurse -File -Force -ErrorAction SilentlyContinue).Count -eq 0)
}
Check 'Start Menu shortcut in sandbox' (@(Get-ChildItem (Join-Path $SB 'StartMenu') -Recurse -Filter '*.lnk' -ErrorAction SilentlyContinue).Count -gt 0)
Check 'Desktop shortcut in sandbox' (@(Get-ChildItem (Join-Path $SB 'Desktop') -Filter '*.lnk' -ErrorAction SilentlyContinue).Count -gt 0)
Check 'uninstall entry in sandbox' (Test-Path (Join-Path $SB 'uninstall-registry.json'))

# ---------------------------------------------------------------- 3. config + server.properties
Section 'Config'
$cfgPath = Join-Path $App 'hivecraft.config.json'
$cfg = $null
if (Test-Path $cfgPath) { try { $cfg = Get-Content -Raw $cfgPath | ConvertFrom-Json } catch { } }
Check 'hivecraft.config.json parses' ($null -ne $cfg)
if ($cfg) {
  Check 'player.mcName' ($cfg.player.mcName -eq $Player) "$($cfg.player.mcName)"
  Check 'provider.kind custom' ($cfg.provider.kind -eq 'custom') "$($cfg.provider.kind)"
  $pw = [string]$cfg.server.rconPassword
  Check 'rcon password random (>=16 chars, not legacy)' ($pw.Length -ge 16 -and $pw -ne ('hivecraft' + '-local')) "len $($pw.Length)"
  Check 'no API key in config' (-not ((Get-Content -Raw $cfgPath) -match 'qa-fake-key-not-real'))
  $srvDir = if ([System.IO.Path]::IsPathRooted($cfg.server.dir)) { $cfg.server.dir } else { Join-Path $App $cfg.server.dir }
  $props = Join-Path $srvDir 'server.properties'
  Check 'server.properties exists' (Test-Path $props) $props
  if (Test-Path $props) {
    $map = @{}
    foreach ($l in Get-Content $props) { if ($l -match '^\s*([^#=]+?)\s*=(.*)$') { $map[$matches[1]] = $matches[2] } }
    Check 'server-port matches' ($map['server-port'] -eq [string]$cfg.server.port) "$($map['server-port']) vs $($cfg.server.port)"
    Check 'rcon.port matches' ($map['rcon.port'] -eq [string]$cfg.server.rconPort) "$($map['rcon.port']) vs $($cfg.server.rconPort)"
    Check 'rcon.password matches config' ($map['rcon.password'] -eq $pw)
    Check 'enable-rcon=true' ($map['enable-rcon'] -eq 'true')
    Check 'online-mode=false' ($map['online-mode'] -eq 'false')
    Check 'server-ip bound locally (not all interfaces)' ($map['server-ip'] -in @('127.0.0.1', 'localhost')) "server-ip='$($map['server-ip'])'"
  }
  $eula = Join-Path $srvDir 'eula.txt'
  Check 'eula.txt eula=true' ((Test-Path $eula) -and ((Get-Content -Raw $eula) -match 'eula=true'))

  # ---------------------------------------------------------------- 4. runtimes + checksums
  Section 'Runtimes'
  $nodeExe = if ([System.IO.Path]::IsPathRooted($cfg.runtime.node)) { $cfg.runtime.node } else { Join-Path $App $cfg.runtime.node }
  $javaExe = if ([System.IO.Path]::IsPathRooted($cfg.runtime.java)) { $cfg.runtime.java } else { Join-Path $App $cfg.runtime.java }
  Check 'node is inside the install' ($nodeExe.StartsWith($Inst, 'OrdinalIgnoreCase') -or $ReuseRuntimes) $nodeExe
  Check 'java is inside the install' ($javaExe.StartsWith($Inst, 'OrdinalIgnoreCase') -or $ReuseRuntimes) $javaExe
  function OutOf([string]$base) { ((Get-Content "$base.out" -ErrorAction SilentlyContinue) + (Get-Content "$base.err" -ErrorAction SilentlyContinue)) -join "`n" }
  [void](Run-Exe $nodeExe @('--version') 60 (Join-Path $QA 'node-version')); $nv = OutOf (Join-Path $QA 'node-version')
  Check 'node runs' ($nv -match 'v\d+') $nv.Trim()
  [void](Run-Exe $javaExe @('-version') 60 (Join-Path $QA 'java-version')); $jv = OutOf (Join-Path $QA 'java-version')
  Check 'java runs (>=21)' ($jv -match 'version "(2[1-9]|[3-9]\d)') (($jv -split "`n")[0]).Trim()
  $jar = Join-Path $srvDir 'server.jar'
  Check 'server.jar exists' (Test-Path $jar)
  if (Test-Path $jar) {
    try {
      $man = Invoke-RestMethod 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json' -UseBasicParsing
      $v = $man.versions | Where-Object { $_.id -eq '1.21.1' } | Select-Object -First 1
      $vj = Invoke-RestMethod $v.url -UseBasicParsing
      $want = $vj.downloads.server.sha1
      $have = (Get-FileHash -Algorithm SHA1 $jar).Hash.ToLowerInvariant()
      Check 'server.jar SHA-1 == Mojang manifest' ($have -eq $want) "$have"
    } catch { Check 'server.jar SHA-1 == Mojang manifest' $false "could not fetch manifest: $_" }
  }
  if (Test-Path $Log) {
    $verified = @(Select-String -Path $Log -Pattern '(sha|checksum|verified)' -ErrorAction SilentlyContinue | ForEach-Object { $_.Line.Trim() })
    Check 'installer log mentions checksum verification' ($verified.Count -gt 0) ("{0} line(s): {1}" -f $verified.Count, (($verified | Select-Object -First 4) -join ' | '))
  }

  # ---------------------------------------------------------------- 5. npm deps
  Section 'npm deps'
  $depJs = "Promise.all(['mineflayer','mineflayer-pathfinder','minecraft-data','@modelcontextprotocol/sdk/server/mcp.js','ws','zod','pngjs','yauzl'].map(m=>import(m))).then(()=>console.log('deps-ok'),e=>{console.log('deps-fail '+e.message);process.exit(1)})"
  [void](Run-Exe $nodeExe @('--input-type=module', '-e', "`"$depJs`"") 120 (Join-Path $QA 'deps') $App)
  $r = OutOf (Join-Path $QA 'deps')
  Check 'npm deps importable' ($r -match 'deps-ok') $r.Trim()
  $timings['nodeModulesMB'] = SizeMB (Join-Path $App 'node_modules')

  # ---------------------------------------------------------------- 6. installed launcher selftest
  Section 'Installed launcher --selftest'
  $t = Get-Date
  $lcode = Run-Exe (Join-Path $App 'Hivecraft.exe') @('--selftest') 300 (Join-Path $QA 'launcher-selftest')
  $timings['launcherSelftest'] = [math]::Round(((Get-Date) - $t).TotalSeconds, 1)
  $stOut = Join-Path $env:TEMP 'hivecraft-selftest.txt'
  $stTxt = if (Test-Path $stOut) { Get-Content -Raw $stOut } else { '' }
  $fails = @(($stTxt -split "`n") | Where-Object { $_ -match 'FAIL' })
  Check 'launcher --selftest exit 0' ($lcode -eq 0) "exit $lcode; $($fails.Count) FAIL line(s) $(($fails | Select-Object -First 3) -join ' | ')"

  # ---------------------------------------------------------------- 7. offline tests from the installed app
  Section 'Offline node tests (installed app)'
  $tests = 'hub-api', 'mod-api-test', 'econ-test', 'earnings-test', 'chat-route-test', 'econ-tools-test', 'tools-list',
           'hub-interrupt', 'mcp-test', 'robust-unit', 'blueprint-check', 'providers-test'
  foreach ($tn in $tests) {
    $f = Join-Path $App "test\$tn.mjs"
    if (-not (Test-Path $f)) { Check "test $tn" $false 'missing'; continue }
    $t = Get-Date
    $tc = Run-Exe $nodeExe @("test\$tn.mjs") 300 (Join-Path $QA "test-$tn") $App
    $sec = [math]::Round(((Get-Date) - $t).TotalSeconds, 1)
    $tail = ''
    if (Test-Path (Join-Path $QA "test-$tn.out")) { $tail = ((Get-Content (Join-Path $QA "test-$tn.out") -Tail 1) -join '').Trim() }
    Check "test $tn" ($tc -eq 0) "exit $tc, ${sec}s $tail"
  }
}

$timings['installedMB'] = SizeMB $Inst
$timings['downloadsMB'] = SizeMB (Join-Path $Inst 'downloads')

# ---------------------------------------------------------------- 8. uninstall
Section 'Uninstall'
$t = Get-Date
$ucode = Run-Exe $Setup @('--uninstall', '--unattended', '--dir', "`"$Inst`"", '--remove-minecraft-profile', '--log', "`"$(Join-Path $QA 'uninstall.log')`"") 600 (Join-Path $QA 'uninstall')
$timings['uninstall'] = [math]::Round(((Get-Date) - $t).TotalSeconds, 1)
Check 'uninstall exit 0' ($ucode -eq 0) "exit $ucode"
$left = @(Get-ChildItem -LiteralPath $Inst -Recurse -Force -ErrorAction SilentlyContinue)
Check 'install dir removed' (-not (Test-Path $Inst) -or $left.Count -eq 0) "$($left.Count) item(s) left"
Check 'Start Menu shortcut removed' (@(Get-ChildItem (Join-Path $SB 'StartMenu') -Recurse -Filter '*.lnk' -ErrorAction SilentlyContinue).Count -eq 0)
Check 'Desktop shortcut removed' (@(Get-ChildItem (Join-Path $SB 'Desktop') -Filter '*.lnk' -ErrorAction SilentlyContinue).Count -eq 0)
Check 'uninstall entry removed' (-not (Test-Path (Join-Path $SB 'uninstall-registry.json')) -or ((Get-Content -Raw (Join-Path $SB 'uninstall-registry.json')) -notmatch 'Hivecraft'))
Check 'user data dir removed' (-not (Test-Path $DataD))
$lp = Join-Path $McDir 'launcher_profiles.json'
if (Test-Path $lp) {
  $lpj = Get-Content -Raw $lp
  Check 'Minecraft profile removed, other profile kept' (($lpj -notmatch '(?i)hivecraft') -and ($lpj -match '"other"'))
}

# ---------------------------------------------------------------- 9. real profile untouched
Section 'Real profile untouched'
$after = Get-Fingerprint
foreach ($k in $before.Keys) { Check "unchanged: $k" ($before[$k] -eq $after[$k]) $(if ($before[$k] -ne $after[$k]) { "$($before[$k]) -> $($after[$k])" } else { '' }) }

# ---------------------------------------------------------------- report
$failed = @($results | Where-Object { -not $_.ok })
$report = [ordered]@{
  when = (Get-Date).ToString('s'); setup = $Setup; setupMB = [math]::Round((Get-Item $Setup).Length / 1MB, 1)
  setupSha256 = (Get-FileHash -Algorithm SHA256 $Setup).Hash.ToLowerInvariant(); qaDir = $QA; timings = $timings
  passed = $results.Count - $failed.Count; failed = $failed.Count; results = $results
}
$json = $report | ConvertTo-Json -Depth 6
[System.IO.File]::WriteAllText((Join-Path $QA 'qa-report.json'), $json, (New-Object System.Text.UTF8Encoding($false)))
[System.IO.File]::WriteAllText((Join-Path $Root 'dist\qa-report.json'), $json, (New-Object System.Text.UTF8Encoding($false)))
Write-Host ''
Write-Host ("QA: {0} passed, {1} failed. Timings: {2}" -f $report.passed, $report.failed, (($timings.GetEnumerator() | ForEach-Object { "$($_.Key)=$($_.Value)" }) -join ' ')) -ForegroundColor $(if ($failed.Count) { 'Red' } else { 'Green' })
if (-not $Keep -and $failed.Count -eq 0) { Remove-Item -Recurse -Force $QA -ErrorAction SilentlyContinue } else { Write-Host "kept $QA" }
exit $(if ($failed.Count) { 1 } else { 0 })
