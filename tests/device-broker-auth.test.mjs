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

