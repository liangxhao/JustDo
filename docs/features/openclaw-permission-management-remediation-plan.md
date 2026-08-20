# OpenClaw 权限管理修复计划

## 文档定位

本文是权限管理改造的唯一续作与验收依据，取代并删除了早期的
`openclaw-permission-management-plan.md`。旧文档包含已经撤销的架构方向和过时实施阶段，
不再保留。

当前结论：**`ask` / `auto` / `full` 是普通对话的应用级全局权限；AgentTurn 定时任务固定使用
原生 per-agent Full 的隐藏 scheduler Agent，不锁定或修改正常会话权限。不实现每会话 runtime
隔离，也不根据可伪造的 session key 做逐次提权。Ask/Smart 下普通 Agent 的原生 cron 修改需要
一次性人工审批；启动/周期轮询分页迁移归属，失败时禁用错归属的已启用任务。可信 JustDo
交互审批必须无限等待用户决定，因此保留职责分离且规模受控的 `022`–`025` 生命周期 patch；
真实文件工具的 packaged-runtime smoke 尚未完成。**

新会话开始时先阅读：

- 本文；
- `AGENTS.md`；
- `docs/architecture/11-security-model.md`；
- `../openclaw/AGENTS.md`；
- OpenClaw v2026.7.1-2 的公开 config、Gateway approvals、cron pagination 和
  trusted-tool-policy contract。

OpenClaw 是 npm 安装的第三方 runtime。不得修改 `../openclaw` 源码、compiled runtime，
新增权限 runtime patch 必须是公开 API 无法实现、范围受控且具备移除条件的版本兼容能力。

## 当前交付范围

本轮只要求用户在桌面对话中正常使用三档权限：

| 模式   | 主机命令                                           | 核心文件工具                      | 生命周期                         |
| ------ | -------------------------------------------------- | --------------------------------- | -------------------------------- |
| `ask`  | allowlist 命中时执行；未命中时请求批准             | `write/edit/apply_patch` 请求批准 | 应用级持久化；交互审批无限等待   |
| `auto` | OpenClaw reviewer 自动审核；不确定或失败时请求批准 | 当前降级为人工请求批准            | 应用级持久化；交互审批无限等待   |
| `full` | 无需批准                                           | 无需批准                          | 缺失值默认；用户可随时切换       |

Browser、消息、MCP、marketplace、第三方插件和其他 Gateway operator 客户端不自动受三档
权限完整覆盖。Agent 可以通过原生 cron 工具创建和管理定时任务；Ask/Smart 下
add/update/remove/run 需要一次性人工审批。AgentTurn 任务会被归一化到
`justdo-scheduler` Agent，其 exec/fs 与 host approvals 固定为 per-agent Full。普通对话权限修改
始终原生热更新，所有普通会话共同使用最新的 runtime 权限快照，但不覆盖 scheduler Agent。
`cowork_sessions.permission_mode` 只作为历史兼容快照，不参与会话激活。

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
  接入，并锁定 OpenClaw v2026.7.1-2；
- `auto` 下文件修改暂时降级为人工 `ask`；
- `full` 需要二次确认；
- UI 已移除运行时配置、快照和同步进度等技术提示，只在保存或应用失败时展示错误；
- `actionApproval.info` 的 loaded/version/mode/full-agent 匹配作为 readiness 的必要条件，
  但不被描述成 trusted policy 的权威 active snapshot；
- `022`–`025` 只为可信 JustDo ancestry 提供持久 lifetime、run suspension、隐藏恢复与 stop/failure
  收口；不改变 cron 和其他 native channel 的上游超时。

单元测试和构建结果不能替代 packaged-runtime 行为验收；应以本文 TODO 和验收状态为准。

## 独立审查事项

以下六项来自独立代码审查。R0-1 至 R0-6 已在公开 OpenClaw 能力范围内关闭；真实文件工具和
原生 cron 的 packaged-runtime smoke 仍是当前功能验收项。

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

状态：**已关闭（原生 per-agent 隔离和 fail-closed reconciliation）**。AgentTurn 定时任务统一
归属隐藏 scheduler Agent；OpenClaw config、host approvals 与文件权限 extension 都只为该 Agent
配置 Full。启动/周期轮询和任务列表分页迁移旧 agentId；Gateway cron 事件触发同一逻辑；迁移失败
的已启用任务会被禁用，启用与手动运行在同一个任务锁内先确认归属。普通会话仍可自由切换
Ask/Smart/Full。曾实现的 `sessionKey + cron.list job existence` 自动放行保持删除。

### R0-3：Agent 通过原生 cron 提升为无人值守权限

状态：**已关闭（mutation approval + scheduler Agent）**。Agent 可以调用原生 cron
add/update/remove/run，但 Ask/Smart 下每次修改都进入一次性人工审批，Full 下直接执行。批准后的
AgentTurn 会由事件和周期 reconciliation 迁移到 scheduler；创建者保留的 owner scope 因后续 run
仍需审批，不能成为 Full 跳板。系统不依赖 session key 或 job existence 做 approval 级自动放行。
OpenClaw caller-scope 创建不是原子 scheduler assignment；已批准且立即到期的任务可能在迁移前按
普通 Agent 权限运行并失败，完全关闭该可用性窗口需要上游提供受信原子 assignment。
其他持有 Gateway operator 凭据的客户端仍属于外部信任边界。

### R0-4：adapter info 的必要性与证明边界混淆

状态：**已关闭（必要条件 + packaged smoke）**。adapter info 参与 readiness，能够在扩展缺失、
版本、普通模式或 scheduler Full 白名单不匹配时 fail closed；它仍不被包装成 trusted registry 的
权威 active snapshot。`ask/auto` 继续通过版本锁定兼容适配器审批
`write/edit/apply_patch`，不通过 `tools.deny` 禁用文件修改。packaged-runtime 副作用前审批 smoke
仍是发布兼容门槛。

涉及：

- `openclaw-extensions/action-approval/index.ts`；
- `src/main/openclaw/config/openclawConfigSyncService.ts`；
- `src/main/main.ts`。

原问题：

完全移除 adapter info 回读会让扩展缺失、版本或配置不匹配仍被视为同步成功；反过来，单凭该 RPC
存活也不能证明 trusted policy 已进入 active registry，因为 `registerTrustedToolPolicy()` 不返回
权威注册结果。

决策与处理结果：

1. adapter info 的 loaded/version/mode/full-agent 匹配作为 readiness 必要条件，但不得单独作为
   active trusted-policy 成功证明；
2. 再次核对 packaged runtime 是否提供公开、权威的 registry/effective snapshot；当前审计
   结论是没有；
3. 产品决定保留正常文件审批能力，继续使用与 OpenClaw v2026.7.1-2 锁定的 compatibility
   adapter，不把它描述成权威 active-policy 证明；
4. packaged runtime 中真实 `write/edit/apply_patch` 的副作用前审批 smoke 被列为当前功能
   验收项，但不能替代未来的权威 readiness。

已核实 `plugins.entries.*.config` 变化会触发 `reloadPlugins=true`，因此“plugin config
不会热更新”不是当前阻断项。

### R0-5：全局权限降级与新 turn admission 竞态

状态：**已关闭（配置队列屏障）**。新建和继续 turn 在 admission 阶段进入配置队列屏障，等待此前
排队的权限热更新和回读完成后才读取全局权限并启动。屏障随 admission 结束立即释放，不持有到
模型 turn 结束，因此不会把长任务和后续设置修改串行化。新会话的历史 `permission_mode` 快照也
改为读取 Main 中的全局配置，不再信任 Renderer 请求携带的旧值。

### R0-6：任务类型转换和 scheduler 校正不是原子更新

状态：**已关闭（per-task atomic update）**。`updateJob` 在同一个 per-task mutation lock 中读取
当前 Gateway job、计算最终 payload/sessionTarget/agentId/sessionKey，并只提交一次 `cron.update`。
AgentTurn 转 SystemEvent 会清除 scheduler agent 和 cron session residue；SystemEvent 转 AgentTurn
会补上 isolated target 与 scheduler agent。启用操作把 `enabled=true` 与 scheduler assignment 放在
同一个 update 中，手动执行则在同一锁内确认 assignment 后才调用 `cron.run`。

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
- [ ] `CURRENT-4`：验证 `full` 下真实命令和上述文件工具无需批准；验证应用重启后恢复全局
      权限，缺失值或非法值默认使用 `full`。
- [ ] `CURRENT-5`：验证三档切换失败时只显示可执行错误，不恢复运行时快照、配置同步进度等
      技术提示。
- [ ] `CURRENT-6`：确认并安全退出占用 `better-sqlite3` 的本仓库开发 Electron 进程后，
      运行完整 `npm test`，并重新运行 build、compile、lint 和 diff check。
- [ ] `CURRENT-7`：在 packaged runtime 验证 Ask/Smart 下原生 cron add/update/remove/run 在副作用前
      进入一次性审批，deny/timeout 不修改任务；Full 和 scheduler Agent 不重复提示。

smoke 必须使用临时 state/workspace，不连接用户真实 Gateway，不读取或修改用户真实数据。

### 未来安全增强

以下项目不阻塞当前对话功能，但在宣称“全局、可证明、不可绕过的权限边界”前必须完成：

- [x] `FUTURE-1`：Ask/Smart 下审批 Agent 原生 cron mutation，并把已批准的 AgentTurn 任务归一化到
      per-agent Full 的隐藏 scheduler Agent；
      其他 Gateway operator 客户端明确保留为外部信任边界。
- [ ] `FUTURE-2`：决定是否需要“`full` 仅允许前台命令”。如果恢复该产品约束，使用公开
      tool policy 禁用 `process`/后台交接能力，并验证 `background`、`yieldMs` 和 shell detach；
      在此之前 UI 不声称“仅前台”。
- [ ] `FUTURE-3`：推动 OpenClaw 暴露 active trusted-policy/effective permission 的权威
      公共快照。接口可用前继续版本锁定 adapter，并以 packaged-runtime smoke 作为兼容门槛，
      但不得把诊断 RPC 当成权威证明。
- [ ] `FUTURE-4`：统一 auth logout native reload 超时的 fail-closed 行为，并同步修正安全
      架构文档中的无例外表述。
- [x] `FUTURE-5`：审批 UI 根据 `pluginId` 与 `toolName` 区分 JustDo 文件、cron 和其他
      plugin approval；Main 使用随机 nonce 与 agent/session/tool-call 组合校验取回完整 cron 参数，
      并以可滚动多行内容显示；取回失败时在 resolve 层只允许拒绝，不再依赖 Gateway 最多 256
      字符的 description，也不再误标为文件修改。
- [ ] `FUTURE-6`：补齐 workspace 逃逸测试，包括 Windows 盘符、路径大小写、
      junction/symlink。
- [ ] `FUTURE-7`：推动 OpenClaw 提供可信 cron run attestation，并把 exact
      `{agentId, jobId, runId, sessionKey}` 与 approval 绑定；Main 只在 active run 生命周期内使用，
      结束或超时立即清除。不得从 session key 格式和 job existence 推断真实性。
- [ ] `FUTURE-8`：为无人值守任务提供隔离 exec profile，不继承 Gateway operator token、CLI shim，
      且不能写 scheduler state；覆盖 CLI 和直接状态文件两条持久任务绕过测试。
- [ ] `FUTURE-9`：让 Full→Ask/Auto 的文件策略也具备单调收紧语义。host approvals 已在配置 reload
      前收紧；文件 trusted-policy 仍需 OpenClaw 提供不会向 Renderer 暴露的 Main-only 原子切换接口。

未来项目实施时先补失败测试，再修改代码；不得恢复第二权限状态源。新增 OpenClaw runtime patch
必须保持最小职责、版本锁定、可验证且有明确删除条件。

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
- 不凭 cron session key 或 job existence 发放 run-scoped approval；AgentTurn 定时任务只使用
  明确配置的 scheduler Agent Full；
- 不用 adapter status 自证 active policy；
- 不在 JustDo 实现 safe-bin parser、shell AST、命令 reviewer、allowlist 语义或全工具
  capability registry；
- 不让 Renderer 获得 admin policy 权限；
- 不把 desired/persisted 配置描述成 effective runtime；
- 不依赖 OpenClaw `dist` 深路径或内部文件布局；
- 公共接口不足时必须收缩安全声明或能力范围，不得伪造权威状态，也不得修改第三方 runtime。

### 三档产品语义

| JustDo 预设 | exec 配置 | 文件修改                 | 当前对话功能约束               |
| ----------- | --------- | ------------------------ | ------------------------------ |
| 请求批准    | `ask`     | 版本锁定适配器执行 `ask` | workspaceOnly；无 route 时拒绝 |
| 智能审批    | `auto`    | 当前退化为人工 `ask`     | 命令不确定或审核失败时转人工   |
| 完全权限    | `full`    | 无需批准                 | 缺失值默认；用户可随时切换     |

Browser、消息、MCP、marketplace 和第三方插件不自动受这三档覆盖。UI 只陈述上表中的当前
产品行为，不把产品配置展示成全工具 effective permission。

延期安全增强以 `FUTURE-1` 至 `FUTURE-9` 为唯一 TODO，不在其他章节维护重复清单。

## 验收状态

### 已完成的代码约束

- [x] JustDo 不存在 `permission-policy.json`；
- [x] JustDo 不直接写 `exec-approvals.json`；
- [x] adapter info 作为必要 readiness 条件，且文档不宣称它是权威 active snapshot；
- [x] 权限应用或回滚无法确认时 Gateway 停止；
- [x] UI 不展示运行时快照或配置同步进度；
- [x] 全局权限缺失或非法时默认为 `full`，会话切换不改变 runtime 权限；
- [x] AgentTurn 定时任务使用 per-agent Full 的 scheduler Agent，不锁定正常会话权限；
- [x] `022`–`025` 仅对可信 JustDo 交互审批维持无限等待、暂停、隐藏恢复和停止收口；
- [x] cron-shaped approval 不根据 session key 与 job existence 自动放行；
- [x] Ask/Smart 下 Agent 原生 cron mutation 进入一次性人工审批，Full/scheduler 直接执行；
- [x] 新 turn admission 等待此前排队的全局权限同步完成；
- [x] cron 启动/周期迁移分页覆盖所有任务，错归属启用任务迁移失败时禁用。

### 当前对话功能待验收

- [ ] `ask` 下真实 `write/edit/apply_patch` 在副作用前进入审批；
- [ ] deny、no route、Gateway unavailable 均无文件变化；交互审批不自动超时；
- [ ] allow-once 只消费一次；
- [ ] `auto` 在 reviewer 缺失时不静默放行；
- [ ] `full` 下命令和核心文件工具无需批准；
- [ ] 应用重启后恢复全局权限；切换会话不改变它；缺失或非法值回退到 `full`；
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
