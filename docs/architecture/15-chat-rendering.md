# Chat 渲染架构

本文按 `v2026.8.26` 的 `src/renderer/libs/openclaw-chat/`、`JustDoChatWrapper`、Main history/adapter 和相关测试重写。Chat 渲染不是“把 messages map 成 DOM”；它是 history、optimistic tail、实时事件、工具生命周期与滚动窗口的确定性投影。

## 1. 目标与不变量

- Gateway transcript/history 是持久消息权威。
- 当前 run 的 agent events 进入单一 reducer，不能再维护并行 overlay 状态机。
- sessionId、sessionKey、runId、lifecycleGeneration、sequence 和 stable message identity共同防串线。
- history/live/optimistic可对账并被替换，不靠文本相同或时间邻近去重。
- 高频delta最多每animation frame发布，长历史只渲染有界窗口。
- Markdown/diagram/tool输出是未可信内容，必须限制、转义和清洗。
- 用户上滚后保持阅读锚点；新消息不强制抢焦点。

## 2. 模块地图

| 目录/文件                                | 职责                                                          |
| ---------------------------------------- | ------------------------------------------------------------- |
| `JustDoChatWrapper.tsx`                  | React/Cowork与Lit chat的桥、IPC订阅、session切换、history载入 |
| `gateway/client.ts`                      | Renderer Gateway client与连接信息适配                         |
| `gateway/chat-controller.ts`             | 对外状态/命令、订阅与transcript调度                           |
| `model/chat-transcript-state.ts`         | persisted/history source、active turn、recent runs、revision  |
| `model/agent-event-reducer.ts`           | normalized agent event -> turn items                          |
| `model/history-reconciler.ts`            | history与active/optimistic identity对账                       |
| `model/history-window.ts`                | 750条窗口、每次250条前后移动                                  |
| `pipeline/build-chat-items.ts`           | 原始message -> group/timeline display items                   |
| `components/justdo-chat.ts`              | Lit组件、搜索、minimap、timeline、滚动、Mermaid后处理         |
| `components/markdown.ts`                 | Markdown-it、highlight、KaTeX、DOMPurify、stream边界/cache    |
| `controllers/stream-render-scheduler.ts` | frame合批和tool partial节流                                   |
| `controllers/chat-scroll-controller.ts`  | follow/paused、锚点、unseen revision、加载旧窗口              |

## 3. 状态模型

`ChatTranscriptState`：当前 session key/id、persistedMessages、historySource、historyGeneration、activeTurn、recentRuns和revision。History source是 `gateway`、`sqlite-fallback` 或 `optimistic`，调用方必须保留来源语义。

`AssistantTurn`绑定 run/session/lifecycle generation，状态 `running|final|aborted|error`，保存 last agent seq、时间、modelRef和有序items。Item分：

- Thinking：running/completed/failed/cancelled/interrupted；
- Tool：toolCallId/name/input/output/error与同样process status；
- Content：streaming/completed/interrupted，标记 delta/snapshot/replaceable；
- Terminal：aborted/error可见行。

最近24个run保留5分钟terminal/sequence fence，阻止迟到事件重新创建已结束turn。Live tool output最大120,000字符。

## 4. 端到端数据流

```mermaid
flowchart LR
  GH[Gateway history]
  SF[SQLite fallback]
  OPT[Optimistic user tail]
  EVT[Normalized live events]
  PS[Persisted transcript state]
  AT[Active turn reducer]
  REC[Identity reconciliation]
  PIPE[Build chat items]
  WIN[History render window]
  LIT[Lit timeline]
  GH --> REC
  SF --> REC
  OPT --> REC
  EVT --> AT --> REC
  REC --> PS --> PIPE --> WIN --> LIT
```

Wrapper切换session时取消旧订阅、建立新generation、请求paged history/tool inputs/compaction detail，并设置chat element属性。Controller按session缓存未完成turn、pending user message、run activity和compaction状态；后台session的live/terminal事件及迟到的send/compact RPC结果写回所属缓存，重新选中时先恢复缓存再与history对账。

临时session转为canonical session必须由创建流程显式登记准确的source/target key。普通的“临时session → 其他已有session”导航不能推断为promotion，也不能迁移消息或sending状态。Live事件先经过shared domain分类，再送controller/reducer；terminal触发Main/Gateway history同步。旧异步history请求即使晚返回，也因generation/session identity被丢弃。

运行期间的 `session.message` 是transcript append的冗余权威通知。若对应Agent Tool start帧漏收，Controller可在session/run identity和active-turn时间边界均匹配时，用稳定toolCallId恢复缺失的 `sessions_yield`。若该通知本身也因背压丢失，后续append暴露的messageSeq缺口会登记unresolved target并触发有界active-tail history追赶；只有权威history追到target并经过安全Tool hydration后才清除，陈旧快照或请求失败会重试。揭示缺口的消息可以是announce，但direct message回填仍必须匹配root run。恢复不替换整个live timeline，也不推进Agent sequence，因此迟到的canonical start/result及后续Tool仍可正常进入reducer；旧、无timestamp或foreign消息不得直接回填到当前turn。

## 5. Event admission

Reducer不只检查runId：

- session key先标准化并与当前域匹配；
- sessionId存在时必须一致；
- lifecycleGeneration防止同run id重用/重连污染；
- agent sequence必须单调，重复或回退忽略；
- terminal recent run拒绝后续非合法修正；
- tool terminal status通过shared normalizer统一；
- foreign/detached run只在明确可见规则下形成历史项，不能抢当前active turn。

Main和Renderer共享 `agentEvent`/`messageDomain` 合约，禁止各自维护含义不同的字符串判断。

## 6. Reducer 规则

### 6.1 Thinking

start/delta/snapshot创建或更新独立Thinking item；文本按delta或snapshot规则合并。终止时变completed/failed/cancelled/interrupted。Thinking不拼入最终Content，也不因没有正文被隐藏。

### 6.2 Tool

用toolCallId稳定更新单卡；input只在详情展示，partial output节流，terminal result/error结束。`sessions_yield` 无输出但仍可显示蓝色running tool，不伪造空result。若其实时start漏收，可由身份受限的 `session.message` 或active-tail history按toolCallId恢复running卡片，并由后续实时事件原位完成；这种missing-item恢复不泛化到普通Tool。`update_plan`解析成始终可见的有序plan card，状态仅接受 pending/in_progress/completed。

### 6.3 Content

Delta append、snapshot replace、replaceable允许权威final替换。文本merge处理suffix/prefix overlap，避免provider重复快照。final完成流；aborted/error把未完成内容标interrupted并增加terminal item。

### 6.4 Process summary

已完成的Thinking/Tool按时间压缩为process summary，默认不把完整输入/输出塞进主DOM。展开summary后仍按原时序展示；每个Tool有自己的detail disclosure。运行中的Thinking/Tool保持独立可见，不被已归档summary吞并。

## 7. History reconciliation

Stable transcript identity优先读取Gateway message id/记录标识，再用受控fallback。Reconciler：

1. normalize history role/content/tool blocks；
2. 对齐persisted和optimistic user message；
3. 识别active assistant正文是否已进入history；
4. 处理process summary takeover、failed-run message和project turn items；
5. 保留合法active tail，删除已被history覆盖的重复项；
6. 增加historyGeneration/revision。

SQLite fallback只在Gateway history不可用时提供初始/错误恢复显示；一旦Gateway结果到达必须takeover。Tool input lookup严格限定请求session，不能跨transcript搜相同call id。

## 8. History 窗口

默认只渲染最新750条，older/newer每次移动250。用户在最新窗口时新history继续锁定尾部；浏览旧窗口时用第一条可见stable identity在新数组中重新定位，identity不存在才用索引clamp。

窗口是DOM/投影优化，不限制Gateway分页存储。加载旧页时保留滚动锚点和搜索/minimap identity；不能用反复数组前插导致O(n²)组装。

## 9. 渲染管线

`buildChatItems`先 normalize role/message、过滤内部runtime context/heartbeat展示、恢复attachments和tool cards，再分project turns/message groups。Pipeline中的user content、role、stream text、text direction、search match和tool helper保持纯函数。

Timeline层决定avatar、sender/model label、timestamp、duration、usage、goal reply零usage隐藏、process/footer。配置的assistant名称不是模型metadata；真实modelName缺失时使用通用assistant label。

## 10. Markdown 与安全

`toSanitizedMarkdownHtml` 使用 Markdown-it的linkify/breaks、task list、texmath/KaTeX和自定义fence/table规则，再用DOMPurify tag/attribute allowlist清洗。

限制：原文最多140,000字符；完整Markdown解析前40,000字符，超限安全截断/转义；cache最多200项且只缓存不超过50,000字符的输入，version为 `markdown-render-v11`。Unknown code language只转义不自动highlight；自动highlight语言是固定allowlist。

链接修正CJK尾随标点但不改显式Markdown link。HTML原文不会直接注入。inline data image仅允许明确image MIME。

## 11. Streaming Markdown

未闭合fence、容器或语法在stream中会造成DOM大幅抖动。`findStableStreamingMarkdownBoundary`只完整解析稳定前缀，尾部以escaped plaintext显示；完成后再全量解析。普通包含box-drawing字符的文本不自动当diagram，只有完整上下边框的独立块才进入diagram展示。

## 12. Mermaid、公式与代码

Mermaid source先以sanitized block进入DOM，component updated后异步render SVG；失败保留syntax error并清临时节点，不展示Mermaid错误画布。Shadow root内使用document-level render后安全注入preview。气泡宽度约束500..820并按SVG调整，支持source/preview切换。

KaTeX由texmath生成且仍经过sanitizer。代码块提供copy按钮；复制来自已解析code文本，不执行内容。

## 13. 滚动

ScrollController只有follow/paused：在底部（0.5px容差）follow并随revision滚到底；用户上滚进入paused并累计unseen revisions。渲染前捕获最多3个可见DOM锚点及offset，渲染/resize后用存活锚恢复位置。

距顶部160px触发older window；在窗口边界的near-bottom可移动newer但保持paused。搜索/minimap导航记录target并阻止render anchor干扰；“跳到最新”清unseen恢复follow。展开工具/summary前保存interaction anchor，避免高度变化跳屏。

## 14. 渲染调度与性能

Stream scheduler将普通更新合并到`requestAnimationFrame`，无RAF时用microtask；tool partial有独立最小间隔，terminal调用flush。Dispose清timer/frame。

性能边界包括：有界history DOM、Markdown cache/limit、live tool output cap、collapsed detail不入DOM、persisted timeline/render cache、minimap最少2项才显示。任何新投影应避免每个token重新扫描全部history或JSON stringify大对象作为key。

## 15. 搜索与 Minimap

搜索收集shadow DOM text nodes，跳过不应搜索的控件，标记match并展开包含它的summary/tool disclosure；清除时还原文本。Match count通过component event回React modal。

Minimap从timeline identity生成entry，追踪当前viewport并支持hover preview/点击导航。DOM anchor使用data-history-key/data-process-id等稳定属性，不以数组index作为跨更新身份。

## 16. Attachments 与路径

附件转换为Gateway content blocks，历史媒体从结构化message提取。Markdown本地路径链接经专门utility转成应用操作；图片保存/打开由Main shell IPC执行。Renderer不能直接读 `file://`；`localfile://` 使用需遵守安全文档中的限制。

## 17. Goal、Compaction 与错误

Goal card位于chat周边但状态来自Main snapshot。Compaction history detail通过专用IPC读取，timeline展示summary、tokens before/after和recovery progress；不把内部context markers显示给用户。

输入区上下文圆环在session已有 `totalTokens` 后与OpenClaw webchat使用相同口径：展示该快照，`totalTokensFresh: false` 时以 `~` 标记近似值。首个快照尚未产生且Gateway明确报告 `hasActiveRun: true` 时，UI可以经过 `~` 标记的 `contextBudgetStatus.estimatedPromptTokens` 作为启动值；它必须带有live patch在provenance校验后写入的 `justdoUsageBootstrap` 标记，且永远不得覆盖已有 `totalTokens`。live budget patch按input provenance排除announce等保留父会话状态的内部run，再按session generation、`updatedAt`拒绝乱序写入；因此announce运行期只保留父会话已有快照，或在首轮保留announce开始前由主run发布的启动估算。运行结束后UI做有界收敛轮询；显示层将异常provider值限制在窗口上限。

长时间无输出提示由active turn clock派生，仅表示等待，不宣告失败。Failed run message必须区分abort、error、transport和tool failure；OpenClaw log hint仅从streaming active content的特定系统尾部移除，普通完成内容中的“Logs”标题保留。

## 18. 会话导出

导出使用Cowork session presentation与canonical items生成文本/Markdown等产品格式，包含必要角色、时间和内容；不直接dump internal state、token、approval payload或Gateway原始JSON。导出前需完成当前显示history加载范围的产品约定，避免误称“完整”却只导出窗口。

## 19. 测试矩阵

现有测试覆盖 reducer sequence/terminal/tool/thinking、history identity/window/reconcile、optimistic tail、process summary、tool lifecycle/cards、active timeline、漏收 `sessions_yield` start后的直接恢复、foreign announce揭示双漏帧messageSeq缺口、陈旧history重试、连续/重复/乱序cursor、foreign/旧/无timestamp拒绝及后续sequence连续性、Markdown/KaTeX/Mermaid、stream scheduler、scroll、minimap、conversion和wrapper辅助逻辑。

变更还应覆盖：session快速切换、旧request晚返回、重连generation、foreign run、分页两端、超大Markdown/tool输出、XSS payload、展开锚点、search disclosure、RTL/CJK、无RAF/ResizeObserver、history takeover和导出一致性。

## 20. 维护规则

- 新Gateway event先更新shared normalize和Main adapter，再更新reducer。
- 不在component render中修协议；复杂转换放纯函数并测试。
- active/persisted状态只能通过transcript reducer/reconciler变更。
- 调整limit必须以性能profile和内存证据为依据。
- Chat架构变化同步Cowork、thin frontend、capability matrix和相关feature审计。

## 21. Item Identity 规则

History message、live assistant segment、tool lifecycle、thinking、plan 和 process summary 使用不同 identity namespace。相同文本不代表相同 item，时间戳也不能单独唯一。Reconciliation key 应优先使用 Gateway message/run/tool/call identity，并把 session domain 纳入；fallback identity 必须稳定且在测试中覆盖碰撞。

## 22. Terminal 与 Takeover

Terminal event 关闭 active reducer 的本次 run，但 persisted history 何时包含完整结果由后续 query 决定。History takeover 的条件是权威项可覆盖对应 live/optimistic identity；不能在收到任意 history response 时清空 overlay，也不能长期保留导致重复。迟到 delta、旧 generation query 和 foreign run 都必须被 admission 拒绝。

## 23. 渲染预算与降级

| 内容            | 控制                             | 降级                             |
| --------------- | -------------------------------- | -------------------------------- |
| History         | 750/250 有界窗口及分块           | 保留锚点，按需加载旧页           |
| Streaming delta | render scheduler 合帧            | terminal 时强制 flush            |
| Markdown        | normalize/cache/内容限额         | plain text 或截断提示            |
| Mermaid         | source hash/cache/尺寸与错误边界 | 显示源码/错误卡，不执行任意 HTML |
| Highlight/KaTeX | 按块处理与 cache                 | 未识别语言/公式显示安全文本      |
| Tool output     | 摘要卡 + disclosure              | 大 payload 不直接挂完整 DOM      |

限额是产品行为，调整时要同时评估内存、首屏、搜索范围、导出语义和 accessibility，不只观察单次 benchmark。

## 24. 可访问性与交互不变量

Streaming 更新不应抢走键盘焦点或反复触发 screen reader 整页朗读；tool/plan disclosure 使用可聚焦控件与 `aria-expanded`；搜索/minimap 结果需可键盘导航。自动滚动只在用户仍位于跟随区域时发生，用户向上阅读后新 delta 不应强制拉回底部。

## 25. 代码证据地图

| 行为               | 入口/测试                                                         |
| ------------------ | ----------------------------------------------------------------- |
| Event reducer      | `model/agent-event-reducer.ts` 及测试                             |
| Transcript/history | `chat-transcript-state.ts`、history/window/reconciler tests       |
| Optimistic         | `optimistic-user-message.ts`、`optimistic-history-tail.ts` 及测试 |
| Projection         | `project-history-timeline.ts`、`project-turn-items.ts` 及测试     |
| Item pipeline      | `pipeline/build-chat-items.ts`、normalizer/tool tests             |
| Streaming/scroll   | controllers scheduler/scroll tests                                |
| Search/minimap     | `search-match.ts`、`chat-minimap.ts` 及测试                       |
| Gateway conversion | `conversion/cowork-to-gateway.ts` 及测试                          |

## 26. Chat 变更完成条件

新增 item/event 必须同时说明 live 与 history 表达、identity、session/run admission、terminal/takeover、渲染清洗、性能上限、搜索/导出和失败 fallback。至少测试乱序、重复、session 切换、分页、重连和危险内容；只截图证明视觉正常不构成数据流验收。
