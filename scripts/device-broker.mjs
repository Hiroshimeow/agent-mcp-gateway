import { randomBytes, randomUUID, timingSafeEqual, verify } from 'node:crypto';
import { WebSocket, WebSocketServer } from 'ws';

export const DEVICE_PROTOCOL_VERSION = 1;
const DEFAULT_REQUEST_TIMEOUT_MS = 10000;
const DEFAULT_HELLO_TIMEOUT_MS = 5000;
const MAX_MESSAGE_BYTES = 64 * 1024;
const DEVICE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function buildDeviceAuthChallenge({ deviceId, nonce }) {
  return Buffer.from(`mcp-device-auth-v1\n${deviceId}\n${nonce}`, 'utf8');
}

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
  socket.write(`HTTP/1.1 ${statusCode} ${message}\r\nConnection: close\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
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

function normalizeDeviceId(value) {
  const deviceId = String(value || '').trim();
  if (!DEVICE_ID_PATTERN.test(deviceId)) throw new Error('Invalid device_id.');
  return deviceId;
}

function normalizeCapabilities(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(item => String(item).trim()).filter(Boolean))].sort();
}

function publicDevice(device) {
  return {
    deviceId: device.deviceId,
    online: Boolean(device.online),
    revoked: Boolean(device.revoked),
    connectionEpoch: device.connectionEpoch || 0,
    agentVersion: device.agentVersion || 'unknown',
    capabilities: [...(device.capabilities || [])],
    connectedAt: device.connectedAt || null,
    lastSeenAt: device.lastSeenAt || null
  };
}

function authFailure(ws, message = 'authentication failed') {
  if (ws.readyState === WebSocket.OPEN) ws.close(4003, message.slice(0, 120));
}

export function createDeviceBroker(options = {}) {
  const enrollmentToken = String(options.enrollmentToken || '').trim();
  const deviceStore = options.deviceStore || null;
  const durableAuth = Boolean(deviceStore);
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const helloTimeoutMs = options.helloTimeoutMs ?? DEFAULT_HELLO_TIMEOUT_MS;
  const devices = new Map();
  const pending = new Map();
  const sockets = new Set();
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });
  let attachedServer = null;
  let upgradeHandler = null;

  if (durableAuth) {
    for (const stored of deviceStore.list()) {
      devices.set(stored.deviceId, {
        deviceId: stored.deviceId,
        socket: null,
        online: false,
        revoked: Boolean(stored.revokedAt),
        connectionEpoch: 0,
        agentVersion: 'unknown',
        capabilities: [],
        connectedAt: null,
        lastSeenAt: null
      });
    }
  }

  function rejectPendingForConnection(deviceId, connectionEpoch, reason) {
    for (const [requestId, entry] of pending) {
      if (entry.deviceId !== deviceId || entry.connectionEpoch !== connectionEpoch) continue;
      clearTimeout(entry.timer);
      pending.delete(requestId);
      entry.reject(new Error(reason));
    }
  }

  function registerConnection(ws, { deviceId, agentVersion, capabilities }) {
    const previous = devices.get(deviceId);
    const connectionEpoch = (previous?.connectionEpoch || 0) + 1;
    const current = {
      deviceId,
      socket: ws,
      online: true,
      revoked: false,
      connectionEpoch,
      agentVersion: String(agentVersion || 'unknown'),
      capabilities: normalizeCapabilities(capabilities),
      connectedAt: Date.now(),
      lastSeenAt: Date.now()
    };
    devices.set(deviceId, current);
    ws.deviceId = deviceId;
    ws.connectionEpoch = connectionEpoch;
    ws.authenticated = true;
    if (previous?.socket && previous.socket !== ws && previous.socket.readyState === WebSocket.OPEN) {
      previous.socket.close(4001, 'replaced by newer connection');
    }
    return current;
  }

  function sendAuthChallenge(ws, authState) {
    ws.authState = { ...authState, nonce: randomBytes(32).toString('base64url') };
    ws.send(JSON.stringify({
      protocol_version: DEVICE_PROTOCOL_VERSION,
      type: 'auth_challenge',
      device_id: authState.deviceId,
      timestamp: Date.now(),
      payload: { nonce: ws.authState.nonce }
    }));
  }

  function handleAuthHello(ws, message) {
    const deviceId = normalizeDeviceId(message.device_id);
    if (message.type === 'enroll_hello') {
      if (!ws.enrollmentAuthorized) return authFailure(ws, 'enrollment authorization required');
      const existing = deviceStore.get(deviceId);
      if (existing) return authFailure(ws, existing.revokedAt ? 'device revoked' : 'device already enrolled');
      const publicKeyPem = String(message.payload?.public_key_pem || '');
      if (!publicKeyPem) return authFailure(ws, 'public key required');
      sendAuthChallenge(ws, {
        mode: 'enroll',
        deviceId,
        publicKeyPem,
        agentVersion: message.payload?.agent_version,
        capabilities: message.payload?.capabilities
      });
      return;
    }
    if (message.type !== 'auth_hello') return authFailure(ws, 'first message must be enroll_hello or auth_hello');
    const stored = deviceStore.get(deviceId);
    if (!stored || stored.revokedAt) return authFailure(ws, 'unknown or revoked device');
    sendAuthChallenge(ws, {
      mode: 'reconnect',
      deviceId,
      publicKeyPem: stored.publicKeyPem,
      agentVersion: message.payload?.agent_version,
      capabilities: message.payload?.capabilities
    });
  }

  function handleAuthResponse(ws, message) {
    const state = ws.authState;
    if (!state || message.type !== 'auth_response' || normalizeDeviceId(message.device_id) !== state.deviceId) {
      return authFailure(ws, 'invalid authentication response');
    }
    let signature;
    try { signature = Buffer.from(String(message.payload?.signature || ''), 'base64'); } catch { return authFailure(ws); }
    const valid = signature.length > 0 && verify(
      null,
      buildDeviceAuthChallenge({ deviceId: state.deviceId, nonce: state.nonce }),
      state.publicKeyPem,
      signature
    );
    if (!valid) return authFailure(ws, 'invalid signature');

    if (state.mode === 'enroll') {
      try { deviceStore.enroll({ deviceId: state.deviceId, publicKeyPem: state.publicKeyPem }); }
      catch { return authFailure(ws, 'enrollment failed'); }
    } else {
      const stored = deviceStore.get(state.deviceId);
      if (!stored || stored.revokedAt) return authFailure(ws, 'unknown or revoked device');
    }

    const current = registerConnection(ws, state);
    ws.authState = null;
    ws.send(JSON.stringify({
      protocol_version: DEVICE_PROTOCOL_VERSION,
      type: 'auth_ok',
      device_id: current.deviceId,
      connection_epoch: current.connectionEpoch,
      timestamp: Date.now(),
      payload: { accepted: true }
    }));
  }

  function registerLegacyHello(ws, message) {
    const deviceId = normalizeDeviceId(message.device_id);
    const current = registerConnection(ws, {
      deviceId,
      agentVersion: message.payload?.agent_version,
      capabilities: message.payload?.capabilities
    });
    ws.send(JSON.stringify({
      protocol_version: DEVICE_PROTOCOL_VERSION,
      type: 'hello_ack',
      device_id: deviceId,
      connection_epoch: current.connectionEpoch,
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
    if (message.type === 'tool_error') entry.reject(new Error(String(message.payload?.message || 'Remote device tool error.')));
    else entry.resolve(message.payload);
  }

  wss.on('connection', ws => {
    sockets.add(ws);
    let firstMessageReceived = false;
    const helloTimer = setTimeout(() => {
      if (!ws.authenticated && ws.readyState === WebSocket.OPEN) ws.close(4000, 'authentication required');
    }, helloTimeoutMs);
    helloTimer.unref?.();

    ws.on('message', raw => {
      try {
        const message = parseMessage(raw);
        if (!ws.authenticated) {
          firstMessageReceived = true;
          if (durableAuth) {
            if (ws.authState) handleAuthResponse(ws, message);
            else handleAuthHello(ws, message);
            if (ws.authenticated) clearTimeout(helloTimer);
            return;
          }
          if (message.type !== 'hello') throw new Error('First device message must be hello.');
          registerLegacyHello(ws, message);
          clearTimeout(helloTimer);
          return;
        }
        handleRegisteredMessage(ws, message);
      } catch (error) {
        if (ws.readyState === WebSocket.OPEN) ws.close(durableAuth ? 4003 : 4002, String(error.message).slice(0, 120));
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
      rejectPendingForConnection(ws.deviceId, ws.connectionEpoch, 'Device disconnected before the request result was known; the request was not replayed.');
    });
  });

  function attach(server, endpointPath = '/device') {
    if (attachedServer) throw new Error('Device broker is already attached.');
    attachedServer = server;
    upgradeHandler = (request, socket, head) => {
      let pathname;
      try { pathname = new URL(request.url || '/', 'http://localhost').pathname; }
      catch { return rejectUpgrade(socket, 400, 'Bad Request'); }
      if (pathname !== endpointPath) return;
      if (!durableAuth) {
        if (!enrollmentToken) return rejectUpgrade(socket, 503, 'Device Enrollment Disabled');
        if (!tokenMatches(bearerToken(request), enrollmentToken)) return rejectUpgrade(socket, 401, 'Unauthorized');
      }
      wss.handleUpgrade(request, socket, head, ws => {
        ws.enrollmentAuthorized = tokenMatches(bearerToken(request), enrollmentToken);
        wss.emit('connection', ws, request);
      });
    };
    server.on('upgrade', upgradeHandler);
  }

  function listDevices() {
    return [...devices.values()].map(publicDevice).sort((a, b) => a.deviceId.localeCompare(b.deviceId));
  }

  function revokeDevice(deviceId) {
    if (!durableAuth) throw new Error('Durable device store is required for revocation.');
    const normalized = normalizeDeviceId(deviceId);
    const stored = deviceStore.revoke(normalized);
    const current = devices.get(normalized) || { deviceId: normalized, connectionEpoch: 0, capabilities: [] };
    current.revoked = true;
    current.online = false;
    if (current.socket?.readyState === WebSocket.OPEN) current.socket.close(4004, 'device revoked');
    current.socket = null;
    devices.set(normalized, current);
    return publicDevice(current);
  }

  async function callDevice({ deviceId, tool, arguments: args = {}, timeoutMs = requestTimeoutMs }) {
    const device = devices.get(String(deviceId || ''));
    if (!device?.online || device.revoked || !device.socket || device.socket.readyState !== WebSocket.OPEN) throw new Error(`Device ${deviceId} is offline or unknown.`);
    if (!device.capabilities.includes(tool)) throw new Error(`Device ${deviceId} does not advertise capability ${tool}.`);
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) throw new Error('Device request timeout must be an integer between 1 and 30000 ms.');
    const requestId = randomUUID();
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(requestId);
        reject(new Error(`Device request ${requestId} timed out; it was not replayed.`));
      }, timeoutMs);
      timer.unref?.();
      pending.set(requestId, { resolve, reject, timer, deviceId: device.deviceId, connectionEpoch: device.connectionEpoch });
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
    for (const ws of sockets) { try { ws.terminate(); } catch {} }
    sockets.clear();
    await new Promise(resolve => wss.close(() => resolve()));
    attachedServer = null;
    upgradeHandler = null;
  }

  return { attach, listDevices, revokeDevice, callDevice, shutdown };
}
