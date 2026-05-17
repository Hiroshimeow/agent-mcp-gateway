# Agent Tool Expansion Plan: 16 -> 30 MCP Tools

Date: 2026-05-17
Project: `personal-mcp-launcher`
Primary repo path: `C:\Users\admin\personal-mcp-launcher`

## 0. Purpose

This document is a detailed implementation handoff for a dev agent or human maintainer.

Goal: expand the current MCP tool set from 16 tools to exactly 30 visible `custom_*` tools, while keeping names clear, reducing ambiguity, and making the tools safe enough for a single coding/project-management agent to use without guessing.

This plan intentionally does **not** add dozens of tools. The target is a compact, high-value set:

- keep current filesystem + shell capabilities;
- add focused wrappers for code search, patching, git, packaging, testing, and review;
- avoid overlapping names;
- avoid vague catch-all tools;
- provide structured outputs where possible;
- make every new tool testable.

`.plan/` must remain committed. Do not add `.plan/` to `.gitignore`.

---

## 1. Current state

### 1.1 Existing package scripts

Current `package.json` has:

```json
{
  "scripts": {
    "start:stack": "powershell -ExecutionPolicy Bypass -File .\\scripts\\start-mcp-stack.ps1",
    "stop:stack": "powershell -ExecutionPolicy Bypass -File .\\scripts\\stop-mcp-stack.ps1",
    "test": "node --test tests/*.test.mjs"
  }
}
```

The current test command is:

```powershell
npm test
```

### 1.2 Current `.gitignore`

Current `.gitignore` ignores:

```gitignore
.env
logs/*.log
logs/pids.json
logs/npm-install.log
node_modules/
npm-debug.log*

logs/
```

Do not ignore `.plan/`.

### 1.3 Current public tools: 16

The existing visible tools are:

| # | Tool | Keep? | Notes |
|---:|---|---|---|
| 1 | `custom_read_file` | Keep but deprecated | Existing upstream alias. Do not use in examples. Prefer `custom_read_text_file`. |
| 2 | `custom_read_text_file` | Keep | Main single text file reader. |
| 3 | `custom_read_media_file` | Keep | Image/audio base64 reader. |
| 4 | `custom_read_multiple_files` | Keep | Batch read for related files. |
| 5 | `custom_write_file` | Keep | Create/overwrite entire file. |
| 6 | `custom_edit_file` | Keep | Exact oldText/newText edit. Good for small precise edits. |
| 7 | `custom_create_directory` | Keep | Create directory. |
| 8 | `custom_list_directory` | Keep | Directory listing. |
| 9 | `custom_list_directory_with_sizes` | Keep | Directory listing with sizes. |
| 10 | `custom_directory_tree` | Keep | Recursive JSON tree. |
| 11 | `custom_move_file` | Keep | Move/rename only. |
| 12 | `custom_search_files` | Keep | Glob search by file/path name only. |
| 13 | `custom_get_file_info` | Keep | Metadata. |
| 14 | `custom_list_allowed_directories` | Keep | Must be called when unsure about scope. |
| 15 | `custom_shell_execute` | Keep | Escape hatch for commands not covered by wrappers. |
| 16 | `custom_get_platform_info` | Keep | OS/shell/backend metadata. |

Important: `custom_search_files` searches filenames/paths. It does not search file content. Add `custom_grep` for content search.

---

## 2. Target tool set: exactly 30 visible tools

Add 14 tools:

| # | New tool | Category | Primary reason |
|---:|---|---|---|
| 17 | `custom_grep` | Search | Search text inside files. |
| 18 | `custom_apply_patch` | Edit | Apply multi-file unified patches safely. |
| 19 | `custom_delete_file` | File ops | Delete file/folder without shell. |
| 20 | `custom_copy_file` | File ops | Copy file/folder without shell. |
| 21 | `custom_git_status` | Git | Structured repo status. |
| 22 | `custom_git_diff` | Git | Working/staged diff wrapper. |
| 23 | `custom_git_add` | Git | Stage files safely. |
| 24 | `custom_git_commit` | Git | Commit staged changes. |
| 25 | `custom_git_push` | Git | Push branch. |
| 26 | `custom_zip_create` | Package | Create zip with include/exclude rules. |
| 27 | `custom_secret_scan` | Review | Scan for accidental secrets before publish. |
| 28 | `custom_review_diff` | Review | Review changed/staged code. |
| 29 | `custom_run_tests` | Test | Run project tests with structured output. |
| 30 | `custom_release_review` | Release | Final publish readiness gate. |

Do not add more tools in this phase. If a future agent wants more, create a new `.plan/` document first.

---

## 3. Tool selection guide for agents

This section must be mirrored in README later so any agent can choose the right tool quickly.

### 3.1 Read tools

Use:

- `custom_read_text_file`: read one text file.
- `custom_read_multiple_files`: read 2+ known files at once.
- `custom_read_media_file`: read image/audio.
- `custom_get_file_info`: inspect metadata without reading contents.

Avoid:

- `custom_read_file`: deprecated; only use if older clients still call it.

### 3.2 Search tools

Use:

- `custom_search_files`: find files by glob/path pattern.
- `custom_grep`: search inside file contents.

Examples:

- Find all test files: `custom_search_files(pattern="**/*.test.mjs")`
- Find all env usage: `custom_grep(query="process.env", include=["**/*.mjs"] )`

### 3.3 Edit tools

Use:

- `custom_edit_file`: small exact replacement in one file.
- `custom_apply_patch`: larger changes, multi-file changes, generated diffs.
- `custom_write_file`: create new file or fully replace a file.

Rules:

- Never use `custom_write_file` to edit an existing large source file unless replacing the entire file is intentional.
- Use `dryRun=true` for risky edits before applying.
- Prefer `custom_apply_patch` for multi-file refactors.

### 3.4 File operation tools

Use:

- `custom_create_directory`: create folder.
- `custom_move_file`: rename/move.
- `custom_copy_file`: duplicate file/folder.
- `custom_delete_file`: delete file/folder.

Avoid shell for basic file ops.

### 3.5 Git tools

Use:

- `custom_git_status`: before and after edits.
- `custom_git_diff`: before review/commit.
- `custom_git_add`: stage selected files.
- `custom_git_commit`: create commit.
- `custom_git_push`: publish to remote.

Avoid `custom_shell_execute` for git operations covered by these wrappers.

### 3.6 Test/review/release tools

Use:

- `custom_run_tests`: run `npm test` or configured test command.
- `custom_secret_scan`: before commit and before zip/push.
- `custom_review_diff`: review current changes.
- `custom_release_review`: final checklist before publish.
- `custom_zip_create`: create package artifacts.

### 3.7 Shell fallback

Use `custom_shell_execute` only when:

- there is no dedicated tool;
- the command is needed for debugging;
- the user explicitly asks for a shell command;
- a wrapper tool fails and shell is the only recovery path.

Before using shell for destructive operations, prefer a dedicated tool with path validation.

---

## 4. Global implementation rules

### 4.1 Path safety

Every new file/path tool must validate paths against `resolvedRepoRoots` using the same trust model as existing filesystem tools.

A target path is valid only if:

```text
path.relative(root, targetPath) === '' OR
(!relative.startsWith('..') && !path.isAbsolute(relative))
```

Rules:

- Accept absolute paths under any trusted root.
- Accept relative paths by resolving them under the selected `working_directory` or first trusted root.
- Reject paths outside trusted roots.
- Never follow user-supplied paths into arbitrary system directories.
- Normalize Windows slashes.

### 4.2 Default excludes

Every recursive tool should default exclude:

```text
node_modules/**
.git/**
logs/**
packages/**
_zip_temp/**
```

`custom_secret_scan`, `custom_grep`, `custom_zip_create`, and `custom_release_review` should allow overriding excludes, but should include these defaults unless explicitly disabled.

### 4.3 Output format

For new custom tools, prefer structured JSON in a text response.

Standard success shape:

```json
{
  "ok": true,
  "tool": "custom_tool_name",
  "summary": "Human-readable one-line summary",
  "data": {}
}
```

Standard failure shape:

```json
{
  "ok": false,
  "tool": "custom_tool_name",
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Readable error",
    "details": {}
  }
}
```

Tool calls may still throw errors for severe unexpected failures, but validation errors should be returned cleanly when possible.

### 4.4 Redaction rules

Tools that may expose secrets must redact values.

Redaction format:

```text
first 4 chars + "..." + last 4 chars
```

Example:

```text
ghp_...9abc
```

Never print full values for:

- API keys;
- bearer tokens;
- OAuth secrets;
- passwords;
- private keys;
- `.env` values likely to be sensitive.

### 4.5 Tool annotations

Set annotations carefully:

| Tool | readOnlyHint | idempotentHint | destructiveHint |
|---|---:|---:|---:|
| `custom_grep` | true | true | false |
| `custom_git_status` | true | true | false |
| `custom_git_diff` | true | true | false |
| `custom_secret_scan` | true | true | false |
| `custom_review_diff` | true | true | false |
| `custom_release_review` | true | true | false |
| `custom_run_tests` | false | false | false |
| `custom_apply_patch` | false | false | false |
| `custom_copy_file` | false | false | false |
| `custom_delete_file` | false | false | true |
| `custom_git_add` | false | false | false |
| `custom_git_commit` | false | false | false |
| `custom_git_push` | false | false | false |
| `custom_zip_create` | false | false | false |

Note: the current launcher normalizes destructiveHint to false inside `normalizeToolForAutopilot`. That should be revisited. Destructive tools should carry accurate metadata internally even if a downstream client ignores it.

### 4.6 Naming rules

Use only `custom_verb_noun` or `custom_noun_verb` when that form is already common.

Good names:

```text
custom_git_status
custom_secret_scan
custom_release_review
custom_zip_create
custom_apply_patch
```

Bad names:

```text
custom_manage
custom_do_git
custom_project_magic
custom_runner
custom_helper
```

Every description must start with:

```text
Use this tool to ...
```

Every description must include:

- when to use it;
- when not to use it;
- whether it reads or modifies files;
- path scope rules if applicable.

---

## 5. Recommended code organization

Avoid putting all implementation inside `authenticated-mcp-wrapper.mjs`.

Create:

```text
scripts/custom-tools/
  index.mjs
  path-utils.mjs
  response-utils.mjs
  grep-tool.mjs
  patch-tool.mjs
  file-ops-tools.mjs
  git-tools.mjs
  zip-tool.mjs
  secret-scan-tool.mjs
  review-tools.mjs
  test-tool.mjs
```

### 5.1 `scripts/custom-tools/index.mjs`

Exports:

```js
export function listCustomTools(context) {}
export async function callCustomTool(name, args, context) {}
```

`context` should include:

```js
{
  resolvedRepoRoots,
  resolvedRepoRoot,
  executeDirectShell,
  packageRoot: resolvedRepoRoot
}
```

### 5.2 Integration point

In `scripts/authenticated-mcp-wrapper.mjs`:

1. Import custom tool registry.
2. In `listMergedTools()`, append new tool descriptors after filesystem and shell tools.
3. In `routeToolCall()`, route new tools before falling back to filesystem tools.

Pseudo:

```js
import { listCustomTools, callCustomTool, isLocalCustomTool } from './custom-tools/index.mjs';

async function listMergedTools() {
  const tools = [];
  // existing filesystem tools
  // existing shell tools
  tools.push(...listCustomTools({ resolvedRepoRoots, resolvedRepoRoot }));
  return tools;
}

async function routeToolCall(request) {
  const toolName = request.params.name;
  const upstreamToolName = toUpstreamToolName(toolName);

  if (isLocalCustomTool(upstreamToolName)) {
    return await callCustomTool(upstreamToolName, request.params.arguments || {}, {
      resolvedRepoRoots,
      resolvedRepoRoot,
      executeDirectShell
    });
  }

  // existing shell/filesystem routing
}
```

Important: because `toUpstreamToolName('custom_git_status')` returns `git_status`, the custom tool registry can use upstream-style names internally or custom-style names consistently. Pick one and test it.

Recommended internal names: without prefix.

Example:

```js
const LOCAL_TOOLS = new Map([
  ['git_status', gitStatusTool],
  ['grep', grepTool]
]);
```

---

## 6. Detailed specs for the 14 new tools

## 6.1 `custom_grep`

### Purpose

Search text inside files under trusted roots. This fills the gap left by `custom_search_files`, which only searches file/path names.

### When to use

Use when agent needs to find code/content by text:

- `process.env`
- `TODO`
- `FIXME`
- `shell_execute`
- `Authorization`
- function names
- config keys

### Do not use

- Do not use to find filenames only; use `custom_search_files`.
- Do not search binary files.
- Do not search `.git`, `node_modules`, `logs`, `packages` by default.

### Input schema

```json
{
  "type": "object",
  "properties": {
    "path": { "type": "string", "description": "Directory or file path under a trusted root. Defaults to first trusted root." },
    "query": { "type": "string", "description": "Plain text or regex query." },
    "regex": { "type": "boolean", "default": false },
    "caseSensitive": { "type": "boolean", "default": false },
    "include": { "type": "array", "items": { "type": "string" }, "default": ["**/*"] },
    "exclude": { "type": "array", "items": { "type": "string" }, "default": [] },
    "maxResults": { "type": "number", "default": 100 },
    "contextLines": { "type": "number", "default": 0 }
  },
  "required": ["query"],
  "additionalProperties": false
}
```

### Output data

```json
{
  "matches": [
    {
      "path": "scripts/authenticated-mcp-wrapper.mjs",
      "line": 123,
      "column": 7,
      "preview": "const token = process.env.MCP_BEARER_TOKEN;"
    }
  ],
  "truncated": false,
  "searchedFiles": 42
}
```

### Implementation hints

Preferred implementation: pure Node.js recursion + minimatch-like glob matching if dependency already available. If adding dependency, prefer a small maintained glob package.

Do not shell out to `grep` because Windows portability is required.

### Tests

Create test fixture files under a temp folder.

Test cases:

1. finds plain text in `.mjs` file;
2. case-insensitive default works;
3. `caseSensitive=true` changes results;
4. regex mode works;
5. excludes `node_modules` by default;
6. respects `maxResults` and sets `truncated=true`;
7. rejects path outside trusted root.

---

## 6.2 `custom_apply_patch`

### Purpose

Apply unified diff patches safely, especially for multi-file edits.

### When to use

Use when:

- editing multiple files;
- applying a generated patch;
- refactoring code;
- wanting one atomic-ish edit operation.

### Do not use

- Do not use for a single exact line replacement; use `custom_edit_file`.
- Do not use for creating an entirely new file unless patch format includes it clearly.

### Input schema

```json
{
  "type": "object",
  "properties": {
    "patch": { "type": "string" },
    "workingDirectory": { "type": "string", "description": "Trusted root or subdirectory. Defaults to first trusted root." },
    "dryRun": { "type": "boolean", "default": true },
    "backup": { "type": "boolean", "default": false },
    "rollbackOnFailure": { "type": "boolean", "default": true }
  },
  "required": ["patch"],
  "additionalProperties": false
}
```

### Output data

```json
{
  "applied": false,
  "dryRun": true,
  "files": ["scripts/foo.mjs"],
  "diffSummary": "+12 -3",
  "warnings": []
}
```

### Implementation hints

Options:

1. Use `git apply --check` and `git apply` through `executeDirectShell`.
2. Reject patches that touch paths outside trusted root.
3. For `dryRun=true`, run validation only.
4. For `backup=true`, copy touched files to `.agent/backups/<timestamp>/` before applying.

Recommended first implementation:

- parse file paths from patch headers;
- validate paths;
- write patch to a temporary file under `.agent/tmp/`;
- run `git apply --check <patchfile>`;
- if not dry run, run `git apply <patchfile>`.

Do not store patch temp files permanently.

### Tests

1. dry run valid patch returns `applied=false`;
2. apply valid patch modifies file;
3. invalid patch returns readable error;
4. patch touching `../outside.txt` is rejected;
5. rollback does not leave partial changes;
6. temp patch file is removed after run.

---

## 6.3 `custom_delete_file`

### Purpose

Delete a file or directory under trusted roots without using shell.

### Input schema

```json
{
  "type": "object",
  "properties": {
    "path": { "type": "string" },
    "recursive": { "type": "boolean", "default": false },
    "force": { "type": "boolean", "default": false },
    "dryRun": { "type": "boolean", "default": false }
  },
  "required": ["path"],
  "additionalProperties": false
}
```

### Rules

- File delete works with `recursive=false`.
- Directory delete requires `recursive=true`.
- Reject deleting trusted root itself.
- Reject deleting `.git` unless `force=true` and `allowGitDirectory=true` is introduced in a future phase. For this phase, always reject `.git` deletion.

### Tests

1. deletes a temp file;
2. dry run does not delete;
3. rejects directory without recursive;
4. deletes temp directory with recursive;
5. rejects `.git`;
6. rejects outside trusted root.

---

## 6.4 `custom_copy_file`

### Purpose

Copy a file or directory under trusted roots without using shell.

### Input schema

```json
{
  "type": "object",
  "properties": {
    "source": { "type": "string" },
    "destination": { "type": "string" },
    "recursive": { "type": "boolean", "default": false },
    "overwrite": { "type": "boolean", "default": false },
    "dryRun": { "type": "boolean", "default": false }
  },
  "required": ["source", "destination"],
  "additionalProperties": false
}
```

### Tests

1. copies file;
2. rejects overwrite unless `overwrite=true`;
3. copies directory only with `recursive=true`;
4. dry run does not copy;
5. rejects outside trusted root.

---

## 6.5 `custom_git_status`

### Purpose

Return structured git status for a repo.

### Input schema

```json
{
  "type": "object",
  "properties": {
    "path": { "type": "string", "description": "Repo path under trusted root. Defaults to first trusted root." },
    "includeIgnored": { "type": "boolean", "default": false }
  },
  "additionalProperties": false
}
```

### Output data

```json
{
  "branch": "main",
  "ahead": 0,
  "behind": 0,
  "clean": false,
  "files": [
    { "path": ".plan/agent-tool-expansion-plan.md", "index": "?", "workingTree": "?" }
  ]
}
```

### Implementation hints

Use:

```powershell
git status --porcelain=v1 -b
```

Parse output.

### Tests

1. reports clean repo;
2. reports untracked file;
3. reports modified file;
4. works from subdirectory;
5. returns readable error outside git repo.

---

## 6.6 `custom_git_diff`

### Purpose

Return git diff for working tree or staged changes.

### Input schema

```json
{
  "type": "object",
  "properties": {
    "path": { "type": "string" },
    "staged": { "type": "boolean", "default": false },
    "statOnly": { "type": "boolean", "default": false },
    "files": { "type": "array", "items": { "type": "string" }, "default": [] },
    "maxBytes": { "type": "number", "default": 200000 }
  },
  "additionalProperties": false
}
```

### Output data

```json
{
  "staged": false,
  "stat": "...",
  "diff": "...",
  "truncated": false
}
```

### Rules

- Use `--cached` when `staged=true`.
- Use `--stat` when `statOnly=true`.
- Truncate diff if over `maxBytes` and set `truncated=true`.

### Tests

1. unstaged diff works;
2. staged diff works;
3. file filter works;
4. statOnly does not return full diff;
5. truncation flag works.

---

## 6.7 `custom_git_add`

### Purpose

Stage selected files safely.

### Input schema

```json
{
  "type": "object",
  "properties": {
    "path": { "type": "string" },
    "files": { "type": "array", "items": { "type": "string" } },
    "all": { "type": "boolean", "default": false },
    "dryRun": { "type": "boolean", "default": false }
  },
  "additionalProperties": false
}
```

### Rules

- Require either `files` or `all=true`.
- If `all=true`, run `git add -A`.
- If `files`, validate each file path.
- Dry run should return what would be staged.

### Tests

1. stages one file;
2. stages all changes;
3. rejects empty request;
4. dry run does not stage;
5. rejects outside path.

---

## 6.8 `custom_git_commit`

### Purpose

Create a git commit from staged changes.

### Input schema

```json
{
  "type": "object",
  "properties": {
    "path": { "type": "string" },
    "message": { "type": "string" },
    "allowEmpty": { "type": "boolean", "default": false }
  },
  "required": ["message"],
  "additionalProperties": false
}
```

### Rules

- Reject empty message.
- Reject message containing newline unless future version supports body.
- Before commit, verify staged changes exist unless `allowEmpty=true`.
- Return commit hash.

### Tests

1. commits staged file;
2. rejects no staged changes;
3. rejects empty message;
4. allowEmpty works;
5. returns commit hash.

---

## 6.9 `custom_git_push`

### Purpose

Push current or specified branch to remote.

### Input schema

```json
{
  "type": "object",
  "properties": {
    "path": { "type": "string" },
    "remote": { "type": "string", "default": "origin" },
    "branch": { "type": "string" },
    "setUpstream": { "type": "boolean", "default": false },
    "dryRun": { "type": "boolean", "default": false }
  },
  "additionalProperties": false
}
```

### Rules

- Do not create remotes. Use shell or future tool for `git remote add`.
- If `branch` omitted, detect current branch.
- If `dryRun=true`, run `git push --dry-run`.
- Return stdout/stderr and exit status.

### Tests

Use a local bare repo fixture.

1. pushes branch to local remote;
2. setUpstream works;
3. dry run does not update remote;
4. missing remote returns readable error.

---

## 6.10 `custom_zip_create`

### Purpose

Create zip artifacts without shell-specific `Compress-Archive` problems.

This is needed because log files can be locked and `packages/` can accidentally include the zip itself.

### Input schema

```json
{
  "type": "object",
  "properties": {
    "source": { "type": "string", "description": "Directory under trusted root. Defaults to first trusted root." },
    "destination": { "type": "string", "description": "Zip path under trusted root." },
    "include": { "type": "array", "items": { "type": "string" }, "default": ["**/*"] },
    "exclude": { "type": "array", "items": { "type": "string" }, "default": [] },
    "includeGit": { "type": "boolean", "default": false },
    "overwrite": { "type": "boolean", "default": false },
    "dryRun": { "type": "boolean", "default": false }
  },
  "required": ["destination"],
  "additionalProperties": false
}
```

### Default behavior

Default excludes:

```text
node_modules/**
logs/**
packages/**
_zip_temp/**
```

`.git/**` is excluded unless `includeGit=true`.

### Output data

```json
{
  "destination": "packages/personal-mcp-launcher-full.zip",
  "filesAdded": 25,
  "bytes": 139785,
  "includeGit": true,
  "excluded": ["logs/**", "node_modules/**"]
}
```

### Implementation hints

Use a Node zip library. Recommended: `yazl` or `archiver`.

Do not use PowerShell `Compress-Archive` in this tool.

### Tests

1. creates zip;
2. excludes `logs/` by default;
3. excludes `packages/` to avoid recursive zip;
4. includes `.git` only when `includeGit=true`;
5. refuses overwrite unless `overwrite=true`;
6. dry run reports file list but creates no zip;
7. output zip can be opened/listed.

---

## 6.11 `custom_secret_scan`

### Purpose

Scan files for accidental secrets before commit/publish.

### Input schema

```json
{
  "type": "object",
  "properties": {
    "path": { "type": "string" },
    "include": { "type": "array", "items": { "type": "string" }, "default": ["**/*"] },
    "exclude": { "type": "array", "items": { "type": "string" }, "default": [] },
    "maxFindings": { "type": "number", "default": 100 },
    "failOn": { "type": "string", "enum": ["high", "medium", "low", "none"], "default": "high" }
  },
  "additionalProperties": false
}
```

### Patterns to detect

At minimum:

- generic `PASSWORD=...` or `SECRET=...` in committed files;
- `MCP_AUTH_PASSWORD` with non-placeholder value;
- `MCP_BEARER_TOKEN` with non-empty value;
- `NGROK_AUTHTOKEN`;
- `OPENAI_API_KEY` or `sk-...` patterns;
- GitHub PAT: `ghp_`, `github_pat_`;
- npm token;
- private key block: `-----BEGIN ... PRIVATE KEY-----`;
- JWT-like long token;
- Tailscale auth key patterns if known.

### Rules

- Do not scan ignored huge folders by default.
- Do not print full secrets.
- `.env.example` placeholders should not fail unless realistic secret-like values appear.
- `.env` should be scanned only if explicitly included or if release review wants local safety warning, but it must not print values.

### Output data

```json
{
  "passed": false,
  "counts": { "high": 1, "medium": 2, "low": 0 },
  "findings": [
    {
      "severity": "high",
      "path": "config/example.json",
      "line": 12,
      "rule": "github_pat",
      "redacted": "ghp_...abcd",
      "message": "Possible GitHub personal access token"
    }
  ]
}
```

### Tests

1. detects fake GitHub token;
2. detects private key block;
3. redacts token;
4. placeholder `.env.example` passes;
5. excludes logs by default;
6. respects `maxFindings`.

---

## 6.12 `custom_review_diff`

### Purpose

Review current code changes and return actionable findings.

This is not an LLM inside the tool. It is a deterministic rule-based reviewer that prepares high-signal findings for the agent.

### Input schema

```json
{
  "type": "object",
  "properties": {
    "path": { "type": "string" },
    "staged": { "type": "boolean", "default": false },
    "focus": {
      "type": "array",
      "items": { "type": "string", "enum": ["security", "bugs", "tests", "docs", "release", "maintainability"] },
      "default": ["security", "bugs", "tests"]
    },
    "maxFindings": { "type": "number", "default": 50 }
  },
  "additionalProperties": false
}
```

### Review rules v1

Check diff for:

- adding `.env` or log files;
- adding secrets or token-like values;
- adding shell execution paths without validation;
- changing auth logic;
- changing trusted roots/path validation;
- adding destructive file operations;
- modifying package dependencies;
- modifying tests without source changes or vice versa;
- large generated files accidentally committed;
- TODO/FIXME in changed lines;
- `.plan/` changed but not committed with related implementation.

### Output data

```json
{
  "passed": false,
  "diffScope": "working-tree",
  "findings": [
    {
      "severity": "warning",
      "category": "security",
      "path": "scripts/authenticated-mcp-wrapper.mjs",
      "line": 140,
      "title": "Auth logic changed",
      "detail": "Review OAuth/static bearer behavior before publish.",
      "suggestion": "Run custom_release_review and tests/auth-session.test.mjs."
    }
  ]
}
```

### Tests

1. flags changed auth files;
2. flags token-like added lines;
3. flags added logs;
4. staged mode uses staged diff;
5. returns passed=true for harmless README typo.

---

## 6.13 `custom_run_tests`

### Purpose

Run project tests with structured output.

### Input schema

```json
{
  "type": "object",
  "properties": {
    "path": { "type": "string" },
    "command": { "type": "string", "default": "npm test" },
    "timeoutMs": { "type": "number", "default": 300000 },
    "maxOutputBytes": { "type": "number", "default": 200000 }
  },
  "additionalProperties": false
}
```

### Rules

- Default command is `npm test`.
- Command must run inside a trusted root.
- For v1, allow only safe project test commands:
  - `npm test`
  - `npm run test`
  - `node --test tests/*.test.mjs`
- Do not allow arbitrary command in this wrapper; use `custom_shell_execute` for arbitrary commands.

### Output data

```json
{
  "passed": true,
  "exitCode": 0,
  "command": "npm test",
  "durationMs": 1234,
  "stdout": "...",
  "stderr": "...",
  "truncated": false
}
```

### Tests

1. runs existing `npm test`;
2. rejects arbitrary command like `Remove-Item`;
3. timeout returns readable failure;
4. truncates long output;
5. returns failed status for failing fixture test.

---

## 6.14 `custom_release_review`

### Purpose

Final readiness gate before publish, push, or zip release.

### Input schema

```json
{
  "type": "object",
  "properties": {
    "path": { "type": "string" },
    "requireCleanGit": { "type": "boolean", "default": false },
    "runTests": { "type": "boolean", "default": true },
    "scanSecrets": { "type": "boolean", "default": true },
    "checkPackage": { "type": "boolean", "default": true },
    "checkDocs": { "type": "boolean", "default": true }
  },
  "additionalProperties": false
}
```

### Checks

Run these subchecks:

1. path is git repo;
2. `.gitignore` exists;
3. `.env` is not tracked;
4. `logs/` is not tracked except `.gitkeep` if intentionally used;
5. `node_modules/` is not tracked;
6. package has valid `name`, `version`, `scripts.test`;
7. README exists;
8. SECURITY exists;
9. TODO or `.plan/` exists;
10. run `custom_secret_scan` if enabled;
11. run `custom_run_tests` if enabled;
12. inspect git status;
13. warn if untracked release artifacts exist in `packages/`;
14. warn if branch has no upstream and push is expected.

### Output data

```json
{
  "ready": false,
  "blockers": [
    "Secret scan failed: 1 high severity finding"
  ],
  "warnings": [
    "Git working tree has untracked files"
  ],
  "checks": [
    { "name": "package_json", "status": "pass" },
    { "name": "tests", "status": "pass" },
    { "name": "secret_scan", "status": "fail" }
  ],
  "nextActions": [
    "Remove secret from config/example.json",
    "Run custom_git_status again"
  ]
}
```

### Tests

1. passes on clean fixture repo;
2. fails if `.env` is tracked;
3. fails if secret scan fails;
4. fails if tests fail and `runTests=true`;
5. warns if git dirty and `requireCleanGit=false`;
6. blocks if git dirty and `requireCleanGit=true`.

---

## 7. Implementation phases

## Phase 0: Safety baseline

1. Run:

```powershell
npm test
```

2. Run current status:

```powershell
git status --short
```

3. Confirm `.plan/` is not ignored:

```powershell
git check-ignore -v .plan/agent-tool-expansion-plan.md
```

Expected: no output.

4. Create a working branch if desired:

```powershell
git switch -c feature/custom-agent-tools
```

Do not require branch creation in automated tests.

## Phase 1: Add shared utilities

Create:

```text
scripts/custom-tools/path-utils.mjs
scripts/custom-tools/response-utils.mjs
scripts/custom-tools/index.mjs
```

### `path-utils.mjs`

Functions:

```js
export function normalizeWindowsPath(value) {}
export function resolveInsideTrustedRoots(inputPath, context, options = {}) {}
export function assertInsideTrustedRoots(targetPath, roots) {}
export function toRelativeFromRoot(targetPath, root) {}
export function defaultExcludePatterns(extra = []) {}
```

### `response-utils.mjs`

Functions:

```js
export function ok(tool, summary, data = {}) {}
export function fail(tool, code, message, details = {}) {}
export function textJson(value) {}
export function redactSecret(value) {}
export function truncateText(text, maxBytes) {}
```

## Phase 2: Register tool descriptors

In `scripts/custom-tools/index.mjs`:

- define input schemas;
- define tool descriptors;
- export local tool names;
- implement routing.

Do not wire into wrapper until descriptor tests pass.

## Phase 3: Implement low-risk tools

Implement first:

1. `custom_grep`
2. `custom_copy_file`
3. `custom_delete_file`
4. `custom_git_status`
5. `custom_git_diff`

Reason: these give immediate agent value and are easier to test.

## Phase 4: Implement mutation and packaging tools

Implement:

1. `custom_apply_patch`
2. `custom_git_add`
3. `custom_git_commit`
4. `custom_zip_create`

Run full test suite after each tool.

## Phase 5: Implement push/test/review/release tools

Implement:

1. `custom_git_push`
2. `custom_secret_scan`
3. `custom_review_diff`
4. `custom_run_tests`
5. `custom_release_review`

## Phase 6: Wire into wrapper

Update `authenticated-mcp-wrapper.mjs`:

- import custom registry;
- append descriptors in `listMergedTools()`;
- route calls before filesystem fallback;
- preserve existing OAuth/static bearer behavior;
- preserve existing shell behavior.

## Phase 7: Docs

Update:

```text
README.vi.md
SECURITY.md
TODO.md
```

Add:

- target tool list;
- tool selection guide;
- release workflow:

```text
custom_git_status
custom_secret_scan
custom_review_diff
custom_run_tests
custom_release_review
custom_zip_create
custom_git_add
custom_git_commit
custom_git_push
```

Do not put secrets or real tokens in docs.

---

## 8. Testing plan

### 8.1 Unit tests

Create tests:

```text
tests/path-utils.test.mjs
tests/response-utils.test.mjs
tests/grep-tool.test.mjs
tests/file-ops-tools.test.mjs
tests/git-tools.test.mjs
tests/zip-tool.test.mjs
tests/secret-scan-tool.test.mjs
tests/review-tools.test.mjs
tests/test-tool.test.mjs
tests/release-review.test.mjs
```

Use temporary directories under OS temp, not the real repo.

### 8.2 Integration tests

Add an integration test that:

1. creates a temp git repo;
2. writes `package.json` with `test` script;
3. creates sample source/test files;
4. runs local tool functions directly;
5. verifies status/diff/add/commit/zip/release review.

Avoid requiring network or real GitHub remote.

For push tests, use local bare repo:

```powershell
git init --bare remote.git
git remote add origin <path-to-remote.git>
```

### 8.3 Manual MCP smoke tests

After implementation, start stack and call tools from ChatGPT or MCP Inspector.

Smoke test order:

1. `custom_list_allowed_directories`
2. `custom_get_platform_info`
3. `custom_git_status`
4. `custom_grep(query="custom_shell_execute")`
5. `custom_secret_scan`
6. `custom_run_tests`
7. `custom_release_review`
8. `custom_zip_create(destination="packages/smoke.zip", includeGit=true, overwrite=true)`
9. `custom_delete_file(path="packages/smoke.zip")`

### 8.4 Regression tests for existing behavior

Existing tests must still pass:

```powershell
npm test
```

Ensure:

- OAuth routes still work;
- static bearer still works;
- shell profile behavior unchanged;
- trusted roots still appear in tool descriptions;
- filesystem tools still route to upstream filesystem MCP.

---

## 9. Release workflow for agents

When an agent prepares this repo for publish, use this order:

```text
1. custom_git_status
2. custom_grep for TODO/FIXME/secrets-related strings if needed
3. custom_secret_scan
4. custom_review_diff
5. custom_run_tests
6. custom_release_review
7. custom_zip_create
8. custom_git_add
9. custom_git_commit
10. custom_git_push
```

Do not use `custom_shell_execute` for these steps unless a dedicated tool fails or the user explicitly requests shell.

---

## 10. Acceptance criteria

Implementation is complete only when all criteria pass.

### Tool count

- `listTools()` returns exactly 30 visible `custom_*` tools.
- The 16 old tools still exist.
- The 14 new tools exist with exact names from this plan.

### Naming clarity

- No vague tool names.
- No duplicate capability with different names except the existing deprecated `custom_read_file`.
- Descriptions include when to use and when not to use.

### Safety

- Every path-taking new tool rejects outside trusted roots.
- Delete rejects `.git` deletion.
- Secret scan redacts values.
- Zip excludes `logs/`, `node_modules/`, `packages/`, `_zip_temp/` by default.
- `.plan/` is not ignored.

### Git

- Status/diff/add/commit work on local fixture repo.
- Push works against local bare repo.
- Missing remote errors are readable.

### Tests

- `npm test` passes.
- New unit tests cover success and failure cases.
- Manual MCP smoke tests pass.

### Docs

- README documents new tool categories and suggested workflow.
- SECURITY documents secret scan/release review limitations.
- TODO references this plan as completed or in progress.

---

## 11. Explicit non-goals for this phase

Do not implement these in this phase:

- browser automation tools;
- Docker tools;
- full AST indexer;
- language server integration;
- issue tracker integration;
- remote GitHub API integration;
- actual lazy-loading tool packs;
- custom remote creation tool;
- AI/LLM-based review inside MCP server.

Reason: target is 30 tools max and low ambiguity.

Future lazy tool design can be added later if tool count grows beyond 35. For now, clarity is achieved by naming, descriptions, and categories.

---

## 12. Common mistakes to avoid

1. Do not add `.plan/` to `.gitignore`.
2. Do not implement new tools by blindly shelling out when Node APIs are safer.
3. Do not print secrets in test output.
4. Do not let zip include itself from `packages/`.
5. Do not scan `node_modules` by default.
6. Do not make `custom_run_tests` execute arbitrary shell commands.
7. Do not let `custom_git_add(all=true)` silently stage `.env` if `.env` is not ignored; release review must catch this.
8. Do not remove existing filesystem tools.
9. Do not change OAuth/static bearer behavior while adding tools.
10. Do not hide errors behind generic `Internal server error` if the error is validation-related.

---

## 13. Suggested first coding task for dev agent

Start with the foundation only:

```text
Task 1:
- create scripts/custom-tools/path-utils.mjs
- create scripts/custom-tools/response-utils.mjs
- create tests/path-utils.test.mjs
- create tests/response-utils.test.mjs
- run npm test
```

Then implement `custom_grep` as the first real tool.

Why: content search is the biggest capability gap and will help future agents implement the remaining tools faster.

---

## 14. Final target list

Final visible tools after this plan:

```text
custom_read_file                  # deprecated
custom_read_text_file
custom_read_media_file
custom_read_multiple_files
custom_write_file
custom_edit_file
custom_create_directory
custom_list_directory
custom_list_directory_with_sizes
custom_directory_tree
custom_move_file
custom_search_files
custom_get_file_info
custom_list_allowed_directories
custom_shell_execute
custom_get_platform_info
custom_grep
custom_apply_patch
custom_delete_file
custom_copy_file
custom_git_status
custom_git_diff
custom_git_add
custom_git_commit
custom_git_push
custom_zip_create
custom_secret_scan
custom_review_diff
custom_run_tests
custom_release_review
```

Total: 30 tools.
