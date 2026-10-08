# Chrome 扩展侧栏对话

侧栏对话已接入产品会话、模型/权限选择、附件、页面上下文和停止。本文说明当前 JustDo 行为，不再以其他产品某个已安装版本的静态观察作为功能承诺。逐字段规范见[扩展 API](../browser-extension-api/README.md)。

## 1. 用户入口与范围

工具栏按钮打开 Side Panel，对话区可新建或继续桌面会话。输入区提供文字、附件、权限、模型和发送/停止；设置入口打开扩展 options，那里继续管理 OpenClaw relay 配对与 Tab 授权。

扩展图标复用应用图标。设置页独立于上游 relay 基线，固定使用英文，分为 Automatic connection、Manual connection、Tab Access 和 Background color；界面品牌由产品元数据注入。颜色选择自动保存并同步到设置页和已打开的侧栏。

两条连接独立：自动化 relay 控制已授权网页，聊天 app-server 管理产品会话。自动发现聊天服务不等于已配对自动化；重新配对 relay 也不能修复 Native host 发现失败。

Automatic connection 通过同一个产品 Native host 发现 app-server，再经独立的 `browser/extension/pair` 方法取得锁定运行时生成的本地 Gateway 配对信息。它复用发现与鉴权，不调用聊天 Controller，也不新建线程或发送消息。配对仍由上游原生状态机应用，Disconnect 可撤销迟到结果，手动配对不能被自动结果覆盖。

## 2. 建连和生命周期

```mermaid
sequenceDiagram
  participant Panel as Side Panel
  participant BG as Background
  participant Host as Native helper
  participant Main as Main app-server
  participant G as Gateway
  Panel->>BG: ensure
  BG->>Host: hello / ensure
  Host->>Host: 读取 rendezvous 或启动桌面
  Host-->>Panel: localAppServerUrl
  Panel->>Main: WS initialize / initialized
  Panel->>Main: thread/read 或 turn/start
  Main->>G: 产品准备与原生执行
  G-->>Main: 流事件 / 原生历史
  Main-->>Panel: thread/stream / turn/completed
```

Native helper 只负责 framing、发现和启动，Electron GUI 不直接承担 Chrome stdin/stdout。app-server 每次启动随机 loopback 端口和 capability；退出清理发现信息，客户端重连重新取得地址，不能长期缓存旧 URL。

## 3. 当前协议子集

初始化后支持 thread/list/read/start/unsubscribe、composer/options、turn/start/interrupt；通知包括 thread/started/updated/stream 与 turn/started/completed。采用 request/result/error 和 notification 形态，但不宣称实现其他产品全部私有 API。

Main 复用 Cowork 身份、权限、模型和原生历史。流直接转发原生生成事件，历史轮询只用于快照校准和终态确认；扩展本身不建立另一份持久 transcript。

新建产品会话可能尚未创建原生会话或 transcript，此时 `chat.history` 合法返回不带游标的空页，甚至没有 `sessionId`。Main 再次读取并确认空页和身份未变化后返回空历史，不发布正文快照；读取失败、非空但缺少身份/游标、待处理输入不完整时仍报错，不能当作新会话。已有历史的完整页使用顶层 `sessionId`，增量页使用 `sessionInfo.sessionId`；分页、回执和最终确认均校验同一物理身份。

首条输入已接收但尚未创建 transcript 时，正式历史也没有游标，`pendingInputs` 可以非空。Main 在同一物理会话内读取待处理分页并用不带游标的 `inputRunIds` 请求核对回执，确认正式历史仍为空、每个待处理页的身份、状态及可见性未变化后返回临时投影。取消或撤回旧页输入也可能不改变总数，不能只确认第一页。若期间输入已消费、状态改变或正式历史出现，则重新读取完整快照；待处理正文仍不进入 Main 历史快照。

## 4. 页面上下文的明确授权

用户显式勾选并授权读取时，在发送时采集当前页标题、URL、选中文字及有界可见正文。当前是最多 24000 字符的快照，不是模型稍后按需读取整页的工具通道。

Main 将上下文放入仅限认证本地客户端的 justdoUntrustedContext，原生只加入本轮 Agent 输入；持久用户消息保留原始文字，不需 Renderer 用正则隐藏注入前缀。网页可含 prompt injection，不能将其当用户命令。

关闭开关就不采集。切换会话清除未发送附件，防止跨任务误发；页面自身导航后旧快照不能被当作当前页面实时事实。

## 5. 模型、权限与附件

composer/options 读取真实配置模型目录，已保存会话/助手模型仅作为启动重连期间兜底，不能把已分配助手的模型当完整目录。选项未就绪时禁用操作，提升 Full access 使用产品确认。

附件和文本有大小/数量限制，当前附件最多 5 个、原始总量 4 MiB，入站 WS 最大 8 MiB。Main 再次验证，不能只依靠浏览器表单。发送成功是原生接收，完成另由运行事件确认。

## 6. 展示和中止

Markdown 使用扩展离线 bundle，关闭原始 HTML，安全链接在外部 Tab 打开，不从 CDN 动态载入脚本。Thinking/Tool 分组，历史默认折叠，用户手动展开选择在后续同组更新保留；完整工具内容按需展开。

发送时只保留一份乐观用户气泡：会话创建和页面上下文采集期间使用临时占位，会话准备好后立即交给流投影并移除占位。后续运行确认、流事件和正式历史更新不会再次追加它；历史读取失败仍保留流中的用户输入与回复。连续发送相同文字仍分别显示。

停止绑定当前 turn 与原生运行，不因面板切换取消另一会话。断线需重新发现、初始化和读取原生历史，不能自动重发未确认用户消息。

## 7. 安全边界

Native manifest 只允许固定公钥派生的扩展 ID。app-server 校验 capability、精确 extension Origin、path 和消息大小；Gateway token 和 relay key 不返回 Side Panel。Origin 不是单独凭据，随机 URL capability 也不能写日志。

页面内容、附件和协议 payload 都要验证。新增方法必须明确 owner、取消、权限和消息持久化边界，而不是把 Gateway RPC 通配透传给扩展。

## 8. 维护、测试和未交付范围

日常 UI 修改在 conversation-overlay，relay 基线由锁定 OpenClaw 版本更新，构建接缝单独审查。回归包括 Native host 未安装/拉起失败、旧 rendezvous、非法 Origin/token、初始化前调用、流与历史重合、停止、超限附件和页面上下文分离。

当前不能将手动 Chrome 加载验证扩展为所有 Chromium 浏览器/商店发布承诺。右键提问、YouTube transcript、tab mention 等未接通能力不列作现有功能；新增时需同步[兼容规范](../browser-extension-api/compatibility.md)。
