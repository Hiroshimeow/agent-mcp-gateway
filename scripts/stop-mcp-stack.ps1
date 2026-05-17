Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent (Split-Path -Parent $PSCommandPath)
$logsDir = Join-Path $projectRoot "logs"
$pidFile = Join-Path $logsDir "pids.json"
$liveStopScript = Join-Path $projectRoot "scripts\stop-mcp-live.ps1"

function Stop-ProcessIfExists {
    param(
        [Parameter(Mandatory = $true)]
        [int]$ProcessId,
        [Parameter(Mandatory = $true)]
        [string]$Label
    )

    try {
        $process = Get-Process -Id $ProcessId -ErrorAction Stop
        Stop-Process -Id $process.Id -Force -ErrorAction Stop
        Write-Host ("Stopped {0} (PID {1})" -f $Label, $process.Id)
        return $true
    } catch {
        Write-Host ("Skipped {0} (PID {1}): {2}" -f $Label, $ProcessId, $_.Exception.Message)
        return $false
    }
}

if (Test-Path $liveStopScript) {
    & $liveStopScript
}

if (-not (Test-Path $pidFile)) {
    Write-Host "PID file not found: $pidFile"
    exit 0
}

$entries = Get-Content -Raw -Path $pidFile | ConvertFrom-Json

foreach ($entry in $entries) {
    if ($entry.name -eq "tailscale-funnel") {
        try {
            tailscale funnel reset | Out-Null
            Write-Host "Stopped tailscale-funnel (reset funnel config)"
        } catch {
            Write-Host ("Skipped tailscale-funnel reset: {0}" -f $_.Exception.Message)
        }
        continue
    }

    $targetPid = $null

    if ($entry.pid) {
        $targetPid = [int]$entry.pid
    }

    if (-not $targetPid) {
        continue
    }

    Stop-ProcessIfExists -ProcessId $targetPid -Label $entry.name | Out-Null
}

Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
Write-Host "Stack stop completed."
