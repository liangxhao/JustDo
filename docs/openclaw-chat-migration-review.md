# JustDo 消息显示重写 — 工作总结与待审代码清单

> 日期: 2026-06-25
> 目标: 彻底替换 JustDo 的消息显示系统，用 OpenClaw webchat 的渲染管线替代

---

## 一、背景

JustDo 原有的消息显示组件 `CoworkSessionDetail.tsx`（3800+ 行）长期存在消息重复、截断、丢失等问题。
经过多次修复未果，决定彻底重写，采用 OpenClaw webchat 的 Lit 渲染管线。

最终方案：Lit 自定义元素 `<justdo-chat>` 嵌入 React，直接连接 OpenClaw Gateway WebSocket（与 webchat 完全一致的对接方式）。

---

## 二、架构

```
OpenClaw Gateway (ws://127.0.0.1:{port})
        ↓ WebSocket (challenge-response + token auth)
  GatewayClient (src/renderer/libs/openclaw-chat/gateway/client.ts)
        ↓ request/response 协议
  ChatController (src/renderer/libs/openclaw-chat/gateway/chat-controller.ts)
        ↓ chat.history / chat.startup / chat.send RPC
        ↓ 事件处理: delta / final / aborted / error
  <justdo-chat> Lit Element (shadow DOM)
        ↓ buildChatItems() → renderMessageGroup()
        ↓ CSS 通过 adoptedStyleSheets 隔离
  Shadow DOM 输出
```

**关键决策：**
- Lit 组件直接连接 Gateway WebSocket，**不经过** JustDo 的 `openclawRuntimeAdapter` 和 Redux store
- 使用和 webchat 完全相同的 RPC 方法（`chat.history`、`chat.startup`、`chat.send`）
- 使用和 webchat 完全相同的事件处理（`delta` 增量追加、`final` 替换最终消息）
- Shadow DOM 隔离 CSS，与 JustDo 的 Tailwind 互不干扰

---

## 三、文件清单

### 新建文件（30+ 个）

#### Gateway 对接层（核心，复制自 webchat）
| 文件 | 说明 | 行数 |
|------|------|------|
| `src/renderer/libs/openclaw-chat/gateway/client.ts` | WebSocket 客户端：challenge-response 握手、request/response 协议、重连 | ~280 |
| `src/renderer/libs/openclaw-chat/gateway/chat-controller.ts` | 聊天状态管理：loadHistory、handleChatEvent、sendMessage、abort | ~350 |

#### Lit 自定义元素和渲染
| 文件 | 说明 | 行数 |
|------|------|------|
| `src/renderer/libs/openclaw-chat/components/justdo-chat.ts` | `<justdo-chat>` Lit 元素：shadow DOM、属性绑定、ChatController 集成 | ~400 |
| `src/renderer/libs/openclaw-chat/components/grouped-render.ts` | 消息分组渲染：user/assistant/tool/thinking/stream | ~220 |
| `src/renderer/libs/openclaw-chat/components/chat-avatar.ts` | 头像渲染 | ~100 |
| `src/renderer/libs/openclaw-chat/components/copy-as-markdown.ts` | 复制按钮 | ~50 |
| `src/renderer/libs/openclaw-chat/components/markdown.ts` | DOMPurify + markdown-it 渲染 | ~20 |
| `src/renderer/libs/openclaw-chat/components/tool-display.ts` | 工具名称/图标显示 | ~15 |

#### 渲染管线（复制自 OpenClaw，适配 imports）
| 文件 | 说明 |
|------|------|
| `src/renderer/libs/openclaw-chat/pipeline/build-chat-items.ts` | 消息分组核心：messages → ChatItem/MessageGroup |
| `src/renderer/libs/openclaw-chat/pipeline/message-normalizer.ts` | 消息规范化：raw → NormalizedMessage |
| `src/renderer/libs/openclaw-chat/pipeline/message-extract.ts` | 提取文本/thinking/raw content |
| `src/renderer/libs/openclaw-chat/pipeline/role-normalizer.ts` | 角色规范化 |
| `src/renderer/libs/openclaw-chat/pipeline/tool-cards.ts` | 工具卡片数据提取 |
| `src/renderer/libs/openclaw-chat/pipeline/tool-helpers.ts` | 工具辅助函数 |
| `src/renderer/libs/openclaw-chat/pipeline/tool-expansion-state.ts` | 工具展开状态 |
| `src/renderer/libs/openclaw-chat/pipeline/stream-reconciliation.ts` | 流式状态管理 |
| `src/renderer/libs/openclaw-chat/pipeline/stream-text.ts` | 流式文本工具 |
| `src/renderer/libs/openclaw-chat/pipeline/heartbeat-display.ts` | heartbeat 过滤 |
| `src/renderer/libs/openclaw-chat/pipeline/history-limits.ts` | 历史限制常量 |
| `src/renderer/libs/openclaw-chat/pipeline/constants.ts` | 共享常量 |
| `src/renderer/libs/openclaw-chat/pipeline/text-direction.ts` | RTL/LTR 检测 |
| `src/renderer/libs/openclaw-chat/pipeline/session-key.ts` | Session key 解析（stub） |
| `src/renderer/libs/openclaw-chat/pipeline/session-cache.ts` | Session 缓存（stub） |
| `src/renderer/libs/openclaw-chat/pipeline/session-message-cache.ts` | 消息缓存 |
| `src/renderer/libs/openclaw-chat/pipeline/search-match.ts` | 搜索匹配（stub） |
| `src/renderer/libs/openclaw-chat/pipeline/app-tool-stream.ts` | 工具流（stub） |
| `src/renderer/libs/openclaw-chat/pipeline/tool-message-refs.ts` | 工具消息引用（stub） |
| `src/renderer/libs/openclaw-chat/pipeline/attachment-payload-store.ts` | 附件存储（stub） |
| `src/renderer/libs/openclaw-chat/pipeline/user-message-content.ts` | 用户消息构建（stub） |

#### Shim 层（替代 @openclaw/* 包）
| 文件 | 说明 |
|------|------|
| `src/renderer/libs/openclaw-chat/shims/normalization-core.ts` | ~7 个字符串/记录 coercion 函数 |
| `src/renderer/libs/openclaw-chat/shims/media-core.ts` | mediaKindFromMime |
| `src/renderer/libs/openclaw-chat/shims/backend-helpers.ts` | 简化版 stripping 函数（stripInboundMetadata、extractCanvasShortcodes 等） |

#### 类型和转换
| 文件 | 说明 |
|------|------|
| `src/renderer/libs/openclaw-chat/types.ts` | gateway 消息格式类型（ChatItem、MessageGroup、NormalizedMessage、ToolCard、GatewayMessage） |
| `src/renderer/libs/openclaw-chat/conversion/cowork-to-gateway.ts` | CoworkMessage → GatewayMessage 转换（当前未使用，备用） |
| `src/renderer/libs/openclaw-chat/hooks/useChatMessages.ts` | React hook（当前未使用，备用） |
| `src/renderer/libs/openclaw-chat/index.ts` | Barrel export |

#### React 集成
| 文件 | 说明 |
|------|------|
| `src/renderer/components/cowork/JustDoChatWrapper.tsx` | React 包装组件：创建 ChatController、连接 gateway、挂载 Lit 元素 |

### 修改的文件

| 文件 | 变更 |
|------|------|
| `package.json` | 添加 `lit`、`markdown-it`、`highlight.js`、`markdown-it-task-lists`、`@types/markdown-it`、`@types/dompurify` |
| `tsconfig.json` | 添加 `experimentalDecorators: true` |
| `src/renderer/components/cowork/CoworkView.tsx` | 添加 `USE_LIT_RENDERER` feature flag，条件渲染 JustDoChatWrapper vs CoworkSessionDetail |

---

## 四、已知 Bug（必须修复）

### Bug 1: 发送消息后前端报错，不显示任何内容

**现象：** 选择 session 后，页面显示 "No messages"，发送消息后直接报错。

**可能原因：**
1. Gateway 连接未成功建立（token 获取失败、port 不可用）
2. `chat.history` / `chat.startup` RPC 返回错误
3. `buildChatItems()` 接收到的消息格式与预期不符
4. Lit 元素的 `requestUpdate()` 未正确触发重渲染
5. Shadow DOM 中的 CSS 未正确加载

**排查方向：**
- 检查 `JustDoChatWrapper.tsx` 中 `connectToGateway()` 的 console 日志
- 检查 `ChatController.connect()` 是否成功调用 `handleHello`
- 检查 `loadHistory()` 返回的消息格式
- 检查 `<justdo-chat>` 的 `render()` 是否被调用

### Bug 2: 旧代码未完全清理

**需要检查的文件：**
- `CoworkView.tsx` 中 `handleContinueSession` 和 `handleDeleteSession` 是否仍被引用
- `CoworkSessionDetail.tsx` 是否仍被 import（当前 feature flag 设为 `true` 时不应使用）
- `coworkSlice.ts` 中的消息相关 reducer 是否仍需要
- `coworkService.ts` 中的 stream listener 是否仍需要
- `preload.ts` 中的 cowork stream IPC 是否仍需要

### Bug 3: 可能的 TypeScript 编译问题

- `tsconfig.json` 添加了 `experimentalDecorators`，可能影响其他使用标准装饰器的代码
- 多个 pipeline 文件使用了简化 stub，可能在复杂消息场景下失败

### Bug 4: CSS 主题不匹配

- Lit 元素使用 CSS 变量 `--justdo-chat-*`，但 JustDo 可能未定义这些变量
- 需要检查 light/dark 模式下的显示效果

### Bug 5: Session 切换可能不工作

- `switchSession()` 调用 `loadHistory()`，但如果 gateway 连接已断开会静默失败
- 需要检查 session key 格式是否正确（`agent:{agentId}:justdo:{sessionId}`）

---

## 五、待审代码重点

### 1. Gateway 客户端安全性 (`gateway/client.ts`)
- Token 是否安全传递（不应出现在 URL 或日志中）
- WebSocket 连接是否有正确的错误处理
- 重连机制是否会导致连接风暴

### 2. Chat 状态管理正确性 (`gateway/chat-controller.ts`)
- `handleDelta` 的流式文本累积逻辑是否正确
- `handleFinal` 是否正确替换 stream-fallback 消息
- `sendMessage` 的乐观更新是否会导致消息重复
- 并发 session 切换是否安全

### 3. Lit 元素渲染正确性 (`components/justdo-chat.ts`)
- Controller 订阅/取消订阅的生命周期是否正确
- `buildChatItems` 的输入格式是否与 pipeline 期望一致
- Shadow DOM 的 CSS 隔离是否完整

### 4. Pipeline 文件适配质量
- 所有从 OpenClaw 复制的文件是否正确适配了 imports
- Stub 函数是否覆盖了所有被调用的场景
- `build-chat-items.ts` 中的 `toSorted` → `sort` 替换是否正确

### 5. Feature Flag 影响
- `USE_LIT_RENDERER = true` 时，旧代码路径是否完全不执行
- 是否有未处理的副作用（如 Redux store 更新、IPC listener 注册）

---

## 六、下一步工作

1. **修复 Bug 1**（最高优先级）：确保 gateway 连接成功、消息正确加载和渲染
2. **代码审查**：请 agent 审查上述所有新建文件
3. **清理旧代码**：确认 CoworkSessionDetail 的依赖可以安全移除
4. **测试流式消息**：验证 streaming delta → final 的完整流程
5. **测试 session 切换**：验证侧边栏切换 session 时 webchat 同步更新
6. **主题适配**：确保 CSS 变量与 JustDo 的 light/dark 模式一致

---

## 七、依赖关系

```
package.json 新增:
  lit                    # Lit web components
  markdown-it            # Markdown 解析
  highlight.js           # 代码高亮
  markdown-it-task-lists # 任务列表支持
  @types/markdown-it     # TypeScript 类型
  @types/dompurify       # TypeScript 类型

tsconfig.json 变更:
  experimentalDecorators: true  # Lit 装饰器支持
```
