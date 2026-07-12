# Hot-reload and managed skills

The gateway loads skills from this directory on every catalog/read operation. Adding, editing, or removing a valid skill does not require an MCP server restart.

## Add a local skill

Use either layout:

- `scripts/skills/<skill-name>/SKILL.md` (recommended; supports scripts and references beside the skill)
- `scripts/skills/<skill-name>.md`

Minimal format:

```markdown
---
name: systematic-debugging
description: Use when a bug needs root-cause analysis before changing code.
aliases: [debug, root-cause]
user-invocable: true
disable-model-invocation: false
---

# Systematic Debugging

Reproduce, isolate, fix, and verify.
```

Required metadata:

- `name`: stable skill identifier; hyphens and spaces normalize to underscores internally.
- `description`: selection criteria exposed to the agent in the live `skillCatalog`.

Optional metadata:

- `aliases`: comma-separated, inline-list, or YAML-list aliases.
- `title`: display title; defaults to the first H1.
- `prompt` / `promptName`: MCP prompt name.
- `uri`: custom MCP resource URI.
- `arguments` / `args`: prompt argument names.
- `user-invocable: false`: omit the skill from MCP prompts.
- `disable-model-invocation: true`: omit the skill from automatic agent selection while preserving explicit `get_skill(name)` loading.

If a new or edited file is invalid, the gateway logs the error and keeps the last valid catalog. The loader and updater use Node filesystem/path APIs, so the same layout works on Linux and Windows.

## Managed upstream skills

`sources.json` is the reviewable source manifest. It contains explicit repositories, branches, included skill folders, compatibility metadata, license requirements, and documented exclusions. `sources.lock.json` records the exact upstream commits currently vendored.

Current managed sources:

- `DietrichGebert/ponytail` — MIT
- `obra/superpowers` — MIT
- redistributable Apache-2.0 skills from `anthropics/skills`

Anthropic's proprietary `docx`, `pdf`, `pptx`, and `xlsx` skills are not vendored because their license prohibits redistribution. `doc-coauthoring` is excluded because its folder does not declare a redistributable license. `canvas-design` is excluded because it includes bundled font files.

Each managed skill contains `.skill-source.json` with its repository, upstream path, commit, license, and any local compatibility metadata. Upstream license and notice files are retained in `_upstream_licenses/` and, where supplied, inside each skill folder.

## Check and apply updates

Check whether any tracked branch has moved:

```bash
npm run skills:check
```

Exit code `0` means the lock is current. Exit code `1` means at least one upstream commit changed.

Fetch, validate, and apply the current manifest:

```bash
npm run skills:sync
npm test
```

Then review before committing:

```bash
git diff --stat
git diff -- scripts/skills/sources.lock.json
git diff -- scripts/skills/<changed-skill>
```

The updater clones into a temporary directory, checks licenses, rejects symlinks, large files, and font files, validates the complete prepared catalog, and only then swaps managed folders. It never deletes unmanaged local skills and refuses to overwrite an unmanaged folder with the same name.

Updating skill files takes effect through hot reload. Restart the MCP server only when the loader or updater code itself changes.

## Add or change a managed source

1. Edit `sources.json`; never edit `sources.lock.json` manually.
2. Use explicit `include` entries rather than importing an entire repository implicitly.
3. Record license requirements and exclusions in the manifest.
4. Add compatibility aliases/URIs under `overrides` only when an existing MCP contract must remain stable.
5. Run `npm run skills:sync`, `npm test`, and review the resulting diff.
