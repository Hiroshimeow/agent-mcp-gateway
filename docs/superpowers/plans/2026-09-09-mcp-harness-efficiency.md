# MCP Harness Efficiency Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce model-facing MCP token cost and unnecessary round trips while preserving the six-tool core, runtime safety boundaries, and recoverability of large outputs.

**Architecture:** Keep the six local core tools eagerly exposed and stable. Move dynamic policy/diagnostic detail out of model-facing descriptions/results, keep large outputs bounded and recoverable, then introduce progressive skills and deferred external-tool discovery only after measurements show a benefit.

**Tech Stack:** Node.js ESM, `@modelcontextprotocol/sdk`, official MCP filesystem server, Node test runner, TOML gateway config.

## Global Constraints

- Preserve the six core `yolo` tool names unless a task explicitly declares a compatibility migration.
- Do not weaken auth, safety-profile, trusted-root, or shell working-directory enforcement as an efficiency optimization.
- Do not add dependencies for work that can use existing Node.js/runtime facilities.
- Model-facing truncation must always remain explicit and recoverable through a spill path or paging/window mechanism.
- Keep tool schemas stable across ordinary runtime-root changes wherever the client contract permits.
- Do not implement deferred loading unless the active model/client has a verified discovery path.
- Every behavior change requires a regression test that is observed failing first.
- Update this task ledger and `CHANGELOG.md` in the same patch as each completed task.

---

## Durable task ledger

| ID | Status | Scope | Risk | Expected value |
|---|---|---|---|---|
| HARN-P0-001 | DONE | Remove dynamic trusted-root prose from `shell_execute` description | Low | Stable/smaller schema, less cache churn |
| HARN-P0-002 | DONE | Compact normal model-facing shell result while retaining recovery fields and telemetry | Low-Medium | Removes repeated diagnostic tokens on the highest-volume tool |
| HARN-P0-003 | PLANNED | Add schema/result byte benchmark report to smoke/benchmark tooling | Low | Prevents speculative token tuning |
| HARN-P1-001 | DONE | Replace mandatory skill bootstrap with measured progressive-disclosure mode | Medium | Removes avoidable `get_skill` round trips |
| HARN-P1-002 | PLANNED | Reduce duplicate skill prompt/resource exposure for clients that only need `get_skill` | Medium | Smaller catalogs/context |
| HARN-P1-003 | PLANNED | Add bounded/paged text-read policy above official filesystem tool | Medium | Prevents accidental large file reads |
| HARN-P1-004 | PLANNED | Simplify `image_preview` aliases after compatibility inventory | Medium | Smaller schema, clearer selection |
| HARN-P2-001 | PLANNED | Threshold-based deferred external MCP discovery | High | Scales large optional catalogs |
| HARN-P2-002 | PLANNED | Exact-name-first deferred tool search | Medium | Avoids false-negative discovery |
| HARN-P3-001 | RESEARCH | Evaluate code-mode/nested tool execution for very large catalogs | High | Potentially large context savings |

`DONE` means implemented, tested, documented, and listed in `CHANGELOG.md`. Do not duplicate DONE tasks.

---

### Task HARN-P0-001: Stable `shell_execute` description

**Files:**
- Modify: `tests/shell-policy.test.mjs`
- Modify: `scripts/shell-tool-descriptor.mjs`
- Modify: `scripts/authenticated-mcp-wrapper.mjs`
- Modify: `CHANGELOG.md`
- Modify: this plan ledger

**Interfaces:**
- Consumes: runtime `currentRoots()` for enforcement and MCP `_meta` only.
- Produces: `buildShellExecuteDescription()` with static model-facing prose independent of current trusted-root values.

- [x] **Step 1: Write the failing test**

Change the descriptor test to call `buildShellExecuteDescription()` without a root notice and assert the description contains stable routing/spill guidance but does not contain a concrete root such as `C:/repo` or `Trusted roots:`.

```js
const description = buildShellExecuteDescription();
assert.match(description, /bounded head\/tail preview/i);
assert.match(description, /spill path/i);
assert.doesNotMatch(description, /Trusted roots:/i);
assert.doesNotMatch(description, /C:\/repo/i);
```

- [x] **Step 2: Run the narrow test and verify RED**

Run:

```bash
node --test tests/shell-policy.test.mjs
```

Expected: FAIL because the current descriptor only receives spill guidance through the dynamic notice passed by the wrapper, and the test expects the new static contract.

- [x] **Step 3: Implement the minimal static descriptor**

Make `buildShellExecuteDescription()` own static spill/routing guidance. Stop interpolating `currentRoots()` into the description in `listMergedTools()`. Preserve runtime root enforcement and existing `_meta` for compatibility.

- [x] **Step 4: Verify GREEN and regression**

Run:

```bash
node --test tests/shell-policy.test.mjs
npm run smoke:mcp:tools
npm test
```

Expected: all PASS.

- [x] **Step 5: Update ledger/changelog**

Mark `HARN-P0-001` DONE and add one concise `CHANGELOG.md` entry.

---

### Task HARN-P0-002: Compact model-facing shell results

**Files:**
- Modify: `tests/direct-shell.test.mjs` or add `tests/shell-result.test.mjs`
- Modify: `tests/tool-metrics.test.mjs`
- Modify: `scripts/authenticated-mcp-wrapper.mjs`
- Possibly modify: `scripts/tool-metrics.mjs`
- Modify: `README.vi.md`
- Modify: `CHANGELOG.md`
- Modify: this plan ledger

**Interfaces:**
- Consumes: full internal `executeDirectShell()` result.
- Produces: compact MCP result containing decision/recovery fields; internal telemetry keeps operational accounting without requiring every byte counter in model content.

Target normal result fields:

```js
{
  exitCode,
  stdout,
  stderr,
  stderrClassification,
  durationMs,
  timedOut,
  stdoutTruncated,
  stderrTruncated,
  stdoutSpillPath,
  stderrSpillPath
}
```

Original byte counts may be retained only when truncation makes them useful. Do not echo `command`, requested cwd, fixed encoding, or head/tail byte counters in every normal result.

- [x] **Step 1: Add a failing regression test** that proves a successful small shell call omits redundant accounting fields while retaining exit/output/duration/recovery contract.
- [x] **Step 2: Run the narrow test and verify RED** against the current verbose result.
- [x] **Step 3: Implement the compact formatter path** from the internal shell execution result while keeping execution semantics unchanged.
- [x] **Step 4: Ensure metrics still report truncation/spill** without restoring verbose fields to model content.
- [x] **Step 5: Run narrow tests, `npm run smoke:mcp:tools`, compatibility benchmark path, and full `npm test`.**
- [x] **Step 6: Compare serialized result bytes before/after.** Smoke fixtures measured `longCommandWireBytes` 4,044 -> 711 bytes (~82% lower) and `compositeWireBytes` 80,708 -> 60,932 bytes (~24% lower), while spill recovery remained exact.
- [x] **Step 7: Update README, changelog, and mark DONE.**

Do not perform this task if an external consumer is found to depend on removed result fields; in that case add an opt-in compatibility mode first and record the evidence here.

---

### Task HARN-P0-003: Token/schema benchmark report

**Files:**
- Modify: `scripts/benchmark-mcp-p0p1.mjs` or create `scripts/benchmark-harness-efficiency.mjs`
- Modify: `package.json`
- Add/modify tests for deterministic calculations
- Modify: `CHANGELOG.md`
- Modify: this plan ledger

**Interfaces:**
- Consumes: `tools/list`, representative shell result fixtures, `.runtime/mcp-calls.ndjson` when present.
- Produces: JSON report with model/tool surface metrics; no production behavior change.

Report at minimum:

```json
{
  "coreToolCount": 6,
  "coreToolSchemaBytes": 0,
  "serverInstructionBytes": 0,
  "shellResultBytes": { "small": 0, "truncated": 0 },
  "telemetry": {
    "callsByTool": {},
    "shellOutputP50": 0,
    "shellOutputP90": 0,
    "shellOutputP95": 0,
    "shellOutputP99": 0,
    "shellTruncationRate": 0
  }
}
```

- [ ] Write deterministic calculation tests first and observe RED.
- [ ] Implement the report without new dependencies.
- [ ] Add `npm run benchmark:harness`.
- [ ] Verify against current telemetry and smoke server.
- [ ] Update changelog and mark DONE.

---

### Task HARN-P1-001: Progressive skill loading

**Files:**
- Modify: `scripts/skill-bootstrap-gate.mjs`
- Modify: `scripts/skills/index.mjs`
- Modify: `scripts/authenticated-mcp-wrapper.mjs`
- Modify: `tests/skill-bootstrap-gate.test.mjs`
- Modify: `scripts/smoke-mcp-tools.mjs`
- Modify: `README.vi.md`
- Modify: `CHANGELOG.md`
- Modify: this plan ledger

**Interfaces:**
- Consumes: verified caller identity and skill registry.
- Produces: progressive skill loading where relevant skills are encouraged/discovered but unrelated shell/write/edit operations do not incur a mandatory blocked round trip.

Required migration evidence before default change:
- current `get_skill` call rate and output bytes;
- representative coding tasks with and without mandatory bootstrap;
- no regression in safety-profile/trusted-root enforcement;
- no increase in destructive/unrelated edits attributable to missing workflow guidance.

- [ ] Add an explicit mode (`enforce` vs `advisory`) behind configuration before changing the default.
- [ ] Write tests for both modes and observe RED.
- [ ] Implement advisory mode without weakening runtime safety checks.
- [ ] A/B representative tasks.
- [ ] Change default only if evidence supports it.
- [ ] Update docs/changelog and mark DONE.

---

### Task HARN-P1-002: Skill surface deduplication

**Files:**
- Modify: `scripts/prompts/index.mjs`
- Modify: `scripts/resources/index.mjs`
- Modify: skill/config loading as needed
- Modify: schema/smoke tests
- Modify: README/changelog/ledger

**Interfaces:**
- Consumes: live skill registry.
- Produces: configurable compatibility surfaces where `get_skill` can remain canonical without necessarily advertising every skill as both prompt and resource.

- [ ] Measure serialized prompt/resource catalog bytes first.
- [ ] Identify clients that require prompt/resource skill surfaces.
- [ ] Add a compatibility configuration rather than deleting surfaces globally.
- [ ] Test add/edit/remove hot reload under each mode.
- [ ] Update docs/changelog and mark DONE.

---

### Task HARN-P1-003: Bounded/paged text reads

**Files:**
- Add a focused wrapper/formatter around `read_text_file` or replace only if required by official filesystem capabilities.
- Add tests for line/byte caps, UTF-8 boundaries, and continuation.
- Update README/changelog/ledger.

**Interfaces:**
- Produces explicit window metadata and a continuation mechanism; never silently truncates.

- [ ] Measure current read result distribution first.
- [ ] Choose defaults from telemetry; use DeepSeek/Qwen limits only as reference points.
- [ ] Write failing tests for oversized UTF-8 text and continuation.
- [ ] Implement without changing write/edit semantics.
- [ ] Run full filesystem and MCP smoke tests.
- [ ] Update docs/changelog and mark DONE.

---

### Task HARN-P1-004: Simplify `image_preview` schema

**Files:**
- Modify: `scripts/custom-tools/index.mjs`
- Modify: `scripts/custom-tools/image-preview-tool.mjs`
- Modify: custom-tool tests
- Update docs/changelog/ledger

Current aliases `path|file|sourcePath` and `embed|includeImage|includeData` overlap. Before deletion:

- [ ] Search repo and telemetry/client code for alias use.
- [ ] If unused, deprecate before removal or provide a compatibility window.
- [ ] Converge on `path`, optional `maxBytes`, and at most one explicit image-inclusion flag if a real use case exists.
- [ ] Measure schema-byte reduction.
- [ ] Update docs/changelog and mark DONE.

---

### Task HARN-P2-001: Threshold-based deferred external MCP discovery

**Files:**
- New focused discovery/index module under `scripts/upstreams/`
- Modify: external MCP manager/config
- Modify: tool routing/listing
- Add dedicated tests and smoke scenarios
- Update docs/changelog/ledger

**Interfaces:**
- Direct core tools remain unchanged.
- Optional external tools may be direct or deferred according to serialized schema footprint and active-client capability.

- [ ] Define a model/client capability check; if discovery is unavailable, do not defer.
- [ ] Calculate schema footprint deterministically.
- [ ] Add configurable threshold; do not hard-copy Qwen's 10% without local evidence.
- [ ] Implement discovery result with exact canonical names and concise descriptions.
- [ ] Verify resume/list-changed/upstream-reconcile behavior.
- [ ] Benchmark prompt bytes and discovery round trips.
- [ ] Update docs/changelog and mark DONE.

---

### Task HARN-P2-002: Exact-name-first deferred search

**Files:**
- Discovery search module from HARN-P2-001
- Tests
- Docs/changelog/ledger

**Interfaces:**
- Query -> exact normalized matches first, then fuzzy/BM25-like ranking if implemented.

- [ ] Write failing test where a broad query contains an exact tool name that fuzzy top-N would otherwise omit.
- [ ] Implement exact-name priority and dedupe.
- [ ] Test canonical, namespaced, and raw upstream names.
- [ ] Update docs/changelog and mark DONE.

---

### Task HARN-P3-001: Code-mode/nested execution research

No production implementation is authorized by this task.

- [ ] Prototype outside the default path.
- [ ] Measure whether hiding inner tool results materially reduces context for realistic external-MCP workflows.
- [ ] Evaluate debugging, security, approval, observability, and cache costs.
- [ ] Write a separate design decision before any production merge.

---

## Verification matrix for every completed production task

Run the narrow test first, then as applicable:

```bash
npm test
npm run skills:check
npm run smoke:mcp-schemas
npm run smoke:mcp:tools
npm run smoke:mcp:upstreams
git diff --check
```

Also inspect:

```bash
git status --short
git diff -- <files touched by the task>
```

Never claim the task DONE when unrelated pre-existing dirty files were overwritten or silently included.

## Self-review

- Spec coverage: design principles, stable schemas, output bounding, skill migration, skill-surface dedupe, read paging, image schema cleanup, deferred external tools, exact discovery, and code-mode research are each mapped to a unique task ID.
- Placeholder scan: no implementation task depends on `TBD`/`TODO`; later high-risk tasks contain explicit prerequisites and acceptance criteria rather than unspecified implementation work.
- Type/interface consistency: shell compaction consumes the existing internal `executeDirectShell()` result; deferred discovery is isolated from the six eager core tools; runtime safety remains outside model-surface optimizations.

## Execution handoff

The user authorized immediate inline execution of simple, low-risk, high-value items. HARN-P0-001 and HARN-P0-002 were completed on 2026-09-09. Keep later tasks planned until their evidence gates are satisfied; HARN-P0-003 is the next low-risk measurement task.

## 2026-09-09 verification record

- `node --test tests/shell-policy.test.mjs`: PASS after an intentional RED failure first.
- `npm run smoke:mcp:tools`: PASS; six-tool `yolo` catalog unchanged; spill recovery preserved.
- `npm test`: PASS, 165/165.
- `npm run smoke:mcp-schemas`: PASS (`resources=44`, `templates=3`, `prompts=44`).
- `npm run smoke:mcp:upstreams`: PASS.
- `MCP_BENCH_WARMUP=0 MCP_BENCH_ITERATIONS=1 MCP_BENCH_SHELL_SIZES=1024,65536 node scripts/benchmark-mcp-p0p1.mjs`: PASS; spill validation exact for 64 KiB raw output.
- `git diff --check`: PASS.
- `npm run skills:check`: external-drift gate currently FAILS because pinned Ponytail, Superpowers, Anthropic, Stitch and Hallmark sources have newer upstream commits; no skill sync was performed because it is unrelated to HARN-P0-001/002.


## HARN-P1-001 implementation note

2026-09-09: converted bootstrap from a hard execution gate to progressive disclosure. Changing tools remain protected by runtime profile, trusted roots, and path validation. Full regression later verified 165/165 tests green; the managed `using-superpowers` compatibility policy was reconciled on 2026-09-12 so task-relevant routing remains strong without making skill loading a prerequisite for unrelated operations.
