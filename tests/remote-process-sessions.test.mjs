import test from 'node:test';
import assert from 'node:assert/strict';

import { createRemoteProcessSessionRegistry } from '../scripts/remote-process-sessions.mjs';

test('remote process registry keeps device routing internal and caller-owned', () => {
  let now = 1000;
  const registry = createRemoteProcessSessionRegistry({ ttlMs: 1000, now: () => now });
  const sessionId = registry.register({
    ownerKey: 'caller-a',
    deviceId: 'thinkbook',
    remoteSessionId: 'native-42'
  });

  assert.match(sessionId, /^remote-/);
  assert.deepEqual(registry.resolve({ sessionId, ownerKey: 'caller-a' }), {
    ownerKey: 'caller-a',
    deviceId: 'thinkbook',
    remoteSessionId: 'native-42',
    lastUsedAt: 1000
  });
  assert.throws(
    () => registry.resolve({ sessionId, ownerKey: 'caller-b' }),
    /different caller/
  );

  now = 2501;
  assert.throws(() => registry.resolve({ sessionId, ownerKey: 'caller-a' }), /Unknown or expired/);
});

test('removing a remote process session requires the owning caller', () => {
  const registry = createRemoteProcessSessionRegistry();
  const sessionId = registry.register({ ownerKey: 'a', deviceId: 'g8', remoteSessionId: '99' });
  assert.throws(() => registry.remove({ sessionId, ownerKey: 'b' }), /different caller/);
  assert.equal(registry.size(), 1);
  assert.equal(registry.remove({ sessionId, ownerKey: 'a' }).deviceId, 'g8');
  assert.equal(registry.size(), 0);
});
