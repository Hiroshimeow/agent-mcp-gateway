import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSafetyProfileStatus, getSafetyProfile } from '../scripts/safety-profile.mjs';
import { shouldExposeToolForProfile } from '../scripts/tool-risk.mjs';

test('safety profile defaults to yolo', () => {
  assert.equal(getSafetyProfile({}).name, 'yolo');
});

test('safety profile parses safe assisted and yolo', () => {
  assert.equal(getSafetyProfile({ MCP_SAFETY_PROFILE: 'safe' }).name, 'safe');
  assert.equal(getSafetyProfile({ MCP_SAFETY_PROFILE: 'assisted' }).name, 'assisted');
  assert.equal(getSafetyProfile({ MCP_SAFETY_PROFILE: 'yolo' }).name, 'yolo');
});

test('legacy SHELL_PROFILE remains a compatibility alias', () => {
  assert.equal(getSafetyProfile({ SHELL_PROFILE: 'safe' }).name, 'safe');
  assert.equal(getSafetyProfile({ MCP_SAFETY_PROFILE: 'assisted', SHELL_PROFILE: 'safe' }).name, 'assisted');
});

test('unknown profile falls back to private yolo default', () => {
  assert.equal(getSafetyProfile({ MCP_SAFETY_PROFILE: 'wat' }).name, 'yolo');
});

test('profile exposure rules match yolo product direction', () => {
  const safe = getSafetyProfile({ MCP_SAFETY_PROFILE: 'safe' });
  const assisted = getSafetyProfile({ MCP_SAFETY_PROFILE: 'assisted' });
  const yolo = getSafetyProfile({ MCP_SAFETY_PROFILE: 'yolo' });
  assert.equal(shouldExposeToolForProfile('custom_read_text_file', safe), true);
  assert.equal(shouldExposeToolForProfile('custom_delete_file', safe), false);
  assert.equal(shouldExposeToolForProfile('custom_delete_file', assisted), true);
  assert.equal(shouldExposeToolForProfile('custom_git_push', assisted), false);
  assert.equal(shouldExposeToolForProfile('custom_shell_execute', assisted), false);
  assert.equal(shouldExposeToolForProfile('custom_shell_execute', yolo), true);
  assert.equal(shouldExposeToolForProfile('custom_git_push', yolo), true);
});

test('status includes host safety caveat', () => {
  const status = buildSafetyProfileStatus({ MCP_SAFETY_PROFILE: 'yolo' });
  assert.equal(status.profile, 'yolo');
  assert.equal(status.shellEnabled, true);
  assert.match(status.hostSafetyNotice, /does not bypass ChatGPT host safety/);
});
