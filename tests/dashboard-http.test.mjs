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
import { SQLiteAuthState } from '../scripts/auth-session.mjs';
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

  deviceStore.enroll({ deviceId: 'alice-device', deviceName: 'Alice Workstation', publicKeyPem: publicKeyPem(), ownerAccountId: alice.accountId, agentVersion: 'ignored', packageVersion: '1.0.5' });
  deviceStore.enroll({ deviceId: 'alice-laptop', deviceName: 'Alice Laptop', publicKeyPem: publicKeyPem(), ownerAccountId: alice.accountId, packageVersion: '1.0.4' });
  deviceStore.enroll({ deviceId: 'alice-idle', deviceName: 'Alice Idle', publicKeyPem: publicKeyPem(), ownerAccountId: alice.accountId });
  deviceStore.enroll({ deviceId: 'bob-device', deviceName: 'Bob Secret Workstation', publicKeyPem: publicKeyPem(), ownerAccountId: bob.accountId });

  usageStore.openActivitySession({ activitySessionId: 'alice-activity', accountId: alice.accountId, clientId: 'chatgpt-alice' });
  usageStore.openActivitySession({ activitySessionId: 'alice-idle-client', accountId: alice.accountId, clientId: 'pi-alice' });
  usageStore.openActivitySession({ activitySessionId: 'bob-activity', accountId: bob.accountId, clientId: 'chatgpt-bob' });
  usageStore.recordToolCall({
    accountId: alice.accountId, activitySessionId: 'alice-activity', deviceId: 'alice-device', tool: 'shell_execute',
    durationMs: 12, success: true, inputBytes: 100, outputBytes: 200, callerCategory: 'oauth'
  });
  usageStore.recordToolCall({
    accountId: alice.accountId, activitySessionId: 'alice-activity', tool: 'load_skill', skillName: 'mcp-builder',
    durationMs: 2, success: false, errorCode: 'UNKNOWN_SKILL', inputBytes: 20, outputBytes: 401, callerCategory: 'oauth'
  });
  usageStore.recordToolCall({
    accountId: alice.accountId, activitySessionId: 'alice-activity', deviceId: 'alice-laptop', tool: 'read_text_file',
    durationMs: 3, success: true, inputBytes: 40, outputBytes: 60, callerCategory: 'oauth',
    requestBody: 'NEVER_RENDER_REQUEST_BODY', responseBody: 'NEVER_RENDER_RESPONSE_BODY'
  });
  usageStore.recordToolCall({
    accountId: alice.accountId, activitySessionId: 'alice-activity', deviceId: 'alice-laptop', tool: 'write_file',
    durationMs: 4, success: false, errorCode: 'WRITE_FAILED', inputBytes: 20, outputBytes: 20, callerCategory: 'oauth'
  });
  usageStore.recordToolCall({
    accountId: bob.accountId, activitySessionId: 'bob-activity', deviceId: 'bob-device', tool: 'bob_secret_tool',
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
  const oauthState = new SQLiteAuthState(dbPath);
  oauthState.setClient({ client_id: 'chatgpt-alice', client_name: 'ChatGPT' });
  oauthState.setClient({ client_id: 'pi-alice', client_name: 'Pi Coding Agent' });
  oauthState.setClient({ client_id: 'chatgpt-bob', client_name: 'Bob OAuth Client' });
  const toolCatalog = [
    {
      name: 'shell_execute',
      description: 'Execute a shell command on one owned device.',
      inputSchema: { type: 'object', properties: { command: { type: 'string' }, device_id: { type: 'string' } }, required: ['command', 'device_id'], additionalProperties: false }
    },
    {
      name: 'read_text_file',
      description: 'Read a text file from one owned device.',
      inputSchema: { type: 'object', properties: { path: { type: 'string' }, device_id: { type: 'string' } }, required: ['path', 'device_id'], additionalProperties: false }
    },
    {
      name: 'write_file',
      description: 'Write a text file on one owned device.',
      inputSchema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' }, device_id: { type: 'string' } }, required: ['path', 'content', 'device_id'], additionalProperties: false }
    },
    {
      name: 'bob_secret_tool',
      description: 'Must never appear in Alice device detail.',
      inputSchema: { type: 'object', properties: { secret: { type: 'string' } } }
    }
  ];
  installDashboardRoutes(app, {
    accountFromRequest: accountHttp.accountFromRequest,
    usageStore,
    deviceBroker: broker,
    baseUrlFromRequest: () => 'https://mcp.matcha.me',
    oauthClientLookup: clientId => oauthState.getClient(clientId),
    listTools: async () => toolCatalog,
    serverVersion: '1.0.0 · testsha',
    deviceReleaseProvider: { latestVersion: async () => '1.0.6' }
  });
  const server = await new Promise(resolve => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  broker.attach(server);
  const base = `http://127.0.0.1:${server.address().port}`;

  return {
    dir, dbPath, accountStore, usageStore, deviceStore, oauthState, broker, server, base,
    alice, bob, admin,
    aliceCookie: `hcu_account_session=${encodeURIComponent(aliceBrowser.sessionId)}`,
    bobCookie: `hcu_account_session=${encodeURIComponent(bobBrowser.sessionId)}`,
    adminCookie: `hcu_account_session=${encodeURIComponent(adminBrowser.sessionId)}`,
    close: async () => {
      await broker.shutdown();
      await new Promise(resolve => server.close(resolve));
      oauthState.close();
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
    assert.doesNotMatch(html, /Bob Secret Workstation|bob-device|bob-activity|bob@example\.com|bob_secret_tool/);
    assert.match(html, /Gateway\s+online/i);
    assert.match(html, /16\s+tools/i);
    assert.match(html, /15,297|15297/);
    assert.match(html, /Usage for this account/i);
    assert.match(html, /Estimated tokens/i);
    assert.match(html, /~216/);
    assert.doesNotMatch(html, /Estimated I\/O tokens|Estimated schema context|not billing tokens|estimated context size/i);
    assert.match(html, /Alice Laptop/);
    assert.match(html, /alice-laptop/);
    assert.match(html, /href="\/dashboard\/devices\/alice-device"/);
    assert.match(html, /href="\/dashboard\/devices\/alice-laptop"/);
    assert.doesNotMatch(html, /Platform \/ agent|agent ignored/i);
    assert.match(html, /<th>Device<\/th><th>Version<\/th><th>Last seen<\/th><th>OK \/ Fail<\/th><th>Input \/ Output<\/th><th>Estimated tokens<\/th>/);
    assert.match(html, /<code>1\.0\.5<\/code><small>latest 1\.0\.6<\/small>/);
    assert.match(html, /<code>1\.0\.4<\/code><small>latest 1\.0\.6<\/small>/);
    assert.match(html, /Bootstrap 1\.0\.5 once/);
    assert.match(html, /<strong>0<\/strong> online[\s\S]*?<strong>3<\/strong> offline/i);
    assert.match(html, /100 B/);
    assert.match(html, /200 B/);
    assert.match(html, /~75/);
    assert.match(html, /60 B/);
    assert.match(html, /80 B/);
    assert.match(html, /~35/);
    assert.match(html, /Alice Idle[\s\S]*?alice-idle · offline[\s\S]*?<td>—<\/td>\s*<td>0 \/ 0<\/td>\s*<td>0 B \/ 0 B<\/td>\s*<td>~0<\/td>/);
    assert.match(html, /section\{overflow-x:auto\}/);
    assert.match(html, /table\{min-width:760px\}/);
    assert.match(html, /shell_execute/);
    assert.match(html, /mcp-builder/);
    assert.match(html, /UNKNOWN_SKILL/);
    assert.match(html, /OAuth client sessions/i);
    assert.match(html, /ChatGPT/);
    assert.match(html, /Pi Coding Agent/);
    assert.match(html, /<th>OAuth client<\/th>[\s\S]*?<th>Started<\/th>[\s\S]*?<th>Last seen<\/th>[\s\S]*?<th>Client session<\/th>[\s\S]*?<th>State<\/th>/);
    assert.match(html, /ChatGPT[\s\S]*?<div class="session-devices">[\s\S]*?(?:Alice Workstation[\s\S]*?Alice Laptop|Alice Laptop[\s\S]*?Alice Workstation)[\s\S]*?alice-activity/);
    assert.match(html, /Pi Coding Agent[\s\S]*?No device activity yet[\s\S]*?alice-idle-client/i);
    assert.match(html, /session-device/);
    assert.match(html, /session-devices\{display:flex;flex-wrap:wrap/);
    assert.doesNotMatch(html, /chatgpt-alice/);
    assert.match(html, /Disconnect client session/i);
    assert.match(html, /alice-activity/);
    assert.doesNotMatch(html, /action="\/dashboard\/devices\/alice-device\/revoke"/);
    assert.match(html, /visibilityState/);
    assert.match(html, /\/dashboard\/state/);
    assert.match(html, /fetch\(/);
    assert.match(html, /dirty/);
    assert.doesNotMatch(html, /location\.reload\(/);
    assert.doesNotMatch(html, /payload body/i);
    assert.ok(cookieValue(response, 'hcu_dashboard_csrf'));
  } finally { await f.close(); }
});

test('device usage detail is account-owned and aggregates only that device tools', async () => {
  const f = await fixture();
  try {
    const response = await fetch(`${f.base}/dashboard/devices/alice-laptop`, { headers: { cookie: f.aliceCookie } });
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, /Alice Laptop/);
    assert.match(html, /alice-laptop/);
    assert.match(html, /read_text_file/);
    assert.match(html, /write_file/);
    assert.match(html, /2/);
    assert.match(html, /1/);
    assert.match(html, /60 B/);
    assert.match(html, /80 B/);
    assert.match(html, /~35/);
    assert.match(html, /Estimated tokens/i);
    assert.doesNotMatch(html, /not billing tokens/i);
    assert.match(html, /Tool definitions & input contracts/i);
    assert.match(html, /Read a text file from one owned device\./);
    assert.match(html, /Write a text file on one owned device\./);
    assert.match(html, /device_id/);
    assert.match(html, /Recent metadata calls/i);
    assert.match(html, /Duration/);
    assert.match(html, /3 ms/);
    assert.match(html, /WRITE_FAILED/);
    assert.match(html, /ChatGPT/);
    assert.match(html, /alice-activity/);
    assert.doesNotMatch(html, /NEVER_RENDER_REQUEST_BODY|NEVER_RENDER_RESPONSE_BODY/);
    assert.match(html, /Danger zone/i);
    assert.match(html, /Revoke Alice Laptop/i);
    assert.match(html, /onsubmit="return confirm\(&quot;Revoke Alice Laptop\?/i);
    assert.match(html, /disconnects this device/i);
    assert.match(html, /revoked identity cannot reconnect/i);
    assert.doesNotMatch(html, /shell_execute|Bob Secret Workstation|bob-device|bob_secret_tool/);

    const foreign = await fetch(`${f.base}/dashboard/devices/bob-device`, { headers: { cookie: f.aliceCookie } });
    const unknown = await fetch(`${f.base}/dashboard/devices/unknown-device`, { headers: { cookie: f.aliceCookie } });
    assert.equal(foreign.status, 404);
    assert.equal(unknown.status, 404);
    assert.equal(await foreign.text(), 'Resource unavailable.');
    assert.equal(await unknown.text(), 'Resource unavailable.');
  } finally { await f.close(); }
});

test('dashboard live state returns account-scoped fragments without a page reload', async () => {
  const f = await fixture();
  try {
    const response = await fetch(`${f.base}/dashboard/state`, { headers: { cookie: f.aliceCookie } });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') || '', /application\/json/);
    const state = await response.json();
    assert.match(state.status, /0[\s\S]*online[\s\S]*3[\s\S]*offline/i);
    assert.match(state.devices, /Alice Workstation/);
    assert.match(state.sessions, /ChatGPT/);
    assert.doesNotMatch(JSON.stringify(state), /Bob Secret Workstation|bob-device|bob-activity/);
  } finally { await f.close(); }
});

test('dashboard empty state onboards the account without hard-coded deployment branding', async () => {
  const f = await fixture();
  try {
    const empty = f.accountStore.createAccount({ email: 'empty@example.com', password: 'empty-password' });
    const session = f.accountStore.createSession(empty.accountId);
    const response = await fetch(`${f.base}/dashboard`, {
      headers: { cookie: `hcu_account_session=${encodeURIComponent(session.sessionId)}` }
    });
    const html = await response.text();
    assert.equal(response.status, 200);
    assert.match(html, /Pair your first device/i);
    assert.match(html, /href="\/pair"/);
    assert.match(html, /https:\/\/mcp\.matcha\.me/);
    assert.match(html, /private device key/i);
    assert.match(html, /outbound/i);
    assert.doesNotMatch(html, /HCU CONTROL|mcp-v2\.hcu-lab\.me/i);
  } finally { await f.close(); }
});

test('recent errors prefer friendly device names and render only the newest bounded 20', async () => {
  const f = await fixture();
  try {
    for (let index = 0; index < 25; index += 1) {
      f.usageStore.recordToolCall({
        accountId: f.alice.accountId,
        activitySessionId: 'alice-activity',
        deviceId: 'alice-device',
        tool: 'bounded_error_tool',
        durationMs: index,
        success: false,
        errorCode: `BOUNDED_${index}`,
        inputBytes: 1,
        outputBytes: 2,
        callerCategory: 'oauth'
      });
    }
    const response = await fetch(`${f.base}/dashboard`, { headers: { cookie: f.aliceCookie } });
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, /Server 1\.0\.0 · testsha/);
    assert.match(html, /Alice Workstation/);
    assert.match(html, /Show 15 more \(max 20\)/);
    assert.match(html, /BOUNDED_24/);
    assert.match(html, /BOUNDED_5/);
    assert.doesNotMatch(html, /BOUNDED_4|BOUNDED_0/);
    assert.equal((html.match(/BOUNDED_\d+/g) || []).length, 20);
  } finally { await f.close(); }
});

test('dashboard permanently excludes revoked devices from inventory and counts', async () => {
  const f = await fixture();
  try {
    f.deviceStore.revoke('alice-device');

    for (const route of ['/dashboard', '/dashboard?show_revoked=1']) {
      const response = await fetch(`${f.base}${route}`, { headers: { cookie: f.aliceCookie } });
      assert.equal(response.status, 200);
      const html = await response.text();
      assert.doesNotMatch(html, /href="\/dashboard\/devices\/alice-device"|alice-device · revoked|Show revoked|Hide revoked/);
      assert.match(html, /<strong>0<\/strong> online[\s\S]*?<strong>2<\/strong> offline/i);
    }
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

    const bobClientRename = await post(f.base, '/dashboard/sessions/bob-activity/rename', { _csrf: csrf, client_name: 'Stolen client' }, cookies);
    assert.equal(bobClientRename.status, 404);
    assert.equal(f.usageStore.listActivitySessions(f.bob.accountId)[0].displayName, null);

    const clientRenamed = await post(f.base, '/dashboard/sessions/alice-activity/rename', { _csrf: csrf, client_name: 'ChatGPT G6' }, cookies);
    assert.equal(clientRenamed.status, 303);
    assert.equal(f.usageStore.listActivitySessions(f.alice.accountId).find(item => item.activitySessionId === 'alice-activity')?.displayName, 'ChatGPT G6');
    const renamedPage = await fetch(`${f.base}/dashboard`, { headers: { cookie: f.aliceCookie } });
    assert.match(await renamedPage.text(), /ChatGPT G6/);

    const bobEnd = await post(f.base, '/dashboard/sessions/bob-activity/end', { _csrf: csrf }, cookies);
    assert.equal(bobEnd.status, 404);
    assert.equal(f.usageStore.listActivitySessions(f.bob.accountId)[0].endedAt, null);

    const ended = await post(f.base, '/dashboard/sessions/alice-activity/end', { _csrf: csrf }, cookies);
    assert.equal(ended.status, 303);
    assert.ok(f.usageStore.listActivitySessions(f.alice.accountId).find(item => item.activitySessionId === 'alice-activity')?.endedAt);

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