# JustDo 定时任务系统设计文档

**版本**: v2026.7.1

## 1. 概述

JustDo 定时任务系统是一套横跨 **Renderer(UI) → Main Process(IPC) → OpenClaw Gateway(调度引擎)** 三层的端到端自动化执行框架。用户可通过 UI 界面或对话创建定时任务，由 OpenClaw Cron 引擎调度触发，执行结果可推送到 IM 平台或 Webhook。

### 1.1 核心设计理念

| 理念 | 说明 |
|------|------|
| **OpenClaw 驱动** | 所有调度、执行、投递由 OpenClaw Gateway 原生完成，JustDo 仅负责任务 CRUD 和 UI 展示 |
| **策略模式 (Policy Pattern)** | 不同来源的任务各自拥有独立策略类，控制默认参数、绑定关系、只读字段 |
| **来源推断 (Origin Inference)** | 通过 `sessionKey` 格式反向推断任务来源，实现与旧数据无缝兼容 |
| **流式轮询** | 15 秒间隔轮询机制将 OpenClaw 状态变化实时推送到 UI |

### 1.2 系统架构

```
┌─────────────────────────────────────────────────────────────┐
│                     Renderer Process                         │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────┐  │
│  │   CronView      │  │  TaskRunHistory │  │ RunSession  │  │
│  │   (TaskForm)    │  │                 │  │ Modal       │  │
│  └─────────────────┘  └─────────────────┘  └─────────────┘  │
│                                                             │
│  ┌─────────────────────────────────────────────────────┐    │
│  │        ScheduledTaskService (IPC 封装)               │    │
│  │        scheduledTaskSlice (Redux Store)              │    │
│  └─────────────────────────────────────────────────────┘    │
├─────────────────────────────────────────────────────────────┤
│                     Main Process                             │
│  ┌─────────────────────────────────────────────────────┐    │
│  │   IPC Handlers (scheduledTask:* 通道)               │    │
│  │   CronJobService (Gateway RPC 适配器)               │    │
│  └─────────────────────────────────────────────────────┘    │
│                                                             │
│  ┌─────────────────────────────────────────────────────┐    │
│  │   TaskModelMapper / TaskPolicyRegistry               │    │
│  │   inferOriginAndBinding / enginePrompt               │    │
│  └─────────────────────────────────────────────────────┘    │
├─────────────────────────────────────────────────────────────┤
│                     OpenClaw Gateway                         │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────┐  │
│  │  Cron Scheduler │  │  Agent Executor │  │ Delivery    │  │
│  │  (调度引擎)     │  │  (会话执行)     │  │ (消息投递)  │  │
│  └─────────────────┘  └─────────────────┘  └─────────────┘  │
│                                                             │
│  ┌─────────────────────────────────────────────────────┐    │
│  │   Channel Adapters (Telegram / Discord / Webhook)   │    │
│  └─────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────┘
```

---

## 2. 类型系统

### 2.1 常量定义

**文件**: `src/scheduledTask/constants.ts`

```typescript
// 调度类型
export const ScheduleKind = {
  At: 'at',           // 一次性任务
  Every: 'every',     // 固定间隔
  Cron: 'cron',       // Cron 表达式
} as const;

// Payload 类型
export const PayloadKind = {
  AgentTurn: 'agentTurn',    // Agent 对话轮次
  SystemEvent: 'systemEvent', // 系统事件注入
} as const;

// 投递模式
export const DeliveryMode = {
  None: 'none',          // 不投递
  Announce: 'announce',  // IM 通道投递
  Webhook: 'webhook',    // HTTP POST 投递
} as const;

// 会话目标
export const SessionTarget = {
  Main: 'main',            // 在主会话中执行
  Isolated: 'isolated',    // 创建隔离会话
} as const;

// 唤醒模式
export const WakeMode = {
  Now: 'now',                     // 立即触发
  NextHeartbeat: 'next-heartbeat', // 等待下次心跳
} as const;

// 任务来源类型
export const OriginKind = {
  Legacy: 'legacy',    // 旧版任务
  IM: 'im',            // IM 创建
  Cowork: 'cowork',    // Cowork 会话创建
  Cron: 'cron',        // Cron 系统创建
  Manual: 'manual',    // UI 手动创建
} as const;

// 执行绑定类型
export const BindingKind = {
  NewSession: 'new_session',    // 每次创建新会话
  UISession: 'ui_session',      // 绑定 UI 会话
  IMSession: 'im_session',      // 绑定 IM 会话
  SessionKey: 'session_key',    // 使用显式 sessionKey
} as const;

// 任务状态
export const TaskStatus = {
  Success: 'success',
  Error: 'error',
  Skipped: 'skipped',
  Running: 'running',
} as const;
```

### 2.2 IPC 通道定义

```typescript
export const IpcChannel = {
  // CRUD 操作
  List: 'scheduledTask:list',
  Get: 'scheduledTask:get',
  Create: 'scheduledTask:create',
  Update: 'scheduledTask:update',
  Delete: 'scheduledTask:delete',
  Toggle: 'scheduledTask:toggle',

  // 执行控制
  RunManually: 'scheduledTask:runManually',
  Stop: 'scheduledTask:stop',

  // 运行历史
  ListRuns: 'scheduledTask:listRuns',
  CountRuns: 'scheduledTask:countRuns',
  ListAllRuns: 'scheduledTask:listAllRuns',
  ResolveSession: 'scheduledTask:resolveSession',

  // 通道查询
  ListChannels: 'scheduledTask:listChannels',
  ListChannelConversations: 'scheduledTask:listChannelConversations',

  // 状态推送
  StatusUpdate: 'scheduledTask:statusUpdate',  // 任务状态变更
  RunUpdate: 'scheduledTask:runUpdate',        // 运行记录更新
  Refresh: 'scheduledTask:refresh',            // 全量刷新信号
} as const;
```

### 2.3 核心类型

**文件**: `src/scheduledTask/types.ts`

```typescript
// 调度配置
export type Schedule =
  | { kind: 'at'; at: string }                                    // ISO 8601
  | { kind: 'every'; everyMs: number; anchorMs?: number }         // 固定间隔
  | { kind: 'cron'; expr: string; tz?: string; staggerMs?: number }; // Cron 表达式

// 执行内容
export type ScheduledTaskPayload =
  | { kind: 'agentTurn'; message: string; timeoutSeconds?: number; model?: string }
  | { kind: 'systemEvent'; text: string };

// 投递配置
export interface ScheduledTaskDelivery {
  mode: DeliveryMode;
  channel?: string;
  to?: string;
  accountId?: string;
  bestEffort?: boolean;
}

// 任务状态
export interface TaskState {
  nextRunAtMs: number | null;
  lastRunAtMs: number | null;
  lastStatus: TaskLastStatus;
  lastError: string | null;
  lastDurationMs: number | null;
  runningAtMs: number | null;
  consecutiveErrors: number;
}

// 任务定义
export interface ScheduledTask {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  schedule: Schedule;
  sessionTarget: SessionTarget;
  wakeMode: WakeMode;
  payload: ScheduledTaskPayload;
  delivery: ScheduledTaskDelivery;
  agentId: string | null;
  sessionKey: string | null;
  state: TaskState;
  createdAt: string;
  updatedAt: string;
}
```

---

## 3. 来源与绑定推断

### 3.1 TaskOrigin -- 任务来源

**文件**: `src/scheduledTask/origin.ts`

```typescript
export type TaskOrigin =
  | { kind: 'legacy' }
  | { kind: 'im'; platform: string; conversationId: string }
  | { kind: 'cowork'; sessionId: string }
  | { kind: 'cron'; jobId: string }
  | { kind: 'manual' };
```

### 3.2 ExecutionBinding -- 执行绑定

```typescript
export type ExecutionBinding =
  | { kind: 'new_session' }
  | { kind: 'ui_session'; sessionId: string }
  | { kind: 'im_session'; platform: string; conversationId: string; sessionId?: string }
  | { kind: 'session_key'; sessionKey: string };
```

### 3.3 inferOriginAndBinding -- 反向推断函数

通过解析 `sessionKey` 格式反向推断来源和绑定：

```typescript
export function inferOriginAndBinding(task: InferableTask): {
  origin: TaskOrigin;
  binding: ExecutionBinding;
} {
  const sk = (task.sessionKey ?? '').trim();

  // 1. Managed session key: "agent:main:justdo:{sessionId}"
  if (sk && isManagedSessionKey(sk)) {
    const parsed = parseManagedSessionKey(sk);
    if (parsed) {
      const isIMChannel = task.delivery?.mode === 'announce'
        && task.delivery?.channel && task.delivery.channel !== 'last';
      if (isIMChannel) {
        return {
          origin: { kind: 'im', platform: task.delivery.channel, conversationId: '' },
          binding: { kind: 'im_session', platform: task.delivery.channel, conversationId: '', sessionId: parsed.sessionId },
        };
      }
      return {
        origin: { kind: 'cowork', sessionId: parsed.sessionId },
        binding: { kind: 'ui_session', sessionId: parsed.sessionId },
      };
    }
  }

  // 2. Cron session key: "cron:{jobId}"
  if (sk && isCronSessionKey(sk)) {
    const jobId = sk.slice(sk.lastIndexOf('cron:') + 'cron:'.length);
    return { origin: { kind: 'cron', jobId }, binding: { kind: 'session_key', sessionKey: sk } };
  }

  // 3. Unknown sessionKey → session_key binding
  if (sk) {
    return { origin: { kind: 'cowork', sessionId: '' }, binding: { kind: 'session_key', sessionKey: sk } };
  }

  // 4. No sessionKey → manual origin
  return { origin: { kind: 'manual' }, binding: { kind: 'new_session' } };
}
```

### 3.4 SessionKey 格式

| 类型 | 格式 | 示例 |
|------|------|------|
| 托管会话 | `agent:main:justdo:{sessionId}` | `agent:main:justdo:abc123` |
| 通道会话 | `agent:{agentId}:{platform}:{subtype}:{conversationId}` | `agent:main:telegram:direct:ou_xxx` |
| Cron 会话 | `cron:{jobId}` | `cron:job-456` |

---

## 4. 策略模式 (Policy Pattern)

### 4.1 TaskPolicy 接口

**文件**: `src/scheduledTask/policies/types.ts`

```typescript
export interface TaskPolicy {
  readonly kind: TaskOrigin['kind'];

  /** 返回该来源任务的默认参数 */
  getCreateDefaults(origin: TaskOrigin): Partial<PolicyTaskInput>;

  /** 保存前的归一化校验 */
  normalizeDraft(draft: PolicyTaskModel): PolicyTaskModel;

  /** 投递配置变更时联动更新绑定关系 */
  onDeliveryChanged(draft: PolicyTaskModel, newDelivery: PolicyDelivery): PolicyTaskModel;

  /** 将 ExecutionBinding 映射为 sessionTarget/sessionKey */
  toWireBinding(binding: ExecutionBinding): WireBinding;

  /** 生成人类可读的运行行为描述 */
  describeRunBehavior(task: PolicyTaskModel): string;

  /** 返回 UI 中不可编辑的字段列表 */
  getReadonlyFields(): string[];
}
```

### 4.2 四种策略实现

| 策略类 | 文件 | 来源类型 | 默认 sessionTarget | 默认 wakeMode | 默认 delivery | 只读字段 |
|--------|------|----------|-------------------|---------------|--------------|---------|
| `ManualTaskPolicy` | `manualPolicy.ts` | `manual` | `isolated` | `now` | `announce` + `last` | 无 |
| `IMTaskPolicy` | `imPolicy.ts` | `im` | `main` | `now` | `announce` + 来源平台 | `origin` |
| `CoworkTaskPolicy` | `coworkPolicy.ts` | `cowork` | `main` | `now` | `announce` + `last` | `origin` |
| `LegacyTaskPolicy` | `legacyPolicy.ts` | `legacy` | `main` | `next-heartbeat` | 无 | `origin` |

### 4.3 TaskPolicyRegistry

**文件**: `src/scheduledTask/policies/registry.ts`

```typescript
export class TaskPolicyRegistry {
  private readonly policies: Map<string, TaskPolicy>;

  constructor(policies: TaskPolicy[]) {
    this.policies = new Map(policies.map(p => [p.kind, p]));
  }

  get(origin: TaskOrigin): TaskPolicy {
    return this.policies.get(origin.kind) ?? this.policies.get(OriginKind.Manual)!;
  }
}

export const taskPolicyRegistry = new TaskPolicyRegistry([
  new LegacyTaskPolicy(),
  new IMTaskPolicy(),
  new CoworkTaskPolicy(),
  new ManualTaskPolicy(),
]);
```

---

## 5. TaskModelMapper

**文件**: `src/scheduledTask/modelMapper.ts`

负责 **线格式 (Wire Format)** 与 **领域模型 (Domain Model)** 之间的双向转换：

```typescript
export class TaskModelMapper {
  /** 从 IPC 数据还原领域模型（含 origin + binding） */
  fromWire(wire: WireTask, meta?: { origin: TaskOrigin; binding: ExecutionBinding }): PolicyTaskModel

  /** 保存时转为 IPC 格式 */
  toWireInput(model: PolicyTaskModel, policy: TaskPolicy): PolicyTaskInput

  /** 创建空白草稿 */
  createDraft(origin: TaskOrigin, defaults: Partial<PolicyTaskInput>): PolicyTaskModel
}
```

---

## 6. IPC 通信设计

### 6.1 Handler 注册

**文件**: `src/main/ipcHandlers/scheduledTask/handlers.ts`

IPC Handlers 在 Main Process 启动时注册：

```typescript
export function registerScheduledTaskHandlers(deps: ScheduledTaskHandlerDeps): void {
  const { getCronJobService, getOpenClawRuntimeAdapter } = deps;

  // 列出所有任务
  ipcMain.handle(ScheduledTaskIpc.List, async () => {
    if (!getOpenClawRuntimeAdapter()?.getGatewayClient()) {
      return { success: true, tasks: [] };  // Gateway 未就绪时返回空列表
    }
    const tasks = await getCronJobService().listJobs();
    return { success: true, tasks };
  });

  // 获取单个任务
  ipcMain.handle(ScheduledTaskIpc.Get, async (_event, id) => {
    const task = await getCronJobService().getJob(id);
    return { success: true, task };
  });

  // 创建任务
  ipcMain.handle(ScheduledTaskIpc.Create, async (_event, input) => {
    const task = await getCronJobService().addJob(input);
    return { success: true, task };
  });

  // 更新任务
  ipcMain.handle(ScheduledTaskIpc.Update, async (_event, id, input) => {
    const task = await getCronJobService().updateJob(id, input);
    return { success: true, task };
  });

  // 手动触发执行
  ipcMain.handle(ScheduledTaskIpc.RunManually, async (_event, id) => {
    await getCronJobService().runJob(id);
    return { success: true };
  });

  // 切换启用/禁用
  ipcMain.handle(ScheduledTaskIpc.Toggle, async (_event, id, enabled) => {
    const task = await getCronJobService().toggleJob(id, enabled);
    return { success: true, task };
  });

  // 删除任务
  ipcMain.handle(ScheduledTaskIpc.Delete, async (_event, id) => {
    await getCronJobService().removeJob(id);
    return { success: true };
  });

  // 列出运行历史
  ipcMain.handle(ScheduledTaskIpc.ListRuns, async (_event, jobId, limit, offset) => {
    const runs = await getCronJobService().listRuns(jobId, limit, offset);
    return { success: true, runs };
  });

  // 查询运行记录数
  ipcMain.handle(ScheduledTaskIpc.CountRuns, async (_event, jobId) => {
    const count = await getCronJobService().countRuns(jobId);
    return { success: true, count };
  });

  // 列出全部运行历史
  ipcMain.handle(ScheduledTaskIpc.ListAllRuns, async (_event, limit, offset) => {
    const runs = await getCronJobService().listAllRuns(limit, offset);
    return { success: true, runs };
  });

  // 解析会话
  ipcMain.handle(ScheduledTaskIpc.ResolveSession, async (_event, sessionKey) => {
    const session = await getOpenClawRuntimeAdapter()?.fetchSessionByKey(sessionKey);
    return { success: true, session };
  });

  // 列出可用通道
  ipcMain.handle(ScheduledTaskIpc.ListChannels, async () => {
    const channels = listScheduledTaskChannels();
    return { success: true, channels };
  });

  // 列出通道会话
  ipcMain.handle(ScheduledTaskIpc.ListChannelConversations, async (_event, accountId, channel) => {
    const conversations = await getCronJobService().listChannelConversations(accountId, channel);
    return { success: true, conversations };
  });
}
```

### 6.2 Handler 管理

**文件**: `src/main/ipcHandlers/scheduledTask/index.ts` — 导出入口

```typescript
export type { CronJobServiceDeps } from './cronJobServiceManager';
export { getCronJobService, initCronJobServiceManager } from './cronJobServiceManager';
export type { ScheduledTaskHandlerDeps } from './handlers';
export { registerScheduledTaskHandlers } from './handlers';
export type { ScheduledTaskHelperDeps } from './helpers';
export { initScheduledTaskHelpers, listScheduledTaskChannels } from './helpers';
```

---

## 7. CronJobService -- Gateway 适配器

### 7.1 职责

**文件**: `src/scheduledTask/cronJobService.ts`

`CronJobService` 是 JustDo 与 OpenClaw Gateway 之间的适配器层，封装所有 Cron RPC 调用：

| CronJobService 方法 | Gateway RPC | 说明 |
|---------------------|------------|------|
| `addJob()` | `cron.add` | 创建 Cron Job |
| `getJob()` | `cron.get` | 获取单个 Job |
| `updateJob()` | `cron.update` | 更新 Cron Job (patch 模式) |
| `removeJob()` | `cron.remove` | 删除 Cron Job |
| `toggleJob()` | `cron.update` | 更新 enabled 字段 |
| `runJob()` | `cron.run` | 立即触发执行 |
| `listJobs()` | `cron.list` | 列出所有 Job |
| `listRuns()` | `cron.runs` | 查询运行历史 |
| `listAllRuns()` | `cron.runs` | 查询全局运行历史 |

### 7.2 轮询机制

```typescript
export class CronJobService {
  private pollingTimer: ReturnType<typeof setInterval> | null = null;
  private static readonly POLL_INTERVAL_MS = 15_000;  // 15 秒

  startPolling(): void { /* 启动 15 秒轮询 */ }
  stopPolling(): void { /* 停止轮询 */ }

  private async pollOnce(): Promise<void> {
    // 1. 获取所有任务状态
    const result = await client.request<{ jobs?: GatewayJob[] }>('cron.list', {
      includeDisabled: true, limit: 200,
    });

    // 2. 更新 jobId → name 缓存
    // 3. 检测状态变更并推送 (statusUpdate)
    // 4. 检测新运行记录并推送 (runUpdate)
    // 5. 首次轮询发送全量刷新信号 (refresh)
  }
}
```

---

## 8. OpenClaw Cron 调度引擎

### 8.1 Gateway Job 数据模型

```typescript
interface GatewayJob {
  id: string;
  name: string;
  description?: string;
  enabled: boolean;
  schedule: GatewaySchedule;    // at | every | cron
  sessionTarget: 'main' | 'isolated';
  wakeMode: 'now' | 'next-heartbeat';
  payload: GatewayPayload;     // systemEvent | agentTurn
  delivery?: GatewayDelivery;  // announce | webhook | none
  agentId?: string | null;
  sessionKey?: string | null;
  deleteAfterRun?: boolean;
  state: GatewayJobState;
  createdAtMs: number;
  updatedAtMs: number;
}
```

### 8.2 执行路径

| sessionTarget | 执行路径 | 说明 |
|---------------|---------|------|
| `main` | 主会话路径 | 将 `systemEvent` 注入主会话时间线，按 `wakeMode` 触发 Agent |
| `isolated` | 隔离会话路径 | 创建独立会话 `cron:{jobId}`，Agent 在独立上下文执行 |

### 8.3 投递流程 (Announce)

当任务完成且 `delivery.mode = 'announce'` 时:

1. **Channel 路由**: 根据 `delivery.channel` 选择 Channel Adapter (Telegram/Discord)
2. **目标解析**: `delivery.to` 指定接收者
3. **消息分块**: 长消息自动分块适配平台限制
4. **去重检查**: 跳过已发送的重复消息
5. **心跳过滤**: 纯心跳响应不投递

### 8.4 重试策略

| 任务类型 | 重试次数 | 退避策略 | 失败后行为 |
|---------|---------|---------|-----------|
| 一次性 (`at`) | 最多 3 次 | 30s → 1m → 5m | 禁用或删除 |
| 循环 (`cron`/`every`) | 不限次 | 30s → 1m → 5m → 15m → 60m | 保持启用 |

---

## 9. Engine Prompt

**文件**: `src/scheduledTask/enginePrompt.ts`

定义 Agent 在 OpenClaw 引擎下如何处理定时任务请求：

```typescript
export function buildScheduledTaskEnginePrompt(): string {
  return [
    '## Scheduled Tasks',
    '- Use the native `cron` tool for any scheduled task creation or management request.',
    '- For scheduled-task creation, call native `cron` with `action: "add"` / `cron.add`.',
    '- Prefer the active conversation context when the user wants scheduled replies.',
    '- When `cron.add` includes any channel delivery config, you MUST set `sessionTarget: "isolated"`.',
    '- For one-time reminders (`schedule.kind: "at"`), send a future ISO timestamp with timezone offset.',
    '- Do not use wrapper payloads or channel-specific relay formats for reminders.',
    '- Never emulate reminders with Bash, `sleep`, background jobs, or manual process management.',
    '',
    '### Message delivery in scheduled-task sessions',
    '- When running in a scheduled-task session, do NOT call `message` tool directly.',
    '- The cron system handles result delivery automatically based on delivery config.',
    '- Output results as plain text; the cron system will forward if delivery is configured.',
  ].join('\n');
}
```

---

## 10. 完整生命周期示例

### 10.1 UI 创建 + Telegram 投递

```
User → TaskForm: 填写表单，每天 9:00 / announce / telegram
TaskForm → ScheduledTaskService: createTask(input)
ScheduledTaskService → IPC: invoke 'scheduledTask:create'
IPC → CronJobService: addJob(input)
CronJobService → Gateway: cron.add({ schedule, payload, delivery })
Gateway → CronJobService: GatewayJob
CronJobService → IPC: ScheduledTask
IPC → ScheduledTaskService: { success: true, task }
ScheduledTaskService → TaskForm: dispatch(addTask)

--- 每天 9:00 触发 ---
Gateway: 创建隔离会话 cron:{jobId}
Gateway: Agent 执行 payload
Gateway → Telegram: announce 投递
Telegram → User: Telegram API sendMessage

--- 轮询检测 ---
CronJobService → Gateway: cron.list (15s)
Gateway → CronJobService: 状态已变更
CronJobService → UI: statusUpdate event
```

### 10.2 对话中创建定时提醒

```
User → Chat: "明天上午9点提醒我查收邮件"
Chat → Agent (OpenClaw): 用户消息
Agent: 解析意图 → cron.add({ schedule: 'at', payload: '提醒：查收邮件' })
Agent → Chat: "好的，已设置好提醒！明天 09:00 会提醒你..."

--- 次日 9:00 触发 ---
Gateway: 创建隔离会话 + 执行
Gateway → User: 投递提醒消息
```

---

## 11. 关键文件清单

| 文件 | 职责 |
|------|------|
| `src/scheduledTask/constants.ts` | 常量定义 (ScheduleKind, PayloadKind, DeliveryMode, IPC 通道等) |
| `src/scheduledTask/types.ts` | 核心类型定义 (ScheduledTask, Schedule, Payload, Delivery, TaskState) |
| `src/scheduledTask/origin.ts` | 来源与绑定推断 (TaskOrigin, ExecutionBinding, inferOriginAndBinding) |
| `src/scheduledTask/modelMapper.ts` | Wire ↔ Domain 模型转换 |
| `src/scheduledTask/cronJobService.ts` | Gateway 适配器 (RPC 封装 + 轮询) |
| `src/scheduledTask/enginePrompt.ts` | Agent 行为提示词 |
| `src/scheduledTask/metaStore.ts` | 元数据存储（配置持久化） |
| `src/scheduledTask/migrate.ts` | 旧任务格式迁移 |
| `src/scheduledTask/reminderText.ts` | 提醒消息文本格式化 |
| `src/scheduledTask/policies/types.ts` | TaskPolicy 接口定义 |
| `src/scheduledTask/policies/manualPolicy.ts` | UI 手动创建策略 |
| `src/scheduledTask/policies/imPolicy.ts` | IM 创建策略（IM 集成开发中） |
| `src/scheduledTask/policies/coworkPolicy.ts` | Cowork 创建策略 |
| `src/scheduledTask/policies/legacyPolicy.ts` | 旧版任务兼容策略 |
| `src/scheduledTask/policies/registry.ts` | 策略注册表 |
| `src/main/ipcHandlers/scheduledTask/handlers.ts` | IPC Handler 实现 |
| `src/main/ipcHandlers/scheduledTask/helpers.ts` | 辅助函数 (通道列表) |
| `src/main/ipcHandlers/scheduledTask/cronJobServiceManager.ts` | CronJobService 管理器 |
| `src/main/ipcHandlers/scheduledTask/index.ts` | Handler 导出入口 |
| `src/renderer/services/scheduledTask.ts` | Renderer IPC 封装 |
| `src/renderer/components/scheduledTasks/CronView.tsx` | 任务主视图（含 TaskForm, TaskList） |
| `src/renderer/components/scheduledTasks/TaskRunHistory.tsx` | 任务运行历史 |
| `src/renderer/components/scheduledTasks/RunSessionModal.tsx` | 运行结果会话 Modal |
| `src/renderer/components/scheduledTasks/utils.ts` | UI 工具函数 |

---

## 12. 设计决策总结

| 决策 | 理由 |
|------|------|
| 策略模式区分任务来源 | 不同来源的默认参数、绑定关系、只读字段各不相同，策略模式避免了大量 if-else |
| 来源推断而非存储 | 通过 sessionKey 格式反推来源，无需修改 OpenClaw 数据模型即可兼容旧数据 |
| 15 秒轮询而非 WebSocket | OpenClaw Gateway 不暴露实时事件流，轮询是简单可靠的状态同步方式 |
| `isolated` + `announce` 作为 IM 投递标准模式 | 隔离会话避免污染主聊天记录，announce 模式让 OpenClaw 原生处理消息投递 |
| IM 投递策略已定义但 IM 集成开发中 | `IMTaskPolicy`、`listChannels` 等基础设施已就位，IM 通道的完整集成仍在进行中 |
