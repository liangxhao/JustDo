# OpenClaw 权限管理修复计划

## 文档定位

本文是权限管理改造的唯一续作与验收依据，取代并删除了早期的
`openclaw-permission-management-plan.md`。旧文档包含已经撤销的架构方向和过时实施阶段，
不再保留。

当前结论：**对话内 `ask` / `auto` / `full` 主链路已经接通；定时任务不切换全局权限，
也不根据可伪造的 session key 自动提权；真实文件工具的 packaged-runtime smoke 尚未完成。
可信 cron run 证明、隔离执行环境和运行时 active-policy 权威证明作为后续安全增强保留。**

新会话开始时先阅读：

- 本文；
- `AGENTS.md`；
- `docs/architecture/11-security-model.md`；
- `../openclaw/AGENTS.md`；
- OpenClaw v2026.6.11 的公开 config、Gateway approvals、cron pagination 和
  trusted-tool-policy contract。

OpenClaw 是 npm 安装的第三方 runtime。不得修改 `../openclaw` 源码、compiled runtime，
也不得新增权限 runtime patch。

## 当前交付范围

本轮只要求用户在桌面对话中正常使用三档权限：

| 模式   | 主机命令                                           | 核心文件工具                      | 生命周期                       |
| ------ | -------------------------------------------------- | --------------------------------- | ------------------------------ |
| `ask`  | allowlist 命中时执行；未命中时请求批准             | `write/edit/apply_patch` 请求批准 | 持久化为默认模式               |
| `auto` | OpenClaw reviewer 自动审核；不确定或失败时请求批准 | 当前降级为人工请求批准            | 持久化为默认模式               |
| `full` | 无需批准                                           | 无需批准                          | 二次确认；应用重启后恢复 `ask` |

Browser、消息、MCP、marketplace、第三方插件和其他 Gateway operator 客户端不自动受三档
权限完整覆盖。Agent 可以通过原生 cron 工具创建和管理定时任务；任务执行不继承交互会话 grant，
仍按届时生效的权限模式处理。

用户界面只展示三档产品行为和可执行错误，不展示“desired/effective policy”“运行时快照”
或“正在提交并核对运行时配置”等内部实现状态。

## 当前实现基线

以下内容已经由代码和单元测试确认：

- minimal config 在后续同步时会重新合并 `tools.exec.mode`、
  `tools.fs.workspaceOnly`、permission adapter entry 及 plugin allow/deny 保护；
- JustDo 不再创建 `permission-policy.json`，也不直接读写
  `exec-approvals.json`；
- exec policy 使用公开的 `exec.approvals.get/set` 和 `baseHash`；
- approvals 更新后会验证响应 hash、回读 hash、defaults 以及所有提交的 agent entry；
- 文件审批适配器通过公开的 `registerTrustedToolPolicy` 和 plugin approval transport
  接入，并锁定 OpenClaw v2026.6.11；
- `auto` 下文件修改暂时降级为人工 `ask`；
- `full` 需要二次确认；
- UI 已移除运行时配置、快照和同步进度等技术提示，只在保存或应用失败时展示错误；
- `filePermissionPolicy.info` 只保留 loaded/version/configured 诊断字段。

单元测试和构建结果不能替代 packaged-runtime 行为验收；应以本文 TODO 和验收状态为准。

## 独立审查事项

以下四项来自独立代码审查。R0-1、R0-2 已关闭；R0-3 的 JustDo 本地入口已关闭，
Gateway 全局入口延期；R0-4 按产品决策关闭，但真实文件工具 smoke 仍是当前功能验收项。

### R0-1：配置同步失败没有完整 fail closed

状态：**已关闭（权限配置代码与单元测试）**。权限配置写入/回读失败复用统一 fail-closed 路径；
`ensureRunning` 和 startup 在同步失败后不再继续启动 Gateway。

涉及：

- `src/main/openclaw/config/openclawConfigSyncService.ts`；
- `src/main/ipc/cowork/config.ts`；
- `src/main/main.ts`。

原问题：

- `OpenClawConfigSync.sync()` 因写盘、原子替换或回读失败返回 `ok:false` 时，只设置外部错误，
  没有统一 disconnect + stop；
- 权限应用和 preference rollback 连续失败时，Gateway 可能仍以旧的 `full` 状态运行；
- Gateway 尚未运行时，配置同步失败后启动流程仍可能继续拉起 Gateway。

关闭依据：

1. 已建立统一的 fail-closed primitive，供权限应用、rollback 和启动期配置失败复用；
2. 失败后会断开客户端、停止 Gateway、设置明确 engine error，并禁止本次启动继续；
3. UI/IPC 只返回保存或应用失败，不把 preference 描述成已确认 runtime 状态；
4. 单元测试覆盖 running/stopped、首次同步失败、rollback 再次失败和启动被阻止。

### R0-2：定时任务会被交互审批阻塞

状态：**部分关闭**。Main 不要求 Full 与 cron 互斥，也不在任务运行前后切换全局权限。
Full 下任务可完整无人值守；Ask/Smart 下的审批保持交互式并默认拒绝超时。曾实现的
`sessionKey + cron.list job existence` 自动放行已移除，因为它不能证明 approval 来自真实 active run。
恢复受限模式下的无人值守能力前，必须完成 `FUTURE-7` 和 `FUTURE-8`。

### R0-3：Agent 通过原生 cron 提升为无人值守权限

状态：**按权限继承规则关闭**。Agent 可以调用原生 cron add/update/remove/run，但任务执行不继承
创建任务时的交互会话 grant，也不会自动获得 Full。Ask/Auto 下的审批继续保持交互式并默认拒绝
超时；Full 仍在应用重启前降级为 Ask。其他持有 Gateway operator 凭据的客户端仍属于外部信任边界。

### R0-4：adapter info 被错误用作 active readiness

状态：**按产品决策关闭（代码与单元测试）**。adapter info 不再参与 readiness。产品要求保留
正常文件审批能力，因此 `ask/auto` 继续通过版本锁定兼容适配器审批
`write/edit/apply_patch`，不再通过 `tools.deny` 禁用文件修改。该选择依赖 packaged-runtime
副作用前审批 smoke 作为发布兼容门槛，但不把 adapter info 包装成权威 readiness。

涉及：

- `openclaw-extensions/file-permission-policy/index.ts`；
- `src/main/openclaw/config/openclawConfigSyncService.ts`；
- `src/main/main.ts`。

原问题：

`verifyActivePermissionPolicy()` 仍将 adapter 的 loaded/version/configuredMode 匹配作为允许
engine 继续运行的条件。但 `registerTrustedToolPolicy()` 不返回权威注册结果，adapter info
RPC 存活不能证明 trusted policy 已进入 active registry。

决策与处理结果：

1. adapter info 只用于版本和配置诊断，不得参与 active/readiness 成功判断；
2. 再次核对 packaged runtime 是否提供公开、权威的 registry/effective snapshot；当前审计
   结论是没有；
3. 产品决定保留正常文件审批能力，继续使用与 OpenClaw v2026.6.11 锁定的 compatibility
   adapter，不把它描述成权威 active-policy 证明；
4. packaged runtime 中真实 `write/edit/apply_patch` 的副作用前审批 smoke 被列为当前功能
   验收项，但不能替代未来的权威 readiness。

已核实 `plugins.entries.*.config` 变化会触发 `reloadPlugins=true`，因此“plugin config
不会热更新”不是当前阻断项。

## TODO List

### 当前功能验收

以下项目完成后，才能把“对话内三档权限正常”标记为已验收：

- [ ] `CURRENT-1`：在打包 runtime 中验证 `ask`。未命中的真实主机命令必须先出现审批；
      deny/timeout 后不执行，allow-once 后只执行一次。
- [ ] `CURRENT-2`：在打包 runtime 中验证 `auto`。可自动判定的命令走 reviewer；不确定、
      reviewer 缺失或失败时转人工，不得静默放行。
- [ ] `CURRENT-3`：在临时 workspace 中分别执行真实 `write`、`edit`、`apply_patch`。
      `ask/auto` 必须在副作用前请求批准；deny、timeout、no route 后文件不变；allow-once
      只消费一次。
- [ ] `CURRENT-4`：验证 `full` 下真实命令和上述文件工具无需批准，并验证应用重启前已将
      `full` 降级为 `ask`。
- [ ] `CURRENT-5`：验证三档切换失败时只显示可执行错误，不恢复运行时快照、配置同步进度等
      技术提示。
- [ ] `CURRENT-6`：确认并安全退出占用 `better-sqlite3` 的本仓库开发 Electron 进程后，
      运行完整 `npm test`，并重新运行 build、compile、lint 和 diff check。

smoke 必须使用临时 state/workspace，不连接用户真实 Gateway，不读取或修改用户真实数据。

### 未来安全增强

以下项目不阻塞当前对话功能，但在宣称“全局、可证明、不可绕过的权限边界”前必须完成：

- [x] `FUTURE-1`：允许 Agent 使用原生 cron mutation，同时确保任务不继承创建会话的临时授权；
      其他 Gateway operator 客户端明确保留为外部信任边界。
- [ ] `FUTURE-2`：决定是否需要“`full` 仅允许前台命令”。如果恢复该产品约束，使用公开
      tool policy 禁用 `process`/后台交接能力，并验证 `background`、`yieldMs` 和 shell detach；
      在此之前 UI 不声称“仅前台”。
- [ ] `FUTURE-3`：推动 OpenClaw 暴露 active trusted-policy/effective permission 的权威
      公共快照。接口可用前继续版本锁定 adapter，并以 packaged-runtime smoke 作为兼容门槛，
      但不得把诊断 RPC 当成权威证明。
- [ ] `FUTURE-4`：统一 auth logout native reload 超时的 fail-closed 行为，并同步修正安全
      架构文档中的无例外表述。
- [ ] `FUTURE-5`：审批 UI 根据 `pluginId` 区分 JustDo 文件审批和其他 plugin approval，
      避免把所有插件审批都显示为文件修改。
- [ ] `FUTURE-6`：补齐 workspace 逃逸测试，包括 Windows 盘符、路径大小写、
      junction/symlink。
- [ ] `FUTURE-7`：推动 OpenClaw 提供可信 cron run attestation，并把 exact
      `{agentId, jobId, runId, sessionKey}` 与 approval 绑定；Main 只在 active run 生命周期内使用，
      结束或超时立即清除。不得从 session key 格式和 job existence 推断真实性。
- [ ] `FUTURE-8`：为无人值守任务提供隔离 exec profile，不继承 Gateway operator token、CLI shim，
      且不能写 scheduler state；覆盖 CLI 和直接状态文件两条持久任务绕过测试。
- [ ] `FUTURE-9`：让 Full→Ask/Auto 的文件策略也具备单调收紧语义。host approvals 已在配置 reload
      前收紧；文件 trusted-policy 仍需 OpenClaw 提供不会向 Renderer 暴露的 Main-only 原子切换接口。

未来项目实施时先补失败测试，再修改代码；不得恢复第二权限状态源或新增 OpenClaw runtime
patch。

## 架构与产品边界

### 职责

| 能力            | OpenClaw                                        | JustDo                             |
| --------------- | ----------------------------------------------- | ---------------------------------- |
| exec 策略       | mode、allowlist、reviewer、审批、fallback、执行 | 选择预设并调用公共 API             |
| 文件工具        | workspace enforcement、approval transport、执行 | 最小版本锁定适配器、配置和审批 UI  |
| sandbox         | 创建、路由、实际状态、降级原因                  | 不推导或伪造运行时状态             |
| approval        | request/list/resolve、timeout、事件             | 订阅、展示和提交用户决策           |
| cron/background | 调度执行、run session 和公开配置                | 本地任务 UI；不伪造 run 级权限证明 |
| 生命周期        | Gateway 提供运行时能力                          | Main 启停、断连和错误呈现          |

JustDo Main 是 Gateway 生命周期和桌面审批 broker，但不是第二套命令风险策略引擎。会话 grant
只是执行用户已明确授予的精确重复授权，不解析命令安全性，也不扩大 Gateway 的单次决策。

普通命令审批的重复授权是会话内、内存态的精确请求匹配：JustDo 不向 Gateway 提交
`allow-always`，而是在同一 `sessionKey` 再次出现完全相同的执行上下文时自动提交
`allow-once`。因此它不会写入当前 main agent 的全局持久化 allowlist，也不会跨会话继承；
旧版 UI 产生且标记为 `source=allow-always` 的条目会在 Gateway host 权限策略同步时清理。
JustDo 固定 exec host 为 Gateway，不提供 node 工具或 node approvals。请求携带的安全执行绑定
无法完整比较时，不提供会话重复授权。

### 强制约束

- 不直接读写 `exec-approvals.json`；
- 不恢复 `permission-policy.json` 或其他第二权限状态源；
- 不只凭 cron session key 放行；必须通过公开 Gateway API 回查 exact job 和执行类型；
- 不用 adapter status 自证 active policy；
- 不在 JustDo 实现 safe-bin parser、shell AST、命令 reviewer、allowlist 语义或全工具
  capability registry；
- 不让 Renderer 获得 admin policy 权限；
- 不把 desired/persisted 配置描述成 effective runtime；
- 不依赖 OpenClaw `dist` 深路径或内部文件布局；
- 公共接口不足时必须收缩安全声明或能力范围，不得伪造权威状态，也不得修改第三方 runtime。

### 三档产品语义

| JustDo 预设 | exec 配置 | 文件修改                 | 当前对话功能约束                 |
| ----------- | --------- | ------------------------ | -------------------------------- |
| 请求批准    | `ask`     | 版本锁定适配器执行 `ask` | workspaceOnly；无 route 时拒绝   |
| 智能审批    | `auto`    | 当前退化为人工 `ask`     | 命令不确定或审核失败时转人工     |
| 完全权限    | `full`    | 无需批准                 | 二次确认；应用重启后恢复为 `ask` |

Browser、消息、MCP、marketplace 和第三方插件不自动受这三档覆盖。UI 只陈述上表中的当前
产品行为，不把产品配置展示成全工具 effective permission。

延期安全增强以 `FUTURE-1` 至 `FUTURE-9` 为唯一 TODO，不在其他章节维护重复清单。

## 验收状态

### 已完成的代码约束

- [x] JustDo 不存在 `permission-policy.json`；
- [x] JustDo 不直接写 `exec-approvals.json`；
- [x] adapter info 不参与 active readiness；
- [x] 权限应用或回滚无法确认时 Gateway 停止；
- [x] UI 不展示运行时快照或配置同步进度；
- [x] `full` 二次确认并在应用重启前降级为 `ask`；
- [x] cron-shaped approval 不根据 session key 与 job existence 自动放行；
- [x] Agent 原生 cron mutation 不被文件权限策略阻断。

### 当前对话功能待验收

- [ ] `ask` 下真实 `write/edit/apply_patch` 在副作用前进入审批；
- [ ] deny、timeout、no route、Gateway unavailable 均无文件变化；
- [ ] allow-once 只消费一次；
- [ ] `auto` 在 reviewer 缺失时不静默放行；
- [ ] `full` 下命令和核心文件工具无需批准；
- [ ] 应用重启后 `full` 在 Gateway 启动前恢复为 `ask`；
- [ ] 合并前完整测试和工程检查通过。

### 未来安全边界

- [ ] OpenClaw 提供并由 JustDo 使用权威 active/effective policy 快照；
- [x] JustDo Agent 可以通过原生 cron 工具创建和管理任务，任务不继承会话 grant；
- [ ] 如果产品要求仅前台，后台执行和 shell detach 均被覆盖；
- [ ] workspace 逃逸、Windows 盘符、路径大小写、junction/symlink 均通过真实测试；
- [ ] auth logout reload 失败与其他配置失败使用一致的 fail-closed 语义。
- [ ] cron approval 使用可信 active-run attestation，并在隔离 exec profile 中执行。

### 工程

```bash
npm run lint
npm run build
npm run compile:electron
npm test
git diff --check
```

涉及 bundled extension 时，还要验证扩展预编译、manifest contract 和最终 packaged runtime。
测试必须使用临时 state/workspace，不连接用户真实 Gateway，也不读取用户真实 state。
