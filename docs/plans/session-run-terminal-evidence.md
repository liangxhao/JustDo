# 产品运行计时的终态证据收敛

状态：未实施。2026-10-24 发现；整理时复核 `src/main/ipc/cowork/sessions.ts`，下述后备规则仍存在。本文记录产品计时的实现缺口，不改变[执行引擎](../architecture/05-agent-engine.md)要求的终态权威。

## 已确认的缺口

`src/main/ipc/cowork/sessions.ts` 的 `reconcileRuntimeStatus` 仍包含以下后备结算：

| 分支                      | 当前行为                                                                              | 缺少的证据                                              |
| ------------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| 已接纳的计时              | 两次 known-idle 或 root 改变时，可按产品状态结束为 completed/failed                   | 原执行的精确整轮终态                                    |
| Stop / yield 后变空闲     | 可能参与上述状态收敛                                                                  | Stop ACK / 空闲均不证明执行已结算                       |
| 未知准入或缺 `acceptedAt` | 允许 `agent.wait` 省略 `runId`，以 `ok/error` 或带 `endedAt` 的 `timeout` 判 terminal | 精确 run 与 `executionSettled:true`，并排除普通观察超时 |

`sessions.test.ts` 明确覆盖其中的旧规则；它们不是定点查询或 Goal 重放引入的新行为。
只移除两次 idle 分支不足以满足目标契约，wait 后备与 root 替换也必须同时收敛。

这些规则不构成原生 whole-run 证据。不能用产品计时、空闲、本地展示 final、启动 checkpoint
或 Goal 历史重放的展示清理证明执行成功。发送准入和产品计时结算应分别验证。

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
