import os from 'node:os';

export function normalizeRunnerCommand(runner, platform = process.platform) {
  const value = String(runner ?? '').trim().toLowerCase();
  if (!value) return undefined;
  if (value === 'npx') return platform === 'win32' ? 'npx.cmd' : 'npx';
  throw new Error(`Unsupported MCP runner: ${runner}`);
}

export function expandPlaceholders(value, { repoRoot = process.cwd(), cwd, home = os.homedir(), env = process.env } = {}) {
  if (typeof value !== 'string') return value;
  return value.replace(/\$\{([^}]+)\}/g, (match, name) => {
    if (name === 'repoRoot') return repoRoot;
    if (name === 'home') return home;
    if (name === 'cwd') return cwd || repoRoot;
    if (name.startsWith('env:')) {
      const envName = name.slice(4);
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(envName)) throw new Error(`Invalid env placeholder: ${match}`);
      return env[envName] || '';
    }
    return match;
  });
}

function hasExplicitArgs(serverRaw) {
  return Object.prototype.hasOwnProperty.call(serverRaw, 'args');
}

function withPresetDefaults(serverRaw, defaults) {
  return { ...defaults, ...serverRaw, preset: serverRaw.preset };
}

export function expandMcpPreset(id, serverRaw = {}, context = {}) {
  const preset = String(serverRaw.preset || '').trim().toLowerCase();
  if (!preset) return { ...serverRaw };
  const runnerCommand = normalizeRunnerCommand(serverRaw.runner || 'npx', context.platform);
  const explicitArgs = hasExplicitArgs(serverRaw);

  if (preset === 'eslint') {
    return withPresetDefaults(serverRaw, {
      transport: 'stdio',
      command: serverRaw.command || runnerCommand,
      args: explicitArgs ? serverRaw.args : ['-y', '@eslint/mcp@latest'],
      cwd: serverRaw.cwd || '${repoRoot}',
      startup_timeout_ms: 30000,
      shutdown_timeout_ms: 5000,
      tool_prefix: id
    });
  }

  if (preset === 'context7') {
    return withPresetDefaults(serverRaw, {
      transport: 'http',
      url: 'https://mcp.context7.com/mcp',
      tool_prefix: id
    });
  }

  throw new Error(`Unknown MCP preset for ${id}: ${serverRaw.preset}`);
}
