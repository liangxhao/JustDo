import { contextBridge, ipcRenderer } from 'electron';

import {
  type AgentFileName,
  type AgentFileSnapshot,
  AgentIpc,
  type AgentProfileInput,
} from '../shared/agents/agents';
import {
  type AppReleaseHistoryResult,
  type AppUpdateCheckFrequency,
  AppUpdateIpc,
  type AppUpdatePreferences,
  type AppUpdateState,
} from '../shared/app/appUpdate';
import { DialogIpc, type SaveTextFileOptions } from '../shared/app/dialogIpc';
import { LogIpc } from '../shared/app/logIpc';
import { MediaCaptureIpc } from '../shared/app/mediaCapture';
import {
  type TerminalActionResult,
  type TerminalCreateRequest,
  type TerminalCreateResult,
  type TerminalDataEvent,
  type TerminalExitEvent,
  TerminalIpc,
  type TerminalResizeRequest,
  type TerminalWriteRequest,
} from '../shared/app/terminal';
import {
  type BrowserActionResult,
  type BrowserAgentInteractionReady,
  type BrowserAgentInteractionState,
  type BrowserAgentSessionEvent,
  type BrowserAgentTabReference,
  type BrowserAgentTabRegistration,
  type BrowserClearDataRange,
  type BrowserClearDataRequest,
  type BrowserClearDataResult,
  type BrowserClearDataSummaryResult,
  type BrowserConnectionTestResult,
  type BrowserDownloadListResult,
  type BrowserHistoryListResult,
  type BrowserImportRequest,
  type BrowserImportResult,
  type BrowserImportSourcesResult,
  BrowserIpc,
  type BrowserLocalHtmlPreviewResult,
  type BrowserMode,
  type BrowserModeSwitchAvailabilityResult,
  type BrowserModeUpdateResult,
  type BrowserPanelHttpAuthDismissed,
  type BrowserPanelHttpAuthRequest,
  type BrowserPanelHttpAuthResponse,
  type BrowserPanelOpenTabEvent,
  type BrowserPanelPdfDetectedEvent,
  type BrowserPanelShortcutAction,
  type BrowserPanelShortcutSettings,
  type BrowserPdfLoadRequest,
  type BrowserPdfLoadResult,
  type BrowserStatusResult,
  normalizeBrowserPanelHttpAuthRequest,
  normalizeBrowserPanelHttpAuthResponse,
  normalizeBrowserPanelOpenTabEvent,
  normalizeBrowserPanelPdfDetectedEvent,
} from '../shared/browser/browser';
import { BrowserInterventionIpc, type BrowserInterventionRequest } from '../shared/browser/browserIntervention';
import { BrowserRecordingChannel, type BrowserRecordingLease } from '../shared/browser/browserRecording';
import type { CoworkAttachmentPayload } from '../shared/cowork/attachments';
import { CollaborationIpc } from '../shared/cowork/collaboration';
import { type CopyCoworkSessionInput, CoworkSessionCopyIpc } from '../shared/cowork/sessionCopy';
import { CoworkSessionDetailsIpc } from '../shared/cowork/sessionDetails';
import { CoworkSessionForkIpc, type ForkCoworkSessionInput } from '../shared/cowork/sessionFork';
import {
  GoalExecutionIpc,
  type GoalExecutionSnapshot,
  SessionGoalIpc,
  type SessionGoalMutationRequest,
} from '../shared/cowork/sessionGoal';
import { SessionRunIpc, type SessionRunUnknownInput } from '../shared/cowork/sessionRun';
import { CoworkSessionSearchIpc } from '../shared/cowork/sessionSearch';
import { type CancelSessionStartInput, SessionStartIpc } from '../shared/cowork/sessionStart';
import { type GenerateSessionTitleRequest, SessionTitleIpc } from '../shared/cowork/sessionTitle';
import { SlashCommandIpc } from '../shared/cowork/slashCommands';
import {
  CoworkSubagentDetailsIpc,
  type CoworkSubtaskChangedEvent,
} from '../shared/cowork/subagentDetails';
import {
  MulticaIntegrationIpc,
  type MulticaIntegrationResult,
  type MulticaIntegrationStatus,
} from '../shared/integrations/multica';
import { type ApiFetchOptions, NetworkIpc } from '../shared/network/network';
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
  OpenClawAssistantMediaIpc,
  type OpenClawAssistantMediaRequest,
} from '../shared/openclaw/assistantMedia';
import {
  CoworkInteractionIpc,
  type ExtensionChangedEvent,
  type ExtensionDeleteRequest,
  type ExtensionImportProgress,
  type ExtensionImportRequest,
  ExtensionIpc,
  type ExtensionSetEnabledRequest,
  type ExtensionUpdateConfigurationRequest,
} from '../shared/openclaw/extensions';
import {
  type ExternalAgentId,
  ExternalAgentIpc,
  type ExternalAgentSettings,
  type ExternalAgentTestResult,
} from '../shared/openclaw/externalAgents';
import { OpenClawHistoryIpc } from '../shared/openclaw/historyIpc';
import { HookIpc } from '../shared/openclaw/hooks';
import { MemoryIpc } from '../shared/openclaw/memory';
import { OpenClawModelsIpc } from '../shared/openclaw/models';
import {
  type OpenClawSessionMigrationConfirmRequest,
  OpenClawSessionMigrationIpc,
  type OpenClawSessionMigrationProgress,
} from '../shared/openclaw/sessionMigration';
import {
  SystemPromptReplacementIpc,
  type SystemPromptReplacementRule,
} from '../shared/openclaw/systemPromptReplacements';
import { UsageStatsIpc, type UsageStatsOptions } from '../shared/openclaw/usage';
import {
  type WorkboardCardInput,
  type WorkboardCardPatch,
  type WorkboardChangedEvent,
  WorkboardIpc,
  type WorkboardStopIdentity,
} from '../shared/openclaw/workboard';
import {
  type MarketplaceCategoryRequest,
  type MarketplaceDetailRequest,
  type MarketplaceInstallRequest,
  MarketplaceIpc,
  type MarketplacePluginKind,
  type MarketplaceQuery,
  type MarketplaceUpdateCheckRequest,
} from '../shared/plugins/marketplace';
import type { OpenClawSkillSource } from '../shared/plugins/skills';
import { type SkillWorkshopDecision, SkillWorkshopIpc } from '../shared/plugins/skillWorkshop';
import {
  type FilePreviewEditAuthorizationRequest,
  type FilePreviewEditAuthorizationResult,
  FilePreviewIpc,
  type FilePreviewWriteRequest,
  type FilePreviewWriteResult,
} from '../shared/preview/filePreview';
import {
  ImagePreviewIpc,
  type ImagePreviewOpenRequest,
  type ImagePreviewOpenResult,
} from '../shared/preview/imagePreview';
import {
  type MediaGenerationModelConfiguration,
  type MediaGenerationModelKind,
  MediaGenerationModelsIpc,
} from '../shared/providers/mediaGenerationModels';
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
  WindowsSandboxIpc,
  type WindowsSandboxOperationResult,
  type WindowsSandboxStatus,
} from '../shared/security/windowsSandbox';
import {
  LocalAsrIpc,
  type LocalAsrModelId,
  type LocalAsrTranscribeOptions,
} from '../shared/speech/localAsr';
import {
  LocalSpeechModelIpc,
  type LocalSpeechModelKind,
  type LocalSpeechModelStatus,
} from '../shared/speech/localSpeechModels';
import { LocalTtsIpc, type LocalTtsModelId } from '../shared/speech/localTts';
import {
  type OnlineAsrConfigurationUpdate,
  type OnlineAsrEvent,
  OnlineAsrIpc,
  type OnlineAsrStartOptions,
} from '../shared/speech/onlineAsr';
import { type OnlineTtsConfigurationUpdate, OnlineTtsIpc } from '../shared/speech/onlineTts';
import { SpeechSynthesisIpc } from '../shared/speech/speechSynthesis';

// 暴露安全的 API 到渲染进程
contextBridge.exposeInMainWorld('electron', {
  platform: process.platform,
  arch: process.arch,
  multica: {
    getStatus: (): Promise<MulticaIntegrationStatus> =>
      ipcRenderer.invoke(MulticaIntegrationIpc.GetStatus),
    enable: (): Promise<MulticaIntegrationResult> =>
      ipcRenderer.invoke(MulticaIntegrationIpc.Enable),
    disable: (): Promise<MulticaIntegrationResult> =>
      ipcRenderer.invoke(MulticaIntegrationIpc.Disable),
    refresh: (): Promise<MulticaIntegrationResult> =>
      ipcRenderer.invoke(MulticaIntegrationIpc.Refresh),
  },
  store: {
    get: (key: string) => ipcRenderer.invoke('store:get', key),
    set: (key: string, value: unknown) => ipcRenderer.invoke('store:set', key, value),
    remove: (key: string) => ipcRenderer.invoke('store:remove', key),
  },
  marketplace: {
    listSources: (kind?: MarketplacePluginKind) =>
      ipcRenderer.invoke(MarketplaceIpc.ListSources, kind),
    listCategories: (request: MarketplaceCategoryRequest) =>
      ipcRenderer.invoke(MarketplaceIpc.ListCategories, request),
    search: (query: MarketplaceQuery) => ipcRenderer.invoke(MarketplaceIpc.Search, query),
    checkUpdates: (request: MarketplaceUpdateCheckRequest) =>
      ipcRenderer.invoke(MarketplaceIpc.CheckUpdates, request),
    detail: (request: MarketplaceDetailRequest) =>
      ipcRenderer.invoke(MarketplaceIpc.Detail, request),
    install: (request: MarketplaceInstallRequest) =>
      ipcRenderer.invoke(MarketplaceIpc.Install, request),
  },
  skillWorkshop: {
    list: (agentId: string) => ipcRenderer.invoke(SkillWorkshopIpc.List, agentId),
    inspect: (agentId: string, proposalId: string) =>
      ipcRenderer.invoke(SkillWorkshopIpc.Inspect, agentId, proposalId),
    decide: (input: SkillWorkshopDecision) => ipcRenderer.invoke(SkillWorkshopIpc.Decide, input),
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
    onChanged: (callback: (event: ExtensionChangedEvent) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: ExtensionChangedEvent) =>
        callback(data);
      ipcRenderer.on(ExtensionIpc.Changed, handler);
      return () => ipcRenderer.removeListener(ExtensionIpc.Changed, handler);
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
    createLocalHtmlPreview: (
      filePath: string,
      workingDirectory?: string,
    ): Promise<BrowserLocalHtmlPreviewResult> =>
      ipcRenderer.invoke(BrowserIpc.CreateLocalHtmlPreview, filePath, workingDirectory),
    loadPdf: (request: BrowserPdfLoadRequest): Promise<BrowserPdfLoadResult> =>
      ipcRenderer.invoke(BrowserIpc.LoadPdf, request),
    cancelPdf: (requestId: string) => ipcRenderer.send(BrowserIpc.CancelPdf, requestId),
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
    onPanelOpenTab: (callback: (event: BrowserPanelOpenTabEvent) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: unknown) => {
        const normalized = normalizeBrowserPanelOpenTabEvent(data);
        if (normalized) callback(normalized);
      };
      ipcRenderer.on(BrowserIpc.PanelOpenTab, handler);
      return () => ipcRenderer.removeListener(BrowserIpc.PanelOpenTab, handler);
    },
    onPanelHttpAuthRequest: (callback: (request: BrowserPanelHttpAuthRequest) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: unknown) => {
        const normalized = normalizeBrowserPanelHttpAuthRequest(data);
        if (normalized) callback(normalized);
      };
      ipcRenderer.on(BrowserIpc.PanelHttpAuthRequest, handler);
      return () => ipcRenderer.removeListener(BrowserIpc.PanelHttpAuthRequest, handler);
    },
    respondToPanelHttpAuth: (response: BrowserPanelHttpAuthResponse) =>
      ipcRenderer.send(BrowserIpc.PanelHttpAuthResponse, response),
    onPanelHttpAuthDismissed: (callback: (event: BrowserPanelHttpAuthDismissed) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: unknown) => {
        const normalized = normalizeBrowserPanelHttpAuthResponse(data);
        if (normalized) callback({ id: normalized.id, guestId: normalized.guestId });
      };
      ipcRenderer.on(BrowserIpc.PanelHttpAuthDismissed, handler);
      return () => ipcRenderer.removeListener(BrowserIpc.PanelHttpAuthDismissed, handler);
    },
    onPanelPdfDetected: (callback: (event: BrowserPanelPdfDetectedEvent) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: unknown) => {
        const normalized = normalizeBrowserPanelPdfDetectedEvent(data);
        if (normalized) callback(normalized);
      };
      ipcRenderer.on(BrowserIpc.PanelPdfDetected, handler);
      return () => ipcRenderer.removeListener(BrowserIpc.PanelPdfDetected, handler);
    },
    setPanelShortcuts: (shortcuts: BrowserPanelShortcutSettings) =>
      ipcRenderer.send(BrowserIpc.PanelSetShortcuts, shortcuts),
    onPanelShortcutAction: (callback: (action: BrowserPanelShortcutAction) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, action: unknown) => {
        if (action === 'terminal' || action === 'browser') callback(action);
      };
      ipcRenderer.on(BrowserIpc.PanelShortcutAction, handler);
      return () => ipcRenderer.removeListener(BrowserIpc.PanelShortcutAction, handler);
    },
    registerAgentTab: (registration: BrowserAgentTabRegistration) =>
      ipcRenderer.send(BrowserIpc.AgentRegisterTab, registration),
    unregisterAgentTab: (reference: BrowserAgentTabReference) =>
      ipcRenderer.send(BrowserIpc.AgentUnregisterTab, reference),
    setAgentActiveTab: (reference: BrowserAgentTabReference) =>
      ipcRenderer.send(BrowserIpc.AgentSetActiveTab, reference),
    setUserInteractionState: (state: BrowserAgentInteractionState) =>
      ipcRenderer.send(BrowserIpc.UserInteractionState, state),
    setRecordingLease: (state: BrowserRecordingLease): Promise<boolean> =>
      ipcRenderer.invoke(BrowserRecordingChannel.Lease, state),
    acknowledgeAgentInteraction: (state: BrowserAgentInteractionReady) =>
      ipcRenderer.send(BrowserIpc.AgentInteractionReady, state),
    intervention: (input: BrowserInterventionRequest) => ipcRenderer.invoke(BrowserInterventionIpc, input),
    onAgentEnsureTab: (callback: (event: BrowserAgentSessionEvent) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: BrowserAgentSessionEvent) =>
        callback(data);
      ipcRenderer.on(BrowserIpc.AgentEnsureTab, handler);
      return () => ipcRenderer.removeListener(BrowserIpc.AgentEnsureTab, handler);
    },
    onAgentFocusTab: (callback: (event: BrowserAgentTabReference) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: BrowserAgentTabReference) =>
        callback(data);
      ipcRenderer.on(BrowserIpc.AgentFocusTab, handler);
      return () => ipcRenderer.removeListener(BrowserIpc.AgentFocusTab, handler);
    },
    onAgentCloseTab: (callback: (event: BrowserAgentTabReference) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: BrowserAgentTabReference) =>
        callback(data);
      ipcRenderer.on(BrowserIpc.AgentCloseTab, handler);
      return () => ipcRenderer.removeListener(BrowserIpc.AgentCloseTab, handler);
    },
    onAgentInteractionState: (callback: (event: BrowserAgentInteractionState) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: BrowserAgentInteractionState) =>
        callback(data);
      ipcRenderer.on(BrowserIpc.AgentInteractionState, handler);
      return () => ipcRenderer.removeListener(BrowserIpc.AgentInteractionState, handler);
    },
    listImportSources: (): Promise<BrowserImportSourcesResult> =>
      ipcRenderer.invoke(BrowserIpc.ListImportSources),
    importData: (request: BrowserImportRequest): Promise<BrowserImportResult> =>
      ipcRenderer.invoke(BrowserIpc.ImportData, request),
    listHistory: (query = ''): Promise<BrowserHistoryListResult> =>
      ipcRenderer.invoke(BrowserIpc.ListHistory, query),
    deleteHistory: (urls: string[]): Promise<BrowserActionResult> =>
      ipcRenderer.invoke(BrowserIpc.DeleteHistory, urls),
    clearHistory: (): Promise<BrowserActionResult> => ipcRenderer.invoke(BrowserIpc.ClearHistory),
    listDownloads: (query = ''): Promise<BrowserDownloadListResult> =>
      ipcRenderer.invoke(BrowserIpc.ListDownloads, query),
    deleteDownloads: (ids: string[]): Promise<BrowserActionResult> =>
      ipcRenderer.invoke(BrowserIpc.DeleteDownloads, ids),
    clearDownloads: (): Promise<BrowserActionResult> =>
      ipcRenderer.invoke(BrowserIpc.ClearDownloads),
    openDownload: (id: string): Promise<BrowserActionResult> =>
      ipcRenderer.invoke(BrowserIpc.OpenDownload, id),
    revealDownload: (id: string): Promise<BrowserActionResult> =>
      ipcRenderer.invoke(BrowserIpc.RevealDownload, id),
    getClearDataSummary: (range: BrowserClearDataRange): Promise<BrowserClearDataSummaryResult> =>
      ipcRenderer.invoke(BrowserIpc.GetClearDataSummary, range),
    clearBrowsingData: (request: BrowserClearDataRequest): Promise<BrowserClearDataResult> =>
      ipcRenderer.invoke(BrowserIpc.ClearBrowsingData, request),
  },
  terminal: {
    create: (request: TerminalCreateRequest): Promise<TerminalCreateResult> =>
      ipcRenderer.invoke(TerminalIpc.Create, request),
    write: (request: TerminalWriteRequest): Promise<TerminalActionResult> =>
      ipcRenderer.invoke(TerminalIpc.Write, request),
    resize: (request: TerminalResizeRequest): Promise<TerminalActionResult> =>
      ipcRenderer.invoke(TerminalIpc.Resize, request),
    close: (id: string): Promise<TerminalActionResult> => ipcRenderer.invoke(TerminalIpc.Close, id),
    onData: (callback: (event: TerminalDataEvent) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: TerminalDataEvent) =>
        callback(data);
      ipcRenderer.on(TerminalIpc.Data, handler);
      return () => ipcRenderer.removeListener(TerminalIpc.Data, handler);
    },
    onExit: (callback: (event: TerminalExitEvent) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: TerminalExitEvent) =>
        callback(data);
      ipcRenderer.on(TerminalIpc.Exit, handler);
      return () => ipcRenderer.removeListener(TerminalIpc.Exit, handler);
    },
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
  saveApiConfig: (config: {
    apiKey: string;
    baseURL: string;
    model: string;
    headers?: Record<string, string>;
    apiType?: 'openai';
  }) => ipcRenderer.invoke('save-api-config', config),
  generateSessionTitle: (request: GenerateSessionTitleRequest) =>
    ipcRenderer.invoke(SessionTitleIpc.Generate, request),
  getRecentCwds: (limit?: number) => ipcRenderer.invoke('get-recent-cwds', limit),
  openclaw: {
    externalAgents: {
      getSettings: () => ipcRenderer.invoke(ExternalAgentIpc.GET_SETTINGS),
      setSettings: (settings: ExternalAgentSettings) =>
        ipcRenderer.invoke(ExternalAgentIpc.SET_SETTINGS, settings),
      test: (agentId: ExternalAgentId): Promise<ExternalAgentTestResult> =>
        ipcRenderer.invoke(ExternalAgentIpc.TEST, agentId),
    },
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
      readAssistantMediaDataUrl: (request: OpenClawAssistantMediaRequest) =>
        ipcRenderer.invoke(OpenClawAssistantMediaIpc.ReadDataUrl, request),
      setPort: (port: number) => ipcRenderer.invoke('openclaw:engine:setPort', port),
      getSystemPromptReplacementRules: () =>
        ipcRenderer.invoke(SystemPromptReplacementIpc.GetRules),
      setSystemPromptReplacementRules: (rules: SystemPromptReplacementRule[]) =>
        ipcRenderer.invoke(SystemPromptReplacementIpc.SetRules, rules),
      openTerminal: (cwd?: string) => ipcRenderer.invoke('openclaw:engine:openTerminal', cwd),
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
    },
    models: {
      list: (options?: { agentId?: string }) => ipcRenderer.invoke(OpenClawModelsIpc.List, options),
    },
    memory: {
      getOverview: () => ipcRenderer.invoke(MemoryIpc.GetOverview),
      getIndexStatus: () => ipcRenderer.invoke(MemoryIpc.GetIndexStatus),
      getDocument: (relativePath: string) =>
        ipcRenderer.invoke(MemoryIpc.GetDocument, relativePath),
      search: (query: string) => ipcRenderer.invoke(MemoryIpc.Search, query),
      rebuildIndex: () => ipcRenderer.invoke(MemoryIpc.RebuildIndex),
    },
    usage: {
      getDaily: (options: UsageStatsOptions) => ipcRenderer.invoke(UsageStatsIpc.GetDaily, options),
    },
  },
  collaboration: {
    read: (sessionId: string) => ipcRenderer.invoke(CollaborationIpc.Read, sessionId),
    readMessages: (sessionId: string, deliveryIds: string[]) =>
      ipcRenderer.invoke(CollaborationIpc.ReadMessages, { sessionId, deliveryIds }),
    list: () => ipcRenderer.invoke(CollaborationIpc.List),
    create: (sessionId: string, agentIds: string[]) =>
      ipcRenderer.invoke(CollaborationIpc.Create, { sessionId, agentIds }),
    stop: (sessionId: string) => ipcRenderer.invoke(CollaborationIpc.Stop, sessionId),
  },
  agents: {
    delete: (agentId: string) => ipcRenderer.invoke(AgentIpc.Delete, agentId),
    save: (input: AgentProfileInput) => ipcRenderer.invoke(AgentIpc.Save, input),
    readFile: (agentId: string, name: AgentFileName) =>
      ipcRenderer.invoke(AgentIpc.ReadFile, { agentId, name }),
    writeFile: (
      agentId: string,
      name: AgentFileName,
      content: string,
      expected: AgentFileSnapshot,
    ) => ipcRenderer.invoke(AgentIpc.WriteFile, { agentId, name, content, expected }),
    list: async () => {
      const result = await ipcRenderer.invoke(AgentIpc.List);
      return result?.success ? result.agents : [];
    },
  },
  cowork: {
    // Session management
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
    }) => ipcRenderer.invoke('cowork:session:start', options),
    cancelSessionStart: (input: CancelSessionStartInput) =>
      ipcRenderer.invoke(SessionStartIpc.Cancel, input),
    stopSession: (sessionId: string) => ipcRenderer.invoke('cowork:session:stop', sessionId),
    deleteSession: (sessionId: string) => ipcRenderer.invoke('cowork:session:delete', sessionId),
    copySession: (input: CopyCoworkSessionInput) =>
      ipcRenderer.invoke(CoworkSessionCopyIpc.Copy, input),
    forkSession: (input: ForkCoworkSessionInput) =>
      ipcRenderer.invoke(CoworkSessionForkIpc.Fork, input),
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
    markSessionRunUnknown: (input: SessionRunUnknownInput) =>
      ipcRenderer.invoke(SessionRunIpc.Unknown, input),
    failSessionRun: (input: { sessionId: string; id: string; endedAt: number }) =>
      ipcRenderer.invoke('cowork:session:run:fail', input),
    patchSessionModel: (options: { sessionId: string; model: string; agentId?: string }) =>
      ipcRenderer.invoke('cowork:session:patchModel', options),
    getSessionModel: (options: { sessionId: string; agentId?: string }) =>
      ipcRenderer.invoke('cowork:session:model', options),
    listSessions: (agentId?: string) => ipcRenderer.invoke('cowork:session:list', agentId),
    searchSessionMessages: (query: string) =>
      ipcRenderer.invoke(CoworkSessionSearchIpc.SearchMessages, query),
    getSessionGoal: (sessionId: string) => ipcRenderer.invoke('cowork:session:goal', sessionId),
    getPlanMode: (sessionId: string) =>
      ipcRenderer.invoke('cowork:session:planMode:get', sessionId),
    setPlanMode: (sessionId: string, enabled: boolean) =>
      ipcRenderer.invoke('cowork:session:planMode:set', { sessionId, enabled }),
    mutateSessionGoal: (sessionId: string, request: SessionGoalMutationRequest) =>
      ipcRenderer.invoke(SessionGoalIpc.Mutate, sessionId, request),
    getGoalExecution: (sessionId: string) => ipcRenderer.invoke(GoalExecutionIpc.Get, sessionId),
    continueGoal: (sessionId: string) => ipcRenderer.invoke(GoalExecutionIpc.Continue, sessionId),
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
      sandboxNetworkEnabled?: boolean;
      agentEngine?: 'openclaw';
      permissionMode?: 'ask' | 'auto' | 'full';
      maxGoalContinuationTurns?: number;
      maxRetainedDisplayTabs?: number;
    }) => ipcRenderer.invoke('cowork:config:set', config),
    getAgentRuntimeSettings: () => ipcRenderer.invoke(AgentRuntimeSettingsIpc.Get),
    setAgentRuntimeSettings: (settings: AgentRuntimeSettings) =>
      ipcRenderer.invoke(AgentRuntimeSettingsIpc.Set, settings),
    getWindowsSandboxStatus: (): Promise<WindowsSandboxStatus> =>
      ipcRenderer.invoke(WindowsSandboxIpc.GetStatus),
    initializeWindowsSandbox: (): Promise<WindowsSandboxOperationResult> =>
      ipcRenderer.invoke(WindowsSandboxIpc.Initialize),
    repairWindowsSandbox: (): Promise<WindowsSandboxOperationResult> =>
      ipcRenderer.invoke(WindowsSandboxIpc.Repair),
    openWindowsSandboxDiagnostics: () => ipcRenderer.invoke(WindowsSandboxIpc.OpenDiagnostics),
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
    getSubTaskStatus: (sessionId?: string, forceRefresh?: boolean) =>
      ipcRenderer.invoke(CoworkSubagentDetailsIpc.Status, sessionId, forceRefresh),
    getSubTaskDetails: (sessionKey: string, taskId?: string) =>
      ipcRenderer.invoke(CoworkSubagentDetailsIpc.Get, sessionKey, taskId),
    listSubTaskDescendants: (sessionId: string) =>
      ipcRenderer.invoke(CoworkSubagentDetailsIpc.ListDescendants, sessionId),
    onSubtasksChanged: (callback: (event: CoworkSubtaskChangedEvent) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, event: CoworkSubtaskChangedEvent) =>
        callback(event);
      ipcRenderer.on(CoworkSubagentDetailsIpc.Changed, handler);
      return () => ipcRenderer.removeListener(CoworkSubagentDetailsIpc.Changed, handler);
    },
  },
  localTts: {
    getStatus: (modelId: LocalTtsModelId) => ipcRenderer.invoke(LocalTtsIpc.GetStatus, modelId),
  },
  localAsr: {
    stageAttachment: (source: string, workspace: string) =>
      ipcRenderer.invoke(LocalAsrIpc.StageAttachment, source, workspace),
    getStatus: (modelId: LocalAsrModelId) => ipcRenderer.invoke(LocalAsrIpc.GetStatus, modelId),
    transcribe: (audio: Uint8Array, options: LocalAsrTranscribeOptions) =>
      ipcRenderer.invoke(LocalAsrIpc.Transcribe, audio, options),
  },
  onlineAsr: {
    getStatus: () => ipcRenderer.invoke(OnlineAsrIpc.GetStatus),
    getConfiguration: () => ipcRenderer.invoke(OnlineAsrIpc.GetConfiguration),
    saveConfiguration: (update: OnlineAsrConfigurationUpdate) =>
      ipcRenderer.invoke(OnlineAsrIpc.SaveConfiguration, update),
    clearConfiguration: () => ipcRenderer.invoke(OnlineAsrIpc.ClearConfiguration),
    start: (options: OnlineAsrStartOptions) => ipcRenderer.invoke(OnlineAsrIpc.Start, options),
    appendAudio: (sessionId: string, audioBase64: string) =>
      ipcRenderer.invoke(OnlineAsrIpc.AppendAudio, sessionId, audioBase64),
    close: (sessionId: string) => ipcRenderer.invoke(OnlineAsrIpc.Close, sessionId),
    onEvent: (callback: (event: OnlineAsrEvent) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, event: OnlineAsrEvent) => callback(event);
      ipcRenderer.on(OnlineAsrIpc.Event, handler);
      return () => ipcRenderer.removeListener(OnlineAsrIpc.Event, handler);
    },
  },
  onlineTts: {
    getStatus: () => ipcRenderer.invoke(OnlineTtsIpc.GetStatus),
    getConfiguration: () => ipcRenderer.invoke(OnlineTtsIpc.GetConfiguration),
    saveConfiguration: (update: OnlineTtsConfigurationUpdate) =>
      ipcRenderer.invoke(OnlineTtsIpc.SaveConfiguration, update),
    clearConfiguration: () => ipcRenderer.invoke(OnlineTtsIpc.ClearConfiguration),
  },
  speechSynthesis: {
    speak: (text: string) => ipcRenderer.invoke(SpeechSynthesisIpc.Speak, text),
  },
  mediaGenerationModels: {
    getConfiguration: (kind: MediaGenerationModelKind) =>
      ipcRenderer.invoke(MediaGenerationModelsIpc.GetConfiguration, kind),
    saveConfiguration: (
      kind: MediaGenerationModelKind,
      configuration: MediaGenerationModelConfiguration,
    ) => ipcRenderer.invoke(MediaGenerationModelsIpc.SaveConfiguration, kind, configuration),
  },
  mediaCapture: {
    armSystemAudio: () => ipcRenderer.invoke(MediaCaptureIpc.ArmSystemAudio),
  },
  localSpeechModels: {
    list: () => ipcRenderer.invoke(LocalSpeechModelIpc.List),
    install: (kind: LocalSpeechModelKind, id: string) =>
      ipcRenderer.invoke(LocalSpeechModelIpc.Install, kind, id),
    remove: (kind: LocalSpeechModelKind, id: string) =>
      ipcRenderer.invoke(LocalSpeechModelIpc.Remove, kind, id),
    onChanged: (callback: (status: LocalSpeechModelStatus) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, status: LocalSpeechModelStatus) =>
        callback(status);
      ipcRenderer.on(LocalSpeechModelIpc.Changed, handler);
      return () => ipcRenderer.removeListener(LocalSpeechModelIpc.Changed, handler);
    },
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
    openPathWith: (filePath: string) => ipcRenderer.invoke(FilePreviewIpc.OpenWith, filePath),
    listWorkspaceDirectory: (sessionId: string, relativeDirectory?: string) =>
      ipcRenderer.invoke(FilePreviewIpc.ListDirectory, sessionId, relativeDirectory),
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
    openLocalHtmlExternal: (previewUrl: string) =>
      ipcRenderer.invoke('shell:openLocalHtmlExternal', previewUrl),
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
    getSchedulerSettings: () => ipcRenderer.invoke(ScheduledTaskIpc.GetSchedulerSettings),
    updateSchedulerSettings: (input: import('../shared/scheduledTask/types').SchedulerSettingsUpdate) =>
      ipcRenderer.invoke(ScheduledTaskIpc.UpdateSchedulerSettings, input),
    getSystemSettings: () => ipcRenderer.invoke(ScheduledTaskIpc.GetSystemSettings),
    updateSystemSettings: (
      input: import('../shared/scheduledTask/types').SystemTaskSettingsPatch,
    ) => ipcRenderer.invoke(ScheduledTaskIpc.UpdateSystemSettings, input),
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
    runManually: (id: string, expectedConfigRevision?: string) =>
      ipcRenderer.invoke(ScheduledTaskIpc.RunManually, id, expectedConfigRevision),

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
  workboard: {
    getSnapshot: () => ipcRenderer.invoke(WorkboardIpc.GetSnapshot),
    createCard: (input: WorkboardCardInput) => ipcRenderer.invoke(WorkboardIpc.CreateCard, input),
    updateCard: (id: string, patch: WorkboardCardPatch, expectedUpdatedAt: number) =>
      ipcRenderer.invoke(WorkboardIpc.UpdateCard, id, patch, expectedUpdatedAt),
    moveCard: (id: string, status: WorkboardCardInput['status'], position: number) =>
      ipcRenderer.invoke(WorkboardIpc.MoveCard, id, status, position),
    deleteCard: (id: string) => ipcRenderer.invoke(WorkboardIpc.DeleteCard, id),
    archiveCard: (id: string, archived: boolean) =>
      ipcRenderer.invoke(WorkboardIpc.ArchiveCard, id, archived),
    commentCard: (id: string, body: string) =>
      ipcRenderer.invoke(WorkboardIpc.CommentCard, id, body),
    startCard: (id: string) => ipcRenderer.invoke(WorkboardIpc.StartCard, id),
    stopCard: (id: string, expectedExecution?: WorkboardStopIdentity) =>
      ipcRenderer.invoke(WorkboardIpc.StopCard, id, expectedExecution),
    resolveSession: (sessionKey: string) =>
      ipcRenderer.invoke(WorkboardIpc.ResolveSession, sessionKey),
    dispatch: (boardId?: string) => ipcRenderer.invoke(WorkboardIpc.Dispatch, boardId),
    onChanged: (callback: (event: WorkboardChangedEvent) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: WorkboardChangedEvent) =>
        callback(data);
      ipcRenderer.on(WorkboardIpc.Changed, handler);
      return () => ipcRenderer.removeListener(WorkboardIpc.Changed, handler);
    },
  },
  networkStatus: {
    send: (status: 'online' | 'offline') => ipcRenderer.send('network:status-change', status),
  },
});
