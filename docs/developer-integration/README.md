# 开发接入指南与接口索引

后续开发新模块时，从这里查阅需要衔接的现有接口。每份说明应写清调用方、触发时机、
调用顺序、运行进程、失败行为和验证方式，避免遗漏已有功能的状态更新。

第三方业务网页调用 Chrome 扩展，从[网页 SDK 接入指南](chrome-extension-web-integration.md)开始：完成站点授权、部署本地 SDK、绑定真实按钮，再按请求句柄处理状态与最终结果。扩展和桌面的内部协议见[扩展内部接口](../features/browser/extension-protocol/README.md)。

新增 Codex、Claude 之外的外部 Agent 时，从[自定义外部 Agent 接入指南](external-agent-integration-guide.md)
开始：先选择原生 ACP 命令或 adapter，再完成产品登记、认证、运行依赖和发布验收。
企业自研的 HTTP/API Agent 也需要本地 ACP adapter；当前设置页展示的是随版本登记的能力。

脚本或自有客户端调用桌面助手时，从[app-server API](../app-server-api/README.md)开始：
复制当前连接配置，完成初始化，再使用线程、执行、订阅及双向审批接口。
[Python 示例](../app-server-api/examples/python/README.md)覆盖对话、并发、历史、订阅、审批及标准图片；
支持范围与尚未实现的官方能力见[兼容性说明](../app-server-api/compatibility.md)。

## 当前接入项

登录 SDK 开发先阅读[登录接入模板](../features/integrations/login-sdk-template.md)，再核对下表中的
模型生命周期与请求头接口。不要绕过现有 LoginService 另写一套账号提交流程。

| 接入场景                   | 需要接入的接口                                                 | 接入要求                                                           | 详细说明                                                     |
| -------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------ |
| 登录 / 退出登录            | `refreshAfterLogin()` / `refreshAfterLogout()`                 | Main 完成登录凭据写入 / 清理后 await；内部处理内置模型与请求头缓存 | [登录与模型生命周期](login-model-lifecycle-api.md)           |
| 登录模块与 Cookie 定时续期 | `updateOutboundHeaderUserInfoCache()`                          | 完成 `user_info.json` 写入或清理后，更新 Main 进程的请求头值缓存   | [请求头值刷新](outbound-header-user-info-refresh-api.md)     |
| 自定义外部 Agent           | ACP 协议与 ACPX 运行层                                         | 选择 CLI/adapter、登记目录、适配认证与权限、校验交付产物           | [自定义外部 Agent 接入](external-agent-integration-guide.md) |
| 外部客户端调用桌面助手     | stdio／本机 WebSocket app-server                               | 独立连接凭据、初始化、线程／执行生命周期、服务端审批与输入能力校验 | [app-server API](../app-server-api/README.md)                |
| 插件市场 SDK               | `PluginMarketplaceProvider` / `createPluginMarketplaceService` | 注入单一市场，映射目录、下载、更新候选与原生安装身份；不包含 Hook  | [插件市场接入](plugin-marketplace-integration.md)            |
| 第三方业务网页调用扩展     | `window.browserAssistant.bind()`                               | 精确站点授权、真实点击、独立输入、按请求处理状态与结果分享         | [Chrome 扩展网页接入](chrome-extension-web-integration.md)   |
| Extension 请求头声明       | `outbound-header-policy.json`                                  | 声明 URL 与请求头名称，实际凭据由本机配置提供                      | [请求头配置与示例](outbound-headers/README.md)               |

本索引记录已确认的接入要求，不代表所有模块接口的完整清单。新增接入项时，在本目录增加
对应说明，并更新上表。接口实现或调用时机变化时，同步维护说明。

## 文档分工

- 本目录：后续开发者的接入步骤、接口合同、示例、失败行为与验收要求。
- `docs/architecture/`：系统架构、进程边界与状态归属。
- `docs/features/`：按领域维护的现行功能与已知限制。
- `docs/plans/`：仍需记录的具体未实施需求；现行验证边界见对应功能或架构文档。
- [出站请求头使用指南](outbound-headers/README.md)：用户配置和 Extension 接入。
