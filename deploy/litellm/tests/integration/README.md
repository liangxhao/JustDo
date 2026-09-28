# 本地认证联调

仅用于测试，不作为生产登录服务。测试账号、数据库、RSA 私钥和模型均独立于正式部署，不读取或修改桌面客户端登录文件。

在本目录执行（Python 3.11+、Docker Compose）：

```sh
python setup.py
docker compose up -d --build
docker compose wait bootstrap
docker compose ps -a
python ../smoke_auth.py
python ../header_guard_live.py
```

`setup.py` 只运行一次，生成本地凭据和配置，拒绝覆盖已有文件。后续只需 `docker compose up -d --build`；运行测试前用 `docker compose wait bootstrap` 等待初始化完成，退出码非零时停止并查看 bootstrap 日志。需使用支持 `wait` 的 Compose v2。请先停止其他占用 9108、9110 的服务。

- 管理页面：`http://localhost:9108/ui`，登录信息在 `.env`。
- 换证：`POST http://localhost:9110/api/litellm/mtoken2jwt`；请求包含 `mtoken`、`deviceId`，可选 `clientIp`。
- JWKS：`http://localhost:9110/.well-known/jwks.json`；RS256 JWT 有效期 300 秒。
- 测试登录数据：`state/login.json`。服务端只保存 mtoken 的 SHA256。
- Virtual Key：`state/development-api-key.txt`，限定 `standard` Team 的 `auth-test-model`，有效期 30 天，重复启动不续期。

初始化服务 `init` 和 `bootstrap` 显示 `Exited (0)` 表示完成。bootstrap 只为首次配置的空默认组添加模拟模型；已有策略不覆盖。数据库与 `state/` 必须一起保留，不要删除初始化标记以重新授权。

模型固定返回测试文本，不连接真实上游。测试脚本通过有效 JWT、Virtual Key 分别验证合法请求及请求头缺失、格式错误、重复，共 30 项检查，不打印凭据。可使用 `--model-url https://模型入口` 验证已有 HTTPS 反向代理。
`smoke_auth.py` 另外验证换证、无效 mtoken、篡改 JWT、模型列表及两种凭据的模型调用。

容器端口仅绑定回环。桌面客户端需要非回环模型入口及匹配的请求头白名单，可接入现有 Tailscale Serve；不要放宽客户端回环限制。客户端仍在 `src/config/builtinModelAuth.ts` 中切换开发认证模式，API Key 模式可配置本地 Key 文件路径。

临时签发服务不连接 Jalor、不验证设备真实性，不具备生产级限流或 mtoken 生命周期管理。生产环境使用真实登录服务。JWT 容器与 LiteLLM 共用网络命名空间，以回环读取 JWKS，不放宽 HTTPS 校验。

停止使用 `docker compose down`，不加 `-v`。分享文件时不要包含 `.env`、`state/`、`users.json` 或私钥数据卷。
