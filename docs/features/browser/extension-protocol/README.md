# Chrome 扩展内部接口

本目录面向扩展和桌面端维护者，描述扩展与桌面应用之间的 Native Messaging、共享 app-server 的浏览器附加能力和网页桥内部契约。
第三方业务网页应从[网页接入指南](../../../developer-integration/chrome-extension-web-integration.md)使用随包 SDK，不直接调用本目录中的内部接口。

基础 Thread／Turn／Item 与 CLI stdio、通用本机 WebSocket 一致；Native Messaging、browser 字段和网页桥只对浏览器 binding 开放。
通用入口与能力对照见 [app-server 总览](../../../app-server-api/README.md)，外部客户端接入见
[通用客户端](../../../app-server-api/external-clients.md)。

Chrome 扩展与桌面应用通信以 Codex 公开 JSON-RPC v2 形态为基线，
具体官方来源和 Schema 对照以[统一兼容性说明](../../../app-server-api/compatibility.md#对照依据)为准，
只实现已列出的兼容子集。Native Messaging 启动协议来自
对本机 ChatGPT 扩展 `1.26.901.11451` 的静态分析，不属于 OpenAI 公开 API。

历史协议参考基线为 2026-09-18；当前支持范围以本目录和仓库实际注册代码为准，
不将当时观察的外部客户端版本作为现行兼容保证。实时消息已接入产品
`browser/thread/stream`，`browser/thread/updated` 继续承担富历史校准；标准 Item 通知另按共享协议输出。

Chrome、通用本机 WebSocket 与 CLI 的 app-server 由同一个 `AppServerConnection` 解析、初始化和路由，两类 WebSocket 也复用同一传输实现。Chrome 仅访问 `source: browser-extension` 的会话，不继续桌面或 CLI 创建的会话。协议共用不合并凭据、会话归属或断开策略，详见[统一契约](../../integrations/app-server.md)。

## 文档导航

- [Native Messaging 实例发现协议](native-messaging.md)：Chrome 到已运行桌面进程的发现、版本协商、rendezvous 文件和消息帧。
- [WebSocket app-server 协议](app-server.md)：连接、初始化、请求、响应、通知和订阅语义。
- [通用标准输入](../../../app-server-api/external-clients.md#turnstart)：文本／图片、模型能力、归一化和限制的主定义；浏览器可用范围仍以本目录为准。
- [数据模型](data-models.md)：Thread、Turn、Item、页面上下文和状态映射。
- [生命周期、错误与恢复](lifecycle-errors.md)：完整时序、停止生成、断线重连和错误码。
- [兼容性与测试](compatibility.md)：官方协议边界、浏览器附加能力、当前未实现能力和验收要求。
- [网页关联操作](webpage-launch.md)：网页按钮、独立草稿、单次发送和精确结果回传。

## 协议分层

```mermaid
flowchart LR
  Panel[Chrome Side Panel]
  Background[Extension Service Worker]
  Native[JustDo Native Host]
  Rendezvous[(app-server.json)]
  Server[JustDo WebSocket app-server]
  Protocol[共享 AppServerConnection]
  Binding[Browser capability binding]
  Controller[BrowserExtensionChatController]
  Gateway[OpenClaw Gateway]

  Panel -->|runtime message| Background
  Background -->|Chrome Native Messaging| Native
  Native --> Rendezvous
  Server -->|发布已运行实例| Rendezvous
  Background -->|localAppServerUrl| Panel
  Panel <-->|JSON-RPC-like WebSocket| Server
  Server --> Protocol --> Binding --> Controller --> Gateway
```

两层协议的 framing 不同：

| 层          | 传输                                                 | JSON-RPC 标头                | 用途                               |
| ----------- | ---------------------------------------------------- | ---------------------------- | ---------------------------------- |
| Native Host | Chrome Native Messaging，4 字节小端长度 + UTF-8 JSON | 必须为 `"jsonrpc":"2.0"`     | 版本协商、发现已运行实例的动态地址 |
| app-server  | `ws://127.0.0.1:<port>/app-server?token=<token>`     | 按 Codex app-server 约定省略 | 会话、消息、运行状态与通知         |

## Chrome 发现协议版本与身份常量

| 名称                 | 当前值                             | 说明                                |
| -------------------- | ---------------------------------- | ----------------------------------- |
| Chrome extension id  | `jboajogplelmaahjbomgflnfngpolgcb` | 由 `manifest.json` 固定公钥稳定派生 |
| Native Host name     | `com.justdo.browserextension`      | Chrome 注册表和扩展必须一致         |
| manifest schema      | `2`                                | Native Host 握手版本                |
| native host protocol | `2`                                | `codexRuntime/*` 方法版本           |
| app-server protocol  | `3`                                | rendezvous 与扩展期望版本           |

这些版本号用于 Chrome Native Messaging 与 rendezvous，不是通用 app-server 的版本协商。Chrome 协议版本变化必须同步修改桌面端、扩展、测试和本目录文档。新增可选字段可保持当前版本；删除字段、改变字段含义或改变时序需要提升相应协议版本。

## 权威实现

- Native Host framing／发现：`scripts/browser/browser-extension-native-host.cs`
- Native Host 注册／rendezvous：`src/main/browser/extension/browserExtensionNativeMessaging.ts`
- WebSocket server：`src/main/browser/extension/browserExtensionChatServer.ts`
- 公共协议引擎：`src/main/appServer/appServerConnection.ts`
- 浏览器附加协议与错误映射：`src/main/browser/extension/browserAppServerProtocol.ts`
- 浏览器能力与订阅：`src/main/browser/extension/browserAppServerBinding.ts`
- 历史字段投影：`src/main/browser/extension/browserAppServerProjection.ts`
- 业务适配：`src/main/browser/extension/browserExtensionChatController.ts`
- 实时事件外形：`src/shared/browser/browserExtensionStream.ts`
- 扩展 bootstrap：`plugins/browser-extensions/browser-assistant/conversation-overlay/modules/app-server-background.js`
- WebSocket client：`plugins/browser-extensions/browser-assistant/conversation-overlay/modules/conversation-client.js`
- 标准审批 presenter／原生 owner：`src/main/appServer/appServerApprovals.ts` 与 `src/main/browser/extension/browserAppServerApprovals.ts`
- 侧栏审批表单：`plugins/browser-extensions/browser-assistant/conversation-overlay/modules/sidepanel-approvals.js`
- Side Panel：`plugins/browser-extensions/browser-assistant/conversation-overlay/sidepanel.js`

文档描述的是当前仓库实现，不承诺未在兼容性表中列出的 Codex app-server 方法。
