# 原生 Worktree 与会话接入

应用通过 OpenClaw 的托管接口创建和管理 Git worktree。分支、检出、快照、恢复与清理继续由原生运行时拥有；应用只保存产品会话映射、执行目录和入口偏好，不实现第二套 Git 生命周期。当前锁定运行时为 2026.9.8，未完成的真实 Gateway/模型验收见[验收清单](../../plans/worktree-integration-plan.md)。

## 用户入口

“设置 → Worktree”提供托管清单、恢复、移除、清理以及创建与存储设置。可开启“显示 Worktree 勾选框”，在新会话输入框展示本次创建选项；每次新会话默认不勾选。勾选后 Main 经 `sessions.create(worktree: true)` 创建原生会话，确认实际检出根后才准备执行。设置面板不负责日常任务创建。

模型也可通过原生 `sessions_spawn(..., visible: true, worktree: true)` 创建可返回的独立子会话。产品只接纳与父会话同一助手、可见且权限可表达的原生 worktree 子会话；跨助手子会话仍归原生管理，不冒充已接入侧边栏。普通 shell `git worktree add` 不进入托管注册表，本面板不声称列出或恢复这类目录。

## 身份与执行目录

```mermaid
flowchart LR
  Input[新会话 Worktree 选择 / 原生可见子会话] --> Main[Main 核对产品与原生身份]
  Main --> Gateway[原生 sessions.create / describe]
  Gateway --> Checkout[原生托管检出]
  Checkout --> Binding[稳定 sessionKey / sessionId / worktreeId]
  Binding --> Store[产品映射与实际 cwd]
  Store --> Chat[继续原生会话]
  Chat --> History[Gateway 原生历史]
```

创建前先绑定稳定原生 session key，避免接收结果未知时丢失核对入口。创建回执必须包含一致的 key、session ID、权限、worktree ID、绝对 sessionRoot 与检出路径；确认后产品 `cwd` 使用实际检出目录。失败时查询原身份：明确不存在才清理产品记录，查询失败或原生保留检出时留下可检查的错误会话，不盲目创建第二个 checkout。

继续已绑定的会话时重新核对身份和实际目录，并同步产品选择的原生权限，不创建替代会话。项目归属与实际执行根分别处理；审批、文件预览、Review 及执行不能使用源仓库路径代替检出根。可见子会话沿用原生 guarded/workspace/full；未声明权限按 ask 接入，read-only 等无法表达的模式不接纳。

Worktree 会话暂不支持复制/分叉：普通消息 fork 不继承检出所有权，复用旧目录会让副本受原会话删除影响。消息与角色文件仍由原生接口管理，不复制 transcript 或移动项目角色规则。

## 恢复、删除与清理

清单和操作使用 `worktrees.list/restore/remove/gc`，受原生 operator 权限及产品会话引用检查约束。仍被本地会话引用的 worktree 不能在面板直接移除，先处理关联会话。删除会话或取消创建须确认原生删除成功；`worktreePreserved` 或结果未知时保留入口与原因，不直接递归删除目录或分支，不把发送删除请求当成清理完成。

原生快照与闲置回收有自己的保留期限，“可恢复”不表示永久保留。源项目、检出和快照的存储边界见[数据存储](../../architecture/10-data-storage.md)，会话身份和删除恢复见[引擎](../../architecture/05-agent-engine.md)。

## 全局创建设置

`worktreeRoot` 与 `worktreeAcceleration` 是 Gateway 全局配置，SQLite 不另建副本。设置通过带查看时 `baseHash` 的 `config.patch` 保存，与应用配置 mutation 共用排他队列；保存后重新读取并核对目录、加速值以及 `configRevisionHash/appliedConfigHash`。版本冲突、断线或超时不自动重放写入，保留草稿并允许重新读取。

空目录通过 merge-patch 的 null 清除覆盖，默认位置为 `<stateDir>/worktrees`。目录改变只影响新分配，旧检出及恢复仍使用登记路径。加速默认开启，关闭后新分配使用普通 Git 检出。当前全局目录不实现每项目同级布局，也没有自定义分支前缀选项；产品配置同步保留原生 Worktree 设置。

## 验证边界

行为测试覆盖 `worktreeSession` 的创建回执、未知结果和保留检出，`worktreeSettingsService` 的版本冲突与应用确认，OpenClaw IPC 的引用保护，以及 Runtime Adapter 的继续和权限同步。这些入口不是本轮重新执行通过的声明。

真实 Gateway、模型发起、应用/Gateway 重启、快照恢复与中文/空格路径的完整验收仍按接入计划执行。
