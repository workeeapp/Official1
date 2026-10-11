# Poll origin for the current branch; when remote is ahead and the tree is clean,
# run refresh with -RequireClean -NoWait. Intended for Official1-live.
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

if ($root -ne $scriptCheckout) {
  Write-WatchLog "Using live worktree $root (invoked from $scriptCheckout)"
}
Write-WatchLog "Watch started in $root (interval ${IntervalSec}s)"

while ($true) {
  try {
    Set-Location $root
    git fetch origin 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) {
      Write-WatchLog "git fetch failed (exit $LASTEXITCODE)"
      Start-Sleep -Seconds $IntervalSec
      continue
    }

    $branch = (git rev-parse --abbrev-ref HEAD).Trim()
    if (-not $branch -or $branch -eq "HEAD") {
      Write-WatchLog "Detached HEAD - skip"
      Start-Sleep -Seconds $IntervalSec
      continue
    }

    $remoteRef = "origin/$branch"
    git rev-parse --verify $remoteRef 2>$null | Out-Null
    if ($LASTEXITCODE -ne 0) {
      Write-WatchLog "No $remoteRef - skip"
      Start-Sleep -Seconds $IntervalSec
      continue
    }

    $counts = (git rev-list --left-right --count "HEAD...$remoteRef").Trim()
    # ahead behind → local...remote : left = ahead of remote, right = behind remote
    $parts = $counts -split '\s+'
    $ahead = [int]$parts[0]
    $behind = [int]$parts[1]

    if ($behind -le 0) {
      Start-Sleep -Seconds $IntervalSec
      continue
    }

    if (-not (Test-WorkeeGitClean $root)) {
      Write-WatchLog "Remote ahead by $behind on $branch but tree dirty - skip refresh"
      Start-Sleep -Seconds $IntervalSec
      continue
    }

    if (Test-WorkeeRefreshLockHeld) {
      Write-WatchLog "Remote ahead by $behind but refresh lock held - skip"
      Start-Sleep -Seconds $IntervalSec
      continue
    }

    Write-WatchLog "origin/$branch is ahead by $behind (local ahead=$ahead) - refreshing"
    Invoke-WorkeeRefresh -RepoRoot $root -RequireClean -NoWait
    Write-WatchLog "Refresh finished OK"
  } catch {
    Write-WatchLog "Error: $_"
  }
  Start-Sleep -Seconds $IntervalSec
}
