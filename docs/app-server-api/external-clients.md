# 通用客户端：stdio 与本机 WebSocket

本文描述 CLI stdio 和本机 Bearer WebSocket 共用的 `CliAppServerBinding`。
两种传输使用相同的方法、数据模型与会话所有权；Chrome 的发现、历史、附件和订阅规范见
[Chrome 扩展](browser/README.md)。公共消息外形和入口差异见[总览](README.md)。

## 连接

### CLI stdio

使用应用提供的命令路径启动：

```text
<cli> app-server --listen stdio://
```

命令路径含空格时按调用环境正确传参。客户端向 stdin 写入每行一条 UTF-8 JSON，
从 stdout 读取同样格式的响应与通知；诊断输出使用 stderr，不解析为协议消息。
此命令不启动 WebSocket listener。调用时桌面应用须已运行或驻留托盘。

stdin EOF 或连接断开会取消本连接拥有的活动／未知运行，并等待原生清理；
关闭进程不能作为执行已停止的证明。更多启动与安装约束见 [CLI 与 ACP](../features/integrations/agent-cli.md)。

### 本机 WebSocket

在“设置 → 外部连接 → 应用接入”复制配置：

```json
{
  "url": "ws://127.0.0.1:<dynamic-port>/app-server",
  "headers": { "Authorization": "Bearer <current-token>" }
}
```

桌面应用运行时提供此入口，无需另行开启。URL 和令牌属于当前 listener 生命周期，
应用重启后重新复制配置，不猜测端口或将令牌写入日志。
HTTP Upgrade 必须携带正确的 `Authorization`，且不能带 `Origin`。
此入口面向可设置 Upgrade 请求头的本机客户端，不能由普通网页直接连接；
Chrome 扩展使用独立的 Origin／capability 入口。

每个 WebSocket 文本消息只包含一条 JSON；入站消息上限为 8 MiB。二进制消息会关闭连接。
WebSocket 断开采用与 stdio EOF 相同的精确运行取消策略。
资源与背压上限由[统一 app-server](../features/integrations/app-server.md)维护。

## 最小调用顺序

按顺序发送请求，并等待每一步的响应；后续请求使用服务端实际返回的 ID：

```json
{ "id": 1, "method": "initialize", "params": { "clientInfo": { "name": "example-client", "version": "1.0.0" } } }
{ "id": 2, "method": "model/list", "params": {} }
{ "id": 3, "method": "thread/start", "params": {} }
{ "id": 4, "method": "turn/start", "params": { "threadId": "<thread.id>", "input": [{ "type": "text", "text": "你好" }] } }
```

每连接仅初始化一次。`initialize` 返回 `{ userAgent, platformOs }`；
发送 `initialized` 通知可选。所有业务调用必须带 `id`，无 `id` 时会被忽略。
`turn/start` 响应后继续接收异步通知；长时间运行不会阻塞 `turn/interrupt` 请求。

## 方法

### `model/list`

返回当前桌面配置中可用的模型，当前不分页，不支持 reasoning effort 覆盖：

```ts
type ModelListResult = {
  data: {
    id: string;
    model: string;
    displayName: string;
    isDefault: boolean;
    supportedReasoningEfforts: [];
    defaultReasoningEffort: null;
  }[];
  nextCursor: null;
};
```

### `thread/start` / `thread/resume`

`thread/start` 接受可选的 `cwd`、`model` 字符串；`null` 按未提供处理。
`model` 使用 `model/list` 返回的 ID。工作目录的默认值由调用上下文和桌面配置确定。

`thread/resume` 额外要求 `threadId`，必须是同一应用 profile 下 CLI 来源、可恢复的
外部会话 ID，可来自普通 CLI、ACP 或 app-server。不能填入桌面产品会话 ID 或原生
session key。省略 `cwd` 时保留该会话的目录；
显式提供时也必须与原目录一致，不能借恢复操作切换工作目录。
服务端仍会校验原生身份、所有权与尚未结算的运行，恢复不等于可以重发未知输入。

两者返回：

```ts
type ThreadOpenResult = {
  thread: { id: string; cwd: string; turns: [] };
  model: string | null;
};
```

`turns: []` 不表示服务端没有历史，只表示此接口不回放历史。
一个连接只能创建或恢复一个会话；即使会话空闲，也不能再绑定另一个。
并行会话使用独立连接。产品会话列表中统一归入 CLI，不按调用方应用名称细分。

桌面应用管理执行配置。以下非 `null` 覆盖项会被拒绝：
`serviceTier`、`approvalPolicy`、`sandbox`、`modelProvider`、`profile`、
`baseInstructions`、`developerInstructions`、`compactPrompt`、`includeApplyPatchTool`。
`config` 只允许省略、`null` 或空对象；未知字段不保证生效，不能据此假设能力已支持。

### `thread/name/set`

要求 `threadId` 属于当前连接，成功返回 `{}`。当前仅校验归属，不修改产品会话标题。

### `turn/start`

```ts
type TurnStartParams = {
  threadId: string;
  input: { type: 'text'; text: string }[];
};
```

输入只能是文本数组，不支持 `input_text` 别名、图片、附件、页面上下文或富输入。
多项文本以换行拼接，合并后必须有非空白内容。执行后端限制最多 2,097,152 个 UTF-16
code units；协议入口另校验 UTF-8 文本最多 8 MiB，WebSocket 消息本身也须满足
包含 JSON 包装的大小限制。后端校验发生在本地准入后，超限可能通过异步失败通知返回。
`threadId` 必须是当前连接拥有的会话；活动或结果未知的 turn 尚未解除前拒绝新输入。

以下非 `null` 的逐轮覆盖项会被拒绝：`effort`、`serviceTier`、`model`、`cwd`、
`approvalPolicy`、`sandboxPolicy`、`outputSchema`。模型可在创建／恢复会话时选择，
权限和其他执行配置沿用桌面应用设置，不提供客户端审批或 MCP 配置 API。

立即返回由服务端生成的 turn ID：

```json
{ "turn": { "id": "<turn-id>", "status": "inProgress", "items": [] } }
```

该响应与 `turn/started` 只确认本地任务准入，不证明原生执行已接纳或结算。
本入口不支持 Chrome 的 `clientTurnId` 幂等查询流程。

### `turn/interrupt`

```json
{
  "id": 5,
  "method": "turn/interrupt",
  "params": { "threadId": "<thread-id>", "turnId": "<turn-id>" }
}
```

两个 ID 必须匹配当前连接拥有的活动／未知 turn。成功返回 `{}`，只确认取消请求；
不得将 ACK、idle、最终正文或连接关闭当作原生停止证据。

## 通知与 Item

所有执行通知的 `params` 均包含 `threadId` 和 `turnId`：

| 方法                       | 其余字段                             |
| -------------------------- | ------------------------------------ |
| `turn/started`             | `turn: { id, status: 'inProgress' }` |
| `item/started`             | `item`                               |
| `item/completed`           | `item`                               |
| `item/agentMessage/delta`  | `itemId, delta`                      |
| `item/reasoning/textDelta` | `itemId, contentIndex: 0, delta`     |
| `turn/completed`           | `turn: { id, status, error? }`       |

同一 `itemId` 的文本 delta 按接收顺序拼接。`item/completed` 提供完成后的内容，
不可在已拼接的文本后再追加一次。

| Item 类型      | 字段                                              |
| -------------- | ------------------------------------------------- |
| `userMessage`  | `id, content: [{ type: 'text', text }]`           |
| `agentMessage` | `id, text, phase: 'commentary' \| 'final_answer'` |
| `reasoning`    | `id, summary: [], content: string[]`              |
| `mcpToolCall`  | `id, server, tool, arguments, status, error?`     |

Reasoning 的开始 item 为 `content: []`，完成时包含投影后的文本。
工具状态为 `inProgress`、`completed` 或 `failed`，错误可包含 `{ message }`。
`mcpToolCall` 只是原生工具进度的协议投影，不表示提供了客户端 MCP 管理能力。
这些 item 不使用 Chrome 的 `toolCall`、`systemMessage` 或 `thread/stream` 模型。

## 结果与断线

`turn/completed.turn.status` 可能为：

| 状态          | 含义                                               |
| ------------- | -------------------------------------------------- |
| `completed`   | 后端成功返回，本轮完成                             |
| `interrupted` | 后端确认取消；`error: null`                        |
| `failed`      | 执行、输出或结果核对发生错误；`error: { message }` |

未知结果也使用 `failed`，但 `error.message` 带 `EXECUTION_UNKNOWN: ` 前缀，
并保留未知运行的占用。这个通知没有 Chrome 的 `executionSettled` 字段，
也不能把所有 `failed` 解释为原生执行已失败。输出通道错误同样不证明原生已经停止。

本入口没有 `thread/read`／`thread/list`、客户端 turn ID 查询或历史订阅恢复 API。
断线、超时或未知结果后不能自动重新提交原输入；恢复会话仍须通过服务端的身份和占用校验。
取消与回收依赖精确原生运行身份及终态证据，详见[执行生命周期](../features/integrations/app-server.md)。

## 错误

业务错误、未初始化和未实现的方法统一返回 `-32000`，无效请求或重复初始化返回
`-32600`。WebSocket 非法 JSON 返回 `-32700`；stdio 非法 JSON 关闭连接。
不支持的方法包括 `thread/list/read/unsubscribe/image`、`composer/options`、
`browser/extension/pair`、`turn/steer`、账户、配置和审批 API。
不能套用 Chrome 的错误码、`error.data.requestSent` 或恢复策略。

权威实现为 `src/main/integrations/externalAgent/cliAppServerBinding.ts`、
`codexAppServerProgress.ts` 与 `src/main/appServer/appServerIntegrationService.ts`。
