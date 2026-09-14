export function catalogToolBytes(tool) {
  return Buffer.byteLength(JSON.stringify(tool), 'utf8');
}

export function classifyExternalToolLane(tool) {
  const annotations = tool?.annotations;
  return annotations?.readOnlyHint === true &&
    annotations?.destructiveHint === false &&
    annotations?.openWorldHint === false
    ? 'read'
    : 'write';
}

function diagnostics(mode, budgetBytes, tools, eagerTools, deferredTools) {
  const sumBytes = items => items.reduce((sum, tool) => sum + catalogToolBytes(tool), 0);
  return {
    mode,
    budgetBytes,
    total: { count: tools.length, bytes: sumBytes(tools) },
    eager: { count: eagerTools.length, bytes: sumBytes(eagerTools) },
    deferred: { count: deferredTools.length, bytes: sumBytes(deferredTools) }
  };
}

export function selectExternalCatalog(tools = [], externalConfig = {}, servers = []) {
  const mode = externalConfig.exposure_mode || 'direct';
  const budgetBytes = Number(externalConfig.eager_schema_budget_bytes ?? 24576);
  const allowlist = Array.isArray(externalConfig.eager_allowlist) ? externalConfig.eager_allowlist : [];

  if (mode === 'direct') {
    return {
      eagerTools: [...tools],
      deferredTools: [],
      diagnostics: diagnostics(mode, budgetBytes, tools, tools, [])
    };
  }
  if (mode === 'brokered') {
    return {
      eagerTools: [],
      deferredTools: [...tools],
      diagnostics: diagnostics(mode, budgetBytes, tools, [], tools)
    };
  }
  if (mode !== 'hybrid') throw new Error(`Invalid external exposure mode: ${mode}`);

  const byName = new Map(tools.map(tool => [tool.name, tool]));
  const selected = [];
  const selectedNames = new Set();
  let usedBytes = 0;

  for (const name of allowlist) {
    const tool = byName.get(name);
    if (!tool) throw new Error(`External MCP eager allowlist contains unknown tool: ${name}`);
    const bytes = catalogToolBytes(tool);
    if (usedBytes + bytes > budgetBytes) {
      throw new Error(`External MCP eager allowlist exceeds schema budget at ${name}: ${usedBytes + bytes} > ${budgetBytes} bytes`);
    }
    selected.push(tool);
    selectedNames.add(tool.name);
    usedBytes += bytes;
  }

  const serverOrder = new Map(servers.map((server, index) => [server.id, index]));
  const candidates = tools
    .filter(tool => !selectedNames.has(tool.name) && classifyExternalToolLane(tool) === 'read')
    .sort((left, right) => {
      const leftOrder = serverOrder.get(left?._meta?.upstream?.upstreamId) ?? Number.MAX_SAFE_INTEGER;
      const rightOrder = serverOrder.get(right?._meta?.upstream?.upstreamId) ?? Number.MAX_SAFE_INTEGER;
      if (leftOrder !== rightOrder) return leftOrder - rightOrder;
      return String(left.name).localeCompare(String(right.name));
    });

  for (const tool of candidates) {
    const bytes = catalogToolBytes(tool);
    if (usedBytes + bytes > budgetBytes) break;
    selected.push(tool);
    selectedNames.add(tool.name);
    usedBytes += bytes;
  }

  const deferredTools = tools.filter(tool => !selectedNames.has(tool.name));
  return {
    eagerTools: selected,
    deferredTools,
    diagnostics: diagnostics(mode, budgetBytes, tools, selected, deferredTools)
  };
}
