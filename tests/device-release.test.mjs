import assert from 'node:assert/strict';
import test from 'node:test';

import {
  compareStableVersions,
  createDeviceReleaseProvider,
  isNewerStableVersion,
  minimumSelfUpdateVersion,
  normalizeStableVersion,
  supportsDeviceSelfUpdate
} from '../scripts/device-release.mjs';

test('stable device versions compare without accepting tags or ranges', () => {
  assert.equal(normalizeStableVersion('1.0.5'), '1.0.5');
  assert.equal(compareStableVersions('1.0.4', '1.0.5'), -1);
  assert.equal(compareStableVersions('1.10.0', '1.9.9'), 1);
  assert.equal(compareStableVersions('2.0.0', '2.0.0'), 0);
  assert.equal(isNewerStableVersion('1.0.4', '1.0.5'), true);
  assert.equal(isNewerStableVersion('1.0.5', '1.0.5'), false);
  assert.throws(() => normalizeStableVersion('latest'));
  assert.throws(() => normalizeStableVersion('1.0.5-beta.1'));
});

test('self-update minimum is platform-aware for legacy Windows clients', () => {
  assert.equal(minimumSelfUpdateVersion('win32'), '1.0.6');
  assert.equal(minimumSelfUpdateVersion('linux'), '1.0.5');
  assert.equal(supportsDeviceSelfUpdate('1.0.5', 'win32'), false);
  assert.equal(supportsDeviceSelfUpdate('1.0.6', 'win32'), true);
  assert.equal(supportsDeviceSelfUpdate('1.0.5', 'linux'), true);
});

test('release provider fetches npm latest and caches it', async () => {
  let calls = 0;
  const provider = createDeviceReleaseProvider({
    ttlMs: 60_000,
    fetchFn: async url => {
      calls += 1;
      assert.match(url, /registry\.npmjs\.org/);
      assert.match(url, /mcp-device\/latest$/);
      return { ok: true, status: 200, async json() { return { version: '1.0.5' }; } };
    }
  });
  assert.equal(await provider.latestVersion(), '1.0.5');
  assert.equal(await provider.latestVersion(), '1.0.5');
  assert.equal(calls, 1);
});

test('release provider fails soft to configured fallback', async () => {
  const provider = createDeviceReleaseProvider({
    fallbackVersion: '1.0.5',
    fetchFn: async () => { throw new Error('offline'); }
  });
  assert.equal(await provider.latestVersion(), '1.0.5');
});
