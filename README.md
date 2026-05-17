# Local Dev MCP Launcher

A Windows-first launcher for exposing local development tools to MCP clients such as ChatGPT Developer Mode through a public HTTPS tunnel. It wraps local MCP servers behind OAuth/password authentication and provides project-oriented file, shell, git, test, review, packaging, and safety-check tools.

> Recommended GitHub repository name: `local-dev-mcp-launcher`

## What this project does

This project starts a local MCP gateway on Windows, exposes it through Tailscale Funnel or ngrok, and lets an authenticated MCP client work inside explicitly trusted local directories.

It is designed for short-lived development sessions where you want an AI coding assistant to inspect, edit, test, review, package, and optionally commit code in local repositories.

## Features

- Windows-first startup scripts with `.bat` and PowerShell entrypoints.
- Public HTTPS tunnel support through Tailscale Funnel, ngrok, or both.
- OAuth login flow for ChatGPT Developer Mode.
- Optional static Bearer token support for MCP clients that do not support OAuth.
- Filesystem MCP access scoped to configured trusted roots.
- Optional full-trust shell execution after authentication.
- 30 visible `custom_*` tools for file operations, search, patching, git, tests, review, secret scanning, and zip packaging.
- Local logs and OAuth session cache under `logs/`.
- Portable zip packaging for moving the launcher between machines without vendored dependencies.

## Repository name

Use this name for GitHub:

```text
local-dev-mcp-launcher
```

Why this name works:

- It describes the actual purpose better than `personal-mcp-launcher`.
- It is broad enough for public use without sounding tied to one machine or one user.
- It contains the important search terms: `local`, `dev`, `mcp`, and `launcher`.

Other acceptable names:

```text
mcp-dev-launcher
windows-mcp-dev-gateway
local-mcp-dev-gateway
```

## Architecture

```text
MCP client
  -> HTTPS tunnel
  -> OAuth/password wrapper
  -> local MCP gateway
  -> filesystem, shell, git, tests, review, packaging tools
  -> trusted local project roots
```

The local wrapper listens on:

```text
http://127.0.0.1:<MCP_GATEWAY_PORT>/mcp
```

The public URL exposed to the MCP client is usually:

```text
https://<your-tunnel-domain>/mcp
```

## Requirements

- Windows 10 or Windows 11.
- Node.js LTS with `npm` and `npx` available on `PATH`.
- One tunnel provider:
  - Tailscale with Funnel enabled, or
  - ngrok.
- Git, if you want the git tools to work.
- A dedicated project directory to use as `REPO_ROOT`.

## Quick start

Clone the repository:

```powershell
git clone https://github.com/<your-user>/local-dev-mcp-launcher.git
cd local-dev-mcp-launcher
```

Install dependencies:

```powershell
npm install
```

Create your local environment file:

```powershell
Copy-Item .env.example .env
```

Edit `.env` and set at least:

```dotenv
REPO_ROOT=E:\path\to\your\project
MCP_AUTH_PASSWORD=replace-with-a-long-random-password
```

Start the live stack:

```powershell
.\start-mcp-live.bat
```

When prompted, choose a tunnel mode and enter the repository path that should become the active trusted root.

Copy the printed MCP URL into your MCP client:

```text
https://<your-tunnel-domain>/mcp
```

For ChatGPT Developer Mode, configure the connector as:

```text
Name: Local Dev MCP
MCP Server URL: https://<your-tunnel-domain>/mcp
Authentication: OAuth
```

When the browser login page opens, enter the value of `MCP_AUTH_PASSWORD` from `.env`.

Stop the stack:

```powershell
.\stop-mcp-live.bat
```

## Environment variables

```dotenv
REPO_ROOT=E:\path\to\your\project
MCP_TRUSTED_ROOTS=
MCP_TRUSTED_ROOTS_FILE=
MCP_GATEWAY_PORT=8000
MCP_TUNNEL_MODE=ngrok
PUBLIC_BASE_URL=
ENABLE_FILESYSTEM=true
ENABLE_SHELL=true
SHELL_PROFILE=yolo
NGROK_AUTHTOKEN=
XAI_API_KEY=
MCP_AUTH_PASSWORD=change-me-now
MCP_BEARER_TOKEN=
```

Important variables:

- `REPO_ROOT`: default trusted root and default working directory.
- `MCP_TRUSTED_ROOTS`: optional semicolon-separated list of additional trusted roots.
- `MCP_TRUSTED_ROOTS_FILE`: optional file containing one trusted root per line. Keep the real file local and commit only `config/trusted-roots.example.txt`.
- `MCP_GATEWAY_PORT`: local port for the OAuth MCP wrapper.
- `MCP_TUNNEL_MODE`: `tailscale`, `ngrok`, or `both`.
- `PUBLIC_BASE_URL`: explicit public base URL for server-only or preconfigured tunnel workflows.
- `ENABLE_FILESYSTEM`: enables filesystem tools.
- `ENABLE_SHELL`: enables shell execution tools.
- `SHELL_PROFILE`: currently defaults to full-trust `yolo` behavior.
- `MCP_AUTH_PASSWORD`: password used by the OAuth login page.
- `MCP_BEARER_TOKEN`: optional static Bearer token for clients that cannot complete OAuth.

## Tool set

The launcher exposes 30 visible custom tools.

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

Before making changes:

```text
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
- `ngrok.log`: ngrok tunnel output.
- `tailscale.log`: Tailscale Funnel output.
- `live-pids.json`: process IDs for the live stack.
- `pids.json`: legacy stack process IDs.
- `auth-state.json`: OAuth client/token state cache.

The `logs/` directory is local runtime state and should not be committed.

## Security model

This project is intended for local development, not production hosting.

The public tunnel is protected by OAuth/password authentication and can optionally accept a static Bearer token. After authentication, enabled tools can read, write, delete, execute shell commands, run tests, and perform git operations inside trusted roots.

Important warnings:

- Do not expose broad directories such as `C:\`, `E:\`, your home directory, Desktop, or Downloads.
- Use a narrow project folder as `REPO_ROOT`.
- Do not commit `.env`.
- Do not commit `config/trusted-roots.txt` if it contains real local paths.
- Treat `ENABLE_SHELL=true` as full command execution access after authentication.
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
git remote add origin https://github.com/<your-user>/local-dev-mcp-launcher.git
git branch -M main
git push -u origin main
```

## License

This repository is currently marked as private/unlicensed in `package.json`.

Before publishing publicly, choose and add a `LICENSE` file if you want other people to use, copy, or modify the project under explicit terms.
