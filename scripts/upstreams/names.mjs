const ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

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

export function normalizeCapabilityName(name) {
  const raw = String(name ?? '').trim().toLowerCase();
  const normalized = raw.replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').replace(/_+/g, '_');
  return normalized || 'unnamed';
}

export function toExternalToolName(serverPrefix, upstreamToolName) {
  return `custom_${validateUpstreamId(serverPrefix, 'tool prefix')}_${normalizeCapabilityName(upstreamToolName)}`;
}

export function toExternalPromptName(serverPrefix, upstreamPromptName) {
  return `external_${validateUpstreamId(serverPrefix, 'prompt prefix')}_${normalizeCapabilityName(upstreamPromptName)}`;
}

export function assertNoNameCollision(name, seen, kind = 'capability') {
  if (seen.has(name)) {
    throw new Error(`External MCP ${kind} name collision: ${name}`);
  }
  seen.add(name);
  return name;
}
