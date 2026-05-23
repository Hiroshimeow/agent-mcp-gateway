import { grepTool } from './grep-tool.mjs';
import { applyPatchTool } from './patch-tool.mjs';
import { copyFileTool, deleteFileTool } from './file-ops-tools.mjs';
import { gitAddTool, gitCommitTool, gitDiffTool, gitPushTool, gitStatusTool } from './git-tools.mjs';
import { zipCreateTool } from './zip-tool.mjs';
import { secretScanTool } from './secret-scan-tool.mjs';
import { releaseReviewTool, reviewDiffTool } from './review-tools.mjs';
import { runTestsTool } from './test-tool.mjs';
import { fail, ok } from './response-utils.mjs';
import { listProjectSummaries } from '../projects/trusted-roots-projects.mjs';
import { buildSafetyProfileStatus } from '../safety-profile.mjs';
import { applyToolRisk } from '../tool-risk.mjs';

function schema(properties = {}, required = []) {
  return { type: 'object', properties, required, additionalProperties: false };
}

const STRING_ARRAY = { type: 'array', items: { type: 'string' } };

const PROJECT_DISCOVERY_GUIDANCE = 'Use custom_list_projects to discover projectId values. projectId is optional for backward compatibility, but recommended for multi-agent use. If projectId is omitted, the server may infer it from an absolute path or use defaultProjectId. Current filesystem and shell tools still operate over the configured trusted roots; treat projectId as routing metadata, not an isolation boundary.';

function projectToolDescription(description) {
  return `${description}\n\n${PROJECT_DISCOVERY_GUIDANCE}`;
}

function listProjectsTool(args = {}, context = {}) {
  if (!context.projectRegistry) {
    return fail('list_projects', 'PROJECT_REGISTRY_UNAVAILABLE', 'Project registry is not available in this runtime context.');
  }

  const summary = listProjectSummaries(context.projectRegistry, { showPaths: Boolean(args.showPaths) });
  return ok('list_projects', 'Listed configured projects', {
    ...summary,
    guidance: PROJECT_DISCOVERY_GUIDANCE
  });
}

function getSafetyProfileTool(_args = {}, context = {}) {
  return ok('get_safety_profile', 'Reported current MCP safety profile', buildSafetyProfileStatus(context.env || process.env));
}

const TOOL_DEFINITIONS = [
  ['list_projects', 'Use this read-only tool to discover configured projectId values for multi-project workflows. It returns project ids, display names, default project settings, and guidance. It does not expose full local paths by default.', schema({ showPaths: { type: 'boolean', default: false } }), { readOnlyHint: true, idempotentHint: true, destructiveHint: false }, listProjectsTool, false],
  ['get_safety_profile', 'Use this read-only tool to inspect the active MCP safety profile and understand which classes of tools are exposed by the private local gateway.', schema(), { readOnlyHint: true, idempotentHint: true, destructiveHint: false }, getSafetyProfileTool, false],
  ['grep', projectToolDescription('Use this tool to search text inside files under trusted roots. Use it for code/content search; do not use it to search filenames only. It reads files and rejects paths outside trusted roots.'), schema({ path: { type: 'string' }, query: { type: 'string' }, regex: { type: 'boolean', default: false }, caseSensitive: { type: 'boolean', default: false }, include: STRING_ARRAY, exclude: STRING_ARRAY, maxResults: { type: 'number', default: 100 }, contextLines: { type: 'number', default: 0 } }, ['query']), { readOnlyHint: true, idempotentHint: true, destructiveHint: false }, grepTool, true],
  ['apply_patch', projectToolDescription('Use this tool to apply unified diff patches under trusted roots. Use it for multi-file edits; do not use it for a single exact replacement. It modifies files unless dryRun=true and rejects patch paths outside trusted roots. It validates patches with git apply --check before applying.'), schema({ patch: { type: 'string' }, workingDirectory: { type: 'string' }, dryRun: { type: 'boolean', default: true } }, ['patch']), { readOnlyHint: false, idempotentHint: false, destructiveHint: false }, applyPatchTool, true],
  ['delete_file', projectToolDescription('Use this tool to delete a file or directory under trusted roots. Use it for safe file removal; do not use it for .git deletion or deleting a trusted root. It modifies files unless dryRun=true and rejects paths outside trusted roots.'), schema({ path: { type: 'string' }, recursive: { type: 'boolean', default: false }, force: { type: 'boolean', default: false }, dryRun: { type: 'boolean', default: false } }, ['path']), { readOnlyHint: false, idempotentHint: false, destructiveHint: true }, deleteFileTool, true],
  ['copy_file', projectToolDescription('Use this tool to copy a file or directory under trusted roots. Use it for duplication without shell; do not use it outside trusted roots. It writes files unless dryRun=true and validates source and destination paths.'), schema({ source: { type: 'string' }, destination: { type: 'string' }, recursive: { type: 'boolean', default: false }, overwrite: { type: 'boolean', default: false }, dryRun: { type: 'boolean', default: false } }, ['source', 'destination']), { readOnlyHint: false, idempotentHint: false, destructiveHint: false }, copyFileTool, true],
  ['git_status', projectToolDescription('Use this tool to return structured git status for a repo under trusted roots. Use it before and after edits; do not use it outside git repositories. It reads git state and does not modify files.'), schema({ path: { type: 'string' }, includeIgnored: { type: 'boolean', default: false } }), { readOnlyHint: true, idempotentHint: true, destructiveHint: false }, gitStatusTool, true],
  ['git_diff', projectToolDescription('Use this tool to return working-tree or staged git diff under trusted roots. Use it before review/commit; do not use it for non-git directories. It reads git state and does not modify files.'), schema({ path: { type: 'string' }, staged: { type: 'boolean', default: false }, statOnly: { type: 'boolean', default: false }, files: STRING_ARRAY, maxBytes: { type: 'number', default: 200000 } }), { readOnlyHint: true, idempotentHint: true, destructiveHint: false }, gitDiffTool, true],
  ['git_add', projectToolDescription('Use this tool to stage selected files safely under trusted roots. Use it instead of shell git add; do not use it with neither files nor all=true. It modifies git index and validates file paths.'), schema({ path: { type: 'string' }, files: STRING_ARRAY, all: { type: 'boolean', default: false }, dryRun: { type: 'boolean', default: false } }), { readOnlyHint: false, idempotentHint: false, destructiveHint: false }, gitAddTool, true],
  ['git_commit', projectToolDescription('Use this tool to create a git commit from staged changes under trusted roots. Use it after review/tests; do not use it with empty or multiline messages. It modifies git history.'), schema({ path: { type: 'string' }, message: { type: 'string' }, allowEmpty: { type: 'boolean', default: false } }, ['message']), { readOnlyHint: false, idempotentHint: false, destructiveHint: false }, gitCommitTool, true],
  ['git_push', projectToolDescription('Use this tool to push a current or specified branch to a remote. Use it after release review; do not use it to create remotes. It sends git data to the configured remote and does not alter files directly.'), schema({ path: { type: 'string' }, remote: { type: 'string', default: 'origin' }, branch: { type: 'string' }, setUpstream: { type: 'boolean', default: false }, dryRun: { type: 'boolean', default: false } }), { readOnlyHint: false, idempotentHint: false, destructiveHint: false }, gitPushTool, true],
  ['zip_create', projectToolDescription('Use this tool to create zip artifacts under trusted roots. Use it for release packages; do not use shell Compress-Archive. It writes a zip unless dryRun=true and excludes node_modules, logs, packages, _zip_temp, and .git by default unless includeGit=true.'), schema({ source: { type: 'string' }, destination: { type: 'string' }, include: STRING_ARRAY, exclude: STRING_ARRAY, includeGit: { type: 'boolean', default: false }, overwrite: { type: 'boolean', default: false }, dryRun: { type: 'boolean', default: false } }, ['destination']), { readOnlyHint: false, idempotentHint: false, destructiveHint: false }, zipCreateTool, true],
  ['secret_scan', projectToolDescription('Use this tool to scan files for accidental secrets under trusted roots. Use it before commit/publish; do not use it to print secret values. It reads files, excludes large ignored folders by default, and redacts findings.'), schema({ path: { type: 'string' }, include: STRING_ARRAY, exclude: STRING_ARRAY, maxFindings: { type: 'number', default: 100 }, failOn: { type: 'string', enum: ['high', 'medium', 'low', 'none'], default: 'high' } }), { readOnlyHint: true, idempotentHint: true, destructiveHint: false }, secretScanTool, true],
  ['review_diff', projectToolDescription('Use this tool to run deterministic review checks on changed or staged code. Use it before commit; do not treat it as an AI code review replacement. It reads git diff and does not modify files.'), schema({ path: { type: 'string' }, staged: { type: 'boolean', default: false }, focus: { type: 'array', items: { type: 'string', enum: ['security', 'bugs', 'tests', 'docs', 'release', 'maintainability'] } }, maxFindings: { type: 'number', default: 50 } }), { readOnlyHint: true, idempotentHint: true, destructiveHint: false }, reviewDiffTool, true],
  ['run_tests', projectToolDescription('Use this tool to run project tests with structured output. Use it for npm test or the configured safe test commands; do not use it for arbitrary shell commands. It may execute project code but does not intentionally modify files.'), schema({ path: { type: 'string' }, command: { type: 'string', default: 'npm test' }, timeoutMs: { type: 'number', default: 300000 }, maxOutputBytes: { type: 'number', default: 200000 } }), { readOnlyHint: false, idempotentHint: false, destructiveHint: false }, runTestsTool, true],
  ['release_review', projectToolDescription('Use this tool to run a final readiness gate before publish, push, or zip release. Use it after tests/review; do not use it as a replacement for human release judgment. It reads repo state and can run tests/secret scan but does not intentionally modify files.'), schema({ path: { type: 'string' }, requireCleanGit: { type: 'boolean', default: false }, runTests: { type: 'boolean', default: true }, scanSecrets: { type: 'boolean', default: true }, checkPackage: { type: 'boolean', default: true }, checkDocs: { type: 'boolean', default: true } }), { readOnlyHint: true, idempotentHint: true, destructiveHint: false }, releaseReviewTool, true]
];

const LOCAL_TOOLS = new Map(
  TOOL_DEFINITIONS.map(([name, description, inputSchema, annotations, handler, projectScoped = true]) => [
    name,
    { name, description, inputSchema, annotations, handler, projectScoped }
  ])
);

export function isLocalCustomTool(name) {
  return LOCAL_TOOLS.has(String(name || '').replace(/^custom_/, ''));
}

export function listCustomTools(context = {}) {
  const meta = { trusted_roots: context.resolvedRepoRoots || [], root_repo: context.resolvedRepoRoot, repo_root: context.resolvedRepoRoot };
  return [...LOCAL_TOOLS.values()].map(tool => applyToolRisk({
    name: `custom_${tool.name}`,
    description: tool.description,
    inputSchema: tool.inputSchema,
    annotations: { ...tool.annotations },
    _meta: meta
  }));
}

export async function callCustomTool(name, args = {}, context = {}) {
  const localName = String(name || '').replace(/^custom_/, '');
  const tool = LOCAL_TOOLS.get(localName);
  if (!tool) return fail(localName || 'unknown', 'UNKNOWN_TOOL', `Unknown custom tool: ${name}`);
  return await tool.handler(args || {}, context);
}

export const LOCAL_TOOL_NAMES = [...LOCAL_TOOLS.keys()];
export const LOCAL_PROJECT_DISCOVERY_GUIDANCE = PROJECT_DISCOVERY_GUIDANCE;
