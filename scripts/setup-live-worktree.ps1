# Create sibling worktree Official1-live for the WhatsApp / live stack.
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

Write-Host "Creating worktree at $LivePath (branch $branch)..."
git worktree add $LivePath $branch
if ($LASTEXITCODE -ne 0) {
  throw "git worktree add failed (exit $LASTEXITCODE)"
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
Write-Host ""
Write-Host "Next:"
Write-Host "  1. Edit / npm run dev only in: $primary"
Write-Host "  2. From live folder: npm install   (once)"
Write-Host "  3. npm run keep-up:install         (from live - registers keep-up + refresh watcher)"
Write-Host "  4. npm run hooks:install           (from either checkout - post-push refreshes live)"
Write-Host "  Do not edit files in Official1-live; keep that tree clean."
