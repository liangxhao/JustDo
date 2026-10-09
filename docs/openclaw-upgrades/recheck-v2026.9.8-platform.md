# OpenClaw 2026.9.8 平台逐功能复核

复核日期：2026-10-04。对象是当前工作区、`../openclaw` 的 9.8 源码、锁定的 pristine npm 包以及 `vendor/openclaw-runtime/current` 正式 Windows 运行时。此次没有重新安装运行时、切换 SQLite ABI、访问用户账户或恢复已撤回的 9.6 兼容方案。

## 结论与证据强度

本轮未发现新的平台执行缺陷。发现一处补丁范围描述不准确并修正：028 的实际授权边界是原生已经批准的 `operator.admin` cwd 路径，不能描述成补丁额外限定产品命名空间。原生非管理员目录限制保持不变。只修改补丁 README，不改变授权代码。

本轮独立重新运行的第一组专项为 **51 文件、307 测试通过**；第二组浏览器/侧栏/桥接专项为 **15 文件、213 测试通过**。两组选择互不重叠，总计 **66 文件、520 测试**。日志分别为 `.tmp/recheck-platform-tests.log`、`.tmp/recheck-platform-browser-tests.log`。测试包含模拟进程、模拟 Gateway 和隔离文件夹，不等于所有功能已在真实账户下运行。

正式运行时的补丁 manifest、source lock、构建配方及冻结产物哈希重新校验通过：`.tmp/recheck-platform-runtime-proof.log`、`.tmp/recheck-platform-frozen.log`。Pristine 契约审计为 11 项原生契约、23 项保留差异：`.tmp/recheck-platform-pristine.log`。逐个 `verifyPatch` 的正式源文件及 Gateway bundle 检查记录在 `.tmp/recheck-platform-23-verifiers.log`。没有通过改写 manifest 消除失败。

Pristine 的 retained-gap 检查只证明补丁验证器不会错误地接受未打补丁的包；它本身不能证明补丁业务必要性。下面的必要性还结合各模块转换锚点、作用域、上游实现和专项回归判断。真实 Gateway 生命周期与 Electron UI 的前轮实测仍是历史实测证据，本轮没有把它们记为再次执行。

## 23 项补丁逐项复核

以下编号对应 `scripts/patches/v2026.9.8/<编号>-*.cjs`；完整文件名及移除条件在模块头部。源代码和最终 bundle 必须同时符合当前精确形态，历史/部分形态应拒绝并重新 pristine 构建。

| 编号 | 9.8 仍需的能力与原生差异 | 审核的安全边界 / 风险 | 本轮验证 |
| --- | --- | --- | --- |
| 001 | 原生 host/native-hook 环境过滤仍去掉受管 pip 配置与 Python user base | 仅请求值与 Main 来源证明完全相同时恢复；来源标记不传入子进程，原生 deny-list 保留 | pristine 差异、正式 verifier、环境相关回归 |
| 002 | Windows npm/npx MCP shim 需要 Electron Node 启动及隐藏子控制台 | 仅包运行器分支；不扩大任意命令或非 Windows 路径 | pristine/正式 verifier、launcher 回归 |
| 003 | Chrome MCP 的 npm 启动需要同样的宿主适配 | 保留新版调用方 env、stderr 和连接诊断；preload 受文件名/绝对路径约束 | pristine/正式 verifier |
| 005 | 原生缺少模型感知完成后、发送前的最终 system prompt 替换入口 | 不能覆盖 hook、模型身份及缓存边界；不改用户正文 | pristine/正式 verifier、compiled metadata 回归 |
| 006 | 内置模型需要 session/parent/一次性 human initiation 元数据及可信隐藏回合 | 仅内置 provider；父身份走原生只读 worker，隐藏仅受信本地后端可用 | worker/request metadata 与编译后验证 |
| 007 | 压缩与命令审批模型请求需要区分 purpose | 仅已认证内置 provider；维护请求清掉 user_initiated；异步读取原生身份 | compaction/reviewer metadata 回归 |
| 008 | App 退出后不自动恢复旧进程接纳的执行任务 | 9.8 已删除通用 task registry，本补丁只约束 main-session 恢复；同 App 内 Gateway 重启保持 epoch | startup-recovery 回归 |
| 013 | 暂停 Goal 的上轮被终止后允许显式恢复 | 只改 Goal resume，保留 idle、freshness、hierarchy、active-work 检查 | goal-resume 回归 |
| 014 | 原生 provider replay 不应带 UI 专用 assistant display block | 仅 provider-bound 投影过滤，保留原生 tool call，不改持久历史 | pristine/正式 verifier |
| 015 | 可信本地未知 MIME 文件下载和 MEDIA 原引用显示 | 不绕过文件来源、大小与读取许可；不是任意远程 URL 放行 | trusted-media 回归 |
| 016 | 插件列表读取不应自动访问托管官方 catalog | 离线意图下用随包 catalog；显式刷新/安装仍由原生执行 | pristine/正式 verifier |
| 019 | 配置、启动、Doctor 不应隐式下载修复插件 | 保留安装记录；显式安装升级路径不被禁止 | pristine/正式 verifier、插件运行时回归 |
| 020 | Realtime ASR 应使用配置的 OpenAI URL | 仅直接 API-key WebSocket 工厂；未配置仍用官方默认 | pristine/正式 verifier |
| 021 | 图片 provider URL/凭据需要与聊天配置隔离 | 克隆请求配置，不覆盖共享 openai；9.8 已移除 OpenAI video provider，未恢复旧视频传输 | pristine/正式 verifier；原生视频由配置专项负责 |
| 022 | Plan 上下文 reset 后仍保留产品显示历史 | 仅 agent:*:justdo:* 显示窗口；模型上下文 reset 保持原生语义 | reset-display-history 回归 |
| 023 | 产品 fork 需要受管目标 key 与选中 assistant 回复原子切点 | operator.admin、产品会话键、目标冲突拒绝；使用原生事务，不事后补写正文 | managed-fork 回归 |
| 025 | MXC 需要已经物化的宿主只读技能根路径 | 仅 MXC；Docker/SSH 仍用其容器路径；最终 bundle 别名形态也验证 | mxc-runtime-paths 回归 |
| 026 | 网页等不可信上下文需要只给模型、不成为可见用户正文 | 可信本地入口、长度边界、raw transcript 保持；不会将网页指令提升为系统指令 | private-context 回归 |
| 027 | bundle 与动态 SDK 模块必须共享访问授权 registry | 只共享 Map，不改变 grant 或可见性；仍拒绝部分形态 | shared SDK 与正式 verifier |
| 028 | sandbox 会话的已授权 admin cwd 不应被后续 containment 重复拒绝 | 依赖原生 operator.admin 授权；非 admin containment 不变。README 本轮修正范围描述 | pristine/正式 verifier |
| 030 | cron 每次执行需要持久化任务级权限及正确 workspace | 仅 unscoped admin 可以写模式或编辑/手动执行 Full；异步准备后仍用选中 workspace | cron-permission、cron-runtime、scheduled-task-permissions |
| 031 | Windows 维护服务持有的系统凭据启动器需要被准确识别 | 仅 justdo_login、System32 PowerShell、精确 TrustedInstaller SID；再次检查 ACL 不含非信任可写权限 | credential-launcher、编译别名回归 |
| 032 | Windows `node:sqlite` 的 namespaced 数据库路径与接纳路径比较 | 只规范化两端路径拼写，不做大小写折叠、不改数据库身份/创建 owner 检查 | windows-session-creation-path 回归 |

009/024 和 017/018 保持退休；没有为了原生已实现能力重新引入补丁。MXC 独立插件的宿主准备、技能路径及生命周期配置仍在 `scripts/openclaw/patch-mxc-sandbox-plugin.cjs`，与核心 23 项分开管理。其 Windows 真 sandbox 启动、真实 ACL 及二进制执行需要 Windows 集成场景，静态 verifier 不能替代。

## 版本、构建、进程入口与 wire

入口：`package.json`、`scripts/patches/v2026.9.8/source-lock.json`、`scripts/openclaw/install-openclaw-runtime.cjs`、`bundle-openclaw-gateway.cjs`、`verify-openclaw-runtime-patches.cjs`、`scripts/packaging/electron-builder-hooks.cjs`。

- 版本均为 2026.9.8。下载同时比较 registry integrity、实际包 integrity 和锁定 tarball SHA256；在 staging 完成打补丁及布局检查后才提交。缓存命中不是跳过验证：同版本冻结运行时仍校验，缺少初次 bundle 授权标记不能任意重建。
- 当前 win-x64 的 npm tarball SHA256 为 `317e0a58db32b386e01187fe9c5c4de541f4ce6d815657bf79a102609b81752a`；现场 proof 验证 source lock、patch set、配方、gateway.asar、包和 shrinkwrap。归档打包后仍校验 patch proof，专项覆盖缺文件、篡改与失败提交保留旧运行时。
- `openclaw-runtime-companions.cjs` 恢复各原模块 URL，覆盖共享 process factory、self Worker、runtime import、readonly SQLite worker 等 9.8 新入口。不能将 worker 简单复制到错误根目录掩盖路径问题。companion、SDK singleton、extension precompile、prune、facade、launcher、packaging tests 均在本轮通过。
- `src/main/engine/openclaw/wire/v2026_9_8.ts` 对 offset/total/cursor/reset 进行封闭解析；pending 的独立分页在共享 pending 契约与 request-local helper，不冒充持久 transcript。旧 `tasks.list/get` 不是 9.8 API。当前 wire 目录、运行时安装及 Vite 无撤回的 `nativeRuntimeMigration` 引用。
- Vite 不再生成被用户要求删除的迁移 helper；OpenClaw 上游自己的进程入口/原生维护模块仍随包保留，不应因名称包含 migration 误删。没有恢复未发布 9.6 的数据或配置兼容。

风险与边界：本轮只检查 Windows 正式产物；macOS/Linux 的 installer、签名和系统二进制没有重新真实打包。单元测试使用伪造产物验证失败边界；不等于三平台安装验收。

## Gateway 快启、热加载、热重启、冷重启

入口：`src/main/openclaw/runtime/openclawEngineManager.ts`、`gatewayConfigReloadMonitor.ts`、`gatewayConfigRestart.ts`；原生对照 `../openclaw/src/gateway/config-reload.ts`、`config-reload-plan.ts`。

| 功能 | 当前代码与证据 | 主要风险与未覆盖边界 |
| --- | --- | --- |
| 快速/重复启动 | `startGateway` 合并启动 promise；既有健康进程复用；预编译 bundle 与 Node compile cache；launcher/engine manager 回归通过 | 本轮未测启动秒数，不以缓存开关推断性能收益 |
| 配置热加载 | 路径分类只作为关联提示；以原生 applied/failed 日志事务结束为准。9.8 对 plugins、MCP、ACP 的 hot 策略被保留 | 插件内部 reload 由原生拥有；未以“配置保存成功”当作实际生效 |
| 进程内热重启 | `gateway.restart.request` 使用 skipDeferral:false；scheduled 等 ready，deferred/coalesced 返回 pending，避免另起冷重启争抢 owner | 忙任务必须等原生接管；本轮 mock 回归，不新增真实长推理请求 |
| 冷重启 | 环境变化、端口变化或原生重启不可用时进入宿主生命周期；generation 检查防止异步等待误停新进程 | 真操作系统挂起/杀毒拦截仍需人工故障注入 |
| App 与 Gateway 边界 | 补丁 008 的宿主 epoch 在同 App 内保留；App 新进程不能恢复前一宿主未完任务 | 不恢复此前已撤回的旧 schema 数据转换 |

本轮重新跑 engine manager、config restart/reload monitor、dev lease/shutdown、launcher、freeze/staging 等测试。前轮真实 Gateway 的 PID 与 ready 结果保留在 host-validation 报告中；此次没有再次声明执行那些场景。

## 浏览器连接、扩展对话、内置浏览器

| 功能与入口 | 本轮检查和证据 | 风险 / 验收边界 |
| --- | --- | --- |
| 原生 Chrome 配对/relay：`resources/browser-extension/openclaw/`、`scripts/browser/prepare-browser-extension.cjs` | 原生 baseline 与 conversation-overlay 分开；生成时验证锁定源文件布局和校验和，再只应用显式集成 seam；prepare 与 native messaging 回归通过 | 没有实际修改用户浏览器 native-host 注册；浏览器商店安装、升级、企业策略仍需真实宿主验收 |
| 扩展侧栏连接：`browserExtensionChatServer.ts` | 仅监听127.0.0.1，验证固定扩展 Origin 与 token；授权、分页、断线/流事件回归通过 | token 泄露与用户自装恶意扩展不由 mock 网络测试覆盖；不放宽入口限制 |
| 侧栏历史与对话：`browserExtensionChatController.ts`、`sidepanel-state.js`、`sidepanel-stream.js` | 共用原生历史投影，pending request-local；thinking/tool/content、历史替换、状态变化和同文输入测试通过。此前 pending 修复已进入当前源码 | 本轮不与聊天 agent 同时修改 pending；精确并发消费场景由其复核和原生 smoke 补充 |
| 静态资源：`build-browser-extension-markdown.cjs`、`browser-extension-rich-content.ts` | 生成器从拆分后的 styles 文件读取并校验锚点；翻译来自双语服务；markdown/rich-content/stream DOM 测试通过 | 本轮未再次运行真实 Chromium；前轮 Chromium smoke 是已有证据 |
| 内置侧栏浏览器：`BrowserPanel.tsx`、`browserAgentBridge.ts` | tab 注册、session/profile scope、CDP 重连、操作确认、文件/截图/页面内容边界、面板保留测试通过 | 真实网站登录、下载、复杂弹窗和跨域 iframe 没有全覆盖 |
| 宿主权限：`browserPanelSecurity.ts`、`mainWindowFactory.ts` | 导航协议与 metadata host 限制；主窗口 sandbox/contextIsolation 开启、nodeIntegration 关闭；permission 与 request-state 回归通过 | 网络层 DNS 重绑定等非本次升级新语义，不能单凭 URL 单测宣称完整 SSRF 防护 |

## 外部 Codex / Claude ACP

入口：设置中的 external agents、`src/shared/integrations/externalAgentCatalog.ts`、`openclawConfigBuilders.ts`、`openclaw-extensions/acpx/`。

- Codex/Claude 默认不启用委派；acpx 插件保持可用以支持连接诊断，但 `startupProbe:false` 不主动启动外部账户请求。配置映射区分 approve-all、approve-reads、deny-all 以及非交互失败/拒绝策略。
- 本地插件锁定 acpx 0.19.1、Codex ACP 1.12.0、Claude ACP 0.79.0，plugin API 下界为 2026.9.8。`codex-auth-bridge.ts` 使用已安装 adapter，缺失明确失败；wrapper 测试证明不自动下载替代品。宿主选择 adapter、配置的 executable 及 Windows 命令 token 路径分别有专项。
- Auth/config 进入插件专属 home；信任项目白名单和凭据复制由专用函数处理，诊断脱敏。`codex-auth-bridge`、`config-state-dir`、adapter wrapper 测试通过；没有读取或展示本机真实密钥。
- MCP 共享是显式设置，受管名称保留；只转发 stdio command/args/env，不把 OpenClaw 私有 headers/cwd 投影到不支持的配置。dynamic MCP、plugin contract 回归通过。
- 清理依据 wrapper 路径、包和 lease 身份，不能仅凭进程名杀外部 Codex/Claude；process reaper 专项通过。SDK shared modules 和 packaged acpx hook 测试同时覆盖打包后的模块身份与资源定位。

边界：本轮没有真实认证 Codex/Claude，没有发出收费推理，没有实际外部编辑/审批回合。因此连接成功后的真实模型工具调用、服务端版本行为和账号限额不是已通过项。需要用户选择的隔离工程与已有凭据进行手工验收，不能用 adapter 启动单测代替。

## 剩余真实验收清单

1. 三平台最终安装包启动、原生依赖、签名和权限；本轮正式产物仅 win-x64。
2. 真实 Chrome/Edge 从安装扩展到配对、浏览器重启、应用重启及多窗口切换；保留 relay/overlay 分离。
3. 隔离工程下 Codex/Claude 各一次真实连接、只读工具、明确拒绝、取消和断线恢复，不触碰其他进程。
4. 同一真实长任务期间热配置、deferred restart、随后 ready；核对模型调用未重复、进程 owner 未被冷重启争抢。
5. Windows MXC 真 sandbox、受管 pip/MCP、系统凭据 launcher ACL 与未知 MIME 文件下载；这些不能只靠转换器形态检查宣布完成。
