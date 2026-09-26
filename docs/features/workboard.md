# Workboard：操作契约与验证

## 范围

以 OpenClaw 2026.9.6（本地源码 `eb377ac59e6`）核对，保留插件和既有启用策略。
四栏只负责展示；OpenClaw 继续拥有任务、存储、认领、调度和执行生命周期。

新建任务只需标题和说明；优先级、标签、助手和历史会话设置折叠在“更多设置”。
triage、scheduled、review、blocked 以卡片上的简短说明解释等待原因。
“怎么使用”改为简短操作说明，不再要求用户学习九个原生阶段。

## 已核对的接口

| 桌面操作           | 上游接口 / 约束                                                       |
| ------------------ | --------------------------------------------------------------------- |
| 加载               | cards.list、boards.list；返回 cards、boards、statuses                 |
| 创建 / 编辑        | cards.create / update；编辑携带 expectedUpdatedAt                     |
| 状态操作           | cards.move；Main 拒绝活动执行，校验并转发界面所见 expectedUpdatedAt   |
| 启动               | cards.start；返回 card、sessionKey、runId                             |
| 批量启动           | cards.dispatch 只选择 ready；普通 todo/backlog 需要先推进             |
| 停止               | tasks.cancel、sessions.list、chat.abort，再对 cards.update 做版本校验 |
| 备注 / 归档 / 删除 | cards.comment / archive / delete                                      |
| 更新通知           | plugin.workboard.changed；收到事件后刷新原生快照                      |

上游源码入口：`extensions/workboard/src/gateway.ts`、`gateway-workspace-methods.ts`、
`gateway-helpers.ts`、`dispatcher.ts`、`store-core.ts`、`store-normalizers.ts`，
以及 Gateway 的 sessions.list、chat.abort、tasks.cancel schema/handlers。

修正了历史 session 关联阻止重做、普通 todo 不参与批量启动、停止后残留 claim，
以及旧详情页面可能覆盖已经开始执行的任务状态等问题。

多 Agent 审查后进一步修正：过期排期不再阻止普通待办的批量启动；活动 execution 的文案优先于
滞后的卡片状态；有时间的排期显示时间和实际可用操作。停止与生命周期更新并发时，以最新版本
和同一执行身份、占用身份（持有者与认领时间）进行有界对账，保留完成结果并释放本轮占用，避免清理尚未写入新 runId
的下一轮执行；定向停止失败不扩大为会话级停止。
旧页面的完成操作即使遇到“新一轮已经结束”的非运行状态，也会因版本不同被拒绝。

上游会隐藏 claim token，因此占用身份依赖持有者和毫秒级认领时间；同一持有者在完全相同
时间戳重新认领且尚未写入新 runId 的极端情况，仍需上游提供公开的认领版本才能严格区分。

## 验证

常规测试：

```powershell
node node_modules/vitest/vitest.mjs run src/renderer/features/workboard src/shared/openclaw/workboard.test.ts src/main/ipc/openclaw/workboard.test.ts
```

直接使用上游处理器、dispatcher 和临时 SQLite 的契约测试（不加入默认测试集，
无需连接用户 Gateway，不发送模型请求）：

```powershell
$env:OPENCLAW_SOURCE = (Resolve-Path ../openclaw).Path
# 可选：源码 node_modules 不完整时，使用同版本已准备运行时的 SDK/第三方依赖。
$env:OPENCLAW_RUNTIME = (Resolve-Path vendor/openclaw-runtime/win-x64).Path
node node_modules/vitest/vitest.mjs run --config scripts/workboard-upstream.vitest.config.mts
```

源码和 SDK 运行时的版本必须一致。测试覆盖创建、修改、备注、手动启动、停止、历史会话重做、
默认及指定助手的批量启动、未来排期与未完成依赖不提前启动、看板范围、归档恢复和删除。
SQLite 使用上游同步 kernel 的异步适配，未覆盖 worker transport；subagent.run、会话目录与
chat.abort 使用替身，因此此验证不等同于真实模型执行或完整 WebSocket 端到端验收。

界面验证使用合成任务渲染真实 React 组件，检查四栏、新建表单和详情操作；不读取用户任务。
