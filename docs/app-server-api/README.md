# App-server 接口文档

本目录维护面向外部客户端的 Codex app-server 兼容接口，包括 CLI stdio、本机 WebSocket、
线程与执行、标准输入、历史、通知和双向审批。两种传输使用相同的通用能力集。
支持范围以本文档和仓库实际注册代码为准，不承诺完整的上游 API。
官方协议对照、已补齐项目和剩余边界见[兼容性说明](compatibility.md)。

## 选择入口

| 入口           | 连接方式                                              | 规范                              |
| -------------- | ----------------------------------------------------- | --------------------------------- |
| CLI stdio      | `<cli> app-server --listen stdio://`                  | [通用客户端](external-clients.md) |
| 本机 WebSocket | 从“设置 → 外部连接 → 应用接入”复制 URL 与 Bearer 配置 | [通用客户端](external-clients.md) |

`<cli>` 表示应用提供的命令路径。连接建立时，服务端确定可调用能力和会话范围；
`clientInfo` 或 `capabilities` 不会切换入口或提升权限。

快速开始：[Python WebSocket 调用示例](examples/python/README.md)。

普通 CLI 命令和 `acp` 参数使用各自的命令／协议适配器，不属于 app-server wire API，
详见 [CLI 与 ACP](../features/external-clients/agent-cli.md)。运行架构和资源生命周期见
[连接与执行架构](../features/external-clients/app-server.md)。

## 消息外形

请求、响应与通知使用 JSON 对象，省略 `jsonrpc` 标头。请求的 `id` 为字符串或安全整数；
通知没有 `id`。不支持批量请求。stdio 每行一条 JSON，WebSocket 每个文本消息一条 JSON。

```json
{
  "id": 1,
  "method": "initialize",
  "params": { "clientInfo": { "name": "example-client", "version": "1.0.0" } }
}
```

```json
{
  "id": 1,
  "result": {
    "userAgent": "<ProductName>/codex-compatible",
    "codexHome": "<absolute-server-home>",
    "platformFamily": "windows",
    "platformOs": "windows"
  }
}
```

```json
{ "id": 2, "error": { "code": -32601, "message": "Method not found." } }
```

```json
{
  "method": "turn/started",
  "params": {
    "threadId": "thread-id",
    "turnId": "turn-id",
    "turn": {
      "id": "turn-id",
      "items": [],
      "itemsView": "notLoaded",
      "status": "inProgress",
      "error": null,
      "startedAt": 1793923200,
      "completedAt": null,
      "durationMs": null
    }
  }
}
```

客户端按 `id` 匹配响应，按方法名处理通知，忽略未知响应字段和通知。
服务端也会发送带 `id` 的审批请求；客户端须先按是否包含 `method` 区分请求与响应，
不能把同方向的 ID 匹配逻辑直接用于另一方向。完整往返示例见[服务端请求与审批](external-clients.md#服务端请求与审批)。
`initialize.params.capabilities.optOutNotificationMethods` 可按精确方法名关闭通知，
不会将未实现的能力变成可用能力。

## 能力边界

| 行为               | CLI stdio / 本机 WebSocket                           |
| ------------------ | ---------------------------------------------------- |
| 初始化             | `initialize` 响应后必须发送 `initialized` 通知       |
| 无 `id` 的业务调用 | 忽略，不启动任务                                     |
| 会话范围           | 每连接绑定多个 CLI 来源会话，按线程订阅              |
| 模型发现           | `model/list`                                         |
| 会话与历史         | 创建、恢复、列表/读取/改名、Turn/Item 历史分页、退订 |
| 输入               | 标准文本、image、localImage；支持纯图片              |
| 实时输出           | 标准 `item/*` 通知                                   |
| 客户端审批         | 命令允许／拒绝／取消；实验性会话授权及插件确认       |
| 停止               | `turn/interrupt` 精确匹配当前连接拥有的 turn         |
| 断开               | 取消当前连接拥有的运行并进行原生清理                 |

标准 `turn/completed` 不包含 `executionSettled` 字段；服务端须先核实精确原生整轮证据，再发布确认的执行结果。
未知结果仍可能以 `failed` 加 `EXECUTION_UNKNOWN:` 前缀报告，不能据此判断原生执行已失败
或自动重发。`thread/read` 不隐式订阅，客户端以 `thread/resume` 明确观察。

图片保留相对次序，原生输入归一为合并文字和有序图片；不承诺文字与图片交错的位置。
图片最多 5 张、原始字节合计 4 MiB，标准输入文字最多 2 MiB（UTF-8）。
`localImage` 必须位于线程绑定的真实工作目录内；远程图片仅支持受限私网 IP 字面地址。
具体格式、编码预算和权限边界见[图片输入](external-clients.md#turnstart)。

## 错误与限制

| 场景                                          | 错误码   |
| --------------------------------------------- | -------- |
| 无效请求对象、非法 `id`／`method`、重复初始化 | `-32600` |
| 尚未初始化                                    | `-32600` |
| 未实现方法                                    | `-32601` |
| 已识别的参数错误或不支持的覆盖项              | `-32602` |
| 其他业务错误                                  | `-32000` |

WebSocket 非法 JSON 返回 `-32700`。stdio 非法 JSON 会关闭协议连接，不能依赖同样的
错误响应或恢复行为。连接丢失、RPC 超时和停止 ACK 均不能证明执行已结算；
不要将未知输入自动重发。

`turn/start` 错误只在后端有明确证据时携带布尔 `error.data.requestSent`，不能从错误码推断是否已发送。

## 实现入口

- 公共协议与路由：`src/main/clients/appServer/protocol/appServerConnection.ts`、`appServerProtocol.ts`。
- 公共投影与历史：同目录的 `appServerWire`、`appServerPagination`、`appServerHistory`、
  `appServerHistoryReader`、`appServerProgress`、`appServerToolProgress`。
- 公共输入与审批：同目录的 `appServerInput`、`appServerApprovals`；原生审批归属仍由宿主权限路由拥有。
- 通用本机 WebSocket：`src/main/clients/appServer/appServerIntegrationService.ts`。
- 通用客户端能力：`src/main/clients/appServer/client/externalAppServerBinding.ts`。

两种传输共用原生执行与历史权威，不建立独立的 transcript 缓存。
