# 宿主接入要求

本页面向为 Chrome Assistant 提供桌面宿主的集成方。客户端需要宿主提供 Native Messaging 发现程序、执行引擎和应用会话服务。集成从实例发现和鉴权开始，随后实现协议、会话和授权，再验证真实发布链路。

## 发现与鉴权

Native Messaging 注册须匹配扩展的固定身份。发现程序只查找已经运行的桌面实例。版本与帧格式见[实例发现](protocol/native-messaging.md)。

WebSocket 需要校验 loopback、精确路径、扩展 Origin 和当前进程的 capability。连接成功后仍按会话归属与工具权限授权。发现凭据只用于扩展与宿主建立连接，执行引擎凭据由宿主保管。

## 标准协议

基础 Thread、Turn、Item 和双向 RPC 采用已实现的 Codex app-server 方法。每条连接先执行 `initialize` 和 `initialized`，再调用 `model/list`、`thread/start`、`thread/resume`、`thread/read`、`thread/list`、`turn/start` 或 `turn/interrupt`。请求、响应和服务端请求的答复按各自 ID 关联，客户端忽略未知的附加字段。上游说明见 [Codex app-server 协议](https://learn.chatgpt.com/docs/app-server)。

宿主以本包明确列出的字段、方法和验证基线作为兼容范围。详见[方法与字段](protocol/app-server.md)、[数据模型](protocol/data-models.md)和[兼容性](protocol/compatibility.md)。

### 客户端使用的标准载体

Thread 包含 `id`、来源、目录、标题及加载状态。Turn 包含 `id`、`status`、`items`、`itemsView` 和错误信息。Thread 与 Turn 的创建和起止时间使用 Unix 秒，Item 的 `startedAtMs`、`completedAtMs` 和 `durationMs` 使用毫秒。富显示和执行结算使用各自的字段，详见[数据模型](protocol/data-models.md)。

多段文字以换行合并，图片之间保持相对顺序。原生输入采用合并后的文字和有序附件，实时用户 Item 和历史都按这个规则归一化。交错输入会重新归组为文字和图片，纯图片消息的用户文本为空，内容中省略空文字占位。

规范化的 `content` JSON 最多 6 MiB，其中合并文字最多 2 MiB UTF-8。输入仍须满足扩展的 32,000 UTF-16 code units 和帧限额。非空 `text_elements`、音频、`fileId` 与非 `auto` 图片 `detail` 应拒绝。原生历史中的受管 `localImage` 引用通过已授权的图片接口读取。

## 会话、输入与执行

宿主只允许扩展操作由扩展创建的产品会话，并精确绑定原生会话、运行和连接代次。

标准图片输入限于 data URL。宿主校验 PNG、JPEG、GIF、WebP 的实际字节，并按以下上限接收消息。

| 项目                | 上限或要求                                             |
| ------------------- | ------------------------------------------------------ |
| 文本                | 32,000 UTF-16 code units，同时满足标准载体和帧限额     |
| 图片与文档附件      | 合计最多 5 项、4 MiB                                   |
| 入站 WebSocket 消息 | 8 MiB                                                  |
| 模型图片能力        | 取自实际模型目录                                       |
| 图片读取            | 仅限已授权接口中的受管引用。拒绝任意文件路径和远程下载 |

`chat.send` 依赖精确 SID、权限和调用前后的身份校验。此发送路径没有原子的 lifecycle revision CAS。ACK 不匹配或身份变化时，执行保留为 `unknown`。

执行以精确的整轮终态结算。发送 ACK、停止 ACK、正文结束、idle 或视图关闭均不提供终态证据。断开时撤回观察和审批，已接纳的工作可以继续。恢复时查询同一精确身份，未知提交只查状态，不重放输入。宿主以原生历史为准，计时、显示分组和客户端缓存均不参与结算。详见[生命周期与错误](protocol/lifecycle-errors.md)。

## 审批与网页入口

只有实际发送连接可回答其运行的审批。审批解决、撤销、到期或连接换代后，旧回复失效。命令会话授权要求实验握手及服务端明确提供的选项，每次仍由原生作出一次性决定。持久 App 权限只接受真实的原生 action。界面与用户操作见[侧栏审批](side-panel.md#侧栏审批)。

网站连接、直接发送和结果分享分别授权，并独立于工具审批。网页接入步骤见[网页 SDK](website-sdk.md)，输入、结果和取消的边界见[网页发起对话与结果分享](website-launch.md)。

## 集成验收

使用已打包的桌面应用、真实 Native Host、匹配的扩展身份、原生授权和实际模型验证完整链路。客户端单测与本机 HTTP/WebSocket 夹具用于验证对应环节，发布前还需完成上述集成验收。具体验证范围见[兼容性与测试](protocol/compatibility.md)。
