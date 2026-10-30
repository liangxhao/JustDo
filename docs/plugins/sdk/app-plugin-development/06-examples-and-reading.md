# 06 示例导读与阅读地图

本章既是推荐阅读列表，也是按需求定位源码的地图。先理解合同，再看一个入口如何使用它，最后读领域实现和测试；不要从最复杂的协调器开始整包复制。

## 第一次开发的顺序

1. [快速入门](01-quick-start.md)与 [Hello Panel](examples/hello-panel)：跑通没有复杂执行副作用的完整包。
2. [目录与清单](02-package-and-manifests.md)：区分 Native / Main / Browser、源码与产物、hash 与 epoch。
3. [SDK 作者摘要](../../../../plugins/sdk/app-plugin-sdk/README.md)与公开类型：查准确签名。
4. [Main 开发](03-native-and-main.md)和 [Browser 开发](04-browser-and-ui.md)：按业务选择重点。
5. [构建与安装](05-build-test-and-install.md)：核对受管安装、精确信任登记和生命周期。
6. [宿主架构](../app-plugin-runtime.md)：理解独立插件为什么需要原生身份、保留产物和清理账本。

## 按任务查公开 SDK

| 任务                                 | 优先阅读                                                                                                                                         |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| 清单、调用、错误、事件和产物身份     | [contracts.ts](../../../../plugins/sdk/app-plugin-sdk/contracts.ts)                                                                                    |
| Main 注册、会话端口、提交/资源参与者 | [main.ts](../../../../plugins/sdk/app-plugin-sdk/main.ts)                                                                                              |
| 视图、模式、摘要和消息投影           | [browser.ts](../../../../plugins/sdk/app-plugin-sdk/browser.ts)                                                                                        |
| Browser 产品服务与明确效果           | [application.ts](../../../../plugins/sdk/app-plugin-sdk/application.ts)                                                                                |
| 产品元数据的只读投影                 | [metadata.ts](../../../../plugins/sdk/app-plugin-sdk/metadata.ts)                                                                                      |
| 子 Agent 来源映射与问答展示          | [execution-source.ts](../../../../plugins/sdk/app-plugin-sdk/execution-source.ts)、[interactions.ts](../../../../plugins/sdk/app-plugin-sdk/interactions.ts) |
| 精确原生快照的规划状态解释           | [planning.ts](../../../../plugins/sdk/app-plugin-sdk/planning.ts)                                                                                      |
| 共享 React、UI 与 composer styles    | [browser-runtime.ts](../../../../plugins/sdk/app-plugin-sdk/browser-runtime.ts)、[ui.ts](../../../../plugins/sdk/app-plugin-sdk/ui.ts)                       |
| 通用显示组件和 rendering 类型        | [presentation.ts](../../../../plugins/sdk/app-plugin-sdk/presentation.ts)、[rendering.ts](../../../../plugins/sdk/app-plugin-sdk/rendering.ts)               |
| 原生单文件支持边界                   | [native-profile.ts](../../../../plugins/sdk/app-plugin-sdk/native-profile.ts)                                                                          |

SDK 是作者可依赖的合同；宿主实现源码可以用来核实行为，但不能作为插件 import 入口。

## Agent Team：产品协调、讨论和完整 UI

建议按下面顺序阅读：

1. [功能说明](../../extensions/agent-team/guide.md)、[助手与协作边界](../../../features/assistants/profiles-and-subagents.md)：理解任务协作、群组讨论、来源会话和原生 SubAgent 的区别。
2. [应用清单](../../../../plugins/extensions/agent-team/app.plugin.json)、[原生清单](../../../../plugins/extensions/agent-team/openclaw.plugin.json)：把 command / slot 与实际入口对应起来。
3. [原生 index.ts](../../../../plugins/extensions/agent-team/index.ts)：了解工具、服务和历史能力的原生组合。
4. [host/app.ts](../../../../plugins/extensions/agent-team/host/app.ts)：跟踪 Main 命令、产品协调、schema、配置和资源/提交参与者。
5. [Browser 注册](../../../../plugins/extensions/agent-team/app/browser/index.tsx)、[会话投影/observer](../../../../plugins/extensions/agent-team/app/browser/sessionPresentation.tsx)：看设置、历史、模式、首次发现和摘要如何随插件注册。
6. [设置对话框](../../../../plugins/extensions/agent-team/app/browser/settings/AgentTeamSettingsDialog.tsx)及同目录测试：看设置读写、失效结果和 UI 文案。
7. [继续协作提交](../../../../plugins/extensions/agent-team/app/browser/collaboration/collaborationContinueSubmission.ts)及相邻测试：看精确来源、待发输入、取消和未知结果。
8. [执行来源映射](../../../../plugins/extensions/agent-team/host/executionSession.ts)及相邻测试：看成员独立聊天、精确 incoming 回执、待确认来源，以及来源更新如何影响浏览器和 Ask User 展示。

适合学习：保留产品元数据但不复制 transcript、关闭时撤回 UI、仍保留必要清理保护、多种业务记录共存。

## Swarm Workflow：原生调度、事件发现和图形界面

1. [功能说明](../../extensions/swarm-workflow/workflows.md)与[批量执行](../../extensions/swarm-workflow/batches.md)：先理解 DAG、批次、来源任务、取消和恢复事实。
2. [原生入口](../../../../plugins/extensions/swarm-workflow/index.ts)、[应用清单](../../../../plugins/extensions/swarm-workflow/app.plugin.json)：看执行能力与产品贡献分别声明在哪里。
3. [host/app.ts](../../../../plugins/extensions/swarm-workflow/host/app.ts)、[host/resources.ts](../../../../plugins/extensions/swarm-workflow/host/resources.ts)：看配置投影、原生事件校验、来源映射和关闭后的精确清理。
4. [Browser 注册](../../../../plugins/extensions/swarm-workflow/app/browser/index.tsx)、[发现 hook](../../../../plugins/extensions/swarm-workflow/app/browser/useSwarmWorkflowDiscovery.ts)：看先订阅再读取、revision、在途刷新和摘要发现。
5. [图形面板](../../../../plugins/extensions/swarm-workflow/app/browser/SwarmWorkflowPanel.tsx)及同领域状态/测试：看 UI 如何消费插件数据，原生历史如何通过公共视图展示。
6. [执行来源映射](../../../../plugins/extensions/swarm-workflow/host/executionSession.ts)、[产品来源解析](../../../../plugins/extensions/swarm-workflow/host/sourceSession.ts)和[原生只读查询](../../../../plugins/extensions/swarm-workflow/service/execution-session.ts)：看来源 key、真实会话身份、service 代次和等待前后校验。

适合学习：原生执行与 Main 协调分离、元数据事件避免复制历史、图形和批次界面留在插件、删除/换包预检。

## Runtime Services：只复用真正通用的能力

先阅读[宿主架构的所有权说明](../app-plugin-runtime.md)，再按实际依赖看：

- [公共 SDK 说明](../../../../plugins/extensions/runtime-services/sdk/README.md)与[包 exports](../../../../plugins/extensions/runtime-services/sdk/package.json)：先确认哪些是可消费的公开合同、哪些仅用于 Native。
- [sdk/app-input.ts](../../../../plugins/extensions/runtime-services/sdk/app-input.ts)：结构化输入的纯合同与验证；正文中的标记和解码身份不能自行授权执行。
- [sdk/native-client.ts](../../../../plugins/extensions/runtime-services/sdk/native-client.ts)、[sdk/admission.ts](../../../../plugins/extensions/runtime-services/sdk/admission.ts)和[sdk/execution.ts](../../../../plugins/extensions/runtime-services/sdk/execution.ts)：握手、通用执行准入、精确原生执行与结算能力。
- [sdk/custody.ts](../../../../plugins/extensions/runtime-services/sdk/custody.ts)、[sdk/filesystem.ts](../../../../plugins/extensions/runtime-services/sdk/filesystem.ts)和[sdk/fifo-permits.ts](../../../../plugins/extensions/runtime-services/sdk/fifo-permits.ts)：不带业务语义的托管、文件准入和 FIFO。Node-only 入口不能进入 Browser 图。

不要把 Team / Workflow 的界面、配置参数、业务历史、DAG 或讨论状态移到 Runtime Services。它必须能在可选插件不存在或关闭时独立维护通用保护，也不能反向 import 它们。

在独立仓库定制 Team / Workflow 时保留插件自身源码目录结构，显式安装 `package.json` 声明的 App SDK、Runtime Services SDK、构建工具和 npm 依赖。通过公开包 exports 复用能力，不复制 Runtime Services 或宿主私有源码，也不依赖兄弟插件目录。编译成功不能证明目标 Gateway 已提供和授权所需运行能力。

## 需要理解宿主时再读

| 问题                                   | 说明与实现                                                                                                                         |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| 插件如何发现、审核、保留和准入         | [宿主架构](../app-plugin-runtime.md)、[Main manager](../../../../src/main/plugins/app/manager.ts)                           |
| scope、同步 hook、epoch 和清理如何检查 | [Main registry](../../../../src/main/plugins/app/registry.ts)及同目录测试                                                                |
| 文件 hash、链接和依赖图如何验证        | [artifact](../../../../src/main/plugins/app/artifact.ts)、[moduleGraph](../../../../src/main/plugins/app/moduleGraph.ts)                       |
| 同源资源和 UI 生命周期如何撤回         | [Browser registry](../../../../src/renderer/features/plugins/app/browserRegistry.ts)及测试                                               |
| 如何构建独立包与 SDK                   | [build-app-plugins.mjs](../../../../scripts/plugins/build-app-plugins.mjs)、[build-app-sdk.mjs](../../../../scripts/plugins/build-app-sdk.mjs) |
| 公共构建 CLI 和安装依赖如何工作        | [构建工具作者说明](../../../../plugins/sdk/app-plugin-build/README.md)、[CLI](../../../../plugins/sdk/app-plugin-build/cli.mjs)                |
| 独立发射 SDK 能证明什么                | [portable SDK probe](../../../../scripts/test/plugin-host/verify-portable-app-sdk.mjs)                                                   |
| 只改插件能否替换 Main/UI               | [plugin-only rewrite probe](../../../../scripts/test/plugin-host/verify-plugin-only-rewrite.mjs)                                         |

阅读宿主是为了理解公共约定和排障；普通业务开发不应从这里复制私有实现或新增专用分支。

## 系统背景和未完成项

| 主题                         | 推荐阅读                                                                                                                                                                                                                           |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 产品/Main 与 OpenClaw 的职责 | [系统架构](../../../architecture/02-architecture.md)、[进程模型](../../../architecture/03-process-model.md)                                                                                                                                    |
| 运行终态、身份和权限         | [执行引擎](../../../architecture/05-agent-engine.md)、[权限管理](../../../features/execution/openclaw-permission-management.md)                                                                                                                     |
| 原生安装、本地导入与管理 UI  | [插件系统](../../../architecture/07-plugin-system.md)、[Plugin Hub](../../../features/plugins/plugin-hub.md)                                                                                                                        |
| 产品元数据、原生历史和删除   | [数据存储](../../../architecture/10-data-storage.md)、[聊天渲染](../../../architecture/15-chat-rendering.md)                                                                                                                                   |
| 环境、日志和原生依赖         | [开发与排障](../../../development.md)、[脚本索引](../../../../scripts/README.md)                                                                                                                                                               |
| SDK 尚未解决或尚未验收的范围 | [宿主验证边界](../app-plugin-runtime.md#验证入口与限制)、[Team](../../extensions/agent-team/guide.md)、[Workflow](../../extensions/swarm-workflow/workflows.md)、[多 Agent 工具边界](../../../features/execution/multi-agent-tools.md) |

阅读测试时注意它使用真实代码、内存数据库、fixture Gateway 还是实际 Gateway。测试文件存在不代表本次已运行；fixture 通过也不代表真实模型质量或正式安装包生命周期已经通过。
