# Changelog

Notable changes are recorded here. Add the newest entry first and keep each item to one short line.

## Unreleased

### Added

- Added deny-by-default remote device ACLs, bounded rate/size policy, caller-filtered inventory, and metadata-only device audit logging.
- Added durable Ed25519 device enrollment, challenge-response reconnect, SQLite identity persistence, restart recovery, and operator-only revocation.

- Added a DeviceBroker skeleton with authenticated `/device` WebSocket enrollment, in-memory device registry, connection epochs, stable `list_devices`, and request/response routing without automatic replay.
- Added bounded caller-owned process sessions with `start_process`, paged output reads, interactive stdin, termination, and completed-session retention.
- Added a durable MCP harness-efficiency design and task ledger to prevent duplicate optimization work across agents.
- Added the managed `hallmark` anti-AI-slop design skill with narrow selection triggers and self-contained references.
- Added managed Google Stitch skills for prompt enhancement and local design-system extraction.
- Added regression coverage for non-overlapping design-skill selection triggers.

### Changed

- Added bounded per-call `timeout_ms` to one-shot `shell_execute` while preserving the existing compact result contract.
- Added guarded `edit_file` exact-count semantics with bounded preview, atomic backend write, CRLF preservation, and legacy `edits[]` compatibility.
- Reconciled progressive-skill compatibility policy and removed obsolete managed-skill compatibility patches while leaving upstream version drift pinned.
- Made the `shell_execute` model-facing description independent of dynamic trusted-root values while preserving runtime enforcement metadata.
- Compacted `shell_execute` results to decision/recovery fields and emit original byte counts only for truncated streams.
- Changed skill bootstrap from a mandatory mutation gate to progressive disclosure; runtime permissions remain the enforcement boundary.
- Updated the MCP benchmark path for the compact shell-result contract while preserving exact spill validation.
- Added concise skill routing guidance to MCP instructions, `get_skill` responses, and local changing-tool descriptions.
- Hardened managed skill sync so every upstream file read or copy is realpath-contained and symlink-free.
- Expanded MCP and filesystem integration test deadlines for the larger live skill catalog.
- Made the upstream TTL cache test deterministic under full-suite load.
- Updated the managed Stitch skills to their latest pinned commit.
- Clarified when agents should use `frontend_design`, `enhance_prompt`, `stitch_extract_design_md`, `theme_factory`, and `web_artifacts_builder`.
- Updated managed Ponytail and Anthropic skill sources to their latest pinned commits.
