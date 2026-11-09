import {
  BIND_ATTRIBUTE,
  WEB_BRIDGE,
  WEB_CONNECTION,
  inputDigest,
  normalizeInput,
  randomIdentifier,
  publicErrorCode,
} from './web-launch-security.js';

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
  const failure = code => Object.assign(new Error(code), { code });
  const externalAvailable = Boolean(extensionId && runtimeApi?.sendMessage);
  function external(op, extra = {}) {
    return new Promise((resolve, reject) => {
      const timer = view.setTimeout(() => reject(failure('BRIDGE_UNAVAILABLE')), 5000);
      let response;
      try {
        response = runtimeApi.sendMessage(extensionId, { type: WEB_CONNECTION, op, ...extra });
      } catch (error) {
        view.clearTimeout(timer);
        reject(error);
        return;
      }
      Promise.resolve(response).then(
        value => {
          view.clearTimeout(timer);
          if (value?.ok) resolve(value);
          else reject(failure(publicErrorCode(value)));
        },
        error => {
          view.clearTimeout(timer);
          reject(failure(publicErrorCode(error)));
        },
      );
    });
  }
  function connectionEvent(binding, value) {
    if (binding.closed) return;
    if (value?.pendingId) binding.connectionId = value.pendingId;
    const status =
      { 'awaiting-consent': 'pending', cancelled: 'rejected' }[value.status] ?? value.status;
    const event = { status, origin, ...(value.code ? { code: value.code } : {}) };
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
    if (message.kind === 'error') {
      binding.callbacks.onError?.(failure(publicErrorCode(message)));
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
        if (error.code === 'PANEL_OPEN_FAILED' || error.code === 'WINDOW_BUSY') {
          binding.bootstrapPending = false;
          connectionEvent(binding, { status: 'rejected', code: error.code });
        } else pollConnection(binding);
        binding.callbacks.onError?.(failure(publicErrorCode(error)));
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
