# 客户端换证配置

编辑 [builtinModelAuth.ts](../../src/config/builtinModelAuth.ts) 中的
`BUILTIN_MODEL_AUTH_CONFIG`，然后重启 Electron 开发进程或重新打包。

```ts
tokenExchangeUrl: 'https://login.example.com/api/litellm/mtoken2jwt',
maxJwtLifetimeSeconds: 10800,
```

- `tokenExchangeUrl` 是 Jalor 完整换证地址，不是模型地址；空地址禁用换证。
- `maxJwtLifetimeSeconds` 为允许接受的 JWT 生命周期上限，整数 30–10800，当前配置 10800。
  不改变服务端签发时长，LiteLLM 的 `LITELLM_JWT_MAX_LIFETIME_SECONDS` 也须匹配。
  有效期越长，被盗后的重放窗口越长。
- 上述地址为示例；仓库换证地址留空，部署时填写可信组织的 HTTPS 地址。禁止填写 mtoken、JWT、Cookie 或生产固定 Key。

内置模型地址配置在 `src/config/builtinModels.ts`，仓库 `baseUrl` 留空。`src/config/outboundHeaders.ts` 的白名单也留空，部署时填写模型地址并允许 `X-User-Account`、`X-Cookie` 注入；规则只在策略启用且目标匹配协议、主机、端口和路径边界时生效。

JWT 必须使用 `aud: 'litellm'`；RS256 JWT 可以没有 kid，签名由 LiteLLM 校验。Main 的模型发现、标题生成、连接测试及 Gateway 均使用 `Authorization: Bearer <真实JWT>`；Main 同时保留 `X-ACCESS-JWT` 和账号字段。

开发启动：`npm run electron:dev`。
Windows 打包：`npm run dist:win`。

## 换证网络故障排查

`stage: 'request'` 且 `reason: 'Token exchange network request failed'` 表示换证传输失败，
尚未拿到可处理的 HTTP 响应；不是 JWT claims 校验失败。有可处理的非成功 HTTP 响应时，
日志会显示 `Token exchange HTTP <状态码>` 和 `httpStatus`。请求异常的 `networkCode`
只显示受控错误码：`ENOTFOUND` / `EAI_AGAIN` 检查 DNS，`ECONNREFUSED` 检查接口主机、
端口和服务监听，`ENETUNREACH` / `EHOSTUNREACH` 检查内网路由，`ECONNRESET` 检查服务端
或代理断连；TLS 错误码检查证书信任和接口协议。15 秒截止时间触发时单独显示超时。
未知底层错误继续使用通用原因，不打印原始 Error/cause 或登录凭据。

在出错电脑上检查完整 `tokenExchangeUrl` 的主机与端口，并检查应用设置中的网络代理；
Main 使用应用已保存的直连、系统或自定义代理配置，不能只凭浏览器访问成功判断应用连接成功。
换证请求禁止跟随重定向，直接请求遇到重定向也可能显示通用网络失败；应配置最终换证地址。
换证传输不注入出站请求头策略，模型地址白名单不能替代换证地址配置。

如果没有可用模型凭据，换证失败后出现 `auth-logout` 配置同步是清理内置模型授权，
不代表登录文件被删除或用户主动退出。修正网络问题后后台监控会重试。

产品改名应修改 `package.json.productName` 并重启开发进程或重新打包；`package.json.name`
保持 `justdo`。改名后的登录文件在 `%APPDATA%/<productName>/huawei/user_info.json`，
旧品牌目录不会自动迁移。修改项目文件夹名称不改变产品数据目录。

## 换证成功后的本地 JWT 校验

`stage: 'credential'` 表示换证接口已返回可处理的成功响应，客户端随后拒绝了模型凭据。
`Invalid or expired access token` 不只表示过期，也包含字段、身份和期限不满足本地约定。
查看附带的 `credentialCode`：

| 错误码 | 检查项 |
| --- | --- |
| `audience-mismatch` | `aud` 必须是字符串 `litellm`，不接受 `model-service` 或数组 |
| `account-mismatch` / `missing-subject` | `sub` 必须与当前登录文件的 `X-User-Account` 一致 |
| `missing-issuer` / `missing-token-id` | JWT 必须包含非空 `iss` / `jti` |
| `unsupported-algorithm` | 使用受支持的非对称算法，如 `RS256`；不接受 `HS256` |
| `invalid-token-format` / `invalid-jwt-json` | `access_token` 必须是完整三段 JWT，不能带 `Bearer ` 前缀；header/payload 必须是 JSON 对象 |
| `invalid-timestamps` | `iat` / `exp` 必须是整数数字、Unix 秒，不能是字符串 |
| `issued-in-future` | 签发时间比本机时间晚超过 30 秒；核对客户端与签发服务时钟 |
| `lifetime-exceeded` / `expiry-too-far` | `exp - iat` 和 `exp - 本机时间` 均不能超过编入 Main 的 `maxJwtLifetimeSeconds` |
| `invalid-lifetime` / `expired-or-expiring` | `exp` 必须晚于 `iat`，且本机校验时至少还有 15 秒有效期 |
| `expires-in-mismatch` | `exp` 不能晚于客户端请求时间加响应 `expires_in` 再加 30 秒 |

这些是客户端本地预检结果；JWT 签名由模型服务验证，服务端 HTTP JWKS 开关不改变
上述客户端校验。修改配置后重启开发 Main 或重新打包。排查时只分享失败代码，不分享
完整 JWT、mtoken、登录文件或 JWT 身份字段值。

## 设备标识约定

换证请求中的 `deviceId` 只采用当前首个有效网卡 MAC，去掉冒号并转为 12 位大写十六进制。Main 公共模块 `src/main/core/network/macAddress.ts` 导出 `getMacAddress(): string`，登录和换证共用；没有可用 MAC 或查询失败时抛错，不回退 UUID，也不使用本地设备 ID 文件。

换证服务按该 MAC 格式校验请求中的 `deviceId`，不要读取服务端本机 MAC。网卡切换或随机 MAC 变化可能改变标识，登录与换证应采用一致的设备绑定约定；MAC 不能替代 mtoken 认证或设备签名。

## 仅 API Key 的开发验证

编辑 `src/config/builtinModelAuth.ts`：

```ts
developmentAuthMode: 'api-key',
developmentApiKey: '<development-only-key>',
```

然后运行 `npm run electron:dev`。该模式不执行 mtoken 换证，
使用 `Authorization: Bearer <key>`；Key 不写入 SQLite，也不传给 Renderer。
此开关只对未打包开发进程有效，打包版始终使用 JWT。修改后须重启 Electron；
提交或打包前改回 `developmentAuthMode: 'jwt'` 并清空 Key，打包钩子会拒绝其他配置。

本仓库的 LiteLLM 模型 API 仍要求合法的 `X-User-Account` 和 `X-Cookie`。
完整调用须先登录，配置可信的非回环内置模型地址，并为该地址启用这两个字段的
请求头注入；回环地址不注入登录信息。代码内置规则与已有手动配置及已启用扩展规则合并，
不会重写用户配置文件；手动策略禁用仍优先。详见[请求头预设](../../src/config/README.md#请求头预设)。
只有 Key 时，可测试模型列表，或使用不要求上述请求头的开发模型服务。
