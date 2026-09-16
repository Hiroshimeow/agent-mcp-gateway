import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import tls from 'node:tls';
import { fileURLToPath } from 'node:url';
import { WebSocket, WebSocketServer } from 'ws';

import {
  DEVICE_INNER_TLS_SUBPROTOCOL,
  createJsonFrameParser,
  createServerInnerTls,
  createWebSocketDuplex,
  encodeJsonFrame,
  exportDeviceAuthKeyingMaterial,
  loadDeviceInnerTlsConfig
} from '../scripts/device-secure-transport.mjs';

const fixtureDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'device-inner-tls');
const ca = fs.readFileSync(path.join(fixtureDir, 'ca-cert.pem'));
const cert = fs.readFileSync(path.join(fixtureDir, 'server-cert.pem'));
const key = fs.readFileSync(path.join(fixtureDir, 'server-key.pem'));

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function closeServer(server) {
  return new Promise(resolve => server.close(resolve));
}

function waitEvent(emitter, event) {
  return new Promise((resolve, reject) => {
    emitter.once(event, (...args) => resolve(args));
    emitter.once('error', reject);
  });
}

test('inner TLS config requires cert and key together and loads both paths', () => {
  assert.equal(loadDeviceInnerTlsConfig({}), null);
  assert.throws(() => loadDeviceInnerTlsConfig({ MCP_DEVICE_INNER_TLS_CERT_PATH: 'cert-only.pem' }), /cert|key|together/i);
  const loaded = loadDeviceInnerTlsConfig({
    MCP_DEVICE_INNER_TLS_CERT_PATH: path.join(fixtureDir, 'server-cert.pem'),
    MCP_DEVICE_INNER_TLS_KEY_PATH: path.join(fixtureDir, 'server-key.pem')
  });
  assert.deepEqual(loaded.cert, cert);
  assert.deepEqual(loaded.key, key);
});

test('uint32 framing parses split and coalesced JSON and rejects invalid lengths', () => {
  const messages = [];
  const parser = createJsonFrameParser({ maxMessageBytes: 64, onMessage: message => messages.push(message) });
  const first = encodeJsonFrame({ type: 'one' }, 64);
  const second = encodeJsonFrame({ type: 'two' }, 64);
  parser.push(first.subarray(0, 2));
  parser.push(Buffer.concat([first.subarray(2), second]));
  assert.deepEqual(messages, [{ type: 'one' }, { type: 'two' }]);

  const zero = createJsonFrameParser({ maxMessageBytes: 64, onMessage: () => {} });
  assert.throws(() => zero.push(Buffer.alloc(4)), /length|frame/i);
  const oversized = Buffer.alloc(4);
  oversized.writeUInt32BE(65, 0);
  assert.throws(() => createJsonFrameParser({ maxMessageBytes: 64, onMessage: () => {} }).push(oversized), /maximum|size|frame/i);
});

test('inner TLS 1.3 carries framed JSON over binary WebSocket without exposing plaintext', async t => {
  const server = http.createServer();
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (request, socket, head) => {
    wss.handleUpgrade(request, socket, head, ws => wss.emit('connection', ws, request));
  });
  const port = await listen(server);
  t.after(async () => { wss.close(); await closeServer(server); });

  const observedOuter = [];
  const serverReady = new Promise((resolve, reject) => {
    wss.once('connection', ws => {
      assert.equal(ws.protocol, DEVICE_INNER_TLS_SUBPROTOCOL);
      ws.on('message', (data, isBinary) => {
        assert.equal(isBinary, true);
        observedOuter.push(Buffer.from(data));
      });
      const secure = createServerInnerTls(ws, { cert, key });
      const parser = createJsonFrameParser({
        onMessage(message) {
          secure.write(encodeJsonFrame({ type: 'echo', payload: message.payload }));
        }
      });
      secure.on('data', chunk => parser.push(chunk));
      secure.once('secure', () => resolve(exportDeviceAuthKeyingMaterial(secure, 'device-1', 'reconnect')));
      secure.once('error', reject);
    });
  });

  const ws = new WebSocket(`ws://127.0.0.1:${port}/device`, DEVICE_INNER_TLS_SUBPROTOCOL);
  await waitEvent(ws, 'open');
  const clientStream = createWebSocketDuplex(ws);
  const clientTls = tls.connect({ socket: clientStream, ca, servername: 'localhost', minVersion: 'TLSv1.3', rejectUnauthorized: true });
  await waitEvent(clientTls, 'secureConnect');
  const serverExporter = await serverReady;
  assert.equal(clientTls.getProtocol(), 'TLSv1.3');
  assert.deepEqual(exportDeviceAuthKeyingMaterial(clientTls, 'device-1', 'reconnect'), serverExporter);

  const received = [];
  const parser = createJsonFrameParser({ onMessage: message => received.push(message) });
  clientTls.on('data', chunk => parser.push(chunk));
  clientTls.write(encodeJsonFrame({ type: 'ping', payload: 'secret-marker-4817' }));
  for (let i = 0; i < 80 && received.length === 0; i += 1) await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(received, [{ type: 'echo', payload: 'secret-marker-4817' }]);
  assert.equal(Buffer.concat(observedOuter).includes(Buffer.from('secret-marker-4817')), false);
  clientTls.destroy();
  ws.terminate();
});

test('v2 WebSocket duplex rejects text input before any JSON message is admitted', async t => {
  const server = http.createServer();
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (request, socket, head) => wss.handleUpgrade(request, socket, head, ws => wss.emit('connection', ws, request)));
  const port = await listen(server);
  t.after(async () => { wss.close(); await closeServer(server); });
  let admitted = 0;
  const rejected = new Promise(resolve => {
    wss.once('connection', ws => {
      const secure = createServerInnerTls(ws, { cert, key });
      const parser = createJsonFrameParser({ onMessage: () => { admitted += 1; } });
      secure.on('data', chunk => parser.push(chunk));
      secure.once('error', error => resolve(error));
      ws.once('close', (code, reason) => resolve(new Error(`closed ${code}: ${reason.toString()}`)));
    });
  });
  const ws = new WebSocket(`ws://127.0.0.1:${port}/device`, DEVICE_INNER_TLS_SUBPROTOCOL);
  await waitEvent(ws, 'open');
  ws.send('plaintext-not-tls');
  await Promise.race([rejected, new Promise((_, reject) => setTimeout(() => reject(new Error('text input was not rejected')), 1000))]);
  assert.equal(admitted, 0);
  try { ws.terminate(); } catch {}
});

test('tampered inner TLS application record is rejected before JSON admission', async t => {
  const server = http.createServer();
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (request, socket, head) => wss.handleUpgrade(request, socket, head, ws => wss.emit('connection', ws, request)));
  const port = await listen(server);
  t.after(async () => { wss.close(); await closeServer(server); });
  let admitted = 0;
  let serverSecure;
  const serverRejected = new Promise(resolve => {
    wss.once('connection', ws => {
      serverSecure = createServerInnerTls(ws, { cert, key });
      const parser = createJsonFrameParser({ onMessage: () => { admitted += 1; } });
      serverSecure.on('data', chunk => parser.push(chunk));
      serverSecure.once('error', resolve);
      serverSecure.once('close', () => resolve(new Error('server TLS closed after tamper')));
      ws.once('close', () => resolve(new Error('server WebSocket closed after tamper')));
    });
  });
  const ws = new WebSocket(`ws://127.0.0.1:${port}/device`, DEVICE_INNER_TLS_SUBPROTOCOL);
  await waitEvent(ws, 'open');
  const clientTls = tls.connect({ socket: createWebSocketDuplex(ws), ca, servername: 'localhost', minVersion: 'TLSv1.3', rejectUnauthorized: true });
  const clientRejected = new Promise(resolve => {
    clientTls.once('error', resolve);
    clientTls.once('close', () => resolve(new Error('client TLS closed after tamper')));
  });
  await waitEvent(clientTls, 'secureConnect');
  const originalSend = ws.send.bind(ws);
  let mutated = false;
  ws.send = (data, options, callback) => {
    if (!mutated) {
      mutated = true;
      const bytes = Buffer.from(data);
      bytes[bytes.length - 1] ^= 1;
      return originalSend(bytes, options, callback);
    }
    return originalSend(data, options, callback);
  };
  clientTls.write(encodeJsonFrame({ type: 'tamper', payload: 'must-not-arrive' }));
  await Promise.race([serverRejected, clientRejected, new Promise((_, reject) => setTimeout(() => reject(new Error('tampered TLS record was not rejected')), 1000))]);
  assert.equal(admitted, 0);
  clientTls.destroy();
  try { ws.terminate(); } catch {}
  try { serverSecure?.destroy(); } catch {}
});

test('replayed inner TLS application record is admitted once then rejected', async t => {
  const server = http.createServer();
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (request, socket, head) => wss.handleUpgrade(request, socket, head, ws => wss.emit('connection', ws, request)));
  const port = await listen(server);
  t.after(async () => { wss.close(); await closeServer(server); });
  const admitted = [];
  const serverRejected = new Promise(resolve => {
    wss.once('connection', ws => {
      const secure = createServerInnerTls(ws, { cert, key });
      const parser = createJsonFrameParser({ onMessage: message => admitted.push(message) });
      secure.on('data', chunk => parser.push(chunk));
      secure.once('error', resolve);
      secure.once('close', () => resolve(new Error('server TLS closed after replay')));
      ws.once('close', () => resolve(new Error('server WebSocket closed after replay')));
    });
  });
  const ws = new WebSocket(`ws://127.0.0.1:${port}/device`, DEVICE_INNER_TLS_SUBPROTOCOL);
  await waitEvent(ws, 'open');
  const clientTls = tls.connect({ socket: createWebSocketDuplex(ws), ca, servername: 'localhost', minVersion: 'TLSv1.3', rejectUnauthorized: true });
  const clientRejected = new Promise(resolve => {
    clientTls.once('error', resolve);
    clientTls.once('close', () => resolve(new Error('client TLS closed after replay')));
  });
  await waitEvent(clientTls, 'secureConnect');
  const originalSend = ws.send.bind(ws);
  let replayed = false;
  ws.send = (data, options, callback) => {
    if (!replayed) {
      replayed = true;
      const captured = Buffer.from(data);
      const result = originalSend(captured, options, callback);
      setTimeout(() => {
        if (ws.readyState === WebSocket.OPEN) originalSend(Buffer.from(captured), options, () => {});
      }, 10);
      return result;
    }
    return originalSend(data, options, callback);
  };
  clientTls.write(encodeJsonFrame({ type: 'once', payload: 'record-replay-marker' }));
  await Promise.race([serverRejected, clientRejected, new Promise((_, reject) => setTimeout(() => reject(new Error('replayed TLS record was not rejected')), 1000))]);
  assert.deepEqual(admitted, [{ type: 'once', payload: 'record-replay-marker' }]);
  clientTls.destroy();
  try { ws.terminate(); } catch {}
});

test('old-session TLS application record is rejected after reconnect', async t => {
  const server = http.createServer();
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (request, socket, head) => wss.handleUpgrade(request, socket, head, ws => wss.emit('connection', ws, request)));
  const port = await listen(server);
  t.after(async () => { wss.close(); await closeServer(server); });

  const sessions = [];
  wss.on('connection', ws => {
    const admitted = [];
    const secure = createServerInnerTls(ws, { cert, key });
    const parser = createJsonFrameParser({ onMessage: message => admitted.push(message) });
    secure.on('data', chunk => parser.push(chunk));
    const rejected = new Promise(resolve => {
      secure.once('error', resolve);
      secure.once('close', () => resolve(new Error('server TLS closed')));
      ws.once('close', () => resolve(new Error('server WebSocket closed')));
    });
    sessions.push({ admitted, secure, rejected });
  });

  const firstWs = new WebSocket(`ws://127.0.0.1:${port}/device`, DEVICE_INNER_TLS_SUBPROTOCOL);
  await waitEvent(firstWs, 'open');
  const firstTls = tls.connect({ socket: createWebSocketDuplex(firstWs), ca, servername: 'localhost', minVersion: 'TLSv1.3', rejectUnauthorized: true });
  await waitEvent(firstTls, 'secureConnect');
  let capturedRecord = null;
  const firstSend = firstWs.send.bind(firstWs);
  firstWs.send = (data, options, callback) => {
    if (!capturedRecord) capturedRecord = Buffer.from(data);
    return firstSend(data, options, callback);
  };
  firstTls.write(encodeJsonFrame({ type: 'old-session', payload: 'replay-after-reconnect' }));
  for (let i = 0; i < 80 && sessions[0]?.admitted.length === 0; i += 1) await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(sessions[0].admitted, [{ type: 'old-session', payload: 'replay-after-reconnect' }]);
  assert(capturedRecord?.length > 0);
  firstTls.destroy();
  firstWs.terminate();

  const secondWs = new WebSocket(`ws://127.0.0.1:${port}/device`, DEVICE_INNER_TLS_SUBPROTOCOL);
  await waitEvent(secondWs, 'open');
  const secondTls = tls.connect({ socket: createWebSocketDuplex(secondWs), ca, servername: 'localhost', minVersion: 'TLSv1.3', rejectUnauthorized: true });
  const clientRejected = new Promise(resolve => {
    secondTls.once('error', resolve);
    secondTls.once('close', () => resolve(new Error('client TLS closed after old-session replay')));
  });
  await waitEvent(secondTls, 'secureConnect');
  assert.equal(sessions.length, 2);
  secondWs.send(Buffer.from(capturedRecord));
  await Promise.race([
    sessions[1].rejected,
    clientRejected,
    new Promise((_, reject) => setTimeout(() => reject(new Error('old-session TLS record was not rejected')), 1000))
  ]);
  assert.deepEqual(sessions[1].admitted, []);
  secondTls.destroy();
  try { secondWs.terminate(); } catch {}
});

test('inner TLS rejects a hostname not covered by the application certificate', async t => {
  const server = http.createServer();
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (request, socket, head) => wss.handleUpgrade(request, socket, head, ws => wss.emit('connection', ws, request)));
  const port = await listen(server);
  t.after(async () => { wss.close(); await closeServer(server); });
  wss.once('connection', ws => createServerInnerTls(ws, { cert, key }).on('error', () => {}));

  const ws = new WebSocket(`ws://127.0.0.1:${port}/device`, DEVICE_INNER_TLS_SUBPROTOCOL);
  await waitEvent(ws, 'open');
  const clientTls = tls.connect({ socket: createWebSocketDuplex(ws), ca, servername: 'wrong.example.test', minVersion: 'TLSv1.3', rejectUnauthorized: true });
  await assert.rejects(waitEvent(clientTls, 'secureConnect'), /hostname|altname|certificate/i);
  clientTls.destroy();
  ws.terminate();
});
