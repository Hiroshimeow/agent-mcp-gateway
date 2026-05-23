# Plan: Dynamic external MCP upstreams

## Goal

Let `agent-mcp-gateway` run as the single MCP endpoint on port 8101 while dynamically loading additional user-declared MCP servers such as CodeGraph, GitNexus, or any compatible local MCP server.

Users should only need to add an upstream block to a gateway config file. The repo must not hardcode individual CodeGraph/GitNexus tools.

Example TOML target:

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

## Product stance

- This is explicit user configuration, not auto-discovery.
- Every enabled server in the configured `mcp_servers` table should be started/connected at gateway startup.
- Default gateway profile remains `yolo`.
- Yolo still does not bypass ChatGPT host safety, Developer Mode confirmation UI, user confirmations, or platform policy.
- Dynamic upstream tools must preserve or derive honest metadata. Do not hide risk by putting everything behind one generic catch-all tool.

## Config format decision

Preferred format: TOML.

Rationale:

- Good for hand-edited config.
- Supports comments.
- Maps naturally to `[mcp_servers.<id>]` tables.
- Less ambiguous than YAML.

Recommended config path order:

1. `MCP_UPSTREAM_CONFIG` if set.
2. `config/mcp-servers.toml` if present.
3. `.mcp-gateway/mcp-servers.toml` if present.
4. No upstreams if no config is found.

Commit `config/mcp-servers.example.toml` only. Real local config may be ignored depending on final repo convention.

## Supported upstream transports

Phase 1: `stdio` only.

Phase 2: `http` / streamable HTTP MCP endpoint with optional bearer token referenced by env var.

Stdio schema:

```toml
[mcp_servers.codegraph]
enabled = true
transport = "stdio"
command = "codegraph"
args = ["serve", "--mcp"]
cwd = "."
startup_timeout_ms = 15000
tool_prefix = "codegraph"
```

HTTP schema:

```toml
[mcp_servers.gitnexus]
enabled = true
transport = "http"
url = "http://127.0.0.1:8123/mcp"
bearer_token_env = "GITNEXUS_MCP_TOKEN"
tool_prefix = "gitnexus"
startup_timeout_ms = 15000
```

## Naming and routing

Server id validation:

- lowercase only
- regex: `^[a-z0-9][a-z0-9_-]{0,63}$`

Dynamic tool names:

```text
upstream tool: find_references
server id:     codegraph
exposed name:  custom_codegraph_find_references
```

If upstream tool names contain invalid identifier characters, normalize to lowercase snake case and keep a routing map:

```js
custom_codegraph_find_references -> { upstreamId: 'codegraph', upstreamToolName: 'find-references' }
```

Collision policy:

- No collisions allowed after prefixing and normalization.
- Startup should fail loudly or mark the specific upstream unavailable with a diagnostic resource.
- Do not silently overwrite tools.

## Capability proxying

### Tools

Startup:

1. Load config.
2. Start/connect every enabled upstream.
3. Initialize MCP client.
4. Call upstream `tools/list`.
5. Prefix and normalize tool names.
6. Preserve upstream `description`, `inputSchema`, `annotations`, and `_meta` where safe.
7. Add gateway `_meta.upstream` fields: `upstreamId`, `upstreamToolName`, `transport`, `source: external-mcp`.
8. Apply risk normalization/fallback.
9. Apply safety profile filtering.
10. Cache catalog.

Call-time:

1. Check gateway profile visibility again.
2. Look up route by exposed name.
3. Forward `tools/call` to upstream MCP client.
4. Return upstream result without lossy transformation.
5. Convert upstream errors to structured MCP errors with upstream id/name context.

### Resources

Expose upstream resources with a URI namespace to avoid collisions:

```text
external-mcp://codegraph/<encoded-upstream-uri>
```

Implement:

- `resources/list`
- `resources/templates/list`
- `resources/read`

### Prompts

Expose dynamic prompts with prefix:

```text
external_codegraph_review_symbol
```

Recommendation: `external_<serverId>_<promptName>` for prompts, `custom_<serverId>_<toolName>` for tools.

## Risk and safety profile behavior

Do not trust upstream metadata blindly when it is missing or obviously incomplete.

Rules:

- Preserve upstream `annotations` if provided.
- If missing, classify by name/description heuristics using a new external risk classifier.
- Unknown external tools should be conservative unless clearly read-only.
- Read-only external tools can be exposed in `safe` only if `readOnlyHint:true`, `destructiveHint:false`, and `openWorldHint:false`.
- `assisted` may expose mutating non-open-world tools, matching current gateway profile semantics.
- `yolo` exposes all enabled upstream tools subject to honest metadata.

Suggested risk metadata additions:

```js
_meta: {
  source: 'external-mcp',
  upstreamId: 'codegraph',
  upstreamToolName: 'find_references',
  riskLevel: 'low' | 'medium' | 'high' | 'critical' | 'unknown'
}
```

## Lifecycle and resilience

Process management for stdio upstreams:

- Spawn on gateway startup.
- Use `windowsHide: true`.
- Resolve `cwd` relative to gateway repo root or configured trusted root.
- Apply startup timeout.
- Capture diagnostics without printing secret env values.
- If an upstream fails to start, gateway should continue by default, expose a diagnostic resource, and omit failed upstream tools.
- On gateway shutdown, terminate child processes.

Optional config:

```toml
fail_gateway_on_startup_error = false
restart = "never" # future: never | on_failure
```

## Catalog cache

Add `scripts/upstreams/catalog-cache.mjs`.

Requirements:

- Cache merged local + external catalog.
- Invalidate on profile change, upstream restart, or manual refresh.
- Avoid calling upstream `tools/list` on every gateway `tools/list` request.
- Build once at startup for phase 1.

## Files/modules to add

```text
scripts/upstreams/config.mjs
scripts/upstreams/stdio-client.mjs
scripts/upstreams/http-client.mjs
scripts/upstreams/manager.mjs
scripts/upstreams/names.mjs
scripts/upstreams/catalog-cache.mjs
scripts/upstreams/risk.mjs
config/mcp-servers.example.toml
```

Modify:

```text
scripts/authenticated-mcp-wrapper.mjs
scripts/tool-risk.mjs
scripts/resources/index.mjs
scripts/prompts/index.mjs
package.json
README.md
SECURITY.md
.env.example
```

## Tests

Unit tests:

```text
tests/upstream-config.test.mjs
tests/upstream-names.test.mjs
tests/upstream-risk.test.mjs
```

Integration tests with fake MCP upstream:

```text
tests/upstream-stdio.test.mjs
```

Runtime smoke:

```text
scripts/smoke-mcp-upstreams.mjs
```

Assertions:

- Starts gateway with fixture upstream config.
- `tools/list` includes `custom_fake_read_context`.
- `safe` hides fake mutating/open-world tool.
- `tools/call custom_fake_read_context` succeeds.
- `tools/call` for hidden fake tool fails at call-time.
- Resource proxy read succeeds.
- Prompt proxy get succeeds.
- Gateway still starts if optional upstream fails when fail-fast is false.

Package script:

```json
"smoke:mcp:upstreams": "node scripts/smoke-mcp-upstreams.mjs"
```

## Docs

README additions:

- Explain dynamic upstream MCP servers.
- Show CodeGraph config example.
- Show GitNexus config example.
- Clarify that configured/enabled upstreams are intentionally started by gateway.
- Explain namespace prefixing.
- Explain safety profile filtering of upstream tools.
- Explain real config vs example config.

SECURITY additions:

- Configured upstream commands run with local user permissions.
- This is intended yolo local automation behavior.
- Do not add upstream configs you do not intend to execute.
- Secrets should be referenced by env var, not literal config values.

## Implementation phases

### Phase 1: Config + stdio upstream tools

- Add TOML parser.
- Add config loader.
- Add stdio MCP client manager using installed SDK APIs.
- Prefix upstream tools.
- Merge with existing local tools.
- Preserve metadata and apply fallback risk.
- Add call-time routing.
- Add unit and integration tests.

### Phase 2: Resources and prompts

- Proxy upstream resources/list/read/templates with URI namespace.
- Proxy upstream prompts/list/get with name prefix.
- Add tests and runtime smoke.

### Phase 3: HTTP upstreams

- Add streamable HTTP MCP client transport.
- Support bearer token by env var.
- Add tests.

### Phase 4: Caching and diagnostics

- Cache startup catalogs.
- Add diagnostic resources for upstream status.
- Add optional refresh tool if real-world use requires it.
- Add latency tests for `tools/list`.

### Phase 5: Docs and release readiness

- Update README/SECURITY/.env.example.
- Add config example.
- Run full validation.
- Run release review with local secrets and dependency folders excluded where appropriate.

## Acceptance criteria

- A user can add CodeGraph to config and see `custom_codegraph_*` tools without code changes.
- A user can add GitNexus to config and see `custom_gitnexus_*` tools without code changes.
- Gateway exposes one MCP endpoint to ChatGPT.
- Runtime `tools/list` contains local and upstream tools with honest annotations.
- Safe/assisted/yolo profile behavior applies to upstream tools at list time and call time.
- No generic catch-all MCP call tool is required.
- Windows and Linux both pass unit tests and runtime smoke.
- POSIX shell remains non-login `-c`.
