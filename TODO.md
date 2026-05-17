# TODO - personal-mcp-launcher

## Current target

Ship a Windows-first MCP launcher that ChatGPT Developer Mode can use through one HTTPS endpoint, with filesystem support on by default and shell support available behind auth.

## Implemented

- Double-click entrypoint via `start-mcp-stack.bat`
- PowerShell launcher and stop script
- OAuth + local password gate
- Filesystem MCP limited to `REPO_ROOT`
- ngrok tunnel with host-header rewrite
- PID tracking in `logs/pids.json`
- Direct PowerShell shell execution from wrapper
- Merged tool surface exposed from one `/mcp` endpoint
- Full yolo shell mode in `authenticated-mcp-wrapper.mjs`

## Current shell policy

- Expose only:
  - `shell_execute`
  - `get_platform_info`
- Force working directory inside `REPO_ROOT`
- Default profile is `yolo`
- After auth, shell runs in full yolo mode with no launcher-side blocklist, approval prompt, or executable whitelist

## Remaining work

- Persist OAuth client registration across restarts so ChatGPT app recreation is less likely
- Add an explicit smoke-test script for MCP endpoint readiness
- Improve shell policy around docker bind mounts if needed
- Evaluate Cloudflare Tunnel or Tailscale as a more stable public endpoint than ngrok free
- Add multi-repo or repo-picker UX later without widening filesystem scope by default
