# Agent MCP Gateway — Device Broker + Tooling Semantics Refactor Plan

> Status: DESIGN / OPERATOR-SELECTION REQUIRED
> Date: 2026-09-12
> Primary repo: E:\git-project\agent-mcp-gateway
> Device runtime repo: E:\git-project\broker-mcp-gateway (fork of wonderwhy-er/DesktopCommanderMCP; preserve upstream attribution/license)
> Governing roadmap: E:\git-project\playwright-auto\.plan\mcp-harness-efficiency-roadmap\mcp-harness-efficiency-roadmap-plan.md
> No implementation is authorized by this document alone.

## 1. Executive decision

Use **two repositories with one control plane**, not one physical super-repo:

1. agent-mcp-gateway = central MCP ingress/control plane/broker/shared skills/policy/routing.
2. broker-mcp-gateway = forked DesktopCommanderMCP remote device runtime and execution engine.

Do not create a third standalone broker/control-plane repo. Despite its name, broker-mcp-gateway is the attributed DesktopCommanderMCP fork/device runtime; the central broker/control plane lives in agent-mcp-gateway.

Do not vendor/copy the full Desktop Commander codebase into agent-mcp-gateway.

Instead, selectively port the **semantics** that are objectively better:
- guarded exact text replacement with expected replacement count;
- explicit long-running process lifecycle;
- paged process output;
- interactive process input;
- explicit shell selection/timeout;
- OS-specific spawn/quoting fixes;
- bounded session state;
- exact device capability routing.

Keep the harness roadmap principles:
- stable model-facing schema;
- small eager catalog;
- progressive skills;
- runtime policy as the actual security boundary;
- bounded/recoverable outputs;
- measure before changing defaults.

## 2. Why the observed shell safety failure does not prove gateway shell policy is the blocker

Current agent-mcp-gateway source in yolo mode explicitly tests that validateShellCommand keeps arbitrary shell commands.
The gateway currently rejects shell only when:
- command is empty; or
- working_directory is outside configured trusted roots; or
- runtime profile hides shell.

The reported pytest invocation was blocked by a tool/safety layer before successful MCP execution.
Therefore the evidence does **not** support blaming shell-policy.mjs.

Desktop Commander start_process itself advertises:
- readOnlyHint=false
- destructiveHint=true
- openWorldHint=true

So its success is also not explained simply by lower-risk MCP annotations.

Likely practical difference: Desktop Commander exposes richer, provider-integrated, intent-specific tools and therefore requires fewer opaque shell strings for common operations.

Important boundary:
This refactor may reduce false positives by replacing opaque shell mutations with typed operations, but must never claim to bypass or disable host/client safety policy.
## 3. Objective comparison: current gateway vs Desktop Commander

### Current gateway strengths

- only six eager core tools;
- small tools/list footprint;
- stable model-facing shell description;
- trusted-root enforcement;
- compact bounded shell result + exact spill recovery;
- OAuth/static bearer auth;
- persistent auth state + refresh tokens;
- hot-reload managed external skills;
- external MCP upstream aggregation;
- cross-platform tests;
- clean progressive skill disclosure at current HEAD;
- telemetry avoids payload bodies.

### Current gateway weaknesses

- shell_execute is one-shot only;
- no persistent/interactive process session;
- fixed 300s shell timeout at wrapper call path;
- shell schema only command + working_directory;
- filesystem edit_file has no expected replacement count;
- edit_file can fall back to flexible whitespace matching;
- no first-class search session/pagination;
- no device registry or outbound device channel;
- some plan/docs remain stale relative to current progressive-skill HEAD.

### Desktop Commander strengths worth borrowing

- start_process(command, timeout_ms, shell, verbose_timing);
- read_process_output(pid, timeout_ms, offset, length);
- interact_with_process(pid, input, timeout_ms);
- force_terminate(pid);
- list_sessions();
- per-platform shell spawn logic;
- Windows PATHEXT repair and cmd quoting handling;
- bounded/paged terminal buffer semantics;
- edit_block with expected_replacements;
- exact-count guard before mutation;
- fuzzy mismatch shown as diagnostic rather than silently applying fuzzy mutation;
- start_search/get_more_search_results/stop_search session model;
- explicit per-device config and capability surface.

### Desktop Commander patterns NOT to copy wholesale

- 20+ eager tool catalog into the central gateway;
- very long tool descriptions containing client-specific instructions;
- allowedDirectories=[] as a production default because that means full filesystem;
- command-blocklist parser as the primary security boundary;
- vendor Supabase/hosted relay coupling;
- telemetry-on default without operator choice;
- automatic SSH command mutation;
- all filesystem/data analysis routed through interactive REPL;
- duplicate config/UI/feedback tools unrelated to gateway purpose.

## 4. Key concrete finding: edit_file is currently weaker than desired

The official filesystem server used by agent-mcp-gateway exposes:

edit_file(path, edits[{oldText,newText}], dryRun)

Its implementation:
- checks modifiedContent.includes(oldText);
- replaces the first match;
- otherwise attempts whitespace-flexible line matching.

It does not expose expected_replacements.

Therefore this pattern currently requires shell/Python to be safe:

count old string
assert count == 1
replace
write

Desktop Commander already models this as:
edit_block(file_path, old_string, new_string, expected_replacements=1)

Target gateway behavior should provide the same invariant directly without requiring shell.

## 5. Target architecture

ChatGPT / Claude / Cursor / other MCP clients
                 |
                 v
        agent-mcp-gateway
        -----------------
        MCP ingress/auth
        stable tool facade
        shared SkillRegistry
        trusted roots/policy
        telemetry
        external MCP manager
        NEW DeviceBroker
                 |
          authenticated WSS
       +---------+---------+
       |                   |
       v                   v
 ThinkBook device      G8 device
 DesktopCommander      DesktopCommander
 execution runtime     execution runtime

Local execution on the broker host and remote execution on devices should converge on common model-facing semantics wherever practical.

## 6. Repository ownership

### agent-mcp-gateway owns

- MCP Streamable HTTP ingress;
- ChatGPT registration/auth;
- caller identity;
- central authorization;
- stable public tool schemas;
- shared external skill registry;
- managed skill sync;
- trusted workspace registry for local execution;
- external MCP aggregation;
- DeviceBroker;
- device registry;
- device ACL;
- routing;
- broker audit metadata;
- tool compatibility/version policy.

### broker-mcp-gateway (DesktopCommanderMCP fork) owns

- remote device process/service;
- local filesystem implementation;
- local terminal/process implementation;
- OS-specific spawn details;
- local path policy;
- local command policy;
- local process sessions;
- outbound persistent device transport adapter;
- device capability reporting.

### Rule

Do not duplicate skill content or broker policy into the device repo.
Do not duplicate OS-specific terminal implementation into the broker if it can be consumed through an adapter or selectively ported once.
## 7. Public tool-surface strategy

The harness roadmap says six eager tools are already close to optimal. Do not abandon that principle merely because Desktop Commander exposes many tools.

Refactor in two classes.

### 7.1 Eager core

Keep:
- read_text_file
- write_file
- edit_file
- shell_execute
- image_preview
- get_skill

But improve schemas/semantics behind compatible names when possible.

### 7.2 Selected process surface: Desktop Commander-style start/session tools

Decision: use the Desktop Commander-style process lifecycle only. Do not add a separate run_process tool.

Public process tools:
- start_process
- read_process_output
- interact_with_process
- terminate_process

Optional administrative/listing capability may remain deferred unless telemetry shows agents need it.

Rationale:
- the agent does not need to predict whether a command is short or long before selecting a tool;
- start_process handles both cases: short commands may complete in the initial call, while longer commands return a live session/PID for subsequent reads;
- one execution model avoids duplicated run-vs-start semantics;
- the design matches proven patterns in Desktop Commander and is close to Codex unified exec, where an initial command can yield a process/session for follow-up polling;
- long-running process state belongs to the server/session registry, not to one MCP request.

Timeout contract:
- expose one timeout_ms knob only;
- Codex-inspired default initial wait: 10,000 ms;
- configurable per call;
- clamp the initial wait to a maximum of 30,000 ms;
- timeout_ms is the maximum foreground wait for that tool call before it yields a still-running session;
- reaching timeout_ms must not kill the process; return RUNNING + session_id and keep buffering output;
- a short process that completes within the wait returns COMPLETED + final result in the same tool call;
- completed output/result must remain retained for a bounded TTL so a later agent turn can recover it;
- callers may choose a shorter or longer wait according to expected workload within the cap;
- do not introduce separate model-facing MCP timeout vs process timeout concepts unless runtime evidence later proves necessary.

Rationale for 10s/30s:
- 10s follows Codex unified exec's current default initial yield and is long enough for many git/search/unit-test calls to finish without an extra poll;
- 30s follows Codex's current maximum initial yield, avoiding multi-minute blocked tool calls once a resumable session exists;
- this avoids the failure mode of using an overly short wait that forces unnecessary polling while still guaranteeing long jobs yield control without losing their eventual result.

## 8. shell_execute v2

Keep shell_execute for one-shot commands.

Candidate compatible additions:
- timeout_ms optional;
- shell optional;
- device_id optional once DeviceBroker exists.

Do not add arbitrary policy flags to the public schema.

Execution result remains compact:
- workingDirectoryResolved
- exitCode
- stdout
- stderr
- durationMs
- timedOut
- truncation flags
- spill paths
- original bytes only when truncated

Do not copy Desktop Commander's verbose timing output into normal model results.
Timing event details belong in optional diagnostics/telemetry.

## 9. edit_file v2

Goal: remove common mutation-through-shell patterns.

Preferred model-facing contract:

edit_file(
  path,
  old_text,
  new_text,
  expected_replacements=1,
  dry_run=false,
  device_id?
)

Required semantics:
- exact count before write;
- if actual count != expected_replacements, do not mutate;
- return actual count and concise mismatch guidance;
- preserve line endings;
- atomic write/rename where supported;
- produce bounded diff/preview;
- no fuzzy mutation by default;
- optional diagnostic closest-match may be returned, but user/model must resubmit exact text.

Compatibility:
Current array edits schema may be retained temporarily under a compatibility path or converted internally.
Do not silently change old multi-edit semantics without tests and changelog.

This feature directly replaces shell/Python patterns such as assert s.count(old)==1.
## 10. Search primitives

Do not automatically port Desktop Commander's search-session tools.

Current shell_execute + rg is efficient for most repository search and aligns with harness guidance.

Only add first-class paged search if telemetry proves:
- large searches frequently overflow shell budget;
- agents repeatedly rerun rg just to page output;
- cancellation/session semantics materially improve workflows.

If added, prefer one search tool plus continuation token rather than three eager tools.

## 11. Safety model

### 11.1 Runtime enforcement

Authoritative controls remain:
- caller authentication;
- caller/device ACL;
- trusted roots;
- canonical path validation;
- local device path validation;
- runtime profile;
- process ownership/session validation;
- bounded execution/output.

### 11.2 Tool annotations

Annotations must describe actual behavior accurately.

Do not mark arbitrary shell read-only just to avoid client safety friction.
Do not mark process_start non-destructive if it can mutate.

### 11.3 Avoid policy-by-command-parser

Desktop Commander's blockedCommands parser can remain a device-side additional guardrail.
Do not make parsing shell strings the central authorization mechanism.

Typed filesystem/edit/process primitives are preferred for operations where intent can be represented structurally.

### 11.4 Host/client safety layer

The gateway cannot guarantee how an external client classifies a tool call.
Success criterion is fewer unnecessary opaque-shell operations, not bypassing client safety.

## 12. Shared skill architecture

Reuse current agent-mcp-gateway SkillRegistry unchanged as the source of truth unless a measured limitation appears.

Current useful properties:
- disk-backed skills;
- hot reload;
- last-valid catalog fallback;
- sources.json;
- sources.lock.json;
- license checks;
- compatibility replacements;
- modelInvocable/userInvocable metadata;
- get_skill discovery;
- prompts/resources.

DeviceBroker must not create a second skill catalog.

Remote devices execute tools; skills remain model/control-plane knowledge.

## 13. Current skill debt to resolve before/alongside refactor

### 13.1 Progressive disclosure source is fixed

Current HEAD aa17646 includes 8e48908:
- no mutation bootstrap gate;
- initialize instructions are progressive;
- old blockedCount/SKILL_BOOTSTRAP_CODE/checkTool debt removed.

### 13.2 Historical docs are stale

docs/mcp-harness-efficiency-design.md still says mandatory bootstrap remains unchanged.
docs/superpowers/plans/2026-09-09-mcp-harness-efficiency.md still says HARN-P1-001 IN PROGRESS.

Reconcile documentation; do not reimplement completed behavior.

### 13.3 Preserve correct skill routing while removing hard mutation gating

The managed using-superpowers skill currently says skill invocation is required before ANY response/action.
That can reintroduce ritual loading at instruction level even though gateway runtime is progressive.

However, observed good behavior such as loading brainstorming and then writing_plans should not be attributed to the old hard gate alone. The gate merely required some skill to be loaded; correct skill choice comes from skill descriptions, routing policy, and workflow instructions.

Target contract:
- keep strong task-relevant skill routing;
- when a skill name is already known from routing, call get_skill(name) directly rather than discovery first;
- preserve useful process flows such as new behavior -> brainstorming -> writing_plans when the task warrants them;
- do not block routine read/write/edit/shell/process calls solely because no skill was loaded;
- measure skill call rate and task-quality regression before weakening routing instructions further.

Resolve the overly broad "before ANY response/action" wording through sources.json compatibility policy or model-invocation metadata, not by hand-editing vendored managed skill files.

### 13.4 managed skill sync currently has real drift

npm run skills:check currently fails because stitch-utilities/enhance-prompt compatibility replacement expects one exact old text match and upstream now has zero.

Treat as independent baseline debt.
Fix manifest compatibility intentionally before claiming managed-skill sync healthy.
## 14. DeviceBroker design

DeviceBroker is a sibling subsystem to:
- SkillRegistry
- ExternalMcpManager
- WorkspaceRegistry

It must not be hidden inside skill bootstrap, external MCP manager, or shell implementation.

Responsibilities:
- device enrollment;
- authenticated persistent connection;
- online/offline state;
- heartbeat;
- device capability snapshot;
- per-device ACL;
- request routing;
- request lifecycle;
- reconnect handling;
- cancellation;
- connection_epoch;
- audit metadata.

Do NOT model every device as external_mcp server.

Reason:
ExternalMcpManager imports each upstream catalog and prefixes tools.
Device inventory changes would then churn model-facing tools/list and violate schema-stability goals.

## 15. Device identity/auth

Initial enrollment:
- device generates Ed25519 keypair;
- operator approves one-time enrollment;
- broker stores public key;
- device stores private key locally.

Reconnect:
- TLS;
- challenge;
- device signs challenge;
- broker verifies;
- broker issues bounded connection/session state.

Optional later:
- mTLS.

No ChatGPT credential is sent to devices.
No device credential is used as ChatGPT OAuth credential.

## 16. Device protocol

Envelope fields:
- protocol_version
- type
- request_id
- device_id
- connection_epoch
- timestamp
- payload

Broker -> device:
- auth_challenge
- tool_call
- cancel
- resync
- shutdown_notice

Device -> broker:
- hello
- authenticate
- capability_sync
- heartbeat
- tool_ack
- tool_stream
- tool_result
- tool_error
- cancel_ack

## 17. No-blind-replay rule

State:
CREATED -> ROUTED -> DELIVERED -> ACKED -> RUNNING -> COMPLETED|FAILED|CANCELLED|EXPIRED|UNKNOWN

If disconnect occurs after delivery ambiguity:
- read-only request may be retried only under explicit idempotent policy;
- mutating request becomes UNKNOWN/reconcile-required;
- never blindly replay mutation.

Use connection_epoch to reject stale late responses.

## 18. Capability and schema stability

Devices report capability metadata at connection time.

Broker public schema does not dynamically add:
- g8_read_file
- thinkbook_read_file
- device-specific tool names.

Instead device_id is runtime routing state/argument.

Adding A2 must not require ChatGPT app recreation or tool rescan if no public tool contract changes.

## 19. Local vs remote execution convergence

Do not create two unrelated model-facing APIs.

Preferred facade:
read_text_file(path, device_id?)
write_file(path, content, device_id?)
edit_file(..., device_id?)
shell_execute(..., device_id?)
start_process(..., device_id?)
read_process_output(..., device_id?)
interact_with_process(..., device_id?)
terminate_process(..., device_id?)

If device_id omitted:
- route local only when there is an unambiguous configured default;
- otherwise return structured ambiguity and available devices;
- never silently choose a remote device.

Internally:
local adapter -> current local implementations
remote adapter -> DeviceBroker call

This keeps ChatGPT tool schema stable while execution target varies.
## 20. Why not a single physical super-repo

Benefits of monorepo:
- one checkout;
- atomic cross-layer commits;
- easier local refactor;
- one CI.

Costs in this specific case:
- Desktop Commander has an active upstream worth syncing;
- device runtime contains many unrelated UI/config/file-format features;
- broker and device release cadences differ;
- a full copy would make upstream merges painful;
- central gateway would accumulate OS-specific execution code;
- security review boundary becomes less clear;
- packaging/deployment for Linux broker vs Windows device becomes coupled.

Decision:
Use a logical super-system, not a physical super-repo.

The contract between repos must be versioned and heavily tested.

## 21. Cross-repo contract strategy

Create a small protocol specification owned by agent-mcp-gateway.

Options:
A. JSON schema files copied/generated into both repos.
B. Small shared npm package later, only if duplication becomes painful.

Start with A to avoid premature package infrastructure.

Version:
protocol_version: integer

Compatibility:
- broker supports current + previous protocol version during migration;
- device reports agent version + capability hash;
- incompatible device stays connected only for diagnostics or is rejected with clear reason.

## 22. Implementation phases

### Phase 0 — reconcile baseline

Before feature code:
- record current HEAD;
- preserve live G8 runtime;
- fix stale progressive-skill docs/ledger;
- decide using-superpowers compatibility behavior;
- repair skills:check compatibility drift;
- rerun 165-test baseline;
- run smoke and benchmark;
- do not restart G8 live yet.

Exit:
source/docs/managed-skill health are understood and green except explicitly accepted external drift.

### Phase 1 — edit_file exact-count semantics

Implement safest high-value local primitive first.

- write RED tests for 0/1/2 occurrences;
- exact expected_replacements guard;
- no mutation on mismatch;
- atomic write;
- bounded diff;
- preserve old compatibility shape if required;
- benchmark schema/result bytes.

Exit:
common guarded replacement no longer needs shell/Python.

### Phase 2 — shell_execute compatible schema improvements

Research/implement:
- timeout_ms optional;
- shell optional only if cross-platform need is proven;
- retain current compact result;
- port Windows PATHEXT/cmd quoting fixes only if current runner lacks equivalent behavior and tests prove need.

Do not add process sessions here.

### Phase 3 — selected process lifecycle

Implement the selected Desktop Commander-style process lifecycle in an isolated branch/worktree:

- start_process
- read_process_output
- interact_with_process
- terminate_process

Do not add run_process.

Required behavior:
- a short process may complete and return its final result from start_process;
- a long process returns RUNNING plus session identity after timeout_ms;
- timeout_ms is one model-facing foreground-wait knob and may vary per call;
- timeout expiry yields control but does not kill the process;
- completed output remains readable for a bounded retention TTL;
- process/session ownership is validated;
- remote sessions carry device identity internally.

Test:
- short process;
- long process;
- timeout but still running;
- interactive prompt;
- output pagination;
- cancellation/termination;
- completed-session read;
- bounded buffer;
- session retention/cleanup;
- Windows + Linux.

Benchmark schema bytes, tool-call count, and abandoned/duplicated-command rate against current shell_execute workflows.

### Phase 4 — DeviceBroker skeleton

- protocol definitions;
- in-memory device registry;
- WSS device endpoint;
- development enrollment token initially;
- one device;
- list_devices;
- ping/read-only test call;
- no ChatGPT change required.

### Phase 5 — durable device auth

- Ed25519 enrollment;
- revoke;
- reconnect;
- SQLite state;
- service restart recovery.

### Phase 6 — remote generic tools

Route stable facade to remote device:
- read
- guarded edit
- shell
- process session

Capability check before dispatch.

### Phase 7 — ACL/audit hardening

- caller -> device ACL;
- tool ACL;
- device local policy;
- metadata-only audit;
- rate/size limits;
- secrets redaction;
- no full filesystem production default.

### Phase 8 — ChatGPT multi-device canary

One registered gateway app:
- local broker host;
- ThinkBook remote;
- G8 remote.

Verify no app recreation after adding/removing a device.

### Phase 9 — migrate old per-machine public MCP exposure

Only after soak:
- retain rollback;
- stop redundant public tunnel per device one at a time;
- measure latency/reliability/error rates;
- retain direct path if it has a justified special use.

## 23. Benchmark requirements

Do not evaluate by individual call only.

Record:
- tools/list bytes;
- initialize bytes;
- first successful mutation latency;
- tool call count;
- shell fallback frequency;
- edit mismatch incidents;
- process reread count;
- output spill/reread rate;
- p50/p95 latency;
- failure/502 rate where observable;
- reconnect time;
- task correctness.

Specific A/B:
A = current edit via shell/Python guarded replacement
B = typed edit_file expected_replacements

A = one-shot shell for long job/repeated polling
B = process session primitive

A = direct per-machine MCP tunnel
B = broker persistent device channel

## 24. Acceptance criteria

- no regression of trusted roots/auth/runtime profiles;
- no mandatory skill bootstrap returns;
- full baseline suite green;
- guarded edit refuses count mismatch;
- one-shot shell remains simple and bounded;
- process lifecycle, if accepted, is recoverable and bounded;
- adding a device does not change tools/list schema;
- no blind replay of ambiguous mutating calls;
- device can reconnect without human OTP after initial enrollment;
- broker and device can upgrade independently within protocol compatibility window;
- no duplicated skill source of truth;
- no requirement to publish inbound MCP on each device;
- host/client safety is respected, not bypassed.

## 25. Explicitly rejected shortcuts

Do not:
- copy all Desktop Commander tools into eager gateway catalog;
- copy vendor remote relay;
- move the entire DC repo under agent-mcp-gateway;
- make command blocklist the primary safety model;
- mark risky tools falsely safe to avoid external safety prompts;
- dynamically generate one tool per device;
- reintroduce mandatory skill loading;
- add a second skill store;
- silently fuzzy-edit files;
- retry unknown mutating calls after reconnect.

## 26. Recommended selected next unit

Before DeviceBroker implementation, highest ROI is:

1. reconcile roadmap/docs with current aa17646 state;
2. fix managed skill sync drift;
3. design + implement guarded edit_file expected_replacements;
4. extend benchmark to measure reduction in shell fallback;
5. then prototype process lifecycle.

Reason:
These improvements benefit the existing gateway immediately and create a cleaner stable tool facade that DeviceBroker can reuse later.

DeviceBroker should route good tool semantics, not freeze today's weak primitives into a remote protocol.

## 27. Operator decisions locked on 2026-09-12

These decisions are no longer open design questions for the implementation task.

1. Repository strategy:
   - keep two physical repos;
   - central control plane remains agent-mcp-gateway;
   - device runtime is a fork of wonderwhy-er/DesktopCommanderMCP renamed broker-mcp-gateway;
   - preserve original LICENSE, upstream remote/attribution, and fork relationship where GitHub permits.

2. Tool refactor scope:
   - implement both the core structured-tool improvements and the broader selected Desktop Commander-inspired surface;
   - use dependencies/phases where work cannot safely run in parallel;
   - keep at most two CDPA implementation tasks active at any time.

3. Process lifecycle:
   - B-only process model; do not add run_process;
   - start_process default foreground wait = 10,000 ms;
   - per-call configurable;
   - initial foreground wait cap = 30,000 ms;
   - if completed within wait: return COMPLETED + final result;
   - if still running: return RUNNING + session_id and keep process/output alive;
   - read_process_output polls existing session;
   - interact_with_process sends input;
   - terminate_process is the only explicit termination primitive;
   - timeout/yield must never discard eventual output/result;
   - completed sessions/results remain recoverable for bounded retention TTL.

4. CDPA orchestration:
   - spawn Team A first on G8 CDPA only;
   - do not touch ThinkBook CDPA while it is being updated;
   - Team A owns design/refactor sequencing and is explicitly authorized to spawn Team B itself;
   - do not pre-create Team B as a blocked/dependency-waiting task;
   - Team A may spawn Team B only after the cross-repo protocol/contract is stable enough for productive work;
   - if Team A becomes blocked or changes the design, Team B does not exist yet and therefore needs no stop/re-create cycle;
   - Team A may keep at most one child Team B active, so total concurrent implementation tasks never exceeds two.

5. Skill source:
   - use the existing agent-mcp-gateway managed/hot-reload skill source as the single source of truth;
   - broker-mcp-gateway must not introduce a second skill store;
   - remove hard mutation gating without weakening task-relevant skill routing; preserve correct flows such as brainstorming -> writing_plans when warranted.

6. Baseline hygiene before feature work:
   - commit this planning/refactor baseline first so agent-mcp-gateway starts clean;
   - create a new feature branch only after that baseline commit;
   - Team A must record the baseline SHA in its report before implementation.
