# 部署配置

编辑本目录的 TypeScript 常量后，重启 Electron 开发进程或重新打包。
配置文件只保存预设值和类型，校验、文件读取、请求等逻辑由使用方负责。
内置模型地址、JWT 换证地址、出站请求头白名单和开发 Key 文件路径默认留空；部署时填写，不能直接使用未配置的内置模型。
除本地临时开发 Key 外，禁止填写 Key、JWT、mtoken、Cookie 等凭据。

开发联调可通过 `builtinModelAuth.ts` 的 `developmentApiKeyFile` 指定本地 Key 文件；仅未打包且选择 `api-key` 模式时由 Main 读取，文件内容不参与打包。非空 `developmentApiKey` 优先于文件。

| 文件 | 配置项 |
| --- | --- |
| [appUpdate.ts](./appUpdate.ts) | 应用更新地址、语音模型路径与版本历史限制 |
| [builtinModels.ts](./builtinModels.ts) | 内置模型开关 `enabled`、LiteLLM API 地址 `baseUrl` |
| [activityReporting.ts](./activityReporting.ts) | 活动信息上报开关 `enabled`，默认开启 |
| [builtinModelAuth.ts](./builtinModelAuth.ts) | Jalor 换证地址、JWT 生命周期上限、开发认证模式与临时 API Key |
| [outboundHeaders.ts](./outboundHeaders.ts) | 请求头注入开关、URL 白名单与请求头名称的分组预设 |

## 活动上报

`activityReporting.ts` 的 `endpointPath` 配置上报路径，默认 `/customer/activity`，需以 `/` 开头并与服务端路由一致；拼接时保留模型地址的部署路径前缀，仅去掉末尾 `/v1`。
将 `enabled` 改为 `false`，关闭活动接口的启动上报、
每日心跳及失败重试；登录回调也不会启动上报。设为 `true` 恢复原有上报行为，仍须内置模型启用且 JWT 有效。
此开关不关闭 JWT 换证、模型请求或服务端必要的身份/EndUser 处理，不删除已经保存的活动数据。
修改后须重启 Electron 开发进程或重新打包，不是运行时设置。

## 模型认证

`tokenExchangeUrl` 填写完整换证接口地址，空值禁用换证。
`maxJwtLifetimeSeconds` 范围为 30–10800 秒，默认 300；须与签发端和
LiteLLM 的 `LITELLM_JWT_MAX_LIFETIME_SECONDS` 策略匹配。
它与模型请求的 `baseUrl` 是两个不同地址。生产环境使用 HTTPS。

只有 API Key 时，可临时编辑 `builtinModelAuth.ts`：

```ts
developmentAuthMode: 'api-key',
developmentApiKey: '<development-only-key>',
```

Key 优先于 JWT 换证，通过 Main 和 OpenClaw SecretRef 使用；
不写入 SQLite、不返回 Renderer。该开关仅对未打包开发进程有效，打包版始终使用
JWT。修改后须重启 Electron；提交或打包前改回 `jwt` 并清空 Key，打包钩子也会阻止
包含开发 Key 的构建。

本仓库的 LiteLLM 部署仍要求模型请求携带合法的 `X-User-Account` 和 `X-Cookie`，
API Key 模式不免除此校验。测试完整模型调用须先登录，将内置模型地址配置为可信的
非回环服务地址，并在请求头白名单中允许该地址和这两个字段。只有 Key 时，可测试
模型列表，或使用不要求这些请求头的开发模型服务。

## 请求头预设

`groups` 中每组指定 `baseUrlWhitelist` 和 `headerNames`。
请求头名称对应登录文件中的字段；白名单按协议、主机、端口和路径边界匹配，
不支持回环地址。白名单为空时不注入请求头。

预设用于首次生成用户目录的 `outbound-header-proxy/config.json`；
已有手动配置优先，不会随重新打包被覆盖。`overwrite` 保持 false。
已有用户须同步修改用户目录的该配置文件，新增可信模型地址及所需请求头。
扩展提供的策略继续由原策略服务合并。

开发启动：`npm run electron:dev`。Windows 打包：`npm run dist:win`。
服务端部署见 [LiteLLM README](../../deploy/litellm/README.md)。
