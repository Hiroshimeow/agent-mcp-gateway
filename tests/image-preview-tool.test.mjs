import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { imagePreviewTool } from '../scripts/custom-tools/image-preview-tool.mjs';
import { createWorkspaceRegistry } from '../scripts/workspace-registry.mjs';

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

function payload(result) {
  return JSON.parse(result.content[0].text);
}

test('image_preview returns MCP image content only inside live trusted roots', async () => {
  const previewRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'image-preview-'));
  const file = path.join(previewRoot, 'sample.png');
  fs.writeFileSync(file, SAMPLE_PNG);

  const result = await imagePreviewTool(
    { path: file, embed: true },
    { resolvedRepoRoots: [previewRoot], resolvedRepoRoot: previewRoot }
  );

  assert.equal(result.content.length, 2);
  assert.equal(payload(result).ok, true);
  assert.equal(payload(result).data.root, path.resolve(previewRoot));
  assert.equal(result.content[1].type, 'image');
  assert.equal(result.content[1].mimeType, 'image/png');
});

test('image_preview can return metadata only', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'image-preview-meta-'));
  const file = path.join(root, 'sample.png');
  fs.writeFileSync(file, SAMPLE_PNG);

  const result = await imagePreviewTool(
    { path: file, embed: false },
    { resolvedRepoRoots: [root], resolvedRepoRoot: root }
  );

  assert.equal(result.content.length, 1);
  assert.equal(payload(result).ok, true);
  assert.equal(payload(result).data.embedded, false);
});

test('environment image roots and home media folders do not independently grant access', async () => {
  const trustedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'image-trusted-'));
  const envRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'image-env-only-'));
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'image-home-'));
  const downloads = path.join(fakeHome, 'Downloads');
  fs.mkdirSync(downloads);
  const envFile = path.join(envRoot, 'env.png');
  const homeFile = path.join(downloads, 'home.png');
  fs.writeFileSync(envFile, SAMPLE_PNG);
  fs.writeFileSync(homeFile, SAMPLE_PNG);

  const previous = {
    MCP_IMAGE_PREVIEW_ROOTS: process.env.MCP_IMAGE_PREVIEW_ROOTS,
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE
  };
  process.env.MCP_IMAGE_PREVIEW_ROOTS = envRoot;
  process.env.HOME = fakeHome;
  process.env.USERPROFILE = fakeHome;
  try {
    for (const file of [envFile, homeFile]) {
      const result = await imagePreviewTool(
        { path: file },
        { resolvedRepoRoots: [trustedRoot], resolvedRepoRoot: trustedRoot }
      );
      assert.equal(payload(result).ok, false);
      assert.equal(payload(result).error.code, 'PATH_OUT_OF_SCOPE');
    }
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('image_preview canonicalizes a directory link and TOML revocation removes access', async t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'image-link-'));
  const targetRoot = path.join(temp, 'target');
  const replacementRoot = path.join(temp, 'replacement');
  const linkRoot = path.join(temp, 'linked');
  fs.mkdirSync(targetRoot);
  fs.mkdirSync(replacementRoot);
  const targetFile = path.join(targetRoot, 'sample.png');
  fs.writeFileSync(targetFile, SAMPLE_PNG);
  try {
    fs.symlinkSync(targetRoot, linkRoot, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    t.skip(`directory links unavailable: ${error.message}`);
    return;
  }

  const configPath = path.join(temp, 'mcp-servers.toml');
  fs.writeFileSync(configPath, `[trusted_roots]\nroots = ["${targetRoot.replaceAll('\\', '/')}"]\n`, 'utf8');
  const registry = createWorkspaceRegistry({ configPath, repoRoot: replacementRoot, watchIntervalMs: 25 });
  const linkedFile = path.join(linkRoot, 'sample.png');
  try {
    const allowed = await imagePreviewTool(
      { path: linkedFile, embed: false },
      { resolvedRepoRoots: registry.snapshot().roots, resolvedRepoRoot: registry.snapshot().roots[0] }
    );
    assert.equal(payload(allowed).ok, true);
    assert.equal(payload(allowed).data.path, path.resolve(targetFile));

    fs.writeFileSync(configPath, `[trusted_roots]\nroots = ["${replacementRoot.replaceAll('\\', '/')}"]\n`, 'utf8');
    await registry.reloadFromDisk('revoke-image');
    const denied = await imagePreviewTool(
      { path: linkedFile, embed: false },
      { resolvedRepoRoots: registry.snapshot().roots, resolvedRepoRoot: registry.snapshot().roots[0] }
    );
    assert.equal(payload(denied).ok, false);
    assert.equal(payload(denied).error.code, 'PATH_OUT_OF_SCOPE');
  } finally {
    registry.close();
  }
});
