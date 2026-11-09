# Chrome WebSocket app-server 协议

Chrome 使用与 CLI／本机 WebSocket 相同的基础 app-server 方法、参数、Thread／Turn／Item、
错误分类及标准通知。基础字段以[宿主接入要求](../protocol-contract.md)为准；
本页只维护入口鉴权、浏览器附加能力和服务端会话策略。

附加能力由 `main/chrome/` 自己定义和注册；公共 `main/clients/appServer/protocol/` 不包含浏览器
协议常量、业务错误分支或反向依赖。共享引擎只提供精确的通用 extensions 注册，
所有扩展调用需要请求 ID，不能替换标准方法，也不能由客户端握手声明开启。

## 建立连接

扩展通过 Native Messaging 获取完整地址，不猜测端口或 capability：

```text
ws://127.0.0.1:<dynamic-port>/app-server?token=<64 hex chars>
```

HTTP Upgrade 同时校验 loopback、固定 `/app-server` 路径、当前进程 capability 和
`Origin: chrome-extension://jboajogplelmaahjbomgflnfngpolgcb`。
通用原生入口则校验 Bearer 并拒绝 Origin。两种凭据不互换，客户端名称与能力声明不改变来源范围。

入站每条 JSON 文本消息最多 8 MiB；Chrome 出站最多 32 MiB，待发缓冲最多 64 MiB。
较大的出站额度服务于已有 20 MiB 图片读取和 Base64 开销，不扩大工具、文件或会话权限。
侧栏附件仍限制最多 5 个、原始文件合计最多 4 MiB，Main 另校验编码后总量。

本轮基础字段与私有命名空间调整将 Chrome app-server 发现版本提升为 4；
Native Messaging framing／握手版本仍为 2。应用与扩展须使用匹配产物，旧版不会静默降级。
更新后重启应用并重新加载扩展；安装版最终验收见[兼容性与测试](compatibility.md)。

## 统一基础协议

消息省略 `jsonrpc`。请求使用字符串或安全整数 ID，响应按 ID 匹配；批量请求不支持。
成功 `initialize` 后发送 `initialized` 通知，再调用业务方法。
参数不是对象、非法 ID、错误初始化、重复初始化和未知方法的处理与通用入口一致。
无 ID 的业务通知不执行任务。

以下每行分别发送为一条 WebSocket 文本消息，不将整个示例或 JSON 数组放入同一帧。
这里与当前 Side Panel 一样显式协商实验能力，用于服务端实际提供的命令会话授权和插件确认；
该标志不授予权限，也不开启尚未实现的方法。

```jsonl
{ "id": 1, "method": "initialize", "params": { "clientInfo": { "name": "chrome-side-panel", "version": "1.0.0" }, "capabilities": { "experimentalApi": true } } }
{ "method": "initialized" }
{ "id": 2, "method": "model/list", "params": {} }
{ "id": 3, "method": "thread/resume", "params": { "threadId": "<id>", "excludeTurns": true, "chrome": { "includeDisplay": true } } }
{ "id": 4, "method": "turn/start", "params": { "threadId": "<id>", "model": "<model-id>", "input": [{ "type": "text", "text": "Hello" }] } }
```

| 方法                                     | Chrome 范围与行为                                                                      |
| ---------------------------------------- | -------------------------------------------------------------------------------------- |
| `model/list`                             | 当前真实模型目录，使用公共模型字段与 cursor／limit；不把过时的 UI 选择冒充可用模型     |
| `thread/list`                            | 公共分页、排序及已支持筛选，只列浏览器来源会话；wire source 为 `appServer`             |
| `thread/start`                           | 公共创建结果；支持已校验模型及目录。浏览器目录由宿主管理，不能通过请求任意切换         |
| `thread/read`                            | 默认读取元数据，不隐式订阅；`includeTurns: true` 读取经身份校验的原生历史              |
| `thread/resume`                          | 显式绑定观察，默认包含标准历史；`excludeTurns: true` 跳过标准正文                      |
| `thread/loaded/list`                     | 浏览器 hub 的实际订阅及仍在准入／运行观察中的线程，按线程去重，使用公共分页形状        |
| `thread/name/set`                        | 真实持久化标题，响应后发送标准改名通知                                                 |
| `thread/turns/list`／`thread/items/list` | 共用原生历史投影、视图选择、字节上限和绑定快照的游标                                   |
| `thread/unsubscribe`                     | 撤回本连接观察，不取消已接纳工作                                                       |
| `turn/start`                             | 标准文本／data URL 图片 `input`、`threadId` 和逐轮 `model`；允许纯图片，响应仅表示准入 |
| `turn/interrupt`                         | 两个 ID 必须对应可控制的精确运行；返回 `{}`，ACK 不证明结算                            |

沙盒、reasoning、service tier、output schema 等未适配覆盖项明确拒绝，不静默忽略。
读取、发送、停止、图片和网页关联始终复核浏览器来源，不开放桌面或 CLI 来源会话。

基础历史不再把按用户消息分组的展示记录标成 completed。
状态只采用该 binding 能核实的精确原生整轮证据；旧计时行缺少此证据时保留
`EXECUTION_UNKNOWN:`。未知结果不解除原有占用或授权重发。
不能忠实转换的可见原生类型仍明确报错；完整富展示通过下面的独立数据表达。

## 浏览器输入与富展示

标准方法中的额外输入放在 `params.chrome`，不覆盖标准字段：

```json
{
  "id": 5,
  "method": "turn/start",
  "params": {
    "threadId": "<id>",
    "model": "<model-id>",
    "input": [{ "type": "text", "text": "Read this page" }],
    "chrome": {
      "clientTurnId": "<uuid>",
      "permissionMode": "ask",
      "attachments": [],
      "pageContext": { "title": "Page", "url": "https://intranet.example/" }
    }
  }
}
```

`clientTurnId` 保留侧栏未知发送的精确身份，不是通用入口的自动重试令牌。
权限值仍由宿主原有策略校验；页面与附件是受限输入，不授予系统操作权限。
通用原生客户端入口不支持此 chrome 输入包，会明确拒绝。

图片使用标准 `input: [{type:'image',url:'data:image/png;base64,...'}]`，
文档附件仍使用 `chrome.attachments`，图片和文档合计最多 5 个／4 MiB。
可只发图片，或用空 input 加真实文档附件发送，不生成占位文字。文本另限 32,000 个 UTF-16 code units，按 JavaScript 字符串长度计数。
浏览器不开放 localImage 或任意 HTTP 图片下载；本机调用者的受限能力见通用接口。
标准输入类型、图片格式与校验、归一化及历史引用以
[宿主接入要求](../protocol-contract.md)为准。
图片还须通过当前真实模型目录的视觉能力校验；未知或仅文本的模型会在发送前明确拒绝，
异步准备期间模型发生变化也不能沿用旧视觉许可。侧栏不会为此自动切换模型或重新发送。

读取／恢复时，`chrome.includeDisplay: true` 单独选择富视图；
`chrome.turnId` 可查询侧栏已知的精确发送身份。响应附加：

```ts
thread.chrome = {
  display?: { id: string; turns: { id: string; items: ChromeDisplayItem[] }[] };
  activeTurn?: { id: string; nativeRunId?: string; status: string; executionSettled: boolean } | null;
};
```

`display` 是 UI 分组，不是标准 Turn，不包含合成执行结果。
它保留 `rawMessage`、`pendingInput`、`questionResult`、阶段、组件及压缩展示信息。
侧栏明确选择 `excludeTurns: true, chrome.includeDisplay: true`，避免为同一正文再加载一份
不供富 UI 使用的标准历史。标准客户端可只使用 Thread／Turn／Item，忽略 chrome 字段。

## 浏览器方法与通知

| 显式附加接口              | 用途                                                      |
| ------------------------- | --------------------------------------------------------- |
| `chrome/composer/options` | 当前会话模型选择与权限模式；模型目录使用标准 `model/list` |
| `chrome/thread/image`     | 读取原生授权媒体或历史明确引用的图片，保留目录与来源验证  |
| `chrome/extension/pair`   | 已鉴权的浏览器自动化配对，不创建聊天会话                  |
| `chrome/webLaunch/*`      | 已有网页关联操作，继续保留文档／草稿／单次发送身份边界    |
| `chrome/thread/stream`    | 按来源、原生身份和连接代次准入的原生 Agent／Chat 增强事件 |
| `chrome/thread/updated`   | `{threadId, display, activeTurn?}` 富视图及运行状态校准   |

旧的 `composer/options`、`thread/image`、`thread/stream`、`thread/updated` 不再是当前协议名称，
不保留按客户端名字切换的隐式兼容分支。

标准 `thread/started`、`thread/name/updated`、`thread/status/changed`、`thread/closed`、`turn/started`、
`item/started`、`item/completed`、正文／reasoning delta 与 `turn/completed` 使用公共载体。
标准 Item 只接收 Main 精确关联的原生进度，缺少身份的原始包不能补造核心 Item。
原生稀疏工具补页不回退正文水位；终态仍只由精确整轮结算建立。

每个连接最多加载 32 个线程；hub 最多保留 256 个精确 thread/turn 准入或观察槽，
需要新增槽的发送、恢复和停止在超限时明确返回 `-32602`，不静默丢掉完成通知。
同线程前一轮仍在校准历史时，新轮次使用独立观察身份，旧轮次可以正常发送完成通知，
但不能用它的 idle 覆盖新的执行。标准线程状态是当前运行观察，不代表执行结算。
发送响应仍在等待时，增强流、核对和停止照常；标准 Turn／Item 的收尾等待该次发送响应准入，
不能因为另一个观察者先恢复就把 completed 发在 started 之前。
最后一个观察者退订且全局没有待准入或运行观察时，只向实际退订连接发送
`notLoaded` 状态及 `thread/closed`；其他观察者和后台运行不受影响。
如果退订时仍有后台工作，稍后观测结束不向旧观察者补发 closed；不保存旧观察者名单。

富侧栏的正文继续由原生增强 reducer／富快照合并，标准 Item 不再被第二次追加。
该 reducer 保留组件、待处理输入、压缩、正文撤回和阅读位置规则；增强信息不是另一份持久正文权威。

## 错误、审批与生命周期

基础错误与通用入口相同：非法请求／未初始化 `-32600`，未实现方法 `-32601`，
明确参数错误 `-32602`，其他业务失败 `-32000`，非法 JSON `-32700`。
`turn/start.error.data.requestSent` 仅在宿主提供明确 boolean 时返回；无值仍表示发送可能未知。
网页关联的业务错误数据仍按其专属契约处理。

实际发起该轮次的侧栏连接通过 Main 的 trusted hooks 取得本轮审批展示权，观察者不取得审批权。
Main 在发送前先保存精确原生会话绑定；审批可能早于发送 ACK，先暂扣，只有原生 ACK 明确确认
actual run 后才展示匹配的审批，不能根据待审批请求的 runId 反向认领执行。
命令审批通过标准 `item/commandExecution/requestApproval` 展示命令、目录、原因，
可仅本次允许、拒绝或取消执行。成功协商 `experimentalApi` 且服务端在 `availableDecisions`
明确提供 `acceptForSession` 时，还可允许当前连接中同会话的相同命令；
该选择每次仍使用原生 allow-once，不是永久命令规则。
实验插件确认同样要求该实验标志，使用 `item/tool/requestUserInput`；只有原生 bundle-mcp 明确提供持久 App action 时
才出现“始终允许此 App”，回传原生真实持久选择，不与命令会话授权混用。

侧栏不默认选择首项；问答按真实选项提交，密码输入不进入草稿或日志。
`serverRequest/resolved`、超时、切换会话、停止及断线撤回对应交互；旧按钮／旧 socket 不能迟到授权。
显式 Cancel 先拒绝审批再请求精确停止；普通拒绝、关闭、退订不自动停止原生执行。
未安装交互 handler 时仍默认拒绝；未知服务端方法返回 method-not-found。
原生独立文件变更审批仍未实现；结构化问答使用下面的独立能力，不能用普通插件确认伪造。

## 工作目录与结构化问答

以下能力仅注册到 Chrome binding，不为通用 app-server 或网页 SDK 开放。

| 方法／通知 | 参数与结果 |
| --- | --- |
| `chrome/composer/options` | 额外返回 `cwd`、`recentCwds`（默认与 Chrome 会话近期目录，最多八项） |
| `chrome/workspace/select` | `{draftId}` 或 `{threadId,expectedCwd}`，可选 `recentCwd` 必须属于服务端近期列表；省略则打开 Main 系统选择器。返回 `{cancelled:true}` 或 `{cwd,selectionToken}` |
| `chrome/thread/workspace/set` | `{threadId,expectedCwd,selectionToken}`；返回 `{success:true,cwd}` 或 `{success:false,reason}`，原因与桌面目录修改合同一致 |
| `chrome/thread/workspace/changed` | `{threadId,cwd}`，目录保存后通知当前订阅者刷新元数据 |
| `chrome/questions/list` | `{threadId}` → `{questions:[{requestId,questions,waitPolicy,expiresAt?,createdAt?}]}` |
| `chrome/questions/respond` | `{threadId,requestId,behavior:'submit',answers}` 或 `{threadId,requestId,behavior:'cancel'}` → `{}` |
| `chrome/questions/changed` | `{threadId}`，只作快照失效信号，重新 list 后才能恢复交互 |

新会话选目录后，`thread/start` 携带 `cwd` 以及
`chrome:{draftId,workspaceSelectionToken}`；凭据绑定本连接与草稿，短期、单次使用。
省略选择沿用全局默认目录；无凭据的 cwd 只能与默认目录一致。
已有会话的选择和保存要求当前显式订阅，凭据另绑定 subscription 与 expectedCwd。
目录取消无副作用，保存复用桌面的空闲、后代、未知准备、计划和身份比较检查。

问答要求显式订阅并核实普通 Chrome 会话来源、原生 key／物理 SID／revision、
run／toolCall 来源和当前 Gateway 代次；插件托管和子执行请求不透传。
题目和答案保留原生稳定 ID、multiSelect、optionInputs、other、skipped 以及等待策略。
此接口复用桌面统一回答锁，允许已验证的多视图回答，不转移命令审批 owner。
断线、切会话和关闭只撤界面；提交结果未知时核对原生 pending，不重放答案。

Chrome 连接关闭只退订该观察者，已接纳的原生工作继续。通用原生客户端关闭仍取消自己拥有的工作。
停止 ACK、侧栏消失、idle、最终正文和历史分组均不能替代精确终态。
详细顺序和恢复围栏见[生命周期与错误](lifecycle-errors.md)。
