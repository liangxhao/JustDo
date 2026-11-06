# Chrome 扩展兼容性与测试

Chrome、CLI 与通用本机 WebSocket 共用基础 app-server 协议、模型／线程／历史投影、
分页与标准 Item 处理。基础支持范围见[宿主接入要求](../protocol-contract.md)，
本页只列服务端策略与浏览器附加能力。

## 对照依据

字段对照采用本机 `codex-cli 0.166.0-alpha.5.1` 导出的 JSON Schema，导出命令未增加实验开关。
这是具体 alpha 版本的开发验证基线，不代表官方稳定版本或后续版本自动兼容；
官方来源为 [Codex app-server](https://learn.chatgpt.com/docs/app-server)。可使用该基线 CLI 导出开发用定义：

```sh
codex app-server generate-json-schema --out ./schemas
```

生成定义不启动模型任务；这不是客户端运行时下载或对后续版本的兼容承诺。
相同方法使用相同必需字段，不再按 Chrome 客户端名称返回另一套核心 Thread／Turn／Item。
Chrome app-server 发现版本为 3，Native Messaging 版本保持 2；不保留旧私有 wire 名称的静默降级。

## 已统一的基础能力

| 能力                   | 当前行为                                                                                    |
| ---------------------- | ------------------------------------------------------------------------------------------- |
| 初始化、ID、参数与错误 | 相同 Codex 策略；安全整数／字符串 ID、对象参数、initialized、通知 opt-out；无 ID 业务不执行 |
| 模型目录               | 标准 model/list 与公共字段／分页；只使用真实可用目录                                        |
| Thread                 | 同一 wire projector；source 值保留各入口真实来源                                            |
| 创建、恢复、元数据读取 | 相同必需配置与结果；read 不隐式订阅，resume 显式观察                                        |
| 列表、加载、改名       | 公共分页／筛选、真实加载集合、真实标题持久化与标准改名通知                                  |
| 线程状态／卸载通知     | 标准 status/changed／closed；只在真实卸载时通知退订方，旧运行状态不覆盖新运行               |
| 历史 Turn／Item        | 共用原生快照投影与游标；无独立终态证据的浏览器计时行保留 EXECUTION_UNKNOWN                  |
| 发送与停止             | 标准 input／model／threadId／turnId；未适配覆盖项明确拒绝，停止 ACK 返回空结果              |
| 标准实时 Item          | 正文、reasoning、工具生命周期；只采用 Main 精确归属的原生事件                               |
| 结束事件               | Chrome 仍须精确 executionSettled；不从 final、idle 或展示分组补造终态                       |
| 客户端审批             | 标准命令及实验插件确认界面；精确发送 owner、会话命令授权和原生明示的 App 持久选择           |
| 标准图片               | 共享真实字节解析；data URL 图片、纯图片及图文输入，文档仍保留专属字段                       |

## 必须保留的边界

- 入口凭据、Origin／capability 校验和会话来源范围独立；通用协议不意味着跨来源访问。
  发现版本和身份常量见[协议分层](README.md#chrome-发现协议版本与身份常量)，鉴权和浏览器输入范围见[app-server 协议](app-server.md)。
- Chrome 是可断开的观察者，断线不取消工作；通用原生连接仍清理自己拥有的运行。
  这是服务端拥有关系，不能由 clientInfo／capabilities 自行提升。
- 当前标准 Item 无法完整表达组件、待处理输入、问答结构、压缩和原生展示信息；
  这些事实保留在显式 browser 富视图中，不伪装成新的标准 Item。
- 页面上下文、截图／附件、授权图片与 relay 配对继续使用浏览器权限边界。
  不能为接口外形统一而放开任意文件、桌面或 CLI 会话。

## 显式浏览器附加能力

- 标准方法的 `params.browser`：clientTurnId、pageContext、attachments、permissionMode；
  read／resume 的 includeDisplay、turnId，以及 thread/start 的 title。
- 标准 Thread 的 `browser.display` 和 `browser.activeTurn`。
  display 的本地分组只含 id／items，不是标准 Turn，也没有合成 completed／final 状态。
- `browser/composer/options`、`browser/thread/image`、`browser/extension/pair`。
- `browser/thread/stream` 与 `browser/thread/updated`。
- 既有 `browser/webLaunch/*`、Native Host 发现及 connection/* 客户端状态。

富侧栏以增强 reducer／快照作为正文显示的单一来源，不再把标准 Item 第二次追加。
增强流保留稀疏片段、组件与交互信息；核心历史保持认证 Gateway 权威，不建立 Main 正文缓存。

## 尚未完成的适配

当前原生命令和插件审批已有真实界面，标准图片输入也已接入。
原生未提供的独立文件变更审批、策略修订、复杂原生问答、音频、fileId、
账户／配置／MCP 管理及 fork／archive／delete 等仍未实现。
不以空成功结果冒充支持，观察者和新连接也不能继承原审批 owner 或命令授权。

## 兼容性规则

基础 wire 跟随公共 Schema；浏览器附加字段必须留在 browser 命名空间。
扩展版本变化不能提升权限或重发未知输入；标准历史无法完整转换的可见原生类型明确报错。
应用与扩展更新须配套，保留已准入运行的身份、代次、停止与恢复围栏。

## 自动化验证

协议统一及审批／图片适配后的开发核验，对两种 binding 的实际响应和通知执行了 53 项上述
JSON Schema 校验断言，包括 loaded／卸载状态、图文归一化、真实图片字节传递与受管历史图片
`localImage` 引用。该记录验证消息形状和已实现适配，不将标准字段校验视为浏览器获得本机图片
路径输入权限，也不代替真实模型、原生审批和最终安装包验收。

包内 `tests/` 覆盖连接、协议、侧栏交互、网页 SDK 与标准图片输入。集成宿主另行验证 Native Host、身份围栏、SQLite 事务和原生执行。构建测试只在显式提供兼容宿主及依赖时运行；不能在独立源码包中假设应用脚本存在。

## 发布前人工验收

1. 安装最终产品包，确认 Native Messaging 注册表和 manifest 路径有效。
2. 在 Chrome 加载签名匹配固定 extension id 的扩展。
3. 分别验证桌面应用已启动和未启动两种连接路径。
4. 新建会话、继续历史会话、发送消息、停止生成。
5. 分别验证不附带和附带页面上下文。
6. 生成期间关闭/重开 Side Panel，确认重连和历史恢复。
7. 强制 app-server restart，确认客户端重新发现动态 URL。
8. 同时打开多个浏览器窗口，确认线程通知不会串到未订阅连接。
9. 验证浏览器受限页面不会导致发送失败。
10. 卸载或升级应用时检查 Native Host 注册和旧 rendezvous 的清理策略。
11. 开发态运行 宿主的开发启动流程，确认注册表指向 build helper，工具栏点击直接打开对话侧栏。
12. 点击侧栏右上角设置按钮，确认进入 relay 配对 options 页面。
13. 在中文/空格安装路径及无额外网页授权的全新扩展资料中验证侧栏连接；保持公网阻断。
14. 长思考与仅工具运行时验证活动条、独立折叠、手动阅读和返回最新消息；断线或 Stop ACK 不显示完成。
15. 在真实需要审批的运行中验证允许、拒绝、取消和服务端明确提供的会话命令授权；更换连接或会话后不得沿用旧选择。
16. 仅在原生确实提供 App 持久 action 时核对选项及原生权限管理结果，不将夹具中的标签回复当作持久化已验证。
17. 用真实视觉模型验证图文及纯图片，用纯文本模型验证发送前拒绝；文档、页面上下文与网页 SDK 的边界分别核对。

当前隔离 Chromium 离线验证已覆盖组装后的真实侧栏、模型目录、显式恢复、标准 Item 与
增强流并存不重复正文、精确 logical turn 停止及原有动画／阅读交互，页面错误为 0。
该夹具还覆盖命令选择只回一次、服务端给出的 App 选项、Secret 密码输入和撤回后旧按钮不能回复，
以及标准图片／文档扩展字段、图片显示及历史接管不重复。单元测试还覆盖纯附件发送、
未协商或未提供的授权选项、旧 socket／重复请求、超时、Stop 及提交响应返回时的 Secret 焦点保留。
该验证使用本机 HTTP／WebSocket 夹具，不经过 Native Host；本机桥另有真实 C# 定向测试。
这些自动化验证不证明原生授权持久化、真实模型理解图片或最终 Chrome + 已打包 Electron 的整链验收。
