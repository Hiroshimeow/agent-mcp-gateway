import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DEFAULT_TIMEOUT_MS = 300000;
export const DEFAULT_SHELL_RESPONSE_BUDGET_BYTES = 128 * 1024;
const DEFAULT_TOTAL_PREVIEW_BYTES = 8 * 1024;
const DEFAULT_COMMAND_PREVIEW_BYTES = 1024;
const DEFAULT_CAPTURE_OUTPUT_BYTES = 64 * 1024;
const DEFAULT_WINDOWS_POWERSHELL = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const DEFAULT_POSIX_SHELL = '/bin/sh';
const SPILL_PREFIX = 'mcp-shell-';
const SPILL_TTL_MS = 24 * 60 * 60 * 1000;
const SPILL_MAX_FILES = 32;
const SPILL_MAX_BYTES = 256 * 1024 * 1024;

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

function cleanupSpills(directory) {
  fs.mkdirSync(directory, { recursive: true });
  const now = Date.now();
  let entries = fs.readdirSync(directory, { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.startsWith(SPILL_PREFIX))
    .map(entry => {
      const filePath = path.join(directory, entry.name);
      const stat = fs.statSync(filePath);
      return { filePath, mtimeMs: stat.mtimeMs, size: stat.size };
    })
    .sort((a, b) => a.mtimeMs - b.mtimeMs);

  for (const entry of entries.filter(entry => now - entry.mtimeMs > SPILL_TTL_MS)) {
    fs.rmSync(entry.filePath, { force: true });
  }
  entries = entries.filter(entry => fs.existsSync(entry.filePath));
  let bytes = entries.reduce((sum, entry) => sum + entry.size, 0);
  while (entries.length >= SPILL_MAX_FILES || bytes >= SPILL_MAX_BYTES) {
    const entry = entries.shift();
    if (!entry) break;
    fs.rmSync(entry.filePath, { force: true });
    bytes -= entry.size;
  }
}

function appendTail(current, chunk, maxBytes) {
  if (maxBytes <= 0) return Buffer.alloc(0);
  if (chunk.length >= maxBytes) return chunk.subarray(chunk.length - maxBytes);
  if (current.length + chunk.length <= maxBytes) return Buffer.concat([current, chunk]);
  const keep = maxBytes - chunk.length;
  return Buffer.concat([current.subarray(current.length - keep), chunk]);
}

function createCollector(captureBytes, { spillDirectory, streamName }) {
  const budget = Math.max(0, Number(captureBytes) || 0);
  const headLimit = Math.ceil(budget / 2);
  const tailLimit = budget - headLimit;
  let chunks = [];
  let bufferedBytes = 0;
  let totalBytes = 0;
  let head = Buffer.alloc(0);
  let tail = Buffer.alloc(0);
  let spillPath = null;
  let spillFd = null;

  function openSpill() {
    if (spillFd !== null) return;
    if (!spillDirectory) return;
    cleanupSpills(spillDirectory);
    spillPath = path.join(spillDirectory, `${SPILL_PREFIX}${Date.now()}-${process.pid}-${randomUUID()}-${streamName}.bin`);
    spillFd = fs.openSync(spillPath, 'wx');
    for (const chunk of chunks) fs.writeSync(spillFd, chunk);
    chunks = [];
    bufferedBytes = 0;
  }

  return {
    push(value) {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      totalBytes += chunk.length;

      if (head.length < headLimit) {
        const accepted = chunk.subarray(0, headLimit - head.length);
        head = Buffer.concat([head, accepted]);
      }
      tail = appendTail(tail, chunk, tailLimit);

      if (spillFd !== null) {
        fs.writeSync(spillFd, chunk);
        return;
      }
      if (bufferedBytes + chunk.length <= budget) {
        chunks.push(chunk);
        bufferedBytes += chunk.length;
        return;
      }
      openSpill();
      if (spillFd !== null) fs.writeSync(spillFd, chunk);
    },
    bytes() {
      return totalBytes;
    },
    result(previewBytes) {
      const previewBudget = Math.max(0, Math.min(budget, Number(previewBytes) || 0));
      const truncated = totalBytes > previewBudget;
      if (truncated && spillFd === null) openSpill();
      if (spillFd !== null) {
        fs.closeSync(spillFd);
        spillFd = null;
      }
      if (!truncated) {
        const raw = Buffer.concat(chunks);
        return {
          text: raw.toString('utf8'),
          totalBytes,
          returnedBytes: raw.length,
          headBytes: raw.length,
          tailBytes: 0,
          truncated: false,
          spillPath: null
        };
      }
      const previewHeadBytes = Math.ceil(previewBudget / 2);
      const previewTailBytes = previewBudget - previewHeadBytes;
      const previewHead = head.subarray(0, previewHeadBytes);
      const previewTail = previewTailBytes > 0 ? tail.subarray(Math.max(0, tail.length - previewTailBytes)) : Buffer.alloc(0);
      const marker = `\n... [truncated; full raw output: ${spillPath}] ...\n`;
      return {
        text: `${previewHead.toString('utf8')}${marker}${previewTail.toString('utf8')}`,
        totalBytes,
        returnedBytes: previewHead.length + previewTail.length,
        headBytes: previewHead.length,
        tailBytes: previewTail.length,
        truncated: true,
        spillPath
      };
    },
    dispose() {
      if (spillFd !== null) {
        fs.closeSync(spillFd);
        spillFd = null;
      }
    }
  };
}

function previewCommand(command, maxBytes = DEFAULT_COMMAND_PREVIEW_BYTES) {
  const raw = Buffer.from(String(command), 'utf8');
  const totalBytes = raw.length;
  const budget = Math.max(0, Number(maxBytes) || 0);
  if (totalBytes <= budget) {
    return { text: String(command), totalBytes, returnedBytes: totalBytes, truncated: false };
  }

  const marker = `\n... [command truncated; ${totalBytes} bytes total] ...\n`;
  const markerBytes = Buffer.byteLength(marker);
  const previewBytes = Math.max(0, budget - markerBytes);
  const headBudget = Math.ceil(previewBytes / 2);
  const tailBudget = previewBytes - headBudget;

  let headEnd = Math.min(raw.length, headBudget);
  while (headEnd > 0 && headEnd < raw.length && (raw[headEnd] & 0xc0) === 0x80) headEnd -= 1;
  let tailStart = Math.max(0, raw.length - tailBudget);
  while (tailStart < raw.length && (raw[tailStart] & 0xc0) === 0x80) tailStart += 1;

  const text = `${raw.subarray(0, headEnd).toString('utf8')}${marker}${raw.subarray(tailStart).toString('utf8')}`;
  return { text, totalBytes, returnedBytes: Buffer.byteLength(text), truncated: true };
}

function allocatePreviewBudgets(stdoutBytes, stderrBytes, totalPreviewBytes) {
  const totalBudget = Math.max(0, Number(totalPreviewBytes) || 0);
  if (stdoutBytes + stderrBytes <= totalBudget) return { stdout: stdoutBytes, stderr: stderrBytes };

  let stdout = Math.min(stdoutBytes, Math.ceil(totalBudget / 2));
  let stderr = Math.min(stderrBytes, totalBudget - stdout);
  let remaining = totalBudget - stdout - stderr;

  if (remaining > 0) {
    const stdoutExtra = Math.min(remaining, Math.max(0, stdoutBytes - stdout));
    stdout += stdoutExtra;
    remaining -= stdoutExtra;
  }
  if (remaining > 0) stderr += Math.min(remaining, Math.max(0, stderrBytes - stderr));
  return { stdout, stderr };
}

export async function executeDirectShell(command, options = {}) {
  const timeoutMs = options.timeout ?? DEFAULT_TIMEOUT_MS;
  const cwd = options.cwd;
  const platform = options.platform || os.platform();
  const baseEnv = options.env || process.env;
  const shell = getDirectShell(platform, baseEnv);
  const totalPreviewBytes = options.maxOutputBytes ?? DEFAULT_TOTAL_PREVIEW_BYTES;
  const commandPreview = previewCommand(command);
  const captureBytes = Math.max(DEFAULT_CAPTURE_OUTPUT_BYTES, Number(totalPreviewBytes) || 0);
  const spillDirectory = options.spillDirectory || path.join(os.tmpdir(), 'agent-mcp-gateway-shell-output');
  const startedAt = Date.now();
  const stdoutCollector = createCollector(captureBytes, { spillDirectory, streamName: 'stdout' });
  const stderrCollector = createCollector(captureBytes, { spillDirectory, streamName: 'stderr' });

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
      stdoutCollector.dispose();
      stderrCollector.dispose();
      error.durationMs = Date.now() - startedAt;
      reject(error);
    });
    child.once('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutHandle);
      const previewBudgets = allocatePreviewBudgets(stdoutCollector.bytes(), stderrCollector.bytes(), totalPreviewBytes);
      const stdout = stdoutCollector.result(previewBudgets.stdout);
      const stderr = stderrCollector.result(previewBudgets.stderr);
      const exitCode = typeof code === 'number' ? code : (timedOut ? 124 : 1);
      resolve({
        command: commandPreview.text,
        commandBytes: commandPreview.totalBytes,
        returnedCommandBytes: commandPreview.returnedBytes,
        commandTruncated: commandPreview.truncated,
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
        stdoutHeadBytes: stdout.headBytes,
        stdoutTailBytes: stdout.tailBytes,
        stderrHeadBytes: stderr.headBytes,
        stderrTailBytes: stderr.tailBytes,
        stdoutSpillPath: stdout.spillPath,
        stderrSpillPath: stderr.spillPath,
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
