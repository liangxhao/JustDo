# Chrome Native Messaging 实例发现协议

此发现协议只服务于 Chrome 扩展入口，不用于通用 Bearer WebSocket 或 CLI stdio。
通用客户端使用[独立连接配置](../external-clients.md#连接)。

Native Host 只负责发现已经运行的桌面 app-server，不启动或重启应用，也不承载对话内容。Chrome 扩展通过
`chrome.runtime.connectNative('com.justdo.browserextension')` 建立长连接。

## 注册

打包后的 JustDo 首次成功启动时，在 Windows 当前用户范围写入：

```text
HKCU\Software\Google\Chrome\NativeMessagingHosts\com.justdo.browserextension
```

默认值指向 `<userData>/browser-extension/com.justdo.browserextension.json`。Manifest：

```json
{
  "allowed_origins": ["chrome-extension://jboajogplelmaahjbomgflnfngpolgcb/"],
  "description": "JustDo browser native messaging host",
  "name": "com.justdo.browserextension",
  "path": "<absolute native host helper path>",
  "type": "stdio"
}
```

`npm run electron:dev` 会在选择 Vite 端口后编译独立 Native Host helper、生成相同 manifest
并写入注册表，因此开发态和安装版走同一协议实现。开发态 manifest 指向
`build/browser-extension/native-host/justdo-browser-extension-dev-host-<source digest>.exe`；安装版指向
`resources/browser-extension/native-host/` 下的随包 helper。后启动的一方会更新当前用户注册，
所以从安装版切回开发版时应重新运行 `npm run electron:dev`。

manifest 同目录还有 `native-host.config.json`。Chrome 不读取此文件，由 helper 用注册表中的
manifest 路径定位它。开发态和安装版统一只记录 `allowAppLaunch: false` 和 rendezvous 路径，
不提供可执行文件或启动参数。helper 只能连接用户已经启动的应用；没有可用实例时返回
手动启动应用的错误。构建文件和 Vite 服务就绪也不会允许扩展抢先拉起 Electron。
helper 中没有启动子进程或删除发现文件的路径，即使旧配置还带有启动目标或
`allowAppLaunch: true`，也不能由扩展启动或重启应用。

组装后的扩展明确声明仅 `http://127.0.0.1/*` 的必需本机 host 权限，用于独立于网页
正文授权的 app-server／relay 连接；页面上下文的 HTTP(S) 权限仍为可选并需用户授权。
不能依赖开发 Chrome 已经保存的广域网页权限，使新安装的扩展缺少本机访问声明。
该权限不替代固定 Origin 和 capability 校验，也不开放任意 Gateway 方法。

开发 helper 文件名包含其 C# 源码摘要。相同摘要的有效 PE 文件会直接复用，避免 Chrome 正在
运行 helper 时 Windows 文件锁导致编译器无法覆盖；源码变化后会自然生成新的文件名。

## 进程入口

Chrome 启动 Native Host 时会把扩展 Origin 作为命令行参数传给独立 helper。Helper 仅在
Origin 精确等于以下值时接受连接：

```text
chrome-extension://jboajogplelmaahjbomgflnfngpolgcb/
```

Helper 自己读写 Native Messaging framing，不经过 Electron GUI 进程，避免 Windows Electron
关闭或污染标准输入输出。两种版本均只读取已运行实例的发现信息。开发态 Main 和 Gateway
由开发命令启动，输出继续属于开发终端；安装版由用户手动启动，日志写入应用日志目录。

## 消息 framing

每条消息由以下两部分组成：

1. 4 字节无符号小端整数，表示 JSON body 的字节数。
2. UTF-8 编码的 JSON body。

单条消息最大 `1 MiB`。超过上限会终止 Host。请求、响应均使用标准 JSON-RPC 2.0 标头：

```json
{
  "jsonrpc": "2.0",
  "id": "justdo-native:1",
  "method": "codexRuntime/hello",
  "params": {}
}
```

## `codexRuntime/hello`

完成版本协商，不启动新的 app-server。

请求：

```json
{
  "jsonrpc": "2.0",
  "id": "justdo-native:1",
  "method": "codexRuntime/hello",
  "params": {
    "constraints": {
      "manifestSchemaVersion": 2,
      "nativeHostName": "com.justdo.browserextension",
      "requiredAppServerProtocolVersion": 2,
      "requiredNativeHostProtocolVersion": 2
    }
  }
}
```

当前 Host 将 `constraints` 视为客户端声明，由扩展根据响应执行兼容性判断。

响应：

```json
{
  "jsonrpc": "2.0",
  "id": "justdo-native:1",
  "result": {
    "manifestSchemaVersion": 2,
    "nativeHostProtocolVersion": 2,
    "supportedProtocolVersions": [2]
  }
}
```

## `codexRuntime/ensure`

返回可用 app-server 地址。如果 rendezvous 指向仍存活的进程则复用；否则立即返回手动启动
应用的错误。扩展后续重试会重新发现实例，不能将连接失败升级为启动或重启请求。
该错误携带 `error.data.code: APP_NOT_RUNNING`；扩展自动配对传输将其映射为原生
`pairing_unavailable`，使 watchdog 保持可重试，用户稍后手动启动应用后可继续自动配对。
真正的 Native Host 缺失、版本不兼容和其他错误继续由原生控制器按各自策略处理。

请求：

```json
{
  "jsonrpc": "2.0",
  "id": "justdo-native:2",
  "method": "codexRuntime/ensure",
  "params": {
    "clientId": "sidepanel-window-42",
    "constraints": {
      "manifestSchemaVersion": 2,
      "nativeHostName": "com.justdo.browserextension",
      "requiredAppServerProtocolVersion": 2,
      "requiredNativeHostProtocolVersion": 2
    }
  }
}
```

`clientId` 用于标识发起请求的浏览器窗口；当前 Host 不据此建立独立 server。

响应：

```json
{
  "jsonrpc": "2.0",
  "id": "justdo-native:2",
  "result": {
    "localAppServerUrl": "ws://127.0.0.1:43128/app-server?token=<64 hex chars>",
    "runtimeConfig": {
      "protocolVersion": 2
    }
  }
}
```

端口是动态值，客户端不得缓存。Token 是当前桌面进程生成的 256-bit capability，进程重启后失效。

## `codexRuntime/restart`

此方法在开发态和安装版均返回 `-32603`，提示用户手动重启应用，不删除已有 rendezvous，
也不启动第二个实例。扩展正常连接与重连只发送 `ensure`。旧客户端仍可能发送以下请求，
Host 会明确拒绝而非假装重启成功：

```json
{
  "jsonrpc": "2.0",
  "id": "justdo-native:3",
  "method": "codexRuntime/restart",
  "params": {
    "clientId": "sidepanel-window-42",
    "reason": "sidepanel_retry",
    "constraints": {}
  }
}
```

Main 对旧的 `--justdo-browser-extension-restart-app-server` 第二实例参数只记录拒绝提示，
不会停止或重新监听 app-server。

## rendezvous 文件

桌面进程把当前 capability 原子写入：

```text
<userData>/browser-extension/app-server.json
```

格式：

```json
{
  "localAppServerUrl": "ws://127.0.0.1:43128/app-server?token=<64 hex chars>",
  "pid": 12345,
  "protocolVersion": 2
}
```

Host 只接受 `ws:`、`127.0.0.1`、`/app-server`、64 位十六进制 token，并确认 `pid` 仍存活。
应用正常退出时仅删除属于当前 PID 的 rendezvous，避免旧实例删除新实例发布的地址。

## Native Host 错误

| code     | 场景                                 |
| -------- | ------------------------------------ |
| `-32700` | JSON body 无法解析                   |
| `-32600` | 缺少 `jsonrpc: "2.0"` 或合法方法名   |
| `-32601` | 方法不存在                           |
| `-32603` | 实例未运行、重启被拒绝或其他内部错误 |

错误响应：

```json
{
  "jsonrpc": "2.0",
  "id": "justdo-native:2",
  "error": {
    "code": -32603,
    "message": "The desktop app is not running. Start it manually, then reconnect the extension.",
    "data": { "code": "APP_NOT_RUNNING" }
  }
}
```

Chrome 报 `Specified native messaging host not found` 表示尚未注册 manifest、manifest 路径失效，
或扩展 ID 与 `allowed_origins` 不一致；该错误发生在 WebSocket 对话连接之前。开发态重新运行
`npm run electron:dev`，安装态重新启动一次已安装应用，即会刷新注册。
