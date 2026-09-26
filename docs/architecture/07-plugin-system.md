# 插件系统：管理状态、文件事务与运行能力

插件页组合多种能力，但它们不是同一种安装单元。本文以 Main 插件服务、原生 API、配置同步和 Extension 注册为依据，说明读取、启停、安装和恢复各由谁负责。

## 1. 类型与所有权

| 类型        | 运行权威                          | 产品负责                              | 主要限制                                   |
| ----------- | --------------------------------- | ------------------------------------- | ------------------------------------------ |
| Skill       | Gateway skills.status/update      | 用户文件导入删除、列表投影            | 文件存在不等于 eligible                    |
| MCP         | 原生连接与工具调用                | 用户配置 Store、发现与配置同步、probe | Extension 提供项是只读来源                 |
| Hook        | 原生 hook runtime                 | 本地包、产品开关和受管同步            | 与 Extension 的 hook capability 不混为一项 |
| Extension   | plugins.list/setEnabled/uninstall | 审查、受控导入、产品保护规则          | 运行代码进入 Gateway 信任域                |
| Marketplace | 各类型安装器及 inventory          | 公司 SDK 适配、来源/版本身份          | 不是另一份运行态清单                       |

Plugin Hub 有四类插件概念；市场当前只开放 extension、skill、mcp 三种 catalog kind。共享 PluginKind 中有 hook，不代表 Marketplace 也支持安装 Hook。仓库默认未注册业务市场 provider。

## 2. 从页面到运行时

```mermaid
flowchart LR
  UI[PluginsView 与领域面板] --> Preload[显式插件 IPC]
  Preload --> Service[Skill / MCP / Hook / Extension 服务]
  Service --> Files[受管文件事务]
  Service --> Store[(产品配置 / 安装身份)]
  Service --> Sync[配置同步]
  Service <--> Gateway[原生管理 API]
  Sync --> Gateway
  Gateway --> Inventory[有效 inventory]
  Inventory --> UI
```

Renderer 显示 loading/error、操作能力和运行结果；不能通过自行扫描目录决定安装状态。启停成功后重新读取 inventory；同名条目的来源变化也需要呈现，不能只把旧卡片布尔值翻转。

本地 Extension 的构建预编译同时覆盖主入口和独立的 `setup-api` 入口（插件根及 `dist/` 下的 TypeScript 文件）。即使主入口已经是 JavaScript，也必须处理 setup 入口；编译成功后移除对应 TypeScript 入口，避免 OpenClaw 优先选中源码。ACPX 的自动启用探针在配置、旧状态检查和重载时都会运行，遗漏其 setup 预编译会触发原生源码代际快照，重复复制、哈希和校验依赖树。预编译让 bundled JavaScript 使用原生快速加载路径，不改变用户插件的源码隔离或完整性校验。

## 3. Skill：有效赢家与文件来源

内置 manifest 有 8 个默认启用项：data-analysis、diagram-design、frontend-design、docx、pdf、pptx、skill-creator、xlsx，并关闭 OpenClaw 默认技能集。打包资源必须与 manifest 一致；数量不应散落在 UI 常量中。

skills.status 提供 effective source、eligibility、disabled、缺失依赖和安装选项。产品文件服务只管理用户导入目录；它不能从 SKILL.md 自行重建运行元数据。受管根使用原生 stateDir/skills，避免重复 extraDirs 引入同一路径。

同名技能遵循原生解析赢家。关闭赢家不等于自动切换到下一来源；赢家目录删除后的 fallback 是另一种变化。没有原生 variants contract 时，UI 不展示臆测的 shadowed 数量或逐来源 toggle。

Extension 发布技能的 scope 表示父插件管理，ownershipScope 表示产品展示归属；两者不能合并推导删除能力。系统内置与用户 Extension 的技能均可能由父插件托管。

### 用户文件变更

导入验证结构与精确目标，复制到受管根。删除先原子移入同卷 `.justdo-skill-trash/delete-*`，避免递归删除中途留下半残 live skill。机会式清理仅处理已知 trash 子目录，不能扫描删除未知项目。

Windows 文件被占用时，ManagedDirectoryOperationCoordinator 识别受管进程，必要时取得配置 mutation 中的原生 suspension，再 stop/mutate/start。不能因为文件锁就杀任意进程；恢复失败必须可诊断。

### 技能提案审核

学习直接使用现有聊天中的原生 `/learn`，遵循原生工具能力、会话权限与技能配置。
JustDo 不再提供独立学习启动流程，也不通过审核入口修改全局学习或发布策略。
技能页仅保留“技能提案”低频入口，独立模态弹窗打开后才读取和轮询主助手（main）的提案。
技能列表默认显式查询 main，`openclaw-workshop` 来源展示为助手提炼技能，不走导入目录删除逻辑。

```mermaid
sequenceDiagram
  participant C as 现有聊天
  participant U as 技能提案弹窗
  participant M as Main / SkillWorkshopService
  participant G as OpenClaw
  C->>G: 用户发起 /learn
  G-->>C: 学习进展与结果
  U->>M: 读取主助手提案
  M->>G: skills.proposals.list
  U->>M: 查看提案
  M->>G: skills.proposals.inspect / skills.workshop.read
  U->>M: 批准或拒绝（expectedRevisionHash）
  M->>G: skills.proposals.apply / reject
  U->>M: 重新读取提案与有效技能清单
```

审核页对更新提案并列显示完整当前指令与提案指令；新建提案只显示新指令，并展示完整支持文件及原生状态。
更新提案读取当前技能并核对原生目标哈希；无法读取或目标变化时禁止批准。Main 校验 main 归属、pending 状态、
expectedRevisionHash，按提案序列化并发决定，再调用原生审核 API。原生负责最终目标冲突、扫描与原子发布。
超时不重放写操作；清除旧审核快照，刷新权威状态后要求重新打开提案。弹窗关闭/卸载停止轮询，
重新打开从原生恢复；写入期间禁用关闭，切换筛选清空旧详情。学习执行和提案持久化仍由原生负责。

## 4. MCP：配置与原生发现的汇合

用户 MCP 保存在 mcp_servers。新增、改名、删除和启停通过串行配置同步生成原生 mcp.servers；原生新增的 server 可在列表刷新和非 MCP mutation 同步前导入缺失 name。

发现只增加缺失项，不因原生配置暂时缺失就删除产品记录。产品主动删除/改名后不能先读旧原生配置，否则会复活旧 name。未被表单建模的 cwd、OAuth、TLS、tool filter 等字段需要保留合并，不能保存一次表单就丢失。

请求 timeout 按单 server override 优先于全局默认投影为 requestTimeoutMs；连接建立 timeout 是另一概念。Extension 自带 MCP 的配置由父插件拥有，不套用户 server 的默认设置。

probe/readResource 在 Main 使用真实 transport。HTTP/SSE probe 保持流式响应、禁止自动重定向并使用网络策略；stdio command/env 属于执行输入，敏感值不能进入 UI 诊断或日志。

## 5. Hook：文件、数据库与配置共同提交

独立 Hook 包包含 HOOK.md 和受支持入口，导入支持限定压缩格式。ID 和路径先规范化，内置与已有目标不能普通覆盖。bundle 环境通过 OPENCLAW_BUNDLED_HOOKS_DIR 指向实际产物。

删除先隔离目录，再修改 Store 和同步配置；同步失败恢复记录与目录，成功后清理隔离区。SQLite transaction 只保护本地行，无法回滚原生 reload，必须保留跨边界补偿语义。

## 6. Extension：审查与运行态对账

列表、启停和卸载使用原生 plugins API。可删除能力由原生 inventory 与产品保护共同决定，不能由一个“用户安装”标签猜测。bundled plugin 目录固定到 runtime/dist/extensions。

本地 path/archive 安装通过受管 CLI。安装前解析能力 surface、operator grants、来源和 integrity，向 UI 返回审查数据；提交时要求匹配本次 surface 的 reviewToken，重新核对后才调用安装器接受能力。包在审查后变化，旧 token 不能继续安装。

```mermaid
flowchart LR
  Source[目录 / 压缩包 / 市场下载] --> Validate[安全解包与格式判断]
  Validate --> Review[能力审查与 reviewToken]
  Review --> Recheck[再次校验同一内容]
  Recheck --> Install[受管原生 CLI 安装]
  Install --> Readback[原生 inventory / installed-index]
  Readback --> Result[结果与配置更新]
```

原生 openclaw.plugin.json 包交由原生安装器验证。其他 bundle 格式虽可能被上游识别，产品共用 conversion 入口当前仍会提示未支持并停止；不能把上游格式能力直接宣传为产品已完成转换。临时目录始终清理，CLI 输出和 timeout 有界，失败不伪造 runtime id。

## 7. 产品扩展各有生命周期

| 扩展/能力             | 持有的状态                           | 产品桥接                     |
| --------------------- | ------------------------------------ | ---------------------------- |
| Runtime Services      | 原生历史、进度、回执的受限读取       | Main/Renderer 查询投影       |
| AskUserQuestion       | pending、期限、默认及取消            | 问答 event/RPC、UI replay    |
| Plan mode             | 原生 session mode、待审核交互        | Main 计划文件与 handoff      |
| Automation permission | 按原生 session mode 进行任务变更审批 | 使用原生 plugin approval     |
| Embedded browser      | 原生 browser 工具桥                  | Main guest 所有权与动作执行  |
| agent-team            | 可选工具、技能与原生发送 hooks       | Main 成员、轮次及接收元数据  |
| stt-local-cli         | 本地附件转录工具                     | 已安装 Sherpa 路径及文件策略 |

agent-team 默认关闭，禁用保留历史；Runtime Services 仍读回执并阻止受管 peer send。stt-local-cli 保留显式 disable，附件转录独立于麦克风开关；sandboxed session 不注册该 host tool，文件访问遵循有效 fs policy，无云端 fallback。

插件可拥有工具或钩子，但不能建立第二份产品会话 transcript。角色文件也归原生 agents.files，不把长期助手实现成 Skill 目录的另一套编辑器。

## 8. 请求头 sidecar 与信任

Extension 可用 outbound-header-policy.json 声明 HTTPS 目标、Header 名称和受管 user-info 引用。声明不含凭据值，安装前校验、安装后 canonical path 回读，启用状态参与有效策略合并。

它不能写永久手工 config，也不提供任意凭据 API。Gateway 同进程 Node Extension 仍处于可信代码边界，sidecar 并不是恶意插件网络沙盒。详细规范见[出站指南](../developer-integration/outbound-headers/README.md)。

## 9. 故障不能只显示“未安装”

| 阶段           | 失败意义                  | 恢复要求                   |
| -------------- | ------------------------- | -------------------------- |
| 下载/解包      | 尚无有效安装输入          | 清理临时目录，保留原安装   |
| 格式转换       | 产品尚不支持或输入非法    | 明确停止，不调用 CLI       |
| 能力审查       | 内容或授权不匹配          | 重新审查                   |
| 文件变更       | 路径、锁或权限失败        | 保留事务/隔离区证据        |
| 配置应用       | 磁盘与 runtime 可能不一致 | 领域回滚或明确待恢复       |
| inventory 读取 | 无法确认当前状态          | 显示查询失败，不能猜未安装 |

## 10. 测试与维护

从 `src/main/plugins/` 的文件事务、MCP/Hook 同步、Extension import/conversion 和 registry 测试检查产品层；从 `tests/openclaw/extensions/` 与 skill-resolution runtime contract 检查最终原生能力。市场增加 kind 前需完成安装、更新、启停、删除与状态对账闭环，详见[市场适配](16-skill-marketplace-adapter.md)。

## OpenClaw 2026.9.6 integration

The runtime retains the native QuickJS Code Mode executor and GitHub reader plugins,
including explicit allowlist membership while preserving user disable state. Local
extensions import named SDK subpaths. Agent-owned Workshop collections remain
Gateway-owned; the application does not recreate workspace-based skill ownership.
See [upgrade audit](../openclaw-upgrades/v2026.9.6.md).

## 内置浏览器与执行策略

`embedded-browser` 的浏览器指导在 `before_prompt_build` 中以 `requiresToolAuthority: true` 注册，读取本轮策略过滤后的 `toolAuthority`。只有实际允许 `browser` 时才注入操作指导；工具不可用时说明执行策略限制，禁止重复发现、通过 shell 绕开限制或自行放宽执行权限。工作区网页可见不代表 Agent 获得操作权限。

默认沙箱策略不提供宿主 `browser` 工具。用户可在“设置 → 安全 → 任务执行方式”选择本机执行，应用不因打开网页而修改策略。内置模式禁用原生 browser 插件，由桌面扩展提供工具，因此 OpenClaw Control UI 的原生 browser.request 查看入口不适用于该模式。

## Workboard：四栏展示与原生执行

Workboard 仍使用 OpenClaw 插件的 `workboard.cards.*` / `workboard.boards.*`
接口和原生 SQLite。Renderer 的四栏是展示投影，不改写持久化状态：

| 展示列 | 原生状态                                         |
| ------ | ------------------------------------------------ |
| 待执行 | triage、backlog、todo、scheduled、ready          |
| 执行中 | running；存在 running execution 时优先显示在此列 |
| 需处理 | review、blocked                                  |
| 已完成 | done                                             |

新建任务默认 todo；编辑描述保留原生状态。详情提供“确认完成”和“放回待执行”，
取消任意状态拖放和九状态选择器，执行中任务必须先停止。已排期任务保留原生时间约束；
没有具体时间的旧 scheduled 卡片允许重新加入待执行。

单任务启动继续调用 `workboard.cards.start`。已结束的历史 session 关联不阻止重做；
活动 execution、claim、独立 task 仍限制启动。批量启动先为可执行卡片补默认助手，
将无未来排期、无前置依赖的 todo/backlog 卡片以 `expectedUpdatedAt` 转为 ready，再调用
原生 dispatch；依赖、时间和 owner 并发容量仍由上游检查。停止操作确认 task/session
已停止后，以版本校验更新 blocked、释放 claim，并清除已停止的独立 task 关联，保留会话历史。
手动状态操作从 Renderer 传入所见卡片版本，Main 再读当前卡片并拒绝活动执行或过期版本，
原生写入继续携带同一版本，避免旧的验收操作覆盖新结果。停止后的对账重新读取卡片，
校验 session/run/task 身份；只对已确认停止的同一次执行释放占用，保留已经到达的完成或审核状态。
已知 runId 的定向停止失败时，不降级为整个 session 的停止，避免误停后来启动的任务。

接口核对与可复现验证见 [Workboard 操作契约](../features/workboard.md)。
