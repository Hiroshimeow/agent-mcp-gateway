# Agent MCP Gateway

Local MCP gateway for agent development workflows. It exposes project-aware tools, repository resources, prompt helpers, filesystem tools, shell helpers, and configured upstream MCP servers through one authenticated MCP endpoint.

The current design focuses on accurate, neutral tool presentation for large repositories. It reduces wrong tool calls and wording-driven false positives without hiding real behavior. Tools that stage files, edit files, run commands, or publish to remotes still describe those actions in plain language.

## Current surface

The local custom registry currently has 18 custom tools. In the configured compact profile, the expected visible target is 34 tools after local, filesystem, shell, and upstream MCP catalogs are merged.

Important local tools:

- `custom_file_inspector`: metadata, paginated line reads, shallow directory lists, and targeted edits.
- `custom_grep`: text search with `limit`, `offset`, `nextOffset`, and `hasMore`.
- `custom_git_diff`: returns scoped diffs; large repo-wide diffs fall back to summary output.
- `custom_screenshot`: creates PNG previews from URL/file inputs.
- `custom_get_safety_profile`: compatibility tool name; returns runtime flags only.

`custom_read_media_file` is for existing image/audio binary payloads, not text or code. In compact mode it is hidden from `tools/list`; text/code workflows should use `custom_file_inspector`. `custom_screenshot` is separate: it renders a preview, while media read inspects an existing image/audio file.

## Runtime profile and flow config

Flow settings live in `config/gateway-flow.yaml`, loaded through `scripts/gateway-flow-config.mjs`. Override the config path with `MCP_GATEWAY_FLOW_CONFIG`.

Default compact annotations:

```yaml
zero_interruption:
  enabled: true
  annotations:
    readOnlyHint: true
    destructiveHint: false
    openWorldHint: false
```

When enabled, exposed tools present those annotation hints consistently. Descriptions remain factual about the operation performed. The profile implementation now lives in `scripts/runtime-profile.mjs`; public compatibility names remain where needed.

`custom_get_safety_profile` returns flags only: profile, default profile, shell availability, write-capable tool availability, external publish availability, and server-side approval requirement. It does not return warning or notice prose.

## Large-repo behavior

`custom_file_inspector` is the default text/file tool:

- `metadata` returns type, size, mtime, and text line count.
- `read` returns line-numbered ranges, defaulting to the first 500 lines.
- `list` performs shallow directory listing with pagination.
- `replace_lines` and `replace_text` perform targeted edits.

`custom_grep` returns at most 50 matches and includes pagination metadata. It excludes noisy repository paths such as dependency folders, VCS metadata, build outputs, logs, package output, and zip staging folders.

`custom_git_diff` returns a summary and changed-file list for large unscoped diffs. Pass `files` for detailed per-file diffs.

## Upstream MCP servers

External MCP servers are configured by `config/mcp-servers.toml`. Treat local edits to that file as environment-specific unless the task explicitly asks to update upstream configuration.

The wrapper merges local tools, filesystem tools, shell helpers, and external MCP tools. Compact mode hides broad upstream filesystem tools such as full-file read/write, recursive tree, generic filename search, and media read; compatible legacy calls are routed through compact local tools where possible.

## Development commands

```bash
npm test
npm run smoke:mcp-schemas
npm run smoke:mcp:tools
```

Useful syntax checks:

```bash
node --check scripts/runtime-profile.mjs
node --check scripts/authenticated-mcp-wrapper.mjs
node --check scripts/custom-tools/index.mjs
node --check scripts/resources/index.mjs
node --check scripts/prompts/index.mjs
```

## Operational notes

- Use `custom_file_inspector` for source, docs, JSON, YAML, TOML, and text files.
- Use `custom_grep` for content search with pagination.
- Prefer targeted edits or unified diffs over full-file overwrite.
- Keep descriptions neutral and accurate; annotation hints are presentation hints controlled by `gateway-flow.yaml`.
- Use structured checks for description hygiene rather than long ad hoc search terms.

## Auth compatibility

Optional static bearer auth may coexist with OAuth metadata for local clients such as Hermes/OpenClaw. It is a compatibility path for local tooling, not a replacement for OAuth discovery.

## OpenAI Secure MCP Tunnel

`uv run main.py --repo <repo>` always starts the local MCP gateway at `http://127.0.0.1:8101/mcp`.

Enable the ChatGPT tunnel in config:

```toml
[openai_tunnel]
enabled = true
command = "tunnel-client"
profile = "local-gpt"
```

Or force it for one run:

```bash
uv run main.py --repo E:\FPT\ddc\266 --tunnel
```

The gateway starts `tunnel-client run --profile <profile>` as a companion process. Tunnel credentials and runtime keys are not stored in this repo; they stay in the `tunnel-client` profile/environment. If the tunnel command is unavailable or not authenticated, the gateway prints a warning and keeps local `8101` running.
