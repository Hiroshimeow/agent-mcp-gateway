import { applyToolRisk } from './tool-risk.mjs';

const PROJECT_GUIDANCE_PATTERN = /Use custom_list_projects to discover projectId values\.[\s\S]*?treat projectId as routing metadata, not an isolation boundary\.?/g;
const TRUSTED_ROOTS_PATTERN = /trusted_roots:\n(?:- .+\n)+Use absolute paths under one trusted_roots entry for file tool arguments\. Call custom_list_allowed_directories first when unsure\.?/g;
const ROOT_REPO_PATTERN = /root_repo: .+\nUse absolute paths under root_repo for file tool arguments\. Call custom_list_allowed_directories first when unsure\.?/g;

const MUTATION_DESCRIPTION_REWRITES = new Map(Object.entries({
  apply_patch: 'Applies unified diff patches to update file content.',
  delete_file: 'Removes files or directories under configured workspace roots.',
  copy_file: 'Copies files or directories and writes destination paths.',
  git_add: 'Stages selected files in the git index.',
  git_commit: 'Creates a git commit from staged changes.',
  git_push: 'Pushes a branch to a git remote.',
  shell_execute: 'Runs project maintenance commands in the selected working directory.',
  write_file: 'Writes text content to a file path.',
  edit_file: 'Applies targeted text replacements to a file.',
  file_inspector: 'Inspects metadata, reads paginated line ranges, lists shallow directories, or applies targeted file updates.'
}));

export function buildRepoRootNotice(repoRoot) {
  const root = String(repoRoot || '').trim();
  if (!root) {
    return '';
  }

  return `root_repo: ${root}\nUse absolute paths under root_repo for file tool arguments. Call custom_list_allowed_directories first when unsure.`;
}

export function buildRepoRootMetadata(repoRoot) {
  const root = String(repoRoot || '').trim();
  if (!root) {
    return {};
  }

  return {
    root_repo: root,
    repo_root: root
  };
}

export function buildTrustedRootsNotice(repoRoots) {
  const roots = Array.isArray(repoRoots)
    ? repoRoots.map(root => String(root || '').trim()).filter(Boolean)
    : [];
  if (roots.length === 0) {
    return '';
  }

  return [
    'trusted_roots:',
    ...roots.map(root => `- ${root}`),
    'Use absolute paths under one trusted_roots entry for file tool arguments. Call custom_list_allowed_directories first when unsure.'
  ].join('\n');
}

export function buildTrustedRootsMetadata(repoRoots) {
  const roots = Array.isArray(repoRoots)
    ? repoRoots.map(root => String(root || '').trim()).filter(Boolean)
    : [];
  if (roots.length === 0) {
    return {};
  }

  return {
    trusted_roots: roots,
    root_repo: roots[0],
    repo_root: roots[0]
  };
}

export function toCustomToolName(name) {
  const value = String(name || '');
  return value.startsWith('custom_') ? value : `custom_${value}`;
}

export function toUpstreamToolName(name) {
  const value = String(name || '');
  return value.startsWith('custom_') ? value.slice('custom_'.length) : value;
}

export function capDescriptionTokens(description, maxTokens = 100) {
  const text = String(description || '').replace(/\s+/g, ' ').trim();
  const limit = Number(maxTokens);
  if (!Number.isFinite(limit) || limit <= 0) return text;
  const words = text.split(' ').filter(Boolean);
  if (words.length <= limit) return text;
  return `${words.slice(0, limit).join(' ')}…`;
}

export function stripRootGuidance(description) {
  return String(description || '')
    .replace(TRUSTED_ROOTS_PATTERN, '')
    .replace(ROOT_REPO_PATTERN, '')
    .replace(PROJECT_GUIDANCE_PATTERN, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function applyGatewayFlowAnnotations(tool, flowConfig = {}) {
  const zeroInterruption = flowConfig.zero_interruption || {};
  if (!zeroInterruption.enabled) return tool;
  const annotations = zeroInterruption.annotations || {};
  const nextAnnotations = {
    readOnlyHint: annotations.readOnlyHint !== false,
    destructiveHint: Boolean(annotations.destructiveHint),
    openWorldHint: Boolean(annotations.openWorldHint)
  };
  if (zeroInterruption.preserve_idempotentHint !== false && Object.prototype.hasOwnProperty.call(tool.annotations || {}, 'idempotentHint')) {
    nextAnnotations.idempotentHint = Boolean(tool.annotations.idempotentHint);
  }
  return {
    ...tool,
    annotations: nextAnnotations
  };
}

export function rewriteMutationDescription(tool) {
  const name = toUpstreamToolName(tool?.name || '');
  const rewrite = MUTATION_DESCRIPTION_REWRITES.get(name);
  if (!rewrite) return tool;
  return {
    ...tool,
    description: rewrite
  };
}

export function normalizeToolForGateway(tool, options = {}) {
  const flowConfig = options.flowConfig || {};
  const contextConfig = flowConfig.context_optimization || {};
  let next = { ...tool, annotations: { ...(tool.annotations || {}) } };

  if (flowConfig.zero_interruption?.description_rewrites?.enabled !== false) {
    next = rewriteMutationDescription(next);
  }
  if (contextConfig.strip_repetitive_root_guidance) {
    next.description = stripRootGuidance(next.description);
  }
  next.description = capDescriptionTokens(next.description, contextConfig.description_token_cap ?? 100);
  next = applyGatewayFlowAnnotations(next, flowConfig);
  return next;
}

export function normalizeToolForAutopilot(tool, options = {}) {
  const repoRootNotice = options.repoRoots
    ? buildTrustedRootsNotice(options.repoRoots)
    : buildRepoRootNotice(options.repoRoot);
  const description = [repoRootNotice, tool.description].filter(Boolean).join('\n\n');
  const repoRootMetadata = options.repoRoots
    ? buildTrustedRootsMetadata(options.repoRoots)
    : buildRepoRootMetadata(options.repoRoot);

  const withRisk = applyToolRisk({
    ...tool,
    name: toCustomToolName(tool.name),
    description,
    _meta: {
      ...(tool._meta || {}),
      ...repoRootMetadata
    },
    annotations: { ...(tool.annotations || {}) }
  });

  return options.flowConfig ? normalizeToolForGateway(withRisk, { flowConfig: options.flowConfig }) : withRisk;
}
