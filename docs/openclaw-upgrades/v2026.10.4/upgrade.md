# OpenClaw v2026.10.4 升级说明

本页记录版本来源、接入决策与依赖适配。测试、复审及阶段产物证据见[验收记录](validation.md)。

## 基线与来源

- 应用起点：`2893c978f314b977a5881526174aa7295e37a3dc`，原 OpenClaw `v2026.9.8`。
- 升级分支：`codex/openclaw-2026-10-4`，独立 worktree，保留原工作区未提交文件。
- 目标：官方 npm `openclaw@2026.10.4`；源码 checkout `v2026.10.4`，提交 `383c124cc32ffee3f8e56f549b88da94d269a4af`，与发布包 build-info 一致。
- tarball SHA-256：`0a41c2ed708abc812498de58d71d058dde322700488d6e8062c7c070dfdca6dc`；完整 integrity 见[锁文件](../../../scripts/patches/v2026.10.4/source-lock.json)。下载入口和准备命令只维护于[离线下载文档](../../offline-downloads.md)。
- 验证平台：Windows x64；Node `24.21.0`，Electron `42.11.15`（其 Node `24.19.0`）。项目 Node 约束保持 `>=24.16.0 <25`。
- OpenAI 完整源码替换基线同步到同一 tag/commit，独立锁文件中的 `libopus-wasm` 更新至 `0.4.1`。MXC 锁定 `2026.10.4`、SDK `0.8.0`；x64/arm64 executor 与 host-prep 字节 hash 已核对。

## 接入决策与用户影响

逐项能力、删除条件和旧/新编号映射以[当前补丁总账](../../../scripts/patches/v2026.10.4/README.md)为准。首轮 25 项和后续候选构建的验证保留在下文；026—029 及其最终构建分别记录，避免混用产物证据。

| 领域            | 目标变化与处理                                                                                                                                                                                                                                                                                                      |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 原生调度/执行   | 原生 registry 改为不可变记录和事务发布；019 通过原生 actor 发布产品元数据，核对 owner/generation、epoch、revision 及提交回执。物理清理接入 `executeAgentRun`；不重放未知执行。                                                                                                                                      |
| 跨会话写入      | 上游在恢复调用者上下文并核对授权后退出源 transcript/CLI-history writer scope；旧 039 删除。目标任务仍需取得自己的原生写入 claim，共享 SDK owner 机制保留。                                                                                                                                                          |
| SQLite 关闭     | 原包已复现旧读取快照导致前台写入 `SQLITE_BUSY`；旧 043 重写为 025，覆盖六处 native owner 和最终 bundle，仅在 final checkpoint 临时设 `busy_timeout=0` 并恢复。保留新版 `beginClose`、异步 `stop` join、lease 和 clean-close 事实。                                                                                  |
| SQLite 回滚     | 上游由旧字段改用绑定备份目录的 before/after migration write receipt；探针同步核对新回执、错误备份身份、未知后续写入、排他锁及文件不移动。未引入应用自动升级/回滚桥。                                                                                                                                                |
| SDK 与 CLI      | 新增两个 CLI 根依赖；补齐 bundle 旁 build-info。发布包未包含远程 file-transfer 的两个 worker，桌面图仅排除其没有调用的声明，任何实际引用仍要求文件存在。                                                                                                                                                            |
| Provider 传输   | 原生参数/空 tool-call/失败内容规范化移至 `@openclaw/ai`；安装生产依赖后对精确版本和实际函数重新核验。请求 metadata 包装保持在新版 service-tier observer 之后。                                                                                                                                                      |
| OpenAI 本地差异 | 三方合并原生协议修复及两个 worker；继续只注册内网能力，无官网登录、官网 catalog、自动端点回退或官方 Realtime Voice 注册。图像/视频/语音/chat 凭据域独立，`video-openai` 仍由唯一 `openai` 插件提供。                                                                                                                |
| MXC             | 使用目标包原生 selected-executor readiness 与 `preservePolicy:false` 生命周期，删除重复 build 接线。只保留只读 external skills 和 capability SID host-prep 识别。                                                                                                                                                   |
| 插件裁剪        | 新增 Cloudflare R2 storage 明确裁剪；移除上游已删除的 zai/novita 清单项。未知插件仍拒绝进入产物，不增加公网默认配置。                                                                                                                                                                                               |
| 浏览器          | 从目标 checkout 的 `extensions/browser/chrome-extension` 更新 background/bootstrap/relay-auth/strict-json 基线及锁定 hash，重新构建产品 overlay。                                                                                                                                                                   |
| Wire/历史       | validator/adapter 切换到 `v2026_10_4`。已对照 chat/history、WS envelope、sessions/create/list/row、terminal、cron、config、questions schema 差异；history/in-flight 形态未变。新增 optional workContext detail、ultrafast 和 compact list 不是当前产品发送参数；产品问题交互仍由自己的 ask-user-question 插件承载。 |

Main 仍只拥有产品生命周期、权限和 metadata；Renderer 消费原生历史/事件，未恢复 transcript cache、`cowork_messages`、旧 SQLite 迁移门禁或已退役 provider 配置迁移。

最终 Windows 打包还发现合并 tar 的通用过滤规则遗漏 MXC SDK 许可证。已使 MXC 与 ACPX 一样保留法律文件，并将归档条目回归参数化到两个插件；5 项归档测试通过。打包守卫保持严格，修复后重新从 pristine 构建，不在旧 manifest 上更新 hash 来放行。

打包的最终 proof 还暴露临时解包范围遗漏：归档已有 companion，但校验临时目录只提取固定根文件。现从归档内实际 Gateway bundle 发现依赖，第二遍仅提取这些 companion，再执行原有 manifest/文件存在性检查；没有跳过检查。回归分别验证 companion 存在时成功、缺失时拒绝。另行执行 `vitest run`，3 个归档/manifest/companion 测试文件、58 项全部通过，不与完整套件的通过或跳过数量相加。

归档规则修复后的重新构建中，Gateway bundle、gateway.asar、运行时 package 和 npm-shrinkwrap hash 均与原生探针所验证的构建一致；构建 recipe 则记录归档规则和 proof 解包逻辑的变化。

三位 Agent 复审后的补丁标记检查修复再次从 pristine 完整重建。以上四项运行时 hash 仍逐字节一致，因此真实界面与原生探针验证的执行代码适用于最终构建；patch set 和 recipe 身份已更新到下方最终值。

## ACPX / TypeSafe 源码同步与 ACPX 0.19.5

本轮在独立 worktree `acpx-typesafe-10-4/JustDo`、分支
`codex/acpx-typesafe-10-4` 完成，应用基线为 `1cd2e66b3`。没有修改或合入
`dev` 的并行工作。目标源码为 OpenClaw `v2026.10.4`，提交
`383c124cc32ffee3f8e56f549b88da94d269a4af`；Node 24.21.0、Electron 42.7.0、
Windows x64。上文各历史构建的测试数和真实界面记录不替代本轮验证。

ACPX 原包名虽为 `2026.9.8-local.1`，实际源码祖先仍为 9.2，不能只调整版本号。
本轮按祖先、本地定制及 10.4 做三方比较，采用原生 generation/session-store、
probe、process-cleanup、稳定 lazy facade、Pi catalog 和 Windows argv 接线，
保留受管目录、隔离认证、结构化命令、构建时目录、逐 Agent 诊断和默认不启动探针。
未开放运行时下载、原生第二套模型选择器或工作区状态目录接管。完整对应关系和
上游来源见 [ACPX 来源记录](../../../plugins/extensions/acpx/UPSTREAM.md)。

TypeSafe 同步 10.4 的 `isAdmissible`，从注册入口经 client 传入 transport，
在首次准备及真实 DNS 等待后的 `beforeRequest` 再检查；保留显式内网服务、认证、
取消和资源释放。内网和 loopback 请求禁止重定向/环境代理，hosted 保留上游代理策略。
来源及定制见
[TypeSafe 来源记录](../../../plugins/extensions/typesafe/UPSTREAM.md)。

OpenClaw 10.4 上游仍使用 acpx 0.19.1；本轮额外评估并精确锁定 0.19.5。
其公开运行时接口和持久会话格式兼容，采用首次持久会话加载、并发 ensure/import、
历史保存与关闭错误聚合等修复。Claude ACP 0.79.0、Codex ACP 1.12.0 保持不变。
`@openclaw/fs-safe@0.22.0` 的可选平台包和 integrity 保留在 npm 生成的锁中。
同时将已有生产依赖 MCP SDK / TOML parser 精确锁定到 1.31.0 / 1.9.0；
对应公告、实际影响边界及零告警审计见 ACPX 来源记录。离线资源清单仍统一维护于
[离线下载文档](../../offline-downloads.md)。

三位 Agent 分工并交叉复审，发现并修复了以下边界：

- 未启用的内置 Agent 做诊断时，先准备其本地包装器；缺失目录命令直接拒绝，
  不落入 ACPX 默认包下载，也不因此授予任务准入。
- 服务先撤销发布再等待实际 shutdown；部分启动失败也等待清理。探针清理失败保留
  owner，并传播到服务关闭；清理失败屏障阻止新代接管，不伪报退出成功。
- Codex 异步读取后重新检查 generation；旧 turn 固定准入时的 lease，重置后不能
  读到后继任务的 stderr。后台关闭和进程清理同时失败时保留两项错误。
- 移除给整个 ACP 任务套用连接超时的旧钩子，继续由 OpenClaw 管理执行期限。

应用构建另暴露基线 `process-history.test.ts` 中 `unknown[]` 强转不符合消息类型；
仅将 fixture 改为真实数组收窄，错误 fixture 明确失败，没有更改产品聊天逻辑。
该最小修复经另一位 Agent 只读复审。

本轮未启动 Gateway、使用用户凭据、读取用户 transcript 或调用真实模型；协议测试
只使用隔离临时目录及本机模拟 ACP peer。ACPX 插件源码的完整静态类型检查仍受上游发布 SDK 缺失
部分 ACPX facade 声明限制；未伪造 ambient 声明来宣称通过。TypeSafe 则直接使用
实际发布 SDK 的严格 TypeScript 语义检查。

最终产物专项记录位于本 worktree 的 `.agent-tasks/plugin-refresh/`，原始日志不入 Git：

| 记录                                            | 结果与边界                                                                                                                                                           |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `runtime-build-final.log`                       | 从锁定 pristine 完整构建成功；9 扩展预编译、0 错误，随后完成裁剪。                                                                                                   |
| `verify-final-runtime.log`                      | 28 项补丁及冻结证明全部通过。                                                                                                                                        |
| `acpx-final-runtime.log`                        | 19 文件、119 项全部通过，73.54 秒；实际 SDK 和 acpx 均来自新 runtime，真实旧 0.19.1 临时 store/handle/history 兼容分支已运行。                                       |
| `typesafe-final-runtime.log`                    | 12 文件、189 项全部通过，22.95 秒；包括三类服务地址各四项准入/DNS 撤销检查。                                                                                         |
| `typesafe-sdk-final-runtime.log`                | 实际发布 SDK 严格语义检查 1 项通过，4.39 秒；运行时仅有 JS 的辅助 facade 从实际 JS 解析，不补造声明。                                                                |
| `acpx-electron-final.log`                       | Electron 42.7.0 下真实 acpx 协议回归 1 项通过，40.94 秒；其内置 Node 为 24.18.0。并发 ensure、会话复用、拒绝权限后下一轮、取消、关闭流、进程退出和旧版本数据均覆盖。 |
| `lint.log`、`build.log`、`compile-electron.log` | 应用静态检查、前端构建与 Electron 编译通过；前述测试数据类型修正后重新构建。                                                                                         |

另在 Electron 下直接加载 `fs-safe@0.22.0` Windows x64 native 成功（48 exports），
对应文件 1,720,832 bytes，SHA-256
`d2bceba7ecc2d97563c76923f0f7928a76ab098ad70456eafba19b6fdb647828`。
上述专项与完整应用测试有重叠，不相加冒充独立测试总数。

首轮完整测试 `tests-final.log` 未通过：6 文件失败，14 项失败、10,657 项通过、
70 项跳过（665.80 秒），不能计为全套通过。定位到 ACPX 根测试缺少新引入的
SDK helper fixture，专用配置实际 SDK alias 因而未暴露这个收集缺口；现已补齐
最窄依赖 fixture。其余配置失败均为真实文件投影循环超过默认 5 秒，五组矩阵
每例分别执行 6/9/13/10/9 次同步，保留全部断言，只给对应矩阵设置 15/30 秒预算。
实际原生历史模块冷加载与每例两次技能 CLI 冷启动也改用局部有界预算，未修改
全局时限、生产期限或添加重试。以上测试修复经另一位 Agent 只读复审。

首轮还有一次浏览器 MCP 的原生进程检查超时和一次卡片资源初始化失败；未证实
产品逻辑缺陷，不据此修改原生检查或增加卡片等待/重试。`tests-repair-serial.log`
将全部失败文件及聊天类型修复用例合并串行复测，7 文件、202 项全部通过
（366.56 秒），两项原测试保持原样。测试后已恢复 Electron ABI 146；随后降低
worker 数独立完整复跑，不以局部通过代替全套结果。

`tests-final-rerun.log` 的独立完整复跑通过：914 文件通过、6 文件跳过，
**10,683 项通过、66 项跳过**，962.30 秒，退出码 0，无未处理错误。
使用两个 worker，实际 TypeSafe SDK 检查及新 runtime 内 acpx 0.19.5 / 旧 0.19.1
数据兼容分支均已启用；跳过项不计通过。结束后再次核对并恢复 Electron ABI 146。

`lint-final.log`、`build-final.log`、`compile-electron-final.log` 的提交前完整检查均通过。
`package-final.log` 的 Windows x64 目录打包成功：资源归档 36,105 文件，包内
28 项 proof、companion、浏览器扩展、Node 24.18.0 / npm 11.19.1 / npx 11.19.1，
以及 better-sqlite3 / node-pty 的 Electron ABI 146 全部核验通过。
`verify-post-package.log` 再次核对补丁及冻结证明通过。打包前后核对下列 runtime
文件及两插件 package/lock 哈希全部不变，见 `post-package-identity.json`。
没有安装或启动目录包，不能代替安装器交互或真实模型验收。

`archive-native-audit.log` 另由独立 Agent 流式读取最终 Zstd/tar，确认 ACPX
manifest、assembly target/fingerprint、安装后的 package 和 lock 均在归档中，
核心/适配器/安全依赖版本与 fresh 产物一致；fs-safe Windows x64 native 的大小及
SHA-256 与前述已在 Electron 加载的文件精确一致。没有执行归档代码或启动产品。

本轮最终构建身份：

- patch set：`b92cc1be485ce170fddda657b19a2800a63a13de2f67156dad96bf331e33dd55`
- build recipe：`eb0e6e3a56f086de0876513180d6ac8c5701c5bd748e2b3a83514057d4dcd034`
- Gateway bundle：`9f0fccdc673a45e3210bc7e29d96e97e1a87b8f0ef54418b1fba509a2f3f8638`（76,755,573 bytes）
- gateway.asar：`3c099c933a9dfbc81524284f5661428da0a3f5c4627b943c8cc0228eefb87ef5`
- runtime package：`b6588b64f66016de8c020c9ff0b29ed4713b87af0ef955d3864066dcbfb038d3`
- npm-shrinkwrap：`886d40c7b53c2b9d7ac45c19b5a7102ac2fc22ca45a267cc6d9adba9b824fc8a`
- ACPX lock：`4707781e87179adb44b6229b792c591cc44105de3416d89e9b4a3ccde3c0f1cc`
- TypeSafe lock：`d93fbb5e2642e72040e9acd335cd9345916c5b755128b8e27a9b6612ae753686`
- Windows `win-resources.tar.zst`：`7237d81b8141ac8225d3d22c47c3bd98b38e3731d6fa17244b93d0f65ce1b2dc`（449,189,330 bytes）

本轮仍需使用最终安装包手工验证：

- 使用真实 Claude/Codex 凭据首次连接、凭据过期/更新，分别从新会话和已有会话执行任务。
- 实际外部 Agent 的长任务、动态 MCP、权限拒绝后的继续执行、停止/重置和应用退出，
  核对不会残留受管进程、误报结束或影响后继任务。
- 真实 TypeSafe 内网地址、认证更新、取消和提供方切换；合成 DNS/HTTP 测试不代表真实服务可用性。
- 中文/空格安装目录的完整安装交互，以及 macOS/Linux/Windows arm64。

Chrome 日常窗口授权及扩展配对继续按用户此前要求留待手测，本轮没有恢复该验收。
