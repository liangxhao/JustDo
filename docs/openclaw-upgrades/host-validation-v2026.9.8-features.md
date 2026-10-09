# OpenClaw 9.8 主机最终验证：任务、看板、记忆与模型设置

执行时间：2026-10-04 07:21（Asia/Shanghai）。本轮为释放占用后的最终功能回归，使用当前工作区已有行为测试；不切换 better-sqlite3 ABI，不修改运行时或证明清单，不使用真实账户。

## 实际结果

**54 个测试文件、487 项测试全部通过，退出码 0。** 总耗时 10.16 秒。完整输出保存在本机 `.tmp/openclaw-2026.9.8-audit/host-feature-tests.log`；日志不作为用户数据或交付附件提交。

本轮没有发现新的升级范围缺陷，因此没有修改生产代码或扩大功能范围。以下渲染和交互验证来自 React Testing Library/jsdom，不是桌面端截图或人工点击验证。

| 功能               | 本轮执行范围                                                                                            | 代表性行为                                                                                                                                               |
| ------------------ | ------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 定时任务           | shared/scheduledTask、Main scheduler 非 SQLite 套件、scheduledTask IPC、Renderer scheduled-tasks 全目录 | 创建和编辑计划、权限预设、助手切换、模型字段、排队回执、历史分页、结果展示、未读同步、声明式任务只读；延迟设置读取不覆盖已保存状态                       |
| 定时任务表单交互   | CronView permissions/models/settings、memoryDreamingControl、skillReviewCard 等                         | 旧通配权限保留到明确改变；系统事件继承权限；助手变更清除旧会话绑定；相同模型 ID 不混淆供应商；保留不可解析的已选模型                                     |
| 工作看板           | shared 契约、Main IPC、Renderer 服务、可用性和各组件测试                                                | 卡片详情操作、运行期间操作约束、待复核卡片完成/重新排队、关联会话入口、明确清除关联、抽屉尺寸限制、Gateway 断开反馈                                      |
| 记忆面板           | Main memory IPC、MemoryView 渲染与交互                                                                  | FTS-only 和语义就绪状态区分；搜索过期诊断；会话片段不触发不支持的文件读取；重建警告；选择助手后按助手搜索和重建；切换助手丢弃旧请求结果                  |
| LLM 模型           | Main models IPC、openclawAgentModels、Renderer 模型目录/切片/选择器、模型设置目录                       | 默认模型和助手覆盖、供应商完整标识、目录能力、鉴权不可用状态；API Key 显示/隐藏不改值；表单校验关联；自定义请求头与内建供应商边界                        |
| Decision 与媒体    | decisionModelConfig、nativeVideoModelConfig、mediaGenerationModels、NonLanguageModelSettings 等         | Decision URL/Key 校验和模拟 Bearer 请求；原生视频模型选择零供应商调用；不支持端点编辑被拒绝（旧视频兼容展示现已撤回）；密钥遮罩；草稿保存/删除边界及过期发现结果丢弃 |
| 定时任务原生历史桥 | scheduledTaskHistoryPlugin、scheduledTaskSessionHistory                                                 | run 身份绑定、分块历史与变化拒绝，沿用原生历史所有权                                                                                                     |

## 可复现命令

直接执行 Vitest，不经过会重建原生 ABI 的 npm test 包装器：

```powershell
npx vitest run `
  src/shared/scheduledTask src/shared/openclaw/workboard.test.ts `
  src/main/ipc/scheduledTask src/main/ipc/plugins/workboard.test.ts `
  src/main/ipc/openclaw/models.test.ts src/main/ipc/openclaw/memory.test.ts `
  src/main/ipc/providers/mediaGenerationModels.test.ts `
  src/main/scheduler/cronJobService.test.ts src/main/scheduler/scheduledTaskLog.test.ts `
  src/main/scheduler/enginePrompt.test.ts src/main/scheduler/scheduledTaskSessionHistory.test.ts `
  src/main/scheduler/scheduledTaskResultSyncService.test.ts `
  src/main/scheduler/schedulerSettings.test.ts src/main/scheduler/systemTaskSettings.test.ts `
  src/main/plugins/extensions/scheduledTaskHistoryPlugin.test.ts `
  src/renderer/features/models src/renderer/features/workboard `
  src/renderer/features/memory src/renderer/features/scheduled-tasks `
  src/renderer/features/settings/models `
  src/main/openclaw/config/nativeVideoModelConfig.test.ts `
  src/main/openclaw/config/decisionModelConfig.test.ts `
  src/main/openclaw/models/openclawAgentModels.test.ts --reporter=dot
```

## 测试输出与未覆盖范围

- 日志包含 Lit 开发模式提示，以及 Workboard 服务在 Node 测试环境初始化语言配置时的 `window is not defined` 已捕获提示。测试没有失败或未处理异常；这些提示不能算作真实 Electron 渲染异常，也不能掩盖测试结果。
- 本轮明确没有执行 SQLite 清理/存储测试，没有切换 Node/Electron ABI。此前清理权限修复和 SQLite 回归证据见 `review-v2026.9.8-tasks-memory-models.md`；本轮不重复认领该验证。
- 左上角记忆按钮到 App 主视图的真实桌面导航、缩放和布局，以及 Workboard 拖拽等端到端行为，未在本轮人工操作。MemoryView 自身的渲染和切换助手交互已执行。
- 外部模型真实鉴权、付费 Decision/图像/视频请求、远程语义嵌入和长时间定时触发没有执行。相关网络发现测试使用模拟数据。
- 主目录运行时重新构建、实际 Gateway 重启及原生离线 smoke 由主代理另行验证；9.6 未发布，本次新增旧数据迁移已按用户要求撤回。本轮通过不能替代这些运行时证据。

## 历史记录：迁移 smoke 方案已撤回

9.6 未发布，按用户要求，本次新增的 SQLite 兼容迁移、父进程启动门禁、专项测试脚本及独立构建资产均已删除，不属于现行功能，也不再提供复跑命令。

撤回前的合成状态演练曾验证 agent23/shared18 升级至24/19、1个agent和2份备份、配置与来源哈希不变、重复执行无变更，以及真实 Electron 与最小 ASAR 入口。它们仅是已撤回方案的历史证据，不构成当前兼容承诺。此前定时任务、Workboard、记忆和模型设置的功能回归证据保留。

## 后续配置兼容清理

按用户要求删除本次新增的旧 Decision plugin.model 搬迁/缺省 decisionModel 合成、typesafe_evaluate 旧名转换，以及旧自定义视频清单/提示。未配置 Decision 类别时不改写其原生配置；当前 decision_evaluate、显式 deny、9.8原生视频与不支持路由拒绝保留。调整后6个文件68项测试通过。此前487项统计是清理前记录，不宣称清理后整组重跑。
