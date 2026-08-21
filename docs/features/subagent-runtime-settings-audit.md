# Subagent 与 Agent Runtime 可配置参数审计

> 审计基线：JustDo `v2026.8.12`、OpenClaw `v2026.7.1-2`、提交
> `9726cea6`。审计日期：2026-08-20；第一版设置实现更新：2026-08-21。

本文回答三个问题：

1. 当前 Subagent 到底有哪些公开配置参数；
2. JustDo 当前实际写入的值与 OpenClaw 原生默认值有什么区别；
3. 哪些参数适合进入设置页，哪些应继续作为内部实现细节。

本文同时记录参数审计与第一版设置实现边界。未进入第一版的参数仍作为后续设计依据。

## 结论摘要

OpenClaw 的 `agents.defaults.subagents` 当前有 **11 个公开配置字段**。JustDo 第一版始终
显式写入 6 个字段，并在用户选择后额外写入 `model` / `thinking`：

| 字段                  |     JustDo 当前值 |
| --------------------- | ----------------: |
| `maxConcurrent`       |               `3` |
| `maxChildrenPerAgent` |               `5` |
| `maxSpawnDepth`       |               `1` |
| `runTimeoutSeconds`   |  `7200`（2 小时） |
| `archiveAfterMinutes` | `0`（不自动归档） |
| `delegationMode`      |         `suggest` |

Subagent 模型和 thinking 默认跟随调用者；用户可在设置页选择固定值。未开放的
`allowAgents`、`requireAgentId` 与 `announceTimeoutMs` 继续使用 OpenClaw 默认语义。

设置页第一版已经开放：

- Subagent 默认模型；
- Subagent 默认 thinking；
- 全局并发数；
- 单父会话活动 child 上限；
- 单个 child 运行超时；
- 委派倾向（建议使用 / 优先使用 Subagent）。

嵌套深度 `1 / 2` 已放进折叠的“高级调度”。跨 Agent allowlist 和工具权限适合后续继续
放进高级设置。归档时间目前不宜直接
开放，因为 JustDo 的永久 Subagent 历史依赖 `archiveAfterMinutes: 0`。announce timeout
主要影响非托管完成通知与异常恢复，并不是 JustDo 托管会话正常 Join 路径的等待上限，
不应在基础设置中用“Subagent 超时”这种容易混淆的名称展示。

## 参数层级

Subagent 相关参数存在四个不同层级，设置设计不能把它们混为一谈：

1. `agents.defaults.subagents`：Gateway 全局默认值；
2. `agents.list[].subagents`：指定 Agent 的覆盖值；
3. `sessions_spawn` 参数：模型在某次 Tool Call 中为单次任务选择的值；
4. OpenClaw / JustDo 内部常量：重试、轮询、恢复和 UI 缓存参数，不属于公开配置。

优先级通常为：单次 `sessions_spawn` 参数 > 每 Agent 覆盖 > 全局默认 > OpenClaw
内置默认。不过并不是每个字段都支持全部层级。

## `agents.defaults.subagents` 完整字段

### 字段总表

| 字段                  | 类型与 schema 约束                    | OpenClaw 默认 | JustDo 产品默认            | 每 Agent 覆盖 | 状态       |
| --------------------- | ------------------------------------- | ------------- | -------------------------- | ------------- | ---------- |
| `delegationMode`      | `suggest \| prefer`                   | `suggest`     | `suggest`（显式写入）      | 支持          | 第一版开放 |
| `allowAgents`         | `string[]`                            | 仅当前 Agent  | 仅当前 Agent（未显式写入） | 支持          | 高级设置   |
| `maxConcurrent`       | 正整数，无 schema 上限                | `8`           | `3`                        | 不支持        | 第一版开放 |
| `maxSpawnDepth`       | 整数 `1..5`                           | `1`           | `1`                        | 不支持        | 高级设置   |
| `maxChildrenPerAgent` | 整数 `1..20`                          | `5`           | `5`                        | 不支持        | 第一版开放 |
| `archiveAfterMinutes` | 整数 `>= 0`，`0` 表示关闭             | `60`          | `0`                        | 不支持        | 暂缓开放   |
| `model`               | 模型字符串或 `{ primary, fallbacks }` | 跟随调用者    | 跟随调用者                 | 支持          | 第一版开放 |
| `thinking`            | 字符串，实际可选值取决于模型          | 跟随调用者    | 跟随调用者                 | 支持          | 第一版开放 |
| `runTimeoutSeconds`   | 整数 `>= 0`，`0` 表示无限             | `0`           | `7200`                     | 不支持        | 第一版开放 |
| `announceTimeoutMs`   | 正整数毫秒                            | `120000`      | `120000`（未显式写入）     | 不支持        | 开发者设置 |
| `requireAgentId`      | boolean                               | `false`       | `false`（未显式写入）      | 支持          | 高级设置   |

“OpenClaw 默认”和“JustDo 恢复默认”必须在 UI 文案中明确区分。用户点击 JustDo 的
“恢复默认”后，应恢复上表的 JustDo 当前有效值，而不是切换成 OpenClaw 的 8 并发、
无限运行时间和 60 分钟归档。

### `maxConcurrent`

- 控制原生 Subagent 专用 `subagent` lane 中同时实际执行的 child 数量；
- 是整个 Gateway 的全局上限，不是每个父会话各自拥有的额度；
- 超出的已接受原生 child 保持 `pending`，排队时不占模型推理槽位；
- ACP child 不占这个 native lane，其并发由 `acp.maxConcurrentSessions` 控制；
- OpenClaw schema 只要求正整数，没有上限。设置页建议限制为 `1..16`，超过 `8` 时提示
  模型费用、速率限制、内存和工具进程压力。

当前 JustDo 值为 `3`，低于 OpenClaw 原生默认 `8`。

### `maxChildrenPerAgent`

- 控制一个父会话拥有的活动 child 总数；
- `pending`、`running` 和正在初始化但尚未登记的 reservation 都计入；
- 达到上限后，新的 `sessions_spawn` 返回 `forbidden`，而不是继续排队；
- 该限制按父会话隔离；
- 原生 Subagent 和 ACP child 都受该父级准入限制；
- schema 范围是 `1..20`。

JustDo 的原子准入补丁保证同一批并发 spawn 不会越过这个上限。当前值为 `5`。当
`maxConcurrent = 3`、`maxChildrenPerAgent = 5` 且没有其他父会话竞争时，典型状态是
3 个 running、2 个 pending。

### `maxSpawnDepth`

- `1`：主 Agent 可以创建 child，child 不能继续创建 Subagent；
- `2`：允许 main → orchestrator → worker；
- schema 支持 `1..5`，但 OpenClaw 文档建议通常最多使用 `2`；
- 深度大于 1 会改变 child 的角色和工具能力。中间层 orchestrator 可获得受限的
  `sessions_spawn`、`subagents`、`sessions_list`、`sessions_history`；叶节点不能继续派生；
- 修改只应影响之后创建的 child，不能尝试提升已经固化在 session metadata 中的角色。

设置页应默认只提供“关闭嵌套（1）/ 允许一层 worker（2）”。如果以后允许 `3..5`，应放在
开发者模式并给出扇出量提示：最坏活动节点数会随每层 child 上限快速增长。

### `runTimeoutSeconds`

- 控制单个 child 的实际运行时间；
- `0` 表示无限；
- JustDo 当前为 `7200` 秒；
- 由于 pending lifecycle 补丁，计时从 Gateway 观察到 child 的 lifecycle `start` 后开始，
  lane 排队时间不消耗运行预算；
- 超时只停止 run，不自动删除 session；
- 当前公开的 `sessions_spawn` Tool Schema **不接受单次 timeout 覆盖**，因此它是全局设置，
  不是模型每次 spawn 可自由修改的参数；
- ACP spawn 也使用这个默认值，但 ACP 后端可能有自己的上限。

设置页可提供“15 分钟 / 30 分钟 / 1 小时 / 2 小时 / 自定义 / 无限制”，恢复默认是
2 小时。自定义值建议限制为 `60..86400` 秒，`0` 作为单独的“无限制”选项，避免用户把
毫秒误填成秒。

### `archiveAfterMinutes`

- OpenClaw 公开文档将它定义为 child 完成后自动归档的延迟；
- `0` 关闭自动归档；
- `cleanup: "delete"` 仍会在完成通知后立即归档；
- 归档会调用 `sessions.delete`，并把 transcript 重命名为带删除时间戳的文件；
- Gateway 重启会丢失内存中的待执行归档 timer，因此归档是 best-effort；
- run timeout 与归档相互独立。

JustDo 当前显式设置为 `0`，并通过分页 `sessions.list` 保持永久 Subagent 历史入口。
如果用户改成正数，当前 UI 的持久历史可能在归档后消失。因此应先设计“已归档
Subagent 历史”的查询和展示，再开放此项。

本次审计还发现一个必须先澄清的 runtime contract 差异：OpenClaw 公开文档称正数会自动
归档完成的 run-mode Subagent，但当前打包 runtime 在登记时只为 `cleanup !== "keep"` 的
run 写入 `archiveAtMs`，而公开 Tool Schema 的默认 cleanup 又是 `keep`。因此正数对默认
`keep` run 是否应生效，文档与 `v2026.7.1-2` 实现并不一致。设置功能不能只按文档接线；
应先补一个正数归档的集成测试，并根据结果修复或上游化该契约。

### `model`

- 未设置时，原生 child 继承调用者模型；
- 可设置单个 `provider/model`，也可设置 `{ primary, fallbacks }`；
- `agents.list[].subagents.model` 可覆盖全局默认；
- 单次 `sessions_spawn.model` 优先级最高；
- 单次传入无效模型时，OpenClaw 会发出警告并退回默认模型；
- ACP child 有配置时也使用此模型，否则由 ACP harness 使用自己的默认值。

UI 建议提供“继承父 Agent”和当前已配置模型列表。不要允许自由文本绕过模型目录，且保存前
要验证 fallback 引用仍然存在。这个字段对成本和速率限制的价值很高，适合第一版开放。

### `thinking`

- 未设置时继承调用者；
- 支持全局、每 Agent 和单次 spawn 覆盖；
- schema 本身是字符串，但有效值受 provider/model 能力约束；
- 常见值包括 `off`、`minimal`、`low`、`medium`、`high`、`xhigh`、`adaptive`、
  `max`、`ultra`，并非每个模型都支持全部值。

当前 JustDo 模型目录没有可靠的 thinking 档位元数据，因此第一版只能展示 OpenClaw 接受的
受限枚举，并始终保留“继承”选项；界面应提示具体档位取决于模型，不确定时保持继承。后续模型
目录接入该元数据后，再根据选中的 Subagent 模型过滤。不要把任意字符串直接写入配置。

### `delegationMode`

- `suggest`：保留标准的“较大或较慢任务可使用 Subagent”提示；
- `prefer`：更强地提示主 Agent 作为协调者，将非直接回复类工作优先委派；
- 它只改变 prompt guidance，不改变工具权限，也不保证模型一定委派；
- 支持每 Agent 覆盖。

这个字段适合用用户语言展示为“按需使用 / 优先委派”，不要用“强制委派”。

### `allowAgents` 与 `requireAgentId`

`allowAgents` 控制 `sessions_spawn.agentId` 可以指向哪些已配置 Agent：

- 未配置时只能使用调用者自己；
- `['*']` 允许任意已配置 Agent；
- stale id 会被拒绝；
- 若列表存在且仍需要显式选择调用者自身，列表中也必须包含调用者 id；
- sandboxed requester 不能选择会在非 sandbox 环境中执行的目标。

`requireAgentId: true` 会拒绝没有显式 `agentId` 的 spawn，用于强制模型选择一个明确的
Agent profile。两者均支持每 Agent 覆盖。

它们会扩大身份、workspace、模型、工具与认证的可达范围，应放在高级设置，并使用 Agent
多选器，不接受任意文本。`['*']` 需要单独风险确认。

### `announceTimeoutMs`

- 是一次 Gateway `agent` completion announce 调用的超时，不是 child run timeout；
- OpenClaw 默认 `120000` 毫秒；
- transient retry 会让总等待时间超过单次 timeout；
- JustDo 托管会话正常使用同一父 run 内的 `sessions_yield` 增量 Join，不依赖 completion
  announce 启动新的父模型回合；
- 该参数仍影响非 JustDo 会话、嵌套/异常恢复和原生 completion delivery fallback。

基础 UI 不应显示它。若放入开发者设置，名称应是“完成通知单次超时”，建议范围
`5000..600000` 毫秒，并在输入框明确单位。

## Subagent 工具权限伴随配置

Subagent 还有一个不在 `agents.defaults.subagents` 下的权限块：

```json5
{
  tools: {
    subagents: {
      tools: {
        allow: [],
        alsoAllow: [],
        deny: [],
      },
    },
  },
}
```

| 字段        | 作用                                                    |
| ----------- | ------------------------------------------------------- |
| `allow`     | 将最终 Subagent 工具集收窄为 allow-only 集合            |
| `alsoAllow` | 与显式 allow 合并，并参与 Subagent 角色 deny 的例外计算 |
| `deny`      | 额外移除工具；deny 冲突时优先                           |

该块不能可靠地恢复在更早的 tool profile、provider、Agent、channel、sandbox 或父级继承策略中
已经移除的工具。`message` 还会在 spawn 时单独禁用。工具策略的组合优先级复杂，建议未来复用
现有权限 UI 的“有效工具预览”，不要提供三个自由文本数组。

当前 JustDo 没有写入这个块，Subagent 使用父级有效策略再叠加 OpenClaw 的角色限制。

## `sessions_spawn` 附件配置

当前 runtime 还提供一组与 Subagent Tool Call 配套的附件开关：

```json5
{
  tools: {
    sessions_spawn: {
      attachments: {
        enabled: false,
        maxTotalBytes: 5242880,
        maxFiles: 50,
        maxFileBytes: 1048576,
        retainOnSessionKeep: false,
      },
    },
  },
}
```

| 字段                  |  默认值 | 作用                                 |
| --------------------- | ------: | ------------------------------------ |
| `enabled`             | `false` | 是否允许 inline attachment           |
| `maxTotalBytes`       |   5 MiB | 一次 spawn 的附件总大小上限          |
| `maxFiles`            |    `50` | 文件数量上限                         |
| `maxFileBytes`        |   1 MiB | 单文件大小上限                       |
| `retainOnSessionKeep` | `false` | `cleanup: "keep"` 时是否保留物化文件 |

原生 Subagent 的附件会写到 child workspace 的 `.openclaw/attachments/<uuid>/`；ACP 只接受
图片附件。内容在 transcript persistence 中会被遮蔽，目录/文件权限也会被收紧，但开启该功能
仍然扩大了模型可写入磁盘的数据面。建议作为高级功能整体开关，大小限制使用上述默认值，不在
第一版提供任意 mount path 默认值。

## `sessions_spawn` 单次 Tool Call 参数

这些是模型在执行过程中决定的任务参数，不应全部变成全局设置。设置页只需要为其中少数字段
提供默认值或策略约束。

| 参数              | 类型 / 默认                          | 说明                                      | 适合作为设置             |
| ----------------- | ------------------------------------ | ----------------------------------------- | ------------------------ |
| `task`            | string，必填                         | 委派任务正文                              | 否                       |
| `taskName`        | string                               | 稳定 handle，匹配 `[a-z][a-z0-9_-]{0,63}` | 否                       |
| `label`           | string                               | 人类可读标签                              | 否                       |
| `agentId`         | string                               | 目标 Agent，受 allowlist 约束             | 只配置策略               |
| `cwd`             | string                               | child 工具工作目录                        | 否                       |
| `runtime`         | `subagent \| acp`，默认 `subagent`   | 原生或 ACP runtime                        | 暂不开放                 |
| `resumeSessionId` | string                               | 仅 ACP，恢复 harness session              | 否                       |
| `streamTo`        | `parent`                             | 仅 ACP，流式输出到父会话                  | 否                       |
| `model`           | string                               | 单次模型覆盖                              | 配置默认和允许范围       |
| `thinking`        | string                               | 单次 thinking 覆盖                        | 配置默认和允许范围       |
| `thread`          | boolean，默认 false                  | 请求 channel thread binding               | 否                       |
| `mode`            | `run \| session`，默认 `run`         | thread session 持久模式                   | 否                       |
| `cleanup`         | `delete \| keep`，默认 `keep`        | 完成后立即归档或保留                      | 可配置策略，不建议第一版 |
| `sandbox`         | `inherit \| require`，默认 `inherit` | 要求目标必须 sandboxed                    | 可配置安全策略           |
| `context`         | `isolated \| fork`，默认 `isolated`  | 清洁上下文或复制父 transcript             | 可配置默认策略           |
| `lightContext`    | boolean，默认 false                  | 原生 Subagent 使用轻量 bootstrap context  | 可作为成本优化高级项     |
| `attachments`     | 最多 50 个附件对象                   | inline 文件；需配置显式启用               | 只配置能力和上限         |
| `attachAs`        | `{ mountPath? }`                     | 指定附件在 child 中的挂载位置             | 否                       |

thread-bound spawn 在未显式指定 context 时会默认使用 `fork`。`fork` 会增加上下文与 token
消耗，因此如果未来增加默认 context 设置，应保持 `isolated` 为产品默认，并明确解释隐私与成本。

`attachments` 的元素结构是 `{ name, content, encoding?, mimeType? }`，其中 encoding 只能是
`utf8` 或 `base64`。当前生成的 runtime Tool Schema 合计包含上述 **18 个公开参数**。其中
`thread` 仅在当前 channel 支持 thread binding 时出现，`resumeSessionId` / `streamTo` 仅在
ACP 可用时出现。runtime 内部还会传递 `expectsCompletionMessage`、`runTimeoutSeconds` 等参数，
但它们没有出现在模型可见的 Tool Schema 中，不应作为“单次 Tool Call 参数”提供给用户。

## Thread binding 伴随配置

持久 thread-bound Subagent 还受以下 session 配置控制：

| 字段                                 | 作用                    |
| ------------------------------------ | ----------------------- |
| `session.threadBindings.enabled`     | 是否启用 thread binding |
| `session.threadBindings.idleHours`   | 空闲多久后自动 unfocus  |
| `session.threadBindings.maxAgeHours` | binding 的绝对最长寿命  |

各 channel 还有 `threadBindings` 和 `spawnSessions` 覆盖项。当前 JustDo 暂未适配 IM channel，
这些字段不应进入第一版桌面设置；等 channel/thread 功能恢复时再按 channel 展示，而不是放在
通用 Subagent 并发设置旁。

## ACP Subagent 的独立参数

如果未来在 JustDo 中正式启用 `runtime: "acp"`，还需单独处理以下参数，而不能误认为
`maxConcurrent` 对 ACP 同样生效：

| 字段                                 | 作用                                     |
| ------------------------------------ | ---------------------------------------- |
| `acp.enabled`                        | ACP 总开关                               |
| `acp.dispatch.enabled`               | ACP turn dispatch 开关                   |
| `acp.backend` / `fallbacks`          | 主 backend 与 fallback backend           |
| `acp.defaultAgent` / `allowedAgents` | 默认 harness Agent 与 allowlist          |
| `acp.maxConcurrentSessions`          | ACP session 并发上限                     |
| `acp.runtime.ttlMinutes`             | 空闲 worker 回收时间                     |
| `acp.stream.*`                       | 合并间隔、chunk 大小、输出上限和投影策略 |

当前 Subagent 设置页应只控制 native Subagent；ACP 未被产品化前不应混入同一组控件。

## 运行时内部常量

以下值会影响观测到的 Subagent 生命周期，但不是 OpenClaw 公开配置。它们适合日志诊断和测试，
不适合直接暴露给普通用户。

| 内部行为                               |                      当前值 | 是否建议开放 |
| -------------------------------------- | --------------------------: | ------------ |
| 未结束 run 的基础 stale window         |                      2 小时 | 否           |
| 有显式 run timeout 时的 stale grace    |                       60 秒 | 否           |
| 已结束 child 的 recent window          |                     30 分钟 | 否           |
| registry sweep 周期                    |                       60 秒 | 否           |
| early lifecycle start 记录 TTL         |                      5 分钟 | 否           |
| pending lifecycle terminal TTL         |                      5 分钟 | 否           |
| lifecycle error/timeout retry grace    |                       15 秒 | 否           |
| 缺少 live run context 的 active grace  |                       60 秒 | 否           |
| direct announce transient retry delay  | 5、10、20 秒，最多 4 次调用 | 否           |
| registry announce retry delay          |       1、2、4 秒，上限 8 秒 | 否           |
| registry announce 最大 attempt count   |                           3 | 否           |
| 普通 announce expiry                   |                      5 分钟 | 否           |
| completion hard expiry                 |                     30 分钟 | 否           |
| frozen completion text 上限            |                     100 KiB | 否           |
| managed `sessions_yield` Join 检查间隔 |                     50 毫秒 | 否           |
| JustDo Subagent 实时查询 recent window |                     24 小时 | 否           |
| JustDo Subagent 状态缓存               |                        8 秒 | 否           |

stale window 的实际判断是“2 小时，或显式 run timeout 加 60 秒，取更长者”。因此 JustDo
当前 2 小时 run timeout 的 stale 边界约为 2 小时 1 分钟。修改公开 run timeout 已经会间接改变
该边界，不需要再开放 stale 参数。

这些内部值与恢复正确性、幂等 delivery、Gateway 重启和 UI 抖动控制绑定。把它们变成设置会
形成难以测试的参数组合，并可能破坏完成通知的 exactly-once-like 边界。

## 其他值得考虑的 Agent Runtime 设置

以下项目不是 Subagent 字段，但确实会影响成本、吞吐、保留周期或长任务稳定性。

### 建议进入同一个“Agent Runtime”设置区

| 参数                             |     OpenClaw 默认 |           JustDo 当前值 | 建议优先级 | 说明                                              |
| -------------------------------- | ----------------: | ----------------------: | ---------- | ------------------------------------------------- |
| `agents.defaults.maxConcurrent`  |               `4` |             `4`（隐式） | P1         | 多个主会话并行上限，每个 session 内仍串行         |
| provider `timeoutSeconds`        |       通常 `120s` |                 `1800s` | P1         | 慢模型单次请求 idle timeout，适合按 provider 配置 |
| `cron.maxConcurrentRuns`         |               `8` |                     `3` | P1         | 定时任务外层和 `cron-nested` 模型执行并发         |
| `session.maintenance.pruneAfter` | OpenClaw 默认策略 |                  `365d` | P1         | 会话记录保留时长                                  |
| `session.maintenance.maxEntries` | OpenClaw 默认策略 |                   `500` | P1         | session store 最大条目数                          |
| `cron.sessionRetention`          | OpenClaw 默认策略 |                    `7d` | P2         | 定时任务 session 保留时间                         |
| 主 Agent heartbeat interval      |             `30m` |                    `2h` | P2         | JustDo 用于托管后台唤醒；应以产品语义展示         |
| App 日志保留                     |               N/A | 7 天、单日志上限 80 MiB | P2         | 属于存储管理，不是 Gateway Agent 参数             |

provider timeout 与 Subagent run timeout 是两个不同层次：前者限制一次模型请求的空闲等待，
后者限制整个 child run。应允许 provider timeout 小于 run timeout，但保存时提示如果前者过短，
长上下文或慢推理请求会在 child 总预算尚未用完时先失败。

### 已经存在用户设置，不应重复

- 模型 provider、模型选择；
- 模型 context length；
- 模型最大输出 token；
- working directory；
- execution mode / sandbox；
- permission mode；
- browser mode。

新的 Runtime 页面应复用这些数据源和选择器，而不是维护第二份模型或权限配置。

### 不建议直接开放的受管参数

| 参数组                           | 当前策略                                                                     | 原因                                                                                         |
| -------------------------------- | ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| compaction                       | Codex-local 90% trigger、24k reserve、mid-turn precheck、memory flush off 等 | 与版本补丁、恢复和上下文溢出收敛强耦合；建议以后只提供经过测试的 preset                      |
| `diagnostics.stuckSession*`      | 10 分钟告警、40 分钟 abort                                                   | 托管 chat 使用无 Gateway deadline，并由 JustDo lifecycle/Stop 负责终态；普通用户难以正确判断 |
| Gateway boot/restart timeout     | boot 300 秒、最多 5 次重启                                                   | 运维自愈参数，错误值会使应用无法启动                                                         |
| WebSocket tick、UI polling/cache | 多组秒级常量                                                                 | 只影响连接检测和 UI 新鲜度，开放后容易制造抖动或额外轮询                                     |
| announce retry/Join commit 参数  | 见内部常量表                                                                 | 影响幂等、恢复和 transcript commit 边界                                                      |
| skills prompt limits             | 200 skills / 50,000 chars                                                    | 防止 prompt 膨胀的产品安全阀                                                                 |

如果确实要给高级用户控制 compaction，优先提供“保守 / 平衡 / 更少压缩”之类的版本化 preset，
不要暴露所有 raw 字段。每个 preset 必须与当前 OpenClaw patch 版本一起测试和迁移。

## 推荐的设置页信息架构

### Subagent 基础设置

1. 使用倾向：按需使用 / 优先委派；
2. 默认模型：继承父 Agent / 已配置模型；
3. Thinking：继承 / OpenClaw 支持的受限枚举（模型能力元数据接入后过滤）；
4. 同时运行的 Subagent：默认 3；
5. 每个任务最多活动 Subagent：默认 5；
6. 单个 Subagent 最长运行时间：默认 2 小时。

### Subagent 高级设置

1. 允许一层嵌套编排：默认关闭；
2. 可作为 child 的 Agent allowlist；
3. 强制每次显式选择 Agent；
4. Subagent 工具权限预览与收窄；
5. 要求 sandbox；
6. 默认 context：isolated / fork；
7. 轻量 context；
8. inline 附件总开关与大小上限；
9. 完成通知单次超时：仅开发者模式；
10. 自动归档：等 runtime contract 与已归档历史 UX 完成后再提供。

### 其他 Runtime 设置

1. 主会话全局并发；
2. provider 请求 idle timeout；
3. 定时任务并发与保留时间；
4. 会话历史保留时长与数量；
5. 日志保留策略。

所有数字项应同时显示单位、JustDo 默认值和影响说明。并发项应显示“运行中 / 排队中”的区别；
timeout 项应明确是“模型请求”“整个 child run”还是“完成通知”。

## 保存、校验与生效语义

### 配置所有权

不要让设置页直接修改 `openclaw.json`。完整配置同步会用 `managedConfig` 重建受管配置，手工
写入的 Subagent 字段会在后续同步中丢失。

第一版采用：

1. 在 shared 层定义版本化的 `AgentRuntimeSettings` contract 和默认值；
2. 在 SQLite `cowork_config` 的版本化 key `agentRuntimeSettings:v1` 中保存 JustDo 拥有的设置；
3. Main IPC 严格校验并保存；
4. `openclawConfigSync` 从该设置生成完整和最小配置中的 `agents.defaults.subagents`；
5. 同步失败时恢复上一份 SQLite 设置并重新生成配置；
6. Renderer 只通过 preload bridge 读写，不接触 OpenClaw 文件。

配置中要保存用户选择，不要只保存与默认值的差异，否则产品默认调整后老用户会静默改变行为。
同时记录 schema version，便于 OpenClaw 升级后迁移范围或枚举。

### 生效范围

| 字段                                               | 预期生效时机                                            |
| -------------------------------------------------- | ------------------------------------------------------- |
| `maxChildrenPerAgent`、allowlist、`requireAgentId` | 后续 spawn admission                                    |
| `maxConcurrent`                                    | 后续 lane 调度；已运行 child 不应被终止                 |
| `model`、`thinking`、`runTimeoutSeconds`           | 后续新建 child；已登记 run 保留 spawn 时快照            |
| `maxSpawnDepth`                                    | 后续新建 child；现有 session role 不变                  |
| `archiveAfterMinutes`                              | 后续登记的归档计划；不能承诺追溯修改已有 timer          |
| `announceTimeoutMs`                                | 后续 delivery attempt                                   |
| 工具策略                                           | 至少后续 child；对已存在 child 的收窄行为需单独集成测试 |

OpenClaw 将 `agents` 配置归类为动态变更，但仍需补充集成测试，确认 lane concurrency 在当前
版本的 config reload 后确实更新。保存成功提示必须区分“已保存”“Gateway 已应用”和“需要等待
当前任务结束”。

### 跨字段校验

- `maxChildrenPerAgent >= maxConcurrent` 不是硬约束；较小值是合法的，但应提示实际并发会被
  child 上限进一步压低；
- 开启嵌套后，提示潜在总扇出与成本；
- Subagent 模型删除时回退为“继承”，不能留下 stale ref；
- thinking 的有效档位取决于最终模型；能力元数据不可用时应建议继承，不能假称已验证兼容；
- provider timeout 大于或等于 run timeout 并非错误，但通常没有额外价值；
- `archiveAfterMinutes > 0` 必须提示历史入口可能消失；
- `allowAgents: ['*']`、扩大工具权限、默认 `fork` context 应要求风险确认。

## 测试清单

实现设置功能时至少覆盖：

1. 默认值、边界值、单位转换和 reset；
2. SQLite 持久化与旧版本迁移；
3. 全配置同步后字段不丢失；
4. auth login/logout 的 scoped sync 不覆盖 runtime settings；
5. config reload 成功、失败和需要重启的 UI 状态；
6. 3/5 并发准入、降低并发时不杀死 active child；
7. pending 时间不计入 run timeout；
8. 新 timeout 只影响新 run；
9. 模型删除、provider logout 和 thinking 不兼容时的回退；
10. nesting depth 1/2 的工具能力与 cascade stop；
11. allowlist、sandbox guard 和 `requireAgentId`；
12. archive 开关对 SubagentMenu 永久历史的影响；
13. `archiveAfterMinutes > 0` 配合默认 `cleanup: "keep"` 的真实契约；
14. inline attachment 的开关、数量、单文件/总大小、清理与 transcript redaction；
15. Gateway 重启后的 registry 恢复；
16. 托管 `sessions_yield` Join 与非托管 announce fallback 均不回归。

## 审计依据

主要实现入口：

- `src/main/openclaw/config/openclawConfigSync.ts`：JustDo 写入的有效默认值；
- `src/main/engine/openclaw/openclawRuntimeAdapter.ts`：托管 turn watchdog、状态缓存；
- `src/main/engine/openclaw/subagentGateway.ts`：24 小时实时窗口与永久历史投影；
- `scripts/patches/v2026.7.1-2/013-atomic-sessions-spawn-admission.cjs`：原子准入；
- `scripts/patches/v2026.7.1-2/014-subagent-pending-lifecycle.cjs`：pending/running 与 timeout 起点；
- `scripts/patches/v2026.7.1-2/018-managed-same-run-join.cjs` 至
  `021-managed-join-identity-delivery.cjs`：托管增量 Join；
- `docs/architecture/04-cowork-system.md`：当前 Subagent 生命周期与 UI 契约；
- 打包 runtime 的 `docs/tools/subagents.md`、`docs/gateway/config-agents.md` 和生成的
  `dist/plugin-sdk/config-schema.d.ts`：OpenClaw `v2026.7.1-2` 公开字段与 schema。

OpenClaw 升级时必须重新执行本审计，不能假设字段、默认值、热加载分类或内部恢复常量保持不变。
