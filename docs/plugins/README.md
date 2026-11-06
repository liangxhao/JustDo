# 插件文档

按插件类型归类，具体插件在分类内按名称建立目录。各层 README 提供导航，概览、使用流程、集成、存储和验证说明按需分篇。

| 分类                                              | 内容                                                |
| ------------------------------------------------- | --------------------------------------------------- |
| [extensions/](extensions/README.md)               | Agent Team、Swarm Workflow、Draw.io、语音等原生扩展 |
| [chrome-extensions/](chrome-extensions/README.md) | Chrome Assistant 的侧栏、网页 SDK 与通信协议        |
| [skills/](skills/README.md)                       | 内置技能来源与维护                                  |
| [mcp-servers/](mcp-servers/README.md)             | MCP Apps 通用接入与内容引用约定                     |
| [sdk/](sdk/README.md)                             | 公共 SDK、构建工具、开发与发布                      |
| [management/](management/README.md)               | 插件安装、配置事务、加载与生命周期、插件中心        |
| [marketplace/](marketplace/README.md)             | 市场适配、安装身份与开发接入                        |

## 维护约定

- 详细文档统一在本目录。源码与资源保留在仓库根目录的 plugins/，其中的 README 为随包分发的简要说明，只引用包内路径。
- 扩展文档对应 plugins/extensions/<插件名>/，Chrome 扩展文档对应 plugins/chrome-extensions/<扩展名>/；Workboard 和 Computer 的实际来源见各自说明。
- 文档中的源码、脚本和测试路径若未另行注明，以对应源码目录为基准；文档链接相对当前文档解析。
- 插件迁到独立仓库时，同时迁移这里对应的文档并调整引用。平台、构建及真实环境验收限制随对应文档维护。
