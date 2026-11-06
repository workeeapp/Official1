# Unified regression run (Windows PowerShell 5.1 compatible, ASCII only).
#
# Usage (from repo root, any PowerShell window):
#   powershell -ExecutionPolicy Bypass -File scripts\run-regression.ps1                 # offline only
#   powershell -ExecutionPolicy Bypass -File scripts\run-regression.ps1 -Live           # + isolated LIVE_FULL (tagged cases)
#   powershell -ExecutionPolicy Bypass -File scripts\run-regression.ps1 -Live -Full     # + whole live-full corpus
#   ... -Live -Tags "continuity"                                                        # continuity measurement (not regression)
#   ... -Live -Cases "id1,id2"                                                          # explicit case ids
#   ... -Live -Repeat 5                                                                 # stability: N runs, per-case pass rates
#   ... -Live -LegacyContext                                                            # pre-G8 eval message (A/B attribution only)
#   ... -SkipOffline                                                                    # live step only
#   ... -EvalDb                                                                         # + full eval-db suite (long; known pre-existing failures)
#   ... -EvalDbFiles "tests/a.eval-db.test.ts,tests/b.eval-db.test.ts"                 # + specific eval-db files
#   ... -AttachmentIntent                                                               # + attachment-intent corpus (model only)
#   ... -Phase4Cases "id1,id2" / -Phase4MtCases "id1"                                   # + phase-4 corpus cases (model only)
#
# Runs in its own process: eval env vars never leak into your shell.
# LIVE_FULL is isolated by the runner itself (fails closed unless DATABASE_URL is the
# approved workee_test DB, the DB role cannot reach product, WhatsApp outbound and
# reminder fire are disabled). This script only loads .env.live-full-eval.
# Outputs: backend\scripts\.tmp-regression-*.out + summary at the end.

param(
  [switch]$Live,
  [switch]$Full,
  [switch]$SkipOffline,
  [switch]$EvalDb,
  [string]$EvalDbFiles = "",
  [switch]$AttachmentIntent,
  [string]$Phase4Cases = "",
  [string]$Phase4MtCases = "",
  [string]$Tags = "structured-offer,mechanism,filing-policy,structured-crud",
  [string]$Cases = "",
  [int]$Repeat = 1,
  [switch]$LegacyContext,
  [string]$OutTag = ""
)

$ErrorActionPreference = "Continue"
$root = Split-Path -Parent $PSScriptRoot
$outDir = Join-Path $root "backend\scripts"
$results = @()

function Invoke-Step([string]$name, [string]$file, [scriptblock]$block) {
  Write-Host "== $name ..."
  $path = Join-Path $outDir $file
  & $block *> $path
  $code = $LASTEXITCODE
  $summary = (Get-Content $path | Where-Object { $_ -match "Test Files|Tests  |Score:|passRate|blocked" }) -join " | "
  $script:results += [pscustomobject]@{ Step = $name; Exit = $code; Summary = $summary; Output = $path }
}

Push-Location $root
try {
  if (-not $SkipOffline) {
    Invoke-Step "offline: shared" ".tmp-regression-shared.out" { npm run test -w shared }
    # Offline = no DB, no model: eval-db / live suites need their own env and run below.
    Invoke-Step "offline: backend" ".tmp-regression-backend.out" { npm run test -w backend -- --exclude "**/*.eval-db.test.ts" --exclude "**/*.live.test.ts" --exclude "**/share-pack-model-apply.offline.test.ts" }
  }

  if ($Live -or $EvalDb -or $EvalDbFiles -or $AttachmentIntent -or $Phase4Cases -or $Phase4MtCases) {
    $envFile = Join-Path $root ".env.live-full-eval"
    if (-not (Test-Path $envFile)) { throw "Missing .env.live-full-eval - refusing live eval" }
    Get-Content $envFile | Where-Object { $_ -match '^\s*[^#].*=' } | ForEach-Object {
      $k, $v = $_.Split('=', 2)
      Set-Item "Env:$($k.Trim())" $v.Trim()
    }
  }
  if ($EvalDb) {
    Invoke-Step "eval-db suite (workee_test)" ".tmp-regression-evaldb.out" { npm run test:eval-db -w backend }
  }
  if ($EvalDbFiles) {
    $files = $EvalDbFiles.Split(",") | ForEach-Object { $_.Trim() } | Where-Object { $_ }
    Invoke-Step "eval-db files (workee_test)" ".tmp-regression-evaldb-files.out" { npm run test:eval-db -w backend -- $files }
  }
  if ($AttachmentIntent) {
    $env:ATTACHMENT_INTENT_MODEL_EVAL = "1"
    # Never inherit case/tag filters from the caller's shell (they select 0 cases here).
    $env:MODEL_EVAL_CASES = ""
    $env:MODEL_EVAL_TAGS = ""
    Invoke-Step "attachment-intent corpus (model only)" ".tmp-regression-attachment-intent.out" { npm run test:attachment-intent-model -w backend }
  }
  if ($Phase4Cases) {
    $env:MODEL_EVAL_LIVE = "1"; $env:MODEL_EVAL_TAGS = ""; $env:MODEL_EVAL_CASES = $Phase4Cases
    Invoke-Step "phase-4 single-turn (model only)" ".tmp-regression-phase4.out" { npm run test:model-eval -w backend }
  }
  if ($Phase4MtCases) {
    $env:MODEL_EVAL_LIVE = "1"; $env:MODEL_EVAL_TAGS = ""; $env:MODEL_EVAL_CASES = $Phase4MtCases
    Invoke-Step "phase-4 multi-turn (model only)" ".tmp-regression-phase4-mt.out" { npm run test:model-eval-mt -w backend }
  }
  if ($Live) {
    $env:MODEL_EVAL_FULL_LIVE = "1"
    $env:MODEL_EVAL_REPEAT = "$Repeat"
    if ($LegacyContext) { $env:MODEL_EVAL_LEGACY_CONTEXT = "1" } else { $env:MODEL_EVAL_LEGACY_CONTEXT = "" }
    if ($Cases) { $env:MODEL_EVAL_CASES = $Cases; $env:MODEL_EVAL_TAGS = "" }
    elseif ($Full) { $env:MODEL_EVAL_CASES = ""; $env:MODEL_EVAL_TAGS = "" }
    else { $env:MODEL_EVAL_CASES = ""; $env:MODEL_EVAL_TAGS = $Tags }
    $liveOut = ".tmp-regression-livefull.out"
    if ($Tags -eq "continuity") { $liveOut = ".tmp-regression-continuity.out" }
    if ($OutTag) { $liveOut = ".tmp-regression-livefull-$OutTag.out" }
    Invoke-Step "live: LIVE_FULL (workee_test)" $liveOut { npm run test:model-eval-full -w backend }
    $stem = [System.IO.Path]::GetFileNameWithoutExtension($liveOut)
    Copy-Item (Join-Path $root "docs\qa\live-full-last-report.md") (Join-Path $outDir "$stem-report.md") -ErrorAction SilentlyContinue
    Copy-Item (Join-Path $root "docs\qa\live-full-last-eval.json") (Join-Path $outDir "$stem-eval.json") -ErrorAction SilentlyContinue
    if ($Repeat -gt 1) {
      Copy-Item (Join-Path $root "docs\qa\live-full-stability.md") (Join-Path $outDir "$stem-stability.md") -ErrorAction SilentlyContinue
      Copy-Item (Join-Path $root "docs\qa\live-full-stability.json") (Join-Path $outDir "$stem-stability.json") -ErrorAction SilentlyContinue
    }
  }
}
finally {
  Pop-Location
}

Write-Host ""
Write-Host "==================== REGRESSION SUMMARY ===================="
$results | Format-Table -AutoSize -Wrap Step, Exit, Summary
$results | Format-Table -AutoSize Step, Output
if ($results | Where-Object { $_.Exit -ne 0 }) { exit 1 } else { exit 0 }
