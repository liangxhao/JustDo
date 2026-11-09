# 第三方网页调用 Chrome 扩展

本文面向业务网站开发者：在页面绑定按钮，用户点击后打开扩展侧栏，准备草稿或经授权发送，并按需向原页面返回本轮最终文本。

网页入口是随扩展交付的 `window.chromeAssistant` SDK。扩展负责与桌面应用通信，业务网站不配置本机 WebSocket、Native Messaging、Gateway 地址或凭据。扩展维护者使用的协议另见[扩展内部接口](protocol/README.md)，产品行为和当前验证限制见[网页发起对话](website-launch.md)。

## 1. 接入前准备

1. 安装与桌面应用匹配的 Chrome 扩展，并启动桌面应用。网页调用不会自动启动桌面应用。
2. 取得发布方提供的同版 `chrome-assistant.js`，复制到业务站点自己的静态资源目录，例如 `/assets/chrome-assistant.js`，随业务站点部署和升级。
3. 用户首次点击业务按钮时，扩展自动识别当前网站，并在自己的侧栏显示实际来源（例如 `https://business.internal:8443`），由用户选择连接或拒绝。开发者和用户都不需要事先登记网址。
4. 用户点击“连接”时，Chrome 可能另行请求网站访问权限。成功后继续处理原按钮的内容，在侧栏准备待确认草稿，无需刷新页面或重新点击业务按钮。连接授权本身不允许自动发送或读取结果；用户仍需确认实际输入和分享。
5. 连接会被记住；用户可以在扩展设置中管理、撤销连接，并分别调整直接发送和结果分享权限。不同协议、主机或端口视为不同来源。

从兼容宿主的扩展发布产物取得已打包的单文件 `chrome-assistant.js`。源码入口依赖包内模块，不能直接作为网站独立脚本复制；SDK 不依赖公共 CDN，网站仍须允许自己的本地脚本。

首版支持 HTTP(S) 顶层页面中已连接的 light DOM `button[type="button"]`。HTTPS 优先；HTTP 内网网站也须由用户确认连接。不支持 iframe 或 Shadow DOM 内的按钮。

## 2. 最小可用示例

页面先加载 SDK，再执行自己的初始化脚本。按钮在登记成功前保持禁用；不要把 `bind()` 放进按钮的 click 回调中。

```html
<button id="ask-assistant" type="button" disabled>生成摘要</button>
<button id="withdraw" type="button" disabled>撤回请求或分享</button>
<p id="request-status" role="status"></p>
<pre id="request-result"></pre>

<script defer src="/assets/chrome-assistant.js"></script>
<script defer src="/assets/assistant-entry.js"></script>
```

`/assets/assistant-entry.js`：

```js
(async () => {
  const button = document.querySelector('#ask-assistant');
  const withdraw = document.querySelector('#withdraw');
  const status = document.querySelector('#request-status');
  const output = document.querySelector('#request-result');
  let currentRequest;
  let currentRevision = -1;

  function showReceipt(receipt) {
    if (!receipt || receipt.requestId !== currentRequest?.requestId) return;
    if (receipt.receiptRevision < currentRevision) return;
    currentRevision = receipt.receiptRevision;
    status.textContent = `请求：${receipt.request.status}；执行：${receipt.execution.status}；结果：${receipt.output.status}`;
    if (receipt.output.status === 'withheld') {
      status.textContent = '本轮结果未获分享许可，或分享已撤回。';
    }
    if (receipt.error?.code === 'TOO_LATE') {
      status.textContent = '消息可能已发送，分享已撤回；如需停止，请操作扩展侧栏。';
    }
    if (
      receipt.execution.executionSettled &&
      receipt.execution.status === 'completed' &&
      receipt.output.status === 'available'
    ) {
      output.textContent = receipt.output.text ?? '';
    }
  }

  try {
    const binding = await window.chromeAssistant.bind(
      button,
      {
        prompt: '请根据这份业务数据生成摘要。',
        context: { text: '订单数量：12；待办数量：3。' },
        mode: 'draft',
        result: 'final',
      },
      {
        onConnection(connection) {
          if (currentRequest) return;
          if (connection.status === 'pending' || connection.status === 'granting') {
            button.disabled = true;
            status.textContent = `请在扩展侧栏确认连接 ${connection.origin}。`;
          } else if (connection.status === 'rejected' || connection.status === 'expired') {
            status.textContent = '网站连接未完成，请检查扩展侧栏后重新操作。';
            button.disabled = false;
          }
        },
        onRequest(request) {
          button.disabled = true;
          currentRequest = request;
          currentRevision = -1;
          output.textContent = '';
          status.textContent = '正在打开侧栏并准备本次请求…';
          withdraw.disabled = false;
        },
        onStatus: showReceipt,
        onResult: showReceipt,
        onError(error) {
          status.textContent = `暂时无法确认请求状态（${error.code}），请检查扩展及桌面应用。`;
        },
      },
    );
    button.disabled = false;
    status.textContent = '已就绪，请点击“生成摘要”。';

    withdraw.addEventListener('click', async () => {
      const request = currentRequest;
      if (!request) return;
      try {
        const { receipt } = await request.cancel();
        if (request !== currentRequest) return;
        if (receipt) showReceipt(receipt);
        else status.textContent = '撤回请求已发出，等待状态确认。';
      } catch (error) {
        if (request !== currentRequest) return;
        status.textContent = `撤回状态尚未确认（${error.code}），请查看扩展侧栏。`;
      }
    });

    // 在组件卸载或业务入口移除时调用：await binding.unbind();
    // 保留 binding，供业务数据变化时串行调用 binding.update(完整参数)。
  } catch (error) {
    status.textContent = `未能准备按钮（${error.code ?? 'BRIDGE_UNAVAILABLE'}）。请检查扩展是否已启用及 SDK 是否匹配。`;
  }
})();
```

真实点击会由扩展监听；页面不需要在自己的 click 回调中另行调用发送。程序 `.click()`、自定义事件、定时器及页面加载本身均不能发起操作。异步业务数据应在点击前准备好，再更新绑定。

示例一次只处理一个操作：收到句柄即禁用启动按钮，避免下一次点击覆盖原句柄；不会在超时或异步错误后自动重新启用。业务组件确认上一操作已处理、保留了所需结果后，再明确开放下一次操作。需要同时管理多次操作时，应按 requestId 保存各自句柄与业务记录，不能只覆盖一个全局变量。

示例将状态枚举直接展示以便联调，正式业务界面应为示例文案、状态和公开错误码提供自己的 i18n 映射；扩展的 messageKey 不会自动成为业务站点的词典。结果只能作为文本或经过业务自身安全处理的数据使用，不要直接写入 `innerHTML`。

## 3. 参数与四种组合

`bind(button, options, callbacks)` 的 options：

| 字段      | 类型与默认值                        | 含义                                                                  |
| --------- | ----------------------------------- | --------------------------------------------------------------------- |
| `prompt`  | 必填、非空字符串                    | 本次待发送文字，最多 16,000 个字符；不接受以 `/` 开头的会话控制命令。 |
| `context` | 可选 `{ text: string }`             | 显式业务快照，最多 24,000 个字符；会在侧栏单独展示。                  |
| `mode`    | `'draft' \| 'send'`，默认 `'draft'` | 放入独立草稿，或请求直接发送。                                        |
| `result`  | `'none' \| 'final'`，默认 `'none'`  | 只接收最小状态，或请求分享本轮最终文本。                              |

不要追加 thread ID、request ID、模型、助手、工作目录、权限模式、附件或回调 URL。每次真实点击的请求身份由扩展生成。

| 组合            | 用户看到的行为                                                     |
| --------------- | ------------------------------------------------------------------ |
| `draft + none`  | 打开独立草稿，用户编辑并发送；网页只收到状态。                     |
| `draft + final` | 打开独立草稿，用户确认实际输入及分享后发送；只分享获准的本轮结果。 |
| `send + none`   | 已获直接发送授权时提交；未授权时在侧栏等待确认。                   |
| `send + final`  | 发送与结果分享分别获准后提交；需要任一许可时在侧栏等待确认。       |

参数表达网站的请求，不能代替用户授权。已有直接发送授权也不会让 `draft` 自动发送；`none` 不会因已有分享授权而返回正文。用户拒绝分享时仍可选择仅发送，页面通过状态得知结果被保留。

整条请求 UTF-8 上限为 128 KiB，结果文本上限为 256 KiB。上下文还受最终编码后 24,000 字符预算约束，说明、JSON 和特殊字符转义均占空间，因此原始 text 未达到上限时也可能收到 `CONTEXT_TOO_LARGE`。缩短输入后再登记，不依赖静默截断。

## 4. 绑定控制器与请求句柄

`await bind()` 返回绑定控制器 `{ update, unbind }`，表示当前按钮配置已准备好，不表示网站已授权、侧栏已打开、消息已发送或执行成功。尚未连接的网站也能完成绑定，首次真实点击进入连接确认。连接阶段通过可选的 `onConnection` 更新页面提示；只有进入任务准备后才通过 `onRequest(handle)` 获得独立请求句柄，此回调先于该请求的状态和结果回调。

| 对象       | 成员                              | 用法                                                                 |
| ---------- | --------------------------------- | -------------------------------------------------------------------- |
| 绑定控制器 | `update(options): Promise<void>`  | 用完整 options 替换未来点击使用的配置；不修改已发起的请求。          |
| 绑定控制器 | `unbind(): Promise<void>`         | 停止新点击及本绑定回调，关闭其句柄，并请求取消未发送操作或撤回分享。 |
| 请求句柄   | `requestId`、`bindingRevision`    | 本次操作的只读关联字段。                                             |
| 请求句柄   | `launchId`                        | 接纳后可用的不透明关联 ID；不能作为跨页面访问凭据。                  |
| 请求句柄   | `read(): Promise<{ receipt? }>`   | 查询原操作；准备仍在进行时可能暂缺 receipt。                         |
| 请求句柄   | `cancel(): Promise<{ receipt? }>` | 撤回原操作或结果分享；响应也可能暂缺 receipt。                       |

SDK 返回的 read/cancel 响应包含桥接字段，业务只读取其中的 `receipt`；不要把整个返回值当作回执，或依赖桥接内部字段：

```js
const { receipt } = await currentRequest.read();
if (receipt) showReceipt(receipt);
```

`update()` 需要串行等待，且每次传完整参数；省略 mode/result 会重新采用默认值。首次连接确认尚未结束时，更新返回 `REQUEST_CONFLICT`，保留原点击的冻结内容；可先解绑取消，或等确认结束后再更新未来点击。例如业务记录变化后，在没有在途请求时更新：

```js
button.disabled = true;
try {
  await binding.update({
    prompt: '请汇总当前记录。',
    context: { text: preparedSnapshot },
    mode: 'draft',
    result: 'final',
  });
  button.disabled = false;
} catch {
  // 保持按钮禁用，提示重新登记或刷新；失败不保证恢复旧配置。
}
```

上例中的 binding、button 和 preparedSnapshot 由业务组件持有。不要在用户已经点击后才等待 fetch/update 并重放这次点击。按钮被替换成相同 id 的新元素时，应解绑旧元素并重新 bind。

## 5. 回调与回执

业务可见回执示意；状态字段允许向后增加，调用方应忽略未知字段：

```js
{
  requestId: 'opaque-request-id',
  launchId: 'opaque-launch-id',
  receiptRevision: 7,
  request: { status: 'submitted' },
  execution: { status: 'completed', executionSettled: true },
  output: { status: 'available', text: '本轮最终文本', format: 'text' },
  delivery: { status: 'connected' },
  // error: { code: 'PUBLIC_CODE', messageKey: 'safe-message-key' }
}
```

| 回调                | 何时使用                                                                               |
| ------------------- | -------------------------------------------------------------------------------------- |
| `onConnection(state)` | 首次连接阶段；包含 status、浏览器核验的 origin 和可选公开 code，不是执行回执。       |
| `onRequest(handle)` | 保存本次真实点击的句柄，关联业务记录。                                                 |
| `onStatus(receipt)` | 更新请求、执行、结果及投递状态，同时检查可选的 receipt.error。                         |
| `onResult(receipt)` | 执行已结算，且输出为 available / empty / unsupported / unavailable；参数仍是整份回执。 |
| `onError(error)`    | 处理点击或后续观察产生的异步桥接错误，根据公开 error.code 展示提示。                   |

连接状态为 `pending / granting / connected / rejected / expired`。`connected` 只表示网站已连接，不能当作任务已接纳、已发送或执行成功；取得任务句柄后，以回执为准，不要用迟到的连接提示覆盖任务状态。

bind/update/unbind/read/cancel 的 Promise 拒绝仍须在调用处 catch，不能仅依赖 `onError`。回执内的 `error` 也不保证触发 `onError`。`onResult` 不等于执行成功：仅在 `execution.status === 'completed'`、`executionSettled === true` 且 `output.status === 'available'` 时使用 text。

`onError` 是绑定级提示，不能单凭它将某个业务请求判为执行失败。各请求以回执中的 requestId 关联，read/cancel 的直接响应也需按 receiptRevision 防止覆盖已收到的新状态。

| 状态层    | 常见值与处理                                                                                                                                                          |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| request   | drafted / awaiting-confirmation 等待用户；submitting / submitted 表示提交阶段；cancelled / expired / rejected 表示请求已关闭。                                        |
| execution | not-started / running / unknown / completed / failed / interrupted；只有 executionSettled 为 true 才能把执行视为已结算。unknown 不代表失败。                          |
| output    | not-requested 不分享；awaiting-consent 等待许可；pending 等待可靠结果；available 可读取 text；unsupported / unavailable 没有可用文本；withheld 表示未获准或撤回分享。 |
| delivery  | connected / revoked；投递关闭不表示执行已停止。                                                                                                                       |

SDK 识别 `empty`，但当前没有普遍可验证的成功空结果保证；不能把缺少文本、silent 或 unavailable 当作成功空值。`withheld`、`pending` 等只通过 `onStatus` 通知，不要创建一个只等 `onResult` 才结束的页面等待流程。

一次点击只关联该输入的首轮结果，不包括后续追问、其他会话、Thinking、工具输出或媒体文件。执行完成时 output 仍可能 pending/unavailable；自然语言答复也不能替代网站自己的业务校验。回调可能重复，按 requestId/launchId 和 receiptRevision 处理，业务写回另做幂等，不保证网页副作用恰好一次。

SDK 的请求句柄是有界内存状态，不是永久查询目录。每个绑定最多保留 100 个句柄；
到达上限后可回收已终态的旧句柄，旧句柄随后 `read()`／`cancel()` 会以 `EXPIRED` 拒绝。
内容桥在登记准入时检查页面已登记的绑定数，阈值为 64；多个按钮应串行 `await bind()`，
该检查不提供跨异步登记的原子并发配额保证。内容桥另有页面总共 100 个请求记录的上限，不能按绑定数量累加。
达到绑定登记检查阈值时 `bind()` 以 `INVALID_REQUEST` 拒绝，请求记录没有可回收项时则报告容量错误。
没有可回收项时通过 `onError` 报 `CAPACITY_EXCEEDED`。页面应限制在途操作、保留业务所需的已授权结果，
并在入口移除时解除绑定；容量错误不能证明这次点击未被接纳，不能因此自动重放。

## 6. 撤回、超时与页面生命周期

尚未发送时，cancel 请求撤销输入。越过发送边界后，cancel 会撤回分享，执行继续；常见响应是正常返回的 receipt，其中 `error.code === 'TOO_LATE'`，不一定抛出异常。需要停止执行时，由用户操作可信侧栏的停止按钮，网页句柄没有 interrupt/stop 方法。

unbind 会先关闭本地回调和句柄，再向扩展请求撤回；其 Promise 完成不证明后端所有撤回已经确认。已经释放到传输层或已经交给网页的数据无法追回。

SDK 桥接调用的等待上限为 5 秒。超时、断线或没有收到回执均不能证明未发送；保留原句柄，只读查询或让用户查看侧栏，不能自动新建请求重发同一业务动作。草稿和确认也有绝对有效期，重新编辑、连接或打开侧栏不会一直延长。

刷新、整页导航、关闭、pagehide 及 BFCache 冻结会终止旧分享，旧绑定/句柄不能跨页面保存恢复。SPA 软导航会使旧请求句柄失效，保留的按钮绑定仍须由业务更新为新记录快照；DOM 元素被替换时重新绑定。撤销站点权限或主动解除关联也终止旧分享，不能仅凭相同 origin/tab/launchId 恢复。

## 7. 常见问题与处理

| 现象或公开码                                                                            | 建议处理                                                                                                                  |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| BRIDGE_UNAVAILABLE                                                                      | 检查扩展是否已安装/启用、SDK 是否匹配，以及按钮是否在 HTTP(S) 顶层 light DOM；不要自动重放点击。                           |
| SITE_NOT_ALLOWED / PERMISSION_REQUIRED                                                  | 在扩展侧栏确认实际网站和 Chrome 访问授权；已撤权的旧请求不能恢复。                                                       |
| PANEL_OPEN_FAILED                                                                      | 浏览器未允许本次打开侧栏；用户可点击扩展图标检查状态，再主动发起新操作，不自动弹新标签或重试。                             |
| APP_NOT_RUNNING / NATIVE_HOST_UNAVAILABLE / CONNECTION_UNAVAILABLE / NATIVE_UNAVAILABLE | 检查桌面应用与扩展连接，再由用户确认下一步；已有句柄只读核对。                                                            |
| COMPOSER_BUSY / WINDOW_BUSY                                                             | 先保留或处理侧栏现有草稿/网页请求，不覆盖、夹带附件或自动排队发送。                                                       |
| CONFIRMATION_REQUIRED / RESULT_CONSENT_REQUIRED                                         | 引导用户在侧栏确认发送和分享；网页不能自行提升权限。                                                                      |
| CONTEXT_TOO_LARGE / REQUEST_TOO_LARGE / INVALID_REQUEST / UNSUPPORTED_INPUT             | 在下一次操作前缩短并修正完整参数，普通文本入口不支持斜杠命令或附件。                                                      |
| EXPIRED / LEASE_REVOKED                                                                 | 旧操作不能恢复为新授权；查看侧栏，按当前页面重新登记并由用户发起新操作。                                                  |
| CAPACITY_EXCEEDED                                                                       | 暂停新点击并检查在途请求及侧栏状态，释放已不再需要的绑定；不要自动重放这次操作。                                          |
| UNKNOWN_EXECUTION / REQUEST_TIMEOUT                                                     | 展示“结果未知”，使用原句柄查询；不得自动重发。                                                                            |
| TOO_LATE                                                                                | 请求可能已发出，分享已撤回；需要停止时让用户操作侧栏。                                                                    |

错误码和回执中的安全键用于业务映射，不能将其理解为成功与失败的唯一判据。未识别的码显示通用提示，不展示底层连接地址、堆栈或凭据。

## 8. 接入验收

- 用真实点击验证四种 mode/result 组合，以及首次未授权、允许直接发送、拒绝分享仍仅发送。
- 侧栏已有文字、附件时保留原草稿；每次网页操作使用独立对话。
- 验证更新记录、替换按钮、取消、页面刷新/跳转、撤权和应用未启动的提示。
- 已发送后断线/超时只查询，不重发；确认 unknown 不被显示为成功或失败。
- 对 available、pending、withheld、unavailable 分别处理，安全展示文本，业务写回可以幂等。

上述是接入方在目标 Chrome、发布产物及内网站点执行的验收项，不代表该业务系统已经通过完整实测。仓库已有验证的范围和剩余限制统一维护在[网页发起对话](website-launch.md#验证范围与限制)。
