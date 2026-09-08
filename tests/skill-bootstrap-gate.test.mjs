import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SKILL_CHECK_ADVISORY,
  SKILL_TOOL_BOOTSTRAP_NOTICE,
  buildSkillCallerKey,
  createSkillBootstrapGate,
  decorateSkillBootstrapDescription
} from '../scripts/skill-bootstrap-gate.mjs';
import { SKILL_AGENT_INSTRUCTIONS } from '../scripts/skills/index.mjs';

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

test('local changing tool descriptions describe optional skill disclosure', () => {
  assert.match(SKILL_TOOL_BOOTSTRAP_NOTICE, /get_skill\(name\)/i);
  assert.match(SKILL_TOOL_BOOTSTRAP_NOTICE, /materially changes the task approach/i);
  assert.match(decorateSkillBootstrapDescription('write_file', 'Write a file.'), /^For specialized workflows/);
  assert.match(decorateSkillBootstrapDescription('shell_execute', 'Run a command.'), /get_skill\(name\)/i);
  assert.equal(decorateSkillBootstrapDescription('read_text_file', 'Read a file.'), 'Read a file.');
  assert.equal(decorateSkillBootstrapDescription('external_create_file', 'Create remotely.'), 'Create remotely.');
});

test('server instructions make skill loading task-relevant rather than a mutation prerequisite', () => {
  assert.match(SKILL_AGENT_INSTRUCTIONS, /materially change the work/i);
  assert.doesNotMatch(SKILL_AGENT_INSTRUCTIONS, /Before first use of local write_file/i);
  assert.doesNotMatch(SKILL_AGENT_INSTRUCTIONS, /satisfies bootstrap/i);
});

test('a successful skill load suppresses further read advice for the caller', () => {
  const gate = createSkillBootstrapGate({ ttlMs: 1_000, now: () => 1_000 });

  gate.markSkillLoaded('caller-a');

  assert.equal(gate.takeReadAdvisory('caller-a', 'read_text_file'), null);
});

test('skill disclosure state expires and starts a fresh advisory cycle', () => {
  const time = clock();
  const gate = createSkillBootstrapGate({ ttlMs: 100, now: time.now });

  gate.markSkillLoaded('caller-a');

  time.advance(101);
  assert.equal(gate.takeReadAdvisory('caller-a', 'read_text_file'), SKILL_CHECK_ADVISORY);
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
