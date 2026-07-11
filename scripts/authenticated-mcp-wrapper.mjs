import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { getOAuthProtectedResourceMetadataUrl, mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  isInitializeRequest,
  ListPromptsRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListResourcesRequestSchema,
  ListRootsRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema
} from '@modelcontextprotocol/sdk/types.js';
import { executeDirectShell } from './direct-shell.mjs';
import { getRuntimeProfile } from './runtime-profile.mjs';
import { applyToolRisk, assertToolAllowedForProfile, shouldExposeToolForProfile } from './tool-risk.mjs';
import { listRepoResources, listRepoResourceTemplates, readRepoResource } from './resources/index.mjs';
import { getRepoPrompt, listRepoPrompts } from './prompts/index.mjs';
import { createExternalMcpManager } from './upstreams/manager.mjs';
import { normalizeExternalMcpConfig } from './upstreams/config.mjs';
import { isExternalResourceUri } from './upstreams/resource-uri.mjs';
import { buildShellExecuteAnnotations, buildShellExecuteDescription } from './shell-tool-descriptor.mjs';
import { callCustomTool, isLocalCustomTool, listCustomTools } from './custom-tools/index.mjs';
import {
  FileBackedAuthState,
  PasswordProtectedAuthProvider,
  isStaticBearerAuthorization,
  shouldCreateTransportForRequest,
  shouldUseStatefulSessionTransport
} from './auth-session.mjs';
import { validateShellCommand } from './shell-policy.mjs';
import { findUnifiedMcpConfigPath } from './projects/trusted-roots-projects.mjs';
import {
  classifyWorkspaceChange,
  createWorkspaceRegistry,
  isAbsoluteWorkspacePath,
  isPathInsideWorkspace,
  normalizeWorkspacePath,
  toFilesystemRootUri
} from './workspace-registry.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = process.env.REPO_ROOT;
const gatewayPort = Number(process.env.MCP_GATEWAY_PORT || '8101');
const gatewayHost = String(process.env.MCP_GATEWAY_HOST || '127.0.0.1').trim() || '127.0.0.1';
const advertisedHost = String(process.env.MCP_ADVERTISE_HOST || '').trim() || (gatewayHost === '0.0.0.0' ? '127.0.0.1' : gatewayHost);
const advertisedUrl = String(process.env.MCP_ADVERTISE_URL || '').trim();
const fallbackBaseUrl = `http://${advertisedHost}:${gatewayPort}`;
const authPassword = process.env.MCP_AUTH_PASSWORD;
const staticBearerToken = process.env.MCP_BEARER_TOKEN;
const runtimeProfile = getRuntimeProfile(process.env);
const filesystemLogPath = process.env.FILESYSTEM_LOG_PATH;
const authStatePath = process.env.AUTH_STATE_PATH;
const useStatefulMcpSessions = shouldUseStatefulSessionTransport(process.env.MCP_STATEFUL_SESSIONS);
const enableFilesystem = String(process.env.ENABLE_FILESYSTEM || 'true').toLowerCase() === 'true';
const enableShell = String(process.env.ENABLE_SHELL || 'true').toLowerCase() === 'true';
const debugAuth = envFlag(process.env.MCP_DEBUG_AUTH, false);
const slowToolThresholdMs = normalizeDurationMs(process.env.MCP_SLOW_TOOL_MS, 5000);
const filesystemEntrypointPath = fileURLToPath(
  new URL('../node_modules/@modelcontextprotocol/server-filesystem/dist/index.js', import.meta.url)
);
const FILESYSTEM_TOOL_NAMES = new Set(['read_text_file', 'write_file', 'edit_file']);
const CORE_TOOL_NAMES = new Set(['read_text_file', 'write_file', 'edit_file', 'shell_execute', 'image_preview', 'get_skill']);
const activeProxyServers = new Set();

if (!repoRoot) throw new Error('REPO_ROOT is required');
if (!authPassword) throw new Error('MCP_AUTH_PASSWORD is required');
if (!enableFilesystem && !enableShell) throw new Error('At least one local execution primitive must be enabled');

function envFlag(value, defaultValue = false) {
  const text = String(value ?? '').trim().toLowerCase();
  if (!text) return defaultValue;
  if (['1', 'true', 'yes', 'y', 'on'].includes(text)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(text)) return false;
  return defaultValue;
}

function normalizeDurationMs(value, defaultValue) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : defaultValue;
}

const configPath = findUnifiedMcpConfigPath(process.env, packageRoot);
if (!configPath) throw new Error('config/mcp-servers.toml is required');
const workspaceRegistry = createWorkspaceRegistry({
  configPath,
  repoRoot: packageRoot,
  env: process.env
});

function workspaceSnapshot() {
  return workspaceRegistry.snapshot();
}

function currentRoots() {
  return workspaceSnapshot().roots;
}

function currentRoot() {
  return currentRoots()[0] || path.resolve(repoRoot);
}

function appendStderrToLog(transport, logPath) {
  if (!logPath || !transport.stderr) return;
  const stderrLog = fs.createWriteStream(logPath, { flags: 'a' });
  transport.stderr.pipe(stderrLog);
}

function createClient(name, version, transport, capabilities = {}) {
  return new Client({ name, version }, { capabilities });
}

function createFilesystemTransport() {
  const transport = new StdioClientTransport({
    command: 'node',
    args: [filesystemEntrypointPath],
    cwd: currentRoot(),
    stderr: 'pipe'
  });
  appendStderrToLog(transport, filesystemLogPath);
  return transport;
}

const filesystemTransport = enableFilesystem ? createFilesystemTransport() : null;
const filesystemClient = filesystemTransport
  ? createClient('personal-mcp-launcher-filesystem', '2.0.0', filesystemTransport, { roots: { listChanged: true } })
  : null;

if (filesystemClient) {
  filesystemClient.setRequestHandler(ListRootsRequestSchema, async () => ({
    roots: currentRoots().map(root => ({
      uri: toFilesystemRootUri(root),
      name: path.basename(root) || root
    }))
  }));
  await filesystemClient.connect(filesystemTransport);
  await activateFilesystemRoots();
}

function textFromToolResult(result) {
  return (result?.content || []).filter(item => item?.type === 'text').map(item => item.text || '').join('\n');
}

async function waitForFilesystemRoots(expectedRoots = currentRoots(), timeoutMs = 3000) {
  if (!filesystemClient) return;
  const deadline = Date.now() + timeoutMs;
  let lastText = '';
  while (Date.now() <= deadline) {
    const result = await filesystemClient.callTool({ name: 'list_allowed_directories', arguments: {} });
    lastText = textFromToolResult(result);
    const activeLines = lastText.split(/\r?\n/).slice(1).filter(Boolean).map(value => normalizeWorkspacePath(value));
    const exactRoots = activeLines.length === expectedRoots.length && expectedRoots.every(root =>
      activeLines.some(active => isPathInsideWorkspace(active, root) && isPathInsideWorkspace(root, active))
    );
    if (exactRoots) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`Filesystem root activation timed out. Expected: ${expectedRoots.join('; ')}. Reported: ${lastText}`);
}

async function activateFilesystemRoots() {
  if (!filesystemClient) return;
  await filesystemClient.sendRootsListChanged();
  await waitForFilesystemRoots(currentRoots());
}

async function broadcastCatalogChanges(changes = {}) {
  const tasks = [];
  for (const server of activeProxyServers) {
    if (changes.toolsChanged) tasks.push(server.sendToolListChanged().catch(() => {}));
    if (changes.resourcesChanged) tasks.push(server.sendResourceListChanged().catch(() => {}));
    if (changes.promptsChanged) tasks.push(server.sendPromptListChanged().catch(() => {}));
  }
  await Promise.all(tasks);
}

function localToolNamesForCollisionCheck() {
  return [...CORE_TOOL_NAMES];
}

const externalMcpManager = await createExternalMcpManager({
  env: process.env,
  repoRoot: packageRoot,
  localToolNames: localToolNamesForCollisionCheck(),
  localPromptNames: listRepoPrompts({ runtimeProfile }).map(prompt => prompt.name),
  onCatalogChanged: async changes => {
    await broadcastCatalogChanges(changes);
  }
});

workspaceRegistry.subscribe(async (next, previous) => {
  const { rootsChanged, upstreamChanged } = classifyWorkspaceChange(next, previous);
  if (rootsChanged) {
    await activateFilesystemRoots();
    await broadcastCatalogChanges({ toolsChanged: true, resourcesChanged: true });
  }
  if (upstreamChanged) {
    const nextExternalConfig = normalizeExternalMcpConfig(next.rawConfig, {
      configPath,
      repoRoot: packageRoot,
      env: process.env
    });
    try {
      await externalMcpManager.reconcile(nextExternalConfig);
    } catch (error) {
      console.error(`[external-mcp] reconcile failed; keeping committed topology: ${error.message}`);
    }
  }
});

const shellExecuteSchema = {
  type: 'object',
  properties: {
    command: { type: 'string', description: 'The system instruction to execute in the verified environment.' },
    working_directory: { type: 'string', description: 'The target workspace for execution.' }
  },
  required: ['command'],
  additionalProperties: false
};

function customToolContext() {
  const snapshot = workspaceSnapshot();
  return {
    resolvedRepoRoots: snapshot.roots,
    resolvedRepoRoot: snapshot.roots[0],
    projectRegistry: snapshot.projectRegistry,
    executeDirectShell,
    packageRoot,
    env: process.env
  };
}

function filesystemToolMeta(tool) {
  const roots = currentRoots();
  return applyToolRisk({
    ...tool,
    name: tool.name,
    _meta: {
      ...(tool._meta || {}),
      trusted_roots: roots,
      root_repo: roots[0],
      repo_root: roots[0]
    }
  });
}

async function listMergedTools() {
  const tools = [];
  if (filesystemClient) {
    const result = await filesystemClient.listTools();
    tools.push(...(result.tools || []).filter(tool => FILESYSTEM_TOOL_NAMES.has(tool.name)).map(filesystemToolMeta));
  }
  tools.push(...listCustomTools(customToolContext()));
  if (enableShell) {
    const roots = currentRoots();
    tools.push(applyToolRisk({
      name: 'shell_execute',
      description: buildShellExecuteDescription(`Trusted roots: ${roots.join('; ')}`),
      inputSchema: shellExecuteSchema,
      _meta: { trusted_roots: roots, root_repo: roots[0], repo_root: roots[0] },
      annotations: buildShellExecuteAnnotations()
    }));
  }
  tools.push(...await externalMcpManager.listAllToolsUnfiltered());
  return tools.filter(tool => shouldExposeToolForProfile(tool, runtimeProfile));
}

async function ensureFileTarget(args = {}) {
  const target = args.path;
  if (target && isAbsoluteWorkspacePath(target)) await workspaceRegistry.ensureTrustedPath(target, 'file');
}

async function ensureImageTarget(args = {}) {
  const target = args.path || args.file || args.sourcePath;
  if (target && isAbsoluteWorkspacePath(target)) await workspaceRegistry.ensureTrustedPath(target, 'file');
}

function structuredToolText(value) {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

async function routeToolCall(request) {
  const toolName = request.params.name;
  assertToolAllowedForProfile(toolName, runtimeProfile);

  if (toolName === 'shell_execute' && enableShell) {
    const args = request.params.arguments || {};
    if (args.working_directory && isAbsoluteWorkspacePath(args.working_directory)) {
      await workspaceRegistry.ensureTrustedPath(args.working_directory, 'directory');
    }
    const roots = currentRoots();
    const validated = validateShellCommand(args, { resolvedRepoRoots: roots, defaultCwd: roots[0] });
    const result = await executeDirectShell(validated.command, {
      cwd: validated.cwd || roots[0],
      timeout: 300000,
      env: process.env
    });
    return structuredToolText({
      command: validated.command,
      workingDirectoryRequested: args.working_directory ?? null,
      workingDirectoryResolved: validated.cwd || roots[0],
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      stderrClassification: result.exitCode !== 0 || result.timedOut ? 'error' : (result.stderr ? 'warning' : 'none'),
      durationMs: result.durationMs,
      timedOut: result.timedOut,
      stdoutTruncated: result.stdoutTruncated,
      stderrTruncated: result.stderrTruncated,
      stdoutBytes: result.stdoutBytes,
      stderrBytes: result.stderrBytes,
      returnedStdoutBytes: result.returnedStdoutBytes,
      returnedStderrBytes: result.returnedStderrBytes,
      encoding: result.encoding
    });
  }

  if (FILESYSTEM_TOOL_NAMES.has(toolName) && filesystemClient) {
    await ensureFileTarget(request.params.arguments || {});
    return await filesystemClient.callTool(request.params);
  }

  if (toolName === 'image_preview') await ensureImageTarget(request.params.arguments || {});
  if (isLocalCustomTool(toolName)) {
    return await callCustomTool(toolName, request.params.arguments || {}, customToolContext());
  }

  if (externalMcpManager.isExternalToolName(toolName)) {
    return await externalMcpManager.callTool(toolName, request.params.arguments || {}, runtimeProfile);
  }

  throw new Error(`Unknown or disabled tool: ${toolName}`);
}

async function routeObservedToolCall(request) {
  const toolName = request.params?.name || 'unknown';
  const startedAt = Date.now();
  console.log(`[tool-call:start] ${toolName}`);
  try {
    const result = await routeToolCall(request);
    const durationMs = Date.now() - startedAt;
    console.log(`[tool-call:finish] ${toolName} durationMs=${durationMs}`);
    if (durationMs > slowToolThresholdMs) console.log(`[tool-call:slow] ${toolName} durationMs=${durationMs}`);
    return result;
  } catch (error) {
    console.log(`[tool-call:error] ${toolName} durationMs=${Date.now() - startedAt}`);
    throw error;
  }
}

function currentResourceContext() {
  const snapshot = workspaceSnapshot();
  return {
    resolvedRepoRoots: snapshot.roots,
    resolvedRepoRoot: snapshot.roots[0],
    projectRegistry: snapshot.projectRegistry,
    packageRoot,
    env: process.env,
    listTools: listMergedTools
  };
}

function createProxyServer() {
  const metadata = workspaceSnapshot().server;
  const server = new Server(
    {
      name: metadata.name,
      title: metadata.title,
      version: '2.0.0',
      description: metadata.description
    },
    {
      instructions: metadata.instructions,
      capabilities: {
        tools: { listChanged: true },
        resources: { subscribe: false, listChanged: true },
        prompts: { listChanged: true }
      }
    }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: await listMergedTools() }));
  server.setRequestHandler(CallToolRequestSchema, routeObservedToolCall);
  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    const context = currentResourceContext();
    return { resources: [...listRepoResources(context), ...await externalMcpManager.listResources()] };
  });
  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => {
    const context = currentResourceContext();
    return { resourceTemplates: [...listRepoResourceTemplates(context), ...await externalMcpManager.listResourceTemplates()] };
  });
  server.setRequestHandler(ReadResourceRequestSchema, async request => {
    if (isExternalResourceUri(request.params.uri)) return await externalMcpManager.readResource(request.params.uri);
    return await readRepoResource(request.params.uri, currentResourceContext());
  });
  server.setRequestHandler(ListPromptsRequestSchema, async () => ({
    prompts: [...listRepoPrompts({ runtimeProfile }), ...await externalMcpManager.listPrompts()]
  }));
  server.setRequestHandler(GetPromptRequestSchema, async request => {
    if (externalMcpManager.isExternalPromptName(request.params.name)) {
      return await externalMcpManager.getPrompt(request.params.name, request.params.arguments || {});
    }
    return getRepoPrompt(request.params.name, request.params.arguments || {}, {
      runtimeProfile,
      defaultProjectId: workspaceSnapshot().projectRegistry.defaultProjectId
    });
  });
  activeProxyServers.add(server);
  return server;
}

function summarizeRequestBody(body) {
  if (!body || typeof body !== 'object') {
    return 'no-body';
  }

  const method = typeof body.method === 'string' ? body.method : 'unknown';
  const toolName = body.params && typeof body.params.name === 'string' ? body.params.name : '';
  return toolName ? `${method}:${toolName}` : method;
}

function setIncomingHeader(req, name, value) {
  req.headers[name.toLowerCase()] = value;
  if (!Array.isArray(req.rawHeaders)) {
    return;
  }

  const index = req.rawHeaders.findIndex(header => header.toLowerCase() === name.toLowerCase());
  if (index >= 0) {
    req.rawHeaders[index + 1] = value;
    return;
  }

  req.rawHeaders.push(name, value);
}

function fingerprint(value) {
  const text = String(value || '');
  return `${text.length}:${createHash('sha256').update(text).digest('hex').slice(0, 12)}`;
}

function getProvidedAuthorizationToken(authorizationHeader) {
  if (typeof authorizationHeader !== 'string') {
    return '';
  }

  const header = authorizationHeader.trim();
  const match = header.match(/^Bearer\s+(.+)$/i);
  return (match ? match[1] : header).trim();
}

const provider = new PasswordProtectedAuthProvider(authPassword, new FileBackedAuthState(authStatePath));
const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: false }));
app.use((req, res, next) => {
  if (req.path !== '/mcp') {
    next();
    return;
  }

  const origin = req.headers.origin;
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'authorization, content-type, accept, mcp-session-id, mcp-protocol-version'
  );
  res.setHeader('Access-Control-Expose-Headers', 'mcp-session-id');

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  next();
});
app.use((req, _res, next) => {
  if (req.path === '/mcp') {
    const sessionId = req.headers['mcp-session-id'];
    const authHeader = req.headers.authorization ? 'yes' : 'no';
    console.log(`[mcp-http] ${req.method} /mcp auth=${authHeader} session=${sessionId || 'none'}`);
  }
  next();
});

function normalizeBaseUrl(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

function requestBaseUrl(req) {
  const explicitBaseUrl = normalizeBaseUrl(advertisedUrl);
  if (explicitBaseUrl) {
    return explicitBaseUrl;
  }

  const forwardedProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  const forwardedHost = String(req.headers['x-forwarded-host'] || '').split(',')[0].trim();
  const host = forwardedHost || req.headers.host;
  if (!host) {
    return fallbackBaseUrl;
  }

  let hostname = String(host).toLowerCase();
  try {
    hostname = new URL(`http://${host}`).hostname.toLowerCase();
  } catch {
    hostname = hostname.split(':')[0];
  }
  const isLocalHost = ['localhost', '127.0.0.1', '::1'].includes(hostname);
  const proto = forwardedProto || (isLocalHost ? req.protocol || (req.secure ? 'https' : 'http') : 'https');
  return normalizeBaseUrl(`${proto}://${host}`);
}

function buildAuthUrls(baseUrl) {
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl) || fallbackBaseUrl;
  const issuerUrl = new URL(normalizedBaseUrl);
  const resourceServerUrl = new URL('/mcp', `${normalizedBaseUrl}/`);
  return { issuerUrl, resourceServerUrl };
}

const authRouters = new Map();

function getAuthRouterForBaseUrl(baseUrl) {
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl) || fallbackBaseUrl;
  const cached = authRouters.get(normalizedBaseUrl);
  if (cached) {
    return cached;
  }

  const { issuerUrl, resourceServerUrl } = buildAuthUrls(normalizedBaseUrl);
  const router = mcpAuthRouter({
    provider,
    issuerUrl,
    resourceServerUrl,
    authorizationOptions: {
      rateLimit: {
        validate: { creationStack: false }
      }
    },
    tokenOptions: {
      rateLimit: {
        validate: { creationStack: false }
      }
    },
    clientRegistrationOptions: {
      rateLimit: {
        validate: { creationStack: false }
      }
    },
    revocationOptions: {
      rateLimit: {
        validate: { creationStack: false }
      }
    },
    scopesSupported: ['mcp:tools'],
    resourceName: 'Local Dev MCP'
  });
  authRouters.set(normalizedBaseUrl, router);
  return router;
}

app.use((req, res, next) => {
  getAuthRouterForBaseUrl(requestBaseUrl(req))(req, res, next);
});

const oauthAuthMiddlewares = new Map();

function getOAuthAuthMiddlewareForBaseUrl(baseUrl) {
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl) || fallbackBaseUrl;
  const cached = oauthAuthMiddlewares.get(normalizedBaseUrl);
  if (cached) {
    return cached;
  }

  const { resourceServerUrl } = buildAuthUrls(normalizedBaseUrl);
  const middleware = requireBearerAuth({
    verifier: provider,
    requiredScopes: [],
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(resourceServerUrl)
  });
  oauthAuthMiddlewares.set(normalizedBaseUrl, middleware);
  return middleware;
}

function mcpAuthMiddleware(req, res, next) {
  if (isStaticBearerAuthorization(req.headers.authorization, staticBearerToken)) {
    console.log('[auth] static-bearer accepted');
    setIncomingHeader(req, 'accept', 'application/json, text/event-stream');
    next();
    return;
  }

  if (debugAuth && req.headers.authorization && staticBearerToken) {
    const providedToken = getProvidedAuthorizationToken(req.headers.authorization);
    console.log(
      `[auth] static-bearer not matched; trying OAuth provided=${fingerprint(providedToken)} expected=${fingerprint(staticBearerToken)}`
    );
  }

  getOAuthAuthMiddlewareForBaseUrl(requestBaseUrl(req))(req, res, next);
}

const transports = {};

async function createTransport() {
  let transport;
  const server = createProxyServer();

  if (!useStatefulMcpSessions) {
    transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    transport.onclose = () => activeProxyServers.delete(server);
    await server.connect(transport);
    return transport;
  }

  transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: id => {
      transports[id] = transport;
    }
  });

  transport.onclose = () => {
    activeProxyServers.delete(server);
    const sid = transport.sessionId;
    if (sid && transports[sid]) delete transports[sid];
  };

  await server.connect(transport);
  return transport;
}

const mcpPostHandler = async (req, res) => {
  const sessionId = req.headers['mcp-session-id'];
  const requestSummary = summarizeRequestBody(req.body);
  console.log(`[mcp-post:start] ${requestSummary} session=${sessionId || 'none'}`);

  try {
    let transport;
    if (useStatefulMcpSessions && sessionId && transports[sessionId]) {
      transport = transports[sessionId];
    } else if (
      !useStatefulMcpSessions ||
      shouldCreateTransportForRequest(sessionId, req.body, transports) ||
      (!sessionId && isInitializeRequest(req.body))
    ) {
      transport = await createTransport();
      await transport.handleRequest(req, res, req.body);
      return;
    } else {
      console.log(`[mcp-post:reject] ${requestSummary} reason=invalid-session session=${sessionId || 'none'}`);
      res.status(400).json({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Bad Request: No valid session ID provided' },
        id: null
      });
      return;
    }

    await transport.handleRequest(req, res, req.body);
    console.log(`[mcp-post:finish] ${requestSummary} session=${sessionId || 'none'}`);
  } catch (error) {
    console.error('Error handling MCP POST request:', error);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        error: { code: -32603, message: 'Internal server error' },
        id: null
      });
    }
  }
};

const mcpGetHandler = async (req, res) => {
  const sessionId = req.headers['mcp-session-id'];
  console.log(`[mcp-get:start] session=${sessionId || 'none'}`);
  if (!sessionId || !transports[sessionId]) {
    console.log(`[mcp-get:reject] reason=invalid-session session=${sessionId || 'none'}`);
    res.status(400).send('Invalid or missing session ID');
    return;
  }

  await transports[sessionId].handleRequest(req, res);
  console.log(`[mcp-get:finish] session=${sessionId || 'none'}`);
};

const mcpDeleteHandler = async (req, res) => {
  const sessionId = req.headers['mcp-session-id'];
  console.log(`[mcp-delete:start] session=${sessionId || 'none'}`);
  if (!sessionId || !transports[sessionId]) {
    console.log(`[mcp-delete:reject] reason=invalid-session session=${sessionId || 'none'}`);
    res.status(400).send('Invalid or missing session ID');
    return;
  }

  await transports[sessionId].handleRequest(req, res);
  console.log(`[mcp-delete:finish] session=${sessionId || 'none'}`);
};

app.get('/healthz', (_req, res) => {
  res.json({ ok: true, enableFilesystem, enableShell });
});

app.post('/mcp', mcpAuthMiddleware, mcpPostHandler);
app.get('/mcp', mcpAuthMiddleware, mcpGetHandler);
app.delete('/mcp', mcpAuthMiddleware, mcpDeleteHandler);

const serverInstance = app.listen(gatewayPort, gatewayHost, () => {
  const { issuerUrl, resourceServerUrl } = buildAuthUrls(normalizeBaseUrl(advertisedUrl) || fallbackBaseUrl);
  console.log(`Authenticated MCP wrapper listening on http://${gatewayHost}:${gatewayPort}/mcp`);
  console.log(`OAuth issuer: ${issuerUrl.href}`);
  console.log(`MCP resource URL: ${resourceServerUrl.href}`);
  const snapshot = workspaceSnapshot();
  console.log(`Trusted roots: ${snapshot.roots.join('; ')}`);
  console.log(
    `Project registry: ${snapshot.projectRegistry.projects.size} project(s), default=${snapshot.projectRegistry.defaultProjectId || 'none'}`
  );
  console.log(`Filesystem enabled: ${enableFilesystem}`);
  console.log(`Shell enabled: ${enableShell}`);
  console.log(`Runtime profile: ${runtimeProfile.name}`);
  console.log(`Static bearer enabled: ${staticBearerToken ? 'true' : 'false'}`);
  console.log(`MCP transport mode: ${useStatefulMcpSessions ? 'stateful' : 'stateless'}`);
});

async function shutdown() {
  serverInstance.close();
  workspaceRegistry.close();
  await externalMcpManager.shutdown().catch(() => {});
  await filesystemClient?.close().catch(() => {});
  await filesystemTransport?.close().catch(() => {});
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
