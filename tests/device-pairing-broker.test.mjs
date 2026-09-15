import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';

import { buildDeviceAuthChallenge, createDeviceBroker } from '../scripts/device-broker.mjs';
import { createDevicePairingStore } from '../scripts/device-pairing-store.mjs';
import { createDeviceStore } from '../scripts/device-store.mjs';
import { createDeviceUsageStore } from '../scripts/device-usage.mjs';

function keyPair() {
  const pair = crypto.generateKeyPairSync('ed25519');
  return {
    publicKeyPem: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    privateKey: pair.privateKey
  };
}

function pkce() {
  const verifier = crypto.randomBytes(32).toString('base64url');
  return {
    verifier,
    challenge: crypto.createHash('sha256').update(verifier).digest('base64url')
  };
}

function nextMessage(ws) {
  return new Promise((resolve, reject) => {
    const onMessage = raw => { cleanup(); resolve(JSON.parse(raw.toString())); };
    const onClose = (code, reason) => { cleanup(); reject(new Error(`socket closed ${code}: ${reason.toString()}`)); };
    const cleanup = () => { ws.off('message', onMessage); ws.off('close', onClose); };
    ws.once('message', onMessage);
    ws.once('close', onClose);
  });
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return server.address().port;
}

function openSocket(port, credential) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/device`, {
      headers: credential ? { authorization: `Bearer ${credential}` } : {}
    });
    ws.once('error', reject);
    ws.once('open', () => resolve(ws));
  });
}

async function sendEnrollHello(ws, { deviceId, publicKeyPem }) {
  const challengePromise = nextMessage(ws);
  ws.send(JSON.stringify({
    protocol_version: 1,
    type: 'enroll_hello',
    device_id: deviceId,
    timestamp: Date.now(),
    payload: {
      public_key_pem: publicKeyPem,
      agent_version: 'hcu-device-test',
      hostname: 'g8',
      platform: 'linux',
      arch: 'x64',
      path_style: 'posix',
      capabilities: ['ping']
    }
  }));
  return await challengePromise;
}

async function answerChallenge(ws, { deviceId, privateKey, challenge }) {
  const signature = crypto.sign(
    null,
    buildDeviceAuthChallenge({ deviceId, nonce: challenge.payload.nonce }),
    privateKey
  ).toString('base64');
  const responsePromise = nextMessage(ws);
  ws.send(JSON.stringify({
    protocol_version: 1,
    type: 'auth_response',
    device_id: deviceId,
    timestamp: Date.now(),
    payload: { signature }
  }));
  return await responsePromise;
}

async function reconnect(ws, { deviceId, privateKey }) {
  const challengePromise = nextMessage(ws);
  ws.send(JSON.stringify({ protocol_version: 1, type: 'auth_hello', device_id: deviceId, timestamp: Date.now(), payload: { agent_version: 'pair-test', capabilities: ['ping'] } }));
  const challenge = await challengePromise;
  return await answerChallenge(ws, { deviceId, privateKey, challenge });
}

function approvedGrant(pairingStore, { deviceId, deviceName, publicKeyPem }) {
  const p = pkce();
  const started = pairingStore.start({
    clientId: 'mcp-device', deviceId, deviceName, publicKeyPem, codeChallenge: p.challenge
  });
  pairingStore.approve({ userCode: started.userCode, accountLabel: 'Example Gateway' });
  const polled = pairingStore.poll({ deviceCode: started.deviceCode, clientId: 'mcp-device', codeVerifier: p.verifier });
  return { ...polled, userCode: started.userCode };
}

async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-pair-broker-'));
  const dbPath = path.join(dir, 'devices.sqlite');
  const deviceStore = createDeviceStore({ dbPath });
  const pairingStore = createDevicePairingStore({ dbPath });
  const usageStore = createDeviceUsageStore({ dbPath });
  const server = http.createServer((_req, res) => res.end('ok'));
  const broker = createDeviceBroker({
    enrollmentToken: 'legacy-enrollment-token',
    deviceStore,
    pairingStore,
    usageStore,
    schemaSnapshot: {
      toolCount: 16,
      toolSchemaBytes: 16225,
      toolSchemaTokenEstimate: 4057,
      tokenEstimateMethod: 'utf8_bytes_div_4_estimate'
    },
    requestTimeoutMs: 1000
  });
  broker.attach(server);
  const port = await listen(server);
  t.after(async () => {
    await broker.shutdown();
    usageStore.close();
    pairingStore.close();
    deviceStore.close();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { port, broker, deviceStore, pairingStore, usageStore };
}

test('pairing grant is consumed only after key proof and persists account/device metadata', async t => {
  const f = await fixture(t);
  const keys = keyPair();
  const grant = approvedGrant(f.pairingStore, {
    deviceId: 'paired-device', deviceName: 'Workstation A', publicKeyPem: keys.publicKeyPem
  });

  const abandoned = await openSocket(f.port, grant.enrollmentGrant);
  const firstChallenge = await sendEnrollHello(abandoned, { deviceId: 'paired-device', publicKeyPem: keys.publicKeyPem });
  assert.equal(firstChallenge.type, 'auth_challenge');
  assert.equal(f.pairingStore.getStatusByUserCode(grant.userCode).status, 'approved');
  abandoned.close();

  const ws = await openSocket(f.port, grant.enrollmentGrant);
  t.after(() => ws.close());
  const challenge = await sendEnrollHello(ws, { deviceId: 'paired-device', publicKeyPem: keys.publicKeyPem });
  const ok = await answerChallenge(ws, { deviceId: 'paired-device', privateKey: keys.privateKey, challenge });
  assert.equal(ok.type, 'auth_ok');
  assert.deepEqual(ok.payload.account, { connected: true, label: 'Example Gateway' });
  assert.equal(ok.payload.device.name, 'Workstation A');
  assert.equal(ok.payload.schema.toolCount, 16);
  assert.equal(ok.payload.schema.toolSchemaTokenEstimate, 4057);
  assert.equal(ok.payload.schema.tokenUsageKind, 'schema_estimate_not_billing');
  assert.equal(f.pairingStore.getStatusByUserCode(grant.userCode).status, 'consumed');

  const stored = f.deviceStore.get('paired-device');
  assert.equal(stored.deviceName, 'Workstation A');
  assert.equal(stored.accountLabel, 'Example Gateway');
  assert.equal(stored.hostname, 'g8');
  assert.equal(stored.platform, 'linux');
  assert.equal(stored.arch, 'x64');
  assert.equal(stored.pathStyle, 'posix');

  const [listed] = f.broker.listDevices();
  assert.equal(listed.hostname, 'g8');
  assert.equal(listed.platform, 'linux');
  assert.equal(listed.arch, 'x64');
  assert.equal(listed.pathStyle, 'posix');
});

test('usage counters survive reconnect and account metadata returns without another pairing grant', async t => {
  const f = await fixture(t);
  const keys = keyPair();
  const grant = approvedGrant(f.pairingStore, {
    deviceId: 'usage-paired', deviceName: 'Usage Device', publicKeyPem: keys.publicKeyPem
  });
  const ws = await openSocket(f.port, grant.enrollmentGrant);
  const challenge = await sendEnrollHello(ws, { deviceId: 'usage-paired', publicKeyPem: keys.publicKeyPem });
  await answerChallenge(ws, { deviceId: 'usage-paired', privateKey: keys.privateKey, challenge });

  ws.on('message', raw => {
    const message = JSON.parse(raw.toString());
    if (message.type !== 'tool_call') return;
    ws.send(JSON.stringify({
      protocol_version: 1,
      type: 'tool_result',
      request_id: message.request_id,
      device_id: 'usage-paired',
      connection_epoch: message.connection_epoch,
      timestamp: Date.now(),
      payload: { ok: true, pong: true }
    }));
  });
  const result = await f.broker.callDevice({ deviceId: 'usage-paired', tool: 'ping', arguments: { hello: 'world' } });
  assert.deepEqual(result, { ok: true, pong: true });
  ws.close();
  await new Promise(resolve => setTimeout(resolve, 40));

  const reconnecting = await openSocket(f.port);
  t.after(() => reconnecting.close());
  const reauth = await reconnect(reconnecting, { deviceId: 'usage-paired', privateKey: keys.privateKey });
  assert.equal(reauth.type, 'auth_ok');
  assert.deepEqual(reauth.payload.account, { connected: true, label: 'Example Gateway' });
  assert.equal(reauth.payload.usage.connections, 2);
  assert.equal(reauth.payload.usage.reconnects, 1);
  assert.equal(reauth.payload.usage.toolCallsStarted, 1);
  assert.equal(reauth.payload.usage.toolCallsSucceeded, 1);
  assert.equal(reauth.payload.usage.toolCallsFailed, 0);
  assert.ok(reauth.payload.usage.requestBytes > 0);
  assert.ok(reauth.payload.usage.responseBytes > 0);

  const [listed] = f.broker.listDevices();
  assert.equal(listed.account.connected, true);
  assert.equal(listed.usage.toolCallsSucceeded, 1);
  assert.equal(listed.schema.tokenUsageKind, 'schema_estimate_not_billing');
});
