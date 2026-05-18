param(
    [Parameter(Mandatory = $true)]
    [string]$Path,
    [string]$TunnelChoice = "1",
    [int]$P = 8000,
    [switch]$FollowLogs
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent (Split-Path -Parent $PSCommandPath)
$logsDir = Join-Path $projectRoot "logs"
$runId = Get-Date -Format "yyyyMMdd-HHmmss"
$envPath = Join-Path $projectRoot ".env"
$envExamplePath = Join-Path $projectRoot ".env.example"
$pidFile = Join-Path $logsDir "live-pids.json"
$gatewayLog = Join-Path $logsDir "gateway.log"
$filesystemLog = Join-Path $logsDir "filesystem-$runId.log"
$shellLog = Join-Path $logsDir "shell.log"
$ngrokLog = Join-Path $logsDir "ngrok-$runId.log"
$tailscaleLog = Join-Path $logsDir "tailscale-$runId.log"
$authStateFile = Join-Path $logsDir "auth-state.json"
$wrapperScript = Join-Path $projectRoot "scripts\authenticated-mcp-wrapper.mjs"
$stopLiveScript = Join-Path $projectRoot "scripts\stop-mcp-live.ps1"

function Write-Section {
    param([string]$Text)
    Write-Host ""
    Write-Host "== $Text =="
}

function Load-DotEnv {
    param([Parameter(Mandatory = $true)][string]$Path)
    if (-not (Test-Path $Path)) {
        return @{}
    }

    $values = @{}
    foreach ($line in Get-Content -Path $Path) {
        $trimmed = $line.Trim()
        if (-not $trimmed -or $trimmed.StartsWith("#")) {
            continue
        }

        $parts = $trimmed -split "=", 2
        if ($parts.Count -ne 2) {
            continue
        }

        $key = $parts[0].Trim()
        $value = $parts[1].Trim()
        if (($value.StartsWith('"') -and $value.EndsWith('"')) -or ($value.StartsWith("'") -and $value.EndsWith("'"))) {
            $value = $value.Substring(1, $value.Length - 2)
        }
        $values[$key] = $value
    }
    return $values
}

function Ensure-DotEnv {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path,
        [Parameter(Mandatory = $true)]
        [string]$ExamplePath
    )

    if (Test-Path $Path) {
        return
    }

    if (-not (Test-Path $ExamplePath)) {
        throw "Missing .env and .env.example. Cannot create default env file."
    }

    Copy-Item -LiteralPath $ExamplePath -Destination $Path -ErrorAction Stop
    Write-Host "Created .env from .env.example. Edit MCP_AUTH_PASSWORD after this run if it is still change-me-now."
}

function Get-ListeningOwningProcessIds {
    param([Parameter(Mandatory = $true)][int]$Port)
    $portOwners = @()
    foreach ($line in (netstat -ano -p tcp)) {
        if ($line -match "^\s*TCP\s+\S+:$Port\s+\S+\s+LISTENING\s+(\d+)\s*$") {
            $portOwners += [int]$Matches[1]
        }
    }
    return $portOwners | Select-Object -Unique
}

function Assert-PortAvailable {
    param([Parameter(Mandatory = $true)][int]$Port)
    $owners = @(Get-ListeningOwningProcessIds -Port $Port)
    if ($owners.Count -gt 0) {
        throw "Port $Port is already in use by PID(s): $($owners -join ', ')."
    }
}

function Stop-StaleLauncherProcessOnPort {
    param([Parameter(Mandatory = $true)][int]$Port)

    $owners = @(Get-ListeningOwningProcessIds -Port $Port)
    foreach ($owner in $owners) {
        $processInfo = Get-CimInstance Win32_Process -Filter "ProcessId=$owner" -ErrorAction SilentlyContinue
        if (-not $processInfo -or -not $processInfo.CommandLine) {
            continue
        }

        if ($processInfo.CommandLine -like "*authenticated-mcp-wrapper.mjs*") {
            Write-Host "Stopping stale MCP gateway on port $Port (PID $owner)."
            Stop-Process -Id $owner -Force -ErrorAction Stop
        }
    }
}

function Get-ListeningOwningProcessId {
    param([Parameter(Mandatory = $true)][int]$Port, [int]$TimeoutSeconds = 15)
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    do {
        $owners = @(Get-ListeningOwningProcessIds -Port $Port)
        if ($owners.Count -gt 0) {
            return [int]$owners[0]
        }
        Start-Sleep -Milliseconds 500
    } while ((Get-Date) -lt $deadline)
    throw "Timed out waiting for a listening process on port $Port."
}

function Wait-ForPort {
    param([Parameter(Mandatory = $true)][string]$HostName, [Parameter(Mandatory = $true)][int]$Port, [int]$TimeoutSeconds = 30)
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    do {
        $client = $null
        try {
            $client = New-Object System.Net.Sockets.TcpClient
            $async = $client.BeginConnect($HostName, $Port, $null, $null)
            if ($async.AsyncWaitHandle.WaitOne(1000, $false)) {
                $client.EndConnect($async)
                $client.Close()
                return $true
            }
        } catch {
        } finally {
            if ($client) {
                $client.Dispose()
            }
        }
        Start-Sleep -Milliseconds 500
    } while ((Get-Date) -lt $deadline)
    return $false
}

function Get-NgrokPublicUrl {
    param([int]$TimeoutSeconds = 45)
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    do {
        try {
            $response = Invoke-RestMethod -Uri "http://127.0.0.1:4040/api/tunnels" -TimeoutSec 5
            $tunnel = $response.tunnels | Where-Object { $_.public_url -like "https://*" } | Select-Object -First 1
            if ($tunnel) {
                return $tunnel.public_url
            }
        } catch {
        }
        Start-Sleep -Seconds 1
    } while ((Get-Date) -lt $deadline)
    throw "Timed out waiting for ngrok public URL."
}

function Get-TailscalePublicUrl {
    $status = tailscale status --json | ConvertFrom-Json
    if (-not $status.Self -or -not $status.Self.DNSName) {
        throw "Tailscale DNSName not found. Check that Tailscale is running and MagicDNS is enabled."
    }
    $dnsName = ([string]$status.Self.DNSName).TrimEnd(".")
    if (-not $dnsName) {
        throw "Tailscale DNSName is empty."
    }
    return "https://$dnsName"
}

function New-ProcessRecord {
    param([string]$Name, [int]$ProcessId, [string]$LogPath, [int]$LaunchPid = 0, [int]$Port = 0)
    return [pscustomobject]@{
        name      = $Name
        pid       = $ProcessId
        launchPid = $LaunchPid
        port      = $Port
        logPath   = $LogPath
    }
}

Write-Section "Environment"
Ensure-DotEnv -Path $envPath -ExamplePath $envExamplePath

$repoRoot = $Path.Trim().Trim('"', "'")
if (-not $repoRoot) {
    throw "Repo path is required."
}
if (-not (Test-Path -LiteralPath $repoRoot)) {
    throw "REPO_ROOT does not exist: $repoRoot"
}
$repoRoot = (Resolve-Path -LiteralPath $repoRoot).Path
if ($repoRoot -match '^[A-Za-z]:\\$') {
    throw "Refusing to expose drive root as REPO_ROOT: $repoRoot"
}

if ($P -lt 1 -or $P -gt 65535) {
    throw "Port must be between 1 and 65535: $P"
}

$choice = $TunnelChoice.Trim().ToLowerInvariant()
$useTailscale = $false
$useNgrok = $false
if ($choice -in @("1", "tailscale", "funnel", "ts", "t")) {
    $useTailscale = $true
} elseif ($choice -in @("2", "ngrok", "grok", "n", "g")) {
    $useNgrok = $true
} elseif ($choice -in @("3", "both", "all")) {
    $useTailscale = $true
    $useNgrok = $true
} else {
    throw "Tunnel choice must be 1/tailscale, 2/ngrok, or 3/both: $TunnelChoice"
}

$envValues = Load-DotEnv -Path $envPath

$enableFilesystemValue = "true"
if ($envValues.ContainsKey("ENABLE_FILESYSTEM") -and $envValues["ENABLE_FILESYSTEM"]) {
    $enableFilesystemValue = $envValues["ENABLE_FILESYSTEM"]
}
$enableShellValue = "false"
if ($envValues.ContainsKey("ENABLE_SHELL") -and $envValues["ENABLE_SHELL"]) {
    $enableShellValue = $envValues["ENABLE_SHELL"]
}
$shellProfileValue = "yolo"
if ($envValues.ContainsKey("SHELL_PROFILE") -and $envValues["SHELL_PROFILE"]) {
    $shellProfileValue = $envValues["SHELL_PROFILE"]
}
$enableFilesystem = $enableFilesystemValue.ToLowerInvariant() -eq "true"
$enableShell = $enableShellValue.ToLowerInvariant() -eq "true"
$trustedRootsValue = $envValues["MCP_TRUSTED_ROOTS"]
$trustedRootsFileValue = $envValues["MCP_TRUSTED_ROOTS_FILE"]
$defaultProjectIdValue = $envValues["MCP_DEFAULT_PROJECT_ID"]
$requireProjectIdValue = $envValues["MCP_REQUIRE_PROJECT_ID"]
$enableProjectPathInferenceValue = $envValues["MCP_ENABLE_PROJECT_PATH_INFERENCE"]
$exposeProjectPathsValue = $envValues["MCP_EXPOSE_PROJECT_PATHS"]
$authPassword = $envValues["MCP_AUTH_PASSWORD"]
$bearerToken = $envValues["MCP_BEARER_TOKEN"]
if (-not $authPassword) {
    $authPassword = $env:MCP_AUTH_PASSWORD
}
if (-not $bearerToken) {
    $bearerToken = $env:MCP_BEARER_TOKEN
}
if (-not $authPassword -and $bearerToken) {
    $authPassword = $bearerToken
}
if (-not $bearerToken -and $authPassword) {
    $bearerToken = $authPassword
}

if (-not $enableFilesystem) {
    throw "ENABLE_FILESYSTEM=false is not supported in v1."
}
if (-not $authPassword) {
    throw "MCP_AUTH_PASSWORD is missing. Set it in .env or current environment before running start-mcp-live.bat."
}
if ($authPassword -eq "change-me-now") {
    throw "MCP_AUTH_PASSWORD is still change-me-now in .env. Set a real password/token before exposing MCP."
}

Write-Section "Prerequisites"
$prereqs = & (Join-Path $projectRoot "scripts\check-prereqs.ps1") -Tunnel none
$prereqs | Format-List | Out-String | Write-Host
if ($useTailscale) {
    & (Join-Path $projectRoot "scripts\check-prereqs.ps1") -Tunnel tailscale | Format-List | Out-String | Write-Host
}
if ($useNgrok) {
    & (Join-Path $projectRoot "scripts\check-prereqs.ps1") -Tunnel ngrok | Format-List | Out-String | Write-Host
}

New-Item -ItemType Directory -Force -Path $logsDir | Out-Null
if (Test-Path $pidFile) {
    Write-Host "Existing live PID file found. Stopping previous live launcher first."
    & $stopLiveScript
}

Stop-StaleLauncherProcessOnPort -Port $P

Write-Section "Dependencies"
if (-not (Test-Path (Join-Path $projectRoot "node_modules"))) {
    Write-Host "Installing npm dependencies..."
    npm install --no-fund --no-audit | Tee-Object -FilePath (Join-Path $logsDir "npm-install.log")
} else {
    Write-Host "Using existing node_modules."
}

try {
    Assert-PortAvailable -Port $P
} catch {
    throw "$($_.Exception.Message) If this is an old MCP process, run scripts\stop-mcp-live.ps1 or stop the PID manually."
}
if (-not (Test-Path $wrapperScript)) {
    throw "Authenticated wrapper script not found: $wrapperScript"
}

$records = New-Object System.Collections.Generic.List[object]
$publicUrls = @()
$primaryPublicBaseUrl = $null

if ($useTailscale) {
    Write-Section "Starting Tailscale Funnel"
    $tailscaleOutput = tailscale funnel --bg --yes $P 2>&1
    $tailscaleOutput | Set-Content -Path $tailscaleLog -Encoding ASCII
    if ($LASTEXITCODE -ne 0) {
        throw "tailscale funnel failed. Check $tailscaleLog"
    }
    $tailscaleUrl = Get-TailscalePublicUrl
    $publicUrls += [pscustomobject]@{ name = "tailscale"; url = $tailscaleUrl }
    $primaryPublicBaseUrl = $tailscaleUrl
    $records.Add((New-ProcessRecord -Name "tailscale-funnel" -ProcessId 0 -LaunchPid 0 -Port 443 -LogPath $tailscaleLog))
}

if ($useNgrok) {
    Write-Section "Starting ngrok"
    $ngrokAuthtoken = $envValues["NGROK_AUTHTOKEN"]
    if ($ngrokAuthtoken) {
        ngrok config add-authtoken $ngrokAuthtoken | Out-Null
    }
    $ngrokCommand = "ngrok http $P --host-header=localhost:$P 1>> `"$ngrokLog`" 2>&1"
    $ngrokProcess = Start-Process -FilePath "cmd.exe" -ArgumentList @("/c", $ngrokCommand) -WorkingDirectory $projectRoot -PassThru -WindowStyle Hidden
    $ngrokPid = Get-ListeningOwningProcessId -Port 4040
    $records.Add((New-ProcessRecord -Name "ngrok" -ProcessId $ngrokPid -LaunchPid $ngrokProcess.Id -Port 4040 -LogPath $ngrokLog))
    $ngrokUrl = Get-NgrokPublicUrl
    $publicUrls += [pscustomobject]@{ name = "ngrok"; url = $ngrokUrl }
    if (-not $primaryPublicBaseUrl) {
        $primaryPublicBaseUrl = $ngrokUrl
    }
}

if (-not $primaryPublicBaseUrl) {
    throw "No tunnel URL was created."
}

Write-Section "Starting MCP Server"
if (-not $enableShell) {
    "Shell MCP is disabled. Set ENABLE_SHELL=true in .env to expose shell tools." | Set-Content -Path $shellLog -Encoding ASCII
}
"Filesystem MCP is launched as a child process of the authenticated wrapper with REPO_ROOT=$repoRoot" | Set-Content -Path $filesystemLog -Encoding ASCII
$gatewayEnv = @(
    "set `"REPO_ROOT=$repoRoot`"",
    "set `"MCP_GATEWAY_PORT=$P`"",
    "set `"PUBLIC_BASE_URL=$primaryPublicBaseUrl`"",
    "set `"MCP_TRUSTED_ROOTS=$trustedRootsValue`"",
    "set `"MCP_TRUSTED_ROOTS_FILE=$trustedRootsFileValue`"",
    "set `"MCP_DEFAULT_PROJECT_ID=$defaultProjectIdValue`"",
    "set `"MCP_REQUIRE_PROJECT_ID=$requireProjectIdValue`"",
    "set `"MCP_ENABLE_PROJECT_PATH_INFERENCE=$enableProjectPathInferenceValue`"",
    "set `"MCP_EXPOSE_PROJECT_PATHS=$exposeProjectPathsValue`"",
    "set `"MCP_AUTH_PASSWORD=$authPassword`"",
    "set `"MCP_BEARER_TOKEN=$bearerToken`"",
    "set `"ENABLE_FILESYSTEM=$enableFilesystemValue`"",
    "set `"ENABLE_SHELL=$enableShellValue`"",
    "set `"SHELL_PROFILE=$shellProfileValue`"",
    "set `"FILESYSTEM_LOG_PATH=$filesystemLog`"",
    "set `"SHELL_LOG_PATH=$shellLog`"",
    "set `"AUTH_STATE_PATH=$authStateFile`"",
    "node `"$wrapperScript`" 1>> `"$gatewayLog`" 2>&1"
) -join " && "
$gatewayProcess = Start-Process -FilePath "cmd.exe" -ArgumentList @("/c", $gatewayEnv) -WorkingDirectory $projectRoot -PassThru -WindowStyle Hidden

if (-not (Wait-ForPort -HostName "127.0.0.1" -Port $P -TimeoutSeconds 30)) {
    throw "Gateway did not become ready. Check $gatewayLog"
}
$gatewayPid = Get-ListeningOwningProcessId -Port $P
$records.Add((New-ProcessRecord -Name "gateway" -ProcessId $gatewayPid -LaunchPid $gatewayProcess.Id -Port $P -LogPath $gatewayLog))
$records | ConvertTo-Json | Set-Content -Path $pidFile -Encoding ASCII

Write-Section "Ready"
Write-Host "OAuth protection: ON"
Write-Host "Static bearer auth: $(if ($bearerToken) { 'ON' } else { 'OFF' })"
Write-Host "Filesystem tools: $enableFilesystem"
Write-Host "Shell tools: $enableShell"
Write-Host "Shell profile: $shellProfileValue"
Write-Host "Active repo root: $repoRoot"
Write-Host "Gateway port: $P"
Write-Host "OAuth issuer/public base URL: $primaryPublicBaseUrl"
Write-Host "Final MCP URL: $primaryPublicBaseUrl/mcp"
if ($publicUrls.Count -gt 1) {
    Write-Host ""
    Write-Host "Additional tunnel URLs:"
    foreach ($entry in $publicUrls) {
        if ($entry.url -ne $primaryPublicBaseUrl) {
            Write-Host "  $($entry.name): $($entry.url)/mcp"
        }
    }
}
Write-Host ""
Write-Host "ChatGPT Developer Mode"
Write-Host "Name: Local Dev MCP"
Write-Host "MCP Server URL: $primaryPublicBaseUrl/mcp"
Write-Host "Authentication: OAuth"
Write-Host "OAuth login password: read MCP_AUTH_PASSWORD from .env"
if ($bearerToken) {
    Write-Host ""
    Write-Host "Hermes / OpenClaw"
    Write-Host "MCP Server URL: $primaryPublicBaseUrl/mcp"
    Write-Host "API key / Bearer token: read MCP_BEARER_TOKEN from .env"
}
Write-Host ""
Write-Host "Logs:"
Write-Host "  Gateway: $gatewayLog"
Write-Host "  Filesystem: $filesystemLog"
Write-Host "  Shell: $shellLog"
if ($useTailscale) {
    Write-Host "  Tailscale: $tailscaleLog"
}
if ($useNgrok) {
    Write-Host "  Ngrok: $ngrokLog"
}

if ($FollowLogs) {
    Write-Section "Live Logs"
    Write-Host "Streaming logs. Press Ctrl+C to stop watching. Live launcher keeps running until you call stop-mcp-live.ps1."
    $logPaths = @($gatewayLog, $filesystemLog, $shellLog)
    if ($useTailscale) {
        $logPaths += $tailscaleLog
    }
    if ($useNgrok) {
        $logPaths += $ngrokLog
    }
    $existingPaths = @($logPaths | Where-Object { Test-Path $_ })
    if ($existingPaths.Count -eq 0) {
        Write-Host "No log files found to follow."
    } else {
        Get-Content -Path $existingPaths -Tail 10 -Wait
    }
}
