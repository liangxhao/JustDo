# Plan Mode

本包维护原生会话规划状态、`present_plan` 工具和只读工具策略。宿主负责计划文件显示、人工审核与实施交接，不能用一次批准扩大旧规划轮次权限。

Plan mode 使用 `api.session.state.registerSessionExtension`、`sessions.pluginPatch` 和
`sessions.describe.pluginExtensions` 保存与读取 `plan-mode/state` 会话开关，原生会话状态槽名为
`planMode`。

plan-mode、agent-team 和 Swarm Workflow 的规划门禁统一读取原生
`pluginExtensions['plan-mode'].state`，不依赖可能缺失或过期的会话槽投影。插件自有状态槽、服务注册键、
消息标记和临时路径前缀按能力或插件命名，不带产品名；应用会话身份保留现有 `justdo:` 命名空间。
`agent_turn_prepare` 注入规划约束，
`registerTrustedToolPolicy` 在执行前阻止已知变更工具。

计划工具统一命名为 `present_plan`，
保持 direct-only，不注册或识别旧工具名；
Tool Search 分发器由原生对实际目标再次执行策略。动作型工具使用上游
`isReplaySafeToolCall` 分类，包括 `theme` 的 list/get（允许）和 set/import（阻止）。
此策略不是任意第三方工具的通用只读沙盒：未识别的工具仍需审核其实际副作用，不能仅凭名称保证安全。

批准只结束规划轮次，不在该轮放开写权限；Main 完成同会话 reset 后才以关闭 Plan 的状态发起实施。

输入框的“+”功能菜单提供独立的“计划模式”开关，不显示勾选，也不随功能启用改变“+”按钮颜色。
开启后，工具栏在执行权限旁显示灯泡图标与“计划”标记；悬停或键盘聚焦时，图标变为关闭叉号，
点击退出计划模式。保存期间禁用重复操作，保存失败保留当前标记并提示。
执行权限菜单只管理请求批准、智能审批和完全权限，切换权限不改变计划模式。
`/plan` 不再提供命令入口；运行期间不能开启计划模式，但已开启时仍可从“+”菜单关闭，
待审计划通过现有服务取消后退出，即使计划审批暂时禁用了普通输入。

规划约束不是任意第三方工具的通用只读沙箱。独立集成须提供兼容的会话状态、工具策略与人工审核流程；原生执行结果仍要求精确整轮结算。
