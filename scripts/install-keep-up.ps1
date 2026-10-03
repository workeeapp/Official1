# Registers a logon task and turns off sleep/lid-sleep while on AC power.
$ErrorActionPreference = "Stop"
$script = Join-Path $PSScriptRoot "keep-workee-up.ps1"
$taskName = "WorkeeKeepUp"

powercfg /change standby-timeout-ac 0
powercfg /change hibernate-timeout-ac 0
powercfg /SETACVALUEINDEX SCHEME_CURRENT SUB_BUTTONS LIDACTION 0
powercfg /S SCHEME_CURRENT

Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
$action = New-ScheduledTaskAction -Execute "C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe" -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$script`"" -WorkingDirectory (Split-Path -Parent $PSScriptRoot)
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero)
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Description "Keep Workee API and Postgres up for WhatsApp" | Out-Null

Start-ScheduledTask -TaskName $taskName
Write-Host "WorkeeKeepUp installed. Sleep-on-AC and lid-close-on-AC are off. Log: $env:LOCALAPPDATA\Workee\keep-up.log"
