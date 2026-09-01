# OpenClaw v2026.7.1-2 补丁能力总账

本目录只接受未经修改的 npm 产物 `openclaw@2026.7.1-2`。`v2026.6.11`
目录仅作为历史资料；这里没有复制旧 anchor/replacement，没有 V2/V3/V13
升级分支，也不兼容旧补丁、部分补丁或来源未知的 bundle。

补丁安装以锁定 npm tarball 为唯一输入：需要更新 runtime 或补丁集合时，流程会重新
解包、构建并从 pristine 产物应用完整 patch pass，绝不在上一次已打补丁的 runtime
上做增量升级。因此补丁代码不得包含旧 marker、旧 replacement 或旧补丁状态的迁移/
兼容分支；缓存只允许复用 manifest 与全部输入指纹完全一致的冻结快照，任何不一致都
必须触发重新构建或直接失败。

锁定产物：

- npm integrity：`sha512-ycF3yPcbjN6bUPeaUx6Mh6vze1hQWoD3CT/wWcmD7a8xaHHHRUaAlaq+lFxMHf1ssEgODVAwjlzYqp2twkYZ7g==`
- tarball SHA-256：`5bb525f36f471a41239615d321c441778c7e1c007018ed6d84b795be77803276`
- Node：`24.15.0`，支持范围 `>=24.15.0 <25`

## 审计与实现规则

1. `verify-openclaw-pristine-contracts.cjs` 必须在 npm 解包后、任何写入前运行。
   它既验证已删除能力的上游控制流，也要求下面每个保留补丁的
   `verifyPatch` 在原始产物上失败。
2. 每个补丁只描述一个可独立删除的能力，文件头必须在前 16 行写明
   `Capability`、`Target`、`Scope`、`Safety`、`Remove when`。
3. 每个目标文件和 anchor 必须唯一。多文件补丁先完成全部内存变换和验证，
   再统一写入；整个 patch pass 失败时恢复所有 JS 文件。完整 patch pass 复用原子
   快照建立的文件/内容索引，并增量更新查询结果；补丁必须通过 `_patch-utils.js`
   的 `writeIfChanged` 写入，禁止绕过索引直接修改 runtime JavaScript。
4. 首次应用必须成功，第二次应用不得改变任何字节；source pass 和 bundle
   pass 分别验证，不能用一个总 marker 代替多个子修改。
5. manifest format 2 绑定 source lock、目标平台、补丁顺序与哈希、patch helper、
   build recipe、package lock、asar/package/companion 文件及最终 bundle 哈希。
   已安装的开发 runtime 是冻结快照，只有 `OPENCLAW_FORCE_INSTALL=1` 才从原始
   npm 包重建并重新 patch；严格校验仍会拒绝把与当前输入不匹配的旧 runtime 打包，
   不允许 patch 自己尝试迁移这个旧 runtime。

## 保留能力清单

“原始版本”均指锁定的 pristine npm 产物。这里的“当前保留原因”不是说补丁永远
不能删除，而是说明在当前产品契约下直接删除会失去什么。删除补丁必须同时满足对应
“可删除条件”，并用原始目标包行为测试证明上游或 App 已经承担该能力。

每个补丁还必须通过 `openclawPristineContracts.test.ts` 的原始缺口断言、首次应用、
二次字节稳定、source/bundle verify 和 anchor 歧义失败测试。文件名使用连续三位
编号；loader 按文件名字典序执行，因此编号也是实际应用顺序，不沿用旧版本 patch ID，
也不为已删除能力保留空位。

### 关系总览

Thinking 的三个阶段彼此互补，不是重复实现：

```text
003 将 <think> 转成 reasoning delta ─┐
002 解除实时 reasoning 事件 callback gate ─┴─> 当前 turn 的实时 Thinking
004 history projection ───────────────────> 刷新、重连后的 Thinking/tool 历史
```

Subagent 的创建、同 run join 和原生 fallback 是两条不同链路。下图箭头表示
运行阶段和结果去向；只有正文明确写出“依赖”的地方才是补丁代码依赖：

```mermaid
flowchart LR
  Spawn[sessions_spawn] --> Admission[013 原子容量准入]
  Admission --> Lifecycle[014 pending → running]
  Lifecycle --> Classify[017 managed ancestry]
  Classify --> Join[018 same-run join]
  Join --> Commit[019 两阶段提交]
  Commit --> Recovery[020 restart/failure recovery]
  Recovery --> Fence[021 delivery ownership/announce fence]
  Fence --> ImplicitJoin[041 durable implicit join]
  ImplicitJoin --> TerminalGuard[042 required-child terminal guard]
  TerminalGuard --> CompletionFollowup[043 completion-run follow-up join]
  CompletionFollowup --> TerminalHandoff[044 unfinished explicit wait handoff]
  Recovery --> Identity[036 managed Gateway identity pin]
  Recovery -->|未消费结果恢复原生投递| Queue[016 requester FIFO]
  Queue --> Promote[015 delivery commit 后提升 canonical branch]
```

其中 `015` 必须先于 `016` 应用，因为 `016` 在 `015` 建立的 post-delivery wrapper
上增加 FIFO 和终态确认；运行时则是 `016` 先确认投递成功，随后才允许 `015`
推进会话 leaf。managed join 成功时不走 `015`/`016`，但 join 失败或恢复时仍需要
这条原生 fallback。

其他显式关系：

- 审批：`022` 管生命周期；`023` 管 run suspension，并向 `024`/`025` 提供可信
  ancestry helper；`024` 管 allow/deny 后恢复，`025` 管 stop 和 transport failure。
- 请求元数据：`026` 在 spawn 时持久化直接父 UUID，`027` 消费它；`028` 独立处理
  compaction/reviewer purpose。
- Compaction：`029` 管原始用户消息的结构化保存与 replay；`030` 管 continuation
  wording；`031` 管模型压缩失败后的本地 handoff。`030` 与 `029` 没有隐含顺序，
  `031` 只读取 `029` 的公开 details 字段，并兼容字段缺失的 legacy transcript；`039`
  复用 `028` 的压缩流边界，为 direct recovery 补可见 lifecycle、等待心跳和摘要增量；
  `040` 防止本地 precheck 文案覆盖真实的压缩终态错误。
- Subagent 终止判定：`041`–`044` 在 `018`–`021` 的 durable join/ownership 状态机之上，
  把模型的 terminal reply（包括 `NO_REPLY`）视为候选；仍有 required child 时先等待
  一批结果并续跑父会话。completion announce 唤醒的父 run 只排除当前正在投递的 source
  child，仍会 join 本轮新派发或其他未完成 child；显式 fire-and-forget、abort、timeout 和
  非 managed session 不变。
- Embedding 网络：JustDo 只给 memory search/index CLI 注入受管代理环境；`047` 让
  OpenClaw 的 generic OpenAI-compatible embedding guarded fetch 显式使用该环境。`048` 只在
  JustDo 的手动重建入口显式要求重新计算向量，避免旧 embedding cache 使整次重建没有网络请求。
  URL 是否注入业务 Header 仍由本地 OutboundHeader policy 决定，runtime patch 不读取用户 Header。
- Gateway 工具调用：`049` 只把认证后的运维侧 `subagents list` 状态查询排除出 agent tool-loop
  accounting；其他 `tools.invoke` 工具/动作和 Agent run 内模型调用仍使用原生循环检测，
  `before_tool_call` hook、授权、交互审批和实际执行不变。

### 001–004：环境、Thinking 与历史

#### `001-managed-pip-config-environment.cjs`

- **做什么**：让 child tool 收到 JustDo 实际指定的 `PIP_CONFIG_FILE` 和
  `PYTHONUSERBASE`，既使用 App 管理的 pip index、证书或代理配置，也把用户新装的包
  持久化到 `<userData>/runtimes/python-user`。
- **关系与边界**：App 侧分别通过 `JUSTDO_MANAGED_PIP_CONFIG_FILE` 和
  `JUSTDO_MANAGED_PYTHON_USER_BASE` 提供值 provenance；本补丁不依赖其他 runtime
  patch，也不从 OpenClaw deny-list 中全局放开这两个变量。
- **当前保留原因**：原始版本会无条件过滤 `PIP_CONFIG_FILE` 和 `PYTHONUSERBASE`；后者
  被过滤时，pip 会退回 `%APPDATA%/Python`，与 `JUSTDO_PYTHON_USER_SITE` 指向的导入路径
  不一致。普通值、override、大小写伪造或 provenance 不匹配仍必须被拦截，这是安全
  补丁而不是通用环境变量放行。
- **可删除条件**：OpenClaw 原生提供 value-bound、来源可信的 managed Python 环境机制，
  并继续阻止任意宿主 `PIP_CONFIG_FILE` 或 `PYTHONUSERBASE` 注入。

#### `002-live-thinking-stream.cjs`

- **做什么**：模型产生 reasoning 时，即使运行路径没有安装可选 callback，也继续向
  Gateway/JustDo 发布实时 Thinking 流；同时让 direct Gateway agent（包括 completion
  announce）继承 session/agent 已配置的 `reasoningLevel`。
- **关系与边界**：`003` 负责产生某类 reasoning delta，`002` 负责让实时事件不被
  callback eligibility 错误拦截；`004` 负责历史重放。`002` 不改变模型 thinking effort，
  只沿用既有 session/agent reasoning preference；原生 mode/thinking gate 和 callback
  调用保护均保留。
- **当前保留原因**：JustDo 使用的事件路径可能没有该可选 callback；此外目标版 direct
  agent-command 只传 `thinkLevel`，没有把 `reasoningLevel` 交给 embedded runner，导致
  announce 在部分 provider 上只能等最终快照或完全没有 Thinking。
- **可删除条件**：上游 direct agent 原生解析并传递 `reasoningLevel`，且 reasoning 事件
  发布不再依赖 callback，并通过无 callback 的 announce 流式行为测试。

#### `003-openai-think-tag-reasoning.cjs`

- **做什么**：把 OpenAI-compatible `content` 中已解析出的 `<think>...</think>` 分支
  转成 reasoning delta，同时保持普通 answer 内容不变。
- **关系与边界**：它是 reasoning 的“生成/转换”层；`002` 是实时事件资格层，`004`
  是历史显示层。三者没有可互相替代的功能。
- **当前保留原因**：目标版两条 transport 都能识别 thinking 分支，却在输出阶段丢弃；
  使用 think-tag 的模型因此只有答案、没有 Thinking。
- **可删除条件**：两条受影响 transport 都原生保留 thinking 分支并发出 reasoning delta。

#### `004-history-display-projection.cjs`

- **做什么**：在 `sessions.history`/历史刷新中保留 reasoning、redacted-thinking，
  以及同时包含文本、tool call、tool result 的 assistant block。
- **关系与边界**：`002`/`003` 解决当前 turn 的实时流，`004` 解决刷新和重连后的投影；
  它复用上游清洗、block 分类及 `text/input_text/output_text` 判断，不改变原始 transcript。
- **当前保留原因**：数据可能仍在 transcript 中，但原始 history projection 会过滤掉这些
  block，所以刷新或重连后看起来像“Thinking/tool 历史丢失”，审计上下文也不完整。
- **可删除条件**：上游 history API 对全部支持的 assistant block 做无损且安全的显示投影。

### 005–012：调度、MCP、工具与会话接口

#### `005-default-cron-delivery-none.cjs`

- **做什么**：没有显式 `delivery` 的 detached cron agent/command job 默认使用 `none`，
  不自动尝试向外部 channel announce。
- **关系与边界**：只改 omitted value；用户显式设置 `announce` 或其他 delivery 时完全走
  上游。它与 subagent completion delivery 无关。
- **当前保留原因**：JustDo 的 scheduled task 结果由 App 内部流程处理；上游默认
  `announce` 会产生无目标投递、错误提示或意外外发语义。
- **可删除条件**：上游对 targetless detached cron 原生默认 `none`，或 JustDo 明确改用
  上游 announce 产品语义。

#### `006-windows-mcp-package-runner.cjs`

- **做什么**：在 Windows 上把精确匹配的 npm/npx MCP package runner 转成
  `Electron + ELECTRON_RUN_AS_NODE + npm-cli.js/npx-cli.js` 启动；同时在 OpenClaw
  完成 MCP 环境过滤后，仅为该受管 runner 重新注入 App 生成的 child-process preload，
  隐藏 npm 随后创建的 `cmd.exe /c <package-bin>` 控制台窗口。
- **关系与边界**：处理通用 MCP stdio package runner；`007` 处理 Chrome MCP 自己的
  启动代码和早期 stderr。App 侧生成的 Electron Node/npm/npx shim 嵌入已解析的可执行
  路径，不依赖会被 MCP 子进程环境过滤掉的 `JUSTDO_*` 变量；非 Windows、非 npm/npx
  命令保持原生。
- **当前保留原因**：Electron 内直接 spawn Windows npm/npx command shim 不可靠，
  会造成 MCP server 无法启动；并且 OpenClaw 会按安全策略移除 `NODE_OPTIONS`，导致
  npm/npx 的下一层 package bin 启动失去 `windowsHide`，出现命令行窗口。这属于 Windows
  运行兼容性。
- **可删除条件**：OpenClaw 原生使用 Electron-safe 的 Windows package runner，且 npm
  与 npx 参数均正确。

#### `007-chrome-mcp-launch-diagnostics.cjs`

- **做什么**：修正 Chrome MCP 的 Windows npm/npx CLI 启动，并在连接握手前就开始
  drain stderr，让早期退出原因可见。
- **关系与边界**：与 `006` 覆盖不同代码路径；`008` 是连接成功后的页面恢复。只有
  platform、runner、npm bin 和 Electron path 全部可信匹配时才切换启动器。
- **当前保留原因**：原始版本在握手成功后才读取 stderr；最需要诊断的启动/握手失败
  反而没有有效错误，同时 Windows shim 仍可能启动失败。
- **可删除条件**：上游同时提供正确的 Electron-safe Chrome MCP runner 和连接前 stderr
  捕获；若产品移除 Chrome MCP 集成，也可连同 `008` 删除。

#### `008-chrome-mcp-empty-page-recovery.cjs`

- **做什么**：Chrome MCP `list_pages` 返回空数组时，最多创建一个 `about:blank` 页面
  并重试一次。
- **关系与边界**：`007` 负责进程启动，`008` 只处理已连接 browser session 的空页面
  状态；非空结果和错误继续走上游。
- **当前保留原因**：空 session 在原始版本中会一直保持无页面，使后续页面工具无法工作。
  这是浏览器可用性补丁，不是核心 agent 状态补丁。
- **可删除条件**：上游原生恢复空 browser session，或 JustDo 不再提供 Chrome MCP。

#### `009-selective-tool-schema-catalog.cjs`

- **做什么**：把 `browser`、goal、cron、memory、`skill_workshop` 等明确列出的重型
  schema 放入 Tool Search catalog，按需再 hydrate，而不是全部塞进每次初始 prompt。
- **关系与边界**：只改变 schema 暴露时机；工具授权、参数验证、调用和实现仍由上游
  负责，与 `011` goal RPC 或其他具体工具行为无依赖。
- **当前保留原因**：上游没有 per-tool defer 配置；删除会恢复大 schema 常驻上下文，
  增加 token 占用并挤压实际会话内容。这是上下文效率能力，不是执行正确性修复。
- **可删除条件**：上游支持等价 per-tool catalog/defer 配置，或确认当前模型上下文预算
  不再需要这项优化并同步调整产品策略。

#### `010-final-system-prompt-replacements.cjs`

- **做什么**：读取 JustDo 管理的 replacement 规则，在 prompt hooks、模型身份和
  model-aware additions 完成后、provider dispatch 前，变换最终 system prompt。
- **关系与边界**：独立于 compaction template；只处理 system prompt 的最终边界，不覆盖
  hook 结果，也不绕过 cache observation。
- **当前保留原因**：更早替换会被后续 hook/addition 覆盖，更晚已经进入 provider；目标版
  没有等价 final-system-only hook，删除会使 App 配置的 replacement 不生效或只部分生效。
- **可删除条件**：上游提供时序等价、可配置且 cache-safe 的最终 system prompt hook。

#### `011-silent-session-goal-clear.cjs`

- **做什么**：增加 authenticated `sessions.goal.clear` Gateway RPC，只清除持久化 goal
  字段，不生成聊天消息或启动 agent turn。
- **关系与边界**：`009` 可能延迟 goal tool schema，但不实现这个 RPC；两者独立。App/UI
  调用 `011` 完成纯状态操作。
- **当前保留原因**：原始 Gateway 没有无消息清理入口；删除后只能伪造用户消息或直接改
  store，都会破坏聊天语义或越过 Gateway 权限边界。
- **可删除条件**：上游提供等价 authenticated RPC，或产品彻底移除 silent goal clear。

#### `012-subagent-task-title-projection.cjs`

- **做什么**：把上游已经持久化的 `taskName` 作为只读 `taskTitle` 投影到
  `sessions.list`。
- **关系与边界**：不新增存储、不修改 spawn；`014` 负责 pending/running 状态，`012`
  只负责标题，两者可独立删除。
- **当前保留原因**：删除不会丢失底层 `taskName`，但刷新/重连后的 session list 无法展示
  可读任务标题。这是 UI 可观测性契约，不是运行正确性硬依赖。
- **可删除条件**：上游 list API 原生暴露 `taskName/taskTitle`，或 UI 不再展示 subagent 标题。

### 013–021：Subagent admission、投递与 managed join

#### `013-atomic-sessions-spawn-admission.cjs`

- **做什么**：native `sessions_spawn` 在同步 preflight 通过后、第一次异步初始化前，按
  canonical requester 预留一个 child 容量；成功或失败后都释放预留。
- **关系与边界**：发生在 `014` lifecycle 和 `017`–`021` managed join 之前。它只影响
  `runtime=subagent`；ACP Agent 保持原始并发和准入行为，不共享该 reservation。
- **当前保留原因**：原始版本先检查 active count，再跨越异步 session 写入，最后才注册。
  两个并发 spawn 可同时通过检查并突破 `maxChildrenPerAgent`；后续 managed join 无法补救
  已超额创建的 child。
- **可删除条件**：上游将 initializing child 纳入同 requester 的原子 check→registration，
  或提供等价 admission primitive；不能仅靠串行测试判断已修复。

#### `014-subagent-pending-lifecycle.cjs`

- **做什么**：spawn accepted/queued 后先显示 `pending`，只在真实 lifecycle start 时切换
  `running` 并开始运行时长/timeout 计时。
- **关系与边界**：`013` 控制能否创建，`014` 描述创建后的排队状态；managed join 使用同一
  durable registry，但不替代 pending/running 投影。
- **当前保留原因**：原始版本在 accepted 时就标成 running，用户看到的状态错误，而且排队
  时间会消耗真正的 run timeout，可能尚未启动就超时。
- **可删除条件**：上游持久化并投影 accepted/queued/running 三态，且 timeout 从真实启动
  时刻开始。

#### `015-completion-branch-promotion.cjs`

- **做什么**：required `subagent_announce` 的外层 agent delivery 已经 durable committed 后，
  在 requester transcript write lock 内把 completion side branch 提升为 canonical leaf。
- **关系与边界**：应用顺序上是 `015 → 016`；`016` 使用其 delivery wrapper 做 FIFO/终态
  确认。managed join 成功不走这里，`020` 恢复的 fallback/native completion 才走
  `016 → 015`。普通 announce、accepted-only 和失败投递绝不提升。
- **当前保留原因**：上游会把 prompt lock 释放期间到达的外部 completion 安全地写入 side
  branch，却没有在交付成功后推进 canonical leaf。删除后结果可能已经显示、也存在于
  JSONL，但后续模型沿旧 branch 构建上下文而“忘记”已交付的 child 结果。
- **可删除条件**：上游提供并调用 post-durable-delivery branch commit；或者产品取消所有
  native/fallback completion 路径。仅有 managed join 成功路径不足以删除它。

#### `016-completion-delivery-queue.cjs`

- **做什么**：required completion 对同一 requester 按 durable sequence FIFO 投递；不同
  requester 仍可并行。failed head 留在队首，busy requester 等待，pending agent call 必须
  等到 terminal 才算完成，并支持 restart 后重调度。恢复时只重试仍在上游 30 分钟硬期限
  内的 completion；超过期限的持久化项直接走原生 discard/cleanup，不再启动 completion
  agent 或 provider 请求。`sessions_yield`/managed join generation 明确位于该期限判断之前，
  不会被这个 fallback 清理规则误删。
- **关系与边界**：构建时要求 `015` 已建立 promotion contract；运行时向 `015` 提供可信的
  committed delivery 结果。managed join 成功绕过它，`020` 的未消费 fallback 和所有
  非 managed completion 使用它。
- **当前保留原因**：原始 announce 可以并发乱序、steer 正忙的 requester，并把 pending/
  accepted 过早当成成功；删除会使 sibling 结果次序不稳定，失败的早期结果还可能被后来
  结果越过。若恢复阶段不加硬期限围栏，旧失败项还会在每次 Gateway 启动时重新发起 LLM
  请求，制造与当前会话无关的报错。它不是旧 `008` 的 transcript 文本启发式去重。
- **可删除条件**：上游提供 restart-safe、per-requester durable FIFO，包含 failed-head、busy
  wait、terminal confirmation、managed-yield fence 和 hard-expiry pre-dispatch discard；若删除
  `015`，也必须先重构本补丁的明确依赖。

#### `017-managed-session-classification.cjs`

- **做什么**：沿持久化 `spawnedBy` ancestry 判定会话树是否精确根于
  `agent:*:justdo:*`，并对缺父、cycle、超过 32 层、cron 和冲突 fail closed。
- **关系与边界**：本身只提供分类器，不改变 `sessions_yield`；`018` 是它的直接消费者。
  `032` 使用等价持久化 ancestry 规则，但因运行位置不同不复用该 registry helper。
- **当前保留原因**：没有可信 classifier 就无法只给 JustDo managed tree 开启 same-run join；
  用 session key 子串判断会漏掉 nested child，也可能误把 native/cron 会话纳入新语义。
- **可删除条件**：上游提供 durable root-ancestry classifier，或完整删除 `018`–`021`
  managed join 能力。

#### `018-managed-same-run-join.cjs`

- **做什么**：JustDo managed 父会话调用 `sessions_yield` 时不结束当前 turn，而是在原 tool
  call 中等待并增量返回 child 结果批次，持久化 `waiting/presented` 状态。若已准入的 run
  在等待期间从 registry 意外消失，立即恢复其余 child 的原生 completion delivery 并返回
  可见 Tool Error，不进入无期限空轮询。合法 steer/restart 会把 waiting ownership 原子转移到
  新 generation，Join 按 child session 继续等待；失败恢复同时按当前 run ID 与稳定的 child
  session key 限定当前 yield 批次，因此即使 abort 早于下一轮 reconciliation 也能恢复 successor，
  不回滚之前已提交的增量结果，并显式报告 delivery 是否恢复成功。
- **关系与边界**：依赖 `017` 的 classifier；`019` 接管结果提交，`020` 接管失败恢复，
  `021` 接管 delivery ownership/announce race，`036` 固定恢复路径的 Gateway identity。
  非 JustDo、cron 和 native channel 保持上游 push
  announce 行为。
- **当前保留原因**：这是 managed subagent join 的核心产品能力。原生 `sessions_yield`
  会结束/暂停父 turn，child 结果只能通过另一个 completion turn 推送，无法在当前 tool call
  中按批次继续。
- **可删除条件**：上游 `sessions_yield` 原生支持持久化 same-call join，或产品明确回退到
  全部 push announce 模式。

#### `019-managed-join-commits.cjs`

- **做什么**：分别记录“匹配 tool result 已写入 transcript”和“随后 assistant continuation
  已 durable commit”两个阶段；只有第二阶段完成后才能 consume child 和执行 cleanup。
- **关系与边界**：依赖 `018` 的 waiting/presented 状态，同时覆盖 Pi transcript 和 Codex
  transcript mirror；`020` 根据这些阶段恢复，`021` 保留 delivery ownership。
- **当前保留原因**：只用一个 delivered marker 无法区分两个 crash window。过早 cleanup 会
  丢结果，过晚或重复恢复会重复展示 child 结果。
- **可删除条件**：上游提供持久化 presentation/continuation 两阶段 commit 和 cleanup fence，
  或删除整个 managed join 链。

#### `020-managed-join-recovery.cjs`

- **做什么**：处理 parent abort、continuation failure、Gateway restart 和未消费 join；未消费
  结果恢复原生 completion delivery，已经 consume 的结果只恢复尚未完成的 delete cleanup。
- **关系与边界**：依赖 `018`/`019` 的 durable 状态；fallback 交给 `016` 排队，成功后由
  `015` promotion；`021` 在 join ownership 存在时阻止竞态 announce。
- **当前保留原因**：没有恢复层，崩溃窗口可能永久卡在 waiting/presented、丢失 child 结果，
  或在 restart 后重复 cleanup/重复投递。same-run join 只有 happy path 不能发布。
- **可删除条件**：上游能从每个 managed join 阶段恢复或安全 fallback，并覆盖 abort、restart、
  未消费和已消费 cleanup。

#### `021-managed-join-identity-delivery.cjs`

- **做什么**：在 join 状态中保存 immutable Gateway session identity evidence，保留 delivery
  ownership，并在原生 announce 真正发送前再次检查 join 状态，阻断在途竞态重复投递。
- **关系与边界**：建立在 `017`–`020` 状态机上；join 失败时不永久吞掉结果，而由 `020`
  恢复一条原生 push。它是替代旧 `008` 启发式去重的精确状态围栏。
- **当前保留原因**：仅在 join 开始时取消 announce 不足以阻止已经在途的发送；delivery state
  清理也可能抹掉 join ownership。删除会重新引入 managed result 与 native announce 同时出现
  的竞态，同时丢失 join 状态中固定的 Gateway identity evidence。
- **可删除条件**：上游 same-run join 原生保存稳定 identity、保持 delivery ownership，并在
  最终发送点提供原子 announce fence。

### 022–025：交互审批生命周期

#### `022-persistent-interactive-approval-lifetime.cjs`

- **做什么**：对可信 JustDo ancestry 的交互审批不创建 expiry/timer，使审批可以一直等待
  用户决定。
- **关系与边界**：是审批栈的 lifetime 层；`023`–`025` 处理等待期间和决议后的 run 行为。
  explicit `null`、cron 和其他 native channel 保留上游 timeout 语义。
- **当前保留原因**：原始 manager 给所有请求固定超时；桌面用户离开一段时间后再回来，
  审批已自动失效，不能满足持久交互审批产品契约。
- **可删除条件**：上游支持 session/channel-aware infinite lifetime，或产品决定接受固定审批
  超时并同步移除后续暂停/恢复语义。

#### `023-approval-run-suspension.cjs`

- **做什么**：审批等待期间暂停对应 JustDo run 的 tool result/assistant 输出，并只忽略精确的
  自动 `chat run timed out`；用户 stop 和其他显式 abort 仍生效。
- **关系与边界**：与 `022` 共同形成“审批和 run 都不自动过期”；还提供可信 ancestry helper
  给 `024`/`025`。它不改变 cron/native channel。
- **当前保留原因**：只让 approval record 永不过期仍不够；provider/run timeout 会撤销 waiter，
  assistant 还可能越过审批继续落盘，产生“审批仍在但任务已结束/继续执行”的分裂状态。
- **可删除条件**：上游提供 durable、run-scoped approval suspension，并保证等待期间不提交
  对应输出。

#### `024-approval-resolution-resume.cjs`

- **做什么**：JustDo webchat 收到真实 allow/deny 后，用隐藏 follow-up agent turn 恢复工作，
  synthetic resume prompt 不写入用户可见历史。
- **关系与边界**：代码上依赖 `023` 的可信 ancestry helper 和上游 prompt-persistence guard；
  非 JustDo 或非 webchat channel 继续使用原生 inline resolution。
- **当前保留原因**：原生 webchat inline 流程不能可靠恢复已经异步暂停的 turn；直接 follow-up
  又会把内部控制提示伪装成用户消息，污染 transcript 和后续上下文。
- **可删除条件**：上游能对 webchat 做隐藏、持久且可恢复的 approval continuation。

#### `025-approval-stop-and-failure.cjs`

- **做什么**：接受 typed `deny-justdo-stop`，使用户 stop 立即成为 terminal silent denial，
  不落入工具执行，也不生成额外回复；同时避免 transport/node failure 被伪造成用户 denial
  完成消息。
- **关系与边界**：exec 路径使用 `023` 的可信 ancestry；普通 deny、native channel 和真实用户
  决议保持上游语义。
- **当前保留原因**：原始 validator 拒绝 stop decision，某些 waiter 可能继续走 timeout/default
  分支；transport failure 还会制造错误的“审批已拒绝/完成”消息，既有安全风险也不真实。
- **可删除条件**：上游有 typed silent-stop、保证 stop 不执行工具，并对 transport failure 保持
  truthful unresolved/failed 状态。

### 026–028：请求与父会话元数据

#### `026-parent-session-identity.cjs`

- **做什么**：在 child spawn admission 时快照直接父会话当前 Gateway UUID generation，并在
  两次 child session commit 中持久化 `parentSessionId`。
- **关系与边界**：`027` 消费该字段发送 `parent_session_id`。本补丁不修改任何现有 parent/
  child `sessionId`，也不把 ancestry root 当直接父。
- **当前保留原因**：仅保存 `spawnedBy` key 后再实时查询，若父会话在 child 首次 provider 请求
  前 reset/轮换，就会得到新的 UUID，导致 LiteLLM lineage 关联到错误 generation。
- **可删除条件**：上游在 spawn 时原生持久化稳定的直接父 UUID，并在 restart/parent reset 后
  保持不变。

#### `027-agent-request-metadata.cjs`

- **做什么**：对 `builtin_models` LiteLLM OpenAI Chat Completions agent 请求发送 `session_id`、来自 `026`
  的 `parent_session_id`、`request_purpose=agent`，并只在用户发起 run 的首个 provider 请求
  发送一次 `user_initiated=true`。legacy child 没有 `parentSessionId` 时，才沿 `spawnedBy`
  查询一次直接父 UUID，并在 session generation guard 下回填 child entry。
- **关系与边界**：优先消费 `026` 的持久 parent identity，legacy live lookup 不能覆盖已有快照；
  `028` 负责非 agent purpose。strict-compatible/custom provider 不接收 JustDo 私有 metadata，
  一次性标记也会被清理。
- **当前保留原因**：没有这些字段，LiteLLM 无法可靠区分会话、nested parent、后台 continuation
  与真实用户触发，影响归因、观测和按请求用途处理。
- **可删除条件**：上游为目标 provider 原生提供同语义 metadata，或 JustDo/LiteLLM 完全不再
  消费这些字段。

#### `028-request-purpose-metadata.cjs`

- **做什么**：native compact 和 safeguard 的 staged/chunk/retry 请求发送
  `request_purpose=context_compaction`；exec reviewer simple completion 发送
  `request_purpose=exec_review`，并携带正确 session identity。
- **关系与边界**：与 `027` 共用 `builtin_models + openai-completions` gating，但不依赖其 agent wrapper；确保后台请求不会
  错误继承 `request_purpose=agent`。custom/strict-compatible provider 不注入。
- **当前保留原因**：原始版本无法区分正常 agent、压缩和执行审查请求；后台调用会被错误归因
  或无法按用途观测/路由。
- **可删除条件**：上游覆盖 native compact、全部 safeguard retry 和 exec-review 三条真实调用链
  的 session-scoped purpose metadata，或下游不再依赖 purpose。

### 029–031：Compaction continuation 与失败恢复

#### `029-retained-user-compaction-context.cjs`

- **做什么**：在 `CompactionEntry.details.justdoRetainedUserMessages` 中保存滚动 20k-token
  原始用户消息，按 transcript entry identity 去重，以 Codex 一致的 UTF-8 bytes/4 预算做
  Unicode-safe 首尾裁剪，并逐条恢复为位于 summary 之前的真实 `user` message；带 archive
  的 checkpoint 可继续读取；只有带 Codex-local semantics marker 的 checkpoint 不回放旧
  assistant/tool tail，避免关闭该模式后误删原生 recent tail。
- **关系与边界**：`030` 只改 continuation wording，不保存原文；`031` 可读取该公开 details
  字段构造 emergency handoff，但字段缺失时仍能工作。metadata 不写入 16k summary suffix。
- **当前保留原因**：原始 replay 只有 summary 和有限 native tail；重复压缩会让用户的原始约束
  只剩模型转述，逐次漂移或消失。这是“与 Codex continuation 行为一致”的原文保真层。
- **可删除条件**：上游持久化、合并、裁剪并重放等价的 bounded retained-user metadata，覆盖
  first/repeated/split/legacy compaction。

#### `030-codex-continuation-compaction.cjs`

- **做什么**：把首次、重复和 split-turn compaction 的默认指令及 replay wrapper 替换为
  Codex 本地 fallback 的标准 prompt/prefix，并让所有阶段使用同一 prompt。
- **关系与边界**：`035` 负责显式选择 Codex-local 流程并绕过上游结构化 suffix；`030` 不负责
  保存原始用户消息或决定触发阈值。
- **当前保留原因**：目标版虽然支持追加 `customInstructions`，但固定默认模板和 replay wrapper
  仍以 OpenClaw 原生摘要语义组织，不能完整替换成 JustDo 需要的 continuation handoff。
- **可删除条件**：上游允许通过配置替换默认模板和 replay wrapper，或产品不再要求 Codex-style
  continuation。这里不声称逐字复制 Codex 未公开模板。

#### `031-compaction-emergency-handoff.cjs`

- **做什么**：非 Codex 模式遇到 missing model/auth、provider error/timeout、staged summary
  和 native compact 失败时，构造确定性的 `<=16k` 本地 handoff；Codex-local 模式不提交
  fallback checkpoint 并保留原历史。
- **关系与边界**：可消费 `029` 的公开 details，但兼容 absent/legacy，不依赖其私有 helper 或
  应用顺序；`030` 的 wording 也不是 emergency builder 前提。显式用户 abort 保持取消语义。
- **当前保留原因**：原始两条 compaction 路径遇到非用户失败会 cancel 或留下 stale
  `cancelReason`，上下文逼近上限时任务可能永久卡住，不能仅因压缩模型不可用而中止。
- **可删除条件**：上游 safeguard/native compact 都能在非用户失败时提交等价 bounded fallback，
  清理状态并继续；用户 abort 仍必须取消。

### 032–037：运行进度、恢复与上下文状态

#### `032-sanitized-run-progress-events.cjs`

- **做什么**：只向 JustDo managed session 发布 `queued`、`preparing`、`waiting_model`、
  `retrying` 四种有界、allow-listed progress stage，供长任务 UI 使用。
- **关系与边界**：使用持久化 ancestry 判断 scope，语义与 `017` 一致但不复用其 run-registry
  helper；普通 Gateway、cron、缺父、冲突、cycle、超深 ancestry 全部不发事件。
- **当前保留原因**：上游有内部 callback，却没有稳定安全的 UI contract。删除不会改变 agent
  最终结果，但长任务期间 UI 会失去可靠的排队/准备/等模型/重试反馈。
- **可删除条件**：上游发布等价 sanitized progress contract，或 JustDo UI 明确不再消费这些
  stage。这是 UX 能力，不应被描述成核心执行硬依赖。

#### `033-tool-error-reasoning-recovery.cjs`

- **做什么**：工具报错后，若模型只输出 reasoning 而没有可见回答，最多追加两次仅本 request
  可见、不写入 transcript 的 recovery instruction，要求模型给出用户可见结果。
- **关系与边界**：复用目标版 delivery evidence、spawn 和 async-start 状态判断；abort、timeout、
  client tool、yield、approval、已提交 delivery、已接受 spawn 或异步工作开始后都禁止 replay，
  且一旦进入本策略不会再叠加上游 reasoning retry。
- **当前保留原因**：原始 generic retry 不覆盖该 failure shape，用户可能只看到工具错误后任务
  静默结束。无安全 guard 的简单重试又可能重复副作用，所以必须保留有界且受证据约束的实现。
- **可删除条件**：上游提供等价 request-only、最多两次且具备相同副作用围栏的 recovery policy。

#### `034-live-context-budget-publication.cjs`

- **做什么**：在 active run 的 pre-prompt 和 mid-turn tool-result 边界，把权威
  `contextBudgetStatus` best-effort 写入原生 session store，供 `sessions.list` 实时展示。
- **关系与边界**：字段定义、list projection 和 turn 结束后的最终持久化全部由上游负责；本补丁
  只补实时窗口，并用 input provenance 排除 announce 等保留用户会话状态的内部 run，再以
  session generation、status timestamp 防止旧 run 覆盖新状态。通过校验的写入带有
  `justdoUsageBootstrap` 标记；UI仅在尚无 `totalTokens`、Gateway明确报告
  `hasActiveRun: true` 且标记存在时，
  把该值作为 `~` 启动估算，已有快照永远优先。
- **当前保留原因**：删除不会丢最终 budget 数据，但运行中的长 turn 一直显示旧值，UI 无法及时
  判断接近 compaction/overflow。这是实时可观测性能力，不是字段存储补丁。
- **可删除条件**：上游 active-run API 或 `sessions.list` 原生发布实时 context budget，或 UI
  不再需要运行中状态。

#### `035-codex-local-compaction-semantics.cjs`

- **做什么**：新增显式 `justdoCodexLocal` 配置，按有效窗口 90% 触发 pre-turn/mid-turn
  compaction，优先使用 provider usage；同一未变化 prompt 的 overflow compaction 限制为一次。
  safeguard 总结当前已安装上下文，关闭固定章节、quality/suffix 和 16k 后处理，并写入版本化
  `details.justdoCompaction` generation/trigger/reason/phase/token 元数据。只有摘要请求自身发生
  context overflow 才从最旧的完整 user turn 开始裁剪重试；认证、模型、超时或其他 provider
  错误以及无压缩进展均拒绝 checkpoint 并保留原历史。
- **关系与边界**：消费 `029` 的用户 archive、`030` 的标准 Codex prompt，并让 `031` 在该模式
  下 fail closed。所有行为均受显式配置门控，普通 OpenClaw compaction 保持原逻辑。
- **当前保留原因**：上游没有 Codex-local strategy、90% threshold 或等价 checkpoint 元数据；
  仅靠 customInstructions 无法改变历史替换顺序和自动触发状态机。
- **可删除条件**：上游提供等价的显式本地策略、用户原话+末尾摘要布局、连续压缩状态和失败语义。

#### `036-managed-session-identity-pin.cjs`

- **做什么**：对已有持久化 ID 的精确 `agent:*:justdo:*` 会话，在 command resolver、
  `chat.send` 的 reply-session 初始化、Gateway agent 初次解析以及持久化前复核四个位置都优先
  使用 store 中的 ID；过期 client ID、idle/daily freshness、failed transcript 缺失和 terminal
  transcript 检查都不能触发隐式换号。
- **关系与边界**：补足 `021` 只保存 identity evidence、未约束 session resolver 的缺口；Gateway
  RPC 的显式 reset/delete 在 agent resolver 前完成；reply-session 中的 `/new`、`/reset`
  则由 `!resetTriggered` 明确绕过 identity pin，仍按上游语义创建或删除身份。普通 session key
  的 rollover 行为逐字保留。
- **当前保留原因**：目标版会在 Gateway 请求开始和持久化前分别计算 session identity，任一处按
  freshness/transcript 状态生成 UUID 都会让 Renderer 拒绝 `sessions.changed`，并使恢复回合落入
  新 transcript。仅记录 join 时的 ID 不能阻止这个回归。
- **可删除条件**：上游为外部托管会话提供跨 command、Gateway admission、持久化复核和隐式恢复
  的 immutable identity，同时仍保留显式 reset/delete 语义。

#### `037-context-overflow-convergence.cjs`

- **做什么**：保留 `035` 的首次 Codex-local checkpoint，不改变正常 90% 触发和 handoff prompt；
  只在模型已经明确返回 context overflow 后启用最多三次恢复。后续 pass 可重新压缩没有新增
  transcript 的 checkpoint，并把总 handoff 目标逐级收紧到窗口 50%/25%，同步缩小 user archive
  与 summary，然后从当前 transcript 自动续跑。
- **关系与边界**：消费 `029` archive、`035` attempt/trigger metadata 和上游 outer retry loop；
  被取消但仍有剩余次数的 pass 不再直接终止。mid-turn/provider overflow attempt 的临时 assistant
  error 不发布 terminal lifecycle，避免 Renderer 在恢复过程中提前结束 turn。所有分支均由
  `justdoCodexLocal` 门控，三次仍超限才视为 system prompt/tool schema 等不可约开销。
- **当前保留原因**：上游只对未变化 prompt 做有限重试，且 safeguard 会拒绝没有新 transcript
  的重复压缩；真实 provider tokenization、system prompt 与 tool schema 开销可能让低于 90% 的
  checkpoint 仍被模型拒绝，从而把可恢复的 `mid-turn precheck` 暴露为用户终态。
- **可删除条件**：上游原生提供等价的有界、逐级收敛、保留会话身份且不发布中间 terminal
  lifecycle 的 overflow compact-and-continue 状态机。

#### `038-case-insensitive-subagent-task-names.cjs`

- **做什么**：允许 `sessions_spawn.taskName` 使用并保留大写 ASCII 字母，使校验与后续本就
  大小写不敏感的 alias resolver 一致；同步更新 Tool schema、模型提示和错误文案。
- **关系与边界**：不改变 registry 存储、标题投影或 target resolver。仍保留 1–64 字符、
  字母开头和 `[A-Za-z0-9_-]` 的无分隔符语法；`all`、`last` 改为大小写不敏感保留，避免
  `ALL`/`Last` 这类可创建但永远无法寻址的别名。
- **当前保留原因**：目标版 resolver 对 alias 使用小写归一化，却在 spawn preflight 拒绝所有
  大写输入，形成没有消歧收益的非对称限制；其保留字检查又是大小写敏感的。
- **可删除条件**：上游允许大小写混合的 `taskName`，并以与 resolver 一致的方式拒绝所有
  保留字大小写变体。

#### `039-recovery-compaction-progress.cjs`

- **做什么**：为 timeout/context-overflow 恢复分支直接调用的 context engine 压缩补齐
  `start/update/end/failed` 事件；等待首个 token 时每五秒发布经过时间心跳，LiteLLM 压缩摘要
  的文本 delta 会按会话节流发布，完成事件同时携带最终摘要和 token 变化。
- **关系与边界**：复用 `028` 的压缩请求 stream wrapper 和稳定 session ID，覆盖上游
  `AgentSession` 事件无法观察到的 direct recovery 调用。只发布压缩模型的文本摘要，不把
  reasoning、凭据或请求 payload 混入普通 assistant 流。
- **当前保留原因**：目标版的常规自动压缩会发布 lifecycle，但 overflow/timeout recovery
  直接调用 `contextEngine.compact()`；UI 因而仍停留在“等待模型回复”，也无法展示摘要进度。
- **可删除条件**：上游所有 context-engine 压缩入口统一发布可关联 session 的完整生命周期
  和安全摘要增量。

#### `040-compaction-error-attribution.cjs`

- **做什么**：记录 overflow 恢复中最后一次压缩失败；终态 payload、可见文本和
  `meta.error` 优先使用 timeout/auth/network/no-op 等真实 reason。本地 precheck 在多次成功
  压缩后仍无法满足安全预算时，显示 local prompt safety budget，而不是伪装成 provider overflow。
- **关系与边界**：在 `037` 的有界恢复和 `039` 的进度事件之后执行，只修改 embedded-agent
  最终归因；provider prompt/assistant error 明确返回、且被 OpenClaw 分类为 context overflow
  时仍沿用上游提示，hook/compaction 等来源不得借用该文案。任一恢复入口成功压缩或裁剪后都
  清除旧失败，避免历史 timeout/no-op 污染后续 attempt。
- **当前保留原因**：目标版以本地 `PREEMPTIVE_OVERFLOW_ERROR_TEXT` 进入恢复，压缩失败后却
  无条件复用通用 overflow 文案，导致 180 秒 safety timeout 被错误报告成模型拒绝上下文。
- **可删除条件**：上游将 precheck trigger 与 provider error 分型，并把最后一次 recovery
  failure 原样传播到最终 payload、lifecycle 和错误 metadata。

#### `041-managed-implicit-subagent-join.cjs`

- **做什么**：提供 managed 父会话的 durable implicit join 协议。它从 registry 选择仍要求
  completion message、且 `requesterSessionKey` 精确属于当前父会话的 child，接管 delivery、等待首批成功或失败结果，并生成有界的内部
  continuation payload 交给调用方。单批最多呈现 16 条并公平分配文本预算，超出的结果保持
  waiting，由下一轮继续交付；只有实际序列化进 prompt 的记录才会进入 `implicit_presented`，
  避免某个超长结果吞掉或误消费后续 sibling。
- **关系与边界**：复用 `018`–`021` 的 waiting/presented、恢复、cleanup 和 announce fence，新增
  `implicit_waiting` / `implicit_presented` 两个持久状态；后续 assistant stop 持久化后才消费结果。
  它不伪造 `sessions_yield` tool call。`expectsCompletionMessage=false` 和非
  `agent:*:justdo:*` ancestry 不会被选择；等待被中断或状态丢失时恢复 native FIFO completion
  delivery。`042` 是该 bridge 的 terminal 调用方。
- **当前保留原因**：目标版把无 tool/follow-up 的 assistant reply 直接当作 run terminal；阈值
  compaction 和 intentional silence 都不会检查 registry 中尚未被父模型消费的 required child。
  completion announce 又会在 requester run 活跃时等待，因此父模型可在最后一个 child 返回前先
  以 `NO_REPLY` 结束，表现为任务突然停止。
- **可删除条件**：上游原生区分 LLM turn completion 与 orchestration completion，在 terminal
  commit 前 durable join required children，并为 abort/restart、steer replacement、cleanup 与
  native completion fallback 提供等价的一次性交付语义。

#### `042-required-subagent-terminal-guard.cjs`

- **做什么**：把 terminal assistant reply（包括 `NO_REPLY` 和空可见文本）降级为终止候选；
  在 candidate delivery 前调用 `041`，拿到 required child 结果后抑制本次 terminal delivery，
  并在同一父 run 中继续执行。
- **关系与边界**：在 optional `before_agent_finalize` hook 之前运行，但保留该 hook 的原语义。
  implicit continuation 不占用 plugin 的三次 revision 预算，并能越过 intentional silence 的
  outer guard。用户 abort、timeout、error、framework retry、已有 client tool call、显式 yield
  和非 managed session 保持原行为。由 `subagent_announce` 启动、已经携带 completion 的投递
  run 不会再次 join 同一 child；native announce 在等待 requester 结束后还会二次检查 durable
  ownership。outer runner 的所有退出路径都会按 parent run 恢复尚未提交的 implicit 状态，
  已成功消费的结果不受影响。managed terminal guard 只延迟 outbound partial/block delivery；
  Gateway 内部的 assistant observation 携带 attempt token 实时广播，避免正常主会话正文直到
  terminal 才集中出现。terminal 接受时提交该 token，候选被拒绝或 compaction retry 清空时回滚
  对应 Content，避免把未交付的候选正文留在 UI。
- **当前保留原因**：仅有 durable join bridge 不会改变 embedded runner 的终止控制流；目标版
  会在最后一个 required child 返回前接受模型的 `NO_REPLY`，使 completion FIFO 等待一个已经
  结束的 requester run，表现为工作流突然停止。
- **可删除条件**：上游在 terminal delivery 前原生调用等价的 required-child obligation guard，
  并以不伪造 tool transcript、不重复副作用且不受普通 finalize-revision 次数限制的方式续跑。

#### `043-completion-delivery-followup-join.cjs`

- **做什么**：细化 `042` 对 `subagent_announce` completion delivery run 的防递归边界。
  从 provenance 提取当前正在投递的 source child session key，只把该 child 排除在 implicit
  join 外；同一父 run 新调用 `sessions_spawn` 创建的 follow-up child，以及其他尚未消费的
  required sibling，仍由 `041` 等待并驱动父 agent 继续。
- **关系与边界**：依赖 `041` 的 terminal join selector 和 `042` 的 terminal interception。
  direct source 必须与当前父会话仍待 native delivery 的 exact child 匹配，才会只排除 source；
  缺失、过期或无法关联的 completion provenance 继续 fail closed。descendant-settlement 的
  self-source synthetic wake 只有在 registry 能证明 controller 是父级注册的 subagent 时才
  不排除其 descendants。普通用户 run、显式 `sessions_yield`、fire-and-forget child、abort、
  timeout 和非 managed session 不变。
- **当前保留原因**：`042` 原先按整个 completion delivery run 跳过 implicit join。父 agent
  收到上一批结果后若在这一轮派发下一批 child、但模型偶发漏调 `sessions_yield`，run 会直接
  结束；新 child 完成后没有存活的父编排继续消费，表现为“subagent 已完成，主 agent 却停止”。
- **可删除条件**：上游能区分正在投递的 source completion 与该 run 新产生的 required-child
  obligation，并在接受 terminal reply 前只排除 source、可靠 join 其余 child。

#### `044-managed-terminal-handoff.cjs`

- **做什么**：当一次显式 `sessions_yield` 只返回部分 child，而模型随后输出 terminal reply 时，
  把同一 controller 尚处于 `waiting` 的 sibling 原子转交给 `implicit_waiting`，等待完成后继续父
  run。registry 写入失败会原地恢复已有对象，不会留下内存/SQLite 分歧或无限 continuation。
- **关系与边界**：依赖 `018`–`021`、`041`–`043` 的 ownership 和 completion provenance。
  embedded terminal guard 与 Codex app-server 都执行同一 durable handoff；completion-delivery run
  允许 exact source 已进入 `presented`/`tool_result_committed`，但只排除该 source，不能放宽 stale
  或 forged provenance。Codex 是运行时安装的 official companion，因此 loader 在 full registry 与
  CLI metadata 的任何 plugin import 前，按锁定版本/hash 原子应用 companion 的 `019`、`020`、
  `044` 合约；失败拒绝加载，repair 后清除 loader cache。
- **安全边界**：只接管 exact requester/controller 的 unfinished explicit wait。多文件 companion
  更新有跨进程锁、受约束的 crash artifact 恢复、root containment、symlink/hardlink 拒绝、
  staged verify 和 rollback。abort/timeout 恢复 native ownership；handoff 失败会记录结构化诊断，
  包含失败原因、run/session 标识、delivery 是否恢复及恢复结果。未恢复时不放行 terminal reply，
  也不进入无界 managed revision；JustDo UI 不展示这条内部 durability 错误。
- **可删除条件**：上游能在 embedded 与 Codex terminal commit 前原子接管 unfinished explicit
  wait，并让动态 companion 安装/更新原生携带同等 exact-once、restart 和 durability 语义。

#### `045-openai-stop-tool-call-compat.cjs`

- **做什么**：兼容 OpenAI-compatible provider 同时返回可见 assistant text、完整 structured
  `tool_calls` 与 `finish_reason=stop` 的响应。只有 tool id/name 非空、name 属于本次 advertised
  tool set、arguments 是完整 JSON object 时，新增的 visible-text 路径才提升为 tool use。
- **关系与边界**：同时覆盖 transport parser source 与最终 `gateway-bundle.mjs`；fresh-bundle
  patch 在 prod dependency install 和 esbuild 之后重放，manifest 只锁最终 bundle。无正文时保留
  上游既有 tool-use/error 自修复语义；visible-text 下的空、残缺、unknown 或 mixed call 不执行。
- **可删除条件**：上游能在保留 visible assistant text 的同时可靠派发完整 advertised structured
  tool calls，并明确拒绝残缺/未知调用。

#### `046-app-startup-task-recovery-boundary.cjs`

- **做什么**：JustDo 为当前软件进程捕获稳定的启动时间，并向该进程启动的每个 Gateway 注入
  `JUSTDO_APP_STARTED_AT_MS`。OpenClaw 将更早或缺少时间戳的 orphaned `running` 主会话原子
  收敛为 `failed`，不发送恢复 prompt；同一软件进程内创建或更新的任务仍执行上游的
  interrupted-turn 自动恢复。
- **关系与边界**：主会话按 `updatedAt` 与 app-start cutoff 分类，并在持久化时校验原值，避免
  recovery scan 覆盖并发启动的新 run。subagent registry 在任何 join/announce/orphan restore
  副作用前，先给旧进程记录设置 `suppressCompletionDelivery`；未结束 run 按精确 `runId` 终止，
  已结束 run 仍允许执行 `subagent_ended` 清理 hook，但不向旧 requester 回投结果。cron 和 ACP
  session 继续沿用上游 skip 规则。JustDo Goal 使用同一 cutoff，并保护当前 active run、当前用户
  activation 与精确的 session/goal ownership；首次完整扫描后，同进程 Gateway 重连恢复正常。
- **可删除条件**：上游提供 host app lifecycle identity，并能原生区分宿主软件重启与 Gateway
  重启，同时保留后者恢复且让前者安全终止为可手动继续的状态。

#### `047-openai-compatible-embedding-env-proxy.cjs`

- **做什么**：让 generic OpenAI-compatible embedding provider 的 `/embeddings` guarded fetch
  使用 `useEnvProxyForEligibleUrls`。memory search/index CLI 已从 JustDo 获得隔离的
  `HTTP(S)_PROXY`、`NO_PROXY` 与 CA 环境，因此重建索引请求会实际到达 OutboundHeader 代理。
- **关系与边界**：只修改该 provider 的单个 POST 调用，同时覆盖 source 与最终
  `gateway-bundle.mjs`。未配置代理或命中 `NO_PROXY` 时仍直连；SSRF policy 保持生效。代理收到
  请求后仍按完整 URL 白名单决定是否注入 Header，未命中请求透明转发，runtime 不读取或复制
  `X-User-Account`、`X-Cookie` 等用户值。
- **当前保留原因**：目标版另一路 memory remote helper 已能自动选择 env proxy，但 Gateway
  实际使用的 generic embedding provider 只调用 strict `fetchWithSsrFGuard`。未设置
  `OPENCLAW_PROXY_ACTIVE=1` 时它会绕过 CLI 的 `HTTP(S)_PROXY`，表现为 `User-Agent` 到达而
  OutboundHeader 未注入。
- **可删除条件**：上游 generic embedding transport 原生按 eligible URL 使用受信任 env proxy，
  并继续保留 `NO_PROXY` 与 SSRF 边界。

#### `048-memory-force-reembed-opt-in.cjs`

- **做什么**：为 OpenClaw memory shadow reindex 增加精确的 host opt-in；当且仅当 CLI 环境包含
  `JUSTDO_MEMORY_REINDEX_NO_CACHE=1` 时，不把旧数据库的 embedding cache 复制进临时索引库，迫使
  有效记忆分块重新请求 embedding。JustDo 仅在设置页“重建索引”入口设置该值。
- **关系与边界**：`047` 负责让真实请求使用 eligible env proxy，`048` 负责保证用户主动重建时
  不被旧向量缓存短路。普通 memory search、后台增量索引及用户直接运行的 OpenClaw CLI 仍保留
  原生缓存语义；原数据库不会预先删除，只有 shadow reindex 全部成功后才按上游流程原子发布。
- **当前保留原因**：目标版 `memory index --force` 会重建索引表，但先 seed 旧 embedding cache；
  文档内容未变化时可在没有任何模型请求的情况下成功结束，无法满足 JustDo 按钮“重新计算向量”
  的产品语义，也无法通过该入口验证 OutboundHeader 请求链路。
- **可删除条件**：上游 `memory index` 提供等价的 `--no-cache`/`--reembed` 选项，JustDo 可直接调用。

#### `049-gateway-tool-invoke-loop-scope.cjs`

- **做什么**：让认证后的 Gateway `subagents list` 查询继续经过 `before_tool_call` hook、授权和审批，
  但只给该只读 out-of-band 状态查询传入 `{ enabled: false }` 的 loop-detection context。JustDo 可继续
  把结构化 `subagents` 工具作为当前状态权威，而不会因为 UI 状态刷新污染父会话的代理工具调用历史。
- **关系与边界**：本补丁作用于 Gateway RPC/HTTP 共用入口，但精确限定为工具名 `subagents` 且
  action 为 `list`；`subagents` 的 kill/steer 等动作以及 exec、文件和插件工具仍保留 loop detection。
  本补丁不修改模型执行期间构建的 agent tools。运维调用仍受认证、tool visibility、plugin policy、
  approval mode 与参数 schema 约束。049 只接受 pristine target 或本次 patch pass 已正确应用的
  幂等状态；source 行尾 marker 被 esbuild 确定性移到下一行时，bundle pass 只把该同次构建产物
  规范化回 canonical 形式。不识别、不迁移任何旧版 049 结果，补丁变更必须重新构建 runtime。
- **当前保留原因**：目标版 `invokeGatewayTool` 使用父 `sessionKey` 调用 `runBeforeToolCallHook`，并传入
  普通 agent loop config；RPC 没有 agent `runId`，因此菜单/抽屉轮询会被错误累计为代理重复调用，
  产生 increasing repeat count 和 critical loop warning。
- **可删除条件**：上游原生把 loop detection 限定到 agent-run tool calls，或提供不经过工具执行的
  结构化 subagent list RPC，同时继续保留 Gateway 工具授权与审批边界。

## 已删除或由上游/App 承担的能力

| 能力                                            | v2026.7.1-2 证据与决定                                                                                                                                                                                                                                                 |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 80 字符 thinking preview                        | 不属于 OpenClaw runtime patch；`src/main/openclaw/runtime/gatewayLogFilter.ts` 已由 JustDo App 实现。                                                                                                                                                                  |
| announce reasoning default                      | 目标版只在 reply/status 路径解析该字段；direct Gateway agent（包括 completion announce）仍会丢失 reasoning preference，现由 `002` 以最小传参补齐。                                                                                                                     |
| 可见 stop 不因 usage=0 重试                     | 原生 empty-response classifier 先按 assistant payload/text 排除，不读取 usage；pristine H04 contract 覆盖，删除旧覆盖逻辑。                                                                                                                                            |
| subagent completion 的 `NO_REPLY` 静默成功      | 已删除目标版实验补丁 `subagent-completion-response-policy`。managed join 成功路径不创建 completion announce；join 失败恢复原生投递时必须产生可见结果，不能用 `NO_REPLY` 把未展示的 child 结果标成 delivered。普通非 subagent 的 intentional silence 继续使用上游语义。 |
| `sessions_yield` delivery evidence/CLI gap-fill | 已删除目标版实验补丁 `yielded-transcript-handling`。managed `sessions_yield` 返回当前 tool call 的内部 child result，不是 committed outbound delivery；原生 CLI transcript 保持上游行为。                                                                              |
| sibling completion transcript 启发式去重        | 删除旧 `008`。managed join 由 `018`–`021` 唯一消费并阻断重复 announce；join 失败由 `020` 恢复一条 native delivery，再由 `016` 按 requester FIFO 投递。未进入 join 的路径直接使用 `016`。                                                                               |
| active/pending delivery 时允许 `sessions_yield` | 原生工具没有 active/ended delivery guard，任何合法 session 都调用 `onYield`；pause generation 会由 completion run reactivation 替换。pristine H07 与 completion tests 覆盖，删除旧 `006`。                                                                             |
| reply init/revision conflict retry              | 原生已有 revision/init conflict normalization 和 retry，删除旧 `009`。                                                                                                                                                                                                 |
| compaction summary input 排序/裁剪              | 上游已处理 previous summary 的单次 redistill、recent assistant/tool result、split-turn prefix、tool-detail stripping、chunk budget、oversize omission 和 recent suffix 上限；pristine C02 contract 覆盖，不再重写。                                                    |
| context budget 字段/投影/最终持久化             | 上游保留，只由 `034` 补 active-run 实时更新。                                                                                                                                                                                                                          |
| active-run 字段改造                             | 完全删除；`032` 只提供 JustDo 使用的安全 progress event。                                                                                                                                                                                                              |
| subagent task title 存储                        | 上游注册前已将 `taskName` 写入 registry/SQLite 并能恢复；pristine S05 contract 覆盖，`012` 只补列表投影。                                                                                                                                                              |

## 旧 v2026.6.11 的 25 个文件处置清单

“删除”表示目标版本不再需要 runtime patch，不表示产品行为被删除。

| 旧文件                                       | 决定                 | v2026.7.1-2 结果                                                                                                                                                                      |
| -------------------------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `001-thinking-stream`                        | 拆分                 | “让 JustDo 实时接收 Thinking 流”的核心能力从新控制流重写为 `002`；80 字符日志 preview 由 App 维护。                                                                                   |
| `002-agent-announce-reasoning-stream`        | 合并并重写           | 并入新 `002`：保留 callback-independent publication，并补 direct agent execution 的 resolved reasoning 传递。                                                                         |
| `003-openai-content-reasoning-tags`          | 保留并重写           | `003`。                                                                                                                                                                               |
| `004-windows-mcp-package-runner`             | 拆分并重写           | `006` 通用 runner、`007` Chrome 启动诊断、`008` 空页面恢复。                                                                                                                          |
| `005-history-thinking-and-subagent-yield`    | 审计后部分保留       | 保留 `004` history、`015` branch promotion、`016` FIFO/recovery；删除与 managed join 新语义冲突的 silent completion 和 yield evidence/CLI gap-fill；usage=0 visible-stop 由上游承担。 |
| `006-sessions-yield-active-guard`            | 删除                 | 上游 H07 已满足更宽松、可恢复的 yield 语义。                                                                                                                                          |
| `007-allow-managed-pip-config-env`           | 保留并安全重写       | `001`，不再全局删除 deny-list。                                                                                                                                                       |
| `008-dedupe-visible-subagent-announces`      | 删除                 | managed 路径由 `018`–`021` 消费和防重，fallback/native 路径由 `016` 串行投递。                                                                                                        |
| `009-reply-session-init-conflict-retry`      | 删除                 | 上游已实现。                                                                                                                                                                          |
| `010-defer-selected-tool-schemas`            | 保留并重写           | `009`。                                                                                                                                                                               |
| `011-retain-user-messages-across-compaction` | 部分保留、结构化重写 | `029` 只负责 retained-user metadata 与 replay；summary input 由上游 C02 承担。                                                                                                        |
| `012-codex-compaction-template`              | 最小保留             | `030` 复用 `customInstructions`，只补默认模板与 replay wrapper。                                                                                                                      |
| `013-default-cron-delivery-none`             | 保留并重写           | `005`。                                                                                                                                                                               |
| `014-live-context-budget-status`             | 部分保留             | `034` 只补 active-run publication。                                                                                                                                                   |
| `015-final-system-prompt-replacements`       | 保留并重写           | `010`。                                                                                                                                                                               |
| `016-litellm-session-id`                     | 拆分并重写           | `026` parent identity、`027` agent/initiation、`028` compaction/review purpose。                                                                                                      |
| `017-tool-error-reasoning-recovery`          | 保留并重写           | `033`。                                                                                                                                                                               |
| `018-persistent-interactive-approvals`       | 拆分并重写           | `022` lifetime、`023` suspension、`024` resume、`025` stop/failure。                                                                                                                  |
| `019-compaction-emergency-fallback`          | 保留并重写           | `031`。                                                                                                                                                                               |
| `020-run-progress-events`                    | 部分保留             | 删除 active-run 改造，`032` 只发布四个安全 stage。                                                                                                                                    |
| `021-atomic-sessions-spawn-admission`        | 保留并重写           | `013`。                                                                                                                                                                               |
| `022-subagent-pending-status`                | 保留并重写           | `014`。                                                                                                                                                                               |
| `023-managed-subagent-join`                  | 拆成六项重写         | `017` classification、`018` same-run join、`019` commits、`020` recovery、`021` delivery ownership、`036` session identity pin。                                                      |
| `024-silent-goal-clear`                      | 保留并重写           | `011`。                                                                                                                                                                               |
| `025-subagent-session-title-metadata`        | 部分保留             | 上游持久化 `taskName`；`012` 只补 list projection。                                                                                                                                   |

## 测试索引

| 测试                                                  | 主要覆盖                                                                                                                                   |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `openclawPristineContracts.test.ts`                   | 锁定原始 npm 包、11 项上游能力证据、49 项保留缺口、头注释和大小约束。                                                                      |
| `openclawV202671ReasoningStream.test.ts`              | `002` callback gate 的原始失败与改写后事件/回调行为。                                                                                      |
| `openclawV202671PatchSafety.test.ts`                  | `001`、`004`、`007`、`034` 的安全边界和真实 fixture 幂等。                                                                                 |
| `openclawV202671CompletionDelivery.test.ts`           | H07 上游语义、managed yield 非对外交付、subagent `NO_REPLY` 非成功，以及 `015`、`016` 的 FIFO、硬期限和恢复边界。                          |
| `openclawV202671AtomicSessionsSpawnAdmission.test.ts` | `013` native pristine 并发失败、post-preflight reservation、canonical requester、跨 requester 并行、ACP 不变及 source/bundle 原子幂等。    |
| `openclawV202671SubagentCapabilityPatches.test.ts`    | `014`。                                                                                                                                    |
| `openclawV202671ManagedSubagentJoin.test.ts`          | `017`–`021` 的分类、批次、两阶段提交、消失 run 终止等待、恢复与 announce fence。                                                           |
| `openclawV202671ManagedImplicitSubagentJoin.test.ts`  | `041`/`042` required child 选择、失败结果、prompt 上限、silent terminal guard、无预算续跑及 commit 边界。                                  |
| `completion-delivery-followup-join.test.ts`           | `043` provenance/registry 关联、self-source wake、source-only 排除、follow-up join/commit/abort 状态链及 source/bundle 幂等。              |
| `managed-terminal-handoff.test.ts`                    | `044` partial→terminal ownership、completion source、persist rollback、Codex companion loader gate、crash recovery 及 source/bundle 幂等。 |
| `openai-stop-tool-call-compat.test.ts`                | `045` visible text + stop + structured call、严格 JSON/advertised gate、fresh bundle 顺序、verify 与幂等。                                 |
| `app-startup-task-recovery-boundary.test.ts`          | `046` 首次软件启动终止 orphan、稳定 app-start cutoff、后续 Gateway 重启恢复、source/bundle verify 与幂等。                                 |
| `openai-compatible-embedding-env-proxy.test.ts`       | `047` generic embedding 的 eligible env proxy、真实 HTTP proxy 路由、source/bundle verify、幂等与歧义拒绝。                                |
| `memory-force-reembed-opt-in.test.ts`                 | `048` 精确 host opt-in、默认缓存不变、source verify、幂等、部分状态与歧义拒绝。                                                            |
| `gateway-tool-invoke-loop-scope.test.ts`              | `049` 运维 RPC loop scope、hook/审批保留、source/bundle verify、幂等、部分状态与歧义拒绝。                                                 |
| `openclawV202671ManagedSessionIdentity.test.ts`       | `036` command、reply、agent initial/persisted 四落点 identity pin（含 reply reset 绕过）、普通会话不变、幂等和多目标原子失败。             |
| `openclawV202671ApprovalLifecycle.test.ts`            | `022`–`025` 的 lifetime、hidden resume、stop/failure 与文件头。                                                                            |
| `openclawV202671RequestMetadata.test.ts`              | `026`–`028`，含 strict-compatible negative 与 nested parent。                                                                              |
| `openclawV202671CompactionMetadata.test.ts`           | `029` identity dedupe、逐条 user replay、summary 顺序、20k token、CJK/emoji 边界。                                                         |
| `openclawV202671EmergencyCompaction.test.ts`          | `031` 非 Codex fallback、Codex fail-closed、abort、details、source/bundle 原子性。                                                         |
| `openclawV202671CodexLocalCompaction.test.ts`         | `035` 显式配置、90% pre/mid-turn 阈值、结构绕过、metadata 与 overflow 单次恢复。                                                           |
| `openclawV202671ContextOverflowConvergence.test.ts`   | `037` 三次有界收敛、无新增 transcript 再压缩、Unicode-safe archive、summary 上限和临时 lifecycle 围栏。                                    |
| `openclawV202671SubagentTaskNameCase.test.ts`         | `038` 大小写保留、保留字大小写折叠、原有 identifier 边界、提示同步、source/bundle 幂等及歧义 anchor 拒绝。                                 |
| `openclawV202671RecoveryCompactionProgress.test.ts`   | `039` timeout/overflow direct compaction 的 lifecycle、等待心跳、摘要流、清理、幂等和歧义 anchor 拒绝。                                    |
| `openclawV202671CompactionErrorAttribution.test.ts`   | `040` timeout/no-op/local precheck/provider overflow 的终态归因、metadata、幂等、partial 与歧义拒绝。                                      |
| `openclawRunProgressEventsPatch.test.ts`              | `032` pristine callback gap、JustDo root/nested ancestry、native/cron/missing/conflict/cycle fail-closed、CLI/embedded allow-list event。  |
| `openclawV202671CapabilityPatches.test.ts`            | `010`、`022`、`027`、`031`、`033` 及歧义 anchor 原子失败。                                                                                 |
| `openclawRuntimePatchManifest.test.ts`                | source lock、patch/build recipe fingerprint、cache、manifest/tamper fence。                                                                |
| `openclawRuntimeStaging.test.ts`                      | runtime 目录原子替换、Windows `current` link 恢复和失败 rollback。                                                                         |

历史 `v2026.6.11` 测试只能作为审计资料，不能作为本目录的目标版本证据。
