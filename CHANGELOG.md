# Changelog

Notable changes are recorded here. Add the newest entry first and keep each item to one short line.

## Unreleased

### Added

- Added the managed `hallmark` anti-AI-slop design skill with narrow selection triggers and self-contained references.
- Added managed Google Stitch skills for prompt enhancement and local design-system extraction.
- Added regression coverage for non-overlapping design-skill selection triggers.

### Changed

- Added concise skill routing guidance to MCP instructions, `get_skill` responses, and local changing-tool descriptions.
- Hardened managed skill sync so every upstream file read or copy is realpath-contained and symlink-free.
- Expanded MCP and filesystem integration test deadlines for the larger live skill catalog.
- Made the upstream TTL cache test deterministic under full-suite load.
- Updated the managed Stitch skills to their latest pinned commit.
- Clarified when agents should use `frontend_design`, `enhance_prompt`, `stitch_extract_design_md`, `theme_factory`, and `web_artifacts_builder`.
- Updated managed Ponytail and Anthropic skill sources to their latest pinned commits.
