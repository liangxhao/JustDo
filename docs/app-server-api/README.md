# App-server 接口文档

本目录描述桌面应用当前实现的 Codex app-server 兼容接口，面向外部客户端开发者。
支持范围以本文档和仓库实际注册代码为准，不承诺完整的上游 API。
协议引擎共用，入口的鉴权、会话范围和能力集分别确定。

## 选择入口

| 入口                  | 连接方式                                              | 规范                              |
| --------------------- | ----------------------------------------------------- | --------------------------------- |
| CLI stdio             | `<cli> app-server --listen stdio://`                  | [通用客户端](external-clients.md) |
| 本机 WebSocket        | 从“设置 → 外部连接 → 应用接入”复制 URL 与 Bearer 配置 | [通用客户端](external-clients.md) |
| Chrome 扩展 WebSocket | Native Messaging 发现扩展专用 URL                     | [Chrome 扩展](browser/README.md)  |

`<cli>` 表示应用提供的命令路径。stdio 与本机 WebSocket 使用相同的通用能力集；
Chrome 入口提供浏览器侧栏所需的扩展能力。入口由连接时的服务端 binding 决定，
`clientInfo` 或 `capabilities` 不会切换入口或提升权限。

普通 CLI 命令和 `acp` 参数使用各自的命令／协议适配器，不属于 app-server wire API，
详见 [CLI 与 ACP](../features/integrations/agent-cli.md)。运行架构和资源生命周期见
[统一 app-server](../features/integrations/app-server.md)。

## 消息外形

请求、响应与通知使用 JSON 对象，省略 `jsonrpc` 标头。请求的 `id` 为字符串或有限数字；
通知没有 `id`。不支持批量请求。stdio 每行一条 JSON，WebSocket 每个文本消息一条 JSON。

```json
{
  "id": 1,
  "method": "initialize",
  "params": { "clientInfo": { "name": "example-client", "version": "1.0.0" } }
}
```

```json
{ "id": 1, "result": { "userAgent": "<ProductName>/codex-compatible", "platformOs": "win32" } }
```

```json
{ "id": 2, "error": { "code": -32000, "message": "Method not found." } }
```

```json
{
  "method": "turn/started",
  "params": { "threadId": "thread-id", "turn": { "id": "turn-id", "status": "inProgress" } }
}
```

上述响应示例来自通用入口，各入口的实际字段以对应规范为准。
客户端按 `id` 匹配响应，按方法名处理通知，忽略未知响应字段和通知。
`initialize.params.capabilities.optOutNotificationMethods` 可按精确方法名关闭通知，
不提供额外能力协商。

## 能力边界

| 行为               | CLI stdio / 本机 WebSocket                        | Chrome 扩展                                            |
| ------------------ | ------------------------------------------------- | ------------------------------------------------------ |
| 初始化             | `initialize` 响应后可调用；`initialized` 通知可选 | 响应后必须发送 `initialized` 通知                      |
| 无 `id` 的业务调用 | 忽略，不启动任务                                  | 执行已支持的方法，不返回响应                           |
| 会话范围           | 每连接创建或恢复一个 CLI 来源会话                 | 仅扩展来源会话，按连接订阅                             |
| 模型发现           | `model/list`                                      | `composer/options`                                     |
| 会话与历史         | `thread/start`、`thread/resume`；不回放历史       | `thread/list/read/start/unsubscribe`、`thread/updated` |
| 输入               | 文本                                              | 文本、附件、页面上下文及侧栏模型／权限选项             |
| 实时输出           | `item/*` 通知                                     | `thread/stream`，历史经 `thread/updated` 校准          |
| 停止               | `turn/interrupt` 精确匹配当前连接拥有的 turn      | `turn/interrupt` 精确匹配已绑定的运行                  |
| 断开               | 取消当前连接拥有的运行并进行原生清理              | 退订；已接纳的运行继续执行                             |

共享的方法名不代表字段、返回值或恢复方式相同。通用入口的 `turn/completed` 不含
Chrome 的 `executionSettled` 字段；未知结果还可能以 `failed` 加 `EXECUTION_UNKNOWN:`
前缀报告，不能据此判断原生执行已失败或自动重发。详见各入口的生命周期说明。

## 错误与限制

| 场景                                          | CLI stdio / 本机 WebSocket | Chrome 扩展 |
| --------------------------------------------- | -------------------------- | ----------- |
| 无效请求对象、非法 `id`／`method`、重复初始化 | `-32600`                   | `-32600`    |
| 尚未初始化                                    | `-32000`                   | `-32002`    |
| 未实现方法                                    | `-32000`                   | `-32601`    |
| 参数或业务错误                                | `-32000`                   | `-32603`    |

WebSocket 非法 JSON 返回 `-32700`。stdio 非法 JSON 会关闭协议连接，不能依赖同样的
错误响应或恢复行为。连接丢失、RPC 超时和停止 ACK 均不能证明执行已结算；
不要将未知输入自动重发。

Chrome 的 `requestSent` 错误数据、历史模型和 Native Messaging 版本号均属于
[Chrome 规范](browser/README.md)，不适用于通用入口。

## 实现入口

- 公共协议与路由：`src/main/appServer/appServerConnection.ts`、`appServerProtocol.ts`。
- 通用本机 WebSocket：`src/main/appServer/appServerIntegrationService.ts`。
- 通用客户端能力：`src/main/integrations/externalAgent/cliAppServerBinding.ts`。
- Chrome 能力：`src/main/browser/extension/browserAppServerBinding.ts`。

各适配器共用原生执行与历史权威，不建立独立的 transcript 缓存。
