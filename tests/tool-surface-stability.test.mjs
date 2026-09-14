import test from 'node:test';
import assert from 'node:assert/strict';

import {
  LOCAL_COLLISION_TOOL_NAMES,
  stableToolDefinition,
  workspaceCatalogChanges
} from '../scripts/tool-surface-stability.mjs';
import { loadSurfaceConfig } from '../scripts/surface-config.mjs';

const FORBIDDEN_DYNAMIC_META = ['trusted_roots', 'root_repo', 'repo_root'];

test('stableToolDefinition removes dynamic root metadata without changing schemas or static metadata', () => {
  const input = {
    name: 'read_text_file',
    description: 'Read a file.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
    _meta: {
      trusted_roots: ['C:/repo-a', 'D:/repo-b'],
      root_repo: 'C:/repo-a',
      repo_root: 'C:/repo-a',
      static_flag: 'keep-me'
    }
  };

  const stable = stableToolDefinition(input);
  assert.equal(stable.name, input.name);
  assert.deepEqual(stable.inputSchema, input.inputSchema);
  assert.equal(stable._meta.static_flag, 'keep-me');
  for (const key of FORBIDDEN_DYNAMIC_META) assert.equal(stable._meta[key], undefined);
  assert.deepEqual(input._meta.trusted_roots, ['C:/repo-a', 'D:/repo-b']);
});

test('stable local collision names include project tools and all execution primitives', () => {
  for (const name of [
    'read_text_file', 'write_file', 'edit_file', 'shell_execute',
    'image_preview', 'get_skill', 'project_list', 'project_inspect', 'list_devices',
    'start_process', 'read_process_output', 'interact_with_process', 'terminate_process'
  ]) {
    assert.equal(LOCAL_COLLISION_TOOL_NAMES.has(name), true, `missing collision name: ${name}`);
  }
});

test('root/project changes never invalidate tools and only invalidate enumerated legacy resources', () => {
  const legacy = loadSurfaceConfig({ surface: { mode: 'legacy' } }, {});
  const agent = loadSurfaceConfig({ surface: { mode: 'agent' } }, {});
  const native = loadSurfaceConfig({ surface: { mode: 'native' } }, {});

  assert.deepEqual(workspaceCatalogChanges({ rootsChanged: true }, legacy), {
    toolsChanged: false,
    resourcesChanged: true,
    promptsChanged: false
  });
  for (const surface of [agent, native]) {
    assert.deepEqual(workspaceCatalogChanges({ rootsChanged: true }, surface), {
      toolsChanged: false,
      resourcesChanged: false,
      promptsChanged: false
    });
  }
  assert.deepEqual(workspaceCatalogChanges({ rootsChanged: false }, legacy), {
    toolsChanged: false,
    resourcesChanged: false,
    promptsChanged: false
  });
});
