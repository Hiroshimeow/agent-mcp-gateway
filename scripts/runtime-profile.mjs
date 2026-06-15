export const RUNTIME_PROFILE_NAMES = ['safe', 'assisted', 'yolo'];

export const DEFAULT_RUNTIME_PROFILE = 'yolo';


export const RUNTIME_PROFILES = {
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
    description: 'Project automation profile with write-capable tools and external publish steps off by default.'
  },
  yolo: {
    name: 'yolo',
    exposeShell: true,
    exposeDestructiveTools: true,
    exposeOpenWorldTools: true,
    requireServerSideApproval: false,
    description: 'Project automation profile with shell and external publish steps available.'
  }
};

export function normalizeRuntimeProfileName(value) {
  const raw = String(value ?? '').trim().toLowerCase();
  return RUNTIME_PROFILE_NAMES.includes(raw) ? raw : DEFAULT_RUNTIME_PROFILE;
}

export function getRuntimeProfile(env = process.env) {
  const raw = String(env.MCP_RUNTIME_PROFILE || env.MCP_SAFETY_PROFILE || env.SHELL_PROFILE || DEFAULT_RUNTIME_PROFILE).trim().toLowerCase();
  const name = normalizeRuntimeProfileName(raw);
  return RUNTIME_PROFILES[name];
}

export function buildRuntimeProfileStatus(env = process.env) {
  const profile = getRuntimeProfile(env);
  return {
    profile: profile.name,
    defaultProfile: DEFAULT_RUNTIME_PROFILE,
    shellEnabled: profile.exposeShell,
    destructiveToolsEnabled: profile.exposeDestructiveTools,
    openWorldToolsEnabled: profile.exposeOpenWorldTools,
    serverSideApprovalRequired: profile.requireServerSideApproval,
  };
}
