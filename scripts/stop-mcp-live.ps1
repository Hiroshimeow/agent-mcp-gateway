Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent (Split-Path -Parent $PSCommandPath)
$logsDir = Join-Path $projectRoot "logs"
$pidFile = Join-Path $logsDir "live-pids.json"

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

if (-not (Test-Path $pidFile)) {
    Write-Host "Live PID file not found: $pidFile"
    exit 0
}

$entries = @(Get-Content -Raw -Path $pidFile | ConvertFrom-Json)
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

    if (-not $entry.pid) {
        continue
    }
    Stop-ProcessIfExists -ProcessId ([int]$entry.pid) -Label $entry.name | Out-Null
}

Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
Write-Host "Live MCP stack stop completed."
