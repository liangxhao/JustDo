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

逐项能力、删除条件和旧/新编号映射以[当前补丁总账](../../../scripts/patches/v2026.10.4/README.md)为准。首轮 25 项和后续候选构建的验证保留在下文；026—029 及其最终构建分别记录，避免混用产物证据。

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

## Plugin Hub 生命周期复核

对照 `../openclaw` 的 v2026.10.4 源码、实际运行时及页面调用方复核四类管理流程。本轮只修改应用适配和展示，不增加运行时补丁、不替换活动运行时、不调用真实模型。

| 类型  | 本轮核对的流程与结论                                                                                                                                                                                                                                                                                              |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 扩展  | `plugins.list` 的配置开关与 `runtime` 健康状态分别处理。修复漏报 `runtime.error`、`service-failed` 及 `needs-setup`；保持原生启用意图、管理权限及卸载保护。安装审查、CLI 最终回执、原生 reload/refresh、卸载和失败后的清单对账维持现行协议。实际 CLI 验证安装、停用、保留停用状态更新、启用、卸载及移除后的清单。 |
| Skill | `skills.status/update`、开关回读确认、文件导入/覆盖/删除、同名有效来源与父扩展归属无新增协议错配。原生解析复核覆盖关闭赢家不切换来源、删除赢家后回退，以及两个工作区各自解析。没有独立执行测试按钮；列表可用性来自原生依赖与资格状态。                                                                            |
| MCP   | 用户配置 CRUD、原生配置投影、扩展连接发现/归属/只读参数/启停及测试保留原生语义。实际 native 与 bundle 两类连接覆盖清单、定向连接、工具/资源/提示发现、资源读取、停用后的显式测试、完整覆盖优先、错误脱敏及父扩展禁用；不调用工具或写回测试配置。                                                                  |
| Hook  | `hooks.status` 的 `enabledByConfig`、`requirementsSatisfied`、`loadable` 和 `blockedReason` 已接入；导入、开关、隔离删除、配置同步与 `plugins.refresh`、回滚及父扩展分组维持现行契约。独立 Hook 没有市场更新入口，同名导入拒绝覆盖；扩展附带 Hook 继续由父扩展管理。                                              |

验证证据在本机忽略目录 `.agent-tasks/plugin-hub/`，不提交原始日志：

- 新增回归先复现 4 个失败：3 类原生运行错误及没有环境缺失项的配置状态；修复后均通过。首轮两文件回归另有一项既有压缩包测试超过 5 秒；其文件夹/压缩包两种形式独立复测通过，后续广泛回归也通过，没有调整超时时限。
- `plugin-suite.log` / `.err.log`：使用 Electron Node 模式及可信 Windows preload，避免切换正在使用的 SQLite ABI。65 个完整文件、914 项通过；另一个原生 Skill 解析文件有 2 项通过、1 项 CLI 子进程超时。该文件随后按项目 Node 24 要求独立运行，3 项全部通过（`skill-native-rerun.log`，69.69 秒）。这些为分批结果，不宣称首轮整套无失败；Electron 子进程单次超时原因未确定。
- `extension-mcp-native.log`：`node --test tests/openclaw/runtime/extension-mcp.native-smoke.mjs` 通过；独立状态与连接，运行插件入口被故意设为抛错，证明清单和测试不会通过执行插件入口完成。
- `extension-lifecycle-native.log`：`node --test tests/openclaw/runtime/plugin-management.native-smoke.mjs` 通过（146.65 秒）。实际应用导入服务、安装器和 CLI 使用一次性配置、端口及凭据，覆盖保留停用策略的升级和最终移除；没有启动 Gateway，测试目录已清理。
- 完整 lint、Renderer/Electron 两组 `tsc --noEmit` 通过；现有运行时 28 项补丁冻结核验通过。没有为测试重建或替换使用中的原生模块。

尚需人工验收：重启开发应用使 Main 适配生效后，在插件页面验证真实本地扩展的审查/取消、热启停/更新/卸载及附带 Skill/MCP/Hook 刷新，观察实际注册/服务失败和待配置提示；对 Skill 导入/同名覆盖/开关/删除、MCP 编辑/测试/开关/删除及 Hook 导入/实际触发/停用/删除做界面闭环。真实企业市场提供方、远端 OAuth/TLS MCP、活动任务期间的插件热变更、权限拒绝和真实文件占用仍未在本轮覆盖。仓库默认未注册市场提供方；扩展/Skill 的自动更新依赖已安装市场身份和提供方能力，本地扩展/Skill 可重新导入，Hook 没有独立更新流程。现有 Chrome 扩展配对延期决定保持不变。

### 多 Agent 交叉复审补充

三名 Agent 分别检查安装更新、卸载归属与界面刷新，再交叉检查修复。补充修复如下：

- 本地交互式安装将人工确认的 `reviewToken` 传给原生 `plugins.install`，由最终 staging 核验能力面；不再用 CLI 无条件接受新能力。安装请求使用 10 分钟窗口，未知结果不重放。多入口包保留精确 manifest owner 与原生代表子 ID 的区别，按真实包目录核对出站策略和安装身份，不按子 ID 前缀猜路径。
- 已提交但运行态应用失败时，提交事实、原生 ID 和已核验路径穿过 Main 安装器与市场登记；市场保留版本身份，Renderer 显示错误和状态刷新，同版本不重新安装，在“可更新”筛选下也保留待处理反馈。无法确认的安装保留可能仍被原生读取的临时源；仅 Main 持有来源占用标记。
- 卸载超时或断线后只读核验清单和本次原路径，无法确认时报告待确认；只有明确未发送才允许离线 CLI 恢复。原生关联拒绝和包含目录占用文字的断线也不能触发重放。
- 已打开的扩展详情跟随成功清单更新，移除时关闭；Skill 订阅父扩展变更，已移除条目的详情不会因同 ID 恢复自动重开。MCP 保存、删除、开关和市场刷新前后使旧测试结果与在途代次失效。配置保存反馈受详情代次约束，迟到结果不污染另一详情或新草稿。

新增实际原生验证 `node --test tests/openclaw/runtime/plugin-capability-consent.native-smoke.mjs`：原能力面可接受旧令牌；增加工具后旧令牌被拒绝，即使存在原生自动确认回调；重新审查的新令牌可接受。另验证临时目录变化不改变相同能力面的令牌。此验证直接调用当前运行时的原生 staging consent，不执行插件入口、不启动 Gateway、不调用模型；它验证的是原生声明能力面令牌，不宣称冻结所有源码字节。

`node --test tests/openclaw/runtime/plugin-package-ownership.native-smoke.mjs` 的加强版也通过（`package-ownership-native-complete.log`，60.51 秒）。独立配置、端口和随机凭据，初始只允许无关的 `memory-core`；实际多入口 CLI 安装后两个子条目均启用，原生 ownership、真实 native catalog、应用列表路径和市场身份一致，列表不发生误刷新；已提交失败中的 owner 也规范到同一代表条目。最初真实样例暴露的 CLI 子 ID 终态匹配和 fixture 对具名原生导出的读取问题已修正。此样例不启动 Gateway，不代表真实在线热安装验收。

补充回归、类型和构建结果见本机 `.agent-tasks/plugin-hub/review-*.log`。`review-suite.log` 使用 Electron Node 与可信 preload，65 个文件、967 项通过；后续交叉修复的受影响文件另行复测，不把不同批次的重叠用例相加。

Renderer 末轮单文件回归分别为扩展 34、MCP 33、市场 35、Skill 21 项通过；Main IPC 与市场适配末轮 62 项通过。安装服务和安装源在隔离 Windows 锁查询后完整复测；锁归属专门用例仍显式提供对应诊断结果，实际原生能力审查继续由独立 fixture 验证，没有提高单测超时或改变生产文件锁诊断。

最终完整 lint、Renderer 构建和 Main `tsc --project electron-tsconfig.json --noEmit` 通过（`review-lint-verified.log`、`review-build-sealed.log`、`review-main-types-sealed.log`）。编译不切换 SQLite ABI；没有为本轮修改重新生成 OpenClaw 运行时。

所有补修完成后的五文件末轮回归 `review-final-regression.log` 为 217/217 通过，覆盖完整安装服务、Windows 安装源、扩展 IPC、市场 IPC 和市场服务；与此前 967 项整套回归有重叠，不相加为独立用例总数。

本轮没有进行真实界面验收或替换活动运行时。上述人工项仍需验证，尤其是新增在线本地安装的真实 Gateway 回执、权限/活动任务冲突、多入口包更新卸载，以及企业市场真实下载更新和远端认证 MCP。请在自行重启开发应用后验收；本轮未关闭正在使用的应用或 Gateway，也未切换 SQLite ABI。

## 2026-10-17 通用结构化思考与正文流式修复（029）

针对用户报告的思考后正文集中到达，新增 029，按原生归一后的思考/正文通道处理，不含模型、服务商或端点白名单。公开插件包装只能取得已经解析的事件，不能解除传输层缓冲；本轮保留小范围运行时补丁，不重写提供方传输。解析恢复、实时预览和原生终态交付的具体边界见[补丁总账](../../../scripts/patches/v2026.10.4/README.md)。三名 Agent 分别复核解析、事件/终态以及构建证明，最终只读复审未发现阻塞问题。

- 从锁定 pristine npm 包强制执行 `OPENCLAW_FORCE_INSTALL=1 npm run openclaw:runtime:host`，全流程成功；实际 source、最终 bundle、预编译和裁剪后 29 项补丁校验通过。不是修改旧运行目录或 manifest 来绕过校验。
- 225 项解析/传输/订阅/补丁形态测试通过；8 组无网络原包/补丁对照和实际重建包探针通过。任意模型、服务商、端点及传输别名的公开正文先于终态到达；显式 strict 仍保留原生缓冲。该证据不代表已经重新验收真实服务或界面。
- 完整 lint、应用构建通过。标准测试后已恢复并核验 Electron SQLite ABI 146。完整回归为 910 文件通过、5 文件失败、5 文件跳过，10,998 项通过、5 项失败、64 项跳过，并出现一次 V8 worker 异常；该批次不是全绿。
- 后续独立复验：配置超时所在筛选批次 13 项通过；记忆与浏览器历史两个完整文件 25 项通过；两个原生 Skill 契约文件均通过。记忆测试导入失败由已有整模块 mock 缺少 `execFile` 引起，仅改成保留其它导出的局部 mock，没有改生产链路。浏览器历史独立复验使用 60 秒 hook 等待，保留全部断言。
- 可选的第二份 pristine 全图构建测试超过 900 秒，未记为通过；正式 host 全图构建及实际产物证明已通过。Windows MCP 批次有一项 Chrome 子进程树清理无法确认，单项再次复验仍因原生进程快照的 2 秒命令上限超时；其余四项通过。该问题不在 029 修改范围内，不能作为全面子进程验收通过的证据。

本轮没有发起真实模型请求，未启动 Gateway 读取历史或直接读取 transcript。实际用户会话的首正文时间、结束前是否分段显示仍待重启后复测；前序真实验收结果不覆盖这份新构建。

本轮 Windows x64 运行时身份：

- patch set：`3f1a58a77cb9871758b0526fbffc663df6ebda0af19514b943bcdc95f4b37ae2`
- build recipe：`7894d6373d6e94185468e7ac79741c4bc7e7bb959d1b903c64096343d9d26f3b`
- Gateway bundle SHA-256：`c5f2d9c18b935aeb7d398b31b3de9176979805c7d679e37f3418ef7cab5c9158`（76,757,264 bytes）
- gateway.asar SHA-256：`cfe72b74327cdcaf9dc8d2ad74eb0c9270411055547ecaf4a7d9b20a58ee20b0`
- npm-shrinkwrap SHA-256：`886d40c7b53c2b9d7ac45c19b5a7102ac2fc22ca45a267cc6d9adba9b824fc8a`（本轮依赖版本及 integrity 未变化）

AI 传输与分区解析模块的精确身份和 hash 已纳入本轮 current/frozen manifest 及归档校验。本轮没有重新生成 Windows 安装包；旧包的打包结果不作为 029 的安装版验证。

## ACPX / TypeSafe 源码同步与 ACPX 0.19.5

本轮在独立 worktree `acpx-typesafe-10-4/JustDo`、分支
`codex/acpx-typesafe-10-4` 完成，应用基线为 `1cd2e66b3`。没有修改或合入
`dev` 的并行工作。目标源码为 OpenClaw `v2026.10.4`，提交
`383c124cc32ffee3f8e56f549b88da94d269a4af`；Node 24.21.0、Electron 42.7.0、
Windows x64。上文各历史构建的测试数和真实界面记录不替代本轮验证。

ACPX 原包名虽为 `2026.9.8-local.1`，实际源码祖先仍为 9.2，不能只调整版本号。
本轮按祖先、本地定制及 10.4 做三方比较，采用原生 generation/session-store、
probe、process-cleanup、稳定 lazy facade、Pi catalog 和 Windows argv 接线，
保留受管目录、隔离认证、结构化命令、构建时目录、逐 Agent 诊断和默认不启动探针。
未开放运行时下载、原生第二套模型选择器或工作区状态目录接管。完整对应关系和
上游来源见 [ACPX 来源记录](../../../openclaw-extensions/acpx/UPSTREAM.md)。

TypeSafe 同步 10.4 的 `isAdmissible`，从注册入口经 client 传入 transport，
在首次准备及真实 DNS 等待后的 `beforeRequest` 再检查；保留显式内网服务、认证、
取消和资源释放。内网和 loopback 请求禁止重定向/环境代理，hosted 保留上游代理策略。
来源及定制见
[TypeSafe 来源记录](../../../openclaw-extensions/typesafe/UPSTREAM.md)。

OpenClaw 10.4 上游仍使用 acpx 0.19.1；本轮额外评估并精确锁定 0.19.5。
其公开运行时接口和持久会话格式兼容，采用首次持久会话加载、并发 ensure/import、
历史保存与关闭错误聚合等修复。Claude ACP 0.79.0、Codex ACP 1.12.0 保持不变。
`@openclaw/fs-safe@0.22.0` 的可选平台包和 integrity 保留在 npm 生成的锁中。
同时将已有生产依赖 MCP SDK / TOML parser 精确锁定到 1.31.0 / 1.9.0；
对应公告、实际影响边界及零告警审计见 ACPX 来源记录。离线资源清单仍统一维护于
[离线下载文档](../../offline-downloads.md)。

三位 Agent 分工并交叉复审，发现并修复了以下边界：

- 未启用的内置 Agent 做诊断时，先准备其本地包装器；缺失目录命令直接拒绝，
  不落入 ACPX 默认包下载，也不因此授予任务准入。
- 服务先撤销发布再等待实际 shutdown；部分启动失败也等待清理。探针清理失败保留
  owner，并传播到服务关闭；清理失败屏障阻止新代接管，不伪报退出成功。
- Codex 异步读取后重新检查 generation；旧 turn 固定准入时的 lease，重置后不能
  读到后继任务的 stderr。后台关闭和进程清理同时失败时保留两项错误。
- 移除给整个 ACP 任务套用连接超时的旧钩子，继续由 OpenClaw 管理执行期限。

应用构建另暴露基线 `process-history.test.ts` 中 `unknown[]` 强转不符合消息类型；
仅将 fixture 改为真实数组收窄，错误 fixture 明确失败，没有更改产品聊天逻辑。
该最小修复经另一位 Agent 只读复审。

本轮未启动 Gateway、使用用户凭据、读取用户 transcript 或调用真实模型；协议测试
只使用隔离临时目录及本机模拟 ACP peer。ACPX 插件源码的完整静态类型检查仍受上游发布 SDK 缺失
部分 ACPX facade 声明限制；未伪造 ambient 声明来宣称通过。TypeSafe 则直接使用
实际发布 SDK 的严格 TypeScript 语义检查。

最终产物专项记录位于本 worktree 的 `.agent-tasks/plugin-refresh/`，原始日志不入 Git：

| 记录                                            | 结果与边界                                                                                                                                                           |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `runtime-build-final.log`                       | 从锁定 pristine 完整构建成功；9 扩展预编译、0 错误，随后完成裁剪。                                                                                                   |
| `verify-final-runtime.log`                      | 28 项补丁及冻结证明全部通过。                                                                                                                                        |
| `acpx-final-runtime.log`                        | 19 文件、119 项全部通过，73.54 秒；实际 SDK 和 acpx 均来自新 runtime，真实旧 0.19.1 临时 store/handle/history 兼容分支已运行。                                       |
| `typesafe-final-runtime.log`                    | 12 文件、189 项全部通过，22.95 秒；包括三类服务地址各四项准入/DNS 撤销检查。                                                                                         |
| `typesafe-sdk-final-runtime.log`                | 实际发布 SDK 严格语义检查 1 项通过，4.39 秒；运行时仅有 JS 的辅助 facade 从实际 JS 解析，不补造声明。                                                                |
| `acpx-electron-final.log`                       | Electron 42.7.0 下真实 acpx 协议回归 1 项通过，40.94 秒；其内置 Node 为 24.18.0。并发 ensure、会话复用、拒绝权限后下一轮、取消、关闭流、进程退出和旧版本数据均覆盖。 |
| `lint.log`、`build.log`、`compile-electron.log` | 应用静态检查、前端构建与 Electron 编译通过；前述测试数据类型修正后重新构建。                                                                                         |

另在 Electron 下直接加载 `fs-safe@0.22.0` Windows x64 native 成功（48 exports），
对应文件 1,720,832 bytes，SHA-256
`d2bceba7ecc2d97563c76923f0f7928a76ab098ad70456eafba19b6fdb647828`。
上述专项与完整应用测试有重叠，不相加冒充独立测试总数。

首轮完整测试 `tests-final.log` 未通过：6 文件失败，14 项失败、10,657 项通过、
70 项跳过（665.80 秒），不能计为全套通过。定位到 ACPX 根测试缺少新引入的
SDK helper fixture，专用配置实际 SDK alias 因而未暴露这个收集缺口；现已补齐
最窄依赖 fixture。其余配置失败均为真实文件投影循环超过默认 5 秒，五组矩阵
每例分别执行 6/9/13/10/9 次同步，保留全部断言，只给对应矩阵设置 15/30 秒预算。
实际原生历史模块冷加载与每例两次技能 CLI 冷启动也改用局部有界预算，未修改
全局时限、生产期限或添加重试。以上测试修复经另一位 Agent 只读复审。

首轮还有一次浏览器 MCP 的原生进程检查超时和一次卡片资源初始化失败；未证实
产品逻辑缺陷，不据此修改原生检查或增加卡片等待/重试。`tests-repair-serial.log`
将全部失败文件及聊天类型修复用例合并串行复测，7 文件、202 项全部通过
（366.56 秒），两项原测试保持原样。测试后已恢复 Electron ABI 146；随后降低
worker 数独立完整复跑，不以局部通过代替全套结果。

`tests-final-rerun.log` 的独立完整复跑通过：914 文件通过、6 文件跳过，
**10,683 项通过、66 项跳过**，962.30 秒，退出码 0，无未处理错误。
使用两个 worker，实际 TypeSafe SDK 检查及新 runtime 内 acpx 0.19.5 / 旧 0.19.1
数据兼容分支均已启用；跳过项不计通过。结束后再次核对并恢复 Electron ABI 146。

`lint-final.log`、`build-final.log`、`compile-electron-final.log` 的提交前完整检查均通过。
`package-final.log` 的 Windows x64 目录打包成功：资源归档 36,105 文件，包内
28 项 proof、companion、浏览器扩展、Node 24.18.0 / npm 11.19.1 / npx 11.19.1，
以及 better-sqlite3 / node-pty 的 Electron ABI 146 全部核验通过。
`verify-post-package.log` 再次核对补丁及冻结证明通过。打包前后核对下列 runtime
文件及两插件 package/lock 哈希全部不变，见 `post-package-identity.json`。
没有安装或启动目录包，不能代替安装器交互或真实模型验收。

`archive-native-audit.log` 另由独立 Agent 流式读取最终 Zstd/tar，确认 ACPX
manifest、assembly target/fingerprint、安装后的 package 和 lock 均在归档中，
核心/适配器/安全依赖版本与 fresh 产物一致；fs-safe Windows x64 native 的大小及
SHA-256 与前述已在 Electron 加载的文件精确一致。没有执行归档代码或启动产品。

本轮最终构建身份：

- patch set：`b92cc1be485ce170fddda657b19a2800a63a13de2f67156dad96bf331e33dd55`
- build recipe：`eb0e6e3a56f086de0876513180d6ac8c5701c5bd748e2b3a83514057d4dcd034`
- Gateway bundle：`9f0fccdc673a45e3210bc7e29d96e97e1a87b8f0ef54418b1fba509a2f3f8638`（76,755,573 bytes）
- gateway.asar：`3c099c933a9dfbc81524284f5661428da0a3f5c4627b943c8cc0228eefb87ef5`
- runtime package：`b6588b64f66016de8c020c9ff0b29ed4713b87af0ef955d3864066dcbfb038d3`
- npm-shrinkwrap：`886d40c7b53c2b9d7ac45c19b5a7102ac2fc22ca45a267cc6d9adba9b824fc8a`
- ACPX lock：`4707781e87179adb44b6229b792c591cc44105de3416d89e9b4a3ccde3c0f1cc`
- TypeSafe lock：`d93fbb5e2642e72040e9acd335cd9345916c5b755128b8e27a9b6612ae753686`
- Windows `win-resources.tar.zst`：`7237d81b8141ac8225d3d22c47c3bd98b38e3731d6fa17244b93d0f65ce1b2dc`（449,189,330 bytes）

本轮仍需使用最终安装包手工验证：

- 使用真实 Claude/Codex 凭据首次连接、凭据过期/更新，分别从新会话和已有会话执行任务。
- 实际外部 Agent 的长任务、动态 MCP、权限拒绝后的继续执行、停止/重置和应用退出，
  核对不会残留受管进程、误报结束或影响后继任务。
- 真实 TypeSafe 内网地址、认证更新、取消和提供方切换；合成 DNS/HTTP 测试不代表真实服务可用性。
- 中文/空格安装目录的完整安装交互，以及 macOS/Linux/Windows arm64。

Chrome 日常窗口授权及扩展配对继续按用户此前要求留待手测，本轮没有恢复该验收。
