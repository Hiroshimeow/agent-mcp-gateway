import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createMcpHandler, Server } from '@modelcontextprotocol/server';
import { createSkillRegistry } from '../scripts/skills/index.mjs';
import { registerSkillsExtension } from '../scripts/skills/mcp-adapter.mjs';
import { readRepoResource } from '../scripts/resources/index.mjs';

function rootWithSkills(count = 1) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-skills-adapter-'));
  for (let index = 0; index < count; index += 1) {
    const name = count === 1 ? 'probe' : `probe-${String(index).padStart(2, '0')}`;
    const dir = path.join(root, name);
    fs.mkdirSync(path.join(dir, 'references'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'assets'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: Probe skill ${index}.\nmetadata:\n  index: "${index}"\n---\n\n# Probe\n\nBody ${index}.\n`);
    fs.writeFileSync(path.join(dir, 'references', 'note.md'), `note-${index}\n`);
    fs.writeFileSync(path.join(dir, 'assets', 'pixel.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, index & 0xff]));
  }
  return root;
}

function modernRequest(method, params = {}, id = 1) {
  const body = {
    jsonrpc: '2.0',
    id,
    method,
    params: {
      ...params,
      _meta: {
        'io.modelcontextprotocol/protocolVersion': '2026-07-28',
        'io.modelcontextprotocol/clientInfo': { name: 'adapter-test', version: '1.0.0' },
        'io.modelcontextprotocol/clientCapabilities': {}
      }
    }
  };
  const headers = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    'mcp-protocol-version': '2026-07-28',
    'mcp-method': method
  };
  if (params.uri) headers['mcp-name'] = params.uri;
  return new Request('http://localhost/mcp', { method: 'POST', headers, body: JSON.stringify(body) });
}

function handlerFor(registry) {
  return createMcpHandler(ctx => {
    const server = new Server(
      { name: 'skills-test', version: '1.0.0' },
      { capabilities: { resources: {} } }
    );
    if (ctx.era === 'modern') registerSkillsExtension(server, registry);
    server.setRequestHandler('resources/read', async request =>
      readRepoResource(request.params.uri, { skillRegistry: registry }));
    return server;
  }, { legacy: 'reject' });
}

async function rpc(handler, method, params = {}, id = 1) {
  const response = await handler.fetch(modernRequest(method, params, id));
  assert.equal(response.status, 200);
  return JSON.parse(await response.text());
}

test('2026 discover advertises resources and the official skills extension', async () => {
  const handler = handlerFor(createSkillRegistry({ directory: rootWithSkills() }));
  const message = await rpc(handler, 'server/discover');
  assert.ok(message.result.supportedVersions.includes('2026-07-28'));
  assert.ok(message.result.capabilities.resources);
  assert.deepEqual(message.result.capabilities.extensions['io.modelcontextprotocol/skills'], {});
});

test('skills/list returns stable entries, full frontmatter, complete manifest, cache hints, pagination, and no body', async () => {
  const handler = handlerFor(createSkillRegistry({ directory: rootWithSkills(51) }));
  const first = (await rpc(handler, 'skills/list')).result;
  assert.equal(first.resultType, 'complete');
  assert.equal(first.skills.length, 50);
  assert.equal(first.ttlMs, 30000);
  assert.equal(first.cacheScope, 'public');
  assert.equal(typeof first.nextCursor, 'string');
  assert.equal(first.skills[0].body, undefined);
  assert.equal(first.skills[0].frontmatter.metadata.index, '0');
  assert.equal(first.skills[0].resources.length, 3);

  const second = (await rpc(handler, 'skills/list', { cursor: first.nextCursor }, 2)).result;
  assert.equal(second.skills.length, 1);
  assert.equal(second.nextCursor, undefined);
});

test('skills/get returns one point-in-time entry and unknown URIs use invalid-params semantics', async () => {
  const handler = handlerFor(createSkillRegistry({ directory: rootWithSkills() }));
  const known = (await rpc(handler, 'skills/get', { uri: 'skill://skills/probe/SKILL.md' })).result;
  assert.equal(known.resultType, 'complete');
  assert.equal(known.skill.uri, 'skill://skills/probe/SKILL.md');
  assert.equal(known.skill.body, undefined);
  assert.equal(known.skill.resources.length, 3);

  const unknown = await rpc(handler, 'skills/get', { uri: 'skill://skills/missing/SKILL.md' }, 2);
  assert.equal(unknown.error.code, -32602);
});

test('resources/read serves exact SKILL.md text, text references, and binary assets', async () => {
  const handler = handlerFor(createSkillRegistry({ directory: rootWithSkills() }));
  const skill = (await rpc(handler, 'resources/read', { uri: 'skill://skills/probe/SKILL.md' })).result;
  assert.equal(skill.resultType, 'complete');
  assert.equal(skill.ttlMs, 30000);
  assert.equal(skill.cacheScope, 'public');
  assert.match(skill.contents[0].text, /name: probe/);
  assert.equal(skill.contents[0].mimeType, 'text/markdown');

  const text = (await rpc(handler, 'resources/read', { uri: 'skill://skills/probe/references/note.md' }, 2)).result;
  assert.equal(text.contents[0].text, 'note-0\n');

  const binary = (await rpc(handler, 'resources/read', { uri: 'skill://skills/probe/assets/pixel.png' }, 3)).result;
  assert.equal(binary.contents[0].mimeType, 'image/png');
  assert.equal(binary.contents[0].blob, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0]).toString('base64'));
});

test('adapter does not implement optional directory reads or invented list-changed notifications', async () => {
  const handler = handlerFor(createSkillRegistry({ directory: rootWithSkills() }));
  const response = await handler.fetch(modernRequest('resources/directory/read', {}, 1));
  assert.equal(response.status, 404);
  const source = fs.readFileSync(new URL('../scripts/skills/mcp-adapter.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /notifications\/skills\/list_changed/);
});
