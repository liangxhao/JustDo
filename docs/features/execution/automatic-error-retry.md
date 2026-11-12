# 错误自动重试

应用可在已登记的原生执行错误后，向同一聊天追加固定内部反馈，最多启动 n 次新运行。
原生旧运行仍然失败；新运行有独立 run ID 和原生回执。不删除工具注册，不重放失败命令，
不改写失败结果，不增加 OpenClaw runtime patch。

## 设置与规则

运行参数 `automaticErrorRetry.maxContinuations` 默认 1，范围 0–3；0 关闭。
旧设置只补缺失的新字段，不重置其他设置。此应用侧设置不投影到 Gateway 配置。
确认命中规则且还有额度后，每次续跑默认等待 3 秒。默认值由 Main 的
`AUTOMATIC_ERROR_RETRY_DELAY_MS` 定义，等待结束后才分配后继运行身份并记入次数。

规则只包含 `id`、`errorCodes`、`fixedPrompt`；重复 ID/错误码或空提示被拒绝。
已登记连续相同工具失败 `openclaw_repeated_tool_error`、上下文溢出 `context_overflow`，以及
会话读取许可失效 `session_reader_not_current`。规则共用同一续跑额度。
连续工具失败的反馈要求检查已有结果、修正参数或换用可用方法。
上下文溢出的反馈要求从已保存的进度继续，先核对可能已有副作用的操作，并限制文件读取和
命令回传的内容。读取许可失效的反馈从原会话中已保存的用户输入继续，先核对已有操作结果。

各规则复用同一个调度器和 Goal 交接。错误识别模块按来源核对原生失败证据。

## 模块归属

Main 的执行实现集中在 `src/main/engine/openclaw/automaticErrorRetry/`，按职责分为：

| 模块 | 职责 |
| --- | --- |
| `coordinator.ts` | 重试链、共用次数和唯一尝试的策略状态 |
| `rules.ts` | 固定错误规则及规则索引验证 |
| `failureCode.ts` | 经现有 Runtime Services 接口核对精确错误码 |
| `host.ts` | 已准入桌面来源、工作区/权限准备、条件发送和回执持久化 |
| `lifecycle.ts` | 已接纳的原生结果暂存、错误展示延后和业务 owner 交接 |
| `historyPresentation.ts` | 无正文历史关联的显示恢复，不重建执行 |

Adapter 继续持有原生 active turn、未知发送、连接代次和会话准备；原生恢复的身份核验
在入口完成后才把精确结果交给重试模块。共享的 `ExecutionSuccessorClaims` 由 Adapter
组合根创建并分别注入 Goal 和 Host，两者不通过对方取得调度能力。

Renderer 的 `controllers/automatic-error-retry-presentation.ts` 只拥有订阅、元数据和计时器；
纯消息/Turn 投影在现有 `pipeline/automatic-error-retry-display.ts`，Lit 负责组合呈现。
preload 的最小桥和 shared 的跨进程契约保持单文件；IPC 只校验来源并组合响应，
数据库 schema 和回执读写继续由 SqliteStore/CoworkStore 持有，不另建重试存储权威。

## 执行与归属

```mermaid
flowchart LR
  Send[桌面发送前登记精确运行] --> Terminal[原生整轮失败结算]
  Terminal --> Claim[认领唯一后继]
  Claim --> Code[核对结构化错误码]
  Code -->|登记规则且有次数| Delay[等待 3 秒]
  Delay --> Check[复核身份 权限 停止与新输入]
  Code -->|未登记或耗尽| Final[交回实际最终结果]
  Check --> Next[同聊天内部提示的新运行]
  Next --> Terminal
  Next -->|成功| Done[展示最终结果]
  Next -->|发送未知| Unknown[保留原身份并精确核验]
```

Main 先登记桌面发送与 key、物理 SID、lifecycle revision、客户端代次的关联，再允许输入。
只接受精确原生整轮 `executionSettled:true` 终态；chat final、空闲和 Stop ACK 不替代结算。
丢失实时事件时，精确 `agent.wait` 结果使用独立证明类型，不制造 agentSeq。

Runtime Services 的只读 `runtimeServices.executionFailure`
使用公开 Session Store/Transcript API，核对读取前后的 SID/revision，只返回指定 run
最后一条 assistant 的结构化错误码及 `identityMatched`。不缓存原始报错、聊天正文或参数。
读取有界，失败则保留普通失败行为。

读回确认 `identityMatched:true` 后，已有 transcript 错误码优先。上下文溢出使用同一运行的
整轮 lifecycle 证据，要求 `phase:error`、`executionSettled:true`、`livenessState:blocked` 和
`errorObservation.failoverReason:context_overflow`，排除取消和超时。OpenClaw 也可能在
压缩本身因上下文不足而失败时保留该观测。一般压缩错误、尝试结束和只有 `agent.wait`
失败状态的结果缺少这一证据。OpenClaw 先完成自己的压缩与恢复，Main 再决定是否派发续跑。
压缩后若物理会话身份已变，现有身份校验会放弃本次应用侧续跑。

读取许可失效有时只发布 `chat.error`。固定文案可唤起一次 `agent.wait` 查询，随后必须取得
精确 run 的已结束失败结果、同一原生 SID/revision 和当前 `lastRunId`。当前锁定运行时的
失败回执未公开细分错误码，Main 通过有界 `chat.history` 读取当前分支：要求已保存用户输入
有精确的原生输入幂等键，并核对其后的 `run-failed-before-reply` 自定义回执确属同一 run，
正文精确匹配这一种原生拒绝。发送前再次复核 `lastRunId`，避免旧错误接管较新的运行。
错误气泡和助手正文均不能单独触发续跑。原始输入无需重新发送。

发送前重新准备当前工作目录和权限，复核原始发送归属、key、SID、revision、客户端代次及
活动运行。沿用现有 `agent` RPC，传入 `expectedExistingSessionId`、
`expectedExistingSessionLifecycleRevision`、稳定幂等键、`internal_system` provenance
和 `suppressPromptPersistence:true`。新运行保留正常可见生命周期；固定反馈不产生用户气泡。
原生跳过续跑提示词的用户消息持久化。若实时消息更新或历史响应仍带有标记为
`internal_system` 的用户消息，聊天按原生来源过滤。用户手动发送相同文字时仍正常显示。

次数属于同一业务请求的整条链。run ID 变化、部分工具成功、A 规则切换 B 规则均不重发
额度。未知 ACK 也消耗次数，保留原始认领和幂等身份，仅核验原运行，不盲目重发。
Stop、新输入、实例或连接变化取消后续派发；未知原生发送仍须等待实际证据。
重启不从历史错误重建自动执行。

## 与 Goal 的组合

通用协调器不导入 Goal，不采用其提示、授权字段、重试方法或计数。
普通桌面聊天开启或关闭 Goal 都可使用同一规则。Main 按精确前驱认领唯一后继，认领早于
异步错误查询；Goal 在实际发送前也核验认领，避免两套策略各续跑一次。

技术交接保留 Goal 的业务计数、退避次数、目标实例与前驱，不当作新用户请求重置状态。
明确未发送时回滚交接并交回原始结果；未知 ACK 不回滚。链的最终实际结果交回原业务
owner。Goal 对同一步的业务重试继承已消耗的通用次数；独立准入的新步骤才有新额度。

## 展示与存储

Renderer 按 Main 的精确运行关联隐藏待核验和续跑中的报错。续跑过程中显示执行状态，
发送结果未知时显示执行状态核对，待精确结果确认后收敛。
额度耗尽、规则不匹配或确认无法发送时，只显示最后一次实际失败。续跑成功时，中间失败
仍保留在原生历史和诊断，聊天保留有效的部分回复、工具活动、文件和媒体。

已有 `cowork_session_runs` 的可空 `automatic_error_retry` 字段保存无正文关联，只服务呈现，
不建立 transcript 缓存或执行恢复权威。刷新历史、切回和重连可恢复已确认处理的失败关联；
应用重启后从持久元数据恢复已被取代的失败关联。对仍未取得整轮结算的候选错误，Main
在 10 秒核验窗口结束后终止该次续跑资格，再显示原失败。已认领续跑的运行及发送结果
未知的运行由其实际结果决议。Renderer 的计时器仅限制元数据加载等待。

## 范围与验证边界

当前只接入能证明普通桌面发送归属及准备身份的执行，包括其已准入的 Goal 后继。
ACP 完成回传、子代理、Agent Team、Swarm、cron、外部客户端及原生子任务回报触发的
主会话运行由各自原生 owner 处理。原生主会话回报续跑的公开事件缺少精确前驱关系，且运行
结束后原生投递仍可能排队重试。仅凭同一会话或空闲状态接管会与原生调度竞争。

续跑已收到接纳回执后，界面依赖原生整轮终态收敛。如果失败仅通过原生 `agent` 的后续 RPC
响应返回，当前连接可能持续显示续跑状态，直至精确执行结果经事件或读回确认。

测试覆盖规则与共用预算、旧设置、实际 Main 准备与错误延后、内部发送、拒绝/未知 ACK、
停止与身份竞态、先终态后 ACK、`agent.wait`、Goal 单后继和计数，以及实际聊天组件的
首次错误绘制、历史接管、工具/文件/部分正文保留和最终错误放开。

尚未使用与本次源码一致的冻结运行包执行真实 Gateway + 合成模型端到端验证。
单元/集成测试及源码核对不替代此项验证或安装包验收。

[返回执行控制](README.md)
