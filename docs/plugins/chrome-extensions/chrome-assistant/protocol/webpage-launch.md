# 网页关联操作

`chrome/webLaunch/*` 是扩展维护者对接桌面端的内部接口，只挂载到 Chrome 专用 capability binding。
第三方业务网页通过随包 SDK 接入，由扩展持有连接凭据并调用内部方法。见[网页 SDK](../website-sdk.md)和[网页入口的行为与验证限制](../website-launch.md)。

## 方法与调用方

| 方法后缀          | 调用方            | 用途                                                                                                           |
| ----------------- | ----------------- | -------------------------------------------------------------------------------------------------------------- |
| `sites/read`      | 后台、设置        | 读取 Main 站点策略、全局 revision 和顶层 `sendMode`。                                                          |
| `sites/write`     | 可信设置、连接卡  | 使用 `expectedRevision` 更新精确 origin 的 `enabled`、`allowSend`、`allowResult`，竞争返回 `POLICY_CONFLICT`。 |
| `sites/send-mode` | 可信设置          | 提交 `{sendMode, expectedRevision}`，设置所有已连接网站的后续请求发送方式。                                    |
| `prepare`         | 后台点击/受限续接 | 校验来源、文档序号、配置摘要；原子创建会话和元数据回执。                                                       |
| `revise`          | 可信侧栏          | 使用 `composeRevision` 修改实际输入摘要，撤销自动许可。                                                        |
| `submit`          | 可信侧栏          | 自动或人工确认的单次认领和发送；不重试未知执行。                                                               |
| `read`            | 后台原文档路径    | 查询回执，以及获准的精确本轮结果。                                                                             |
| `cancel`          | 后台原文档路径    | 撤销未发送请求或分享，派发后返回 `TOO_LATE`。                                                                  |
| `revokeDocument`  | 后台              | 终止性撤销原文档租约。                                                                                         |
| `stop`            | 可信侧栏          | 为本 launch 保存停止意图；仅停止精确绑定首轮。                                                                 |
| `observations`    | 可信侧栏、设置    | 独立刷新并读取观察元数据，不返回最终正文。                                                                     |
| `abandon`         | 可信侧栏、设置    | 用户确认放弃观察，关闭旧 owner 并保留防重证据。                                                                |

每个请求须有 RPC `id`，通知形态不执行副作用。参数严格检查字段、类型和大小。
`contracts/webLaunch.ts` 的纯类型与常量在组装时编译为扩展自己的模块，插件不导入应用 `src`。

这些方法由浏览器领域以固定白名单注册到共享协议的 `extensions`，不会因此开放到通用 Bearer／stdio 入口。
站点连接授权涵盖后续发送与回传。原生工具或命令审批的 owner 仍按原生运行核验。持久 App 权限仍由原生 action 授权。
普通侧栏支持标准图片，本接口只接收文本输入。

## 准备与来源

```ts
type Prepare = {
  source: {
    chromeInstanceId: string;
    windowInstanceId: string;
    windowId: number;
    tabId: number;
    frameId: 0;
    documentId: string;
    channelGeneration: number;
    origin: string;
    url?: string;
    title?: string;
  };
  documentLeaseId?: string;
  requestId: string;
  bindingRevision: number;
  clickSequence: number;
  payloadDigest: string;
  input: {
    prompt: string;
    context?: { text: string };
    mode: 'draft' | 'send';
    result: 'none' | 'final';
  };
  connectionOnly?: true;
  expectedPolicyRevision?: number;
  expectedQueuedPolicyRevision?: number;
};
```

### 来源校验与防重

- 后台以浏览器 `MessageSender` 为来源，网页字段不能覆盖。`payloadDigest` 是 `canonicalWebLaunchInput` 的 UTF-8 SHA-256。
- 后台为原文档的新真实点击发送 `prepare`，由 Main 按当前文档来源选择有效租约或创建新租约。成功接纳的回执各自保留租约 ID，站点授权和已消费的点击序号跨租约生效。
- `prepare` 在同一事务内为预留的产品会话记录待首发标记。侧栏可以恢复该草稿。Chrome 聊天 Controller 在核验首条原生发送 ACK 后清除标记，桌面目录和搜索此时才展示该会话。
- 相同文档请求身份与摘要返回原回执。同 ID 换内容返回 `REQUEST_CONFLICT`。
- 已消费的序号若缺少完整回执，返回 `EXPIRED`，不重新创建会话。

### 网页消息发送方式

顶层 `sendMode` 取 `'website'`、`'send'` 或 `'draft'`，默认 `'website'`。Main 接纳新请求时决定实际的发送方式。`'website'` 使用网页的 `input.mode`，另外两个值覆盖 `input.mode`。原始 `input` 用于校验 `payloadDigest`，其中的 `result` 决定是否请求回传。

`sites/send-mode` 使用全局 `expectedRevision` 更新这一设置，竞争返回 `POLICY_CONFLICT`。已接纳的请求沿用原有的发送方式和回传状态。触发连接授权的请求始终等待手动发送。

### 首次连接与受限续接

1. 扩展通过独立的 `runtime.onMessageExternal` 接收连接 `probe`、`request`、`query`、`cancel`。入口仅处理这四种连接消息，不能代理 Native discovery、任意 RPC 或业务任务的 `prepare`／`submit`。扩展管理外部来源、待确认身份、绝对期限、原文档绑定和单次续接，Main 不增加待确认状态或正文存储。
2. 用户在侧栏同意连接后，后台对精确 origin 写入 `{enabled:true, allowSend:true, allowResult:true}`。写入使用待确认时冻结的全局 `expectedRevision`，冲突后等待新的连接请求。已有完整授权时可沿用原记录。旧站点缺少任一权限时，需要通过连接卡确认完整授权范围。新版后台只把三项均为 `true` 的站点视为已连接。
3. 受限 `prepare` 成对传入 `connectionOnly:true` 和确认连接时的全局 `expectedPolicyRevision`。`false`、缺失 revision 或单独 revision 均拒绝。Main 在同一同步事务内比较全局 revision，保留原 `input` 和 `payloadDigest`，强制原请求等待侧栏手动发送。已存在的较高授权回执不能重新解释为受限续接。
4. 用户在可信侧栏点击发送时确认该次操作。请求为 `final` 时，这一点击同时确认本轮回传。

每个窗口可保留一笔等待中的连接申请。窗口仍有待处理输入或任务队列时，初始状态为 `waiting-for-window`，保留原浏览器文档、绑定和两分钟期限。输入可用后重新读取策略，进入 `awaiting-consent`。已有连接申请时，后来的点击收到 `waiting-for-connection`，网页提示回原标签页处理已有申请。

已具备当前站点授权和 Chrome host permission 的页面可由 `probe` 按精确浏览器文档修复内容桥。修复只注入内容脚本，后续发送仍需要新真实点击。

### ACK 丢失与只读恢复

`prepare` 或 `submit` 的 ACK 丢失后只调用 `read`。尚未收到本次 `prepare` 的 ACK 时用 `source + requestId` 找回回执，已知回执时用 `source + documentLeaseId + launchId`。后台只从新接纳或找回的本次请求更新文档租约；迟到的旧请求响应不能改写当前租约。
同一仍 active 的文档可用新 `channelGeneration` 只读重连。文档租约终止撤销后不可恢复。

每次真实点击都分配新的 requestId 和点击序号。后台在点击链上调用 `sidePanel.open()`，再按 Chrome 窗口保存有界 FIFO。若 Chrome 未打开侧栏，已授权的点击保留在队列里，用户可通过工具栏打开侧栏。队首在前一请求获得精确原生发送确认或已关闭，且原标签页和侧栏输入框可用后，使用原点击快照进入 `prepare`。若输入框在接纳后被占用，侧栏保留该笔已接纳请求，等输入框可用后再切换。已获得绑定的请求继续独立执行和回传结果。

同一网页的新点击到达队首时，可以替换侧栏当前关联且等待手动发送的网页草稿。后台核对原文档和当前侧栏，再用旧请求的来源、租约和 launchId 调用 `cancel`，附上新点击序号与入队时的策略版本。Main 只关闭尚未开始发送的手动草稿，并通过可信回执确认替换。旧草稿确认取消后，队首进入独立准入。若旧请求的发送已开始，它保留原回传权限，队首继续等待发送确认。

等待中可以用原句柄查询或取消。网页得到 `queueStatus`，Main 接纳后才得到正式回执和 launchId。排队输入最长保留 15 分钟。提升队首时重新检查原文档、站点权限、输入框和绝对期限，并由 Main 在准入事务里用 `expectedQueuedPolicyRevision` 比较入队时的全局策略版本。直接点击后立即准入的路径沿用当前策略。未知 Prepare 保留只读恢复，队列不会重放原点击。

## 回执与内部字段

```ts
type Receipt = {
  requestId: string;
  launchId: string;
  receiptRevision: number;
  request: { status: string };
  execution: { status: string; executionSettled: boolean };
  output: {
    status: string;
    text?: string;
    format?: 'text';
    artifacts?: Array<{
      name: string;
      kind: 'image' | 'audio' | 'video' | 'document';
      mimeType?: string;
    }>;
  };
  delivery: { status: string };
  error?: { code: string; messageKey: string };
};
```

Main 返回 `{receipt, internal}`，后台仅用 `receipt` 的允许字段逐项重建网页可见 Receipt。
`executionSettled` 只来自同一 native run 的精确整轮终态。

| `internal` 字段                                                                    | 用途                                          |
| ---------------------------------------------------------------------------------- | --------------------------------------------- |
| `threadId`、`documentLeaseId`                                                      | 宿主会话和原文档租约                          |
| `composeRevision`、`deadlineAt`                                                    | 实际输入版本和准入期限                        |
| `effectiveMode`（可选）                                                            | 接纳时生效的发送方式                          |
| `permissionMode`（可选）                                                           | 可信侧栏使用的草稿权限                        |
| `requiresSendConfirmation`、`requiresResultConsent`、`requiresUnknownConfirmation` | 侧栏需确认的条件                              |
| `clientTurnId`、`nativeRunId`（可选）                                              | 客户端提交和原生运行身份                      |
| `notSent`（可选）                                                                  | Main 已确认本次输入未发送，侧栏可撤回临时气泡 |

### 提交与结果释放

- `submit` 包含 `launchId`、`composeRevision`、实际 `input`、`submission:'automatic'|'confirmed'` 和 `shareResult`。
  当前侧栏对 `result:'final'` 提交 `shareResult:true`，人工发送同时确认本轮回传。后续真实点击在站点授权范围内按 `effectiveMode` 和网页的 `result` 处理。已有 `rememberSend`、`rememberResult` 字段保留以兼容旧侧栏。用户在侧栏手动发送时，侧栏提交 `confirmNewTask:true`，授权当前这次请求独立执行。旧任务的状态仍由原回执跟踪。
- Main 为新草稿写入 `full` 权限，旧回执缺少该字段时按 `ask` 读取。自动发送核验准备时的实际输入和权限。可信侧栏可以通过 `revise` 修改权限或模型，修改后由用户手动发送。草稿权限只传给扩展，网页无法提供或读取此字段。
- `chrome/webLaunch/changed` 向当前连接发送空参数，只提示重读策略或观察。正文、凭据、终态及发送权限均不通过该通知交付。
- 只有当前原文档租约的 `read` 在最后一次权限核验后可以返回最终文本和交付件描述。交付件描述只含文件名、类别和可选 MIME 类型。

### 错误数据

错误采用闭合 `code` 和 `webLaunchError<CODE>` 安全文案键，未知异常统一为 `INTERNAL_ERROR`。
RPC envelope 不透传底层 `message`、`stack`、路径或 token。浏览器桥和传输错误另行映射为有限公开码。
