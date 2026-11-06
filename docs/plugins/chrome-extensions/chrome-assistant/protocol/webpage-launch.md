# 网页关联操作

`chrome/webLaunch/*` 只挂载到 Chrome 专用 capability binding，供扩展维护者对接桌面端。第三方业务网页使用[网页 SDK](../website-sdk.md)，不能直接持有连接凭据或调用这些方法。产品行为与验证限制见[网页入口](../website-launch.md)。

## 方法与调用方

| 方法后缀         | 调用方           | 用途                                                                                                 |
| ---------------- | ---------------- | ---------------------------------------------------------------------------------------------------- |
| `sites/read`     | 后台、设置       | 读取 Main 站点策略和全局 revision。                                                                  |
| `sites/write`    | 可信设置         | 使用 expectedRevision 更新精确 origin 的 enabled、allowSend、allowResult；竞争返回 POLICY_CONFLICT。 |
| `prepare`        | 后台真实点击路径 | 校验来源、文档序号、配置摘要；原子创建会话和元数据回执。                                             |
| `revise`         | 可信侧栏         | 使用 composeRevision 修改实际输入摘要，撤销自动许可。                                                |
| `submit`         | 可信侧栏         | 自动或人工确认的单次认领和发送；不重试未知执行。                                                     |
| `read`           | 后台原文档路径   | 查询回执，以及获准的精确本轮结果。                                                                   |
| `cancel`         | 后台原文档路径   | 撤销未发送请求或分享；派发后返回 TOO_LATE。                                                          |
| `revokeDocument` | 后台             | 终止性撤销原文档租约。                                                                               |
| `stop`           | 可信侧栏         | 为本 launch 保存停止意图；仅停止精确绑定首轮。                                                       |
| `observations`   | 可信侧栏、设置   | 独立刷新并读取观察元数据，不返回最终正文。                                                           |
| `abandon`        | 可信侧栏、设置   | 用户确认放弃观察，关闭旧 owner 并保留防重证据。                                                      |

请求必须有 RPC id；通知形态不执行副作用。参数严格检查字段、类型和大小。纯类型与常量位于 `contracts/webLaunch.ts`；组装时编译为扩展自己的纯模块，插件不导入应用 `src`。

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
};
```

来源由后台根据浏览器 MessageSender 构造，不接受网页覆盖。digest 是纯契约 `canonicalWebLaunchInput` 的 UTF-8 SHA-256。相同文档请求身份与摘要只返回原回执；同 ID 换内容为 REQUEST_CONFLICT。消费过的序号缺少完整回执时返回 EXPIRED，不重新创建。

Prepare/Submit ACK 丢失后只能 Read，不重放副作用。Read 可使用 `source + requestId` 找回未知 launch/lease；已知时使用 `source + documentLeaseId + launchId`。同一仍 active 文档允许新 channelGeneration 的只读重连，终止撤销后不可恢复。

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

Main 返回 `{receipt, internal}`。internal 包含 threadId、documentLeaseId、composeRevision、deadlineAt、requiresSendConfirmation、requiresResultConsent、requiresUnknownConfirmation，以及可选 clientTurnId/nativeRunId。后台逐字段重建网页可见 Receipt，不向网页转发 internal。`executionSettled` 只来自同一 native run 的精确整轮终态。

Submit 包含 launchId、composeRevision、实际 input、`submission:'automatic'|'confirmed'` 和 shareResult；人工确认可选择 rememberSend、rememberResult 和 confirmNewTask。实际 input 可含 modelRef/permissionMode，但这些字段仅来自可信侧栏的人类操作，网页参数不允许指定。

`chrome/webLaunch/changed` 向当前连接发送空参数，提示重读策略/观察，不携带正文、凭据或终态，也不授予发送权限。正文只能由当前原文档租约的 Read 在最后一次权限核验后返回。

错误采用闭合 code 和 `webLaunchError<CODE>` 安全文案键；未知异常收敛为 INTERNAL_ERROR。RPC envelope 不透传底层 message、stack、路径或 token。浏览器桥/传输错误另外映射为有限公开码。
