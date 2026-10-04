# v2026.9.8 浏览器、插件与 ACP 最终主机验证

验证日期：2026-10-04。执行环境为 Windows、Node 24 与主机已安装的 Chromium 149.0.7827.55。此轮专门补测浏览器扩展配对协议、独立 conversation overlay、内嵌浏览器桥接、插件管理及 ACP 适配；没有切换 SQLite ABI，没有操作真实账户，也没有注册或修改浏览器 native host。

## 结果

本轮没有发现新的产品代码回归。以下三组检查均通过，覆盖范围不同，不应将 mock、真实浏览器执行与完整产品端到端验证混为一谈。

| 检查                          | 执行方式                                                                                                               | 结果                       |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| 本仓库浏览器、插件及 ACP 回归 | Vitest；明确排除两个直接依赖 SQLite 的测试文件                                                                         | 96 文件、931 项通过        |
| 随包原生浏览器模块            | 将上游 9.8 的 8 个测试文件复制至隔离目录，执行对象使用本软件 `resources/browser-extension/openclaw/modules` 的 JS 文件 | 8 文件、213 项通过         |
| Chromium 中的认证与侧栏交互   | 临时生成扩展资源，隔离 Chromium context，纯 loopback HTTP/WebSocket 测试服务                                           | 全部通过；页面运行错误为 0 |

本地执行记录：`.tmp/browser-host-regression.log`、`.tmp/browser-native-host-tests.log`、`.tmp/browser-chromium-host-smoke.log`。这些临时日志不作为用户数据或运行时构建证明提交。

## 实际 Chromium 执行

新增可复跑的离线脚本：`tests/browser-extension/chromium-offline-smoke.cjs`。传入已安装的 `playwright-core` 目录即可运行；脚本不会下载浏览器或安装依赖。本次使用：

```powershell
node tests/browser-extension/chromium-offline-smoke.cjs ../openclaw/node_modules/playwright-core
```

脚本先用现有打包器在临时目录生成真正的产品扩展资源，再通过仅绑定 `127.0.0.1` 的测试服务器加载。Chromium 以隔离 context 运行，页面网络请求限制在测试 origin；结束关闭浏览器、HTTP/WebSocket 服务并删除临时资源。它没有加载真实用户浏览器 profile。

原生 relay v2 模块在 Chromium 内使用真实 WebCrypto，按上游固定合成向量执行 hello、server proof 验证、client proof 生成及 accept proof 验证。另行验证错误服务端证明、资源绑定错误、超长有效期和未知字段均被拒绝，失败实例不能再次参与握手；含重复键的认证 JSON 被拒绝。这不是只搜索源码字符串或使用替代加密实现。

独立 overlay 加载实际生成的 HTML、CSS、ESM 与 `AppServerClient`，连接真实本地 WebSocket fixture。实际点击和输入验证了：

- 会话列表选择与既有问题展示。
- 输入并发送一条消息，服务端收到一次 `turn/start` 和准确的合成文本。
- 接收流式 thinking，自动展开，再由用户点击折叠；后续 thinking 更新保留人工折叠选择。
- 接收并展示流式回答。
- 点击停止，服务端收到一次 `turn/interrupt`，按钮恢复发送状态。

Chrome runtime/windows 等扩展 API 在该页面中由 fixture 提供；模型服务也是本地合成响应，没有模型调用。这验证生成资源的浏览器执行、真实 DOM 操作及 WebSocket 序列，不等同于安装 MV3 扩展后完成 native messaging 配对。脚本输出也明确记录 `nativeHost: not exercised`。

## 原生协议、权限和生命周期回归

从 `../openclaw/extensions/browser/chrome-extension/modules` 读取当前 9.8 原生测试，放在 `.tmp/browser-native-host-tests`，被测 JS 来自本软件随包快照。8 组为：

- `relay-auth-v2`：证明向量、严格消息形状、时间／绑定约束及失败状态。
- `relay-core`：连接与地址等基础行为。
- `relay-command-handler`：原生命令分发与受控行为。
- `native-bootstrap`：浏览器 bootstrap 消息契约和错误处理。
- `tab-access`：标签授权策略。
- `tab-access-events`、`tab-access-events.navigation`：标签变化与导航生命周期中的权限更新。
- `tab-document-provenance`：标签文档身份边界。

以上 213 项使用上游测试自己的 Chrome API mock。它们补充真实 Chromium 小型交互检查，不能证明操作系统 native host 已正确安装。

## 本仓库回归范围

运行的 96 个文件包括扩展打包与 dev host、overlay 状态和 DOM、Main 浏览器动作／文件／快照／下载／页面预览／native messaging／聊天服务、安全和请求状态、技能审核与导入、MCP、Hook、扩展安装／秘密文件／动态重载、市场，以及 Renderer 浏览器、插件和浏览器设置页面。

ACP 覆盖 `tests/openclaw/acpx`、原生插件契约、命令 token、动态 MCP 测试，包含此前升级修复的 `stateDir/acpx` 默认目录及显式目录覆盖。没有启动已登录 Codex／Claude 或执行付费推理。

本轮明确排除 `browserHistoryStorage.test.ts` 和 `mcpStore.test.ts`，不改变原生模块 ABI。它们的历史测试结果不能被本轮 931 项统计替代。内嵌浏览器的 Electron API 由既有单元测试替身提供；没有在此轮声称完成真实 WebContents 界面端到端操作。

新增脚本的 ESLint、Prettier 检查通过；Chromium 脚本在最终格式修正后再次成功执行。

## 仍需实际产品环境验证的边界

上游 `bootstrap.chromium.test.ts` 明确将完整 extension bootstrap E2E 限定为 Linux/macOS，本机 Windows 不满足该运行条件。本轮没有绕过该限制写入真实浏览器注册项。

以下仍需在最终安装包或开发应用中用专用浏览器 profile 执行，不能把以上自动检查当作已完成：

1. 安装生成的 MV3 扩展、native messaging 配对、断线重连与浏览器重启恢复。
2. 通过实际浏览器操作验证所有标签／指定标签授权和移出授权组后的撤销。
3. Electron 内嵌浏览器的真实导航、上传、下载、录制和人工接管界面。
4. 经用户授权后对外部代理账号、MCP OAuth 和外部插件服务进行连接检查。
