# 产品运行计时的终态证据收敛

状态：未实施。2026-10-24 的 Team/Swarm 发送复查中发现，独立于本轮发送准入修复。

## 已确认的缺口

`src/main/ipc/cowork/sessions.ts` 的 `reconcileRuntimeStatus` 仍有历史后备规则：
已接受计时在两次 known-idle 后，或原生 root 改变时，可以按产品状态结束为 completed/failed。
Stop ACK 和 yielded 后的空闲也可能参与该收敛。现有 `sessions.test.ts` 明确覆盖这些规则，
因此它们不是新的定点查询或 Goal 重放代码引入的行为。

这些规则不构成原生 whole-run 证据。不能用产品计时、空闲或本地展示 final 证明执行成功。
`SessionRunBegin` 本轮改变的是零时长 aborted restart checkpoint 的查询方式；该启动标记
不是一次实际运行的终态。Goal 历史重放的清理退役本次重复操作的等待和展示投影，
不写入原生 `executionSettled` 回执，也不能作为旧执行完成证据。

## 实施要求

- 原运行只有获得精确 key/SID/run、连接代次与 `executionSettled:true` 的整轮终态后才结束计时。
  新 root 出现不能先结束或覆盖旧运行；证据不足保留未知。
- 优先复用 `getRunTerminalReceipt`；必要的 `agent.wait` 补查必须使用原先已准入的原生绑定，
  前后核对同一 SID/revision 和连接，要求精确 runId、有限 endedAt，排除 yielded、pendingError
  和普通观察超时。不能在冷重启后凭当前会话或 run-ID 形状补造旧绑定。
- 明确未派发的提交可以结束提交等待；缺少 acceptedAt 或 Stop ACK 本身不能证明未派发。
- 不增加 transcript 缓存、不用全局列表为单个输入造终态、不补发未知输入。

## 验收

改写既有“空闲即完成”用例，补充重复空闲、root 替换、Stop/yield、缺绑定、错 SID/run/代次、
补查期间身份或计时改变等负例，均不能 finish 或新建计时覆盖旧回执。正例使用真实精确
整轮终态验证 completed/failed/aborted，以及旧运行确实结算后新 root 的独立记录。
同步更新计时与重启恢复的功能说明，完成后移除此计划并将契约归入架构文档。
