# Unified regression run (Windows PowerShell 5.1 compatible, ASCII only).
#
# This script only ORCHESTRATES: it runs the requested suites, records what ran in
# a manifest, and hands the verdict to backend/src/scripts/regression-summary.ts
# (PASS / FAIL / NOT_RUN per suite, per scope; LIVE gated per case against
# docs/qa/baselines/model-eval-baseline.json; tsc gated against
# docs/qa/baselines/tsc-diagnostics.txt). A suite that did not run is never PASS.
#
# Usage (from repo root, any PowerShell window):
#   powershell -ExecutionPolicy Bypass -File scripts\run-regression.ps1                 # offline track (shared + backend, no DB / model)
#   ... -Db                                                                             # + db track (*.db.test.ts, approved workee_test)
#   ... -EvalDb                                                                         # + full eval-db track (long; locked eval env)
#   ... -EvalDbFiles "tests/a.eval-db.test.ts,tests/b.eval-db.test.ts"                  # + specific eval-db files
#   ... -Live                                                                           # + LIVE_FULL (tagged cases; production path: sendChatMessage)
#   ... -Live -Full | -Live -Cases "id1,id2" | -Live -Tags "continuity"
#   ... -Live -Cases "so-household-share-offer" -Repeat 3                               # re-verify a flaky baseline case (3 runs)
#   ... -AttachmentIntent                                                               # + attachment-intent corpus (model only)
#   ... -Phase4Cases "id1,id2" / -Phase4MtCases "id1"                                   # + phase-4 corpus cases (model only)
#   ... -Tsc                                                                            # + TypeScript: no new diagnostics vs baseline
#   ... -WriteTscBaseline                                                               # explicit, reviewed baseline (re)write; never automatic
#   ... -SkipOffline                                                                    # do not run the offline track
#   ... -LegacyContext                                                                  # pre-G8 eval message (A/B attribution only; implies -HarnessApply)
#   ... -HarnessApply                                                                   # LIVE_FULL via model + harness apply (A/B only; removed in C1)
#   ... -NoFlakyRerun                                                                   # skip the automatic 3x re-check of failed baseline-flaky LIVE cases
#
# Runs in its own process: eval env vars never leak into your shell.
# Outputs: backend\scripts\.tmp-regression-*.out / *.json + .tmp-regression-summary-<OutTag|profile>.json

param(
  [switch]$Live,
  [switch]$Full,
  [switch]$SkipOffline,
  [switch]$Db,
  [switch]$EvalDb,
  [string]$EvalDbFiles = "",
  [switch]$AttachmentIntent,
  [string]$Phase4Cases = "",
  [string]$Phase4MtCases = "",
  [string]$Tags = "structured-offer,mechanism,filing-policy,structured-crud",
  [string]$Cases = "",
  [int]$Repeat = 1,
  [switch]$LegacyContext,
  [switch]$HarnessApply,
  [switch]$NoFlakyRerun,
  [string]$OutTag = "",
  [switch]$Tsc,
  [switch]$WriteTscBaseline
)

$ErrorActionPreference = "Continue"
$root = Split-Path -Parent $PSScriptRoot
$outDir = Join-Path $root "backend\scripts"
$suites = @()
$profileParts = @()

function Now-Iso { (Get-Date).ToUniversalTime().ToString("o") }

# Register a suite in the manifest. Not-requested suites are still listed so the
# summary shows them as NOT_RUN instead of silently omitting them.
function Add-Suite([string]$id, [string]$kind, [string]$scope, [bool]$requested, [string]$baselineSuite = "") {
  $s = [ordered]@{
    id = $id; kind = $kind; scope = $scope; requested = $requested; executed = $false
    exitCode = $null; startedAt = $null; resultFile = $null; rerunFile = $null; rerunStartedAt = $null
  }
  if ($baselineSuite) { $s.baselineSuite = $baselineSuite }
  $script:suites += [pscustomobject]$s
}

function Get-Suite([string]$id) { $script:suites | Where-Object { $_.id -eq $id } | Select-Object -First 1 }

# Scratch result files are removed first; tracked "last report" files are not
# (the summary rejects them as stale by mtime / generatedAt instead).
function Invoke-Suite([string]$id, [string]$logFile, [string]$resultFile, [scriptblock]$block) {
  $s = Get-Suite $id
  Write-Host "== $id ..."
  $s.startedAt = Now-Iso
  if ($resultFile -and $resultFile.StartsWith($outDir) -and (Test-Path $resultFile)) { Remove-Item $resultFile -Force }
  & $block *> (Join-Path $outDir $logFile)
  $s.exitCode = $LASTEXITCODE
  $s.executed = $true
  $s.resultFile = $resultFile
}

function Json-Out([string]$name) { Join-Path $outDir $name }

$requestOffline = -not $SkipOffline
$requestEvalDb = $EvalDb -or [bool]$EvalDbFiles
Add-Suite "offline-shared" "vitest" "unit" $requestOffline
Add-Suite "offline-backend" "vitest" "unit" $requestOffline
Add-Suite "db" "vitest" "db-harness" ([bool]$Db)
Add-Suite "eval-db" "vitest" "eval-db-harness" $requestEvalDb
$liveScope = "production-path"
if ($HarnessApply -or $LegacyContext) { $liveScope = "model+harness-apply" }
Add-Suite "live-full" "model-eval" $liveScope ([bool]$Live) "live-full"
Add-Suite "phase-4" "model-eval" "model-only" ([bool]$Phase4Cases) "phase-4"
Add-Suite "phase-4-mt" "model-eval" "model-only" ([bool]$Phase4MtCases) "phase-4-mt"
Add-Suite "attachment-intent" "model-eval" "model-only" ([bool]$AttachmentIntent) "attachment-intent"
Add-Suite "tsc" "tsc" "static" ([bool]$Tsc)
if ($requestOffline) { $profileParts += "offline" }
if ($Db) { $profileParts += "db" }
if ($requestEvalDb) { $profileParts += "eval-db" }
if ($Live) { $profileParts += "live" }
if ($Phase4Cases -or $Phase4MtCases) { $profileParts += "phase-4" }
if ($AttachmentIntent) { $profileParts += "attachment-intent" }
if ($Tsc) { $profileParts += "tsc" }
$runStarted = Now-Iso

Push-Location $root
try {
  if ($requestOffline) {
    $sharedJson = Json-Out ".tmp-regression-shared.json"
    Invoke-Suite "offline-shared" ".tmp-regression-shared.out" $sharedJson {
      npm run test -w shared -- --reporter=default --reporter=json --outputFile=$sharedJson
    }
    # Default vitest config = offline track only (no *.db / *.eval-db / *.live files).
    $backendJson = Json-Out ".tmp-regression-backend.json"
    Invoke-Suite "offline-backend" ".tmp-regression-backend.out" $backendJson {
      npm run test -w backend -- --reporter=default --reporter=json --outputFile=$backendJson
    }
  }

  if ($Db) {
    $dbJson = Json-Out ".tmp-regression-db.json"
    Invoke-Suite "db" ".tmp-regression-db.out" $dbJson {
      npm run test:db -w backend -- --reporter=default --reporter=json --outputFile=$dbJson
    }
  }

  if ($requestEvalDb -or $Live -or $AttachmentIntent -or $Phase4Cases -or $Phase4MtCases) {
    $envFile = Join-Path $root ".env.live-full-eval"
    if (-not (Test-Path $envFile)) { throw "Missing .env.live-full-eval - refusing live eval" }
    Get-Content $envFile | Where-Object { $_ -match '^\s*[^#].*=' } | ForEach-Object {
      $k, $v = $_.Split('=', 2)
      Set-Item "Env:$($k.Trim())" $v.Trim()
    }
  }
  if ($requestEvalDb) {
    $evalJson = Json-Out ".tmp-regression-evaldb.json"
    $files = @()
    if ($EvalDbFiles) { $files = $EvalDbFiles.Split(",") | ForEach-Object { $_.Trim() } | Where-Object { $_ } }
    Invoke-Suite "eval-db" ".tmp-regression-evaldb.out" $evalJson {
      npm run test:eval-db -w backend -- $files --reporter=default --reporter=json --outputFile=$evalJson
    }
  }
  if ($AttachmentIntent) {
    $env:ATTACHMENT_INTENT_MODEL_EVAL = "1"
    # Never inherit case/tag filters from the caller's shell (they select 0 cases here).
    $env:MODEL_EVAL_CASES = ""
    $env:MODEL_EVAL_TAGS = ""
    $env:MODEL_EVAL_REPEAT = ""
    Invoke-Suite "attachment-intent" ".tmp-regression-attachment-intent.out" (Join-Path $root "docs\qa\attachment-intent-last-eval.json") {
      npm run test:attachment-intent-model -w backend
    }
  }
  if ($Phase4Cases) {
    $env:MODEL_EVAL_LIVE = "1"; $env:MODEL_EVAL_TAGS = ""; $env:MODEL_EVAL_CASES = $Phase4Cases
    Invoke-Suite "phase-4" ".tmp-regression-phase4.out" (Join-Path $root "docs\qa\phase-4-last-eval.json") {
      npm run test:model-eval -w backend
    }
  }
  if ($Phase4MtCases) {
    $env:MODEL_EVAL_LIVE = "1"; $env:MODEL_EVAL_TAGS = ""; $env:MODEL_EVAL_CASES = $Phase4MtCases
    Invoke-Suite "phase-4-mt" ".tmp-regression-phase4-mt.out" (Join-Path $root "docs\qa\phase-4-multi-turn-last-eval.json") {
      npm run test:model-eval-mt -w backend
    }
  }
  if ($Live) {
    $env:MODEL_EVAL_FULL_LIVE = "1"
    $env:MODEL_EVAL_REPEAT = "$Repeat"
    if ($LegacyContext) { $env:MODEL_EVAL_LEGACY_CONTEXT = "1" } else { $env:MODEL_EVAL_LEGACY_CONTEXT = "" }
    if ($HarnessApply) { $env:MODEL_EVAL_LIVE_FULL_PATH = "harness" } else { $env:MODEL_EVAL_LIVE_FULL_PATH = "" }
    if ($Cases) { $env:MODEL_EVAL_CASES = $Cases; $env:MODEL_EVAL_TAGS = "" }
    elseif ($Full) { $env:MODEL_EVAL_CASES = ""; $env:MODEL_EVAL_TAGS = "" }
    else { $env:MODEL_EVAL_CASES = ""; $env:MODEL_EVAL_TAGS = $Tags }
    $liveOut = ".tmp-regression-livefull.out"
    if ($Tags -eq "continuity") { $liveOut = ".tmp-regression-continuity.out" }
    if ($OutTag) { $liveOut = ".tmp-regression-livefull-$OutTag.out" }
    $stem = [System.IO.Path]::GetFileNameWithoutExtension($liveOut)
    Invoke-Suite "live-full" $liveOut (Join-Path $root "docs\qa\live-full-last-eval.json") {
      npm run test:model-eval-full -w backend
    }
    Copy-Item (Join-Path $root "docs\qa\live-full-last-report.md") (Join-Path $outDir "$stem-report.md") -ErrorAction SilentlyContinue
    Copy-Item (Join-Path $root "docs\qa\live-full-last-eval.json") (Join-Path $outDir "$stem-eval.json") -ErrorAction SilentlyContinue
    if ($Repeat -gt 1) {
      Copy-Item (Join-Path $root "docs\qa\live-full-stability.md") (Join-Path $outDir "$stem-stability.md") -ErrorAction SilentlyContinue
      Copy-Item (Join-Path $root "docs\qa\live-full-stability.json") (Join-Path $outDir "$stem-stability.json") -ErrorAction SilentlyContinue
      # A repeat run is the flaky re-verification evidence (>= minPassesOf3 of 3).
      (Get-Suite "live-full").rerunFile = (Join-Path $root "docs\qa\live-full-stability.json")
      (Get-Suite "live-full").rerunStartedAt = (Get-Suite "live-full").startedAt
    } elseif (-not $NoFlakyRerun) {
      # Automatic flaky re-check: only cases the baseline marks flaky AND that
      # failed in THIS run are re-run 3x. The gate reads the original result from
      # its own copy ($stem-eval.json) plus the separate re-run stability file;
      # re-run evidence older than the re-run start is ignored by the summary.
      $liveSuite = Get-Suite "live-full"
      $originalEval = Join-Path $outDir "$stem-eval.json"
      $originalReport = Join-Path $outDir "$stem-report.md"
      if (Test-Path $originalEval) { $liveSuite.resultFile = $originalEval }
      # Stale re-run outputs from an earlier run with the same tag must never be read as this run's.
      Get-ChildItem -Path $outDir -Filter "$stem-rerun*" -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue
      $flaky = ""
      if (Test-Path $originalEval) {
        Push-Location (Join-Path $root "backend")
        try {
          # startedAt: a result file older than this run yields nothing (no re-run on stale data).
          $flaky = (npx tsx src/scripts/regression-summary.ts flaky-rerun-list $originalEval live-full $liveSuite.startedAt | Select-Object -Last 1)
          if ($LASTEXITCODE -ne 0) { Write-Host "== live-full flaky re-run list failed (exit $LASTEXITCODE) - no re-run"; $flaky = "" }
        } finally { Pop-Location }
      }
      if ($flaky -and $flaky.Trim()) {
        Write-Host "== live-full flaky re-run (3x): $flaky"
        $savedCases = $env:MODEL_EVAL_CASES; $savedTags = $env:MODEL_EVAL_TAGS; $savedRepeat = $env:MODEL_EVAL_REPEAT
        $liveSuite.rerunStartedAt = Now-Iso
        try {
          $env:MODEL_EVAL_CASES = $flaky.Trim(); $env:MODEL_EVAL_TAGS = ""; $env:MODEL_EVAL_REPEAT = "3"
          npm run test:model-eval-full -w backend *> (Join-Path $outDir "$stem-rerun.out")
          Write-Host "== live-full flaky re-run exit code: $LASTEXITCODE"
          Copy-Item (Join-Path $root "docs\qa\live-full-last-eval.json") (Join-Path $outDir "$stem-rerun-eval.json") -ErrorAction SilentlyContinue
          Copy-Item (Join-Path $root "docs\qa\live-full-last-report.md") (Join-Path $outDir "$stem-rerun-report.md") -ErrorAction SilentlyContinue
          Copy-Item (Join-Path $root "docs\qa\live-full-stability.md") (Join-Path $outDir "$stem-rerun-stability.md") -ErrorAction SilentlyContinue
          $rerunStability = Join-Path $outDir "$stem-rerun-stability.json"
          Copy-Item (Join-Path $root "docs\qa\live-full-stability.json") $rerunStability -ErrorAction SilentlyContinue
          # Freshness is checked by the summary (generatedAt vs rerunStartedAt); a missing file = no re-run evidence.
          if (Test-Path $rerunStability) { $liveSuite.rerunFile = $rerunStability }
        } finally {
          $env:MODEL_EVAL_CASES = $savedCases; $env:MODEL_EVAL_TAGS = $savedTags; $env:MODEL_EVAL_REPEAT = $savedRepeat
          # docs\qa "last" files describe the main run again, not the 3x re-run.
          if (Test-Path $originalEval) { Copy-Item $originalEval (Join-Path $root "docs\qa\live-full-last-eval.json") -Force -ErrorAction SilentlyContinue }
          if (Test-Path $originalReport) { Copy-Item $originalReport (Join-Path $root "docs\qa\live-full-last-report.md") -Force -ErrorAction SilentlyContinue }
        }
      }
    }
  }

  if ($Tsc -or $WriteTscBaseline) {
    $tscOut = Json-Out ".tmp-regression-tsc.txt"
    if ($Tsc) {
      Invoke-Suite "tsc" ".tmp-regression-tsc.log" $tscOut {
        Push-Location (Join-Path $root "backend")
        npx tsc -p tsconfig.json --noEmit --pretty false *> $tscOut
        $code = $LASTEXITCODE
        Pop-Location
        $global:LASTEXITCODE = $code
      }
    } else {
      Push-Location (Join-Path $root "backend")
      npx tsc -p tsconfig.json --noEmit --pretty false *> $tscOut
      Pop-Location
    }
    if ($WriteTscBaseline) {
      Push-Location (Join-Path $root "backend")
      npx tsx src/scripts/regression-summary.ts write-tsc-baseline $tscOut
      Pop-Location
    }
  }
}
finally {
  Pop-Location
}

$profileName = ($profileParts -join "+")
if (-not $profileName) { $profileName = "none" }
# One summary per run kind, so a later run never overwrites an earlier verdict.
$runTag = $OutTag
if (-not $runTag) { $runTag = ($profileParts -join "-") }
if (-not $runTag) { $runTag = "none" }
$manifestPath = Json-Out ".tmp-regression-manifest-$runTag.json"
$summaryPath = Json-Out ".tmp-regression-summary-$runTag.json"
$manifest = [ordered]@{ profile = $profileName; startedAt = $runStarted; suites = $suites }
$manifest | ConvertTo-Json -Depth 6 | Out-File -FilePath $manifestPath -Encoding utf8

Write-Host ""
Push-Location (Join-Path $root "backend")
npx tsx src/scripts/regression-summary.ts summarize $manifestPath $summaryPath
$verdict = $LASTEXITCODE
Pop-Location
Write-Host ""
Write-Host "Logs: $outDir\.tmp-regression-*.out   Summary: $summaryPath"
exit $verdict
