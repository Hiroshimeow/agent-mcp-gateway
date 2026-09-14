import { pathToFileURL } from 'node:url';

function jsonBytes(value) {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function defaultClassifyTool(tool) {
  if (tool?._meta?.upstream?.source === 'external-mcp') return 'external';
  return 'core';
}

export function measureCatalogPayload({
  toolsPayload = { tools: [] },
  resourcesPayload = { resources: [] },
  templatesPayload = { resourceTemplates: [] },
  promptsPayload = { prompts: [] },
  classifyTool = defaultClassifyTool
} = {}) {
  const tools = Array.isArray(toolsPayload?.tools) ? toolsPayload.tools : [];
  const resources = Array.isArray(resourcesPayload?.resources) ? resourcesPayload.resources : [];
  const templates = Array.isArray(templatesPayload?.resourceTemplates) ? templatesPayload.resourceTemplates : [];
  const prompts = Array.isArray(promptsPayload?.prompts) ? promptsPayload.prompts : [];
  const groups = {
    core: { count: 0, bytes: 0 },
    external: { count: 0, bytes: 0 },
    other: { count: 0, bytes: 0 }
  };

  for (const tool of tools) {
    const rawGroup = classifyTool(tool);
    const group = Object.prototype.hasOwnProperty.call(groups, rawGroup) ? rawGroup : 'other';
    groups[group].count += 1;
    groups[group].bytes += jsonBytes(tool);
  }

  return {
    toolCount: tools.length,
    toolSchemaBytes: jsonBytes(toolsPayload),
    resourceCount: resources.length,
    resourceTemplateCount: templates.length,
    promptCount: prompts.length,
    groups
  };
}

export function parseSyntheticCounts(value) {
  const parts = String(value ?? '').split(',').map(part => Number(part.trim()));
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0)) {
    throw new Error('Invalid synthetic counts; expected tools,resources,templates,prompts as non-negative integers.');
  }
  const [tools, resources, templates, prompts] = parts;
  return { tools, resources, templates, prompts };
}

function syntheticPayloads(counts) {
  return {
    toolsPayload: {
      tools: Array.from({ length: counts.tools }, (_, index) => ({
        name: `synthetic_tool_${index + 1}`,
        description: 'Synthetic catalog benchmark tool.',
        inputSchema: { type: 'object', properties: {} }
      }))
    },
    resourcesPayload: {
      resources: Array.from({ length: counts.resources }, (_, index) => ({
        uri: `synthetic://resource/${index + 1}`,
        name: `Synthetic resource ${index + 1}`
      }))
    },
    templatesPayload: {
      resourceTemplates: Array.from({ length: counts.templates }, (_, index) => ({
        uriTemplate: `synthetic://template/${index + 1}/{id}`,
        name: `Synthetic template ${index + 1}`
      }))
    },
    promptsPayload: {
      prompts: Array.from({ length: counts.prompts }, (_, index) => ({ name: `synthetic_prompt_${index + 1}` }))
    }
  };
}

function parseArgs(argv) {
  const result = { url: '', bearerEnv: '', synthetic: '' };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--url') result.url = argv[++index] || '';
    else if (arg === '--bearer-env') result.bearerEnv = argv[++index] || '';
    else if (arg === '--synthetic') result.synthetic = argv[++index] || '';
    else if (arg === '--help' || arg === '-h') result.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return result;
}

function parseMcpResponse(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) throw new Error('Empty MCP response.');
  if (trimmed.startsWith('{')) return JSON.parse(trimmed);
  const dataLines = trimmed
    .split(/\r?\n/)
    .filter(line => line.startsWith('data:'))
    .map(line => line.slice(5).trim())
    .filter(Boolean);
  if (!dataLines.length) throw new Error(`Unexpected MCP response: ${trimmed.slice(0, 300)}`);
  return JSON.parse(dataLines.join('\n'));
}

async function mcpRequest(url, id, method, token, params = {}) {
  const headers = {
    accept: 'application/json, text/event-stream',
    'content-type': 'application/json'
  };
  if (token) headers.authorization = `Bearer ${token}`;
  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params })
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`MCP HTTP ${response.status}: ${text.slice(0, 300)}`);
  const parsed = parseMcpResponse(text);
  if (parsed?.error) throw new Error(`MCP ${method} failed: ${parsed.error.message || JSON.stringify(parsed.error)}`);
  return parsed?.result || {};
}

async function measureRemoteCatalog({ url, token }) {
  let id = 1;
  await mcpRequest(url, id++, 'initialize', token, {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'catalog-benchmark', version: '1.0.0' }
  });
  const [toolsPayload, resourcesPayload, templatesPayload, promptsPayload] = await Promise.all([
    mcpRequest(url, id++, 'tools/list', token),
    mcpRequest(url, id++, 'resources/list', token),
    mcpRequest(url, id++, 'resources/templates/list', token),
    mcpRequest(url, id++, 'prompts/list', token)
  ]);
  return measureCatalogPayload({ toolsPayload, resourcesPayload, templatesPayload, promptsPayload });
}

function usage() {
  return [
    'Usage:',
    '  npm run benchmark:catalog -- --url http://127.0.0.1:8102/mcp [--bearer-env MCP_BEARER_TOKEN]',
    '  npm run benchmark:catalog -- --synthetic 86,75,3,36'
  ].join('\n');
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }

  let report;
  if (args.synthetic) {
    report = measureCatalogPayload(syntheticPayloads(parseSyntheticCounts(args.synthetic)));
  } else {
    if (!args.url) throw new Error('--url is required unless --synthetic is used.');
    const token = args.bearerEnv ? String(env[args.bearerEnv] || '') : '';
    if (args.bearerEnv && !token) throw new Error(`Bearer token environment variable is empty: ${args.bearerEnv}`);
    report = await measureRemoteCatalog({ url: args.url, token });
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
