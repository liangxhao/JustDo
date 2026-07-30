type CoworkAttachmentPayload = import('../../shared/cowork/attachments').CoworkAttachmentPayload;
type SaveTextFileOptions = import('../../shared/dialogIpc').SaveTextFileOptions;
type SaveTextFileResult = import('../../shared/dialogIpc').SaveTextFileResult;
type ExtensionImportProgress = import('../../shared/openclaw/extensions').ExtensionImportProgress;
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
type SystemPromptReplacementRule =
  import('../../shared/openclaw/systemPromptReplacements').SystemPromptReplacementRule;

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
  activeSkillIds: string[];
  agentId: string;
  messages: CoworkMessage[];
  createdAt: number;
  updatedAt: number;
}

interface CoworkMessageMetadata {
  toolName?: string;
  toolInput?: Record<string, unknown>;
  toolResult?: string | Record<string, unknown>;
  toolUseId?: string | null;
  error?: string;
  isError?: boolean;
  isStreaming?: boolean;
  isFinal?: boolean;
  skillIds?: string[];
  [key: string]: unknown;
}

interface TokenUsage {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
}

interface DailyTokenUsage {
  date: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
}

interface CoworkMessage {
  id: string;
  type: 'user' | 'assistant' | 'tool_use' | 'tool_result' | 'system' | 'subagent_completion';
  content: string;
  timestamp: number;
  metadata?: CoworkMessageMetadata;
  thinkingContent?: string;
  modelName?: string;
  usage?: TokenUsage;
}

interface CoworkSessionSummary {
  id: string;
  title: string;
  status: 'idle' | 'running' | 'completed' | 'error';
  pinned: boolean;
  groupId?: string | null;
  agentId?: string;
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
  agentEngine: 'openclaw';
}

type CoworkConfigUpdate = Partial<
  Pick<CoworkConfig, 'workingDirectory' | 'executionMode' | 'agentEngine'>
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
  apiType?: 'openai';
}

type OpenClawEnginePhase = 'ready' | 'starting' | 'running' | 'error';

interface OpenClawEngineStatus {
  phase: OpenClawEnginePhase;
  version: string | null;
  progressPercent?: number;
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
}

import type { GatewayPortSetErrorCode } from '@shared/openclaw/gatewayPort';
import type {
  MemoryDocumentResult,
  MemoryOverviewResult,
  MemoryRebuildResult,
  MemorySearchResult,
} from '@shared/openclaw/memory';
import type {
  MarketplaceDetailRequest,
  MarketplaceDetailResponse,
  MarketplaceInstallRequest,
  MarketplaceInstallResponse,
  MarketplaceQuery,
  MarketplaceSearchResponse,
  MarketplaceSourcesResponse,
  PluginKind,
} from '@shared/plugins/marketplace';
import type {
  ScheduledTask,
  ScheduledTaskChannelOption,
  ScheduledTaskInput,
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
import type { McpServerFormData } from '@/features/plugins/types/mcp';

interface IElectronAPI {
  platform: string;
  arch: string;
  store: {
    get: <T = unknown>(key: string) => Promise<T>;
    set: <T>(key: string, value: T) => Promise<void>;
    remove: (key: string) => Promise<void>;
  };
  marketplace: {
    listSources: (kind?: PluginKind) => Promise<MarketplaceSourcesResponse>;
    search: (query: MarketplaceQuery) => Promise<MarketplaceSearchResponse>;
    detail: (request: MarketplaceDetailRequest) => Promise<MarketplaceDetailResponse>;
    install: (request: MarketplaceInstallRequest) => Promise<MarketplaceInstallResponse>;
  };
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
    }>;
    onImportProgress: (callback: (progress: ExtensionImportProgress) => void) => () => void;
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
      options?: import('@shared/slashCommands').ListSlashCommandsOptions,
    ) => Promise<import('@shared/slashCommands').ListSlashCommandsResult>;
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
  agents: {
    list: () => Promise<Agent[]>;
  };
  api: {
    fetch: (options: {
      url: string;
      method: string;
      headers: Record<string, string>;
      body?: string;
    }) => Promise<ApiResponse>;
  };
  getApiConfig: () => Promise<CoworkApiConfig | null>;
  checkApiConfig: (options?: {
    probeModel?: boolean;
  }) => Promise<{ hasConfig: boolean; config: CoworkApiConfig | null; error?: string }>;
  saveApiConfig: (config: CoworkApiConfig) => Promise<{ success: boolean; error?: string }>;
  generateSessionTitle: (userInput: string | null) => Promise<string>;
  getRecentCwds: (limit?: number) => Promise<string[]>;
  openclaw: {
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
      openTerminal: () => Promise<{
        success: boolean;
        error?: string;
        status?: OpenClawEngineStatus;
      }>;
      onProgress: (callback: (status: OpenClawEngineStatus) => void) => () => void;
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
      getPagedHistory: (params: {
        sessionKey: string;
        cursor?: string;
        limit?: number;
      }) => Promise<{
        success: boolean;
        messages?: unknown[];
        hasMore?: boolean;
        nextCursor?: string;
        error?: string;
      }>;
    };
    memory: {
      getOverview: () => Promise<MemoryOverviewResult>;
      getDocument: (relativePath: string) => Promise<MemoryDocumentResult>;
      search: (query: string) => Promise<MemorySearchResult>;
      rebuildIndex: () => Promise<MemoryRebuildResult>;
    };
    usage: {
      getDaily: (options: { days: number; utcOffset: string }) => Promise<{
        success: boolean;
        daily?: DailyTokenUsage[];
        totalTokens?: number;
        updatedAt?: number;
        cacheStatus?: {
          status: 'fresh' | 'partial' | 'stale' | 'refreshing';
          cachedFiles: number;
          pendingFiles: number;
          staleFiles: number;
          refreshedAt?: number;
        };
        error?: string;
      }>;
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
      cwd?: string;
      title?: string;
      activeSkillIds?: string[];
      agentId?: string;
      attachments?: CoworkAttachmentPayload[];
    }) => Promise<{
      success: boolean;
      session?: CoworkSession;
      error?: string;
      code?: string;
      engineStatus?: OpenClawEngineStatus;
    }>;
    continueSession: (options: {
      sessionId: string;
      prompt: string;
      activeSkillIds?: string[];
      attachments?: CoworkAttachmentPayload[];
    }) => Promise<{
      success: boolean;
      session?: CoworkSession;
      error?: string;
      code?: string;
      engineStatus?: OpenClawEngineStatus;
    }>;
    stopSession: (sessionId: string) => Promise<{ success: boolean; error?: string }>;
    deleteSession: (sessionId: string) => Promise<{ success: boolean; error?: string }>;
    deleteSessions: (sessionIds: string[]) => Promise<{ success: boolean; error?: string }>;
    setSessionPinned: (options: {
      sessionId: string;
      pinned: boolean;
    }) => Promise<{ success: boolean; error?: string }>;
    renameSession: (options: {
      sessionId: string;
      title: string;
    }) => Promise<{ success: boolean; error?: string }>;
    getSession: (
      sessionId: string,
    ) => Promise<{ success: boolean; session?: CoworkSession; error?: string }>;
    getGatewaySessionId: (
      sessionId: string,
    ) => Promise<{ success: boolean; sessionId?: string; error?: string }>;
    remoteManaged: (
      sessionId: string,
    ) => Promise<{ success: boolean; remoteManaged: boolean; error?: string }>;
    getSessionRuntimeStatus: (
      sessionId: string,
      options?: { includeSubagents?: boolean; forceRefresh?: boolean },
    ) => Promise<{
      success: boolean;
      known: boolean;
      mainRunning: boolean;
      subagentRunning: boolean;
      running: boolean;
      error?: string;
    }>;
    getSessionRuntimeStatuses: (
      sessionIds: string[],
      options?: { includeSubagents?: boolean; forceRefresh?: boolean },
    ) => Promise<{
      success: boolean;
      statuses: Record<
        string,
        {
          known: boolean;
          mainRunning: boolean;
          subagentRunning: boolean;
          running: boolean;
        }
      >;
      error?: string;
    }>;
    patchSessionModel: (options: {
      sessionId: string;
      model: string;
      agentId?: string;
    }) => Promise<{ success: boolean; error?: string }>;
    listSessions: (
      agentId?: string,
    ) => Promise<{ success: boolean; sessions?: CoworkSessionSummary[]; error?: string }>;
    getSessionGoal: (sessionId: string) => Promise<{
      success: boolean;
      goal?: import('@shared/sessionGoal').SessionGoal;
      error?: string;
    }>;
    getContextUsage: (sessionId: string) => Promise<{
      success: boolean;
      totalTokens?: number;
      contextTokens?: number;
      totalTokensFresh?: boolean;
      error?: string;
    }>;
    deleteMessage: (
      sessionId: string,
      messageId: string,
    ) => Promise<{ success: boolean; error?: string }>;
    deleteMessagesFrom: (
      sessionId: string,
      messageId: string,
    ) => Promise<{ success: boolean; error?: string }>;
    respondToInteraction: (options: {
      requestId: string;
      result: CoworkInteractionResult;
    }) => Promise<{ success: boolean; error?: string }>;
    getConfig: () => Promise<{ success: boolean; config?: CoworkConfig; error?: string }>;
    setConfig: (config: CoworkConfigUpdate) => Promise<{ success: boolean; error?: string }>;
    setDefaultModel: (options: {
      modelId: string;
      providerKey?: string;
      agentId?: string;
    }) => Promise<{ success: boolean; error?: string }>;
    onStreamMessage: (
      callback: (data: { sessionId: string; message: CoworkMessage }) => void,
    ) => () => void;
    onStreamMessageUpdate: (
      callback: (data: { sessionId: string; messageId: string; content: string }) => void,
    ) => () => void;
    onStreamThinkingUpdate: (
      callback: (data: { sessionId: string; messageId: string; thinkingDelta: string }) => void,
    ) => () => void;
    onStreamMessageMetadataUpdate: (
      callback: (data: {
        sessionId: string;
        messageId: string;
        metadata: Record<string, unknown>;
        usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
      }) => void,
    ) => () => void;
    onStreamMessageDelete: (
      callback: (data: { sessionId: string; messageId: string }) => void,
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
    getSubTaskStatus: (sessionId?: string) => Promise<{
      success: boolean;
      subagents?: Array<{
        id: string;
        sessionKey: string;
        label: string;
        status: 'running' | 'done' | 'failed' | 'killed' | 'timeout';
        task?: string;
        model?: string;
        startedAt?: number;
        endedAt?: number;
        runtimeMs?: number;
        totalTokens?: number;
      }>;
    }>;
    getSubTaskSession: (sessionKey: string) => Promise<{
      success: boolean;
      session?: CoworkSession | null;
      error?: string;
    }>;
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
    showImageContextMenu: (
      imageUrl: string,
    ) => Promise<{ success: boolean; error?: string }>;
    openPath: (
      filePath: string,
      workingDirectory?: string,
    ) => Promise<{ success: boolean; error?: string; notFound?: boolean }>;
    readPreviewFile: (
      filePath: string,
      workingDirectory?: string,
    ) => Promise<{
      success: boolean;
      content?: string;
      filePath?: string;
      error?: string;
      notFound?: boolean;
    }>;
    showItemInFolder: (
      filePath: string,
      workingDirectory?: string,
    ) => Promise<{ success: boolean; error?: string; notFound?: boolean }>;
    openExternal: (url: string) => Promise<{ success: boolean; error?: string }>;
  };
  autoLaunch: {
    get: () => Promise<{ enabled: boolean }>;
    set: (enabled: boolean) => Promise<{ success: boolean; error?: string }>;
  };
  preventSleep: {
    get: () => Promise<{ enabled: boolean }>;
    set: (enabled: boolean) => Promise<{ success: boolean; error?: string }>;
  };
  developerConfig: {
    get: () => Promise<import('../../shared/developerConfig').DeveloperConfig>;
  };
  appInfo: {
    getVersion: () => Promise<string>;
    getOpenclawVersion: () => Promise<string>;
    getSystemLocale: () => Promise<string>;
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
    runManually: (id: string) => Promise<{ success: boolean; error?: string }>;
    listRuns: (
      taskId: string,
      limit?: number,
      offset?: number,
    ) => Promise<{
      success: boolean;
      runs?: ScheduledTaskRun[];
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
    onResultUpserted: (
      callback: (data: ScheduledTaskResultUpsertedEvent) => void,
    ) => () => void;
    onUnreadCountChanged: (
      callback: (data: ScheduledTaskUnreadCountEvent) => void,
    ) => () => void;
    onRefresh: (callback: () => void) => () => void;
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
