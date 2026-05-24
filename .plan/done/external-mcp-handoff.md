# Handoff Plan: Dynamic External MCP Upstreams

Branch: `feat/external-mcp-upstreams`

Feature name: **Dynamic External MCP Upstreams**

## 0. Executive summary

Implement a dynamic MCP upstream aggregator inside `agent-mcp-gateway`.

The gateway remains the single MCP server exposed to ChatGPT, normally on port `8101`. At startup, it reads a user-maintained TOML config, starts or connects to every enabled upstream MCP server, imports their tools/resources/prompts dynamically, prefixes them to avoid collisions, preserves or derives honest metadata, applies the existing `safe` / `assisted` / `yolo` profile behavior at both list-time and call-time, and routes calls back to the correct upstream server.

This feature must not hardcode CodeGraph, GitNexus, or any specific upstream tool. CodeGraph/GitNexus should only appear as examples and smoke/integration fixtures where useful.

Current product stance:

- Default profile remains `yolo`.
- External MCP upstreams are also `yolo` by default: enabled upstreams are intentionally started and proxied unless disabled in config.
- Yolo means no extra gateway-side approval prompts, no gateway-side shell blocklists, no executable allowlist restrictions, and broad local dev automation.
- Yolo does not bypass ChatGPT host safety, ChatGPT Developer Mode confirmation UI, user confirmations, or platform policy.
- Do not fake metadata to reduce confirmations. Preserve metadata where possible and classify fallback risk honestly.

## 1. User-facing target behavior

A user adds this to gateway config:

```toml
[mcp_servers.codegraph]
enabled = true
transport = "stdio"
command = "codegraph"
args = ["serve", "--mcp"]

[mcp_servers.gitnexus]
enabled = true
transport = "stdio"
command = "npx"
args = ["-y", "gitnexus@latest", "mcp"]
```

Then starts gateway normally:

```bash
npm start
```

The gateway automatically:

1. starts CodeGraph and GitNexus MCP servers,
2. initializes them as upstream MCP clients,
3. imports their catalog,
4. exposes dynamic tools such as:

```text
custom_codegraph_find_references
custom_codegraph_search_symbols
custom_gitnexus_repo_summary
custom_gitnexus_analyze_commit
```

5. exposes upstream resources as namespaced resources:

```text
external-mcp://codegraph/<encoded-upstream-uri>
external-mcp://gitnexus/<encoded-upstream-uri>
```

6. exposes upstream prompts with namespaced names:

```text
external_codegraph_review_symbol
external_gitnexus_explain_history
```

No code changes are required when adding a new compatible MCP server.

## 2. Non-goals

Do not implement a single generic catch-all tool like:

```text
custom_mcp_call({ server, tool, args })
```

Reason: that destroys per-tool metadata, increases confirmation friction, and makes safety profile filtering less accurate.

Do not scan arbitrary repo files to auto-discover MCP servers. Only load explicit gateway config paths.

Do not add hardcoded CodeGraph/GitNexus tool descriptors.

Do not claim the gateway can disable ChatGPT host confirmations or policy checks.

## 3. Config format and paths

### 3.1 Format

Use TOML for the primary config format.

Recommended dependency: `smol-toml` unless repo maintainers prefer another small TOML parser.

Reasons:

- good for hand-edited local config,
- comments are supported,
- `[mcp_servers.<id>]` maps naturally to upstream server blocks,
- less surprising than YAML.

### 3.2 Config path resolution

Load the first existing config path in this order:

1. `MCP_UPSTREAM_CONFIG` absolute or repo-relative path if set.
2. `config/mcp-servers.toml`.
3. `.mcp-gateway/mcp-servers.toml`.
4. no upstreams if none exists.

Add and commit only:

```text
config/mcp-servers.example.toml
```

Decision for real config ignore:

- Add `.mcp-gateway/` to `.gitignore` if it is intended as local config.
- Do not ignore `config/mcp-servers.toml` unless project owner wants it local-only.

### 3.3 Root schema

```toml
[external_mcp]
enabled = true
fail_gateway_on_startup_error = false
catalog_cache = "startup" # startup | ttl | none, phase 1 implements startup
catalog_cache_ttl_ms = 30000
startup_timeout_ms = 15000
shutdown_timeout_ms = 5000

default_transport = "stdio"
default_enabled = true

[mcp_servers.codegraph]
enabled = true
transport = "stdio"
command = "codegraph"
args = ["serve", "--mcp"]
cwd = "."
tool_prefix = "codegraph"
startup_timeout_ms = 15000

[mcp_servers.gitnexus]
enabled = true
transport = "stdio"
command = "npx"
args = ["-y", "gitnexus@latest", "mcp"]
tool_prefix = "gitnexus"
```

### 3.4 HTTP schema, phase 2

```toml
[mcp_servers.remote_graph]
enabled = true
transport = "http"
url = "http://127.0.0.1:8123/mcp"
bearer_token_env = "REMOTE_GRAPH_MCP_TOKEN"
tool_prefix = "remote_graph"
startup_timeout_ms = 15000
```

Policy:

- Support `bearer_token_env`.
- Do not support literal `bearer_token` initially, to avoid accidental secret commits.
- If literal token support is later required, add explicit docs and secret scan tests.

## 4. Server id, prefixing, and normalization

### 4.1 Server id validation

Valid `mcp_servers.<id>`:

```regex
^[a-z0-9][a-z0-9_-]{0,63}$
```

Reject ids with uppercase, spaces, slash, dot-dot, path separators, or empty names.

### 4.2 Tool prefix

Default `tool_prefix` is server id.

Validate `tool_prefix` with the same id regex.

Exposed tool format:

```text
custom_<toolPrefix>_<normalizedToolName>
```

Example:

```text
find-references      -> custom_codegraph_find_references
repo.summary         -> custom_gitnexus_repo_summary
search/symbols       -> custom_codegraph_search_symbols
```

### 4.3 Prompt prefix

Exposed prompt format:

```text
external_<toolPrefix>_<normalizedPromptName>
```

### 4.4 Resource namespace

Use:

```text
external-mcp://<serverId>/<base64url-encoded-upstream-uri>
```

Base64url avoids ambiguity with slashes, query strings, fragments, and non-file URIs.

Each listed proxy resource should include `_meta.upstream`:

```js
{
  upstreamId,
  upstreamUri,
  source: 'external-mcp'
}
```

### 4.5 Collision rules

Do not silently overwrite.

Collisions to detect:

- dynamic external tool vs local gateway tool,
- dynamic external tool vs another upstream dynamic tool,
- prompt name collisions,
- resource URI wrapper collisions.

Phase 1 behavior:

- Mark the specific upstream as unavailable if it collides.
- Keep gateway running if `fail_gateway_on_startup_error=false`.
- Expose diagnostic resource for the upstream.
- If fail-fast is true, startup fails.

## 5. Modules to add

```text
scripts/upstreams/config.mjs
scripts/upstreams/names.mjs
scripts/upstreams/stdio-client.mjs
scripts/upstreams/http-client.mjs
scripts/upstreams/manager.mjs
scripts/upstreams/catalog-cache.mjs
scripts/upstreams/risk.mjs
scripts/upstreams/resource-uri.mjs
scripts/upstreams/diagnostics.mjs
```

### 5.1 `config.mjs`

Responsibilities:

- locate config path,
- parse TOML,
- validate schema,
- apply defaults,
- resolve `cwd` cross-platform,
- return normalized config object,
- never read `.env` secrets except by env var name references.

Export:

```js
export function findExternalMcpConfigPath(env, repoRoot) {}
export async function loadExternalMcpConfig({ env, repoRoot }) {}
export function normalizeExternalMcpConfig(raw, { configPath, repoRoot, env }) {}
```

### 5.2 `names.mjs`

Responsibilities:

- validate server ids,
- normalize upstream tool/prompt names,
- build exposed names,
- maintain reverse route keys,
- detect collisions.

Export:

```js
export function validateUpstreamId(id) {}
export function normalizeCapabilityName(name) {}
export function toExternalToolName(serverPrefix, upstreamToolName) {}
export function toExternalPromptName(serverPrefix, upstreamPromptName) {}
```

### 5.3 `stdio-client.mjs`

Use installed `@modelcontextprotocol/sdk` APIs. Verify exact import paths before coding.

Likely implementation uses SDK `Client` and `StdioClientTransport`.

Responsibilities:

- spawn stdio upstream,
- initialize client,
- list tools/resources/prompts,
- forward tool calls,
- forward resource reads,
- forward prompt gets,
- terminate process on shutdown.

Windows requirements:

- use `windowsHide: true`,
- pass `command` and `args` as argv, not a shell string,
- do not use POSIX-only quoting,
- support `cwd` with spaces.

### 5.4 `http-client.mjs`, phase 2

Use streamable HTTP transport from SDK. Verify exact API names.

Responsibilities:

- connect to `url`,
- pass bearer auth from `bearer_token_env`,
- initialize,
- implement same interface as stdio client.

### 5.5 `manager.mjs`

Responsibilities:

- own all upstream clients,
- start all enabled upstreams,
- build dynamic catalogs,
- expose route maps,
- route calls/reads/prompts,
- aggregate diagnostics,
- shutdown clients.

Export:

```js
export async function createExternalMcpManager(options) {}
```

Suggested manager interface:

```js
manager.listAllToolsUnfiltered()
manager.listToolsForProfile(profile)
manager.hasTool(name)
manager.callTool(name, args, context)
manager.listResources()
manager.listResourceTemplates()
manager.readResource(uri)
manager.listPrompts()
manager.getPrompt(name, args)
manager.getDiagnostics()
manager.shutdown()
```

### 5.6 `catalog-cache.mjs`

Phase 1:

- build once at startup,
- store unfiltered dynamic catalog,
- profile filtering is cheap and runs on cached catalog.

Phase 2:

- TTL or manual refresh if needed.

### 5.7 `risk.mjs`

Responsibilities:

- preserve upstream annotations if present,
- classify missing/incomplete annotations conservatively,
- integrate with existing `scripts/tool-risk.mjs`.

Heuristic suggestions:

Read-only candidates:

```text
read, get, list, search, find, inspect, analyze, status, diff, symbols, references, callgraph
```

Mutating/open-world candidates:

```text
write, edit, patch, delete, remove, move, rename, execute, run, shell, command, push, publish, deploy, network, fetch, install
```

Rules:

- If upstream provides all four MCP hints, preserve them.
- If unknown, do not mark read-only.
- Unknown external tool in `safe` should be hidden unless clearly read-only.
- `yolo` exposes unknown external tool but metadata must indicate risk unknown/open-world as appropriate.

## 6. Wrapper integration

Modify `scripts/authenticated-mcp-wrapper.mjs`.

Startup order:

1. resolve repo roots and project registry,
2. create local filesystem client,
3. create external MCP manager,
4. build local + external unfiltered catalog,
5. register MCP handlers.

Tools:

```js
async function listAllMergedToolsUnfiltered() {
  return [
    ...localTools,
    ...externalManager.listAllToolsUnfiltered()
  ].map(applyToolRiskOrExternalRisk);
}

async function listMergedTools() {
  return listAllMergedToolsUnfiltered().filter(tool => shouldExposeToolForProfile(tool, safetyProfile));
}
```

Call routing order:

1. local custom tools,
2. shell/platform tools,
3. external manager tools,
4. upstream filesystem tools.

Before every route, enforce profile visibility:

```js
assertToolAllowedForProfile(toolName, safetyProfile)
```

For external tools, enforcement must use the external risk metadata associated with the route.

Resources:

- merge local repo resources with `externalManager.listResources()`.
- `readResource` routes `external-mcp://...` to external manager, otherwise local repo resource handler.

Prompts:

- merge local repo prompts with `externalManager.listPrompts()`.
- route prefixed prompt names to external manager.

Shutdown:

- on process exit/SIGINT/SIGTERM, call `externalManager.shutdown()`.

## 7. Safety profile behavior

Current profiles:

- `safe`: read-only, non-destructive, non-open-world only.
- `assisted`: local mutating/preview tools allowed; raw shell and open-world hidden.
- `yolo`: broad local automation, no gateway-side approval prompts or blocklists.

External MCP defaults:

- `external_mcp.enabled=true` unless omitted config means no upstreams.
- Each `mcp_servers.<id>.enabled` defaults to `true`.
- In `yolo`, enabled upstreams are started and dynamic tools are exposed subject to honest metadata.
- In `safe`/`assisted`, upstreams may still start, but exposed catalog is filtered. This avoids profile changes requiring process restarts.

Optional future setting:

```toml
[mcp_servers.codegraph]
profiles = ["yolo", "assisted", "safe"]
```

Do not implement unless needed in phase 1.

## 8. Diagnostics and lifecycle

Add diagnostic resources:

```text
external-mcp://_diagnostics/status
external-mcp://codegraph/status
external-mcp://gitnexus/status
```

Status payload:

```json
{
  "enabled": true,
  "available": true,
  "transport": "stdio",
  "startedAt": "...",
  "toolCount": 12,
  "resourceCount": 5,
  "promptCount": 2,
  "lastError": null
}
```

Startup failure policy:

- Default: gateway keeps running, upstream unavailable.
- If `[external_mcp].fail_gateway_on_startup_error=true`, fail startup.

Logging:

- log upstream id, transport, availability, counts,
- never print bearer token values,
- truncate child stderr diagnostics.

Shutdown:

- terminate stdio child process,
- wait `shutdown_timeout_ms`,
- force kill if necessary.

## 9. Test plan

### 9.1 Unit tests

Add:

```text
tests/upstream-config.test.mjs
tests/upstream-names.test.mjs
tests/upstream-risk.test.mjs
tests/upstream-resource-uri.test.mjs
```

Coverage:

- TOML parse examples,
- missing config returns disabled/no upstreams,
- id validation,
- disabled upstream ignored,
- enabled defaults true,
- cwd resolves correctly on Windows/Linux style paths,
- invalid transport rejected,
- HTTP bearer token env lookup,
- tool/prompt name normalization,
- collision detection,
- resource URI encode/decode,
- risk preservation/fallback,
- safe/assisted/yolo filter expectations.

### 9.2 Fake upstream MCP server

Add:

```text
tests/fixtures/fake-mcp-server.mjs
```

It should support:

- initialize,
- tools/list,
- tools/call,
- resources/list,
- resources/templates/list,
- resources/read,
- prompts/list,
- prompts/get.

Fake tools:

```text
read_context: readOnlyHint true
write_context: destructiveHint true
push_context: openWorldHint true
unknown_context: no annotations
```

### 9.3 Integration tests

Add:

```text
tests/upstream-stdio.test.mjs
```

Coverage:

- manager starts fake stdio server,
- imports dynamic tools,
- prefixes tools,
- routes `tools/call`,
- routes resources,
- routes prompts,
- profile filters list-time,
- profile rejects call-time for hidden tools,
- failed optional upstream produces diagnostic but does not crash,
- shutdown terminates child.

### 9.4 Runtime smoke

Add:

```text
scripts/smoke-mcp-upstreams.mjs
```

Package script:

```json
"smoke:mcp:upstreams": "node scripts/smoke-mcp-upstreams.mjs"
```

Runtime smoke should:

1. create temp TOML config with fake stdio upstream,
2. start gateway on random port with `MCP_UPSTREAM_CONFIG` pointing to temp config,
3. initialize MCP,
4. call `tools/list`,
5. assert `custom_fake_read_context` exists,
6. assert yolo exposes all fake tools honestly,
7. assert safe hides `custom_fake_write_context`, `custom_fake_push_context`, and unknown unsafe tools,
8. assert safe call-time rejects hidden tools,
9. read `external-mcp://fake/...` resource,
10. get external prompt,
11. assert diagnostics resource includes fake upstream.

### 9.5 Existing validation must still pass

```bash
npm test
npm run smoke:mcp:tools
npm run smoke:mcp:upstreams
```

If HTTP phase is implemented:

```bash
npm run smoke:mcp:http-upstreams
```

## 10. Documentation updates

README:

- add “Dynamic External MCP Upstreams” section,
- include CodeGraph and GitNexus TOML examples,
- describe prefixing,
- describe resources/prompts namespace,
- explain `safe`/`assisted`/`yolo` filtering,
- explain that enabled upstream commands are intentionally started by gateway,
- explain that real local config may be ignored while example config is committed.

SECURITY:

- configured upstream commands run with local user permissions,
- this is intended in yolo local automation,
- do not add upstream configs you do not intend to execute,
- use env vars for secrets,
- upstream metadata is preserved but gateway fallback classification is conservative,
- ChatGPT/platform safety is separate.

`.env.example`:

```env
# Optional dynamic external MCP upstream config.
# If unset, gateway checks config/mcp-servers.toml then .mcp-gateway/mcp-servers.toml.
MCP_UPSTREAM_CONFIG=

# External MCP is yolo by default when configured. Safety profile still filters exposed tools.
MCP_EXTERNAL_MCP_ENABLED=true
```

`config/mcp-servers.example.toml`:

- include CodeGraph example,
- include GitNexus example,
- include HTTP example commented out.

## 11. Windows/Linux compatibility checklist

Windows:

- stdio command spawn must not use shell quoting,
- `npx` may need `npx.cmd` resolution if Node spawn cannot resolve it; test this or document using `npx.cmd` on Windows,
- `cwd` with spaces must work,
- process termination must handle Windows child processes,
- paths in config should support forward slashes and native separators.

Linux/macOS:

- no regression to POSIX shell execution: keep non-login `-c`, not `-lc`,
- stdio upstream child env should inherit process env by default,
- shutdown should not leave orphan processes.

Tests should not depend on CodeGraph/GitNexus being installed. Use fake upstream fixtures.

## 12. Suggested implementation sequence for next agent

1. Read current code:
   - `scripts/authenticated-mcp-wrapper.mjs`
   - `scripts/tool-risk.mjs`
   - `scripts/resources/index.mjs`
   - `scripts/prompts/index.mjs`
   - `scripts/safety-profile.mjs`
   - `scripts/smoke-mcp-tools.mjs`
2. Add TOML dependency and config example.
3. Implement `scripts/upstreams/names.mjs` with tests.
4. Implement `scripts/upstreams/config.mjs` with tests.
5. Implement fake upstream MCP fixture.
6. Implement stdio upstream client/manager.
7. Proxy external tools and add list-time/call-time safety enforcement.
8. Add catalog cache.
9. Add external resources and prompts proxying.
10. Add diagnostics resources.
11. Add runtime smoke.
12. Update README/SECURITY/.env.example.
13. Run:

```bash
npm test
npm run smoke:mcp:tools
npm run smoke:mcp:upstreams
```

14. Run release review and secret scan.
15. Commit only code, tests, docs, examples. Do not commit local real upstream config or secrets.

## 13. Acceptance criteria

- User can add CodeGraph TOML block and see `custom_codegraph_*` tools after gateway restart without code changes.
- User can add GitNexus TOML block and see `custom_gitnexus_*` tools after gateway restart without code changes.
- Gateway remains the only MCP server registered with ChatGPT.
- Runtime `tools/list` includes local and external tools with honest annotations.
- `safe`, `assisted`, and `yolo` behavior applies to external tools at list-time and call-time.
- External resources are available under `external-mcp://<serverId>/...`.
- External prompts are available as `external_<serverId>_<prompt>`.
- Catalog is cached and does not call upstream `tools/list` on every client `tools/list` request.
- Failed optional upstreams do not crash gateway by default and have diagnostics.
- Windows and Linux tests pass.
- Existing yolo shell behavior and POSIX non-login `-c` behavior remain unchanged.
