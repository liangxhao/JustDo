# OpenClaw v2026.10.4 验收记录

本页保留各阶段的验证、复审、产物身份与未验收范围；不同阶段结果不能合并为同一产物的证明。本次整理没有重新执行这些验证。

## 会话复制与消息分支专项复审（2026-10-17）

对照目标源码的 `sessions-create` / `session-create-service`、`sessions-rewind`、
SQLite parent-fork/message-cut 与当前 012 补丁后，保留现有两个原生调用路径。
10.4 原生默认 fork 仍在用户消息前切断，不能替代包含选中助手回复的受管分支。
不扩大 Worktree 或 Agent Team 的复制准入，也不增加运行时补丁。

产品适配收紧三处：复制/分支的计时回执按目标原生 run 身份精确筛选；创建、准备与 Goal 清理
核对同一物理身份；创建结果不明或后续准备失败时保留列表恢复记录，不先删除产品
目标再进行无人核对的原生清理。只有已收到创建响应并确认原生目标不存在时撤销记录。
明确失败与成功仍分开，恢复项不会自动选中或重发复制请求。

独立 agent 复审发现并修复两项 P2：按产品时间/随机 ID 排序仍可能误带同时间戳或
off-path 回执；普通 error 恢复项可能经继续、模型选择或侧聊创建/执行空目标。
现以稳定原生历史的 run ID 成员集筛选计时，持久 pending 标记阻止未完成目标继续；
Main 与 Renderer Wrapper 分别覆盖准备/运行/设置及直接 Gateway 发送旁路。
补测覆盖重复时间、旧分支回执、分页失败/身份变化/超限、明确拒绝与丢失回执、
重启后的隔离及旧 Renderer ref。当前恢复项供检查/删除，不提供未经核验的自动继续。

`scripts/test/verify-native-session-branching.mjs` 在当前准备运行时、Node 24.21.0 的
独立合成状态中通过六组原生验证：完整分支复制保留工具配对及最新 Code Mode
store entry；历史回复/最新回复均精确包含切点；历史分支排除后续消息和 store 写入；
工具调用中途切点被拒绝、来源记录不变。另启动独立 Gateway 验证真实 create/fork、
history cursor/计时 ID 投影及目标冲突拒绝；退出状态为 0。没有启动用户 Gateway、
调用模型或读取用户 transcript；它不证明真实 UI 操作、
模型在分支后主动读取 store、冷归档或断线重连场景已人工验收。

本地证据：`.agent-tasks/runtime/session-branching/probe-rywEsx/result.json`，包含运行时
版本及 bundle SHA-256。复审后专项 7 个文件、219 项测试通过；最终全量 Vitest
为 924 个文件、11,124 项通过，另有 5 个文件、60 项按现有条件跳过。
lint、build、Main 与 Renderer 类型检查通过。最终 agent 复核无新增阻塞项。

首轮全量发现一个新增测试引用了不存在的 IPC 常量，已改为现有 handler channel
并复跑通过；另有本地 ACPX 仍为 0.19.1、锁文件要求 0.19.5，以及 SDK 类型测试
并行负载下超时。后两项分别经独立依赖与单独复跑确认，再以 2 workers 完整重跑通过。
测试文件中的超时预算未调整。由于当前 Electron 原生库文件被占用，SQLite 用相同
锁定版本 12.11.1 的 Node ABI 预构建库在临时 Vitest alias 中执行；ACPX 依照现有
锁文件在独立目录 `npm ci --ignore-scripts`，通过 `ACPX_RUNTIME_TEST_PACKAGE` 选择。
这些测试环境文件及日志均留在 `.agent-tasks/runtime/session-branching/`，未覆盖应用
当前运行目录或修改依赖锁文件，也不提交原生日志。

## 技能发现与 Code Mode 中间结果专项验证（2026-10-17）

在独立 worktree `codex/verify-native-skill-state`、应用提交 `3b58e5a9e` 上从锁定
pristine 重建 28 项补丁运行时并通过补丁核验。专项探针在 Node `24.21.0` 与
Electron `42.7.0`（Node `24.18.0`）运行，均确认两项能力已接入，无需新增产品实现：

- 提示词未列出的已安装技能仍可搜索，并可读取完整说明；禁用技能和读取权限受到
  原生约束，Code Mode 的技能接口使用同一目录。
- 显式 `store/load` 可跨 cell、后续用户回合和 Gateway 重启保存 JSON；会话相互隔离，
  失败及取消的未完成 cell 不提交，超大值被拒绝，删除在后续回合生效。

每种环境先完成 16 项检查；旧探针的关闭检查失败，未记为整轮通过。探针改为复用
应用的 shutdown preload 与 ready 消息后，在原有隔离状态上分别续验 5 项，包括
此前进程退出后的恢复、正常关闭后重启恢复、删除及显示历史过滤。两次续验均成功，
最终测试进程正常退出。没有重发未知的用户执行，也没有读取用户 transcript。
本轮合成模型只负责确定性发出工具调用，不证明真实模型会主动选用技能或正确组织
Code Mode；未做 MXC 实机或安装版 UI 验收。Code Mode 仍需启用其现有开关。

专项相关的 48 项单元测试通过；配置用例另有 6 项分批通过，其中最后 2 项单独复测
显式使用 90 秒预算。扩展配置回归首测为 158 项通过、47 项默认 5 秒超时；中间一次
30 秒预算复测为 4 项通过、2 项超时，不将这些失败或筛选跳过项记为通过，也没有
修改产品代码或测试文件中的时限来掩盖失败。本次不声称完整回归套件通过。

复验入口为 `scripts/test/verify-native-skill-state-runtime.mjs`。本地证据位于
`.agent-tasks/runtime/skill-state/probe-035ccu/result.json`（Node）及
`probe-GZIdgl/result.json`（Electron），各自保留 `previousVerification` 分阶段结果；
证据和日志不提交。运行时身份：

- Gateway bundle SHA-256：`9f0fccdc673a45e3210bc7e29d96e97e1a87b8f0ef54418b1fba509a2f3f8638`。
- Patch set SHA-256：`b92cc1be485ce170fddda657b19a2800a63a13de2f67156dad96bf331e33dd55`。

以下历史升级记录与此专项按各自基线保留。

正文流式输出及输出中停止真实验收通过，Windows 目录包通过；Chrome 扩展配对按用户要求延期。最新复审与产物见[追加复审](#追加复审与补丁整体校验)，前序候选的测试和产物身份按各自阶段保留。

## MCP Apps 合回 dev（2026-10-18）

将 `codex/mcp-apps-research` 的单个功能提交 `cf4a47a4b` 合到 dev `497c970e9` 之上，保留后续会话分支恢复、Widget 30 秒读取期限、测试双 worker 配置及工具调用恢复的改动。解决同处修改后，补齐 Main/Renderer 的 App 会话门禁：原生分支创建结果待确认时，旧 App 回调、启动/安装引导及问题操作不能绕过原有隔离。

本次不恢复原 `030-mcp-app-operation-lifecycle.cjs`，不修改 dev 已有的 30 项补丁；现行 `030-tool-call-format-recovery.cjs` 属于另一能力。下方 28 项产物身份及 MiMo 证据仅属于原 worktree 阶段，不冒充合并后 dev 的新运行时构建。draw.io 资源已按 dev 的实际依赖从锁定本地归档重新准备；未覆盖现有 Gateway 的运行时。

合并后的 lint、生产 build、Electron 编译通过。交叉回归 51 个文件/742 项通过；补充的 Main/Renderer 门禁回归 2 个文件/16 项通过。dev 当前依赖下重新准备 3,141 项校验资源，实际 draw.io 冷 profile 公网请求为 0，编辑后 .drawio/PNG/SVG 导出通过。

完整 Vitest 使用现有隔离配置 `.agent-tasks/runtime/session-branching/vitest.config.ts` 导入当前仓库配置（包括新插件测试），以相同版本 12.11.1 的独立 Node SQLite alias 和锁定 ACPX 0.19.5 fixture 执行，未切换/覆盖运行中 Electron 的原生依赖。2 workers、30 秒 test/hook 预算下，首轮 959 个文件/11,794 项通过、4 个文件/60 项条件跳过；`inspect-session-storage.test.ts` 的一项原有测试发生 30 秒超时，该文件和脚本本次均未修改。整轮结束后按原时限单独复测该文件，5 项全部通过（3.11 秒）。保留首次超时，不将其记作首轮全量全绿；未修改断言、预算或跳过失败项。证据在 `.agent-tasks/mcp-apps/merge-{full-tests,storage-recheck}.log`，不提交原始日志。

## MCP Apps 改用原生生命周期（2026-10-18）

经锁定源码与公开 SDK 复核、用户明确确认，删除原 MCP Apps 生命周期补丁 `030-mcp-app-operation-lifecycle.cjs` 及其 helper，该 worktree 当时回到 28 项原有补丁。工具、资源、审批、提问、文件、上下文与标准 AppBridge 继续使用原生认证 WS；宿主和表单预览不再要求本地 appIdentity/hostLeaseId 字段。

关闭停止本地交互并尝试清理已知精确 updateId；已发出的操作可能继续，视图和临时授权按原生租约回收，最长为创建后约十分钟。这个取舍不是协议功能缺失。后续升级必须重新核对公开取消与最终视图释放接口，见[升级清单](../../upgrade-checklist/checklist.md#21-mcp-apps-原生生命周期)和[宿主契约](../../features/chat/mcp-apps.md#原生接口与插件替代审计)。下节指纹和补丁测试仅对应已移除 030 的历史候选，不能作为当前产物证明。

Windows x64 已从锁定 pristine 包强制重建、bundle、资源同步、预编译和裁剪，并通过 28 项补丁最终校验。该 worktree 验证时 Gateway bundle SHA-256 为 `2a807004b695065822a99608d5fad70d94a027198fb388825b8e27172ff4449b`，patch set 为 `b92cc1be485ce170fddda657b19a2800a63a13de2f67156dad96bf331e33dd55`，build recipe 为 `fef5a727d2dc0acdaaffd6b113d27d01a12f0713b3fef058b98d296245bef30a`。

两个 Agent 只读复审后，修复旧展示关闭误清新上下文的代次及展示归属竞态；最新 51 项相关测试、lint/build 和 Electron 编译通过。实际 Gateway 探针通过工具授权/拒绝、原生问题、设置、资源、精确上下文移除、文件保存/ETag 冲突/订阅/边界和跨会话拒绝，确认本地取消后的后台完成且无自动重发。消息与工作区 Chromium 探针通过；实际运行时 draw.io 冷 profile 公网请求为 0，编辑后的 .drawio/PNG/SVG 导出均通过。

已获准使用的 MiMo `mimo-v2.6-flash` 在隔离原生会话完成真实绘图，精确 `executionSettled:true` 终态和原生历史确认实际模型及 `drawio__create_diagram` 调用；随后通过实际认证 Gateway 加载可编辑界面。冷启动浏览器公网请求为 0，.drawio/PNG/SVG 三种实际导出通过。此项使用现有公网模型仅做开发验证，不代替企业内网模型或完整安装版验收。

最终完整运行时冻结后重新执行 `npm test -- --maxWorkers=2 --testTimeout=30000 --hookTimeout=30000`：931 个测试文件、10,896 项测试通过，6 个文件/66 项条件跳过；结束后恢复 Electron ABI 146。前一轮与运行时重建并行、读到替换中文件的测试已作废，不计入本记录结论。完整安装版、企业内网模型和前述人工组合场景仍需另行验收。

## 历史候选：MCP Apps 宿主追加验证（2026-10-17，含已移除的 030）

`codex/mcp-apps-research` 在同一锁定 npm 包上加入 030：连接/请求绑定的 MCP App 取消、展示租约和最终视图回收，仍由原生会话、请求者、工具、问题与文件策略授权。产品宿主及当前限制见 [MCP Apps](../../features/chat/mcp-apps.md)。未改变 OpenClaw 版本，也未在旧产物上改写 proof。

Windows x64 从 pristine 完整安装、打包、bundle、插件资源同步、预编译及裁剪成功；最终校验确认 29 项补丁。Gateway bundle SHA-256 为 `0a7d9c0b2d2ca783e39d24614361cefb3e3ef2db324b1f1dff5f0071b62cf810`，patch set 为 `fbc64f2cdaa9b93926d4afd2606701696805fe19f075d6e4a30a88c88945200d`，build recipe 为 `de0289b318b77b3ab5e4caeb98393404bcd959978bfca77b1829b69294d452d5`。

三路 Agent 审查后修复取消读取的未交付租约回收、部分补丁形态拒绝、真实原生历史预览恢复、展开后关闭覆盖层和关闭中的草稿确认竞态。React 入口、设置和原生提问采用紧凑控件，补充必选校验、可选数值和首页迟到响应测试；真实产品组件已检查明暗主题和窄窗口截图。

最终 launcher 的隔离 stdio MCP 探针已通过：入口、视图内授权与拒绝、精确取消、原生问题、设置、资源搜索、上下文、文件保存/冲突/订阅/边界和释放。两个父文档的 Chromium 探针通过 SDK 握手、初始结果、一次工具调用、伪造来源拒绝、展开保留输入、主题更新和 teardown 后释放。以上均不发送模型请求。

本次全量 `npm test -- --maxWorkers=2 --testTimeout=30000 --hookTimeout=30000` 通过 10,864 项，条件跳过 66 项（926 个测试文件通过，6 个跳过）；结束后已恢复 Electron ABI 146。`npm run lint`、`npm run build` 与 `npm run compile:electron` 均通过。

全量回归后追加修复 ToolSearch 原生嵌套活动的历史恢复，并以真实 nested live 事件验证 `reduceAgentEvent → projectTurnItems`。最终 `npm test -- src/renderer/libs/openclaw-chat --maxWorkers=2 --testTimeout=30000 --hookTimeout=30000` 通过 108 个聊天模块测试文件、1,717 项测试，随后恢复 Electron ABI 146 并重新执行 lint/build；该追加改动未改变上述运行时指纹。

安装版、企业 MCP 服务/代理、富表单预览/上传/秘密存储组合，以及实际独立窗口最小化等人工场景仍待验收；前述历史 Windows 目录包通过不能替代这次新增宿主的安装版验证。

## 首轮验证证据（25 项补丁构建）

原生执行探针使用独立 state、合成内容和 loopback 测试服务，不读取用户 transcript，不使用生产 Gateway。随后按用户要求，以独立产品 profile 和已配置的 MiMo 模型补做真实界面验收，具体范围见[真实界面验收记录](validation.md)。

本机原始输出保留在仓库外 `E:\workspace\openclaw-upgrade-2026-10-4\`，不提交原生日志。原生证据包括 `owned-execution-{final,electron-final}.log`、`peer-return-{final,electron-final}.log`、`sqlite-lifecycle-{node,electron}-final.log`、`gateway-lifecycle-{node,electron}.log` 和 `ui-final.log`。复审后的构建、核验、完整测试及打包记录为 `runtime-build-reviewed.log`、`verify-reviewed.log`、`tests-reviewed.log` 和 `package-reviewed.log`；lint/build/Electron 编译为对应的 `*-review-final.log`。真实界面证据位于 `real-ui/`，本记录只保存汇总结论与产物身份。

| 范围                                                                                                                | 状态与证据                                                                                                                                                                                                                                                            |
| ------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 源包与补丁                                                                                                          | 通过：pristine 核验 12 项原生能力、25 项保留缺口；目标源码 apply/verify/当前形态幂等通过，历史/部分标记拒绝测试保留。最终产物核验另记下表。                                                                                                                           |
| 原生 owned execution                                                                                                | 通过源码 Gateway 探针：整轮结算及 cross-plugin 拒绝、后台进程消失后才清理结算、精确取消、重启后持久结算与 interrupted unknown；未知取消拒绝。最终冻结 bundle 在 Node/Electron 同场景均通过。                                                                          |
| SQLite                                                                                                              | 通过：真实原包阻塞对照、补丁并发写入与 timeout 恢复；六类生命周期在 Node/Electron 均通过：WAL 最新数据备份、回滚拒绝及成功/row ID 保留、删除排他、异常关闭不冒充 clean、正常退出/强制终止及重启完整性。                                                               |
| OpenAI 类型                                                                                                         | 85 个本地源码文件在目标 tag SDK 下 strict 检查无本地诊断；上游依赖闭包诊断单独排除，未声称上游整个仓库 tsc 通过。目标发布包缺少部分 SDK d.ts，故该检查使用锁定 tag 的 SDK 源码；实际加载另由发布产物测试验证。                                                        |
| 构建、完整测试、最终 manifest                                                                                       | 通过：强制 pristine 重建及预编译/裁剪，25 项 manifest/freeze 核验；lint、build、compile:electron 均通过；最终标准 npm test 为 907 文件通过、5 文件跳过，10,421 项通过、57 项跳过。跳过项不记为通过，当前目标 pristine topology 50 项及 facade 强制核验 3 项另行通过。 |
| Gateway/SDK、chat/history、压缩、摘要、权限、Goal/Plan、cron、Team/Workflow、插件生命周期、配置/认证、浏览器/工作区 | 按升级检查清单纳入完整自动化回归；本轮完整自动化已通过；最终 Gateway 的普通/溢出/取消/提供方失败压缩、五轮 peer return、QuickJS 及下述重启验证通过。自动化不替代下一节人工场景。                                                                                      |

非最终候选构建曾被缺失 companion、编译后变量重命名守卫或 stale recipe 正确拒绝；最终产物必须从 pristine 重新生成，不修改安装目录中的 bundle/manifest 来消除拒绝。

## 真实界面与复审

已使用现有配置的 `mimo/mimo-v2.6-flash`，在隔离 profile 中完成四个用户/任务回合，减少额外模型调用。实际验证停止按钮及原生 aborted 整轮结算、切换聊天后侧栏仍显示运行中、内嵌网页承载与输入/点击/导航/后退、Chrome 隔离窗口打开并点击网页，以及一次性定时任务在设定时刻触发并保存成功未读回执。三轮聊天均核对精确 native run 的 `executionSettled:true` 终态，未用 ACK、chat final 或 idle 替代。

三位 Agent 分别复审执行/SQLite、运行时与 OpenAI/Chrome/MXC、应用 wire/config/cron，修复 009/010/012 补丁对两类历史标记及文件头尾、提前返回路径的检查遗漏。三个补丁现在都在全部目标的历史标记检查通过后才写入；公开 apply/verify 的 source/bundle 拒绝、无部分写入及当前形态幂等回归共 120 项通过。没有发现其他已确认功能回归。

Chrome 窗口读取时，界面工具因无法可靠识别当前 URL 而结束自动化，之后未再操作界面。已完成范围和未完成交互分别保留在[真实界面验收记录](validation.md)，不将工具限制判为产品故障或全面通过。

后续独立验收已完成 browser 工具执行中停止、定时任务收件箱/立即运行/已读持久化及日常 Chrome 连接。普通正文无法流式显示被确认是新版全局 finalize hook 的缓冲门槛所致，新增 026 与两插件的精确归属声明；详见[续验与修复](validation.md#续验发现与修复普通会话无法流式显示)。这些变化不修改原生整轮终态、权限或 reasoning 规则。扩展配对因设置页自动化被浏览器策略拒绝；用户反馈已安装但无法配对，随后明确要求停止本轮扩展验收，留待其后续验证。

## 尚需真实环境验收

- 未验证：除上述 MiMo chat 外的真实内网 chat/image/embedding/STT/TTS/video 服务及账号轮换、麦克风/系统音频；本机 HTTP/WS fixtures 只证明协议和凭据隔离。
- 未验证：真实模型超过一小时的任务、yield/fallback、终端/子进程执行中的界面停止及完整人工审批/Goal/Plan/Team/Workflow 组合场景；browser 工具停止和定时任务收件箱/立即运行已续验。
- 未验证：Chrome 扩展配对/Tab Access、全新原生授权对话框、企业页面/下载/文件/PDF、MXC 实际隔离进程及电脑工具、不同 DPI/双屏/中文输入法/剪贴板；日常窗口实际连接已通过。
- 未验证：最终安装器交互、中文/空格安装路径、安装后首次启动与 packaged Renderer/Widget 组合人工验收；打包检查或隔离 Gateway 不能替代该项。
- 不适用本轮平台验收：macOS、Linux、Windows arm64；仅核对 arm64 MXC 锁定字节，未声称该平台启动通过。

上述项目不以历史通过记录或合成事件标为完成。代码及自动化可验范围与真实产品验收分别记录；尚无真实服务、设备和安装版的全面验收结论。

## 首轮命令与产物（25 项补丁构建）

| 命令/场景                                                     | 结果                                                                                                                                                                                                                                                                |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OPENCLAW_FORCE_INSTALL=1 npm run openclaw:runtime:win-x64`   | 成功；官方 MXC 2026.10.4，12 个本地扩展，51 个上游扩展明确裁剪；预编译 9 个、已有 JS/非目标 18 个跳过、0 错误。                                                                                                                                                     |
| `npm run openclaw:patches:verify`                             | 当前 25 项及冻结证明通过；完整 rebuilt source 和 bundle 共同校验。                                                                                                                                                                                                  |
| `npm run lint` / `npm run build` / `npm run compile:electron` | 串行通过；标准测试后 Electron ABI 146 已恢复。                                                                                                                                                                                                                      |
| `npm test -- --maxWorkers=4`                                  | 10,421 passed，57 skipped；未把旧版本 CI 专用开关全局套入本版测试。首轮发现的旧基线/旧 UI 断言已按真实目标修正；隔离安装最初跳过的 http-mitm-proxy 初始化补齐后，证书 9 项通过。另修正两条提示中的内部引擎名称，匹配 zh/en。                                        |
| `plugin-owned-execution.native-smoke.cjs`                     | 最终 bundle 在 Node/Electron 上的 settlement、跨插件拒绝、后台进程清理、取消、重启 unknown 全通过。                                                                                                                                                                 |
| `verify-peer-compaction-runtime.mjs` 四模式                   | 普通自动压缩、provider overflow、压缩期间 abort、压缩后 provider failure 均通过；失败以原生 `schema`/`format` 分类和持久历史核对，不依赖旧错误文案。新 context-only carrier 不再被本地 fixture 模型误认成当前任务；精确原生授权与终态断言保留。                     |
| `probe-agent-team-peer-return.mjs`                            | Node/Electron 各 5 轮、15 次本机模型请求，写作者与组织者各 5 个精确整轮终态，原生 grant/accepted receipt 和并发 history/list 通过。克隆探针实际复制 dist 子目录，遵守新版 public-surface 路径不得逃逸的校验。                                                       |
| `sqlite-retirement-lifecycle.native-smoke.mjs`                | 最终冻结 runtime 在 Node/Electron 上各 6 类全通过。                                                                                                                                                                                                                 |
| `gateway-lifecycle-smoke.cjs`                                 | Node cold/warm 22,956/25,941ms，hot restart 35,277ms；Electron cold/warm 19,330/22,053ms，hot restart 41,307ms；热配置/热重启同 PID、冷启动新 PID、sessionId 保留，均通过。并行高负载首测曾超过探针重连等待，独立复测确认，不修改产品等待策略来掩盖。               |
| `verify-code-mode-runtime.mjs`                                | 最终 QuickJS/WASM/encoding 资产、执行、wait/resume、UTF-8、失败和取消全通过。                                                                                                                                                                                       |
| 原生 `plugins list --json`                                    | 唯一 loaded openai，source 为运行时 `dist/extensions/openai/index.js`，providerIds 为 openai/video-openai。                                                                                                                                                         |
| 隔离 Electron UI                                              | 最终构建启动新 Gateway `2026.10.4`，首页、三种权限、记忆、设置、模型、沙箱、插件、定时任务、看板共 9 项通过；导航结束仍 running，Renderer page error 为 0。看板在一次性 profile 显式启用后验证空态，不改变原生默认禁用状态。                                        |
| Windows directory package                                     | 通过：npx electron-builder --config electron-builder.config.cjs --dir --win --x64；产物 release/win-unpacked。资源归档、包内 patch proof/companion、Node/npm/npx、浏览器扩展 2.3.0 及 better-sqlite3/node-pty Electron ABI 146 均通过。目录包不包含安装器交互验收。 |

首轮 UI 探针沿用了旧导航/中文标题，已按当前「更多」、沙箱与隔离、系统内置入口更新；未改变产品导航或隐藏失败。该检查使用实际 Electron 窗口和开发资源服务，不作为安装版 Renderer hosting 的证据。后续真实模型界面验收见上节；Windows 安装器交互和其余真实服务/设备保持未验证。

首轮 25 项补丁运行时身份（026 后的新构建另记）：

- patch set: `df4d6c71d7d9167bf11271305f21e3ed003b5df257cca612a41138fd154ab7ca`
- build recipe: `245eec99f34fddd3569017ffd5705450ec62eef36fa54d7b3ea3dc9ddc96edb4`
- Gateway bundle SHA-256: `c2c5d4848bc0608438c6c44cd5adb8ad78f02a4c39d0df07647c51b6532f66ee`（76751923 bytes）
- gateway.asar SHA-256: `9579fabadbba9304a82f2863e05ca6efa61c56e88ae651f7f14b0ef6cdbf7c29`
- runtime package SHA-256: `b6588b64f66016de8c020c9ff0b29ed4713b87af0ef955d3864066dcbfb038d3`
- npm-shrinkwrap SHA-256: `886d40c7b53c2b9d7ac45c19b5a7102ac2fc22ca45a267cc6d9adba9b824fc8a`
- Windows `win-resources.tar.zst` SHA-256: `787b9f14953547b1820e04735d716402b29e7923b335d98f166cd2e0b8690eff`（448568067 bytes）

发布包 source integrity、runtime package/shrinkwrap、全部 patch/support/extension assembly 的 hash 以冻结 manifest 为准。本次 Windows x64 目录包已通过包装阶段的归档 proof；最终再次执行 `npm run openclaw:patches:verify` 和 `git diff --check` 均通过。安装器交互与其他平台仍按前述范围保持未验证。

## 026 续验候选构建与产物

真实界面暴露了全局结束前钩子缓冲普通正文的问题，026 与两插件的身份准入修复经过三位 Agent 分工及独立终审。复审修正了公开选择器类型，以及 native/SDK 两组之间的不完整补丁状态拒绝。修改输入后的中间候选被陈旧 source proof 守卫拒绝；随后从官方 pristine 包完整重建，未修改安装目录中的 manifest 放行。

- `runtime-build-stream-final.log`：强制 pristine 重建通过，12 项上游能力、26 项保留缺口；9 个扩展预编译、0 错误。
- `verify-stream-final.log`：全部 26 项及最终冻结证明通过。
- `finalize-bundle-stream-final.log`：直接执行最终 bundle 的真实函数，39 项通过、1 项 pristine 源码专用断言跳过。普通正文在终态前发布、所属修订草稿保护、同一注册集合、身份失配拒绝、reset/retry/abort 及公开 apply/verify 的不完整状态零写入拒绝均覆盖；不通过再次 transform 掩盖最终 bundle 缺补丁。
- `lint-stream-fix.log`、`build-stream-fix.log`、`compile-stream-fix.log`：检查、前端构建和 Electron 编译通过。
- `tests-stream-final-rerun.log`：标准测试完整重跑，909 文件通过、5 文件跳过；10,465 项通过、63 项跳过，264.15 秒，Electron ABI 146 已恢复。首轮发现补丁清单测试遗漏 026，已同步精确清单；另一次 Vitest runner 初始化异常导致少收集一个文件，未查得根因。单独完整重跑已收集全部 914 文件、无失败或未处理错误，不将首轮失败计为通过。
- `package-stream-final.log`：Windows x64 目录包成功，包内 26 项 proof、companion、Node/npm/npx、浏览器扩展 2.3.0 及两项原生模块 Electron ABI 146 均通过。打包后 Gateway bundle hash 保持一致；目录包检查不代替安装器交互。

026 候选运行时身份（后续新会话初始化修复另行构建）：

- patch set：`e37ff60b4276564b7a62f3a177fdf6693027327963b238a26e9a377699272537`
- build recipe：`bca1a5b4a74bb4fd9a0c428e4cf73e1cb8fae125ffdcea45d7ecaaec44d2f64e`
- Gateway bundle：`6ea35fc0cbaedc23da3ed6efc13d9fc93de6ae82d712e45f941881c0210993f1`（76755154 bytes）
- gateway.asar：`c342ba23b0262d3be6f69184f663bc3e56bb6040999a66beb6899d969371c50a`
- runtime package：`b6588b64f66016de8c020c9ff0b29ed4713b87af0ef955d3864066dcbfb038d3`
- npm-shrinkwrap：`886d40c7b53c2b9d7ac45c19b5a7102ac2fc22ca45a267cc6d9adba9b824fc8a`
- Windows `win-resources.tar.zst`：`08346daa98782d38baa496ff2070ebee321d4faa434c99d2c9fda3ece2dfee3e`（448586364 bytes）

首轮的完整原生探针结果属于上文 25 项构建，不能冒充这个新 bundle 的重跑结果。

26 项候选的真实新会话续验又发现 canonical 准备与响应发布缺口：同一 `chat.startup` 请求反复响应，正文初始化未完成。独立复审确认 Windows 路径别名导致校验缓存状态分裂，且可重入读取在 pending 时已经发布响应。具体证据见[真实界面续验](validation.md#026-候选续验新会话初始化循环)。因此上文自动化和目录包通过不作为最终正文流界面通过记录。

## 最终 28 项构建

026 恢复普通会话正文的及时交付；027/028 修复 Windows canonical 准备路径及读取响应发布。真实界面已经验证新会话正常准备、正文 1 至 41 可见时任务仍在运行、输出继续增长及实际停止；精确整轮 aborted 终态在停止请求后约 261 ms 收敛，部分正文保留。重启后收件箱已读持久化、原生完整会话和未读空态也通过，详见[真实界面记录](validation.md#28-项候选的正文流与停止实测)。Chrome 扩展配对仍按用户要求留待后续验证。

最后一次严格语义复审补齐 SDK 同文件的 `Registration` 与 `RegistrationOptions`，产品选项精确实例化 finalize 泛型；两插件执行 JS 不变。三位 Agent 的执行、应用及独立运行时复审均通过，实际 SDK 正例和五类类型负例有效。同文件部分声明、source/bundle 混合形态和遗漏/额外/异名原生 worker 均在写入前拒绝。

- `runtime-build-ready-release.log`：再次从锁定 pristine 完整重建通过，12 项原生能力、28 项保留缺口；9 个扩展预编译，0 错误。仅本次进程临时优先使用 npm 缓存，未修改持久 npm 设置，也未跳过 integrity、源码拓扑或冻结检查。
- `verify-ready-release.log`：全部 28 项及最终冻结证明通过。
- `focused-ready-release.log`：最终产物三个专项文件 83 项通过、2 项条件跳过。SDK 语义检查直接使用实际发布声明，不先修复声明再测试。
- `probe-node-ready-release.log`、`probe-electron-ready-release.log`：Node 与显式等待退出的 Electron 各 31 项实际 SQLite、准备/响应及独立 state-read worker 函数断言通过。
- `tests-ready-release.log`：标准完整测试独立运行，910 文件通过、6 文件跳过；10,507 项通过、66 项跳过（265.67 秒），无失败或未处理错误。跳过项不计通过；实际发布 SDK 语义及最终 bundle 专项另按上列显式模式执行。测试结束已恢复并核对 Electron ABI 146。
- `package-ready-release.log`：Windows x64 目录包成功；归档 35,970 文件，包内 28 项 proof、companion、Node/npm/npx、浏览器扩展及两项原生模块 Electron ABI 146 检查通过。`verify-ready-post-package.log` 再次核对冻结证明通过。目录包成功不代替安装器交互验收。
- `lint-ready-release.log`：独立完整检查通过。此前一次检查器内部 `factory2.createJsxAttribute` 解析异常未查得根因；同一未修改文件单独检查、完整重跑及本次独立完整检查均通过，不把那次异常记为通过。
- 前端构建与 Electron 编译分别见 `build-ready-final-2.log`、`compile-ready-final-2.log`，均通过；最后仅修改的扩展类型已由严格 SDK 语义检查及重新预编译覆盖。

目录打包后再次无模型启动最终运行时，既有停止会话历史和可用输入、列表空闲、原生 cron 完整会话及收件箱已读持久化均通过。模型验收候选与最终启动后的 25,018 个执行/依赖文件及 package/lock 清单逐文件比较 **0 差异**，因此正文流与实际停止证据适用于最终执行代码。静态构建曾只差 Main 动态生成的 Windows preload 格式，源函数/编译函数 hash 均已对应并确认语义一致；未就地修补 vendor。Gateway bundle hash 始终一致，最终 SDK 声明则独立完成实际发布语义检查。

最终运行时身份：

- patch set：`97698346dc0e2f94032599b21ff518e99d1577fec2a92d65da589ffe21ce6022`
- build recipe：`4c2929fc2d40d145c4351c23c1ddf6221e33958d1f8c9e311cf42303a863ec60`
- Gateway bundle：`9f0fccdc673a45e3210bc7e29d96e97e1a87b8f0ef54418b1fba509a2f3f8638`（76755573 bytes）
- gateway.asar：`4e8ca60cda30d3e406d8812d7f4297d2ec142b6276027c68cc933cfa937ea2cc`
- runtime package：`b6588b64f66016de8c020c9ff0b29ed4713b87af0ef955d3864066dcbfb038d3`
- npm-shrinkwrap：`886d40c7b53c2b9d7ac45c19b5a7102ac2fc22ca45a267cc6d9adba9b824fc8a`
- Windows `win-resources.tar.zst`：`0eafa831d4bf623ea78a7f9add34aad4ace8ae6cd8ed86fece797b3d3626116b`（448635144 bytes）

## 追加复审与补丁整体校验

按用户要求再次由三位 Agent 对完整升级分支复审，并交叉检查彼此的修复。应用契约和供应链专项未发现新的产品行为错配；初次只读专项 14 文件、259 项通过，原生基线清单和冻结证明核对通过。随后从 025 的公开入口复现跨文件混合状态被补齐，扩展检查全部 28 项补丁，确认 001—025 还需补强写前校验。026—028 已有整组状态门禁。

本轮修复集中在构建校验：所有相关目标先在内存中完成转换、原生依赖检查和整体状态判断，再写入。覆盖 native/SDK/support/bundle 混合、一个 bundle 内的多个子能力、helper 与调用处不一致、缺失 disposition/Close schema，以及 fork/MXC/cron 的缺字段或重复条件。历史与部分形态拒绝时检查写入调用和逐文件字节均不变；当前完整形态幂等、既有编译 marker 规范化及正常生成内容保留。没有以补齐旧 sidecar、重试或更新 proof 来放行旧产物。

交叉复审补充的 003/004/008、012/013/016、017/020/022 细分负例均已修复；部分用例先在修前复现失败，再验证修后拒绝。共享公开入口专项最终 183 项通过；001—008 行为与准入 6 文件 71 项通过（其中准入 58 项），017—024 8 文件 144 项通过、1 项条件跳过，025 独立 11 项通过。数字存在包含关系，不相加冒充独立用例总数。三组对实际 current 的公开 verify 全通过；003/004 另对 14 个真实 source/bundle seam 只读变换，字节均不变。复审及这些检查未启动 Gateway、修改 vendor 或读取用户 transcript。

首次仅包含 025 修复的重建在生产依赖安装阶段被主动中止，以先完成其余入口的修复；该 staging 没有发布为 current。全部修复与交叉复审完成后才重新从锁定 pristine 构建。真实环境仍需补验的操作、预期及限制见[手动验收清单](validation.md#复审后的手动验收清单)，不将合成测试或历史结果扩大为已完成的人工场景。

`runtime-build-audit-final2.log` 记录本轮完整重建成功，扩展预编译 9 个、0 错误；`verify-audit-final.log` 的全部 28 项及冻结证明通过。与上一轮静态最终构建的 25,018 个执行/依赖文件逐项比较 **0 差异**（清单 SHA-256 `c29b4aa12abbd38bbce2fbaed89ebd9c8aae8a75ed0c451104bcf787db6927e6`）；7,272 个声明、JSON/MD 等资源只有 `runtime-build-info.json` 和 `runtime-patch-manifest.json` 两份构建证明变化。Gateway bundle、asar、package 和依赖锁 hash 均保持下列值。本轮未另启产品界面或真实模型，可保留前轮执行代码对应的流式输出/停止实测；此前 Main 动态生成 preload 的格式差异仍按前节记录，不冒充新界面验收。

本轮首次标准完整运行有两项失败：012 新增守卫后按测试计数为 602 行，超原 600 行预算；未改动的配置同步 Code Mode minimal 用例超 5 秒。仅为同时审计 schema、转发和 native/worker 投影的 012 设置 625 行有界例外，019 仍为 1200、其余仍为 600，经另一位 Agent 只读复审通过；没有挤掉安全校验或修改执行代码。配置逻辑和测试超时时限均未调整，两份失败所在文件独立复测 114 项全部通过（`audit-full-suite-repair.log`），随后以三个 worker 重跑完整套件。单次并行超时原因尚未确定，不将独立复测当作完整套件通过。

`tests-audit-final2.log` 的标准完整复跑成功：910 文件通过、6 文件跳过；**10,640 项通过、66 项跳过**（324.34 秒），无失败或未处理错误。此前超时的 minimal 配置同步在本次完整运行中用时 2,869 ms。结束后 Electron better-sqlite3 已恢复并核对 ABI 146。`focused-audit-final.log` 再次对本轮最终 SDK、bundle 和 canonical-read publication 运行三个专项文件，83 项通过、2 项条件跳过。

随后对本轮最终 bundle 运行 `plugin-owned-execution.native-smoke.cjs`，Node/Electron 各四类均通过：持久整轮结算与跨插件拒绝、后台进程消失后清理结算、精确取消，以及重启保留已结算证据、被中断运行保持 unknown 并拒绝不确定取消（`owned-node-audit-final.log`、`owned-electron-audit-final.log`）。使用独立 Gateway、状态和本机 HTTP 模型 fixture，没有调用用户配置的真实模型。两轮 Gateway 及其测试进程均已关闭。

`sqlite-retirement-lifecycle.native-smoke.mjs` 的备份更新、更新回滚、删除、错误关闭、正常退出及崩溃六类，在 Node/Electron 下各全部通过（`sqlite-node-audit-final.log`、`sqlite-electron-audit-final.log`）。Electron 最终函数/SQLite/Windows namespace/worker 专项另有 31 项通过（`readiness-electron-audit-final.log`）；Node 同项已包含在上述最终产物专项中。这些隔离原生检查不代替终端/子进程的界面停止及其余手测场景。

`package-audit-final.log` 记录本轮 Windows x64 目录包成功：归档 35,970 文件，包内 28 项 proof、companion 和原生模块 Electron ABI 146 核验通过；`verify-audit-post-package.log` 再次核对全部补丁与冻结证明通过。目录打包没有安装或启动产品，不代替安装器交互与手动验收。`lint-audit-final.log` 的完整源码检查通过，提交前 `git diff --check` 通过。

本轮最终构建身份：

- patch set：`b92cc1be485ce170fddda657b19a2800a63a13de2f67156dad96bf331e33dd55`
- build recipe：`b8c41a3fe43f036ea22023fad2520016e70ed1996fd11068242b4127898b476b`
- Gateway bundle：`9f0fccdc673a45e3210bc7e29d96e97e1a87b8f0ef54418b1fba509a2f3f8638`（76755573 bytes）
- gateway.asar：`4e8ca60cda30d3e406d8812d7f4297d2ec142b6276027c68cc933cfa937ea2cc`
- runtime package：`b6588b64f66016de8c020c9ff0b29ed4713b87af0ef955d3864066dcbfb038d3`
- npm-shrinkwrap：`886d40c7b53c2b9d7ac45c19b5a7102ac2fc22ca45a267cc6d9adba9b824fc8a`
- Windows `win-resources.tar.zst`：`e00ae923c7ba8aec5c4fcf00b8e4e65e03563bd112089dbdf70fbc82281da8b7`（448633466 bytes）

## Plugin Hub 生命周期复核

对照 `../openclaw` 的 v2026.10.4 源码、实际运行时及页面调用方复核四类管理流程。本轮只修改应用适配和展示，不增加运行时补丁、不替换活动运行时、不调用真实模型。

| 类型  | 本轮核对的流程与结论                                                                                                                                                                                                                                                                                              |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 扩展  | `plugins.list` 的配置开关与 `runtime` 健康状态分别处理。修复漏报 `runtime.error`、`service-failed` 及 `needs-setup`；保持原生启用意图、管理权限及卸载保护。安装审查、CLI 最终回执、原生 reload/refresh、卸载和失败后的清单对账维持现行协议。实际 CLI 验证安装、停用、保留停用状态更新、启用、卸载及移除后的清单。 |
| Skill | `skills.status/update`、开关回读确认、文件导入/覆盖/删除、同名有效来源与父扩展归属无新增协议错配。原生解析复核覆盖关闭赢家不切换来源、删除赢家后回退，以及两个工作区各自解析。没有独立执行测试按钮；列表可用性来自原生依赖与资格状态。                                                                            |
| MCP   | 用户配置 CRUD、原生配置投影、扩展连接发现/归属/只读参数/启停及测试保留原生语义。实际 native 与 bundle 两类连接覆盖清单、定向连接、工具/资源/提示发现、资源读取、停用后的显式测试、完整覆盖优先、错误脱敏及父扩展禁用；不调用工具或写回测试配置。                                                                  |
| Hook  | `hooks.status` 的 `enabledByConfig`、`requirementsSatisfied`、`loadable` 和 `blockedReason` 已接入；导入、开关、隔离删除、配置同步与 `plugins.refresh`、回滚及父扩展分组维持现行契约。独立 Hook 没有市场更新入口，同名导入拒绝覆盖；扩展附带 Hook 继续由父扩展管理。                                              |

验证证据在本机忽略目录 `.agent-tasks/plugin-hub/`，不提交原始日志：

- 新增回归先复现 4 个失败：3 类原生运行错误及没有环境缺失项的配置状态；修复后均通过。首轮两文件回归另有一项既有压缩包测试超过 5 秒；其文件夹/压缩包两种形式独立复测通过，后续广泛回归也通过，没有调整超时时限。
- `plugin-suite.log` / `.err.log`：使用 Electron Node 模式及可信 Windows preload，避免切换正在使用的 SQLite ABI。65 个完整文件、914 项通过；另一个原生 Skill 解析文件有 2 项通过、1 项 CLI 子进程超时。该文件随后按项目 Node 24 要求独立运行，3 项全部通过（`skill-native-rerun.log`，69.69 秒）。这些为分批结果，不宣称首轮整套无失败；Electron 子进程单次超时原因未确定。
- `extension-mcp-native.log`：`node --test tests/openclaw/runtime/extension-mcp.native-smoke.mjs` 通过；独立状态与连接，运行插件入口被故意设为抛错，证明清单和测试不会通过执行插件入口完成。
- `extension-lifecycle-native.log`：`node --test tests/openclaw/runtime/plugin-management.native-smoke.mjs` 通过（146.65 秒）。实际应用导入服务、安装器和 CLI 使用一次性配置、端口及凭据，覆盖保留停用策略的升级和最终移除；没有启动 Gateway，测试目录已清理。
- 完整 lint、Renderer/Electron 两组 `tsc --noEmit` 通过；现有运行时 28 项补丁冻结核验通过。没有为测试重建或替换使用中的原生模块。

尚需人工验收：重启开发应用使 Main 适配生效后，在插件页面验证真实本地扩展的审查/取消、热启停/更新/卸载及附带 Skill/MCP/Hook 刷新，观察实际注册/服务失败和待配置提示；对 Skill 导入/同名覆盖/开关/删除、MCP 编辑/测试/开关/删除及 Hook 导入/实际触发/停用/删除做界面闭环。真实企业市场提供方、远端 OAuth/TLS MCP、活动任务期间的插件热变更、权限拒绝和真实文件占用仍未在本轮覆盖。仓库默认未注册市场提供方；扩展/Skill 的自动更新依赖已安装市场身份和提供方能力，本地扩展/Skill 可重新导入，Hook 没有独立更新流程。现有 Chrome 扩展配对延期决定保持不变。

### 多 Agent 交叉复审补充

三名 Agent 分别检查安装更新、卸载归属与界面刷新，再交叉检查修复。补充修复如下：

- 本地交互式安装将人工确认的 `reviewToken` 传给原生 `plugins.install`，由最终 staging 核验能力面；不再用 CLI 无条件接受新能力。安装请求使用 10 分钟窗口，未知结果不重放。多入口包保留精确 manifest owner 与原生代表子 ID 的区别，按真实包目录核对出站策略和安装身份，不按子 ID 前缀猜路径。
- 已提交但运行态应用失败时，提交事实、原生 ID 和已核验路径穿过 Main 安装器与市场登记；市场保留版本身份，Renderer 显示错误和状态刷新，同版本不重新安装，在“可更新”筛选下也保留待处理反馈。无法确认的安装保留可能仍被原生读取的临时源；仅 Main 持有来源占用标记。
- 卸载超时或断线后只读核验清单和本次原路径，无法确认时报告待确认；只有明确未发送才允许离线 CLI 恢复。原生关联拒绝和包含目录占用文字的断线也不能触发重放。
- 已打开的扩展详情跟随成功清单更新，移除时关闭；Skill 订阅父扩展变更，已移除条目的详情不会因同 ID 恢复自动重开。MCP 保存、删除、开关和市场刷新前后使旧测试结果与在途代次失效。配置保存反馈受详情代次约束，迟到结果不污染另一详情或新草稿。

新增实际原生验证 `node --test tests/openclaw/runtime/plugin-capability-consent.native-smoke.mjs`：原能力面可接受旧令牌；增加工具后旧令牌被拒绝，即使存在原生自动确认回调；重新审查的新令牌可接受。另验证临时目录变化不改变相同能力面的令牌。此验证直接调用当前运行时的原生 staging consent，不执行插件入口、不启动 Gateway、不调用模型；它验证的是原生声明能力面令牌，不宣称冻结所有源码字节。

`node --test tests/openclaw/runtime/plugin-package-ownership.native-smoke.mjs` 的加强版也通过（`package-ownership-native-complete.log`，60.51 秒）。独立配置、端口和随机凭据，初始只允许无关的 `memory-core`；实际多入口 CLI 安装后两个子条目均启用，原生 ownership、真实 native catalog、应用列表路径和市场身份一致，列表不发生误刷新；已提交失败中的 owner 也规范到同一代表条目。最初真实样例暴露的 CLI 子 ID 终态匹配和 fixture 对具名原生导出的读取问题已修正。此样例不启动 Gateway，不代表真实在线热安装验收。

补充回归、类型和构建结果见本机 `.agent-tasks/plugin-hub/review-*.log`。`review-suite.log` 使用 Electron Node 与可信 preload，65 个文件、967 项通过；后续交叉修复的受影响文件另行复测，不把不同批次的重叠用例相加。

Renderer 末轮单文件回归分别为扩展 34、MCP 33、市场 35、Skill 21 项通过；Main IPC 与市场适配末轮 62 项通过。安装服务和安装源在隔离 Windows 锁查询后完整复测；锁归属专门用例仍显式提供对应诊断结果，实际原生能力审查继续由独立 fixture 验证，没有提高单测超时或改变生产文件锁诊断。

最终完整 lint、Renderer 构建和 Main `tsc --project electron-tsconfig.json --noEmit` 通过（`review-lint-verified.log`、`review-build-sealed.log`、`review-main-types-sealed.log`）。编译不切换 SQLite ABI；没有为本轮修改重新生成 OpenClaw 运行时。

所有补修完成后的五文件末轮回归 `review-final-regression.log` 为 217/217 通过，覆盖完整安装服务、Windows 安装源、扩展 IPC、市场 IPC 和市场服务；与此前 967 项整套回归有重叠，不相加为独立用例总数。

本轮没有进行真实界面验收或替换活动运行时。上述人工项仍需验证，尤其是新增在线本地安装的真实 Gateway 回执、权限/活动任务冲突、多入口包更新卸载，以及企业市场真实下载更新和远端认证 MCP。请在自行重启开发应用后验收；本轮未关闭正在使用的应用或 Gateway，也未切换 SQLite ABI。

## 2026-10-17 通用结构化思考与正文流式修复（029）

针对用户报告的思考后正文集中到达，新增 029，按原生归一后的思考/正文通道处理，不含模型、服务商或端点白名单。公开插件包装只能取得已经解析的事件，不能解除传输层缓冲；本轮保留小范围运行时补丁，不重写提供方传输。解析恢复、实时预览和原生终态交付的具体边界见[补丁总账](../../../scripts/patches/v2026.10.4/README.md)。三名 Agent 分别复核解析、事件/终态以及构建证明，最终只读复审未发现阻塞问题。

- 从锁定 pristine npm 包强制执行 `OPENCLAW_FORCE_INSTALL=1 npm run openclaw:runtime:host`，全流程成功；实际 source、最终 bundle、预编译和裁剪后 29 项补丁校验通过。不是修改旧运行目录或 manifest 来绕过校验。
- 225 项解析/传输/订阅/补丁形态测试通过；8 组无网络原包/补丁对照和实际重建包探针通过。任意模型、服务商、端点及传输别名的公开正文先于终态到达；显式 strict 仍保留原生缓冲。该证据不代表已经重新验收真实服务或界面。
- 完整 lint、应用构建通过。标准测试后已恢复并核验 Electron SQLite ABI 146。完整回归为 910 文件通过、5 文件失败、5 文件跳过，10,998 项通过、5 项失败、64 项跳过，并出现一次 V8 worker 异常；该批次不是全绿。
- 后续独立复验：配置超时所在筛选批次 13 项通过；记忆与浏览器历史两个完整文件 25 项通过；两个原生 Skill 契约文件均通过。记忆测试导入失败由已有整模块 mock 缺少 `execFile` 引起，仅改成保留其它导出的局部 mock，没有改生产链路。浏览器历史独立复验使用 60 秒 hook 等待，保留全部断言。
- 可选的第二份 pristine 全图构建测试超过 900 秒，未记为通过；正式 host 全图构建及实际产物证明已通过。Windows MCP 批次有一项 Chrome 子进程树清理无法确认，单项再次复验仍因原生进程快照的 2 秒命令上限超时；其余四项通过。该问题不在 029 修改范围内，不能作为全面子进程验收通过的证据。

本轮没有发起真实模型请求，未启动 Gateway 读取历史或直接读取 transcript。实际用户会话的首正文时间、结束前是否分段显示仍待重启后复测；前序真实验收结果不覆盖这份新构建。

本轮 Windows x64 运行时身份：

- patch set：`3f1a58a77cb9871758b0526fbffc663df6ebda0af19514b943bcdc95f4b37ae2`
- build recipe：`7894d6373d6e94185468e7ac79741c4bc7e7bb959d1b903c64096343d9d26f3b`
- Gateway bundle SHA-256：`c5f2d9c18b935aeb7d398b31b3de9176979805c7d679e37f3418ef7cab5c9158`（76,757,264 bytes）
- gateway.asar SHA-256：`cfe72b74327cdcaf9dc8d2ad74eb0c9270411055547ecaf4a7d9b20a58ee20b0`
- npm-shrinkwrap SHA-256：`886d40c7b53c2b9d7ac45c19b5a7102ac2fc22ca45a267cc6d9adba9b824fc8a`（本轮依赖版本及 integrity 未变化）

AI 传输与分区解析模块的精确身份和 hash 已纳入本轮 current/frozen manifest 及归档校验。本轮没有重新生成 Windows 安装包；旧包的打包结果不作为 029 的安装版验证。


## 真实界面验收与复审

日期：2026-10-16 至 17，Windows x64。使用升级 worktree 的实际 Electron 窗口和原生 Gateway；默认模型沿用用户已配置的 `mimo/mimo-v2.6-flash`，未使用回环假模型。仅将应用配置复制到仓库外的独立验收目录，不复制用户会话或原生 transcript。

## 首轮实测结果（25 项补丁构建）

| 功能         | 操作与观察                                                                                                                                                                                                                                    | 结论                                                                                                                          |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| 会话停止     | 通过聊天输入区发起数字列表任务；列表显示“运行中”，当前会话出现停止按钮。实际点击后显示 `The run was interrupted.` / `Stopped after 16s`，按钮恢复发送，列表不再显示运行中。                                                                   | 通过模型请求/思考阶段的实际停止；未验证正文流式输出中、后台工具或子进程中的界面停止。                                         |
| 会话列表状态 | Chrome 任务运行时切换到“新对话”，旧会话仍显示运行中；原生任务完成后，产品元数据两条验收会话均为 `idle`。                                                                                                                                      | 当前会话、切离后的后台会话及结束后状态收敛通过。                                                                              |
| 内嵌浏览器   | 从聊天发起 browser 打开网页并读取标题，模型返回 `Example Domain`，实际网页显示在侧边栏。随后在本机验收页输入 `UI_OK`、点击按钮得到 `1`、跳转第二页并后退，地址与内容正确，输入值保留。                                                        | 实际模型调用、页面承载、人工输入/点击/导航/后退通过。                                                                         |
| 定时任务     | 通过真实表单创建“运行时升级验收（一次）”，时间设为 22:18，默认模型、只读权限、仅应用内投递，提示仅回复 `CRON_UI_OK`。原生 22:18:03 开始运行，22:18:15 完成；产品保存 `success`、摘要 `CRON_UI_OK`、`read_at=null`。                           | UI 创建、实际到点触发、模型完成、成功/未读结果回执通过。未在本轮打开收件箱详情、标记已读或点击立即运行。                      |
| Chrome       | 通过设置切换为 Chrome/隔离连接；聊天请求打开本机验收页并点击 `Count 0`。实际 Chrome 窗口标题变为 `Browser Acceptance - Google Chrome`；认证 Gateway 历史记录最终回复“页面标题：Browser Acceptance，点击后按钮文字：1”，stopReason 为 `stop`。 | 隔离 Chrome 启动、实际模型 browser 操作及结果通过；最后的 Chrome 窗口截图被工具安全检查终止。日常 Chrome 授权与扩展配对未验。 |

Chrome 窗口读取时，computer-use 报告无法以足够置信度识别当前浏览器 URL，因而终止本轮界面自动化。此后未再发送界面输入，也没有换用其他 UI 自动化绕过限制。后续仅通过已运行 Gateway 的只读 API 及产品 metadata 核对先前任务结果；没有读取 transcript 文件或为诊断另启 Gateway。

停止、内嵌任务与 Chrome 任务还核对了产品已采集的原生诊断 metadata：三个精确 native run 均有 `executionSettled:true` 的整轮生命周期终态；停止一轮为 `phase:error / aborted:true / stopReason:aborted`，两个浏览器回合为 `phase:end / stopReason:stop`。不是用停止 ACK、chat final 或界面 idle 替代结算证据。脱敏投影保存在仓库外 `terminal-evidence.json`。

实际模型请求共四个用户/任务回合：停止任务、内嵌标题、Chrome 打开点击、单次 cron。产品自动标题及工具后续模型调用由原生正常执行，不把四个回合计为四次底层 API 请求。其余网页输入、按钮与导航使用界面操作，未额外请求模型。

原始输出与只读证据位于仓库外 `E:\workspace\openclaw-upgrade-2026-10-4\real-ui\`。配置、数据库、原生日志和完整历史不提交。验收实例及其子 Gateway/隔离 Chrome 已关闭。

补丁标记检查修复后再次从 pristine 完整重建，最终 Gateway bundle、gateway.asar、运行时 package 和 npm-shrinkwrap 的 hash 均与此次真实界面验收版本一致；执行文件字节未变。最终补丁/recipe 身份见[验收记录](validation.md)。

## 多 Agent 复审

三位 Agent 分别审查执行/SQLite、运行时与 OpenAI/Chrome/MXC、应用 wire/config/cron。前两组分别复跑 87 项和 108 项专项检查；应用契约组另跑 10 项。未发现其他已确认功能回归。

应用契约审查确认：补丁 009/010/012 的历史标记正则遗漏 `JUSTDO` 或 `RUNTIME` 前缀，公开 apply/verify 可接受混合历史标记。第一轮修复补齐前缀后，独立复审继续发现 009/012 只扫描局部函数体及提前返回的遗漏。本轮统一全文件检查，并要求三个补丁的全部目标的历史标记检查通过后才写入；公开 source/bundle 的历史标记拒绝、无部分写入、当前形态幂等及 fork 回归共 120 项通过。最终完整测试数量与重建身份见[验收记录](validation.md)。

这些首轮 review 和实测只支持上述范围。以下续验记录更新工具停止、收件箱与日常 Chrome 的范围；安装版验收仍未完成。

## 续验：工具停止、收件箱与日常 Chrome

继续使用同一独立 profile 和已配置的 MiMo，未读取用户 transcript。下面三项先在首轮的实际运行时完成；026 的重建与正文流复验另记，不把旧 bundle 的证据说成新 bundle 的执行结果。

- **工具执行中停止通过。** 模型使用内嵌 browser 导航本机 `/slow` 页面（故意等待 30 秒），界面显示正在使用工具、导航卡片与 Agent 操作遮罩时点击停止。HTTP 请求于 14:57:22.559 UTC 开始，14:57:41.165 连接关闭，`completed:false`。精确 native run `justdo-1792162629302-db576b60-7e1b-4bca-bc03-0beaae3c8a44` 于停止请求后约 219 ms 收到 `phase:error / executionSettled:true / aborted:true / stopReason:aborted`；工具结束、发送恢复、列表忙碌和网页操作遮罩均收敛。随后人工打开普通验收页并点击计数器得到 `1`。本项验证 browser 工具取消，不扩大为终端/子进程取消的界面验收。
- **定时任务收件箱通过。** 原到点任务 `CRON_UI_OK` 的完整原生会话可打开，自动已读并清除导航/收件箱角标；仅看未读显示空态。另从 UI 创建暂停的“运行时升级验收（手动）”，点击立即运行，实际模型完成后显示成功及新未读 `CRON_MANUAL_OK`。详情展示原生输入与回复；打开后自动已读，刷新后仍无未读。两个结果的 `read_at` 分别为 `1792162456551`、`1792163952385`，仅通过产品 metadata 只读核验。手动任务仍暂停，不留下自动触发。
- **日常 Chrome 连接通过。** 设置中切换到 Chrome 日常窗口模式，点击“测试连接并触发授权”，真实 `browser.request GET /tabs profile=user` 成功，UI 显示“已连接到 Chrome”。Chrome 已启用本机远程调试；没有声称本次观察到一个全新的原生 Allow 对话框，也没有自动点击浏览器身份授权。
- **扩展配对留待用户验证。** 产品测试如实显示扩展未连接。Browser Use 拒绝自动打开 `chrome-extension:` 设置页，仅允许 HTTP(S)，并明确禁止换入口绕过。用户反馈已安装但无法配对，随后明确要求本轮不再验证，留待其后续验收。因此不将配对、Tab Access 或实际扩展网页操作记为通过，也不把安全限制判为产品故障。

本段实际模型用户/任务回合为五轮：长数字停止、browser 工具停止、两个短数字诊断及 cron 手动运行。`/think off` 是原生命令，收件箱和连接测试不额外调用模型。实际自动标题及工具后续请求不折算为这五轮底层 API 次数。

## 续验发现与修复：普通会话无法流式显示

观察到纯数字正文只在整轮完成后出现。通过原生 `/think off` 确认会话配置后仍可复现，排除了只因 reasoning 延迟的解释。目标 pristine `prepareStream` 只要存在任意 `before_agent_finalize` 注册便启用 `deferTerminalDelivery`；常驻 Runtime Services 的 Team 发起守卫及可选 Workflow 都全局注册，即使 handler 最终不修订，也会拦住普通正文。

新增补丁 026，为结束前钩子声明身份级适用范围；prompt build 及宿主有效性核对后冻结本次 attempt 的 registration 和原 handler，正文交付与 final dispatch 使用同一集合。普通已确认非所属运行恢复实时交付，未知身份/损坏账本/异常或异步选择器继续保护，所属修订草稿不提前泄漏。精确终态、执行/修订权限及 reasoning 规则保持不变。契约见[执行引擎](../../architecture/05-agent-engine.md#轮末修订与流式交付)与[补丁总账](../../../scripts/patches/v2026.10.4/README.md)。

三位 Agent 分别完成 native 准入/交付、两插件归属适配和独立复审。独立复审指出选择器公开类型与实际身份投影不一致，已把公开契约收窄为相同五字段；另核对身份失配拒绝、冻结 handler、新注册不后插及未知保守行为，成稿无剩余阻塞发现。产品侧三个专项文件 141 项通过，追加断言后两所属文件 71 项通过。

终审另发现 native 整组与四份 SDK 整组状态不一致时，公开 apply 会补齐缺失组；已改为两组状态必须一致、写入前拒绝。source/bundle 双方向回退及零写入负例通过，pristine 专项共 39 项通过、1 项最终 bundle 专用断言跳过。该检查修复后重新从 pristine 完整构建，不就地修改运行时 proof。

## 026 候选续验：新会话初始化循环

26 项构建的检查、完整自动化及 Windows 目录包通过后，真实新会话首次提交 `/think off` 暴露另一问题：准备卡片后正文区空白，列表仍显示运行中。Gateway 对同一个 `chat.startup` 请求 ID 每约 2 ms 发布一次响应，导致其他只读请求超时。未由此把模型调用或正文流验收记为通过；发现后退出独立实例，停止重复读取。

两位 Agent 只读核对确认 Renderer 为每次请求创建不同 ID，且删除首个响应的等待项，未发现 Renderer 重发循环。原生 `withReadySessionRows` 会在 canonical 准备未完成时重入同步读取；内层 ACP 元数据读取可吞掉 private deferred signal，history handler 随后已经响应，外层仍判定 pending。

原生源码与隔离验证又确认 Windows 路径别名缺口：`db.location()` 带命名空间前缀，已登记物理身份的 filename 为规范普通路径；校验缓存虽是全局单例，却按两种不同路径键保存状态。准备器可能在一个键上已完成，读取者仍在另一个键上等待。修复使用已登记身份的 locator，保留显式路径、agent、物理 generation 与撤销保护；响应前在同一个同步 deferral owner 核对准备完成，pending 时交回原生准备流程。该场景不通过模拟响应、绕过历史准备或任意重试上限放行。

首次 28 项重建在目标拓扑检查处拒绝：锁定发布包的 `dist/state/openclaw-state-read.worker.js` 本身也内联两处路径函数，之前仅扫描根 `.mjs` 的验证漏掉了 worker。独立递归扫描 pristine 及实际 facade 阶段确认其并非构建新增副本。027 因此锁定根 canonical-key、validation-cache 及原生 worker 三个文件的精确路径集合；新增、遗漏、混合补丁状态均须在写入前拒绝。失败产物未发布，后续从 pristine 重新构建。

三位 Agent 追加复审：应用侧准入、原生执行/准备和独立运行时检查均无剩余阻塞。完整 pristine 递归复制 → 真实 facade → 全 28 项源码补丁 → 实际 Gateway entry 与生产 shared-SDK/ImportMeta resolver、external 列表的完整 esbuild 图 → 027/028 公开 verify → worker 回退零写拒绝，专项共 79 项通过、1 项跳过（185.9 秒）。格式化后排除已通过的昂贵整链再跑，78 项通过、2 项跳过；Node/Electron 各 31 项实际 SQLite 与独立 worker 函数断言通过。这些隔离证据仍不替代最终产物和后续真实新会话验收。

## 28 项候选的正文流与停止实测

10 月 17 日 00:55，在独立 profile 的全新会话只提交一次原生 `/think off`，约 8 秒后显示 `Thinking disabled.`，输入和列表状态正常收敛，未再出现同一 startup 响应循环。随后沿用已配置 MiMo，发起一轮逐行输出 1 至 5000 的模型任务；约 5 秒时真实窗口已显示 1 至 41，列表仍显示运行中，停止按钮可用，后续观察正文继续增长。

正文输出中实际点击停止，约 9 秒处结束，保留 183 个完整数字及末尾 `1` 残片。精确 native run `justdo-1792169757621-edfff187-c8d7-4c3e-87f9-ba5571e1fde1` 在 `1792169766670` 记录停止请求，`1792169766931` 收到 `phase:error / executionSettled:true / aborted:true / stopReason:aborted`，约 261 ms。此前的 chat aborted、非结算 lifecycle end 和 Stop ACK 均未用于判定整轮终止。原生 history 保留 625 字符的部分正文；其中 message stopReason 为 `stop`，同样不用于推断执行结局。界面显示 `The run was interrupted.`、发送按钮恢复、列表不再运行，产品 session `a0bdb85c-bf03-467c-8911-6e828c72c00f` 的 metadata 为 idle。

同一启动中再次打开定时任务收件箱：两个原有结果仍已读，手动任务仍暂停，完整原生会话可以打开并显示输入与 `CRON_MANUAL_OK`，仅看未读为空。本段只增加一轮实际模型正文请求；原生命令和收件箱读取不增加模型请求，自动标题请求仍由原生正常执行。

该候选全部 28 项冻结检查通过，最终函数专项 78 项通过、2 项条件跳过；Node 与显式等待退出的 Electron 进程各 31 项原生 SQLite/worker 断言通过。Gateway bundle 为 `9f0fccdc673a45e3210bc7e29d96e97e1a87b8f0ef54418b1fba509a2f3f8638`（76755573 bytes）。后续严格 SDK 语义复审发现声明类型遗漏，因而不把此候选直接当作最终发布构建；先关闭独立窗口及对应 Gateway，再修正并从 pristine 重建。

严格语义复审使用真实 TypeScript 5.9.3 `ts.Program/getPreEmitDiagnostics`：公开 `RegistrationOptions` 未包含准入字段，且产品 `Parameters<typeof api.on>` 得到的宽选项联合可携带 finalize 不接受的工具授权字段。仅预编译不能发现这两处问题。修复补齐同文件两种声明，并精确实例化 `api.on<'before_agent_finalize'>`；同时补语义正例及非 finalize、async、readonly、未知上下文字段等负例。类型修正前已经保存 25,018 个 JS/WASM/Node 模块、EXE/DLL/BIN 及 package/lock 文件的 hash 清单，最终是否复用本轮模型证据须以重建后的逐文件比较为准。

## 最终重建、打包与无模型启动复验

类型修正后再次从锁定 pristine 完整重建。实际发布 SDK 与最终 bundle 三专项 83 项通过、2 项条件跳过；Node/Electron 原生 SQLite/worker 探针各 31 项通过。标准完整测试 10,507 项通过、66 项跳过，910 文件通过、6 文件跳过；Electron ABI 146 恢复。Windows x64 目录包、包内 runtime proof/companion 和原生模块检查通过，打包后 28 项冻结核验通过。

重建与模型验收候选的 Gateway bundle、全部 native/worker、插件及依赖执行字节均一致。首次静态清单只差 `windows-runtime-preload.cjs`：构建使用源函数生成，Main 使用同一个函数的编译格式生成。已分别核对两个 hash 的来源，并通过 canonical helper 确认语义相同，未手工修改 vendor 放行。最终启动自动生成该文件后，25,018 项逐文件比较为 **0 差异**，因此可复用上述真实正文流/停止模型回合；不是拿不同 bundle 的旧结果冒充最终结果。

目录打包后再启动最终运行时，仅打开已有会话和收件箱：历史恢复 183 个完整数字及残片，显示中断和 `Stopped after 9s`，准备完成后输入可用、列表空闲；任务仍暂停，两个结果均已读，完整原生 cron 会话展示 `CRON_MANUAL_OK`，仅看未读为空。该轮没有发送模型任务，也没有再次验证已由用户延期的 Chrome 扩展。验收窗口、对应 Gateway、开发资源服务和本机 HTTP fixture 均已退出。

最终命令、产物 hash 和保留的真实环境限制见[主升级记录](validation.md#最终-28-项构建)。全部原始证据仍在仓库外，仅提交本记录及脱敏结论。

## 复审后的手动验收清单

以下项目尚未完成真实环境验收，不代表已经发现故障。优先补验前四项；模型沿用已有配置，每个场景先用一轮短任务验证，不为验收重复长输出。仅记录错误文字、时间和诊断身份，不分享凭据或配对码。

| 项目                             | 操作                                                                                                                                                                                                                            | 预期结果与未验原因                                                                                                                                                                                 |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Chrome 扩展配对、日常窗口授权    | 按用户决定留待手测。扩展先 Use local 至 Connected；Disconnect 后观察，再 Use local。Tab Access 只授权本机验收页，分别操作已授权与未授权页，再撤销授权、重启 Chrome/应用。日常窗口连接需在出现全新原生授权提示时分别允许、拒绝。 | 断开后不自动重连，恢复后可操作已授权页，未授权或撤销页不能操作；拒绝原生授权如实报错。现有窗口已开放调试端口，未触发新授权；工具不允许操作扩展设置页，用户已明确延期配对。                         |
| 终端与子进程运行中停止           | 在临时工作区通过界面发起可取消的等待任务，确认终端/子进程已启动后点击停止，再切换会话并重开。                                                                                                                                   | 已有正文保留，停止和列表状态最终收敛；任务子进程被清理，重开不重发命令。需结合产品诊断的精确整轮终态和清理回执核对，不能只看停止 ACK。本轮已实测 browser 工具取消，尚未从界面完成终端/子进程场景。 |
| 运行中重连与重启                 | 发起一轮短的工具与正文交错任务，运行中在设置的常规页重启 AI 引擎；连接恢复后打开原会话、切换会话，再重启应用。发送结果不明时不要重复发送。                                                                                      | 历史和活动状态按权威结果恢复，无重复正文、重复工具执行或串到其他会话；中断结果不明时明确保留未知，不自动重放。已有验收覆盖完成后的重启恢复，尚未覆盖真实任务运行中断线。                           |
| 定时任务多页追赶与删除           | 在已有多页结果的测试任务中关闭收件箱，待后台累积结果后重新打开并逐页查看；翻页/同步中重启，再删除测试任务并重启。应用和引擎保持运行时才能继续产生定时结果，无需为凑页数反复请求模型。                                           | 结果不漏不重，已读状态保留；删除后任务不复活，未完成同步不能冒充空成功。基础创建、到点运行、立即运行、收件箱详情/已读及重启持久化已实测，本项补验批量与竞争情形。                                  |
| Team、Workflow、Goal/Plan 与审批 | 在独立测试项目分别真实发起 Team 协作/讨论、Workflow 规划至验收、Goal/Plan；覆盖需要修正交付、拒绝审批、运行中停止、插件停用再启用和重启。                                                                                       | 所属草稿在验收前不泄漏，实际提交与修订可用；停止/权限变化后不继续派发，未知发送不重试；后续普通聊天仍增量显示正文。合成测试和静态契约不能替代真实模型与人工审批组合。                              |
| Windows 安装版                   | 在测试账户安装最终安装器，分别选当前用户/所有用户以及中文、空格路径；首次启动，使用既有数据副本升级；检查聊天与 Widget，卸载时保留数据。另账户管理员凭据提权也单独验证。                                                        | 资源和原生模块可用，数据按选择保留；打包 Renderer 的本机承载、导航保护及真实 Widget 准入可用。目录打包已通过，本轮未操作安装器。                                                                   |
| MXC、电脑操作与显示输入          | 在支持 MXC 的机器选择沙盒后执行临时文件/命令任务；测试工作区外访问、网络、取消/超时和探针失败。实机补验双屏、不同 DPI、中文输入法与剪贴板。                                                                                     | 仅访问获准工作区，skills 为只读，默认网络限制生效，取消清理进程；探针失败不回退 host。真实电脑定位、输入及设备环境未在本轮覆盖。                                                                   |
| 其他内网模型与音频设备           | 对实际提供的 image、embedding、STT/TTS、video 能力分别发起一轮最小请求；切换独立账号并测试麦克风/系统音频。                                                                                                                     | 实际服务和设备工作，账号/端点不串用，失败如实显示。已配置 MiMo chat 的实际请求通过；其余只完成协议及凭据隔离回归。                                                                                 |
| 长任务及其他发行平台             | 实际运行超过一小时且包含等待/恢复的任务，补验 yield/fallback、取消及重启；若需发布 macOS/Linux/Windows arm64，在对应系统安装并启动。                                                                                            | 长任务不提前结算、不丢失清理责任；各平台实际启动、核心聊天和工具可用。本轮未执行长时实机或其他平台验收，二进制 hash 不等于运行通过。                                                               |

## 运行进度专项验证（2026-10-22）

The current contract and public-API/removal audit are in the
[033 capability inventory](../../../scripts/patches/v2026.10.4/README.md#native-bindings-and-ordinary-implementations).
This change retains one observation insertion in the native message-update handler;
stage mapping, retry details, tool progress, rendering and animation remain application code.

The original feature validation below predates the dev merge. The latest integration
evidence is recorded in [Dev integration](#dev-integration--2026-10-22).

## Source and final artifact

- Node 24.21.0; pristine `openclaw@2026.10.4`, with npm integrity and tarball SHA-256
  matching the unchanged source lock (`0a41c2ed708abc812498de58d71d058dde322700488d6e8062c7c070dfdca6dc`).
- Fresh Windows x64 base-runtime installation, current-runtime synchronization and Gateway
  bundling passed, including all 33 source/final-bundle patch checks and manifest generation.
  The first install encountered Windows `EPERM` at the final directory rename; closing the
  isolated preview and retrying the pristine install completed successfully.
- Final Gateway bundle SHA-256:
  `6311846e3b48f52db555d6af67d5df3cf1926147a43eb6d49e5a66fc136c3cca`.
- Native support module SHA-256:
  `762760b92f293735a95f3eb043adad1bf8aaed269299f59310a737ffdbcb1b0d`.
- Direct 033 reapplication to the prepared runtime returned no changed files and preserved
  the exact bytes of its native owner, support module and final bundle.
- After the independent review fixes, another pristine Windows x64 install/sync/bundle passed
  all 33 source/final-bundle checks in 613,736 ms of bundling. The final whitespace-only cleanup
  was followed by another pristine install/sync and a completed 457,437 ms bundle pass. The executable
  bundle hash above remained identical. The final manifest verification and zero-byte-change 033
  reapplication passed against the final helper bytes above.
- An independent compilation of the real pristine subscriber graph passed complete helper
  and call-binding verification. Executing the unmodified native snapshot implementation
  with its real schema accepted and deduplicated 100 progress updates in both `full` and
  `summary` modes, retained the newer actual tool event and cleared progress on retirement.

One post-cleanup validation process exited with Windows `0xC0000005` before writing a manifest.
No verifier exception was reported, and the cause was not established. The supported explicit
rebuild below passed all checks from the already rebuilt, complete current source tree:

```powershell
$env:OPENCLAW_FORCE_INSTALL = '1'
node --max-old-space-size=8192 scripts/openclaw/bundle-openclaw-gateway.cjs
```

`npm run openclaw:patches:verify` and current-shape byte-preserving reapplication passed afterward.

## Application and regression checks

`npm run lint`, `npm run build`, `npm run compile:electron` and the staged `git diff --check`
passed. The final complete `npm test` passed **1,042 test files and 13,183 tests**, with five
conditional file skips and 76 conditional case skips (1,047 files / 13,259 cases discovered).
It completed in 504.92 seconds and restored better-sqlite3 for Electron ABI 146.

Before review, twelve focused test files passed 522 tests, with one conditional skip:
controller/activity, Lit streaming, 033 patch,
pristine contracts, certificate-store setup, ACP plugin setup, native reasoning transport/parser
and runtime manifest coverage. Native text-admission assertions distinguish the content-free
status item from actual assistant/preamble publication, and still reject protected text in
the complete callback payloads.

The initial full suite reported 12,791 passes, six failures and four collection failures.
Those seven affected files were rechecked after native/plugin dependencies and the repository's
HTTP proxy dependency preparation completed, and after reloading the current controller module;
all affected cases passed in the focused runs above and the final complete suite.

The first post-review complete run had one remaining failure: the existing eight-file Goal
patch source/idempotence test took 8.211 seconds and exceeded Vitest's default five-second budget.
The unchanged file passed in isolation (32 cases, nine conditional skips). Only this case received
a local 30-second budget; all four semantic assertions remain. The subsequent complete run passed
as recorded above. No global timeout, retry or skipped assertion was added.

## Independent review follow-up

Three independent agents reviewed native patch boundaries, Renderer behavior and validation.
Five findings were fixed before the final verification:

- Reject a conditionally disabled source observation even when an existing bundle is valid,
  checking AST ownership before any source/support write.
- Ignore content-free metadata for dormant announcements, preserving the existing admission
  of public content and the original buffered lifecycle start.
- Preserve command-output progress while a session is in the background.
- Use the same lifecycle retry/fallback projection in selected and background sessions.
- Keep parallel-tool progress attached to the tool that actually published it.

The focused controller suite passed 19 tests and the native patch suite passed nine tests.
Additional cases cover 150 silent metadata updates before a real announcement, background
silence, exact retained Map values and the 64-call capacity boundary. All semantic assertions
remain; the native observer's executable bytes and its single native insertion are unchanged.

`npm run lint`, `npm run build` and `npm run compile:electron` passed after the fixes.
The final staged-file check found one extra trailing empty line in the new native support module.
Removing it was verified to change trailing whitespace only; its nine patch tests passed again.
No executable code changed after the successful complete suite.

## Real Gateway stream verification

```powershell
node tests/openclaw/runtime/chat-stream-smoke.cjs vendor/openclaw-runtime/current --run-progress
```

The freshly built Gateway and native read tool passed against an isolated loopback model.
The model supplied 65,650 UTF-16 argument characters in slow chunks. The authenticated client
received 21 progress observations, including increasing counts before the remaining arguments
were sent. The native tool did not start early, then returned the expected fixture bytes;
history was read through the public API. Metadata field allowlists and content-exclusion checks
passed. The exact run published `executionSettled:true`; its native lifecycle classifier reported
success. No enterprise model or user Gateway was used.

## Recovery boundary

The native snapshot retains the last available progress item and its original timestamp.
After any item exists, the locked upstream implementation omits later startup statuses; its
public in-flight projection exposes neither these omitted events nor their sequence watermark.
A reconnect during fallback preparation can therefore briefly restore an earlier observed stage
until a new live event arrives. This limitation is documented instead of adding a snapshot patch.

## Browser preview and remaining scope

An isolated browser preview using synthetic events showed increasing long-argument counts,
freshness and retry countdowns. Computed animations remained `working-spark` and
`working-shimmer`; counter updates used `aria-live:off`. Lit tests also verified that updates
retain the same animated DOM elements. This validation does not cover an enterprise model request,
full optional-plugin assembly or installer packaging.

## Dev integration — 2026-10-22

The integration includes dev through `4a649a829`, including resource and source relocation,
model selection, Marketplace feedback, startup/history upgrades and inline-reasoning
source correlation, followed by local speech readiness warnings and native failure receipts.
Three independent reviews found no unresolved product blocker in
the combined Renderer, native patch or startup boundaries. The 033 native seam and its
support module remain unchanged; the updated 029 patch and build recipe require a new
pristine runtime build, so the earlier bundle hash is not proof of this merged tree.

Both browser extension generators were rerun and their committed modules refreshed.
The new sidepanel DOM regression verifies that argument previews and content-free status
items cannot create a running tool card, while native start/result create and complete
the same card. A narrowly scoped Git whitespace attribute preserves meaningful spaces
inside the generated Lit template literals. The native reasoning semantic assertion
now requires an actual preamble, so a progress status cannot satisfy it accidentally.

The merged tree passed `npm run lint`, `npm run build`, `npm run compile:electron`, both
browser extension generators and `browser-extension:prepare`. The offline Chromium
smoke passed authentication rejection, real loopback WebSocket streaming, history,
Thinking, manual collapse, answer and Stop checks with zero page errors. It did not
exercise Native Messaging or a customer history upgrade.

The combined reasoning/progress native suites passed 210 cases with five conditional
skips. The fresh locked Windows x64 installation and current-runtime extraction passed;
the installed build recipe matches the merged source fingerprint
`5d8992be0423251e2ad4f0f26559cab5ad2c920e5be23d3b10e0a932749aac42`.

The new Gateway bundle completed all 33 source/final-bundle patch checks in 578,973 ms.
Its SHA-256 is `b1e0f75a60f75aec3bfd1104406c358ffd72ec2135b830aa21cc720ee7d32620`;
the native progress helper retains the exact `762760b9…cb1b0d` hash recorded above.
`openclaw:patches:verify` passed against the current merged recipe. Reapplying 033
returned no changed files and preserved its owner, helper and final bundle byte for byte.

The later `a6170ea0a` and `4a649a829` commits do not change native sources or the build
recipe; the fingerprint above was checked again after merging them. Their focused
application regressions passed 214 cases across nine files, including 13 new cases for
speech inventory updates, load failures, configuration changes and isolated button actions.
Browser modules were regenerated again after these source changes.

The first dev-integration complete test run, on the `2df4b9f3d` tree, reported 13,373 passes,
80 conditional skips and one failure: the existing session-storage CLI child exceeded its
10-second budget during concurrent native bundle validation. Its unchanged five-case file
passed in isolation in 27.72 seconds. Static inspection found no input-dependent SQL path
or parent/child deadlock, but the precise waiting stage was not established. The original
timeouts and assertions remain unchanged.

The rebuilt real Gateway stream fixture passed: 65,650 argument characters, 22 progress
observations, increasing counts before input completion, no premature tool start, the
expected native read result and public history, followed by the exact settled whole-run
success. This remains an isolated model fixture, not customer migration acceptance.

The final complete `npm test -- --maxWorkers=2` on the `4a649a829` integration tree
passed **1,053 files and 13,404 cases**, with five conditional file skips and 80
conditional case skips (1,058 files / 13,484 cases discovered). It ran alone, completed
in 710.72 seconds and restored and verified Electron ABI 146. The session-storage CLI
file passed with its original budgets and assertions. The final tree also passed lint,
the production build, Electron compilation and the offline Chromium smoke; staged
whitespace/conflict checks passed. Full installer and optional-plugin assembly were
not rerun for this integration.
