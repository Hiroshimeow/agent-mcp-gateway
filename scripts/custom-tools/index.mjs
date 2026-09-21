import { fail, ok } from './response-utils.mjs';
import { inspectProject, listProjects, PROJECT_INSPECTION_VIEWS } from '../project-inspection.mjs';
import { applyToolRisk } from '../tool-risk.mjs';
import { skillResourceUri } from '../skills/index.mjs';

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

function requireSkillRegistry(context = {}) {
  if (!context.skillRegistry) throw new Error('Skill registry is unavailable.');
  return context.skillRegistry;
}

function skillCatalog(args = {}, context = {}) {
  const snapshot = requireSkillRegistry(context).snapshot();
  const version = snapshot.catalogVersion;
  if (String(args.known_version || '') === version) return { changed: false, version };
  return {
    changed: true,
    version,
    skills: snapshot.skills.map(skill => ({
      name: skill.name,
      description: skill.description,
      uri: skill.uri,
      revision: skill.skillRevision
    }))
  };
}

function loadSkill(args = {}, context = {}) {
  const registry = requireSkillRegistry(context);
  const skill = registry.getByName(String(args.name || ''));
  if (!skill) throw new Error(`Unknown skill: ${args.name}`);
  const resource = String(args.resource || '').trim();
  if (!resource) {
    return {
      name: skill.name,
      description: skill.description,
      uri: skill.uri,
      revision: skill.skillRevision,
      body: skill.body,
      resources: skill.resources
    };
  }
  if (resource.startsWith('/') || resource.includes('\\') || resource.split('/').some(segment => !segment || segment === '.' || segment === '..')) {
    throw new Error('Invalid skill resource path.');
  }
  const requestedUri = skillResourceUri(skill.name, resource);
  const entry = skill.resources.find(item => item.uri === requestedUri);
  if (!entry) throw new Error(`Unknown resource for ${skill.name}: ${resource}`);
  const loaded = registry.readResource(entry.uri);
  if (!loaded) throw new Error(`Unknown resource for ${skill.name}: ${resource}`);
  return {
    name: skill.name,
    uri: loaded.uri,
    revision: skill.skillRevision,
    mimeType: loaded.mimeType,
    digest: loaded.digest,
    size: loaded.size,
    ...(loaded.text !== undefined ? { text: loaded.text } : { blob: loaded.blob })
  };
}

const TOOL_DEFINITIONS = [
  {
    name: 'skill_catalog',
    description: 'Discover the current reusable skill catalog for clients that do not natively implement the MCP Skills extension. Returns compact metadata only; use load_skill for content.',
    inputSchema: schema({
      known_version: { type: 'string', description: 'Previously observed catalog version; matching versions return changed:false.' }
    }),
    outputSchema: structuredOutputSchema(),
    annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
    handler: (args, context) => ok('skill_catalog', 'Read skill catalog', skillCatalog(args, context))
  },
  {
    name: 'load_skill',
    description: 'Load one reusable skill, or one explicitly listed supporting resource, for clients that do not natively implement the MCP Skills extension.',
    inputSchema: schema({
      name: { type: 'string', minLength: 1, description: 'Canonical skill name from skill_catalog.' },
      resource: { type: 'string', description: 'Optional relative resource path from the selected skill manifest.' }
    }, ['name']),
    outputSchema: structuredOutputSchema(),
    annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
    handler: (args, context) => ok('load_skill', 'Loaded skill content', loadSkill(args, context))
  },
  {
    name: 'image_preview',
    description: 'Load a bounded image preview from one explicit owned online device for visual inspection.',
    inputSchema: schema({
      device_id: { type: 'string', minLength: 1, description: 'Owned online device containing the image.' },
      path: { type: 'string' },
      file: { type: 'string' },
      sourcePath: { type: 'string' },
      embed: { type: 'boolean', default: true },
      includeImage: { type: 'boolean', default: true },
      includeData: { type: 'boolean', default: true },
      maxBytes: { type: 'number', default: 8388608 }
    }, ['device_id']),
    annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
    handler: (args, context) => {
      if (!context.callDeviceTool) throw new Error('Device execution routing is unavailable.');
      return context.callDeviceTool('image_preview', args);
    }
  },
  {
    name: 'project_list',
    description: 'List configured projects for one explicit owned online device. Local absolute paths stay hidden unless path exposure is explicitly enabled.',
    inputSchema: schema({
      device_id: { type: 'string', minLength: 1, description: 'Owned online device id whose configured projects should be listed.' },
      query: { type: 'string', description: 'Optional project id or display-name filter.' },
      cursor: { type: 'string', description: 'Opaque cursor returned by the previous page.' },
      limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 }
    }, ['device_id']),
    outputSchema: structuredOutputSchema(),
    annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
    handler: (args, context) => ok('project_list', 'Listed projects', listProjects(context, args))
  },
  {
    name: 'project_inspect',
    description: 'Inspect one configured project through bounded summary, tree, Git, README, or package views. Use read_text_file for generic file bodies.',
    inputSchema: schema({
      device_id: { type: 'string', minLength: 1, description: 'Owned online device id associated with the project.' },
      project_id: { type: 'string', description: 'Configured project id on that device.' },
      view: { type: 'string', enum: [...PROJECT_INSPECTION_VIEWS] },
      depth: { type: 'integer', minimum: 1, maximum: 10, default: 3 },
      staged: { type: 'boolean', default: false },
      cursor: { type: 'string', description: 'Opaque cursor returned by a bounded tree page.' },
      limit: { type: 'integer', minimum: 1, maximum: 500, default: 200 }
    }, ['device_id', 'project_id', 'view']),
    outputSchema: structuredOutputSchema(),
    annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
    handler: async (args, context) => ok(
      'project_inspect',
      `Inspected project ${args.project_id}`,
      await inspectProject(context, { ...args, deviceId: args.device_id, projectId: args.project_id })
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
