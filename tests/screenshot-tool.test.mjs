import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { screenshotTool } from '../scripts/custom-tools/screenshots-tool.mjs';

test('custom_screenshot rejects file mode because local image reading is separate', async () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'screenshot-repo-'));
  const result = await screenshotTool(
    { mode: 'file', path: path.join(repoRoot, 'sample.png'), embed: true },
    { resolvedRepoRoots: [repoRoot], resolvedRepoRoot: repoRoot }
  );

  const payload = JSON.parse(result.content[0].text);
  assert.equal(payload.ok, false);
  assert.equal(payload.tool, 'custom_screenshot');
  assert.equal(payload.error.code, 'UNKNOWN_MODE');
});

test('custom_screenshot cleanup reports no files when preview directory is absent', async () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'screenshot-cleanup-'));
  const result = await screenshotTool(
    { mode: 'cleanup' },
    { resolvedRepoRoots: [repoRoot], resolvedRepoRoot: repoRoot }
  );

  const payload = JSON.parse(result.content[0].text);
  assert.equal(payload.ok, true);
  assert.equal(payload.tool, 'custom_screenshot');
  assert.equal(payload.data.removed, 0);
});
