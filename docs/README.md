# 工程文档

本目录面向产品维护、开发与排障。当前版本以 `package.json` 和锁文件为准；现行能力以架构、功能说明和实际注册代码为准。计划、调研与历史测试结果不能直接作为当前产品承诺。

## 从哪里开始

1. [产品与系统总览](architecture/01-overview.md)：产品能力、任务生命周期与数据权威。
2. [开发、打包与排障](development.md)：开发启动、平台打包命令、运行时重建、检查与日志。
3. [功能文档索引](features/README.md)：按领域查找现行入口、实现与限制。
4. [系统架构](architecture/02-architecture.md)与[进程模型](architecture/03-process-model.md)：模块、IPC 与资源生命周期。

## 目录与阅读顺序

| 目录                                                      | 内容                                             | 使用方式                         |
| --------------------------------------------------------- | ------------------------------------------------ | -------------------------------- |
| [architecture/](architecture/README.md)                   | 持续维护的所有权、状态、数据与进程契约           | 修改架构和判断实现边界时阅读     |
| [features/](features/README.md)                           | 按领域组织的现行功能说明                         | 查用户路径、实现契约和已知限制   |
| [developer-integration/](developer-integration/README.md) | 登录、外部 Agent、请求头等开发接入接口及分发示例 | 增加集成模块时阅读               |
| [app-server-api/](app-server-api/README.md)               | 通用 stdio、WebSocket 与 Chrome 扩展协议规范     | 外部客户端对接时阅读             |
| [plans/](plans/README.md)                                 | 具体未实施需求                                   | 先核对现行能力，再推进真实差异   |
| [openclaw-upgrades/](openclaw-upgrades/README.md)         | 按目标版本组织的升级记录                         | 从版本索引查差异、复核与验收演进 |
| [releases/](releases/README.md)                           | 已发布应用版本说明                               | 保留发布时事实，不按当前源码改写 |
| `assets/`                                                 | 文档引用的资源                                   | 不存放方案或独立功能说明         |

开发操作指南入口：[开发与排障](development.md)、[升级检查清单](upgrade-checklist/README.md)、[运行时补丁](openclaw-runtime-patches.md)、[Windows 安装器](windows-installer.md)及[离线下载](offline-downloads.md)。升级先按功能域核对原生契约与真实验收，不只检查补丁是否能应用。全部离线资源的下载地址、文件名、目的路径与准备命令统一维护在离线下载指南。

## 架构与功能的分工

[架构索引](architecture/README.md)按进程、执行、数据、安全、插件和呈现查找跨域契约；[功能索引](features/README.md)按用户任务查找现行流程和限制。这里不再复制两份专题目录。

判断一个需求是否已经实现，先读对应现行文档并核对注册与消费链路，再读[未实施需求](plans/README.md)。计划中的目标接口、候选架构和历史测量不能替代当前契约；已完成方案应将必要规则整合进现行文档后删除，历史由 Git 追溯。

## 维护规则

- 每个主题明确现行说明的维护入口。用户行为放在功能说明，跨进程契约放在架构，开发调用步骤放在接入指南；用链接连接不同层次，不重复维护整份规格。
- `plans/` 仅保留仍需记录的具体未实施需求；现行规则、已知问题和验证边界随 `features/` 或 `architecture/` 维护，不另建重复验收计划。
- 不保留重复的旧版调研、阶段审查和测试流水；历史由 Git 追溯。升级与发布记录按目标版本维护，不能将旧环境测试改写成当前版本已通过。
- 事实核对顺序为 shared 合约 → 注册入口 → service/store/adapter → preload/Renderer 消费方 → 测试。文件存在不等于接入，测试文件存在不等于本次执行通过。
- 保留所有权、正常调用链、身份约束、失败恢复和必要 Mermaid 图，不用文件路径列表代替设计。
- 移动或合并文档时更新仓库内相对链接、`AGENTS.md`、中英文 README 与其他引用。不要保留一套重复的旧路径占位说明。
- 文档修改运行 `git diff --check`、改动 Markdown 的 Prettier 检查及本地链接检查。文档整理不启动用户 Gateway、不改配置、不重建原生 ABI。
