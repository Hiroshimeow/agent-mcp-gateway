import { createHash } from 'node:crypto';

const HARD_MAX_INPUT_BYTES = 48 * 1024;
const HARD_MAX_OUTPUT_BYTES = 48 * 1024;
const DEFAULT_INPUT_BYTES = 32 * 1024;
const DEFAULT_OUTPUT_BYTES = 48 * 1024;
const DEFAULT_REQUESTS_PER_MINUTE = 60;
const PATH_TOOLS = new Set(['read_text_file', 'write_file', 'edit_file']);
const CWD_TOOLS = new Set(['shell_execute', 'start_process']);

export class DeviceAccessError extends Error {
  constructor(message, code = 'DEVICE_ACCESS_DENIED') {
    super(message);
    this.name = 'DeviceAccessError';
    this.code = code;
  }
}

function bytes(value) {
  return Buffer.byteLength(JSON.stringify(value ?? {}), 'utf8');
}

function stringList(value, field) {
  const values = Array.isArray(value) ? value : value === undefined ? [] : [value];
  const normalized = [...new Set(values.map(item => String(item).trim()).filter(Boolean))];
  if (!normalized.length) throw new Error(`device access rule ${field} must not be empty`);
  return normalized;
}

function positiveInt(value, fallback, maximum, field) {
  const number = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(number) || number < 1 || number > maximum) {
    throw new Error(`device access rule ${field} must be an integer between 1 and ${maximum}`);
  }
  return number;
}

function normalizeRemotePath(value) {
  const raw = String(value || '').trim().replaceAll('\\', '/');
  if (!raw || !(raw.startsWith('/') || raw.startsWith('//') || /^[A-Za-z]:\//.test(raw))) {
    throw new DeviceAccessError('Remote path must be absolute and inside an allowed root.', 'DEVICE_PATH_DENIED');
  }
  const windowsLike = raw.startsWith('//') || /^[A-Za-z]:\//.test(raw);
  let prefix = '';
  let remainder = raw;
  if (/^[A-Za-z]:\//.test(raw)) {
    prefix = `${raw.slice(0, 2)}/`;
    remainder = raw.slice(3);
  } else if (raw.startsWith('//')) {
    const parts = raw.slice(2).split('/').filter(Boolean);
    if (parts.length < 2) throw new DeviceAccessError('UNC path must include server and share.', 'DEVICE_PATH_DENIED');
    prefix = `//${parts.shift()}/${parts.shift()}/`;
    remainder = parts.join('/');
  } else {
    prefix = '/';
    remainder = raw.slice(1);
  }
  const segments = [];
  for (const segment of remainder.split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      if (!segments.length) throw new DeviceAccessError('Remote path escapes its root.', 'DEVICE_PATH_DENIED');
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  let normalized = prefix + segments.join('/');
  if (normalized.length > prefix.length) normalized = normalized.replace(/\/$/, '');
  return windowsLike ? normalized.toLowerCase() : normalized;
}

function pathAllowed(candidate, roots) {
  const normalized = normalizeRemotePath(candidate);
  return roots.some(root => {
    const base = normalizeRemotePath(root);
    return normalized === base || normalized.startsWith(base.endsWith('/') ? base : `${base}/`);
  });
}

function callerMatches(pattern, callerSubject, callerCategory) {
  if (pattern === '*') return true;
  if (pattern === callerSubject || pattern === callerCategory) return true;
  return pattern.endsWith('*') && callerSubject.startsWith(pattern.slice(0, -1));
}

function parseRules(raw) {
  if (!String(raw || '').trim()) return [];
  let parsed;
  try { parsed = JSON.parse(String(raw)); }
  catch { throw new Error('MCP_DEVICE_ACCESS_POLICY must be valid JSON'); }
  if (!parsed || !Array.isArray(parsed.rules)) throw new Error('MCP_DEVICE_ACCESS_POLICY must contain a rules array');
  return parsed.rules.map((rule, index) => {
    if (!rule || typeof rule !== 'object' || Array.isArray(rule)) throw new Error(`device access rule ${index} must be an object`);
    const callers = stringList(rule.callers ?? rule.caller, 'callers');
    const devices = stringList(rule.devices ?? rule.device, 'devices');
    const tools = stringList(rule.tools, 'tools');
    const roots = Array.isArray(rule.roots) ? rule.roots.map(item => String(item).trim()).filter(Boolean) : [];
    return {
      id: String(rule.id || `rule-${index + 1}`),
      callers,
      devices,
      tools,
      roots,
      requestsPerMinute: positiveInt(rule.requests_per_minute, DEFAULT_REQUESTS_PER_MINUTE, 600, 'requests_per_minute'),
      maxInputBytes: positiveInt(rule.max_input_bytes, DEFAULT_INPUT_BYTES, HARD_MAX_INPUT_BYTES, 'max_input_bytes'),
      maxOutputBytes: positiveInt(rule.max_output_bytes, DEFAULT_OUTPUT_BYTES, HARD_MAX_OUTPUT_BYTES, 'max_output_bytes')
    };
  });
}

export function callerAuditId(callerSubject) {
  return createHash('sha256').update(String(callerSubject || 'anonymous')).digest('hex').slice(0, 16);
}

export function createDeviceAccessPolicy({ raw = '', now = Date.now, profile = 'safe' } = {}) {
  const rules = parseRules(raw);
  const windows = new Map();
  const yolo = String(profile || '').trim().toLowerCase() === 'yolo';

  function authenticatedCaller(category) {
    return category === 'oauth' || category === 'static-bearer';
  }

  function matchingRule({ callerSubject, callerCategory, deviceId, tool }) {
    return rules.find(rule =>
      rule.callers.some(pattern => callerMatches(pattern, callerSubject, callerCategory))
      && rule.devices.some(pattern => pattern === '*' || pattern === deviceId)
      && rule.tools.some(pattern => pattern === '*' || pattern === tool)
    );
  }

  function enforceRate(rule, callerSubject, deviceId) {
    const key = `${rule.id}\n${callerSubject}\n${deviceId}`;
    const current = now();
    let state = windows.get(key);
    if (!state || current - state.startedAt >= 60_000) {
      state = { startedAt: current, count: 0 };
      windows.set(key, state);
    }
    state.count += 1;
    if (state.count > rule.requestsPerMinute) {
      throw new DeviceAccessError('Remote device rate limit exceeded.', 'DEVICE_RATE_LIMIT');
    }
  }

  function authorize({ callerSubject = 'anonymous', callerCategory = 'anonymous', deviceId, tool, arguments: args = {} }) {
    const normalizedDevice = String(deviceId || '').trim();
    const normalizedTool = String(tool || '').trim();
    const subject = String(callerSubject || callerCategory || 'anonymous');
    const category = String(callerCategory || 'anonymous');
    const inputBytes = bytes(args);
    if (yolo) {
      if (!authenticatedCaller(category)) throw new DeviceAccessError(`Remote device access is not authorized for ${normalizedTool}.`);
      if (inputBytes > HARD_MAX_INPUT_BYTES) {
        throw new DeviceAccessError('Remote device request exceeds the hard input size limit.', 'DEVICE_INPUT_TOO_LARGE');
      }
      return { ruleId: 'yolo-authenticated-device', inputBytes, maxOutputBytes: HARD_MAX_OUTPUT_BYTES };
    }
    const rule = matchingRule({ callerSubject: subject, callerCategory: category, deviceId: normalizedDevice, tool: normalizedTool });
    if (!rule) throw new DeviceAccessError(`Remote device access is not authorized for ${normalizedTool}.`);
    if (inputBytes > rule.maxInputBytes) {
      throw new DeviceAccessError('Remote device request exceeds the allowed input size.', 'DEVICE_INPUT_TOO_LARGE');
    }
    if (PATH_TOOLS.has(normalizedTool)) {
      if (!rule.roots.length || !pathAllowed(args.path, rule.roots)) {
        throw new DeviceAccessError('Remote file path is outside the caller/device allowlist.', 'DEVICE_PATH_DENIED');
      }
    }
    if (CWD_TOOLS.has(normalizedTool)) {
      if (!rule.roots.length || !args.working_directory || !pathAllowed(args.working_directory, rule.roots)) {
        throw new DeviceAccessError('Remote process working_directory must be inside an allowed root.', 'DEVICE_PATH_DENIED');
      }
    }
    enforceRate(rule, subject, normalizedDevice);
    return { ruleId: rule.id, inputBytes, maxOutputBytes: rule.maxOutputBytes };
  }

  function filterDevices(devices, { callerSubject = 'anonymous', callerCategory = 'anonymous' } = {}) {
    const subject = String(callerSubject || callerCategory || 'anonymous');
    const category = String(callerCategory || 'anonymous');
    const inventory = Array.isArray(devices) ? devices : [];
    if (yolo) return authenticatedCaller(category) ? inventory : [];
    return inventory.filter(device => {
      const deviceId = String(device?.deviceId || '').trim();
      const capabilities = Array.isArray(device?.capabilities) ? device.capabilities.map(String) : [];
      return rules.some(rule =>
        rule.callers.some(pattern => callerMatches(pattern, subject, category))
        && rule.devices.some(pattern => pattern === '*' || pattern === deviceId)
        && rule.tools.some(pattern => pattern === '*' || capabilities.includes(pattern))
      );
    });
  }

  function assertOutput(grant, result) {
    const outputBytes = bytes(result);
    if (outputBytes > grant.maxOutputBytes) {
      throw new DeviceAccessError('Remote device response exceeds the allowed output size.', 'DEVICE_OUTPUT_TOO_LARGE');
    }
    return outputBytes;
  }

  return { authorize, assertOutput, filterDevices, ruleCount: rules.length };
}
