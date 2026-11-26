# 内容交付与宿主集成

Smart Canvas 通过 `visualize` 技能交付可视化内容，复用 Gateway 原生 `show_widget`
与宿主的独立网页展示能力。以下 MCP App 安装、资源与授权规则属于兼容宿主。

独立分发的 MCP Apps 由各自的插件仓库维护源码、依赖、构建和交付物，不进入主工程
依赖或 Electron 安装包。插件清单静态声明 MCP，经现有扩展导入和原生声明校验安装，
附带 MCP 沿原生配置、审批和父扩展启停流程运行；市场按现有 `extension` 类型分发。
宿主只提供通用发现、消息展示、工作区文件入口及原生 RPC 约定，文件格式解析、
容量限制和编辑存储归外部插件所有，不增加 marketplace kind 或业务 Provider。

插件 ID 为 `smart-canvas`，默认开启；配置同步保留用户明确的启停选择。
清单声明 `activation.onStartup: false` 与技能目录。打包交付包含技能和参考文件，
运行时使用内置 `show_widget` 的 HTML 入口。旧 `interactive-answer` 类型的历史记录
可保留，相关卡片需要以 HTML 重新生成才能展示。

按需 `visualize` 技能负责实际可见交付，并复用设计技能已生成的源码：完整 HTML、
交互式 3D 地球、游戏和复杂模拟默认写为托管页面后输出 `[embed ref="…"]`；已有网址
直接 `[embed url="…"]`。小型自包含 HTML/SVG 卡片、本地计算或需要人工确认草稿桥
的控件才选择 `show_widget`。明确的文件交付与真实应用开发保留原目标。技能只随插件
按需加载，不增加每轮提示或修改设计技能。

托管文件通过现有已授权 Gateway 本机 exec 读取非空 `OPENCLAW_STATE_DIR`，写入
`canvas/documents/<fresh-id>/index.html` 与相对资源。外链开关、代理及静态文档认证
由宿主负责；独立网页不继承 Widget 能力或草稿桥。页面资源与普通网络访问由兼容宿主拥有。

原生 HTML 卡片沿用 CSP 和资源限制，用户可通过卡片真实操作产生建议并确认加入草稿。
具体示例见[原生 HTML](../../../../plugins/extensions/smart-canvas/skills/visualize/references/native-html.md)。
完整页面的依赖和静态资源由作者随页提供或使用已配置的可达服务，交付步骤见
[托管 HTML](../../../../plugins/extensions/smart-canvas/skills/visualize/references/hosted-html.md)。

## 宿主集成验证

以下命令在兼容宿主仓库根目录执行，使用已准备的锁定原生运行时随附的 Node。
Gateway 和 Electron viewer 探针由宿主维护。

```text
& "<runtime-dir>/node-runtime/node.exe" scripts/test/smart-canvas/verify-gateway.mjs "<runtime-dir>"
```

`verify-gateway.mjs` 使用隔离的本地合成 provider，检查技能发现时插件入口保持未加载，
并覆盖原生 `show_widget` 的 HTML 卡片调用、认证文档读取和历史恢复。

| `verify-gateway.mjs` 选项               | 验证范围与限制                                                                                                                                                                                                                                |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--interaction-contract`                | 在隐藏的隔离 Electron 浏览器中核对拒绝隐藏发送字段、同名 inline 文档创建与原生私有 prompt port。需要真实 Chromium activation，程序触发的 prompt 必须失败。fixture 将返回文字另行显式提交，并核对模型输入与历史；bridge resolve 不是模型回执。 |
| `--interaction-contract --presentation` | 使用实际 Lit viewer 和原生 iframe 链，核对 HTML 在不同主题和视口尺寸下的展示，以及真实操作产生草稿建议。 |
| `--retention`                           | 单独执行，在一个合成会话创建 33 个原生文档，核对只保留最新 32 个，同时保留另一个会话。                                                                                                                                                        |
| `--tool-dispatch`                       | 单独执行，在插件关闭时验证原生 Tool Search directory mode。合成模型通过 `tool_call` 调用精确 Core `show_widget` 并提供通用 HTML，核对 dispatcher envelope、认证视图和 history/restart，不发生重复执行。                                       |
