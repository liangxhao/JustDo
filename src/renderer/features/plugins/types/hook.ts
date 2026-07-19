export interface HookMissing {
  bins: string[];
  anyBins?: string[];
  env: string[];
  config: string[];
  os: string[];
}

export interface HookEntry {
  id: string;
  name: string;
  description: string;
  emoji?: string;
  enabled: boolean;
  eligible: boolean;
  requirementsSatisfied: boolean;
  loadable: boolean;
  blockedReason?: string;
  source: string;
  pluginId?: string;
  events: string[];
  homepage?: string;
  filePath?: string;
  baseDir?: string;
  handlerPath?: string;
  missing: HookMissing;
  managedByPlugin: boolean;
}

export interface HookListResult {
  success: boolean;
  hooks?: HookEntry[];
  workspaceDir?: string;
  managedHooksDir?: string;
  error?: string;
  gatewayOffline?: boolean;
  restartRequired?: boolean;
  hookId?: string;
}
