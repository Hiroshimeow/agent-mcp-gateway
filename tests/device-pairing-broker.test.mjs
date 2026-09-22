import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import { WebSocket } from 'ws';

import {
  buildDeviceAuthChallenge,
  buildDeviceAuthChallengeV2,
  buildDeviceAuthExporterContext,
  createDeviceBroker
} from '../scripts/device-broker.mjs';
import {
  DEVICE_INNER_TLS_SUBPROTOCOL,
  createJsonFrameParser,
  createWebSocketDuplex,
  encodeJsonFrame
} from '../scripts/device-secure-transport.mjs';
import { createDevicePairingStore } from '../scripts/device-pairing-store.mjs';
import { createDeviceStore } from '../scripts/device-store.mjs';
import { createDeviceUsageStore } from '../scripts/device-usage.mjs';

const innerTlsFixtureDir = path.join('tests', 'fixtures', 'device-inner-tls');
const innerTlsCa = fs.readFileSync(path.join(innerTlsFixtureDir, 'ca-cert.pem'));
const innerTlsCert = fs.readFileSync(path.join(innerTlsFixtureDir, 'server-cert.pem'));
const innerTlsKey = fs.readFileSync(path.join(innerTlsFixtureDir, 'server-key.pem'));

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

async function openV2(port) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/device`, DEVICE_INNER_TLS_SUBPROTOCOL);
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  const secure = tls.connect({
    socket: createWebSocketDuplex(ws),
    ca: innerTlsCa,
    servername: 'localhost',
    minVersion: 'TLSv1.3',
    rejectUnauthorized: true
  });
  await new Promise((resolve, reject) => { secure.once('secureConnect', resolve); secure.once('error', reject); });
  const queue = [];
  const waiters = [];
  const parser = createJsonFrameParser({
    onMessage(message) {
      const waiter = waiters.shift();
      if (waiter) waiter(message);
      else queue.push(message);
    }
  });
  secure.on('data', chunk => parser.push(chunk));
  return {
    ws,
    secure,
    send(message) { secure.write(encodeJsonFrame(message)); },
    async next() { return queue.length ? queue.shift() : await new Promise(resolve => waiters.push(resolve)); }
  };
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
  pairingStore.approve({ userCode: started.userCode, accountId: 'account-example', accountLabel: 'Example Gateway' });
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
    requestTimeoutMs: 1000,
    innerTls: { cert: innerTlsCert, key: innerTlsKey }
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
  assert.deepEqual(ok.payload.account, { connected: true, account_id: 'account-example', label: 'Example Gateway' });
  assert.equal(ok.payload.device.name, 'Workstation A');
  assert.equal(ok.payload.schema.toolCount, 16);
  assert.equal(ok.payload.schema.toolSchemaTokenEstimate, 4057);
  assert.equal(ok.payload.schema.tokenUsageKind, 'schema_estimate_not_billing');
  assert.equal(f.pairingStore.getStatusByUserCode(grant.userCode).status, 'consumed');

  const stored = f.deviceStore.get('paired-device');
  assert.equal(stored.deviceName, 'Workstation A');
  assert.equal(stored.ownerAccountId, 'account-example');
  assert.equal(stored.accountLabel, 'Example Gateway');
  assert.equal(stored.hostname, 'g8');
  assert.equal(stored.platform, 'linux');
  assert.equal(stored.arch, 'x64');
  assert.equal(stored.pathStyle, 'posix');

  const [listed] = f.broker.listDevices({ accountId: 'account-example' });
  assert.equal(listed.hostname, 'g8');
  assert.equal(listed.platform, 'linux');
  assert.equal(listed.arch, 'x64');
  assert.equal(listed.pathStyle, 'posix');
});

test('v2 pairing grant is consumed only after valid inner-TLS device proof', async t => {
  const f = await fixture(t);
  const keys = keyPair();
  f.deviceStore.enroll({ deviceId: 'v2-pair-device', publicKeyPem: keys.publicKeyPem, deviceName: 'Before Pair' });
  const grant = approvedGrant(f.pairingStore, {
    deviceId: 'v2-pair-device', deviceName: 'After Pair', publicKeyPem: keys.publicKeyPem
  });

  const bad = await openV2(f.port);
  bad.send({
    protocol_version: 2,
    type: 'pair_hello',
    device_id: 'v2-pair-device',
    timestamp: Date.now(),
    payload: {
      public_key_pem: keys.publicKeyPem,
      enrollment_grant: grant.enrollmentGrant,
      capabilities: ['ping']
    }
  });
  const badChallenge = await bad.next();
  assert.equal(badChallenge.payload.mode, 'pair');
  assert.equal(f.pairingStore.getStatusByUserCode(grant.userCode).status, 'approved');
  const badClosed = new Promise(resolve => bad.ws.once('close', resolve));
  bad.send({
    protocol_version: 2,
    type: 'auth_response',
    device_id: 'v2-pair-device',
    timestamp: Date.now(),
    payload: { signature: Buffer.alloc(64).toString('base64') }
  });
  await badClosed;
  assert.equal(f.pairingStore.getStatusByUserCode(grant.userCode).status, 'approved');
  bad.secure.destroy();

  const good = await openV2(f.port);
  t.after(() => { good.secure.destroy(); good.ws.terminate(); });
  good.send({
    protocol_version: 2,
    type: 'pair_hello',
    device_id: 'v2-pair-device',
    timestamp: Date.now(),
    payload: {
      public_key_pem: keys.publicKeyPem,
      enrollment_grant: grant.enrollmentGrant,
      capabilities: ['ping']
    }
  });
  const challenge = await good.next();
  const exporter = good.secure.exportKeyingMaterial(
    32,
    'EXPERIMENTAL-HCU-MCP-DEVICE-AUTH-V2',
    buildDeviceAuthExporterContext({ deviceId: 'v2-pair-device', mode: 'pair' })
  );
  const signature = crypto.sign(null, buildDeviceAuthChallengeV2({
    deviceId: 'v2-pair-device',
    mode: 'pair',
    nonce: challenge.payload.nonce,
    exporter,
    publicKeyPem: keys.publicKeyPem,
    grant: grant.enrollmentGrant
  }), keys.privateKey).toString('base64');
  good.send({
    protocol_version: 2,
    type: 'auth_response',
    device_id: 'v2-pair-device',
    timestamp: Date.now(),
    payload: { signature }
  });
  const ok = await good.next();
  assert.equal(ok.type, 'auth_ok');
  assert.equal(f.pairingStore.getStatusByUserCode(grant.userCode).status, 'consumed');
  assert.equal(f.deviceStore.get('v2-pair-device').ownerAccountId, 'account-example');
  assert.equal(f.deviceStore.get('v2-pair-device').minProtocol, 2);
});

test('account ownership filters inventory and is rechecked at every device dispatch', async t => {
  const f = await fixture(t);
  const keys = keyPair();
  const grant = approvedGrant(f.pairingStore, {
    deviceId: 'owned-device', deviceName: 'Owned Device', publicKeyPem: keys.publicKeyPem
  });
  const ws = await openSocket(f.port, grant.enrollmentGrant);
  t.after(() => ws.close());
  const challenge = await sendEnrollHello(ws, { deviceId: 'owned-device', publicKeyPem: keys.publicKeyPem });
  await answerChallenge(ws, { deviceId: 'owned-device', privateKey: keys.privateKey, challenge });

  assert.deepEqual(f.broker.listDevices({ accountId: 'account-example' }).map(item => item.deviceId), ['owned-device']);
  assert.deepEqual(f.broker.listDevices({ accountId: 'account-bob' }), []);
  assert.deepEqual(f.broker.listDevices(), []);
  await assert.rejects(
    () => f.broker.callDevice({ deviceId: 'owned-device', tool: 'ping' }),
    /ACCOUNT_ID_REQUIRED/
  );
  await assert.rejects(
    () => f.broker.callDevice({ accountId: 'account-bob', deviceId: 'owned-device', tool: 'ping' }),
    /DEVICE_ACCESS_DENIED/
  );
});

test('normal account revoke hard-forgets its own device and a later pair is a fresh enrollment', async t => {
  const f = await fixture(t);
  const keys = keyPair();
  const grant = approvedGrant(f.pairingStore, {
    deviceId: 'self-service-device', deviceName: 'Before Rename', publicKeyPem: keys.publicKeyPem
  });
  const ws = await openSocket(f.port, grant.enrollmentGrant);
  t.after(() => ws.close());
  const challenge = await sendEnrollHello(ws, { deviceId: 'self-service-device', publicKeyPem: keys.publicKeyPem });
  await answerChallenge(ws, { deviceId: 'self-service-device', privateKey: keys.privateKey, challenge });

  assert.throws(
    () => f.broker.renameOwnedDevice({ accountId: 'account-bob', deviceId: 'self-service-device', deviceName: 'Stolen' }),
    /DEVICE_ACCESS_DENIED/
  );
  const renamed = f.broker.renameOwnedDevice({
    accountId: 'account-example', deviceId: 'self-service-device', deviceName: 'Renamed Device'
  });
  assert.equal(renamed.deviceName, 'Renamed Device');
  assert.equal(f.deviceStore.get('self-service-device').deviceName, 'Renamed Device');

  assert.throws(
    () => f.broker.revokeOwnedDevice({ accountId: 'account-bob', deviceId: 'self-service-device' }),
    /DEVICE_ACCESS_DENIED/
  );
  const forgotten = f.broker.revokeOwnedDevice({ accountId: 'account-example', deviceId: 'self-service-device' });
  assert.equal(forgotten.forgotten, true);
  assert.equal(f.deviceStore.get('self-service-device'), null);
  assert.equal(f.broker.listDevices({ accountId: 'account-example' }).length, 0);
  assert.equal(f.usageStore.getAccountUsage('account-example').deviceStatusEvents.length, 0);
  await assert.rejects(
    () => f.broker.callDevice({ accountId: 'account-example', deviceId: 'self-service-device', tool: 'ping' }),
    error => error.code === 'DEVICE_OFFLINE'
  );

  const nextKeys = keyPair();
  const nextGrant = approvedGrant(f.pairingStore, {
    deviceId: 'self-service-device', deviceName: 'Paired Again', publicKeyPem: nextKeys.publicKeyPem
  });
  const nextWs = await openSocket(f.port, nextGrant.enrollmentGrant);
  t.after(() => nextWs.close());
  const nextChallenge = await sendEnrollHello(nextWs, { deviceId: 'self-service-device', publicKeyPem: nextKeys.publicKeyPem });
  await answerChallenge(nextWs, { deviceId: 'self-service-device', privateKey: nextKeys.privateKey, challenge: nextChallenge });
  const [pairedAgain] = f.broker.listDevices({ accountId: 'account-example' });
  assert.equal(pairedAgain.deviceName, 'Paired Again');
  assert.equal(pairedAgain.online, true);
  assert.notEqual(f.deviceStore.get('self-service-device').publicKeyPem, keys.publicKeyPem);
  assert.equal(f.usageStore.getAccountUsage('account-bob').deviceStatusEvents.length, 0);
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
  const result = await f.broker.callDevice({ accountId: 'account-example', deviceId: 'usage-paired', tool: 'ping', arguments: { hello: 'world' } });
  assert.deepEqual(result, { ok: true, pong: true });
  ws.close();
  await new Promise(resolve => setTimeout(resolve, 40));

  const reconnecting = await openSocket(f.port);
  t.after(() => reconnecting.close());
  const reauth = await reconnect(reconnecting, { deviceId: 'usage-paired', privateKey: keys.privateKey });
  assert.equal(reauth.type, 'auth_ok');
  assert.deepEqual(reauth.payload.account, { connected: true, account_id: 'account-example', label: 'Example Gateway' });
  assert.equal(reauth.payload.usage.connections, 2);
  assert.equal(reauth.payload.usage.reconnects, 1);
  assert.equal(reauth.payload.usage.toolCallsStarted, 1);
  assert.equal(reauth.payload.usage.toolCallsSucceeded, 1);
  assert.equal(reauth.payload.usage.toolCallsFailed, 0);
  assert.ok(reauth.payload.usage.requestBytes > 0);
  assert.ok(reauth.payload.usage.responseBytes > 0);

  const [listed] = f.broker.listDevices({ accountId: 'account-example' });
  assert.equal(listed.account.connected, true);
  assert.equal(listed.usage.toolCallsSucceeded, 1);
  assert.equal(listed.schema.tokenUsageKind, 'schema_estimate_not_billing');
});
