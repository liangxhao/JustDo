# 9.8 功能再复核：任务、插件、记忆与模型

本轮重新读取当前应用源码、`../openclaw` 的 `v2026.9.6..v2026.9.8` 差异及 `CHANGELOG/2026.9.7.md`、`CHANGELOG/2026.9.8.md`，并在正式安装的 `vendor/openclaw-runtime/current` 上执行隔离状态测试。没有修改运行时、证明清单、真实账户或用户未跟踪文档。

## 结论与本轮修正

本轮未发现这些领域新的确定性升级阻塞缺陷。修正了 `AGENTS.md` 末尾仍要求保留旧 custom `/videos` 配置的文字：当前产品只接受原生视频提供商，不应为已移除的旧传输增加兼容。该修正与用户要求删除本次新增历史兼容一致，没有改动通用配置所有权规则。

“测试通过”以下按实际范围列出，不表示所有供应商、操作系统和真实安装包都已人工验证。

## 逐功能核对

| 功能 | 当前代码与 9.8 契约 | 本轮结果 |
| --- | --- | --- |
| 定时任务创建、列表、编辑、删除 | `cronJobService.ts` 使用 `cron.add/list/update/remove`；列表核验分页快照，修改携带 `expectedConfigRevision`，按任务串行化修改 | 单测通过；真实 Gateway 创建、修改、删除通过 |
| 时区、计划、精确时间 | 计划映射保留 cron 时区和 `staggerMs`，不把精确时间零值当成缺省；native schema 的新增 `scheduleErrorCount` 是只读事实，不应回写 | 计划及 IPC 用例通过 |
| 权限与高级任务 | 任务权限单独保存；系统事件继承运行会话权限；未支持的声明式/高级字段仍受只读边界约束，不能通过普通编辑丢失字段 | `cronJobService`、权限和 IPC 测试通过 |
| 手动运行、回执、结果 | `cron.run` 返回原生执行标识，`cron.runs` 与应用结果/回执映射分开；新 `cron.history` 不使现有按具体 run/sessionId 读取的结果适配失效 | 真实本地 command 运行返回成功回执；结果同步、日志、历史测试通过 |
| 结果清理 | `openClawCronRunCleanupService.ts` 沿 `spawnedBy` 控制归属清理；删除前核验 sessionId、归属、生命周期修订及更新时间，不以导航父级授权 | 重新读代码确认既有修复仍在；本轮未重跑 SQLite 清理测试，避免改变 Electron ABI |
| 重启后任务与结果 | 原生 Cron SQLite 为任务执行事实来源，应用保留 receipt/tombstone/清理事务职责；通用 Tasks API 删除不能推导为删除 Cron 的运行表 | 本轮没有重复运行进程重启或 SQLite 故障恢复；由主线程运行时复核覆盖 |
| 工作看板 | shared Workboard 合同使用 `sessionKey/runId/execution`，未依赖已删除的 taskId；Main 校验输入后调用原生 cards API | UI/service/IPC 测试及真实创建、修改、评论、归档、删除通过 |
| 记忆入口与切换 | `app/shell/Sidebar.tsx` 调用 `onShowMemory`；`app/App.tsx` 经过导航保护进入 `MemoryView`；所选 agentId 传入 Main | MemoryView 和 IPC 测试通过，入口没有断链 |
| 记忆搜索、状态、索引 | `ipc/openclaw/memory.ts` 使用原生 `memory.search` 和带 agentId 的 status/index 命令；工作区由所选助手的原生文件接口解析 | 实际 FTS 搜索通过；未执行远程 embedding 请求 |
| 记忆文件边界 | Main 限制角色工作区下 Markdown 文件、相对路径、符号链接、读取大小和文件数；Renderer 不直接读磁盘 | 路径/文件安全测试通过；没有增加独立记忆数据库 |
| Skills 状态与开关 | `openclawSkillService.ts` 仍使用 `skills.status/update`；9.8 将安装实现拆到 `skills-install.ts`，没有使这些调用失效 | Skills 状态、所有权、导入/文件处理测试通过 |
| Skill Workshop | `skillWorkshopService.ts` 核验 agentId、proposalId、revisionHash、目标内容 hash，再调用 `skills.proposals.apply/reject` | 面板与服务测试通过；未添加提案缓存或绕过 native 决策 |
| MCP | `mcpConfigSyncService.ts` 将保存交给配置同步器，显式关闭本次外部自动发现；extension MCP 与用户导入目录分别发现 | discovery/probe/config-sync/UI 测试通过；SQLite McpStore 本轮排除 |
| Hooks | 导入路径与文件操作仍归 Main；原生 hook 执行语义留在 Gateway，UI 不自行执行 hook | hook 文件和管理界面测试通过 |
| 扩展与显式状态 | 可选扩展的配置与禁用状态保留；安装/目录转换/Secrets/网络策略分别有边界；TypeSafe 配置类别存在时成为应用管理项 | 扩展与配置所有权测试通过 |
| Marketplace | 应用自己的 source/provider/installation registry 负责检索、详情、分类和安装；安装由按类型注册的安装器执行，不冒用上游控制台 UI | marketplace/service/registry/installation/UI 测试通过 |
| 语言模型目录与选择 | Main 保留 `available/unavailableReason/unavailableUntil/reasoning/supportsTools/input/contextWindow`；选择使用完整 provider/model，助手空配置继承应用默认 | 模型目录、选择、可用性、表单和刷新测试通过；真实 `models.list` 通过 |
| Decision | `decisionModelConfig.ts` 写 `agents.defaults.decisionModel` 和 TypeSafe `serviceUrl`、file SecretRef；工具使用 `decision_evaluate`，不搬迁旧配置或旧工具名 | 首次配置、清除、未管理状态、Secrets 与完整配置同步测试通过 |
| 视频 | 原生 Kie/Z.AI/Novita 的 provider ID、模型 ID 与 9.8 扩展一致；Main 再次校验 URL/API Key/模型；聊天与视频同 provider 时共用 endpoint/credential | 原生视频配置、保存/回滚及 UI 测试通过；无付费生成请求 |
| 视频清除默认 | UI 实际文案为“不指定默认视频模型”；清除指定默认不会删除 provider 凭证，也不会禁用原生自动发现 | 属于明确产品语义，不把继续自动发现误报为禁用失效 |
| 语音输入、输出、音频附件 | 本地 ASR/TTS、模型资源、麦克风设置与 `transcribe_audio` 扩展分开；文件转写不因关闭麦克风而关闭 | speech service、IPC、设置及输入组件测试通过；未测真实麦克风/扬声器硬件 |
| 设置与回滚 | 非语言模型设置经过 Main 校验和统一配置同步；未管理类别不重写外部配置；首次保存失败恢复原有原生字段及 provider allow/deny 归属 | logout/配置同步与模型专项通过；不恢复本次已删除的历史迁移 |

## 9.7 / 9.8 变更处置矩阵

下列是本分工范围内需要判定的产品变化；聊天协议、浏览器、运行时打包及系统更新另有专项。

| 上游变化 | 处置 | 理由/集成边界 |
| --- | --- | --- |
| `decision_evaluate`、Decision provider 能力、TypeSafe 延迟初始化 | 已集成 + 原生生效 | 新工具/设置写入已接通，启动与 fallback/响应校验由原生执行 |
| 删除退休 Sora/OpenAI 视频生成 | 已集成 | 提供原生 Kie/Z.AI/Novita 设置，不再投影自定义 `/videos` |
| 新模型（Opus/Sonnet 5.5、GPT-6.1 Sol）、目录鉴权与定价修复 | 原生生效 | 应用使用 Gateway 模型目录和完整模型标识；9.8 tag 在发布说明之后还有 GPT-6.1 Sol 提交，不能只以“No intentional capability changes”断言毫无模型变化 |
| 模型 fallback、默认模型清除、thinking transport 修复 | 原生生效 | 应用保留模型默认与 reasoning stream，执行与 fallback 不另写一套 |
| Cron 异步数据库、Windows 大小写环境、输出保留与隐藏 run 删除 | 原生生效 | 实际 9.8 command/receipt 测试覆盖主调用路径；清理继续携带原生身份条件 |
| `cron.history`、`scheduleErrorCount` | 原生可用，未添加重复 UI | 已有按具体运行绑定的历史面板；错误计数为报告字段，应用没有写入它 |
| `failureAlert:false`、高级 delivery/Workboard automations | 原生生效，部分配置 UI 可选 | 原生可执行；应用普通编辑器保持对高级任务的保护，不擅自覆盖已有字段 |
| Skills watcher、目录替换、read-only 安装修复、Workshop 错误改进 | 原生生效 | 应用调用现有状态/提案合同，Watcher 与安装执行属于原生 |
| 插件配置保留、source custody、reload settlement、SDK 校验修复 | 原生生效 | 应用仍保留其配置管理边界；没有用自动 Doctor 作为启动前提 |
| 插件详情能力/工具输入、账户凭证状态、Computer use 分类 | 可选 UI 增强 | 上游 Control UI 展示能力不等于 JustDo 安装协议必填字段；现有市场分类和详情仍工作，没有声称全部上游展示已复制 |
| Memory 查询容错、FTS fallback、索引安全、dreaming 改进 | 原生生效 | 应用保持搜索/索引 API 和 native dreaming 所有权，不创建第二套 dreaming cron |
| Gemini Interactions、OpenAI Agents API、Sign in with ChatGPT Beta、Telnyx、Codex Ultrafast | 可选后端/鉴权入口，未新增专用产品流程 | 不属于既有 LLM API Key/Codex、Decision 或视频流程的强制协议切换；不以这轮验证宣称这些账户能登录 |
| Gemini 双声音 TTS、Slack huddles、Talk/FaceTime/Twilio 统一上下文 | 可选上游渠道/实时语音 | 当前产品本地语音与附件转写不调用这些渠道，不静默启用新的账号或通话能力 |
| 多用户角色模型策略、Visitor Access、Incognito、云 worker Settings | 可选部署能力 | JustDo 本地产品没有该共享 Gateway/云控制台流程；原生策略仍是执行端边界 |
| 9.8 Doctor/更新迁移安全 | 原生保留，应用不新增旧数据迁移 | 用户已明确 9.6 未发布；没有恢复历史兼容、自动 broad Doctor 或读取真实历史数据库 |

## 实际执行记录

- 第一批非 SQLite Vitest：80 文件、762 项通过。覆盖插件、任务、记忆、工作看板、设置模型；明确排除 `mcpStore.test.ts`。
- 第二批配置/模型 Vitest：8 文件、133 项通过。包括 Decision、native video、完整 logout 配置同步和模型选择。
- 第三批语音/调度补充 Vitest：16 文件、86 项通过。
- 合计 **104 文件、981 项通过**。输出为 `.tmp/features-recheck-vitest.log`、`.tmp/features-config-recheck.log`、`.tmp/features-speech-recheck.log`。未执行 `npm test`，未切换 native ABI。
- `node tests/openclaw/runtime/tasks-memory-models-smoke.cjs vendor/openclaw-runtime/current` 成功；输出 `cronCrud:true`、`commandRunReceipt:"ok"`、`workboardCrud:true`、`memorySearch:true`、`modelCatalog:true`。隔离状态目录为系统临时目录中的 `justdo-domain-smoke-YZFbt5`，无模型/媒体付费请求。结果见 `.tmp/features-native-recheck.log`。

## 版本 fixture 与未覆盖项

`openclawConfigSync.logout.test.ts` 的 `getDesiredVersion: '2026.9.6'` 是注入配置写入器的测试值，测试实际模型行为使用当前实现；`openclawConfigSync.test.ts` 的 `buildOpenClawConfigMeta('2026.9.6', ...)` 验证通用 metadata 函数保留指定版本。它们不是运行时版本锁，也不是历史数据迁移，不进行全局文本替换。真正失实的 AGENTS custom-video 指引已修正。

仍需主线程/人工验收：SQLite 清理故障和应用重启、完整安装包窗口交互、真实网络供应商鉴权/Decision/媒体、实际麦克风扬声器、各平台权限提示。离线 smoke 只证明本地原生协议和安全的合成数据流程，不能替代这些验证。
