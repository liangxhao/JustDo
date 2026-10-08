# 兼容性与测试

## 与 Codex app-server 的关系

OpenAI 官方文档规定 app-server 使用省略 `jsonrpc` 标头的 JSON-RPC 2.0 消息、每连接一次
`initialize`/`initialized` 握手，以及 Thread → Turn → Item 的数据层级。JustDo 保持这些核心
wire conventions，以降低扩展客户端适配成本。

“兼容”在本项目中表示字段和生命周期尽量遵循公开协议，不表示 JustDo 是 Codex app-server 的
完整替代实现。官方 WebSocket transport 本身也被标记为实验性；升级 OpenAI/Codex 版本时必须
重新核对官方 schema，而不能只依赖本文。

官方参考：

- [Codex app-server](https://developers.openai.com/zh-Hans/docs/app-server)
- 官方建议通过对应 Codex 版本运行 `codex app-server generate-ts` 或
  `codex app-server generate-json-schema` 生成精确 schema。

## 当前支持矩阵

| 能力                                         | JustDo      | 备注                                        |
| -------------------------------------------- | ----------- | ------------------------------------------- |
| WebSocket request/response/notification 外形 | 支持        | payload 省略 `jsonrpc`                      |
| initialize/initialized                       | 支持        | notification opt-out 支持精确方法名         |
| thread/list                                  | 支持子集    | cursor/limit；不支持官方筛选参数            |
| thread/read                                  | 支持        | `includeTurns`                              |
| thread/start                                 | 支持子集    | title；忽略模型、沙盒等高级覆盖项           |
| thread/unsubscribe                           | 支持        | 每连接订阅                                  |
| composer/options                             | JustDo 扩展 | 权限模式与已配置模型                        |
| browser/extension/pair                        | JustDo 扩展 | 已鉴权的本地自动化配对，不创建聊天会话       |
| turn/start                                   | 支持子集    | 文本、附件、权限、模型和 JustDo pageContext |
| turn/interrupt                               | 支持        | 实际按 thread 停止                          |
| thread/started                               | 支持        | 订阅过滤                                    |
| turn/started、turn/completed                 | 支持        | 订阅过滤                                    |
| thread/updated                               | JustDo 扩展 | 传输完整聚合历史                            |
| Thinking (`reasoning`) 历史 item             | 支持        | 通过 `thread/updated` 完整快照同步          |
| Tool / system 历史 item                      | JustDo 扩展 | 使用 `toolCall` / `systemMessage`           |
| item 增量事件                                | 未实现      | 无逐 token、tool 或 command delta           |
| 审批 server requests                         | 未实现      | 审批继续由桌面 UI 处理                      |
| thread/resume                                | 未实现      | 现有线程直接 `turn/start` 可继续对话        |
| thread/fork/archive/delete/unarchive         | 未实现      | 不属于当前侧栏范围                          |
| turn/steer                                   | 未实现      | 运行中线程拒绝新的 turn/start               |
| account/model/config/MCP API                 | 未实现      | 桌面端仍是配置入口                          |

## JustDo 特有扩展

- `turn/start.params.pageContext`
- `turn/start.params.attachments|permissionMode|modelRef`
- `composer/options`
- `browser/extension/pair`
- `thread/updated`
- 历史 `toolCall|systemMessage` item
- Native Host `codexRuntime/hello|ensure|restart`
- Native Host 返回 `runtimeConfig.protocolVersion`
- 扩展内部 `connection/closed|connection/reconnected`

这些字段和事件应位于兼容适配层，不能反向污染 OpenClaw Gateway 契约。

## 兼容性规则

客户端：

- 忽略未知 response 字段和未知 notification。
- 不根据动态端口构造 URL，始终重新调用 Native Host。
- 不持久化历史合成 turn/item ID。
- 完成后用 `thread/read(includeTurns: true)` 获取最终消息。
- 断线后重新初始化并恢复所需订阅。

服务端：

- 新增 optional 字段时保留现有字段语义。
- 不在同一协议版本中改变时间单位、状态 discriminant 或错误外形。
- 对未实现方法返回 `-32601`，不伪造空成功结果。
- 线程消息以 OpenClaw native history 为权威，不建立第二份 transcript cache。

## 自动化验证

相关测试：

- `src/main/browser/browserExtensionNativeMessaging.test.ts`
- `src/main/browser/browserExtensionChatServer.test.ts`
- `src/main/browser/browserExtensionChatController.test.ts`
- `src/main/ipc/app/browser.test.ts`
- `tests/scripts/prepare-browser-extension.test.ts`
- `tests/scripts/prepare-browser-extension-dev-host.test.ts`

建议在变更协议或扩展资源后运行：

```bash
npm run browser-extension:prepare
npm run browser-extension:prepare-dev-host
npx vitest run src/main/browser/browserExtensionChatController.test.ts src/main/browser/browserExtensionChatServer.test.ts src/main/browser/browserExtensionNativeMessaging.test.ts src/main/ipc/app/browser.test.ts tests/scripts/prepare-browser-extension.test.ts
npm run compile:electron
npm run lint
git diff --check
```

## 发布前人工验收

1. 打包安装 JustDo，确认 Native Messaging 注册表和 manifest 路径有效。
2. 在 Chrome 加载签名匹配固定 extension id 的扩展。
3. 分别验证桌面应用已启动和未启动两种连接路径。
4. 新建会话、继续历史会话、发送消息、停止生成。
5. 分别验证不附带和附带页面上下文。
6. 生成期间关闭/重开 Side Panel，确认重连和历史恢复。
7. 强制 app-server restart，确认客户端重新发现动态 URL。
8. 同时打开多个浏览器窗口，确认线程通知不会串到未订阅连接。
9. 验证浏览器受限页面不会导致发送失败。
10. 卸载或升级应用时检查 Native Host 注册和旧 rendezvous 的清理策略。
11. 开发态运行 `npm run electron:dev`，确认注册表指向 build helper，工具栏点击直接打开对话侧栏。
12. 点击侧栏右上角设置按钮，确认进入 relay 配对 options 页面。

当前自动化测试不替代真实 Chrome + 已打包 Electron 的端到端验收。
