# OpenClaw 9.8 主目录安装与详细验收

日期：2026-10-04。本文承接[升级复核总报告](review-v2026.9.8.md)，记录用户要求释放占用后，在正式运行包路径上的追加测试。

## 安装结果

已核验并释放Codex持有的旧 `dist/agents/auth-profiles` 目录句柄，没有结束整个Codex进程。目录重命名及恢复验证通过。先前安装失败保留了旧目录；随后将已从锁定原包完整构建的9.8运行包复制到同级临时目录，核对当前工作区补丁、构建规则和冻结产物证明，使用项目 `commitStagedRuntime` 原子替换正式目标。

正式目录为 `vendor/openclaw-runtime/win-x64`，`current` 指向此目录。标准 `npm run openclaw:runtime:host` 随后整链退出码0，9个本地扩展编译、0错误，23个补丁验证通过。整个流程没有原地套用旧补丁或修改版本／证明清单。

## 后续范围调整与历史记录

9.6 未发布，用户明确要求删除本次新增旧数据兼容。9.6→9.8 SQLite 迁移桥接、启动门禁、专项测试脚本与独立构建资产均已移除，不属于现行能力。

此前真实窗口曾发现迁移独立入口遗漏于 Vite 产物，当时补齐资产并完成 Electron/最小 ASAR 检查；该修复现随整个迁移方案撤回。此历史发现不再构成当前打包要求。以下其余真实 Gateway、浏览器及页面证据保留，原有统计属于当时运行，不能混充删除后的再次全量测试。
## 功能测试

| 范围 | 实际执行 | 结果与限制 |
| --- | --- | --- |
| 聊天与工具 | 主目录Gateway连接本地SSE模型，调用原生read，再读取原生history | 通过；2次模型请求、thinking/item/tool/assistant等实时流、5条历史消息；不代表真实供应商账户 |
| Gateway能力 | 主目录Gateway协议、方法发现、会话创建、进度刷新和ACP诊断 | 通过；协议4、480个方法 |
| Cron | 原生创建、修改、手动command运行、runId对应成功回执、删除 | 通过；没有用模型请求代替定时运行 |
| Workboard | 原生卡片CRUD、评论、归档 | 通过 |
| 记忆与模型 | 原生FTS memory.search与models.list | 通过；语义embedding和真实供应商推理未调用 |
| 决策凭据 | 实际Gateway和SDK读取file SecretRef、轮换、失效阻断及恢复 | 通过；本地服务，不请求付费账户 |
| 原生执行权限 | 正式9.8 runtime的Full/read-only文件系统与审批策略、编辑payload后权限保留、bundle后的授权守卫 | 3项通过；不替代真实用户点击审批对话框 |
| 视频目录 | Kie、Z.AI、Novita激活、配置验证、工具和模型发现 | 通过；外部提供方请求0，未生成真实视频 |
| 浏览器扩展 | Chromium149中的真实WebCrypto认证、拒绝路径、loopback WebSocket侧栏历史／发送／思考／折叠／回答／停止 | 通过；Chrome API为测试替身，不冒充完整MV3 native host配对 |
| Electron人工接管 | 真实BrowserWindow/webview、BrowserAgentBridge IPC、取消排空、手动输入保留、恢复、重复操作拒绝、关闭最后标签后的恢复 | 通过；临时独立profile和本地页面 |
| Electron录制 | 真实guest截图、可信点击及HTML、媒体／动画／URL保留、密码可见性保护 | 通过；临时独立profile和本地页面 |
| 完整Electron应用 | 独立appData/userData/home，加载实际主bundle和构建后的Renderer；明确等待Gateway running/2026.9.8，打开三档权限、记忆、模型、安全、插件、任务和工作看板页面；等待插件与看板加载结束 | 9个检查通过；无Renderer pageerror，导航完成后Gateway仍运行；不触碰真实用户配置、不执行真实账户推理 |

已撤回方案的历史证据：曾以9.6合成状态验证数据库升级、备份及重复执行，随后验证热加载/热重启同PID、冷重启新PID与会话保留。没有迁移真实用户数据库。这不再是现行兼容能力；原生 Gateway 生命周期能力仍由保留的独立生命周期 smoke 验证。
## 多agent回归

- [消息、权限、Plan、Goals和子代理](host-validation-v2026.9.8-chat.md)：113个文件、1604项通过。
- [浏览器、插件、ACP](host-validation-v2026.9.8-browser.md)：本仓库96个文件、931项通过；随包原生模块8个文件、213项通过；Chromium离线交互通过。
- [定时任务、Workboard、记忆、模型设置](host-validation-v2026.9.8-features.md)：54个文件、487项通过。

专项集合和全量测试会重叠，不能直接相加作为独立测试总数。

主目录升级完成后的全量 `npm test -- --maxWorkers=4 --reporter=dot`：654个文件中646通过、5失败、3跳过；6659项中6596通过、17失败、46跳过。17项与升级前复现的问题一致：builtinModelProvider 9项、app/network 1项、ConversationAgentSelector 4项、ContextUsageIndicator 2项、renderer-motion-styles 1项。没有新增失败；也不能宣称全量全绿。测试结束已恢复并验证Electron ABI146。

上述全量测试发生在已撤回迁移方案的 Vite 资产修复前，属于历史测试快照；之后的修改分别执行专项验证，不宣称删除方案后再次全量运行。

新增脚本及构建配置独立lint通过，应用源码lint通过。最终完整窗口fixture为 `justdo-electron-ui-YfLvOk`，包含9项截图和结构化结果；记录保留在系统临时目录，没有把原生日志或用户内容提交到仓库。

## 验收边界

此次已完成主目录安装、真实Gateway链路、重启、Chromium侧栏、Electron guest和完整应用页面检查。仍未执行真实付费模型生成、真实Codex/Claude账号任务、完整MV3扩展的操作系统native-host配对、完整NSIS安装，以及长时间多子任务和断网审批的人工场景。相关源码和组件测试通过不能替代这些场景，也没有据此声称全部第三方服务可用。上游新增能力是否已接入仍以升级总报告的决策表为准。

历史提交 `666e07a5e` 曾补齐独立迁移入口打包；该能力及资产现已按用户要求删除。没有推送远端。

## 可复跑检查

在完成应用编译和运行包安装后执行：

```text
npm run openclaw:runtime:host
node scripts/openclaw/verify-openclaw-runtime-patches.cjs vendor/openclaw-runtime/current
node tests/openclaw/runtime/gateway-smoke.cjs vendor/openclaw-runtime/current
node tests/openclaw/runtime/chat-stream-smoke.cjs vendor/openclaw-runtime/current
node tests/openclaw/runtime/tasks-memory-models-smoke.cjs vendor/openclaw-runtime/current
node scripts/test/verify-decision-secret-runtime.cjs vendor/openclaw-runtime/current
node tests/openclaw/runtime/native-video-smoke.cjs vendor/openclaw-runtime/current
node tests/openclaw/runtime/gateway-lifecycle-smoke.cjs vendor/openclaw-runtime/current
node scripts/test/browser-intervention-smoke.cjs
node scripts/test/browser-recording-smoke.cjs
```

旧 schema 迁移脚本已删除，不再提供复跑入口。Chromium检查脚本为 `tests/browser-extension/chromium-offline-smoke.cjs`，浏览器依赖和操作边界详见专项报告。

## 删除旧数据兼容后的验证

移除 SQLite 迁移链后，engineManager 23 项测试、标准 build 与 compile:electron 通过。清除旧构建残留辅助入口后，真实 Electron 全新隔离状态的9项页面检查再次通过，Gateway running/2026.9.8，rendererErrors为空。证据目录为 `C:/Users/lianghao/AppData/Local/Temp/justdo-electron-ui-o3cdDf/`，日志 `.tmp/remove-98-migration-ui.log`。

该次构建发生在后续 Decision 旧配置/工具别名和旧自定义视频展示清理之前；这些配置兼容清理另由6文件68项专项测试验证，不将上述UI结果冒充它们完成后的再次运行。

最终全部兼容清理完成后，标准 build 与 compile:electron 再次通过（日志：.tmp/remove-98-compat-final-build.log、.tmp/remove-98-compat-final-compile.log）；全新真实 Electron 隔离验证9项全部通过，Gateway running/2026.9.8，rendererErrors为空。最终证据目录：C:/Users/lianghao/AppData/Local/Temp/justdo-electron-ui-PWr5DJ/；日志：.tmp/remove-98-compat-final-ui.log。它覆盖 SQLite 迁移链和三类配置兼容都删除后的最终代码状态。
