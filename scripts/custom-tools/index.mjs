import { imagePreviewTool } from './image-preview-tool.mjs';
import { fail, ok } from './response-utils.mjs';
import { getSkillTool } from '../skills/index.mjs';
import { applyToolRisk } from '../tool-risk.mjs';

function schema(properties = {}, required = []) {
  return { type: 'object', properties, required, additionalProperties: false };
}

const TOOL_DEFINITIONS = [
  {
    name: 'get_skill',
    description: 'Load a known skill directly by name or alias. Omit name only when discovery is needed; discovery returns the compact live routing catalog without a skill body.',
    inputSchema: schema({
      name: {
        type: 'string',
        description: 'Registered skill name or alias. Omit only to discover the compact live skill catalog.'
      }
    }),
    outputSchema: {
      type: 'object',
      properties: {
        ok: { type: 'boolean' },
        tool: { type: 'string' },
        summary: { type: 'string' },
        data: { type: 'object' }
      },
      required: ['ok', 'tool', 'summary', 'data'],
      additionalProperties: false
    },
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
  }
];

const LOCAL_TOOLS = new Map(TOOL_DEFINITIONS.map(tool => [tool.name, tool]));

export function isLocalCustomTool(name) {
  return LOCAL_TOOLS.has(String(name || ''));
}

export function listCustomTools(context = {}) {
  const meta = {
    trusted_roots: context.resolvedRepoRoots || [],
    root_repo: context.resolvedRepoRoot,
    repo_root: context.resolvedRepoRoot
  };
  return TOOL_DEFINITIONS.map(tool => applyToolRisk({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}),
    annotations: { ...tool.annotations },
    _meta: meta
  }));
}

export async function callCustomTool(name, args = {}, context = {}) {
  const localName = String(name || '');
  const tool = LOCAL_TOOLS.get(localName);
  if (!tool) return fail(localName || 'unknown', 'UNKNOWN_TOOL', `Unknown local tool: ${name}`);
  return await tool.handler(args || {}, context);
}

export const LOCAL_TOOL_NAMES = [...LOCAL_TOOLS.keys()];
