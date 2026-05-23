const SCHEME = 'external-mcp://';

export function encodeUpstreamResourceUri(upstreamUri) {
  return Buffer.from(String(upstreamUri ?? ''), 'utf8').toString('base64url');
}

export function decodeUpstreamResourceUri(encoded) {
  return Buffer.from(String(encoded ?? ''), 'base64url').toString('utf8');
}

export function toExternalResourceUri(serverId, upstreamUri) {
  return `${SCHEME}${encodeURIComponent(serverId)}/${encodeUpstreamResourceUri(upstreamUri)}`;
}

export function isExternalResourceUri(uri) {
  return String(uri || '').startsWith(SCHEME);
}

export function parseExternalResourceUri(uri) {
  const text = String(uri || '');
  if (!isExternalResourceUri(text)) throw new Error(`Not an external MCP resource URI: ${uri}`);
  const match = text.match(/^external-mcp:\/\/([^/]+)\/(.+)$/);
  if (!match) throw new Error(`Invalid external MCP resource URI: ${uri}`);
  const serverId = decodeURIComponent(match[1]);
  if (serverId === '_diagnostics') return { diagnostics: true, serverId, upstreamUri: 'status' };
  const encoded = match[2].replace(/[?#].*$/, '');
  if (encoded === 'status') return { diagnostics: true, serverId, upstreamUri: 'status' };
  return { diagnostics: false, serverId, upstreamUri: decodeUpstreamResourceUri(encoded) };
}
