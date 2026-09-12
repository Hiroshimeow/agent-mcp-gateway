import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import os from 'node:os';

import { getDirectShell } from './direct-shell.mjs';

const DEFAULT_INITIAL_WAIT_MS = 10000;
const MAX_INITIAL_WAIT_MS = 30000;
const DEFAULT_COMPLETED_TTL_MS = 5 * 60 * 1000;
const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;
const DEFAULT_MAX_SESSIONS = 32;

function normalizeWait(value, defaultValue = DEFAULT_INITIAL_WAIT_MS) {
  if (value === undefined) return defaultValue;
  if (!Number.isInteger(value) || value < 0 || value > MAX_INITIAL_WAIT_MS) {
    throw new Error(`timeout_ms must be an integer between 0 and ${MAX_INITIAL_WAIT_MS}.`);
  }
  return value;
}

function appendBounded(session, text, maxBytes) {
  if (!text) return;
  session.output += text;
  while (Buffer.byteLength(session.output, 'utf8') > maxBytes && session.output.length > 0) {
    const excess = Buffer.byteLength(session.output, 'utf8') - maxBytes;
    let removeChars = Math.max(1, Math.min(session.output.length, excess));
    while (removeChars < session.output.length && Buffer.byteLength(session.output.slice(removeChars), 'utf8') > maxBytes) {
      removeChars += 1;
    }
    session.output = session.output.slice(removeChars);
    session.baseOffset += removeChars;
    session.outputTruncated = true;
  }
}

function publicState(session) {
  return {
    sessionId: session.id,
    status: session.status,
    exitCode: session.exitCode,
    signal: session.signal,
    output: session.output,
    baseOffset: session.baseOffset,
    nextOffset: session.baseOffset + session.output.length,
    outputTruncated: session.outputTruncated
  };
}

function getOwnedSession(sessions, sessionId, ownerKey) {
  const session = sessions.get(String(sessionId || ''));
  if (!session) throw new Error('Unknown or expired process session.');
  if (session.ownerKey !== ownerKey) throw new Error('Process session does not belong to this caller.');
  return session;
}

async function waitForExit(session, timeoutMs) {
  if (session.status !== 'RUNNING') return;
  await Promise.race([
    session.exitPromise,
    new Promise(resolve => setTimeout(resolve, timeoutMs))
  ]);
}

async function terminateChild(child, platform) {
  if (!child || child.exitCode !== null || child.killed) return;
  if (platform === 'win32' && child.pid) {
    await new Promise(resolve => {
      const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore'
      });
      killer.once('error', resolve);
      killer.once('close', resolve);
    });
    return;
  }
  child.kill('SIGTERM');
}

export function createProcessSessionManager(options = {}) {
  const sessions = new Map();
  const getShell = options.getShell || getDirectShell;
  const platform = options.platform || os.platform();
  const env = options.env || process.env;
  const completedTtlMs = options.completedTtlMs ?? DEFAULT_COMPLETED_TTL_MS;
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const maxSessions = options.maxSessions ?? DEFAULT_MAX_SESSIONS;
  const now = options.now || Date.now;

  function cleanup() {
    const current = now();
    for (const [id, session] of sessions) {
      if (session.status !== 'RUNNING' && session.completedAt !== null && current - session.completedAt > completedTtlMs) {
        sessions.delete(id);
      }
    }
  }

  function enforceCapacity() {
    cleanup();
    if (sessions.size < maxSessions) return;
    const completed = [...sessions.values()]
      .filter(session => session.status !== 'RUNNING')
      .sort((a, b) => (a.completedAt ?? 0) - (b.completedAt ?? 0));
    while (sessions.size >= maxSessions && completed.length) sessions.delete(completed.shift().id);
    if (sessions.size >= maxSessions) throw new Error('Process session capacity reached. Terminate an active session before starting another.');
  }

  async function start({ command, cwd, ownerKey, timeoutMs, baseEnv = env }) {
    enforceCapacity();
    const waitMs = normalizeWait(timeoutMs);
    const shell = getShell(platform, baseEnv);
    const child = spawn(shell.executable, [...shell.args, command], {
      cwd,
      windowsHide: true,
      env: {
        ...baseEnv,
        PYTHONUTF8: baseEnv.PYTHONUTF8 || '1',
        PYTHONIOENCODING: baseEnv.PYTHONIOENCODING || 'utf-8'
      },
      stdio: ['pipe', 'pipe', 'pipe']
    });

    const session = {
      id: randomUUID(),
      ownerKey,
      child,
      status: 'RUNNING',
      exitCode: null,
      signal: null,
      output: '',
      baseOffset: 0,
      outputTruncated: false,
      completedAt: null,
      exitPromise: null
    };
    session.exitPromise = new Promise(resolve => {
      child.stdout.on('data', chunk => appendBounded(session, chunk.toString('utf8'), maxOutputBytes));
      child.stderr.on('data', chunk => appendBounded(session, chunk.toString('utf8'), maxOutputBytes));
      child.once('error', error => {
        appendBounded(session, `\n${error.message}`, maxOutputBytes);
        session.status = 'FAILED';
        session.exitCode = 1;
        session.completedAt = now();
        resolve();
      });
      child.once('close', (code, signal) => {
        if (session.status === 'CANCELLED') {
          session.exitCode = typeof code === 'number' ? code : null;
        } else {
          session.exitCode = typeof code === 'number' ? code : 1;
          session.status = session.exitCode === 0 ? 'COMPLETED' : 'FAILED';
        }
        session.signal = signal || null;
        session.completedAt = now();
        resolve();
      });
    });
    sessions.set(session.id, session);
    await waitForExit(session, waitMs);
    return publicState(session);
  }

  function read({ sessionId, ownerKey, offset, length = 8192 }) {
    cleanup();
    const session = getOwnedSession(sessions, sessionId, ownerKey);
    const requestedOffset = Number.isInteger(offset) && offset >= 0 ? offset : session.baseOffset;
    const pageLength = Number.isInteger(length) && length > 0 ? Math.min(length, 65536) : 8192;
    const effectiveOffset = Math.max(requestedOffset, session.baseOffset);
    const relative = effectiveOffset - session.baseOffset;
    const output = session.output.slice(relative, relative + pageLength);
    return {
      sessionId: session.id,
      status: session.status,
      exitCode: session.exitCode,
      signal: session.signal,
      output,
      offset: effectiveOffset,
      nextOffset: effectiveOffset + output.length,
      baseOffset: session.baseOffset,
      availableUntil: session.baseOffset + session.output.length,
      outputTruncated: session.outputTruncated
    };
  }

  async function interact({ sessionId, ownerKey, input, timeoutMs = 0 }) {
    cleanup();
    const session = getOwnedSession(sessions, sessionId, ownerKey);
    if (session.status !== 'RUNNING') throw new Error(`Process session is ${session.status}; stdin is no longer writable.`);
    const data = String(input ?? '');
    await new Promise((resolve, reject) => session.child.stdin.write(data, error => error ? reject(error) : resolve()));
    await waitForExit(session, normalizeWait(timeoutMs, 0));
    return publicState(session);
  }

  async function terminate({ sessionId, ownerKey }) {
    cleanup();
    const session = getOwnedSession(sessions, sessionId, ownerKey);
    if (session.status === 'RUNNING') {
      session.status = 'CANCELLED';
      await terminateChild(session.child, platform);
      await Promise.race([session.exitPromise, new Promise(resolve => setTimeout(resolve, 2000))]);
      if (session.completedAt === null) session.completedAt = now();
    }
    return publicState(session);
  }

  async function shutdown() {
    await Promise.all([...sessions.values()]
      .filter(session => session.status === 'RUNNING')
      .map(async session => {
        session.status = 'CANCELLED';
        await terminateChild(session.child, platform).catch(() => {});
      }));
  }

  return { start, read, interact, terminate, shutdown, cleanup };
}
