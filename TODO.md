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
- Agent tool expansion from 16 to 30 visible `custom_*` tools per `.plan/agent-tool-expansion-plan.md`
- Local custom tool registry in `scripts/custom-tools/`
- Project-agent wrappers for grep, patch, copy/delete, git, zip, secret scan, diff review, tests, and release review
- Unit/integration-style tests for custom tool utilities and wrappers

## Current shell policy

- Expose only:
  - `shell_execute`
  - `get_platform_info`
- Force working directory inside `REPO_ROOT`
- Default profile is `yolo`
- After auth, shell runs in full yolo mode with no launcher-side blocklist, approval prompt, or executable whitelist

## Remaining work

- Keep `.plan/agent-tool-expansion-plan.md` as the implementation handoff record; do not add `.plan/` to `.gitignore`.
- Keep real trusted roots in local-only `config/trusted-roots.txt`; commit only `config/trusted-roots.example.txt`.
- Keep release artifacts in local-only `packages/`; do not commit generated zip files.
- Run the release workflow before publishing: `custom_git_status`, `custom_secret_scan`, `custom_review_diff`, `custom_run_tests`, `custom_release_review`, `custom_zip_create`, `custom_git_add`, `custom_git_commit`, `custom_git_push`.
- Persist OAuth client registration across restarts so ChatGPT app recreation is less likely
- Add an explicit smoke-test script for MCP endpoint readiness
- Improve shell policy around docker bind mounts if needed
- Evaluate Cloudflare Tunnel or Tailscale as a more stable public endpoint than ngrok free
- Add multi-repo or repo-picker UX later without widening filesystem scope by default
