import { randomUUID } from 'node:crypto';

const DEFAULT_TTL_MS = 30 * 60 * 1000;

export function createRemoteProcessSessionRegistry(options = {}) {
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const now = options.now || (() => Date.now());
  const sessions = new Map();

  function sweep() {
    const cutoff = now() - ttlMs;
    for (const [sessionId, record] of sessions) {
      if (record.lastUsedAt < cutoff) sessions.delete(sessionId);
    }
  }

  function register({ ownerKey, deviceId, connectionEpoch, executionRuntimeGeneration, remoteSessionId }) {
    sweep();
    if (connectionEpoch === undefined || connectionEpoch === null || String(connectionEpoch).trim() === '') {
      throw new Error('Process session requires a connection epoch.');
    }
    const runtimeGeneration = String(executionRuntimeGeneration || '').trim();
    if (!runtimeGeneration) throw new Error('Process session requires an execution runtime generation.');
    const sessionId = `remote-${randomUUID()}`;
    const createdAt = now();
    sessions.set(sessionId, {
      ownerKey: String(ownerKey || 'anonymous'),
      deviceId: String(deviceId),
      connectionEpoch,
      executionRuntimeGeneration: runtimeGeneration,
      remoteSessionId: String(remoteSessionId),
      createdAt,
      lastUsedAt: createdAt
    });
    return sessionId;
  }

  function resolve({ sessionId, ownerKey }) {
    sweep();
    const record = sessions.get(String(sessionId || ''));
    if (!record) throw new Error(`Unknown or expired process session ${sessionId}.`);
    const caller = String(ownerKey || 'anonymous');
    if (record.ownerKey !== caller) throw new Error('Process session belongs to a different caller.');
    return { ...record };
  }

  function touch({ sessionId, ownerKey }) {
    const record = resolve({ sessionId, ownerKey });
    const current = sessions.get(String(sessionId));
    if (!current) throw new Error(`Unknown or expired process session ${sessionId}.`);
    current.lastUsedAt = now();
    return { ...current };
  }

  function remove({ sessionId, ownerKey }) {
    const record = resolve({ sessionId, ownerKey });
    sessions.delete(String(sessionId));
    return record;
  }

  function removeByDevice(deviceId) {
    const target = String(deviceId || '');
    let removed = 0;
    for (const [sessionId, record] of sessions) {
      if (record.deviceId !== target) continue;
      sessions.delete(sessionId);
      removed += 1;
    }
    return removed;
  }

  function size() {
    sweep();
    return sessions.size;
  }

  return { register, resolve, touch, remove, removeByDevice, size };
}