import { createHash } from 'node:crypto';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import { classifyExternalToolLane } from './catalog-budget.mjs';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
const MAX_DESCRIPTION_CHARS = 240;
const MAX_INPUT_SUMMARY = 20;

function boundedLimit(value) {
  if (value === undefined || value === null || value === '') return DEFAULT_LIMIT;
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new Error(`Invalid limit: ${value}. Expected an integer from 1 to ${MAX_LIMIT}.`);
  }
  return limit;
}

function tokenize(value) {
  return String(value || '').toLowerCase().match(/[\p{L}\p{N}_-]+/gu) || [];
}

function searchScore(tool, query) {
  const normalizedQuery = String(query || '').trim().toLowerCase();
  if (!normalizedQuery) return 0;
  const name = String(tool.name || '').toLowerCase();
  const description = String(tool.description || '').toLowerCase();
  if (name === normalizedQuery) return 1_000_000;

  let score = name.includes(normalizedQuery) ? 10_000 : 0;
  for (const token of tokenize(normalizedQuery)) {
    if (name === token) score += 2_000;
    else if (name.includes(token)) score += 500;
    if (description.includes(token)) score += 50;
  }
  return score;
}

function inputSummary(tool) {
  const properties = Object.keys(tool?.inputSchema?.properties || {});
  const required = Array.isArray(tool?.inputSchema?.required) ? tool.inputSchema.required : [];
  const ordered = [...required, ...properties.filter(name => !required.includes(name))];
  return [...new Set(ordered)].slice(0, MAX_INPUT_SUMMARY);
}

function publicSearchItem(tool) {
  return {
    name: tool.name,
    description: String(tool.description || '').slice(0, MAX_DESCRIPTION_CHARS),
    lane: classifyExternalToolLane(tool),
    server: String(tool?._meta?.upstream?.upstreamId || ''),
    inputSummary: inputSummary(tool)
  };
}

export function isExternalToolAllowedForProfile(tool, runtimeProfile) {
  const profile = runtimeProfile || {};
  if (classifyExternalToolLane(tool) === 'read') return true;
  if (!profile.exposeDestructiveTools) return false;

  const annotations = tool?.annotations;
  const openWorld = annotations?.openWorldHint !== false;
  if (openWorld && !profile.exposeOpenWorldTools) return false;
  return true;
}

function cursorSignature({ query, server, lane, runtimeProfile, tools }) {
  return createHash('sha256').update(JSON.stringify({
    query: String(query || '').trim().toLowerCase(),
    server: String(server || '').trim(),
    lane: String(lane || '').trim(),
    profile: runtimeProfile?.name || '',
    tools: tools.map(tool => tool.name)
  })).digest('base64url').slice(0, 18);
}

function encodeCursor(offset, signature) {
  return Buffer.from(JSON.stringify({ v: 1, offset, signature }), 'utf8').toString('base64url');
}

function decodeCursor(cursor, signature) {
  if (!cursor) return 0;
  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(String(cursor), 'base64url').toString('utf8'));
  } catch {
    throw new Error('Invalid cursor: expected an opaque cursor returned by external_tool_search.');
  }
  if (parsed?.v !== 1 || parsed?.signature !== signature || !Number.isInteger(parsed?.offset) || parsed.offset < 0) {
    throw new Error('Invalid or stale cursor: search parameters or catalog changed.');
  }
  return parsed.offset;
}

function searchTools(tools, options, runtimeProfile) {
  const query = String(options.query || '').trim();
  const server = String(options.server || '').trim();
  const lane = String(options.lane || '').trim();
  if (lane && !['read', 'write'].includes(lane)) throw new Error(`Invalid lane: ${lane}. Expected read or write.`);
  const limit = boundedLimit(options.limit);

  const filtered = tools
    .filter(tool => isExternalToolAllowedForProfile(tool, runtimeProfile))
    .filter(tool => !server || tool?._meta?.upstream?.upstreamId === server)
    .filter(tool => !lane || classifyExternalToolLane(tool) === lane)
    .map(tool => ({ tool, score: searchScore(tool, query) }))
    .filter(entry => !query || entry.score > 0)
    .sort((left, right) => right.score - left.score || String(left.tool.name).localeCompare(String(right.tool.name)))
    .map(entry => entry.tool);

  const signature = cursorSignature({ query, server, lane, runtimeProfile, tools: filtered });
  const offset = decodeCursor(options.cursor, signature);
  if (offset > filtered.length) throw new Error('Invalid or stale cursor: offset is outside the current result set.');
  const page = filtered.slice(offset, offset + limit);
  const nextOffset = offset + page.length;
  const truncated = nextOffset < filtered.length;
  return {
    items: page.map(publicSearchItem),
    truncated,
    nextCursor: truncated ? encodeCursor(nextOffset, signature) : null
  };
}

export function createExternalToolBroker({ getTools, invokeTool }) {
  if (typeof getTools !== 'function') throw new Error('createExternalToolBroker requires getTools().');
  if (typeof invokeTool !== 'function') throw new Error('createExternalToolBroker requires invokeTool().');
  const validatorProvider = new AjvJsonSchemaValidator();
  const validatorCache = new Map();

  function currentTools() {
    const tools = getTools();
    return Array.isArray(tools) ? tools : [];
  }

  function findTool(name) {
    const tool = currentTools().find(item => item.name === name);
    if (!tool) throw new Error(`Unknown external tool: ${name}`);
    return tool;
  }

  function validateArguments(tool, args) {
    const schema = tool.inputSchema || { type: 'object' };
    const schemaKey = JSON.stringify(schema);
    let cached = validatorCache.get(tool.name);
    if (!cached || cached.schemaKey !== schemaKey) {
      try {
        cached = { schemaKey, validate: validatorProvider.getValidator(schema) };
      } catch (error) {
        throw new Error(`Unable to validate cached input schema for ${tool.name}: ${error.message}`);
      }
      validatorCache.set(tool.name, cached);
    }
    const result = cached.validate(args);
    if (!result.valid) throw new Error(`Invalid arguments for ${tool.name}: ${result.errorMessage || 'schema validation failed'}`);
  }

  return {
    search(options = {}, runtimeProfile = {}) {
      return searchTools(currentTools(), options, runtimeProfile);
    },
    async call(expectedLane, options = {}, runtimeProfile = {}) {
      if (!['read', 'write'].includes(expectedLane)) throw new Error(`Invalid external tool call lane: ${expectedLane}`);
      const name = String(options.name || '').trim();
      if (!name) throw new Error('External tool name is required.');
      const tool = findTool(name);
      const actualLane = classifyExternalToolLane(tool);
      if (actualLane !== expectedLane) {
        throw new Error(`External tool ${name} belongs to the ${actualLane} lane; use external_tool_call_${actualLane}.`);
      }
      if (!isExternalToolAllowedForProfile(tool, runtimeProfile)) {
        throw new Error(`Tool ${name} is disabled by MCP_SAFETY_PROFILE=${runtimeProfile?.name || 'unknown'}.`);
      }
      const args = options.arguments ?? {};
      if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error(`Invalid arguments for ${name}: expected an object.`);
      validateArguments(tool, args);
      return await invokeTool(name, args);
    }
  };
}
