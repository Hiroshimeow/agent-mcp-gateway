import { randomUUID, timingSafeEqual } from 'node:crypto';
import { WebSocket, WebSocketServer } from 'ws';

export const DEVICE_PROTOCOL_VERSION = 1;
const DEFAULT_REQUEST_TIMEOUT_MS = 10000;
const DEFAULT_HELLO_TIMEOUT_MS = 5000;
const MAX_MESSAGE_BYTES = 64 * 1024;
const DEVICE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function bearerToken(request) {
  const value = String(request.headers.authorization || '');
  return value.startsWith('Bearer ') ? value.slice('Bearer '.length) : '';
}

function tokenMatches(actual, expected) {
  if (!actual || !expected) return false;
  const left = Buffer.from(actual, 'utf8');
  const right = Buffer.from(expected, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}

function rejectUpgrade(socket, statusCode, message) {
  if (!socket.writable) return socket.destroy();
  const body = `${message}\n`;
  socket.write(
    `HTTP/1.1 ${statusCode} ${message}\r\n` +
    'Connection: close\r\n' +
    'Content-Type: text/plain; charset=utf-8\r\n' +
    `Content-Length: ${Buffer.byteLength(body)}\r\n` +
    '\r\n' +
    body
  );
  socket.destroy();
}

function parseMessage(raw) {
  const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw);
  if (Buffer.byteLength(text, 'utf8') > MAX_MESSAGE_BYTES) throw new Error('Device message exceeds maximum size.');
  const message = JSON.parse(text);
  if (!message || typeof message !== 'object') throw new Error('Device message must be an object.');
  if (message.protocol_version !== DEVICE_PROTOCOL_VERSION) throw new Error('Unsupported device protocol version.');
  if (typeof message.type !== 'string' || !message.type) throw new Error('Device message type is required.');
  return message;
}

function normalizeCapabilities(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(item => String(item).trim()).filter(Boolean))].sort();
}

function publicDevice(device) {
  return {
    deviceId: device.deviceId,
    online: device.online,
    connectionEpoch: device.connectionEpoch,
    agentVersion: device.agentVersion,
    capabilities: [...device.capabilities],
    connectedAt: device.connectedAt,
    lastSeenAt: device.lastSeenAt
  };
}

export function createDeviceBroker(options = {}) {
  const enrollmentToken = String(options.enrollmentToken || '').trim();
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const helloTimeoutMs = options.helloTimeoutMs ?? DEFAULT_HELLO_TIMEOUT_MS;
  const devices = new Map();
  const pending = new Map();
  const sockets = new Set();
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });
  let attachedServer = null;
  let upgradeHandler = null;

  function rejectPendingForConnection(deviceId, connectionEpoch, reason) {
    for (const [requestId, entry] of pending) {
      if (entry.deviceId !== deviceId || entry.connectionEpoch !== connectionEpoch) continue;
      clearTimeout(entry.timer);
      pending.delete(requestId);
      entry.reject(new Error(reason));
    }
  }

  function registerHello(ws, message) {
    const deviceId = String(message.device_id || '').trim();
    if (!DEVICE_ID_PATTERN.test(deviceId)) throw new Error('Invalid device_id.');
    const previous = devices.get(deviceId);
    const connectionEpoch = (previous?.connectionEpoch || 0) + 1;
    const current = {
      deviceId,
      socket: ws,
      online: true,
      connectionEpoch,
      agentVersion: String(message.payload?.agent_version || 'unknown'),
      capabilities: normalizeCapabilities(message.payload?.capabilities),
      connectedAt: Date.now(),
      lastSeenAt: Date.now()
    };
    devices.set(deviceId, current);
    ws.deviceId = deviceId;
    ws.connectionEpoch = connectionEpoch;
    if (previous?.socket && previous.socket !== ws && previous.socket.readyState === WebSocket.OPEN) {
      previous.socket.close(4001, 'replaced by newer connection');
    }
    ws.send(JSON.stringify({
      protocol_version: DEVICE_PROTOCOL_VERSION,
      type: 'hello_ack',
      device_id: deviceId,
      connection_epoch: connectionEpoch,
      timestamp: Date.now(),
      payload: { accepted: true }
    }));
  }

  function handleRegisteredMessage(ws, message) {
    const device = devices.get(ws.deviceId);
    if (!device || device.socket !== ws || device.connectionEpoch !== ws.connectionEpoch) return;
    if (message.device_id && message.device_id !== ws.deviceId) throw new Error('device_id does not match authenticated connection.');
    if (message.connection_epoch !== undefined && message.connection_epoch !== ws.connectionEpoch) return;
    device.lastSeenAt = Date.now();

    if (message.type === 'heartbeat') return;
    if (message.type === 'capability_sync') {
      device.capabilities = normalizeCapabilities(message.payload?.capabilities);
      device.agentVersion = String(message.payload?.agent_version || device.agentVersion);
      return;
    }
    if (message.type !== 'tool_result' && message.type !== 'tool_error') return;

    const requestId = String(message.request_id || '');
    const entry = pending.get(requestId);
    if (!entry || entry.deviceId !== ws.deviceId || entry.connectionEpoch !== ws.connectionEpoch) return;
    clearTimeout(entry.timer);
    pending.delete(requestId);
    if (message.type === 'tool_error') {
      entry.reject(new Error(String(message.payload?.message || 'Remote device tool error.')));
    } else {
      entry.resolve(message.payload);
    }
  }

  wss.on('connection', ws => {
    sockets.add(ws);
    let helloReceived = false;
    const helloTimer = setTimeout(() => {
      if (!helloReceived && ws.readyState === WebSocket.OPEN) ws.close(4000, 'hello required');
    }, helloTimeoutMs);
    helloTimer.unref?.();

    ws.on('message', raw => {
      try {
        const message = parseMessage(raw);
        if (!helloReceived) {
          if (message.type !== 'hello') throw new Error('First device message must be hello.');
          registerHello(ws, message);
          helloReceived = true;
          clearTimeout(helloTimer);
          return;
        }
        handleRegisteredMessage(ws, message);
      } catch (error) {
        if (ws.readyState === WebSocket.OPEN) ws.close(4002, String(error.message).slice(0, 120));
      }
    });

    ws.on('close', () => {
      sockets.delete(ws);
      clearTimeout(helloTimer);
      if (!ws.deviceId) return;
      const current = devices.get(ws.deviceId);
      if (!current || current.socket !== ws || current.connectionEpoch !== ws.connectionEpoch) return;
      current.online = false;
      current.socket = null;
      current.lastSeenAt = Date.now();
      rejectPendingForConnection(
        ws.deviceId,
        ws.connectionEpoch,
        'Device disconnected before the request result was known; the request was not replayed.'
      );
    });
  });

  function attach(server, path = '/device') {
    if (attachedServer) throw new Error('Device broker is already attached.');
    attachedServer = server;
    upgradeHandler = (request, socket, head) => {
      let pathname;
      try {
        pathname = new URL(request.url || '/', 'http://localhost').pathname;
      } catch {
        return rejectUpgrade(socket, 400, 'Bad Request');
      }
      if (pathname !== path) return;
      if (!enrollmentToken) return rejectUpgrade(socket, 503, 'Device Enrollment Disabled');
      if (!tokenMatches(bearerToken(request), enrollmentToken)) return rejectUpgrade(socket, 401, 'Unauthorized');
      wss.handleUpgrade(request, socket, head, ws => wss.emit('connection', ws, request));
    };
    server.on('upgrade', upgradeHandler);
  }

  function listDevices() {
    return [...devices.values()].map(publicDevice).sort((a, b) => a.deviceId.localeCompare(b.deviceId));
  }

  async function callDevice({ deviceId, tool, arguments: args = {}, timeoutMs = requestTimeoutMs }) {
    const device = devices.get(String(deviceId || ''));
    if (!device?.online || !device.socket || device.socket.readyState !== WebSocket.OPEN) {
      throw new Error(`Device ${deviceId} is offline or unknown.`);
    }
    if (!device.capabilities.includes(tool)) throw new Error(`Device ${deviceId} does not advertise capability ${tool}.`);
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) {
      throw new Error('Device request timeout must be an integer between 1 and 30000 ms.');
    }

    const requestId = randomUUID();
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(requestId);
        reject(new Error(`Device request ${requestId} timed out; it was not replayed.`));
      }, timeoutMs);
      timer.unref?.();
      pending.set(requestId, {
        resolve,
        reject,
        timer,
        deviceId: device.deviceId,
        connectionEpoch: device.connectionEpoch
      });
      device.socket.send(JSON.stringify({
        protocol_version: DEVICE_PROTOCOL_VERSION,
        type: 'tool_call',
        request_id: requestId,
        device_id: device.deviceId,
        connection_epoch: device.connectionEpoch,
        timestamp: Date.now(),
        payload: { tool, arguments: args }
      }), error => {
        if (!error) return;
        const entry = pending.get(requestId);
        if (!entry) return;
        clearTimeout(entry.timer);
        pending.delete(requestId);
        reject(error);
      });
    });
  }

  async function shutdown() {
    if (attachedServer && upgradeHandler) attachedServer.off('upgrade', upgradeHandler);
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error('Device broker is shutting down.'));
    }
    pending.clear();
    for (const ws of sockets) {
      try { ws.terminate(); } catch {}
    }
    sockets.clear();
    await new Promise(resolve => wss.close(() => resolve()));
    attachedServer = null;
    upgradeHandler = null;
  }

  return { attach, listDevices, callDevice, shutdown };
}
