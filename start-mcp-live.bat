@echo off
setlocal
set "REPO_ROOT_INPUT="
set "MCP_IP_INPUT="
set "MCP_PORT_INPUT="

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

powershell -NoProfile -ExecutionPolicy Bypass -Command "& '%~dp0scripts\start-mcp-live.ps1' -Path $env:REPO_ROOT_INPUT -Ip $env:MCP_IP_INPUT -P ([int]$env:MCP_PORT_INPUT) -FollowLogs"
if errorlevel 1 exit /b %errorlevel%
pause
