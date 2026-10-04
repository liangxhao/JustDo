# 9.8 升级后专项复核：定时任务、工作看板、记忆与模型

本次复核基于升级检查点 `98bc2299d`，重新对照 `../openclaw` 的 `v2026.9.6..v2026.9.8` 源码与应用调用链。实际协议验证使用独立构建的 `.tmp/openclaw-2026.9.8-audit/verification-repo/vendor/openclaw-runtime/current`，未将仍被占用的主目录 9.6 runtime 当成 9.8 证据。

## 发现与修复

发现一个清理权限边界问题：删除定时任务结果时，应用原先同时沿 `spawnedBy` 和 `parentSessionKey` 查找子会话。9.8 的 `src/gateway/session-utils-row.ts` 区分运行控制归属与界面导航父级；子会话改换控制归属后，导航父级仍可能指向旧任务。原算法可能删除已经不由该任务控制的会话。

已修改 `src/main/scheduler/openClawCronRunCleanupService.ts`：

- 只沿原生 `spawnedBy` 建立待清理子树。
- 保存列表发现时的子会话 ID 和控制父级；执行删除前重新读取并比对，替换或改挂会话时拒绝继续。
- 继续向原生 `sessions.delete` 传递会话 ID、生命周期修订和更新时间条件，不弱化原生并发保护。

新增回归覆盖导航残留、列表之后会话替换、列表之后控制归属变更，并保留分页、循环树、归档路径约束、回执精确删除等既有检查。该修复不更改 runtime 构建材料。

## 分领域结论

| 范围 | 上游证据与应用处理 | 结论 |
| --- | --- | --- |
| 定时任务 CRUD、计划、手动执行 | `packages/gateway-protocol/src/schema/cron.ts` 的 list/get/add/update/remove/run/runs 契约仍适用；应用维持快照分页和配置修订检查，手动执行返回原生排队 runId | 实际 9.8 CRUD 与 command 执行通过 |
| 权限与高级任务 | `cronJobService.test.ts` 覆盖任务权限单独保存、系统事件继承权限、外部助手归属不被改写、声明式任务只读及高级任务 Main 边界拒绝 | 未发现新增协议不兼容；没有扩大默认权限 |
| 回执与历史 | 9.8 新增 `cron.history`；现有 `scheduledTaskSessionHistory.ts` 与 runtime-services 的 `scheduled-task-history.ts` 已按具体 run 的 sessionId 读取原生历史，分页通过内容版本校验且异步读取后重新核验归属 | 保留现有完整结果面板，不为新 API 重复添加界面 |
| Cron SQLite 保留数据 | `src/cron/store/run-history.kernel.ts` 明确保留只属于 Cron 的 `task_runs` 数据及 `task_delivery_state` 关系；通用 Tasks API 被删除并不代表这些表被删除 | 现有精确清理 SQL 仍适用；不能误删成“旧 Tasks 兼容代码” |
| 清理与恢复 | 本次修复控制归属；持久化待清理归档列表、结果 tombstone 与 receipt 存储仍由应用负责 | SQLite 相关回归通过；真实进程重启由运行时专项报告覆盖 |
| 工作看板 | 原生 WorkboardCard 删除了旧 taskId，但应用使用 sessionKey/runId/execution；cards create/update/comment/archive/delete 契约可直接调用 | 实际 9.8 CRUD 通过；未新增上游上传等独立产品流程 |
| 左上角记忆入口 | Sidebar → App 的 memory 主视图 → MemoryView；Main 管理文件访问，原生 memory.search 负责搜索，status/index 使用原生命令 | 未发现导航断链或 9.8 搜索参数变化；实际 FTS 搜索通过 |
| 记忆文件安全 | `src/main/ipc/openclaw/memory.ts` 限定角色工作区、校验相对路径、跳过符号链接、限制文件数及读取大小 | 保留安全边界；原生 memory-core 管理 dreaming，不把占位展示卡变成另一个 cron 所有者 |
| LLM 目录与鉴权 | `models.list` 的 provider-config 视图仍受支持；应用保留 available、unavailableReason、unavailableUntil、reasoning、supportsTools、input 和 contextWindow | 原生鉴权发布和目录刷新由 9.8 服务端执行；实际请求通过 |
| 模型选择与默认值 | 应用继续使用完整 provider/model ID；空助手模型继承默认；独立助手保留自己的模型；reasoningDefault 使用原生 stream | 本轮未发现需要重新定义模型身份或思考协议的缺口 |
| Decision 与媒体 | 升级检查点已集成 decision_evaluate、TypeSafe serviceUrl/SecretRef，以及 Kie、Z.AI、Novita 原生视频配置；本轮重跑对应配置及目录测试 | 继续保留显式禁用和用户配置；不重新启用被上游移除的 OpenAI 视频实现 |

## 验证记录

1. 定向 Vitest：scheduler、scheduledTask IPC、memory IPC/UI、Workboard IPC/UI、模型目录、Decision 配置、原生视频配置与媒体目录，共 21 个文件、224 项通过。首次另一个清理测试文件由于 Electron/Node SQLite ABI 不匹配未能执行；这是测试环境失败，不是断言结果。
2. 主代理串行切换到 Node ABI 后重跑清理、结果存储、浏览器历史三个文件，共 36 项通过，随后恢复 Electron ABI 146。记录位于 `.tmp/openclaw-2026.9.8-audit/review-sqlite-tests.log`。
3. 新增 `tests/openclaw/runtime/tasks-memory-models-smoke.cjs`，在临时状态目录启动实际 9.8 Gateway：禁用的 every 任务创建与更新、强制 command 手动执行、按 runId 找到成功回执、删除任务；工作看板创建/更新/评论/归档/删除；memory.search；models.list 全部通过。
4. 实际 smoke 使用本地 Node command 和 FTS-only 记忆搜索，没有模型、远程嵌入或付费媒体请求，也未改写 runtime 或证明清单。
5. 清理生产文件与测试的 ESLint、工作区 `git diff --check` 通过。

## 验收范围与仍需人工检查

自动化证明覆盖了协议、配置映射和本地离线执行，不等同于已经测试所有真实账户。交付前建议在打包应用中完成下列可观察检查：

- 从左上角进入记忆面板，切换助手，搜索、打开文件、重建索引后刷新状态；确认显示的是所选助手工作区。
- 创建有明确时区的定时任务，编辑计划及权限，手动运行后打开结果；重启应用确认未读数与结果保留，删除单条结果确认不会影响其他运行或改挂子会话。
- 在工作看板拖动普通卡片，运行中的卡片保持原生限制；确认刷新后的标题、归档状态和运行入口一致。
- 使用已有测试账户验证默认与独立助手模型选择、思考内容展示、凭证失效后的不可用提示与恢复；针对 Decision 和媒体分别确认明确禁用不会被同步重新启用。

本轮不以空目录 smoke 声称真实供应商鉴权成功，也不以 command 任务代替 agentTurn 的付费模型执行验证。运行时重启、热加载以及浏览器升级资源的复核由其他专项负责。
