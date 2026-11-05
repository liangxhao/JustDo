# 部署配置

编辑本目录的 TypeScript 常量后，重启 Electron 开发进程或重新打包。
配置文件只保存预设值和类型，校验、文件读取、请求等逻辑由使用方负责。
内置模型地址、JWT 换证地址、出站请求头白名单、开发 Key 及其文件路径均留空，部署时填写所需地址。空换证地址禁用换证，空模型地址不启用内置模型。
除本地临时开发 Key 外，禁止填写 Key、JWT、mtoken、Cookie 等凭据。

开发联调可通过 `builtinModelAuth.ts` 的 `developmentApiKeyFile` 指定本地 Key 文件；仅未打包且选择 `api-key` 模式时由 Main 读取，文件内容不参与打包。非空 `developmentApiKey` 优先于文件。

| 文件                                         | 配置项                                                       |
| -------------------------------------------- | ------------------------------------------------------------ |
| [appUpdate.ts](appUpdate.ts)                 | 应用更新地址、语音模型路径与版本历史限制                     |
| [builtinModels.ts](builtinModels.ts)         | 内置模型开关 `enabled`、LiteLLM API 地址 `baseUrl`           |
| [activityReporting.ts](activityReporting.ts) | 活动信息上报开关 `enabled`，默认开启                         |
| [builtinModelAuth.ts](builtinModelAuth.ts)   | Jalor 换证地址、JWT 生命周期上限、开发认证模式与临时 API Key |
| [loginStorage.ts](loginStorage.ts)           | 登录存储目录 `directoryName`、用户信息文件 `userInfoFileName` |
| [outboundHeaders.ts](outboundHeaders.ts)     | 请求头注入开关、URL 白名单与请求头名称的分组预设             |

## 登录信息目录

`loginStorage.ts` 的 `LOGIN_STORAGE_CONFIG` 分别配置目录和用户信息文件：

- `directoryName`：产品数据目录下的存储子目录，还可存放其他业务文件。
- `userInfoFileName`：上述目录中的用户信息文件名，独立于目录名配置。

部署时直接修改配置文件中的值；实际目录名与文件名以该配置为准。

Windows 路径为 `%APPDATA%/<productName>/<directoryName>/<userInfoFileName>`；
产品根目录继续由 `package.json.productName` 决定。两项均只填写单个非空名称，
不填写绝对路径、路径分隔符、`.` 或 `..`。

登录读写、内置模型换证和出站请求头缓存共用同一路径解析器；隔离开发 profile 的 `userData`
不改变此路径。更改目录或文件名不会自动迁移或回退读取旧文件；
需要完全退出应用后自行移动或重命名原文件，或启动应用后重新登录。
退出登录只删除配置指定的用户信息文件，不删除整个目录或其中的其他文件。
修改配置需重启 Electron 开发进程或重新打包；此配置文件只保存名称，不保存凭据。

## 活动上报

`activityReporting.ts` 的 `endpointPath` 配置上报路径，默认 `/user/activity`，需以 `/` 开头并与服务端路由一致；拼接时保留模型地址的部署路径前缀，仅去掉末尾 `/v1`。
将 `enabled` 改为 `false`，关闭延迟的用量快照采集和上报；登录回调也不会启动上报。设为 `true` 后仍须内置模型启用且 JWT 有效。
此开关不关闭 JWT 换证、模型请求或现有 User/Team 授权或 EndUser 消费归属，不删除已经保存的活动数据。
修改后须重启 Electron 开发进程或重新打包，不是运行时设置。
启动就绪至少 15 分钟、已有 Gateway 连接、已知没有活动运行且系统至少 60 秒无输入时，才允许进入采集窗口。每个客户端数据目录按北京时间每日最多 3 个窗口，间隔至少 6 小时；准备失败、数据未变化和网络失败也消耗窗口。配额与接口冷却保存在 Main KV，重启、登录和跨午夜不绕过间隔；无分钟级重试。
每窗口至多一次 `sessions.usage` 查询最近 7 天的本机每日活跃原生会话数和已记录输入/输出/总 Token，不拆分账号、内置或自配模型，不读取聊天正文，不轮询等待缓存完成。原生缓存可能后台刷新；Gateway 不可用时不会启动它。快照通过 `metadata.usage` 上报；同步 `getMetadata` 只适合小对象扩展，异步统计使用可取消的 `collectMetadata`。
新版客户端可先于活动服务部署；404 等接口或格式不支持响应至少冷却 24 小时且跨重启保留，不阻塞登录、启动或聊天。每个新窗口使用新事件 ID 和最新快照，不积压旧事件；退出只取消采集和请求。

Main 日志搜索 `[UserActivity]`，每条为单行 JSON；开发终端同样可见。Windows 默认文件是 `%APPDATA%/<productName>/logs/main-YYYY-MM-DD.log`，文件名按 UTC 日期，隔离开发目录则在其 `logs/` 下。

| event / reason | 含义 |
| --- | --- |
| `started`、`waiting / startup-delay` | 上报服务已启动；`nextCheckAt` 为启动等待结束后的检查时间 |
| `waiting / not-idle` | 尚未满足空闲条件；`gatewayConnected`、`activeSessions`、`idleSeconds` 说明具体状态，系统须至少 60 秒无键鼠输入 |
| `waiting / login-unavailable`、`jwt-unavailable`、`api-key-mode` | 缺少可用登录资料/JWT，或使用不参与上报的开发 API Key 模式 |
| `waiting / minimum-interval`、`daily-limit`、`endpoint-cooldown` | 正在等待持久化间隔、日配额或接口冷却；可见当前次数、下次检查时间及已有的上次成功时间 |
| `collecting`、`sending` | 已预留一个报告窗口，开始统计或发送；不代表成功 |
| `succeeded` | 服务端返回 2xx 且正文明确 `ok:true`；HTTP 状态和本日窗口次数可见 |
| `failed` | 失败；`reason`、`phase`、可用的 `httpStatus` 区分配置、配额保存、采集、网络、确认等阶段 |
| `skipped / statistics-unavailable`、`unchanged` | 本窗口没有可用统计，或统计未变化；没有发送 HTTP |
| `disabled`、`stopped` | 配置关闭/内置提供方关闭，或当前上报服务已停止 |

同一等待/失败状态最多每 30 分钟重复一次；状态变化和真正的采集、发送结果会记录。`nextCheckAt`/`lastSuccessAt` 为 UTC ISO 时间，下次检查不保证一定发送。日志不包含账号、凭据、地址、快照正文或原始异常；日志故障不影响报告结果。`succeeded` 后若另有 `failed / state-write-failed` 且 `phase=success-persistence`，表示远端已确认，但本机成功状态未能保存。

## 模型认证

`tokenExchangeUrl` 填写完整换证接口地址，空值禁用换证。
`maxJwtLifetimeSeconds` 范围为 30–10800 秒，当前配置 10800；须与签发端和
LiteLLM 的 `LITELLM_JWT_MAX_LIFETIME_SECONDS` 策略匹配。
它与模型请求的 `baseUrl` 是两个不同地址。部署时使用可信组织的 HTTPS 地址。JWT audience 必须为字符串 `justdo-litellm`，kid 可选；模型请求的 Bearer 携带真实 JWT。

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

代码内置预设由策略服务与用户目录 `outbound-header-proxy/config.json` 中的手动规则及已启用扩展规则合并，不写入或覆盖用户配置。新建文件仅包含空手动规则；已有安装也使用当前代码内置规则。手动配置的 `enabled: false` 禁用所有注入，保留用户选择。

开发启动：`npm run electron:dev`。Windows 打包：`npm run dist:win`。
服务端部署见 [LiteLLM README](../../deploy/litellm/README.md)。
