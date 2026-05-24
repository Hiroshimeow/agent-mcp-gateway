const ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const RESERVED_TOOL_PREFIXES = new Set(['custom']);

export function validateUpstreamId(id, label = 'upstream id') {
  const value = String(id ?? '').trim();
  if (!ID_PATTERN.test(value)) {
    throw new Error(`Invalid ${label}: ${id}. Expected ${ID_PATTERN}.`);
  }
  if (value.includes('..') || /[\\/]/.test(value)) {
    throw new Error(`Invalid ${label}: ${id}. Path separators and dot-dot are not allowed.`);
  }
  return value;
}

export function validateExternalToolPrefix(prefix, label = 'tool prefix') {
  const value = validateUpstreamId(prefix, label);
  if (RESERVED_TOOL_PREFIXES.has(value)) {
    throw new Error(`Invalid ${label}: ${value}. This prefix is reserved for local gateway tools.`);
  }
  return value;
}

export function normalizeCapabilityName(name) {
  const raw = String(name ?? '').trim().toLowerCase();
  const normalized = raw.replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').replace(/_+/g, '_');
  return normalized || 'unnamed';
}

function stripDuplicatePrefix(prefix, capabilityName) {
  const normalizedPrefix = normalizeCapabilityName(validateUpstreamId(prefix, 'capability prefix'));
  const normalizedName = normalizeCapabilityName(capabilityName);
  const marker = `${normalizedPrefix}_`;
  if (normalizedName.startsWith(marker) && normalizedName.length > marker.length) {
    return normalizedName.slice(marker.length);
  }
  return normalizedName;
}

export function toExternalToolName(serverPrefix, upstreamToolName) {
  const prefix = validateUpstreamId(serverPrefix, 'tool prefix');
  return `${prefix}_${stripDuplicatePrefix(prefix, upstreamToolName)}`;
}

export function toExternalPromptName(serverPrefix, upstreamPromptName) {
  const prefix = validateUpstreamId(serverPrefix, 'prompt prefix');
  return `${prefix}_${stripDuplicatePrefix(prefix, upstreamPromptName)}`;
}

export function assertNoNameCollision(name, seen, kind = 'capability') {
  if (seen.has(name)) {
    throw new Error(`External MCP ${kind} name collision: ${name}`);
  }
  seen.add(name);
  return name;
}
