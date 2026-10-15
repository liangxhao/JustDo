# LiteLLM 存量部署更新与重启

适用于已经有数据库、模型和用户的服务，更新为本目录代码后继续使用原有数据。
当前部署固定支持 LiteLLM 1.99.1；更换 LiteLLM 版本前，须在预发布环境验证迁移、认证和模型调用。

**普通重启不会更新数据库。原生表结构已就绪、只需补活动字段和默认组时，运行 `upgrade.py` 即可。**
脚本仅增加缺失项，不执行原生迁移，不删除已有数据或修改已有组。
已有组的标记、模型和已有用户的归属，需要管理员检查并补齐。

可以选择下面三条操作路径：

- **增量更新脚本**：按[增量更新步骤](#使用增量更新脚本)运行 `upgrade.py`，仅补活动字段和默认组，成功后正常启动服务。
- **原生迁移和完整初始化**：原生数据库版本需要升级或首次建库时，按
  [完整初始化入口](#完整初始化入口)运行 `native/start.py init`，成功后启动服务。
- **手动补齐数据库**：原库已完成当前 LiteLLM 版本的原生迁移、只缺活动字段和默认组时，按
  [手动更新步骤](#不用初始化脚本时手动更新数据库)执行 SQL，然后启动服务。

存量更新以继续使用原数据库、保留已有用户、模型、Key、分组和历史记录为前提。
本目录的 Hook 更新只新增缺失的列和默认组，不删除或清空已有记录；已有默认组也不会被重建。
**`init` 还会执行 LiteLLM 自带的版本化迁移，因此涉及 LiteLLM 版本变化时，须先在备份副本验证迁移内容。**
只补本次两个 Hook 项目且不需要原生迁移时，使用 `upgrade.py` 或下文的手动 SQL。

## 使用增量更新脚本

脚本为部署根目录的 [upgrade.py](upgrade.py)，使用现有服务的 Python 环境及已有数据库。
它读取 `LITELLM_ACTIVITY_DATABASE_URL`；必须确认该地址指向原 LiteLLM 数据库，且不含 Prisma 专用连接参数。
`--env-file` 显式指定部署配置文件，文件中的值覆盖继承的同名环境变量，不展开 `${...}`。
省略该参数时只使用进程环境变量，不自动搜索 `.env`。

### 普通机器

以 `/opt/litellm/native` 为例，可以先只读检查，不停服、不修改数据库：

```sh
cd /opt/litellm/native
.venv/bin/python ../upgrade.py --env-file .env --check
```

然后停止旧服务、备份原库并更新代码和依赖，保留原 `.env` 及加密盐。
确认执行账号有建列和插入默认组的权限后，运行增量更新，成功后启动服务：

```sh
sudo -u litellm .venv/bin/python ../upgrade.py --env-file .env && sudo systemctl start litellm
```

没有 systemd 时，在更新成功后运行 `.venv/bin/python start.py`。
Windows 在 `native` 目录执行 `.venv\Scripts\python.exe ..\upgrade.py --env-file .env`，
检查模式在命令末尾加 `--check`。

### Docker

更新完整部署目录并重新构建镜像后，在 `docker/` 目录中执行。
原数据库服务必须已启动并健康；这里复用 `init` 服务的环境配置，但将入口替换为增量脚本：

```sh
docker compose run --rm --no-deps --entrypoint python init /opt/litellm-hooks/upgrade.py --check
```

停止旧模型服务、备份数据库后应用更新：

```sh
docker compose run --rm --no-deps --entrypoint python init /opt/litellm-hooks/upgrade.py
```

只有命令以退出码 0 完成后，才正常启动新模型服务；Redis 和数据库都必须健康：

```sh
docker compose up -d --no-deps --force-recreate litellm
```

### 脚本执行范围

- 启用 `activity` 时，为 EndUser 增加缺失的 `metadata jsonb` 列。已有列及其内容保持不变。
- `LITELLM_DEFAULT_TEAM_ID` 非空且组不存在时创建该组，默认 metadata 为 `{"jwt_managed":true}`，模型列表为空。
  ID 为空时不创建组，不擅自启用自动入组。
- 已有组整行保留，包括 metadata、模型、预算、blocked 状态及成员关系。
- 发现 metadata 类型不匹配或所需原生表不存在时停止，不删除、重建或强制转换旧结构。
- 两项更新在同一个事务中执行，提交前任一步失败时回滚；重复执行跳过已存在的项目。
  脚本不执行 LiteLLM 原生迁移、不修改 `.env`、不创建用户或 Key，也不启停服务。

`--check` 使用只读事务，显示缺失项和需要管理员核对的设置。更新完成后的 `CHECK` 提示也需处理：
为新组选择模型、检查旧组受管标记和已有用户成员关系。退出码 0 表示检查或数据库更新成功，不代表所有用户已具备模型权限。
完整备份、配置和验证步骤见下文。

## 完整初始化入口

### 普通机器和 systemd

使用 **`native/start.py init`**。它会读取同目录的 `native/.env`，然后调用部署根目录的初始化逻辑。
不要直接在根目录执行 `python start.py init` 并假定它会读取 `.env`，根目录入口本身不加载该文件。

先停止原服务，备份原数据库，更新代码、依赖及配置；详细准备见后文。
确认 `native/.env` 中使用原数据库、原加密盐，并包含需要的设置，例如：

```dotenv
LITELLM_DEFAULT_TEAM_ID=standard
LITELLM_HOOKS=activity
```

`standard` 是默认组的 ID，可替换为已有组的真实 ID；已有其他可选 Hook 时保留它们。
在 `/opt/litellm/native` 中执行，使用现有服务的 Python 环境：

```sh
cd /opt/litellm/native
sudo -u litellm .venv/bin/python start.py init && sudo systemctl start litellm
```

这里使用 `&&`，初始化失败时不会启动服务。执行前应已完成停服和备份；不需要重新运行首次安装或创建新数据库。
没有 systemd、以前台方式运行时，停止旧进程并备份后，可以执行 `.venv/bin/python start.py up`，
它会依次初始化和启动；Linux 的 `bash start.sh up` 是同一入口。
Windows 使用 `.venv\Scripts\python.exe start.py init`，成功后再运行
`.venv\Scripts\python.exe start.py`。

执行成功后，缺失的 EndUser `metadata` 列和默认组已补齐；仍需为默认组设置模型白名单，
并检查已有用户的成员关系。之后同一代码和数据库的日常重启直接重启服务，无需再次初始化。

### Docker

在原 `docker/` 目录中，停服、备份并构建新镜像，确认数据库和 Redis 健康后，执行：

```sh
docker compose run --rm --no-deps init
```

该任务使用镜像内的 `/opt/litellm-hooks/start.py init`，环境变量由 Compose 提供。
**只有这条命令以退出码 0 完成后**，再执行：

```sh
docker compose up -d --no-deps --force-recreate litellm
```

完整停服、备份及构建顺序见[Docker 更新步骤](#docker-更新步骤)。

## 判断本次需要做什么

| 场景 | 需要执行的操作 |
| --- | --- |
| 同一份代码和配置，数据库已完成初始化，仅重启进程或机器 | 直接重启服务，不必重复加字段或建组 |
| 原生表结构已就绪，更新代码后只缺本目录的活动字段或默认组 | 先用 `upgrade.py --check` 检查，停服备份后执行增量更新，再核对组和用户 |
| 首次建库或需要升级 LiteLLM 原生表结构 | 停服、备份、验证并执行 `init`，然后核对组和用户 |
| 仅修改 `.env` 或 `config.yaml`，不涉及数据库或新 Hook 初始化 | native 重启；Docker 重新创建服务容器以应用环境变量 |
| 首次启用 `activity`，或更改 `LITELLM_DEFAULT_TEAM_ID` 并需要创建新组 | 更新配置后执行 `upgrade.py`，再启动服务；新组还要配置模型 |
| 仅在网页修改组、模型、预算或成员 | 保存即可，不需要数据库初始化；授权缓存传播需要时间 |

`init` 可以对同一部署重复执行：增加列使用 `IF NOT EXISTS`，默认组使用
`ON CONFLICT DO NOTHING`。**重复执行不会修复已有组的 metadata、添加模型或给已有用户入组。**
原生迁移先于 Hook 初始化；Hook 初始化在一个事务内完成，失败会回滚该事务，不能据此认为原生迁移也已回滚。

## 更新前保留数据和配置

1. 记录当前代码或镜像版本，备份所用部署目录的 `.env`、`config.yaml` 和已定制的服务配置。
2. 停止处理请求的 LiteLLM 服务，备份 PostgreSQL，确认备份可用后再执行迁移。
   同一数据库若还有其他 LiteLLM 实例，也应停止后再迁移。
3. 更新完整的 `deploy/litellm` 目录，包括根目录 `start.py`、`register.py`、`hooks/`
   和所用部署子目录；保留已有 `.env`，逐项合并新示例配置及 `config.yaml` 的变化。

必须保留原 `LITELLM_SALT_KEY`，否则数据库中的模型凭据可能无法解密。
旧服务未设置 salt 时，以旧 master key 作为 salt 保留，再单独安排 master key 变更；
不要在更新时重新生成 salt。数据库地址、账号及 Docker 的
`LITELLM_DEPLOYMENT_NAME`、数据卷名称也应保持与原部署一致。

若原服务不是通过当前 Compose 部署，先核对数据库地址和旧卷挂载，不能直接假定新 Compose 会找到旧库。
禁止使用 `docker compose down -v` 清理更新环境，也不要用 `prisma db push --accept-data-loss` 代替迁移。

### 补齐旧配置

比较所用部署目录的 `.env.example` 与现有 `.env`，只合并需要的配置，不要用示例文件覆盖旧文件。

| 配置 | 存量服务需要核对的内容 |
| --- | --- |
| `DATABASE_URL` | 继续指向原 LiteLLM 数据库；执行原生迁移的账号需有相应建表和改表权限 |
| `LITELLM_ACTIVITY_DATABASE_URL` | 与上项指向同一数据库，默认 schema 为 `public`；不能带 Prisma 专用的 `schema`、`connection_limit`、`pool_timeout` 等参数 |
| `LITELLM_MASTER_KEY`、`LITELLM_SALT_KEY` | 保留稳定加密盐；master key 只用于服务端管理，不分发给客户端 |
| `UI_USERNAME`、`UI_PASSWORD` | 补齐管理页面登录配置 |
| Redis 配置 | 保留实际连接信息；native 需要地址、端口和密码，Docker 核对密码 |
| `LITELLM_JWT_ISSUER`、`LITELLM_JWT_AUDIENCE`、`LITELLM_JWT_JWKS_URL` | 填真实签发方参数和可访问的 JWKS 地址，与客户端换证服务一致 |
| `LITELLM_JWT_ALLOW_HTTP_JWKS` | JWKS 使用内网非回环 HTTP 时显式设为 `true`；旧 `.env` 不会自动获得新示例中的设置 |
| `LITELLM_JWT_MAX_LIFETIME_SECONDS` | 不小于实际 JWT 生命周期，支持 30–10800 秒，默认 300 秒；同时核对客户端上限 |
| `LITELLM_DEFAULT_TEAM_ID` | 使用实际默认组的 **team_id**，例如 `standard`；不是网页显示名。留空关闭新用户自动入组，也不创建默认组 |
| `LITELLM_HOOKS` | 需要活动记录时包含 `activity`；显式留空会关闭可选 Hook，不会关闭强制 JWT 和请求头校验 |
| `LITELLM_ACTIVITY_TOKEN`、`LITELLM_ACTIVITY_LEGACY_EXPIRES_AT` | 仅旧版活动兼容需要；没有此需求时留空，不要生成新的兼容期限 |

两个数据库 URL 在完整 `init` 入口中都需要提供，即使关闭了 `activity`；
增量脚本只使用 `LITELLM_ACTIVITY_DATABASE_URL`。
新增字段由初始化账号创建；活动运行账号需要 EndUser 表的 SELECT、INSERT，以及 metadata、alias 的 UPDATE 权限。

已有 `config.yaml` 至少保留以下认证和迁移配置，并合并当前模板中的其他必要变化：

```yaml
general_settings:
  custom_auth: hooks.jwt_auth.handler.user_api_key_auth
  custom_auth_run_common_checks: true
  disable_prisma_schema_update: true
  database_url: os.environ/DATABASE_URL
```

普通启动有意禁用自动 schema 更新。请求超时、连接池、日志保留和请求头转发设置见
[公共配置说明](README.md#数据库与请求参数)，更新时也需核对网页保存的模型和 Router 覆盖值。

## 普通机器更新步骤

以下使用 Linux、`/opt/litellm/native`、服务账号 `litellm` 和现有 `.venv`。
使用其他虚拟环境时，替换为该环境 Python 的绝对路径；所有命令应使用同一个环境。
**每一步成功后再继续；初始化失败时保持服务停止。**

1. 停服，完成上一节的备份，再更新完整部署目录和配置：

   ```sh
   sudo systemctl stop litellm
   ```

   PostgreSQL 备份可由现有运维平台执行，或使用与服务器版本匹配的 `pg_dump`。
   例如在已有安全备份目录中执行，按提示输入数据库密码：

   ```sh
   pg_dump --host=127.0.0.1 --port=5432 --username=litellm --dbname=litellm --password --format=custom --file=/secure-backups/model-proxy-before-update.dump
   ```

   将地址、账号、库名及文件路径替换为实际值，确认备份文件可读且不覆盖需要保留的旧备份。

2. 依赖文件有变化，或现有环境尚未安装当前版本时，安装锁定依赖并生成 Prisma 客户端：

   ```sh
   cd /opt/litellm/native
   sudo -u litellm .venv/bin/python install.py --existing-env
   ```

   此命令使用已有虚拟环境。安装阶段不读取 `.env`；内网 Prisma 引擎配置按
   [native 安装说明](native/README.md#安装和配置)设置，确保变量在执行安装的服务账号环境中有效。

3. 仅补活动字段和默认组时执行增量更新，命令会读取指定的 `native/.env`：

   ```sh
   cd /opt/litellm/native
   sudo -u litellm .venv/bin/python ../upgrade.py --env-file .env
   ```

   这一步结束后不会启动服务。先执行下文的数据库核对，再启动。
   如果需要原生版本迁移，此步骤改为 `.venv/bin/python start.py init`，按完整初始化处理。

4. 启动服务，限制客户端流量，完成组和用户配置及验证后再开放：

   ```sh
   sudo systemctl start litellm
   sudo systemctl status litellm
   sudo journalctl -u litellm -n 100 --no-pager
   ```

   只有修改了 systemd unit 时，才需要在启动前安装更新后的 unit 并执行 `sudo systemctl daemon-reload`。

未使用 systemd 时，先停止旧前台进程，同样执行安装和 `upgrade.py`，随后运行
`.venv/bin/python start.py`；需要完整初始化时才使用 `start.py init` 或 `start.py up`。
Windows 对应增量命令为 `.venv\Scripts\python.exe ..\upgrade.py --env-file .env`，启动为
`.venv\Scripts\python.exe start.py`。

日常重启使用 `sudo systemctl restart litellm`，前台部署重新运行 `start.py`。
systemd 模板没有自动执行 `init` 的步骤；不要改用原生 `litellm` 命令绕开 Hook 入口。

## Docker 更新步骤

在原部署的 `docker/` 目录执行，保持项目名和数据卷不变。
以下显式运行一次增量更新任务，以便在启动服务前确认它成功。
**每一步成功后再继续，特别是更新命令必须以退出码 0 结束。**

1. 停止模型服务，保留数据库和 Redis，完成备份后再更新完整部署目录和配置：

   ```sh
   docker compose stop litellm
   ```

   使用本 Compose 的 `db` 服务时，可在数据库容器内生成备份，再复制到已有安全目录。
   此处先写文件再复制，也避免 PowerShell 对二进制输出重定向造成的备份损坏：

   ```sh
   docker compose exec -T db sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc -f /tmp/model-proxy-before-update.dump'
   docker compose cp db:/tmp/model-proxy-before-update.dump /secure-backups/model-proxy-before-update.dump
   ```

   替换宿主机备份路径；外置数据库使用其备份方式。核对备份后再继续。

2. 校验配置、构建新镜像并确认基础服务健康：

   ```sh
   docker compose config --quiet
   docker compose build litellm init
   docker compose up -d db redis
   docker compose ps
   ```

   等待 `db`、`redis` 都显示 healthy，再执行下一步。

3. 使用新镜像和当前环境变量执行增量更新，完成后核对数据库：

   ```sh
   docker compose run --rm --no-deps --entrypoint python init /opt/litellm-hooks/upgrade.py
   ```

   `--rm` 会移除这次临时任务容器，以命令退出码判断结果。
   它与首次安装时由 Compose 管理、显示 `Exited (0)` 的常驻任务记录不同。
   如果需要原生版本迁移，将此步骤改为 `docker compose run --rm --no-deps init`，按完整初始化处理。

4. 更新成功后，重新创建模型服务容器并检查日志，限制客户端流量直到验证完成：

   ```sh
   docker compose up -d --no-deps --force-recreate litellm
   docker compose ps
   docker compose logs --tail 100 litellm
   ```

   此处的 `--no-deps` 依赖前面已成功完成所选更新且基础服务健康，不能跳过前面步骤单独执行。

同一代码、同一环境下仅重启使用 `docker compose restart litellm`。
修改 `.env` 后需重新创建容器；只执行 `restart` 不会应用新环境变量。
Hook 代码复制在镜像中，更新宿主机代码后必须重新构建，不能只重启旧容器。

## 不用初始化脚本时手动更新数据库

适用于**当前 LiteLLM 原生表结构已经就绪，只需要补本目录的活动字段和默认组**的已有数据库。
这条路径不运行 `init`，也不会运行原生版本迁移。手动操作顺序如下：

1. 停止 LiteLLM 服务，备份原库，保留原 `.env`、数据库地址和加密盐。
2. 使用数据库管理工具或 `psql` 连接原库，先查询，再按需要执行下面的增列和建组 SQL。
3. 确认默认组 ID 与 `.env` 的 `LITELLM_DEFAULT_TEAM_ID` 一致。复用已有组时补齐受管标记。
4. 正常启动服务；native 运行 `start.py` 或 `systemctl start litellm`，Docker 用已构建的新镜像
   执行 `docker compose up -d --no-deps --force-recreate litellm`，数据库和 Redis 必须已健康。
5. 在管理页面补齐模型白名单和已有用户的成员关系，通过后文验证后再开放客户端。

SQL 仅使用增加列、插入不存在的组，以及按需合并指定组的 metadata；
不执行 `DROP`、`TRUNCATE`、`DELETE`，不重置用户、模型、Key、用量或已有成员。
如果原生表不存在或原生版本未迁移完成，先完成该版本的迁移，不能用这些 SQL 代替。

### EndUser metadata 列

这里的字段是 `public."LiteLLM_EndUserTable".metadata`，用于活动记录。
它与 Team 上的 `metadata.jwt_managed` 标记是两件事。启用 `activity` 并成功执行 `upgrade.py` 或 `init` 后，
通常无需再手动加列。连接实际使用的 PostgreSQL 数据库执行：

```sql
SELECT table_schema, table_name, column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'LiteLLM_EndUserTable'
  AND column_name = 'metadata';
```

预期有一行，类型为 `jsonb`，允许 NULL。空值不需要手工填 `{}`，也不需要为每个用户预先填活动内容。
如果没有该列，先检查是否关闭了 `activity`、初始化是否成功以及是否连接了同一个库。

没有该列且需要启用活动记录时，在维护窗口执行与 Hook 相同的增列操作；已有行保留，新增列初始为 NULL：

```sql
BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '10s';
ALTER TABLE public."LiteLLM_EndUserTable"
  ADD COLUMN IF NOT EXISTS metadata jsonb;
COMMIT;
```

已有列不是 `jsonb` 时，应先核查旧结构，不要直接删列重建。手动增列不能替代完整的原生迁移和其他 Hook 初始化。

### 默认 Team

把下面的 `standard` 替换为 `.env` 中的实际 `LITELLM_DEFAULT_TEAM_ID`：

```sql
SELECT team_id, team_alias, models, blocked,
       metadata->'jwt_managed' AS jwt_managed,
       metadata->'legacy_clients' AS legacy_clients
FROM public."LiteLLM_TeamTable"
WHERE team_id = 'standard';
```

若不存在，设置非空 `LITELLM_DEFAULT_TEAM_ID` 后执行 `upgrade.py` 即可创建；完整 `init` 也会创建。
选择手动路径时，直接执行以下 SQL 创建默认组，不需要再运行初始化脚本。
把 `standard` 替换为实际默认组 ID；`Default` 是显示名，可自行修改。
重复执行遇到相同 ID 时跳过，不覆盖已有组的模型、预算、成员和 metadata：

```sql
INSERT INTO public."LiteLLM_TeamTable"
  (team_id, team_alias, admins, members, members_with_roles, metadata, models)
VALUES
  ('standard', 'Default', ARRAY[]::text[], ARRAY[]::text[],
   '[]'::jsonb, '{"jwt_managed":true}'::jsonb, ARRAY[]::text[])
ON CONFLICT (team_id) DO NOTHING;
```

如果该 ID 已有组，但缺少 `jwt_managed` 标记，可以在网页保留其他字段并补上
`"jwt_managed": true`；也可以在**停服期间**执行下面的定向更新：

```sql
UPDATE public."LiteLLM_TeamTable"
SET metadata = COALESCE(metadata, '{}'::jsonb) || '{"jwt_managed":true}'::jsonb,
    updated_at = CURRENT_TIMESTAMP
WHERE team_id = 'standard'
  AND jsonb_typeof(COALESCE(metadata, '{}'::jsonb)) = 'object'
  AND COALESCE(metadata->'legacy_clients', 'false'::jsonb) <> 'true'::jsonb
RETURNING team_id, metadata->'jwt_managed' AS jwt_managed;
```

此更新只合并该标记，保留其他 metadata、模型、预算、blocked 状态和成员关系，并跳过 legacy 组。
应返回一行且 `jwt_managed` 为布尔值 `true`；没有返回行时，核对 ID、原 metadata 类型及 legacy 标记，
不要删除旧组重建。正常复用的组还应核对 `blocked=false`；有意封禁的组不应解除封禁。

新建组初始模型列表为空，会拒绝 JWT 调用。启动服务后，在 `/ui` 中完成以下设置：

- 找到实际 team_id 对应的组；网页显示名 `Default` 不能代替 team_id。
- metadata 中有布尔值 `"jwt_managed": true`，不是字符串 `"true"`；同时不能是 `legacy_clients: true` 的旧版兼容组。
- 在保留原有 metadata 其他字段的基础上补标记，不能把原对象整体替换而丢失成员预算等设置。
- 选择明确允许的模型，确认模型已存在且上游凭据可用，核对预算、RPM/TPM 和默认成员策略。
- 正常开放的组应为 `blocked=false`；有意封禁的组保留封禁状态。

**如果旧库中已存在同 ID 的组，初始化会整行跳过。** 即使它没有 `jwt_managed` 或模型为空，
重复执行 `init` 也不会补齐，须按上述 SQL 或在网页修改。也可在网页创建独立的受管组，
将 `.env` 的默认 ID 指向它并应用新配置；更改默认 ID 只影响新用户自动入组，不移动旧用户。

### 已有用户和成员关系

JWT 使用的是内部用户 `LiteLLM_UserTable` 及其 Team 成员关系。
Customer/EndUser 记录是独立的活动和用量主体；存在 EndUser 记录不代表已经具备 Team 权限。

- 数据库中尚不存在的内部用户，在首次通过 JWT 校验时可以自动加入已配置的默认组。
- **数据库中已经存在的内部用户不会自动补组**，无组、移组或撤权状态均保留。
  管理员需要在网页将应获授权的用户加入目标组。
- 每个 JWT 用户必须恰好属于一个非 legacy 的 `jwt_managed` Team，并具有实际成员关系。
  不要只用 SQL 修改用户的 `teams` 数组，否则可能缺少成员记录和成员策略。
- 手动创建内部用户时，user_id 应与 JWT 的 `sub` 和 `X-User-Account` 一致，关闭自动生成 Key。
  不要删除用户再让其自动注册来修复权限，这可能重新授予已撤销的访问权。

分组和成员调整优先使用网页管理，等待授权缓存传播后再验证。

## 旧客户端兼容需要单独处理

只有仍需保留旧客户端调用时才执行此项，普通代码更新无需重新登记旧 Key。
`upgrade.py` 和 `init` 都不会创建 legacy Team，不会登记旧 Key，也不会延长它的期限。

按[旧版客户端兼容步骤](README.md#4-旧版客户端只兼容-30-天)完成：若旧共享值仍是 master key，
先保留加密盐并更换服务端 master key；手动创建独立 legacy Team、设置模型和
`{"legacy_clients": true}`，再运行一次登记脚本。重复登记不会续期，不能在每次重启时重新开始 30 天窗口。
旧活动上报另需摘要令牌和绝对截止时间，不能晚于旧模型 Key 的到期时间。

## 开放客户端前验证

1. 检查 `/health/liveliness` 可达、`/ui` 可登录。健康检查成功只代表进程可用，不能代替以下授权验证。
2. 使用一个应获授权的已有账号，确认只能看到所属 Team 的模型，并完成一次真实模型调用。
   模型请求必须携带合法 `X-User-Account` 和 `X-Cookie`，JWT 的账号必须与账号头一致。
3. 需要自动入组时，使用一个数据库中尚不存在的合法测试账号验证默认组与默认成员策略。
   再验证无组或已撤权的已有账号仍被拒绝，跨组模型、blocked 和预算限额仍受控制。
4. 启用活动记录时，用新版客户端触发启动上报，确认 `/customer/activity` 成功，并查询对应记录：

   ```sql
   SELECT user_id, alias, metadata->'customer_activity' AS activity
   FROM public."LiteLLM_EndUserTable"
   WHERE user_id = 'h00658810';
   ```

   将账号替换为测试账号；活动 metadata 不会由原生 Customer API/UI 自动展示。
5. 仍需旧客户端时，验证旧 Key 可调用且保持原到期时间；检查日志中没有凭据明文。

| 现象 | 优先检查 |
| --- | --- |
| 活动请求提示缺少 metadata 列 | 是否连接原库、是否启用 `activity`、是否成功运行 `upgrade.py`、完整 `init` 或手动增列 |
| `AUTH-2006` | 默认 ID 对应的组不存在、非受管、被禁用或是 legacy 组 |
| `AUTH-2004` | Team 模型白名单为空或无效；初始化创建的空组还没配置模型 |
| `AUTH-2002` / `AUTH-2003` | 已有用户的唯一受管组和实际成员关系；重复初始化不会补组 |
| `REQ-1042` / `REQ-2071` | 客户端账号或 Cookie 请求头缺失、重复或格式不合法 |
| 内网 HTTP JWKS 不可用 | 旧 `.env` 是否补了 HTTP 开关，Docker 容器是否已重新创建，再核对网络与签发参数 |

完整错误码见 [Hook 错误说明](hooks/ERRORS.md)。初始化失败时先修复数据库权限、连接或迁移问题，
保留维护状态，不绕过初始化直接开放服务。需要回退时同时核对代码、依赖或镜像、配置与数据库版本；
原生迁移可能已经改变数据库，不能假定换回旧代码就完成回退，应按已验证的备份恢复方案处理。

## 实现依据

- [增量更新脚本](upgrade.py)：只补缺失的活动列和默认组，提供只读检查，不运行原生迁移。
- [共享初始化入口](start.py)：先原生版本化迁移，再执行 Hook 初始化。
- [默认 Team 初始化](hooks/jwt_auth/__init__.py)：仅插入不存在的组，保留已有配置。
- [活动字段定义](hooks/activity/schema.sql)：可重复执行的 metadata 增列。
- [新用户入组与已有用户授权](hooks/jwt_auth/handler.py)：已有内部用户不自动回填组。
- [native 启动入口](native/start.py)、[systemd 模板](native/litellm.service)和 [Compose 定义](docker/docker-compose.yml)：区分初始化与正常启动。
