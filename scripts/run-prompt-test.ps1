# Smoke the updated Lucy prompt against workee_prompt_test without touching live.
# Does NOT run refresh / InheritConfig against Official1-live.
#
# Prerequisites: DB workee_prompt_test exists; .env.prompt-test points at it (PORT=3004).
# Usage (from Official1 primary):
#   powershell -NoProfile -File scripts/run-prompt-test.ps1
#   then open http://127.0.0.1:5174/

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$envFile = Join-Path $root ".env.prompt-test"
if (-not (Test-Path $envFile)) {
  throw "Missing .env.prompt-test. Copy .env and set DATABASE_URL to workee_prompt_test, PORT=3004, CLIENT_ORIGIN=http://localhost:5174"
}

Get-Content $envFile | ForEach-Object {
  if ($_ -match '^\s*([^#=]+)=(.*)$') {
    Set-Item -Path "Env:$($Matches[1].Trim())" -Value $Matches[2].Trim()
  }
}

$env:WORKEE_FORCE_LOCAL = "1"
$env:VITE_DEV_PORT = "5174"
$env:VITE_API_PROXY = "http://127.0.0.1:$($env:PORT)"

Write-Host "Prompt-test API PORT=$($env:PORT) DB=$($env:DATABASE_URL)"
Write-Host "UI http://127.0.0.1:5174/  (live workee DB is NOT used; do not run npm run refresh)"

npm run dev
