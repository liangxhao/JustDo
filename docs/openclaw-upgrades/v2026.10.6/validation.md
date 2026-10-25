# OpenClaw v2026.10.6 验证记录

## 2026-10-24 补充：逐模块接口审计与遗漏适配

本阶段从应用 `89a074ece` 开始，在升级分支的受管 worktree
`E:/workspace/worktrees/openclaw-upgrade-audit/JustDo` 实施；主目录保持 `dev`，未修改其源码。
完整逐模块结论、13 个扩展、上游源码依据、适配决策和测试层次见
[专项报告](module-api-audit.md)。后续升级必须交付该独立报告，要求已加入升级 README 和 checklist。

新增生产修改仅是应用侧 Skill Workshop 新原生接口/界面/typed IPC 与 Worktree GC 异步任务消费。
没有新增运行时补丁或改变冻结产物输入。对原 release2 按当前 worktree 的严格 verifier 重新准入，
patchSet `3acfeba0ce1dce2aa13d48f35f4b34d934ce946bfae5429edccaeeae316b6b45`、
recipe `b8c466c682c07722f4c6b2d2e4a1819e665a84b1aceba86bc790a620146ab56d`、
bundle `9e8898bbb432d7ac6511e339a453c4e68d094255883cb9aedff8557feb2ce21b` 保持一致。
所有发布包行为 probe 使用该产物自带 Node24.22.1；目标源码精确检出 `.6` tag 且 tracked clean。

本轮定向结果：执行域538项、Workshop service31/UI8/IPC5、真实目标源码协议18、原生请求51、
实际13扩展注册、maintenance completed/failed 两模式、STT真实 loopback WebSocket、
Workshop真实文件/版本/SQLite worker七组、Workboard实际 handler/SQLite adapter 用例均已有通过证据。
这些是不同层次/部分重叠的执行，不能相加成全量总数；原生 GC 的调度/文件工作与 Workboard 的
sessions/subagent 等端口受控，未冒称真实模型、真实目录清理或桌面 UI 验收。

统一升级 gate 为 `scripts/test/run-openclaw-module-contracts.cjs`，显式传 `--runtime-dir` 与
`--source-root`，串行检查七组实际契约，任一步身份、源码、资源、退出或超时失败均整体失败。
全套首跑实际为1,167文件：1,145文件通过、19文件条件跳过、2文件 fixture 收集失败及1个线程池用例失败；
用例15,110通过、544条件跳过、1失败。两个 patch 测试已补统一 native runtime 候选，pristine 仍优先；
另一个 `process.chdir` 用例只改用项目默认 forks pool，不改断言。P+F条件下3文件257/257复验通过，
其中4项在原全套已通过，合并去重为1,148文件通过/19条件跳过、15,363用例通过/544条件跳过。
这是两阶段结果，不是单次全套全绿；原失败和条件跳过均保留。最终复验已确认 Electron ABI146 恢复。
日志分别为 `build/upgrade-audit/module-contract-audit/full-test-final.log` 与 `full-failures-rerun.log`。

环境与失败记录：新 checkout 的 ignored lock 缺失及 CRLF recipe 差异被严格拒绝，按规范化内容完全相同
的前提恢复51项原字节；没有改 verifier 或 manifest。共享 SQLite DLL 占用与依赖目录联接导致
初次全量无法有效执行，之后为新 worktree 准备完整独立依赖副本，插件独立依赖单独准备，
未终止用户应用、未改生产 Vite/CSP/权限。两个旧 patch 测试的默认 fixture 目录缺失必须显式复验。
另一次全部13扩展静态整图检查产生292条诊断，未通过；SDK不完整声明和依赖前提的限制见专项报告，
不以 native 注册或执行成功代替静态结论。七项 gate 曾两次因 Windows native snapshot rename EPERM
失败，含低负载 patch 场景；失败现场和日志保留，根因未定位，不得归因为并发/杀软或宣布风险消失。
A/B 新 profile 项目目录2次、系统临时目录3次均通过；最终将业务临时 state 与项目审计证据隔离，
保留全部原断言及非零失败传播，无业务重试/新 patch。最终完整七项 gate 在该布局下全部通过、自然 exit0、
零跳过，日志 `build/upgrade-audit/module-contract-audit/native-gate-separated-profile.log`。
此通过不消除已观察到的 Windows 文件系统风险；应用未知结果不自动重放的测试仍单独成立。

现已完成生产 build、ESLint 和 Main TypeScript 编译，三 agent 的实现/测试交叉复审无剩余应用侧阻塞。
真实企业服务、设备、Chrome/Electron UI、安装/覆盖升级和跨平台范围仍以本文
[未验收清单](#尚未完成的实机与发行验收)为准。

## 环境与证据边界

实施日期：2026-10-23—24（Asia/Shanghai）；应用基线 `04716a465`；Windows x64；
开发 Node 24.22.1；Electron 42.7.0。所有生成物、日志和隔离 profile 留在忽略目录，
不提交原始日志、凭据或用户任务正文。未启动或更改用户运行中的 Gateway。

升级实现和 Windows x64 运行时重建已完成；两批根回归经定向修复后没有剩余失败，
隔离原生场景及生产资源归档通过。真实 Electron UI/IPC、安装版、内网模型、长任务
和其他平台仍按[未验收清单](#尚未完成的实机与发行验收)保留待办，
不因自动化通过而标为完成。最终身份与去重结果见本文“第二轮冻结与最终验证”。

## 尚未完成的实机与发行验收

以下事项仍缺目标版本实机证据。执行时必须绑定最终产物身份，记录失败与复验边界；
完成后将事实更新到本文件及对应架构/功能文档，不以隔离探针或模拟服务替代。

- 在最终 Windows 安装包中验证无缓存、阻断公网冷启动；中文/空格路径安装、覆盖升级、
  卸载、独立 Node/npm/worker、资源法律文件及 Renderer 不可变资产保护。
- 使用真实内网模型验证 Thinking/正文/工具交错、长参数、撤回、切会话/重连、两次压缩、
  格式纠正两请求上限、Goal 精确结算、审批/问答以及超过一小时任务跨 token 轮换。
- 实际验证 Team/Workflow、插件安装/更新/停用/卸载、真实定时触发和结果收件箱、
  共享终端 attach、Worktree fork/引用保护及停止清理。
- 在真实 Chrome 验证 Native Messaging、relay 配对、Tab 授权、侧聊与企业页面人工介入；
  验证内网图像、视频、文件/实时 STT、TTS、embedding 的端点及凭据隔离。
- 用独立旧环境验证当前 SQLite 覆盖安装、已发布 JSONL 引导/备份/导入/身份与中断恢复；
  不使用用户生产环境做迁移演练。
- 补齐 Windows arm64 MXC、双架构 DACL/取消、其他 Node 平台、macOS 签名/notarization
  对可执行文件 hash 的影响；双屏/DPI、输入法、麦克风等设备另记。

## 已执行的分项验证

以下分项互有重叠，不相加作为完整测试套件总数：

| 范围 | 结果与证据边界 |
| --- | --- |
| 浏览器基线与 overlay | 13 文件、160 项通过；实际准备命令成功，锁定 29 项原始文件；未代替真实 Chrome 配对 |
| 005/012/018/025 | 4 文件、17 项通过；12 个隔离复制的真实原始模块上 verify 负控制、首次应用、语法检查、重复零写入及 hash 一致；不等于最终 bundle |
| 补丁 marker/原子性 | 2 文件、233 项通过；更新目标 fork intent/handler 和 recovery aggregate fixture，删除无目标 owner 的旧 minified worker fixture |
| Windows recovery 024 | 3 项通过；精确目标 private function + 真实 fs 验证外部 junction 与原生内部 relocation、历史/部分形态拒绝、mixed source/bundle 原子拒绝及 compiled 幂等 |
| 原生路径别名 | 未修改的目标 sqlite-worker-identity 模块在现存中文/空格文件及缺失 ancestor 上，将普通和命名空间路径解析为相同物理键；外部 junction 原生负控制复现 EPERM |
| 原生 CLI 宿主 | history/MCP/pairing/policy 及缺失 runtime 拒绝的分项通过；插件导入/记忆 2 文件、187 项通过、1 项条件跳过；独立 Node 路径替代旧进程 fallback |
| CLI 与错误呈现 | Windows 中文/空格路径实际 cmd 验证参数、exit 7、缺失准入路径即 127；POSIX 源码 guard 拒绝 PATH fallback；Main zh/en 错误提示及诊断脱敏通过 |
| Node 归档 | 官方 win-x64 ZIP 到完整 1994 文件清单，再经正常资源归档解包到中文/空格路径；完整文件核验与离线 registry 下 Node/npm/npx 版本、SQLite 嵌 NUL 文本通过 |
| Node/构建回归 | build agent 分项 24 文件、162 项通过、1 项 Windows symlink 权限条件跳过；计数只属于该次分项 |
| Node 签后与平台过滤 | 实际 electron-builder 的 macOS/Linux filter 均保留完整 1994 文件；签后字节变化即使无公证凭据也拒绝；清单按 key 精确比较，不依赖系统 locale 排序；未执行 macOS 实际签名 |
| SDK 静态闭包 | 13 个本地扩展入口在真实目标 SDK 的 named exports 闭包通过；85 项 OpenAI 上游来源 hash 与目标源码吻合 |
| Main 完整配置 | 真实 OpenClawConfigSync 生成并落盘的登录/内网模型/exec SecretRef 与登出最小配置，2 项原样通过目标原生 OpenClawSchema；默认单 main，不代替全部多代理/可选插件组合 |
| 全补丁源码矩阵 | 最终冻结生产输入的隔离 pristine 复制上，13 个原生契约、33 项缺口、33 项 apply/verify、79 个 JS 语法及第二次零写入通过；不等于最终产物证明 |
| 当前补丁测试 | 最终源码矩阵单次 40 文件、1030 通过、15 条件跳过；纯 pristine/source 与完整依赖图分开选择，真实 publication 16 场景属于源码诊断，最终产物另验 |
| 编译绑定 | 012 对实际编译的 `targetKey4` 用 AST symbol 验证；错 key、追加 spread、错 fork 对象均拒绝；最终 79 条相对/native 注入 import 加 1 条 Node builtin，0 missing、0 mismatch，39 个 owner/source hash 与 5 项返回契约独立复核通过 |
| 历史测试隔离 | 历史补丁矩阵 707 项通过、358 项旧 native 条件跳过；显式传新 runtime 环境变量仍不把新产物当作旧版验证；冻结的历史 helper 不进入当前构建 |
| MXC 0.9 x64 | 固定 SHA 的实际 executor probe 返回 base-container；现有 0.7.0-alpha envelope 无网络、临时目录权限执行 cmd exit 0；未证明双架构 DACL/取消 |
| MXC node-pty | 18 项裁剪测试通过，包括 nested/hoisted 与双架构、包/prebuild/选中架构的真实 Windows junction 越界拒绝且零删；实际 bundled Node 加载 1.2.0-beta.15 并在中文/空格 cwd 执行 cmd、destroy、宿主 exit 0 |

初轮依赖安装期间 rolldown 正被写入，浏览器测试启动失败；依赖安装完成后重新执行
上述 160 项并通过。原生 CLI 路径收紧后，旧测试 fixture 未提供准入 executable，
造成预期失败；已把 mock CLI 环境补为明确 executable，同时修正误加到产品 config
fixture 的字段，插件/记忆复验通过。未恢复生产 fallback 来使测试通过。

首次完整构建在新补丁及配置输入仍变化时只用于目标生产依赖下载和正常 native lifecycle；
它不是最终 freeze 证据。任何前期 fingerprint 失效均按 pristine 重建，不能补写旧证明。
首次完整 bundle 的 33 项严格验证通过后，MXC 组装拒绝了旧脚本硬编码的 SDK 嵌套
node-pty 路径。已确认实际依赖被 npm 正常提升到插件根，按真实依赖解析及物理路径
边界修复，并在后半流程排错后重新从 pristine 构建；该诊断组装不充作最终产物。
发行归档的静态资产核验也同步按原生依赖优先级处理 nested/hoisted，核对真实包名、
SDK 锁定版本及 node-pty 依赖约束；nested 已存在但损坏时拒绝，不借 hoisted 绕过。
105 项构建/manifest 与 7 项 metadata 测试及实际组装目录 658 项 MXC 文件通过。

## 独立多 agent 审查

实施前由补丁、供应链、SDK 三方交叉审设计，确认原包重建和独立 Node；实施后交换
所有权独立复核：

- SDK agent 审 Node，发现 POSIX copy 绝对化相对 symlink，已用 verbatimSymlinks
  及完整源/目标清单验证修复；另将开发路径绑定冻结 runtime 而非独立缓存。
- Build agent 审 OpenAI/STT/TTS/policy/provenance 和 ACPX generation/oneshot，
  未发现阻塞；保留真实协议与 worker 验证要求。
- Patch agent 审 005/012/018/024/025 及 native CLI 接线，确认原生 owner/identity/
  stop join/native filter 保护；fork 的真实数据库/worker链路仍需最终产物场景。
- 目标真实 completion 分项暴露 `input.prepared` 承载最终内容的新数据流，格式纠正的
  拒绝草稿处理已据此适配；后续验证必须使用修复后的重建产物。
- 实际 bundle 复核发现 022 的短导出名已变，旧 `n` 是进程内 binder，当前 `t`
  才是 Gateway mutation binder；已修正并加入真实 export 及错误绑定负控制。
  旧构建产物由新校验器正确拒绝，必须重新构建；003/004 的只读 worker 别名经
  三参数 consume 调用及原生前后 current 检查复核，属于有意别名，无需生产修改。

## 清单领域状态

| 清单领域 | 当前范围 |
| --- | --- |
| 来源、补丁、SDK、源码替换、裁剪 | 已适配并执行分项；最终产物见后续记录 |
| 流式、历史、压缩、Goal/权限/结算 | 自动化及目标 native 契约分项；真实模型/长任务未验收 |
| 工程、Worktree、终端、记忆 | 契约审计及宿主回归；实际工程/终端重连未验收 |
| cron/结果收件箱 | 保留原生 schema/身份；真实定时触发与安装版未验收 |
| 插件/技能/MCP/Team/Workflow | SDK 闭包与部分组件回归；最终注册/原生场景另记 |
| 浏览器/Chrome/人工介入 | 源码及 160 项组件回归；真实 Chrome/企业页面/安装版未验收 |
| 配置/认证/媒体 | 三方源码及策略适配；内网模型与跨 token 长任务未验收 |
| 导航/侧栏/分离窗口/设置 | 未改界面契约；真实桌面、多 DPI/设备未验收 |
| 存储与历史升级 | 不新增 SQLite 桥；JSONL 导入/旧环境覆盖安装未验收 |
| 其他平台与发布 | 六平台 Node 锁已准备；仅 Windows x64 执行本机验证，其他平台未验收 |

## 应用回归与首轮产物诊断

应用与插件批次使用 Node 24.22.1 执行：903 文件、11870 项，其中 11865 项通过、
5 项平台/环境条件跳过。初轮 4 项旧 CLI mock 未提供已准入路径，已仅修测试输入，
对应 2 文件、22 项复验全部通过；没有恢复生产 fallback。原始失败和复验记录分别为
`app-plugin-tests-final.log` 与 `app-plugin-fixtures-recheck.log`。
此批次排除 `tests/**` 和需最终原生环境的 `openclawExtensionImportService.test.ts`，
后者连同其余 `tests/**` 在最终产物批次执行。
wrapper 已恢复并验证产品 better-sqlite3 的 Electron ABI 146。

首轮冻结产物批次执行 259 文件、3935 项，初轮 3501 通过、7 失败、427 条件跳过；
失败仅涉及 5 文件：MXC 版本旧期望、原生投影新增 boolean `ok`、新版 Node/MCP
正常关闭不再产生旧 JSON 诊断、9.8 测试误用新 pristine、9.2 历史测试误认全局
current-runtime 必需开关。已按真实目标源码及行为修正测试，保持来源/失败/过滤、
MCP transport/preload、当前 10.6 产物必需验证不变，历史 native 按精确版本隔离。
5 文件定向复验 exit 0：93 通过、6 历史 native 条件跳过，所有 7 项失败均已解决；
日志为 `runtime-tests-final.log` 和 `runtime-tests-recheck.log`。wrapper 再次验证
恢复 Electron ABI 146。

两个不重叠批次及上述定向复验覆盖当时根 Vitest 配置的全部 1162 文件，按测试
成员去重为 15372 通过、433 条件跳过；计数包含历史版本/平台/显式实机开关跳过，
不代表这些 native 场景已执行。没有把重跑项目重复加总，也没有声称一次单命令全绿。

`npm run lint`、`npm run build` 和 `npm run compile:electron` 均通过；后两者包含
最终 Main CLI 准入及中英文错误呈现修改。上述 Main 编译/宿主测试不等同于真实桌面
Electron→Node 启动端到端验收。

首个完整冻结产物从锁定 pristine 包重建并通过结构准入；但后续真实执行发现问题，
因此该产物已作废，仅保留诊断证据。33 项真实 bundle 补丁校验、
13 个本地扩展的完整依赖替换、10 项预编译（0 errors）及运行时裁剪全部完成。
冻结后复制到 `build/runtimes/openclaw/win-x64`，再次核验全部 manifest、companion
及 Node 1994 项文件，未补写或沿用前期失效证明。作废产物身份为：

| 项目 | SHA-256 / 值 |
| --- | --- |
| OpenClaw / target | `v2026.10.6` / `win-x64` |
| Node | `24.22.1`，1994 项文件 |
| patch set | `f0f18665ac7c6fa5fa4074e69fdd71d21847378947f93ae875d154b3e5c88c16` |
| build recipe | `9597f092d61cef90a93057ab3aa8d0dfa29b21039439d7cf591f7af25681bdfd` |
| patch manifest | `dd20f64c8039d2618531d2a140790703e2fd683ec415613319125981ea73ac41` |
| Gateway bundle | `faeb59fcde589ca4d7f4226e61be947832ec63b41f181827933f08c59634a7ec` |
| Gateway ASAR | `30ca1e9951999a2f07b0134ba1f9f5ac6c7719117fae5a58268b72dcac375b10` |
| Node manifest | `fa1162ab75d024ba4bb333f70424ebfa27c97ced78268375ca55de9e74f39703` |

在该首轮产物上，独立 agent 执行了真实生产 `packMultipleSources` 与
`PACKAGED_RUNTIME_EXCLUDES` → zstd → `verifyPackagedOpenClawRuntime`，
38970 项文件入包、388 项按生产规则排除，完整解包校验通过；归档为 283801787 bytes，
SHA-256 为 `7506e2d5b77b642dce2e9e1da207717f0da78ad48e46f68be8dc0d8d297b2d76`。
核对包含 33 项补丁证明、Node 完整树、CLI/companion、ACPX/MXC 包 metadata、
hoisted node-pty/conpty 同根和 worker 闭包。首轮审计脚本漏传生产 exclusions，被
worker-artifacts guard 正确拒绝；补齐真实生产参数后在新目录复验，未修改生产代码
或该轮产物。这是运行时资源归档证明，不是 NSIS 安装包或真实 macOS 签名验收。

该产物自身 Node 的 CLI 显示 `OpenClaw 2026.10.6 (fe06181)`，npm/npx 为
11.19.1；中文空格独立 profile、空 npm cache、offline registry 下的 Koffi、esbuild、
protobuf、含 NUL 的 SQLite 和 MXC hoisted node-pty 实际进程退出/显式 destroy
全部通过，`electronVersion=null`。此记录不把 Node 原生验证写成 Electron 验证。

随后真实 plugin-owned execution 场景发现 019 的生产异步契约遗漏：目标原生
`loadSubagentSessionEntry` 返回 Promise，而支持层同步读取结果，严格身份检查因此
拒绝执行。此项未被名称/import 绑定审查或同步 mock 暴露；该冻结产物的结构证明和
前述测试仍保留为诊断，但不能据此交付。已完成最小适配及真实异步负控制，
修复后必须从 pristine 完整重建并重新绑定最终验证，禁止回填旧证明。

019 注册入口还必须原样保留 `params.assertCurrent()` 返回的 admitted native entry，
不能把它替换成应用执行 metadata。新方案使用原生异步准备的同步 live guard，在
初次读取、每次实时检查和 native source assertion 中精确比较 SID、lifecycleRevision
及 pluginOwnerId；其必要性和独立审查记录在补丁总账。原生完整函数的 10 项竞争/
语义测试、58 MB 原生模块图编译后的整函数校验、真实 SQLite/worker 的 4 项 owner
变更/初读/生命周期负控制均已通过；这些是重建前诊断，尚不替代最终原生执行验收。

peer abort 诊断另发现：原生取消通知已占用 terminal publication，随后执行器真实产生
的 `executionSettled: true` 被 publication admission 拒绝，authenticated Gateway 客户端
无法看到执行结算。未修改原生模块的独立负控制已复现；最小修复已完成独立交叉审查，
不能把普通 cancelled/end 通知视作结算来放宽测试。

修复后的最终构建和隔离 Gateway native 结果见下一节；实机与安装版待办见
[未验收清单](#尚未完成的实机与发行验收)。

## 第二轮冻结与最终验证

2026-10-24 02:16（Asia/Shanghai）统一冻结生产输入，SDK、补丁和供应链三方独立
复审均无阻塞。新构建从锁定原包完整重装，经标准入口
`vendor/openclaw-runtime/current` 严格复制到独立只读验收副本
`build/runtimes/openclaw/win-x64-release2`。开发和打包仍使用 `vendor/openclaw-runtime/current`；
`build/runtimes/openclaw/win-x64` 中的首轮作废副本仅保留诊断，不参与正常选版，
其字节和证明不修改。
此轮 patch set 为 `3acfeba0ce1dce2aa13d48f35f4b34d934ce946bfae5429edccaeeae316b6b45`，
build recipe 为 `b8c466c682c07722f4c6b2d2e4a1819e665a84b1aceba86bc790a620146ab56d`。

冻结后 `npm run lint`、`npm run build`、`npm run compile:electron` 再次全部 exit 0。
当前根测试配置覆盖 1164 文件：应用/插件批次 903 文件，最终运行时批次 261 文件，
交集为零；后者包含 deferred import service 以及新增的两组 native guard/publication
测试。最终运行时批次强制传入新产物、自带 Node、pristine source 和重新生成的
001–030 Goal predecessor，不能静默改用旧产物或仅执行 fixture。

完整重建及严格复制于 02:44 完成，复制前后验证 source、manifest 和 Node 全树通过。
新产物身份如下；首轮作废身份仅保留在前节，不用于本节验收。

| 项目 | SHA-256 / 值 |
| --- | --- |
| OpenClaw / target | `v2026.10.6` / `win-x64` |
| Node | `24.22.1`，1994 项文件 |
| patch set | `3acfeba0ce1dce2aa13d48f35f4b34d934ce946bfae5429edccaeeae316b6b45` |
| build recipe | `b8c466c682c07722f4c6b2d2e4a1819e665a84b1aceba86bc790a620146ab56d` |
| patch manifest | `fdfd728eafc3f86b3d5f17a509c0f19594d01d513c6e0a294df20a4ce9eced12` |
| Gateway bundle | `9e8898bbb432d7ac6511e339a453c4e68d094255883cb9aedff8557feb2ce21b` |
| Gateway ASAR | `2cbd3e726511717ff2268fd2b960789871d170e1fd4846ae86f55fea4fa1a188` |
| Node manifest | `fa1162ab75d024ba4bb333f70424ebfa27c97ced78268375ca55de9e74f39703` |

最终产物自身 Node 的真实 SQLite/worker guard 场景 4/4 通过并自然退出：精确 full
projection、同 SID/revision 的 owner-only 变更失效、初读 stale owner 拒绝、生命周期
替换失效。原生数据库均完成 clean-close；证明绑定上述身份，不使用重建前 overlay。

新产物实际执行生产资源归档及解包核验：38970 文件入包、388 按生产规则排除，
283761581 bytes，归档 SHA-256
`87a5abefb95ac9a55df41e965aee294a8a09c672873cc8a0af166be87e856413`。
原生 worker 闭包、33 项证明、CLI/companion、MXC/ACPX metadata 和完整 Node 均通过；
归档前后冻结身份不变。新产物自身 Node 的 CLI、npm/npx 11.19.1、Koffi、esbuild、
protobuf、SQLite NUL 和真实 hoisted node-pty 创建/销毁/进程退出均通过；环境为中文/
空格路径、独立 profile、空 npm cache、offline registry，`electronVersion=null`。
日志为 `release2-archive-packaged-roundtrip.log`、`release2-dependencies.log` 和
`release2-frozen-state.log`；这些是运行时资源证明，不是 NSIS 安装版或 Electron UI 验收。

| 最终原生场景 | 新产物结果 |
| --- | --- |
| 流式 transport | 8 路通过；5 种 reasoning 字段、普通文本、自定义端点/API alias、strict policy；正文在 terminal 前增量到达，strict 仍保持 buffer |
| plugin-owned execution | 4 个真实 Gateway 阶段通过并全部关闭：durable tool-free/跨 plugin 拒绝、进程灭绝先于 cleanup settled、精确 cancel、异常重启后的 durable 与 unknown 边界 |
| Goal | 真实工具创建、live turn 延后、whole-run predecessor、原子次数、同 idempotency 回执重放零新增请求、successor 与 limit 全部通过 |
| 工具格式 XML 恢复 | main `chat.send` 与真实 subagent 各一次纠正成功，保留既有工具结果；畸形整批零派发，文件各仅写入 AB 一次 |
| 工具格式持续错误 | main/sub 各通过；保留已成功结果 A，只允许两次纠正 `[1,2]`，畸形整批零额外派发，保留最新安全错误与 exact whole-run error；sub 同时确认 execution/cleanup settled |
| peer abort | 整体 exit 0；真实 HTTP compaction 被取消，仅一条 error/aborted/`executionSettled:true` whole terminal、无 completion，native drain 后正常关闭，全 join 且无 forced |
| peer normal/overflow/provider-failure | 三模式整体 exit 0；normal 真实 completion，overflow 真实响应一次后恢复 completion，provider-failure 真实失败一次、历史含错误且无 completion；各仅一条 whole terminal、原 SID 保持、正常关闭及全 join |
| 本地扩展注册 | 13 个扩展逐一实际 loaded、0 error，`activate:false/runtimeSideEffects:false`，inspection.release 完成；不代替各插件服务运行验收 |
| 原生插件管理 | consent/MCP/management/package ownership 四组各 1/1 通过；旧 reviewToken 遇扩大能力面拒绝，MCP 定向连接/工具/资源/prompts/disable，安装/更新保持 disabled、切换/卸载与多入口归属断言均保留 |
| 原生会话分支 | 8/8 通过；真实 SQLite worker、incognito actor、assistant includeEntry 与 Gateway fork 链路 |
| Widget runtime | native kind/resource 注册与内容边界通过，不代替真实桌面 viewer UI |
| Widget Gateway | authenticated HTML、native tool schema、canonical widget/history、重启不重复、停用后保留文档但拒绝资源全部通过；4 次本地 fixture 模型请求，整体 exit 0，未运行真实 Electron viewer UI |
| Windows publication | 真实 no-DELETE 文件句柄占用场景 1/1 通过，沿原生事务在预算内恢复 |
| manual compaction | 准入前阻止、in-progress、abort ACK 仍非结算、HTTP 实际关闭后的 aborted 双终态、随后成功 history/turn-prefix、跨 session unknown、成功回执重放零新派发全部通过；精确 3 次 summary 顺序保持 history/history/turn-prefix，正常全 join |

peer abort 首次新产物运行已通过 whole terminal 断言，但测试 finally 的 12 秒强杀门
早于原生 20 秒 drain 预算，整体退出 1。已仅将探针关闭等待改为 45 秒，保留自然退出、
全部 join、无 forced 和唯一 whole terminal 的严格要求；复验整体 exit 0，日志为
`release2-native-peer-abort-accepted.log`。此调整不改变生产输入或构建身份。

最终运行时批次 261 文件、3976 项：首轮 3546 通过、428 条件跳过、2 失败。
一项是实际原生历史图冷导入超过旧 5 秒期限，已按相邻原生投影测试改为 30 秒，
同时显式选择 frozen final 并在 mandatory 模式缺失 owner 时失败；全部历史行为断言
保持不变，定向复验通过。另一项是库存测试的行数维护上限过旧：019 的 1294 行超过
1200，修正后循环又暴露 031 的 763 行超过默认 600。独立审查确认新增原生异步/
publication 原子组和 8 个 Goal owner 接线属于已审范围，仅将这两个上限分别更新
为 1300/775，其他上限、固定 33 文件、五项说明标签与全部语义断言保持不变。
库存 20 项定向复验全部通过。原失败、两文件复验及库存复验日志分别为
`runtime-tests-release2.log`、`runtime-tests-release2-recheck.log`、
`runtime-tests-release2-inventory-recheck.log`；未修改生产输入来消除失败。

按原测试成员去重后，最终运行时批次为 **3548 通过、428 条件跳过**；加上前述不重叠
应用/插件批次，当前根配置的全部 **1164 文件**覆盖完成，共 **15413 通过、433 条件
跳过**。这是分批及定向修复后的去重结果，不是一次单命令全绿；历史版本、平台和
显式实机开关的跳过不算执行通过。新增 publication 测试实际执行了新 final graph 的
16 个原生 routing/owner/epoch/producer 场景，并打印本节新身份。
测试 wrapper 最后再次恢复并确认 Electron ABI 146；最后的纯库存复验不加载原生
数据库模块，不改变该 ABI。

三方最终独立审查没有未解决阻塞。历史冷导入期限、019/031 库存维护上限及 peer
关闭预算都仅调整测试，原生行为、终态/身份断言和生产 fingerprint 不变。原开发
工作区和相邻 v2026.10.6 源码 checkout 最后检查仍干净；没有合并或发布本次分支。

全部最终 native 场景结束后，SDK 与补丁 agent 分别再次严格核验 frozen runtime、
当前源码 fingerprint、manifest 和完整 Node 分发，全部 exit 0，身份保持本节数值。
两侧已无自有 Gateway。忽略目录中的逐场景汇总为
`.agent-tasks/upgrade/sdk-adapters-release2-validation.json` 和
`.agent-tasks/upgrade/runtime-patches-release2-validation.json`；未把原生日志加入 Git。

## 2026-10-24：启动配置、四类启动与正常升级补查

本节在 `6ced6d9b8`（逐模块适配已提交）之后实施，工作区为升级分支
`codex/openclaw-2026-10-6`，开发主目录仍为 `dev`。只读取用户指定升级 worktree
的 `run_log.log` 作诊断，不修改或启动真实用户 profile/Gateway，不提交原始日志。
前节 release2 是历史不可变证据；它的旧配方不作为本节新代码的最终交付证明。

### 实现与验证范围

- 实际日志中的 `.10.6` CLI 配置退出为 code78，原因包括退役 Workshop 配置与 TTS
  旧字段。真实 Main 同步器覆盖完整/最小、登录/退出、有模型/无模型的落盘配置，
  同时执行原生 schema 和 load-time legacy 检测；schema 单独通过不足以证明可启动。
- 四路为迁移升级、正常升级、首次安装和正常启动。正常升级保留当前数据，处理
  交付身份变化、缺回执、同身份但原生 schema 待维护，以及中断后的重新检查。
  正常启动也有后置原生验证，不能吞错后开放 Gateway。
- 版本方向与目标原生合同集中声明。任一应用/runtime 版本降低先等待人工确认，
  “仍然启动”只恢复同一流程；未知版本、异目标未完成事务、实际数据不兼容或加载
  失败照常报错。确认 IPC 绑定可信主 frame、单次 requestId 和完整内部交付身份，
  不永久记忆授权，不由 Renderer 直接标记 Ready。
- 当前原生范围为 shared20、agent24/25。更新使用真实原生排他锁和 agent lease，
  lease 先于完整备份且覆盖更新和复验；未加入原生 SQL、旧数据代码链或新 runtime patch。
  跨库不是整体事务，未知结果先重新检查；原始备份不由重试覆盖。
- Windows 生产 tar 与 mac/Linux 都省略重复 `gateway.asar`。Main 按实际交付形态
  验证 manifest、16 项实际 owner 字节/导出、bundle、package/lock 及独立 Node；
  archive 存在时仍作完整 hash 和逐 owner 双比。早期“Windows 必须存在 ASAR”
  的判断已纠正，并补实际 packed-shape 正控及 owner 损坏负控。

### 应用侧回归与独立审查

| 检查 | 结果与证据 |
| --- | --- |
| 启动、配置、产品数据、共享合同、Renderer、preview、manifest 选定批次 | `startup-final-regression.log`：73 文件、1221 用例全部通过；wrapper 最终恢复并验证 Electron ABI146 |
| 最后 Main/确认/活动时钟补查 | SDK agent 的 5 文件86用例通过；包含真实 SQLite/JSONL 保留负控的 owning 文件已纳入父批次，最后时钟窄修另有受控时间回归 |
| 降级实际 UI 组件 | `startup-downgrade-ui.log`：3 文件20用例通过，覆盖两种外壳、等待、单次点击、确认不等于 Ready、stale/IPC 拒绝和后续 schema 错误；中英文实际组件另由 preview 测试覆盖 |
| 原生进程/环境/冻结身份 | 原生 agent 54 项 focused 通过，涵盖消息码白名单、deadline/取消/强退、child/helper 双方退出观察、无法 join 后本实例永久阻断，以及实际 packed-shape 合同 |
| 开发版紧急退出 | 最后 3 文件16用例通过；执行真实 Main 超时回调与实际 shutdown controller，验证无 Gateway 时也等待维护子进程、45s 原生观察与47s紧急上界、拒绝原因记录，不因30s回调先触发而遗弃维护子进程 |
| 静态检查与构建 | `startup-final-build.log` 和 `startup-final-main-compile.log` exit0；首轮 lint 有三处 import 排序，修正后 `startup-final-lint-recheck.log` exit0，无语义放宽 |
| 实现后独立审查 | Main、原生维护和构建 agent 交叉审查后无阻塞；发现并修正了 lease 前备份竞态、无法 join 的无界等待、Normal 后置错误吞掉、Windows archive 形态误判和确认等待计时 |

以上是本次选定回归与增量复验，不宣称在最后源码上重新跑完前节全部仓库用例；
重叠批次不可相加。日志中的 `interface chunk unavailable` 是界面错误恢复用例的
受控错误输出，测试断言与总退出状态均通过。

最终重建前，实际 Main adapter 配不可变原生 owners 的八组隔离诊断已自然 exit0、
`cleanClose:true`：fresh20/25 创建/关闭/重开、24→25 全备份并保留 SID/正文与配置、
真实旧/高/损坏格式拒绝、活跃 writer lease 零备份、SQLite_BUSY 零 schema 改动、
原生事务回滚、IPC 取消与重检恢复、无重复 ASAR 的实际身份准入及 owner 损坏拒绝。
最后诊断为 `probe-MotzAC/result.json`，实际 busy 错误码为 `SQLITE_BUSY`；
原生活跃 lease 没有结构化 errno，保留 generic，未按英文文本推断。
这些旧产物诊断只证明 Main/原生接缝，不替代下文新产物的严格配方验收。

### 界面与交付边界

`npm run startup:preview -- --route upgrade --language zh --theme light` 使用真实启动组件，
可切四路、语言、主题、实际操作展示和降级待确认演练。浏览器人工查看了首次/迁移/
正常升级/正常启动、中英文与浅深色，以及“仍然启动”回到 Preparing；全部动作只在
内存，不操作用户数据。真实开发 Electron 采用同一 Main 路由，不因开发模式跳过维护。
浏览器演练和模块/IPC 测试不等价于真实 Electron 窗口、NSIS 覆盖安装或用户实库验收。

手动 NSIS 覆盖安装当前没有可靠的新旧版本比较；自动更新的 `allowDowngrade:false`
只约束自动更新。上述策略属于含新代码版本的逐 profile 启动，不追溯保证不含此策略
的历史二进制，也不把安装器替换文件成功当作数据兼容证明。首次断公网冷启动、
NSIS 安装/卸载、掉电/介质故障和企业服务实机仍以各自验收记录为准。

### 本轮新构建身份

从锁定 pristine 包完成原安装、33 项补丁与 bundle 后验、插件、资源、预编译和裁剪，
并复制至本 worktree 的 `build/runtimes/openclaw/win-x64-startup-regression`。
原 pipeline 在资源阶段因缺 draw.io 离线资源退出；核对并复用匹配锁定 SHA 的缓存，
标准 `drawio:prepare` 成功后继续剩余资源/预编译/裁剪，未重新补丁、改 manifest 或伪造资产。
第一次证据复制误将 `current` junction 当作实体，已在 ignored 证据脚本解析真实源目录
后完整复制；source、独立副本及完整 Node 文件树均严格通过。

| 项目 | SHA-256 / 值 |
| --- | --- |
| OpenClaw / target / Node | `v2026.10.6` / `win-x64` / `24.22.1` |
| patch set | `3acfeba0ce1dce2aa13d48f35f4b34d934ce946bfae5429edccaeeae316b6b45` |
| build recipe | `371f2275d5b018b1f8d810da9048b6097e6d063fc0dd30f02a638413280703e1` |
| patch manifest | `d4828cc5a58fdb7ae7280e4ce0c26fcb78bce171e5d4c62a4251539ad39c861a` |
| Gateway bundle | `9e8898bbb432d7ac6511e339a453c4e68d094255883cb9aedff8557feb2ce21b` |
| Gateway ASAR | `2cbd3e726511717ff2268fd2b960789871d170e1fd4846ae86f55fea4fa1a188` |
| Node manifest | `fa1162ab75d024ba4bb333f70424ebfa27c97ced78268375ca55de9e74f39703` |
| Node executable | `d702daa815eabbff763c7d3808e235cf031cf2ca70211b56847bc72f51e240e5` |
| native owner 语义合同（16 owner） | `f9b17e993859b9e191a64bd8e5b3705b125c41eb0b8f52e5c051a99c8fe6270a` |

本轮 Gateway 源码补丁未改变，fresh 生成的 bundle/ASAR 与历史 release2 相同；
配方、manifest 与新增 producer proof 已更新，不能据此沿用旧 manifest。
完整身份见 `startup-frozen-runtime-identity.json`；构建和冻结证据分别为
`startup-runtime-build.log`、`startup-drawio-prepare.log`、`startup-runtime-freeze.log`。

补丁与 SDK agent 分别对这份新副本独立只读复核，严格 frozen/current recipe 均通过。
189 项配方输入与当前源文件逐一匹配，16 个实际原生 owner/导出与 ASAR 字节一致，
独立 Node 24.22.1 的完整 1994 文件树和自身执行均通过；实际 Main 身份准入返回
本节 manifest、shared20 和 agent25。原生维护五个生产输入及共享版本策略均纳入
配方，哈希与冻结值相同。独审没有未解决阻塞；证据包括
`native-database-upgrade-final-identity.json`。这两轮身份检查未重复计入数据库场景。

### 新产物严格九项 gate

使用本节固定新目录、显式目标源码和当前配方运行模块合同入口，整体 exit0，
输出 `All module contract gates passed.`；未使用 archived diagnostic 模式。

| 项目 | 本轮实际结果 |
| --- | --- |
| Gateway 协议与状态投影 | 51/51 通过 |
| Main 落盘配置与原生加载校验 | 2/2 通过，覆盖 8 种真实配置投影与 10 个旧字段负控 |
| 本地扩展 SDK 注册与释放 | 13 个扩展检查通过 |
| Worktree GC 原生维护 | 2 种模式通过 |
| 原生实时 STT | loopback 双端点和实际会话顺序、关闭检查通过 |
| Workshop 原生 FS/SQLite | 7 项检查、6 个实际动作通过；本轮未出现历史 EPERM |
| 扩展管理来源合同 | 18/18 通过 |
| Workboard 实际 handler | 1/1 通过 |
| Main 与原生数据库维护 | 下述 8 组通过，`cleanClose:true`，自然退出 |

数据库场景在隔离临时 profile 中执行：实际无重复 ASAR 的 packed-shape 正控与 owner
损坏负控；fresh 只读检查和原生创建20/25、关闭重开；真实24→25完整备份并保留
身份/内容/配置且重试不覆盖原备份；agent22/26/损坏及shared19/21在备份前拒绝；
实际原生 writer lease 和共享 SQLite busy 分别拒绝、释放后显式重试；事务末 authority
丢失撤回25发布并保持24及原备份；IPC取消完成子进程退出观察后返回 unknown，重新
检查后显式重试。没有用已完成回执替代当前 schema 事实，也没有接触真实用户库。

统一日志为 `startup-native-gate-final.log`；实际数据库报告为
`.agent-tasks/runtime/native-database-upgrade/probe-KckiMk/result.json`，身份精确为
本节 `d4828cc5…c861a`。部分 Vite 诊断指出裁剪后 source map 不存在；业务断言和
每项退出状态均通过，没有为此放宽校验。

### 实际运行时发行归档回环

本轮实际调用标准 `packMultipleSources`、`PACKAGED_RUNTIME_EXCLUDES` 和 zstd 压缩，
再由真实 Windows packaging hook 严格校验，最后用系统 tar 在 `发行 空间/cfmind`
目录完整提取原 tar，验证 manifest、完整 Node 文件树及自身执行、Main 原生身份准入。
整体 exit0；zstd 路径由真实 packaging hook 覆盖，系统 tar 提取的是原 tar，
不能将这两项证据称为完整 NSIS 解压安装。

| 项目 | 结果 |
| --- | --- |
| 实际发行文件 | 43320 个条目、38970 个文件；1532 个知识文件、78 个本地 worker、905 个法律文件 |
| 原生维护合同 | 16 项实际 owner 齐全；按真实发行 filter 省略重复 ASAR，Main 准入仍严格通过 |
| tar | 887759360 字节；SHA-256 `7952dd7b00a9351c4f386aaf7e5618731594674406365d4520376f324c71a27d` |
| zstd | 184962493 字节；SHA-256 `218462d6434ed15fcf08d86cf464dc95acc35b35214b03c30f51915db9a4f413` |
| 身份稳定性 | source、独立固定副本及提取结果的 manifest 均为本节 `d4828cc5…c861a`，当前 recipe 仍为 `371f2275…703e1` |
| 进程收尾 | 最后独立所有权检查 `activeOwnedProcesses:0`；未启动用户 Gateway |

日志为 `startup-runtime-tar-roundtrip.log`，归档回执为
`startup-runtime-tar-roundtrip/result.json`，收尾回执为
`startup-final-ownership-receipt.json`。这是 OpenClaw runtime 单资源的实际发行形态；
未准备齐全的 Python、MinGit、本地语音组合资源和完整 NSIS 安装不计为通过。

## 2026-10-24：仅应用更新使用正常启动

在 `ae7c05ce2` 后补充路由规则。此前完整交付身份任一字段变化都会显示正常升级；
仅更新应用版本也改变包含 package 信息的 recipe，因而不能只排除 appVersion、
仍用 manifest 指纹独立触发升级。现在当前数据代际且有完成回执时，只有 OpenClaw
版本变化、原生实际需要维护、未完成升级或待确认降级才选择正常升级外壳。
OpenClaw 版本相同且实际无需维护的应用升版、构建指纹变化使用正常启动。

完整身份继续用于严格产物准入、跨目标未完成事务保护和降级比较。正常启动在
原生复验与应用初始化完成后原子更新完整完成身份、清除目标；写入失败上报错误并
保留旧回执，完整身份未变化则无需重复写入。应用降级仍保留原来的升级确认外壳及
确认前零数据库检查/零写入顺序，本次未更改 Main 窗口接线或“仍然启动”授权边界。

| 检查 | 实际结果 |
| --- | --- |
| 相关启动、共享合同、Renderer/preview、manifest 回归 | `startup-app-only-regression.log`：23 文件、359 用例通过；wrapper 最终恢复并验证 Electron ABI146 |
| 新增行为覆盖 | 应用升版、仅构建变化及两者同时变化均 Normal；可选 `v` 前缀等价；真实产品 SQLite/实际分类器和 AppInitialization 维持普通屏幕及数据库字节；实际待维护仍 Upgrade；中断升级继续恢复；异目标仅 app/build 变化仍拒绝 |
| 完成回执负控 | 未复验及复验失败不发布新身份；原子 rename 失败保留旧回执并报错；成功更新后可识别随后应用降级；已完成同身份不重复写入 |
| 静态检查与 Main 编译 | `startup-app-only-lint.log`、`startup-app-only-compile.log` 均 exit0 |
| 独立复审 | SDK 与原生维护 agent 分别只读审查实现与测试，无未解决阻塞；未修改文件或另行切换 ABI |

本次只改 Main 路由/完成记录、相关测试和文档。实际检查 189 项配方确认 coordinator
不在 recipe 输入，五个原生维护生产文件与共享版本策略均未变化；当前 recipe 仍为
`371f2275…703e1`、固定产物 manifest 仍为 `d4828cc5…c861a`。
没有重新构建相同原生运行时、重复累计前节九项 gate 或声称新增 Electron/NSIS 实机验收。
本节批次与之前测试重叠，359 不与前节总数相加。原生就绪在本节路由测试中显式模拟；
真实数据库维护与原生占用/取消证据仍以上一节固定产物的八组检查为准。

## 2026-10-24：工作区关联修复与真实桌面启动

用户实际在 VS Code 打开的旧目录为
`E:/workspace/worktrees/openclaw-2026-10-6/JustDo`。该目录和当前审核 worktree 的 `.git`
误指同一个 `JustDo30` 管理目录/索引，反向登记却只指审核目录；旧文件因而相对当前
提交显示 220 项 tracked 状态。逐项只读核对表明其中 100 项内容与当前提交相同、
73 项对应早期提交、6 项是等价格式或旧 GC 中间态，另外 41 项为当时尚未新增的文件；
唯一非忽略未跟踪文件是后来合并去重的旧验收计划。不能把这批状态当作用户新修改整体应用。

原差异的 180 份现存原始字节、41 条缺失记录及 Git 关联信息已保存至 ignored 的
`build/upgrade-audit/worktree-recovery/original-before-repair`，保留独立 SHA 校验。
用户说明没有目录偏好后，固定使用 `openclaw-upgrade-audit/JustDo`，只把旧目录失效
的 52 字节 `.git` 指针退休到非 `.git` 文件名；旧代码、日志、脚本、依赖和运行产物
均原样保留。两 agent 独立确认旧原始文件逐项未变，审核目录仍为升级分支且干净，
主目录保持 `dev`。无需新建分支、重写历史或让两个目录继续共享索引。

首次真实桌面验证从该固定 worktree 启动 `run-isolated-dev.cjs`，使用唯一临时资料目录，
没有复制用户会话或凭据。新构建的 Main 和实际 Electron 窗口均已运行，但 Fresh 在
打开产品 Store 前报错：`The bundled native database maintenance runtime is missing or inconsistent.`
堆栈定位到 `admitNativeDatabaseRuntime` 的 archive 存在检查；普通 Node 的完整产物校验
此前通过，实际 Electron 将有效 `gateway.asar` 呈现为虚拟目录，旧 `stat.isFile()` 判断
因此拒绝。真实窗口的错误页与 Main 日志均确认此问题，不能以 Node probe 或浏览器演练
替代 Electron Main 的文件系统语义。首次失败保留在 `desktop-startup-fresh.log`；自有启动
进程已退出，未开始用户资料或任何数据库维护。

修复只在 Electron 中延迟加载 `original-fs`，用于物理归档的类型检查和整文件 SHA；
内部 16 个模块仍由 archive-aware fs 读取并逐项校验。普通 Node 路径不加载 Electron
模块，发行省略重复 ASAR 的既有规则不变，没有设置全局 `process.noAsar`、删除归档、
放宽身份或新增原生补丁。两个 agent 独立复审实现与真实 Electron 回归，无未解决阻塞。

新增 `native-database-identity.electron-probe.cjs`，使用真实 Electron 42.7.0 Main，
不设置 `ELECTRON_RUN_AS_NODE`，不替换正控的 archive reader；覆盖虚拟目录负控、
物理 file/整包 SHA、实际内部模块、损坏成员/物理包/真实目录拒绝，以及省略 ASAR
发行形态正控，并断言不改变全局 ASAR 状态。先前固定包上的诊断结果位于
`.agent-tasks/runtime/native-database-electron-identity/72aad6b5-8eea-4703-a2b5-70cce1648966/result.json`，
5 组通过且真实 Electron 自然退出 0。该结果仅为旧包诊断，不代替新配方完整重建后的
默认严格验证；统一模块入口已接入第十组必跑检查。

本轮选定回归为 3 文件、141 项全部通过，`npm run lint` 与 `npm run build` 均 exit0；
测试 wrapper 最终恢复并验证 Electron ABI146。日志为 `desktop-startup-tests.log`、
`desktop-startup-lint.log`、`desktop-startup-build.log`。这些检查不代替下面的实际启动结果。

### 新鲜产物与完整桌面启动

冻结生产输入后，子环境 `OPENCLAW_FORCE_INSTALL=1`、`npm_config_offline=true` 执行完整
`npm run openclaw:runtime:win-x64`，从 pristine 包重新安装、应用 33 项补丁、bundle
深层语义/幂等后验、资源、预编译和裁剪，一次完整 exit0。没有重写旧产物的 manifest，
旧 `win-x64-startup-regression` 保留。新 immutable 为
`build/runtimes/openclaw/win-x64-desktop-regression`，与交付 current 严格身份一致：

| 身份 | 新鲜构建结果 |
| --- | --- |
| manifest | `01103cc08fee377fa299baea4d2606335d3c32c5df4a5e4ca1b697947436ace4` |
| 189 项 current recipe | `071eaf0539d79eeb4e8dff5fdcf0a8e68fb0fc0209026fccb94b9fbe0878f195` |
| patch set | `3acfeba0ce1dce2aa13d48f35f4b34d934ce946bfae5429edccaeeae316b6b45` |
| Gateway bundle | `9e8898bbb432d7ac6511e339a453c4e68d094255883cb9aedff8557feb2ce21b` |
| ASAR | `2cbd3e726511717ff2268fd2b960789871d170e1fd4846ae86f55fea4fa1a188` |

本轮仅改宿主身份检查，原生 bundle/ASAR 的 fresh 字节与前轮相同符合预期；recipe 和
manifest 随生产输入更新。两端均通过 current recipe、完整 Node 文件树及 16 个实际
owner/ASAR 校验。完整构建/冻结日志为 `desktop-runtime-build.log`、
`desktop-runtime-freeze.log`；身份回执为 `desktop-frozen-runtime-identity.json`。

主 agent 亲自从固定 worktree 以随包 Node 启动标准 `run-isolated-dev.cjs`，使用全新
临时资料目录，路径同时含中文和空格。首次启动实际显示四步准备页，随后进入真实
首页，Gateway 认证连接、原生配置加载和完成回执均成功。Alt+F4 触发正常清理，
标准 launcher 自然 exit0；记录的 Main/子进程全部退出。

随后用同一资料目录再次启动，实际显示紧凑的“正在启动”界面，Main 明确 `route: normal`，
随后首页和 Gateway 认证连接成功；原完整完成身份保持正确。再次 Alt+F4 后 Gateway
`shutdown completed cleanly`、`code=0, signal=null`，launcher exit0，10 个已记录的
owned 进程均退出。相同身份下 journal 保留原 fresh 完成记录，不误写另一轮升级。
控制台为 `desktop-startup-fresh-final.log`、`desktop-startup-normal-final.log`，
关闭和身份回执为 `desktop-startup-fresh-result.json`、`desktop-startup-normal-result.json`。

正常升级使用精确绑定新 immutable 的独立合成 profile：原生 shared20 + 官方 agent24
fixture，仅从已关闭测试 profile 复制产品库和完成回执，没有复制用户资料、配置或会话。
主 agent 实际观察“正常升级安装 / 更新数据库结构”页面及随后首页，Gateway 认证连接、
`route: upgrade`、complete 和新完整身份均成立。关闭后另一 agent 用随包 Node 独立
复验 shared20/agent25、原 SID/合成事件 SHA，以及 shared20/agent24 整组原生备份；
agent24 备份与升级前数据库字节精确相同。证据为
`.agent-tasks/runtime/electron-upgrade-fixture/859b3fa3-53bb-47a9-b02d-9d77931118e0/post-gui-result.json`。

本次升级 GUI 的退出不能标为 Gateway clean exit：Main 在 15.071 秒调用 Windows
`child.kill()`，当时原生 plugin-state 关闭刚完成、其余关闭尚在推进；最终是
`code=null, signal=SIGTERM`。Main/launcher 虽 exit0 且 10 个 owned 进程全部退出，
它们不能替代原生正常关闭证明。另旧 16 秒计时器在未观察进程退出时仍会返回成功。
该缺口来自宿主既有监督策略；原生 325/330 秒预算在前版已存在，本版真实验证暴露
了不匹配，不能写成本版才新增该预算。原失败保留在 `desktop-startup-upgrade-final.log`、
`desktop-startup-upgrade-exit-result.json` 和 `gateway-shutdown-budget-audit.json`。

升级日志还记录一次原生 agent 后台准入前的 `sessions.create: UNAVAILABLE`，随后
`agent-admission recovered`，memory dreaming 后续成功建立 managed cron。日志不含
该次 create 的调用方/参数，不能据此确定来自哪个宿主入口。另用实际宿主源码的隔离
诊断确认 workspace App 会永久缓存一次 create 失败 Promise，连续两次显式 prepare
仅触达一次 native create，需修复。不能因错误形态为 pending 就重新派发 create：
同形态可在深层处理出现，必须保留未知写入边界。

十组严格 gate 在新 immutable 上一次完整 exit0，未使用 diagnostic 参数；原九项及
数据库八组均通过，实际报告为
`.agent-tasks/runtime/native-database-upgrade/probe-JIsC0s/result.json`（`cleanClose:true`）。
第十项真实 Electron Main 五组通过，driver 确认 `code=0, signal=null` 自然退出，结果为
`.agent-tasks/runtime/native-database-electron-identity/d6e4dd43-50e4-4828-8b72-5b4a342087bc/result.json`。
完整日志 `desktop-native-gate-final.log`；这些结果不消除上述完整 App 接缝发现。

### 就绪与退出监督修复后复验

工作区 App 在派发创建前，先用原生 `sessions.describe` 等待 agent 数据库检查，且要求
预留的会话不存在。只有原生公共 SDK 关联到该次只读请求、准确的 pending 错误，才能
释放尚未发送 create 的失败准备，供下一次显式 prepare 使用；实际 create 一经派发，
任何失败或未知结果都不重发。当前服务、路由、manager、连接代次、owner 和关闭状态
在异步等待前后均检查，避免旧连接结果污染新 owner。原生实际构造器/WeakSet、源码
准入和宿主行为分别有必跑合同，不能用相同错误文本模拟成功关联。

Gateway 监督、Main 清理与开发 launcher 改用共享预算：原生 grace 330 秒、强制后
观察 15 秒，Main 425 秒，launcher 430 秒。每个进程保留唯一停止 Promise 和截止时间，
实际 close 才确认退出；超时、非零或 signal 退出保留失败，不能再次启动或安装更新。
Main 即使前序清理失败仍尝试其余资源，只有全部实际回收成功才关闭已有 Store。
未 join 的任务和超时不能当作成功，退出也不延迟初始化新 Store。

整批首次运行暴露旧 `startupEmergencyCleanup` 测试仍要求已经撤掉的紧急回调，留下
`desktop-final-tests.log`（其余 21 文件 461 项通过、2 项跳过），随后改为执行实际
Main 注册和清理 controller，覆盖未 join、425 秒无重复 stop 窗口及 339 秒合法清理。
显式指定当前 native/source 后，最终同批 `desktop-final-regression.log` 为 **22 文件、
466 项全部通过、零跳过**，wrapper 恢复并验证 Electron ABI146；完整 lint 与 build
分别在 `desktop-final-lint-complete.log`、`desktop-final-build.log` exit0。与各阶段
选定测试重叠，不累计总数。两个 agent 独立复审实现和实际 Main 测试，无未解决阻塞。

主 agent 再次以新中文/空格临时 profile 实际 Fresh 启动并观察首页。只读准备已成功，
但实际 native create 暴露默认 `project` 尚不存在，返回 `INVALID_REQUEST cwd is unavailable`
（`desktop-repeat-fresh.log`）。上游对显式 cwd 的存在要求前版已存在，本次真实测试
暴露宿主默认目录准备缺口，不能改为放宽原生检查或盲目重试写入。
该轮 Alt+F4 后，原生完整关闭用时 **18.036 秒**，随后 Gateway `code=0, signal=null`、
Main/launcher exit0，9 个已记录 owned 进程全部结束；证明修复保留了超过旧 15 秒的
实际清理窗口，但不能把本轮记为 workspace App 创建通过。回执为
`desktop-repeat-fresh-result.json`，后续完整复验另列。

统一入口在新 immutable 上的最终 **十一组 gate 全部 exit0**，日志
`desktop-eleven-gate-final.log`，执行身份回执 `desktop-eleven-gate-execution.json`。
第二组显式要求实际 native/source，新增关闭预算与 workspace 原生合同均无跳过；
第九组八种数据库场景位于
`.agent-tasks/runtime/native-database-upgrade/probe-yNOcYr/result.json`（`cleanClose:true`）；
第十组为真实 Electron 五组，结果位于
`.agent-tasks/runtime/native-database-electron-identity/99cbb29e-ee98-4ef3-abca-725fab9effdb/result.json`，
自然 close0/null；第十一组确认实际 Main loader 使用同一个 native 构造器/公共 WeakSet，
并执行受控只读失败、无关联错误和派发后失败三场景。最后一组不声称实际 Gateway RPC。
前后 manifest 均为 `01103cc0…6ace4`，没有重写运行产物、忽略失败或操作主 agent 的 GUI/fixture 子树。
Workboard 的已裁剪依赖 sourcemap 缺失只产生构建 warning，实际该组通过；仍保留原日志。

默认目录修复仅导出 `CoworkStore` 已有 resolver，Main 既有 await mkdir 复用同一函数，
删除硬编码 home 拼接，不改变 resolver 规则、可选错误语义、自定义 cwd、权限或重试。
两个 agent 独立审查，无阻塞。新增 9 项真实临时目录/实际 Main 初始化测试通过；随后
`desktop-default-workspace-regression.log` 为 **4 文件、30 项通过、零跳过**，再次恢复并
验证 Electron ABI146。完整 lint、Main noEmit 和 build 均 exit0，对应
`desktop-default-workspace-{lint,compile,build}.log`。这批与 466 项有重叠，不累计。

最终 Fresh 使用另一个全新中文/空格 profile，主 agent 观察完整四步首次准备及真实首页，
默认项目目录存在，实际 native describe/create/describe 均成功。打开功能菜单后正常退出，
Gateway `code=0, signal=null`、Main/launcher exit0，12 个记录的 owned 进程均结束。
完成回执为 fresh/complete、完整新产物身份。证据为 `desktop-verified-profile.json`、
`desktop-verified-fresh.log`、`desktop-verified-fresh-result.json`。

该轮退出中仍保留一次 `sessions.delete: UNAVAILABLE`：原生 20 秒 active-work drain
超时后开始关闭，归档登记 Worker 明确拒绝请求，随后写入 agent clean-close 并退出 0。
独立源码复查确认窗口销毁的 workspace release 是 best-effort，Main 未显式 join 此
owner，存在停机竞争路径；但日志无 delete 参数，不能唯一确认调用方。原生删除可先
提交、再于归档登记失败，故本轮只确认进程退出，不宣称该删除完整完成或完全未发生。
可能保留临时预览归档元数据的未知结果；没有现成历史误删或数据库损坏证据，也不据此
放宽精确 SID/revision 围栏、重试未知写入或新增原生补丁。安装版与真实模型验收仍另列。

### 最终真实启动矩阵

以下三轮均由主 agent 亲自在固定 worktree 运行真实 Electron/Main/Gateway，使用标准
隔离启动器和交付 Node；没有浏览器 mock、真实账号、模型请求或用户原始数据库。
生产代码与原生维护输入在三轮之间冻结；中间的最终测试已恢复 Electron ABI146。

| 场景 | 实际界面和原生调用 | 退出与资料检查 |
| --- | --- | --- |
| Fresh | 全新中文/空格目录，四步准备→首页；describe/create/describe 成功 | Gateway0/null、Main/launcher0，12 个已记录进程均退出；fresh/complete 和完整 manifest 正确；前述临时 delete 未确认 |
| Normal | 复用同一资料，紧凑“正在启动”→首页，日志 route normal；describe/create/describe 成功 | Gateway0/null、Main/launcher0，13 个已记录进程均退出；相同身份保留原 fresh 完成 journal，未重复升级；临时 delete 在停机 owner 撤销后返回 UNAVAILABLE，不作成功推断 |
| 正常升级 | 独立 shared20/agent24 官方合成资料；实际五步升级→首页，日志 route upgrade；只读 describe 等待约 5.49 秒后成功，create 约 0.989 秒成功并可再次读取 | delete 约 19.664 秒成功、active-work drain settled，随后原生 shutdown completed cleanly 16.383 秒；Gateway0/null、Main/launcher0，13 个已记录进程全部退出；数据库独立后验如下 |

Normal 控制台/回执为 `desktop-verified-normal.log`、`desktop-verified-normal-result.json`；
升级为 `desktop-verified-upgrade.log`、`desktop-verified-upgrade-result.json`。
进程检查同时绑定 PID 与 CreationDate，只覆盖各轮实际记录的 owned 子树，不宣称整台
开发机没有其他进程，也不把 stdout 的缺失记录当作某项事件从未发生。

升级关闭后另一 agent 通过严格 immutable 自身 Node 独立复验 shared20/agent25、
原 SID `fixture-history`、合成事件 SHA `10caf8c9…f4c60` 与完整同组 shared20/agent24
原生备份；agent24 备份 SHA `e8b875c0…0f406` 与升级前原文件字节完全一致。
当前库及备份的原生检查通过，startup upgrade/complete 与完整身份正确，结果位于
`.agent-tasks/runtime/electron-upgrade-fixture/61859c02-f5a5-4508-a16b-ba9abaa46891/post-gui-result.json`，
日志为 `gui-native-profile-desktop-second-verify.log`。该合成历史未作为会话清理目标。
另独立只读核对当前 shared/agent、同组两份备份及产品库，五项 `quick_check` 均为 ok，
各文件读前后 SHA 不变且句柄均关闭；补充回执为同目录 `post-gui-quickcheck.json`。
shared 备份经过原生 lease sanitization，未宣称其与原 shared 文件逐字节相同。

本轮完成了实际桌面启动、schema24→25、历史/原始备份与进程退出验证。未配置模型时
首页禁止发送符合当前产品规则；没有把此结果写成真实企业账号/模型对话成功。开发态
Python 未准备、原生 listener 阈值与内网浏览器配置等 warning 保留原始证据；11 个
exit listener 的提示没有堆栈，不能据此确认泄漏，也没有靠提高阈值隐藏。安装包覆盖
安装、无缓存且公网阻断的全离线冷启动、MinGit/Python/本地语音及真实模型仍未在本轮
完成人工验收。前述 Fresh/Normal 临时预览清理未知的限制继续保留。

最后一次目录修复后，独立 agent 再逐项核对动态 recipe 仍为 189 项且原字节 SHA 无
增删/漂移；重算 recipe 仍为 `071eaf05…8f195`、patch set 不变，current 与 immutable
manifest 同为 `01103cc0…6ace4`。Main、Store 和新增目录测试不属于配方输入，因此不
重建同一原生产物或重复十一门；以新增行为回归、三轮真实桌面及完整类型/构建验证宿主
改动。末验回执为 `desktop-final-default-workspace-identity.json`，独立复审无阻塞。

## 2026-10-24：Rebase 最新 dev

将原升级分支 `45230c6d1` 的六个提交重放到本地 `dev@b938102ce`，保留 dev 的四项
提交：离线可视化库、会话列表宽度、浅色代码块和下载对话框修复。重放后升级提交末端
为 `d132af835`；原提交保留本地 backup ref。独立 range-diff 确认六个提交完整保留，
14 个重叠文件同时保留两边改动，没有使用一侧文件整体覆盖。

两处内容冲突分别合并为：归档校验提取同时保留完整 `node-runtime/` 与 Widget Kit
资源；Widget 原生探针同时输出严格运行时身份与实际注册的两种内容类型。另补齐两项
验证代码：Windows 准备顺序的测试期望纳入 dev 新增的 widget 步骤，浏览器验证器的两处
原生模块名更新到 10.6；不增加旧版 fallback、生产功能分支或原生补丁。

本地只读复用主目录中六份锁定离线归档，在本 worktree 的 ignored cache/assets 中准备
并校验资源，不下载文件，也不修改主目录。相关测试首批为 244/245：未修改的
`ui-schema.test.ts` 真实资源加载用例一次返回空 DOM；原单文件随后 70/70，通过同批
完整复验最终 **16 文件、245/245、零跳过**。未改该文件、加 sleep 或放宽断言，首次
失败保留，尚未确定该次偶发的根因。测试 wrapper 恢复并验证 Electron ABI146。
完整 lint、build 和 Main noEmit 均 exit0；日志为
`dev-rebase-{tests,ui-isolated,tests-final,lint,build,compile}.log`。两个 agent 独立复审
合并结果和验证适配，无未解决的合并阻塞。

浏览器验证器另通过语法检查，并只读调用历史 01103 产物的实际原生 HTML/CSP 基础
函数，独立核对导出；这不属于本轮浏览器或 Gateway 端到端验收。
dev 新增的 Widget 生产输入已纳入构建 recipe，原 `01103cc0…6ace4` 的冻结运行时和
此前十一门/桌面证据仅适用于原先构建，不能当作 rebase 后 current-recipe 证明。
本轮没有重建或改写该产物；后续启动使用标准 `electron:dev:openclaw` 准备新运行时。

## 2026-10-24：dev 启动与 Team 首次发送修复

本轮基于 `dev@6f192d3bf`，在 `codex/openclaw-startup-team-recovery` worktree 实施，
保留 dev 已有 thinking/streaming 修复。开发前分工检查原生数据库准备、Team 准入和
构建身份；实现后由其他 agent 独立复审，处理了历史会话误判为全新、nullable revision
不严格、Main 缺少未知状态翻译等发现。未增加 OpenClaw runtime patch。

首份用户控制台捕获中，828 次同类 canonical checkpoint 错误伴随 4569 次
`sessions.describe`，原生 Worker 的提交授权窗口为五秒，记录的两次等待约 5002/5004ms。
Gateway 同期存在同步加载阻塞，但缺少精确请求派发时间，不能归罪于某个插件；后续请求
洪泛也不能解释更早的首次失败。没有证据确认数据库损坏。原 Team 提示没有记录当次
known/running 状态，不能据此断言用户点击一定属于 unknown，或把两个问题串成单一因果。
第二份捕获没有 checkpoint 错误，仍保留六次其他 RPC 错误；不把一次恢复视为永久无故障。

修复将原生 canonical 准备放在停止 Gateway 的独立进程内，继续使用官方租约、完整备份、
Worker 授权和实际退出回执。schema 就绪不能替代 canonical 就绪。无待处理任务时不新建
备份；原生同组备份可复用首次快照，不宣称每次都有最新快照或支持自动回滚。失败、取消、
身份改变和未知退出均不开放 Gateway。Team 的两次空闲检查改为目标会话读取，保留本地
执行、排队、后代、客户端代次、精确身份和变更事件围栏；未知状态单独提示并保留草稿。

本轮冻结产物身份如下，完整回执保存在 ignored 证据目录
`build/upgrade-audit/dev-startup-team-recovery/`：

| 项目 | 身份 |
| --- | --- |
| OpenClaw / Node | v2026.10.6 / v24.22.1 |
| manifest SHA256 | `75316448a9d09210d87ed4015f6878b54f1f53f5463c81ad4e6567aeabe6d5cc` |
| build recipe SHA256 | `8472b55d23124f0eaa64fa9e0e6050de96ec9416b86313ff5f6e306b436b4702`，207 项原始字节输入 |
| patch set SHA256 | `3acfeba0ce1dce2aa13d48f35f4b34d934ce946bfae5429edccaeeae316b6b45`，33 项不变 |
| 原生 owner | 18 项，新增 canonical validation/worker 两项准入 |
| bundle / ASAR SHA256 | `9e8898bbb432d7ac6511e339a453c4e68d094255883cb9aedff8557feb2ce21b` / `1145ae602d4fc3d54327d3312558d018577e19f92b30d46ea18b3d790683e187` |

Gateway bundle 构建耗时约 8.7 分钟，后续还有插件装配和预编译。这次构建范围过大：
与用户原 B8 产物比较，11096 项原生核心
文件字节完全相同。随后复用本次验证产物，不再重复原生构建。输入和产物身份分别见
`fresh-source-identity.json`、`fresh-frozen-runtime-identity.json`；主目录暂存完整 39532
项文件/链接与冻结副本一致，见 `main-staged-runtime-identity.json`。目录之间仅换行符
不同的生产输入仍须对齐到已验证的原始字节，不能修改 manifest 绕过 recipe 校验。

主目录最终复用同一产物，59 个输入仅对齐换行字节后，207 项 recipe、18 owner、
ASAR 和完整随包 Node 的严格准入通过。暂存目录通过同盘 rename 安装，保留原 B8
产物；Git 跟踪内容无附加变更，用户日志原样保留，未修改用户资料或数据库。回执为
`main-final-current-runtime-identity.json`；后续本节文字修订不属于 recipe 输入。

最终行为回归为 **42 文件、1024/1024、零跳过**，使用实际目标上游源码，测试 wrapper
恢复并验证 Electron ABI146。首次全批次有一个旧测试 mock 未实现新必需接口的失败，
补齐 fixture 后同批次全过，没有放宽生产校验。完整 lint、Renderer build 和 Main 编译
通过；最后 Main 翻译补充后再次 build、对应 lint 通过。日志为
`regression-tests-final.log`、`build-final.log` 及本目录其他检查日志。

| 新产物原生验证 | 结果与覆盖 |
| --- | --- |
| canonical 准备 | 五组通过；空目录不创建数据库、260 行历史和配置保留、备份先于 canonical 写入、新进程认可同一文件回执、重复执行零 Worker/零新备份、复制/替换/撤销失效、损坏原始备份组拒绝、真实提交消息延后 5400ms 后仍按五秒原生授权拒绝 |
| Electron 身份 | 五项通过；真实 Electron/ASAR 成员与原始字节准入、18 owner、目录和损坏归档等负例 |
| Team 首次发送 | task/group 均经实际宿主 coordinator 和认证 Gateway 创建、注册、发送；精确 key/SID/runId 的 `executionSettled:true` 整轮终态及官方历史可核对；未知状态在任何创建/注册/发送前拒绝 |

两个受影响原生 gate 均以严格 current recipe 执行并 exit0，见
`fresh-affected-native-gates-result.json`；本轮没有执行完整十二门矩阵。
Team 回执位于 `.agent-tasks/runtime/agent-team-first-send/probe-jA1Fta/result.json`，
所有自有客户端和 Gateway 正常关闭。loopback 模型共六次请求，两种模式各三次，符合
实际 runtime-services 的两次纠正上限；这验证首发链路，不代表模型实际组织了成员、
完整 Team 桌面对话或企业模型服务已验收。

主 agent 另亲自启动真实 Electron/Main/Gateway，使用中文及空格路径的全新隔离资料：

| 路由 | 实际结果 |
| --- | --- |
| Fresh | 四步首次准备进入首页，fresh/complete 与完整新产物身份正确；启动期间零 checkpoint 和 RPC 错误；标准关闭 Gateway0/null、Main/launcher0，原生清理约 59.17 秒 |
| Normal | 复用同一资料，紧凑“正在启动”进入首页，日志 route normal，没有重复升级界面；保留相同完成身份；启动期间零 checkpoint 和 RPC 错误；标准退出时一次 `cron.list` 被原生以 restart 拒绝，随后 Gateway0/null、Main/launcher0，原生清理约 5.75 秒 |

桌面日志及进程退出回执为 `desktop-{fresh,normal}.log`、
`desktop-{fresh,normal}/close.json`。未配置模型的首页禁止发送符合当前规则；没有使用
真实账号、用户数据库或用户草稿。原生准备仍有耗时：本机独立单 agent 正常复验约
20–27 秒，实际 Gateway 启动另有后台准备及同步加载等待；本轮不宣称启动性能已优化。
安装包、无缓存且公网阻断的冷启动、其他平台和真实企业模型仍需另行验收。原始日志、
数据库和诊断产物不进入 Git。

## 2026-10-24：Team 与 Swarm 五类消息入口定点复查

本轮继续在升级 worktree 实施，覆盖 Team 主会话、成员单聊、实际群聊，以及
Swarm 主会话和节点输入。前节 task/group 首发只证明宿主创建与普通消息发送，
不能代替实际群聊成员执行或 Swarm 工具创建流程。本轮补充三个独立原生探针，
实际使用生产 Renderer controller、Team host 和 Swarm host/native 插件，分别记录证据。
接口差异和每条生产链路见[专项报告 2.7](module-api-audit.md#27-五条人工发送入口定点准入与扩展产物)。

发送前旧会话检查、Team 创建/成员准入/清理/删除、Goal 重放、标题和统计均使用精确
`sessions.describe`，不依赖全局会话扫描；保留当前成员、SID、revision、连接代次、
本地未结算和原生后代检查。未知保持未知，不自动补发。群聊结算缺少原生 SID 时
拒绝接纳，不能以缺字段放行。背景目录展示和历史运行恢复仍承担各自的目录职责，
不进入发送准入链路。

### 资源范围与产物身份

本轮没有重建 Gateway 核心或新增 runtime patch。正式资源同步、扩展预编译和
裁剪写入新目录 `build/runtimes/openclaw/win-x64-collaboration-send-2`，原冻结目录保留。
207 项 recipe、18 项原生数据库 owner、bundle、ASAR、SDK 和完整随包 Node 与前节
753 产物一致；所有非 `dist/extensions/` 文件逐字节相同。

| 项目 | 本轮身份 |
| --- | --- |
| core manifest SHA256 | `75316448a9d09210d87ed4015f6878b54f1f53f5463c81ad4e6567aeabe6d5cc` |
| build recipe SHA256 | `8472b55d23124f0eaa64fa9e0e6050de96ec9416b86313ff5f6e306b436b4702` |
| 独立 extension assembly SHA256 | `a055e1843b8a5c981e47b26644ecb8145db3e4c1fdaf45fa46bc3a522855e671`，57 项原生扩展输入 |
| extension receipt SHA256 | `3032a590089062e5c0bd17af0f53766d5252c7c4656ec952c5f08971396fddcb` |
| Team / Swarm 编译入口 SHA256 | `35736222078d9c014c659d55bfe3e04505a48b07a97daa369f340169dd2170da` / `d35e478ab18543788efd8f90bcb477074b462e72fa84033d986c7e9bf85267b6` |

core manifest 不绑定本轮插件源码；独立 receipt 记录完整扩展输出库存及源闭包，
原生探针还只读重编两个真实入口并逐字节核对产物。缺 receipt 的标准新构建仍须通过
当前核心严格准入和真实入口重现，不能凭 manifest 相同认定扩展相同。控制用例实际
拒绝修改入口、遗漏源文件、未记录的额外输出和错误核心回执。

### 自动化结果与复验边界

最终相关回归 **94 文件、1,929/1,929、零跳过**，目标源码固定为
`v2026.10.6@fe06181dc5ecc01cf8904abbfc26925925efefbc`。测试 wrapper 恢复并验证
Electron ABI146。独立的发送 gate 源码/准入/结算/产物控制分项 **7 文件、116/116**；
它们与前述应用回归存在重叠，不相加。完整 lint、Renderer/Main 生产 build 和
Main noEmit 通过。日志在 ignored `build/upgrade-audit/collaboration-send-matrix/`，
不提交原始日志或用户数据。

最后复审补充 checkpoint 等待期间的计时替换围栏：只有同一启动 marker 才能继续，
新的已接纳运行、替代 marker 和删除均返回未知，零 finish/reopen/begin。
两 IPC 文件 **99/99**，最终发送 gate 源码控制 **7 文件、119/119**；
包含在先前大批次中的用例不重复相加。围栏后再次生产 build、Main noEmit 和对应 lint
通过，日志 `checkpoint-race-final.log`、`send-gate-source-controls-final.log`、
`build-checkpoint-final.log`。既存 accepted-timing 的空闲/root 后备未混入本轮，
其收敛缺口见[独立计划](../../plans/session-run-terminal-evidence.md)。

| 最终真实原生分项 | 实际结果与范围 | 隔离证据 |
| --- | --- | --- |
| 共享主会话 controller | 新建、续发、重连、真实 initial dispatch 四次精确 SID/run 整轮终态及历史；错 SID/key/断线前零发送；已接纳 ACK 丢失保留 unknown，仅一次发送、零自动重放；全部 wire 含初始化零 sessions.list | `collaboration-main-send/probe-BRkUgh`，5 次模型请求 |
| Team 成员与实际群聊 | 来源一次、成员一次、群聊两位成员均有精确 whole-run；原生历史、群聊同请求重放零发送；真实 bind/dispatch→Requested→handle→resolve ensure 三次，只创建一个新成员，已有/未知零新创建、发送或删除；三位团队成员精确 CAS 删除 | `agent-team-message-paths/probe-oxWJ9X`，4 次模型请求，全部 application sessions.list 为零 |
| Swarm 主会话及节点 | 实际 start 工具发起；运行中 note 零派发且拒绝 continue；失败同 key/SID 新 run 继续、同 operation 丢 ACK 对账及原文持久保存；retry 新 key/SID/run 并完成验收和投递；已有主会话 status 真工具一次；三个 work 的 whole-run 和公开 cleanupSettled 分别取证 | `swarm-workflow-send/probe-rKAbSt`，14 次模型请求；Host 实际零 sessions.list，插件无该调用另以当前 bundle 静态检查证明 |

三个分项均 `verified:true/cleanClose:true`，所有自有 Gateway 和客户端实际正常退出。
证据目录位于 ignored `.agent-tasks/runtime/`；最后独立核对生产源闭包分别为
217、32、12 项，全部 raw SHA 漂移为零，见 `final-component-proofs.json`。
原生运行包均为本节同一 `-2`，未新增 Swarm 生产适配或重复构建核心。

保留失败及修复复验：Controller 首轮 Node relay 缺浏览器 Origin，原生拒绝；测试补精确
loopback allowlist/HTTP Origin 后通过，未关闭原生验证。Team 首轮后端未订阅内部群聊
会话的 lifecycle，改用官方精确会话订阅；后续新增 ensure 未知反例误期待统一错误，
改为精确保留原错误并继续断言零变更。Swarm 前四轮外部测试 wrapper 不具备 bundled
钩子/特权 RPC 信任，未证明生产故障；最终改为直接加载正式 bundled 原入口，用公开
会话订阅和 cleanup 字段取证。其后两轮分别修复测试把模型输入日期前缀当成原文改变、
以及复验期间使用旧 revision 的问题；原文强断言放在真实 dispatch 与认证历史，操作
紧前读取当前 revision，保留 stale revision 负控且不自动重试未知操作。失败未计作通过。

复验入口：

```powershell
node scripts/test/run-collaboration-send-contracts.cjs --runtime-dir build/runtimes/openclaw/win-x64-collaboration-send-2 --source-root E:/workspace/openclaw
```

该入口先验精确目标源码、current recipe/frozen core 和当前扩展；本节当时按源码控制、
真实 controller、Team 和 Swarm 四阶段执行，后续 Main 接缝补查扩为五阶段，
最后复核相同产物与源码。已接入模块验收的
第十三门；本轮按分项执行，不宣称完整十三门矩阵已经重新运行。超时或子进程失败
整体失败，只有探针实际关闭并 join 全部自有资源的结果才记录 `cleanClose:true`。

真实服务、DOM/React/完整桌面 UI、用户资料和企业模型未由这些合成探针代替；
原生测试全部使用隔离资料及 loopback 合成模型，不操作用户数据库或真实凭据。

## 2026-10-24：迟到会话通知与 Main 准入补查

用户随后在 dev 的真实已有会话仍无法发起 Team；失败均为准备前状态未知。
本轮只读核对最新 Main/Gateway 日志及产品会话元数据，不读取原生 transcript 文件，
不修改用户数据库。普通运行已完成，来源没有 native key/history binding/旧 launch 回执；
四次 create ACK、迟到 changed 与成功 describe 的时间交错相同。
接口与接缝说明见[报告 2.8](module-api-audit.md#28-准备响应后的会话通知与-main-准入接缝)。

新增直接回归先在旧实现返回 unknown，按原断言失败，证据
`build/upgrade-audit/dev-startup-team-recovery/targeted-event-reobserve-before.log`。
修复仅对被通知淘汰的合法定点结果再读一次，固定 SID、revision 三态、产品身份及
连接代次；未知 custody、真实 busy、缺行、错误、换代和重复失效不能借重读放行。
独立复审补充 await 期间转为 external owner 的围栏及真实 SQL 映射反例。

| 自动化复验 | 实际范围与结果 |
| --- | --- |
| 直接状态与目标原生源码 | 2 文件 74/74，required source、零跳过；完整 `materializeSessionRow` 与原生活动函数经过 JSON 序列化，证明 revision 合法省略，缺省/null/字符串不互换 |
| 真实 Main 组合与关联 IPC/Team | 4 文件 183/183，零跳过，含新增 19 例；真实 CoworkStore SQL、Adapter/propertyContext、生产事件处理、Router、Team launch 和 IPC，网络与 Electron/Git 端口受控；Node 内存 SQLite 不切换 better-sqlite3 ABI |
| 最终发送 gate 源码分项 | 9 文件 209/209，零跳过；含直接状态、原生源码、Main 组合、启动 checkpoint、Team launch、讨论结算与扩展身份，精确上游 `fe06181dc5ecc01cf8904abbfc26925925efefbc` 与既有 `-2` 运行包 |
| 完整静态与生产构建 | 全量 `npm run lint`、`npm run build`、`npm run compile:electron` 均 exit0；没有 ABI 切换或 Gateway 核心构建 |

以上批次重叠，不相加；最终 9 文件日志为
`build/upgrade-audit/dev-startup-team-recovery/main-send-admission-source-final.log`。
构建日志为同目录 `main-send-lint-final.log`、`main-send-build-final.log` 与
`main-send-electron-final.log`。
没有执行全量 npm test 的 ABI 切换，没有重新构建或替换运行中的用户 Gateway。

新增原生入口 `tests/openclaw/runtime/main-send-admission.native-probe.mjs` 使用实际
Main Store/Adapter/Router/Team launch 与已验 `win-x64-collaboration-send-2`，
只延迟真正接收到的 create 事件帧，不修改 payload；将固定旧 HEAD 的状态函数放入
同一生产 context，核对旧实现一次读取未知、新实现两次精确读取。原生测试隔离于 OS
临时资料，模型仅使用 loopback 合成服务。无 Goal fixture 在每条生产事件处理后取消
独立后台 Goal 恢复 owner，因此零全局列表仅证明本次发送链路，不宣称整个应用没有
后台目录读取。完整桌面 DOM/React 和真实企业模型仍不由此替代。

永久发送门禁现为五阶段：源码/组合、实际 Main 通知准入、Renderer controller、Team、
Swarm。本轮只重跑受影响源码/组合分项及新增 Main 原生探针，不冒称完整五阶段或
全部十三门矩阵重新通过。其他三份历史原生证据继续保留其当时的源闭包和范围。

保留原生探针失败：首轮未加载真实准备依赖 automation-permission，在
`automationPermission.info` 被拒，零模型/零目标读取；补正式扩展后，第二轮已证明
旧/新准入差异及实际 Team whole-run，但测试错误地在 `chat.history` 传入无
`messageId` 的 `sessionId`，被原生正确拒绝，按正式 `{ sessionKey }` 修正。
第三轮保持释放强断言，whole/history 之后尚未满足空闲前置条件即返回 false，未计通过。
这三轮均保留 `verified:false/cleanClose:true` 和原始隔离证据，不放宽身份或释放条件，
不把测试配置/参数错误当作应用协议适配。

最终原生复验 `main-send-admission/probe-kkgkPy/result.json` 为
`verified:true/cleanClose:true`，Gateway `code=0/signal=null`、实际 join 且自有 PID 已退出。
其结果 SHA256 为 `be27ed90b90bd8450639259a1a827f9c9775ca64a0fd64fbe128f1c3ab19a405`；
最后核对 123 项实际编入的宿主/依赖源闭包 SHA 漂移为零。运行包及原生扩展仍为前节
753 / `a055e184…` 的同一 `-2`，未重新装配或重建。

| 最终实际 Main + Gateway 场景 | 原生结果 |
| --- | --- |
| 固定旧函数的同事件窗口 | 一次精确 describe 被真实迟到 create 通知淘汰，稳定返回 unknown |
| 已有普通历史后切 Team | 先实际普通发送并核对 exact whole/history；同一来源再次 prepare 保持物理 SID；真实迟到帧触发两次精确读取，实际 Team register/mark/send/whole/history 均通过 |
| 原生执行与清理分离 | whole 不代替 idle；只读确认同 SID/revision 无活动后仅调用一次实际 launch release，收到释放回执 |
| 自定义助手来源 | 两次精确读取后正常发送，同 key/SID/run 的 whole 和认证历史通过 |
| 连接/代次/错 SID | 均返回未知，零发送；不以重新观察接纳新身份 |

共 5 次合成模型请求（普通 1、Team 原生纠正轮 3、自定义助手 1）、3 次实际
`chat.send`、1 次 launch release、零 `sessions.list`。全部 26 次实际 describe 的
revision 均为原生字符串自有字段，未补 null；合法省略的正反控由上游完整函数/JSON
契约测试另证。最终原生日志为 `main-send-admission-native-final.log`。
此测试不证明模型自主创建团队、真实企业模型质量或完整 Electron UI。

三方独立设计/交叉复审覆盖生产函数、Main 组合、真实事件帧与门禁，无阻塞遗留。
本轮没有追加 OpenClaw patch、修改扩展源码或重建核心；用户原会话与数据库均保留。

## 2026-10-24：发布包 Worker 裁剪复核

本轮只重新验证既有裁剪策略，没有修改生产打包、安装或运行时代码，也没有新增
OpenClaw patch。三 agent 分别检查目标源码、打包和安装/初始化接缝，独立交叉复审
实际验证脚本及最终回执。使用主目录的严格冻结 `win-x64` 产物，未更改用户运行中的
Gateway、原会话或数据库；用户正在编辑的助手及角色模板保持原样。

**结论仍适用，但只适用于精确的 `dist/worker-artifacts/` 部署包。** 目标 npm 产物
仍将其作为独立 Worker/配对 node-host 的安装资源，`prepareWorkerBundle` 通过 lazy
producer 在明确准备部署时读取。普通本地 Gateway、Code Mode、图像、SQLite 和
PTY 使用自己的入口；不能据此扩大到删除所有 Worker、`dist/worker*` 或
`gateway/worker-environments/`。同一 PC 上的 paired node-host 仍不属于发行范围。
当前独立部署归档为 30,446,552 字节；源目录及 source proof 保持完整，仅发布归档省略。

目标上游源码为 `v2026.10.6` 的精确提交
`fe06181dc5ecc01cf8904abbfc26925925efefbc`，tracked clean；并对照 `v2026.10.4`
核查部署读取/懒执行及本地入口变化。当前产物身份为：

| 身份 | SHA-256 |
| --- | --- |
| core manifest | `75316448a9d09210d87ed4015f6878b54f1f53f5463c81ad4e6567aeabe6d5cc` |
| build recipe | `8472b55d23124f0eaa64fa9e0e6050de96ec9416b86313ff5f6e306b436b4702` |
| Gateway bundle | `9e8898bbb432d7ac6511e339a453c4e68d094255883cb9aedff8557feb2ce21b` |
| 本轮组合 tar.zst | `42ad8f64b17cff8bc8ca8f1f65abd825ea6bbee271860538156f213a23bbfc40` |

当前本地 `.worker.js` 是 **78 个**，旧回执的 73 个不再代表目标版本。归档还核对了
原生 process registry 中源产物实际存在的 **70 个入口**，包含无该后缀的 PTY、spawn
broker、service-child relay/anchor、SQLite readonly resource 等。registry 的另外两项
`worker/memory-worker-entry.js`、`worker/skills-worker-entry.js` 在准备源中已经不存在，
属于未交付 file-transfer 插件的配对工作区链路，不能将其当作本轮删包造成的缺失。
完整独立 Node/npm/npx 必须保留，当前含清单共 1,995 文件、107,657,721 字节；
因此旧版安装包体积与执行宿主的结论不能直接套用新版。

本轮实际验证如下，不与前述历史批次相加：

| 范围 | 实际结果与边界 |
| --- | --- |
| 打包/裁剪回归 | 6 文件、39 passed、1 skipped；跳过的是 Windows 下的 POSIX npm 符号链接场景，含 ACPX 第三方 agent 平台二进制排除检查 |
| 正式组合资源 | 调用生产 `packMultipleSources`，包含 OpenClaw、Python、MinGit、语音四类资源；41,127 文件逐字节核对准备源，保留 1,547 个知识文件、1,004 个法律文件及全部本地入口 |
| 正式归档校验 | 33 patches/source proof、完整 Node 文件树、CLI、bundle companions、ACPX/MXC 与 Worker 检查通过；使用私有 TEMP 的二次校验及临时目录清理也通过 |
| 实际安装资源解压 | 同版本 Electron 的 Node 模式运行生产 `unpack-cfmind.cjs`，解到中文/空格路径；41,127 文件与归档 SHA 一致，约 178.1 秒；不代替 NSIS/UAC/注册表/覆盖安装验收 |
| 初始化前置准入 | 实际 Main `admitNativeDatabaseRuntime` 接受解压产物，manifest、原生数据库 owner、Node 身份一致；不代替完整 Main/Gateway 首启 |
| 本地 Code Mode | 原生执行返回 42、等待/恢复保持词法状态、取消返回 aborted、取消后再次执行成功 |
| 图像 Worker | 两个并发 Worker 实际 BMP→PNG，检查签名和 1×1 尺寸 |
| SQLite Worker | 公开 SDK 创建实际非主线程 backend，写读并持久化 42，关闭后重新只读打开检查；未使用用户数据库 |
| PTY 与新增 Worker | 提取运行时的真实 Windows PTY 执行固定 cmd echo 并 exit0，通过公开 SIGHUP 路径收尾；新增磁盘预算 Worker 对全新空目录返回 0 |
| Node 与扩展闭包 | 提取 Node 24.22.1、npm/npx 11.19.1 可执行；13 个扩展通过真实 loader inspection，服务只登记、不激活，不调用模型 |

最终本地能力回执的 8 项操作全部自然 exit0；实际 8 个 Worker 均有唯一身份的退出
配对，子进程没有未收尾记录。JS 护栏拒绝网络并限制 CJS/ESM 从提取运行时及私有
profile 解析，5 次预期网络拒绝和 2 次宿主依赖拒绝作为负控；实际功能操作的
unexpected 为零。这是固定本地探针的约束，不是 OS 网络/文件系统沙箱。

全部操作结束后再次逐文件核对准备源和安装副本：41,127 个文件的 SHA 与安装文件
mtime 均无变化、无新增文件，部署目录仍未生成；源/安装副本的严格证明再次通过。
汇总回执为 `.agent-tasks/worker-compat-v2026.10.6/result.json`。

保留探针修正和失败范围：源码 control 曾因 junction 的物理路径准入及过早读取
PTY pid 失败，之后按真实路径和 onData 修正。首轮 installed 探针的默认 PTY kill
没有释放探针持有的 Conout Worker，超时结果保留；最终使用公开 `kill('SIGHUP')`
直接清理，不通过 `process.exit` 掩盖存活 Worker。因此本轮不认证默认 kill 的所有
生命周期，也不将缺少完整 Gateway owner 的探针超时宣称为产品缺陷或裁剪回归。

真实组合裸 tar 为 **1,051,525,632 字节**，Zstd 归档 **230,402,667 字节**；本机
实际使用 4 个压缩线程，约 **91.3 秒**，仍为 level 19/LDM/64 MiB window。裸 tar
距 1 GiB 的并行缓冲上限只余约 21.2 MiB，后续资源增长可能触发现有单线程回退，
不能沿用旧版约一分钟的固定性能结论，也不能拿该资源归档大小当作完整 exe 大小。

证据位于 `.agent-tasks/worker-compat-v2026.10.6/` 和
`build/worker-compat-v2026.10.6/run-THS6rg/`；前者的
`installed-probe-result-b.json` 为成功本地能力回执，`installed-probe-result.json`
保留首轮失败，后者包含归档/解压清单、`result.json` 和 `postcheck-result.json`。
6 文件测试日志为 `build/worker-compat-v2026.10.6/independent-tests-756597d9daec4a749b74aaf27a2ac788/packaging-tests.log`。

本轮没有重建完整 NSIS 或启动安装版桌面，覆盖安装、卸载/回滚、无缓存阻断公网的
完整桌面冷启仍属于上方未验收范围。当前 `release` 中 10 月 22 日的安装产物内
`package.json.openclaw.version` 实际为 `v2026.10.4`，不能当作新版验收证据。

## 2026-10-25：新版安装包体积优化

本轮基准改为用户实际生成的 OpenClaw 2026.10.6 Windows 安装包，大小
338,513,540 字节，SHA-256 为
`bbc0d74c3d3945b05af46823c7ed3d1bf9bdb6bb24e5cae4566d515b95d52c65`。
其资源归档为 230,411,892 字节，应用 ASAR 为 63,554,538 字节；上方旧版/单独
资源归档的数字不能代替这次基准。基准副本保存在
`build/size-optimization/baseline/`，新构建使用独立输出目录以保留原安装包。

三 agent 分别审查上游执行入口、应用依赖与打包、安装和初始化，并交叉复审。
本轮仅采用下列压缩方式，没有新增 OpenClaw patch：

- 调整普通 tar 文件顺序，集中相似依赖路径、根模块和内容完全一致的文件，让原有
  64 MiB 窗口覆盖更多重复数据。每个安装文件仍独立写入，不产生硬链接。
- 仅省略 `dist/control-ui/assets/` 下 JS/CSS 的可选 `.gz`/`.br` 副本；原始资源、
  manifest、其他插件资产和文档不变。原生协商在普通请求中返回 identity；显式
  禁止 identity 且没有其他可用表示时仍为 406。保留原生 raw 资源哈希校验。
- 12 个已编译进应用或只在开发/构建中使用的宿主包转为 devDependencies，版本不变。
  其中宿主 node-pty 不再有生产调用；Gateway/MXC 仍保留自己的 PTY。应用保留
  5 个宿主生产依赖，并从六个真实 Vite 输出收集编译组件及传递依赖的原始法律材料。
  before/afterPack 分别校验构建证明与最终法律文件，私有证明不进入安装包。

完整 Node/npm/npx、Agent Markdown、原生 docs/skills、全部本地 Worker、Python、
MinGit、FFmpeg 与语音资源继续保留。压缩保持 Zstd 19/LDM/64 MiB，不提高安装端
解码窗口或更换格式。改变构建配方后已从锁定 pristine npm 包重新构建；禁止通过
刷新旧 source proof 接纳变更。

同一份基准资源的策略实验先验证了 40,197 个保留文件的 SHA 全部一致，生产排序
实现将归档从 230,411,892 降至 200,369,939 字节。最终重新准备的当版资源和安装器
以下表为准，实验归档不作为交付成品。

| 实际产物 | 基准字节数 | 新构建字节数 |
| --- | ---: | ---: |
| 完整 EXE | 338,513,540 | 305,031,009 |
| 组合资源 tar.zst | 230,411,892 | 200,360,245 |
| 应用 app.asar | 63,554,538 | 37,374,843 |

完整 EXE 减少 33,482,531 字节（9.89%）；按十进制为 305.0 MB，按二进制为
290.9 MiB，不能混用单位声称小于 300 MB。实际 tar 组装 63.2 秒，4 线程压缩
66.6 秒；未改变安装解码参数。新输出目录为 `build/size-optimization/release/`。
当前更新地址为空，按既有配置关闭自动更新；此本地验证产物不应生成更新清单或
blockmap，不能把有意禁用认定为文件丢失。

| 新构建身份 | SHA-256 |
| --- | --- |
| EXE | `e5b102fbc8fa0665bbb9f91522f24d47c5812ad7a6dc93b1d829905441c8ae01` |
| 组合 tar.zst | `23fe5de9efa1b4ee42e8e706a837cd1252474f61430392c680c0c0fe7a70bce4` |
| app.asar | `49a58088ce770ceb626140670e3a0d707ad0ab6e2c46abc40f4915153b578690` |
| core manifest | `d2b0db62f1b41c0c274afb58cd3229ce004dfe4175f53198c1d7dc419e3d5b48` |
| build recipe | `6e5796b876c33588dde17a50993158fc483fbfab073f12d83d224bfc5126b3a6` |

Gateway bundle SHA 与上方冻结源一致。完整 builder 已 exit0，内嵌应用 7z 的
NSIS 可解码过滤器及 CRC 校验通过；包内独立 Node 24.22.1、npm/npx 11.19.1、
33 patches、离线编辑器、浏览器扩展及 Electron SQLite ABI 146 的检查均通过。

应用 lint、完整 Vite build、Electron TypeScript compile 通过。两组相关回归共
16 个测试文件、167 passed、1 skipped；跳过的是 Windows 下的 POSIX Node 链接
场景。覆盖归档独立文件和路径边界、原始资源/文档保护、法律资产和传递依赖、
ACPX/MXC、完整 Node，以及 NSIS 编译/解压/更新配置。法律检查在真实构建中覆盖
6 scopes、170 条包记录和 329 个公开文件。独立 reviewer 重跑的重叠测试不再累加。
日志分别为 `build/size-optimization/validation/targeted-final-tests.log`、
`installer-tests.log`、`lint.log`、`build-final.log`、`compile-electron.log` 和
`package.log`。

实际 EXE 的资源块不能沿用旧探针的“查找首 64 字节”定位方法：新 Zstd 前缀也
被 NSIS deflate 编码。验证按内嵌 7z 结束位置后的 NSIS 长度块解析，在偏移
104,686,474 解码 200,162,894 字节，得到完整 200,360,245 字节资源，与构建输入
全字节相同。EXE 提取的 430 个应用文件也逐项匹配构建副本。归档 44,892 个条目
均为安全相对路径的普通文件/目录，40,197 文件逐项 SHA 匹配 freshly prepared 源。

系统 tar 路径使用最终 EXE 内的 Electron 与生产 `unpack-cfmind.cjs`，解到全新
中文/空格路径，220.655 秒自然退出 0；40,197 个安装文件、source proof、完整
Node、78 Worker/1,547 知识/1,004 法律文件检查均通过。仅一个实际系统 tar
子进程且自然收尾，没有宿主模块借用或网络事件。真实 Electron 的独立 5 项负控
确认候选外 CJS/ESM、网络和任意子进程会被拒绝。此耗时发生在并行验证负载下，
不能与上方历史 178 秒直接比较并宣称安装更快。

另用同一个实际 Electron 42.7.0/Node 24.18.0，按 ABBA 顺序独立进程解码原/新
资源流到 sink，均使用生产默认 Zstd decoder。原包 5.52/5.21 秒，新包
5.07/5.12 秒；采样峰值 RSS 都约 197–202 MiB，未见这组测试中的解码负担增加。
这只覆盖解码，不覆盖创建数万文件或安装向导；并发 QA 也可能影响采样。
记录为 `build/size-optimization/decoder-6p7KP2/result.json`。

强制 `JUSTDO_INSTALLER_DISABLE_NATIVE_TAR=1` 的另一个全新安装目录也自然 exit0，
223.291 秒，40,197 文件全部匹配同一实际 NSIS 资源和源字节。此路径只加载
候选 `app.asar/node_modules/tar` 的闭包，没有宿主模块、网络或子进程借用；两条
提取都没有触发超时/强杀。实际提取的 `justdo-cli.exe --help/--version` 自然 exit0，
分别约 0.235/0.1 秒；这覆盖本地元数据入口，不代替 ACP/bridge 会话验收。
报告为 `build/size-optimization/release-qa-lVTx7s/result.json`，隔离负控为同目录
`extractor-guard-controls.json`。

最终安装副本的 8 项本地能力探针均自然 exit0：Code Mode 返回 42、wait/resume
维持状态、cancel aborted 后重新执行；两个并发图像 Worker 完成 BMP→PNG；真实
SQLite Worker 写读并持久化 42；Windows PTY 固定 echo/exit0 并经公开 SIGHUP
收尾；磁盘预算空目录为 0；13 个扩展 inspect 全部 loaded，服务只登记不激活；
Node/npm/npx 均使用安装副本。8 个 Worker 全 join，子进程未收尾和 unexpected
均为空。回执为
`.agent-tasks/packaging-size-v2026.10.6/final-runtime-probe-native-VvhWgI.json`。
执行前后完整库存也一致：源树 39,548 文件、1,116,176,843 字节，安装 runtime
38,084 文件、843,397,035 字节；path、size、SHA、mtime 与物理根全部相同，
没有新增部署 Worker 或其他资源写入。记录为
`build/size-optimization/final-runtime-probe-native-VvhWgI-immutability.json`。

最终安装副本的原生 Control UI HTTP/retention 亦通过：930 个预压缩侧档均省略，
489 个 raw 文件和原 manifest/hash 保留；identity 200/MIME/cache、显式禁止
identity 的 406、HEAD/404/越界请求、缺失编码的 retention 及损坏 raw 拒绝均符合
原生行为，2 个实际 Worker 均 join。没有启动 Gateway 或修改原生校验结果。
报告为 `build/packaging-size-v2026.10.6/sidecars-6mg452/result.json`。

### 最终桌面初始化、二次启动与独立审计边界

最终 EXE 提取根另复制到
`build/size-optimization/实际首启 中文 空格-SYR1l4/`，使用同版本 Electron host
加载实际 Main/Preload/Renderer 和安装资源，全新私有 profile 跑 Fresh 与 Normal。
两轮功能断言均通过，Main/Gateway 均自然 exit0，无超时或强杀；到稳定 ready 的
本机耗时分别 63.671/125.781 秒，不作为受控性能比较。每轮前后 40,602 个资源
的 path/size/SHA/mtime 一致。四个默认角色文件、必要扩展/技能、Settings DOM、
preload bridge 和循环稳定性检查通过；首次启动后追加的 USER.md 内容在重启后
保留，BOOTSTRAP.md 随包但默认不注入。
原聚合脚本在护栏断言处退出，后续 role 保留与资源状态断言由独立只读
`poststate-result.json` 补齐；其同时确认 fresh/normal 路由、真实 preload、六轮
engine running、Renderer/Preload errors 为空及私有产品数据库/初始化标记。

**原始聚合收据仍为 failed，不能称启动护栏全绿。** 原因是正向阶段的 5 次拒绝：
两次阻止从宿主加载可选 `supports-color`，以及原生 broker 的负 self-PGID
TERM/KILL 和 `/bin/ps` Windows 不支持探测。实际功能和资源断言已经通过，后续
没有修改原始状态、退出码、证明或资源来消除告警。独立审计逐项分类，未分类为 0：

- 扫描最终 ASAR 的可执行文件，仅 `debug@4.4.3` 的 optional peer catch-all
  引用 supports-color。实际取其原始代码块分别抛 MODULE_NOT_FOUND/EACCES，
  得到相同默认六色结果；宿主模块在执行前被拒绝，没有借用其实现。
- 原生负 self-PGID 的 Windows ESRCH 与 guard EACCES 都由同一 catch-all 吞掉；
  原生 spawnSync ENOENT 与 guard 同步拒绝也进入同一 census catch，均返回
  undefined 并保留原生 5,250 ms 等待。未替造进程退出或 group 为空的证据。
- 63 次子进程启动都有退出记录。46 个 Worker 中 41 个有显式 exit，另 5 个
  随自然 exit0 且现已 ESRCH 的 owner 进程结束；不能写成 46 个显式 join。
  独立只读 OS 后检确认 92 个记录过的 owned PID 都已不存在，没有残留候选进程。

源字节、调用点、错误行为对照及进程/Worker 证据位于
`.agent-tasks/packaging-size-v2026.10.6/startup-independent-audit-SYR1l4.json`，
其状态为 `accepted-with-documented-probe-limits`；原始收据保持
`build/size-optimization/实际首启 中文 空格-SYR1l4/result.json` 的 failed 状态。
原 trace 没记录模块 parent、子进程 argv 或完整 census 参数，因此三个 POSIX
探测的精确 callee 归因属于源码推断，不能宣称已捕获调用栈。OS 后检位于同安装
验证根的 `owned-process-postcheck.json`。8 项真实随包 Node 护栏负控和两个
spawn/fork 继承正控另有记录，未与产品正向断言混为一谈。

本轮未操作真实 NSIS 向导、UAC、注册表/快捷方式、覆盖卸载或实际企业模型。
Main QA 将窗口显示、系统集成写操作 stub；隐藏窗口没有 native capture surface，
所以未认证截图视觉。外部 CLI 的兄弟路径按实际 host execPath 解析，完整 bridge
启动仍在该 host 测法范围之外，独立 CLI 本地入口已由上方真实提取 EXE 验证。
JS 网络/模块/子进程护栏不等同 OS 沙箱。当前结论是本轮优化没有发现生产阻塞，
不把有限探针扩大为所有平台和安装流程的认证。三方最终独立交叉 review 无未解决
生产 finding；生产代码在 pristine 重建前冻结，之后仅补验证和文档。
