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
      reviewToken?: string;
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
  operationContext?: import('../../../shared/plugins/pluginOperation').PluginOperationContext;
  onProgress?: (progress: { stage: string; percent: number }) => void;
}

export interface PluginInstallResult {
  success: boolean;
  /** The installation persisted, even if applying the runtime state subsequently failed. */
  installationCommitted?: true;
  /** A native operation may still be reading the prepared source; its path stays Main-only. */
  installSourceInUse?: true;
  operationUnconfirmed?: true;
  refreshWarning?: true;
  pluginId?: string;
  /** Internal install location used to disambiguate layered capabilities. Never expose over IPC. */
  installPath?: string;
  restartRequired?: boolean;
  failedStage?: string;
  error?: string;
  capabilityReview?: import('../../../shared/plugins/extensions').OpenClawPluginCapabilityReview;
}

export interface PluginInstaller {
  readonly kind: PluginKind;
  install(request: PluginInstallRequest): Promise<PluginInstallResult>;
}

export interface PreparedMarketplaceInstall {
  payload: PluginInstallPayload;
  cleanup?: () => void | Promise<void>;
}
