# 功能文档

本目录按产品功能领域维护当前用户流程、实现契约和验证限制。各领域 README 是阅读入口；同一功能只保留一份主定义，跨领域通过链接衔接。

## 按功能查找

| 目录                                            | 范围           |
| ----------------------------------------------- | -------------- |
| [app/](app/README.md)                           | 应用与启动     |
| [chat/](chat/README.md)                         | 对话输入与内容 |
| [execution/](execution/README.md)               | 执行控制与诊断 |
| [assistants/](assistants/README.md)             | 助手与角色     |
| [workspace/](workspace/README.md)               | 工作区与文件   |
| [browser/](browser/README.md)                   | 浏览器操作     |
| [models/](models/README.md)                     | 模型配置       |
| [speech/](speech/README.md)                     | 语音交互与资源 |
| [account/](account/README.md)                   | 账号与认证     |
| [network/](network/README.md)                   | 网络与请求策略 |
| [external-clients/](external-clients/README.md) | 外部客户端     |

## 常见问题

- 启动或历史恢复受阻：[启动分流](app/startup-and-history-upgrade.md#四类启动)、[初始化错误](app/startup-and-history-upgrade.md#初始化错误)。
- 运行参数、授权与自动续跑：[执行控制](execution/README.md)；停止或无回复时看[会话诊断](execution/session-diagnostics.md#用户操作)。
- 配置模型、使用语音或登录换证：分别看[模型配置](models/README.md)、[语音](speech/README.md)、[账号认证](account/README.md)。
- 插件安装或启停异常：[插件中心](../plugins/management/plugin-hub.md)；插件业务见[插件文档](../plugins/README.md)。

## 文档边界

- [架构](../architecture/README.md)维护进程、数据与执行权威；本目录维护产品行为及当前限制。
- [开发接入](../developer-integration/README.md)维护调用步骤与外部接入；[app-server API](../app-server-api/README.md)维护公共协议字段和示例。
- 插件业务、协议、schema、UI 和验证只在对应[插件目录](../plugins/README.md)维护，本目录通过链接引用。
- 语音资源发布指南保留在 speech，作为该能力的维护者入口，与用户使用说明分篇。
- 具体未实施需求见[计划](../plans/README.md)。历史测试或隔离探针不能替代真实模型、正式安装包和目标平台验收；已知限制保留在所属文档。
- 移动文档同步修复引用与章节深链，不留下重复旧路径副本。
