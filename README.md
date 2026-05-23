# Agent MCP Gateway

A Windows-first local MCP gateway for AI agents. It exposes local development tools on a chosen bind IP, defaults to `127.0.0.1:8101`, wraps them behind OAuth/password or Bearer-token authentication, and provides project-oriented file, shell, git, test, review, packaging, and safety-check tools.

> Recommended GitHub repository name: `agent-mcp-gateway`

## What this project does

This project starts a local MCP gateway on Windows and lets an authenticated MCP client work inside explicitly trusted local directories.

It is designed for short-lived development sessions where you want an AI coding assistant to inspect, edit, test, review, package, and optionally commit code in local repositories.

## Features

- Windows-first startup scripts with `.bat` and PowerShell entrypoints.
- Direct OS shell execution: PowerShell on Windows and a POSIX shell on Linux/macOS. Command strings run as-is; the gateway does not translate command syntax between PowerShell and POSIX.
- OAuth login flow for ChatGPT Developer Mode.
- Optional static Bearer token support for MCP clients that do not support OAuth.
- Filesystem MCP access scoped to configured trusted roots.
- Project ids help agents route work across trusted roots, but filesystem and shell tools still use the global trusted-root set in v1.
- `MCP_SAFETY_PROFILE` with `yolo` as the default private local-dev mode, plus narrower `safe` and `assisted` profiles.
- Optional full-trust shell execution after authentication in `yolo` only.
- Native read-only MCP Resources and MCP Prompts for repo summaries, manifests, review flows, and release workflows.
- 32 visible `custom_*` tools in `yolo`, including project discovery, safety-profile inspection, file operations, search, patching, git, tests, review, secret scanning, and zip packaging.
- Local logs and OAuth session cache under `logs/`.
- Portable zip packaging for moving the launcher between machines without vendored dependencies.

## Repository name

Use this name for GitHub:

```text
agent-mcp-gateway
```

Why this name works:

- It says the project is primarily a gateway for AI agents.
- It still includes the important MCP keyword.
- It covers both generic MCP agents and ChatGPT Developer Mode without making the repo ChatGPT-only.
- It sounds less personal and more reusable than `personal-mcp-launcher`.

Other acceptable names:

```text
mcp-agent-gateway
chatgpt-agent-mcp-gateway
windows-agent-mcp-gateway
local-agent-mcp-gateway
```

## Architecture

```text
MCP client
  -> OAuth/password wrapper
  -> local MCP gateway
  -> filesystem, shell, git, tests, review, packaging tools
  -> trusted local project roots
```

The local wrapper listens on:

```text
http://127.0.0.1:<MCP_GATEWAY_PORT>/mcp
```

## Requirements

- Windows 10 or Windows 11.
- Node.js LTS with `npm` and `npx` available on `PATH`.
- Git, if you want the git tools to work.
- A dedicated project directory to use as `REPO_ROOT`.

## Quick start

Clone the repository:

```powershell
git clone https://github.com/<your-user>/agent-mcp-gateway.git
cd agent-mcp-gateway
```

Install dependencies:

```powershell
npm install
```

Fastest local run:

```powershell
uv run main.py
```

With no arguments, `main.py` uses:

```text
repo root: current directory
bind IP:   127.0.0.1
port:      8101
MCP URL:   http://127.0.0.1:8101/mcp
```

To choose another repo, bind address, or port:

```powershell
uv run main.py --repo E:\path\to\your\project --ip 127.0.0.1 --port 8101
```

To bind to a Tailscale IP or all interfaces, change `--ip`, for example `--ip 100.x.y.z` or `--ip 0.0.0.0`.

When the gateway is reached through a public HTTPS reverse proxy or SSH tunnel, it derives OAuth metadata from the request `Host`/`X-Forwarded-*` headers. If your proxy does not preserve those headers, set the public base URL explicitly:

```powershell
uv run main.py --ip 127.0.0.1 --port 8101 --advertise-url https://mcp.hcu-lab.me
```

This should make OAuth discovery publish `https://mcp.hcu-lab.me/register` instead of a local loopback URL, which external clients such as ChatGPT cannot use.

Windows prompt-based launcher:

```powershell
.\start-mcp-live.bat
```

When prompted, enter the repository path that should become the active trusted root. The default bind address is `127.0.0.1` and the default port is `8101`. The batch launcher does not ask for a public URL; use the local MCP URL it prints unless you explicitly run `uv run main.py --advertise-url ...` or `scripts\start-mcp-live.ps1 -AdvertiseUrl ...` behind a public proxy.

Optional `.env` setup:

```powershell
Copy-Item .env.example .env
```

Use `.env` for auth tokens, trusted roots, shell/filesystem settings, and direct `npm start`/Node wrapper runs. `uv run main.py` intentionally keeps its no-argument defaults as current directory, `127.0.0.1`, and `8101`; pass `--repo`, `--ip`, and `--port` to change those.

Use the printed local MCP URL in your MCP client:

```text
http://127.0.0.1:<MCP_GATEWAY_PORT>/mcp
```

For ChatGPT Developer Mode, configure the connector as:

```text
Name: Local Dev MCP
MCP Server URL: http://127.0.0.1:<MCP_GATEWAY_PORT>/mcp
Authentication: OAuth
```

When the browser login page opens, enter `MCP_AUTH_PASSWORD`. `uv run main.py` never prints tokens loaded from `.env`, environment variables, or `--token`. If no token is configured, it generates and prints a temporary token for that session only.

Stop the live launcher:

```powershell
.\stop-mcp-live.bat
```

## Environment variables

```dotenv
REPO_ROOT=.
MCP_TRUSTED_ROOTS=
MCP_TRUSTED_ROOTS_FILE=
MCP_DEFAULT_PROJECT_ID=
MCP_REQUIRE_PROJECT_ID=false
MCP_ENABLE_PROJECT_PATH_INFERENCE=true
MCP_EXPOSE_PROJECT_PATHS=false
MCP_GATEWAY_HOST=127.0.0.1
MCP_ADVERTISE_HOST=
# Optional public HTTPS base URL for OAuth metadata behind a reverse proxy or SSH tunnel.
MCP_ADVERTISE_URL=
MCP_GATEWAY_PORT=8101
ENABLE_FILESYSTEM=true
ENABLE_SHELL=true
MCP_SAFETY_PROFILE=yolo
SHELL_PROFILE=yolo
XAI_API_KEY=
# Placeholder only. Set a real value for .bat or direct Node wrapper runs.
MCP_AUTH_PASSWORD=change-me-now
MCP_BEARER_TOKEN=
```

Important variables:

- `REPO_ROOT`: fallback trusted root for direct `npm start` or `node scripts/authenticated-mcp-wrapper.mjs` runs. `uv run main.py` defaults to the current directory unless `--repo` is passed.
- `MCP_TRUSTED_ROOTS`: optional newline- or semicolon-separated trusted roots using the same formats as `config/trusted-roots.txt`.
- `MCP_TRUSTED_ROOTS_FILE`: optional file containing one trusted root per line. Keep the real file local and commit only `config/trusted-roots.example.txt`.
- `MCP_DEFAULT_PROJECT_ID`: optional default project id for multi-project workflows.
- `MCP_REQUIRE_PROJECT_ID`: set to `true` only when callers must pass explicit project ids to project-aware custom tools.
- `MCP_ENABLE_PROJECT_PATH_INFERENCE`: defaults to `true`; allows absolute paths to infer project id by longest trusted-root prefix.
- `MCP_EXPOSE_PROJECT_PATHS`: defaults to `false`; `custom_list_projects` hides full local paths unless this is set to `true`.
- `MCP_GATEWAY_HOST`: bind IP/host for direct Node wrapper runs. Use `127.0.0.1` for local-only, a Tailscale IP for tailnet access, or `0.0.0.0` to bind all interfaces.
- `MCP_ADVERTISE_HOST`: optional host used in OAuth metadata and printed MCP URLs for direct Node wrapper runs. If empty, it follows `MCP_GATEWAY_HOST`; for `0.0.0.0`, it defaults to `127.0.0.1`.
- `MCP_ADVERTISE_URL`: optional full public base URL, such as `https://mcp.hcu-lab.me`, used as an override when proxy headers do not expose the public origin.
- `MCP_GATEWAY_PORT`: local port for direct Node wrapper runs.
- `ENABLE_FILESYSTEM`: enables filesystem tools.
- `ENABLE_SHELL`: enables shell execution tools and defaults to `true` for this private local-dev gateway. `custom_shell_execute` is still hidden and rejected unless the active safety profile exposes shell.
- `MCP_SAFETY_PROFILE`: defaults to `yolo`. `safe` exposes read-only tools/resources/prompts, `assisted` allows non-open-world mutating helper tools but hides raw shell and open-world tools such as `custom_git_push`, and `yolo` exposes the private full local-dev surface.
- `SHELL_PROFILE`: backward-compatible alias for older configs; `MCP_SAFETY_PROFILE` wins when both are set.
- `MCP_AUTH_PASSWORD`: password used by the OAuth login page.
- `MCP_BEARER_TOKEN`: optional static Bearer token for clients that cannot complete OAuth.

Token logging rules:

- Tokens loaded from `.env`, environment variables, or `--token` are never printed.
- If no token is configured, `uv run main.py` generates a temporary session token and prints it once so you can complete login.
- Treat generated temporary tokens as secrets; close the server to invalidate the runtime-only value.

## Tool set

The launcher exposes 32 visible custom tools in the default `yolo` profile. The active safety profile may intentionally hide risky tools from `tools/list`, and hidden tools are also rejected at call time.

Filesystem and shell tools:

- `custom_read_file`
- `custom_read_text_file`
- `custom_read_media_file`
- `custom_read_multiple_files`
- `custom_write_file`
- `custom_edit_file`
- `custom_create_directory`
- `custom_list_directory`
- `custom_list_directory_with_sizes`
- `custom_directory_tree`
- `custom_move_file`
- `custom_search_files`
- `custom_get_file_info`
- `custom_list_allowed_directories`
- `custom_shell_execute`
- `custom_get_platform_info`

Project-agent tools:

- `custom_list_projects`
- `custom_get_safety_profile`
- `custom_grep`
- `custom_apply_patch`
- `custom_delete_file`
- `custom_copy_file`
- `custom_git_status`
- `custom_git_diff`
- `custom_git_add`
- `custom_git_commit`
- `custom_git_push`
- `custom_zip_create`
- `custom_secret_scan`
- `custom_review_diff`
- `custom_run_tests`
- `custom_release_review`

## Recommended agent workflow

Read-only context can also be gathered via native MCP Resources such as `repo://projects`, `repo://project/<projectId>/summary`, `repo://project/<projectId>/readme`, `repo://project/<projectId>/package`, `repo://project/<projectId>/tree`, `repo://project/<projectId>/git/status`, `repo://project/<projectId>/safety-profile`, and `repo://project/<projectId>/tool-manifest`. Native MCP Prompts include `review_repo`, `security_audit`, `cross_platform_review`, `release_readiness`, `explain_diff`, `generate_pr_description`, `plan_feature`, and `fix_with_tests`.

Before making changes:

```text
custom_list_projects
custom_list_allowed_directories
custom_git_status
custom_git_diff
```

When editing:

```text
custom_read_text_file
custom_grep
custom_edit_file or custom_apply_patch
custom_run_tests
custom_review_diff
custom_secret_scan
```

Before publishing or pushing:

```text
custom_git_status
custom_secret_scan
custom_review_diff
custom_run_tests
custom_release_review
custom_git_add
custom_git_commit
custom_git_push
```

## Trusted roots and project discovery

`config/trusted-roots.txt` is the v1 source of truth for multi-project discovery. `config/projects.json` is not used.

Supported formats:

```text
path
path | projectId
path | projectId | displayName
```

Repeat the same `projectId` on multiple lines to group multiple trusted roots under one project. Legacy path-only lines continue to work and receive generated project ids.

Agents should call `custom_list_projects` to discover available `projectId` values. By default the tool returns project ids and display names, not full local paths. To expose paths explicitly, set `MCP_EXPOSE_PROJECT_PATHS=true` and call `custom_list_projects` with `showPaths: true`.

Project discovery is routing metadata for multi-agent workflows. In this version, filesystem and shell tools still operate over the configured trusted roots; project ids are not hard sandbox isolation boundaries.

## Packaging for another machine

This repository includes `custom_zip_create`, which can create a portable archive of the launcher.

Recommended portable archive contents:

- include source files, scripts, config examples, tests, and `.env` when you explicitly want to move your local setup;
- exclude `.git/`, `node_modules/`, `packages/`, and `logs/`;
- reinstall dependencies on the target machine with `npm install`.

If the target project itself is Python-based and uses `uv`, run `uv sync` inside that target project after moving it. This launcher itself is a Node.js project and uses `npm`.

## Running tests

```powershell
npm test
```

The test suite covers:

- auth/session behavior;
- command execution helpers;
- trusted-root path validation;
- file operations;
- grep;
- git wrappers;
- secret scanning;
- review checks;
- test runner wrapper;
- release review;
- zip creation.

## Logs

Runtime logs are written under `logs/`:

- `gateway.log`: OAuth wrapper and MCP gateway logs.
- `filesystem-<timestamp>.log`: filesystem MCP runtime logs.
- `shell.log`: shell runtime log or placeholder.
- `live-pids.json`: process IDs for the live launcher.
- `auth-state.json`: OAuth client/token state cache.

The `logs/` directory is local runtime state and should not be committed.

## Security model

This project is intended for local development, not production hosting.

The local MCP endpoint is protected by OAuth/password authentication and can optionally accept a static Bearer token. After authentication, enabled tools can read, write, delete, execute shell commands, run tests, and perform git operations inside trusted roots.

Important warnings:

- Do not expose broad directories such as `C:\`, `E:\`, your home directory, Desktop, or Downloads.
- Use a narrow project folder as `REPO_ROOT`.
- Do not commit `.env`.
- Do not commit `config/trusted-roots.txt` if it contains real local paths.
- By default, unset `ENABLE_SHELL` behaves like `ENABLE_SHELL=true`; with default `MCP_SAFETY_PROFILE=yolo`, raw shell is exposed after authentication.
- Treat `ENABLE_SHELL=true` plus `MCP_SAFETY_PROFILE=yolo` as full command execution access after authentication.
- Yolo removes extra gateway-side approval prompts, shell blocklists, and executable allowlist restrictions for trusted private local development, but it does not bypass ChatGPT host safety, ChatGPT Developer Mode confirmation UI, user confirmations, or platform policy.
- Risky tools are annotated honestly. For example, raw shell and `custom_git_push` are destructive and open-world, while read-only resources/tools use `readOnlyHint: true` where accurate.
- Public tunnel URLs should be treated as sensitive operational information.
- Rotate `MCP_AUTH_PASSWORD` and `MCP_BEARER_TOKEN` if they are shared or exposed.

See `SECURITY.md` for more details.

## GitHub publishing checklist

Before pushing this repository publicly:

```powershell
npm test
git status
```

Make sure these files are not committed:

```text
.env
logs/
node_modules/
packages/
config/trusted-roots.txt
*.zip
```

Recommended first push:

```powershell
git remote add origin https://github.com/<your-user>/agent-mcp-gateway.git
git branch -M main
git push -u origin main
```

## License

MIT. See `LICENSE` for details.
