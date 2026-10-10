# 工程文档

本目录面向产品维护、开发与排障。当前版本以 `package.json` 和锁文件为准；现行能力以架构、功能说明和实际注册代码为准。计划、调研与历史测试结果不能直接作为当前产品承诺。

## 从哪里开始

1. [产品与系统总览](architecture/01-overview.md)：产品能力、任务生命周期与数据权威。
2. [开发与排障](development.md)：环境、启动、运行时重建、验证与日志。
3. [功能文档索引](features/README.md)：按领域查找现行入口、实现与限制。
4. [系统架构](architecture/02-architecture.md)与[进程模型](architecture/03-process-model.md)：模块、IPC 与资源生命周期。

## 目录与阅读顺序

| 目录                                                      | 内容                                             | 使用方式                         |
| --------------------------------------------------------- | ------------------------------------------------ | -------------------------------- |
| [architecture/](#架构专题)                                | 持续维护的所有权、状态、数据与进程契约           | 修改架构和判断实现边界时阅读     |
| [features/](features/README.md)                           | 按领域组织的现行功能说明                         | 查用户路径、实现契约和已知限制   |
| [developer-integration/](developer-integration/README.md) | 登录、外部 Agent、请求头等开发接入接口及分发示例 | 增加集成模块时阅读               |
| [browser-extension-api/](browser-extension-api/README.md) | Native Messaging 与 app-server 协议规范          | 浏览器扩展客户端对接时阅读       |
| [plans/](plans/README.md)                                 | 剩余候选设计与未完成验收                         | 先核对现行能力，再推进真实差异   |
| [openclaw-upgrades/](openclaw-upgrades/README.md)         | 按目标版本组织的升级记录                         | 从版本索引查差异、复核与验收演进 |
| [releases/](releases/README.md)                           | 已发布应用版本说明                               | 保留发布时事实，不按当前源码改写 |
| `assets/`                                                 | 文档引用的资源                                   | 不存放方案或独立功能说明         |

开发操作指南直接放在本目录根部，便于查找：[开发与排障](development.md)、[运行时补丁](openclaw-runtime-patches.md)、[Windows 安装器](windows-installer.md)及[离线下载](offline-downloads.md)。全部离线资源的下载地址、文件名、目的路径与准备命令统一维护在离线下载指南。

## 架构专题

| 文档                                                                   | 主要问题                                     |
| ---------------------------------------------------------------------- | -------------------------------------------- |
| [系统架构](architecture/02-architecture.md)                            | 产品宿主、执行运行时与组合根                 |
| [进程模型](architecture/03-process-model.md)                           | IPC、连接、请求与窗口生命周期                |
| [Cowork](architecture/04-cowork-system.md)                             | 会话、发送、停止、目标与交互                 |
| [Agent Engine](architecture/05-agent-engine.md)                        | 配置准入、Gateway、子任务与恢复              |
| [插件系统](architecture/07-plugin-system.md)                           | Skill、MCP、Hook、Extension 的管理与执行边界 |
| [定时任务](architecture/08-scheduled-tasks.md)                         | 原生 cron、结果收件箱与删除补偿              |
| [数据存储](architecture/10-data-storage.md)                            | 产品 schema、原生历史、保留与恢复            |
| [安全模型](architecture/11-security-model.md)                          | IPC、文件、网络、凭据与剩余风险              |
| [工程构建与发布](architecture/12-tech-stack.md)                        | 依赖、平台资源、ABI 与打包链路               |
| [薄前端设计](architecture/13-pure-frontend-design.md)                  | 显示投影与执行事实的区别                     |
| [所有权判定](architecture/14-openclaw-frontend-boundary.md)            | 新能力应该落在哪一层                         |
| [聊天渲染](architecture/15-chat-rendering.md)                          | 历史、实时流、工具、媒体与工作区显示         |
| [市场适配](architecture/16-skill-marketplace-adapter.md)               | Provider contract 与安装事务                 |
| [Windows 原生沙盒](architecture/17-windows-native-sandbox.md)          | 工具进程隔离与平台限制                       |
| [Gateway 能力矩阵](architecture/openclaw-gateway-capability-matrix.md) | 原生能力、产品消费与升级核对                 |

编号 06 和 09 没有对应主题，不创建占位文档补齐编号。逐补丁能力、上游处置和移除条件只维护在[当前版本补丁总账](../scripts/patches/v2026.9.8/README.md)。

## 维护规则

- 每个主题明确现行说明的维护入口。用户行为放在功能说明，跨进程契约放在架构，开发调用步骤放在接入指南；用链接连接不同层次，不重复维护整份规格。
- `plans/` 只保留尚待推进的设计和未完成验收。实现后将现行规则与必要限制归入 `features/` 或 `architecture/`，删除完成或被替代的方案。
- 不保留重复的旧版调研、阶段审查和测试流水；历史由 Git 追溯。升级与发布记录按目标版本维护，不能将旧环境测试改写成当前版本已通过。
- 事实核对顺序为 shared 合约 → 注册入口 → service/store/adapter → preload/Renderer 消费方 → 测试。文件存在不等于接入，测试文件存在不等于本次执行通过。
- 保留所有权、正常调用链、身份约束、失败恢复和必要 Mermaid 图，不用文件路径列表代替设计。
- 移动或合并文档时更新仓库内相对链接、`AGENTS.md`、中英文 README 与其他引用。不要保留一套重复的旧路径占位说明。
- 文档修改运行 `git diff --check`、改动 Markdown 的 Prettier 检查及本地链接检查。文档整理不启动用户 Gateway、不改配置、不重建原生 ABI。
