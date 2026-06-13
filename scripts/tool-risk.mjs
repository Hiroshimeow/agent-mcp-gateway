export const TOOL_CATEGORIES = {
  filesystem: 'filesystem',
  git: 'git',
  review: 'review',
  release: 'release',
  shell: 'shell',
  project: 'project',
  platform: 'platform'
};

const READ_ONLY = {
  readOnlyHint: true,
  idempotentHint: true,
  destructiveHint: false,
  openWorldHint: false,
  riskLevel: 'low'
};

const MUTATING = {
  readOnlyHint: false,
  idempotentHint: false,
  destructiveHint: true,
  openWorldHint: false,
  riskLevel: 'low'
};

const RISK_MAP = new Map(Object.entries({
  list_projects: { ...READ_ONLY, category: TOOL_CATEGORIES.project },
  list_allowed_directories: { ...READ_ONLY, category: TOOL_CATEGORIES.filesystem },
  read_file: { ...READ_ONLY, category: TOOL_CATEGORIES.filesystem },
  read_text_file: { ...READ_ONLY, category: TOOL_CATEGORIES.filesystem },
  read_media_file: { ...READ_ONLY, category: TOOL_CATEGORIES.filesystem },
  read_multiple_files: { ...READ_ONLY, category: TOOL_CATEGORIES.filesystem },
  list_directory: { ...READ_ONLY, category: TOOL_CATEGORIES.filesystem },
  list_directory_with_sizes: { ...READ_ONLY, category: TOOL_CATEGORIES.filesystem },
  directory_tree: { ...READ_ONLY, category: TOOL_CATEGORIES.filesystem },
  search_files: { ...READ_ONLY, category: TOOL_CATEGORIES.filesystem },
  get_file_info: { ...READ_ONLY, category: TOOL_CATEGORIES.filesystem },
  grep: { ...READ_ONLY, category: TOOL_CATEGORIES.filesystem },
  file_inspector: { ...MUTATING, destructiveHint: false, category: TOOL_CATEGORIES.filesystem },
  git_status: { ...READ_ONLY, category: TOOL_CATEGORIES.git },
  git_diff: { ...READ_ONLY, category: TOOL_CATEGORIES.git },
  secret_scan: { ...READ_ONLY, category: TOOL_CATEGORIES.review },
  review_diff: { ...READ_ONLY, category: TOOL_CATEGORIES.review },
  get_platform_info: { ...READ_ONLY, category: TOOL_CATEGORIES.platform },
  get_safety_profile: { ...READ_ONLY, category: TOOL_CATEGORIES.platform },

  write_file: { ...MUTATING, category: TOOL_CATEGORIES.filesystem },
  edit_file: { ...MUTATING, category: TOOL_CATEGORIES.filesystem },
  move_file: { ...MUTATING, category: TOOL_CATEGORIES.filesystem },
  delete_file: { ...MUTATING, category: TOOL_CATEGORIES.filesystem },
  apply_patch: { ...MUTATING, category: TOOL_CATEGORIES.filesystem },
  git_add: { ...MUTATING, category: TOOL_CATEGORIES.git },
  git_commit: { ...MUTATING, category: TOOL_CATEGORIES.git },
  git_push: { readOnlyHint: false, idempotentHint: false, destructiveHint: true, openWorldHint: true, riskLevel: 'low', category: TOOL_CATEGORIES.git },
  shell_execute: { readOnlyHint: false, idempotentHint: false, destructiveHint: true, openWorldHint: true, riskLevel: 'low', category: TOOL_CATEGORIES.shell },

  // Idempotent or non-destructive writes. These still mutate state, so readOnlyHint is false.
  create_directory: { readOnlyHint: false, idempotentHint: true, destructiveHint: false, openWorldHint: false, riskLevel: 'low', category: TOOL_CATEGORIES.filesystem },
  copy_file: { readOnlyHint: false, idempotentHint: false, destructiveHint: false, openWorldHint: false, riskLevel: 'low', category: TOOL_CATEGORIES.filesystem },
  zip_create: { readOnlyHint: false, idempotentHint: false, destructiveHint: false, openWorldHint: false, riskLevel: 'low', category: TOOL_CATEGORIES.release },
  run_tests: { readOnlyHint: false, idempotentHint: false, destructiveHint: false, openWorldHint: false, riskLevel: 'low', category: TOOL_CATEGORIES.review },
  release_review: { readOnlyHint: false, idempotentHint: false, destructiveHint: false, openWorldHint: false, riskLevel: 'low', category: TOOL_CATEGORIES.release }
}));

export function normalizeRiskToolName(toolOrName) {
  const name = typeof toolOrName === 'string' ? toolOrName : toolOrName?.name;
  const value = String(name || '');
  return value.startsWith('custom_') ? value.slice('custom_'.length) : value;
}

export function getToolRisk(toolOrName) {
  const name = normalizeRiskToolName(toolOrName);
  return RISK_MAP.get(name) || {
    readOnlyHint: false,
    idempotentHint: false,
    destructiveHint: false,
    openWorldHint: false,
    riskLevel: 'unknown',
    category: 'unknown'
  };
}

export function applyToolRisk(tool) {
  const risk = getToolRisk(tool);
  return {
    ...tool,
    annotations: {
      ...(tool.annotations || {}),
      readOnlyHint: risk.readOnlyHint,
      idempotentHint: risk.idempotentHint,
      destructiveHint: risk.destructiveHint,
      openWorldHint: risk.openWorldHint
    },
    _meta: {
      ...(tool._meta || {}),
      riskLevel: risk.riskLevel,
      category: risk.category,
      profileVisibility: {
        safe: shouldExposeToolForProfile(tool, { name: 'safe', exposeShell: false, exposeDestructiveTools: false, exposeOpenWorldTools: false }),
        assisted: shouldExposeToolForProfile(tool, { name: 'assisted', exposeShell: false, exposeDestructiveTools: true, exposeOpenWorldTools: false }),
        yolo: shouldExposeToolForProfile(tool, { name: 'yolo', exposeShell: true, exposeDestructiveTools: true, exposeOpenWorldTools: true })
      }
    }
  };
}

export function shouldExposeToolForProfile(toolOrName, safetyProfile) {
  const name = normalizeRiskToolName(toolOrName);
  const risk = getToolRisk(toolOrName);
  if (name === 'shell_execute') return Boolean(safetyProfile.exposeShell);
  if (risk.openWorldHint && !safetyProfile.exposeOpenWorldTools) return false;
  if (risk.destructiveHint && !safetyProfile.exposeDestructiveTools) return false;
  return true;
}

export function assertToolAllowedForProfile(toolOrName, safetyProfile) {
  if (!shouldExposeToolForProfile(toolOrName, safetyProfile)) {
    const name = typeof toolOrName === 'string' ? toolOrName : toolOrName?.name;
    throw new Error(`Tool ${name} is disabled by MCP_SAFETY_PROFILE=${safetyProfile.name}.`);
  }
}

export function buildToolRiskManifest(tools, safetyProfile) {
  return tools.map(tool => {
    const risk = getToolRisk(tool);
    const visible = shouldExposeToolForProfile(tool, safetyProfile);
    return {
      name: tool.name,
      category: risk.category,
      riskLevel: risk.riskLevel,
      readOnlyHint: risk.readOnlyHint,
      idempotentHint: risk.idempotentHint,
      destructiveHint: risk.destructiveHint,
      openWorldHint: risk.openWorldHint,
      visible,
      reason: visible ? `Visible because MCP_SAFETY_PROFILE=${safetyProfile.name}.` : `Hidden because MCP_SAFETY_PROFILE=${safetyProfile.name}.`
    };
  });
}
