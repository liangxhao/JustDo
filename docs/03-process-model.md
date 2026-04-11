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
  // 存储
  store: {
    get: (key: string) => ipcRenderer.invoke('store:get', key),
    set: (key: string, value: unknown) => ipcRenderer.invoke('store:set', key, value),
    delete: (key: string) => ipcRenderer.invoke('store:delete', key),
  },

  // Cowork 会话
  cowork: {
    startSession: (params: StartSessionParams) => 
      ipcRenderer.invoke('cowork:startSession', params),
    continueSession: (params: ContinueSessionParams) => 
      ipcRenderer.invoke('cowork:continueSession', params),
    stopSession: (sessionId: string) => 
      ipcRenderer.invoke('cowork:stopSession', sessionId),
    getSession: (sessionId: string) => 
      ipcRenderer.invoke('cowork:getSession', sessionId),
    listSessions: () => 
      ipcRenderer.invoke('cowork:listSessions'),
    deleteSession: (sessionId: string) => 
      ipcRenderer.invoke('cowork:deleteSession', sessionId),
    respondToPermission: (params: PermissionResponseParams) => 
      ipcRenderer.invoke('cowork:respondToPermission', params),
    getConfig: () => 
      ipcRenderer.invoke('cowork:getConfig'),
    setConfig: (config: CoworkConfig) => 
      ipcRenderer.invoke('cowork:setConfig', config),
    
    // 流式事件监听
    onStreamMessage: (callback: (msg: CoworkMessage) => void) => 
      ipcRenderer.on('cowork:stream:message', (_, msg) => callback(msg)),
    onStreamMessageUpdate: (callback: (update: MessageUpdate) => void) => 
      ipcRenderer.on('cowork:stream:messageUpdate', (_, update) => callback(update)),
    onStreamPermissionRequest: (callback: (req: PermissionRequest) => void) => 
      ipcRenderer.on('cowork:stream:permissionRequest', (_, req) => callback(req)),
    onStreamComplete: (callback: (result: SessionComplete) => void) => 
      ipcRenderer.on('cowork:stream:complete', (_, result) => callback(result)),
    onStreamError: (callback: (error: SessionError) => void) => 
      ipcRenderer.on('cowork:stream:error', (_, error) => callback(error)),
    removeStreamListeners: () => {
      ipcRenderer.removeAllListeners('cowork:stream:message');
      ipcRenderer.removeAllListeners('cowork:stream:messageUpdate');
      // ...
    },
  },

  // OpenClaw 引擎
  openclaw: {
    engine: {
      getStatus: () => ipcRenderer.invoke('openclaw:engine:getStatus'),
      start: () => ipcRenderer.invoke('openclaw:engine:start'),
      stop: () => ipcRenderer.invoke('openclaw:engine:stop'),
      install: () => ipcRenderer.invoke('openclaw:engine:install'),
      onProgress: (callback: (progress: InstallProgress) => void) => 
        ipcRenderer.on('openclaw:engine:onProgress', (_, progress) => callback(progress)),
      onStatusChange: (callback: (status: EngineStatus) => void) => 
        ipcRenderer.on('openclaw:engine:onStatusChange', (_, status) => callback(status)),
    },
  },

  // IM 集成（规划中）
  im: {
    getStatus: () => ipcRenderer.invoke('im:getStatus'),
    getConfig: () => ipcRenderer.invoke('im:getConfig'),
    setConfig: (config: IMConfig) => ipcRenderer.invoke('im:setConfig', config),
    // 多实例管理（规划中）
  },

  // Agent 管理
  agent: {
    list: () => ipcRenderer.invoke('agent:list'),
    create: (config: AgentConfig) => ipcRenderer.invoke('agent:create', config),
    update: (id: string, config: AgentConfig) => ipcRenderer.invoke('agent:update', id, config),
    delete: (id: string) => ipcRenderer.invoke('agent:delete', id),
    getBindings: (id: string) => ipcRenderer.invoke('agent:getBindings', id),
    setBindings: (id: string, bindings: PlatformBinding[]) => 
      ipcRenderer.invoke('agent:setBindings', id, bindings),
  },

  // 定时任务
  scheduledTask: {
    list: () => ipcRenderer.invoke('scheduledTask:list'),
    create: (task: ScheduledTaskParams) => ipcRenderer.invoke('scheduledTask:create', task),
    update: (id: string, task: ScheduledTaskParams) => 
      ipcRenderer.invoke('scheduledTask:update', id, task),
    delete: (id: string) => ipcRenderer.invoke('scheduledTask:delete', id),
    getMeta: (id: string) => ipcRenderer.invoke('scheduledTask:getMeta', id),
    setMeta: (id: string, meta: ScheduledTaskMeta) => 
      ipcRenderer.invoke('scheduledTask:setMeta', id, meta),
  },

  // 快捷键
  shortcut: {
    register: (accelerator: string, callback: () => void) => 
      ipcRenderer.invoke('shortcut:register', accelerator),
    unregister: (accelerator: string) => 
      ipcRenderer.invoke('shortcut:unregister', accelerator),
  },

  // 系统信息
  platform: process.platform,
  appVersion: app.getVersion(),
});
```

### 2.2 类型声明

为 Renderer 提供完整的 TypeScript 类型声明：

```typescript
// src/renderer/types/electron.d.ts
interface ElectronAPI {
  store: {
    get: (key: string) => Promise<unknown>;
    set: (key: string, value: unknown) => Promise<void>;
    delete: (key: string) => Promise<void>;
  };
  cowork: {
    startSession: (params: StartSessionParams) => Promise<{ sessionId: string }>;
    // ...
  };
  // ...
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
  // Cowork
  ipcMain.handle('cowork:startSession', handleStartSession);
  ipcMain.handle('cowork:continueSession', handleContinueSession);
  ipcMain.handle('cowork:stopSession', handleStopSession);
  ipcMain.handle('cowork:getSession', handleGetSession);
  ipcMain.handle('cowork:listSessions', handleListSessions);
  ipcMain.handle('cowork:deleteSession', handleDeleteSession);
  ipcMain.handle('cowork:respondToPermission', handleRespondToPermission);
  ipcMain.handle('cowork:getConfig', handleGetCoworkConfig);
  ipcMain.handle('cowork:setConfig', handleSetCoworkConfig);

  // OpenClaw Engine
  ipcMain.handle('openclaw:engine:getStatus', handleEngineGetStatus);
  ipcMain.handle('openclaw:engine:start', handleEngineStart);
  ipcMain.handle('openclaw:engine:stop', handleEngineStop);
  ipcMain.handle('openclaw:engine:install', handleEngineInstall);

  // IM（规划中）
  ipcMain.handle('im:getStatus', handleImGetStatus);
  ipcMain.handle('im:getConfig', handleImGetConfig);
  ipcMain.handle('im:setConfig', handleImSetConfig);
  // 多实例 handlers（规划中）...

  // Agent
  ipcMain.handle('agent:list', handleAgentList);
  ipcMain.handle('agent:create', handleAgentCreate);
  ipcMain.handle('agent:update', handleAgentUpdate);
  ipcMain.handle('agent:delete', handleAgentDelete);
  ipcMain.handle('agent:getBindings', handleAgentGetBindings);
  ipcMain.handle('agent:setBindings', handleAgentSetBindings);

  // Scheduled Task
  ipcMain.handle('scheduledTask:list', handleScheduledTaskList);
  ipcMain.handle('scheduledTask:create', handleScheduledTaskCreate);
  // ...

  // Store
  ipcMain.handle('store:get', handleStoreGet);
  ipcMain.handle('store:set', handleStoreSet);
  ipcMain.handle('store:delete', handleStoreDelete);
}
```

### 3.2 Handler 实现示例

```typescript
// Cowork Session Handler
async function handleStartSession(
  event: IpcMainInvokeEvent,
  params: StartSessionParams
): Promise<{ sessionId: string; status: string }> {
  // 1. 检查引擎状态
  const engineStatus = openclawEngineManager.getStatus();
  if (engineStatus.phase !== 'running') {
    // 尝试启动引擎
    await openclawEngineManager.ensureOpenClawRunningForCowork();
  }

  // 2. 创建会话
  const sessionId = uuid();
  const workingDir = params.workingDirectory || coworkStore.getConfig().workingDirectory;
  
  coworkStore.createSession(sessionId, {
    title: params.title || 'New Session',
    workingDirectory: workingDir,
    status: 'running',
    createdAt: Date.now(),
  });

  // 3. 添加用户消息
  coworkStore.addMessage(sessionId, {
    id: uuid(),
    type: 'user',
    content: params.prompt,
    timestamp: Date.now(),
  });

  // 4. 启动引擎执行
  const router = new CoworkEngineRouter(coworkStore, openclawEngineManager);
  router.startSession(sessionId, params.prompt);

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