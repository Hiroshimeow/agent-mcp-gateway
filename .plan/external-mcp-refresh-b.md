# Plan B: Dynamic External MCP Catalog Refresh

Branch: `feat/external-mcp-upstreams`

Status: planned next implementation pass.

## 0. Decision

Implement full catalog cache behavior for Dynamic External MCP Upstreams:

- `catalog_cache = "startup"`: build once at gateway startup.
- `catalog_cache = "ttl"`: build at startup, then refresh atomically after TTL expires when catalog is requested.
- `catalog_cache = "none"`: refresh catalog on every catalog request.

The current product philosophy remains yolo. This plan must not add gateway-side risk filtering, safety classification, tool allowlists, shell blocklists, approval prompts, or provider-specific restrictions.

Risk and safety design remains deferred in `.plan/risk.md`.

## 1. Goals

1. Make `catalog_cache`, `catalog_cache_ttl_ms`, and runtime behavior match.
2. Keep the gateway as the only MCP server registered with ChatGPT.
3. Preserve dynamic upstream behavior for any provider: CodeGraph, GitNexus, Brave MCP, CodeMatrix, or future MCP servers.
4. Refresh tools, resources, resource templates, and prompts consistently.
5. Avoid corrupting the current working catalog when refresh fails.
6. Preserve route correctness: every exposed name must route to the correct upstream capability.
7. Keep yolo mode simple: import, prefix, preserve metadata, route.

## 2. Non-goals

Do not implement:

- gateway-side safe/assisted/yolo filtering for external MCP;
- descriptor-based risk inference;
- provider-specific tool rules;
- generic catch-all MCP call tool;
- background polling thread;
- ChatGPT host cache invalidation;
- host UI or confirmation behavior changes.

## 3. Config semantics

Existing TOML surface should become real behavior:

```toml
[external_mcp]
enabled = true
catalog_cache = "startup" # startup | ttl | none
catalog_cache_ttl_ms = 30000
startup_timeout_ms = 15000
shutdown_timeout_ms = 5000
```

Rules:

- `startup` ignores `catalog_cache_ttl_ms`.
- `ttl` requires a positive finite `catalog_cache_ttl_ms`.
- `none` ignores `catalog_cache_ttl_ms` and refreshes on each list request.
- All modes still connect/start enabled upstreams at gateway startup.
- Tool/resource/prompt calls use the latest committed catalog snapshot.
- If a call references a tool that existed in an older ChatGPT-visible catalog but has disappeared after refresh, return a clear unknown tool error.

## 4. Runtime model

### 4.1 Current state

Current manager builds one cache at startup:

- `cache.tools`
- `cache.toolRoutes`
- `cache.resources`
- `cache.resourceRoutes`
- `cache.resourceTemplates`
- `cache.prompts`
- `cache.promptRoutes`

List APIs read this snapshot.

### 4.2 Target state

Introduce an atomic catalog state object:

```js
catalogState = {
  snapshot,
  lastRefreshAt,
  refreshInFlight,
  lastRefreshError,
  generation
}
```

Each snapshot contains all list output and route maps:

```js
snapshot = {
  tools,
  toolRoutes,
  resources,
  resourceRoutes,
  resourceTemplates,
  prompts,
  promptRoutes,
  diagnostics,
  builtAt,
  generation
}
```

Refresh builds a complete candidate snapshot first. It validates collisions and route maps before replacing `catalogState.snapshot`.

If validation fails, keep the previous snapshot.

## 5. Refresh behavior

### 5.1 `startup`

- Build snapshot once during `createExternalMcpManager()`.
- List APIs return current snapshot without touching upstream list APIs.
- This preserves current behavior.

### 5.2 `ttl`

On every catalog list call:

- If `Date.now() - lastRefreshAt <= catalog_cache_ttl_ms`, return current snapshot.
- If expired and no refresh is running, refresh before returning.
- If expired and refresh is already running, await the same refresh promise.
- If refresh succeeds, return new snapshot.
- If refresh fails, return previous snapshot and expose the failure in diagnostics.

This avoids stampedes and route-map races.

### 5.3 `none`

On every catalog list call:

- Run refresh before returning.
- If refresh succeeds, return new snapshot.
- If refresh fails and an old snapshot exists, return old snapshot plus diagnostics error.
- If refresh fails and no old snapshot exists, return empty external catalog plus diagnostics error.

`none` still uses atomic replacement; it is not a per-upstream live passthrough.

## 6. APIs to refactor

Manager should expose async list methods:

```js
await manager.listAllToolsUnfiltered()
await manager.listToolsForProfile(profile) // compatibility alias, no filtering
await manager.listResources()
await manager.listResourceTemplates()
await manager.listPrompts()
```

Call/read/get methods remain async and route through the current committed snapshot:

```js
await manager.callTool(name, args)
await manager.readResource(uri)
await manager.getPrompt(name, args)
```

`listToolsForProfile(profile)` keeps the signature for wrapper compatibility but must not filter external tools.

## 7. Wrapper integration

`scripts/authenticated-mcp-wrapper.mjs` currently likely assumes synchronous list methods. Update MCP handlers to await external manager list methods.

Expected handler changes:

- `tools/list`: await external tools before merging local + external.
- `resources/list`: await external resources before merging local + external.
- `resources/templates/list`: await external templates.
- `prompts/list`: await external prompts.

No change to local tool behavior.

## 8. Catalog builder

Move startup catalog build logic into reusable function:

```js
async function buildExternalCatalog({ servers, clients, localToolNames, localPromptNames })
```

The builder must:

1. fetch upstream `tools/list`, `resources/list`, `resources/templates/list`, and `prompts/list`;
2. normalize exposed names using generic provider prefix logic;
3. preserve upstream descriptions, input schemas, annotations, and `_meta`;
4. add `_meta.upstream` provenance;
5. build reverse route maps;
6. reject collisions before committing the candidate;
7. include diagnostics for failed optional upstreams;
8. avoid provider-specific behavior.

## 9. Collision policy

Refresh candidate validation must reject collisions in the candidate snapshot:

- external tool vs local tool;
- external tool vs another external tool;
- external prompt vs local prompt;
- external prompt vs another external prompt;
- external resource URI vs another external resource URI.

On refresh collision:

- keep previous snapshot;
- set `lastRefreshError`;
- expose diagnostics;
- do not partially update route maps.

If collision happens during startup and `fail_gateway_on_startup_error = true`, gateway startup should fail. If false, gateway should continue with diagnostics and no corrupt routes.

## 10. Diagnostics

Diagnostics resources should include:

```json
{
  "configPath": "...",
  "cacheMode": "ttl",
  "catalogTtlMs": 30000,
  "generation": 3,
  "lastRefreshAt": "...",
  "lastRefreshError": null,
  "refreshInFlight": false,
  "servers": [...]
}
```

Per-server diagnostics should include latest known catalog counts and latest refresh error for that server where available.

Do not include bearer token values or full secret-bearing env data.

## 11. Shutdown timeout fix

Also implement the correctness fix from review:

- enforce per-upstream `shutdown_timeout_ms` in `manager.shutdown()`;
- `client.close()` reject should not reject manager shutdown;
- close that never resolves should not hang gateway shutdown;
- diagnostics/log message should not include secrets.

Preferred implementation:

```js
await Promise.race([
  client.close().catch(error => ({ error })),
  timeout(shutdownTimeoutMs)
])
```

If stdio transport exposes a process kill hook later, call it after timeout. Do not invent SDK APIs.

## 12. HTTP startup timeout check

Verify whether HTTP upstream connect currently respects `startup_timeout_ms`.

If missing, wrap HTTP connect with the same timeout behavior used for stdio.

Do not invent MCP SDK APIs; inspect installed SDK exports before coding.

## 13. Tests

Add or update tests:

### 13.1 Config

- `catalog_cache = "startup"` accepted.
- `catalog_cache = "ttl"` accepted with positive `catalog_cache_ttl_ms`.
- `catalog_cache = "none"` accepted.
- invalid catalog mode rejected.
- `ttl` with non-positive TTL rejected.

### 13.2 TTL refresh

Use fake upstream server whose catalog can change between list calls.

- Initial list returns tool A.
- Before TTL expires, list still returns A without upstream list call.
- After TTL expires, list returns A+B.
- route map calls B successfully after refresh.

### 13.3 None refresh

- Every list request calls upstream list.
- New tool appears on next list without restart.

### 13.4 Startup cache

- Startup mode does not refresh after upstream catalog changes.

### 13.5 Refresh failure atomicity

- Existing snapshot has tool A.
- Refresh candidate introduces collision or upstream list failure.
- List returns previous tool A.
- Diagnostics reports refresh failure.
- No partial route map is committed.

### 13.6 Tool disappearance

- Snapshot has tool A.
- Refresh removes A.
- `tools/list` no longer shows A.
- `tools/call` for A returns unknown external MCP tool.

### 13.7 Shutdown timeout

- Fake client close never resolves.
- `manager.shutdown()` resolves within configured timeout plus small buffer.
- Close reject is swallowed and recorded/logged without throwing.

### 13.8 Smoke

Update `scripts/smoke-mcp-upstreams.mjs` to keep startup behavior and optionally add a TTL subsection if it remains deterministic.

## 14. Docs

Update README:

- document `startup`, `ttl`, and `none` precisely;
- state that `startup` is recommended for stable ChatGPT sessions;
- state that ChatGPT/host may cache visible tool lists, so runtime refresh updates gateway catalog but host UI may require reconnect/relist;
- keep yolo wording: no extra gateway-side risk filtering for external MCP.

Update `config/mcp-servers.example.toml`:

```toml
catalog_cache = "startup"
# catalog_cache = "ttl"
# catalog_cache_ttl_ms = 30000
# catalog_cache = "none"
```

## 15. Validation commands

Run targeted tests while developing:

```bash
node --test tests/upstream-config.test.mjs
node --test tests/upstream-stdio.test.mjs
node --test tests/upstream-resource-uri.test.mjs
```

Final validation:

```bash
npm test
npm run smoke:mcp:upstreams
```

If smoke runner allowlist blocks `smoke:mcp:upstreams`, either update the allowlist or run it directly from shell and record the result.

## 16. Acceptance criteria

- `startup`, `ttl`, and `none` have real distinct behavior.
- Refresh is atomic and cannot corrupt route maps.
- External MCP remains yolo-only in runtime.
- No provider-specific code or tests depend on CodeGraph/GitNexus names except examples/smoke config.
- Shutdown timeout is enforced.
- Tests cover cache behavior and shutdown timeout.
- README and example TOML match implementation.
