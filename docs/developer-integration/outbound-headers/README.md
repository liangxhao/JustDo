# 出站请求头配置与 Extension 接入指南

这是一份可以独立分发的使用说明。适用于以下两类人：

- 普通用户或运维人员：临时为指定服务器添加认证请求头；
- Extension 开发者：让用户安装并启用 Extension 后，自动获得所需的 URL 与请求头映射。

请求头的名称和作用范围可以由手工配置或 Extension 声明，但请求头的实际值始终从用户本机的
`user_info.json` 读取。Extension 不应包含真实 token、Cookie、密码或其他凭据。

## 1. 先选择使用方式

| 需求                                              | 推荐方式                                              |
| ------------------------------------------------- | ----------------------------------------------------- |
| 临时调试、个人环境、快速添加一个服务器            | 修改手工 `config.json`                                |
| 希望用户安装 Extension 后自动获得 URL/Header 映射 | 在 Extension 根目录放置 `outbound-header-policy.json` |
| 修改真实 Header 值                                | 修改本机 `user_info.json`                             |
| 临时关闭所有自动请求头                            | 把手工 `config.json` 的 `enabled` 改为 `false`        |

两种方式可以同时使用。应用按代码预定义规则、手工规则、所有“已安装且已启用”的 Extension
规则的顺序在内存中合并。预定义规则和 Extension 规则都不会写入手工 `config.json`。

## 2. 手工配置快速开始

### 2.1 文件位置

当前标准产品名为 `JustDo`。Windows 上的默认路径是：

```text
%APPDATA%\JustDo\outbound-header-proxy\config.json
%APPDATA%\JustDo\huawei\user_info.json
```

其他平台的对应位置是：

| 平台  | `config.json`                                                                                                                  | `user_info.json`                                                                                       |
| ----- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| macOS | `~/Library/Application Support/JustDo/outbound-header-proxy/config.json`                                                       | `~/Library/Application Support/JustDo/huawei/user_info.json`                                           |
| Linux | `$XDG_CONFIG_HOME/JustDo/outbound-header-proxy/config.json`；未设置时使用 `~/.config/JustDo/outbound-header-proxy/config.json` | `$XDG_CONFIG_HOME/JustDo/huawei/user_info.json`；未设置时使用 `~/.config/JustDo/huawei/user_info.json` |

如果使用的是更换过产品名的构建，请把路径中的 `JustDo` 替换为实际产品名。

### 2.2 配置步骤

1. 完全退出应用。
2. 复制 [`examples/manual/config.json`](examples/manual/config.json) 到上述 `config.json` 路径。
3. 按实际服务器地址修改 `baseUrlWhitelist`，按实际请求头名称修改 `headerNames`。
4. 复制 [`examples/manual/user_info.json`](examples/manual/user_info.json) 到上述
   `user_info.json` 路径，并把示例值替换为真实值。
5. 重新启动应用。
6. 通过服务器日志或对应功能的连接测试确认 Header 已收到。

请求头配置没有实时监听。手工修改后，完整退出并重新启动应用即可生效；其他刷新时机见第 7 节。

### 2.3 `config.json` 字段

```json
{
  "enabled": true,
  "groups": [
    {
      "baseUrlWhitelist": ["https://api.example.com/v1/"],
      "headerNames": ["X-User-Account", "X-Access-Token"]
    }
  ]
}
```

- `enabled`：全局开关。设为 `false` 时，代码预定义规则、手工规则和 Extension 规则都会停止生效。
- `groups`：URL 与 Header 名称的映射，可以配置多组。
- `baseUrlWhitelist`：允许注入请求头的 URL 前缀。
- `headerNames`：命中该组时需要注入的 Header 名称。

如果一个请求同时命中多个 group，会合并这些 group 的 Header 名称。同名 Header
不区分大小写地去重，策略提供的值会替换请求中原有的同名 Header。

文件不存在时，应用会创建 `{"enabled": true, "groups": []}`。如果 JSON 损坏或结构无效，
包括旧版没有 `groups` 的格式，也会重写为这个空默认配置。`enabled` 必须为布尔值，`groups`
必须为数组，每个组的两个字段必须为字符串数组。空手工配置仍会合并代码预定义规则和启用扩展的规则。

代码中，空默认配置名为 `DEFAULT_OUTBOUND_HEADER_POLICY_CONFIG`，预定义规则名为
`PREDEFINED_OUTBOUND_HEADER_POLICY_CONFIG`，均定义于 `src/config/outboundHeaders.ts`。
与预定义组完全相同的手工组在合并时去重。手工文件是
本机受信的高级配置，不具备 Extension sidecar 的全部限制；请勿手工配置 `Host`、`Content-Length`、
`Connection`、`Proxy-Authorization` 等传输层 Header，以免破坏请求。

### 2.4 `user_info.json` 字段

```json
{
  "X-User-Account": "replace-with-user-account",
  "X-Access-Token": "replace-with-real-token"
}
```

属性名必须与 `headerNames` 完全一致，包括大小写。字符串值会去掉首尾空白；数字和布尔值会转换为
字符串。缺失、`null`、对象、数组或包含控制字符的值不会成为有效凭据，通常会导致服务端认证失败。

不要把真实 `user_info.json` 放进 Extension、Git 仓库、日志或发给其他用户。

## 3. Extension 开发者接入

本节只适用于 OpenClaw Extension。Skill、MCP 配置或 Hook 目录不会因为放入同名文件而自动贡献规则。

### 3.1 Extension 中需要放什么

只需在现有 OpenClaw Extension 的根目录增加一个普通文件：

```text
your-extension/
├─ openclaw.plugin.json
├─ package.json
├─ ...原有 Extension 文件
├─ outbound-header-policy.json
└─ USER_SETUP.md                  # 可选，告诉用户需要配置哪些本机字段
```

参考文件：[`examples/extension/outbound-header-policy.json`](examples/extension/outbound-header-policy.json)。
建议同时参考 [`examples/extension/USER_SETUP.md`](examples/extension/USER_SETUP.md)，在 Extension 的
README 或用户说明中写清楚需要配置的 `user_info.json` 属性。`USER_SETUP.md` 只用于说明，不由应用读取。

不需要增加 Hook，不需要编写代码修改 `config.json`，也不需要声明 outbound-header 专属权限或
审批 token。用户安装并启用 Extension 后，应用会自动读取该文件；禁用或卸载 Extension 后，
对应规则会自动移除。

### 3.2 完整示例

```json
{
  "schemaVersion": 1,
  "groups": [
    {
      "baseUrlWhitelist": ["https://api.example.com/v1/"],
      "headerNames": ["X-User-Account", "X-Access-Token"]
    }
  ]
}
```

Extension 只声明 URL 和 Header 名称。Header 值固定从 `user_info.json` 的同名属性读取，用户仍需
在自己的 `user_info.json` 中提供实际值。

### 3.3 Extension 文件约束

- 文件名必须是 `outbound-header-policy.json`，并直接位于 Extension 根目录。
- 必须是普通文件，不能是符号链接或硬链接，最大 64 KiB。
- `schemaVersion` 当前只能是 `1`。
- 必须包含 1–32 个 group；每个 group 可包含 1–64 个 URL、1–32 个 Header。
- URL 必须使用 HTTPS，不能包含用户名、密码、query 或 fragment。路径末尾的 `/` 可省略；应用会按路径边界匹配。
- 不允许 localhost、loopback、IPv4/IPv6 link-local 或 unspecified 地址。
- Header 名称最长 128 个字符，必须是合法 HTTP Header 名称。
- 禁止声明连接和传输层 Header：`Host`、`Content-Length`、`Connection`、
  `Proxy-Authorization`、`Proxy-Connection`、`Keep-Alive`、`TE`、`Trailer`、
  `Transfer-Encoding`、`Upgrade`。
- schema 中不接受未定义字段。不要添加备注字段；JSON 本身也不支持注释。

导入来源中的 sidecar 无效时，Extension 安装会失败。已经安装的 Extension 如果 sidecar 后续损坏，
其全部规则会被排除。最终安装目录中的文件是运行时权威。

## 4. URL 匹配规则

以 `https://api.example.com/v1/` 为例：

| 请求 URL                                              | 是否命中 | 原因                                     |
| ----------------------------------------------------- | -------- | ---------------------------------------- |
| `https://api.example.com/v1/models`                   | 是       | protocol、host、port、path prefix 都匹配 |
| `https://api.example.com/v1/chat/completions?debug=1` | 是       | query 不参与匹配                         |
| `https://api.example.com/v10/models`                  | 否       | `/v1/` 不匹配 `/v10/`                    |
| `http://api.example.com/v1/models`                    | 否       | protocol 不同                            |
| `https://api.example.com:8443/v1/models`              | 否       | port 不同                                |
| `https://files.example.com/v1/models`                 | 否       | hostname 必须完全相同                    |

手工 `config.json` 可声明 HTTP 或 HTTPS；Extension sidecar 只能声明 HTTPS。路径末尾的 `/` 可省略，
`/v1` 与 `/v1/` 含义相同，且都不会误命中 `/v10`。

本地 loopback 请求不会注入 Header。不要配置 `localhost`、`127.x.x.x`、`0.0.0.0` 或 `::1`。

## 5. 对哪些请求有效

| 场景                                               | 是否生效 | 实现方式                                     |
| -------------------------------------------------- | -------- | -------------------------------------------- |
| OpenClaw Gateway 发出的匹配 HTTP(S) 请求           | 是       | Gateway 专用本地代理                         |
| Gateway 启动的、继承并遵守代理环境变量的子进程请求 | 是       | 继承 `HTTP_PROXY` / `HTTPS_PROXY` 等环境变量 |
| 会话标题生成                                       | 是       | Main 进程按同一规则直接注入                  |
| 设置页模型列表发现                                 | 是       | Main 校验用途、method 和 endpoint 后直接注入 |
| 设置页模型连接测试                                 | 是       | Main 重建固定的 `Hi` 测试请求后直接注入      |
| MCP 连接测试                                       | 是       | Main 的 MCP probe transport 直接注入         |
| 普通 Renderer `api.fetch`                          | 否       | 通用 IPC 不具备注入能力                      |
| 应用中其他未显式接入的 Main 请求                   | 否       | 不做全局 `fetch` 修改                        |
| 浏览器、终端或其他外部程序                         | 否       | 不修改系统全局代理                           |
| localhost/loopback 请求                            | 否       | 始终排除                                     |

是否注入最终仍取决于：全局 `enabled`、Extension 是否安装并启用、URL 是否命中、Header 名称是否合法，
以及 `user_info.json` 是否包含对应值。

上表中的“MCP 连接测试”是 Main 进程的测试入口。MCP 或其他能力在 Gateway 内实际运行后，如果其
HTTP(S) 请求经过 Gateway 网络环境，仍按第一行的本地代理规则处理。

## 6. 本地代理是否生效

会生效，但它是应用为 OpenClaw Gateway 单独创建的 loopback 代理，不是系统全局代理。

- 只有存在有效且启用的 URL 规则时才需要代理能力。
- Gateway 每次启动前都会读取并合并当前规则，再获得该代进程专用的代理地址和 CA 环境。
- HTTP 和 HTTPS 都经过该代理；HTTPS 由应用管理的本地 CA 完成代理所需的证书处理。
- 如果用户配置了系统代理或应用上游代理，本地代理会继续按现有代理策略转发。
- Gateway 发生重定向时，每个新请求都会重新按目标 URL 匹配；未命中的目标不会获得这些 Header。
- 标题生成、模型测试和 MCP 测试不绕行本地代理，而是在 Main 进程使用相同 matcher 直接注入，避免代理递归。

某个子进程如果主动忽略 `HTTP_PROXY`、`HTTPS_PROXY`、`NO_PROXY` 或证书环境变量，则不能保证它的
请求经过本地代理。

## 7. 规则何时刷新

| 变更                              | 刷新方式                                                              |
| --------------------------------- | --------------------------------------------------------------------- |
| 修改手工 `config.json`            | 下次策略合并时读取；重启应用可确保生效                                |
| 手工修改 `user_info.json`         | 重启应用，或由 Main 进程显式调用值刷新接口                            |
| 登录、退出或定时更新 Cookie       | 登录模块完成文件写入/清理后调用 `updateOutboundHeaderUserInfoCache()` |
| 安装或更新带 sidecar 的 Extension | 安装流程自动刷新；必要时重启 Gateway                                  |
| 启用或禁用 Extension              | 自动刷新；必要时重启 Gateway                                          |
| 卸载 Extension                    | 自动移除规则；必要时重启 Gateway                                      |
| Gateway 自身重新启动              | 启动前重新读取并合并规则                                              |

每次策略合并都会重新读取 `config.json` 和扩展策略文件，并读取一次 `user_info.json` 初始化值。
值刷新接口只读取 `user_info.json`，保留当前规则，不重读策略文件或重启代理。
凭据监控的 30 秒重试、到期刷新、文件变化回调，以及设置页手动刷新模型，不直接调用此接口；
若模型配置变化引发 Gateway 重启，则仍会执行上述策略合并。
登录模块接入细节见[值刷新接口文档](../outbound-header-user-info-refresh-api.md)。

`config.json` 的 `enabled:false` 在下次策略合并后生效，会关闭全部自动注入。若只想停用某个
Extension 的规则，请禁用或卸载该 Extension，不要关闭全局开关。

## 8. 常见问题

### Header 没有发出

依次检查：

1. 应用是否在修改手工文件后完整重启；
2. `enabled` 是否为 `true`；
3. Extension 是否已安装且已启用；
4. 请求的 protocol、hostname、port 和 path prefix 是否全部匹配；
5. `headerNames` 与 `user_info.json` 属性名是否完全一致；
6. JSON 是否有效，Extension URL 是否为 HTTPS；
7. 请求是否属于第 5 节列出的有效场景。

### 修改后旧规则仍然存在

手工文件没有热更新，请完全退出并重启应用。Extension 启停失败时，不要直接删除其安装目录；
应从应用的 Extension 管理界面重试禁用或卸载，让应用完成规则和 Gateway 生命周期收敛。

### 能否把 token 直接写进 `outbound-header-policy.json`

不能。sidecar 只声明 URL 和 Header 名称。真实值固定从本机 `user_info.json` 的同名属性读取。

### 如何处理请求中已有的同名 Header

命中规则后，策略值会替换请求中已有的同名 Header。`overwrite` 字段已移除，无需配置；
旧手工文件中残留的该字段会被忽略。

## 9. 分发前检查清单

- 示例中没有真实账号、token、Cookie 或内部域名；
- Extension 根目录包含合法的 `outbound-header-policy.json`；
- Extension 的 README 或 `USER_SETUP.md` 已列出用户必须提供的 `user_info.json` 属性；
- 所有 Extension URL 使用 HTTPS；
- `user_info.json` 中的 key 与 Header 名称完全一致；
- 已在安装、启用、禁用、更新、卸载和应用重启后分别验证；
- 已验证 Gateway 请求、标题生成、模型测试和 MCP 测试中实际需要的场景。
