<#
  make-release.ps1 - builds the Hivecraft release (Windows PowerShell 5.1 compatible).

    powershell -ExecutionPolicy Bypass -File tools\make-release.ps1
    ... -SkipMod -SkipLauncher        reuse dist\build\mod + dist\build\launcher from a previous run
    ... -SkipModTests                 gradle build -x test (faster)
    ... -BundleNodeModules            put node_modules (production deps) in the payload (~0.7 GB unpacked)
    ... -NoInstaller                  stop after dist\Hivecraft-payload.zip
    ... -Version 0.2.0                default: version from package.json

  Steps: mod jar (gradlew.bat) -> launcher (dotnet publish single-file) -> dist\payload\app (release files only)
         -> scrub scan of the payload (FAILS the build on any personal/secret hit) -> payload.zip
         -> installer (dotnet publish, payload.zip embedded) -> dist\Hivecraft-Setup.exe + .sha256 + RELEASE_NOTES.md

  Output (dist\):
    Hivecraft-Setup.exe            the one file users download
    Hivecraft-Setup.exe.sha256     "<hash> *Hivecraft-Setup.exe"
    Hivecraft-payload.zip          same payload as embedded (for --payload / sibling-zip testing)
    RELEASE_NOTES.md
    build-report.json              sizes, hashes, timings, scan result
    payload\app\                   the unzipped payload (what gets installed)
    build\                         intermediate outputs
  Nothing is uploaded or published.
#>
[CmdletBinding()]
param(
  [string]$Version = '',
  [switch]$SkipMod,
  [switch]$SkipModTests,
  [switch]$SkipLauncher,
  [switch]$BundleNodeModules,
  [switch]$NoInstaller
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2

$Root  = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$Dist  = Join-Path $Root 'dist'
$Build = Join-Path $Dist 'build'
$Pay   = Join-Path $Dist 'payload'
$App   = Join-Path $Pay 'app'
$Docs  = Join-Path $Root 'docs\release'
$t0    = Get-Date
$times = [ordered]@{}

function Step([string]$name) { Write-Host ''; Write-Host "==> $name" -ForegroundColor Cyan; $script:stepStart = Get-Date; $script:stepName = $name }
function EndStep { $script:times[$script:stepName] = [math]::Round(((Get-Date) - $script:stepStart).TotalSeconds, 1) }
function Fail([string]$msg) { Write-Host "RELEASE BUILD FAILED: $msg" -ForegroundColor Red; exit 1 }
function Need([string]$path, [string]$what) { if (-not (Test-Path -LiteralPath $path)) { Fail "$what not found: $path" } }
function Invoke-Native([string]$exe, [string[]]$argList, [string]$what, [string]$cwd = $Root) {
  Write-Host "  > $exe $($argList -join ' ')" -ForegroundColor DarkGray
  Push-Location $cwd
  try { & $exe @argList; $code = $LASTEXITCODE } finally { Pop-Location }
  if ($code -ne 0) { Fail "$what exited with code $code" }
}
function Copy-Tree([string]$src, [string]$dst, [string[]]$excludeDirs = @(), [string[]]$excludeFiles = @(), [switch]$Mirror) {
  # robocopy: /E subdirs (/MIR = also purge extra files; excluded dirs are kept, e.g. gradle/obj caches), quiet.
  # Exit codes < 8 are success. robocopy also copes with >260-char paths (loom cache), unlike Remove-Item on PS 5.1.
  $mode = if ($Mirror) { '/MIR' } else { '/E' }
  $a = @($src, $dst, $mode, '/NFL', '/NDL', '/NJH', '/NJS', '/NP', '/R:1', '/W:1')
  if ($excludeDirs.Count)  { $a += '/XD'; $a += $excludeDirs }
  if ($excludeFiles.Count) { $a += '/XF'; $a += $excludeFiles }
  & robocopy @a | Out-Null
  if ($LASTEXITCODE -ge 8) { Fail "copy $src -> $dst (robocopy $LASTEXITCODE)" }
  $global:LASTEXITCODE = 0
}
function Copy-One([string]$src, [string]$dstRel) {
  Need $src 'file'
  $dst = Join-Path $App $dstRel
  New-Item -ItemType Directory -Force (Split-Path $dst) | Out-Null
  Copy-Item -LiteralPath $src -Destination $dst -Force
}
# UTF-8 without BOM (PS 5.1's Set-Content -Encoding UTF8 writes a BOM, which some JSON readers reject)
function Write-Utf8([string]$path, [string]$text) { [System.IO.File]::WriteAllText($path, $text, (New-Object System.Text.UTF8Encoding($false))) }
function Get-Sha256([string]$path) { (Get-FileHash -Algorithm SHA256 -LiteralPath $path).Hash.ToLowerInvariant() }
function Get-SizeMB([string]$path) {
  if ((Get-Item -LiteralPath $path).PSIsContainer) { $s = (Get-ChildItem -LiteralPath $path -Recurse -File | Measure-Object Length -Sum).Sum } else { $s = (Get-Item -LiteralPath $path).Length }
  if (-not $s) { $s = 0 }
  [math]::Round($s / 1MB, 2)
}

# ---------------------------------------------------------------- prerequisites
$node = (Get-Command node -ErrorAction SilentlyContinue)
if (-not $node) { Fail 'node is required to run the scrub scan (tools\scrub-scan.mjs)' }
$dotnet = (Get-Command dotnet -ErrorAction SilentlyContinue)
if (-not $dotnet -and (-not $SkipLauncher -or -not $NoInstaller)) { Fail 'dotnet SDK (10.x) is required' }
$pkg = Get-Content -Raw (Join-Path $Root 'package.json') | ConvertFrom-Json
if (-not $Version) { $Version = $pkg.version }
Write-Host "Hivecraft release $Version  ($Root)"

New-Item -ItemType Directory -Force $Dist, $Build | Out-Null
$Src = Join-Path $Build 'src'
# launcher + installer are built from clean copies (no stale/shared obj\ bin\ with teammates' dev builds);
# installer links ..\launcher\Core\*.cs, so both keep their relative layout under distuild\src
$script:dotnetSynced = $false
function Sync-DotnetSrc {
  if ($script:dotnetSynced) { return }
  foreach ($p in 'launcher', 'installer') {
    $s = Join-Path $Root $p; $d = Join-Path $Src $p
    if (-not (Test-Path $s)) { continue }
    Copy-Tree $s $d @('bin', 'obj', 'publish', 'screenshots', '.vs') @('*.user', '*.log') -Mirror
  }
  $script:dotnetSynced = $true
}

# ---------------------------------------------------------------- 1. mod jar
$modOut = Join-Path $Build 'mod'
if (-not $SkipMod) {
  Step 'Build overlay mod (gradle)'
  # build from a clean copy so teammates' in-progress builds in moduild don't collide with ours
  $modDir = Join-Path $Src 'mod'
  Copy-Tree (Join-Path $Root 'mod') $modDir @('build', '.gradle', 'run', 'out', 'bin', '.idea') -Mirror
  $gargs = @('build', '--no-daemon', '--console=plain')
  if ($SkipModTests) { $gargs += @('-x', 'test') }
  Invoke-Native (Join-Path $modDir 'gradlew.bat') $gargs 'gradle build' $modDir
  $jar = Get-ChildItem (Join-Path $modDir 'build\libs') -Filter '*.jar' |
         Where-Object { $_.Name -notmatch '-(sources|dev|javadoc|all)\.jar$' } |
         Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if (-not $jar) { Fail 'no mod jar in mod\build\libs' }
  if (Test-Path $modOut) { Remove-Item -Recurse -Force $modOut }
  New-Item -ItemType Directory -Force $modOut | Out-Null
  Copy-Item $jar.FullName (Join-Path $modOut 'hivecraft-overlay.jar')
  Write-Host "  mod jar: $($jar.Name) ($([math]::Round($jar.Length/1KB)) KB)"
  EndStep
}
Need (Join-Path $modOut 'hivecraft-overlay.jar') 'mod jar (run without -SkipMod)'

# ---------------------------------------------------------------- 2. launcher
$launchOut = Join-Path $Build 'launcher'
if (-not $SkipLauncher) {
  Step 'Publish launcher (Hivecraft.exe)'
  if (Test-Path $launchOut) { Remove-Item -Recurse -Force $launchOut }
  Sync-DotnetSrc
  Invoke-Native 'dotnet' @('publish', (Join-Path $Src 'launcher\Hivecraft.csproj'), '-c', 'Release', '-r', 'win-x64',
    '--self-contained', '-p:PublishSingleFile=true', '-p:DebugType=none', '-p:DebugSymbols=false',
    "-p:Version=$Version", '-p:Deterministic=true', '-p:ContinuousIntegrationBuild=true', '-o', $launchOut, '--nologo') 'dotnet publish launcher'
  EndStep
}
Need (Join-Path $launchOut 'Hivecraft.exe') 'launcher exe (run without -SkipLauncher)'
# the single-file exe is compressed, so a binary scan can't see its strings: keep the plain IL assembly for the scan
$asmScan = Join-Path $Build 'scan-assemblies'
if (-not $SkipLauncher) {
  if (Test-Path $asmScan) { Remove-Item -Recurse -Force $asmScan }
  New-Item -ItemType Directory -Force $asmScan | Out-Null
  $ld = Get-ChildItem (Join-Path $Src 'launcher\obj\Release') -Recurse -Filter 'Hivecraft.dll' | Where-Object { $_.FullName -notmatch '\\ref(int)?\\' } | Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if (-not $ld) { Fail 'launcher IL assembly (obj\Release\...\Hivecraft.dll) not found for the scrub scan' }
  Copy-Item $ld.FullName (Join-Path $asmScan 'Hivecraft.dll')
}

# ---------------------------------------------------------------- 3. assemble payload
Step 'Assemble payload'
if (Test-Path $Pay) { Remove-Item -Recurse -Force $Pay }
New-Item -ItemType Directory -Force $App | Out-Null

Copy-One (Join-Path $launchOut 'Hivecraft.exe') 'Hivecraft.exe'
Copy-One (Join-Path $Root 'package.json') 'package.json'
Copy-One (Join-Path $Root 'package-lock.json') 'package-lock.json'
$junkFiles = @('*.log', '*.pid', '*.tmp', '*.bak', 'hivecraft.config.json', '.env', '*.env')
Copy-Tree (Join-Path $Root 'bridge') (Join-Path $App 'bridge') @('node_modules', 'logs', 'out') $junkFiles
Copy-Tree (Join-Path $Root 'mcp')    (Join-Path $App 'mcp')    @('node_modules') $junkFiles
# crew: code + prompts + roster only (never logs / logs-archive / work)
Copy-One (Join-Path $Root 'crew\crew.js') 'crew\crew.js'
Copy-One (Join-Path $Root 'crew\roster.json') 'crew\roster.json'
Copy-Tree (Join-Path $Root 'crew\prompts') (Join-Path $App 'crew\prompts') @() $junkFiles
Get-ChildItem (Join-Path $Root 'crew') -File -Filter '*.js' | Where-Object { $_.Name -ne 'crew.js' } | ForEach-Object { Copy-One $_.FullName "crew\$($_.Name)" }
# offline tests (QA + "is my install OK?")
Copy-Tree (Join-Path $Root 'test') (Join-Path $App 'test') @('out', 'tmp') $junkFiles
# overlay mod
Copy-One (Join-Path $modOut 'hivecraft-overlay.jar') 'mod\hivecraft-overlay.jar'
# shipped default data only (never hub.json / economy / ledger / photos / blueprints / archive / memory / logs)
Copy-One (Join-Path $Root 'data\econ-catalog.json') 'data\econ-catalog.json'
# docs
Need (Join-Path $Docs 'README.md') 'release README (docs\release\README.md)'
Copy-One (Join-Path $Docs 'README.md') 'README.md'
Copy-One (Join-Path $Docs 'README.md') 'docs\README.md'
Copy-One (Join-Path $Root 'LICENSE') 'LICENSE'
Copy-One (Join-Path $Root 'THIRD_PARTY_NOTICES.md') 'THIRD_PARTY_NOTICES.md'
# append the full npm license table generated from package-lock.json (production deps only)
$tpn = Join-Path $App 'THIRD_PARTY_NOTICES.md'
$js = @'
const fs = require('fs'); const [lockFile, out] = process.argv.slice(2);
const lock = JSON.parse(fs.readFileSync(lockFile, 'utf8')); const seen = new Set(); const rows = [];
for (const [k, v] of Object.entries(lock.packages || {})) {
  if (!k || v.dev) continue;
  const n = k.replace(/^.*node_modules\//, ''); const key = n + '@' + v.version;
  if (seen.has(key)) continue; seen.add(key);
  rows.push('| ' + n + ' | ' + v.version + ' | ' + (v.license || 'see package') + ' |');
}
rows.sort((a, b) => a.localeCompare(b));
const table = '| Package | Version | License |\n|---|---|---|\n' + rows.join('\n') + '\n\n' + rows.length + ' packages.\n';
fs.writeFileSync(out, fs.readFileSync(out, 'utf8').replace('<!-- NPM-TABLE -->', table));
'@
$jsFile = Join-Path $Build 'npm-table.cjs'
Set-Content -Encoding UTF8 $jsFile $js
& node $jsFile (Join-Path $Root 'package-lock.json') $tpn
if ($LASTEXITCODE -ne 0) { Fail 'npm license table generation' }
Copy-One (Join-Path $Docs 'RELEASE_NOTES.md') 'docs\RELEASE_NOTES.md'
if (Test-Path (Join-Path $Root 'MOD_PROTOCOL.md')) { Copy-One (Join-Path $Root 'MOD_PROTOCOL.md') 'docs\MOD_PROTOCOL.md' }

$hasNodeModules = $false
if ($BundleNodeModules) {
  Write-Host '  bundling production node_modules (npm ci --omit=dev in a staging copy)'
  $stage = Join-Path $Build 'npm-stage'
  if (Test-Path $stage) { Remove-Item -Recurse -Force $stage }
  New-Item -ItemType Directory -Force $stage | Out-Null
  Copy-Item (Join-Path $Root 'package.json'), (Join-Path $Root 'package-lock.json') $stage
  Invoke-Native 'npm.cmd' @('ci', '--omit=dev', '--no-audit', '--no-fund', '--ignore-scripts') 'npm ci' $stage
  Copy-Tree (Join-Path $stage 'node_modules') (Join-Path $App 'node_modules')
  $hasNodeModules = $true
}

# sanity: nothing forbidden slipped in
$forbidden = @('hivecraft.config.json', 'data\hub.json', 'data\economy', 'data\ledger', 'data\photos', 'data\blueprints',
               'data\archive', 'data\memory', 'data\personalities.json', 'server', 'crew\logs', 'crew\work', 'crew\logs-archive')
foreach ($f in $forbidden) { if (Test-Path (Join-Path $App $f)) { Fail "forbidden path in payload: $f" } }
$logs = Get-ChildItem $App -Recurse -File -Include '*.log', '*.pid' -ErrorAction SilentlyContinue
if ($logs) { Fail "log/pid files in payload: $($logs.FullName -join ', ')" }

$exeHash = Get-Sha256 (Join-Path $App 'Hivecraft.exe')
$jarHash = Get-Sha256 (Join-Path $App 'mod\hivecraft-overlay.jar')
$manifest = [ordered]@{
  name = 'Hivecraft'; version = $Version; built = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
  hasNodeModules = $hasNodeModules; minecraft = '1.21.1'; node = '20+'
  sha256 = [ordered]@{ 'Hivecraft.exe' = $exeHash; 'mod/hivecraft-overlay.jar' = $jarHash }
}
Write-Utf8 (Join-Path $App 'manifest.json') ($manifest | ConvertTo-Json -Depth 5)
$files = (Get-ChildItem $App -Recurse -File).Count
Write-Host "  payload: $files files, $(Get-SizeMB $App) MB"
EndStep

# ---------------------------------------------------------------- 4. scrub scan (gate)
Step 'Scrub scan payload'
$scanArgs = @((Join-Path $Root 'tools\scrub-scan.mjs'), '--payload', '--root', $App, '--max', '50')
& node @scanArgs | Tee-Object -FilePath (Join-Path $Build 'scrub-payload.txt')
$scanCode = $LASTEXITCODE
if (Test-Path $asmScan) {
  Write-Host '  launcher IL assembly:'
  & node (Join-Path $Root 'tools\scrub-scan.mjs') --payload --root $asmScan --max 50 | Tee-Object -FilePath (Join-Path $Build 'scrub-assemblies.txt')
  if ($LASTEXITCODE -ne 0) { $scanCode = 1 }
}
& node (Join-Path $Root 'tools\scrub-scan.mjs') --payload --root $App --json --quiet > (Join-Path $Build 'scrub-payload.json')
$global:LASTEXITCODE = 0
if ($scanCode -ne 0) { Fail "scrub scan found personal / secret data in the payload (see dist\build\scrub-payload.txt)" }
EndStep

# ---------------------------------------------------------------- 5. zip
Step 'Zip payload'
$zip = Join-Path $Build 'payload.zip'
if (Test-Path $zip) { Remove-Item -Force $zip }
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
# entries written by hand so names always use forward slashes (ZipFile.CreateFromDirectory on .NET Framework can write '\')
$fs = [System.IO.File]::Open($zip, [System.IO.FileMode]::CreateNew)
try {
  $za = New-Object System.IO.Compression.ZipArchive($fs, [System.IO.Compression.ZipArchiveMode]::Create)
  try {
    $base = $App.TrimEnd('\') + '\'
    foreach ($f in (Get-ChildItem $App -Recurse -File | Sort-Object FullName)) {
      $name = $f.FullName.Substring($base.Length).Replace('\', '/')
      $level = if ($f.Extension -in '.jar', '.zip', '.png', '.jpg') { [System.IO.Compression.CompressionLevel]::NoCompression } else { [System.IO.Compression.CompressionLevel]::Optimal }
      [void][System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($za, $f.FullName, $name, $level)
    }
  } finally { $za.Dispose() }
} finally { $fs.Dispose() }
Copy-Item $zip (Join-Path $Dist 'Hivecraft-payload.zip') -Force
$zipHash = Get-Sha256 $zip
Write-Host "  payload.zip: $(Get-SizeMB $zip) MB  sha256 $zipHash"
EndStep

# ---------------------------------------------------------------- 6. installer
$setup = Join-Path $Dist 'Hivecraft-Setup.exe'
$setupHash = $null
if (-not $NoInstaller) {
  Step 'Publish installer (Hivecraft-Setup.exe)'
  Sync-DotnetSrc
  $proj = Join-Path $Src 'installer\HivecraftSetup.csproj'
  Need $proj 'installer project'
  $instOut = Join-Path $Build 'installer'
  if (Test-Path $instOut) { Remove-Item -Recurse -Force $instOut }
  Invoke-Native 'dotnet' @('publish', $proj, '-c', 'Release', '-r', 'win-x64', '--self-contained', '-p:PublishSingleFile=true',
    '-p:DebugType=none', '-p:DebugSymbols=false', "-p:Version=$Version", '-p:Deterministic=true', '-p:ContinuousIntegrationBuild=true',
    "-p:PayloadZip=$zip", '-o', $instOut, '--nologo') 'dotnet publish installer'
  $built = Join-Path $instOut 'Hivecraft-Setup.exe'
  Need $built 'installer exe'
  Copy-Item $built $setup -Force
  # binary scan of the exe itself (catches PDB paths / literals; the embedded zip was scanned above) + its IL assembly
  $instScan = Join-Path $Build 'scan-installer'
  if (Test-Path $instScan) { Remove-Item -Recurse -Force $instScan }
  New-Item -ItemType Directory -Force $instScan | Out-Null
  Copy-Item $built $instScan
  $idl = Get-ChildItem (Join-Path $Src 'installer\obj\Release') -Recurse -Filter 'Hivecraft-Setup.dll' -ErrorAction SilentlyContinue | Where-Object { $_.FullName -notmatch '\\ref(int)?\\' } | Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if ($idl) { Copy-Item $idl.FullName $instScan }
  & node (Join-Path $Root 'tools\scrub-scan.mjs') --payload --root $instScan --max 50 | Tee-Object -FilePath (Join-Path $Build 'scrub-installer.txt')
  if ($LASTEXITCODE -ne 0) { Remove-Item -Force $setup; Fail 'scrub scan found personal data in the installer exe' }
  $setupHash = Get-Sha256 $setup
  "$setupHash *Hivecraft-Setup.exe" | Set-Content -Encoding ASCII "$setup.sha256"
  Write-Host "  Hivecraft-Setup.exe: $(Get-SizeMB $setup) MB  sha256 $setupHash"
  EndStep
}

# ---------------------------------------------------------------- 7. notes + report
Step 'Release notes + report'
$notes = Get-Content -Raw (Join-Path $Docs 'RELEASE_NOTES.md')
$notes = $notes.Replace('{{VERSION}}', $Version).Replace('{{DATE}}', (Get-Date).ToString('yyyy-MM-dd'))
$notes += "`r`n## Files`r`n`r`n| File | Size | SHA-256 |`r`n|---|---|---|`r`n"
if ($setupHash) { $notes += "| Hivecraft-Setup.exe | $(Get-SizeMB $setup) MB | ``$setupHash`` |`r`n" }
$notes += "| Hivecraft-payload.zip (embedded in the setup) | $(Get-SizeMB $zip) MB | ``$zipHash`` |`r`n"
$notes += "| Hivecraft.exe (launcher, inside the payload) | $(Get-SizeMB (Join-Path $App 'Hivecraft.exe')) MB | ``$exeHash`` |`r`n"
$notes += "| mod/hivecraft-overlay.jar | $([math]::Round((Get-Item (Join-Path $App 'mod\hivecraft-overlay.jar')).Length/1KB)) KB | ``$jarHash`` |`r`n"
Write-Utf8 (Join-Path $Dist 'RELEASE_NOTES.md') $notes

$report = [ordered]@{
  version = $Version; built = $manifest.built; totalSeconds = [math]::Round(((Get-Date) - $t0).TotalSeconds, 1); steps = $times
  payloadFiles = $files; payloadMB = (Get-SizeMB $App); payloadZipMB = (Get-SizeMB $zip); payloadZipSha256 = $zipHash
  setupMB = $(if ($setupHash) { Get-SizeMB $setup } else { $null }); setupSha256 = $setupHash
  launcherSha256 = $exeHash; modJarSha256 = $jarHash; hasNodeModules = $hasNodeModules; scrub = 'clean'
}
Write-Utf8 (Join-Path $Dist 'build-report.json') ($report | ConvertTo-Json -Depth 5)
EndStep

Write-Host ''
Write-Host "RELEASE OK  v$Version  in $($report.totalSeconds)s" -ForegroundColor Green
if ($setupHash) { Write-Host "  $setup  ($($report.setupMB) MB)" }
Write-Host "  $(Join-Path $Dist 'Hivecraft-payload.zip')  ($($report.payloadZipMB) MB)"
exit 0
