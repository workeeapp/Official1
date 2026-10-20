# Install git hooks: pre-push (version bump) + post-push (refresh live worktree).
# Worktrees share the common .git hooks directory.
$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$commonDir = (git rev-parse --git-common-dir).Trim()
if (-not [System.IO.Path]::IsPathRooted($commonDir)) {
  $commonDir = Join-Path $root $commonDir
}
$hooksDir = Join-Path $commonDir "hooks"
New-Item -ItemType Directory -Force -Path $hooksDir | Out-Null

# --- pre-push: bump VERSION on every branch push ---
$prePushPath = Join-Path $hooksDir "pre-push"
$prePushSrc = Join-Path $PSScriptRoot "pre-push-bump-version.sh"
Copy-Item -Force -Path $prePushSrc -Destination $prePushPath
Write-Host "Installed pre-push hook: $prePushPath"
Write-Host "Every git push bumps VERSION (skip with WORKEE_SKIP_VERSION_BUMP=1)."

# --- post-push: refresh live worktree ---
$hookPath = Join-Path $hooksDir "post-push"
$refreshAfterPush = Join-Path $PSScriptRoot "refresh-after-push.ps1"

$hookBody = @"
#!/bin/sh
# Installed by scripts/install-git-hooks.ps1 — refresh live Workee after push.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$refreshAfterPush"
exit 0
"@

[System.IO.File]::WriteAllText($hookPath, $hookBody.Replace("`r`n", "`n"))
Write-Host "Installed post-push hook: $hookPath"
Write-Host "After git push, runs: $refreshAfterPush"
Write-Host "Set WORKEE_LIVE_ROOT (or run npm run live:setup) so the hook refreshes Official1-live."
