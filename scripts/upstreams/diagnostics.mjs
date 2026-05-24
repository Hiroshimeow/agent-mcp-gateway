export function diagnosticsResource(uri, data) {
  return { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(data, null, 2) }] };
}

export function summarizeDiagnostics(statuses, catalogState = {}, config = {}) {
  const snapshot = catalogState.snapshot || {};
  return {
    source: 'external-mcp',
    generatedAt: new Date().toISOString(),
    configPath: config.configPath || null,
    cacheMode: config.external?.catalog_cache || 'startup',
    catalogTtlMs: config.external?.catalog_cache_ttl_ms ?? null,
    generation: catalogState.generation ?? snapshot.generation ?? 0,
    lastRefreshAt: catalogState.lastRefreshAt || null,
    lastRefreshError: catalogState.lastRefreshError || null,
    refreshInFlight: Boolean(catalogState.refreshInFlight),
    servers: [...statuses.entries()].map(([id, value]) => ({ id, ...value })),
    upstreams: Object.fromEntries([...statuses.entries()].map(([id, value]) => [id, value]))
  };
}
