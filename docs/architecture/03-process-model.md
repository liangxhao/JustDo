# GucciAI 进程模型与 IPC 通信

## 1. Electron 进程模型

GucciAI 采用 Electron 的严格进程隔离架构，所有跨进程通信通过 IPC 实现。

### 1.1 三进程模型

```
┌─────────────────────────────────────────────────────────────┐
│                    Main Process (Node.js)                    │
│                                                             │
│  - 窗口生命周期管理                                           │
│  - SQLite 持久化                                             │
│  - OpenClaw Agent 引擎                                        │
│  - IM 网关（多平台 Bot 集成，规划中）                         │
│  - 40+ IPC 处理器                                             │
│  - 安全：context isolation 启用，node integration 禁用        │
│                                                             │
│  入口文件：src/main/main.ts                                  │
└─────────────────────────────────────────────────────────────┘
                              │
                              │ IPC (ipcMain.handle / ipcRenderer.invoke)
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                    Preload Script                            │
│                                                             │
│  - 通过 contextBridge 暴露 window.electron API               │
│  - 包含 cowork 命名空间（会话管理 + 流式事件）                 │
│                                                             │
│  入口文件：src/main/preload.ts                               │
└─────────────────────────────────────────────────────────────┘
                              │
                              │ contextBridge (安全桥接)
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                    Renderer Process (React)                  │
│                                                             │
│  - React 18 + Redux Toolkit + Tailwind CSS                  │
│  - 所有 UI 和业务逻辑                                         │
│  - 通过 IPC 与主进程通信                                      │
│                                                             │
│  入口文件：src/renderer/App.tsx                              │
└─────────────────────────────────────────────────────────────┘
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
    delete: (id: string) => ipcRenderer.invoke('skills:delete', id),
    getRoot: () => ipcRenderer.invoke('skills:getRoot'),
    autoRoutingPrompt: () => ipcRenderer.invoke('skills:autoRoutingPrompt'),
    getConfig: (skillId: string) => ipcRenderer.invoke('skills:getConfig', skillId),
    setConfig: (skillId: string, config: Record<string, string>) =>
      ipcRenderer.invoke('skills:setConfig', skillId, config),
    onChanged: (callback: () => void) => {
      const handler = () => callback();
      ipcRenderer.on('skills:changed', handler);
      return () => ipcRenderer.removeListener('skills:changed', handler);
    },
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
    onBridgeSyncStart: (callback: () => void) => { /* ... */ },
    onBridgeSyncDone: (callback: (data: { tools: number; error?: string }) => void) => { /* ... */ },
  },

  // 系统权限
  permissions: {
    checkCalendar: () => ipcRenderer.invoke('permissions:checkCalendar'),
    requestCalendar: () => ipcRenderer.invoke('permissions:requestCalendar'),
  },

  // 企业配置
  enterprise: {
    getConfig: () => ipcRenderer.invoke('enterprise:getConfig'),
  },

  // API 请求（含流式）
  api: {
    fetch: (options: { url: string; method: string; headers: Record<string, string>; body?: string }) =>
      ipcRenderer.invoke('api:fetch', options),
    stream: (options: { url: string; method: string; headers: Record<string, string>; body?: string; requestId: string }) =>
      ipcRenderer.invoke('api:stream', options),
    cancelStream: (requestId: string) => ipcRenderer.invoke('api:stream:cancel', requestId),
    onStreamData: (requestId: string, callback: (chunk: string) => void) => { /* ... */ },
    onStreamDone: (requestId: string, callback: () => void) => { /* ... */ },
    onStreamError: (requestId: string, callback: (error: string) => void) => { /* ... */ },
    onStreamAbort: (requestId: string, callback: () => void) => { /* ... */ },
  },

  // Cowork 会话
  cowork: {
    startSession: (options: {
      prompt: string;
      cwd?: string;
      systemPrompt?: string;
      activeSkillIds?: string[];
      agentId?: string;
      imageAttachments?: Array<{ name: string; mimeType: string; base64Data: string }>;
    }) => ipcRenderer.invoke('cowork:session:start', options),
    continueSession: (options: { sessionId: string; prompt: string; /* ... */ }) =>
      ipcRenderer.invoke('cowork:session:continue', options),
    stopSession: (sessionId: string) => ipcRenderer.invoke('cowork:session:stop', sessionId),
    deleteSession: (sessionId: string) => ipcRenderer.invoke('cowork:session:delete', sessionId),
    getSession: (sessionId: string) => ipcRenderer.invoke('cowork:session:get', sessionId),
    listSessions: (agentId?: string) => ipcRenderer.invoke('cowork:session:list', agentId),
    respondToPermission: (options: { requestId: string; result: any }) =>
      ipcRenderer.invoke('cowork:permission:respond', options),
    getConfig: () => ipcRenderer.invoke('cowork:config:get'),
    setConfig: (config: { workingDirectory?: string; executionMode?: string; /* ... */ }) =>
      ipcRenderer.invoke('cowork:config:set', config),
    
    // 记忆管理
    listMemoryEntries: (input: { query?: string; status?: string; /* ... */ }) =>
      ipcRenderer.invoke('cowork:memory:listEntries', input),
    createMemoryEntry: (input: { text: string; confidence?: number }) =>
      ipcRenderer.invoke('cowork:memory:createEntry', input),
    updateMemoryEntry: (input: { id: string; text?: string; /* ... */ }) =>
      ipcRenderer.invoke('cowork:memory:updateEntry', input),
    deleteMemoryEntry: (input: { id: string }) =>
      ipcRenderer.invoke('cowork:memory:deleteEntry', input),
    
    // 流式事件监听
    onStreamMessage: (callback: (data: { sessionId: string; message: any }) => void) => { /* ... */ },
    onStreamMessageUpdate: (callback: (data: { sessionId: string; messageId: string; content: string }) => void) => { /* ... */ },
    onStreamThinkingUpdate: (callback: (data: { sessionId: string; messageId: string; thinkingDelta: string }) => void) => { /* ... */ },
    onStreamMessageMetadataUpdate: (callback: (data: { sessionId: string; messageId: string; metadata: Record<string, unknown> }) => void) => { /* ... */ },
    onStreamPermission: (callback: (data: { sessionId: string; request: any }) => void) => { /* ... */ },
    onStreamComplete: (callback: (data: { sessionId: string; claudeSessionId: string | null }) => void) => { /* ... */ },
    onStreamError: (callback: (data: { sessionId: string; error: string }) => void) => { /* ... */ },
    onSessionsChanged: (callback: () => void) => { /* ... */ },
  },

  // 文件对话框
  dialog: {
    selectDirectory: () => ipcRenderer.invoke('dialog:selectDirectory'),
    selectFile: (options?: { title?: string; filters?: { name: string; extensions: string[] }[] }) =>
      ipcRenderer.invoke('dialog:selectFile', options),
    selectFiles: (options?: { /* ... */ }) => ipcRenderer.invoke('dialog:selectFiles', options),
    saveInlineFile: (options: { dataBase64: string; fileName?: string; mimeType?: string; cwd?: string }) =>
      ipcRenderer.invoke('dialog:saveInlineFile', options),
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
    onStatusUpdate: (callback: (data: any) => void) => { /* ... */ },
    onRunUpdate: (callback: (data: any) => void) => { /* ... */ },
  },
});
```

### 2.2 类型声明

为 Renderer 提供完整的 TypeScript 类型声明：

```typescript
// src/renderer/types/electron.d.ts
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
    delete: (id: string) => Promise<void>;
    getRoot: () => Promise<string>;
    autoRoutingPrompt: () => Promise<string>;
    getConfig: (skillId: string) => Promise<Record<string, string>>;
    setConfig: (skillId: string, config: Record<string, string>) => Promise<void>;
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
  
  enterprise: {
    getConfig: () => Promise<EnterpriseConfig>;
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
  
  cowork: {
    startSession: (options: StartSessionOptions) => Promise<{ sessionId: string }>;
    continueSession: (options: ContinueSessionOptions) => Promise<void>;
    stopSession: (sessionId: string) => Promise<void>;
    deleteSession: (sessionId: string) => Promise<void>;
    getSession: (sessionId: string) => Promise<Session | null>;
    listSessions: (agentId?: string) => Promise<Session[]>;
    respondToPermission: (options: { requestId: string; result: any }) => Promise<void>;
    getConfig: () => Promise<CoworkConfig>;
    setConfig: (config: CoworkConfigUpdate) => Promise<void>;
    listMemoryEntries: (input: MemoryListInput) => Promise<MemoryEntry[]>;
    createMemoryEntry: (input: { text: string; confidence?: number }) => Promise<MemoryEntry>;
    updateMemoryEntry: (input: MemoryUpdateInput) => Promise<void>;
    deleteMemoryEntry: (input: { id: string }) => Promise<void>;
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
  ipcMain.handle('skills:delete', handleSkillsDelete);
  ipcMain.handle('skills:getRoot', handleSkillsGetRoot);
  ipcMain.handle('skills:autoRoutingPrompt', handleSkillsAutoRoutingPrompt);
  ipcMain.handle('skills:getConfig', handleSkillsGetConfig);
  ipcMain.handle('skills:setConfig', handleSkillsSetConfig);

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
  ipcMain.handle('cowork:session:get', handleCoworkSessionGet);
  ipcMain.handle('cowork:session:list', handleCoworkSessionList);
  ipcMain.handle('cowork:permission:respond', handleCoworkPermissionRespond);

  // Cowork Config
  ipcMain.handle('cowork:config:get', handleCoworkConfigGet);
  ipcMain.handle('cowork:config:set', handleCoworkConfigSet);

  // Cowork Memory
  ipcMain.handle('cowork:memory:listEntries', handleCoworkMemoryListEntries);
  ipcMain.handle('cowork:memory:createEntry', handleCoworkMemoryCreateEntry);
  ipcMain.handle('cowork:memory:updateEntry', handleCoworkMemoryUpdateEntry);
  ipcMain.handle('cowork:memory:deleteEntry', handleCoworkMemoryDeleteEntry);
  ipcMain.handle('cowork:memory:getStats', handleCoworkMemoryGetStats);

  // Cowork Bootstrap Files
  ipcMain.handle('cowork:bootstrap:read', handleCoworkBootstrapRead);
  ipcMain.handle('cowork:bootstrap:write', handleCoworkBootstrapWrite);

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

  // Enterprise
  ipcMain.handle('enterprise:getConfig', handleEnterpriseGetConfig);
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

  // 2. 创建会话
  const sessionId = uuid();
  const workingDir = options.cwd || coworkStore.getConfig().workingDirectory;
  
  coworkStore.createSession(sessionId, {
    title: 'New Session',
    workingDirectory: workingDir,
    status: 'running',
    createdAt: Date.now(),
  });

  // 3. 添加用户消息
  coworkStore.addMessage(sessionId, {
    id: uuid(),
    type: 'user',
    content: options.prompt,
    timestamp: Date.now(),
  });

  // 4. 启动引擎执行
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

  window.electron.cowork.onStreamPermissionRequest((req) => {
    dispatch(coworkSlice.actions.setPermissionRequest(req));
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

### 4.3 清理监听器

```typescript
// 组件卸载时清理
useEffect(() => {
  setupStreamListeners(dispatch);
  return () => {
    window.electron.cowork.removeStreamListeners();
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

  // Cowork
  CoworkStartSession: 'cowork:startSession',
  CoworkContinueSession: 'cowork:continueSession',
  CoworkStopSession: 'cowork:stopSession',
  CoworkGetSession: 'cowork:getSession',
  CoworkListSessions: 'cowork:listSessions',
  CoworkDeleteSession: 'cowork:deleteSession',
  CoworkRespondToPermission: 'cowork:respondToPermission',
  CoworkGetConfig: 'cowork:getConfig',
  CoworkSetConfig: 'cowork:setConfig',

  // Stream Events
  CoworkStreamMessage: 'cowork:stream:message',
  CoworkStreamMessageUpdate: 'cowork:stream:messageUpdate',
  CoworkStreamPermissionRequest: 'cowork:stream:permissionRequest',
  CoworkStreamComplete: 'cowork:stream:complete',
  CoworkStreamError: 'cowork:stream:error',

  // OpenClaw Engine
  OpenClawEngineGetStatus: 'openclaw:engine:getStatus',
  OpenClawEngineStart: 'openclaw:engine:start',
  OpenClawEngineStop: 'openclaw:engine:stop',
  OpenClawEngineInstall: 'openclaw:engine:install',
  OpenClawEngineOnProgress: 'openclaw:engine:onProgress',
  OpenClawEngineOnStatusChange: 'openclaw:engine:onStatusChange',

  // IM（规划中）
  ImGetStatus: 'im:getStatus',
  ImGetConfig: 'im:getConfig',
  ImSetConfig: 'im:setConfig',
  // 多实例 channels（规划中）...

  // Agent
  AgentList: 'agent:list',
  AgentCreate: 'agent:create',
  AgentUpdate: 'agent:update',
  AgentDelete: 'agent:delete',
  AgentGetBindings: 'agent:getBindings',
  AgentSetBindings: 'agent:setBindings',

  // Scheduled Task
  ScheduledTaskList: 'scheduledTask:list',
  ScheduledTaskCreate: 'scheduledTask:create',
  ScheduledTaskUpdate: 'scheduledTask:update',
  ScheduledTaskDelete: 'scheduledTask:delete',
  ScheduledTaskGetMeta: 'scheduledTask:getMeta',
  ScheduledTaskSetMeta: 'scheduledTask:setMeta',
} as const;

export type IpcChannelName = typeof IpcChannel[keyof typeof IpcChannel];
```

### 5.2 使用规范

**正确用法**：使用常量

```typescript
// Main
ipcMain.handle(IpcChannel.CoworkStartSession, handler);

// Renderer
window.electron.cowork.startSession(params);
// 内部使用 ipcRenderer.invoke(IpcChannel.CoworkStartSession, params)
```

**错误用法**：裸字符串

```typescript
// 错误 - 不要这样做
ipcMain.handle('cowork:startSession', handler);
ipcRenderer.invoke('cowork:startSession', params);
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

- **批量操作**：合并多个 IPC 调用为一次
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