# 功能文档

本目录只维护当前已接入的用户流程、实现契约和已知限制。剩余候选设计和验收见[计划索引](../plans/README.md)。尚未完成真实环境验收的功能仍保留限制，不能因移出计划目录而视为验收通过。

## 对话与助手

| 领域 | 现行文档                                                                                        | 分工                                                |
| ---- | ----------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| 对话 | [输入框功能菜单](chat/composer-feature-menu.md)                                                 | 注册、启用过滤、草稿与菜单交互                      |
| 对话 | [运行参数](chat/agent-runtime-settings.md) / [权限管理](chat/openclaw-permission-management.md) | 容量与超时调优、执行授权分别管理                    |
| 对话 | [会话诊断](chat/session-diagnostics.md)                                                         | 本地证据、日志扫描、结束原因与脱敏导出              |
| 对话 | [交互式回答](chat/interactive-answers.md)                                                       | 原生卡片、可选组件、选择回到草稿与失败恢复          |
| 助手 | [长期助手与任务内协作](assistants/assistants-and-collaboration.md)                              | 角色档案、助手切换、agent-team 与原生 SubAgent 边界 |

消息、Thinking、工具、音视频与 Review 的完整渲染链路统一在[聊天渲染架构](../architecture/15-chat-rendering.md)，不另用旧渲染计划维护现状。

## 工作区与工作流

| 领域   | 现行文档                                             | 分工                                               |
| ------ | ---------------------------------------------------- | -------------------------------------------------- |
| 工作区 | [侧边栏首页](workspace/sidebar-home.md)              | 新标签页、工具入口和最近访问                       |
| 工作区 | [独立窗口](workspace/detached-workspace.md)          | 完整侧栏拆出/收回、状态保留与窗口生命周期          |
| 工作区 | [Worktree](workspace/worktree.md)                    | 原生托管检出、会话身份、创建/恢复/清理             |
| 工作流 | [Swarm Workflow](workflow/swarm-workflow.md)         | 普通 DAG、助手指派、主会话工具与人工介入的统一说明 |
| 工作流 | [Swarm 批量执行](workflow/swarm-workflow-batches.md) | 批次输入、预算、长任务、产物、分页与失败项重试     |
| 工作流 | [Workboard](workflow/workboard.md)                   | 独立原生看板的卡片与执行契约                       |

Swarm 主会话管理已并入主说明；批次是独立的扩展契约。Workboard、agent-team 与原生 collector 各有自己的身份与执行生命周期，不因为都有图形界面而合并。

## 浏览器

| 文档                                                   | 分工                                                                               |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| [浏览器模式与设置](browser/browser-settings-design.md) | 四种工具模式、真实 guest、代理、文件与配对边界                                     |
| [人工介入](browser/browser-intervention.md)            | 停止确认、页面保护、人工操作与明确继续                                             |
| [操作演示](browser/browser-operation-recording.md)     | 人工录制、步骤编辑、截图与普通消息发送                                             |
| [扩展侧栏聊天](browser/browser-extension-side-chat.md) | 用户路径与产品会话集成；逐字段规范见[扩展 API](../browser-extension-api/README.md) |

这四篇共享浏览器基础，但分别负责模式配置、执行控制、演示材料和扩展客户端，不混合各自的授权与取消规则。

## 模型、插件与集成

| 领域       | 现行文档                                                               | 分工                                                     |
| ---------- | ---------------------------------------------------------------------- | -------------------------------------------------------- |
| 模型       | [模型管理](models/model-management.md)                                 | 语言、决策、语音、图像与视频的目录和选择                 |
| 模型       | [语音与本地转录](models/local-tts.md)                                  | 输入、朗读、附件转录与离线模型                           |
| 模型       | [Jev / TypeSafe](models/jev-integration.md)                            | 决策模型与原生 decision_evaluate 的 provider 接入        |
| 插件       | [Plugin Hub](plugins/plugin-hub-experience.md)                         | 列表、来源、导入、市场与受保护扩展                       |
| 账号       | [登录 SDK 模板](integrations/login-sdk-template.md)                    | 已实现的 LoginService 和 SDK 接缝；真实 SDK 尚未接入     |
| 账号       | [内置模型认证](integrations/authentication-builtin-model-lifecycle.md) | mtoken/JWT、模型发现、轮换与退出清理                     |
| 网络       | [出站请求头](integrations/outbound-headers.md)                         | 手工与 Extension 策略、Main 注入、Gateway 代理的统一契约 |
| 外部客户端 | [Multica](integrations/multica-integration.md)                         | launcher、受认证桥接、会话恢复与协议边界                 |

账号 UI/SDK、模型换证与开发调用步骤的所有者不同：先从上表阅读相应实现，再从[开发接入索引](../developer-integration/README.md)查接口和示例。待复验的内网模型、企业网页及冷历史恢复集中在[内网验收清单](../plans/intranet-feature-acceptance.md)。
