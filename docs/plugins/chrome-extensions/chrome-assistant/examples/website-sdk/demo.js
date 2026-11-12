const copy = navigator.language.startsWith('zh')
  ? {
      lang: 'zh-CN',
      title: '网页调用 Chrome 扩展示例',
      record: '示例记录有 12 个订单，其中 3 个待处理。每个按钮显示最近一次请求的状态。',
      context: '订单 12 个，其中 3 个待处理。',
      prompt: '用一句话总结这条订单记录。',
      draft: '打开草稿并请求结果',
      draftHelp: '在侧栏确认发送和分享结果，最终文本会显示在这里。',
      send: '请求自动发送',
      sendHelp:
        '完成当前草稿后再试。确认发送时可勾选“今后允许此网站直接发送”。以后点击只回传状态。',
      ready: '可以点击按钮。',
      confirm: origin => `请在扩展侧栏确认连接 ${origin}。`,
      connection: status => `连接状态 ${status}`,
      preparing: '正在准备请求。',
      receipt: ({ request, execution, output }) =>
        `请求 ${request.status} · 执行 ${execution.status} · 结果 ${output.status}`,
      error: code => `请求提示 ${code}。请查看扩展侧栏。`,
      unavailable: code => `按钮无法绑定（${code}）。请检查扩展及网页 SDK 是否为同一版本。`,
    }
  : {
      lang: 'en',
      title: 'Chrome extension website example',
      record:
        'This sample has 12 orders, including 3 pending orders. Each button shows its latest request.',
      context: 'There are 12 orders, including 3 pending orders.',
      prompt: 'Summarize this order record in one sentence.',
      draft: 'Open a draft and request the result',
      draftHelp:
        'Confirm sending and result sharing in the side panel. The final text will appear here.',
      send: 'Request automatic sending',
      sendHelp:
        'Finish the current draft first. When confirming this send, select “Allow this website to send directly next time.” This button returns status updates.',
      ready: 'Ready to click.',
      confirm: origin => `Confirm the connection to ${origin} in the extension side panel.`,
      connection: status => `Connection status ${status}`,
      preparing: 'Preparing the request.',
      receipt: ({ request, execution, output }) =>
        `Request ${request.status} · Execution ${execution.status} · Result ${output.status}`,
      error: code => `Request notice ${code}. Check the extension side panel.`,
      unavailable: code =>
        `Could not bind the button (${code}). Check that the extension and website SDK versions match.`,
    };

document.documentElement.lang = copy.lang;
document.title = copy.title;
for (const element of document.querySelectorAll('[data-copy]')) {
  element.textContent = copy[element.dataset.copy];
}

async function bindExample(section) {
  const button = section.querySelector('button');
  const status = section.querySelector('[data-status]');
  const result = section.querySelector('[data-result]');
  const mode = section.dataset.mode;
  let latestRequestId;
  let latestRevision = -1;

  function showReceipt(receipt) {
    if (receipt.requestId !== latestRequestId || receipt.receiptRevision < latestRevision) return;
    latestRevision = receipt.receiptRevision;
    status.textContent = copy.receipt(receipt);
    if (receipt.error) status.textContent += ` · ${receipt.error.code}`;
    const available =
      receipt.execution.executionSettled === true &&
      receipt.execution.status === 'completed' &&
      receipt.output.status === 'available';
    result.textContent = available ? (receipt.output.text ?? '') : '';
    result.hidden = !available;
  }

  try {
    // Bind before the user's click. The extension handles the actual click and send.
    await window.chromeAssistant.bind(
      button,
      {
        prompt: copy.prompt,
        context: { text: copy.context },
        mode,
        result: mode === 'draft' ? 'final' : 'none',
      },
      {
        onConnection(connection) {
          const waiting = connection.status === 'pending' || connection.status === 'granting';
          button.disabled = waiting;
          if (waiting) status.textContent = copy.confirm(connection.origin);
          else if (connection.status !== 'connected')
            status.textContent = copy.connection(connection.status);
        },
        onRequest(request) {
          latestRequestId = request.requestId;
          latestRevision = -1;
          status.textContent = copy.preparing;
          result.textContent = '';
          result.hidden = true;
        },
        onStatus: showReceipt,
        onResult: showReceipt,
        onError(error) {
          status.textContent = copy.error(error.code);
        },
      },
    );
    status.textContent = copy.ready;
    button.disabled = false;
  } catch (error) {
    status.textContent = copy.unavailable(error.code ?? 'BRIDGE_UNAVAILABLE');
  }
}

// Bind serially so each button finishes registration before another begins.
void (async () => {
  for (const section of document.querySelectorAll('[data-mode]')) await bindExample(section);
})();
