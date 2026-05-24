# SECURITY

This launcher exposes local MCP tools on `127.0.0.1` behind OAuth, with an optional static Bearer token for clients that cannot complete OAuth.

Use it only while actively developing.

Stop the stack when done.

## Important Warnings

- Demo OAuth with a password gate is better than `No Auth`, but it is still not production-grade security.
- Optional static Bearer auth (`MCP_BEARER_TOKEN`) gives non-OAuth clients access to the same tools as OAuth clients.
- Static Bearer token auth is a shared secret. Anyone with the token can call `/mcp` until you rotate it.
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

Shell hiện bật mặc định theo `MCP_SAFETY_PROFILE=yolo` cho private local-dev; nếu không set `ENABLE_SHELL`, wrapper xử lý như `ENABLE_SHELL=true`.

When enabled in `yolo`, the launcher does not apply a shell safety policy after auth.

- repo-only working directory intent stays at `REPO_ROOT`
- authenticated agent commands run in full-trust mode
- no launcher-side approval prompt for `git push`, `git reset --hard`, deletes, or download-and-exec commands
- no gateway-side shell blocklists or executable allowlist restrictions

This is not a sandbox. It also does not disable ChatGPT host safety, ChatGPT Developer Mode confirmation UI, user confirmations, or platform policy.

Enable shell only if you explicitly accept full command execution risk after auth.

Before enabling shell or write-heavy workflows:

- use a dedicated git branch
- run `git status`
- review `git diff`
- keep backups

## Secrets

- Do not hardcode secrets in `.bat`, `.ps1`, `.mjs`, TOML, or JSON config files.
- Do not print secrets to console.
- `uv run main.py` must not print tokens loaded from `.env`, environment variables, or `--token`; it may print only a generated temporary token when no token is configured.
- Do not commit `.env`.
- Do not commit `config/trusted-roots.txt`; keep real trusted roots local and commit only `config/trusted-roots.example.txt`.
- Do not commit real external MCP upstream configs; commit only `config/mcp-servers.example.toml`.
- HTTP upstream bearer credentials must use `bearer_token_env`; keep token values in environment variables or `.env`.
- Keep `XAI_API_KEY` only in environment variables or `.env`.
- Keep `MCP_AUTH_PASSWORD` only in `.env`.
- Keep `MCP_BEARER_TOKEN` only in `.env`; rotate it if it is shared with another client or machine.
- Use a long random `MCP_BEARER_TOKEN` when enabling Hermes/OpenClaw-style Bearer auth.
- Rotate `MCP_BEARER_TOKEN` after sharing logs, screenshots, client configs, or tunnel URLs that may expose it.

## Dynamic External MCP Upstreams

Configured upstream MCP servers are started or connected at gateway startup and imported into the gateway catalog. Optional upstream startup failures are reported through diagnostics resources unless `fail_gateway_on_startup_error = true`.

External upstream tools are yolo by default when configured, but `safe`, `assisted`, and `yolo` profile filtering is enforced at both list-time and call-time. Complete upstream annotations are preserved; missing or incomplete annotations are classified conservatively rather than downgraded to avoid confirmations.

Treat any enabled upstream process as trusted local development automation with the permissions of the gateway process.

## Agent Tool Safety

The expanded local tool set includes git, patching, zip packaging, deterministic review, tests, and secret scanning wrappers.

- Every new path-taking tool validates paths against trusted roots.
- `custom_delete_file` refuses trusted-root deletion and `.git` deletion.
- `custom_secret_scan` redacts suspected secrets; it must never print full secret values.
- `custom_zip_create` excludes `node_modules/`, `logs/`, `packages/`, `_zip_temp/`, and `.git/` by default. `.git/` is included only when `includeGit=true`; generated `packages/` artifacts are local release outputs and should not be committed.
- `custom_run_tests` only allows safe project test commands. Use `custom_shell_execute` explicitly for arbitrary commands.
- `custom_review_diff` is deterministic and rule-based. It is useful as a pre-commit signal, not as a complete human security review.
- `custom_get_safety_profile` reports the active gateway profile and reminds callers that host/platform confirmations are separate from gateway behavior.
- Native MCP Resources provide read-only project context such as summaries, README, package metadata, tree snapshots, git status, safety profile, and tool manifests.
- Native MCP Prompts guide review, security audit, release readiness, PR description, feature planning, and fix-with-tests workflows.
- `custom_release_review` is a readiness gate. Treat warnings and blockers seriously before publishing, pushing, or zipping release artifacts.
