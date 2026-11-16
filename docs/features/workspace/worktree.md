# 原生 Worktree 与会话接入

应用通过 OpenClaw 的托管接口创建和管理 Git worktree。分支、检出、快照、恢复与清理继续由原生运行时拥有；应用只保存产品会话映射、执行目录和入口偏好，不实现第二套 Git 生命周期。运行时版本以 `package.json.openclaw` 为准，未完成的真实 Gateway/模型验收见[现行说明与验证边界](#验证边界)。

## 用户入口

“设置 → Worktree”提供托管清单、恢复、移除、清理以及创建与存储设置。可开启“显示 Worktree 勾选框”，在新会话输入框展示本次创建选项；每次新会话默认不勾选。勾选后 Main 经 `sessions.create(worktree: true)` 创建原生会话，确认实际检出根后才准备执行。设置面板不负责日常任务创建。

勾选 Worktree 后点击发送，桌面保留新对话页面和草稿，直到 Gateway 确认原生检出并准备好首轮发送。若 Gateway 明确拒绝当前分支没有提交的仓库，且回读确认会话不存在，新对话页打开初始提交弹窗。取消保留草稿、附件和 Worktree 选择。确认会对显示的项目仓库创建本地提交，随后重新准备 Worktree。检出成功才切换到对话页并发送草稿。

桌面以所选工作目录的本地 `HEAD` 提交创建 Worktree。Main 将该提交作为明确基准交给 Gateway，已存在本地提交的项目无需配置 `origin` 或获取远程默认分支。尚无提交时，由 Gateway 识别首次提交场景。

弹窗的文件树支持展开、搜索和逐项或按目录勾选，右侧显示已选文件。首次打开只勾选已暂存文件，候选遵循 Git 忽略规则。用户可以提交所选文件，或创建空提交从空白检出开始。Main 将提交确认绑定到原发起窗口和当前所选目录，核对仓库、分支与所选文件，保留未纳入提交的暂存项。提交已成功但检出失败时，草稿保留，后续发送使用现有提交。无法确认原生创建结果时仍使用会话检查入口。

模型创建[原生可见子会话](../assistants/profiles-and-subagents.md#原生-subagent)时可同时设置 `worktree: true`，让子会话在独立检出目录执行。Worktree 设置面板按原生托管注册表显示和操作检出；通过 shell 运行普通 `git worktree add` 创建的目录由 Git 管理。

会话列表和聊天标题旁用浅色 Git 分支图标标记托管 Worktree 会话。图标使用现有会话状态读取返回的原生 Worktree 信息，按已绑定的原生会话 key 匹配。已确认的创建回执也可提供首轮发送时的标记。

设置页的托管工作目录卡片展示分支和检出状态，并分别标注检出目录、源项目和最近活动时间。恢复、移除和清理仍由原生接口完成。

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

继续已绑定的 Worktree 会话时重新核对原生会话身份、检出身份和实际目录，并同步产品选择的原生权限。项目归属与实际执行根分别处理；审批、文件预览、Review 及执行使用实际检出根。原生子会话的通用权限接入规则见[执行引擎](../../architecture/05-agent-engine.md)。

Worktree 会话暂不支持复制/分叉：普通消息 fork 不继承检出所有权，复用旧目录会让副本受原会话删除影响。消息与角色文件仍由原生接口管理，不复制 transcript 或移动项目角色规则。

## 恢复、删除与清理

清单和操作使用 `worktrees.list/restore/remove/gc`，受原生 operator 权限及产品会话引用检查约束。仍被本地会话引用的 worktree 不能在面板直接移除，先处理关联会话。删除会话或取消创建须确认原生删除成功；`worktreePreserved` 或结果未知时保留入口与原因，不直接递归删除目录或分支，不把发送删除请求当成清理完成。

### 清理回执与未知结果

`worktrees.gc` 返回后台清理任务回执，`queued` / `running` 只表示已接收或仍在执行。Main 在同一 Gateway 生命周期内保留任务 ID，只查询同一个原生任务，收到 `completed` 后才刷新清单；`failed` 显示原生失败，观察期间界面保持忙碌。并发窗口共用当前观察，不重复提交清理。

断线、90 秒观察预算耗尽、回执不合法或 Gateway 代次更换时，保留未确认任务与现有清单。再次检查已知任务只使用原 `jobId`，不能重新发送空参数启动替代清理；首次回复丢失、任务已不在原生保留窗口或原 Gateway 已退役时，无法确认原结果，不能报告清理完成。该观察回执只在当前 Main 进程内保留，不构成持久清理账本。

原生快照与闲置回收有自己的保留期限，“可恢复”不表示永久保留。源项目、检出和快照的存储边界见[数据存储](../../architecture/10-data-storage.md)，会话身份和删除恢复见[引擎](../../architecture/05-agent-engine.md)。

## 全局创建设置

`worktreeRoot` 与 `worktreeAcceleration` 是 Gateway 全局配置，SQLite 不另建副本。设置通过带查看时 `baseHash` 的 `config.patch` 保存，与应用配置 mutation 共用排他队列；保存后重新读取并核对目录、加速值以及 `configRevisionHash/appliedConfigHash`。版本冲突、断线或超时不自动重放写入，保留草稿并允许重新读取。

空目录通过 merge-patch 的 null 清除覆盖，默认位置为 `<stateDir>/worktrees`。目录改变只影响新分配，旧检出及恢复仍使用登记路径。加速默认开启，关闭后新分配使用普通 Git 检出。当前全局目录不实现每项目同级布局，也没有自定义分支前缀选项；产品配置同步保留原生 Worktree 设置。

## 验证边界

行为测试覆盖 `worktreeSession` 的创建回执、未知结果和保留检出，`worktreeSettingsService` 的版本冲突与应用确认，OpenClaw IPC 的引用保护，以及 Runtime Adapter 的继续和权限同步。测试入口不代表本次文档整理重新执行通过。

清理任务回归覆盖 queued/running/completed/failed、原任务查询、跨窗口合并、超时/断线保留、错误任务 ID、过期 Gateway 和旧同步结果拒绝。当时的原生协议用例从严格校验的 v2026.10.6 产物加载实际 maintenance owner，只控制 scheduler 与 `runGc`；它验证回执与提交次数，不执行真实文件回收，也不启动 Gateway。历史结果见[10.6模块接口审计](../../openclaw-upgrades/v2026.10.6/module-api-audit.md)；本版重新执行范围见[10.7验证](../../openclaw-upgrades/v2026.10.7/validation.md)。

协议测试不代表完整产品验收。

真实模型发起、应用/Gateway 重启后发现与恢复、快照/清理失败和结果未知、中文/空格路径及 macOS/Linux 的完整链路尚未完成实际环境验收。取消或准备失败不得回源目录执行；清理失败不得报告已删除。
