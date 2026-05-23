export function createCatalogCache() {
  return {
    tools: [],
    resources: [],
    resourceTemplates: [],
    prompts: [],
    toolRoutes: new Map(),
    resourceRoutes: new Map(),
    promptRoutes: new Map()
  };
}
