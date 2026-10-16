# OpenClaw v2026.10.4 升级记录

本记录区分源码/自动化验证与真实服务、设备和安装版人工验收；历史版本结果不作为本版证据。

正文流式输出及输出中停止真实验收通过，Windows 目录包通过；Chrome 扩展配对按用户要求延期。最新复审与产物见[追加复审](#追加复审与补丁整体校验)，前序候选的测试和产物身份按各自阶段保留。

## 基线与来源

- 应用起点：`2893c978f314b977a5881526174aa7295e37a3dc`，原 OpenClaw `v2026.9.8`。
- 升级分支：`codex/openclaw-2026-10-4`，独立 worktree，保留原工作区未提交文件。
- 目标：官方 npm `openclaw@2026.10.4`；源码 checkout `v2026.10.4`，提交 `383c124cc32ffee3f8e56f549b88da94d269a4af`，与发布包 build-info 一致。
- tarball SHA-256：`0a41c2ed708abc812498de58d71d058dde322700488d6e8062c7c070dfdca6dc`；完整 integrity 见[锁文件](../../../scripts/patches/v2026.10.4/source-lock.json)。下载入口和准备命令只维护于[离线下载文档](../../offline-downloads.md)。
- 验证平台：Windows x64；Node `24.21.0`，Electron `42.11.15`（其 Node `24.19.0`）。项目 Node 约束保持 `>=24.16.0 <25`。
- OpenAI 完整源码替换基线同步到同一 tag/commit，独立锁文件中的 `libopus-wasm` 更新至 `0.4.1`。MXC 锁定 `2026.10.4`、SDK `0.8.0`；x64/arm64 executor 与 host-prep 字节 hash 已核对。

## 接入决策与用户影响

逐项能力、删除条件和旧/新编号映射以[28 项补丁总账](../../../scripts/patches/v2026.10.4/README.md)为准。首轮 25 项和后续 26 项候选构建的验证保留在下文；真实续验新增的 026—028 及其最终构建另记，避免混用产物证据。

| 领域            | 目标变化与处理                                                                                                                                                                                                                                                                                                      |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 原生调度/执行   | 原生 registry 改为不可变记录和事务发布；019 通过原生 actor 发布产品元数据，核对 owner/generation、epoch、revision 及提交回执。物理清理接入 `executeAgentRun`；不重放未知执行。                                                                                                                                      |
| 跨会话写入      | 上游在恢复调用者上下文并核对授权后退出源 transcript/CLI-history writer scope；旧 039 删除。目标任务仍需取得自己的原生写入 claim，共享 SDK owner 机制保留。                                                                                                                                                          |
| SQLite 关闭     | 原包已复现旧读取快照导致前台写入 `SQLITE_BUSY`；旧 043 重写为 025，覆盖六处 native owner 和最终 bundle，仅在 final checkpoint 临时设 `busy_timeout=0` 并恢复。保留新版 `beginClose`、异步 `stop` join、lease 和 clean-close 事实。                                                                                  |
| SQLite 回滚     | 上游由旧字段改用绑定备份目录的 before/after migration write receipt；探针同步核对新回执、错误备份身份、未知后续写入、排他锁及文件不移动。未引入应用自动升级/回滚桥。                                                                                                                                                |
| SDK 与 CLI      | 新增两个 CLI 根依赖；补齐 bundle 旁 build-info。发布包未包含远程 file-transfer 的两个 worker，桌面图仅排除其没有调用的声明，任何实际引用仍要求文件存在。                                                                                                                                                            |
| Provider 传输   | 原生参数/空 tool-call/失败内容规范化移至 `@openclaw/ai`；安装生产依赖后对精确版本和实际函数重新核验。请求 metadata 包装保持在新版 service-tier observer 之后。                                                                                                                                                      |
| OpenAI 本地差异 | 三方合并原生协议修复及两个 worker；继续只注册内网能力，无官网登录、官网 catalog、自动端点回退或官方 Realtime Voice 注册。图像/视频/语音/chat 凭据域独立，`video-openai` 仍由唯一 `openai` 插件提供。                                                                                                                |
| MXC             | 使用目标包原生 selected-executor readiness 与 `preservePolicy:false` 生命周期，删除重复 build 接线。只保留只读 external skills 和 capability SID host-prep 识别。                                                                                                                                                   |
| 插件裁剪        | 新增 Cloudflare R2 storage 明确裁剪；移除上游已删除的 zai/novita 清单项。未知插件仍拒绝进入产物，不增加公网默认配置。                                                                                                                                                                                               |
| 浏览器          | 从目标 checkout 的 `extensions/browser/chrome-extension` 更新 background/bootstrap/relay-auth/strict-json 基线及锁定 hash，重新构建产品 overlay。                                                                                                                                                                   |
| Wire/历史       | validator/adapter 切换到 `v2026_10_4`。已对照 chat/history、WS envelope、sessions/create/list/row、terminal、cron、config、questions schema 差异；history/in-flight 形态未变。新增 optional workContext detail、ultrafast 和 compact list 不是当前产品发送参数；产品问题交互仍由自己的 ask-user-question 插件承载。 |

Main 仍只拥有产品生命周期、权限和 metadata；Renderer 消费原生历史/事件，未恢复 transcript cache、`cowork_messages`、旧 SQLite 迁移门禁或已退役 provider 配置迁移。

最终 Windows 打包还发现合并 tar 的通用过滤规则遗漏 MXC SDK 许可证。已使 MXC 与 ACPX 一样保留法律文件，并将归档条目回归参数化到两个插件；5 项归档测试通过。打包守卫保持严格，修复后重新从 pristine 构建，不在旧 manifest 上更新 hash 来放行。

打包的最终 proof 还暴露临时解包范围遗漏：归档已有 companion，但校验临时目录只提取固定根文件。现从归档内实际 Gateway bundle 发现依赖，第二遍仅提取这些 companion，再执行原有 manifest/文件存在性检查；没有跳过检查。回归分别验证 companion 存在时成功、缺失时拒绝。另行执行 `vitest run`，3 个归档/manifest/companion 测试文件、58 项全部通过，不与完整套件的通过或跳过数量相加。

归档规则修复后的重新构建中，Gateway bundle、gateway.asar、运行时 package 和 npm-shrinkwrap hash 均与原生探针所验证的构建一致；构建 recipe 则记录归档规则和 proof 解包逻辑的变化。

三位 Agent 复审后的补丁标记检查修复再次从 pristine 完整重建。以上四项运行时 hash 仍逐字节一致，因此真实界面与原生探针验证的执行代码适用于最终构建；patch set 和 recipe 身份已更新到下方最终值。

## 首轮验证证据（25 项补丁构建）

原生执行探针使用独立 state、合成内容和 loopback 测试服务，不读取用户 transcript，不使用生产 Gateway。随后按用户要求，以独立产品 profile 和已配置的 MiMo 模型补做真实界面验收，具体范围见[真实界面验收记录](real-ui-acceptance.md)。

本机原始输出保留在仓库外 `E:\workspace\openclaw-upgrade-2026-10-4\`，不提交原生日志。原生证据包括 `owned-execution-{final,electron-final}.log`、`peer-return-{final,electron-final}.log`、`sqlite-lifecycle-{node,electron}-final.log`、`gateway-lifecycle-{node,electron}.log` 和 `ui-final.log`。复审后的构建、核验、完整测试及打包记录为 `runtime-build-reviewed.log`、`verify-reviewed.log`、`tests-reviewed.log` 和 `package-reviewed.log`；lint/build/Electron 编译为对应的 `*-review-final.log`。真实界面证据位于 `real-ui/`，本记录只保存汇总结论与产物身份。

| 范围                                                                                                                | 状态与证据                                                                                                                                                                                                                                                            |
| ------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 源包与补丁                                                                                                          | 通过：pristine 核验 12 项原生能力、25 项保留缺口；目标源码 apply/verify/当前形态幂等通过，历史/部分标记拒绝测试保留。最终产物核验另记下表。                                                                                                                           |
| 原生 owned execution                                                                                                | 通过源码 Gateway 探针：整轮结算及 cross-plugin 拒绝、后台进程消失后才清理结算、精确取消、重启后持久结算与 interrupted unknown；未知取消拒绝。最终冻结 bundle 在 Node/Electron 同场景均通过。                                                                          |
| SQLite                                                                                                              | 通过：真实原包阻塞对照、补丁并发写入与 timeout 恢复；六类生命周期在 Node/Electron 均通过：WAL 最新数据备份、回滚拒绝及成功/row ID 保留、删除排他、异常关闭不冒充 clean、正常退出/强制终止及重启完整性。                                                               |
| OpenAI 类型                                                                                                         | 85 个本地源码文件在目标 tag SDK 下 strict 检查无本地诊断；上游依赖闭包诊断单独排除，未声称上游整个仓库 tsc 通过。目标发布包缺少部分 SDK d.ts，故该检查使用锁定 tag 的 SDK 源码；实际加载另由发布产物测试验证。                                                        |
| 构建、完整测试、最终 manifest                                                                                       | 通过：强制 pristine 重建及预编译/裁剪，25 项 manifest/freeze 核验；lint、build、compile:electron 均通过；最终标准 npm test 为 907 文件通过、5 文件跳过，10,421 项通过、57 项跳过。跳过项不记为通过，当前目标 pristine topology 50 项及 facade 强制核验 3 项另行通过。 |
| Gateway/SDK、chat/history、压缩、摘要、权限、Goal/Plan、cron、Team/Workflow、插件生命周期、配置/认证、浏览器/工作区 | 按升级检查清单纳入完整自动化回归；本轮完整自动化已通过；最终 Gateway 的普通/溢出/取消/提供方失败压缩、五轮 peer return、QuickJS 及下述重启验证通过。自动化不替代下一节人工场景。                                                                                      |

非最终候选构建曾被缺失 companion、编译后变量重命名守卫或 stale recipe 正确拒绝；最终产物必须从 pristine 重新生成，不修改安装目录中的 bundle/manifest 来消除拒绝。

## 真实界面与复审

已使用现有配置的 `mimo/mimo-v2.6-flash`，在隔离 profile 中完成四个用户/任务回合，减少额外模型调用。实际验证停止按钮及原生 aborted 整轮结算、切换聊天后侧栏仍显示运行中、内嵌网页承载与输入/点击/导航/后退、Chrome 隔离窗口打开并点击网页，以及一次性定时任务在设定时刻触发并保存成功未读回执。三轮聊天均核对精确 native run 的 `executionSettled:true` 终态，未用 ACK、chat final 或 idle 替代。

三位 Agent 分别复审执行/SQLite、运行时与 OpenAI/Chrome/MXC、应用 wire/config/cron，修复 009/010/012 补丁对两类历史标记及文件头尾、提前返回路径的检查遗漏。三个补丁现在都在全部目标的历史标记检查通过后才写入；公开 apply/verify 的 source/bundle 拒绝、无部分写入及当前形态幂等回归共 120 项通过。没有发现其他已确认功能回归。

Chrome 窗口读取时，界面工具因无法可靠识别当前 URL 而结束自动化，之后未再操作界面。已完成范围和未完成交互分别保留在[真实界面验收记录](real-ui-acceptance.md)，不将工具限制判为产品故障或全面通过。

后续独立验收已完成 browser 工具执行中停止、定时任务收件箱/立即运行/已读持久化及日常 Chrome 连接。普通正文无法流式显示被确认是新版全局 finalize hook 的缓冲门槛所致，新增 026 与两插件的精确归属声明；详见[续验与修复](real-ui-acceptance.md#续验发现与修复普通会话无法流式显示)。这些变化不修改原生整轮终态、权限或 reasoning 规则。扩展配对因设置页自动化被浏览器策略拒绝；用户反馈已安装但无法配对，随后明确要求停止本轮扩展验收，留待其后续验证。

## 尚需真实环境验收

- 未验证：除上述 MiMo chat 外的真实内网 chat/image/embedding/STT/TTS/video 服务及账号轮换、麦克风/系统音频；本机 HTTP/WS fixtures 只证明协议和凭据隔离。
- 未验证：真实模型超过一小时的任务、yield/fallback、终端/子进程执行中的界面停止及完整人工审批/Goal/Plan/Team/Workflow 组合场景；browser 工具停止和定时任务收件箱/立即运行已续验。
- 未验证：Chrome 扩展配对/Tab Access、全新原生授权对话框、企业页面/下载/文件/PDF、MXC 实际隔离进程及电脑工具、不同 DPI/双屏/中文输入法/剪贴板；日常窗口实际连接已通过。
- 未验证：最终安装器交互、中文/空格安装路径、安装后首次启动与 packaged Renderer/Widget 组合人工验收；打包检查或隔离 Gateway 不能替代该项。
- 不适用本轮平台验收：macOS、Linux、Windows arm64；仅核对 arm64 MXC 锁定字节，未声称该平台启动通过。

上述项目不以历史通过记录或合成事件标为完成。代码及自动化可验范围与真实产品验收分别记录；尚无真实服务、设备和安装版的全面验收结论。

## 首轮命令与产物（25 项补丁构建）

| 命令/场景                                                     | 结果                                                                                                                                                                                                                                                                |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OPENCLAW_FORCE_INSTALL=1 npm run openclaw:runtime:win-x64`   | 成功；官方 MXC 2026.10.4，12 个本地扩展，51 个上游扩展明确裁剪；预编译 9 个、已有 JS/非目标 18 个跳过、0 错误。                                                                                                                                                     |
| `npm run openclaw:patches:verify`                             | 当前 25 项及冻结证明通过；完整 rebuilt source 和 bundle 共同校验。                                                                                                                                                                                                  |
| `npm run lint` / `npm run build` / `npm run compile:electron` | 串行通过；标准测试后 Electron ABI 146 已恢复。                                                                                                                                                                                                                      |
| `npm test -- --maxWorkers=4`                                  | 10,421 passed，57 skipped；未把旧版本 CI 专用开关全局套入本版测试。首轮发现的旧基线/旧 UI 断言已按真实目标修正；隔离安装最初跳过的 http-mitm-proxy 初始化补齐后，证书 9 项通过。另修正两条提示中的内部引擎名称，匹配 zh/en。                                        |
| `plugin-owned-execution.native-smoke.cjs`                     | 最终 bundle 在 Node/Electron 上的 settlement、跨插件拒绝、后台进程清理、取消、重启 unknown 全通过。                                                                                                                                                                 |
| `verify-peer-compaction-runtime.mjs` 四模式                   | 普通自动压缩、provider overflow、压缩期间 abort、压缩后 provider failure 均通过；失败以原生 `schema`/`format` 分类和持久历史核对，不依赖旧错误文案。新 context-only carrier 不再被本地 fixture 模型误认成当前任务；精确原生授权与终态断言保留。                     |
| `probe-agent-team-peer-return.mjs`                            | Node/Electron 各 5 轮、15 次本机模型请求，写作者与组织者各 5 个精确整轮终态，原生 grant/accepted receipt 和并发 history/list 通过。克隆探针实际复制 dist 子目录，遵守新版 public-surface 路径不得逃逸的校验。                                                       |
| `sqlite-retirement-lifecycle.native-smoke.mjs`                | 最终冻结 runtime 在 Node/Electron 上各 6 类全通过。                                                                                                                                                                                                                 |
| `gateway-lifecycle-smoke.cjs`                                 | Node cold/warm 22,956/25,941ms，hot restart 35,277ms；Electron cold/warm 19,330/22,053ms，hot restart 41,307ms；热配置/热重启同 PID、冷启动新 PID、sessionId 保留，均通过。并行高负载首测曾超过探针重连等待，独立复测确认，不修改产品等待策略来掩盖。               |
| `verify-code-mode-runtime.mjs`                                | 最终 QuickJS/WASM/encoding 资产、执行、wait/resume、UTF-8、失败和取消全通过。                                                                                                                                                                                       |
| 原生 `plugins list --json`                                    | 唯一 loaded openai，source 为运行时 `dist/extensions/openai/index.js`，providerIds 为 openai/video-openai。                                                                                                                                                         |
| 隔离 Electron UI                                              | 最终构建启动新 Gateway `2026.10.4`，首页、三种权限、记忆、设置、模型、沙箱、插件、定时任务、看板共 9 项通过；导航结束仍 running，Renderer page error 为 0。看板在一次性 profile 显式启用后验证空态，不改变原生默认禁用状态。                                        |
| Windows directory package                                     | 通过：npx electron-builder --config electron-builder.config.cjs --dir --win --x64；产物 release/win-unpacked。资源归档、包内 patch proof/companion、Node/npm/npx、浏览器扩展 2.3.0 及 better-sqlite3/node-pty Electron ABI 146 均通过。目录包不包含安装器交互验收。 |

首轮 UI 探针沿用了旧导航/中文标题，已按当前「更多」、沙箱与隔离、系统内置入口更新；未改变产品导航或隐藏失败。该检查使用实际 Electron 窗口和开发资源服务，不作为安装版 Renderer hosting 的证据。后续真实模型界面验收见上节；Windows 安装器交互和其余真实服务/设备保持未验证。

首轮 25 项补丁运行时身份（026 后的新构建另记）：

- patch set: `df4d6c71d7d9167bf11271305f21e3ed003b5df257cca612a41138fd154ab7ca`
- build recipe: `245eec99f34fddd3569017ffd5705450ec62eef36fa54d7b3ea3dc9ddc96edb4`
- Gateway bundle SHA-256: `c2c5d4848bc0608438c6c44cd5adb8ad78f02a4c39d0df07647c51b6532f66ee`（76751923 bytes）
- gateway.asar SHA-256: `9579fabadbba9304a82f2863e05ca6efa61c56e88ae651f7f14b0ef6cdbf7c29`
- runtime package SHA-256: `b6588b64f66016de8c020c9ff0b29ed4713b87af0ef955d3864066dcbfb038d3`
- npm-shrinkwrap SHA-256: `886d40c7b53c2b9d7ac45c19b5a7102ac2fc22ca45a267cc6d9adba9b824fc8a`
- Windows `win-resources.tar.zst` SHA-256: `787b9f14953547b1820e04735d716402b29e7923b335d98f166cd2e0b8690eff`（448568067 bytes）

发布包 source integrity、runtime package/shrinkwrap、全部 patch/support/extension assembly 的 hash 以冻结 manifest 为准。本次 Windows x64 目录包已通过包装阶段的归档 proof；最终再次执行 `npm run openclaw:patches:verify` 和 `git diff --check` 均通过。安装器交互与其他平台仍按前述范围保持未验证。

## 026 续验候选构建与产物

真实界面暴露了全局结束前钩子缓冲普通正文的问题，026 与两插件的身份准入修复经过三位 Agent 分工及独立终审。复审修正了公开选择器类型，以及 native/SDK 两组之间的不完整补丁状态拒绝。修改输入后的中间候选被陈旧 source proof 守卫拒绝；随后从官方 pristine 包完整重建，未修改安装目录中的 manifest 放行。

- `runtime-build-stream-final.log`：强制 pristine 重建通过，12 项上游能力、26 项保留缺口；9 个扩展预编译、0 错误。
- `verify-stream-final.log`：全部 26 项及最终冻结证明通过。
- `finalize-bundle-stream-final.log`：直接执行最终 bundle 的真实函数，39 项通过、1 项 pristine 源码专用断言跳过。普通正文在终态前发布、所属修订草稿保护、同一注册集合、身份失配拒绝、reset/retry/abort 及公开 apply/verify 的不完整状态零写入拒绝均覆盖；不通过再次 transform 掩盖最终 bundle 缺补丁。
- `lint-stream-fix.log`、`build-stream-fix.log`、`compile-stream-fix.log`：检查、前端构建和 Electron 编译通过。
- `tests-stream-final-rerun.log`：标准测试完整重跑，909 文件通过、5 文件跳过；10,465 项通过、63 项跳过，264.15 秒，Electron ABI 146 已恢复。首轮发现补丁清单测试遗漏 026，已同步精确清单；另一次 Vitest runner 初始化异常导致少收集一个文件，未查得根因。单独完整重跑已收集全部 914 文件、无失败或未处理错误，不将首轮失败计为通过。
- `package-stream-final.log`：Windows x64 目录包成功，包内 26 项 proof、companion、Node/npm/npx、浏览器扩展 2.3.0 及两项原生模块 Electron ABI 146 均通过。打包后 Gateway bundle hash 保持一致；目录包检查不代替安装器交互。

026 候选运行时身份（后续新会话初始化修复另行构建）：

- patch set：`e37ff60b4276564b7a62f3a177fdf6693027327963b238a26e9a377699272537`
- build recipe：`bca1a5b4a74bb4fd9a0c428e4cf73e1cb8fae125ffdcea45d7ecaaec44d2f64e`
- Gateway bundle：`6ea35fc0cbaedc23da3ed6efc13d9fc93de6ae82d712e45f941881c0210993f1`（76755154 bytes）
- gateway.asar：`c342ba23b0262d3be6f69184f663bc3e56bb6040999a66beb6899d969371c50a`
- runtime package：`b6588b64f66016de8c020c9ff0b29ed4713b87af0ef955d3864066dcbfb038d3`
- npm-shrinkwrap：`886d40c7b53c2b9d7ac45c19b5a7102ac2fc22ca45a267cc6d9adba9b824fc8a`
- Windows `win-resources.tar.zst`：`08346daa98782d38baa496ff2070ebee321d4faa434c99d2c9fda3ece2dfee3e`（448586364 bytes）

首轮的完整原生探针结果属于上文 25 项构建，不能冒充这个新 bundle 的重跑结果。

26 项候选的真实新会话续验又发现 canonical 准备与响应发布缺口：同一 `chat.startup` 请求反复响应，正文初始化未完成。独立复审确认 Windows 路径别名导致校验缓存状态分裂，且可重入读取在 pending 时已经发布响应。具体证据见[真实界面续验](real-ui-acceptance.md#026-候选续验新会话初始化循环)。因此上文自动化和目录包通过不作为最终正文流界面通过记录。

## 最终 28 项构建

026 恢复普通会话正文的及时交付；027/028 修复 Windows canonical 准备路径及读取响应发布。真实界面已经验证新会话正常准备、正文 1 至 41 可见时任务仍在运行、输出继续增长及实际停止；精确整轮 aborted 终态在停止请求后约 261 ms 收敛，部分正文保留。重启后收件箱已读持久化、原生完整会话和未读空态也通过，详见[真实界面记录](real-ui-acceptance.md#28-项候选的正文流与停止实测)。Chrome 扩展配对仍按用户要求留待后续验证。

最后一次严格语义复审补齐 SDK 同文件的 `Registration` 与 `RegistrationOptions`，产品选项精确实例化 finalize 泛型；两插件执行 JS 不变。三位 Agent 的执行、应用及独立运行时复审均通过，实际 SDK 正例和五类类型负例有效。同文件部分声明、source/bundle 混合形态和遗漏/额外/异名原生 worker 均在写入前拒绝。

- `runtime-build-ready-release.log`：再次从锁定 pristine 完整重建通过，12 项原生能力、28 项保留缺口；9 个扩展预编译，0 错误。仅本次进程临时优先使用 npm 缓存，未修改持久 npm 设置，也未跳过 integrity、源码拓扑或冻结检查。
- `verify-ready-release.log`：全部 28 项及最终冻结证明通过。
- `focused-ready-release.log`：最终产物三个专项文件 83 项通过、2 项条件跳过。SDK 语义检查直接使用实际发布声明，不先修复声明再测试。
- `probe-node-ready-release.log`、`probe-electron-ready-release.log`：Node 与显式等待退出的 Electron 各 31 项实际 SQLite、准备/响应及独立 state-read worker 函数断言通过。
- `tests-ready-release.log`：标准完整测试独立运行，910 文件通过、6 文件跳过；10,507 项通过、66 项跳过（265.67 秒），无失败或未处理错误。跳过项不计通过；实际发布 SDK 语义及最终 bundle 专项另按上列显式模式执行。测试结束已恢复并核对 Electron ABI 146。
- `package-ready-release.log`：Windows x64 目录包成功；归档 35,970 文件，包内 28 项 proof、companion、Node/npm/npx、浏览器扩展及两项原生模块 Electron ABI 146 检查通过。`verify-ready-post-package.log` 再次核对冻结证明通过。目录包成功不代替安装器交互验收。
- `lint-ready-release.log`：独立完整检查通过。此前一次检查器内部 `factory2.createJsxAttribute` 解析异常未查得根因；同一未修改文件单独检查、完整重跑及本次独立完整检查均通过，不把那次异常记为通过。
- 前端构建与 Electron 编译分别见 `build-ready-final-2.log`、`compile-ready-final-2.log`，均通过；最后仅修改的扩展类型已由严格 SDK 语义检查及重新预编译覆盖。

目录打包后再次无模型启动最终运行时，既有停止会话历史和可用输入、列表空闲、原生 cron 完整会话及收件箱已读持久化均通过。模型验收候选与最终启动后的 25,018 个执行/依赖文件及 package/lock 清单逐文件比较 **0 差异**，因此正文流与实际停止证据适用于最终执行代码。静态构建曾只差 Main 动态生成的 Windows preload 格式，源函数/编译函数 hash 均已对应并确认语义一致；未就地修补 vendor。Gateway bundle hash 始终一致，最终 SDK 声明则独立完成实际发布语义检查。

最终运行时身份：

- patch set：`97698346dc0e2f94032599b21ff518e99d1577fec2a92d65da589ffe21ce6022`
- build recipe：`4c2929fc2d40d145c4351c23c1ddf6221e33958d1f8c9e311cf42303a863ec60`
- Gateway bundle：`9f0fccdc673a45e3210bc7e29d96e97e1a87b8f0ef54418b1fba509a2f3f8638`（76755573 bytes）
- gateway.asar：`4e8ca60cda30d3e406d8812d7f4297d2ec142b6276027c68cc933cfa937ea2cc`
- runtime package：`b6588b64f66016de8c020c9ff0b29ed4713b87af0ef955d3864066dcbfb038d3`
- npm-shrinkwrap：`886d40c7b53c2b9d7ac45c19b5a7102ac2fc22ca45a267cc6d9adba9b824fc8a`
- Windows `win-resources.tar.zst`：`0eafa831d4bf623ea78a7f9add34aad4ace8ae6cd8ed86fece797b3d3626116b`（448635144 bytes）

## 追加复审与补丁整体校验

按用户要求再次由三位 Agent 对完整升级分支复审，并交叉检查彼此的修复。应用契约和供应链专项未发现新的产品行为错配；初次只读专项 14 文件、259 项通过，原生基线清单和冻结证明核对通过。随后从 025 的公开入口复现跨文件混合状态被补齐，扩展检查全部 28 项补丁，确认 001—025 还需补强写前校验。026—028 已有整组状态门禁。

本轮修复集中在构建校验：所有相关目标先在内存中完成转换、原生依赖检查和整体状态判断，再写入。覆盖 native/SDK/support/bundle 混合、一个 bundle 内的多个子能力、helper 与调用处不一致、缺失 disposition/Close schema，以及 fork/MXC/cron 的缺字段或重复条件。历史与部分形态拒绝时检查写入调用和逐文件字节均不变；当前完整形态幂等、既有编译 marker 规范化及正常生成内容保留。没有以补齐旧 sidecar、重试或更新 proof 来放行旧产物。

交叉复审补充的 003/004/008、012/013/016、017/020/022 细分负例均已修复；部分用例先在修前复现失败，再验证修后拒绝。共享公开入口专项最终 183 项通过；001—008 行为与准入 6 文件 71 项通过（其中准入 58 项），017—024 8 文件 144 项通过、1 项条件跳过，025 独立 11 项通过。数字存在包含关系，不相加冒充独立用例总数。三组对实际 current 的公开 verify 全通过；003/004 另对 14 个真实 source/bundle seam 只读变换，字节均不变。复审及这些检查未启动 Gateway、修改 vendor 或读取用户 transcript。

首次仅包含 025 修复的重建在生产依赖安装阶段被主动中止，以先完成其余入口的修复；该 staging 没有发布为 current。全部修复与交叉复审完成后才重新从锁定 pristine 构建。真实环境仍需补验的操作、预期及限制见[手动验收清单](real-ui-acceptance.md#复审后的手动验收清单)，不将合成测试或历史结果扩大为已完成的人工场景。

`runtime-build-audit-final2.log` 记录本轮完整重建成功，扩展预编译 9 个、0 错误；`verify-audit-final.log` 的全部 28 项及冻结证明通过。与上一轮静态最终构建的 25,018 个执行/依赖文件逐项比较 **0 差异**（清单 SHA-256 `c29b4aa12abbd38bbce2fbaed89ebd9c8aae8a75ed0c451104bcf787db6927e6`）；7,272 个声明、JSON/MD 等资源只有 `runtime-build-info.json` 和 `runtime-patch-manifest.json` 两份构建证明变化。Gateway bundle、asar、package 和依赖锁 hash 均保持下列值。本轮未另启产品界面或真实模型，可保留前轮执行代码对应的流式输出/停止实测；此前 Main 动态生成 preload 的格式差异仍按前节记录，不冒充新界面验收。

本轮首次标准完整运行有两项失败：012 新增守卫后按测试计数为 602 行，超原 600 行预算；未改动的配置同步 Code Mode minimal 用例超 5 秒。仅为同时审计 schema、转发和 native/worker 投影的 012 设置 625 行有界例外，019 仍为 1200、其余仍为 600，经另一位 Agent 只读复审通过；没有挤掉安全校验或修改执行代码。配置逻辑和测试超时时限均未调整，两份失败所在文件独立复测 114 项全部通过（`audit-full-suite-repair.log`），随后以三个 worker 重跑完整套件。单次并行超时原因尚未确定，不将独立复测当作完整套件通过。

`tests-audit-final2.log` 的标准完整复跑成功：910 文件通过、6 文件跳过；**10,640 项通过、66 项跳过**（324.34 秒），无失败或未处理错误。此前超时的 minimal 配置同步在本次完整运行中用时 2,869 ms。结束后 Electron better-sqlite3 已恢复并核对 ABI 146。`focused-audit-final.log` 再次对本轮最终 SDK、bundle 和 canonical-read publication 运行三个专项文件，83 项通过、2 项条件跳过。

随后对本轮最终 bundle 运行 `plugin-owned-execution.native-smoke.cjs`，Node/Electron 各四类均通过：持久整轮结算与跨插件拒绝、后台进程消失后清理结算、精确取消，以及重启保留已结算证据、被中断运行保持 unknown 并拒绝不确定取消（`owned-node-audit-final.log`、`owned-electron-audit-final.log`）。使用独立 Gateway、状态和本机 HTTP 模型 fixture，没有调用用户配置的真实模型。两轮 Gateway 及其测试进程均已关闭。

`sqlite-retirement-lifecycle.native-smoke.mjs` 的备份更新、更新回滚、删除、错误关闭、正常退出及崩溃六类，在 Node/Electron 下各全部通过（`sqlite-node-audit-final.log`、`sqlite-electron-audit-final.log`）。Electron 最终函数/SQLite/Windows namespace/worker 专项另有 31 项通过（`readiness-electron-audit-final.log`）；Node 同项已包含在上述最终产物专项中。这些隔离原生检查不代替终端/子进程的界面停止及其余手测场景。

`package-audit-final.log` 记录本轮 Windows x64 目录包成功：归档 35,970 文件，包内 28 项 proof、companion 和原生模块 Electron ABI 146 核验通过；`verify-audit-post-package.log` 再次核对全部补丁与冻结证明通过。目录打包没有安装或启动产品，不代替安装器交互与手动验收。`lint-audit-final.log` 的完整源码检查通过，提交前 `git diff --check` 通过。

本轮最终构建身份：

- patch set：`b92cc1be485ce170fddda657b19a2800a63a13de2f67156dad96bf331e33dd55`
- build recipe：`b8c41a3fe43f036ea22023fad2520016e70ed1996fd11068242b4127898b476b`
- Gateway bundle：`9f0fccdc673a45e3210bc7e29d96e97e1a87b8f0ef54418b1fba509a2f3f8638`（76755573 bytes）
- gateway.asar：`4e8ca60cda30d3e406d8812d7f4297d2ec142b6276027c68cc933cfa937ea2cc`
- runtime package：`b6588b64f66016de8c020c9ff0b29ed4713b87af0ef955d3864066dcbfb038d3`
- npm-shrinkwrap：`886d40c7b53c2b9d7ac45c19b5a7102ac2fc22ca45a267cc6d9adba9b824fc8a`
- Windows `win-resources.tar.zst`：`e00ae923c7ba8aec5c4fcf00b8e4e65e03563bd112089dbdf70fbc82281da8b7`（448633466 bytes）
