# One-shot: pull, install, migrate, generate, build SPA, free ports, restart, health-check.
# Serves https://wa.workee.site via API+frontend/dist when cloudflared points at the API port.
$ErrorActionPreference = "Stop"
$env:Path = @("C:\Program Files\nodejs", $env:Path) -join ";"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$PublicOrigin = "https://wa.workee.site"

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

function Stop-WorkeePorts {
  $apiPort = Get-DotEnvPort
  foreach ($port in @($apiPort, 5173)) {
    Get-NetTCPConnection -LocalPort $port -ErrorAction SilentlyContinue |
      Where-Object { $_.OwningProcess -gt 0 } |
      ForEach-Object {
        Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue
        Write-Step "Stopped PID $($_.OwningProcess) on port $port"
      }
  }
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -match 'tsx watch|vite|concurrently -n api' } |
    ForEach-Object {
      Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
      Write-Step "Stopped node $($_.ProcessId)"
    }
  $deadline = (Get-Date).AddSeconds(15)
  while ((Get-Date) -lt $deadline) {
    if ((Test-PortFree $apiPort) -and (Test-PortFree 5173)) {
      return
    }
    Start-Sleep -Seconds 1
  }
  throw "Ports $apiPort/5173 still busy after stop"
}

function Invoke-NativeOk([string]$label) {
  if ($LASTEXITCODE -ne 0) {
    throw "$label failed (exit $LASTEXITCODE)"
  }
}

function Ensure-ClientOrigin {
  $envFile = Join-Path $root ".env"
  if (-not (Test-Path $envFile)) {
    Write-Warning ".env missing — skip CLIENT_ORIGIN update"
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
    Write-Step "Updated CLIENT_ORIGIN → $next"
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

function Wait-WorkeeHealthy([int]$apiPort, [int]$timeoutSec = 120) {
  $deadline = (Get-Date).AddSeconds($timeoutSec)
  $needDashboard = Test-Path (Join-Path $root "frontend\dist\index.html")
  while ((Get-Date) -lt $deadline) {
    $apiOk = Test-HttpOk "http://127.0.0.1:$apiPort/api/health"
    $viteOk = Test-HttpOk "http://127.0.0.1:5173/"
    $dashOk = -not $needDashboard -or (Test-HttpOk "http://127.0.0.1:$apiPort/dashboard")
    if ($apiOk -and $viteOk -and $dashOk) {
      return
    }
    Start-Sleep -Seconds 1
  }
  throw "Timed out waiting for health (api :$apiPort, vite :5173, dashboard from API if dist exists)"
}

function Assert-Cloudflared {
  $cf = Get-Process -Name cloudflared -ErrorAction SilentlyContinue
  if ($cf) {
    Write-Step "cloudflared is running (PID $(($cf | Select-Object -First 1).Id))"
  } else {
    Write-Warning "cloudflared is NOT running — $PublicOrigin will not reach this machine until the tunnel is up"
  }
}

Write-Step "Refreshing Workee in $root"
$apiPort = Get-DotEnvPort

# Tracked files only — never stash -u (would remove this script mid-run).
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
    Write-Step "Pull failed — restoring stash"
    git stash pop
  }
  throw "git pull --ff-only failed (exit $LASTEXITCODE)"
}

if ($didStash) {
  Write-Step "Restoring local changes"
  git stash pop
  if ($LASTEXITCODE -ne 0) {
    Write-Warning "stash pop conflicted — resolve manually (see git stash list)"
  }
}

Write-Step "npm install"
npm install
Invoke-NativeOk "npm install"

Write-Step "Freeing ports $apiPort / 5173"
Stop-WorkeePorts

Write-Step "Applying migrations (db:deploy)"
npm run db:deploy
Invoke-NativeOk "db:deploy"

Write-Step "Generating Prisma client"
npx prisma generate
Invoke-NativeOk "prisma generate"

Ensure-ClientOrigin

Write-Step "Building frontend SPA (for $PublicOrigin via API)"
npm run build -w frontend
Invoke-NativeOk "frontend build"

Assert-Cloudflared

Write-Step "Starting npm run dev (api + web)"
$npm = Get-Command npm.cmd -ErrorAction SilentlyContinue
if (-not $npm) {
  $npm = Get-Command npm -ErrorAction Stop
}
$dev = Start-Process -FilePath $npm.Source -ArgumentList @("run", "dev") -WorkingDirectory $root -PassThru -NoNewWindow
try {
  Write-Step "Waiting for health (API :$apiPort, Vite :5173, /dashboard from API)..."
  Wait-WorkeeHealthy $apiPort 120
  Write-Step "Healthy — API http://localhost:$apiPort  Vite http://127.0.0.1:5173/  SPA http://127.0.0.1:$apiPort/dashboard"
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
