import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createExternalMcpManager } from '../scripts/upstreams/manager.mjs';
import { toExternalResourceUri } from '../scripts/upstreams/resource-uri.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fakeServer = path.join(root, 'tests/fixtures/fake-mcp-server.mjs');

async function tempConfig(text) {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'mcp-upstream-'));
  const file = path.join(dir, 'mcp-servers.toml');
  await fs.promises.writeFile(file, text);
  return file;
}

test('manager imports and routes fake stdio upstream', async () => {
  const configPath = await tempConfig(`
[mcp_servers.fake]
transport = "stdio"
command = "${process.execPath.replaceAll('\\', '\\\\')}"
args = ["${fakeServer.replaceAll('\\', '\\\\')}"]
`);
  const manager = await createExternalMcpManager({ repoRoot: root, env: { MCP_UPSTREAM_CONFIG: configPath } });
  try {
    const toolNames = manager.listAllToolsUnfiltered().map(tool => tool.name);
    assert.ok(toolNames.includes('custom_fake_read_context'));
    assert.ok(toolNames.includes('custom_fake_write_context'));
    assert.ok(toolNames.includes('custom_fake_push_context'));
    assert.ok(toolNames.includes('custom_fake_unknown_context'));
    const call = await manager.callTool('custom_fake_read_context', { a: 1 });
    assert.match(call.content[0].text, /called:read_context/);
    const uri = toExternalResourceUri('fake', 'fake://context/main');
    const resource = await manager.readResource(uri);
    assert.equal(resource.contents[0].uri, uri);
    assert.match(resource.contents[0].text, /resource:fake:\/\/context\/main/);
    const prompt = await manager.getPrompt('external_fake_review_context', { topic: 'x' });
    assert.match(prompt.messages[0].content.text, /prompt:review_context:x/);
    const diag = await manager.readResource('external-mcp://_diagnostics/status');
    assert.match(diag.contents[0].text, /"fake"/);
  } finally {
    await manager.shutdown();
  }
});

test('failed optional upstream does not throw and exposes diagnostics', async () => {
  const configPath = await tempConfig(`
[mcp_servers.bad]
transport = "stdio"
command = "definitely-not-a-real-command-for-mcp"
`);
  const manager = await createExternalMcpManager({ repoRoot: root, env: { MCP_UPSTREAM_CONFIG: configPath } });
  try {
    const diag = await manager.readResource('external-mcp://bad/status');
    const data = JSON.parse(diag.contents[0].text);
    assert.equal(data.available, false);
    assert.match(data.lastError, /not.*found|ENOENT|spawn/i);
  } finally {
    await manager.shutdown();
  }
});
