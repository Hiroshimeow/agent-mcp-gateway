export const TOOL_CATEGORIES = {
  filesystem: 'filesystem',
  shell: 'shell',
  platform: 'platform'
};

const READ_ONLY = {
  readOnlyHint: true,
  idempotentHint: true,
  destructiveHint: false,
  openWorldHint: false,
  riskLevel: 'low'
};

const MUTATING_FILE = {
  readOnlyHint: false,
  idempotentHint: false,
  destructiveHint: true,
  openWorldHint: false,
  riskLevel: 'low',
  category: TOOL_CATEGORIES.filesystem
};

const RISK_MAP = new Map(Object.entries({
  read_text_file: { ...READ_ONLY, category: TOOL_CATEGORIES.filesystem },
  write_file: { ...MUTATING_FILE, idempotentHint: true },
  edit_file: { ...MUTATING_FILE },
  list_allowed_directories: { ...READ_ONLY, category: TOOL_CATEGORIES.filesystem },
  image_preview: { ...READ_ONLY, category: TOOL_CATEGORIES.filesystem },
  get_skill: { ...READ_ONLY, category: TOOL_CATEGORIES.platform },
  shell_execute: {
    readOnlyHint: false,
    idempotentHint: false,
    destructiveHint: true,
    openWorldHint: true,
    riskLevel: 'low',
    category: TOOL_CATEGORIES.shell
  }
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
