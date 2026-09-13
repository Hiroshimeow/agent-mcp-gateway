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

test('reconnect challenge is invalid after A to B to A authorization generation changes', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'device-auth-generation-challenge-'));
  const dbPath = path.join(dir, 'devices.sqlite');
  const { store, port } = await createHarness(t, dbPath);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const a = keyPair();
  const b = keyPair();

  const first = await openSocket(port, 'dev-secret');
  await enroll(first, { deviceId: 'generation-challenge-device', ...a });
  first.close();
  await new Promise(resolve => setTimeout(resolve, 20));

  const reconnecting = await openSocket(port);
  const challengePromise = nextMessage(reconnecting);
  reconnecting.send(JSON.stringify({
    protocol_version: 1,
    type: 'auth_hello',
    device_id: 'generation-challenge-device',
    timestamp: Date.now(),
    payload: { agent_version: 'test-generation', capabilities: ['ping'] }
  }));
  const challenge = await challengePromise;
  store.rotate({ deviceId: 'generation-challenge-device', expectedPublicKeyPem: a.publicKeyPem, publicKeyPem: b.publicKeyPem });
  store.rotate({ deviceId: 'generation-challenge-device', expectedPublicKeyPem: b.publicKeyPem, publicKeyPem: a.publicKeyPem });

  const signature = sign(
    null,
    buildDeviceAuthChallenge({ deviceId: 'generation-challenge-device', nonce: challenge.payload.nonce }),
    a.privateKey
  ).toString('base64');
  const outcome = new Promise(resolve => {
    reconnecting.once('message', raw => resolve({ kind: 'message', message: JSON.parse(raw.toString()) }));
    reconnecting.once('close', (code, reason) => resolve({ kind: 'close', code, reason: reason.toString() }));
  });
  reconnecting.send(JSON.stringify({
    protocol_version: 1,
    type: 'auth_response',
    device_id: 'generation-challenge-device',
    timestamp: Date.now(),
    payload: { signature }
  }));
  const result = await outcome;
  assert.equal(result.kind, 'close');
  assert.equal(result.code, 4003);
});

test('live session is invalid after A to B to A authorization generation changes', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'device-auth-generation-session-'));
  const dbPath = path.join(dir, 'devices.sqlite');
  const { store, broker, port } = await createHarness(t, dbPath);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const a = keyPair();
  const b = keyPair();
  const ws = await openSocket(port, 'dev-secret');
  await enroll(ws, { deviceId: 'generation-session-device', ...a });
  store.rotate({ deviceId: 'generation-session-device', expectedPublicKeyPem: a.publicKeyPem, publicKeyPem: b.publicKeyPem });
  store.rotate({ deviceId: 'generation-session-device', expectedPublicKeyPem: b.publicKeyPem, publicKeyPem: a.publicKeyPem });

  await assert.rejects(
    broker.callDevice({ requestId: 'generation-session-1', deviceId: 'generation-session-device', tool: 'ping' }),
    /authorization changed|offline/i
  );
  assert.equal(broker.listDevices()[0].online, false);
});

test('dispatch rechecks authorization under serialization after a stale preflight read', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'device-auth-dispatch-race-'));
  const dbPath = path.join(dir, 'devices.sqlite');
  const baseStore = createDeviceStore({ dbPath });
  const externalStore = createDeviceStore({ dbPath });
  let armed = false;
  let oldKey;
  let newKey;
  const brokerStore = {
    list: () => baseStore.list(),
    get: deviceId => {
      const row = baseStore.get(deviceId);
      if (armed && row) {
        armed = false;
        externalStore.rotate({ deviceId, expectedPublicKeyPem: oldKey, publicKeyPem: newKey });
      }
      return row;
    },
    enroll: args => baseStore.enroll(args),
    rotate: args => baseStore.rotate(args),
    revoke: deviceId => baseStore.revoke(deviceId),
    withCurrentAuthorization: (args, callback) => baseStore.withCurrentAuthorization(args, callback),
    close: () => baseStore.close()
  };
  const server = http.createServer((_req, res) => res.end('ok'));
  const broker = createDeviceBroker({ enrollmentToken: 'dev-secret', deviceStore: brokerStore, requestTimeoutMs: 50 });
  broker.attach(server);
  const port = await listen(server);
  t.after(async () => {
    await broker.shutdown();
    brokerStore.close();
    externalStore.close();
    await closeServer(server);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const a = keyPair();
  const b = keyPair();
  oldKey = a.publicKeyPem;
  newKey = b.publicKeyPem;
  const ws = await openSocket(port, 'dev-secret');
  t.after(() => ws.close());
  await enroll(ws, { deviceId: 'dispatch-race-device', ...a });
  armed = true;

  await assert.rejects(
    broker.callDevice({ requestId: 'dispatch-race-1', deviceId: 'dispatch-race-device', tool: 'ping', timeoutMs: 30 }),
    /authorization changed|revoked|offline/i
  );
});

test('enrollment cannot bind an externally rotated key it did not prove', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'device-auth-enroll-race-'));
  const dbPath = path.join(dir, 'devices.sqlite');
  const baseStore = createDeviceStore({ dbPath });
  const externalStore = createDeviceStore({ dbPath });
  const a = keyPair();
  const b = keyPair();
  const brokerStore = {
    list: () => baseStore.list(),
    get: deviceId => baseStore.get(deviceId),
    enroll: args => {
      const enrolled = baseStore.enroll(args);
      externalStore.rotate({ deviceId: args.deviceId, expectedPublicKeyPem: a.publicKeyPem, publicKeyPem: b.publicKeyPem });
      return enrolled;
    },
    rotate: args => baseStore.rotate(args),
    revoke: deviceId => baseStore.revoke(deviceId),
    withCurrentAuthorization: (args, callback) => baseStore.withCurrentAuthorization(args, callback),
    close: () => baseStore.close()
  };
  const server = http.createServer((_req, res) => res.end('ok'));
  const broker = createDeviceBroker({ enrollmentToken: 'dev-secret', deviceStore: brokerStore });
  broker.attach(server);
  const port = await listen(server);
  t.after(async () => {
    await broker.shutdown();
    brokerStore.close();
    externalStore.close();
    await closeServer(server);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const ws = await openSocket(port, 'dev-secret');
  await assert.rejects(
    enroll(ws, { deviceId: 'enroll-race-device', ...a }),
    /socket closed 4003/i
  );
  const stored = baseStore.get('enroll-race-device');
  assert.equal(stored.publicKeyPem, b.publicKeyPem);
  assert.equal(stored.authorizationGeneration, 2);
  assert.equal(broker.listDevices().length, 0);
});

test('result acceptance rechecks authorization under serialization after a stale preflight read', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'device-auth-result-race-'));
  const dbPath = path.join(dir, 'devices.sqlite');
  const baseStore = createDeviceStore({ dbPath });
  const externalStore = createDeviceStore({ dbPath });
  let armed = false;
  let oldKey;
  let newKey;
  const brokerStore = {
    list: () => baseStore.list(),
    get: deviceId => {
      const row = baseStore.get(deviceId);
      if (armed && row) {
        armed = false;
        externalStore.rotate({ deviceId, expectedPublicKeyPem: oldKey, publicKeyPem: newKey });
      }
      return row;
    },
    enroll: args => baseStore.enroll(args),
    rotate: args => baseStore.rotate(args),
    revoke: deviceId => baseStore.revoke(deviceId),
    withCurrentAuthorization: (args, callback) => baseStore.withCurrentAuthorization(args, callback),
    close: () => baseStore.close()
  };
  const server = http.createServer((_req, res) => res.end('ok'));
  const broker = createDeviceBroker({ enrollmentToken: 'dev-secret', deviceStore: brokerStore, requestTimeoutMs: 1000 });
  broker.attach(server);
  const port = await listen(server);
  t.after(async () => {
    await broker.shutdown();
    brokerStore.close();
    externalStore.close();
    await closeServer(server);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const a = keyPair();
  const b = keyPair();
  oldKey = a.publicKeyPem;
  newKey = b.publicKeyPem;
  const ws = await openSocket(port, 'dev-secret');
  await enroll(ws, { deviceId: 'result-race-device', ...a });
  const toolCallPromise = nextMessage(ws);
  const pendingCall = broker.callDevice({ requestId: 'result-race-1', deviceId: 'result-race-device', tool: 'ping' });
  const pendingRejected = assert.rejects(pendingCall, /authorization changed.*not replayed/i);
  const toolCall = await toolCallPromise;
  armed = true;
  ws.send(JSON.stringify({
    protocol_version: 1,
    type: 'tool_result',
    request_id: toolCall.request_id,
    device_id: 'result-race-device',
    connection_epoch: toolCall.connection_epoch,
    timestamp: Date.now(),
    payload: { content: [{ type: 'text', text: 'must-not-resolve' }] }
  }));
  await pendingRejected;
});

test('delayed old send callback cannot remove replacement request with the same request id', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'device-auth-send-callback-'));
  const dbPath = path.join(dir, 'devices.sqlite');
  const originalSend = WebSocket.prototype.send;
  let heldCallback = null;
  let holdFirstToolCall = true;
  WebSocket.prototype.send = function patchedSend(data, options, callback) {
    let cb = callback;
    let opts = options;
    if (typeof options === 'function') {
      cb = options;
      opts = undefined;
    }
    let parsed = null;
    try { parsed = JSON.parse(Buffer.isBuffer(data) ? data.toString('utf8') : String(data)); } catch {}
    if (holdFirstToolCall && parsed?.type === 'tool_call' && typeof cb === 'function') {
      holdFirstToolCall = false;
      heldCallback = cb;
      return opts === undefined
        ? originalSend.call(this, data, () => {})
        : originalSend.call(this, data, opts, () => {});
    }
    return originalSend.apply(this, arguments);
  };
  t.after(() => { WebSocket.prototype.send = originalSend; });

  const { broker, port } = await createHarness(t, dbPath);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const keys = keyPair();
  const first = await openSocket(port, 'dev-secret');
  await enroll(first, { deviceId: 'send-callback-device', ...keys });

  const firstToolCallPromise = nextMessage(first);
  const firstCall = broker.callDevice({ requestId: 'reused-id', deviceId: 'send-callback-device', tool: 'ping' });
  const firstRejected = assert.rejects(firstCall, /replaced.*not replayed/i);
  await firstToolCallPromise;
  const replacement = await openSocket(port);
  t.after(() => replacement.close());
  await reconnect(replacement, { deviceId: 'send-callback-device', privateKey: keys.privateKey });
  await firstRejected;
  assert.equal(typeof heldCallback, 'function');

  const secondToolCallPromise = nextMessage(replacement);
  const secondCall = broker.callDevice({ requestId: 'reused-id', deviceId: 'send-callback-device', tool: 'ping' });
  const secondToolCall = await secondToolCallPromise;
  heldCallback(new Error('late old send failure'));
  replacement.send(JSON.stringify({
    protocol_version: 1,
    type: 'tool_result',
    request_id: secondToolCall.request_id,
    device_id: 'send-callback-device',
    connection_epoch: secondToolCall.connection_epoch,
    timestamp: Date.now(),
    payload: { content: [{ type: 'text', text: 'new-result' }] }
  }));
  const result = await secondCall;
  assert.equal(result.content[0].text, 'new-result');
});

test('request id cannot be reused within the same connection epoch after timeout', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'device-auth-request-reuse-'));
  const dbPath = path.join(dir, 'devices.sqlite');
  const { broker, port } = await createHarness(t, dbPath);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const keys = keyPair();
  const ws = await openSocket(port, 'dev-secret');
  t.after(() => ws.close());
  await enroll(ws, { deviceId: 'request-reuse-device', ...keys });

  const firstToolCallPromise = nextMessage(ws);
  const firstCall = broker.callDevice({ requestId: 'same-epoch-id', deviceId: 'request-reuse-device', tool: 'ping', timeoutMs: 20 });
  await firstToolCallPromise;
  await assert.rejects(firstCall, /timed out/i);

  await assert.rejects(
    broker.callDevice({ requestId: 'same-epoch-id', deviceId: 'request-reuse-device', tool: 'ping', timeoutMs: 20 }),
    /already used|cannot be reused|connection epoch/i
  );
});

