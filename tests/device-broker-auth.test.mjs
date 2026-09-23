import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { generateKeyPairSync, sign, verify } from 'node:crypto';
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
import { createDeviceStore } from '../scripts/device-store.mjs';

const innerTlsFixtureDir = path.join('tests', 'fixtures', 'device-inner-tls');
const innerTlsCa = fs.readFileSync(path.join(innerTlsFixtureDir, 'ca-cert.pem'));
const innerTlsCert = fs.readFileSync(path.join(innerTlsFixtureDir, 'server-cert.pem'));
const innerTlsKey = fs.readFileSync(path.join(innerTlsFixtureDir, 'server-key.pem'));

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

async function reconnect(ws, { deviceId, privateKey, packageVersion = null }) {
  const challengePromise = nextMessage(ws);
  ws.send(JSON.stringify({
    protocol_version: 1,
    type: 'auth_hello',
    device_id: deviceId,
    timestamp: Date.now(),
    payload: { agent_version: 'test-2', capabilities: ['ping'], ...(packageVersion ? { package_version: packageVersion } : {}) }
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

async function createHarness(t, dbPath, brokerOptions = {}) {
  const store = createDeviceStore({ dbPath });
  const server = http.createServer((_req, res) => res.end('ok'));
  const broker = createDeviceBroker({
    enrollmentToken: 'dev-secret',
    deviceStore: store,
    requestTimeoutMs: 1000,
    requireAccountOwnership: false,
    innerTls: { cert: innerTlsCert, key: innerTlsKey },
    ...brokerOptions
  });
  broker.attach(server);
  const port = await listen(server);
  t.after(async () => {
    await broker.shutdown();
    store.close();
    await closeServer(server);
  });
  return { store, broker, port };
}

async function openV2Tls(port) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/device`, DEVICE_INNER_TLS_SUBPROTOCOL);
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  const secure = tls.connect({
    socket: createWebSocketDuplex(ws),
    ca: innerTlsCa,
    servername: 'localhost',
    minVersion: 'TLSv1.3',
    rejectUnauthorized: true
  });
  await new Promise((resolve, reject) => {
    secure.once('secureConnect', resolve);
    secure.once('error', reject);
  });
  const queue = [];
  const waiters = [];
  const parser = createJsonFrameParser({
    onMessage(message) {
      const waiter = waiters.shift();
      if (waiter) waiter.resolve(message);
      else queue.push(message);
    }
  });
  secure.on('data', chunk => parser.push(chunk));
  secure.on('error', error => {
    while (waiters.length) waiters.shift().reject(error);
  });
  ws.on('close', (code, reason) => {
    const error = new Error(`socket closed ${code}: ${reason.toString()}`);
    while (waiters.length) waiters.shift().reject(error);
  });
  return {
    ws,
    secure,
    send: message => secure.write(encodeJsonFrame(message)),
    next: () => queue.length ? Promise.resolve(queue.shift()) : new Promise((resolve, reject) => waiters.push({ resolve, reject }))
  };
}

function signV2Reconnect({ secure, deviceId, nonce, publicKeyPem, privateKey }) {
  const exporter = secure.exportKeyingMaterial(
    32,
    'EXPERIMENTAL-HCU-MCP-DEVICE-AUTH-V2',
    buildDeviceAuthExporterContext({ deviceId, mode: 'reconnect' })
  );
  return sign(null, buildDeviceAuthChallengeV2({
    deviceId,
    mode: 'reconnect',
    nonce,
    exporter,
    publicKeyPem
  }), privateKey).toString('base64');
}

test('v2 challenge encoding binds mode nonce exporter key and grant', async () => {
  const brokerModule = await import('../scripts/device-broker.mjs');
  assert.equal(typeof brokerModule.buildDeviceAuthChallengeV2, 'function');
  const keys = keyPair();
  const base = {
    deviceId: 'bound-device',
    mode: 'pair',
    nonce: Buffer.alloc(32, 3),
    exporter: Buffer.alloc(32, 7),
    publicKeyPem: keys.publicKeyPem,
    grant: 'grant-one'
  };
  const challenge = brokerModule.buildDeviceAuthChallengeV2(base);
  const signature = sign(null, challenge, keys.privateKey);
  const otherKeys = keyPair();
  assert.equal(verify(null, challenge, keys.publicKeyPem, signature), true);
  for (const mutation of [
    { mode: 'enroll' },
    { nonce: Buffer.alloc(32, 4) },
    { exporter: Buffer.alloc(32, 8) },
    { publicKeyPem: otherKeys.publicKeyPem },
    { grant: 'grant-two' },
    { deviceId: 'other-device' }
  ]) {
    assert.equal(verify(null, brokerModule.buildDeviceAuthChallengeV2({ ...base, ...mutation }), keys.publicKeyPem, signature), false);
  }
});

test('one-time token enrollment persists Ed25519 identity and reconnect needs only proof of possession', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'device-auth-'));
  const dbPath = path.join(dir, 'devices.sqlite');
  const { store, broker, port } = await createHarness(t, dbPath);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const keys = keyPair();

  const first = await openSocket(port, 'dev-secret');
  const firstOk = await enroll(first, { deviceId: 'device-auth', ...keys });
  assert.equal(firstOk.type, 'auth_ok');
  assert.equal(firstOk.connection_epoch, 1);
  assert.equal(store.get('device-auth').revokedAt, null);
  first.close();
  await new Promise(resolve => setTimeout(resolve, 50));

  const second = await openSocket(port);
  t.after(() => second.close());
  const secondOk = await reconnect(second, { deviceId: 'device-auth', privateKey: keys.privateKey });
  assert.equal(secondOk.type, 'auth_ok');
  assert.equal(secondOk.connection_epoch, 2);
  const [device] = broker.listDevices();
  assert.equal(device.online, true);
  assert.equal(device.connectionEpoch, 2);
});

test('v2 reconnect uses inner TLS exporter proof and raises the durable protocol floor', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'device-auth-v2-'));
  const dbPath = path.join(dir, 'devices.sqlite');
  const { store, port } = await createHarness(t, dbPath);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const keys = keyPair();
  const first = await openSocket(port, 'dev-secret');
  await enroll(first, { deviceId: 'v2-device', ...keys });
  first.close();
  await new Promise(resolve => setTimeout(resolve, 25));

  const ws = new WebSocket(`ws://127.0.0.1:${port}/device`, DEVICE_INNER_TLS_SUBPROTOCOL);
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  const secure = tls.connect({
    socket: createWebSocketDuplex(ws),
    ca: innerTlsCa,
    servername: 'localhost',
    minVersion: 'TLSv1.3',
    rejectUnauthorized: true
  });
  await Promise.race([
    new Promise((resolve, reject) => {
      secure.once('secureConnect', resolve);
      secure.once('error', reject);
    }),
    new Promise((_, reject) => setTimeout(() => reject(new Error('inner TLS handshake timeout')), 1000))
  ]);

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
  const next = async () => queue.length ? queue.shift() : await new Promise(resolve => waiters.push(resolve));
  const send = message => secure.write(encodeJsonFrame(message));

  send({ protocol_version: 2, type: 'auth_hello', device_id: 'v2-device', timestamp: Date.now(), payload: { capabilities: ['ping'] } });
  const challenge = await next();
  assert.equal(challenge.type, 'auth_challenge');
  assert.equal(challenge.payload.mode, 'reconnect');
  const exporter = secure.exportKeyingMaterial(
    32,
    'EXPERIMENTAL-HCU-MCP-DEVICE-AUTH-V2',
    buildDeviceAuthExporterContext({ deviceId: 'v2-device', mode: 'reconnect' })
  );
  const signature = sign(null, buildDeviceAuthChallengeV2({
    deviceId: 'v2-device',
    mode: 'reconnect',
    nonce: challenge.payload.nonce,
    exporter,
    publicKeyPem: keys.publicKeyPem
  }), keys.privateKey).toString('base64');
  send({ protocol_version: 2, type: 'auth_response', device_id: 'v2-device', timestamp: Date.now(), payload: { signature } });
  const ok = await next();
  assert.equal(ok.type, 'auth_ok');
  assert.equal(ok.protocol_version, 2);
  assert.equal(store.get('v2-device').minProtocol, 2);
  secure.destroy();
  ws.terminate();
});

test('copied v2 signature from one inner TLS session is rejected on a new session', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'device-auth-v2-replay-'));
  const dbPath = path.join(dir, 'devices.sqlite');
  const { port } = await createHarness(t, dbPath);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const keys = keyPair();
  const deviceId = 'v2-replay-device';

  const enrolled = await openSocket(port, 'dev-secret');
  await enroll(enrolled, { deviceId, ...keys });
  enrolled.close();
  await new Promise(resolve => setTimeout(resolve, 25));

  const first = await openV2Tls(port);
  first.send({ protocol_version: 2, type: 'auth_hello', device_id: deviceId, timestamp: Date.now(), payload: {} });
  const firstChallenge = await first.next();
  const copiedSignature = signV2Reconnect({
    secure: first.secure,
    deviceId,
    nonce: firstChallenge.payload.nonce,
    publicKeyPem: keys.publicKeyPem,
    privateKey: keys.privateKey
  });
  first.send({ protocol_version: 2, type: 'auth_response', device_id: deviceId, timestamp: Date.now(), payload: { signature: copiedSignature } });
  assert.equal((await first.next()).type, 'auth_ok');
  first.secure.destroy();
  first.ws.terminate();
  await new Promise(resolve => setTimeout(resolve, 25));

  const second = await openV2Tls(port);
  t.after(() => {
    second.secure.destroy();
    try { second.ws.terminate(); } catch {}
  });
  second.send({ protocol_version: 2, type: 'auth_hello', device_id: deviceId, timestamp: Date.now(), payload: {} });
  const secondChallenge = await second.next();
  assert.notEqual(secondChallenge.payload.nonce, firstChallenge.payload.nonce);
  second.send({ protocol_version: 2, type: 'auth_response', device_id: deviceId, timestamp: Date.now(), payload: { signature: copiedSignature } });
  await assert.rejects(second.next(), /socket closed 4003|invalid signature/i);
});

test('v2 enrollment token stays inside inner TLS and is bound into the exporter proof', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'device-auth-v2-enroll-'));
  const dbPath = path.join(dir, 'devices.sqlite');
  const { store, port } = await createHarness(t, dbPath);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const keys = keyPair();
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
      if (waiter) waiter.resolve(message);
      else queue.push(message);
    }
  });
  secure.on('data', chunk => parser.push(chunk));
  secure.once('error', error => { const waiter = waiters.shift(); waiter?.reject(error); });
  ws.once('close', (code, reason) => { const waiter = waiters.shift(); waiter?.reject(new Error(`socket closed ${code}: ${reason.toString()}`)); });
  const next = async () => queue.length ? queue.shift() : await new Promise((resolve, reject) => waiters.push({ resolve, reject }));
  const send = message => secure.write(encodeJsonFrame(message));

  send({
    protocol_version: 2,
    type: 'enroll_hello',
    device_id: 'v2-enroll-device',
    timestamp: Date.now(),
    payload: {
      public_key_pem: keys.publicKeyPem,
      enrollment_grant: 'dev-secret',
      capabilities: ['ping']
    }
  });
  const challenge = await next();
  assert.equal(challenge.payload.mode, 'enroll');
  const exporter = secure.exportKeyingMaterial(
    32,
    'EXPERIMENTAL-HCU-MCP-DEVICE-AUTH-V2',
    buildDeviceAuthExporterContext({ deviceId: 'v2-enroll-device', mode: 'enroll' })
  );
  const signature = sign(null, buildDeviceAuthChallengeV2({
    deviceId: 'v2-enroll-device',
    mode: 'enroll',
    nonce: challenge.payload.nonce,
    exporter,
    publicKeyPem: keys.publicKeyPem,
    grant: 'dev-secret'
  }), keys.privateKey).toString('base64');
  send({ protocol_version: 2, type: 'auth_response', device_id: 'v2-enroll-device', timestamp: Date.now(), payload: { signature } });
  const ok = await next();
  assert.equal(ok.type, 'auth_ok');
  assert.equal(store.get('v2-enroll-device').minProtocol, 2);
  secure.destroy();
  ws.terminate();
});

test('v1 reconnect is rejected after the stored protocol floor is raised to v2', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'device-auth-floor-'));
  const dbPath = path.join(dir, 'devices.sqlite');
  const { store, port } = await createHarness(t, dbPath);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const keys = keyPair();
  const first = await openSocket(port, 'dev-secret');
  await enroll(first, { deviceId: 'floor-device', ...keys });
  first.close();
  await new Promise(resolve => setTimeout(resolve, 25));
  store.raiseProtocolFloor('floor-device', 2);

  const second = await openSocket(port);
  const closed = new Promise(resolve => second.once('close', (code, reason) => resolve({ code, reason: reason.toString() })));
  second.send(JSON.stringify({ protocol_version: 1, type: 'auth_hello', device_id: 'floor-device', timestamp: Date.now(), payload: {} }));
  const result = await closed;
  assert.equal(result.code, 4003);
  assert.match(result.reason, /protocol|v2|upgrade/i);
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
  assert.equal(broker.listDevices().length, 0);
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
  const { store, broker, port } = await createHarness(t, dbPath);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const keys = keyPair();

  const ws = await openSocket(port, 'dev-secret');
  await enroll(ws, { deviceId: 'revoked-device', ...keys });
  const closed = new Promise(resolve => ws.once('close', (code, reason) => resolve({ code, reason: reason.toString() })));
  const forgotten = broker.revokeDevice('revoked-device');
  const closeResult = await closed;
  assert.equal(closeResult.code, 4004);
  assert.equal(forgotten.forgotten, true);
  assert.equal(broker.listDevices().length, 0);
  assert.equal(store.get('revoked-device'), null);

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
  const broker1 = createDeviceBroker({ enrollmentToken: 'dev-secret', deviceStore: store1, requireAccountOwnership: false });
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
  const broker2 = createDeviceBroker({ enrollmentToken: 'dev-secret', deviceStore: store2, requireAccountOwnership: false });
  broker2.attach(server2);
  const port2 = await listen(server2);
  t.after(async () => {
    await broker2.shutdown();
    store2.close();
    await closeServer(server2);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  assert.equal(broker2.listDevices()[0].online, false);
  assert.equal(broker2.listDevices()[0].agentVersion, 'test-1');
  const ws2 = await openSocket(port2);
  t.after(() => ws2.close());
  const ok = await reconnect(ws2, { deviceId: 'restart-device', privateKey: keys.privateKey });
  assert.equal(ok.type, 'auth_ok');
  assert.equal(broker2.listDevices()[0].online, true);
  assert.equal(broker2.listDevices()[0].agentVersion, 'test-2');
  assert.equal(store2.get('restart-device').agentVersion, 'test-2');
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
  const broker = createDeviceBroker({ enrollmentToken: 'dev-secret', deviceStore: brokerStore, requestTimeoutMs: 50, requireAccountOwnership: false });
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
  const broker = createDeviceBroker({ enrollmentToken: 'dev-secret', deviceStore: brokerStore, requireAccountOwnership: false });
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
  const broker = createDeviceBroker({ enrollmentToken: 'dev-secret', deviceStore: brokerStore, requestTimeoutMs: 1000, requireAccountOwnership: false });
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

test('request id can be safely reused within the same connection epoch after timeout', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'device-auth-request-reuse-'));
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
  const ws = await openSocket(port, 'dev-secret');
  t.after(() => ws.close());
  await enroll(ws, { deviceId: 'request-reuse-device', ...keys });

  const firstToolCallPromise = nextMessage(ws);
  const firstCall = broker.callDevice({ requestId: 'same-epoch-id', deviceId: 'request-reuse-device', tool: 'ping', timeoutMs: 20 });
  const firstToolCall = await firstToolCallPromise;
  const firstWireRequestId = firstToolCall.request_id;
  assert.notEqual(firstWireRequestId, 'same-epoch-id');
  await assert.rejects(
    broker.callDevice({ requestId: 'same-epoch-id', deviceId: 'request-reuse-device', tool: 'ping', timeoutMs: 20 }),
    /already pending/i
  );
  await assert.rejects(
    firstCall,
    error => error?.code === 'DEVICE_REQUEST_TIMEOUT' && /timed out/i.test(error.message)
  );
  assert.equal(typeof heldCallback, 'function');

  const secondToolCallPromise = nextMessage(ws);
  const secondCall = broker.callDevice({ requestId: 'same-epoch-id', deviceId: 'request-reuse-device', tool: 'ping' });
  const secondToolCall = await secondToolCallPromise;
  assert.notEqual(secondToolCall.request_id, firstWireRequestId);
  heldCallback(new Error('late first send failure'));
  ws.send(JSON.stringify({
    protocol_version: 1,
    type: 'tool_result',
    request_id: firstWireRequestId,
    device_id: 'request-reuse-device',
    connection_epoch: secondToolCall.connection_epoch,
    timestamp: Date.now(),
    payload: { content: [{ type: 'text', text: 'old-result' }] }
  }));
  ws.send(JSON.stringify({
    protocol_version: 1,
    type: 'tool_result',
    request_id: secondToolCall.request_id,
    device_id: 'request-reuse-device',
    connection_epoch: secondToolCall.connection_epoch,
    timestamp: Date.now(),
    payload: { content: [{ type: 'text', text: 'new-result' }] }
  }));
  const result = await secondCall;
  assert.equal(result.content[0].text, 'new-result');
});

test('account owner can dispatch a fixed-version device update and completion follows reconnect version', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'device-auth-self-update-'));
  const dbPath = path.join(dir, 'devices.sqlite');
  const { store, broker, port } = await createHarness(t, dbPath);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const keys = keyPair();
  store.enroll({
    deviceId: 'update-device',
    publicKeyPem: keys.publicKeyPem,
    ownerAccountId: 'account-1',
    agentVersion: 'test-1',
    packageVersion: '1.0.5'
  });

  const ws = await openSocket(port);
  t.after(() => ws.close());
  await reconnect(ws, { deviceId: 'update-device', privateKey: keys.privateKey, packageVersion: '1.0.5' });

  const updateMessagePromise = nextMessage(ws);
  const requested = broker.requestDeviceUpdate({
    accountId: 'account-1',
    deviceId: 'update-device',
    targetVersion: '1.0.6'
  });
  assert.equal(requested.state, 'requested');
  assert.equal(requested.targetVersion, '1.0.6');

  const updateMessage = await updateMessagePromise;
  assert.equal(updateMessage.type, 'device_update');
  assert.equal(updateMessage.device_id, 'update-device');
  assert.equal(updateMessage.payload.target_version, '1.0.6');

  ws.send(JSON.stringify({
    protocol_version: 1,
    type: 'device_update_status',
    request_id: updateMessage.request_id,
    device_id: 'update-device',
    connection_epoch: updateMessage.connection_epoch,
    timestamp: Date.now(),
    payload: { state: 'accepted', target_version: '1.0.6', package_version: '1.0.5' }
  }));
  await new Promise(resolve => setTimeout(resolve, 15));
  assert.equal(broker.listDevices({ accountId: 'account-1' })[0].update.state, 'accepted');

  ws.send(JSON.stringify({
    protocol_version: 1,
    type: 'device_update_status',
    request_id: updateMessage.request_id,
    device_id: 'update-device',
    connection_epoch: updateMessage.connection_epoch,
    timestamp: Date.now(),
    payload: { state: 'installed', target_version: '1.0.6', package_version: '1.0.5' }
  }));
  await new Promise(resolve => setTimeout(resolve, 15));
  assert.equal(broker.listDevices({ accountId: 'account-1' })[0].update.state, 'installed');

  const replacement = await openSocket(port);
  t.after(() => replacement.close());
  await reconnect(replacement, { deviceId: 'update-device', privateKey: keys.privateKey, packageVersion: '1.0.6' });
  const visible = broker.listDevices({ accountId: 'account-1' })[0];
  assert.equal(visible.packageVersion, '1.0.6');
  assert.equal(visible.update.state, 'complete');
});

test('device update request times out without progress and can be retried safely', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'device-auth-update-timeout-'));
  const dbPath = path.join(dir, 'devices.sqlite');
  const { store, broker, port } = await createHarness(t, dbPath, { updateTimeoutMs: 40 });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const keys = keyPair();
  store.enroll({
    deviceId: 'timeout-device',
    publicKeyPem: keys.publicKeyPem,
    ownerAccountId: 'account-1',
    agentVersion: 'test-1',
    packageVersion: '1.0.6'
  });

  const ws = await openSocket(port);
  t.after(() => ws.close());
  await reconnect(ws, { deviceId: 'timeout-device', privateKey: keys.privateKey, packageVersion: '1.0.6' });

  const firstMessagePromise = nextMessage(ws);
  const first = broker.requestDeviceUpdate({ accountId: 'account-1', deviceId: 'timeout-device', targetVersion: '1.0.7' });
  const firstMessage = await firstMessagePromise;
  assert.equal(firstMessage.type, 'device_update');
  assert.equal(first.state, 'requested');

  await new Promise(resolve => setTimeout(resolve, 70));
  const timedOut = broker.listDevices({ accountId: 'account-1' })[0].update;
  assert.equal(timedOut.state, 'failed');
  assert.equal(timedOut.error.code, 'DEVICE_UPDATE_TIMEOUT');

  const retryMessagePromise = nextMessage(ws);
  const retry = broker.requestDeviceUpdate({ accountId: 'account-1', deviceId: 'timeout-device', targetVersion: '1.0.7' });
  const retryMessage = await retryMessagePromise;
  assert.equal(retry.state, 'requested');
  assert.notEqual(retry.requestId, first.requestId);
  assert.equal(retryMessage.request_id, retry.requestId);
});

test('legacy Linux 1.0.7 device requires one-time 1.0.8 bootstrap before dashboard self-update', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'device-auth-linux-bootstrap-'));
  const dbPath = path.join(dir, 'devices.sqlite');
  const { store, broker, port } = await createHarness(t, dbPath);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const keys = keyPair();
  store.enroll({
    deviceId: 'linux-107',
    publicKeyPem: keys.publicKeyPem,
    ownerAccountId: 'account-1',
    agentVersion: 'test-1',
    packageVersion: '1.0.7',
    platform: 'linux'
  });

  const ws = await openSocket(port);
  t.after(() => ws.close());
  await reconnect(ws, { deviceId: 'linux-107', privateKey: keys.privateKey, packageVersion: '1.0.7' });

  assert.throws(
    () => broker.requestDeviceUpdate({ accountId: 'account-1', deviceId: 'linux-107', targetVersion: '1.0.8' }),
    error => error?.code === 'DEVICE_UPDATE_BOOTSTRAP_REQUIRED' && /1\.0\.8/.test(error.message)
  );
});

test('legacy Windows 1.0.5 device requires one-time bootstrap before dashboard self-update', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'device-auth-windows-bootstrap-'));
  const dbPath = path.join(dir, 'devices.sqlite');
  const { store, broker, port } = await createHarness(t, dbPath);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const keys = keyPair();
  store.enroll({
    deviceId: 'windows-105',
    publicKeyPem: keys.publicKeyPem,
    ownerAccountId: 'account-1',
    agentVersion: 'test-1',
    packageVersion: '1.0.5',
    platform: 'win32'
  });

  const ws = await openSocket(port);
  t.after(() => ws.close());
  await reconnect(ws, { deviceId: 'windows-105', privateKey: keys.privateKey, packageVersion: '1.0.5' });

  assert.throws(
    () => broker.requestDeviceUpdate({ accountId: 'account-1', deviceId: 'windows-105', targetVersion: '1.0.7' }),
    error => error?.code === 'DEVICE_UPDATE_BOOTSTRAP_REQUIRED' && /1\.0\.6/.test(error.message)
  );
});

