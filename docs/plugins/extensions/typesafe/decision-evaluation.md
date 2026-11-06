# TypeSafe 决策评估合同

本包为 OpenClaw 原生决策 API 提供 Boolean、Choice 和 Score 评估，不生成聊天回复。原生 `decision_evaluate` 依据有效 `decisionModel` 选择 provider；何时评估由对话模型或原生消费者决定，不自动建立业务流程。模型选择不下载或启动服务。

## 服务配置

兼容性、能力与配置 schema 以 [package.json](../../../../plugins/extensions/typesafe/package.json) 和 [openclaw.plugin.json](../../../../plugins/extensions/typesafe/openclaw.plugin.json) 为准；来源及本地改动见 [UPSTREAM.md](../../../../plugins/extensions/typesafe/UPSTREAM.md)。注册保持延迟加载，不注册替代原生决策工具或独立模型选择机制。

- `serviceUrl` 是显式 HTTP(S) API 基址，可包含 `/v1` 等路径前缀；不得含 URL 用户名／密码、query 或 fragment。服务须实现 System One，插件在基址后请求 `/systemone`，仅兼容聊天补全接口不足以使用。
- `apiKey` 使用 manifest 声明的结构化 SecretRef，由原生预先准备。`serviceUrl` 路径发送 Bearer 认证；宿主负责受限存储、SecretRef 发布、轮换及原生刷新，不把密钥放进提示词或普通日志。
- 旧本地 Kev 模式使用 `baseUrl`，仅接受 loopback origin（例如 `http://127.0.0.1:8009`），不得带路径、凭据、query 或 fragment；请求 `/v1/systemone`，不发送 hosted key。服务和 checkpoint 必须事先就绪。
- `baseUrl` 与 `serviceUrl` 互斥。`timeoutMs` 为 1000–60000 的整数，默认 30000；详细模型能力和问题数量上限以 manifest 为准。

请求只访问显式端点，可使用内网服务；不跟随重定向、不读取环境代理、不回退公共服务，不因模型选择自动部署服务。评估会把请求证据发送给所选服务，费用和数据处理由部署方及服务约定。

## 原生工具、权限与错误

`decision_evaluate` 接受 Boolean、Choice 和 Score 问题。TypeSafe 按 manifest 声明能力、延迟加载 evaluator；当前工具和模型选择由原生拥有，不迁移旧插件专用模型、不改名旧工具政策，也不恢复未发布的兼容实现。

原生最终调用准入贯穿延迟加载与 HTTP 准备。TypeSafe 在 guarded fetch 准备前，以及 DNS/transport 准备结束、实际派发前重新核验；任一步撤权都返回不可用，不发送或重试请求。认证内网 `serviceUrl` 和旧 loopback 端点遵循相同检查。

| 响应                                    | 原生分类                        | 限制                                                          |
| --------------------------------------- | ------------------------------- | ------------------------------------------------------------- |
| HTTP 400 / 413 / 422 且属于不支持的输入 | unavailable / unsupported-input | 可进入原生决策 fallback，不重试本次 transport，不暴露响应正文 |
| HTTP 401 / 403                          | 认证错误                        | 不伪装为可切换 provider 的输入限制                            |
| HTTP 429                                | 限流                            | 保留 retryAfter 元数据                                        |

显式工具 deny、插件禁用与本地／sandbox 会话政策继续有效；决策输出不扩大权限。宿主负责在不改变既有工具策略含义的前提下准入原生工具。

响应先通过原生 schema 校验，再做凭据反射检查。答案标签、评分图例和准确所选模型可以合法回显，短 key 与这些值或数字结果重叠不会误拒绝；意外 provider 模型名包含凭据仍拒绝，错误正文不返回模型。

## 打包与状态单例

上游来源由 [UPSTREAM.md](../../../../plugins/extensions/typesafe/UPSTREAM.md) 锁定。宿主的 local-extension 流水线安装锁定生产依赖、针对宿主 SDK 预编译并保留许可证，不依赖未来发布的 npm 包。

Gateway bundle 与动态插件必须解析到同一组原生 `secret-input-runtime` ESM 状态所有者，包含 prepared secrets、配置快照/准备作用域、环境发布、auth revision/ownership/read cache、不可用 owner 和错误类。将这些模块分别内联会产生空凭据快照、失效错误缓存或破坏 `instanceof` 分类；不能靠修改原生凭据算法或能力检查补救。构建从锁定 pristine 包重建并保留这些外部模块。

## 验证与交付边界

包内 `src/*.test.ts` 覆盖配置／端点、认证失败不回退、原生 schema、取消、响应清理、凭据反射、初始准入拒绝及延迟加载／DNS 准备期间撤权。测试需要集成工作区提供匹配的 OpenClaw SDK、Vitest 和隔离的原生准备凭据环境；包内测试不读取用户凭据或调用真实托管服务。

宿主集成必须额外验证打包 Gateway 与动态插件共享上述状态所有者：用隔离原生实例和本地合成 System One 服务，经真实工具调用验证轮换、不可用 owner 拒绝及恢复，并检测模块内联造成的状态分裂。构建脚本和该集成探针由宿主提供，不是本包运行时依赖。

合成测试不能代表真实托管验收；真实 key 必须经操作者明确授权，合成 key 不得发往公共端点。当前实现不下载模型、不部署服务，也不把决策结果变成执行授权。
