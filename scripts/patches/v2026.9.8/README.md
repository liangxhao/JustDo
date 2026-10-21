# OpenClaw v2026.9.8 runtime patches

This is the capability inventory for the pristine `openclaw@2026.9.8` npm
artifact locked in `source-lock.json`. Rebuild from that package; do not migrate
an existing patched runtime. Historical and partial patch markers fail closed.
The sibling source checkout was audited at tag `v2026.9.8` against `v2026.9.6`.

## Disposition

The current set contains **25 numbered patches**, down from 32. Code in this
directory drops from 9,141 to 7,533 lines (17.6%); ordinary source modules own
the relocated implementation. The audit uses
the sibling `../openclaw` source at tag `v2026.9.8` and the integrity-locked npm
artifact. Do not merge unrelated patches merely to reduce the file count.

### Capabilities moved out of patches

| Former patch | Ordinary implementation                                                            | Contract                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------ | ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 002          | `src/main/openclaw/runtime/mcpPackageRunner.ts` and the managed MCP config builder | Windows bare npm/npx commands become direct Electron Node argv with the trusted child-window preload. Windows shims embed absolute preload/Node paths so nested npm package-bin wrappers cannot resolve them against the caller's cwd. User settings, arguments, credentials and native process custody stay intact. Other native/plugin MCP launchers can still use the self-contained application shims. |
| 003          | The same launchers and `src/main/openclaw/config/openclawConfigBuilders.ts`        | Existing-session Windows profiles use `chrome-mcp.cmd`, which starts the pinned bundled server with vision and update checks disabled. Explicit custom commands remain selected; native Chrome handshake and process cleanup own the connection.                                                                                                                                                           |
| 020          | `openclaw-extensions/openai/realtime-transcription-provider-factory.ts`            | Explicit per-session intranet transcription URL and matching header policy; cold catalog uses the same factory. Native protocol, reconnect and transcript ordering remain; missing URL fails without public fallback.                                                                                                                                                                                      |
| 021          | `openclaw-extensions/openai/image-generation-provider.ts` and `intranet-config.ts` | Request-local `justdo-image-openai` configuration never changes chat. Video keeps the `video-openai` provider/config ID, registered by this same OpenAI source fork.                                                                                                                                                                                                                                       |
| 027          | `scripts/openclaw/openclaw-shared-sdk-modules.cjs`                                 | The bundle externalizes the native session-access state owner reached through `plugin-sdk/session-visibility`. SDK registration and Gateway reads share the original module instance; no global registry replacement is injected.                                                                                                                                                                          |

033 and 035 are retired by product choice, not absorbed upstream. Diagnostic
projection uses ordinary native lifecycle and bounded Gateway history evidence;
private loop exits are no longer reported. Workflow observes the already-public model_call_started event in ordinary plugin
source and sizes the exact serialized result envelope. The before_prompt_build
budget extension is not required; missing observations use a conservative fallback.

The local OpenAI extension is a complete, version-locked source replacement of
upstream OpenAI, with one plugin ID and no directory merging or native-* backup
entries. The prune policy disables the upstream copy; local protection retains
the replacement. Public account onboarding/catalog/usage and public endpoint
fallbacks are removed; explicit intranet credentials remain supported. Image,
TTS, realtime transcription, file transcription and video share one extension
but retain separate configuration domains. Clearing video never disables OpenAI.
Main excludes build-only source replacements from source discovery/copying.
All production source, manifests, dependency locks and workers are fingerprinted.
See [the mandatory upgrade checklist](../../../docs/openclaw-upgrade-checklist.md)
for baseline comparison, native SDK checks and fresh-artifact validation.

034 and 038 retain only their native bindings, control-flow edits, schema/type
seams and exact verification. Their execution/receipt/cleanup and compaction
implementations are imported from
`src/main/openclaw/runtime/native-support/{plugin-owned-execution,compaction-lifecycle}.mjs`.
Live native accessors retain current registry ownership across replacement and
restart; the support modules create no transcript store. The build recipe binds
their bytes and patch verification checks both copied modules and bundled code.
They cannot live in optional Runtime Services: native restart recovery and worker
copies need them before plugin registration, and public hooks do not grant the
native actor, mutation authority or cleanup-owner bindings they require.

### Remaining patch audit — user impact, 2026-10-14

审计最初检查 27 个 transformer、产品调用方及锁定版本的原生接口；
按用户本轮指定，只移除 033 和 035，当前其余 25 项保留。
**无法在 src 中完全等价复现，不等于补丁必须保留。** 下表分别说明功能价值、
迁移障碍和退回原生行为的代价。下表是其余能力的审计建议，实际构建为 25 项。
删除的比较对象是从锁定 pristine 包重新构建的运行时，并同步修改产品调用方；
不是直接从已经应用补丁的 vendor 目录中删除文件。

`src/main` 通常运行在 Electron Main，不能改变另一个 Gateway 进程的局部变量、
SQLite 事务或 admission。`runtime-services` 虽在 Gateway 中运行，但公开 hook/SDK
只授予指定入口的能力；把核心实现移到插件文件，并不会自动获得执行时机和原生
所有权。普通 `.mjs` 支持模块可以放进 src 并被 Gateway 导入，034/038 已这样做，
但导入和传入原生依赖的接线仍需要补丁。这个限制只解释等价迁移的困难，
不能代替用户影响判断。

| 编号与实际用途                                                                                              | src / 插件能承载什么，当前缺什么                                                                                                                                                                                                                                                                                               | 从 pristine 构建时删除后的用户变化                                                                                                                                                                                                             | 建议                                                                                                                                                                          |
| ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **001** 执行 Python/pip 时保留宿主管理的 pip 配置和 Python 用户安装目录。                                   | Main 已生成两组环境值；原生 spawn 前的 sanitizer 又会删除它们。普通插件提前设置环境仍会被过滤。可以研究在自有 Python 启动器/启动模块中固定配置，但必须覆盖 `python -m pip`、pip、绝对解释器路径和 native hook，不能仅给模型加提示。                                                                                            | Python 本身和已打包依赖不因此消失。pip 可能改用默认源，`--user` 安装可能落到默认用户目录；自有 sitecustomize 仍读取应用用户 site，因此新装包可能无法被后续 Python 找到。只用预装依赖的任务通常不受影响。                                       | **迁移候选**，先以真实 pip 安装、随后 import 和只读安装目录验证替代方案；不是所有 Python 功能都依赖此补丁。                                                                   |
| **005** 对最终 system prompt 做正则替换：品牌、冗余说明、版本行、Runtime 段和自定义规则。                   | src 已拥有规则和持久化。原生有 `transformSystemPrompt`、`registerTextTransforms`、provider `wrapStreamFn`，因此“没有提示词替换接口”不准确。前者在后续 prompt hook/模型身份追加之前运行；全局 input 替换还会改用户消息、历史和工具参数。单 provider stream 可以只改最终 system prompt，但跨所有 provider/harness 需要分别组合。 | 普通聊天、工具执行继续使用原生提示词。自定义最终替换不生效，品牌和部分 OpenClaw 指令恢复，prompt 稍长；模型对产品身份和维护命令的回答可能变化。没有证据表明删除必然使聊天不可用。                                                              | **可按产品取舍删除或缩减**。优先将品牌/指导放角色文件与插件；若只要求内置 provider 的替换，可迁普通 provider 源码，不要求保留“所有最终段落均替换”的契约。                     |
| **006** 为内置模型请求补 session/parent/purpose、人类首次发起标记；另给内部 `chat.send` 增加隐藏用户轮次。  | payload 包装可以迁 provider；隐藏轮次要在 native chat admission 传 `transcript.display=false`，排队输入还要将一次性标记从 source turn 转到执行 run。Main/Renderer 不拥有这些入口；用事后 UI 过滤不能改变原生显示投影。                                                                                                         | 直接删会让 Main 和 Renderer 发送的 `justdoUserInitiated` 等字段不通过原生 closed schema，影响普通发送；同步去字段后标准 provider 可继续聊天。内置服务少请求分类字段；计划实施提示会显示为用户消息。服务端是否强制要求 metadata，仓库无法证明。 | **拆职责缩减**。保留当前消费者需要的 schema/隐藏轮次接线；将较大 payload 实现移普通 provider 或 native-support。不能凭 metadata 名称推断内置模型、计费必坏。                  |
| **007** 区分内置模型的上下文压缩和 exec review 请求，并去掉它们的 human initiation 标记。                   | provider 可以包 payload，但当前公共 wrapper 未提供每个维护调用的用途和原生 reviewer 会话身份；普通 turn hook 不能准确分类所有内部调用。分类小接线留下，包装/注册辅助实现可迁普通模块。                                                                                                                                         | 原生压缩和审查调用仍存在；内置服务收到普通/缺少用途的请求。第三方 provider 不受该补丁影响。后端统计、配额或策略的变化需要服务端契约验证，不能声称压缩本身必坏。                                                                                | **缩减候选**；若后端不消费这些字段可以删除，先核对内置服务。与 006 的 stream 标记依赖一起处理。                                                                               |
| **008** 完整退出再启动应用时，不自动恢复上一应用进程遗留的主会话任务；同一应用内 Gateway 重启仍可恢复。     | Main 提供启动时间，但原生 recovery 自己扫描、认领并派发任务。连接后再 list/abort 有竞态，不能保证任务未先执行。若接受上游自动恢复策略，则不需要等价替代。                                                                                                                                                                      | 聊天功能仍可用；在原生恢复条件满足时，上次中断任务可能重新调用模型或继续执行工具。不是“删了不能启动”，而是重启后的执行策略改变。                                                                                                               | **产品策略取舍**。接受原生恢复可清理；要保证重开应用不继续旧任务则保留小接线，辅助结算逻辑可移 native-support。                                                               |
| **013** 暂停 Goal 后，允许恢复此前被主动 abort 的空闲会话。                                                 | Native Goal resume admission 在运行前因 `abortedLastRun` 拒绝；后续插件 hook 没有机会运行。Main 用 reset 绕过会改上下文/Goal 状态，用新会话绕过会丢同一 Goal 的续接。                                                                                                                                                          | 普通聊天和创建 Goal 不受影响；触发这种状态组合的“暂停→继续”会失败。                                                                                                                                                                            | **保留**；只有取消同一会话的 Goal 恢复能力，才可随产品功能一起删除。实际运行修改已很小。                                                                                      |
| **014** 回放历史时，排除无法送给模型的 assistant display block，保留文本、思考和 tool call。                | 过滤发生在原生 transport message 转换中，provider payload hook 来得更晚。只给某个 provider 写自有安全转换可以覆盖部分路径；Main 的 UI 投影无法改变 Gateway 发出的历史。                                                                                                                                                        | 没有此类 block 的对话通常正常。含不受支持的显示 block 的会话，在后续模型转换/请求时可能失败。关闭 widget-kit 不能证明其他原生显示 block 全部消失。                                                                                         | **保留窄修复**，运行时主要是一个 skip 分支；无需为减少文件数另造通用 transcript 回放器。                                                                                      |
| **015** 给可信本地未知 MIME 文件兜底 `application/octet-stream`；保留 assistant 原始 MEDIA 路径供桌面预览。 | 两件事可分开。未知 MIME 在 native attachment admission 就被拒绝，Renderer 后补不了。原始路径保留则有替代：src 支持 native attachment 和带认证的 `/api/chat/media/outgoing/` 下载，不再要求 Gateway 回传本地路径。无需复制历史。                                                                                                | 直接删两部分：未知类型本地文件可能不能作为附件发出；历史显示仍有原生 managed attachment，但当前桌面本地预览/伴随附件合并依赖原路径，可能无法打开或显示重复。不是所有文件下载都消失。                                                           | **优先缩减**：迁桌面附件访问到原生认证下载，删路径保留部分；留下小 MIME 兜底。若改用明确支持的 MIME/普通项目文件入口，后者也可按范围放弃。                                    |
| **016** 插件库存读取使用离线官方目录，不自动刷新 hosted catalog。                                           | 原生 loader 本身支持内部 `offline` 参数，但 `plugins.list/inspect` 没公开这个选项，Main 发普通 RPC 不能禁止那次 fetch。无需在 src 复制插件库存才能删除：直接接受原生联网和 fallback 即可。                                                                                                                                     | 插件列表通常仍可用；可能联网更新官方 metadata，网络差时有加载等待。原生有本地快照/打包目录 fallback，不应把目录 fetch 等同插件下载安装。                                                                                                       | **可删除候选**，接受目录联网与等待即可；它不是插件基本功能的必要补丁。                                                                                                        |
| **019** 禁止配置驱动的启动/Doctor 插件自动安装或修复，保留显式安装。                                        | Main 的插件安装管理可以继续存在，但 native repair 在自己的 install lease 下启动，后来的插件不能取消已发生下载；简单配置项不能表达当前范围的 host policy。                                                                                                                                                                      | 现有已安装插件通常照常运行。遇缺失/需修复插件时，原生可能联网安装、更改安装记录；用户显式安装能力没有因为补丁存在而被关闭。                                                                                                                    | **策略补丁**，不能称为聊天硬依赖；若允许原生自动修复可以删。当前打包可重复性和产品安装流程仍依赖禁止隐式修复，建议保留。                                                      |
| **022** 产品会话 reset 清模型上下文时，聊天仍显示 reset 前历史。                                            | 原生 SQLite history reader 已按 boundary 截掉展示范围，Main 收不到此前数据，不能靠 Renderer 排版恢复；禁止另建 transcript 缓存。另一路是改产品流程为“reset 即新对话”，旧历史留在旧会话。                                                                                                                                       | 普通执行不受影响；当前对话中 reset 前消息不再可见，并非从原生数据库物理删除。                                                                                                                                                                  | **显示语义取舍**。保留同一聊天完整历史则留窄接线；接受新对话/原生 reset 显示规则可删并改 src 流程。                                                                           |
| **023** 原子 fork 指定产品管理 key，并包括选中的完整助手回复。                                              | key 部分可通过 Main 保存原生返回 key、停止各域推导固定产品 key 来替代；成本是联动会话、权限、插件识别。选中助手回复的 fork 不同：原生 `resolveMessageCut` 只接受 user entry，不能直接 fork 最后一条 assistant。两次 RPC/重新发送文本也不等价原生事务。                                                                         | 当前复制/分支调用带 `targetKey/includeEntry`，直接删会校验失败。改调用方后可退回原生 user-message fork；“从这条助手回复继续”仍失去，除非改产品入口/语义。                                                                                      | **可部分缩减**。不要将指定 key 说成绝对无法在 src 改；保留助手回复 fork 则仍需原生 seam。                                                                                     |
| **025** MXC 隔离环境的技能提示/读取路径使用已物化的 Windows host skills 目录。                              | MXC 插件能物化和授权目录，路径选择却在 native `resolveSandboxSkillRuntimeInputs`。插件改容器 cwd 来冒充技能目录会改变项目执行目录；简单复制不能保证当前只读映射/所有入口。                                                                                                                                                     | 非 MXC 不受影响。MXC 中相关技能仍可被发现，但模型拿到的技能读取路径可能不存在，导致无法读取/使用技能说明。                                                                                                                                     | **保留 MXC 窄接线**。若不再提供 MXC 技能能力可删除；已有独立 MXC 插件构建修正也要一起核对。                                                                                   |
| **026** 浏览器等外部上下文只给 agent，当次可见用户消息仍保持原文。                                          | Main 已构建网页上下文。原生 `agent_turn_prepare`/next-turn injection 可添加 context，但不能直接接收这个受认证的 `chat.send` 字段并绑定特定排队用户轮次；next-turn 与 exact submitted turn 语义不同。直接把上下文拼到 message 可以完全用 src 实现。                                                                             | 当前浏览器发送含 `justdoUntrustedContext`，直接删会校验失败；同步删字段后会失去自动网页上下文。改成普通 message 附上下文后功能可恢复，但网页正文进入用户历史，UI 也会显示或需要产品投影。                                                      | **可通过改变语义清理**，不能把“agent-only 且准确当次”与“普通可见文本”当成等价迁移。也可研究插件精确 turn admission，未证明前不是零代价替代。                                  |
| **028** 项目 cwd 可在独立助手角色 workspace 之外，避免已获 admin 授权后再次被 containment 拒绝。            | Main 已传 admin/cwd；第二次检查仍在 `sessions.create` 中。把角色 home 设置到项目虽能绕开，却会破坏独立助手文件与项目 AGENTS 的层次和隔离执行目录。                                                                                                                                                                             | 在 sandbox containment 生效且项目位于角色 home 外的会话创建场景失败；不是所有非 sandbox 聊天都坏。                                                                                                                                             | **保留**，运行修改仅增加已有 admin 判定。取消独立角色 home/项目隔离是更大产品改变。                                                                                           |
| **030** 定时任务保存并执行每个 job 的 read-only/full 权限及正确工作区。                                     | Main 已投影设置。原生 cron closed schema、payload merge、异步准备后 session permission 和授权事务都缺字段；任务开始后再 patch session 有竞态。全局 full 或插件 prompt 限制不能提供每个 job 的原生权限约束。                                                                                                                    | 当前 cron add/update 带 permissionMode，直接删会失败；删调用字段后基础 cron 可用，但任务权限选择失效，写文件/命令可能被拒绝或要求后台无法完成的审批。                                                                                          | **保留当前能力**；若固定所有任务为同一原生权限，可删并移除任务权限入口。不要为省补丁复制一个产品调度执行器。                                                                  |
| **031** Windows 内置凭证的 SecretRef 允许精确系统 PowerShell 的 TrustedInstaller ACL。                      | Main 已拥有加密凭证和 resolver，命令路径却由 native SecretRef validator 拒绝。可研究改为符合原生 ACL 的自有可执行启动器，从 src/打包实现；普通 `.cmd`/改模型参数不自动满足 secure-exec 验证。                                                                                                                                  | 触发该 ACL 检查的 Windows 内置账号凭证无法解析，内置模型会不可用；手填 API key 的其他 provider 并非都受影响。                                                                                                                                  | **保留或先替换启动器**。这是可替代的凭证架构选择，不是所有登录方式必须修改 OpenClaw；不用明文配置或放宽通用 ACL 作替代。                                                      |
| **032** 修复 Windows session creation 发布时普通路径与 `\\?\` SQLite 文件名不相等。                         | native 事务内部一边使用 SQLite filename，一边使用已授权路径集合；Main 在收到创建结果前已被拒绝。只改外部传入路径不保证内部两侧 canonicalization，插件也不拥有 publication guard。                                                                                                                                              | 触发 namespaced 路径组合时创建会话失败，连普通聊天/子会话入口都可能被挡住。                                                                                                                                                                    | **保留硬故障修复**。补丁约 72 行，实际运行改动仅规范化比较两侧；搬动文件没有必要。                                                                                            |
| **034** 插件受管运行的 describe/cancel、超时、完整执行结算和 run-owned 工具进程清理。                       | 实现已移 `src/main/openclaw/runtime/native-support/plugin-owned-execution.mjs`。剩余是 SDK 方法、registry 持久事实、dispatcher admission、harness/exec policy 与 cleanup finally 的原生接线。插件 hook 能看到结束事件，但不能证明 supervisor 中工具已退出，也不能授予自己 registry 所有权。                                    | 普通非受管聊天未必受影响。当前 Swarm Workflow 明确检查 describeRun/cancelRun，缺失会拒绝运行；去掉检查强行推进，会失去准确取消/恢复/进程清理和何时安全重试的证据。Agent Team 使用的 SDK timeout 投影也须同步检查。                             | **保留 Workflow 能力的接线**。不保留相关插件/受管执行契约时可整体删；不要退回“看最终回复就当整个任务完成”。大量代码是 AST 变换与验证，可共用工具，但不能把移目录当删除 seam。 |
| **036** 桌面共享终端支持项目 cwd、选定 shell/args，以及关闭时显式终止共享 PTY。                             | Main 已选 launch 参数、管理窗口，实际 PTY/agent viewer/权限由 native 持有。独立 Main PTY 能做终端，但会丢 agent 与用户共享同一 buffer 的能力。原生 RPC closed schema 和 manager launch/close 路径没有对应选项。                                                                                                                | 当前 terminal.open/close 带扩展字段，直接删会校验失败；同步删参数后仍可用原生默认终端，但起始目录/PowerShell 参数不能定制，关闭已被 agent 接管的终端可能只是 detach。                                                                          | **保留共享终端契约**；愿意采用 native 默认目录、shell、关闭语义可删并改 src。                                                                                                 |
| **037** 终端欢迎文字用 productName，去掉原生龙虾 ASCII。                                                    | 字符从 native shared PTY buffer 种入。Renderer 过滤会影响 offsets/reconnect，无法等价修改；但根本不需要等价修改它。                                                                                                                                                                                                            | 只恢复 `Welcome to the Claw` 与原生 ASCII。终端输入、cwd、agent 共享、审批、断线附着均照常。                                                                                                                                                   | **最明确的删除候选**。无需在 src 重新实现欢迎文字；产品名已有终端外围 UI。                                                                                                    |
| **038** 自动 recovery compaction 的进度/结果；手动 compact 的 operation ID、状态查询和覆盖准备/清理的取消。 | 实现已移 `native-support/compaction-lifecycle.mjs`。一般 compaction hook 不能看到绕过它的恢复入口，`sessions.abort` 也不证明压缩准备/cleanup 已结束。插件不能重定义核心 RPC 或取得 mutation-authority。                                                                                                                        | 原生压缩能力仍在。当前手动入口发送 operationId 并调用 status/abort，直接删会失败；改调用方后可以保留基础 compact，失去准确停止/不确定提交处理和部分自动压缩进度。                                                                              | **可拆分缩减**：自动进度只是体验，可以去掉 recovery observer；保留现有可取消手动压缩则需其窄接线。若取消 Stop/状态查询契约，可改 src 使用基础 RPC 再删。                      |
| **039** 原生 agent-tool RPC 进入 peer 会话时，解除 sender transcript/CLI writer scope，保留调用权限。       | 调用插件先 detach 仍会被 native `AsyncLocalStorage.snapshot()` 恢复 sender scope；必须在 snapshot 还原后、实际 peer dispatch 前退出 writer carrier。不能用 Main 重发不确定请求或删原生 fence 代替。                                                                                                                            | 普通单会话可能正常；peer 会话的恢复压缩/最终持久化可报 `SessionTranscriptWriterClaimReboundError`，目标任务可能失败或结果无法落盘。                                                                                                            | **保留已定位故障修复**。不是纯日志/展示补丁；放弃相关 agent-tool peer 执行路径才可移除。                                                                                      |
| **040** Windows 原生电脑操作的活动、光标/点击提示、心跳与执行释放通知。                                     | Main 已画 overlay。工具 before/after hook 可做近似提示，但覆盖不到直接 computer RPC、dedup 和 execution release，因此不能等价恢复精确通知。现有实现只观察原生执行，不实现输入执行器。                                                                                                                                          | 自动点击、键盘、截图与权限检查继续走 native；用户少“正在操作电脑”悬浮提示、光标/点击表现。若退近似 tool hook，长 Code Mode 和 RPC 路径可能提示不准。                                                                                           | **可删除候选**，同步停用/清理依赖 overlay；不是电脑执行能力的必要补丁。若保留精确提示，可像 034 一样将 observer 放普通支持模块，但仍有接线。                                  |
| **042** Windows 插件热卸载/恢复捕获时保留 host 目录 junction，不当普通 symlink 重建。                       | src 安装时能调整链接布局，但 native `captureRecoverySource` 持有恢复快照，插件运行前就 cpSync。native uninstall keepFiles、CLI force 均不跳过捕获。可研究不使用 host junction 的完整打包依赖布局；仅删除链接会使 SDK/native shared owner 解析失败。                                                                            | 无 junction 或非 Windows 通常不受影响。受影响插件卸载/热替换可能 EPERM，留下插件不能正常卸载；关 Gateway 再离线删属于中断任务的操作退化。                                                                                                      | **保留已复现的 Windows 管理故障修复**，先有真实无 junction 打包替代才能删除。                                                                                                 |

本轮只处理 **033 / 035**：033 及其 live event、展示和导出字段已移除，
停止判断继续复用 src 中已有的原生终态和有限历史观察。035 由 Workflow 普通源码
读取已有的 model_call_started.contextTokenBudget 替代；该字段由原生
attempt.contextWindowInfo.tokens 提供，时机晚于 prompt hook，但早于本次模型
发出的结果读取工具。只缓存有界 session/run/trace/尝试 span/额度元数据；
model-call trace 的 parentSpanId 必须与 before_tool_call 的原生 spanId 匹配，
一份旧尝试的迟到事件不能给新尝试提供额度。缺失或不匹配时回退 2000 成本单位。
同一尝试保留最保守的已观测额度；agent_end 和服务停止只清理观测，不建立执行结算。
批次页按最终 metadata/cursor/details/content 包装
计算大小，避免固定预留量把本来可读的小页拒绝；极长单项索引明确提示缩短路径或
发布紧凑产物清单，不截断 JSON。其余 037/040/016 仅是候选，本轮不删除。
005、008、019、022、026 也不是普遍的执行硬依赖，但改变的是提示词、自动恢复、
隐式安装、历史可见性或网页上下文契约；必须将这些变化具体说明。

优先迁移/缩减的实现是 015 的本地媒体投影、006/007 的 payload 辅助模块，
以及 038 的自动压缩进度部分。023 的 key 绑定、001 的 Python 配置和 031 的
凭证启动器有普通代码替代方向，但需要消费者/打包重构与原生负例验证；
目前未完成等价替代，不作为“已证明能无损删除”。

原生接口的审计证据包括 OpenClaw 源码中的
`plugins/{provider-plugin.types,provider-transport.types,provider-runtime,host-hook-turn-types}.ts`、
`agents/embedded-agent-runner/run/{attempt-system-prompt,attempt-prompt-build}.ts`、
`gateway/chat-display-projection.{helpers,sanitize}.ts` 和
`plugins/plugin-generation-source-lookup.ts`。产品消费者是
[提示词规则](../../../src/main/openclaw/runtime/systemPromptReplacementRegistry.ts)、
[chat send](../../../src/main/engine/openclaw/openclawRuntimeAdapter.ts)、
[fork 调用](../../../src/main/ipc/cowork/sessions.ts)、
[附件投影](../../../src/renderer/libs/openclaw-chat/pipeline/history-display-normalizer.ts)、
[Workflow 预算](../../../openclaw-extensions/swarm-workflow/contracts/batch.ts)、
[受管运行要求](../../../openclaw-extensions/runtime-services/execution/managed-subagent.ts)、
[手动压缩](../../../src/renderer/libs/openclaw-chat/gateway/chat-controller-compaction.ts) 和
[电脑提示消费者](../../../src/main/core/window/computer/bindComputerOverlay.ts)。

033/035 退休后的相关回归为 31 个文件、453 项通过，覆盖未扩展的原生终态、
历史输出观察、无回复证据的未知判断、诊断导出脱敏、原生事件预算与保守回退下的
完整结果/游标读取，以及 25 项 pristine inventory。应用构建和修改文件的 lint 通过。
运行时已从锁定原始 npm 包重新构建，冻结验证通过；生产 bundle 和保留的 JS
文件均不含 justDoLoopExit / justDoResponseShape。
真实 Workflow fixture 同时检查 prompt hook 字段缺失、model-call 事件报告实际
32768 上限（不同于模型标称 131072），以及结果读取确实使用高于回退的额度。
最终完整一轮通过：100 项处理、3 项显式重试、20 次索引读取、独立校验和交付；
aggregate.json 为 count=100 / sum=10100，受管工具清理完成且执行 lease 为零。
最大结果包装成本为 10,472，超过回退 2000 且低于原生事件支持的 12,000 上限。
fixture 在启动阶段等待原生 sidecar 就绪；长汇总脚本经原生 write 保存后用短命令
执行，避开 Windows 命令长度限制。只认 exec 的成功退出码和实际 stdout 标记，
不将写文件的代码预览当作执行证据。

原生批次压力验证也有一轮停在 96 项完成、3 项预设失败、1 项运行中：最后一项
已有工具提交和可见的结束回复，但受管 SDK 未提供完整结算证据，工作流因此保留
占用。没有以 chat final 或 agent.wait 的回复结束状态强制结算；本轮未修改 034。
这项间歇性的结算等待仍需单独追查，不能将预算替代验证解读为所有结算时序均已稳定。

The unnumbered `computer-overlay-activity.js` remains the self-contained native
observer used by 040. `_patch-utils.js` provides transactional writes, exact
support-module staging and native topology helpers; `source-lock.json` pins the
pristine artifact. Neither is a separately removable capability patch.

### Refactor validation

合并提交前由三个 Agent 分别审查 MCP/OpenAI、构建与原生接线、Workflow/诊断。
审查修复了两个问题：Windows 非 user 模式以及认证刷新时的隐式 user profile
必须走应用启动器；异步模型事件必须按原生 trace/尝试 span 关联，防止同一 run
中迟到的旧尝试扩大当前结果预算。三方复审均未发现新的 P1/P2。相关浏览器
实际序列化、原生配置解析和 MCP 握手回归共 210 项通过。
最终 Windows 全量回归为 852 个文件、9,587 项通过（4 个文件、53 项按条件跳过），
无失败；lint、应用构建、Electron 类型检查、OpenAI 适配器和预算模块的严格
类型检查通过。最终 runtime 从锁定 pristine 包重建，25 项冻结验证通过；
两个支持模块在源码、dist、gateway.asar 中字节一致，OpenAI 保持单一扩展 ID。
加入尝试 trace 关联检查后的真实 Gateway 批次也通过：100 项、3 项显式重试、
20 次索引读取、独立汇总校验与交付，产物 count=100 / sum=10100，执行 lease
为零且工具清理完成。每次结果读取都匹配原生模型事件的 run/trace/尝试 span；
退休的 prompt 预算字段仍缺失，实际模型额度为 32768，最大结果包装成本为
10,472，证明普通插件替代在匹配尝试中确实使用了高于 2000 回退的额度。

The earlier 32-to-27 refactor rebuilt the integrity-locked package, verified its
27 native seams in source and the production bundle, assembled provider overlays,
precompiled plugins and pruned the payload. Final artifact proof passed.
`npm run lint`, `npm run build`, Main TypeScript compilation and strict OpenAI
adapter checking against the package SDK passed. That refactor's full suite with bounded
Windows concurrency passed 9,571 tests (77 skipped).

`tests/openclaw/runtime/windows-mcp-launch.test.ts` exercises real Electron/native
npm/npx MCP and both a Unicode-path fixture and the bundled Chrome server,
including handshake and cleanup. `tests/openclaw/plugins/openai-native-composition.test.ts`
compiles the local source fork and loads registration/setup/policy/cold catalog with native SDK aliases.
It checks explicit URLs, missing-config rejection, reconnect/transcript ordering, and image generation/edit,
TTS, file STT and video against a local service with isolated credentials; no public service is called. Shared SDK tests
exercise grant/read/revoke across the real bundling boundary. Native execution
and compaction tests cover settlement, cancellation, custody and exact support
bytes; historical/partial implementations still fail and require a pristine rebuild.

The Windows MCP test uses the unmodified native transport and its actual config
resolver. Both synthetic runners and real offline npm/npx complete a Client
handshake, tool discovery, invocation and cleanup in paths containing Chinese
and spaces. Managed config projection produces no protocol diagnostic; the batch
control reports `Unexpected end of JSON input` but continues to the valid response.
Unsafe NODE_OPTIONS is dropped while explicit preload argv retains child-window
suppression. The earlier first-error probe did not establish a connection failure;
002 is retired rather than retained on that inference. These tests do not claim
compatibility for every third-party server or strict custom client.

041 (explicit skill discovery refresh) is retired. Use ordinary skills.status
reads with native file watching. The proposed 043 preventive package-copy patch is withdrawn; no alternate
native install protocol is introduced.

Prefer existing native APIs and application-layer fixes. Retain a runtime patch only
for a demonstrated core-function blocker with no reasonable native alternative.
Bounded discovery delays do not justify a patch. The earlier 041–043 review
left existing integration patches in place. The user-impact audit above now
identifies optional presentation/diagnostic/offline behaviors, including 037,
as removal candidates; the current built set still contains them.

The retained integration seams include these scope reductions.
032 fixes a Windows session-creation path comparison in 9.8;
034 adds opt-in plugin execution settlement and tool cleanup;
036 adds the shared desktop terminal launch and close contract;
037 replaces the operator terminal welcome art with the desktop product name;
038 supplies native compaction lifecycle and operation-scoped cancellation;
039 separates source and peer transcript writer scopes at native turn dispatch;
040 publishes content-free local Windows computer activity for desktop presentation;
042 preserves Windows directory junctions when copying native plugin recovery captures;

- **008:** upstream removed the generic durable task registry. Delete its task
  maintenance patch; retain only the application-process boundary on native
  main-session restart recovery. Gateway restarts within one app epoch retain
  native recovery semantics. Prior-app settlement calls the native
  `applySessionEntryExactReplacements` binding; verification rejects the historical
  unbound `applySessionEntryReplacements` helper and requires a pristine rebuild.

Previously retired 009/024 (native reindex and ACP admission reload) and 017/018
(custom live recovery/order projections) stay retired. Native history owns the
display projection and the ordering of restored messages.

| Patch | Retained capability                  | 9.8 boundary                                                                                                                                                       |
| ----- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 001   | Managed pip environment provenance   | Host and native-hook environment sanitizers                                                                                                                        |
| 005   | Final system prompt replacements     | Final model-aware prompt before routing observation                                                                                                                |
| 006   | Agent metadata and hidden turns      | Chat admission, queued source-to-execution human initiation transfer, and provider transport; native read worker checks parent identity                            |
| 007   | Request-purpose metadata             | Compaction and reviewer provider payloads; async native reviewer identity reads                                                                                    |
| 008   | App-process recovery boundary        | Native main-session restart recovery only                                                                                                                          |
| 013   | Explicit Goal resume after pause     | Goal resume admission only                                                                                                                                         |
| 014   | Provider-safe replay                 | Native assistant transport projection                                                                                                                              |
| 015   | Trusted local file delivery          | MIME fallback and native media display projection                                                                                                                  |
| 016   | Offline official plugin catalog      | Native catalog loader with explicit offline intent                                                                                                                 |
| 019   | No automatic plugin repair downloads | Installed-index lease writer; explicit installs remain native                                                                                                      |
| 022   | Planning history after reset         | Native display-history boundary; model reset unchanged                                                                                                             |
| 023   | Managed atomic fork                  | Current fork schema/handler and native atomic transcript fork                                                                                                      |
| 025   | MXC external skill paths             | Canonical host read-only materialization                                                                                                                           |
| 026   | Private untrusted turn context       | Authorized agent-only input, raw transcript unchanged                                                                                                              |
| 028   | Managed session cwd                  | Already-authorized operator.admin cwd path; native non-admin containment unchanged                                                                                 |
| 030   | Scheduled task permissions           | Cron schema, job persistence and selected workspace after async preparation                                                                                        |
| 031   | Windows credential launcher ACL      | Exact system launcher/provider and verified TrustedInstaller SID                                                                                                   |
| 032   | Windows session creation publication | Canonicalize admitted and SQLite namespaced paths; preserve exact case, database identity and current-owner checks                                                 |
| 034   | Owned plugin execution and cleanup   | General SDK run timeout and managed tool lifetime; exact native registry ownership, whole-run lifecycle, supervisor cleanup and trusted Code Mode wait metadata    |
| 036   | Shared desktop terminal              | Admin terminal launch accepts project cwd and shell/args; explicit termination retains native viewer ownership checks                                              |
| 037   | Product terminal welcome             | Welcome text reads validated build-time productName; no lobster art; native buffer seeding and output offsets remain unchanged                                     |
| 038   | Native compaction lifecycle          | Recovery start/update/end events; admin operation status/cancellation covers preparation and cleanup; bounded native receipts retain no transcript or summary      |
| 039   | Peer transcript writer scope         | Detach only source transcript/CLI-history ownership after caller snapshot restoration; preserve native authority, target writer admission, guards and cancellation |
| 040   | Local computer activity presentation | Admin-only v2 start/end heartbeats and execution release; opaque presentation identity, no input/image/coordinate payload, unchanged native execution and results  |
| 042   | Windows plugin recovery junctions    | Preserve accepted absolute directory links as junctions in recovery copies; keep native file references, hardlink checks, admission and lifecycle unchanged        |
| 043   | Nonblocking SQLite retirement        | Run a closing handle's WAL checkpoint with zero busy timeout; preserve blocked evidence, native close, leases and the original foreground busy policy              |

Each module header records its scope, native safety boundary and removal condition.
No upstream issue number is claimed without an actual filed issue.

Patch 043 prevents a retiring connection from holding SQLite's writer lock while
waiting for an older read snapshot during a TRUNCATE checkpoint. In the pinned
native code, close inherits the normal 5-second busy timeout. A concurrent Agent
session update can exhaust its own write-admission deadline while that cleanup
waits; accepted peer messages can consequently fail before the organizer starts.
The shared-state checkpoint warnings and the failed session write are separate
observations; warnings alone do not establish an execution failure.

The deterministic native SQLite probe holds an old reader, commits a newer frame,
and closes a third connection concurrently with a foreground write. The original
close blocks the write with SQLITE_BUSY; the patched close reports incomplete
checkpointing immediately and the write succeeds with the reader still open.
Only handle retirement uses a zero busy timeout, restored by the existing native
helper. Explicit checkpoints, transaction admission, synchronous settings, invalidation,
cleanup results and lease verification remain native. An incomplete checkpoint
does not mean an Agent succeeded or its tools finished. Public Gateway/plugin
APIs do not control the native per-handle retirement callback, so an application
retry cannot remove this lock and could duplicate an uncertain operation.

All seven native copies (including both embedded worker bundles, the state read
worker, native-hook relay, config doctor and package recovery) and the final
Gateway bundle are checked. Tests:
`tests/openclaw/patches/v2026.9.8/nonblocking-sqlite-retirement.test.ts`;
`node scripts/openclaw/probe-sqlite-retirement.mjs <runtime-directory>` reproduces
the pristine defect and tests actual SQLite locking without user data. The peer
return probe uses an isolated Gateway and deterministic loopback model; it checks
real organizer execution and whole-run terminals rather than accepting a send ACK
as completion. Remove this seam when upstream retirement is nonblocking.

Lifecycle regression:
`node tests/openclaw/runtime/sqlite-retirement-lifecycle.native-smoke.mjs <runtime-directory>`
uses the prepared package's actual exports and isolated synthetic state, with no
Gateway/model or replacement of native owners. Run with Node and the Electron
Node runtime. Its six groups cover:

| Boundary                       | Required evidence                                                                                                                                                                                                                                                                         |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Backup with a pinned reader    | Blocked close releases the exact lease without a clean receipt; verified online snapshots contain later committed WAL rows while the old reader keeps its original view; the published DELETE-journal copy is independently readable without sidecars                                     |
| Update capture and rollback    | Real update inventory/capture preserves row IDs; native rollback refuses a peer reader, a foreign maintenance owner, stale generations and a damaged snapshot without moving source files; a valid exclusive rollback restores baseline rows and removes candidate-only schema            |
| Database deletion              | No maintenance authority and a peer reader both refuse removal; after release the native exclusion permits deleting the complete owned family and recreating a valid database; native Agent deletion preparation rejects a foreign live lease and preserves the unrelated surviving owner |
| Failed close                   | The real maintenance error handler records `health.error`, returns false and never produces a clean integrity receipt                                                                                                                                                                     |
| Normal exit and restart        | Native process-exit callbacks release the lease before a fresh process starts; a pinned reader keeps the receipt uncheckpointed; reopening preserves committed rows and accepts new writes                                                                                                |
| Forced termination and restart | An acknowledged committed row survives killing the writer process; an uncommitted row rolls back; a fresh owner recovers the stale lease and can write, then an unpinned orderly close records clean                                                                                      |

Product assistant-profile deletion is separately covered by
`src/main/ipc/cowork/agents.test.ts`: availability removal preserves native history
and never calls `agents.delete`. The smoke's physical database deletion uses only
its own temporary fixture, not the product profile operation. Recovery refusal
after file-generation changes is intentional; the test never refreshes a stale
authorization and retries it as if it were the original operation. These tests
exercise process termination, not hardware power loss or storage failure.

Retention decision (2026-10-16, Windows win-x64): keep 043 for the locked 9.8
runtime. All six groups passed on Node 24.21.0 and Electron 42.7.0's Node runtime;
144 focused patch/manifest/profile/store/continuation tests passed. The existing
`gateway-lifecycle-smoke.cjs` also passed on Electron with the application's
shutdown preload: hot reload, in-process restart, orderly shutdown and fresh
process startup retained the exact native session identity. Independent review
found no remaining blocking issue after correcting the unit error fixture and
strengthening authority, generation, lease and child-process cleanup assertions.
The production patch is unchanged by this validation; upgrading OpenClaw requires
a new audit rather than carrying this version-specific patch forward unchanged.

### Upgrade handoff: 2026.10.4

The 2026-10-16 pre-audit inspected the sibling checkout at release tag
`v2026.10.4` / `383c124cc32ffee3f8e56f549b88da94d269a4af` and the integrity-verified
official npm package. This is upgrade input, not acceptance of a 10.4 application
runtime. The retention decision and passing tests above belong only to 9.8.
Record final dispositions and new proof in the target version's patch README.

| Area                           | Target observation                                                                                                                                                                                                          | Required upgrade work                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 043 retirement seam            | `configureSqliteWalMaintenance.close` now calls `beginClose`; async `stop()` joins maintenance, and the Agent execution closer awaits it. Ordinary close still uses TRUNCATE with its busy policy.                          | Reproduce the actual target retirement/write contention through its new lifecycle before deciding to retain or remove the seam. The old `clearInterval` / direct cancellation AST guards and seven-source/eight-with-bundle counts are version-specific and require a fresh audit. If a gap remains, rewrite against pristine target source and preserve `stop()` joining, checkpoint results, native close and lease receipts. Do not apply 9.8's transformer to 10.4. |
| 039 peer writer scope          | The target in-process Agent dispatcher uses `runWithoutOwnedSessionTranscriptWrites` after capturing authority; upstream [#170077](https://github.com/openclaw/openclaw/pull/170077) addresses launched-turn writer claims. | Treat this as a candidate for native coverage. Verify caller snapshot restoration, transcript and CLI-history scope separation, async boundaries and unchanged authority/current-owner checks before dropping the patch. A similar function name alone does not prove equivalence.                                                                                                                                                                                      |
| SQLite contention probe        | `scripts/openclaw/probe-sqlite-retirement.mjs` directly imports the 9.8 043 transformer.                                                                                                                                    | Separate native target reproduction from the old transformer or bind the comparison to a newly audited target patch. A 9.8 topology/marker rejection is a stale harness, not evidence that target SQLite failed.                                                                                                                                                                                                                                                        |
| Lifecycle and return probes    | `sqlite-retirement-lifecycle.native-smoke.mjs` resolves exact native function exports; `probe-agent-team-peer-return.mjs` depends on the current session-visibility SDK, fixture plugin and Gateway client.                 | Update module discovery, signatures, scoped grants and shared SDK identity for the target package. Keep latest-WAL backup, row-ID preservation, refusal without file moves, clean/dirty receipts, exact lease release, committed/uncommitted restart and exact whole-run return assertions. Rerun on Node and Electron, plus the application's actual Gateway shutdown/restart path.                                                                                    |
| Product continuation admission | The current collaboration coordinator permits a new independent user request when historical accepted work has a precise run ID but no terminal receipt and fresh full-team activity is known idle.                         | Preserve this behavior and its tests while adapting native runtime-status/identity contracts. Do not mark the historical execution complete, replay its message or remove the admission fix merely because native writer handling improved.                                                                                                                                                                                                                             |

The sibling checkout's installed dependencies were stale during this pre-audit:
the test cache failed at `defineCacheKeyGenerator`, and the source import failed
at `@openclaw/fs-safe/copy` (installed 0.4.1 versus required 0.24.2). Synchronize the
target's locked dependencies/toolchain in the isolated upgrade checkout before
interpreting new failures. No target regression pass is claimed from that run.

Build the target from its pristine locked package with a new source lock,
capability inventory, pristine contracts and source/bundle verification. Do not
reuse the 9.8 prepared runtime, hashes, target counts or passing test totals as
target proof; do not weaken safety assertions to make a rewritten harness pass.
The 10.4 lifecycle improvements do not by themselves prove that 043 can be
deleted, and 9.8's retention decision does not require retaining it after upgrade.

Patch 042 fixes Windows plugin replacement preparation during uninstall, toggles,
reloads and other native lifecycle operations. `captureRecoverySource` uses
`fs.cpSync` with `verbatimSymlinks`, but Node recreates directory junctions as
ordinary directory symlinks. Copying the native `node_modules/openclaw` host
junction can consequently fail with EPERM even when the installed plugin
directory is writable and unlocked.

The native uninstall RPC exposes only pluginId/keepFiles. keepFiles still prepares
runtime replacement; CLI --force only skips confirmation, and a CLI connected to
a running Gateway forwards to the same RPC. None skips this native-owned capture.
Offline CLI removal would require stopping the Gateway and interrupting tasks.
Application-owned source preparation cannot repair the already captured boundary;
042 is retained for the reproduced normal-uninstall blocker.

The seam runs the original recovery filter first. Only on Windows, an accepted
existing directory link with an absolute target is recreated as a junction and
excluded from the default copy. It preserves the target without traversing it;
relative, file and dangling links retain native behavior, as do non-Windows
copies. Native file-reference/hardlink handling, ownership checks, recovery
disposal and plugin lifecycle are unchanged. It does not bypass failed runtime
drain or introduce a Gateway restart. Four native source copies and the final
Gateway bundle require exact verification; historical or partial shapes require
a pristine rebuild. Remove when upstream recovery preserves Windows junctions.
Tests: `tests/openclaw/patches/v2026.9.8/windows-plugin-recovery-junctions.test.ts`.

Patch 040 covers the native service/handler/scope-guard chunks, the recovery
monolith, and both minified `dist/worker/worker.mjs` and
`dist/worker/sqlite-store.worker.mjs` copies (four targets per seam before bundling,
five with `gateway-bundle.mjs`). Minified local names are derived from the native
AST; the activity callback captures handler options to avoid a shadowed context
alias. Verify against the complete locked pristine archive, not a subset of dist.

Patch 039 addresses `SessionTranscriptWriterClaimReboundError` during a peer
turn's automatic context recovery. Native `bindAgentToolGatewayRequest` captures
all async-local scopes with `AsyncLocalStorage.snapshot()`. Its subsequent
`agent` dispatch restores the sender's transcript writer along with the caller's
authorization. A target attempt temporarily binds its own writer, but recovery
and terminal persistence outside that attempt can again inherit the sender's
writer and reject the different target. Successful compaction does not rule out
this subsequent persistence failure. Detaching outside the captured caller is
too early: snapshot restoration reinstates the source scope.

The bound dispatcher exits only native transcript and CLI-history writer scopes
for `agent` RPCs, after snapshot restoration. The original dispatcher receives
the same request, arguments, caller checks, opaque operator authority, target
commit guard and abort signal. Other RPCs retain their original writer scope.
The target still acquires and validates its own native writer fence; no guard is
removed, no session claim is overwritten, and no uncertain launch is retried.
The Gateway bundle and dynamically imported SDK must also share the native
`transcript-write-context` and `cli-history-boundary` state owners, as enforced
by the shared SDK build contract. The detach helper's CLI dependency must use
the same carrier as CLI execution and transcript boundary reads. Upstream
async-work carriers already use global singletons and need no new seam.
All four native dispatcher copies and the final bundle are verified.
Rebuild from the locked pristine package. Remove this seam when upstream
separates these writer scopes after restoring caller authorization. Tests:
`tests/openclaw/patches/v2026.9.8/peer-transcript-write-scope.test.ts` and
`tests/openclaw/runtime/shared-sdk-modules.test.ts`.

Patch 006's bundle pass recognizes numeric local aliases generated by esbuild
for the shared native authority resolver. Pinned native files still require the
exact resolver name; missing or ambiguous assertions fail closed. This is a
fresh-build recognition rule, not repair logic for an older patched runtime.

Patch 038 closes two native 9.8 gaps. Timeout/overflow/budget recovery calls the
context engine directly, bypassing ordinary AgentSession compaction events; its
only existing progress callback requires configured notifier hook messages.
Recovery now emits one unique item/operation identity with start, periodic update
and end, including completed/skipped/failed/aborted outcome and available token
accounting. Hook notifications become updates within that operation. Observation
never waits for remote notification delivery, and pending callbacks suppress
heartbeat updates; terminal delivery and timer cleanup do not block execution.
This seam adds lifecycle and heartbeat observations, not summary streaming.

Manual `sessions.compact` accepts an optional UUID `operationId`. Native admin
methods `sessions.compaction.status` and `sessions.compaction.abort` accept exactly
`{key, operationId}` and return a direct snapshot with `phase` equal to
`in-progress`, `settled` or `unknown`; settled snapshots include `outcome`, `ok`,
`compacted`, `markerExpected` and available token counts. `admitted` distinguishes
an accepted operation from a cancellation fence created before its dispatch.
Abort does not clear the follow-up queue; native `sessions.abort` still owns that
separate capability. Absence of an active embedded run never proves preparation
has settled. Unknown abort IDs are reserved before confirming cancellation,
preventing a delayed original submission from starting. Repeated IDs never run
again. In-progress aborts settle only after the native handler's cleanup releases
its operator/lifecycle custody; RPC responses and `session.operation` terminals
are delivered after that cleanup. The wrapper transfers the native opaque
mutation-authority binding rather than relying on copied request properties.

The Gateway keeps at most 4096 content-free receipts/fences per native runtime
identity for its process lifetime. It never evicts them or expires cancellation
fences, and rejects new admission at capacity. A restart returns unknown; clients
must fence uncertain old IDs before allowing later work and must not reconstruct
their earlier outcome. Receipts contain fixed reason codes, never summaries,
provider error text or transcripts; immediate RPC and live terminal attribution
retain the native reason or error message. Exact native no-op and cancellation
reasons retain their semantics.
Only stock client compaction of a durable transcript advertises an expected
history marker. Server-endpoint, CLI, detached-memory and opaque custom-engine
successes can finish without one.

The new methods retain native operator.admin and session/profile target policy.
Compact parameter and operation-event schema changes are verified with the
handler, native method descriptors, relay descriptors, context-engine delegate,
producer, recovery module and both native workers before writing any target.
Public plugin hooks cannot establish preparation/cleanup settlement or observe
the missing recovery lifecycle, so this capability belongs at the native seam.
Rebuild from the locked pristine package; partial and historical shapes fail
closed. Remove 038 when upstream exposes equivalent operation-scoped settlement
and cancellation covering preparation, plus complete recovery events and marker
provenance. `src/main/openclaw/runtime/native-support/compaction-lifecycle.mjs`
contains the ordinary imported implementation and is included in the build recipe;
038 owns all transformations and exact verification. Tests:
`tests/openclaw/patches/v2026.9.8/native-compaction-lifecycle.test.ts`.

Patch 037 renders `Welcome to the <productName>.` using validated `package.json`
metadata, preserving ANSI theme colors and CRLF spacing. The monochrome app icon
loses its cat details at compact terminal sizes, so no replacement ASCII art is
shown. This changes only the native intro composer in the session manager,
recovery module and both native workers, verified again in the Gateway bundle. It preserves native
operator/viewer intro seeding, PTY output, buffers and offsets; no Renderer filtering or
Main output rewriting is added. The product metadata validator is part of the
build recipe proof. Remove when upstream supports product-owned terminal intros.
Tests: `tests/openclaw/patches/v2026.9.8/terminal-product-banner.test.ts`.

Patch 036 addresses the native terminal integration gap: `terminal.open` starts in
the role home and does not accept the desktop's selected project or PowerShell
launch arguments; `terminal.close` normally detaches from an adopted shared PTY.
The existing operator.admin RPC accepts optional cwd/shell/args and an explicit
terminate flag. Catalog launches retain their native plan. Sandbox admission,
exact chat incarnation and attached-viewer checks stay native; agent input still
uses native one-time approval unless full execution access applies. Rebuild from
the locked pristine package. Remove this seam when those native launch and close
contracts are available upstream. Source targets are the protocol, terminal RPC,
session manager and the native recovery bundle; final Gateway bundle verification
checks the same behavior. Tests: `tests/openclaw/patches/v2026.9.8/shared-terminal.test.ts`
and `src/main/ipc/app/terminal.test.ts`.

Patch 006 transfers the one-shot human initiation marker from the native queued
source turn to its separately allocated execution ID immediately before execution.
It leaves native run identities and queue behavior unchanged. The current marker
revision rejects older patched inputs; rebuild from the locked pristine package.
The bundle verifier accepts the exact current transfer after esbuild removes its
comment and renames local bindings, checking the adjacent native source and
execution identities. Markerless source files and incomplete transfers still fail.

## Packaging and native evidence

9.8 adds `dist/package-update-activation-recovery.mjs` alongside the two embedded
worker bundles. Audit all copies rather than assuming the former three source
targets. Gateway-only handlers remain in the Gateway ownership boundary; each
transform checks the exact current module topology. Payload helper export aliases
are resolved from the locked artifact, never carried over from the previous hash.

The packaging companion registry covers all 54 native process entrypoints (13
added since 9.6), including the SDK Job launcher reached by file-access runtime. Preserve the original module URL through the new shared process
factory, self-starting workers and runtime-module imports so bundled execution
resolves the shipped worker files rather than the Gateway bundle directory.

`verify-openclaw-pristine-contracts.cjs` checks native thinking/history, tool
discovery, Goals, decision evaluation, subagent queue/wait/delivery, Stop,
approval expiry and compaction before writes. `tasks.list/get` and generic task
events were removed upstream and are no longer claimed as native contracts.

The facade static-import transform remains packaging-only. Final artifact proof
binds the source lock, patch inputs, build recipe, native modules and bundle;
failed proofs must never be repaired by rewriting their manifest.

034 is opt-in for trusted plugin owners. It does not change ordinary plugin
tool lifetime, grant filesystem access, or introduce a Swarm-specific executor.
Managed runs require local native execution; unverified remote, ACP, alternate
harness and sandbox tool backends fail closed. SDK declarations and all four
native code copies are checked, then the production bundle is verified after
esbuild normalization. Historical or partial versions require a pristine rebuild.
Before this refactor, the execution capability passed a full isolated production build (real dependency lock,
asar and artifact metadata), native Code Mode async wait and cleanup probes, and
a real execution lasting over one hour. See the Swarm batch feature plan for
the exact test scope and remaining recovery limits.

The retired 035 patch populated an optional public hook field. Workflow no longer
requires it: the public model_call_started event already exposes the effective
context budget at the result-reader boundary. Bounded plugin metadata observes
that event; absent evidence uses the conservative page fallback. Native admission,
model context caps and compaction remain unchanged. The native batch fixture
asserts the prompt field is absent and actual result reads use the public event.

## MXC

The separately locked `@openclaw/mxc-sandbox@2026.9.8` still uses MXC SDK 0.8.0.
Its external skill paths, host-preparation capability SID and invalid
`filesystem.clearPolicyOnExit` configuration, plus its unrelated IsoEnvBroker
readiness gate, still require the product build
patch in `scripts/openclaw/patch-mxc-sandbox-plugin.cjs`. Preserve filesystem
permissions and emit the supported native lifecycle configuration. Binary hashes
are unchanged from 9.6 and are verified against `mxcNativeBinaries.json`.

Readiness now probes the exact selected executor with `--probe`, including an
explicit `mxcBinaryPath`, and requires a native ProcessContainer isolation tier.
Native tier warnings remain advisory; failed, malformed or unrecognized probes
block backend registration. Main also checks a real isolated process before
admission. Remove this readiness patch when the locked plugin includes the
[upstream executor-based readiness](https://github.com/openclaw/openclaw/blob/main/extensions/mxc/README.md#host-readiness).
Prior product patch revisions are rejected; rebuild the plugin from its locked
pristine package instead of updating a previously patched cache in place.
Tests: `tests/scripts/mxc-sandbox-patches.test.ts` and
`src/main/security/windowsSandboxService.test.ts`.

For feature-level integration and validation results see
[the upgrade audit](../../../docs/openclaw-upgrades/v2026.9.8/v2026.9.8.md).
