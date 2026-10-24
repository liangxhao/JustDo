# v2026.10.6 逐模块上游接口审计报告

本报告补充本次升级的逐模块兼容性复查，不能由 TypeScript 编译、旧 mock 或历史测试总数代替。
审计发现此前漏掉的两处真实不兼容：技能 Workshop 旧提案接口已退役；Worktree 清理改为异步任务。
本轮通过应用侧适配解决，不新增 OpenClaw runtime patch。

后续启动日志复查又发现配置接缝遗漏：废弃的 Workshop `approvalPolicy` 仍被保留，
TTS 生产投影与设置保存仍写旧字段。此前只用空配置和 schema 通过来判断启动兼容不足，
补充的真实配置/legacy 检测见第 2.3 节，四类启动及正常升级见第 2.4 节。

## 1. 基线、方法与结果边界

- 应用基线：`89a074ece6852258042bc401437ceffa904ea4a5`，已经包含上一阶段升级改动。
- 上游：本地只读源码 `v2026.10.4`（`383c124cc32ffee3f8e56f549b88da94d269a4af`）→
  `v2026.10.6`（`fe06181dc5ecc01cf8904abbfc26925925efefbc`）。发布包、补丁和最终运行时身份见[验证记录](validation.md)。
- 本轮仅在 `E:/workspace/worktrees/openclaw-upgrade-audit/JustDo` 实施；主目录 `E:/workspace/JustDo`
  保持 `dev`。新 worktree 从同一升级提交建立，复用原升级目录中只读的 release2 产物。
- 扫描 1,938 个生产源码文件，得到 195 种符合原生前缀的字符串引用；其中也包含配置键、事件和文件名，
  **不是 195 个已调用 RPC**。进一步逐域核对方法常量、动态派发、插件注册、事件及真实消费方。
- 对照的是 `packages/gateway-protocol/src/schema/`、server handlers、事件生产者、SDK owner 和应用调用链。
  去除注释/空白后，44 个 schema 变更文件中有 27 个生产 schema 文件存在 token 变化；新增非产品能力也单独处置。
- 三个 agent 分别审查执行/会话、管理/浏览器、SDK/模型/扩展；方案交叉审查后实施，再独立复审实现和测试。
  根 agent 补查启动历史、连接、诊断、CLI/app-server，并整合完整矩阵。

下列“无需新增适配”仅针对已列出的生产接缝。原生契约测试、应用回归、真实模型、桌面 UI 和安装包验收分别记录；
没有把前轮 native smoke、mock 或 loader inspection 扩大成整模块端到端通过。
本版对应的流程勾选项见[模块审计清单](../../upgrade-checklist/module-api-audit.md)。

## 2. 本轮发现与适配

### 2.1 Skill Workshop：旧提案接口已退役

10.6 `src/gateway/server-methods/skills-retired.ts` 对旧 `skills.proposals.*` 方法固定返回
`INVALID_REQUEST`。方法仍出现在原生方法目录，不代表业务仍可调用；旧 mock 继续返回 proposal 对象会掩盖问题。
新契约由 `schema/agents-models-skills.ts`、`server-methods/skills-workshop.ts` 与原生 Workshop library 定义。

应用原先仍调用 `skills.proposals.list/inspect/apply/reject`。现改为原生
`skills.workshop.list/changes/read/archive/restore`，同步 shared、typed IPC、preload、界面与中英文文案。
界面展示当前技能、保存版本和最近变更，由用户选择精确版本恢复；不把旧批准/拒绝伪映射成归档/恢复。

审查特别核对：`archived[].live:true` 表示仍存在当前副本；restore 回执中的 `change.versionId`
不必等于用户指定的恢复版本；changes 无完整分页 cursor，不能宣称展示了全部变更。变更请求单次提交，
未知结果通过刷新重新观察和选择，不自动重复归档/恢复，不伪造原生不存在的 CAS。

### 2.2 Worktree 清理：接收任务不等于清理完成

10.6 `schema/worktrees.ts` 为 `worktrees.gc` 增加 jobId/state/时间/错误；
`server-methods/worktrees.ts` 改用 `gateway/worktree-maintenance.ts`，先返回 queued/running 回执。
原应用直接把 RPC 返回当作清理完成，会过早显示成功。

Main 现保留原 manager、生命周期 generation 和任务 ID，只观察同一个任务，completed 才成功，failed 明确失败。
断线、超时或首次提交结果未知均保留未确认状态，不能再发一个空参数请求启动替代任务；
界面在观察期间保持 busy，未知状态保留已显示的 Worktree 列表。任务回执丢失不能由 UI 推断为成功。

### 2.3 启动配置：实际 CLI admission 与 schema 需要分别核对

升级 worktree 的用户启动日志明确记录 `openclaw@2026.10.6`，在配置准入阶段因
`skills.workshop.approvalPolicy` 未识别而退出，exit code 为 78。后续健康等待和设置查询
失败是该退出的连带现象。主目录旧日志不能用于解释这次启动。

当前投影清理废弃的应用字段，Workshop 的 `autonomous.mode` 和现有偏好保留；
TTS builder、扩展合并、完整/最小/退出配置及设置 IPC 统一写当前 `auto`、
`speakerVoice` / `speakerVoiceId`。手动朗读不通过旧 `enabled` 字段控制，扩展明确启停独立保留。
按本次开发要求，不保留未发布旧代码兼容分支，不将旧声音别名或 enabled 晋升为新配置；
旧开发环境的声音选择可在设置中重新保存。

`TtsConfigSchema` 的兼容字段与 provider catchall 会接受部分旧值，但原生
`findLegacyConfigIssues` 仍会识别它们。回归必须对真实同步器的完整落盘结果同时执行
未修改的目标 schema 与 legacy 检测，并覆盖已有配置、登录/退出、有模型/无模型、
重复同步、可选插件和权限保留；重新注入废弃键的负控必须失败。

### 2.4 四类启动与正常升级安装

“不兼容未发布旧代码”不免除数据库更新。当前启动按数据代际与交付身份划分：

| 场景 | 数据处理与进入应用的条件 |
| --- | --- |
| 迁移升级安装 | 仅保留已发布 JSON/JSONL 历史；选择性备份、隔离旧环境、原生导入并核对物理身份后恢复产品历史元数据 |
| 正常升级安装 | 保留会话、产品数据库、配置及其他现有数据；原生检查、必要的完整数据库备份和 schema 维护、严格复验后继续初始化 |
| 首次安装 | 无现有环境，建立当前目录、产品数据库和运行配置 |
| 正常启动 | 已完成相同交付身份且实际原生检查无待维护项，进入紧凑启动界面 |

10.4→10.6 的 shared schema 保持 20，agent schema 从 24 升至 25；10.6 普通启动
会拒绝待维护的 24，不能把原生数据库初始化当作自动升级。自动调用通用 `doctor --fix`
还会触及配置、插件及服务，不能用于只维护数据库的正常升级。

Main 新增 `startup/upgrade`：使用交付 Node 和锁定当前版本的原生 owner，
在产品 Store、配置同步前完成 schema 维护；配置及历史恢复后、外部入口和 Gateway
启动前再完成原生 canonical 准备。应用不写原生迁移 SQL，
不复制 transcript，不新增 runtime patch。selected owner 的路径、字节和导出由静态合同
及冻结 manifest 校验；完整依赖图仍由构建配方与封存产物验证，不能以局部 owner hash 替代。
维护使用原生 Gateway 排他锁、数据库维护 scope、agent lease、完整备份和原生更新，
原生关闭及子进程退出均被等待；失败、取消或强制结束不生成成功回执。

当前合同只接纳 shared20 和 agent24/25（全新缺失数据库另行初始化）；更旧、更新、损坏、
未知身份和未完成发布均保留文件并阻断，未恢复撤回的 9.6→9.8 兼容桥。
`startup-state.json` 记录应用版本、runtime 版本和冻结构建身份，缺完成回执、OpenClaw
版本变化、实际 schema 待维护、上次正常升级中断均走正常升级。仅应用版本升高或
构建指纹变化且 OpenClaw 版本相同、无需维护时直接正常启动；成功复验和初始化后
严格原子刷新完整完成身份，失败保留旧回执并报错，后续降级据此判断。构建指纹仍完整
参与准入和未完成事务归属，不单独决定展示路由。重试先重新检查原生事实，不能凭旧
退出码或旧完成标记盲目继续；待确认降级继续使用现有升级外壳。

HTML 首屏、React 和窗口交接固定同一路由；正常升级显示五步与真实检查/备份/更新/复验活动。
开发版也使用相同判定，另提供 `startup:preview` 内存演练四路界面。
交付方向和 schema 支持范围集中声明，跨版本升级按目标合同检查，不串接相邻版本分支。
应用/runtime 任一版本降低时先暂停并提供“仍然启动”，用户确认后释放同一启动流程，
不提前就绪或写永久跳过。无法比较的版本不推断兼容；继续后实际数据检查与加载错误
照常执行，不能只凭 schema 数字相同或确认按钮推断兼容。两类启动界面均覆盖提醒和错误。
当前源码与隔离原生探针的结果、最终产物身份及未验收边界分别记录在 `validation.md`；
真实用户数据库不作为测试输入。

### 2.5 首页 Apps：原生后台准入与失败准备的恢复

真实升级窗口已进入首页并建立认证连接后，日志仍记录一次 `sessions.create` 因助手数据库
inspection-pending 被拒绝，稍后原生 agent admission 恢复。日志没有该调用的参数或宿主
调用栈，不能把它直接归因于首页 Apps。独立执行当前宿主源码则确认一个具体缺陷：
`WorkspaceAppSessions` 按窗口/requestId 缓存拒绝的创建 Promise，之后显式重新发现仍取
同一个失败结果，无法恢复。原有“发送结果未知不得重发”的规则必须保留，不能泛清缓存。

目标原生 `agent-database-admission.ts` 给出 `UNAVAILABLE`、`retryable:true` 与精确
`details.code:'agent-database-inspection-pending'`。但深层提交后异常也可能经公共错误转换
形成同类 receipt，单凭此 shape 不足以证明没有创建。最终应用侧方案是在派发创建前先对
本次自有 key 做原生只读 `sessions.describe`；目标 pre-dispatch 对该观察方法等待助手准备，
实际 handler 用 `session:null` 表示不存在。仅这一只读阶段收到当前原生客户端已相关的
精确 pending 负响应、且创建未派发时，才回收该失败准备供后续显式重试。碰撞不借用；
创建派发后的任何错误和未知结果保持原边界，既有成功身份也不因后续 describe 失败而丢弃。
Main 的 service/router/adapter/manager、客户端代次及窗口/requestId/配置作用域同时设防，
并在实际发送前复核；并发初次等待、后继替换与关闭均保留精确身份。

新增第十一门 `workspace-preflight.native-probe.cjs` 使用严格冻结产物及自身 Node，执行实际
Main resolver/loader/capture；证明当前选中 constructor 与原生公共 facade 严格相同、共享
原生相关性 WeakSet，并拒绝未相关的同形原生 Error。Workspace 的请求端口受控，验证只读
pending 后显式创建一次、未相关失败固定及创建后 pending 不重发，不宣称实际 Gateway RPC。
`workspace-preflight-native-contract.test.ts` 另外执行目标原生 pre-dispatch 与 describe 整函数
以及当前 Main DI，依赖端口受控，验证真正等待、空记录和交付 owner 换代。生产无 runtime
patch 或配方输入变更；真实桌面在后台准入恢复窗口的目录和工具使用由后续独立复验承接。

后续实际隔离 Fresh 窗口已进入首页，`sessions.describe` 成功，随后 `sessions.create`
明确因开发 profile 下的 `project` 不存在而失败。此错误不是新的 10.6 cwd 合同：原生
显式 cwd 在新旧版本均只做真实目录检查。Main 配置路径设置开发隔离默认值，Store 也
消费它，但启动 mkdir 仍硬编码 home 默认路径，形成两个默认目录来源。最小修复仅导出
Store 既有 `getDefaultWorkingDirectory` 并让 Main 的原有 awaited 初始化复用；函数选择
语义、可选初始化失败反馈、原生 guard 与创建后未知结果边界不变，不被动创建保存的
任意自定义工作目录。共置 `coworkStore.defaultWorkspace.test.ts` 九例执行实际 Main 块、
Store 配置读取与真实临时文件，验证中文隔离路径、生产/相对 override、既有内容保留、
自定义路径不创建、文件冲突和等待顺序；不使用原生 SQLite ABI 或 Gateway。实际 GUI
重验由独立桌面证据承接，不能以该文件系统测试替代 App 启动/工具交互。

最终真实 Electron 已覆盖 Fresh、Normal 和 shared20/agent24→25 正常升级，三轮均进入
首页且原生 describe/create/describe 成功；升级后的原 SID、合成事件与完整原始备份经
独立复验保留，Gateway/Main/launcher 均正常退出。具体界面、身份、测试数量和进程证据
见[最终启动矩阵](validation.md#最终真实启动矩阵)。Fresh/Normal 各有一次临时会话 delete
与停机竞争而未确认，不能把进程退出 0 当作删除完成；真实模型或 App 工具操作仍未由
这些启动与只读/创建调用替代。

### 2.6 dev 启动复查：规范校验与 Team 首次发送

2026-10-24 在 `dev@6f192d3bf` 后续复查。实际主目录运行时经严格验收为
10.6/33 patches/16 owners/207 recipe 输入，排除沿用旧运行时；原始日志只保存在
ignored 证据目录，不提交会话内容。首次 canonical Worker 提交授权超过原生 5 秒
期限，随后两个助手 unavailable，报告日志中反复出现 828 次同类 RPC 错误。
其前后有约 5–6 秒同步插件加载；没有精确 commit-request 时刻，不能归咎于某个插件。
也没有据此宣称数据库损坏或仅 schema 不兼容。

| 模块/上游 owner | 适配与原生依据 | 回归边界 |
| --- | --- | --- |
| 启动、原生存储 | `assertOpenClawDatabasesReady` 只证明 schema，不能替代 `certifySessionCanonicalValidationPending`。Gateway 前增加离线准备，由原生 certifier 决定是否待写；真实文件代际回执不能在复制文件或只读快照上复用 | 正式 `native-canonical-preparation.native-probe.mjs` 直接编译调用生产 transport/SOURCE，含大量行、下一进程复用、复制/替换、撤销、备份失败和真实 5 秒 commit 拒绝负控 |
| 维护/Worker 授权 | 原生 Doctor 外锁全程持有；维护租约下探测与全组备份，正常释放后 Worker 获取自己的普通租约；全部 Worker join 后重新维护复验。两个新增 owner 导出进入精确 bytes/alias/ASAR 合同，既有 patch 不变 | 无待写不重复备份；未知提交或退休不得发布成功；原生 private snapshot 改变物理身份，且直接只读打开缺 SHM 的 WAL 库会创建 SHM，故不把这项维护塞入只读 inspect |
| Team 两种显式模式 | 原空闲检查把 `known:false` 也提示为 busy，全局 full scan 会在任意会话通知后失效。改用原生 describe 的当前主运行/queued/递归后代聚合；保留 SID、nullable revision、连接和来源围栏。旧普通会话也可能未持久化 native key，明确缺席还须验证没有旧执行回执和继承来源 | `runtimeSessionStatus.targeted.native-contract.test.ts` 直接执行目标源码完整投影函数与真实事件 payload；行为测试包含无关独立 root、未知祖先、错身份/修订、连接替换及旧回执。真实 Gateway 首发脚本另测 host/native 边界，不冒充真实企业模型或完整组队 UI |

用户确认的 busy 文案只能定位两次发送前空闲检查之一；原日志未记录该次具体 flags，
不能断言点击时一定是 unknown。新增安全阶段日志只记录 known/running 等标志，
不记录正文或凭据；未知仍拒绝且使用准确提示，不自动重发。最终产物身份、测试结果、
实际界面观察与未验收项见[本轮验证记录](validation.md#2026-10-24dev-启动与-team-首次发送修复)。

### 2.7 五条人工发送入口：定点准入与扩展产物

后续复审覆盖 Team 主会话、成员单聊、公开群聊，以及 Swarm 主会话和节点人工输入。
10.4→10.6 的 `chat.send` 没有新增必填发送字段；问题集中在应用仍用全局目录判断
单个目标是否可发送、局部事件身份过宽，以及既有探针没有经过真正的五条产品链路。
`sessions.send` / `sessions.steer` 复用原生聊天执行入口，但 steer 具有中断语义，
不能用它或裸 `agent` RPC 替换全部人工消息。Swarm 节点继续使用自己的受管执行权限。

| 入口 | 实际消费者与本轮处置 | 当前证据及限制 |
| --- | --- | --- |
| Team / Swarm 主会话 | `SessionRunBegin` 仅将旧 restart-checkpoint 的发送前检查改为 `targeted`；真实 Renderer `ChatController` 和 `dispatchInitialTurn` 仍发送同一准备好的 `chat.send` | Main IPC 与实际状态函数组合回归；真实 controller/client 经 Gateway 完成新建、续发、重连、initial dispatch、错身份拒绝及 ACK 丢失不重发，全部 wire（含初始化）零全局列表；不宣称该原生探针覆盖 Main IPC 或 React UI |
| Team 成员单聊 | `CollaborationCoordinator.prepareContinuation` 对来源、选定目标及全队成员读取精确 key/SID/revision，保留 room/成员/配置/连接代次；未知独立于 busy | 真实 Host→native peer 发送及历史通过；原生 bind/dispatch→Requested→host.handle→resolve 的 ensure 桥创建一次，已有意图只读、未知零创建/发送/删除；不宣称模型自行组织团队 |
| Team 公开群聊 | 真正的 `TeamDiscussionCoordinator`→`teamDiscussion.prepare/start/status/history`；执行与汇总两个 whole-run 消费点都要求事件 SID 严格等于已登记 SID，缺失也拒绝 | 两个缺 SID 负控通过；实际建群、两成员精确终态、公开原生历史和同请求零重发通过，含三成员团队的精确 CAS 清理 |
| Swarm 节点人工输入 | `intervene` 的 note/continue/retry 保留各自受管来源、回执与 native execution 语义，不以普通 `chat.send` 绕过所属关系 | 正式 bundled 扩展真实 source-start、note 零派发、失败节点同 SID 新 run 继续、丢 ACK 同 operation 对账、新 key/SID/run 重试及已有主会话 status 工具通过；原生 whole-run、公开 cleanup 与原文历史分别核对，无需 Swarm 生产适配 |
| 首条消息后的单目标观察 | 标题 SID 解析、usage 详情及三处 Goal replay 去掉 search-list 补桥，使用精确 `sessions.describe` | 168 项定向回归含两个上游真实函数/连线契约；省略或损坏 `activeRunIds`、错 SID/key、连接或产品身份改变均保持未知，不补发输入 |

原生 `server-methods/sessions-read-by-key.ts` 为 describe 注入
`createVisibleActiveSessionRunProjector`，通过同一 presentation 发布 `hasActiveRun`
及完整可见时的 `activeRunIds`。上游 `sessions-describe-active-run.test.ts` 对照 describe
和 roster 的 queued/running/done；projected owner 仅提供活跃事实时，两者均省略精确
run ID 集合。应用不能把这种省略当作旧 run 未执行。成功 ACK 后的 Goal 观察失败保留
原 run/operation；Main 的执行 Promise 继续等待精确 whole-run，而非提前返回成功。
后台 Goal 恢复、侧栏目录及其它确需完整范围的读取仍保留原职责，本轮没有整体替换。

Team 的首次创建、发送前旧回执释放和删除同样使用定点观察。删除要求真实字符串
revision 的原生 CAS；nullable/未知身份保留删除待确认，不能放宽成只按 key 删除。
已知原生缺席、停止 ACK、空闲或产品状态都不能替代 whole-run 和清理回执。

本轮只修改本地 Team 扩展的两个 SID guard，未新增 native patch 或重建 Gateway core。
新 `win-x64-collaboration-send-2` 从已验 753 运行包复制，执行官方资源同步、扩展编译、
prune 和 manifest writer。207 项配方、core manifest、Gateway bundle、ASAR、SDK、
Node 及全部非扩展字节不变；独立 `extension-assembly-receipt.json` 绑定当前扩展
源码闭包、生产入口、资源输出、工具和完整树。core manifest 不被宣称为本地扩展全包身份。

永久入口 `scripts/test/run-collaboration-send-contracts.cjs` 按精确上游 tag 与当前配方
准入，再串行调用实际 Main 通知准入、controller、Team 和 Swarm 探针；有装配回执时核对其来源和输出，
全新构建没有回执时可只读重现两个官方生产 bundle 并逐字节比较。发送及清理阶段
强制拒绝应用层 `sessions.list`，controller 初始化也要求零全局列表。插件静态入口检查
与 Host 实际 wire 计数分别记录，不能混称动态观测。实际五路径通过与否须以各
探针的 exact SID/run whole-run、原生 history、零未知重发和自然关闭结果为准；
三个最终探针均实际通过并正常关闭，逐项身份、失败复验和范围见
[五类消息验证记录](validation.md#2026-10-24team-与-swarm-五类消息入口定点复查)。

本轮未改写既存 accepted-timing 的空闲/root 变更后备收敛；它不构成原生执行终态证据，
已单独记录[待实施计划](../../plans/session-run-terminal-evidence.md)。发送 checkpoint 在
等待后须仍是同一启动 marker，计时被替换即返回未知，不能借本次定点查询进入旧后备。
Goal 历史重放退役的是重复操作的本地展示和等待，不是给旧运行补造 whole-run 结论。

### 2.8 准备响应后的会话通知与 Main 准入接缝

同日用户在 dev 实测，普通聊天已完成，随后选择 Team 仍在 `before-preparation`
返回未知。四次 console/Main 日志均出现 create 成功、迟到 changed、describe 成功的
交错。只读产品元数据为 idle/main、没有持久 native key 或 history binding，存在已完成
的普通运行，没有旧 Team launch 回执；用户给出的是物理 SID，不能把它当产品会话 ID。

实际生产链路是 `CoworkView` 先同步会话权限，经
`SessionPermissionModeCoordinator` → `OpenClawRuntimeAdapter.prepareSession` 调用
原生 create，再由 `SessionRunBegin` → Team launch 检查空闲。上游
`server-methods/sessions-create.ts` 在 `respond(true)` 之后才调用
`emitSessionsChanged`；`session-change-event.ts` 异步准备快照，某些失败形态仅发送
无 key 的目录通知。应用原有事件处理会淘汰目标或祖先不明的在途状态读取，因此请求
本身成功仍可能返回未知。不能通过忽略通知、把缺失状态当空闲或扫描全局会话绕过。

本轮只调整应用侧状态观察：首读确为合法原生行、只有事件 token 被淘汰，且产品身份、
client/generation、本地未知执行/恢复边界保持时，丢弃首个结果并重新精确 describe 一次。
第二次固定首读物理 SID 和 lifecycle revision 的省略/null/字符串三态，错身份、换代、错误、
缺行、再次失效均保持未知；实际主执行/后代忙碌仍拒绝准入。没有 mutation 或发送重试，
没有新增 runtime patch、核心或扩展重建。安全原因日志区分查询失败、身份改变、未知
custody 和事件反复失效，不记录响应正文或提示词。

此前 controller 原生探针绕过 Main IPC；Team 原生探针使用受控产品元数据与准备/状态
端口，两者均未证明上述完整接缝。本轮补充实际 Store、Adapter/propertyContext、生产
事件处理、Router 与 IPC 组合，及真实原生事件帧的投递时序验证，分别标注控制端口与
桌面 UI 边界。回归先在旧实现明确失败，再按固定身份和负控复验。
实际结果、探针和未验收范围见[本轮验证记录](validation.md#2026-10-24迟到会话通知与-main-准入补查)。

## 3. 按功能模块检查

以下上游路径相对 OpenClaw 源码，应用路径相对本仓库。测试结果与限制集中在第 5、6 节。
`[x]` 仅表示源码/契约检查和处置已记录，不表示该行全部端到端验收；实际测试结果及未验收项以第 5、6 节为准。

| 勾选 | 模块 / 原生接缝 | 上游实际变化与生产消费者 | 结论及回归入口 |
| --- | --- | --- | --- |
| [x] | Gateway 关闭、开发监督与更新安装 | 原生已有 shutdown325/stop330 秒预算；真实桌面发现宿主 15 秒强杀及 16 秒无退出即成功。Main/launcher 监督层、成功回收和失败传播均受影响 | 已适配共享预算、同 child 单次 deadline、实际 close 证明和失败围栏；正常关闭超过 15 秒仍等待，强杀/无退出不重启，未知清理不关闭 Store 或继续安装。shutdownPolicy 原生敏感测试、Gateway owner/launcher/Main 阶段测试，完整 GUI 结果见 validation |
| [x] | Gateway 连接、认证、scope、订阅 | `server/ws-connection/connect-{hello,session,operator-access}.ts` 新增能力和设备来源校验；共享 secret operator、backend mode 与已有 scope 不改。应用 `engine/openclaw/runtimeGatewayConnection.ts` 使用真实原生 client、受管 token、`deviceIdentity:null`，Renderer 指定 controller 使用独立认证连接 | 无需新增适配；连接 generation、拒绝/断连/迟到 hello 与重连测试，未新接入公网 account 或 worker 管理 |
| [x] | 聊天发送、排队与未知提交 | `logs-chat.ts` send 参数未变；内部 normalization 改为异步。应用只 await RPC，不直接同步调用内部 normalization，保留 idempotency 身份 | 发送字段无需调整；应用发送前定点准入、Goal replay 及五路径验证接缝见 2.7；initial-turn-dispatch、queued-input/pending-input、native input receipt 与 cancellation 用例保留 |
| [x] | History/startup/分页/完整消息 | 新增可选 `toolResultMaxChars`，`chat.message.get.sessionId` 和 8M 上限；reader 改成 prepared/current-sharing publication。`wire/v2026_10_6.ts`、Renderer `chat-history-protocol.ts` 已在升级基线传选定物理 SID，保持更小请求预算与分块回退 | 基线已适配；目标真实 validator 边界、wire/history/reconciliation、SID 不符、旧 generation、截断与分块测试 |
| [x] | Thinking/Content/Tool/activity/进度 | 新 `AgentActivityItem.unpairedCall?:boolean` 是无配对显示标记；原生异步 publication 内部实变。应用保留 sidecar，按 owner/scope/seq 合并，未把 unpaired call 当工具或执行终态 | 无需新增适配；流式段序、preamble/rollback/空替换、snapshot、重复/乱序/迟到与恢复测试；具体传输历史仍以 validation 的 native 场景为限 |
| [x] | Stop、whole-run、恢复 | `agent.wait` 从独立文件移到 `agent.ts`，前后授权及 generation/SID 检查保留；abort 参数未改 | 原生执行回执仍只信精确 `executionSettled:true` whole-run，Stop ACK/chat final/idle 不替代；execution/recovery/terminal 负例。既存产品计时后备限制见 2.7，不宣称本轮已修复全部计时收敛 |
| [x] | Sessions list/search/status | 新可选 source/excludeDock、lifecycleRevision/sessionModelRevision/hasBoard/isDock/childOwnerSessionKeys；移除 conversationLink。应用 sessionListClient/runtimeSessionStatus/subagentGateway 不依赖被删 link | 目录用途保留；当前发送、cleanup、标题和 usage 单目标读取改为 describe，见 2.7。compact/full 保留已知事实，历史 ancestry 仍用 spawnedBy；wire/status/search/subagent 回归 |
| [x] | create/fork/reset/delete/worktree adoption | 新可选 `surface:'plugin-dock'`、worker placement；handler 强化 trusted spawn 与 prepared source。应用显式 key/agent/cwd，不制造原生可信来源 | 无需新增适配；sessionBranching/worktreeSession/adoption 测试；既有 managed-fork 窄补丁仍目标版本专属 |
| [x] | 权限、cwd、exec/plugin approvals | 请求/decision enum 无实质 diff；native writer/source authority 加强。应用现有 pending 身份、允许选择、过期和 exact SID 校验保持 | 无需新增适配；permission coordinator、approval routing/grants、迟到/撤销/Stop 回归 |
| [x] | Goal、压缩、Plan、问题 | Goal schema 未改，handler 改为 await fingerprint 并捕获原生 SID/revision/owner；Plan/问题由所属扩展等待工具持有，压缩取消不等于结算 | 无需新增适配；Goal continuation/receipt、compaction、plan/question tests；不恢复宿主 transcript/终态推断 |
| [x] | 助手/角色文件/档案删除 | agents CRUD/files schema 未变；原生统一 2MiB UTF-8 写界限。产品 100k 字符限制仍更严，文件 API 持有正文；删除只退休产品 roster | 无需新增适配；nativeAssistantCreation/profile/agents 测试，不调用会清历史的 agents.delete |
| [x] | Worktree list/remove/restore | 三类请求未变，native owner/readback 和非 force 删除保持 | 无需新增适配；engine/settings/native request 边界；真实 Git snapshot/恢复仍需安装版验收 |
| [x] | Worktree gc | 同步操作变 queued/running/completed/failed 任务。应用 Main 与 UI 原来误认完成 | **本轮适配**；coordinator/UI 测试及真实 native maintenance owner 控制调度/GC probe |
| [x] | 终端 PTY | terminal schema 只有注释变化；内部 kill helper 提取，不改变真实 exit/offset。应用保留 agent/sessionKey/native PTY ID、attach snapshot 和 offset | 无需新增适配；Main/Renderer terminal 与 shared-terminal tests，重连只 attach，未知 stdin 不重放 |
| [x] | cron 定时任务与运行结果 | cron/config schema 无 tag diff；cron-list 拆成 immutable read/projection，full 默认保持，新 deliveryPreview 可选。应用 cronJobService 保留 snapshotRevision 分页、expectedConfigRevision 与真实 enqueued/runId | 无需新增适配；cronJobService/permission/runtime 映射测试；真实调度器/长时 delivery 另验 |
| [x] | Workboard | `packages/workboard-contract` 新可选 cardsRevision/sessionsRevision，gateway 改 runOperation wrapper；既有 CRUD/start/dispatch 返回保持 | 无需新增适配；原生 Workboard adapter/产品 IPC、CAS/派发/停止测试；不从新 revision 推断执行结算 |
| [x] | Memory/search、artifacts、progressCard | memory-search handler 无 tag diff，version 省略仍 legacy search；产品只请求主助手/max20，校验结果诊断。artifacts/progressCard 原生接口与 revision/scope/clear 边界保持 | 无需新增适配；memory/artifact/progress tests；真实 embedding/index freshness 和模型质量未新验 |
| [x] | Skill inventory/启停/导入 | skills-status 原生合同保持，文件事务和解析赢家由 native APIs 拥有；Workshop 是独立 breaking change | 无需新增适配；skill service/native resolution/extension toggle，保留同名 fallback 与 extension scope |
| [x] | Skill Workshop | proposal schemas 删除且旧 handler 固定拒绝；新 current skill/version/change/archive/restore | **本轮全链路适配**；service/UI/typed IPC、真实新 schema 和退役 handler 测试，见第 2 节 |
| [x] | Extension/Hook/MCP 管理 | plugins schema diff 仅注释，hooks/status 保持；catalog handler 拆分。应用 native inventory/install/setEnabled/uninstall/reload/refresh 与配置 hash 仍权威 | 无需新增适配；required Runtime Services 保护、optional 状态、mutation receipt/restart、MCP/Hook tests |
| [x] | 模型目录与会话选模 | catalog 新 sessionModelRevision/service-tier observation/recommended；设置页用 provider-config 视图，未把 observation 存为配置；session patch 请求未改 | 无需新增适配；models/managed model queues/native wire tests；UI 请求 revision 不冒充 native revision |
| [x] | 登录、内置模型与凭据轮换 | 应用登录 SDK 自有；native secret resolver 仍异步 Map，provider wrapStream hook 未删。Runtime Services 每请求 await SecretRef、校验 authSession/route/取消 | 无需新增适配；登录/换证/迟到清理/builtin model HTTP tests；真实公司 SDK/JWT 服务另验 |
| [x] | OpenAI 源码/路由/service tier | 上游 85 份 provenance，37 生产源实变且新增 service-tier-policy，基线已完整替换。显式公司 endpoint gate 保留，未注册公网 OAuth/RTC/catalog fallback | 基线已适配；source SHA、真实 SDK composition/显式缺 endpoint 负例；不是仅检查 import 名称 |
| [x] | 实时 STT/Talk | factory/session 状态及 predecessor 链算法实变并已刷新；Talk transcription 公开 schema/8k µ-law 不改。Main onlineAsr await session，保持 owner/audio 校验 | 基线已适配；本轮新增真实 native provider + loopback WebSocket 双端点/顺序/重连/close/缺地址测试，补旧 fake transport 缺口 |
| [x] | 文件 STT/TTS/图像/视频 | STT helper 未删；tts.speak RPC 无 tag diff，但当前配置废弃 enabled/voice 别名，原生产写入遗漏已修正；image 源完整采用；本地 video adapter 继续受支持 native Provider Promise 合同 | TTS 配置与设置 IPC 已适配；真实 schema 与 legacy 双检、规范声音读写、无旧值晋升和可选状态保留回归；真实音视频设备及企业服务另验 |
| [x] | Embedding/Decision/TypeSafe | OpenAI client resolve 内联、compatible deadline/vector parsing 已刷新；TypeSafe 400 加入 413/422 unsupported-input 分类，401/403/429 保留 | 基线已适配；SDK declarations/transport/admission/native resolver 测试；不绕授权 fallback |
| [x] | MCP Apps/draw.io/Widget/交互回答 | native view/launch/formResource 与 descriptor 认证边界保持；首页 Apps 新增创建前原生只读 describe 等待，仅相关 pending 且创建未派发可供之后显式重试。产品每次 await 后重验身份 | 首页 workspace 恢复已适配；实际 Main loader/native correlation 与上游等待/空记录函数测试，保留 unknown send 围栏；Widget 资源合同保持，真实工具/租约及 Electron UI 仍另验 |
| [x] | 浏览器设置/配对/relay/介入/录制 | browser request/工具 action 管理由 native owner 保持，浏览器扩展升级基线已刷新 29 项资源并保留产品 overlay | 无需新增适配；browser config/action/pairing/recording tests；真实 Chrome/CDP/企业网页另验 |
| [x] | Chrome side chat | overlay 只消费产品 app-server，不直接 import upstream SDK；Main browser controller 消费 native session/history/stream，连接换代和 source 限制保持 | 无需新增适配；sidepanel stream/DOM/messages/activity + browser controller，合成流不冒充实际 Chrome |
| [x] | Config/secrets/reload/suspend/restart | config RPC envelope 无 tag diff不代表原生配置内容不变；Workshop approvalPolicy 已移除，TTS legacy 检测有独立准入规则。secret reload 与 prepared apply/source 权威保留 | 当前配置字段已适配；完整落盘结果 schema+legacy 双检，保留 baseHash、实际 loaded hash、optional state、suspension ID 与回滚；首次保存不等于运行生效 |
| [x] | 启动历史/存储 | JSONL import/inspect 继续由原生拥有；shared schema 20 保持，agent 24→25，10.6 普通启动拒绝待维护的 24。Electron 普通 fs 将 ASAR 作为虚拟目录 | 已适配四类路由、原生维护及物理 ASAR 校验；内部模块继续严格校验，真实 Electron/省略 ASAR 正控与损坏负控进入必跑。保留历史迁移与恢复测试，不恢复已撤回的 9.6→9.8 兼容桥，不读用户 transcript |
| [x] | 诊断、Agent CLI/ACP/app-server | 诊断读认证会话与日志投影；agent.wait 文件移动无协议改动。外部 adapter 用精确 SID/incarnation/run/generation 和 terminal/wait receipts，不依赖 private handler 路径 | 无需新增适配；externalAgent execution/resources/progress、ACP、AppServer transport/binding/disconnect tests；不是第三方客户端实机验收 |
| [x] | 文件预览/工作区/窗口/托盘/更新/主题 | 无直接 native Gateway/SDK 接口；通过 Main 本地文件授权、IPC、工作区服务或上述会话边界间接依赖 | 不需要上游 API 适配；产品 lint/build/Renderer/IPC 回归，安装/覆盖升级/系统 UI 仍独立验收 |
| [x] | 新 process inventory、dock/worker UI、catalog/search/theme/prefs 能力 | 新 session-processes 最大 50 条、48KiB、tail2k，stop 要精确 SID/process/instance；其他新 schema 非产品已接入接口替换 | **不接入**：无现有生产调用，不伪造进程权限或把新增能力当已有功能；未来需求走领域设计，未宣称这些新界面已验 |

## 4. 13 个内置扩展的 SDK 接缝

原生注册检查与业务执行不是同一种证据。本轮再次运行的 13-extension inspection 证明真实 SDK loader 注册/释放，
不证明所有工具已端到端执行。`getSessionEntry` 仍同步；内部 `loadSubagentSessionEntry` 的确异步，
两者不能混为一谈。后者的 019 修复已在升级基线完成，本轮没有新建 authority 缓存或兼容桥。

| 勾选 | 扩展 | 检查的实际 SDK/Hook/返回值 | 处置与验证边界 |
| --- | --- | --- | --- |
| [x] | runtime-services | registerProvider/Embedding/Tool/GatewayMethod/Harness；before_prompt_build/llm_input/before_agent_finalize；transcript facts/read/append、subagent run/describe/cancel、exact native source guards | 已有 async 019/031 修复；公开 transcript Promise 均 await；required 服务不依赖 Team；领域回归与前轮真实 proof 分列 |
| [x] | agent-team | registerChannel、channel-inbound/reply dispatch Promise、before/after_tool_call、持久 transcript commit、exact settled event | public reply adapters 移除 host-only 私有字段，本地未传这些字段；协作/讨论/holding/summary/permits 回归；真实多助手模型另验 |
| [x] | swarm-workflow | tool/model/finalize hooks、managed run/wait/describe/cancel、trace/span、result budget | native tool factory 异步由原生 await，model/agent_end 不当 whole-run；events/submission/batch/cleanup 回归，真实长 DAG 另验 |
| [x] | plan-mode | agent_turn_prepare、TrustedToolPolicy、registerTool/service gatewayEvents、最新 native entry | 公开上下文与 replay-safe helper 保持；计划/提问/Goal 关闭回归；真实审批 UI 另验 |
| [x] | ask-user-question | execute(signal) Promise、pending/resolve RPC、service gatewayEvents | 工具等待/取消不替代执行结算；extension question/late/reset tests |
| [x] | automation-permission | async TrustedToolPolicy.evaluate、同步最新 entry、operator.read info RPC | 新 Async sibling 不改变旧同步方法；native permissionMode 仍权威，policy/cron 权限回归 |
| [x] | drawio | contextVersion2 factory、prepared exact identity、dispatchGatewayMethod Promise envelope、native MCP preview Promise | 所有 await 后重查 current；native App/插件与恢复 tests，断网导出/真实 UI 待验 |
| [x] | widget-kit | registerBoardWidgetContentKind、真实 show_widget/canvas document、authenticated descriptor/HTML | 注册及 viewer/admission tests；前轮隔离 Gateway HTML/禁用/重启证据只覆盖其场景；真实 Electron 待验 |
| [x] | embedded-browser | contextVersion2、prepared identity/signal、registerService、saveMediaBuffer Promise | native SDK 形态无破坏；桥接/权限/释放 tests；真实 guest/CDP 待验 |
| [x] | stt-local-cli | tool factory/execute(signal)、native workspace/root 权限、Sherpa 子进程 | 无 realtime Talk 依赖；插件回归，不增加公网 fallback；麦克风/模型权重待验 |
| [x] | openai | Provider/Embedding/Image/Video/Speech/RealtimeTranscription/MediaUnderstanding 注册与两个 worker entries | 已完整刷新且只注册公司支持能力；本轮真实 WS 补强，见模型/媒体各行 |
| [x] | acpx | registerAcpRuntimeBackend、tryDispatchAcpReplyHook、Service、native catalog、session handle/generation/lease Promise | 基线已三方合并 8 模块并替换被删 JSON helper；stdio fixture/reset/oneshot/lease 回归；真实用户 CLI 多平台待验 |
| [x] | typesafe | definePluginEntry/registerDecisionProvider、prepared secret、guardedFetch/release、contractVersion1 union Promise | 基线已采用 400 分类；declarations/transport/admission/错误负例；真实企业服务待验 |

## 5. 本轮测试与独立复审

本节在实施完成后记录最终命令及实际结果。运行中的用例、计划用例、前轮 release2 总数均不提前计为本轮通过。

新增测试分三层：应用行为测试验证真实消费者；目标发布包的 validator/retired handler/maintenance owner
验证模拟形态没有过时；真实 native OpenAI descriptor 连接隔离 loopback WebSocket 验证异步 transport。
其中退役 handler 由精确目标 tag 源码 bundle 执行；发布包行为则由 frozen artifact 的 validator、
maintenance owner、Workshop library 和 STT descriptor 分别证明，不能混称同一证据。
所有 native probe 必须显式选择锁定产物、严格校验当前 recipe/manifest，并使用产物自带 Node24.22.1。
缺产物或身份不符应失败，不静默跳过。

统一必跑入口（从本 worktree 执行）：

```powershell
node scripts/test/run-openclaw-module-contracts.cjs --runtime-dir E:/workspace/worktrees/openclaw-upgrade-audit/JustDo/build/runtimes/openclaw/win-x64-collaboration-send-2 --source-root E:/workspace/openclaw
```

当前 Windows x64 入口串行执行十三组上游敏感测试，精确检查 source HEAD=目标 tag 且 tracked 源码干净，
任一步缺资源、超时或失败均整体失败；后续升级须替换目标产物并随实际差异扩充用例。
原七组之外，启动补查新增真实 Main 落盘配置的 schema/legacy 双检，以及实际原生数据库
升级/拒绝/占用/回滚/取消/packed-shape 场景。此前启动补查的固定产物严格通过全部九组，
最后数据库八组自然退出且 `cleanClose:true`；产物身份与逐项结果见
[验证记录的启动补查章节](validation.md#2026-10-24启动配置四类启动与正常升级补查)。
真实桌面启动进一步发现 Electron 将 ASAR 呈现为虚拟目录；第十组在实际 Electron Main 中
验证物理归档、内部模块及省略 ASAR 两种形态，保留损坏负控，不能用 Node 模式代替。
第十一组检查创建前只读 readiness 与实际 Main loader 的原生相关响应证明；第二组同时检查
原生关闭预算与 Main 接线。新构建身份、先前十组与最终十一组结果单独记录在
[桌面启动章节](validation.md#2026-10-24工作区关联修复与真实桌面启动)。
第十二组是后续 canonical 准备边界，第十三组是 2.7/2.8 的发送契约。可单独执行后者的五个阶段，
避免为纯应用发送适配重复全部原生矩阵：

```powershell
node scripts/test/run-collaboration-send-contracts.cjs --runtime-dir E:/workspace/worktrees/openclaw-upgrade-audit/JustDo/build/runtimes/openclaw/win-x64-collaboration-send-2 --source-root E:/workspace/openclaw
```

这是永久验收入口说明，不表示本轮已经完整运行十三组或该五阶段命令；具体逐项实跑结果另记验证记录。
此前十一组入口已在本地执行；未远程运行或修改 GitHub Actions。CI 使用它前必须准备精确目标源码及其
schema 构建依赖、完整冻结产物，现有 CI 的旧补丁检查不能代替本报告的模块验收。

以下表格是先前七组模块审计的历史结果。当时新 checkout 的 CRLF 与冻结输入字节不同，曾被严格准入拒绝。51 个 recipe 文件在规范化文本完全相同的前提下
恢复原冻结字节，未改逻辑、未修改 manifest 或放宽 verifier；ignored package-lock 按原字节恢复。
当时产物为 validation 记录的 release2，而非此前被否决的旧 win-x64 目录。
启动补查修改了配方，必须从 pristine 重建；不能修改旧 release2 manifest 使其冒充新交付。

| 本轮执行 | 实际结果 | 证明范围 |
| --- | --- | --- |
| `run-openclaw-module-contracts.cjs` 七项统一 gate | 最终隔离布局七项全部通过、exit0、零跳过 | source 精确 tag/clean、每个 native probe 严格 manifest/recipe/自带 Node；以下 native/source 行是其分项，不重复加总；先前两次 EPERM 失败仍保留 |
| `local-extension-registration.native-smoke.mjs` | 1/1，通过全部13 ID，零 error diagnostics | 真正 native loader 的 inspection、`activate:false/runtimeSideEffects:false` 及 release；不宣称13类业务工具全部执行 |
| `module-api-protocol.native-smoke.mjs` | 51/51（30 正向、21 负向） | 真正发布包 AJV 校验器：chat/history/message/SID/8M 上限、session、agent.wait、config、cron、plugins、Workshop、Worktree、terminal |
| `worktree-maintenance-receipts.native-probe.mjs` | completed/failed 两模式通过 | 真正 native owner queued→running→terminal、同 ID 只读、错误 ID 拒绝、回执 clone 隔离，每模式 runGc 仅一次；调度器及实际文件回收注入，不删真实 worktree |
| `openai-transcription.native-smoke.mjs` | 1/1，零跳过，自然退出 | 真正 native loader/descriptor 与 loopback WS；双端点凭据隔离、predecessor 逆序仍 one/two、重连同 itemId 不拼旧 partial、close 单次 commit/最后正文、缺端点零连接、socket/inspection 释放 |
| `workshop-library.native-probe.mjs` | 7 组检查通过 | 真正 frozen native library、隔离文件与 SQLite worker；6 次精确动作 create/write_file/patch/指定版本 restore/archive/restore、支持文件、变更 feed、authority/path 负例与 owner join |
| `management-protocol-native.test.ts` | 18/18 | 目标 tag 的真实 TypeBox schemas、scope specs、固定退役 handler；新版 service 出参/回执送原生校验，catalog 列出旧方法但 handler 仍拒绝；cron/config/plugins/hooks 请求边界 |
| Workshop service/UI/IPC 定向 | service31 + UI8 + IPC5 通过 | Main-only、路径/版本/形态校验、迟到读、未知写不重放、用户重新选择确认、typed bridge；另18原生源码用例已在上一行列出 |
| 执行/会话/权限/历史/终端等定向 | 22 文件515通过，另 helper16 + UI7通过，合计538，零跳过 | 含新 wire/activity、gc integration、history/Goal/subagent/permission/approval/assistant/branch/worktree/terminal/stream/input；与最终全量回归重叠，不累计 |
| `workboard-upstream.contract.test.mts` 的实际 adapter 验证 | 1 文件1用例通过（内含 CRUD/CAS/start/stop/dispatch 多项断言） | 实际10.6 handler/WorkboardStore + 临时 SQLite adapter，subagent/sessions/chat.abort 为可控端口，不是实际模型调度 |
| lint / 生产 build / Main 类型编译 | 通过 | 应用 ESLint、TypeScript/Vite、`tsc --project electron-tsconfig.json`；最终全量回归另记录于 validation |
| 全量执行与失败文件复验 | 1,167 文件：最终1,148文件通过、19文件条件跳过；用例去重15,363通过、544条件跳过 | **两阶段合并结果，不是单次全绿命令**。全套首跑15,110通过、1用例失败、2文件收集失败；3文件随后257/257通过，其中4个原已通过用例不重复计数 |

全套命令使用显式 release2 运行时和目标源码，首次选用 threads pool；
两个旧 patch 测试忽略已显式提供的 native runtime，仍读不存在的默认目录，另一个旧配置测试的
`process.chdir` 不受 threads 支持。两处入口增加同一 native env fallback，保留 pristine 优先和所有原断言；
随后以 pristine P + 完整依赖 F、项目默认 forks pool 重跑这三个文件，257/257通过且零跳过。
独立 frozen 模式另为247通过/5个 pristine-only 对照跳过；pristine 模式已覆盖这5个对照。
总通过数计算为15,110 + (257 - 4) = 15,363；544个条件跳过不计为通过，
历史版本、平台/专用 fixture 与真实服务等未覆盖范围继续明确保留。不能把分项定向和 gate 再加进总数。
完整结果亦见[验证记录](validation.md)。

保留失败与修复复验：首次 strict 准入缺 ignored lock/CRLF 字节不同；首次 protocol 命令误用 `--test`
把产物目录当第二个测试路径；初版 helper 的同步子进程60秒期限、退役旧源码路径错误、Workshop 6 次写操作误断言7次，
均在对应修复后按原语义复验。未缩减场景、修改运行时证明或把失败计作通过。
初次全量命令因共享 better-sqlite3 DLL 占用未进入测试；随后试跑因新 worktree 的联接路径被 Vite CSS
沙箱拒绝、插件独立依赖未准备而未形成有效全量验收。保留原联接并改为独立依赖副本后重跑，
未改生产安全配置，也不终止正在运行的用户应用。

**Windows 原生快照发布限制：** 七项 gate 曾两次在 Workshop 原生 `snapshotSkill` 的
staging→version 目录 rename 报 EPERM，分别位于 archive 与 patch；第二次已无其他测试并发。
失败现场与原日志保留，不能宣称七项首次通过，也不能归因为杀软、目录监听、同名或并发。
只读核对未见明显的测试句柄泄漏；其中 archive 实例失败在当前技能移出之前，live 指令/支持文件完整，
但应用不能据私有文件状态替代原生提交回执，仍按未知结果处理。
受控 A/B 的独立新 profile（项目目录2次、系统临时目录3次）均7组通过，尚未定位这两次 EPERM 的根因。
为规范隔离，最终 probe 将业务 state 放系统临时目录、项目 `.agent-tasks` 仅存身份、state 路径及成功/失败证据，
原7组断言、错误传播和 SQLite owner join 保持，不增加 sleep、业务重试或 runtime patch。
最终完整 gate 在该布局下七项全部通过、自然 exit0，日志为
`build/upgrade-audit/module-contract-audit/native-gate-separated-profile.log`；不能据此消除已观察到的 Windows 文件系统风险。

另一次尝试用 TypeScript 检查全部扩展与发布 SDK 的静态整图产生 292 条诊断，**未通过**。
目标 SDK 的部分实际 subpath 只有 default JS export、未发布完整 `.d.ts`；allowJs 推断还遇到独立插件依赖缺失，
因此这次方法不能证明静态 SDK 全图兼容。诊断保留并与旧版声明/实现对照，未把它们全部冒称为新版本 bug，
也未用 native 运行成功覆盖这一静态验证限制。

另已追踪新增内部 `assistantTurnId`：它用于 native source reply 的幂等 scope，并没有透传到公开 tool start/result 流。
当前公开工具展示仍依赖真实 run/callId/seq；本轮未新增 response 级 UI 身份保证，也未用未公开字段或猜测 ID 修补语义。

## 6. 未由本轮自动化替代的验收

真实公司登录/JWT/模型/图片/语音/视频/embedding/decision 服务、麦克风/音频设备、Chrome/guest/CDP、
真实 Electron Widget/draw.io/审批/终端/协作和工作流 UI、安装包断公网冷启动、覆盖安装/卸载、
旧独立 JSONL 用户资料恢复、macOS/Linux/ARM/签名/DACL/多屏等，仍以
[验证记录的未验收清单](validation.md#尚未完成的实机与发行验收)为准。
合成 loopback 服务、注入 GC 调度器、mock IPC 和只读 loader inspection 均不替代这些验收。
