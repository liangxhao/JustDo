# 功能文档

本目录只维护当前已接入的用户流程、实现契约和已知限制。仅仍需记录的具体未实施需求见[需求索引](../plans/README.md)，验证边界随对应功能维护。尚未完成真实环境验收的功能仍保留限制，不能因移出计划目录而视为验收通过。

## 应用导航与启动

| 文档                                                           | 维护范围                                             |
| -------------------------------------------------------------- | ---------------------------------------------------- |
| [导航、会话列表与设置外壳](app/navigation-and-session-list.md) | 左侧导航、完整目录与按需摘要、来源组、宽度和设置草稿 |
| [启动分流与历史升级](app/startup-and-history-upgrade.md)       | 首装、历史导入、普通启动、共用引导与恢复事务         |

## 对话与交互内容

| 文档                                              | 维护范围                                                 |
| ------------------------------------------------- | -------------------------------------------------------- |
| [MCP Apps](chat/mcp-apps.md)                      | 标准应用界面、手动入口、原生提问、文件与上下文的桌面宿主 |
| [消息中的独立网页](chat/webpage-embeds.md)        | embed 短码、联网 HTML、托管认证与浏览器代理              |
| [消息文件链接](chat/message-file-links.md)        | 保守路径识别、输出约定、点击时工程解析与侧栏预览         |
| [交互式回答](chat/interactive-answers.md)         | 原生卡片、可选组件、选择回到草稿与失败恢复               |
| [draw.io 离线绘图](chat/drawio-offline.md)        | 编辑器、离线资源打包与本地导出                           |
| [draw.io 当前画布](chat/drawio-current-canvas.md) | 图表身份、连续修改、撤销与确认结果恢复                   |

标准 App 宿主管理视图与权限；[MCP App 引用接入](plugins/mcp-app-references.md)管理通用引用协议；
draw.io 两篇只维护自己的资源与编辑业务。三者不互相复制完整契约。
消息、Thinking、工具、音视频与 Review 的渲染链路统一在[聊天渲染架构](../architecture/15-chat-rendering.md)。

## 运行与助手

| 领域 | 现行文档                                                                                        | 分工                                                       |
| ---- | ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| 对话 | [输入框功能菜单](chat/composer-feature-menu.md)                                                 | 注册、启用过滤、草稿与菜单交互                             |
| 对话 | [运行参数](chat/agent-runtime-settings.md) / [权限管理](chat/openclaw-permission-management.md) | 容量与超时调优、执行授权分别管理                           |
| 对话 | [Goal 模式](chat/goal-mode.md)                                                                  | 自动续跑、原生身份校验、不确定发送与操作回执恢复           |
| 对话 | [会话诊断](chat/session-diagnostics.md)                                                         | 本地证据、日志扫描、结束原因与脱敏导出                     |
| 助手 | [长期助手与任务内协作](assistants/assistants-and-collaboration.md)                              | 角色档案、助手切换、agent-team 与原生 SubAgent 边界        |
| 助手 | [Agent Team](assistants/agent-team.md)                                                          | 协作 Graph、群组讨论、组织者、资源设置、待发输入及执行恢复 |

## 工作区与工作流

| 领域   | 现行文档                                             | 分工                                               |
| ------ | ---------------------------------------------------- | -------------------------------------------------- |
| 工作区 | [侧边栏首页](workspace/sidebar-home.md)              | 新标签页、工具入口和最近访问                       |
| 工作区 | [文件预览](workspace/file-preview.md)                | 文件格式清单、原生 PDF／媒体、源码与插件入口       |
| 工作区 | [独立窗口](workspace/detached-workspace.md)          | 完整侧栏拆出/收回、状态保留与窗口生命周期          |
| 工作区 | [Worktree](workspace/worktree.md)                    | 原生托管检出、会话身份、创建/恢复/清理             |
| 工作流 | [Swarm Workflow](workflow/swarm-workflow.md)         | 普通 DAG、助手指派、主会话工具与人工介入的统一说明 |
| 工作流 | [Swarm 批量执行](workflow/swarm-workflow-batches.md) | 批次输入、预算、长任务、产物、分页与失败项重试     |
| 工作流 | [Workboard](workflow/workboard.md)                   | 独立原生看板的卡片与执行契约                       |

Swarm 主会话管理已并入主说明；批次是独立的扩展契约。Workboard、agent-team 与原生 collector 各有自己的身份与执行生命周期，不因为都有图形界面而合并。

## 浏览器

| 文档                                                   | 分工                                                                                   |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------- |
| [浏览器模式与设置](browser/browser-settings-design.md) | 四种工具模式、真实 guest、代理、文件与配对边界                                         |
| [人工介入](browser/browser-intervention.md)            | 停止确认、页面保护、人工操作与明确继续                                                 |
| [操作演示](browser/browser-operation-recording.md)     | 人工录制、步骤编辑、截图与普通消息发送                                                 |
| [扩展侧栏聊天](browser/browser-extension-side-chat.md) | 用户路径与产品会话集成；逐字段规范见[Chrome 接口](../app-server-api/browser/README.md) |

这四篇共享浏览器基础，但分别负责模式配置、执行控制、演示材料和扩展客户端，不混合各自的授权与取消规则。

## 模型、插件与集成

| 领域       | 现行文档                                                               | 分工                                                     |
| ---------- | ---------------------------------------------------------------------- | -------------------------------------------------------- |
| 模型       | [模型管理](models/model-management.md)                                 | 语言、决策、语音、图像与视频的目录和选择                 |
| 模型       | [语音与本地转录](models/local-tts.md)                                  | 输入、朗读、附件转录与离线模型                           |
| 模型       | [Jev / TypeSafe](models/jev-integration.md)                            | 决策模型与原生 decision_evaluate 的 provider 接入        |
| 插件       | [内置技能](plugins/bundled-skills.md)                                  | 技能源文件、运行时投影与维护边界                         |
| 插件       | [MCP App 引用接入](plugins/mcp-app-references.md)                      | 通用侧栏引用、稳定内容关联、紧凑历史回执与恢复边界       |
| 插件       | [Plugin Hub](plugins/plugin-hub-experience.md)                         | 列表、来源、导入、市场与受保护扩展                       |
| 账号       | [登录 SDK 模板](integrations/login-sdk-template.md)                    | 已实现的 LoginService 和 SDK 接缝；真实 SDK 尚未接入     |
| 账号       | [内置模型认证](integrations/authentication-builtin-model-lifecycle.md) | mtoken/JWT、模型发现、轮换与退出清理                     |
| 网络       | [出站请求头](integrations/outbound-headers.md)                         | 手工与 Extension 策略、Main 注入、Gateway 代理的统一契约 |
| 外部客户端 | [通用 CLI / ACP](integrations/agent-cli.md)                            | 默认可用命令行、ACP、app-server 子集与客户端接入示例     |
| app-server | [统一 app-server](integrations/app-server.md)                          | Chrome 与 CLI 共用协议引擎，保留能力和生命周期边界       |

账号 UI/SDK、模型换证与开发调用步骤的所有者不同：先从上表阅读相应实现，再从[开发接入索引](../developer-integration/README.md)查接口和示例。内网模型、企业网页及冷历史恢复的验证边界分别维护在插件、浏览器和数据存储说明中。

## 文档归属

- `architecture/` 维护跨进程边界、权威来源、安全与通用基础设施；本目录维护用户流程和领域契约。
- 每项契约只在所属领域维护完整定义，其他文档链接到该定义。独立的授权与生命周期不能为减少文件而合并。
- 验证段落说明测试入口、证据范围和当前限制；历史测试数量、逐轮审查和修复流水不作为现行契约。
  运行时升级证据见对应 `openclaw-upgrades/` 记录，未验收不因整理或删除计划而变成通过。
- 仍需实施的具体需求归 `plans/`；已完成或撤回内容回收到所属现行文档后删除，历史由 Git 追溯。
