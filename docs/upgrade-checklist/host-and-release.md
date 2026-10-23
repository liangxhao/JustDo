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
- [ ] 幂等凭据重载的有界暂态重试与任务重试分开；持续失败仅对确切失败实例执行一次
      受控恢复，用户主动停止/退出及替代实例不被自动启动或停止。验证冷 PowerShell
      凭据解析预算、配置延迟重启及迟到 ACK，刷新失败需保留受控原因。

依据：[认证生命周期](../features/integrations/authentication-builtin-model-lifecycle.md)。

## Apps、Widget 与跨轮资源

- [ ] 对照 031：手动 App 准备与模型运行使用原生 ingress resolver 的同一持久工作区，
      下一轮、切会话再返回后编辑和资源仍可用；准备期间身份变化拒绝旧结果。
      首页预览被首条输入采用时保留精确原生会话，未采用的预览仅清理自有会话。
- [ ] App 文档/视图/update 身份、ETag 与订阅在原位更新、侧栏和独立窗口中保持一致。
      侧栏绑定精确 client/generation/sessionKey/非空 sessionId/docId；移动展示不新增
      Gateway 连接或权限。
- [ ] Widget 仍需真实 `show_widget` 和认证 HTML，只有 HTTP(S) viewer 广告能力。
      固定 viewer 的内存 browser session 使用配置代理，创建失败不降级主 Renderer iframe。
      超链接经受控会话浏览器打开；后续输入仍需人类确认进入既有草稿。
- [ ] draw.io 冷缓存、断公网时打开/编辑/保存/PNG/SVG/其他受支持导出，检查本地资源
      URL 避开 Chromium 禁用端口。界面布局、图标、插件侧资源规范不能代替原生权限验收。

依据：[MCP Apps](../features/chat/mcp-apps.md)、[交互回答](../features/chat/interactive-answers.md)。

## CLI、ACP 与 Chrome

- [ ] 普通 CLI、ACP、stdio app-server 及本地 WebSocket 只连接已有桌面实例，
      不另开产品数据库或 Gateway；安装版无外部 Node/首启下载依赖，中文/空格路径可用。
- [ ] 共享 app-server 路由保留端点能力隔离：Chrome 仅访问 browser-extension 来源，
      外部连接仅拥有其 external thread，客户端请求名称不能升级权限。
      CLI/app-server 支持子集不能被误写成拥有 ACP session MCP 或交互审批能力。
- [ ] 浏览器断线退订与 console、native-client WebSocket 断连及服务关闭的精确取消/drain
      按各自所有权验证；未知执行返回
      `EXECUTION_UNKNOWN` 并保留 run/session identity，不把断线/无 stdout 当成功或重试许可。
- [ ] ACP session MCP 绑定 exact leased native session 和写 scope，经 authenticated admin
      注册；external_mcp 每次一次性 plugin approval，即使 general full 也不能跳过。
      root、permission、incarnation 改变撤销旧授权。
- [ ] 安装版真实 Chrome Native Messaging 发现、鉴权、配对、连接/重连和流式进度单独验收。
      组件测试或开发环境连接通过，不证明 exe 安装后的注册和路径正确。

依据：[Agent CLI](../features/integrations/agent-cli.md)、[共享 app-server](../features/integrations/app-server.md)、
[侧聊](../features/browser/browser-extension-side-chat.md)。

## 插件发布、技能与离线资产

- [ ] 对照 034：仅原生 extension directory 安装中匹配 rename 的 EPERM/EBUSY 可恢复；
      同一 stage/backup/请求、固定本地 NTFS、目标不存在、原 guards/ownership 和每文件
      精确 bytes 均需成立，五秒总预算内重试。未知结果、发布后失败、远程卷或变更资产
      不重放安装；穷尽按原生失败与旧版本恢复处理。
- [ ] 安装进度、能力同意、启用与实际生效分开确认。市场安装默认启用仍受准入限制；
      父扩展包含 Skill/MCP/Hook 的组合、部分提交和跨页迟到回包都需回归。
- [ ] 技能刷新保留上游通用说明，适配仅围绕可用工具、原生提案、路径和离线依赖；
      不引入要求用户另装 LibreOffice 等运行条件。`skills_search/read` 的发现/权限与
      实际模型选择分开验收，不能只看技能目录存在。
- [ ] 所有来源按当前 `plugins/` 分类组装，运行资源在 `build/runtimes/`、下载缓存在
      `cache/`；重建指纹和安装资源不能继续引用已迁走的目录。
- [ ] Windows Gateway/worker 保留 `CHOKIDAR_USEPOLLING=true`，移除继承的统一 polling
      interval，使用原生按用途的频率；不把 Gateway 环境策略扩散到应用/CLI 基础环境。

依据：[插件系统](../architecture/07-plugin-system.md)、[Plugin Hub](../features/plugins/plugin-hub-experience.md)、
[补丁总账](../../scripts/patches/v2026.10.4/README.md)、[离线准备](../offline-downloads.md)。

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

依据：[启动与历史升级](../features/app/startup-and-history-upgrade.md)、
[现行说明与验证边界](../features/README.md)、[存储](../architecture/10-data-storage.md)。
