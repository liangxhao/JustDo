# OpenClaw worktree 接入计划

> 当前分支 `feat/worktree-integration` 已接入原生可见 worktree 子会话的发现、身份绑定与继续，以及设置页 Worktree 清单和原生恢复/移除/清理接口。真实 Gateway + 模型端到端验收仍待执行；本文后续阶段保留完整验收目标。

当前发现流程仅接纳与父会话同一助手的可见子会话。跨助手生成的 worktree 子会话仍由 OpenClaw 管理，但不会出现在 JustDo 会话列表中；接入前需确定目标助手的产品身份与权限映射。

当前 Worktree 会话暂不支持复制/分叉：普通原生消息 fork 不继承检出所有权，直接复用原目录会让副本随原会话删除而失效。采用子会话时保留原生 guarded/workspace/full 权限，未声明时按 ask 约束接入；read-only 等产品无法表达的权限暂不接纳。

## 结论与范围

JustDo 使用 OpenClaw v2026.9.6 Gateway 执行任务。Git worktree 的创建、分支、快照、恢复和清理均由 OpenClaw 管理；JustDo 不实现第二套 Git worktree 生命周期。接入目标是让用户在 JustDo 内看得见、找得回、能继续使用原生 worktree 会话，并确保产品自己的项目路径、权限及删除操作不会破坏原生所有权。

这里的“模型触发”特指模型调用 OpenClaw 的 `sessions_spawn(..., visible: true, worktree: true)` 等原生托管接口。模型也可能通过 shell 直接运行 `git worktree add`；那会产生普通 Git worktree，不进入 OpenClaw 托管注册表，不受本面板的恢复与清理流程控制。提示词只能引导模型优先使用原生接口，不能保证禁止 shell Git 命令。若产品要求强制所有 worktree 走托管流程，需要在命令执行策略层识别并拦截相关 Git 变更命令，同时覆盖脚本、别名和其他间接执行路径；本计划不声称仅靠 UI 或提示词能完成强制约束。

会话界面默认隐藏 Worktree 选项。设置 → Worktree 中可开启“显示 Worktree 勾选框”，在新会话输入框右上角显示入口；每次新会话默认不勾选。勾选后，Main 调用原生 `sessions.create(worktree: true)` 创建会话并确认实际目录，再提交首轮消息。普通会话继续在所选项目目录运行。用户明确要求独立任务时，模型也可通过原生工具触发可见子会话；具体调用仍遵循 OpenClaw 的工具策略与用户授权。设置页同时承担清单、恢复和清理等管理职责。

## 已核实的原生契约

- `sessions.create` 支持 `cwd` 加 `worktree: true`，可选 `worktreeBaseRef`、`worktreeName`。返回的会话工作目录是新检出目录，持久会话记录含 `worktree: { id, branch, repoRoot }`。无初始消息时创建等待准备完成；有初始任务时可能先返回已接纳的会话，随后异步准备并报告失败。
- `sessions_spawn` 的 worktree 参数属于 `visible: true`、`runtime: "subagent"` 的独立子会话路径；隐藏子代理不接受这些参数。相同 agent 且未显式指定来源时，可继承父会话的受管仓库或直接选中的已注册项目。是否能调用还受有效工具策略、权限和运行环境约束。
- OpenClaw 文档要求仅在用户需要独立可返回的会话时使用 `visible: true`；普通内部委派不因需要隔离、运行较久或产出 PR 就自动升级为侧边栏会话。
- 会话归档、删除、闲置回收与恢复使用 OpenClaw 的快照和所有权规则。删除可能返回 `worktreePreserved`；此时目录仍需用户可见，不能宣称清理成功。自动清理和快照有保留期限，不能把“可恢复”说成永久保存。
- 网页 Control UI 的 New session 可手选 Worktree；Sessions → Worktrees 可列出、新建、恢复、删除、清理。全局 `worktreeRoot` 与 `worktreeAcceleration` 是 Gateway 配置，不是模型触发所需的 UI 设置。
- 原生默认目录为 `<openclaw-state-dir>/worktrees/<repo-fingerprint>/<name>`，`worktreeRoot` 只能设置一个全局绝对根目录，不能按源项目自动放到其同级。原生分支固定为 `openclaw/<name>`；`worktreeName` 只控制名称部分，没有可配置的分支前缀。这与“每个项目在当前工作目录同级创建 worktree、前缀可自定义”的期望不同，必须在实施前明确是否要求改变 OpenClaw 本身。

依据：`../openclaw/docs/concepts/managed-worktrees.md`、`../openclaw/docs/tools/subagents/tool-reference.md`、`../openclaw/src/agents/tools/sessions-spawn-visible.ts`、`../openclaw/src/gateway/server-methods/sessions-create.ts`。实现时以锁定的 v2026.9.6 运行时及 JustDo 补丁结果复核这些契约，不能仅依赖邻仓当前检出。

## JustDo 现状与缺口

| 环节 | 当前行为 | 对 worktree 的影响 |
| --- | --- | --- |
| 产品会话创建 | `openclawRuntimeAdapter.prepareSessionKey` 用产品 `session.cwd` 调 `sessions.create`，并断言返回的 `sessionRoot` 与该目录相同 | 不能直接给此调用增加 `worktree: true`；要区分项目源目录和实际执行目录，并保证重连时不重复分配 |
| 子代理展示 | `subagentGateway` 从原生 task 列表及 `sessions.describe` 补充状态；子任务面板主要按父会话展示 | 可见独立子会话目前缺少完整的侧边栏归属、导航、输入、恢复和停止流程；worktree 元数据未投影 |
| 项目路径消费者 | 审批范围、计划产物、Review、文件预览、浏览器扩展和会话详情等使用产品 `session.cwd` | 若产品主会话进入 worktree，必须逐项区分“源项目”和“实际工作目录”；只改创建参数会产生错误路径或越界判断 |
| 删除 | 产品先删本地会话，再异步递归调用原生 `sessions.delete`，失败被吞掉 | 原生 worktree 保留或清理失败可能在 JustDo 中失去入口；需保留可追踪的失败状态和恢复路径 |
| 协作边界 | 持久 Team 成员共享项目文件；当前文档明确没有自动 worktree 隔离 | 本计划不改变 Team/隐藏子代理的文件共享语义 |

相关代码：`src/main/engine/openclaw/openclawRuntimeAdapter.ts`、`src/main/engine/openclaw/subagentGateway.ts`、`src/main/engine/openclaw/wire/v2026_9_8.ts`、`src/main/data/coworkStore.ts`、`src/main/engine/openclaw/runtimePlanInteractions.ts`、`src/main/ipc/cowork/sessionReview.ts`。

## 实施顺序

### P0：锁定运行时能力并做端到端探针

1. 在 JustDo 实际打包的 v2026.9.6 Gateway 中确认 `sessions_spawn` 的有效工具列表、`visible/worktree` 参数、`sessions.list/describe` 的 `worktree` 与 `sessionRoot` 字段，以及权限模式；同时检查 JustDo 补丁是否改变这些能力。
2. 用有提交的临时 Git 仓库，从 JustDo 主会话请求一个可见 worktree 子会话。记录原生 session key、task ID、父子关系、checkout、branch、创建中/失败事件和完成通知。分别核对创建后、Gateway 重启后、JustDo 重启后的读回。
3. 验证创建失败、父会话删除、原生会话删除清理失败、闲置回收后恢复的响应。探针只用于确认协议，测试仓库及 worktree 通过原生生命周期清理。

完成条件：明确哪些信息能从原生 API 稳定取得、现有 JustDo 工具策略是否允许模型调用，以及是否需要扩展产品会话模型；任何字段或工具能力缺失都先定位运行时/补丁，不用推测补齐。

目录和分支策略决策门槛：若“项目同级目录”和“自定义分支前缀”是必须满足的产品要求，先在锁定版本的 OpenClaw 中设计并实现配置/命名扩展及其原生生命周期测试，然后再开展 JustDo UI 接入。只修改 JustDo 的 `cwd` 或创建后移动目录/重命名分支，会破坏 OpenClaw 记录的 checkout、所有者与恢复关系，不能作为适配方案。若只是偏好，则维持原生路径和 `openclaw/` 前缀，避免扩大运行时补丁面。

### P1：可见 worktree 子会话的产品接入

1. 建立原生可见子会话到 JustDo 任务/项目的持久映射，只保存身份、父子关系、源项目和生命周期元数据；消息历史仍由 Gateway 提供，不复制 transcript。明确同一原生会话跨重启去重、被原生侧删除时的失效处理。
2. 沿用现有会话导航和聊天操作，使原生可见子会话能够被打开、继续发送消息、停止运行并返回父会话；不在会话界面增加 worktree 专用操作。创建或准备失败的状态保留在会话中，并在设置页提供管理入口，不把失败的 checkout 当作普通项目目录。
3. 从原生 `worktree` 元数据取得分支、源仓库及实际目录；会话中可以被动显示当前位置，但不提供 worktree 操作。所有文件操作和 Review 使用经 Gateway 确认的实际 session root。源项目路径只用于项目归属，不作为 worktree 会话的写入根。
4. 删除/归档流程先以原生回执确认结果，再更新产品侧可见状态。若返回 `worktreePreserved` 或请求结果不确定，保留恢复/检查入口并展示原生原因；不直接删除目录或分支。
5. 按 `operator` 权限和现有产品权限模式验证新目录的可访问范围；不以来源仓库路径替代实际 worktree 的安全边界。

验收：模型可在用户要求独立任务时创建原生可见 worktree 会话；JustDo 重启后仍可定位、打开并继续；父子会话文件互不覆盖；删除失败时用户能从设置页找到保留的 worktree。勾选框只有在设置开启后才出现在新会话输入框，勾选创建使用原生检出目录；取消准备不发送首轮消息，失败不退回源项目执行。普通隐藏子代理和 Team 行为不变。

### P2：设置页 Worktree 管理面板

在设置中增加 Worktree 面板，通过 Gateway `worktrees.list` 显示名称、分支、源仓库、所有者、路径、活动/可恢复状态及最近活动时间。对已移除且可恢复的记录提供恢复；对可管理记录提供清理，显式展示快照失败或 `worktreePreserved` 原因。操作使用原生 `worktrees.restore/remove/gc` 并遵守对应 operator 权限；不直接执行 Git 删除。危险操作沿用产品现有确认交互。创建托管 worktree 可由新会话勾选框或模型经原生会话工具发起，设置面板不提供日常任务创建入口，也不声称列出模型通过 shell 创建的非托管 Git worktree。

### P3：全局设置（已接入）

设置页的“创建与存储”提供存储目录选择、恢复默认目录和文件系统加速开关，并展示当前生效（或待应用）的目录、分支规则及保存状态。两项均为 Gateway 全局配置，通过带查看时 `baseHash` 的 `config.patch` 保存；Main 与应用配置同步共用排他队列，只投影 Worktree 字段到 Renderer。Gateway 仍拥有配置和创建策略，SQLite 不另建配置副本。

保存后重新读取原生配置，核对目录和加速状态，并通过 `configRevisionHash` 与 `appliedConfigHash` 区分已保存与已生效。版本冲突、超时或断线不自动重试写入，页面保留修改并提供重新读取。应用的完整、无模型及登录/退出配置同步均保留原生 Worktree 设置，避免启动后恢复默认。空目录写入 merge-patch 的 null 以移除覆盖，恢复 `<stateDir>/worktrees` 原生默认位置。

修改存储位置只影响新分配的 worktree，旧记录仍使用原路径；恢复也使用原登记路径。文件系统加速默认自动启用，关闭后新分配使用普通 Git 检出。全局 `worktreeRoot` 不能实现每个项目的同级布局，自定义分支前缀也不是现有配置项；本轮设置明确展示这些规则。

## 测试与风险控制

- 单元/协议测试覆盖字段解析、重复发现去重、父子归属、路径分离、权限拒绝、删除保留和未知结果，不镜像原生 Git 实现。
- 集成测试以真实 Gateway 和临时 Git 仓库验证：创建、继续、重启恢复、归档/删除、创建失败及原生快照恢复。Windows 路径含空格和中文时至少验证一次。
- 非平凡代码变更按仓库要求运行 `npm run lint`、`npm run build`、`npm test`。本文是计划，不改变运行时行为。

最主要的产品风险是把“源项目目录”误当作 worktree 会话的执行目录，以及产品先隐藏会话而原生 checkout 清理失败。P1 必须先解决身份与可见性，再扩展创建入口。
