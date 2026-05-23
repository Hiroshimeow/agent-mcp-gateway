import { execFile } from 'node:child_process';
import os from 'node:os';

const DEFAULT_TIMEOUT_MS = 300000;
const MAX_BUFFER_BYTES = 1024 * 1024 * 8;
const DEFAULT_WINDOWS_POWERSHELL = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const DEFAULT_POSIX_SHELL = '/bin/sh';

function cleanEnvValue(value) {
  return String(value ?? '').trim();
}

export function getDirectShell(platform = os.platform(), env = process.env) {
  if (platform === 'win32') {
    return {
      executable: cleanEnvValue(env.POWERSHELL_EXE) || DEFAULT_WINDOWS_POWERSHELL,
      args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command'],
      executionMode: 'direct-wrapper-powershell'
    };
  }

  const executable = cleanEnvValue(env.POSIX_SHELL) || cleanEnvValue(env.SHELL) || DEFAULT_POSIX_SHELL;
  return {
    executable,
    args: ['-c'],
    executionMode: 'direct-wrapper-posix-shell'
  };
}

export async function executeDirectShell(command, options = {}) {
  const timeout = options.timeout ?? DEFAULT_TIMEOUT_MS;
  const cwd = options.cwd;
  const shell = getDirectShell(options.platform, options.env);

  return await new Promise((resolve, reject) => {
    execFile(
      shell.executable,
      [...shell.args, command],
      {
        cwd,
        timeout,
        windowsHide: true,
        maxBuffer: MAX_BUFFER_BYTES
      },
      (error, stdout, stderr) => {
        if (error) {
          const wrapped = new Error(`Command execution failed: ${error.message}${stderr ? `\n${stderr}` : ''}`);
          wrapped.stdout = stdout;
          wrapped.stderr = stderr;
          wrapped.exitCode = typeof error.code === 'number' ? error.code : 1;
          reject(wrapped);
          return;
        }

        resolve({ stdout, stderr, exitCode: 0 });
      }
    );
  });
}

export function getDirectPlatformInfo(options = {}) {
  const platform = options.platform ?? os.platform();
  const shell = getDirectShell(platform, options.env);

  return {
    platform,
    architecture: os.arch(),
    shell: shell.executable,
    shellArgs: shell.args,
    executionMode: shell.executionMode,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    repoRoot: options.repoRoot,
    trustedRoots: options.trustedRoots
  };
}
