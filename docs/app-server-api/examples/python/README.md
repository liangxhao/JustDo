# Python WebSocket 调用示例

示例连接桌面应用提供的本机 app-server，完成：

`initialize` → `model/list` → `thread/start`（或 `thread/resume`）→ `turn/start` → 流式通知 → `turn/completed`。

需要 Python 3.10 或更新版本。桌面应用须已运行或驻留托盘，并已配置可用模型。
脚本只连接已运行的应用，不会启动另一套服务。

## 1. 安装依赖

在仓库根目录的 PowerShell 中运行：

```powershell
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

自动端口模式下，应用重启后地址可能变化，需要重新复制。保存固定端口或重新生成令牌后，
重启应用再复制配置；复制按钮始终返回当前正在运行的服务配置。

## 3. 运行

发送一条消息，实时打印助手正文，并等待本轮完成：

```powershell
python docs/app-server-api/examples/python/app_server_ws.py --config "$env:TEMP\app-server-connection.json" --message "你好，请用一句话介绍你能做什么。"
```

仅查询可用模型，不创建会话或发起模型任务：

```powershell
python docs/app-server-api/examples/python/app_server_ws.py --config "$env:TEMP\app-server-connection.json" --list-models
```

可选参数：

| 参数 | 用途 |
| --- | --- |
| `--model "<model-id>"` | 使用 `model/list` 返回的模型 ID；不传则沿用桌面默认值 |
| `--cwd "E:\workspace\project"` | 指定工作目录；不传则使用服务端默认目录 |
| `--thread-id "<thread-id>"` | 明确恢复以前的 CLI、ACP 或 app-server 外部会话，并发送这次的新消息 |
| `--timeout 600` | 收到 `turn/start` 响应后，等待整轮结果的总秒数，默认 300；每个 RPC 另有 60 秒超时 |

脚本将 Thread ID、Turn ID 和状态打印到 stderr，将助手正文打印到 stdout。
恢复时使用之前输出的 Thread ID；不能用桌面产品会话 ID 或原生 session key 替代。
此脚本演示一个会话，恢复时发送 `excludeTurns: true`，跳过脚本未展示的过去历史。
服务端支持同连接多线程和逐轮模型选择；本示例在创建／恢复时选择模型。
恢复时若传 `cwd`，必须与原会话目录一致。

收到服务端命令审批时，示例明确回复 `decline`，不会等待至超时或自动授权。
若要支持需要审批的工具，客户端应先向用户展示精确请求，再将用户选择返回到同一请求 ID。
本示例不启用实验插件确认；对其他服务端请求返回不支持。

## 结果判断

- `turn/start` 返回的 ID 只表示本地准入，仍须接收异步通知。
- 示例按 `threadId` 和 `turnId` 匹配通知，正文来自 `item/agentMessage/delta`。
  `item/completed` 的完整正文不会再次追加；没有 delta 时则直接显示完整正文。
  正文可能包含执行中的 commentary，最终回答 item 的 `phase` 为 `final_answer`。
- 只有匹配的 `turn/completed` 且 `status: completed` 时，脚本才以退出码 `0` 结束。
  `interrupted` 表示后端确认取消；`failed` 可能是执行、输出或结果核对错误。
- `EXECUTION_UNKNOWN:` 表示执行结果未知，不能当作原生执行已失败。超时、断线、正文结束
  也不能证明任务已停止。示例不会自动重连或重发输入；结果未知后先在桌面端核对。
- Ctrl+C 或超时会关闭连接，服务端请求取消所属执行；连接关闭不等于取消已经完成。
  如需显式停止，可发送 `turn/interrupt` 并带上精确的 `threadId`、`turnId`；其 ACK 也只表示取消请求。

字段与能力范围见[通用客户端规范](../../external-clients.md)，其中包含原生历史分页及
交互审批的完整边界。此示例只展示文本流，不展示历史、附件或浏览器页面上下文。
