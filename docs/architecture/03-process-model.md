# JustDo 进程模型与 IPC 通信

**Last Updated:** 2026-07-01
**Version:** 2026.7.1

## 1. Electron 进程模型

JustDo 采用 Electron 的严格进程隔离架构，所有跨进程通信通过 IPC 实现。

### 1.1 三进程模型

```
+--------------------------------------------------------------------+
|                    Main Process (Node.js)                            |
|                                                                      |
|  - 窗口生命周期管理                                                   |
|  - SQLite 持久化（UI 缓存）                                            |
|  - OpenClaw Gateway 引擎生命周期管理                                    |
|  - 50+ IPC 处理器（按模块组织）                                       |
|  - IM 网关（多平台 Bot 集成，规划中）                                 |
|  - 安全：contextIsolation 启用，nodeIntegration 禁用                  |
|                                                                      |
|  入口文件：src/main/main.ts                                          |
+--------------------------------------------------------------------+
                              |
                              | IPC (ipcMain.handle / ipcRenderer.invoke)
                              |
                              v
+--------------------------------------------------------------------+
|                    Preload Script                                    |
|                                                                      |
|  - 通过 contextBridge 暴露 window.electron API                       |
|  - 模块命名空间：cowork, store, skills, mcp, agents,                 |
|    api, dialog, shell, autoLaunch, preventSleep, appInfo,            |
|    log, scheduledTasks, openclaw.engine, permissions                 |
|                                                                      |
|  入口文件：src/main/preload.ts                                       |
+--------------------------------------------------------------------+
                              |
                              | contextBridge (安全桥接)
                              |
                              v
+--------------------------------------------------------------------+
|                    Renderer Process (React + Lit)                     |
|                                                                      |
|  - React 18 + Redux Toolkit + Tailwind CSS 3 + Lit                  |
|  - 所有 UI 和业务逻辑（不含 Agent 执行逻辑）                           |
|  - 聊天渲染：<justdo-chat> Lit 自定义元素直接连接 Gateway WebSocket   |
|  - 通过 IPC 与主进程通信（配置、存储、系统操作）                       |
|                                                                      |
|  入口文件：src/renderer/App.tsx                                      |
+--------------------------------------------------------------------+
```

### 1.2 安全配置

**webPreferences**（BrowserWindow）：

```typescript
const mainWindow = new BrowserWindow({
  webPreferences: {
    preload: path.join(__dirname, 'preload.js'),
    contextIsolation: true,    // 启用：Renderer 无法直接访问 Node.js
    nodeIntegration: false,    // 禁用：Renderer 无 require 能力
    sandbox: true,             // 启用：Renderer 运行在沙箱
    webSecurity: true,
  }
});
```

### 1.3 架构设计要点

- **Thin Frontend**：Renderer 不包含任何 Agent 执行逻辑。会话由 Gateway 全权管理。
- **Gateway WebSocket 直连**：聊天渲染通过 Lit `<justdo-chat>` 自定义元素直接连接 Gateway WebSocket，不经过 IPC 中继。这提供了更低的延迟和与 OpenClaw WebChat 一致的用户体验。
- **SQLite 是 UI 缓存**：本地数据库仅缓存 Gateway 的会话和消息数据，不是权威数据源。
- **IM 集成（未来工作）**：当前阶段未激活。代码中有占位，但 `im:getConfig`、`im:setConfig` 等 IPC channel 已移除。

## 2. Preload API 设计

### 2.1 命名空间结构

Preload 通过 `contextBridge.exposeInMainWorld` 暴露 API，按功能模块组织：

```typescript
// src/main/preload.ts
contextBridge.exposeInMainWorld('electron', {
  // 基本信息
  platform: process.platform,
  arch: process.arch,

  // 存储
  store: {
    get: (key: string) => ipcRenderer.invoke('store:get', key),
    set: (key: string, value: unknown) => ipcRenderer.invoke('store:set', key, value),
    remove: (key: string) => ipcRenderer.invoke('store:remove', key),
  },

  // Skills 管理
  skills: {
    list: () => ipcRenderer.invoke('skills:list'),
    setEnabled: (options: { id: string; enabled: boolean }) =>
      ipcRenderer.invoke('skills:setEnabled', options),
    install: (params: { source: 'clawhub'; slug: string; version?: string; force?: boolean }) =>
      ipcRenderer.invoke('skills:install', params),
    import: (archivePath: string) => ipcRenderer.invoke('skills:import', archivePath),
    importFolder: (folderPath: string) => ipcRenderer.invoke('skills:importFolder', folderPath),
    search: (options?: { query?: string; limit?: number }) =>
      ipcRenderer.invoke('skills:search', options || {}),
    detail: (options: { slug: string }) => ipcRenderer.invoke('skills:detail', options),
    delete: (id: string) => ipcRenderer.invoke('skills:delete', id),
  },

  // MCP 服务器管理
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

  // 系统权限
  permissions: {
    checkCalendar: () => ipcRenderer.invoke('permissions:checkCalendar'),
    requestCalendar: () => ipcRenderer.invoke('permissions:requestCalendar'),
  },

  // API 请求（含流式）
  api: {
    fetch: (options: { url: string; method: string; headers: Record<string, string>; body?: string }) =>
      ipcRenderer.invoke('api:fetch', options),
    stream: (options: {
      url: string; method: string; headers: Record<string, string>;
      body?: string; requestId: string;
    }) => ipcRenderer.invoke('api:stream', options),
    cancelStream: (requestId: string) => ipcRenderer.invoke('api:stream:cancel', requestId),
    onStreamData: (requestId: string, callback: (chunk: string) => void) => {
      const handler = (_event: any, chunk: string) => callback(chunk);
      ipcRenderer.on(`api:stream:${requestId}:data`, handler);
      return () => ipcRenderer.removeListener(`api:stream:${requestId}:data`, handler);
    },
    onStreamDone: (requestId: string, callback: () => void) => {
      const handler = () => callback();
      ipcRenderer.on(`api:stream:${requestId}:done`, handler);
      return () => ipcRenderer.removeListener(`api:stream:${requestId}:done`, handler);
    },
    onStreamError: (requestId: string, callback: (error: string) => void) => {
      const handler = (_event: any, error: string) => callback(error);
      ipcRenderer.on(`api:stream:${requestId}:error`, handler);
      return () => ipcRenderer.removeListener(`api:stream:${requestId}:error`, handler);
    },
    onStreamAbort: (requestId: string, callback: () => void) => {
      const handler = () => callback();
      ipcRenderer.on(`api:stream:${requestId}:abort`, handler);
      return () => ipcRenderer.removeListener(`api:stream:${requestId}:abort`, handler);
    },
  },

  // 通用 IPC 通道（受限）
  ipcRenderer: {
    send: (channel: string, ...args: any[]) => ipcRenderer.send(channel, ...args),
    on: (channel: string, func: (...args: any[]) => void) => {
      const handler = (_event: any, ...args: any[]) => func(...args);
      ipcRenderer.on(channel, handler);
      return () => ipcRenderer.removeListener(channel, handler);
    },
  },

  // 窗口控制
  window: {
    minimize: () => ipcRenderer.send('window-minimize'),
    toggleMaximize: () => ipcRenderer.send('window-maximize'),
    close: () => ipcRenderer.send('window-close'),
    isMaximized: () => ipcRenderer.invoke('window:isMaximized'),
    showSystemMenu: (position: { x: number; y: number }) =>
      ipcRenderer.send('window:showSystemMenu', position),
    onStateChanged: (callback: (state: {
      isMaximized: boolean; isFullscreen: boolean; isFocused: boolean;
    }) => void) => {
      const handler = (_event: any, state: any) => callback(state);
      ipcRenderer.on('window:state-changed', handler);
      return () => ipcRenderer.removeListener('window:state-changed', handler);
    },
  },

  // API 配置
  getApiConfig: () => ipcRenderer.invoke('get-api-config'),
  checkApiConfig: (options?: { probeModel?: boolean }) =>
    ipcRenderer.invoke('check-api-config', options),
  saveApiConfig: (config: { apiKey: string; baseURL: string; model: string; apiType?: 'anthropic' | 'openai' }) =>
    ipcRenderer.invoke('save-api-config', config),

  // 工具函数
  generateSessionTitle: (userInput: string | null) =>
    ipcRenderer.invoke('generate-session-title', userInput),
  getRecentCwds: (limit?: number) => ipcRenderer.invoke('get-recent-cwds', limit),

  // OpenClaw 引擎管理
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

  // Agent 管理
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
      id?: string; name: string; description?: string;
      systemPrompt?: string; identity?: string; model?: string;
      icon?: string; skillIds?: string[]; source?: string; presetId?: string;
    }) => {
      const result = await ipcRenderer.invoke('agents:create', request);
      return result?.success ? result.agent : null;
    },
    update: async (id: string, updates: {
      name?: string; description?: string; systemPrompt?: string;
      identity?: string; model?: string; icon?: string;
      skillIds?: string[]; enabled?: boolean;
    }) => {
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

  // Cowork 会话
  cowork: {
    // 会话管理
    startSession: (options: {
      prompt: string; cwd?: string; systemPrompt?: string;
      activeSkillIds?: string[]; agentId?: string;
      imageAttachments?: Array<{ name: string; mimeType: string; base64Data: string }>;
    }) => ipcRenderer.invoke('cowork:session:start', options),
    continueSession: (options: {
      sessionId: string; prompt: string; systemPrompt?: string;
      activeSkillIds?: string[];
      imageAttachments?: Array<{ name: string; mimeType: string; base64Data: string }>;
    }) => ipcRenderer.invoke('cowork:session:continue', options),
    stopSession: (sessionId: string) => ipcRenderer.invoke('cowork:session:stop', sessionId),
    deleteSession: (sessionId: string) => ipcRenderer.invoke('cowork:session:delete', sessionId),
    deleteSessions: (sessionIds: string[]) => ipcRenderer.invoke('cowork:session:deleteBatch', sessionIds),
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
    deleteMessagesFrom: (sessionId: string, messageId: string) =>
      ipcRenderer.invoke('cowork:message:deleteFrom', sessionId, messageId),
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
      content: string; defaultFileName?: string; fileExtension?: string;
    }) => ipcRenderer.invoke('cowork:session:exportText', options),

    // 权限管理
    respondToPermission: (options: { requestId: string; result: any }) =>
      ipcRenderer.invoke('cowork:permission:respond', options),

    // 配置
    getConfig: () => ipcRenderer.invoke('cowork:config:get'),
    setConfig: (config: {
      workingDirectory?: string; executionMode?: string;
    }) => ipcRenderer.invoke('cowork:config:set', config),

    // 记忆管理
    listMemoryEntries: (input: { query?: string; status?: string }) =>
      ipcRenderer.invoke('cowork:memory:listEntries', input),
    createMemoryEntry: (input: { text: string; confidence?: number }) =>
      ipcRenderer.invoke('cowork:memory:createEntry', input),
    updateMemoryEntry: (input: { id: string; text?: string }) =>
      ipcRenderer.invoke('cowork:memory:updateEntry', input),
    deleteMemoryEntry: (input: { id: string }) =>
      ipcRenderer.invoke('cowork:memory:deleteEntry', input),

    // 预设提示词
    listPresetPrompts: () => ipcRenderer.invoke('cowork:prompts:list'),
    getPresetPrompt: (id: string) => ipcRenderer.invoke('cowork:prompts:get', id),
    setPresetPrompt: (input: { id?: string; title: string; prompt: string }) =>
      ipcRenderer.invoke('cowork:prompts:set', input),
    deletePresetPrompt: (id: string) => ipcRenderer.invoke('cowork:prompts:delete', id),

    // 流式事件监听
    onStreamMessage: (callback: (data: {
      sessionId: string; message: any;
    }) => void) => {
      const handler = (_event: any, data: any) => callback(data);
      ipcRenderer.on('cowork:stream:message', handler);
      return () => ipcRenderer.removeListener('cowork:stream:message', handler);
    },
    onStreamMessageUpdate: (callback: (data: {
      sessionId: string; messageId: string; content: string;
    }) => void) => {
      const handler = (_event: any, data: any) => callback(data);
      ipcRenderer.on('cowork:stream:messageUpdate', handler);
      return () => ipcRenderer.removeListener('cowork:stream:messageUpdate', handler);
    },
    onStreamThinkingUpdate: (callback: (data: {
      sessionId: string; messageId: string; thinkingDelta: string;
    }) => void) => {
      const handler = (_event: any, data: any) => callback(data);
      ipcRenderer.on('cowork:stream:thinkingUpdate', handler);
      return () => ipcRenderer.removeListener('cowork:stream:thinkingUpdate', handler);
    },
    onStreamMessageMetadataUpdate: (callback: (data: {
      sessionId: string; messageId: string; metadata: Record<string, unknown>;
    }) => void) => {
      const handler = (_event: any, data: any) => callback(data);
      ipcRenderer.on('cowork:stream:messageMetadataUpdate', handler);
      return () => ipcRenderer.removeListener('cowork:stream:messageMetadataUpdate', handler);
    },
    onStreamPermission: (callback: (data: {
      sessionId: string; request: any;
    }) => void) => {
      const handler = (_event: any, data: any) => callback(data);
      ipcRenderer.on('cowork:stream:permissionRequest', handler);
      return () => ipcRenderer.removeListener('cowork:stream:permissionRequest', handler);
    },
    onStreamComplete: (callback: (data: {
      sessionId: string; claudeSessionId: string | null;
    }) => void) => {
      const handler = (_event: any, data: any) => callback(data);
      ipcRenderer.on('cowork:stream:complete', handler);
      return () => ipcRenderer.removeListener('cowork:stream:complete', handler);
    },
    onStreamError: (callback: (data: {
      sessionId: string; error: string;
    }) => void) => {
      const handler = (_event: any, data: any) => callback(data);
      ipcRenderer.on('cowork:stream:error', handler);
      return () => ipcRenderer.removeListener('cowork:stream:error', handler);
    },
    onSessionsChanged: (callback: () => void) => {
      const handler = () => callback();
      ipcRenderer.on('cowork:sessions:changed', handler);
      return () => ipcRenderer.removeListener('cowork:sessions:changed', handler);
    },
  },

  // 文件对话框
  dialog: {
    selectDirectory: () => ipcRenderer.invoke('dialog:selectDirectory'),
    selectFile: (options?: {
      title?: string; filters?: { name: string; extensions: string[] }[];
    }) => ipcRenderer.invoke('dialog:selectFile', options),
    selectFiles: (options?: {
      title?: string; filters?: { name: string; extensions: string[] }[];
      multiSelections?: boolean;
    }) => ipcRenderer.invoke('dialog:selectFiles', options),
    saveInlineFile: (options: {
      dataBase64: string; fileName?: string; mimeType?: string; cwd?: string;
    }) => ipcRenderer.invoke('dialog:saveInlineFile', options),
    readFileAsDataUrl: (filePath: string) =>
      ipcRenderer.invoke('dialog:readFileAsDataUrl', filePath),
  },

  // Shell 操作
  shell: {
    openPath: (filePath: string) => ipcRenderer.invoke('shell:openPath', filePath),
    showItemInFolder: (filePath: string) => ipcRenderer.invoke('shell:showItemInFolder', filePath),
    openExternal: (url: string) => ipcRenderer.invoke('shell:openExternal', url),
  },

  // 自动启动
  autoLaunch: {
    get: () => ipcRenderer.invoke('app:getAutoLaunch'),
    set: (enabled: boolean) => ipcRenderer.invoke('app:setAutoLaunch', enabled),
  },

  // 防止睡眠
  preventSleep: {
    get: () => ipcRenderer.invoke('app:getPreventSleep'),
    set: (enabled: boolean) => ipcRenderer.invoke('app:setPreventSleep', enabled),
  },

  // 应用信息
  appInfo: {
    getVersion: () => ipcRenderer.invoke('app:getVersion'),
    getSystemLocale: () => ipcRenderer.invoke('app:getSystemLocale'),
  },

  // 日志管理
  log: {
    getPath: () => ipcRenderer.invoke('log:getPath'),
    openFolder: () => ipcRenderer.invoke('log:openFolder'),
    exportZip: () => ipcRenderer.invoke('log:exportZip'),
  },

  // 定时任务
  scheduledTasks: {
    list: () => ipcRenderer.invoke(ScheduledTaskIpc.List),
    get: (id: string) => ipcRenderer.invoke(ScheduledTaskIpc.Get, id),
    create: (input: any) => ipcRenderer.invoke(ScheduledTaskIpc.Create, input),
    update: (id: string, input: any) => ipcRenderer.invoke(ScheduledTaskIpc.Update, id, input),
    delete: (id: string) => ipcRenderer.invoke(ScheduledTaskIpc.Delete, id),
    toggle: (id: string, enabled: boolean) => ipcRenderer.invoke(ScheduledTaskIpc.Toggle, id, enabled),
    runManually: (id: string) => ipcRenderer.invoke(ScheduledTaskIpc.RunManually, id),
    stop: (id: string) => ipcRenderer.invoke(ScheduledTaskIpc.Stop, id),
    listRuns: (taskId: string, limit?: number, offset?: number) =>
      ipcRenderer.invoke(ScheduledTaskIpc.ListRuns, taskId, limit, offset),
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
  },
});
```

### 2.2 类型声明

为 Renderer 提供完整的 TypeScript 类型声明，定义于 `src/renderer/types/electron.d.ts`：

```typescript
interface ElectronAPI {
  platform: NodeJS.Platform;
  arch: string;

  store: {
    get: (key: string) => Promise<unknown>;
    set: (key: string, value: unknown) => Promise<void>;
    remove: (key: string) => Promise<void>;
  };

  skills: {
    list: () => Promise<SkillEntry[]>;
    setEnabled: (options: { id: string; enabled: boolean }) => Promise<void>;
    install: (params: SkillInstallParams) => Promise<SkillEntry>;
    import: (archivePath: string) => Promise<SkillEntry>;
    importFolder: (folderPath: string) => Promise<SkillEntry>;
    search: (options?: SkillSearchOptions) => Promise<SkillSearchResult[]>;
    detail: (options: { slug: string }) => Promise<SkillDetail>;
    delete: (id: string) => Promise<void>;
    getRoot: () => Promise<string>;
    autoRoutingPrompt: () => Promise<string>;
    getConfig: (skillId: string) => Promise<Record<string, string>>;
    setConfig: (skillId: string, config: Record<string, string>) => Promise<void>;
    testEmailConnectivity: (skillId: string, config: Record<string, string>) => Promise<boolean>;
    onChanged: (callback: () => void) => () => void;
  };

  mcp: {
    list: () => Promise<MCPServer[]>;
    create: (data: MCPServerCreateInput) => Promise<void>;
    update: (id: string, data: MCPServerUpdateInput) => Promise<void>;
    delete: (id: string) => Promise<void>;
    setEnabled: (options: { id: string; enabled: boolean }) => Promise<void>;
    refreshBridge: () => Promise<void>;
    onBridgeSyncStart: (callback: () => void) => () => void;
    onBridgeSyncDone: (callback: (data: { tools: number; error?: string }) => void) => () => void;
  };

  permissions: {
    checkCalendar: () => Promise<boolean>;
    requestCalendar: () => Promise<boolean>;
  };

  api: {
    fetch: (options: ApiFetchOptions) => Promise<ApiResponse>;
    stream: (options: ApiStreamOptions) => Promise<void>;
    cancelStream: (requestId: string) => Promise<void>;
    onStreamData: (requestId: string, callback: (chunk: string) => void) => () => void;
    onStreamDone: (requestId: string, callback: () => void) => () => void;
    onStreamError: (requestId: string, callback: (error: string) => void) => () => void;
    onStreamAbort: (requestId: string, callback: () => void) => () => void;
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

  getApiConfig: () => Promise<ApiConfig>;
  checkApiConfig: (options?: { probeModel?: boolean }) => Promise<ApiConfigCheckResult>;
  saveApiConfig: (config: ApiConfigSaveInput) => Promise<void>;
  generateSessionTitle: (userInput: string | null) => Promise<string>;
  getRecentCwds: (limit?: number) => Promise<string[]>;

  openclaw: {
    engine: {
      getStatus: () => Promise<EngineStatus>;
      install: () => Promise<void>;
      retryInstall: () => Promise<void>;
      restartGateway: () => Promise<void>;
      getPort: () => Promise<number>;
      getToken: () => Promise<string>;
      setPort: (port: number) => Promise<void>;
      onProgress: (callback: (status: EngineInstallProgress) => void) => () => void;
    };
  };

  agents: {
    list: () => Promise<AgentConfig[]>;
    get: (id: string) => Promise<AgentConfig | null>;
    create: (request: AgentCreateRequest) => Promise<AgentConfig | null>;
    update: (id: string, updates: AgentUpdateRequest) => Promise<AgentConfig | null>;
    delete: (id: string) => Promise<boolean>;
    presets: () => Promise<AgentPreset[]>;
    addPreset: (presetId: string) => Promise<AgentConfig | null>;
  };

  cowork: {
    startSession: (options: StartSessionOptions) => Promise<{ sessionId: string }>;
    continueSession: (options: ContinueSessionOptions) => Promise<void>;
    stopSession: (sessionId: string) => Promise<void>;
    deleteSession: (sessionId: string) => Promise<void>;
    deleteSessions: (sessionIds: string[]) => Promise<void>;
    setSessionPinned: (options: { sessionId: string; pinned: boolean }) => Promise<void>;
    renameSession: (options: { sessionId: string; title: string }) => Promise<void>;
    getSession: (sessionId: string) => Promise<Session | null>;
    remoteManaged: (sessionId: string) => Promise<void>;
    patchSessionModel: (options: { sessionId: string; model: string; agentId?: string }) => Promise<void>;
    listSessions: (agentId?: string) => Promise<Session[]>;
    getContextUsage: (sessionId: string) => Promise<ContextUsage | null>;
    deleteMessage: (sessionId: string, messageId: string) => Promise<void>;
    deleteMessagesFrom: (sessionId: string, messageId: string) => Promise<void>;
    exportResultImage: (options: ExportImageOptions) => Promise<string | null>;
    captureImageChunk: (options: CaptureChunkOptions) => Promise<string>;
    saveResultImage: (options: SaveImageOptions) => Promise<string | null>;
    exportSessionText: (options: ExportTextOptions) => Promise<string | null>;
    respondToPermission: (options: { requestId: string; result: any }) => Promise<void>;
    getConfig: () => Promise<CoworkConfig>;
    setConfig: (config: CoworkConfigUpdate) => Promise<void>;
    listMemoryEntries: (input: MemoryListInput) => Promise<MemoryEntry[]>;
    createMemoryEntry: (input: { text: string; confidence?: number }) => Promise<MemoryEntry>;
    updateMemoryEntry: (input: MemoryUpdateInput) => Promise<void>;
    deleteMemoryEntry: (input: { id: string }) => Promise<void>;
    listPresetPrompts: () => Promise<PresetPrompt[]>;
    getPresetPrompt: (id: string) => Promise<PresetPrompt | null>;
    setPresetPrompt: (input: { id?: string; title: string; prompt: string }) => Promise<PresetPrompt>;
    deletePresetPrompt: (id: string) => Promise<void>;
    onStreamMessage: (callback: StreamMessageCallback) => () => void;
    onStreamMessageUpdate: (callback: StreamMessageUpdateCallback) => () => void;
    onStreamThinkingUpdate: (callback: StreamThinkingUpdateCallback) => () => void;
    onStreamMessageMetadataUpdate: (callback: StreamMetadataUpdateCallback) => () => void;
    onStreamPermission: (callback: StreamPermissionCallback) => () => void;
    onStreamComplete: (callback: StreamCompleteCallback) => () => void;
    onStreamError: (callback: StreamErrorCallback) => () => void;
    onSessionsChanged: (callback: () => void) => () => void;
  };

  dialog: {
    selectDirectory: () => Promise<string | null>;
    selectFile: (options?: FileDialogOptions) => Promise<string | null>;
    selectFiles: (options?: FileDialogOptions) => Promise<string[] | null>;
    saveInlineFile: (options: SaveInlineFileOptions) => Promise<string | null>;
    readFileAsDataUrl: (filePath: string) => Promise<string>;
  };

  shell: {
    openPath: (filePath: string) => Promise<void>;
    showItemInFolder: (filePath: string) => Promise<void>;
    openExternal: (url: string) => Promise<void>;
  };

  autoLaunch: {
    get: () => Promise<boolean>;
    set: (enabled: boolean) => Promise<void>;
  };

  preventSleep: {
    get: () => Promise<boolean>;
    set: (enabled: boolean) => Promise<void>;
  };

  appInfo: {
    getVersion: () => Promise<string>;
    getSystemLocale: () => Promise<string>;
  };

  log: {
    getPath: () => Promise<string>;
    openFolder: () => Promise<void>;
    exportZip: () => Promise<string>;
  };

  scheduledTasks: {
    list: () => Promise<ScheduledTask[]>;
    get: (id: string) => Promise<ScheduledTask>;
    create: (input: CreateTaskInput) => Promise<ScheduledTask>;
    update: (id: string, input: UpdateTaskInput) => Promise<void>;
    delete: (id: string) => Promise<void>;
    toggle: (id: string, enabled: boolean) => Promise<void>;
    runManually: (id: string) => Promise<void>;
    stop: (id: string) => Promise<void>;
    listRuns: (taskId: string, limit?: number, offset?: number) => Promise<TaskRun[]>;
    listChannels: () => Promise<DeliveryChannel[]>;
    onStatusUpdate: (callback: (data: any) => void) => () => void;
    onRunUpdate: (callback: (data: any) => void) => () => void;
  };
}

declare global {
  interface Window {
    electron: ElectronAPI;
  }
}
```

## 3. IPC Handler 实现

### 3.1 Handler 注册

所有 IPC handler 在 `main.ts` 中集中注册：

```typescript
// src/main/main.ts
function registerIpcHandlers() {
  // Store
  ipcMain.handle('store:get', handleStoreGet);
  ipcMain.handle('store:set', handleStoreSet);
  ipcMain.handle('store:remove', handleStoreRemove);

  // Skills
  ipcMain.handle('skills:list', handleSkillsList);
  ipcMain.handle('skills:setEnabled', handleSkillsSetEnabled);
  ipcMain.handle('skills:install', handleSkillsInstall);
  ipcMain.handle('skills:search', handleSkillsSearch);
  ipcMain.handle('skills:detail', handleSkillsDetail);
  ipcMain.handle('skills:import', handleSkillsImport);
  ipcMain.handle('skills:importFolder', handleSkillsImportFolder);
  ipcMain.handle('skills:delete', handleSkillsDelete);

  // MCP
  ipcMain.handle('mcp:list', handleMcpList);
  ipcMain.handle('mcp:create', handleMcpCreate);
  ipcMain.handle('mcp:update', handleMcpUpdate);
  ipcMain.handle('mcp:delete', handleMcpDelete);
  ipcMain.handle('mcp:setEnabled', handleMcpSetEnabled);
  ipcMain.handle('mcp:refreshBridge', handleMcpRefreshBridge);

  // Cowork Session
  ipcMain.handle('cowork:session:start', handleCoworkSessionStart);
  ipcMain.handle('cowork:session:continue', handleCoworkSessionContinue);
  ipcMain.handle('cowork:session:stop', handleCoworkSessionStop);
  ipcMain.handle('cowork:session:delete', handleCoworkSessionDelete);
  ipcMain.handle('cowork:session:deleteBatch', handleCoworkSessionDeleteBatch);
  ipcMain.handle('cowork:session:pin', handleCoworkSessionSetPinned);
  ipcMain.handle('cowork:session:rename', handleCoworkSessionRename);
  ipcMain.handle('cowork:session:get', handleCoworkSessionGet);
  ipcMain.handle('cowork:session:remoteManaged', handleCoworkSessionRemoteManaged);
  ipcMain.handle('cowork:session:patchModel', handleCoworkSessionPatchModel);
  ipcMain.handle('cowork:session:list', handleCoworkSessionList);
  ipcMain.handle('cowork:session:contextUsage', handleCoworkSessionContextUsage);
  ipcMain.handle('cowork:session:exportResultImage', handleCoworkSessionExportResultImage);
  ipcMain.handle('cowork:session:captureImageChunk', handleCoworkSessionCaptureImageChunk);
  ipcMain.handle('cowork:session:saveResultImage', handleCoworkSessionSaveResultImage);
  ipcMain.handle('cowork:session:exportText', handleCoworkSessionExportText);
  ipcMain.handle('cowork:message:delete', handleCoworkMessageDelete);
  ipcMain.handle('cowork:message:deleteFrom', handleCoworkMessageDeleteFrom);

  // Cowork Permission
  ipcMain.handle('cowork:permission:respond', handleCoworkPermissionRespond);

  // Cowork Config
  ipcMain.handle('cowork:config:get', handleCoworkConfigGet);
  ipcMain.handle('cowork:config:set', handleCoworkConfigSet);

  // Cowork Memory
  ipcMain.handle('cowork:memory:listEntries', handleCoworkMemoryListEntries);
  ipcMain.handle('cowork:memory:createEntry', handleCoworkMemoryCreateEntry);
  ipcMain.handle('cowork:memory:updateEntry', handleCoworkMemoryUpdateEntry);
  ipcMain.handle('cowork:memory:deleteEntry', handleCoworkMemoryDeleteEntry);

  // Cowork Bootstrap
  ipcMain.handle('cowork:bootstrap:read', handleCoworkBootstrapRead);
  ipcMain.handle('cowork:bootstrap:write', handleCoworkBootstrapWrite);

  // Cowork Preset Prompts
  ipcMain.handle('cowork:prompts:list', handleCoworkPresetPromptsList);
  ipcMain.handle('cowork:prompts:get', handleCoworkPresetPromptsGet);
  ipcMain.handle('cowork:prompts:set', handleCoworkPresetPromptsSet);
  ipcMain.handle('cowork:prompts:delete', handleCoworkPresetPromptsDelete);

  // API
  ipcMain.handle('api:fetch', handleApiFetch);
  ipcMain.handle('api:stream', handleApiStream);
  ipcMain.handle('api:stream:cancel', handleApiStreamCancel);

  // Dialog
  ipcMain.handle('dialog:selectDirectory', handleDialogSelectDirectory);
  ipcMain.handle('dialog:selectFile', handleDialogSelectFile);
  ipcMain.handle('dialog:selectFiles', handleDialogSelectFiles);
  ipcMain.handle('dialog:saveInlineFile', handleDialogSaveInlineFile);
  ipcMain.handle('dialog:readFileAsDataUrl', handleDialogReadFileAsDataUrl);

  // Shell
  ipcMain.handle('shell:openPath', handleShellOpenPath);
  ipcMain.handle('shell:showItemInFolder', handleShellShowItemInFolder);
  ipcMain.handle('shell:openExternal', handleShellOpenExternal);

  // App
  ipcMain.handle('app:getAutoLaunch', handleAppGetAutoLaunch);
  ipcMain.handle('app:setAutoLaunch', handleAppSetAutoLaunch);
  ipcMain.handle('app:getPreventSleep', handleAppGetPreventSleep);
  ipcMain.handle('app:setPreventSleep', handleAppSetPreventSleep);
  ipcMain.handle('app:getVersion', handleAppGetVersion);
  ipcMain.handle('app:getSystemLocale', handleAppGetSystemLocale);

  // Log
  ipcMain.handle('log:getPath', handleLogGetPath);
  ipcMain.handle('log:openFolder', handleLogOpenFolder);
  ipcMain.handle('log:exportZip', handleLogExportZip);

  // Scheduled Tasks
  ipcMain.handle(ScheduledTaskIpc.List, handleScheduledTaskList);
  ipcMain.handle(ScheduledTaskIpc.Get, handleScheduledTaskGet);
  ipcMain.handle(ScheduledTaskIpc.Create, handleScheduledTaskCreate);
  ipcMain.handle(ScheduledTaskIpc.Update, handleScheduledTaskUpdate);
  ipcMain.handle(ScheduledTaskIpc.Delete, handleScheduledTaskDelete);
  ipcMain.handle(ScheduledTaskIpc.Toggle, handleScheduledTaskToggle);
  ipcMain.handle(ScheduledTaskIpc.RunManually, handleScheduledTaskRunManually);
  ipcMain.handle(ScheduledTaskIpc.Stop, handleScheduledTaskStop);
  ipcMain.handle(ScheduledTaskIpc.ListRuns, handleScheduledTaskListRuns);
  ipcMain.handle(ScheduledTaskIpc.ListChannels, handleScheduledTaskListChannels);

  // Permissions
  ipcMain.handle('permissions:checkCalendar', handlePermissionsCheckCalendar);
  ipcMain.handle('permissions:requestCalendar', handlePermissionsRequestCalendar);

  // Agents
  ipcMain.handle('agents:list', handleAgentsList);
  ipcMain.handle('agents:get', handleAgentsGet);
  ipcMain.handle('agents:create', handleAgentsCreate);
  ipcMain.handle('agents:update', handleAgentsUpdate);
  ipcMain.handle('agents:delete', handleAgentsDelete);
  ipcMain.handle('agents:presets', handleAgentsPresets);
  ipcMain.handle('agents:addPreset', handleAgentsAddPreset);

  // OpenClaw Engine
  ipcMain.handle('openclaw:engine:getStatus', handleOpenclawEngineGetStatus);
  ipcMain.handle('openclaw:engine:install', handleOpenclawEngineInstall);
  ipcMain.handle('openclaw:engine:retryInstall', handleOpenclawEngineRetryInstall);
  ipcMain.handle('openclaw:engine:restartGateway', handleOpenclawEngineRestartGateway);
  ipcMain.handle('openclaw:engine:getPort', handleOpenclawEngineGetPort);
  ipcMain.handle('openclaw:engine:getToken', handleOpenclawEngineGetToken);
  ipcMain.handle('openclaw:engine:setPort', handleOpenclawEngineSetPort);

  // Window
  ipcMain.handle('window:isMaximized', handleWindowIsMaximized);

  // General
  ipcMain.handle('get-api-config', handleGetApiConfig);
  ipcMain.handle('check-api-config', handleCheckApiConfig);
  ipcMain.handle('save-api-config', handleSaveApiConfig);
  ipcMain.handle('generate-session-title', handleGenerateSessionTitle);
  ipcMain.handle('get-recent-cwds', handleGetRecentCwds);
}
```

### 3.2 Handler 实现示例

```typescript
// Cowork Session Handler
async function handleCoworkSessionStart(
  event: IpcMainInvokeEvent,
  options: StartSessionOptions
): Promise<{ sessionId: string; status: string }> {
  // 1. 检查引擎状态
  const engineStatus = openclawEngineManager.getStatus();
  if (engineStatus.phase !== 'running') {
    // 尝试启动引擎
    await openclawEngineManager.ensureRunning();
  }

  // 2. 创建会话（本地 SQLite 缓存）
  const sessionId = uuid();
  const workingDir = options.cwd || coworkStore.getConfig().workingDirectory;

  coworkStore.createSession(sessionId, {
    title: 'New Session',
    workingDirectory: workingDir,
    status: 'running',
    createdAt: Date.now(),
  });

  // 3. 添加用户消息（本地缓存）
  coworkStore.addMessage(sessionId, {
    id: uuid(),
    type: 'user',
    content: options.prompt,
    timestamp: Date.now(),
  });

  // 4. 通过引擎路由启动 Gateway 执行
  const router = new CoworkEngineRouter(coworkStore, openclawEngineManager);
  router.startSession(sessionId, options.prompt, {
    systemPrompt: options.systemPrompt,
    activeSkillIds: options.activeSkillIds,
    agentId: options.agentId,
    imageAttachments: options.imageAttachments,
  });

  return { sessionId, status: 'running' };
}
```

## 4. 流式通信

### 4.1 事件推送机制

主进程通过 `webContents.send` 推送事件：

```typescript
// src/main/libs/agentEngine/openclawRuntimeAdapter.ts
function emitStreamMessage(sessionId: string, message: CoworkMessage) {
  const win = BrowserWindow.getAllWindows()[0];
  if (win && !win.isDestroyed()) {
    win.webContents.send('cowork:stream:message', {
      sessionId,
      message,
    });
  }
}

function emitStreamMessageUpdate(sessionId: string, update: MessageUpdate) {
  const win = BrowserWindow.getAllWindows()[0];
  if (win && !win.isDestroyed()) {
    win.webContents.send('cowork:stream:messageUpdate', {
      sessionId,
      messageId: update.messageId,
      content: update.content,
      isStreaming: true,
    });
  }
}
```

### 4.2 Renderer 监听

```typescript
// src/renderer/services/cowork.ts
export function setupStreamListeners(dispatch: Dispatch) {
  window.electron.cowork.onStreamMessage((msg) => {
    dispatch(coworkSlice.actions.addMessage(msg));
  });

  window.electron.cowork.onStreamMessageUpdate((update) => {
    dispatch(coworkSlice.actions.updateMessageContent({
      messageId: update.messageId,
      content: update.content,
    }));
  });

  window.electron.cowork.onStreamComplete((result) => {
    dispatch(coworkSlice.actions.setSessionStatus({
      sessionId: result.sessionId,
      status: 'completed',
    }));
  });

  window.electron.cowork.onStreamError((error) => {
    dispatch(coworkSlice.actions.setSessionError({
      sessionId: error.sessionId,
      error: error.message,
    }));
  });
}
```

### 4.3 Chat 渲染的双通道模型

v2026.6 引入了双通道消息渲染：

1. **IPC 通道**（向后兼容/冗余）：通过 `cowork:stream:*` 事件推送消息到 Redux store，用于会话元数据维护
2. **WebSocket 直连通道**（主要）：`<justdo-chat>` Lit 元素通过 `ChatController` -> `client.ts` 直接连接 Gateway WebSocket，即时渲染消息内容

```
Gateway WebSocket
  |
  +---> <justdo-chat> Lit 元素 (main rendering path)
  |       |
  |       +---> pipeline/build-chat-items.ts
  |       +---> pipeline/message-normalizer.ts
  |       +---> components/justdo-chat.ts (Lit custom element)
  |
  +---> WebSocket -> Gateway History API
          |
          +---> Main Process openclawHistory.ts
                  |
                  +---> SQLite cowork_messages (cache)
                          |
                          +---> IPC cowork:stream:message
                                  |
                                  +---> Redux coworkSlice (metadata sync)
```

### 4.4 清理监听器

```typescript
// 组件卸载时清理
useEffect(() => {
  setupStreamListeners(dispatch);
  return () => {
    window.electron.cowork.onStreamMessage(() => {}); // deregister
  };
}, [dispatch]);
```

## 5. IPC Channel 常量管理

### 5.1 常量定义

所有 IPC channel 名称集中定义，避免裸字符串：

```typescript
// src/shared/ipcChannels.ts
export const IpcChannel = {
  // Store
  StoreGet: 'store:get',
  StoreSet: 'store:set',
  StoreDelete: 'store:delete',

  // Cowork Session
  CoworkSessionStart: 'cowork:session:start',
  CoworkSessionContinue: 'cowork:session:continue',
  CoworkSessionStop: 'cowork:session:stop',
  CoworkSessionDelete: 'cowork:session:delete',
  CoworkSessionGet: 'cowork:session:get',
  CoworkSessionList: 'cowork:session:list',

  // Cowork Config
  CoworkConfigGet: 'cowork:config:get',
  CoworkConfigSet: 'cowork:config:set',

  // Cowork Memory
  CoworkMemoryListEntries: 'cowork:memory:listEntries',
  CoworkMemoryCreateEntry: 'cowork:memory:createEntry',
  CoworkMemoryUpdateEntry: 'cowork:memory:updateEntry',
  CoworkMemoryDeleteEntry: 'cowork:memory:deleteEntry',

  // Stream Events
  CoworkStreamMessage: 'cowork:stream:message',
  CoworkStreamMessageUpdate: 'cowork:stream:messageUpdate',
  CoworkStreamThinkingUpdate: 'cowork:stream:thinkingUpdate',
  CoworkStreamMessageMetadataUpdate: 'cowork:stream:messageMetadataUpdate',
  CoworkStreamPermissionRequest: 'cowork:stream:permissionRequest',
  CoworkStreamComplete: 'cowork:stream:complete',
  CoworkStreamError: 'cowork:stream:error',

  // OpenClaw Engine
  OpenClawEngineGetStatus: 'openclaw:engine:getStatus',
  OpenClawEngineInstall: 'openclaw:engine:install',
  OpenClawEngineRetryInstall: 'openclaw:engine:retryInstall',
  OpenClawEngineRestartGateway: 'openclaw:engine:restartGateway',
  OpenClawEngineGetPort: 'openclaw:engine:getPort',
  OpenClawEngineGetToken: 'openclaw:engine:getToken',
  OpenClawEngineSetPort: 'openclaw:engine:setPort',

  // Skills
  SkillsList: 'skills:list',
  SkillsSetEnabled: 'skills:setEnabled',
  SkillsInstall: 'skills:install',
  SkillsSearch: 'skills:search',
  SkillsDetail: 'skills:detail',
  SkillsImport: 'skills:import',
  SkillsImportFolder: 'skills:importFolder',
  SkillsDelete: 'skills:delete',

  // MCP
  McpList: 'mcp:list',
  McpCreate: 'mcp:create',
  McpUpdate: 'mcp:update',
  McpDelete: 'mcp:delete',
  McpSetEnabled: 'mcp:setEnabled',
  McpRefreshBridge: 'mcp:refreshBridge',

  // Agents
  AgentList: 'agents:list',
  AgentGet: 'agents:get',
  AgentCreate: 'agents:create',
  AgentUpdate: 'agents:update',
  AgentDelete: 'agents:delete',
  AgentPresets: 'agents:presets',
  AgentAddPreset: 'agents:addPreset',

  // API
  ApiFetch: 'api:fetch',
  ApiStream: 'api:stream',
  ApiStreamCancel: 'api:stream:cancel',

  // Dialog
  DialogSelectDirectory: 'dialog:selectDirectory',
  DialogSelectFile: 'dialog:selectFile',
  DialogSelectFiles: 'dialog:selectFiles',
  DialogSaveInlineFile: 'dialog:saveInlineFile',
  DialogReadFileAsDataUrl: 'dialog:readFileAsDataUrl',

  // Shell
  ShellOpenPath: 'shell:openPath',
  ShellShowItemInFolder: 'shell:showItemInFolder',
  ShellOpenExternal: 'shell:openExternal',

  // App
  AppGetAutoLaunch: 'app:getAutoLaunch',
  AppSetAutoLaunch: 'app:setAutoLaunch',
  AppGetPreventSleep: 'app:getPreventSleep',
  AppSetPreventSleep: 'app:setPreventSleep',
  AppGetVersion: 'app:getVersion',
  AppGetSystemLocale: 'app:getSystemLocale',

  // Log
  LogGetPath: 'log:getPath',
  LogOpenFolder: 'log:openFolder',
  LogExportZip: 'log:exportZip',

  // Permissions
  PermissionsCheckCalendar: 'permissions:checkCalendar',
  PermissionsRequestCalendar: 'permissions:requestCalendar',

  // Window
  WindowIsMaximized: 'window:isMaximized',

  // General
  GetApiConfig: 'get-api-config',
  CheckApiConfig: 'check-api-config',
  SaveApiConfig: 'save-api-config',
  GenerateSessionTitle: 'generate-session-title',
  GetRecentCwds: 'get-recent-cwds',
} as const;

export type IpcChannelName = typeof IpcChannel[keyof typeof IpcChannel];
```

### 5.2 使用规范

**正确用法**：使用常量

```typescript
// Main
ipcMain.handle(IpcChannel.CoworkSessionStart, handler);

// Renderer
window.electron.cowork.startSession(params);
// 内部使用 ipcRenderer.invoke(IpcChannel.CoworkSessionStart, params)
```

**错误用法**：裸字符串

```typescript
// 错误 - 不要这样做
ipcMain.handle('cowork:session:start', handler);
ipcRenderer.invoke('cowork:session:start', params);
```

## 6. 错误处理

### 6.1 IPC 错误传递

```typescript
// Handler 错误处理
async function handleStartSession(event, params) {
  try {
    // 业务逻辑
    return { success: true, sessionId };
  } catch (error) {
    // 返回错误信息给 Renderer
    return {
      success: false,
      error: {
        code: 'ENGINE_NOT_READY',
        message: error.message,
      }
    };
  }
}
```

### 6.2 Renderer 错误处理

```typescript
// Service 层错误处理
async function startSession(params: StartSessionParams): Promise<string> {
  const result = await window.electron.cowork.startSession(params);

  if (!result.success) {
    throw new CoworkError(result.error.code, result.error.message);
  }

  return result.sessionId;
}
```

## 7. 性能考量

### 7.1 IPC 调用优化

- **批量操作**：合并多个 IPC 调用为一次（如 `deleteSessions`）
- **缓存数据**：减少重复 IPC 请求
- **异步处理**：避免阻塞 UI

### 7.2 流式事件频率控制

```typescript
// 限制流式更新频率
let lastUpdateTime = 0;
const MIN_UPDATE_INTERVAL = 50; // ms

function emitStreamMessageUpdate(sessionId, update) {
  const now = Date.now();
  if (now - lastUpdateTime < MIN_UPDATE_INTERVAL) {
    return; // 跳过高频更新
  }
  lastUpdateTime = now;

  win.webContents.send('cowork:stream:messageUpdate', update);
}
```

### 7.3 WebSocket 直连优化

v2026.6 引入的 `<justdo-chat>` Lit 渲染管道通过直接 Gateway WebSocket 连接渲染消息，相比 IPC 中继路径有以下优势：

- **更低延迟**：WebSocket 推送直接到达 Lit 组件，无需经过 `Main Process -> IPC -> Redux -> React re-render` 链路
- **减少主进程负载**：流式消息不再全部通过 IPC 转发
- **减少 React 重渲染**：Lit 使用原生 DOM 操作，不触发 React reconciliation
- **与 OpenClaw WebChat 共享代码**：相同的渲染管道和 Gateway 连接逻辑
