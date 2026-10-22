# Loads process-scoped LIVE_FULL eval env from gitignored .env.live-full-eval.
# Does not modify shared .env or running product processes.
# Usage (from repo root):
#   . .\scripts\Load-LiveFullEvalEnv.ps1
# Then (separately approved): npm run test:model-eval-full -w backend

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$path = Join-Path $root ".env.live-full-eval"
if (-not (Test-Path $path)) {
  throw "Missing $path — copy .env.live-full-eval.example and set secrets, or recreate via compose setup."
}

Get-Content $path | ForEach-Object {
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
    throw "Missing required env after load: $key"
  }
}

# Sanitized confirmation only
try {
  $u = [Uri]$env:DATABASE_URL
  $db = $u.AbsolutePath.TrimStart("/").Split("?")[0]
  $user = ($u.UserInfo -split ":", 2)[0]
  Write-Host "LIVE_FULL eval env loaded: $($u.Host):$($u.Port)/$db user=$user (password hidden)"
} catch {
  Write-Host "LIVE_FULL eval env loaded (URL parse skipped)"
}
