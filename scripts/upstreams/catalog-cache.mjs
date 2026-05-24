export function createCatalogSnapshot({ generation = 0, diagnostics = {}, builtAt = new Date().toISOString() } = {}) {
  return {
    tools: [],
    resources: [],
    resourceTemplates: [],
    prompts: [],
    toolRoutes: new Map(),
    resourceRoutes: new Map(),
    promptRoutes: new Map(),
    diagnostics,
    builtAt,
    generation
  };
}

export function createCatalogState({ snapshot = createCatalogSnapshot() } = {}) {
  return {
    snapshot,
    lastRefreshAt: snapshot.builtAt || null,
    refreshInFlight: null,
    lastRefreshError: null,
    generation: snapshot.generation || 0
  };
}

export function createCatalogCache() {
  return createCatalogSnapshot();
}
