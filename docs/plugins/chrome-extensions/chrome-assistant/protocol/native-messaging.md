# Chrome Native Messaging 实例发现协议

Native Host 为 Chrome 扩展发现兼容的已运行桌面 app-server。通用 Bearer WebSocket 和 CLI stdio 各自建立连接。
桌面应用由用户或 Main 自有生命周期启动和重启。发现后的对话与自动配对直接走 app-server WebSocket。

1. 扩展用 `chrome.runtime.connectNative('app.chrome_extension')` 按需启动 helper，每次发现建立独立连接。
2. 扩展在同一连接完成 `hello`、`ensure`。并发发现各自管理连接、请求和超时。
3. 成功或失败后扩展主动断开，helper 在 stdin EOF 后退出。重连时重新启动 helper。

## 注册

打包后的 JustDo 首次成功启动时写入 Windows 当前用户注册表键。

```text
HKCU\Software\Google\Chrome\NativeMessagingHosts\app.chrome_extension
```

注册表默认值指向 `<userData>/chrome-extension/app.chrome_extension.json`。该 manifest 的格式如下。

```json
{
  "allowed_origins": ["chrome-extension://jboajogplelmaahjbomgflnfngpolgcb/"],
  "description": "Browser native messaging host",
  "name": "app.chrome_extension",
  "path": "<absolute native host helper path>",
  "type": "stdio"
}
```

### 开发版与安装版

宿主开发启动流程选择 Vite 端口后编译独立 helper，生成同格式 manifest 并更新注册表。两个版本使用同一协议实现。

| 环境   | manifest 的 `path`                                                                                  |
| ------ | --------------------------------------------------------------------------------------------------- |
| 开发版 | `build/chrome-extension/native-host/<source digest>/<productName>-chrome-extension-native-host.exe` |
| 安装版 | `resources/chrome-extension/native-host/<productName>-chrome-extension-native-host.exe`             |

文件名使用 `package.json.productName`，不含协议或应用版本号。后启动的版本会更新当前用户注册。从安装版切回开发版时，重新运行宿主开发启动流程。

开发 helper 目录包含 C# 源码摘要。相同摘要的有效 PE 文件直接复用，避免 Chrome 运行 helper 时 Windows 文件锁阻止覆盖。源码变化生成新目录，文件名保持稳定。

### Helper 配置与 Chrome 权限

- **Helper 配置。** Helper 根据注册表中的 manifest 路径定位同目录的 `native-host.config.json`，Chrome 不读取该配置。
  开发版和安装版均只记录 `allowAppLaunch: false` 和 rendezvous 路径。Helper 没有启动子进程或删除发现文件的路径。
  旧配置中的启动目标、启动参数或 `allowAppLaunch: true` 不授予启动权限，构建文件和 Vite 就绪也不会让扩展启动 Electron。
  没有可用实例时提示用户手动启动应用。
- **Chrome 权限。** 组装产物的必需本机 host 权限仅为 `http://127.0.0.1/*`，用于 app-server／relay。
  页面上下文的 HTTP(S) 权限由用户另行授予。安装包须自带本机访问声明，开发 Chrome 中已有的广域网页权限不能代替该声明。
  连接仍校验固定 Origin 和 capability，Gateway 方法各自授权。

## 进程入口

Chrome 启动 Native Host 时将扩展 Origin 作为命令行参数传给独立 helper。Helper 只接受下列精确值。

```text
chrome-extension://jboajogplelmaahjbomgflnfngpolgcb/
```

Helper 自己读写 Native Messaging framing，不经过 Electron GUI 进程，避免 Windows Electron
关闭或污染标准输入输出。两种版本均只读取已运行实例的发现信息。开发态 Main 和 Gateway
由开发命令启动，输出继续属于开发终端；安装版由用户手动启动，日志写入应用日志目录。

## 消息 framing

每条消息按以下顺序编码。

1. 4 字节无符号小端整数，表示 JSON body 的字节数。
2. UTF-8 编码的 JSON body。

单条消息最大 `1 MiB`，超限时 Host 终止。请求与响应均使用标准 JSON-RPC 2.0 标头。

```json
{
  "jsonrpc": "2.0",
  "id": "justdo-native:1",
  "method": "codexRuntime/hello",
  "params": {}
}
```

## `codexRuntime/hello`

`hello` 仅用于版本协商。Host 将 `constraints` 视为客户端声明，扩展根据响应判断兼容性。

**请求**

```json
{
  "jsonrpc": "2.0",
  "id": "justdo-native:1",
  "method": "codexRuntime/hello",
  "params": {
    "constraints": {
      "manifestSchemaVersion": 2,
      "nativeHostName": "app.chrome_extension",
      "requiredAppServerProtocolVersion": 4,
      "requiredNativeHostProtocolVersion": 2
    }
  }
}
```

**响应**

```json
{
  "jsonrpc": "2.0",
  "id": "justdo-native:1",
  "result": {
    "manifestSchemaVersion": 2,
    "nativeHostProtocolVersion": 2,
    "supportedProtocolVersions": [4]
  }
}
```

## `codexRuntime/ensure`

`ensure` 返回 rendezvous 指向的存活进程地址，否则立即返回 `error.data.code: APP_NOT_RUNNING` 并提示用户手动启动应用。
扩展重试时只重新发现实例。

自动配对传输将 `APP_NOT_RUNNING` 映射为原生 `pairing_unavailable`，使 watchdog 保持可重试。用户手动启动应用后可继续自动配对。
Native Host 缺失、版本不兼容和其他错误由原生控制器按各自策略处理。

**请求**

```json
{
  "jsonrpc": "2.0",
  "id": "justdo-native:2",
  "method": "codexRuntime/ensure",
  "params": {
    "clientId": "sidepanel-window-42",
    "constraints": {
      "manifestSchemaVersion": 2,
      "nativeHostName": "app.chrome_extension",
      "requiredAppServerProtocolVersion": 4,
      "requiredNativeHostProtocolVersion": 2
    }
  }
}
```

`clientId` 用于标识发起请求的浏览器窗口；当前 Host 不据此建立独立 server。

**响应**

```json
{
  "jsonrpc": "2.0",
  "id": "justdo-native:2",
  "result": {
    "localAppServerUrl": "ws://127.0.0.1:43128/app-server?token=<64 hex chars>",
    "runtimeConfig": {
      "protocolVersion": 4
    }
  }
}
```

端口是动态值，客户端不得缓存。Token 是当前桌面进程生成的 256-bit capability，进程重启后失效。

## `codexRuntime/restart`

开发版和安装版均以 `-32603` 拒绝此方法，提示用户手动重启应用。已有 rendezvous 保留，Host 不启动第二个实例。
扩展正常连接与重连使用 `ensure` 发现实例。以下旧客户端请求会被明确拒绝。

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

Main 对旧的 `--chrome-extension-restart-app-server` 第二实例参数只记录拒绝提示，
不会停止或重新监听 app-server。

## rendezvous 文件

桌面进程将当前 capability 原子写入下列文件。

```text
<userData>/chrome-extension/app-server.json
```

**文件格式**

```json
{
  "localAppServerUrl": "ws://127.0.0.1:43128/app-server?token=<64 hex chars>",
  "pid": 12345,
  "protocolVersion": 4
}
```

Host 只接受 `ws:`、`127.0.0.1`、`/app-server` 和 64 个十六进制字符的 token，并确认 `pid` 仍存活。
应用正常退出时仅删除属于当前 PID 的 rendezvous，避免旧实例删除新实例发布的地址。

## Native Host 错误

| code     | 场景                                 |
| -------- | ------------------------------------ |
| `-32700` | JSON body 无法解析                   |
| `-32600` | 缺少 `jsonrpc: "2.0"` 或合法方法名   |
| `-32601` | 方法不存在                           |
| `-32603` | 实例未运行、重启被拒绝或其他内部错误 |

**错误响应**

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

Chrome 若在 WebSocket 对话连接前报告 `Specified native messaging host not found`，检查 manifest 注册、文件路径和 `allowed_origins` 中的扩展 ID。
开发态重新运行宿主开发启动流程，安装态重启一次已安装应用，即可刷新注册。
