export const SAFETY_PROFILE_NAMES = ['safe', 'assisted', 'yolo'];

export const DEFAULT_SAFETY_PROFILE = 'yolo';

export const HOST_SAFETY_NOTICE = 'Yolo mode does not bypass ChatGPT host safety, user confirmations, or platform policy.';

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

export function normalizeSafetyProfileName(value) {
  const raw = String(value ?? '').trim().toLowerCase();
  return SAFETY_PROFILE_NAMES.includes(raw) ? raw : DEFAULT_SAFETY_PROFILE;
}

export function getSafetyProfile(env = process.env) {
  const raw = String(env.MCP_SAFETY_PROFILE || env.SHELL_PROFILE || DEFAULT_SAFETY_PROFILE).trim().toLowerCase();
  const name = normalizeSafetyProfileName(raw);
  return SAFETY_PROFILES[name];
}

export function buildSafetyProfileStatus(env = process.env) {
  const profile = getSafetyProfile(env);
  const warnings = [];
  if (profile.exposeShell) {
    warnings.push('Raw shell can modify or delete files.');
    warnings.push('Raw shell can run network commands.');
    warnings.push('Commands are executed as-is by the selected OS shell.');
  }
  if (profile.exposeOpenWorldTools) {
    warnings.push('Open-world tools can interact with external systems such as git remotes or networks.');
  }

  return {
    profile: profile.name,
    defaultProfile: DEFAULT_SAFETY_PROFILE,
    shellEnabled: profile.exposeShell,
    destructiveToolsEnabled: profile.exposeDestructiveTools,
    openWorldToolsEnabled: profile.exposeOpenWorldTools,
    serverSideApprovalRequired: profile.requireServerSideApproval,
    hostSafetyNotice: HOST_SAFETY_NOTICE,
    warnings
  };
}
