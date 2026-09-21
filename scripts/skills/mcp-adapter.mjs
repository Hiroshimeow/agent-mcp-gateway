import { fromJsonSchema, ProtocolError, ProtocolErrorCode } from '@modelcontextprotocol/server';

export const SKILLS_EXTENSION_ID = 'io.modelcontextprotocol/skills';
export const SKILLS_TTL_MS = 30_000;
const PAGE_SIZE = 50;

const emptyObjectSchema = fromJsonSchema({
  type: 'object',
  properties: {
    cursor: { type: 'string' },
    _meta: { type: 'object' }
  },
  additionalProperties: true
});

const getSkillParamsSchema = fromJsonSchema({
  type: 'object',
  properties: {
    uri: { type: 'string', minLength: 1 },
    _meta: { type: 'object' }
  },
  required: ['uri'],
  additionalProperties: true
});

function encodeCursor(offset) {
  return Buffer.from(JSON.stringify({ offset }), 'utf8').toString('base64url');
}

function decodeCursor(cursor) {
  if (!cursor) return 0;
  try {
    const parsed = JSON.parse(Buffer.from(String(cursor), 'base64url').toString('utf8'));
    if (!Number.isInteger(parsed.offset) || parsed.offset < 0) throw new Error('invalid offset');
    return parsed.offset;
  } catch {
    throw new ProtocolError(ProtocolErrorCode.InvalidParams, 'Invalid skills/list cursor.');
  }
}

function skillEntry(skill) {
  return {
    uri: skill.uri,
    frontmatter: skill.frontmatter,
    resources: skill.resources
  };
}

export function registerSkillsExtension(server, registry) {
  server.registerCapabilities({
    resources: {},
    extensions: {
      [SKILLS_EXTENSION_ID]: {}
    }
  });

  server.setRequestHandler(
    'skills/list',
    { params: emptyObjectSchema },
    async params => {
      const snapshot = registry.snapshot();
      const offset = decodeCursor(params?.cursor);
      if (offset > snapshot.skills.length) {
        throw new ProtocolError(ProtocolErrorCode.InvalidParams, 'Invalid skills/list cursor.');
      }
      const page = snapshot.skills.slice(offset, offset + PAGE_SIZE);
      const nextOffset = offset + page.length;
      return {
        resultType: 'complete',
        skills: page.map(skillEntry),
        ...(nextOffset < snapshot.skills.length ? { nextCursor: encodeCursor(nextOffset) } : {}),
        ttlMs: SKILLS_TTL_MS,
        cacheScope: 'public'
      };
    }
  );

  server.setRequestHandler(
    'skills/get',
    { params: getSkillParamsSchema },
    async params => {
      const skill = registry.getByUri(params.uri);
      if (!skill) {
        throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Unknown skill URI: ${params.uri}`);
      }
      return {
        resultType: 'complete',
        skill: skillEntry(skill),
        ttlMs: SKILLS_TTL_MS,
        cacheScope: 'public'
      };
    }
  );
}
