# Loads process-scoped eval env from gitignored .env.live-full-eval (workee_test).
# Does not modify shared .env or running product processes.
# Fail-closed: missing file / missing keys / URL mismatch → throw (no product .env fallback).
#
# Usage (from repo root):
#   . .\scripts\Load-LiveFullEvalEnv.ps1
# Then (separately approved): npm run test:eval-db -w backend -- <suite>
#   or LIVE_FULL: npm run test:model-eval-full -w backend
#
# Node/vitest equivalent (same file, same rules):
#   npm run test:eval-db -w backend -- tests/load-live-full-eval-env.test.ts

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$path = Join-Path $root ".env.live-full-eval"
if (-not (Test-Path $path)) {
  throw "Missing $path — copy .env.live-full-eval.example and set secrets, or recreate via compose setup. Refusing eval DB use (no product .env fallback)."
}

Get-Content $path -ErrorAction Stop | ForEach-Object {
  $line = $_.Trim()
  if (-not $line -or $line.StartsWith("#") -or $line -notmatch "=") { return }
  $key, $value = $line.Split("=", 2)
  Set-Item -Path "Env:$($key.Trim())" -Value $value.Trim()
}

$required = @(
  "DATABASE_URL",
  "WORKEE_APPROVED_TEST_DATABASE_URL",
  "WORKEE_DISABLE_WHATSAPP_OUTBOUND",
  "WORKEE_DISABLE_REMINDER_FIRE"
)
foreach ($key in $required) {
  if (-not (Get-Item "Env:$key" -ErrorAction SilentlyContinue)?.Value) {
    throw "Missing required env after load: $key — refusing eval DB use (no product .env fallback)."
  }
}

if ($env:DATABASE_URL -ne $env:WORKEE_APPROVED_TEST_DATABASE_URL) {
  throw "DATABASE_URL must exactly equal WORKEE_APPROVED_TEST_DATABASE_URL — refusing eval DB use."
}

# Block product DB identity even if someone put it in the eval file.
$uCheck = [Uri]$env:DATABASE_URL
$dbName = $uCheck.AbsolutePath.TrimStart("/").Split("?")[0].Split("/")[0]
if ($dbName -eq "workee") {
  throw "database identity 'workee' is the product database; refusing eval DB use."
}

# Prevent product dotenv (override:true) from wiping these when Node loads config/env.ts
$env:WORKEE_EVAL_ENV_LOCKED = "1"

# Sanitized confirmation only
try {
  $u = [Uri]$env:DATABASE_URL
  $db = $u.AbsolutePath.TrimStart("/").Split("?")[0]
  $user = ($u.UserInfo -split ":", 2)[0]
  Write-Host "LIVE_FULL eval env loaded: $($u.Host):$($u.Port)/$db user=$user (password hidden); WORKEE_EVAL_ENV_LOCKED=1"
} catch {
  Write-Host "LIVE_FULL eval env loaded (URL parse skipped); WORKEE_EVAL_ENV_LOCKED=1"
}
