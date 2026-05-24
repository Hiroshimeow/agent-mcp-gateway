import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
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
import { executeDirectShell, getDirectPlatformInfo } from './direct-shell.mjs';
import { getSafetyProfile } from './safety-profile.mjs';
import { applyToolRisk, assertToolAllowedForProfile, shouldExposeToolForProfile } from './tool-risk.mjs';
import { listRepoResources, listRepoResourceTemplates, readRepoResource } from './resources/index.mjs';
import { getRepoPrompt, listRepoPrompts } from './prompts/index.mjs';
import { createExternalMcpManager } from './upstreams/manager.mjs';
import { isExternalResourceUri } from './upstreams/resource-uri.mjs';
import { buildShellExecuteAnnotations, buildShellExecuteDescription } from './shell-tool-descriptor.mjs';
import { callCustomTool, isLocalCustomTool, listCustomTools } from './custom-tools/index.mjs';
import {
  buildTrustedRootsMetadata,
  buildTrustedRootsNotice,
  normalizeToolForAutopilot,
  toCustomToolName,
  toUpstreamToolName
} from './tool-metadata.mjs';
import {
  FileBackedAuthState,
  PasswordProtectedAuthProvider,
  isStaticBearerAuthorization,
  shouldCreateTransportForRequest,
  shouldUseStatefulSessionTransport
} from './auth-session.mjs';
import { validateShellCommand } from './shell-policy.mjs';
import {
  buildTrustedRootsProjectRegistryFromRaw,
  resolveTrustedRootPaths
} from './projects/trusted-roots-projects.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = process.env.REPO_ROOT;
const gatewayPort = Number(process.env.MCP_GATEWAY_PORT || '8101');
const gatewayHost = String(process.env.MCP_GATEWAY_HOST || '127.0.0.1').trim() || '127.0.0.1';
const advertisedHost = String(process.env.MCP_ADVERTISE_HOST || '').trim() || (gatewayHost === '0.0.0.0' ? '127.0.0.1' : gatewayHost);
const advertisedUrl = String(process.env.MCP_ADVERTISE_URL || '').trim();
const fallbackBaseUrl = `http://${advertisedHost}:${gatewayPort}`;
const authPassword = process.env.MCP_AUTH_PASSWORD;
const staticBearerToken = process.env.MCP_BEARER_TOKEN;
const safetyProfile = getSafetyProfile(process.env);
const filesystemLogPath = process.env.FILESYSTEM_LOG_PATH;
const shellLogPath = process.env.SHELL_LOG_PATH;
const authStatePath = process.env.AUTH_STATE_PATH;
const useStatefulMcpSessions = shouldUseStatefulSessionTransport(process.env.MCP_STATEFUL_SESSIONS);
const enableFilesystem = String(process.env.ENABLE_FILESYSTEM || 'true').toLowerCase() === 'true';
const enableShell = String(process.env.ENABLE_SHELL || 'true').toLowerCase() === 'true';
const debugAuth = envFlag(process.env.MCP_DEBUG_AUTH, false);
const slowToolThresholdMs = normalizeDurationMs(process.env.MCP_SLOW_TOOL_MS, 5000);

if (!repoRoot) throw new Error('REPO_ROOT is required');
if (!authPassword) throw new Error('MCP_AUTH_PASSWORD is required');
if (!enableFilesystem && !enableShell) {
  throw new Error('At least one upstream MCP server must be enabled');
}

function envFlag(value, defaultValue = false) {
  const text = String(value ?? '').trim().toLowerCase();
  if (!text) return defaultValue;
  if (['1', 'true', 'yes', 'y', 'on'].includes(text)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(text)) return false;
  return defaultValue;
}

function normalizeDurationMs(value, defaultValue) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed) || parsed < 0) return defaultValue;
  return parsed;
}

function readTrustedRootsFile(filePath, baseDir = packageRoot) {
  const value = String(filePath || '').trim();
  if (!value) {
    return '';
  }

  const normalized = value.replace(/^['"]|['"]$/g, '').replace(/^\\\\\?\\/, '');
  const resolvedPath = path.isAbsolute(normalized) ? path.resolve(normalized) : path.resolve(baseDir, normalized);
  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`MCP_TRUSTED_ROOTS_FILE does not exist: ${resolvedPath}`);
  }

  return fs
    .readFileSync(resolvedPath, 'utf8')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('#'))
    .join('\n');
}

const trustedRootsRaw = [
  process.env.MCP_TRUSTED_ROOTS,
  readTrustedRootsFile(process.env.MCP_TRUSTED_ROOTS_FILE)
]
  .filter(Boolean)
  .join('\n');

const { existingRoots: resolvedRepoRoots, missingRoots: missingTrustedRoots } = resolveTrustedRootPaths(
  trustedRootsRaw,
  repoRoot
);
const resolvedRepoRoot = resolvedRepoRoots[0];
const projectRegistry = buildTrustedRootsProjectRegistryFromRaw(trustedRootsRaw, {
  fallbackRoot: repoRoot,
  defaultProjectId: process.env.MCP_DEFAULT_PROJECT_ID,
  requireProjectId: envFlag(process.env.MCP_REQUIRE_PROJECT_ID, false),
  pathInference: envFlag(process.env.MCP_ENABLE_PROJECT_PATH_INFERENCE, true),
  exposeProjectPaths: envFlag(process.env.MCP_EXPOSE_PROJECT_PATHS, false),
  checkExists: true
});
const filesystemEntrypointPath = fileURLToPath(
  new URL('../node_modules/@modelcontextprotocol/server-filesystem/dist/index.js', import.meta.url)
);

function isSamePathOrInside(basePath, targetPath) {
  const base = path.resolve(basePath);
  const target = path.resolve(targetPath);
  const relative = path.relative(base, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

const shellExecuteSchema = {
  type: 'object',
  properties: {
    command: {
      type: 'string',
      description:
        'Shell command string executed after authentication. Full yolo mode: no launcher-side shell blocklist or approval gate.'
    },
    working_directory: {
      type: 'string',
      description:
        'Optional directory. It must stay inside one trusted root. If omitted, the launcher uses the first trusted root.'
    }
  },
  required: ['command'],
  additionalProperties: false
};

const repoRootNotice = buildTrustedRootsNotice(resolvedRepoRoots);
const repoRootMetadata = buildTrustedRootsMetadata(resolvedRepoRoots);

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
    args: [filesystemEntrypointPath, ...resolvedRepoRoots],
    cwd: resolvedRepoRoot,
    stderr: 'pipe'
  });
  appendStderrToLog(transport, filesystemLogPath);
  return transport;
}

const filesystemTransport = enableFilesystem ? createFilesystemTransport() : null;
const shellTransport = null;

const filesystemClient = filesystemTransport
  ? createClient('personal-mcp-launcher-filesystem', '1.3.0', filesystemTransport, { roots: {} })
  : null;
const shellClient = null;

if (filesystemClient) {
  filesystemClient.setRequestHandler(ListRootsRequestSchema, async () => ({
    roots: resolvedRepoRoots.map(root => ({
      uri: pathToFileURL(root).href,
      name: path.basename(root) || root
    }))
  }));
}

if (filesystemClient && filesystemTransport) {
  await filesystemClient.connect(filesystemTransport);
}

async function listLocalToolNamesForCollisionCheck() {
  const names = new Set();
  if (filesystemClient) {
    const filesystemResult = await filesystemClient.listTools();
    for (const tool of filesystemResult.tools || []) {
      names.add(tool.name);
      names.add(toCustomToolName(tool.name));
    }
  }
  for (const tool of listCustomTools({ resolvedRepoRoots, resolvedRepoRoot, projectRegistry })) names.add(tool.name);
  if (enableShell) {
    names.add('custom_shell_execute');
    names.add('custom_get_platform_info');
  }
  return [...names];
}

const externalMcpManager = await createExternalMcpManager({
  env: process.env,
  repoRoot: packageRoot,
  localToolNames: await listLocalToolNamesForCollisionCheck(),
  localPromptNames: listRepoPrompts({ safetyProfile }).map(prompt => prompt.name)
});

function isWithinRepo(targetPath) {
  return resolvedRepoRoots.some(root => {
    const relative = path.relative(root, targetPath);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
  });
}

async function listAllMergedToolsUnfiltered() {
  const tools = [];

  if (filesystemClient) {
    const filesystemResult = await filesystemClient.listTools();
    tools.push(...filesystemResult.tools.map(tool => normalizeToolForAutopilot(tool, { repoRoots: resolvedRepoRoots })));
  }

  tools.push(...listCustomTools({ resolvedRepoRoots, resolvedRepoRoot, projectRegistry }));

  if (enableShell) {
    tools.push({
      name: 'custom_shell_execute',
      description: buildShellExecuteDescription(repoRootNotice),
      inputSchema: shellExecuteSchema,
      _meta: repoRootMetadata,
      annotations: buildShellExecuteAnnotations()
    });
    tools.push({
      name: 'custom_get_platform_info',
      description: `${repoRootNotice}\n\nGet information about the current shell backend used by the launcher.`,
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      _meta: repoRootMetadata,
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        destructiveHint: false,
        openWorldHint: false
      }
    });
  }

  tools.push(...await externalMcpManager.listAllToolsUnfiltered());

  return tools.map(tool => tool._meta?.upstream ? tool : applyToolRisk(tool));
}

async function listMergedTools() {
  return (await listAllMergedToolsUnfiltered()).filter(tool => shouldExposeToolForProfile(tool, safetyProfile));
}

async function routeToolCall(request) {
  const toolName = request.params.name;
  const upstreamToolName = toUpstreamToolName(toolName);
  assertToolAllowedForProfile(upstreamToolName, safetyProfile);
  if (isLocalCustomTool(upstreamToolName)) {
    return await callCustomTool(upstreamToolName, request.params.arguments || {}, {
      resolvedRepoRoots,
      resolvedRepoRoot,
      projectRegistry,
      executeDirectShell,
      packageRoot: resolvedRepoRoot,
      env: process.env
    });
  }

  if (enableShell && upstreamToolName === 'shell_execute') {
    const validated = validateShellCommand(request.params.arguments, {
      resolvedRepoRoots,
      defaultCwd: resolvedRepoRoot
    });
    console.log('[shell] accepted');
    const result = await executeDirectShell(validated.command, { cwd: validated.cwd || resolvedRepoRoot, timeout: 300000 });
    return {
      content: [
        {
          type: 'text',
          text: result.stdout || ''
        },
        {
          type: 'text',
          text: result.stderr ? `Error output: ${result.stderr}` : ''
        }
      ]
    };
  }

  if (enableShell && upstreamToolName === 'get_platform_info') {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            getDirectPlatformInfo({ repoRoot: resolvedRepoRoot, trustedRoots: resolvedRepoRoots }),
            null,
            2
          )
        }
      ]
    };
  }

  if (externalMcpManager.isExternalToolName(toolName)) {
    return await externalMcpManager.callTool(toolName, request.params.arguments || {}, safetyProfile);
  }

  if (filesystemClient) {
    return await filesystemClient.callTool({ ...request.params, name: upstreamToolName });
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
    if (durationMs > slowToolThresholdMs) {
      console.log(`[tool-call:slow] ${toolName} durationMs=${durationMs}`);
    }
    return result;
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    console.log(`[tool-call:error] ${toolName} durationMs=${durationMs}`);
    throw error;
  }
}

function createProxyServer() {
  const server = new Server(
    { name: 'personal-mcp-launcher', version: '1.3.0' },
    {
      capabilities: {
        tools: { listChanged: false },
        resources: { subscribe: false, listChanged: false },
        prompts: { listChanged: false }
      }
    }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools: await listMergedTools() };
  });

  server.setRequestHandler(CallToolRequestSchema, async request => {
    return await routeObservedToolCall(request);
  });

  const resourceContext = {
    resolvedRepoRoots,
    resolvedRepoRoot,
    projectRegistry,
    packageRoot,
    env: process.env,
    listTools: listAllMergedToolsUnfiltered
  };

  server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: [...listRepoResources(resourceContext), ...await externalMcpManager.listResources()] }));
  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({ resourceTemplates: [...listRepoResourceTemplates(resourceContext), ...await externalMcpManager.listResourceTemplates()] }));
  server.setRequestHandler(ReadResourceRequestSchema, async request => {
    if (isExternalResourceUri(request.params.uri)) return await externalMcpManager.readResource(request.params.uri);
    return await readRepoResource(request.params.uri, resourceContext);
  });

  server.setRequestHandler(ListPromptsRequestSchema, async () => ({ prompts: [...listRepoPrompts({ safetyProfile }), ...await externalMcpManager.listPrompts()] }));
  server.setRequestHandler(GetPromptRequestSchema, async request => {
    if (externalMcpManager.isExternalPromptName(request.params.name)) return await externalMcpManager.getPrompt(request.params.name, request.params.arguments || {});
    return getRepoPrompt(request.params.name, request.params.arguments || {}, { safetyProfile, defaultProjectId: projectRegistry.defaultProjectId });
  });

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
  if (!useStatefulMcpSessions) {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined
    });
    const server = createProxyServer();
    await server.connect(transport);
    return transport;
  }

  let transport;
  transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: id => {
      transports[id] = transport;
    }
  });

  transport.onclose = () => {
    const sid = transport.sessionId;
    if (sid && transports[sid]) {
      delete transports[sid];
    }
  };

  const server = createProxyServer();
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
  console.log(`Trusted roots: ${resolvedRepoRoots.join('; ')}`);
  console.log(
    `Project registry: ${projectRegistry.projects.size} project(s), default=${projectRegistry.defaultProjectId || 'none'}`
  );
  if (missingTrustedRoots.length > 0) {
    console.log(`Skipped missing trusted roots: ${missingTrustedRoots.join('; ')}`);
  }
  console.log(`Filesystem enabled: ${enableFilesystem}`);
  console.log(`Shell enabled: ${enableShell}`);
  console.log(`Safety profile: ${safetyProfile.name}`);
  console.log(`Static bearer enabled: ${staticBearerToken ? 'true' : 'false'}`);
  console.log(`MCP transport mode: ${useStatefulMcpSessions ? 'stateful' : 'stateless'}`);
});

async function shutdown() {
  serverInstance.close();
  await externalMcpManager.shutdown().catch(() => {});
  await filesystemClient?.close().catch(() => {});
  await filesystemTransport?.close().catch(() => {});
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
