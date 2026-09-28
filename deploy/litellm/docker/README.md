# Docker 部署

部署完整的 `deploy/litellm` 目录，在本目录执行命令。Compose 只启动一个 LiteLLM 服务，
以及 PostgreSQL、Redis；模型、管理页面和活动接口使用同一端口。
需要 Docker Engine/Desktop 和 Compose v2；复制范围和必填配置见[公共部署清单](../README.md#复制与首次启动)。

1. 复制 `.env.example` 为 `.env`，填写数据库、Redis、JWT、管理密钥及稳定加密盐。
2. 复用旧库时先备份，保留原盐及数据卷名称；配置说明见[公共 README](../README.md)。
3. 构建并初始化，任一步失败时停止操作：

```sh
docker compose config --quiet
docker compose up -d --build
docker compose ps -a
docker compose logs --tail 100 litellm
```

入口为 `http://服务器地址:9108`，端口通过 `LITELLM_PORT` 配置；生产环境接入现有 HTTPS 入口。
项目名通过 `LITELLM_DEPLOYMENT_NAME` 配置，默认 `litellm`；部署后保持不变，以复用数据卷。
在管理页面为初始化生成的默认 Team 设置模型和限额；旧 Key 登记见公共 README。

初始化执行版本化迁移并增加 EndUser metadata 列，正常启动禁用自动 schema 同步。
Compose 等待数据库健康后执行 `init`，成功后才启动 LiteLLM；`init` 显示 `Exited (0)` 为正常完成。
升级既有数据库前先备份并安排维护窗口，不要在旧服务仍处理请求时执行迁移。
管理页面使用 `.env` 中的 `UI_USERNAME`、`UI_PASSWORD` 登录。
禁止使用 `prisma db push --accept-data-loss`。镜像固定为 LiteLLM 1.99.1。

修改 Python Hook 后重新构建镜像；修改环境后执行 `docker compose up -d --force-recreate`。
停止服务使用 `docker compose down`，不要加 `-v`，以免删除数据库和 Redis 数据卷。
