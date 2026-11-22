<#
  Stops Hivecraft: crew first, then the bridge (bots quit), then the Minecraft server via RCON 'stop'.
    .\stop.ps1               # everything
    .\stop.ps1 -KeepServer   # leave the Minecraft server running
#>
param([switch]$KeepServer, [int]$Port = 47960)
$ErrorActionPreference = 'Continue'
$Root = $PSScriptRoot
$DataDir = Join-Path $Root 'data'

function Kill-Matching([string]$pattern, [string]$label) {
  $procs = Get-CimInstance Win32_Process -Filter "Name='node.exe' OR Name='claude.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine -like $pattern }
  foreach ($p in $procs) {
    Write-Host "[stop] $label pid $($p.ProcessId)"
    # taskkill /T also ends the claude.exe children the crew launched
    & taskkill /PID $p.ProcessId /T /F | Out-Null
  }
}

# 1. crew (+ its claude.exe children)
Kill-Matching '*crew?crew.js*' 'crew'
Remove-Item (Join-Path $DataDir 'crew.pid') -ErrorAction SilentlyContinue

# 2. bridge: graceful shutdown endpoint (flushes hub.json, quits bots); fall back to killing the process
try { Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:$Port/admin/shutdown" -Body '{}' -ContentType 'application/json' -TimeoutSec 5 | Out-Null; Write-Host '[stop] bridge asked to shut down' } catch { }
Start-Sleep -Milliseconds 1500
Kill-Matching '*bridge?server.js*' 'bridge'
Remove-Item (Join-Path $DataDir 'bridge.pid') -ErrorAction SilentlyContinue

# 3. Minecraft server via RCON
if (-not $KeepServer) {
  $rconUrl = ([System.Uri](Join-Path $Root 'bridge/hub/rcon.js')).AbsoluteUri
  $js = "import { rcon } from '$rconUrl'; try { const o = await rcon('stop'); console.log('[stop] rcon:', o || 'ok'); } catch (e) { console.log('[stop] rcon failed:', e.message); process.exit(2); }"
  & node --input-type=module -e $js
  $code = $LASTEXITCODE
  if ($code -eq 0) {
    for ($i = 0; $i -lt 60; $i++) {
      $c = New-Object System.Net.Sockets.TcpClient
      $open = $false
      try { $iar = $c.BeginConnect('127.0.0.1', 25590, $null, $null); $open = $iar.AsyncWaitHandle.WaitOne(500) -and $c.Connected } catch {} finally { $c.Close() }
      if (-not $open) { Write-Host '[stop] Minecraft server stopped'; break }
      Start-Sleep -Milliseconds 700
    }
  } else {
    Write-Host '[stop] server not reachable over RCON (already stopped?)'
  }
} else {
  Write-Host '[stop] -KeepServer: Minecraft server left running'
}
Write-Host '[stop] done'
