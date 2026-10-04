# OpenClaw 9.8 逐功能再次复核

日期：2026-10-04。起点为 `4c83dac02`，本轮由主 Agent 和三个专项 Agent 重新阅读当前实现与相邻 `../openclaw` 的固定 9.8 源码契约。检查目标是 9.6→9.8 升级完整性，不是检索其他更新版本。此前报告保留历史验证时点，本报告记录本轮结果。

源码基准：9.6 的 tag object 为 `ce5bbdc244ee937246cc1700d1b224d020c3b599`，解引用 commit 为 `eb377ac59e6c9fd6c7705028034812becf00271b`；9.8 的 tag object 为 `b1c1c6d3af1f68bc82efbb6c92fb224c36df8683`，解引用 commit 为 `fc23bc864e4553c2d215e479eeec47b67a0bf943`。tag 对象不是代码 commit；发布包仍独立受 source-lock 约束。

## 功能清单与逐项检查

下表中的“复核”指本轮源码、契约和相关自动化检查，不等于真实账户、全部操作系统及安装包均已验收。专项报告会列出入口、边界和证据：

- [聊天、子任务、权限与 Plan](recheck-v2026.9.8-chat.md)
- [Gateway、浏览器、外部工具与 23 个补丁](recheck-v2026.9.8-platform.md)
- [任务、插件、记忆、模型及上游功能取舍](recheck-v2026.9.8-features.md)

| 序号 | 功能 | 本轮重点复核内容 | 证据归属／实际环境边界 |
| --- | --- | --- | --- |
| 1 | Thinking 消息流 | 思考首帧、追加、替换、折叠、重连恢复、会话切换隔离 | 聊天专项；真实提供方思考仍需账户验证 |
| 2 | Tool 消息流 | 工具开始／更新／结果／失败／skipped，工具结果与完整运行终态分开 | 聊天专项；不以工具结束推断 Agent 已结束 |
| 3 | Content 消息流 | 流式追加、正文替换、Markdown、final 去重和终态关联 | 聊天专项；原生协议和本地模型验证不能代替每家供应商 |
| 4 | 正式历史、分页与重连 | 原生游标、物理会话身份、历史代际变化、实时与历史合并 | 聊天专项；继续禁止应用持久正文缓存 |
| 5 | 已接受但待处理的输入 | 独立分页、回执、截断补全、取消／中断、转入正式历史后的去重 | 本轮修复明确失效记录的旧占位残留；主聊天和扩展分别核查 |
| 6 | 子任务／SubAgent | queued/running/terminal、控制父级、详情、停止、旧身份不能影响新执行 | 聊天专项；原生负责限流与调度 |
| 7 | 请求审批 | 原生 guarded 映射、审批请求、允许一次／拒绝、过期和恢复 | 聊天专项；请求审批与执行生命周期分别核实 |
| 8 | 智能审批 | 原生策略与应用选择映射、决策上下文和失败处理 | 聊天及模型专项；真实决策服务调用仍需账户 |
| 9 | 完全权限 | 原生 full 映射、沙箱／模型策略等独立限制不被绕过 | 聊天专项；完全权限并不伪造所有工具可用 |
| 10 | Plan 模式 | 只读规划、计划修订、版本绑定批准、取消和执行交接 | 聊天专项；旧批准不能授权新计划 |
| 11 | Goals | 启动、暂停、显式恢复、停止与实际运行结算 | 聊天及补丁 013；暂停不会自动恢复 |
| 12 | 定时任务 | CRUD、时区、计划解析、手动／定时运行、权限、回执分页、删除和恢复 | 功能专项；原生离线执行覆盖任务链，长时间定时需持续环境 |
| 13 | Workboard | 卡片 CRUD、评论、归档、关联会话／运行、执行和停止 | 功能专项；不再依赖已移除的通用 Tasks 注册表 |
| 14 | 记忆按钮和面板 | 首页入口、助手工作区、读取、搜索、索引状态／重建、dreaming | 功能专项；面板与原生记忆执行所有权分开 |
| 15 | 插件安装／开关／卸载 | 显式禁用保留、配置归属、安装错误、原生 reload 完成确认 | 功能及平台专项；外部市场下载受服务可用性影响 |
| 16 | Skills 与 Workshop | 内置清单、导入、启用、原生 metadata、提案修订与审批、安全删除 | 功能专项；不覆盖项目 AGENTS 与角色文件 |
| 17 | MCP | stdio／远程配置、启动参数、环境与凭据、Windows npm 和 Chrome | 功能及补丁专项；真实远程 MCP 需服务环境 |
| 18 | Hooks 与市场目录 | hook 生命周期、插件显式状态、离线目录、主动安装与自动下载边界 | 功能专项；未把目录展示等同于认证成功 |
| 19 | 浏览器扩展连接 | 原生 26 文件基线、relay v2、严格 JSON、授权标签、重连 | 平台专项；完整 Chrome／Edge MV3 与 native-host 配对需真实安装 |
| 20 | 浏览器扩展中的对话 | 独立 overlay、历史、流式、停止、待处理输入、旧回复不能结算新轮次 | 平台及聊天专项；与连接基线保持分离 |
| 21 | 软件侧边栏浏览器 | Electron guest、导航、窗口、下载、会话作用域和关闭清理 | 平台专项；区别于浏览器扩展对话侧栏 |
| 22 | Gateway 快速启动 | bundle、预编译、worker companion、缓存路径、健康及协议就绪 | 平台专项；不从单次时间推导性能承诺 |
| 23 | 热加载／热重启／冷重启 | 配置实际应用回执、合并／延迟重启、PID 和运行身份、防重复启动 | 平台专项；沿用原生运行恢复，不加旧版本数据迁移 |
| 24 | 语言模型 | provider/model 标识、能力、思考等级、默认继承、工具、fallback、取消 | 功能专项；未调用真实付费模型，不宣称全部供应商推理通过 |
| 25 | 决策／图像／视频模型 | decision_evaluate、SecretRef、默认模型、Kie／Z.AI／Novita、配置隔离 | 功能专项；视频生成和决策服务外呼仍需真实环境 |
| 26 | 语音与音频附件 | 实时 ASR、自定义端点、TTS、本地文件转写、沙箱边界、文件暂存 | 功能专项及本轮 localAudioAttachment 测试；设备和云服务另验 |
| 27 | Codex／Claude 等外部工具 | 设置入口、ACP 适配器、stateDir/acpx、显式覆盖、鉴权、取消和重启 | 平台专项；不以注册成功替代已登录账户执行 |
| 28 | 独立助手／协作 | 助手默认模型、角色工作区、项目 cwd、禁用／删除、agent-team 开关 | 聊天专项；历史归属不因助手删除丢失 |
| 29 | 附件与文件预览 | 原生媒体 metadata、MIME、中文空格路径、音视频 Range、文件编辑授权 | 本轮 32 文件／347 项附件、预览、worktree 等专项；另含媒体协议测试 |
| 30 | 会话 fork／reset／归档／删除／worktree | 原生 fork、Plan 状态、显示历史与模型重置边界、创建不确定性和取消保留 | 聊天、平台及根线程 worktree 检查；未实际操作用户工作区 |
| 31 | 会话诊断与导出 | 只读已连接 Gateway、真实会话身份、错误节选、脱敏、扫描缺口、ZIP | 本轮修复默认 main 身份错误；12 文件／118 项诊断和媒体专项通过 |
| 32 | 版本、wire、打包与补丁 | 9.8 固定版本、wire 文件名、23 补丁必要性、pristine 重建与冻结证明 | 平台专项逐补丁清单；不包含完整 NSIS 或其他系统产物验收 |
| 33 | 本次历史兼容移除 | 无旧 SQLite 迁移桥、启动门禁、旧 Decision 搬迁／工具改名、旧视频兼容 UI | 本轮再次静态核查；保留原生和既有产品初始化规则 |

## 根线程补充发现与修复

本轮发现并修复三类执行／显示问题，以及两处过时文档：

| 问题 | 修正 | 交叉检查 |
| --- | --- | --- |
| Main 收到 attempt 级 end/error 后，可能在 1.5 秒 fallback 中提前 complete | 仅 `executionSettled:true` 允许整轮收尾；保留 identity、sequence、compaction 与 Goal 分流 | 第二 Agent 对照普通执行与 ACP 原生 lifecycle，确认正式终态携带该字段 |
| 长 pending 输入在补全前被消费／撤回，旧占位可能残留 | 主聊天和 Main 侧栏读取均识别原生 `not_found/not_visible`，退役显示并追平正式历史；临时传输失败保留占位 | 第二 Agent 核对 native miss 与失败区别，不使用 transcript fallback |
| 独立助手／子任务诊断使用默认 main key | 使用 Main 可信原生绑定，采集入口捕获，日志扫描期间或历史读取期间改绑均丢弃证据 | 第二 Agent 建议补充日志期间改绑测试，已纳入 |
| AGENTS 仍要求保留旧 custom-video 记录 | 改为当前支持的原生 provider 配置要求 | 不恢复用户明确移除的旧配置兼容 |
| 补丁 028 README 误称仅产品命名空间 | 精确说明原生已授权 `operator.admin` cwd 范围 | 仅文档修正，没有更改授权代码或补丁哈希 |

诊断历史读取曾直接以应用 sessionId 拼出 `agent:main:justdo:…`。独立助手和原生子任务使用不同 key，因此可能漏读其失败证据。本轮由 Main 从可信会话记录提供身份：显式 nativeSessionKey 优先，否则按该助手构建托管 key；无身份不读取。采集后复核绑定，变化时丢弃历史节选。该身份不来自 Renderer，也不添加正文缓存或新持久字段。

新增回归覆盖独立助手、原生子会话、缺失身份以及采集期间改绑；原有离线、不启动 Gateway、脱敏、分代一致性和导出检查仍通过。文档同步到 `docs/features/session-diagnostics.md`。

附件／预览／worktree 检查读取了 native media 投影、音频 realpath 暂存、localmedia Range、原生 worktree 创建与取消确认、IPC fork 的 Plan 状态保留。没有发现本次升级需要新增的历史媒体转换或第二份持久消息记录。

## 上游新增能力与验收结论

9.7 的主要应用适配已经覆盖：统一 `decision_evaluate`、原生视频提供方、旧 Tasks 注册表移除、worker 化运行包、流式与 pending 协议、插件 reload 完成确认、Windows 路径／缓存／权限边界。原生的子任务调度、memory/cron 修复、模型 fallback 与模型目录通过运行包生效。

9.8 发布说明将自己定义为可靠性热修复，但固定 tag 还包含 GPT-6.1 Sol 等模型目录提交；本轮以实际源码和目录合同为准，没有只根据 changelog 标题断言“完全没有模型变化”。

以下仍未新增专用产品入口：逐条队列取消／队列数量、插件能力与账户状态预览、Incognito、Gemini Interactions、OpenAI Agents API、ChatGPT Beta 登录、Codex Ultrafast／Ultra、Lightpanda、多用户／云 worker／通话渠道。这些已在[升级功能取舍矩阵](review-v2026.9.8.md)及本轮功能专项逐项分类，不能写成已完成集成。涉及账户、部署或独立交互的功能也没有静默启用。

本轮专项证据：平台 66 文件／520 项；任务、插件、记忆与模型 104 文件／981 项；附件、预览与 worktree 等 32 文件／347 项；诊断及媒体首轮 12 文件／118 项。专项可能与最终全量重叠，不能简单相加形成所谓总测试数。诊断在交叉 review 后另补日志扫描期间改绑用例，以最终全量结果为准。

实际正式 9.8 Gateway 隔离 smoke 再次验证 Cron CRUD、本地 command 回执、Workboard CRUD、FTS memory.search 和 models.list，全部通过。没有读取真实用户数据库或使用付费模型。

另外重新执行真实 Gateway 离线聊天：2 次本地 SSE 请求，原生 read 工具读取合成文件，出现 thinking/item/tool/assistant 等流，正式历史 5 条。待处理输入 smoke 覆盖 21 条接纳、20+1 分页、重连、停止后 21 条取消记录，以及消费后原生 user idempotencyKey 去重；均通过。日志为 `.tmp/recheck-98-native-chat.log`、`.tmp/recheck-98-native-pending.log`。

## 最终全量与构建验证

全部代码修复及交叉 review 完成后，执行 `npm test -- --maxWorkers=4 --reporter=dot`：**655 文件中 647 通过、5 失败、3 跳过；6664 项中 6601 通过、17 失败、46 跳过**，耗时 152.36 秒。本轮新增 12 项通过，没有增加失败项。日志 `.tmp/recheck-98-final-full-tests.log`。

剩余 17 项仍是此前在升级前基线复现的同一组：builtinModelProvider 9、app/network 1、ConversationAgentSelector 4、ContextUsageIndicator 2、renderer-motion-styles 1。它们没有因本轮升级复核被隐去或改成跳过，也不能据“既有失败”宣称仓库全绿。SQLite 测试由统一 wrapper 执行，结束后恢复并核验 Electron ABI 146；包含各专项有意留给主线程的 SQLite 路径。

`npm run build`、`npm run lint`、`npx tsc --project electron-tsconfig.json` 和本轮 `git diff --check` 全部通过。日志分别为 `.tmp/recheck-98-final-build.log`、`recheck-98-final-lint.log`、`recheck-98-final-compile.log`。本轮没有改动生成的第三方富文本 bundle，不产生上一轮生成字面量的空白差异。

真实 Chromium 149.0.7827.55 再次通过：认证成功、四条拒绝路径、重复 JSON key 拒绝、历史、pending 显示／移除、发送、Thinking、折叠、正文、停止；页面错误 0。日志 `.tmp/recheck-98-final-chromium.log`。其 Chrome API 为测试替身，native-host 未执行，不能等同完整扩展安装配对。

最终构建的实际 Electron 在隔离 appData/userData/home 下通过 9 项检查：首页、三种权限选项、记忆、设置、模型、权限、插件、定时任务、Workboard。Gateway 为 running/2026.9.8，Renderer 错误 0。日志 `.tmp/recheck-98-final-electron-ui.log`，fixture `C:/Users/lianghao/AppData/Local/Temp/justdo-electron-ui-ADdiEa`。这是未打包应用的真实页面验证，不是 NSIS 安装验收。

最终 Gateway 生命周期实测再次通过：热加载与热重启保持进程，冷重启更换进程、会话状态保留。本次隔离观测首次启动 14.339 秒、再次启动 11.667 秒、热重启 34.664 秒；不是性能承诺。日志 `.tmp/recheck-98-final-lifecycle.log`，fixture `C:/Users/lianghao/AppData/Local/Temp/justdo-lifecycle-smoke-9OjQPG`。使用全新合成状态，没有执行旧版本数据升级。测试关闭自身创建的进程，不关闭用户浏览器或其他工作进程。

## 尚未完成的真实环境验收

真实收费语言／Decision／图像／视频模型、已登录 Codex／Claude 的完整工具执行、Chrome／Edge 实际扩展安装与 native-host 配对、Windows MXC 完整沙箱任务、麦克风／扬声器硬件、完整 NSIS 及 macOS/Linux 安装包仍未在本轮执行。对应功能已经审查代码和测试合同，但不能宣称这些真实环境场景全部通过。长期定时和真实忙任务下的重启还需持续环境观察。

本轮没有增加历史迁移，没有修改运行包证明，没有推送仓库，也没有改动用户原有未跟踪的 `docs/features/intranet-plugin-expansion-plan.md`。
