# OpenClaw 升级检查清单

升级 OpenClaw、重新生成运行时补丁，或刷新本地 OpenAI 源码替换前，必须先读本文。
检查范围包括供应链、Gateway/SDK 契约、配置与执行、消息展示、产品功能和最终安装包。
运行时能够启动、TypeScript 编译通过或一次聊天成功，都不足以证明升级完成。

升级时同时核对[流式与执行](streaming-and-execution.md)、
[宿主与发行](host-and-release.md)和[逐模块上游接口审计](module-api-audit.md)中的专项检查项。

当前仓库基线为 `openclaw@2026.10.7`；后续升级以 `package.json.openclaw.version`
为准。源包 integrity 以目标版本补丁目录的 `source-lock.json` 为准，逐补丁能力、
上游证据、依赖与删除条件以该目录 `README.md` 为唯一总账。本文不固定补丁数量，
也不把历史版本验收结果当作目标版本的通过记录。

版本对应的产物身份、验证范围与未验收项见[升级记录](../openclaw-upgrades/README.md)。

本文中的勾选项是升级时需要执行的检查。每个领域应记录「通过 / 需适配 / 未验证 /
不适用」，附目标版本、测试或人工场景及证据；不适用必须说明原因。即使判断无需
修改代码，也应说明对照了哪些原生契约、运行了什么回归。已知限制仍以
[功能文档](../features/README.md)及对应架构说明为准。

## 1. 升级基线、范围与变更记录

- [ ] 按[模块接口审计清单](module-api-audit.md)覆盖功能索引与全部生产原生调用，
      在 `docs/openclaw-upgrades/<目标版本>/module-api-audit.md` 交付独立报告，
      逐模块记录上游差异、适配结论、正反向用例、真实原生契约证据和未验收项；
      同步本目录和升级记录 README 的入口。不得仅引用旧 mock 或测试总数宣布兼容。
- [ ] 保留当前工作区改动，在隔离 worktree 中升级。记录应用提交、旧/新 OpenClaw
      版本、目标平台、Node/Electron 约束以及本地插件版本，避免混入无关修改。
- [ ] 阅读旧版到目标版之间的 release notes、breaking changes 与实际代码差异。
      若使用上游 checkout，核对 tag/commit 与目标 npm 包；同时比较发布包的 dist、
      worker、CLI、SDK exports 和 manifest，不能只依据源码或发布说明。
- [ ] 为 Gateway 方法/事件、SDK API、插件注册、原生配置、存储格式、浏览器扩展和
      模型协议分别建立变化列表，关联下文受影响领域及产品调用方。
- [ ] 为每项原有补丁或本地差异明确选择：原生已覆盖、移到应用层、移到普通插件、
      接受原生行为变化，或保留窄接线。删除时同步修改调用方、测试、构建清单和文档，
      写明用户影响；不能仅以「上游有类似功能」认定等价。
- [ ] 从未经修改的目标 npm 包重建。新版本创建自己的补丁目录与 source lock，
      重建 pristine contracts；不得修改版本号后沿用旧 anchor、迁移旧 vendor runtime，
      或添加历史/部分补丁形态的就地兼容。只允许当前精确形态的幂等。
- [ ] 核对插件裁剪策略与全部上游插件清单。新增插件逐项决定保留、裁剪或本地替换；
      未知插件应使构建失败，不能自动进入发行版或默认启用。
- [ ] 使用独立测试 profile，按各自边界备份产品数据库、Gateway state、插件状态及
      必要配置；凭据和原生日志不进入 Git。存储变更必须单独说明上游支持范围及恢复方法。
      不恢复已撤回的 9.6→9.8 原生 SQLite 迁移桥、启动门禁或构建资产，也不自动删库重建。
- [ ] 分别验证迁移升级安装、正常升级安装、首次安装和正常启动。正常升级必须覆盖
      跳过原生版本、实际 schema 待更新、失败/取消后恢复及全部现有数据保留。
      仅应用升版或同 OpenClaw 版本新构建、且实际无需维护时直接正常启动；成功后刷新
      完整交付回执，写入失败报错，未完成事务仍精确绑定目标。
      集中声明目标 owner 与支持的来源 schema，不以相邻版本 if 分支串接升级。
- [ ] 应用或 runtime 任一降低时先提示并等待用户选择“仍然启动”，确认后接回同一
      正常启动流程，验证受信主 frame、精确请求/目标、单次消费和退出取消。确认不能
      标记就绪或成为永久跳过；版本不可可靠比较、数据格式不支持及实际加载失败仍
      显示具体错误并保留数据，相同 schema 数字或用户点击确认不能代替实际兼容性。

工程流程见[补丁操作指南](../openclaw-runtime-patches.md)和
[构建脚本说明](../../scripts/README.md)。离线资源地址、文件名和准备命令统一维护在
[离线下载文档](../offline-downloads.md)，不要在本文复制另一份下载清单。

## 2. Gateway、SDK 与跨进程契约

先核对原生请求/响应，再检查应用 adapter、共享校验、preload 和 Renderer 消费方。
对于删除或重命名的接口，不能继续发送旧请求，再用空列表或 UI 推断补齐含义。

| 接缝           | 必须对照的变化与通过标准                                                                                                                                  |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 连接与能力协商 | WS 初始化、认证、角色/scope、事件订阅、能力声明和错误形态；旧连接 generation 失效，重连重新读取权威状态，不创建第二个 Gateway                             |
| 聊天数据面     | `chat.send/startup/history/message.get/abort` 的 closed schema、回执、分页和事件；完整页与增量页的 session 身份分别核对，数据仍由指定聊天 controller 消费 |
| 会话与子任务   | `sessions.create/describe/list/changed/abort`、fork/reset、物理 sessionId、incarnation 与父子控制归属；以目标版本实际支持的原生会话投影为准               |
| 执行与交互     | whole-run lifecycle、`executionSettled`、原生运行 registry、Goal、Plan、问题与审批的身份/取消语义；接收、执行结算和工具清理分别确认                       |
| 插件 SDK       | package exports、注册方法、hooks、`runtime.subagent`、取消信号、trace/span 与 worker imports；所有本地扩展在目标 SDK 下实际注册，不仅通过应用类型检查     |
| 管理 API       | plugins、skills、cron、artifacts、progressCard、memory、worktrees、terminal、browser 与 config 的参数和返回值；区分可选能力缺失、无数据和读取失败         |
| 配置应用       | schema、null/省略/默认语义、`config.patch` 版本 hash、reload/suspend/restart 事件；文件写入、本地保存与运行时生效分别验证                                 |
| HTTP 资源      | Widget、媒体和预览的认证/来源/路径、大小与缓存规则；新资源 URL 或 descriptor 不能自行成为权限                                                             |

- [ ] 更新 `src/shared/openclaw/` 的原生契约/校验及 `src/main/engine/openclaw/`
      的对应 adapter。新增 IPC 同步 channel 常量、typed payload、Main handler、最小
      preload 和 `src/renderer/types/electron.d.ts`，验证权限及非平凡参数。
- [ ] 比较未知字段、缺字段、null、空结果、截断结果、冲突、拒绝、超时、断连和迟到响应。
      新增枚举先确认语义，不把未知状态映射为成功，也不静默丢弃有效原生内容。
- [ ] Gateway bundle、动态 SDK 与插件共用必要的原生状态模块实例；跨 bundle 验证
      grant/read/revoke、原生会话访问 registry、transcript write context 与 CLI-history
      boundary。不能只验证每个模块单独 import 成功。
- [ ] 保持 Main 的产品生命周期/权限/元数据、Gateway 的执行/原生历史、Renderer 的
      显示投影边界。不得恢复 `cowork_messages`、Main/Redux transcript cache，或由插件
      导入应用 `src`；required Runtime Services 不依赖可选插件注册时机。

参考：[架构](../architecture/02-architecture.md)、[进程模型](../architecture/03-process-model.md)、
[执行引擎](../architecture/05-agent-engine.md)、[数据存储](../architecture/10-data-storage.md)。

### 2.1 MCP Apps 原生生命周期

MCP Apps 使用原生认证 WS 接口，不使用生命周期补丁。关闭视图停止本地交互，
不保证后台取消；视图及临时授权按原生租约到期回收（当前创建后约十分钟）。
工具调用格式纠正补丁 029 不提供 MCP Apps 生命周期能力。
完整契约见 [MCP Apps 宿主](../features/chat/mcp-apps.md#原生接口与插件替代审计)。

- [ ] 重读目标版本 WS 派发、App view/disposer、SDK 与方法描述，核对是否新增公开的精确请求取消、可确认的最终视图释放和多窗口隔离接口；有则通过公开接口接入，无则保留原生行为，不恢复补丁或访问私有 store。
- [ ] 核对 TTL、授权范围、原生过期和后台收尾语义；分别测试本地 AbortSignal、已发出操作、等待审批/提问、断线、迟到响应，不把取消 ACK 当成副作用回滚。
- [ ] 验证原生 view/launch/history/formResource 返回形态，普通工具 descriptor 与问题预览引用各从认证来源准入，不要求已删除的 `appIdentity` / `hostLeaseId`。
- [ ] 回归精确 `updateId` 清理、文件 ETag/订阅、旧 session/incarnation/generation 拒绝、跨窗口影响及未知结果不重试；核对冷启动 draw.io 三种导出仍不依赖公网资源。

## 3. Thinking / Tool / Content 消息流与历史展示

**每次升级都要重新核对消息流适配。** 检查链路为原生事件/历史 → Gateway client →
准入与 reducer → history reconciliation → timeline pipeline → React/Lit 展示。
只有完整链路语义未变且回归通过，才能记录「无需重新适配」。

### 3.1 实时事件与段顺序

- [ ] 对照 reasoning/redacted-thinking、正文、工具前 preamble/commentary、tool call、
      update/result/error 的原生形态、owner 与序号。Thinking 缺失可能是模型能力或配置
      所致，不编造思考内容；工具前后多段正文不能合并后再按时间戳猜排序。
- [ ] 分别处理 delta、累计 snapshot、可替换段和 `replace:true`，覆盖空字符串撤回。
      累计快照不能再次 append；正文撤回不能清除独立 Thinking、Tool 或 preamble，
      迟到旧段也不能复活已撤回内容。
- [ ] 验证 sessionKey、物理 sessionId、runId、lifecycle/connection generation、
      toolCallId、entry identity 与各 owner sequence 的准入。重复、乱序及稀疏恢复事件
      不覆盖新内容，不能用一个全局 latestSeq 拒绝其他 owner 的有效补缺。
- [ ] 覆盖单次 run 内 Thinking → Content → Tool → Content、多工具并发/交错、
      多次模型 attempt/fallback、工具失败后继续回复，以及只有 Thinking 或空回复。
      工具状态不能取代整轮失败原因，错误后已有部分输出继续保留。
- [ ] 验证工具 `progressText` 与 partial result 分开更新，终态接管后清除临时进度；
      迟到 partial 不回退进度，input/result 补全不丢失。禁止为每个进度帧轮询历史。
- [ ] 对照 Tool Search 的核心 `tool_call` 包装及 Code Mode 嵌套记录。`exec({code})`
      展示原生标题与代码，普通 `exec({command})` 保持 shell 含义；`wait`、嵌套调用和
      取消使用原生事件，不增加第二套等待执行器或结果缓存。
- [ ] 区分 `chat.final` 的显示收敛、attempt 完成、Stop ACK 与真正 whole-run
      `executionSettled:true`。终态后迟到 delta 不重新开启运行，旧 run 不结束新 run。

### 3.2 历史、重连与完整消息

- [ ] 运行中重连或首次打开活动会话时，同时对照 `chat.history.messages`、
      `inFlightRun.text` 与 `inFlightRun.events`。无正文的进度事件不能抹掉独立 text；
      迟到历史补入旧消息，但不能覆盖已接受的更新实时尾部。
- [ ] 比较刷新前后 Thinking/Tool/Content 的原生显示投影、原生 entry ID 与 commentary。
      当前不使用已删除的 017/018 恢复/顺序补丁，不承诺重现未持久 Thinking 的全部交错；
      不因历史块顺序与 live 不完全相同而重排原生历史。
- [ ] 验证初始历史、旧页、增量页、message get 和分块补全的 cursor、offset、字符预算、
      truncated 标记及取消。缺失一页不是消息被删除；完整消息读取不能吞掉独立 commentary。
- [ ] 覆盖分页期间追加消息、分支 leaf 变化、reset/fork、冷归档读取和读失败重试。
      当前会话/连接/历史 generation 变化后旧读取失效；读取失败保留已显示内容，
      不提交空成功快照，也不在首次权威读取完成前开放发送或导出。
- [ ] 工具 input、失败 detail 和 compaction detail 仅凭原生身份有界补取。超大结果、
      补取超限或临时失败保留可诊断占位，不根据「已截断」文字猜原文或永久空结果。
- [ ] 实时用户气泡、`session.message` 和历史接管按原生身份/幂等键去重。
      连续发送相同文字仍显示两次，不能用文本相等合并真实输入。

### 3.3 输入、过程折叠与阅读交互

- [ ] 核对 `queueMode:followup`、`pendingInputs`、`inputReceipts`、独立 pending 分页、
      `suppressCommandInterpretation` 和精确撤回。接收 run 与后继执行 run 不混淆；
      普通尚未持久化输入不误入排队卡片，消费后正式用户消息及时出现。
- [ ] 覆盖首条输入已接收但 transcript 尚未创建、发送与停止竞争、结果不明、重连及
      Gateway 重启。保留草稿与原请求身份，先核对原生事实；不能盲目重发或自动执行中断输入。
- [ ] 主聊、侧聊、Goal、Plan、结构化待答和 Team/Swarm 模式各自保持发送门禁。
      附件、引用、网页上下文和功能标签的异步准备绑定原草稿身份；旧 ACK 不清空新草稿。
- [ ] Thinking/Tool 过程折叠、用户展开状态及 live→history 的接管保持稳定，关闭/重开
      过程详情不丢失有效内容。展开全文、复制、代码与 Read/Write/Apply Patch 展示复用
      同一原生参数/结果，不把任意 JSON 猜成业务卡片。
- [ ] 用真实流验证未闭合代码/公式/Mermaid、长工具输出、图片加载、音视频播放和本地
      HTML 链接。Markdown/错误/工具输出继续清洗，媒体与路径经受控打开通路。
- [ ] 验证向上阅读暂停跟随、历史窗口锚点、搜索定位、选择/引用、窄窗口、主题与
      独立工作区。不能让流更新强拉到底部、跳到其他消息或反复重建工具详情。
- [ ] 模型、时长和用量以实际原生 run/history 为准；fallback 后不继续显示发送前选择。
      最近请求的上下文占用与累计 Token 分开，过期/未知预算不显示为准确值。

实现与回归入口：`src/renderer/libs/openclaw-chat/{gateway,model,pipeline,components}/`
及 Cowork chat/composer；完整契约见[聊天渲染](../architecture/15-chat-rendering.md)。

## 4. 上下文压缩、预算与物理会话切换

- [ ] 分别验收用户手动压缩、模型/预算触发的自动压缩，以及溢出、超时等恢复压缩。
      对照开始、准备、进度、完成、失败、取消和跳过的原生生命周期及原因；不能只测
      普通成功路径或以普通聊天 final 判定压缩结束。
- [ ] 手动 `sessions.compact` 的 `operationId` 绑定一次提交，使用
      `sessions.compaction.status/abort` 核对与取消同一操作。覆盖排队、准备、运行、
      终态清理期间取消，以及取消早于迟到 admission。
- [ ] 请求超时、断线、会话级 `no-active-run` 不构成操作终态，不重发压缩、不解除
      发送隔离。Gateway 重启后的未知结果明确提示未确认，并验证迟到提交取消围栏。
- [ ] 验证自动压缩与活动模型 run、工具执行、停止、重连、Goal 续跑和跨会话转发并发。
      原生写入 claim、incarnation 与目标会话所有权不混用；不能关闭写入保护来消除错误。
- [ ] 比较压缩后的实际模型输入、工具 call/result 配对、system prompt、角色文件、
      工程规则与必要上下文保留。压缩摘要不能替代原始 transcript；不维护产品摘要库。
- [ ] 检查压缩标记、Token 指标、摘要详情与有界补取。缺少摘要仅按原生 entry ID 查询；
      `markerExpected:false` 的成功不伪造持久标记、不反复补查。失败/跳过不能显示为成功。
- [ ] 原生压缩若产生后继物理 sessionId，先用匹配 key/连接/历史世代的权威历史确认，
      再原子替换身份、分页与上下文占用。旧 sessionId 的流、补取及预算全部失效；
      活动 run 只有经后继 `hasActiveRun/activeRunIds` 证明仍归属它时才重绑。
- [ ] 核对 `totalTokens`、`contextTokens` 与 `contextBudgetStatus` 的实际口径和模型
      窗口有效性。当前占用分母优先用 `promptBudgetBeforeReserve`，不能以剩余预算或
      预估值冒充；后继缺少用量时隐藏旧占用，不根据占用减少推断压缩成功。
- [ ] 对照内网维护请求的 purpose/human initiation、模型端点与凭据。
      手动 `/compact` 附加要求若目标 RPC 仍不支持，应继续明确拒绝，不能静默丢弃。

入口：聊天 `chat-controller-compaction`、Main 的 `runtime/native-support/`、
当前版本压缩补丁与 `native-compaction-lifecycle` / controller compaction 测试。

## 5. 摘要视图、任务进度、输出与来源

下列内容名称相近，但数据源和生命周期不同，升级时必须分别验证：

| 展示                   | 权威来源                                                                  | 不能作为替代的证据                             |
| ---------------------- | ------------------------------------------------------------------------- | ---------------------------------------------- |
| 上下文压缩摘要         | 原生压缩记录及精确详情                                                    | UI 摘要面板、成功提示或自行整理的文本          |
| 聊天标题栏「摘要」     | 当前会话的 Goal、progress card、子会话与资源 metadata、Team/Workflow 关联 | 扫描工具参数、工作区文件或其他会话记录         |
| Thinking/Tool 过程摘要 | 当前 Renderer 的原生 timeline 投影                                        | 新建一份持久 transcript 或重写原生段顺序       |
| 团队/流程汇总与交付    | 对应批次、原生执行与交付回执                                              | 成员最后一条回复、ACK、Graph 已无 running 节点 |

- [ ] 摘要按当前会话展示 Goal objective、任务进度、子智能体、输出、来源、
      Swarm Workflow 与 Agent Team；无关会话和旧 generation 的数据不能出现。
      Goal、present_plan 和 progress card 不混用生命周期或入口。
- [ ] 对照 `progressCard.changed/get/refresh` 的能力声明、revision 与异步回执。
      null、读取失败或旧 revision 不沿用旧卡冒充最新；刷新不制造用户消息或清空草稿。
- [ ] 输出通过认证 `artifacts.list(sessionKey,messageRole:'assistant')` 与助手明确
      交付引用形成；工具 Write 参数、任意触及文件和用户附件不冒充助手交付。
      核对 artifact ID、附件身份、message seq、managed-media 伴生关联与截断补全。
- [ ] 来源使用当前已加载的用户附件/文件引用，以及成功且具有原生 externalContent
      归属的 `web_search/web_fetch` 结果；覆盖真实 `tool_call` 与 Code Mode 嵌套结果。
      不调用不存在的 `sources.list`，不采纳普通助手链接或任意 custom JSON。
- [ ] 输出与来源去重不跨消息猜路径；仅在去重身份中忽略网页 fragment，实际打开保留
      锚点。按需复用文件/图片/浏览器预览，不调用下载来制造副本，不在 metadata 复制 base64。
- [ ] 验证三条预览、「查看全部」资源 Tab、输出空态、失败保留已确认条目及重开重试。
      不可打开的内联文档、丢失文件和超大资源显示真实限制；切换会话后的旧读取不打开系统工具。
- [ ] Team 计数以真实协作批次/群聊房间、Workflow 以关联流程为准；子智能体用原生会话
      状态与累计用量。关闭详情 Tab 保留摘要入口，关闭可选插件则按契约隐藏其入口。
- [ ] 首次有意义内容只自动展开一次，不抢焦点或切换 Tab；手动关闭后轮询、新条目和
      切回会话不重新打开。主题、窄屏、键盘及独立窗口保持可用。

入口：Cowork `components/display/summary/SessionSummaryPanel`、资源列表/打开逻辑，
聊天 `chat-summary-resources`、`session-summary-resources`、`process-summary-takeover`
及对应测试；数据边界见[聊天渲染](../architecture/15-chat-rendering.md)。

## 6. 执行、审批、Goal、Plan 与助手

### 6.1 准入、结算与恢复

- [ ] 发送先准备并回读原生权限、sessionRoot/cwd、模型与身份，再委托一次原生提交。
      未知发送/启动保留 unknown，查询相同身份；不凭最新消息、run-ID 后缀或 prompt
      标记推断授权或执行结果。
- [ ] 只有匹配整轮的 lifecycle terminal 且 `executionSettled:true` 建立执行结论。
      required-child join、工具 scope 清理、插件 custody/cleanup 各自核对；停止 ACK、
      idle、owner 更换或某 attempt 结束不能替代结算。
- [ ] 完整应用重启与同一应用内 Gateway 重启分别验收。前者保留 app-start boundary
      对上一宿主遗留主会话的保护，后者按原生 durable recovery 核对；不恢复已删除的
      generic durable task registry 接线，也不连接后补发 abort 冒充恢复准入。
- [ ] 覆盖权限应用失败、模型不可用、首事件前取消、断线后迟到接收、后台会话停止、
      自动重连和退出期间的排队重启。旧 generation 的通知不能更新新运行或重启已退出应用。

### 6.2 权限、交互与目标模式

- [ ] ask/auto/full 正确映射 guarded/workspace/full；新会话默认与当前会话权限分开。
      活动 run 期间变更显示 pending，原生回读失败禁止发送，不用全局 full 兜底。
- [ ] structured question 与 automation approval 核对 request/run/session 身份、
      用户选择、超时、停止、重连和重复回答；运行参数的等待期限仍实际生效。
- [ ] Goal 创建、暂停、显式继续、等待用户、完成/失败与预算限制逐状态验收。
      goalId fence、停止 latch 和自动续跑门禁有效，普通继续不能暗中恢复 paused goal。
- [ ] Plan 生成、present_plan 读取、审批/拒绝/修改、批准后 reset 与实施交接验证同一
      canonical transcript。显示历史跨 reset 保留，模型上下文仍正确切断；计划审核
      不退化为任意文件编辑器，重启不重放已经批准的工具。
- [ ] 编辑、撤回、fork 绑定合法持久 entry，在 Goal、Plan reset、sending、压缩、
      历史未就绪和身份缺失时保持门禁；不能只在界面禁用而让后台路径绕过。

### 6.3 助手、原生 SubAgent 与用量

- [ ] 助手创建/保存/启停、独立模型、角色文件读写与冲突保护正常。
      角色目录固定 `stateDir/agent-workspaces/<agentId>`，工程 cwd 与项目 `AGENTS.md`
      仍按原生规则加载；切换助手创建新会话，不搬历史、不改项目规则。
- [ ] 助手软删除保留历史身份与角色文件，不调用会清除原生会话索引的 `agents.delete`。
      同名新助手获得新身份；配置同步、cron 归属与历史团队引用不被重新绑定。
- [ ] 当前子任务查询使用 `sessions.list/describe` 与 `sessions.changed`，不再使用
      已移除的 `tasks.*` 账本。历史发现分页读取原生会话并按返回的 `spawnedBy` 精确
      筛选，不能依赖已过期的运行控制索引；`parentSessionKey` 不代替取消授权。
- [ ] 子会话 queued/running/done/failed/interrupted/killed/timeout、嵌套导航、取消、
      完整快照替换及旧响应隔离正确；不恢复旧结果重投递/忽略按钮，不伪造当前接口
      不再暴露的 deliveryStatus、等待原因和 diffStat。
- [ ] 普通 SubAgent、原生 Swarm 分组、可选 Agent Team 与 Swarm Workflow 独立。
      不把长期助手 roster 自动加入跨角色 allowlist，不用原生 `agents team create`
      直接替代产品房间。累计 usage 与本轮上下文快照不能混用。

### 6.4 Code Mode 执行与会话中间结果

- [ ] 核对现有 Code Mode 开关及 QuickJS 执行器配置，实际验证 exec、wait/resume、
      失败与取消。缺失执行器不能降级为 Node VM；普通 JavaScript 变量、当轮
      `results.save` 引用与显式 `await store/load` 的生命周期分别验证。
- [ ] 验证已完成 cell 的 JSON 值可跨 cell、后续用户回合和 Gateway 重启恢复；
      会话之间隔离，失败或取消的未完成 cell 不提交缓冲写入。覆盖超限拒绝、覆盖与
      删除后读取；按目标版本核对单值/总量限制，不将历史旧值视为已物理擦除。
- [ ] 保存与恢复由原生会话的 `openclaw.code-mode-store` entries 负责，检查其不进入
      面向展示的聊天历史；Main/Redux 不复制中间结果，也不新增 VM 或等待快照缓存。
      使用精确整轮 `executionSettled:true` 终态核对，重启前确认关闭结果，不重发未知执行。

参考：[权限管理](../features/chat/openclaw-permission-management.md)、
[运行参数](../features/chat/agent-runtime-settings.md)、
[助手](../features/assistants/assistants-and-collaboration.md)、[执行引擎](../architecture/05-agent-engine.md)。

## 7. 工程、Worktree、共享终端与记忆

- [ ] 普通工程和原生 Worktree 都验证实际 cwd/sessionRoot、中文/空格路径、创建失败与
      不确定回执；审批、文件预览、Review 和工具执行使用真实检出根，不用源仓库代替。
- [ ] Worktree 的 `sessions.create(worktree:true)`、可见子会话接纳、继续已有身份、
      `worktrees.list/restore/remove/gc` 及引用保护正常。未知创建不再分配第二个 checkout；
      `worktreePreserved` 或未知删除不直接删目录/分支。当前 Worktree 会话仍限制复制/fork。
- [ ] 原生全局 worktreeRoot/acceleration 通过带 `baseHash` 的配置 patch 保存并回读，
      只影响新分配；配置同步不覆盖这些非产品副本字段，冲突/超时不自动重放写入。
- [ ] Review 以 `sessions.describe/diff` 和前后 incarnation 核对真实 checkout。
      原生基线、scope/commit 与路径校验正确；共享目录的修改不能宣称全部来自本 Agent，
      `.agent-tasks/` 只作展示分组，不从原生差异删除。
- [ ] 共享终端绑定已准备原生会话，由 Gateway 拥有 PTY/buffer。创建、shell/args/cwd、
      输出 offset、输入、取消/关闭及助手发现实际有效；断线只 attach 原 PTY，不 reopen
      或重放未知输入。关闭/隐藏 Tab 和终止执行的含义分开。
- [ ] 验证多终端、Windows 输入法、独立窗口与后台会话归属。不把 UI 选中终端推断为
      助手可识别的「当前终端」；terminal banner 变化仅作展示验收，不当作启动证据。
- [ ] 记忆浏览、搜索、索引诊断和用户触发重建对照原生 memory 能力、助手归属、
      embedding 端点/凭据及取消。索引状态使用原生 CLI，读取不触发重建；索引完整性
      与 embedding 实时健康分开。强制重建仅在用户触发后执行，退出码为零还需回读
      状态，不把关闭/仅关键词/未确认显示为无条件成功；不另建记忆库。

参考：[Worktree](../features/workspace/worktree.md)、
[共享终端/审阅 IPC](../architecture/03-process-model.md)、[执行引擎](../architecture/05-agent-engine.md)。

## 8. 定时任务、结果收件箱与系统任务

- [ ] 对照 cron schema、事件、job/run 查询和 mutation。at/every/cron、时区、
      夏令时边界、非法时间、启停、编辑、删除和手动运行都按原生行为验证；
      不在应用新增第二套调度时钟。
- [ ] agentTurn/systemEvent 的 payload、owner、隔离会话、工作区、权限、模型覆盖与
      delivery 正确。普通编辑保留表单未建模的原生字段及列表外模型；model 省略为保留，
      `null` 为清除。新建显式 `delivery:none`，不靠上游默认规避外发。
- [ ] 手动运行与真实定时触发分别检查原生 run/session 身份、模型请求和权限审批。
      接收 ACK 不显示完成，无人值守不自动 full；超时不重复提交第二次运行。
- [ ] 冷启动先订阅再读取，等待 Main 的 Gateway readiness；不以提前空成功列表掩盖
      冷启动，不在 Renderer 加与宿主冲突的独立初始化期限。退出先停止 polling。
- [ ] 首次同步持久 baseline，不把全部旧历史变成未读；增量同步跨多页追赶，
      watermark/catch-up 在中断和重启后继续。单 job 快速同步不冒充权威全量清单。
- [ ] receipt 以原生 task/run 身份去重，重复 upsert 保留 readAt；失败结果可读，
      未读计数、筛选、标记已读和详情跳转一致。正文仍按原生 session 读取，不复制历史。
- [ ] 运行中结果拒绝删除；删除/reconcile barrier、分步 artifact 清理、持久 tombstone
      与丢失响应后的幂等正常。部分清理失败保留可恢复记录，不能删除后又被同步复活。
- [ ] 「技能库自动整理」按原生 declarationKey/Agent 聚合，不按名称或 prompt 猜。
      UI 聚合 ID 不传 cron mutation；系统任务不开放普通删除，统一开关映射
      `skills.workshop.autonomous.mode`，未设置时应用显式 off，保留用户明确选择。
- [ ] 原生结果已清理、Gateway 离线、历史单页失败和助手软删除分别显示真实状态，
      不创建空 transcript 或用空列表认定全部任务已删。

入口：`src/main/scheduler/`、`src/main/ipc/scheduledTask/`、
`src/shared/scheduledTask/`、结果 Store 与 Renderer scheduled-tasks；
完整契约见[定时任务架构](../architecture/08-scheduled-tasks.md)。

## 9. 插件、技能、MCP、Hooks 与产品扩展

### 9.1 管理、安装与有效清单

- [ ] 在目标 SDK 下核对 manifest/schema、main/setup/provider-policy/provider-contract/
      capability catalog、tools/RPC/hooks/widget kind 注册及来源。安装目录存在不证明
      已加载；不能只 import index 来证明 CLI/Gateway 选择了正确入口。
- [ ] Extension 查询、启停、安装/更新、卸载分别验证运行态回读、reload/refresh 与
      必要重启。已提交但响应丢失先查 inventory，不重复破坏性 CLI 操作；
      文件锁失败保留真实原因，不以 stop/mutate/start 或强制重试绕过原生生命周期。
- [ ] 分开验证 `plugins.list` 的期望开关与实际 `runtime` 健康状态：注册/服务失败
      显示错误，`unloaded` 不推断失败；`needs-setup` 即使没有缺失环境变量也显示
      配置警告。清单成功后能清除旧错误，不为展示错误修改开关或管理权限。
- [ ] 测试本地目录/压缩包导入、能力审查与 reviewToken、换包/文件变化、取消和部分
      安装失败。未知格式拒绝，不把上游 bundle 识别能力当作产品已实现转换。
- [ ] 人工确认的能力令牌必须由最终原生 staging 再核验；审查后增加能力使旧令牌
      失效，不能用 CLI 无条件接受标志代替确认。安装等待覆盖依赖准备与运行时应用，
      普通 RPC 超时不证明安装未提交，不能自动改走另一条安装路径。
- [ ] 多入口包分别核对 manifest owner、原生子条目 ID、精确安装路径和市场身份。
      以原生 metadata/ownership 为准，不按 ID 前缀猜归属；CLI 最终回执匹配实际
      子条目，列表、配置、更新和卸载使用同一已核验目录。验证无预授权子条目的新安装，
      以及已提交失败回包中的 owner/代表条目对账，不能因包级扫描没有子 ID 误判已卸载。
- [ ] 原生明确已提交、后续应用失败时，保留 `installationCommitted`、可确认身份和
      安装路径，市场仍记录本次版本；市场安装响应不泄露内部路径、凭据或原始错误。
      未知结果不冒充提交，仍可能被原生读取的临时源不能被清理，不自动重复安装。
- [ ] 卸载覆盖明确未发送、已发送后超时/断线、原生拒绝与目录部分删除；只有明确
      未发送才允许离线 CLI 恢复。结果不明先核对权威清单和本次包路径，不能重放卸载。
      安装时才启动 Gateway 的场景也要检查网络策略、原生重启要求和实际运行态收敛。
- [ ] Windows 普通目录、junction、坏链接、恢复副本、worker/CLI 清理与真实原生
      卸载验证不跟随链接误删宿主 runtime；不放宽原生 hardlink/文件引用校验。
- [ ] Skill 有效赢家以 `skills.status/update` 为准；测试同名来源、eligible 与 enabled
      的区别、导入/删除、启停确认、文件 watcher 与迟到响应。关闭赢家不自动改用下一份。
      041 发现刷新补丁已退役，不因短暂发现延迟恢复补丁或强制重启。
- [ ] 验证 `skills_search/skills_read` 按需发现已安装技能：即使提示词目录因预算省略，
      仍可搜索并读取完整说明；覆盖元数据/有界正文搜索、完整读取超出搜索前缀的正文、
      禁用及禁止模型调用的技能过滤。用与产品导入相同的 `stateDir/skills` 位置验证。
- [ ] 撤销读取权限后仅保留元数据搜索，正文搜索与完整读取不能绕过权限；Code Mode
      的 `skills.search/skills.read` 使用同一原生目录和权限。读取技能不授予执行权限，
      Main 不建立第二份技能索引；工具可用性与真实模型会否主动选用分别记录。
- [ ] MCP 用户配置与 Extension 提供项分开，扩展连接参数只读，独立启停服从原生
      归属与管理权限；关闭的连接仍可显式测试，测试不修改保存配置或启用状态。
      真实验证连接、工具/资源/提示发现、资源读取、
      调用、取消、timeout 与进程退出；Windows npm/npx、嵌套包 bin、中文/空格路径
      和 Chrome MCP 均要握手，不能把某条批处理诊断直接判为连接失败。
- [ ] Hook 文件、开关、数据库与配置事务一致，拒绝不支持的链接和半成品发布；
      父扩展变更刷新附带 Hook/MCP，不只翻转旧卡布尔值。
- [ ] 市场默认无业务 provider 时显示未配置；只支持已接入的 extension/skill/mcp。
      核对安装来源/版本、更新对账与受保护同名项，不凭空恢复公网 catalog 或厂商默认目录。
- [ ] 分别验证市场更新、本地重新导入和父扩展更新，更新保留用户明确停用状态；
      无市场映射的本地/系统同名项不能获得市场更新权限。按实际交付能力记录不适用项：
      当前 Hook 无独立市场更新入口，Skill/Hook 无独立执行测试按钮，不能以模拟按钮代替验收。
- [ ] 清单读取失败保留最近确认状态与错误，迟到查询不覆盖新操作。配置同步尊重显式
      optional disable，受管适配器遵循所属设置；通用插件入口的保护同时由 Main 强制。

### 9.2 每种扩展的独立验收

| 扩展/能力                                 | 升级必须验证的行为                                                                                                                                                         |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Runtime Services                          | required 保护、原生受限读取/授权、执行结算/cleanup、禁用可选插件后的回执对账与清理；不得依赖可选插件或复制 transcript                                                      |
| ask-user-question / automation-permission | 问题/审批注册、等待/超时/取消、身份与重连恢复；非交互维护请求不能伪装为人类发起                                                                                            |
| plan-mode                                 | 原生 extension state、计划工具、审批 artifact、reset 与 handoff、重启待审恢复；显示历史与执行上下文分别验证                                                                |
| agent-team                                | 协作 Graph、seal/whole-run 结算、独立验收、群公开镜像与内部历史、来源汇总、定向 @/引用、holding FIFO、unknown 队头、发起守卫、设置冲突及禁用后 custody；不删除借用来源会话 |
| swarm-workflow                            | 原生 owned-run 准入、DAG/revision、任务信封、人工介入、暂停/停止、批次分页、产物 hash、独立验收、精确结果投递；预算区分排队/执行，旧执行和工具清理未确认时不重试           |
| embedded-browser                          | 唯一 browser 工具、真实 guest/目标/权限桥、文件边界与取消；模式切换不产生两个提供方                                                                                        |
| widget-kit / 原生 Widget              | kind/resource 注册、真实 `show_widget` 准入、认证 `canvas.document.view`、CSP/origin/source/generation、嵌套核心工具身份及去重；建议先确认加入草稿，再由用户发送           |
| stt-local-cli                             | 显式开关、模型路径/依赖、录音与附件转录、取消/释放、离线可用性；关闭麦克风入口不误关闭独立附件转录                                                                         |
| tts-local-cli                             | 原生 `tts` 工具与本地 speech provider 注册、独立模型选择、缺失模型撤下 provider、试听/朗读及取消释放；语音页选择不覆盖扩展设置，下载文件共享 |
| typesafe / 决策模型                       | 原生 `decision_evaluate` provider、schema、模型/凭据配置、条件托管及失败行为；不绕过会话权限                                                                               |
| acpx / 外部 Agent                         | setup 预编译、目录发现、连接/session/replay/cancel 与外部 MCP；保持外部执行器边界，不能假定拥有本地 managed-run 的结算/清理保证                                            |
| 原生 Workboard                            | boards/cards CRUD、expectedUpdatedAt 冲突、ready 派发、start/stop 与真实 session/run、事件后刷新、可选关闭；四栏 UI 不冒充另一套调度器                                     |
| OpenAI / QuickJS 等受管适配器             | 通用插件入口禁止绕过所属设置启停/删除；QuickJS worker/WASM、Code Mode exec/wait/取消实际可用，缺失执行器不得自动降级到 Node VM                                             |

- [ ] 可选插件逐个覆盖关闭、开启、运行中关闭、快速关闭再开启、Gateway/应用重启、
      历史读取和删除。关闭隐藏工具/导航/功能标签，保留约定历史；旧草稿选择与在途
      发起失效，但正文、附件和引用不丢失。
- [ ] Agent Team、Swarm Workflow、Workboard 与原生 collector 分别记录结果。
      插件 accepted/ACK、某节点完成、Graph 不再 running 或可选插件关闭，都不能推断
      整个执行及工具已结算。
- [ ] Widgets 在当前 HTTP(S) viewer 的实际发送连接公告能力，Main 后台保持 headless。
      假 shortcode/JSON、失败工具结果或同名 MCP 不授予读取；切换/重连撤销旧端口，
      文档丢失/加载失败按手动重试和草稿建议恢复，不保存组件 HTML 副本。

### 9.3 插件页面的状态刷新与跨页恢复

- [ ] 安装、更新、卸载和启停完成后重读权威清单，再核对市场身份、版本、分组与权限；
      Main 向窗口发布实际观察到的状态，保存成功但应用失败也触发对账，不能只翻转旧卡片。
- [ ] 父扩展变更同时刷新附带 Skill/MCP/Hook，已打开的扩展详情更新或关闭；
      Skill 移除后同 ID 恢复不自动重开旧详情。列表读取失败保留已确认内容和错误。
- [ ] MCP 保存、删除、启停及市场更新前后使旧测试结果和在途测试代次失效；
      覆盖操作期间新发起的测试、资源读取和迟到结果，不将旧连接成功挂到新配置。
- [ ] 配置保存/失败反馈绑定详情代次；保存期间移除条目、打开另一详情或同 ID 重入后，
      迟到回包不能清空新草稿、串写成功/错误提示，也不能重开已关闭详情。
- [ ] 市场已提交但后续失败时保留错误和状态刷新入口，同版本不重复安装；
      在“可更新”筛选下仍可看到待处理反馈。页内切换、离页再返回、多窗口及交错读取
      不释放在途安装锁、不覆盖较新清单，不依靠重复安装修复刷新失败。

参考：[插件系统](../architecture/07-plugin-system.md)、[Plugin Hub](../features/plugins/plugin-hub-experience.md)、
[市场适配](../architecture/16-skill-marketplace-adapter.md)、
[Agent Team](../features/assistants/agent-team.md)、[Workflow](../features/workflow/swarm-workflow.md)、
[批次](../features/workflow/swarm-workflow-batches.md)、[Workboard](../features/workflow/workboard.md)、
[交互式回答](../features/chat/interactive-answers.md)。

## 10. 浏览器模式、Chrome 扩展与人工介入

- [ ] isolated/user/extension/embedded 四种模式分别检查原生配置、工具发现与实际
      操作；缺失/未知旧值的读取默认与非法写入校验分开。切换失败回滚，不偷偷切到
      外部 Chrome 补缺能力。当前内置浏览器仍是真实 Electron webview guest，不能
      把候选 WebContentsView 迁移写成已交付浏览器架构。
- [ ] user 模式实际通过 `browser.request`、existing-session driver 与随包 Chrome MCP
      触发 Chrome 授权；端口可达不等于授权成功。完整/最小/认证配置同步都保留
      正确 launcher、现有自定义 profile/default profile 与用户配置。
- [ ] 对照目标版本浏览器扩展 pristine relay 源码、checksum、manifest/background/
      options 与 bootstrap seam，再组合 conversation-overlay。不从 build 混合产物
      反向覆盖源码，不因 release notes 未提及就认定基线无变化。
- [ ] 从桌面实际入口验证手动配对与自动发现/配对、Tab Access、Disconnect、worker
      重启、watchdog 重试和迟到响应撤销。CLI 根入口及完整依赖真实可运行；Gateway
      bundle 能启动不证明 CLI pairing 可用。配对凭据不进入桌面 Renderer 或日志。
- [ ] relay 自动化与 Native Messaging/app-server 侧栏聊天分别验收。扩展 ID/Origin、
      capability、loopback 发现、初始化、会话列表/历史、流、附件、权限/模型和 stop
      正常；不把 Gateway token/relay key 暴露给 Side Panel，断线不自动重发消息。
- [ ] 扩展侧栏同步验证 Thinking/Tool/Content 折叠、pending 输入、乐观去重、历史
      全量/增量身份和无 transcript 空页；桌面成功不能替代扩展客户端回归。
- [ ] 网页上下文仅在用户明确授权后采集，作为本轮 private untrusted context，不能
      当用户指令或持久用户正文；切会话/页面后不使用过时上下文或误发旧附件。
- [ ] 内置 guest 逐动作检查 task/profile/target/webContents、lease、文档和 frame。
      导航后旧 ref/授权失效；后台创建 Tab 不抢当前工作区，容量拒绝不留下外层虚假 Tab。
- [ ] 浏览器代理与非浏览器/Gateway 代理分别检查 system/direct/custom、认证挑战、
      新旧 partition、生效和 Cookie/profile 隔离。browserProxy 变化不重启 Gateway，
      浏览器网页不进入模型 outbound-header 注入通路。
- [ ] 上传、下载、PDF、剪贴板、摄像头/麦克风、定位/通知、HTTP auth 与证书错误
      保留来源确认、路径和取消边界；Agent 文件只使用真实工作区，下载拒绝覆盖并清理
      部分文件。本地与在线 PDF 统一验收 Chromium 原生查看器，检查内部流导航的精确放行及 PDF 工具栏打印。
- [ ] 「停止任务并人工操作」先核实在途动作收敛，unknown 保留页面保护；明确继续
      重新观察当前页，不复用旧元素、不重放未知表单提交。录制/标注只进入原会话草稿，
      用户审阅发送，录制不与 Agent 自动输入竞争。
- [ ] 网页历史、favicon、最近访问、导入、密码存储、下载记录及数据清理分别验收；
      旧异步请求不在清理后复活记录，清除记录不误删下载文件或其他 profile 数据。

参考：[浏览器设置](../features/browser/browser-settings-design.md)、
[扩展侧聊](../features/browser/browser-extension-side-chat.md)、[app-server 协议](../app-server-api/README.md)、
[人工介入](../features/browser/browser-intervention.md)、[操作录制](../features/browser/browser-operation-recording.md)。

## 11. 设置项、配置投影与认证切换

以 `src/renderer/features/settings/settingsCatalog.ts` 为页面清单，检查每个当前页面；
另检查插件专属表单及定时任务设置。新增上游配置不自动等于已支持的产品选项。

| 页面/设置         | 需要覆盖的内容与实际效果                                                                                                                        |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| 通用              | 语言、自启动、防休眠、应用更新频率、非浏览器代理；保存、系统效果及代理生效范围正确                                                              |
| 外观              | 主题/明暗与预览取消，主窗口、聊天 Shadow DOM、工作区/Widget/浏览器相关界面一致；HTTP 随机端口不丢偏好                                           |
| 快捷键            | 编辑/冲突/恢复默认、发送方式与工具提示，实际文档焦点、中文输入法和独立窗口有效，不重复注册                                                      |
| 语音              | 麦克风/输出设备、在线与本地输入/朗读、附件转录、模型下载与取消、释放、显式插件关闭                                                              |
| 宠物              | 选择、显示和浮动位置持久化，侧栏拆出/收回仍保留主窗口归属与拖动范围                                                                             |
| 模型              | 语言/决策/图像/视频/ASR/TTS 目录、发现、默认与会话/助手 override、保存/导入导出、多能力 endpoint/SecretRef 隔离                                 |
| 助手              | 档案、角色文件、独立模型、主助手切换开关、编辑冲突与历史保留                                                                                    |
| 执行设置          | Agent thinking/timeout/并发、Goal、问答/审批期限、侧栏容量、Code Mode、MCP timeout、SubAgent model/visibility/depth/容量、原生 Swarm 开关与容量 |
| 沙箱与隔离        | 执行方式、权限映射、Windows MXC 执行器 probe 与真实隔离准入、失败诊断；设置不能静默扩大宿主权限                                                 |
| Worktree          | 勾选入口偏好、原生列表/restore/remove/gc、全局目录/加速、引用保护和 config hash 冲突                                                            |
| 浏览器            | 四种模式、配对、独立代理、搜索、历史、下载及链接打开偏好；对应工具与真实 guest 行为一致                                                         |
| 电脑操控          | 显式启用、模型/本机准入、computer RPC/tool、dedup/heartbeat/release 和悬浮提示；展示关闭不冒充执行停止                                          |
| 连接与集成        | MCP/外部 Agent/ACP/Multica 目录与配置、会话恢复、取消及协议子集；连接发现不自动取得执行授权                                                     |
| 消息通道          | 已接入 IM/channel 的配置、凭据、状态与权限；不因上游新增 channel 自动开放未适配能力                                                             |
| 用量与存储        | 原生/服务端用量口径、加载失败、会话冷归档/存储状态及受保护清理；不是累计 transcript 缓存                                                        |
| 关于与帮助        | 应用与运行时版本、更新/诊断入口、错误反馈；显示最终产物的真实版本，不取旧 vendor 文本                                                           |
| 插件/任务专属设置 | Agent Team 全局/本团队覆盖、Swarm Workflow 批次预算与并发、cron/system-task 开关及 Extension 凭据；全局与局部所有者分开                         |

- [ ] 对每项设置执行「修改 → 保存 → 持久化回读 → 实际使用 → 应用重启回读」；
      涉及 Gateway 的受管项还须核对原生配置与新任务实际效果。
      预览/取消/恢复默认、未保存离开、保存失败/冲突和在途操作均保留原草稿及明确状态。
      即时保存与页底统一保存的既有语义不被改成仅本地成功。
- [ ] null、0、缺字段、空字符串和显式 false 按各字段含义处理，不依据新上游默认
      重置旧用户选择。重点验证 timeout=0、thinking/model 继承、visibility、可选插件
      disable 与 `skills.workshop.autonomous.mode`。
- [ ] 完整配置、无模型最小配置、正常保存、登录、Token 轮换与退出同步分别验证。
      保留非受管权限、原生 `meta.migrations`、env、Worktree 设置与用户可选开关；
      受管 OpenAI/QuickJS/浏览器/TypeSafe 等按各自契约投影，不删除其他 deny/allowlist。
- [ ] 配置 mutation 串行，区分变更检测、应用完成与受控重启；schema 校验、热应用
      失败和保存冲突不可用最小配置静默掩盖。不可确认写入不自动重放。
- [ ] builtin 模型发现/mtoken→JWT/SecretRef、轮换/过期/退出与用户 provider 独立；
      未解析 SecretRef 拒绝，敏感字段不进入 Renderer 清单或日志。登录 SDK 与内置
      模型换证仍使用统一 MAC 获取契约，无 UUID/device-ID 回退。
- [ ] 通用 Extension 凭据只接受当前 manifest 声明字段/env，分别检查替代变量组、
      系统环境来源、保存应用和冲突；不向空 schema 写虚构 apiKey。
- [ ] UI 使用匹配的 zh/en 文案，设置搜索/导航仍执行离开保护。持久 UI 偏好经
      `rendererPreferences`/Main KV 在 App/Redux imports 前 hydrate，不依赖随机 HTTP origin。
- [ ] 品牌从 `productMetadata`/构建 metadata 读取，兼容标识保持稳定；新内部字段、
      KV/IPC/plugin state/source symbol 使用领域名称，不从产品名派生。

参考：[模型管理](../features/models/model-management.md)、[语音](../features/models/local-tts.md)、
[决策模型](../features/models/jev-integration.md)、[登录](../features/integrations/login-sdk-template.md)、
[模型认证](../features/integrations/authentication-builtin-model-lifecycle.md)、
[出站请求头](../features/integrations/outbound-headers.md)、[CLI / ACP / app-server](../features/integrations/agent-cli.md)。

## 12. 左侧导航、会话列表与右侧工作区

### 12.1 左侧功能栏与会话导航

- [ ] 主页/聊天列表、搜索、新聊天、定时任务、插件、更多、账号和设置入口始终可达；
      收起列表或切页不隐藏固定功能栏。Workboard/记忆固定顺序持久，插件暂不可用只隐藏，
      重新可用恢复偏好；developer WebChat 遵循开发者开关。
- [ ] 会话创建/重命名/置顶/分组/删除与活动状态更新正常。Chrome 与 Multica 来源组
      按真实创建来源投影，不凭标题/正文猜归属，扩展继续桌面会话不改原来源。
- [ ] 跨会话 `sessions.search` 命中携带原生 entry 与物理身份；等待历史就绪后定位，
      冷归档、分页、身份变化和迟到查询不滚动到其他对话。
- [ ] 未读结果、任务状态、连接错误及插件启停通过既有 owner 更新；侧栏隐藏不终止
      后台原生任务，用户导航不触发新的执行或后台消息发送。

### 12.2 工作区 Tab、文件与独立窗口

- [ ] 首页/会话侧栏空态、新标签页、工具替换、单例复用、最近访问、打开顺序、
      容量/后台保留、关闭最后一页、溢出列表与键盘焦点正常；关闭 Tab 不改变底层
      不相关任务。创建 guest 失败不插入虚假页签。
- [ ] 文件树、选择页签、预览/编辑、路径面包屑、刷新/折叠、未保存关闭保护、
      Review/终端/侧聊/子智能体/Team/Workflow/资源列表分别保持原会话归属。
      导航 generation 淘汰旧读取，隐藏面板不丢当前合法草稿或错误状态。
- [ ] 临时 `/btw` 侧聊保持独立内存 timeline，不写主 transcript；主聊引用、团队
      引用、录制材料和 Widget 建议只在确认后进入相应草稿，不自动发送。
- [ ] 工作区拆出/收回移动同一文档与工具实例，不重开 PTY、guest、Monaco、Lit 或
      Graph，不丢附件/群聊 @/表单。子文档无应用 preload，窗口 IPC/guest host 绑定
      当前 generation，异常销毁撤销旧授权。
- [ ] 主窗口最小化后独立工作区仍更新流、布局、菜单和终端；主题、OwnerDocument、
      ResizeObserver、调度、DPI、剪贴板和焦点使用真实展示文档。主窗口托盘/恢复、
      顶层审批引导、屏幕变化与退出清理分别验证。

参考：[侧栏首页](../features/workspace/sidebar-home.md)、
[独立工作区](../features/workspace/detached-workspace.md)、[聊天渲染](../architecture/15-chat-rendering.md)。

## 13. 本地 OpenAI 完整源码替换

`plugins/extensions/openai` 以原生 OpenAI 的 v2026.10.7 源码为起点，包含
MIT LICENSE。`upstream-source.json` 记录原始 tag、commit 和源文件 SHA-256；
它描述上游基线，不要求已修改的本地文件等于原始 hash。测试辅助源码不发布。
本地依赖使用独立 `package-lock.json`，不引用上游 `workspace:*` 开发依赖。

资源同步以本地目录**完整替换**原生 `dist/extensions/openai`，不合并文件，
不保留旧 `native-index.mjs`/`native-capability-catalog.mjs`。裁剪清单将上游
`openai` 列入 `local-source-replacements`；本地插件保护只保留替换后的目录。
最终只有一个 `openai` 插件 ID。`openclaw.runtimeBundled` 表示只能在构建时组装，
开发期库存与启动源码复制排除该源目录，由已编译运行时 manifest 判定可用性。
源版本、基线版本或 runtime 版本不一致时资源同步必须失败，要求重新审查。

升级方法：取得目标 tag 的原生 OpenAI，使用旧基线/新上游/本地三个版本比较；
将原生协议修复带入本地，逐条重新实施并验证下面的差异，再更新来源记录与锁文件。
不要直接覆盖本地 `index.ts`、manifest 和 setup entry；这样会重新开放官网登录，
丢失视频注册或隔离配置。保留的上游辅助源码不等于开放其中的官网功能。

| 本地约定            | 必须比较和验证的文件/行为                                                                                                                                                                                                                                                                                  |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 无官网账号引导      | `provider-contract-api.ts`、`setup-api.ts`、`openclaw.plugin.json` 的 auth、wizard、CLI flags、credential import、usage/env 声明。注册与 setup 均无浏览器登录、device code、SIWC 或官网 API Key 向导。                                                                                                     |
| 显式内网模型        | `openai-provider.ts`、`provider-policy-api.ts`、`model-auth-policy.ts`、`shared.ts`。保留原生 stream/replay/tool 语义；模型与地址由设置提供，无官网 catalog/自动发现/默认地址。检查模型级 API/baseUrl 优先于 provider 配置，未知模型不能被厂商 preset 重写。                                               |
| 图像隔离            | `image-generation-provider.ts`、`intranet-config.ts`、`contracts/media-config.ts`。只使用 `models.providers.justdo-image-openai` 的地址/凭据；不借聊天 openai 或环境 Key。覆盖 generations、multipart edits、响应上限、私网显式允许和拒绝越界。                                                            |
| TTS                 | `speech-provider.ts`、`tts.ts`。显式地址、模型、音色、响应格式与能力专属凭据；无环境 Key/公网地址回退。覆盖内网任意模型/音色、额外参数、匿名服务、响应上限和释放。                                                                                                                                         |
| 实时 STT            | `realtime-transcription-provider-factory.ts`。接受 HTTP(S) 与直接 WS(S) baseUrl，派生 `/realtime?intent=transcription` 时保留直接 WebSocket 协议，transport 与 header policy 使用同一地址。覆盖四种协议、并发端点、按 committed 链顺序输出、重连重置、最后 commit、溢出关闭；不借官网 profile 或环境 Key。 |
| 文件 STT            | `audio-transcription.ts`、`media-understanding-provider.ts`。原生 multipart `/audio/transcriptions`、模型、文件名/MIME、响应与释放；使用配置域凭据，显式账号 profile 在上传前拒绝；配置缺失在上传前拒绝，上传开始后的失败不能改服务重试。                                                                  |
| Embedding           | `embedding-provider.ts`、`memory-embedding-adapter.ts`、`embedding-batch.ts`。显式 remote/provider 地址、原生凭据/目标绑定、模型前缀、cache identity、批次与总超时，不恢复官网默认地址。                                                                                                                   |
| 视频合并            | `video-provider.ts` 注册仍叫 `video-openai` 的 provider，但所属插件是 `openai`。保留 `models.providers.video-openai`、模型 primary 和凭据域；单独关闭视频不得关闭 chat/image/TTS/STT。检查异步 Videos 提交/轮询/下载，未知提交不重试。                                                                     |
| 官网 Realtime Voice | 原生 ChatGPT/Quicksilver/官网 RTC 源码不注册为能力。它与现有 TTS、实时 STT 和文件 STT 是不同入口；未经明确内网协议实现与验收，不能恢复注册。                                                                                                                                                               |

API Key/SecretRef 仍可用于用户显式选择的内网服务；删除的是官网认证流程，
不是内网鉴权。未解析 SecretRef 必须拒绝，不能转为字符串或泄露到日志。
插件不导入应用 `src`；纯配置 ID 由插件 `contracts/` 拥有，应用 shared 只做门面。

- [ ] 在本机测试服务验证图像 generations/edits、TTS、实时/文件 STT、embedding、
      视频的请求地址、协议、不同凭据、冷发现与注册一致性，再在实际内网服务验证聊天、
      图像、录音、文件转录、朗读与视频，记录实际输出及失败/取消。fixture 通过不代表
      真实服务支持全部原生参数。
- [ ] 视频设置、配置保存和导入仍仅支持 `video-openai`（所属插件 `openai`）；不恢复
      Kie、Z.AI、Novita 选项、固定厂商目录或已退役的自定义视频配置迁移。

## 14. 运行时补丁与宿主接缝复核

逐项读取[当前版本总账](../../scripts/patches/v2026.10.7/README.md)和 transformer，
升级后将链接更新为目标版本总账。下表按集成风险组织验证，不替代逐补丁删除条件。

| 接缝（当前编号）                                  | 目标版本必须验证的重点                                                                                                                                                           |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 环境/提示/请求（001/002/003/004/014）             | 真实 pip 安装后 import；最终 system prompt transform 不改用户/历史/工具参数；人类发起 metadata 经 queue 到执行正确归属；维护 purpose 与本轮 private untrusted input 隔离         |
| 会话/恢复/显示（005/006/007/008/011/012/015/018） | app-start 主会话恢复边界、paused Goal 显式继续、provider-safe replay、授权媒体、reset 显示历史、原子 fork 冲突、admin cwd 与 Windows canonical/SQLite 路径和身份                 |
| 离线插件（009/010）                               | 断网 catalog 与配置同步不偷偷安装/下载缺失插件，显式安装仍走原生流程；新 inventory/capture 生命周期不破坏保护                                                                    |
| 沙盒/凭据/定时任务（013/016/017）                 | MXC external skills 只读物化及越界拒绝，cron 权限/工作区持久映射，Windows servicing launcher 的身份、ACL、凭据与清理                                                             |
| owned execution（019）                            | native-support 注入与精确 bytes、SDK run timeout、registry actor/owner/incarnation、whole-run settlement、custody 与 managed-tool cleanup/recovery，不把 wait timeout 当执行超时 |
| 共享终端（020/021）                               | native PTY launch/close、cwd/shell/args、viewer ownership、buffer/offset 与 attach；欢迎文字只影响展示，删除候选需单独说明用户影响                                               |
| 压缩/转发（022/原生）                             | operation-scoped 状态/取消覆盖准备与清理，自动恢复压缩生命周期；恢复调用者授权后仅退出源 transcript/CLI-history 写入 scope，目标保持自己的写入 claim                             |
| 电脑提示/Windows 恢复（023/024）                  | 内容无关的 activity start/end/heartbeat/release 与真实操作分别验收；原生 recovery capture 保留获准目录 junction，不改文件链接、hardlink、相对/坏链接或授权                       |
| SQLite 退休/历史发布（025/027；原 027 已原生覆盖） | 非阻塞 checkpoint 保留 stop/join；Windows canonical readiness 由原生物理键核对；deferred read 未就绪前不得发布成功或失败响应 |
| 流式交接（026/028/032） | attempt 级 finalize admission、消息 scope 与真实完成关联、长参数无正文进度及有界恢复；详见[流式专题](streaming-and-execution.md) |
| 格式恢复/Goal（029/031） | 同一原生循环的两请求纠正上限与精确整轮结算；Goal 前驱、回交 owner 和累计次数原子准入，未知发送不重放 |
| 手动 Apps（030） | 手动准备与后续模型运行使用同一持久会话工作区，准备过程身份变化拒绝，下一轮不退役仍被使用的资源 |
| Windows 插件发布（033） | 同一事务、stage 与精确字节的有界 rename 恢复；禁止重放安装，详见[宿主专题](host-and-release.md) |

- [ ] 以下均指 9.8 旧编号：删除的 002/003 由 Main MCP/Chrome 启动器及配置投影承载，
      真实连接回归仍必需；020/021 由完整本地 OpenAI 源码替换承载，027 由构建时共享 SDK 模块承载。
- [ ] 9.8 旧编号 033 私有 loop-exit 诊断、035 私有 prompt-budget 接线、041 发现刷新与
      历史拟议的 043 替代安装接线不恢复。Workflow 结果预算用公开 `model_call_started` 的有效预算及
      精确 run/trace/attempt span；缺观察保守回退，不能采用旧 attempt 的大额度。
- [ ] 核对单独锁定的 MXC package、二进制 hash 与 product build patch，probe 实际
      selected executor 和真实隔离进程，不以无关 broker readiness 判定准入。
- [ ] 补丁核验覆盖发布包全部相关 native copies、worker、recovery monolith 和最终
      bundle；不能只匹配一个源码文件或只检查补丁标记存在。019/022 普通 native-support
      与原生接线一同校验，不移动到可被关闭的插件。

## 15. 重建、构建产物与自动化回归

### 15.1 串行重建与产物检查

- [ ] 关闭使用开发 runtime 的应用，从目标 pristine 包强制重建目标平台。
      runtime 目录替换、freeze 校验与使用其产物的测试必须串行，不能并行读写旧目录。
      例如 Windows x64：

  ```powershell
  $env:OPENCLAW_FORCE_INSTALL = '1'
  try {
    npm run openclaw:runtime:win-x64
  } finally {
    Remove-Item Env:OPENCLAW_FORCE_INSTALL -ErrorAction SilentlyContinue
  }
  ```

- [ ] 检查 source lock、目标补丁 inventory、copied support bytes、共享 SDK owner、
      plugin assembly、precompile/prune、runtime manifest/build recipe 与 freeze。
      原包 `dist/build-info.json` 已同步为 Gateway bundle 根目录的 build-info companion，
      CLI 根入口及依赖完整，不靠运行时临时转译或补回单个缺文件恢复产物。
- [ ] 本地替换预编译覆盖 main、setup、provider-policy/provider-contract、manifest
      capability catalog 及 `openclaw.build.workerEntries`；当前 OpenAI 两个 worker、
      相对 URL、`.js` exports、SDK aliases、第三方依赖、LICENSE/NOTICE 实际可加载。
      上游已编译插件的 build 字段可能指向未发布 TS，不误套本地源码重编译要求。
- [ ] CLI `plugins list --json` 与实际 Gateway inventory 只有一个已加载 openai，
      source 指向运行时外层 `dist/extensions/openai/index.js`，providerIds 含 openai 和
      video-openai，无旧 native-* 或独立 video-openai 目录。普通应用 build 或重启
      旧 Gateway 不能证明运行时更新。
- [ ] 验证目标平台的 Node/Electron/native ABI、MinGit/Python/MXC/QuickJS、worker、
      WASM、法律文件、ASAR 内外路径与最终安装资源；中文/空格安装目录和首次启动可用。
- [ ] 安装版验证只读 loopback Renderer hosting、immutable asset 校验、CSP、导航
      guards、Widget/工作区 HTTP origin 和无继承 preload。开发 Vite 成功不能替代安装包。

### 15.2 自动化检查入口

实际升级完成 runtime 重建/freeze 后执行项目检查，命令和参数以 `package.json` 为准。
按顺序执行，每一步确认成功后再继续，避免前序失败被后续成功掩盖：

```powershell
npm run openclaw:patches:verify
npm run lint
npm run build
npm run compile:electron
npm test
git diff --check
```

`npm test` 先使用 Node better-sqlite3，再恢复 Electron ABI；必要时按脚本说明执行
`npm run rebuild:electron-native`。

| 范围                 | 当前可复用的测试入口                                                                                                                                                                                                   |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 来源替换/预编译/裁剪 | `tests/scripts/{native-extension-replacement,precompile-openclaw-extensions,sync-openclaw-runtime-resources,prune-openclaw-runtime}.test.ts`                                                                           |
| SDK 与本地 OpenAI    | `tests/openclaw/runtime/shared-sdk-modules.test.ts`、`tests/openclaw/plugins/{openai-native-composition,openai-intranet-config}.test.ts`                                                                               |
| 流/历史/过程         | chat `agent-event-reducer*`、`history-reconciler`、`chat-history-protocol`、`chunked-message-history`、`process-summary-takeover`、`browser-extension-stream` 与 components streaming tests                            |
| 压缩/摘要            | chat `chat-controller.compaction*`、`chat-summary-resources`、`session-summary-resources`、`SessionSummaryPanel` / 资源列表 / `openSummaryResource`，当前补丁 `native-compaction-lifecycle`                            |
| 配置/执行/身份       | Main adapter、wire validator、permissions、Goal/Plan、config sync/logout、worktree/sandbox 领域测试及当前版本补丁测试                                                                                                  |
| 技能发现/Code Mode   | `node scripts/test/verify-native-skill-state-runtime.mjs <runtime-directory>` 验证真实隔离 Gateway 的技能发现、读取权限与 JSON 跨轮/重启保存；`node scripts/test/verify-code-mode-runtime.mjs <runtime-directory>` 验证 QuickJS 资产及执行/等待/取消；开发 Node/随包 Node 分别运行 |
| SQLite 关闭/恢复     | 先按目标版本适配 `scripts/openclaw/probe-sqlite-retirement.mjs`、`tests/openclaw/runtime/sqlite-retirement-lifecycle.native-smoke.mjs`；覆盖备份、回滚拒绝与成功、删除排他、退出租约及重启恢复；开发 Node/随包 Node 分别验证 |
| 启动/历史升级       | `src/main/startup/routing/startupCoordinator.test.ts`、`src/main/startup/history/` 的 `historyRecovery`、`nativeHistoryRuntime`、`nativeHistoryFailure` 等测试；覆盖三类启动、备份完整性、导入身份和阶段恢复 |
| 定时任务             | scheduler `cronJobService`、`scheduledTaskResultSyncService`、`scheduledTaskSessionHistory`、结果 Store/IPC/UI，`tests/openclaw/runtime/scheduled-task-permissions.test.ts`                                            |
| 插件页生命周期      | `src/main/plugins/`、`src/main/ipc/plugins/`、`src/renderer/features/plugins/` 的安装、更新、卸载、归属、部分提交、状态刷新与迟到回包测试                                                                                      |
| Team/Workflow        | `tests/openclaw/extensions/`、Renderer composer 及当前 plugin recovery/owned-run/cleanup 测试                                                                                                                          |
| 浏览器/工作区/设置   | browser bridge/extension assembly、Main app-server、Renderer browser/settings/display；`tests/openclaw/runtime/windows-mcp-launch.test.ts` 与 `scripts/test/workspace-window-probe.cjs`                                |

按目标契约更新有意义的行为断言，不能为了通过只改版本快照或删除失败用例。
所有接受 runtime 目录的探针必须显式传入本次构建的最终产物目录（按项目约定位于
`build/runtimes/`），核对其版本、manifest 与 freeze 身份；不依赖脚本中的历史默认路径。
旧版本目录测试保留为历史回归，不可作为目标版本通过证据；缺失关键场景时补齐。
技能/Code Mode 探针使用隔离状态与本机合成模型；分阶段续验应分别保留前序失败与
续验结果，不冒充一次全量通过。此类验证不证明真实模型会主动选择技能、正确编排
Code Mode 或通过 MXC 实机准入；本版专项证据见[升级记录](../openclaw-upgrades/v2026.10.7/README.md)。

插件还需按目标版本适配并运行 `tests/openclaw/runtime/` 下的实际原生验证：
`plugin-management.native-smoke.mjs`（安装/更新/启停/卸载）、
`plugin-capability-consent.native-smoke.mjs`（staging 能力令牌）、
`plugin-package-ownership.native-smoke.mjs`（多入口包、清单与市场身份）及
`extension-mcp.native-smoke.mjs`（扩展连接发现与测试）。使用独立配置、端口和凭据，
不触碰用户运行中的 Gateway；原生 fixture 通过仍不能替代下节真实界面与企业服务验收。

## 16. 真实应用验收与完成标准

自动化检查后，按目标平台在真实应用中记录以下组合场景。安装版必须有独立记录；
fixture、合成输入和本机测试服务不替代真实模型、设备或企业页面验收。

| 场景             | 最低验收证据                                                                                              |
| ---------------- | --------------------------------------------------------------------------------------------------------- |
| 多段消息与恢复   | 真实模型产生 Thinking/正文/工具交错和失败继续；运行中断连/重连、刷新/切会话后内容和身份正确，无重复/串流  |
| 压缩与继续       | 手动/自动/恢复压缩，准备阶段取消及断线核对；压缩后继续调用工具、刷新历史与上下文占用正确                  |
| 进度/资源/摘要   | progress card 更新、文件/图片/网页交付、嵌套 web 来源、查看全部与预览；空态/失败和切会话不误显示          |
| 权限/目标/计划   | 三种权限、审批/问题、Goal 暂停/继续、Plan 批准 reset；停止及两类重启无未知操作重放                        |
| 子会话/团队/流程 | 原生 SubAgent、Agent Team 两种模式、Workflow/批次分别执行与停止；精确结算/cleanup、unknown 和禁用恢复有效 |
| cron 收件箱      | 一次手动与一次真实定时触发，结果详情/未读/readAt，多页追赶及删除后重启不复活                              |
| 插件生命周期     | Skill/MCP/Hook/Extension 按支持范围实际安装/更新/启停/测试/卸载；父扩展联动、详情/市场状态刷新、部分提交、受管保护、Windows junction 与离线行为正常；真实在线热变更和企业市场另记 |
| 浏览器与扩展     | 四模式、真实 Chrome 授权/配对、侧栏聊天与 relay 分别检查；内置页面人工介入、文件/PDF/下载正确             |
| 设置与认证       | 保存后实际新任务使用，取消/冲突/完整/最小/登录退出投影；chat/image/STT/TTS/video 不串凭据                 |
| 工程与桌面       | 普通工程/Worktree、Review、共享终端 attach、左右侧栏、工作区分离/最小化/托盘及安装版资源正确              |
| 启动与历史升级   | 新装、当前 SQLite 覆盖安装、已发布 JSONL 升级分别验证；无缓存断公网冷启动，备份/隔离/初始化/导入/映射/最终检查各阶段退出重启，历史与附件可读且能续聊 |

长任务相关升级应执行真实超过一小时的任务，验证排队不计执行预算、跨 yield/fallback
计时、停止后工具清理、重启后精确核对及安全人工重试。物理双屏、不同 DPI、系统
中文输入法、原生剪贴板、麦克风/系统音频按平台另记，不能以合成事件宣称通过。

诊断先查看 `%APPDATA%/<productName>/logs/main-YYYY-MM-DD.log` 与
`%APPDATA%/<productName>/openclaw/logs/gateway.log`，必要时对照 `[gateway] log file:`
指向的完整原生 JSON 日志及认证原生事件。简化日志缺行、控制台没有输出或 UI 已空闲
均不构成结算证据。会话诊断只用已有连接及受限历史/日志接口，不为诊断启动 Gateway，
不直接读取 transcript 文件；提交记录仅保存脱敏证据。见
[开发排障](../development.md)与[会话诊断](../features/chat/session-diagnostics.md)。

升级记录至少包含：

- 旧/新版本、应用提交、源包 identity、本地 OpenAI 基线、平台与最终产物身份。
- 各领域「通过 / 需适配 / 未验证 / 不适用」及原因、执行过的命令/场景、证据位置。
- 补丁/插件/SDK 的保留或删除决策、对应用户影响与已更新的调用方/文档。
- 未验证的服务/平台、已有验收限制、新增回归和阻塞项；不能以其他领域通过抵消。

只有来源/产物核验、必要自动化检查和受影响的关键应用链路通过，才可声明相应范围
升级完成；关键链路仍未验证时不能标记完成，其他未验证范围和限制应明确记录。
同步更新本文、目标补丁 README、相关架构/功能文档和
`docs/openclaw-upgrades/<version>/` 的验证记录；保留有价值的设计说明，将待验收
工作留在 plans，不承诺未执行的验收。
