import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { generateKeyPairSync, sign } from 'node:crypto';
import { WebSocket } from 'ws';

import { buildDeviceAuthChallenge, createDeviceBroker } from '../scripts/device-broker.mjs';
import { createDeviceStore } from '../scripts/device-store.mjs';

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return server.address().port;
}

async function closeServer(server) {
  await new Promise(resolve => server.close(resolve));
}

function keyPair() {
  const pair = generateKeyPairSync('ed25519');
  return {
    publicKeyPem: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    privateKey: pair.privateKey
  };
}

function openSocket(port, token) {
  return new Promise((resolve, reject) => {
    const headers = token === undefined ? {} : { authorization: `Bearer ${token}` };
    const ws = new WebSocket(`ws://127.0.0.1:${port}/device`, { headers });
    ws.once('error', reject);
    ws.once('open', () => resolve(ws));
  });
}

function nextMessage(ws) {
  return new Promise((resolve, reject) => {
    const onMessage = raw => {
      cleanup();
      resolve(JSON.parse(raw.toString()));
    };
    const onClose = (code, reason) => {
      cleanup();
      reject(new Error(`socket closed ${code}: ${reason.toString()}`));
    };
    const cleanup = () => {
      ws.off('message', onMessage);
      ws.off('close', onClose);
    };
    ws.once('message', onMessage);
    ws.once('close', onClose);
  });
}

async function enroll(ws, { deviceId, publicKeyPem, privateKey }) {
  const challengePromise = nextMessage(ws);
  ws.send(JSON.stringify({
    protocol_version: 1,
    type: 'enroll_hello',
    device_id: deviceId,
    timestamp: Date.now(),
    payload: {
      public_key_pem: publicKeyPem,
      agent_version: 'test-1',
      capabilities: ['ping']
    }
  }));
  const challenge = await challengePromise;
  assert.equal(challenge.type, 'auth_challenge');
  const signature = sign(null, buildDeviceAuthChallenge({ deviceId, nonce: challenge.payload.nonce }), privateKey).toString('base64');
  const okPromise = nextMessage(ws);
  ws.send(JSON.stringify({
    protocol_version: 1,
    type: 'auth_response',
    device_id: deviceId,
    timestamp: Date.now(),
    payload: { signature }
  }));
  return await okPromise;
}

async function reconnect(ws, { deviceId, privateKey }) {
  const challengePromise = nextMessage(ws);
  ws.send(JSON.stringify({
    protocol_version: 1,
    type: 'auth_hello',
    device_id: deviceId,
    timestamp: Date.now(),
    payload: { agent_version: 'test-2', capabilities: ['ping'] }
  }));
  const challenge = await challengePromise;
  assert.equal(challenge.type, 'auth_challenge');
  const signature = sign(null, buildDeviceAuthChallenge({ deviceId, nonce: challenge.payload.nonce }), privateKey).toString('base64');
  const okPromise = nextMessage(ws);
  ws.send(JSON.stringify({
    protocol_version: 1,
    type: 'auth_response',
    device_id: deviceId,
    timestamp: Date.now(),
    payload: { signature }
  }));
  return await okPromise;
}

async function createHarness(t, dbPath) {
  const store = createDeviceStore({ dbPath });
  const server = http.createServer((_req, res) => res.end('ok'));
  const broker = createDeviceBroker({ enrollmentToken: 'dev-secret', deviceStore: store, requestTimeoutMs: 1000 });
  broker.attach(server);
  const port = await listen(server);
  t.after(async () => {
    await broker.shutdown();
    store.close();
    await closeServer(server);
  });
  return { store, broker, port };
}

test('one-time token enrollment persists Ed25519 identity and reconnect needs only proof of possession', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'device-auth-'));
  const dbPath = path.join(dir, 'devices.sqlite');
  const { store, broker, port } = await createHarness(t, dbPath);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const keys = keyPair();

  const first = await openSocket(port, 'dev-secret');
  const firstOk = await enroll(first, { deviceId: 'thinkbook-auth', ...keys });
  assert.equal(firstOk.type, 'auth_ok');
  assert.equal(firstOk.connection_epoch, 1);
  assert.equal(store.get('thinkbook-auth').revokedAt, null);
  first.close();
  await new Promise(resolve => setTimeout(resolve, 50));

  const second = await openSocket(port);
  t.after(() => second.close());
  const secondOk = await reconnect(second, { deviceId: 'thinkbook-auth', privateKey: keys.privateKey });
  assert.equal(secondOk.type, 'auth_ok');
  assert.equal(secondOk.connection_epoch, 2);
  const [device] = broker.listDevices();
  assert.equal(device.online, true);
  assert.equal(device.connectionEpoch, 2);
});

test('rotated device key rejects the old key and accepts the new key on reconnect', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'device-auth-rotate-'));
  const dbPath = path.join(dir, 'devices.sqlite');
  const { store, port } = await createHarness(t, dbPath);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const oldKeys = keyPair();
  const newKeys = keyPair();

  const enrolled = await openSocket(port, 'dev-secret');
  await enroll(enrolled, { deviceId: 'rotated-device', ...oldKeys });
  enrolled.close();
  await new Promise(resolve => setTimeout(resolve, 50));
  store.rotate({ deviceId: 'rotated-device', expectedPublicKeyPem: oldKeys.publicKeyPem, publicKeyPem: newKeys.publicKeyPem });

  const stale = await openSocket(port);
  const staleClosed = new Promise(resolve => stale.once('close', (code, reason) => resolve({ code, reason: reason.toString() })));
  void reconnect(stale, { deviceId: 'rotated-device', privateKey: oldKeys.privateKey }).catch(() => {});
  const staleResult = await staleClosed;
  assert.equal(staleResult.code, 4003);

  const current = await openSocket(port);
  t.after(() => current.close());
  const currentOk = await reconnect(current, { deviceId: 'rotated-device', privateKey: newKeys.privateKey });
  assert.equal(currentOk.type, 'auth_ok');
});

test('rotation between challenge and auth response invalidates the challenged old key', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'device-auth-race-'));
  const dbPath = path.join(dir, 'devices.sqlite');
  const { store, port } = await createHarness(t, dbPath);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const oldKeys = keyPair();
  const newKeys = keyPair();

  const enrolled = await openSocket(port, 'dev-secret');
  await enroll(enrolled, { deviceId: 'race-device', ...oldKeys });
  enrolled.close();
  await new Promise(resolve => setTimeout(resolve, 50));

  const stale = await openSocket(port);
  const challengePromise = nextMessage(stale);
  stale.send(JSON.stringify({ protocol_version: 1, type: 'auth_hello', device_id: 'race-device', timestamp: Date.now(), payload: {} }));
  const challenge = await challengePromise;
  store.rotate({ deviceId: 'race-device', expectedPublicKeyPem: oldKeys.publicKeyPem, publicKeyPem: newKeys.publicKeyPem });
  const signature = sign(null, buildDeviceAuthChallenge({ deviceId: 'race-device', nonce: challenge.payload.nonce }), oldKeys.privateKey).toString('base64');
  const outcome = Promise.race([
    nextMessage(stale).then(message => ({ kind: 'message', message }), error => ({ kind: 'closed', error })),
    new Promise(resolve => setTimeout(() => resolve({ kind: 'timeout' }), 1000))
  ]);
  stale.send(JSON.stringify({ protocol_version: 1, type: 'auth_response', device_id: 'race-device', timestamp: Date.now(), payload: { signature } }));
  const result = await outcome;
  assert.equal(result.kind, 'closed', `expected authentication rejection, got ${JSON.stringify(result)}`);
  assert.match(result.error.message, /socket closed 4003/i);
});

test('external key rotation invalidates a live session before dispatch', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'device-auth-live-rotate-'));
  const dbPath = path.join(dir, 'devices.sqlite');
  const { store, broker, port } = await createHarness(t, dbPath);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const oldKeys = keyPair();
  const newKeys = keyPair();
  const ws = await openSocket(port, 'dev-secret');
  await enroll(ws, { deviceId: 'live-rotate-device', ...oldKeys });
  const closed = new Promise(resolve => ws.once('close', (code, reason) => resolve({ code, reason: reason.toString() })));

  store.rotate({ deviceId: 'live-rotate-device', expectedPublicKeyPem: oldKeys.publicKeyPem, publicKeyPem: newKeys.publicKeyPem });
  await assert.rejects(
    broker.callDevice({ deviceId: 'live-rotate-device', tool: 'ping' }),
    /authorization changed|offline/i
  );
  const result = await closed;
  assert.equal(result.code, 4005);
  assert.equal(broker.listDevices()[0].online, false);
});

test('external revocation invalidates a live session before dispatch', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'device-auth-live-revoke-'));
  const dbPath = path.join(dir, 'devices.sqlite');
  const { store, broker, port } = await createHarness(t, dbPath);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const keys = keyPair();
  const ws = await openSocket(port, 'dev-secret');
  await enroll(ws, { deviceId: 'live-revoke-device', ...keys });
  const closed = new Promise(resolve => ws.once('close', (code, reason) => resolve({ code, reason: reason.toString() })));

  store.revoke('live-revoke-device');
  await assert.rejects(
    broker.callDevice({ deviceId: 'live-revoke-device', tool: 'ping' }),
    /authorization changed|revoked/i
  );
  const result = await closed;
  assert.equal(result.code, 4004);
  const [device] = broker.listDevices();
  assert.equal(device.online, false);
  assert.equal(device.revoked, true);
});

test('external rotation rejects a pending stale-session result without replay', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'device-auth-pending-rotate-'));
  const dbPath = path.join(dir, 'devices.sqlite');
  const { store, broker, port } = await createHarness(t, dbPath);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const oldKeys = keyPair();
  const newKeys = keyPair();
  const ws = await openSocket(port, 'dev-secret');
  await enroll(ws, { deviceId: 'pending-rotate-device', ...oldKeys });

  const toolCallPromise = nextMessage(ws);
  const pendingCall = broker.callDevice({ requestId: 'pending-rotate-1', deviceId: 'pending-rotate-device', tool: 'ping' });
  const toolCall = await toolCallPromise;
  assert.equal(toolCall.type, 'tool_call');
  store.rotate({ deviceId: 'pending-rotate-device', expectedPublicKeyPem: oldKeys.publicKeyPem, publicKeyPem: newKeys.publicKeyPem });
  const closed = new Promise(resolve => ws.once('close', (code, reason) => resolve({ code, reason: reason.toString() })));
  ws.send(JSON.stringify({
    protocol_version: 1,
    type: 'tool_result',
    request_id: toolCall.request_id,
    device_id: 'pending-rotate-device',
    connection_epoch: toolCall.connection_epoch,
    timestamp: Date.now(),
    payload: { content: [{ type: 'text', text: 'stale-result' }] }
  }));
  await assert.rejects(pendingCall, /authorization changed.*not replayed/i);
  const result = await closed;
  assert.equal(result.code, 4005);
});

test('replacement connection rejects old pending requests immediately without replay', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'device-auth-replace-pending-'));
  const dbPath = path.join(dir, 'devices.sqlite');
  const { broker, port } = await createHarness(t, dbPath);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const keys = keyPair();
  const first = await openSocket(port, 'dev-secret');
  await enroll(first, { deviceId: 'replace-pending-device', ...keys });

  const toolCallPromise = nextMessage(first);
  const pendingCall = broker.callDevice({ requestId: 'replace-pending-1', deviceId: 'replace-pending-device', tool: 'ping' });
  const pendingRejected = assert.rejects(pendingCall, /replaced.*not replayed/i);
  await toolCallPromise;
  const replacement = await openSocket(port);
  t.after(() => replacement.close());
  const ok = await reconnect(replacement, { deviceId: 'replace-pending-device', privateKey: keys.privateKey });
  assert.equal(ok.type, 'auth_ok');
  await pendingRejected;
});

test('invalid signature cannot authenticate an enrolled identity', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'device-auth-'));
  const dbPath = path.join(dir, 'devices.sqlite');
  const { port } = await createHarness(t, dbPath);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const keys = keyPair();
  const wrong = keyPair();

  const enrolled = await openSocket(port, 'dev-secret');
  await enroll(enrolled, { deviceId: 'signed-device', ...keys });
  enrolled.close();
  await new Promise(resolve => setTimeout(resolve, 50));

  const ws = await openSocket(port);
  const challengePromise = nextMessage(ws);
  ws.send(JSON.stringify({ protocol_version: 1, type: 'auth_hello', device_id: 'signed-device', timestamp: Date.now(), payload: {} }));
  const challenge = await challengePromise;
  const badSignature = sign(null, buildDeviceAuthChallenge({ deviceId: 'signed-device', nonce: challenge.payload.nonce }), wrong.privateKey).toString('base64');
  const closed = new Promise(resolve => ws.once('close', (code, reason) => resolve({ code, reason: reason.toString() })));
  ws.send(JSON.stringify({ protocol_version: 1, type: 'auth_response', device_id: 'signed-device', timestamp: Date.now(), payload: { signature: badSignature } }));
  const result = await closed;
  assert.equal(result.code, 4003);
});

test('revocation disconnects an online device and blocks later reconnect', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'device-auth-'));
  const dbPath = path.join(dir, 'devices.sqlite');
  const { broker, port } = await createHarness(t, dbPath);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const keys = keyPair();

  const ws = await openSocket(port, 'dev-secret');
  await enroll(ws, { deviceId: 'revoked-device', ...keys });
  const closed = new Promise(resolve => ws.once('close', (code, reason) => resolve({ code, reason: reason.toString() })));
  broker.revokeDevice('revoked-device');
  const closeResult = await closed;
  assert.equal(closeResult.code, 4004);
  assert.equal(broker.listDevices()[0].revoked, true);

  const reconnecting = await openSocket(port);
  const reconnectClosed = new Promise(resolve => reconnecting.once('close', (code, reason) => resolve({ code, reason: reason.toString() })));
  reconnecting.send(JSON.stringify({ protocol_version: 1, type: 'auth_hello', device_id: 'revoked-device', timestamp: Date.now(), payload: {} }));
  const result = await reconnectClosed;
  assert.equal(result.code, 4003);
});

test('persisted identity survives broker restart and can authenticate without enrollment token', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'device-auth-restart-'));
  const dbPath = path.join(dir, 'devices.sqlite');
  const keys = keyPair();

  const store1 = createDeviceStore({ dbPath });
  const server1 = http.createServer((_req, res) => res.end('ok'));
  const broker1 = createDeviceBroker({ enrollmentToken: 'dev-secret', deviceStore: store1 });
  broker1.attach(server1);
  const port1 = await listen(server1);
  const ws1 = await openSocket(port1, 'dev-secret');
  await enroll(ws1, { deviceId: 'restart-device', ...keys });
  ws1.close();
  await broker1.shutdown();
  store1.close();
  await closeServer(server1);

  const store2 = createDeviceStore({ dbPath });
  const server2 = http.createServer((_req, res) => res.end('ok'));
  const broker2 = createDeviceBroker({ enrollmentToken: 'dev-secret', deviceStore: store2 });
  broker2.attach(server2);
  const port2 = await listen(server2);
  t.after(async () => {
    await broker2.shutdown();
    store2.close();
    await closeServer(server2);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  assert.equal(broker2.listDevices()[0].online, false);
  const ws2 = await openSocket(port2);
  t.after(() => ws2.close());
  const ok = await reconnect(ws2, { deviceId: 'restart-device', privateKey: keys.privateKey });
  assert.equal(ok.type, 'auth_ok');
  assert.equal(broker2.listDevices()[0].online, true);
});

