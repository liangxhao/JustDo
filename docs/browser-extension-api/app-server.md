# WebSocket app-server 协议

JustDo app-server 使用 Codex app-server 的双向 JSON-RPC v2 消息形态：请求有 `id`，通知无
`id`，响应包含 `result` 或 `error`，但在 WebSocket payload 中省略 `"jsonrpc":"2.0"`。

## 建立连接

扩展必须使用 Native Host 返回的完整 `localAppServerUrl`，不能自行猜测端口或 token：

```text
ws://127.0.0.1:<dynamic-port>/app-server?token=<64 hex chars>
```

HTTP Upgrade 必须同时满足：

- 连接到 `127.0.0.1` 上的动态端口；
- path 为 `/app-server`；
- query 中的 `token` 与当前进程 capability 一致；
- `Origin` 精确为 `chrome-extension://jboajogplelmaahjbomgflnfngpolgcb`。

不满足时返回 HTTP `401` 并关闭连接。每个 WebSocket 文本帧只能包含一条消息，最大
payload 为 `8 MiB`。Side Panel 本身把附件限制为最多 5 个、原始文件合计最多 4 MiB；
Main 还会校验编码后的附件总量。

## 消息格式

请求：

```json
{ "id": "thread/list:uuid", "method": "thread/list", "params": {} }
```

成功响应：

```json
{ "id": "thread/list:uuid", "result": { "data": [], "nextCursor": null } }
```

失败响应：

```json
{
  "id": "thread/read:uuid",
  "error": { "code": -32603, "message": "Thread not found." }
}
```

服务端通知：

```json
{
  "method": "turn/started",
  "params": { "threadId": "thread-id", "turn": { "id": "turn-id" } }
}
```

## 初始化握手

每条 WebSocket 连接必须严格执行：

1. 发送一次 `initialize` 请求并等待响应。
2. 发送无 `id` 的 `initialized` 通知。
3. 再调用线程或轮次方法。

自动化配对也要求同样的鉴权与初始化。产品扩展方法 `browser/extension/pair` 接收空 `params`，返回 `{ pairingString: string }`；Main 先准备 Gateway，再调用锁定 CLI 的 `browser extension pair --local-gateway --json`。只允许当前配置的 `127.0.0.1` Gateway 与原生 `/browser/extension` 路径，不接收远程地址、profile 或 CLI 参数。它不操作会话／Tab，不触发聊天，不返回 Gateway token；pairingString 中的 relay key 只供扩展后台交给原生配对状态机，不得记录或持久化到发现文件。失败统一返回凭据已隐藏的错误。

请求：

```json
{
  "id": "initialize:uuid",
  "method": "initialize",
  "params": {
    "clientInfo": {
      "name": "justdo-chrome-extension-sidepanel",
      "title": "<ProductName> Chrome Extension Sidepanel",
      "version": "<extension version>"
    },
    "capabilities": {
      "experimentalApi": true,
      "requestAttestation": false,
      "optOutNotificationMethods": []
    }
  }
}
```

响应：

```json
{
  "id": "initialize:uuid",
  "result": {
    "platformFamily": "windows",
    "platformOs": "win32",
    "userAgent": "JustDo/<app version>"
  }
}
```

当前实现识别 `capabilities.optOutNotificationMethods`，按精确方法名屏蔽当前连接上的通知。
其余 capability 为兼容声明，当前不会改变服务行为。重复 `initialize` 返回
`Already initialized.`；握手前的其他请求返回 `Connection is not initialized.`。

## `thread/list`

分页列出应用会话，不按助手名称隐藏会话。默认每页 50 条，`limit` 被限制在 1–100。

```json
{
  "id": "1",
  "method": "thread/list",
  "params": { "cursor": "0", "limit": 50 }
}
```

```json
{
  "id": "1",
  "result": {
    "data": [{ "id": "thread-id", "name": "Conversation", "status": { "type": "idle" } }],
    "nextCursor": null
  }
}
```

`cursor` 是十进制 offset 的字符串。无效或负数 cursor 按 `0` 处理。当前不实现官方协议中的
筛选参数；未知参数被忽略。

## `thread/read`

读取一个已存在会话。`includeTurns: true` 时从 OpenClaw 权威历史加载消息并组装 turns；扩展读取会
绕过进程内的增量历史快照并重新获取完整快照，避免过期 delta cursor 遗漏刚落盘的最终回复。否则
`turns` 为空数组。

```json
{
  "id": "2",
  "method": "thread/read",
  "params": { "threadId": "thread-id", "includeTurns": true }
}
```

```json
{ "id": "2", "result": { "thread": { "id": "thread-id", "turns": [] } } }
```

必填：`threadId`。不存在时返回错误，不会隐式创建会话；读取成功后当前 WebSocket 会订阅该线程，
以便断线重连后恢复通知。

## `thread/start`

创建空的 JustDo 会话，并自动让当前 WebSocket 订阅该线程通知。

```json
{
  "id": "3",
  "method": "thread/start",
  "params": { "title": "Summarize this page" }
}
```

```json
{
  "id": "3",
  "result": {
    "instructionSources": [],
    "thread": { "id": "thread-id", "name": "Summarize this page", "turns": [] }
  }
}
```

同时向已订阅该线程的连接发送 `thread/started`。`title` 可省略，最长使用前 50 个字符；创建
会话要求桌面端已经配置任务目录。

## `thread/unsubscribe`

取消当前连接对指定线程的通知订阅，不删除、不归档会话，也不会停止运行中的 turn。

```json
{
  "id": "4",
  "method": "thread/unsubscribe",
  "params": { "threadId": "thread-id" }
}
```

结果为 `{ "status": "unsubscribed" }` 或 `{ "status": "notSubscribed" }`。

## `composer/options`

读取输入区当前应展示的权限和模型选项。`threadId` 省略时返回桌面端默认值，指定时返回该会话
当前值。模型来自已启用 agent；当前会话已有的模型也会保留在选项中。

```json
{
  "id": "options",
  "method": "composer/options",
  "params": { "threadId": "thread-id" }
}
```

```json
{
  "id": "options",
  "result": {
    "permissionMode": "full",
    "modelRef": "provider/model",
    "models": [{ "id": "provider/model", "name": "model" }]
  }
}
```

## `turn/start`

向现有线程发送消息并开始生成。调用成功后当前连接自动订阅返回的 thread。

```json
{
  "id": "5",
  "method": "turn/start",
  "params": {
    "threadId": "thread-id",
    "input": [{ "type": "text", "text": "Explain the selected code" }],
    "attachments": [{ "name": "notes.txt", "mimeType": "text/plain", "base64Data": "SGVsbG8=" }],
    "permissionMode": "full",
    "modelRef": "provider/model",
    "pageContext": {
      "title": "Example",
      "url": "https://example.com/",
      "selectedText": "const value = 1;"
    }
  }
}
```

兼容输入：

- 首选 `input` 数组；只拼接 `type: "text"` 或 `type: "input_text"` 的 `text`。
- 为内部兼容也接受顶层 `message` 字符串。
- 文本为空时拒绝请求。
- `attachments` 使用 `{ name, mimeType, base64Data }`；最多 5 个，编码后总长度最多 6 MiB。
- `permissionMode` 可为 `ask`、`auto`、`full`，在本轮开始前保存并同步到 Gateway session。
- `modelRef` 必须来自 `composer/options.models`；改变模型时先创建/准备 Gateway session，再调用
  session model patch；成功或失败都以 patch 返回的 Gateway 权威模型校准本地值。
- `threadId` 可省略，控制器会创建新会话；官方侧栏流程会先调用 `thread/start`，因此正常请求总是携带它。
- `pageContext` 不会拼接或持久化为 user message；Main 通过受限的 Agent-only context 字段把它
  交给本轮模型，`thread/read` 返回的用户文本始终是原始输入。

响应中的 `turn` 初始状态为 `inProgress`，`id` 是 JustDo `clientTurnId/runId`：

```json
{
  "id": "5",
  "result": {
    "turn": {
      "id": "run-id",
      "status": "inProgress",
      "items": [],
      "itemsView": "full",
      "error": null,
      "startedAt": 1789690000,
      "completedAt": null,
      "durationMs": null
    }
  }
}
```

收到 Gateway 接受确认后才返回成功。一个线程已有运行中响应时，新请求会失败。

## `turn/interrupt`

请求停止当前线程正在运行的响应：

```json
{
  "id": "6",
  "method": "turn/interrupt",
  "params": { "threadId": "thread-id", "turnId": "run-id" }
}
```

成功响应为 `{}`，随后发送 `turn/completed`，状态为 `interrupted`。`threadId` 必填；
`turnId` 建议提供，用于通知关联，但当前实际停止操作以 `threadId` 为准。

## 通知

| method           | params                 | 触发条件                                 |
| ---------------- | ---------------------- | ---------------------------------------- |
| `thread/started` | `{ thread }`           | `thread/start` 创建成功                  |
| `turn/started`   | `{ threadId, turn }`   | `turn/start` 已被 Gateway 接受           |
| `thread/updated` | `{ threadId, thread }` | JustDo 扩展通知；轮询到权威消息历史变化  |
| `turn/completed` | `{ threadId, turn }`   | 完成、失败、中断、线程消失或持续刷新失败 |

`thread/updated` 是 JustDo 为当前非增量历史桥接增加的扩展，不是需要其他 Codex
app-server 客户端依赖的官方核心事件。`turn/completed.turn.items` 当前为空；客户端应在完成后调用
`thread/read(includeTurns: true)` 获取最终历史。运行期间优先复用按 session 隔离的 Gateway delta
cursor，并以较低频率执行完整快照校准；进入终态后改用完整快照做最终 reconciliation。历史读取失败
不会广播空 transcript，也不会推进完成判定。服务端要求终态历史包含本轮 assistant 内容并连续稳定，
或到达有界的最大等待时间后，才发送 `turn/completed`。

通知按连接订阅过滤。`thread/read`、`thread/start` 和 `turn/start` 会订阅；
`thread/unsubscribe` 会退订。

### `thread/image`（JustDo 扩展）

请求 `{ "threadId": "session-id", "source": "./screenshot.png" }`，返回
`{ "dataUrl": "data:image/png;base64,..." }`。仅初始化成功的已认证客户端可请求。
对于 `media://inbound/` 及 `/api/chat/media/outgoing/`，服务端解析 thread 对应的原生 session key，复用桌面 Gateway 媒体接口的格式校验及会话授权，返回图片 data URL。
对于本地文件，服务端核对当前会话原生历史中的图片引用，按会话 cwd 解析相对路径；拒绝未引用路径、网络文件路径、
不支持的文件扩展名及超过 20 MiB 的文件。失败通过现有 JSON-RPC error 返回，客户端显示图片加载失败。

`thread/read` / `thread/updated` 中的 `userMessage`、`agentMessage` 可带可选 `rawMessage`：
只包含展示所需的 role、content 与原生媒体字段，供侧栏与桌面共享的解析器识别附件和浏览器卡片。
原有 text/content 文本投影保留，纯图片也会产生消息 item。

生成图片的 `openclawDelivery.mediaUrls` 保留用于替换 managed outgoing 地址。拆分的正文项中，
`rawMessage.__browserExtensionOmitDeliveryMedia` 表示只用 delivery 信息清理重复附件；消息末尾
另追加一个媒体展示项，避免图片出现在 Thinking 之前或重复展示。此标记只用于临时侧栏展示，不写入原生历史。
图片读取只匹配用户／助手的展示内容和显式媒体字段，工具参数、工具结果及任意元数据路径不构成授权。
