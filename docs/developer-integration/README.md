# 开发接入指南与接口索引

后续开发新模块时，从这里查阅需要衔接的现有接口。每份说明应写清调用方、触发时机、
调用顺序、运行进程、失败行为和验证方式，避免遗漏已有功能的状态更新。

新增 Codex、Claude 之外的外部 Agent 时，从[自定义外部 Agent 接入指南](external-agent-integration-guide.md)
开始：先选择原生 ACP 命令或 adapter，再完成产品登记、认证、运行依赖和发布验收。
企业自研的 HTTP/API Agent 也需要本地 ACP adapter；当前设置页展示的是随版本登记的能力。

## 当前接入项

| 待开发模块                 | 需要接入的接口                                 | 接入要求                                                           | 详细说明                                                     |
| -------------------------- | ---------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------ |
| 登录 / 退出登录            | `refreshAfterLogin()` / `refreshAfterLogout()` | Main 完成登录凭据写入 / 清理后 await；内部处理内置模型与请求头缓存 | [登录与模型生命周期](login-model-lifecycle-api.md)           |
| 登录模块与 Cookie 定时续期 | `updateOutboundHeaderUserInfoCache()`          | 完成 `user_info.json` 写入或清理后，更新 Main 进程的请求头值缓存   | [请求头值刷新](outbound-header-user-info-refresh-api.md)     |
| 自定义外部 Agent           | ACP 协议与 ACPX 运行层                         | 选择 CLI/adapter、登记目录、适配认证与权限、校验交付产物           | [自定义外部 Agent 接入](external-agent-integration-guide.md) |
| Extension 请求头声明       | `outbound-header-policy.json`                  | 声明 URL 与请求头名称，实际凭据由本机配置提供                      | [请求头配置与示例](outbound-headers/README.md)               |

本索引记录已确认的接入要求，不代表所有模块接口的完整清单。新增接入项时，在本目录增加
对应说明，并更新上表。接口实现或调用时机变化时，同步维护说明。

## 文档分工

- 本目录：后续开发者的接入步骤、接口合同、示例、失败行为与验收要求。
- `docs/architecture/`：系统架构、进程边界与状态归属。
- `docs/features/`：功能设计与实现方案。
- [出站请求头使用指南](outbound-headers/README.md)：用户配置和 Extension 接入。
