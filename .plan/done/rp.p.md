# Plan: ChatGPT-Safe MCP Gateway with Default Yolo Mode, Native Resources, and Prompt Primitives

## 0. Purpose

This document is the single implementation plan for the next agent working on `agent-mcp-gateway`.

The goal is to evolve the repo from a practical local MCP tool gateway into a more correct ChatGPT Developer / Apps-compatible MCP gateway while still preserving the user's desired default behavior:

- **Yolo mode is ON by default** for this private local developer gateway.
- In yolo mode, agents should be able to run without extra server-side approval prompts from this gateway.
- The implementation must not attempt to bypass, suppress, spoof, or weaken ChatGPT host safety, platform policy, or user confirmation behavior.
- The repo cannot disable ChatGPT Developer Mode confirmation UI from server code. Any "remember approvals for this conversation" behavior is a ChatGPT host/UI feature, not an MCP server flag.
- The correct way to reduce unnecessary confirmation friction is to expose accurate read-only tools/resources, split preview and apply operations, and provide honest tool metadata so ChatGPT can distinguish low-risk reads from mutating/open-world actions.
- Tool metadata must be honest and precise so ChatGPT safety and planning layers can reason correctly.
- Add native MCP **Resources**.
- Strongly consider adding native MCP **Prompts** in the same plan.
- Keep future extensibility in mind, including the ability to shrink or expand tool surface by safety profile.

This plan is intentionally detailed. Do not stop halfway. Do not invent APIs. Verify names against the installed `@modelcontextprotocol/sdk` version before coding. Do not use fallback fake code that only passes superficial tests.

---

## 1. Official references to use while implementing

Use these official docs as the design basis. Re-check exact APIs against the installed SDK in this repo.

### OpenAI Apps SDK / ChatGPT Apps

- Apps SDK MCP server concept: `https://developers.openai.com/apps-sdk/concepts/mcp-server`
- Tool planning and metadata: `https://developers.openai.com/apps-sdk/plan/tools`
- Security and privacy guidance: `https://developers.openai.com/apps-sdk/guides/security-privacy`
- Apps SDK reference: `https://developers.openai.com/apps-sdk/reference`
- Connect from ChatGPT Developer Mode: `https://developers.openai.com/apps-sdk/deploy/connect-chatgpt`

Important principles from OpenAI docs to preserve:

- Do not design tools to bypass safety.
- Use clear tool descriptions, input schemas, output contracts, and annotations.
- Split read-only and mutating operations.
- Keep server-side validation even when ChatGPT has model-side safety and confirmations.
- Treat destructive and open-world operations honestly in metadata.
- Prefer dedicated tools over a broad raw shell tool where possible.

### MCP specification

- Tools: `https://modelcontextprotocol.io/specification/2025-06-18/server/tools`
- Resources: `https://modelcontextprotocol.io/specification/2025-06-18/server/resources`
- Prompts: `https://modelcontextprotocol.io/specification/2025-06-18/server/prompts`
- Base MCP spec: `https://modelcontextprotocol.io/specification/2025-06-18/basic`

Important MCP concepts to preserve:

- Tools are model-callable actions.
- Resources are application-controlled context/data exposed by URI.
- Prompts are server-provided prompt templates/workflows.
- The server should advertise capabilities for the primitives it supports.
- Request handlers should use the SDK request schema names present in the installed SDK, not guessed names.

---

## 2. Current repo state summary

As of this plan, the repo already has:

- Streamable HTTP MCP wrapper in `scripts/authenticated-mcp-wrapper.mjs`.
- Filesystem MCP upstream wrapped through `@modelcontextprotocol/server-filesystem`.
- Custom local tools in `scripts/custom-tools/`.
- Shell backend adapter in `scripts/direct-shell.mjs`:
  - Windows: PowerShell with `-NoProfile -NonInteractive -ExecutionPolicy Bypass -Command`.
  - Linux/macOS/POSIX: configured POSIX shell with `-c`.
- `scripts/shell-tool-descriptor.mjs` for shell tool description and annotations.
- OAuth/password/static bearer auth support.
- Trusted roots/project registry support.
- Tests under `tests/*.test.mjs`.

Observed issues and gaps:

1. Tool surface is strong, but native MCP Resources and Prompts are not implemented.
2. `normalizeToolForAutopilot()` currently forces some annotations to `destructiveHint:false` and `openWorldHint:false`; this is not correct for ChatGPT safety semantics.
3. Yolo behavior exists as ad hoc `ENABLE_SHELL` and `SHELL_PROFILE`, but there is no first-class safety profile model.
4. Runtime tool catalog metadata can become stale; we need tests that catch source/runtime mismatch.
5. Existing custom tools are flat and numerous; future work needs a formal tool policy/risk manifest to allow expansion or intentional reduction.
6. The package description and docs still contain some Windows-first phrasing; this is acceptable historically but should be made cross-platform where it affects semantics.

---

## 3. Target design overview

Implement a first-class **safety profile system** with yolo as default for this repo.

### Profiles

There should be three profiles:

```txt
safe
assisted
yolo
```

Default:

```env
MCP_SAFETY_PROFILE=yolo
```

Rationale: this repo is a private local development gateway. The user wants agent automation without extra server-side approval prompts by default. The server must still describe risk accurately to ChatGPT.

### Profile meaning

| Profile | Default? | Raw shell | Destructive local tools | Open-world tools | Intended use |
|---|---:|---:|---:|---:|---|
| `safe` | No | Hidden/blocked | Hidden or blocked | Hidden/blocked | Public-ish or conservative ChatGPT app mode |
| `assisted` | No | Hidden/blocked | Visible | Hidden or blocked | Private dev with safer dedicated tools |
| `yolo` | Yes | Visible | Visible | Visible | Private trusted local developer mode |

Important wording:

```txt
Yolo mode reduces server-side launcher restrictions for trusted local development. It does not bypass ChatGPT host safety, user confirmations, or platform policy.
```

### Safety model

Every tool should have a risk classification:

```txt
readOnlyHint
idempotentHint
destructiveHint
openWorldHint
riskLevel
category
profileVisibility
```

Use MCP annotations where supported. Put extra repo-specific policy in `_meta` and/or a dedicated manifest resource/tool.

### Confirmation and approval model

There are two distinct approval layers. The implementation must keep them separate.

#### 1. Gateway/server-side approval

This repo controls only its own launcher behavior. In `MCP_SAFETY_PROFILE=yolo`, the gateway should not add extra server-side approval prompts, shell blocklists, executable allowlists, or policy gates beyond trusted-root validation and auth. This is the part the repo can reduce.

#### 2. ChatGPT host confirmation

ChatGPT Developer Mode / Apps host confirmation is outside this repo. The MCP server must not try to bypass, hide, weaken, or spoof host-side confirmation. In particular:

- There is no repo env var that disables ChatGPT host confirmation UI.
- "Remember approvals for this conversation" is a ChatGPT UI/host feature, not something this MCP server can force.
- Do not mark mutating, destructive, or open-world tools as read-only to reduce prompts.
- Do not lie in `destructiveHint` or `openWorldHint` to make a risky tool look safe.

The correct friction-reduction strategy is:

1. Make genuinely read-only operations first-class and correctly annotate them with `readOnlyHint:true`.
2. Prefer native MCP Resources for passive repo context so ChatGPT can inspect state without invoking mutating tools.
3. Split dangerous workflows into dedicated preview/dry-run/read-only checks followed by explicit apply tools.
4. Keep raw shell exposed only in yolo, but annotate it as destructive and open-world.
5. Prefer dedicated tools such as `git_status`, `git_diff`, `secret_scan`, and `review_diff` before raw shell.
6. Ensure default tool arguments are non-destructive where feasible, for example `dryRun:true` for patch/delete/zip/release-like flows when appropriate.

Acceptance target for confirmation friction:

```txt
The repo should minimize unnecessary prompts for read-only and preview operations, but must still allow ChatGPT host to request confirmation for write, destructive, or open-world actions.
```

---

## 4. Non-goals

Do not do these in this implementation:

- Do not remove yolo mode.
- Do not make `safe` the default unless the user explicitly changes product direction.
- Do not try to override ChatGPT safety checks.
- Do not add behavior intended to make ChatGPT Developer Mode skip confirmations for risky actions.
- Do not hide destructive behavior by setting false annotations.
- Do not relabel mutating/open-world tools as read-only merely to reduce confirmation prompts.
- Do not expose raw shell in safe/assisted profiles.
- Do not add fake Resources or fake Prompts that just call tools without using MCP primitives.
- Do not change auth architecture unless required for handler registration.
- Do not break existing Windows behavior.
- Do not break Linux behavior that was just fixed.
- Do not use fallback no-op handlers to pass tests.

---

## 5. Implementation phase 1: Safety profile foundation

### 5.1 Add `scripts/safety-profile.mjs`

Create a pure module with no server side effects.

Required exports:

```js
export const SAFETY_PROFILE_NAMES = ['safe', 'assisted', 'yolo'];

export const SAFETY_PROFILES = {
  safe: {
    name: 'safe',
    exposeShell: false,
    exposeDestructiveTools: false,
    exposeOpenWorldTools: false,
    requireServerSideApproval: true,
    description: 'Conservative profile for ChatGPT-friendly read-mostly usage.'
  },
  assisted: {
    name: 'assisted',
    exposeShell: false,
    exposeDestructiveTools: true,
    exposeOpenWorldTools: false,
    requireServerSideApproval: true,
    description: 'Private developer profile with dedicated mutating tools but no raw shell or open-world publishing by default.'
  },
  yolo: {
    name: 'yolo',
    exposeShell: true,
    exposeDestructiveTools: true,
    exposeOpenWorldTools: true,
    requireServerSideApproval: false,
    description: 'Private full-trust developer profile. Server exposes raw shell and open-world tools. This does not bypass ChatGPT host safety.'
  }
};

export function getSafetyProfile(env = process.env) {
  const raw = String(env.MCP_SAFETY_PROFILE || env.SHELL_PROFILE || 'yolo').trim().toLowerCase();
  return SAFETY_PROFILES[raw] || SAFETY_PROFILES.yolo;
}
```

Notes:

- Preserve `SHELL_PROFILE` as backward-compatible alias but prefer `MCP_SAFETY_PROFILE`.
- Default must be `yolo`.
- Unknown values should fall back to `yolo` only if that is acceptable for this private repo. If the implementer prefers safer fallback, document and ask. For this plan, use `yolo` because the user explicitly asked yolo default.
- Log a warning for unknown profile values if practical.

### 5.2 Add `scripts/tool-risk.mjs`

Create a pure module that classifies tools.

Minimum exports:

```js
export const TOOL_CATEGORIES = {
  filesystem: 'filesystem',
  git: 'git',
  review: 'review',
  release: 'release',
  shell: 'shell',
  project: 'project',
  platform: 'platform'
};

export function getToolRisk(toolName) { ... }
export function applyToolRisk(tool) { ... }
export function shouldExposeToolForProfile(tool, safetyProfile) { ... }
```

Tool name normalization:

- Accept both upstream names and custom-prefixed names.
- Use `toUpstreamToolName()` or duplicate a tiny safe normalization if importing would create cycles.

Risk map baseline:

| Tool | readOnly | destructive | openWorld | category | safe | assisted | yolo |
|---|---:|---:|---:|---|---:|---:|---:|
| `list_projects` | true | false | false | project | yes | yes | yes |
| `list_allowed_directories` | true | false | false | filesystem | yes | yes | yes |
| `read_file` | true | false | false | filesystem | yes | yes | yes |
| `read_text_file` | true | false | false | filesystem | yes | yes | yes |
| `read_media_file` | true | false | false | filesystem | yes | yes | yes |
| `read_multiple_files` | true | false | false | filesystem | yes | yes | yes |
| `list_directory` | true | false | false | filesystem | yes | yes | yes |
| `list_directory_with_sizes` | true | false | false | filesystem | yes | yes | yes |
| `directory_tree` | true | false | false | filesystem | yes | yes | yes |
| `search_files` | true | false | false | filesystem | yes | yes | yes |
| `get_file_info` | true | false | false | filesystem | yes | yes | yes |
| `grep` | true | false | false | filesystem | yes | yes | yes |
| `git_status` | true | false | false | git | yes | yes | yes |
| `git_diff` | true | false | false | git | yes | yes | yes |
| `secret_scan` | true | false | false | review | yes | yes | yes |
| `review_diff` | true | false | false | review | yes | yes | yes |
| `get_platform_info` | true | false | false | platform | yes | yes | yes |
| `get_safety_profile` | true | false | false | platform | yes | yes | yes |
| `write_file` | false | true | false | filesystem | no | yes | yes |
| `edit_file` | false | true | false | filesystem | no | yes | yes |
| `create_directory` | false | false | false | filesystem | no or yes | yes | yes |
| `move_file` | false | true | false | filesystem | no | yes | yes |
| `copy_file` | false | false | false | filesystem | no or yes | yes | yes |
| `delete_file` | false | true | false | filesystem | no | yes | yes |
| `apply_patch` | false | true | false | filesystem | no | yes | yes |
| `zip_create` | false | false | false | release | no or yes | yes | yes |
| `git_add` | false | true | false | git | no | yes | yes |
| `git_commit` | false | true | false | git | no | yes | yes |
| `git_push` | false | true | true | git | no | no | yes |
| `run_tests` | false | false | false | review | yes or assisted | yes | yes |
| `release_review` | false | false | false | release | yes or assisted | yes | yes |
| `shell_execute` | false | true | true | shell | no | no | yes |

Decisions to make explicitly in code comments:

- `run_tests` executes project code. It is not intentionally destructive, but it is not strictly read-only. Set `readOnlyHint:false`, `destructiveHint:false`, `openWorldHint:false` unless a command could reach network. Keep command allowlist.
- `release_review` can run tests and secret scans. It is not intentionally destructive. Set `readOnlyHint:false`, `destructiveHint:false`, `openWorldHint:false`.
- `zip_create` writes an artifact. It is mutating but not destructive. Set `readOnlyHint:false`, `destructiveHint:false`, `openWorldHint:false`.
- `copy_file` writes files but is not destructive unless overwrite. Static annotations cannot depend on args. Prefer `destructiveHint:false`, but description must mention it writes files and can overwrite only with `overwrite:true`. If ChatGPT behavior requires conservative hints, set destructive true. Choose one, document it, test it.
- `create_directory` mutates filesystem but is idempotent. Use `readOnlyHint:false`, `idempotentHint:true`, `destructiveHint:false`.

### 5.3 Stop forcing destructive/open-world hints to false

Current file: `scripts/tool-metadata.mjs`.

Current problem:

```js
annotations: {
  readOnlyHint: tool.annotations?.readOnlyHint ?? false,
  idempotentHint: tool.annotations?.idempotentHint ?? false,
  destructiveHint: false,
  openWorldHint: false
}
```

Replace with risk-aware behavior:

```js
import { applyToolRisk } from './tool-risk.mjs';

export function normalizeToolForAutopilot(tool, options = {}) {
  ...
  const normalized = {
    ...tool,
    name: toCustomToolName(tool.name),
    description,
    _meta: { ...(tool._meta || {}), ...repoRootMetadata }
  };
  return applyToolRisk(normalized);
}
```

Avoid import cycles. If `tool-risk.mjs` needs custom name helpers, either import from `tool-metadata.mjs` carefully or keep a local `stripCustomPrefix` utility.

### 5.4 Apply profile filtering in `listMergedTools()`

Current file: `scripts/authenticated-mcp-wrapper.mjs`.

Pseudo:

```js
import { getSafetyProfile } from './safety-profile.mjs';
import { applyToolRisk, shouldExposeToolForProfile } from './tool-risk.mjs';

const safetyProfile = getSafetyProfile(process.env);

async function listMergedTools() {
  const tools = [];
  ... build filesystem/custom/shell/platform tools ...
  return tools
    .map(applyToolRisk)
    .filter(tool => shouldExposeToolForProfile(tool, safetyProfile));
}
```

Important:

- Do not expose `custom_shell_execute` unless `safetyProfile.exposeShell === true`.
- Do not expose `custom_git_push` unless `safetyProfile.exposeOpenWorldTools === true`.
- Do not expose destructive tools in `safe`.
- In yolo default, existing agent automation behavior remains broad and fast.

### 5.5 Enforce profile in `routeToolCall()`

Do not rely only on hiding tools. A client can call a hidden tool by name.

Before executing any tool:

```js
const safetyProfile = getSafetyProfile(process.env);
const requestedRisk = getToolRisk(upstreamToolName);
if (!shouldAllowToolCallForProfile(upstreamToolName, safetyProfile)) {
  throw new Error(`Tool ${toolName} is disabled by MCP_SAFETY_PROFILE=${safetyProfile.name}.`);
}
```

Rules:

- `shell_execute` rejected unless yolo.
- open-world tools rejected unless yolo.
- destructive tools rejected in safe.
- assisted allows destructive local tools but not raw shell/open-world publishing.

### 5.6 Add `custom_get_safety_profile`

Add a read-only custom tool to expose the current profile.

Output shape:

```json
{
  "profile": "yolo",
  "defaultProfile": "yolo",
  "shellEnabled": true,
  "destructiveToolsEnabled": true,
  "openWorldToolsEnabled": true,
  "serverSideApprovalRequired": false,
  "hostSafetyNotice": "Yolo mode does not bypass ChatGPT host safety, user confirmations, or platform policy.",
  "warnings": [
    "Raw shell can modify or delete files.",
    "Raw shell can run network commands.",
    "Commands are executed as-is by the selected OS shell."
  ]
}
```

Implementation location:

- Prefer `scripts/custom-tools/safety-profile-tool.mjs`, registered through `scripts/custom-tools/index.mjs`.
- Or implement as wrapper-native tool next to `custom_get_platform_info`; choose whichever avoids import cycles and keeps it testable.

### 5.7 Update shell descriptor

Current: `scripts/shell-tool-descriptor.mjs`.

Required changes:

- Keep cross-platform description.
- Keep command-as-is wording.
- Set `openWorldHint:true`, not false.
- Set `destructiveHint:true` because raw shell can modify/delete files.
- Do not present raw shell as read-only or safe merely to reduce ChatGPT confirmations.
- Mention yolo/private mode explicitly.
- Mention that yolo removes only gateway-side restrictions and does not control ChatGPT host confirmations.

Suggested description:

```txt
Execute a shell command on the local machine after authentication. This tool is exposed only in private yolo developer mode. On Windows this uses PowerShell; on Linux/macOS this uses a POSIX shell. Command strings are executed as-is by the selected OS shell; the launcher does not translate PowerShell syntax to POSIX syntax or POSIX syntax to PowerShell. This tool can modify or delete files, run network commands, install packages, publish changes, or access data available to the server process. Use dedicated safer tools when possible. Yolo mode removes extra gateway-side restrictions for trusted local development, but it does not control ChatGPT host confirmations, user confirmations, or platform policy.
```

Annotations:

```js
{
  readOnlyHint: false,
  idempotentHint: false,
  destructiveHint: true,
  openWorldHint: true
}
```

### 5.8 Update platform info

`custom_get_platform_info` should include shell args.

Update `scripts/direct-shell.mjs`:

```js
return {
  platform,
  architecture: os.arch(),
  shell: shell.executable,
  shellArgs: shell.args,
  executionMode: shell.executionMode,
  timeoutMs: DEFAULT_TIMEOUT_MS,
  repoRoot: options.repoRoot,
  trustedRoots: options.trustedRoots
};
```

Test this.

---

## 6. Implementation phase 2: Native MCP Resources

### 6.1 Why Resources

Currently, repo state is mostly retrieved through tools. That works, but MCP Resources are the correct primitive for application-controlled context/data. Resources should expose read-only project state and common context without requiring mutating tool calls.

### 6.2 Server capabilities

Update server capabilities in `createProxyServer()`.

Current:

```js
{ capabilities: { tools: { listChanged: false } } }
```

Target:

```js
{
  capabilities: {
    tools: { listChanged: false },
    resources: { subscribe: false, listChanged: false },
    prompts: { listChanged: false }
  }
}
```

Only advertise prompts after phase 3 is implemented.

Verify exact shape against installed SDK and MCP spec.

### 6.3 Required SDK schema imports

Do not guess names. Inspect `node_modules/@modelcontextprotocol/sdk/types.js` if needed.

Likely names in MCP SDK are similar to:

```js
ListResourcesRequestSchema
ReadResourceRequestSchema
ListResourceTemplatesRequestSchema
```

But verify before import. If names differ, use actual names from installed SDK.

### 6.4 Add `scripts/resources/index.mjs`

Pure resource registry module.

Exports:

```js
export function listRepoResources(context) { ... }
export function listRepoResourceTemplates(context) { ... }
export async function readRepoResource(uri, context) { ... }
```

Context:

```js
{
  resolvedRepoRoots,
  resolvedRepoRoot,
  projectRegistry,
  packageRoot,
  getSafetyProfile,
  executeDirectShell // only if absolutely needed; resources should avoid shell where possible
}
```

Resources must be read-only. Do not mutate files. Avoid running arbitrary shell. If reading git state, prefer `executeGit` helpers from existing custom tools if pure and safe; otherwise use `git` read commands carefully.

### 6.5 Resource URI scheme

Use a repo-specific URI scheme.

Recommended:

```txt
repo://projects
repo://project/{projectId}/summary
repo://project/{projectId}/tree
repo://project/{projectId}/git/status
repo://project/{projectId}/git/diff
repo://project/{projectId}/package
repo://project/{projectId}/readme
repo://project/{projectId}/safety-profile
repo://project/{projectId}/tool-manifest
repo://project/{projectId}/file/{encodedPath}
```

URI rules:

- `projectId` must be validated with existing project-id logic.
- `file/{encodedPath}` path must be URL-decoded and resolved inside one trusted root for that project.
- Do not allow `..` traversal.
- For absolute paths, prefer not to encode raw system paths in URI. Use project-relative paths.
- Resources should not expose local full paths unless `MCP_EXPOSE_PROJECT_PATHS=true` or equivalent.

### 6.6 Minimum static resources

Implement these first:

#### `repo://projects`

Returns JSON summary of configured projects.

Content example:

```json
{
  "projects": [
    {
      "projectId": "agent-mcp-gateway",
      "displayName": "agent-mcp-gateway",
      "default": true
    }
  ],
  "pathExposure": false
}
```

#### `repo://project/{projectId}/summary`

Returns:

```json
{
  "projectId": "agent-mcp-gateway",
  "displayName": "agent-mcp-gateway",
  "defaultRootName": "agent-mcp-gateway",
  "hasPackageJson": true,
  "hasReadme": true,
  "safetyProfile": "yolo"
}
```

#### `repo://project/{projectId}/safety-profile`

Returns same as `custom_get_safety_profile`, but as a read-only resource.

#### `repo://project/{projectId}/tool-manifest`

Returns the tool risk manifest for the current profile:

```json
{
  "profile": "yolo",
  "tools": [
    {
      "name": "custom_shell_execute",
      "category": "shell",
      "readOnlyHint": false,
      "destructiveHint": true,
      "openWorldHint": true,
      "visible": true,
      "reason": "Visible because MCP_SAFETY_PROFILE=yolo."
    }
  ]
}
```

#### `repo://project/{projectId}/readme`

Reads `README.md` if present. Return text/markdown.

#### `repo://project/{projectId}/package`

Reads and parses `package.json` if present. Return JSON text.

#### `repo://project/{projectId}/tree`

Return bounded directory tree:

- exclude `.git`, `node_modules`, `logs`, `packages`, `_zip_temp` by default.
- max depth default 3.
- max entries default 500.
- no file contents.

#### `repo://project/{projectId}/git/status`

Return structured status if project root is a git repo.

- Read-only.
- Should not use shell if existing git utility helper is available.
- If invoking git, use `execFile` with argument array, not shell string.

### 6.7 Resource templates

Add templates if SDK supports them:

```txt
repo://project/{projectId}/file/{path}
repo://project/{projectId}/tree{?depth}
repo://project/{projectId}/git/diff{?staged}
```

Do not implement templates before verifying SDK schema names.

### 6.8 Wrapper handlers

In `createProxyServer()`:

```js
server.setRequestHandler(ListResourcesRequestSchema, async () => {
  return { resources: listRepoResources(context) };
});

server.setRequestHandler(ReadResourceRequestSchema, async request => {
  return await readRepoResource(request.params.uri, context);
});
```

If resource templates supported:

```js
server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => {
  return { resourceTemplates: listRepoResourceTemplates(context) };
});
```

Verify return shapes against SDK examples/spec.

### 6.9 Resource content shape

MCP resource read result should use spec shape. Common shape is:

```json
{
  "contents": [
    {
      "uri": "repo://projects",
      "mimeType": "application/json",
      "text": "{...}"
    }
  ]
}
```

Verify exact field names.

### 6.10 Tests for Resources

Add `tests/resources.test.mjs`.

Test pure registry functions first:

- Lists projects.
- Reads project summary.
- Reads safety profile.
- Reads tool manifest.
- Reads README resource.
- Reads package resource.
- Rejects unknown URI.
- Rejects path traversal in file resource.
- Does not expose full paths when `MCP_EXPOSE_PROJECT_PATHS=false`.

Add wrapper handler test if feasible without starting HTTP server.

---

## 7. Implementation phase 3: Native MCP Prompts

### 7.1 Why Prompts

This repo repeatedly uses long review/audit/fix prompts. MCP Prompts are the correct primitive for server-provided prompt templates/workflows. Implementing prompts reduces copy-paste and makes workflows discoverable.

### 7.2 Required SDK schema imports

Verify names in installed SDK. Likely names:

```js
ListPromptsRequestSchema
GetPromptRequestSchema
```

Do not guess. Inspect SDK types before coding.

### 7.3 Add `scripts/prompts/index.mjs`

Exports:

```js
export function listRepoPrompts(context) { ... }
export function getRepoPrompt(name, args, context) { ... }
```

Prompt list minimum:

1. `review_repo`
2. `security_audit`
3. `cross_platform_review`
4. `release_readiness`
5. `explain_diff`
6. `generate_pr_description`
7. `plan_feature`
8. `fix_with_tests`

### 7.4 Prompt definitions

#### `review_repo`

Arguments:

```json
{
  "projectId": "string",
  "focus": "security,tests,maintainability,docs,release",
  "depth": "quick|normal|deep"
}
```

Prompt must instruct agent to:

- Use Resources first: project summary, README, package, tool manifest.
- Use read-only tools before mutating tools.
- Run tests/review tools only after understanding scope.
- Report findings with severity and paths.

#### `security_audit`

Focus:

- secrets
- auth
- shell/file/network risk
- path traversal
- prompt injection implications
- least privilege
- data leakage

Must reference current safety profile.

#### `cross_platform_review`

Focus:

- Windows/Linux/macOS shell/path/env behavior
- `path` usage
- child process execution
- test coverage
- CI matrix gaps

#### `release_readiness`

Focus:

- clean git state
- tests pass
- secret scan
- runtime schema smoke
- untracked imported files
- package/docs consistency

#### `explain_diff`

Arguments:

```json
{
  "projectId": "string",
  "staged": "boolean"
}
```

#### `generate_pr_description`

Arguments:

```json
{
  "projectId": "string",
  "baseBranch": "string",
  "headBranch": "string"
}
```

#### `plan_feature`

For creating implementation plans like this one.

#### `fix_with_tests`

For agent coding loop.

### 7.5 Prompt result shape

Verify MCP prompt result shape. Common pattern:

```json
{
  "description": "...",
  "messages": [
    {
      "role": "user",
      "content": {
        "type": "text",
        "text": "..."
      }
    }
  ]
}
```

Do not invent non-spec fields.

### 7.6 Handler registration

In `createProxyServer()`:

```js
server.setRequestHandler(ListPromptsRequestSchema, async () => ({
  prompts: listRepoPrompts(context)
}));

server.setRequestHandler(GetPromptRequestSchema, async request => {
  return getRepoPrompt(request.params.name, request.params.arguments || {}, context);
});
```

Add capabilities:

```js
prompts: { listChanged: false }
```

### 7.7 Tests for Prompts

Add `tests/prompts.test.mjs`.

Test:

- `listRepoPrompts()` includes all required prompts.
- `getRepoPrompt()` returns spec-shaped messages.
- Unknown prompt rejected.
- Args validated.
- Prompt text mentions safety profile and command-as-is caveat where relevant.
- Prompts instruct use of resources/read-only tools before destructive tools.

---

## 8. Implementation phase 4: Tool surface expansion/contraction strategy

### 8.1 Principle

Do not add new broad tools unless necessary. Prefer dedicated tools with narrow schemas and strict validation.

### 8.2 Keep current tools but classify and filter

Do not remove existing tools immediately; this could break current workflows. Instead:

- Add risk classification.
- Add profile-based visibility.
- Add `custom_tool_manifest` or resource manifest.
- In safe/assisted profiles, hide or reject high-risk tools.
- In yolo, preserve broad local dev power.

### 8.3 Candidate tools to add later

Add only if they reduce need for raw shell:

#### `custom_git_clone`

Purpose: clone repos into trusted roots without raw shell.

Schema:

```json
{
  "url": "string",
  "destinationRoot": "string",
  "directoryName": "string",
  "depth": 1
}
```

Validation:

- URL must be `https://github.com/...` or allowed configured hosts.
- destinationRoot must be inside trusted roots.
- destination must not exist unless explicit safe behavior is added.
- use `execFile('git', ['clone', ...])`, not shell.
- destructive false, openWorld true because network.
- visible only in yolo unless allowlist says otherwise.

#### `custom_git_checkout_branch`

Purpose: avoid shell for branch switching.

#### `custom_git_pull`

Open-world true. Visible only in yolo by default.

#### `custom_run_package_script`

Purpose: run named package scripts with allowlist.

Schema:

```json
{
  "path": "string",
  "script": "test|build|lint|typecheck",
  "timeoutMs": 300000
}
```

Do not allow arbitrary script by default outside yolo.

#### `custom_install_dependencies`

High risk. Network + can run lifecycle scripts. Keep yolo-only unless implemented with strict package manager options and warnings.

### 8.4 Candidate tools to hide or narrow

In safe mode:

- hide `custom_shell_execute`
- hide `custom_git_push`
- hide filesystem mutators
- possibly hide `custom_run_tests` if public app context is intended

In assisted mode:

- hide `custom_shell_execute`
- hide `custom_git_push`
- allow local file mutators and git commit
- keep release review/test tools

In yolo:

- expose all current tools

---

## 9. Implementation phase 5: Runtime schema smoke test

### 9.1 Why

We already saw a real bug where source description was fixed but runtime tool catalog exposed stale wording. Add a smoke test to catch this.

### 9.2 Add `scripts/smoke-mcp-tools.mjs`

This script should either:

- start the wrapper server on a random/local port and call MCP initialize + tools/list, or
- import pure list functions if server startup is too heavy, plus separately test HTTP in existing smoke endpoint script.

Prefer true MCP tools/list if feasible.

### 9.3 Smoke assertions

In yolo profile:

- `custom_shell_execute` exists.
- `custom_shell_execute.description` does not contain `local Windows machine`.
- Description contains `local machine`.
- Description contains `PowerShell`.
- Description contains `Linux/macOS` and `POSIX shell`.
- Description contains `executed as-is`.
- Description contains `does not translate`.
- `custom_shell_execute.annotations.destructiveHint === true`.
- `custom_shell_execute.annotations.openWorldHint === true`.
- `custom_git_push.annotations.openWorldHint === true`.
- `custom_get_safety_profile` exists.

In safe profile:

- `custom_shell_execute` does not exist.
- `custom_git_push` does not exist.
- read-only tools exist.

In assisted profile:

- `custom_shell_execute` does not exist.
- `custom_git_push` does not exist.
- `custom_edit_file` or equivalent mutating local tools exist.

### 9.4 Package scripts

Add:

```json
{
  "scripts": {
    "smoke:mcp:tools": "node scripts/smoke-mcp-tools.mjs"
  }
}
```

Do not break existing `smoke:mcp`.

### 9.5 Release review integration

Update `custom_release_review` to check:

- untracked imported files
- tool schema smoke if server can be started safely
- no stale shell wording in source/docs except negative tests
- `npm test` pass
- secret scan pass or documented exceptions

Untracked imported files must fail release review.

Implementation idea:

- parse changed/untracked `.mjs` imports or run `node --check`/`npm test` from clean staged state.
- simplest: release review detects `git status --porcelain` untracked files and if any untracked file is imported by tracked files, block.

---

## 10. Docs updates

Update all relevant docs:

### README.md

Add section:

```md
## Safety profiles

`MCP_SAFETY_PROFILE` controls which tools are exposed.

Default is `yolo` because this gateway is intended for private local developer automation.

- `safe`: read-mostly, hides raw shell and destructive/open-world tools.
- `assisted`: exposes local mutating tools but hides raw shell and open-world publishing tools.
- `yolo`: exposes raw shell and open-world tools for private full-trust development.

Yolo mode does not bypass ChatGPT host safety, user confirmations, or platform policy. It only changes which tools this MCP server exposes and how strictly this server filters tool calls.
```

Add section:

```md
## Native MCP Resources and Prompts

This server exposes tools, resources, and prompts.

Resources provide read-only project context such as project list, README, package metadata, git status, safety profile, and tool manifest.

Prompts provide reusable workflows such as repo review, security audit, release readiness, and PR description generation.
```

### README.vi.md

Add equivalent Vietnamese summary.

### SECURITY.md

Add:

- yolo risk statement
- profile behavior table
- server-side validation is still enforced
- ChatGPT host safety cannot be bypassed
- prompt injection assumptions

### .env.example

Add:

```env
# safe | assisted | yolo
# Default is yolo for private local developer automation.
MCP_SAFETY_PROFILE=yolo

# Legacy alias. Prefer MCP_SAFETY_PROFILE.
# SHELL_PROFILE=yolo
```

Also document:

```env
# Deterministic POSIX shell override. Useful on macOS/Linux.
# POSIX_SHELL=/bin/sh

# Deterministic Windows PowerShell override.
# POWERSHELL_EXE=C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe
```

### TODO.md

Update implemented/remaining sections after code is done.

---

## 11. Tests required before finishing

Run:

```bash
npm test
```

Expected:

- All previous tests pass.
- New tests pass.

Add/update tests:

### `tests/safety-profile.test.mjs`

Must cover:

- default is yolo
- safe profile parse
- assisted profile parse
- yolo profile parse
- unknown value behavior
- legacy `SHELL_PROFILE` compatibility
- profile exposure rules

### `tests/tool-risk.test.mjs`

Must cover:

- read tools read-only
- mutating file tools destructive/openWorld false
- shell destructive/openWorld true
- git_push destructive/openWorld true
- run_tests not readOnly but not destructive
- release_review not destructive
- custom prefix and upstream names normalize consistently

### `tests/resources.test.mjs`

Must cover listed resource registry functions.

### `tests/prompts.test.mjs`

Must cover prompt list/get result shapes.

### `tests/shell-policy.test.mjs`

Update existing shell descriptor test:

- openWorld true
- yolo wording
- host safety not bypassed wording

### `tests/custom-tools-registry.test.mjs`

Update expected annotations if existing assertions assume old false destructive/open-world behavior.

### Runtime smoke

Add or update smoke test. If not feasible in unit tests, add npm script and document manual run.

---

## 12. Acceptance criteria / Definition of Done

The implementation is not done until all criteria below are true.

### Safety profile

- [ ] `MCP_SAFETY_PROFILE` exists and defaults to `yolo`.
- [ ] `safe`, `assisted`, `yolo` behavior is implemented.
- [ ] `custom_get_safety_profile` exists and returns accurate profile state.
- [ ] Hidden tools are also blocked at call-time.
- [ ] Yolo mode clearly means no extra gateway-side approval prompts, not control over ChatGPT host confirmations.
- [ ] The implementation does not claim that ChatGPT confirmation UI can be disabled by repo config.

### Tool metadata

- [ ] `normalizeToolForAutopilot()` no longer forces destructive/open-world false.
- [ ] Tool annotations reflect real risk.
- [ ] `custom_shell_execute` has `destructiveHint:true` and `openWorldHint:true`.
- [ ] `custom_git_push` has `destructiveHint:true` and `openWorldHint:true`.
- [ ] Read-only tools have `readOnlyHint:true`.
- [ ] Tool descriptions clearly distinguish dedicated tools from raw shell.

### Resources

- [ ] Server advertises resources capability.
- [ ] `resources/list` implemented.
- [ ] `resources/read` implemented.
- [ ] Project list, summary, safety profile, tool manifest, README, package, tree, git status resources work.
- [ ] Resource URI path traversal is rejected.
- [ ] Resource content follows MCP spec shape.

### Prompts

- [ ] Server advertises prompts capability.
- [ ] `prompts/list` implemented.
- [ ] `prompts/get` implemented.
- [ ] Required prompts exist and return spec-shaped messages.
- [ ] Prompts mention safety profile and prefer resources/read-only tools first.

### Tests and smoke

- [ ] `npm test` passes.
- [ ] Resource tests pass.
- [ ] Prompt tests pass.
- [ ] Safety profile tests pass.
- [ ] Tool risk tests pass.
- [ ] Runtime tools/list smoke detects stale schema.
- [ ] Release review catches untracked imported files.

### Docs

- [ ] README documents safety profiles.
- [ ] README.vi documents safety profiles.
- [ ] SECURITY.md documents yolo and ChatGPT host safety caveat.
- [ ] .env.example documents `MCP_SAFETY_PROFILE`.
- [ ] TODO updated.

### Git hygiene

- [ ] No required imported file is untracked.
- [ ] `.plan/` files are committed only if intentionally desired.
- [ ] `git status --short` is reviewed before commit.
- [ ] Branch is pushed after tests pass.

---

## 13. Suggested implementation order for the next agent

Follow this exact order to reduce risk:

1. Inspect installed MCP SDK exports for resource/prompt schema names.
2. Implement `safety-profile.mjs` and tests.
3. Implement `tool-risk.mjs` and tests.
4. Update `tool-metadata.mjs` and custom tool registry annotations.
5. Update shell descriptor: open-world true and yolo/private wording.
6. Wire profile filtering and call-time enforcement in wrapper.
7. Add `custom_get_safety_profile`.
8. Run `npm test`; fix all annotation expectation failures honestly.
9. Implement Resources registry and tests.
10. Wire Resources handlers/capabilities into wrapper.
11. Implement Prompts registry and tests.
12. Wire Prompts handlers/capabilities into wrapper.
13. Add runtime tools/list smoke.
14. Update release review gate.
15. Update docs.
16. Run `npm test` and smoke scripts.
17. Check `git status --short` for untracked imported files.
18. Commit and push.

---

## 14. Known caution points

### 14.1 `api_tool.list_resources` stale metadata

Earlier, the live tool catalog exposed old `custom_shell_execute` wording even after source was changed. Do not trust source-only tests. Add runtime smoke to prevent this.

### 14.2 `openWorldHint` meaning

Use `openWorldHint:true` for tools that can interact with external systems, publish, fetch, install, push, or run arbitrary network-capable commands. Shell and git push must be open-world.

### 14.3 Yolo default, ChatGPT safety, and confirmation friction

Yolo default is a product decision for this private local gateway. It must be represented honestly, not disguised. The server can expose high-risk tools by default, but descriptions/annotations must make them high-risk.

Yolo means the gateway avoids extra server-side approval prompts and policy gates for a trusted authenticated local user. It does not mean the repo can disable ChatGPT host confirmations. The implementation should reduce unnecessary prompts by making read-only context available through Resources/read-only tools and by offering preview/dry-run flows, not by misclassifying risky tools.

### 14.4 Resources must remain read-only

Do not implement resources that mutate state. If a resource needs computed data, compute read-only. If it needs mutation, it is a tool, not a resource.

### 14.5 Prompts are not hidden tools

Prompts should instruct workflows. They should not pretend to execute actions. They should tell the model what resources/tools to use and in what order.

### 14.6 Public ChatGPT App suitability

This repo with yolo default is suitable for private Developer Mode/local trusted automation. It is not automatically suitable for public app submission. Public-facing configurations should use `MCP_SAFETY_PROFILE=safe` and probably not expose raw shell at all.

---

## 15. Final expected outcome

After this plan is implemented, the repo should be accurately described as:

```txt
A private local developer MCP gateway for ChatGPT/agents with yolo mode enabled by default, honest ChatGPT-compatible safety metadata, first-class safety profiles, native MCP Resources for read-only repo context, native MCP Prompts for reusable workflows, and a tool surface that can be expanded or narrowed by policy without breaking core workflows.
```

The implementation should preserve the current fast local agent workflow while making the server more correct against MCP/ChatGPT Apps design principles. It should reduce avoidable confirmation friction for read-only and preview operations, but it must not misrepresent risky tools or imply control over ChatGPT host confirmation UI.
