# Python WebSocket 调用示例

本目录包含一个入门示例和六个进阶示例，连接桌面应用提供的本机 app-server。
入门示例完成：

`initialize` → `model/list` → `thread/start`（或 `thread/resume`）→ `turn/start` → 流式通知 → `turn/completed`。

需要 Python 3.10 或更新版本。桌面应用须已运行或驻留托盘，并已配置可用模型。
脚本只连接已运行的应用，不会启动另一套服务。

| 文件                                   | 场景                                         |
| -------------------------------------- | -------------------------------------------- |
| [app_server_ws.py](app_server_ws.py)   | 单次文本流式回复、模型查询、显式恢复         |
| [conversation.py](conversation.py)     | 同一会话连续多轮，逐轮选择模型               |
| [parallel_turns.py](parallel_turns.py) | 一个连接中的多会话并发，分别收集结果         |
| [history.py](history.py)               | 只读会话目录、Turn／Item 分页和完整历史      |
| [subscribe.py](subscribe.py)           | 独立客户端观察现有会话，不发送任务或停止请求 |
| [approvals.py](approvals.py)           | 流式接收期间逐次手动审批，支持实验插件确认   |
| [media.py](media.py)                   | 标准 image／localImage、图文及纯图片输入     |

进阶脚本共用 [app_server_client.py](app_server_client.py)，使用相同配置和依赖。
复制示例时保留这些文件在同一目录。公共客户端只有一个接收循环，等待 RPC 时保留通知，
审批输入通过后台线程返回 Future，不阻塞 WebSocket 接收。

## 1. 安装依赖

在仓库根目录的 PowerShell 中运行：

下面使用已有的 `py313` Conda 环境；也可直接使用其他 Python 3.10 以上环境。

```powershell
conda activate py313
python -m pip install -r docs/app-server-api/examples/python/requirements.txt
```

公司内网可使用已配置的内部 pip 源，或预先准备 wheel 后离线安装：

```powershell
python -m pip install --no-index --find-links "E:\offline-wheels" -r docs/app-server-api/examples/python/requirements.txt
```

依赖是 `websocket-client`，导入名为 `websocket`。它属于示例客户端的依赖，
不会改变桌面应用的运行时或安装包。连接参数参考该库的
[官方文档](https://websocket-client.readthedocs.io/en/latest/core.html#websocket._core.WebSocket.connect)。

## 2. 复制连接配置

在“设置 → 外部连接 → 应用接入 → WebSocket”点击复制当前配置，
将剪贴板中的完整 JSON 保存到仓库外。例如，在复制后执行：

```powershell
Get-Clipboard | Set-Content -LiteralPath "$env:TEMP\app-server-connection.json" -Encoding utf8
```

配置的结构如下，实际地址和令牌使用复制出的值：

```json
{
  "url": "ws://127.0.0.1:<current-port>/app-server",
  "headers": { "Authorization": "Bearer <current-token>" }
}
```

该文件含连接凭据，不要提交到 Git 或输出到日志。不要开启库的 `enableTrace`，
它会打印认证请求头。示例只使用 `Authorization`，并限制连接到上述本机入口。
`suppress_origin=True` 必须保留：该入口拒绝包含 `Origin` 的请求。
示例先用标准库 socket 直连 `127.0.0.1`，再交给 websocket-client，避免环境代理接收连接凭据；
同时用 `redirect_limit=0` 禁止带令牌跳转。配置中的其他主机、查询参数和 URL 凭据均拒绝。

自动端口模式下，应用重启后地址可能变化，需要重新复制。保存固定端口或重新生成令牌后，
重启应用再复制配置；复制按钮始终返回当前正在运行的服务配置。

## 3. 运行

发送一条消息，实时打印助手正文，并等待本轮完成：

```powershell
python docs/app-server-api/examples/python/app_server_ws.py --config "$env:TEMP\app-server-connection.json" --message "你好，请用一句话介绍你能做什么。"
```

仅查询模型目录的第一页，不创建会话或发起模型任务：

```powershell
python docs/app-server-api/examples/python/app_server_ws.py --config "$env:TEMP\app-server-connection.json" --list-models
```

该入门脚本没有自动翻模型页，默认最多返回 50 项；若 `nextCursor` 非空，完整客户端应继续调用
`model/list` 并传入该游标，直到为 `null`。模型 ID 和 `inputModalities` 使用真实目录结果。

可选参数：

| 参数                           | 用途                                                                              |
| ------------------------------ | --------------------------------------------------------------------------------- |
| `--model "<model-id>"`         | 使用 `model/list` 返回的模型 ID；不传则沿用桌面默认值                             |
| `--cwd "E:\workspace\project"` | 指定工作目录；不传则使用服务端默认目录                                            |
| `--thread-id "<thread-id>"`    | 明确恢复以前的 CLI、ACP 或 app-server 外部会话，并发送这次的新消息                |
| `--timeout 600`                | 收到 `turn/start` 响应后，等待整轮结果的总秒数，默认 300；每个 RPC 另有 60 秒超时 |

脚本将 Thread ID、Turn ID 和状态打印到 stderr，将助手正文打印到 stdout。
恢复时使用之前输出的 Thread ID；不能用桌面产品会话 ID 或原生 session key 替代。
此脚本演示一个会话，恢复时发送 `excludeTurns: true`，跳过脚本未展示的过去历史。
服务端支持同连接多线程和逐轮模型选择；本示例在创建／恢复时选择模型。
恢复时若传 `cwd`，必须与原会话目录一致。

收到服务端命令审批时，示例明确回复 `decline`，不会等待至超时或自动授权。
若要支持需要审批的工具，客户端应先向用户展示精确请求，再将用户选择返回到同一请求 ID。
本示例不启用实验插件确认；收到 `item/tool/requestUserInput` 时回复空 `answers`，
未知服务端方法回复 `-32601`。它不提供交互审批界面。

## 4. 多轮对话与逐轮模型

重复 `--message` 表示明确提交的多轮新输入；每轮完成后才发送下一轮：

```powershell
python docs/app-server-api/examples/python/conversation.py --config "$env:TEMP\app-server-connection.json" --message "不要使用工具。设计一个简单的待办事项数据结构。" --message "在刚才的结构上补充截止日期。"
```

添加 `--thread-id "<thread-id>"` 可在旧会话继续发送这些新消息，历史输入不会被重发。
`--model "<model-id>"` 指定所有轮次使用的模型，也可重复 `--model` 并与消息逐项对应；
ID 使用入门脚本 `--list-models` 的真实结果。`--timeout` 是每一轮的等待秒数，默认 300。
失败、取消或 `EXECUTION_UNKNOWN:` 均停止后续轮次。

## 5. 一个连接并发多个会话

每个 `--message` 创建一个独立会话；脚本先提交各轮，再按精确 Thread／Turn ID 收集全部结果：

```powershell
python docs/app-server-api/examples/python/parallel_turns.py --config "$env:TEMP\app-server-connection.json" --message "不要使用工具。用三句话介绍 SQLite。" --message "不要使用工具。用三句话介绍 WebSocket。" --timeout 180
```

最多 32 个会话，`--cwd` 为各会话的公共工作目录。`--model` 的单值／逐项对应规则与多轮示例相同。
某个明确拒绝的任务不会重发，也不会取消其他已接纳任务；脚本仍收集它们的结果。
所有准入调用结束后，等待使用一个总期限；每个准入 RPC 仍有独立的 60 秒期限。
超时输出已经完成的结果和仍未核实的 ID。Ctrl+C 立即关闭连接，
不把取消请求当作执行已经停止。

## 6. 历史读取与分页

只列外部会话元数据，不创建或恢复会话：

```powershell
python docs/app-server-api/examples/python/history.py --config "$env:TEMP\app-server-connection.json" --limit 10 --pages 2
```

读取某个会话的 Turn 摘要页，或读取指定 Turn 的 Item：

```powershell
python docs/app-server-api/examples/python/history.py --config "$env:TEMP\app-server-connection.json" --thread-id "<thread-id>" --view turns --limit 2 --pages 3
python docs/app-server-api/examples/python/history.py --config "$env:TEMP\app-server-connection.json" --thread-id "<thread-id>" --view items --turn-id "<turn-id>" --limit 10
```

每页输出独立 JSON，并保留 `nextCursor`。达到 `--pages` 后可用 `--cursor "<nextCursor>"`
接着查询；线程、视图、排序和筛选条件须保持一致。历史发生变化使游标失效时，脚本直接报错，
不会自动从头重读。`--limit` 范围为 1 到 200，默认 50；`--pages` 默认 1。

`--view full` 使用一次 `thread/read(includeTurns: true)`，不分页，也不受 `--limit`／`--pages` 控制。
完整历史超限时改用分页视图。所有结果只打印到 stdout，不自动写入历史文件或取得执行所有权。

## 7. 独立观察客户端

在第二个终端运行，使用对话脚本输出的外部 Thread ID：

```powershell
python docs/app-server-api/examples/python/subscribe.py --config "$env:TEMP\app-server-connection.json" --thread-id "<thread-id>" --timeout 120
```

它使用 `thread/resume(excludeTurns: true)` 订阅后续通知，不回放错过的实时事件，也不提交新轮次。
然后在第一个终端使用 `conversation.py --thread-id "<thread-id>" --message "<new-message>"` 继续对话，
两个客户端都可接收后续结果。观察者不会取得其他连接的执行或审批权限。
观察期限结束或 Ctrl+C 时先尽力退订，再关闭自己的连接；不会向拥有者的轮次发送停止请求。

## 8. 手动审批

使用需要工具的明确任务，逐次展示原生命令、目录、原因和对应 Thread／Turn：

```powershell
python docs/app-server-api/examples/python/approvals.py --config "$env:TEMP\app-server-connection.json" --message "请在当前目录运行只读命令 pwd 并告诉我结果。"
```

命令提示输入 `accept`、`decline` 或 `cancel`；回车、EOF 或不支持的请求均拒绝。
`accept` 只允许这一次请求，`cancel` 还请求取消对应轮次，仍须等待原生结果。
开启 `--experimental` 且服务端明确提供时，也可输入 `acceptForSession`，
只复用该连接中同一原生会话的精确相同命令／环境，不写永久命令规则。
该许可可跨本连接已结算的轮次复用，空闲退订本身不清除；关闭连接、`cancel` 或身份／代次变化会撤回，
也可能因有界缓存回收而重新提示。新连接不继承旧连接的命令许可。
是否触发审批由真实权限模式和工具决定，`on-request` 不保证每条命令都会出现提示。
`--thread-id`、`--model`、`--cwd` 和 `--timeout` 与其他对话示例含义一致。

添加 `--experimental` 才开启本产品的实验插件确认。脚本逐项展示真实选项，
输入对应序号回传服务端标签，不根据中文／英文文字猜测允许项。
只有原生明确提供时才出现“始终允许此 App”，它是原生 App 持久授权，范围与命令会话授权不同。
此选择可在原生 App 权限设置中管理；脚本不创建或模拟永久命令规则。

等待用户输入时继续接收回复及审批撤销。标准输入无法跨平台强制中断：若旧请求已撤销或过期，
之后输入的选择会被丢弃；旧输入线程仍在等待时，新请求直接拒绝。按 Enter 结束旧提示后，
才能显示下一次提示。最多使用一个后台输入线程，关闭连接后不会发送迟到选择。
本地审批等待上限为 60 秒，服务器可更早撤销；`--timeout` 不会延长审批许可。

## 9. 标准图片输入

读取客户端图片，转换成标准 image data URL；不把客户端本地路径传给宿主：

```powershell
python docs/app-server-api/examples/python/media.py --config "$env:TEMP\app-server-connection.json" --image-file "E:\images\diagram.png" --message "解释这张图。"
```

省略 `--message` 即纯图片输入，不生成占位 prompt。`--image-file`、`--local-image` 和
`--image-url` 可混用／重复，图片相对顺序保留。`--local-image` 指桌面线程 cwd 内的真实图片路径；
`--image-url` 仅支持宿主允许的私网 IP 字面地址 HTTP(S) 资源，不带 Cookie 或模型凭据。
不接受域名、loopback／链路本地地址、URL 用户名／密码或 fragment，也不跟随重定向；
使用宿主已有代理设置，每张远程图片读取上限 15 秒。
域名图片可先由客户端获取为本地文件，再用 `--image-file`。
格式为 PNG／JPEG／GIF／WebP，最多 5 张、解码后合计 4 MiB；真实模型必须声明 image 模态。
文本按 UTF-8 最多 2 MiB，规范化 content 编码后最多 6 MiB，完整 JSON 消息仍须低于 8 MiB。
`--image-file` 的读取范围由客户端机器权限决定；`--local-image` 在宿主解析真实路径，必须位于线程 cwd 内。
文本和图片在原生侧归一为合并文字和有序图片，实时通知与历史使用相同含义，不承诺交错位置。
当前不支持 audio／localAudio、fileId 和非 auto 的图片 detail。
此脚本仍默认拒绝工具审批；终端省略含完整图片字节的 userMessage 通知，继续输出模型进度和结果。
纯图片走原生 chat.send：保留 SID、连接代次和发送前后身份核对，但没有带文字图片使用的原生 revision CAS。
身份或 ACK 不匹配仍为 unknown，不能重发。长回复仅凭认证历史中的唯一精确执行 final_answer
与原生截断摘要匹配恢复；恢复失败是输出错误，不代表已确认完成的原生执行变成失败。

## 10. 验证示例

本地测试不连接桌面应用、不读取凭据或启动模型，覆盖提前通知、并发结果、未知状态、
超时、分页游标、观察者退订、审批撤销和媒体参数构造：

```powershell
conda activate py313
python -B -m unittest discover -s docs/app-server-api/examples/python/tests -v
```

进阶脚本的 stdout 使用 JSON 行输出通知及结果，stderr 输出运行 ID、审批提示和错误。
公共客户端对帧、通知队列、文本及审批身份设有容量上限；超限明确失败，不静默丢掉终态。
单帧仍限制 8 MiB，等待其他 RPC 时的聚合缓存为 16 MiB，能够同时保留大图片的 started／completed 两份通知。
队列还限制通知数量、审批请求与已见 ID 数量，长期运行到上限会明确退出；该示例客户端不是无界常驻服务。
JSON 输出可能包含用户输入、工具结果、图片字节及真实图片引用路径；只有 `media.py` 主动省略 userMessage 通知，
只读历史和观察脚本仍会按请求输出它们。不应将这些结果当作已脱敏日志。
这些示例均不自动重连、重发任务或批准工具。

验证记录：六个进阶入口均完成命令帮助和本地测试；审批另经真实本机 WebSocket 测试服务验证
允许、拒绝、实验插件选项和输入等待时撤销，执行后端为替身。
协议统一前的真实桌面文本／历史联调不能替代本轮图片与审批整链验收。
当前已验证和未验证的范围统一维护在[兼容性说明](../../compatibility.md#已验证与未验证)。

## 结果判断

- `turn/start` 返回的 ID 只表示本地准入，仍须接收异步通知。
- 示例按 `threadId` 和 `turnId` 匹配通知，正文来自 `item/agentMessage/delta`。
  `item/completed` 的完整正文不会再次追加；没有 delta 时则直接显示完整正文。
  正文可能包含执行中的 commentary，最终回答 item 的 `phase` 为 `final_answer`。
- 发送任务的示例只有全部请求匹配 `turn/completed` 且 `status: completed` 时才以退出码 `0` 结束；
  模型查询、历史读取和观察脚本按自身查询／观察是否正常完成退出。
  `interrupted` 表示后端确认取消；`failed` 可能是执行、输出或结果核对错误。
- `EXECUTION_UNKNOWN:` 表示执行结果未知，不能当作原生执行已失败。超时、断线、正文结束
  也不能证明任务已停止。示例不会自动重连或重发输入；结果未知后先在桌面端核对。
- Ctrl+C 或超时会关闭连接，服务端请求取消所属执行；连接关闭不等于取消已经完成。
  如需显式停止，可发送 `turn/interrupt` 并带上精确的 `threadId`、`turnId`；其 ACK 也只表示取消请求。

字段与能力范围见[通用客户端规范](../../external-clients.md)，其中包含原生历史分页及
交互审批的完整边界。入门脚本 app_server_ws.py 只展示文本流，不展示历史、附件或浏览器页面上下文。
