import test from 'node:test';
import assert from 'node:assert/strict';

import { loadSurfaceConfig } from '../scripts/surface-config.mjs';

test('surface config defaults to agent behavior', () => {
  assert.deepEqual(loadSurfaceConfig({}, {}), {
    mode: 'agent',
    enumerateProjectResources: false,
    enumerateSkillResources: false,
    exposeResourceTemplates: false,
    exposePrompts: true
  });
});

test('surface config maps agent and native modes to fixed exposure policies', () => {
  assert.deepEqual(loadSurfaceConfig({ surface: { mode: 'agent' } }, {}), {
    mode: 'agent',
    enumerateProjectResources: false,
    enumerateSkillResources: false,
    exposeResourceTemplates: false,
    exposePrompts: true
  });
  assert.deepEqual(loadSurfaceConfig({ surface: { mode: 'native' } }, {}), {
    mode: 'native',
    enumerateProjectResources: false,
    enumerateSkillResources: false,
    exposeResourceTemplates: true,
    exposePrompts: true
  });
});

test('MCP_SURFACE_MODE overrides TOML without client capability guessing', () => {
  const config = loadSurfaceConfig({ surface: { mode: 'legacy' } }, { MCP_SURFACE_MODE: 'agent' });
  assert.equal(config.mode, 'agent');
  assert.equal(config.enumerateProjectResources, false);
  assert.equal(config.exposeResourceTemplates, false);
});

test('surface config rejects unknown modes from TOML or environment', () => {
  assert.throws(() => loadSurfaceConfig({ surface: { mode: 'auto' } }, {}), /surface\.mode/);
  assert.throws(() => loadSurfaceConfig({}, { MCP_SURFACE_MODE: 'auto' }), /MCP_SURFACE_MODE/);
});
