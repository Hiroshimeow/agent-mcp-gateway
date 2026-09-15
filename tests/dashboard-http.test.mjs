import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import express from 'express';

import { createAccountStore } from '../scripts/account-store.mjs';
import { installAccountRoutes } from '../scripts/account-http.mjs';
import { installDashboardRoutes } from '../scripts/dashboard-http.mjs';
import { createDeviceBroker } from '../scripts/device-broker.mjs';
import { createDeviceStore } from '../scripts/device-store.mjs';
import { createDeviceUsageStore } from '../scripts/device-usage.mjs';

function publicKeyPem() {
  return generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }).toString();
}

async function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hcu-dashboard-'));
  const dbPath = path.join(dir, 'gateway.sqlite');
  const accountStore = createAccountStore({ dbPath });
  const usageStore = createDeviceUsageStore({ dbPath });
  const deviceStore = createDeviceStore({ dbPath });
  const alice = accountStore.createAccount({ email: 'alice@example.com', password: 'alice-password' });
  const bob = accountStore.createAccount({ email: 'bob@example.com', password: 'bob-password' });
  const admin = accountStore.createAdmin({ email: 'admin@example.com', password: 'admin-password' });
  const aliceBrowser = accountStore.createSession(alice.accountId);
  const bobBrowser = accountStore.createSession(bob.accountId);
  const adminBrowser = accountStore.createSession(admin.accountId);

  deviceStore.enroll({ deviceId: 'alice-device', deviceName: 'Alice Workstation', publicKeyPem: publicKeyPem(), ownerAccountId: alice.accountId, agentVersion: 'ignored' });
  deviceStore.enroll({ deviceId: 'bob-device', deviceName: 'Bob Secret Workstation', publicKeyPem: publicKeyPem(), ownerAccountId: bob.accountId });

  usageStore.openActivitySession({ activitySessionId: 'alice-activity', accountId: alice.accountId, clientId: 'chatgpt-alice' });
  usageStore.openActivitySession({ activitySessionId: 'bob-activity', accountId: bob.accountId, clientId: 'chatgpt-bob' });
  usageStore.recordToolCall({
    accountId: alice.accountId, activitySessionId: 'alice-activity', deviceId: 'alice-device', tool: 'shell_execute',
    durationMs: 12, success: true, inputBytes: 100, outputBytes: 200, callerCategory: 'oauth'
  });
  usageStore.recordToolCall({
    accountId: alice.accountId, activitySessionId: 'alice-activity', tool: 'get_skill', skillName: 'mcp_builder',
    durationMs: 2, success: false, errorCode: 'UNKNOWN_SKILL', inputBytes: 20, outputBytes: 401, callerCategory: 'oauth'
  });
  usageStore.recordToolCall({
    accountId: bob.accountId, activitySessionId: 'bob-activity', deviceId: 'bob-device', tool: 'read_text_file',
    durationMs: 1, success: true, inputBytes: 10, outputBytes: 20, callerCategory: 'oauth'
  });
  usageStore.recordCatalogList({
    accountId: alice.accountId, activitySessionId: 'alice-activity', toolCount: 16, schemaBytes: 15297,
    estimatedTokens: 3825, estimationMethod: 'utf8_bytes_div_4_estimate'
  });
  usageStore.setSchemaSnapshot({
    toolCount: 16, schemaBytes: 15297, estimatedTokens: 3825, estimationMethod: 'utf8_bytes_div_4_estimate'
  });

  const broker = createDeviceBroker({ deviceStore, usageStore });
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use(express.json());
  const accountHttp = installAccountRoutes(app, { accountStore, needInvite: false });
  installDashboardRoutes(app, {
    accountFromRequest: accountHttp.accountFromRequest,
    usageStore,
    deviceBroker: broker
  });
  const server = await new Promise(resolve => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  broker.attach(server);
  const base = `http://127.0.0.1:${server.address().port}`;

  return {
    dir, dbPath, accountStore, usageStore, deviceStore, broker, server, base,
    alice, bob, admin,
    aliceCookie: `hcu_account_session=${encodeURIComponent(aliceBrowser.sessionId)}`,
    bobCookie: `hcu_account_session=${encodeURIComponent(bobBrowser.sessionId)}`,
    adminCookie: `hcu_account_session=${encodeURIComponent(adminBrowser.sessionId)}`,
    close: async () => {
      await broker.shutdown();
      await new Promise(resolve => server.close(resolve));
      deviceStore.close();
      usageStore.close();
      accountStore.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
}

function cookieValue(response, name) {
  const raw = response.headers.get('set-cookie') || '';
  const match = raw.match(new RegExp(`${name}=([^;]+)`));
  return match ? decodeURIComponent(match[1]) : null;
}

function form(data) {
  return new URLSearchParams(data).toString();
}

async function post(base, route, data, cookie) {
  return fetch(`${base}${route}`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
    body: form(data)
  });
}

test('dashboard is user-only, account-isolated, compact, and labels token values as estimates', async () => {
  const f = await fixture();
  try {
    const anonymous = await fetch(`${f.base}/dashboard`, { redirect: 'manual' });
    assert.equal(anonymous.status, 302);
    assert.match(anonymous.headers.get('location'), /^\/login\?return_to=/);

    const admin = await fetch(`${f.base}/dashboard`, { headers: { cookie: f.adminCookie }, redirect: 'manual' });
    assert.equal(admin.status, 302);

    const response = await fetch(`${f.base}/dashboard`, { headers: { cookie: f.aliceCookie } });
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, /alice@example\.com/);
    assert.match(html, /Alice Workstation/);
    assert.match(html, /alice-device/);
    assert.doesNotMatch(html, /Bob Secret Workstation|bob-device|bob-activity|bob@example\.com/);
    assert.match(html, /Gateway\s+online/i);
    assert.match(html, /16\s+tools/i);
    assert.match(html, /15,297|15297/);
    assert.match(html, /estimated/i);
    assert.match(html, /not billing/i);
    assert.match(html, /shell_execute/);
    assert.match(html, /mcp_builder/);
    assert.match(html, /UNKNOWN_SKILL/);
    assert.match(html, /alice-activity/);
    assert.doesNotMatch(html, /command|payload body/i);
    assert.ok(cookieValue(response, 'hcu_dashboard_csrf'));
  } finally { await f.close(); }
});

test('dashboard mutations require CSRF and cannot mutate another account resources', async () => {
  const f = await fixture();
  try {
    const page = await fetch(`${f.base}/dashboard`, { headers: { cookie: f.aliceCookie } });
    const html = await page.text();
    const csrf = cookieValue(page, 'hcu_dashboard_csrf');
    assert.ok(csrf);
    assert.match(html, new RegExp(`name="_csrf" value="${csrf}"`));
    const cookies = `${f.aliceCookie}; hcu_dashboard_csrf=${encodeURIComponent(csrf)}`;

    const noCsrf = await post(f.base, '/dashboard/devices/alice-device/rename', { device_name: 'Nope' }, f.aliceCookie);
    assert.equal(noCsrf.status, 403);
    assert.equal(f.deviceStore.get('alice-device').deviceName, 'Alice Workstation');

    const bobRename = await post(f.base, '/dashboard/devices/bob-device/rename', { _csrf: csrf, device_name: 'Stolen' }, cookies);
    assert.equal(bobRename.status, 404);
    assert.equal(f.deviceStore.get('bob-device').deviceName, 'Bob Secret Workstation');

    const renamed = await post(f.base, '/dashboard/devices/alice-device/rename', { _csrf: csrf, device_name: 'Alice Renamed' }, cookies);
    assert.equal(renamed.status, 303);
    assert.equal(f.deviceStore.get('alice-device').deviceName, 'Alice Renamed');

    const bobEnd = await post(f.base, '/dashboard/sessions/bob-activity/end', { _csrf: csrf }, cookies);
    assert.equal(bobEnd.status, 404);
    assert.equal(f.usageStore.listActivitySessions(f.bob.accountId)[0].endedAt, null);

    const ended = await post(f.base, '/dashboard/sessions/alice-activity/end', { _csrf: csrf }, cookies);
    assert.equal(ended.status, 303);
    assert.ok(f.usageStore.listActivitySessions(f.alice.accountId)[0].endedAt);

    const bobRevoke = await post(f.base, '/dashboard/devices/bob-device/revoke', { _csrf: csrf }, cookies);
    assert.equal(bobRevoke.status, 404);
    assert.equal(f.deviceStore.get('bob-device').revokedAt, null);

    const revoked = await post(f.base, '/dashboard/devices/alice-device/revoke', { _csrf: csrf }, cookies);
    assert.equal(revoked.status, 303);
    assert.ok(f.deviceStore.get('alice-device').revokedAt);

    const getMutation = await fetch(`${f.base}/dashboard/devices/bob-device/revoke`, { headers: { cookie: cookies } });
    assert.equal(getMutation.status, 404);
  } finally { await f.close(); }
});
