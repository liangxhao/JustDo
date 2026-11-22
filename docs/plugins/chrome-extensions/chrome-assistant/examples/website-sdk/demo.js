const copy = navigator.language.startsWith('zh')
  ? {
      lang: 'zh-CN',
      title: '网页调用 Chrome 扩展示例',
      record: '示例记录有 12 个订单，其中 3 个待处理。每次接纳新任务时，页面会显示它的新编号。',
      start: '点击 A。首次使用时先允许网站连接，再在侧栏发送草稿。',
      keepOpen: 'A 发送后，保持侧栏打开并连续点击两次 B。即使 A 仍在运行，侧栏也会依次切到新对话。',
      reopen:
        '每次点击都会显示新的任务编号，各笔请求分别回传结果。处理期间可关闭侧栏，再用 Chrome 工具栏的扩展图标打开。',
      context: '订单 12 个，其中 3 个待处理。',
      prompt: {
        draft: '请用一行以 A 开头的文字回答订单总数。',
        send: '请用一行以 B 开头的文字回答待处理订单数。',
      },
      draft: 'A · 打开草稿',
      draftHelp: '在侧栏点击发送，最终文本会显示在这里。',
      send: 'B · 自动发送',
      sendHelp: 'A 发起后可用。扩展发送方式设为「跟随网页」时，B 会直接发送。',
      ready: '可以点击按钮。',
      preparing: '正在准备请求。',
      queue: ({ requestId, status, message }) =>
        `请求 ${requestId.slice(0, 8)} · ${message ?? (status === 'queued' ? '排队中' : '已取消')}`,
      receipt: ({ launchId, request, execution, output }) =>
        `任务 ${launchId.slice(0, 8)} · 请求 ${request.status} · ${execution.executionSettled ? '执行已结束' : '执行'} ${execution.status} · 结果 ${output.status}`,
      inspectTask: '请打开扩展侧栏，核对这次请求的状态。',
      unavailable: '请确认 Chrome 已加载扩展，并检查扩展与网页 SDK 是否配套。',
    }
  : {
      lang: 'en',
      title: 'Chrome extension website example',
      record:
        'This sample has 12 orders, including 3 pending orders. Each accepted task gets a new ID.',
      start:
        'Click A. On first use, allow the website to connect, then send the draft in the side panel.',
      keepOpen:
        'After sending A, leave the side panel open and click B twice. The side panel switches to each new conversation while A continues.',
      reopen:
        'Each click gets a new task ID and returns its own result. Use the extension icon to reopen the side panel if you close it.',
      context: 'There are 12 orders, including 3 pending orders.',
      prompt: {
        draft: 'Answer with one line starting with A and give the total number of orders.',
        send: 'Answer with one line starting with B and give the number of pending orders.',
      },
      draft: 'A · Open a draft',
      draftHelp: 'Send the draft in the side panel. The final text will appear here.',
      send: 'B · Send automatically',
      sendHelp: 'Available after A starts. With Follow website selected, B sends directly.',
      ready: 'Ready to click.',
      preparing: 'Preparing the request.',
      queue: ({ requestId, status, message }) =>
        `Request ${requestId.slice(0, 8)} · ${message ?? (status === 'queued' ? 'Queued' : 'Cancelled')}`,
      receipt: ({ launchId, request, execution, output }) =>
        `Task ${launchId.slice(0, 8)} · Request ${request.status} · ${execution.executionSettled ? 'Execution settled' : 'Execution'} ${execution.status} · Result ${output.status}`,
      inspectTask: 'Open the extension side panel to check this request.',
      unavailable:
        'Check that Chrome has loaded the extension and that it matches the website SDK.',
    };

document.documentElement.lang = copy.lang;
document.title = copy.title;
for (const element of document.querySelectorAll('[data-copy]')) {
  element.textContent = copy[element.dataset.copy];
}

async function bindExample(section, onReceipt) {
  const button = section.querySelector('button');
  const status = section.querySelector('[data-status]');
  const list = section.querySelector('[data-requests]');
  const mode = section.dataset.mode;
  const requests = new Map();
  let latestRequestId;

  function showReceipt(receipt) {
    const row = requests.get(receipt.requestId);
    if (!row || receipt.receiptRevision < row.revision) return;
    row.revision = receipt.receiptRevision;
    row.label.textContent = copy.receipt(receipt);
    if (receipt.error) row.label.textContent += ` · ${copy.inspectTask}`;
    if (receipt.requestId === latestRequestId) status.textContent = '';
    const available =
      receipt.execution.executionSettled === true &&
      receipt.execution.status === 'completed' &&
      receipt.output.status === 'available';
    row.result.textContent = available
      ? [receipt.output.text, ...(receipt.output.artifacts ?? []).map(artifact => artifact.name)]
          .filter(Boolean)
          .join('\n')
      : '';
    row.result.hidden = !available;
    onReceipt?.();
  }

  try {
    // Bind before the user's click. The extension handles the actual click and send.
    await window.chromeAssistant.bind(
      button,
      {
        prompt: copy.prompt[mode],
        context: { text: copy.context },
        mode,
      },
      {
        onConnection(connection) {
          button.disabled = ['waiting-for-window', 'pending', 'granting'].includes(
            connection.status,
          );
          status.textContent = connection.message ?? copy.inspectTask;
        },
        onRequest(request) {
          latestRequestId = request.requestId;
          status.textContent = '';
          const entry = document.createElement('li');
          const label = document.createElement('span');
          const result = document.createElement('pre');
          label.textContent = copy.preparing;
          result.hidden = true;
          entry.append(label, result);
          list.append(entry);
          requests.set(request.requestId, { label, result, revision: -1 });
        },
        onQueue(queue) {
          const row = requests.get(queue.requestId);
          if (row) row.label.textContent = copy.queue(queue);
        },
        onStatus: showReceipt,
        onResult: showReceipt,
        onActionRequired({ requestId, message }) {
          const row = requests.get(requestId);
          const label = row?.label ?? status;
          label.textContent = message;
        },
      },
    );
    status.textContent = copy.ready;
    button.disabled = false;
  } catch {
    status.textContent = copy.unavailable;
  }
}

const draftSection = document.querySelector('[data-mode="draft"]');
const sendSection = document.querySelector('[data-mode="send"]');
let sendBinding;
// After A is admitted, the website grant and the content script are ready for B.
void bindExample(draftSection, () => {
  sendBinding ??= bindExample(sendSection);
});
