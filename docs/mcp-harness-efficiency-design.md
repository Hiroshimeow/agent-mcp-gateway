# MCP Harness Efficiency Design

Status: **living architecture baseline**  
Owner surface: `agent-mcp-gateway`  
Established: 2026-09-09

This document is the durable design source for future MCP gateway efficiency work. Agents should read this before adding core tools, changing model-facing schemas, changing skill loading, or introducing deferred external tools.

## 1. Goal

Keep the gateway capable enough for serious local coding while minimizing model-visible schema size, repeated instructions, tool-result tokens, unnecessary round trips, and prompt/KV-cache churn.

The objective is **effective task completion per model token**, not the smallest possible tool count.

## 2. Current baseline

The `yolo` profile intentionally exposes six eager core tools:

1. `read_text_file`
2. `write_file`
3. `edit_file`
4. `shell_execute`
5. `image_preview`
6. `get_skill`

This is a balanced profile. Do not add wrappers such as `git_status`, `search_files`, `run_tests`, or `list_directory` merely for convenience when `shell_execute` plus the existing filesystem tools already cover the workflow.

The current overlap between shell and filesystem operations is intentional. The routing rule is semantic:

- file content read/write/edit -> dedicated filesystem tools;
- Git, search, tests, builds, package managers, processes, and general terminal work -> `shell_execute`;
- local image inspection -> `image_preview`;
- reusable workflow guidance -> `get_skill`.

## 3. Reference harness lessons

These are design influences, not compatibility requirements.

### DeepSeek Harness

Public `sdk-minimal` demonstrates that a useful coding harness can expose only a persistent shell plus `str_replace_editor`; the full harness adds dedicated filesystem/search capabilities when product ergonomics need them. DeepSeek documentation explicitly discusses token effect and KV-cache effect, and its filesystem tools cap/read-window model-facing results.

References:
- https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/bundle/sdk-minimal/README.md
- https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/fs/tool-fs/README.md
- https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/fs/README.md
- https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/shell/tool-bash/README.md

Lesson: **separate runtime capability from the amount of data shown to the model; stable, bounded surfaces matter more than extreme tool minimization.**

### Qwen Code

Qwen strongly prefers dedicated file/search tools over recreating them through shell. It truncates large tool outputs and supports deferred tool discovery, but preloads deferred schemas when their estimated footprint fits a configurable context-window threshold (default 10%). Its docs explicitly warn that tool search can be undesirable for models that benefit heavily from stable prompt-prefix KV caching.

References:
- https://github.com/QwenLM/qwen-code/blob/main/packages/core/src/core/prompts.ts
- https://github.com/QwenLM/qwen-code/blob/main/docs/users/configuration/settings.md
- https://github.com/QwenLM/qwen-code/blob/main/docs/developers/tools/file-system.md

Lesson: **keep a small useful core eager; defer only when catalog size justifies the discovery cost.**

### Codex CLI

Codex is deliberately shell-heavy for discovery (`rg`, `rg --files`) while keeping a specialized patch/edit primitive. Current public code also defers MCP tools behind `tool_search` when available rather than injecting every external schema into the initial tool set.

References:
- https://github.com/openai/codex/blob/main/codex-rs/core/gpt_5_2_prompt.md
- https://github.com/openai/codex/blob/main/codex-rs/features/src/lib.rs
- https://github.com/openai/codex/blob/main/codex-rs/core/src/tools/handlers/tool_search_spec.rs

Lesson: **general execution plus a few semantically strong primitives scales well; large optional catalogs should be discoverable rather than always visible.**

## 4. Architecture principles

### P1. Stable model-facing schemas

Tool names, descriptions, and schemas should not change merely because runtime state changes. Trusted roots, grants, current workspace details, auth state, and telemetry belong to runtime policy/metadata, not prose embedded in tool descriptions.

Why:
- avoids repeatedly changing model-visible prefixes;
- improves cacheability;
- avoids large dynamic root lists in every tool catalog;
- keeps authorization truth in the enforcement layer rather than advisory prose.

### P2. Runtime policy is not model context

The runtime owns:
- trusted-root enforcement;
- auth/session identity;
- safety profile;
- spill files;
- detailed byte accounting;
- telemetry and diagnostics.

The model normally needs only the result required to decide the next action.

### P3. Bounded, recoverable outputs

Every potentially large read/search/shell output must have:

`bounded preview + explicit truncation signal + recoverable pointer/window`

Never silently truncate. Never dump arbitrarily large output merely because it is available.

### P4. No redundant echo

Do not return input arguments or diagnostic counters to the model by default when the model already supplied them and they do not affect the next decision.

Examples normally unsuitable for model-facing shell responses:
- full echoed command;
- requested cwd repeated back unchanged;
- command/request/path byte counters;
- head/tail byte counters;
- encoding when it is a fixed contract.

Keep these in internal telemetry if operationally useful.

### P5. Small core stays eager

The six core tools are small enough to remain eagerly advertised. Do not add `tool_search` just to discover these six tools.

Deferred loading is for optional/external catalogs whose schema cost is material relative to context size.

### P6. Progressive disclosure, not ritual calls

Skills should be loaded when they materially change the work. A skill mechanism should not exist merely to force a round trip.

The current mandatory skill bootstrap predates this design and remains intentionally unchanged until measured migration work is completed. Its future replacement must preserve any useful workflow/safety behavior without requiring unrelated calls.

### P7. Dedicated tools need distinct semantics

A new dedicated tool is justified when it provides at least one of:
- meaningfully better safety/approval semantics;
- materially smaller outputs;
- structured behavior difficult to reproduce reliably with shell;
- substantially better model selection accuracy;
- a capability shell cannot provide.

Convenience alone is insufficient.

### P8. Optimize from telemetry

Before changing a cap, catalog threshold, or routing policy, measure current traffic. Record:
- calls by tool;
- p50/p90/p95/p99 model-facing result bytes;
- truncation/spill rate;
- error/retry rate;
- extra round trips caused by truncation/discovery;
- initial tool schema bytes;
- skill discovery/load calls;
- task success regression where available.

### P9. Compatibility changes are explicit

Removing parameters, result fields, or changing tool names is not a "cleanup". It requires a migration task, tests, changelog entry, and a reason the token/selection benefit exceeds compatibility risk.

### P10. Prefer reversible improvements

Early improvements should be easy to revert and independently testable. Avoid mixing schema cleanup, skill policy changes, deferred loading, and runtime authorization changes in one patch.

## 5. Target layering

```text
Model-visible stable layer
  six eager core tools
  concise server routing instruction
        |
        v
Runtime enforcement layer
  auth / safety profile / trusted roots
  filesystem activation / shell execution
  output bounding / spill recovery
  metrics
        |
        v
Optional capability registry
  external MCPs / future plugins
  direct exposure when cheap
  deferred discovery when schema footprint is large
```

Runtime root changes should not require changing human/model prose in a tool description.

## 6. Shell result contract target

Normal successful shell calls should converge on a compact decision-oriented result similar to:

```json
{
  "exitCode": 0,
  "stdout": "...",
  "stderr": "",
  "durationMs": 12,
  "stdoutTruncated": false,
  "stderrTruncated": false,
  "stdoutSpillPath": null,
  "stderrSpillPath": null
}
```

Additional diagnostics may be present when needed for recovery/error handling, but internal accounting should not be duplicated into every normal model response.

The exact compatibility migration is tracked in the implementation plan; do not remove fields opportunistically outside that task.

## 7. Deferred external-tool policy target

Do not defer the six core tools.

For optional/external MCP tools:

1. estimate total serialized tool-schema footprint;
2. expose directly while footprint is small;
3. once a configurable threshold is exceeded, expose a discovery mechanism and defer optional schemas;
4. guarantee exact-name discovery before fuzzy ranking;
5. never defer tools unless a working discovery path exists for the active model/client;
6. consider prompt-prefix/KV-cache behavior before enabling dynamic schema injection.

No fixed threshold is adopted yet. Qwen's 10% context-window default is a reference point, not a copied requirement.

## 8. Skill policy target

Long-term direction:

- `get_skill(name)` remains available for explicit or strongly matched workflows;
- known skill names should load directly without discovery first;
- discovery must remain compact;
- skill content should be loaded once per task unless refresh is needed;
- prompt/resource duplicates should be optional compatibility surfaces where clients do not need them;
- mandatory bootstrap should be replaced only after measuring task quality and safety impact.

## 9. Change-control rule for future agents

Before implementing a harness-efficiency change:

1. read this design;
2. read `docs/superpowers/plans/2026-09-09-mcp-harness-efficiency.md`;
3. check the task ID/status there and `CHANGELOG.md`;
4. inspect `git status --short` and do not overwrite unrelated dirty work;
5. add/adjust a failing regression test before changing behavior;
6. run narrow tests, then full `npm test`, relevant MCP smoke tests, and `git diff --check`;
7. update the task status and changelog in the same change.

If a task ID is already marked DONE, do not reimplement it unless new evidence identifies a regression or the plan explicitly creates a follow-up task.
