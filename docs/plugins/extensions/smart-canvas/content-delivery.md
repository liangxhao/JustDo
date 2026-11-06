# MCP App 内容与工具

本包提供可视化内容与技能，不注册通用 MCP 服务。下述 MCP App 安装、资源与工具授权是兼容宿主的前提，不是 Smart Canvas 自带的完整 MCP 宿主。

独立分发的 MCP Apps 由各自的插件仓库维护源码、依赖、构建和交付物，不进入主工程
依赖或 Electron 安装包。插件清单静态声明 MCP，经现有扩展导入和原生声明校验安装，
附带 MCP 沿原生配置、审批和父扩展启停流程运行；市场按现有 `extension` 类型分发。
宿主只提供通用发现、消息展示、工作区文件入口及原生 RPC 约定，文件格式解析、
容量限制和编辑存储归外部插件所有，不增加 marketplace kind 或业务 Provider。

本包在 `ui/` 聚合固定组件的 schema、组合器、渲染逻辑、
文案与样式；`document/` 仅保留这些组件复用的 HTML/JSON 安全序列化与资源初始化。
插件通过原生 `registerBoardWidgetContentKind` 注册 `interactive-answer`，发布
`/__smart_canvas__/ui.js`。类型校验 JSON，由原生 `show_widget` 拥有包装、文档和历史。

插件 ID 为 `smart-canvas`，默认开启；配置同步保留用户明确的启停选择。
没有工具调用补参 hook、额外 HTML 页面类型、图片转换或业务联网适配；不新增 agent
tools、MCP/RPC、数据库或 runtime patch。组件单元测试归插件，宿主与打包集成测试归主工程。

按需 `visualize` 技能负责实际可见交付，并复用设计技能已生成的源码：完整 HTML、
交互式 3D 地球、游戏和复杂模拟默认写为托管页面后输出 `[embed ref="…"]`；已有网址
直接 `[embed url="…"]`。小型自包含 HTML/SVG 卡片、本地计算或需要人工确认草稿桥
的控件才选择 `show_widget`。明确的文件交付与真实应用开发保留原目标。技能只随插件
按需加载，不增加每轮提示或修改设计技能。

托管文件通过现有已授权 Gateway 本机 exec 读取非空 `OPENCLAW_STATE_DIR`，写入
`canvas/documents/<fresh-id>/index.html` 与相对资源。外链开关、代理及静态文档认证
由宿主负责；独立网页不继承 Widget 能力或草稿桥。页面资源与普通网络访问由兼容宿主拥有。

`interactive-answer` 提供 table/compare/chart/form/steps，不接受表达式、脚本或外部
提交；多选表单使用原生复选框，保留组级必选与空初值。固定 renderer 的继续按钮只在
当前原生私有 prompt port 可用时启用，由用户确认后加入草稿。搜索、排序、选择和
表单值保留在当前 iframe 内存中，重载恢复默认值；未获得 Dashboard/tools/resources
执行权限。

普通原生 HTML 仍遵循原生 CSP 与资源规则，宿主不增加业务 fetch 下载通道。
完整页面的依赖和静态资源由作者随页提供或使用已配置的可达服务，不在首次展示时安装库。
内容路线见[完整页面](../../../../plugins/extensions/smart-canvas/skills/visualize/references/hosted-html.md)、[原生 HTML](../../../../plugins/extensions/smart-canvas/skills/visualize/references/native-html.md)与[固定组件](../../../../plugins/extensions/smart-canvas/skills/visualize/references/fixed-components.md)。

首次、复用和备用同步及最终分发仍排除未使用的 assets 目录。Smart Canvas 没有运行时
第三方依赖；固定 renderer 从插件源码生成并随入口预编译。

## 宿主集成验证

以下命令相对兼容宿主仓库根目录执行，需要显式准备的锁定原生运行时。
组件单元测试随插件维护；这些 Gateway、Electron viewer 和原生注册边界探针由宿主维护，
不是只安装本插件即可运行的独立测试。以下说明记录探针范围，不表示本次已执行或已经通过。

```text
node scripts/test/smart-canvas/verify-gateway.mjs <runtime-dir>
node scripts/test/smart-canvas/verify-runtime.mjs <runtime-dir>
```

`verify-gateway.mjs` 使用隔离的本地合成 provider，检查真实 Widget 工具、认证文档视图、
history/restart、prompt bridge 和显式关闭插件，结束后清理临时服务与凭据，不使用用户状态。
默认路径覆盖单一 `interactive-answer` 注册的五类组件和多选表单字段，核对公开 renderer、
认证视图、history/restart 及关闭行为，不重写文档。`verify-runtime.mjs` 检查原生 registrar，
包括重复 kind 和重复 resource 拒绝。

| `verify-gateway.mjs` 选项               | 验证范围与限制                                                                                                                                                                                                                                |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--interaction-contract`                | 在隐藏的隔离 Electron 浏览器中核对拒绝隐藏发送字段、同名 inline 文档创建与原生私有 prompt port。需要真实 Chromium activation，程序触发的 prompt 必须失败。fixture 将返回文字另行显式提交，并核对模型输入与历史；bridge resolve 不是模型回执。 |
| `--interaction-contract --presentation` | 使用实际 Lit viewer 和原生 iframe 链，核对固定组件与 HTML 在浅/深主题、840/312px 卡片宽度、实时 viewport resize 下的展示，以及表单多选和真实点击产生可读建议。不能代替真实模型质量或安装版应用/工作区验收。                                   |
| `--retention`                           | 单独执行，在一个合成会话创建 33 个原生文档，核对只保留最新 32 个，同时保留另一个会话。                                                                                                                                                        |
| `--tool-dispatch`                       | 单独执行，在插件关闭时验证原生 Tool Search directory mode。合成模型通过 `tool_call` 调用精确 Core `show_widget` 并提供通用 HTML，核对 dispatcher envelope、认证视图和 history/restart，不发生重复执行。                                       |
