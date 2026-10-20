# 应用插件分支：10.4 适配与公开 SDK 接入

## 当前方案：不新增原生补丁（2026-10-18）

应用插件改为只使用 OpenClaw 公开接口。原应用插件 030、配套原生 runtime helper、
Runtime Services 的 `app.runtime.inspect` 和专用补丁验证均已移除；相对最新
`dev` 基线 `ed2eb48c0`，`scripts/patches/` 与原生 support 模块没有本功能新增能力或改写。
保留 dev 自身的产品兼容补丁，包括工具调用恢复、MCP Apps 工作区、Goal 后继准入与
执行进度观察；它们与已移除的应用插件补丁不同，不因本功能同步而删除。

`@app-plugin/sdk/native` 为插件登记注册收据和普通 RPC；通用构建器自动包装入口。
插件自有 RPC 经公开 API 登记同权限的实例绑定入口，Core RPC 使用
`gateway-method-runtime` 的 authenticated-request 公开分发能力，不改 Gateway
schema，不导入私有 registry 或 instance。原方法和绑定入口的实际 owner、scope、
profileAccess 与 sessionAccess 通过公开 handler context 的只读描述符核对；
登记冲突或缺失均拒绝准入。真实执行、会话 incarnation/generation、
调用者权限、取消与提交边界继续由 OpenClaw 管理。注册 PID/随机 ID 与固定源码摘要
只用于 Main/Native 关联，不再宣称它们是实际 ESM namespace 执行字节证明。
可信且不可变的 Native/Main/UI 产物通过明确的 Gateway 冷变更流程准入。

软件保持打开。宿主预检业务和历史 owner 后确认旧 Gateway 退出，读取变更后的真实
清单，在原 Main 进程加载新 hash 对应的 Main/UI 产物，初始化相应 schemas，保留
仍有资源引用的原 hash 清理 owner，最后后台启动 Gateway 并核对新注册。
应用插件同包启停统一使用公开原生管理 API 热应用，禁止由宿主触发 Gateway 重启；
关闭即撤回历史、设置和其他业务入口。原本离线且没有
Gateway 的应用不因为审批准备启动运行时。停止未确认时不改包、不启动替代进程。

独立 review 修复并增加以下回归：

- 已进入 Native 派发后的异常可能已提交，通过严格关联当前请求的未知结果标记，
  保持既有 `CLIENT_TIMEOUT` / `requestSent: true` 分类，不清除发送围栏或重试。
- 导入的历史 cleanup owner 由原 registry 释放，避免错误 ALS 上下文跳过实际清理。
- 同一次改包还持有 `beforeDisable` 清理 lease 时，先归还 lease，再撤销旧实例。
- 客户端暂时断线但受管 Gateway 仍存在时，改包后仍恢复原运行状态。
- 临时清单错误单独围栏并允许后台修复；修复前仍检查已知运行任务，不清除资源账本、
  schema 错误或历史 owner 不明的保护，也不重试前一次未知操作。
- 原 hash 最后一项资源被删除或采用后，释放不再引用的本地清理 owner；释放等待该
  精确实例的所有变更/删除 lease 归还，重复访问同一 hash 不遗失 disposer。
- HELLO/健康检查早于配置稳定时，只重查公开只读握手并接收配置变更事件；不重试
  任何业务请求，防止重连后的插件入口一直不可见。
- 真实 Team 启动暴露了同步探针遗漏的问题：公开嵌套 dispatcher 在收到受理首帧后
  返回，导致随后仍在运行的 handler 过早失去 Native work-admission root。自有 RPC
  改走同权限直接入口，使完整 handler Promise 仍由实际 Native 请求持有；不以受理
  建立执行终态，也不脱离原调用者或提升为系统权限。

### 真实开发链路与热启停（2026-10-20）

实机入口缺失的直接原因是 Vite 将变量动态导入改写为带 `?import` 的请求，而开发
资源代理的路径校验拒绝了这个标记。Native/Main 握手和独立 Browser 产物测试均可
成功，真实 Vite 页面却收到 404，并在注册失败捕获中撤回全部视图和输入模式。
代理现仅剥离固定 `?import` 后转发已验证路径；其它查询、私有 Main/binding/清单
访问、错误方法及撤回后的资源仍拒绝。验证增加真实 Vite 转换，不能再以裸 URL
取回产物代替变量动态导入。

开发启动补充同批 Native/Main/UI 包准备：原生字节、清单和伴随产物匹配时不写入；
变更时先确认相关 Gateway 没有运行，再通过现有资源同步器准备。不能在旧 Gateway
仍加载相同路径时覆盖代码，不能静默用旧 Native 搭配新应用清单。

同包启停撤销下述 CLI 停启方案，改用 `plugins.setEnabled` 和 `skills.update`。
Skill 写入后只读核对原生配置修订与已应用修订、技能布尔值，防止下一次开关与
异步配置监听争用原生 lease。请求固定到现有客户端、进程及代次；断线或身份变化
直接失败，不调用会自动恢复 Gateway 的通用请求入口。不增加原生补丁，不延长产品
RPC 时限，不重发未知变更。丢失响应仅形成临时业务围栏，取得新的完整 Native 绑定证明后可以恢复
Main/UI；schema、资源清理失败的永久保护不因此解除。

多 Agent 复查进一步发现，开关收尾通知与 Renderer 重读仍经普通目录请求，断线时
可进入自动恢复。生产目录读取现固定到原客户端、进程及代次，只执行只读请求，
不调用 `plugins.refresh`；无连接或读取失败保留错误，不以缺少内置项的本地清单
广播禁用。界面保留上次成功目录，并在就绪通知到来时补读先前不可用的查询。真实
服务加 IPC 的断线回归覆盖调用前无连接、写入后失联及后续列表刷新；不模拟目录
方法，从而验证收尾链路也不能启动或恢复 Gateway。

直接 Gateway 探针在默认配置监听、公网连接被阻止、原有 RPC 时限下完成两个插件
的四次启停，只有初始一次 Gateway 启动，期间零停止。真实 Electron 开发应用也已
完成六次关闭、重新启用，PID 保持一致，原生 `[gateway] ready` 仅出现一次；
Main、preload、SQLite、Vite 转换、私有资源代理和 Browser 注册均使用实际代码。
真实按钮点击与完整开发应用回归入口为
`node scripts/test/plugin-host/verify-development-application.mjs`，不使用模型或用户配置。

最终专项回归为 450 项通过、0 项失败、1 项条件跳过；跳过项需要 worktree 相邻目录
中的原生浏览器源码，本轮真实 Gateway 与 UI 探针不依赖该路径。真实开发验收完成
“+”菜单、设置弹窗、历史弹窗的可见按钮点击与六次启停；每次切换均实际打开
“+”菜单核对入口，分别保持设置、历史窗口打开后关闭插件，先确认窗口撤回再
导航。重新启用后旧窗口不自动重开，入口可再次点击，Gateway PID 与唯一 ready
周期保持不变。实际 Windows
进程清单另验证中文/空格路径和另一条运行时目录联接：活进程存在时拒绝改包，原
Native 文件逐字节不变。lint、构建、Electron 类型及独立产物检查通过；未进行
真实模型、正式安装包或其它平台验收。

### 首轮 dev 实机修复（历史 CLI 方案，已被热更新替代）

开发布局的 `current` 是 Windows 目录联接。Main 发现时先固定受管运行时根目录的
真实路径，保留包内链接、Native 摘要与握手检查；实际产物验证覆盖通过该联接加载
两个插件及 Team 设置、历史贡献，避免把开发路径误拒绝为未准入代码。

实机日志随后确认两个插件握手成功，但运行中的 `plugins.setEnabled` 原生重载分别
耗时约 41 秒和 31 秒，超过单次 RPC 响应期限。旧恢复分支只查用户安装目录，因而
把捆绑插件误报为 `Extension is not installed.`，还可能重复执行已经发出的启停。

随软件捆绑、未被外部版本覆盖的应用插件改走确认停止 Gateway 后的公开 CLI，
同步其附属 Skill，释放停止 lease 后显式调用已有的启动与认证连接恢复流程。
原先离线且没有受管进程时保持离线；停止未确认时不写配置、不启动替代进程。
外部安装插件仍走原生能力审核。普通 API 的结果未知时不执行 CLI，也不自动重发。
没有增加原生补丁或延长产品超时。

本轮 12 个文件的 384 项相关回归全部通过，零失败、零跳过；包含外部包覆盖、停止
未确认、原先离线、连接恢复失败和未知请求不重发。实际 Electron Node 使用隔离
配置运行随包 OpenClaw CLI，两个插件的开启/关闭四项均通过；完整 Gateway 探针
另外完成初始启动及四次确认停止/后台启动，逐次回读 `plugins.list`，开启时核对
各自 `.app.handshake`。没有修改当前用户配置。最终构建、相关 ESLint、Electron
类型检查和独立 SDK/Main/Chromium/开发资源验证通过；未重跑全量测试或真实模型。

### dev 同步（2026-10-23）

从 `938a37c52` rebase 到本地 `dev` 的 `ed2eb48c0`，纳入 58 个提交，功能保持
单个 commit。插件源码、UI 和自有测试随 dev 统一迁入 `plugins/extensions/`；
Main 配置贡献接入 dev 拆分后的 plugins/policies 模块，保留模型、凭据、语音和
Widget Kit 的最新投影。首页工作区、原生执行进度、历史绑定删除与首页首次发送的
会话采用逻辑均保留。插件准备、schema 初始化和 Browser 注册继续服从真实启动、
历史恢复与 Renderer 偏好加载门禁。

真实完整应用发现了旧启动顺序的缺陷：插件发现早于 Core Store 赋值，触发新版
运行时目录访问门禁，发现失败后留下空插件清单。现在先完成原有历史保护和用户
数据准备，再打开并赋值 Store，随后发现插件和初始化 schema，最后创建资源服务
与主窗口；初始化进度窗口不受影响。没有移除历史门禁、提前启动 Gateway 或延长时限。完整开发探针在真实
窗口出现时立即断言两个插件都已发现，覆盖独立 Main/UI 产物测试遗漏的启动接线。

多 Agent 复查修复了目录层级迁移造成的构建根路径、误改的预编译脚本文件名、
稳定容器外重复挂载的 MCP App 面板，以及隐藏群聊保留焦点的问题。群聊按实际
可见状态持有各自的焦点 lease，切换标签保留草稿，旧视图释放不能覆盖新房间。
独立复查同时确认，最新凭据恢复逻辑不会让插件热启停或其后的目录读取进入
Gateway 自动恢复、CLI 或重启分支。

宿主与插件专项 105 个文件共 1,837 项通过、1 项条件跳过；跳过项依赖 worktree
相邻的 OpenClaw 浏览器源码。历史显示测试显式注册可选插件贡献，并跟进 dev 的
`model/input` 目录。配置测试复用一次本地插件库存快照，临时安装目录仍真实扫描，
保持原断言和超时。lint、完整应用构建、Main 类型检查和独立 SDK/Main/Chromium/
Vite 私有资源验证通过。

构建及运行时脚本另有 8 个文件、116 项通过。同步最终 dev 后，启动历史保护与
诊断领域 28 个文件、312 项全部通过；再次执行 lint、完整应用构建、Main 类型
检查和独立产物验证均通过。按每个文件最后一次执行汇总，本轮分批定向回归为
141 个文件、2,265 项通过、1 项条件跳过，零剩余失败；这不是全量 `npm test`
执行结果。原始执行与修复后的复测报告分别保留，不用复测结果改写原始报告。

完整开发应用探针用真实 `SqliteStore.create` 生成当前代隔离资料，以真实分类器
确认普通启动路径，再启动 Main、preload 和 Gateway。旧的手造 kv-only 数据库会被
新版启动门禁正确拒绝，不能用它代替合法的当前代资料。资料、工作目录和网络守卫
均属于探针；该探针覆盖正常资料启动后的热启停，首次安装与历史迁移另有领域测试。

该完整应用使用新建的空 Native 状态目录和公网阻断守卫完成六次启停；每次实际
点击“+”菜单核对 Team/Workflow 入口。设置与历史弹窗分别保持打开后关闭 Team，
弹窗立即撤回；重新启用不自动重开，卡片入口可以再次点击。Gateway PID 全程
一致，子进程启动次数与原生 ready 周期均为一次。点击等待只等待真实按钮可见且
命中，沿用原 30 秒界限，不隐藏启动遮罩或注入 UI 状态。

从锁定原始 npm 包重新提取源码，依赖通过本地缓存执行离线锁定安装，重新应用
dev 的全部 33 项补丁并完成正式 ASAR、bundle、资源、预编译及裁剪。12 项上游
契约与 33 项保留缺口核对通过，最终冻结文件及配方验证通过；没有复用旧补丁源码
或把历史 bundle 作为新构建证据。最终 Gateway bundle SHA-256 为
`f7e316a8b4363f3911d3ab36328d2ad2531657dfc03983f342770377f5f86631`。
全部运行时与资料均在当前 worktree 隔离准备，不影响其它 checkout 或用户配置。

收尾期间 dev 改写为 `ed2eb48c0`，原样保留凭据恢复并撤回专用诊断分类提交。
以新 dev 为基线重放唯一功能提交，没有带回已撤回的诊断代码。两个独立 reviewer
确认该差异不改变插件、Main 启动接线或 Native 构建配方；上述真实 GUI 与新运行时
对应的生产路径不变。

### dev 同步（2026-10-20）

从原基线 `70571b106` rebase 到本地与远端一致的 `938a37c52`，纳入 18 个 dev
提交，应用插件功能仍保持单个 commit。保留新 MCP Apps 宿主、语音扩展设置与
显式启停规则、启动准备进度、打包/离线改进，以及 Team/Workflow 的发起准备、
中性 Goal 快照判断和 Workflow 连续补充输入。迁移中的界面变更合入插件目录，
不恢复业务专属宿主 IPC 或直接 import。

Browser 贡献通过 SDK 自带图标，保留 dev 的 Team 图标一致性与 Workflow 图标；
Main SDK 的 Goal 执行投影保持真实 `goalId`、`phase`、`identityPending` 类型。
冷启动修复、公开 Native 请求桥及精确执行终态要求保持不变。未提交的 16 份文档
草稿独立恢复并逐字节校验，不进入功能提交。

Workflow 默认关闭由插件清单声明，配置同步继续保留用户显式开关。配置测试的固定
库存包含新增 draw.io，语音受限 allowlist、首次 TTS 注册和电脑工具禁用策略按
dev 的实际行为做精确核对。同步后相关回归为 137 个文件、2148 项全部通过，
零失败、零跳过；包含 Team/Workflow、Main 插件宿主、Native VM、输入框、历史、
配置同步和运行时资源接入。测试保持原时限，使用实际 Electron Node 与现有 ABI。
补充 MCP Apps 输入与文件入口、设置、问题及 Main IPC 的 7 个文件、33 项测试也
全部通过。最终 lint、应用构建、Electron 类型检查及 SDK/Main/Chromium/开发资源
产物验证通过；本节测试范围与下节此前的冻结运行时 Gateway 验证分别记录。

### 更新后的多 Agent 复审（2026-10-20）

三个独立 Agent 重新审查最新 dev 基线上的完整功能及 rebase 变化，分别覆盖 Main/SDK
权限与生命周期、Team/Workflow 执行语义、Renderer 和构建资源接入。发现并修复两项
P2，修复后交叉复核未发现其他可操作的 P1/P2：

- rebase 遗漏了语音扩展设置弹窗的清单清理。成功清单确认 STT/TTS 已移除后关闭弹窗；
  仅禁用扩展或清单读取失败时继续保留，防止将读取失败解释为卸载。
- Core 会话删除在等待插件预检时可能遭遇换包，后续删除错误地转交新资源 owner。
  删除与包变更现在互斥：删除在任何插件回调前同步取得 lease，包变更覆盖库存修复、
  预检、停止、替换和最终 Gateway 重连。两项问题都先用回归测试复现失败，再验证修复。

最终相关回归为 137 个文件、2169 项通过；补充 MCP Apps 和语音设置的 8 个文件、
38 项通过，共 2207 项，零失败、零跳过，保持原测试时限及现有 Electron ABI。
另有 12 项隔离场景通过，覆盖生命周期、Gateway 停止方法的进程替身、离线恢复、
包预检否决、旧清理 owner、结构化输入、Workflow 资源及插件源码独立改写构建。
最终 lint、应用构建、Electron 类型检查，以及实际 SDK/Main/SQLite/Chromium/
开发资源产物检查通过。16 份文档草稿逐字节保持原样且不进入提交，功能仍保持单提交。

本轮没有重新构建 dev 的 30 项原生运行时或重跑真实 Gateway/模型、正式安装包；
下节的 29 项冻结运行时与 loopback 模型证据仍属于此前验收，不替代当前组合的运行时验收。

### 初次构建与验证证据（2026-10-18 至 19）

从锁定的原始 npm 包重新解压，使用独立离线依赖、原生 facade 和基线 29 项补丁
完成新的 Gateway bundle、资源同步、扩展预编译和裁剪，未复用旧的 030 运行时。
源包 SHA-256 为
`0a41c2ed708abc812498de58d71d058dde322700488d6e8062c7c070dfdca6dc`。
冻结清单验证 29 项通过；`gateway-bundle.mjs` 为 77,168,057 字节，SHA-256 为
`23c8298de7a6e8b5a611c88c44076a02915633e81d9591dfae0645b5db87b945`。
独立构建目录未替换开发分支使用的 current 运行时。

- 真实 Gateway / 公开 SDK / 实际 Main manager 探针，在 Node 24.21.0 和
  Electron 42.7.0 / Node 24.18.0 各通过 16 项检查：使用最终预编译、裁剪和冻结校验
  后的运行时、独立空缓存、隔离状态与
  loopback，以 Node 传输守卫拒绝非回环 TCP、UDP、DNS、HTTP(S) 和 fetch；全部
  Gateway 退出后的守卫审计均为零次非回环尝试。此守卫不等同于操作系统防火墙。
  两种运行时均完成冷启动及三次后台重载。
- 验证实际 Native 写入只发生一次、伪造注册/PID 无副作用、目标方法权限及错误元数据、
  已提交后的异常仍保留未知结果。原入口和绑定入口提前 ACK 后的权限及可选 guard
  一致，并核对真实 profile/session 准入。断连本身不被当成权限撤销；用公开设备配对与
  token revoke，在等待中的写入恢复后确认提交检查明确拒绝，且无副作用。
- 关闭、重新启用和新版替换分别重启后台 Gateway；实际 Main 进程 PID 保持不变，
  新注册和新业务 epoch 生效，旧请求、旧 UI 资源及旧注册不能获得新版本许可。
- Team 历史专项使用真实 Main bound client 执行产品 prepare/start/status/history。
  受理首帧之后，两名成员均取得严格匹配 sessionId、lifecycleRevision 的 Native
  完成结果；关闭历史入口拒绝访问，Runtime Services 独立收据仍可核对，后台重启
  Gateway 再启用后历史消息逐条完全一致。模型为 loopback fixture。
- 早期完整 Team tool/CWD 探针在原 30 秒中止 / 45 秒 RPC 预算内未完成最终
  投递；旧 030 source CLI 对照也超时，不是旧 bundle 的性能对照。后续 CPU 与
  文件调用采样定位到大量目录观察守卫和跨助手数据库 Worker 切换，不能仅凭
  started/settled 计数把这类失败记为成功。
- 插件让每名普通成员经过独立完整公开 channel dispatcher，由 Native group-thread
  保持轮次、提及和策略；许可提前到整个成员流程，覆盖入站准备、执行、投递及
  custody 清理。已接纳但缺少精确 whole-run 终态仍关闭本批准入，迟到终态不重开。
  没有删除身份、权限或提交守卫，没有变更原生 Worker、watcher 或编译缓存实现。
- 探针按产品布局拆分 config、各角色 home 与项目目录：config 父目录不再是共享
  OS 临时目录，角色 home 的父目录也不再混入 SQLite/WAL、日志及运行时文件。
  使用实际桌面启动环境，保留 Windows 500ms polling；连接与 Main 一致，使用
  受管 loopback token 和 `deviceIdentity:null`，不在探针进程创建另一套 Native
  state writer。SDK 注册就绪前只读握手，不预热模型或技能、不增加补丁。
- 目录修正后的多轮空状态冷执行在原 30 秒中止 / 45 秒 RPC 预算内通过；目录
  对照为 9.174、17.116、19.148 秒，完整成员许可修正后的最终代码为 12.285、
  12.587 秒；后一次启用同一 Node 传输守卫阻断非回环 TCP、UDP、DNS、HTTP(S)
  和 fetch，Gateway 退出后审计为零次非回环尝试，不等同于 OS 防火墙。
  每次均校验两名成员的精确 sessionId、
  lifecycleRevision、runId、whole-run 完成结果、项目读取和原生历史投递引用。
  技能三次修改及原子移出仍在原 5 秒窗口内被发现。组织者上下文测试按 Native v4
  的 quoted conversation data 解码身份，Plan 拒绝测试使用产品实际读取的
  `pluginExtensions['plan-mode'].state`，不改变原生 prompt 或授权。
- 最终完整 Team 探针由实际 Gateway 向 loopback 模型发出 60 次请求，覆盖工具/CWD、控制指令
  拒绝、精确历史、原生取消、并发容量 1/2/6、ACK 重放、消息工具、真实 Main
  组织团队、来源参与/退出/删除后的公开历史、自动汇总、细粒度权限与 Plan 拒绝、
  独立验收身份和终态。来源参与连同历史读取在严格原 25 秒内完成，用时
  18.430 秒；状态请求使用剩余预算，到期后重读到 completed 不能补成通过。
  关闭后历史入口拒绝，再启用且后台重启 Gateway 后历史逐条相同；实际 Alice
  workspace 的三次技能 revision 均被 Native 发现，发布链接持续存在。
- 最终源码的完整回归为 11,457 项通过、2 项失败、67 项跳过，953 个文件；两项
  失败均为既有配置同步测试超过默认 5 秒时限。全部大型检查退出后，以相同 Node
  运行时、原断言和原时限单独重跑，两项分别约 0.96 秒和 1.83 秒通过。没有放宽
  时限、删除或跳过失败用例，也不把定向复测表述为整套回归全绿。
- 该完整回归包含最终 Native SDK 的 45 项测试及两组 Native VM 的 143 项测试。
  模块图负控另验证不透明动态依赖被拒绝，以及依赖改动导致入口和伴随产物身份改变；
  其独立 Node 模块导入 fixture 不模拟真实 Gateway 权限，后者由上述实际探针验证。
- 2026-10-19 冷启动修复后，使用实际 Electron Node 与现有 native ABI 定向运行
  Team Main/UI、Team/Workflow Native VM、Native 请求桥与绑定相关测试，
  71 个文件、1195 项全部通过，零失败、零跳过。包含完整成员许可的 15 项边界
  回归；这次定向结果不改写前述完整套件的历史失败记录。
- lint、应用构建、Electron 编译、13 个独立 SDK 子路径加载、真实 Main/SQLite
  产物和 Chromium 界面/资源边界验证通过。包含禁用后移除历史与设置贡献、保留活动
  正证据、新 epoch、单例 React、Renderer 无 Node 及不可发布 Main/binding 文件。
  上述构建与产物检查在冷启动修复后再次通过；冻结运行时的 29 项校验也再次通过，
  bundle 字节及 SHA-256 保持不变。

以上使用隔离的请求/模型端口 fixture，不等同于正式安装包与实际模型业务验收。

本节之后是此前补丁方案的历史构建和 review 证据，**不能作为当前公开 SDK 方案的
验收结论**。当前契约以[应用插件宿主](../../architecture/17-app-plugin-host.md)为准，
剩余正式安装包和真实模型验收见[验收清单](../../architecture/17-app-plugin-host.md#验证与剩余验收)。

本记录针对独立 Native / Main / Browser 应用插件分支。基线为 `dev` 的
`4241027a6`，OpenClaw 源码核对 `v2026.10.4` / `383c124cc32`；发布产物使用
[source-lock.json](../../../scripts/patches/v2026.10.4/source-lock.json) 锁定的原始 npm 包。
前面的 28 项升级验收属于 `dev` 基线，不作为本分支新产物的验证结果。

## dev 同步

后续 rebase 到 `dev` 的 `92da9f218`（包含本地最新 Widget 提交）；远端 `origin/dev`
为其直接前序 `7954f39b9`。OpenClaw 仍为 2026.10.4。保留 dev 新增的 029 reasoning
streaming，本分支原接入补丁顺延为 030，合计 30 项。下文 29 项运行时及 bundle hash
是首次适配的历史证据，不作为这次合并后的新运行时构建证明。

Team 的成员独立发送通过挂载原生详情提供的受控端口完成，业务准备与 stop generation
核验仍在插件内；宿主不向插件暴露 ChatController。保留原生不明回执、断连及重新准入
的拒绝语义。Workflow 活动快照与摘要查询经插件命令注册，按需显示和可见性检查继续归
插件。通用会话列表合并不共享携带插件实例绑定的请求，防止借用其他调用方的回执。
Main 宿主以真实 runtime/client 对象为键复用受控包装，保持身份复核有效；不缓存
原生状态，也不让旧连接的包装隐藏实际替换。真实 Main 产物另验证两种轻量查询。

此次 rebase 的专项回归为 2,182 项通过、0 项失败、11 项跳过；补丁清单及原始
契约 fixture 另有 12 项通过。lint、应用构建、Main/Renderer 类型检查、Electron
编译及独立 SDK/Main/Chromium/开发资源检查通过。未重跑全量套件，也未从 pristine
重建合并后的 30 项运行时，因此不把旧运行时探针视为新组合的证明。

## 更新 dev 后的独立 review（2026-10-18）

三个独立 reviewer 分别检查 Main 生命周期与权限、插件 UI 以及原生接入和打包，并交叉
复核修复。发现并修正以下问题：

- 普通 `electron:dev` 也先构建独立应用插件，避免直接启动时找不到 Main/UI 产物。
- 插件退役撤回历史、设置、详情、导航和消息展示贡献，但保留最后一次成功确认的
  活动会话 ID。新 epoch 的初始化或失败读取不能清空该提示；只有当前实例的完整
  成功快照才能替换它。Team 同时等待协作和讨论列表准备完成，Workflow 消费原生
  活动快照。宿主只保留按插件隔离的 ID 集合，不保留旧 resolver 或插件 UI。
- 停止 Gateway 超时后，确切的当前子进程退出事件可以解除相应的不明变更围栏；
  旧子进程的延迟退出不能释放新 owner 的围栏，包变更租约仍独立保护冷操作。
- 030 校验完整 ESM 语法时按顶层语句释放无关 AST，只把受保护函数和 schema 的
  声明/赋值片段交给既有 TypeScript 及词法 owner 比较。保留唯一性、原生接线、
  schema 字段和损坏状态零写入拒绝；没有新增补丁文件或放宽补丁行数预算。

真实 Chromium 产物检查覆盖两类插件停用后的活动提示保留、历史等 UI 贡献撤回、
重新启用后读取失败继续保留，以及成功空快照清除提示。独立 SDK、实际 Main/SQLite、
开发资源检查、lint、应用构建和 Electron 编译通过。

完整回归为 11,396 项通过、1 项失败、67 项跳过，不记录为全绿。失败为 Windows
MCP/Chrome 测试的原生 attach/进程查询超时；本轮停止重构建后独立复跑同文件，
5 项全部通过。此前另一次完整执行的技能 CLI 超时也已独立复测通过。未修改原生
握手、进程清理或超时断言。

030 的 61 项定向测试全部通过，维持默认每项 5 秒限制，覆盖原有正负控、范围外语法
错误、重复/嵌套声明及赋值、字符串/正则/模板假锚点和失败不写入。

本轮最终 30 项运行时重新从锁定 tarball 提取全部源码，依赖使用本轮成功安装产生的
精确 shrinkwrap 执行 `npm ci --offline` 全量重装，未沿用已裁剪或带补丁的依赖树。
原始包的 12 项上游契约和 30 项保留缺口核对通过；重新应用全部补丁、使用安装器原有
helper 归档后，正式 bundle 脚本在默认堆配置下成功，耗时约 209 秒。随后正式资源同步、
插件预编译、裁剪和 30 项最终补丁校验通过，配方及补丁摘要与当前源码一致。

单独的 030 只读校验测得约 16.1 秒、峰值 RSS 339 MiB；这不是整套构建的峰值。
此前一次默认构建异常退出、随后 8 GiB 堆构建成功，不能据此确定异常根因；优化后
完整默认构建已成功，不依赖提高堆上限。最终 bundle 的 SHA-256 为
`db3f83a710f65cee9a82ab78d3071b1a6eb8bd7da01b39a45205270dd585ccf5`。
本轮使用 worktree 内的隔离运行时验证，没有替换其他 checkout 的运行时或用户配置。

在这份最终静态产物上，实际 Gateway 的匹配请求、伪造身份零副作用、旧实例失效、
关闭/重开及三种等待后正负控制通过；10 处原生接线/最终 bundle 损坏对照全部拒绝且
原文件不变。8 种流式 transport 场景通过，实际 Windows MCP/Chrome 的 5 项测试也
通过，明确使用新的 30 项运行时目录。真实 Electron 内置 Node 24.18.0 的 bundle
冷入口、执行字节收据和只读查询通过。

Electron 预跑曾在功能断言完成后遇到临时目录 `EBUSY`；探针现在从 spawn 起记录
各子进程的 close Promise，在清理时等到包括 stdio 在内的关闭，并仅对路径已双重
验证的临时目录执行有界删除重试。没有修改原生权限或业务断言，清理最终失败仍
使整条探针失败。正式安装包、真实模型和默认配置监听交错等生产验收仍见下述清单。

review 收尾期间 `dev` 又更新至 `70571b106`，本分支已追加 rebase；独立 reviewer
确认仅合入该基线的模型文件锁及测试稳定性变更。Vitest 冲突同时保留基线的两个
worker 和插件的 resolver、测试范围、setupFiles；原有配置策略断言未丢失。本功能
仍为该基线之上的一个提交，原生配方未变化，前述 30 项最终产物校验继续通过。

该基线上的最终串行标准 `npm test` 完整回归为 11,383 项通过、0 项失败、109 项
按环境条件跳过，并成功恢复 Electron ABI 146。比之前多出的 42 个跳过项均属于
需要显式 `APP_PLUGIN_PRISTINE_DIR` 的原生接入专项，前述 61 项专项独立验证包含
这些测试，不把条件跳过当作通过。追加 rebase 后再次传入原始源码和最终 30 项
运行时目录，61 项全部通过、0 项跳过。最新基线的 lint、应用构建和 Electron 编译通过。
review 期间后来出现的 `dev` 提交 `497c970e9` 涉及新的工具调用恢复原生补丁，不在
本轮基线或验证结论内。

## 收敛结果（历史补丁方案，已被替代）

旧应用插件分支在 9.8 目录增加三个补丁和两个补丁辅助文件。本次全部移除，历史
9.8 总账恢复为 `dev` 的记录；10.4 新增一个
`030-app-plugin-native-binding.cjs` 接入补丁（现已删除）。
普通实现放在
`app-plugin-runtime.mjs`（现已删除），
由原生接入代码显式传入真实状态 owner，纳入构建配方、复制字节和最终产物校验。

| 旧分支能力 | 新版承担方式 |
| --- | --- |
| 044：请求所属 Gateway / generation / instance 投影 | 030 暴露窄 SDK 门面；普通模块读取原生 registry、实例和 invocation，不建立第二份注册表 |
| 045：canonical 请求绑定 | 复用 10.4 原生 handler authority、admitted-input 和 mutation custody，传入实例检查；保留设备/profile 授权和配置过渡拒绝 |
| 046：实际执行入口字节收据 | 普通模块在真实 Node24 ESM 加载时签发收据；030 接入原生共享加载器和 retained namespace 复用途径 |
| 旧版四份请求 schema 修改 | 新版只有一份共享 `RequestFrameSchema`，不再修改三个旧 worker/recovery 副本 |
| 手工重复的等待后检查 | 交由新版已有的 handler lifetime 与提交检查消费同一围栏，保留授权后和真实提交边界的校验 |

这不是通过删除身份检查减少文件数。原生已具备的控制流被复用；仍缺少的能力保留
窄接入。仅凭插件注册回调、自报版本或磁盘 hash，无法证明当前 Gateway 的实际实例
和已经执行的 namespace，因而不能把这一接缝改成可关闭的普通插件。

通用词法比较归入现有 `prepared-read-patch-shapes.js` 构建校验工具；030 为 578 行，
继续遵守仓库对普通补丁的 600 行上限，没有扩大行数例外。

Team、Workflow 的业务与界面继续归各自插件。Runtime Services 只消费公开 SDK，
不导入应用 `src`。`dev` 的 SQLite 交接修复、scoped finalize admission、群成员面板、
引用卡片和发送快捷键一并保留；快捷键通过通用 UI 服务供插件使用。

10.4 的请求上下文模块是执行帧的无状态视图，不再把整个模块设为 bundle 外部依赖。
共享实际的 invocation / execution frame 及其 class owner，SDK 和 Gateway 仍读取同一
异步上下文；普通 getter 留在 bundle 中，避免额外导入别名破坏原生执行权限补丁的
精确检查。回归测试同时验证跨 SDK 的同一帧身份、异步传递、离开作用域后的清空，
以及未共享状态的对照 bundle 无法读取该帧。

## 首次 10.4 适配的验证边界

专项测试覆盖原始包拒绝、首次应用、重复应用字节不变、混合/历史/损坏状态零写入
拒绝、真实协议 schema、Gateway/代次/实例变化、关闭和配置过渡，以及原生设备
授权保留。格式化 bundle 对照会改变 owner 参数而保留调用数量，确认校验实际绑定
和调用位置，而非只检查标记或计数。

真实 Node 模块加载负例覆盖冷入口、磁盘换码、未登记的预热 namespace、跨 URL
导出对象复用和加载失败。应用产物检查使用实际独立 Main 包、SQLite、BrowserRegistry
和 Chromium，核对设置、历史摘要发现、启停撤回及旧 epoch 拒绝。

本轮已完成以下检查，全部使用隔离配置和合成请求：

| 范围 | 结果 |
| --- | --- |
| 原始来源 | npm tarball 的 SHA-256 / integrity 与 source lock 一致，13,355 个源码文件逐一核对字节 |
| 新补丁 | 37 项测试通过，包括真实协议边界、直接/延迟初始化 schema、词法改名及错误借用外层同名变量的拒绝 |
| SDK 状态共享 | 3 项通过；共享真实执行帧和 class owner，无状态 getter 保留正常打包 |
| 最终运行时 | 原始源码重新应用补丁、ASAR、Gateway bundle、资源同步、插件预编译和裁剪完成；29 项最终补丁校验通过 |
| 最终 bundle 拒绝对照 | 10 处原生接线/复制模块/最终 bundle 损坏均被只读校验拒绝，未修改实际文件 |
| 实际 Gateway | 冷入口、复制 SDK 身份、只读 RPC、显式关闭/重新启用、旧实例和伪造实例拒绝均通过 |
| 真实副作用边界 | 有效请求及三种等待后有效请求能执行；关闭后的 commit / authorization / caller 检查均拒绝旧请求，新增副作用为零；有效身份仍不能获得缺少的 operator scope |
| ESM 缓存和换码 | 未登记的预热 namespace 不签发收据；已登记缓存保留首次字节；外部 JavaScript 换码后，新捕获代次具有自己的入口字节收据 |
| 多 Gateway | 同进程两个 Gateway 的 owner 相互隔离，跨 owner invocation 被拒绝 |
| Electron | 真实 Electron 内置 Node 24.18.0 启动最终 Gateway bundle，入口字节和只读查询通过 |
| 应用产物与文档 | 独立插件类型检查、实际 Main/SQLite/BrowserRegistry/Chromium 检查及开发文档示例验证通过；lint 与应用构建通过 |

通用校验工具整理后已再次重建。最终 Gateway bundle 的 SHA-256 为
`bce5564c63e6b0012bcfbc79969053e4cbcacda4cd147e13d26d51489296ae74`，
与上述真实 Gateway / Electron 探针使用的产物逐字节一致。

标准运行时安装命令曾在 npm 依赖解包阶段超时，该命令不计为通过。后续复用本轮
已完整安装、同源同平台的依赖快照，验证 package / shrinkwrap 的实际 hash 和原始包
转换一致，再从锁定 tarball 的字节重新生成全部源码。归档使用现有安装器 helper，
后续 bundle / plugins / resources / precompile / prune / patches:verify 使用正式脚本。
新构建重新计算来源、配方和产物摘要，记录 `dependencyReuse`；未复制旧补丁产物或
旧验证清单作为新产物的证明。

显式 API 探针设置 `gateway.reload.mode=off` 以隔离被动配置文件监听；已对照 10.4
原生 `config-reload.ts`，该设置不跳过显式 plugin lifecycle 的原生应用和权限检查。
默认监听的预跑观察到配置过渡拒绝和 `config reload superseded`，未自动重试该变更
请求，也未把这些预跑记为通过。自动监听与显式启停交错、正式安装包、真实模型任务
及其他平台仍按[应用插件验收清单](../../architecture/17-app-plugin-host.md#验证与剩余验收) 分别验收。

最终 Electron TypeScript 编译通过。低并发完整回归命令为
`npm test -- --maxWorkers=2 --testTimeout=20000`：10,697 项通过、1 项失败、70 项跳过，
因此本轮完整套件不记录为全绿。失败是 Windows MCP/Chrome 原生进程树清理返回
`Chrome MCP subprocess tree cleanup could not be verified`；独立运行同文件的 5 项
测试全部通过。保留原生 `uncertain` 的严格判断，负载下可靠确认清理仍需续验。
此前补丁行数预算和技能 CLI 超时的两项失败经整理/独立复测后，与新增补丁一起的
52 项检查全部通过。未修改行数预算、CLI 时限或握手/清理断言。
