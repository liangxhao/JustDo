import type {
  AgentFileName,
  AgentFileSnapshot,
  AgentProfileInput,
  AgentResult,
} from '../../shared/agents/agents';
type SessionRunUnknownInput = import('../../shared/cowork/sessionRun').SessionRunUnknownInput;
type BrowserRecordingLease = import('../../shared/browser/browserRecording').BrowserRecordingLease;
type CoworkAttachmentPayload = import('../../shared/cowork/attachments').CoworkAttachmentPayload;
type BeginSessionRunInput = import('../../shared/cowork/sessionRun').BeginSessionRunInput;
type SessionRunBeginErrorCode = import('../../shared/cowork/sessionRun').SessionRunBeginErrorCode;
type SessionRunTiming = import('../../shared/cowork/sessionRun').SessionRunTiming;
type SessionRuntimeSnapshot = import('../../shared/cowork/sessionRun').SessionRuntimeSnapshot;
type ExternalSessionMetadata = import('../../shared/integrations/multica').ExternalSessionMetadata;
type MulticaIntegrationResult = import('../../shared/integrations/multica').MulticaIntegrationResult;
type MulticaIntegrationStatus = import('../../shared/integrations/multica').MulticaIntegrationStatus;
type CoworkSessionDetailsResult =
  import('../../shared/cowork/sessionDetails').CoworkSessionDetailsResult<CoworkSession>;
type CoworkSubagentDetailsResult =
  import('../../shared/cowork/subagentDetails').CoworkSubagentDetailsResult;
type CoworkSubagentDescendantsResult =
  import('../../shared/cowork/subagentDetails').CoworkSubagentDescendantsResult;
type CoworkSubtaskChangedEvent =
  import('../../shared/cowork/subagentDetails').CoworkSubtaskChangedEvent;
type GenerateSessionTitleRequest =
  import('../../shared/cowork/sessionTitle').GenerateSessionTitleRequest;
type SaveTextFileOptions = import('../../shared/app/dialogIpc').SaveTextFileOptions;
type SaveTextFileResult = import('../../shared/app/dialogIpc').SaveTextFileResult;
type TerminalActionResult = import('../../shared/app/terminal').TerminalActionResult;
type TerminalCreateRequest = import('../../shared/app/terminal').TerminalCreateRequest;
type TerminalCreateResult = import('../../shared/app/terminal').TerminalCreateResult;
type TerminalDataEvent = import('../../shared/app/terminal').TerminalDataEvent;
type TerminalExitEvent = import('../../shared/app/terminal').TerminalExitEvent;
type TerminalResizeRequest = import('../../shared/app/terminal').TerminalResizeRequest;
type TerminalWriteRequest = import('../../shared/app/terminal').TerminalWriteRequest;
type ExtensionImportProgress = import('../../shared/openclaw/extensions').ExtensionImportProgress;
type ExtensionChangedEvent = import('../../shared/openclaw/extensions').ExtensionChangedEvent;
type ExtensionImportRequest = import('../../shared/openclaw/extensions').ExtensionImportRequest;
type ExtensionImportStage = import('../../shared/openclaw/extensions').ExtensionImportStage;
type ExtensionDeleteRequest = import('../../shared/openclaw/extensions').ExtensionDeleteRequest;
type ExtensionDeleteResult = import('../../shared/openclaw/extensions').ExtensionDeleteResult;
type ExtensionSetEnabledRequest =
  import('../../shared/openclaw/extensions').ExtensionSetEnabledRequest;
type ExtensionSetEnabledResult =
  import('../../shared/openclaw/extensions').ExtensionSetEnabledResult;
type ExtensionUpdateConfigurationRequest =
  import('../../shared/openclaw/extensions').ExtensionUpdateConfigurationRequest;
type ExtensionUpdateConfigurationResult =
  import('../../shared/openclaw/extensions').ExtensionUpdateConfigurationResult;
type InstalledOpenClawExtension =
  import('../../shared/openclaw/extensions').InstalledOpenClawExtension;
type OpenClawSkillSource = import('../../shared/plugins/skills').OpenClawSkillSource;
type PluginHubScope = import('../../shared/plugins/management').PluginHubScope;
type PluginManagementCapabilities =
  import('../../shared/plugins/management').PluginManagementCapabilities;
type SystemPromptReplacementRule =
  import('../../shared/openclaw/systemPromptReplacements').SystemPromptReplacementRule;
type PermissionMode = import('../../shared/openclaw/approvals').PermissionMode;
type ApprovalKind = import('../../shared/openclaw/approvals').ApprovalKind;
type ApprovalRequest = import('../../shared/openclaw/approvals').ApprovalRequest;
type ApprovalResolved = import('../../shared/openclaw/approvals').ApprovalResolved;
type ApprovalDecision = import('../../shared/openclaw/approvals').ApprovalDecision;
type AgentRuntimeSettings =
  import('../../shared/openclaw/agentRuntimeSettings').AgentRuntimeSettings;
type ExternalAgentSettings = import('../../shared/openclaw/externalAgents').ExternalAgentSettings;
type ExternalAgentId = import('../../shared/openclaw/externalAgents').ExternalAgentId;
type ExternalAgentTestResult =
  import('../../shared/openclaw/externalAgents').ExternalAgentTestResult;
type OpenClawSessionMigrationPlan =
  import('../../shared/openclaw/sessionMigration').OpenClawSessionMigrationPlan;
type OpenClawSessionMigrationProgress =
  import('../../shared/openclaw/sessionMigration').OpenClawSessionMigrationProgress;
type OpenClawSessionMigrationConfirmRequest =
  import('../../shared/openclaw/sessionMigration').OpenClawSessionMigrationConfirmRequest;
type OpenClawSessionMigrationResult =
  import('../../shared/openclaw/sessionMigration').OpenClawSessionMigrationResult;
type AppUpdateActionResult = import('../../shared/app/appUpdate').AppUpdateActionResult;
type AppUpdateState = import('../../shared/app/appUpdate').AppUpdateState;
type BrowserActionResult = import('../../shared/browser/browser').BrowserActionResult;
type BrowserAgentInteractionState = import('../../shared/browser/browser').BrowserAgentInteractionState;
type BrowserAgentInteractionReady = import('../../shared/browser/browser').BrowserAgentInteractionReady;
type BrowserImportRequest = import('../../shared/browser/browser').BrowserImportRequest;
type BrowserImportResult = import('../../shared/browser/browser').BrowserImportResult;
type BrowserImportSourcesResult = import('../../shared/browser/browser').BrowserImportSourcesResult;
type BrowserLocalHtmlPreviewResult = import('../../shared/browser/browser').BrowserLocalHtmlPreviewResult;
type BrowserHistoryListResult = import('../../shared/browser/browser').BrowserHistoryListResult;
type BrowserDownloadListResult = import('../../shared/browser/browser').BrowserDownloadListResult;
type BrowserConnectionTestResult = import('../../shared/browser/browser').BrowserConnectionTestResult;
type BrowserClearDataRange = import('../../shared/browser/browser').BrowserClearDataRange;
type BrowserClearDataRequest = import('../../shared/browser/browser').BrowserClearDataRequest;
type BrowserClearDataResult = import('../../shared/browser/browser').BrowserClearDataResult;
type BrowserClearDataSummaryResult = import('../../shared/browser/browser').BrowserClearDataSummaryResult;
type BrowserMode = import('../../shared/browser/browser').BrowserMode;
type BrowserModeSwitchAvailabilityResult =
  import('../../shared/browser/browser').BrowserModeSwitchAvailabilityResult;
type BrowserModeUpdateResult = import('../../shared/browser/browser').BrowserModeUpdateResult;
type BrowserPdfLoadRequest = import('../../shared/browser/browser').BrowserPdfLoadRequest;
type BrowserPdfLoadResult = import('../../shared/browser/browser').BrowserPdfLoadResult;
type BrowserPanelOpenTabEvent = import('../../shared/browser/browser').BrowserPanelOpenTabEvent;
type BrowserPanelHttpAuthRequest = import('../../shared/browser/browser').BrowserPanelHttpAuthRequest;
type BrowserPanelHttpAuthResponse = import('../../shared/browser/browser').BrowserPanelHttpAuthResponse;
type BrowserPanelPdfDetectedEvent = import('../../shared/browser/browser').BrowserPanelPdfDetectedEvent;
type BrowserAgentSessionEvent = import('../../shared/browser/browser').BrowserAgentSessionEvent;
type BrowserAgentTabReference = import('../../shared/browser/browser').BrowserAgentTabReference;
type BrowserAgentTabRegistration = import('../../shared/browser/browser').BrowserAgentTabRegistration;
type BrowserPanelShortcutAction = import('../../shared/browser/browser').BrowserPanelShortcutAction;
type BrowserPanelShortcutSettings = import('../../shared/browser/browser').BrowserPanelShortcutSettings;
type BrowserStatusResult = import('../../shared/browser/browser').BrowserStatusResult;
type ApiFetchOptions = import('../../shared/network/network').ApiFetchOptions;
type FilePreviewReadResult = import('../../shared/preview/filePreview').FilePreviewReadResult;
type FilePreviewEditAuthorizationRequest =
  import('../../shared/preview/filePreview').FilePreviewEditAuthorizationRequest;
type FilePreviewEditAuthorizationResult =
  import('../../shared/preview/filePreview').FilePreviewEditAuthorizationResult;
type FilePreviewWriteRequest = import('../../shared/preview/filePreview').FilePreviewWriteRequest;
type FilePreviewWriteResult = import('../../shared/preview/filePreview').FilePreviewWriteResult;
type WorkspaceDirectoryListResult = import('../../shared/preview/filePreview').WorkspaceDirectoryListResult;
type WorkboardCard = import('../../shared/openclaw/workboard').WorkboardCard;
type WorkboardCardInput = import('../../shared/openclaw/workboard').WorkboardCardInput;
type WorkboardCardPatch = import('../../shared/openclaw/workboard').WorkboardCardPatch;
type WorkboardChangedEvent = import('../../shared/openclaw/workboard').WorkboardChangedEvent;
type WorkboardDispatchSummary = import('../../shared/openclaw/workboard').WorkboardDispatchSummary;
type WorkboardResult<T = undefined> = import('../../shared/openclaw/workboard').WorkboardResult<T>;
type WorkboardSnapshot = import('../../shared/openclaw/workboard').WorkboardSnapshot;
type WorkboardStatus = import('../../shared/openclaw/workboard').WorkboardStatus;
type WorkboardStartResult = import('../../shared/openclaw/workboard').WorkboardStartResult;
type WorkboardStopIdentity = import('../../shared/openclaw/workboard').WorkboardStopIdentity;
type WorkboardSessionResolution =
  import('../../shared/openclaw/workboard').WorkboardSessionResolution;

interface ApiResponse<T = unknown> {
  ok: boolean;
  status: number;
  statusText: string;
  headers: Record<string, string>;
  data: T;
  error?: string;
}

// Cowork types for IPC
interface CoworkSession {
  id: string;
  title: string;
  status: 'idle' | 'running' | 'completed' | 'error';
  pinned: boolean;
  cwd: string;
  executionMode: 'auto' | 'local' | 'sandbox';
  permissionMode: PermissionMode;
  activeSkillIds: string[];
  agentId: string;
  modelRef?: string;
  handoffSource?: import('../../shared/agents/agents').AgentHandoffSource;
  forkSource?: {
    sessionId?: string;
    title: string;
    entryId: string;
  };
  external?: ExternalSessionMetadata;
  createdAt: number;
  updatedAt: number;
}

interface CoworkSessionSummary {
  id: string;
  title: string;
  status: 'idle' | 'running' | 'completed' | 'error';
  pinned: boolean;
  groupId?: string | null;
  agentId?: string;
  external?: ExternalSessionMetadata;
  createdAt: number;
  updatedAt: number;
}

interface SessionGroup {
  id: string;
  name: string;
  color: string;
  sortOrder: number;
  createdAt: number;
}

interface CoworkConfig {
  workingDirectory: string;
  executionMode: 'auto' | 'local' | 'sandbox';
  sandboxNetworkEnabled: boolean;
  agentEngine: 'openclaw';
  permissionMode: PermissionMode;
  maxGoalContinuationTurns: number;
  maxRetainedDisplayTabs: number;
}

type CoworkConfigUpdate = Partial<
  Pick<
    CoworkConfig,
    | 'workingDirectory'
    | 'executionMode'
    | 'sandboxNetworkEnabled'
    | 'agentEngine'
    | 'permissionMode'
    | 'maxGoalContinuationTurns'
    | 'maxRetainedDisplayTabs'
  >
>;

interface CoworkInteractionRequest {
  sessionId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  requestId: string;
  toolUseId?: string | null;
  interactionKind?: import('../../shared/openclaw/extensions').CoworkInteractionKind;
}

interface CoworkApiConfig {
  apiKey: string;
  baseURL: string;
  model: string;
  headers?: Record<string, string>;
  apiType?: 'openai';
}

type OpenClawEnginePhase = 'ready' | 'starting' | 'running' | 'error';

interface OpenClawEngineStatus {
  phase: OpenClawEnginePhase;
  version: string | null;
  message?: string;
  canRetry: boolean;
}

interface WindowState {
  isMaximized: boolean;
  isFullscreen: boolean;
  isFocused: boolean;
}

interface Skill {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  isOfficial: boolean;
  isBuiltIn: boolean;
  updatedAt: number;
  prompt: string;
  skillPath: string;
  // Gateway extended fields
  source?: OpenClawSkillSource;
  eligible?: boolean;
  missing?: {
    bins: string[];
    env: string[];
    config: string[];
    os: string[];
  };
  install?: Array<{
    id: string;
    kind: 'brew' | 'node' | 'go' | 'uv' | 'download' | 'script';
    label: string;
    bins?: string[];
    formula?: string;
    url?: string;
  }>;
  emoji?: string;
  homepage?: string;
  scope: PluginHubScope;
  ownershipScope: PluginHubScope;
  management: PluginManagementCapabilities;
}

type CoworkInteractionResult =
  | {
      behavior: 'submit';
      updatedInput?: Record<string, unknown>;
      toolUseID?: string;
    }
  | {
      behavior: 'cancel';
      message: string;
      interrupt?: boolean;
      toolUseID?: string;
    }
  | {
      behavior: 'plan';
      decision: 'implement' | 'revise' | 'cancel';
      feedback?: string;
    };

interface McpServerConfigIPC {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  transportType: 'stdio' | 'sse' | 'http';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  requestTimeoutSeconds?: number;
  isBuiltIn: boolean;
  githubUrl?: string;
  registryId?: string;
  createdAt: number;
  updatedAt: number;
}

interface McpProbeResultIPC {
  available: boolean;
  serverName?: string;
  serverVersion?: string;
  instructions?: string;
  capabilities?: {
    tools: boolean;
    resources: boolean;
    prompts: boolean;
  };
  tools: Array<{
    name: string;
    title?: string;
    description?: string;
    inputSchema?: unknown;
    outputSchema?: unknown;
  }>;
  resources: Array<{
    uri: string;
    name: string;
    title?: string;
    description?: string;
    mimeType?: string;
  }>;
  prompts: Array<{
    name: string;
    title?: string;
    description?: string;
    arguments?: Array<{
      name: string;
      description?: string;
      required?: boolean;
    }>;
  }>;
  latencyMs: number;
  error?: string;
}

interface McpReadResourceResultIPC {
  contents: Array<{
    uri?: string;
    mimeType?: string;
    text?: string;
    blob?: string;
    [key: string]: unknown;
  }>;
}

interface HookEntryIPC {
  id?: string;
  hookKey?: string;
  name: string;
  description: string;
  emoji?: string;
  eligible: boolean;
  disabled?: boolean;
  enabledByConfig?: boolean;
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
  missing: {
    bins: string[];
    anyBins?: string[];
    env: string[];
    config: string[];
    os: string[];
  };
  managedByPlugin: boolean;
  scope?: PluginHubScope;
  management?: PluginManagementCapabilities;
}

import type { GatewayPortSetErrorCode } from '@shared/openclaw/gatewayPort';
import type {
  MemoryDocumentResult,
  MemoryIndexStatusResult,
  MemoryOverviewResult,
  MemoryRebuildResult,
  MemorySearchResult,
} from '@shared/openclaw/memory';
import type {
  MarketplaceCategoriesResponse,
  MarketplaceCategoryRequest,
  MarketplaceDetailRequest,
  MarketplaceDetailResponse,
  MarketplaceInstallRequest,
  MarketplaceInstallResponse,
  MarketplacePluginKind,
  MarketplaceQuery,
  MarketplaceSearchResponse,
  MarketplaceSourcesResponse,
  MarketplaceUpdateCheckRequest,
  MarketplaceUpdateCheckResponse,
} from '@shared/plugins/marketplace';
import type {
  ScheduledTask,
  ScheduledTaskChannelOption,
  ScheduledTaskInput,
  ScheduledTaskManualRunResult,
  ScheduledTaskResult,
  ScheduledTaskResultPage,
  ScheduledTaskResultQuery,
  ScheduledTaskResultUpsertedEvent,
  ScheduledTaskRun,
  ScheduledTaskRunEvent,
  ScheduledTaskStatusEvent,
  ScheduledTaskUnreadCountEvent,
} from '@shared/scheduledTask/types';

import type { Agent } from '@/features/agents/agentTypes';
import type { McpServerFormData } from '@/features/plugins/mcp/mcp';

interface IElectronAPI {
  multica: {
    getStatus: () => Promise<MulticaIntegrationStatus>;
    enable: () => Promise<MulticaIntegrationResult>;
    disable: () => Promise<MulticaIntegrationResult>;
    refresh: () => Promise<MulticaIntegrationResult>;
  };
  browser: {
    createLocalHtmlPreview: (
      filePath: string,
      workingDirectory?: string,
    ) => Promise<BrowserLocalHtmlPreviewResult>;
    loadPdf: (request: BrowserPdfLoadRequest) => Promise<BrowserPdfLoadResult>;
    cancelPdf: (requestId: string) => void;
    getStatus: () => Promise<BrowserStatusResult>;
    canSetMode: () => Promise<BrowserModeSwitchAvailabilityResult>;
    setMode: (mode: BrowserMode) => Promise<BrowserModeUpdateResult>;
    openRemoteDebugging: () => Promise<BrowserActionResult>;
    testConnection: () => Promise<BrowserConnectionTestResult>;
    openExtensionManagement: () => Promise<BrowserActionResult>;
    revealExtension: () => Promise<BrowserActionResult>;
    copyExtensionPairing: () => Promise<BrowserActionResult>;
    testExtensionConnection: () => Promise<BrowserConnectionTestResult>;
    onPanelOpenTab: (callback: (event: BrowserPanelOpenTabEvent) => void) => () => void;
    onPanelHttpAuthRequest: (
      callback: (request: BrowserPanelHttpAuthRequest) => void,
    ) => () => void;
    respondToPanelHttpAuth: (response: BrowserPanelHttpAuthResponse) => void;
    onPanelHttpAuthDismissed: (
      callback: (event: import('../../shared/browser/browser').BrowserPanelHttpAuthDismissed) => void,
    ) => () => void;
    onPanelPdfDetected: (callback: (event: BrowserPanelPdfDetectedEvent) => void) => () => void;
    setPanelShortcuts: (shortcuts: BrowserPanelShortcutSettings) => void;
    onPanelShortcutAction: (callback: (action: BrowserPanelShortcutAction) => void) => () => void;
    registerAgentTab: (registration: BrowserAgentTabRegistration) => void;
    unregisterAgentTab: (reference: BrowserAgentTabReference) => void;
    setAgentActiveTab: (reference: BrowserAgentTabReference) => void;
    setUserInteractionState: (state: BrowserAgentInteractionState) => void;
    setRecordingLease: (state: BrowserRecordingLease) => Promise<boolean>;
    acknowledgeAgentInteraction: (state: BrowserAgentInteractionReady) => void;
    onAgentEnsureTab: (callback: (event: BrowserAgentSessionEvent) => void) => () => void;
    onAgentFocusTab: (callback: (event: BrowserAgentTabReference) => void) => () => void;
    onAgentCloseTab: (callback: (event: BrowserAgentTabReference) => void) => () => void;
    onAgentInteractionState: (
      callback: (event: BrowserAgentInteractionState) => void,
    ) => () => void;
    listImportSources: () => Promise<BrowserImportSourcesResult>;
    importData: (request: BrowserImportRequest) => Promise<BrowserImportResult>;
    listHistory: (query?: string) => Promise<BrowserHistoryListResult>;
    deleteHistory: (urls: string[]) => Promise<BrowserActionResult>;
    clearHistory: () => Promise<BrowserActionResult>;
    listDownloads: (query?: string) => Promise<BrowserDownloadListResult>;
    deleteDownloads: (ids: string[]) => Promise<BrowserActionResult>;
    clearDownloads: () => Promise<BrowserActionResult>;
    openDownload: (id: string) => Promise<BrowserActionResult>;
    revealDownload: (id: string) => Promise<BrowserActionResult>;
    getClearDataSummary: (range: BrowserClearDataRange) => Promise<BrowserClearDataSummaryResult>;
    clearBrowsingData: (request: BrowserClearDataRequest) => Promise<BrowserClearDataResult>;
  };
  terminal: {
    create: (request: TerminalCreateRequest) => Promise<TerminalCreateResult>;
    write: (request: TerminalWriteRequest) => Promise<TerminalActionResult>;
    resize: (request: TerminalResizeRequest) => Promise<TerminalActionResult>;
    close: (id: string) => Promise<TerminalActionResult>;
    onData: (callback: (event: TerminalDataEvent) => void) => () => void;
    onExit: (callback: (event: TerminalExitEvent) => void) => () => void;
  };
  platform: string;
  arch: string;
  store: {
    get: <T = unknown>(key: string) => Promise<T>;
    set: <T>(key: string, value: T) => Promise<void>;
    remove: (key: string) => Promise<void>;
  };
  marketplace: {
    listSources: (kind?: MarketplacePluginKind) => Promise<MarketplaceSourcesResponse>;
    listCategories: (request: MarketplaceCategoryRequest) => Promise<MarketplaceCategoriesResponse>;
    search: (query: MarketplaceQuery) => Promise<MarketplaceSearchResponse>;
    checkUpdates: (
      request: MarketplaceUpdateCheckRequest,
    ) => Promise<MarketplaceUpdateCheckResponse>;
    detail: (request: MarketplaceDetailRequest) => Promise<MarketplaceDetailResponse>;
    install: (request: MarketplaceInstallRequest) => Promise<MarketplaceInstallResponse>;
  };
  skillWorkshop: import('../../shared/plugins/skillWorkshop').SkillWorkshopApi;
  skills: {
    list: () => Promise<{
      success: boolean;
      skills?: Skill[];
      error?: string;
      gatewayOffline?: boolean;
    }>;
    setEnabled: (options: {
      id: string;
      enabled: boolean;
    }) => Promise<{ success: boolean; skills?: Skill[]; error?: string; gatewayOffline?: boolean }>;
    // Offline skill import from a folder or archive
    importPath: (sourcePath: string) => Promise<{
      success: boolean;
      skillId?: string;
      error?: string;
      skills?: Skill[];
    }>;
    delete: (options: {
      id: string;
      source?: OpenClawSkillSource;
    }) => Promise<{ success: boolean; skills?: Skill[]; error?: string }>;
  };
  extensions: {
    list: () => Promise<{
      success: boolean;
      extensions: InstalledOpenClawExtension[];
      error?: string;
    }>;
    delete: (request: ExtensionDeleteRequest) => Promise<ExtensionDeleteResult>;
    setEnabled: (request: ExtensionSetEnabledRequest) => Promise<ExtensionSetEnabledResult>;
    updateConfiguration: (
      request: ExtensionUpdateConfigurationRequest,
    ) => Promise<ExtensionUpdateConfigurationResult>;
    importPath: (request: ExtensionImportRequest) => Promise<{
      success: boolean;
      extensionId?: string;
      error?: string;
      failedStage?: ExtensionImportStage;
      capabilityReview?: import('../../shared/openclaw/extensions').OpenClawPluginCapabilityReview;
    }>;
    onImportProgress: (callback: (progress: ExtensionImportProgress) => void) => () => void;
    onChanged: (callback: (event: ExtensionChangedEvent) => void) => () => void;
  };
  hooks: {
    list: () => Promise<{
      success: boolean;
      hooks?: HookEntryIPC[];
      workspaceDir?: string;
      managedHooksDir?: string;
      error?: string;
      gatewayOffline?: boolean;
    }>;
    importPath: (sourcePath: string) => Promise<{
      success: boolean;
      hookId?: string;
      hooks?: HookEntryIPC[];
      workspaceDir?: string;
      managedHooksDir?: string;
      error?: string;
    }>;
    delete: (hookId: string) => Promise<{
      success: boolean;
      hooks?: HookEntryIPC[];
      workspaceDir?: string;
      managedHooksDir?: string;
      restartRequired?: boolean;
      error?: string;
    }>;
    setEnabled: (options: { id: string; enabled: boolean }) => Promise<{
      success: boolean;
      hooks?: HookEntryIPC[];
      workspaceDir?: string;
      managedHooksDir?: string;
      restartRequired?: boolean;
      error?: string;
      gatewayOffline?: boolean;
    }>;
  };
  slashCommands: {
    list: (
      options?: import('@shared/cowork/slashCommands').ListSlashCommandsOptions,
    ) => Promise<import('@shared/cowork/slashCommands').ListSlashCommandsResult>;
  };
  mcp: {
    list: () => Promise<{
      success: boolean;
      servers?: McpServerConfigIPC[];
      error?: string;
    }>;
    listExtensionServers: () => Promise<{
      success: boolean;
      extensionServers?: import('@shared/openclaw/mcp').ExtensionProvidedMcpServer[];
      error?: string;
    }>;
    create: (
      data: McpServerFormData,
    ) => Promise<{ success: boolean; servers?: McpServerConfigIPC[]; error?: string }>;
    update: (
      id: string,
      data: Partial<McpServerFormData>,
    ) => Promise<{ success: boolean; servers?: McpServerConfigIPC[]; error?: string }>;
    delete: (
      id: string,
    ) => Promise<{ success: boolean; servers?: McpServerConfigIPC[]; error?: string }>;
    setEnabled: (options: {
      id: string;
      enabled: boolean;
    }) => Promise<{ success: boolean; servers?: McpServerConfigIPC[]; error?: string }>;
    syncConfig: () => Promise<{ success: boolean; tools: number; error?: string }>;
    probe: (
      id: string,
    ) => Promise<{ success: boolean; result?: McpProbeResultIPC; error?: string }>;
    readResource: (options: {
      id: string;
      uri: string;
    }) => Promise<{ success: boolean; result?: McpReadResourceResultIPC; error?: string }>;
    onConfigSyncStart: (callback: () => void) => () => void;
    onConfigSyncDone: (callback: (data: { tools: number; error?: string }) => void) => () => void;
  };
  collaboration: {
    read: (
      sessionId: string,
    ) => Promise<AgentResult<import('@shared/cowork/collaboration').CollaborationSnapshot>>;
    readMessages: (
      sessionId: string,
      deliveryIds: string[],
    ) => Promise<
      AgentResult<import('@shared/cowork/collaboration').CollaborationMessageResult[]>
    >;
    list: () => Promise<AgentResult<import('@shared/cowork/collaboration').CollaborationRoom[]>>;
    create: (
      sessionId: string,
      agentIds: string[],
    ) => Promise<AgentResult<import('@shared/cowork/collaboration').CollaborationSnapshot>>;
    stop: (sessionId: string) => Promise<AgentResult<void>>;
  };
  agents: {
    delete: (agentId: string) => Promise<AgentResult<void>>;
    save: (input: AgentProfileInput) => Promise<AgentResult<Agent>>;
    readFile: (agentId: string, name: AgentFileName) => Promise<AgentResult<AgentFileSnapshot>>;
    writeFile: (
      agentId: string,
      name: AgentFileName,
      content: string,
      expected: AgentFileSnapshot,
    ) => Promise<AgentResult<AgentFileSnapshot>>;
    list: () => Promise<Agent[]>;
  };
  api: {
    fetch: (options: ApiFetchOptions) => Promise<ApiResponse>;
    cancelFetch: (requestId: string) => Promise<void>;
  };
  getApiConfig: () => Promise<CoworkApiConfig | null>;
  checkApiConfig: (options?: {
    probeModel?: boolean;
  }) => Promise<{ hasConfig: boolean; config: CoworkApiConfig | null; error?: string }>;
  saveApiConfig: (config: CoworkApiConfig) => Promise<{ success: boolean; error?: string }>;
  generateSessionTitle: (request: GenerateSessionTitleRequest) => Promise<string>;
  getRecentCwds: (limit?: number) => Promise<string[]>;
  openclaw: {
    externalAgents: {
      getSettings: () => Promise<{
        success: boolean;
        settings?: ExternalAgentSettings;
        error?: string;
      }>;
      setSettings: (settings: ExternalAgentSettings) => Promise<{
        success: boolean;
        settings?: ExternalAgentSettings;
        error?: string;
      }>;
      test: (agentId: ExternalAgentId) => Promise<ExternalAgentTestResult>;
    };
    approvals: {
      list: () => Promise<{
        success: boolean;
        requests: ApprovalRequest[];
        error?: string;
      }>;
      resolve: (
        id: string,
        decision: ApprovalDecision,
        kind: ApprovalKind,
      ) => Promise<{ success: boolean; error?: string }>;
      onRequested: (callback: (request: ApprovalRequest) => void) => () => void;
      onResolved: (callback: (resolved: ApprovalResolved) => void) => () => void;
      onSnapshot: (callback: (requests: ApprovalRequest[]) => void) => () => void;
    };
    engine: {
      getStatus: () => Promise<{ success: boolean; status?: OpenClawEngineStatus; error?: string }>;
      restartGateway: () => Promise<{
        success: boolean;
        status?: OpenClawEngineStatus;
        error?: string;
      }>;
      getPort: () => Promise<{
        success: boolean;
        port?: number;
        activePort?: number;
        requiresRestart?: boolean;
        error?: string;
      }>;
      getToken: () => Promise<{ success: boolean; token?: string; error?: string }>;
      readAssistantMediaDataUrl: (
        request: import('../../shared/openclaw/assistantMedia').OpenClawAssistantMediaRequest,
      ) => Promise<import('../../shared/openclaw/assistantMedia').OpenClawAssistantMediaResult>;
      setPort: (port: number) => Promise<{
        success: boolean;
        error?: string;
        errorCode?: GatewayPortSetErrorCode;
        requiresRestart?: boolean;
      }>;
      getSystemPromptReplacementRules: () => Promise<{
        success: boolean;
        rules?: SystemPromptReplacementRule[];
        error?: string;
      }>;
      setSystemPromptReplacementRules: (rules: SystemPromptReplacementRule[]) => Promise<{
        success: boolean;
        rules?: SystemPromptReplacementRule[];
        error?: string;
      }>;
      openTerminal: (cwd?: string) => Promise<{
        success: boolean;
        error?: string;
        status?: OpenClawEngineStatus;
      }>;
      onProgress: (callback: (status: OpenClawEngineStatus) => void) => () => void;
      migration: {
        plan: () => Promise<{
          success: boolean;
          plan?: OpenClawSessionMigrationPlan;
          error?: string;
        }>;
        confirm: (
          request: OpenClawSessionMigrationConfirmRequest,
        ) => Promise<OpenClawSessionMigrationResult & { status?: OpenClawEngineStatus }>;
        onProgress: (callback: (progress: OpenClawSessionMigrationProgress) => void) => () => void;
      };
    };
    history: {
      getToolInputs: (params: { sessionKey: string; toolCallIds: string[] }) => Promise<{
        success: boolean;
        inputs?: Record<string, { name?: string; input: unknown }>;
        error?: string;
      }>;
      getCompactionDetails: (params: { sessionKey: string; entryIds: string[] }) => Promise<{
        success: boolean;
        details?: Record<string, { summary?: string; tokensBefore?: number; tokensAfter?: number }>;
        error?: string;
      }>;
    };
    models: {
      list: (options?: {
        agentId?: string;
      }) => Promise<import('@shared/openclaw/models').OpenClawModelsListResult>;
    };
    memory: {
      getOverview: () => Promise<MemoryOverviewResult>;
      getIndexStatus: () => Promise<MemoryIndexStatusResult>;
      getDocument: (relativePath: string) => Promise<MemoryDocumentResult>;
      search: (query: string) => Promise<MemorySearchResult>;
      rebuildIndex: () => Promise<MemoryRebuildResult>;
    };
    usage: {
      getDaily: (
        options: import('../../shared/openclaw/usage').UsageStatsOptions,
      ) => Promise<import('../../shared/openclaw/usage').DailyTokenUsageResult>;
    };
  };
  ipcRenderer: {
    send: (channel: string, ...args: unknown[]) => void;
    on: (channel: string, func: (...args: unknown[]) => void) => () => void;
  };
  window: {
    minimize: () => void;
    toggleMaximize: () => void;
    close: () => void;
    isMaximized: () => Promise<boolean>;
    showSystemMenu: (position: { x: number; y: number }) => void;
    onStateChanged: (callback: (state: WindowState) => void) => () => void;
  };
  cowork: {
    startSession: (options: {
      prompt: string;
      gatewayPrompt?: string;
      cwd?: string;
      title?: string;
      activeSkillIds?: string[];
      agentId?: string;
      attachments?: CoworkAttachmentPayload[];
      clientTurnId?: string;
      startedAt?: number;
      planMode?: boolean;
    }) => Promise<{
      success: boolean;
      session?: CoworkSession;
      error?: string;
      code?: string;
      engineStatus?: OpenClawEngineStatus;
      timing?: SessionRunTiming;
      cancelled?: boolean;
    }>;
    cancelSessionStart: (
      input: import('../../shared/cowork/sessionStart').CancelSessionStartInput,
    ) => Promise<import('../../shared/cowork/sessionStart').CancelSessionStartResult>;
    stopSession: (sessionId: string) => Promise<{ success: boolean; error?: string }>;
    deleteSession: (sessionId: string) => Promise<{ success: boolean; error?: string }>;
    copySession: (
      input: import('../../shared/cowork/sessionCopy').CopyCoworkSessionInput,
    ) => Promise<{
      success: boolean;
      session?: CoworkSession;
      planModeEnabled?: boolean;
      error?: string;
    }>;
    forkSession: (
      input: import('../../shared/cowork/sessionFork').ForkCoworkSessionInput,
    ) => Promise<{
      success: boolean;
      session?: CoworkSession;
      error?: string;
    }>;
    deleteSessions: (sessionIds: string[]) => Promise<{ success: boolean; error?: string; deletedSessionIds?: string[] }>;
    setSessionPinned: (options: {
      sessionId: string;
      pinned: boolean;
    }) => Promise<{ success: boolean; error?: string }>;
    renameSession: (options: {
      sessionId: string;
      title: string;
    }) => Promise<{ success: boolean; error?: string }>;
    setSessionPermissionMode: (options: {
      sessionId: string;
      permissionMode: PermissionMode;
      deferIfActive?: boolean;
    }) => Promise<{
      success: boolean;
      deferred?: boolean;
      error?: string;
      engineStatus?: OpenClawEngineStatus;
    }>;
    getSession: (
      sessionId: string,
    ) => Promise<{ success: boolean; session?: CoworkSession; error?: string }>;
    getSessionDetails: (sessionId: string) => Promise<CoworkSessionDetailsResult>;
    getGatewaySessionId: (
      sessionId: string,
    ) => Promise<{ success: boolean; sessionId?: string; error?: string }>;
    remoteManaged: (
      sessionId: string,
    ) => Promise<{ success: boolean; remoteManaged: boolean; error?: string }>;
    getSessionRuntimeStatus: (
      sessionId: string,
      options?: { includeSubagents?: boolean; forceRefresh?: boolean; fullScan?: boolean },
    ) => Promise<{
      success: boolean;
      known: boolean;
      mainRunning: boolean;
      subagentRunning: boolean;
      running: boolean;
      revision: number;
      timing?: SessionRunTiming;
      error?: string;
    }>;
    getSessionRuntimeStatuses: (
      sessionIds: string[],
      options?: { includeSubagents?: boolean; forceRefresh?: boolean; fullScan?: boolean },
    ) => Promise<{
      success: boolean;
      statuses: Record<string, SessionRuntimeSnapshot>;
      error?: string;
    }>;
    beginSessionRun: (input: BeginSessionRunInput) => Promise<{
      success: boolean;
      timing?: SessionRunTiming;
      snapshot?: SessionRuntimeSnapshot;
      errorCode?: SessionRunBeginErrorCode;
      error?: string;
    }>;
    bindSessionRun: (input: { id: string; rootRunId: string }) => Promise<{
      success: boolean;
      timing?: SessionRunTiming;
      error?: string;
    }>;
    listSessionRuns: (sessionId: string) => Promise<{
      success: boolean;
      timings: SessionRunTiming[];
      error?: string;
    }>;
    markSessionRunUnknown: (input: SessionRunUnknownInput) => Promise<{
      success: boolean;
      snapshot?: SessionRuntimeSnapshot;
      error?: string;
    }>;
    failSessionRun: (input: { sessionId: string; id: string; endedAt: number }) => Promise<{
      success: boolean;
      snapshot?: SessionRuntimeSnapshot;
      error?: string;
    }>;
    patchSessionModel: (options: {
      sessionId: string;
      model: string;
      agentId?: string;
    }) => Promise<{
      success: boolean;
      modelRef?: string;
      appliesTo?: 'next-turn' | 'subsequent-calls';
      source?: 'gateway' | 'local-cache' | 'agent-default';
      error?: string;
    }>;
    getSessionModel: (options: { sessionId: string; agentId?: string }) => Promise<{
      success: boolean;
      modelRef?: string;
      source?: 'gateway' | 'local-cache' | 'agent-default';
      error?: string;
    }>;
    listSessions: (
      agentId?: string,
    ) => Promise<{ success: boolean; sessions?: CoworkSessionSummary[]; error?: string }>;
    searchSessionMessages: (
      query: string,
    ) => Promise<import('@shared/cowork/sessionSearch').CoworkSessionMessageSearchResult>;
    getSessionGoal: (sessionId: string) => Promise<{
      success: boolean;
      goal?: import('@shared/cowork/sessionGoal').SessionGoal;
      error?: string;
    }>;
    getPlanMode: (
      sessionId: string,
    ) => Promise<{ success: boolean; enabled?: boolean; error?: string }>;
    setPlanMode: (
      sessionId: string,
      enabled: boolean,
    ) => Promise<{ success: boolean; enabled?: boolean; error?: string }>;
    mutateSessionGoal: (
      sessionId: string,
      request: import('@shared/cowork/sessionGoal').SessionGoalMutationRequest,
    ) => Promise<{
      success: boolean;
      mutation?: import('@shared/cowork/sessionGoal').SessionGoalMutationResult;
      goal?: import('@shared/cowork/sessionGoal').SessionGoal | null;
      execution?: import('@shared/cowork/sessionGoal').GoalExecutionSnapshot;
      error?: string;
    }>;
    getGoalExecution: (sessionId: string) => Promise<{
      success: boolean;
      execution?: import('@shared/cowork/sessionGoal').GoalExecutionSnapshot;
      error?: string;
    }>;
    continueGoal: (sessionId: string) => Promise<{
      success: boolean;
      execution?: import('@shared/cowork/sessionGoal').GoalExecutionSnapshot;
      error?: string;
    }>;
    restartCompletedGoalForFeedback: (
      sessionId: string,
      goalId: string,
      objective?: string,
    ) => Promise<{
      success: boolean;
      objective?: string;
      error?: string;
    }>;
    respondToInteraction: (options: {
      requestId: string;
      result: CoworkInteractionResult;
    }) => Promise<{ success: boolean; error?: string }>;
    replayPendingInteractions: () => Promise<{ success: boolean; count: number }>;
    getConfig: () => Promise<{ success: boolean; config?: CoworkConfig; error?: string }>;
    setConfig: (
      config: CoworkConfigUpdate,
    ) => Promise<{ success: boolean; error?: string; engineStatus?: OpenClawEngineStatus }>;
    getAgentRuntimeSettings: () => Promise<{
      success: boolean;
      settings?: AgentRuntimeSettings;
      error?: string;
    }>;
    setAgentRuntimeSettings: (settings: AgentRuntimeSettings) => Promise<{
      success: boolean;
      changed?: boolean;
      settings?: AgentRuntimeSettings;
      error?: string;
      engineStatus?: OpenClawEngineStatus;
    }>;
    getWindowsSandboxStatus: () => Promise<import('@shared/security/windowsSandbox').WindowsSandboxStatus>;
    initializeWindowsSandbox: () => Promise<
      import('@shared/security/windowsSandbox').WindowsSandboxOperationResult
    >;
    repairWindowsSandbox: () => Promise<
      import('@shared/security/windowsSandbox').WindowsSandboxOperationResult
    >;
    openWindowsSandboxDiagnostics: () => Promise<{ success: boolean; error?: string }>;
    setDefaultModel: (options: {
      modelId: string;
      providerKey?: string;
      modelRef?: string;
      agentId?: string;
    }) => Promise<{ success: boolean; error?: string }>;
    onSessionActivity: (
      callback: (data: { sessionId: string; kind: 'user' | 'other'; timestamp: number }) => void,
    ) => () => void;
    onStreamInteraction: (
      callback: (data: { sessionId: string; request: CoworkInteractionRequest }) => void,
    ) => () => void;
    onStreamInteractionDismiss: (callback: (data: { requestId: string }) => void) => () => void;
    onStreamComplete: (
      callback: (data: {
        sessionId: string;
        finalStatus?: 'idle' | 'running' | 'completed' | 'error';
      }) => void,
    ) => () => void;
    onStreamError: (callback: (data: { sessionId: string; error: string }) => void) => () => void;
    onSessionsChanged: (callback: () => void) => () => void;
    onGoalExecutionChanged: (
      callback: (snapshot: import('@shared/cowork/sessionGoal').GoalExecutionSnapshot) => void,
    ) => () => void;
    onSessionGoalChanged: (callback: (data: { sessionId: string }) => void) => () => void;
    getSubTaskStatus: (
      sessionId?: string,
      forceRefresh?: boolean,
    ) => Promise<{
      success: boolean;
      subagents?: Array<{
        id: string;
        taskName: string;
        sessionKey: string;
        sessionId?: string;
        label: string;
        labelSource: 'taskName' | 'label' | 'task';
        status: 'pending' | 'running' | 'done' | 'failed' | 'killed' | 'timeout' | 'blocked';
        runtime?: 'subagent' | 'acp';
        agentId?: string;
        task?: string;
        runId?: string;
        model?: string;
        startedAt?: number;
        updatedAt?: number;
        endedAt?: number;
        runtimeMs?: number;
        runtimeSampledAt?: number;
        totalTokens?: number;
        progressSummary?: string;
        terminalSummary?: string;
        error?: string;
        lastActivity?: string;
        lastToolName?: string;
        toolUseCount?: number;
      }>;
    }>;
    getSubTaskDetails: (
      sessionKey: string,
      taskId?: string,
    ) => Promise<CoworkSubagentDetailsResult>;
    listSubTaskDescendants: (sessionId: string) => Promise<CoworkSubagentDescendantsResult>;
    onSubtasksChanged: (callback: (event: CoworkSubtaskChangedEvent) => void) => () => void;
  };
  localTts: {
    getStatus: (
      modelId: import('../../shared/speech/localTts').LocalTtsModelId,
    ) => Promise<import('../../shared/speech/localTts').LocalTtsStatus>;
  };
  localAsr: {
    stageAttachment: (source: string, workspace: string) => Promise<import('../../shared/speech/localAsr').StageAudioAttachmentResult>;
    getStatus: (
      modelId: import('../../shared/speech/localAsr').LocalAsrModelId,
    ) => Promise<import('../../shared/speech/localAsr').LocalAsrStatus>;
    transcribe: (
      audio: Uint8Array,
      options: import('../../shared/speech/localAsr').LocalAsrTranscribeOptions,
    ) => Promise<import('../../shared/speech/localAsr').LocalAsrTranscribeResult>;
  };
  onlineAsr: {
    getStatus: () => Promise<import('../../shared/speech/onlineAsr').OnlineAsrStatus>;
    getConfiguration: () => Promise<import('../../shared/speech/onlineAsr').OnlineAsrConfiguration>;
    saveConfiguration: (
      update: import('../../shared/speech/onlineAsr').OnlineAsrConfigurationUpdate,
    ) => Promise<void>;
    clearConfiguration: () => Promise<void>;
    start: (
      options: import('../../shared/speech/onlineAsr').OnlineAsrStartOptions,
    ) => Promise<import('../../shared/speech/onlineAsr').OnlineAsrSession>;
    appendAudio: (sessionId: string, audioBase64: string) => Promise<void>;
    close: (sessionId: string) => Promise<void>;
    onEvent: (
      callback: (event: import('../../shared/speech/onlineAsr').OnlineAsrEvent) => void,
    ) => () => void;
  };
  onlineTts: {
    getStatus: () => Promise<import('../../shared/speech/onlineTts').OnlineTtsStatus>;
    getConfiguration: () => Promise<import('../../shared/speech/onlineTts').OnlineTtsConfiguration>;
    saveConfiguration: (
      update: import('../../shared/speech/onlineTts').OnlineTtsConfigurationUpdate,
    ) => Promise<void>;
    clearConfiguration: () => Promise<void>;
  };
  speechSynthesis: {
    speak: (text: string) => Promise<import('../../shared/speech/speechSynthesis').SpeechSynthesisResult>;
  };
  mediaGenerationModels: {
    getConfiguration: (
      kind: import('../../shared/providers/mediaGenerationModels').MediaGenerationModelKind,
    ) => Promise<
      import('../../shared/providers/mediaGenerationModels').MediaGenerationModelConfigurationResult
    >;
    saveConfiguration: (
      kind: import('../../shared/providers/mediaGenerationModels').MediaGenerationModelKind,
      configuration: import('../../shared/providers/mediaGenerationModels').MediaGenerationModelConfiguration,
    ) => Promise<void>;
  };
  mediaCapture: {
    armSystemAudio: () => Promise<void>;
  };
  localSpeechModels: {
    list: () => Promise<import('../../shared/speech/localSpeechModels').LocalSpeechModelListResult>;
    install: (
      kind: import('../../shared/speech/localSpeechModels').LocalSpeechModelKind,
      id: string,
    ) => Promise<import('../../shared/speech/localSpeechModels').LocalSpeechModelInstallResult>;
    remove: (
      kind: import('../../shared/speech/localSpeechModels').LocalSpeechModelKind,
      id: string,
    ) => Promise<import('../../shared/speech/localSpeechModels').LocalSpeechModelInstallResult>;
    onChanged: (
      callback: (status: import('../../shared/speech/localSpeechModels').LocalSpeechModelStatus) => void,
    ) => () => void;
  };
  sessionGroup: {
    list: () => Promise<{ success: boolean; groups?: SessionGroup[]; error?: string }>;
    create: (input: { name: string; color?: string }) => Promise<{
      success: boolean;
      group?: SessionGroup;
      error?: string;
    }>;
    update: (
      id: string,
      input: { name?: string; color?: string; sortOrder?: number },
    ) => Promise<{ success: boolean; group?: SessionGroup; error?: string }>;
    delete: (id: string) => Promise<{ success: boolean; error?: string }>;
    moveSession: (
      sessionId: string,
      groupId: string | null,
    ) => Promise<{ success: boolean; error?: string }>;
    reorder: (groupIds: string[]) => Promise<{ success: boolean; error?: string }>;
  };
  dialog: {
    saveTextFile: (options: SaveTextFileOptions) => Promise<SaveTextFileResult>;
    selectDirectory: () => Promise<{ success: boolean; path: string | null }>;
    selectFile: (options?: {
      title?: string;
      filters?: { name: string; extensions: string[] }[];
    }) => Promise<{ success: boolean; path: string | null }>;
    selectFiles: (options?: {
      title?: string;
      filters?: { name: string; extensions: string[] }[];
    }) => Promise<{ success: boolean; paths: string[]; error?: string }>;
    selectFolders: (options?: { title?: string }) => Promise<{
      success: boolean;
      paths: string[];
      error?: string;
    }>;
    saveInlineFile: (options: {
      dataBase64: string;
      fileName?: string;
      mimeType?: string;
      cwd?: string;
    }) => Promise<{ success: boolean; path: string | null; error?: string }>;
    readFileAsDataUrl: (
      filePath: string,
    ) => Promise<{ success: boolean; dataUrl?: string; error?: string }>;
  };
  shell: {
    showAttachmentContextMenu: () => Promise<'open' | 'open-with-system' | 'show-in-folder' | null>;
    showImageContextMenu: (imageUrl: string) => Promise<{ success: boolean; error?: string }>;
    openPath: (
      filePath: string,
      workingDirectory?: string,
    ) => Promise<{ success: boolean; error?: string; notFound?: boolean }>;
    openPathWith: (filePath: string) => Promise<{
      success: boolean;
      error?: string;
      notFound?: boolean;
      unavailable?: boolean;
    }>;
    listWorkspaceDirectory: (
      sessionId: string,
      relativeDirectory?: string,
    ) => Promise<WorkspaceDirectoryListResult>;
    readPreviewFile: (
      filePath: string,
      workingDirectory?: string,
    ) => Promise<FilePreviewReadResult>;
    authorizePreviewFileEdit: (
      request: FilePreviewEditAuthorizationRequest,
    ) => Promise<FilePreviewEditAuthorizationResult>;
    revokePreviewFileEdit: (editToken: string) => Promise<void>;
    writePreviewFile: (request: FilePreviewWriteRequest) => Promise<FilePreviewWriteResult>;
    showItemInFolder: (
      filePath: string,
      workingDirectory?: string,
    ) => Promise<{ success: boolean; error?: string; notFound?: boolean }>;
    openExternal: (url: string) => Promise<{ success: boolean; error?: string }>;
    openLocalHtmlExternal: (previewUrl: string) => Promise<{ success: boolean; error?: string }>;
  };
  imagePreview: {
    open: (
      request: import('../../shared/preview/imagePreview').ImagePreviewOpenRequest,
    ) => Promise<import('../../shared/preview/imagePreview').ImagePreviewOpenResult>;
  };
  autoLaunch: {
    get: () => Promise<{ enabled: boolean }>;
    set: (enabled: boolean) => Promise<{ success: boolean; error?: string }>;
  };
  preventSleep: {
    get: () => Promise<{ enabled: boolean }>;
    set: (enabled: boolean) => Promise<{ success: boolean; error?: string }>;
  };
  appInfo: {
    getVersion: () => Promise<string>;
    getOpenclawVersion: () => Promise<string>;
    getSystemLocale: () => Promise<string>;
  };
  appUpdate: {
    getState: () => Promise<AppUpdateState>;
    check: () => Promise<AppUpdateState>;
    download: () => Promise<AppUpdateActionResult>;
    quitAndInstall: () => Promise<AppUpdateActionResult>;
    getPreferences: () => Promise<import('../../shared/app/appUpdate').AppUpdatePreferences>;
    setCheckFrequency: (
      frequency: import('../../shared/app/appUpdate').AppUpdateCheckFrequency,
    ) => Promise<import('../../shared/app/appUpdate').AppUpdatePreferences>;
    getReleaseHistory: () => Promise<import('../../shared/app/appUpdate').AppReleaseHistoryResult>;
    onStateChanged: (callback: (state: AppUpdateState) => void) => () => void;
  };
  builtinModels: {
    refresh: () => Promise<{ success: boolean; error?: string }>;
  };
  log: {
    getPath: () => Promise<string>;
    openFolder: () => Promise<void>;
    exportZip: () => Promise<{
      success: boolean;
      canceled?: boolean;
      path?: string;
      missingEntries?: string[];
      error?: string;
    }>;
    debug: (message: string, details?: Record<string, unknown>) => void;
  };
  scheduledTasks: {
    getSchedulerSettings: () => Promise<{
      success: boolean;
      snapshot?: import('@shared/scheduledTask/types').SchedulerSettingsSnapshot;
      error?: string;
    }>;
    updateSchedulerSettings: (input: import('@shared/scheduledTask/types').SchedulerSettingsUpdate) => Promise<{
      success: boolean;
      error?: string;
    }>;
    getSystemSettings: () => Promise<{
      success: boolean;
      settings?: import('@shared/scheduledTask/types').SystemTaskSettings;
      error?: string;
    }>;
    updateSystemSettings: (
      input: import('@shared/scheduledTask/types').SystemTaskSettingsPatch,
    ) => Promise<{ success: boolean; error?: string }>;
    list: () => Promise<{
      success: boolean;
      tasks?: ScheduledTask[];
      error?: string;
    }>;
    get: (id: string) => Promise<{
      success: boolean;
      task?: ScheduledTask;
      error?: string;
    }>;
    create: (input: ScheduledTaskInput) => Promise<{
      success: boolean;
      task?: ScheduledTask;
      error?: string;
    }>;
    update: (
      id: string,
      input: Partial<ScheduledTaskInput>,
    ) => Promise<{
      success: boolean;
      task?: ScheduledTask;
      error?: string;
    }>;
    delete: (id: string) => Promise<{ success: boolean; error?: string }>;
    toggle: (
      id: string,
      enabled: boolean,
    ) => Promise<{
      success: boolean;
      task?: ScheduledTask;
      warning?: string;
      error?: string;
    }>;
    runManually: (
      id: string,
      expectedConfigRevision?: string,
    ) => Promise<{
      success: boolean;
      result?: ScheduledTaskManualRunResult;
      error?: string;
    }>;
    listRuns: (
      taskId: string,
      limit?: number,
      offset?: number,
    ) => Promise<{
      success: boolean;
      runs?: ScheduledTaskRun[];
      hasMore?: boolean;
      nextOffset?: number | null;
      error?: string;
    }>;
    resolveSession: (
      sessionKey: string,
      context?: import('@shared/scheduledTask/types').ScheduledTaskSessionResolveContext,
    ) => Promise<{
      success: boolean;
      history?: import('@shared/scheduledTask/types').ScheduledTaskSessionHistory | null;
      error?: string;
    }>;
    listChannels: () => Promise<{
      success: boolean;
      channels?: ScheduledTaskChannelOption[];
      error?: string;
    }>;
    onStatusUpdate: (callback: (data: ScheduledTaskStatusEvent) => void) => () => void;
    onRunUpdate: (callback: (data: ScheduledTaskRunEvent) => void) => () => void;
    listResults: (query?: ScheduledTaskResultQuery) => Promise<{
      success: boolean;
      page?: ScheduledTaskResultPage;
      error?: string;
    }>;
    markResultRead: (runId: string) => Promise<{
      success: boolean;
      result?: ScheduledTaskResult;
      unreadCount?: number;
      error?: string;
    }>;
    markAllResultsRead: (taskId?: string) => Promise<{
      success: boolean;
      unreadCount?: number;
      error?: string;
    }>;
    deleteResult: (runId: string) => Promise<{
      success: boolean;
      unreadCount?: number;
      error?: string;
    }>;
    reconcileResults: () => Promise<{ success: boolean; error?: string }>;
    onResultUpserted: (callback: (data: ScheduledTaskResultUpsertedEvent) => void) => () => void;
    onUnreadCountChanged: (callback: (data: ScheduledTaskUnreadCountEvent) => void) => () => void;
    onRefresh: (callback: () => void) => () => void;
  };
  workboard: {
    getSnapshot: () => Promise<WorkboardResult<WorkboardSnapshot>>;
    createCard: (input: WorkboardCardInput) => Promise<WorkboardResult<WorkboardCard>>;
    updateCard: (
      id: string,
      patch: WorkboardCardPatch,
      expectedUpdatedAt: number,
    ) => Promise<WorkboardResult<WorkboardCard>>;
    moveCard: (
      id: string,
      status: WorkboardStatus,
      position: number,
    ) => Promise<WorkboardResult<WorkboardCard>>;
    deleteCard: (id: string) => Promise<WorkboardResult>;
    archiveCard: (id: string, archived: boolean) => Promise<WorkboardResult<WorkboardCard>>;
    commentCard: (id: string, body: string) => Promise<WorkboardResult<WorkboardCard>>;
    startCard: (id: string) => Promise<WorkboardResult<WorkboardStartResult>>;
    stopCard: (
      id: string,
      expectedExecution?: WorkboardStopIdentity,
    ) => Promise<WorkboardResult<WorkboardCard>>;
    resolveSession: (sessionKey: string) => Promise<WorkboardResult<WorkboardSessionResolution>>;
    dispatch: (boardId?: string) => Promise<WorkboardResult<WorkboardDispatchSummary>>;
    onChanged: (callback: (event: WorkboardChangedEvent) => void) => () => void;
  };
  permissions: {
    checkCalendar: () => Promise<{
      success: boolean;
      status?: string;
      error?: string;
      autoRequested?: boolean;
    }>;
    requestCalendar: () => Promise<{
      success: boolean;
      granted?: boolean;
      status?: string;
      error?: string;
    }>;
  };
  networkStatus: {
    send: (status: 'online' | 'offline') => void;
  };
}

declare global {
  interface Window {
    electron: IElectronAPI;
  }
}

export {};
