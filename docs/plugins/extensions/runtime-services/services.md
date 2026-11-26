# Runtime Services 通用运行能力

## 会话展示名称

`runtimeServices.sessionDisplayName` 仅处理当前获准的 `operator.admin` backend 请求，
目标限于应用受管会话键。通过公开会话 SDK 更新 `displayName`，在原生事务中核对当前授权、
精确会话 ID、生命周期版本及写入前的名称。返回仅含目标身份和已确认名称的回执。
`confirmOnly` 只核对原生存储中的字段及身份，用于写入回执丢失时确认结果。
展示名称可以重名，修改保留原生 `label`、会话活动时间和历史。

## 会话 Goal 更新

`runtimeServices.sessionGoal` 接受当前获准的 `operator.admin` backend 请求，目标限于应用受管会话键。
调用方提交精确的 `sessionKey`、`sessionId`、`lifecycleRevision`、`operationId`、读取到的
`expectedGoalId`（没有 Goal 时为 null）和 `set` 或 `clear` 操作。
`set` 可在同一次更新中设置目标、状态及 token 预算，预算为 null 时清除预算。Main 根据会话的
执行观察传入 `allowReplacement`，原生事务只在允许替换时创建新 Goal ID，也复核并发完成后
同一目标是否已变为替换请求。
新目标使用操作 ID 作为 Goal ID，从原生当前 token 基线重新计量，状态或预算更新保留已有用量。
公开会话 SDK 在原生事务中复核授权及会话行，然后返回已提交的 Goal、是否清除及是否请求开始执行。
执行由宿主通过既有会话准入发起。回执不证明已开始或完成执行，未知写入结果也不能据此重发。

## 精确执行失败代码

`runtimeServices.executionFailure` 是 `operator.read` 的窄只读接口。调用方提供精确的
`sessionKey`、`sessionId`、`lifecycleRevision`（未分配时显式为 null）和 `runId`。
Runtime Services 通过公开异步会话和可见原生 transcript SDK 读取当前分支，返回这组身份、
最后一条对应 assistant 消息的结构化 `errorCode` 和 `identityMatched`。没有匹配失败时
`errorCode` 为 null。只有读取前后 SID 和 lifecycle revision 均匹配时 `identityMatched`
才为 true。响应不含原始错误、参数、消息正文或凭据。
该接口不能证明整轮已经结算；Main 必须另行关联精确 `executionSettled:true` 回执，
不能根据失败代码推断工具权限、原始发送授权或终态。当前读取复用原生完整可见分支的
异步 owner，不宣称支持按 run 索引的局部存储查询。

Runtime Services 还提供通用 CLI / ACP 的会话级 stdio MCP 代理：通过公开 v2 工具工厂按
精确 native session/lease 提供固定声明的 `external_mcp`，保留服务器原始 schema 和结果；
每次调用经原生单次审批，不把客户端 MCP 写进全局配置。进程、授权与租约随会话关闭清理。
当前集成宿主的离线组装器提供 `@modelcontextprotocol/client` 及其内嵌 Ajv。独立迁仓方必须显式提供等价依赖和组装步骤，不能假设本包已包含独立安装链。

资源同步与 TypeScript 预编译都将传输和校验器打包为入口旁的 ESM 按需模块。模块使用
`createRequire` 支持所捆绑的依赖，首次使用直接读取离线包。该能力需要宿主提供会话身份、
客户端交互审批及关闭通知。
会话 stdio MCP 仅在 Windows / Linux 提供；macOS 的普通 CLI / ACP 仍可用，但在启动
MCP 进程前拒绝该能力。

锁定的公开 MCP SDK 不提供 detached 进程组创建选项，原生清理
API 也不能清理 macOS 上 attached wrapper 的后代，因此不声明该平台的进程树清理保证。

Runtime Services 在注册时立即建立外部 MCP 的策略、工具工厂与清理回调。准备获准的
会话租约时才加载 schema 校验器和传输客户端。异步加载结束后、创建子进程前，重新核对
租约、当前原生会话身份、管理员及客户端授权和插件状态。加载期间撤销任一权限都将阻止
新进程启动。

Runtime Services 还拥有 `builtin_models` 的请求级认证 Provider 包装：通过公开 SDK
重新解析 Main 发布的会话绑定 exec SecretRef，让运行中的长任务跟随 JWT 续签，
并在退出、换账号或重新登录后拒绝旧任务借用新凭据；模型传输与执行仍由原生拥有。
该包装依赖宿主发布的受管凭据与当前登录身份，复制本包不提供企业认证服务。
内置记忆向量适配器复用该凭据解析器，按 `builtin_models` 的服务地址验证请求，并使用 Bearer 认证。
退出或换账号后，尚未被原生热更新替换的旧适配器也会拒绝新请求。独立配置的向量凭据沿用原有传输规则。

Runtime Services 提供嵌套 MCP App 历史的受限恢复 RPC：只读原生当前可见历史和当前
策略许可的 UI resource，使用公开 SDK 借用原生连接。挂载时主动取数的历史 App 可以
按原工具和原参数读取已记录结果，缺省值按当前 schema 核对，不执行原业务工具或恢复旧工具授权。
会话 incarnation、生命周期和配置权限变化立即使恢复视图失效，需要宿主提供兼容的原生 UI resource 与挂载请求上下文。
恢复历史 App 时，按需加载 MCP 工具投影 SDK，并在导入后复核当前恢复请求权限。

Runtime Services 还通过公开 prompt/agent-end hooks 记录有限的轮次准入诊断元数据，
只观察本次 hook 的原生身份及 trace，不缓存或推断失败阶段，不改变 prompt 或原生准入。
日志使用原生 JSON 诊断接口；集成方须自行提供受限采集与脱敏界面，不得将局部诊断当作整轮结算证据。
