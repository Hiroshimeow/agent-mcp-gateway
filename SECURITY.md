# SECURITY

This launcher exposes local MCP tools to a public tunnel behind OAuth, with an optional static Bearer token for clients that cannot complete OAuth.

Use it only while actively developing.

Stop the stack when done.

## Important Warnings

- Demo OAuth with a password gate is better than `No Auth`, but it is still not production-grade security.
- Optional static Bearer auth (`MCP_BEARER_TOKEN`) gives non-OAuth clients access to the same tools as OAuth clients.
- Static Bearer token auth is a shared secret. Anyone with the token can call `/mcp` until you rotate it.
- Public `ngrok` means anyone with the URL can try to reach the MCP endpoint.
- This project is for temporary development use, not production exposure.

## Safe REPO_ROOT Rules

Do not set `REPO_ROOT` to:

- `C:\`
- `E:\`
- `C:\Users\admin`
- Desktop, Downloads, or any broad folder that may contain secrets

Use a specific project folder only.

## Filesystem Scope

- Filesystem access is intentionally limited to `REPO_ROOT`.
- Do not widen that scope to an entire drive.
- Treat write access as real write access. ChatGPT can create and edit files inside the allowed directory.

## Shell Risk

Shell hiện bật mặc định theo profile `yolo`.

When enabled, the launcher does not apply a shell safety policy after auth.

- repo-only working directory intent stays at `REPO_ROOT`
- authenticated agent commands run in full-trust mode
- no launcher-side approval prompt for `git push`, `git reset --hard`, deletes, or download-and-exec commands

This is not a sandbox.

Enable shell only if you explicitly accept full command execution risk after auth.

Before enabling shell or write-heavy workflows:

- use a dedicated git branch
- run `git status`
- review `git diff`
- keep backups

## Secrets

- Do not hardcode secrets in `.bat`, `.ps1`, `.mjs`, or JSON config files.
- Do not print secrets to console.
- Do not commit `.env`.
- Keep `XAI_API_KEY` only in environment variables or `.env`.
- Keep `MCP_AUTH_PASSWORD` only in `.env`.
- Keep `MCP_BEARER_TOKEN` only in `.env`; rotate it if it is shared with another client or machine.
- Use a long random `MCP_BEARER_TOKEN` when enabling Hermes/OpenClaw-style Bearer auth.
- Rotate `MCP_BEARER_TOKEN` after sharing logs, screenshots, client configs, or tunnel URLs that may expose it.
