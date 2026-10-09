import type Database from 'better-sqlite3';

import { OpenClawHookConfigSyncService } from './openclawHookConfigSyncService';
import { OpenClawHookStore } from './openclawHookStore';

type OpenClawHookServicesDeps = {
  getDatabase: () => Database.Database;
  syncOpenClawConfig: (options: {
    reason: string;
  }) => Promise<{ success: boolean; changed: boolean; error?: string }>;
};

export class OpenClawHookServices {
  private readonly deps: OpenClawHookServicesDeps;
  private store: OpenClawHookStore | null = null;
  private configSyncService: OpenClawHookConfigSyncService | null = null;

  constructor(deps: OpenClawHookServicesDeps) {
    this.deps = deps;
  }

  getStore(): OpenClawHookStore {
    if (!this.store) {
      this.store = new OpenClawHookStore(this.deps.getDatabase());
    }
    return this.store;
  }

  syncConfig(): Promise<{ hooks: number; error?: string }> {
    return this.getConfigSyncService().syncConfig();
  }

  syncConfigAfterExclusiveMutation(
    syncOpenClawConfig: OpenClawHookServicesDeps['syncOpenClawConfig'],
  ): Promise<{ hooks: number; error?: string }> {
    return this.getConfigSyncService().syncConfigAfterExclusiveMutation(syncOpenClawConfig);
  }

  private getConfigSyncService(): OpenClawHookConfigSyncService {
    if (!this.configSyncService) {
      this.configSyncService = new OpenClawHookConfigSyncService({
        getHookStore: () => this.getStore(),
        syncOpenClawConfig: this.deps.syncOpenClawConfig,
      });
    }
    return this.configSyncService;
  }
}
