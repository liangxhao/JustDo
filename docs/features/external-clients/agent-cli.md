# CLI 与入站 ACP

安装后的 `<productName lowercase>-cli` 是桌面应用共用的命令行入口。
应用运行或驻留托盘时，CLI、ACP 和已实现的 app-server 子集默认可用，没有客户端专用启用开关。
入口使用随包运行时，不依赖系统 Node、首次下载或公网；不会打开第二份产品数据库或启动另一套 Gateway。

本页先说明命令用法，再说明 ACP 的会话、MCP 与审批资源。app-server 的握手、路由、WebSocket
和断连差异统一见[通用 app-server](app-server.md)，逐字段定义见[外部客户端规范](../../app-server-api/external-clients.md)。

## 1. 找到入口并运行命令

“设置 → 外部连接 → 应用接入”显示可复制的完整 CLI 路径及 launcher/bridge 状态。
刷新状态只读，不启动 Gateway。ACP 通过该入口的 `acp` 参数启动；app-server 提供并列的 stdio
与 WebSocket 配置面板。打开设置、复制配置或安装某个客户端都不是启用条件。

| 环境            | 入口位置与规则                                                                                                        |
| --------------- | --------------------------------------------------------------------------------------------------------------------- |
| Windows 安装版  | 应用旁的 `<productName lowercase>-cli.exe`；使用明确路径，不修改 PATH                                                 |
| Windows 开发版  | `.agent-tasks/external-agent/development/<profile-hash>/` 下的隔离 profile 程序。默认启动器直接在工程的 `.agent-tasks/external-agent/development/` 下，连接时读取活动数据位置       |
| macOS / Linux   | profile 私有 `external-agent/bin/<productName lowercase>-cli` wrapper；明确绑定所属 profile 并剔除 bootstrap 环境覆盖 |
| POSIX PATH 别名 | 优先 `~/.local/bin`，仅作为首个所属 profile 的便利入口；准备其他 profile 不覆盖它                                     |

可执行文件名来自外部产品名的小写形式加 `-cli`；协议通过参数选择。安装路径或开发路径变化后，
客户端需要更新命令路径，不提供旧客户端专用 executable、bootstrap 或 discovery 别名。

以下 `<cli>` 指复制出的路径。按所用 shell 为带空格的路径和提示词加引号。

```text
<cli> --help
<cli> --version
<cli> status --json
<cli> models list --json
<cli> exec --cwd <project-directory> --json "Describe this project"
<cli> exec --session <external-session-id> --stream-json "Continue the task"
<cli> acp
<cli> app-server --listen stdio://
<cli> debug models --bundled
```

### exec 的输入与会话规则

- help/version 无需运行桌面应用；status 只读取已有状态。
- 模型列表只包含已启用、已配置且凭据可用的聊天模型。
- `exec` 接受 `--cwd`、`--session`、`--model`、`--json`、`--stream-json`，以及 `--prompt <text>` 或一个位置提示词。
  `--` 后可提供以短横线开头的提示词。
- 新会话默认使用命令启动目录。恢复会话默认保留已存目录；明确传 cwd 也必须是同一真实目录。
- 模型选择经现有会话 mutation 队列确认，不改应用默认模型。

### 输出与退出码

| 输出模式       | stdout                                                     | stderr |
| -------------- | ---------------------------------------------------------- | ------ |
| 文本           | 最终回答                                                   | 诊断   |
| JSON           | 一个最终 `result` 或 `error`                               | 诊断   |
| Streaming JSON | 带外部 session ID、run ID 和原生事件的 `event`，最后为结果 | 诊断   |

退出码：成功 0、参数错误 64、宿主不可用 69、桥接或执行失败 70、确认取消 130。
意外输出或桥断连不代表成功。`EXECUTION_UNKNOWN` 保留已知 session/run ID，不能据此重试提示词。

## 2. 所有入口共用的执行与身份边界

```mermaid
flowchart LR
  Client[脚本 / ACP / app-server 客户端] --> CLI[统一 CLI]
  CLI -->|认证本地 pipe / socket| Bridge[Main bridge]
  Bridge --> Adapter[命令与协议适配器]
  Adapter --> Sessions[外部会话与执行服务]
  Sessions --> Prepare[既有权限和模型确认]
  Prepare --> Gateway[OpenClaw Gateway]
  Gateway --> History[(原生 transcript)]
```

### 本地桥与信任范围

传输保留 v4 有界帧、UTF-8、FIFO、队列上限和慢消费者背压。Main 只发布
`external-agent/bridge.json` 供所有命令发现当前 pipe token。端点和 launcher/model/session
服务归入站客户端 `clients` 领域，不探测或认证指定第三方应用。

命令仅允许为 app-server 身份标记转发可选 `CODEX_HOME`；不转发其他任务环境、客户端 token
或 server/workspace ID。Gateway 凭据不进入命令参数或协议输出。

访问范围是当前操作系统用户和应用 profile。客户端名称、标记目录只是显示资料，不是同用户
程序之间的授权边界。默认可用不增加权限，原生准备、模型校验、审批、身份与容量检查仍然生效。

### 外部会话与恢复

CLI、ACP、app-server 共用 `ExternalAgentBackendFactory`、`createExternalAgentExecution`
和 `ExternalSessionStore`，新会话 `source='cli'`。`cowork_external_sessions` 只保留
外部/原生身份与执行回执，不保存消息；新会话显示在 `External` 来源分组。
该分组与浏览器扩展的 `Chrome` 分组在中英文界面均使用上述英文名称；内部来源标识保持不变。
来源通过分组展示，会话标题旁不再重复显示外部来源徽标。

新建外部会话直接使用应用会话 ID 作为对外 ID，app-server 的 `threadId`、ACP 的 `sessionId`
与该应用记录使用同一个值，不再额外生成外部 UUID。已有外部会话保留原 ID 和映射，恢复不新增别名，
也不将普通桌面、Chrome 或 OpenClaw 原生 ID 自动视为外部会话。

查询内置模型日志时使用 OpenClaw 会话 ID，而不是 `threadId`。应用会话菜单的“复制主会话 ID”
和“会话详情 → 基本信息 → Session ID”已经提供 OpenClaw 原生 ID。

新建的空会话显示“新对话”。首次提交任务时，若标题仍为“新对话”占位，则用首条消息的第一个非空行命名，最多保留 50 个字符；
纯图片任务使用“图片对话”。之后继续对话不会覆盖标题，客户端或桌面已设置的自定义标题也会保留。
CLI、ACP 和 app-server 使用同一规则，不再用助手名字命名会话，也不额外调用模型生成标题。
已有历史会话的标题保持原样，不读取或回填历史正文。

历史客户端的 scoped ID、tombstone 和原生映射保持原样，作为只读外部客户端历史展示。
新协议不会推测旧 scope、扫描 marker 获取授权或用裸 UUID 认领旧记录。

恢复必须核对来源、仍存在的产品会话、助手、真实 cwd 和已固定的原生会话身份。
外部会话 ID 不能替换成任意 Gateway key。普通文本及图文的原生 `agent` 准入接收预期 SID 和
lifecycle revision，准备与派发之间发生 reset 时拒绝发送。app-server 纯图片使用支持空文本的
原生 `chat.send`；该方法没有原子 revision CAS，宿主在派发前后核对精确身份、连接代次与 ACK，
无法确认时保留 unknown，不重发。所有协议按产品会话 ID 共用执行预留。

## 3. app-server 子集与客户端配置

ACP 客户端使用复制出的 command 和 `args: ["acp"]`。app-server 是另一协议，使用
`app-server --listen stdio://`。每个 app-server 连接最多绑定 32 个外部线程，逐线程管理执行与订阅。

支持 `initialize`／`initialized`、`model/list`、`thread/start`、`thread/resume`、`thread/name/set`、
`thread/list`／`thread/read`、`thread/loaded/list`、`thread/turns/list`／`thread/items/list`、`thread/unsubscribe`、
`turn/start`、`turn/interrupt`，以及 reasoning、正文、用户准入和工具 item 通知。
恢复默认回放原生历史，`excludeTurns: true` 可跳过；`thread/read(includeTurns: true)` 可显式读取。
历史要求已有认证 Gateway，读取前后核对身份和回执，不启动运行时或存储正文副本。
改名会真实保存到产品元数据，元数据读取不启动 Gateway。
支持标准文本、`image` 和 `localImage`，可发送图文或纯图片；发送图片时，所选模型必须在真实目录中声明图片能力。
图片格式、大小、cwd 路径及受限网络地址规则见[输入规范](../../app-server-api/external-clients.md#turnstart)。
不支持的 execution override、音频、其他输入类型、reasoning/service tier 和客户端专用 MCP
配置会明确失败。支持原生命令允许／拒绝／取消；实验握手下可明确提供精确命令会话授权，
以及插件确认和原生明确提供的 App 持久授权，详见下文审批归属。
逐字段对照、官方 schema 校验基线和剩余兼容范围见[兼容性说明](../../app-server-api/compatibility.md)。

Multica 的配置示例选择基础协议 **codex**，使用同一 command，不添加额外参数；其
[适配器](https://github.com/multica-ai/multica/blob/main/server/pkg/agent/codex.go)
启动上述 app-server 命令。这是前端配置示例，不要求 Multica 凭据、安装检测或后端注册。
互通取决于方法、版本与能力，不取决于客户端名字，也不代表支持所有 Codex/ACP 功能。

### 可选 CODEX_HOME 身份标记

客户端提供 `CODEX_HOME` 时，可在该目录的
`sessions/rollout-external-<thread-id>.jsonl` 写一个仅含身份的 `session_meta`。
标记不含正文、工具结果或用量；不是初始化、创建、执行的条件，也不能授权 resume。

冲突文件及 marker 文件 symlink 被拒绝；已有客户端 sessions 目录可解析到其实际标记目录。
创建时标记失败只回滚尚未原生派发的新空产品会话；resume 失败不能删除已有会话。

## 4. ACP 的能力与进度流

ACP 使用精确锁定的 SDK，声明稳定协议 v1。支持：

- `initialize`、`session/new`、`session/prompt`、`session/cancel`、`session/close`；
- 流式 `session/update`、`session/set_config_option` 模型选择；
- 双向 `session/request_permission`；同连接可拥有多个独立 cwd 的会话。

会话请求中的绝对 cwd 是权威，不必等于 CLI 启动目录。prompt 支持文本与 resource link；
引用不会触发隐式读文件或联网，模型真正读取时仍由原生工具授权。

不声明图片、音频、embedded resource、额外 roots、HTTP/SSE MCP、客户端文件系统或 terminal。
`loadSession` 为 false：身份标记或截断历史页无法满足 ACP 完整回放要求，不能靠改版本号宣称兼容。

### 进度准入与输出顺序

prompt 不阻塞接收循环，取消通知和审批回复可与执行/输出 drain 并发处理。
正文、reasoning 和工具事件直接投影原生执行；暂定 terminal-guard 正文等待 commit，rollback 时丢弃。
最终 prompt 响应排在本轮所有已排队 update 后面。

原生进度可能在会话投影准备中省略 SID。此时 Main 只有在同一来源连接的 `sessions.describe`
证明固定 SID 与 incarnation 后，才接纳未标注的正文、thinking 和工具进度；还需精确 active run，
或先前带精确会话身份的 lifecycle start。owner 投影可能不含 active-run 列表。
精确整轮终态可在 run 离开活动列表后证明先前排队事件，并为流划界。
显式身份冲突和未标注 lifecycle 仍拒绝。

输出使用同一 FIFO，上限 1024 帧 / 8 MiB，身份证明和 drain 各有五秒期限。
进度不能结算执行；输出失败也不能覆盖另行确认的原生结论。

## 5. ACP 会话 MCP 的资源管理

### 创建、目录与平台范围

Windows/Linux 接受每会话的 stdio MCP 定义，在首个 prompt 获准执行前连接。
服务器和包必须已在本地；推荐绝对 executable 路径，也可由受管 PATH 解析名称。
Runtime Services 经认证的 `runtimeServices.externalMcp.open/close` 拥有发现、子进程与清理。
定义仅属于该会话，不修改全局 MCP 或其他会话目录。

open 声明原生 session-write scope 和必要 profile，handler 在启动和整个 lease 期间还要求
连接的认证 admin scope。close 保留 admin 要求，但不要求会话仍存在，以便 reset/删除后清理。

macOS 可使用普通 CLI/ACP，但在启动会话 MCP 进程前拒绝该能力：锁定公开 MCP SDK 不提供
独立进程组创建，原生清理 API 无法确认回收 wrapper 后代进程。

### 工具调用与审批

锁定 SDK 要求静态工具名，因此 Runtime Services 只向精确 leased session 暴露固定
`external_mcp`。`list` 返回原服务器 schema（含 root 引用），`call` 选择 server/tool 并按
该 schema 验参；原始结果保留在工具详情。不伪造原生 MCP App 注册或客户端 terminal UI。

每次调用使用原生插件的一次性审批，Full 模式也不例外。审批绑定当前 lease、原生 session、
tool call 和 canonical 参数；客户端 annotations 不授权。root、权限或 incarnation 变化使旧 lease
失效。会话/连接关闭撤销 lease 并停止所属 MCP 进程，应用退出停止 registry。

## 6. 审批、取消与未知结果

### 审批归属

ACP 与支持双向 RPC 的 app-server 在 prepared turn 安装精确 approval owner 后声明交互审批；内部使用
`webchat` 和 `deliver:false` 以接收权限请求，不自动授权或向外部渠道投递回答。
普通 `exec` 保留原生非交互审批行为。

交互客户端独占本轮精确 native run 的 exec/plugin 审批展示；桌面列表排除已路由给该 owner 的请求。
ACP 保持原生支持的一次性允许／拒绝。app-server 命令审批另支持取消；只有实验握手和服务端
明确提供的 `availableDecisions` 才能启用 `acceptForSession`。该授权按连接、原生身份及命令／环境
精确指纹复用，每次仍提交原生 allow-once，不创建永久命令规则。它可跨同连接已结算轮次保留，
取消、身份变化或连接撤回按各入口生命周期清理；普通退订是否清理见[外部客户端规范](../../app-server-api/external-clients.md)。
插件确认通过实验性 user-input 请求展示；只有原生 bundle-mcp 明确提供持久 App action 时才显示该选项，
与命令会话授权及 ACP 会话 MCP 的一次性许可不同。

Main 在解决前复核 run、session、incarnation、连接、到期及实际允许的决定／action。
迟到、已取消、断连回复不允许操作；未知审批发送不在新连接重放。
纯图片路径在提交前安装 prepared owner，ACK 前暂扣请求；只有确认实际 native root 后才交给客户端，
不因提交未知而把展示权转移给观察者或桌面。字段和双向 RPC 示例见[审批规范](../../app-server-api/external-clients.md#服务端请求与审批)。

取消立即撤回本轮审批权限，包含正等待身份读取的回复；展示归属保留至结算，Stop 未确认时
不能让后续审批回退到桌面。

### 结算与恢复

CLI、入站 ACP 和通用 app-server 共用[错误自动重试](../execution/automatic-error-retry.md)。
符合规则的整轮失败会在当前请求内续跑，原请求 ID、会话预约和客户端连接继续有效。等待期间
可取消，客户端只收到最终结果。每次实际续跑使用独立原生运行 ID，沿用同一连接的审批和资源范围。

| 证据或事件                                               | 处理                                                                       |
| -------------------------------------------------------- | -------------------------------------------------------------------------- |
| 精确整轮终态 / 精确原生 wait 回执                        | 确认原生结果；本地取消与已确认成功/失败竞争时不改写结果                    |
| Stop ACK、chat final、attempt completion、历史正文、idle | 不足以结算                                                                 |
| 原生确认取消                                             | 才映射为 interrupted，退出码才可为 130                                     |
| 传输丢失或提交未知                                       | 保留原身份、回执与预留，不重发任务；后续 EOF/取消仍请求精确 abort          |
| 权威/回执长期不可用                                      | 有界核对后返回 unknown；精确证据表明仍 active 时可延长观察，不设总任务时限 |

yielded 后续执行若无法经公开 API 精确归属，保持 unknown 和预留。ACP 持有 MCP/审批资源时
替换 Gateway，也不能静默把资源转给新进程。应用重启后未知 CLI 记录继续阻塞，不假定取消或自动重放。

### 最终输出的补全

原生终态正文快照最多 4096 UTF-16 units。确认完成后，普通文本及图文只有同 run 的 final RPC、
匹配 producer metadata 与 snapshot projection，才可在五秒内恢复可能截断的全文。
app-server 纯图片的 `chat.send` 仅返回准入 ACK，因此改用当前认证 Gateway 的完整历史快照：
只接受唯一精确 run 的可见 final_answer，前后复核来源、身份和连接代次，并要求全文投影与终态快照一致。
不读取 transcript 文件、另存正文缓存或用“最新回复”补全。
无法核验或缺少全文时返回输出错误，保留已确认的执行结论；不重发提示词，也不把截断快照
追加到已流出的 ACP 正文。

## 验证范围与发布验收

| 证据层                      | 已覆盖内容                                                                                                                            | 不能替代什么                                                 |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| 定向测试                    | 真实 Windows console、独立 ACP SDK peer、UTF-8 拆包、默认发现、慢输出、审批/取消并发、stdio MCP、schema、来源隔离及未知元数据         | 正式安装包及真实远端服务                                     |
| 插件冷构建                  | resource sync / TS precompile 的实际 registry、Ajv、MCP client；无外部 node_modules 的本地 stdio server；清单及原生方法 scope/profile | 完整 Gateway/model/client 验收；原生会话和进程树边界仍有替身 |
| 2026-10-23 Windows 开发验收 | 无系统 Node/客户端任务变量；CLI、独立 ACP/app-server 真实模型调用；相互 resume、可选 marker、EOF；Multica 0.6.5 新会话                | POSIX 或最终 installer                                       |

历史开发验收的新映射为 `source='cli'`、精确原生身份及 settled 回执，旧 scoped 映射未改；
临时直连模型测试后恢复了原代理设置。上述历史证据不表示本次文档修改重新运行这些验收。

发布仍需在最终安装包、无系统 Node、公网阻断、无缓存、中文/空格路径下验证普通 CLI、独立
ACP 和 app-server peer，再验证 Multica 配置示例。覆盖模型选择、真实 MCP、审批、cancel、EOF、
断连及重启。测试产物不得保存私有 prompt、token 或原生 transcript。
