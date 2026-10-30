# 插件 SDK

本目录维护插件公共 SDK、构建工具及开发发布说明。具体插件的业务规则仍在各自文档目录维护。

| 文档                                            | 内容                                                                          |
| ----------------------------------------------- | ----------------------------------------------------------------------------- |
| [应用插件开发指南](app-plugin-development/README.md) | 使用 App Plugin SDK 开发 Native / Main / Browser 插件的教程、示例和阅读路线 |
| [App Plugin SDK](app-plugin-sdk.md)             | Native、Main、Browser 与展示接口，托管数据、Python 运行时、生命周期和权限边界 |
| [应用插件运行机制](app-plugin-runtime.md)       | SDK 对应的宿主加载、代码信任、业务代次和资源清理                              |
| [构建工具](build-tools.md)                      | 独立类型检查、完整插件包、主题、测试端口与 SDK 产物生成                       |
| [Runtime Services SDK](runtime-services-sdk.md) | 通用准入、原生客户端、执行回执、清理及写租约                                  |
| [开发与发布](development-and-distribution.md)   | 仓库内准备 SDK、生成 npm 包及独立项目消费方式                                 |

## 源码与发行包

| npm 包                  | 源码与依赖元数据                                                                                         |
| ----------------------- | -------------------------------------------------------------------------------------------------------- |
| `@app-plugin/sdk`       | [plugins/sdk/app-plugin-sdk](../../../plugins/sdk/app-plugin-sdk/package.json)                           |
| `@app-plugin/build`     | [plugins/sdk/app-plugin-build](../../../plugins/sdk/app-plugin-build/package.json)                       |
| `@runtime-services/sdk` | [plugins/extensions/runtime-services/sdk](../../../plugins/extensions/runtime-services/sdk/package.json) |

Runtime Services SDK 由 Runtime Services 插件维护，是独立发行包。安装任一 SDK 不会安装、启动或授权运行服务；运行要求见[Runtime Services](../extensions/runtime-services/README.md)。应用侧加载、代码准入与资源管理见[插件运行机制](app-plugin-runtime.md)。

SDK 版本、公开 exports 和依赖范围以对应包元数据为准。随包 README 保留独立消费者所需的简要说明，仓库开发和发布操作统一在本目录维护。

[返回插件文档索引](../README.md)
