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

## 未完成的生产验收

完整生产群 FIFO、首条消息 viewer 委托、真实 UI/语音、多窗口和权限竞争尚未完成端到端验收。
历史开关探针通过不代表完整组织者流程通过：组织者探针仍在 sender/relay/authorization
联合断言处失败。模型自主组织、讨论内容质量、企业模型工具选择和完整 Main room 流程
也没有被固定响应模型证明。

长期记忆只有 custom-role/隐藏上下文及 FTS 的局部证据；REM/NREM dreaming 和其他原生
管理/channel 恢复入口尚未实际验收。保存房间意图不等于每名成员已准备，accepted、空闲、
Stop ACK 和可见最终文字均不能替代各执行的精确 whole-run 终态与工具清理。
