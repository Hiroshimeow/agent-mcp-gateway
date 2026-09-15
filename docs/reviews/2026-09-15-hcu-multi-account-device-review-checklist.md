# HCU Multi-Account Device — Review Checklist

Use this checklist after each phase. A reviewer should be able to reject one phase without reopening unrelated phases.

## Phase 0 — Repo rename / runtime continuity
- [x] GitHub canonical repo is `Hiroshimeow/agent-mcp-device`.
- [x] Canonical local checkout is `E:/git-project/agent-mcp-device`.
- [x] `origin` points to the renamed repo; `upstream` remains DesktopCommanderMCP.
- [x] Live Windows runner executes from `agent-mcp-device`, not the old repo.
- [x] Device reconnect is proven online after rename.
- [x] No new commits are made in stale `broker-mcp-gateway` checkout.

## Phase 1 — Device identity / metadata / HCU branding
- [x] New `device_id` format is `<hostname>-<random8>`, immutable after enrollment.
- [x] `device_name` is separate from `device_id` and can be friendly/renameable.
- [x] Device hello provides hostname/platform/arch/path_style/version/capabilities.
- [x] `list_devices` exposes those fields in bounded structured output.
- [x] Duplicate friendly names do not silently route.
- [x] HCU runtime paths/service names replace new DesktopCommander runtime branding.
- [x] Legacy Desktop Commander Remote transport is absent: no Supabase `RemoteChannel`, legacy authenticator/session path, offline updater, direct dependency, or legacy reconnect test; Desktop Commander remains only the local execution engine.
- [x] Legal/upstream attribution is preserved.
- [x] npm is NOT published in this phase.

## Phase 2 — P0 IDs / no fallback
- [x] Public project field is only `project_id`; no model-facing `projectId` remains.
- [x] `project_inspect` requires `project_id`.
- [x] Prompt/resource project variables use `project_id`.
- [x] Missing `project_id` fails closed instead of selecting default workspace.
- [x] Unknown `project_id` fails closed.
- [x] `default_project_id` is informational only, never an execution fallback.
- [x] Regression test proves omission cannot mutate/read the default project accidentally.

## Phase 3 — Accounts / invites / OAuth / ownership
- [x] Accounts are durable and use normalized email + salted scrypt password hash.
- [x] Invite codes are 8-char uppercase/unambiguous, hashed, single-use, revocable.
- [x] `need_invite=true` requires an invite; false allows normal signup.
- [x] No email verification is required in this phase.
- [x] Login UI does not reveal whether an email exists.
- [x] Login abuse control does not permit easy global victim-account lockout.
- [x] Admin is local CLI-only; no public admin login.
- [ ] The author uses a normal account for MCP usage.
- [x] OAuth access/refresh token human subject is `account_id`, not merely `client_id`.
- [x] `offline_access` remains supported.
- [x] Device approval binds `owner_account_id`.
- [x] `list_devices` returns only the caller account's devices.
- [x] Every remote dispatch rechecks caller-account vs device owner.
- [x] Static bearer cannot bypass tenant ownership accidentally.
- [x] Account revoke invalidates/blocks future access.
- [x] Alice knowing Bob's `device_id` is insufficient to call Bob's device.

## Phase 4 — Device/project association
- [ ] Every configured project is associated with an explicit `device_id`.
- [ ] `project_list` requires/selects a device explicitly.
- [ ] `project_inspect` requires `device_id` + `project_id`.
- [ ] Wrong project/device pair fails, never reroutes.
- [ ] `/home` or path-style hints may auto-select only when exactly one compatible owned online device exists.
- [ ] Two compatible Linux devices cause ambiguity, not guessing.

## Phase 5 — Pure control plane
- [ ] Gateway owns schemas/routing but not normal host filesystem/shell execution.
- [ ] Host machine runs `agent-mcp-device` when it must be controlled.
- [ ] Filesystem/shell/start-process calls require `device_id`.
- [ ] Process follow-ups require only bound `session_id`.
- [ ] No missing-`device_id` fallback to gateway host remains.
- [ ] `image_preview` has an explicit remote-safe decision; no hidden local fallback.
- [ ] Ownership checks cover every execution tool.

## Phase 6 — Tool/debt cleanup
- [ ] `edit_file` exposes one contract only: path/old_text/new_text/expected_replacements/dry_run/device_id.
- [ ] `edits[]`, `dryRun`, and dual-contract `anyOf` are gone from public schema.
- [ ] No dead legacy edit implementation remains after internal consumers are migrated.
- [ ] `device_id` remains on multi-device filesystem/shell/start-process tools.
- [ ] Redundant `device_id` is absent from process follow-up tools.
- [ ] `shell_execute` schema is measured before/after any trim.
- [ ] Runtime-output reduction is not confused with schema reduction.
- [ ] Strict MCP structured output validation still passes.
- [ ] Skills remain on-demand; no skill bodies are preloaded.
- [ ] Routine filesystem/shell calls are not forced through `get_skill`.

## Phase 7 — Usage / audit / dashboard
- [ ] SQLite is authoritative for audit/usage metadata.
- [ ] JSONL/NDJSON, if retained, are optional export/debug only.
- [ ] Per-call metadata includes account/session/device/tool/duration/status/bytes without payload bodies.
- [ ] Skill loads record name/success/bytes/estimated tokens.
- [ ] Dashboard shows endpoint health, device status/version/last-seen, tool/schema counts, calls, failures, bytes, estimated context tokens, top tools, skills, errors, sessions.
- [ ] Estimated token values are explicitly labeled estimates.
- [ ] No claim of exact ChatGPT billing/context tokens is made.
- [ ] `activity_session_id` is used for logical session aggregation; stateless HTTP is not mislabeled as a durable connection.
- [ ] A normal account can rename/revoke only its own devices and end only its own sessions.
- [ ] Admin management remains local CLI-only.
- [ ] Mutating dashboard actions use POST/session/CSRF-safe semantics, not GET links.
- [ ] Alice cannot see Bob's usage/dashboard metadata.

## Phase 8 — Live migration
- [ ] Old Linux v1 endpoint remains untouched.
- [ ] ThinkBook v2 remains the development host until later g8 migration.
- [ ] Local admin is created only on host.
- [ ] Invite can be generated without exposing server secrets.
- [ ] User email/password are never invented by automation.
- [ ] Signup/login exists before legacy shared-password OAuth is disabled.
- [ ] ThinkBook is eventually paired under a normal account.
- [ ] Old pre-account device record is revoked/cleaned.
- [ ] Access token expiry refreshes silently while refresh token remains valid.
- [ ] hport/cloudflared health and device WSS health are audited separately.

## Phase 9 — Final audit
- [ ] Gateway full tests green.
- [ ] Gateway MCP endpoint/schema/tools/upstream smokes green.
- [ ] Device full tests/build green.
- [ ] Package tarball smoke works from renamed repo.
- [ ] No secrets/personal paths accidentally entered tracked source.
- [ ] Legal attribution remains.
- [ ] Dead compatibility/debt scan completed.
- [ ] Over-engineering review completed; speculative abstractions removed.
- [ ] Final tool count/schema bytes/schema token estimate recorded.
- [ ] Working trees intentionally clean or every dirty file explained.
- [ ] Remote SHAs match intended local commits after push.

## Explicit deferrals — reviewer must ensure they were NOT accidentally implemented
- [ ] Email verification is deferred.
- [ ] Email invite-request/accept/reject automation is deferred.
- [ ] Password-reset email is deferred.
- [ ] HA/failover implementation is deferred; no empty HA abstraction/placeholders were added.
- [ ] GitHub Actions upstream watcher is deferred.
- [ ] npm publication is deferred.
- [ ] Linux g8 production cutover is deferred.
- [ ] Private/per-account skill catalogs are deferred; all users share HCU/Superpowers skills.
