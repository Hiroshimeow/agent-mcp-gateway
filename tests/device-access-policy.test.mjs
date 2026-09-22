import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { callerAuditId, createDeviceAccessPolicy, DeviceAccessError } from '../scripts/device-access-policy.mjs';
import { createDeviceAuditRecorder } from '../scripts/device-audit.mjs';

function policy(rule = {}) {
  return createDeviceAccessPolicy({
    raw: JSON.stringify({
      rules: [{
        id: 'test-rule',
        callers: ['oauth:client-a'],
        devices: ['device'],
        tools: ['read_text_file', 'write_file', 'image_preview', 'shell_execute', 'read_process_output'],
        roots: ['E:\\work\\project'],
        requests_per_minute: 5,
        max_input_bytes: 2048,
        max_output_bytes: 4096,
        ...rule
      }]
    })
  });
}

test('safe and assisted device access remain deny-by-default without an explicit rule', () => {
  for (const profile of ['safe', 'assisted']) {
    const access = createDeviceAccessPolicy({ profile });
    assert.throws(() => access.authorize({
      callerSubject: 'static-bearer', callerCategory: 'static-bearer', deviceId: 'device-a', tool: 'read_text_file', arguments: { path: 'C:\\work\\file.txt' }
    }), error => error instanceof DeviceAccessError && error.code === 'DEVICE_ACCESS_DENIED');
  }
});

test('yolo device access trusts authenticated callers and enrolled device capabilities without gateway root allowlists', () => {
  const access = createDeviceAccessPolicy({ profile: 'yolo' });
  const devices = [
    { deviceId: 'device-a', capabilities: ['read_text_file', 'shell_execute'] },
    { deviceId: 'device-b', capabilities: ['write_file'] }
  ];

  assert.deepEqual(access.filterDevices(devices, {
    callerSubject: 'oauth:client-a', callerCategory: 'oauth'
  }), devices);

  const grant = access.authorize({
    callerSubject: 'oauth:client-a', callerCategory: 'oauth', deviceId: 'device-a', tool: 'read_text_file',
    arguments: { path: 'D:\\shared\\outside-any-repo\\file.txt' }
  });
  assert.equal(grant.ruleId, 'yolo-authenticated-device');
  assert.doesNotThrow(() => access.authorize({
    callerSubject: 'static-bearer', callerCategory: 'static-bearer', deviceId: 'device-a', tool: 'shell_execute',
    arguments: { command: 'node -v', working_directory: 'C:\\Users\\Public' }
  }));

  assert.throws(() => access.authorize({
    callerSubject: 'anonymous', callerCategory: 'anonymous', deviceId: 'device-a', tool: 'read_text_file', arguments: { path: 'C:\\work\\file.txt' }
  }), error => error instanceof DeviceAccessError && error.code === 'DEVICE_ACCESS_DENIED');
  assert.deepEqual(access.filterDevices(devices, { callerSubject: 'anonymous', callerCategory: 'anonymous' }), []);
});

test('caller, device, tool, and remote root must all match', () => {
  const access = policy();
  const grant = access.authorize({
    callerSubject: 'oauth:client-a', callerCategory: 'oauth', deviceId: 'device', tool: 'read_text_file', arguments: { path: 'E:\\work\\project\\src\\a.txt' }
  });
  assert.equal(grant.ruleId, 'test-rule');
  assert.throws(() => access.authorize({
    callerSubject: 'oauth:client-b', callerCategory: 'oauth', deviceId: 'device', tool: 'read_text_file', arguments: { path: 'E:\\work\\project\\src\\a.txt' }
  }), /not authorized/);
  assert.throws(() => access.authorize({
    callerSubject: 'oauth:client-a', callerCategory: 'oauth', deviceId: 'g8', tool: 'read_text_file', arguments: { path: 'E:\\work\\project\\src\\a.txt' }
  }), /not authorized/);
  assert.throws(() => access.authorize({
    callerSubject: 'oauth:client-a', callerCategory: 'oauth', deviceId: 'device', tool: 'edit_file', arguments: { path: 'E:\\work\\project\\src\\a.txt' }
  }), /not authorized/);
  assert.throws(() => access.authorize({
    callerSubject: 'oauth:client-a', callerCategory: 'oauth', deviceId: 'device', tool: 'read_text_file', arguments: { path: 'E:\\work\\other\\secret.txt' }
  }), error => error.code === 'DEVICE_PATH_DENIED');
});

test('device inventory is filtered by caller and advertised capabilities', () => {
  const access = policy();
  const devices = [
    { deviceId: 'device', capabilities: ['read_text_file', 'shell_execute'] },
    { deviceId: 'g8', capabilities: ['read_text_file'] },
    { deviceId: 'device', capabilities: ['unknown_tool'] }
  ];
  const visible = access.filterDevices(devices, {
    callerSubject: 'oauth:client-a', callerCategory: 'oauth'
  });
  assert.equal(visible.length, 1);
  assert.equal(visible[0].deviceId, 'device');
  assert.deepEqual(access.filterDevices(devices, {
    callerSubject: 'oauth:client-b', callerCategory: 'oauth'
  }), []);
});

test('remote image preview obeys the same safe-profile path root as filesystem tools', () => {
  const access = policy();
  assert.doesNotThrow(() => access.authorize({
    callerSubject: 'oauth:client-a', callerCategory: 'oauth', deviceId: 'device', tool: 'image_preview', arguments: { path: 'E:\\work\\project\\assets\\preview.png' }
  }));
  assert.doesNotThrow(() => access.authorize({
    callerSubject: 'oauth:client-a', callerCategory: 'oauth', deviceId: 'device', tool: 'image_preview', arguments: { file: 'E:\\work\\project\\assets\\preview.png' }
  }));
  assert.throws(() => access.authorize({
    callerSubject: 'oauth:client-a', callerCategory: 'oauth', deviceId: 'device', tool: 'image_preview', arguments: { sourcePath: 'E:\\work\\other\\preview.png' }
  }), error => error.code === 'DEVICE_PATH_DENIED');
});

test('remote project inspection obeys the same safe-profile project root', () => {
  const access = policy({ tools: ['project_inspect'], roots: ['E:\\work\\project'] });
  assert.doesNotThrow(() => access.authorize({
    callerSubject: 'oauth:client-a', callerCategory: 'oauth', deviceId: 'device', tool: 'project_inspect',
    arguments: { path: 'E:\\work\\project', project_id: 'fixture', view: 'summary' }
  }));
  assert.throws(() => access.authorize({
    callerSubject: 'oauth:client-a', callerCategory: 'oauth', deviceId: 'device', tool: 'project_inspect',
    arguments: { path: 'E:\\work\\other', project_id: 'fixture', view: 'summary' }
  }), error => error.code === 'DEVICE_PATH_DENIED');
});

test('remote shell requires an explicitly allowed working directory', () => {
  const access = policy();
  assert.throws(() => access.authorize({
    callerSubject: 'oauth:client-a', callerCategory: 'oauth', deviceId: 'device', tool: 'shell_execute', arguments: { command: 'node -v' }
  }), error => error.code === 'DEVICE_PATH_DENIED');
  assert.doesNotThrow(() => access.authorize({
    callerSubject: 'oauth:client-a', callerCategory: 'oauth', deviceId: 'device', tool: 'shell_execute', arguments: { command: 'node -v', working_directory: 'E:\\work\\project' }
  }));
});

test('rate and size bounds are enforced before and after dispatch', () => {
  let now = 1000;
  const access = createDeviceAccessPolicy({
    now: () => now,
    raw: JSON.stringify({ rules: [{
      callers: ['static-bearer'], devices: ['dev'], tools: ['read_process_output'],
      requests_per_minute: 2, max_input_bytes: 64, max_output_bytes: 80
    }] })
  });
  const request = () => access.authorize({
    callerSubject: 'static-bearer', callerCategory: 'static-bearer', deviceId: 'dev', tool: 'read_process_output', arguments: { session_id: 'r1' }
  });
  const first = request();
  request();
  assert.throws(request, error => error.code === 'DEVICE_RATE_LIMIT');
  now += 60_001;
  assert.doesNotThrow(request);
  assert.throws(() => access.authorize({
    callerSubject: 'static-bearer', callerCategory: 'static-bearer', deviceId: 'dev', tool: 'read_process_output', arguments: { session_id: 'x'.repeat(100) }
  }), error => error.code === 'DEVICE_INPUT_TOO_LARGE');
  assert.equal(access.assertOutput(first, { ok: true }), Buffer.byteLength(JSON.stringify({ ok: true })));
  assert.throws(() => access.assertOutput(first, { data: 'x'.repeat(100) }), error => error.code === 'DEVICE_OUTPUT_TOO_LARGE');
});

test('device audit stores metadata only and hashes caller identity', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'device-audit-'));
  const auditPath = path.join(root, 'audit.jsonl');
  const recorder = createDeviceAuditRecorder({ auditPath });
  recorder.record({
    requestId: 'req-1', callerId: callerAuditId('oauth:client-a'), callerCategory: 'oauth',
    deviceId: 'device', tool: 'shell_execute', outcome: 'success', durationMs: 12,
    inputBytes: 33, outputBytes: 44
  });
  recorder.close();
  const text = fs.readFileSync(auditPath, 'utf8');
  const entry = JSON.parse(text.trim());
  assert.equal(entry.tool, 'shell_execute');
  assert.equal(entry.callerId.length, 16);
  assert.equal(text.includes('oauth:client-a'), false);
  assert.equal(text.includes('authorization'), false);
  fs.rmSync(root, { recursive: true, force: true });
});

test('device lifecycle audit survives disabled tool-call audit and stores only forensic metadata', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'device-lifecycle-audit-'));
  const auditPath = path.join(root, 'audit.jsonl');
  const recorder = createDeviceAuditRecorder({ auditPath, enabled: false });
  recorder.record({
    requestId: 'ignored', callerId: 'ignored', callerCategory: 'oauth', deviceId: 'device',
    tool: 'shell_execute', outcome: 'success', durationMs: 1, inputBytes: 2, outputBytes: 3
  });
  recorder.recordEvent({
    event: 'device_forgotten', callerId: 'account-secret-id', callerCategory: 'dashboard',
    deviceId: 'device', details: { deviceName: 'Laptop', packageVersion: '1.0.5' }
  });
  recorder.close();

  const lines = fs.readFileSync(auditPath, 'utf8').trim().split(/\r?\n/);
  assert.equal(lines.length, 1);
  const entry = JSON.parse(lines[0]);
  assert.equal(entry.type, 'device_event');
  assert.equal(entry.event, 'device_forgotten');
  assert.equal(entry.deviceId, 'device');
  assert.equal(entry.callerId.length, 16);
  assert.equal(lines[0].includes('account-secret-id'), false);
  assert.equal(lines[0].includes('public_key'), false);
  fs.rmSync(root, { recursive: true, force: true });
});
