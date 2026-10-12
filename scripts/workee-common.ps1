# Shared helpers for Workee refresh / live worktree scripts.
# Dot-source: . (Join-Path $PSScriptRoot "workee-common.ps1")

$script:WorkeeAppData = Join-Path $env:LOCALAPPDATA "Workee"
$script:WorkeeLiveRootFile = Join-Path $script:WorkeeAppData "live-root.txt"
$script:WorkeeRefreshLockFile = Join-Path $script:WorkeeAppData "refresh.lock"

function Ensure-WorkeeAppData {
  New-Item -ItemType Directory -Force -Path $script:WorkeeAppData | Out-Null
}

function Get-WorkeeLiveRoot {
  if ($env:WORKEE_LIVE_ROOT -and (Test-Path -LiteralPath $env:WORKEE_LIVE_ROOT)) {
    return (Resolve-Path -LiteralPath $env:WORKEE_LIVE_ROOT).Path
  }
  if (Test-Path -LiteralPath $script:WorkeeLiveRootFile) {
    $fromFile = (Get-Content -LiteralPath $script:WorkeeLiveRootFile -Raw).Trim()
    if ($fromFile -and (Test-Path -LiteralPath $fromFile)) {
      return (Resolve-Path -LiteralPath $fromFile).Path
    }
  }
  return $null
}

function Set-WorkeeLiveRoot([string]$path) {
  Ensure-WorkeeAppData
  $resolved = (Resolve-Path -LiteralPath $path).Path
  Set-Content -LiteralPath $script:WorkeeLiveRootFile -Value $resolved -NoNewline
  [Environment]::SetEnvironmentVariable("WORKEE_LIVE_ROOT", $resolved, "User")
  $env:WORKEE_LIVE_ROOT = $resolved
  return $resolved
}

function Test-WorkeeForceLocal {
  return ($env:WORKEE_FORCE_LOCAL -match '^(1|true|yes)$')
}

# Prefer Official1-live when configured, so npm run refresh/keep-up/refresh:watch
# from the primary checkout still operate on the live tree.
# Override with WORKEE_FORCE_LOCAL=1 (or -Local on refresh).
function Get-WorkeeRuntimeRoot {
  param(
    [Parameter(Mandatory = $true)][string]$ScriptCheckoutRoot,
    [switch]$ForceLocal
  )
  $here = (Resolve-Path -LiteralPath $ScriptCheckoutRoot).Path
  if ($ForceLocal -or (Test-WorkeeForceLocal)) {
    return $here
  }
  $live = Get-WorkeeLiveRoot
  if ($live) {
    return $live
  }
  return $here
}

function Test-WorkeeGitClean([string]$repoRoot) {
  Push-Location $repoRoot
  try {
    $porcelain = @(git status --porcelain)
    return ($porcelain.Count -eq 0)
  } finally {
    Pop-Location
  }
}

# Stale lock: owner dead, or file older than this (orphan Wait / crashed refresh).
$script:WorkeeRefreshLockMaxAgeMinutes = 15

function Clear-WorkeeRefreshLockFile {
  Remove-Item -LiteralPath $script:WorkeeRefreshLockFile -Force -ErrorAction SilentlyContinue
}

function Clear-WorkeeRefreshLockForPid([int]$LockPid) {
  if ($LockPid -le 0) {
    return
  }
  if (-not (Test-Path -LiteralPath $script:WorkeeRefreshLockFile)) {
    return
  }
  $raw = (Get-Content -LiteralPath $script:WorkeeRefreshLockFile -Raw -ErrorAction SilentlyContinue)
  if ($raw -and $raw -match "pid=$LockPid\b") {
    Clear-WorkeeRefreshLockFile
  }
}

function Test-WorkeeRefreshLockHeld {
  if (-not (Test-Path -LiteralPath $script:WorkeeRefreshLockFile)) {
    return $false
  }
  $info = Get-Item -LiteralPath $script:WorkeeRefreshLockFile -ErrorAction SilentlyContinue
  if ($info -and ((Get-Date) - $info.LastWriteTime).TotalMinutes -gt $script:WorkeeRefreshLockMaxAgeMinutes) {
    Clear-WorkeeRefreshLockFile
    return $false
  }
  $raw = (Get-Content -LiteralPath $script:WorkeeRefreshLockFile -Raw -ErrorAction SilentlyContinue)
  if (-not $raw) {
    return $false
  }
  $lockPid = 0
  if ($raw -match 'pid=(\d+)') {
    $lockPid = [int]$Matches[1]
  }
  if ($lockPid -le 0) {
    return $true
  }
  $proc = Get-Process -Id $lockPid -ErrorAction SilentlyContinue
  if (-not $proc) {
    Clear-WorkeeRefreshLockFile
    return $false
  }
  return $true
}

function Enter-WorkeeRefreshLock([string]$owner) {
  Ensure-WorkeeAppData
  if (Test-WorkeeRefreshLockHeld) {
    return $false
  }
  $payload = "pid=$PID`nowner=$owner`nat=$(Get-Date -Format o)"
  Set-Content -LiteralPath $script:WorkeeRefreshLockFile -Value $payload -NoNewline
  return $true
}

function Exit-WorkeeRefreshLock {
  if (Test-Path -LiteralPath $script:WorkeeRefreshLockFile) {
    $raw = (Get-Content -LiteralPath $script:WorkeeRefreshLockFile -Raw -ErrorAction SilentlyContinue)
    if ($raw -and $raw -match "pid=$PID\b") {
      Clear-WorkeeRefreshLockFile
    }
  }
}

function Stop-WorkeeProcessTree([int]$ProcessId) {
  if ($ProcessId -le 0) {
    return
  }
  & taskkill.exe /PID $ProcessId /T /F 2>$null | Out-Null
  Stop-Process -Id $ProcessId -Force -ErrorAction SilentlyContinue
}

function Get-WorkeeRefreshTimeoutMs {
  # Default 10 minutes — enough for npm install + prisma + build + health.
  $timeoutMs = 600000
  if ($env:WORKEE_REFRESH_TIMEOUT_MS -match '^\d+$') {
    $timeoutMs = [int]$env:WORKEE_REFRESH_TIMEOUT_MS
  }
  return $timeoutMs
}

function Invoke-WorkeeRefresh {
  param(
    [Parameter(Mandatory = $true)][string]$RepoRoot,
    [switch]$RequireClean,
    [switch]$NoWait,
    [bool]$InheritConfig = $true
  )
  $refresh = Join-Path $RepoRoot "scripts\refresh-workee.ps1"
  if (-not (Test-Path -LiteralPath $refresh)) {
    throw "refresh-workee.ps1 not found under $RepoRoot"
  }
  $argList = @(
    "-NoProfile"
    "-ExecutionPolicy"
    "Bypass"
    "-File"
    $refresh
  )
  if ($RequireClean) { $argList += "-RequireClean" }
  if ($NoWait) { $argList += "-NoWait" }
  # Start-Process stringifies CLI args; "-InheritConfig:true/false/0" fails [bool]
  # binding. refresh-workee.ps1 already honors WORKEE_REFRESH_INHERIT_CONFIG.
  $timeoutMs = Get-WorkeeRefreshTimeoutMs
  $prevInherit = $env:WORKEE_REFRESH_INHERIT_CONFIG
  $env:WORKEE_REFRESH_INHERIT_CONFIG = if ($InheritConfig) { "1" } else { "0" }
  $proc = $null
  try {
    # Do not use Start-Process -Wait: it can hang forever after npm/dev children
    # exit oddly under -NoNewWindow, which blocks watch-and-refresh's poll loop.
    $proc = Start-Process -FilePath "powershell.exe" `
      -ArgumentList $argList `
      -WorkingDirectory $RepoRoot `
      -PassThru `
      -NoNewWindow
    if (-not $proc) {
      throw "failed to start refresh-workee.ps1 in $RepoRoot"
    }
    $finished = $proc.WaitForExit($timeoutMs)
    if (-not $finished) {
      Stop-WorkeeProcessTree -ProcessId $proc.Id
      Clear-WorkeeRefreshLockForPid -LockPid $proc.Id
      throw "refresh-workee.ps1 timed out after ${timeoutMs}ms in $RepoRoot (killed PID $($proc.Id))"
    }
  } finally {
    if ($null -eq $prevInherit) {
      Remove-Item Env:WORKEE_REFRESH_INHERIT_CONFIG -ErrorAction SilentlyContinue
    } else {
      $env:WORKEE_REFRESH_INHERIT_CONFIG = $prevInherit
    }
  }
  if ($null -eq $proc.ExitCode -or $proc.ExitCode -ne 0) {
    throw "refresh-workee.ps1 failed (exit $($proc.ExitCode)) in $RepoRoot"
  }
}
