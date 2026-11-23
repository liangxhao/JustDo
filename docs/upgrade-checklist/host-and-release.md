# 宿主、插件与发行

与[总清单第 7–16 节](checklist.md)共同核对。

## 请求级凭据与配置生效

- [ ] 正常轮换先发布同一认证会话的派生快照并确认 `secrets.reload`，不先等待模型目录。
      配置同时变化时先确认对应 `configRevisionHash/appliedConfigHash`；单个 reload ACK
      或文件字节没变均不能代替同认证会话、同 Gateway 实例的实际加载确认。
- [ ] Runtime Services 的公开 `wrapStreamFn/wrapSimpleCompletionStreamFn` 在每次
      builtin 模型请求无缓存解析 SecretRef，同步替换 Bearer 与 `X-ACCESS-JWT`。
      用同一长任务跨 token 到期点验证；退出、同账号重新登录后旧任务拒绝借用新凭据。
      失败不回退旧 JWT，不重放聊天/工具，不影响自定义 provider。
- [ ] 幂等凭据重载的有界暂态重试与任务重试分开，前后核对同认证会话与 Gateway
      实例。验证 Windows 原生 ACL 检查所需预算、原生延迟重启与迟到 ACK。同步失败
      留待当前实例再次确认，保留错误原因，Main 不以此发起 Gateway 启停或重启。
- [ ] 启动恢复覆盖暂态验证失败、明确失效和同账号换证成功；退出或换号后迟到结果
      不写入新账号。模型详情或市场请求失败时保留已取得的可用模型目录，Gateway
      同步失败时保留已确认的登录或退出结果。
- [ ] 出站 Header 声明从已启用的原生 owner 加载，覆盖扩展 ID 大小写、停用/卸载后
      失效、规则重叠、换证和 URL 未命中。使用实际模型请求核对匹配、覆盖和隔离，
      同时核对 Windows 有效企业 CA 与无效继承路径下的默认信任链。

依据：[认证生命周期](../features/account/authentication-builtin-model-lifecycle.md)、
[登录 SDK](../features/account/login-sdk-template.md)、[出站请求头](../features/network/outbound-headers.md)。

## Apps、Widget 与跨轮资源

- [ ] 对照 030：手动 App 准备与模型运行使用原生 ingress resolver 的同一持久工作区，
      下一轮、切会话再返回后编辑和资源仍可用；准备期间身份变化拒绝旧结果。
      首页预览被首条输入采用时保留精确原生会话，未采用的预览仅清理自有会话。
- [ ] App 文档/视图/update 身份、ETag 与订阅在原位更新、侧栏和独立窗口中保持一致。
      侧栏绑定精确 client/generation/sessionKey/非空 sessionId/docId；移动展示不新增
      Gateway 连接或权限。
- [ ] 已加载的活动、暂挂和历史只读视图跨过初始 TTL 后仍能按原权限读取；续租保持
      原连接、视图和 owner，无需重建页面或重跑工具。关闭/detach 停止续租，过期、
      撤权或身份变化使旧调用失效；历史只读恢复不获得工具权限。
- [ ] 普通聊天的可选 App 上下文遇到断线、超时或无效视图时，原消息仍只委托一次。
      覆盖 Stop 和迟到更新，清理仅作用于本次 `updateId`。显式 App 操作继续核对原生
      授权和未知结果；历史预览、打开受管原文件及工具交付件各用已核验的资源身份。
- [ ] Widget 仍需真实 `show_widget` 和认证 HTML，只有 HTTP(S) viewer 广告能力。
      固定 viewer 的内存 browser session 使用配置代理，创建失败不降级主 Renderer iframe。
      超链接经受控会话浏览器打开；后续输入仍需人类确认进入既有草稿。
- [ ] draw.io 冷缓存、断公网时打开/编辑/保存/PNG/SVG/其他受支持导出，检查本地资源
      URL 避开 Chromium 禁用端口。界面布局、图标、插件侧资源规范不能代替原生权限验收。

依据：[MCP Apps](../features/chat/mcp-apps.md)、[交互回答](../features/chat/interactive-answers.md)。

## CLI、ACP 与 Chrome

- [ ] 普通 CLI、ACP、stdio app-server 及本地 WebSocket 只连接已有桌面实例，
      不另开产品数据库或 Gateway；安装版无外部 Node/首启下载依赖，中文/空格路径可用。
- [ ] 共享 app-server 路由保留端点能力隔离：Chrome 仅访问 chrome-extension 来源，
      外部连接仅拥有其 external thread，客户端请求名称不能升级权限。
      公共 app-server 目录不定义或依赖浏览器代码；ACP session MCP 不因共享执行后端而开放给 app-server。
- [ ] 通用 WebSocket 固定端口占用只影响该入口，Chrome 和 stdio 仍可用。保存的自动或
      固定模式保持，修改端口或令牌在应用重启后生效。外部客户端恢复原模型已下架的
      会话时，验证 `thread/resume` 显式选用有效模型以及后续 `turn/start` 的逐轮选择。
- [ ] 支持双向 RPC 的 app-server 只呈现实际发送 owner 的原生命令／插件审批；ACK 前暂扣的审批
      必须经实际 run 绑定后才展示。命令会话授权要求实验协商与明确选项，每次仍原生 allow-once；
      App 持久授权只接受原生明确 action。取消／断线／身份变化后旧回复不能授权，观察者不接管。
- [ ] 标准图片、图文及纯图片按真实字节和模型模态校验；localImage 限绑定 cwd，远程图片沿
      专属网络限制。纯图片 chat.send 没有 revision CAS，保留发送前后身份校验与未知提交预留，
      不用协议 Schema 通过替代真实视觉模型和原生审批验收。按目标 Gateway 限制实测
      单张图片字节边界和多附件总量。桌面与 Chrome 在超限拒绝后保留原草稿，外部入口
      返回明确拒绝。同一超限请求不自动重发。
- [ ] 浏览器断线退订与 console、native-client WebSocket 断连及服务关闭的精确取消/drain
      按各自所有权验证；未知执行返回
      `EXECUTION_UNKNOWN` 并保留 run/session identity，不把断线/无 stdout 当成功或重试许可。
- [ ] ACP session MCP 绑定 exact leased native session 和写 scope，经 authenticated admin
      注册；external_mcp 每次一次性 plugin approval，即使 general full 也不能跳过。
      root、permission、incarnation 改变撤销旧授权。
- [ ] 出站 ACP 子任务真实完成回传后，来源运行仍保留应有的工具权限；覆盖前后台切换、
      原生重新读取结构化 spawn lineage 及缺失/不匹配 lineage 的拒绝。外部长任务区分
      客户端等待、单 RPC 超时、断开后的取消请求与原生执行终态。
- [ ] 安装版真实 Chrome Native Messaging 发现、鉴权、配对、连接/重连和流式进度单独验收。
      迁移数据根后验证旧发现记录不能覆盖活动资料。组件测试或开发环境连接通过，不证明
      exe 安装后的注册和路径正确。
- [ ] Chrome 侧栏按标签保留各自会话、草稿与活动状态，切换或重开时旧响应不覆盖当前标签。
      绝对/相对文件链接及 `MEDIA` 经认证宿主打开，相对路径按当前工作目录复核，迟到、越界
      或不可用目标不会触发系统打开。
- [ ] Chrome 网页按钮覆盖真实点击、首次或重新授权后的手动发送、同窗口排队、同页
      未发请求替换和已发任务并行。准备或提交 ACK 丢失后按原 `requestId`/`launchId`
      核对。文档租约过期后由新的真实点击重新准入，旧请求不重放，旧文档、窗口和授权
      无权接管。核对 `onQueue` 与 `onActionRequired`；执行终态取自首轮精确原生回执，
      授权的最终正文和交付件描述也只取自该轮，文件路径、字节及其他轮次保持隔离。

依据：[Agent CLI](../features/external-clients/agent-cli.md)、[共享 app-server](../features/external-clients/app-server.md)、
[侧聊](../plugins/chrome-extensions/chrome-assistant/side-panel.md)、
[网页发起](../plugins/chrome-extensions/chrome-assistant/website-launch.md)。

## 插件发布、技能与离线资产

- [ ] 对照 033：仅原生 extension directory 安装中匹配 rename 的 EPERM/EBUSY 可恢复；
      同一 stage/backup/请求、固定本地 NTFS、目标不存在、原 guards/ownership 和每文件
      精确 bytes 均需成立，五秒总预算内重试。未知结果、发布后失败、远程卷或变更资产
      不重放安装；穷尽按原生失败与旧版本恢复处理。
- [ ] 安装进度、能力同意、启用与实际生效分开确认。市场安装默认启用仍受准入限制；
      父扩展包含 Skill/MCP/Hook 的组合、部分提交和跨页迟到回包都需回归。
- [ ] 在线卸载、同版本重新导入及更新先释放目标受管 MCP 服务，替换后按原启停状态
      恢复，无关服务继续运行。核对 040 跳过目标额外回滚副本时的原生失败语义与其他
      owner 的恢复。启停和查询复用原生清单、准入及回执；App companion 仍在装载边界
      核验独有的 hash 和能力。测试未知变更对账，无重复全目录复核或多余引擎重启。
- [ ] 卸载的数据清理仅对确实存在的受管数据提供，默认未勾选。原生卸载明确成功后
      再核对精确所有权和数据根；未知结果不删除，资料、会话历史和用户文件保留。
- [ ] 技能刷新保留上游通用说明，适配仅围绕可用工具、原生 Workshop 版本/变更、路径和离线依赖；
      同时扫描 bundled SKILL、角色模板和提示词中的已退役工具/RPC，不能只检查 TypeScript 调用；
      不引入要求用户另装 LibreOffice 等运行条件。`skills_search/read` 的发现/权限与
      实际模型选择分开验收，不能只看技能目录存在。
- [ ] 所有来源按当前 `plugins/` 分类组装，运行资源在 `build/runtimes/`、下载缓存在
      `cache/`；重建指纹和安装资源不能继续引用已迁走的目录。
- [ ] Windows Gateway/worker 保留 `CHOKIDAR_USEPOLLING=true`，移除继承的统一 polling
      interval，使用原生按用途的频率；不把 Gateway 环境策略扩散到应用/CLI 基础环境。

依据：[插件系统](../architecture/07-plugin-system.md)、[Plugin Hub](../features/plugins/plugin-hub.md)、
[App 插件运行时](../plugins/sdk/app-plugin-runtime.md)、
[补丁总账](../../scripts/patches/v2026.10.7/README.md)、[离线准备](../offline-downloads.md)。

## 旧版聊天记录迁移与首次启动引导

- [ ] 当前格式普通覆盖升级保留数据和设置；已发布 JSONL 代际或旧 `cowork_messages`
      产品库按现行引导走选择性备份和原生导入，
      不按安装版本号或旧初始化标记缺失强制迁移。未知、损坏、混合格式读取失败保留数据。
- [ ] 产品库备份包含已提交 WAL，原生历史/附件与标题映射分别核对；中断从已确认阶段
      继续，不重复替换环境。旧设置、凭据、插件和 cron 不导入新环境；历史正文不回写产品库。
- [ ] 核对目标版本 `doctor --session-sqlite import/inspect` 的参数、回执及导入语义。
      仅在最终规范 state 路径、Gateway 和外部聊天入口均停止时导入；导入后通过公开 SDK
      `getSessionEntry` 逐条核对 session ID 与 `spawnedBy`，身份或关联缺失不提交产品映射。
      未知导入结果保留阶段，由原生导入器核对；Main 不直接读写原生 transcript 数据库。
- [ ] 在 Gateway 停止边界验证原生导入、完整性、逐条身份与继续聊天；缺失工作目录和
      正文的恢复提示单独验收。旧产品消息仅作一次性历史来源，不重建 transcript 缓存；
      本功能不恢复撤回的 9.6→9.8 SQLite 桥。
- [ ] 旧历史导入覆盖置顶、分组、未完成工具和旧子任务；导入会话保持空闲，旧队列、
      Goal 和活动执行不会恢复。当前格式会话的原生重启恢复独立验收。

依据：[启动与历史升级](../features/app/startup-and-history-upgrade.md)、
[现行说明与验证边界](../features/README.md)、[存储](../architecture/10-data-storage.md)。

## Windows 安装和数据目录迁移

- [ ] 新装、双击覆盖和应用内安装更新分别核对安装路径。覆盖每用户/整机安装、盘符
      变更、失效及冲突注册记录。对符合条件的已确认本机每用户安装，验证同卷暂存、
      精确停止旧进程和中断回滚。回退旧卸载器前核对回滚结果及卸载器身份；保留用户
      资料和无关文件。
- [ ] 最终安装版以随包静态首屏承接 loopback 初始化，覆盖延迟可连、断连和重试；
      核对主 Renderer 仍走原不可变资源检查、CSP、导航守卫及 Chromium 沙箱 ACL。
      归档完整性检查覆盖内嵌载荷位于默认搜索窗口之外的安装包。
- [ ] 离线搬迁覆盖原生一致快照、目标规范准备、定位切换和锁文件收尾。切换前失败保留
      原活动根；切换后以目标为唯一权威，仅在源写入者退出后按本次记录清理旧副本，再
      重启。固定配置/升级备份与根外项目不随目录搬迁。验证二次搬迁仍从当前活动根开始。

依据：[Windows 安装器](../windows-installer.md)、[数据目录](../features/app/data-directory.md)。

## 启动与首响基线

- [ ] 替换前保留旧发行产物和可重复的样本。固定主机、Node、配置、启用插件、资料规模
      和模型条件，用隔离资料多次比较冷、热启动，记录样本和中位数。原样 npm 包的
      对照用于定位上游变化，安装版须用各自冻结运行时复测。
- [ ] 分开记录主界面可交互、Gateway 子进程启动到 `/healthz`、`/readyz` 和认证连接
      可用。普通新会话分段记录点击到可发、首次提交到接收、原生准备/排队、模型首事件
      和正文首次呈现。记录原生请求次数、分页及慢阶段，复验精确身份和 Stop，避免把
      被动读移出关键路径之后误认为发送准入已完成。
- [ ] 大量已有会话用截断启动快照验收恢复读取，补充页仅识别当前代次、精确身份的普通
      会话，Goal 或证据缺失时仍定点查询。Windows 启动内存错误只由当前进程代次的原生
      致命分配错误或启动 `ENOMEM` 确认，普通 GC、退出码或 readiness 慢分别诊断。

依据：[执行引擎](../architecture/05-agent-engine.md)、[聊天渲染](../architecture/15-chat-rendering.md)。
