import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const wrapper = fs.readFileSync(new URL('../scripts/authenticated-mcp-wrapper.mjs', import.meta.url), 'utf8');
const customTools = fs.readFileSync(new URL('../scripts/custom-tools/index.mjs', import.meta.url), 'utf8');

test('gateway execution surface requires explicit device routing and has no local execution fallback', () => {
  assert.match(wrapper, /required:\s*\['command',\s*'working_directory',\s*'device_id'\]/);
  assert.match(wrapper, /required:\s*\['command',\s*'working_directory',\s*'device_id'\]/);
  assert.match(wrapper, /function requireDeviceId\(/);
  assert.match(wrapper, /DEVICE_ID_REQUIRED/);

  for (const deadLocalPrimitive of [
    "from '@modelcontextprotocol/sdk/client/stdio.js'",
    "from './direct-shell.mjs'",
    "from './process-session-manager.mjs'",
    'filesystemClient',
    'filesystemTransport',
    'executeDirectShell',
    'processSessions.start',
    'processSessions.read',
    'processSessions.interact',
    'processSessions.terminate',
    'workspaceRegistry.ensureTrustedPath'
  ]) {
    assert.doesNotMatch(wrapper, new RegExp(deadLocalPrimitive.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});

test('dead gateway-host execution modules are removed from the runtime tree', () => {
  for (const relativePath of [
    '../scripts/direct-shell.mjs',
    '../scripts/process-session-manager.mjs',
    '../scripts/shell-policy.mjs',
    '../scripts/custom-tools/image-preview-tool.mjs',
    '../config/shell.mcp.json'
  ]) {
    assert.equal(fs.existsSync(new URL(relativePath, import.meta.url)), false, `${relativePath} must not remain as a hidden host executor`);
  }
});

test('image_preview is device-routed at the public contract', () => {
  assert.match(customTools, /name:\s*'image_preview'[\s\S]*device_id:[\s\S]*\},\s*\['device_id'\]\)/);
  assert.doesNotMatch(customTools, /handler:\s*imagePreviewTool/);
});
