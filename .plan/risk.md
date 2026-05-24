# External MCP risk model notes

## Current runtime decision

External MCP upstreams are yolo dynamic proxy capabilities.

Runtime behavior:

- load enabled upstream MCP servers from TOML;
- import their tools, resources, and prompts;
- prefix exposed tool and prompt names;
- preserve upstream annotations and metadata when present;
- add `_meta.upstream` for provenance and reverse routing;
- route calls and reads back to the owning upstream.

Runtime intentionally does not add:

- extra profile filtering for imported upstream tools;
- fallback classification for imported upstream tools;
- descriptor heuristics;
- provider-specific allow or deny rules;
- metadata rewriting;
- a generic catch-all MCP call tool.

## Why this is the current design

The project default operating mode is yolo. External MCP is meant to be flexible: the user should be able to add arbitrary upstream MCP providers such as CodeGraph, GitNexus, or future providers without changing gateway code.

A heuristic classifier created practical problems:

- provider tools without complete annotations were hidden even when they were useful read/query tools;
- code-intelligence verbs differ across providers;
- a generic classifier can create false positives and false negatives;
- hardcoding provider-specific names would undermine the dynamic upstream goal;
- gateway-side inference makes behavior harder to predict when the upstream already owns its tool semantics.

Therefore the current runtime should stay simple: import, prefix, preserve metadata, route.

## Future options to decide later

Possible controls, if desired later:

1. Diagnostics-only report
   - Analyze descriptors and annotations but do not affect runtime exposure.
   - Surface a report under diagnostics resources.

2. Explicit TOML policy
   - Per-upstream include/exclude by exposed tool name or upstream tool name.
   - User-controlled, no heuristic guessing.

3. User-managed overrides
   - Local config that marks exact upstream tools as visible or hidden.
   - Keyed by upstream id plus upstream tool name.

4. Upstream annotation passthrough only
   - Trust upstream annotations as metadata.
   - Do not infer missing annotations.

5. Separate opt-in mode
   - Keep yolo as current default.
   - Add a stricter mode later only if explicitly needed.

## Non-goals

- Do not hardcode CodeGraph, GitNexus, or any provider-specific rules.
- Do not rewrite metadata to make an upstream tool look different from what it reported.
- Do not add a generic `custom_mcp_call` catch-all tool.
- Do not silently overwrite local or external name collisions.

## Host/platform boundary

Host-level behavior is outside the gateway. The gateway should not claim to control host UI or platform policy. Runtime code should not contain extra operational caveats for external MCP; notes belong here until a final model is chosen.

## Hot refresh Plan B note

The planned catalog refresh work in `.plan/external-mcp-refresh-b.md` must preserve the current yolo runtime philosophy.

Refresh modes (`startup`, `ttl`, `none`) are cache freshness controls only. They must not become risk controls. They must not introduce:

- gateway-side risk filtering;
- gateway-side safety classification;
- provider-specific allow or deny rules;
- hidden metadata rewriting;
- tool execution prompts;
- shell command blocklists for external MCP.

If an upstream publishes a new tool during refresh, yolo runtime exposes it after the refreshed snapshot is committed, subject only to name-collision correctness. Any future safety model must be designed separately and explicitly.
