# git push then refresh live (same as post-push hook). Use when hooks are not installed.
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

git push @args
if ($LASTEXITCODE -ne 0) {
  throw "git push failed (exit $LASTEXITCODE)"
}

& (Join-Path $PSScriptRoot "refresh-after-push.ps1")
