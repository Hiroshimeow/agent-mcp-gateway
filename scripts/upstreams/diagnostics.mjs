export function diagnosticsResource(uri, data) {
  return { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(data, null, 2) }] };
}

export function summarizeDiagnostics(statuses) {
  return {
    source: 'external-mcp',
    generatedAt: new Date().toISOString(),
    upstreams: Object.fromEntries([...statuses.entries()].map(([id, value]) => [id, value]))
  };
}
