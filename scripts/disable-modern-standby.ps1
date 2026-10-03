# Disables Windows Modern Standby (Connected Standby) so Workee can stay
# awake with the lid closed. Requires Administrator + a reboot.
# Side effect: this PC has no classic S3 sleep, so it may not deep-sleep at all.
$ErrorActionPreference = "Stop"

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
  [Security.Principal.WindowsBuiltInRole]::Administrator
)
if (-not $isAdmin) {
  Write-Host "Re-launching elevated..."
  Start-Process -FilePath "powershell.exe" -Verb RunAs -ArgumentList @(
    "-NoProfile",
    "-ExecutionPolicy", "Bypass",
    "-File", $PSCommandPath
  ) | Out-Null
  exit 0
}

# Sleep timers: never on AC or battery
powercfg /change standby-timeout-ac 0
powercfg /change standby-timeout-dc 0
powercfg /change hibernate-timeout-ac 0
powercfg /change hibernate-timeout-dc 0
powercfg /SETACVALUEINDEX SCHEME_CURRENT SUB_SLEEP STANDBYIDLE 0
powercfg /SETDCVALUEINDEX SCHEME_CURRENT SUB_SLEEP STANDBYIDLE 0
powercfg /SETACVALUEINDEX SCHEME_CURRENT SUB_SLEEP HIBERNATEIDLE 0
powercfg /SETDCVALUEINDEX SCHEME_CURRENT SUB_SLEEP HIBERNATEIDLE 0
powercfg /SETACVALUEINDEX SCHEME_CURRENT SUB_SLEEP HYBRIDSLEEP 0
powercfg /SETDCVALUEINDEX SCHEME_CURRENT SUB_SLEEP HYBRIDSLEEP 0
powercfg /SETACVALUEINDEX SCHEME_CURRENT SUB_BUTTONS LIDACTION 0
powercfg /SETDCVALUEINDEX SCHEME_CURRENT SUB_BUTTONS LIDACTION 0
powercfg /setactive SCHEME_CURRENT

# Turn off Connected Standby / Modern Standby
New-ItemProperty -Path "HKLM:\SYSTEM\CurrentControlSet\Control\Power" -Name "CsEnabled" -PropertyType DWord -Value 0 -Force | Out-Null

Write-Host ""
Write-Host "Done."
Write-Host "- Sleep after AC/DC = Never"
Write-Host "- Lid close AC/DC = Do nothing"
Write-Host "- CsEnabled = 0 (Modern Standby off)"
Write-Host ""
Write-Host "REBOOT REQUIRED for Modern Standby to fully turn off."
Write-Host "Press Enter to close..."
[void][Console]::ReadLine()
