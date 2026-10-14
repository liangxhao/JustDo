# OpenClaw 升级检查清单

升级 OpenClaw、重新生成补丁，或更新本地 OpenAI 插件前，必须先读本文。
当前基线是 `openclaw@2026.9.8`。版本、源包 integrity、补丁总账分别以
`package.json`、目标补丁目录的 `source-lock.json`、该目录 `README.md` 为准。
本文记录升级时的检查方法，不替代逐补丁的功能、影响和删除条件总账。

## 1. 先确定升级基线

1. 保留当前本地改动，在隔离 worktree 中升级。确认 `../openclaw` 的 tag/commit
   与拟升级 npm 包一致，比较源码及实际发布产物，不能只看源码通过编译。
2. 阅读当前与目标版本 release notes、SDK 类型、原生 CLI/Gateway schemas、
   extension manifest、package exports、依赖锁及 worker 构建入口变化。
3. 从未经修改的目标 npm 包重新构建。不得迁移已经打过旧补丁的 vendor runtime，
   不得添加历史补丁形态兼容，也不得恢复已撤回的 9.6→9.8 SQLite 迁移桥。
4. 新版本创建自己的补丁目录，重新记录 source lock/pristine contracts。
   每个旧能力先判断：原生已覆盖、Main 可承载、普通插件可承载、允许退回原生行为，
   或仍需窄接线。不能直接修改版本号并沿用旧 anchor。
5. 更新插件裁剪清单的版本。所有新增上游插件必须明确保留、裁剪或本地替换；
   未知插件应使构建失败，不能自动加入默认发行版。

## 2. 当前 25 个补丁需要检查的接缝

逐项读取 `scripts/patches/v2026.9.8/README.md` 和对应 transformer，
对照新版本原生实现及调用方。下面只列升级验证重点：

| 编号 | 升级检查与验收重点                                                                                                                                               |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 001  | 对照 spawn 环境 sanitizer。真实 pip 安装后 import，检查受管源和用户安装目录；预装依赖可用不能证明新安装路径正确。                                                |
| 005  | 对照最终 system prompt 的生成顺序及公开 transform hook。验证只改 system prompt，不改变用户文本、历史、工具参数。                                                 |
| 006  | 对照请求 metadata、chat.send closed schema、隐藏用户轮次及排队后的标记归属；用实际内置服务核实字段消费。                                                         |
| 007  | 验证 compaction/exec review 的 purpose 及 human initiation 标记，不能按普通聊天调用推断内部维护调用。                                                            |
| 008  | 分别验证完整应用重启与同一应用内 Gateway 重启的任务恢复；核对 recovery admission，而非连接后补做 abort。                                                         |
| 013  | 验证 paused goal 的显式继续和普通继续分别如何消费原生 goal/queue 状态。                                                                                          |
| 014  | 对照 assistant display block 的原生存储/回放/历史投影，避免重建产品 transcript 缓存。                                                                            |
| 015  | 验证已授权本地文件媒体准入；覆盖路径、会话身份及非授权读取拒绝。                                                                                                 |
| 016  | 核对离线官方插件 catalog 与裁剪策略；断网启动和插件页查询不能触发公网 catalog。                                                                                  |
| 019  | 核对配置插件自动安装的原生入口；断网配置同步不能偷偷下载缺失插件。                                                                                               |
| 022  | 对照 reset 的 display/history API，验证显示重置不伪造执行终态、不破坏原生历史所有权。                                                                            |
| 023  | 核对 session fork target key schema/ownership；验证目标身份和并发冲突，不覆盖现有会话。                                                                          |
| 025  | 对照 MXC 的 external skills 路径和沙箱准入，实际读取允许技能并拒绝越界路径。                                                                                     |
| 026  | 核对 private untrusted context 的真实模型输入与可见历史投影，不以 Renderer 过滤代替原生隔离。                                                                    |
| 028  | 核对 admin session cwd、sessionRoot 和路径授权；创建/打开/执行都使用实际项目。                                                                                   |
| 030  | 核对 cron native session 权限映射，覆盖手动执行、定时执行与审批边界。                                                                                            |
| 031  | Windows servicing credential launcher：核对原生 launch API，验证进程身份、凭据和清理；不记录秘密。                                                               |
| 032  | Windows session creation path：覆盖中文/空格路径、平台原生路径解析和创建 API。                                                                                   |
| 034  | 对照 plugin-owned launch、settlement、custody、cleanup 和重启恢复。核对 native-support 注入的 actor/registry/accessor；不能用 chat final 代替 executionSettled。 |
| 036  | 对照共享 terminal launch 的 CLI/RPC 入口、原生 PTY 所有权；重连只能 attach，不重放不确定输入。                                                                   |
| 037  | 验证 terminal banner 与共享启动器的输出顺序；删除时说明只是展示变化，不能与终端执行混为一谈。                                                                    |
| 038  | 对照 compaction lifecycle、取消和并发 run 边界；验证普通 native-support 模块与原生接线的完整性。                                                                 |
| 039  | 对照 peer transcript 写入权限、会话 incarnation 和原生 SDK actor；覆盖跨会话拒绝，不放宽全局写权限。                                                             |
| 040  | 核对 computer RPC、tool、dedup、heartbeat、release 的活动通知，真实操作与悬浮提示分别验收。                                                                      |
| 042  | Windows plugin recovery：核对 junction/链接目录重启发现，覆盖普通目录、链接及坏链接。                                                                            |

已删除的 002/003 由 Main 的 MCP/Chrome 启动器和配置投影承载；升级必须跑真实
Windows npm/npx、嵌套包 bin、中文/空格路径及 Chrome MCP 握手/调用/退出验证。
020/021 由下节本地 OpenAI 源码承载。027 由构建时共享 SDK 模块保证授权注册表
实例一致，必须验证注册、读、撤销跨 bundle 边界一致。

033 私有 loop exit 诊断已删除，仍以原生 whole-run lifecycle 为准。
035 私有 prompt budget 接线已删除；Workflow 用公开 `model_call_started` 及匹配的
run/trace/attempt span 计算结果预算。升级检查事件时序、trace 关系和 SDK schema，
缺失观察应保守回退，不能采用旧尝试的高额度。

## 3. 本地 OpenAI 是完整源码替换

`openclaw-extensions/openai` 以原生 OpenAI 的 v2026.9.8 源码为起点，包含
MIT LICENSE。`upstream-source.json` 记录原始 tag、commit 和源文件 SHA-256；
它描述上游基线，不要求已修改的本地文件等于原始 hash。测试辅助源码不发布。
本地依赖使用独立 `package-lock.json`，不引用上游 `workspace:*` 开发依赖。

资源同步以本地目录**完整替换**原生 `dist/extensions/openai`，不合并文件，
不保留旧 `native-index.mjs`/`native-capability-catalog.mjs`。裁剪清单将上游
`openai` 列入 `local-source-replacements`；本地插件保护只保留替换后的目录。
最终只有一个 `openai` 插件 ID。`openclaw.runtimeBundled` 表示只能在构建时组装，
开发期库存与启动源码复制排除该源目录，由已编译运行时 manifest 判定可用性。
源版本、基线版本或 runtime 版本不一致时资源同步必须失败，要求重新审查。

升级方法：取得目标 tag 的原生 OpenAI，使用旧基线/新上游/本地三个版本比较；
将原生协议修复带入本地，逐条重新实施并验证下面的差异，再更新来源记录与锁文件。
不要直接覆盖本地 `index.ts`、manifest 和 setup entry；这样会重新开放官网登录，
丢失视频注册或隔离配置。保留的上游辅助源码不等于开放其中的官网功能。

| 本地约定            | 必须比较和验证的文件/行为                                                                                                                                                                                                                                                                                  |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 无官网账号引导      | `provider-contract-api.ts`、`setup-api.ts`、`openclaw.plugin.json` 的 auth、wizard、CLI flags、credential import、usage/env 声明。注册与 setup 均无浏览器登录、device code、SIWC 或官网 API Key 向导。                                                                                                     |
| 显式内网模型        | `openai-provider.ts`、`provider-policy-api.ts`、`model-auth-policy.ts`、`shared.ts`。保留原生 stream/replay/tool 语义；模型与地址由设置提供，无官网 catalog/自动发现/默认地址。检查模型级 API/baseUrl 优先于 provider 配置，未知模型不能被厂商 preset 重写。                                               |
| 图像隔离            | `image-generation-provider.ts`、`intranet-config.ts`、`contracts/media-config.ts`。只使用 `models.providers.justdo-image-openai` 的地址/凭据；不借聊天 openai 或环境 Key。覆盖 generations、multipart edits、响应上限、私网显式允许和拒绝越界。                                                            |
| TTS                 | `speech-provider.ts`、`tts.ts`。显式地址、模型、音色、响应格式与能力专属凭据；无环境 Key/公网地址回退。覆盖内网任意模型/音色、额外参数、匿名服务、响应上限和释放。                                                                                                                                         |
| 实时 STT            | `realtime-transcription-provider-factory.ts`。接受 HTTP(S) 与直接 WS(S) baseUrl，派生 `/realtime?intent=transcription` 时保留直接 WebSocket 协议，transport 与 header policy 使用同一地址。覆盖四种协议、并发端点、按 committed 链顺序输出、重连重置、最后 commit、溢出关闭；不借官网 profile 或环境 Key。 |
| 文件 STT            | `audio-transcription.ts`、`media-understanding-provider.ts`。原生 multipart `/audio/transcriptions`、模型、文件名/MIME、响应与释放；使用配置域凭据，显式账号 profile 在上传前拒绝；配置缺失在上传前拒绝，上传开始后的失败不能改服务重试。                                                                  |
| Embedding           | `embedding-provider.ts`、`memory-embedding-adapter.ts`、`embedding-batch.ts`。显式 remote/provider 地址、原生凭据/目标绑定、模型前缀、cache identity、批次与总超时，不恢复官网默认地址。                                                                                                                   |
| 视频合并            | `video-provider.ts` 注册仍叫 `video-openai` 的 provider，但所属插件是 `openai`。保留 `models.providers.video-openai`、模型 primary 和凭据域；单独关闭视频不得关闭 chat/image/TTS/STT。检查异步 Videos 提交/轮询/下载，未知提交不重试。                                                                     |
| 官网 Realtime Voice | 原生 ChatGPT/Quicksilver/官网 RTC 源码不注册为能力。它与现有 TTS、实时 STT 和文件 STT 是不同入口；未经明确内网协议实现与验收，不能恢复注册。                                                                                                                                                               |

API Key/SecretRef 仍可用于用户显式选择的内网服务；删除的是官网认证流程，
不是内网鉴权。未解析 SecretRef 必须拒绝，不能转为字符串或泄露到日志。
插件不导入应用 `src`；纯配置 ID 由插件 `contracts/` 拥有，应用 shared 只做门面。

## 4. 检查实际构建产物

预编译必须覆盖 main entry、setup、provider-policy、provider-contract、manifest 指定的 capability catalog，
以及 `openclaw.build.workerEntries` 的两个 worker，并更新 package/manifest 的 `.js`
路径。检查 SDK alias、包名、相对 worker URL、第三方依赖与法律文件；不能只编译
index 后靠运行时临时转译其它入口。保留 worker 源码供上游对照不代表开放官网语音。
worker 构建描述只对 `openclaw.runtimeBundled` 的本地源码替换严格编译；上游已编译
插件的同名字段可能仍指向未发布的 TS 源码（例如 QuickJS），不能据此要求重编译。
所有本地 OpenAI 生产源码、manifest、锁文件和 worker 都参与 runtime build recipe。
任意修改后旧 runtime 必须被判定陈旧。

关闭正在使用开发 runtime 的应用，再强制从 pristine 重建目标平台。例如 Windows：

```powershell
$env:OPENCLAW_FORCE_INSTALL = '1'
npm run openclaw:runtime:win-x64
```

确认最终 manifest、source lock、25 项或目标版的新补丁数、copied support bytes、
共享 SDK owner、plugin assembly、预编译与裁剪及 freeze 校验均通过。
实际目录只出现一个 openai，包含新 video 注册，不含 native-* 旧入口或独立
video-openai 插件目录。普通应用 build 或重启旧 Gateway 不能证明 runtime 已更新。
另外通过原生 `plugins list --json` 检查实际发现结果：只应有一个已加载的 `openai`，
source 指向运行时外层 `dist/extensions/openai/index.js`，providerIds 包含 `openai`
和 `video-openai`。不能只手工 import 文件来证明 Gateway/CLI 选择了正确的目录。

运行项目 lint、build、Electron 编译和测试。原生/全量测试必须等 runtime 重建和
freeze 校验完成后再执行，不能与 runtime 目录替换并行。重要定向检查：

```text
tests/scripts/native-extension-replacement.test.ts
tests/scripts/precompile-openclaw-extensions.test.ts
tests/scripts/sync-openclaw-runtime-resources.test.ts
tests/scripts/prune-openclaw-runtime.test.ts
tests/openclaw/plugins/openai-native-composition.test.ts
tests/openclaw/plugins/openai-intranet-config.test.ts
tests/openclaw/runtime/windows-mcp-launch.test.ts
src/main/openclaw/config/nativeVideoModelConfig.test.ts
src/main/openclaw/config/openclawConfigSync.logout.test.ts
src/main/plugins/extensions/intranetVideoPlugin.test.ts
src/main/plugins/extensions/openclawLocalExtensions.test.ts
```

OpenAI 原生 SDK 集成测试使用本机测试服务验证 generations/edits、TTS、文件 STT、
video 的请求地址和不同凭据，另验证冷发现与注册 STT 一致及转录顺序。
视频设置、配置保存和导入只支持 `video-openai`（所属插件 `openai`）；升级后不得
重新引入 Kie、Z.AI、Novita 的供应商选项或固定模型目录，即使上游仍包含这些插件。
这些测试不代表真实内网服务支持全部原生参数；最终仍须在应用中分别验证聊天、
图像、录音识别、文件转录、朗读与视频，检查实际 Gateway 日志和输出文件。
诊断必须使用原生事件证据，不以简化控制台日志缺行推断失败或成功。

在升级变更中更新本文、版本补丁 README、相关架构/功能文档和验证结果，
说明退回原生行为的用户影响及尚未验证的服务/平台，不承诺未执行的验收。
