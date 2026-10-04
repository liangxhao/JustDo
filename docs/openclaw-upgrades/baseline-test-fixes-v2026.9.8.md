# 9.8 验收中的 17 项既有测试失败修复

日期：2026-10-04。用户要求解决此前升级前已存在的 17 项失败，并明确内置模型 URL 暂时必须为空。本轮不修改 `src/config/builtinModels.ts`，不配置真实模型服务或用户账户。

## 原因与修复

| 失败项 | 数量 | 根因 | 修复与保留的验证 |
| --- | --- | --- | --- |
| builtinModelProvider | 9 | 测试直接使用空的产品 baseUrl，原生业务入口正确地跳过请求，目录与并发断言未触达目标路径 | 测试文件独立 mock 配置；保留默认选择、空目录、失败回退、embedding 分类、用户禁用与并发修改断言；新增空 URL 不请求用例 |
| network 内置连接探测 | 1 | 空 baseUrl 拼成相对 URL，参数验证即拒绝，未执行认证路径 | 使用仅限测试的绝对模拟地址；保留 Main 注入认证／Renderer 不含 JWT 检查；新增空 URL 拒绝且不发送凭据用例 |
| ConversationAgentSelector | 4 | 组件已使用 ThemedSelect，旧测试仍对原生 select 发 change、读 value | 使用真实展开／点击选项行为，仅模拟 jsdom 缺失的布局与 scrollIntoView；保留可用助手过滤、等待交接、已删除助手展示、失败提示与原归属检查 |
| ContextUsageIndicator | 2 | tooltip 已包含说明标签，测试仍精确要求仅有旧数字文案 | 按 tooltip 角色检查完整说明和数值；保留 portal、悬停、键盘焦点、关闭与延迟行为 |
| renderer-motion-styles | 1 | 早期测试禁止整个 Renderer 出现减少动态效果支持，与后来架构中明确的组件级无障碍要求冲突 | 保留当前产品行为，使用 CSS AST 检查减少动态效果规则不能对全局根／通配符覆盖所有动画；允许已明确设计的组件局部样式 |

没有删除失败用例、改成 skip 或降低模型业务断言；没有修改生产业务逻辑。动画规则以当前 `docs/architecture/15-chat-rendering.md` 的侧栏、文件树和运行指示设计，以及 `docs/features/session-diagnostics.md` 的无障碍要求为依据。先前全局禁止规则来自 2026-08-29 的早期提交，已不适用于这些后续局部设计。

## 本地假模型验证

新增测试辅助 `tests/fixtures/localModelServer.ts`，只监听 `127.0.0.1` 随机端口，提供 `/v1/models`、`/v1/model/info`、`/v1/chat/completions` 三个合成端点。两条集成用例通过真实 HTTP 分别验证：

1. 模型目录与 metadata 读取、chat/embedding 分类、Main 凭据发送、保存配置不包含凭据。
2. IPC 连接探测的规范化请求、Main 认证头注入、假模型返回正文、Renderer 响应不含 JWT。

服务和账户信息全部为合成测试数据，`finally` 关闭监听与连接，不调用付费或外部模型。不修改磁盘生产配置；测试模块 mock 每次重置，空 URL 本身继续是受支持的未配置状态。Electron 的网络入口在该用例中映射到 Node fetch，因此证明的是 IPC／认证与真实回环 HTTP 链路，不冒充完整 Chromium 网络栈或真实服务端 JWT 签名验证。

## 验证

五个原失败文件的定向测试：**5 文件、46 项全部通过**，其中新增 4 项。日志 `.tmp/baseline-fix-focused.log`。

最终 `npm test -- --maxWorkers=4 --reporter=dot`：**652 文件通过、3 文件跳过；6622 项通过、46 项跳过、0 失败**，总计 655 文件／6668 项，耗时 158.54 秒。原有 17 项全部转为通过，跳过数量没有增加。日志 `.tmp/baseline-fix-full-tests.log`。

`npm run build`、`npm run lint`、`git diff --check` 通过。日志 `.tmp/baseline-fix-build.log`、`.tmp/baseline-fix-lint.log`。全量测试 wrapper 已恢复并核验 Electron ABI 146。本轮没有生产逻辑变化，因此没有重复运行上一轮真实 Electron/Gateway 页面及生命周期测试。
