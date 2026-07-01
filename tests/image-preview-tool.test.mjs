import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { imagePreviewTool } from '../scripts/custom-tools/image-preview-tool.mjs';

const SAMPLE_PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
  0x08, 0x04, 0x00, 0x00, 0x00, 0xb5, 0x1c, 0x0c,
  0x02, 0x00, 0x00, 0x00, 0x0b, 0x49, 0x44, 0x41,
  0x54, 0x78, 0xda, 0x63, 0xfc, 0xff, 0x1f, 0x00,
  0x03, 0x03, 0x02, 0x00, 0xef, 0xbf, 0xa7, 0xdb,
  0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44,
  0xae, 0x42, 0x60, 0x82
]);

test('custom_image_preview returns MCP image content from image preview roots', async () => {
  const previewRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'image-preview-'));
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'image-repo-'));
  const file = path.join(previewRoot, 'sample.png');
  fs.writeFileSync(file, SAMPLE_PNG);

  const previous = process.env.MCP_IMAGE_PREVIEW_ROOTS;
  process.env.MCP_IMAGE_PREVIEW_ROOTS = previewRoot;
  try {
    const result = await imagePreviewTool(
      { path: file, embed: true },
      { resolvedRepoRoots: [repoRoot], resolvedRepoRoot: repoRoot }
    );

    assert.equal(result.content.length, 2);
    const payload = JSON.parse(result.content[0].text);
    assert.equal(payload.ok, true);
    assert.equal(payload.tool, 'custom_image_preview');
    assert.equal(payload.data.source, 'file');
    assert.equal(payload.data.embedded, true);
    assert.equal(payload.data.root, path.resolve(previewRoot));
    assert.equal(result.content[1].type, 'image');
    assert.equal(result.content[1].mimeType, 'image/png');
    assert.ok(result.content[1].data.length > 0);
  } finally {
    if (previous === undefined) delete process.env.MCP_IMAGE_PREVIEW_ROOTS;
    else process.env.MCP_IMAGE_PREVIEW_ROOTS = previous;
  }
});

test('custom_image_preview can return metadata only', async () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'image-preview-meta-'));
  const file = path.join(repoRoot, 'sample.png');
  fs.writeFileSync(file, SAMPLE_PNG);

  const result = await imagePreviewTool(
    { path: file, embed: false },
    { resolvedRepoRoots: [repoRoot], resolvedRepoRoot: repoRoot }
  );

  assert.equal(result.content.length, 1);
  const payload = JSON.parse(result.content[0].text);
  assert.equal(payload.ok, true);
  assert.equal(payload.data.source, 'file');
  assert.equal(payload.data.embedded, false);
});
