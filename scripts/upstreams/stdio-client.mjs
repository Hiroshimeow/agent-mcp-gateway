import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    })
  ]);
}

export async function createStdioUpstreamClient(serverConfig) {
  const transport = new StdioClientTransport({
    command: serverConfig.command,
    args: serverConfig.args || [],
    cwd: serverConfig.cwd,
    stderr: 'pipe',
    windowsHide: true
  });
  let stderr = '';
  let running = true;
  transport.stderr?.on?.('data', chunk => {
    stderr = `${stderr}${chunk.toString()}`.slice(-4000);
  });
  transport.onclose = () => { running = false; };
  const client = new Client({ name: `agent-mcp-gateway-upstream-${serverConfig.id}`, version: '1.0.0' }, { capabilities: {} });
  await withTimeout(client.connect(transport), serverConfig.startupTimeoutMs || 15000, `upstream ${serverConfig.id} initialize`);
  const capabilities = client.getServerCapabilities?.() || {};
  return {
    id: serverConfig.id,
    config: serverConfig,
    client,
    transport,
    capabilities,
    get pid() { return transport.pid; },
    get stderr() { return stderr; },
    isRunning() { return running && Boolean(transport.pid); },
    kill(signal = 'SIGTERM') {
      if (!running) return false;
      const pid = transport.pid;
      if (!pid) return false;
      try {
        process.kill(pid, signal);
        return true;
      } catch {
        running = false;
        return false;
      }
    },
    async listTools() { return await client.listTools(); },
    async callTool(params) { return await client.callTool(params); },
    async listResources() { return await client.listResources(); },
    async listResourceTemplates() { return await client.listResourceTemplates(); },
    async readResource(params) { return await client.readResource(params); },
    async listPrompts() { return await client.listPrompts(); },
    async getPrompt(params) { return await client.getPrompt(params); },
    async close() {
      await client.close().catch(() => {});
      await transport.close().catch(() => {});
      running = false;
    }
  };
}
