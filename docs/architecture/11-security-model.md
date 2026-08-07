# 安全模型

JustDo 的安全边界建立在 Electron 进程隔离、Preload 最小 API、Main 进程输入校验、本地文件协议限制、CSP、系统对话框和 OpenClaw runtime 边界之上。

## 核心原则

- Renderer 不直接访问 Node.js、Electron、SQLite 或文件系统。
- 所有本地能力通过 `window.electron` 的窄 API 暴露。
- Main 进程校验 IPC 输入后再访问文件、网络、Gateway、SQLite 或 marketplace。
- 用户可见本地系统动作通过明确 UI 或系统对话框触发。
- 不把 API key、token、password 写入源码。

## 关键文件

| 文件                                                                 | 作用                            |
| -------------------------------------------------------------------- | ------------------------------- |
| `src/main/preload.ts`                                                | Renderer API surface            |
| `src/main/core/contentSecurityPolicy.ts`                             | CSP 注册                        |
| `src/main/core/localFileProtocol.ts`                                 | `localfile://` 安全本地文件协议 |
| `src/main/ipc/payloadSanitizer.ts`                                   | IPC payload sanitizer           |
| `src/main/ipc/app/shell.ts`                                          | shell/path 操作                 |
| `src/main/cowork/providerApiConfig.ts`                               | provider/API 配置读取           |
| `src/renderer/features/cowork/components/CoworkInteractionModal.tsx` | ask-user 交互 UI                |
| `src/renderer/features/cowork/components/ExecApprovalModal.tsx`      | 命令与文件修改审批 UI           |

## Electron 安全

- Renderer 通过 contextBridge 获取受控 API。
- Main process owns filesystem, shell, SQLite, Gateway process and OS integration.
- CSP 在 app 启动时注册。
- 本地文件预览使用自定义协议，不直接暴露任意文件 URL。

Linux/Windows 当前会设置 Chromium `no-sandbox`，用于桌面应用兼容和 Windows 管理员启动场景。该设置应视为平台兼容决策，不能替代应用层权限校验。

## 工具执行

OpenClaw/Gateway 负责命令策略、workspace enforcement、approval transport 和最终执行。
JustDo 提供 `ask`、`auto`、`full` 三档产品预设，提交 npm runtime 已公开支持的
`tools.exec.mode` 与 `tools.fs.workspaceOnly`，并通过 Gateway `exec.approvals.get/set`
更新 host policy。写入使用 Gateway 返回的 `baseHash`，JustDo 不直接访问 approvals 文件。

npm OpenClaw v2026.6.11 尚无独立文件 mode。JustDo 因此维护
`file-permission-policy` bundled compatibility extension，通过公开的
`registerTrustedToolPolicy` 接口在已审计的 core 文件修改工具执行前请求 plugin approval。
该适配器与 `package.json.openclaw.version` 一起版本锁定；升级 OpenClaw 时必须重新审计精确的
core 工具 ID 和 manifest contract。该适配器是版本锁定的兼容层，不构成 active-policy
readiness 证明。
扩展的 `filePermissionPolicy.info` 只证明扩展代码已加载并读到了指定配置，不证明 trusted
policy 已进入 OpenClaw active registry。当前 OpenClaw 没有公开权威 effective permission
snapshot。产品选择继续使用该版本锁定适配器提供文件审批功能：`ask` 与 `auto` 的文件修改
进入人工审批，`full` 跳过文件审批。adapter info 不参与 Gateway readiness；真实 packaged
runtime 的副作用前审批 smoke test 是每次 OpenClaw 升级和发布前的兼容门槛。

当前审批覆盖 host exec 和适配器中已审计的文件变更工具，但仍不等于所有工具权限。Browser、消息、定时任务、
第三方 MCP/插件副作用与 sandbox/tool policy 仍是独立安全层。

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

| 边界                   | 风险                      | 防护                                                    |
| ---------------------- | ------------------------- | ------------------------------------------------------- |
| Renderer -> Main       | 恶意/损坏 UI 请求本地能力 | preload 窄 API、Main 校验                               |
| Model/Gateway -> Tools | 模型请求执行危险动作      | Gateway/OpenClaw policy                                 |
| Local files            | 任意路径读取/打开/泄漏    | dialog 用户选择、localfile protocol、path normalization |
| Plugins/MCP/Skills     | 第三方能力执行            | 安装确认、配置同步、运行时权限、日志                    |

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

| 类型          | 推荐入口                                          | 说明                    |
| ------------- | ------------------------------------------------- | ----------------------- |
| 用户选择文件  | `dialog.selectFile/selectFiles`                   | 明确用户授权            |
| 预览/打开文件 | `shell.readPreviewFile/openPath/showItemInFolder` | Main 检查路径和工作目录 |
| 渲染本地资源  | `localfile://`                                    | 自定义协议限制读取方式  |

新增文件能力时要明确是否允许目录、是否递归、是否读取内容、最大大小，以及错误如何反馈。

## Command And Tool Safety

命令安全策略属于 OpenClaw/Gateway。JustDo 不维护命令危险性规则，也不根据命令文本自行放行或升级风险。策略侧应考虑：

- 是否需要用户确认。
- 是否会修改文件。
- 是否会访问网络。
- 是否会读取 secret。
- 是否跨 workspace。
- 是否长期运行或后台运行。

Renderer 不判断命令是否安全，也不自行解析命令决定放行。Main 校验 approval id、kind 和
产品级 decision 后调用对应的 `exec.approval.resolve` 或 `plugin.approval.resolve`。
普通审批 UI 只提供“允许一次”“本会话允许相同命令”和“拒绝”，不会向 Gateway 发送
`allow-always`。Gateway client 必须显式申请
`operator.approvals`；renderer 只能使用 list/resolve 和 requested/resolved 四个窄接口。

“本会话允许相同命令”由 Main 的内存 grant 实现，不写 OpenClaw 的 agent 持久化 allowlist。
grant 以 Gateway 提供的精确 `sessionKey` 隔离，并匹配 command、argv、cwd、host、agent、
env binding、resolved path、system-run plan、security、ask 和来源上下文；Gateway host 只提供
env key 而没有值时不允许建立会话 grant。命中后仍仅向 Gateway 提交 `allow-once`。Main 不做 shell
语义解析，也不把一条命令扩展成“类似命令”。新会话不会继承，session reset/delete 和应用退出
都会清除；JustDo 与 Gateway 的 delete/reset 事件以及 cron artifact cleanup 都显式清理。升级同步
权限策略时会通过 CAS 移除 Gateway host 上 `source=allow-always` 的持久化项，同时保留其他来源的
人工 allowlist 配置。JustDo 固定 `tools.exec.host=gateway`，禁用 OpenClaw 的 `nodes` 工具，也不调用
node approvals RPC；远程 node 不是 JustDo 的产品能力。

默认策略为 `security=allowlist`、`ask=on-miss`、`askFallback=deny`。用户从消息输入区附件按钮
右侧的权限选择器切换 `ask`、`auto` 或 `full`。切换会持久化应用级产品偏好，热更新 OpenClaw
config，再通过 Gateway CAS 更新 host policy并回读 defaults 和所有受管 agent entry。已有待审批
请求不自动放行。所有配置同步在 Main 内串行；成功前会回读 tools exec/fs、文件权限插件和
host approvals。权限配置写入、reload、回读或回滚无法确认时，Main 立即断开并
停止 Gateway，将 engine 标记为权限同步错误。

开启 `full` 前必须由用户在权限选择器中二次确认；core 文件修改与主机命令都不再审批。
定时任务不继承交互会话 grant，也不会触发全局权限切换。Full 下任务按 Full 无人值守执行；
Ask/Smart 下产生的命令、文件或第三方插件审批保持交互式，超时默认拒绝。Main 不把 cron-shaped
session key 当作可信运行证明：OpenClaw v2026.6.11 的公开 API 只能证明 job 存在，不能证明 approval
来自该 job 的真实 active run，自动放行会允许伪造 session 获得 run-scoped Full。
Agent 可以通过原生 cron 工具创建和管理任务，JustDo UI 通过 Main RPC 管理任务。任务执行仍按届时
生效的权限模式处理，不继承创建任务时的交互会话 grant，也不会因为由 Agent 创建而自动放行审批。
Gateway operator、CLI 和 scheduler state 仍是外部信任边界；完整隔离依赖未来的独立执行凭据与
状态目录保护。`full` 仍是非持久化运行期状态，应用启动前降级为 `ask`。

权限选择器只展示三档产品行为和可执行错误，不展示或推导 workspace、sandbox、
effective policy、运行时快照或配置同步进度。

当前没有为 `ls`、PowerShell alias、`rg` 或 Git 查询配置宽泛 safe-bin 白名单。默认 safe-bin
profile 只适合窄的 stdin filter；参数级只读 profile 完成前，这些命令仍可能请求批准。

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
