import { contextBridge, ipcRenderer } from 'electron';

import {
  type AppReleaseHistoryResult,
  type AppUpdateCheckFrequency,
  AppUpdateIpc,
  type AppUpdatePreferences,
  type AppUpdateState,
} from '../shared/appUpdate';
import {
  type BrowserActionResult,
  type BrowserConnectionTestResult,
  BrowserIpc,
  type BrowserMode,
  type BrowserModeSwitchAvailabilityResult,
  type BrowserModeUpdateResult,
  type BrowserStatusResult,
} from '../shared/browser';
import type { CoworkAttachmentPayload } from '../shared/cowork/attachments';
import { CoworkSessionDetailsIpc } from '../shared/cowork/sessionDetails';
import { type GenerateSessionTitleRequest, SessionTitleIpc } from '../shared/cowork/sessionTitle';
import { CoworkSubagentDetailsIpc } from '../shared/cowork/subagentDetails';
import { DeveloperConfigIpc } from '../shared/developerConfig';
import { DialogIpc, type SaveTextFileOptions } from '../shared/dialogIpc';
import {
  type FilePreviewEditAuthorizationRequest,
  type FilePreviewEditAuthorizationResult,
  FilePreviewIpc,
  type FilePreviewWriteRequest,
  type FilePreviewWriteResult,
} from '../shared/filePreview';
import {
  ImagePreviewIpc,
  type ImagePreviewOpenRequest,
  type ImagePreviewOpenResult,
} from '../shared/imagePreview';
import { LogIpc } from '../shared/logIpc';
import { type ApiFetchOptions, NetworkIpc } from '../shared/network';
import {
  type AgentRuntimeSettings,
  AgentRuntimeSettingsIpc,
} from '../shared/openclaw/agentRuntimeSettings';
import {
  type ApprovalDecision,
  type ApprovalKind,
  type ApprovalRequest,
  type ApprovalResolved,
  OpenClawApprovalIpc,
} from '../shared/openclaw/approvals';
import {
  CoworkInteractionIpc,
  type ExtensionDeleteRequest,
  type ExtensionImportProgress,
  type ExtensionImportRequest,
  ExtensionIpc,
  type ExtensionSetEnabledRequest,
  type ExtensionUpdateConfigurationRequest,
} from '../shared/openclaw/extensions';
import { OpenClawHistoryIpc, type OpenClawPagedHistoryParams } from '../shared/openclaw/historyIpc';
import { HookIpc } from '../shared/openclaw/hooks';
import { MemoryIpc } from '../shared/openclaw/memory';
import {
  type OpenClawSessionMigrationConfirmRequest,
  OpenClawSessionMigrationIpc,
  type OpenClawSessionMigrationProgress,
} from '../shared/openclaw/sessionMigration';
import {
  SystemPromptReplacementIpc,
  type SystemPromptReplacementRule,
} from '../shared/openclaw/systemPromptReplacements';
import { UsageStatsIpc } from '../shared/openclaw/usage';
import {
  type MarketplaceDetailRequest,
  type MarketplaceInstallRequest,
  MarketplaceIpc,
  type MarketplaceQuery,
  type PluginKind,
} from '../shared/plugins/marketplace';
import type { OpenClawSkillSource } from '../shared/plugins/skills';
import { IpcChannel as ScheduledTaskIpc } from '../shared/scheduledTask/constants';
import type {
  ScheduledTaskInput,
  ScheduledTaskResultQuery,
  ScheduledTaskResultUpsertedEvent,
  ScheduledTaskRunEvent,
  ScheduledTaskStatusEvent,
  ScheduledTaskUnreadCountEvent,
} from '../shared/scheduledTask/types';
import {
  GoalExecutionIpc,
  type GoalExecutionSnapshot,
  SessionGoalIpc,
} from '../shared/sessionGoal';
import { SlashCommandIpc } from '../shared/slashCommands';

// 暴露安全的 API 到渲染进程
contextBridge.exposeInMainWorld('electron', {
  platform: process.platform,
  arch: process.arch,
  store: {
    get: (key: string) => ipcRenderer.invoke('store:get', key),
    set: (key: string, value: unknown) => ipcRenderer.invoke('store:set', key, value),
    remove: (key: string) => ipcRenderer.invoke('store:remove', key),
  },
  marketplace: {
    listSources: (kind?: PluginKind) => ipcRenderer.invoke(MarketplaceIpc.ListSources, kind),
    search: (query: MarketplaceQuery) => ipcRenderer.invoke(MarketplaceIpc.Search, query),
    detail: (request: MarketplaceDetailRequest) =>
      ipcRenderer.invoke(MarketplaceIpc.Detail, request),
    install: (request: MarketplaceInstallRequest) =>
      ipcRenderer.invoke(MarketplaceIpc.Install, request),
  },
  skills: {
    list: () => ipcRenderer.invoke('skills:list'),
    setEnabled: (options: { id: string; enabled: boolean }) =>
      ipcRenderer.invoke('skills:setEnabled', options),
    // Offline import from a local folder or archive
    importPath: (sourcePath: string) => ipcRenderer.invoke('skills:import', sourcePath),
    delete: (options: { id: string; source?: OpenClawSkillSource }) =>
      ipcRenderer.invoke('skills:delete', options),
  },
  extensions: {
    list: () => ipcRenderer.invoke(ExtensionIpc.List),
    delete: (request: ExtensionDeleteRequest) => ipcRenderer.invoke(ExtensionIpc.Delete, request),
    setEnabled: (request: ExtensionSetEnabledRequest) =>
      ipcRenderer.invoke(ExtensionIpc.SetEnabled, request),
    updateConfiguration: (request: ExtensionUpdateConfigurationRequest) =>
      ipcRenderer.invoke(ExtensionIpc.UpdateConfiguration, request),
    // Import a native OpenClaw extension from a local folder or archive.
    importPath: (request: ExtensionImportRequest) =>
      ipcRenderer.invoke(ExtensionIpc.Import, request),
    onImportProgress: (callback: (progress: ExtensionImportProgress) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, progress: ExtensionImportProgress) =>
        callback(progress);
      ipcRenderer.on(ExtensionIpc.ImportProgress, handler);
      return () => ipcRenderer.removeListener(ExtensionIpc.ImportProgress, handler);
    },
  },
  hooks: {
    list: () => ipcRenderer.invoke(HookIpc.List),
    importPath: (sourcePath: string) => ipcRenderer.invoke(HookIpc.Import, sourcePath),
    delete: (hookId: string) => ipcRenderer.invoke(HookIpc.Delete, hookId),
    setEnabled: (options: { id: string; enabled: boolean }) =>
      ipcRenderer.invoke(HookIpc.SetEnabled, options),
  },
  slashCommands: {
    list: (options?: { agentId?: string | null }) =>
      ipcRenderer.invoke(SlashCommandIpc.List, options || {}),
  },
  mcp: {
    list: () => ipcRenderer.invoke('mcp:list'),
    listExtensionServers: () => ipcRenderer.invoke('mcp:listExtensionServers'),
    create: (data: unknown) => ipcRenderer.invoke('mcp:create', data),
    update: (id: string, data: unknown) => ipcRenderer.invoke('mcp:update', id, data),
    delete: (id: string) => ipcRenderer.invoke('mcp:delete', id),
    setEnabled: (options: { id: string; enabled: boolean }) =>
      ipcRenderer.invoke('mcp:setEnabled', options),
    syncConfig: () => ipcRenderer.invoke('mcp:syncConfig'),
    probe: (id: string) => ipcRenderer.invoke('mcp:probe', id),
    readResource: (options: { id: string; uri: string }) =>
      ipcRenderer.invoke('mcp:readResource', options),
    onConfigSyncStart: (callback: () => void) => {
      const handler = () => callback();
      ipcRenderer.on('mcp:config:syncStart', handler);
      return () => ipcRenderer.removeListener('mcp:config:syncStart', handler);
    },
    onConfigSyncDone: (callback: (data: { tools: number; error?: string }) => void) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        data: { tools: number; error?: string },
      ) => callback(data);
      ipcRenderer.on('mcp:config:syncDone', handler);
      return () => ipcRenderer.removeListener('mcp:config:syncDone', handler);
    },
  },
  permissions: {
    checkCalendar: () => ipcRenderer.invoke('permissions:checkCalendar'),
    requestCalendar: () => ipcRenderer.invoke('permissions:requestCalendar'),
  },
  browser: {
    getStatus: (): Promise<BrowserStatusResult> => ipcRenderer.invoke(BrowserIpc.GetStatus),
    canSetMode: (): Promise<BrowserModeSwitchAvailabilityResult> =>
      ipcRenderer.invoke(BrowserIpc.CanSetMode),
    setMode: (mode: BrowserMode): Promise<BrowserModeUpdateResult> =>
      ipcRenderer.invoke(BrowserIpc.SetMode, mode),
    openRemoteDebugging: (): Promise<BrowserActionResult> =>
      ipcRenderer.invoke(BrowserIpc.OpenRemoteDebugging),
    testConnection: (): Promise<BrowserConnectionTestResult> =>
      ipcRenderer.invoke(BrowserIpc.TestConnection),
    openExtensionManagement: (): Promise<BrowserActionResult> =>
      ipcRenderer.invoke(BrowserIpc.OpenExtensionManagement),
    revealExtension: (): Promise<BrowserActionResult> =>
      ipcRenderer.invoke(BrowserIpc.RevealExtension),
    copyExtensionPairing: (): Promise<BrowserActionResult> =>
      ipcRenderer.invoke(BrowserIpc.CopyExtensionPairing),
    testExtensionConnection: (): Promise<BrowserConnectionTestResult> =>
      ipcRenderer.invoke(BrowserIpc.TestExtensionConnection),
  },
  api: {
    // 普通 API 请求（非流式）
    fetch: (options: ApiFetchOptions) => ipcRenderer.invoke(NetworkIpc.Fetch, options),
    cancelFetch: (requestId: string): Promise<void> =>
      ipcRenderer.invoke(NetworkIpc.CancelFetch, requestId),
  },
  ipcRenderer: {
    send: (channel: string, ...args: unknown[]) => {
      ipcRenderer.send(channel, ...args);
    },
    on: (channel: string, func: (...args: unknown[]) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, ...args: unknown[]) => func(...args);
      ipcRenderer.on(channel, handler);
      return () => ipcRenderer.removeListener(channel, handler);
    },
  },
  window: {
    minimize: () => ipcRenderer.send('window-minimize'),
    toggleMaximize: () => ipcRenderer.send('window-maximize'),
    close: () => ipcRenderer.send('window-close'),
    isMaximized: () => ipcRenderer.invoke('window:isMaximized'),
    showSystemMenu: (position: { x: number; y: number }) =>
      ipcRenderer.send('window:showSystemMenu', position),
    onStateChanged: (
      callback: (state: {
        isMaximized: boolean;
        isFullscreen: boolean;
        isFocused: boolean;
      }) => void,
    ) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        state: { isMaximized: boolean; isFullscreen: boolean; isFocused: boolean },
      ) => callback(state);
      ipcRenderer.on('window:state-changed', handler);
      return () => ipcRenderer.removeListener('window:state-changed', handler);
    },
  },
  getApiConfig: () => ipcRenderer.invoke('get-api-config'),
  checkApiConfig: (options?: { probeModel?: boolean }) =>
    ipcRenderer.invoke('check-api-config', options),
  saveApiConfig: (config: { apiKey: string; baseURL: string; model: string; apiType?: 'openai' }) =>
    ipcRenderer.invoke('save-api-config', config),
  generateSessionTitle: (request: GenerateSessionTitleRequest) =>
    ipcRenderer.invoke(SessionTitleIpc.Generate, request),
  getRecentCwds: (limit?: number) => ipcRenderer.invoke('get-recent-cwds', limit),
  openclaw: {
    approvals: {
      list: () => ipcRenderer.invoke(OpenClawApprovalIpc.List),
      resolve: (id: string, decision: ApprovalDecision, kind: ApprovalKind) =>
        ipcRenderer.invoke(OpenClawApprovalIpc.Resolve, { id, decision, kind }),
      onRequested: (callback: (request: ApprovalRequest) => void) => {
        const handler = (_event: Electron.IpcRendererEvent, request: ApprovalRequest) =>
          callback(request);
        ipcRenderer.on(OpenClawApprovalIpc.Requested, handler);
        return () => ipcRenderer.removeListener(OpenClawApprovalIpc.Requested, handler);
      },
      onResolved: (callback: (resolved: ApprovalResolved) => void) => {
        const handler = (_event: Electron.IpcRendererEvent, resolved: ApprovalResolved) =>
          callback(resolved);
        ipcRenderer.on(OpenClawApprovalIpc.Resolved, handler);
        return () => ipcRenderer.removeListener(OpenClawApprovalIpc.Resolved, handler);
      },
      onSnapshot: (callback: (requests: ApprovalRequest[]) => void) => {
        const handler = (_event: Electron.IpcRendererEvent, requests: ApprovalRequest[]) =>
          callback(requests);
        ipcRenderer.on(OpenClawApprovalIpc.Snapshot, handler);
        return () => ipcRenderer.removeListener(OpenClawApprovalIpc.Snapshot, handler);
      },
    },
    engine: {
      getStatus: () => ipcRenderer.invoke('openclaw:engine:getStatus'),
      restartGateway: () => ipcRenderer.invoke('openclaw:engine:restartGateway'),
      getPort: () => ipcRenderer.invoke('openclaw:engine:getPort'),
      getToken: () => ipcRenderer.invoke('openclaw:engine:getToken'),
      setPort: (port: number) => ipcRenderer.invoke('openclaw:engine:setPort', port),
      getSystemPromptReplacementRules: () =>
        ipcRenderer.invoke(SystemPromptReplacementIpc.GetRules),
      setSystemPromptReplacementRules: (rules: SystemPromptReplacementRule[]) =>
        ipcRenderer.invoke(SystemPromptReplacementIpc.SetRules, rules),
      openTerminal: () => ipcRenderer.invoke('openclaw:engine:openTerminal'),
      onProgress: (callback: (status: unknown) => void) => {
        const handler = (_event: Electron.IpcRendererEvent, status: unknown) => callback(status);
        ipcRenderer.on('openclaw:engine:onProgress', handler);
        return () => ipcRenderer.removeListener('openclaw:engine:onProgress', handler);
      },
      migration: {
        plan: () => ipcRenderer.invoke(OpenClawSessionMigrationIpc.Plan),
        confirm: (request: OpenClawSessionMigrationConfirmRequest) =>
          ipcRenderer.invoke(OpenClawSessionMigrationIpc.Confirm, request),
        onProgress: (callback: (progress: OpenClawSessionMigrationProgress) => void) => {
          const handler = (
            _event: Electron.IpcRendererEvent,
            progress: OpenClawSessionMigrationProgress,
          ) => callback(progress);
          ipcRenderer.on(OpenClawSessionMigrationIpc.Progress, handler);
          return () => ipcRenderer.removeListener(OpenClawSessionMigrationIpc.Progress, handler);
        },
      },
    },
    history: {
      getToolInputs: (params: { sessionKey: string; toolCallIds: string[] }) =>
        ipcRenderer.invoke(OpenClawHistoryIpc.GetToolInputs, params),
      getCompactionDetails: (params: { sessionKey: string; entryIds: string[] }) =>
        ipcRenderer.invoke(OpenClawHistoryIpc.GetCompactionDetails, params),
      getPagedHistory: (params: OpenClawPagedHistoryParams) =>
        ipcRenderer.invoke(OpenClawHistoryIpc.GetPagedHistory, params),
    },
    memory: {
      getOverview: () => ipcRenderer.invoke(MemoryIpc.GetOverview),
      getDocument: (relativePath: string) =>
        ipcRenderer.invoke(MemoryIpc.GetDocument, relativePath),
      search: (query: string) => ipcRenderer.invoke(MemoryIpc.Search, query),
      rebuildIndex: () => ipcRenderer.invoke(MemoryIpc.RebuildIndex),
    },
    usage: {
      getDaily: (options: { days: number; utcOffset: string }) =>
        ipcRenderer.invoke(UsageStatsIpc.GetDaily, options),
    },
  },
  agents: {
    list: async () => {
      const result = await ipcRenderer.invoke('agents:list');
      return result?.success ? result.agents : [];
    },
  },
  cowork: {
    // Session management
    startSession: (options: {
      prompt: string;
      cwd?: string;
      title?: string;
      activeSkillIds?: string[];
      agentId?: string;
      attachments?: CoworkAttachmentPayload[];
      clientTurnId?: string;
      startedAt?: number;
    }) => ipcRenderer.invoke('cowork:session:start', options),
    stopSession: (sessionId: string) => ipcRenderer.invoke('cowork:session:stop', sessionId),
    deleteSession: (sessionId: string) => ipcRenderer.invoke('cowork:session:delete', sessionId),
    deleteSessions: (sessionIds: string[]) =>
      ipcRenderer.invoke('cowork:session:deleteBatch', sessionIds),
    setSessionPinned: (options: { sessionId: string; pinned: boolean }) =>
      ipcRenderer.invoke('cowork:session:pin', options),
    renameSession: (options: { sessionId: string; title: string }) =>
      ipcRenderer.invoke('cowork:session:rename', options),
    setSessionPermissionMode: (options: {
      sessionId: string;
      permissionMode: 'ask' | 'auto' | 'full';
      deferIfActive?: boolean;
    }) => ipcRenderer.invoke('cowork:session:setPermissionMode', options),
    getSession: (sessionId: string) => ipcRenderer.invoke('cowork:session:get', sessionId),
    getSessionDetails: (sessionId: string) =>
      ipcRenderer.invoke(CoworkSessionDetailsIpc.Get, sessionId),
    getGatewaySessionId: (sessionId: string) =>
      ipcRenderer.invoke('cowork:session:gatewaySessionId', sessionId),
    remoteManaged: (sessionId: string) =>
      ipcRenderer.invoke('cowork:session:remoteManaged', sessionId),
    getSessionRuntimeStatus: (
      sessionId: string,
      options?: { includeSubagents?: boolean; forceRefresh?: boolean; fullScan?: boolean },
    ) => ipcRenderer.invoke('cowork:session:runtimeStatus', sessionId, options),
    getSessionRuntimeStatuses: (
      sessionIds: string[],
      options?: { includeSubagents?: boolean; forceRefresh?: boolean; fullScan?: boolean },
    ) => ipcRenderer.invoke('cowork:sessions:runtimeStatus', sessionIds, options),
    beginSessionRun: (input: {
      sessionId: string;
      clientTurnId: string;
      startedAt: number;
      modelRef?: string;
    }) => ipcRenderer.invoke('cowork:session:run:begin', input),
    bindSessionRun: (input: { id: string; rootRunId: string }) =>
      ipcRenderer.invoke('cowork:session:run:bind', input),
    listSessionRuns: (sessionId: string) =>
      ipcRenderer.invoke('cowork:session:run:list', sessionId),
    failSessionRun: (input: { sessionId: string; id: string; endedAt: number }) =>
      ipcRenderer.invoke('cowork:session:run:fail', input),
    patchSessionModel: (options: { sessionId: string; model: string; agentId?: string }) =>
      ipcRenderer.invoke('cowork:session:patchModel', options),
    getSessionModel: (options: { sessionId: string; agentId?: string }) =>
      ipcRenderer.invoke('cowork:session:model', options),
    listSessions: (agentId?: string) => ipcRenderer.invoke('cowork:session:list', agentId),
    getSessionGoal: (sessionId: string) => ipcRenderer.invoke('cowork:session:goal', sessionId),
    getGoalExecution: (sessionId: string) => ipcRenderer.invoke(GoalExecutionIpc.Get, sessionId),
    continueGoal: (sessionId: string) => ipcRenderer.invoke(GoalExecutionIpc.Continue, sessionId),
    resumeGoalForUserInput: (sessionId: string) =>
      ipcRenderer.invoke(GoalExecutionIpc.ResumeForUserInput, sessionId),
    restartCompletedGoalForFeedback: (sessionId: string, goalId: string, objective?: string) =>
      ipcRenderer.invoke(GoalExecutionIpc.RestartCompletedForFeedback, {
        sessionId,
        goalId,
        objective,
      }),
    // Extension interaction handling
    respondToInteraction: (options: { requestId: string; result: unknown }) =>
      ipcRenderer.invoke(CoworkInteractionIpc.Respond, options),
    replayPendingInteractions: () => ipcRenderer.invoke(CoworkInteractionIpc.Replay),

    // Configuration
    getConfig: () => ipcRenderer.invoke('cowork:config:get'),
    setConfig: (config: {
      workingDirectory?: string;
      executionMode?: 'auto' | 'local' | 'sandbox';
      agentEngine?: 'openclaw';
      permissionMode?: 'ask' | 'auto' | 'full';
      maxGoalContinuationTurns?: number;
    }) => ipcRenderer.invoke('cowork:config:set', config),
    getAgentRuntimeSettings: () => ipcRenderer.invoke(AgentRuntimeSettingsIpc.Get),
    setAgentRuntimeSettings: (settings: AgentRuntimeSettings) =>
      ipcRenderer.invoke(AgentRuntimeSettingsIpc.Set, settings),
    setDefaultModel: (options: {
      modelId: string;
      providerKey?: string;
      modelRef?: string;
      agentId?: string;
    }) => ipcRenderer.invoke('config:setDefaultModel', options),
    // Stream event listeners
    onSessionActivity: (
      callback: (data: { sessionId: string; kind: 'user' | 'other'; timestamp: number }) => void,
    ) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        data: { sessionId: string; kind: 'user' | 'other'; timestamp: number },
      ) => callback(data);
      ipcRenderer.on('cowork:session:activity', handler);
      return () => ipcRenderer.removeListener('cowork:session:activity', handler);
    },
    onStreamInteraction: (callback: (data: { sessionId: string; request: unknown }) => void) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        data: { sessionId: string; request: unknown },
      ) => callback(data);
      ipcRenderer.on(CoworkInteractionIpc.Stream, handler);
      return () => ipcRenderer.removeListener(CoworkInteractionIpc.Stream, handler);
    },
    onStreamInteractionDismiss: (callback: (data: { requestId: string }) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: { requestId: string }) =>
        callback(data);
      ipcRenderer.on(CoworkInteractionIpc.Dismiss, handler);
      return () => ipcRenderer.removeListener(CoworkInteractionIpc.Dismiss, handler);
    },
    onStreamComplete: (
      callback: (data: {
        sessionId: string;
        finalStatus?: 'idle' | 'running' | 'completed' | 'error';
      }) => void,
    ) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        data: {
          sessionId: string;
          finalStatus?: 'idle' | 'running' | 'completed' | 'error';
        },
      ) => callback(data);
      ipcRenderer.on('cowork:stream:complete', handler);
      return () => ipcRenderer.removeListener('cowork:stream:complete', handler);
    },
    onStreamError: (callback: (data: { sessionId: string; error: string }) => void) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        data: { sessionId: string; error: string },
      ) => callback(data);
      ipcRenderer.on('cowork:stream:error', handler);
      return () => ipcRenderer.removeListener('cowork:stream:error', handler);
    },
    onSessionsChanged: (callback: () => void) => {
      const handler = () => callback();
      ipcRenderer.on('cowork:sessions:changed', handler);
      return () => ipcRenderer.removeListener('cowork:sessions:changed', handler);
    },
    onGoalExecutionChanged: (callback: (snapshot: GoalExecutionSnapshot) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, snapshot: GoalExecutionSnapshot) =>
        callback(snapshot);
      ipcRenderer.on(GoalExecutionIpc.Changed, handler);
      return () => ipcRenderer.removeListener(GoalExecutionIpc.Changed, handler);
    },
    onSessionGoalChanged: (callback: (data: { sessionId: string }) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: { sessionId: string }) =>
        callback(data);
      ipcRenderer.on(SessionGoalIpc.Changed, handler);
      return () => ipcRenderer.removeListener(SessionGoalIpc.Changed, handler);
    },
    getSubTaskStatus: (sessionId?: string) =>
      ipcRenderer.invoke('cowork:subTask:status', sessionId),
    getSubTaskDetails: (sessionKey: string) =>
      ipcRenderer.invoke(CoworkSubagentDetailsIpc.Get, sessionKey),
    listSubTaskDescendants: (sessionId: string) =>
      ipcRenderer.invoke(CoworkSubagentDetailsIpc.ListDescendants, sessionId),
  },
  sessionGroup: {
    list: () => ipcRenderer.invoke('sessionGroup:list'),
    create: (input: { name: string; color?: string }) =>
      ipcRenderer.invoke('sessionGroup:create', input),
    update: (id: string, input: { name?: string; color?: string; sortOrder?: number }) =>
      ipcRenderer.invoke('sessionGroup:update', id, input),
    delete: (id: string) => ipcRenderer.invoke('sessionGroup:delete', id),
    moveSession: (sessionId: string, groupId: string | null) =>
      ipcRenderer.invoke('sessionGroup:moveSession', sessionId, groupId),
    reorder: (groupIds: string[]) => ipcRenderer.invoke('sessionGroup:reorder', groupIds),
  },
  dialog: {
    saveTextFile: (options: SaveTextFileOptions) =>
      ipcRenderer.invoke(DialogIpc.SaveTextFile, options),
    selectDirectory: () => ipcRenderer.invoke('dialog:selectDirectory'),
    selectFile: (options?: {
      title?: string;
      filters?: { name: string; extensions: string[] }[];
    }) => ipcRenderer.invoke('dialog:selectFile', options),
    selectFiles: (options?: {
      title?: string;
      filters?: { name: string; extensions: string[] }[];
    }) => ipcRenderer.invoke('dialog:selectFiles', options),
    selectFolders: (options?: { title?: string }) =>
      ipcRenderer.invoke('dialog:selectFolders', options),
    saveInlineFile: (options: {
      dataBase64: string;
      fileName?: string;
      mimeType?: string;
      cwd?: string;
    }) => ipcRenderer.invoke('dialog:saveInlineFile', options),
    readFileAsDataUrl: (filePath: string) =>
      ipcRenderer.invoke('dialog:readFileAsDataUrl', filePath),
  },
  shell: {
    showAttachmentContextMenu: () => ipcRenderer.invoke('shell:showAttachmentContextMenu'),
    showImageContextMenu: (imageUrl: string) =>
      ipcRenderer.invoke('shell:showImageContextMenu', imageUrl),
    openPath: (filePath: string, workingDirectory?: string) =>
      ipcRenderer.invoke('shell:openPath', filePath, workingDirectory),
    readPreviewFile: (filePath: string, workingDirectory?: string) =>
      ipcRenderer.invoke(FilePreviewIpc.Read, filePath, workingDirectory),
    authorizePreviewFileEdit: (
      request: FilePreviewEditAuthorizationRequest,
    ): Promise<FilePreviewEditAuthorizationResult> =>
      ipcRenderer.invoke(FilePreviewIpc.AuthorizeEdit, request),
    revokePreviewFileEdit: (editToken: string): Promise<void> =>
      ipcRenderer.invoke(FilePreviewIpc.RevokeEdit, editToken),
    writePreviewFile: (request: FilePreviewWriteRequest): Promise<FilePreviewWriteResult> =>
      ipcRenderer.invoke(FilePreviewIpc.Write, request),
    showItemInFolder: (filePath: string, workingDirectory?: string) =>
      ipcRenderer.invoke('shell:showItemInFolder', filePath, workingDirectory),
    openExternal: (url: string) => ipcRenderer.invoke('shell:openExternal', url),
  },
  imagePreview: {
    open: (request: ImagePreviewOpenRequest): Promise<ImagePreviewOpenResult> =>
      ipcRenderer.invoke(ImagePreviewIpc.Open, request),
  },
  autoLaunch: {
    get: () => ipcRenderer.invoke('app:getAutoLaunch'),
    set: (enabled: boolean) => ipcRenderer.invoke('app:setAutoLaunch', enabled),
  },
  preventSleep: {
    get: () => ipcRenderer.invoke('app:getPreventSleep'),
    set: (enabled: boolean) => ipcRenderer.invoke('app:setPreventSleep', enabled),
  },
  developerConfig: {
    get: () => ipcRenderer.invoke(DeveloperConfigIpc.Get),
  },
  appInfo: {
    getVersion: () => ipcRenderer.invoke('app:getVersion'),
    getOpenclawVersion: () => ipcRenderer.invoke('app:getOpenclawVersion'),
    getSystemLocale: () => ipcRenderer.invoke('app:getSystemLocale'),
  },
  appUpdate: {
    getState: (): Promise<AppUpdateState> => ipcRenderer.invoke(AppUpdateIpc.GetState),
    check: (): Promise<AppUpdateState> => ipcRenderer.invoke(AppUpdateIpc.Check),
    download: () => ipcRenderer.invoke(AppUpdateIpc.Download),
    quitAndInstall: () => ipcRenderer.invoke(AppUpdateIpc.QuitAndInstall),
    getPreferences: (): Promise<AppUpdatePreferences> =>
      ipcRenderer.invoke(AppUpdateIpc.GetPreferences),
    setCheckFrequency: (frequency: AppUpdateCheckFrequency): Promise<AppUpdatePreferences> =>
      ipcRenderer.invoke(AppUpdateIpc.SetCheckFrequency, frequency),
    getReleaseHistory: (): Promise<AppReleaseHistoryResult> =>
      ipcRenderer.invoke(AppUpdateIpc.GetReleaseHistory),
    onStateChanged: (callback: (state: AppUpdateState) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, state: AppUpdateState) => callback(state);
      ipcRenderer.on(AppUpdateIpc.StateChanged, handler);
      return () => ipcRenderer.removeListener(AppUpdateIpc.StateChanged, handler);
    },
  },
  builtinModels: {
    refresh: () => ipcRenderer.invoke('builtinModels:refresh'),
  },
  log: {
    getPath: () => ipcRenderer.invoke('log:getPath'),
    openFolder: () => ipcRenderer.invoke('log:openFolder'),
    exportZip: () => ipcRenderer.invoke('log:exportZip'),
    debug: (message: string, details?: Record<string, unknown>) =>
      ipcRenderer.send(LogIpc.WriteDebug, message, details),
  },
  scheduledTasks: {
    // Task CRUD
    list: () => ipcRenderer.invoke(ScheduledTaskIpc.List),
    get: (id: string) => ipcRenderer.invoke(ScheduledTaskIpc.Get, id),
    create: (input: ScheduledTaskInput) => ipcRenderer.invoke(ScheduledTaskIpc.Create, input),
    update: (id: string, input: Partial<ScheduledTaskInput>) =>
      ipcRenderer.invoke(ScheduledTaskIpc.Update, id, input),
    delete: (id: string) => ipcRenderer.invoke(ScheduledTaskIpc.Delete, id),
    toggle: (id: string, enabled: boolean) =>
      ipcRenderer.invoke(ScheduledTaskIpc.Toggle, id, enabled),

    // Execution
    runManually: (id: string) => ipcRenderer.invoke(ScheduledTaskIpc.RunManually, id),

    // Run history
    listRuns: (taskId: string, limit?: number, offset?: number) =>
      ipcRenderer.invoke(ScheduledTaskIpc.ListRuns, taskId, limit, offset),
    resolveSession: (
      sessionKey: string,
      context?: import('../shared/scheduledTask/types').ScheduledTaskSessionResolveContext,
    ) => ipcRenderer.invoke(ScheduledTaskIpc.ResolveSession, sessionKey, context),

    // Delivery channels
    listChannels: () => ipcRenderer.invoke(ScheduledTaskIpc.ListChannels),

    onStatusUpdate: (callback: (data: ScheduledTaskStatusEvent) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: ScheduledTaskStatusEvent) =>
        callback(data);
      ipcRenderer.on(ScheduledTaskIpc.StatusUpdate, handler);
      return () => ipcRenderer.removeListener(ScheduledTaskIpc.StatusUpdate, handler);
    },
    onRunUpdate: (callback: (data: ScheduledTaskRunEvent) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: ScheduledTaskRunEvent) =>
        callback(data);
      ipcRenderer.on(ScheduledTaskIpc.RunUpdate, handler);
      return () => ipcRenderer.removeListener(ScheduledTaskIpc.RunUpdate, handler);
    },
    listResults: (query?: ScheduledTaskResultQuery) =>
      ipcRenderer.invoke(ScheduledTaskIpc.ListResults, query),
    markResultRead: (runId: string) => ipcRenderer.invoke(ScheduledTaskIpc.MarkResultRead, runId),
    markAllResultsRead: (taskId?: string) =>
      ipcRenderer.invoke(ScheduledTaskIpc.MarkAllResultsRead, taskId),
    deleteResult: (runId: string) => ipcRenderer.invoke(ScheduledTaskIpc.DeleteResult, runId),
    reconcileResults: () => ipcRenderer.invoke(ScheduledTaskIpc.ReconcileResults),
    onResultUpserted: (callback: (data: ScheduledTaskResultUpsertedEvent) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: ScheduledTaskResultUpsertedEvent) =>
        callback(data);
      ipcRenderer.on(ScheduledTaskIpc.ResultUpserted, handler);
      return () => ipcRenderer.removeListener(ScheduledTaskIpc.ResultUpserted, handler);
    },
    onUnreadCountChanged: (callback: (data: ScheduledTaskUnreadCountEvent) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: ScheduledTaskUnreadCountEvent) =>
        callback(data);
      ipcRenderer.on(ScheduledTaskIpc.UnreadCountChanged, handler);
      return () => ipcRenderer.removeListener(ScheduledTaskIpc.UnreadCountChanged, handler);
    },
    onRefresh: (callback: () => void) => {
      const handler = () => callback();
      ipcRenderer.on(ScheduledTaskIpc.Refresh, handler);
      return () => ipcRenderer.removeListener(ScheduledTaskIpc.Refresh, handler);
    },
  },
  networkStatus: {
    send: (status: 'online' | 'offline') => ipcRenderer.send('network:status-change', status),
  },
});
