# HCU Multi-Account Device — Review Checklist

Use this checklist after each phase. A reviewer should be able to reject one phase without reopening unrelated phases.

## Phase 0 — Repo rename / runtime continuity
- [x] GitHub canonical repo is `Hiroshimeow/agent-mcp-device`.
- [x] Canonical local checkout is `<workspace>/agent-mcp-device`.
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
- [x] Every configured project is associated with an explicit `device_id`.
- [x] `project_list` requires/selects a device explicitly.
- [x] `project_inspect` requires `device_id` + `project_id`.
- [x] Wrong project/device pair fails, never reroutes.
- [x] `/home` or path-style hints may auto-select only when exactly one compatible owned online device exists.
- [x] Two compatible Linux devices cause ambiguity, not guessing.

## Phase 5 — Pure control plane
- [x] Gateway owns schemas/routing but not normal host filesystem/shell execution.
- [x] Host machine runs `agent-mcp-device` when it must be controlled.
- [x] Filesystem/shell/start-process calls require `device_id`.
- [x] Process follow-ups require only bound `session_id`.
- [x] No missing-`device_id` fallback to gateway host remains.
- [x] `image_preview` has an explicit remote-safe decision; no hidden local fallback.
- [x] Ownership checks cover every execution tool.

Evidence: isolated real-WebSocket disconnect/reconnect gate returns `DEVICE_OFFLINE` while disconnected and resumes after reconnect; `pure-control-plane-contract` finds no host execution path in the model-facing gateway; full gateway 287/287 plus three smokes PASS; full device 52/52 PASS; YOLO catalog remains 16 tools / 15,793 bytes. Live v2 cutover is intentionally Phase 8.

## Phase 6 — Tool/debt cleanup
- [x] `edit_file` exposes one contract only: path/old_text/new_text/expected_replacements/dry_run/device_id.
- [x] `edits[]`, `dryRun`, and dual-contract `anyOf` are gone from public schema.
- [x] No dead legacy edit implementation remains after internal consumers are migrated.
- [x] `device_id` remains on multi-device filesystem/shell/start-process tools.
- [x] Redundant `device_id` is absent from process follow-up tools.
- [x] `shell_execute` schema is measured before/after any trim.
- [x] Runtime-output reduction is not confused with schema reduction.
- [x] Strict MCP structured output validation still passes.
- [x] Skills remain on-demand; no skill bodies are preloaded.
- [x] Routine filesystem/shell calls are not forced through `get_skill`.

Evidence: exact baseline YOLO 15,793 bytes (`shell_execute` 1,928; `edit_file` 1,678), after cleanup YOLO 15,297 bytes (`shell_execute` 1,856; `edit_file` 1,254). Strict MCP SDK validation accepts all schema-bearing gateway output shapes tested and rejects malformed structured output. Gateway full suite 285/285 plus three smokes PASS; device full suite 52/52 PASS; implementation grep finds no legacy edit branch. Live v2 remains intentionally unchanged until Phase 8.

## Phase 7 — Usage / audit / dashboard
- [x] SQLite is authoritative for audit/usage metadata.
- [x] JSONL/NDJSON, if retained, are optional export/debug only.
- [x] Per-call metadata includes account/session/device/tool/duration/status/bytes without payload bodies.
- [x] Skill loads record name/success/bytes/estimated tokens.
- [x] Dashboard shows endpoint health, device status/version/last-seen, tool/schema counts, calls, failures, bytes, estimated context tokens, top tools, skills, errors, sessions.
- [x] Estimated token values are explicitly labeled estimates.
- [x] No claim of exact ChatGPT billing/context tokens is made.
- [x] `activity_session_id` is used for logical session aggregation; stateless HTTP is not mislabeled as a durable connection.
- [x] A normal account can rename/revoke only its own devices and end only its own sessions.
- [x] Admin management remains local CLI-only.
- [x] Mutating dashboard actions use POST/session/CSRF-safe semantics, not GET links.
- [x] Alice cannot see Bob's usage/dashboard metadata.

Evidence: same `gateway.sqlite` stores bounded per-call, skill-load, catalog/schema, activity-session, and device-status metadata; debug JSONL/NDJSON exports are off by default. OAuth activity IDs persist across refresh and end-session blocks access/refresh. Dashboard integration proves user-only access, Alice/Bob isolation, CSRF, POST-only mutation, own-device rename/revoke, immediate routing cutoff, and own-session termination. Device agent version survives gateway restart/reconnect. Secret payload sentinel is absent from SQLite. Full gateway suite 294/294 plus all three MCP smokes PASS; YOLO remains 16 tools / 15,297 bytes; token/context values are explicitly estimated with `utf8_bytes_div_4_estimate`. Live v2 remains intentionally unchanged until Phase 8.

## Phase 8 — Live migration
- [x] Old Linux v1 endpoint remains untouched.
- [x] ThinkBook v2 remains the development host until later g8 migration.
- [ ] Local admin is created only on host.
- [x] Invite can be generated without exposing server secrets.
- [x] User email/password are never invented by automation.
- [x] Signup/login exists before legacy shared-password OAuth is disabled.
- [ ] ThinkBook is eventually paired under a normal account.
- [ ] Old pre-account device record is revoked/cleaned.
- [ ] Access token expiry refreshes silently while refresh token remains valid.
- [x] hport/cloudflared health and device WSS health are audited separately.

Checkpoint evidence: gateway commit `82359b6` was the documented pre-cutover checkpoint and the account-aware build is now live on public port 8102; temporary canary 8103 has been removed. Runtime migration preserved 2 devices, 2 usage rows, and 4 OAuth clients in `gateway.sqlite`, while old tokens/pairings were deliberately excluded. Public login/signup/OAuth metadata/dashboard auth and the 16-tool / 15,297-byte / estimated 3,825-token schema are live. One unused invite exists only in runtime state. Both migrated device rows remain unowned and no normal account exists yet, so execution is intentionally fail-closed until the user creates an account and pairs a device. A cutover reconnect storm was independently traced to four stale `remote --help` processes starting real device runtimes; device commit `4bb56c4dc6b820b3227f101f99b2b85546de7bda` fixes the CLI behavior, full device regression is 52/52, rogue process count is zero, and reconnect counters stayed unchanged across repeated 10–15 second checks. v1 remains healthy. Remaining Phase 8 gates require user-chosen credentials, pairing, live account-scoped call/denial verification, refresh verification, and stale-device cleanup.

## Phase 9 — Final audit
- [x] Gateway full tests green.
- [x] Gateway MCP endpoint/schema/tools/upstream smokes green.
- [x] Device full tests/build green.
- [x] Package tarball smoke works from renamed repo.
- [x] No secrets/personal paths accidentally entered tracked source.
- [x] Legal attribution remains.
- [x] Dead compatibility/debt scan completed.
- [x] Over-engineering review completed; speculative abstractions removed.
- [x] Final tool count/schema bytes/schema token estimate recorded.
- [ ] Working trees intentionally clean or every dirty file explained.
- [ ] Remote SHAs match intended local commits after push.

Evidence: gateway `708fed3a75fdf6459768b467f2b8c33b62e0107a` verified 294/294 plus three MCP smokes. Device `05821fb766b256160a38855fb0648dc469aa821f` verified 52/52 plus build PASS. Real npm-pack lifecycle smoke: 727,759-byte / 244-file tarball, HCU help exit 0, no runtime start, zero legacy setup/install-telemetry/release/MCPB artifacts. Both repos scanned 0 tracked personal-path and 0 secret-like files. MIT/legal attribution remains. Debt review removed completed migration code, stale runtime aliases/defaults, package marketing/release/setup baggage, and inherited install telemetry; HCU remote mode also forces the Desktop Commander telemetry environment kill-switch in parent and child. No speculative HA/watcher infrastructure was added. Final stable model surface: 16 tools / 15,297 bytes / ~3,825 estimated tokens versus 16 / 16,225 / ~4,057 baseline.

## Explicit deferrals — reviewer must ensure they were NOT accidentally implemented
- [x] Email verification is deferred.
- [x] Email invite-request/accept/reject automation is deferred.
- [x] Password-reset email is deferred.
- [x] HA/failover implementation is deferred; no empty HA abstraction/placeholders were added.
- [x] GitHub Actions upstream watcher is deferred.
- [x] npm publication is deferred.
- [x] Linux g8 production cutover is deferred.
- [x] Private/per-account skill catalogs are deferred; all users share HCU/Superpowers skills.
