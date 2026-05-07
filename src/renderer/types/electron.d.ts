interface ApiResponse {
  ok: boolean;
  status: number;
  statusText: string;
  headers: Record<string, string>;
  data: any;
  error?: string;
}

interface ApiStreamResponse {
  ok: boolean;
  status: number;
  statusText: string;
  error?: string;
}

// Cowork types for IPC
interface CoworkSession {
  id: string;
  title: string;
  claudeSessionId: string | null;
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
  toolResult?: string;
  toolUseId?: string | null;
  error?: string;
  isError?: boolean;
  isStreaming?: boolean;
  isFinal?: boolean;
  skillIds?: string[];
  [key: string]: unknown;
}

interface CoworkMessage {
  id: string;
  type: 'user' | 'assistant' | 'tool_use' | 'tool_result' | 'system' | 'subagent_completion';
  content: string;
  timestamp: number;
  metadata?: CoworkMessageMetadata;
  thinkingContent?: string;
  modelName?: string;
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

interface CoworkPermissionRequest {
  sessionId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  requestId: string;
  toolUseId?: string | null;
}

interface CoworkApiConfig {
  apiKey: string;
  baseURL: string;
  model: string;
  apiType?: 'anthropic' | 'openai';
}

type OpenClawEnginePhase =
  | 'not_installed'
  | 'installing'
  | 'ready'
  | 'starting'
  | 'running'
  | 'error';

interface OpenClawEngineStatus {
  phase: OpenClawEnginePhase;
  version: string | null;
  progressPercent?: number;
  message?: string;
  canRetry: boolean;
}

interface QwenOAuthToken {
  access: string;
  refresh: string;
  expires: number;
  resourceUrl?: string;
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
  source?:
    | 'workspace'
    | 'agents-project'
    | 'agents-personal'
    | 'managed'
    | 'openclaw-bundled'
    | 'extra-dir'
    | 'unknown';
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

// ClawHub marketplace types
interface ClawHubSkill {
  slug: string;
  name: string;
  description: string;
  version: string;
  author?: string;
  tags?: string[];
  homepage?: string;
}

interface ClawHubSkillDetail extends ClawHubSkill {
  readme?: string;
  install?: {
    requires?: {
      bins?: string[];
      env?: string[];
    };
  };
}

type EmailConnectivityCheckCode = 'imap_connection' | 'smtp_connection';
type EmailConnectivityCheckLevel = 'pass' | 'fail';
type EmailConnectivityVerdict = 'pass' | 'fail';

interface EmailConnectivityCheck {
  code: EmailConnectivityCheckCode;
  level: EmailConnectivityCheckLevel;
  message: string;
  durationMs: number;
}

interface EmailConnectivityTestResult {
  testedAt: number;
  verdict: EmailConnectivityVerdict;
  checks: EmailConnectivityCheck[];
}

type CoworkPermissionResult =
  | {
      behavior: 'allow';
      updatedInput?: Record<string, unknown>;
      updatedPermissions?: Record<string, unknown>[];
      toolUseID?: string;
    }
  | {
      behavior: 'deny';
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

interface McpMarketplaceServer {
  id: string;
  name: string;
  description_zh: string;
  description_en: string;
  category: string;
  transportType: 'stdio' | 'sse' | 'http';
  command: string;
  defaultArgs: string[];
  requiredEnvKeys?: string[];
  optionalEnvKeys?: string[];
}

interface McpMarketplaceCategory {
  id: string;
  name_zh: string;
  name_en: string;
}

interface McpMarketplaceData {
  categories: McpMarketplaceCategory[];
  servers: McpMarketplaceServer[];
}

import type { Agent, PresetAgent } from './agent';

interface IElectronAPI {
  platform: string;
  arch: string;
  store: {
    get: (key: string) => Promise<any>;
    set: (key: string, value: any) => Promise<void>;
    remove: (key: string) => Promise<void>;
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
    // Gateway-based skill management
    install: (params: {
      source: 'clawhub';
      slug: string;
      version?: string;
      force?: boolean;
    }) => Promise<{ success: boolean; error?: string; gatewayOffline?: boolean }>;
    // Offline skill import
    import: (archivePath: string) => Promise<{
      success: boolean;
      skillId?: string;
      error?: string;
      skills?: Skill[];
    }>;
    // Offline skill import from folder
    importFolder: (folderPath: string) => Promise<{
      success: boolean;
      skillId?: string;
      error?: string;
      skills?: Skill[];
    }>;
    search: (options?: { query?: string; limit?: number }) => Promise<{
      success: boolean;
      results?: ClawHubSkill[];
      error?: string;
      gatewayOffline?: boolean;
    }>;
    detail: (options: { slug: string }) => Promise<{
      success: boolean;
      detail?: ClawHubSkillDetail;
      error?: string;
      gatewayOffline?: boolean;
    }>;
    // Deprecated: no longer functional
    delete: (id: string) => Promise<{ success: boolean; skills?: Skill[]; error?: string }>;
    getRoot: () => Promise<{ success: boolean; path?: string; error?: string }>;
    autoRoutingPrompt: () => Promise<{ success: boolean; prompt?: string | null; error?: string }>;
    getConfig: (
      skillId: string,
    ) => Promise<{ success: boolean; config?: Record<string, string>; error?: string }>;
    setConfig: (
      skillId: string,
      config: Record<string, string>,
    ) => Promise<{ success: boolean; error?: string }>;
    testEmailConnectivity: (
      skillId: string,
      config: Record<string, string>,
    ) => Promise<{ success: boolean; result?: EmailConnectivityTestResult; error?: string }>;
    onChanged: (callback: () => void) => () => void;
  };
  mcp: {
    list: () => Promise<{ success: boolean; servers?: McpServerConfigIPC[]; error?: string }>;
    create: (
      data: any,
    ) => Promise<{ success: boolean; servers?: McpServerConfigIPC[]; error?: string }>;
    update: (
      id: string,
      data: any,
    ) => Promise<{ success: boolean; servers?: McpServerConfigIPC[]; error?: string }>;
    delete: (
      id: string,
    ) => Promise<{ success: boolean; servers?: McpServerConfigIPC[]; error?: string }>;
    setEnabled: (options: {
      id: string;
      enabled: boolean;
    }) => Promise<{ success: boolean; servers?: McpServerConfigIPC[]; error?: string }>;
    refreshBridge: () => Promise<{ success: boolean; tools: number; error?: string }>;
    onBridgeSyncStart: (callback: () => void) => () => void;
    onBridgeSyncDone: (callback: (data: { tools: number; error?: string }) => void) => () => void;
  };
  agents: {
    list: () => Promise<Agent[]>;
    get: (id: string) => Promise<Agent | null>;
    create: (request: {
      id?: string;
      name: string;
      description?: string;
      systemPrompt?: string;
      identity?: string;
      model?: string;
      icon?: string;
      skillIds?: string[];
      source?: string;
      presetId?: string;
    }) => Promise<Agent>;
    update: (
      id: string,
      updates: {
        name?: string;
        description?: string;
        systemPrompt?: string;
        identity?: string;
        model?: string;
        icon?: string;
        skillIds?: string[];
        enabled?: boolean;
      },
    ) => Promise<Agent>;
    delete: (id: string) => Promise<void>;
    presets: () => Promise<PresetAgent[]>;
    addPreset: (presetId: string) => Promise<Agent>;
  };
  api: {
    fetch: (options: {
      url: string;
      method: string;
      headers: Record<string, string>;
      body?: string;
    }) => Promise<ApiResponse>;
    stream: (options: {
      url: string;
      method: string;
      headers: Record<string, string>;
      body?: string;
      requestId: string;
    }) => Promise<ApiStreamResponse>;
    cancelStream: (requestId: string) => Promise<boolean>;
    onStreamData: (requestId: string, callback: (chunk: string) => void) => () => void;
    onStreamDone: (requestId: string, callback: () => void) => () => void;
    onStreamError: (requestId: string, callback: (error: string) => void) => () => void;
    onStreamAbort: (requestId: string, callback: () => void) => () => void;
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
      install: () => Promise<{ success: boolean; status?: OpenClawEngineStatus; error?: string }>;
      retryInstall: () => Promise<{
        success: boolean;
        status?: OpenClawEngineStatus;
        error?: string;
      }>;
      restartGateway: () => Promise<{
        success: boolean;
        status?: OpenClawEngineStatus;
        error?: string;
      }>;
      getPort: () => Promise<{ success: boolean; port?: number; error?: string }>;
      getToken: () => Promise<{ success: boolean; token?: string; error?: string }>;
      setPort: (port: number) => Promise<{ success: boolean; error?: string }>;
      onProgress: (callback: (status: OpenClawEngineStatus) => void) => () => void;
    };
  };
  ipcRenderer: {
    send: (channel: string, ...args: any[]) => void;
    on: (channel: string, func: (...args: any[]) => void) => () => void;
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
      imageAttachments?: Array<{ name: string; mimeType: string; base64Data: string }>;
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
      imageAttachments?: Array<{ name: string; mimeType: string; base64Data: string }>;
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
    remoteManaged: (
      sessionId: string,
    ) => Promise<{ success: boolean; remoteManaged: boolean; error?: string }>;
    patchSessionModel: (options: {
      sessionId: string;
      model: string;
      agentId?: string;
    }) => Promise<{ success: boolean; error?: string }>;
    listSessions: (
      agentId?: string,
    ) => Promise<{ success: boolean; sessions?: CoworkSessionSummary[]; error?: string }>;
    getContextUsage: (sessionId: string) => Promise<{
      success: boolean;
      totalTokens?: number;
      contextTokens?: number;
      error?: string;
    }>;
    deleteMessage: (
      sessionId: string,
      messageId: string,
    ) => Promise<{ success: boolean; error?: string }>;
    exportResultImage: (options: {
      rect: { x: number; y: number; width: number; height: number };
      defaultFileName?: string;
    }) => Promise<{ success: boolean; canceled?: boolean; path?: string; error?: string }>;
    captureImageChunk: (options: {
      rect: { x: number; y: number; width: number; height: number };
    }) => Promise<{
      success: boolean;
      width?: number;
      height?: number;
      pngBase64?: string;
      error?: string;
    }>;
    saveResultImage: (options: {
      pngBase64: string;
      defaultFileName?: string;
    }) => Promise<{ success: boolean; canceled?: boolean; path?: string; error?: string }>;
    exportSessionText: (options: {
      content: string;
      defaultFileName?: string;
      fileExtension?: string;
    }) => Promise<{ success: boolean; canceled?: boolean; path?: string; error?: string }>;
    respondToPermission: (options: {
      requestId: string;
      result: CoworkPermissionResult;
    }) => Promise<{ success: boolean; error?: string }>;
    getConfig: () => Promise<{ success: boolean; config?: CoworkConfig; error?: string }>;
    setConfig: (config: CoworkConfigUpdate) => Promise<{ success: boolean; error?: string }>;
    setDefaultModel: (options: {
      modelId: string;
      providerKey?: string;
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
      }) => void,
    ) => () => void;
    onStreamMessageDelete: (
      callback: (data: { sessionId: string; messageId: string }) => void,
    ) => () => void;
    onStreamPermission: (
      callback: (data: { sessionId: string; request: CoworkPermissionRequest }) => void,
    ) => () => void;
    onStreamPermissionDismiss: (callback: (data: { requestId: string }) => void) => () => void;
    onStreamComplete: (
      callback: (data: {
        sessionId: string;
        claudeSessionId: string | null;
        finalStatus?: 'idle' | 'running' | 'completed' | 'error';
      }) => void,
    ) => () => void;
    onStreamError: (callback: (data: { sessionId: string; error: string }) => void) => () => void;
    onSessionsChanged: (callback: () => void) => () => void;
    // Subagent streaming events
    onSubagentMessage: (
      callback: (data: {
        parentSessionId: string;
        agentId: string;
        message: CoworkMessage;
      }) => void,
    ) => () => void;
    onSubagentMessageUpdate: (
      callback: (data: {
        parentSessionId: string;
        agentId: string;
        messageId: string;
        content: string;
      }) => void,
    ) => () => void;
    onSubagentThinkingUpdate: (
      callback: (data: {
        parentSessionId: string;
        agentId: string;
        messageId: string;
        thinkingDelta: string;
      }) => void,
    ) => () => void;
    onSubagentToolResult: (
      callback: (data: {
        parentSessionId: string;
        agentId: string;
        toolUseId: string;
        result: string;
        isError: boolean;
      }) => void,
    ) => () => void;
    getSubTaskStatus: (sessionId?: string) => Promise<{
      success: boolean;
      statuses: Record<string, 'pending' | 'running' | 'done'>;
      displayLabels?: Record<string, string>;
    }>;
    getSubTaskHistory: (options: {
      parentSessionId: string;
      agentId: string;
      sessionKey?: string;
    }) => Promise<{
      success: boolean;
      messages?: CoworkMessage[];
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
    selectDirectory: () => Promise<{ success: boolean; path: string | null }>;
    selectFile: (options?: {
      title?: string;
      filters?: { name: string; extensions: string[] }[];
    }) => Promise<{ success: boolean; path: string | null }>;
    selectFiles: (options?: {
      title?: string;
      filters?: { name: string; extensions: string[] }[];
    }) => Promise<{ success: boolean; paths: string[] }>;
    selectFolders: (options?: { title?: string }) => Promise<{
      success: boolean;
      paths: string[];
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
    openPath: (filePath: string) => Promise<{ success: boolean; error?: string }>;
    showItemInFolder: (filePath: string) => Promise<{ success: boolean; error?: string }>;
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
  appInfo: {
    getVersion: () => Promise<string>;
    getOpenclawVersion: () => Promise<string>;
    getSystemLocale: () => Promise<string>;
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
  };
  scheduledTasks: {
    list: () => Promise<{
      success: boolean;
      tasks?: import('../../scheduledTask/types').ScheduledTask[];
      error?: string;
    }>;
    get: (id: string) => Promise<{
      success: boolean;
      task?: import('../../scheduledTask/types').ScheduledTask;
      error?: string;
    }>;
    create: (input: import('../../scheduledTask/types').ScheduledTaskInput) => Promise<{
      success: boolean;
      task?: import('../../scheduledTask/types').ScheduledTask;
      error?: string;
    }>;
    update: (
      id: string,
      input: Partial<import('../../scheduledTask/types').ScheduledTaskInput>,
    ) => Promise<{
      success: boolean;
      task?: import('../../scheduledTask/types').ScheduledTask;
      error?: string;
    }>;
    delete: (id: string) => Promise<{ success: boolean; error?: string }>;
    toggle: (
      id: string,
      enabled: boolean,
    ) => Promise<{
      success: boolean;
      task?: import('../../scheduledTask/types').ScheduledTask;
      warning?: string;
      error?: string;
    }>;
    runManually: (id: string) => Promise<{ success: boolean; error?: string }>;
    stop: (id: string) => Promise<{ success: boolean; error?: string }>;
    listRuns: (
      taskId: string,
      limit?: number,
      offset?: number,
    ) => Promise<{
      success: boolean;
      runs?: import('../../scheduledTask/types').ScheduledTaskRun[];
      error?: string;
    }>;
    countRuns: (taskId: string) => Promise<{ success: boolean; count?: number; error?: string }>;
    listAllRuns: (
      limit?: number,
      offset?: number,
    ) => Promise<{
      success: boolean;
      runs?: import('../../scheduledTask/types').ScheduledTaskRunWithName[];
      error?: string;
    }>;
    resolveSession: (sessionKey: string) => Promise<{
      success: boolean;
      session?: import('./cowork').CoworkSession | null;
      error?: string;
    }>;
    listChannels: () => Promise<{
      success: boolean;
      channels?: import('../../scheduledTask/types').ScheduledTaskChannelOption[];
      error?: string;
    }>;
    listChannelConversations?: (
      channel: string,
      accountId?: string,
    ) => Promise<{
      success: boolean;
      conversations?: import('../../scheduledTask/types').ScheduledTaskConversationOption[];
      error?: string;
    }>;
    onStatusUpdate: (
      callback: (data: import('../../scheduledTask/types').ScheduledTaskStatusEvent) => void,
    ) => () => void;
    onRunUpdate: (
      callback: (data: import('../../scheduledTask/types').ScheduledTaskRunEvent) => void,
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
  enterprise: {
    getConfig: () => Promise<{
      ui?: Record<string, 'hide' | 'disable' | 'readonly'>;
      disableUpdate?: boolean;
      version: string;
      name: string;
    } | null>;
  };
  networkStatus: {
    send: (status: 'online' | 'offline') => void;
  };
  qwen: {
    oauthLogin: () => Promise<{ success: boolean; data?: QwenOAuthToken; error?: string }>;
    oauthRefresh: (
      refreshToken: string,
    ) => Promise<{ success: boolean; data?: QwenOAuthToken; error?: string }>;
    onOAuthProgress: (callback: (message: string) => void) => () => void;
  };
}

declare global {
  interface Window {
    electron: IElectronAPI;
  }
}

export {};
