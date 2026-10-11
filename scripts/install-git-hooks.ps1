# Install post-push hook that refreshes the live worktree after a successful push.
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
