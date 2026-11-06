import {
  BIND_ATTRIBUTE,
  WEB_BRIDGE,
  normalizeInput,
  randomIdentifier,
  publicErrorCode,
} from './web-launch-security.js';

export function createChromeAssistant({
  window: view = window,
  document: doc = document,
  cryptoApi = crypto,
} = {}) {
  const pending = new Map();
  const bindings = new Map();
  const origin = view.location.origin;
  const failure = code => Object.assign(new Error(code), { code });
  function call(bindingId, kind, extra = {}) {
    const correlationId = randomIdentifier(cryptoApi);
    return new Promise((resolve, reject) => {
      const timer = view.setTimeout(() => {
        pending.delete(correlationId);
        reject(failure('BRIDGE_UNAVAILABLE'));
      }, 5000);
      pending.set(correlationId, { resolve, reject, timer });
      view.postMessage(
        { bridge: WEB_BRIDGE, direction: 'page', correlationId, bindingId, kind, ...extra },
        origin,
      );
    });
  }
  function closeBinding(binding) {
    binding.closed = true;
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
        for (const request of binding.requests.values()) request.closed = true;
        binding.requests.clear();
      }
      return;
    }
    const binding = bindings.get(message.bindingId);
    if (!binding || binding.closed) return;
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
      const binding = { id, button, callbacks, requests: new Map(), revision: 1, closed: false };
      bindings.set(id, binding);
      button.setAttribute(BIND_ATTRIBUTE, id);
      try {
        await call(id, 'bind', { bindingRevision: 1, input: normalizeInput(options) });
      } catch (error) {
        closeBinding(binding);
        if (button.getAttribute(BIND_ATTRIBUTE) === id) button.removeAttribute(BIND_ATTRIBUTE);
        throw error;
      }
      return Object.freeze({
        async update(input) {
          if (binding.closed || !normalizeInput(input)) throw failure('INVALID_REQUEST');
          const disabled = button.disabled;
          button.disabled = true;
          try {
            await call(id, 'update', {
              bindingRevision: ++binding.revision,
              input: normalizeInput(input),
            });
          } finally {
            button.disabled = disabled;
          }
        },
        async unbind() {
          if (binding.closed) return;
          closeBinding(binding);
          await call(id, 'unbind');
        },
      });
    },
  });
}
