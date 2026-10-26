# 升级决策与来源

## 固定基线

最初在 `codex/openclaw-2026-10-7` 分支实施，应用基线为
`62342c478c7c55645c892094cf668c7ea7141fa8`。主工作区已有的未提交修改
未带入本次 worktree。目标平台为 Windows x64；开发与随包 Node 为 24.22.1，
应用 Node 约束仍为 `>=24.22.1 <25`，Electron 约束保持 `^42.6.2`。

2026-10-26 首轮将原升级提交重新应用到当时的 dev
`1d3d217a1f585f5bae36cc0e7e1118b940ed14cb`。只重放升级提交，保留 dev 对分页、
启动/数据库快路径、权限/配置、决策模型、会话读取和流式订阅的修复；同名旧父
提交不再重放。新组合按产物 C 重新构建与验证，原 A/B 记录只保留其历史范围。
其中 .6 的 026 流式修复已对照真实 .7 订阅 owner 移植到现有 .7 补丁，
并以 raw/final 真实订阅各 7 项和新 C 的严格补丁矩阵验证；完整结果见
[validation.md](validation.md)。

C 验证期间 dev 又新增三项修复，后续固定到 14:54 的
`fd2ad574c0f3a9c36a866d38693e813023a3419c`：保留聊天错误展示、Team 来源工具继承/
讨论后任务继续，以及禁用 setup 委派工具。两个升级提交重放为 `3a5b35cf3`、
`bdd689b96`，独立 .7 接口核对无阻断。原工作树两次被清理且 ignored 产物/证据丢失，
现由已提交源码恢复到已登记的 `runtime-dev-sync/JustDo` 工作树，分支
`codex/openclaw-2026-10-7-dev-sync`。组合 E 完整重建后，严格依赖图发现生产依赖
重装覆盖了上游随包 Chrome 快照身份修复；E 不可验收。三名 agent 独立确认实际
消费路径后，按锁定原包完整保留 bundled dependency，并加入来源/整树冻结证明。
这是应用构建侧修复，不增加 33 项 native patch。最终组合改由 F 完整重建和独立
验证，不以 C/D/E 的历史结果替代；主目录源码与未提交内容不带入。

F 构建前又将已提交的计划工具更名、提问工具和历史折叠回答纳入，最终 dev 基线
固定为 `fdf4cfdc79d9a28af70ef31f23e6ed1037287159`（16:31）。四个本轮提交
无冲突重放，构建侧修复为 `c00a87127`。独立审查确认 `present_plan` /
`ask_user_question` 精确名称已同步，插件 ID 和 RPC 保持原协议；不需要新的
原生补丁。F 从新 checkpoint 完整重建，主目录未提交的修改仍不带入。

最终 F 的完整构建、冻结、43 文件严格矩阵、真实 SDK/Chrome/Group/ACP/CLI
探针和单次 13 段模块门禁均通过。全量发现的默认 junction 测试夹具与源码 ACPX
依赖准备缺口已收口，第二轮完整测试为 17,509 项通过、零失败；详细条件跳过、
身份、首次失败和人工验收范围见 [validation.md](validation.md)。

| 来源 | 旧版本 | 新版本及证据 |
| --- | --- | --- |
| OpenClaw | 2026.10.6 | 2026.10.7；原始 npm 包 identity 见目标 `source-lock.json` |
| 上游源码 | tag v2026.10.6 / commit fe06181dc5ecc01cf8904abbfc26925925efefbc | tag v2026.10.7 / commit 157d8c2bc3ea2fa183afdc11088e69690bf8e64e |
| AI transport | @openclaw/ai 2026.10.6 | 2026.10.7；固定 transport、provider、partitioner 路径仍逐项验证 |
| 文件系统 | @openclaw/fs-safe 0.25.0 | 0.26.0；补丁接触的 move-path 与 guarded-mutation 原始字节未变 |
| Windows 沙盒插件 | @openclaw/mxc-sandbox 2026.10.6 | 2026.10.7；SDK 仍为 0.9.0，二进制哈希及签名要求不变 |

目标原包 SHA-256 为
`45dc6dadab3ca4e5286262226d6b61554309435a5e83b5d25c803a3a12ef2f81`，
SHA-512 integrity 与 registry metadata、本次下载字节和目标 source lock 一致。
annotated tag 的对象 ID 不作为源码 commit；核对使用 `v2026.10.7^{commit}`。
下载清单与准备命令统一见[离线准备](../../offline-downloads.md)。

## 上游变化与接入

已对照本地目标源码的 `CHANGELOG/2026.10.7.md` 及 `.6..7` 实际差异。
本版重点包括恢复 provenance 与工具结果、数据库/worker 退休与拒绝、配置观察、
插件增量装载与 capture、cron 回复绑定以及维护/更新修复。
公共 Gateway schema 的实质增量为 UI command 的 GitHub 操作与 worker timeout 的
`tool_execution` 阶段；前者尚无产品入口，不新增授权面。

诊断链路接入 `tool_execution`：shared 闭合枚举、Main 解析与导出、Renderer 和
中英文字典同时更新。未知阶段仍拒绝或显示 unknown；该观察字段不能推断整轮结算。
新增测试直接加载目标原生 schema 和 normalization owner，并保留未知值负控。

Goal 保持已启用的自动续跑：只有匹配精确身份、原生整轮结算及条件准入时才发起
新的后继 run，不把工具超时改成人工继续门槛。现有 host 提示补充先核对超时或
结果不明的工具状态与已有成果，避免盲目重复有副作用的操作；发送结果不明仍
保留原候选与回执核对，不重放原请求。新增 11 项 Main 编排用例覆盖自动新轮、
未结算/旧身份/重复终态及未知 ACK。提示不能代替真实模型行为验收，也不声称
普通 Goal 后继自动继承原生专用 recovery 的只读工具限制。

启动数据库契约的 18 个 owner 从目标 pristine 包重新解析唯一声明、导出 alias 和
SHA-256。原生 schema 仍为 state 20 / agent 25，既有可维护来源仍为 state 20 /
agent 24、25；不扩大兼容范围、不恢复撤回的旧 SQLite 桥。原生探针中所有受影响
的 dist hash 路径与 alias 同步重新绑定。

既有 `v2026_10_6` wire 文件及导出符号保留，文件承载的共有协议未变化，
其当前目标常量及注释更新为 v2026.10.7。不为纯命名做无关调用方重构。

## 插件与补丁处置

多 agent 分别审查并交叉核对原生调用、补丁、SDK 与插件。
33 项补丁均仍存在对应缺口；没有新增能力补丁，也没有扩大权限或增加历史补丁
就地迁移。目标目录独立建立 source lock，并以实际发布包重建 owner/anchor 证据。
全部保留理由、依赖和删除条件以目标补丁 README 为唯一总账。

本地 OpenAI 的 85 个上游来源文件重新计算哈希；上游两个 tag 之间只有 package
版本变化，84 个其余文件原样一致。完整本地源码替换、两个 worker、manifest、
内网凭据/端点和唯一插件身份保留；刷新版本、源码 commit 与 package hash。
ACPX 和 TypeSafe 同样只有上游包元数据变化，刷新来源与 SDK 最低版本，保留本地
实现及依赖 integrity。裁剪策略逐项核对，目标上游插件集合没有新增或删除，
策略版本更新到 v2026.10.7。

随包技能逐文核查还修正两处历史说明：skill-creator 改为现行 Workshop 即时、
版本化写入及个人库各自的实际参数；ACPX 从五类受支持外部 agent 中，仅选择本地
已配置且已启用者，通过受管命令、授权与生命周期启动。不再指示在线安装、直接修改用户配置、重启
Gateway 或在会话结果不明时盲目重放；已有用户授权继续有效，不增加人工 apply
门槛。技能来源策略同时更新，并重新从 pristine 执行完整产物构建，独立核对资源
实际复制字节，不能只改旧产物身份后沿用。

Windows MXC 仍使用真实 selected-executor probe 和固定 SDK 二进制证明，
只保留既有 external read-only skills 与 capability SID 兼容接线。
fs-safe 0.26.0 没有提供与 033 等价的同事务、有界目录发布恢复，因此保留该补丁。

## 验证边界

执行记录、失败与修复复验、最终产物身份和未完成项见 [validation.md](validation.md)。
源码审计、合成模型、原生 fixture 与真实 UI/企业模型/安装包分别记录。
