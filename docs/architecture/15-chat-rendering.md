# JustDo 消息渲染系统（Lit 管线）

## 1. 概述

v2026.6.25 中，JustDo 的消息显示系统已完成彻底重写。原有的 `CoworkSessionDetail.tsx`（3800+ 行）已被 OpenClaw webchat 的 Lit 渲染管线完全替代。

### 1.1 设计动机

原有 React 消息组件长期存在消息重复、截断、丢失等问题。经过多次修复未果，决定彻底重写，采用与 OpenClaw webchat 完全一致的 Lit 渲染管线。

### 1.2 最终方案

Lit 自定义元素 `<justdo-chat>` 嵌入 React，直接连接 OpenClaw Gateway WebSocket——与 webchat 完全一致的对接方式。

### 1.3 关键变更

- 废弃 `CoworkSessionDetail.tsx`（3800+ 行）
- 移除 Redux 驱动的消息状态管理
- 移除 IPC 消息传递路径
- Lit 自定义元素直接连接 Gateway WebSocket
- 消息渲染管线与 OpenClaw webchat 同步（同一套 `buildChatItems` + `renderMessageGroup`）

## 2. 架构

```
OpenClaw Gateway (ws://127.0.0.1:{port})
        │
        ▼ WebSocket (challenge-response + token auth)
┌───────────────────────────────────────────┐
│  GatewayClient                            │
│  (src/renderer/libs/openclaw-chat         │
│   /gateway/client.ts)                     │
│  - WebSocket 连接管理                     │
│  - request/response RPC                   │
│  - 自动重连                               │
└────────────────┬──────────────────────────┘
                 │
                 ▼
┌───────────────────────────────────────────┐
│  ChatController                            │
│  (src/renderer/libs/openclaw-chat          │
│   /gateway/chat-controller.ts)             │
│  - 聊天状态管理                            │
│  - chat.history / chat.startup RPC         │
│  - chat.send RPC                           │
│  - 事件处理: delta / final / aborted/error │
│  - 工具调用/思考流处理                     │
└────────────────┬──────────────────────────┘
                 │
                 ▼
┌───────────────────────────────────────────┐
│  <justdo-chat> Lit Element                 │
│  (src/renderer/libs/openclaw-chat          │
│   /components/justdo-chat.ts)              │
│  - buildChatItems() → renderMessageGroup() │
│  - Shadow DOM 隔离                         │
│  - adoptedStyleSheets                      │
└────────────────┬──────────────────────────┘
                 │
                 ▼
         Shadow DOM 输出
```

### 2.1 React 集成

```
JustDoChatWrapper.tsx (React bridge)
  │
  ├── ChatController (Gateway WebSocket 直连)
  ├── <justdo-chat> Lit custom element
  ├── Exposes: sendMessage, setPendingUserMessage, clearSending
  └── Fallback: ChatMessageDisplay (纯 React 版本)
```

## 3. 核心组件

### 3.1 GatewayClient

**文件**：`src/renderer/libs/openclaw-chat/gateway/client.ts`

OpenClaw Gateway WebSocket 客户端，简化版 `GatewayBrowserClient`。

协议格式：

- **Request**: `{ type: "req", id: string, method: string, params: unknown }`
- **Response**: `{ type: "res", id: string, ok: boolean, payload?, error? }`
- **Event**: `{ type: "event", event: string, payload?, seq? }`

连接握手流程：

1. WebSocket open
2. 等待 `connect.challenge` 事件（750ms 超时）
3. 发送 `connect` 请求（含 auth token + 客户端元信息）
4. 接收 `hello-ok` 响应，连接建立成功

```typescript
export class GatewayClient {
  constructor(opts: GatewayClientOptions);
  start(): void;
  stop(): void;
  request<T>(method: string, params?: unknown): Promise<T>;
  get connected(): boolean;
}
```

自动重连：指数退避（800ms 起步，最大 15s，因子 1.7），WebSocket 断开后自动重连。

### 3.2 ChatController

**文件**：`src/renderer/libs/openclaw-chat/gateway/chat-controller.ts`

聊天控制器——管理与 Gateway 的交互，复刻 webchat 的 `controllers/chat.ts` 逻辑。

**状态管理** (`ChatState`)：

| 字段 | 类型 | 说明 |
|------|------|------|
| `connected` | `boolean` | Gateway WebSocket 连接状态 |
| `sessionKey` | `string` | 当前会话 key |
| `chatMessages` | `unknown[]` | 已加载的消息列表 |
| `chatThinkingMessages` | `unknown[]` | Thinking 流消息 |
| `chatToolMessages` | `unknown[]` | 工具调用消息 |
| `chatStream` | `string \| null` | 当前流式文本 |
| `chatThinkingStream` | `string \| null` | 当前 thinking 流文本 |
| `chatSending` | `boolean` | 是否正在发送 |
| `chatRunId` | `string \| null` | 当前 run ID |
| `pendingUserMessage` | `object \| null` | 乐观用户消息（历史加载前展示） |

**核心方法**：

| 方法 | 说明 |
|------|------|
| `connect(url, token, sessionKey)` | 连接 Gateway 并加载历史 |
| `switchSession(sessionKey)` | 切换会话 |
| `disconnect()` | 断开连接 |
| `sendMessage(text)` | 发送消息 |
| `abort()` | 中止当前 run |
| `loadHistory()` | 从 Gateway 加载历史消息 |
| `setPendingUserMessage(text)` | 设置乐观用户消息 |

**事件处理**：

| 事件 | 来源 | 处理 |
|------|------|------|
| `chat.state=delta` | Gateway `chat` event | 流式文本追加 |
| `chat.state=final` | Gateway `chat` event | 完成消息追加 |
| `chat.state=aborted` | Gateway `chat` event | 中止处理 |
| `chat.state=error` | Gateway `chat` event | 错误处理 |
| `agent` | Gateway agent event | Thinking 流、工具调用、生命周期 |
| `session.tool` | Gateway tool event | 工具状态更新 |
| `session.message` | Gateway message event | 触发历史重新加载 |

### 3.3 `<justdo-chat>` Lit Element

**文件**：`src/renderer/libs/openclaw-chat/components/justdo-chat.ts`

Lit 自定义元素，在 Shadow DOM 中渲染聊天消息。

**两种模式**：

1. **Direct props**：直接传入 `messages`、`stream`、`isStreaming` 等属性
2. **Controller mode**（推荐）：绑定 `ChatController` 引用，自动同步状态

**核心渲染方法**：

```typescript
@customElement('justdo-chat')
export class JustDoChatElement extends LitElement {
  render(): TemplateResult {
    // 1. 从 controller 获取消息状态
    // 2. buildChatItems() → ChatItem[] | MessageGroup[]
    // 3. 逐项调用 renderItem() 生成 TemplateResult
  }
}
```

## 4. 消息处理管线

### 4.1 消息项构建 (buildChatItems)

**文件**：`src/renderer/libs/openclaw-chat/pipeline/build-chat-items.ts`

将原始消息数组转换为渲染项列表。管线步骤：

1. **消息归一化** (`normalizeMessage`)：标准化消息格式
2. **角色归一化** (`normalizeRoleForGrouping`)：角色合并
3. **文本提取** (`extractTextCached`)：从消息内容中提取纯文本
4. **工具卡片提取** (`extractToolCardsCached`)：提取工具调用信息
5. **搜索匹配** (`messageMatchesSearchQuery`)：搜索高亮
6. **流式文本截断** (`trimAccumulatedStreamPrefix`)：流合并优化
7. **心跳过滤** (`isAssistantHeartbeatAckForDisplay`)：过滤心跳消息
8. **消息分组**：按角色和连续性分组 → `MessageGroup[]`

### 4.2 消息组渲染 (renderMessageGroup)

**文件**：`src/renderer/libs/openclaw-chat/components/grouped-render.ts`

渲染已分组的消息：

- **User 组**：右对齐，浅蓝背景
- **Assistant 组**：左对齐，白色/深色背景
- **Tool 组**：工具调用卡片样式
- **Thinking 组**：可折叠思考块，流式脉冲动画

### 4.3 流式内容更新

流式内容通过两种机制渲染：

1. **Stream text**：`chat.state=delta` 事件驱动的部分文本
2. **Assistant snapshot**：`agent` 事件 `stream=assistant` 携带的完整快照

```typescript
// 流式渲染入口 (justdo-chat.ts)
const stream = ctrl?.state.chatStream ?? this.stream;
if (isStreaming && stream) {
  return renderStreamingGroup(stream, streamStartedAt);
}
```

### 4.4 Thinking Stream 显示

Thinking 流通过 `agent` 事件 `stream=thinking` 传递完整 thinking 文本快照：

```typescript
// Event: agent { stream: "thinking", data: { text: "..." } }
// ChatController 处理
if (stream === 'thinking') {
  this.state.chatThinkingStream = text;
}
```

UI 呈现为可折叠的思考块，包含：
- 脉冲指示器动画（`thinking-pulse`）
- 实时内容滚动（最大高度 200px）
- 流式完成时自动提交（`commitActiveThinking`）

## 5. 工具调用显示

### 5.1 Tool Card 渲染

**文件**：`src/renderer/libs/openclaw-chat/pipeline/tool-cards.ts`
**文件**：`src/renderer/libs/openclaw-chat/components/tool-display.ts`

工具调用在消息中渲染为 Tool Card：

```
┌──────────────────────────────────┐
│  tool-name [collapse ▼]          │
│                                  │
│  ┌ Input ─────────────────────┐  │
│  │ { "param": "value" }       │  │
│  └────────────────────────────┘  │
│  ┌ Output ────────────────────┐  │
│  │ result text...             │  │
│  └────────────────────────────┘  │
└──────────────────────────────────┘
```

- 可折叠（`<details>` / `<summary>`）
- 错误状态（红色边框 + 背景）
- 参数和结果详情框

### 5.2 Tool Activity Group

一组工具调用在 `<details>` 中折叠显示，底部可展开查看所有工具活动。

### 5.3 Canvas 块

AI 生成的视觉内容（SVG 动画、Mermaid 图等）以 `canvas` 类型块嵌入消息流中。通过 `appendCanvasBlockToAssistantMessage` 将预览附加到 assistant 消息末尾。

## 6. 权限交互集成

工具调用的权限审批通过 `CoworkPermissionModal`（React 组件）处理，独立于 Lit 渲染管线：

```
Gateway → tool permission request → IPC → React CoworkPermissionModal → user approve/deny → IPC → Gateway
```

## 7. 与 React 集成

### 7.1 JustDoChatWrapper

**文件**：`src/renderer/components/cowork/JustDoChatWrapper.tsx`

React 与 Lit 之间的桥梁组件：

```typescript
const JustDoChatWrapper = forwardRef<JustDoChatWrapperRef, JustDoChatWrapperProps>((props, ref) => {
  // 创建/管理 ChatController
  // 监听当前会话变化
  // 暴露 sendMessage / setPendingUserMessage / clearSending
  // 渲染 <justdo-chat> Lit 元素
});
```

**Props (via ref)**：
- `sendMessage(text)`: 发送消息到当前会话
- `setPendingUserMessage(text)`: 设置乐观用户消息（会话切换时使用）
- `clearSending()`: 清除发送状态

### 7.2 ChatMessageDisplay

**文件**：`src/renderer/components/cowork/ChatMessageDisplay.tsx`

纯 React 版本的聊天消息显示组件，作为 `<justdo-chat>` 不可用时的回退方案。

## 8. 数据流

```
用户输入
  │
  ▼
JustDoChatWrapper.sendMessage(text)
  │
  ▼
ChatController.sendMessage(text)
  │  ├─ 乐观: 立即追加 user message
  │  └─ 发送: client.request('chat.send', { sessionKey, message })
  │
  ▼
Gateway → AI 处理 → 工具调用 → 响应
  │
  ▼
ChatController.handleEvent()
  │  ├─ handleDelta → chatStream 更新 → notifyStream
  │  ├─ handleAgentEvent → thinking/assistant/tool 更新
  │  └─ handleFinal → 消息追加 + loadHistory
  │
  ▼
<justdo-chat> lit element
  │  └─ buildChatItems → renderItem → Shadow DOM
```

## 9. 关键文件清单

| 文件 | 职责 |
|------|------|
| `src/renderer/libs/openclaw-chat/gateway/client.ts` | Gateway WebSocket 客户端 |
| `src/renderer/libs/openclaw-chat/gateway/chat-controller.ts` | 聊天控制器（状态、事件、RPC） |
| `src/renderer/libs/openclaw-chat/components/justdo-chat.ts` | `<justdo-chat>` Lit 自定义元素 |
| `src/renderer/libs/openclaw-chat/components/grouped-render.ts` | 消息组渲染函数 |
| `src/renderer/libs/openclaw-chat/components/chat-avatar.ts` | 聊天头像组件 |
| `src/renderer/libs/openclaw-chat/components/markdown.ts` | Markdown 渲染（Lit） |
| `src/renderer/libs/openclaw-chat/components/tool-display.ts` | 工具调用显示 |
| `src/renderer/libs/openclaw-chat/pipeline/build-chat-items.ts` | 消息管线处理 |
| `src/renderer/libs/openclaw-chat/pipeline/message-normalizer.ts` | 消息归一化 |
| `src/renderer/libs/openclaw-chat/pipeline/role-normalizer.ts` | 角色归一化 |
| `src/renderer/libs/openclaw-chat/pipeline/tool-cards.ts` | 工具卡片提取 |
| `src/renderer/libs/openclaw-chat/pipeline/stream-text.ts` | 流式文本处理 |
| `src/renderer/libs/openclaw-chat/pipeline/heartbeat-display.ts` | 心跳消息过滤 |
| `src/renderer/libs/openclaw-chat/pipeline/history-limits.ts` | 历史消息渲染限制 |
| `src/renderer/libs/openclaw-chat/pipeline/message-extract.ts` | 消息内容提取 |
| `src/renderer/libs/openclaw-chat/pipeline/search-match.ts` | 搜索匹配高亮 |
| `src/renderer/libs/openclaw-chat/pipeline/text-direction.ts` | 文本方向检测 |
| `src/renderer/libs/openclaw-chat/pipeline/user-message-content.ts` | 用户消息内容构建 |
| `src/renderer/libs/openclaw-chat/types.ts` | Lit 聊天系统类型定义 |
| `src/renderer/components/cowork/JustDoChatWrapper.tsx` | React ↔ Lit 桥接组件 |
| `src/renderer/components/cowork/ChatMessageDisplay.tsx` | 回退 React 消息组件 |

## 10. 版本信息

- **Last Updated**: 2026-07-01
- **JustDo Version**: v2026.7.1
- **OpenClaw Gateway**: v2026.6.9
