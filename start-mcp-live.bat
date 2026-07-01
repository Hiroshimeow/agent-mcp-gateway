@echo off
setlocal
set "REPO_ROOT_INPUT="
set "MCP_IP_INPUT="
set "MCP_PORT_INPUT="
set "MCP_ADVERTISE_URL_INPUT="

echo MCP local gateway

set /p "REPO_ROOT_INPUT=Repo path: "
if "%REPO_ROOT_INPUT%"=="" (
  echo Repo path is required.
  exit /b 1
)

set /p "MCP_IP_INPUT=Bind IP/host [127.0.0.1]: "
if "%MCP_IP_INPUT%"=="" set "MCP_IP_INPUT=127.0.0.1"

set /p "MCP_PORT_INPUT=Port [8101]: "
if "%MCP_PORT_INPUT%"=="" set "MCP_PORT_INPUT=8101"


set /p "MCP_ADVERTISE_URL_INPUT=Public HTTPS advertise URL (optional): "


"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -Command "& '%~dp0scripts\start-mcp-live.ps1' -Path $env:REPO_ROOT_INPUT -Ip $env:MCP_IP_INPUT -P ([int]$env:MCP_PORT_INPUT) -AdvertiseUrl $env:MCP_ADVERTISE_URL_INPUT -FollowLogs"
set "LAUNCH_EXIT_CODE=%errorlevel%"
if not "%LAUNCH_EXIT_CODE%"=="0" (
  echo.
  echo Launcher failed with exit code %LAUNCH_EXIT_CODE%.
  echo Check logs\gateway.log and logs\filesystem-*.log for the real error.
  pause
  exit /b %LAUNCH_EXIT_CODE%
)
pause
