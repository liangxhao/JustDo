import {
  BIND_ATTRIBUTE,
  WEB_BRIDGE,
  WEB_CONNECTION,
  inputDigest,
  normalizeInput,
  randomIdentifier,
  publicErrorCode,
  queueWaitReason,
} from './web-launch-security.js';

const DEFINITE_CONNECTION_REJECTIONS = new Set([
  'CAPACITY_EXCEEDED',
  'EXPIRED',
  'FORBIDDEN',
  'INVALID_REQUEST',
  'PANEL_OPEN_FAILED',
]);

const messages = {
  en: {
    generic: 'Open the extension side panel in this tab and check the request before trying again.',
    opening: 'Opening the extension side panel.',
    waiting:
      'Finish the current input in the side panel. Then confirm this website’s connection.',
    waitingForConnection:
      'Return to the tab where you started the existing connection. Allow or decline it in the side panel, then come back and click this button again.',
    confirm: 'Open the extension side panel in this tab and select Allow connection.',
    checking: 'Checking this website’s Chrome permissions.',
    connectionAppPending: 'Open the desktop app, then continue this connection in the side panel.',
    connectionExpired:
      'This connection request expired. Click the webpage button to request the connection again.',
    connected:
      'Website connected. Review the draft in the side panel and select Send when it is ready.',
    queued:
      'The request is queued. Keep its tab open so the side panel can start it when it is next.',
    composer: 'The request is queued. Handle the current draft or approval in the side panel, or wait for the send confirmation.',
    panel: 'The request is queued. Open the extension side panel from the Chrome toolbar in this tab to continue.',
    connection: 'The request is queued while the extension checks this page and the connection. Keep this tab open and open the desktop app if needed.',
    cancelled: 'This request was cancelled.',
    errors: {
      APP_NOT_RUNNING: 'Open the desktop app, then return to this tab and click the button again.',
      CAPACITY_EXCEEDED:
        'There are too many pending requests. Wait for one to finish or cancel a queued request, then click again.',
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
      BRIDGE_UNAVAILABLE: 'Check that the Chrome extension is enabled and this website uses its matching SDK, then click again.',
      CONNECTION_UNAVAILABLE: 'Check the desktop app and the extension connection. Look for the current request in the side panel before clicking again.',
      INCOMPATIBLE_VERSION: 'Update and reload the Chrome extension using the version supplied with the desktop app, then check the original request in the side panel.',
      STORAGE_UNAVAILABLE: 'The desktop app cannot read or save this request. Check the original request in the side panel and contact your administrator if the problem continues.',
      UNKNOWN_EXECUTION: 'Check the original request in the side panel before starting another task.',
      REQUEST_TOO_LARGE: 'Reduce the text or context provided by this button, then click again.',
      REQUEST_CONFLICT: 'Finish or cancel the current website request before changing the button or starting again. If the conflict persists, ask the website administrator to check the integration.',
      CONFIRMATION_REQUIRED: 'Review the draft in the extension side panel and select Send to confirm it.',
      RESULT_CONSENT_REQUIRED: 'Review the draft and result sharing in the extension side panel, then select Send to confirm.',
      COMPOSE_CHANGED: 'Check the latest draft in the side panel and send it once the update is confirmed.',
      TOO_LATE: 'Check the original conversation in the side panel. If the task is still running and you want to stop it, select Stop there.',
      EXECUTION_FAILED: 'Open the original conversation in the side panel to see why the task failed.',
      EXECUTION_INTERRUPTED: 'The task stopped. Open the original conversation to review its progress.',
      RESULT_UNAVAILABLE: 'Open the original conversation in the side panel to check the result.',
      CANCEL_PENDING: 'Wait for cancellation confirmation. Check the original request in the side panel for its current status.',
      INTERNAL_ERROR: 'Check the original request in the side panel before trying again. Contact your administrator if the problem continues.',
      NATIVE_UNAVAILABLE: 'Check the desktop app’s connection and current working folder, then review the original request in the side panel.',
    },
  },
  zh: {
    generic: '请打开此标签页的扩展侧栏核对请求状态，再决定是否重新点击。',
    opening: '正在打开扩展侧栏。',
    waiting: '请先处理当前侧栏的输入，再在侧栏确认此网站的连接。',
    waitingForConnection: '请回到先前发起连接的标签页，在侧栏允许或拒绝该连接，再回到此页点击按钮。',
    confirm: '请打开此标签页的扩展侧栏，点击「允许连接」。',
    checking: '正在核对 Chrome 的网站访问权限。',
    connectionAppPending: '请打开桌面应用，再在侧栏继续这笔连接申请。',
    connectionExpired: '这次连接申请已过期，请点击网页按钮重新申请。',
    connected: '网站已连接。草稿就绪后，请在侧栏核对并点击发送。',
    queued: '请求已排队。请保留此标签页，轮到时会在侧栏处理。',
    composer: '请求已排队。请先处理侧栏当前的草稿或审批，或等待当前消息确认发送。',
    panel: '请求已排队。请在此标签页点击 Chrome 工具栏的扩展图标打开侧栏，队列会继续处理。',
    connection: '请求已排队，扩展正在核对网页与桌面端连接。请保留此标签页，如桌面应用未启动，请先打开。',
    cancelled: '本次请求已取消。',
    errors: {
      APP_NOT_RUNNING: '请先打开桌面应用，再回到此标签页点击按钮。',
      CAPACITY_EXCEEDED: '待处理请求已满。请等一笔完成或取消一笔排队请求，再点击按钮。',
      CONNECTION_REJECTED: '网站连接已拒绝。如果仍想连接此网站，请再次点击网页按钮。',
      EXPIRED: '这次请求已过期。请先在侧栏核对原请求，再决定是否重新点击。',
      FORBIDDEN: '请在网站的主标签页使用此按钮。若仍无法打开侧栏，请联系网站管理员检查接入。',
      INVALID_REQUEST: '请联系网站管理员检查这个按钮的配置。',
      LEASE_REVOKED: '此页的连接已结束，请回到网页点击按钮重新连接。',
      PANEL_OPEN_FAILED: '请在此标签页点击 Chrome 工具栏的扩展图标打开侧栏，再点击网页按钮。',
      PERMISSION_REQUIRED: '请再次点击网页按钮，并按 Chrome 的提示允许访问此网站。',
      POLICY_CONFLICT: '站点授权或发送设置已更改。请核对扩展设置，再从网页点击按钮。',
      SITE_NOT_ALLOWED: '请再次点击网页按钮，在扩展侧栏确认此网站的连接权限。',
      BRIDGE_UNAVAILABLE: '请确认 Chrome 扩展已启用，且网页 SDK 与扩展版本匹配，再点击按钮。',
      CONNECTION_UNAVAILABLE: '请检查桌面应用和扩展的连接，并在侧栏核对原请求后再点击按钮。',
      INCOMPATIBLE_VERSION: '请用桌面应用附带的版本更新并重新加载 Chrome 扩展，然后在侧栏核对原请求。',
      STORAGE_UNAVAILABLE: '桌面应用暂时无法读取或保存请求。请在侧栏核对原请求，问题持续时请联系管理员。',
      UNKNOWN_EXECUTION: '请先在侧栏核对原请求，再决定是否发起新任务。',
      REQUEST_TOO_LARGE: '请缩减按钮提供的文字或附带的上下文，再点击按钮。',
      REQUEST_CONFLICT: '请先处理或取消当前网页请求，再更新按钮或重新发起。问题持续时，请联系网站管理员检查接入。',
      CONFIRMATION_REQUIRED: '请在扩展侧栏核对草稿，再点击「发送」确认。',
      RESULT_CONSENT_REQUIRED: '请在扩展侧栏核对草稿和结果回传范围，再点击「发送」确认。',
      COMPOSE_CHANGED: '输入已改变。请在侧栏核对最新草稿，等待更新确认后再发送。',
      TOO_LATE: '请在侧栏核对原会话。如果任务仍在运行且你想结束它，请在侧栏点击「停止」。',
      EXECUTION_FAILED: '请在扩展侧栏打开原会话，查看任务失败的原因。',
      EXECUTION_INTERRUPTED: '任务已停止。可打开原会话查看已有进度。',
      RESULT_UNAVAILABLE: '请在扩展侧栏打开原会话，查看任务结果。',
      CANCEL_PENDING: '请等待取消确认，并在侧栏核对原请求的当前状态。',
      INTERNAL_ERROR: '请先在侧栏核对原请求，问题持续时请联系管理员。',
      NATIVE_UNAVAILABLE: '请检查桌面应用的连接和当前工作目录，再在侧栏核对原请求。',
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
  const errorMessage = code => {
    const key = ({
      NATIVE_HOST_UNAVAILABLE: 'CONNECTION_UNAVAILABLE',
      REQUEST_TIMEOUT: 'CONNECTION_UNAVAILABLE', CONTEXT_TOO_LARGE: 'REQUEST_TOO_LARGE',
      INVALID_SOURCE: 'FORBIDDEN', INVALID_ORIGIN: 'FORBIDDEN', UNSUPPORTED_INPUT: 'INVALID_REQUEST',
      CONFLICT: 'REQUEST_CONFLICT', UNKNOWN_REQUEST: 'EXPIRED', UNSUPPORTED_RESULT_MODE: 'RESULT_UNAVAILABLE',
    })[code] ?? code;
    return Object.hasOwn(copy.errors, key) ? copy.errors[key] : copy.generic;
  };
  const failure = code => Object.assign(new Error(errorMessage(code)), { code });
  const describeReceipt = receipt => receipt?.error
    ? { ...receipt, error: { ...receipt.error, message: errorMessage(publicErrorCode(receipt.error)) } }
    : receipt;
  const actionRequired = (code, requestId) => ({
    code, message: errorMessage(code), ...(requestId ? { requestId } : {}),
  });
  const notifyAction = (binding, code, requestId) => {
    if (binding.callbacks.onActionRequired) binding.callbacks.onActionRequired(actionRequired(code, requestId));
    else binding.callbacks.onError?.(failure(code), requestId);
  };
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
          if (op === 'request' && (value?.busyReason === 'connection' ||
              value?.connectionPending?.code === 'CONNECTION_PENDING'))
            resolve({ ok: true, connectionPending: { status: 'waiting-for-connection' } });
          else if (value?.ok) resolve(value);
          else {
            const error = failure(publicErrorCode(value));
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
        ? (value.code === 'APP_NOT_RUNNING' && ['waiting-for-window', 'pending'].includes(status)
          ? copy.connectionAppPending
          : errorMessage(value.code))
        : {
            'waiting-for-window': copy.waiting,
            'waiting-for-connection': copy.waitingForConnection,
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
      const acceptsAction = kind === 'continue' || typeof bindings.get(bindingId)?.callbacks.onActionRequired === 'function';
      pending.set(correlationId, { resolve, reject, timer, acceptsAction });
      view.postMessage(
        { bridge: WEB_BRIDGE, direction: 'page', correlationId, bindingId, kind, ...extra },
        origin,
      );
    });
  }
  function bridgeOwnsClick(binding) {
    return binding.registration?.supportsHandoff === true &&
      !binding.button.hasAttribute(BIND_ATTRIBUTE);
  }
  function attachBootstrapBinding(binding, supportsHandoff) {
    if (!binding.bootstrap) return Promise.resolve();
    if (binding.registration) return binding.registration.promise;
    binding.button.setAttribute(BIND_ATTRIBUTE, binding.id);
    const registration = { supportsHandoff };
    registration.promise = call(binding.id, 'bind', {
      bindingRevision: binding.revision,
      input: binding.input,
    }).catch(error => {
      // The isolated bridge can be ready even if its reply is dropped.
      if (error.code !== 'BRIDGE_UNAVAILABLE' || binding.closed ||
          binding.registration !== registration || !bridgeOwnsClick(binding))
        throw error;
    }).then(() => {
      if (binding.registration === registration) binding.bootstrap = false;
    }).finally(() => {
      if (binding.registration === registration) binding.registration = undefined;
    });
    binding.registration = registration;
    return registration.promise;
  }
  function closeBinding(binding) {
    if (bridgeOwnsClick(binding)) binding.bootstrap = false;
    binding.closed = true;
    binding.generation += 1;
    stopPolling(binding);
    if (externalAvailable && binding.bootstrapPending)
      void external('cancel', { bindingId: binding.id }).catch(() => {});
    if (binding.button.getAttribute(BIND_ATTRIBUTE) === binding.id)
      binding.button.removeAttribute(BIND_ATTRIBUTE);
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
      if (waiter.acceptsAction && message.actionRequired) waiter.resolve({
        ok: true,
        actionRequired: actionRequired(publicErrorCode(message.actionRequired), message.actionRequired.requestId),
      });
      else if (message.ok) waiter.resolve(message.receipt ? { ...message, receipt: describeReceipt(message.receipt) } : message);
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
          binding.registration = undefined;
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
      const supportsHandoff = message.bindingHandoff === true;
      binding.continuingGeneration = generation;
      void (async () => {
        try {
          await attachBootstrapBinding(binding, supportsHandoff);
          if (binding.closed || binding.generation !== generation) return;
          const continuation = call(binding.id, 'continue', { pendingId: message.pendingId });
          if (supportsHandoff) {
            for (const other of bindings.values()) {
              if (other !== binding && other.bootstrap && other.button.isConnected)
                void attachBootstrapBinding(other, supportsHandoff).catch(() => {});
            }
          }
          const result = await continuation;
          if (binding.closed || binding.generation !== generation) return;
          binding.bootstrapPending = false;
          stopPolling(binding);
          connectionEvent(binding, { status: 'connected' }, result.actionRequired?.message);
        } catch (error) {
          if (!binding.closed && binding.generation === generation)
            notifyAction(binding, publicErrorCode(error));
        } finally {
          if (binding.continuingGeneration === generation) binding.continuingGeneration = undefined;
        }
      })();
      return;
    }
    if (message.kind === 'binding-error') {
      notifyAction(binding, publicErrorCode(message));
      return;
    }
    if (message.kind === 'request' && !binding.requests.has(message.requestId)) {
      if (binding.requests.size >= 100) {
        const retired = [...binding.requests.entries()].find(([, request]) => request.terminal);
        if (!retired) {
          notifyAction(binding, 'CAPACITY_EXCEEDED');
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
      state.actionPending = false;
      const reason = queueWaitReason(message.reason);
      binding.callbacks.onQueue?.({
        requestId: message.requestId,
        status: message.status,
        ...(reason ? { reason } : {}),
        message: state.terminal ? copy.cancelled : copy[reason ?? 'queued'],
      });
      return;
    }
    if (message.kind === 'error') {
      if (message.terminal === true) state.terminal = true;
      else state.actionPending = true;
      notifyAction(binding, publicErrorCode(message), message.requestId);
      return;
    }
    if (
      message.kind !== 'status' ||
      !message.receipt ||
      message.receipt.receiptRevision < state.revision
    )
      return;
    const receipt = describeReceipt(message.receipt);
    state.launchId = receipt.launchId;
    state.terminal =
      receipt.execution?.executionSettled === true ||
      ['cancelled', 'expired', 'rejected'].includes(receipt.request?.status);
    const changed = receipt.receiptRevision > state.revision || state.actionPending;
    state.actionPending = false;
    state.revision = receipt.receiptRevision;
    if (changed) binding.callbacks.onStatus?.(receipt);
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
        !bridgeOwnsClick(value) &&
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
      ...(binding.connectionWaitStatus ? { connectionWaitStatus: true } : {}),
    });
    connectionEvent(binding, { status: 'awaiting-consent' });
    void request.then(
      result => {
        if (binding.closed) {
          if (result.connectionPending?.pendingId)
            void external('cancel', { pendingId: result.connectionPending.pendingId }).catch(() => {});
          return;
        }
        if (!binding.bootstrapPending || binding.generation !== generation) return;
        connectionEvent(binding, result.connectionPending);
        if (result.connectionPending?.status === 'waiting-for-connection') {
          binding.bootstrapPending = false;
          return;
        }
        pollConnection(binding);
      },
      error => {
        if (binding.closed || !binding.bootstrapPending || binding.generation !== generation)
          return;
        if (error.definitive) {
          binding.bootstrapPending = false;
          connectionEvent(binding, { status: 'rejected', code: error.code }, error.message);
        } else pollConnection(binding);
        notifyAction(binding, error.code);
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
          binding.connectionWaitStatus = probe.connectionWaitStatus === true;
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
            if (binding.registration) await binding.registration.promise.catch(() => {});
            if (binding.closed) throw failure('EXPIRED');
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
          if (binding.registration) await binding.registration.promise.catch(() => {});
          if (!binding.bootstrap) await call(id, 'unbind');
        },
      });
    },
  });
}
