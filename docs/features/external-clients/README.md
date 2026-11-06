# 外部客户端

外部程序通过 CLI、入站 ACP 和 app-server 使用桌面应用；出站委派指南和公共协议规范在各自目录维护。

- [CLI 与入站 ACP](agent-cli.md)
- [app-server 连接与生命周期](app-server.md)

## 接入方式与代码归属

CLI 是命令行入口，可以执行普通命令，也可以通过子命令承载 ACP 或 app-server stdio。app-server 的另一种连接方式是本机 WebSocket；两种传输共用协议和外部线程能力，不建立两套执行系统。

入站代码统一在 `src/main/clients/`：

| 模块                  | 职责                                                              |
| --------------------- | ----------------------------------------------------------------- |
| `cli/`                | 启动器、本地认证桥、命令执行与 ACP 适配                           |
| `appServer/protocol/` | 标准握手、方法路由、输入、历史投影、审批呈现和通用 WebSocket 传输 |
| `appServer/client/`   | 外部线程 binding、Codex 适配和统一连接会话管理                    |
| `appServer/` 根文件   | 本机 WebSocket 入口、凭据设置和停止协调                           |
| `shared/`             | 两种接入方式共用的模型目录、会话映射、原生执行、回执和资源契约    |

Main 向 CLI 和本机 WebSocket 注入同一个 app-server 会话管理器，共用加载集合和事件订阅；各传输仍只关闭自己持有的连接。Chrome 的发现、鉴权及专属能力留在 `src/main/chrome/`，通过纯协议层接入。出站调用其他 Agent 的配置及插件不归本目录。

字段、示例和支持范围见 [app-server API](../../app-server-api/README.md)；应用调用其他 Agent 见[出站委派指南](../../developer-integration/external-agent-integration-guide.md)。

[返回功能文档索引](../README.md)
