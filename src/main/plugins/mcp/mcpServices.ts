import type Database from 'better-sqlite3';

import type { OpenClawEngineManager } from '../../openclaw/runtime/openclawEngineManager';
import { runExtensionMcpOperation } from './extensionMcpRuntime';
import {
  McpProbeResult,
  McpReadResourceResult,
  probeMcpServer,
  readMcpResource,
} from './mcpProbeService';
import { McpStore } from './mcpStore';

type McpServicesDeps = {
  getDatabase: () => Database.Database;
  getManager: () => OpenClawEngineManager;
};

export class McpServices {
  private readonly deps: McpServicesDeps;
  private store: McpStore | null = null;

  constructor(deps: McpServicesDeps) {
    this.deps = deps;
  }

  getStore(): McpStore {
    if (!this.store) {
      this.store = new McpStore(this.deps.getDatabase());
    }
    return this.store;
  }

  async probeServer(id: string): Promise<McpProbeResult> {
    if (id.startsWith('extension:')) {
      return runExtensionMcpOperation(this.deps.getManager(), 'probe', id);
    }
    const server = this.getStore().getServer(id);
    if (!server) {
      return {
        available: false,
        tools: [],
        resources: [],
        prompts: [],
        latencyMs: 0,
        error: 'MCP server not found',
      };
    }
    return probeMcpServer(server);
  }

  readExtensionDefinition(id: string): Promise<Record<string, unknown> | null> {
    return runExtensionMcpOperation(this.deps.getManager(), 'settings', id);
  }

  async readResource(id: string, uri: string): Promise<McpReadResourceResult> {
    if (id.startsWith('extension:')) {
      return runExtensionMcpOperation(this.deps.getManager(), 'read', id, uri);
    }
    const server = this.getStore().getServer(id);
    if (!server) {
      throw new Error('MCP server not found');
    }
    return readMcpResource(server, uri);
  }
}
