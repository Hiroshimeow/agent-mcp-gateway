# Local Coding MCP Gateway

Authenticated MCP gateway for local coding workspaces. The canonical hosted deployment is https://device.hcu-lab.me, while the runtime remains host-configurable.

## Hosted quick start

Current production links:

- Dashboard: https://device.hcu-lab.me/dashboard
- Pair device: https://device.hcu-lab.me/pair
- Help / setup guide: https://device.hcu-lab.me/help

Install the current device package with:

```bash
npm install -g @hcu-lab.me/mcp-device
```

The hosted Quick start card derives the gateway origin and Dashboard/Pair/Help links from the current request so preview, staging, and custom deployments remain usable.

## MCP and skills

The gateway serves the official TypeScript MCP SDK v2 path and supports MCP `2026-07-28`. Modern clients discover reusable skills through the `io.modelcontextprotocol/skills` extension:

- `skills/list` returns metadata and resource manifests.
- `skills/get` returns one metadata snapshot by skill URI.
- `resources/read` returns the current skill resource bytes.

Generic MCP clients that do not implement the Skills extension have exactly two fallback tools:

- `skill_catalog` returns compact names, descriptions, URIs, revisions, and a catalog version.
- `load_skill` loads one skill body or one explicitly listed supporting resource.

Both paths use one canonical registry backed by `scripts/skills/`. Skill bodies are not duplicated into MCP prompts or resource listings, and the gateway does not route tasks to skills. Add, edit, or remove a valid skill package and the next relevant request sees the change without a server restart.

A valid skill lives at `scripts/skills/<name>/SKILL.md`. The directory basename and frontmatter `name` must match the portable lowercase-hyphen form. `name`, `description`, and all other runtime metadata come from the resulting YAML frontmatter in that file. The registry hashes exact served bytes, builds a complete resource manifest, and derives one revision from the complete package.

Repo-local instructions are separate from the global/team registry: use root `AGENTS.md` plus `.agents/skills/<name>/SKILL.md` for repository-specific guidance. Those files are not copied into `scripts/skills/`.

`/healthz` reports bounded skill status. A missing, unreadable, or invalid configured skill root is degraded; it is never represented as a healthy empty or built-in catalog.

## Managed skill sources

Upstream skills are reproducible through:

- `scripts/skills/sources.json` — reviewed source/configuration and compatibility patches.
- `scripts/skills/sources.lock.json` — exact source commits and provenance.
- `scripts/sync-skills.mjs` — fetch, license checks, compatibility patches, validation, replacement, stale managed-skill removal, and lock generation.

Supply-chain provenance is not stored inside served skill packages. If upstream semantic metadata must change for compatibility, the sync process patches the resulting `SKILL.md`; the runtime registry never overrides semantic metadata from provenance.

Run:

```bash
npm run skills:check
npm run skills:sync
```

Then review the generated diff. Managed updates preserve unmanaged team skills. See `scripts/skills/README.md` for source and validation details.

## Workspace and execution plane

`config/mcp-servers.toml` is the single configuration file for server metadata, trusted roots, optional upstreams, and tunnel settings.

Filesystem, shell/process, project, and device execution stay in the execution plane. `mcp-device` has no skill registry, skill routing, or Skills-extension behavior.

When a structured tool call contains an absolute path that implements the user's request, the gateway normalizes the path, updates the trusted-root configuration through the existing guarded workflow, reloads the workspace registry, and continues under the normal authorization policy. Invalid TOML keeps the last valid workspace configuration.

Optional upstream MCP servers are staged and reconciled transactionally. Codegraph and ripgrep remain ordinary CLI workflows; they are not imported into the skill subsystem.

Runtime profiles remain `safe`, `assisted`, and `yolo`. DeviceBroker uses the existing authenticated WebSocket device path and durable Ed25519 device identity. Usage/audit metadata remains authoritative in `gateway.sqlite`; JSONL/NDJSON exports are optional debug outputs.

## Development

Required validation after changes to the MCP or skill subsystem:

```bash
npm test
npm run skills:check
npm run skills:sync
npm test
npm run smoke:mcp-schemas
npm run smoke:mcp:tools
npm run smoke:mcp
npm run smoke:mcp:upstreams
```

Also run relevant OAuth/auth/device regression tests for transport or authentication changes, plus `git diff --check` and a final legacy-surface grep.

## Authentication and tunnel

OAuth remains the primary ChatGPT path. Optional static bearer authentication may coexist for local clients; it does not replace OAuth discovery.
