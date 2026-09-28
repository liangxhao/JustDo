# LiteLLM JWT、Team 与旧版 30 天兼容

选择部署方式：

- [Docker 部署](docker/README.md)：Compose 管理 PostgreSQL、Redis 和单个 LiteLLM 服务。
- [普通机器部署](native/README.md)：Python 虚拟环境、独立基础服务及 systemd 模板。
- [本地认证联调](tests/integration/README.md)：独立 JWT 签发服务、模拟模型和测试 Virtual Key。

每种 Hook 位于独立的 `hooks/` 子目录，根目录 `register.py` 统一注册，`start.py` 负责启动和初始化。
环境变量使用 `LITELLM_JWT_*` 和 `LITELLM_DEFAULT_TEAM_ID`。

| 客户端      | 请求凭证                                | LiteLLM 授权主体                   | 有效期                         |
| ----------- | --------------------------------------- | ---------------------------------- | ------------------------------ |
| 新版客户端 | 登录服务签发的短期 JWT                  | 长期存在的 User + 唯一受管 Team | JWT 默认上限 5 分钟，可配置；Team 长期有效 |
| 未升级旧版  | 历史共享值注册成一枚 legacy Virtual Key | 专用 legacy Team                   | 30 天，禁止续期                |

Team 管理模型白名单、预算、禁用状态及 TPM/RPM 限制。
JWT 泄露后可在剩余有效期内被重放，应按需设置最短有效期。

### 模型请求头

强制 Hook `model_headers` 对模型 API（含实时 WebSocket）校验：

- `X-User-Account`：ASCII 字母开头，总长 9–12 字符，其余为字母或数字，末尾 6 位必须为数字，例如 `h00658810`。
- `X-Cookie`：非空，最多 16 KiB，格式为 `name=value; name2=value2`。按
  [RFC 6265](https://www.rfc-editor.org/rfc/rfc6265.html#section-4.2.1) 校验键值字符，拒绝控制字符、非 ASCII 和畸形键值对。
- 两个字段均只允许出现一次，缺失或不合法返回 HTTP 400；WebSocket 拒绝握手。

请求头错误仅含通用提示、错误码和请求 ID；JWT 错误使用相同格式并说明具体原因。
定位方法见[统一错误码](hooks/ERRORS.md)。
不读取请求正文、不记录或回显字段值。Cookie 仅验证格式，不证明会话有效，不能代替 JWT 或 Key 认证。
同样适用于旧 Key；旧客户端必须已经注入合法字段。管理接口、健康检查、模型列表/信息查询和 OPTIONS 预检不受该 Hook 限制。

## 复制与首次启动

复制整个 `deploy/litellm` 目录并保留层级，不能只复制 `docker/` 或 `native/`：
两者都依赖父目录的 `start.py`、`register.py`、`hooks/` 和依赖文件。
正式部署可以不复制 `tests/`。

在所选部署子目录将 `.env.example` 复制为 `.env`（不要覆盖已有配置），完成以下设置：

| 配置 | 要求 |
| --- | --- |
| `DATABASE_URL`、`LITELLM_ACTIVITY_DATABASE_URL` | 指向同一数据库；后者不能包含 Prisma 专用连接参数；密码需 URL 编码 |
| `LITELLM_MASTER_KEY`、`LITELLM_SALT_KEY` | 独立随机密钥；旧数据库必须保留原加密盐 |
| `UI_USERNAME`、`UI_PASSWORD` | 管理页面登录账号和密码，不用于客户端调用 |
| Redis 配置 | Docker 填写密码；native 还需填写地址和端口 |
| `LITELLM_JWT_ISSUER`、`LITELLM_JWT_AUDIENCE`、`LITELLM_JWT_JWKS_URL` | 与真实签发服务一致；JWKS 必须可访问，示例域名不能直接使用 |
| `LITELLM_JWT_MAX_LIFETIME_SECONDS` | 不小于签发令牌的有效期，最大 10800 秒 |
| `LITELLM_DEFAULT_TEAM_ID` | 默认 `standard`，首次创建后在网页管理模型和成员 |

Docker 还需填写 `POSTGRES_PASSWORD`，与两个数据库 URL 中的密码一致。
native 需提前准备可访问的 PostgreSQL 数据库（账号具有迁移建表权限）、Redis、
Python 3.11/3.12，并按 native README 安装依赖。首次安装需要软件源访问或已准备的离线包和 Prisma 引擎。

完成上述准备后，首次启动只需一个命令：

- Docker：在 `docker/` 执行 `docker compose up -d --build`。
- native：在 `native/` 执行 `.venv/bin/python start.py up`；已有虚拟环境使用其 Python 绝对路径。

启动后访问 `/health/liveliness` 检查服务，访问 `/ui` 登录管理页面。
在网页添加真实模型及上游凭据，再为默认 Team 选择允许的模型；空模型列表会拒绝调用。
生产部署不会自动创建测试 Key、模拟模型或 JWT 签发服务。旧 Key 兼容需按本文的迁移步骤单独登记。
若要无真实上游的完整认证测试，使用独立的[本地联调入口](tests/integration/README.md)。

客户端另外配置换证 URL、模型 URL 和出站请求头白名单；这些不会由服务端自动修改。
模型 URL 应使用可访问的非回环地址，接入组织现有 HTTPS 入口。

## 服务结构

单个 LiteLLM 实例同时处理以下请求：

- 带 `X-ACCESS-JWT` 或 JWT 形式 Bearer 的请求：校验 JWT 和 managed Team，失败直接拒绝。
- 普通 API Key、管理员密钥和管理页面会话：由 LiteLLM 原生认证校验。
- 活动请求：JWT 绑定当前 EndUser；可选的旧活动令牌只在配置期限内有效。

`hooks/jwt_auth/dispatch.py` 在服务启动时连接 LiteLLM 1.99.1 的认证回调入口，
普通 Key 返回原生认证流程，JWT 异常不回退。所有模型请求仍经过 LiteLLM 的公共权限、
预算和限流检查。适配固定支持此版本，升级前须验证。

参考 LiteLLM 官方文档：[Custom Authentication](https://docs.litellm.ai/docs/proxy/custom_auth)、
[Virtual Keys](https://docs.litellm.ai/docs/proxy/virtual_keys)、
[Team Budgets](https://docs.litellm.ai/docs/proxy/team_budgets)、
[Model Access](https://docs.litellm.ai/docs/proxy/model_access)。

## 1. 登录服务签发 JWT

登录服务必须使用非对称算法签名并提供 HTTPS JWKS。默认只启用 `RS256`。每枚 JWT 必须
包含：

- `kid`：JWT header 中的签名公钥 ID；
- `iss`：与 `LITELLM_JWT_ISSUER` 完全一致；
- `aud`：包含 `LITELLM_JWT_AUDIENCE`；
- `sub`：LiteLLM `user_id`，并与 `X-User-Account` 一致；
- `iat`、`exp`：整数时间戳，生命周期不超过配置上限（默认 300 秒，可配置 30–10800 秒）；
- `jti`：每枚 token 唯一。

客户端换证地址及有效期上限见 [客户端配置](../client/README.md)。
客户端自动换证、续签；Hook 使用 JWKS 校验签名及上述字段。

## 2. 配置服务

按所选部署目录的 README 安装依赖、填写该目录的 .env 并启动服务。

服务必须使用稳定的 `LITELLM_SALT_KEY`，它用于数据库模型凭据加密，不能跟随
master key 随意轮换。复用旧数据库时，保留原 salt；旧服务未设置 salt 时，将旧 master key
作为 salt 保留，再单独更换管理 master key。不要打印这些值。全新数据库使用独立随机 salt。
若旧 master key 曾分发给客户端，这只是保持可解密的迁移措施，应另外安排数据库凭据重加密，
不能直接改 salt 后重启。

多个 worker 通过 Redis 共享用量和限流计数。上线前须验证 Redis 故障行为、数据库
连接池和上游模型容量，并按目标并发执行流式请求压测。

模型通过 LiteLLM UI 配置。`config.yaml` 加载 JWT Hook 并开启：

```yaml
custom_auth_run_common_checks: true
```

不能删除该开关，否则自定义认证成功后不会执行 Team 的模型、预算和限流检查。

### 数据库与请求参数

两种部署使用相同参数，在各自的 `config.yaml` 中修改：

| 配置 | 默认值 | 含义 |
| --- | --- | --- |
| `general_settings.proxy_batch_write_at` | 60 | 消费用量批量写入间隔（秒），明细显示存在延迟 |
| `general_settings.database_connection_pool_limit` | 4 | 每个 worker 的 Prisma 数据库连接上限 |
| `general_settings.database_connection_timeout` | 30 | 等待获取 Prisma 池连接的超时（秒），不是模型请求超时 |
| `general_settings.disable_error_logs` | false | 开启原生失败请求记录落库，便于查询和分析 |
| `general_settings.always_include_stream_usage` | true | 请求流式用量信息，具体返回取决于上游支持 |
| `litellm_settings.drop_params` | true | 丢弃上游不支持的参数，调用方应注意相关功能可能不生效 |
| `litellm_settings.json_logs` | true | LiteLLM 日志使用 JSON 格式 |
| `litellm_settings.set_verbose` | false | 不开启详细调试输出 |
| `litellm_settings.request_timeout` | 1800 | 模型调用默认超时（秒），不是整个 Agent 任务的时限 |
| `router_settings.timeout` / `stream_timeout` | 1800 | Router 普通与流式调用的默认超时（秒） |
| `router_settings.num_retries` | 2 | 默认最多重试 2 次，是否重试取决于错误类型和 Router 策略 |

慢模型使用 30 分钟默认超时，为较长首 token 等待和生成留出时间。具体超时语义取决于
上游适配器，不保证整条流在第 30 分钟强制结束。模型单独配置、请求参数及网页保存的
Router 设置可能覆盖默认值；部署时检查是否残留较短超时或额外重试、fallback 策略。
30 分钟不是包含重试的总耗时上限，发生重试时总体等待时间可能更长。

失败请求记录受批量写入延迟影响，不一定立即出现在网页或数据库中。
请求头 Hook 在进入 LiteLLM 前拒绝的请求不生成原生消费记录，使用程序日志中的
错误码和请求 ID 定位；开启错误落库不等于覆盖所有入口拒绝或数据库故障。

启动入口在加载 LiteLLM 前将连接池参数写入进程内 `DATABASE_URL` 的
`connection_limit`、`pool_timeout`，覆盖 URL 中同名参数，保留其他连接参数；
`database_url` 必须为 `os.environ/DATABASE_URL`。不修改 `.env` 或活动 Hook 的
`LITELLM_ACTIVITY_DATABASE_URL`，后者不能带 Prisma 参数。
4 个 worker 的连接预算为原生池 16 加活动池最多 16，合计最多约 32 个；
数据库还须为初始化、管理及其他服务预留连接。worker 数不是模型请求并发上限。
批量写入减少写入频率，但异常退出时尚未落库的数据存在丢失风险。上述参数不代表已完成容量压测。

两种部署均开启 `store_prompts_in_spend_logs`、`forward_client_headers_to_llm_api`
和 `litellm_settings.enable_preview_features`。消费明细包含请求/响应正文，需限制数据库
访问权限并配置保留周期；两种部署的 `.env` 均可通过 `MAX_STRING_LENGTH_PROMPT_IN_DB`
配置正文字符串截断长度，示例值为 100000。
请求头转发会将 `X-User-Account`、`X-Cookie`、`X-ACCESS-JWT` 等字段发送给上游，
只允许接入有权接收这些凭据的可信模型服务，并限制上游日志访问。

`user_header_mappings` 将账号映射为 Customer/EndUser；同时配置同名的
`user_header_name`，供原生旧式用户字段读取路径使用。JWT 用户身份仍以签名中的 `sub`
为准，账号头必须与其一致；这些配置不代替 JWT 校验或 Team 授权。

## 3. 创建 Team 和用户分组

### 首次认证自动入组

首次部署设置 `LITELLM_DEFAULT_TEAM_ID=standard`，数据库初始化会创建名为 Default 的默认组。
组已存在时不作修改。初始模型列表为空，管理员须先在网页选择允许使用的模型，再开放客户端。
空 ID 关闭自动入组。初始化不创建用户 Key，也不预设成员或覆盖已有预算、模型和限额。

新用户首次通过 JWT 校验后自动加入默认组，继承默认成员策略。

已有用户即使没有组也不自动回填默认组，防止覆盖管理员移组或撤权。新组同样需要
`jwt_managed=true`；移组时移除旧组再加入新组，中间无组阶段请求被拒绝。
封禁应保留用户记录并移除成员关系或放入 blocked 组，**不要通过删除用户记录封禁**：
仍持有效组织身份的已删除用户会被识别为新用户。

权限变更受 LiteLLM 授权缓存传播影响。模型列表变化后，客户端可手动刷新。

### 网页管理

在 LiteLLM 网页创建 Team、设置 Models/Budget/Limits、添加或移动成员。
新组 metadata 设置 `{"jwt_managed": true}`；每个用户只能属于一个此类非 legacy Team。
管理员手动创建用户时关闭自动生成 Key，新用户也可以通过客户端首次登录自动入组。
成员和权限存储在数据库中，日常管理不修改代码、不重启服务、不主动中断进行中的模型请求。

## 4. 旧版客户端只兼容 30 天

若历史客户端使用的固定值也是当前 `LITELLM_MASTER_KEY`，必须先生成新 master key、修改
`.env` 并重启服务。绝不能直接把 master key 当 legacy Key；否则它仍拥有管理权限。
旧值不能是三段 base64url 的 JWT 外形或等于 `access-jwt-auth`；这些凭证保留给 JWT 认证，避免歧义。

在网页创建独立的 legacy Team，设置模型列表和限额，metadata 设置 `{"legacy_clients": true}`。
然后在部署根目录运行一次登记命令；此命令不创建或更新 Team 和成员：

```powershell
$env:LITELLM_MASTER_KEY = '<new-server-master-key>'
$env:LITELLM_LEGACY_KEY = '<exact-old-client-key>'
python -m hooks.jwt_auth.legacy_key --team-id '<legacy-team-id>' --base-url http://127.0.0.1:9108
Remove-Item Env:LITELLM_LEGACY_KEY
```

脚本把该值登记成 alias 为 `legacy-client` 的**唯一 legacy Virtual Key**，并强制：

- `allowed_routes=["llm_api_routes", "/models", "/v1/models"]`，只开放推理与客户端模型发现；
- 只继承 legacy Team 的模型列表；
- `duration=30d`。

第一次补迁移一个原先无过期时间的同 alias Key 时，脚本会加上 30 天期限；之后重复运行
不会延长已有期限。已经过期或过期时间超过迁移窗口时脚本直接拒绝。

旧 Key 若短于 16 字符，可在迁移时把 `MINIMUM_CUSTOM_KEY_LENGTH` 临时降到旧值长度，完成
后立刻恢复为 16 并重启。该设置不会改变现有 Key。

30 天后 LiteLLM 会自动拒绝过期 Key。确认旧版流量结束后再删除记录：

```powershell
$body = @{ key_aliases = @('legacy-client') } | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:9108/key/delete `
  -Headers @{ Authorization = "Bearer $env:LITELLM_MASTER_KEY" } `
  -ContentType 'application/json' -Body $body
```

删除旧 Key 不影响 JWT 和管理功能，无需重启服务。

## 5. 验证

在安装 LiteLLM v1.99.1 及测试依赖的 Python 环境中运行：

```powershell
python -m pytest -q tests
```

上线前至少验证：同一 Team 只能看到自己的模型；跨 Team 模型返回 403；blocked、预算和
RPM/TPM 生效；篡改签名、issuer、audience、`sub` 或账号 header 均返回 401/403；带无效
JWT 的请求不回退 legacy；旧 Key 到期后返回 401；任何日志中都不出现 JWT、Cookie、
Authorization 或 master key 明文。

## 6. EndUser 注册与活动记录

新版客户端使用同一短期 JWT 调用 `POST /customer/activity`，不调用 Customer 管理 API。
服务端先校验 JWT 和当前 managed Team，再要求正文 `user_id` 等于签名中的 `sub`。
首次调用原子创建 EndUser；已有记录保留预算、blocked 及其他 metadata，更新产品版本 alias 和活动信息。
被禁用的 Team 或 EndUser 不允许上报。模型权限仍由 LiteLLM 的公共授权检查执行。

请求正文示例：

```json
{"event_id":"822f78cc-bd26-4e13-a42a-b45060a330da","user_id":"alice","event_type":"startup","metadata":{"userName":"Alice","loginTime":"2026-09-22T09:00:00Z","productName":"Example","version":"1","clientTime":"2026-09-22T10:00:00Z"}}
```

首次成功后每 24 小时上报 heartbeat；失败按 1、5、15 分钟补试，再等待 24 小时。
重试复用事件 ID；保留最近 256 个 ID 去重及最近 90 个有活动的 UTC 日期。
数据库时间用于活动统计；客户端 loginTime 仅为声明值。正文最多 8 KiB，不接收 Cookie 或登录凭据。
开发环境 API Key 模式仅验证模型，不上报活动。

`LITELLM_ACTIVITY_DATABASE_URL` 是 asyncpg 使用的 PostgreSQL URI，必须与模型数据库一致，
不能带 Prisma 专有的 schema、connection_limit、pool_timeout 等参数；默认 schema 为 public。
初始化执行 `hooks/activity/schema.sql` 增加可空 metadata JSONB 列。运行账号需要 SELECT、INSERT，
以及 metadata 和 alias 的 UPDATE 权限。行锁与事务保护并发写入。
原生 Customer API/UI 不自动展示新增列，可查询：

```sql
SELECT user_id, alias, metadata->'customer_activity' AS activity
FROM public."LiteLLM_EndUserTable";
```

旧版活动兼容可选：`LITELLM_ACTIVITY_TOKEN` 设置为旧 Key 的
`SHA256("customer/activity/v1:" + oldKey)`，并设置带时区的绝对截止时间
`LITELLM_ACTIVITY_LEGACY_EXPIRES_AT`（例如 `2026-10-22T00:00:00Z`），不得晚于旧模型 Key 到期时间。
默认留空即拒绝旧活动上报；不会影响旧模型 Key 的调用。旧活动令牌不能证明用户身份，
也不能创建 EndUser，且到期后拒绝上报。新版 JWT 请求失败不会回退到此令牌。

## 7. 注册更多 Hook

新增 `hooks/<名称>/` → 在 `register.py` 注册 → 用 `LITELLM_HOOKS` 启用。
默认开启 `activity`，空值关闭可选 Hook，不影响模型 JWT 认证。
目录职责、可运行示例与测试要求见 [Hook 开发指南](hooks/README.md)。

真实 SQL 测试通过 `LITELLM_TEST_DATABASE_URL`
连接测试数据库并使用临时表；未配置时跳过。千级并发、生产登录服务及数据库升级需在预发布环境验证。
