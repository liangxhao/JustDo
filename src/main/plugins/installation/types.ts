import type { MarketplaceInstallOperation, PluginKind } from '../../../shared/plugins/marketplace';
import type { McpServerFormData } from '../mcp';

export const PluginInstallOrigin = {
  CUSTOM: 'custom',
  MARKETPLACE: 'marketplace',
} as const;

export type PluginInstallOrigin = (typeof PluginInstallOrigin)[keyof typeof PluginInstallOrigin];

export type PluginInstallPayload =
  | {
      kind: typeof PluginKind.EXTENSION | typeof PluginKind.SKILL | typeof PluginKind.HOOK;
      sourcePath: string;
    }
  | {
      kind: typeof PluginKind.MCP;
      config: Partial<McpServerFormData>;
      targetId?: string;
    };

export interface PluginInstallRequest {
  operation: MarketplaceInstallOperation;
  origin: PluginInstallOrigin;
  payload: PluginInstallPayload;
  marketplacePluginId?: string;
  onProgress?: (progress: { stage: string; percent: number }) => void;
}

export interface PluginInstallResult {
  success: boolean;
  pluginId?: string;
  restartRequired?: boolean;
  failedStage?: string;
  error?: string;
}

export interface PluginInstaller {
  readonly kind: PluginKind;
  install(request: PluginInstallRequest): Promise<PluginInstallResult>;
}

export interface PreparedMarketplaceInstall {
  payload: PluginInstallPayload;
  cleanup?: () => void | Promise<void>;
}
