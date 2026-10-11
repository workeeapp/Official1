# Create sibling worktree Official1-live for the WhatsApp / live stack.
# Git cannot check out the same branch in two worktrees, so live uses a local
# branch live/<shared-branch> that tracks origin/<shared-branch>.
# Run from the primary checkout (e.g. Official1). Does not commit secrets.
param(
  [string]$LivePath = ""
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "workee-common.ps1")

$primary = Split-Path -Parent $PSScriptRoot
Set-Location $primary

if (-not $LivePath) {
  $parent = Split-Path -Parent $primary
  $LivePath = Join-Path $parent "Official1-live"
}

if (Test-Path -LiteralPath $LivePath) {
  throw "Live path already exists: $LivePath"
}

$branch = (git rev-parse --abbrev-ref HEAD).Trim()
if (-not $branch -or $branch -eq "HEAD") {
  throw "Checkout a named branch before creating the live worktree."
}
if ($branch -like "live/*") {
  throw "Primary checkout is already on a live/* branch ($branch). Switch to the shared branch first."
}

$liveBranch = "live/$branch"
$upstream = "origin/$branch"

git rev-parse --verify $upstream 2>$null | Out-Null
if ($LASTEXITCODE -ne 0) {
  Write-Host "Fetching $upstream..."
  git fetch origin $branch
  if ($LASTEXITCODE -ne 0) {
    throw "Missing $upstream - push the shared branch once, then retry live:setup."
  }
}

git show-ref --verify --quiet "refs/heads/$liveBranch"
if ($LASTEXITCODE -eq 0) {
  throw "Local branch $liveBranch already exists. Delete it or pass a different -LivePath after cleanup."
}

Write-Host "Creating worktree at $LivePath"
Write-Host "  local branch: $liveBranch (tracks $upstream)"
git worktree add -b $liveBranch $LivePath $branch
if ($LASTEXITCODE -ne 0) {
  throw "git worktree add failed (exit $LASTEXITCODE)"
}

Push-Location $LivePath
try {
  git branch --set-upstream-to=$upstream $liveBranch
  if ($LASTEXITCODE -ne 0) {
    throw "Failed to set upstream $upstream on $liveBranch"
  }
} finally {
  Pop-Location
}

$srcEnv = Join-Path $primary ".env"
$dstEnv = Join-Path $LivePath ".env"
if ((Test-Path -LiteralPath $srcEnv) -and -not (Test-Path -LiteralPath $dstEnv)) {
  Copy-Item -LiteralPath $srcEnv -Destination $dstEnv
  Write-Host "Copied .env into live worktree (not committed)."
} elseif (-not (Test-Path -LiteralPath $srcEnv)) {
  Write-Warning "No .env in primary checkout - copy one into $LivePath before keep-up / refresh."
}

$resolved = Set-WorkeeLiveRoot $LivePath
Write-Host ""
Write-Host "Live worktree ready: $resolved"
Write-Host "  WORKEE_LIVE_ROOT saved (user env + $script:WorkeeLiveRootFile)"
Write-Host "  Watches $upstream via local branch $liveBranch"
Write-Host ""
Write-Host "Next:"
Write-Host "  1. Edit / npm run dev only in: $primary (stay on $branch)"
Write-Host "  2. From live folder: npm install   (once)"
Write-Host "  3. npm run keep-up:install         (registers keep-up + refresh watcher)"
Write-Host "  4. npm run hooks:install           (post-push refreshes live)"
Write-Host "  Do not edit files in Official1-live; keep that tree clean."
