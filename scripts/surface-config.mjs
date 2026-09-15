const MODES = new Set(['legacy', 'agent', 'native']);

const MODE_POLICIES = Object.freeze({
  legacy: Object.freeze({
    enumerateProjectResources: true,
    enumerateSkillResources: true,
    exposeResourceTemplates: true,
    exposePrompts: true
  }),
  agent: Object.freeze({
    enumerateProjectResources: false,
    enumerateSkillResources: false,
    exposeResourceTemplates: false,
    exposePrompts: true
  }),
  native: Object.freeze({
    enumerateProjectResources: false,
    enumerateSkillResources: false,
    exposeResourceTemplates: true,
    exposePrompts: true
  })
});

function normalizeMode(value, label) {
  const mode = String(value ?? '').trim().toLowerCase();
  if (!MODES.has(mode)) {
    throw new Error(`Invalid ${label}: ${value}. Expected legacy, agent, or native.`);
  }
  return mode;
}

export function loadSurfaceConfig(rawConfig = {}, env = process.env) {
  // Surface mode is an explicit deployment choice. Do not guess from User-Agent
  // or client capabilities because the same client may reconnect with different metadata.
  const envMode = String(env?.MCP_SURFACE_MODE ?? '').trim();
  const configuredMode = rawConfig?.surface?.mode ?? 'agent';
  const mode = envMode
    ? normalizeMode(envMode, 'MCP_SURFACE_MODE')
    : normalizeMode(configuredMode, 'surface.mode');

  return {
    mode,
    ...MODE_POLICIES[mode]
  };
}
