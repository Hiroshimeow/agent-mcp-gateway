import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { WebSocket } from 'ws';

import { createDeviceBroker } from '../scripts/device-broker.mjs';

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

function connectDevice(port, token, hello = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/device`, {
      headers: { authorization: `Bearer ${token}` }
    });
    ws.once('error', reject);
    ws.once('open', () => {
      ws.send(JSON.stringify({
        protocol_version: 1,
        type: 'hello',
        device_id: hello.device_id || 'device-test',
        timestamp: Date.now(),
        payload: {
          agent_version: 'test-1',
          capabilities: ['ping', 'read_text_file'],
          ...hello.payload
        }
      }));
      resolve(ws);
    });
  });
}

async function waitUntil(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('Timed out waiting for condition');
}

test('device broker authenticates enrollment token, registers hello, and routes a ping call', async t => {
  const server = http.createServer((_req, res) => res.end('ok'));
  const broker = createDeviceBroker({ enrollmentToken: 'dev-secret', requestTimeoutMs: 1000 });
  broker.attach(server);
  const port = await listen(server);
  t.after(async () => {
    await broker.shutdown();
    await closeServer(server);
  });

  const ws = await connectDevice(port, 'dev-secret');
  t.after(() => ws.close());
  ws.on('message', raw => {
    const message = JSON.parse(raw.toString());
    if (message.type !== 'tool_call') return;
    ws.send(JSON.stringify({
      protocol_version: 1,
      type: 'tool_result',
      request_id: message.request_id,
      device_id: 'device-test',
      connection_epoch: message.connection_epoch,
      timestamp: Date.now(),
      payload: { ok: true, pong: true }
    }));
  });

  await waitUntil(() => broker.listDevices().length === 1);
  const [device] = broker.listDevices();
  assert.equal(device.deviceId, 'device-test');
  assert.equal(device.online, true);
  assert.deepEqual(device.capabilities, ['ping', 'read_text_file']);
  assert.equal(device.connectionEpoch, 1);

  const result = await broker.callDevice({ deviceId: 'device-test', tool: 'ping', arguments: {} });
  assert.deepEqual(result, { ok: true, pong: true });
});

test('device disconnect fails closed with DEVICE_OFFLINE and reconnect restores dispatch', async t => {
  const server = http.createServer((_req, res) => res.end('ok'));
  const broker = createDeviceBroker({ enrollmentToken: 'dev-secret', requestTimeoutMs: 1000 });
  broker.attach(server);
  const port = await listen(server);
  t.after(async () => {
    await broker.shutdown();
    await closeServer(server);
  });

  const attachResponder = ws => ws.on('message', raw => {
    const message = JSON.parse(raw.toString());
    if (message.type !== 'tool_call') return;
    ws.send(JSON.stringify({
      protocol_version: 1,
      type: 'tool_result',
      request_id: message.request_id,
      device_id: 'host-device',
      connection_epoch: message.connection_epoch,
      timestamp: Date.now(),
      payload: { ok: true, source: 'device' }
    }));
  });

  const first = await connectDevice(port, 'dev-secret', { device_id: 'host-device' });
  attachResponder(first);
  await waitUntil(() => broker.listDevices()[0]?.online === true);
  assert.deepEqual(await broker.callDevice({ deviceId: 'host-device', tool: 'ping', arguments: {} }), { ok: true, source: 'device' });

  first.close();
  await waitUntil(() => broker.listDevices()[0]?.online === false);
  await assert.rejects(
    broker.callDevice({ deviceId: 'host-device', tool: 'ping', arguments: {} }),
    error => error.code === 'DEVICE_OFFLINE'
  );

  const second = await connectDevice(port, 'dev-secret', { device_id: 'host-device' });
  t.after(() => second.close());
  attachResponder(second);
  await waitUntil(() => broker.listDevices()[0]?.online === true);
  assert.deepEqual(await broker.callDevice({ deviceId: 'host-device', tool: 'ping', arguments: {} }), { ok: true, source: 'device' });
});

test('device broker rejects an invalid enrollment token', async t => {
  const server = http.createServer((_req, res) => res.end('ok'));
  const broker = createDeviceBroker({ enrollmentToken: 'dev-secret' });
  broker.attach(server);
  const port = await listen(server);
  t.after(async () => {
    await broker.shutdown();
    await closeServer(server);
  });

  const outcome = await new Promise(resolve => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/device`, {
      headers: { authorization: 'Bearer wrong' }
    });
    ws.once('open', () => resolve('open'));
    ws.once('error', () => resolve('error'));
    ws.once('unexpected-response', (_req, res) => resolve(`http-${res.statusCode}`));
  });
  assert.notEqual(outcome, 'open');
  assert.equal(broker.listDevices().length, 0);
});

test('reconnect increments connection epoch and stale socket close cannot mark new connection offline', async t => {
  const server = http.createServer((_req, res) => res.end('ok'));
  const broker = createDeviceBroker({ enrollmentToken: 'dev-secret' });
  broker.attach(server);
  const port = await listen(server);
  t.after(async () => {
    await broker.shutdown();
    await closeServer(server);
  });

  const first = await connectDevice(port, 'dev-secret', { device_id: 'same-device' });
  await waitUntil(() => broker.listDevices()[0]?.connectionEpoch === 1);
  const second = await connectDevice(port, 'dev-secret', { device_id: 'same-device' });
  t.after(() => second.close());
  await waitUntil(() => broker.listDevices()[0]?.connectionEpoch === 2);

  first.close();
  await new Promise(resolve => setTimeout(resolve, 50));
  const [device] = broker.listDevices();
  assert.equal(device.connectionEpoch, 2);
  assert.equal(device.online, true);
});


test('device broker preserves bounded remote tool error codes', async t => {
  const server = http.createServer((_req, res) => res.end('ok'));
  const broker = createDeviceBroker({ enrollmentToken: 'dev-secret', requestTimeoutMs: 1000 });
  broker.attach(server);
  const port = await listen(server);
  t.after(async () => {
    await broker.shutdown();
    await closeServer(server);
  });
  const ws = await connectDevice(port, 'dev-secret');
  t.after(() => ws.close());
  ws.on('message', raw => {
    const message = JSON.parse(raw.toString());
    if (message.type !== 'tool_call') return;
    ws.send(JSON.stringify({
      protocol_version: 1,
      type: 'tool_error',
      request_id: message.request_id,
      device_id: 'device-test',
      connection_epoch: message.connection_epoch,
      timestamp: Date.now(),
      payload: { message: 'too large', code: 'DEVICE_OUTPUT_TOO_LARGE' }
    }));
  });
  await waitUntil(() => broker.listDevices().length === 1);
  await assert.rejects(
    broker.callDevice({ deviceId: 'device-test', tool: 'read_text_file', arguments: { path: 'x' } }),
    error => error.code === 'DEVICE_OUTPUT_TOO_LARGE' && error.message === 'too large'
  );
});
