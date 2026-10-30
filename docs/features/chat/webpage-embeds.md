# 消息中的独立网页

桌面聊天将助手消息中的 `[embed ...]` 转为独立网页卡片。它展示已有 HTTP(S) 页面或
当前原生 profile 托管的静态 HTML，不要求 `show_widget`，也不把页面内容自动加入模型上下文。

完整 HTML、交互式 3D、游戏和复杂模拟默认使用本功能；简单自包含卡片与需要草稿桥的
控件使用 Widget。生成页面写入当前 profile 的静态托管目录后引用真实 ref；已有网站
直接引用 URL。两条路径在任务开始时选择，不自动迁移或重放不支持的保存 Widget。
没有专门的视频网站转换或播放器适配。

## 输入与选择

```text
[embed ref="report_2026" title="报告" height="480" /]
[embed url="/__openclaw__/canvas/documents/report_2026/index.html" title="报告" /]
[embed url="https://configured-service.example/report" title="业务页面" /]
```

### 外部网址开关

普通外部 URL 的“设置 → 浏览器 → 内置浏览器设置 → 允许消息内嵌外部网页”默认开启，
对应原生配置 `gateway.controlUi.allowExternalEmbedUrls: true`。显式关闭时显示
不可用卡片并保留普通网页打开入口。开关读取现有原生值，打开设置不写配置；切换立即
通过 `config.get` revision / `config.patch` 条件写入，只修改这一项，不另存产品偏好。
读回原生值及应用状态后更新开关；冲突、断线或未能确认写入时禁用再次修改，用户刷新
读取后再决定，不自动重放写入。引擎未连接时显示不可用与刷新入口，不因查看设置启动
引擎。

普通设置保存不覆盖此项，配置同步仅为缺失项补齐开启值，保留显式关闭。
开关作用于后续 mount 准入，
不会重装或撤销已经打开的网页。外链准入通过同一当前连接读取 `config.get` 的有效快照，
与设置页共同遵循原生 JSON5/`$include` 解析，不再直接读取根配置文件。

允许正常企业内网地址，
拒绝任意本机端口、应用 origin、Gateway 控制面、元数据服务、文件和危险协议。
托管 ref 无需该外链开关。`file://` 或磁盘路径不是托管入口。

网页卡片的边框、14px 圆角、浅底标题栏与图标按钮参考现有 `show_widget`；浏览器打开、
固定和放大均有文字提示与可访问名称。填满侧栏时去除外层边框与圆角，放大、固定和
代理重试保持同一网页实例，样式复用不改变 Widget 或网页各自的准入规则。

Smart Canvas 的按需 `visualize` skill 负责交付选择。已有 HTTP(S) URL 直接输出消息短码，
没有查询工具或配置预读步骤；Main 在真实 mount 准入时检查当前外链开关和目标地址。
系统提示只将原生 embed 的一行网址限制改为宿主允许的 HTTP(S)，保留其余原生说明，
不添加工具名或查找步骤。已落盘的旧长引导规则按现有退休 ID 机制清除。
插件关闭时桌面渲染历史消息的能力保留。

### 托管页面的生成与交付

新页面通过现有已授权 Gateway 本机 exec 精确读取非空 `OPENCLAW_STATE_DIR`，
将文件写入 `<stateDir>/canvas/documents/<fresh-id>/index.html` 及相对资源，再输出真实 ref，
无需 Widget manifest。

环境不可读或无法确认是同一宿主时，不猜默认 profile、用户目录
或配置文件父目录，改用可用的 Widget 或真实文件交付。HTML 文件创建成功不等于已显示，
仍需检查实际页面与交互。网页解析、开关与静态文档授权均不依赖辅助工具结果。

## 投影与稳定展示

`pipeline/embed-shortcodes.ts` 在连续助手 text 范围内扫描有序 text/embed 片段；
`embed-presentation.ts` 同时分类短码与结构化 `canvas/render:url`。实时流、完成消息和
原生历史走同一投影。代码块、行内代码、转义、非法和未完成标记保留文字，不从用户、
thinking 或工具日志创建页面。

显式 URL 优先；非法 URL 不借 ref 回退。
高度限制为 160–1200；标题/paired fallback 仅作文字；失败时显示备用文字。
Widget 和 MCP App 保留各自准入及精确去重，MCP 描述符不降为普通网页。

`webpage-embed` anchor 给出消息位置，独立 presentation manager 在首次 guest 创建前
捕获原聊天最小上下文和 prepare/release API。通用 `NativePresentationSurface` 持有同一
view；固定、放大、侧栏往返和拆出保留页面及输入，不重载。展示身份不是工具权限。
放大/收起显式通知展示载体更新，卡片内常驻 dialog 通过 top layer 切换，支持 Escape，
无 presentation scope 的窄历史抽屉也能放大；不移动或重建内层 webview。

会话、owner 或连接代次变化撤销旧绑定；不复制 transcript、HTML 或持久网页状态。

### 网页导航与新窗口

普通 URL 有常驻浏览器打开入口；受保护托管文档没有可转交另一浏览器 session 的公开地址，
其打开按钮禁用并解释，可在当前卡片放大或固定。不会泄露内部转发 URL 或原生租约。
普通页面的点击、输入和同页跳转保持原生行为。`target="_blank"` / `window.open` 请求由
Main 拦截，合法 HTTP(S) GET 链接通过精确 mount 的 Main-only 事件交给所属会话现有
侧栏浏览器打开，放大状态先收起，原网页实例和输入不变；不创建页面所有的原生窗口。
只在普通 URL webview
初次创建时允许请求到达拦截器，托管 iframe 仍不允许弹窗。代理未就绪、身份退休、保护
地址或 POST 新窗口请求不分派，不将 POST 重放成 GET。状态桥不能伪造打开链接事件。
初始化事件不作为页面成功凭据；托管 shell 初始化只表示 iframe 已创建。普通 URL 的
主 frame、托管页面的直属业务 frame 加载失败或受保护导航被阻止时显示不可用；普通
导航取消和更深子 frame/资源失败不直接判整个页面失败。

## 承载、网络和静态授权

### 普通 URL 与共享登录

普通 HTTP(S) URL 直接加载到顶层 webview，不安装网页 preload 或应用桥；加载/代理状态
由 Main 回传原聊天 owner。它使用默认侧栏
浏览器的 `BROWSER_PANEL_PARTITION`，共享 Cookie（包括 HttpOnly）、同源
localStorage/IndexedDB 与站点 worker；首个顶层请求按正常 SameSite Strict/Lax/None 规则
使用当前 Cookie，不复制凭据或放宽 Chromium 限制。
sessionStorage 和页面内存仍按页面隔离；仅在这些位置保存的登录状态不保证跨页可用。
导入、命名 profile 和用户 Chrome 不自动参与共享。

### 托管 ref 与隔离存储

托管 ref 继续为每 mount 创建独立内存 partition，只允许固定不可变
`embed-viewer.html?mount=<UUID>`，装配最小 URL/代理状态/原生失败桥；内层 iframe
开启 scripts/same-origin/forms，不继承默认浏览器登录。

两条路径的网页都没有应用、工具、
Gateway、Widget 或草稿桥；Node、弹窗、下载、系统权限和嵌套 webview 关闭，保留
sandbox/contextIsolation/webSecurity。CSP、CORS、mixed content 与 Cookie/SameSite 规则
不变；普通 URL 是顶层页面，X-Frame-Options/frame-ancestors 不阻止该加载，仍约束网站
被其他页面放入 iframe。托管 iframe 继续受相应嵌套策略约束，直接引用 Widget 文档不会
解除原生写入的 CSP。

### 代理变更与释放

两条路径都沿用现有 `browserProxy` 队列，缺省系统代理，Widget 存储仍独立。
每个 session 有设置代次和 pending/ready/failed 状态；设置变更先同步暂停新请求，
再应用代理并关闭旧连接，当前代次实际成功才开放。失败不隐式 DIRECT，不重建文档或
重放未知请求。

代理重试不重建已加载页面；尚未发起首次请求时，代理就绪后开始一次
目标导航。源站认证不借用代理凭据。普通 URL 释放只销毁自身
页面并撤销准入，不清理共享存储、不注销整个 profile 的代理、不关闭 profile 连接或结束
共享 worker；托管 session 销毁时注销并清理自己的存储。

独立网页按上述代次守门保留原页面，不借用 Widget 权限或替换其恢复方式。

### 网络边界与无法归属的请求

可归属 guest 的页面 URL、跳转、frame、子资源和 WebSocket 使用同一 Main 网络边界。直接路由使用该 session
的 DNS 检查保护地址；只含代理且没有 DIRECT fallback 的路由允许由已配置代理解析本机
无法解析的域名。这些页面请求始终拒绝已知保护地址。远端 DNS 的最终解析受用户配置代理控制；
本地预解析不是 TCP 地址固定，不能将它描述为完整 DNS rebinding 防护。

共享 session 的网络、权限和下载处理器由 Main 单一所有者安装，按精确 guest/mount 身份
分派页面准入，不能用一个 mount 的保护覆盖同 profile 其他页面。无法归属页面的 worker
请求遵循浏览器 profile 的基线网络政策并保留元数据服务防护，不获得 mount、静态转发、
工具或工作区权限；页面释放不能证明共享站点活动或已发请求全部停止。
已登记或退休的内嵌 guest 即使与侧栏同 host、同存储，也不能登记为 browser 工具 target。

### 认证静态文档转发

托管页面通过 Main 在认证 hello 记录的 `pluginSurfaceUrls.canvas` 租约读取，绑定
实际 client、generation 与 Gateway stateDir。续期只调用已连接 client 的
`plugin.surface.refresh`；不启动 Gateway、不读 transcript 或任意磁盘文件。
每 mount 建独立 loopback origin，入口只覆盖本 document 的 GET/HEAD 相对静态资源，
同时要求 guest session 仅在精确范围注入的随机 Main-only header。

入口没有原生 capability。
转发流式、不缓存 HTML、不改脚本/CSP、不代理页面业务 API。响应保留 MIME 与策略头，
拒绝跳转、压缩形状不匹配以及会暴露租约的策略头；不透传上游 Cookie、鉴权、Location
或原始错误。client/profile/mount 退休停止在途传输，不能复用旧入口读其它文档。

```mermaid
flowchart LR
  Text[原生消息中的 embed] --> Projection[有序纯投影]
  Projection --> Card[稳定网页卡片]
  Card --> Admission[Main mount 校验]
  Admission --> Page[普通 URL 顶层 webview<br/>默认浏览器共享 session / 无 preload]
  Admission --> Shell[托管 ref 固定 shell / iframe<br/>独立内存 session]
  Settings[浏览器代理设置] --> Page
  Settings --> Shell
  Page --> Web[原网页及业务 API]
  Shell --> Web
  Shell --> Broker[精确文档静态转发]
  Broker --> Canvas[认证原生 Canvas]
```

## 验证边界

自动化入口覆盖消息语法、live/history 投影、viewer capability、真实 mount 准入、
Main owner、配置 revision 条件写入、旧绑定/租约退休、代理代次与失败、精确静态转发及
插件离线打包。当前实现位于 `src/main/chat/embed/`、
`src/main/core/window/webpageEmbedGuest.ts` 和
`src/renderer/libs/openclaw-chat/components/webpage-embed/`。

既有隔离 Electron 探针使用真实 guest、不可变静态宿主和原生输入验证：

- 普通按钮、输入、同页跳转，以及 `_blank`/`window.open` 经 Main/Renderer 打开侧栏页；
  托管页面仍维持原沙箱，外链许可不等于托管页面获得弹窗能力。
- 普通 URL 顶层页面与默认侧栏共享 Cookie、localStorage/IndexedDB，sessionStorage 隔离；
  单页销毁不影响其他页面，重开保持登录，侧栏登出同步生效。自动 JS/POST SSO 中断初始导航
  后可到达合法目标，Main 不重放导航。
- 固定、放大、拆出、停靠和返回消息保留页面实例及输入；固定 shell 路径另外验证主题、窄屏、
  初始受保护 302、一级 iframe 的 X-Frame-Options/连接失败与深层 frame 失败隔离。
- SYSTEM（探针实际为 DIRECT）、显式 DIRECT 和自定义 HTTP 代理下的页面、JS/CSS、图片、
  fetch/API 与 WebSocket CONNECT；无效 CUSTOM 阻断请求，修复设置后原 iframe 可恢复。

普通 URL 顶层 guest 与固定 shell/iframe 是不同承载路径，二者的通过范围不能互相替代。
原生 serve/capability 的隔离 HTTP 检查覆盖认证、普通 HTML/相对资源、CSP、HEAD 和租约退休，
但不是完整 Gateway hello 握手。以上是既有分层证据，不是本次文档整理重新执行的结果。

Gateway 和部分 React 入口仍使用 fixture，未覆盖完整 Cowork/Gateway 流程、应用重启、
生产 SSO、真实企业代理/PAC/代理认证或最终安装包冷启动。真实探针未稳定制造 DNS 失败，
该分支仅有行为测试。真实模型交付和空缓存且公网阻断的首启依赖也需目标环境证据；
冻结运行时 proof 过期导致未执行的探针不计为验收通过。
