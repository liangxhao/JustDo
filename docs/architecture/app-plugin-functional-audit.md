# 应用插件改造功能审核

本轮以未应用插件改造的 `594cc79da` 为功能对照，审核 Agent Team、Swarm Workflow 及其与普通聊天、设置、历史、删除和运行时的接入。目标是保留原有功能和交互，把业务实现交给独立插件。不能仅凭文件移动、类型检查或模拟端口通过，就认定功能完全相同。

审核同时使用源码对照、多个 Agent 独立审查、真实产品数据库与插件入口的边界测试、独立构建产物、Chromium，以及当前锁定 OpenClaw 的隔离运行。运行时版本由 `package.json.openclaw` 决定；本轮实际运行目标为 `2026.10.7`。未访问用户会话、直接读取原生 transcript、重建共享原生依赖或增加 OpenClaw patch。

## 功能对照

| 功能                     | 改造后的契约                                                                | 验证方式与范围                                                                                                        |
| ------------------------ | --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| 插件发现、启用、关闭     | 按清单加载 Native、Main、Browser；同包启停不重启 Gateway                    | Manager/Registry 生命周期、真实产物及 Electron 开发启动探针；进程启动次数、PID 与原生 ready 次数分别检查              |
| 插件卡片                 | 启用时提供原设置和 Team 历史入口；关闭即撤回，打开中的弹窗也关闭            | 实际卡片点击、弹窗和热关开；Registry 过期请求、导航与窗口归属测试                                                     |
| “+”菜单与输入标签        | 保留顺序、子菜单、文字、图标结构、标签删除与焦点                            | 从对照提交读取原菜单工厂，真实 Chromium 比较 Core 菜单和独立 CSS；关闭撤回模式，保留正文和附件                        |
| Team 面板和摘要          | 来源记录进入右侧 Tab；独立记录进入主内容页；保留首次创建时的打开规则        | Core 真实侧栏几何位置、摘要间距与行高、插件导航和 application page 测试；侧栏探针与点击路由测试分开验证               |
| 成员详情                 | 保留返回、身份、状态、历史、子任务与单成员停止入口                          | 原标题栏结构对照、真实历史视图端口与详情测试；不重复显示子任务按钮                                                    |
| 助手发现、创建和邀请     | 实际 Team Main 入口经绑定请求准备成员并回填结果                             | 真实 Registry、Core SQLite、Team schema/入口和严格 Native 端口；另用真实 Gateway 验证助手配置写入及公开 SDK 请求      |
| 任务协作与成员续写       | 保留房间、权限、精确成员身份、预算、停止代次、原生接纳和未知发送保护        | Team Coordinator、Native 扩展、续写及 Core 发送边界回归；实际冷工具运行验证真实成员执行，不代替任意真实模型质量验收   |
| 群聊、FIFO 和 holding    | 原生存正文，Main 只存定位与收据；禁止重放未知输入                           | 队列、holding、summary、原生收据及真实 Main 生命周期测试；缺少 whole-run 终态时保持未知                               |
| 关闭后的清理             | 继续核对既有运行、holding 取消与摘要停止，不派发新工作                      | 真实 Team Main + SQLite + cleanup lease；覆盖热关开、迟到响应、未知 FIFO 和持久取消任务                               |
| 历史显示                 | 业务入口关闭；已加载聊天仍按当前安装插件的纯规则显示                        | 独立 presentation 产物、当前 hash 租约、已挂载消息刷新、卸载与异步撤回测试；不修改原生记录                            |
| 引用、复制与导出         | 保留原引用文案、来源和返回；插件撤回后旧快照不能继续导出                    | 引用卡片、复制/导出异步等待前后守卫；已提交给系统的操作不声称能撤销                                                   |
| 草稿与断线               | 同一安装产物保留正文、附件路径和未知请求冻结；不恢复权限或自动发送          | ID/hash 隔离内存、epoch、卸载；本地恢复锁仍匹配草稿、同一 draftId 房间明确 ready/prepare_failed 且无冻结发送才解锁    |
| Workflow DAG、批次和管理 | 原生流程库、执行器、规划、介入、结果分页与权限继续归 Workflow               | Native/Host/Browser 定向回归；真实 FlowStore/FlowEngine 控制测试；真实 Gateway 批量执行、汇总和结果交付               |
| Workflow 与源聊天 Stop   | 两个独立操作；源 Stop 或下一条聊天不自动停止流程                            | 未完成真实流程经过提交参与者后仍运行；明确 Workflow Stop 才控制精确流程；错误父身份、外来流程、旧 revision 均拒绝     |
| 删除与包替换             | 全资源集合先预检；不删除借用来源；未清理执行继续否决                        | Team 实际资源参与者与 compare-delete；Workflow 真实 SQL 资源清理；租约、旧 owner、失败与未知保护                      |
| 普通聊天、Widget 与权限  | Core 继续拥有 controller、历史、普通发送、权限、Goal 和 Widget              | Core Main/Renderer 回归；Widget fixture 走真实历史加载与其所属窗口的 sandbox 握手，不手工制造不一致的 controller 状态 |
| 独立打包和资源安全       | SDK 无应用源码依赖；Browser/Worker 可访问已校验资源，Main 和 binding 不公开 | 仓库外 SDK ESM 消费、真实 Main/Browser 产物、模块图负例、实际本地 HTTP 200/404 与 Vite 代理验证                       |

原 Team 核心协调算法在对照版本中已经通过门面复用扩展实现；Workflow 的执行、批次和流程持久化也主要保持原算法。本轮发现的风险集中在新建的生命周期、SDK、资源参与者和界面适配边界，不能以“主体算法没变”忽略这些差异。

## 确认并修复的差异

1. 助手配置写入期间，SDK 曾把全局配置重载尚未收尾误认为插件失效。成功的 `agents.create` 被改成未知结果，旧 Main epoch 无法回填工具请求。移除错误的全局门禁，保留真实注册、调用者、取消、进程及最终提交围栏；没有增加超时或重试创建。
2. Team 关闭时原先停止了全部 Main 核对，重开又重新构造协调器。现在实例寿命与业务 epoch 分开，清理在窄 lease 中继续；热关开不执行进程恢复，不修改有效房间 generation。
3. Workflow 被套入 Team 式通用取消，源聊天 Stop 或新输入可能影响已有流程。移除这项新增行为，保留明确流程控制及删除/改包预检。
4. 旧历史格式化和词典只随业务 Browser 注册，关闭或重连后可能暴露旧控制提示、把群聊调度当普通用户输入。改为插件拥有的独立纯展示入口；已挂载视角缓存也随规则变化刷新。
5. 插件卸载业务视图时丢失本地草稿。增加有界 plain-data 草稿存储，保留未知请求的冻结，拒绝把草稿或界面恢复当成发送授权；普通草稿不再误判为准备恢复。
6. 成员历史标题栏、引用文案和异步导出守卫有偏差，已恢复原交互并在异步等待后复查当前贡献与会话。
7. 发送前临时准入映射没有在成功后回收，可能累计到上限而阻断新来源。旧实现能稳定复现 1,025 个来源的失败；现在全部参与者守卫成功后回收，未知或失败仍保留，确认删除仅回收精确集合。
8. 独立纯展示产物引入的模块图发布曾遗漏 Worker/独立浏览器模块；纯 JavaScript Main 入口也需要显式拒绝。现校验本地 URL 资源边，保留浏览器资源，发布层再次排除 Main，加入真实 HTTP 边界测试。
9. JSX 桥把 `jsxs` 当成 `createElement`，使静态子元素被当成动态数组，实际设置页出现重复 key 警告。改为分别透传宿主真实 `jsx/jsxs/jsxDEV`，保留单例 React、key/ref 和开发参数；不向业务元素补假 key。真实构建及渲染测试同时验证静态无误告警、动态缺 key 仍告警及重排后的 DOM 身份。

对疑似差异也做了负向核查：Workflow 活动 hook 的分页参数只过滤返回映射，发布的完整活动集合并未被截断；没有为此改写生产逻辑。旧 Workflow 文档曾声称发现后自动打开 Tab，但对照实现没有绑定该回调，现修正文档，保留实际行为。

## 测试证据与可复现入口

定向回归按每个文件最后一次执行汇总，共 **569 个文件、8,838 项通过，无剩余失败或跳过**；修复前失败与最终复测分别保留，重复执行不重复累加。覆盖 Core 运行时、插件管理、配置、权限和发送，以及 Team、Workflow 和聊天呈现。原五项环境条件跳过在显式提供当前 OpenClaw 源码及已准备运行时后已通过。没有把这些定向测试称为全量 `npm test`：使用直接 Vitest 运行和隔离的 Node SQLite 依赖，避免重建用户正在使用的 Electron 原生依赖。

完整应用构建、Main 类型检查、独立插件类型检查及 lint 通过。独立 SDK 在仓库外消费全部导出成功；真实 Electron Main 产物及 SQLite、Chromium Browser 产物和实际 Vite 资源代理通过。Browser 验证额外核对关闭保留纯历史/词典、卸载撤回，界面对照验证菜单、侧栏、摘要间距、两种 CSS 加载顺序及 Portal。

代表性的真实边界测试：

- `tests/plugin-host/agent-team-lifecycle.test.ts` 使用真实 Registry、Core SQLite、Team Main 入口和 schema。仅 Native RPC 与执行边缘为受控端口，不能代替真实模型或整个 Gateway。
- `tests/plugin-host/swarm-workflow-boundary.test.ts` 加载实际构建的 Main，贯穿绑定别名、真实 FlowStore/FlowEngine；Native 请求端口受控。构建属于准备阶段，Vitest 的模块装载适配不修改生产 loader。
- `src/main/plugins/app/historyPresentationAssets.test.ts` 实际读取本地资源服务，验证 Worker、共享模块和禁止公开的 Main/私有模块；失败 HTTP 断言也检查响应正文已消费。
- `src/main/plugins/app/sessionParticipants.test.ts` 覆盖长期累积、未知守卫、确认删除、旧异步回调与后来同 key 映射。

隔离运行入口：

```bash
node scripts/test/plugin-host/verify-portable-app-sdk.mjs
node scripts/test/plugin-host/verify-built-app-artifacts.mjs
node scripts/test/plugin-host/verify-built-browser-artifacts.mjs
node scripts/test/plugin-host/verify-development-assets.mjs
node scripts/test/plugin-host/verify-ui-parity.mjs
node scripts/test/plugin-host/verify-development-application.mjs --runtime <prepared-runtime>
node scripts/openclaw/agent-team/probe-agent-team-gateway.mjs <prepared-runtime> --cold-start-only
```

`--runtime` 开发探针使用私有应用目录、产品库、HOME、配置和运行时物理副本，投影当前插件产物，保留真实 Main、preload、Vite 和普通页面。不会修改来源运行时或 worktree 的 `current`。资源代理仍走生产校验；同包开关分别核对进程数、PID 和原生 ready 次数。

最终版本再次完整运行真实开发页面，完成六次 Team/Workflow 热关开，所有设置、历史和“+”入口按状态撤回与恢复；打开中的历史和设置弹窗即时撤回，重开后可再次使用，没有自动恢复旧弹窗。Gateway PID 一直为 `45212`、启动次数和原生 ready 次数均为一；实际 Gateway、Main 和父 runner 最后均以零退出，设置页不再出现 JSX key 警告。早一轮父 runner 将验证与正常关闭合计在同一五分钟内而报错，该失败记录保留。runner 已分开原验证预算与既有应用关闭策略，并用成功、失败、缺失完成信号、无实际 close 和迟到 close 等负例验证，再完整实跑通过；不增加业务或关闭预算，也不把 ACK、日志中的 clean-close 替代实际进程退出。

冷工具探针使用真实公开 Gateway SDK 和确定性的本地模型协议 fixture，验证项目目录、真实原生成员执行、whole-run 与历史交付。窄 `--cold-start-only` 不包含工作区 Skill 文件监视测试；旧完整脚本的五秒监视断言与当前 Windows 原生三十秒扫描策略不同，未当作本轮通过证据，也未修改生产轮询或冷工具预算。

本轮冷工具完整通过：两个真实成员执行完成并交付历史，耗时约八秒，原三十秒预算不变；全程公网拦截没有记录连接尝试。

Workflow 的 `tests/openclaw/extensions/swarm-workflow-orders.native-smoke.cjs` 需要 `SWARM_WORKFLOW_TEST_RUNTIME` 指向已准备运行时。它通过本地模型协议 fixture 生成十二条输入，真实调用执行工具，验证批次结果、规划纠正、实际汇总、独立验收、主会话交付及 execution lease 回收。运行时设置与产品一致关闭公共模型目录及更新检查；公网连接拦截在测试进程中启用，不改变系统网络设置。

批测首轮曾通过，后续在原总预算内未完成；受控阶段记录显示模型响应仅一至七毫秒，而新会话在 Native start 前约三十三秒，同会话再次执行约一秒。源码与实际已准备产物确认：普通新会话会抓取 Git diff 基线，在探测到的仓库根执行 `git ls-files --others --exclude-standard -z`，预算三十秒；测试项目位于开发仓库内，实际扫描了不断增大的宿主运行产物。现仅给测试项目建立独立 Git 仓库及真实小基线，不跳过 Native 基线捕获，不改宿主 ignore、生产执行或任何超时。原十二项复跑全部通过，首次规划派发到 start 从 `33.210s` 降到 `2.032s`，实际汇总、独立验收、主会话交付和零 execution lease 均通过；完整观测约一百二十五秒，公网拦截无连接尝试。原失败与无正文的阶段元数据分别保留。

测试设施也经过核查：旧 Widget 测试仅写 `chatMessages`，没有初始化 controller 实际使用的分块历史；这不是生产 Widget 回归，fixture 已改为真实 `loadHistory`。开发启动不能把初始化进度窗口当普通页面，也不能在原生历史检查尚未完成时断言插件目录为空。测试修复保持生产历史门禁与原生数据权威。

## 允许的变化与验证边界

关闭即隐藏设置、历史和“+”入口，属于本次明确要求；关闭时不再让业务视图保持可用。Native 证明失效会撤回业务贡献，重新准入需要新 epoch，正文草稿与安装产物的纯历史显示保留。更换代码包允许后台重启 Gateway，普通同包启停不允许重启 Gateway，软件窗口持续运行。

自动化已覆盖广泛的功能和真实接入，但不能证明所有模型、平台及任意外部插件都完全相同。当前未将真实公司模型的开放式任务质量、签名安装包、macOS/Linux、外部安装/卸载产品入口或长期多窗口压力计为通过。内置交付策略保持原样，可信进程内插件也不构成恶意代码沙箱。

本轮审核结果用于减少用户逐项验收负担。尚未验证的范围需要针对环境补充验证，不能把它们转换成“功能完全一致”或“全部没有问题”的结论。
