# 普通机器部署

需要 Python 3.11/3.12、PostgreSQL 和 Redis，不需要 Docker。部署完整目录，
下面以 Linux 的 `/opt/litellm` 为例。使用专用服务账号运行。
复制范围和必填配置见[公共部署清单](../README.md#复制与首次启动)，不能只复制 `native/` 子目录。

## 安装和配置

```sh
cd /opt/litellm/native
python3 install.py
cp .env.example .env
chmod 600 .env
```

已有配置不要覆盖。填写 `.env` 中的数据库、Redis、管理密钥、稳定加密盐和 JWT 参数。
填写 `UI_USERNAME`、`UI_PASSWORD`，启动后通过 `/ui` 登录管理页面。
它使用 dotenv 格式，不通过 Shell source 加载。复用旧库先备份并保留原盐。

安装脚本创建 `.venv`，安装固定版本依赖并生成 Prisma 客户端；可通过组织配置的软件源安装。
离线环境需预备 Python 包及匹配平台的 Prisma 引擎。数据库和 Redis 由组织提供或独立安装。

已有虚拟环境时，改用该环境的 Python 安装，不创建 `.venv`：

```sh
/data/sjx/envs/litellm/bin/python install.py --existing-env
```

此命令会安装锁定版本依赖，须在停服维护期间执行，不要与其他应用共用环境。
内网预装 Prisma 引擎时，安装前导出 `PRISMA_QUERY_ENGINE_BINARY`、
`PRISMA_SCHEMA_ENGINE_BINARY` 和可选的 `PRISMA_USE_GLOBAL_NODE=true`；
安装程序继承当前环境，不读取 `.env`。启动时在 `.env` 中配置同名变量。
引擎须匹配安装的 Prisma 客户端、操作系统及 OpenSSL，不能仅按旧目录中的版本复用。
不要求公司证书，保留运行环境默认的 TLS 信任配置，不关闭证书校验。

## 初始化和启动

```sh
.venv/bin/python start.py up
```

`up` 先执行 LiteLLM 版本化迁移、初始化 Hook 表结构和默认 Team，成功后才启动服务；失败不会启动。
Linux 也可执行 `bash start.sh up`。已有数据库升级前须停服、备份并安排维护窗口。
日常重启用 `.venv/bin/python start.py` 或 `bash start.sh`，不执行迁移。

使用已有虚拟环境时，将 `.venv/bin/python` 替换为该环境 Python 的绝对路径。
也可先 `export LITELLM_PYTHON=/data/sjx/envs/litellm/bin/python`，再使用 `start.sh`。
不要改用原生 `litellm` 命令启动，否则不会加载统一 Hook 入口。

只有一个 LiteLLM 实例，默认监听 `127.0.0.1:9108`，接入现有 HTTPS 入口即可。
`LITELLM_HOST` 配置监听地址，`LITELLM_PORT` 配置端口，`LITELLM_WORKERS` 配置 worker 数量。
HTTPS 入口位于其他机器时，可监听指定内网地址或 `0.0.0.0`，并用防火墙限制访问来源。
模型、旧 Key、JWT、
管理页面和活动接口共用此实例。在网页为默认组选择模型，之后的分组和成员管理无需重启。
分组和旧 Key 设置见[公共 README](../README.md)。

`MAX_STRING_LENGTH_PROMPT_IN_DB` 示例为 100000，控制写入数据库的 prompt 字符串截断长度，
不是模型上下文或请求大小限制，也不会单独开启正文存储；启用正文存储时需评估隐私、磁盘和写入压力。
`LITELLM_LOCAL_MODEL_COST_MAP=True` 使用随包提供的模型价格表，更新价格需维护部署包。
不要设置 `LITELLM_LOG=ERROR` 来屏蔽校验错误定位所需的 WARNING 日志。

Windows 使用 `py -3.12 install.py` 安装，再运行
`.venv\Scripts\python.exe start.py up`；日常重启省略 `up`。

## 可选 Linux 服务

创建专用的 `litellm` 系统账号，使其拥有部署目录和虚拟环境，核对
`litellm.service` 中的账号及路径。停止前台进程后：
已有虚拟环境需将 `ExecStart` 的 Python 路径改为该环境的绝对路径。

```sh
sudo install -m 644 litellm.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now litellm
sudo systemctl status litellm
```

日志使用 `journalctl -u litellm` 查看。修改配置后重启该服务。
升级前备份数据库、停止服务，安装依赖并运行 `start.py init`，成功后重新启动。
禁止使用 `prisma db push --accept-data-loss`。认证适配固定支持 LiteLLM 1.99.1，
升级版本须先验证认证、数据库和模型请求。
