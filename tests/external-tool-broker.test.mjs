import test from 'node:test';
import assert from 'node:assert/strict';

import { createExternalToolBroker } from '../scripts/external-tool-broker.mjs';
import { RUNTIME_PROFILES } from '../scripts/runtime-profile.mjs';

const READ = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
const WRITE = { readOnlyHint: false, destructiveHint: true, openWorldHint: false };

function tool(name, server, description, inputSchema, annotations = undefined) {
  return {
    name,
    description,
    inputSchema,
    ...(annotations ? { annotations } : {}),
    _meta: { upstream: { upstreamId: server, source: 'external-mcp' } }
  };
}

function fixture() {
  const tools = [
    tool('github_create_issue', 'github', 'Create an issue in a repository.', {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
        title: { type: 'string' },
        body: { type: 'string' }
      },
      required: ['owner', 'repo', 'title'],
      additionalProperties: false
    }, WRITE),
    tool('github_get_issue', 'github', 'Read one issue from a repository.', {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
        number: { type: 'integer', minimum: 1 }
      },
      required: ['owner', 'repo', 'number'],
      additionalProperties: false
    }, READ),
    tool('linear_get_issue', 'linear', 'Read an issue from Linear.', {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
      additionalProperties: false
    }, READ),
    tool('unknown_publish', 'unknown', 'Publish data through an unannotated tool.', {
      type: 'object',
      properties: { value: { type: 'string' } },
      required: ['value'],
      additionalProperties: false
    })
  ];
  const calls = [];
  const broker = createExternalToolBroker({
    getTools: () => tools,
    invokeTool: async (name, args) => {
      calls.push({ name, args });
      return { content: [{ type: 'text', text: `${name}:${JSON.stringify(args)}` }] };
    }
  });
  return { broker, calls };
}

test('search ranks exact name first and returns only bounded public metadata', () => {
  const { broker } = fixture();
  const result = broker.search({ query: 'github_create_issue', limit: 10 }, RUNTIME_PROFILES.assisted);
  assert.equal(result.items[0].name, 'github_create_issue');
  assert.deepEqual(result.items[0], {
    name: 'github_create_issue',
    description: 'Create an issue in a repository.',
    lane: 'write',
    server: 'github',
    inputSummary: ['owner', 'repo', 'title', 'body']
  });
  assert.equal(result.nextCursor, null);
  assert.equal('inputSchema' in result.items[0], false);
  assert.equal('_meta' in result.items[0], false);
});

test('search supports token scoring, server and lane filters, pagination, and stable ordering', () => {
  const { broker } = fixture();
  const first = broker.search({ query: 'issue', lane: 'read', limit: 1 }, RUNTIME_PROFILES.yolo);
  assert.deepEqual(first.items.map(item => item.name), ['github_get_issue']);
  assert.equal(typeof first.nextCursor, 'string');

  const second = broker.search({ query: 'issue', lane: 'read', limit: 1, cursor: first.nextCursor }, RUNTIME_PROFILES.yolo);
  assert.deepEqual(second.items.map(item => item.name), ['linear_get_issue']);
  assert.equal(second.nextCursor, null);

  const github = broker.search({ server: 'github', lane: 'read', limit: 10 }, RUNTIME_PROFILES.yolo);
  assert.deepEqual(github.items.map(item => item.name), ['github_get_issue']);
  assert.throws(
    () => broker.search({ query: 'different', lane: 'read', limit: 1, cursor: first.nextCursor }, RUNTIME_PROFILES.yolo),
    /cursor/i
  );
});

test('search applies runtime profile before exposing results', () => {
  const { broker } = fixture();
  assert.deepEqual(
    broker.search({ limit: 20 }, RUNTIME_PROFILES.safe).items.map(item => item.name),
    ['github_get_issue', 'linear_get_issue']
  );
  assert.deepEqual(
    broker.search({ limit: 20 }, RUNTIME_PROFILES.assisted).items.map(item => item.name),
    ['github_create_issue', 'github_get_issue', 'linear_get_issue']
  );
  assert.deepEqual(
    broker.search({ limit: 20 }, RUNTIME_PROFILES.yolo).items.map(item => item.name),
    ['github_create_issue', 'github_get_issue', 'linear_get_issue', 'unknown_publish']
  );
});

test('read call validates full cached schema before forwarding and rejects wrong lane', async () => {
  const { broker, calls } = fixture();
  await assert.rejects(
    () => broker.call('read', { name: 'github_get_issue', arguments: { owner: 'o', repo: 'r', number: 0 } }, RUNTIME_PROFILES.safe),
    /Invalid arguments.*github_get_issue/i
  );
  assert.equal(calls.length, 0);

  await assert.rejects(
    () => broker.call('read', { name: 'github_create_issue', arguments: { owner: 'o', repo: 'r', title: 't' } }, RUNTIME_PROFILES.assisted),
    /write lane/i
  );
  assert.equal(calls.length, 0);

  const result = await broker.call('read', { name: 'github_get_issue', arguments: { owner: 'o', repo: 'r', number: 1 } }, RUNTIME_PROFILES.safe);
  assert.match(result.content[0].text, /github_get_issue/);
  assert.deepEqual(calls, [{ name: 'github_get_issue', args: { owner: 'o', repo: 'r', number: 1 } }]);
});

test('write call preserves underlying runtime risk and conservative unknown annotations', async () => {
  const { broker, calls } = fixture();
  const closedWorldWrite = await broker.call('write', {
    name: 'github_create_issue',
    arguments: { owner: 'o', repo: 'r', title: 't' }
  }, RUNTIME_PROFILES.assisted);
  assert.match(closedWorldWrite.content[0].text, /github_create_issue/);

  await assert.rejects(
    () => broker.call('write', { name: 'unknown_publish', arguments: { value: 'x' } }, RUNTIME_PROFILES.assisted),
    /MCP_RUNTIME_PROFILE=assisted/i
  );
  assert.equal(calls.length, 1);

  await broker.call('write', { name: 'unknown_publish', arguments: { value: 'x' } }, RUNTIME_PROFILES.yolo);
  assert.equal(calls.length, 2);
});
