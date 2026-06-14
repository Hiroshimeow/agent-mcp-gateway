import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

import { fail } from './response-utils.mjs';
import { resolveInsideTrustedRoots } from './path-utils.mjs';

const TOOL = 'screenshot';
const IMAGE_EXT = new Map([
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp']
]);
const BROWSERS = ['chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable', 'chrome'];
let browserPathPromise = null;

function numberInRange(value, fallback, min, max) {
  const n = Number(value ?? fallback);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function bool(value, fallback) {
  if (value === undefined || value === null) return fallback;
  return Boolean(value);
}

async function exists(filePath) {
  try {
    await fs.promises.access(filePath, fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

async function findBrowser() {
  if (browserPathPromise) return await browserPathPromise;
  browserPathPromise = (async () => {
  for (const name of BROWSERS) {
    const found = await new Promise(resolve => {
      const child = spawn('sh', ['-lc', `command -v ${name}`], { stdio: ['ignore', 'pipe', 'ignore'] });
      let out = '';
      child.stdout.on('data', chunk => { out += chunk; });
      child.on('close', code => resolve(code === 0 ? out.trim() : ''));
      child.on('error', () => resolve(''));
    });
    if (found) return found;
  }
  return '';
  })();
  return await browserPathPromise;
}

function runBrowser(command, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      const error = new Error(`browser timed out after ${timeoutMs}ms`);
      error.code = 'BROWSER_TIMEOUT';
      reject(error);
    }, timeoutMs);
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', error => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', code => {
      clearTimeout(timer);
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        const error = new Error(stderr.trim() || stdout.trim() || `browser exited with ${code}`);
        error.code = 'BROWSER_FAILED';
        error.details = { code, stdout: stdout.slice(-2000), stderr: stderr.slice(-2000) };
        reject(error);
      }
    });
  });
}

async function makeOutputPath(context, args) {
  const base = path.resolve(context.resolvedRepoRoot || context.packageRoot || process.cwd(), 'logs', 'screenshots');
  await fs.promises.mkdir(base, { recursive: true });
  if (args.outputPath) {
    const checked = resolveInsideTrustedRoots(args.outputPath, context);
    await fs.promises.mkdir(path.dirname(checked.path), { recursive: true });
    return checked.path;
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return path.join(base, `${stamp}-${process.pid}.png`);
}

async function imageContent(filePath, includeImage) {
  const stat = await fs.promises.stat(filePath);
  const ext = path.extname(filePath).toLowerCase();
  const mimeType = IMAGE_EXT.get(ext) || 'image/png';
  const meta = { path: filePath, bytes: stat.size, mimeType };
  if (!includeImage) return { meta, image: null };
  const data = await fs.promises.readFile(filePath, 'base64');
  return { meta, image: { type: 'image', data, mimeType } };
}

async function captureUrl(args, context) {
  if (!args.url || typeof args.url !== 'string') {
    return fail(TOOL, 'URL_REQUIRED', 'url is required.');
  }
  const browser = await findBrowser();
  if (!browser) {
    return fail(TOOL, 'BROWSER_NOT_FOUND', 'No browser command was found.', { candidates: BROWSERS });
  }
  const width = numberInRange(args.width, 1365, 320, 3840);
  const height = numberInRange(args.height, 768, 240, 2160);
  const timeoutMs = numberInRange(args.timeoutMs, 30000, 1000, 120000);
  const outputPath = await makeOutputPath(context, args);
  await runBrowser(browser, [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--hide-scrollbars',
    `--window-size=${width},${height}`,
    `--screenshot=${outputPath}`,
    args.url
  ], timeoutMs);
  const { meta, image } = await imageContent(outputPath, bool(args.embed ?? args.includeImage, false));
  return {
    content: [
      { type: 'text', text: JSON.stringify({ ok: true, tool: 'custom_screenshot', summary: 'Saved PNG preview.', data: { ...meta, source: 'url', url: args.url, width, height } }, null, 2) },
      ...(image ? [image] : [])
    ]
  };
}

async function readImageFile(args, context) {
  const input = args.path || args.file;
  if (!input || typeof input !== 'string') {
    return fail(TOOL, 'PATH_REQUIRED', 'path is required.');
  }
  const checked = resolveInsideTrustedRoots(input, context, { mustExist: true });
  const ext = path.extname(checked.path).toLowerCase();
  if (!IMAGE_EXT.has(ext)) {
    return fail(TOOL, 'UNSUPPORTED_FILE', 'Supported files: png, jpg, jpeg, webp.', { path: checked.path });
  }
  const { meta, image } = await imageContent(checked.path, bool(args.embed ?? args.includeImage, false));
  return {
    content: [
      { type: 'text', text: JSON.stringify({ ok: true, tool: 'custom_screenshot', summary: 'Loaded PNG file.', data: { ...meta, source: 'file' } }, null, 2) },
      ...(image ? [image] : [])
    ]
  };
}

async function cleanup(args, context) {
  const base = path.resolve(context.resolvedRepoRoot || context.packageRoot || process.cwd(), 'logs', 'screenshots');
  if (!(await exists(base))) {
    return { content: [{ type: 'text', text: JSON.stringify({ ok: true, tool: 'custom_screenshot', summary: 'No files found.', data: { removed: 0, path: base } }, null, 2) }] };
  }
  const maxAgeMs = numberInRange(args.maxAgeMs, 86400000, 0, 30 * 86400000);
  const cutoff = Date.now() - maxAgeMs;
  let removed = 0;
  for (const entry of await fs.promises.readdir(base)) {
    const filePath = path.join(base, entry);
    const stat = await fs.promises.stat(filePath);
    if (stat.isFile() && stat.mtimeMs < cutoff) {
      await fs.promises.unlink(filePath);
      removed += 1;
    }
  }
  return { content: [{ type: 'text', text: JSON.stringify({ ok: true, tool: 'custom_screenshot', summary: 'Cleaned files.', data: { removed, path: base } }, null, 2) }] };
}

export async function screenshotTool(args = {}, context = {}) {
  const mode = String(args.mode || (args.url ? 'url' : args.path || args.file ? 'file' : 'url')).toLowerCase();
  try {
    if (mode === 'url') return await captureUrl(args, context);
    if (mode === 'file') return await readImageFile(args, context);
    if (mode === 'cleanup') return await cleanup(args, context);
    return fail(TOOL, 'UNKNOWN_MODE', `Unknown mode: ${mode}`);
  } catch (error) {
    return fail(TOOL, error.code || 'SCREENSHOT_FAILED', error.message, error.details || {});
  }
}
