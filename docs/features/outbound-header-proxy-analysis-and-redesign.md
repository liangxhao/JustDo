# Outbound Header Proxy 问题分析与重构建议

## 文档目的

本文汇总当前 `OutboundHeaderProxy` 的需求边界、已知现象、代码分析、并发风险、候选根因、推荐架构、实施步骤和验收标准，供后续会话直接作为实现上下文使用。

本文同时记录分析与实施状态。核心作用域隔离、Gateway 环境快照、本地代理 capability、
非候选 HTTPS raw tunnel、证书初始化并发修复、Main fetch 解耦、loopback bypass 恢复和
关闭顺序修复已实施；更完整的 PAC 多候选、SOCKS、配置热重载和客户端能力矩阵仍是后续
增强项，不属于本次已完成代码的能力声明。

## 代码复核结论

再次对照当前实现后，原方案方向基本正确，但必须修正以下结论和边界：

1. 代理数据面只包括 OpenClaw Gateway 及其启动的 tool/子进程网络请求。Electron Renderer 和 Electron Main 不应被 Outbound Header Proxy 全局改写；确定性的 Main 标题生成请求是唯一例外，它在调用点按白名单显式注入 Header，但不经过本地 MITM。
2. 选择性 MITM 只能在 CONNECT 时按 origin（hostname + port）决定是否解密，不能按 path 决定。只要某个 origin 存在任一白名单 path，该 origin 上的其他 path 也会被本地解密，只是不得注入 Header。原文中“非白名单 HTTPS 绝不解密”的表述过强。
3. `GatewayNetworkEnvironment` 正好是本功能需要的作用域：代理和 CA 环境只进入 Gateway generation，不写入 Electron Main 的全局 `process.env`。当前 Main `fetch` monkey patch 和 Electron `webRequest` 注入应删除。
4. 当前已有多项确定性缺陷，不能只围绕 `http-mitm-proxy` 的 semaphore 猜测并发根因：退出顺序错误、上游 resolver 注入失效、策略 reload 没有生产入口、全局 Main/Renderer 注入越界，均应纳入修复。
5. 上游代理不是单个 `UpstreamRoute` 就能完整表达。PAC 返回的是有顺序的候选计划，`DIRECT` 也是显式候选；固定代理失败时禁止静默直连，但 PAC 明确给出的 `DIRECT` fallback 可以执行。
6. 仅靠 `HTTP_PROXY`/`HTTPS_PROXY` 无法同时保证“未知子进程的白名单请求一定经过本地代理”和“该子进程的其他请求完全不经过本地代理”。选择性 raw tunnel 只是不解密普通 HTTPS，普通流量仍经过本地进程和 socket 转发。若要求物理绕过，只能对可控客户端使用显式 per-origin transport，或使用各客户端都能正确执行的 PAC；后者对 curl/Python/Node 并不通用。

## 已确认的需求

本功能服务于 OpenClaw 中模型自主调用 tool 时产生的远程 HTTP/HTTPS 访问，包括：

- Gateway 进程内执行的网络工具请求。
- OpenClaw 启动的 `curl`、Python、Node.js 等 tool 子进程请求。
- OpenClaw 插件、MCP 或 skill 在 Gateway 进程树内发起、且符合受支持客户端约束的网络请求。

以下请求明确不属于自定义 Header 注入范围：

- Electron Renderer/Chromium 的普通页面和应用请求。
- Electron Main 的配置同步、更新检查等普通请求。
- 不在 OpenClaw Gateway 进程树中的其他进程请求。

Gateway 自身访问模型 provider、插件仓库或其他基础服务时可能因为 proxy env 而经过本地代理，但只要 URL 不匹配白名单就绝不能注入校验 Header。当前代理无法仅凭 HTTP 请求判断它是“tool 调用”还是“Gateway 内部请求”，所以真正的注入边界由“Gateway 进程树 + URL 白名单”共同定义。

本组件负责把校验 Header 安全地附加到受保护目标的请求上；最终权限判定必须由远端服务完成，并拒绝缺失或无效 Header 的请求。本组件不是通用防火墙，也不能阻止 tool 使用不遵循 proxy env 的客户端访问普通互联网。

命中配置白名单的请求必须携带一组共享的自定义校验 Header。所有请求使用相同 Header 值，不需要请求级或任务级 Header 隔离。

该功能与 LiteLLM 无关，LiteLLM 不需要这些自定义 Header，也不应成为解决方案的注入点。

还需要满足以下约束：

- 未命中白名单的请求绝不能携带校验 Header。
- 并发请求必须全部可靠注入，不能出现三次请求只有一次携带 Header。
- 普通请求的开始或结束不得修改、删除或恢复全局代理环境变量。
- 系统代理、自定义代理、直连模式和 Outbound Header Proxy 必须可以组合。
- Header 值、代理认证信息和 CA 私钥不得写入日志。

这里的 tool 子进程应理解为受支持客户端集合，而不是对任意网络程序的无条件保证。验收前必须建立客户端能力矩阵，至少记录其是否遵循 proxy env、`NO_PROXY`、CA env、CONNECT 和重定向语义。客户端显式绕过代理时，本地代理无法强制注入。

Header 名称不强制要求 `X-` 前缀；只需满足合法 HTTP field name 语法。为保持配置示例清晰，本文和生成的配置说明统一使用 `X-User-Account`、`X-Cookie` 这类以 `X-` 开头的名称，但这只是示例约定，不是运行时限制。

## 最终方案摘要

本次重构按以下闭环实现，不把某个局部补丁当作完成：

1. Outbound Header Proxy 只为 OpenClaw Gateway generation 启动；策略未启用或白名单为空时不启动。
2. 不修改 Electron Main 的全局 proxy/CA env，不 patch Main `fetch`，不注册 Electron Header listener。
3. Proxy ready 后构造一次不可变 Gateway env snapshot，再 spawn Gateway；配置变化创建新 generation 并受控 restart。
4. Gateway env 携带当前 generation 的随机 local proxy capability；未认证的本地客户端不能使用代理。
5. CONNECT 建立后先根据首个 tunnel 数据包区分明文 HTTP 与 TLS，再按对应协议匹配候选 origin；非候选请求只做 raw tunnel，候选 HTTP 进入明文解析，候选 HTTPS 才 MITM，解析后再按完整 URL/path 决定是否注入。
6. 修复/替换 `http-mitm-proxy` 的证书初始化 single-flight，保证首次同 origin 并发请求共享同一个初始化结果。
7. 每个请求使用独立 request context、headers 和 upstream plan；业务 Header snapshot 在一个 generation 内只读。
8. 保留普通 loopback 和用户 bypass；Gateway env-proxy 模式忽略 loopback 白名单并脱敏告警，不能因这类配置阻塞应用启动，也不能再为 LiteLLM 删除全局 loopback bypass。
9. 先停止新任务并 drain/cancel 请求，再停止 Gateway 及子进程，最后关闭 proxy、socket 和证书 server。
10. 用真实 HTTPS echo server、三并发/百并发、受支持 tool 子进程和系统/自定义上游代理完成端到端验收。

这套方案能保证：Main/Renderer 不受代理数据面或全局注入影响；唯一的 Main 标题请求在调用点按白名单显式注入；受支持的 OpenClaw tool 请求命中白名单时可靠注入；非候选 HTTPS 不被本地解密。它不能保证主动禁用代理或使用不受支持协议的 tool 客户端也被强制注入，远端服务仍必须拒绝缺少校验 Header 的请求。

## 已观察到的生产现象

用户同时发起三个均应命中规则的请求，服务端只观察到一个请求携带自定义 Header。期间没有发生：

- 配置切换。
- Gateway 重启。
- 代理重启。
- 用户主动执行的其他生命周期操作。

因此，不能把该现象解释为用户切换代理配置时短暂删除了 `HTTP_PROXY` 或 `HTTPS_PROXY`。

## 当前实现概览

主要文件：

- `src/main/core/outboundHeaderProxy.ts`
- `src/main/core/outboundHeaderPolicyConfig.ts`
- `src/main/core/systemProxy.ts`
- `src/main/core/systemProxyPreference.ts`
- `src/main/core/trustedCertificates.ts`
- `src/main/openclaw/runtime/openclawEngineManager.ts`
- `src/main/main.ts`

当前实现同时承担多项职责：

1. 从磁盘读取 URL 白名单和 Header 值。
2. 启动基于 `http-mitm-proxy@1.1.0` 的本地 MITM 代理。
3. 为 HTTPS 动态生成证书。
4. 修改 Main 进程的全局代理和 CA 环境变量。
5. 让 OpenClaw/Gateway 继承这些环境变量。
6. 修改 Main 进程的全局 `fetch`。
7. 注册 Electron `webRequest.onBeforeSendHeaders`。
8. 解析并串联系统或自定义上游代理。
9. 管理 Gateway localhost bypass。
10. 修改全局 console 行为以过滤 MITM 库日志。

当前网络路径大致如下：

```text
OpenClaw / curl / Python / Node
        |
        | HTTP_PROXY / HTTPS_PROXY
        v
OutboundHeaderProxy (localhost MITM)
        |
        | direct / system proxy / custom proxy
        v
Remote URL
```

当策略启用且白名单非空时，`applyOutboundProxyEnv()` 会把整个进程环境中的大小写 `HTTP_PROXY` 和 `HTTPS_PROXY` 都指向本地代理，同时设置 `NODE_USE_ENV_PROXY` 和多种 CA 环境变量。

白名单当前只决定是否注入 Header，并不决定请求是否进入本地代理。因此，代理环境中的所有 HTTP/HTTPS 流量都会先到本地代理。

## 已经排除的错误假设

### 普通请求结束时不会删除代理环境变量

`proxy.onRequest()` 的普通请求路径只执行：

- 解析 URL。
- 解析上游代理。
- 判断白名单。
- 修改本次请求自己的 `proxyToServerRequestOptions.headers`。
- 调用 callback 继续发送。

该路径没有调用：

- `applyOutboundProxyEnv()`。
- `restoreOutboundProxyEnv()`。
- `applySystemProxyEnv()`。
- `restoreOriginalProxyEnv()`。

因此，不存在“请求 1 注入完成后删除 `PROXY` 环境变量，使并发请求 2 绕过代理”的普通请求级行为。

环境变量只会在以下生命周期发生修改：

- Outbound Header Proxy 启动。
- 代理 bypass 重新应用。
- 系统/自定义/直连代理偏好变化。
- 应用退出、代理停止。

### 共享 Header 对象不是当前主要并发嫌疑

三个请求使用相同 Header 值。`applyOutboundHeaders()` 修改的是每个请求自己的 headers 对象；Electron 路径和 `fetch` wrapper 也会创建新的 headers 对象。

只要某个请求确实执行到 `applyOutboundHeaders()`，当前代码会为它写入 Header。代码中没有“只注入一次”的计数器或消费型状态。

所以“三个请求只有一个携带 Header”更可能表示：

- 代理只看到了一个请求。
- 代理看到了三个请求，但只有一个 URL 匹配规则。
- 三个请求都注入了，但后续重定向或上游链路移除了两个请求的 Header。
- MITM 连接或证书并发初始化发生异常。

## 当前设计的结构性问题

### 1. 影响范围远大于业务范围

业务目标是给少数白名单请求加 Header，但实现会把整个 OpenClaw 进程树的 HTTP/HTTPS 流量送入本地代理。

GitHub、npm、pip、MCP、普通网页、局域网服务和其他工具流量都会受到本地代理可用性、证书和协议兼容性的影响。

### 2. 所有 HTTPS 流量都可能被 MITM

当前 `http-mitm-proxy` 会为 HTTPS CONNECT 创建内部 HTTPS server。即使请求最终不命中 Header 白名单，TLS 也可能已经在本地终止。

这会引入：

- 自签 CA 信任问题。
- 企业 CA 和 CA 轮换问题。
- certificate pinning 不兼容。
- mTLS 不兼容。
- HTTP/2、HTTP/3、QUIC、WebSocket 和特殊 CONNECT 的兼容风险。
- 不同语言或 native 网络库使用不同证书库的问题。

### 3. 全局 `process.env` 是共享可变状态

`systemProxy.ts` 和 `outboundHeaderProxy.ts` 都管理：

- `HTTP_PROXY` / `http_proxy`。
- `HTTPS_PROXY` / `https_proxy`。
- `NO_PROXY` / `no_proxy`。

Outbound Header Proxy 还管理：

- `NODE_USE_ENV_PROXY`。
- `NODE_OPTIONS`。
- `NODE_EXTRA_CA_CERTS`。
- `REQUESTS_CA_BUNDLE`。
- `CURL_CA_BUNDLE`。
- `SSL_CERT_FILE`。
- `PIP_CERT`。

当前正确性依赖“先应用系统代理，再用本地 Header Proxy 覆盖进程代理”的调用顺序。普通并发请求不会修改这些变量，但以下生命周期仍可能竞争：

- Gateway spawn。
- 代理偏好异步应用。
- Gateway restart。
- 应用 shutdown。
- 后续新增的网络初始化代码。

环境变量还是逐项更新的，并非真正的原子事务。

### 4. 环境变量对已运行子进程不会动态生效

Gateway 和它的子进程在创建时复制环境。之后修改 Electron Main 的 `process.env` 不会改变已运行 Gateway 的环境。

真正敏感的窗口不是两个普通请求同时读取 `process.env`，而是 Gateway 恰好在代理环境处于过渡状态时 spawn。

### 5. 上游代理组合复杂且不完整

当前代码要在本地 MITM 内再次解析系统或自定义上游代理，存在以下限制：

- HTTPS、HTTP 上游代理路径采用不同手工逻辑。
- SOCKS 上游代理不完整或直接跳过。
- PAC 多候选和 DIRECT fallback 处理有限。
- IPv6、NTLM/Kerberos、系统集成认证等场景风险较高。
- 自定义代理凭据从 Electron `proxyRules` 中移除，但项目中未发现对应 proxy login handler。

### 6. Electron 代理切换没有关闭旧连接（相邻问题）

`systemProxyPreference.ts` 调用 `session.defaultSession.setProxy()` 后没有调用 `closeAllConnections()`。Electron 官方文档提示，代理切换后可能需要关闭连接，否则连接池会继续复用旧代理路径。

参考：<https://www.electronjs.org/docs/latest/api/session#sessetproxyconfig>

该问题属于系统代理功能本身，不属于 OpenClaw Header 注入的核心验收范围。若同一改动涉及 Electron 代理切换，可一并修复；否则单独跟踪，避免扩大本次重构。

### 7. Electron `webRequest` listener 超出功能边界

本功能不需要处理 Renderer 请求，应直接移除 `registerElectronHeaderInjection()`。此外，Electron 官方说明同一 `webRequest` 事件只有最后附加的 listener 生效；当前默认 session 全量 listener 也存在覆盖其他功能的风险。

参考：<https://www.electronjs.org/docs/latest/api/web-request/>

### 8. Main 全局 `fetch` monkey patch 超出功能边界

`registerGlobalFetchInjection()` 替换 `globalThis.fetch`，会修改并非由 OpenClaw tool 发起的 Main 请求。它应被移除。Main 若需要遵循系统/自定义代理，应使用独立的普通网络 transport，但不得复用 Header 注入策略。

### 9. `OutboundHeaderProxy.fetch()` 混入了无关的 Main 网络职责

当前 `OutboundHeaderProxy.fetch()` 被 Main 用于受控请求，同时内部 `fetchWithProxy()`：

- 只接受 string 和 typed-array body。
- 缓冲完整响应，不能正确保留流式语义。
- 自己创建并销毁 agent，连接复用有限。
- 没有完整复刻 Fetch 的 redirect、Request 和 body 行为。

它不适合作为通用网络层，也不应继续属于 Outbound Header Proxy。调用方如仍需系统/自定义代理能力，应迁移到不注入 Header 的 Main transport；这项迁移只为解除错误耦合，不把 Main 纳入本功能。

### 10. 使用了第三方库私有 API和全局 console patch

当前实现 monkey patch `http-mitm-proxy` 的 `_onError`、`_onSocketError`，并临时替换全局 `console.debug`、`console.error`。

这些私有行为容易随依赖版本变化，也可能吞掉无关模块的日志。

### 11. Header 名称说明与实际需求不一致

`outboundHeaderPolicyConfig.ts` 的说明声称 Header 名必须以 `X-` 开头，但实际需求是不强制该前缀，代码也只校验通用 HTTP field name 语法。

应把配置说明改成：示例和推荐命名以 `X-` 开头，但运行时允许注入任意语法合法的 Header 名。当前阶段不增加额外 allowlist、denylist 或 `X-` 强制校验；保留现有非法名称和非法值校验，避免 Node/Electron 网络栈因格式错误崩溃。

### 12. 策略“reload”目前没有生产调用入口

`updateOutboundHeaderUserInfoCache()` 的注释称运行中的代理会使用刷新后的策略和值，但当前生产代码只在 `OutboundHeaderProxy` 构造时调用一次，项目中没有配置文件监听、IPC reload 或其他生产调用点。

因此，运行时修改 `config.json` 或 `user_info.json` 不会自动生效；即使未来补上 reload，启用状态、白名单或 CA/代理需求变化还必须触发受控的 proxy/Gateway generation 切换，不能只替换缓存对象。

### 13. 构造函数的上游 resolver 没有用于代理请求路径

`OutboundHeaderProxy` 保存了 `this.resolveUpstreamProxy`，但 `proxy.onRequest()` 调用的 `applyUpstreamProxyForRequest()` 又直接使用模块级 `resolveConfiguredUpstreamProxy()`。注入 resolver 目前只影响 `OutboundHeaderProxy.fetch()`，不影响 MITM 代理的真实上游路由。

这会造成测试替身与生产路径不一致，也阻碍把上游路由做成 request snapshot。应把 resolver 显式传入代理请求路径，并为 direct、fixed、PAC candidates 分别做集成测试。

### 14. 当前退出顺序会先切断代理，再停止依赖它的 Gateway

`runAppCleanup()` 当前先调用 `outboundHeaderProxy.stop()`，之后才停止 Cowork sessions 和 Gateway。这与本文的并发不变量相反，可能让仍在结束中的请求命中已关闭端口。

正确顺序应为：停止接受新任务，drain/cancel Cowork 请求，停止 Gateway 及其后代，最后关闭本地代理并释放证书 server/socket。还应验证 `proxy.close()` 是否真正等待活动连接结束，不能把同步调用视为 drain 完成。

### 15. 策略说明仍残留与 LiteLLM 绑定的旧假设

需求已经确认该功能与 LiteLLM 无关。`outboundHeaderPolicyConfig.ts` 及生成的 `config.README.md` 中“请求经过 LiteLLM，因此 Header 必须以 `X-` 开头”的内容应删除，改为“示例和推荐名称以 `X-` 开头，但不强制”。

### 16. 本地代理没有调用方认证

当前本地代理只依赖 loopback 绑定，没有验证请求是否来自当前 Gateway generation。本机其他进程如果发现代理端口，也可以把它当作 HTTP proxy 使用；访问白名单目标时，代理会替它注入同一组业务校验 Header。这与“只服务 OpenClaw tool”的范围不一致。

每次 Gateway 启动应生成高熵、短生命周期的本地代理 capability，并通过该 generation 的 proxy URL/专用 env 交给 Gateway。代理必须在处理 HTTP 请求或 CONNECT 前验证 capability：

- 认证失败时返回 `407 Proxy Authentication Required`，不得连接目标。
- 本地 `Proxy-Authorization` 只用于 Gateway -> local proxy 这一跳，验证后立即剥离。
- 串联上游代理时，应单独生成 upstream `Proxy-Authorization`，两者不能复用或混淆。
- capability、带凭据的 proxy URL 和业务 Header 值都不得写日志。
- Gateway 停止后 capability 立即失效；新 generation 使用新值。

这不能抵御同一用户权限下能够读取 Gateway 环境或内存的恶意本机进程，但能避免其他普通进程偶然或直接复用一个无认证的注入代理。

### 17. 当前 `NO_PROXY` 策略会把普通 loopback 流量强制送入代理

`configureOutboundProxyBypass()` 会从 baseline 中移除 `*`、`localhost`、`127.0.0.1` 和 `::1`。代码注释说明这是为了让 LiteLLM 等本地服务也经过 MITM，但 LiteLLM 已明确不属于本功能。

这会让 Gateway 访问本地 MCP、开发服务和其他 loopback endpoint 时也依赖 Outbound Header Proxy，是“影响正常网络访问”的一个确定性来源。新 env builder 应：

- 默认保留用户原有 `NO_PROXY` 语义，并确保普通 loopback 地址直连。
- 始终精确 bypass Gateway 自己的监听地址，防止代理回环。
- 传统 `NO_PROXY` 无法可靠表达“同一 loopback host 仅 portA 走代理、portB 直连”的排除项反转，因此 Gateway env-proxy 模式忽略 loopback 白名单并给出脱敏警告，但不能阻塞应用启动。
- 如果未来确实需要保护本地 endpoint，应使用不命中 loopback bypass 的专用 hostname，或为该客户端提供显式 per-origin transport；不得通过删除整个 loopback bypass 来实现。

## “三次并发只有一次注入”的根因树

当前没有足够的成功路径日志，尚不能唯一确定根因。应按下面顺序验证。

### A. 只有一个请求实际经过本地代理

可能原因：

- 不同调用方对 `HTTP_PROXY`/`HTTPS_PROXY` 支持不一致。
- Node 库使用显式 dispatcher/agent，忽略环境代理。
- Python 客户端关闭 `trust_env`。
- 子进程显式构造了不包含代理变量的 env。
- `NO_PROXY` 命中部分目标。
- 请求使用不受传统 HTTP proxy 控制的网络栈或协议。

如果本地代理只记录到一个请求，这一类原因优先级最高。

### B. 代理看到三个请求，但只有一个匹配白名单

可能原因：

- 最终 protocol、hostname 或 port 不同。
- path prefix 配置没有 trailing slash，或实际 path 与预期不同。
- 请求经过重定向、服务发现或不同 endpoint。
- URL 构造时 Host header、IPv6 authority 或默认端口处理不一致。

### C. 三个请求都注入，Header 在后续链路丢失

可能原因：

- 跨 origin 重定向时客户端移除敏感 Header。
- 上游代理过滤自定义 Header。
- 目标前置网关只允许特定 Header。
- 最终服务观察的不是代理注入的那一跳。

### D. `http-mitm-proxy@1.1.0` 的首次 HTTPS 并发初始化竞态

依赖库在首次访问某个 HTTPS hostname 时使用 `sslSemaphores` 防止重复创建证书和内部 HTTPS server，但当前实现存在明显可疑顺序：

```ts
getHttpsServer(hostname, (err, port) => {
  process.nextTick(sem.leave.bind(sem));
  // ...
  return makeConnection(port);
});
delete self.sslSemaphores[wildcardHost];
```

`delete` 在异步 `getHttpsServer()` 完成前执行。第二、第三个冷启动并发 CONNECT 可能观察不到第一个 semaphore，然后重复创建 semaphore、证书或 HTTPS server。

对应依赖源码位置：

- `node_modules/http-mitm-proxy/lib/proxy.ts` 约 660-687 行。

这是具体的高风险并发缺陷，但尚未通过本项目的 HTTPS 并发集成测试证明它就是生产现象的唯一根因。不能只凭代码阅读直接下结论。

### E. 错误日志过滤掩盖了关键信息

当前实现会忽略部分 `ECONNRESET`、`EPIPE` 等错误，并 patch console 输出。这些错误可能只是正常断连，也可能与并发连接初始化失败相关。过度过滤会让“请求没有进入注入路径”的证据消失。

## 当前测试缺口

现有 `src/main/core/outboundHeaderProxy.test.ts` 主要覆盖：

- URL 匹配。
- Header 值读取和安全校验。
- 单个 headers 对象修改。
- 环境变量设置和恢复。
- 单次显式 HTTP proxy fetch。
- 错误日志过滤。

它没有覆盖真实的：

- HTTPS CONNECT。
- 动态证书生成。
- 同一 hostname 冷启动并发。
- keep-alive 连接复用。
- 重定向。
- 上游系统/自定义代理串联。
- curl、Python、Node 子进程继承后的端到端行为。

因此现有单元测试通过不能证明生产并发路径可靠。

## 推荐目标架构

对于“无法控制任意 curl/Python/Node 调用代码，但要修改 HTTPS Header”的需求，某种代理和 TLS interception 无法完全避免。HTTPS Header 位于加密层内；如果既不修改客户端，又不终止 TLS，就无法通用修改 Header。

推荐保留代理能力，但把它重构为“Gateway 子进程专属、白名单选择性 MITM”的窄作用域组件。

这里的“窄作用域”是进程作用域和 TLS 解密作用域变窄，并不表示 Gateway 后代的所有非白名单流量都能绕过本地 socket。使用传统 proxy env 的客户端，其非候选 HTTPS 仍通过本地代理做透明 raw tunnel。该残余故障面必须通过极简 tunnel 路径、超时、backpressure、连接 drain 和压力测试控制，并在产品能力说明中明确。

```text
OpenClaw Gateway and descendants
  -> immutable Gateway env snapshot
  -> authenticated local selective proxy
       -> candidate HTTPS origin: MITM, then path match and inject
       -> non-candidate HTTPS origin: raw TCP tunnel
       -> HTTP request: match and inject or forward unchanged
  -> optional upstream system/custom proxy

Electron Renderer and Main
  -> never use Outbound Header Proxy for Header injection
  -> retain their normal direct/system/custom proxy behavior
```

### 目标组件拆分

#### `OutboundHeaderPolicy`

- 读取和校验配置。
- 规范化 protocol、hostname、port 和 path。
- 提供纯函数 `matches(url)`。
- 返回不可变的共享 Header snapshot。
- 不处理网络、不修改环境变量。

#### `SelectiveOutboundProxy`

- 只监听 `127.0.0.1`。
- 收到 CONNECT 时先解析并规范化 hostname 和 port，并在 tunnel 建立后嗅探首个数据包以区分明文 HTTP 与 TLS。
- 对应协议的 origin 不属于任何拦截候选规则时只建立原始 TCP tunnel；非候选 TLS 不在本地终止。
- HTTP 候选进入明文请求解析，HTTPS 候选才进行 MITM；path 是否匹配只能在解析后判断。
- CONNECT 内层明文 HTTP 继承外层已验证的 Gateway capability，不要求或转发第二份代理认证 Header。
- 解密后再次按完整 URL/path 判断是否注入。
- 校验 CONNECT authority、TLS SNI、解密后的 Host/`:authority` 一致性；不一致时 fail closed，绝不把 Header 发往意外 origin。
- Header snapshot 只读；每个请求修改独立 headers。
- 不修改 `process.env`。

#### `GatewayNetworkEnvironment`

- 根据基础环境、代理模式、本地 proxy URL、CA bundle 和 bypass 一次性生成完整 env snapshot。
- 只把 snapshot 传给 Gateway spawn。
- 不修改 Electron Main 的全局 `process.env`。
- 配置变化时生成新 snapshot，并通过受控 Gateway restart 生效。

#### `GatewayProxyCapability`

- 每个 Gateway generation 生成独立随机 capability。
- 只存在于内存和该 generation 的 env snapshot，不落盘。
- local proxy 在 CONNECT/HTTP 转发前验证并消费本地代理认证 Header。
- 与上游代理凭据完全分离，任何情况下都不发送给目标服务。

#### 移除越界入口

- 删除 `registerGlobalFetchInjection()`，不再 monkey patch Main 的 `globalThis.fetch`。
- 删除 `registerElectronHeaderInjection()`，不再注册默认 session 的 Header listener。
- 将 Main 对 `OutboundHeaderProxy.fetch()` 的调用迁移到普通网络 transport；标题调用点在发送前显式执行白名单匹配和 Header 构造。
- `OutboundHeaderProxy` 对外不再提供 Main fetch 能力，只管理 Gateway 专属代理生命周期、policy 和 env snapshot。

## 并发设计要求

因为所有业务请求共享同一组校验 Header，不需要请求级业务 token 或独立端口。另有一个仅用于限制本地代理调用方的 generation-level capability；它通过 local `Proxy-Authorization` 表达，但不是业务 Header，也不区分同一 Gateway generation 内的不同请求。

仍然必须满足以下并发不变量：

1. 普通请求路径永远不修改代理环境。
2. Header 配置更新采用不可变 snapshot，不能原地修改共享对象。
3. 每个请求修改自己的 headers 对象。
4. 同一 hostname 的证书生成必须使用正确的 single-flight。
5. single-flight entry 不能在仍有 waiter 时删除；当前对 `http-mitm-proxy` 的兼容补丁在代理生命周期内保留 wildcard semaphore，避免 sibling hostname waiter 与新 semaphore 并存。
6. 并发请求不能共享可变的 request URL、request headers 或 upstream options。
7. 代理配置版本变化不能影响已经开始的请求。
8. 代理停止前先停止或 drain 所有依赖它的 Gateway/子进程。
9. 同一请求的 policy、Header 值和 upstream plan 必须来自同一 generation snapshot。
10. Header 名只做标准 HTTP field name/value 语法校验；`X-` 是配置文档中的示例和推荐前缀，不是强制条件。
11. 每个进入注入/tunnel 路径的请求必须先通过当前 Gateway generation 的本地代理 capability 校验。
12. local 和 upstream 两跳的 `Proxy-Authorization` 分开处理，均不得泄漏到目标请求。

正确的证书初始化应类似：

```text
hostname -> Promise<SSLServer>

Request 1 -> 创建 Promise
Request 2 -> await 同一个 Promise
Request 3 -> await 同一个 Promise
所有 waiter 完成后再删除，或在代理生命周期内保留轻量 semaphore
```

不建议继续依赖当前依赖库中提前删除 semaphore 的逻辑。

## 选择性 MITM 规则

### 非拦截候选 origin 的 HTTPS

```text
CONNECT other.example.com:443
  -> resolve upstream route
  -> raw CONNECT/TCP tunnel
  -> do not generate certificate
  -> do not inspect HTTP
  -> do not inject Header
```

### 存在白名单规则的 HTTPS origin

```text
CONNECT api.example.com:443
  -> verify origin is eligible for interception
  -> get/create cached certificate with single-flight
  -> terminate TLS locally
  -> verify CONNECT authority / SNI / Host consistency
  -> parse full request URL
  -> match protocol + hostname + port + path
  -> inject shared Header into this request only
  -> forward through direct/system/custom upstream route
```

### 白名单 HTTP

HTTP 请求不需要 TLS MITM，可以直接解析 absolute-form/origin-form URL，匹配后注入。

同一 origin 上未命中白名单 path 的请求仍会经过本地 TLS 终止，但不得注入 Header。这是 path 级策略与 CONNECT 级选择性 MITM 之间无法消除的边界；如果不能接受，应把配置粒度限制为 origin，或为不同 path 使用不同 hostname。

### CONNECT 无法解析时

应默认不注入，并返回明确错误或安全地拒绝。不能因为解析失败而对未知目标进行宽泛 MITM。

## 环境变量重构

### 当前方式

```text
mutate process.env
  -> restore upstream proxy env
  -> apply upstream proxy env
  -> overwrite with local Header proxy env
  -> later restore again
```

### 推荐方式

```ts
const gatewayEnv = buildGatewayNetworkEnvironment({
  baseEnv: process.env,
  proxyMode,
  outboundHeaderProxyInfo,
  gatewayBypass,
  caBundlePath,
});

spawnGateway({ env: gatewayEnv });
```

要求：

- `buildGatewayNetworkEnvironment()` 是纯函数。
- 返回新对象，不修改输入。
- 一次性计算大小写 proxy 变量、NO_PROXY 和 CA 变量。
- 保留普通 loopback/用户 bypass；白名单与既有 bypass 冲突时应显式报告。只有能被目标客户端准确表达的远程规则才能做最小化冲突消解。
- Gateway generation N 从启动到退出始终持有同一 snapshot。
- 配置更新生成 generation N+1，不修改 N。
- Proxy 必须 ready 后才能创建引用它的 snapshot。

## 上游代理处理建议

Header 注入和上游路由应解耦。统一定义：

```ts
type UpstreamRoute =
  | { kind: 'direct' }
  | { kind: 'http-proxy'; url: URL }
  | { kind: 'https-proxy'; url: URL }
  | { kind: 'socks-proxy'; url: URL };

type UpstreamPlan = readonly UpstreamRoute[];
```

要求：

- HTTP、HTTPS CONNECT 和 MITM 后的请求共享同一 resolver。
- 明确支持或明确拒绝 SOCKS，不能静默直连。
- 上游 proxy auth 只发送给代理，绝不能发送给目标服务。
- PAC 多候选保留顺序并逐个尝试；`DIRECT` 只有在 PAC 明确返回时才是授权 fallback。
- fixed/custom proxy 失败时默认 fail closed，不得擅自直连泄漏请求。
- IPv6 authority 使用 `[host]:port` 格式。
- 上游 CONNECT response 设置最大 Header 大小和超时。
- 所有 socket 都有 connect、idle 和 shutdown timeout。

## 可观测性方案

当前缺少成功路径日志，无法定位 1/3 注入问题。建议增加结构化、脱敏日志。

每个请求至少记录：

```text
request_seen
  requestId
  method
  sanitizedOrigin
  sanitizedPathOrPathHash
  isTls
  connectionId

policy_evaluated
  requestId
  matched
  matchedRuleId

headers_injected
  requestId
  headerNames

upstream_route_selected
  requestId
  routeKind

request_completed
  requestId
  status
  durationMs
```

禁止记录：

- Header 值。
- 完整 cookie/token。
- 带认证信息的代理 URL。
- CA private key。
- 可能含敏感 query 的完整 URL。

对 HTTPS CONNECT 还应记录：

- `connect_seen`。
- `connect_intercepted` 或 `connect_tunneled`。
- `certificate_cache_hit`。
- `certificate_generation_started/completed/failed`。
- single-flight waiters 数量。

利用这些日志判断：

| 观测结果                                | 结论                              |
| --------------------------------------- | --------------------------------- |
| 只出现一次 `request_seen`               | 两个请求绕过代理或未成功进入 MITM |
| 三次 `request_seen`，只有一次 matched   | URL、port、path 或 redirect 问题  |
| 三次 `headers_injected`，服务端只有一次 | Header 在后续跳被移除             |
| 冷启动出现重复证书生成                  | 证书 single-flight 竞态           |
| 第一次并发异常，证书缓存后正常          | 强烈指向 HTTPS 初始化竞态         |

## 测试计划

### Policy 单元测试

- protocol、hostname、显式/默认 port 精确匹配。
- path prefix 边界。
- IPv4、IPv6、大小写 hostname。
- malformed URL 和 malformed CONNECT authority。
- 非白名单永不注入。
- 已存在同名 Header 时的覆盖策略。
- 空值 Header 是否应跳过，需明确产品语义。
- `X-Trace-Id` 等示例名称可用。
- 不以 `X-` 开头、但符合 HTTP field name 语法的配置名称同样可用。
- 非法 field name 和包含控制字符的值被拒绝。

### Header 并发单元测试

- 对同一不可变 Header snapshot 并发处理至少 100 个独立 headers 对象。
- 100 个结果全部包含相同 Header。
- 原始输入对象之间没有引用或值污染。

### HTTPS MITM 集成测试

- 新 hostname 首次并发 3 次，服务端必须收到 3 次 Header。
- 新 hostname 首次并发 20 次，只允许生成一次证书/server。
- 证书缓存后并发 100 次，全部注入。
- 同一 keep-alive 连接上的多个请求全部注入。
- 多个并发 CONNECT 全部正确映射 request context。
- 代理 error handler 不吞掉测试所需错误。

### 选择性 MITM 集成测试

- 白名单 HTTPS 被 MITM 并注入。
- 不属于任何候选 origin 的 HTTPS 只 tunnel，本地代理不替换远端证书链。
- 不属于任何候选 origin 的请求不触发证书生成。
- 白名单 hostname、非白名单 path 被 MITM 但不注入。
- CONNECT authority、SNI 与 Host 不一致时拒绝注入并安全失败。
- malformed CONNECT 被安全拒绝。

### Redirect 测试

- 同 origin redirect 后仍匹配时重新注入。
- redirect 到非白名单 origin 时不携带 Header。
- redirect 到另一个白名单 origin 时按新规则注入。
- 不依赖客户端保留跨 origin 自定义 Header。

### 子进程端到端测试

分别通过 Gateway 环境 snapshot 启动：

- curl。
- Python `requests`。
- Python `httpx`。
- Node.js `fetch`。
- Node.js `http`/`https`。

每种客户端验证：

- 白名单请求注入。
- 非白名单请求不注入。
- 三个冷启动并发请求全部注入。
- NO_PROXY 行为符合预期。
- CA 信任正确。

同时维护能力矩阵：客户端显式禁用 env proxy、使用 certificate pinning/mTLS、或使用 QUIC/HTTP/3 时，测试必须得到明确的“不支持/绕过被检测”结果，不能计入可靠注入承诺。

### 系统/自定义代理组合测试

- direct -> local selective proxy -> target。
- local selective proxy -> HTTP upstream proxy -> target。
- local selective proxy -> HTTPS upstream proxy -> target。
- 有认证和无认证上游代理。
- upstream CONNECT 非 200。
- timeout、reset 和 proxy restart。

### 生命周期竞态测试

- Proxy ready 前不得 spawn Gateway。
- Gateway 构建 env 时配置更新，不产生半更新 snapshot。
- Gateway restart 时旧 generation 请求可完成或明确取消。
- shutdown 与正在进行的 proxy preference apply 不会重新写回环境。
- stop 后没有仍引用已关闭 proxy port 的子进程。

### 作用域隔离测试

- Proxy 启动、停止和 reload 都不修改 Electron Main 的 `process.env`。
- Main 的 `globalThis.fetch` 不被替换。
- 本功能不注册 Electron `webRequest` Header listener。
- 只有传给 Gateway spawn 的 env snapshot 包含本地 proxy 和 CA 设置。
- Renderer 和 Main 普通请求即使访问白名单 URL 也不会注入；Main 标题请求命中时会显式注入。
- Gateway/tool 对同一白名单 URL 发起请求时正常注入。
- 普通 localhost/127.0.0.1/::1 服务保持直连，不经过本地 MITM。
- Gateway env-proxy 模式下配置 loopback 白名单会被忽略并告警，不会阻塞启动或删除整个 loopback bypass。
- 不带或携带错误 local proxy capability 的请求得到 407，目标服务 0 次收到请求。
- 正确 capability 可以并发复用，但只在对应 Gateway generation 生命周期内有效。
- local proxy capability、upstream proxy password 和业务 Header 值均不会出现在日志或目标请求中。

## 验收标准

### 正确性

- 同一白名单 HTTPS URL 冷启动并发 100 次，100 次全部携带 Header。
- 重复运行至少 100 轮，无漏注入。
- 非白名单请求 0 次携带 Header。
- 非候选 origin 的 HTTPS 0 次触发 MITM 证书生成。
- 候选 origin 下未匹配 path 的请求允许被本地解密，但 0 次注入 Header。
- redirect 行为符合每一跳重新匹配规则。

### 稳定性

- 并发测试无未处理 promise rejection、socket leak 或 MaxListeners warning。
- 代理切换和 Gateway restart 后不存在旧连接池复用错误。
- 代理 shutdown 可在限定时间内完成。
- 上游代理不可用时返回明确错误，不静默直连。

### 安全性

- 日志不出现 Header 值、token、cookie、proxy password。
- CA private key 仅存放在受限目录。
- 代理只绑定 loopback。
- 非候选 origin 的请求不会被本地代理解密。
- CONNECT authority、SNI、Host/`:authority` 不一致时不会注入 Header。
- `Proxy-Authorization` 不会转发到目标服务。
- 未通过 Gateway generation capability 验证的本地代理客户端无法触发 Header 注入或 tunnel。

## 建议实施顺序

### 阶段 1：先定位 1/3 漏注入

1. 增加脱敏成功路径日志和 request ID。
2. 增加真实 HTTPS 冷启动并发集成测试。
3. 分别验证代理是否看到三个请求、是否匹配三个、是否注入三个。
4. 验证 `http-mitm-proxy` semaphore 提前删除问题。
5. 在根因确认前，不要用修改环境变量顺序掩盖现象。
6. 记录三次请求的调用方/进程、CONNECT 数量、最终 URL 和 redirect hop；“服务端收到三次但仅一次有 Header”与“只完成了一次请求”必须分开统计。

### 阶段 2：先完成进程作用域隔离

1. 新增纯函数 `buildGatewayNetworkEnvironment()`，Gateway spawn 使用不可变 env snapshot。
2. 停止修改 Main 全局 proxy/CA env，移除 Main global `fetch` monkey patch 和 Electron Header listener。
3. 将现有 Main `OutboundHeaderProxy.fetch()` 调用迁移到普通系统/自定义代理 transport；仅标题调用点按白名单显式注入校验 Header。
4. 为每个 Gateway generation 生成并验证 local proxy capability，严格分离 local/upstream proxy auth。
5. 重做 `NO_PROXY` 计算，恢复普通 loopback 和用户 bypass；loopback 白名单忽略并告警，不能阻塞启动。
6. 修正 shutdown 顺序，确保先停止任务和 Gateway/子进程，再关闭代理。

### 阶段 3：修复代理数据面和并发

1. 实现非候选 origin 的 CONNECT 原始 tunnel。
2. 只对至少存在一条白名单规则的 HTTPS origin 启用 MITM。
3. 修复或替换证书/server single-flight，并让冷启动三并发/百并发测试稳定通过。
4. 修复 resolver 未接入真实代理路径的问题，用不可变 ordered upstream plan 处理 direct/fixed/PAC。
5. 完善 connect、idle、request、shutdown timeout、backpressure、socket cleanup 和错误传播。
6. 确保 local/upstream `Proxy-Authorization` 以及业务 Header 都只出现在正确的一跳。

### 阶段 4：配置生命周期与收尾

1. 用 lifecycle generation 管理 proxy、policy snapshot、Gateway restart 和旧请求 drain。
2. 增加显式 reload API 或文件监听，定义哪些变更只换 policy snapshot、哪些必须创建新 generation。
3. 从 `OutboundHeaderProxy` 删除 Main fetch 职责，只保留 Gateway 代理能力。
4. 更新配置说明：示例名称以 `X-` 开头，但不做前缀强制，并移除 LiteLLM 相关说明。
5. 更新相关架构、安全和 OpenClaw 生命周期文档。
6. 完成作用域隔离、子进程、上游代理、重定向、并发和 shutdown 全套验收后再发布；不得只发布 semaphore 补丁。

### 阶段 5：评估代理实现

短期可以修补或封装现有 `http-mitm-proxy`，但必须覆盖其证书并发缺陷。中期应评估：

- vendor 并维护一个经过测试的最小选择性代理实现。
- 使用成熟的外部 sidecar，例如 mitmproxy/mitmdump addon。
- 采用其他明确支持 HTTP/1.1、HTTP/2、WebSocket、并发证书缓存和上游代理的库。

替换代理实现只能改善稳定性和协议支持，不能消除 HTTPS MITM 对 CA 信任的天然要求。

## 当前工作区注意事项

选择性 CONNECT tunnel 已在本次实现：代理会区分 CONNECT 内的明文 HTTP 与 TLS；非候选
请求走 raw tunnel，候选 HTTP 进入明文解析，候选 HTTPS 才进入 MITM。后续修改应以当前
实现和集成测试为基线，不再假设 CONNECT 必然承载 HTTPS，也不再按旧的“所有 HTTPS 都
MITM”路径设计。

后续会话开始时仍须执行 `git status` 和 `git diff`，以实际工作区状态为准；保留所有用户修改，不要处理无关的未跟踪文件 `my.png`。

## 后续会话开始前需要确认的信息

为精确复现“三次只有一次注入”，最好补充：

- 三个请求是否为完全相同的 URL、method 和 redirect 策略。
- 三个请求是否来自同一个 curl/Python/Node 进程。
- 是否为该 hostname 启动后的首次访问。
- 三个请求的服务端状态码和最终 URL。
- 再次执行相同并发请求时是否仍为 1/3，还是只在第一次发生。
- 本地主日志、Gateway 日志和 OpenClaw native JSON 日志中对应时间、run id、session id。

即使暂时缺少这些信息，也可以先通过本地 HTTPS echo server 编写确定性的冷启动并发集成测试。

## 可直接用于新会话的任务描述

```text
请阅读 docs/features/outbound-header-proxy-analysis-and-redesign.md，先执行 git status 和 git diff 检查当前工作区，然后诊断并修复 OutboundHeaderProxy 的并发漏注入问题。

已确认需求：代理数据面只处理 OpenClaw Gateway 进程树内由模型自主调用 tool 产生的网络请求，包括 Gateway 内工具以及其启动的 curl、Python、Node.js、插件、MCP、skill 请求。Electron Renderer 和 Main 不做全局注入；确定性的 Main 标题生成请求作为唯一例外，在调用点按白名单显式构造 Header。所有命中 URL 白名单的受支持 tool 请求共享同一组 Header；配置示例使用以 X- 开头的名称，但运行时不强制 X- 前缀；该功能与 LiteLLM 无关。生产现象是三个同时发起且都应命中的请求只有一个携带 Header，期间没有任何配置切换或重启。

先增加真实 HTTPS 冷启动并发集成测试和脱敏请求路径诊断，确认请求是在代理前绕过、policy match 阶段丢失、MITM 初始化失败，还是注入后被移除。特别检查 http-mitm-proxy@1.1.0 的 sslSemaphores 提前删除竞态。

修复时优先实现 Gateway generation 专属的不可变代理环境，以及非候选 origin CONNECT 原始 tunnel、候选 origin 选择性 MITM。注意 raw tunnel 仍会让 Gateway 进程树的非候选流量经过本地 socket，不能宣称这些流量完全绕过代理。删除 Main global fetch monkey patch 和 Electron webRequest 注入，确保本功能不再修改 Main/Renderer 请求。同步修复 shutdown 顺序、真实代理路径未使用注入 resolver、策略 reload 生命周期和证书 single-flight。恢复普通 loopback NO_PROXY，env-proxy 模式忽略 loopback 白名单并告警，但不得阻塞启动。为每个 Gateway generation 生成 local proxy capability，验证后剥离，并与 upstream proxy auth 分开。Header 名保留通用 HTTP 语法校验，不增加 X- 强制或额外 allowlist。不要覆盖现有未提交修改，不要记录 Header 值、capability 或其他 secret。完成后运行相关单元/集成测试、lint 和 build，并更新相关架构文档。
```
