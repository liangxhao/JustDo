# v2026.10.7 逐模块上游接口审计

当前实施位于已登记worktree `E:/workspace/worktrees/runtime-dev-sync/JustDo`，分支
`codex/openclaw-2026-10-7-dev-sync`，F构建所用HEAD
`c00a87127ea6c4e17781be09e6a8b2dedc8a0b36`，固定dev基线
`fdf4cfdc79d9a28af70ef31f23e6ed1037287159`；新的最终产物记为F，证据目录为
`build/upgrade-audit/v2026.10.7/dev-rebase-f/`。源码recipe已确定为
`254b4da49f9b509c6781f10170e58f792b258df6d619daaf76db87e7ef28534a`，33项补丁及
patch set `b39e45d846759b03670f0d699b05f17cf1bbadc1fb620395466315061405defa`未变。
F完整构建/冻结、依赖图、严格矩阵、领域原生补验及同一次完整13段module gate均已完成；
F第二轮同预算完整npm test也已整体通过；首轮三份套件初始化失败及定向29项通过的
记录分别保留，不将分段结果拼接成完整通过。
此前E因真实Chrome MCP bundled字节回退而不可验收，不能改写E后重签或借用旧产物通过。

## F构建修复与新dev组合范围

独立只读准入F已通过：identity SHA
`263fdc595625a2ef7a41d2342b81a6040e2c45fed8970cd437951b9cf7edd0bf`，manifest为
`2faff5f450a6d7b73e8bce7512e7e97deb9a4964f321177528844f7d82e3a0db`，bundled proof为
`08c9e0a06aa03ac0a2a497f43bc4c939857df32a5d580581b0d3f917219a9aca`。八项核心
身份文件包含该proof，path/SHA与实际buildInfo/sourceArtifacts闭合，并实际逐文件核对
完整bundled树；此准入只读文件，不执行原生模块、Gateway或ABI操作。

`native-dependency-graph-f.json`已实际passed，SHA
`73395bd10639bd0dee1dd6448ea7354ed7d46d6f1a48109d9e3e2e33cee331dd`：两份原包private
依赖、322项只读generic绑定（85项重核复用、237项新建）与F lock对应；唯一bundled
Chrome raw360与F360完整树相同。80份原包owner及177项动态保护文件前后保持，E-origin
pristine/before031仅作为逐项重核的锁定源码夹具，不作为E产物通过证据。

F独立静态资源审计也实际exit0，`plugin-F-resource-audit.json` SHA
`ddbaf039d32abeee944cb98d5a7aec9229af1b550eca7ae66bc07756b6c1d1d3`：357份资源输入保持，
三SKILL source/final字节与正规文件边界、85份OpenAI来源/入口/worker及ASAR无旧shadow
均绑定同一F前后身份。此静态范围本身不证明SDK注册、CLI、ACP、群聊、模型或桌面效果；
后续原生用例的独立实际收据见下文，不能由静态结论推导通过。

装配修复只完整恢复已认证OpenClaw tar声明的bundled依赖，不新增native patch。原包的
source proof在npm安装前捕获，安装后/shrinkwrap前重新检查来源、staging身份与原始lock
出处，再完整恢复子树并记录`runtime-bundled-dependencies.json`。buildInfo及patch manifest
的sourceArtifacts同时绑定其固定path/SHA，冻结校验逐文件复核整树；Chrome原始registry
SRI仍仅表示基包出处，修复字节由锁定OpenClaw tar与完整tree proof证明。

裁剪在变更前后校验并保留整个声明bundle。Windows打包校验先提取root元数据/proof，
再由同一helper校验声明、只提取精确bundled前缀完整子树；写前拒绝链接、特殊文件、
越界段、ADS、设备名和尾点空格，解出后仍执行全部冻结/来源/树验证。既有current
junction仅在只读消费入口先解析到物理runtime；pristine/staging写入仍拒绝链接。

新增真实Chrome合同加入现有13段门禁的第二段，未新增或跳过步骤：必须有明确F runtime，
完整360文件proof、上游固定的两JS/notice/法律文件SHA；实际导入原生Browser options生成
root CLI，再由随包Node执行`--version`。另在独立副本移除frame限定caller，确认stock式
变异会被完整proof拒绝，绝不改写冻结产物。F统一门禁第二段四文件10项实际通过，包含
上述两项合同；另有独立真实normalize/CLI与整树收据。不外推跨frame浏览器动作、真实
模型或桌面验收。

新增dev的确切工具名为`present_plan`与`ask_user_question`；plugin ID及`planMode.*`、
`askUserQuestion.list/resolve` RPC未变，不引入`request_user_input`。Main交互身份、取消、
重连与unknown不重放门禁保留；Browser新增QuestionResult仅从精确匹配且唯一、非错误的
native tool-result投影展示，不建立执行终态或授权。Goal仍要求原生whole-run终态和
`executionSettled:true`后自动条件后继，未增加人工继续门槛。.7 SDK相关注册接缝无上游
生产delta；新factory/manifest及历史读取已随F组合门禁验证，第三段实际原生loader注册
全部本地扩展通过，范围为注册而不激活，不替代真实审批交互。

### 已执行的构建修复源码验证与限制

`bundled-dependencies-fix/freeze-prune-focused.*`首轮117通过/10失败，暴露新proof未纳入
Windows选择性提取与一处负控错误匹配；修复后`freeze-prune-focused-retest.*`三文件127
通过/零跳过，98.25秒。随后加入写前严格路径和新归档负控的最终轮
`freeze-prune-focused-final.*`为138通过/2超时/零跳过，204.65秒；所有新增整树、裁剪、
14项归档及8项path/type断言均通过。两个未改provider transport/partitioner用例分别在
7.562/6.553秒触及原5秒截止，没有断言差异。`provider-budget-isolated.*`随后只选这两项、
单worker、原5秒截止实际通过（2.097/1.618秒），另128项仅名称过滤未选；不将该定向结果
拼接成最终三文件全过。F完整npm test另行完成下述统一闭环，失败原件保留。

### F已执行的严格矩阵、领域原生与统一门禁

| 范围 | F实际结果与边界 |
| --- | --- |
| 严格补丁矩阵 | raw subscriber 7项及公开SDK 1项通过；严格43文件1,073项通过、1项互斥raw用例跳过、零失败，Goal tool-timeout组合5项及final subscriber 7项实际通过；随后raw publication 1项补验通过。177项保护文件在三个阶段前后共531条记录相同，80份raw owner、依赖图及F核心身份保持 |
| 公开SDK策略清除 | 实际公开API清除19个旧策略字段，同进程及全新随包Node进程重新读取均确认落盘；stale SID/revision两项commit guard实际拒绝且零写入 |
| 独立Chrome验证 | 从锁定tar重新核SHA/SRI并私有提取，360文件完整树与F/proof相同；树SHA为`433b09ca372115869c52328beaac8a5dfe6ff070c3c199dfceaa08ba13abae73`，两JS/notice/法律文件均精确匹配。实际原生Browser父模块解析、原生normalize和随包Node执行root CLI `--version`均通过，版本1.10.1；HOME/AppData/临时目录隔离，关闭统计及更新 |
| Team来源工具继承与继续 | tool-inheritance三场景/7次合成模型请求、125.241秒；default八场景/16次请求、158.676秒。真实成员、后继和借用来源文件的三个写入阶段通过，Gateway及模型loopback均关闭；不据此证明企业模型自主决策或独立PID join |
| ACP/CLI | acpx 0.19.5真实合成协议footer通过；隔离CLI唯一loaded外层OpenAI index、`openai`/`video-openai`双provider且无旧wrapper。CLI是derived inventory，不冒充持久registry证明；实际SDK注册由统一门禁第三段单独验证 |
| 完整13段module gate | 2026-10-26 18:34:53.787+08:00完成，同一次入口恰好13段与唯一`All module contract gates passed.` footer；window/gate/前后准入/独立audit均exit0，watch ready后正常stop+join、无强停，finally Electron恢复0 |
| 完整npm test | F第二轮同预算完整套件exit0：1,251文件通过、24文件跳过（1,275），17,509项通过、841项跳过、零失败（18,350），1,015.79秒。前后F准入0，finally实际恢复Electron146；首轮失败另存，不由定向复验或历史B全量替代 |

严格结果`target-validation-result-f.json` SHA为
`e72e1fc3388708623ed8dea6b0fb3b46333bb25fb5d4c22ba3c12cacd5c647e6`；六份领域业务
收据及五个outer/八个inner退出记录汇总于`plugin-F-native-probes-summary.json`，SHA为
`0520bddfb514bd8edbf1996c1961336f36b10b146aa473d1c6c26d27d1ef5b23`，逐份字节/hash
及实际退出均已独立只读核对。

完整门禁的五个协作子步均exit0/signal:null：source九文件216项、真实Main六组、Renderer
七组、Team五组、Swarm六组；四个真实发送收据均verified/cleanClose:true。Main的历史、
精确两读接纳、旧generation/client/SID拒绝保留，后继仍要求精确whole-run终态和
`executionSettled:true`，unknown ACK不重放。DB八组、实际Electron准入五组及canonical
五组也通过；canonical用例包含原lease内持久proof快路径、复制/同路径物理替换拒绝借用、
坏备份和真实5秒迟到commit拒绝，158.392秒且cleanClose:true，未改操作预算或断言。

独立审计`module-gate-independent-audit-f.json` SHA为
`21ee8d9ef067038fb64ab16d7bb6983302395b845a9b2099a72d171ada2705f5`。2,927份源码/资源/
测试/recipe输入快照SHA为
`cf7f7cb05167029182c3efecea2c386eb5884a220a96dc296e44b57a25fa38bd`，绑定上述c00/254b，
当前逐份重哈希无漂移。Main/Renderer/Team/Swarm实际输入数为126/222/31/12，公共assembly
为`e7097454528c02c35eb6a369139aa9ac859bd126367df82c7efbc02359de45a8`，其source与entry
当前字节重算相符。Renderer `controller.cjs`的`f93ee138…522e9`及Swarm `host.cjs`的
`0762c26c…c6cee`在watcher早期独立读取后，最终仍实际可读并再次匹配；无缺失compiled
证据，未把历史读取冒充当前重核。

watcher归档九个固定owner的合成JSON，不读取用户transcripts/config或原生日志。
完整module log SHA为`38d5cb9060e2d05a6fa4de50f6148430707dcc6bede2bb916b6f07c070056efe`，
completed ledger SHA为`2aa4f4d00194c572ac46749404d46de7d37caf351e6138b0653b3cb3c8b4eea3`。
纯fs observer已exit0，包含原路径/字节/SHA的68份版本副本另存稳定授权目录
`dev-rebase-recovery/native/module-f-evidence/`。这些是协议、受控合成模型及输入字节证据；
真实企业模型、完整桌面UI、安装器实机和Chrome跨frame操作仍需人工验收。

### F完整套件首轮失败与测试准备边界

`full-tests-f.log/json`首轮实际失败，2026-10-26 18:52:22.489+08:00完成。console footer为
1,247文件通过、25文件跳过、3文件失败（1,275），17,480项通过、848项跳过（18,328），
942.58秒。两份ACP文件`auth-config.test.ts`和`local-command-shim.test.ts`均在收集时缺少
`smol-toml`，没有执行断言；新的worktree尚未准备插件源码自己的node_modules，插件
package/lock仍精确锁定1.9.0。F产物中的依赖和此前实际ACP协议通过不能替代源码测试依赖。

第三份为`.7/scoped-finalize-native-subscription.test.ts`：精确版本准入一项通过，六项
行为用例因beforeAll构建失败跳过。默认current junction的helper路径仍为alias，而esbuild
解析成物理路径，使精确onLoad未命中，误纳入完整helper的`io.runtime`及`update-execution`
顶层await后无法生成CJS。测试修正仅先canonicalize所选runtime，再按同一物理root验证
精确包名/版本；另要求每次构建精确helper的onLoad命中一次。原owner/导出、六项正负控、
预算与artifact零写断言未放宽，不加入basename兜底或产品改动。

修正以test-only提交`b90d8a80f`记录；独立只读重核2,927份快照仍全同，recipe仍为
`254b4d…534a`。该patch测试不属于recipe或该门禁快照，F无需重签。首轮state为
fullTests:1/artifactAfterTests:0，finally实际恢复Electron ABI146，原始失败保留。

源码ACP依赖随后仅在插件目录按自身lock执行离线ci，关闭scripts/audit/fund并omit dev，
实际exit0、20.094秒、163包。`acpx-source-dependencies-offline.receipt.json` SHA为
`6ab0b31b8721adaf3e2587fbaf447f48da17706047c2670e89ded1a62c7d3aa6`：package/lock及
F身份前后相同，记录8,136文件/891目录且零link；独立只读复核当前七项直接依赖的正规
路径、package SHA/version及插件lock SRI相符，未再次递归声称重验全部安装文件。

`focused-recovery-f.log/json`三文件29项、零失败/跳过，24.74秒；subscriber七项（含全部
六项行为及负控）、ACP auth七项和shim十五项逐项实际passed。全局30秒/60秒、单worker，
原显式用例预算未改，finally实际恢复Electron146；state targetedTests:0，前后准入0，
两份artifact除验证时间外deepEqual，包含八项核心文件与bundled proof。JSON SHA为
`a44074076256a840e8c98b725281178fc34d44e3c174e9e349a6d5884d2ad6f8`。第二轮完整测试
使用不同的`full-tests-f-retest.*`、原30秒/60秒及max2预算；其独立成功记录见下文，
不把首轮其余通过数与定向复验拼成完整套件通过。

### F完整套件最终通过与跳过范围

`full-tests-f-retest.log/json`第二轮整体exit0。wrapper于2026-10-26 19:00:23.940+08:00
开始，19:17:37.450+08:00结束；Vitest于19:00:32开始，1,015.79秒。console footer为
1,251文件通过、24文件跳过（1,275），17,509项通过、841项跳过、零失败（18,350）。
JSON success:true且各项数一致，SHA为
`0e6f4c7316eef7d5096ec56460a29de092caa28e988916ecb69799d0da3c604e`；其1,275个
testResults把全跳过文件也标为passed，因此文件细分使用console及逐项状态，不使用
numTotalTestSuites推断。state的artifactBeforeTests/fullTests/artifactAfterTests均0，
日志finally实际验证Electron42.7.0/ABI146恢复，未放宽任何显式用例预算。

独立逐项比较首轮与本轮JSON，少掉的七项跳过恰好是subscriber六项行为用例，以及
`tests/openclaw/acpx/runtime-upgrade.test.ts`中的session identity/permissions/turn
controls原生回归；后者因源码acpx依赖就绪而解除原有exists条件，本轮实际12.776秒通过。
另有ACP auth七项和shim十五项由收集失败变为新收集的22项passed。因此通过数增加29、
跳过减少7、总项数增加22完整闭合；29项定向重点在这次完整套件内也全部实际通过。

841项跳过分布为历史patch版本764项、当前`.7`需显式原包/组合fixture的43项，以及
其他runtime/OS/opt-in条件34项；共24个全跳过文件、41个部分跳过文件。它们不计为本轮
执行通过；当前原生场景的额外覆盖以此前明确选定F的严格矩阵和13段门禁收据为准，
不由完整套件的skip替代，也不扩大为人工验收已完成。

最终纯fs重核2,927份源输入逐份相同、快照SHA仍为`cf7f7c…38bd`，当前recipe仍为
`254b4d…534a`；before/after artifact除验证时间外deepEqual，八项核心文件与bundled
proof保持。当前F完整只读准入实际通过，identity仍为`263fdc…d0bf`、manifest仍为
`2faff5…a0db`。本轮自动化已完成，保留前述企业模型、桌面/安装器及Chrome跨frame操作
的人工验收限制。

## E已执行但不可验收的历史

E曾固定于bdd689b96/fd2基线，已从锁定原包完整构建并冻结，manifest为
`e29ee97aa7ddc3ec79517093776b0ffdd28dfab0b0c2279c8c035579d1a2515c`，recipe为
`3dbf724223bb9ac7466aa6f878bbccd0249c8595a24ed066d3f3e2fe013e9412`，patch set为
`b39e45d846759b03670f0d699b05f17cf1bbadc1fb620395466315061405defa`。logout独占
源码复验已通过；依赖图首轮发现Chrome MCP bundled补丁丢失，已暂停严格矩阵。E不能
验收；修正构建后须产生新的完整产物，再执行严格矩阵、完整13段门禁及完整npm test，
不得修改E后重签或由旧产物推导通过。

### E接口范围与当时待验项

| 接缝 | 静态兼容结论 | E验证范围 |
| --- | --- | --- |
| Main配置/设置委托 | 固定tools.deny新增`openclaw`；目标原生工具确为独立setup/repair delegation，.7 ToolPolicySchema接受精确字符串deny且deny优先。该Main文件明确属于runtime recipe，已fresh重建 | logout文件127项以原预算独占通过；其他ConfigSync、默认模型及目标原生schema/config门禁仍待E验证 |
| Team host准备与未知占用 | 已知request先复用原receipt，不新prepare或重发；新批次先assertSettled，再按成员精确SID/revision刷新来源策略并Validate。queue generation、来源id/agent/cwd/permission及启停/删除守卫保留；未知Start ACK保留occupied slot和原requestId，只查status | host产品SQL/source、真实群聊与来源工具继承待E验证 |
| Team公开SDK/工具继承 | .7公开SessionEntry/get/patch与channel/reply/group/transcript接缝相对.6无生产差异。每批复制来源当前执行/模型策略，保留成员角色workspace，准备/dispatch/commit重核来源。required sandbox及未验证ACP/runtime继续拒绝 | source SDK模拟、实际loader、真实继承与公开patch清除旧策略字段分开验证；E均待验 |
| 来源汇总与任务继续 | 移除群聊专属read白名单和summary disableTools，沿用来源原有工具/权限/审批；讨论数据不产生授权，只继续用户已授权任务。whole-settled/cleanup/output receipt仍为结算依据，attempt完成不能替代 | 自动续跑/未知不重放/迟到取消负控与真实工具后继待验；模型是否正确理解授权仍需实机 |
| 聊天错误呈现 | 新formatter/展开收起只改变显示和i18n，不改tool_execution字段或send/Continue准入；Markdown仅完整往返匹配时解码一次并按文本显示 | E源码与构建待验，受控DOM测量不证明真实Electron宽度/UI |
| Chrome MCP bundled来源 | 原包明确bundle `chrome-devtools-mcp@1.10.1`的上游snapshot identity修复；native Browser及Main shim实际使用最终root包CLI | E依赖图真实失败：360份raw与359份final中两JS不同、notice缺失；最终字节退回未修复registry版本，需先修构建 |

既有33项补丁及`b39e45…`patch set保留，不新增native能力；新策略和Team源码/技能属于
recipe/扩展assembly，E的实际指纹须由本轮冻结确认。历史C/D source和产物结果只记录当时
执行范围；此前外部清理已删除旧worktree及build证据，不能作为E验收依据。
E将把本轮probe合成JSON按原字节/SHA/原路径及时备份到稳定证据目录，不读取或复制用户
transcripts、配置或原生日志；归档只保存证据，不替代实际门禁。
已独立只读核对E重新准备的三个锁定原包SHA/SRI、80份原生owner的当前hash及前后记录；
`before-goal-admission-receipt-e.json`为本轮新生成，001–030依次apply/verify并最终复验
30项、76份变更target与43份patch输入字节相符，031仍精确报缺失，patch指纹仍为
`b39e45…`。此处未重跑补丁、未读取正在构建的最终runtime，不计严格矩阵或实际gate通过。
本轮已准备2,917份tracked源码/资源/测试入口及recipe输入的独立字节快照，绑定HEAD
`bdd689b96`与recipe`3dbf724…`；watcher仅在冻结后启动，先确认ready再运行门禁，结束后
stop并等待退出才审计。最终审计将核同一次13段footer、五协作退出码、精确E身份、
各receipt的源输入及实际assembly；compiled文件若已被清理，只能引用此前实际读取的
hash或明确记为不可重核。脚本/报告已另存授权的稳定recovery目录，以上准备不计实跑。

### E已执行的独占源码复验

2026-10-26 16:39:44+08:00，`run-policy-logout-e-isolated.ps1`实际exit0：
`openclawConfigSync.logout.test.ts`一文件127通过、零失败/跳过，112.58秒（tests
110.80秒）。单worker、全局testTimeout30秒/hookTimeout60秒及原15/20秒显式用例截止
均未修改，D首轮超时的五项本次也实际通过；这排除了本次相同预算下的重现，不能据此
证明D超时的唯一原因。前后E准入均0，identity SHA均为
`89797791cfd10f8be751a0b8c93207c1c524dc33f36be0384f8ed3a8446fdade`。
Node24.22.1 ABI137实际内存SQLite验证成功；完成后保持Node窗口交回root，未恢复Electron
或并发启动其他probe。原日志/JSON/state及两次准入/Node准备验证日志共七份已原字节备份
到授权的`dev-rebase-recovery/native/`，备份ledger逐项记录SHA；JSON为
`fd0819faea3d100afcc8beeedb7ad4a09bfe811641a568ef691f1aacdc158335`。
此结果只覆盖该源码文件，不替代严格矩阵、实际SDK、完整module gate或full suite。

### E依赖图发现的构建缺口

E首次graph没有通过，严格矩阵尚未启动。锁定原包的Chrome MCP含上游批准的完整bundled
修复，而`installProdDeps`删除全部node_modules后重装registry版本，使`TextSnapshot.js`
与`McpPage.js`分别从已补丁SHA`299833ad…788b`/`47aa13c6…9975`退回公开原始
`f3496989…5ea0`/`d49b2666…538d`，并丢失`build/src/OPENCLAW_PATCH_NOTICE.md`；
其余357份文件相同。上游tag的`patches/README.md`、`package-bundled-mcp.mts`与原包
notice共同声明必须保留这些字节，不能为通过图校验而改成junction或清掉notice。

该差异影响实际执行：原生Browser的`chrome-mcp-options.ts`与Main引擎shim均解析最终
root包CLI；frame/CDP session/document generation绑定、替换renderer后lazy handle拒绝、
frame限定DOM/CSS查找会随旧JS回退而丢失。原包单独Chrome registry SRI只说明基包来源，
已修复字节的来源证明是锁定OpenClaw tar及其bundled合同。修复应在装配阶段完整保留
声明bundled子树及真实`inBundle`元数据，不新增native能力；须另行review并fresh重建，
不能把本次E冻结或此前源码通过视为修复后的验证。

E独立资源审计已实际exit0，`plugin-E-resource-audit.json` SHA为
`aa1907a364e01a087c2d2826a61b3236413148fa65904e0f963e17483a20b8bd`：357份资源输入、
三SKILL source/final字节、85份OpenAI来源/实际入口/两worker及ASAR无旧shadow均通过，
前后绑定同一E身份。该结论仅为静态资源/来源范围，不覆盖Chrome依赖、SDK注册、CLI、
ACP、真实群聊或live技能发现，也不能消除上述graph失败。

## C/D已执行但原件丢失的历史

C完整13段门禁曾在同一次调用通过，结束于2026-10-26 14:54:58.990+08:00，五协作
子步均exit0，Node准备/验证、gate、身份复核和Electron恢复均0。独立审计当时已核
Main/Renderer/Team/Swarm六/七/五/六组verified/cleanClose，输入126/219/32/12及57份
assembly源码、两扩展输出；273份Git checkout-filtered输入和97份依赖SHA匹配，assembly
为`e8d143d23606b1d4597a18f63ab4fdc62d94f47ec03af386acd057527acf7e7c`。
canonical最终五组passed/cleanClose、275,191毫秒，含首次lease快路径、物理替换、坏备份与
5秒迟到commit负控。C完整npm test未执行。原`.agent-tasks`receipt先被外部清理，随后
旧worktree连同build日志/state也被回收；下文旧路径仅指当时记录，目前不可重读。

D固定在同一fd2基线，曾实际执行Team五文件207项、聊天十二文件263项，均通过且零跳过。
Main/config/host四文件首轮311通过、5超时、零跳过，557.93秒：Team host78、ConfigSync105、
modelDefaults6全过，logout127项中122过、5项超出原用例15/20/30秒截止，没有字段/权限/
身份断言差异。其127个同名用例在C总耗时225.647秒、D为553.219秒，中位884→1,936毫秒；
尚未独占复验，不能认定纯环境原因。原始失败不抹除，E将以max1、全局30秒/hook60秒及
原显式15/20秒单文件复验，不放宽预算。

D首轮pipeline因离线Node根被外部删除而失败；恢复后root报告完整第二轮pipeline exit0，
但15:45旧checkout/build再次整体被回收，产物和证据均丢失，未完成独立冻结/最终门禁。
D未执行独占logout复验和完整npm test。E重新验证，不能把上述当时执行记录拼接成E通过。

## 第一次dev合并与C的设计历史

C实施树曾于2026-10-26重放到 dev
`1d3d217a1f585f5bae36cc0e7e1118b940ed14cb`；升级提交为
`50bad0a679331a201c968e31ce0dfa1f35dfeaf5`，工作目录为
`E:/workspace/worktrees/openclaw-2026-10-7-rebase/JustDo`。本轮后续产物记为 C。
目前已完成合并源码静态核对、聚焦source回归、C完整重建/冻结及严格补丁矩阵。
C首轮13段module gate及随后协作聚焦分别暴露两个旧fixture边界；均已仅修测试并完成
对应聚焦复验；随后完整13段已在同一次入口通过，五个协作子步均exit0，完整npm test尚未执行。以下A/B结果均为
原实施树的历史证据，不能作为合并后C的通过结论。旧日志名也只标识原执行记录。

### C当时的接口与验证范围

仅重放原升级提交到最新dev；没有在共同祖先之后再次重放已被dev重写替代的历史
启动/列表提交。唯一文本冲突为Cowork测试，插件agent解决后由原生接口agent独立复审。
本节记录C当时的合并源码与最终已执行范围，后续完整门禁结果已在上文记载。
后文逐模块矩阵的实跑仍按A/B原有范围解释，原日志/receipt现已不可重读。

| 接缝 | 合并源码核对 | C当时实际验证范围 |
| --- | --- | --- |
| 配置/权限 | 保留dev集中固定tools.deny（按dev策略不合并旧全局deny）、transcripts.enabled:false与allow/alsoAllow互斥、computer所属设置；同时保留.7精确目标及native schema断言。transcripts是原生会议采集开关，不能解释为关闭普通chat history | full/minimal/login/logout、权限/可选插件、默认模型清空与发布协调source回归通过；原生目标schema所在完整13段门禁通过 |
| 会话列表恢复 | 仅当前认证facade确认的精确PluginInstanceUnavailableError重做sessions.list只读分页；旧页丢弃，client/generation/后续失效仍拒绝，四次有界退避与10秒恢复总预算 | 认证/伪造错误、旧连接、分页失效、预算/取消及普通读source回归通过；不重试create/send，完整13段门禁通过不外推额外真实分页场景 |
| 初次会话/模型 | 只在sessions.describe读取上等待native存储就绪；create仍单次。显式model pin在新send前重核key/SID/权限/cwd和model来源，连接与配置代次变化拒绝，未知send仍保留原run | storage pending与错误agent、取消/换代、create未知不重试、单次send与模型准备source负控通过；Main真实发送六组及完整13段门禁通过 |
| 启动DB | .7的18角色合同与原升级树完全相同，schema20/25及来源[20]/[24,25]未放宽；dev轻量deliveryIdentity只负责路由，维护execute仍完整admit并要求Gateway已停 | 路由与完整准入分层、损坏owner、取消/退休source回归通过；真实DB维护与ASAR准入所在完整13段门禁通过 |
| 持久canonical proof | 无pending时在原维护lease内inspect/probe/ready，再核lease/source后正常退休，仅省worker handoff；native物理身份/原备份和receipt仍为权威。探针保留dev精确活动序列及history/config/proof不变断言，并保留.7 hashed owners | 最终完整13段入口内五组及cleanClose通过，含重复准备零worker/backup、复制/替换身份、坏备份与迟到提交 |
| Cowork/LF | dev生产loadSession保留temporary、失败/过期读取与focus守卫；合并保留session-read拒绝和model三态测试、spy恢复与等待当前Promise；.7 raw消费端LF规范和三换行测试仍在 | 会话加载/focus、新旧读取竞态、模型晚到及角色基线source回归通过，详见下方Renderer批次；真实UI仍待验 |
| Goal与结算 | 自动后继、精确身份/序列、executionSettled:true、新UUID条件接纳与未知ACK不重放均未因rebase改动；保留工具超时先核对结果的提示，不新增人工继续门槛 | Main coordinator/adapter及tool timeout自动续跑正反通过；C严格矩阵中真实终态→接纳组合5/5通过，完整13段入口的发送gate也通过 |
| 026订阅包装 | .7仍有原生浅克隆提前求值deferTerminalDelivery的问题，已移植dev已有getter透传并独立静态复审；严格绑定原formal input，保持原callback/最终准入/受保护执行，属于既有026缺口修复 | raw/final真实订阅各7/7通过，含普通与structured流、protected run、无callback及移除getter负控；旧shape拒绝/零写与幂等纳入C严格矩阵通过 |

DB的Identity、UpgradeRuntime和UpgradeSource均在运行时recipe中，026也改变patch输入；
因此C曾从锁定pristine执行完整pipeline，没有沿用A/B的manifest。
C实际已完成33项补丁核验、严格矩阵、完整13段module gate及Electron恢复；完整npm test
未执行即转入后续基线，现由E重新验证。依赖准备期间未启动测试；root完成Node ABI137
重建并验证后才运行以下source批次，未借此启动Gateway或重建运行时。
新增产品入口或原生权限不是本次合并目标，实际企业模型/桌面/安装包限制仍保留。

C完整统一门禁已于2026-10-26 14:54:58结束：`dev-rebase/module-contracts-c.log`
含全部13步骤及最终passed footer，协作五子步exit0；`module-gate-state-c.json`
记录Node准备/实际DB验证、完整gate、产物身份复核及Electron恢复全部0。
该结果仅绑定上述1d3d217a1基线与C，验证期间dev后续提交需另行组合验证。

026实现与用例复审已确认：pristine clone恰为两属性，current形态恰为三属性且getter
转发原始input，每次读取保留同一attempt admission；递归params、常量、值属性、重复或
缺失getter和已标记的旧revision均拒绝，不在旧产物上补修。新.7真实订阅用例固定实际
`builtin-openclaw-Ci5YBsOb.mjs`与pristine SHA，动态核对text helper import/export alias，
执行原生订阅、消息/lifecycle handler、stream state及reply delivery，并以只移除getter
的内存负控重现旧buffering；构建使用write:false，并给native owner、text helper和bundle
设置输入哈希结束不变断言。model accounting、未使用的工具/
错误协作函数及session/event producer为测试替身，不宣称真实模型或Gateway transport通过。
新增.6历史订阅测试另有版本与SDK根准入，不默认借用C的依赖图。

C已从锁定pristine完整重建，33项补丁核验通过，冻结为manifest
`eda11a20c3c4d43187fbf5e92818367e2de221a39f04e1d9d0b0bf7a9f56900d`、recipe
`5ad1d32fc9172872daf88266c2d291891f848635b2439fddbb104e3d0dd1c86a`、patch set
`b39e45d846759b03670f0d699b05f17cf1bbadc1fb620395466315061405defa`、bundle
`d7a071eaa1fbfc576eb55b07f8ff528084ad3076a42f3b59412c5ee4f0310533`。
`dev-rebase/target-validation-result-c.json`与实际日志/JSON独立核对：严格矩阵43文件、
1,073项通过、1项raw/frozen互斥跳过、零失败，158.27秒；该raw publication另以原包
单项通过补验。raw订阅7项与实际SDK单项也通过；后两次按名称过滤的24/56项未选用例
不计为已执行。C严格矩阵中的final订阅7项和原生Goal组合5项均实际通过、零跳过。
三阶段各176个输入（80个raw owner及96个冻结owner/support/身份文件）前后SHA逐项相同，
独立再次读取当前文件仍匹配；这些测试未改写C或原包。

独立只读核对`dev-rebase/plugin-C-resource-audit.json`：357个源资源输入保持、退休说明
负扫零命中；两份SKILL source/final均为正规文件且字节相同，creator为30,705字节/
`7efc509a7387cf66bebb3b5224797dcee8d974f5840fab86c2b5580c6ae163d5`，router为
5,704字节/`64ed6ec0dce9e23d3b611bd333b21f57f3505e8204b22fcc4cd1866581f09968`。
router在C为CRLF，不能沿用B的LF字节数与hash。ASAR的12,524项无目标技能或陈旧说明
shadow，85项OpenAI来源、实际入口/两个worker及静态技能发现链均绑定C；这不证明
实际SDK注册、live技能发现、外部CLI或真实模型行为，仍以本轮完整gate及实机验收为准。

C首轮统一入口的前12段均完成，最后协作段的9文件源码子步骤为207通过、2失败；
完整入口exit1，Electron恢复exit0，原始日志/state保留为
`dev-rebase/module-contracts-c-attempt-1.log`与`module-gate-state-c-attempt-1.json`。
失败源于dev新增create前只读readiness检查后，旧测试预先prepare已经消耗一次describe，
其固定index1事件未在send阶段触发。只修测试：相对prepare后的read基线触发恰一次事件，
精确断言BeforePreparation两次describe均先于后续显式prepare，随后readiness/create、
native row/inspect/BeforeRegistration/register各阶段保持。每次显式prepare仍单次create，
没有将后续readiness当作重观察；其他17项身份/事件/unknown负控未改动且事件仍有效。
插件agent独立复审该修正，四文件聚焦复验为160通过、零失败/跳过，2.74秒，证据为
`dev-rebase/targeted-event-retry-focused.*`；包含19项事件重读、70项targeted status、
36项storage wait及35项initial dispatch，后者仍明确拒绝重试已发出的未知create。
实际Node ABI137内存DB验证成功；修改后recipe、manifest与bundle仍逐字节匹配上述C。

首轮canonical准备的五组已独立核对`probe-vzBxkS/result.json`：passed/cleanClose均true，
225,552毫秒，绑定C身份。探针精确保留`nativeInspect`三次后`nativeVerify`的首次lease
快路径断言，已持久proof不启动worker/备份或再次fleet扫描；物理复制/替换不能借原receipt，
坏备份与超过原生5秒gate的迟到commit仍拒绝。原生失败子进程属于这两项负控，不计产品
成功。此处只记已完成分项，不把首轮前12段与单独协作复验拼成完整统一gate通过。

随后协作聚焦入口在Main原生探针再次因同类旧前置假设失败：延迟create事件的transport
在prepare开始即拦截同key的首个describe，dev新增的precreate readiness读因而等待尚未
执行的create。失败记录保留为`dev-rebase/collaboration-focused-c-attempt-1.log`与
`main-send-admission/probe-DgwUCo`，verified:false/cleanClose:true，不计通过。
仅修该harness的阶段：preparing继续捕获真实native frame，但不等待/消费/投递；成功
prepare并核key/SID后才arm admission，随后真实point-reader响应中核同SID和gate owner，
仍投递原始收到的对象、核整个frame hash与reader token退役。原10秒等待与所有终态/
身份负控未变。其他三个协作native探针经两个agent逐段核对，无同类首读计数假设。

修正后以C随包Node独立执行Main探针exit0，165.253秒，证据为
`dev-rebase/main-send-admission-focused-c.{log,run.json}`及`probe-IHMwql/result.json`。
六组完成，整体verified/cleanClose均true：原有普通history、main真实Team注册及结算后释放、custom
source分别精确重观察两次、generation/client变化单次读取后仍unknown、错误SID零mutation；
共5次loopback合成模型请求，原生Gateway退出code0/signal:null并joined。
126份metafile源码SHA逐项重算匹配，manifest/recipe/patch/bundle与C相同，assembly为
`e8d143d23606b1d4597a18f63ab4fdc62d94f47ec03af386acd057527acf7e7c`。
未执行可选`--baseline-source`独立旧reader路径，不把其可运行性当作本轮实跑证据；
该Main单项通过也不替代剩余三个native探针或完整13段统一入口。

Main/DB/config source聚焦：20文件、1,012项通过，零失败/跳过，228.68秒；命令使用
Vitest、最多2workers及30秒test/60秒hook预算，日志/JSON为
`dev-rebase/main-db-config-focused.*`。覆盖ConfigSync完整/最小/认证、配置发布协调、
optional tools、decision/default model、storage preparation、native initial dispatch、
session snapshot/targeted状态、adapter models、Goal coordinator/adapter与工具超时11项，
以及DB identity/UpgradeRuntime和startup routing/launch。修正一处新合并负控：错误包名
使用正确的contract版本，使name成为唯一损坏；轻量routing的显式.6正控继续保留。
这些是应用源码与受控依赖回归，不能替代C的真实DB/ASAR/原生协议和最终产物准入。

插件 agent 对合并后的 Renderer/插件接缝另作独立复核：dev 的按需目录/分页、
历史准备与 focus 代次保护、模型发送捕获、MCP transport 延迟加载和浏览器发现后
独立连接释放均保留；Cowork 冲突保留 session-read 门禁及 model 的
origin-closed/closed/replaced 三态负控，LF 消费规范与资源模板字节也未丢失。
外部 MCP 在动态加载后重核 lease/权限/native incarnation；浏览器 hello/ensure
保持同管道，成功和失败均释放，开发与打包 native-host 命名同步保留。

2026-10-26 在上述新 worktree 本地执行四批源码定向回归，日志记录 HEAD
`50bad0a679331a201c968e31ce0dfa1f35dfeaf5`，每批最多两个 worker，清除旧运行时
环境变量。共 **39 文件、595 项通过，零失败、零跳过**；证据均在本 worktree 的
`build/upgrade-audit/v2026.10.7/`，不是 A/B 日志的重命名。

| 合并源码定向范围 | 结果 | 日志与 JSON |
| --- | --- | --- |
| Cowork 加载/目录/分页/搜索/focus、Team 历史入口及角色 LF/AgentManager | 13 文件、210 项通过，含 Cowork 54 项 | `rebase-renderer-state.{log,json}` |
| 原生准备拒绝后的历史只读重试、换代/重连、主/Team/Swarm/子会话历史、模型发送与首页 MCP 连接 | 11 文件、177 项通过 | `rebase-renderer-history.{log,json}` |
| 启动 UI/资源、外部 MCP 延迟加载与真实隔离 stdio、浏览器发现释放/native-host 命名和 payload/package 契约 | 11 文件、140 项通过 | `rebase-plugin-startup.{log,json}` |
| 清空 decision 模型的 Renderer 配置、配置转移及提交计时 | 4 文件、68 项通过 | `rebase-renderer-models.{log,json}` |

四批未启动 Gateway、切换 ABI 或加载 better-sqlite3。它们不证明 C 的实际 SDK
registration/扩展 loader 或最终原生图通过；它们后来由C完整门禁独立执行，不能从这些
source批次推导通过，亦不能作为E的通过证据。
企业内网模型、断公网安装版冷启动与真实桌面 UI 仍需后续实机验收，不外推历史 B。

## A/B原实施树的升级与验证历史

本轮以锁定源码及 pristine npm 发布包对照生产调用方。已发现并适配新原生
`tool_execution` 超时阶段；启动数据库的 18 个精确 owner 和当前原生探针重新绑定
10.7 发布包。未增加运行时补丁、旧协议兼容分支、权限或 transcript 缓存。
第三轮已在冻结产物 A 上完整通过13段统一module gate，协作五个子步也全部exit0。
随后静态扫出两份随包技能仍含不适用的发布/路由说明，已按当前原生权限语义修正；
新 registry strategy 触发从 pristine 重建产物 B，已完成冻结、33项补丁核验及外层资源审计；
B 已以同一次统一入口通过13段 module gate，协作五子步也全部exit0；随后完整测试
16,989项通过、822项跳过、零失败，并恢复验证 Electron ABI 146。
本报告分别保留 A 与 B 的实际执行记录。
真实企业模型、完整桌面UI与安装包的未验收范围继续保留。

## 基线与方法

- 应用基线：`62342c478c7c55645c892094cf668c7ea7141fa8`。
- 实施 worktree：`E:/workspace/worktrees/openclaw-2026-10-7/JustDo`，分支
  `codex/openclaw-2026-10-7`；主目录现有工作未混入本次升级。
- 上游提交：`v2026.10.6^{commit}` = `fe06181dc5ecc01cf8904abbfc26925925efefbc` →
  `v2026.10.7^{commit}` = `157d8c2bc3ea2fa183afdc11088e69690bf8e64e`。
  10.7 是 annotated tag，`5c101ce5a0637df375c5f6ae49d44d0d27cc26b1` 是 tag 对象，
  不把它误记为源码 commit。统一 gate 要求目标源码 HEAD 精确匹配且无 tracked 改动。
- Windows x64；开发 Node `v24.22.1`。目标包要求
  `>=24.22.1 <25 || >=26.12.1`，随包 Node 仍取仓库锁定的 24.22.1。
- 阅读 `docs/upgrade-checklist/` 全部五份文件、功能索引及相关架构/功能契约，
  对照上游 `CHANGELOG/2026.10.7.md` 和实际 `v2026.10.6..v2026.10.7` 差异。
- 本轮字符串索引扫描 `src/` 与 `plugins/extensions/` 的 1,579 个非测试代码文件，
  得到 146 种指定原生前缀引用。它包含配置键、事件与文件名，**不是 RPC 数量**。
  另追踪方法常量、`skills.workshop.${operation}` 动态派发、插件注册与 CLI/HTTP 接缝。
- 对照 schema **以及实际 handler/事件 producer**。目标公共 protocol 生产差异只有
  `client-info.ts`、`schema/ui-command.ts`、`schema/worker-admission.ts`；未变 schema
  不能证明内部执行行为未变，恢复、compaction、queue、cron、loader 和 SQLite owner
  的变化单独核对。SDK `src/plugin-sdk/` 无生产差异。
- 最终静态复审涵盖全部 11 份 Main/shared/Renderer 生产差异，以及新增 Goal/LF 与
  会话加载用例。除诊断枚举、权威 owner 绑定、目标版本和已有提示外，没有新增 IPC、
  执行/权限分支或 native-support 改动。工具超时保持自动条件后继，未增加人工门槛。
- B 构建期间再次只读检查应用、数据库、module gate 及其探针差异：目标版本绑定
  不改成范围接纳，DB schema 来源集合和18角色清单保持；当前目标的身份损坏、
  未结算、未知发送与重复终态负控仍在。仅历史10.4/10.6依赖图不再借用默认当前
  产物；显式错误历史路径/版本仍失败，当前10.7强制矩阵和统一gate不继承该跳过。

发布包 integrity、最终 manifest/build recipe、补丁和运行时冻结身份见
[验证记录](validation.md)。本报告区分源码审计、真实原生 owner、应用模拟回归与实机验收；
不将历史 10.6 结果或仅 loader 注册成功作为本版业务通过记录。
下文未明确注明 B 的既有产物实跑均绑定 A：bundle SHA-256
`41c8831fe1e5904c88ab04edaabc8c97fa0868bb65b27e4699989a16e2496e56`、recipe SHA-256
`35e29c1065fcdc3f3a1f0880c837104dbbc287af85b6eb71a22e388000b28092`。
B 已冻结为 manifest SHA-256
`cf119682a87f69a8a16b3cd0c41b6113c020edaad1941b4d764c40f972211260`、recipe SHA-256
`94db94168144adc09c83f9f1cf44a430db75e0426210728ef4c19897a696cbec`。
独立只读重算 manifest、bundle、ASAR、package、npm-shrinkwrap 与 Node manifest 六份
实际文件，均匹配 `final-artifact-identity.json`；后五者及 patch set 与 A 一致。
不同 manifest/recipe 和外层资源仍须分别记录，不能由相同 core bytes 推导 B 的实跑通过。

## 实质变化与适配

### 工具执行超时

上游 `packages/gateway-protocol/src/schema/worker-admission.ts` 新增
`timeoutPhase: 'tool_execution'`；`packages/normalization-core/src/agent-run-terminal-outcome.ts`
将其归为 `hard_timeout`。`src/agents/agent-run-terminal-outcome.ts` 从真实 attempt phase
生成该事实。`src/gateway/session-lifecycle-state.ts` 将会话投影为 `interrupted`，保留
`safeToolsRequired` 专用恢复标记；这不表示工具副作用已回滚或可以重复执行。

应用原先诊断闭合枚举会丢弃该阶段。现将它贯穿
`shared/cowork/diagnostics/sessionDiagnostics.ts`、Main 原生事件投影、Renderer 说明、
复制摘要与 ZIP；中英文提示重复操作前核对实际状态。
`exportSummary.ts` 复用共享枚举，避免导出保留另一份过时白名单。
未知 phase 仍被拒绝或投影为 `unknown`，不泄露任意字符串。
只有原生明确提供的 `executionSettled:true` 能确认整轮结算，阶段本身不产生此事实。
现行契约同步到[会话诊断](../../features/chat/session-diagnostics.md)。

新增真实目标契约用例加载目标 worker TypeBox schema 与 normalization owner：
合法工具超时通过 schema 且分类为 timeout，未知 phase 被拒绝；再经过真实应用投影
检查新阶段保留、缺失 settlement 不被补造。另有 parser、中文/英文 ZIP 和 Renderer
展开说明回归。没有模拟实际工具副作用。

Goal 自动续跑继续保留：`runtimeGatewayEvents.forwardGoalEvent` 传递原生阶段与
`executionSettled === true`，`GoalEventAdmission.admit` 核对精确 SID/run/key 与单调
原生序列；`processLifecycle` 只有整轮结算后才可进入 error/aborted 退避。
`retry` 和 `dispatchContinuation` 准备权限并重读当前 Goal/SID/revision，创建新 run，
携带精确 `goalContinuation` 前驱条件；原生 031 仍在最终接纳处核对前驱与回交 owner。
`interrupted` 不新增人工继续门槛；后继提示明确先核对权威状态与已有工具结果，不盲目
重复可能有副作用的调用。普通 Goal 后继不读取专用恢复的 `safeToolsRequired`，也不传
`forceRestartSafeTools`，不能据原生专用恢复配置宣称它自动只读。真实模型如何核对未知
工具副作用仍未验收。

独立 co-located `goalContinuationCoordinator.toolTimeout.test.ts` 接入真实事件准入，
验证 .7 工具超时精确结算后自动创建新条件后继；未结算、旧 SID/run/序列、重复终态
不重复派发，已发送后继的 ACK 丢失保留同一未知身份。冷恢复只接受精确结算前驱，
不能从 `interrupted` 或空闲投影独立推导授权。Gateway describe/agent 和权限准备使用
受控替身，因此这证明 Main 协调与真实事件准入，不是实际原生 handler 接纳或真实模型
执行证据。插件 agent 与补丁 agent 已分别独立交叉审查该窄提示和正反向用例，无阻断发现。

另已独立复审并核对 A 的 `goal-tool-timeout-native-final.log`：5/5 通过。
该组合用例执行实际发布包的完整 lifecycle persist/derive 函数、原生 outcome/recovery
imports、lifecycle lock、最终 support 与 accepted-writer 接缝，只替换存储及 Gateway I/O。
已结算工具超时生成 interrupted/safeToolsRequired 和精确前驱回执，再接纳不同 UUID 的
automatic 后继；false/缺失 settlement 与旧 SID 不产生前驱或 acceptance。第二次终态
特意省略 expected-writer 前置条件，实际走到10.7 duplicate-terminal guard 并断言空写；
同 candidate 重复接纳不增加 count。这补充真实原生算法组合证据，仍不证明模型核对
副作用、实际远程工具或完整 Gateway Goal 执行。B 的严格42文件矩阵也已重新执行同一
`goal-tool-timeout-native.test.ts`，5/5通过；证据为 `patch-tests-strict-b.log/json` 和
`target-validation-result-b.json.nativeTimeoutComposition`，不借用 A 的 focused 日志。

### 启动数据库与当前探针

10.7 package 的 schema 仍为 shared/state 20、agent 25；维护合同继续只接纳
state20、agent24/25，缺失数据库仍走既有初始化。上游变化包括拒绝打开时的 Worker lease
收尾、物理文件身份丢失时退休 owner、自定义 session store 候选按 agent 过滤，以及
runtime 对可隔离 agent 的 refusal 投影。应用维护检查仍显式拒绝非空
`agentRefusals`、未知 inventory 与未完成发布；未放宽来源范围或写入本地迁移 SQL。

`src/main/startup/upgrade/nativeDatabaseContract.json` 的 18 个角色按目标 pristine 发布包
逐项核对唯一顶层 declaration、export alias 和 SHA-256 后重新生成。
`native-database-upgrade.native-probe.mjs`、`native-canonical-preparation.native-probe.mjs`
的 12 种实际被调用 symbol owner 同样重绑。完整文件、ASAR 与 manifest 验证仍由原 gate
执行；不通过仅改版本号或修改旧运行时的 manifest 接纳旧产物。
ignored 生成证据为 `build/upgrade-audit/v2026.10.7/native-database-contract-owners.json`
和 `native-probe-bindings.json`。

当前 gate/probe 的目标版本改为严格读取根 `package.json.openclaw.version`，包括
management、config/legacy、targeted session status、shutdown budget、真实 Electron
identity、数据库维护、canonical 准备、Workspace readiness 和 Team 首次发送。
旧版本升级策略 fixture 保留其原场景。`wire/v2026_10_6.ts` 及 config sanitizer 保留
既有入口和符号，因为其协议在 10.7 没有变化；实际错误版本及目标注释更新为 10.7。

### Windows 角色草稿换行与既有后台读取

`assistantTranslations.ts` 仅在消费 raw 角色模板时将 CRLF/CR 统一为 LF，匹配
textarea 的换行语义；原模板 Markdown、原生角色文件和 runtime recipe 均不变。
新增 LF/CRLF/CR 的 zh/en 消费用例，原六种职责、两种语言的完整基线断言继续保留。
这修复 Windows checkout 下的草稿比较差异，不变更角色权限或保存流程。

`coworkService.ts` 在应用基线已经先选中会话、后台读取模型元数据，本轮没有修改
该生产逻辑。测试将 session read 取消与 model read 晚到分开：来源 UI 关闭但目标仍当前
时采用有效结果，关闭/替换目标时拒绝晚到结果且不污染旧模型映射。独立复审发现的
spy 跨参数用例复用已通过恢复 mocks、核对单次调用和等待本例后台 Promise 修正；
没有用放松生产身份条件来修测试。

### 原生变化，保留原生实现

- `agent-core/agent-stream-response.ts` 仅在真实可用工具包含 `sessions_yield` 时启用异步
  tool execution，防止 cron 在工具结果前作答。空工具集合现在表示无工具，不再表示未知。
  正文/工具流消费者不自行调度或恢复这些操作。
- recovery 对 bodyless length stop、媒体回答及超大 child completion 做原生修复；
  compaction 的 `requestFromEntryId` 和 request budget 保留当前请求边界。
  followup drain 退出旧 plugin/model generation 后重新准入，原 Gateway caller 仍保留。
- session lifecycle 拒绝重复 terminal 复活已经清理的 recovery；delegated sender 权限丢失
  且无其他 custody 时原生只退休该输入。应用不替代此结果或据最新消息重放发送。
- `models-list-result.owner.ts` 固定一次 runtime/source 配置对；晚附加 profile 准备原生
  operator access。现有认证 scope/generation 和请求级凭据检查保持。
- loader 的 generation capture、private-registry provider-policy cache，以及 inspection
  retained registration/disposer custody 转移由原生修复。没有公开 SDK 签名变化。
- MCP loopback grant保留本次CLI run的配置工具；native request authority在等待catalog或
  重连后、实际server I/O前重查。initialize的server instructions仅来自仍获准列出的工具。
  应用不复制grant、工具实例或补造授权。
- memory-core移除standing-intent factory的owner预筛，但`security/dangerous-tools.ts`
  将`intent`纳入统一owner-only denylist：`senderIsOwner !== true`（包括`undefined`）均拒绝。
  `session-portal-target.ts`使用该函数，agent-tools将deny透传至插件工具及message policy。
  这是原生定义与权限准入的集中处理，不能解释为放开非owner调用。
  新`agent-tools.turn-authority.ts`未发现生产调用，不将其定义当作已接入授权层的证据。
- 新 `ui-agent-github-settings` capability / `agent-github-settings` command 未接入产品，
  不广告此 capability；新原生功能不自动成为产品入口或权限。

### 随包技能的当前权限与发布说明

最终文本复审覆盖 `plugins/skills/` 与扩展携带的实际技能资源。`skill-creator`
原有四处在线发布说明仍指向待审核 proposal/人工 apply，但目标
`skill-workshop-tool.ts` 的普通 Workshop 已即时变更、保存版本并提供 archive/restore；
`skills-retired.ts` 对旧 `skills.proposals.*` 固定拒绝。这一退休行为在 10.6 已存在，
不能把本轮文本修正描述为 10.7 才新增的即时写入权限。

现按本轮实际 `skill_workshop` schema、现有授权与原生写入回执描述在线修改，
先读当前技能，不直接编辑安装目录；仓库自有源文件仍按请求原位编辑与审查。
普通 Workshop 的即时版本与可选个人库能力明确区分：个人库使用原生返回的 skill ID，
update 携带 read 返回的 expected revision；只发布用户请求的变更，`proposal_content`
是版本正文，个人草稿不受支持。个人库发布影响新会话，不自动激活当前会话，
activate/share/transfer 仍依实际 schema、明确意图与权限。未引入额外人工 apply 门槛。

同时核对真实 10.7 delta：`createConfiguredSkillWorkshopTool` 将 run 的 `sandboxed`
传入 `createLibrarySkillWorkshopTool`，workspace-default 分支交给
`capability.assertWorkspaceCurrent({ sandboxed })` 复核；原生 source execution guard
在 await 前捕获并于实际文件修改处重新检查。应用不替代 generation、sandbox、
read-before-edit 或原生写入 owner，也不通过技能正文授予能力。

ACPX 实际分发的 `acp-router` 原先广告未注册的 native Codex harness、上游别名表、
运行时 npm 安装/重启和失败后 direct fallback。现只使用产品当前配置且启用的目录
与实际 native schema，保留启动、继续、状态、取消和清理；未知结果保留原身份核对，
不重放输入或据超时创建替代会话。显式 direct 请求仍须证明现有命令、认证、权限与
生命周期归属相同，不由上游别名、ambient 配置或 package URL 生成绕行命令。

两技能、ACPX 来源说明及 owning docs 已独立交叉审查；`builtin-skills.json` 唯一新差异
是 skill-creator 的 strategy 改为 `preserve-immediate-workshop-adaptation`，schema 2、
reviewedRevision、技能身份与开关未改。registry 属于 build recipe，B 已从 pristine
完整重建。`plugin-B-resource-audit.json` 绑定上述 B 身份；独立逐字节复核 source/final：
skill-creator 为30,705 bytes、SHA-256
`7efc509a7387cf66bebb3b5224797dcee8d974f5840fab86c2b5580c6ae163d5`，acp-router 为
5,609 bytes、SHA-256 `2a9d74399131cf553c87508e775aa4c566f80a1f821c86a3a0da9777624cd792`。
审计记录357个技能/支持资源的过时指令负扫描零命中、ASAR 12,524条记录无目标技能副本
或旧说明。Main环境变量→原生resolver→plugin manifest.skills的链路属于静态证据，
没有以此宣称 B 的 live skill discovery 或模型执行；B 的统一 gate 通过另有完整实跑记录。

## 逐模块覆盖矩阵

“源码无需适配”仅说明已比较的生产接口未要求调用方变更；“未验证”明确保留对应的
最终产物/实机场景。统一 gate 的最终实跑结果由[验证记录](validation.md)提供。

| 模块 | 上游证据与产品消费者 | 处置、正反向验证与当前边界 |
| --- | --- | --- |
| Gateway 连接/认证/roles/scopes/caps/generation/订阅/错误 | `connect-user-profile.ts` 晚绑定 access 修复；`client-info.ts` 新 GitHub cap；Main gateway connection/client 与 Renderer gateway | 源码无需适配；不声明新cap，原换代规则保留。dev/bundled隔离真实Gateway技能探针均完成连接、执行与重启；多窗口及企业认证实机未验证 |
| 发送/历史/完整消息/Thinking/Content/Tool/分页/重连 | chat schemas/handlers无差异；agent-core异步工具、length/媒体回复恢复修复；`runtimeHistory`、`runtimePendingHistory`、chat controller/reducer | protocol与新阶段已验证；真实Renderer controller/wire七组覆盖首次/同会话后继/重连/初始派发、错身份/断连拒绝、ACK丢失不重放和无全局list。无DOM/React，真实模型交错、长参数与UI恢复未验 |
| sessions create/describe/list/patch/reset/fork/delete | 原请求schema/handlers保持；`session-reset-service.ts` 仅允许原生 main restart tombstone reset，lifecycle增加tool timeout投影 | 定向真实 descendant function 与wire已验证；create未知结果不重放、fork/删除实机未验证 |
| 助手/角色文件 | agents公开协议无差异；产品 `agents.files`、固定role workspace、软删除不调用agents.delete | 源码无需适配；角色冲突/切换与历史保留的最终产物未验证 |
| whole-run/subagent/Goal/停止/审批/Plan/问题 | terminal新tool_execution，native recovery/duplicate-terminal修复；Goal ingress无生产delta；Main execution/Goal coordinators | 新超时stage真实schema+normalization、应用诊断及真实事件准入11项自动续跑/身份负控通过；A/B的实际native lifecycle→conditional acceptance组合各5项通过，storage/IO受控。保留新条件后继，不重放旧send；真实模型工具副作用核对、完整Gateway Goal执行和审批UI未验证 |
| 压缩/预算/摘要 | `compaction-runtime.ts`、`agent-session-compaction.ts`、agent-core compaction增加requestFromEntryId/预算/summary保留 | 源码无需应用适配，022保留；手动/自动/恢复压缩、准备取消、后继SID实机未验证 |
| Agent Team协作/讨论/holding | sessions/SDK保持；child completion总预算160,000字符；followup generation重新准入 | B真实host/native五组通过：ensure Requested/Resolve、既有intent不重建、unknown拒绝变更、成员直发和错身份负控、群聊两参与者精确终态/历史及重复请求不派发；无全局list。模型自主组队、实际UI、禁用/重启组合仍未验 |
| Swarm DAG/batch/并发/回执/清理 | SDK/managed run公开形态保持，原生恢复与child结果预算变化；独立plugin owner | B真实host/native六组通过：主会话实际start tool、运行节点仅保存note且拒绝继续、失败节点同SID新run/ACK丢失核对、新key/SID重跑、完成节点只读、既有主会话状态查询；三个工作run均execution/cleanup settled且无全局list。长DAG/batch、停用与UI组合未验 |
| cron定时任务/结果收件箱 | cron schema/handlers无差异；`run-prepare/run-executor`将CLI binding facts固定为session稳定reply mode；异步工具修复 | 源码无需适配；CRUD/分页/ACK与完成区分保留。实际定时触发、owner/delivery与重启收件箱未验证 |
| Workboard | 原生extension仅package版本变更；真实handlers/SQLite adapter接口保持 | 源码无需适配；实际handler/SQLite组合用例在第二轮通过，耗时235.75秒；企业调度与UI未验证 |
| memory/search/artifacts/progressCard/摘要资源 | memory-core移除standing-intent factory的owner预筛；`dangerous-tools`统一在senderIsOwner不严格为true（含undefined）时deny intent，经session-portal-target/agent-tools传递；其余schema/handler保持 | 源码权限边界仍在，不接入未调用的turn-authority定义、不提升产品权限；原生注册与权限回归待验，真实embedding/index未验证 |
| skills inventory/启停/导入/Workshop | schema/management handler不变；原生library workspace wrapper新增run sandbox复核，仍由原生authoring owner持有；skill-creator修正陈旧proposal说明 | A的dev/bundled Gateway各20项通过；B的management契约和实际Workshop文件/版本/SQLite七项经统一gate重跑通过。B新文本资源字节及静态发现链已审，尚无新文本live发现/模型编排证明；真实模型主动发现/学习与安装包未验证 |
| extension库存/安装/启停/卸载/审查/required/optional | loader/capture/inspection ownership修复，管理公开接口保持；保护由Main及原生共同执行 | 原生安装/保留策略更新/启停/卸载、旧review token拒绝扩大surface、package ownership和extension MCP四项业务探针通过，后两项direct重跑也通过；未知提交、Windows发布竞争及实际UI未验证 |
| 全部本地扩展SDK/hooks/workers/tools/Promise | `src/plugin-sdk/`无生产delta；13项逐一清单见下表 | A/B的实际native inspection loader均逐项确认13个扩展各一份loaded、关键service/provider/handler与无error诊断，且release完成；activate/runtimeSideEffects均false，不能代表服务激活或业务执行 |
| 模型/provider/auth/登录/内置模型/轮换 | `models-list-result.owner.ts`配置快照修复；OpenAI源仅package变更，credential wrapper保持 | source锁85项及独立端点配置已验证；真实JWT/内网模型、跨到期轮换、退出中旧任务拒绝未验证 |
| 图片/视频/实时及文件STT/TTS/embedding/decision | 上游OpenAI源码/manifest/workers与TypeSafe源码无差异；本地能力独立端点/凭据不变 | 替换/预编译/config及source/artifact组合通过，原生transcription真实隔离transport与连接状态重置通过；企业图片/视频/语音/embedding/decision服务与设备未验证 |
| MCP/MCP Apps/交互问题/Widget/draw.io/认证HTTP | 原生MCP bundle request context及grant工具归属/授权重查修复，App公开schema保持，未新增精确cancel/dispose API | extension MCP真实inventory、定向连接、资源与parent disable通过named/direct探针；保留原生TTL/授权及unknown取消。冷缓存断公网导出、实际App视图/ETag/多窗口未验证 |
| 浏览器/profile/配对/relay/介入/录制/side chat | `extensions/browser/chrome-extension`、browser extension源码无delta，cua-computer会话过期恢复为原生变化 | 原生Chrome基线无需替换；overlay源锁/实际Chrome/Native Messaging/CDP与四模式实机未验证 |
| Worktree list/remove/restore/gc | schema/handlers保持10.6异步job回执；产品仍只观察同一job ID | maintenance owner的queued/running/completed与failed同job回执、单次执行通过；scheduler/runGc受控、没有真实文件删除，中文路径/引用保护仍未验证 |
| terminal open/attach/input/resize/close | 原生terminal schema/handlers无差异；补丁020/021继续限定launch/terminate及展示 | 源码无需适配；不重开或重放未知输入，真实PTY/独立窗口未验证 |
| config get/patch/hash/secrets/reload/suspend/restart | config types/zod与公开RPC无生产delta，observation保存last-known-good配置修复 | 保留baseHash/loaded hash与optional state；Main配置投影、原生schema/legacy规则及生命周期策略3文件8用例通过，不以provider catchall证明CLI准入。真实企业登录/热重载组合未验 |
| 启动/history import/inspect/存储/诊断 | schema20/25保持、18owner重绑；Doctor retained-source settlement改认historical_transcript_deferred；新tool超时诊断 | 原生维护8组/cleanClose、实际Electron ASAR身份5组、Main workspace关联3组、canonical准备5组和SQLite退休18场景通过；JSONL用户恢复、真实用户数据与安装版仍未验证 |
| Agent CLI/ACP/app-server | 原生CLI MCP/sessions replay-safe修复，acpx仅版本/依赖metadata变化；acp-router修正为当前enabled catalog/native schema，不广告未注册harness或运行时安装/失败fallback | 无需宿主API适配；新技能文本及B实际资源字节/静态发现链已审，B的ACPX领域回归与随包Node合成协议fixture通过。外部客户端权限/取消/unknown结果及真实CLI多平台未验证 |
| 文件预览/工作区/窗口/托盘/更新/主题/偏好/设置导航 | 无直接原生RPC；间接依赖上述session/IPC、受控文件/HTTP和Main生命周期 | 上游API适配不适用；仍需产品build/测试与安装版UI回归，不把无直接调用当作实机通过 |

## 本地扩展逐项审计

下列13项均已在产物A、B的实际native inspection loader注册通过，未激活服务或执行
runtime side effects；逐行保留业务执行边界，不用注册成功替代完整功能验收。

| 扩展 | 具体接缝与处置 | 当前验证范围 |
| --- | --- | --- |
| runtime-services | registerProvider/Tool/GatewayMethod/Harness、transcript Promise、owned run/wait/cancel、prompt/finalize hooks；019/031仍需精确native owner | 实际loader及historyMessage注册通过；协作gate中的精确terminal、managed cleanup与无全局扫描通过，扩展全部hook业务和禁用组合未验 |
| agent-team | channel/reply dispatch Promise、before/after_tool_call、commit/whole-run、discussion/holding | 实际host ensure、成员直发、群聊、身份/unknown/重放负控五组通过；模型组队、实际UI及禁用重启收尾未验 |
| swarm-workflow | native hooks、managed run/describe/wait/cancel、trace/span、batch budget | 主会话/节点note/同会话继续/新会话重跑/ACK核对/精确cleanup六组通过；完整batch、长DAG与实际UI未验 |
| plan-mode | agent_turn_prepare、TrustedToolPolicy、extension state、PresentPlan/reset | 源码无需适配；真实审批及重启待验 |
| ask-user-question | signal-aware工具Promise、pending/resolve RPC、gatewayEvents | 源码无需适配；问题超时/关闭/迟到回复待验 |
| automation-permission | async evaluate、native entry读取、read-scope info RPC | 源码无需适配；原生权限未扩大，真实审批待验 |
| drawio | contextVersion2、prepared identity、dispatchGatewayMethod、native preview Promise | 源码无需适配；真实冷启动编辑/导出/视图释放待验 |
| widget-kit | board kind、真实show_widget、authenticated canvas.document.view及HTML | 源码无需适配；HTTP viewer/离线库/真实发送待验 |
| embedded-browser | contextVersion2、signal/identity、service与media Promise | 源码无需适配；实际guest/权限/取消待验 |
| stt-local-cli | 工具factory/execute(signal)、Sherpa子进程/真实workspace权限 | 源码无需适配；模型及麦克风实机待验 |
| openai | Provider/Embedding/Image/Video/Speech/RealtimeTranscription/MediaUnderstanding及两个worker | 85项provenance、配置/替换/预编译15测试、source/artifact与SDK组合27测试通过；实际loader注册及原生transcription隔离transport/重置通过。CLI derived inventory只确认入口和descriptor；企业媒体服务未验 |
| acpx | setup/catalog/backend/reply hooks、session handle/generation/lease Promise | 上游仅package变化；保留本地acpx0.19.5及既有实现，不混入上游workspace依赖；22文件148用例和随包Node合成ACP fixture通过，真实外部CLI/服务未验 |
| typesafe | decision provider、prepared secret、guardedFetch/release、contractVersion1 Promise | 上游仅package变化；保留本地显式端点及unsupported-input分类；12文件192用例通过，真实企业服务未验 |

Agent Team 的 `discussion-execution.ts` 中“locked 2026.10.6 SDK”是最初验证基线注释，
不是本轮遗漏接入。独立对照两 tag 的 `channel-inbound` 导出、`GroupThreadTurn.digest`、
group-thread/context 实现无差异；实际10.7 pristine 与 B 对应 SDK/context 字节一致，
插件 agent 另核对完整 dispatch group-thread section 相同。仍只识别原生精确 empty digest，
未知或缺失 digest 继续原生 dispatch；保留冻结源与已有权限边界，不为历史注释重构代码。

上游插件目录集合无增删；prune policy版本更新，未将未知插件自动带入发行版。
本地OpenAI的83个生产TS和package/manifest共85份来源逐项复核；协议源码/两个worker
无目标delta，保留内网配置隔离，不重新开放公网catalog/OAuth/RTC。
三个本地插件lockfile除root版本外依赖packages逐项保持。

## 补丁交叉审查

原生接口 agent 与补丁 agent 独立比较 005/019/022/031 后交叉讨论，均保留：

- 005：原生新增安全恢复/退休输入，但无应用host epoch。prior-app guard仍在原生恢复提交前；
  新工具超时已是interrupted，不把它伪造为先前仍运行或自动重放。
- 019：Worker拒绝打开和DB lease修复不提供plugin-owned whole-run/managed-tool cleanup证据。
- 022：compaction请求边界修复不提供完整operation-scoped准备取消及recovery lifecycle。
- 031：原生Goal ingress/acceptance无对应新能力，精确前驱结算、handoff与累计count仍需接缝。

其余逐补丁证据及删除条件由目标补丁总账维护。插件 agent 独立审查诊断实现，
确认共享闭合枚举、Main安全导出、Renderer与中英文说明一致，没有新增授权或正文缓存。
应用接口agent反向复审三项本地插件：85项来源hash、83生产TS完整覆盖、真正tag commit
及三份lock仅root版本变化均独立通过。005/019/022/031的新实现相对旧版只有版本marker
与精确产物owner路径变化；另外独立核对7个native import alias及compaction mutation
authority owner，均与pristine发布包一致。没有以此替代fresh bundle测试。
最终产物后的独立代码审查结果继续写入[验证记录](validation.md)。

## 本轮实际验证与未验收项

2026-10-25 至 2026-10-26，Node24.22.1，升级worktree：

| 已执行 | 结果与证明边界 |
| --- | --- |
| 两份随包技能、registry与owning docs静态复审 | 已直接核对目标普通Workshop/个人库schema、退休handler、run/source/sandbox权限与受管ACPX目录；无新增权限、人工apply或unknown重放 |
| B完整重建、冻结与资源只读核对 | pipeline完成，33项补丁独立验证通过；manifest/recipe为上述B身份。六份core文件SHA和两个SKILL source/final字节独立复核通过；357文件扫描与ASAR无shadow审计不等同live发现。以下未明确B的既有产物结果均为A |
| B插件领域、随包ACP与CLI inventory | 五份`plugin-B-*.log`均exit0且绑定上述B manifest/recipe/bundle；source/artifact OpenAI+shared SDK/external MCP/ACPX契约5文件27项、TypeSafe12文件192项、ACPX22文件148项通过。随包Node synthetic ACP fixture15.437秒通过；隔离CLI9.168秒确认唯一loaded外层OpenAI index、openai/video-openai及无旧wrapper。CLI仍是derived inventory，不替代native loader注册或真实企业服务；不据此声明B统一gate通过 |
| B完整统一module gate | `module-contracts-final-b.log`同一次完整调用恰好13步骤及成功footer，协作5子步均exit0/signal:null。Renderer/Team/Swarm为7/5/6组verified/cleanClose；218/32/12输入、57项assembly源码及两扩展输出SHA逐项重算匹配，assembly为`d177e9d3d19cbcd4f2d652ab030121d7c8f86914e78fdaf3270dbd213dc72d95`。B manifest/recipe/bundle与receipt一致；随后Electron ABI恢复exit0 |
| B原生工具超时与Goal条件接纳组合 | 严格42文件矩阵中的`goal-tool-timeout-native.test.ts` 5/5通过、零跳过；strict-b日志/JSON及`target-validation-result-b.json.nativeTimeoutComposition`一致，四scenario及duplicate-terminal空写均保留。没有另行B focused日志；storage/IO模拟与模型/持久性限制仍如上 |
| B完整npm test | 2026-10-26完成；`full-tests-final-b.log` console footer为1,231文件通过、22文件跳过（1,253），16,989项通过、822项跳过（17,811），零失败，986.22秒。JSON success:true及项数一致；其testResults把全跳过文件也标passed，文件细分采用console，不使用numTotalTestSuites。finally实际验证Electron42.7.0/ABI146；state为passed，module/full/恢复均exit0，完成时间00:09:57.984+08:00 |
| diagnostics adapter/exporter/Renderer、management真实目标schema及normalization、targeted session原生函数、wire、nativeDatabaseIdentity | 7文件127用例通过，零跳过；source明确为目标checkout，不启Gateway/不读取用户历史 |
| Goal工具超时自动续跑 | 新独立文件11用例通过：真实事件准入、late whole-settled timeout、新conditional successor、cold精确前驱及未结算/旧身份/重复终态/未知ACK负控；不启动Gateway，不冒充实际工具副作用核对 |
| A的原生工具超时与Goal条件接纳组合 | `goal-tool-timeout-native-final.log` 5/5通过，含必须选定当前图、精确settled正控和false/missing/旧SID三负控；真实persist/derive、原生imports/lock/support及accepted-writer接缝，storage/IO受控。重复终态走真实duplicate guard且空写、重复candidate不增加count；B独立结果另列 |
| 首次上述定向 | 2个新增export负控错误期望undefined；既有导出安全映射是unknown，修正测试断言后完整复验通过。未放松白名单 |
| OpenAI intranet config、native extension replacement、precompile | 插件agent执行3文件15用例通过；包括独立端点、旧入口完整替换、main/setup/policy/catalog/两worker及错版本拒绝 |
| 最终source/artifact OpenAI组合、内网/shared SDK/external MCP registration/ACPX契约；TypeSafe；ACPX | 插件agent执行日志分别为5文件27用例、12文件192用例、22文件148用例通过，已独立核对日志exit0；随包Node合成ACP upgrade fixture也exit0。日志为ignored的`plugin-domain-A.log`、`plugin-typesafe-sdk.log`、`plugin-acpx-sdk.log`与`plugin-acpx-protocol.log`，不替代真实企业服务 |
| 隔离profile随包Node CLI插件inventory | 唯一loaded插件为openai，来源精确指向最终外层`dist/extensions/openai/index.js`，provider为openai/video-openai，顶层diagnostics为空；registry明确为derived且提示尚无persisted registry。这是fresh profile的索引快照，不能代替真实runtime loader注册，证据为ignored的`plugin-cli-inventory.json` |
| 四项插件native业务探针与direct复验 | 安装/保留策略更新/启停/卸载、旧review token拒绝扩大能力面、多入口package ownership、extension MCP定向连接/资源/parent disable各一项实质named用例通过；后两项各一次direct重跑也通过，均使用随包Node和同一冻结身份。`--test`额外显示的runtime目录不能计为业务用例，日志为`plugin-native-*.log` |
| SQLite退休，开发Node与随包Node | 六组进程均exit0；两个raw锁阻塞负控、四个patched/final非阻塞正控、两套各六种生命周期，共18个major场景。lifecycle分别334.416/336.283秒，覆盖backup-update、rollback、deletion、error-close、exit/crash；证据为`sqlite-validation-result.json`及六组日志。使用node:sqlite、隔离合成DB，不证明安装版/实际用户数据迁移或Gateway关闭 |
| 技能发现与Code Mode状态，开发Node与随包Node | 两份独立profile各20项通过、各39次loopback合成模型请求；覆盖prompt省略后搜索、正文/完整read、禁用与read权限、跨cell/turn/session状态、失败/超限/取消不提交、Gateway干净关闭重启后保留、删除和显示历史隔离。已核对`probe-gGDmib`/`probe-eNEVJr`的result.json，均绑定同一bundle hash；不证明真实模型主动编排或企业模型效果 |
| 统一gate第二轮前12段的分项结果 | protocol正反51、Main config/schema/legacy/lifecycle三文件8、13扩展实际inspection loader、worktree受控回执、原生transcription真实隔离transport、Workshop文件/版本/SQLite七项、management/descendant两文件23、Workboard handler/SQLite一项均完成；源码严格绑定目标commit。完整入口最后协作段失败，不能把这些分项当成整体exit0 |
| 第三轮完整统一gate | 同一次入口13段全部完成并打印`All module contract gates passed.`；协作五子步全部exitCode0/signal:null，包括9文件209源码用例、Main原生发送、Renderer七组、Team五组、Swarm六组；后三者均verified/cleanClose。日志`module-contracts-final-retest.log`，随后Electron42.7.0/ABI146恢复并验证成功 |
| A完整npm test及未改动文件复验 | `full-tests-final.*`为16,988通过、Windows CIM两秒期限1项失败、822跳过；原样独立复验该5项文件全部通过。保留当时失败，不把复验拼成A的全量通过；最终B另有上述独立完整套件成功记录 |
| 严格新产物的存储与启动接缝 | 第二轮DB维护8组、实际Electron ASAR身份5组、Main workspace原生关联3组和canonical准备5组通过。DB/canonical均有cleanClose:true；涵盖备份/拒绝/lease/busy/事务回滚/IPC取消恢复、物理替换与迟到提交拒绝。Main workspace为实际resolver与原生correlation owner、受控响应，不宣称真实网络执行 |
| 18-role合同生成与12种probe symbol重绑 | 唯一实际声明/export和目标SHA已逐项检查；这是静态原包证据，不能代替runtime/ASAR/worker实跑 |
| 原包selected-owner verifier、六个改动probe语法检查、git diff --check | 均通过；原包18角色contract SHA-256为`81e0887f6971ccfc4f600b4e46f43eea33c4bc9341b802b2b6d4a6e6a08ac6fd`，允许原包尚无gateway.asar，不冒充安装资源验收 |

统一 gate 的首次运行在第 9 段数据库组合探针触发父进程 240 秒总预算。
原始证据 `probe-JYEiNi` 已连续创建 27 个顺序 native child，首个本地时间
21:37:03、最后一个 21:40:53，gate 在 21:40:57 超时；相邻 child 创建最大间隔
43.149 秒，另有实际 SQLite busy 负控在 5.491 秒报告锁竞争后继续执行。
探针完整流程包含 31 个 inspect/upgrade child，以及直接原生回滚、取消和恢复；
该证据表明截断发生时仍在推进，尚无最终 `result.json`，不将它记为数据库验证通过。
仅将这一整段总预算提高为 600 秒，保留原单次操作截止、身份/备份/拒绝断言和全部场景；
插件 agent 已独立复审该单行调整，无阻断发现。gate 脚本不属于 runtime recipe，
冻结指纹未变。完整重跑结果仍以[验证记录](validation.md)
为准；若新预算内仍失败，需根据具体阶段继续调查。

第二轮在新总预算内完成数据库组合探针及其后续三个启动/存储段，但最后协作段在
Renderer构建harness缺少真实`AGENTS.md?raw` loader时整体失败。此前该段的209项
源码契约及Main原生发送探针已完成，后者`verified:true/cleanClose:true`；这不是完整
协作链通过。测试harness现仅对file namespace中`.md`且suffix严格为`?raw`的模块读取
真实UTF-8，保留metafile逻辑query和真实资源hash；普通Markdown仍由默认loader拒绝，
没有mock角色模板/i18n或修改生产代码。独立编译微验证与随包Node `--prepare-only`
实际controller构造/218个输入hash均通过；prepare-only仅证明可构造，不提供发送行为证据。
该harness修复不属于runtime recipe；随后第三轮完整重跑统一入口取得单次整体成功，
没有将前12段与单独协作补跑拼接为统一gate的exit0。

独立最终复核确认日志包含恰好13个module步骤、成功footer及协作五步全部exit0；
Renderer/Team/Swarm的7/5/6组receipt均verified/cleanClose，分别218/32/12项输入
SHA逐项匹配当前源码，含真实raw角色模板。三份receipt的扩展assembly、两扩展输出、
manifest、bundle与当前recipe均匹配同一冻结身份。上游HEAD仍是目标peeled commit且
tracked干净。Swarm继续使用原SID和新run，重跑换key/SID，ACK丢失只有一次accepted
operation，三个工作run均有精确executionSettled和cleanupSettled；没有全局session扫描。

B完整套件中，本轮Main自动续跑11项、DB身份13项、Cowork会话加载54项和LF/CRLF/CR
消费端3项均实际通过。默认完整套件中的原生Goal组合四个环境依赖场景为skip，不能
冒充再执行了五项native算法；这四场景已经在显式选择B的严格矩阵中全部实际通过。
最终state与日志/JSON一致，当前manifest仍匹配冻结B；没有抹除A的CIM超时失败或
将822项跳过当作已执行。手工验收限制继续保留。

本次已完整执行的统一入口：

```powershell
node scripts/test/run-openclaw-module-contracts.cjs --runtime-dir <本次冻结产物绝对目录> --source-root E:/workspace/openclaw
```

A/B以上记录仅为历史。当前最终F已完成重建、冻结、严格矩阵、领域原生补验、同一次
完整13项gate及独立完整npm test，精确身份、计数与证据范围见本报告开头。
完整lint/build/Main编译/test的最终结果及
内网模型/JWT/图片/视频/语音/embedding/decision、Chrome/CDP、Electron工具UI、超过一小时任务、
安装包断公网冷启动与覆盖升级、JSONL恢复及其他平台的结果，均按[验证记录](validation.md)
的实际执行记录判断；本报告不预先声明这些验收完成。synthetic loopback、控制依赖、loader inspection
与应用模拟回归不能替代这些验收。
