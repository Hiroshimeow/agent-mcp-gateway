import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import tls from 'node:tls';
import { Duplex } from 'node:stream';
import { WebSocket } from 'ws';

export const DEVICE_INNER_TLS_SUBPROTOCOL = 'hcu-device-v2-inner-tls';
export const DEVICE_MAX_MESSAGE_BYTES = 64 * 1024;

export function loadDeviceInnerTlsConfig(env = process.env, readFile = readFileSync) {
  const certPath = String(env.MCP_DEVICE_INNER_TLS_CERT_PATH || '').trim();
  const keyPath = String(env.MCP_DEVICE_INNER_TLS_KEY_PATH || '').trim();
  if (!certPath && !keyPath) return null;
  if (!certPath || !keyPath) throw new Error('MCP_DEVICE_INNER_TLS_CERT_PATH and MCP_DEVICE_INNER_TLS_KEY_PATH must be configured together.');
  return { cert: readFile(certPath), key: readFile(keyPath) };
}

export class WebSocketDuplex extends Duplex {
  constructor(ws) {
    super();
    this.ws = ws;
    ws.on('message', (data, isBinary) => {
      if (!isBinary) {
        this.destroy(new Error('Inner TLS transport requires binary WebSocket messages.'));
        return;
      }
      const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data);
      this.push(chunk);
    });
    ws.once('close', () => this.push(null));
    ws.once('error', error => this.destroy(error));
  }

  _read() {}

  _write(chunk, _encoding, callback) {
    if (this.ws.readyState !== WebSocket.OPEN) {
      callback(new Error('WebSocket is not open.'));
      return;
    }
    this.ws.send(Buffer.from(chunk), { binary: true }, callback);
  }

  _destroy(error, callback) {
    try {
      if (this.ws.readyState === WebSocket.OPEN) this.ws.close(1000, 'inner transport closed');
      else if (this.ws.readyState === WebSocket.CONNECTING) this.ws.terminate();
    } catch {}
    callback(error);
  }
}

export function createWebSocketDuplex(ws) {
  return new WebSocketDuplex(ws);
}

export function createServerInnerTls(ws, { cert, key, secureContext } = {}) {
  const context = secureContext || tls.createSecureContext({ cert, key, minVersion: 'TLSv1.3' });
  return new tls.TLSSocket(createWebSocketDuplex(ws), {
    isServer: true,
    secureContext: context
  });
}

export function exportDeviceAuthKeyingMaterial(socket, deviceId, mode) {
  const context = createHash('sha256')
    .update(`hcu-mcp-device-auth-v2\n${String(deviceId)}\n${String(mode)}`, 'utf8')
    .digest();
  return socket.exportKeyingMaterial(32, 'EXPERIMENTAL-HCU-MCP-DEVICE-AUTH-V2', context);
}

export function encodeJsonFrame(message, maxMessageBytes = DEVICE_MAX_MESSAGE_BYTES) {
  const payload = Buffer.from(JSON.stringify(message), 'utf8');
  if (payload.length < 1 || payload.length > maxMessageBytes) {
    throw new Error('Device JSON frame exceeds maximum size.');
  }
  const frame = Buffer.allocUnsafe(4 + payload.length);
  frame.writeUInt32BE(payload.length, 0);
  payload.copy(frame, 4);
  return frame;
}

export function createJsonFrameParser({ maxMessageBytes = DEVICE_MAX_MESSAGE_BYTES, onMessage }) {
  if (typeof onMessage !== 'function') throw new Error('onMessage callback is required.');
  const header = Buffer.allocUnsafe(4);
  let headerBytes = 0;
  let expectedLength = null;
  let bodyBytes = 0;
  let bodyParts = [];

  return {
    push(value) {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      let offset = 0;
      while (offset < chunk.length) {
        if (expectedLength === null) {
          const take = Math.min(4 - headerBytes, chunk.length - offset);
          chunk.copy(header, headerBytes, offset, offset + take);
          headerBytes += take;
          offset += take;
          if (headerBytes < 4) continue;
          const length = header.readUInt32BE(0);
          headerBytes = 0;
          if (length < 1 || length > maxMessageBytes) throw new Error('Invalid device JSON frame length.');
          expectedLength = length;
          bodyBytes = 0;
          bodyParts = [];
          continue;
        }

        const remaining = expectedLength - bodyBytes;
        const take = Math.min(remaining, chunk.length - offset);
        bodyParts.push(chunk.subarray(offset, offset + take));
        bodyBytes += take;
        offset += take;
        if (bodyBytes !== expectedLength) continue;

        const text = Buffer.concat(bodyParts, expectedLength).toString('utf8');
        expectedLength = null;
        bodyBytes = 0;
        bodyParts = [];
        const message = JSON.parse(text);
        if (!message || typeof message !== 'object') throw new Error('Device JSON frame must contain an object.');
        onMessage(message);
      }
    }
  };
}
