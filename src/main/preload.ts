import { contextBridge, ipcRenderer } from 'electron';

import { IpcChannel as ScheduledTaskIpc } from '../scheduledTask/constants';

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
    // New: Gateway-based skill management
    install: (params: { source: 'clawhub'; slug: string; version?: string; force?: boolean }) =>
      ipcRenderer.invoke('skills:install', params),
    // Offline import from local archive
    import: (archivePath: string) => ipcRenderer.invoke('skills:import', archivePath),
    // Offline import from local folder
    importFolder: (folderPath: string) => ipcRenderer.invoke('skills:importFolder', folderPath),
    search: (options?: { query?: string; limit?: number }) =>
      ipcRenderer.invoke('skills:search', options || {}),
    detail: (options: { slug: string }) => ipcRenderer.invoke('skills:detail', options),
    // Deprecated: no longer functional, Gateway manages everything
    delete: (id: string) => ipcRenderer.invoke('skills:delete', id),
    getRoot: () => ipcRenderer.invoke('skills:getRoot'),
    autoRoutingPrompt: () => ipcRenderer.invoke('skills:autoRoutingPrompt'),
    getConfig: (skillId: string) => ipcRenderer.invoke('skills:getConfig', skillId),
    setConfig: (skillId: string, config: Record<string, string>) =>
      ipcRenderer.invoke('skills:setConfig', skillId, config),
    testEmailConnectivity: (skillId: string, config: Record<string, string>) =>
      ipcRenderer.invoke('skills:testEmailConnectivity', skillId, config),
    onChanged: (callback: () => void) => {
      const handler = () => callback();
      ipcRenderer.on('skills:changed', handler);
      return () => ipcRenderer.removeListener('skills:changed', handler);
    },
  },
  mcp: {
    list: () => ipcRenderer.invoke('mcp:list'),
    create: (data: any) => ipcRenderer.invoke('mcp:create', data),
    update: (id: string, data: any) => ipcRenderer.invoke('mcp:update', id, data),
    delete: (id: string) => ipcRenderer.invoke('mcp:delete', id),
    setEnabled: (options: { id: string; enabled: boolean }) =>
      ipcRenderer.invoke('mcp:setEnabled', options),
    refreshBridge: () => ipcRenderer.invoke('mcp:refreshBridge'),
    onBridgeSyncStart: (callback: () => void) => {
      const handler = () => callback();
      ipcRenderer.on('mcp:bridge:syncStart', handler);
      return () => ipcRenderer.removeListener('mcp:bridge:syncStart', handler);
    },
    onBridgeSyncDone: (callback: (data: { tools: number; error?: string }) => void) => {
      const handler = (_event: any, data: { tools: number; error?: string }) => callback(data);
      ipcRenderer.on('mcp:bridge:syncDone', handler);
      return () => ipcRenderer.removeListener('mcp:bridge:syncDone', handler);
    },
  },
  permissions: {
    checkCalendar: () => ipcRenderer.invoke('permissions:checkCalendar'),
    requestCalendar: () => ipcRenderer.invoke('permissions:requestCalendar'),
  },
  enterprise: {
    getConfig: () => ipcRenderer.invoke('enterprise:getConfig'),
  },
  api: {
    // 普通 API 请求（非流式）
    fetch: (options: {
      url: string;
      method: string;
      headers: Record<string, string>;
      body?: string;
    }) => ipcRenderer.invoke('api:fetch', options),

    // 流式 API 请求
    stream: (options: {
      url: string;
      method: string;
      headers: Record<string, string>;
      body?: string;
      requestId: string;
    }) => ipcRenderer.invoke('api:stream', options),

    // 取消流式请求
    cancelStream: (requestId: string) => ipcRenderer.invoke('api:stream:cancel', requestId),

    // 监听流式数据
    onStreamData: (requestId: string, callback: (chunk: string) => void) => {
      const handler = (_event: any, chunk: string) => callback(chunk);
      ipcRenderer.on(`api:stream:${requestId}:data`, handler);
      return () => ipcRenderer.removeListener(`api:stream:${requestId}:data`, handler);
    },

    // 监听流式完成
    onStreamDone: (requestId: string, callback: () => void) => {
      const handler = () => callback();
      ipcRenderer.on(`api:stream:${requestId}:done`, handler);
      return () => ipcRenderer.removeListener(`api:stream:${requestId}:done`, handler);
    },

    // 监听流式错误
    onStreamError: (requestId: string, callback: (error: string) => void) => {
      const handler = (_event: any, error: string) => callback(error);
      ipcRenderer.on(`api:stream:${requestId}:error`, handler);
      return () => ipcRenderer.removeListener(`api:stream:${requestId}:error`, handler);
    },

    // 监听流式取消
    onStreamAbort: (requestId: string, callback: () => void) => {
      const handler = () => callback();
      ipcRenderer.on(`api:stream:${requestId}:abort`, handler);
      return () => ipcRenderer.removeListener(`api:stream:${requestId}:abort`, handler);
    },
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
  saveApiConfig: (config: {
    apiKey: string;
    baseURL: string;
    model: string;
    apiType?: 'anthropic' | 'openai';
  }) => ipcRenderer.invoke('save-api-config', config),
  generateSessionTitle: (userInput: string | null) =>
    ipcRenderer.invoke('generate-session-title', userInput),
  getRecentCwds: (limit?: number) => ipcRenderer.invoke('get-recent-cwds', limit),
  openclaw: {
    engine: {
      getStatus: () => ipcRenderer.invoke('openclaw:engine:getStatus'),
      install: () => ipcRenderer.invoke('openclaw:engine:install'),
      retryInstall: () => ipcRenderer.invoke('openclaw:engine:retryInstall'),
      restartGateway: () => ipcRenderer.invoke('openclaw:engine:restartGateway'),
      getPort: () => ipcRenderer.invoke('openclaw:engine:getPort'),
      getToken: () => ipcRenderer.invoke('openclaw:engine:getToken'),
      setPort: (port: number) => ipcRenderer.invoke('openclaw:engine:setPort', port),
      onProgress: (callback: (status: any) => void) => {
        const handler = (_event: any, status: any) => callback(status);
        ipcRenderer.on('openclaw:engine:onProgress', handler);
        return () => ipcRenderer.removeListener('openclaw:engine:onProgress', handler);
      },
    },
  },
  agents: {
    list: async () => {
      const result = await ipcRenderer.invoke('agents:list');
      return result?.success ? result.agents : [];
    },
    get: async (id: string) => {
      const result = await ipcRenderer.invoke('agents:get', id);
      return result?.success ? result.agent : null;
    },
    create: async (request: {
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
    }) => {
      const result = await ipcRenderer.invoke('agents:create', request);
      return result?.success ? result.agent : null;
    },
    update: async (
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
    ) => {
      const result = await ipcRenderer.invoke('agents:update', id, updates);
      return result?.success ? result.agent : null;
    },
    delete: async (id: string) => {
      const result = await ipcRenderer.invoke('agents:delete', id);
      return result?.success ? result.deleted : false;
    },
    presets: async () => {
      const result = await ipcRenderer.invoke('agents:presets');
      return result?.success ? result.presets : [];
    },
    addPreset: async (presetId: string) => {
      const result = await ipcRenderer.invoke('agents:addPreset', presetId);
      return result?.success ? result.agent : null;
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
      imageAttachments?: Array<{ name: string; mimeType: string; base64Data: string }>;
    }) => ipcRenderer.invoke('cowork:session:start', options),
    continueSession: (options: {
      sessionId: string;
      prompt: string;
      systemPrompt?: string;
      activeSkillIds?: string[];
      imageAttachments?: Array<{ name: string; mimeType: string; base64Data: string }>;
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
    patchSessionModel: (options: { sessionId: string; model: string; agentId?: string }) =>
      ipcRenderer.invoke('cowork:session:patchModel', options),
    listSessions: (agentId?: string) => ipcRenderer.invoke('cowork:session:list', agentId),
    getContextUsage: (sessionId: string) =>
      ipcRenderer.invoke('cowork:session:contextUsage', sessionId),
    deleteMessage: (sessionId: string, messageId: string) =>
      ipcRenderer.invoke('cowork:message:delete', sessionId, messageId),
    exportResultImage: (options: {
      rect: { x: number; y: number; width: number; height: number };
      defaultFileName?: string;
    }) => ipcRenderer.invoke('cowork:session:exportResultImage', options),
    captureImageChunk: (options: {
      rect: { x: number; y: number; width: number; height: number };
    }) => ipcRenderer.invoke('cowork:session:captureImageChunk', options),
    saveResultImage: (options: { pngBase64: string; defaultFileName?: string }) =>
      ipcRenderer.invoke('cowork:session:saveResultImage', options),
    exportSessionText: (options: {
      content: string;
      defaultFileName?: string;
      fileExtension?: string;
    }) => ipcRenderer.invoke('cowork:session:exportText', options),

    // Permission handling
    respondToPermission: (options: { requestId: string; result: any }) =>
      ipcRenderer.invoke('cowork:permission:respond', options),

    // Configuration
    getConfig: () => ipcRenderer.invoke('cowork:config:get'),
    setConfig: (config: {
      workingDirectory?: string;
      executionMode?: 'auto' | 'local' | 'sandbox';
      agentEngine?: 'openclaw';
    }) => ipcRenderer.invoke('cowork:config:set', config),
    setDefaultModel: (options: { modelId: string; providerKey?: string }) =>
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
    onStreamPermission: (callback: (data: { sessionId: string; request: any }) => void) => {
      const handler = (_event: any, data: { sessionId: string; request: any }) => callback(data);
      ipcRenderer.on('cowork:stream:permission', handler);
      return () => ipcRenderer.removeListener('cowork:stream:permission', handler);
    },
    onStreamPermissionDismiss: (callback: (data: { requestId: string }) => void) => {
      const handler = (_event: any, data: { requestId: string }) => callback(data);
      ipcRenderer.on('cowork:stream:permissionDismiss', handler);
      return () => ipcRenderer.removeListener('cowork:stream:permissionDismiss', handler);
    },
    onStreamComplete: (
      callback: (data: {
        sessionId: string;
        claudeSessionId: string | null;
        finalStatus?: string;
      }) => void,
    ) => {
      const handler = (
        _event: any,
        data: { sessionId: string; claudeSessionId: string | null; finalStatus?: string },
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
    // Subagent streaming event listeners
    onSubagentMessage: (
      callback: (data: { parentSessionId: string; agentId: string; message: any }) => void,
    ) => {
      const handler = (
        _event: any,
        data: { parentSessionId: string; agentId: string; message: any },
      ) => callback(data);
      ipcRenderer.on('cowork:subagent:message', handler);
      return () => ipcRenderer.removeListener('cowork:subagent:message', handler);
    },
    onSubagentMessageUpdate: (
      callback: (data: {
        parentSessionId: string;
        agentId: string;
        messageId: string;
        content: string;
      }) => void,
    ) => {
      const handler = (
        _event: any,
        data: {
          parentSessionId: string;
          agentId: string;
          messageId: string;
          content: string;
        },
      ) => callback(data);
      ipcRenderer.on('cowork:subagent:messageUpdate', handler);
      return () => ipcRenderer.removeListener('cowork:subagent:messageUpdate', handler);
    },
    onSubagentThinkingUpdate: (
      callback: (data: {
        parentSessionId: string;
        agentId: string;
        messageId: string;
        thinkingDelta: string;
      }) => void,
    ) => {
      const handler = (
        _event: any,
        data: {
          parentSessionId: string;
          agentId: string;
          messageId: string;
          thinkingDelta: string;
        },
      ) => callback(data);
      ipcRenderer.on('cowork:subagent:thinkingUpdate', handler);
      return () => ipcRenderer.removeListener('cowork:subagent:thinkingUpdate', handler);
    },
    onSubagentToolResult: (
      callback: (data: {
        parentSessionId: string;
        agentId: string;
        toolUseId: string;
        result: string;
        isError: boolean;
      }) => void,
    ) => {
      const handler = (
        _event: any,
        data: {
          parentSessionId: string;
          agentId: string;
          toolUseId: string;
          result: string;
          isError: boolean;
        },
      ) => callback(data);
      ipcRenderer.on('cowork:subagent:toolResult', handler);
      return () => ipcRenderer.removeListener('cowork:subagent:toolResult', handler);
    },
    getSubTaskStatus: (sessionId?: string) =>
      ipcRenderer.invoke('cowork:subTask:status', sessionId),
    getSubTaskHistory: (options: {
      parentSessionId: string;
      agentId: string;
      sessionKey?: string;
    }) => ipcRenderer.invoke('cowork:subTask:history', options),
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
    openPath: (filePath: string) => ipcRenderer.invoke('shell:openPath', filePath),
    showItemInFolder: (filePath: string) => ipcRenderer.invoke('shell:showItemInFolder', filePath),
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
  log: {
    getPath: () => ipcRenderer.invoke('log:getPath'),
    openFolder: () => ipcRenderer.invoke('log:openFolder'),
    exportZip: () => ipcRenderer.invoke('log:exportZip'),
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
    stop: (id: string) => ipcRenderer.invoke(ScheduledTaskIpc.Stop, id),

    // Run history
    listRuns: (taskId: string, limit?: number, offset?: number) =>
      ipcRenderer.invoke(ScheduledTaskIpc.ListRuns, taskId, limit, offset),
    countRuns: (taskId: string) => ipcRenderer.invoke(ScheduledTaskIpc.CountRuns, taskId),
    listAllRuns: (limit?: number, offset?: number) =>
      ipcRenderer.invoke(ScheduledTaskIpc.ListAllRuns, limit, offset),
    resolveSession: (sessionKey: string) =>
      ipcRenderer.invoke(ScheduledTaskIpc.ResolveSession, sessionKey),

    // Delivery channels
    listChannels: () => ipcRenderer.invoke(ScheduledTaskIpc.ListChannels),
    listChannelConversations: (channel: string, accountId?: string) =>
      ipcRenderer.invoke(ScheduledTaskIpc.ListChannelConversations, channel, accountId),

    // Stream event listeners
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
  qwen: {
    // OAuth登录
    oauthLogin: () => ipcRenderer.invoke('qwen:oauth:login'),
    // OAuth刷新token
    oauthRefresh: (refreshToken: string) => ipcRenderer.invoke('qwen:oauth:refresh', refreshToken),
    // OAuth进度监听
    onOAuthProgress: (callback: (message: string) => void) => {
      const handler = (_event: any, message: string) => callback(message);
      ipcRenderer.on('qwen:oauth:progress', handler);
      return () => ipcRenderer.removeListener('qwen:oauth:progress', handler);
    },
  },
});
