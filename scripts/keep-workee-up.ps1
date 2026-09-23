# WhatsApp needs API + Postgres + Cloudflared. This keeps the first two up
# and asks Windows not to sleep while this process is running.
$ErrorActionPreference = "Stop"
$env:Path = @(
  "C:\Program Files\nodejs"
  "$env:LOCALAPPDATA\Programs\DockerDesktop\resources\bin"
  "C:\Program Files\Docker\Docker\resources\bin"
  $env:Path
) -join ";"
$root = Split-Path -Parent $PSScriptRoot
$logDir = Join-Path $env:LOCALAPPDATA "Workee"
$logFile = Join-Path $logDir "keep-up.log"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

function Write-Log([string]$message) {
  $line = "{0} {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $message
  Add-Content -Path $logFile -Value $line
  Write-Host $line
}

if (-not ("WorkeeSleep" -as [type])) {
  Add-Type -TypeDefinition @"
using System.Runtime.InteropServices;
public static class WorkeeSleep {
  [DllImport("kernel32.dll")]
  public static extern uint SetThreadExecutionState(uint esFlags);
}
"@
}

function Keep-Awake {
  # ES_CONTINUOUS | ES_SYSTEM_REQUIRED | ES_AWAYMODE_REQUIRED
  [void][WorkeeSleep]::SetThreadExecutionState([uint32]2147483713)
}

function Wait-Docker {
  $deadline = (Get-Date).AddMinutes(3)
  while ((Get-Date) -lt $deadline) {
    docker info 2>$null | Out-Null
    if ($LASTEXITCODE -eq 0) {
      return
    }
    $candidates = @(
      (Join-Path $env:LOCALAPPDATA "Programs\DockerDesktop\Docker Desktop.exe")
      (Join-Path $env:LOCALAPPDATA "Programs\Docker Desktop\Docker Desktop.exe")
    )
    $dockerDesktop = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
    if ($dockerDesktop) {
      Start-Process $dockerDesktop | Out-Null
    }
    Start-Sleep -Seconds 5
  }
  throw "Docker did not become ready."
}

function Ensure-Postgres {
  $name = "workee-postgres"
  $state = docker inspect -f "{{.State.Running}}" $name 2>$null
  if ($LASTEXITCODE -ne 0) {
    throw "Container $name is missing. Start it once, then rerun."
  }
  if ($state -ne "true") {
    Write-Log "Starting $name"
    docker start $name | Out-Null
  }
}

function Test-ApiPort {
  $client = $null
  try {
    $client = New-Object System.Net.Sockets.TcpClient
    $client.Connect("127.0.0.1", 3003)
    return $true
  } catch {
    return $false
  } finally {
    if ($client) { $client.Dispose() }
  }
}

Keep-Awake
Write-Log "Keep-up started"
Wait-Docker
Ensure-Postgres

if (Test-ApiPort) {
  Write-Log "API already listening on 3003; holding sleep lock only"
  while ($true) {
    Keep-Awake
    Start-Sleep -Seconds 60
    try {
      Ensure-Postgres
    } catch {
      Write-Log $_
    }
  }
}

Set-Location $root
Write-Log "Starting API"
while ($true) {
  Keep-Awake
  try {
    Ensure-Postgres
  } catch {
    Write-Log $_
  }
  try {
    npm run dev -w backend
    Write-Log "API exited $LASTEXITCODE; restarting in 5s"
  } catch {
    Write-Log $_
  }
  Start-Sleep -Seconds 5
}
