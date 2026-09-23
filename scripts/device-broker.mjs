import { createHash, createPublicKey, randomBytes, randomUUID, timingSafeEqual, verify } from 'node:crypto';
import { WebSocket, WebSocketServer } from 'ws';
import {
  DEVICE_INNER_TLS_SUBPROTOCOL,
  createJsonFrameParser,
  createServerInnerTls,
  encodeJsonFrame
} from './device-secure-transport.mjs';
import { compareStableVersions, minimumSelfUpdateVersion, normalizeStableVersion, supportsDeviceSelfUpdate } from './device-release.mjs';

export const DEVICE_PROTOCOL_VERSION = 1;
export const DEVICE_PROTOCOL_VERSION_V2 = 2;
const DEVICE_AUTH_EXPORTER_LABEL = 'EXPERIMENTAL-HCU-MCP-DEVICE-AUTH-V2';
const DEFAULT_REQUEST_TIMEOUT_MS = 10000;
const DEFAULT_HELLO_TIMEOUT_MS = 5000;
const DEFAULT_UPDATE_TIMEOUT_MS = 15 * 60 * 1000;
const MAX_MESSAGE_BYTES = 64 * 1024;
const DEVICE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function buildDeviceAuthChallenge({ deviceId, nonce }) {
  return Buffer.from(`mcp-device-auth-v1\n${deviceId}\n${nonce}`, 'utf8');
}

const DEVICE_AUTH_V2_MODE = Object.freeze({ reconnect: 0, enroll: 1, pair: 2 });

function fixed32(value, name) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(String(value || ''), 'base64url');
  if (bytes.length !== 32) throw new Error(`${name} must be exactly 32 bytes.`);
  return bytes;
}

export function buildDeviceAuthExporterContext({ deviceId, mode }) {
  if (!DEVICE_ID_PATTERN.test(String(deviceId || ''))) throw new Error('Invalid device_id.');
  if (!(mode in DEVICE_AUTH_V2_MODE)) throw new Error('Invalid device authentication mode.');
  return createHash('sha256').update(`hcu-mcp-device-auth-v2\n${deviceId}\n${mode}`, 'utf8').digest();
}

export function buildDeviceAuthChallengeV2({ deviceId, mode, nonce, exporter, publicKeyPem, grant = null }) {
  const deviceBytes = Buffer.from(String(deviceId || ''), 'utf8');
  if (!DEVICE_ID_PATTERN.test(String(deviceId || '')) || deviceBytes.length > 0xffff) throw new Error('Invalid device_id.');
  if (!(mode in DEVICE_AUTH_V2_MODE)) throw new Error('Invalid device authentication mode.');
  const publicKey = createPublicKey(publicKeyPem);
  if (publicKey.asymmetricKeyType !== 'ed25519') throw new Error('Device public key must be Ed25519.');
  const publicKeyDer = publicKey.export({ type: 'spki', format: 'der' });
  const grantDigest = mode === 'reconnect'
    ? Buffer.alloc(32)
    : createHash('sha256').update(String(grant || ''), 'utf8').digest();
  const deviceLength = Buffer.allocUnsafe(2);
  deviceLength.writeUInt16BE(deviceBytes.length, 0);
  return Buffer.concat([
    Buffer.from('hcu-mcp-device-auth-v2\0', 'ascii'),
    Buffer.from([2, DEVICE_AUTH_V2_MODE[mode]]),
    deviceLength,
    deviceBytes,
    fixed32(nonce, 'gateway nonce'),
    fixed32(exporter, 'TLS exporter'),
    createHash('sha256').update(publicKeyDer).digest(),
    grantDigest
  ]);
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

function validateMessage(message, expectedVersion) {
  if (!message || typeof message !== 'object') throw new Error('Device message must be an object.');
  if (message.protocol_version !== expectedVersion) throw new Error('Unsupported device protocol version.');
  if (typeof message.type !== 'string' || !message.type) throw new Error('Device message type is required.');
  return message;
}

function parseMessage(raw, expectedVersion = DEVICE_PROTOCOL_VERSION) {
  const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw);
  if (Buffer.byteLength(text, 'utf8') > MAX_MESSAGE_BYTES) throw new Error('Device message exceeds maximum size.');
  return validateMessage(JSON.parse(text), expectedVersion);
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

function machineMetadata(payload = {}) {
  const pathStyle = String(payload.path_style || '').trim();
  return {
    hostname: String(payload.hostname || '').trim().slice(0, 128) || null,
    platform: String(payload.platform || '').trim().slice(0, 32) || null,
    arch: String(payload.arch || '').trim().slice(0, 32) || null,
    pathStyle: ['windows', 'posix'].includes(pathStyle) ? pathStyle : null
  };
}

function runtimeMetadata(payload = {}) {
  const hasReady = Object.prototype.hasOwnProperty.call(payload, 'runtime_ready');
  const runtimeReady = hasReady
    ? payload.runtime_ready === true
    : null;
  const runtimeReason = runtimeReady === false
    ? (String(payload.runtime_reason || 'LOCAL_EXECUTION_ENGINE_UNAVAILABLE').trim().slice(0, 96) || 'LOCAL_EXECUTION_ENGINE_UNAVAILABLE')
    : null;
  const executionRuntimeGeneration = String(payload.execution_runtime_generation || '').trim().slice(0, 128) || null;
  return { runtimeReady, runtimeReason, executionRuntimeGeneration };
}

function effectiveRuntimeGeneration(device) {
  return device.executionRuntimeGeneration || `legacy:${device.connectionEpoch}`;
}

function publicDevice(device, { stored = null, usage = null, schema = null } = {}) {
  return {
    deviceId: device.deviceId,
    deviceName: stored?.deviceName || device.deviceId,
    hostname: device.hostname || stored?.hostname || null,
    platform: device.platform || stored?.platform || null,
    arch: device.arch || stored?.arch || null,
    pathStyle: device.pathStyle || stored?.pathStyle || null,
    account: {
      connected: Boolean(stored?.ownerAccountId),
      account_id: stored?.ownerAccountId || null,
      label: stored?.accountLabel || null
    },
    online: Boolean(device.online),
    revoked: Boolean(stored?.revokedAt || device.revoked),
    connectionEpoch: device.connectionEpoch || 0,
    runtimeReady: device.runtimeReady ?? null,
    runtimeReason: device.runtimeReason || null,
    executionRuntimeGeneration: device.executionRuntimeGeneration || null,
    agentVersion: device.agentVersion || stored?.agentVersion || 'unknown',
    packageVersion: device.packageVersion || stored?.packageVersion || null,
    capabilities: [...(device.capabilities || [])],
    connectedAt: device.connectedAt || null,
    lastSeenAt: device.lastSeenAt || null,
    usage,
    schema
  };
}

function authFailure(ws, message = 'authentication failed') {
  if (ws.readyState === WebSocket.OPEN) ws.close(4003, message.slice(0, 120));
}

function deviceBrokerError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

export function createDeviceBroker(options = {}) {
  const enrollmentToken = String(options.enrollmentToken || '').trim();
  const deviceStore = options.deviceStore || null;
  const pairingStore = options.pairingStore || null;
  const usageStore = options.usageStore || null;
  const auditRecorder = options.auditRecorder || null;
  const onDeviceForgotten = typeof options.onDeviceForgotten === 'function' ? options.onDeviceForgotten : null;
  const innerTls = options.innerTls || null;
  const durableAuth = Boolean(deviceStore);
  const requireAccountOwnership = options.requireAccountOwnership !== false;
  let schemaSnapshot = normalizeSchemaSnapshot(options.schemaSnapshot);
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const helloTimeoutMs = options.helloTimeoutMs ?? DEFAULT_HELLO_TIMEOUT_MS;
  const updateTimeoutMs = options.updateTimeoutMs ?? DEFAULT_UPDATE_TIMEOUT_MS;
  const devices = new Map();
  const pending = new Map();
  const pendingByWireRequestId = new Map();
  const updateStates = new Map();
  const updateTimers = new Map();
  const activityStates = new Map();
  const sockets = new Set();
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });
  let attachedServer = null;
  let upgradeHandler = null;

  function normalizeSchemaSnapshot(value = {}) {
    const toolCount = Number.isInteger(Number(value.toolCount)) ? Number(value.toolCount) : 0;
    const toolSchemaBytes = Number.isInteger(Number(value.toolSchemaBytes)) ? Number(value.toolSchemaBytes) : 0;
    const toolSchemaTokenEstimate = Number.isInteger(Number(value.toolSchemaTokenEstimate))
      ? Number(value.toolSchemaTokenEstimate)
      : Math.ceil(toolSchemaBytes / 4);
    return {
      toolCount,
      toolSchemaBytes,
      toolSchemaTokenEstimate,
      tokenEstimateMethod: String(value.tokenEstimateMethod || 'utf8_bytes_div_4_estimate').slice(0, 64),
      tokenUsageKind: 'schema_estimate_not_billing'
    };
  }

  function statusForDevice(device) {
    const stored = durableAuth ? deviceStore.get(device.deviceId) : null;
    const usage = usageStore ? usageStore.get(device.deviceId) : null;
    const status = publicDevice(device, { stored, usage, schema: schemaSnapshot });
    return { ...status, update: updateStates.get(device.deviceId) || null };
  }

  function clearUpdateTimer(deviceId) {
    const timer = updateTimers.get(deviceId);
    if (timer) clearTimeout(timer);
    updateTimers.delete(deviceId);
  }

  function armUpdateTimer(deviceId, requestId) {
    clearUpdateTimer(deviceId);
    const delay = Number(updateTimeoutMs) > 0 ? Number(updateTimeoutMs) : DEFAULT_UPDATE_TIMEOUT_MS;
    const timer = setTimeout(() => {
      updateTimers.delete(deviceId);
      const current = updateStates.get(deviceId);
      if (!current || current.requestId !== requestId || !['requested', 'accepted', 'installed'].includes(current.state)) return;
      updateStates.set(deviceId, {
        ...current,
        state: 'failed',
        updatedAt: Date.now(),
        error: {
          code: 'DEVICE_UPDATE_TIMEOUT',
          message: 'Device update stopped reporting progress before completion; retry only after the device is online.'
        }
      });
    }, delay);
    timer.unref?.();
    updateTimers.set(deviceId, timer);
  }

  function recordDeviceStatus(device, status) {
    if (!usageStore || !device?.deviceId) return;
    const stored = durableAuth ? deviceStore.get(device.deviceId) : null;
    usageStore.recordDeviceStatus(device.deviceId, {
      accountId: stored?.ownerAccountId || null,
      status,
      connectionEpoch: device.connectionEpoch || 0,
      agentVersion: device.agentVersion || null
    });
  }

  function noteActivitySent(deviceId, tool) {
    const previous = activityStates.get(deviceId) || {};
    activityStates.set(deviceId, {
      ...previous,
      lastTool: String(tool || previous.lastTool || ''),
      lastSentAt: Date.now()
    });
  }

  function noteActivityFinished(deviceId, tool, outcome = 'success') {
    const previous = activityStates.get(deviceId) || {};
    activityStates.set(deviceId, {
      ...previous,
      lastTool: String(tool || previous.lastTool || ''),
      lastReceivedAt: Date.now(),
      lastOutcome: String(outcome || 'success')
    });
  }

  function getActivitySnapshot({ accountId = null } = {}) {
    const owner = String(accountId || '').trim();
    if (durableAuth && requireAccountOwnership && !owner) return [];
    const pendingByDevice = new Map();
    for (const entry of pending.values()) {
      const current = pendingByDevice.get(entry.deviceId) || { count: 0, tool: null, startedAt: 0 };
      current.count += 1;
      if (Number(entry.startedAt || 0) >= current.startedAt) {
        current.startedAt = Number(entry.startedAt || 0);
        current.tool = entry.tool || current.tool;
      }
      pendingByDevice.set(entry.deviceId, current);
    }
    return [...devices.values()].flatMap(device => {
      const stored = durableAuth ? deviceStore.get(device.deviceId) : null;
      if (durableAuth && !stored) return [];
      if (owner && stored?.ownerAccountId !== owner) return [];
      const activity = activityStates.get(device.deviceId) || {};
      const active = pendingByDevice.get(device.deviceId) || { count: 0, tool: null };
      return [{
        deviceId: device.deviceId,
        inFlight: active.count,
        tool: active.tool || activity.lastTool || null,
        lastSentAt: activity.lastSentAt || null,
        lastReceivedAt: activity.lastReceivedAt || null,
        lastOutcome: activity.lastOutcome || null
      }];
    });
  }

  function statusPayload(device) {
    const status = statusForDevice(device);
    return {
      accepted: true,
      account: status.account,
      device: {
        id: status.deviceId,
        name: status.deviceName,
        online: status.online,
        connectionEpoch: status.connectionEpoch,
        runtimeReady: status.runtimeReady,
        runtimeReason: status.runtimeReason,
        executionRuntimeGeneration: status.executionRuntimeGeneration,
        connectedAt: status.connectedAt,
        lastSeenAt: status.lastSeenAt
      },
      usage: status.usage,
      schema: status.schema
    };
  }

  function socketProtocolVersion(ws) {
    return ws?.deviceProtocolVersion === DEVICE_PROTOCOL_VERSION_V2
      ? DEVICE_PROTOCOL_VERSION_V2
      : DEVICE_PROTOCOL_VERSION;
  }

  function sendDeviceMessage(ws, message, callback = undefined) {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      callback?.(new Error('Device WebSocket is not open.'));
      return false;
    }
    const protocolVersion = socketProtocolVersion(ws);
    const payload = { ...message, protocol_version: protocolVersion };
    if (protocolVersion === DEVICE_PROTOCOL_VERSION_V2) {
      if (!ws.innerTlsSocket || ws.innerTlsSocket.destroyed) {
        callback?.(new Error('Device inner TLS socket is not open.'));
        return false;
      }
      const frame = encodeJsonFrame(payload, MAX_MESSAGE_BYTES);
      ws.innerTlsSocket.write(frame, callback);
      return true;
    }
    ws.send(JSON.stringify(payload), callback);
    return true;
  }

  function sendStatusSnapshot(ws, device) {
    if (!ws || ws.readyState !== WebSocket.OPEN || !device) return;
    sendDeviceMessage(ws, {
      type: 'status_snapshot',
      device_id: device.deviceId,
      connection_epoch: device.connectionEpoch,
      timestamp: Date.now(),
      payload: statusPayload(device)
    });
  }

  if (durableAuth) {
    for (const stored of deviceStore.list()) {
      if (stored.revokedAt) {
        deviceStore.revoke(stored.deviceId);
        auditRecorder?.recordEvent?.({
          event: 'legacy_revoked_device_purged',
          callerCategory: 'migration',
          deviceId: stored.deviceId,
          details: { deviceName: stored.deviceName || stored.deviceId }
        });
        continue;
      }
      devices.set(stored.deviceId, {
        deviceId: stored.deviceId,
        socket: null,
        online: false,
        revoked: false,
        connectionEpoch: 0,
        agentVersion: stored.agentVersion || 'unknown',
        packageVersion: stored.packageVersion || null,
        hostname: stored.hostname || null,
        platform: stored.platform || null,
        arch: stored.arch || null,
        pathStyle: stored.pathStyle || null,
        capabilities: [],
        runtimeReady: null,
        runtimeReason: null,
        executionRuntimeGeneration: null,
        connectedAt: null,
        lastSeenAt: null,
        authenticatedPublicKeyPem: null,
        authenticatedAuthorizationGeneration: null
      });
    }
  }

  function rejectPendingForConnection(deviceId, connectionEpoch, reason, { code = 'DEVICE_OFFLINE', outcome = 'disconnected' } = {}) {
    for (const [requestId, entry] of pending) {
      if (entry.deviceId !== deviceId || entry.connectionEpoch !== connectionEpoch) continue;
      clearTimeout(entry.timer);
      if (pending.get(requestId) !== entry) continue;
      pending.delete(requestId);
      if (pendingByWireRequestId.get(entry.wireRequestId) === entry) pendingByWireRequestId.delete(entry.wireRequestId);
      noteActivityFinished(entry.deviceId, entry.tool, outcome);
      entry.reject(deviceBrokerError(reason, code));
    }
  }

  function registerConnection(ws, {
    deviceId,
    agentVersion,
    packageVersion = null,
    capabilities,
    hostname = null,
    platform = null,
    arch = null,
    pathStyle = null,
    runtimeReady = null,
    runtimeReason = null,
    executionRuntimeGeneration = null,
    publicKeyPem = null,
    authorizationGeneration = null
  }) {
    const previous = devices.get(deviceId);
    const connectionEpoch = (previous?.connectionEpoch || 0) + 1;
    const current = {
      deviceId,
      socket: ws,
      online: true,
      revoked: false,
      connectionEpoch,
      agentVersion: String(agentVersion || 'unknown'),
      packageVersion: String(packageVersion || '').trim().slice(0, 32) || null,
      hostname: String(hostname || '').trim().slice(0, 128) || null,
      platform: String(platform || '').trim().slice(0, 32) || null,
      arch: String(arch || '').trim().slice(0, 32) || null,
      pathStyle: ['windows', 'posix'].includes(String(pathStyle || '').trim()) ? String(pathStyle).trim() : null,
      capabilities: normalizeCapabilities(capabilities),
      runtimeReady: typeof runtimeReady === 'boolean' ? runtimeReady : null,
      runtimeReason: runtimeReady === false ? (String(runtimeReason || 'LOCAL_EXECUTION_ENGINE_UNAVAILABLE').slice(0, 96) || 'LOCAL_EXECUTION_ENGINE_UNAVAILABLE') : null,
      executionRuntimeGeneration: String(executionRuntimeGeneration || '').trim().slice(0, 128) || null,
      connectedAt: Date.now(),
      lastSeenAt: Date.now(),
      authenticatedPublicKeyPem: durableAuth ? String(publicKeyPem || '') : null,
      authenticatedAuthorizationGeneration: durableAuth ? Number(authorizationGeneration) : null
    };
    devices.set(deviceId, current);
    const update = updateStates.get(deviceId);
    if (update?.targetVersion && current.packageVersion === update.targetVersion) {
      clearUpdateTimer(deviceId);
      updateStates.set(deviceId, { ...update, state: 'complete', completedAt: Date.now(), error: null });
    }
    ws.deviceId = deviceId;
    ws.connectionEpoch = connectionEpoch;
    ws.authenticated = true;
    if (previous?.socket && previous.socket !== ws) {
      rejectPendingForConnection(
        deviceId,
        previous.connectionEpoch,
        'Device connection was replaced before the request result was known; the request was not replayed.'
      );
      if (previous.socket.readyState === WebSocket.OPEN) previous.socket.close(4001, 'replaced by newer connection');
    }
    return current;
  }

  function applyRuntimeState(device, payload = {}) {
    const hasReady = Object.prototype.hasOwnProperty.call(payload, 'runtime_ready');
    const hasReason = Object.prototype.hasOwnProperty.call(payload, 'runtime_reason');
    const hasGeneration = Object.prototype.hasOwnProperty.call(payload, 'execution_runtime_generation');
    if (!hasReady && !hasReason && !hasGeneration) return;

    const beforeGeneration = effectiveRuntimeGeneration(device);
    const metadata = runtimeMetadata(payload);
    if (hasReady) device.runtimeReady = metadata.runtimeReady;
    if (hasReady || hasReason) {
      device.runtimeReason = device.runtimeReady === false
        ? metadata.runtimeReason
        : null;
    }
    if (hasGeneration) device.executionRuntimeGeneration = metadata.executionRuntimeGeneration;
    const afterGeneration = effectiveRuntimeGeneration(device);

    if (device.runtimeReady === false) {
      rejectPendingForConnection(
        device.deviceId,
        device.connectionEpoch,
        'Device execution runtime became unavailable before the request result was known; the request was not replayed.',
        { code: 'DEVICE_NOT_READY', outcome: 'not_ready' }
      );
      return;
    }
    if (beforeGeneration !== afterGeneration) {
      rejectPendingForConnection(
        device.deviceId,
        device.connectionEpoch,
        'Device execution runtime changed before the request result was known; the request was not replayed.',
        { code: 'DEVICE_RUNTIME_CHANGED', outcome: 'runtime_changed' }
      );
    }
  }

  function invalidateAuthorization(device, { revoked, reason, closeCode }) {
    const socket = device.socket;
    const connectionEpoch = device.connectionEpoch;
    rejectPendingForConnection(
      device.deviceId,
      connectionEpoch,
      `${reason} before the request result was known; the request was not replayed.`
    );
    if (revoked) {
      clearUpdateTimer(device.deviceId);
      updateStates.delete(device.deviceId);
      activityStates.delete(device.deviceId);
      devices.delete(device.deviceId);
      try { onDeviceForgotten?.({ deviceId: device.deviceId, accountId: null }); }
      catch (error) { console.error(`[device-broker] device cleanup callback failed: ${error.message}`); }
      auditRecorder?.recordEvent?.({
        event: 'device_forget_observed',
        callerCategory: 'broker',
        deviceId: device.deviceId,
        details: { reason: String(reason || 'authorization removed').slice(0, 160) }
      });
      if (socket?.readyState === WebSocket.OPEN) socket.close(closeCode, reason.slice(0, 120));
      return;
    }
    device.revoked = false;
    device.online = false;
    device.socket = null;
    device.lastSeenAt = Date.now();
    device.authenticatedPublicKeyPem = null;
    device.authenticatedAuthorizationGeneration = null;
    recordDeviceStatus(device, 'offline');
    if (socket?.readyState === WebSocket.OPEN) socket.close(closeCode, reason.slice(0, 120));
  }

  function refreshAuthorization(device) {
    if (!durableAuth || !device?.online || !device.socket) return true;
    const stored = deviceStore.get(device.deviceId);
    if (!stored || stored.revokedAt) {
      invalidateAuthorization(device, { revoked: true, reason: 'Device was revoked', closeCode: 4004 });
      return false;
    }
    if (!device.authenticatedPublicKeyPem || stored.publicKeyPem !== device.authenticatedPublicKeyPem || stored.authorizationGeneration !== device.authenticatedAuthorizationGeneration) {
      invalidateAuthorization(device, { revoked: false, reason: 'Device authorization changed', closeCode: 4005 });
      return false;
    }
    return true;
  }

  function sendAuthChallenge(ws, authState) {
    const nonce = randomBytes(32).toString('base64url');
    const protocolVersion = socketProtocolVersion(ws);
    let exporter = null;
    if (protocolVersion === DEVICE_PROTOCOL_VERSION_V2) {
      exporter = ws.innerTlsSocket.exportKeyingMaterial(
        32,
        DEVICE_AUTH_EXPORTER_LABEL,
        buildDeviceAuthExporterContext({ deviceId: authState.deviceId, mode: authState.mode })
      );
    }
    ws.authState = { ...authState, nonce, exporter };
    sendDeviceMessage(ws, {
      type: 'auth_challenge',
      device_id: authState.deviceId,
      timestamp: Date.now(),
      payload: {
        nonce,
        ...(protocolVersion === DEVICE_PROTOCOL_VERSION_V2 ? { mode: authState.mode } : {})
      }
    });
  }

  function handleAuthHello(ws, message) {
    const deviceId = normalizeDeviceId(message.device_id);
    const v2 = socketProtocolVersion(ws) === DEVICE_PROTOCOL_VERSION_V2;
    const innerCredential = v2 ? String(message.payload?.enrollment_grant || '').trim() : '';
    if (message.type === 'enroll_hello') {
      const pairingCredential = v2 ? innerCredential : String(ws.enrollmentCredential || '').trim();
      const legacyEnrollmentAuthorized = v2
        ? tokenMatches(pairingCredential, enrollmentToken)
        : Boolean(ws.enrollmentAuthorized);
      if (!legacyEnrollmentAuthorized && !(pairingStore && pairingCredential)) {
        return authFailure(ws, 'enrollment authorization required');
      }
      const existing = deviceStore.get(deviceId);
      if (existing) return authFailure(ws, existing.revokedAt ? 'device revoked' : 'device already enrolled');
      const publicKeyPem = String(message.payload?.public_key_pem || '');
      if (!publicKeyPem) return authFailure(ws, 'public key required');
      sendAuthChallenge(ws, {
        mode: 'enroll',
        deviceId,
        publicKeyPem,
        agentVersion: message.payload?.agent_version,
        packageVersion: message.payload?.package_version,
        capabilities: message.payload?.capabilities,
        ...machineMetadata(message.payload),
        ...runtimeMetadata(message.payload),
        legacyEnrollmentAuthorized,
        enrollmentGrant: pairingCredential
      });
      return;
    }
    const stored = deviceStore.get(deviceId);
    if (!v2 && stored?.minProtocol >= 2) return authFailure(ws, 'device requires protocol v2');
    if (message.type === 'pair_hello') {
      const pairingCredential = v2 ? innerCredential : String(ws.enrollmentCredential || '').trim();
      if (!pairingStore || !pairingCredential) return authFailure(ws, 'pairing grant required');
      if (stored?.revokedAt) return authFailure(ws, 'revoked device');
      const publicKeyPem = stored?.publicKeyPem || String(message.payload?.public_key_pem || '');
      if (!publicKeyPem) return authFailure(ws, 'public key required for device migration');
      sendAuthChallenge(ws, {
        mode: 'pair',
        deviceId,
        publicKeyPem,
        agentVersion: message.payload?.agent_version,
        packageVersion: message.payload?.package_version,
        capabilities: message.payload?.capabilities,
        ...machineMetadata(message.payload),
        ...runtimeMetadata(message.payload),
        authorizationGeneration: stored?.authorizationGeneration ?? null,
        wasEnrolled: Boolean(stored),
        enrollmentGrant: pairingCredential
      });
      return;
    }
    if (message.type !== 'auth_hello') return authFailure(ws, 'first message must be enroll_hello, pair_hello, or auth_hello');
    if (!stored || stored.revokedAt) return authFailure(ws, 'unknown or revoked device');
    sendAuthChallenge(ws, {
      mode: 'reconnect',
      deviceId,
      publicKeyPem: stored.publicKeyPem,
      agentVersion: message.payload?.agent_version,
      packageVersion: message.payload?.package_version,
      capabilities: message.payload?.capabilities,
      ...machineMetadata(message.payload),
      ...runtimeMetadata(message.payload),
      authorizationGeneration: stored.authorizationGeneration
    });
  }

  function handleAuthResponse(ws, message) {
    const state = ws.authState;
    if (!state || message.type !== 'auth_response' || normalizeDeviceId(message.device_id) !== state.deviceId) {
      return authFailure(ws, 'invalid authentication response');
    }
    let signature;
    try { signature = Buffer.from(String(message.payload?.signature || ''), 'base64'); } catch { return authFailure(ws); }
    const challenge = socketProtocolVersion(ws) === DEVICE_PROTOCOL_VERSION_V2
      ? buildDeviceAuthChallengeV2({
          deviceId: state.deviceId,
          mode: state.mode,
          nonce: state.nonce,
          exporter: state.exporter,
          publicKeyPem: state.publicKeyPem,
          grant: state.enrollmentGrant
        })
      : buildDeviceAuthChallenge({ deviceId: state.deviceId, nonce: state.nonce });
    const valid = signature.length > 0 && verify(null, challenge, state.publicKeyPem, signature);
    if (!valid) return authFailure(ws, 'invalid signature');

    let authorizedPublicKeyPem = state.publicKeyPem;
    let authorizationGeneration;
    if (state.mode === 'enroll') {
      try {
        let pairing = null;
        if (!state.legacyEnrollmentAuthorized) {
          pairing = pairingStore.consumeGrant({
            enrollmentGrant: state.enrollmentGrant,
            deviceId: state.deviceId,
            publicKeyPem: state.publicKeyPem
          });
        }
        const enrolled = deviceStore.enroll({
          deviceId: state.deviceId,
          publicKeyPem: state.publicKeyPem,
          deviceName: pairing?.deviceName || state.deviceId,
          ownerAccountId: pairing?.account?.account_id || null,
          accountLabel: pairing?.account?.label || null,
          hostname: state.hostname,
          platform: state.platform,
          arch: state.arch,
          pathStyle: state.pathStyle,
          agentVersion: state.agentVersion,
          packageVersion: state.packageVersion
        });
        authorizedPublicKeyPem = enrolled.publicKeyPem;
        authorizationGeneration = enrolled.authorizationGeneration;
      } catch {
        return authFailure(ws, 'enrollment failed');
      }
    } else if (state.mode === 'pair') {
      try {
        const pairing = pairingStore.consumeGrant({
          enrollmentGrant: state.enrollmentGrant,
          deviceId: state.deviceId,
          publicKeyPem: state.publicKeyPem
        });
        const current = deviceStore.get(state.deviceId);
        let updated;
        if (!current) {
          updated = deviceStore.enroll({
            deviceId: state.deviceId,
            publicKeyPem: state.publicKeyPem,
            deviceName: pairing.deviceName,
            ownerAccountId: pairing.account?.account_id || null,
            accountLabel: pairing.account?.label || null,
            hostname: state.hostname,
            platform: state.platform,
            arch: state.arch,
            pathStyle: state.pathStyle,
            agentVersion: state.agentVersion,
            packageVersion: state.packageVersion
          });
        } else {
          if (current.revokedAt || current.publicKeyPem !== state.publicKeyPem) throw new Error('device authorization changed');
          if (state.wasEnrolled && current.authorizationGeneration !== state.authorizationGeneration) throw new Error('device authorization changed');
          updated = deviceStore.updateMetadata({
            deviceId: state.deviceId,
            deviceName: pairing.deviceName,
            hostname: state.hostname,
            platform: state.platform,
            arch: state.arch,
            pathStyle: state.pathStyle,
            agentVersion: state.agentVersion,
            packageVersion: state.packageVersion
          });
          updated = deviceStore.assignOwner({
            deviceId: state.deviceId,
            ownerAccountId: pairing.account?.account_id || null,
            accountLabel: pairing.account?.label || null
          });
        }
        authorizedPublicKeyPem = updated.publicKeyPem;
        authorizationGeneration = updated.authorizationGeneration;
      } catch {
        return authFailure(ws, 'account pairing failed');
      }
    } else {
      authorizedPublicKeyPem = state.publicKeyPem;
      authorizationGeneration = state.authorizationGeneration;
    }

    try {
      const current = deviceStore.withCurrentAuthorization(
        { deviceId: state.deviceId, publicKeyPem: authorizedPublicKeyPem, authorizationGeneration },
        () => registerConnection(ws, { ...state, publicKeyPem: authorizedPublicKeyPem, authorizationGeneration })
      );
      if ((state.agentVersion !== undefined || state.packageVersion !== undefined) && typeof deviceStore.updateMetadata === 'function') {
        try { deviceStore.updateMetadata({ deviceId: state.deviceId, agentVersion: state.agentVersion, packageVersion: state.packageVersion }); }
        catch (error) { console.error(`[device-broker] device version persist failed: ${error.message}`); }
      }
      if (socketProtocolVersion(ws) === DEVICE_PROTOCOL_VERSION_V2 && typeof deviceStore.raiseProtocolFloor === 'function') {
        deviceStore.raiseProtocolFloor(state.deviceId, DEVICE_PROTOCOL_VERSION_V2);
      }
      ws.authState = null;
      if (usageStore) {
        const previousUsage = usageStore.get(current.deviceId);
        usageStore.recordConnection(current.deviceId, { reconnect: previousUsage.connections > 0 });
        recordDeviceStatus(current, 'online');
      }
      sendDeviceMessage(ws, {
        type: 'auth_ok',
        device_id: current.deviceId,
        connection_epoch: current.connectionEpoch,
        timestamp: Date.now(),
        payload: statusPayload(current)
      });
    } catch { return authFailure(ws, 'device authorization changed'); }
  }

  function registerLegacyHello(ws, message) {
    const deviceId = normalizeDeviceId(message.device_id);
    const current = registerConnection(ws, {
      deviceId,
      agentVersion: message.payload?.agent_version,
      packageVersion: message.payload?.package_version,
      capabilities: message.payload?.capabilities,
      ...machineMetadata(message.payload),
      ...runtimeMetadata(message.payload)
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
    if (!refreshAuthorization(device)) return;
    if (message.device_id && message.device_id !== ws.deviceId) throw new Error('device_id does not match authenticated connection.');
    if (message.connection_epoch !== undefined && message.connection_epoch !== ws.connectionEpoch) return;
    device.lastSeenAt = Date.now();
    if (message.type === 'account_logout') {
      if (!durableAuth) return;
      const updated = deviceStore.assignOwner({ deviceId: device.deviceId, ownerAccountId: null, accountLabel: null });
      device.authenticatedAuthorizationGeneration = updated.authorizationGeneration;
      usageStore?.touch(device.deviceId);
      sendStatusSnapshot(ws, device);
      return;
    }
    if (message.type === 'heartbeat') {
      applyRuntimeState(device, message.payload || {});
      usageStore?.touch(device.deviceId);
      sendStatusSnapshot(ws, device);
      return;
    }
    if (message.type === 'capability_sync') {
      device.capabilities = normalizeCapabilities(message.payload?.capabilities);
      device.agentVersion = String(message.payload?.agent_version || device.agentVersion);
      device.packageVersion = String(message.payload?.package_version || device.packageVersion || '').trim().slice(0, 32) || null;
      if (durableAuth && (message.payload?.agent_version !== undefined || message.payload?.package_version !== undefined)) {
        deviceStore.updateMetadata({ deviceId: device.deviceId, agentVersion: device.agentVersion, packageVersion: device.packageVersion });
      }
      usageStore?.touch(device.deviceId);
      sendStatusSnapshot(ws, device);
      return;
    }
    if (message.type === 'device_update_status') {
      const current = updateStates.get(device.deviceId);
      const requestId = String(message.request_id || '').trim();
      const targetVersion = String(message.payload?.target_version || '').trim();
      if (!current || current.requestId !== requestId || current.targetVersion !== targetVersion) return;
      const state = String(message.payload?.state || '').trim();
      if (!['accepted', 'installed', 'failed'].includes(state)) return;
      updateStates.set(device.deviceId, {
        ...current,
        state,
        updatedAt: Date.now(),
        error: state === 'failed' ? {
          code: String(message.payload?.code || 'DEVICE_UPDATE_FAILED').slice(0, 64),
          message: String(message.payload?.message || 'Device update failed.').slice(0, 240)
        } : null
      });
      if (state === 'failed') clearUpdateTimer(device.deviceId);
      else armUpdateTimer(device.deviceId, requestId);
      return;
    }
    if (message.type !== 'tool_result' && message.type !== 'tool_error') return;
    const wireRequestId = String(message.request_id || '');
    const responseBytes = Buffer.byteLength(JSON.stringify(message), 'utf8');
    let usageOutcome = null;
    const acceptResult = () => {
      const entry = pendingByWireRequestId.get(wireRequestId);
      if (!entry || entry.deviceId !== ws.deviceId || entry.connectionEpoch !== ws.connectionEpoch || pending.get(entry.requestId) !== entry) return;
      clearTimeout(entry.timer);
      pending.delete(entry.requestId);
      if (pendingByWireRequestId.get(wireRequestId) === entry) pendingByWireRequestId.delete(wireRequestId);
      noteActivityFinished(device.deviceId, entry.tool, message.type === 'tool_error' ? 'error' : 'success');
      if (message.type === 'tool_error') {
        const error = new Error(String(message.payload?.message || 'Remote device tool error.'));
        error.code = String(message.payload?.code || 'REMOTE_DEVICE_ERROR').slice(0, 64);
        usageOutcome = { ok: false, errorCode: error.code };
        entry.reject(error);
      } else {
        usageOutcome = { ok: true };
        entry.resolve(entry.includeDispatchContext
          ? { result: message.payload, dispatchContext: entry.dispatchContext }
          : message.payload);
      }
    };
    try {
      if (!durableAuth) acceptResult();
      else {
        deviceStore.withCurrentAuthorization(
          { deviceId: device.deviceId, publicKeyPem: device.authenticatedPublicKeyPem, authorizationGeneration: device.authenticatedAuthorizationGeneration },
          acceptResult
        );
      }
      if (usageOutcome && usageStore) {
        if (usageOutcome.ok) usageStore.recordToolSucceeded(device.deviceId, responseBytes);
        else usageStore.recordToolFailed(device.deviceId, responseBytes, usageOutcome.errorCode);
        sendStatusSnapshot(ws, device);
      }
    } catch {
      invalidateAuthorization(device, { revoked: false, reason: 'Device authorization changed', closeCode: 4005 });
    }
  }

  wss.on('connection', (ws, request) => {
    sockets.add(ws);
    ws.deviceProtocolVersion = ws.protocol === DEVICE_INNER_TLS_SUBPROTOCOL
      ? DEVICE_PROTOCOL_VERSION_V2
      : DEVICE_PROTOCOL_VERSION;
    const helloTimer = setTimeout(() => {
      if (!ws.authenticated && ws.readyState === WebSocket.OPEN) ws.close(4000, 'authentication required');
    }, helloTimeoutMs);
    helloTimer.unref?.();

    const handleLogicalMessage = message => {
      try {
        validateMessage(message, socketProtocolVersion(ws));
        if (!ws.authenticated) {
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
    };

    if (ws.deviceProtocolVersion === DEVICE_PROTOCOL_VERSION_V2) {
      if (!innerTls) {
        ws.close(1011, 'device inner TLS is unavailable');
      } else {
        const secureSocket = createServerInnerTls(ws, innerTls);
        ws.innerTlsSocket = secureSocket;
        const frameParser = createJsonFrameParser({
          maxMessageBytes: MAX_MESSAGE_BYTES,
          onMessage: handleLogicalMessage
        });
        secureSocket.on('data', chunk => {
          try { frameParser.push(chunk); }
          catch (error) {
            if (ws.readyState === WebSocket.OPEN) ws.close(4003, String(error.message).slice(0, 120));
          }
        });
        secureSocket.once('error', error => {
          if (ws.readyState === WebSocket.OPEN) ws.close(4003, String(error.message).slice(0, 120));
        });
      }
    } else {
      ws.on('message', raw => {
        try { handleLogicalMessage(parseMessage(raw)); }
        catch (error) {
          if (ws.readyState === WebSocket.OPEN) ws.close(durableAuth ? 4003 : 4002, String(error.message).slice(0, 120));
        }
      });
    }

    ws.on('close', () => {
      sockets.delete(ws);
      clearTimeout(helloTimer);
      try { ws.innerTlsSocket?.destroy(); } catch {}
      if (!ws.deviceId) return;
      const current = devices.get(ws.deviceId);
      if (!current || current.socket !== ws || current.connectionEpoch !== ws.connectionEpoch) return;
      current.online = false;
      current.socket = null;
      current.lastSeenAt = Date.now();
      recordDeviceStatus(current, 'offline');
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
      const requestedProtocols = String(request.headers['sec-websocket-protocol'] || '')
        .split(',')
        .map(value => value.trim())
        .filter(Boolean);
      const requestsV2 = requestedProtocols.includes(DEVICE_INNER_TLS_SUBPROTOCOL);
      if (requestsV2 && !innerTls) return rejectUpgrade(socket, 503, 'Device Inner TLS Unavailable');
      if (requestedProtocols.length > 0 && !requestsV2) return rejectUpgrade(socket, 400, 'Unsupported Device Protocol');
      if (!durableAuth) {
        if (!enrollmentToken) return rejectUpgrade(socket, 503, 'Device Enrollment Disabled');
        if (!tokenMatches(bearerToken(request), enrollmentToken)) return rejectUpgrade(socket, 401, 'Unauthorized');
      }
      wss.handleUpgrade(request, socket, head, ws => {
        const v2 = ws.protocol === DEVICE_INNER_TLS_SUBPROTOCOL;
        const credential = v2 ? '' : bearerToken(request);
        ws.enrollmentAuthorized = !v2 && tokenMatches(credential, enrollmentToken);
        ws.enrollmentCredential = ws.enrollmentAuthorized ? '' : credential;
        wss.emit('connection', ws, request);
      });
    };
    server.on('upgrade', upgradeHandler);
  }

  function listDevices({ accountId = null } = {}) {
    for (const device of devices.values()) {
      if (device.online) refreshAuthorization(device);
    }
    const owner = String(accountId || '').trim();
    if (durableAuth && requireAccountOwnership && !owner) return [];
    return [...devices.values()]
      .map(statusForDevice)
      .filter(device => !owner || device.account.account_id === owner)
      .sort((a, b) => a.deviceId.localeCompare(b.deviceId));
  }

  function requireOwnedDevice(accountId, deviceId) {
    if (!durableAuth) throw new Error('Durable device store is required for account-owned device operations.');
    const owner = String(accountId || '').trim();
    const normalized = normalizeDeviceId(deviceId);
    if (!owner) throw deviceBrokerError('ACCOUNT_ID_REQUIRED: account_id is required for device management.', 'ACCOUNT_ID_REQUIRED');
    const stored = deviceStore.get(normalized);
    if (!stored || !stored.ownerAccountId || stored.ownerAccountId !== owner) {
      throw deviceBrokerError('DEVICE_ACCESS_DENIED: device is not owned by the caller account.', 'DEVICE_ACCESS_DENIED');
    }
    return stored;
  }

  function renameOwnedDevice({ accountId, deviceId, deviceName }) {
    const stored = requireOwnedDevice(accountId, deviceId);
    const name = String(deviceName || '').trim();
    if (!name || name.length > 128) throw new Error('device_name must be between 1 and 128 characters.');
    deviceStore.updateMetadata({ deviceId: stored.deviceId, deviceName: name });
    const current = devices.get(stored.deviceId) || { deviceId: stored.deviceId, connectionEpoch: 0, capabilities: [] };
    if (current.online) sendStatusSnapshot(current.socket, current);
    return statusForDevice(current);
  }

  function revokeDevice(deviceId, { accountId = null, callerCategory = 'system' } = {}) {
    if (!durableAuth) throw new Error('Durable device store is required for revocation.');
    const normalized = normalizeDeviceId(deviceId);
    const stored = deviceStore.get(normalized);
    if (!stored) throw new Error(`Unknown device ${normalized}.`);
    const current = devices.get(normalized) || { deviceId: normalized, connectionEpoch: 0, capabilities: [] };

    deviceStore.revoke(normalized);
    if (current.socket) {
      rejectPendingForConnection(
        normalized,
        current.connectionEpoch,
        'Device was forgotten before the request result was known; the request was not replayed.'
      );
    }
    clearUpdateTimer(normalized);
    updateStates.delete(normalized);
    activityStates.delete(normalized);
    devices.delete(normalized);
    try {
      onDeviceForgotten?.({ deviceId: normalized, accountId: stored.ownerAccountId || null });
    } catch (error) {
      console.error(`[device-broker] device cleanup callback failed: ${error.message}`);
    }
    if (current.socket?.readyState === WebSocket.OPEN) current.socket.close(4004, 'device forgotten');
    auditRecorder?.recordEvent?.({
      event: 'device_forgotten',
      callerId: accountId || stored.ownerAccountId || '',
      callerCategory,
      deviceId: normalized,
      details: {
        deviceName: stored.deviceName || normalized,
        hostname: stored.hostname || null,
        packageVersion: stored.packageVersion || null
      }
    });
    return { deviceId: normalized, deviceName: stored.deviceName || normalized, forgotten: true };
  }

  function revokeOwnedDevice({ accountId, deviceId }) {
    const stored = requireOwnedDevice(accountId, deviceId);
    return revokeDevice(stored.deviceId, { accountId, callerCategory: 'dashboard' });
  }

  function requestDeviceUpdate({ accountId, deviceId, targetVersion }) {
    const stored = requireOwnedDevice(accountId, deviceId);
    const device = devices.get(stored.deviceId);
    if (device?.online && !refreshAuthorization(device)) {
      throw deviceBrokerError(`Device ${stored.deviceId} authorization changed or was revoked; it is offline.`, 'DEVICE_OFFLINE');
    }
    if (!device?.online || device.revoked || !device.socket || device.socket.readyState !== WebSocket.OPEN) {
      throw deviceBrokerError(`Device ${stored.deviceId} is offline.`, 'DEVICE_OFFLINE');
    }
    const target = normalizeStableVersion(targetVersion);
    let current;
    try { current = normalizeStableVersion(device.packageVersion || stored.packageVersion); }
    catch { throw deviceBrokerError('Device package version is unavailable; bootstrap MCP Device before dashboard updates.', 'DEVICE_UPDATE_BOOTSTRAP_REQUIRED'); }
    const platform = device.platform || stored.platform || null;
    const minimumVersion = minimumSelfUpdateVersion(platform);
    if (!supportsDeviceSelfUpdate(current, platform)) {
      throw deviceBrokerError(`Device must be bootstrapped to MCP Device ${minimumVersion} before dashboard self-update is available.`, 'DEVICE_UPDATE_BOOTSTRAP_REQUIRED');
    }
    if (compareStableVersions(target, current) <= 0) {
      throw deviceBrokerError(`Device is already on ${current} or newer.`, 'DEVICE_UPDATE_NOT_NEEDED');
    }
    const existing = updateStates.get(device.deviceId);
    if (existing && ['requested', 'accepted', 'installed'].includes(existing.state)) {
      if (existing.targetVersion === target) return existing;
      throw deviceBrokerError('Another device update is already in progress.', 'DEVICE_UPDATE_IN_PROGRESS');
    }
    const requestId = randomUUID();
    const update = {
      requestId,
      targetVersion: target,
      state: 'requested',
      requestedAt: Date.now(),
      updatedAt: Date.now(),
      error: null
    };
    const wireMessage = {
      type: 'device_update',
      request_id: requestId,
      device_id: device.deviceId,
      connection_epoch: device.connectionEpoch,
      timestamp: Date.now(),
      payload: { target_version: target }
    };
    const dispatch = () => {
      updateStates.set(device.deviceId, update);
      const sent = sendDeviceMessage(device.socket, wireMessage, error => {
        if (!error) return;
        const currentUpdate = updateStates.get(device.deviceId);
        if (currentUpdate?.requestId !== requestId) return;
        clearUpdateTimer(device.deviceId);
        updateStates.set(device.deviceId, {
          ...currentUpdate,
          state: 'failed',
          updatedAt: Date.now(),
          error: { code: 'DEVICE_UPDATE_SEND_ERROR', message: String(error.message || error).slice(0, 240) }
        });
      });
      if (!sent) {
        clearUpdateTimer(device.deviceId);
        updateStates.set(device.deviceId, {
          ...update,
          state: 'failed',
          updatedAt: Date.now(),
          error: { code: 'DEVICE_UPDATE_SEND_ERROR', message: 'Device update could not be sent.' }
        });
        throw deviceBrokerError('Device update could not be sent.', 'DEVICE_UPDATE_SEND_ERROR');
      }
      armUpdateTimer(device.deviceId, requestId);
    };
    deviceStore.withCurrentAuthorization(
      {
        deviceId: device.deviceId,
        publicKeyPem: device.authenticatedPublicKeyPem,
        authorizationGeneration: device.authenticatedAuthorizationGeneration
      },
      dispatch
    );
    return updateStates.get(device.deviceId);
  }

  async function callDevice({
    requestId: requestedRequestId,
    accountId = null,
    deviceId,
    tool,
    arguments: args = {},
    timeoutMs = requestTimeoutMs,
    expectedConnectionEpoch,
    expectedExecutionRuntimeGeneration,
    includeDispatchContext = false
  }) {
    const device = devices.get(String(deviceId || ''));
    if (device?.online && !refreshAuthorization(device)) {
      throw deviceBrokerError(`Device ${deviceId} authorization changed or was revoked; it is offline.`, 'DEVICE_OFFLINE');
    }
    if (!device?.online || device.revoked || !device.socket || device.socket.readyState !== WebSocket.OPEN) {
      throw deviceBrokerError(`Device ${deviceId} is offline or unknown.`, 'DEVICE_OFFLINE');
    }
    const currentRuntimeGeneration = effectiveRuntimeGeneration(device);
    if (expectedConnectionEpoch !== undefined && String(expectedConnectionEpoch) !== String(device.connectionEpoch)) {
      throw deviceBrokerError('Process session is stale because the device connection changed.', 'PROCESS_SESSION_STALE');
    }
    if (expectedExecutionRuntimeGeneration !== undefined &&
        String(expectedExecutionRuntimeGeneration) !== currentRuntimeGeneration) {
      throw deviceBrokerError('Process session is stale because the execution runtime changed.', 'PROCESS_SESSION_STALE');
    }
    if (device.runtimeReady === false) {
      throw deviceBrokerError(
        `Device ${deviceId} execution runtime is not ready${device.runtimeReason ? `: ${device.runtimeReason}` : '.'}`,
        'DEVICE_NOT_READY'
      );
    }
    if (durableAuth && requireAccountOwnership) {
      const owner = String(accountId || '').trim();
      const stored = deviceStore.get(device.deviceId);
      if (!owner) throw new Error('ACCOUNT_ID_REQUIRED: account_id is required for remote device dispatch.');
      if (!stored?.ownerAccountId || stored.ownerAccountId !== owner) throw new Error('DEVICE_ACCESS_DENIED: device is not owned by the caller account.');
    }
    if (!device.capabilities.includes(tool)) throw new Error(`Device ${deviceId} does not advertise capability ${tool}.`);
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) throw new Error('Device request timeout must be an integer between 1 and 30000 ms.');
    const requestId = requestedRequestId === undefined ? randomUUID() : String(requestedRequestId).trim();
    if (!requestId || requestId.length > 128) throw new Error('Device request_id must be between 1 and 128 characters.');
    if (pending.has(requestId)) throw new Error(`Device request ${requestId} is already pending.`);
    const wireRequestId = randomUUID();
    const wireMessage = {
      type: 'tool_call',
      request_id: wireRequestId,
      device_id: device.deviceId,
      connection_epoch: device.connectionEpoch,
      timestamp: Date.now(),
      payload: { tool, arguments: args }
    };
    const wireVersion = socketProtocolVersion(device.socket);
    const requestBytes = Buffer.byteLength(JSON.stringify({ ...wireMessage, protocol_version: wireVersion }), 'utf8');
    return await new Promise((resolve, reject) => {
      let entry = null;
      const dispatch = () => {
        const current = devices.get(device.deviceId);
        if (current !== device || !device.online || device.revoked ||
            !device.socket || device.socket.readyState !== WebSocket.OPEN) {
          if (expectedConnectionEpoch !== undefined || expectedExecutionRuntimeGeneration !== undefined) {
            throw deviceBrokerError('Process session is stale because the device connection changed.', 'PROCESS_SESSION_STALE');
          }
          throw deviceBrokerError(`Device ${deviceId} connection changed before dispatch.`, 'DEVICE_OFFLINE');
        }
        const dispatchRuntimeGeneration = effectiveRuntimeGeneration(device);
        if (expectedConnectionEpoch !== undefined && String(expectedConnectionEpoch) !== String(device.connectionEpoch)) {
          throw deviceBrokerError('Process session is stale because the device connection changed.', 'PROCESS_SESSION_STALE');
        }
        if (expectedExecutionRuntimeGeneration !== undefined &&
            String(expectedExecutionRuntimeGeneration) !== dispatchRuntimeGeneration) {
          throw deviceBrokerError('Process session is stale because the execution runtime changed.', 'PROCESS_SESSION_STALE');
        }
        if (device.runtimeReady === false) {
          throw deviceBrokerError(
            `Device ${deviceId} execution runtime is not ready${device.runtimeReason ? `: ${device.runtimeReason}` : '.'}`,
            'DEVICE_NOT_READY'
          );
        }
        const dispatchContext = {
          deviceId: device.deviceId,
          connectionEpoch: device.connectionEpoch,
          executionRuntimeGeneration: dispatchRuntimeGeneration
        };
        entry = {
          requestId, wireRequestId, resolve, reject, timer: null,
          deviceId: device.deviceId, connectionEpoch: device.connectionEpoch,
          executionRuntimeGeneration: dispatchRuntimeGeneration,
          includeDispatchContext: includeDispatchContext === true,
          dispatchContext,
          tool, startedAt: Date.now()
        };
        const timer = setTimeout(() => {
          if (pending.get(requestId) !== entry) return;
          pending.delete(requestId);
          if (pendingByWireRequestId.get(wireRequestId) === entry) pendingByWireRequestId.delete(wireRequestId);
          usageStore?.recordToolFailed(device.deviceId, 0, 'DEVICE_REQUEST_TIMEOUT');
          noteActivityFinished(device.deviceId, tool, 'timeout');
          entry.reject(deviceBrokerError(`Device request ${requestId} timed out; it was not replayed.`, 'DEVICE_REQUEST_TIMEOUT'));
        }, timeoutMs);
        entry.timer = timer;
        timer.unref?.();
        pending.set(requestId, entry);
        pendingByWireRequestId.set(wireRequestId, entry);
        noteActivitySent(device.deviceId, tool);
        sendDeviceMessage(device.socket, wireMessage, error => {
          if (!error || pending.get(requestId) !== entry) return;
          clearTimeout(entry.timer);
          pending.delete(requestId);
          if (pendingByWireRequestId.get(wireRequestId) === entry) pendingByWireRequestId.delete(wireRequestId);
          usageStore?.recordToolFailed(device.deviceId, 0, 'DEVICE_SEND_ERROR');
          noteActivityFinished(device.deviceId, tool, 'send_error');
          entry.reject(error);
        });
      };
      try {
        if (durableAuth) {
          deviceStore.withCurrentAuthorization(
            {
              deviceId: device.deviceId,
              publicKeyPem: device.authenticatedPublicKeyPem,
              authorizationGeneration: device.authenticatedAuthorizationGeneration
            },
            dispatch
          );
        } else dispatch();
        usageStore?.recordToolStarted(device.deviceId, requestBytes);
      } catch (error) {
        if (entry && pending.get(requestId) === entry) {
          clearTimeout(entry.timer);
          pending.delete(requestId);
          if (pendingByWireRequestId.get(wireRequestId) === entry) pendingByWireRequestId.delete(wireRequestId);
        }
        if (durableAuth && /authorization changed|revoked|stale/i.test(String(error?.message || ''))) {
          invalidateAuthorization(device, { revoked: false, reason: 'Device authorization changed', closeCode: 4005 });
        }
        reject(error);
      }
    });
  }

  async function shutdown() {
    if (attachedServer && upgradeHandler) attachedServer.off('upgrade', upgradeHandler);
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      if (pending.get(entry.requestId) === entry) pending.delete(entry.requestId);
      if (pendingByWireRequestId.get(entry.wireRequestId) === entry) pendingByWireRequestId.delete(entry.wireRequestId);
      entry.reject(new Error('Device broker is shutting down.'));
    }
    pending.clear();
    pendingByWireRequestId.clear();
    for (const deviceId of updateTimers.keys()) clearUpdateTimer(deviceId);
    for (const ws of sockets) { try { ws.terminate(); } catch {} }
    sockets.clear();
    await new Promise(resolve => wss.close(() => resolve()));
    attachedServer = null;
    upgradeHandler = null;
  }

  function setSchemaSnapshot(value) {
    schemaSnapshot = normalizeSchemaSnapshot(value);
    for (const device of devices.values()) {
      if (device.online) sendStatusSnapshot(device.socket, device);
    }
    return schemaSnapshot;
  }

  return { attach, listDevices, getActivitySnapshot, renameOwnedDevice, revokeDevice, revokeOwnedDevice, requestDeviceUpdate, callDevice, setSchemaSnapshot, shutdown };
}
