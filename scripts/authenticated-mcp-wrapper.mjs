import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
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
  ListToolsRequestSchema,
  ReadResourceRequestSchema
} from '@modelcontextprotocol/sdk/types.js';
import { getRuntimeProfile } from './runtime-profile.mjs';
import { applyToolRisk, assertToolAllowedForProfile, shouldExposeToolForProfile } from './tool-risk.mjs';
import { listRepoResources, listRepoResourceTemplates, readRepoResource } from './resources/index.mjs';
import { getRepoPrompt, listRepoPrompts } from './prompts/index.mjs';
import { loadSurfaceConfig } from './surface-config.mjs';
import { LOCAL_COLLISION_TOOL_NAMES, stableToolDefinition, workspaceCatalogChanges } from './tool-surface-stability.mjs';
import { SKILL_AGENT_INSTRUCTIONS, watchSkillCatalog } from './skills/index.mjs';
import { createExternalToolBroker } from './external-tool-broker.mjs';
import { createExternalMcpManager } from './upstreams/manager.mjs';
import { normalizeExternalMcpConfig } from './upstreams/config.mjs';
import { isExternalResourceUri } from './upstreams/resource-uri.mjs';
import { buildShellExecuteAnnotations, buildShellExecuteDescription } from './shell-tool-descriptor.mjs';
import { callCustomTool, isLocalCustomTool, listCustomTools } from './custom-tools/index.mjs';
import {
  AUTH_SUPPORTED_SCOPES,
  AccountAuthProvider,
  SQLiteAuthState,
  isStaticBearerAuthorization,
  shouldCreateTransportForRequest,
  shouldUseStatefulSessionTransport
} from './auth-session.mjs';
import { buildSkillCallerKey, createSkillBootstrapGate, decorateSkillBootstrapDescription } from './skill-bootstrap-gate.mjs';
import { buildToolMetric, createToolMetricsRecorder } from './tool-metrics.mjs';
import { createRemoteProcessSessionRegistry } from './remote-process-sessions.mjs';
import { normalizeRemoteFilesystemResult } from './remote-tool-result.mjs';
import { createDeviceBroker } from './device-broker.mjs';
import { listDevicesToolDefinition, paginateDeviceInventory } from './device-inventory.mjs';
import { installDevicePairingRoutes } from './device-pairing-http.mjs';
import { createDevicePairingStore } from './device-pairing-store.mjs';
import { createDeviceStore } from './device-store.mjs';
import { createDeviceUsageStore } from './device-usage.mjs';
import { callerAuditId, createDeviceAccessPolicy } from './device-access-policy.mjs';
import { createDeviceAuditRecorder } from './device-audit.mjs';
import { createAccountStore } from './account-store.mjs';
import { installAccountRoutes } from './account-http.mjs';
import { findUnifiedMcpConfigPath } from './projects/trusted-roots-projects.mjs';
import {
  classifyWorkspaceChange,
  createWorkspaceRegistry
} from './workspace-registry.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runtimeDirectory = path.resolve(process.env.MCP_RUNTIME_DIR || path.join(packageRoot, '.runtime'));
const repoRoot = process.env.REPO_ROOT;
const gatewayPort = Number(process.env.MCP_GATEWAY_PORT || '8101');
const gatewayHost = String(process.env.MCP_GATEWAY_HOST || '127.0.0.1').trim() || '127.0.0.1';
const advertisedHost = String(process.env.MCP_ADVERTISE_HOST || '').trim() || (gatewayHost === '0.0.0.0' ? '127.0.0.1' : gatewayHost);
const advertisedUrl = String(process.env.MCP_ADVERTISE_URL || '').trim();
const fallbackBaseUrl = `http://${advertisedHost}:${gatewayPort}`;
const staticBearerToken = process.env.MCP_BEARER_TOKEN;
const runtimeProfile = getRuntimeProfile(process.env);
const useStatefulMcpSessions = shouldUseStatefulSessionTransport(process.env.MCP_STATEFUL_SESSIONS);
const enableFilesystem = String(process.env.ENABLE_FILESYSTEM || 'true').toLowerCase() === 'true';
const enableShell = String(process.env.ENABLE_SHELL || 'true').toLowerCase() === 'true';
const debugAuth = envFlag(process.env.MCP_DEBUG_AUTH, false);
const slowToolThresholdMs = normalizeDurationMs(process.env.MCP_SLOW_TOOL_MS, 5000);
const toolMetrics = createToolMetricsRecorder({
  metricsPath: path.resolve(process.env.MCP_METRICS_PATH || path.join(runtimeDirectory, 'mcp-calls.ndjson')),
  enabled: envFlag(process.env.MCP_METRICS_ENABLED, true)
});
const skillBootstrapGate = createSkillBootstrapGate({
  ttlMs: normalizeDurationMs(process.env.MCP_SKILL_BOOTSTRAP_TTL_MS, 4 * 60 * 60 * 1000)
});
const FILESYSTEM_TOOL_NAMES = new Set(['read_text_file', 'write_file', 'edit_file']);
const PROCESS_TOOL_NAMES = new Set(['start_process', 'read_process_output', 'interact_with_process', 'terminate_process']);
const activeProxyServers = new Set();

if (!repoRoot) throw new Error('REPO_ROOT is required');
if (!enableFilesystem && !enableShell) throw new Error('At least one execution tool family must be enabled');

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
  runtimeRootsPath: path.join(runtimeDirectory, 'trusted-roots.toml'),
  repoRoot: packageRoot,
  env: process.env
});

function workspaceSnapshot() {
  return workspaceRegistry.snapshot();
}

function currentSurfaceConfig(snapshot = workspaceSnapshot()) {
  return loadSurfaceConfig(snapshot.rawConfig, process.env);
}

const remoteProcessSessions = createRemoteProcessSessionRegistry();
const gatewayDbPath = path.resolve(process.env.MCP_GATEWAY_DB_PATH || path.join(runtimeDirectory, 'gateway.sqlite'));
const accountStore = createAccountStore({ dbPath: gatewayDbPath });
const deviceStore = createDeviceStore({ dbPath: gatewayDbPath });
const devicePairingStore = createDevicePairingStore({ dbPath: gatewayDbPath });
const deviceUsageStore = createDeviceUsageStore({ dbPath: gatewayDbPath });
const deviceBroker = createDeviceBroker({
  enrollmentToken: process.env.MCP_DEVICE_ENROLLMENT_TOKEN,
  deviceStore,
  pairingStore: devicePairingStore,
  usageStore: deviceUsageStore
});
const deviceAccessPolicy = createDeviceAccessPolicy({
  raw: process.env.MCP_DEVICE_ACCESS_POLICY || '',
  profile: runtimeProfile.name
});
const deviceAudit = createDeviceAuditRecorder({
  auditPath: path.join(runtimeDirectory, 'device-audit.jsonl'),
  enabled: process.env.MCP_DEVICE_AUDIT_ENABLED !== 'false'
});

async function broadcastCatalogChanges(changes = {}) {
  const tasks = [];
  for (const server of activeProxyServers) {
    if (changes.toolsChanged) tasks.push(server.sendToolListChanged().catch(() => {}));
    if (changes.resourcesChanged) tasks.push(server.sendResourceListChanged().catch(() => {}));
    if (changes.promptsChanged) tasks.push(server.sendPromptListChanged().catch(() => {}));
  }
  await Promise.all(tasks);
}

const stopSkillCatalogWatcher = watchSkillCatalog(async () => {
  const surfaceConfig = currentSurfaceConfig();
  await broadcastCatalogChanges({
    resourcesChanged: surfaceConfig.enumerateSkillResources,
    promptsChanged: surfaceConfig.exposePrompts
  });
});

function localToolNamesForCollisionCheck() {
  return [...LOCAL_COLLISION_TOOL_NAMES];
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
const externalToolBroker = createExternalToolBroker({
  getTools: () => externalMcpManager.getCachedTools(),
  invokeTool: (name, args) => externalMcpManager.callTool(name, args)
});

workspaceRegistry.subscribe(async (next, previous) => {
  const { rootsChanged, upstreamChanged } = classifyWorkspaceChange(next, previous);
  if (rootsChanged) {
    await broadcastCatalogChanges(workspaceCatalogChanges({ rootsChanged }, currentSurfaceConfig(next)));
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
    working_directory: { type: 'string', description: 'The target workspace for execution.' },
    timeout_ms: { type: 'integer', minimum: 1, maximum: 28000, description: 'Optional one-shot execution timeout in milliseconds. Defaults to 28000; use start_process for longer work.' },
    device_id: { type: 'string', minLength: 1, description: 'Owned online device that will execute this command.' }
  },
  required: ['command', 'working_directory', 'device_id'],
  additionalProperties: false
};

const processToolSchemas = {
  start_process: {
    type: 'object',
    properties: {
      command: { type: 'string', minLength: 1, description: 'Command to execute in a retained process session.' },
      working_directory: { type: 'string', description: 'Trusted workspace directory for the process.' },
      timeout_ms: { type: 'integer', minimum: 1, maximum: 30000, default: 10000, description: 'Foreground wait before yielding RUNNING. Does not kill the process.' },
      device_id: { type: 'string', minLength: 1, description: 'Owned online device that will start the process. Follow-up calls use session_id only.' }
    },
    required: ['command', 'working_directory', 'device_id'],
    additionalProperties: false
  },
  read_process_output: {
    type: 'object',
    properties: {
      session_id: { type: 'string', minLength: 1 },
      offset: { type: 'integer', minimum: 0 },
      length: { type: 'integer', minimum: 1, maximum: 65536, default: 8192 }
    },
    required: ['session_id'],
    additionalProperties: false
  },
  interact_with_process: {
    type: 'object',
    properties: {
      session_id: { type: 'string', minLength: 1 },
      input: { type: 'string', description: 'Raw stdin text; include a newline when the target program requires one.' },
      timeout_ms: { type: 'integer', minimum: 0, maximum: 30000, default: 0, description: 'Optional wait after writing stdin. Does not kill the process.' }
    },
    required: ['session_id', 'input'],
    additionalProperties: false
  },
  terminate_process: {
    type: 'object',
    properties: { session_id: { type: 'string', minLength: 1 } },
    required: ['session_id'],
    additionalProperties: false
  }
};

function listProcessTools() {
  const descriptions = {
    start_process: 'Start a command with retained bounded output. Short commands may complete immediately; long commands return RUNNING plus sessionId after timeout_ms without being killed.',
    read_process_output: 'Read a bounded page of retained process output using absolute offset/length. Completed output remains available for a bounded retention period.',
    interact_with_process: 'Write raw stdin to a running process session and optionally wait briefly for progress.',
    terminate_process: 'Terminate a caller-owned running process session and its process tree where supported.'
  };
  return [...PROCESS_TOOL_NAMES].map(name => applyToolRisk({
    name,
    description: descriptions[name],
    inputSchema: processToolSchemas[name]
  }));
}

const shellExecuteOutputSchema = {
  type: 'object',
  properties: {
    workingDirectoryResolved: { type: 'string' },
    exitCode: { type: 'number' },
    stdout: { type: 'string' },
    stderr: { type: 'string' },
    stderrClassification: { type: 'string' },
    durationMs: { type: 'number' },
    timedOut: { type: 'boolean' },
    stdoutTruncated: { type: 'boolean' },
    stderrTruncated: { type: 'boolean' },
    stdoutBytes: { type: 'number' },
    stderrBytes: { type: 'number' },
    stdoutSpillPath: {},
    stderrSpillPath: {}
  }
};

function customToolContext(callerContext = {}) {
  const snapshot = workspaceSnapshot();
  return {
    resolvedRepoRoots: snapshot.roots,
    resolvedRepoRoot: snapshot.roots[0],
    projectRegistry: snapshot.projectRegistry,
    accountId: callerContext.accountId || null,
    listVisibleDevices: () => deviceAccessPolicy.filterDevices(
      deviceBroker.listDevices({ accountId: callerContext.accountId || null }),
      {
        callerSubject: callerContext.callerSubject || callerContext.callerCategory || 'anonymous',
        callerCategory: callerContext.callerCategory || 'anonymous'
      }
    ),
    callDeviceTool: async (tool, args = {}) => {
      const { deviceId, toolArguments } = requireDeviceId(args);
      return await callRemoteDevice({ context: callerContext, deviceId, tool, arguments: toolArguments });
    },
    externalToolBroker,
    runtimeProfile,
    packageRoot,
    env: process.env
  };
}

function buildEditFileInputSchema(inputSchema = {}) {
  return {
    ...inputSchema,
    type: 'object',
    properties: {
      ...(inputSchema.properties || {}),
      old_text: { type: 'string', minLength: 1, description: 'Exact text to replace. No fuzzy matching is applied.' },
      new_text: { type: 'string', description: 'Replacement text.' },
      expected_replacements: { type: 'integer', minimum: 1, default: 1, description: 'Required exact occurrence count before mutation.' },
      dry_run: { type: 'boolean', default: false, description: 'Validate and preview without writing.' }
    },
    required: ['path'],
    anyOf: [
      { required: ['edits'] },
      { required: ['old_text', 'new_text'] }
    ],
    additionalProperties: false
  };
}

function withRequiredDeviceId(inputSchema = {}) {
  return {
    ...inputSchema,
    type: 'object',
    properties: {
      ...(inputSchema.properties || {}),
      device_id: { type: 'string', minLength: 1, description: 'Owned online device that will perform this filesystem operation.' }
    },
    required: [...new Set([...(inputSchema.required || []), 'device_id'])]
  };
}

const FILESYSTEM_TOOL_DEFINITIONS = [
  {
    name: 'read_text_file',
    description: 'Read a text file from one explicit owned online device. Use head or tail to bound large reads.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        tail: { type: 'number', description: 'If provided, returns only the last N lines of the file.' },
        head: { type: 'number', description: 'If provided, returns only the first N lines of the file.' }
      },
      required: ['path'],
      additionalProperties: false
    },
    outputSchema: { type: 'object', properties: { content: { type: 'string' } }, required: ['content'], additionalProperties: false }
  },
  {
    name: 'write_file',
    description: 'Create or completely overwrite a text file on one explicit owned online device.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' }, content: { type: 'string' } },
      required: ['path', 'content'],
      additionalProperties: false
    },
    outputSchema: { type: 'object', properties: { content: { type: 'string' } }, required: ['content'], additionalProperties: false }
  },
  {
    name: 'edit_file',
    description: 'Make exact guarded edits to a text file on one explicit owned online device.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        edits: {
          type: 'array',
          items: {
            type: 'object',
            properties: { oldText: { type: 'string' }, newText: { type: 'string' } },
            required: ['oldText', 'newText'],
            additionalProperties: false
          }
        },
        dryRun: { type: 'boolean', default: false }
      },
      required: ['path'],
      additionalProperties: false
    },
    outputSchema: { type: 'object', properties: { content: { type: 'string' } }, required: ['content'], additionalProperties: false }
  }
];

function filesystemToolMeta(tool) {
  const baseSchema = tool.name === 'edit_file' ? buildEditFileInputSchema(tool.inputSchema) : tool.inputSchema;
  return stableToolDefinition(applyToolRisk({
    ...tool,
    inputSchema: withRequiredDeviceId(baseSchema),
    name: tool.name,
    description: decorateSkillBootstrapDescription(tool.name, tool.name === 'edit_file'
      ? `${tool.description} Prefer old_text/new_text with expected_replacements for guarded exact edits; legacy edits[]/dryRun remains supported for compatibility.`
      : tool.description)
  }));
}

async function listMergedTools() {
  const tools = [];
  if (enableFilesystem) {
    tools.push(...FILESYSTEM_TOOL_DEFINITIONS.map(filesystemToolMeta));
  }
  tools.push(...listCustomTools(customToolContext()));
  tools.push(applyToolRisk(listDevicesToolDefinition()));
  if (enableShell) {
    tools.push(stableToolDefinition(applyToolRisk({
      name: 'shell_execute',
      description: buildShellExecuteDescription(),
      inputSchema: shellExecuteSchema,
      outputSchema: shellExecuteOutputSchema,
      annotations: buildShellExecuteAnnotations()
    })));
    tools.push(...listProcessTools());
  }
  tools.push(...await externalMcpManager.listAllToolsUnfiltered());
  return tools.filter(tool => shouldExposeToolForProfile(tool, runtimeProfile));
}

async function refreshDeviceSchemaSnapshot() {
  const tools = await listMergedTools();
  const toolSchemaBytes = Buffer.byteLength(JSON.stringify({ tools }), 'utf8');
  return deviceBroker.setSchemaSnapshot({
    toolCount: tools.length,
    toolSchemaBytes,
    toolSchemaTokenEstimate: Math.ceil(toolSchemaBytes / 4),
    tokenEstimateMethod: 'utf8_bytes_div_4_estimate'
  });
}

function structuredToolText(value, { includeStructured = false } = {}) {
  const result = { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
  return includeStructured ? { ...result, structuredContent: value } : result;
}

const SHELL_RESPONSE_BUDGET_BYTES = 128 * 1024;
const SHELL_TOOL_RESULT_BUDGET_BYTES = SHELL_RESPONSE_BUDGET_BYTES - (8 * 1024);

function boundedShellToolText(value) {
  const response = structuredToolText(value, { includeStructured: true });
  if (Buffer.byteLength(JSON.stringify(response)) <= SHELL_TOOL_RESULT_BUDGET_BYTES) return response;
  throw new Error(`shell_execute response exceeds ${SHELL_RESPONSE_BUDGET_BYTES} byte budget`);
}

function appendSkillAdvisory(result, advisory) {
  if (!advisory || result?.isError) return result;
  return {
    ...result,
    content: [...(result?.content || []), { type: 'text', text: advisory }]
  };
}

function splitDeviceArguments(args = {}) {
  const { device_id: deviceId, ...toolArguments } = args;
  return { deviceId: String(deviceId || '').trim(), toolArguments };
}

function requireDeviceId(args = {}) {
  const routed = splitDeviceArguments(args);
  if (routed.deviceId) return routed;
  const error = new Error('DEVICE_ID_REQUIRED: device_id is required for execution tools.');
  error.code = 'DEVICE_ID_REQUIRED';
  throw error;
}

async function callRemoteDevice({ context = {}, deviceId, tool, arguments: args = {}, timeoutMs }) {
  const callerSubject = context.callerSubject || context.callerCategory || 'anonymous';
  const callerCategory = context.callerCategory || 'anonymous';
  const requestId = randomUUID();
  const startedAt = Date.now();
  let grant = null;
  try {
    grant = deviceAccessPolicy.authorize({
      callerSubject,
      callerCategory,
      deviceId,
      tool,
      arguments: args
    });
    const result = await deviceBroker.callDevice({
      requestId,
      accountId: context.accountId || null,
      deviceId,
      tool,
      arguments: args,
      ...(timeoutMs === undefined ? {} : { timeoutMs })
    });
    const outputBytes = deviceAccessPolicy.assertOutput(grant, result);
    deviceAudit.record({
      requestId,
      callerId: callerAuditId(callerSubject),
      callerCategory,
      deviceId,
      tool,
      outcome: 'success',
      durationMs: Date.now() - startedAt,
      inputBytes: grant.inputBytes,
      outputBytes
    });
    return result;
  } catch (error) {
    const inputBytes = grant?.inputBytes ?? Buffer.byteLength(JSON.stringify(args ?? {}), 'utf8');
    deviceAudit.record({
      requestId,
      callerId: callerAuditId(callerSubject),
      callerCategory,
      deviceId,
      tool,
      outcome: 'error',
      durationMs: Date.now() - startedAt,
      inputBytes,
      errorCode: String(error?.code || 'REMOTE_DEVICE_ERROR').slice(0, 64)
    });
    throw error;
  }
}

async function routeToolCall(request, context = {}) {
  const { callerKey } = context;
  const toolName = request.params.name;
  assertToolAllowedForProfile(toolName, runtimeProfile);

  if (toolName === 'shell_execute' && enableShell) {
    const { deviceId, toolArguments } = requireDeviceId(request.params.arguments || {});
    const remoteTimeoutMs = Number(toolArguments.timeout_ms || 28000);
    if (!Number.isInteger(remoteTimeoutMs) || remoteTimeoutMs < 1 || remoteTimeoutMs > 28000) {
      throw new Error('Remote shell_execute timeout_ms must be between 1 and 28000; use start_process for longer commands.');
    }
    const result = await callRemoteDevice({
      context,
      deviceId,
      tool: 'shell_execute',
      arguments: { ...toolArguments, timeout_ms: remoteTimeoutMs },
      timeoutMs: remoteTimeoutMs + 2000
    });
    return boundedShellToolText(result);
  }

  if (toolName === 'list_devices') {
    const devices = deviceAccessPolicy.filterDevices(deviceBroker.listDevices({ accountId: context.accountId || null }), {
      callerSubject: context.callerSubject || context.callerCategory || 'anonymous',
      callerCategory: context.callerCategory || 'anonymous'
    });
    return structuredToolText({ ok: true, ...paginateDeviceInventory(devices, request.params.arguments || {}) }, { includeStructured: true });
  }

  if (PROCESS_TOOL_NAMES.has(toolName) && enableShell) {
    const args = request.params.arguments || {};
    const ownerKey = callerKey || 'anonymous';
    if (toolName === 'start_process') {
      const { deviceId, toolArguments } = requireDeviceId(args);
      const remote = await callRemoteDevice({
        context,
        deviceId,
        tool: 'start_process',
        arguments: toolArguments,
        timeoutMs: Math.min(Number(toolArguments.timeout_ms || 10000) + 2000, 30000)
      });
      const remoteSessionId = remote?.sessionId ?? remote?.session_id;
      if (!remoteSessionId) throw new Error('Remote start_process did not return a session identifier.');
      const sessionId = remoteProcessSessions.register({ ownerKey, deviceId, remoteSessionId });
      return structuredToolText({ ...remote, sessionId, session_id: sessionId }, { includeStructured: true });
    }
    const remoteSession = remoteProcessSessions.resolve({ sessionId: args.session_id, ownerKey });
    const remoteArgs = { ...args, session_id: remoteSession.remoteSessionId };
    const remoteTimeoutMs = toolName === 'read_process_output'
      ? 12000
      : Math.min(Number(args.timeout_ms || 10000) + 2000, 30000);
    const remote = await callRemoteDevice({
      context,
      deviceId: remoteSession.deviceId,
      tool: toolName,
      arguments: remoteArgs,
      timeoutMs: remoteTimeoutMs
    });
    if (toolName === 'terminate_process') {
      remoteProcessSessions.remove({ sessionId: args.session_id, ownerKey });
    }
    return structuredToolText({ ...remote, sessionId: args.session_id, session_id: args.session_id }, { includeStructured: true });
  }

  if (FILESYSTEM_TOOL_NAMES.has(toolName)) {
    const { deviceId, toolArguments } = requireDeviceId(request.params.arguments || {});
    const result = await callRemoteDevice({ context, deviceId, tool: toolName, arguments: toolArguments });
    const rendered = result && Array.isArray(result.content)
      ? normalizeRemoteFilesystemResult(result)
      : structuredToolText(result, { includeStructured: true });
    return appendSkillAdvisory(rendered, skillBootstrapGate.takeReadAdvisory(callerKey, toolName));
  }

  if (isLocalCustomTool(toolName)) {
    const result = await callCustomTool(toolName, request.params.arguments || {}, customToolContext(context));
    if (toolName === 'get_skill') skillBootstrapGate.markSkillLoaded(callerKey);
    return appendSkillAdvisory(result, skillBootstrapGate.takeReadAdvisory(callerKey, toolName));
  }

  if (externalMcpManager.isEagerToolName(toolName)) {
    return await externalMcpManager.callTool(toolName, request.params.arguments || {}, runtimeProfile);
  }
  if (externalMcpManager.isExternalToolName(toolName)) {
    throw new Error(`External MCP tool ${toolName} is deferred; use external_tool_search and the appropriate external_tool_call_* lane.`);
  }

  throw new Error(`Unknown or disabled tool: ${toolName}`);
}

async function routeObservedToolCall(request, context) {
  const toolName = request.params?.name || 'unknown';
  const startedAt = Date.now();
  console.log(`[tool-call:start] ${toolName}`);
  try {
    const result = await routeToolCall(request, context);
    const durationMs = Date.now() - startedAt;
    console.log(`[tool-call:finish] ${toolName} durationMs=${durationMs}`);
    if (durationMs > slowToolThresholdMs) console.log(`[tool-call:slow] ${toolName} durationMs=${durationMs}`);
    toolMetrics.record(buildToolMetric({
      toolName,
      args: request.params?.arguments || {},
      result,
      durationMs,
      callerCategory: context?.callerCategory,
      upstream: externalMcpManager.isExternalToolName(toolName) ? 'external-mcp' : null
    }));
    return result;
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    console.log(`[tool-call:error] ${toolName} durationMs=${durationMs}`);
    toolMetrics.record(buildToolMetric({
      toolName,
      args: request.params?.arguments || {},
      durationMs,
      callerCategory: context?.callerCategory,
      upstream: externalMcpManager.isExternalToolName(toolName) ? 'external-mcp' : null,
      error
    }));
    throw error;
  }
}

function currentResourceContext(callerContext = {}) {
  const snapshot = workspaceSnapshot();
  return {
    resolvedRepoRoots: snapshot.roots,
    resolvedRepoRoot: snapshot.roots[0],
    projectRegistry: snapshot.projectRegistry,
    surfaceConfig: currentSurfaceConfig(snapshot),
    accountId: callerContext.accountId || null,
    listVisibleDevices: () => deviceAccessPolicy.filterDevices(
      deviceBroker.listDevices({ accountId: callerContext.accountId || null }),
      {
        callerSubject: callerContext.callerSubject || callerContext.callerCategory || 'anonymous',
        callerCategory: callerContext.callerCategory || 'anonymous'
      }
    ),
    callDeviceTool: async (tool, args = {}) => {
      const { deviceId, toolArguments } = requireDeviceId(args);
      return await callRemoteDevice({ context: callerContext, deviceId, tool, arguments: toolArguments });
    },
    packageRoot,
    env: process.env,
    listTools: listMergedTools
  };
}

function createProxyServer({ accountId, callerKey, callerCategory, callerSubject }) {
  const metadata = workspaceSnapshot().server;
  const server = new Server(
    {
      name: metadata.name,
      title: metadata.title,
      version: '2.0.0',
      description: metadata.description
    },
    {
      instructions: [metadata.instructions, SKILL_AGENT_INSTRUCTIONS].filter(Boolean).join(' '),
      capabilities: {
        tools: { listChanged: true },
        resources: { subscribe: false, listChanged: true },
        prompts: { listChanged: true }
      }
    }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: await listMergedTools() }));
  server.setRequestHandler(CallToolRequestSchema, request => routeObservedToolCall(request, { accountId, callerKey, callerCategory, callerSubject }));
  const callerContext = { accountId, callerKey, callerCategory, callerSubject };
  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    const context = currentResourceContext(callerContext);
    return { resources: [...listRepoResources(context), ...await externalMcpManager.listResources()] };
  });
  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => {
    const context = currentResourceContext(callerContext);
    return { resourceTemplates: [...listRepoResourceTemplates(context), ...await externalMcpManager.listResourceTemplates()] };
  });
  server.setRequestHandler(ReadResourceRequestSchema, async request => {
    if (isExternalResourceUri(request.params.uri)) return await externalMcpManager.readResource(request.params.uri);
    return await readRepoResource(request.params.uri, currentResourceContext(callerContext));
  });
  server.setRequestHandler(ListPromptsRequestSchema, async () => ({
    prompts: [...listRepoPrompts({ runtimeProfile }), ...await externalMcpManager.listPrompts()]
  }));
  server.setRequestHandler(GetPromptRequestSchema, async request => {
    if (externalMcpManager.isExternalPromptName(request.params.name)) {
      return await externalMcpManager.getPrompt(request.params.name, request.params.arguments || {});
    }
    return getRepoPrompt(request.params.name, request.params.arguments || {}, { runtimeProfile });
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

function skillCallerKeyFromRequest(req) {
  return buildSkillCallerKey({
    accountId: req.auth?.accountId || '',
    oauthClientId: req.auth?.clientId || '',
    staticBearer: isStaticBearerAuthorization(req.headers.authorization, staticBearerToken),
    sessionId: useStatefulMcpSessions ? req.headers['mcp-session-id'] || '' : ''
  });
}

function callerCategoryFromRequest(req) {
  if (isStaticBearerAuthorization(req.headers.authorization, staticBearerToken)) return 'static-bearer';
  if (req.auth?.clientId) return 'oauth';
  return 'anonymous';
}

function callerSubjectFromRequest(req) {
  if (isStaticBearerAuthorization(req.headers.authorization, staticBearerToken)) return 'static-bearer';
  if (req.auth?.accountId) return `account:${req.auth.accountId}`;
  return 'anonymous';
}

function getProvidedAuthorizationToken(authorizationHeader) {
  if (typeof authorizationHeader !== 'string') {
    return '';
  }

  const header = authorizationHeader.trim();
  const match = header.match(/^Bearer\s+(.+)$/i);
  return (match ? match[1] : header).trim();
}

await refreshDeviceSchemaSnapshot();
const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: false }));
const accountHttp = installAccountRoutes(app, {
  accountStore,
  needInvite: () => workspaceSnapshot().rawConfig?.auth?.need_invite !== false
});
const oauthStateStore = new SQLiteAuthState(gatewayDbPath);
const provider = new AccountAuthProvider({
  stateStore: oauthStateStore,
  accountStore,
  accountFromRequest: accountHttp.accountFromRequest
});
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

installDevicePairingRoutes(app, {
  pairingStore: devicePairingStore,
  accountFromRequest: accountHttp.accountFromRequest,
  baseUrlFromRequest: requestBaseUrl
});

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
    scopesSupported: AUTH_SUPPORTED_SCOPES,
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

async function createTransport(req) {
  let transport;
  const server = createProxyServer({
    accountId: req.auth?.accountId || null,
    callerKey: skillCallerKeyFromRequest(req),
    callerCategory: callerCategoryFromRequest(req),
    callerSubject: callerSubjectFromRequest(req)
  });

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
      transport = await createTransport(req);
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
  console.log(`Filesystem tools enabled: ${enableFilesystem}`);
  console.log(`Shell tools enabled: ${enableShell}`);
  console.log(`Runtime profile: ${runtimeProfile.name}`);
  console.log(`Static bearer enabled: ${staticBearerToken ? 'true' : 'false'}`);
  console.log(`MCP transport mode: ${useStatefulMcpSessions ? 'stateful' : 'stateless'}`);
});

deviceBroker.attach(serverInstance);

async function shutdown() {
  serverInstance.close();
  stopSkillCatalogWatcher();
  workspaceRegistry.close();
  toolMetrics.close();
  deviceAudit.close();
  await deviceBroker.shutdown().catch(() => {});
  try { oauthStateStore.close(); } catch {}
  try { accountStore.close(); } catch {}
  try { deviceUsageStore.close(); } catch {}
  try { devicePairingStore.close(); } catch {}
  try { deviceStore.close(); } catch {}
  await externalMcpManager.shutdown().catch(() => {});
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
