# Registers logon tasks for keep-up + refresh watcher; turns off sleep/lid-sleep on AC.
$ErrorActionPreference = "Stop"

. (Join-Path $PSScriptRoot "workee-common.ps1")

$keepUpScript = Join-Path $PSScriptRoot "keep-workee-up.ps1"
$watchScript = Join-Path $PSScriptRoot "watch-and-refresh.ps1"
$defaultRoot = Split-Path -Parent $PSScriptRoot
$liveRoot = Get-WorkeeLiveRoot
$workRoot = if ($liveRoot) { $liveRoot } else { $defaultRoot }

powercfg /change standby-timeout-ac 0
powercfg /change hibernate-timeout-ac 0
powercfg /SETACVALUEINDEX SCHEME_CURRENT SUB_BUTTONS LIDACTION 0
powercfg /S SCHEME_CURRENT

$ps = "C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe"
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero)
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME

# Keep-up: prefer live worktree so the WhatsApp API runs from the clean checkout.
$keepUpInLive = Join-Path $workRoot "scripts\keep-workee-up.ps1"
if (-not (Test-Path -LiteralPath $keepUpInLive)) {
  $keepUpInLive = $keepUpScript
  $workRoot = $defaultRoot
}

Unregister-ScheduledTask -TaskName "WorkeeKeepUp" -Confirm:$false -ErrorAction SilentlyContinue
$keepAction = New-ScheduledTaskAction -Execute $ps -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$keepUpInLive`"" -WorkingDirectory $workRoot
Register-ScheduledTask -TaskName "WorkeeKeepUp" -Action $keepAction -Trigger $trigger -Settings $settings -Description "Keep Workee API and Postgres up for WhatsApp" | Out-Null
Start-ScheduledTask -TaskName "WorkeeKeepUp"

$watchInRoot = Join-Path $workRoot "scripts\watch-and-refresh.ps1"
if (-not (Test-Path -LiteralPath $watchInRoot)) {
  $watchInRoot = $watchScript
}

Unregister-ScheduledTask -TaskName "WorkeeRefreshWatch" -Confirm:$false -ErrorAction SilentlyContinue
$watchAction = New-ScheduledTaskAction -Execute $ps -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$watchInRoot`"" -WorkingDirectory $workRoot
Register-ScheduledTask -TaskName "WorkeeRefreshWatch" -Action $watchAction -Trigger $trigger -Settings $settings -Description "Auto-refresh Workee when origin advances on the active branch" | Out-Null
Start-ScheduledTask -TaskName "WorkeeRefreshWatch"

Write-Host "WorkeeKeepUp + WorkeeRefreshWatch installed."
Write-Host "  Working directory: $workRoot"
Write-Host "  Sleep-on-AC and lid-close-on-AC are off."
Write-Host "  keep-up log: $env:LOCALAPPDATA\Workee\keep-up.log"
Write-Host "  refresh-watch log: $env:LOCALAPPDATA\Workee\refresh-watch.log"
if (-not $liveRoot) {
  Write-Host "  Tip: npm run live:setup  then re-run keep-up:install so tasks use Official1-live."
}
