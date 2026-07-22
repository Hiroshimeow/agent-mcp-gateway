import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SKILL_BOOTSTRAP_CODE,
  SKILL_CHECK_ADVISORY,
  SKILL_TOOL_BOOTSTRAP_NOTICE,
  buildSkillCallerKey,
  createSkillBootstrapGate,
  decorateSkillBootstrapDescription
} from '../scripts/skill-bootstrap-gate.mjs';

function clock(start = 1_000) {
  let now = start;
  return {
    now: () => now,
    advance: milliseconds => { now += milliseconds; }
  };
}

test('read advisory is emitted once per caller until TTL expiry', () => {
  const time = clock();
  const gate = createSkillBootstrapGate({ ttlMs: 100, now: time.now });

  assert.equal(gate.takeReadAdvisory('caller-a', 'read_text_file'), SKILL_CHECK_ADVISORY);
  assert.equal(gate.takeReadAdvisory('caller-a', 'read_text_file'), null);
  assert.equal(gate.takeReadAdvisory('caller-a', 'image_preview'), null);
  assert.equal(gate.takeReadAdvisory('caller-b', 'read_text_file'), SKILL_CHECK_ADVISORY);

  time.advance(101);
  assert.equal(gate.takeReadAdvisory('caller-a', 'read_text_file'), SKILL_CHECK_ADVISORY);
});

test('local changing tool descriptions expose the bootstrap precondition before use', () => {
  assert.match(SKILL_TOOL_BOOTSTRAP_NOTICE, /call get_skill without arguments/i);
  assert.match(decorateSkillBootstrapDescription('write_file', 'Write a file.'), /^Before first use of this local changing tool/);
  assert.match(decorateSkillBootstrapDescription('shell_execute', 'Run a command.'), /inspect its routingPolicy and skillCatalog/i);
  assert.equal(decorateSkillBootstrapDescription('read_text_file', 'Read a file.'), 'Read a file.');
  assert.equal(decorateSkillBootstrapDescription('external_create_file', 'Create remotely.'), 'Create remotely.');
});

test('local changing tools receive one full block then a short repeated block', () => {
  const gate = createSkillBootstrapGate({ ttlMs: 1_000, now: () => 1_000 });

  const first = gate.checkTool('caller-a', 'edit_file');
  assert.equal(first?.code, SKILL_BOOTSTRAP_CODE);
  assert.match(first?.message || '', /before the first local write_file, edit_file, or shell_execute operation/i);

  const repeated = gate.checkTool('caller-a', 'write_file');
  assert.equal(repeated?.code, SKILL_BOOTSTRAP_CODE);
  assert.equal(repeated?.message, 'Call get_skill().');

  assert.equal(gate.checkTool('caller-a', 'read_text_file'), null);
  assert.equal(gate.checkTool('caller-a', 'image_preview'), null);
  assert.equal(gate.checkTool('caller-a', 'get_skill'), null);
  assert.equal(gate.checkTool('caller-a', 'external_create_file'), null);
});

test('a successful skill load unlocks the caller without repeated prompting', () => {
  const gate = createSkillBootstrapGate({ ttlMs: 1_000, now: () => 1_000 });

  assert.ok(gate.checkTool('caller-a', 'shell_execute'));
  gate.markBootstrapped('caller-a');

  assert.equal(gate.checkTool('caller-a', 'shell_execute'), null);
  assert.equal(gate.checkTool('caller-a', 'edit_file'), null);
  assert.equal(gate.takeReadAdvisory('caller-a', 'read_text_file'), null);
});

test('bootstrap state expires and starts a fresh advisory/block cycle', () => {
  const time = clock();
  const gate = createSkillBootstrapGate({ ttlMs: 100, now: time.now });

  gate.markBootstrapped('caller-a');
  assert.equal(gate.checkTool('caller-a', 'write_file'), null);

  time.advance(101);
  assert.equal(gate.takeReadAdvisory('caller-a', 'read_text_file'), SKILL_CHECK_ADVISORY);
  assert.match(gate.checkTool('caller-a', 'write_file')?.message || '', /before the first local write_file, edit_file, or shell_execute operation/i);
});

test('caller key follows verified client identity instead of rotating access tokens', () => {
  const first = buildSkillCallerKey({ oauthClientId: 'chatgpt-client' });
  const refreshed = buildSkillCallerKey({ oauthClientId: 'chatgpt-client' });

  assert.equal(first, refreshed);
  assert.notEqual(first, buildSkillCallerKey({ oauthClientId: 'other-client' }));
  assert.doesNotMatch(first, /chatgpt-client/);
  assert.match(first, /^caller:[0-9a-f]{24}$/);
});

test('static bearer requests share one stable non-secret identity', () => {
  const first = buildSkillCallerKey({ staticBearer: true });
  const second = buildSkillCallerKey({ staticBearer: true });

  assert.equal(first, second);
  assert.notEqual(first, buildSkillCallerKey());
});
