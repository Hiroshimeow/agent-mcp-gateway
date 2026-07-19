import fs from 'node:fs';
import path from 'node:path';

const fileCache = new Map();

const DEFAULT_GATEWAY_FLOW_CONFIG = {
  tool_surface: {
    mode: 'core'
  },
  zero_interruption: {
    enabled: false,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false
    },
    preserve_idempotentHint: true,
    description_rewrites: { enabled: true }
  },
  context_optimization: {
    description_token_cap: 100,
    strip_repetitive_root_guidance: true,
    tool_registry_cache: true,
    routing_cache: true,
    rules_cache: true
  },
  search: {
    default_limit: 50,
    max_limit: 50,
    preview_chars: 150,
    mandatory_excludes: ['node_modules/**', '.git/**', 'dist/**', 'build/**', 'logs/**', 'packages/**', '_zip_temp/**']
  },
  file_read: {
    default_max_lines: 500,
    max_lines: 500,
    preview_chars: 150
  },
  list_directory: {
    default_max_depth: 1,
    max_entries: 200,
    hide_dot_folders: true,
    hide_binary_files: true
  },
  git: {
    diff_max_bytes: 60000,
    diff_stat_on_large_output: true
  }
};

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function mergeObject(base, overlay) {
  if (!overlay || typeof overlay !== 'object' || Array.isArray(overlay)) return cloneJson(base);
  const result = cloneJson(base);
  for (const [key, value] of Object.entries(overlay)) {
    if (value && typeof value === 'object' && !Array.isArray(value) && result[key] && typeof result[key] === 'object' && !Array.isArray(result[key])) {
      result[key] = mergeObject(result[key], value);
    } else {
      result[key] = value;
    }
  }
  return result;
}

function parseScalar(value) {
  const text = String(value ?? '').trim();
  if (text === '') return undefined;
  if (text === 'true') return true;
  if (text === 'false') return false;
  if (/^-?\d+(?:\.\d+)?$/.test(text)) return Number(text);
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
    return text.slice(1, -1);
  }
  return text;
}

function stripInlineComment(line) {
  let quote = '';
  for (let index = 0; index < line.length; index += 1) {
    const ch = line[index];
    if ((ch === '"' || ch === "'") && line[index - 1] !== '\\') {
      quote = quote === ch ? '' : quote || ch;
    }
    if (ch === '#' && !quote) return line.slice(0, index);
  }
  return line;
}

function prepareYamlLines(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map(raw => stripInlineComment(raw).replace(/\s+$/, ''))
    .filter(raw => raw.trim())
    .map(raw => ({ indent: raw.match(/^ */)?.[0].length || 0, text: raw.trim() }));
}

function parseSimpleYaml(text) {
  const lines = prepareYamlLines(text);
  const root = {};
  const stack = [{ indent: -1, value: root }];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    while (stack.length > 1 && line.indent <= stack[stack.length - 1].indent) stack.pop();
    const parent = stack[stack.length - 1].value;

    if (line.text.startsWith('- ')) {
      if (!Array.isArray(parent)) throw new Error(`YAML list item has no array parent near: ${line.text}`);
      parent.push(parseScalar(line.text.slice(2)));
      continue;
    }

    const match = line.text.match(/^([^:]+):(.*)$/);
    if (!match) throw new Error(`Unsupported YAML line: ${line.text}`);
    const key = match[1].trim();
    const rawValue = match[2].trim();
    if (rawValue) {
      parent[key] = parseScalar(rawValue);
      continue;
    }

    const next = lines.slice(index + 1).find(candidate => candidate.indent > line.indent);
    const child = next?.text.startsWith('- ') ? [] : {};
    parent[key] = child;
    stack.push({ indent: line.indent, value: child });
  }

  return root;
}

function cachedFileRecord(filePath) {
  const absolutePath = path.resolve(filePath);
  const stat = fs.statSync(absolutePath);
  const cached = fileCache.get(absolutePath);
  if (cached && cached.mtimeMs === stat.mtimeMs) return cached;
  const text = fs.readFileSync(absolutePath, 'utf8');
  const record = { absolutePath, mtimeMs: stat.mtimeMs, text, json: undefined, flowConfig: undefined };
  fileCache.set(absolutePath, record);
  return record;
}

export function resolveGatewayFlowConfigPath({ env = process.env, repoRoot = process.cwd() } = {}) {
  const explicit = String(env.MCP_GATEWAY_FLOW_CONFIG || '').trim().replace(/^['"]|['"]$/g, '');
  if (explicit) return path.isAbsolute(explicit) ? path.resolve(explicit) : path.resolve(repoRoot, explicit);
  return path.resolve(repoRoot, 'config/gateway-flow.yaml');
}

export function loadGatewayFlowConfig({ env = process.env, repoRoot = process.cwd() } = {}) {
  const configPath = resolveGatewayFlowConfigPath({ env, repoRoot });
  if (!fs.existsSync(configPath)) {
    return { ...cloneJson(DEFAULT_GATEWAY_FLOW_CONFIG), _meta: { configPath, mtimeMs: 0, exists: false } };
  }
  const record = cachedFileRecord(configPath);
  if (!record.flowConfig) {
    record.flowConfig = mergeObject(DEFAULT_GATEWAY_FLOW_CONFIG, parseSimpleYaml(record.text));
    record.flowConfig._meta = { configPath: record.absolutePath, mtimeMs: record.mtimeMs, exists: true };
  }
  return record.flowConfig;
}

export function readCachedTextFile(filePath) {
  return cachedFileRecord(filePath).text;
}

export function readCachedJsonFile(filePath, fallback = {}) {
  try {
    const record = cachedFileRecord(filePath);
    if (record.json === undefined) record.json = JSON.parse(record.text);
    return record.json;
  } catch {
    return fallback;
  }
}

export function getFlowCacheStats() {
  return {
    files: fileCache.size,
    paths: [...fileCache.keys()]
  };
}
