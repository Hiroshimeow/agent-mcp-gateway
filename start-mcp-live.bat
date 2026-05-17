@echo off
setlocal
set "TUNNEL_CHOICE="
set "REPO_ROOT_INPUT="

echo Tunnel mode:
echo   1. Tailscale Funnel (default)
echo   2. ngrok
echo   3. both
set /p "TUNNEL_CHOICE=Choose tunnel [1]: "
if "%TUNNEL_CHOICE%"=="" set "TUNNEL_CHOICE=1"

set /p "REPO_ROOT_INPUT=Repo path: "
if "%REPO_ROOT_INPUT%"=="" (
  echo Repo path is required.
  exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -Command "& '%~dp0scripts\start-mcp-live.ps1' -TunnelChoice $env:TUNNEL_CHOICE -Path $env:REPO_ROOT_INPUT -FollowLogs"
if errorlevel 1 exit /b %errorlevel%
pause
