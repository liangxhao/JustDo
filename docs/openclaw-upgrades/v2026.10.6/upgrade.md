# OpenClaw v2026.10.6 升级说明

## 基线与供应链

应用起点为 `04716a4655d6ab35e7190c0dd74c75ea50f9d28d`，旧运行时 v2026.10.4。
在独立 worktree 的 `codex/openclaw-2026-10-6` 分支实施，原 `dev` 工作区保留。
目标源码为相邻 OpenClaw checkout 的 v2026.10.6，提交
`fe06181dc5ecc01cf8904abbfc26925925efefbc`。构建使用未经修改的官方 npm 包，
不将源码 checkout 或旧 vendor 产物当成发布包。

原包 SHA-256 为 `b13fc9f1221e185451573a435ff31bdeb8c5875f569e6f41008198708ca2359f`；
integrity 由[目标 source lock](../../../scripts/patches/v2026.10.6/source-lock.json)锁定。
发布包的 dist、workers、SDK exports 与实际依赖同源码差异一起审计。
下载地址、文件名、缓存目录及准备命令统一维护在[离线资源清单](../../offline-downloads.md)。

## Node 与桌面宿主

目标原生版本严格要求 Node 24.22.1+（24 系列），原开发 Node 24.21.0 不符合要求。
`.nvmrc` 更新为 24.22.1，应用 engines 收紧至 `>=24.22.1 <25`。
开发机已由用户更新并实际回读为 24.22.1。本次保持 Electron 42.7.0；其内置 Node
不能满足原生 floor，因此不能通过忽略 engines、修改原生 guard 或选 PATH 来启动 Gateway。

构建为六个平台锁定完整官方 Node 24.22.1 发行树（含 npm/npx）的 archive 身份，
按所选 target 准备、验证固定 archive hash 及完整逐文件清单，再装入 OpenClaw
运行时的 `node-runtime/`。本次只在 Windows x64 实际准备并执行。
开发和安装版均从同一冻结运行时解析，Gateway 及其原生 CLI/worker 使用独立 Node。
构建、开发和打包的正常入口仍为 `vendor/openclaw-runtime/current`；
`build/runtimes/openclaw/win-x64-release2` 是严格复制的独立只读验收副本。
历史导入/核验、插件管理、MCP、记忆、电脑权限查询和 Chrome 配对也使用同一准入路径。
缺失或损坏即拒绝，不回退 Electron、系统 Node 或首启联网下载。
兼容环境字段和既有 helper 名称保留，新的文件与清单名使用领域名称。
终端中的 OpenClaw CLI shim 同样只使用已准入路径，移除 Windows 的系统 Node
优先选择与 POSIX 的 PATH fallback；缺失返回 127。Main 启动失败显示中英文提示，
具体损坏原因经脱敏后保留在诊断日志。

Electron 继续拥有产品生命周期、UI 和产品 `better-sqlite3` 的 ABI；原生依赖与应用依赖
仍各归其主。Windows 整合归档与其他平台复制保留完整 Node 子树、法律文件及 POSIX
相对 symlink，manifest/freeze/最终归档均验证该子树，不补写旧运行时证明。
macOS 的 afterSign 在所有公证凭据 early return 前核对冻结 Node；重签若改变字节即
拒绝发行。该 guard 的测试通过不能代替 macOS 实际签名与公证兼容验收。

## 补丁处置

旧版 34 项逐项在目标 pristine 发布包重新定位。保留 33 项，原 027 canonical readiness
路径别名修复已由原生 `resolveDatabasePathKey` 的物理 owner key 覆盖，增加原生契约检查。
旧版 028—034 在目标版顺次变为 027—033；编号、依赖和删除条件只在
[目标总账](../../../scripts/patches/v2026.10.6/README.md)维护。

关键适配包括：

- 启动恢复使用目标已导入的原生 settlement 聚合，保持 app-start epoch 边界。
- fork handler 改接原生 preconditions 路径，`includeEntry` 经同一原生 intent 进入
  Main、incognito actor 和 worker；仍只允许精确管理员、托管命名空间及未占用目标。
- Windows 创建权限 guard 移至 `assertSessionEntryCreationTarget`，保留 actor/file
  database identity 优先以及 agent/session/current-owner 核对。
- 共享执行与 harness 选择按目标 generator/actor 结构重建，终态必须是整轮结算。
- 插件执行按目标异步会话读取契约准备原生 live guard，注册入口原样返回已准入的
  native entry；固定 SID、lifecycleRevision、pluginOwnerId，并绑定同一 options 对象
  和原生执行 owner。同步回调消费已准备的同步断言，不能用 Promise 或快照替代实时身份。
- 原生取消通知占用 publication 后，允许原执行器随后产生的真实整轮结算发布一次；
  必须匹配首次 reservation 捕获的完整 generation/SID/sessionKey/agentId，缺失身份、
  重复终态、其他执行和跨代事件均不获得该例外。应用不生成替代终态。
- 插件恢复保留原生内部 junction relocation，只补外部已捕获宿主目录 junction 的
  Windows 类型；插件发布恢复仅准入原生 install，同一 stage/字节/总预算不变。
- SQLite 退休保留 `void beginClose()`、异步 stop join 与结果，仅关闭 checkpoint
  临时采用零 busy timeout。
- 公开正文流保留目标新增 recovery flush 和内部交付路径；格式纠正保持初始候选来源、
  同循环两请求上限与终态，目标 `input.prepared` 的最终内容同样执行拒绝草稿处理。

未增加旧补丁修订迁移、模糊 anchor 或 transcript 缓存，未恢复撤回的 9.6→9.8 SQLite 兼容桥。
每项补丁的首次应用、当前形态幂等和最终 bundle 校验分别执行。

## SDK、本地扩展与配置

OpenAI 以旧上游/本地/新上游三方比较刷新完整生产源码及 provenance，带入新的
service-tier、流式及协议行为并锁定 ws 8.22.0。继续只注册显式内网 chat/image/TTS/STT/
embedding/video；无官网登录、公共 catalog、自动端点回退或官方 Realtime Voice 注册。
不同媒体能力的地址和凭据域仍独立，最终只有一个 `openai` 插件。

ACPX 带入目标 retained binding、generation、oneshot restore、probe cwd 和实际安装定位，
保持本地无首启下载及独立 acpx 0.19.5 锁。目标 SDK 删除的 `readJsonFileWithFallback`
由本地受限 manifest 读取与对象/name 校验替代。Claude/Codex ACP 适配器随目标版本更新。
TypeSafe 采用目标 HTTP 400 unsupported-input 分类，保留内网地址、凭据、取消和准入。

Wire 以 v2026.10.6 命名，完整消息补取携已确认的物理 sessionId，继续保留连接与历史
generation 校验。目标新增的 cyber-refusal 公共模型 fallback 在 Main 管理配置中显式关闭。
不因原生默认值而增加企业内网之外的服务。

MXC 独立包更新为 2026.10.6，原生 SDK 为 0.9.0；四个 executor/host-prep binary
hash 更新并继续固定签名身份。SDK 仍接受现有 `0.7.0-alpha` ProcessContainer envelope。
node-pty 按 SDK 的真实依赖解析定位，以适应 npm 在插件内的提升；包、prebuild 和
选中架构都验证物理路径边界，不能退到插件外或在缺少目标架构时继续裁剪。
目标新增 X/Twitter 上游渠道明确加入裁剪，未知扩展仍使组装失败。

浏览器扩展完整对齐目标 tag 的 29 项原始资源，新增 relay URL 校验与串行队列；
产品配对 transport、侧聊 overlay、扩展身份、权限和 Native Messaging 边界保持。

## 后续启动配置与正常升级补查

用户在升级 worktree 启动时暴露 Workshop 废弃配置和 TTS 旧字段准入遗漏，
已统一为当前配置写入，并对真实 Main 落盘结果同时执行原生 schema 与 legacy 检测。
同轮确认 agent schema24→25 不能由普通启动自动完成，新增保留全部数据的正常升级，
与已有历史迁移、首次安装和正常启动分开。当前原生 owner 合同只支持 shared20 和
agent24/25，由目标原生维护、备份及复验，不复制原生 SQL 或引入新的 runtime patch。

仅应用版本升高或构建指纹变化、OpenClaw 版本相同且数据库无需维护时直接正常启动；
保留完整产物准入、实际就绪检查和完成身份更新。OpenClaw 版本变化、缺回执、实际
schema 待维护和未完成升级仍走正常升级，降级确认继续使用既有升级外壳。

后续跨版本升级按目标集中合同检查来源数据，任一应用/runtime 版本降低先提示并提供
“仍然启动”，确认后接回正常检查，实际不兼容与加载错误照常显示。开发模式使用相同
路由，并提供独立界面演练。逐项依据与当前边界见[模块报告第 2 节](module-api-audit.md#2-本轮发现与适配)。

具体测试、构建身份及独立审查结果见[验证记录](validation.md)。
