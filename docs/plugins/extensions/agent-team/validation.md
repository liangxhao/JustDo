# Agent Team 验证与维护边界

本页区分插件独立业务测试、显式宿主集成、原生探针与真实生产验收。业务契约见[Agent Team](guide.md)，数据恢复见[持久化](persistence.md)，接入边界见[宿主集成](integration.md)。

## 独立包检查

在本包根目录安装已声明的依赖后运行：

```bash
npm run check
npm run build
npm test
```

Node、OpenClaw、SDK 与 React 兼容范围以[package.json](../../../../plugins/extensions/agent-team/package.json)为准。公开 SDK 和构建工具必须作为正常依赖提供，不借应用源码、兄弟仓库或宿主 node_modules 回退。独立测试使用本包 Vitest 配置，UI fixture 只实现调用者拥有的公开端口，不加载 Electron bridge、应用 Store 或宿主聊天实现；可选 SQLite 驱动覆盖规则见[测试说明](../../../../plugins/extensions/agent-team/tests/README.md)。

`tests/host/` 是显式宿主集成 profile，独立 suite 排除该目录。没有宿主时明确跳过，需要集成时显式设置 `APP_PLUGIN_HOST_ROOT`；错误宿主路径或损坏的已存在资料应失败，而不是伪装成未安装。此类集成用例依赖外部宿主，不能因业务包迁仓而被宣称为独立测试。

## 原生与宿主探针

以下入口使用独立状态和合成资料。历史记录仅说明所列产物和 fixture 的验证范围，不表示当前包、当前运行时或真实业务模型自动通过；本页保留这些限制，不依赖宿主仓库的升级报告才能理解。

| 验证入口                                                              | 核对内容                                                             | 证据范围                                                          |
| --------------------------------------------------------------------- | -------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `scripts/native/hot-reenable.native-probe.mjs`                        | 同进程关闭/开启、新 proof、旧 App 绑定拒绝、launch 与 inert holding  | 已有冻结产物隔离证据；使用可信目录测试覆盖，非生产安装信任验收    |
| `scripts/test/verify-group-discussion-runtime.mjs --tool-inheritance` | 成员工具、来源参与、讨论结束后来源继续工具执行、精确终态与汇总 entry | 历史 v2026.10.6 loopback 合成模型证据，不能延续为当前真实模型通过 |
| `scripts/native/agent-team-message-paths.native-probe.mjs`            | 成员单聊、公开群聊、重放不新增调用、bind/dispatch、定点 CAS 清理     | 历史 v2026.10.6 原生链路证据，元数据与权限端口为 fixture          |
| `scripts/native/main-send-admission.native-probe.mjs`                 | 实际 Store/Adapter/Router、定点观察重读、SID/连接变化、注册与清理    | 隔离合成模型；不代表整个生产应用没有后台全局查询                  |

表中脚本路径均相对本包根目录。以上探针均显式依赖集成环境，须设置 `APP_PLUGIN_HOST_ROOT`，
并提供相符的宿主构建、冻结运行时和独立插件产物；原生探针使用所选运行时自带 Node。
热启用探针还核对配套 Workflow 产物和 Required 服务。这些探针随包维护，但不是只安装本包即可独立运行的测试。
不得读取用户资料或把跳过、来源 proof 失效、未运行的用例计为通过。

### 专项探针命令

以下命令从本包根目录运行，仍须先设置 `APP_PLUGIN_HOST_ROOT` 并准备相符的宿主与运行时。
脚本从自身位置解析本插件源码，不搜索兄弟插件仓库，也不通过固定相对路径定位宿主源码。
这些入口保留各自的独立状态和精确身份检查；命令存在不表示本次已执行或已经通过。

| 命令                                                                         | 核对内容与限制                                                                                                                                                                                                                                                                                                                                                                                                    |
| ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `node scripts/openclaw/probe-agent-team-routing.mjs <runtime-directory>`     | 比较普通群广播与保留组织者来源会话的公开 `runGroupThread` 回调。使用临时状态和确定性 dispatcher，不启动 Gateway 或 provider；只断言会话、投递身份与 `toolsAllow` 转发，不证明权限执行、忙会话排队或持久完成投递。                                                                                                                                                                                                 |
| `node scripts/openclaw/probe-agent-team-source.mjs <runtime-directory>`      | 使用隔离 Gateway 和本地 fixture 模型核对来源会话工具限制、排队、取消与投递身份。原 channel 路径是负对照，顶层 `routePreserved=false` 符合预期；internal participation 与 standalone summary 变体必须保留投递与身份。不使用真实 provider 凭据或用户会话。                                                                                                                                                          |
| `node scripts/openclaw/probe-agent-team-peer-return.mjs <runtime-directory>` | 使用本地 fixture 模型、隔离 Gateway 和限定精确会话的 send grant，核对重复 writer 结果会启动真实 organizer 执行，并在并发 history/list 读取下收到 whole-run 终态。调查打包行为时使用目标运行时随附的独立 Node。                                                                                                                                                                                                    |
| `node scripts/openclaw/probe-agent-team-gateway.mjs <runtime-directory>`     | 使用生产 Team 扩展和 Main coordinators，核对模型创建房间、自动汇总、来源参与/mentions、删除来源后公开原生历史保留、关闭后拒绝历史与重新启用后恢复，以及设置资源限制。追加 `--history-toggle-only` 可只检查历史 RPC 注册、关闭后精确已结算收据保留和重新启用后的原生历史恢复；`--cold-start-only` 只检查原生工具执行、工作目录及历史投递。并发指标来自公开原生 lifecycle；排队取消和来源参与共用生产 permit pool。 |
| `node scripts/openclaw/probe-agent-team-settings.mjs <runtime-directory>`    | 使用有界延迟 fixture dispatcher 核对公开 group SDK 的逐请求策略、turn budget、mention 与取消。测量的是 dispatcher 并发，不是真实模型执行或 whole-run 结果。                                                                                                                                                                                                                                                       |
| `node scripts/test/verify-group-discussion-runtime.mjs [runtime-directory]`  | 使用独立状态、loopback 模型及随包 group/summary RPC，核对广播、原生 `NO_REPLY` 不重试空回答、静默轮提前完成、精确 mentions、借用来源身份、来源汇总、整组取消与 provider 失败。产物位于宿主的 `.agent-tasks/runtime/group-mode-native-*/`，不访问用户配置、凭据或历史；只验证原生执行契约，不证明真实模型讨论质量或完整 Main/Renderer 流程。                                                                       |

`node scripts/test/probe-agent-team-ui.cjs` 委托独立构建 Browser 产物探针，使用真实共享 React、
已注册的 Team/Workflow 视图与模式，以及 fixture application/Gateway 端口；不再导入已移除的应用 feature 组件。
Team 原生 send 验证入口是：

```text
node scripts/test/run-send-contracts.cjs --runtime-dir <runtime> --source-root <target-source>
```

历史 Team/Workflow 配对行为和 UI 基线检查位于 `scripts/test/verify-paired-*.mjs`。
这类显式集成场景还要求 `APP_PLUGIN_PROBE_SOURCE_ROOT` 包含两个被测插件，独立于默认 Core 验证命令。
插件源码与这些专项探针都不是构建、启动或测试 Core 应用的必要输入。

Gateway 探针编译宿主当前的真实 Runtime Services 入口及清单，沿用所选冻结运行时的原始 execution profile，
不注册 Team 退休业务 RPC、不修改 profile 或原生产物证明。Team 的保留型数据目录由真实宿主准备服务创建。
历史开关场景在关闭前已完成讨论：它逐项核对通用 Required 收据的 owner、operation、writer、输入摘要、
全部成员 key/SID/revision/run、settledRunIds、outcome 与 cleanupComplete，并与认证 Gateway 的精确
whole-run 终态对应；关闭后须保留同一收据。它只证明已结算收据的保留，不证明关闭期间新结算在途执行。
启停通过原生热应用及独立技能同步完成，要求同一 Gateway 进程和连接、新 Native 注册及旧绑定拒绝。
Windows 沿用生产 polling 模式及 Native 的 30 秒技能树扫描周期，局部文件发现窗口为 40 秒（30 秒周期加 10 秒调度余量），不设置全局短 polling interval；其他平台保留 5 秒窗口。探针从 `skills.status` 的权威 workspaceDir 写入本次隔离技能，核对三次真实内容刷新及 Team 技能仍然发布，并记录每次耗时、扫描周期和最大等待。这不构成 5 秒被动刷新的产品承诺。
探针使用宿主现行 shutdown preload/消息关闭自有 Gateway，正常退出等待上限为 45 秒；超时仅停止仍存活的自有子进程，再有界观察 3 秒，未确认回收则记录 unknown 并退出失败，不按退休 PID 清理进程树。模型服务关闭同样有界，只有正常退出后才输出最终 `ok`。
此场景不执行完整产品 Main disable lease、待发输入取消事务或真实企业模型验收。

2026-11-07 的 Windows 定向复验中，`--cold-start-only` 与 `--history-toggle-only` 均以退出码 0 完成，并确认自有 Gateway 正常关闭。冷启动完成两名成员的真实工具执行和公开历史投递，耗时 6,734 ms；历史开关后的三次文件变更分别在 15,250、366 和 29,845 ms 被实际观察，保持生产扫描周期及严格内容断言。该记录仅覆盖本节所述隔离合成模型与定向场景，不代表完整组织者、产品禁用事务或安装包验收。

## 未完成的生产验收

完整生产群 FIFO、首条消息 viewer 委托、真实 UI/语音、多窗口和权限竞争尚未完成端到端验收。
历史开关探针通过不代表完整组织者流程通过：组织者探针仍在 sender/relay/authorization
联合断言处失败。模型自主组织、讨论内容质量、企业模型工具选择和完整 Main room 流程
也没有被固定响应模型证明。

长期记忆只有 custom-role/隐藏上下文及 FTS 的局部证据；REM/NREM dreaming 和其他原生
管理/channel 恢复入口尚未实际验收。保存房间意图不等于每名成员已准备，accepted、空闲、
Stop ACK 和可见最终文字均不能替代各执行的精确 whole-run 终态与工具清理。
