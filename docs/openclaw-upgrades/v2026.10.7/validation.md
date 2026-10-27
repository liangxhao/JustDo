# 验证与独立审查

日期：2026-10-25 至 2026-10-26（Asia/Shanghai）。原升级应用基线
`62342c478c7c55645c892094cf668c7ea7141fa8`，分支 `codex/openclaw-2026-10-7`。
本地证据位于 `build/upgrade-audit/v2026.10.7/`，不提交原始日志、凭据或用户 transcript。

实际开发 Node 为 24.22.1，安装的 Electron 为 42.7.0（项目约束 `^42.6.2`），
native ABI 为 146。测试准备器会临时使用 Node 的 better-sqlite3，再恢复 Electron ABI。

## Chrome 随包依赖修复与后续产物 F

最终 F 构建前再纳入 dev 已提交的 `39bd8dc96` 和 `fdf4cfdc7`，基线固定为
**2026-10-26 16:31 的 `fdf4cfdc79d9a28af70ef31f23e6ed1037287159`**。
84 个变更路径包括 `present_plan` / `ask_user_question` 更名及历史折叠回答。
三名 agent 独立确认原插件 ID、RPC、执行终态与授权边界不变，无新增 .7 原生
补丁需求。四个本轮提交无冲突重放为 `6280a8053`、`08ae06fd2`、`e3a454d20`、
`c00a87127`；主目录未提交修改没有带入。以下 E 的 fd2 基线属于历史记录。

F 采用全新强制 pristine 构建，输入 checkpoint 为
`c00a87127ea6c4e17781be09e6a8b2dedc8a0b36`，recipe 为
`254b4da49f9b509c6781f10170e58f792b258df6d619daaf76db87e7ef28534a`，
patch set 仍为 `b39e45d846759b03670f0d699b05f17cf1bbadc1fb620395466315061405defa`。
仅本次构建子进程将 Node heap 上限设为 16 GiB；产品运行参数和测试预算未变。

| F 检查 | 状态 |
| --- | --- |
| rebase 与独立复审 | 无冲突；最新 dev 全部生产/插件/browser 改动保留；三名 agent 无剩余源码阻断 |
| lint / 前端 / Main | 三项实际退出 0；Main precompile 确认 Electron ABI 146 |
| 浏览器扩展组装 | 从当前本地源码重新 prepare，退出 0 |
| 强制 pristine pipeline / 最终冻结 | 完整入口、最终冻结及独立备份均退出 0；新 proof 已绑定 |
| 依赖图 / 技能资源静态审计 | 两项实际退出 0；Chrome raw/final 完整 360 文件一致，357 资源及 26 新输入一致 |
| 严格矩阵 | 43 文件、1,073 通过；唯一互斥用例已单独补验通过 |
| SDK / group / ACP / CLI | 所有独立探针顺序退出 0，含 SDK 清理、Chrome、两组 Group、ACP、模型插件 CLI |
| 完整 13 段门禁 / 全量测试 | 门禁/独立审计均为 0；29 项定向通过；第二轮完整测试 1,251 文件/17,509 项通过，零失败 |

最新工具改名没有增加旧名称别名：旧 transcript 中的 `AskUserQuestion` /
`PresentPlan` 继续按通用工具历史展示，新结构化问答按新精确名称和 toolCallId
接纳结果。该展示范围不等同于真实 Electron/浏览器视觉或企业模型决策验收。

E 的依赖图检查首次退出 1，严格矩阵尚未启动。原包 Chrome 子树为 360 文件，
E 为 359 文件：357 个相同，`McpPage.js` / `TextSnapshot.js` 恰好退回公开 npm
1.10.1 的原始字节，`OPENCLAW_PATCH_NOTICE.md` 缺失。失败日志、receipt 及后续
完整性审计均已备份，80 个原包目标和 176 个保护文件未被图准备改写。

三名 agent 独立核对上游 .7 的 `patches/README.md`、固定哈希、notice、实际包名/
版本/SRI 及消费路径，确认是构建缺陷。`installProdDeps` 清空原包 `node_modules`
后重新安装依赖，覆盖了 OpenClaw 明确随包提供的 Chrome 快照身份修复。原生
browser 的真实 `createRequire.resolve` 与 Main shim 均落到该根 CLI；缺失的
frame/CDP session/loader 身份、失效检查及 frame 范围的 CSS 解析属于实际能力。
registry 基包 SRI 和 `inBundle:true` 没有证明上游修改字节，不能放宽 raw/final
整树比较，也不能把 E 的旧冻结校验或静态资源成功当作可发布结论。

已交叉审查并批准应用构建侧修复：使用已通过 source-lock 的原包声明清单，
在生产依赖安装后、shrinkwrap 前完整恢复 bundled dependency 子树，保留代码、
notice、LICENSE 和第三方说明；加入稳定文件清单、根归档来源、构建证明和冻结
核验。不得只覆盖两个 JS、伪造 Chrome 基包 SRI 或修改 E 后补签。
不新增原生补丁，既有 33 项及 b39 patch set 不变。最终组合改记为 F，已重新
完成构建、冻结、严格矩阵、实际 SDK/group/CLI、单次完整 13 段门禁及完整测试。
F 的实际输入、固定身份、首轮失败收口和最终验证结果记录如下。

构建 helper 最终定向测试为 66/66、零跳过。冻结/裁剪/打包三文件首轮发现
选择性归档提取遗漏新 proof 和完整 bundled 子树，已修复并补充归档变异、
Windows 路径及链接负控。最终三文件为 138 通过、2 项既有 provider 用例在默认
5 秒截止超时；随后 maxWorkers=1、原 5 秒预算精确复验两项分别为 2,097/1,618 ms
通过。保留各轮原件，不拼接为三文件整体成功；最终仍以 F 的完整测试为准。

F 完整构建实际从 17:27:30 至 17:49:53，bundle 为 569,512 ms；扩展编译
10 项、按策略跳过 18 项、零错误，裁剪 16,528 文件。最终冻结校验通过后，
在工作树外保存完整独立 tar（1,149,948,416 bytes，SHA-256
`e144471b1887d0f00d81ca4db9ba85ac9df945773b312aa147f2b502bfba46d1`）。
F identity JSON 的 SHA-256 为
`263fdc595625a2ef7a41d2342b81a6040e2c45fed8970cd437951b9cf7edd0bf`。

| F 固定身份 | SHA-256 |
| --- | --- |
| patch manifest | `2faff5f450a6d7b73e8bce7512e7e97deb9a4964f321177528844f7d82e3a0db` |
| build-info | `7a025bba5d11da323e29584437751bea7faa1005fa8efb6ab4b52c32986eaaf2` |
| bundled proof（81,382 bytes） | `08c9e0a06aa03ac0a2a497f43bc4c939857df32a5d580581b0d3f917219a9aca` |
| Gateway bundle（78,466,299 bytes） | `d7a071eaa1fbfc576eb55b07f8ff528084ad3076a42f3b59412c5ee4f0310533` |
| Gateway ASAR（218,963,199 bytes） | `0337cba8d556e8f0e9f1066cf6ea81ab612d9d7e0747127be9bf8734d1fe3af7` |

bundle/ASAR 字节与 E 相同是此次全新构建的结果；被修复的 Chrome 属于外置
node_modules，须由独立 raw/final 全树核对及真实 CLI 接线验证。F 的源码 recipe、
构建证明、随包树和应用插件重新绑定，不以核心字节相同推断复用了 E 或补签。
原生测试前已单独 rebuild 并真实打开 `:memory:` 验证 Node ABI 137，退出 0。

F 依赖图首次正式执行退出 0，重新验证 E-origin 只读 pristine/before031
夹具的来源、80 个 raw owner、43 个 patch 输入及支持文件，不把 E 的失败图当
F 证据。两个 private 依赖按 F 锁校验；322 个 generic 依赖中 85 个既有链接
重新验目标，237 个新建。Chrome 原包 360 文件与 F 360 文件精确一致。
静态审计的 357 资源、26 新输入、OpenAI 85 个来源、三个 SKILL 的完整字节和
ASAR 中零遮蔽副本均通过，前后 F 身份不变。

三阶段严格验证实际全部退出 0：原包真实 subscriber 7/7 和 SDK 语义 1 项，
随后完整 43 文件矩阵 1,073 通过、1 项互斥跳过，最后精确 raw-only 补验该项
通过。final subscriber 7/7、Goal 5/5 和 final SDK 语义 1 项确实执行通过；
精确 name filter 排除项不算业务 skip。各阶段 177 个保护文件、80 个 raw owner
及完整依赖图前后逐项一致，F identity 和 manifest 未变。没有放宽形态断言或
用普通 npm Chrome 替代原包树。

真实 F SDK 清理探针的 write/read 子进程均退出 0：19 个策略字段先写入再由
undefined 清除，同进程与 fresh-process 均读回为空；过期 SID/revision 拒绝零写，
updatedAt 不变，commit guard 恰好执行一次。Chrome 独立探针也退出 0：重新按
锁定归档 SHA-256/SHA-512 核对 pristine，全 360 文件与 final 相同，canonical
tree SHA 为 `433b09ca372115869c52328beaac8a5dfe6ff070c3c199dfceaa08ba13abae73`。
真实 `normalizeChromeMcpOptions` 导出与 Browser 父模块的 require.resolve 一致，
均得到随包 Node 和根 Chrome CLI；独立执行 `--version` 返回 1.10.1。两个修复 JS、
notice、LICENSE 和第三方说明都与原包一致，前后 F 身份不变。这不等同于真实
浏览器跨 frame 交互或视觉验收。

F Group 的 tool-inheritance 模式为 3 场景/7 个模型请求，member、automatic
continuation、borrowed 三阶段均完成真实文件写入；源 SID/revision 保持。
default 模式为 8 场景/16 个模型请求，覆盖广播、第二轮 NO_REPLY、静默结束且
不重试、精确提及、whole-group Stop、provider failure 保持 failed，以及工具
继承后的真实任务继续。两组均退出 0，Gateway/合成模型端口在清理后拒绝连接。
ACP fixture 0.19.5 和 CLI inventory 随后顺序退出 0；唯一 loaded OpenAI 为
F 的 `dist/extensions/openai/index.js`，provider 精确为 openai/video-openai，
没有旧 wrapper 或独立 video 目录。每个 inner/outer 运行和业务 receipt 都已
备份且前后 F 身份一致，未使用真实企业模型或 UI。

F 单次完整 13 段 module window 从 18:18:39 至 18:34:53，整个入口退出 0，
没有拼接分段结果。内部 gate 的构建准入、Node 准备/实际内存数据库打开、13 段
执行、执行后准入和 Electron ABI 恢复均为 0。watcher 先 ready，正常 stop/退出 0，
无强制终止；最后独立 auditor 退出 0。前后 identity JSON SHA 完全相同。
module log SHA 为 `38d5cb9060e2d05a6fa4de50f6148430707dcc6bede2bb916b6f07c070056efe`，
completed ledger SHA 为
`2aa4f4d00194c572ac46749404d46de7d37caf351e6138b0653b3cb3c8b4eea3`。
2,927 份源码输入快照绑定 c00/254b；13 段含新增真实 Chrome 两项，五段协作
源合同/Main/Renderer/Team/Swarm 均实际退出 0。原始结果和编译接线证据在执行中
持续备份到工作树外，最终 68 个版本副本已核对。独立复核确认 9 份收据字节/SHA
完整，Main/Renderer/Team/Swarm
输入数实际为 126/222/31/12，检查数为 6/7/5/6；Renderer controller 和 Swarm host
当前文件重哈希与 watcher 早期记录相同。全量测试在该窗口结束、Electron 恢复
成功后才单独启动。

F 首轮全量为 1,247 文件通过、25 文件跳过、3 套件初始化失败，17,480 项通过、
848 项跳过，用时 942.58 秒。两个 ACPX 套件在收集阶段缺少源码插件独立依赖
`smol-toml`；订阅夹具默认选择 current junction，但 esbuild 返回物理 helper
路径，精确拦截失配后误载完整模块，在 CJS 产物中遇到 top-level await。
该套件准入项通过，其余六项因 beforeAll 失败未执行，不能算作资源不可用。
首轮日志/JSON/state 全部保留，执行后 F 冻结校验及 Electron ABI 146 恢复为 0。

收口仅涉及测试和环境：`b90d8a80f` 将订阅夹具先 realpath 再按精确包名/版本
准入，并断言 exact helper 每次恰好拦截一次；owner、导出、正负控及预算不变。
源码插件按自身 lock 离线 ci 准备 163 个包，smol-toml 1.9.0 的 SRI、包/锁文件
和完整无链接依赖树均验证；产品源码、33 patch、recipe 及 F 身份未变。
2,927 份门禁输入也再次逐文件核对一致。默认 alias 入口与两个 ACPX 套件随后
统一定向复验为 3 文件/29 项全部通过、零跳过，24.74 秒，前后冻结及 Electron
恢复均为 0。第二轮全量从同一 F 独立重跑，仍为 30 秒 test/60 秒 hook、
maxWorkers=2，单项显式预算保持原值，使用全新日志/JSON/state，不覆盖首轮证据。

第二轮完整入口实际退出 0：Vitest 为 **1,251 文件通过、24 文件条件跳过，
17,509 项通过、841 项条件跳过、零失败**（共 1,275 文件/18,350 项），用时
1,015.79 秒。wrapper 从 19:00:23 至 19:17:37，执行前准入、npm test、执行后
完整冻结校验均为 0；日志实际确认恢复并验证 Electron ABI 146。JSON success 为
true，SHA-256 为
`0e6f4c7316eef7d5096ec56460a29de092caa28e988916ecb69799d0da3c604e`。
首轮、定向和第二轮均保留独立原件。原生/历史版本等条件模式的跳过不代替验收，
本轮要求的 .7 raw/final、严格矩阵及完整原生门禁已独立实际执行通过。

两轮逐项差分闭合：六个订阅行为与锁定 ACPX runtime 的 session identity /
permissions / turn controls 用例由跳过转为通过，后者在源码依赖就绪后实际执行
12.776 秒；两个 ACPX 套件新增收集 22 项并全部通过。因此通过数增加 29、
跳过减少 7、总项数增加 22。最终 841 项跳过分别为历史 patch 版本 764、当前
.7 的显式 fixture 条件 43、其他 runtime/OS/opt-in 34，均保留各自条件范围。
最终再次核对上游源码仍为干净的 .7 tag/commit
`157d8c2bc3ea2fa183afdc11088e69690bf8e64e`，应用分支以固定 dev fdf4 为祖先。

## 固定 dev 基线与恢复后的产物 E（不可验收）

C 验证期间 dev 新增聊天错误展示 `d0948ed37`、Team 来源工具继承与任务继续
`3140436e2`、禁用 setup 委派工具 `fd2ad574c`。本轮固定到 **2026-10-26 14:54 的
dev `fd2ad574c0f3a9c36a866d38693e813023a3419c`**，只重放升级及整合修正两个提交，
分别为 `3a5b35cf3`、`bdd689b96`。主目录未提交内容不带入。

第二次 rebase 仅有 Team 验证文档冲突，保留 .6 工具继承的历史验证段和升级对
历史证据的范围说明；生产代码自动合并。两名 agent 独立核对新增三项 dev 修复的
27 个非文档文件，均与固定 dev 原字节一致。第二个整合提交与 C checkpoint
`a056ecc45` 完全相同，.7 的 026 动态 getter、严格旧形态拒绝及两个迟到事件夹具
修正没有丢失。Team/SDK/权限与聊天错误链审查未发现需要新增 native patch 的缺口。

原工作树在构建期间两次发生文件缺失，移除来源尚未确认。首次缺失 Git 元数据、
顶层配置和构建用 Node，D 构建在复制 Node 时 `ENOENT` 退出 1；恢复并核对指纹后，
第二次完整 D 构建退出 0，bundle 用时 647,772 ms，10 个插件编译、18 个跳过、
0 错误，裁剪 16,528 个文件。但该目录随后连同源码、产物及 ignored 验证原件被
清理，D 尚未完成冻结后门禁，不能作为当前产物通过的证据。D 当时的源码批次
实际为聊天 12 文件/263 项、Team 5 文件/207 项通过；Main 配置/SQL 四文件为
311 项通过、5 项超时。五项仅超时，无业务断言差异，但原件现已丢失，E 仍需重验。
原 C 的完整门禁与独立输入审计曾实际完成，原 ignored 证据也已不可用；下文保留
当时结果作为历史记录，不代替 E 的实际验证。

已通过应用创建并登记新的 managed 工作树
`E:/workspace/worktrees/runtime-dev-sync/JustDo`，恢复分支为
`codex/openclaw-2026-10-7-dev-sync`，由已提交的 `bdd689b96` 承接升级。
旧分支仍被已清理路径的登记占用，因此没有强删该目录。依赖、锁定原包及离线
缓存重新独立准备。新源码实际核对 patch 指纹仍为
`b39e45d846759b03670f0d699b05f17cf1bbadc1fb620395466315061405defa`，recipe 仍为
`3dbf724223bb9ac7466aa6f878bbccd0249c8595a24ed066d3f3e2fe013e9412`。

该轮组合产物记为 E，证据根为 `build/upgrade-audit/v2026.10.7/dev-rebase-e/`；
发现上述 Chrome 缺陷后 E 不可验收，最终由 F 承接。
恢复脚本和后续证据另存于主仓库 ignored 的
`build/upgrade-audit/v2026.10.7/dev-rebase-recovery/`，不修改主目录源码或原生 ABI。
E 必须重新执行完整 pipeline、33 项冻结核验、严格补丁矩阵、完整 13 段 module gate、
Team 工具继承/讨论后续跑、lint/build/Main 编译与完整测试；不复用丢失的 C/D 身份。

| E 检查 | 当前状态 |
| --- | --- |
| rebase 与独立接口审查 | 固定 fd2ad574c；27 个新增修复文件完整保留，.7 审查无阻断 |
| 源码/原包 | 新工作树由已提交源码恢复；原包 SHA-256/SHA-512 与 source lock 一致 |
| fresh pipeline / 冻结 / 资源 | 完整入口及原冻结校验通过；资源静态审计通过；Chrome 子树缺陷使 E 不可验收 |
| Main 配置独占复验 | 127/127、零失败/跳过，112.58 秒；原预算不变，前后 E 身份一致 |
| 严格矩阵 / 完整 13 段门禁 | 图准备发现真实 bundled Chrome 差异而退出 1；严格矩阵和门禁未启动，转 F |
| Team 真实工具继承与任务继续 | E 未执行，转 F |
| lint / 前端 / Main / 全量测试 | lint、前端构建和 Main 编译通过，Electron ABI 146 兼容检查通过；E 未执行全量测试，转 F |

受控 DOM 几何测试不证明真实 Electron 各窗口宽度布局，合成模型固定工具选择
不代表企业模型自主续跑质量或完整 UI 已验收；安装包断公网冷启动等限制仍保留。

### E 构建与固定身份

`runtime-build-e.log` 的完整入口从锁定原包重新安装、验证 13 项基础契约和 33 项
保留缺口、应用源码补丁并生成新 ASAR/bundle；没有从丢失的 C/D 恢复或补签 core。
bundle 用时 863,312 ms，随后同步 13 个本地扩展，10 个编译、18 个按策略跳过、
0 错误，裁剪 16,528 个文件，完整命令退出 0。draw.io 从锁定离线缓存准备并验证
3,110 个文件，smart-canvas 验证并准备 6 个离线库。

`artifact-e-identity.json` 与 `artifact-e-verification.log` 已通过完整冻结校验，
构建输入与前述 b39/3db 指纹一致。core 字节与 C 相同是本次全新构建的实际结果；
Main/Team 新输入由新的 recipe 和后续扩展 assembly 约束，不以相同 bundle 字节
推断复用了旧产物。

| E 身份 | SHA-256 |
| --- | --- |
| runtime patch manifest | `e29ee97aa7ddc3ec79517093776b0ffdd28dfab0b0c2279c8c035579d1a2515c` |
| build-info | `f429d5f2827d32cabfcb65d43d2fea4ec3f2ce76d3b774725c7cc5c7e83764c6` |
| Gateway bundle（78,466,299 bytes） | `d7a071eaa1fbfc576eb55b07f8ff528084ad3076a42f3b59412c5ee4f0310533` |
| Gateway ASAR | `0337cba8d556e8f0e9f1066cf6ea81ab612d9d7e0747127be9bf8734d1fe3af7` |
| runtime package | `eec144d3f565dc61b4528aa115dd2bc47876c45cb0d3e97e006b3db738455f80` |
| npm-shrinkwrap | `9a82a770b477d174aa64f960d4b7043bd8fc00748479e0804886b4c8e2ae7d6d` |
| bundled Node manifest | `fa1162ab75d024ba4bb333f70424ebfa27c97ced78268375ca55de9e74f39703` |

冻结后生成的完整目录外归档为 `dev-rebase-recovery/runtime-artifact-e.tar`，
1,149,814,272 bytes，SHA-256
`0f18925562383289a56707a27753d8b2cb18bee0ea4203f0ebfd96f8cbcfab72`。
该归档、构建日志和身份文件均保留在主仓库 ignored build 内，避免再次清理工作树
丢失原件；不提交二进制、原生日志或用户 transcript。

## 2026-10-26 dev rebase 与重新验证

本轮将升级分支重新基于 dev `1d3d217a1f585f5bae36cc0e7e1118b940ed14cb`。
dev 重排了原分页/启动提交的历史，因此仅重放原升级提交 `3a48ed046`，不再次带入
旧父提交 `62342c478`；重放后的升级提交为 `50bad0a67`。原升级提交另由
`codex/backup-openclaw-2026-10-7-before-dev-sync-20261026` 保留。
新的独立工作目录为 `E:/workspace/worktrees/openclaw-2026-10-7-rebase/JustDo`。
旧目录现仅余依赖残留，旧 A/B 的 ignored 日志未带入新目录；下文 A/B 为此前
源码与产物的历史记录，不能作为本轮组合产物 C 的实际执行证据。

dev 的七项提交保留会话分页与加载、启动窗口/数据库准备、浏览器发现连接释放、
集中工具限制与配置同步、清空决策模型、会话读取/聚焦恢复，以及订阅包装下的
正文流式修复。唯一文本冲突为 Cowork 测试，保留 dev 生产行为和升级分支更强的
迟到模型三态负控、单次调用断言及 mock 隔离。Main/DB/原生 schema/probe 的自动
合并由独立 agent 核对，精确 .7 owner、固定 deny、transcripts 和数据库快路径同时保留。

dev 的流式修复只修改历史 .6 的 026；本轮已移植到 .7 现有 026，保持原生订阅
浅复制后对延迟交付 getter 的动态读取。补丁能力及数量不增加；不接受旧 marker
或混合形态，不把未知发送变成重试。方案和最终实现均经两个 agent 独立交叉审查。
Main/打包/插件输入和补丁均改变，必须从锁定原包完整生成 C，不能复用 B 的身份。

| C 检查 | 当前状态 |
| --- | --- |
| dev 基线与合并语义 | rebase 完成；合并语义、026 实现及真实订阅用例的独立审查无阻断 |
| 原包来源 | 重新取得 .7 原包，103,494,479 bytes，SHA-256/SHA-512 与 source lock 一致 |
| 受影响定向测试 | Renderer/插件/浏览器 39 文件、595 项；Main/DB/config 20 文件、1,012 项；均零失败、零跳过 |
| 原生流式订阅与当前补丁严格矩阵 | 严格 43 文件、1,073 项通过；互斥 raw 用例另行 1/1 通过；raw/final 订阅各 7/7，零资源跳过 |
| 完整 C 构建、冻结与 module gate | 构建与 33 项冻结核验通过；修正夹具后单次完整 13 段门禁退出 0，五个协作子步均退出 0 |
| lint / 构建 / Main 编译 / 全量测试 | lint、前端构建、Main 编译通过；C 未执行全量测试，后续由 E 执行 |

本轮证据单独写入 `build/upgrade-audit/v2026.10.7/dev-rebase/`，不覆盖或拼接 A/B 计数。

### C 构建与产物身份

`runtime-build-c.log` 记录从锁定 pristine 重新安装、13 项基础契约、33 项源码补丁、
全新 ASAR 和 bundle；bundle 用时 543,098 ms。首次完整命令在资源组装时因新目录
未准备 draw.io 离线资源而退出 1，未当作通过。随后按离线下载文档用已有锁定归档
准备 3,110 个校验文件，`drawio-prepare-c.log` 退出 0；再次运行完整入口，核验并复用
本轮新建的 C core，继续完成资源同步、编译和裁剪，`runtime-build-c-complete.log`
整体退出 0。没有复用 A/B core、手写 build-info 或补签旧 manifest。

最终同步 13 个本地扩展；10 个编译、18 个按策略跳过、0 错误；裁剪 16,528 个文件。
`artifact-c-identity.json` 和 `artifact-c-verification.log` 确认源码输入指纹与构建前一致、
随包 Node、完整 manifest 和 33 项补丁均有效。

| C 身份 | SHA-256 |
| --- | --- |
| runtime patch manifest | `eda11a20c3c4d43187fbf5e92818367e2de221a39f04e1d9d0b0bf7a9f56900d` |
| build recipe | `5ad1d32fc9172872daf88266c2d291891f848635b2439fddbb104e3d0dd1c86a` |
| patch set | `b39e45d846759b03670f0d699b05f17cf1bbadc1fb620395466315061405defa` |
| Gateway bundle（78,466,299 bytes） | `d7a071eaa1fbfc576eb55b07f8ff528084ad3076a42f3b59412c5ee4f0310533` |
| Gateway ASAR | `0337cba8d556e8f0e9f1066cf6ea81ab612d9d7e0747127be9bf8734d1fe3af7` |
| runtime package | `eec144d3f565dc61b4528aa115dd2bc47876c45cb0d3e97e006b3db738455f80` |
| npm-shrinkwrap | `9a82a770b477d174aa64f960d4b7043bd8fc00748479e0804886b4c8e2ae7d6d` |
| bundled Node manifest | `fa1162ab75d024ba4bb333f70424ebfa27c97ced78268375ca55de9e74f39703` |

`plugin-C-resource-audit.json` 只读审计退出 0：357 项资源输入未漂移，旧说明扫描零命中；
ASAR 的 12,524 个条目没有目标技能副本遮蔽。skill-creator 源/最终均 30,705 bytes、
SHA-256 `7efc509a7387cf66bebb3b5224797dcee8d974f5840fab86c2b5580c6ae163d5`；
acp-router 源/最终均 5,704 bytes、SHA-256
`64ed6ec0dce9e23d3b611bd333b21f57f3505e8204b22fcc4cd1866581f09968`。
后者是本 checkout 的 95 个 CRLF，Git 内容没有新增语义差异，不强套旧 B 的字节哈希。
OpenAI 的 85 项来源哈希、唯一入口、两个 worker 与无旧 wrapper 审计均通过。
这些静态检查不替代实际 SDK 注册、模型服务或桌面验收。

### C 严格补丁与原生订阅

`target-validation-result-c.json` 将全部阶段绑定上述 C 身份：raw 真实订阅 7/7、
raw 实际 SDK 语义 1/1 均退出 0。随后 `target-strict-matrix-c.log/json` 完整运行
43 个文件，1,073 项通过、0 失败，耗时 158.27 秒。唯一 skip 是 raw/final 两种
模式互斥的原包 publication 用例，已在 `026-raw-publication-supplement-c.log/json` 单独 1/1
通过；其余 name filter 排除项不作资源 skip。最终产物的真实订阅 7 项、SDK
语义及原生 Goal tool-timeout 组合 5 项全部实际执行，没有资源缺失导致的跳过。

原包与最终订阅均覆盖普通文本、structured 增量、owned/unlocked 缓冲保护、
无 callback 的清理，以及只在内存移除 getter 后重现旧故障的负控。全部阶段前后
176 个保护文件（含 80 个 raw owner、最终 owner、support 和身份文件）哈希一致。
before031 夹具从独立原包副本真实执行 001–030、逐项验证并最终复验 30 项，031
仍精确缺失；两个 agent 独立核对了 10,628 项初始快照、连续变更链和补丁指纹。
没有从最终产物剥离片段来冒充原包，也没有修改 C 来做补丁形态兼容。

### C 模块门禁中的测试夹具修正

首轮完整 13 段入口的原始日志和退出状态保留为
`module-contracts-c-attempt-1.log`、`module-gate-state-c-attempt-1.json`：前 12 段通过，
最后的 collaboration 首子步 209 项中 207 通过、2 失败，整体 exit 1，Electron
恢复 exit 0。该首轮不记为完整通过，也不与后续分段结果拼接。

根因为 dev 新增创建前的 storage read 后，原升级测试
`sessions.targetedEventRetry.test.ts` 仍按绝对第一次读取触发迟到 publication。
手动 prepare 已消费该读取，旧回调在 send 内没有触发，旧 slice 断言也随之错位。
两个 agent 核对生产调用并交叉审查后，仅修正测试：记录 prepare 后的 baseline，
要求 publication 恰触发一次，断言 send 的完整 RPC 序列，再以透明 call-through
prepare spy 的调用顺序证明两次重新观察确实先于后续显式准备；其余 17 项负控不变。
没有修改生产逻辑、当前补丁、recipe 或 C，也没有把显式准备误判成未知 create 重试。

`targeted-event-retry-focused.log/json` 的四文件 160 项全部通过、零失败、零跳过，
包括 targeted status 70、storage wait 36、native initial dispatch 35 和此处 19 项。
原未知 create 的单次提交负控保留。完整 collaboration 五子步和完整 13 段门禁随后复验。

`collaboration-focused-c-attempt-1.log` 随后记录源码子步 209/209 通过，但真实 Main
子步因同类旧夹具顺序而退出 1：探针在准备期首个 describe 等待尚未发生的 create
帧，目标 prepare 新增的 storage read 因而无法继续。原记录的 `cleanClose:true`
及 Electron 恢复成功不当作功能通过。仅调整探针的 preparing/admission 阶段：
准备时继续捕获原生真实帧而不释放，实际 create 返回且 key/SID 核对后，才在真实
point reader 响应中释放同一帧；原对象来源、哈希、令牌退役、两次同身份读取及
10 秒事件预算全部保留，并额外核对 gate owner 与 prepared SID。

修正后的 `main-send-admission-focused-c.log`、`.run.json` 整体退出 0，用时
165,253 ms，实际 probe 的 `verified:true`、`cleanClose:true`，Gateway 正常退出并
完成 join。6 项场景、5 次合成模型请求通过，126 份编译输入哈希与当前源码一致。
两个 agent 对方案与落盘 diff 独立交叉审查，并确认其余三个协作探针没有同类
首读假设。没有修改 C、生产逻辑或预算；可选旧 baseline-source 对照本轮未重跑。
完整 13 段入口另行重跑，仍要求同一次入口整体成功。

### C 完整门禁结果

修正夹具后的 `module-contracts-c.log` 在同一次入口完成全部 13 段，包含
`All module contract gates passed.`；collaboration 的五个子步 exitCode 均为 0。
`module-gate-state-c.json` 记录 2026-10-26 14:30:34 至 14:54:58（Asia/Shanghai），
Node 准备、实际内存数据库验证、完整门禁、门禁后产物身份核对和 Electron 恢复
全部退出 0。首次失败记录仍独立保留。C 未运行完整 npm test；验证期间 dev 新增
三项提交，本轮继续以更新后的固定基线重建下一份产物，不能将 C 的通过外推给它。

## 准备与来源

- 新 worktree 的源码和依赖独立于主工作区。复用下载缓存与依赖副本后单独执行测试；
  未修改主工作区、用户配置或用户 Gateway。
- 管理工具在忽略文件的指令扫描阶段停滞，checkout 本身已经完整；停止了该次创建
  专属的只读 Git 扫描，保留完整 Git worktree 并创建本次分支。应用附件注册失败不
  影响该 checkout 的 Git 身份；未为此重建或清理主工作区。
- 完整原包在 `pristine/package/` 保留为只读审计输入；补丁实验使用另一个目录。
  原包完整性及源码 tag/commit 核对通过。
- 为兼容现有脚本入口，本 worktree 的 `vendor/openclaw-runtime` 和
  `vendor/openclaw-plugins` 为指向本 worktree `build/runtimes/` 的目录 junction。
  所有准备产物实际位于仓库根的 `build/`，测试显式传入本次最终产物。

## 已执行检查

以下为原升级提交的历史验证。其最终产物 B 的构建、严格补丁矩阵、插件回归、统一 module gate 和完整套件
均已通过。标明 A 的广覆盖探针保留原始执行身份；两份产物的核心字节相同，
不将 A 的测试结果改记成 B 的实际执行。

| 范围 | 状态与证据 |
| --- | --- |
| 原始包 native 基础契约及保留缺口 | 13 项契约通过，33 项保留补丁在 pristine 上均拒绝；单独补丁实验继续验证 |
| 诊断与目标源码定向回归 | 7 文件、127 用例通过；包括 parser/export/UI、原生 management schema/normalization、descendant owner、wire 和 DB identity |
| 插件替换与预编译基础回归 | 3 文件、15 用例通过 |
| SDK 共享与 ACPX 契约 | B：插件领域 5 文件、27 用例，TypeSafe 12 文件、192 用例，ACPX 22 文件、148 用例通过 |
| 静态检查 | `npm run lint` 通过 |
| 应用构建、Electron 编译 | `npm run build` 与 `npm run compile:electron` 通过；Electron native ABI 检查通过 |
| 补丁完整源码事务与幂等 | 33 项应用/验证通过，87 个变更 JS 语法通过，二次事务零字节变化；81 条新 import edge/alias 独立审查通过 |
| 最终 bundle 与运行时冻结 | B：Windows x64 完整 pipeline exit 0；33 项冻结补丁核验通过；10 个扩展编译、18 个跳过、0 错误 |
| 当前补丁严格矩阵 | B：42 文件通过，1,055 项通过、1 项互斥模式跳过；该 raw-mode 用例另行 1/1 通过，无缺资源跳过；包含实际原生 Goal 组合 5/5 |
| 随包 ACP 与插件清单 | B：随包 Node synthetic ACP 协议 fixture 通过；隔离 CLI 清单只有一个已加载 OpenAI，实际 source 为本次外层完整替换目录，提供 openai/video-openai |
| 插件真实生命周期与 MCP | A：安装/更新/启停/卸载、能力同意、多入口包归属、扩展 MCP 四项各 1 个命名业务场景通过；使用独立配置及真实 native CLI/owner/stdio fixture |
| QuickJS 执行器 | A：开发 Node、随包 Node 两组通过；资产、执行、wait/resume、UTF-8、失败和取消均验证 |
| 技能发现与 Code Mode 状态 | A：开发 Node、随包 Node 的独立真实 Gateway 各 20 项通过；合成模型验证权限、持久化、重启、取消及展示历史隔离 |
| SQLite 退休与恢复 | A：两种 Node 的 6 组进程、18 个顶层场景全部通过：2 个原包阻塞负控、4 个非阻塞正控、12 个真实生命周期场景；未改单场景预算 |
| 上游敏感 module gate | B：单次完整 13 项整体 exit 0；末项协作发送的 5 个子步骤全部 exit 0，真实 Renderer/Team/Swarm 均 verified 且正常关闭 |
| 完整测试 | B：1,231 文件通过、22 文件跳过；16,989 项通过、822 项跳过、0 失败，完整调用 exit 0；实际恢复 Electron ABI 146 |
| 离线 draw.io 资产 | 使用已锁定的本地归档准备并验证 3,110 个文件；未将资产存在作为真实编辑/导出验收 |

## 首份冻结产物

当时真实目录为 `build/runtimes/openclaw/win-x64/`，`current` 指向该产物；
这个准备目录后来由 B 完整重建替换，A 的身份与运行日志单独保留。
完整 pipeline 的 Gateway bundle 阶段耗时 555,496 ms；继续完成 MXC 2026.10.7、
13 个本地扩展、离线资源、预编译和裁剪后退出 0。独立补丁核验通过 33 项。
历史身份保留在 `first-artifact-identity.json`；host Goal 提示与 Renderer 换行修复均不在
209 项运行时 recipe 输入中，修改后 recipe 指纹重新计算保持一致。

| 身份 | SHA-256 |
| --- | --- |
| runtime patch manifest | `e5bf197bb04d3a01c2bf3e40980ec1ee7a2ac1aeb6b3c85948d42ff92bafaf36` |
| build recipe | `35e29c1065fcdc3f3a1f0880c837104dbbc287af85b6eb71a22e388000b28092` |
| patch set | `e1898a13af47f463ae2a7fd6863180fd3ec4bc4469ce6f4fc9796207c0ecb26c` |
| Gateway bundle（78,466,209 bytes） | `41c8831fe1e5904c88ab04edaabc8c97fa0868bb65b27e4699989a16e2496e56` |
| Gateway ASAR | `f293202958131250d4f6e6bc28532ba15ef9f87c6408a3671be273709ec3b998` |
| bundled Node manifest | `fa1162ab75d024ba4bb333f70424ebfa27c97ced78268375ca55de9e74f39703` |

## 技能说明与最终重建

逐文审计覆盖本地技能 341 个文件（84 个 Markdown、9 个 SKILL）、运行时角色/渠道
8 个 Markdown，以及五个扩展技能目录。发现并修正 skill-creator 遗留的
proposal/review/apply 说明及 ACPX 对已裁剪路由、在线修复、直接修改用户配置和
不确定结果重放的指示；由插件与原生接口 agent 交叉核对实际 schema/注册入口。
普通 Workshop 写入即时版本化，个人库使用自身 revision/proposal_content 参数，
发布不等于在当前会话激活。现有授权不要求再次人工 apply；ACPX 保持用户配置、
受管命令/授权/生命周期和不确定结果先核对的边界。

`builtin-skills.json` 的来源策略同步为现行适配，改变运行时 recipe。旧 build-info
不能据此重新签名复用；产物 B 从锁定 pristine 包重新安装、应用现有 33 项补丁、
打 bundle、同步插件/技能并冻结。SKILL 叶文本不包含在 core manifest 覆盖范围内，
因此还需逐字节比对实际外层复制资源，并核查 ASAR 没有旧副本遮蔽。

## 最终冻结产物 B

`runtime-build-final.log` 的完整 pipeline 退出 0，Gateway bundle 阶段耗时
672,186 ms；13 个本地扩展同步、10 个编译、18 个跳过、0 错误，随后完成裁剪。
`patch-manifest-final-b.log` 再次独立验证 33 项补丁通过，身份写入
`final-artifact-identity.json`。

| 身份 | SHA-256 |
| --- | --- |
| runtime patch manifest | `cf119682a87f69a8a16b3cd0c41b6113c020edaad1941b4d764c40f972211260` |
| build recipe | `94db94168144adc09c83f9f1cf44a430db75e0426210728ef4c19897a696cbec` |

补丁集、Gateway bundle、ASAR、运行时 package、npm-shrinkwrap 和随包 Node manifest
全部与 A 逐字节相同，哈希见上表及两份身份 JSON。变化为技能来源策略的 recipe、
构建时间和外层技能说明；外层文本另行核对，不由相同 core hash 推断已复制。
严格补丁矩阵、统一 module gate 及完整套件均按 B 的最终身份独立完成。

`plugin-B-resource-audit.json` 已通过：skill-creator 的 30,705 bytes、SHA-256
`7efc509a7387cf66bebb3b5224797dcee8d974f5840fab86c2b5580c6ae163d5`，
acp-router 的 5,609 bytes、SHA-256
`2a9d74399131cf553c87508e775aa4c566f80a1f821c86a3a0da9777624cd792`，
均为 source/final 逐字节相同。357 个技能/资源支持文件的过时指令负扫描零命中；
ASAR 的 12,524 条记录没有目标技能副本，也没有旧说明文本。Main 环境变量、原生
resolver 与插件 manifest.skills 的静态链指向上述外层资源，未将此静态证据写成
新增 live discovery 实跑。OpenAI 的 85 项来源 hash、唯一入口及两个 worker、
无旧 wrapper/独立 video-openai 目录再次通过。

B 的严格矩阵独立实跑 42 文件、1,055 通过、0 失败，耗时 163.15 秒。
唯一互斥的 026 raw 模式另行 1/1 通过；45 项只是 name filter 未选中，不计资源跳过。
原生 Goal 组合 5/5 实际执行。`target-validation-result-b.json` 同时重算 80 个 raw
owner，最终 core 身份与冻结 B 一致。插件领域 A、TypeSafe 和 ACPX 共 39 文件、
367 项通过（27 + 192 + 148）；随包 Node synthetic ACP 和隔离 CLI 各退出 0，
记录为 `plugin-B-*.log`，均携带相同 B 身份。CLI 派生清单确认唯一外层 OpenAI
及 openai/video-openai provider；这些结果不替代统一 module gate。

B 的统一入口现已完成单次 13 项整体 exit 0，`module-contracts-final-b.log` 包含
`All module contract gates passed.`；协作 5 个子步骤全部 exit 0，最终 assembly
SHA-256 为 `d177e9d3d19cbcd4f2d652ab030121d7c8f86914e78fdaf3270dbd213dc72d95`。
`final-b-validation-state.json` 记录 Node ABI 准备、完整 gate 与 Electron ABI 恢复
均退出 0，随后同一自动流程直接开始完整套件，未等待人工继续。
完整套件最终也退出 0，Electron ABI 146 的实际验证与恢复成功。

## 完整套件与阶段复验

首轮 `npm test -- --testTimeout=30000 --hookTimeout=60000 --maxWorkers=2`：
1,250 文件，16,939 项通过、20 项失败、828 项跳过，耗时 969.24 秒；
`full-tests.log` 保留原结果，执行器已成功恢复 Electron ABI。四个失败文件分别为：

- 新版 producer 六例把已补丁的 native candidate 部分剥离后当成 pristine，形成
  mixed shape，被生产 verifier 正确拒绝。改用锁定原包的完整函数 fixture 和显式
  raw owner 精确对照，保留原六例，另加冻结产物独立幂等/零字节验证。
- Windows checkout 的 raw role baseline 带 CRLF，textarea 规范为 LF，导致 12 个
  preset 场景不一致。仅在 Renderer 模板消费边界规范换行，加入 LF/CRLF/CR 用例；
  资源文件字节、native role 权限和运行时 recipe 均不变。
- Cowork 一例仍期望阻塞等待后台模型读取，但基线提交 `62342c4` 已明确先选择会话，
  再后台读取模型。拆分真正阻塞的 session read 与后台 model read：前者 origin
  关闭后不得选择会话；后者已完成选择时，只要当前目标仍相同就允许有效模型更新，
  当前目标关闭/替换后拒绝迟到模型。未改生产 Cowork 行为。
- 插件裁剪 fixture 仍声明 10.6，本地完整替换已是 10.7。fixture 改为项目精确目标，
  保留未替换 OpenAI 的拒绝断言。

第一轮定向复验包含 Cowork、AgentManager、换行、Goal 自动续跑与裁剪，5 文件
108 项通过（`focused-regression-retest.log`）。随后按独立 review 增强 mock 隔离及
当前目标关闭/替换负控，Cowork 54/54 复验通过并再次独立审查。
最终完整套件结果单独记录，以上不拼成一次全量通过。

第二次完整执行相同超时/worker 参数，增加 default/JSON reporter：1,253 文件，
1,230 通过、1 失败、22 跳过；16,988 项通过、1 失败、822 跳过，耗时 1,286.73 秒。
日志/JSON 为 `full-tests-final.*`，执行器已恢复 Electron ABI 146。
唯一失败是 `windows-mcp-launch.test.ts` 的实际 Chrome MCP 关闭扫描：原生两秒
`Get-CimInstance Win32_Process` 期限在 2,181 ms 触发，保持不确定状态而不伪造清理成功。
相关 Chrome/MCP 源码、executor 与两秒预算在 .6→.7 的 Git blob 完全相同；测试及
host shim 也未改。随后在无并发、无预热、原预算/断言不变下原样复验完整文件，
5/5 通过，耗时 35.67 秒，见 `windows-mcp-isolated-retest.*`。
这支持环境调度波动的推断，但不将失败抹去，也不把定向结果拼成一次完整通过。

第三次完整套件针对最终 B 执行相同参数，2026-10-25 23:53:28 开始，耗时
986.22 秒，最终整体退出 0：1,231 文件通过、22 文件跳过（共 1,253）；
16,989 项通过、822 项跳过、0 失败（共 17,811）。日志与 JSON 为
`full-tests-final-b.*`，JSON `success: true`。文件细分按 console footer 统计，
JSON 会将全跳过文件的 status 也记为 passed，不能据此把 22 个文件算成实跑。
Windows MCP 原文件本轮 5/5 通过，耗时 35.963 秒，原两秒期限与断言未改。
测试执行器随后以真实 Electron 验证内存数据库并恢复 ABI 146；自动总流程于
2026-10-26 00:09:57 正常完成，`final-b-validation-state.json` 记录所有阶段 exit 0。
这是一次完整调用通过，不由先前失败轮次与阶段复验拼接。

准备过程中的两次启动失败单独保留：依赖复制尚未完成时缺少 Vite logger，
以及 raw pristine SDK 缺少尚未安装的 AI 依赖；均未执行相应测试，不计为通过。
新增导出负控首轮的预期曾误写为 undefined，既有合法行为为 unknown；修正断言后
127 项定向回归通过，未放松运行时白名单。

通用构建工具首轮测试发现两处旧版测试自身的目标值漏更新：facade 历史标记负控
没有实际改变字符串，manifest 错版错误的正则仍期望 10.6。已修复并为标记负控
增加“必须实际改变”的断言。数据库 owner 精确断言亦同步到原包；复验中一个
manifest fixture 在并行磁盘负载下超过默认五秒，单独复验 740 ms 通过。
完整套件将统一记录实际参数与结果，不能把这些阶段拼成一次全量通过。

当前补丁的初始诊断矩阵另暴露尚无依赖树时两个 native stream suite 无法收集、
computer activity 历史负控版本未变化及一个 AST 用例五秒超时；负控修复后
33 项通过、1 项缺 native 图跳过。最终严格矩阵必须使用本次冻结依赖图和独立
pristine 对照，初始矩阵不作为产物验收。

## 最终原生探针

本节为产物 A 的实际执行记录，所有命令当时均显式选定其冻结目录；B 的复验另记。
QuickJS 的两种 Node 检查分别记录于
`code-mode-dev-node.log`、`code-mode-bundled-node.log`。
技能状态使用隔离 Gateway、本地合成模型和独立配置：开发 Node、随包 Node 各通过 20 项，
包含技能发现/完整读取/权限负控、跨 cell/轮/会话状态、失败写回滚、取消、重启、
删除及展示历史隔离。两个探针均正常退出 0。证据为 `skill-state-*-node.log`
及 `.agent-tasks/runtime/skill-state/probe-*/result.json`，不等同企业模型实测。

SQLite 两种 Node 均为 24.22.1，直接使用 `node:sqlite`，不依赖产品数据库或
better-sqlite3 ABI。每种 Node 分别对原包依赖快照执行 contention 负控与内存变换
正控、对 final 执行非阻塞正控，再执行六类 lifecycle：backup-update、
update-rollback、deletion、error-close、exit、crash。两组 lifecycle 耗时
334.42 / 336.28 秒，原 120 秒单 case 期限未变；详细命令与回执在
`sqlite-validation-result.json`，原包与最终产物哈希均未改变。
探针内旧版本 marker 已修正；此修正不在 runtime recipe 中，不改变生产行为。

插件四个命名业务场景日志为 `plugin-native-management.log`、
`plugin-native-consent.log`、`plugin-native-ownership-direct.log`、
`plugin-native-extension-mcp-direct.log`。初轮误将 runtime 目录作为 `node --test`
的位置参数，产生额外 library import 测试项，该项不计业务通过数量；后两项改为
直接 `bundledNode <probe.mjs> <runtime>` 复验，各 1/1 通过。
四个真正命名场景均已通过精确 final manifest 和随包 Node 身份准入。
MCP 检查是实际 metadata/stdio fixture、资源/prompts、禁用/错归属/脱敏边界，
不据此宣称已覆盖真实 Gateway caller authority 撤销或企业 MCP 服务。

统一 module gate 首轮在数据库组累计 240 秒总预算处截断，未出现该组失败断言。
独立核对显示 31 次计划子进程中已推进至 27 次，创建跨度 230.151 秒，
最大相邻启动间隔 43.149 秒；不是把超时算作通过。仅将该组总封套增至 600 秒，
原单次 inspect/upgrade 期限、断言、场景及退出/信号失败判定不变，交叉审查通过。
第二轮前 12 项及协作 Main 实际发送均通过，第 13 项在 Renderer 探针编译阶段
暴露现有 `AGENTS.md?raw` 缺少测试 loader，整体仍为失败，不计作一次整体通过。
仅给测试构建补入精确 `file` namespace + `.md` + `?raw` 的真实 UTF-8 loader；
metafile 保留逻辑 query ID，哈希读取实际资源字节。普通 `.md` 仍拒绝，角色文本和
i18n 没有 mock，生产源码及 recipe 不变。独立审查和既有 `--prepare-only`
真实控制器构造/资源哈希快检通过。第三轮完整 13 项取得整体 exit 0，日志最终为
`All module contract gates passed.`，并成功恢复 Electron ABI 146。
原日志依次为 `module-contracts.log`、`module-contracts-final.log`，最终复验为
`module-contracts-final-retest.log`。Workboard 加载发行裁剪后缺失的开发 sourcemap
会打印警告，各轮实际用例均通过，不修改发行资源或屏蔽失败。

第三轮末项协作 gate 的五个子步骤全部退出 0：209 项上游/应用契约、真实 Main
准备与迟到事件、真实 Renderer wire/initial dispatch、Team、Swarm。
真实 Renderer 的 7 组、Team 的 5 组、Swarm 的 6 组均 verified 且 cleanClose；
包括原生整轮结算/历史、错误身份无发送、ACK 丢失后单发与不重放、重复请求无新增
执行、运行节点仅备注、原会话继续与新会话重试。精确目标源码 commit 为
`157d8c2bc3ea2fa183afdc11088e69690bf8e64e`，协作 assembly SHA-256 为
`138e9be73efb0b9faccd0c982035faa874e3215194ceca37a1e132b57e7bc089`。
全部使用生产 host/controller 与实际原生协议、合成模型和隔离状态，不替代桌面 UI
或企业模型质量验收。

## 独立审查

实施前由原生接口、补丁、插件三个 agent 分工审计，再交叉审查删除条件与接口。
已完成的独立实现审查确认：MXC 实际 .7 包的首次变换、幂等以及 x64/arm64 全部
固定二进制 hash 通过；AI 与 fs-safe 固定依赖路径存在；facade 两个真实 loader
形态保留；数据库 18 个 owner 的真实 hash/export/schema 对应；诊断新增枚举
完整接入且未知值防护保留。最终产物与完整差异的独立核对分别记录如下。

最终源码交叉审查还重新核对 026/028/029/032 的逐差异、029 实际 core 的 async/
allowed-tools 函数、80 个 pristine owner 的真实哈希及 9 个 SDK import alias，
未发现待解决生产问题。审查指出 031 总账的 safeTools/Goal observation 顺序描述
不准确，已按实际原生 atomic write 修正文案，无需改变接线。

Agent Team 中仍注明 10.6 的 sibling digest 注释是首次锁定验证基线。额外独立审查
确认两个 tag 的 SDK 导出、GroupThreadTurn.digest、完整 group-thread 摘要/空值
判定和派发源码逐字节相同，实际 .7 pristine 与 B 的对应 SDK/dispatch 实现也相同；
没有因该历史注释漏掉 .7 接口适配，不为纯注释重新生成产物。

转为历史的 10.6 原生测试加入与既有 10.4 同类的精确包身份准入：隐式当前产物
版本不匹配时只跳过依赖历史 artifact 的部分，hermetic 回归继续执行；显式错误
版本或缺失路径必须失败。共享 helper 的八个正反向用例通过；当前 10.7 严格矩阵
仍显式要求目标产物，不通过排除全局测试目录消除失败。

最终由三个 agent 再次独立交叉复核，未发现待解决的源码、补丁或插件阻断问题。
`final-audit-receipt.json` 记录测试结束后的只读收口：当前源码 tag/commit、33 项
补丁、manifest/recipe/bundle/ASAR、两份技能实际字节仍与冻结 B 一致，完整 13 项
gate、协作 5 个子步骤及完整套件均退出 0。完整套件跳过项与互斥 raw 补验分别
记录，未把跳过项、A 的执行或受控探针扩大为真实企业/桌面验收。

## 尚未建立的产品验收

跨平台安装包、真实企业模型与模型续跑超过一小时、真实 Chrome/桌面 UI/设备、
多 DPI/多屏、安装版中文和空格路径、无缓存断公网冷启动尚未验收。
这些项目不由源码检查、fixture 或开发构建替代；逐模块限制见接口专项报告。
四类启动、实际普通升级/降级和原生维护只有在对应本版探针或真实安装场景通过时
才记录为通过，不沿用 v2026.10.6 的历史结果。

后续实机结果直接补入本记录及对应功能文档，未验收范围仍保持上述状态。

## 2026-10-27 Windows 重新打包

本次从应用源码 `9c86860a121ea543d28ea5edab6fc3592dcc54c7` 的独立
Windows checkout 开始正常 `npm run dist:win`，没有复用旧运行包或手工重签
source proof。最终纳入构建期间已提交的
`f5011fb08c237af387939872d8880192b60053a5`（TypeSafe 手动配置控制修复），
补测其变更后重新打包；原生 recipe/34 项补丁证明保持一致。
交付期间原仓库后续更新至 `aa1e7c7e118de5efd09e95c06f071d8eaa2ae1d5`。
用户明确选择交付此前已验证的 `f5011fb08` 冻结安装包，后续模型设置改动
未纳入本次 EXE。打包适配源码单独回写原仓库，保留其后续提交及无关工作区改动。

原仓库 `vendor/openclaw-runtime/current` 未用隔离构建的冻结运行包覆盖，
其既有 recipe 已过期，不能将它作为此次验收源。后续正常 `npm run dist:win`
仍通过既有 `predist:win` 校验与 pristine 重建路径；目标 runtime 不应同时被
开发 Gateway 占用，亦可继续在隔离 checkout 构建。

构建调用仅为大型 Gateway 编译设置 Node 堆上限 16 GiB。
生产差异限于安装解压事务提交前的六个非空普通文件检查：OpenClaw
`package.json` 及随包 Node 可执行文件、manifest、npm/npx 入口和 license；
失败继续使用既有四类运行时的回滚。相应负控覆盖缺失、空文件、目录冒充、
升级回滚和首次安装清理，并补齐 Node 离线准备及安装契约文档。
打包适配本身没有新增原生补丁；Main/Renderer 的版本变化来自上述 `f5011fb08`。

这是新的冻结产物，不能与前述 A/B 的测试结果拼接：

| 身份 | 本次值 |
| --- | --- |
| OpenClaw / MXC | `2026.10.7` / `2026.10.7` |
| 目标 / Electron | `win-x64` / `42.7.0`（ABI 146） |
| 随包 Node / npm / npx | `24.22.1` / `11.19.1` / `11.19.1` |
| 34 项 patch set SHA-256 | `001e97d1420d95f37740ab9fc6dff318d7ec71111481c346020b29fd1ba72be1` |
| Build recipe SHA-256 | `c70a4669b3e57049ed06a2cfab5b225dea26f2401c8dcc34f68db7e1bec5cbf6` |
| Gateway bundle SHA-256 | `caf145c6004c48fcdd2345c405b5505fb7539d169d0970aa377873e7d8dd2f5c` |
| Node manifest SHA-256 | `fa1162ab75d024ba4bb333f70424ebfa27c97ced78268375ca55de9e74f39703` |
| Setup EXE SHA-256 | `47b85f9a69dcb4a89c81b5533b0179ef15baebb8e6e4b5c10093d3b47c18db65` |

最终文件 `release/JustDo Setup 2026.10.20.exe` 为 **303,302,216 字节**，
即 303.30 MB / 289.25 MiB；不将它表述成小于 300 MB。
资源归档保留 40,224 个文件，包括 1,532 个运行时知识文件、78 个本地
Worker 和 991 个许可证等法律元数据文件；应用法律元数据另有 65 个。
完整随包 Node 的 1,994 个文件通过清单校验。
压缩仍为 Zstd 19、64 MiB 窗口，本机使用四个构建线程，未增加用户解压窗口。
仅排除独立部署 `dist/worker-artifacts/`，不扩展到本地 worker 或
`gateway/worker-environments`。ACPX 不附带第三方 agent 安装包。

随包 Node 的独立原生探针在隔离 HOME、配置和临时目录下执行，执行前后
完整 source proof 相等：原生协议 schema 正反向 51/51、本地插件真实 loader
注册 13 个扩展的一项场景、QuickJS 资产/执行/暂停恢复/UTF-8/失败/取消均通过。
插件注册明确使用 `activate:false`、`runtimeSideEffects:false`；这些结果不扩大为
真实 RPC、扩展服务激活或企业模型验收。三类探针及 Node 身份由另一 agent
独立只读核对，安装代码及测试也已交叉审查。

本轮构建和验证回执保存在独立 checkout 的
`build/repackage-20261027/`；这是本地产物证据目录，不提交原始运行日志。

### 回归发现与补验

首次完整 `npm test` 调用取得 1,291 文件通过、30 文件跳过、10 文件失败；
用例为 18,004 通过、915 跳过、8 失败，耗时 1,645.87 秒，最后成功恢复
Electron ABI 146。保留原始 `full-tests.json` 与日志；这不是一次最终源码的
全量通过，后续定向补验不能将该次失败改写为成功。

其中四项证书失败揭示真实候选问题：复制构建依赖时遗漏既有 postinstall 的
`patch-http-mitm-proxy.cjs`，初始 ASAR Main 仍使用固定 CA subject，亦保留
旧 semaphore 删除。已补执行原有完整变换，证书九项回归全部通过，旧 EXE
明确标记 superseded，必须重新编译与打包。新增本地 QA 对实际 ASAR AST
验证唯一 subject-key identifier、复制后的 subject/issuer 属性和 semaphore
删除不存在；旧候选在该门禁的负控中确实被拒绝，没有仅修测试放行旧 EXE。

另外两项陈旧断言分别为 033 补丁期望清单和 abort 即 released；已按批准的
034 清单及浏览器 `revoked`/确切整轮结算合同修正，保留独立显式清单与精确
requestId/run。语音 SDK 和 ACPX SDK mock 补齐实际新导入，没有 mock 生产
注册器或 TOML 解析成功。ACPX 缺少的 `smol-toml@1.9.0` 是其已有声明依赖，
从本次锁定 runtime 物理复制到插件自己的忽略目录并核对 13 文件；未增加
根包依赖、下载第三方 agent 或修改锁文件。相关七文件 **148/148** 定向通过。

两项默认五秒超时用例在原截止期限、原断言下单独复验，分别为登录配置同步
1,991 ms、浏览器扩展打包 716 ms；该轮 **2/2** 通过，其余 143 项因选择器未运行，
不计为通过。源码未通过放宽这两项期限规避失败。

两份 reasoning suite 首次收集失败是未提供原包依赖 owner 路径。补验使用
经当前 source-lock 原包 SHA-256/SRI 及 80 个 owner 哈希准入的独占 raw 副本，
14,840 个物理文件、254,894,108 字节，跳过来源链接；不能将其称为完整安装图。
依赖解析显式补入本次冻结运行包。029 五文件、032/034、两类 reasoning、
随包 Chrome 正负控共 **11 文件、456/456** 通过，无跳过；原生矩阵封套为
`maxWorkers=1`、`testTimeout=30000`、`hookTimeout=60000`，与完整套件的
默认五秒用例分开记录。原包输入和冻结运行包没有因测试被改写。

最后 `npm run lint` 通过。安装器先前四文件 **85/85** 回归也通过，包含真实
资源解压子进程、升级回滚与首次安装清理；没有将普通 fixture 测试扩大为
NSIS 提权、注册表、快捷方式或卸载验收。

纳入 `f5011fb08` 后，配置写入、插件保护、决策模型、同步服务和扩展设置界面
五文件 **343/343** 通过；另选取 TypeSafe 控制释放、手动开关保留和配置回滚
八个生命周期场景 **8/8** 通过，其余 127 项因选择器未运行。两轮均经标准
测试包装器恢复并验证 Electron ABI 146，再执行最终正常打包。该提交不改变
原生 patch set、recipe 或 Gateway bundle，未将其余历史测试重新计为一次
最终源码的全量通过。

### 最终 EXE 归档验收

`qa-rebuilt/final-archive-receipt.json` 一次完整调用退出 0，并经独立 ACPX
审计及 `final-package-handoff.json` 汇总通过；没有复用旧候选的失败轮次或
continuation。主 agent 另核最终 EXE 和六份 evidence 的实际大小、SHA-256。
EXE 的嵌入应用 7z 与 NSIS 外层独立资源均真实解出，426 个 shell 文件逐项
等于本次 `win-unpacked`；完整解码器只用于本机 QA，不成为安装或首启依赖。
再由解出的实际产品 EXE 的 Node 模式运行同包生产解压器，在中文及空格路径
完成四类运行时事务。44,900 条目、40,224 文件均经准备源、最终 EXE 内 tar
与实际安装文件三方 SHA-256，完整随包 Node、Chrome 360 文件、ASAR 外置
16 文件和动态知识/Markdown/法律元数据/本地 Worker 清单均通过。

最终资源 `win-resources.tar.zst` 为 198,542,506 字节，SHA-256 为
`5dc60ec038a426b1dd55f5b6f25afae4b946bf2734c4250f5bfc37c883fc3022`。
实际 ASAR Main 为 4,267,285 字节，SHA-256 为
`8e7b103f6a1bfb53bb61c2e6786adec8654f6dcb3de561f237c37153d04546c9`；
其唯一 CA 生产链及 semaphore AST 门禁通过。产品解压子进程耗时 218.579 秒，
含当前机器文件落盘等开销，不能当作受控安装性能对比。

ACPX 审计覆盖其实际 3,830 文件；无第三方 agent 本体、平台 agent 包或预下载
缓存，保留所需协议适配器、SDK，以及 Codex 的三份小型 launcher/metadata/
README 文件。不得将此描述成整个 Codex npm 包均已删除。

本轮没有运行 NSIS 主体；提权、注册表、快捷方式、卸载注册及安装标记仍未验收。

### 安装启动验证范围收口

按用户要求停止进一步复杂安装测试，直接交付上述已通过构建、定向回归和归档
校验的冻结 EXE。完整的首次启动及同一 profile 再次启动验收未完成，不将此前
受控运行中的局部业务成功或最后一轮中止计作完整通过。相关隔离测试日志保留
在本地忽略目录；测试工具的子进程准入迭代未修改最终 EXE。

### 后续验证精简

按用户反馈，将本次新增的 17 个安装异常组合缩为 4 个代表场景，保留缺失、
空文件、目录冒充、升级回滚与首次安装清理覆盖。仅运行这 4 个定向用例通过，
耗时 2.88 秒；同文件其余 54 项因选择器未运行，不计为通过。
`AGENTS.md` 明确常规开发和重打包使用定向测试及既有构建检查，不默认追加
安装/冷启动演练或重复的全量产物盘点。离线下载清单移除 Node 条目，
按用户定义排除 Node.js/npm 等前提环境。
