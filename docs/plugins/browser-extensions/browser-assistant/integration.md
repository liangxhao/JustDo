# 浏览器扩展的宿主集成

扩展客户端、侧栏、网页 SDK、私有协议与用户流程由
[Browser Assistant 包](overview.md)维护。
这些文档随客户端源码分发；本页只记录应用提供的接入边界。

Main 的浏览器领域提供 Native Messaging 注册和实例发现、独立 loopback WebSocket、
来源校验、产品会话准备、审批 owner、原生历史读取与执行回执核对。
相关入口为 `src/main/browser/extension/`；Native Host 的应用侧构建入口为
`scripts/browser/browser-extension-native-host.cs`。
共享标准协议和传输由 `src/main/appServer/` 提供，不反向依赖浏览器业务。

客户端更新必须与宿主协议版本匹配。具体帧、版本、字段、方法与能力限制仅在
[包内宿主契约](protocol-contract.md)
及其协议文档定义，不在应用文档复制。

应用负责保护产品来源、原生 SID／revision／run 与连接代次，拒绝跨来源访问及过期交互。
侧栏断线只撤回观察，不取消已接纳工作；通用外部连接的执行所有权另按其入口处理。
关闭界面、停止 ACK、idle 与正文结束不能结算执行，未知提交不得自动重放。

正式发布需以匹配客户端、真实 Native Host、已打包应用、原生授权与模型完成集成验收。
客户端单测或隔离 HTTP/WebSocket 夹具不替代宿主及完整链路验证。
