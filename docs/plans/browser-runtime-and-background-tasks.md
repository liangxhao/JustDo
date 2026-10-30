# 浏览器共存与同页宿主迁移（候选设计）

状态：待 POC。**零新增、零调整 OpenClaw patch 是硬约束。** 本文仅维护唯一工具门面、
Chrome 控制授权和统一同页宿主的剩余设计，不代表已经支持。

原始设计日期：2026-10-26；历史研究基线为 `dev@c48a21e69`、OpenClaw `v2026.10.7`。
实施前必须按当前锁定运行时重新验证公开 SDK 与调用控制流，不能把研究基线当作当前版本声明。

内置前后台执行已有实现，当前契约和验证限制见[浏览器设置](../features/browser/browser-settings-design.md#内置浏览器的前台与后台执行)
与[定时任务](../architecture/08-scheduled-tasks.md#内置浏览器后台执行)。现有 `browser` 名称、
按模式互斥的插件配置、前台 webview 与后台离屏 BrowserWindow 均继续有效；下述
`web_browser` 改名、Chrome RPC 统一门面及同一 WCV 前后台迁移尚未实施。

## 阅读与决策入口

本计划分成两层：本页说明交付范围、现状差异、验证门槛与回退；
[候选技术设计](browser-runtime-design.md)说明工具权限、页面宿主和精确资源协议。
两篇都属于未实施方案，不能代替现行功能文档。

| 要回答的问题                     | 阅读入口                                                                                                              |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| 为什么改、保留哪些能力           | 下方“决策与目标”及“与当前实现的差异”                                                                                  |
| 下一步先证明什么                 | “分阶段实施与验证门槛”；先做 G0–G5，再切换能力                                                                        |
| 怎样防止工具改名绕过权限         | [工具门面与权限](browser-runtime-design.md#工具门面原生服务与权限)                                                    |
| 怎样保证同页前后台、停止后再接管 | [页面宿主](browser-runtime-design.md#main-owned-页面宿主)与[人工接管](browser-runtime-design.md#查看人工接管与继续)   |
| Chrome 能否安全调用公开 RPC      | [Chrome 调用](browser-runtime-design.md#chrome-调用公开-sdk-与窄动作适配)；原始调用者、signal 和真实 drain 必须可证明 |

尚待 POC 决定的参数包括 carrier 类型、后台 scope/内存上限、viewport 和资源 TTL。
文中的建议值不作为已批准的默认配置；任何门槛失败都不能通过新增原生 patch 或自动降级绕过。

## 决策与目标

采用 **一个应用浏览器门面 + 标准工具 deny + 保留原生浏览器服务**：

1. 普通会话和定时任务统一跟随“设置 → 浏览器”，默认内置，保留 embedded/isolated/user/extension 四种模式；Chrome 扩展专属会话固定 Chrome，不受全局模式影响。
2. 模型只看见应用工具 `web_browser`（拟定内部名，UI 仍显示“浏览器”），参数不提供 backend/driver/node 选择。软件确定路由，不能让模型选择两套浏览器。
3. 原生 browser 插件和服务保持启用，使用现有 `tools.deny: ['browser']` 将其模型工具移出有效目录；应用门面名称与被 deny 的原生名不同，因此无需改原生 factory、同名注册规则或工具过滤接口。
4. 内置分支复用当前 BrowserAgentBridge 和真实页面能力；Main-owned WCV 的前后台宿主迁移继续按本文实施。Chrome 分支通过公开 `browser.request` 调用原生控制服务，由应用负责窄动作映射与目标准入。
5. Chrome 扩展继续当前 Main backend 的产品发送、会话和私有上下文链路，控制绑定由应用核验。无需为了调用原生模型工具引入 copilot 发送或改 014。
6. 不引入第二 Gateway、第二 Agent loop、另一份 transcript、Chrome 窗口嵌入或首次使用公网下载。

**可行性结论**：源码分层支持这条零 patch 路线：工具过滤、浏览器 RPC/relay/service 分别工作。它避免上版同名双 factory 必须新增退出门的问题。代价是维护应用工具门面、Chrome 动作适配和权限名过渡；完整运行时、取消排空与页面兼容仍需 POC，不把源码可组合视为端到端已通过。

侧栏用户操作保持原设计：真实页面、地址栏、标签、登录、下载、录制标注、介入和分离窗口。变化主要在工具内部名和资源所有权；历史不改写。旧 custom allowlist 仅允许 browser 的情况不能被假定自动授权 web_browser，见[权限名过渡](browser-runtime-design.md#权限名过渡与遮蔽来源)。

### 后续完整方案的交付范围

- 桌面聊天的内置浏览器保持真实网页、历史、登录、下载、PDF、查找、标注、录制、人工介入和侧栏分离能力。
- 产品可编辑的、隔离 `agentTurn` 定时任务使用浏览器时继承全局模式；选择内置才使用本设计的后台宿主。沿用任务权限，`systemEvent`、脚本/命令、托管和高级任务不自动获得控制能力。
- 正在运行的后台页面可在侧栏只读查看；需要操作时先停止并取得精确终态，再人工接管。
- Chrome 扩展会话只操作本轮授权并核验的 Chrome 标签，其标签授权不被定时任务继承；定时任务选择 Chrome 时按全局所选 driver 独立准入。

### “后台”和“无头”的边界

| 方案                     | 能否不显示窗口        | 是否仍排版、执行脚本和绘制         | 同一页面直接放回侧栏                 | 本期选择                            |
| ------------------------ | --------------------- | ---------------------------------- | ------------------------------------ | ----------------------------------- |
| Main WCV + 隐藏 carrier  | 可以，待 Windows 实测 | 需要；根据页面和截图发生绘制       | 拟通过移动同一个 View 实现           | 首选                                |
| Electron offscreen       | 可以                  | 需要，输出位图或 GPU 纹理          | 不是仅切换一个显示开关，需另行验证   | 不作为前提                          |
| 独立 Chromium headless   | 可以                  | 仍需要 DOM/layout/JS，截图也要绘制 | 不能直接变成应用 WCV；需另做可视接管 | POC 失败后的独立备选                |
| CSS 隐藏现有 `<webview>` | 可以隐藏 UI           | guest 可能继续工作                 | 页面已在 UI 中                       | 不能解决创建与生命周期依赖 Renderer |

Electron 的 offscreen 文档描述的是绘制输出方式，不能据此推导“没有渲染”。本方案对用户展示“后台内置浏览器”，内部状态保留准确宿主信息，不把 `show:false` 伪装为 Chromium `headless:true`。[Electron offscreen](https://www.electronjs.org/docs/latest/tutorial/offscreen-rendering)

## 与当前实现的差异

现行能力由功能文档维护；以下代码入口用于避免重复设计已实现机制，并标明下一步迁移边界。

| 现有机制                                                        | 入口                                                                                                   | 本方案剩余差异                                                                             |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| 原生/内置工具同名 `browser`，按模式互斥                         | `plugins/extensions/embedded-browser/index.ts`；`src/main/openclaw/config/plugins/pluginProjection.ts` | 未来单门面与原生服务共存需要新目录/权限投影                                                |
| 真实 native run、toolCall、toolAuthority 与 v2 live guard       | `plugins/extensions/embedded-browser/browserRunAdmission.ts`                                           | 复用已实现准入；扩到门面后须重新证明 Chrome 调用边界                                       |
| 带 run/toolCall 的请求及 prepare/commit/取消/撤权               | `browserExecutionContract.ts`、`index.ts`；`src/main/browser/embeddedBrowserGatewayBridge.ts`          | 不从旧 `{requestId, sessionKey, command}` 桥重新起步；新门面仍需复核通道最小权限与未知回执 |
| 内置 cron 已核验 editable、isolated、agentTurn 并使用原生工作区 | `src/main/browser/embeddedBrowserGatewayBridge.ts` 的 `prepareScope()`                                 | 当前后台准入已实现；未来 Chrome 路由和新偏好尚未接入                                       |
| 前台 Renderer webview，后台 Main-owned 离屏 BrowserWindow       | `BrowserPanel.tsx`、`src/main/browser/backgroundBrowserHost.ts`                                        | 统一 WCV 才能研究同实例前后台显示与接管；不能声称现有后台页可直接移入侧栏                  |
| 后台 CDP 输入与前台输入分别处理                                 | `src/main/browser/agent/browserAgentActions.ts`                                                        | 新宿主保留既有输入能力，按 G1 做迁移验证                                                   |
| foreground guest 与 background registry 分别验证                | `browserAgentBridge.ts`、`backgroundBrowserGuestRegistry.ts`                                           | WCV 必须有精确 registry，不能宽泛放行所有窗口                                              |
| 工作区 WCV 承载侧栏壳并支持同组分离                             | `src/main/core/window/workspaceWindowManager.ts`                                                       | 可复用展示几何，不等于真实网页已由统一宿主管理                                             |

全运行终态、ACK、final 与 idle 的边界继续遵循[引擎](../architecture/05-agent-engine.md)；
只读任务不因迁移自动获得浏览器权限。主计划与配套设计中的门面、Chrome grant、统一页面 registry 和
presentation lease 均为未来目标，不能据此推断已完成。

## 分阶段实施与验证门槛

现有内置后台实现不等于未来统一门面通过验收。以下门槛专门覆盖剩余差异；失败只能改应用适配或缩小已验证范围，不能悄悄新增原生 patch。

| 阶段      | 交付                            | 放行条件                                                                                                                                                          |
| --------- | ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P0-A / G0 | 现有准入/命令协议迁移至门面     | 复用 exact run 与 prepare/commit；验证改名后的 authority、通道可见范围、epoch、unknown 查询与迟到 commit                                                          |
| P0-B / G1 | Windows 统一 WCV 隐藏宿主 POC   | 对照现有后台 BrowserWindow，复核无焦点中文输入、快捷键、iframe、canvas、文件、截图及锁屏/睡眠行为                                                                 |
| P0-C / G2 | 同实例侧栏与 overlay            | WCV/表单/history 保留，DPI/viewport 正确，不穿透、不盖审批，崩溃/陈旧 bounds 安全                                                                                 |
| P0-D / G3 | 门面 → 原生 RPC 与 Chrome grant | deny 后 RPC/relay 仍可用；原权限/host-sandbox 不扩权；producer 保留 in-process resolver，缺失不取 token/不建 WS；target/batch 固定，signal/撤权/真实 drain 可证明 |
| P0-E / G4 | 扩展现有 backend 上下文回归     | 当前 014 字节不变，24k 边界/并发/关闭采集/停止/迟到响应与历史正确                                                                                                 |
| P0-F / G5 | 单门面目录、配置来源与权限过渡  | 模型 schema/Search/Code Mode/effective 只有 web_browser；Full/readonly/custom/用户 deny 均保留真实语义，非产品入口不误伤                                          |
| P1        | 门面与配置切换                  | G3/G5 后实现显式 Chrome 动作映射、Plan Mode/历史分类、plugin 禁用保护；无 raw RPC schema                                                                          |
| P2        | Main 宿主与现有 UI 迁移         | G1/G2 后迁移；录制/标注/下载/PDF/查找/凭据/分离均无静默退化                                                                                                       |
| P3        | 既有内置 cron 向统一宿主迁移    | G0/P1/P2 后保留既有隔离准入/工作区/终态语义，验证新 profile/展示与 Chrome 路由                                                                                    |
| P4        | Chrome 扩展控制                 | G3/G4/G5 后；保留 app-server backend 发送，目标授权与正文采集分别验证                                                                                             |
| P5        | 离线交付与独立审查              | 冷启动、公网阻断、真实站点、崩溃/睡眠、权限负例与多代理 code review                                                                                               |

不以 RPC 返回 AbortError、Stop ACK、chat final 或 idle 解锁人工控制。无法证明底层排空时记录 unknown 并保持锁。公开 in-process 不满足原始权限/信号边界的 producer，不能转用 admin WS 兜底；单独评估有界受支持 transport 后再放行。

### 必要行为证据

- 有效目录：两个插件 enabled、native browser denied；默认/目录/Tool Search/Code Mode、模型 fallback/compaction、tools.effective 均只含一个门面。静态能力全集不作有效目录证据。
- 路由：四种设置 × 普通/cron/扩展；扩展固定真实 Chrome 标签，缺绑定/并发/关闭/撤权不回落普通 profile。
- 权限：Full 可用、readonly 无浏览器、custom 旧名保持限制；字面 browser、group:ui/group:openclaw、bro*、plugin/agent/provider/channel/sandbox/MXC 禁止均不能被工具改名/遮蔽 receipt 绕过；外部入口逐层覆盖。
- Chrome：所有嵌套目标、外部 node、全局宿主动作、原生 idle cleanup、tabScope 非授权负例；RPC 已返回的 chooser/dialog/download armed 状态撤销；产物路径、模型视觉、私密媒体及网页不可信结果契约。
- 生命周期：原始 AbortSignal、低权限拒绝、reset/config/连接代次改变、已提交未知、底层 RPC/Playwright drain、late result；不重试提交或上传。
- 内置：页面/incarnation/document/ref/viewport 错配、pending capacity、profile 手工并发、guest IPC/overlay、主 Renderer reload、分离/隐藏与恢复。
- 清理：只关闭本运行创建的页，借用 Chrome 不关闭，不删除 native session；退出后无悬挂 host/debugger/listener/部分下载。

### 证据边界

历史原生源码研究支持公开接口组合的候选路线；它不等于 G0–G5、统一 WCV 或安装包 POC
已通过。原设计阶段原生测试曾因依赖导出缺失而未执行，该历史环境故障不作为当前测试结论。
实施时使用锁定运行时建立最小真实 POC，再执行变更域必要检查。现有后台功能的验证限制
只在所属功能文档维护；本计划的门槛不能覆盖或抹去这些限制。

## 回退与后续文档

上线用领域 feature gate 区分门面/权限过渡、宿主迁移、后台和 Chrome grant。只在无活跃浏览器运行、双方资源 drain 且配置回读后切换目录；门面失败不能临时去掉 browser deny，让旧工具意外恢复控制。回退必须恢复同一受管配置回执对应的工具/政策组合，保留真实用户 deny、profile、历史与产物。宿主回退需重启并新建页面，不把活 WCV 热变回旧 webview，也不重放未知输入。

G1/G2 失败的备选顺序：隐藏 BrowserWindow 对照→在显式受限能力下继续研究 Electron→独立受管 Chromium headless 另案。最后一项会增加安装包、profile、可视接管和升级成本，不属于本方案暗含 fallback。纯 offscreen 与零渲染都不能当作已解决替代方案。

实施完成后，把当前合约分别合入 [浏览器设置](../features/browser/browser-settings-design.md)、[扩展侧聊](../features/browser/browser-extension-side-chat.md)、[人工介入](../features/browser/browser-intervention.md)、[分离侧栏](../features/workspace/detached-workspace.md)、[执行引擎](../architecture/05-agent-engine.md)、[定时任务](../architecture/08-scheduled-tasks.md)、[进程模型](../architecture/03-process-model.md)、[插件系统](../architecture/07-plugin-system.md) 和 [数据存储](../architecture/10-data-storage.md)。确认没有未实施要求后删除本计划；若仍有阻塞，只保留确切剩余需求。

## 离线交付、日志与资源

首期只使用已交付 Electron 和原生 SDK，避免新增浏览器安装器、Rust/Python 服务或外部模型代理。需要的新静态 overlay/脚本随安装包交付，通过现有 loopback、immutable asset、CSP 与导航守卫加载；不能使用公网 CDN、遥测、自动更新或首次使用下载兜底。若以后引入依赖，其离线下载 URL/文件/准备流程只写入 [offline-downloads](../offline-downloads.md)。

日志使用领域前缀，仅记录 epoch、哈希/截断后的运行定位、资源数、耗时和结构化错误；不记录 Cookie、nonce、auth header、完整页面正文、选区、密码或任务 prompt。允许的 metadata receipt 有界并清理，不借诊断建立 transcript 缓存。

量测 cold startup、页面创建、首个快照、动作耗时、carrier/page 内存、active/pending 数和释放后残留 WebContents；在清空缓存、公网阻断、中文/空格安装路径、100%/150%/200% DPI 下验证。截图和调试产物只保存本机合成页面，避免把真实账号数据写入仓库。
