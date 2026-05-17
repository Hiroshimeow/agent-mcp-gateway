param(
    [string]$Path,
    [int]$P,
    [ValidateSet("ngrok", "tailscale")]
    [string]$Tunnel,
    [switch]$FollowLogs
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent (Split-Path -Parent $PSCommandPath)
$logsDir = Join-Path $projectRoot "logs"
$runId = Get-Date -Format "yyyyMMdd-HHmmss"
$configDir = Join-Path $projectRoot "config"
$packageJsonPath = Join-Path $projectRoot "package.json"
$envPath = Join-Path $projectRoot ".env"
$pidFile = Join-Path $logsDir "pids.json"
$gatewayLog = Join-Path $logsDir "gateway.log"
$filesystemLog = Join-Path $logsDir "filesystem-$runId.log"
$ngrokLog = Join-Path $logsDir "ngrok.log"
$tailscaleLog = Join-Path $logsDir "tailscale.log"
$shellLog = Join-Path $logsDir "shell.log"
$authStateFile = Join-Path $logsDir "auth-state.json"
$stopScript = Join-Path $projectRoot "scripts\stop-mcp-stack.ps1"
$wrapperScript = Join-Path $projectRoot "scripts\authenticated-mcp-wrapper.mjs"

function Write-Section {
    param([string]$Text)
    Write-Host ""
    Write-Host "== $Text =="
}

function Follow-StackLogs {
    param(
        [Parameter(Mandatory = $true)]
        [string[]]$Paths
    )

    Write-Section "Live Logs"
    Write-Host "Streaming logs. Press Ctrl+C to stop watching. Stack keeps running until you call stop-mcp-stack.ps1."

    $existingPaths = @($Paths | Where-Object { Test-Path $_ })
    if ($existingPaths.Count -eq 0) {
        Write-Host "No log files found to follow."
        return
    }

    Get-Content -Path $existingPaths -Tail 10 -Wait
}

function Load-DotEnv {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path
    )

    if (-not (Test-Path $Path)) {
        throw "Missing .env file at $Path. Copy .env.example to .env and update REPO_ROOT."
    }

    $values = @{}
    foreach ($line in Get-Content -Path $Path) {
        $trimmed = $line.Trim()
        if (-not $trimmed) {
            continue
        }

        if ($trimmed.StartsWith("#")) {
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

function Get-ListeningOwningProcessIds {
    param(
        [Parameter(Mandatory = $true)]
        [int]$Port
    )

    $portOwners = @()
    foreach ($line in (netstat -ano -p tcp)) {
        if ($line -match "^\s*TCP\s+\S+:$Port\s+\S+\s+LISTENING\s+(\d+)\s*$") {
            $portOwners += [int]$Matches[1]
        }
    }

    return $portOwners | Select-Object -Unique
}

function Assert-PortAvailable {
    param(
        [Parameter(Mandatory = $true)]
        [int]$Port
    )

    $owners = @(Get-ListeningOwningProcessIds -Port $Port)
    if ($owners.Count -gt 0) {
        throw "Port $Port is already in use by PID(s): $($owners -join ', ')."
    }
}

function Wait-ForHttp {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Url,
        [int]$TimeoutSeconds = 30
    )

    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    do {
        try {
            Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 5 | Out-Null
            return $true
        } catch {
            Start-Sleep -Seconds 1
        }
    } while ((Get-Date) -lt $deadline)

    return $false
}

function Wait-ForPort {
    param(
        [Parameter(Mandatory = $true)]
        [string]$HostName,
        [Parameter(Mandatory = $true)]
        [int]$Port,
        [int]$TimeoutSeconds = 30
    )

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

    $dnsName = [string]$status.Self.DNSName
    $dnsName = $dnsName.TrimEnd(".")
    if (-not $dnsName) {
        throw "Tailscale DNSName is empty."
    }

    return "https://$dnsName"
}

function New-ProcessRecord {
    param(
        [string]$Name,
        [int]$ProcessId,
        [string]$LogPath,
        [int]$LaunchPid = 0,
        [int]$Port = 0
    )

    return [pscustomobject]@{
        name      = $Name
        pid       = $ProcessId
        launchPid = $LaunchPid
        port      = $Port
        logPath   = $LogPath
    }
}

function Get-ListeningOwningProcessId {
    param(
        [Parameter(Mandatory = $true)]
        [int]$Port,
        [int]$TimeoutSeconds = 15
    )

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

Write-Section "Environment"
$envValues = Load-DotEnv -Path $envPath

$tunnelMode = "ngrok"
if ($PSBoundParameters.ContainsKey("Tunnel")) {
    $tunnelMode = $Tunnel
} elseif ($envValues.ContainsKey("MCP_TUNNEL_MODE") -and $envValues["MCP_TUNNEL_MODE"]) {
    $tunnelMode = $envValues["MCP_TUNNEL_MODE"].Trim().ToLowerInvariant()
}
if ($tunnelMode -notin @("ngrok", "tailscale")) {
    throw "MCP_TUNNEL_MODE must be ngrok or tailscale: $tunnelMode"
}

Write-Section "Prerequisites"
$prereqs = & (Join-Path $projectRoot "scripts\check-prereqs.ps1") -Tunnel $tunnelMode
$prereqs | Format-List | Out-String | Write-Host

if ($PSBoundParameters.ContainsKey("Path")) {
    if (-not $Path.Trim()) {
        throw "-Path was provided but empty."
    }
    $repoRoot = $Path.Trim().Trim('"', "'")
} else {
    $repoRoot = $envValues["REPO_ROOT"]
    if ($repoRoot) {
        $repoRoot = $repoRoot.Trim().Trim('"', "'")
    }
}

if (-not $repoRoot) {
    throw "Repo root is missing. Pass -Path or set REPO_ROOT in .env."
}

if (-not (Test-Path -LiteralPath $repoRoot)) {
    throw "REPO_ROOT does not exist: $repoRoot"
}

$repoRoot = (Resolve-Path -LiteralPath $repoRoot).Path

$gatewayPort = 8000
if ($PSBoundParameters.ContainsKey("P")) {
    $gatewayPort = $P
} elseif ($envValues.ContainsKey("MCP_GATEWAY_PORT") -and $envValues["MCP_GATEWAY_PORT"]) {
    $gatewayPort = [int]$envValues["MCP_GATEWAY_PORT"]
}
if ($gatewayPort -lt 1 -or $gatewayPort -gt 65535) {
    throw "Port must be between 1 and 65535: $gatewayPort"
}

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
$ngrokAuthtoken = $envValues["NGROK_AUTHTOKEN"]
$authPassword = $envValues["MCP_AUTH_PASSWORD"]
$bearerToken = $envValues["MCP_BEARER_TOKEN"]

if (-not $enableFilesystem) {
    throw "ENABLE_FILESYSTEM=false is not supported in v1."
}

if (-not $authPassword) {
    throw "MCP_AUTH_PASSWORD is missing in .env."
}

if ($repoRoot -match '^[A-Za-z]:\\$') {
    throw "Refusing to expose drive root as REPO_ROOT: $repoRoot"
}

New-Item -ItemType Directory -Force -Path $logsDir | Out-Null

Write-Section "Dependencies"
if (-not (Test-Path (Join-Path $projectRoot "node_modules"))) {
    Write-Host "Installing npm dependencies..."
    npm install --no-fund --no-audit | Tee-Object -FilePath (Join-Path $logsDir "npm-install.log")
} else {
    Write-Host "Using existing node_modules."
}

if ($tunnelMode -eq "ngrok" -and $ngrokAuthtoken) {
    ngrok config add-authtoken $ngrokAuthtoken | Out-Null
}

if (Test-Path $pidFile) {
    Write-Host "Existing PID file found. Stopping previous stack first."
    & $stopScript
}

if (-not $enableShell) {
    "Shell MCP is disabled. Set ENABLE_SHELL=true in .env to expose shell tools." | Set-Content -Path $shellLog -Encoding ASCII
}

Assert-PortAvailable -Port $gatewayPort

if (-not (Test-Path $wrapperScript)) {
    throw "Authenticated wrapper script not found: $wrapperScript"
}

$records = New-Object System.Collections.Generic.List[object]

if ($tunnelMode -eq "ngrok") {
    Write-Section "Starting ngrok"
    $ngrokCommand = "ngrok http $gatewayPort --host-header=localhost:$gatewayPort 1>> `"$ngrokLog`" 2>&1"
    $ngrokProcess = Start-Process -FilePath "cmd.exe" -ArgumentList @("/c", $ngrokCommand) -WorkingDirectory $projectRoot -PassThru -WindowStyle Hidden
    $ngrokPid = Get-ListeningOwningProcessId -Port 4040
    $records.Add((New-ProcessRecord -Name "ngrok" -ProcessId $ngrokPid -LaunchPid $ngrokProcess.Id -Port 4040 -LogPath $ngrokLog))

    $publicBaseUrl = Get-NgrokPublicUrl
} else {
    Write-Section "Starting Tailscale Funnel"
    $tailscaleOutput = tailscale funnel --bg --yes $gatewayPort 2>&1
    $tailscaleOutput | Set-Content -Path $tailscaleLog -Encoding ASCII
    if ($LASTEXITCODE -ne 0) {
        throw "tailscale funnel failed. Check $tailscaleLog"
    }
    $publicBaseUrl = Get-TailscalePublicUrl
    $records.Add((New-ProcessRecord -Name "tailscale-funnel" -ProcessId 0 -LaunchPid 0 -Port 443 -LogPath $tailscaleLog))
}

$finalMcpUrl = "$publicBaseUrl/mcp"

Write-Section "Starting Gateway"
"Filesystem MCP is launched as a child process of the authenticated wrapper with REPO_ROOT=$repoRoot" | Set-Content -Path $filesystemLog -Encoding ASCII
$gatewayEnv = @(
    "set `"REPO_ROOT=$repoRoot`"",
    "set `"MCP_GATEWAY_PORT=$gatewayPort`"",
    "set `"PUBLIC_BASE_URL=$publicBaseUrl`"",
    "set `"MCP_TRUSTED_ROOTS=$trustedRootsValue`"",
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

if (-not (Wait-ForPort -HostName "127.0.0.1" -Port $gatewayPort -TimeoutSeconds 30)) {
    throw "Gateway did not become ready. Check $gatewayLog"
}

$gatewayPid = Get-ListeningOwningProcessId -Port $gatewayPort
$records.Add((New-ProcessRecord -Name "gateway" -ProcessId $gatewayPid -LaunchPid $gatewayProcess.Id -Port $gatewayPort -LogPath $gatewayLog))

$records | ConvertTo-Json | Set-Content -Path $pidFile -Encoding ASCII

Write-Section "Ready"
Write-Host "OAuth protection: ON"
Write-Host "Static bearer auth: $(if ($bearerToken) { 'ON' } else { 'OFF' })"
Write-Host "Filesystem tools: $enableFilesystem"
Write-Host "Shell tools: $enableShell"
Write-Host "Shell profile: $shellProfileValue"
Write-Host "Tunnel mode: $tunnelMode"
Write-Host "Active repo root: $repoRoot"
Write-Host "Gateway port: $gatewayPort"
Write-Host "Public base URL: $publicBaseUrl"
Write-Host "Final MCP URL: $finalMcpUrl"
Write-Host ""
Write-Host "ChatGPT Developer Mode"
Write-Host "Name: Local Dev MCP"
Write-Host "MCP Server URL: $finalMcpUrl"
Write-Host "Authentication: OAuth"
Write-Host "OAuth login password: read MCP_AUTH_PASSWORD from .env"
if ($bearerToken) {
    Write-Host ""
    Write-Host "Hermes / OpenClaw"
    Write-Host "MCP Server URL: $finalMcpUrl"
    Write-Host "API key / Bearer token: read MCP_BEARER_TOKEN from .env"
}
Write-Host ""
Write-Host "Logs:"
Write-Host "  Gateway: $gatewayLog"
Write-Host "  Filesystem: $filesystemLog"
Write-Host "  Shell: $shellLog"
if ($tunnelMode -eq "ngrok") {
    Write-Host "  Ngrok: $ngrokLog"
} else {
    Write-Host "  Tailscale: $tailscaleLog"
}

if ($FollowLogs) {
    if ($tunnelMode -eq "ngrok") {
        Follow-StackLogs -Paths @($gatewayLog, $filesystemLog, $shellLog, $ngrokLog)
    } else {
        Follow-StackLogs -Paths @($gatewayLog, $filesystemLog, $shellLog, $tailscaleLog)
    }
}
