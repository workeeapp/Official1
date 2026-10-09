# One-shot: pull, install, migrate, generate, build SPA, free ports, restart, health-check.
# Serves https://wa.workee.site via API+frontend/dist when cloudflared points at the API port.
$ErrorActionPreference = "Stop"
$env:Path = @("C:\Program Files\nodejs", $env:Path) -join ";"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$PublicOrigin = "https://wa.workee.site"
$VitePort = 5173

function Write-Step([string]$message) {
  Write-Host ("[{0}] {1}" -f (Get-Date -Format "HH:mm:ss"), $message)
}

function Get-DotEnvPort {
  $envFile = Join-Path $root ".env"
  if (-not (Test-Path $envFile)) {
    return 3003
  }
  $line = Get-Content $envFile | Where-Object { $_ -match '^\s*PORT\s*=' } | Select-Object -First 1
  if ($line -match 'PORT\s*=\s*(\d+)') {
    return [int]$Matches[1]
  }
  return 3003
}

function Test-PortFree([int]$port) {
  -not [bool](Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)
}

function Get-PortListenerPid([int]$port) {
  $conn = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue |
    Where-Object { $_.OwningProcess -gt 0 } |
    Select-Object -First 1
  if ($conn) { return [int]$conn.OwningProcess }
  return $null
}

function Get-ProcessTreeIds([int]$rootPid) {
  $byParent = @{}
  Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | ForEach-Object {
    $ppid = [int]$_.ParentProcessId
    if (-not $byParent.ContainsKey($ppid)) {
      $byParent[$ppid] = [System.Collections.Generic.List[int]]::new()
    }
    $byParent[$ppid].Add([int]$_.ProcessId)
  }
  $ids = [System.Collections.Generic.HashSet[int]]::new()
  $queue = [System.Collections.Generic.Queue[int]]::new()
  $queue.Enqueue($rootPid)
  while ($queue.Count -gt 0) {
    $processId = $queue.Dequeue()
    if (-not $ids.Add($processId)) { continue }
    if ($byParent.ContainsKey($processId)) {
      foreach ($child in $byParent[$processId]) {
        $queue.Enqueue($child)
      }
    }
  }
  return $ids
}

function Test-PidInTree([int]$processId, [int]$rootPid) {
  if ($processId -le 0 -or $rootPid -le 0) { return $false }
  $tree = Get-ProcessTreeIds $rootPid
  return $tree.Contains($processId)
}

function Get-ProtectedPids {
  # Never kill this refresh PowerShell or its parents (npm/cmd wrappers).
  $protected = Get-ProcessTreeIds $PID
  $walk = $PID
  for ($i = 0; $i -lt 6; $i++) {
    $row = Get-CimInstance Win32_Process -Filter "ProcessId=$walk" -ErrorAction SilentlyContinue
    if (-not $row) { break }
    [void]$protected.Add([int]$row.ProcessId)
    $walk = [int]$row.ParentProcessId
    if ($walk -le 0) { break }
    [void]$protected.Add($walk)
  }
  return $protected
}

function Stop-WorkeePorts {
  $apiPort = Get-DotEnvPort
  $protected = Get-ProtectedPids
  for ($attempt = 1; $attempt -le 3; $attempt++) {
    foreach ($port in @($apiPort, $VitePort)) {
      Get-NetTCPConnection -LocalPort $port -ErrorAction SilentlyContinue |
        Where-Object { $_.OwningProcess -gt 0 -and -not $protected.Contains([int]$_.OwningProcess) } |
        ForEach-Object {
          $owner = [int]$_.OwningProcess
          Stop-Process -Id $owner -Force -ErrorAction SilentlyContinue
          Write-Step "Stopped PID $owner on port $port"
        }
    }
    Get-CimInstance Win32_Process -Filter "Name='node.exe' OR Name='cmd.exe'" -ErrorAction SilentlyContinue |
      Where-Object {
        $_.CommandLine -and
        -not $protected.Contains([int]$_.ProcessId) -and (
          $_.CommandLine -match 'tsx watch|node_modules[\\/]vite[\\/]|concurrently -n api|npm run dev -w backend|@workee/backend'
        )
      } |
      ForEach-Object {
        Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
        Write-Step "Stopped $($_.Name) $($_.ProcessId)"
      }

    $deadline = (Get-Date).AddSeconds(15)
    while ((Get-Date) -lt $deadline) {
      if ((Test-PortFree $apiPort) -and (Test-PortFree $VitePort)) {
        Write-Step "Ports $apiPort / $VitePort are free"
        return
      }
      Start-Sleep -Milliseconds 500
    }
    Write-Step "Ports still busy after stop attempt $attempt - retrying"
  }
  throw "Ports $apiPort/$VitePort still busy after stop"
}

function Invoke-NativeOk([string]$label) {
  if ($LASTEXITCODE -ne 0) {
    throw "$label failed (exit $LASTEXITCODE)"
  }
}

function Ensure-ClientOrigin {
  $envFile = Join-Path $root ".env"
  if (-not (Test-Path $envFile)) {
    Write-Warning ".env missing - skip CLIENT_ORIGIN update"
    return
  }
  $raw = Get-Content $envFile -Raw
  if ($raw -match '(?m)^\s*CLIENT_ORIGIN\s*=\s*(.+)$') {
    $current = $Matches[1].Trim()
    if ($current -like "*$PublicOrigin*") {
      Write-Step "CLIENT_ORIGIN already includes $PublicOrigin"
      return
    }
    $next = if ([string]::IsNullOrWhiteSpace($current)) {
      "http://localhost:5173,$PublicOrigin"
    } else {
      "$current,$PublicOrigin"
    }
    $updated = [regex]::Replace(
      $raw,
      '(?m)^\s*CLIENT_ORIGIN\s*=\s*.*$',
      "CLIENT_ORIGIN=$next"
    )
    Set-Content -Path $envFile -Value $updated -NoNewline
    Write-Step "Updated CLIENT_ORIGIN to $next"
  } else {
    Add-Content -Path $envFile -Value "`nCLIENT_ORIGIN=http://localhost:5173,$PublicOrigin"
    Write-Step "Appended CLIENT_ORIGIN with $PublicOrigin"
  }
}

function Test-HttpOk([string]$url) {
  try {
    $res = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 3
    return ($res.StatusCode -ge 200 -and $res.StatusCode -lt 300)
  } catch {
    return $false
  }
}

function Test-DevLogConflict([string[]]$logPaths) {
  foreach ($path in $logPaths) {
    if (-not (Test-Path $path)) { continue }
    $text = Get-Content -Path $path -Raw -ErrorAction SilentlyContinue
    if ($text -and $text -match 'EADDRINUSE|address already in use') {
      return $true
    }
  }
  return $false
}

function Wait-WorkeeHealthy {
  param(
    [int]$apiPort,
    [int]$devPid,
    [string[]]$logPaths,
    [int]$timeoutSec = 120
  )
  $deadline = (Get-Date).AddSeconds($timeoutSec)
  $needDashboard = Test-Path (Join-Path $root "frontend\dist\index.html")
  while ((Get-Date) -lt $deadline) {
    if ($devPid -gt 0) {
      $proc = Get-Process -Id $devPid -ErrorAction SilentlyContinue
      if (-not $proc) {
        throw "npm run dev exited before becoming healthy (PID $devPid)"
      }
    }
    if (Test-DevLogConflict $logPaths) {
      throw "Dev log shows EADDRINUSE - a previous process still held the port"
    }

    $apiPid = Get-PortListenerPid $apiPort
    $vitePid = Get-PortListenerPid $VitePort
    $apiOk = Test-HttpOk "http://127.0.0.1:$apiPort/api/health"
    $viteOk = Test-HttpOk "http://127.0.0.1:5173/"
    $dashOk = -not $needDashboard -or (Test-HttpOk "http://127.0.0.1:$apiPort/dashboard")

    if ($apiOk -and $viteOk -and $dashOk -and $apiPid -and $vitePid) {
      $apiOurs = Test-PidInTree $apiPid $devPid
      $viteOurs = Test-PidInTree $vitePid $devPid
      if ($apiOurs -and $viteOurs) {
        # Catch late bind failures from a racing second listener.
        Start-Sleep -Seconds 2
        if (Test-DevLogConflict $logPaths) {
          throw "EADDRINUSE appeared after health - stale process raced the new API"
        }
        $apiPid2 = Get-PortListenerPid $apiPort
        if (-not (Test-PidInTree $apiPid2 $devPid)) {
          throw "API port $apiPort is no longer owned by this refresh process tree"
        }
        Write-Step "Port ownership OK (API PID $apiPid2, Vite PID $vitePid under dev PID $devPid)"
        return
      }
      Write-Step "Health OK but ports not owned by this refresh yet (API=$apiPid Vite=$vitePid) - waiting"
    }
    Start-Sleep -Seconds 1
  }
  throw "Timed out waiting for health + port ownership (api :$apiPort, vite :$VitePort under PID $devPid)"
}

function Assert-Cloudflared {
  $cf = Get-Process -Name cloudflared -ErrorAction SilentlyContinue
  if ($cf) {
    Write-Step "cloudflared is running (PID $(($cf | Select-Object -First 1).Id))"
  } else {
    Write-Warning "cloudflared is NOT running - $PublicOrigin will not reach this machine until the tunnel is up"
  }
}

Write-Step "Refreshing Workee in $root"
$apiPort = Get-DotEnvPort

# Tracked files only - never stash -u (would remove this script mid-run).
$dirtyTracked = @(git status --porcelain --untracked-files=no)
$didStash = $false
if ($dirtyTracked.Count -gt 0) {
  Write-Step "Stashing tracked local changes ($($dirtyTracked.Count) paths)"
  git stash push -m "refresh-workee auto-stash $(Get-Date -Format o)"
  Invoke-NativeOk "git stash"
  $didStash = $true
}

$branch = (git rev-parse --abbrev-ref HEAD).Trim()
Write-Step "Pulling origin/$branch"
git pull --ff-only
if ($LASTEXITCODE -ne 0) {
  if ($didStash) {
    Write-Step "Pull failed - restoring stash"
    git stash pop
  }
  throw "git pull --ff-only failed (exit $LASTEXITCODE)"
}

if ($didStash) {
  Write-Step "Restoring local changes"
  git stash pop
  if ($LASTEXITCODE -ne 0) {
    Write-Warning "stash pop conflicted - resolve manually (see git stash list)"
  }
}

Write-Step "npm install"
npm install
Invoke-NativeOk "npm install"

# Do NOT free ports here - keep-up / an old API may reclaim 3003 during the long
# migrate+build window and then collide with the new npm run dev. Stop immediately
# before start instead.

Write-Step "Applying migrations (db:deploy)"
npm run db:deploy
Invoke-NativeOk "db:deploy"

# Windows locks query_engine-windows.dll.node while the API is running — stop
# before generate. keep-up may reclaim the port during the frontend build; we
# stop again immediately before start (below).
Write-Step "Freeing ports $apiPort / $VitePort before prisma generate"
Stop-WorkeePorts

Write-Step "Generating Prisma client"
npx prisma generate
Invoke-NativeOk "prisma generate"

Ensure-ClientOrigin

Write-Step "Building frontend SPA (for $PublicOrigin via API)"
npm run build -w frontend
Invoke-NativeOk "frontend build"

Assert-Cloudflared

Write-Step "Freeing ports $apiPort / $VitePort immediately before start"
Stop-WorkeePorts

Write-Step "Starting npm run dev (api + web)"
$npm = Get-Command npm.cmd -ErrorAction SilentlyContinue
if (-not $npm) {
  $npm = Get-Command npm -ErrorAction Stop
}
$logDir = Join-Path $env:TEMP "workee-refresh"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$outLog = Join-Path $logDir "dev-out.log"
$errLog = Join-Path $logDir "dev-err.log"
Remove-Item $outLog, $errLog -ErrorAction SilentlyContinue

$dev = Start-Process -FilePath $npm.Source `
  -ArgumentList @("run", "dev") `
  -WorkingDirectory $root `
  -PassThru `
  -NoNewWindow `
  -RedirectStandardOutput $outLog `
  -RedirectStandardError $errLog
try {
  Write-Step "Waiting for health + ownership (API :$apiPort, Vite :$VitePort, under PID $($dev.Id))..."
  Wait-WorkeeHealthy -apiPort $apiPort -devPid $dev.Id -logPaths @($outLog, $errLog) -timeoutSec 120
  Write-Step "Healthy - API http://localhost:$apiPort  Vite http://127.0.0.1:$VitePort/  SPA http://127.0.0.1:$apiPort/dashboard"
  Write-Step "Public (if tunnel up): $PublicOrigin/dashboard"
  Write-Step "Dev is running (PID $($dev.Id)). Ctrl+C stops this watcher; stop node to free ports."
  Wait-Process -Id $dev.Id
} catch {
  if ($dev -and -not $dev.HasExited) {
    Stop-Process -Id $dev.Id -Force -ErrorAction SilentlyContinue
  }
  Stop-WorkeePorts
  throw
}
