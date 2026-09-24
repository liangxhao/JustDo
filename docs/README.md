# 工程文档

本目录面向产品维护、开发和排障。当前代码基线为应用 `v2026.8.27`、OpenClaw `v2026.9.2`；2026-09-24 按现行代码重写架构，以及聊天、权限、子任务、插件、定时任务、浏览器、认证和语音专题；分别说明数据权威、调用流程、失败恢复与当前限制。文档中的历史测试结果只适用于对应提交，不代表本轮或当前安装包的验收结果。

## 从哪里开始

1. [产品与系统总览](architecture/01-overview.md)：任务如何执行，数据由谁负责。
2. [当前实现状态](features/current-state-v2026.8.10.md)：能力、版本、数量及已知限制。
3. [开发与排障](development.md)：启动、运行时重建、验证和日志定位。
4. [系统架构](architecture/02-architecture.md)与[进程模型](architecture/03-process-model.md)：模块、进程、IPC 和启动退出顺序。

## 文档类型

- `architecture/`：持续维护的架构与数据契约，说明权威、调用链和失败语义。
- `features/`：领域实现说明，以及明确标注日期的审计与重构记录。文件名含 plan 不代表尚未实现，以开头状态和现行专题为准。
- `archive/`：已退出产品的交互和早期方案，仅用于理解历史决策。
- `releases/`：不可按当前源码改写的发布记录。
- 接口和分发指南：面向扩展、适配器或部署使用者，可独立阅读。

## 架构专题

| 文档                                                                   | 主要问题                                     |
| ---------------------------------------------------------------------- | -------------------------------------------- |
| [Cowork](architecture/04-cowork-system.md)                             | 会话身份、发送、停止、目标与子任务           |
| [Agent Engine](architecture/05-agent-engine.md)                        | Gateway 生命周期、适配、权限和恢复           |
| [插件系统](architecture/07-plugin-system.md)                           | Skill、MCP、Hook、Extension 的管理与执行边界 |
| [定时任务](architecture/08-scheduled-tasks.md)                         | 原生 cron、结果收件箱和删除补偿              |
| [数据存储](architecture/10-data-storage.md)                            | 产品 schema、迁移、保留和消息权威            |
| [安全模型](architecture/11-security-model.md)                          | IPC、文件、网络、凭据与剩余风险              |
| [构建与发布](architecture/12-tech-stack.md)                            | 依赖、平台资源、ABI 和打包链路               |
| [薄前端设计](architecture/13-pure-frontend-design.md)                  | 显示状态与执行状态的区别                     |
| [所有权判定](architecture/14-openclaw-frontend-boundary-plan.md)       | 新能力应该落在哪一层                         |
| [聊天渲染](architecture/15-chat-rendering.md)                          | 历史、实时流、恢复、工具卡和 Markdown        |
| [市场适配](architecture/16-skill-marketplace-adapter.md)               | Provider contract 与安装事务                 |
| [Windows 原生沙盒](architecture/17-windows-native-sandbox.md)          | 工具进程隔离及平台限制                       |
| [Gateway 能力矩阵](architecture/openclaw-gateway-capability-matrix.md) | 原生能力、产品实现和补丁的边界               |

编号 06 和 09 没有对应主题，不为补齐编号创建占位文档。

## 功能与实现说明

### 助手与协作

[助手管理](features/multi-agent.md)说明设置、角色文件和历史保留；[协作机制](features/multi-agent-collaboration.md)说明启用、准备成员、原生发送、预算与恢复；[任务内协作](features/task-scoped-agent-collaboration.md)记录当前设计与早期方案的差异；[原生验证](features/native-collaboration-verification.md)提供手动检查步骤。

相关实施记录：[模型创建助手](features/conversation-agent-creation-plan.md)、[会话菜单](features/collaboration-session-menu-plan.md)、[协作展示](features/collaboration-display-implementation.md)。历史说明不得覆盖现行机制。

### 对话、目标与运行权限

- [消息链路](features/chat-message-flow-review-2026-07-26.md)、[时间线](features/chat-message-timeline-refactor-plan.md)、[Thinking](features/thinking-stream-implementation.md)、[进度卡](features/openclaw-progress-card-ui.md)。
- [会话权限](features/openclaw-permission-management-remediation-plan.md)、[运行参数](features/subagent-runtime-settings-audit.md)、[子任务恢复](features/subagent-model-retry-and-announce-consistency-plan.md)。
- [定时任务结果](features/scheduled-task-in-app-results-implementation-plan.md)、[薄前端状态](features/openclaw-thin-frontend-refactor-plan.md)。

### 模型、网络、插件与集成

- [模型管理](features/model-management.md)、[内置模型认证](features/authentication-builtin-model-lifecycle.md)、[语音](features/local-tts.md)。
- [Plugin Hub](features/plugin-hub-experience-plan.md)、[Extension 请求头声明](features/extension-contributed-outbound-header-policy-plan.md)、[出站代理](features/outbound-header-proxy-analysis-and-redesign.md)。
- [外部 Agent](features/external-agent-adapters.md)、[Multica](features/multica-integration.md)。

### 浏览器与桌面

- [浏览器设计](features/browser-settings-design.md)、[扩展侧栏聊天](features/browser-extension-side-chat.md)、[操作演示](features/browser-operation-recording.md)。
- [Windows 安装器](features/windows-installer-resilience.md)。

## 接口与分发指南

- [浏览器扩展接口](browser-extension-api/README.md)：Native Messaging、app-server、数据模型、错误和兼容边界。
- [出站请求头配置](outbound-header-guide/README.md)：可分发配置说明及 Extension 样例。
- [外部 Agent 接入](external-agent-integration-guide.md)：适配器、认证、离线资源与发布检查。
- [运行时补丁指南](patches/openclaw-patch-guide.md)：构建、验证和升级流程；能力清单以[版本目录](../scripts/patches/v2026.9.2/README.md)为准。

## 历史、审计与重构记录

以下记录保留当时的发现和测试范围，不能据此认定当前代码仍存在同一问题或已经通过全部验证：

- [2026-09-08 发送与停止审计](features/message-send-stop-review-2026-09-08.md)。
- [浏览器操作演示审查](features/browser-operation-recording-review.md)。
- [源码目录重构](features/src-directory-refactor.md)、[大文件拆分](features/src-large-file-refactor.md)。
- [早期助手与 Handoff](archive/assistant-profiles-early-implementation.md)、[早期任务协作提案](archive/task-scoped-collaboration-proposal.md)。
- [发布记录](releases/README.md)。

## 维护规则

事实核对顺序为 shared 合约 → 注册入口 → service/store/adapter → preload/Renderer 消费方 → 测试。文件存在不等于功能已接入；测试文件存在不等于本次运行通过。

架构专题应保留所有权、正常调用链、身份和状态约束、失败与恢复、已知限制及测试入口。不要用路径清单替代设计，也不要在每篇末尾不断追加互相矛盾的修改日志。

版本来自 package.json 与 lockfile，内置技能来自 manifest，Redux 来自 store 注册，表清单包括 schema 委派的初始化器。补丁清单只维护在当前版本目录，不把旧补丁数量复制到多个页面。

修改文档后运行 `git diff --check`，对改动 Markdown 执行 Prettier，检查相对链接。涉及行为变化时再运行对应代码检查和测试；文档修改本身不应为了验证而改动本地运行时或重建 native ABI。
