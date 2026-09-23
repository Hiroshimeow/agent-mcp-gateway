import { listCustomTools } from './custom-tools/index.mjs';
import { listDevicesToolDefinition } from './device-inventory.mjs';
import { buildShellExecuteAnnotations, buildShellExecuteDescription } from './shell-tool-descriptor.mjs';
import { applyToolRisk } from './tool-risk.mjs';
import { stableToolDefinition } from './tool-surface-stability.mjs';

export const DEVICE_EXECUTION_TOOL_NAMES = Object.freeze([
  'read_text_file',
  'write_file',
  'edit_file',
  'shell_execute',
  'start_process',
  'read_process_output',
  'interact_with_process',
  'terminate_process',
  'image_preview',
  'project_inspect'
]);

export const DEVICE_PUBLIC_TOOL_NAMES = Object.freeze([
  'list_devices',
  'project_list',
  ...DEVICE_EXECUTION_TOOL_NAMES
]);

export const shellExecuteSchema = {
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

export const processToolSchemas = {
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

export const shellExecuteOutputSchema = {
  type: 'object',
  properties: {
    workingDirectoryResolved: { type: 'string' },
    exitCode: { type: 'number' },
    stdout: { type: 'string' },
    stderr: { type: 'string' },
    timedOut: { type: 'boolean' },
    stdoutTruncated: { type: 'boolean' },
    stderrTruncated: { type: 'boolean' },
    stdoutBytes: { type: 'number' },
    stderrBytes: { type: 'number' },
    stdoutSpillPath: {},
    stderrSpillPath: {}
  }
};

export const FILESYSTEM_TOOL_DEFINITIONS = [
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
    description: 'Make one exact guarded text replacement on one explicit owned online device.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        old_text: { type: 'string', minLength: 1, description: 'Exact text to replace. No fuzzy matching is applied.' },
        new_text: { type: 'string', description: 'Replacement text.' },
        expected_replacements: { type: 'integer', minimum: 1, default: 1, description: 'Required exact occurrence count before mutation.' },
        dry_run: { type: 'boolean', default: false, description: 'Validate without writing.' }
      },
      required: ['path', 'old_text', 'new_text'],
      additionalProperties: false
    },
    outputSchema: { type: 'object', properties: { content: { type: 'string' } }, required: ['content'], additionalProperties: false }
  }
];

const PROCESS_TOOL_DESCRIPTIONS = {
  start_process: 'Start a command with retained bounded output. Short commands may complete immediately; long commands return RUNNING plus sessionId after timeout_ms without being killed.',
  read_process_output: 'Read a bounded page of retained process output using absolute offset/length. Completed output remains available for a bounded retention period.',
  interact_with_process: 'Write raw stdin to a running process session and optionally wait briefly for progress.',
  terminate_process: 'Terminate a caller-owned running process session and its process tree where supported.'
};

export function withRequiredDeviceId(inputSchema = {}) {
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

export function filesystemToolMeta(tool) {
  return stableToolDefinition(applyToolRisk({
    ...tool,
    inputSchema: withRequiredDeviceId(tool.inputSchema),
    name: tool.name,
    description: tool.description
  }));
}

export function shellExecuteToolMeta() {
  return stableToolDefinition(applyToolRisk({
    name: 'shell_execute',
    description: buildShellExecuteDescription(),
    inputSchema: shellExecuteSchema,
    outputSchema: shellExecuteOutputSchema,
    annotations: buildShellExecuteAnnotations()
  }));
}

export function listProcessTools() {
  return Object.keys(processToolSchemas).map(name => applyToolRisk({
    name,
    description: PROCESS_TOOL_DESCRIPTIONS[name],
    inputSchema: processToolSchemas[name]
  }));
}

export function listStaticDeviceExecutionTools() {
  const customByName = new Map(listCustomTools().map(tool => [tool.name, tool]));
  const tools = [
    ...FILESYSTEM_TOOL_DEFINITIONS.map(filesystemToolMeta),
    shellExecuteToolMeta(),
    ...listProcessTools(),
    customByName.get('image_preview'),
    customByName.get('project_inspect')
  ].filter(Boolean);
  const byName = new Map(tools.map(tool => [tool.name, tool]));
  return DEVICE_EXECUTION_TOOL_NAMES.map(name => {
    const tool = byName.get(name);
    if (!tool) throw new Error(`Missing static device execution tool definition: ${name}`);
    return tool;
  });
}

export function listStaticDevicePublicTools() {
  const customByName = new Map(listCustomTools().map(tool => [tool.name, tool]));
  const tools = [
    applyToolRisk(listDevicesToolDefinition()),
    customByName.get('project_list'),
    ...listStaticDeviceExecutionTools()
  ].filter(Boolean);
  const byName = new Map(tools.map(tool => [tool.name, tool]));
  return DEVICE_PUBLIC_TOOL_NAMES.map(name => {
    const tool = byName.get(name);
    if (!tool) throw new Error(`Missing static device public tool definition: ${name}`);
    return tool;
  });
}
