# Plan: External MCP Onboarding Presets and Trusted Roots Parity

Branch: `feat/external-mcp-upstreams`

Status: planned.

## 0. Problem

External MCP upstreams are now imported into the same gateway tool namespace as local `custom_*` tools, but onboarding still requires each MCP server to be configured manually with provider-specific command, args, platform command name, roots, cwd, timeout names, and auth shape.

This creates two product problems:

1. Trust-root parity is inconsistent. Local gateway tools read trusted roots from `REPO_ROOT`, `MCP_TRUSTED_ROOTS`, `MCP_TRUSTED_ROOTS_FILE`, and `config/trusted-roots.txt`, while external MCP servers only see roots that the user manually repeats in each server's args.
2. Simple external MCP onboarding is not possible. Users must know implementation details such as `npx.cmd` vs `npx`, positional roots for filesystem, `--allow-dir` for ripgrep, and `startup_timeout_ms` vs common `startup_timeout_sec` examples.

The expected product model is closer to Codex/Claude-style MCP config: user adds an MCP server in a small TOML block, and the gateway handles normalization, platform details, and trusted-root propagation where safe and applicable.

## 1. Goals

1. Keep the external MCP runtime generic: no provider-specific routing or safety filtering.
2. Add a config normalization layer for simple MCP onboarding.
3. Make trusted-root propagation consistent for external MCP presets that operate on local files.
4. Preserve explicit configuration as an escape hatch.
5. Support common MCP config examples with minimal edits.
6. Avoid forcing new users to read gateway internals to configure standard MCP servers.
7. Keep yolo execution philosophy unchanged: this is DX/config parity, not risk filtering.

## 2. Non-goals

Do not implement:

- gateway-side risk filtering for external MCP tools;
- provider-specific runtime behavior;
- LSP/codegraph runtime in gateway core;
- automatic installation beyond normal command execution such as `npx -y`;
- background discovery of random MCP servers;
- automatic auth/login flows;
- modifying third-party MCP packages.

## 3. Desired user config shape

The gateway should accept simple blocks like:

```toml
[mcp_servers.openaiDeveloperDocs]
url = "https://developers.openai.com/mcp"

[mcp_servers.cloudflare-api]
url = "https://mcp.cloudflare.com/mcp"

[mcp_servers.hf-mcp-server]
url = "https://huggingface.co/mcp?login"

[mcp_servers.context7]
url = "https://mcp.context7.com/mcp"

[mcp_servers.filesystem]
command = "npx.cmd"
args = ["-y", "@modelcontextprotocol/server-filesystem", 'C:\\Users\\admin', 'C:\\temp']
startup_timeout_sec = 30.0

[mcp_servers.eslint]
command = "npx.cmd"
args = ["-y", "@eslint/mcp"]
startup_timeout_sec = 30.0
```

And also support an easier preset form:

```toml
[mcp_servers.filesystem]
preset = "filesystem"
roots = "trusted"

[mcp_servers.ripgrep]
preset = "ripgrep"
roots = "trusted"

[mcp_servers.eslint]
preset = "eslint"
cwd = "${repoRoot}"

[mcp_servers.context7]
preset = "context7"
```

## 4. Config normalization requirements

### 4.1 Transport inference

If `url` is present and `transport` is omitted:

```toml
transport = "http"
```

If `command` is present and `transport` is omitted:

```toml
transport = "stdio"
```

Keep explicit `transport` authoritative.

### 4.2 Timeout aliases

Support both:

```toml
startup_timeout_ms = 30000
shutdown_timeout_ms = 5000
```

and common user-facing aliases:

```toml
startup_timeout_sec = 30.0
shutdown_timeout_sec = 5.0
```

Rules:

- `_ms` wins if both are present.
- `_sec` accepts positive finite numbers.
- Normalize internally to milliseconds.

### 4.3 Platform-aware executable normalization

Add optional runner shorthand:

```toml
runner = "npx"
```

Normalize to:

- Windows: `npx.cmd`
- non-Windows: `npx`

Do not rewrite explicit `command` unless a preset uses `runner` internally.

### 4.4 Tool prefix inference

If `tool_prefix` is omitted, infer from server id using current ID normalization rules.

Continue to reject reserved prefix `custom`.

### 4.5 Placeholder expansion

Support placeholders in preset fields and selected config strings:

- `${repoRoot}`
- `${home}`
- `${cwd}` where meaningful
- `${env:NAME}` only for non-secret path-like values

Do not expand secrets directly into TOML-derived auth values. Secrets remain env-referenced.

## 5. Trusted roots parity

### 5.1 Source of truth

Use the same trusted roots source as local tools:

- `REPO_ROOT`
- `MCP_TRUSTED_ROOTS`
- `MCP_TRUSTED_ROOTS_FILE`
- `config/trusted-roots.txt`

Do not invent a second root list for external MCP.

### 5.2 Preset root propagation

For file-system-oriented presets, support:

```toml
roots = "trusted"
```

or:

```toml
roots = ["${repoRoot}", "D:\\repo-a"]
```

For `roots = "trusted"`, expand to the full resolved trusted roots list.

### 5.3 Filesystem preset

Preset:

```toml
[mcp_servers.filesystem]
preset = "filesystem"
roots = "trusted"
```

Expands to:

```toml
transport = "stdio"
command = platform npx
args = ["-y", "@modelcontextprotocol/server-filesystem", ...trustedRoots]
tool_prefix = "filesystem" or inferred id
startup_timeout_ms = 30000
shutdown_timeout_ms = 5000
```

If user provides explicit `args`, do not append trusted roots silently unless they set:

```toml
inherit_trusted_roots = true
```

This avoids changing explicit expert configs unexpectedly.

### 5.4 Ripgrep preset

Preset:

```toml
[mcp_servers.rg]
preset = "ripgrep"
roots = "trusted"
```

Expands to:

```toml
transport = "stdio"
command = platform npx
args = [
  "-y",
  "@atef_andrus/mcp-ripgrep",
  "--allow-dir", root1,
  "--allow-dir", root2,
  "--max-result-chars", "80000",
  "--max-output-bytes", "20000000"
]
```

### 5.5 ESLint preset

Preset:

```toml
[mcp_servers.eslint]
preset = "eslint"
cwd = "${repoRoot}"
```

Expands to:

```toml
transport = "stdio"
command = platform npx
args = ["-y", "@eslint/mcp@latest"]
cwd = resolved repoRoot
```

Do not inject all trusted roots into ESLint; ESLint is project-root oriented.

### 5.6 HTTP docs/API presets

Context7 and simple HTTP MCP endpoints should not receive trusted roots.

Preset:

```toml
[mcp_servers.context7]
preset = "context7"
```

Expands to:

```toml
transport = "http"
url = "https://mcp.context7.com/mcp"
tool_prefix = "context7"
```

## 6. Auth and headers

Current `bearer_token_env` remains supported.

Add optional generic headers by env reference only:

```toml
[mcp_servers.some-http]
url = "https://example.com/mcp"

[mcp_servers.some-http.headers_env]
Authorization = "SOME_AUTH_HEADER"
X_API_Key = "SOME_API_KEY"
```

Rules:

- Values are env var names, not literal secret values.
- Diagnostics must show header names only, never env values.
- Reject literal-looking secret values in TOML where possible.

## 7. Explicit config compatibility

Existing explicit config must keep working:

```toml
[mcp_servers.filesystem]
transport = "stdio"
command = "npx.cmd"
args = ["-y", "@modelcontextprotocol/server-filesystem", 'C:\\Users\\admin', 'C:\\temp']
startup_timeout_ms = 30000
```

New aliases should make common examples work with fewer edits:

```toml
startup_timeout_sec = 30.0
```

and:

```toml
[mcp_servers.context7]
url = "https://mcp.context7.com/mcp"
```

## 8. Safety and trust model

This plan does not add risk filtering. External MCP remains trusted as configured.

Trusted-root parity here means local file scope consistency, not a safety classifier:

- local gateway tools and external filesystem/ripgrep presets should operate on the same trusted roots by default;
- HTTP docs/API MCPs do not receive local roots;
- expert explicit configs remain possible.

## 9. Implementation outline

1. Extend config loader input context so `normalizeExternalMcpConfig()` can access resolved trusted roots and repoRoot, or add a preprocessing step before normalization.
2. Add preset registry module, e.g. `scripts/upstreams/presets.mjs`.
3. Implement transport inference for `url`/`command`.
4. Implement timeout `_sec` aliases.
5. Implement platform-aware `runner = "npx"` helper.
6. Implement roots expansion for `roots = "trusted"` and arrays.
7. Implement presets: `filesystem`, `ripgrep`, `eslint`, `context7`.
8. Add optional `headers_env` support for HTTP clients if needed.
9. Update docs and `config/mcp-servers.example.toml`.
10. Add smoke/preset tests.

## 10. Tests

Add tests for:

1. `url` without `transport` infers HTTP.
2. `command` without `transport` infers stdio.
3. `startup_timeout_sec` normalizes to ms.
4. `runner = "npx"` resolves to `npx.cmd` on Windows and `npx` elsewhere.
5. `preset = "filesystem"`, `roots = "trusted"` expands all trusted roots into args.
6. `preset = "ripgrep"`, `roots = "trusted"` expands `--allow-dir` for each root.
7. `preset = "eslint"` defaults cwd to repoRoot.
8. `preset = "context7"` creates HTTP config without roots.
9. Explicit args are not silently mutated unless `inherit_trusted_roots = true`.
10. `tool_prefix = "custom"` remains rejected after preset expansion.
11. Diagnostics do not leak header env values.

## 11. Docs

Update README with two levels of config:

### Simple presets

```toml
[mcp_servers.filesystem]
preset = "filesystem"
roots = "trusted"

[mcp_servers.rg]
preset = "ripgrep"
roots = "trusted"

[mcp_servers.context7]
preset = "context7"
```

### Explicit expert config

```toml
[mcp_servers.filesystem]
transport = "stdio"
command = "npx.cmd"
args = ["-y", "@modelcontextprotocol/server-filesystem", 'C:\\Users\\admin']
```

Clearly state that local roots come from the same trusted-root mechanism as local tools when `roots = "trusted"` is used.

## 12. Validation

Run:

```bash
npm test
npm run smoke:mcp:tools
npm run smoke:mcp:upstreams
custom_review_diff
```

Add a manual example smoke where possible:

- filesystem preset lists allowed directories including all trusted roots;
- ripgrep preset searches inside a secondary trusted repo.

## 13. Acceptance criteria

- Existing explicit MCP configs keep working.
- Common URL-only MCP configs work without `transport = "http"`.
- Common `startup_timeout_sec` examples work.
- File-oriented presets can inherit all trusted roots without repeating them manually.
- New users can add filesystem/ripgrep/eslint/context7 without studying gateway internals.
- External MCP runtime remains generic and yolo; only config onboarding improves.
