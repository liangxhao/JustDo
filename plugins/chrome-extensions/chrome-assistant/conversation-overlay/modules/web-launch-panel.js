import { sidePanelText as t } from './sidepanel-i18n.js';

export const WebLaunchPanelMessage = {
  Register: 'web-launch:panel:register',
  State: 'web-launch:panel:state',
  Event: 'web-launch:panel:event',
  Revise: 'web-launch:launch:revise',
  Submit: 'web-launch:launch:submit',
  Cancel: 'web-launch:launch:cancel',
  Stop: 'web-launch:launch:stop',
  Abandon: 'web-launch:launch:abandon',
};
const SENT = new Set(['submitting', 'submitted']);
const CLOSED = new Set(['cancelled', 'expired', 'rejected']);
const noop = () => {};

/** Owns only the external composer presentation; Main remains the execution owner. */
export function createWebLaunchPanel({
  document,
  chrome = globalThis.chrome,
  readComposer,
  installComposer,
  refreshThread = async () => {},
  onReceipt = noop,
  onChange = noop,
  confirm = message => globalThis.confirm(message),
}) {
  const root = document.getElementById('webLaunchCard');
  if (!root || !chrome?.runtime?.sendMessage || !chrome?.windows?.getCurrent) {
    return {
      inputAssociated: () => false,
      ownsThread: () => false,
      blocked: () => false,
      edit: noop,
      publishState: noop,
      ready: noop,
      submit: async () => {},
      stop: async () => {},
      beforeSwitch: async () => true,
      dispose: noop,
    };
  }
  const panelInstanceId = crypto.randomUUID();
  let windowId;
  let current = null;
  let receipt = null;
  let disposed = false;
  let busy = false;
  let dirty = false;
  let inputVersion = 0;
  let revisePromise = null;
  let revisionError = false;
  let automaticDisarmed = false;
  let installing = false;
  let inputReleased = false;
  let initialized = false;
  let modelChanged = false;
  let actionPending = false;
  let cancellation = null;
  let lastState = '';
  let previousThread = '';
  let expiryTimer;
  const make = (tag, key, parent = root) => {
    const node = document.createElement(tag);
    if (key) node.textContent = t(key);
    parent.append(node);
    return node;
  };
  const title = make('strong', 'webLaunchTitle');
  const origin = make('p');
  origin.className = 'web-launch-origin';
  const status = make('p');
  status.setAttribute('role', 'status');
  const contextDetails = make('details');
  make('summary', 'webLaunchContext', contextDetails);
  const context = make('textarea', null, contextDetails);
  context.setAttribute('aria-label', t('webLaunchContext'));
  context.maxLength = 24000;
  const option = key => {
    const label = make('label');
    label.className = 'web-launch-choice';
    const input = make('input', null, label);
    input.type = 'checkbox';
    make('span', key, label);
    return { label, input };
  };
  const share = option('webLaunchShare');
  const warning = make('p', 'webLaunchShareHint');
  warning.className = 'web-launch-hint';
  const rememberSend = option('webLaunchRememberSend');
  const rememberResult = option('webLaunchRememberResult');
  const newTask = option('webLaunchUnknownConfirm');
  const error = make('p');
  error.className = 'error';
  error.setAttribute('role', 'alert');
  const actions = make('div');
  actions.className = 'web-launch-actions';
  const button = (key, action) => {
    const node = make('button', key, actions);
    node.type = 'button';
    node.addEventListener('click', () => void action());
    return node;
  };
  const submitButton = button('webLaunchSendOnly', () => submit('confirmed'));
  submitButton.className = 'primary';
  const cancelButton = button('webLaunchCancel', () => cancel(false));
  const ordinaryButton = button('webLaunchOrdinary', () => cancel(true));
  const stopButton = button('stop', stop);
  const abandonButton = button('webLaunchAbandon', abandon);
  const returnButton = button('webLaunchReturn', async () => {
    if (previousThread) await refreshThread(previousThread);
  });
  const inputAssociated = () =>
    Boolean(current && !inputReleased && !CLOSED.has(receipt?.request?.status));
  const ownsThread = threadId =>
    Boolean(
      current &&
      current.threadId === threadId &&
      !receipt?.execution?.executionSettled &&
      !CLOSED.has(receipt?.request?.status),
    );
  const actualInput = () => {
    const composer = readComposer();
    return {
      prompt: composer.prompt,
      ...(context.value ? { context: { text: context.value } } : {}),
      ...(modelChanged && composer.modelRef ? { modelRef: composer.modelRef } : {}),
      permissionMode: composer.permissionMode || 'ask',
    };
  };
  const fail = code => {
    error.textContent =
      t(`webLaunchError_${code}`) === `webLaunchError_${code}`
        ? t('webLaunchError_GENERIC')
        : t(`webLaunchError_${code}`);
  };
  const request = async (type, params = {}) => {
    const result = await chrome.runtime.sendMessage({
      type,
      panelInstanceId,
      windowId,
      ...params,
    });
    if (!result || result.ok === false)
      throw Object.assign(new Error('Web launch request failed'), {
        code: result?.code || 'GENERIC',
      });
    return result;
  };
  function render() {
    root.classList.toggle('hidden', !current);
    if (!current) {
      onChange();
      return;
    }
    origin.textContent = current.origin;
    const execution = receipt?.execution?.status;
    const requestStatus = receipt?.request?.status;
    const shareStatus = receipt?.output?.status;
    status.textContent = t(
      `webLaunchStatus_${execution === 'not-started' ? requestStatus : execution}`,
    );
    if (shareStatus === 'withheld') status.textContent += ` · ${t('webLaunchWithheld')}`;
    else if (
      current.result === 'final' &&
      ['pending', 'available', 'empty', 'unsupported', 'unavailable', 'awaiting-consent'].includes(
        shareStatus,
      )
    )
      status.textContent += ` · ${t(`webLaunchOutput_${shareStatus}`)}`;
    const associated = inputAssociated();
    const submitted = SENT.has(requestStatus) || (execution && execution !== 'not-started');
    contextDetails.hidden = !associated || (current.contextText === undefined && !context.value);
    context.disabled = !associated || submitted;
    share.label.hidden = !associated || current.result !== 'final';
    warning.hidden = share.label.hidden || !share.input.checked;
    rememberSend.label.hidden =
      !associated || current.mode !== 'send' || current.automaticSendAllowed;
    rememberResult.label.hidden =
      !associated || current.result !== 'final' || current.shareAllowed || !share.input.checked;
    newTask.label.hidden = !associated || !current.requiresUnknownConfirmation;
    submitButton.textContent = t(
      share.input.checked && current.result === 'final'
        ? 'webLaunchSendReturn'
        : 'webLaunchSendOnly',
    );
    submitButton.hidden = !associated || submitted;
    submitButton.disabled =
      busy ||
      dirty ||
      revisionError ||
      !readComposer().ready ||
      !readComposer().prompt.trim() ||
      (current.requiresUnknownConfirmation && !newTask.input.checked) ||
      Date.now() >= current.expiresAt;
    cancelButton.textContent = t(submitted ? 'webLaunchStopSharing' : 'webLaunchCancel');
    cancelButton.hidden = !associated && (current.result !== 'final' || shareStatus === 'withheld');
    cancelButton.disabled = actionPending;
    ordinaryButton.hidden = !associated || submitted;
    ordinaryButton.disabled = busy;
    stopButton.hidden =
      (!submitted && !busy) ||
      receipt?.execution?.executionSettled === true ||
      CLOSED.has(requestStatus);
    stopButton.disabled = actionPending;
    abandonButton.hidden = execution !== 'unknown';
    abandonButton.disabled = busy;
    returnButton.hidden = !previousThread;
    returnButton.disabled = associated;
    title.textContent = t('webLaunchTitle');
    onChange();
  }
  function acceptReceipt(response) {
    if (!current || disposed) return;
    const next = response.receipt;
    if (
      next &&
      next.launchId === current.launchId &&
      (!receipt || next.receiptRevision > receipt.receiptRevision)
    ) {
      receipt = next;
      current.receipt = next;
      if (response.internal?.requiresSendConfirmation !== undefined) {
        current.automaticSendAllowed = !response.internal.requiresSendConfirmation;
        if (response.internal.requiresSendConfirmation) automaticDisarmed = true;
      }
      if (response.internal?.requiresResultConsent !== undefined)
        current.shareAllowed =
          current.result === 'final' && !response.internal.requiresResultConsent;
      if (next.request.status === 'awaiting-confirmation') automaticDisarmed = true;
      if (next.error?.code) fail(next.error.code);
      if (response.internal?.composeRevision !== undefined)
        current.composeRevision = response.internal.composeRevision;
      if (response.internal?.deadlineAt) current.expiresAt = response.internal.deadlineAt;
      if (next.request.status === 'submitted' || next.execution.status === 'running') {
        const original = readComposer().prompt;
        inputReleased = true;
        if (!dirty && original === current.lastSubmittedPrompt)
          installComposer({ clearPrompt: true });
      }
      if (CLOSED.has(next.request.status)) inputReleased = true;
      onReceipt({ ...response, threadId: response.internal?.threadId || current.threadId });
      if (CLOSED.has(next.request.status) && cancellation?.launchId === next.launchId) {
        if (
          cancellation.hadInput &&
          !cancellation.keepText &&
          inputVersion === cancellation.inputVersion &&
          readComposer().prompt === cancellation.prompt
        )
          installComposer({ clearPrompt: true });
        cancellation = null;
        current = null;
        receipt = null;
      }
    }
    render();
  }
  async function publishState(force = false) {
    if (disposed || windowId === undefined) return;
    const composer = readComposer();
    try {
      const state = {
        composerBusy: Boolean(
          composer.prompt.trim() ||
          composer.attachments ||
          composer.attachmentReads ||
          busy ||
          inputAssociated(),
        ),
        ...(current
          ? { launchId: current.launchId, composeRevision: current.composeRevision }
          : {}),
        selectedThreadId: composer.threadId,
      };
      const signature = JSON.stringify(state);
      if (!force && signature === lastState) return;
      lastState = signature;
      await request(WebLaunchPanelMessage.State, state);
    } catch (failure) {
      lastState = '';
      if (failure.code === 'FORBIDDEN') await register();
    }
  }
  async function acceptEnvelope(envelope) {
    if (disposed || !envelope || envelope.launchId === current?.launchId) return;
    const composer = readComposer();
    const alreadyDispatched =
      SENT.has(envelope.receipt?.request?.status) ||
      (envelope.receipt?.execution?.status && envelope.receipt.execution.status !== 'not-started');
    if (alreadyDispatched) {
      current = { ...envelope };
      receipt = envelope.receipt;
      inputReleased = true;
      automaticDisarmed = true;
      render();
      return;
    }
    if (
      composer.prompt.trim() ||
      composer.attachments ||
      composer.attachmentReads ||
      busy ||
      inputAssociated()
    ) {
      await request(WebLaunchPanelMessage.Cancel, {
        launchId: envelope.launchId,
        reason: 'composer-busy',
      }).catch(() => {});
      fail('COMPOSER_BUSY');
      return;
    }
    current = { ...envelope };
    receipt = envelope.receipt;
    previousThread = composer.threadId;
    inputReleased = false;
    cancellation = null;
    dirty = false;
    revisionError = false;
    automaticDisarmed = envelope.restored === true;
    modelChanged = false;
    error.textContent = '';
    installing = true;
    context.value = envelope.contextText || '';
    share.input.checked = envelope.result === 'final';
    rememberSend.input.checked = false;
    rememberResult.input.checked = false;
    newTask.input.checked = false;
    installComposer({
      prompt: envelope.prompt,
      permissionMode: 'ask',
      includePage: false,
      threadId: envelope.threadId,
    });
    render();
    await refreshThread(envelope.threadId);
    installing = false;
    if (current?.launchId !== envelope.launchId || disposed) return;
    render();
    await publishState();
    clearTimeout(expiryTimer);
    expiryTimer = setTimeout(
      () => {
        if (!disposed) render();
      },
      Math.max(0, current.expiresAt - Date.now()) + 1,
    );
    if (current.restored === true) {
      automaticDisarmed = true;
      edit();
    } else await maybeAutomatic();
  }
  async function revise() {
    if (revisePromise || !current || !inputAssociated()) return revisePromise;
    const launchId = current.launchId;
    revisePromise = (async () => {
      while (dirty && current?.launchId === launchId && !disposed) {
        const version = inputVersion;
        const input = actualInput();
        try {
          const result = await request(WebLaunchPanelMessage.Revise, {
            launchId,
            expectedComposeRevision: current.composeRevision,
            input,
            shareResult: current.result === 'final' && share.input.checked,
          });
          if (current?.launchId !== launchId || disposed) return;
          if (result.internal?.composeRevision !== undefined)
            current.composeRevision = result.internal.composeRevision;
          dirty = version !== inputVersion;
          revisionError = false;
          acceptReceipt(result);
        } catch (failure) {
          if (current?.launchId !== launchId || disposed) return;
          revisionError = true;
          fail(failure.code);
          break;
        }
      }
    })().finally(() => {
      revisePromise = null;
      render();
      void publishState();
    });
    return revisePromise;
  }
  function edit(field) {
    if (field === 'model') modelChanged = true;
    if (installing || !inputAssociated() || disposed) return;
    automaticDisarmed = true;
    dirty = true;
    inputVersion += 1;
    revisionError = false;
    render();
    void revise();
  }
  async function maybeAutomatic() {
    if (
      !initialized ||
      installing ||
      !current ||
      current.mode !== 'send' ||
      !current.automaticSendAllowed ||
      (current.result === 'final' && !current.shareAllowed) ||
      current.requiresUnknownConfirmation ||
      automaticDisarmed ||
      dirty ||
      busy ||
      !readComposer().ready ||
      !inputAssociated()
    )
      return;
    await submit('automatic');
  }
  async function submit(submission = 'confirmed') {
    if (
      !inputAssociated() ||
      SENT.has(receipt?.request?.status) ||
      busy ||
      dirty ||
      revisionError ||
      !readComposer().ready ||
      !readComposer().prompt.trim() ||
      Date.now() >= current.expiresAt ||
      (current.requiresUnknownConfirmation && !newTask.input.checked)
    )
      return;
    if (
      submission === 'automatic' &&
      (automaticDisarmed ||
        current.mode !== 'send' ||
        !current.automaticSendAllowed ||
        (current.result === 'final' && !current.shareAllowed))
    )
      return;
    const launchId = current.launchId;
    const input = actualInput();
    current.lastSubmittedPrompt = input.prompt;
    busy = true;
    error.textContent = '';
    render();
    try {
      const result = await request(WebLaunchPanelMessage.Submit, {
        launchId,
        composeRevision: current.composeRevision,
        input,
        submission,
        shareResult: current.result === 'final' && share.input.checked,
        rememberSend: submission === 'confirmed' && rememberSend.input.checked,
        rememberResult:
          submission === 'confirmed' && share.input.checked && rememberResult.input.checked,
        confirmNewTask: newTask.input.checked,
      });
      if (current?.launchId !== launchId || disposed) return;
      acceptReceipt(result);
      await refreshThread(current.threadId);
    } catch (failure) {
      if (current?.launchId === launchId && !disposed) {
        automaticDisarmed = true;
        fail(failure.code);
      }
    } finally {
      busy = false;
      render();
      void publishState();
    }
  }
  async function cancel(keepText) {
    if (!current || actionPending) return;
    const launchId = current.launchId;
    const cancellingPrompt = readComposer().prompt;
    const hadInput = inputAssociated();
    cancellation = { launchId, keepText, hadInput, prompt: cancellingPrompt, inputVersion };
    actionPending = true;
    automaticDisarmed = true;
    render();
    try {
      const result = await request(WebLaunchPanelMessage.Cancel, {
        launchId,
        reason: keepText ? 'detached' : 'cancelled',
      });
      if (disposed || current?.launchId !== launchId) return;
      acceptReceipt(result);
      if (
        CLOSED.has(result.receipt?.request?.status) ||
        result.receipt?.execution?.executionSettled === true
      ) {
        inputReleased = true;
        current = null;
        receipt = null;
      }
    } catch (failure) {
      fail(failure.code);
    } finally {
      actionPending = false;
      render();
      void publishState();
    }
  }
  async function stop() {
    if (!current) return;
    try {
      acceptReceipt(await request(WebLaunchPanelMessage.Stop, { launchId: current.launchId }));
    } catch (failure) {
      fail(failure.code);
    }
  }
  async function abandon() {
    if (!current || !confirm(t('webLaunchAbandonConfirm'))) return;
    try {
      const result = await request(WebLaunchPanelMessage.Abandon, {
        launchId: current.launchId,
        confirm: true,
      });
      acceptReceipt(result);
      inputReleased = true;
      current = null;
      receipt = null;
      render();
      void publishState();
    } catch (failure) {
      fail(failure.code);
    }
  }
  share.input.addEventListener('change', edit);
  context.addEventListener('input', edit);
  newTask.input.addEventListener('change', render);
  const listener = (message, sender) => {
    if (
      chrome.runtime.id &&
      (sender?.id !== chrome.runtime.id ||
        sender.tab ||
        (sender.url && sender.url !== chrome.runtime.getURL('background.js')))
    )
      return;
    if (
      message?.type !== WebLaunchPanelMessage.Event ||
      message.panelInstanceId !== panelInstanceId ||
      message.windowId !== windowId ||
      disposed
    )
      return;
    if (message.envelope && message.envelope.launchId !== current?.launchId)
      void acceptEnvelope(message.envelope);
    else if (message.receipt) acceptReceipt(message);
    else if (message.code) fail(message.code);
  };
  chrome.runtime.onMessage?.addListener(listener);
  async function register() {
    try {
      const window = await chrome.windows.getCurrent();
      if (disposed) return;
      windowId = window.id;
      const composer = readComposer();
      const result = await request(WebLaunchPanelMessage.Register, {
        composerBusy: Boolean(
          composer.prompt.trim() || composer.attachments || composer.attachmentReads,
        ),
      });
      initialized = true;
      if (result.envelope) await acceptEnvelope(result.envelope);
    } catch {
      /* Ordinary extension chat remains available when this bridge is unavailable. */
    }
  }
  void register();
  const heartbeat = setInterval(() => void publishState(true), 3000);
  return {
    inputAssociated,
    ownsThread,
    blocked: () => inputAssociated() && (dirty || busy || revisionError),
    edit,
    publishState,
    ready: () => {
      render();
      void maybeAutomatic();
    },
    submit,
    stop,
    beforeSwitch: async threadId => {
      if (!inputAssociated() || threadId === current.threadId) return true;
      if (!confirm(t('webLaunchSwitchConfirm'))) {
        installComposer({ threadId: current.threadId });
        return false;
      }
      await cancel(false);
      if (inputAssociated() && current) installComposer({ threadId: current.threadId });
      return !inputAssociated();
    },
    dispose: () => {
      disposed = true;
      clearTimeout(expiryTimer);
      clearInterval(heartbeat);
      chrome.runtime.onMessage?.removeListener(listener);
    },
  };
}
