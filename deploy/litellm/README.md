# LiteLLM 部署与运维

本目录提供单个 LiteLLM 服务的部署配置：新版客户端使用短期 JWT，旧版客户端可使用限期
Virtual Key；两者共用模型入口，模型权限、预算和限流由 Team 管理。

## 阅读入口

| 要做的事 | 阅读位置 |
| --- | --- |
| 直接用 Python 部署或启动 | [普通机器部署](native/README.md) |
| 用 Docker 管理服务及 PostgreSQL、Redis | [Docker 部署](docker/README.md) |
| 更新或重启已有部署 | [存量部署更新与重启](UPGRADE.md) |
| 首次部署前核对共同配置 | [复制与首次启动](#复制与首次启动) |
| 对接登录服务和客户端 | [认证与授权](#认证与授权)、[客户端配置](../client/README.md) |
| 管理模型权限和用户 | [Team 与用户分组](#team-与用户分组) |
| 调整连接池、超时等参数 | [服务配置](#服务配置) |
| 查看日志、确认长期运行的保留策略 | [日志与长期运行](#日志与长期运行) |
| 迁移旧客户端或接入活动上报 | [旧版兼容](#旧版客户端只兼容-30-天)、[活动记录](#用户活动记录) |
| 使用模拟模型联调或开发 Hook | [本地认证联调](tests/integration/README.md)、[开发与验证](#开发与验证) |

## 复制与首次启动

### 1. 准备目录和依赖

复制整个 `deploy/litellm` 目录并保留层级，不能只复制 `native/` 或 `docker/`。
两种部署都依赖父目录的 `start.py`、`register.py`、`logging.json`、`hooks/` 和依赖文件；
正式部署可以不复制 `tests/`。

直接用 Python 部署时，需提前准备 Python 3.11/3.12、可访问的 PostgreSQL 数据库和 Redis，
数据库账号须具有迁移建表权限。按 [native 安装说明](native/README.md#安装和配置)安装依赖；
首次安装需要软件源访问，或预先准备离线 Python 包和匹配的 Prisma 引擎。
Docker 的基础服务准备见 [Docker 部署](docker/README.md)。

### 2. 填写部署配置

在所选部署子目录将 `.env.example` 复制为 `.env`，不要覆盖已有配置。
先完成基础设施和管理设置：

| 配置 | 要求 |
| --- | --- |
| `DATABASE_URL`、`LITELLM_ACTIVITY_DATABASE_URL` | 指向同一数据库，密码需 URL 编码；活动数据库 URL 不能包含 Prisma 专用参数 |
| `LITELLM_MASTER_KEY`、`LITELLM_SALT_KEY` | 全新数据库使用独立随机密钥；已有数据库必须保留原加密盐，见[密钥与模型配置](#密钥与模型配置) |
| `UI_USERNAME`、`UI_PASSWORD` | 管理页面登录账号和密码，不用于客户端调用 |
| Redis 配置 | Docker 填写密码；native 还需填写地址和端口 |
| `POSTGRES_PASSWORD`（仅 Docker） | 与两个数据库 URL 中的密码一致 |

再完成 JWT 和默认分组设置：

| 配置 | 要求 |
| --- | --- |
| `LITELLM_JWT_ISSUER`、`LITELLM_JWT_AUDIENCE`、`LITELLM_JWT_JWKS_URL` | 与真实签发服务一致；JWKS 必须可访问，示例域名不能直接使用 |
| `LITELLM_JWT_ALLOW_HTTP_JWKS` | 内网 HTTP JWKS 使用 `true`；未设置或 `false` 时只允许 HTTPS 和回环 HTTP；部署模板已显式设为 `true` |
| `LITELLM_JWT_MAX_LIFETIME_SECONDS` | 不小于签发令牌的有效期，默认 300 秒，可配置 30–10800 秒 |
| `LITELLM_DEFAULT_TEAM_ID` | 模板默认 `standard`；首次创建后在网页管理模型和成员；空值关闭自动入组 |

### 3. 初始化并启动

完成依赖安装和 `.env` 配置后，在对应子目录执行首次启动命令：

| 部署方式 | 执行目录 | 首次启动命令 |
| --- | --- | --- |
| Python 直接启动 | `native/` | `.venv/bin/python start.py up` |
| Docker | `docker/` | `docker compose up -d --build` |

Python 使用已有虚拟环境时，将 `.venv/bin/python` 替换为该环境 Python 的绝对路径；
Windows 命令见 [native 部署说明](native/README.md#初始化和启动)。

启动后依次完成：

1. 访问 `/health/liveliness` 检查服务，访问 `/ui` 登录管理页面。
2. 在网页添加真实模型及上游凭据，再为默认 Team 选择允许的模型；空模型列表会拒绝调用。
3. 配置客户端的换证 URL、模型 URL 和出站请求头白名单，见[客户端配置](../client/README.md)。
   模型 URL 应使用可访问的非回环地址，接入组织现有 HTTPS 入口；服务端不会自动修改客户端配置。
4. 按[验证要求](#开发与验证)核对授权、限流和认证失败行为后，再开放客户端流量。

生产部署不会自动创建测试 Key、模拟模型或 JWT 签发服务。无真实上游时可使用独立的
[本地联调入口](tests/integration/README.md)；旧 Key 需按[旧版兼容步骤](#旧版客户端只兼容-30-天)单独登记。

已有部署更新或重启时，按 [UPGRADE.md](UPGRADE.md)操作。原生表结构已就绪、只需检查 User metadata
或准备默认组时，可使用 [upgrade.py](upgrade.py)，命令见[增量更新步骤](UPGRADE.md#使用增量更新脚本)。

## 认证与授权

### 凭证与请求流程

| 客户端 | 请求凭证 | LiteLLM 授权主体 | 有效期 |
| --- | --- | --- | --- |
| 新版客户端 | 登录服务签发的短期 JWT | 长期存在的 User + 唯一受管 Team | JWT 默认上限 5 分钟，可配置；Team 长期有效 |
| 未升级旧版 | 历史共享值注册成一枚 legacy Virtual Key | 专用 legacy Team | 30 天，禁止续期 |

单个 LiteLLM 实例按以下方式处理请求：

- 带 `X-ACCESS-JWT` 或 JWT 形式 Bearer 的请求：校验 JWT 和受管 Team，失败直接拒绝，不回退普通 Key 或 legacy Key。
- 普通 API Key、管理员密钥和管理页面会话：由 LiteLLM 原生认证校验。
- 活动请求：JWT 绑定当前 User，仅更新已存在用户的活动资料，见[活动记录](#用户活动记录)。

所有模型请求仍经过 LiteLLM 的公共权限、预算和 TPM/RPM 限流检查。
JWT 泄露后可在剩余有效期内被重放，应按需设置最短有效期。

### 登录服务签发 JWT

登录服务必须使用非对称算法签名并提供 JWKS，默认只启用 `RS256`。
每枚 JWT 必须包含以下字段：

| 位置 | 字段 | 要求 |
| --- | --- | --- |
| Header | `kid` | 签名公钥 ID |
| Payload | `iss` | 与 `LITELLM_JWT_ISSUER` 完全一致 |
| Payload | `aud` | 与 `LITELLM_JWT_AUDIENCE` 一致；模板值为 `justdo-litellm` |
| Payload | `sub` | LiteLLM `user_id`，并与 `X-User-Account` 一致 |
| Payload | `iat`、`exp` | 整数时间戳，生命周期不超过配置上限 |
| Payload | `jti` | 每枚 token 唯一 |

客户端自动换证和续签；Hook 使用 JWKS 校验签名及上述字段。
客户端换证地址及有效期上限见[客户端配置](../client/README.md)。

**JWKS 的 HTTP 开关。** Hook 未设置开关时只接受 HTTPS 或回环 HTTP。
内网 HTTP JWKS 需在所选部署目录的 `.env` 设置 `LITELLM_JWT_ALLOW_HTTP_JWKS=true`
（也接受 `1`、`yes`，忽略大小写和前后空格），并填写真实公钥地址。
两种 `.env.example` 已包含此开关，Docker Compose 会透传给容器；已有 `.env` 补充后须重启，
Docker 使用 `docker compose up -d --build` 重新构建并应用环境变量。
此开关只控制获取公钥的协议，不修改客户端换证地址，也不放宽 issuer、audience、算法或签名校验。

**时间校验。** `LITELLM_JWT_CLOCK_SKEW_SECONDS` 默认 30 秒，用于以下未来上界：

- `iat <= 服务端时间 + 容差`。
- `exp <= 服务端时间 + 有效期上限 + 容差`。
- `exp - iat` 仍不能超过有效期上限。

已到期的 token 立即拒绝，容差不延长实际有效期，也不放宽 `nbf`。
客户端本地预检使用固定 30 秒容差，各端仍应同步系统时间。

### 模型请求头

强制 Hook `model_headers` 校验模型 API（含实时 WebSocket）的以下请求头，旧 Key 同样适用：

| 请求头 | 要求 |
| --- | --- |
| `X-User-Account` | ASCII 字母开头，总长 9–12 字符，其余为字母或数字，末尾 6 位必须为数字，例如 `h00658810` |
| `X-Cookie` | 非空，最多 16 KiB，格式为 `name=value; name2=value2`；按 RFC 6265 校验键值字符，拒绝控制字符、非 ASCII 和畸形键值对 |

两个字段均只允许出现一次。缺失或不合法返回 HTTP 400；WebSocket 拒绝握手。
旧客户端必须已经注入合法字段；管理接口、健康检查、模型列表/信息查询和 OPTIONS 预检不受该 Hook 限制。

请求头校验不读取请求正文、不记录或回显字段值。Cookie 仅验证格式，不证明会话有效，
不能代替 JWT 或 Key 认证。请求头错误仅含通用提示、错误码和请求 ID；JWT 错误使用相同结构，
并说明具体原因。定位方法见[统一错误码](hooks/ERRORS.md)，Cookie 语法参考
[RFC 6265](https://www.rfc-editor.org/rfc/rfc6265.html#section-4.2.1)。

## Team 与用户分组

### 默认组与首次自动入组

首次部署设置 `LITELLM_DEFAULT_TEAM_ID=standard`，数据库初始化会创建名为 Default 的默认组；
组已存在时不作修改。初始模型列表为空，管理员须先在网页选择允许使用的模型，再开放客户端。
空 ID 关闭自动入组。初始化不创建用户 Key，也不预设成员或覆盖已有预算、模型和限额。

新用户首次通过 JWT 校验后自动加入默认组，继承默认成员策略。
已有用户即使没有组也不自动回填，避免覆盖管理员移组或撤权。

### 网页管理与权限变更

在 LiteLLM 网页创建 Team，设置 Models/Budget/Limits，并添加或移动成员：

- 新组 metadata 设置 `{"jwt_managed": true}`；每个用户只能属于一个此类非 legacy Team。
- 管理员手动创建用户时关闭自动生成 Key；新用户也可通过客户端首次登录自动入组。
- 移组时先移除旧组，再加入新组；中间无组阶段的请求被拒绝。
- 封禁时保留用户记录并移除成员关系，或放入 blocked 组。**不要通过删除用户记录封禁**：
  仍持有效组织身份的已删除用户会被识别为新用户。

成员和权限存储在数据库中，日常管理不修改代码、不重启服务、不主动中断进行中的模型请求。
权限变更受 LiteLLM 授权缓存传播影响；模型列表变化后，客户端可手动刷新。

## 服务配置

环境变量在所选部署子目录的 `.env` 中修改；下述参数在各自的 `config.yaml` 中修改，
两种部署使用相同默认值。

### 密钥与模型配置

`LITELLM_SALT_KEY` 用于数据库模型凭据加密，必须稳定，不能跟随 master key 随意轮换：

- 全新数据库使用独立随机 salt。
- 复用旧数据库时保留原 salt；旧服务未设置 salt 时，将旧 master key 作为 salt 保留，再单独更换管理 master key。
- 若旧 master key 曾分发给客户端，上述操作只保证旧数据可解密，仍应另外安排数据库凭据重加密，不能直接改 salt 后重启。

不要打印这些值。模型通过 LiteLLM UI 配置。`config.yaml` 加载 JWT Hook，并必须保留：

```yaml
general_settings:
  custom_auth_run_common_checks: true
```

关闭该开关后，自定义认证成功也不会执行 Team 的模型、预算和限流检查。

### 数据库与请求参数

**连接池和批量写入。** 以下参数属于 `general_settings`：

| 参数 | 默认值 | 含义 |
| --- | --- | --- |
| `database_connection_pool_limit` | 4 | 每个 worker 的 Prisma 数据库连接上限 |
| `database_connection_timeout` | 30 | 等待获取 Prisma 池连接的超时（秒），不是模型请求超时 |
| `proxy_batch_write_at` | 60 | 消费用量批量写入间隔（秒），明细显示存在延迟 |

启动入口在加载 LiteLLM 前将连接池参数写入进程内 `DATABASE_URL` 的 `connection_limit`、
`pool_timeout`，覆盖同名参数并保留其他连接参数；`database_url` 必须为 `os.environ/DATABASE_URL`。
不修改 `.env` 或活动 Hook 的 `LITELLM_ACTIVITY_DATABASE_URL`，后者不能带 Prisma 参数。

4 个 worker 的连接预算为原生池 16 加活动池最多 16，合计最多约 32 个；
数据库还须为初始化、管理及其他服务预留连接。worker 数不是模型请求并发上限。
多个 worker 通过 Redis 共享用量和限流计数；上线前须验证 Redis 故障行为、数据库连接池和
上游模型容量，并按目标并发执行流式请求压测。这些默认值不代表已完成容量压测。

**模型请求与 Router。**

| 配置 | 默认值 | 含义 |
| --- | --- | --- |
| `litellm_settings.request_timeout` | 1800 | 模型调用默认超时（秒），不是整个 Agent 任务的时限 |
| `router_settings.timeout` / `stream_timeout` | 1800 | Router 普通与流式调用的默认超时（秒） |
| `router_settings.num_retries` | 2 | 默认最多重试 2 次，是否重试取决于错误类型和 Router 策略 |
| `litellm_settings.drop_params` | true | 丢弃上游不支持的参数，调用方应注意相关功能可能不生效 |
| `general_settings.always_include_stream_usage` | true | 请求流式用量信息，具体返回取决于上游支持 |

慢模型使用 30 分钟默认超时，为较长首 token 等待和生成留出时间。具体语义取决于上游适配器，
不保证整条流在第 30 分钟强制结束，也不是包含重试的总耗时上限。
模型单独配置、请求参数和网页保存的 Router 设置可能覆盖默认值；部署时须检查是否残留
较短超时或额外重试、fallback 策略。

### 正文存储与请求头转发

两种部署均开启 `store_prompts_in_spend_logs`、`forward_client_headers_to_llm_api`
和 `litellm_settings.enable_preview_features`：

- 消费明细包含请求/响应正文，需限制数据库访问权限并配置保留周期。
  `.env` 中的 `MAX_STRING_LENGTH_PROMPT_IN_DB` 控制正文字符串截断长度，示例值为 100000。
- 请求头转发会将 `X-User-Account`、`X-Cookie`、`X-ACCESS-JWT` 等字段发送给上游，
  只允许接入有权接收这些凭据的可信模型服务，并限制上游日志访问。

`user_header_mappings` 将账号映射为 Customer/EndUser；同时配置同名的 `user_header_name`，
供原生旧式用户字段读取路径使用。JWT 用户身份仍以签名中的 `sub` 为准，账号头必须与其一致；
这些配置不代替 JWT 校验或 Team 授权。

## 日志与长期运行

### 程序日志：输出位置与轮转

两种启动方式共用 `logging.json`。Uvicorn 的启动及自定义 Hook 日志包含完整日期、时间、
时区偏移、级别、日志名和进程号；时间使用运行环境的本地时区，Docker 容器通常为 UTC。
LiteLLM 原生日志由 `litellm_settings.json_logs: true` 配置为 JSON，
`litellm_settings.set_verbose: false` 关闭详细调试输出。

为控制长期运行的输出量，默认关闭 Uvicorn 逐请求访问日志，保留校验拒绝和运行异常。
每个 worker 仅补充一条 Hook 与数据库池配置摘要；显式初始化记录迁移及 Hook 初始化阶段。
自定义诊断不输出连接串、凭据或请求正文，按错误码和请求 ID 定位，见[统一错误码](hooks/ERRORS.md)。

| 运行方式 | 日志去向 | 保留与轮转 |
| --- | --- | --- |
| Python 直接启动 | 标准输出/标准错误，通常显示在终端 | 程序不自行创建日志文件；仅终端输出时无需文件轮转 |
| Python 配合 `nohup`、重定向或 `tee` | 启动命令指定的文件，也可能是默认 `nohup.out` | 外部文件须由部署环境配置轮转和保留上限，本服务不会自动管理 |
| systemd | journal，使用 `journalctl -u litellm` 查看 | 由 journal 管理轮转和容量，长期部署需核对主机 journald 配额 |
| Docker Compose | 容器标准输出/标准错误 | 每个容器使用 `json-file`，单文件最多 10 MB，最多保留 3 个文件；已有容器需重新创建才能应用 |

直接用 Python 启动时，更新部署文件并重启进程即可应用日志配置，详见
[native 日志说明](native/README.md#python-直接启动时的日志)。不要将长期输出保存到没有轮转的文件。

### 数据库记录：消费明细与失败请求

数据库中的请求记录与上述程序日志分别管理。以下参数属于 `general_settings`：

| 参数 | 默认值 | 含义 |
| --- | --- | --- |
| `disable_spend_logs` | false | 开启原生消费记录落库 |
| `disable_error_logs` | false | 开启原生失败请求记录落库，不控制程序日志输出 |
| `maximum_spend_logs_retention_period` | 30d | 保留最近 30 天的消费日志，过期记录分批删除 |
| `maximum_spend_logs_retention_interval` | 1d | 每 24 小时清理一次消费日志，不是固定在午夜执行 |

消费清理覆盖 `LiteLLM_SpendLogs` 及其关联工具索引，**不清理 `LiteLLM_ErrorLogs`**；
错误日志表需单独配置数据库维护任务。修改保留配置后重启服务；首次清理通常在启动约
24 小时后执行，积压记录可能需要多轮清理。删除记录后，PostgreSQL 通常保留空间供后续写入复用，
不保证磁盘文件立即缩小。

批量写入会让消费及失败记录延迟显示，异常退出时尚未落库的数据存在丢失风险。
请求头 Hook 在进入 LiteLLM 前拒绝的请求不生成原生消费记录，应查程序日志中的错误码和请求 ID；
开启错误落库不等于覆盖所有入口拒绝或数据库故障。

## 旧版客户端只兼容 30 天

仅在仍需保留旧客户端调用时执行本节。

### 1. 更换管理密钥并准备 legacy Team

若历史客户端使用的固定值也是当前 `LITELLM_MASTER_KEY`，必须先生成新 master key、修改
`.env` 并重启服务，同时[保留原加密盐](#密钥与模型配置)。绝不能直接把 master key 当 legacy Key，
否则它仍拥有管理权限。旧值也不能是三段 base64url 的 JWT 外形或等于 `access-jwt-auth`，
这些凭证保留给 JWT 认证，避免歧义。

在网页创建独立的 legacy Team，设置模型列表和限额，metadata 设置 `{"legacy_clients": true}`。
下面的登记脚本不会创建或更新 Team 和成员。

### 2. 一次性登记旧 Key

在部署根目录执行，以下为 PowerShell 示例：

```powershell
$env:LITELLM_MASTER_KEY = '<new-server-master-key>'
$env:LITELLM_LEGACY_KEY = '<exact-old-client-key>'
python -m hooks.jwt_auth.legacy_key --team-id '<legacy-team-id>' --base-url http://127.0.0.1:9108
Remove-Item Env:LITELLM_LEGACY_KEY
```

脚本把旧值登记为 alias 为 `legacy-client` 的**唯一 legacy Virtual Key**，并强制：

- `allowed_routes=["llm_api_routes", "/models", "/v1/models"]`，只开放推理与客户端模型发现。
- 只继承 legacy Team 的模型列表。
- `duration=30d`。

第一次补迁移一个原先无过期时间的同 alias Key 时，脚本会加上 30 天期限；之后重复运行
不会延长已有期限。已经过期或过期时间超过迁移窗口时，脚本直接拒绝。

旧 Key 若短于 16 字符，可在迁移时把 `MINIMUM_CUSTOM_KEY_LENGTH` 临时降到旧值长度，
完成后立刻恢复为 16 并重启。该设置不会改变现有 Key。

### 3. 到期后清理

30 天后 LiteLLM 会自动拒绝过期 Key。确认旧版流量结束后再删除记录：

```powershell
$body = @{ key_aliases = @('legacy-client') } | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:9108/key/delete `
  -Headers @{ Authorization = "Bearer $env:LITELLM_MASTER_KEY" } `
  -ContentType 'application/json' -Body $body
```

删除旧 Key 不影响 JWT 和管理功能，无需重启服务。

## 用户活动记录

### 上报流程

客户端使用同一短期 JWT 调用 `POST /user/activity`。服务端保留现有 JWT 与受管 Team 校验，并要求正文 `user_id` 等于签名中的 `sub`。
活动存储只锁定已存在的 `LiteLLM_UserTable` 行，合并 `metadata.user_activity` 并保留其他 metadata；缺用户返回 404，不创建用户、不修改角色或 Team、不开通管理 API。
这些约束指活动存储阶段；之前的共享 JWT 认证仍按既有配置处理自动开户和默认入组。404 仅表示认证完成后活动存储未找到 User，认证或 Team 授权失败仍返回原有错误。
旧 `/customer/activity` 及旧共享活动令牌不再支持。允许先更新客户端、过几天再更新服务端；客户端将接口或字段尚不支持视为可选上报延后，不回退旧接口，也不影响登录、模型目录或聊天。

原生请求中的 `end_user_id` 和 Customer 账号映射保持不变，继续供消费记录及网页 EndUser 筛选使用；User 活动与 EndUser 消费归属是两条独立路径。

请求正文示例：

```json
{
  "event_id": "822f78cc-bd26-4e13-a42a-b45060a330da",
  "user_id": "h00658810",
  "event_type": "usage.snapshot",
  "metadata": {
    "userName": "Example User",
    "loginTime": "2026-09-22T09:00:00Z",
    "productName": "Example",
    "version": "1",
    "clientTime": "2026-09-22T10:00:00Z"
  }
}
```

客户端启动就绪至少 15 分钟后择空闲采集：已有 Gateway 连接、没有已知活动运行且系统至少 60 秒无输入。每个客户端数据目录按北京时间每日最多 3 个报告窗口，间隔至少 6 小时；窗口在 Main KV 预留，准备失败、无变化与网络失败也消耗机会，重启/换账号不重置。每窗口至多一次原生统计查询和一次 HTTP 请求，无分钟级补试、无退出网络等待。400/404/405/413/415/422/501 或未确认的成功响应至少冷却 24 小时，其他失败等待下一合格窗口。
每个新窗口使用新事件 ID 和最新累计快照，不排队补发过期快照；同一个 ID 的正文不变。发送前重新取得当前 JWT。只有有界读取到成功响应 `{"ok":true}` 才保存成功指纹；动态时间不参与变化判断，同一快照 24 小时内不重复发送。重定向禁止，错误正文不进入日志。服务端保留最近 256 个 ID 去重及最近 90 个有活动的 UTC 接收日期；原有 startup 接收计数不代表客户端真实启动次数。
数据库时间用于活动统计，客户端 loginTime 仅为声明值。正文最多 8 KiB，不接收 Cookie 或登录凭据。
开发环境 API Key 模式仅验证模型，不上报活动。

### 数据库要求与查询

`LITELLM_ACTIVITY_DATABASE_URL` 是 asyncpg 使用的 PostgreSQL URI，必须与模型数据库一致，
不能带 Prisma 专有的 `schema`、`connection_limit`、`pool_timeout` 等参数；默认 schema 为 public。
活动使用原生 `LiteLLM_UserTable.metadata`，不增加列。运行账号需要 User 表的 SELECT 和 metadata UPDATE 权限，不需要通过活动接口 INSERT 用户。
行锁与事务保护并发合并；缺失或类型不正确的原生 metadata 应先处理原生 schema，不能给 EndUser 增列代替。

可查询：

```sql
SELECT user_id, user_alias, metadata->'user_activity' AS activity
FROM public."LiteLLM_UserTable";
```

### 活动与模型用量的边界

协议保持四个顶层字段 `event_id`（UUID）、`user_id`（匹配 JWT）、`event_type`、`metadata`，不接受其他顶层字段。
`event_type` 接受 `[a-z][a-z0-9._-]{0,63}`，例如 `usage.snapshot`、`session.summary`。已有 startup、heartbeat、login 继续有效；客户端发送 `usage.snapshot`，loginTime 是声明的登录资料。

未来字段统一放在 `metadata` 中，不必为每个指标修改服务端白名单。它必须是 JSON 对象，支持嵌套对象、数组、字符串、布尔、null 和有限数值。
整个请求最多 8 KiB；metadata 根深度为 0、最大深度 6、最多 256 个节点、128 个对象键，单键最多 128 字符、单字符串最多 2048 字符。
任意层级的明确凭据字段（如 Cookie、Authorization、mtoken、api_key、accessToken、privateKey）会被拒绝，NaN/Infinity、无效 Unicode、JSONB 不支持的 U+0000 或超限结构返回受控 400/413。

客户端通过单次 `sessions.usage` 读取最近 7 个北京时间日期的本机每日活跃原生会话数与已记录输入/输出/总 Token，所有模型统一统计，不拆分本机登录账号。`costDaily` 和全部 creator 的日期 cohort 已由原生聚合，客户端只提取有界数字，不读正文或逐会话明细。原生缓存可能后台刷新；客户端不轮询等待完整，缺失统计跳过，有效空统计才报零。会话数包含子任务等原生实例，不是当天新建产品聊天数；同一实例同日只计一次，跨日分别计数。

当前 metadata 中的用量形状如下（daily 最多 7 条）：

```json
{
  "usage": {
    "timeZone": "Asia/Shanghai",
    "collectedAt": 1793836800000,
    "cacheStatus": "fresh",
    "updatedAt": 1793836799000,
    "daily": [
      {"date": "2026-11-05", "sessionCount": 3, "inputTokens": 400, "outputTokens": 200, "totalTokens": 600}
    ]
  }
}
```

这些值仅作为客户端提供的最新快照，写入 `UserTable.metadata.user_activity.metadata`，事件类型记在 `latest_event_type`。
自定义事件和数值不自动累计、不反写原生消费或权限；只有 startup/login 执行已有的专属聚合。
此接口不是长期每日历史账本或多设备用量聚合服务；保存最后一次客户端近 7 天快照。已记录 Token 不保证模型提供了所有调用用量，不估算缺失值，也不进入原生账单。内置服务消费仍可查询原生 DailyUserSpend。

### 分批升级与失败隔离

活动接口是可选旁路。客户端的上报 Promise 不向调用者抛出错误，登录和启动不等待网络上报，也不因上报错误修改模型认证、Team 或 EndUser 归属。
旧服务仍可能返回 HTTP 404、400 或其他错误状态，这是服务端未更新时的真实响应；新版客户端静默延后并仅记录受控信息，不弹出活动错误、不清除 JWT、不改用旧共享 Key。
服务更新后，后续合格窗口会重新探测并恢复上报，无须再次发布客户端；应用重启保留配额和冷却，不绕过等待。
不持久排队未确认事件，不承诺跨重启或停服期间的完整历史补报。原生用量留在 OpenClaw，下个窗口重新采样；退出只取消请求。未来添加字段只需扩展 metadata；`getMetadata` 同步回调只提供小对象，异步统计使用可取消的 `collectMetadata`，失败均不影响主流程。

## 开发与验证

### 注册更多 Hook

每种 Hook 位于独立的 `hooks/` 子目录，根目录 `register.py` 统一注册，`start.py` 负责启动和初始化。
新增 `hooks/<名称>/` → 在 `register.py` 注册 → 用 `LITELLM_HOOKS` 启用。
默认开启 `activity`；空值关闭可选 Hook，不影响强制 JWT 认证和模型请求头校验。
目录职责、可运行示例与测试要求见 [Hook 开发指南](hooks/README.md)。

`hooks/jwt_auth/dispatch.py` 在启动时连接 LiteLLM 1.99.1 的认证回调入口，
普通 Key 返回原生认证流程，JWT 异常不回退。该适配固定支持此版本，升级前须验证。

### 测试与上线验证

在安装锁定 LiteLLM 版本及测试依赖的 Python 环境中，从 `deploy/litellm` 运行：

```sh
python -m pytest -q tests
```

上线前至少验证：

- 同一 Team 只能看到自己的模型；跨 Team 模型返回 403。
- blocked、预算及 RPM/TPM 限制生效。
- 篡改签名、issuer、audience、`sub` 或账号 header 均返回 401/403。
- 带无效 JWT 的请求不回退 legacy；旧 Key 到期后返回 401。
- 程序诊断中不出现 JWT、Cookie、Authorization 或 master key 明文；上游转发与正文落库范围按[配置说明](#正文存储与请求头转发)单独核对。

真实 SQL 测试通过 `LITELLM_TEST_DATABASE_URL` 连接测试数据库并使用临时表，未配置时跳过。
千级并发、生产登录服务及数据库升级需在预发布环境验证。

### 参考资料

- LiteLLM [Custom Authentication](https://docs.litellm.ai/docs/proxy/custom_auth)
- LiteLLM [Virtual Keys](https://docs.litellm.ai/docs/proxy/virtual_keys)
- LiteLLM [Team Budgets](https://docs.litellm.ai/docs/proxy/team_budgets)
- LiteLLM [Model Access](https://docs.litellm.ai/docs/proxy/model_access)
