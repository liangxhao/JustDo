# 第三方网页调用 Chrome 扩展

把 `chrome-assistant.js` 放到业务网站，再用 `window.chromeAssistant.bind()` 绑定一个按钮。扩展默认根据按钮的配置准备草稿或直接发送，并将本轮最终答复返回原网页。

## 1. 获取网页 SDK

从你要在 Chrome 中使用的那份扩展里取 `chrome-assistant.js`。文件与 `manifest.json` 在同一级目录。

| 你手上的版本     | 到哪里复制                                                                                                                                                                                                         |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 已安装的桌面应用 | 在桌面应用打开 **设置 → 浏览器 → Chrome 扩展 → 打开扩展文件夹**，再进入里面的 `chrome-extension` 子目录。Windows 安装版的文件路径为 `<安装目录>/resources/chrome-extension/chrome-extension/chrome-assistant.js`。 |
| 本地源码         | 在仓库根目录运行 `npm run chrome-extension:prepare`，从 `build/chrome-extension/chrome-extension/chrome-assistant.js` 复制组装好的文件。                                                                           |

将组装好的文件复制到网站的静态资源目录，例如 `/assets/chrome-assistant.js`，随网站发布。源码中的同名入口还依赖其他模块。升级扩展时一起更新这份 SDK。

## 2. 最小可用示例

### 先在本机试一遍

从仓库根目录运行下面两条命令。

```bash
npm run chrome-extension:prepare
node docs/plugins/chrome-extensions/chrome-assistant/examples/website-sdk/serve.cjs
```

在 Chrome 加载本次组装的 `build/chrome-extension/chrome-extension/` 目录，启动与这份扩展匹配的桌面应用，再用 Chrome 打开[本地示例](http://127.0.0.1:4178)。Chrome 的开发者模式与加载步骤见[扩展概览](overview.md#安装或更新扩展)。

在扩展设置的 **Website message sending mode** 保留 **Follow website (default)**，按下面的顺序验证连续发起任务。

1. 点击 **A · 打开草稿**（`draft + final`）。首次使用时在侧栏允许连接，再发送草稿。
2. A 发送后保持侧栏打开，连续点击两次 **B · 自动发送**（`send + final`）。每次点击都会获得新的任务编号，侧栏依次切到对应的新对话。A 仍在执行时也可以发起 B。
3. 等各笔请求在原网页显示自己的结果。可以在运行期间关闭侧栏，再用 Chrome 工具栏中的扩展图标打开查看。整个过程无需刷新网页。

示例服务从组装目录读取 SDK。要把示例搬到自己的网站，把 `index.html`、`demo.js` 和组装后的 `chrome-assistant.js` 放在同一目录。[示例页面](examples/website-sdk/index.html) · [绑定与回调代码](examples/website-sdk/demo.js)

### 在自己的网站绑定按钮

在 HTTP 或 HTTPS 顶层网页放一个普通的 `button[type="button"]`。页面先加载 SDK，再运行初始化脚本。

```html
<button id="ask-assistant" type="button" disabled>生成摘要</button>
<p id="assistant-status" role="status"></p>
<pre id="assistant-result"></pre>
<script defer src="/assets/chrome-assistant.js"></script>
<script defer src="/assets/assistant-entry.js"></script>
```

把下面的代码保存为 `assistant-entry.js`，和 SDK 放在同一个静态资源目录。网页应能通过 `/assets/assistant-entry.js` 加载该脚本。

```js
async function bindAssistant() {
  const button = document.querySelector('#ask-assistant');
  const status = document.querySelector('#assistant-status');
  const output = document.querySelector('#assistant-result');

  try {
    await window.chromeAssistant.bind(
      button,
      {
        prompt: '用一句话总结这条订单记录。',
        context: { text: '订单 12 个，其中 3 个待处理。' },
        mode: 'draft',
      },
      {
        onRequest() {
          output.textContent = '';
        },
        onConnection(state) {
          status.textContent = state.message ?? '';
        },
        onQueue(state) {
          status.textContent = state.message;
        },
        onActionRequired(action) {
          status.textContent = action.message;
        },
        onResult(receipt) {
          if (
            receipt.execution.executionSettled &&
            receipt.execution.status === 'completed' &&
            receipt.output.status === 'available'
          ) {
            output.textContent = [
              receipt.output.text,
              ...(receipt.output.artifacts ?? []).map(artifact => artifact.name),
            ]
              .filter(Boolean)
              .join('\n');
          }
        },
      },
    );
    button.disabled = false;
  } catch {
    status.textContent = '请在 Chrome 工具栏打开扩展侧栏，检查扩展与网页 SDK 是否配套。';
  }
}

void bindAssistant();
```

在页面初始化时准备输入并完成绑定，成功后再启用按钮。扩展监听用户的真实点击。用 `.click()`、自定义事件或定时器触发的操作不会发起对话。iframe 和 Shadow DOM 内的按钮不在支持范围内。

## 3. 用户点击后会看到什么

1. 用户在业务网页点击 **生成摘要** 等按钮。首次使用时，Chrome 在发起请求的标签页打开侧栏，弹出 **允许此网站连接？**，下方列出网站地址。处理弹窗前，侧栏输入区暂停操作。
2. 用户核对网站地址和授权范围后，点击 **允许连接**。此授权涵盖后续请求的直接发送和结果回传。如果 Chrome 随后询问是否允许扩展访问该网站，按提示确认。
3. 授权完成后，刚才那次点击的消息进入侧栏输入框，默认使用「完全访问」。用户可以核对或编辑草稿，也可以在发送前切换权限模式。
4. 点击输入区右侧的发送按钮。需要回传时，扩展会向发起请求的网站返回本轮结果。

触发授权的这条消息始终需要用户确认发送。后续请求默认按 [`mode` 和 `result` 的组合](#4-参数与四种组合)处理。用户可在侧栏点击 **连接设置**，为所有已连接网站选择[网页消息发送方式](website-launch.md#后续使用与撤销)，也可在 **Connected websites** 中查看或撤销单个网站的连接。站点授权按协议、主机和端口生效。

升级前已同时授权直接发送和结果回传的网站可继续使用。只有部分授权的网站，下次使用时需要在侧栏确认一次新的范围。若旧绑定的第一次点击只显示连接提示，请再点击一次。仍无法打开连接卡时，刷新页面后再点。

## 4. 参数与四种组合

在 `bind(button, options, callbacks)` 的 `options` 中填写消息和发送方式。

| 字段      | 类型与默认值                        | 含义                                                                  |
| --------- | ----------------------------------- | --------------------------------------------------------------------- |
| `prompt`  | 必填、非空字符串                    | 本次待发送文字，最多 16,000 个字符；不接受以 `/` 开头的会话控制命令。 |
| `context` | 可选 `{ text: string }`             | 显式业务快照，最多 24,000 个字符；会在侧栏单独展示。                  |
| `mode`    | `'draft' \| 'send'`，默认 `'draft'` | 放入独立草稿，或请求直接发送。                                        |
| `result`  | `'none' \| 'final'`，默认 `'final'` | 回传本轮最终结果。显式传入 `none` 时只接收状态。                      |

每次点击的请求 ID 由扩展分配。网页可提供消息和文本上下文，不能指定已有会话、模型、助手、工作目录、权限模式、附件或回调 URL。

以下是网站连接后，发送方式为 **Follow website (default)** 时的行为。触发首次授权的请求始终进入待确认草稿。

| 组合            | 用户看到的行为                                           |
| --------------- | -------------------------------------------------------- |
| `draft + none`  | 打开独立草稿，用户编辑并发送；网页只收到状态。           |
| `draft + final` | 打开独立草稿。用户点击发送，执行完成后回传本轮最终结果。 |
| `send + none`   | 准入检查通过后自动发送，网页只收到状态。                 |
| `send + final`  | 准入检查通过后自动发送，执行完成后回传本轮最终结果。     |

用户选择 **Send directly** 或 **Open as draft** 时，该设置优先于网页的 `mode`，适用于所有已连接网站的新请求。回传仍按网页的 `result` 处理。省略 `result` 时回传最终结果，显式传 `none` 时只返回状态。

整条请求最多 128 KiB UTF-8，最终文本最多 256 KiB UTF-8。上下文在加入说明、JSON 和特殊字符转义后仍须在 24,000 字符内。收到 `CONTEXT_TOO_LARGE` 时，请缩短文本再绑定或更新。

## 5. 更新按钮与查询请求

`await bind()` 成功表示按钮可以使用，网站授权在用户首次点击后进行。返回的绑定对象管理按钮的配置。用户点击并进入任务准备后，`onRequest(handle)` 交付该次请求的句柄，用于查询或撤回。

| 对象       | 成员                              | 用法                                                                 |
| ---------- | --------------------------------- | -------------------------------------------------------------------- |
| 绑定控制器 | `update(options): Promise<void>`  | 用完整 options 替换未来点击使用的配置；不修改已发起的请求。          |
| 绑定控制器 | `unbind(): Promise<void>`         | 停止新点击及本绑定回调，关闭其句柄，并请求取消未发送操作或撤回分享。 |
| 请求句柄   | `requestId`、`bindingRevision`    | 本次操作的只读关联字段。                                             |
| 请求句柄   | `launchId`                        | 接纳后可用的不透明关联 ID；不能作为跨页面访问凭据。                  |
| 请求句柄   | `read(): Promise<{ receipt?, queueStatus?, actionRequired? }>`   | 查询原操作，排队时返回 `queueStatus: 'queued'`。 |
| 请求句柄   | `cancel(): Promise<{ receipt?, queueStatus?, actionRequired? }>` | 撤回等待中的请求、尚未发出的输入或结果分享。 |

`read()` 和 `cancel()` 返回 `queueStatus` 时，可按 `onQueue` 的方式显示 `queued` 或 `cancelled`。返回正式 `receipt` 后，交给处理 `onStatus` 的同一个函数。提供 `onActionRequired` 的接入会在需要操作时收到 `{ actionRequired: { code, message, requestId } }`。原有接入可继续捕获这两项操作的 Promise 拒绝并显示本地化提示。

业务记录变化时，在用户下一次点击前调用 `update()`。逐次 `await`，每次传完整参数。省略 `mode` 或 `result` 会恢复该字段的默认值。首次连接等待确认时，原点击的内容已经固定，此时更新会返回 `REQUEST_CONFLICT`。等确认结束，或解绑撤回后再更新入口。

下面的 `binding` 来自 `bind()`，`preparedSnapshot` 是业务代码提前准备好的文本。

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
  // 保持按钮禁用，并提示用户重新绑定。
}
```

按钮元素被替换时，即使新元素的 `id` 相同，也要解除旧绑定，再绑定新元素。

## 6. 回调与回执

`onConnection` 可用来提示用户到侧栏授权。任务准备开始后，SDK 先调用 `onRequest`，再传回该请求的状态与结果。根据 `requestId` 关联回执，用 `receiptRevision` 忽略比当前显示更旧的回执。

每次真实点击都会得到新句柄，包括连续点击同一个按钮。若侧栏正在等待手动发送同一网页发起的草稿，新请求可以替换它，原请求通过 `onStatus` 收到 `request.status: 'cancelled'`。侧栏有普通草稿或正在确认发送时，后续点击按顺序等待。上一笔消息确认发送后，侧栏可切到下一笔新对话，已发送的请求继续独立执行。排队请求有自己的 requestId，在获准创建对话时才获得 launchId。

下面的回执同时包含最终文本和一个 Excel 交付件。

```js
{
  requestId: 'opaque-request-id',
  launchId: 'opaque-launch-id',
  receiptRevision: 7,
  request: { status: 'submitted' },
  execution: { status: 'completed', executionSettled: true },
  output: {
    status: 'available',
    text: '已生成报表。',
    format: 'text',
    artifacts: [
      {
        name: 'report.xlsx',
        kind: 'document',
        mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      },
    ],
  },
  delivery: { status: 'connected' },
  // error: { code: 'PUBLIC_CODE', messageKey: 'safe-message-key' }
}
```

| 回调                  | 何时使用                                                                               |
| --------------------- | -------------------------------------------------------------------------------------- |
| `onConnection(state)` | 首次连接的进度。包含 `status`、浏览器核验的 `origin`、操作提示 `message` 和可选 `code`。 |
| `onRequest(handle)`   | 保存本次真实点击的句柄，关联业务记录。                                                 |
| `onQueue(state)`      | 根据 `requestId` 更新等待状态。`reason` 为 `composer` 时提示处理当前输入，为 `panel` 时提示手动打开侧栏。 |
| `onStatus(receipt)`   | 更新请求、执行、结果及投递状态，同时检查可选的 receipt.error。                         |
| `onResult(receipt)`   | 执行已结算，且输出为 available / empty / unsupported / unavailable；参数仍是整份回执。 |
| `onActionRequired({ code, message, requestId? })` | 用 `message` 显示下一步，用 `code` 做业务判断。有对应请求时按 `requestId` 更新。 |

连接状态为 `waiting-for-window`、`waiting-for-connection`、`pending`、`granting`、`connected`、`rejected`、`expired`。`waiting-for-window` 表示先处理同窗口的输入或队列。收到 `waiting-for-connection` 时，用户应回到先前申请连接的标签页处理，然后再点击。`connected` 表示网站已连接。任务的发送与执行进度以对应请求的回执为准。

`bind`、`update`、`unbind`、`read` 和 `cancel` 的 Promise 拒绝在调用处捕获。回执内的 `error` 也要单独处理。收到 `onResult` 后，只有 `execution.status === 'completed'`、`executionSettled === true` 且 `output.status === 'available'` 时才读取 `output.text` 和 `output.artifacts`。用 `textContent` 显示结果。

`output.artifacts` 为可选数组，最多包含 32 项。每项包含文件名 `name`、类别 `kind`（`image`、`audio`、`video` 或 `document`）和可选的 `mimeType`。数组只提供文件描述。本地路径、下载地址和文件内容均不会作为交付件字段提供。仅有交付件时，`output.text` 和 `output.format` 可以省略。

新版 SDK 优先调用 `onActionRequired`。现有接入只提供 `onError` 时，仍可收到本地化操作提示。执行结果以对应请求的回执为准。处理 `read` 或 `cancel` 的回执时按 `receiptRevision` 防止覆盖较新的状态。

| 状态层    | 常见值与处理                                                                                                                                                                 |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| request   | drafted / awaiting-confirmation 等待用户；submitting / submitted 表示提交阶段；cancelled / expired / rejected 表示请求已关闭。                                               |
| execution | not-started / running / unknown / completed / failed / interrupted；只有 executionSettled 为 true 才能把执行视为已结算。unknown 不代表失败。                                 |
| output    | not-requested 不分享；awaiting-consent 等待许可；pending 等待可靠结果；available 可读取文本或交付件；unsupported / unavailable 没有可用结果；withheld 表示未获准或撤回分享。 |
| delivery  | connected / revoked；投递关闭不表示执行已停止。                                                                                                                              |

SDK 识别 `empty`，但当前没有普遍可验证的成功空结果保证；不能把缺少文本、silent 或 unavailable 当作成功空值。`withheld`、`pending` 等只通过 `onStatus` 通知，不要创建一个只等 `onResult` 才结束的页面等待流程。

一次点击只关联该输入的首轮结果，不包括后续追问、其他会话、Thinking、工具输出或文件内容。执行完成时 output 仍可能 pending/unavailable；自然语言答复也不能替代网站自己的业务校验。回调可能重复，按 requestId/launchId 和 receiptRevision 处理，业务写回另做幂等，不保证网页副作用恰好一次。

### 页面容量

- **按钮绑定**的检查阈值为 64。多个按钮要逐次 `await bind()`，因为异步登记不保证原子配额。达到 SDK 阈值可收到 `CAPACITY_EXCEEDED`，达到内容桥登记阈值可收到 `INVALID_REQUEST`。
- **请求句柄**每个绑定最多保留 100 个，内容桥另有全页 100 条请求记录的上限。达到上限时可回收已结束的记录。被回收句柄的 `read()` 或 `cancel()` 会以 `EXPIRED` 拒绝。
- **没有可回收记录时**，`onActionRequired` 会收到 `CAPACITY_EXCEEDED`。等一笔完成或取消一笔排队请求，再点击按钮。

## 7. 撤回、超时与页面生命周期

- **撤回输入或分享**用 `cancel()`。越过发送边界后，调用只撤回分享，任务仍可继续。`TOO_LATE` 也可能作为正常回执的 `error.code` 返回。要停止执行，请在侧栏点 **停止**。
- **解除绑定**用 `unbind()`。它先关闭本地回调和句柄，再发出撤回请求。Promise 完成后，扩展仍可能在确认撤回。已经进入传输或交给网页的数据无法追回。
- **超时或断线时**，保留原句柄查询，或到侧栏核对。普通桥接调用最多等待 5 秒。草稿和人工确认有绝对有效期，重新编辑、连接或打开侧栏不会延长期限。
- **离开页面时**，刷新、整页导航、关闭、`pagehide` 和 BFCache 冻结都会结束旧分享。SPA 软导航会使旧句柄失效，保留的按钮须更新为新记录。撤销站点权限或解除关联后，旧分享也会结束。

旧绑定和句柄仅在原页面中使用。收到超时或未知状态时，禁止自动重放同一次业务操作。

## 8. 常见问题与处理

| 现象或公开码                                                                            | 建议处理                                                                                         |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| BRIDGE_UNAVAILABLE                                                                      | 检查扩展是否已安装/启用、SDK 是否匹配，以及按钮是否在 HTTP(S) 顶层 light DOM；不要自动重放点击。 |
| SITE_NOT_ALLOWED / PERMISSION_REQUIRED                                                  | 在扩展侧栏确认实际网站和 Chrome 访问授权；已撤权的旧请求不能恢复。                               |
| PANEL_OPEN_FAILED                                                                       | 浏览器未允许本次打开侧栏；用户可点击扩展图标检查状态，再主动发起新操作，不自动弹新标签或重试。   |
| APP_NOT_RUNNING / NATIVE_HOST_UNAVAILABLE / CONNECTION_UNAVAILABLE / NATIVE_UNAVAILABLE | 检查桌面应用与扩展连接，再由用户确认下一步；已有句柄只读核对。                                   |
| `onQueue` 的 `reason: 'composer'`                                                       | 发送或清空侧栏当前输入。队列会自动继续。 |
| `onQueue` 的 `reason: 'panel'`                                                          | 点击 Chrome 工具栏的扩展图标，在当前标签页打开侧栏。队列会自动继续。 |
| `onConnection` 的 `waiting-for-connection`                                               | 回到先前申请连接的标签页，在侧栏允许或拒绝，再回到当前网页点击。 |
| CONFIRMATION_REQUIRED / RESULT_CONSENT_REQUIRED                                         | 查看侧栏提示，核对草稿后点击发送。                                                               |
| CONTEXT_TOO_LARGE / REQUEST_TOO_LARGE / INVALID_REQUEST / UNSUPPORTED_INPUT             | 在下一次操作前缩短并修正完整参数，普通文本入口不支持斜杠命令或附件。                             |
| EXPIRED / LEASE_REVOKED                                                                 | 连接申请、请求回执或网页访问权限已失效。按下方说明检查是否需要重新发起。                         |
| CAPACITY_EXCEEDED                                                                       | 暂停新点击并检查在途请求及侧栏状态，释放已不再需要的绑定；不要自动重放这次操作。                 |
| UNKNOWN_EXECUTION / REQUEST_TIMEOUT                                                     | 展示“结果未知”，使用原句柄查询；不得自动重发。                                                   |
| TOO_LATE                                                                                | 请求可能已发出，分享已撤回；需要停止时让用户操作侧栏。                                           |

连接申请或未发送的草稿超时后，用户可以从原网页再次发起。请求已发送或发送状态未知时，请先在扩展侧栏核对原会话，再决定是否重新发起。已发送任务的执行状态以原会话为准。

用结构化状态和 `code` 做业务判断。`message` 提供本地化提示，回执记录实际执行状态。

## 9. 接入验收

- 用真实点击验证四种 mode/result 组合，覆盖首次连接、旧站点补充授权、手动发送后回传、后续自动发送和只接收状态。
- 切换扩展的网页消息发送方式，验证它对所有已连接网站的新请求生效，回传仍按每次请求的 `result` 处理。
- 侧栏已有文字、附件时保留原草稿；每次网页操作使用独立对话。
- 验证更新记录、替换按钮、取消、页面刷新/跳转、撤权和应用未启动的提示。
- 已发送后断线/超时只查询，不重发；确认 unknown 不被显示为成功或失败。
- 对 available、pending、withheld、unavailable 分别处理，安全展示文本，业务写回可以幂等。

上述是接入方在目标 Chrome、发布产物及内网站点执行的验收项，不代表该业务系统已经通过完整实测。仓库已有验证的范围和剩余限制统一维护在[网页发起对话](website-launch.md#验证范围与限制)。
