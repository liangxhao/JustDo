# 工程文档

本目录面向产品维护、开发和排障。版本以 `package.json` 和锁文件为准；能力从[产品与系统总览](architecture/01-overview.md)进入，并以各专题及代码核对。历史测试结果只适用于对应提交。

## 从哪里开始

1. [产品与系统总览](architecture/01-overview.md)：任务如何执行，数据由谁负责。
2. [开发与排障](development.md)：启动、运行时重建、验证和日志定位。
3. [系统架构](architecture/02-architecture.md)与[进程模型](architecture/03-process-model.md)：模块、进程、IPC 和启动退出顺序。

## 文档类型

- `architecture/`：持续维护的架构与数据契约，说明权威、调用链和失败语义。
- `features/`：领域实现说明，以及仍在推进的方案；方案开头应标明已完成部分与待验证事项。
- `releases/`：不可按当前源码改写的发布记录。
- `openclaw-upgrades/`：按版本保存 OpenClaw 升级审计；不作为现行能力清单。
- `developer-integration/`：模块接口接入、外部 Agent 适配，以及可分发的 Extension 配置指南与示例。

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
| [所有权判定](architecture/14-openclaw-frontend-boundary.md)            | 新能力应该落在哪一层                         |
| [聊天渲染](architecture/15-chat-rendering.md)                          | 历史、实时流、恢复、工具卡和 Markdown        |
| [市场适配](architecture/16-skill-marketplace-adapter.md)               | Provider contract 与安装事务                 |
| [Windows 原生沙盒](architecture/17-windows-native-sandbox.md)          | 工具进程隔离及平台限制                       |
| [Gateway 能力矩阵](architecture/openclaw-gateway-capability-matrix.md) | 原生能力、产品实现和补丁的边界               |

编号 06 和 09 没有对应主题，不为补齐编号创建占位文档。

## 功能与实现说明

### 助手与协作

[长期助手与任务内协作](features/assistants-and-collaboration.md)说明档案管理、成员准备、原生发送、预算、恢复与验证。

### 对话、目标与运行权限

- [聊天渲染](architecture/15-chat-rendering.md)：发送、时间线、Thinking、进度卡和恢复。
- [会话权限](features/openclaw-permission-management.md)、[运行参数](features/agent-runtime-settings.md)、[执行引擎与子任务](architecture/05-agent-engine.md)。
- [定时任务结果](architecture/08-scheduled-tasks.md)、[薄前端状态](architecture/13-pure-frontend-design.md)。

### 模型、网络、插件与集成

- [模型管理](features/model-management.md)、[内置模型认证](features/authentication-builtin-model-lifecycle.md)、[语音](features/local-tts.md)。
- [Plugin Hub](features/plugin-hub-experience.md)、[Extension 请求头声明](features/extension-contributed-outbound-header-policy.md)、[出站代理](features/outbound-header-proxy-analysis-and-redesign.md)。
- [Multica](features/multica-integration.md)。

### 浏览器与桌面

- [浏览器设计](features/browser-settings-design.md)、[扩展侧栏聊天](features/browser-extension-side-chat.md)、[操作演示](features/browser-operation-recording.md)。
- [Workboard](features/workboard.md)：操作契约与验证。

## 接口与分发指南

- [浏览器扩展接口](browser-extension-api/README.md)：Native Messaging、app-server、数据模型、错误和兼容边界。
- [出站请求头配置](developer-integration/outbound-headers/README.md)：可分发配置说明及 Extension 样例。
- [开发接入接口索引](developer-integration/README.md)：后续模块需要适配的接口与调用要求。
- [外部 Agent 接入](developer-integration/external-agent-integration-guide.md)：适配器、认证、离线资源与发布检查。
- [运行时补丁指南](openclaw-runtime-patches.md)：构建、验证和升级流程；能力清单以[当前版本目录](../scripts/patches/v2026.9.6/README.md)为准。
- [Windows 安装器](windows-installer.md)：平台故障、数据归属和验证。

运行时版本升级记录见[OpenClaw 升级目录](openclaw-upgrades/README.md)。

发布历史见[发布记录](releases/README.md)；其中的验证结论只适用于对应版本。

仍待完成的真实环境验证集中在[内网功能验收](features/intranet-feature-acceptance.md)。

## 维护规则

事实核对顺序为 shared 合约 → 注册入口 → service/store/adapter → preload/Renderer 消费方 → 测试。文件存在不等于功能已接入；测试文件存在不等于本次运行通过。

架构专题应保留所有权、正常调用链、身份和状态约束、失败与恢复、已知限制及测试入口。不要用路径清单替代设计，也不要在每篇末尾不断追加互相矛盾的修改日志。

版本来自 package.json 与 lockfile，内置技能来自 manifest，Redux 来自 store 注册，表清单包括 schema 委派的初始化器。补丁清单只维护在当前版本目录，不把旧补丁数量复制到多个页面。

修改文档后运行 `git diff --check`，对改动 Markdown 执行 Prettier，检查相对链接。涉及行为变化时再运行对应代码检查和测试；文档修改本身不应为了验证而改动本地运行时或重建 native ABI。
