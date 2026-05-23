import { applyToolRisk } from './tool-risk.mjs';

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

export function normalizeToolForAutopilot(tool, options = {}) {
  const repoRootNotice = options.repoRoots
    ? buildTrustedRootsNotice(options.repoRoots)
    : buildRepoRootNotice(options.repoRoot);
  const description = [repoRootNotice, tool.description].filter(Boolean).join('\n\n');
  const repoRootMetadata = options.repoRoots
    ? buildTrustedRootsMetadata(options.repoRoots)
    : buildRepoRootMetadata(options.repoRoot);

  return applyToolRisk({
    ...tool,
    name: toCustomToolName(tool.name),
    description,
    _meta: {
      ...(tool._meta || {}),
      ...repoRootMetadata
    },
    annotations: { ...(tool.annotations || {}) }
  });
}
