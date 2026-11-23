# 逐模块上游接口审计

每次 OpenClaw 升级都必须执行本清单，并在
`docs/openclaw-upgrades/<目标版本>/module-api-audit.md` 保存独立专项报告。
升级记录 [README](../openclaw-upgrades/README.md) 将它列为必交文件。
本清单与 [总清单](checklist.md)、[流式与执行](streaming-and-execution.md)、
[宿主与发行](host-and-release.md) 一起使用。

## 检查方法与证据

- [ ] 固定应用提交、旧/新 tag 和 commit、pristine 发布包、实际运行时及 Node 身份。
      应用源码只在升级 worktree 中修改；不得把主目录的其他分支当作待升级代码。
- [ ] 从生产源码收集 RPC 调用、方法常量、事件订阅、动态派发、SDK imports/注册、
      CLI 参数、配置投影和 HTTP 资源。字符串扫描只是索引，须排除配置键和文件名，
      补查动态方法与插件自定义方法，不能把“方法仍被列出”当作仍可调用。
- [ ] 对照旧/新 schema **和实际 handler/事件生产者**：必填项、closed schema、默认值、
      null/省略、结果字段、枚举、身份、权限、取消、回执、分页、生命周期和错误。
      删除接口、固定拒绝的退役 handler、同步转异步和 Promise 返回都须显式处置。
- [ ] 追踪变更到真实生产消费者：Main adapter → shared contract → typed IPC/preload →
      Renderer/插件。SDK 还需检查实际 owner、worker、异步调用和注册/停用收尾。
- [ ] 会话控制或启动观察的 SDK 变更须跟到 Goal、运行注册和插件 RPC 调用方。核对原生
      启动准入、禁止绕过准入注册、精确清理回执、调用者既有 scope，以及启动观察中的
      有限截止时间、`null`、字段缺失和 owner 失效。启动预算与实际执行超时分别验证。
      若以 `v2026.11.7` 为目标，按其 SDK 迁移指南核对 `runAttempt` 内注册与精确清理、
      `dispatchGatewayMethod` 的 manifest 声明与调用者权限、`startDeadlineAtMs` 的
      缺省语义。Goal 原生接线仍读取旧 `chatAbortControllers` / `chatQueuedTurns`，
      目标版需用实际 handler 验证新 owner 下的排队和原子准入。
      同时盘点同步会话读取与写入接口的退役，核对异步 worker 入口及读取后身份重验。
      `before_prompt_build`／`agent_turn_prepare` 的 transcript 内容可能已冻结，用目标
      SDK 验证插件通过返回值贡献提示词，原始历史与后续派发的 transcript 保持原样。
- [ ] 每个模块写“已适配并验证 / 无需适配并验证 / 未验证 / 不适用”，引用精确源文件、
      API 名、测试文件与执行结果。不适用解释原因；未完成不得写成通过。
- [ ] 每个实质变更至少有正向行为用例及相应负例。至少一层测试直接加载锁定原生
      schema/handler/发布包 owner，避免旧 mock、手抄返回值与应用代码一起过时。
      可控依赖注入的原生测试须写明替换了什么，不冒充真实模型/真实文件操作。
- [ ] 配置必须覆盖真实同步器的登录、退出、有模型和无模型启动落盘结果，同时执行
      目标原生 schema **与 legacy-config 检测**；provider catchall 接受旧字段不代表
      CLI 允许启动。加入废弃字段负控、重复同步和可选插件/权限保留断言。
      对仍承诺支持的回退来源，回归新版关闭可选服务后的实际落盘配置，例如实时语音
      的省略与 `null`，用旧版真实加载验证；已迁移数据根另按存储契约记录支持范围。
      不保留未发布旧代码兼容分支；这不免除当前数据库升级。分别核对迁移升级安装、
      正常升级安装、首次安装和正常启动，并验证正常升级保留数据、原生备份与维护、
      原生版本变化、同版本但 schema 待更新、占用/损坏/取消及失败后重新检查。
      schema 通过不能替代会话规范准备：覆盖大量现有行、原生提交授权超时、整组备份失败、
      下一进程复用真实文件回执、文件复制/替换与原生撤销后重新校验、无 pending 不重复备份。
      维护路径的离线准备必须在 Gateway 插件加载前完成，检查原生排他锁、Worker 自有租约与实际退休。
      已有完成记录、OpenClaw 版本相同、版本顺序校验通过且无未完成事务时使用正常启动，
      不执行宿主数据库预检、完整产物哈希或离线规范校验，原生实际准入由 Gateway 负责。
      正常启动完成后仅刷新 `lastOpenedIdentity` 并保留 `completedIdentity`，不能将打开记录
      视为新的维护证明；维护路径成功后才提交完整交付回执，失败不得发布成功身份。
      未完成事务仍精确匹配目标，未知版本及原生实际加载失败仍拒绝并保留数据。
      加入跳过版本、混合方向变更、降级待确认与未知版本的正反向测试；验证“仍然启动”
      只恢复当前目标的正常检查，不提前就绪、不跳过 schema 及实际加载错误，也不永久记忆授权。
      在真实 Electron Main 中验证完整开发包及发行省略 ASAR 两种形态；覆盖普通 fs 的
      虚拟目录行为、物理归档类型/整包 hash、实际归档内部模块与损坏负控，不能用
      `ELECTRON_RUN_AS_NODE` 或浏览器启动演练替代。
- [ ] 升级验收/CI 必须执行上游敏感测试 gate，传入目标冻结产物与源码：
      `node scripts/test/openclaw/run-openclaw-module-contracts.cjs --runtime-dir <产物绝对目录> --source-root <目标源码绝对目录>`。
      当前 gate 包含原生请求、13 个本地扩展实际 SDK 注册、maintenance receipt、STT WebSocket、Workshop 文件/版本/SQLite owner、
      管理 source/退役 handler、完整配置 schema/legacy 双检、正常升级的真实原生维护与负控，
      Workboard 实际 handler/SQLite adapter，以及真实 Electron Main 的 ASAR/省略 ASAR 准入；
      source 必须精确检出目标 tag 且无 tracked 改动。
      另验证目标原生关闭预算与各监督层关系、创建会话前的只读 readiness 等待、
      实际 Main loader/constructor 对应的原生相关响应证明，以及未知创建结果不重放。
      当前完整入口验收范围为 Windows x64；其他平台须先适配探针中的平台路径并独立验证，
      不以 Windows 结果认定跨平台通过。
      后续升级按新增变化扩充。缺产物、缺源码、身份不符或任一步失败应整体失败，不能只运行普通 mock suite。
- [ ] 测试确保“旧协议会失败”：退役 API 不能被继续调用；queued 不能被当作完成；
      身份不符、缺字段、未知枚举、超时/断线/迟到结果不能被算作成功或授权重试。
- [ ] 模拟测试、目标原生契约、最终产物行为、真实服务、Electron UI 和安装包验收
      分开记录。条件跳过要写触发条件；CI 必跑的关键契约缺运行时应失败，不能静默绿灯。
- [ ] 多 agent 独立审查差异与适配，再交叉审查实现和测试；处理发现并记录复验。
      不以新增兼容补丁、扩大权限或放松身份检查绕过适配。
- [ ] 更新拥有当前契约的 feature/architecture 文档及本版报告、验证记录，报告包含
      剩余风险、复验入口和实际范围。未接入的新原生功能也记录不接入理由。

## 模块覆盖清单

逐项在本版报告给出对应行和证据；可按职责细分，不能整组仅写“现有测试通过”。

- [ ] Gateway 连接、认证、roles/scopes、能力协商、generation、订阅与错误。
- [ ] 聊天发送/历史/完整消息/流式 Thinking、Content、Tool、分页、重连与资源。
- [ ] 会话 create/describe/list/patch/reset/fork/delete、助手与角色文件。
- [ ] 执行 whole-run、子任务、Goal、压缩、取消、审批、计划与提问。按[自动续跑规则](streaming-and-execution.md#已登记错误的自动续跑)
      审计原生错误生产者与应用匹配器，每个登记规则单列目标版本结论和验收证据。
- [ ] Agent Team 协作、讨论与 holding 的身份、收据和停用后收尾。主聊天中两种模式
      的首发均为带普通提示的 `chat.send`，沿用原生权限与 followup，真实业务提交
      另由 `task_assistants`、`sessions_send`、`team_discussion` 等入口验证。主聊天提示、
      成员单聊、群聊各自覆盖首次、已有会话、升级/重启之后和结果未知。仅组织者有权
      创建协作批次，成员交接必须有同批真实回执，旧文本或 Stop 不创建新批次。
      实际建房、成员单聊及旧回执收尾按各自 owner 核对原生活动，包含 queued、深层后代、
      不完整关系、错 SID/revision、连接换代、明确缺席和读取失败。活动缺字段保持未知，
      测试精确准入和清理不扫描全局目录；已知 key 的用量、标题和 Goal 重放核对仍使用
      精确 `describe`。
      补充真实 Main Store → Adapter → Router → IPC 的组合验证：产品 ID 与原生 SID
      不同、未保存 native key 但已有原生历史、历史绑定及自定义助手分别覆盖。
      检查 create 成功响应与迟到 changed 通知在 describe 等待期间交错；只读重查必须
      有界、固定原生身份/代次，反复失效和未知提交不得放行或重发。原生补证使用实际
      事件帧，分别注明网络投递控制、Main 组合和完整桌面 UI 的验证范围。
- [ ] Swarm Workflow/DAG/batch 的运行、并发、回执与清理。分别实跑主会话和节点，
      区分保存补充、同会话继续和新会话重跑。覆盖已有会话缺少保存的原生绑定时的实际
      节点投影、界面持续更新与切会话迟到通知。先验证节点可用工具，再验收交付阶段关闭
      工具，直接从已有证据产生摘要和交付件。
- [ ] cron 定时任务 CRUD、运行、delivery、owner、分页和结果。
- [ ] Workboard 卡片/评论/派发、memory/search、artifacts/progressCard。
- [ ] Skill inventory/启停/导入、Workshop 版本/变更/归档/恢复。
- [ ] Extension inventory/安装/启停/卸载/审查、required/optional 插件状态。
- [ ] 所有内置扩展的 SDK exports、注册、hooks、worker、工具和异步返回。
- [ ] 模型目录、provider/auth、登录/内置模型、凭据轮换和配置生效。
- [ ] 使用统计、可选活动上报与 `sessions.usage`。验证日期、物理会话身份、模型与来源
      的使用量映射，原生错误或缺字段保持未知。上报按已有配置读取运行中的 Gateway，
      不额外启动引擎或阻塞登录及发送。
- [ ] 图片/视频/语音/STT/TTS/embedding/decision 的实际原生 provider 接缝。
- [ ] MCP、MCP Apps、交互问题、Widget、draw.io 与认证 HTTP 资源。
- [ ] 浏览器模式、profile、配对/relay、介入、录制、扩展 side chat 和网页按钮发起的
      实际扩展 → Main → Gateway 组合验收。见[宿主专题](host-and-release.md#cliacp-与-chrome)。
- [ ] Worktree 列表/删除/恢复/清理与异步任务；终端 open/attach/input/resize/close。
- [ ] Config get/patch/hash、secrets/reload、suspend/restart 和可选状态保留。
- [ ] 启动路由、历史 import/inspect/原生身份校验、数据存储及诊断。
- [ ] Agent CLI、ACP、app-server 对会话、执行、授权和进度的消费。
- [ ] 文件预览/工作区/窗口/更新等无直接原生调用的模块，说明间接依赖和回归边界。

## 测试覆盖要求

| 场景       | 最少需要验证的行为                                                         |
| ---------- | -------------------------------------------------------------------------- |
| 请求与响应 | 新字段/省略/null、旧形态拒绝、返回结果解析、合法附加字段与未知枚举         |
| 异步任务   | queued/running/completed/failed、同任务只读查询、超时/断线、未知提交不重放 |
| 身份与权限 | sessionId/incarnation/generation、owner、缺 scope、跨窗口/跨插件与迟到回复 |
| 历史与事件 | 重复/乱序/截断/分页、订阅失效、停止 ACK 与 whole-run 结算的区别            |
| 插件/配置  | 启停/卸载/重启、可选插件状态、运行时实际生效、worker/SDK 同一 owner        |
| 资源与离线 | 认证/路径/大小/ETag、冷启动资源、断网边界与无公网回退                      |

用例按模块风险选择组合；数量不是目标，能够直接发现上游契约变化才是目标。
