import { imagePreviewTool } from './image-preview-tool.mjs';
import { fail, ok } from './response-utils.mjs';
import { getSkillTool } from '../skills/index.mjs';
import { inspectProject, listProjects, PROJECT_INSPECTION_VIEWS } from '../project-inspection.mjs';
import { applyToolRisk } from '../tool-risk.mjs';

function schema(properties = {}, required = []) {
  return { type: 'object', properties, required, additionalProperties: false };
}

function structuredOutputSchema() {
  return {
    type: 'object',
    properties: {
      ok: { type: 'boolean' },
      tool: { type: 'string' },
      summary: { type: 'string' },
      data: { type: 'object' }
    },
    required: ['ok', 'tool', 'summary', 'data'],
    additionalProperties: false
  };
}

function requireExternalToolBroker(context = {}) {
  if (!context.externalToolBroker) throw new Error('External tool broker is unavailable.');
  return context.externalToolBroker;
}

const TOOL_DEFINITIONS = [
  {
    name: 'get_skill',
    description: 'Load a known skill directly by name or alias. Omit name only when discovery is needed; discovery returns the compact live routing catalog without a skill body.',
    inputSchema: schema({
      name: {
        type: 'string',
        description: 'Registered skill name or alias. Omit only to discover the compact live skill catalog.'
      },
      cursor: { type: 'string', description: 'Opaque cursor returned by get_skill discovery.' },
      limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 }
    }),
    outputSchema: structuredOutputSchema(),
    annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
    handler: args => ok('get_skill', 'Loaded skill definition', getSkillTool(args))
  },
  {
    name: 'image_preview',
    description: 'Read an existing local image as MCP image content for visual inspection.',
    inputSchema: schema({
      path: { type: 'string' },
      file: { type: 'string' },
      sourcePath: { type: 'string' },
      embed: { type: 'boolean', default: true },
      includeImage: { type: 'boolean', default: true },
      includeData: { type: 'boolean', default: true },
      maxBytes: { type: 'number', default: 8388608 }
    }),
    annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
    handler: imagePreviewTool
  },
  {
    name: 'project_list',
    description: 'List configured projects with bounded pagination and optional name/id filtering. Local absolute paths stay hidden unless path exposure is explicitly enabled.',
    inputSchema: schema({
      query: { type: 'string', description: 'Optional project id or display-name filter.' },
      cursor: { type: 'string', description: 'Opaque cursor returned by the previous page.' },
      limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 }
    }),
    outputSchema: structuredOutputSchema(),
    annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
    handler: (args, context) => ok('project_list', 'Listed projects', listProjects(context, args))
  },
  {
    name: 'project_inspect',
    description: 'Inspect one configured project through bounded summary, tree, Git, README, or package views. Use read_text_file for generic file bodies.',
    inputSchema: schema({
      project_id: { type: 'string', description: 'Configured project id.' },
      view: { type: 'string', enum: [...PROJECT_INSPECTION_VIEWS] },
      depth: { type: 'integer', minimum: 1, maximum: 10, default: 3 },
      staged: { type: 'boolean', default: false },
      cursor: { type: 'string', description: 'Opaque cursor returned by a bounded tree page.' },
      limit: { type: 'integer', minimum: 1, maximum: 500, default: 200 }
    }, ['project_id', 'view']),
    outputSchema: structuredOutputSchema(),
    annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
    handler: async (args, context) => ok(
      'project_inspect',
      `Inspected project ${args.project_id}`,
      await inspectProject(context, { ...args, projectId: args.project_id })
    )
  },
  {
    name: 'external_tool_search',
    description: 'Search the bounded external MCP catalog without exposing full deferred schemas. Results are filtered by runtime profile.',
    inputSchema: schema({
      query: { type: 'string', description: 'Optional name/description search text.' },
      server: { type: 'string', description: 'Optional external MCP server id.' },
      lane: { type: 'string', enum: ['read', 'write'], description: 'Optional risk lane filter.' },
      cursor: { type: 'string', description: 'Opaque cursor returned by the previous search page.' },
      limit: { type: 'integer', minimum: 1, maximum: 50, default: 20 }
    }),
    outputSchema: structuredOutputSchema(),
    annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
    handler: (args, context) => ok(
      'external_tool_search',
      'Searched external MCP tools',
      requireExternalToolBroker(context).search(args, context.runtimeProfile)
    )
  },
  {
    name: 'external_tool_call_read',
    description: 'Invoke one discovered external MCP tool only when its cached annotations place it in the read lane. Arguments are validated against the cached full input schema before forwarding.',
    inputSchema: schema({
      name: { type: 'string', minLength: 1 },
      arguments: { type: 'object', default: {} }
    }, ['name']),
    annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
    handler: (args, context) => requireExternalToolBroker(context).call('read', args, context.runtimeProfile)
  },
  {
    name: 'external_tool_call_write',
    description: 'Invoke one discovered external MCP tool only when its cached annotations place it in the write lane. Arguments are validated against the cached full input schema before forwarding.',
    inputSchema: schema({
      name: { type: 'string', minLength: 1 },
      arguments: { type: 'object', default: {} }
    }, ['name']),
    annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: true, openWorldHint: false },
    handler: (args, context) => requireExternalToolBroker(context).call('write', args, context.runtimeProfile)
  }
];

const LOCAL_TOOLS = new Map(TOOL_DEFINITIONS.map(tool => [tool.name, tool]));

export function isLocalCustomTool(name) {
  return LOCAL_TOOLS.has(String(name || ''));
}

export function listCustomTools(_context = {}) {
  return TOOL_DEFINITIONS.map(tool => applyToolRisk({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}),
    annotations: { ...tool.annotations }
  }));
}

export async function callCustomTool(name, args = {}, context = {}) {
  const localName = String(name || '');
  const tool = LOCAL_TOOLS.get(localName);
  if (!tool) return fail(localName || 'unknown', 'UNKNOWN_TOOL', `Unknown local tool: ${name}`);
  return await tool.handler(args || {}, context);
}

export const LOCAL_TOOL_NAMES = [...LOCAL_TOOLS.keys()];
