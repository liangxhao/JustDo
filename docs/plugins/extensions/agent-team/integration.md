# Agent Team 宿主与 SDK 集成

本包分别提供 Native、桌面 Main、Browser 和纯历史展示入口。它们通过已安装的公开 SDK 接入宿主，不导入宿主源码、Plan Mode 实现或相邻业务插件。包根的 [package.json](../../../../plugins/extensions/agent-team/package.json)、[app.plugin.json](../../../../plugins/extensions/agent-team/app.plugin.json) 与 [openclaw.plugin.json](../../../../plugins/extensions/agent-team/openclaw.plugin.json) 是依赖、入口、能力和默认启用状态的声明；用户流程见[业务说明](guide.md)，表与恢复账本见[持久化](persistence.md)。

## 依赖、构建与代码信任

`@app-plugin/sdk` 提供 Main／Browser、规划状态解析及 Native 绑定端口；`@runtime-services/sdk` 提供必需的通用执行准入、inert custody 和精确收据核对。后者不理解 Team 模式、房间或讨论协议，也不反向依赖可选 Team。讨论输入、发起守卫和业务账本归本包。

独立依赖安装后由 `@app-plugin/build` 检查和构建，命令与测试条件见[验证说明](validation.md#独立包检查)。运行时装配消费完整的 Native/Main/Browser 配套产物，不读取宿主源码或在线安装依赖。公开 SDK 的安装、版本兼容与所选 OpenClaw 运行时须由使用方提供，构建成功不证明宿主已接纳代码。

Native RPC 仍要求 OpenClaw 的可信安装准入；桌面 Main/UI 的产物 hash 审核不授予原生信任。只读握手和写租约须绑定当前注册、真实 Gateway、原生客户端与代次。调用声明、插件 ID、目录存在及旧 proof 都不能替代当前权限。宿主按清单加载已批准的不可变产物；未知包变更和失效绑定撤回业务，不重放请求。

## Main 注册与运行所有权

[Main 入口](../../../../plugins/extensions/agent-team/host/app.ts) 注册插件 schema、命令、配置／提交／停止／删除参与者及维护任务。业务 store、coordinator 和队列使用 SDK 的实时窄端口读取同一实际 store/router；异步续体不能使用入口创建时复制的宿主状态。

桌面宿主继续拥有 SQLite 连接、产品会话、助手档案、权限准备、原生聊天控制器、Gateway、窗口和通用资源账本。Team 拥有房间、来源参与、FIFO、独立验收和发起政策。同库创建成员产品会话及房间元数据维持同步原子事务，原生请求仍在事务外执行。

用户停止来源时先同步撤销 Team 在途准入，再立即请求原生停止，不等待远端守卫清理。精确停止 ACK 也不代表执行或托管工具清理已完成。Main `maintenance` 只核对已经登记的 whole-run、摘要停止、holding 取消及持久清理任务；关闭后不派发新 FIFO、不读取待发正文、不创建汇总或成员。热关开复用同一协调器，不重复进程恢复或推进房间代次。

### 全队停止与成员单执行停止

协作标题栏通过插件命令 `collaboration.stop` 停止全队，来源自身已空闲时仍保留入口。同一房间并发全队停止复用同一组成员取消请求，先同步冻结协作轮次，再等待全部成员请求返回并报告失败；来源关联讨论同时进入自己的停止流程。一次成员取消失败不能让其余请求提前结束等待，也不能将部分成功显示为整队已结算。

成员实时工作详情通过公开 SDK invoke 调用 `collaboration.stop-member`，参数为 `sourceSessionId`、`roomId`、`targetSessionKey`、`nativeSessionId` 和 `runId`，不接受以助手名称或历史投递推导目标。插件 Main 命令绑定到 [协作协调器](../../../../plugins/extensions/agent-team/host/collaboration/collaborationCoordinator.ts) 的 `stopMember`，重新核对来源确为房间锚点、成员关系未删除及产品助手身份，再通过 `sessions.describe` 核对精确 native SID 与当前活动 run。

原生未提供完整 `activeRunIds` 时，只在已确认仍有活动运行的前提下读取有界 `chat.history` 快照，要求其 session、key 与 `inFlightRun.runId` 同时匹配；返回消息不保留为正文缓存。异步读取后再次验证成员归属，最后只调用 `sessions.abort({key,runId})`。旧 SID、旧 run 或成员替换均不能扩大为会话级停止或取消替换后的执行。

此路径不调用产品会话停止，不触发全队级联、不清空未来输入，也不关闭协作轮次；后续合法协作消息仍可启动该成员。响应须原生确认成功且状态为 `aborted` 或 `no-active-run`；`aborted` 还须携带相同 `abortedRunId`。`no-active-run` 也仅是该次停止请求的响应。停止 ACK 与精确 whole-run 终态、托管工具清理继续分别核对，失败保留原运行观察与错误提示。

## Browser 草稿与准备恢复

[Browser 入口](../../../../plugins/extensions/agent-team/app/browser/index.tsx) 注册模式、工作区、设置、历史、摘要、应用页与详情贡献；宿主只组合这些通用插槽。纯展示入口独立于业务启用状态，不能借展示恢复工具或读取额外历史。

SDK `uiState.get/set` 保存当前插件 ID/hash 隔离的有界 plain-data 草稿。正文、附件路径和未知请求定位可在关闭、断线或可恢复围栏间保留；真正卸载或更换 hash 后清除。草稿不保存 ChatController、回调、原生授权或 transcript，重新启用不自动发送或重开旧对话框。

Team 恢复准备时，保存的 attempt 锁必须仍匹配当前草稿。只有读取同一 `draftId` 房间明确为 `ready/prepare_failed`，且没有冻结的待发送请求，才解除准备锁；原生 metadata 不保存 UI attempt ID。缺失、断线、身份改变和发送结果未知均保持冻结。实现见[讨论草稿](../../../../plugins/extensions/agent-team/browser/discussion/teamDiscussionDraft.ts)，不得按超时自行生成新请求重试。

## Tab、主内容页与窗口焦点

来源会话的摘要、历史及首次创建 Team 通过 `workspace.tab` 进入右侧工作区。每次明确打开增加 `selectionRevision`，清除上次成员／子视图选择；普通 Tab 切换保留面板和草稿。无有效来源的历史 Team 记录使用 `application.page`，通过当前 epoch 的 `page.setVisible` 显示，不改成大弹窗。

设置页临时遮住主内容但保留页面草稿；普通导航撤回页面及旧异步读取。群聊仅在视图可见时持有该房间焦点，切换或关闭只释放本视图自己的 focus token，不能清除后来打开的另一房间。隐藏面板不参与“当前可见群聊”问题判断，重新显示恢复焦点与原草稿。

设置和历史弹窗使用 SDK `OwnerDocumentProvider` 跟随实际点击窗口，不能把 Portal 固定到主文档。窗口关闭、导航变更、插件停用或 epoch 变化撤销旧请求。

## 摘要、详情和纯历史投影

Team 的常驻 `application.page` observer 按需读取协作和讨论元数据，通过 `session.presentation.summaryAvailable` 报告摘要存在。发现不依赖摘要是否已展开；宿主只根据通用提示执行一次摘要展开。当前会话第一次出现新的协作或讨论时，插件可打开 Team Tab；已有基线、后台会话和用户关闭后的旧记录不重复触发。

完整会话目录只有轻量身份元数据，标题通过有界 `ensureSummaries` 按需取得。分页标题列表不能证明来源或锚点不存在。只有真实协作锚点替换普通详情；成员详情请宿主重新读取实际产品会话，保留原生身份、统计和返回动作，不导航到主聊天，也不把失效贡献的旧读取继续提交。

成员消息发送使用绑定当前挂载会话的受控发送端口，保留权限准备、原生身份、重连、计时及未知回执。Team 仍负责房间身份、全队活动和停止代次核验。旧挂载、错误成员或旧 epoch 不能使用该端口。

公开镜像归属的判断来自本包纯消息展示贡献。精确 `replyMirror` 定位只用于筛选已知 channel-final 镜像，不比较正文，不改写原生消息，也不建立执行结论。业务关闭时宿主可保留当前已批准产物的纯展示租约；包真正卸载、替换或身份未知时必须撤回。仅为历史清理保留的旧 owner 不发布新的展示。

## 完整活动快照与迟到结果

[会话投影](../../../../plugins/extensions/agent-team/app/browser/sessionPresentation.tsx) 只有在协作列表和群聊列表都完整读取成功后，才调用 `publishSessionActivity` 替换活动 ID 集合。新 epoch 的初始空数组、读取中或查询失败不能清除宿主保留的最后正证据；不同插件的集合互不覆盖。

活动投影组合真实成员运行和关联群聊状态。未结算的历史投递、pending 计数或房间 open/closing 本身不能证明成员仍在执行；取得完整当前空闲快照后才收起旋转提示，同时保留未确认回执。此提示不授予发送、不建立执行终态，也不是正文缓存。

Main 的瞬时事件由通用桥绑定插件 ID、产物 hash 与业务 epoch；Browser 只接纳当前实例的事件，重连后重新读取权威元数据。准备、保存、停止和导航的所有迟到续体仍需复核来源、原生 incarnation、请求 token 和当前权限。

## 部署与验收边界

独立构建与包内测试不证明桌面已经开放任意插件安装，也不证明真实 UI、多窗口、模型协作或权限竞争已验收。显式宿主集成和 Native 探针仍需要相符的宿主环境及准备好的原生产物；它们不会回退搜索兄弟仓库。可重复入口和未完成项统一见[验证边界](validation.md)。
