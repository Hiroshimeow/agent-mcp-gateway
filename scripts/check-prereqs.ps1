param(
    [ValidateSet("none", "ngrok", "tailscale")]
    [string]$Tunnel = "ngrok"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Test-CommandExists {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Name
    )

    return $null -ne (Get-Command -Name $Name -ErrorAction SilentlyContinue)
}

function Assert-Command {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Name,
        [string]$Hint = ""
    )

    if (-not (Test-CommandExists -Name $Name)) {
        $message = "Missing required command: $Name"
        if ($Hint) {
            $message += ". $Hint"
        }

        throw $message
    }
}

Assert-Command -Name "node" -Hint "Install Node.js LTS from https://nodejs.org/"
Assert-Command -Name "npm" -Hint "Install Node.js LTS from https://nodejs.org/"
Assert-Command -Name "npx" -Hint "Install Node.js LTS from https://nodejs.org/"
if ($Tunnel -eq "ngrok") {
    Assert-Command -Name "ngrok" -Hint "Install ngrok from https://ngrok.com/download"
} elseif ($Tunnel -eq "tailscale") {
    Assert-Command -Name "tailscale" -Hint "Install Tailscale from https://tailscale.com/download"
}

$nodeVersion = node --version
$npmVersion = npm --version
$tunnelVersion = if ($Tunnel -eq "ngrok") { ngrok version } elseif ($Tunnel -eq "tailscale") { tailscale version | Select-Object -First 1 } else { "none" }

[pscustomobject]@{
    NodeVersion   = $nodeVersion
    NpmVersion    = $npmVersion
    TunnelMode    = $Tunnel
    TunnelVersion = $tunnelVersion
}
