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

function keys() {
  const pair = crypto.generateKeyPairSync('ed25519');
  return { publicKeyPem: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString(), privateKey: pair.privateKey };
}
function pkce() {
  const verifier = crypto.randomBytes(32).toString('base64url');
  return { verifier, challenge: crypto.createHash('sha256').update(verifier).digest('base64url') };
}
function next(ws) {
  return new Promise((resolve, reject) => {
    const message = raw => { cleanup(); resolve(JSON.parse(raw.toString())); };
    const close = (code, reason) => { cleanup(); reject(new Error(`closed ${code}: ${reason.toString()}`)); };
    const cleanup = () => { ws.off('message', message); ws.off('close', close); };
    ws.once('message', message); ws.once('close', close);
  });
}
async function open(port, credential) {
  return await new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/device`, { headers: credential ? { authorization: `Bearer ${credential}` } : {} });
    ws.once('error', reject); ws.once('open', () => resolve(ws));
  });
}
async function signChallenge(ws, deviceId, privateKey, challenge) {
  const signature = crypto.sign(null, buildDeviceAuthChallenge({ deviceId, nonce: challenge.payload.nonce }), privateKey).toString('base64');
  const response = next(ws);
  ws.send(JSON.stringify({ protocol_version: 1, type: 'auth_response', device_id: deviceId, timestamp: Date.now(), payload: { signature } }));
  return await response;
}
function grant(store, deviceId, publicKeyPem) {
  const p = pkce();
  const started = store.start({ clientId: 'mcp-device', deviceId, deviceName: 'Linked Device', publicKeyPem, codeChallenge: p.challenge });
  store.approve({ userCode: started.userCode, accountLabel: 'Example Gateway' });
  return store.poll({ deviceCode: started.deviceCode, clientId: 'mcp-device', codeVerifier: p.verifier }).enrollmentGrant;
}

test('existing local identity can migrate into an empty central device store only after signed pairing proof', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'device-account-migrate-'));
  const dbPath = path.join(dir, 'devices.sqlite');
  const store = createDeviceStore({ dbPath });
  const pairing = createDevicePairingStore({ dbPath });
  const key = keys();
  const broker = createDeviceBroker({ deviceStore: store, pairingStore: pairing });
  const server = http.createServer((_req, res) => res.end('ok'));
  broker.attach(server);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  t.after(async () => { await broker.shutdown(); pairing.close(); store.close(); await new Promise(resolve => server.close(resolve)); fs.rmSync(dir, { recursive: true, force: true }); });

  const pairingGrant = grant(pairing, 'migrated-device', key.publicKeyPem);
  const ws = await open(port, pairingGrant);
  t.after(() => ws.close());
  const challengePromise = next(ws);
  ws.send(JSON.stringify({
    protocol_version: 1,
    type: 'pair_hello',
    device_id: 'migrated-device',
    timestamp: Date.now(),
    payload: { agent_version: 'test', capabilities: ['ping'], public_key_pem: key.publicKeyPem }
  }));
  const challenge = await challengePromise;
  assert.equal(challenge.type, 'auth_challenge');
  assert.equal(store.get('migrated-device'), null);

  const linked = await signChallenge(ws, 'migrated-device', key.privateKey, challenge);
  assert.equal(linked.type, 'auth_ok');
  assert.deepEqual(linked.payload.account, { connected: true, label: 'Example Gateway' });
  const stored = store.get('migrated-device');
  assert.equal(stored.deviceName, 'Linked Device');
  assert.equal(stored.accountLabel, 'Example Gateway');
  assert.equal(stored.publicKeyPem, key.publicKeyPem);
});

test('enrolled device can relink and logout account only after signed proof', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'device-account-link-'));
  const dbPath = path.join(dir, 'devices.sqlite');
  const store = createDeviceStore({ dbPath });
  const pairing = createDevicePairingStore({ dbPath });
  const key = keys();
  store.enroll({ deviceId: 'account-device', publicKeyPem: key.publicKeyPem, deviceName: 'Linked Device' });
  const broker = createDeviceBroker({ deviceStore: store, pairingStore: pairing });
  const server = http.createServer((_req, res) => res.end('ok'));
  broker.attach(server);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  t.after(async () => { await broker.shutdown(); pairing.close(); store.close(); await new Promise(resolve => server.close(resolve)); fs.rmSync(dir, { recursive: true, force: true }); });

  const pairingGrant = grant(pairing, 'account-device', key.publicKeyPem);
  const ws = await open(port, pairingGrant);
  t.after(() => ws.close());
  const challengePromise = next(ws);
  ws.send(JSON.stringify({ protocol_version: 1, type: 'pair_hello', device_id: 'account-device', timestamp: Date.now(), payload: { agent_version: 'test', capabilities: ['ping'] } }));
  const challenge = await challengePromise;
  assert.equal(challenge.type, 'auth_challenge');
  const linked = await signChallenge(ws, 'account-device', key.privateKey, challenge);
  assert.equal(linked.type, 'auth_ok');
  assert.deepEqual(linked.payload.account, { connected: true, label: 'Example Gateway' });
  assert.equal(store.get('account-device').accountLabel, 'Example Gateway');

  const statusPromise = next(ws);
  ws.send(JSON.stringify({ protocol_version: 1, type: 'account_logout', device_id: 'account-device', connection_epoch: linked.connection_epoch, timestamp: Date.now(), payload: {} }));
  const status = await statusPromise;
  assert.equal(status.type, 'status_snapshot');
  assert.deepEqual(status.payload.account, { connected: false, label: null });
  assert.equal(store.get('account-device').accountLabel, null);
});
