import { contextBridge, ipcRenderer } from 'electron';

import type { CoworkAttachmentPayload } from '../shared/cowork/attachments';
import { LogIpc } from '../shared/logIpc';
import { OpenClawHistoryIpc } from '../shared/openclaw/historyIpc';
import { UsageStatsIpc } from '../shared/openclaw/usage';
import { IpcChannel as ScheduledTaskIpc } from '../shared/scheduledTask/constants';
import { SlashCommandIpc } from '../shared/slashCommands';

// 暴露安全的 API 到渲染进程
contextBridge.exposeInMainWorld('electron', {
  platform: process.platform,
  arch: process.arch,
  store: {
    get: (key: string) => ipcRenderer.invoke('store:get', key),
    set: (key: string, value: any) => ipcRenderer.invoke('store:set', key, value),
    remove: (key: string) => ipcRenderer.invoke('store:remove', key),
  },
  skills: {
    list: () => ipcRenderer.invoke('skills:list'),
    setEnabled: (options: { id: string; enabled: boolean }) =>
      ipcRenderer.invoke('skills:setEnabled', options),
    // Marketplace-based skill management
    install: (params: { id: string; version?: string; force?: boolean }) =>
      ipcRenderer.invoke('skills:install', params),
    // Offline import from local folder
    importFolder: (folderPath: string) => ipcRenderer.invoke('skills:importFolder', folderPath),
    search: (options?: { query?: string; limit?: number }) =>
      ipcRenderer.invoke('skills:search', options || {}),
    detail: (options: { id: string }) => ipcRenderer.invoke('skills:detail', options),
    delete: (id: string) => ipcRenderer.invoke('skills:delete', id),
  },
  hooks: {
    list: () => ipcRenderer.invoke('hooks:list'),
    setEnabled: (options: { id: string; enabled: boolean }) =>
      ipcRenderer.invoke('hooks:setEnabled', options),
  },
  slashCommands: {
    list: (options?: { agentId?: string | null }) =>
      ipcRenderer.invoke(SlashCommandIpc.List, options || {}),
  },
  mcp: {
    list: () => ipcRenderer.invoke('mcp:list'),
    create: (data: any) => ipcRenderer.invoke('mcp:create', data),
    update: (id: string, data: any) => ipcRenderer.invoke('mcp:update', id, data),
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
      const handler = (_event: any, data: { tools: number; error?: string }) => callback(data);
      ipcRenderer.on('mcp:config:syncDone', handler);
      return () => ipcRenderer.removeListener('mcp:config:syncDone', handler);
    },
  },
  permissions: {
    checkCalendar: () => ipcRenderer.invoke('permissions:checkCalendar'),
    requestCalendar: () => ipcRenderer.invoke('permissions:requestCalendar'),
  },
  api: {
    // 普通 API 请求（非流式）
    fetch: (options: {
      url: string;
      method: string;
      headers: Record<string, string>;
      body?: string;
    }) => ipcRenderer.invoke('api:fetch', options),
  },
  ipcRenderer: {
    send: (channel: string, ...args: any[]) => {
      ipcRenderer.send(channel, ...args);
    },
    on: (channel: string, func: (...args: any[]) => void) => {
      const handler = (_event: any, ...args: any[]) => func(...args);
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
        _event: any,
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
  generateSessionTitle: (userInput: string | null) =>
    ipcRenderer.invoke('generate-session-title', userInput),
  getRecentCwds: (limit?: number) => ipcRenderer.invoke('get-recent-cwds', limit),
  openclaw: {
    engine: {
      getStatus: () => ipcRenderer.invoke('openclaw:engine:getStatus'),
      restartGateway: () => ipcRenderer.invoke('openclaw:engine:restartGateway'),
      getPort: () => ipcRenderer.invoke('openclaw:engine:getPort'),
      getToken: () => ipcRenderer.invoke('openclaw:engine:getToken'),
      setPort: (port: number) => ipcRenderer.invoke('openclaw:engine:setPort', port),
      openTerminal: () => ipcRenderer.invoke('openclaw:engine:openTerminal'),
      onProgress: (callback: (status: any) => void) => {
        const handler = (_event: any, status: any) => callback(status);
        ipcRenderer.on('openclaw:engine:onProgress', handler);
        return () => ipcRenderer.removeListener('openclaw:engine:onProgress', handler);
      },
    },
    history: {
      getToolInputs: (params: { sessionKey: string; toolCallIds: string[] }) =>
        ipcRenderer.invoke(OpenClawHistoryIpc.GetToolInputs, params),
      getPagedHistory: (params: { sessionKey: string }) =>
        ipcRenderer.invoke(OpenClawHistoryIpc.GetPagedHistory, params),
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
      systemPrompt?: string;
      activeSkillIds?: string[];
      agentId?: string;
      attachments?: CoworkAttachmentPayload[];
    }) => ipcRenderer.invoke('cowork:session:start', options),
    continueSession: (options: {
      sessionId: string;
      prompt: string;
      systemPrompt?: string;
      activeSkillIds?: string[];
      attachments?: CoworkAttachmentPayload[];
    }) => ipcRenderer.invoke('cowork:session:continue', options),
    stopSession: (sessionId: string) => ipcRenderer.invoke('cowork:session:stop', sessionId),
    deleteSession: (sessionId: string) => ipcRenderer.invoke('cowork:session:delete', sessionId),
    deleteSessions: (sessionIds: string[]) =>
      ipcRenderer.invoke('cowork:session:deleteBatch', sessionIds),
    setSessionPinned: (options: { sessionId: string; pinned: boolean }) =>
      ipcRenderer.invoke('cowork:session:pin', options),
    renameSession: (options: { sessionId: string; title: string }) =>
      ipcRenderer.invoke('cowork:session:rename', options),
    getSession: (sessionId: string) => ipcRenderer.invoke('cowork:session:get', sessionId),
    remoteManaged: (sessionId: string) =>
      ipcRenderer.invoke('cowork:session:remoteManaged', sessionId),
    getSessionRuntimeStatus: (sessionId: string, options?: { includeSubagents?: boolean }) =>
      ipcRenderer.invoke('cowork:session:runtimeStatus', sessionId, options),
    getSessionRuntimeStatuses: (sessionIds: string[], options?: { includeSubagents?: boolean }) =>
      ipcRenderer.invoke('cowork:sessions:runtimeStatus', sessionIds, options),
    patchSessionModel: (options: { sessionId: string; model: string; agentId?: string }) =>
      ipcRenderer.invoke('cowork:session:patchModel', options),
    listSessions: (agentId?: string) => ipcRenderer.invoke('cowork:session:list', agentId),
    getSessionGoal: (sessionId: string) => ipcRenderer.invoke('cowork:session:goal', sessionId),
    getContextUsage: (sessionId: string) =>
      ipcRenderer.invoke('cowork:session:contextUsage', sessionId),
    deleteMessage: (sessionId: string, messageId: string) =>
      ipcRenderer.invoke('cowork:message:delete', sessionId, messageId),
    deleteMessagesFrom: (sessionId: string, messageId: string) =>
      ipcRenderer.invoke('cowork:message:deleteFrom', sessionId, messageId),
    // Extension interaction handling
    respondToInteraction: (options: { requestId: string; result: any }) =>
      ipcRenderer.invoke('cowork:interaction:respond', options),

    // Configuration
    getConfig: () => ipcRenderer.invoke('cowork:config:get'),
    setConfig: (config: {
      workingDirectory?: string;
      executionMode?: 'auto' | 'local' | 'sandbox';
      agentEngine?: 'openclaw';
    }) => ipcRenderer.invoke('cowork:config:set', config),
    setDefaultModel: (options: { modelId: string; providerKey?: string; agentId?: string }) =>
      ipcRenderer.invoke('config:setDefaultModel', options),
    // Stream event listeners
    onStreamMessage: (callback: (data: { sessionId: string; message: any }) => void) => {
      const handler = (_event: any, data: { sessionId: string; message: any }) => callback(data);
      ipcRenderer.on('cowork:stream:message', handler);
      return () => ipcRenderer.removeListener('cowork:stream:message', handler);
    },
    onStreamMessageUpdate: (
      callback: (data: { sessionId: string; messageId: string; content: string }) => void,
    ) => {
      const handler = (
        _event: any,
        data: { sessionId: string; messageId: string; content: string },
      ) => callback(data);
      ipcRenderer.on('cowork:stream:messageUpdate', handler);
      return () => ipcRenderer.removeListener('cowork:stream:messageUpdate', handler);
    },
    onStreamThinkingUpdate: (
      callback: (data: { sessionId: string; messageId: string; thinkingDelta: string }) => void,
    ) => {
      const handler = (
        _event: any,
        data: { sessionId: string; messageId: string; thinkingDelta: string },
      ) => callback(data);
      ipcRenderer.on('cowork:stream:thinkingUpdate', handler);
      return () => ipcRenderer.removeListener('cowork:stream:thinkingUpdate', handler);
    },
    onStreamMessageMetadataUpdate: (
      callback: (data: {
        sessionId: string;
        messageId: string;
        metadata: Record<string, unknown>;
      }) => void,
    ) => {
      const handler = (
        _event: any,
        data: { sessionId: string; messageId: string; metadata: Record<string, unknown> },
      ) => callback(data);
      ipcRenderer.on('cowork:stream:messageMetadataUpdate', handler);
      return () => ipcRenderer.removeListener('cowork:stream:messageMetadataUpdate', handler);
    },
    onStreamMessageDelete: (callback: (data: { sessionId: string; messageId: string }) => void) => {
      const handler = (_event: any, data: { sessionId: string; messageId: string }) =>
        callback(data);
      ipcRenderer.on('cowork:stream:messageDelete', handler);
      return () => ipcRenderer.removeListener('cowork:stream:messageDelete', handler);
    },
    onStreamInteraction: (callback: (data: { sessionId: string; request: any }) => void) => {
      const handler = (_event: any, data: { sessionId: string; request: any }) => callback(data);
      ipcRenderer.on('cowork:stream:interaction', handler);
      return () => ipcRenderer.removeListener('cowork:stream:interaction', handler);
    },
    onStreamInteractionDismiss: (callback: (data: { requestId: string }) => void) => {
      const handler = (_event: any, data: { requestId: string }) => callback(data);
      ipcRenderer.on('cowork:stream:interactionDismiss', handler);
      return () => ipcRenderer.removeListener('cowork:stream:interactionDismiss', handler);
    },
    onStreamComplete: (
      callback: (data: {
        sessionId: string;
        finalStatus?: string;
      }) => void,
    ) => {
      const handler = (
        _event: any,
        data: { sessionId: string; finalStatus?: string },
      ) => callback(data);
      ipcRenderer.on('cowork:stream:complete', handler);
      return () => ipcRenderer.removeListener('cowork:stream:complete', handler);
    },
    onStreamError: (callback: (data: { sessionId: string; error: string }) => void) => {
      const handler = (_event: any, data: { sessionId: string; error: string }) => callback(data);
      ipcRenderer.on('cowork:stream:error', handler);
      return () => ipcRenderer.removeListener('cowork:stream:error', handler);
    },
    onSessionsChanged: (callback: () => void) => {
      const handler = () => callback();
      ipcRenderer.on('cowork:sessions:changed', handler);
      return () => ipcRenderer.removeListener('cowork:sessions:changed', handler);
    },
    getSubTaskStatus: (sessionId?: string) =>
      ipcRenderer.invoke('cowork:subTask:status', sessionId),
    getSubTaskSession: (sessionKey: string) =>
      ipcRenderer.invoke('cowork:subTask:session', sessionKey),
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
    openPath: (filePath: string, workingDirectory?: string) =>
      ipcRenderer.invoke('shell:openPath', filePath, workingDirectory),
    readPreviewFile: (filePath: string, workingDirectory?: string) =>
      ipcRenderer.invoke('shell:readPreviewFile', filePath, workingDirectory),
    showItemInFolder: (filePath: string, workingDirectory?: string) =>
      ipcRenderer.invoke('shell:showItemInFolder', filePath, workingDirectory),
    openExternal: (url: string) => ipcRenderer.invoke('shell:openExternal', url),
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
    create: (input: any) => ipcRenderer.invoke(ScheduledTaskIpc.Create, input),
    update: (id: string, input: any) => ipcRenderer.invoke(ScheduledTaskIpc.Update, id, input),
    delete: (id: string) => ipcRenderer.invoke(ScheduledTaskIpc.Delete, id),
    toggle: (id: string, enabled: boolean) =>
      ipcRenderer.invoke(ScheduledTaskIpc.Toggle, id, enabled),

    // Execution
    runManually: (id: string) => ipcRenderer.invoke(ScheduledTaskIpc.RunManually, id),

    // Run history
    listRuns: (taskId: string, limit?: number, offset?: number) =>
      ipcRenderer.invoke(ScheduledTaskIpc.ListRuns, taskId, limit, offset),
    resolveSession: (sessionKey: string) =>
      ipcRenderer.invoke(ScheduledTaskIpc.ResolveSession, sessionKey),

    // Delivery channels
    listChannels: () => ipcRenderer.invoke(ScheduledTaskIpc.ListChannels),

    onStatusUpdate: (callback: (data: any) => void) => {
      const handler = (_event: any, data: any) => callback(data);
      ipcRenderer.on(ScheduledTaskIpc.StatusUpdate, handler);
      return () => ipcRenderer.removeListener(ScheduledTaskIpc.StatusUpdate, handler);
    },
    onRunUpdate: (callback: (data: any) => void) => {
      const handler = (_event: any, data: any) => callback(data);
      ipcRenderer.on(ScheduledTaskIpc.RunUpdate, handler);
      return () => ipcRenderer.removeListener(ScheduledTaskIpc.RunUpdate, handler);
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
