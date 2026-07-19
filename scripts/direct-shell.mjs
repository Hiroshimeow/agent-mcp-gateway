import { spawn } from 'node:child_process';
import os from 'node:os';

const DEFAULT_TIMEOUT_MS = 300000;
const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024 * 8;
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

function createCollector(maxBytes) {
  const chunks = [];
  let returnedBytes = 0;
  let totalBytes = 0;
  return {
    push(chunk) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalBytes += buffer.length;
      if (returnedBytes >= maxBytes) return;
      const remaining = maxBytes - returnedBytes;
      const accepted = buffer.subarray(0, remaining);
      chunks.push(accepted);
      returnedBytes += accepted.length;
    },
    result() {
      return {
        text: Buffer.concat(chunks).toString('utf8'),
        totalBytes,
        returnedBytes,
        truncated: totalBytes > returnedBytes
      };
    }
  };
}

export async function executeDirectShell(command, options = {}) {
  const timeoutMs = options.timeout ?? DEFAULT_TIMEOUT_MS;
  const cwd = options.cwd;
  const platform = options.platform || os.platform();
  const baseEnv = options.env || process.env;
  const shell = getDirectShell(platform, baseEnv);
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const startedAt = Date.now();
  const stdoutCollector = createCollector(maxOutputBytes);
  const stderrCollector = createCollector(maxOutputBytes);

  return await new Promise((resolve, reject) => {
    let timedOut = false;
    let settled = false;
    const child = spawn(shell.executable, [...shell.args, command], {
      cwd,
      windowsHide: true,
      env: {
        ...baseEnv,
        PYTHONUTF8: baseEnv.PYTHONUTF8 || '1',
        PYTHONIOENCODING: baseEnv.PYTHONIOENCODING || 'utf-8'
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });

    const timeoutHandle = setTimeout(() => {
      timedOut = true;
      child.kill(platform === 'win32' ? undefined : 'SIGTERM');
    }, Math.max(0, timeoutMs));
    timeoutHandle.unref?.();

    child.stdout.on('data', chunk => stdoutCollector.push(chunk));
    child.stderr.on('data', chunk => stderrCollector.push(chunk));
    child.once('error', error => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutHandle);
      error.durationMs = Date.now() - startedAt;
      reject(error);
    });
    child.once('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutHandle);
      const stdout = stdoutCollector.result();
      const stderr = stderrCollector.result();
      const exitCode = typeof code === 'number' ? code : (timedOut ? 124 : 1);
      resolve({
        command,
        exitCode,
        signal: signal || null,
        stdout: stdout.text,
        stderr: stderr.text,
        durationMs: Date.now() - startedAt,
        timedOut,
        stdoutTruncated: stdout.truncated,
        stderrTruncated: stderr.truncated,
        stdoutBytes: stdout.totalBytes,
        stderrBytes: stderr.totalBytes,
        returnedStdoutBytes: stdout.returnedBytes,
        returnedStderrBytes: stderr.returnedBytes,
        encoding: 'utf-8'
      });
    });
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
