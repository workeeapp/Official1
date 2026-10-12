# After a successful local push: refresh the live worktree (or this repo if no live root).
# Used by post-push hook and npm run push:live.
$ErrorActionPreference = "Stop"
$env:Path = @("C:\Program Files\nodejs", $env:Path) -join ";"

. (Join-Path $PSScriptRoot "workee-common.ps1")
Ensure-WorkeeAppData

$logFile = Join-Path $script:WorkeeAppData "refresh-after-push.log"
function Write-PushLog([string]$message) {
  $line = "{0} {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $message
  Add-Content -Path $logFile -Value $line
  Write-Host $line
}

$live = Get-WorkeeLiveRoot
$target = if ($live) { $live } else { Split-Path -Parent $PSScriptRoot }

if (-not (Test-Path -LiteralPath (Join-Path $target "scripts\refresh-workee.ps1"))) {
  Write-PushLog "No refresh script under $target - skip"
  exit 0
}

if (-not (Test-WorkeeGitClean $target)) {
  Write-PushLog "Target dirty ($target) - skip auto refresh"
  exit 0
}

if (Test-WorkeeRefreshLockHeld) {
  Write-PushLog "Refresh lock held - skip"
  exit 0
}

Write-PushLog "Refreshing after push in $target"
try {
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  Invoke-WorkeeRefresh -RepoRoot $target -RequireClean -NoWait
  Write-PushLog ("Refresh finished OK ({0}s)" -f [int]$sw.Elapsed.TotalSeconds)
} catch {
  Write-PushLog "Refresh failed: $_"
  exit 1
}
