# OpenClaw 9.8 主机验证：聊天、子代理、权限与计划目标

验证日期：2026-10-04；代码基线：`477fe62fa`。本轮按主机最终验证分工执行现有自动化测试，不启动真实账户模型请求，不修改 SQLite ABI，不改变主目录运行时。主目录安装与原生集成由主验证报告记录，本文不以此前隔离运行时结果冒充主目录验证。后续按用户要求移除了本次新增的未发布 9.6 旧数据迁移；本文涉及迁移入口的记录仅为已撤回方案的历史证据。

## 结果

**113 个测试文件、1604 项测试全部通过**，用时 12.50 秒。结果保存在 `.tmp/host-validation-chat-tests.log`。此次未发现新增失败，不需要追加生产代码修改。

测试集包含 `src/renderer/libs/openclaw-chat/` 全目录；Main 的权限协调、审批授权、目标续跑；运行时 adapter 的审批、Plan、Goals、SubAgent、history、turn-lifecycle；子代理 Gateway 适配及操作；Renderer 的子代理、审批、目标组件；计划插件；共享审批契约和审批 IPC。

使用 `npx vitest run` 直接运行这些目标文件和目录，没有执行会切换原生模块 ABI 的 `npm test` 包装脚本。Gateway、Electron 和外部请求在对应测试中采用已有 fixture/mock；没有连接用户真实账户。日志中存在 Lit 开发模式重复更新提示，但没有测试失败；这不是桌面性能验收结论。

## 第二轮修复的最终覆盖

| 修复/风险 | 本轮检查的行为证据 | 结果 |
| --- | --- | --- |
| native skipped 误显示失败或完成 | `tool-presentation.test.ts` 分别输入实时 item、工具 details 和历史 activity；保留 skipped 并计数。`active-turn-timeline.test.ts` 检查独立状态标签 | 通过 |
| queued 或旧身份终态清理当前执行 | `openclawRuntimeAdapter.turn-lifecycle.test.ts` 的三组行覆盖 queued、旧 run、另一原生 session；先确认当前 turn 未清理，再发送匹配当前身份的 done 确认可正常结束 | 通过 |
| tasks API 移除后的子任务操作 | `subagentGateway.operations.test.ts` 检查原生子任务取消/清理排队、模糊响应、后代归属、分页 cursor、父身份重新授权；`subagentGateway.test.ts` 及 adapter 测试检查状态与快照映射 | 通过 |
| 子任务界面旧状态或旧选择污染 | `SubtaskControls.test.tsx` 检查精确身份、重复提交、不确定操作禁用、选择变化后忽略旧响应；`SubtaskListPanel.test.tsx` 检查原生摘要、分页历史、子级导航、刷新失效及会话切换 | 通过 |
| 权限变更尚未原生生效即启动下一轮 | `sessionPermissionModeCoordinator.test.ts` 检查保存失败不调用 Gateway、失败待重试、活动 turn 延后、串行更新与 continuation 前准备；共享映射与 adapter 审批测试同时执行 | 通过 |
| 审批断线恢复及复用扩大授权 | 审批 adapter、IPC、`sessionExecApprovalGrants.test.ts` 和共享合约覆盖请求/决定、快照恢复与精确授权绑定 | 通过 |
| Plan/Goals 过早进入实施或重复续跑 | `planModePlugin.test.ts` 覆盖只读阶段、批准、重新检查模式、取消后重试；adapter plans/goals 与 `goalContinuationCoordinator.test.ts` 检查交接、执行终态和续跑身份；目标展示/操作测试同步执行 | 通过 |

所有表格中的文件均为仓库现有测试，本轮重新执行，而非只引用以前的通过记录。集合内测试共享 fixture，并不等同于以真实原生进程完成全部端到端行为。

## 界面测试实际覆盖到哪里

本轮已执行仓库现有 jsdom + Testing Library / Lit 组件测试，并非仅检查纯函数：

- `justdo-chat.streaming.test.ts` 实际渲染隔离 turn 的 Thinking/Tool/Content 时间线、实时前导内容、文本分帧、工具前刷新，以及原生历史接管后不重复显示。
- `chat-controller.reconnect.test.ts`、session-lifecycle/native-recovery/history 等 controller 测试验证订阅、断线恢复和快照合并；组件测试同时验证最终呈现。
- 子任务组件测试通过点击/选择/刷新/关闭等模拟事件验证状态操作、导航、消息抽屉和旧响应抑制。抽屉测试中的 ChatController 使用替身，因此不能拿它证明真实原生历史传输成功。
- 审批组件当前测试重点是决定选项、摘要与截止时间的解析，不声称已在真实 Electron 弹窗中验证每个交互。

没有为本轮安装新的浏览器驱动，也没有将浏览器模拟环境称为真实桌面验收。真实 Gateway 的本地 SSE 模型及 read 工具链已在前一专项报告中记录；本轮主目录真实运行时 smoke 由主验证任务执行，结果应以它为准。

## 仍缺的真实界面场景

1. Electron 中真实模型长时间连续 Thinking → Tool → Content；执行中切换会话、断网重连、重启应用并翻阅历史，核对视图与原生历史的一致性、滚动位置及性能。
2. 跨 profile 的父子任务实际创建、完成、打开历史、执行中停止与再次发送；取消期间原生会话重建的竞争需要真实调度测试。native abort 没有 expectedSessionId 原子比较参数的限制仍在。
3. 请求/智能/完全三档权限下，真实工作区内外写入与命令执行；模式在运行中改变后，下一轮确实执行对应策略；操作系统权限或第三方插件自身限制不能由 mock 证明。
4. 断线期间弹出的审批、过期与重复点击；恢复后检查真正的弹窗焦点和原生决定结果。计划拒绝/修改/批准后的真实实施交接，以及目标预算耗尽/暂停/恢复跨重启。
5. 9.8 新增 pendingInput queued/count/cancelled 收据尚未对应完整队列计数/逐条取消界面；waiting_for_state/state_contention 目前使用通用等待/错误展示。它们属于已明确记录的新功能 UI 缺口，不应因自动化全绿被描述为完成。

本轮结论是现有应用合约、状态归属和组件行为回归通过；不扩大为所有真实账户、系统权限、插件副作用和桌面交互均已验收。

## 补充：真实 Electron 隔离窗口验证

在主任务确认 `npm test` 结束、Electron ABI 已恢复之后，使用现有编译产物和主目录正式 9.8 runtime 执行 `tests/openclaw/runtime/electron-isolated-ui-smoke.cjs`。这是实际 Electron 主进程、preload、Renderer 和原生 Gateway；未替换产品 API，也未发送模型推理请求。

仅设置 `JUSTDO_DEV_USER_DATA_DIR` 不足以隔离登录：出站请求头及内置登录文件仍依据 `app.getPath('appData')` 查找。因此 harness 的独立启动入口先把 Electron appData/userData/home 及子进程 APPDATA/LOCALAPPDATA/USERPROFILE/OPENCLAW 路径指向新建临时目录，再加载原编译入口，并断言实际路径。采用 development、非 packaged 模式，跳过仅打包版启动时执行的浏览器 native-host 注册；也未使用会注册宿主的 `run-electron-dev` 脚本。没有改生产逻辑，没有关闭其他应用。

### 历史构建缺陷记录（相关迁移方案已撤回）

首次实际启动曾发现迁移子进程入口未被 Vite 带入产物，导致全新隔离 profile 也无法启动 Gateway。当时补齐资源发出和 watch 依赖，正式 build/compile 后复验通过。此后因 9.6 未发布，用户要求撤回整个新增兼容方案；迁移入口及此项 Vite 资产均已移除，不再是当前构建要求。

当时最终运行明确断言 Gateway `phase: running`、`version: 2026.9.8`，并在页面导航结束后再次断言 running。进程退出码 0，Renderer 未捕获 pageerror。以下9项页面证据保留，但不能将其表述为删除迁移后已复跑；后续复验由主报告另录。测试选择器曾将权限项 role=option 写成 button，以及误用 Escape 返回设置；这两处属于 harness 问题，已修正，不计为产品缺陷。

### 实际通过的 9 项检查

| 检查 | 实际观察 | 截图 |
| --- | --- | --- |
| 首页 | 完成初始化，显示新对话输入区与“无模型可用”；没有用户凭据 | `01-home.png` |
| 执行权限菜单 | 请求批准、智能审批、Plan 模式、完全权限可见；只展开查看，不修改设置 | `01-permission-options.png` |
| 记忆面板 | 原生 main 助手的初始 USER.md、空长期/每日记忆状态可见；索引后台检查不代表索引完成 | `02-memory.png` |
| 设置 | 真实设置导航正常进入 | `03-settings.png` |
| 模型 | 模型分类与供应商界面、无可用模型状态正确显示；未测试连接或保存密钥 | `04-models.png` |
| 安全 | 本机/沙盒设置界面显示；只浏览，不切换隔离策略 | `05-permissions.png` |
| 插件 | 等待安装分组加载完成，显示 32 个系统与内置扩展、0 个用户扩展；非 loading 截图 | `06-plugins.png` |
| 定时任务 | 系统任务与新建入口可见；未点击立即运行 | `07-tasks.png` |
| 任务看板 | 等待原生列表加载，四列空卡片状态正常；未创建或执行任务 | `08-workboard.png` |

最终证据目录：`C:/Users/lianghao/AppData/Local/Temp/justdo-electron-ui-YfLvOk/`，含以上 9 张截图、对应页面文本及 `result.json`。仓库日志：`.tmp/host-electron-ui-smoke-final.log`。已查看权限、记忆、插件及任务看板截图确认实际页面内容；harness ESLint 与语法检查通过。

这补齐了“实际桌面窗口能否启动并浏览功能”的验证，但没有覆盖上文列出的真实模型流、权限执行副作用、审批决定、Plan 实施交接及目标跨重启续跑。空 profile 的 UI 冒烟不能替代那些行为验收。

### 删除迁移后的复验

主任务移除 SQLite 兼容迁移链并清除旧构建辅助入口后，engineManager 23项、标准 build 与 compile:electron 通过；同一 UI harness 在全新隔离 profile 再次完成9项检查，Gateway running/2026.9.8，rendererErrors为空。证据目录：`C:/Users/lianghao/AppData/Local/Temp/justdo-electron-ui-o3cdDf/`；日志：`.tmp/remove-98-migration-ui.log`。此结果发生在后续 Decision 与旧自定义视频兼容清理之前，不冒充其完成后的UI复验。

最终全部兼容清理完成后，标准 build 与 compile:electron 再次通过（日志：.tmp/remove-98-compat-final-build.log、.tmp/remove-98-compat-final-compile.log）；全新真实 Electron 隔离验证9项全部通过，Gateway running/2026.9.8，rendererErrors为空。最终证据目录：C:/Users/lianghao/AppData/Local/Temp/justdo-electron-ui-PWr5DJ/；日志：.tmp/remove-98-compat-final-ui.log。它覆盖 SQLite 迁移链和三类配置兼容都删除后的最终代码状态。
