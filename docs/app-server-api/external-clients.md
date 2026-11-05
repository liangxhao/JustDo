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

桌面应用运行时提供此入口，无需另行开启。设置页支持保存监听端口：`0` 为自动分配，
`1..65535` 为固定端口。令牌自动生成并持久保存，正常重启不会更换。
需要自动重连的客户端可配置固定端口，重启应用使设置生效后复制一次连接配置，
以后正常重启继续使用相同 URL 和令牌；桌面应用仍须先运行。

保存端口和“重新生成”令牌仅在下次启动生效，当前连接与任务继续使用原配置。
复制按钮始终提供当前有效配置；设置待生效时，重启应用后再复制新配置。
自动端口模式下每次重启仍可能换地址。固定端口被占用时服务不可用，不自动换端口。
不要猜测端口或将令牌写入日志。
HTTP Upgrade 必须携带正确的 `Authorization`，且不能带 `Origin`。
此入口面向可设置 Upgrade 请求头的本机客户端，不能由普通网页直接连接；
Chrome 扩展使用独立的 Origin／capability 入口。

可直接运行的 [Python WebSocket 示例](examples/python/README.md)演示读取复制配置、
查询模型、创建／恢复会话、发送文本和接收流式回复。

每个 WebSocket 文本消息只包含一条 JSON；入站消息上限为 8 MiB。二进制消息会关闭连接。
WebSocket 断开采用与 stdio EOF 相同的精确运行取消策略。
资源与背压上限由[统一 app-server](../features/integrations/app-server.md)维护。

## 最小调用顺序

按顺序发送请求，并等待每一步的响应；后续请求使用服务端实际返回的 ID：

```json
{ "id": 1, "method": "initialize", "params": { "clientInfo": { "name": "example-client", "version": "1.0.0" } } }
{ "method": "initialized", "params": {} }
{ "id": 2, "method": "model/list", "params": {} }
{ "id": 3, "method": "thread/start", "params": {} }
{ "id": 4, "method": "turn/start", "params": { "threadId": "<thread.id>", "input": [{ "type": "text", "text": "你好" }] } }
```

每连接仅初始化一次。`clientInfo.name` 和 `clientInfo.version` 必须为字符串，
可选 `title` 必须为字符串或 `null`；能力字段按声明类型校验。非法初始化不占用握手状态，
客户端可在同一连接修正后重试初始化。请求 ID 使用字符串或 JavaScript 安全整数；
超出安全整数范围的 ID 应改用字符串。

`initialize` 返回 `{ userAgent, codexHome, platformFamily, platformOs }`，
其中 `codexHome` 是宿主的 `<userData>/app-server` 目录，不是客户端 `CODEX_HOME` 标记目录，
也不是原生历史或登录凭据目录。Windows 的平台值分别为 `windows`／`windows`，
macOS 为 `unix`／`macos`，Linux 为 `unix`／`linux`。
响应后必须发送 `initialized` 通知（其 `params` 可省略、为 `null` 或对象），再发送业务请求。
所有业务调用必须带 `id`，无 `id` 时会被忽略。
`turn/start` 响应后继续接收异步通知；长时间运行不会阻塞 `turn/interrupt` 请求。

## 方法

### `model/list`

返回当前桌面配置中可用的模型，支持 `cursor`、`limit`（默认 50，上限 200，0 返回空页）
以及布尔 `includeHidden`。当前目录只包含已启用且可用的模型，没有额外隐藏目录。
不支持 reasoning effort 覆盖：

```ts
type ModelListResult = {
  data: {
    id: string;
    model: string;
    displayName: string;
    description: string;
    hidden: false;
    isDefault: boolean;
    supportedReasoningEfforts: [];
    defaultReasoningEffort: 'default';
    inputModalities: ['text'];
    supportsPersonality: false;
  }[];
  nextCursor: string | null;
};
```

`description` 在目录未提供说明时为空。`defaultReasoningEffort: 'default'` 表示沿用桌面管理的
原生默认值，不表示禁用推理；不能用此值请求逐轮覆盖。模型输出不包含凭据、服务地址或认证头。

### `thread/start` / `thread/resume`

`thread/start` 接受可选的 `cwd`、`model` 字符串；`null` 按未提供处理。
`model` 使用 `model/list` 返回的 ID。工作目录的默认值由调用上下文和桌面配置确定。

`thread/resume` 额外要求 `threadId`，必须是同一应用 profile 下 CLI 来源、可恢复的
外部会话 ID，可来自普通 CLI、ACP 或 app-server。不能填入桌面产品会话 ID 或原生
session key。省略 `cwd` 时保留该会话的目录；
显式提供时也必须与原目录一致，不能借恢复操作切换工作目录。
服务端仍会校验原生身份、所有权与尚未结算的运行，恢复不等于可以重发未知输入。
默认读取经身份校验的原生历史；`excludeTurns: true` 可跳过回放。历史读取失败时返回错误，
不会将读取失败解释为空历史，也不根据历史正文解除未知执行的占用。

两者返回：

```ts
type ThreadOpenResult = {
  thread: {
    id: string;
    sessionId: string;
    cwd: string;
    name: string | null;
    createdAt: number;
    updatedAt: number;
    modelProvider: string;
    source: 'cli';
    status: { type: 'notLoaded' | 'idle' | 'systemError' } | { type: 'active'; activeFlags: [] };
    turns: Turn[]; // start 或 excludeTurns:true 时为空。
    // 还包含官方 Thread 所需的 cliVersion、ephemeral、preview、projectId 等元数据。
  };
  model: string;
  modelProvider: string;
  cwd: string;
  approvalPolicy: 'on-request' | 'never';
  approvalsReviewer: 'user';
  sandbox: { type: 'externalSandbox'; networkAccess: 'enabled' };
  permissionMode: string; // 产品扩展：真实的会话权限模式。
};
```

时间戳按官方形状使用 Unix 秒。`sessionId` 使用同一外部不透明 ID，不暴露内部原生 SID、
session key 或执行回执。当前各外部入口共用 `source: 'cli'` 命名空间；不按当前连接类型重写历史来源。
`preview` 为空、`path` 为 `null`，元数据查询不会读取消息正文或披露原生文件路径。

配置投影描述 app-server 这一层的行为：有交互审批资源时为 `approvalPolicy: 'on-request'`，
未安装此能力时为 `never`；
`externalSandbox` 表示权限与隔离由原有宿主和原生运行时负责，`networkAccess: 'enabled'`
表示本协议层不另加网络沙箱。它们不授予网络、文件或工具权限；执行仍使用真实 `permissionMode`
与原有审批／权限校验，需审批而本客户端不能处理的操作仍可被拒绝。

同一连接最多绑定 32 个线程（含正在打开的线程），不同线程可并发执行。
同一线程仍受全局执行预留保护，多个客户端不能重复执行或接管彼此的 turn。
产品会话列表中统一归入 `Clients` 分组，中英文界面均使用
该英文名称，不按调用方应用名称细分。

桌面应用管理执行配置。以下非 `null` 覆盖项会被拒绝：
`serviceTier`、`approvalPolicy`、`sandbox`、`modelProvider`、`profile`、
`baseInstructions`、`developerInstructions`、`compactPrompt`、`includeApplyPatchTool`。
`config` 只允许省略、`null` 或空对象；未知字段不保证生效，不能据此假设能力已支持。
非空 `serviceName`、`sessionStartSource`、`threadSource`、`dynamicTools`、`personality`、
`collaborationMode`、`approvalsReviewer` 也会明确拒绝；不支持临时线程和 `historyMode: 'paginated'`
的原生存储模式，已支持的历史分页接口仍使用 `legacy` Thread 载体。

### `thread/list` / `thread/read` / `thread/loaded/list`

`thread/list` 返回 `{ data: Thread[], nextCursor, backwardsCursor: null }`。
只列同一 profile 的可用 CLI 来源映射，不混入 Chrome、普通桌面会话、旧客户端命名空间或已删除记录。
目录、助手或产品映射已失效的条目不会伪装成可恢复会话；数据库故障仍报错。

列表支持 `cursor`、`limit`、`sortKey`（`created_at`／`updated_at`／`recency_at`）、
`sortDirection`（`asc`／`desc`）、`searchTerm`、`modelProviders`、`sourceKinds`、
`cwd`（字符串或字符串数组）和最多 100 个 UUID 的 `excludedThreadIds`。
默认按创建时间倒序，`recency_at` 使用产品会话活动时间。游标绑定查询与排序条件；
改变条件后应从第一页重新查询。`archived: true` 返回空列表，因为本产品不维护该协议的归档分类；
非空 `originators`、具体 `sectionId` 和 `section_position` 排序不受支持。

`thread/read` 默认只读取元数据；`includeTurns: true` 读取完整原生历史。
历史查询要求 Gateway 已连接，不为读取启动运行时。查询不会绑定线程或取得执行、停止所有权。

`thread/loaded/list` 返回 `{ data: string[], nextCursor }`，只报告当前宿主管理的 app-server
连接实际已绑定且尚未退役的线程，支持 `cursor`、`limit`；不把数据库所有记录视为已加载。

### `thread/turns/list` / `thread/items/list`

两者均要求 `threadId`，支持 `cursor`、`limit`（默认 50、上限 200）和
`sortDirection: 'asc' | 'desc'`，返回 `{ data, nextCursor, backwardsCursor }`。
Turn 默认从新到旧，`itemsView` 可为 `notLoaded`、`summary`（默认）或 `full`；
Item 默认从旧到新，可用 `turnId` 限定某一轮。Item 页的数据为 `{ turnId, item, startedAtMs?, completedAtMs? }`。
Item 游标还可为 `{ type: 'item', itemId }`，此时必须提供非空 `turnId`，且锚点自身不重复返回。

游标绑定线程、原生 incarnation、查询参数和快照内容；历史变化后须从第一页重新查询。
完整历史和分页响应受字节容量限制，超限会明确报错，应减小分页范围。
历史通过认证 Gateway 读取，正文只在当前请求内投影，不新增 Main 正文缓存。
Turn 状态仅采用精确运行回执；无法归属的旧消息保留在只读 `history:` 段，
以 `EXECUTION_UNKNOWN:` 标明结果不可核实，不将最终正文当作成功证据。
用户消息也可按原生完整输入幂等标识归入对应轮次；这只建立显示关联，不提供执行授权。
内部恢复／计时记录不会自动成为空 Turn；只有外部映射明确指向的无消息执行可单独保留。

### `thread/unsubscribe`

接受 `{ threadId }`，只撤回当前连接对此线程的实时订阅，不取消任务或解除未知占用。
返回 `{ status: 'unsubscribed' | 'notSubscribed' | 'notLoaded' }`。
空闲且不持有执行的本地绑定可卸载；最后一个加载绑定移除后发送 `thread/closed`。
其他连接的订阅不受影响。
再次 `thread/resume` 可恢复订阅。退订与连接断开不同：断开仍取消本连接拥有的运行。

### `thread/name/set`

接受 `{ threadId, name }`，同样核验 profile、外部映射、助手与目录归属，
可更新已加载或持久化的有效外部会话。名称去除首尾空白后须为 1 到 500 字符，
成功持久保存产品标题、通知桌面列表，并返回 `{}`；响应之后发送
`thread/name/updated { threadId, threadName }`。只改元数据，不接触原生正文或客户端标记文件。

### `turn/start`

```ts
type TurnStartParams = {
  threadId: string;
  input: { type: 'text'; text: string }[];
  model?: string; // 必须来自当前 model/list。
};
```

输入只能是文本数组，不支持 `input_text` 别名、图片、附件、页面上下文或富输入。
多项文本以换行拼接，合并后必须有非空白内容。执行后端限制最多 2,097,152 个 UTF-16
code units；协议入口另校验 UTF-8 文本最多 8 MiB，WebSocket 消息本身也须满足
包含 JSON 包装的大小限制。后端校验发生在本地准入后，超限可能通过异步失败通知返回。
`threadId` 必须是当前连接拥有的会话；活动或结果未知的 turn 尚未解除前拒绝新输入。

以下非 `null` 的逐轮覆盖项会被拒绝：`effort`、`serviceTier`、`cwd`、
`approvalPolicy`、`sandboxPolicy`、`outputSchema`。模型也可逐轮选择，原生后端在准入前真实应用；
权限和其他执行配置沿用桌面应用设置，不提供客户端 MCP 配置 API。
非空 `toolOutput`、`disabledPluginIds`、`serviceTierForTurn`、`summary`、`personality`、
`collaborationMode`、`approvalsReviewer`、`parentTurnId`、`rootTurnId`、`clientUserMessageId`
及 `turnTrigger` 同样明确拒绝，不会静默忽略调用方请求的语义。

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

## 服务端请求与审批

客户端同时处理 `{ id, method, params }` 服务端请求，并使用同一 `id` 回复 `{ id, result }`
或 `{ id, error }`。服务端请求 ID 是唯一字符串，与客户端自己的请求方向独立匹配。
未回复请求最多 64 个；到期、取消、断开、重复或迟到的回复都不能授予权限。
请求结束后可收到 `serverRequest/resolved { threadId, requestId }`。

`item/commandExecution/requestApproval` 包含精确 `threadId`、`turnId`、`itemId`、
`startedAtMs`、命令、目录和原生警告。客户端只能将用户的一次性选择返回为
`{ decision: 'accept' | 'decline' | 'cancel' }`。`cancel` 还请求取消对应 turn，仍须等待原生结算。
`acceptForSession`、策略或网络修订不会降级为授权。许可解决仍由原生路由复核运行身份、
incarnation、当前连接、到期和 allowedDecisions；客户端不能绕过桌面权限规则。

初始化时明确声明 `capabilities.experimentalApi: true` 才展示插件确认，使用
`item/tool/requestUserInput`。只有服务端给出的单个 `permission` 问题和一次性允许选项，
以 `{ answers: { permission: { answers: ['<advertised-label>'] } } }` 回复才可请求允许；
自由文本、额外答案及其他形状均拒绝。不支持文件变更审批、持久授权、通用 elicitation 或动态工具注册。
Python 示例默认拒绝审批；生产客户端应向用户展示请求并收集选择。

## 通知与 Item

所有执行通知的 `params` 均包含 `threadId` 和 `turnId`：

| 方法                       | 其余字段                             |
| -------------------------- | ------------------------------------ |
| `turn/started`             | `turn: { id, items: [], itemsView: 'notLoaded', status: 'inProgress', error: null }` |
| `item/started`             | `item, startedAtMs`                   |
| `item/completed`           | `item, completedAtMs`                 |
| `item/agentMessage/delta`  | `itemId, delta`                      |
| `item/reasoning/textDelta` | `itemId, contentIndex: 0, delta`     |
| `turn/completed`           | `turn: { id, items: [], itemsView: 'notLoaded', status, error }` |

Turn 响应及开始／完成通知均含官方必需的 `items`；使用 `itemsView: 'notLoaded'` 明确说明
此载体未加载正文，不为完整 Turn 建立 Main transcript 缓存。Turn 时间为 Unix 秒，
`durationMs` 与 item 时间字段为毫秒。

成功创建线程后还会在响应之后发送 `thread/started { thread }`，恢复不冒充新建。
绑定线程的执行状态变化通过 `thread/status/changed { threadId, status }` 通知；
该通知不替代精确原生终态证据。

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
工具投影保留开始时的名称／参数和真实输出，MCP `content`／`structuredContent` 按原值返回；
原生 `content`／`details` 结果将 `details` 投影为结构化内容。已明确隐藏的工具与
尚未通过原生 guard 提交的正文不会输出。工具元数据和去重 ID 均有容量上限，完成结果不另存历史缓存。

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

新连接可查询历史，并通过 `thread/resume` 订阅后续事件；不会重放错过的实时通知。
稳定 URL 和令牌只简化连接参数管理；每条新连接仍需重新 `initialize` 并明确创建或恢复会话。
断线、超时或未知结果后不能自动重新提交原输入；恢复会话仍须通过服务端的身份和占用校验。
取消与回收依赖精确原生运行身份及终态证据，详见[执行生命周期](../features/integrations/app-server.md)。

## 错误

未初始化、无效请求或重复初始化返回 `-32600`；明确的参数校验失败／不支持的参数为 `-32602`，
未实现方法为 `-32601`，其他业务错误为 `-32000`。WebSocket 非法 JSON 返回 `-32700`；stdio 非法 JSON 关闭连接。
不支持的方法包括 `thread/image`、`composer/options`、
`browser/extension/pair`、`turn/steer`、账户、配置和文件变更审批 API。
不能套用 Chrome 的错误码、`error.data.requestSent` 或恢复策略。

权威实现为 `src/main/integrations/externalAgent/cliAppServerBinding.ts`、
`codexAppServerProgress.ts` 与 `src/main/appServer/appServerIntegrationService.ts`。
