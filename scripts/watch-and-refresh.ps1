# Poll the configured upstream; when remote is ahead and the tree is clean,
# run refresh with -RequireClean -NoWait. Intended for Official1-live
# (local branch live/<shared> tracking origin/<shared>).
param(
  [int]$IntervalSec = 60
)

$ErrorActionPreference = "Stop"
$env:Path = @("C:\Program Files\nodejs", $env:Path) -join ";"

. (Join-Path $PSScriptRoot "workee-common.ps1")
Ensure-WorkeeAppData

$scriptCheckout = Split-Path -Parent $PSScriptRoot
$root = Get-WorkeeRuntimeRoot -ScriptCheckoutRoot $scriptCheckout
Set-Location $root

$logFile = Join-Path $script:WorkeeAppData "refresh-watch.log"

function Write-WatchLog([string]$message) {
  $line = "{0} {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $message
  Add-Content -Path $logFile -Value $line
  Write-Host $line
}

function Get-WorkeeUpstreamRef {
  $upstream = (git rev-parse --abbrev-ref "@{u}" 2>$null).Trim()
  if ($LASTEXITCODE -ne 0 -or -not $upstream) {
    return $null
  }
  return $upstream
}

if ($root -ne $scriptCheckout) {
  Write-WatchLog "Using live worktree $root (invoked from $scriptCheckout)"
}
Write-WatchLog "Watch started in $root (interval ${IntervalSec}s)"

while ($true) {
  try {
    Set-Location $root
    # git writes "From https://..." to stderr; with 2>&1 + Stop that becomes a terminating error.
    $prevEap = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    git fetch origin --quiet
    $fetchExit = $LASTEXITCODE
    $ErrorActionPreference = $prevEap
    if ($fetchExit -ne 0) {
      Write-WatchLog "git fetch failed (exit $fetchExit)"
      Start-Sleep -Seconds $IntervalSec
      continue
    }

    $branch = (git rev-parse --abbrev-ref HEAD).Trim()
    if (-not $branch -or $branch -eq "HEAD") {
      Write-WatchLog "Detached HEAD - skip"
      Start-Sleep -Seconds $IntervalSec
      continue
    }

    $upstream = Get-WorkeeUpstreamRef
    if (-not $upstream) {
      Write-WatchLog "No upstream for $branch - skip (set with git branch -u origin/<shared>)"
      Start-Sleep -Seconds $IntervalSec
      continue
    }

    $counts = (git rev-list --left-right --count "HEAD...@{u}").Trim()
    # ahead behind → local...upstream : left = ahead of upstream, right = behind
    $parts = $counts -split '\s+'
    $ahead = [int]$parts[0]
    $behind = [int]$parts[1]

    if ($behind -le 0) {
      Start-Sleep -Seconds $IntervalSec
      continue
    }

    if (-not (Test-WorkeeGitClean $root)) {
      Write-WatchLog "$upstream ahead by $behind but tree dirty - skip refresh"
      Start-Sleep -Seconds $IntervalSec
      continue
    }

    if (Test-WorkeeRefreshLockHeld) {
      Write-WatchLog "$upstream ahead by $behind but refresh lock held - skip"
      Start-Sleep -Seconds $IntervalSec
      continue
    }

    Write-WatchLog "$upstream is ahead by $behind (local ahead=$ahead on $branch) - refreshing"
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    Invoke-WorkeeRefresh -RepoRoot $root -RequireClean -NoWait
    Write-WatchLog ("Refresh finished OK ({0}s)" -f [int]$sw.Elapsed.TotalSeconds)
  } catch {
    Write-WatchLog "Error: $_"
  }
  Start-Sleep -Seconds $IntervalSec
}
