# 浏览器扩展的宿主集成

本页供维护本仓库桌面宿主、扩展构建和安装包的开发者使用。安装和更新扩展见[概览](overview.md#安装或更新扩展)，业务网站接入见[网页 SDK](website-sdk.md)。

## 构建与发布

从仓库根目录运行 `npm run chrome-extension:prepare`。组装结果位于 `build/chrome-extension/chrome-extension/`。加载扩展时选择含 `manifest.json` 的这一层。发布方可从同一目录取得网页所用的单文件 `chrome-assistant.js`。

安装包把该目录复制到应用资源目录的 `chrome-extension/chrome-extension/` 下。桌面应用中的 **设置 → 浏览器 → Chrome 扩展 → 打开扩展文件夹** 打开它的上一级。Windows 上这一级的路径为 `<安装目录>/resources/chrome-extension/`，该目录下的 `native-host/` 存放 Native Host。Native Host 的开发态与安装态注册方式见[实例发现](protocol/native-messaging.md)。

组装以锁定的上游源码为基线，验证源码快照后叠加产品界面和协议客户端，写入应用显示名称与固定公钥。发布时使用协议匹配的桌面应用、Native Host 和扩展。版本协商及方法范围见[宿主接入要求](protocol-contract.md)和[兼容性](protocol/compatibility.md)。

## 源码入口

| 负责的部分                                        | 仓库路径                                                           |
| ------------------------------------------------- | ------------------------------------------------------------------ |
| 锁定的上游 relay 基线及声明                       | `plugins/chrome-extensions/chrome-assistant/openclaw/`             |
| 侧栏、设置、网页 SDK 和客户端模块                 | `plugins/chrome-extensions/chrome-assistant/conversation-overlay/` |
| 扩展组装、源码校验和浏览器 Markdown 构建          | `plugins/chrome-extensions/chrome-assistant/scripts/`              |
| 客户端测试                                        | `plugins/chrome-extensions/chrome-assistant/tests/`                |
| 网页 SDK 示例                                     | [网页示例目录](examples/website-sdk/)                              |
| Native Messaging 注册、实例发现和 Chrome 会话服务 | `src/main/chrome/`                                                 |
| Windows Native Host 源码                          | `scripts/chrome/chrome-extension-native-host.cs`                   |
| 通用 app-server 消息解析、路由和传输              | `src/main/clients/appServer/protocol/`                             |
| 安装包资源映射                                    | `electron-builder.json`                                            |

## 宿主职责

Main 为 Chrome 扩展提供独立的本机 WebSocket，校验扩展来源和连接身份，准备产品会话，确定审批归属，并核对原生历史与执行回执。通用 app-server 负责共享协议与传输，Chrome 专属能力由浏览器入口注册。帧、版本、方法和字段的定义集中在[协议参考](protocol/README.md)。

调试连接时，先确认 Chrome 加载的目录与当前桌面应用附带的扩展匹配，再按[实例发现](protocol/native-messaging.md)核对 Native Host 和已运行实例。侧栏断线后的观察恢复、未知提交和执行结算见[生命周期与错误](protocol/lifecycle-errors.md)。

正式发布需要在已打包应用中使用匹配的扩展身份、真实 Native Host、原生授权和实际模型完成集成验收。客户端单测和隔离夹具覆盖的范围见[兼容性与测试](protocol/compatibility.md)。
