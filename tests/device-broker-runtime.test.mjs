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

async function openDevice(port, { deviceId = 'runtime-device', runtime } = {}) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/device`, { headers: { authorization: 'Bearer runtime-secret' } });
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  const ackPromise = nextMessage(ws);
  ws.send(JSON.stringify({
    protocol_version: 1,
    type: 'hello',
    device_id: deviceId,
    timestamp: Date.now(),
    payload: {
      agent_version: 'runtime-test',
      capabilities: ['ping'],
      ...(runtime || {})
    }
  }));
  const ack = await ackPromise;
  assert.equal(ack.type, 'hello_ack');
  return { ws, ack };
}

async function createHarness(t) {
  const server = http.createServer((_req, res) => res.end('ok'));
  const broker = createDeviceBroker({
    enrollmentToken: 'runtime-secret',
    requestTimeoutMs: 1000,
    requireAccountOwnership: false
  });
  broker.attach(server);
  const port = await listen(server);
  t.after(async () => {
    await broker.shutdown();
    await closeServer(server);
  });
  return { broker, port };
}

test('runtime readiness is independent from transport and legacy absence stays callable', async t => {
  const { broker, port } = await createHarness(t);

  const notReady = await openDevice(port, {
    deviceId: 'runtime-not-ready',
    runtime: {
      runtime_ready: false,
      runtime_reason: 'LOCAL_EXECUTION_ENGINE_UNAVAILABLE',
      execution_runtime_generation: null
    }
  });
  t.after(() => notReady.ws.close());
  const notReadyState = broker.listDevices().find(item => item.deviceId === 'runtime-not-ready');
  assert.equal(notReadyState.online, true);
  assert.equal(notReadyState.runtimeReady, false);
  await assert.rejects(
    broker.callDevice({ deviceId: 'runtime-not-ready', tool: 'ping' }),
    error => error?.code === 'DEVICE_NOT_READY'
  );

  const legacy = await openDevice(port, { deviceId: 'runtime-legacy' });
  t.after(() => legacy.ws.close());
  const pending = broker.callDevice({
    deviceId: 'runtime-legacy',
    tool: 'ping',
    includeDispatchContext: true
  });
  const toolCall = await nextMessage(legacy.ws);
  assert.equal(toolCall.type, 'tool_call');
  legacy.ws.send(JSON.stringify({
    protocol_version: 1,
    type: 'tool_result',
    request_id: toolCall.request_id,
    device_id: 'runtime-legacy',
    connection_epoch: toolCall.connection_epoch,
    timestamp: Date.now(),
    payload: { ok: true }
  }));
  const result = await pending;
  assert.deepEqual(result.result, { ok: true });
  assert.equal(result.dispatchContext.deviceId, 'runtime-legacy');
  assert.equal(result.dispatchContext.connectionEpoch, 1);
  assert.equal(result.dispatchContext.executionRuntimeGeneration, 'legacy:1');
});

test('runtime-not-ready transition rejects a pending call without replay', async t => {
  const { broker, port } = await createHarness(t);
  const { ws } = await openDevice(port, {
    deviceId: 'runtime-transition',
    runtime: {
      runtime_ready: true,
      runtime_reason: null,
      execution_runtime_generation: 'runtime-a'
    }
  });
  t.after(() => ws.close());

  const pending = broker.callDevice({ requestId: 'runtime-pending-1', deviceId: 'runtime-transition', tool: 'ping' });
  const toolCall = await nextMessage(ws);
  assert.equal(toolCall.type, 'tool_call');

  const statusPromise = nextMessage(ws);
  ws.send(JSON.stringify({
    protocol_version: 1,
    type: 'heartbeat',
    device_id: 'runtime-transition',
    connection_epoch: toolCall.connection_epoch,
    timestamp: Date.now(),
    payload: {
      runtime_ready: false,
      runtime_reason: 'LOCAL_EXECUTION_ENGINE_UNAVAILABLE',
      execution_runtime_generation: null
    }
  }));

  await assert.rejects(pending, error => error?.code === 'DEVICE_NOT_READY');
  const status = await statusPromise;
  assert.equal(status.type, 'status_snapshot');
  assert.notEqual(status.type, 'tool_call');
  assert.equal(broker.listDevices().find(item => item.deviceId === 'runtime-transition').online, true);
});

test('process affinity rejects connection epoch and runtime generation drift', async t => {
  const { broker, port } = await createHarness(t);
  const first = await openDevice(port, {
    deviceId: 'runtime-affinity',
    runtime: {
      runtime_ready: true,
      runtime_reason: null,
      execution_runtime_generation: 'runtime-a'
    }
  });

  await assert.rejects(
    broker.callDevice({
      deviceId: 'runtime-affinity',
      tool: 'ping',
      expectedConnectionEpoch: 1,
      expectedExecutionRuntimeGeneration: 'runtime-b'
    }),
    error => error?.code === 'PROCESS_SESSION_STALE'
  );

  const statusPromise = nextMessage(first.ws);
  first.ws.send(JSON.stringify({
    protocol_version: 1,
    type: 'heartbeat',
    device_id: 'runtime-affinity',
    connection_epoch: 1,
    timestamp: Date.now(),
    payload: {
      runtime_ready: true,
      runtime_reason: null,
      execution_runtime_generation: 'runtime-b'
    }
  }));
  assert.equal((await statusPromise).type, 'status_snapshot');
  await assert.rejects(
    broker.callDevice({
      deviceId: 'runtime-affinity',
      tool: 'ping',
      expectedConnectionEpoch: 1,
      expectedExecutionRuntimeGeneration: 'runtime-a'
    }),
    error => error?.code === 'PROCESS_SESSION_STALE'
  );

  first.ws.close();
  await new Promise(resolve => setTimeout(resolve, 30));
  const second = await openDevice(port, {
    deviceId: 'runtime-affinity',
    runtime: {
      runtime_ready: true,
      runtime_reason: null,
      execution_runtime_generation: 'runtime-c'
    }
  });
  t.after(() => second.ws.close());
  assert.equal(second.ack.connection_epoch, 2);
  await assert.rejects(
    broker.callDevice({
      deviceId: 'runtime-affinity',
      tool: 'ping',
      expectedConnectionEpoch: 1,
      expectedExecutionRuntimeGeneration: 'runtime-a'
    }),
    error => error?.code === 'PROCESS_SESSION_STALE'
  );
});
