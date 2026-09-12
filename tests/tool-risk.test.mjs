import test from 'node:test';
import assert from 'node:assert/strict';

import { applyToolRisk, getToolRisk, shouldExposeToolForProfile } from '../scripts/tool-risk.mjs';

const safe = { name: 'safe', exposeShell: false, exposeDestructiveTools: false, exposeOpenWorldTools: false };
const yolo = { name: 'yolo', exposeShell: true, exposeDestructiveTools: true, exposeOpenWorldTools: true };

test('retained read tools are read-only', () => {
  for (const name of ['read_text_file', 'image_preview', 'get_skill', 'list_devices']) {
    const risk = getToolRisk(name);
    assert.equal(risk.readOnlyHint, true);
    assert.equal(risk.destructiveHint, false);
    assert.equal(risk.openWorldHint, false);
  }
});

test('retained file writes are destructive but not open-world', () => {
  for (const name of ['write_file', 'edit_file']) {
    const risk = getToolRisk(name);
    assert.equal(risk.readOnlyHint, false);
    assert.equal(risk.destructiveHint, true);
    assert.equal(risk.openWorldHint, false);
  }
});

test('shell and process execution stay behind shell profile visibility', () => {
  for (const name of ['shell_execute', 'start_process', 'read_process_output', 'interact_with_process', 'terminate_process']) {
    assert.equal(shouldExposeToolForProfile(name, safe), false);
    assert.equal(shouldExposeToolForProfile(name, yolo), true);
  }

  const shell = getToolRisk('shell_execute');
  assert.equal(shell.destructiveHint, true);
  assert.equal(shell.openWorldHint, true);
  assert.equal(getToolRisk('read_process_output').readOnlyHint, true);
  for (const name of ['start_process', 'interact_with_process', 'terminate_process']) {
    const risk = getToolRisk(name);
    assert.equal(risk.destructiveHint, true);
    assert.equal(risk.openWorldHint, true);
  }
});

test('applyToolRisk preserves description and applies core annotations', () => {
  const tool = applyToolRisk({ name: 'image_preview', description: 'Preview', annotations: { readOnlyHint: false } });
  assert.equal(tool.description, 'Preview');
  assert.equal(tool.annotations.readOnlyHint, true);
  assert.equal(tool._meta.category, 'filesystem');
});
