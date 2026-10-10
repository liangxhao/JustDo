# OpenClaw v2026.9.8 验收摘要

本页合并 2026-10-04 各轮升级验证的有效结论，删除重复流水与早期失败快照。以下结果只适用于当时受测代码与 Windows 运行包；本次文档整理没有重新启动 Gateway、执行模型请求或重跑这些代码测试。现行功能继续以架构、功能文档与实际实现为准。

## 最终自动化结果

完成协议/运行时修复和 17 项既有基线测试修复后，全量 npm test -- --maxWorkers=4 --reporter=dot 为 **652 文件通过、3 文件跳过；6622 项通过、46 项跳过、0 失败**。跳过数量没有因基线修复增加。构建、源码 lint 与差异空白检查通过；运行时/主进程变更的编译检查也通过，全量 wrapper 恢复并核验 Electron ABI。

17 项基线失败来自空内置模型 URL 的测试配置、旧 select 交互、tooltip 文案和过时全局动画断言。修复使用隔离模拟地址、真实组件交互与局部无障碍规则，补充空 URL 不请求/不发送凭据验证；没有配置生产模型地址、删除失败用例或以 skip 掩盖失败。新增回环 HTTP 模型用例验证目录、metadata、IPC 认证与凭据不返回 Renderer，但不证明真实供应商 JWT 或完整 Chromium 网络栈。

此最终全量结果不能与此前重叠的专项用例数量累加，也不代表后来所有代码变更均已再次通过全量检查。

## 实际执行范围

| 验证层次            | 已执行内容                                                                                                                                             | 证据边界                                                                                                                          |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| 正式 Windows 运行包 | 锁定原包重建、冻结证明、补丁、bundle/companion 与扩展预编译；标准 host 准备链和正式路径安装                                                            | 没有修改证明规避失败，不代表其他平台安装包已验收                                                                                  |
| 隔离真实 Gateway    | 协议/方法发现、会话创建；本地 SSE 模型触发 read，观察 Thinking/Tool/Content 与原生历史                                                                 | 模型为合成回环服务，不代表真实账号或付费推理                                                                                      |
| 待处理输入          | 21 条接纳、20+1 分页、重连；停止后的取消记录；消费后按正式 user identity 去重                                                                          | 证明原生协议与显示恢复，不代表专用队列管理 UI 已交付                                                                              |
| 任务、看板与记忆    | Cron CRUD、本地 command 执行及精确 run 回执，Workboard CRUD/评论/归档，FTS memory.search 与 models.list                                                | 不代替长时间定时 agentTurn、远程 embedding 或业务模型质量验证                                                                     |
| 凭据与配置          | 本地服务上的决策 file SecretRef 读取、轮换、失效阻断与恢复；权限/配置所有权回归                                                                        | 不证明真实 Decision/图像/视频服务可用；旧视频目录测试不代表当前随包清单                                                           |
| Gateway 生命周期    | 热加载和热重启保持进程，冷重启更换进程并保留原生会话状态                                                                                               | 合成隔离状态；真实忙任务/长期运行的延迟重启仍需验收，不保留单次启动秒数作为性能承诺                                               |
| 实际 Chromium       | 生成的扩展资源、真实 WebCrypto relay v2 认证与拒绝路径、重复 JSON key 拒绝；侧栏历史/发送/Thinking/折叠/回答/停止/pending 刷新                         | 回环 HTTP/WebSocket 与 Chrome API fixture，未安装完整 MV3 或执行 OS native-host 配对                                              |
| Electron guest      | 真实 BrowserWindow/webview、浏览器 IPC、人工介入取消排空/继续、可信输入、截图录制与密码保护                                                            | 临时 profile 和本地页面，不代表所有企业网站、上传下载与复杂跨域页面已验收                                                         |
| 完整 Electron 窗口  | 实际 Main/preload/Renderer 与 Gateway running/2026.9.8；首页、权限菜单、记忆、设置/模型/安全、插件、定时任务、Workboard 共 9 项检查，Renderer 错误为零 | 独立 appData/userData/home、未打包应用；页面能打开不证明权限副作用、审批决定或计划实施；基线测试修复未改生产逻辑，未重复 UI smoke |

SQLite 相关回归由统一测试 wrapper 串行处理 ABI 切换；浏览器、聊天与业务专项有交集，不另报累加总数。测试使用合成状态、临时工程与本地服务，没有读取真实用户数据库或使用已登录付费账户。

## 仍未完成的真实环境验收

- 真实语言、Decision、图像/视频及语音服务：鉴权、工具调用、思考显示、流式取消、默认继承与凭据失效恢复。
- Chrome/Edge 完整 MV3 安装、native messaging 配对、标签授权与撤销、浏览器/应用重启及多窗口恢复。
- Codex/Claude 已登录账号在隔离工程内的真实 ACP 工具执行、审批拒绝、停止和断线恢复。
- 真实长对话与多子任务：排队、跨助手导航、完成与取消、重建竞争、历史重连；三档权限下工作区内外写入及命令执行。
- 断网审批、过期/重复决定、Plan 修改与版本绑定批准后的实施交接；Goals 预算、暂停/恢复及跨重启续行。
- 长时间定时执行、真实忙任务的配置热加载与 deferred restart；确认无重复请求或冷重启争抢。
- Windows MXC 真沙盒、受管 pip/MCP、系统凭据 launcher ACL、真实麦克风/扬声器，以及完整 NSIS 与 macOS/Linux 安装产物。

原生 sessions.abort 缺少 expectedSessionId 的原子比较参数；客户端重读身份只能缩小竞争窗口，不能承诺跨 RPC 的原子取消。Plan 只读策略也不是未知第三方插件副作用的通用沙盒。源码审查、mock 与隔离真实进程各有不同覆盖，不能替代上述环境验证。

Worktree 与内网专项未完成验收继续见[Worktree 清单](../../plans/worktree-integration-plan.md)及[内网清单](../../plans/intranet-feature-acceptance.md)，完成后更新相应现行说明。

## 后续复验入口

复验使用最终锁定运行包、隔离状态和临时工程。常规门禁按 AGENTS.md 运行；运行时准备与证明检查见[补丁指南](../../openclaw-runtime-patches.md)。可按目标选择现有检查，不把检查脚本存在当作本次已执行：

- [Gateway 启动](../../../tests/openclaw/runtime/gateway-smoke.cjs)与[聊天流](../../../tests/openclaw/runtime/chat-stream-smoke.cjs)。
- [待处理输入](../../../tests/openclaw/runtime/pending-input-smoke.cjs)、[任务/记忆/模型](../../../tests/openclaw/runtime/tasks-memory-models-smoke.cjs)与[生命周期](../../../tests/openclaw/runtime/gateway-lifecycle-smoke.cjs)。
- [决策凭据](../../../scripts/test/verify-decision-secret-runtime.cjs)、[Chromium 扩展离线检查](../../../tests/browser-extension/chromium-offline-smoke.cjs)与[隔离 Electron 窗口](../../../tests/openclaw/runtime/electron-isolated-ui-smoke.cjs)。

具体参数和设备前置条件以脚本与当前开发指南为准。记录受测版本、平台、实际完成范围与剩余限制；不再追加重复的逐轮报告。
