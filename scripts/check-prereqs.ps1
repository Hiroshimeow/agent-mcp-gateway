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

$nodeVersion = node --version
$npmVersion = npm --version

[pscustomobject]@{
    NodeVersion = $nodeVersion
    NpmVersion  = $npmVersion
}
