import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createAccountStore } from '../scripts/account-store.mjs';
import { createDeviceBroker } from '../scripts/device-broker.mjs';
import { createDeviceStore } from '../scripts/device-store.mjs';
import { createDeviceUsageStore } from '../scripts/device-usage.mjs';
import { startOperatorDashboard } from '../scripts/operator-dashboard-http.mjs';

function publicKeyPem() {
  const { publicKey } = crypto.generateKeyPairSync('ed25519');
  return publicKey.export({ type: 'spki', format: 'pem' });
}

async function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'operator-dashboard-'));
  const dbPath = path.join(dir, 'gateway.sqlite');
  const accountStore = createAccountStore({ dbPath });
  const usageStore = createDeviceUsageStore({ dbPath });
  const deviceStore = createDeviceStore({ dbPath });
  const alice = accountStore.createAccount({ email: 'alice@example.com', password: 'alice-password' });
  const bob = accountStore.createAccount({ email: 'bob@example.com', password: 'bob-password' });
  deviceStore.enroll({ deviceId: 'alice-device', deviceName: 'Workstation', publicKeyPem: publicKeyPem(), ownerAccountId: alice.accountId });
  deviceStore.enroll({ deviceId: 'bob-device', deviceName: 'Workstation', publicKeyPem: publicKeyPem(), ownerAccountId: bob.accountId });
  usageStore.recordToolCall({ accountId: alice.accountId, deviceId: 'alice-device', tool: 'shell_execute', durationMs: 1, success: true, inputBytes: 40, outputBytes: 80, callerCategory: 'oauth' });
  usageStore.recordToolCall({ accountId: alice.accountId, deviceId: 'alice-device', tool: 'read_text_file', durationMs: 1, success: false, errorCode: 'FAIL', inputBytes: 20, outputBytes: 20, callerCategory: 'oauth' });
  usageStore.recordToolCall({ accountId: bob.accountId, deviceId: 'bob-device', tool: 'shell_execute', durationMs: 1, success: true, inputBytes: 100, outputBytes: 300, callerCategory: 'oauth' });
  const broker = createDeviceBroker({ deviceStore, usageStore });
  const server = await startOperatorDashboard({ accountStore, usageStore, deviceBroker: broker, port: 0 });
  const address = server.address();
  return {
    accountStore, usageStore, deviceStore, broker, server, alice, bob,
    base: `http://127.0.0.1:${address.port}`,
    async close() {
      await new Promise(resolve => server.close(resolve));
      await broker.shutdown().catch(() => {});
      usageStore.close(); deviceStore.close(); accountStore.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
}

test('operator dashboard is loopback-only and keeps account/device/tool usage grouped', async () => {
  const f = await fixture();
  try {
    assert.equal(f.server.address().address, '127.0.0.1');
    const response = await fetch(f.base);
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, /Operator account usage/i);
    const aliceStart = html.indexOf('alice@example.com');
    const bobStart = html.indexOf('bob@example.com');
    assert.ok(aliceStart >= 0 && bobStart > aliceStart);
    const aliceSection = html.slice(aliceStart, bobStart);
    const bobSection = html.slice(bobStart);
    assert.match(aliceSection, new RegExp(f.alice.accountId));
    assert.match(aliceSection, /alice-device/);
    assert.match(aliceSection, /shell_execute/);
    assert.match(aliceSection, /read_text_file/);
    assert.match(aliceSection, /<b>2<\/b> calls/i);
    assert.match(aliceSection, /<b>1<\/b> success/i);
    assert.match(aliceSection, /<b>1<\/b> fail/i);
    assert.match(aliceSection, /<b>60 B<\/b> input/i);
    assert.match(aliceSection, /<b>100 B<\/b> output/i);
    assert.match(aliceSection, /<b>~40<\/b> I\/O tokens/i);
    assert.doesNotMatch(aliceSection, /bob-device|bob@example\.com|100 B input|300 B output/);
    assert.match(bobSection, new RegExp(f.bob.accountId));
    assert.match(bobSection, /bob-device/);
    assert.match(bobSection, /shell_execute/);
    assert.match(bobSection, /<b>1<\/b> calls/i);
    assert.match(bobSection, /<b>100 B<\/b> input/i);
    assert.match(bobSection, /<b>300 B<\/b> output/i);
    assert.match(bobSection, /<b>~100<\/b> I\/O tokens/i);
    assert.doesNotMatch(bobSection, /alice-device|read_text_file/);
  } finally { await f.close(); }
});

test('operator dashboard includes lazy 3.5s auto refresh with hidden-tab pause and toggle', async () => {
  const f = await fixture();
  try {
    const html = await (await fetch(f.base)).text();
    assert.match(html, /Auto refresh/);
    assert.match(html, /3500/);
    assert.match(html, /visibilitychange/);
    assert.match(html, /document\.hidden/);
    assert.match(html, /localStorage/);
    assert.match(html, /selection/i);
  } finally { await f.close(); }
});
