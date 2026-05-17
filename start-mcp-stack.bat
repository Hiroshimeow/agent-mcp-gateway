@echo off
setlocal
set "REPO_ROOT_INPUT="
set "PORT_INPUT="
set "TUNNEL_INPUT="

set /p "REPO_ROOT_INPUT=Repo path: "
if "%REPO_ROOT_INPUT%"=="" (
  echo Repo path is required.
  exit /b 1
)

set /p "PORT_INPUT=Port [8000]: "
if "%PORT_INPUT%"=="" set "PORT_INPUT=8000"

set /p "TUNNEL_INPUT=Tunnel [ngrok/tailscale] [ngrok]: "
if "%TUNNEL_INPUT%"=="" set "TUNNEL_INPUT=ngrok"

powershell -ExecutionPolicy Bypass -File "%~dp0scripts\start-mcp-stack.ps1" -Path "%REPO_ROOT_INPUT%" -P "%PORT_INPUT%" -Tunnel "%TUNNEL_INPUT%" -FollowLogs
if errorlevel 1 exit /b %errorlevel%
pause
