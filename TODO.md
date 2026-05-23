# TODO - personal-mcp-launcher

## Current target

Ship a Windows-first local MCP launcher that binds to `127.0.0.1:<port>`, with filesystem support on by default and shell support available behind auth.

## Implemented

- Double-click entrypoint via `start-mcp-live.bat`
- Live Windows PowerShell launcher and stop script
- OAuth + local password gate
- Filesystem MCP limited to configured trusted roots
- Local-only gateway on `127.0.0.1:<port>`
- PID tracking in `logs/live-pids.json`
- Direct OS shell execution from wrapper: PowerShell on Windows, POSIX shell on Linux/macOS
- Merged tool surface exposed from one `/mcp` endpoint
- Full yolo shell mode in `authenticated-mcp-wrapper.mjs`; command strings run as-is and are not translated between PowerShell and POSIX
- Agent tool expansion from 16 to 31 visible `custom_*` tools including `custom_list_projects`
- Local custom tool registry in `scripts/custom-tools/`
- Project-agent wrappers for project discovery, grep, patch, copy/delete, git, zip, secret scan, diff review, tests, and release review
- Unit/integration-style tests for custom tool utilities and wrappers

## Current shell policy

- Expose only:
  - `shell_execute`
  - `get_platform_info`
- Force working directory inside configured trusted roots
- Default profile is `yolo`
- After auth, shell runs in full yolo mode with no launcher-side blocklist, approval prompt, or executable whitelist

## Remaining work

- Keep `.plan/` as implementation handoff records; do not add `.plan/` to `.gitignore`.
- Keep real trusted roots in local-only `config/trusted-roots.txt`; commit only examples unless intentionally publishing machine-local roots.
- Use `config/trusted-roots.txt` as the single source of truth for v1 multi-project discovery; do not use `config/projects.json`.
- Keep release artifacts in local-only `packages/`; do not commit generated zip files.
- Run the release workflow before publishing: `custom_git_status`, `custom_secret_scan`, `custom_review_diff`, `custom_run_tests`, `custom_release_review`, `custom_zip_create`, `custom_git_add`, `custom_git_commit`, `custom_git_push`.
- Persist OAuth client registration across restarts so ChatGPT app recreation is less likely
- Add an explicit smoke-test script for MCP endpoint readiness
- Improve shell policy around docker bind mounts if needed
- Add hard per-project filesystem/shell isolation later; current project ids are routing metadata over global trusted roots
