# 应用插件宿主（SDK v1）

Agent Team 和 Swarm Workflow 的原生执行、Main 协调、数据规则、界面、设置、历史入口及翻译分别归插件包。应用按清单发现和加载独立构建产物，不再通过业务 `import` 或专属 IPC 组装它们。用户可以只修改和重建插件；通过授权的本地包管理与代码审核流程后，宿主停止并重新启动后台 Gateway，同时在原应用进程中重新准入 Main/UI，**不要求退出或重启软件**。插件机制不新增 OpenClaw patch，也不导入原生私有模块；新增底层能力仍需扩展公共 SDK。当前随软件内置交付，是否开放安装、卸载属于单独的产品策略。

## 所有权与运行边界

```mermaid
flowchart LR
  Package[插件包: Native / Main / Browser] --> Native[OpenClaw 原生注册]
  Package --> MainHost[通用 Main 宿主]
  Package --> BrowserHost[通用 Browser 宿主]
  MainHost --> DB[(产品 SQLite: 同库事务)]
  MainHost --> Bridge[通用 appPlugins IPC]
  Bridge --> BrowserHost
  MainHost --> Gateway[绑定插件注册收据的公开 RPC]
  Gateway --> Native
  Native --> History[(原生消息与 holding)]
  Required[Runtime Services: 常驻保护/收据/清理] --> History
```

`plugins/sdk/app-plugin-sdk/` 是无应用源码依赖的公开契约。`src/main/plugins/app/` 只负责可信代码发现、产物校验和保留、生命周期、数据库端口、配置贡献、提交/删除参与者、代码审核和资源发布。`src/renderer/features/plugins/app/` 只负责 React 宿主、声明式插槽、模式选择、只读投影与资源生命周期。Core 保留产品会话、窗口、权限、执行连接、普通聊天和草稿；业务不再由 Core 识别 Team 或 Workflow。

Browser 视图和输入模式可提供自己的 React 图标，宿主保留通用缺省图标，不按插件 ID 选择业务图标。Main 的运行时 Goal 投影只读返回 `goalId`、`phase`、`identityPending` 等原生执行状态；插件据此区分普通会话的中性快照与实际 Goal，不能用投影建立终态或扩大权限。

Browser utility CSS 使用宿主完整 Tailwind 主题，禁用重复 preflight，并限定到本插件的 `data-ui-style-scope` 祖先。通用 Registry 给视图、模式选项及图标提供不产生布局盒的边界；SDK Portal 和 Core Modal 保留该上下文并在真实目标 DOM 中补齐边界。这样独立面板的 utility 不会改变宿主菜单，也不会被另一个插件的同名 shorthand 覆盖。插件手写 CSS 仍须使用自己的命名空间；这是当前独立 HTML 贡献面的样式约束，不是恶意 CSS 沙箱或任意嵌套插件、SVG/table 贡献的完整隔离。

Main SDK 的 execution facade 按真实路由实例复用，不能每次创建新的包装对象，否则插件自己的 `getRouter() === capturedRouter` 围栏会误拒绝同一实例。底层路由替换后旧 facade 失效。响应上下文只暴露 `isCurrent()`，同时核对原生响应上下文、当前运行时引用和插件 epoch；定向状态查询原样传递预期 session ID 与 lifecycle revision，不用空闲投影代替精确身份或终态。

Agent Team 的 `host/` 持有协调器、队列、附件和产品数据库事务；`host/app.ts` 注册 Main，`app/` 持有应用契约及完整 React UI；既有 `browser/` 保留与原生入口无关的纯浏览器辅助。Workflow 的 `host/` 和 `app/browser/` 分别持有 Main 注册与完整 UI，`browser/` 保留纯辅助。两者自己的配置投影、沙箱工具声明和技能声明通过注册返回。Core 对贡献 ID 统一合并用户配置、保留显式开关，按技能声明处理同步和发现重启，没有 Team/Workflow 特例。它们均不导入应用 `src`。原生 `index.ts` 不导入应用入口。

Runtime Services 只保留通用执行准入、inert session 托管、执行收据、取消/清理、文件系统和 FIFO。它不识别可选插件 ID、工具、模式、房间或轮次。Team 的启动规则、纠正提示、讨论协议及业务账本归 Team；Workflow 的流程规则及流程库归 Workflow。插件握手与请求转发归每个插件的公开 SDK 接入。Required 服务不加载可选插件 Main/UI，也不提供它们关闭后的业务入口。

## 清单、构建与授权

### 清单字段与发现

每个插件有 `openclaw.plugin.json` 和 `app.plugin.json`。应用清单固定 `manifestVersion:1`、`apiVersion:1`，声明相同的应用/原生 ID、版本、Main/Browser 文件、能力、命令与插槽；`package.json.app` 指向源码入口。清单 `native.defaultEnabled` 和 `native.userToggleable` 声明捆绑默认策略；宿主在 Main/schema 激活之前独立验证可信捆绑产物元数据，外部包不能凭这两个字段自动启用。构建脚本按文件发现清单，不维护业务入口列表。

### 纯历史展示入口

可选 `entries.presentation` 对应独立的纯历史展示入口，源码由 `package.json.app.presentation` 指定，仅导出 `presentation`。它可提供文本清洗、原生输入身份展示、精确镜像识别和双语词典，不取得 Browser host、React、命令、导航、数据或发送端口。构建与模块图校验拒绝其引用 Main、Browser 入口或 Browser runtime；普通 Browser 图也拒绝引用 Main 入口。

独立浏览器模块与 `new URL('./worker.mjs', import.meta.url)` 的本地资源边继续验证和发布，Main 私有图不作为 HTTP 资源根。

### 不可变产物和安装审核

`npm run plugins:app:build` 独立构建 SDK 和插件。产物为 `build/app-plugins/<id>/<hash>`；可安装完整包位于其 `packages/<id>/<hash>`，包含单文件原生 ESM、技能及 `app/`。Main 的 npm 依赖进入自己的 ESM 包；Browser 的 React/ReactDOM 指向宿主真实单例，插件自行编译 CSS/Tailwind。产物逐文件 SHA-256 和清单共同生成身份，限制路径、链接、文件数、大小及可解析模块图。

保留目录复制后再校验，防止从可变安装目录执行 Main 代码。作者操作见 [SDK 说明](../../plugins/sdk/app-plugin-sdk/README.md)。

安装、删除与原生能力审核继续使用原生扩展流程。外部 Main/UI 代码另有绑定精确产物 hash 的审核，不复用原生 review token。审批文件位于产品数据的 `app-plugins/approvals.json`，只保存当前 hash 和有界历史批准；保留的不可变产物位于 `app-plugins/artifacts/<id>/<hash>`。损坏或不匹配的记录不能授权执行。安装目录同 ID 的自定义插件覆盖捆绑候选，不会退回执行另一个同名版本。

### 代码信任限制

首版运行可信 Main 进程内代码和同页面浏览器模块。contextIsolation 保护 preload 边界，不能隔离同页面插件。模块图和 SDK 门禁防止过期调用和格式错误，**不是恶意 JavaScript 沙箱**。新窗口种类、执行原语或不受 SDK 支持的宿主行为仍需要 SDK/宿主变更。

## 公开原生接口、注册收据与代码准入

### 源码独立构建与 Required 能力

公共 App SDK 和构建工具源码集中在 `plugins/sdk/`，分别保留 `app-plugin-sdk/` 与 `app-plugin-build/` 子包；根 npm workspace 使用 `plugins/sdk/*`。插件发现继续读取 `plugins/extensions/`。目录调整保持 npm 包名、公开 exports、构建命令和产物布局不变。

App SDK、`@runtime-services/sdk` 与 `@app-plugin/build` 分别分发契约、Required Service 的客户端/通用库和构建工具。宿主使用 npm workspaces 开发这些公开包，发布输出包含 ESM、声明和许可证；外部项目只安装打包后的依赖，不解析宿主源码或借宿主 `node_modules`。

构建工具使用自己的公共 Tailwind preset 和 React 单例 adapter，忽略祖先 tsconfig 的源码 aliases，验证实际 npm 输入与许可证。外部 desktop companion 保留完整 Native/Main/Browser 包结构，与 MCP App 流水线分别处理。

应用插件的 `package.json.app` 是通用源码构建声明，不再需要旧宿主专属 bundle 标记。运行时装配只消费已构建的完整包，不读取该源码目录的依赖锁、不执行 npm 安装，也不携带源码开发依赖或旧依赖缓存。其它 Native 扩展仍使用原有锁文件和生产依赖流程；应用声明及目录存在都不授予 Native trust。

Team/Workflow 从公开 SDK 导入通用准入、FIFO、文件准入和执行能力。讨论协议和 `DiscussionLedger` 属于 Team，不再从 Runtime SDK 发布。Team 自己解释模式、房间、轮次及业务回执；Required 服务只维护精确原生身份、代次、owner 寿命、接纳、取消及终态/清理事实。未登记资源的普通会话不产生插件业务锁。

### 只读握手与写租约

Native 客户端先通过公开 `api.lifecycle.runInBackgroundContext` 在原注册绑定的 Gateway 上完成只读能力握手，再以随机实例 token 绑定同步投影。能力协议使用通用 `executionAdmission`，只返回执行通道的 `clear/held/unknown` 和无正文身份，不发布 Team 模式。实例、路径或插件 ID 不能代替该握手。

同步 reader 也回到 Required 注册的公开上下文，不借外部 ambient Gateway；缺失、失败和退休均拒绝准入。新绑定使旧 handle 失效，旧工具闭包不附会新 provider。正常原生工具采用已启动 Gateway service 的注册；未采用准备好注册的 discovery factory 首次只触发合并的只读绑定并隐藏工具，后续合法 factory 才取得投影，不启动或重放业务。trusted tool policy、精确原生身份和副作用前校验继续独立生效。

写操作使用独立 owner 租约。客户端登记随机 proof RPC，Required 服务通过公开 Gateway method descriptor 核对实际插件归属，在同一绑定 Gateway 上完成单次 nonce 挑战；密钥只交给该注册的回调。只读 provider token、请求体中的插件 ID 和 Main 代码审核都不能授权写入。租约绑定原注册、provider scope 和真实 lifecycle，退休后旧回调不能写入。Required 服务继续保留已登记资源的收据与取消/清理围栏；owner 退休不构成执行已结算。

### 发布、quiesce 和迟到握手

热替换先启动候选 service，成功后才发布候选的 Gateway 方法表。因此 owner 客户端和 proof RPC 仍在注册期创建，但 service.start 只初始化本地资源，不能要求候选 proof 已能从当前 Gateway 调用。已发布的实际业务请求在副作用前等待 `ensureBound()`，并在握手前后重新核对调用权限、service 代次、停止状态及原生生命周期；失败直接拒绝该请求，不重放业务。停止后或跨越停止/重启的迟到握手不能恢复旧请求。只读回执快照不持久恢复状态，也不借查询取得写租约。

Native 客户端和 provider 在注册期捕获普通调用上下文，再通过原公开 background runner 核对当前准入。Native 开始 quiesce 后，信号尚未 abort 或已准入 cleanup 仍可运行都不延长业务权限；迟到握手被拒绝，已失效句柄和租约不会复活，恢复需要新的真实注册。不读取 Native 私有实例字段，也不新增运行时补丁。

### 托管执行与原生能力证明

Managed execution descriptor 明确声明 whole-run、run-owned cleanup 与精确 describe/cancel 协议。facade 始终调用原插件的 bound executor，并将 capability fence 与调用者 `assertCurrent` 合并；Runtime Services 不代执行。当前宿主的私有适配从公开 SDK 所属运行包、实际进程入口及交付 profile 核验预备 bundle 的版本/完整字节 hash 和既有执行能力基线。

profile 由冻结运行时验证后的资源装配生成，绑定目标平台实际 bundle，并随 Required 包交付；外部 SDK 不包含 patch 路径或宿主目录。无 profile、不兼容或 pristine 环境不声明该能力，不退化为 Stop ACK 或 `waitForRun` 推断结算。本机制不增加或调整原生 patch。

公开 `api.runtime.gateway.request` 继续受 OpenClaw 的 bundled / trusted official 安装准入约束。Main companion 的 hash 批准不能授予 Native trust；独立构建不代表任意手工安装包自动具备后台 RPC 权限。交付仍须通过既有可信安装或宿主显式捆绑流程，不新增权限绕过。能力握手测试证明路由与生命周期，不证明任意第三方分发策略已开放。

### 计划状态和源码分发边界

Plan Mode 不成为业务插件的源码/启用依赖。App SDK 的纯 planning 契约解释规划、待审核和异常状态；Runtime Services 不导入该解析器。Main 不能以 `sessions.describe` 省略投影证明无计划：Required 的只读 `runtimeServices.sessionNamespace` 在认证 backend、精确 SID/revision 下读取调用方指定的有界 namespace 快照，由消费者解释。该读取不写状态、不批准审核或扩大权限。

本次契约直接替换旧内部实现，不提供旧协议分支、旧目录扫描或迁移桥。已有业务数据文件保留，由所属插件读取；缺少插件不会自动恢复、重放或清理旧任务。

业务测试随插件独立配置运行；真实 Core 聊天控制器/历史边界的原有断言保留在显式宿主集成 profile。SDK 及宿主边界测试继续由 Core 测试运行器发现，不把缺少可选源码视为失败或转而搜索外部仓库。

### Native 注册收据与当前代码

`@app-plugin/sdk/native` 通过 OpenClaw 的公开 `registerGatewayMethod`、`api.lifecycle` 和 `openclaw/plugin-sdk/gateway-method-runtime` 接入。通用构建器自动包装 Native 入口，并在产物清单加入 `contracts.gatewayMethodDispatch: ["authenticated-request"]`；插件作者不需要修改宿主源码。Agent Team 和 Workflow 的源码入口也显式登记同一幂等 helper，以支持原有原生资源构建路径。原生入口不导入 Main/Browser。

每次 Native 注册产生独立的随机注册 ID，公开 `<plugin-id>.app.handshake` 返回插件 ID、注册 ID、实际进程 PID、canonical Native 入口、注册时固定的源码摘要，以及本实例自有 RPC 的绑定入口。Main 同时核对配置、所管理 Gateway 的 PID/进程代次、已批准产物中的 `native.binding.json`、入口路径和磁盘字节；等待握手时跨过进程代次或失效事件的结果不能激活插件。配置未知、来源不符或握手失败均撤回业务。

该收据是应用与插件注册之间的关联，**不是原生私有 instance/generation 权限，也不是实际 ESM namespace 执行字节证明**。

Gateway 的 HELLO 和健康检查不证明配置重载已经稳定。Main 对握手做有界的只读重查，并订阅原生公开的 `plugins.changed` / `config.changed` 重新核对注册；新代次、包变更和宿主释放都会撤销旧定时器。此机制只恢复可见性和准入，不重试业务命令或发送请求。

### 字节身份与冷替换

支持 `single-file-v1`：业务依赖打包，只允许静态、字面量公开 OpenClaw SDK 模块和支持的 Node 内建导入，拒绝替代 loader。Main/UI 使用保留目录内按 hash 定址的产物。改变 Native 或伴随代码必须先确认旧 Gateway 退出，再验证包并启动新进程；不在运行中的相同路径覆盖代码后热采纳新 hash。注册摘要不会随磁盘修改更新，运行时发现字节变化即撤回准入。不支持利用预热 namespace、自定义 loader 或私自原地改包获得新版本准入；代码审核与目录检查不是恶意本地代码隔离。

开发运行时的 `vendor/openclaw-runtime/current` 可以是指向平台运行时目录的符号链接或 Windows 目录联接。发现捆绑插件时先解析并固定该受管运行时根目录的真实路径，再拼接 `dist/extensions/<id>`；插件包内部的目录或入口链接仍拒绝，Native 字节摘要及注册握手检查保持不变。产物验证同时覆盖真实 Main/SQLite 通过 `current` 目录联接加载 Team 与 Workflow，防止开发布局被误拒绝后丢失设置、历史等界面贡献。

### 请求分发与权限传递

SDK 用代理 API 观察插件的公开 `registerGatewayMethod` 登记，为插件自有 RPC 同时登记绑定本次注册 ID/PID 的直接入口。原参数保持原样，保留原方法的 scope、profileAccess、sessionAccess 及保留名称的权限要求；原 handler 看到的 `req.method` 仍为业务方法名。握手通过公开 handler context 的只读 Gateway 方法描述符核对原方法和绑定入口的实际 owner 与权限，原登记冲突或元数据不一致均不能发布映射。不读取其中的 opaque 插件 registry，不导入原生私有 registry/instance 模块。

Main 的 canonical Gateway client 用 `AsyncLocalStorage` 保留当前业务注册收据。自有 RPC 走收据中的直接入口，Core RPC 才转换为 `<plugin-id>.app.dispatch` 的普通参数并调用公开 `dispatchGatewayMethod`；不扩展 `RequestFrameSchema` 或客户端协议。Native helper 核对注册 ID、PID、后台客户端、真实注册生命周期、请求取消和调用者权限。

原生继续持有真实实例、会话 incarnation/generation、原始调用者与 profile/device 权限，并在授权等待及提交边界检查；应用注册收据不代替这些权威。清理请求不借用新业务注册，仍受插件清理方法和参数 predicate 约束。

### 配置重载不代替注册寿命

全局 `isConfigReloadSettled()` 不属于插件注册或请求的寿命证明，不作为握手、派发或响应的额外门禁。`agents.create/update` 等公开方法会写配置并自行确认应用；其成功响应可能早于全局重载收尾。只要真实注册和调用者仍有效，SDK 原样传递该响应，Main 重新核对同一注册收据时保持业务 epoch。实际关闭、调用者撤权、取消、实例更换或源码身份变化继续按既有围栏撤回，未知副作用不自动重发。

直接入口使真实 Native handler 的完整 Promise 归属实际外层请求：像讨论启动这样先返回受理结果、再等待后台任务的接口，不会因一次嵌套派发已取得首帧结果而提前释放 work-admission root。SDK 不把受理结果当执行完成，也不通过脱离调用者权限的后台上下文绕过这项约束。

这不替代 handler 自己的提交围栏。Native 是否提供 session mutation commit guard 取决于原方法的公开准入声明，不能假设每个自定义 RPC 都具有该 guard；插件仍须在异步等待后的副作用前检查实际调用者权限，并在 Native 提供 commit guard 时保留相应检查。绑定入口保持这些字段、getter 与权限上下文，不给原方法增加系统权限。

### 明确拒绝与未知结果

派发前的拒绝保持明确错误；派发后超时、取消或撤销可能已经产生副作用，helper 返回严格关联插件、注册、进程和方法的未知结果标记。Main 只对完整匹配当前调用的标记转换为既有 `CLIENT_TIMEOUT` / `requestSent: true` 未知结果，保留发送围栏并核对原生收据。原生明确返回的错误原样保留。任何路径都不自动重发未知操作，不以重启、空闲或 owner 更换建立执行终态。

## 启停、替换与恢复

| 操作          | 继续保留                     | 必须撤回或核对                             |
| ------------- | ---------------------------- | ------------------------------------------ |
| 同包关闭      | 数据、未知回执、既有合法清理 | 业务 epoch、命令、UI 和新工作准入          |
| 同包重开      | 同一产物及持久业务元数据     | 新业务 epoch，不重放未知输入               |
| 代码包替换    | 旧版本必要的资源/清理引用    | 旧 Gateway 退出、hash 审核、新 Native 关联 |
| 重连/实例变更 | 可恢复元数据和当前清理责任   | 旧收据和迟到响应，重新握手后才准入         |
| 明确卸载      | 业务表、历史和安全回执       | 通用宿主关联按 owner 清理，不误删共享资源  |

`register`、`activate`、`onEnable` 和 Browser 注册为同步契约。无效 thenable 会被处理并阻止激活；同步 activation 的清理 lease 在返回时撤销，异步尾部无法继续删除或写数据库。`activate` 每实例一次；`onEnable` 每业务 epoch 一次并返回 disposer。异步工作通过命令、合法清理参与者和预检执行。

可选 Main `maintenance` 在实例激活后运行，不依赖业务启用状态。宿主每次给予新的、仅本次 Promise 有效的清理 lease，串行执行，释放实例时撤销；只能使用已声明且参数符合 predicate 的清理能力，不能恢复业务注册、启动 Gateway 或发起新执行。旧资源 owner 可保留维护，不能因此发布旧版本界面。Team 利用它核对既有精确运行收据及持久取消任务；热关开复用同一协调器，不重新执行进程恢复或推进房间代次。

清理 RPC 的参数 predicate 也必须同步返回严格 `true`，其临时权限在返回时撤销。配置投影同步运行于只读作用域，不继承调用方的业务或清理权限。Gateway 离线时，保存成功的配置开关与实际原生运行证明分别记录；就绪后可以恢复业务，配置结果未知或运行身份未确认时拒绝业务调用。

关闭插件先撤回业务 epoch，围栏待发输入，保存必要元数据，再修改原生状态。Browser 移除业务插槽、历史/设置入口、打开的对话框、模式、样式和旧请求。重新启用产生新 epoch，不重开旧对话框、不重放未知发送。原生 transcript 保留，只在可选插件再次启用后恢复其业务历史入口。

当前已安装且获批产物的纯历史展示入口按插件 ID/hash 单独租用，关闭或临时断线不撤销，已挂载消息也会随展示规则变化刷新；不读取额外历史或赋予业务权限。真正卸载、选定包替换或清单身份未知会撤回旧展示，旧异步加载及 disposer 不能污染新版本。仅为清理保留的历史 owner 不发布展示。快照 `installed` 只表示当前已批准 UI 产物收据，不能证明 Native 安装、启用或运行。`presentationEntry` 只有验证后的同源不可变资源 URL，不接受安装目录直链。

用户停止产品会话时，先同步发起各插件的本地取消围栏，再立即执行原生 Stop，不等待插件的远端 guard 清理完成。清理失败不能阻塞来源停止，也不构成执行已结算或资源可删除的证据。侧栏相关活动通过插件自己的 `session.presentation` 投影，Team 的未结算投递收据不能推断成员仍在执行，Workflow 使用全历史运行摘要而非截断列表推断空闲。

插件通过 `publishSessionActivity` 发布成功读取的完整活动 ID 集合。通用 Browser 宿主仅保留各插件最后确认的活动正证据，关闭时继续显示运行提示；旧 resolver、历史、设置和导航全部撤回。新 epoch 的初始空状态、读取中或失败不能清除旧证据，只有当前插件取得完整成功快照后才替换其集合；多个插件分别维护，不互相清除。Team 需两份完整团队列表均读取成功，Workflow 使用完整原生活动快照。这是界面提示，不建立执行终态、发送许可或历史权威。

安装、更新、审核、删除等改变 Native 包身份的操作仍使用 Gateway 冷流程：先撤回所有已准入应用插件，检查业务及历史清理 owner，停止实际 Gateway，并阻止并发启动；只有确认原进程退出才改变包。停止超时保留活进程引用并阻止后续启动/替换。普通预检否决且未触碰原生变更时恢复旧业务；资源清单、schema 或清理失败的安全阻塞继续保留。操作后只读取一次真实清单，不重试未知变更；变更的 Main 模块通过新的不可变 hash 路径加载，旧业务、样式、资源 URL、UI 和 epoch 立即失效。

必要历史清理 owner 按原 hash 保留，非必要旧实例释放。新 schemas 在原产品库中初始化，仍使用同一数据库端口。

冷操作 lease 释放后，原先存在的 Gateway 在后台重新启动并重连，软件窗口、Core 和主进程保持运行；原本离线且无 Gateway 的应用不因只读审核准备而启动运行时。只有新进程握手通过才重新发布业务 UI。同包启停独立于改包流程，必须通过公开管理 API 在现有 Gateway 内热应用，不能触发 Gateway 重启。关闭后立即隐藏历史和设置入口，重新启用不恢复旧对话框或重放请求。

捆绑及已批准的外部应用插件统一调用原生 `plugins.setEnabled`，保留其能力审核与运行态回执；不使用 CLI 作为失败后的替代路径，不使用 9.8 的 Skill 发现重启规避。附属 Skill 经 `skills.update` 同步后，只读核对 `config.get` 中技能开关及 `configRevisionHash === appliedConfigHash`，等待配置实际应用，避免紧接着的插件操作与尚在执行的配置监听争用 lease。

热更新只使用已连接的 Gateway 客户端，每一步核对原连接、进程和代次；断线或身份变化直接失败，不进入通用请求的自动恢复流程。原生要求重启或热更新无法确认时明确返回失败，宿主不会自动停启 Gateway。Main/UI 只在当前 Native 注册握手通过后发布。

非应用扩展的离线恢复同时核对用户安装包及实际捆绑目录、清单身份和配置策略，不能把用户安装目录中没有条目等同于内置插件未安装。其管理 API 超时或断线后，也只有明确的未派发证明才允许命令行恢复；已发送或结果不明的启停保留待确认结果，不重发、不凭配置布尔值推断原生重载已完成。应用插件启停不使用这条 CLI 恢复路径。

热启停的收尾通知及 Renderer 列表重读同样只用现有连接，不调用通用自动恢复入口或 `plugins.refresh`。连接不可用时保留错误与最近确认的清单，不退回遗漏内置插件的局部目录；连接就绪后，只对先前不可用的读取补读，避免一次断线隐藏卡片或间接启动 Gateway。

参数保存不改变 Native/Main/Browser 的代码身份，不进入包替换的冷操作 lease。声明热配置的字段沿原生配置服务更新和确认，保留字段权限、进度及未确认结果；Swarm 的数值配置不能因套用包变更流程而停止 Gateway，或因缺少应用 ACK 自动重启。

失去启停响应形成可恢复的业务围栏，与永久 schema/资源清理失败分别记录。后续只读刷新取得新的、完整且当前有效的 Native 绑定证明后，才恢复业务准入；配置布尔值、同一份旧证明或未确认状态均不能解除围栏，也不把原请求的未知结果改写为成功。资源与清理失败继续阻塞。

应用启动先完成历史保护和用户数据准备，再打开并赋值 Core Store，随后发现插件、初始化插件 schema，最后启动开发资源服务和主窗口。插件发现需要读取受管运行时目录，不能早于 Core Store 的访问门禁；发现与 schema 准备不启动 Gateway，也不提前准入 Native 业务。初始化进度窗口仍按原流程显示，Browser 偏好加载和历史恢复门禁继续约束后续激活。

Store 打开后和插件异步准备后都重新核对退出状态，退出期间不因发现插件而构造新的运行时服务。普通启动可以先开放工作区、在后台准备引擎；插件业务贡献仍须等待当前 Native 注册证明。扩展目录发现不持有应用配置队列，发现完成后的同步配置投影才进入该队列，避免等待引擎的目录读取反过来阻塞启动配置。

开发启动先构建伴随包，再在没有相关活 Gateway 的前提下准备同批 Native/Main/UI 产物，防止新清单与旧 Native 包不匹配时默默丢失入口；已有匹配产物不写运行时。Vite 会给变量动态导入附加 `?import`，代理仅剥离这个固定标记后向私有 Main 资源服务转发已验证路径，拒绝其它查询串；Main、binding、清单及私有 token 的保护不变。真实开发验证入口为 `node scripts/test/plugin-host/verify-development-application.mjs`。

Core 的生产与测试入口不静态导入可选插件源码。插件业务测试和专项探针保存在其自身 `tests/`、`scripts/`，随源码目录一起移动；Core 测试使用合成 SDK 贡献验证宿主行为。Vitest 按实际插件目录发现测试及可选 `tests/hostSetup.ts`，不维护业务插件列表。需要真实宿主的插件集成通过显式 `APP_PLUGIN_HOST_ROOT` 定位，并在未提供宿主时明确跳过；设置了错误宿主或现存插件文件损坏时直接失败。通用产物探针按实际清单验证生命周期，零个可选插件也是有效库存，不把缺席伪装成已验证某项业务。

源码分离验证在未包含 Team 和 Workflow 两个目录的隔离副本执行：完整应用构建、50 个文件的 756 项 Core 定向测试通过，真实 Electron Main 与 Chromium Browser 均接纳空应用插件清单并撤回全部业务贡献。该验证没有启动 Gateway、调用模型或修改用户数据，不代替安装包和实际执行中的卸载验收。插件在外部仓库的独立构建还需要显式提供其 npm 和必需公共模块依赖，Core 不通过兄弟仓库路径回退加载源码。

临时目录清单读取/加载失败形成独立的包准入围栏。修复文件后，下一次显式包操作先在确认停止的 Gateway 下重读、验证和恢复当前清单，再恢复连接并执行正常资源预检；不重放前次未知操作。该恢复不能清除数据库资源账本、schema 错误或历史 owner 不明的永久保护。未完成的多包准入保留新 schemas 的待初始化集合，避免部分失败后跳过初始化。

原 hash 的资源被显式采用或最后一项删除后，宿主释放不再有引用的本地清理实例及收据/停止订阅。重复切换同一 hash 也不能覆盖并遗失旧 disposer。释放必须等该精确实例的变更 lease 和删除 lease 都归还；从其他 registry 借入的 owner 仍由原 registry 在自己的清理上下文释放。

Gateway 关闭只有真实正常 close/exit 才证明退休。异常、超时、信号或非零退出保留本进程的关闭失败围栏，后来的退出观测不能重新准入或启动替代 Gateway；包变更 lease 及其他资源保护也继续独立生效。普通插件热启停不进入这条关闭流程。

旧批准产物只在当前仍安装的插件资源账本引用其精确 hash 时恢复清理，捆绑产物也可使用账本中的精确 owner/hash 收据。顺序是发现候选、当前 schemas/账本初始化、实际 runtime 建立，再激活旧清理 owner；不扫描目录以推断信任，不重跑旧 schema/adoption，不发布旧 UI 或业务命令。已知插件的坏包或缺失旧文件只保护其关联资源；完整清单读取失败、账本不可读或包变更结果未知仍保留全局保护。可信 Main 完整但 Native 身份不可核实时，仅允许其清理库存参与，不发布业务。

完整可信清单确认插件缺席后，宿主撤回其业务、界面、维护和提交/删除参与者，并仅解除该 owner 在 `app_plugin_resources` 中的关联。同一来源的其他插件保护保持不变，普通聊天、普通会话删除及其他插件操作不等待已移除插件的历史清理。卸载不删除产品团队元数据、助手、普通或成员会话、原生历史和执行安全回执；重新安装后由当前插件初始化并读取原有数据，重建资源关联，不重放未知发送。借用清理实例由其原 registry 退休，旧异步调用不能继续写入或调用 Native。

整个运行时或扩展目录不可用、清单损坏、权限错误和单个入口字节不匹配不构成卸载证据。只有完整清单不再包含该 owner，或可读取的实际扩展目录确认特定包目录不存在，才解除其参与。开发准备、资源同步和裁剪会核对已退出当前源码及构建清单的旧应用插件；仅在与保留构建包逐文件一致、路径无链接且确认没有相关 Gateway 进程时清除旧 Native 副本，同 ID 的第三方改包不按目录名删除。产品用户数据与保留构建收据不随该步骤删除。

## 提交、数据和界面契约

Composer 插件返回 `{prompt,input?}`，宿主填入 pluginId、epoch、mode 的有界结构化原生 envelope；提交者和 native 侧只接受当前精确 owner。宿主在真实发送边界重查当前草稿、选择、模式、普通 turn 与原生身份。取消和失败不能清空新草稿，也不能自动重放未知发送。

模型选择等异步准备之前捕获当前模式选择，等待结束及实际提交前再次校验。等待期间插件关闭、epoch 变化或用户切换模式均撤回原提交，不能因准备函数被替换而把原插件消息降为普通消息发送。

提交参与者的临时准入映射只绑定发送前守卫及当次 epoch；全部参与者成功完成 `markSubmissionStarted` 后回收同一映射，失败或未知仍保留，不能因历史会话累积耗尽新请求名额。精确确认删除后回收对应会话集合。该回收不推断发送或执行结果；持久收据、Native 身份及清理围栏继续由原参与者持有。

Browser `uiState.get/set` 提供当前插件 ID/hash 隔离的有界内存 plain-data 草稿，克隆读写并拒绝函数、访问器、循环和活对象。关闭、断线或可恢复的业务围栏保留正文、附件路径和未知请求定位；真正卸载或更换 hash 后清除。它不保存控制器、插件模式、回调、原生授权或 transcript，也不在重新启用后自动发送。

Team 恢复准备时，本地保存的 attempt 锁必须仍匹配当前草稿；只有读取同一 `draftId` 房间明确为 `ready/prepare_failed` 且没有冻结的待发送请求，才解除准备锁。原生 metadata 不保存该 UI attempt ID；缺失、断线和发送结果未知仍保持冻结。

插件资源参与者扩展删除集合至固定点；先获取所有删除 lease，再完成所有预检，最后删除。全部参与者冲突、失败或未知均否决删除，避免只清理一半。产品库新增 `app_plugin_resources` 保存 resource ID、owner ID 与 artifact hash；空投影不能删除旧保护记录，跨版本采用必须显式确认完整集合。插件使用同一个实际 SQLite 连接的受控端口，同库原子事务不拆分；产品表和插件原有表位置不变。

产品会话删除与包变更互斥，包括没有插件资源的普通会话。删除在任何插件回调前同步取得 lease，直到整个删除事务结束才归还；包变更从预检、库存修复、停止 Gateway 到最终重连期间拒绝新的删除。删除预检即使异步等待，也不能被换包切换到未取得本次 fence、未参与预检的新资源 owner。准入失败和操作异常均归还临时互斥 lease，既有未知结果和资源保护围栏继续独立生效。

### Browser 插槽和撤回

Browser 可声明 workspace、composer、plugin settings/history、chat action、session summary/details/presentation、application page 和 message/interaction presentation。主输入、普通详情和扩展列表只组合插槽。视图可声明有限数值 `order`，同序保留注册顺序；摘要保留 Workflow → Team、右侧计数和原有焦点样式。

摘要容器用单列自然高度轨道和 gap，避免无布局盒的样式边界吞掉旧子元素 margin 或压缩滚动内容。SDK 暴露只读产品元数据和显式草稿/导航/文件效果。原生历史由 Core ChatController/Gateway 维护挂载投影；插件获得视图、状态及绑定当前挂载会话的受控发送端口，不获得控制器或新的 transcript 缓存。发送端口保留权限准备、原生身份与重连核验、运行计时及未知回执，旧挂载或插件 epoch 不能继续使用。Team 的成员独立发送通过该端口完成，业务准备和停止代次核验归插件。

资源通过宿主同源 hash/epoch URL 发布；不发布 Main 或 binding。开发代理使用本机私有 token 和有界专用路径。

工作区面板保持挂载以保留草稿，实际可见性通过 `AppViewContext.active` 传给插件。
来源会话的摘要、历史及首次创建 Team 均通过 `workspace.tab` 进入右侧原有 Tab。
每次明确打开增加 `selectionRevision`，使默认打开可以清除上次成员/子视图，普通切换 Tab 则保留状态。
没有有效来源的 Team 记录沿用主内容页，`application.page` 的常驻控制器通过 epoch 绑定的 `page.setVisible` 请求显示，不能改为大弹窗。

设置页临时遮住主内容但保留页面草稿；普通导航撤回页面和旧异步请求，插件关闭则卸载贡献。
Team 群聊只在可见时持有当前房间焦点；切换标签或关闭视图释放该视图自己的焦点，
不能清除后来打开的其他房间。隐藏面板不参与“当前可见群聊”的提问判断，重新显示
时恢复焦点与原草稿。MCP App 面板仅由宿主的稳定容器挂载一次，避免重复 iframe
注册和初始化。

`session.details` 可声明 `append`、`replace` 或 `hidden`；只有真实 Team 锚点替换普通详情。成员详情通过宿主重新读取实际会话 ID，保留 Native 身份、统计及返回，不导航到聊天或工作区；插件贡献失效后不能提交旧读取。插件设置的运行时参数链接通过通用导航服务打开原设置页。历史弹窗使用 SDK `OwnerDocumentProvider` 跟随点击窗口，关闭窗口或变更导航即撤销旧请求，不能把 Portal 固定到主文档。

### 目录、摘要和原生历史视图

Browser SDK 的完整会话目录只含轻量元数据，不含标题或正文；历史入口按该目录判断来源和锚点是否存在，再经有界 `ensureSummaries` 按需读取标题，不能用分页摘要判定历史不存在。通用 Native 历史视图保留控制器的准备中与准备超时状态，准备中不显示空历史或开放发送，重试仍交给原控制器。Team 公开镜像的精确定位判断属于 Team 的纯消息展示贡献；宿主只组合通用 `replyMirror`，按当前已批准产物的展示租约维护，不改写原生消息或建立执行结论。

摘要记录发现不依赖摘要是否已经展开。插件在常驻 `application.page` observer 中读取元数据，并通过 `session.presentation.summaryAvailable` 与上下文变更通知报告当前会话存在摘要内容；Core 仅用这一通用提示执行原有的单次自动展开。Team 自己保留当前聊天首次新建协作/讨论时打开 Team Tab 的行为，既有基线、后台会话和已关闭记录不会重复触发；Workflow 自己发现流程并显示摘要入口，不主动重开已关闭图形 Tab。

### 瞬时事件与视图刷新

插件 Main 可发布有界、瞬时元数据事件；通用桥填入 owner、产物 hash 和业务 epoch，Browser 仅投递给当前同版本插件，关闭或重启后旧监听立即失效。Workflow 自己校验原生变更和父会话身份，发布 revision 通知，列表订阅后读取并合并在途变更，不恢复轮询或专用宿主 IPC。Gateway 重连撤回旧业务 epoch，重新准入后视图重新读取权威状态。

## 验证入口与限制

宿主边界回归分别验证 SDK 消费、构建产物、资源发布、开发代理和真实原生桥。以下为可复现入口，运行条件与断言以脚本为准；脚本存在不表示本次或任意平台已通过：

```bash
node scripts/test/plugin-host/verify-portable-app-sdk.mjs
node scripts/test/plugin-host/verify-built-app-artifacts.mjs
node scripts/test/plugin-host/verify-built-browser-artifacts.mjs
node scripts/test/plugin-host/verify-development-assets.mjs
node scripts/test/plugin-host/verify-development-application.mjs --runtime <prepared-runtime>
node scripts/test/plugin-host/verify-native-gateway-bridge.mjs <prepared-runtime> --gateway-bundle --assistant-config-reload --block-public-network
```

隔离探针采用真实 Main/UI 产物、SQLite、Electron/Chromium 或锁定 Gateway，并按场景替代模型或应用端口。它们证明指定边界，不能替代真实业务模型、正式安装包或所有平台的验收。Team/Workflow 的业务回归及真实模型限制分别随[Agent Team](../features/assistants/agent-team.md)和[Workflow](../features/workflow/swarm-workflow.md)维护。阶段性修复过程和测试数量由 Git 历史追溯，不作为当前契约重复维护。

### 尚未完成的生产验证

- 当前内置交付保持安装、卸载入口策略。未来开放外部安装前，在正式 Windows 安装包完成 install → 应用代码审核 → 后台 Gateway 重新加载 → 启用 → 关闭 → 自定义新版替换 → 后台 Gateway 重新加载 → 卸载，整个过程软件保持打开。隔离公开 SDK/产物探针不等同于完整安装包验收。

- 用实际产品 UI 和真实模型完成 Team 协作、公开讨论、holding FIFO、成员续写、Workflow DAG/批量、取消、来源删除及关闭重启恢复。构建产物 smoke tests 的应用与模型端口 fixture 只证明插件接入。

- 验证签名安装包、macOS/Linux、升级后的持久化保留，以及长时间运行/反复启停的内存和监听器释放。Windows 开发代理的实际 Electron→Vite→Main 路径及同一 Gateway 中的启停已有专项覆盖，正式安装包与其它平台仍需分别验收。

- 在默认被动配置监听下继续验证任意配置文件改动与显式启停交错。插件和附属 Skill 的连续启停已通过实际 Gateway 验证，并以原生已应用配置修订确认收敛；任意外部改文件、跨窗口并发及长时间压力仍需单独验收。未知请求不自动重试。

- 复核 Windows MCP 进程树清理在负载下的确认：此前完整回归出现一次 `uncertain`，独立的 5 项握手/清理测试通过；保留原生严格判断，继续验证确认过程的稳定性。

- 若未来接入嵌入 worker/备用客户端，必须经同一公开插件请求桥及未知结果分类；当前 App Main 业务通过 canonical client，未宣称任意旁路客户端具有插件收据绑定。

- 独立设计低信任进程/iframe 隔离及免 Gateway 重启的 Native 二进制替换；当前只接受可信插件与 Gateway 冷包变更，软件无需重启。不将源码摘要称为原生执行字节证明。
