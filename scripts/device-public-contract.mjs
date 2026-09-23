import { DEVICE_EXECUTION_TOOL_NAMES, listStaticDeviceExecutionTools } from './device-execution-tool-definitions.mjs';

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function toolContract(tool) {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: clone(tool.inputSchema),
    ...(tool.outputSchema ? { outputSchema: clone(tool.outputSchema) } : {}),
    ...(tool.annotations ? { annotations: clone(tool.annotations) } : {}),
    ...(tool._meta ? { _meta: clone(tool._meta) } : {})
  };
}

export function buildDevicePublicContract() {
  const tools = listStaticDeviceExecutionTools();
  if (tools.length !== DEVICE_EXECUTION_TOOL_NAMES.length) {
    throw new Error('Device public contract tool count drifted from the fixed execution surface.');
  }
  return {
    schemaVersion: 1,
    scope: 'gateway-device-execution-tools',
    mcpSpecificationRevision: '2026-07-28',
    resultEnvelope: {
      success: {
        content: 'MCP CallToolResult content array',
        structuredContent: 'JSON object when the gateway normalizes a structured device result'
      }
    },
    errorEnvelope: {
      transport: 'MCP tools/call request error',
      internalCodes: [
        'DEVICE_ID_REQUIRED',
        'DEVICE_NOT_READY',
        'DEVICE_OFFLINE',
        'PROCESS_SESSION_STALE',
        'DEVICE_ACCESS_DENIED',
        'DEVICE_PATH_DENIED',
        'DEVICE_RATE_LIMIT',
        'DEVICE_INPUT_TOO_LARGE',
        'DEVICE_OUTPUT_TOO_LARGE'
      ]
    },
    tools: tools.map(toolContract)
  };
}

function jsonEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function addChange(changes, classification, path, before, after) {
  changes.push({ classification, path, before, after });
}

function classifyInputSchema(toolName, before = {}, after = {}, changes) {
  const beforeRequired = new Set(before.required || []);
  const afterRequired = new Set(after.required || []);
  for (const name of afterRequired) {
    if (!beforeRequired.has(name)) addChange(changes, 'breaking', `tools.${toolName}.inputSchema.required+${name}`, false, true);
  }
  for (const name of beforeRequired) {
    if (!afterRequired.has(name)) addChange(changes, 'additive', `tools.${toolName}.inputSchema.required-${name}`, true, false);
  }

  const beforeProps = before.properties || {};
  const afterProps = after.properties || {};
  for (const name of Object.keys(beforeProps)) {
    if (!(name in afterProps)) {
      addChange(changes, 'breaking', `tools.${toolName}.inputSchema.properties.${name}`, beforeProps[name], undefined);
      continue;
    }
    if (!jsonEqual(beforeProps[name], afterProps[name])) {
      addChange(changes, 'breaking', `tools.${toolName}.inputSchema.properties.${name}`, beforeProps[name], afterProps[name]);
    }
  }
  for (const name of Object.keys(afterProps)) {
    if (name in beforeProps) continue;
    addChange(
      changes,
      afterRequired.has(name) ? 'breaking' : 'additive',
      `tools.${toolName}.inputSchema.properties.${name}`,
      undefined,
      afterProps[name]
    );
  }

  const beforeAdditional = before.additionalProperties;
  const afterAdditional = after.additionalProperties;
  if (!jsonEqual(beforeAdditional, afterAdditional)) {
    const classification = beforeAdditional === false && afterAdditional !== false ? 'additive' : 'breaking';
    addChange(changes, classification, `tools.${toolName}.inputSchema.additionalProperties`, beforeAdditional, afterAdditional);
  }

  const handled = new Set(['required', 'properties', 'additionalProperties']);
  const beforeRest = Object.fromEntries(Object.entries(before).filter(([key]) => !handled.has(key)));
  const afterRest = Object.fromEntries(Object.entries(after).filter(([key]) => !handled.has(key)));
  if (!jsonEqual(beforeRest, afterRest)) {
    addChange(changes, 'breaking', `tools.${toolName}.inputSchema`, beforeRest, afterRest);
  }
}

export function classifyDevicePublicContractChanges(baseline, current) {
  const changes = [];
  const baselineTools = new Map((baseline?.tools || []).map(tool => [tool.name, tool]));
  const currentTools = new Map((current?.tools || []).map(tool => [tool.name, tool]));

  for (const [name, before] of baselineTools) {
    const after = currentTools.get(name);
    if (!after) {
      addChange(changes, 'breaking', `tools.${name}`, before, undefined);
      continue;
    }

    const beforeDeprecated = before?._meta?.deprecated === true;
    const afterDeprecated = after?._meta?.deprecated === true;
    if (!beforeDeprecated && afterDeprecated) {
      addChange(changes, 'deprecated', `tools.${name}._meta.deprecated`, false, true);
    }

    classifyInputSchema(name, before.inputSchema, after.inputSchema, changes);

    for (const key of ['description', 'outputSchema', 'annotations']) {
      if (!jsonEqual(before[key], after[key])) {
        addChange(changes, 'breaking', `tools.${name}.${key}`, before[key], after[key]);
      }
    }

    const beforeMeta = { ...(before._meta || {}) };
    const afterMeta = { ...(after._meta || {}) };
    delete beforeMeta.deprecated;
    delete afterMeta.deprecated;
    if (!jsonEqual(beforeMeta, afterMeta)) {
      addChange(changes, 'breaking', `tools.${name}._meta`, beforeMeta, afterMeta);
    }
  }

  for (const [name, after] of currentTools) {
    if (!baselineTools.has(name)) addChange(changes, 'additive', `tools.${name}`, undefined, after);
  }

  for (const key of ['schemaVersion', 'scope', 'mcpSpecificationRevision', 'resultEnvelope', 'errorEnvelope']) {
    if (!jsonEqual(baseline?.[key], current?.[key])) {
      addChange(changes, 'breaking', key, baseline?.[key], current?.[key]);
    }
  }

  const counts = { unchanged: changes.length === 0 ? 1 : 0, additive: 0, deprecated: 0, breaking: 0 };
  for (const change of changes) counts[change.classification] += 1;
  return { counts, changes };
}
