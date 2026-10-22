# 工具调用格式纠正的具体错误反馈

> 第 1–17 节保留此前方案与产物证据；2026-10-20 发现 schema→坏 JSON 混合路径缺口，
> 已改为第 18 节的同一原生 loop 扩展。当前执行契约见引擎架构文档，真实模型纠正率仍待内网验收。

状态：隔离 worktree 已实施；第 16 节发现的子运行错误回传缺口已按第 17 节修复，全新产物 20/20 组 Gateway 假模型实测通过。真实内网模型纠正率和远端安装版仍待验收。

工作树：`E:/workspace/worktrees/tool-call-feedback/JustDo`，分支
`codex/tool-call-feedback`，基于 dev `85684f59000976915fc548e8894552c5615d6a93`。
不修改 dev，不纳入主工作树的其它进行中改动，不重写已有恢复能力的历史提交。

## 1. 目标和现状

当前纠正提示只说明“工具参数格式错误、整批未执行、按定义重新生成 JSON”。
对于 XML 参数、空参数、顶层数组、引号或转义错误，模型得到的说明相同。
本项增加可定位、受限的错误反馈，帮助模型纠正本次响应，保留原有恢复准入和两次额度。
效果属于待验证假设，不预先宣称某个成功率或已解决远端安装版节点故障。

锁定 `openclaw@2026.10.4` 的实际控制流：

1. `parseJsonObjectPreservingUnsafeIntegers` 保留大整数，但失败时返回 null，丢弃解析异常。
2. `finalizeTerminalToolCallArguments` 先验证全部调用，再统一赋值，不提前执行合法兄弟调用。
3. Completions finalizer 将缺少名称、空参数及解析失败归为同一句 error，并移除全部工具块。
4. 030 在这一拒绝点记录完整流和零派发证明；事实投影及策略位于 Runtime Services。
5. 原生 runner 在保留现有历史的条件下安排最多两次内部纠正请求。

因此不能只在 policy 中拼接 errorMessage，也不能从错误正文反推恢复授权。

## 2. 不变量与范围

- 仍限原生 OpenAI Completions 的可信初始候选、同一 runner、完整响应、整批零派发。
- 保留此前工具结算、嵌套回执、writer fence、会话 incarnation/generation、取消及累计排除。
- 两次格式额度与原生 RunRetryBudget 同时生效；不跨候选或 runner 重开额度。
- 不执行修补后的参数、不把 XML 转成 JSON、不补齐残缺命令、不重交原用户消息。
- 主聊天和原生 subagent 共用；不为 Swarm 另加重试、执行 RPC 或流程状态。
- 不扩大到 length、网络断流、普通工具执行错误、权限拒绝或 schema 校验失败。
- 新反馈不改变 `before_agent_finalize`、取消、等待、终态及 fallback 互斥契约。
- 无诊断或诊断不能信任时沿用当前通用提示；不因反馈生成失败增加请求或阻断结算。

## 3. 首期反馈合同

在现有 pre-dispatch rejection diagnostic 的 details 内增加可选的 `feedback`。
使用普通 JSON 数据，不增加 SDK 公共类型、配置、数据库或消息缓存。
反馈只由真正执行拒绝的原生 producer 生成，与现有证明同一条 diagnostic 传递。

| 字段 | 约束和含义 |
| --- | --- |
| version | 固定 1，未知版本只忽略反馈 |
| batchCallCount | 同一响应全部被拒绝的调用数；不能等同失败调用数 |
| issues | 最多 3 项，按同批调用位置稳定排列，不重复 |
| callIndex | 零起始索引，必须在 batchCallCount 内 |
| kind | 单项已确认的固定类别：missing_tool_name、empty_arguments、non_object_arguments、invalid_json、native_rejected |
| detail | 可选固定枚举，例如 xml_like_input、unterminated_string、invalid_escape、unexpected_token；不是任意错误字符串 |
| argumentChars | 原参数 UTF-16 长度，不暴露内容 |
| position | 仅有真实诊断位置时提供，UTF-16 坐标；没有就省略 |
| omitted | 反馈条目被预算省略时明确标记 |
| localization | 批次级 located 或 unlocalized；后者表示未能在预算内找到具体失败项 |

数量字段和位置均为非负安全整数，字段取白名单，不透传任意嵌套对象。
批次级未定位不得伪装为某个 callIndex 的 native_rejected；未扫描或未诊断不意味着该项有错。
单项数组只包含已证实有格式问题的调用，不能因为扫描预算不足而指责一个合法兄弟调用。
首期不包含 toolName、原始参数、解析异常原文或结构 preview。

## 4. 参数预览与敏感内容

首期不在 diagnostic、errorBody 或日志中复制原始参数、命令、文件正文和原始解析异常消息。
这些 diagnostic 可能进入原生审计，不能把“再发给同一个模型”当作可以写入日志的理由。

评审后首期完全省略原文和结构 preview。非法 JSON 不能可靠按字段脱敏；
仅掩去字母和数字也不够，标点、反斜杠和转义字符同样可能是字符串正文或凭据。
为了预览而再实现一套容错词法解析器，会增加范围而缺少已证实的纠正收益。

call.name 也来自模型，ASCII 标识和疑似凭据正则不能证明它可安全持久化。
首期只给出调用序号，不为显示名称增加传输/工具目录接线。后续若有当前请求定义中的
规范名称可精确匹配，才评估名称投影；不把普通模型文本升级为可信标签。

反馈仅包含固定枚举、数值和布尔状态，作为诊断数据序列化；固定指令独立生成。
这也避免把模型原文或伪角色分隔符借内部提示升级为指令。编码不替代授权与原生证据。

若对比实验表明这版诊断信息不足，
应另外评审同次模型请求范围的瞬态数据通道，不能先建立全局 WeakMap/run registry 或公开开关。
这项取舍意味着首期增强的是具体错误诊断，不声称已实现原始出错参数回传。

## 5. 分类和真实错误位置

可直接确认的原生前置条件优先：工具名缺失、参数缺失/空白；名称检查本身也必须有界。
名称原文绝不进入反馈。其余只在原生已经拒绝之后进行诊断分析，不能仅凭普通 JSON.parse
判断哪个调用失败：锁定原生 parser 会先规范化不安全整数，普通 JSON.parse 与它并不完全一致。

采用唯一的窄同步 parser adapter：030 从它原先调用的 AST 节点提取同一个
`finalizeTerminalToolCallArguments` 函数引用，并仅在拒绝闭包把引用传给纯辅助。
不得从 options、global 或插件注册表选择，不增加恢复、执行或结算 callback API。
辅助先检查预算，再新建单项 dummy `{ arguments: {}, partialArgs: raw }` 交给原生 validator；
不传原始 call，不保留函数、dummy、解析结果或异常对象，也不回写原始 arguments。
原生接受该项时立即跳过；只有明确捕获 `errorCode === 'malformed_tool_call_arguments'`
才认定该项失败，其他异常只留批次级 unlocalized 或丢弃反馈。

只有已确认原生拒绝的项，才考虑用原文 JSON.parse 提供更具体的固定分类和位置。
额外解析不产生可执行 arguments，不复制大整数 parser，也不修改原生允许集合。
原文含可能触发不安全整数预处理的数字形态时，保守只给 native_rejected，省略细因和位置；
可以使用有界的保守识别，例如任何连续 16 位以上十进制数字，允许误省略但不能误定位。
例 `{9007199254740993:0}` 是原生可接受的合法兄弟；
`{9007199254740993:0 "x":1}` 原生失败于缺逗号，原文 JSON.parse 却可能先报数字键，
因此 dummy 校验确认失败后，也不能直接把原文位置称为原生实际错误位置。
不把整个 SyntaxError.message 或堆栈复制到提示或日志，其中可能含原始输入。
只提取可证明的固定分类和数值位置；不能根据长度推定网络截断。

对超大参数不重新执行无界诊断扫描。拟定最多检查 16 个调用、总计 16 Ki UTF-16 参数字符，
超过预算的输入在 trim、正则、JSON.parse 或序列化前截停，只给批次级未定位/省略状态，
不为没有检查的调用制造失败项。返回问题最多 3 项，整体反馈最多 2 KiB，
最终附加提示最多 3 KiB；准确字节限制以序列化后的 UTF-8 计算，并保留合法代理对。
名称检查、dummy 校验、数字形态检查、额外解析共享新增扫描预算，不能各自再取得一份 16 Ki。
可按单项诊断的最坏扫描次数预扣；`.length` 读取不算全文扫描，不为诊断无限重扫。
预算是构建期常量，不增加用户设置。

## 6. 提示内容和整批语义

保留现有通用提示，再追加受限数据及少量固定纠正说明：

- 明确这次响应的整批工具调用都没有执行，包含其中原本合法的兄弟调用。
- 模型自行判断哪些操作仍需要，重新生成完整调用；不要只补发残缺字符串的尾部。
- 此前成功的工具结果继续有效，不重做已完成操作。
- 本次工具定义继续由原生请求链提供；不复制整套 schema 或历史进入反馈。
- 不为被拒绝调用伪造 tool-result 配对，不把错误数据变成可执行 tool-call。

示例语义：第 2 个调用的参数是标记文本，要求 JSON 对象；整个响应的 3 个调用均未派发。
模型需要重新评估这 3 个调用，而不是误认为前两个已完成。

反馈分类必须与当前已确认的拒绝观察对应；旧 run、旧 attempt 或重写后的 assistant 不借反馈获得准入。
诊断元数据只增强说明。原生零派发证明、当前 completed observation 和结算判断继续独立成立。
只从 `currentAttemptCompletedAssistant` 的唯一原生拒绝 diagnostic 投影反馈；
current assistant、transcript 和 errorMessage 不能作为备用反馈来源。
现有 SameObservation 不比较反馈，因此不扩展它去接受另一份反馈，也不依赖反馈取得身份结论。
反馈缺失、损坏、超限或辅助构造异常时只丢弃反馈，不能改变 rejected、excluded、claimed 或结算。

## 7. 所有权和最小补丁

| 位置 | 拟承担内容 |
| --- | --- |
| Runtime Services tool-call-recovery 纯模块 | 预算、白名单投影、分类辅助、反馈校验、固定提示拼装 |
| 现有 030 producer 接缝 | 在丢弃工具块前调用纯模块，附加同条原生拒绝 diagnostic；不改变整批验证顺序 |
| 现有 030 runner 接缝 | 将已验证的可选反馈交给原有策略，不增加异步等待或执行控制 |
| 030 support 审计 | 覆盖新增 producer 使用方的精确绑定、完整实现及无条件初始化 |
| 主工程通用构建证明 | 复用现有两文件 build recipe 和六文件 SDK artifact 合同，生产脚本不增加新枚举或扫描器 |

首期只复用现有 facts.mjs / policy.mjs，不另增反馈模块。facts 承担 producer 投影和 completed 反馈校验，
policy 将白名单数据映射为固定说明，不拼接任意原始字段。插件纯模块单测放在 `plugins/extensions/runtime-services/tests/`，
原生 producer/runner、bundle、归档及主/子入口的边界测试留在 `tests/openclaw/`。
不修改邻接 openclaw 源码、dev 工作树、Main、Renderer、Swarm 的生产行为。

原生 producer 是锁定 AI SDK 的 `openai-completions-transport-QYABn8Uz.mjs`，
与 runtime/dist 所有者位置不同。现有 nativeSupportImport 不能直接用于此 SDK 路径。
030 必须对已审计的 SDK target 与 runtime/dist/native-support 两个锚点计算准确相对导入
（当前形态是 `../../../../dist/native-support/tool-call-recovery-facts.mjs`），
不在 SDK 内复制第二份 support，也不增加 SDK 写入文件集合。
source pass 检查真正、唯一、完整且无 alias 的 ImportDeclaration；注释中的同名声明不能通过。
现有 bindSupport 的 includes 检查不足以证明这一新增 SDK 绑定，可在同函数局部收紧，
不扩展成通用新导入扫描框架。bundle 则增加这个 producer 的精确 lazy owner 无条件初始化审计。

不新增 patch 编号，不增加历史形态兼容。当前 030 为 637 行、审计预算 650 行，
复用现有模板、导出列表和入参行，新增可见接线初估 8–13 行，真实行数和编译验证前不承诺已经满足。
若无法维持预算，必须回到本方案说明必要范围，
不得悄悄抬高测试阈值或拆成多个补丁绕过预算。

## 8. 纠正效果验证

分开报告“诊断正确”“模型输入确实收到反馈”和“模型纠正成功”，不能用固定响应的假模型证明成功率。

1. 用确定性原始参数样本验证分类、位置及整批说明：XML、空串、顶层数组/标量、
   缺引号、缺逗号、非法转义、Unicode、大整数、超大 exec、多调用中间失败和多个失败。
   加入原生接受但普通 JSON.parse 拒绝的数字键，以及数字预处理发生在真实错误之前的例子；
   前者不得误报失败，后者不得给出误导性的原文细因/位置。
2. 用真实 SDK/SSE 与锁定 producer 确认新信息在删除工具块前产生，confirmed=0；
   通过真实 runner 读到这次反馈，模型请求中的已有工具结果不丢失，也不出现孤立 tool-result。
3. 复用现有 `swarm-workflow.native-smoke.cjs` 和 `plugin-owned-execution.native-smoke.cjs`
   的隔离 Gateway/loopback SSE fixture。分别走 chat.send、插件 runtime.subagent.run 和实际
   Swarm work/verify 节点，注入同批“合法+非法”的完整 SSE。观察下一次真实 HTTP 请求收到
   当次诊断、原生 run/session 不换、已有工具结果保留、首次整批零派发、纠正后每个副作用只一次。
   不用会话键命名替代真实入口；Swarm 提交 schema/计划校验另列，不混为格式恢复通过。
4. 用冻结旧/新两套构建和目标内网模型做条件纠正率配对实验。每个样本在全新合成会话中
   回放字节完全相同的首个拒绝 SSE，后续纠正请求才转发目标模型；这测量给定相同失败后的纠正率，
   不是自然初始失败率。两臂保持任务/工具/schema/历史/模型参数和预算相同，随机执行顺序，
   至少 30 对样本，按预定义的“语法正确+任务语义正确+副作用一次”指标分别记录首次和两次内成功、
   重复错误、tokens 和延迟。记录模型、构建指纹、随机条件及原始拒绝 fixture，不把波动当作确定提升。
5. 没有目标内网模型或远端安装包时，标为待验收，不调用其它公网模型替代并声称已经解决。

首期验收门槛：反馈分类准确、同次错误绑定正确、无副作用重复、失败不扩大权限；
只有实际对照结果支持时才写“提高纠正成功率”，否则只宣称提供了更具体诊断。

## 9. 恢复安全性回归

- 有效 JSON 中包含长整型、Unicode、Windows 路径、引号和反斜杠时，不改变既有执行参数或合法调用。
- 同批一个合法调用加一个非法调用，confirmed=0；此前写文件一次只执行一次。
- 恶意文本、角色分隔符、ASCII 形态凭据工具名、仅由标点组成的秘密参数、长输入和无效代理对
  不进入 diagnostic/日志或形成新的指令/授权；首期不采集任何原文或结构预览。
- 空、畸形、重复、异属、未知版本或超限反馈退回通用提示，不改变原有 rejected/eligible 判断。
- 模型伪造诊断文本而没有原生拒绝证明时，不能触发任何恢复。
- completed/current 的拒绝 receipt 相同但 current 的反馈被修改时，只采用 completed 的有界反馈。
- 前 16 个调用合法而后续调用非法、超大合法兄弟与非法调用同批时，不产生错误的单项归因。
- validator 缺失、抛出未知错误或改写 dummy 时，原调用和已完成历史不变；大整数差异不误标合法兄弟。
- 跨 attempt 排除、嵌套回执父链、async、Code Mode、yield、委派、投递、审批和客户端接管不放宽。
- 取消、writer/session/generation 失效时无新请求；次数不重置，日志不带参数值。
- 已接管恢复的完成和异常仍不能绕到 empty-error、fallback 或 finalize revision 获得额外请求。

## 10. 补丁和打包验证

从锁定 pristine 包分别验证无补丁、当前形态幂等、缺少任一接线/支持绑定、旧/部分形态拒绝。
覆盖 029/030 两种应用顺序、事务回滚及 SDK dependency 六文件证明。
新增 producer 支持导入必须进入 source 与实际 esbuild bundle 审计，使用真实构建格式，
不只验证字符串标记或在函数内计算但没有初始化的支持函数。

最终从原始包重建 Windows x64 runtime，验证补丁 manifest、依赖字节、支持模块、冻结 fingerprint，
再验证 Windows 资源归档/安装目录与源输入一致。远端 EXE 的原始失败仍须独立取证，
本机最新 bundle 或旧 669 项通过都不能证明远端安装版包含新反馈并实际触发。
不得修补已冻结 vendor 或给失败/旧产物补写证明。

## 11. 分步实施与交付

1. 先完成本方案及三项只读 agent review，收敛数据安全、纠正信息量和补丁行数。
2. 在独立 worktree 加入纯模块失败用例，再实现受限诊断/提示；不复制 dev 未提交文件。
3. 同一 030 增加最小 producer/runner 接线和支持证明，补全真实边界回归。
4. 运行插件单测、原生专项、lint/build/compile 与补丁/归档验证；有条件再做内网配对实验。
5. 功能与复审修正保持一个功能 commit，不合入或推送 dev；报告实际已验证和待验收项。

方案先经三项 review 收敛后再实施；生产逻辑位于既有 facts/policy，接线限于 030。
独立 worktree 不合入 dev；验证结果和真实模型验收状态分别记录，不把确定性 fixture 当作效果实验。

## 12. 参考与差异

[Anthropic 的非法 JSON 工具输入反馈](https://platform.claude.com/docs/en/agents-and-tools/tool-use/fine-grained-tool-streaming#handling-invalid-json-in-tool-responses)
使用明确包装的数据将不可解析输入反馈给模型。借鉴“给模型具体纠正线索”的思路，
不照搬其 tool-result 形状；本项目已经拒绝并删除这些工具块，不能制造没有合法调用所属的结果。
本地原生 parser 和 producer 为执行语义的唯一依据，远端安装版问题尚未取得对应证据。

## 13. Agent review 记录

2026-10-19，三个 agent 分别只读审查纠正效果、恢复安全性和补丁范围，结合实际锁定 parser
做了内存验证；没有运行真实 Gateway/模型、读取私人 transcript 或修改功能代码。
没有发现 P1，原草案的三个不同方案级 P2 已按下表修订，三位 reviewer 均复核关闭。

| 问题 | 修订和取舍 | 落点 |
| --- | --- | --- |
| 工具名和结构预览的持久化泄漏 | 首期完全省略名称及原文/结构预览，只传固定枚举、数值和布尔状态，不依赖疑似凭据正则 | 第 3、4、9 节 |
| 普通 JSON.parse 会误标原生合法兄弟，且大整数预处理可能使原文错误位置误导 | 通过同一个原生 validator 验证 dummy；潜在整数预处理时只给 native_rejected；未扫描调用仅批次未定位 | 第 3、5、8、9 节 |
| SDK producer 不能使用根 dist 的导入路径，现有字符串包含检查也不能证明实际绑定 | 在 030 审计精确 SDK 相对路径和真实 ImportDeclaration，并追加第三个 bundle owner 的无条件初始化证明 | 第 7、10 节 |

纠正效果 review 另要求：名称/原文省略后的首期版本只宣称诊断增强；对复杂命令的收益有限，
必须通过冻结构建、相同失败 SSE 和目标内网模型的配对实验测量，不能预先宣称成功率提升。
实际代码三项 review 均未发现确定 P1/P2；生产修改限于 facts.mjs、policy.mjs 与 030。
030 按现有预算规则为 646 行，未抬高 650 行阈值；实际编译形态仍以全新产物验证为准。

## 14. 本次实施与验证记录

生产修改仅涉及 Runtime Services 既有 facts.mjs、policy.mjs 和现有 030。
030 新增 8 行接线/审计，未增加补丁、SDK 写入目标、配置、数据库或权限。
纯模块新增 16 Ki 字符共享诊断预算、最多 16 个调用/3 个问题及两层白名单；
错误类别包括名称缺失、空参数、非对象、JSON 语法错误和原生拒绝。
没有可靠坐标时省略位置，潜在整数预处理时省略细因和位置。

三位 agent 完成实际代码复审，均未发现确定的生产 P1/P2。
新增 native smoke 的主聊天最初只检查 agent.wait，补丁范围 reviewer 指出这是 P2 验收缺口；
已改为精确 runId/sessionKey、executionSettled:true 的 whole-run lifecycle 终态，并复核关闭。
主/子纠正事件还各自要求恰好一次 retryAttempt:1，不用聊天 final 代替结算。

| 验证 | 实际结果 |
| --- | --- |
| 方案 review | 纠正效果、恢复安全性、补丁范围三项；第 13 节的三个方案 P2 已修订并复核关闭 |
| 应用检查 | npm run lint、npm run build、Electron TypeScript 编译、修改测试的 lint、JS 语法与 git diff --check 通过；未执行共享依赖的 ABI 重建 |
| 全新运行时 | 从锁定 pristine 包安装，source/bundle 的 30 项补丁通过；资源准备后预编译 10 项、18 项跳过、零错误，裁剪完成 |
| 冻结与拷贝 | current/win-x64 冻结校验通过；manifest 的 30 项补丁、6 个 SDK 依赖文件与当前源输入一致，工作树保存物理 win-x64，current 为同目录链接 |
| 实际产物专项 | 15 文件 612 项全部通过，无条件跳过；包含真实 SDK/SSE、原生 runner、嵌套回执、029/030 组合、支持初始化、原子回滚、归档证明 fixture、SDK/CLI companion |
| 主聊天与 subagent | 实际 Gateway chat.send 与 runtime.subagent.run；各 4 次模型请求。先完成写入 A，再拒绝“合法 B + 非法 XML”整批；纠正请求收到 Call 2/XML/整批 2 项说明，保留 A 的结果，最终 AB 各写一次，精确结算通过 |
| Swarm | 实际 work/verify 各拒绝整批后在同一次节点 attempt 内纠正；11 次本地模型请求，检查 exec 一次，work/verify 均收到当次反馈；暂停/重启恢复及最终交付通过，无节点重试 |
| 内网模型与远端安装版 | 未进行真实模型配对实验、未重新生成 EXE；不能据此宣称纠正成功率提升或远端实例已修复 |

运行时首轮在资源同步阶段因新工作树缺少离线 draw.io assets 停止；没有修补失败产物证明。
使用仓库已有锁定归档生成并验证离线资源，确认 patch/build recipe 指纹未变后，
按官方 resources → precompile → prune 步骤完成构建，再执行冻结和原生探针。

Swarm 首轮探针另发现旧 fixture 匹配带句点的旧提示词，当前提示为
`The user explicitly selected Swarm Workflow for this request...`，所以没有启动流程。
仅修正合成服务的前缀识别后重新运行通过；工具可用性、真实流程状态和调用次数断言保留。
纠正效果 reviewer 已确认此适配没有放宽生产行为，也不构成真实模型效果实验。

最终 SHA-256：

```text
gateway-bundle.mjs  f4299a2cb0f8c0d66fc1ebbf21d7ae936191cc8f32d12d3d7cc2c2ed6f9c30ba
gateway.asar        78953d41a90dae99a9a4ffdec6689c13be26f6536846baabfe57065c736e7c3b
patch set           8ef37df9e838600f214f9221f4d204cce91dd59864250688b9e55ec1e99152a4
build recipe        89b3cfe608a2651435724e47af31e9640fe086da0f26b48e163847fe8bdf105c
```

本实现基于建工作树时的 dev 85684f590；期间 dev 另有 Swarm follow-up 提交 938a37c52，
未纳入本工作树，也未修改/重置/合并 dev。后续合并前应单独核对其 smoke fixture 交集。

## 15. 过长错误与后续模型错误的补充要求

2026-10-20 用户补充：错误信息过长时根据情况截断或摘要；纠正期间出现其它无法恢复的
错误，必须告知用户最新原因。此补充不扩大格式恢复资格、次数或原生补丁范围。

格式诊断继续以闭合类别/数值摘要代替原文；超大参数在扫描前跳过，明确 omitted。
新增超大 Unicode 参数及最大安全整数元数据回归，确认未知大字段不会被扫描或序列化，
输出反馈 JSON 不超过 2 KiB、完整纠正提示不超过 3 KiB。

后续模型错误沿用原生投影：SDK projectProviderError 先脱敏并限制 message/body，
原生 lifecycle 格式器生成安全原因，公开 chat error/errorDetail 发布受限字段。
每次新 attempt 启动会清除旧的 lifecycle error/observation。
供应商正文不是公开错误通道的保证；如纯文本 503 可能只得到服务过载分类，
断连得到无法连接提示。这些原因属于当前失败，不能要求它们包含第一次格式错误或
强行返回供应商原文。不得把 raw preview/body/hash 塞入公开 errorDetail 绕过脱敏边界。

新增实际 Gateway 探针在“已完成 A，整批 B+XML 被拒绝，开始第一次纠正”后分别注入
HTTP 503、连接中断，以及带 Unicode/模拟凭据的超长 503 正文，核对：

- chat error、agent.wait 和精确 run/session 的 executionSettled:error 终态呈现同一最新原因；
- 不出现旧 malformed 或通用 couldn't generate a response 替代原因；
- 公开错误事件小于 3 KiB，不包含模拟凭据和超长正文；
- 只发生一次格式纠正、B 仍未执行，A 保留一次，没有工具重放；
- 不为返回错误正文另外发起模型请求，不增加新补丁或新的脱敏实现。

安全性和补丁范围 agent 已结合真实 503/断连事件及原生源码复审，未发现需要新增
生产接线的确定缺陷；本轮补充测试和契约说明，030 仍为 646 行。

补充专项 6 文件 233 项通过（含已有错误展示、事件投影和 runner 异常透传回归）；
断连、503、超长含 Unicode/模拟凭据的 503 三种 Gateway 探针通过。
复审建议将长度/凭据断言扩展到 agent.wait 和 settled terminal 数据，同样纳入探针。
生产 patch/build recipe 指纹与第 14 节一致，沿用已验证的 pristine 产物，没有重写或补写证明。

上述三种故障探针覆盖主 `chat.send`，未覆盖原生 subagent 的等待回执或 Swarm 节点错误。
该验证范围不足以证明“所有路径均保留最新原因”；第 16 节的扩展实测发现了真实缺口。

## 16. 假模型驱动的真实 Gateway 验证

2026-10-20 按用户要求扩展现有本地 OpenAI-compatible 假模型服务，调用第 14 节同一
Windows x64 Gateway bundle，经过真实 SSE、SDK 参数校验、030 恢复、原生 exec、
`chat.send`、plugin `runtime.subagent.run` 和 Swarm Workflow 执行。未替换策略判断，
未调用外部模型、读取用户 transcript 或修改已安装应用；每次使用独立合成状态目录。

假模型按真实请求中的纠正提示决定返回结果：先执行写入 A，再返回合法 B 与非法调用
组成的一批；检查纠正请求已带正确类别、整批拒绝提示及此前工具结果后，才返回正确 B。
在下一请求检查文件恰为 AB，确认原 A 保留一次、坏批中的 B 从未提前执行。

| 场景 | 实际路径 | 结果 |
| --- | --- | --- |
| XML、未闭合 JSON 字符串、非法转义、数组参数 | 主聊天、原生 subagent 各执行一次 | 四组均纠正成功；每个运行各 4 个模型请求，写入恰为 AB |
| 10,000 个 emoji 的超大非法参数 | 主聊天、原生 subagent | 省略诊断并明确 omitted，纠正成功；实际附加提示均为 706 字节 |
| Swarm 工作/验收节点整批格式拒绝 | 真实 Workflow 插件与 managed subagent | 11 个模型请求，两个节点均收到反馈，原节点 attempt 均为 1，检查命令只执行一次，重启恢复及最终交付通过 |
| 第一次纠正时断连、503、带模拟凭据及 100,000 个 emoji 的 503 | 主聊天 | 三组均呈现最新安全原因；各 3 个模型请求、一次纠正、仅保留 A，无 B 派发 |
| 同三种故障 | 原生 subagent | 聊天事件与精确 settled:error 终态保留原因，但 agent.wait.error 变成 failed；三组严格透传断言失败 |
| 同三种故障 | 真实 Swarm 工作节点 | 各 6 个模型请求，工作节点 failed、attempt=1，检查命令只执行一次；节点 error 均为 failed，三组透传断言失败 |
| 模型连续返回同批格式错误 | 主聊天、原生 subagent | 均在两次纠正后停止，各 4 个模型请求，仅保留 A；主聊天保留原生安全失败摘要，子运行 wait.error 仍变为 failed |

最终 17 组独立探针共 95 次本地模型 HTTP 请求：10 组通过，7 组因同一子运行错误回传
缺口失败（3 组子运行服务故障、1 组子运行纠正耗尽、3 组 Swarm 服务故障）；无基建故障。
计数不含定位过程的中间重跑，五组主/子成功探针每组含两个独立原生运行。
纠正耗尽当前沿用原生通用 couldn't finish this reply 文案，未声称它向用户解释了格式细因。

实际纠正提示为 679–724 字节；例如未闭合字符串给出调用 2、参数长度 29 UTF-16 units、
错误 offset 29，未包含参数原文。此结果证明反馈接线、整批拒绝和续跑安全性，不能估计
真实模型的自主纠正概率，因为假模型按测试脚本响应已核验的提示。

**修复前发现的具体原因丢失（由第 17 节修复）**：原生 agent 派发完成 payload 以 summary=failed 发布普通
失败（上游 `src/gateway/agent-turn/agent-run-dispatch.ts`）；agent job 的 dedupe 错误投影
优先使用此 summary，后发布的 RPC 结果可覆盖 lifecycle 的具体原因。
`server-plugin-subagent-runtime.ts` 的 waitForRun 透传 agent.wait.error，Workflow 的
`service/lifecycle.ts` 继续传递此 reply，`execution/engine.ts` 把 result.error 写入节点。
因此这不是“子 Agent 未执行格式纠正”，而是纠正失败后的错误回传路径不完整。
已验证原生子运行仍以 executionSettled/cleanupSettled=true、outcome=error 收敛，
错误原因丢失不代表成功或未知，也没有另外启动一组纠正。

该轮仅扩展两个已有 native smoke fixture 并记录验证边界，不修改业务代码或 030，
保留严格失败断言而非把 failed 当作“具体原因已透传”。复现时设置已准备 runtime：

```powershell
$env:JUSTDO_EXECUTION_RUNTIME=(Resolve-Path vendor/openclaw-runtime/current).Path
$env:JUSTDO_EXECUTION_BUNDLE='1'
$env:TOOL_CALL_FEEDBACK_PROBE='1'
$env:TOOL_CALL_FEEDBACK_CASE='xml' # truncated / escape / array / oversized / persistent
$env:TOOL_CALL_FEEDBACK_OWNER='sub' # 故障模式主/子路径；普通成功场景默认 main 并自动覆盖两者
$env:TOOL_CALL_FEEDBACK_FAILURE='disconnect' # http / http-long；普通成功场景移除此环境变量
node tests/openclaw/patches/v2026.10.4/plugin-owned-execution.native-smoke.cjs

$env:SWARM_WORKFLOW_TEST_RUNTIME=$env:JUSTDO_EXECUTION_RUNTIME
$env:SWARM_WORKFLOW_TEST_ENTRY='gateway-launcher.cjs'
$env:SWARM_WORKFLOW_TEST_FORMAT_FEEDBACK='1'
$env:SWARM_WORKFLOW_TEST_EXEC='1'
$env:SWARM_WORKFLOW_TEST_FORMAT_FAILURE='disconnect' # http / http-long；普通成功场景移除此环境变量
node tests/openclaw/extensions/swarm-workflow.native-smoke.cjs
```

plugin-owned fixture 的独立端口可用 `RUNTIME_EXECUTION_PROBE_PORT` 指定，下一端口供假模型使用；
Swarm fixture 固定使用 43131/43132，不能与另一个 Swarm probe 并行。
合成请求、脱敏错误回执和机器可读结果只留在忽略的 `.agent-tasks/` 下，未提交原生日志。

## 17. 子运行错误原因丢失的最小修复

用户授权修复后，保留原 worktree/dev 隔离和单个 feature commit。设计与新代码分别经过
安全性、补丁范围两个 agent 只读审查，均未发现确定的新 P1/P2；原生重建与故障探针
是本节独立验收，不能复用第 14 节旧 bundle 证明新接线已经生效。

扩展的 waitForRun 此时只能取得 failed；订阅 lifecycle 后缓存原因会新增运行身份、
代次、事件顺序、清理和重启恢复状态。选择在原生 exact result 仍存在的 dispatch
发布 summary 处接入 Runtime Services 纯投影，直接消除原因丢失，不建立缓存或登记表。

- 只替换 responseStatus=error、modelFallbackStopReason=tool_call_format_recovery 的摘要。
- 只读取当前结果自有的 readAgentRunTerminalError symbol；原生 post-run 在写入前已经
  选择当前 lifecycle 原因并执行 redactSensitiveText。getter 本身不是脱敏器，不能用
  包含裸 meta.error.message 兜底的局部变量或供应商原文替代它。
- 当前 abortSignal、meta.aborted/timeout、incognito 优先；未知抑制状态、非恢复链、
  空白/缺失诊断保留原生 failed。普通 subagent 错误协议不在本次统一调整。
- 摘要 JSON 编码后不超过 2 KiB，计入转义、Unicode、孤立代理项及省略标记；扫描和
  输出均有界，for-of 不切开合法代理对，不直接截断序列化 JSON。
- 原生 symbol 仍不序列化，只为这条已接管链开放有界用户摘要；原 status、result 身份、
  timeout/cancel、settlement、dedupe、权限和两次预算保持原样，异常 catch 分支不变。

030 增加第四个原生 owner agent-turn-service-CVZmpyt7.mjs 的窄接线：AST 精确核对
原生 reader、同一个 .then(result)/公开 result、错误三元分支、abort/privacy 条件，
并纳入 source/current 全集、事务和 bundle 无条件 lazy 初始化证明。
旧 030 或缺少新 owner/support 的部分形态直接拒绝，必须从锁定 pristine 包重建。
因此仅将 030 专项行预算从 650 调整为 700，不压行或把 transformer 藏到扩展中，
没有新增补丁、SDK 写入目标或运行状态权威；业务投影仍位于原有 policy.mjs。

新增回归覆盖原生 dispatch 的确切结果绑定、回执和 dedupe 摘要、裸 meta 不兜底、
普通/其它停止原因、取消/超时/incognito、异常抛出，以及 Unicode、控制字符、
孤立代理项和长空白的有界 JSON 摘要。030 的现有预算算法计 681 行，低于 700。
最终 8 文件 225 项回归通过；manifest/冻结产物检查确认 30 个补丁与 6 个依赖证明。

本次从锁定 pristine 包独立完整重建，未在第 14 节旧产物上改补丁或补写证明：

- patch-set：`86752faec2d66a78024b98eb0cd3e9445c1ec558e934ed61b1eb5872b86f36d1`
- build-recipe：`9a022531cdd58d5005a3cb84f50c5bc1970458ac8f486c96a5f09a86b7b8bf5c`
- gateway-bundle：`b69d38c55dcc2ca61d677ebef7faecdf4edbe21c9cc03de49d253e37382115e2`
- gateway.asar：`242abbba84a6f6753276e3d1789b5830c6ab405b553b0b4f50bb92f60dd02478`

独立 evidence agent 在独立 43541/43542 端口复测子运行纠正时遇到 503：
3 次实际 HTTP 请求、1 次纠正、文件仅 A，wait.error、唯一 chat.error、精确
settled:error 均为服务过载；executionSettled/cleanupSettled 均 true、outcome=error。
探针 exit 0、PASS，端口与进程已清理。该场景的具体原因丢失已在新产物中关闭。

同一冻结产物的最终矩阵 20/20 组通过、0 失败/未执行，共 122 次本地模型 HTTP 请求：

| 场景 | 组数 / HTTP | 实际结果 |
| --- | --- | --- |
| 五类坏参数，主聊天和原生 subagent | 5 / 40 | 两条路径均纠正成功，整批零派发，实际文件各为 AB |
| 断连、503、超长含模拟凭据的 503，主/子各三类 | 6 / 18 | 最新安全原因传到 chat、精确终态和 wait；纠正一次、文件仅 A |
| 连续返回坏格式，主/子各一次 | 2 / 8 | 两次纠正后停止，保留原生安全失败摘要，文件仅 A，子运行完成清理 |
| Swarm 工作/验收纠正及重启恢复交付 | 1 / 11 | 两节点 attempt=1，实际检查文件计数为 1，恢复及交付通过 |
| 工作/验收节点各三类服务故障 | 6 / 45 | 节点保留最新安全原因，attempt=1，实际检查文件计数为 1 |

一次主聊天超长 503 探针在单次 agent.wait 的 20 秒窗口到期后中断，不能作为运行终态。
保留该失败证据，仅将 fixture 调整为等待同一 runId、最多六个 20 秒窗口；不重发
任务，预期错误、精确终态、写入、清理及请求次数断言全部保留。agent 已复核该调整。
重测该场景实际经历一次等待超时后通过，仍只有 3 次模型请求、1 次纠正、文件仅 A。
子运行超长 503 与纠正耗尽也各使用了第二个等待窗口，分别为 3/4 次请求，最终均
通过原有精确错误、执行和清理结算断言；等待本身没有触发模型请求或工具派发。
首批已严格通过的 12 组按相同产物指纹重新核对，失败/未执行的 8 组在第二批完成；
汇总只接受对应 fixture 的通过记录、最终 PASS 和 exit 0，并校验固定请求次数。
122 次正式通过请求不含该中断探针和独立 agent 的额外复测；旧失败记录未覆盖。

安全性、补丁范围和证据三路 agent review 未留下确定的 P1/P2；产物实测后再次通过
frozen/manifest 校验。结论只覆盖本地假模型驱动的实际接线与安全边界，不估计真实
模型的自主纠正概率，也不表示另一台电脑的已安装程序已经更新。

## 18. schema 后出现坏 JSON 的原生循环修复

用户提供的 swarm_workflow_verify 在两次 {arguments:{...}} schema 失败后返回
残缺参数 {"arguments": 。实际假模型探针确认：schema 原生工具结果确实进入后续请求，
第三次 JSON 拒绝却直接终止；旧 facts 的 lastToolError 排除阻止了外层恢复，先前单独
坏 JSON 矩阵不能证明这条混合路径有效。已保留失败探针证据，未归咎于安装版本。

本次删除外层格式重启及其专用 nested receipt 读取/投影，将恢复能力接入当前 Agent
config、stream 提交前和 native runLoop 的原有续跑边界。既有 schema 校验不改，坏
JSON 使用不可执行的插件自有 hidden custom 反馈，不伪造 {}、调用 ID 或 toolResult。
原 SDK failure 不变，只规范化 core 副本；同一 run owner 共享两次格式预算并消费总预算。
原生停止策略先于反馈提交；有 pending 纠正的 policy stop 走原生失败通道。

原生首个 abort fence 仅在 hook 存在、三项当前响应计数均为 0、无取消且已确认完整
拒绝时暂缓。其它诊断（包括 provider_refusal）、异步 prefix、未知/不完整证明不接管。
超长反馈仍使用类别/数值摘要，后续服务失败仍保留最新安全错误。
接受 handoff 时按值保存 API/provider/model，原生下一轮准备完成后再次核验；更换模型
或原模型对象被原地修改均走原生失败，不把纠正交给新的候选。

生产代码为 Runtime Services facts/policy/loop 和现有 030，没有新补丁、依赖 SDK
写入目标、公开配置、数据库或 Swarm 重试。删除旧跨 attempt 证明后，030 当前约
760 行，审计预算调整到 800；新增部分是 core/attempt 的显式接线及绑定验证。
旧跨 attempt / nested 证明测试随删除实现移除，由插件纯逻辑、真实 native core
函数、run owner 和同一节点 schema→JSON 假模型回归替代。

首次新产物的真实 Gateway 请求暴露了原生投影边界：尾部新增且未保留的
system-update/runtime-context 在历史清理时被删除，循环虽继续但模型未收到反馈。
保留失败探针；改用 runtime-services.tool-call-validation 隐藏 custom 消息，沿
原生 generic custom → user 模型转换，不改全局历史清理或 prompt retention。
消息仍以 custom/display:false 留在原生记录，不成为新的用户发送或恢复授权；
恢复资格只来自当前 producer receipt。增加真实历史清理和转换函数回归，最终验收
仍要求 Gateway 下一次 HTTP 请求确实携带诊断，不能只检查内部 pendingMessages。

正式新产物与矩阵结果在本节后续记录；前节 20/20 仅是旧实现的历史验收。

新实现从锁定 pristine 包完整重建并冻结，30 个补丁和 6 个依赖证明均通过；没有修改
旧 bundle 或在旧产物上补写证明。最终产物指纹为：

- patch-set：`812ded9d5030766888dabd7d6612183ea8533758763ff77b8f993f200da739cf`
- build-recipe：`6406c0969037ada629aa735ad6dda738293298ff53885c95c67d9a91e5193bef`
- gateway-bundle：`9dbdf1002941a776f28b2737531499933bcda2db8cd7c2d6201e1863eddc2410`
- gateway.asar：`d42b2f4fa27afb47215fe83af00ee21f788ba64f4e6bcbeb26a6de96ce015340`

锁定 pristine 上 11 文件 317 项专项回归通过，最终冻结产物上 12 文件 380 项通过，
均无跳过；lint、应用 build 和新增测试的 ESLint 检查通过。实际转换链覆盖版本 3/4、
历史更新开关及 custom 对象克隆，保留此前工具调用与结果，不引入用户授权字段。

Swarm format fixture 使用同 plugin owner 的只读观察入口，直接核对节点的精确
run/session、current epoch/session、outcome、executionSettled 和 cleanupSettled，
并要求同一运行的 executionSettled:true lifecycle 终态；失败原因必须与节点展示一致。
重启前只缓存已通过这些核验的证明，最终仍核对当前节点的身份与结果。

正式矩阵首轮与 manifest/归档回归并行，Swarm 重启场景在第 10 次预期请求后耗尽
旧的 70 次轮询窗口；当时流程仍在运行，没有据此推断成功或失败。保留该超时证据，
仅将 format fixture 改为最多 240 秒等待同一 flow，未增加发送、节点重试或放宽请求
次数、副作用、精确终态和清理断言。最终矩阵另用新目录记录，并从头运行全部场景。

同一冻结产物的正式最终矩阵 **24/24 组通过、0 失败/未执行，共 168 次本地 HTTP**：

| 场景 | 组数 / HTTP | 结果 |
| --- | --- | --- |
| 五类坏参数，主聊天与 subagent | 5 / 40 | 下一次请求收到诊断，保留此前结果，整批零派发，文件各为 AB |
| 断连、503、超长含模拟凭据的 503，主/子各三类 | 6 / 18 | 最新安全原因到达 chat、wait 与精确终态，文件仅 A |
| 连续坏格式，主/子各一组 | 2 / 8 | 共享两次纠正后失败，未重新开启其它重试，文件仅 A |
| Swarm 工作/验收纠正及暂停重启恢复 | 1 / 11 | 完成交付，两个节点 attempt=1，检查文件仅写入 1 次 |
| Swarm 工作/验收节点各三类服务故障 | 6 / 45 | 最新安全错误、精确执行和清理结算一致，无节点重试 |
| 两次原生 schema 错误后接残缺 JSON | 1 / 13 | 两个前序调用 ID 的校验结果确实进入请求；JSON 诊断送达后纠正并交付 |
| 上述混合错误后接断连、503、超长 503 | 3 / 33 | 当前服务错误透传，检查只执行一次，work/verify 原生结算证明完整 |

schema 场景使用在原生 ID 清洗后仍完全一致的字母数字 ID，不能拿任意历史错误充数；
第三次参数使用用户提供的同一残缺前缀 `{"arguments": `。实际格式反馈不含原始参数。
最终 168 次请求不含旧失败记录和 expanded-source 预检，所有结果都校验本轮 PASS、
exit 0、实际请求数、同一产物指纹和具体副作用；旧证据未被覆盖或并入通过数。
成功混合场景保存了两条 schema 调用 ID；三组混合故障以当次精确 ID 断言证明，
报告未另存该数组。本轮暂停发生在工作完成前，未实际覆盖“缓存已完成工作证明后
重启”的测试分支，不能据此宣称执行途中重连或这一缓存路径已经验收。

安全性、范围和证据多路 agent review 未留下确定 P1/P2。结论证明当前原生循环接线
和受测边界有效，真实内网模型的自主纠正率、profile 与重连验收仍保留，不推断已安装
程序已经更新。业务策略留在 Runtime Services，必要原生接线仍只修改既有 030。
