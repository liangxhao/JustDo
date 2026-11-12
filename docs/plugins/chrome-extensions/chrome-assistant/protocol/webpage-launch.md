# 网页关联操作

`chrome/webLaunch/*` 是扩展维护者对接桌面端的内部接口，只挂载到 Chrome 专用 capability binding。
第三方业务网页通过随包 SDK 接入，由扩展持有连接凭据并调用内部方法。见[网页 SDK](../website-sdk.md)和[网页入口的行为与验证限制](../website-launch.md)。

## 方法与调用方

| 方法后缀         | 调用方            | 用途                                                                                                           |
| ---------------- | ----------------- | -------------------------------------------------------------------------------------------------------------- |
| `sites/read`     | 后台、设置        | 读取 Main 站点策略和全局 revision。                                                                            |
| `sites/write`    | 可信设置、连接卡  | 使用 `expectedRevision` 更新精确 origin 的 `enabled`、`allowSend`、`allowResult`，竞争返回 `POLICY_CONFLICT`。 |
| `prepare`        | 后台点击/受限续接 | 校验来源、文档序号、配置摘要；原子创建会话和元数据回执。                                                       |
| `revise`         | 可信侧栏          | 使用 `composeRevision` 修改实际输入摘要，撤销自动许可。                                                        |
| `submit`         | 可信侧栏          | 自动或人工确认的单次认领和发送；不重试未知执行。                                                               |
| `read`           | 后台原文档路径    | 查询回执，以及获准的精确本轮结果。                                                                             |
| `cancel`         | 后台原文档路径    | 撤销未发送请求或分享，派发后返回 `TOO_LATE`。                                                                  |
| `revokeDocument` | 后台              | 终止性撤销原文档租约。                                                                                         |
| `stop`           | 可信侧栏          | 为本 launch 保存停止意图；仅停止精确绑定首轮。                                                                 |
| `observations`   | 可信侧栏、设置    | 独立刷新并读取观察元数据，不返回最终正文。                                                                     |
| `abandon`        | 可信侧栏、设置    | 用户确认放弃观察，关闭旧 owner 并保留防重证据。                                                                |

每个请求须有 RPC `id`，通知形态不执行副作用。参数严格检查字段、类型和大小。
`contracts/webLaunch.ts` 的纯类型与常量在组装时编译为扩展自己的模块，插件不导入应用 `src`。

这些方法由浏览器领域以固定白名单注册到共享协议的 `extensions`，不会因此开放到通用 Bearer／stdio 入口。
网页站点的发送／分享许可与原生工具审批分别核验；既有网页请求不能取得另一轮次的审批 owner、
命令会话授权或持久 App 权限。普通侧栏增加标准图片不改变本接口仅支持文本输入的契约。

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
};
```

### 来源校验与防重

- 后台以浏览器 `MessageSender` 为来源，网页字段不能覆盖。`payloadDigest` 是 `canonicalWebLaunchInput` 的 UTF-8 SHA-256。
- 相同文档请求身份与摘要返回原回执。同 ID 换内容返回 `REQUEST_CONFLICT`。
- 已消费的序号若缺少完整回执，返回 `EXPIRED`，不重新创建会话。

### 首次连接与受限续接

1. 扩展通过独立的 `runtime.onMessageExternal` 接收连接 `probe`、`request`、`query`、`cancel`。入口仅处理这四种连接消息，不能代理 Native discovery、任意 RPC 或业务任务的 `prepare`／`submit`。扩展管理外部来源、待确认身份、绝对期限、原文档绑定和单次续接，Main 不增加待确认状态或正文存储。
2. 首次连接卡只授予 `{enabled:true, allowSend:false, allowResult:false}`。写入使用待确认时冻结的全局 `expectedRevision`，冲突后不刷新版本自动重试。
3. 受限 `prepare` 成对传入 `connectionOnly:true` 和授权写入返回的全局 `expectedPolicyRevision`。`false`、缺失 revision 或单独 revision 均拒绝。Main 在同一同步事务内比较全局 revision，关闭自动发送和既有结果分享许可，同时保留原 `input` 和 `payloadDigest`。已存在的较高授权回执不能重新解释为受限续接。
4. 可信侧栏仍需分别确认发送与分享。

### ACK 丢失与只读恢复

`prepare` 或 `submit` 的 ACK 丢失后只调用 `read`。未知 launch／lease 时用 `source + requestId` 找回回执，已知时用 `source + documentLeaseId + launchId`。
同一仍 active 的文档可用新 `channelGeneration` 只读重连。文档租约终止撤销后不可恢复。

## 回执与内部字段

```ts
type Receipt = {
  requestId: string;
  launchId: string;
  receiptRevision: number;
  request: { status: string };
  execution: { status: string; executionSettled: boolean };
  output: { status: string; text?: string; format?: 'text' };
  delivery: { status: string };
  error?: { code: string; messageKey: string };
};
```

Main 返回 `{receipt, internal}`，后台仅用 `receipt` 的允许字段逐项重建网页可见 Receipt。
`executionSettled` 只来自同一 native run 的精确整轮终态。

| `internal` 字段                                                                    | 用途                     |
| ---------------------------------------------------------------------------------- | ------------------------ |
| `threadId`、`documentLeaseId`                                                      | 宿主会话和原文档租约     |
| `composeRevision`、`deadlineAt`                                                    | 实际输入版本和准入期限   |
| `requiresSendConfirmation`、`requiresResultConsent`、`requiresUnknownConfirmation` | 侧栏需确认的条件         |
| `clientTurnId`、`nativeRunId`（可选）                                              | 客户端提交和原生运行身份 |

### 提交与结果释放

- `submit` 包含 `launchId`、`composeRevision`、实际 `input`、`submission:'automatic'|'confirmed'` 和 `shareResult`。
  人工确认可选择 `rememberSend`、`rememberResult` 和 `confirmNewTask`。实际 `input` 中的 `modelRef`、`permissionMode` 只能由可信侧栏的人类操作提供。
- `chrome/webLaunch/changed` 向当前连接发送空参数，只提示重读策略或观察。正文、凭据、终态及发送权限均不通过该通知交付。
- 只有当前原文档租约的 `read` 在最后一次权限核验后可以返回正文。

### 错误数据

错误采用闭合 `code` 和 `webLaunchError<CODE>` 安全文案键，未知异常统一为 `INTERNAL_ERROR`。
RPC envelope 不透传底层 `message`、`stack`、路径或 token。浏览器桥和传输错误另行映射为有限公开码。
