import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRuntimeProfileStatus, getRuntimeProfile } from '../scripts/runtime-profile.mjs';
import { shouldExposeToolForProfile } from '../scripts/tool-risk.mjs';

test('runtime profile defaults to yolo', () => {
  assert.equal(getRuntimeProfile({}).name, 'yolo');
});

test('runtime profile parses configured modes', () => {
  assert.equal(getRuntimeProfile({ MCP_RUNTIME_PROFILE: 'safe' }).name, 'safe');
  assert.equal(getRuntimeProfile({ MCP_RUNTIME_PROFILE: 'assisted' }).name, 'assisted');
  assert.equal(getRuntimeProfile({ MCP_RUNTIME_PROFILE: 'yolo' }).name, 'yolo');
});

test('legacy SHELL_PROFILE remains a compatibility alias', () => {
  assert.equal(getRuntimeProfile({ SHELL_PROFILE: 'safe' }).name, 'safe');
  assert.equal(getRuntimeProfile({ MCP_RUNTIME_PROFILE: 'assisted', SHELL_PROFILE: 'safe' }).name, 'assisted');
});

test('unknown profile falls back to private yolo default', () => {
  assert.equal(getRuntimeProfile({ MCP_RUNTIME_PROFILE: 'wat' }).name, 'yolo');
});

test('profile exposure rules match configured modes', () => {
  const safe = getRuntimeProfile({ MCP_RUNTIME_PROFILE: 'safe' });
  const assisted = getRuntimeProfile({ MCP_RUNTIME_PROFILE: 'assisted' });
  const yolo = getRuntimeProfile({ MCP_RUNTIME_PROFILE: 'yolo' });
  assert.equal(shouldExposeToolForProfile('custom_read_text_file', safe), true);
  assert.equal(shouldExposeToolForProfile('custom_delete_file', safe), false);
  assert.equal(shouldExposeToolForProfile('custom_delete_file', assisted), true);
  assert.equal(shouldExposeToolForProfile('custom_git_push', assisted), false);
  assert.equal(shouldExposeToolForProfile('custom_shell_execute', assisted), false);
  assert.equal(shouldExposeToolForProfile('custom_shell_execute', yolo), true);
  assert.equal(shouldExposeToolForProfile('custom_git_push', yolo), true);
});

test('status returns flags only', () => {
  const status = buildRuntimeProfileStatus({ MCP_RUNTIME_PROFILE: 'yolo' });
  assert.equal(status.profile, 'yolo');
  assert.equal(status.shellEnabled, true);
  assert.equal(Object.hasOwn(status, 'warnings'), false);
  assert.equal(Object.hasOwn(status, 'hostSafetyNotice'), false);
});
