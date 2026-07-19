# Local Coding MCP Gateway

Generic authenticated MCP gateway for local coding workspaces. Deployment and connector names belong to host configuration; the repository itself is machine-neutral.

## Core catalog

The local catalog contains exactly six tools:

- `read_text_file`
- `write_file`
- `edit_file`
- `shell_execute`
- `image_preview`
- `get_skill`

Use the official filesystem tools for file content. Use `shell_execute` for `rg`, Git, tests, builds, linters, package managers, archives, and process operations. Specialized Git/search/review/release MCP wrappers were removed rather than hidden behind another surface mode.

## Live skills

Copy a standard `<name>/SKILL.md` folder into `scripts/skills/`. The gateway discovers additions, edits, and removals without restart, emits prompt/resource list-changed notifications, and returns the current names, aliases, and descriptions through `get_skill()` as `skillCatalog`.

The first `read_text_file` or `image_preview` call for an authenticated caller adds one short skill advisory. Before that caller's first `write_file`, `edit_file`, or `shell_execute`, the gateway requires one successful `get_skill(...)` call. The first block explains what to do; repeated blocks use only `Call get_skill().` Successful skill loading unlocks project-changing tools for four hours by default (`MCP_SKILL_BOOTSTRAP_TTL_MS`). Read operations remain available so the agent can inspect context before choosing a workflow.

`SKILL.md` requires YAML frontmatter with `name` and a selection-quality `description`. Optional `user-invocable: false` hides it from MCP prompts; `disable-model-invocation: true` keeps explicit loading but removes it from automatic agent selection. Invalid changes keep the last valid catalog.

Upstream Ponytail, Superpowers, and redistributable Anthropic skills are tracked through `scripts/skills/sources.json`; exact commits are recorded in `sources.lock.json`. Use `npm run skills:check` to detect upstream movement and `npm run skills:sync` to fetch, validate, and stage the current manifest. The sync process preserves unmanaged local skills and enforces license, symlink, file-size, and font-file checks. Anthropic's proprietary document skills are intentionally excluded.

The loader and updater use Node filesystem/path APIs and repository-relative paths, so the same layout works on Linux and Windows. Deploying loader code requires one gateway restart; subsequent skill additions, edits, removals, and managed skill syncs do not. See `scripts/skills/README.md` for the update workflow and license policy.

## Live workspace roots

`config/mcp-servers.toml` is the single configuration file for server metadata, trusted roots, optional upstreams, and tunnel settings.

When a structured tool call contains an absolute path that implements the user's request, the gateway:

1. normalizes the path and derives the smallest directory root;
2. appends it to `[trusted_roots].roots` with a lock and atomic replace;
3. reloads one in-memory workspace registry;
4. sends `notifications/roots/list_changed` to the official filesystem server;
5. waits until the exact root set is active;
6. continues the original tool call without restart or a second approval prompt.

Manual valid edits to the TOML file hot-reload. Invalid TOML keeps the last valid runtime state. Roots remain configured until explicitly removed.

`[trusted_roots].roots` is the only authorization source. `MCP_TRUSTED_ROOTS`, `MCP_IMAGE_PREVIEW_ROOTS`, and implicit home folders do not grant access. Migrate any legacy environment root into the TOML array. `image_preview`, filesystem operations, shell working directories, resources, and project discovery all consume the same live root set and canonical path policy. Lock files contain owner metadata; dead owners or locks older than the conservative 10-minute stale threshold are recoverable.

## Optional upstreams

Context7, DeepWiki, Exa, and ESLint are configured with `enabled = false` by default. Changing one to `enabled = true` stages the candidate client and catalog, then atomically commits and emits list-changed notifications without restarting the gateway. Disabling or replacing a server is also transactional: if candidate startup or catalog discovery fails, the previous clients, routes, statuses, and generation remain active.

Codegraph and ripgrep are CLI workflows, not MCP upstreams. The `local_coding` skill uses Codegraph only when the executable and an existing `.codegraph` index are present; otherwise it falls back to `rg` and `read_text_file`.

## Shell result

`shell_execute` returns structured JSON containing the command, requested/resolved working directory, exit code, stdout, stderr, stderr classification, duration, timeout state, truncation metadata, original byte counts, returned byte counts, and UTF-8 encoding. Exit code `1` from `rg` means no matches, not a gateway failure.

Runtime profiles remain `safe`, `assisted`, and `yolo`. `safe` hides mutating filesystem tools and shell; `assisted` permits file writes but hides shell; `yolo` exposes all six core tools.

## Development

```bash
npm test
npm run skills:check
npm run smoke:mcp-schemas
npm run smoke:mcp:tools
npm run smoke:mcp:upstreams
```

Useful checks:

```bash
node --check scripts/authenticated-mcp-wrapper.mjs
node --check scripts/workspace-registry.mjs
node --check scripts/upstreams/manager.mjs
git diff --check
```

## Authentication and tunnel

OAuth remains the primary ChatGPT path. Optional static bearer authentication may coexist for local clients; it does not replace OAuth discovery.

`uv run main.py --repo <repo>` starts the local endpoint at `http://127.0.0.1:8101/mcp`. The optional tunnel is configured in `[openai_tunnel]`; credentials remain in the tunnel profile/environment, not this repository.
