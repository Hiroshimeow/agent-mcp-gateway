# Progressive Skill Disclosure Contract Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every model-facing skill instruction describe optional, task-relevant loading rather than a prerequisite for local mutations.

**Architecture:** Keep authorization and tool routing unchanged. Remove only stale bootstrap wording and dead blocking state, then prove the runtime MCP instruction, tool calls, profiles, and output recovery contracts remain intact.

**Tech Stack:** Node.js ESM, Node test runner, MCP Streamable HTTP smoke harness.

---

### Task 1: Establish progressive-disclosure contract

**Files:**
- Modify: `tests/skill-bootstrap-gate.test.mjs`
- Modify: `scripts/skills/index.mjs`
- Modify: `scripts/skill-bootstrap-gate.mjs`

- [x] **Step 1: Write failing tests** that assert the exported agent instruction does not contain `Before first use` or `satisfies bootstrap`, and the gate state no longer exposes old blocking artifacts.
- [x] **Step 2: Run** `node --test tests/skill-bootstrap-gate.test.mjs` and observe the old mandatory instruction failure.
- [x] **Step 3: Implement minimal wording/state cleanup** while retaining the one-time advisory TTL behavior.
- [x] **Step 4: Run** `node --test tests/skill-bootstrap-gate.test.mjs` and confirm all tests pass.

### Task 2: Align externally visible documentation and smoke output

**Files:**
- Modify: `README.md`
- Modify: `README.vi.md`
- Modify: `scripts/skills/README.md`
- Modify: `scripts/smoke-mcp-tools.mjs`

- [x] **Step 1: Replace mandatory-gate descriptions** with optional skill loading for specialized workflows.
- [x] **Step 2: Update smoke summary terminology** to describe progressive disclosure rather than a bootstrap gate.

### Task 3: Verify behavior and quantify benefit

**Files:**
- Test: `tests/skill-bootstrap-gate.test.mjs`
- Test: `scripts/smoke-mcp-tools.mjs`

- [x] **Step 1: Run focused regression and MCP smoke**, including tools/list, direct unbootstrapped mutation, profiles, shell output, and spill recovery.
- [x] **Step 2: Compare baseline and fixed instructions/call path** by measuring UTF-8 instruction bytes and the eliminated `get_skill` tool-call wire response.
- [x] **Step 3: Run full suite**; fix the managed-skill registry assertion so local skills do not make the full suite fail.
