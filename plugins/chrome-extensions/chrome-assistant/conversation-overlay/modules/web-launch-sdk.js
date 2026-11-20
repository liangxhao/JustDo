import {
  BIND_ATTRIBUTE,
  WEB_BRIDGE,
  WEB_CONNECTION,
  inputDigest,
  normalizeInput,
  randomIdentifier,
  publicErrorCode,
} from './web-launch-security.js';

const DEFINITE_CONNECTION_REJECTIONS = new Set([
  'CAPACITY_EXCEEDED',
  'EXPIRED',
  'FORBIDDEN',
  'INVALID_REQUEST',
  'PANEL_OPEN_FAILED',
  'WINDOW_BUSY',
]);

const messages = {
  en: {
    generic: 'Open the extension side panel in this tab and check the request before trying again.',
    opening: 'Opening the extension side panel.',
    waiting:
      'Your connection request is waiting for this window’s tasks to finish. Then confirm it in this tab’s side panel.',
    confirm: 'Open the extension side panel in this tab and select Allow connection.',
    checking: 'Checking this website’s Chrome permissions.',
    connectionExpired:
      'This connection request expired. Click the webpage button to request the connection again.',
    connected:
      'Website connected. Review the draft in the side panel and select Send when it is ready.',
    queued:
      'The request is queued. Keep its tab open so the side panel can start it when it is next.',
    composer:
      'The request is queued. Send or clear the current draft and attachments in the side panel to continue. Copy any text you want to keep first.',
    cancelled: 'This request was cancelled.',
    errors: {
      APP_NOT_RUNNING: 'Open the desktop app, then return to this tab and click the button again.',
      CAPACITY_EXCEEDED:
        'There are too many pending requests. Wait for one to finish or cancel a queued request, then click again.',
      COMPOSER_BUSY:
        'Finish the current task or send, save, or clear the current draft in the side panel, then click this button again.',
      CONNECTION_PENDING:
        'Return to the tab where you started the existing connection. Allow or decline it in the side panel, then come back and click this button again.',
      CONNECTION_REJECTED:
        'The connection was declined. Click the webpage button again if you want to connect this website.',
      EXPIRED:
        'This request has expired. Check the side panel for the original request before clicking again.',
      FORBIDDEN:
        'Use the website button in the main tab. If it still cannot open the side panel, ask the website administrator to check the integration.',
      INVALID_REQUEST: 'Ask the website administrator to check this button’s configuration.',
      LEASE_REVOKED:
        'This page’s connection ended. Return to the webpage and click the button to reconnect.',
      PANEL_OPEN_FAILED:
        'Open the extension side panel from the Chrome toolbar in this tab, then click the webpage button again.',
      PERMISSION_REQUIRED:
        'Click the webpage button again and allow Chrome to access this website when prompted.',
      POLICY_CONFLICT:
        'Website permissions or settings changed. Check the extension settings, then click the webpage button again.',
      SITE_NOT_ALLOWED:
        'Click the webpage button again and confirm this website in the extension side panel.',
      WINDOW_BUSY:
        'Finish the work or connection already open in this Chrome window, then return to this tab and click the button again.',
    },
  },
  zh: {
    generic: '请打开此标签页的扩展侧栏核对请求状态，再决定是否重新点击。',
    opening: '正在打开扩展侧栏。',
    waiting: '连接请求正在等待本窗口的任务处理完毕。届时请在此标签页的侧栏确认连接。',
    confirm: '请打开此标签页的扩展侧栏，点击「允许连接」。',
    checking: '正在核对 Chrome 的网站访问权限。',
    connectionExpired: '这次连接申请已过期，请点击网页按钮重新申请。',
    connected: '网站已连接。草稿就绪后，请在侧栏核对并点击发送。',
    queued: '请求已排队。请保留此标签页，轮到时会在侧栏处理。',
    composer:
      '请求已排队。请先发送或清空侧栏里的草稿和附件，队列会继续处理。如需保留文字，可以先复制。',
    cancelled: '本次请求已取消。',
    errors: {
      APP_NOT_RUNNING: '请先打开桌面应用，再回到此标签页点击按钮。',
      CAPACITY_EXCEEDED: '待处理请求已满。请等一笔完成或取消一笔排队请求，再点击按钮。',
      COMPOSER_BUSY: '请先在侧栏处理当前任务，或发送、保存、清空当前草稿，再回到此页点击按钮。',
      CONNECTION_PENDING:
        '请回到先前发起连接的标签页，在侧栏允许或拒绝该连接，再回到此页点击按钮。',
      CONNECTION_REJECTED: '网站连接已拒绝。如果仍想连接此网站，请再次点击网页按钮。',
      EXPIRED: '这次请求已过期。请先在侧栏核对原请求，再决定是否重新点击。',
      FORBIDDEN: '请在网站的主标签页使用此按钮。若仍无法打开侧栏，请联系网站管理员检查接入。',
      INVALID_REQUEST: '请联系网站管理员检查这个按钮的配置。',
      LEASE_REVOKED: '此页的连接已结束，请回到网页点击按钮重新连接。',
      PANEL_OPEN_FAILED: '请在此标签页点击 Chrome 工具栏的扩展图标打开侧栏，再点击网页按钮。',
      PERMISSION_REQUIRED: '请再次点击网页按钮，并按 Chrome 的提示允许访问此网站。',
      POLICY_CONFLICT: '站点授权或发送设置已更改。请核对扩展设置，再从网页点击按钮。',
      SITE_NOT_ALLOWED: '请再次点击网页按钮，在扩展侧栏确认此网站的连接权限。',
      WINDOW_BUSY: '请先处理这个 Chrome 窗口中已有的任务或连接申请，再回到此页点击按钮。',
    },
  },
};

export function createChromeAssistant({
  window: view = window,
  document: doc = document,
  cryptoApi = crypto,
  runtimeApi = view.chrome?.runtime,
  extensionId = typeof __CHROME_ASSISTANT_EXTENSION_ID__ === 'string'
    ? __CHROME_ASSISTANT_EXTENSION_ID__
    : '',
} = {}) {
  const pending = new Map();
  const bindings = new Map();
  const origin = view.location.origin;
  const copy = view.navigator?.language?.startsWith('zh') ? messages.zh : messages.en;
  const errorMessage = (code, busyReason) => {
    const key = code === 'WINDOW_BUSY' && busyReason === 'connection' ? 'CONNECTION_PENDING' : code;
    return Object.hasOwn(copy.errors, key) ? copy.errors[key] : copy.generic;
  };
  const failure = (code, busyReason) =>
    Object.assign(new Error(errorMessage(code, busyReason)), { code });
  const externalAvailable = Boolean(extensionId && runtimeApi?.sendMessage);
  function external(op, extra = {}) {
    return new Promise((resolve, reject) => {
      const timer = view.setTimeout(() => reject(failure('BRIDGE_UNAVAILABLE')), 5000);
      let response;
      try {
        response = runtimeApi.sendMessage(extensionId, { type: WEB_CONNECTION, op, ...extra });
      } catch (error) {
        view.clearTimeout(timer);
        reject(failure(publicErrorCode(error)));
        return;
      }
      Promise.resolve(response).then(
        value => {
          view.clearTimeout(timer);
          if (value?.ok) resolve(value);
          else {
            const error = failure(publicErrorCode(value), value?.busyReason);
            error.definitive =
              value?.ok === false && DEFINITE_CONNECTION_REJECTIONS.has(error.code);
            reject(error);
          }
        },
        error => {
          view.clearTimeout(timer);
          reject(failure(publicErrorCode(error)));
        },
      );
    });
  }
  function connectionEvent(binding, value, guidance) {
    if (binding.closed || !value) return;
    if (value?.pendingId) binding.connectionId = value.pendingId;
    const status =
      { 'awaiting-consent': 'pending', cancelled: 'rejected' }[value.status] ?? value.status;
    const message =
      guidance ??
      (value.code
        ? errorMessage(value.code)
        : {
            'waiting-for-window': copy.waiting,
            pending: value.requiresAction ? copy.confirm : copy.opening,
            granting: copy.checking,
            connected: copy.connected,
            rejected: copy.cancelled,
            expired: copy.connectionExpired,
          }[status]);
    const event = {
      status,
      origin,
      ...(value.code ? { code: value.code } : {}),
      ...(message ? { message } : {}),
    };
    const key = JSON.stringify(event);
    if (binding.connectionEvent !== key) {
      binding.connectionEvent = key;
      binding.callbacks.onConnection?.(event);
    }
  }
  function stopPolling(binding) {
    if (binding.pollTimer !== undefined) view.clearTimeout(binding.pollTimer);
    binding.pollTimer = undefined;
  }
  function pollConnection(binding) {
    if (binding.closed || !binding.bootstrapPending) return;
    const generation = binding.generation;
    stopPolling(binding);
    binding.pollTimer = view.setTimeout(async () => {
      if (binding.closed || !binding.bootstrapPending || binding.generation !== generation) return;
      if (Date.now() >= binding.connectionDeadline) {
        binding.bootstrapPending = false;
        connectionEvent(binding, { status: 'expired' });
        return;
      }
      try {
        const result = await external(
          'query',
          binding.connectionId ? { pendingId: binding.connectionId } : { bindingId: binding.id },
        );
        if (binding.closed || !binding.bootstrapPending || binding.generation !== generation)
          return;
        connectionEvent(binding, result.connectionPending);
        if (['rejected', 'expired', 'cancelled'].includes(result.connectionPending?.status)) {
          binding.bootstrapPending = false;
          return;
        }
      } catch {
        /* A lost connection ACK never replays the request. */
      }
      if (binding.generation !== generation) return;
      pollConnection(binding);
    }, 1000);
  }
  function call(bindingId, kind, extra = {}, timeoutMs = 5000) {
    const correlationId = randomIdentifier(cryptoApi);
    return new Promise((resolve, reject) => {
      const timer = view.setTimeout(() => {
        pending.delete(correlationId);
        reject(failure('BRIDGE_UNAVAILABLE'));
      }, timeoutMs);
      pending.set(correlationId, { resolve, reject, timer });
      view.postMessage(
        { bridge: WEB_BRIDGE, direction: 'page', correlationId, bindingId, kind, ...extra },
        origin,
      );
    });
  }
  function closeBinding(binding) {
    binding.closed = true;
    binding.generation += 1;
    stopPolling(binding);
    if (externalAvailable && binding.bootstrapPending)
      void external('cancel', { bindingId: binding.id }).catch(() => {});
    binding.requests.clear();
    bindings.delete(binding.id);
  }
  function receive(event) {
    const message = event.data;
    if (
      event.source !== view ||
      event.origin !== origin ||
      message?.bridge !== WEB_BRIDGE ||
      message.direction !== 'extension'
    )
      return;
    if (message.kind === 'reply') {
      const waiter = pending.get(message.correlationId);
      if (!waiter) return;
      pending.delete(message.correlationId);
      view.clearTimeout(waiter.timer);
      if (message.ok) waiter.resolve(message);
      else waiter.reject(failure(publicErrorCode(message)));
      return;
    }
    if (message.kind === 'lease-retired') {
      for (const binding of bindings.values()) {
        binding.generation += 1;
        for (const request of binding.requests.values()) request.closed = true;
        binding.requests.clear();
        if (binding.bootstrapPending) {
          binding.bootstrapPending = false;
          binding.connectionId = undefined;
          stopPolling(binding);
        }
        if (message.reconnectRequired && externalAvailable) {
          binding.bootstrap = true;
          binding.bootstrapPending = false;
          binding.connectionId = undefined;
          stopPolling(binding);
          connectionEvent(binding, { status: 'expired', code: 'LEASE_REVOKED' });
        }
      }
      return;
    }
    const binding = bindings.get(message.bindingId);
    if (!binding || binding.closed) return;
    if (message.kind === 'connection-ready') {
      if (
        !binding.bootstrapPending ||
        binding.continuingGeneration === binding.generation ||
        !binding.button.isConnected ||
        binding.revision !== message.bindingRevision ||
        binding.digest !== message.payloadDigest
      )
        return;
      const generation = binding.generation;
      binding.continuingGeneration = generation;
      void (async () => {
        try {
          binding.button.setAttribute(BIND_ATTRIBUTE, binding.id);
          await call(binding.id, 'bind', {
            bindingRevision: binding.revision,
            input: binding.input,
          });
          if (binding.closed || binding.generation !== generation) return;
          binding.bootstrap = false;
          await call(binding.id, 'continue', { pendingId: message.pendingId });
          if (binding.closed || binding.generation !== generation) return;
          binding.bootstrapPending = false;
          stopPolling(binding);
          connectionEvent(binding, { status: 'connected' });
        } catch (error) {
          if (!binding.closed && binding.generation === generation)
            binding.callbacks.onError?.(failure(publicErrorCode(error)));
        } finally {
          if (binding.continuingGeneration === generation) binding.continuingGeneration = undefined;
        }
      })();
      return;
    }
    if (message.kind === 'binding-error') {
      binding.callbacks.onError?.(failure(publicErrorCode(message)));
      return;
    }
    if (message.kind === 'request' && !binding.requests.has(message.requestId)) {
      if (binding.requests.size >= 100) {
        const retired = [...binding.requests.entries()].find(([, request]) => request.terminal);
        if (!retired) {
          binding.callbacks.onError?.(failure('CAPACITY_EXCEEDED'));
          return;
        }
        retired[1].closed = true;
        binding.requests.delete(retired[0]);
      }
      const state = { launchId: undefined, revision: -1, resultKey: '', closed: false };
      const handle = Object.freeze({
        requestId: message.requestId,
        bindingRevision: message.bindingRevision,
        get launchId() {
          return state.launchId;
        },
        read: () =>
          state.closed || binding.closed
            ? Promise.reject(failure('EXPIRED'))
            : call(binding.id, 'read', { requestId: message.requestId }),
        cancel: () =>
          state.closed || binding.closed
            ? Promise.reject(failure('EXPIRED'))
            : call(binding.id, 'cancel', { requestId: message.requestId }),
      });
      binding.requests.set(message.requestId, state);
      binding.callbacks.onRequest?.(handle);
    }
    const state = binding.requests.get(message.requestId);
    if (!state) return;
    if (
      message.kind === 'queue' &&
      !state.launchId &&
      !state.terminal &&
      ['queued', 'cancelled'].includes(message.status)
    ) {
      state.terminal = message.status === 'cancelled';
      binding.callbacks.onQueue?.({
        requestId: message.requestId,
        status: message.status,
        message: state.terminal
          ? copy.cancelled
          : message.reason === 'composer'
            ? copy.composer
            : copy.queued,
      });
      return;
    }
    if (message.kind === 'error') {
      if (message.terminal === true) state.terminal = true;
      binding.callbacks.onError?.(failure(publicErrorCode(message)), message.requestId);
      return;
    }
    if (
      message.kind !== 'status' ||
      !message.receipt ||
      message.receipt.receiptRevision < state.revision
    )
      return;
    const receipt = message.receipt;
    state.launchId = receipt.launchId;
    state.terminal =
      receipt.execution?.executionSettled === true ||
      ['cancelled', 'expired', 'rejected'].includes(receipt.request?.status);
    if (receipt.receiptRevision > state.revision) binding.callbacks.onStatus?.(receipt);
    state.revision = receipt.receiptRevision;
    if (
      receipt.execution?.executionSettled === true &&
      ['available', 'empty', 'unsupported', 'unavailable'].includes(receipt.output?.status)
    ) {
      const key = JSON.stringify(receipt.output);
      if (key !== state.resultKey) {
        state.resultKey = key;
        binding.callbacks.onResult?.(receipt);
      }
    }
  }
  view.addEventListener('message', receive);
  const onHide = () => {
    for (const binding of bindings.values()) closeBinding(binding);
  };
  view.addEventListener('pagehide', onHide);
  function click(event) {
    if (!event.isTrusted || !view.navigator.userActivation?.isActive || doc.prerendering) return;
    const binding = [...bindings.values()].find(
      value =>
        !value.closed &&
        value.bootstrap &&
        !value.bootstrapPending &&
        event.composedPath().includes(value.button),
    );
    if (
      !binding ||
      !binding.button.isConnected ||
      binding.button.disabled ||
      binding.button.ownerDocument !== doc ||
      binding.button.getRootNode() !== doc
    )
      return;
    binding.bootstrapPending = true;
    binding.generation += 1;
    const generation = binding.generation;
    binding.connectionId = undefined;
    binding.connectionDeadline = Date.now() + 120_000;
    // This must remain on the actual click stack; no digest or bridge await here.
    const request = external('request', {
      bindingId: binding.id,
      bindingRevision: binding.revision,
      input: binding.input,
      payloadDigest: binding.digest,
    });
    connectionEvent(binding, { status: 'awaiting-consent' });
    void request.then(
      result => {
        if (binding.closed) {
          void external('cancel', { pendingId: result.connectionPending.pendingId }).catch(
            () => {},
          );
          return;
        }
        if (!binding.bootstrapPending || binding.generation !== generation) return;
        connectionEvent(binding, result.connectionPending);
        pollConnection(binding);
      },
      error => {
        if (binding.closed || !binding.bootstrapPending || binding.generation !== generation)
          return;
        if (error.definitive) {
          binding.bootstrapPending = false;
          connectionEvent(binding, { status: 'rejected', code: error.code }, error.message);
        } else pollConnection(binding);
        binding.callbacks.onError?.(error);
      },
    );
  }
  doc.addEventListener?.('click', click, true);
  return Object.freeze({
    async bind(button, options, callbacks = {}) {
      if (
        view !== view.top ||
        button?.ownerDocument !== doc ||
        button.tagName !== 'BUTTON' ||
        button.type !== 'button' ||
        !button.isConnected ||
        button.getRootNode() !== doc ||
        !normalizeInput(options)
      )
        throw failure('INVALID_REQUEST');
      const id = randomIdentifier(cryptoApi);
      if (bindings.size >= 64) throw failure('CAPACITY_EXCEEDED');
      const binding = {
        id,
        button,
        callbacks,
        requests: new Map(),
        revision: 1,
        closed: false,
        generation: 0,
        input: normalizeInput(options),
        bootstrap: false,
      };
      bindings.set(id, binding);
      button.setAttribute(BIND_ATTRIBUTE, id);
      try {
        if (externalAvailable) {
          binding.digest = await inputDigest(binding.input, cryptoApi);
          const probe = await external('probe');
          binding.bootstrap = probe.connected !== true;
          if (!binding.bootstrap) {
            try {
              await call(id, 'ping', {}, 150);
            } catch (error) {
              if (error.code !== 'BRIDGE_UNAVAILABLE') throw error;
              binding.bootstrap = true;
            }
          }
        }
        if (binding.closed) throw failure('EXPIRED');
        if (!binding.bootstrap)
          await call(id, 'bind', { bindingRevision: 1, input: binding.input });
      } catch (error) {
        closeBinding(binding);
        if (button.getAttribute(BIND_ATTRIBUTE) === id) button.removeAttribute(BIND_ATTRIBUTE);
        throw error;
      }
      return Object.freeze({
        async update(input) {
          if (binding.closed || !normalizeInput(input)) throw failure('INVALID_REQUEST');
          if (binding.bootstrapPending) throw failure('REQUEST_CONFLICT');
          const disabled = button.disabled;
          button.disabled = true;
          try {
            const next = normalizeInput(input);
            const digest = externalAvailable ? await inputDigest(next, cryptoApi) : undefined;
            if (!binding.bootstrap)
              await call(id, 'update', { bindingRevision: binding.revision + 1, input: next });
            binding.revision += 1;
            binding.input = next;
            binding.digest = digest;
          } finally {
            button.disabled = disabled;
          }
        },
        async unbind() {
          if (binding.closed) return;
          closeBinding(binding);
          if (!binding.bootstrap) await call(id, 'unbind');
        },
      });
    },
  });
}
