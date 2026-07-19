# 安全模型

JustDo 的安全边界建立在 Electron 进程隔离、Preload 最小 API、Main 进程输入校验、本地文件协议限制、CSP、系统对话框和 OpenClaw runtime 边界之上。

## 核心原则

- Renderer 不直接访问 Node.js、Electron、SQLite 或文件系统。
- 所有本地能力通过 `window.electron` 的窄 API 暴露。
- Main 进程校验 IPC 输入后再访问文件、网络、Gateway、SQLite 或 marketplace。
- 用户可见本地系统动作通过明确 UI 或系统对话框触发。
- 不把 API key、token、password 写入源码。

## 关键文件

| 文件 | 作用 |
| --- | --- |
| `src/main/preload.ts` | Renderer API surface |
| `src/main/core/contentSecurityPolicy.ts` | CSP 注册 |
| `src/main/core/localFileProtocol.ts` | `localfile://` 安全本地文件协议 |
| `src/main/ipc/payloadSanitizer.ts` | IPC payload sanitizer |
| `src/main/ipc/app/shell.ts` | shell/path 操作 |
| `src/main/cowork/providerApiConfig.ts` | provider/API 配置读取 |
| `src/renderer/features/cowork/components/CoworkInteractionModal.tsx` | ask-user 交互 UI |

## Electron 安全

- Renderer 通过 contextBridge 获取受控 API。
- Main process owns filesystem, shell, SQLite, Gateway process and OS integration.
- CSP 在 app 启动时注册。
- 本地文件预览使用自定义协议，不直接暴露任意文件 URL。

Linux/Windows 当前会设置 Chromium `no-sandbox`，用于桌面应用兼容和 Windows 管理员启动场景。该设置应视为平台兼容决策，不能替代应用层权限校验。

## 工具执行

JustDo 不实现 OpenClaw 命令审批和工具权限管理。OpenClaw/Gateway owns tool execution policy；JustDo 仅保留 extension ask-user 交互桥接。

需要谨慎处理的能力：

- shell open path / external URL
- 本地文件读取和预览
- MCP stdio process
- extension callback
- command execution
- marketplace install
- scheduled task execution

## 网络和代理

Main 进程负责系统代理偏好、outbound header proxy 和 Gateway localhost proxy bypass。代理配置变化可能触发 Gateway restart 或 client reconnect。

## Secrets

- 源码和文档中不能硬编码真实 secret。
- Provider API key 通过应用配置保存和读取。
- 日志中不要输出完整 token、API key 或认证 header。

## 维护规则

- 新增 preload API 时，先说明调用者、输入、输出和失败行为。
- 新增文件系统能力时使用路径归一化和最小暴露。
- 新增网络能力时避免 renderer 直连敏感服务。
- 新增系统对话框或 ask-user 交互时添加 i18n 文案。

## Threat Model

JustDo 的主要风险来自四类边界：

| 边界 | 风险 | 防护 |
| --- | --- | --- |
| Renderer -> Main | 恶意/损坏 UI 请求本地能力 | preload 窄 API、Main 校验 |
| Model/Gateway -> Tools | 模型请求执行危险动作 | Gateway/OpenClaw policy |
| Local files | 任意路径读取/打开/泄漏 | dialog 用户选择、localfile protocol、path normalization |
| Plugins/MCP/Skills | 第三方能力执行 | 安装确认、配置同步、运行时权限、日志 |

## Renderer Isolation

Renderer 应被当作不可信 UI 层处理。即使当前代码由我们编写，模型输出、Markdown、外部链接、marketplace 内容都可能进入 renderer。

要求：

- `contextIsolation: true`。
- `nodeIntegration: false`。
- 不把 `require`、`process.env`、filesystem handle 暴露给 renderer。
- Markdown/HTML 输出经过 DOMPurify。
- 外部链接通过 Main 的 shell API 打开。

## IPC Input Validation

Main handler 对输入做三层处理：

1. shape validation：字段存在、类型正确。
2. semantic validation：id 是否存在、状态是否允许、路径/URL 是否合理。
3. authority validation：这个操作是否应该由用户当前动作触发。

例如市场安装：

```text
Renderer install click
  -> marketplace.install({ sourceId, pluginId, kind, version })
  -> Main validates source/kind/id/version
  -> registered marketplace provider
  -> result
```

不要让 renderer 传入“要调用哪个 provider method”这类动态能力。

## File Access

文件访问分三类：

| 类型 | 推荐入口 | 说明 |
| --- | --- | --- |
| 用户选择文件 | `dialog.selectFile/selectFiles` | 明确用户授权 |
| 预览/打开文件 | `shell.readPreviewFile/openPath/showItemInFolder` | Main 检查路径和工作目录 |
| 渲染本地资源 | `localfile://` | 自定义协议限制读取方式 |

新增文件能力时要明确是否允许目录、是否递归、是否读取内容、最大大小，以及错误如何反馈。

## Command And Tool Safety

命令安全策略属于 OpenClaw/Gateway。JustDo 不维护命令危险性规则，也不根据命令文本自行放行或升级风险。策略侧应考虑：

- 是否需要用户确认。
- 是否会修改文件。
- 是否会访问网络。
- 是否会读取 secret。
- 是否跨 workspace。
- 是否长期运行或后台运行。

Renderer 不应自己判断命令是否安全。JustDo 配置 OpenClaw exec approvals 为关闭状态，避免桌面端承担命令审批职责。

## Plugin Security

Skills、MCP、Hooks、Extensions 都可能扩展 runtime 能力。

安全要求：

- Marketplace 内容不直接信任。
- MCP server config 存储在 SQLite，并由 Main 同步给 Gateway。
- MCP probe 在 Main process/service 层执行，结果给 UI。
- Hooks 默认不应静默启用危险行为。
- Extension ask-user interaction 必须映射到具体 session/request id。

## Logging And Secrets

日志用于排障，但不应成为 secret 泄漏面。

禁止记录：

- 完整 API key。
- Gateway token。
- Authorization header。
- 用户文件完整内容，除非用户明确导出。
- credential-bearing URL。

可以记录：

- provider name。
- model id。
- sanitized base URL host。
- request id/session id。
- error code 和简短 message。

## Security Review Checklist

新增能力合入前检查：

- Renderer 是否能绕过 preload？
- IPC 参数是否有类型和语义校验？
- 是否涉及文件、shell、网络、进程、secret？
- 是否需要系统 dialog 或 ask-user 交互？
- 是否需要 CSP/localfile/sanitizer 变化？
- 是否会把 Gateway authority 复制到本地？
- 是否有测试覆盖恶意或 malformed input？
