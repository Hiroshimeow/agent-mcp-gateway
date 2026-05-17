import { execFile } from 'node:child_process';
import os from 'node:os';

function getWindowsPowerShell() {
  return 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
}

export async function executeDirectShell(command, options = {}) {
  const timeout = options.timeout ?? 300000;
  const cwd = options.cwd;

  return await new Promise((resolve, reject) => {
    execFile(
      getWindowsPowerShell(),
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command],
      {
        cwd,
        timeout,
        windowsHide: true,
        maxBuffer: 1024 * 1024 * 8
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
  return {
    platform: os.platform(),
    architecture: os.arch(),
    shell: getWindowsPowerShell(),
    executionMode: 'direct-wrapper-powershell',
    timeoutMs: 300000,
    repoRoot: options.repoRoot,
    trustedRoots: options.trustedRoots
  };
}
