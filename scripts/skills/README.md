# Canonical global/team skills

`scripts/skills/` is the gateway's only runtime source for global/team skills. One `SkillRegistry` scans this directory and serves both the standard MCP Skills extension and the two generic fallback tools.

Repository-specific guidance stays outside this registry: use root `AGENTS.md` and `.agents/skills/<name>/SKILL.md` in the repository that owns the instructions.

## Package format

A skill package is a directory:

```text
scripts/skills/<name>/
  SKILL.md
  references/...
  scripts/...
  assets/...
```

`SKILL.md` must be a regular file with YAML mapping frontmatter, a non-empty body, and these required fields:

```yaml
---
name: systematic-debugging
description: Use when a bug needs root-cause analysis before changing code.
---
```

The canonical name must match both `^[a-z0-9]+(?:-[a-z0-9]+)*$` and the directory basename. Runtime metadata is parsed from the actual resulting `SKILL.md`; source configuration never overrides it at runtime.

Every regular served file becomes a `skill://skills/<name>/...` resource with an exact-byte SHA-256 digest and size. Symlinks and path traversal are rejected. A package may contain at most 512 served resources and 16 MiB of static served bytes.

Supply-chain metadata, registry metadata, upstream-license storage, and temporary sync files are not served as skill package contents.

## Delivery paths

Modern MCP `2026-07-28` clients use `io.modelcontextprotocol/skills`:

- `skills/list` for stable metadata entries and complete manifests.
- `skills/get` for one current metadata entry by URI.
- normal `resources/read` for exact skill content.

Generic clients use only `skill_catalog` and `load_skill`. Both adapters read the same registry snapshot, revisions, and catalog version. There is no server-side skill classifier, priority system, bootstrap gate, prompt mirror, or background watcher.

Relevant entry points rescan/hash deterministically. Therefore add/edit/remove is visible on the next catalog/get/read call without restarting the server.

## Health

A valid empty directory is healthy. A missing, unreadable, or invalid root is degraded/error. The gateway never substitutes an embedded catalog when the configured root disappears. `/healthz` exposes only bounded skill status, count/version when healthy, or a stable error code when degraded.

## Managed upstream skills

`sources.json` is the reviewable source manifest. `sources.lock.json` records exact repositories, refs, commits, source paths, targets, compatibility patches, and license provenance. `sync-skills.mjs` fetches pinned upstream state, checks licenses and tree safety, copies selected skills, applies compatibility patches to the resulting package, validates the entire prepared catalog, replaces managed directories, removes stale managed skills, and writes the lock.

Current managed sources include Ponytail, ordinary Superpowers workflow skills, redistributable Anthropic skills, selected Stitch skills, and Hallmark. Non-redistributable packages remain excluded.

Compatibility changes belong in `sources.json`, not as hand-edits to managed output. Semantic changes such as a corrected name or description must be applied to the resulting `SKILL.md` during sync.

Run:

```bash
npm run skills:check
npm run skills:sync
npm test
```

After sync, review `git status --short`, `git diff --stat`, and `git diff`. Re-running sync against the same source commits must be idempotent.

## Adding a team skill

Add a valid `scripts/skills/<name>/SKILL.md` package. Do not add hard-coded runtime definitions, aliases, source-specific runtime URIs, or a second registry. The next relevant registry operation will discover it.
