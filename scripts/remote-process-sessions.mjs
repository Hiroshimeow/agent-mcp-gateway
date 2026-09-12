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

  function register({ ownerKey, deviceId, remoteSessionId }) {
    sweep();
    const sessionId = `remote-${randomUUID()}`;
    sessions.set(sessionId, {
      ownerKey: String(ownerKey || 'anonymous'),
      deviceId: String(deviceId),
      remoteSessionId: String(remoteSessionId),
      lastUsedAt: now()
    });
    return sessionId;
  }

  function resolve({ sessionId, ownerKey }) {
    sweep();
    const record = sessions.get(String(sessionId || ''));
    if (!record) throw new Error(`Unknown or expired process session ${sessionId}.`);
    const caller = String(ownerKey || 'anonymous');
    if (record.ownerKey !== caller) throw new Error('Process session belongs to a different caller.');
    record.lastUsedAt = now();
    return { ...record };
  }

  function remove({ sessionId, ownerKey }) {
    const record = resolve({ sessionId, ownerKey });
    sessions.delete(String(sessionId));
    return record;
  }

  function size() {
    sweep();
    return sessions.size;
  }

  return { register, resolve, remove, size };
}
