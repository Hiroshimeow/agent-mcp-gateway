export function textJson(value) {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

export function ok(tool, summary, data = {}) {
  return textJson({ ok: true, tool: `custom_${tool}`, summary, data });
}

export function fail(tool, code, message, details = {}) {
  return textJson({ ok: false, tool: `custom_${tool}`, error: { code, message, details } });
}

export function redactSecret(value) {
  const text = String(value ?? '');
  if (text.length <= 8) return '****';
  return `${text.slice(0, 4)}...${text.slice(-4)}`;
}

export function truncateText(text, maxBytes = 200000) {
  const value = String(text ?? '');
  const limit = Number(maxBytes);
  if (!Number.isFinite(limit) || limit <= 0) return { text: '', truncated: value.length > 0 };
  const bytes = Buffer.byteLength(value, 'utf8');
  if (bytes <= limit) return { text: value, truncated: false };
  let end = Math.min(value.length, limit);
  while (Buffer.byteLength(value.slice(0, end), 'utf8') > limit && end > 0) end -= 1;
  return { text: value.slice(0, end), truncated: true };
}

export function parseToolResult(result) {
  const text = result?.content?.find?.(entry => entry?.type === 'text')?.text ?? '{}';
  return JSON.parse(text);
}
