import type { PluginHubScope, PluginManagementCapabilities } from './management';

export const ExtensionIpc = {
  List: 'extensions:list',
  Import: 'extensions:import',
  ImportProgress: 'extensions:import-progress',
  Delete: 'extensions:delete',
  SetEnabled: 'extensions:set-enabled',
  UpdateConfiguration: 'extensions:update-configuration',
  Changed: 'extensions:changed',
} as const;

export type ExtensionChangedEvent = {
  extensionId: string;
  enabled: boolean;
};

export type OpenClawExtensionConfigurationField = {
  path: string;
  label: string;
  help?: string;
  labelKey?: string;
  helpKey?: string;
  type?: 'integer' | 'number';
  minimum?: number;
  maximum?: number;
  defaultValue?: number;
  value?: number;
  requirement?: string;
  /** Native provider credential alternatives; saved to env.vars, never plugin config. */
  environmentVariables?: string[];
  configuredEnvironmentVariables?: string[];
  inheritedEnvironmentVariables?: string[];
  sensitive: boolean;
  configured: boolean;
};

export type InstalledOpenClawExtension = {
  id: string;
  name: string;
  description: string;
  version?: string;
  installPath?: string;
  enabled: boolean;
  state?: 'enabled' | 'disabled' | 'error';
  origin?: string;
  category?: string;
  kinds?: string[];
  error?: string;
  removable?: boolean;
  canToggle?: boolean;
  managed?: boolean;
  missingRequirements: string[];
  configurationFields: OpenClawExtensionConfigurationField[];
  scope?: PluginHubScope;
  management?: PluginManagementCapabilities;
};

export type ExtensionUpdateConfigurationRequest = {
  extensionId: string;
  values: Record<string, string>;
};

export type ExtensionUpdateConfigurationResult = {
  success: boolean;
  error?: string;
  pending?: boolean;
};

export type ExtensionSetEnabledRequest = {
  extensionId: string;
  enabled: boolean;
  reviewToken?: string;
};

export type OpenClawPluginDeclaredSurface = {
  channels: string[];
  providers: string[];
  tools: string[];
  contracts: string[];
  hooks: string[];
  mcpServers: string[];
  cliCommands: string[];
  cliBackends: string[];
  skills: string[];
  dangerousConfigFlags: string[];
};

export type OpenClawPluginCapabilityReview = {
  reviewToken: string;
  declared: OpenClawPluginDeclaredSurface;
  widened?: Partial<OpenClawPluginDeclaredSurface>;
  source?: {
    kind:
      | 'bundled'
      | 'clawhub'
      | 'npm'
      | 'git'
      | 'path'
      | 'archive'
      | 'marketplace'
      | 'official-catalog';
    spec?: string;
    packageName?: string;
    integrity?: string;
    integrityKind?: 'ssri' | 'sha256' | 'git-commit';
  };
  grants: {
    hooks: {
      allowPromptInjection: { effective: boolean; configured?: boolean };
      allowConversationAccess: { effective: boolean; configured?: boolean };
    };
    llm?: {
      allowModelOverride?: boolean;
      allowedModels?: string[];
      allowedCompletionModels?: string[];
      allowAuthProfileOverride?: boolean;
      allowAgentIdOverride?: boolean;
    };
    subagent?: {
      allowModelOverride?: boolean;
      allowedModels?: string[];
    };
  };
  trust?: {
    disposition: 'clean' | 'review-recommended' | 'review-required' | 'blocked';
    reasons?: string[];
    checkedAt?: string;
    acknowledgedAt?: string;
    pending?: boolean;
    stale?: boolean;
  };
};

export type ExtensionSetEnabledResult = {
  success: boolean;
  error?: string;
  warnings?: string[];
  capabilityReview?: OpenClawPluginCapabilityReview;
};

export type ExtensionDeleteRequest = {
  extensionId: string;
};

export type ExtensionDeleteResult = {
  success: boolean;
  error?: string;
  warnings?: string[];
};

export type ExtensionImportStage =
  | 'preparing'
  | 'extracting'
  | 'validating'
  | 'preparing_runtime'
  | 'installing'
  | 'installing_dependencies'
  | 'restarting_gateway'
  | 'completed';

export type ExtensionImportRequest = {
  requestId: string;
  sourcePath: string;
  reviewToken?: string;
};

export type ExtensionImportProgress = ExtensionImportRequest & {
  stage: ExtensionImportStage;
  percent: number;
};

export type ExtensionImportResult = {
  success: boolean;
  extensionId?: string;
  error?: string;
  failedStage?: ExtensionImportStage;
  capabilityReview?: OpenClawPluginCapabilityReview;
};
