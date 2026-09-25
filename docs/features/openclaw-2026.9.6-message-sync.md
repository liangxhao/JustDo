# OpenClaw 2026.9.6 消息同步审计

## 当前方案：撤销 017，使用原生恢复协议

017 已从当前版本补丁清单删除，运行时从锁定的原始包重新构建，剩余 23 个补丁。
不能通过对旧运行时逆向替换注入代码来卸载补丁。以下涉及 017 修复及 24 个补丁的
记录是已撤销方案的历史审计，不再代表当前部署要求。

原生协议已覆盖基本恢复：持久正文位于 `messages`，运行中正文位于
`inFlightRun.text`，工具和进度位于 `inFlightRun.events`。原生有意不在 events
重复存储正文；前端此前忽略独立 text 字段形成了对 017 的不必要依赖，本次移除。
代价是恢复时不承诺精确重现尚未持久化的全部 thinking/正文分段顺序。

18:16 的再次实测不是模型持续等待：Gateway 重启导致 Renderer 断开，后端随后
发起任务，18:17:22 已生成正文、18:17:23 正常结束，Renderer 到 18:17:27 才重连。
离线时尚无活跃 run，离线后新建的任务没有进入原先的重连恢复分支，且发送状态阻止
历史应用，因此界面持续等待。恢复必须以当前任务身份和原生历史终态确认结果，不能
仅凭没有收到实时 final 或 session 已不活跃，就继续等待或标为取消。
直接调用该会话的原生 API 也确认：`sessions.describe.session.status` 为 `done`，
`chat.history` 没有 `inFlightRun`，且存在与本轮 `__openclaw.runId` 匹配、
`stopReason: stop` 的 assistant 回复。诊断只读取状态和消息结构，没有重新请求模型。

原生安装产物回归同时检查：旧 017 标记不存在、正文缓冲可读、工具/item 回放有效、
原生字节预算与工具组淘汰正常。Renderer 用不含自定义分段字段的协议样例验证恢复。

最终复查另外修复了四个边界：原生 failed/killed 终态不能继续等待；确切 done 的
静默或工具-only 结果不应误判取消；commentary 使用原生 `openclawStreamFallback`
字段排除；同一前缀在持久历史与 live turn 同时存在时只能剥离一次，保留工具后重复回复。

最终 `dev` 验证：聊天及原生运行时共 72 个测试文件、1,083 项测试通过（其中
原生运行时与 pristine 契约 13 项）；23 个补丁验证、lint、build 和 `git diff --check` 通过。
worktree 的代码、删除项与完整重建运行时已同步至 `dev`，两个目录的改动逐文件一致。
未声称重新发起真实模型请求或完成 UI 人工复测。

## 历史记录：2026-09-25 首次实测无回复修正

15:04 的实测暴露了此前 helper 模拟测试未覆盖的运行时错误：017 补丁调用
`jsonUtf8Bytes`，但新版原生 progress 模块没有该绑定，导致 assistant 事件分发
抛出 ReferenceError。模型已成功完成，回复也已持久化；不能把此故障归因于模型。

- 补丁私有计数使用 Node `Buffer.byteLength`，保存事件走原生
  `captureProgressEvent`，确保冻结副本和原生 WeakMap 字节计数一致。
- 原生 transient 清理保留有身份的正文片段；文本、工具和 typed item 混合时预算
  不再因删除未登记事件变成 `NaN`，工具组淘汰同时清除对应 tool/item。
- 结束后的补史只接受可见的 assistant 回复作为恢复证据。用户行、工具调用、工具结果、
  thinking-only 和 commentary 不再因为共用 runId 或序号增长而提前取消补史。
- 新增实际安装产物测试：在独立 Node 进程直接导入原生模块，执行 run state 的
  progress API，不注入任何模拟依赖。旧产物已复现相同 ReferenceError；覆盖混合事件、
  原生捕获、预算及双向淘汰。可用 `JUSTDO_TEST_PATCHED_RUNTIME` 指定待测运行时目录；
  指定目录缺少模块时必须失败，未安装运行时的源码测试环境才允许跳过。

必须从锁定的 pristine 包重建并重新启动 Gateway；仅更新 Renderer 无法修复此异常。
此前“补丁验证通过”只证明变换形态符合预期，不代表事件分发路径已执行成功。

本次验证：聊天模块 69 个文件、1,054 项测试通过；相关终态、撤回及补丁测试
65 项通过；实际安装产物执行测试在旧版失败、新版通过。完整 Windows runtime
重建、24 个补丁验证、lint 和 build 均通过。修复代码与完整重建产物已同步至
`dev` 工作目录，并在该目录再次通过产物执行测试。未声称完成真实模型 UI 复测。

本次对照相邻 `openclaw` 源码（package version `2026.9.6`）、当前版本运行时补丁和 Renderer 消息链路。近期 main 日志抽样没有发现 history 参数校验错误，不能据此推断所有传输事件都正常；以下结论以源码和可重复的行为测试为依据。

## 协议核对

- 原生 `server-chat.ts` 对 assistant/thinking 流进行合并发送，序号不连续是正常情况。`text` 是快照，`delta` 是增量，`replace` 可以撤回已有文本；不能用序号缺口直接判断丢包。
- `embedded-agent-subscribe.handlers.tools.progress.ts` 对 typed progress 仅发送带 `progressText` 的 item，并抑制重复的 detailed Tool update。普通 partialResult 仍是工具输出快照。
- `chat-history-handler.ts`、`chat-history-page-kernel.ts` 保留 `limit/maxChars/offset/nextOffset/hasMore`；`chat.message.get` 仍接受 2,000,000 字符预算并可能返回 oversized。当前请求参数无需改名。原生 deltaCursor/activity 是附加协议，本次不将它们误当作替代现有消息历史的接口。
- 原生历史允许同一 transcript id 产生多个显示片段，分页接缝与补全必须区别“显示片段身份”和“原生消息身份”。
- 原生 leaf 是当前分支末端，普通追加也会更新；只有不能证明延续的变化才需要替换已有分支投影。

## 已修复的问题

| 问题 | 触发方式与修复 |
| --- | --- |
| 空替换残留、thinking 替换增量追加错误 | 明确替换优先于追加；空替换清空原 owner，立即通知视图。前台、后台、侧边聊天均允许 chat-only 撤回穿过普通双流去重，原生 payload seq 与 WS frame seq 分开保护迟到帧。 |
| 切回会话复活已撤回文本 | 017 恢复补丁正确消费 replace，并保留带原段序号的空替换；不再把它当作追加空 delta。 |
| 工具进度不更新且安排多余刷新 | 消费原生 item.progressText，单独存放临时进度，沿用工具部分更新节流；最终结果清除进度，迟到进度不覆盖终态。 |
| 长消息补全后显示重复或丢 commentary | 区分同原生 id 的主投影和 commentary，补全主投影时只去掉对应重复片段；不能证明完整的混合投影保留原显示。 |
| 切换后旧大消息仍连续下载 | 每次分块及下一条补全任务前检查请求归属；失效后不再发起剩余 RPC，也不发布旧结果。 |
| 常规追加重置长历史分页 | 新快照包含旧 leaf 及后继新 leaf 时保留已加载历史；真正分支切换仍替换旧页。 |
| 子代理初始任务跨多页时丢失中间页 | 找到起点后合并全部已加载 chunks，并按原生显示身份处理接缝重叠。 |
| 子代理误绑定主会话待确认运行 | 无选中会话身份的 spawned 事件不能绑定 provisional run；明确选中子会话仍可建立运行。 |

## 验证与边界

### 多 Agent review

三路独立 review 分别检查流式归并、历史分页与子代理、运行时恢复补丁，并交叉审查流式修复。发现并补充修复：

1. chat 空替换跨过较新的 Thinking/Tool 时没有清除旧正文；撤回先于旧 owner 到达时，旧内容仍会复活。现按 assistant 源序号维护撤回水位和真实文本更新序号，保留较新正文及独立 commentary。
2. 工具 typed progress 与 detailed partial 属于不同事件通道，迟到 partial 会覆盖较新进度。现用独立进度序号保护显示，同时允许终态和缺失 input 补回。
3. preamble 空替换被入口过滤，恢复墓碑无法生效。现接受明确替换的空 preamble，保留 owner 的序号保护。
4. `NO_REPLY` 等非空原始快照可投影为空，017 只判断原始空串会遗漏撤回。现保存同 owner 的空恢复事件，覆盖无 replace 标记的权威快照，并防止控制前缀泄漏。
5. `chat.message.get` 仅返回单个显示投影，不能替代包含 commentary 的所有历史片段。现分别保留 commentary；不向此场景扩大原始消息分块读取。
6. 实时持久消息追加后，上次 history 的 leaf 已落后；回退到中间消息被误判为普通追加。现用实际已显示的持久后继校正 leaf，回退后移除旧分支尾部。

对于签名已被原生混合投影消除、无法可靠匹配的超限 commentary，保留原生截断展示。此处解决刷新丢失，不声称恢复其全部超限文字；完整补全仍需 OpenClaw 提供一致的完整显示投影能力，不能通过直接展示原始控制或内部消息来替代。

新增回归覆盖空替换、替换后的继续增量、迟到快照、typed tool progress 与最终结果、完整/截断兄弟片段混合补全、取消后停止分块、跨三页子代理任务历史、普通 leaf 追加与真正分支切换。原有大历史窗口、流式渲染、后台会话、子代理 Gateway 适配测试一并执行。

017 的行为测试直接执行当前注入 helper，并验证当前 transformer 幂等、旧形态拒绝。应用需从锁定的 pristine npm artifact 重建运行时才能获得该补丁更新；不能原地修补旧运行时。测试不等同于真实模型长时间交互压测，也不保证网络或模型延迟。

本 worktree 验证结果：

- 消息 UI、Gateway、共享协议、subagent 适配与 017 补丁：86 个测试文件、1,241 项测试通过。
- `npm run lint`、`npm run build`、`npx tsc --project electron-tsconfig.json --noEmit` 通过。
- 从锁定原始包执行 `OPENCLAW_FORCE_INSTALL=1` 的 Windows runtime 完整重建通过；`npm run openclaw:patches:verify` 验证全部 24 个补丁通过。
- `git diff --check` 通过。此处报告的是上述相关测试集合，未声称执行全仓库 `npm test` 或真实模型交互压测。
