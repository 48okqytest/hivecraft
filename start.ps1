<#
  Hivecraft launcher:  MC server (if not already on 25590) -> bridge (47960) -> crew (Claude Code players).
  Examples:
    .\start.ps1                              # server + bridge + crew with roster defaults
    .\start.ps1 -Agents 3 -Minutes 60        # passthrough to crew
    .\start.ps1 -Goal "Build a base and get iron gear"
    .\start.ps1 -NoCrew                      # only server + bridge + dashboard
    .\start.ps1 -Mock -NoCrew                # bridge with the fake engine (no Minecraft needed)
  Extra crew flags can be appended, e.g.  .\start.ps1 -Agents 2 --model claude-sonnet-5-5
  Logs: server\server-out.log  data\bridge.log   Stop everything: .\stop.ps1
#>
param(
  [int]$Agents = 0,
  [int]$Minutes = 0,
  [string]$Goal = '',
  [string]$Model = '',
  [switch]$NoCrew,
  [switch]$NoServer,
  [switch]$Mock,
  [int]$Port = 47960,
  [Parameter(ValueFromRemainingArguments = $true)] $CrewExtra
)
$ErrorActionPreference = 'Stop'
$Root = $PSScriptRoot
$DataDir = Join-Path $Root 'data'
New-Item -ItemType Directory -Force $DataDir | Out-Null

function Test-Port([int]$p) {
  $c = New-Object System.Net.Sockets.TcpClient
  try {
    $iar = $c.BeginConnect('127.0.0.1', $p, $null, $null)
    if ($iar.AsyncWaitHandle.WaitOne(800) -and $c.Connected) { return $true } else { return $false }
  } catch { return $false } finally { $c.Close() }
}
function Wait-Port([int]$p, [int]$timeoutSec, [string]$what) {
  $t0 = Get-Date
  while (((Get-Date) - $t0).TotalSeconds -lt $timeoutSec) {
    if (Test-Port $p) { return }
    Start-Sleep -Milliseconds 700
  }
  throw "$what did not come up on port $p within $timeoutSec s"
}
function Bridge-Healthy {
  try { $r = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/health" -TimeoutSec 2; return [bool]$r.ok } catch { return $false }
}

# ---- 1. Minecraft server ----
if (-not $NoServer -and -not $Mock) {
  if (Test-Port 25590) {
    Write-Host '[start] Minecraft server already running on 25590'
  } else {
    $srv = Join-Path $Root 'server'
    if (-not (Test-Path (Join-Path $srv 'server.jar'))) { throw "server\server.jar missing" }
    Write-Host '[start] starting Minecraft server (1.21.1, offline mode)...'
    $p = Start-Process -FilePath 'java' -ArgumentList @('-Xmx3G', '-jar', 'server.jar', 'nogui') -WorkingDirectory $srv `
      -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $srv 'server-out.log') -RedirectStandardError (Join-Path $srv 'server-err.log')
    Set-Content -Path (Join-Path $srv 'server.pid') -Value $p.Id
    Wait-Port 25590 180 'Minecraft server'
    Wait-Port 25591 30 'RCON'
    Write-Host "[start] server up (pid $($p.Id))"
  }
}

# ---- 2. bridge ----
if (Bridge-Healthy) {
  Write-Host "[start] bridge already running on $Port"
} else {
  Write-Host "[start] starting bridge on $Port$(if ($Mock) { ' (MOCK engine)' })..."
  $env:HIVE_PORT = "$Port"
  if ($Mock) { $env:HIVE_ENGINE = 'mock' } else { Remove-Item Env:HIVE_ENGINE -ErrorAction SilentlyContinue }
  $bp = Start-Process -FilePath 'node' -ArgumentList @('bridge/server.js') -WorkingDirectory $Root -WindowStyle Hidden -PassThru `
    -RedirectStandardOutput (Join-Path $DataDir 'bridge.log') -RedirectStandardError (Join-Path $DataDir 'bridge.err.log')
  Set-Content -Path (Join-Path $DataDir 'bridge.pid') -Value $bp.Id
  $t0 = Get-Date
  while (-not (Bridge-Healthy)) {
    if ($bp.HasExited) { throw "bridge exited early; see data\bridge.err.log" }
    if (((Get-Date) - $t0).TotalSeconds -gt 30) { throw 'bridge did not become healthy in 30s' }
    Start-Sleep -Milliseconds 500
  }
  Write-Host "[start] bridge up (pid $($bp.Id))  dashboard: http://127.0.0.1:$Port/"
}

# ---- 3. crew ----
if ($NoCrew) {
  Write-Host "[start] -NoCrew: done. Dashboard http://127.0.0.1:$Port/"
  return
}
$crewArgs = @('crew/crew.js')
if ($Agents -gt 0) { $crewArgs += @('--agents', "$Agents") }
if ($Minutes -gt 0) { $crewArgs += @('--minutes', "$Minutes") }
if ($Goal) { $crewArgs += @('--goal', $Goal) }
if ($Model) { $crewArgs += @('--model', $Model) }
if ($CrewExtra) { $crewArgs += $CrewExtra }
$crewArgs += @('--url', "http://127.0.0.1:$Port")
Write-Host "[start] launching crew: node $($crewArgs -join ' ')"
$cp = Start-Process -FilePath 'node' -ArgumentList $crewArgs -WorkingDirectory $Root -NoNewWindow -PassThru
Set-Content -Path (Join-Path $DataDir 'crew.pid') -Value $cp.Id
try {
  $cp.WaitForExit()
  Write-Host "[start] crew exited (code $($cp.ExitCode)). Server + bridge keep running; .\stop.ps1 to stop them."
} finally {
  Remove-Item (Join-Path $DataDir 'crew.pid') -ErrorAction SilentlyContinue
}
