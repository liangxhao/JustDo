import {
  BIND_ATTRIBUTE,
  WEB_BRIDGE,
  WEB_RUNTIME,
  inputDigest,
  normalizeInput,
  randomIdentifier,
  publicErrorCode,
  validIdentifier,
} from './web-launch-security.js';

/** Isolated-world owner. Page scripts never receive document leases or runtime credentials. */
export function installWebLaunchContent({
  window: view = window,
  document: doc = document,
  chromeApi = chrome,
  cryptoApi = crypto,
} = {}) {
  if (view !== view.top || !['http:', 'https:'].includes(view.location.protocol)) return null;
  const bindings = new Map();
  const requests = new Map();
  const continuations = new Map();
  let documentNonce = randomIdentifier(cryptoApi);
  let documentLeaseId;
  let sequence = 0;
  let terminated = false;
  let polling = false;
  const origin = view.location.origin;
  const post = message =>
    view.postMessage({ bridge: WEB_BRIDGE, direction: 'extension', ...message }, origin);
  const reply = (message, result) =>
    post({ kind: 'reply', correlationId: message.correlationId, ...result });
  const send = message => {
    try {
      return Promise.resolve(chromeApi.runtime.sendMessage({ ...message, documentNonce }));
    } catch (error) {
      return Promise.reject(error);
    }
  };

  async function register(message) {
    const registrationNonce = documentNonce;
    const previous = bindings.get(message.bindingId);
    if (
      message.kind === 'update' &&
      (!previous || message.bindingRevision !== previous.revision + 1)
    )
      throw { code: 'REQUEST_CONFLICT' };
    if (
      message.kind === 'bind' &&
      (previous ||
        bindings.size >= 64 ||
        !Number.isSafeInteger(message.bindingRevision) ||
        message.bindingRevision < 1)
    )
      throw { code: 'INVALID_REQUEST' };
    if (previous) previous.ready = false;
    const admission = await send({ type: `${WEB_RUNTIME}hello` });
    if (terminated || documentNonce !== registrationNonce) throw { code: 'EXPIRED' };
    if (!admission?.ok) throw { code: 'SITE_NOT_ALLOWED' };
    const input = normalizeInput(message.input);
    if (!input) throw { code: 'INVALID_REQUEST' };
    const element =
      previous?.element ??
      [...doc.querySelectorAll(`button[${BIND_ATTRIBUTE}]`)].find(
        node => node.getAttribute(BIND_ATTRIBUTE) === message.bindingId,
      );
    if (
      !element ||
      element.ownerDocument !== doc ||
      !element.isConnected ||
      element.getRootNode() !== doc ||
      element.type !== 'button'
    )
      throw { code: 'INVALID_REQUEST' };
    if ([...bindings.values()].some(binding => binding !== previous && binding.element === element))
      throw { code: 'REQUEST_CONFLICT' };
    element.removeAttribute(BIND_ATTRIBUTE);
    const binding = { element, input, revision: message.bindingRevision, ready: false };
    bindings.set(message.bindingId, binding);
    const digest = cryptoApi.subtle
      ? await inputDigest(input, cryptoApi)
      : (await send({ type: `${WEB_RUNTIME}digest`, input })).digest;
    if (!/^[a-f0-9]{64}$/u.test(digest ?? '')) throw { code: 'BRIDGE_UNAVAILABLE' };
    if (
      terminated ||
      documentNonce !== registrationNonce ||
      bindings.get(message.bindingId) !== binding ||
      !element.isConnected
    )
      throw { code: 'EXPIRED' };
    binding.digest = digest;
    binding.ready = true;
    reply(message, { ok: true, bindingRevision: binding.revision });
  }

  function acceptResponse(request, response) {
    if (terminated || !requests.has(request.requestId) || !bindings.has(request.bindingId)) return;
    if (response?.documentLeaseId !== undefined)
      documentLeaseId = response.documentLeaseId ?? undefined;
    if (!response?.ok) {
      post({
        kind: 'error',
        bindingId: request.bindingId,
        requestId: request.requestId,
        code: publicErrorCode(response),
      });
      if (['SITE_NOT_ALLOWED', 'PERMISSION_REQUIRED'].includes(response?.code)) {
        bindings.clear();
        requests.clear();
        continuations.clear();
        documentLeaseId = undefined;
        documentNonce = randomIdentifier(cryptoApi);
        post({ kind: 'lease-retired', reconnectRequired: true });
      }
      return;
    }
    if (response.receipt) {
      request.launchId = response.receipt.launchId;
      request.receipt = response.receipt;
      post({
        kind: 'status',
        bindingId: request.bindingId,
        requestId: request.requestId,
        receipt: response.receipt,
      });
    }
  }

  function handleClick(event) {
    if (
      terminated ||
      !event.isTrusted ||
      !view.navigator.userActivation?.isActive ||
      doc.prerendering
    )
      return;
    const match = [...bindings.entries()].find(
      ([, binding]) => binding.ready && event.composedPath().includes(binding.element),
    );
    if (!match) return;
    const [bindingId, binding] = match;
    launchRequest(bindingId, binding);
  }

  function launchRequest(bindingId, binding, continuation) {
    if (requests.size >= 100) {
      const retired = [...requests.entries()].find(
        ([, request]) =>
          request.receipt?.execution.executionSettled === true ||
          ['cancelled', 'expired', 'rejected'].includes(request.receipt?.request.status),
      );
      if (retired) requests.delete(retired[0]);
      else {
        post({ kind: 'binding-error', bindingId, code: 'CAPACITY_EXCEEDED' });
        return;
      }
    }
    if (
      !binding.element.isConnected ||
      binding.element.ownerDocument !== doc ||
      binding.element.getRootNode() !== doc ||
      (!continuation && binding.element.disabled) ||
      binding.element.type !== 'button' ||
      sequence >= Number.MAX_SAFE_INTEGER
    )
      return;
    const requestId = randomIdentifier(cryptoApi);
    const request = {
      requestId,
      bindingId,
      bindingRevision: binding.revision,
      result: binding.input.result,
    };
    requests.set(requestId, request);
    post({ kind: 'request', bindingId, requestId, bindingRevision: binding.revision });
    // Keep this call on the real click stack. No digest, storage or permission await here.
    const operation = send({
      type: `${WEB_RUNTIME}${continuation ? 'connection-launch' : 'launch'}`,
      ...(continuation ? { pendingId: continuation.pendingId, bindingId } : {}),
      requestId,
      bindingRevision: binding.revision,
      clickSequence: ++sequence,
      payloadDigest: binding.digest,
      input: binding.input,
      documentLeaseId,
      title: doc.title,
    });
    void Promise.resolve(operation).then(
      response => acceptResponse(request, response),
      error => acceptResponse(request, { ok: false, code: publicErrorCode(error) }),
    );
    return operation;
  }

  async function handleMessage(event) {
    const message = event.data;
    if (
      terminated ||
      event.source !== view ||
      event.origin !== origin ||
      message?.bridge !== WEB_BRIDGE ||
      message.direction !== 'page' ||
      !validIdentifier(message.correlationId) ||
      !validIdentifier(message.bindingId)
    )
      return;
    try {
      if (message.kind === 'ping') {
        reply(message, { ok: true });
        return;
      }
      if (['bind', 'update'].includes(message.kind)) {
        await register(message);
        return;
      }
      const binding = bindings.get(message.bindingId);
      if (!binding) throw { code: 'EXPIRED' };
      if (message.kind === 'continue') {
        const continuation = continuations.get(message.pendingId);
        if (
          !continuation ||
          continuation.bindingId !== message.bindingId ||
          continuation.bindingRevision !== binding.revision ||
          continuation.payloadDigest !== binding.digest ||
          continuation.expiresAt <= Date.now() ||
          !binding.ready
        )
          throw { code: 'EXPIRED' };
        continuations.delete(message.pendingId);
        const response = await launchRequest(message.bindingId, binding, continuation);
        reply(
          message,
          response?.ok ? { ok: true } : { ok: false, code: publicErrorCode(response) },
        );
        return;
      }
      if (message.kind === 'unbind') {
        bindings.delete(message.bindingId);
        for (const [id, value] of continuations)
          if (value.bindingId === message.bindingId) continuations.delete(id);
        for (const [id, request] of requests) {
          if (request.bindingId !== message.bindingId) continue;
          requests.delete(id);
          void send({
            type: `${WEB_RUNTIME}cancel`,
            requestId: id,
            launchId: request.launchId,
            documentLeaseId,
          }).catch(() => {});
        }
        reply(message, { ok: true });
        return;
      }
      const request = requests.get(message.requestId);
      if (
        !request ||
        request.bindingId !== message.bindingId ||
        !['read', 'cancel'].includes(message.kind)
      )
        throw { code: 'INVALID_REQUEST' };
      const response = await send({
        type: `${WEB_RUNTIME}${message.kind}`,
        requestId: request.requestId,
        launchId: request.launchId,
        documentLeaseId,
        result: request.result,
      });
      acceptResponse(request, response);
      reply(
        message,
        response?.ok
          ? { ok: true, receipt: response.receipt }
          : { ok: false, code: publicErrorCode(response) },
      );
    } catch (error) {
      reply(message, { ok: false, code: publicErrorCode(error) });
    }
  }

  async function poll() {
    if (polling || terminated) return;
    polling = true;
    try {
      for (const request of requests.values()) {
        if (request.receipt?.delivery.status === 'revoked') continue;
        if (
          request.receipt?.execution.executionSettled === true &&
          !['pending', 'awaiting-consent'].includes(request.receipt.output.status)
        )
          continue;
        try {
          acceptResponse(
            request,
            await send({
              type: `${WEB_RUNTIME}read`,
              requestId: request.requestId,
              launchId: request.launchId,
              documentLeaseId,
              result: request.result,
            }),
          );
        } catch {
          /* Observation never resends input. */
        }
      }
    } finally {
      polling = false;
    }
  }
  const timer = view.setInterval(() => {
    void poll();
  }, 3000);
  function pagehide() {
    terminated = true;
    bindings.clear();
    continuations.clear();
    requests.clear();
    void send({ type: `${WEB_RUNTIME}revoke`, documentLeaseId, reason: 'pagehide' }).catch(
      () => {},
    );
    documentLeaseId = undefined;
  }
  function pageshow(event) {
    if (event.persisted) {
      documentNonce = randomIdentifier(cryptoApi);
      terminated = false;
    }
  }
  const probe = (message, sender, reply) => {
    if (sender?.id === chromeApi.runtime.id && message?.type === `${WEB_RUNTIME}connection-ready`) {
      if (
        terminated ||
        !validIdentifier(message.pendingId) ||
        !validIdentifier(message.bindingId) ||
        !Number.isSafeInteger(message.bindingRevision) ||
        !/^[a-f0-9]{64}$/u.test(message.payloadDigest ?? '') ||
        message.expiresAt <= Date.now() ||
        continuations.size >= 64
      ) {
        reply({ ok: false });
        return false;
      }
      const value = {
        pendingId: message.pendingId,
        bindingId: message.bindingId,
        bindingRevision: message.bindingRevision,
        payloadDigest: message.payloadDigest,
        expiresAt: message.expiresAt,
      };
      continuations.set(value.pendingId, value);
      post({ kind: 'connection-ready', ...value });
      reply({ ok: true });
      return false;
    }
    if (
      sender?.id === chromeApi.runtime.id &&
      message?.type === `${WEB_RUNTIME}retire` &&
      message.documentNonce === documentNonce
    ) {
      requests.clear();
      continuations.clear();
      if (message.reconnectRequired === true) bindings.clear();
      documentLeaseId = undefined;
      documentNonce = randomIdentifier(cryptoApi);
      post({ kind: 'lease-retired', reconnectRequired: message.reconnectRequired === true });
      reply({ ok: true });
      return false;
    }
    if (
      sender?.id !== chromeApi.runtime.id ||
      message?.type !== `${WEB_RUNTIME}probe` ||
      message.documentNonce !== documentNonce
    )
      return false;
    reply({ active: !terminated && !doc.prerendering, documentNonce });
    return false;
  };
  chromeApi.runtime.onMessage.addListener(probe);
  view.addEventListener('message', handleMessage);
  doc.addEventListener('click', handleClick, true);
  view.addEventListener('pagehide', pagehide);
  view.addEventListener('pageshow', pageshow);
  return {
    handleClick,
    dispose() {
      pagehide();
      view.clearInterval(timer);
      chromeApi.runtime.onMessage.removeListener(probe);
      view.removeEventListener('message', handleMessage);
      doc.removeEventListener('click', handleClick, true);
      view.removeEventListener('pagehide', pagehide);
      view.removeEventListener('pageshow', pageshow);
    },
  };
}
