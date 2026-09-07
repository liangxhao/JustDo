# 浏览器设置与 OpenClaw v2026.9.2 边界

本文描述 JustDo 浏览器设置对 OpenClaw v2026.9.2 Browser plugin 的产品映射、诊断边界和扩展分发方式。浏览器执行、profile driver、relay 协议与 tab 授权由 OpenClaw 持有；JustDo 只持有模式选择、设置引导和 IPC 安全边界。

## 1. 产品模式

三个产品模式保存在 `app_config.browserMode`，并映射到 OpenClaw 的三个官方 profile：

| UI 模式    | app_config  | defaultProfile | driver             | 用途                                |
| ---------- | ----------- | -------------- | ------------------ | ----------------------------------- |
| 隔离浏览器 | `isolated`  | `openclaw`     | `openclaw`         | OpenClaw 管理的独立浏览器资料       |
| 用户浏览器 | `user`      | `user`         | `existing-session` | Chrome DevTools MCP 连接日常 Chrome |
| 浏览器扩展 | `extension` | `chrome`       | `extension`        | OpenClaw 扩展连接已登录 Chrome      |

`normalizeBrowserMode` 对未知持久化值回退 `isolated`；IPC 写入仍严格拒绝未知值。切换通过 app config 与 OpenClaw config 的事务完成，同步失败时恢复原模式。

OpenClaw v2026.9.2 会补齐缺失的 `openclaw`、`user` 和 `chrome` 内置 profile。JustDo 仍显式写入所选外部浏览器 profile，以固定产品语义：

```json5
// user
{ browser: { defaultProfile: "user", profiles: { user: {
  driver: "existing-session", attachOnly: true
} } } }

// extension
{ browser: { defaultProfile: "chrome", profiles: { chrome: {
  driver: "extension"
} } } }
```

## 2. 配置应用

OpenClaw Browser plugin 将 `browser.profiles` 与 `browser.defaultProfile` 声明为 hot reload。模式切换正常走 Gateway 原生配置重载，不依赖进程环境变量，也不要求为了浏览器切换预热或重启 Gateway。

JustDo 仍在运行中会话存在时阻止切换。这是产品级一致性策略：避免同一个任务的省略 profile 调用在执行途中改变路由，不表示 OpenClaw 缺少热更新能力。

当前 JustDo 将根 `browser` block 视为应用管理配置。若以后开放自定义 browser profiles，必须改为字段级 merge 并明确保留 `snapshotDefaults`、`tabCleanup`、`extensionRelay`、自定义 profiles 等用户字段。

## 3. 用户浏览器

`user` 使用 OpenClaw 的 `existing-session` driver。Gateway 通过 Chrome DevTools MCP `--autoConnect` 连接本机 Chrome；用户首次连接需要在 Chrome 中批准 Remote Debugging。

设置页读取 Preferences、`DevToolsActivePort` 和端口 owner，仅用于安装与启动引导。这些本机迹象不是连接成功的权威证据。真正的连接测试通过：

```text
browser.request
  method: GET
  path: /tabs
  query.profile: user
  timeoutMs: 45000
```

只有响应严格包含 `running: true` 才表示 Chrome MCP 页面通道可用。`{running:false,tabs:[]}` 是正常的未连接结果，不能显示“已连接”。请求超时归类为授权超时；Gateway 未连接和其他运行错误分别报告。

OpenClaw 还提供 profile-aware 的 `/` 和 `/doctor` Browser routes，后续若扩充诊断 UI，应直接投影其 `driver`、`transport`、`running`、`cdpReady`、`pageReady` 与 doctor checks，不在 JustDo 重建同一套 runtime 状态机。

## 4. 浏览器扩展

JustDo 不维护独立的 Chrome relay 实现。`resources/browser-extension/chrome-extension` 是锁定 OpenClaw runtime 所带扩展的未修改快照，当前 manifest 版本为 `2.2.0`。构建脚本只复制并验证以下契约：

- manifest 保持 OpenClaw identity；
- `openclaw-extension-relay.v2` 认证存在；
- v2 challenge/response 模块、Options 页面和完整权限存在；
- 16/32/48/128 图标尺寸正确。

更新 OpenClaw 时必须从同一锁定 runtime 更新整个目录，不能只复制 `background.js` 或继续兼容旧 JustDo extension。扩展代码、Gateway relay 和认证协议必须保持同版本。

### 配对

Windows 仍使用 OpenClaw 支持的高级手动配对。Main 调用锁定 runtime 的 `browser extension pair --json`，由 OpenClaw 负责 relay key 的安全创建、权限校验和并发复用；JustDo 只将返回的 pairing string 写入剪贴板。典型格式为：

```text
ws://127.0.0.1:<relay-port>/extension?gateway=ws%3A%2F%2F127.0.0.1%3A<gateway-port>#<relay-key>
```

默认 relay port 为 Gateway port + 10；显式 `browser.profiles.chrome.cdpPort` 优先。完整字符串属于密码，只进入系统剪贴板，不返回 Renderer、不写日志。

新版扩展在 Settings → Advanced manual pairing 接收该字符串，并使用 Browser Relay Authentication v2 完成连接绑定的挑战认证。JustDo 显式设置 `browser.extensionRelay.allowLegacyAuth=false`，不再开放 Basic/Bearer 和旧 token-subprotocol 通道。

Browser service 由第一次 `browser.request` 或 OpenClaw 的 Gateway extension route 按需唤醒。旧的 `OPENCLAW_EAGER_BROWSER_CONTROL_SERVER` 环境变量不存在于 v2026.9.2，不得重新引入。

### Tab 授权

新版扩展有两种 access mode：

- `Selected tabs`：高级手动配对的默认值，只允许 OpenClaw tab group 中的网页；
- `All tabs`：用户主动选择后，允许所有符合条件的普通网页。

设置文案必须明确默认值，不能继续声称扩展始终只共享 tab group。暂停、移组、断开、导航和 debugger attachment 的撤销与竞态处理由上游扩展实现。

### 连接测试

扩展测试调用相同的 `/tabs` route，profile 为 `chrome`。只有 `running: true` 才成功；共享 tab 可以为空。失败诊断来自 Gateway Browser plugin，不通过读取 relay key 后发送 legacy HTTP 认证来猜测端口 owner。

## 5. 安全边界

- Renderer 不接收 Gateway token、relay key、CDP credential、页面内容或本机配置路径。
- Pairing string 只写剪贴板；日志仅记录非秘密 relay port 或动作结果。
- 浏览器 extension 资源必须与锁定 OpenClaw 版本整体同步。
- `dangerouslyAllowPrivateNetwork` 表示允许浏览器访问私网，不表示禁止互联网；UI 不得把 profile 隔离描述成网络隔离。
- 本机端口探测只能辅助引导，不能替代 Gateway 的 `running`/`pageReady` 结果。
- 切换模式时 app config 与 OpenClaw config 必须一起成功或一起回滚。

## 6. 验收

自动测试至少覆盖：

- 三种模式生成 v2026.9.2 接受的 profile driver；
- `user` 与 `chrome` 的 `/tabs` 返回 `running:false` 时不误报成功；
- Gateway 缺失、授权超时和一般连接错误的稳定分类；
- v2 扩展 manifest、关键模块、图标和重复 prepare；
- pairing key 创建/复用且不经 IPC 返回；
- 模式同步失败与活动会话竞态回滚；
- 构建和安装包包含完整的官方扩展目录。

手工 smoke 需要分别验证隔离浏览器启动、Chrome MCP 首次授权、扩展手动配对、All tabs/Selected tabs、移除授权、Gateway 重启后重连，以及 Windows 打包资源路径。
