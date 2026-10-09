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
