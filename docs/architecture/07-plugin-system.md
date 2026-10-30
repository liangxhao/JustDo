# 插件系统：读取、变更与原生应用

插件管理不是一份安装目录清单。用户配置、文件提交、原生配置应用和当前 Gateway inventory 是不同事实，必须分别确认。本页按读取和变更的调用链组织；桌面 Main/Browser 代码的公开 SDK、审核与加载另见[应用插件宿主](17-app-plugin-host.md)。

## 1. 分类与源码所有权

| 类型        | 运行权威                          | 产品负责                              | 主要限制                                   |
| ----------- | --------------------------------- | ------------------------------------- | ------------------------------------------ |
| Skill       | Gateway skills.status/update      | 用户文件导入删除、列表投影            | 文件存在不等于 eligible                    |
| MCP         | 原生连接与工具调用                | 用户配置 Store、发现与配置同步、probe | 扩展默认定义只读，覆盖留在原生配置         |
| Hook        | 原生 hook runtime                 | 本地包、产品开关和受管同步            | 与 Extension 的 hook capability 不混为一项 |
| Extension   | plugins.list/setEnabled/uninstall | 审查、受控导入、产品保护规则          | 运行代码进入 Gateway 信任域                |
| Marketplace | 各类型安装器及 inventory          | 公司 SDK 适配、来源/版本身份          | 不是另一份运行态清单                       |

Plugin Hub 有四类插件概念；市场当前只开放 extension、skill、mcp 三种 catalog kind。共享 PluginKind 中有 hook，不代表 Marketplace 也支持安装 Hook。仓库默认未注册业务市场 provider。

### 源码和构建归属

内置插件源码统一位于仓库根目录的 `plugins/`，按 `extensions/`、`skills/`、`mcp-servers/`、`hooks/`、`browser-extensions/` 分类。OpenClaw 扩展位于 `plugins/extensions/<plugin-id>/`，独立技能及筛选清单位于 `plugins/skills/`；扩展自带的技能保留在所属扩展内部。`mcp-servers/`、`hooks/` 当前仅预留目录，尚无内置加载逻辑。

构建仍将 OpenClaw 扩展和选中技能组装到原生的 `dist/extensions/`、`skills/`、`custodian-skills/`，开发源码发现读取对应扩展目录。图标、文档模板和运行时准备缓存继续由 `resources/` 管理。目录约定见[内置插件说明](../../plugins/README.md)。

`plugins/sdk/` 保存公开 App SDK 和构建工具开发包，使用 npm workspace 或打包制品接入；扩展发现仍只扫描 `plugins/extensions/`。源码位置、发布和消费契约见[应用插件宿主](17-app-plugin-host.md)。

Browser Assistant 位于 `plugins/browser-extensions/browser-assistant/`，由 Chrome 安装和加载，不进入 Plugin Hub 的 OpenClaw 扩展管理。它保留上游基线及产品侧栏补充，自有组装脚本、Markdown 源码和单元测试随包维护；复用应用聊天代码的构建适配与 Native Messaging helper 留在宿主，Main 继续拥有连接、权限和会话。

构建生成 `build/browser-extension/chrome-extension/`，安装路径沿用 `resources/browser-extension/chrome-extension/`，显示名称和固定扩展身份独立于源码包目录。详见[侧栏对话](../features/browser/browser-extension-side-chat.md)。

插件专属的工具、界面、资源、构建/校验脚本和单元测试归 `plugins/extensions/<plugin-id>/` 所有。主工程保留通用 MCP Apps 宿主、权限与保存桥、配置/打包接入，以及验证宿主边界的集成测试；插件不能反向导入应用 `src`。根 npm 命令和打包流程只委托插件自己的脚本，draw.io 的目录约定见[插件说明](../../plugins/extensions/drawio/README.md)。

## 2. 清单读取与界面投影

读取只观察当前权威状态，不因列出卡片而安装、启用或重启运行时。配置 `enabled` 和当前运行态分别显示。

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

### 查询队列和旧响应

扩展清单查询先等待此前应用设置的保存与失败补偿完成，随后释放配置队列再等待
Gateway 和原生清单发现。慢速列举不能阻塞后续 `app_config` 读取或偏好保存，否则
普通启动中先挂载的扩展订阅会让 Renderer 配置初始化耗尽自己的 30 秒预算。
在途读取只共享原生发现结果；最终本地配置和受管能力在短配置队列内重新读取，
因此发现期间发起的设置保存或失败补偿也必须完成后才能展示。已持有该队列的
变更通知直接投影，不嵌套排队，也不与外部查询共享配置投影。
TypeSafe 的实际配置和启停变更继续在应用配置队列内串行执行；配置读取仍等待
此前变更应用或回滚，不绕过事务读取未确认的设置。

页面展示清单还需要隔离迟到响应。Extension 页进入和收到已有变更通知时重新查询，只有当前挂载页面的最新查询可以更新列表或提示错误；卸载后回包失效。成功清单同时替换已打开的扩展详情，条目消失时关闭详情。Skill 与 Hook 页也订阅父扩展变更，强制重读附带能力，Hook 更新或关闭已打开的详情。用户 MCP 的查询与操作回包、Hook 的导入/删除/启停回包使用 Renderer 查询代次保护，操作成功使旧查询失效；操作回包跨越新代次时重读权威清单，避免旧全量结果覆盖后续修改。

MCP 保存、删除、启停和市场更新在提交前使已有测试结果与在途测试代次失效，迟到测试不能附到新配置。普通 MCP 清单来自产品 Store，目录 Hook 的原生状态每次重新发现；它们没有技能发现缓存的同一刷新限制，不增加对应的运行时补丁。后台运行态应用与界面列表更新是不同的完成条件。扩展提供的 MCP 清单错误独立保存，自建 MCP 的成功操作不会清除该错误；只有提供方清单实际读取成功才清除，重读期间也不误报空列表。

生产扩展目录读取也必须只观察现有 Gateway：固定客户端、进程及代次，不调用自动启动/恢复入口，也不以读取为由执行 `plugins.refresh`。无连接或读取失败明确返回不可用，不能用仅含用户安装目录的局部清单覆盖内置卡片或广播伪造的禁用状态。页面和共享启用状态保留最近确认的清单；仅在读取不可用时，通过应用插件就绪通知补读，已有请求代次与卸载保护继续生效。因此热启停的收尾通知及界面重读也不会间接触发 Gateway 重启。

输入框功能入口通过 `extensions:changed` 观察实际启用状态。Main 在启停尝试完成后
串行重读权威目录并通知全部仍存在的窗口；已保存但运行时重启失败时也发出实际
状态，不用请求值假定成功。导入/市场安装和卸载同步通知；通知读取失败保留操作
结果且不伪造状态。Renderer 按插件合并在途开关，关闭版本使快速关闭/开启后的
旧标签选择失效。详见[输入框功能菜单](../features/chat/composer-feature-menu.md)。

### 分组、排序与管理权限

插件页的扩展、技能、MCP 和 Hook 在用户安装与系统内置分组内使用固定 `zh-CN`
名称排序，忽略大小写并按数字自然排序；名称等价时以精确 ID 升序打破平局，
不依赖原生发现顺序或当前界面语言。用户 MCP 与用户扩展提供的 MCP 合并后排序。
系统内置扩展仍按当前开关权限将可手动切换项放在加锁项前，各类内部使用同一名称排序。
锁定图标的提示及详情展示管理来源：模型、视频、决策模型、浏览器、电脑操控、运行参数、
执行模式或应用基础组件。

Renderer 根据 Main 返回的管理权限解释来源，不按插件名称自行限制操作。
Main 在扩展目录清单中为原生 `bundled` 条目补齐实际存在的随包目录，复用 `installPath` 和 `revealInFolder` 能力提供文件夹入口；该只读入口不改变系统托管的启停、配置或删除权限，也不保存另一份目录配置。

OpenAI Provider 和 QuickJS Code Mode 是应用托管适配器，通用插件入口禁止启停、配置和删除；
完整、最小及登录状态同步均保持已打包适配器启用、加入 allowlist，并移除这两个插件的 deny，
保留其他配置和权限。模型、图像及语音功能仍由各自设置与凭据控制；Code Mode 是否使用由运行参数控制。

Document Extraction 和 Web Readability Extraction 保持上游默认启用，允许用户关闭；
协作、记忆和本地语音可选插件继续保留用户明确禁用状态。TypeSafe 仅在决策模型设置具有有效默认选择时托管；
没有默认选择时，扩展页可手动配置和启停，后续同步保留这些原生设置。取消默认保留扩展当前配置和开关，
只撤销此前确切投影的原生默认引用，不按模型名称推测来源。首次接管失败通过显式回滚上下文恢复最新手动快照。

TypeSafe 配置、启停及扩展清单读取与应用设置事务同序，等待保存或补偿完成后再检查管理权限。
视频由同一个 OpenAI 适配器提供；清空默认视频模型只停止视频使用，不关闭整个插件。

## 3. 变更调用链与完成证据

```mermaid
flowchart LR
  Input[用户意图 / 安装输入] --> Check[格式 / 路径 / 能力审查]
  Check --> Commit[本地或原生持久提交]
  Commit --> Apply[reload / 必需 restart]
  Apply --> Confirm[只读确认 inventory]
  Confirm --> UI[刷新清单和消费者]
  Commit -->|提交已确认但应用失败| Partial[保留 installationCommitted]
  Apply -->|请求已发且回执缺失| Unknown[保留 unknown / 源占用]
```

一次写操作按以下顺序推进：准备输入 → 校验文件/能力 → 持久提交 → 原生应用 → 只读确认 → 刷新消费者。已提交但应用失败、已发送但结果未知必须与未提交区分。

### 进度和失败反馈

插件变更的等待包含安装源准备、文件校验与发布、全局配置队列、原生应用或重启、
状态确认和清单刷新；它们有不同的完成证据，不能通过提前返回成功来缩短等待。
扩展完整清单还可能解析本地 manifest、启动只读包归属子进程，因此通知和页面并发
查询会重复消耗资源。Main 只合并同一变更代次的在途扩展清单读取，变更开始和结束
使旧读取失效；不保存已完成清单，不跨变更复用结果。

Hook 变更前后的权限、目录和
身份核对直接读取 `hooks.status`，仅最终展示清单查询父扩展来源，减少无消费的
`plugins.list`。Renderer 市场对账和更新检查只随相关身份、版本、路径或显式刷新
变化，不因普通开关和数组引用变化重复调用市场接口。

变更 IPC 可在最后传入有界 `PluginOperationContext.requestId`，Main 以
`plugins:operation:progress` 仅向原请求窗口发布闭合的 kind、action、stage 和
elapsedMs。阶段在实际开始执行时报告，排队等待保持 queued；事件不携带路径、
凭据、SDK 输出或插件正文，也不授予权限或确认结果。Main 记录各阶段耗时到
`[PluginOperations]`，用于区分队列、原生应用、确认和下载适配器的实际耗时。
窗口销毁、进度发送或观察失败不能改变变更结果；结束后忽略迟到回调。

Renderer 在调用前登记操作并订阅，在完整操作及清单刷新结束后释放；只接纳同一
requestId、kind 和 action 的通知。这个会话内 owner 仅持有操作元数据，切换分类
或离页不释放在途变更，重新进入页面可继续展示。计时只更新已用时，不推进阶段
或生成百分比；最终成功、失败、已提交和待确认仍取自原调用及权威清单。

变更响应通过 `PluginOperationFeedback` 补充失败处冻结的 `failedStage`，以及确有
证据的 `installationCommitted`、`installSourceInUse`、`operationUnconfirmed`
或 `refreshWarning`。失败阶段在补偿回滚、清理和最终刷新之前记录，后续进度不能
覆盖原业务失败；后置清单读取失败也不能反向否定已经完成的文件或配置变更。
Renderer 不从错误关键词或最后一条进度推测提交和未知状态。

同一个操作 owner 分开保存活动进度与有界失败队列。服务在收到失败响应或异常时
显式登记错误，待本次收尾结束才入队；同一请求不重复入队，页面的 mounted/代次
检查仅限制清单写入，不能吞掉后台失败。Plugin Hub 根组件统一展示队首结果，
切换分类或重新进入插件页仍可看到未关闭的错误。批量导入由调用方汇总一次，
保留每项真实阶段和已提交/待确认提示。关闭结果只移除展示记录，不解除市场版本
锁或重新提交变更；错误详情按既有敏感字段规则脱敏并限制大小。

MCP 操作将相同 requestId 显式透传到配置同步的 start/done 广播；界面仅在精确
匹配时交由该操作的最终结果弹窗负责，避免同步失败和操作失败重复弹出。没有关联
ID 的后台同步继续保留原错误提醒，不根据“当前有某个 MCP 操作”猜测归属。

市场安装调用没有收到结果回执时也保留待确认保护，并先尝试只读对账。普通列表
刷新或同目录 manifest 出现不证明未知原生命令已经终结，因此不能据此释放重复
提交保护；这类保护在当前 Renderer 会话内保留，不随报错关闭或反馈记录裁剪释放。

市场 Provider 的 `prepareInstall` 默认整体显示“获取插件信息并下载安装包”。
适配器可通过可选 context 回调报告真实的闭合阶段，不提供细分回调时不会假定
下载进度、转换步骤或文件大小。类型安装器的已有阶段继续向上透传；来源释放时
才报告临时资源清理，原生仍可能读取的来源继续保留。

首次市场安装显式落实启用
意图，Skill 按原生有效来源和精确安装目录取得实际 skillKey 后开启并确认；
Extension 仅在原生安装后仍显式关闭时补原生开启，不跳过必需配置校验；
首次安装因缺配置被关闭也明确返回已安装但无法启用，不能静默报告全部成功。
MCP 首次创建保持启用。市场升级保留已有开关；已安装但后续启用失败继续携带
installationCommitted，不能作为未安装再次提交。

## 4. Skill：身份、文件与状态确认

内置 manifest 有 8 个默认启用项：data-analysis、diagram-design、frontend-design、docx、pdf、pptx、skill-creator、xlsx。v2 manifest 通过 `openclaw.skills` 和 `openclaw.custodianSkills` 显式选择上游技能：分别保留 `coding-agent` 和 `diagnose-gateway`，其余上游技能不打包。

系统维护技能留在原生 `custodian-skills/`，仅由系统 Agent（应用配置为 `main`）发现。安装和打包共用同一筛选逻辑，所有选中源校验通过后才清理目录；缺失上游技能时必须从锁定的原始包重建运行时，不能静默跳过。打包资源必须与 manifest 一致；数量不应散落在 UI 常量中。

独立技能保留上游正文及配套资源，仅调整实际宿主与内网约束。manifest 的 `upstream` 字段记录维护基线，不参与原生状态判断；具体来源和适配见[内置 Skill](../features/plugins/bundled-skills.md)。Python 可选依赖只使用已配置的内网源或离线 wheel，不要求安装外部系统应用。绘图 HTML/SVG 默认使用本地字体，PNG 通过已安装的 Edge 离线导出；未执行的渲染、重算和视觉检查不得报告为已通过。

技能列表和详情使用 Gateway 状态，详情提供有权限的启用／关闭入口，并在更新后显示最新状态与缺失依赖。若原生技能要求显式开启自身的 `skills.entries.<skillKey>.enabled`（如 `coding-agent`），Main 在该条件缺失时显示未启用，即使原生 `disabled` 为 false；其他缺失依赖只影响可用性，不改变启用状态。

用户启用仍通过原生 `skills.update` 保存，系统预装与普通导入不为绕过原生 opt-in 要求默认开启；市场首次安装按明确安装意图通过同一原生接口开启，仍保留全部依赖校验。
该开关同样适用于 `plugin-skills` 中由扩展提供的技能：只更新原生 `skills.entries.<skillKey>.enabled` 并回读确认，不写产品 Store，也不修改扩展文件；其删除和文件配置权限仍由父扩展保留。扩展 Hook 则受原生策略限制，仍以父扩展为启停 owner。

Renderer 的缺失依赖徽标和详情提示不重复列出该技能自身的启用条件，由开关表示；其余程序、环境变量、配置和系统要求保持原生结果。原生 `missing.anyBins` 表示任选一种工具即可满足的要求，计为一个缺失依赖组，列表提示和详情明确说明“至少安装一个”；开启技能不会清除该依赖提示。原始 Gateway 状态不受展示过滤影响。

TypeSafe 扩展声明决策模型提供方；原生 `decision_evaluate` 工具按 Agent 的 `decisionModel` 自动提供。9.8 不再注册专用评估工具或 skill，Boolean、Choice、Score 输入由提供方翻译。具体接入见 [Jev evaluations](../features/models/jev-integration.md)。

内网发行版通过 `plugins/extensions/prune-policy.json` 声明当前 OpenClaw 版本内置扩展的保留和移除清单，排除 Anthropic、ElevenLabs、
GitHub、Kie、Z.AI 和 Novita 插件；运行时资源准备与安装包构建共用该剪裁策略。

同一策略裁剪 `admin-http-rpc` 和 `file-transfer`：应用管理通过 Gateway WebSocket RPC，
没有接入额外的 HTTP 管理端点、已配对节点的文件传输或远程工作空间映射。
本地附件与文件操作使用既有能力；全局工具策略继续禁用 `file_fetch`、`dir_list`、
`dir_fetch`、`file_write`，避免用户另行安装插件后意外开放未接入的远程能力。

保留 OpenAI 插件作为内网兼容接口的协议适配器，在线语音设置显式提交内网服务地址、
模型及凭据；保留插件不代表必须连接 OpenAI 公网。实时识别需要兼容 Realtime
Transcription（PCMU 8 kHz），朗读需要兼容 Audio Speech。模型目录仍由用户配置，
不会以插件内置模型元数据填充语音设置。ElevenLabs 不再列入受管语音提供方。

视频服务由本地 `plugins/extensions/openai` 注册 `video-openai` provider，
由同一插件的完整替换、预编译和裁剪保护流程打包。设置页保存后由 Main
配置同步器投影 `agents.defaults.mediaModels.video`；模型 ID 和基础地址由用户填写。

`models.providers.video-openai` 独立于聊天和图像配置；非空 API Key 写入受限的
`extension-secrets.json`，通过 file SecretRef 引用；空 Key 不发布凭据引用。
原生 `video_generate` 工具负责权限、参考图片读取和结果交付，插件只实现 multipart
提交、状态轮询和视频内容下载。

三阶段共用总超时与原生有界响应读取；使用配置地址和
HTTP 策略、允许显式配置的私有网络地址、拒绝重定向和不确定提交的重试，没有公网地址或凭据回退。

视频设置只支持本地 OpenAI 适配器；Kie、Z.AI、Novita 的目录和配置支持已移除，
安装对应插件也不会加入视频选项。配置同步按 OpenAI 插件库存清除缺失的视频选择，
不写入对应新凭据。
完整和最小同步遵循相同规则。新视频插件通过原生 provider 扩展接入，不恢复 9.6
旧自定义视频配置或迁移。具体协议与输入限制见 [模型管理](../features/models/model-management.md)。

skills.status 提供 effective source、eligibility、disabled、缺失依赖和安装选项。产品文件服务只管理用户导入目录；它不能从 SKILL.md 自行重建运行元数据。受管根使用原生 stateDir/skills，避免重复 extraDirs 引入同一路径。

同名技能遵循原生解析赢家。关闭赢家不等于自动切换到下一来源；赢家目录删除后的 fallback 是另一种变化。没有原生 variants contract 时，UI 不展示臆测的 shadowed 数量或逐来源 toggle。

Extension 发布技能的 scope 表示父插件管理，ownershipScope 表示产品展示归属；两者不能合并推导删除能力。系统内置与用户 Extension 的技能均可能由父插件托管。

### 用户文件变更

导入验证结构与精确目标，复制到受管根。删除先原子移入同卷 `.justdo-skill-trash/delete-*`，避免递归删除中途留下半残 live skill。机会式清理仅处理已知 trash 子目录，不能扫描删除未知项目。

技能导入、同名覆盖更新与删除保持 Gateway 运行；文件服务显式关闭 ManagedDirectoryOperationCoordinator 的 runtime 停启恢复，只保留串行变更与文件锁诊断。Windows Gateway 启动环境使用原生支持的 `CHOKIDAR_USEPOLLING=true`，避免长期目录句柄阻止原子重命名；移除继承的轮询间隔，由各原生监听器采用自己的默认值：技能目录为 30 秒，配置文件为 100 毫秒。

不能用统一的短间隔反复扫描所有技能目录，否则会持续占用事件循环并拖慢历史加载和页面请求。外部技能文件变化通常在下一次目录轮询后发现，繁忙、扫描和文件稳定性检查可能延后；技能清单和实际执行仍由原生 API 及准入校验决定。该设置传给 Gateway 及其 worker，不修改应用或 CLI 的基础环境；其他平台保留原生监听方式。外部程序占用或权限问题按真实失败提示，不停止 Gateway 或杀进程。

删除后重新查询原生技能清单，成功弹窗明确显示“已删除”。技能消失是删除的预期结果；只有同名技能实际解析到另一个来源时，才追加来源变化说明。批量导入只要有成功项就刷新清单，部分失败弹窗保留成功、失败数量与逐项原因。

技能文件删除已提交后，原生清单刷新失败不会改报删除失败。Main 仅从本次操作前的原生清单投影中移除确切匹配 key、来源和目录的已删除条目，保留其他原生元数据；不缓存清单或猜测同名回退，后续查询仍以原生清单为准。

文件变更之后的首次 `skills.status` 可能仍命中原生发现缓存；原生监听还要经过轮询、文件稳定检查和 debounce，`skills.changed` 通知会随 remote-bin-refresh 延后。直接使用标准 `skills.status` 和原生文件监听，允许发现结果短暂延迟，在页面订阅期间对成功导入、市场安装/更新和删除进行最多 5 次、约 5 秒窗口的自动重读，连续操作合并、离页停止；不再通过补丁扩展刷新参数，不将目录存在或普通查询成功当作同目录覆盖已被原生重新解析的证明。

Renderer 用查询代次隔离旧响应，避免操作前的在途请求覆盖新结果。首次查询失败或断线后，只要页面仍订阅清单，每 3 秒通过现有连接重读；实际查询成功或离页后停止，不以引擎 running 代替 RPC 就绪、不启动 Gateway，也不重放失败的开关修改。变更重读和失败恢复共享在途请求，避免重复并发。

Main 的文件变更串行队列同时覆盖操作后的原生清单查询，供不同窗口和市场安装共用；文件服务自身的配置/目录锁仍独立，不嵌套同一锁。Renderer 的删除/启停回包如果跨越了更新的查询代次，也会重读当前原生清单，避免迟到的全量旧清单覆盖新版。

### 技能工坊：当前技能、版本与变更

学习直接使用现有聊天中的原生 `/learn`，遵循原生工具能力、会话权限与技能配置。
技能页的“技能工坊”入口仅在打开后读取主助手（main）的工坊；关闭后不发后台请求。
`openclaw-workshop` 来源仍展示为助手提炼技能，不走导入目录删除逻辑。

OpenClaw 2026.10.7 的技能变更立即生效；旧 `skills.proposals.*` 虽仍在方法目录中，
handler 已固定返回退役错误。应用完整采用 `skills.workshop.list/changes/read/archive/restore`，
不把旧批准/拒绝按钮伪映射为归档/恢复，也不在 Main 建立技能文件、版本或变更账本。

随包 `skill-creator` 遵循当前 `skill_workshop` 的原生 authoring owner 与实际 schema：
普通 Workshop 修改立即生效并保留可恢复版本，个人库能力仅在实际提供时按技能 ID、
revision 和当前用户授权发布。技能正文不创建待审核提案或要求额外人工 apply，
也不直接改写已安装技能目录。

```mermaid
sequenceDiagram
  participant C as 现有聊天
  participant U as 技能工坊弹窗
  participant M as Main / SkillWorkshopService
  participant G as OpenClaw
  C->>G: 用户发起 /learn
  G-->>C: 学习进展与实际变更
  U->>M: 读取 main 当前技能、保存版本、最近变更
  M->>G: skills.workshop.list / changes
  U->>M: 查看当前或选定版本的完整文件
  M->>G: skills.workshop.read（name/filePath/versionId）
  U->>M: 确认归档或恢复明确选定版本
  M->>G: skills.workshop.archive / restore（仅一次）
  G-->>M: 原生 change 回执
  M-->>U: 确认或未确认结果
  U->>M: 只读刷新原生工坊与有效技能清单
```

界面分别展示当前技能、已保存版本和最近最多 200 条变更。原生 `archived[].live:true`
表示该技能仍有当前副本且保留历史，不能标成已归档；`live:false` 才表示没有当前副本。
版本/当前副本都支持读取 `SKILL.md` 与完整支持文件。变更的 `versionId` 指向**该次变更前**
的快照，可用于撤销；restore 回执的备份 ID 不等于用户选定的恢复目标。
原生 changes 只有排他时间戳 `beforeMs`，没有完整分页 cursor，本界面不宣称展示全部历史。

归档先显示用途及可恢复提示，并允许填写原因；恢复必须查看并明确选择具体版本，再确认替换当前副本。
原生没有 `expectedRevisionHash` 前置条件，界面明确说明其他任务也可能修改技能；
归档作用于执行时的当前副本，恢复前由原生保存当前副本，应用不伪造 CAS。
读取需要 `operator.read`，归档/恢复需要 `operator.admin`；Main 固定 main 归属、校验文件/版本参数，
序列化同一技能的变更并检查原生回执 agent/name/action。

原生文件发布与变更记录可能在不同阶段失败。包括 `INVALID_REQUEST` 在内的未确认写入，
均保留“可能已生效”提示，不自动重试、不反向补偿；清除详情后只读刷新，要求用户重新核对和选择。
即使原生变更成功、产品技能列表刷新失败，也分别显示已确认变更和刷新失败，不提示重复提交。
写入期间禁用关闭；异步读取带本地 generation，刷新/卸载使迟到内容失效，不保存转录副本。

验证分层：service/UI 行为测试覆盖当前/历史区分、支持文件、显式恢复、单次写入、未知结果和迟到读取；
`management-protocol-native.test.ts` 直接执行目标 TypeBox schema、scope 目录及退役 handler，
避免旧 proposal mock 掩盖原生实变。真实企业内网模型学习、Electron 窗口和安装版文件操作另行验收。

### 保存后确认与页面恢复

Skill 的 `skills.update` 回执确认配置已保存，原生运行态配置仍可能异步发布。Main 将启停和导入/删除放入同一操作队列；保存只执行一次，随后通过现有 `skills.status` 有界确认目标开关状态（含显式 opt-in），匹配后才返回完整原生清单。确认只读取已有 Gateway 客户端，等待客户端自身重连，不进入启动/健康恢复路径；30 秒内对旧状态和短暂断线/读取超时自动退避重读，单次查询限时 5 秒并用原生取消信号清理在途请求。

市场安装文件后先按精确来源和目录等待原生发现，最长 45 秒以覆盖 Windows 的 30 秒目录轮询；取得真实 skillKey 后首次安装才落实开启意图，升级只确认身份并保留开关。不能把同目录发现缓存解释为新正文已重新解析。等待期间卡片保持忙碌，避免第二次点击重复提交；缺依赖的 `eligible` 不作为开关成功条件。只有最终无法确认或原生永久拒绝时提示状态暂时无法同步，不要求用户手动刷新，不返回旧状态作为成功结果。此流程无需新增运行时补丁或重启 Gateway。

Renderer 技能服务保留在途开关，同一技能的相同意图复用请求，反向意图按顺序执行；页面重入读取等待在途操作结束。清单服务在最终返回时、页面在消费结果时分别检查代次，离页后的操作不再更新该页面。补充读取失败保留最近确认的清单，不因一次读取失败清空卡片或推断技能不可用；迟到失败不覆盖较新清单的连接状态。

技能页首次挂载与父扩展变更均复用同一后台清单刷新器，覆盖离页期间错过的变更通知。刷新窗口为 45 秒，以容纳 Windows 原生技能树的 30 秒轮询；读取间隔逐步退避到 5 秒，不调整原生扫描频率，也不重复安装。确认删除的路径在同一窗口内屏蔽旧缓存，首次权威缺席或明确的同路径重新导入可提前解除。断线恢复后若清单仍旧，只继续原窗口剩余时间；最后一个订阅者离页时取消定时器，迟到响应仍受查询代次约束。

## 5. MCP 与 Hook：配置及文件事务

### MCP 配置和原生发现

用户 MCP 保存在 mcp_servers。新增、改名、删除和启停通过串行配置同步生成原生 mcp.servers；原生新增的 server 可在列表刷新和非 MCP mutation 同步前导入缺失 name。

受管配置固定写入 `commands.mcp: false`，关闭聊天中的 `/mcp show|get|set|unset` 配置管理命令；此开关不禁用 MCP server 连接、工具调用或插件页的 MCP 管理功能。

新增、更新、删除与启停等待受管配置应用完成再返回成功；同步失败恢复原记录（包括原 ID、时间戳和未建模的原生字段）并补偿同步。记录变更、原生应用、补偿、列表发现与手动同步都持有全局配置队列；队列上下文提供直接同步入口，避免嵌套排队死锁，也阻止其他设置同步在删除或改名尚未应用时从旧配置复活记录。MCP／Hook 同步服务为每次请求排队执行，不能将后续变更并入已经读取旧状态的在途同步；无错误文本的失败回执也必须返回失败。

Extension 提供的 MCP 通过受管子进程直接调用原生 manifest registry、MCP 支持检查及有效配置加载器发现，同时支持 bundle 和原生 openclaw 格式；不加载扩展入口或完整插件 CLI。列表展示有效启用状态，并按父扩展 origin 分组：bundled 属于系统内置，用户导入的扩展属于用户安装。展示分组不改变管理权限；扩展默认定义不写入用户 MCP Store。插件页面预取清单，Renderer 保存可刷新展示快照并合并并发读取；扩展变更通知使快照失效，过期响应不能覆盖新清单。初次读取完成前显示加载状态，不提前显示未安装。

扩展 MCP 的独立开关直接使用原生 `mcp.servers.<name>`，不另存 SQLite、KV 或覆盖文件。Main 在全局配置队列内重新核对完整扩展/server 身份、当前原生归属、同名用户记录及应用受管保护，使用 Gateway `config.get` 的版本经 `config.patch` 仅切换选中条目的启用状态，并沿现有配置应用确认流程回读清单。默认连接关闭写入禁用标记，恢复开启移除该标记；已有完整覆盖保留连接定义，仅切换其开关。未知写入结果不自动重试或反向补偿。

配置同步前读取原生扩展 MCP 名称归属，完整、最小及登录状态同步保留这些原生覆盖，外部 MCP 发现排除这些名称，避免将覆盖导入产品 Store。归属读取失败保留现有配置并报告失败，不能按空清单重建。参数窗口整页只读，Main 的配置能力固定禁止，不注册任意参数保存 IPC，也不提供对应 preload/Renderer 方法；保留独立启停、只读查看和测试，不改变既有原生覆盖。窗口读取选中条目的完整原生定义，只有禁用标记时也加载父扩展默认连接；常用字段与下方完整原始 JSON 均不可修改。

已有连接覆盖优先读取 Gateway sourceConfig，默认定义经原生 schema/redactConfigObject 脱敏后返回 Renderer；没有完整定义时保留原生摘要，不从摘要重建配置。此查看流程不写配置，不增加第二份运行清单或凭据持久化。

MCP 的传输支持状态使用原生清单的 `unsupported` 标记；`hasStdioTransport: false` 也可能表示受支持的 HTTP 传输，不能据此标记为不支持。

交互界面是工具的附加能力，仍使用相同 MCP 清单和启停流程。连接测试保留标准 `ui://` 资源元数据，列表显示紧凑的界面标识；不因名称、transport 或 resources 能力推断。内置 draw.io 的已审查提示在连接定义被覆盖后撤回，实际工具目录优先。其 stdio 服务、Web 编辑器、只读 loopback 资源和完整离线打包契约见 [draw.io 离线绘图](../features/chat/drawio-offline.md)。

发现只增加缺失项，不因原生配置暂时缺失就删除产品记录。产品主动删除/改名后不能先读旧原生配置，否则会复活旧 name。未被表单建模的 cwd、OAuth、TLS、tool filter 等字段需要保留合并，不能保存一次表单就丢失。

请求 timeout 按单 server override 优先于全局默认投影为 requestTimeoutMs；连接建立 timeout 是另一概念。Extension 自带 MCP 的配置由父插件拥有，不套用户 server 的默认设置。

probe/readResource 在 Main 使用真实 transport。HTTP/SSE probe 保持流式响应、禁止自动重定向并使用网络策略；stdio command/env 属于执行输入，敏感值不能进入 UI 诊断或日志。

Extension MCP 卡片提供参数、单项测试和全部测试入口。手动测试与 MCP 自动启用开关独立，关闭的条目也纳入测试。Main 按完整扩展/server ID 重新读取原生配置并核对归属，只连接所选 server；错误归属、不受支持或无法取得当前归属的父扩展默认定义不能启动 transport。配置优先使用原生 merged MCP 定义；被禁用过滤时，完整原生连接覆盖仍优先，仅有禁用标记则读取原生加载器解析的父扩展默认定义，不拼接另一份配置。

测试与资源读取将所选定义交给独立的原生 session MCP runtime，保留路径、cwd、认证和工具筛选语义，并在完成后等待连接清理；保存的 MCP 与父插件开关不变，不写配置文件、Store 或 KV。启用开关仍决定正常运行时的自动接入，手动测试结果不能代替该状态。UI 只接收原生脱敏连接摘要、统一原生脱敏错误与能力元数据，不接收 env、headers 或原始连接配置；测试不调用工具。

扩展变更使清单、测试和资源读取的旧回应失效；加载失败不声明空清单，搜索与重复测试期间仍显示不受减少动画设置影响的旋转指示。

### Hook 发布与清理

独立 Hook 包包含 HOOK.md 和受支持入口，导入支持限定压缩格式。ID 和路径先规范化，内置与已有目标不能普通覆盖。bundle 环境通过 OPENCLAW_BUNDLED_HOOKS_DIR 指向实际产物。

导入与启停、删除使用同一串行变更队列，并在全局配置队列内完成文件、记录与运行时应用。复制后从 Gateway 清单按安装目录取得原生 hookKey，将启用状态写入 Store，再等待受管配置同步和原生 `plugins.refresh` 的运行时完成回执后返回成功；显式刷新也覆盖配置未改变的重新导入。新发现的 managed Hook 在 `hooks.status` 中默认启用，并不代表执行器已选择加载。同步或刷新失败时移除本次导入目录、恢复原记录并补偿同步及运行时刷新，回滚不完整必须明确报告。成功后的清单刷新失败不撤销已完成的导入。

独立 Hook 的启停只投影到各自 `entries`。非空列表保持原生 internal 总开关启用，避免误停扩展的 legacy Hook；空列表移除受管 internal 配置，同时保留独立的 webhook 设置，包括未配置模型的最小配置路径。

插件附带 Hook 以 `hooks.status` 为清单权威，以 `plugins.list` 的父扩展 origin 补充展示分组；用户扩展附带项进入用户安装区，bundled 父扩展附带项进入系统内置区。父扩展清单暂不可读时仍保留 Hook 展示和管理锁，不能因来源读取失败隐去 Hook，也不能把“由插件管理”等同于“系统内置”。

删除先隔离目录，再修改 Store 和同步配置；同步失败恢复记录与目录，成功后清理隔离区。SQLite transaction 只保护本地行，无法回滚原生 reload，必须保留跨边界补偿语义。

删除已提交后的 `hooks.status` 刷新失败不会把成功改成失败。Renderer 在这种情况下只从已有列表移除该确切已删除 ID，保留其他条目的原生元数据；后续查询仍以 Gateway 清单为准，避免成功提示后仍展示旧 Hook。

### 链接复制的类型差异

Main 的 Skill 文件夹复制同样为绝对目标目录链接保留 junction，不解引用目标内容；结构化 `errorSyscall` 参与错误分类，内层链接创建错误优先于外层通用 EPERM。Hook 包继续拒绝符号链接，复制与校验在独立 `.hook-stage-` 目录完成，核对相同 Hook 身份和 handler 后原子发布；复制失败不留下可被发现的半成品，也不会删除另一个已安装 Hook。新安装发布拒绝覆盖晚到的同名目录，不清理其他并行安装的暂存目录。

## 6. Extension：审核、提交与未知结果

### 能力审核与安装

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

原生 openclaw.plugin.json 包交由原生安装器验证，运行入口须符合原生编译格式。
其他格式在提交安装前明确拒绝，提示当前 `productName` 的扩展格式要求、原生
manifest 和运行入口，不再提示尚未实现的转换。文件名、显示名称及合法的内外部
路径含中文或空格本身不构成格式错误。CLI 输出和 timeout 有界，失败不伪造
runtime id。临时资源按来源与原生阶段清理：未提交或已确认结束才释放需要原生
读取的隔离副本，原生安装已发起且结果不明时保留该副本，先查 inventory，不重放安装。

本地 Extension 的交互式能力审查由 Main 展示，确认后通过 `plugins.install` 将同一 `reviewToken` 交给 v2026.10.7 原生 staging 在提交前核验。不能用 CLI `--accept-capabilities` 代替已确认令牌，否则审查后改变的能力面会被无条件接受。安装 RPC 使用原 CLI 的 10 分钟等待窗口；确认原生提交及运行时代次回执后收敛出站策略和重启要求，超时不回退或重复安装。原生返回持久提交错误时保留提交事实；能力面变化则重新展示审查。可信市场及没有交互式审查的冷 CLI 安装保留现有路径。

本地扩展安装及更新直接使用原生接口，不新增 staging copy 补丁。Windows 文件夹导入仅在 `node_modules/openclaw` 为指向当前 CLI 运行时的绝对目录链接、包声明对应宿主依赖和原生入口、其余目录为真实目录且文件无额外硬链接时，异步生成一次性隔离副本并省略该宿主链接。原生安装器仍执行安全扫描、能力确认与发布，并重建宿主 junction。复制按已检查的文件身份读取，前后及全树成员变化会失败并清理；未知链接和其他输入原样交给原生处理，用户原目录不修改。

能力确认和安装使用同一副本；能力确认返回、尚未发起安装或确认安装成功时清理临时源；安装已发起但 CLI 失败、超时或抛错时无法证明原生操作已结束，保留副本并记录路径，不自动重放。原生安装记录保留真实使用过的临时副本路径，不伪造原始来源；该路径在清理后不再可读，持久安装目录保持可用。本地 path 原生不支持自动更新，后续更新须重新导入，不引入长期来源副本管理。

### 多入口包的身份

多入口包的 manifest owner 与原生运行条目 ID 分开处理。Main 按需使用独立只读进程调用原生 metadata snapshot 与 package ownership resolver，投影明确的 owner、条目集合及安装路径，再与本地包的精确路径核对。该结果仅用于本次清单和文件操作的对账，不执行插件入口、不启动 Gateway、不另存包归属；不能按 ID 前缀或包名猜路径。清单为子条目补齐已核验目录，并按其原生 ID 计算配置状态；安装结果以明确的代表条目统一市场身份，配置和卸载捕获使用同一包路径。读取失败报告无法确认，保留错误而不猜测可管理条目。

冷 CLI 的多入口成功提示同样使用子条目 ID。发起前通过原生 manifest registry 读取源目录的确切条目集合，用它匹配最终回执；提交后再通过安装归属核对路径，不能以包 ID 等待永远不会出现的成功提示。CLI 卸载成功还须确认本次捕获的包目录已消失，不能因子 ID 未出现在包级文件扫描中推断已删除。安装 RPC 若在请求准备时才启动 Gateway，网络策略或原生重启要求按实际已运行的 Gateway 收敛，不只检查操作开始时的状态。

### 原生应用与有限重新准入

OpenClaw v2026.10.7 的插件管理 RPC 会直接应用运行时变更。CLI 导入等待最终运行时回执：Gateway 已应用则无需额外操作，仅保存到磁盘时调用 `plugins.reload`。卸载 RPC 仍请求重启时，以及 CLI 卸载和启停回退后，优先调用 `plugins.refresh`；原生确认已热应用且无需重启时直接完成，仍需重启、热加载失败或出站代理策略变化时再申请 Gateway 重启。

扩展普通配置先等待配置 reload ACK，无环境变量变更时再尝试定向 `plugins.reload`；SecretRef 更新先调用 `secrets.reload` 刷新准备快照，失败报告并保留待刷新，不能靠重启掩盖。配置应用与重启协调见[引擎](05-agent-engine.md)；保留原生对活动任务的重启延迟，不能与宿主冷重启竞争。原生不支持热应用的运行时代码及网络策略仍可能需要重启；Windows 文件操作的目录锁恢复保持独立。

原生插件或配置操作的互斥租约忙碌时，Main 仅对锁定版本明确返回的“尚未进入写入”的 `UNAVAILABLE` 拒绝等待后重新申请准入：必须同时具有精确忙碌原因、`retryable: true` 和有效 `retryAfterMs`，且不含提交、运行时尝试或结果未知等元数据。等待最多 30 秒，并共享原请求总超时；等待期间进度进入排队阶段。重新申请必须保持原 Gateway PID 与进程代次、相同参数及能力确认令牌。Main 请求适配器在连接准备前和实际发送前再次校验身份与预算，校验回调不进入原生传输。

超时、断连和任何结果未知的已发送操作均不重放；启停只有明确未发送的连接失败才允许既有 CLI 回退，不能用配置开关值推断运行时成功。Windows Gateway 沿生产启动环境使用轮询监听，集成测试也必须复用该环境，避免测试自身引入长期目录句柄；现存目录的占用检测与文件安全边界仍然保留。

### Windows 发布和文件占用

Windows 目标查询返回 `ENOENT` / `ENOTDIR` 时，不启动目录占用扫描，其他文件
查询错误仍进入诊断。快捷路径保留“未诊断”，不能以路径缺席证明无占用，因为
Windows 等待删除的目录也可能暂时不可见；原生发布仍验证目标。已存在的目录继续
检查占用。诊断进程以 UTF-8 返回数组 JSON，无占用返回 `[]`，不把空结果或
PowerShell 模块初始化进度误报为诊断失败。

Windows 原生扩展安装的最后一次目录发布支持五秒有界恢复：只有真实重命名调用
被拒绝、确认是本地固定 NTFS、正式目标仍不存在且原生所有权未变时，才等待并
再次移动同一个已复制临时目录。每次等待后核对原始源清单、已复制文件身份和内容，
提交前仍执行原生父目录、权限和临时目录守卫；不重复下载、复制、能力审查或安装
RPC。正常发布不增加卷探测或全树比较。网络目录、未知结果、文件变化、守卫与
提交后错误不重试；持续占用耗尽预算后沿原生失败与旧版恢复流程处理。

补丁的
精确原生边界、产物证明及删除条件见[当前补丁总账的目录发布能力](../../scripts/patches/v2026.10.7/README.md#capability-gaps-and-removal-conditions)。

Extension CLI 文件变更的预检保留目录锁诊断，但关闭文件锁触发的 Gateway stop/mutate/start；占用者即使是 Gateway，也先报告真实失败，不通过重启或重复破坏性命令绕过。只有明确未发送的原生卸载请求允许 CLI 离线恢复；超时、断线或原生关联拒绝不证明未提交。响应丢失时先核对权威清单和本次原安装路径，确认已移除后只收敛运行态；无法确认时提示结果待确认，不重放卸载或通过重启绕过。

扩展删除确认按钮在操作及清单更新期间显示旋转加载图标，并禁用重复提交与取消；完成后结束加载，失败恢复重试入口。Windows 原生插件恢复快照复制原有目录 junction 时，`fs.cpSync` 默认将它重新创建为普通 symlink，可能在替换准备阶段因权限不足报 EPERM。

运行时补丁 024 仅在原生 filter 接受后，为外部已捕获宿主目录的绝对链接保留 junction 类型；原生内部 junction relocation 继续由原生执行；文件链接、相对或断开的链接、非 Windows 行为及原生文件引用校验保持不变，不遍历链接目标或改变卸载生命周期。补丁从锁定 pristine 包重建后生效，不修改正在使用的旧运行时。

Main 沿完整错误 cause 优先识别链接创建失败，保留实际原因，不转成目录占用或失联后重复 CLI 卸载；未确认占用者时仅报告未确认的目录失败并附实际错误。

### 已提交失败与临时源

导入尝试已交给原生安装器后，即使最终 reload／重启失败，结果也保留 Extension ID；Main 据此重读权威清单并通知消费者，让已提交的部分安装状态及其附带能力失效刷新，不按失败结果假定没有安装。已确认提交的失败另外携带 `installationCommitted`，贯穿类型安装器、市场身份记录和窄化 IPC；市场版本/路径按已提交安装登记，Renderer 保留错误并刷新 inventory，同一版本只允许状态刷新，不重新安装。未知安装结果通过 Main 内部标记保留可能仍被原生读取的市场临时源；该标记与文件路径不进入 Renderer，也不据此记录提交成功。

### 凭据、普通配置与错误展示

Extension 卡片的警告支持鼠标悬停、键盘聚焦和点击进入详情。红色表示原生错误，
橙黄色表示缺少凭据；详情显示错误或缺失项，并提供密码输入框、已配置提示和保存反馈。
OpenClaw 2026.10.7 的 `plugins.list` 分别返回配置期望状态与当前 Gateway 代次的
`runtime` 状态。

Main 保持 `enabled` 的配置含义，将 `runtime.error` 或
`runtime.state: service-failed` 投影为错误警告；仅 `unloaded` 不推断失败。
原生 `needs-setup` 同样显示配置警告，即使没有环境变量缺失项；不为展示错误修改开关、
管理权限或另存运行态。原生目录自身的错误优先保留，后续成功清单可以清除旧运行错误。

Main 优先使用 manifest 的 sensitive `uiHints`；只有 provider 环境变量声明而没有对应
配置字段时，按 `setup.providers[].envVars` 生成凭据入口。
同一 provider 的变量是替代项，任一已配置即可满足该组；不同 provider 分别检查。
详情使用左右布局；存在替代变量时，左侧下拉选择要填写的凭据，右侧输入其值。
切换选项清空未保存输入，保存仅写入所选的 manifest 声明变量；配置状态按变量呈现。

这些入口保存到原生 `env.vars`，不向空的插件 config schema 写入虚构的 `apiKey`。
Main 每次保存重新读取 manifest 并限制可写字段，inventory 仅返回配置状态，不返回密钥。
普通文本字段要求 `configSchema` 的明确 `string` 属性及对应 `uiHints.configurable: true`；
支持沿 `properties` 声明的安全嵌套路径，不自动展开额外属性、引用或组合 schema。

此类字段在清单中返回当前值、默认值和直接声明的长度、正则、枚举及 URI 格式约束，
Main 在写入配置或凭据前再次校验。敏感字段、秘密契约路径、危险标记和只读／只写／常量
schema 的相关路径不作为普通文本公开；带通配符的秘密契约同样保护其祖先与后代。
详情仅提交用户编辑过的普通文本，保留精确字符串；清空可选文本删除该项覆盖并保留相邻配置，
必填文本仅在存在有效默认值时允许通过清空恢复默认。密码空白仍表示保留已存凭据。

通用配置不修改扩展开关，不扩大受应用托管扩展的编辑权限；跨字段及插件特有约束仍由原生插件校验。
完整和最小配置同步保留用户的原生环境配置；配置临时文件在写入前限制凭据文件权限。
原生 Gateway 热重载负责应用环境配置，无法确认应用时使用现有重启协调器。
应用失败时保留待刷新状态，重复保存同一个值也会重新应用。替换凭据同时删除同名的
顶层 `env.NAME`，避免旧值覆盖 `env.vars.NAME`；系统环境提供的变量显示来源并禁止
无效覆盖，用户修改系统变量后重启应用。

权限或写入失败直接报错，不触发最小配置重建。

## 7. 受管扩展与可选业务

受管状态由所属设置和 Main 策略返回，普通管理入口不能按名称推断或覆盖。Required Services 不依赖 Team/Workflow 等可选业务。

结构化提问工具以 `ask_user_question` 注册；插件 ID 仍为 `ask-user-question`，
配置及 `askUserQuestion.list` / `askUserQuestion.resolve` RPC 保持原契约。
插件在成功工具结果中返回版本化问答快照，覆盖用户提交、超时默认、超时未答及取消。

原生允许保留的完整 JSON text envelope 与实时 details 承载相同结果，历史不依赖自定义 details；
插件 `contracts/` 负责纯校验，`browser/` 负责只读问答呈现，宿主仅适配原生工具投影与现有过程折叠。
原生 transcript、问题窗口及响应 RPC 继续持有原所有权，不追加模拟用户消息或 runtime patch。

| 扩展/能力             | 持有的状态                           | 产品桥接                     |
| --------------------- | ------------------------------------ | ---------------------------- |
| Runtime Services      | 原生历史、进度、回执的受限读取       | Main/Renderer 查询投影       |
| ask_user_question     | pending、期限、默认及取消            | 问答 event/RPC、UI replay    |
| Plan mode             | 原生 session mode、待审核交互        | Main 计划文件与 handoff      |
| Automation permission | 按原生 session mode 进行任务变更审批 | 使用原生 plugin approval     |
| Embedded browser      | 原生 browser 工具桥                  | Main guest 所有权与动作执行  |
| agent-team            | 可选工具、技能与原生发送 hooks       | Main 成员、轮次及接收元数据  |
| stt-local-cli         | 本地附件转录工具                     | 已安装 Sherpa 路径及文件策略 |

Plan mode 使用 `api.session.state.registerSessionExtension`、`sessions.pluginPatch` 和
`sessions.describe.pluginExtensions` 保存与读取 `plan-mode/state` 会话开关，原生会话状态槽名为
`planMode`。

plan-mode、agent-team 和 Swarm Workflow 的规划门禁统一读取原生
`pluginExtensions['plan-mode'].state`，不依赖可能缺失或过期的会话槽投影。插件自有状态槽、服务注册键、
消息标记和临时路径前缀按能力或插件命名，不带产品名；应用会话身份保留现有 `justdo:` 命名空间。
`agent_turn_prepare` 注入规划约束，
`registerTrustedToolPolicy` 在执行前阻止已知变更工具。

计划工具统一命名为 `present_plan`，
保持 direct-only，不注册或识别旧工具名；
Tool Search 分发器由原生对实际目标再次执行策略。动作型工具使用上游
`isReplaySafeToolCall` 分类，包括 `theme` 的 list/get（允许）和 set/import（阻止）。
此策略不是任意第三方工具的通用只读沙盒：未识别的工具仍需审核其实际副作用，不能仅凭名称保证安全。

批准只结束规划轮次，不在该轮放开写权限；Main 完成同会话 reset 后才以关闭 Plan 的状态发起实施。

输入框的“+”功能菜单提供独立的“计划模式”开关，不显示勾选，也不随功能启用改变“+”按钮颜色。
开启后，工具栏在执行权限旁显示灯泡图标与“计划”标记；悬停或键盘聚焦时，图标变为关闭叉号，
点击退出计划模式。保存期间禁用重复操作，保存失败保留当前标记并提示。
执行权限菜单只管理请求批准、智能审批和完全权限，切换权限不改变计划模式。
`/plan` 不再提供命令入口；运行期间不能开启计划模式，但已开启时仍可从“+”菜单关闭，
待审计划通过现有服务取消后退出，即使计划审批暂时禁用了普通输入。

agent-team 默认关闭，禁用保留历史；Runtime Services 仍读回执并阻止受管 peer send。两个发送 hook 均避让原生 SubAgent 与 ACP 子会话，由 OpenClaw 判断子会话归属和可见性；这些发送不计入平级协作预算。stt-local-cli 保留显式 disable，附件转录独立于麦克风开关；sandboxed session 不注册该 host tool，文件访问遵循有效 fs policy，无云端 fallback。

Agent Team 关闭时，应用隐藏摘要、插件卡片／详情中的历史与参数设置入口，以及团队导航；已打开的历史／设置弹窗随禁用关闭。未知启用状态不展示入口，禁用事件立即覆盖在途目录读取。重新启用恢复保留记录入口。协作消息详情与群聊历史 RPC 归可选 Agent Team，禁用后不可用；重新启用恢复读取保留的原生 transcript。托管清理、离线回执核对和发起守卫仍由常驻 Runtime Services 提供。

Agent Team 的规则、资源参数校验和发起提示随插件分别放在 `contracts/`、`prompt/`；可选执行及各自历史读取由 `collaboration/` 与 `discussion/` 组合。Runtime Services 的 `agent-team/` 按成员发送保护、讨论离线控制／托管／回执、发起保护分域，独立的 `contracts/` 持有关闭插件后仍需读取／清理的身份与输入协议。

通用权限、插件/tool ID 与受管 session-key 协议属于 Runtime Services 的纯 `contracts/`，FIFO 许可属于 `concurrency/`；Plan 状态解析归 Plan Mode 的纯 `contracts/`。

两个插件不导入应用 `src`，Runtime Services 不导入可选插件；应用 shared 入口只复用浏览器安全的纯合约，Main 通过 typed ports 使用 Team `host/` 的协调及同库元数据事务，Renderer 使用 Team `browser/` 的草稿与规则。数据库连接、Electron IPC、Redux/preload 和界面组合由应用持有。host/browser 模块保持各自进程，原生插件入口不加载它们；禁用后的合法 Main 清理和核对仍保留。

资源同步在预打包阶段消除纯合约的相对路径，SDK 保持 external。见 [Agent Team 模块边界](../features/assistants/agent-team.md#模块边界)。

新版 Gateway 可以为执行 hook、工具工厂和服务创建不同的插件注册实例。Team 的临时 scoped grant 因此由 `collaboration.dispatch` 所在的 Gateway 实例统一登记，不能仅保存在执行 hook 的局部 Map。登记前固定目标 sessionId，授权继续受源会话、运行、准确目标及有效期限制。`collaboration.release` 提前撤销，`native-result` 回报路径再次撤销；前者 RPC 失败不得阻止真实发送结果回报 Main。历史读取归可选插件，禁用后的发送阻断归 Runtime Services，不通过扩大全局会话可见性实现平级交流。

服务停止会推进生命周期代次并清空临时状态，旧请求即使随后返回，也不能重新写入授权。发送授权最长 60 秒；结果回报使用独立的准入身份记录（最长 10 分钟、最多 512 条），校验源会话、toolCallId、runId、deliveryId 和目标。该记录不授予会话访问权限，不保存正文；撤销授权后仍允许准确关联的迟到结果更新 Main 回执。取消准入时，即使 release RPC 失败，也通过绑定的取消结果撤权并结束 dispatching 状态。

插件可拥有工具或钩子，但不能建立第二份产品会话 transcript。角色文件也归原生 agents.files，不把长期助手实现成 Skill 目录的另一套编辑器。

### Runtime Services 通用能力

Runtime Services 还提供通用 CLI / ACP 的会话级 stdio MCP 代理：通过公开 v2 工具工厂按
精确 native session/lease 提供固定声明的 `external_mcp`，保留服务器原始 schema 和结果；
每次调用经原生单次审批，不把客户端 MCP 写进全局配置。进程、授权与租约随会话关闭清理。
MCP client 使用根工程精确版本生产依赖，其发布代码已内嵌 Ajv。

资源同步与 TypeScript
预编译两条路径都将其随扩展离线打包，不增加插件独立 npm 安装链；仅该扩展添加 ESM
`createRequire` 入口以支持所捆绑依赖。完整边界见[通用 CLI / ACP](../features/integrations/agent-cli.md)。
会话 stdio MCP 仅在 Windows / Linux 提供；macOS 的普通 CLI / ACP 仍可用，但在启动
MCP 进程前拒绝该能力。

锁定的公开 MCP SDK 不提供 detached 进程组创建选项，原生清理
API 也不能清理 macOS 上 attached wrapper 的后代，因此本轮不声明该平台的进程树清理保证。

Runtime Services 在注册时立即建立外部 MCP 的策略、工具工厂与清理回调，传输客户端在
首次连接时才初始化。异步加载结束后、创建子进程前，重新核对租约、当前原生会话身份、
管理员及客户端授权和插件状态；加载期间撤销任一权限不得启动新进程。离线打包仍内嵌
传输依赖，不把延迟初始化变成首次使用下载。

Runtime Services 还拥有 `builtin_models` 的请求级认证 Provider 包装：通过公开 SDK
重新解析 Main 发布的会话绑定 exec SecretRef，让运行中的长任务跟随 JWT 续签，
并在退出、换账号或重新登录后拒绝旧任务借用新凭据；模型传输与执行仍由原生拥有。
详见[内置模型认证](../features/integrations/authentication-builtin-model-lifecycle.md#长任务的请求级凭据)。

Runtime Services 提供嵌套 MCP App 历史的受限恢复 RPC：只读原生当前可见历史和当前
策略许可的 UI resource，使用公开 SDK 借用原生连接。挂载时主动取数的历史 App 可以
按原工具和原参数读取已记录结果，缺省值按当前 schema 核对，不执行原业务工具或恢复旧工具授权。
会话 incarnation、生命周期和配置权限变化立即使恢复视图失效，详见[MCP Apps](../features/chat/mcp-apps.md)。

Runtime Services 还通过公开 prompt/agent-end hooks 记录有限的轮次准入诊断元数据，
只观察本次 hook 的原生身份及 trace，不缓存或推断失败阶段，不改变 prompt 或原生准入。
日志沿现有原生 JSON 导出，能力和证据缺口见[会话诊断](../features/chat/session-diagnostics.md#已保存用户轮次的准入错误)。

### 语音与媒体适配

`tts-local-cli` 采用与锁定 OpenClaw 同版本的应用自有源码完整替换，保留原生 provider 身份、CLI 实现、许可证和来源哈希，新增按显式配置的在线合成分支。裁剪规则将上游目录列为源码替换项，必须有当前本地替换证明才能保留；不使用运行时补丁或私有上游模块导入。`stt-local-cli` 继续拥有唯一 `transcribe_audio` 工厂，按自己的本地／在线模式执行，工具准入和扩展开关不改变。两种扩展的执行配置由 Main 投影，不能反向读取应用配置库。

Runtime Services 的在线回复朗读 RPC 只通过公开 TTS API 使用当前受支持适配器，配置仅作用于该请求，不依赖可选 CLI 扩展，也不改变工具的默认模型。契约与验证见[语音功能](../features/models/local-tts.md)。

OpenAI 媒体适配由 `plugins/extensions/openai` 的完整本地源码实现，基线为原生
v2026.10.7。来源哈希与完整替换由本地插件清单及构建校验记录；保留内网适配差异，升级时重新核对上游完整目录。
资源同步完整替换原包目录；裁剪策略明确移除上游插件，本地保护只保留
替换后的唯一 `openai`。不合并源码、不备份 native-* 入口、不注册第二个同名插件。

本地 manifest 和 setup 删除官网登录/API Key 引导、公网 catalog 和 usage；内网服务
仍可配置 API Key/SecretRef，缺失能力地址时拒绝请求，不读取环境 Key 回退。
图像使用 `justdo-image-openai` 的请求级配置副本；实时 STT 在自身源码中持有每个
会话的地址、请求头及原生协议/生命周期。冷发现和注册共用同一 factory。
源码替换只在构建时组装；开发库存和启动源码复制排除该目录，由已编译 manifest
决定可用性。

来源版本不匹配时构建失败，全部源码/依赖锁/worker 纳入 build recipe。
保留图像、TTS、实时 STT、文件转录、embedding 和配置模型的原生协议能力，视频
也由同一插件注册。官网账号/RTC 专属 Realtime Voice 不注册，不影响现有 TTS/STT。
更新时先读[升级检查清单](../upgrade-checklist/checklist.md)，再三方比较上游基线、
新上游与本地差异。

Gateway bundle 和动态 SDK 通过构建时共享原生会话访问模块实例
完成授权注册表共享，不通过运行时补丁建立第二个注册表。

### Smart Canvas 与外部分发的 MCP App

独立分发的 MCP Apps 由各自的插件仓库维护源码、依赖、构建和交付物，不进入主工程
依赖或 Electron 安装包。插件清单静态声明 MCP，经现有扩展导入和能力审查安装，
附带 MCP 沿原生配置、审批和父扩展启停流程运行；市场按现有 `extension` 类型分发。
宿主只提供通用发现、消息展示、工作区文件入口及原生 RPC 约定，文件格式解析、
容量限制和编辑存储归外部插件所有，不增加 marketplace kind 或业务 Provider。

`plugins/extensions/smart-canvas` 在 `ui/` 聚合固定组件的 schema、组合器、渲染逻辑、
文案与样式；`document/` 仅保留这些组件复用的 HTML/JSON 安全序列化与资源初始化。
插件通过原生 `registerBoardWidgetContentKind` 注册 `interactive-answer`，发布
`/__smart_canvas__/ui.js`。类型校验 JSON，由原生 `show_widget` 拥有包装、文档和历史。

插件 ID 为 `smart-canvas`，默认开启；配置同步保留用户明确的启停选择。
没有工具调用补参 hook、额外 HTML 页面类型、图片转换或业务联网适配；不新增 agent
tools、MCP/RPC、数据库或 runtime patch。组件单元测试归插件，宿主与打包集成测试归主工程。

按需 `visualize` 技能负责实际可见交付，并复用设计技能已生成的源码：完整 HTML、
交互式 3D 地球、游戏和复杂模拟默认写为托管页面后输出 `[embed ref="…"]`；已有网址
直接 `[embed url="…"]`。小型自包含 HTML/SVG 卡片、本地计算或需要人工确认草稿桥
的控件才选择 `show_widget`。明确的文件交付与真实应用开发保留原目标。技能只随插件
按需加载，不增加每轮提示或修改设计技能。

托管文件通过现有已授权 Gateway 本机 exec 读取非空 `OPENCLAW_STATE_DIR`，写入
`canvas/documents/<fresh-id>/index.html` 与相对资源。外链开关、代理及静态文档认证
由宿主负责；独立网页不继承 Widget 能力或草稿桥。契约见[独立网页](../features/chat/webpage-embeds.md)。

`interactive-answer` 提供 table/compare/chart/form/steps，不接受表达式、脚本或外部
提交；多选表单使用原生复选框，保留组级必选与空初值。固定 renderer 的继续按钮只在
当前原生私有 prompt port 可用时启用，由用户确认后加入草稿。搜索、排序、选择和
表单值保留在当前 iframe 内存中，重载恢复默认值；未获得 Dashboard/tools/resources
执行权限。

普通原生 HTML 仍遵循原生 CSP 与资源规则，宿主不增加业务 fetch 下载通道。
完整页面的依赖和静态资源由作者随页提供或使用已配置的可达服务，不在首次展示时安装库。
组件流程与验证边界见[交互式回答](../features/chat/interactive-answers.md)。

首次、复用和备用同步及最终分发仍排除未使用的 assets 目录。Smart Canvas 没有运行时
第三方依赖；固定 renderer 从插件源码生成并随入口预编译。

### ACPX 与浏览器承载

ACPX 随包保留 ACP 协议适配器及其运行库，组装时移除 Codex/Claude 的平台代理二进制，
最终打包再次检查不得混入。代理由用户独立安装维护；受管包装器启动时读取本机 PATH
或显式 CLI 路径，缺少时连接测试报错，不下载、不回退到 SDK 内置代理。

日常 Chrome 沿用原生 existing-session driver 和随包 Chrome MCP，设置页通过 Gateway 请求原生 Tab 查询来触发浏览器授权。Windows 的应用配置选择 `chrome-mcp.cmd`，Main 生成的 UTF-8 启动器用锁定的独立 Node 启动服务器；`npm.cmd`、`npx.cmd` 和 `node.cmd` 同样位于应用 PATH 前端。

启动器内的 Node／可信预加载文件引用使用绝对路径，避免真实 npm 包的 `.cmd` 嵌套调用裸 `node` 时将 `%~dp0` 解析到调用方工作目录。受管 MCP 的裸 `npm/npx` 命令由 Main 配置投影为锁定 Node 的直接启动参数，显式加载可信窗口隐藏模块；用户保存的命令、参数、环境和其它原生字段不被改写，绝对路径自定义命令保留原样。配置投影与启动器共享 npm 路径解析，安装包中指向同一冻结 `node-runtime/` 内的完整 npm 分发。

原生 MCP 仍过滤不安全环境变量，负责连接授权、进程身份核验与清理。普通插件来源仍可使用应用 PATH 中的自包含启动器。002/003 补丁已移除；真实 npm/npx 与原生配置解析器对照测试验证连接、工具发现、调用和清理，受管配置不产生批处理空帧诊断。真实本地包二进制启动另验证嵌套批处理和中文／空格启动器路径。批处理对照虽有空帧诊断仍能完成普通 Client 连接，不能把该诊断直接等同于功能不可用。

ACPX 本地封装以 OpenClaw v2026.10.7 为基线，底层运行库精确锁定为 acpx 0.19.5。
会话世代、持久资源绑定、reset 和探测沿用上游分层；产品继续拥有外部 Agent 目录、
结构化受管命令、隔离认证、逐 Agent doctor 和默认不启动探测的策略。内置适配器的
诊断也使用随包包装器，诊断不授予任务执行权限。服务停止先撤销后端，再等待运行库
shutdown 和进程清理；清理失败必须向宿主报告，不能当作成功结束或释放责任后另起一代。
这些状态只描述 ACP 执行资源，不替代原生 transcript 或 whole-run 结算。

QuickJS Code Mode 是默认启用的应用托管原生执行器，是否使用由运行设置控制；电脑控制继续要求专用开关显式启用。两者均保留精确 allowlist 身份。扩展从具名公开 SDK 子路径导入；Agent 技能工坊归 Gateway，不恢复工作区技能所有权的旧实现。

当前锁定产物的接入与实际验证分别见[模块审计](../openclaw-upgrades/v2026.10.7/module-api-audit.md)和[验证记录](../openclaw-upgrades/v2026.10.7/validation.md)，旧版证据只适用于原记录的产物和场景。

### 可选本机电脑控制

运行时裁剪保留上游 `cua-computer`，配置同步为已安装插件写入默认
`enabled: false`，并加入原生插件 allowlist。未明确启用插件时，全局 `computer`
工具也默认禁止，包括插件配置缺失的情况。设置 → 电脑操控提供一个即时保存的
开关，通过带原生配置版本的单次 `config.patch` 同时更新插件和全局 `computer`
工具许可；关闭时写入明确的工具 deny，开启时只移除该工具的 deny，并扩展当前
allow 或 alsoAllow，保留其他工具权限。

同步、登录和退出登录按插件选择维持两者
一致，不新增产品数据库中的开关副本。扩展列表继续显示同一个原生插件，并沿用
受管理扩展的锁定状态；主进程拒绝通过通用扩展管理入口启停或改写该插件，
仅设置页开关更新启用状态。提交后立即显示保存提示和开关内的旋转加载动画，
首次进入页面时显示读取提示和居中的加载指示，取得真实状态后才显示开关；
读取失败显示未知状态和重试入口，不把尚未读取的状态显示为关闭。
初始读取与窗口聚焦刷新复用在途查询，扩展变更通知和写入会使旧查询失效；
不缓存权限读取结果，也不新增开关状态副本。

保存期间禁止重复提交；成功后以 Main 返回的状态更新开关，使用 200ms 滑动和颜色过渡，
不再额外回读配置并重复执行原生权限检查。失败或保存期间收到刷新通知时才回读，
保留已写入但应用失败的真实选择。

当前电脑操控设置页仍通过 `motion-safe` / `motion-reduce` 在系统减少动态效果时停用旋转和过渡，这是现有 UI 实现与全局“动画保持启用”要求的差距，不是推荐的新功能契约；文档整理未修改该行为。
页面只显示开关和当前会话模型必须支持图像的说明，不单独配置模型或图像能力。
主进程以隔离的 Node 子进程调用锁定运行时的原生工具策略函数，只传入全局
profile、allow、alsoAllow、deny，读取真实的全局许可状态并在启用写入前校验。

保留通配符 deny 和受限 profile；若现有 profile 与绝对白名单组合仍阻止
`computer`，启用返回失败，不扩大其他工具权限或显示假成功。
上游在 Windows/Linux 上要求 `plugins.entries.cua-computer.enabled: true`，
仅保留文件或依赖插件 manifest 的默认值并不能启用本机控制。

OpenClaw 的原生 `computer` 工具通过 Gateway 电脑服务调用 CUA，拥有截图、
动作、引用校验、串行执行和运行结束清理；应用沿用通用工具调用展示，
不添加鼠标键盘 IPC、截图缓存或独立执行器。截图用于模型观察，
不自动作为聊天附件发送。它与现有 `browser` 工具及内置浏览器承载独立。

新会话发送时，Main 可复用执行准入已读取的配置，异步调用 `computer.status`
提前准备显式启用的原生宿主，与后续会话和执行环境准备重叠。它不执行输入或截图，
不代替原生模型、工具或会话准入；关闭插件或明确禁止 `computer` 时不准备。
仅合并同一代次的在途请求，不保存能力快照、不增加保活轮询，宿主闲置回收仍由
OpenClaw 管理。失败不阻塞发送，客户端、进程或配置替换后忽略旧结果。

Windows 10 2004 及更新系统的本机电脑操作自动显示透明提示层：状态提示、
屏幕边缘，以及前台桌面动作的大指针、光晕和成功点击反馈。窗口不获取焦点，
鼠标穿透；默认在显示前开启系统截图排除。“设置 / 电脑操控”在启用电脑操控后
提供远程效果预览开关，默认关闭，自动保存到 app_config.computerOverlayRemotePreview。
开启后允许远程控制、共享和录屏捕获提示层，也可能进入 AI 截图；下次电脑操作
应用设置，关闭后恢复截图保护，无需重启 Gateway。

多屏坐标使用 Electron DIP，
只在有前台指针动作时采样鼠标，动作结束时固定位置并保留 4 秒反馈，随后淡出光标。
屏幕边框使用 5px 高亮边线和双层内发光，动作间隙保留 75% 亮度，便于远程观看。
预加载隐藏的受保护窗口，普通退出隐藏并复用，应用退出或绘制失败才销毁；
隐藏和静止反馈不采样鼠标。首次显示先提交绘制帧，避免只有边框的空白闪现。
窗口／元素／浏览器定向操作只显示状态，不将后台动作伪装为物理鼠标移动。
远程节点、托管虚拟桌面、macOS 和 Linux 不启用该提示层。

[电脑活动补丁](../../scripts/patches/v2026.10.7/023-computer-overlay-activity.cjs)在 Gateway 电脑服务完成权限、代际、独占和幂等校验后，
为实际提交的本机原生调用发布 `computer.activity`；仅 `operator.admin` 可接收。
v2 事件仅有版本、临时请求 ID、独立显示执行 ID、开始／结束／释放、指针和点击布尔值，不含会话身份、
输入、坐标、截图或工具结果。

执行期间每 5 秒续期，Main 的显示租约为 15 秒；
租约过期仅隐藏 UI，不判断执行结果，也不重试操作。请求完成后边框进入低亮度
“电脑操作待续”状态，12 秒内的新动作恢复亮度而不重建窗口；空闲退出用 180ms 淡出。
原生 execution 的 owner 取消或 releaseOwner 清理发送显示释放事件；迟到事件不能复活已释放显示。
显示空闲时间不改变原生资源租约。键盘输入和观察不在物理鼠标处伪造目标位置。
Gateway 断开、锁屏／休眠、应用退出和绘制失败会清理显示。

广播失败不改变原生结果。
该功能需要从锁定 pristine 包重建包含此活动发布能力的运行时，不能就地修改旧冻结运行时。

Windows x64/ARM64 和 glibc Linux x64/ARM64 使用上游固定版本的本地
`@trycua/cua-driver` SDK 及对应平台原生包，依赖由锁定 OpenClaw 包的生产安装提供。
扩展预编译保持 CUA SDK 和 `rastermill` 外部加载，保留原生库的包目录解析。
Gateway 须处于可访问的交互式桌面会话，聊天模型须支持图片。
macOS 仍依赖上游原生应用持有的驱动端点与系统权限；保留插件不表示
Electron 应用已经实现该平台的原生承载。

启用开关为全局工具策略显式加入 `computer`，支持编程工具集和非空 allowlist；
关闭开关保留原有限制性 allowlist，避免移除最后一个元素后变成无限制策略。
提供商、独立助手和其他显式限制仍由原生工具策略处理。应用不把宿主桌面控制加入
沙箱工具白名单。命令审批仅约束 `exec`，不能视为对每次电脑输入的审批。
开发中已裁剪的冻结运行时须从锁定的 pristine 包重新构建，不能在原目录补拷插件。

`embedded-browser` 只替换原生 `browser` 工具的桌面执行承载，提供工具契约、请求事件桥和结果，不注册提示词钩子，也不向普通聊天逐轮注入浏览器使用规则或工具不可用说明。工具是否可用由 OpenClaw 原生执行策略过滤决定；工作区网页可见不代表 Agent 获得操作权限。

默认沙箱策略不提供宿主 `browser` 工具。用户可在“设置 → 安全 → 任务执行方式”选择本机执行，应用不因打开网页而修改策略。内置模式禁用原生 browser 插件，由桌面扩展提供工具，因此 OpenClaw Control UI 的原生 browser.request 查看入口不适用于该模式。

### Workboard 与团队

Workboard 使用原生卡片/看板 API 和原生存储，Renderer 只做用户流程与状态投影。它与独立 Workflow、Agent Team 分别启用，不因都有图或任务而合并执行权威。列状态、启动/停止及版本冲突规则统一见[Workboard](../features/workflow/workboard.md)。

Agent Team 默认关闭，业务 Main、Browser、Native 与业务 schema 同属插件；通用宿主不保留 Team 专属 IPC。配置同步组合插件声明并保留用户显式选择，关闭撤销业务入口，Required Runtime Services 只保留通用回执与合法清理。来源参与、汇总、工具继承及资源预算见[Agent Team](../features/assistants/agent-team.md)，不在此维护另一套模式或权限说明。

### Jev / TypeSafe

`typesafe` 位于 `plugins/extensions/typesafe/`，按固定上游 revision 随现有本地扩展流程组装。没有决策模型设置时默认关闭，允许用户手动启停。设置页管理 URL/API Key、provider/model 目录、发现和导入导出，选择 `agents.defaults.decisionModel` 及评估工具默认模型。

只有有效默认选择才接管并锁定插件配置；仅保存未选中的目录不会自动启用。清空默认或删除所有 provider 后恢复手动控制，保留插件当前配置/开关，仅清除此前精确投影的原生默认引用。没有归属的原生默认保持不变，重新选择有效默认再次接管。模型自行决定何时调用工具。

内网 System One 可使用受认证 `serviceUrl` 接口，不跟随重定向、环境代理或托管服务回退。完整设置与边界见[Jev 集成](../features/models/jev-integration.md)。

### 敏感配置和准备凭据

扩展详情使用原生敏感配置声明。Main 将结构化秘密写入权限受限的 `extension-secrets.json`，原生配置只保存 file SecretRef。轮换先用 `secrets.reload` 刷新准备快照，再定向 `plugins.reload` 热应用；只有原生不支持或明确要求时才交既有 coordinator 安排重启，secret-provider 错误不以重启兜底。启动、设置及登录/退出同步保留用户启停、引用和 secret provider。清单只返回凭据元数据，模型设置的原始凭据继续由原应用配置拥有。

原生 OpenClaw 负责传输、校验、取消和结果。不能为解决未准备凭据而添加备用 secret reader。

### 凭据状态模块的打包单例

Gateway bundler 将原生 `secret-input-runtime` SDK 状态 owner 模块保持为外部 ESM，使 Gateway 和动态扩展共享准备凭据及 unavailable-owner 状态。配置准备 scope、环境发布、认证缓存/owner 与所用原生错误类同样保持单一实例。

这是构建边界，不是运行时 patch。构建 recipe 对其做指纹校验；变化后从锁定 pristine 输入重建冻结运行时，不能原地编辑源码或证明 manifest。

### Workflow

Workflow 通过公开 App/Runtime SDK 注册 Native/Main/Browser 贡献，插件拥有 DAG、批次、提交、执行、验收和持久化规则。Core 只提供通用加载、配置、资源 preflight、视图和提交参与者，不直接导入业务或保留专属桥。关闭撤回业务，保留元数据及合法清理；重开不重放未知 launch，来源聊天 Stop 也不代替明确流程控制。

详细契约见[Workflow](../features/workflow/swarm-workflow.md)、[批次](../features/workflow/swarm-workflow-batches.md)与[应用插件宿主](17-app-plugin-host.md)。

## 8. 出站请求头与信任

Extension 可用 outbound-header-policy.json 声明 HTTPS 目标、Header 名称和受管 user-info 引用。声明不含凭据值，安装前校验、安装后 canonical path 回读，启用状态参与有效策略合并。

它不能写永久手工 config，也不提供任意凭据 API。Gateway 同进程 Node Extension 仍处于可信代码边界，sidecar 并不是恶意插件网络沙盒。详细规范见[出站指南](../developer-integration/outbound-headers/README.md)。

## 9. 构建与运行时状态单例

### Windows 同步删除保护

Windows Electron 42 宿主的同步递归 `fs.rmSync` 会跟随目录 junction，导致原生插件
capture 清理误删 `node_modules/openclaw` 指向的真实运行时。Gateway bundle launcher
在加载原生代码前安装宿主修正：逐级 `lstat`，链接仅 `unlink`，真实目录逐级删除，
保留缺失文件与重试语义，并同步 ESM 的 fs 导出。

宿主修正通过独立 preload 在
Worker 入口加载前安装；包装 Worker 构造器，为原生显式 `execArgv: []` 以及嵌套
Worker 同样加入 preload，保留其余参数和线程选项。launcher 与 preload 一同生成、打包校验，
不依赖父线程的 fs 修改跨线程传播。

Main 在直接加载原生 Gateway 客户端前也安装该保护；
统一 CLI 环境通过 `NODE_OPTIONS` 携带相同 preload，覆盖绕过 Gateway launcher 的
浏览器扩展配对等公开 CLI 及继承环境的原生子进程，防止退出时插件 capture 清理误删宿主。
异步删除、普通 Node 和非 Windows
宿主保持原实现。该修正随构建配方校验，不改变插件启停、恢复副本或配置校验协议。
已经缺失入口或 worker 的开发运行时须退出应用后重新构建；补回单个入口不足以恢复完整性。

### 源码预编译

执行结算及压缩的普通实现放在 Main 领域的 `runtime/native-support/`，构建时作为
原生运行时模块导入，并由构建配方和最终 bundle 校验绑定。执行结算与压缩补丁仅保留
原生接入和验证，具体编号见当前补丁总账；原生恢复、worker 及准备/清理阶段需要这些能力，不能依赖可关闭插件的注册
时机。Runtime Services 继续通过受限 SDK 消费能力，不接管原生状态所有权。

本地 Extension 的构建预编译同时覆盖主入口和独立的 `setup-api` 入口（插件根及 `dist/` 下的 TypeScript 文件）。即使主入口已经是 JavaScript，也必须处理 setup 入口；编译成功后移除对应 TypeScript 入口，避免 OpenClaw 优先选中源码。ACPX 的自动启用探针在配置、旧状态检查和重载时都会运行，遗漏其 setup 预编译会触发原生源码代际快照，重复复制、哈希和校验依赖树。预编译让 bundled JavaScript 使用原生快速加载路径，不改变用户插件的源码隔离或完整性校验。

### 共享原生授权对象

Gateway 单文件打包与动态 SDK 必须共享原生运行授权及私有会话绑定标记的状态所有者。打包器从锁定 SDK 的 secret/reply 依赖图识别原生模块，将 `createAdmittedRunOperatorAuthority` 和 `prepareGatewayContextBindingOwner` 所在模块分别保留为同一外部 ESM 实例；不复制或重新签发授权，不放宽原生 WeakSet、来源、撤销或精确 owner 校验。

这修复真实 webchat 发起的 peer 执行在继续投递时被另一份授权校验状态拒绝的问题，属于打包边界修复，不新增运行时行为 patch。后台/System 连接不能替代这一链路的验证；已有冻结 runtime 必须按原构建流程从锁定 pristine 包重建，不能修改旧 bundle 或补写证明文件。

共享模块使 esbuild 为多处权限 resolver 导入生成数字后缀。现有 metadata 补丁的 bundle 检查接受此编译形态，原生文件仍要求锁定的精确函数名；缺失或重复的 transport authority assertion 继续报错。验收须覆盖从 pristine 安装、打包后的完整补丁复核到 Gateway 启动，单独重打包与 SDK 用例不能代替该流程。

## 10. 失败处理与验证

| 阶段           | 失败意义                  | 恢复要求                   |
| -------------- | ------------------------- | -------------------------- |
| 下载/解包      | 尚无有效安装输入          | 清理临时目录，保留原安装   |
| 格式转换       | 产品尚不支持或输入非法    | 明确停止，不调用 CLI       |
| 能力审查       | 内容或授权不匹配          | 重新审查                   |
| 文件变更       | 路径、锁或权限失败        | 保留事务/隔离区证据        |
| 配置应用       | 磁盘与 runtime 可能不一致 | 领域回滚或明确待恢复       |
| inventory 读取 | 无法确认当前状态          | 显示查询失败，不能猜未安装 |

### 回归入口

从 `src/main/plugins/` 的文件事务、MCP/Hook 同步、Extension import/conversion 和 registry 测试检查产品层；从 `tests/openclaw/extensions/` 与 skill-resolution runtime contract 检查最终原生能力。市场增加 kind 前需完成安装、更新、启停、删除与状态对账闭环，详见[市场适配](16-skill-marketplace-adapter.md)。

### 真实环境限制

`/learn` 触发的 Workshop 即时变更、版本读回和列表刷新尚未用真实公司模型与账号完成验证，包括冲突、断线及跨 Agent 隔离；写入仍遵循用户授权和当前原生 authoring 权限。公司 MCP 的身份与权限规范尚未确定，不将浏览器登录身份或公网可达性视为后台服务授权。
