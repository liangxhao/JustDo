import type Database from 'better-sqlite3';

import { McpConfigSyncService } from './mcpConfigSyncService';
import { McpStore } from './mcpStore';

type McpServicesDeps = {
  getDatabase: () => Database.Database;
  syncOpenClawConfig: (options: {
    reason: string;
    restartGatewayIfRunning?: boolean;
  }) => Promise<{ success: boolean; changed: boolean; error?: string }>;
};

export class McpServices {
  private readonly deps: McpServicesDeps;
  private store: McpStore | null = null;
  private configSyncService: McpConfigSyncService | null = null;

  constructor(deps: McpServicesDeps) {
    this.deps = deps;
  }

  getStore(): McpStore {
    if (!this.store) {
      this.store = new McpStore(this.deps.getDatabase());
    }
    return this.store;
  }

  syncConfig(): Promise<{ tools: number; error?: string }> {
    return this.getConfigSyncService().syncConfig();
  }

  private getConfigSyncService(): McpConfigSyncService {
    if (!this.configSyncService) {
      this.configSyncService = new McpConfigSyncService({
        getMcpStore: () => this.getStore(),
        syncOpenClawConfig: this.deps.syncOpenClawConfig,
      });
    }
    return this.configSyncService;
  }
}
