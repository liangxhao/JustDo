# Python WebSocket 调用示例

用 Python 连接桌面应用的 app-server，发送消息并接收流式回复。
先启动桌面应用并配置好模型；示例需要 Python 3.10 或更新版本。

## 快速开始

### 1. 安装依赖

在仓库根目录打开 PowerShell，进入示例目录并安装依赖：

```powershell
conda activate py313
cd docs/app-server-api/examples/python
python -m pip install -r requirements.txt
```

没有 `py313` 环境时，使用其他 Python 3.10 以上环境即可。
后面的命令都在这个目录运行。

### 2. 保存连接配置

在桌面应用的“设置 → 外部连接 → 应用接入 → WebSocket”中复制配置。
在当前目录新建 `app-server-connection.json`，粘贴配置并保存。

文件内容如下，地址和令牌以应用中复制的值为准：

```json
{
  "url": "ws://127.0.0.1:<current-port>/app-server",
  "headers": { "Authorization": "Bearer <current-token>" }
}
```

这个文件含连接令牌，已加入 Git 忽略规则。不要把令牌发给他人或写进日志。
自动分配的端口可能在应用重启后变化，届时重新复制配置。
修改固定端口或重新生成令牌后，也需要重启应用，再复制配置。

### 3. 发送消息

```powershell
python app_server_ws.py --config app-server-connection.json --message "你好，请用一句话介绍你能做什么。"
```

脚本会实时打印助手回复，等本轮结束后退出。Thread ID（会话 ID）、Turn ID（本轮 ID）和状态也会显示在终端。
入门示例会拒绝工具审批；需要手动批准工具时，使用下面的 [approvals.py](#手动审批)。

## 选择示例

所有示例使用同一份配置文件和依赖。

| 文件                                   | 用途                                                 |
| -------------------------------------- | ---------------------------------------------------- |
| [app_server_ws.py](app_server_ws.py)   | 发送一条消息，接收流式回复；也可查询模型或继续旧会话 |
| [conversation.py](conversation.py)     | 在同一会话中连续发送多条消息                         |
| [parallel_turns.py](parallel_turns.py) | 同时运行多个独立会话                                 |
| [history.py](history.py)               | 查看会话列表和历史记录                               |
| [subscribe.py](subscribe.py)           | 在另一个终端观察会话的后续消息                       |
| [approvals.py](approvals.py)           | 手动批准或拒绝工具请求                               |
| [media.py](media.py)                   | 发送图片或图文消息                                   |

进阶示例共用 [app_server_client.py](app_server_client.py)。复制示例时，请把它和
[app_server_ws.py](app_server_ws.py) 一起保留在同一目录。

## 查询模型与常用参数

查看可用模型：

```powershell
python app_server_ws.py --config app-server-connection.json --list-models
```

这条命令只查询模型，不发送对话。最多显示前 50 项；开发完整客户端时，若返回的 `nextCursor` 不为空，
应继续调用 `model/list` 读取下一页。

| 参数                           | 用途                                                      |
| ------------------------------ | --------------------------------------------------------- |
| `--model "<model-id>"`         | 选择查询结果中的模型；不传则使用桌面默认模型              |
| `--cwd "E:\workspace\project"` | 设置工作目录；不传则使用服务端默认目录                    |
| `--thread-id "<thread-id>"`    | 继续以前的 CLI、ACP 或 app-server 会话，并发送新消息      |
| `--timeout 600`                | 等待本轮结果的秒数，默认 300；每次 RPC 调用另有 60 秒超时 |

`--thread-id` 使用脚本输出的 Thread ID。新建外部会话的 Thread ID 与应用会话 ID 相同；
已有会话继续使用原来的 Thread ID。普通桌面或 Chrome 会话 ID、OpenClaw 原生 ID 不能用于恢复外部会话。
继续旧会话时，若传入 `--cwd`，必须与原会话目录一致。

## 多轮对话

每个 `--message` 是一条新消息，前一轮完成后再发送下一条：

```powershell
python conversation.py --config app-server-connection.json --message "不要使用工具。设计一个待办事项数据结构。" --message "在刚才的结构上补充截止日期。"
```

添加 `--thread-id "<thread-id>"` 可继续旧会话，不会重发历史消息。
传一个 `--model` 时，所有轮次使用同一模型。要在同一会话中切换模型，为每条消息分别传一个
`--model`，按顺序对应。将下面两个示例值替换为 `--list-models` 返回的两个完整 `data[].id`。

```powershell
$modelA = "provider-a/model-a"
$modelB = "provider-b/model-b"
python conversation.py --config app-server-connection.json --message "设计一个待办事项数据结构。" --model $modelA --message "在刚才的结构上补充截止日期。" --model $modelB
```

创建或恢复会话时使用第一个指定的模型。旧会话的模型下架后，可用 `--thread-id` 和 `--model` 指定当前可用的模型继续。
`--timeout` 按每一轮计算，默认 300 秒。某轮失败、取消或结果未知时，脚本停止发送后续消息。

## 并发对话

每个 `--message` 创建一个独立会话，脚本提交所有消息后等待各自的结果：

```powershell
python parallel_turns.py --config app-server-connection.json --message "不要使用工具。用三句话介绍 SQLite。" --message "不要使用工具。用三句话介绍 WebSocket。" --timeout 180
```

最多同时创建 32 个会话。`--cwd` 对所有会话生效，`--model` 的用法与多轮示例相同。
某个任务被拒绝时，脚本仍会等待其他已接收的任务。
所有提交调用结束后，按 `--timeout` 等待结果；每次提交另有 60 秒超时。
超时后会列出已完成的结果和结果未知的 ID。按 Ctrl+C 关闭连接，并不代表任务已经停止。

## 查看历史

列出会话，每页 10 条，最多读取 2 页：

```powershell
python history.py --config app-server-connection.json --limit 10 --pages 2
```

查看某个会话的轮次列表：

```powershell
python history.py --config app-server-connection.json --thread-id "<thread-id>" --view turns --limit 2 --pages 3
```

查看某一轮的消息和工具记录：

```powershell
python history.py --config app-server-connection.json --thread-id "<thread-id>" --view items --turn-id "<turn-id>" --limit 10
```

每页输出一条 JSON。结果中的 `nextCursor` 不为空时，可添加 `--cursor "<nextCursor>"` 继续查询，
会话、视图、排序和筛选条件须保持一致。游标失效时会报错，不会自动从头读取。
`--limit` 为每页条数，范围 1～200，默认 50；`--pages` 默认为 1。

`--view full` 一次读取完整会话，不受 `--limit` 和 `--pages` 控制；历史过大时请改用分页。
这个示例只读取历史，不创建会话、不执行任务，也不会把结果自动保存到文件。

## 观察会话

在另一个终端进入示例目录，用已有的 Thread ID 运行：

```powershell
python subscribe.py --config app-server-connection.json --thread-id "<thread-id>" --timeout 120
```

然后在原终端继续向同一会话发送消息：

```powershell
python conversation.py --config app-server-connection.json --thread-id "<thread-id>" --message "继续刚才的话题。"
```

两个终端都会收到后续消息。观察示例只订阅运行期间的新通知，不补发之前的通知，也不会取得其他连接的执行或审批权限。
达到观察时间或按 Ctrl+C 后，它会尝试退订并关闭自己的连接，不会停止另一个终端的任务。

## 手动审批

这个示例会展示工具请求的命令、工作目录、原因和对应的会话／轮次，等待你选择：

```powershell
python approvals.py --config app-server-connection.json --message "请在当前目录运行只读命令 pwd 并告诉我结果。"
```

| 输入      | 行为                                             |
| --------- | ------------------------------------------------ |
| `accept`  | 允许这一次请求                                   |
| `decline` | 拒绝这一次请求                                   |
| `cancel`  | 拒绝请求，并请求取消本轮；仍需等待服务端确认结果 |
| 直接回车  | 拒绝请求                                         |

是否出现审批提示，取决于应用的权限设置和实际调用的工具。`on-request` 不保证每条命令都需要审批。
`--thread-id`、`--model`、`--cwd` 和 `--timeout` 与其他对话示例相同。

添加 `--experimental` 可使用服务端提供的实验审批选项：

- **命令会话授权**：只有服务端提供 `acceptForSession` 时才能选择。只对当前连接、同一原生会话中完全相同的命令和环境生效，不保存永久命令规则。
  授权可跨轮次使用；空闲退订不会清除。关闭连接、取消或会话身份变化时撤回，缓存回收后也可能再次询问。新连接不继承旧授权。
- **插件确认**：按提示输入选项序号。只有服务端提供时才会出现“始终允许此 App”；该授权由原生 App 权限设置管理，与上面的命令会话授权不同。

等待输入期间，脚本仍会接收消息和审批撤销。审批过期或撤销后，迟到的选择会被丢弃。
旧提示仍在等输入时，新请求会被拒绝；按 Enter 结束旧提示后才能显示新提示。
审批最多等待 60 秒，服务端可能更早撤销，`--timeout` 不会延长审批时间。
输入结束（EOF）或不支持的请求也会被拒绝。

## 发送图片

发送本机图片和文字：

```powershell
python media.py --config app-server-connection.json --image-file "E:\images\diagram.png" --message "解释这张图。"
```

省略 `--message` 就是只发送图片。三种图片参数可以混用、重复，图片顺序与参数顺序一致：

| 参数                                               | 读取位置和要求                                         |
| -------------------------------------------------- | ------------------------------------------------------ |
| `--image-file "E:\images\diagram.png"`             | Python 所在电脑上的文件，脚本读出后转为 data URL 发送  |
| `--local-image "E:\workspace\project\diagram.png"` | 桌面应用所在电脑上的文件，真实路径必须在会话工作目录内 |
| `--image-url "http://<private-ip>/diagram.png"`    | 由桌面应用读取，只支持允许的私网 IP 地址，不支持域名   |

模型必须支持图片输入。图片支持 PNG、JPEG、GIF、WebP，最多 5 张，原始字节合计不超过 4 MiB。
文字最多 2 MiB（UTF-8）；编码后的输入内容最多 6 MiB，完整 JSON 消息须小于 8 MiB。
当前不支持音频、`fileId` 或非 `auto` 的图片 `detail`。

远程图片请求不带 Cookie 或模型凭据，不允许回环／链路本地地址、URL 用户名密码、fragment 或重定向。
请求使用桌面应用已有的代理设置，每张图片最多读取 15 秒。域名图片可先下载，再用 `--image-file` 发送。
文字会合并，图片保留顺序，不保证文字与图片交错的位置。

这个示例默认拒绝工具审批。终端会显示模型进度和结果，但会省略含完整图片数据的 `userMessage` 通知。
纯图片发送的身份核对和长回复恢复边界见[兼容性说明](../../compatibility.md#有意保留的宿主边界)。

## 输出与结果判断

入门脚本将助手正文输出到 stdout，将运行 ID 和状态输出到 stderr。
进阶脚本在 stdout 中按行输出 JSON，在 stderr 中显示运行 ID、审批提示和错误。
JSON 可能包含用户输入、工具结果、图片数据和路径，不能当作已脱敏日志。
只有 `media.py` 省略 `userMessage`，历史和观察示例仍可能输出这些内容。

- `turn/start` 返回 ID 只表示请求已接收。还要等到对应会话和轮次的 `turn/completed`，才能判断结果。
- 发送任务的示例只有所有任务都以 `status: completed` 结束时才返回退出码 `0`。查询和观察示例按各自操作是否正常完成退出。
- `interrupted` 表示服务端已确认取消；`failed` 可能是执行失败，也可能是输出或结果核对出错。
- `EXECUTION_UNKNOWN:` 表示结果未知。超时、断线或回复文字结束，都不能证明任务已停止。先在桌面应用中核对，不要直接重发。
- Ctrl+C 或超时会关闭连接，服务端会请求取消该连接的任务。关闭连接不代表取消完成；`turn/interrupt` 的响应也只表示收到取消请求。

所有示例都不会自动重连、自动重发任务或自动批准工具。

## 实现说明

需要修改客户端时，再查看这些细节和[通用客户端规范](../../external-clients.md)：

- 调用顺序为 `initialize` → `initialized` → `model/list` → `thread/start` 或 `thread/resume` → `turn/start` → 接收通知，直到 `turn/completed`。
- 入门示例一次处理一个会话，在创建或恢复会话时选择模型。恢复时使用 `excludeTurns: true`，不读取旧历史；服务端也支持同连接多会话和逐轮选择模型。
- 入门示例不启用实验插件确认：命令审批返回 `decline`，`item/tool/requestUserInput` 返回空 `answers`，未知服务端方法返回 `-32601`。交互审批见 `approvals.py`。
- 进阶示例共用一个接收循环，等待 RPC 时会保留通知；审批使用一个后台输入线程，避免阻塞消息接收。关闭连接后不再发送迟到的审批选择。
- 回复按 `threadId`、`turnId` 匹配。正文来自 `item/agentMessage/delta`；`item/completed` 只在没有 delta 时补充完整正文，避免重复输出。执行中的文字可能是 commentary，最终回答的 `phase` 为 `final_answer`。
- 示例只接受设置中复制的本机 `127.0.0.1` 地址。连接先用标准库 socket 直连，再交给 `websocket-client`，避开环境代理；`redirect_limit=0` 禁止带令牌跳转，`suppress_origin=True` 避免发送服务端不接受的 `Origin`。不接受其他主机、查询参数或 URL 凭据。
- 不要开启 `websocket.enableTrace`，它会打印认证请求头。连接参数可查阅 `websocket-client` 的[官方文档](https://websocket-client.readthedocs.io/en/latest/core.html#websocket._core.WebSocket.connect)。
- 客户端限制单帧 8 MiB、等待 RPC 时的通知缓存合计 16 MiB，可同时保留图片的 started／completed 通知。通知、文本和审批记录也有数量上限，超限时会报错退出，不会悄悄丢弃完成通知。示例适合学习和短期调用，不适合直接作为长期运行的服务。

## 离线安装与本地测试

内网环境可使用已配置的内部 pip 源。如果已准备好依赖 wheel，也可以离线安装：

```powershell
python -m pip install --no-index --find-links "E:\offline-wheels" -r requirements.txt
```

运行本地测试：

```powershell
python -B -m unittest discover -s tests -v
```

测试不连接桌面应用、不读取令牌，也不调用模型。覆盖提前到达的通知、并发结果、未知状态、超时、分页、退订、审批撤销和图片参数。
六个进阶示例已检查命令帮助并通过本地测试；审批还使用本机 WebSocket 测试服务验证过允许、拒绝、插件选项和等待输入时撤销，执行后端为测试替身。
这些测试不能代替真实桌面应用的图片和审批完整联调，当前验证范围见[兼容性说明](../../compatibility.md#已验证与未验证)。
