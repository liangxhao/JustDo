# Goal 模式

Goal 的 objective、token 预算和六种状态由 OpenClaw 原生会话持有。
Main 的 GoalContinuationCoordinator 只协调续跑、等待和停止，不保存消息正文或重造执行器。
自动续跑上限见[运行参数](agent-runtime-settings.md)，权限仍遵循[权限管理](openclaw-permission-management.md)。

## 续跑与不确定发送

只有精确原生整轮 `executionSettled: true` 终态才允许安排下一轮；chat final、单次
attempt 结束、Stop ACK 或空闲投影不能替代执行结算。目标仍 active、没有停止锁时，
Main 准备权限并再次读取原生 Goal，核对 goalId、状态和会话 sessionId/lifecycleRevision。
准备期间暂停、完成或预算耗尽时不发送；准备期间目标身份或原生会话身份被替换时停止自动续跑，等待用户
重新审视。相同 goalId 的文字编辑使用准备后的最新 objective。

续跑使用 backend `agent` RPC，携带原生 expectedExistingSessionId 和
expectedExistingSessionLifecycleRevision，在原生准入时继续限制会话身份。
合成续跑提示不写入原生用户消息历史。ACK 必须包含原运行 ID 和 accepted/in_flight 状态。

发送后超时、回执失配等结果不明确的情况保留同一 runId 和 Main 跟踪，标记
identityPending，不清理运行、不生成新 ID 重发。现有恢复链通过精确 `agent.wait` 核对；
缺失/失配 runId、无终态时间的 timeout 和读取失败都保留未知状态。确认整轮结算后才按
最新 Goal 决定是否另起一轮。明确未发送或原生提交前拒绝仍可按原有退避重试；停止锁和
连接代次变化始终使迟到结果失效。
终态触发的重试始终携带该终态的原生 sessionId，以及该运行已知的 lifecycleRevision；
查询失败、重复退避和停止失败后的恢复都保留这些约束。原生 reset 可沿用 sessionId，
因此已知 revision 不能被重试时的新查询结果覆盖。

## 原生事件准入

Goal 在主聊天 UI 结束后仍需接收迟到的工具和生命周期事件，因此保留独立的、有界于当前
受管会话的运行身份记录。事件必须匹配原生 sessionKey、sessionId、runId 和单调递增的
原生 agent sequence；WS frame 序号或本地补出的序号不能授权
Goal 变更。Main 拥有精确后继运行时才可替换记录；chat final 后只接受已准入运行的后续
事件。旧会话、旧代次、其他运行、重复事件和身份缺失事件不得改变 Goal 或触发续跑。
OpenClaw 10.4 的内部 lifecycleGeneration 不序列化到公共事件，不能将其作为必填字段；
提供该字段时仍检查一致性。连接回调核对当前 client、Main 连接代次和停止标记，拒绝
旧连接迟到事件；清除/删除会话及连接清理同时淘汰运行身份记录。

## 用户操作与回执恢复

编辑、暂停、继续和清除使用原生结构化 Goal RPC，绑定 goalId、原生 sessionId、
operationId 和原始 issuedAtMs。不明确的响应及失配回执保留原操作身份；另一操作必须
先核对该操作，不能跳过未知提交。

INVALID_REQUEST 结合结构化 details.reason 分类。receipt-invalid 和未知 Goal 原因保留
未知语义；expired 将操作退役，不能重发过期请求。下一次显式操作只刷新原生现状并通知
界面，不提交变更；读取失败继续保留退役记录。用户审视刷新结果后再次明确操作，才创建
新身份。operation-conflict、session-rebound、goal-rebound、capacity、invalid 等明确
提交前拒绝可释放原操作。

## 暂停后继续补丁与验证

运行中暂停先停止执行，再修改原生 Goal 为 paused。停止留下 abortedLastRun 标记；
当前补丁 [006](../../../scripts/patches/v2026.10.4/006-goal-resume-after-pause.cjs)
只允许明确 resume 请求通过该标记检查，仍保留空闲、历史、身份、执行归属和排队准入
限制。上游支持同等语义并通过原生回归前保留此补丁。

自动化覆盖发送后 ACK 丢失、失配回执、暂停/替换准备竞态、原生事件隔离、迟到完成回执
和过期操作恢复。合成测试不替代真实模型下的暂停、停止清理、断连和重启组合验收。
