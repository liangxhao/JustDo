import { sidePanelText as t } from './sidepanel-i18n.js';
import { createWebConnectionPanel } from './web-connection-panel.js';

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
  tabId,
  readComposer,
  installComposer,
  refreshThread = async () => {},
  onReceipt = noop,
  onChange = noop,
  onError = noop,
  onClearError = noop,
  isTurnSettled = () => false,
  confirm = message => globalThis.confirm(message),
}) {
  const root = document.getElementById('webLaunchControls');
  if (
    !root ||
    !Number.isSafeInteger(tabId) ||
    tabId < 0 ||
    !chrome?.runtime?.sendMessage ||
    !chrome?.tabs?.get
  ) {
    return {
      inputAssociated: () => false,
      ownsThread: () => false,
      composerAction: () => null,
      activity: () => null,
      updateSelection: noop,
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
  let registering = false;
  let tabScopeRevision = 0;
  let modelChanged = false;
  let actionPending = false;
  let stopPending = '';
  let submissionStartedAt;
  let cancellation = null;
  let lastState = '';
  let expiryTimer;
  let connectionVersion = 0;
  let visibleLaunch = '';
  const make = (tag, key, parent = root) => {
    const node = document.createElement(tag);
    if (key) node.textContent = t(key);
    parent.append(node);
    return node;
  };
  const recipient = make('p');
  const contextDetails = make('details');
  make('summary', 'webLaunchContext', contextDetails);
  const context = make('textarea', null, contextDetails);
  context.setAttribute('aria-label', t('webLaunchContext'));
  context.maxLength = 24000;
  const newTaskLabel = make('label');
  newTaskLabel.className = 'web-launch-choice';
  const newTask = make('input', null, newTaskLabel);
  newTask.type = 'checkbox';
  make('span', 'webLaunchUnknownConfirm', newTaskLabel);
  const actions = make('div');
  actions.className = 'web-launch-actions';
  const button = (key, action) => {
    const node = make('button', key, actions);
    node.type = 'button';
    node.addEventListener('click', () => void action());
    return node;
  };
  const ordinaryButton = button('webLaunchOrdinary', recoverDraft);
  const abandonButton = button('webLaunchAbandon', abandon);
  const inputAssociated = () => Boolean(current && !inputReleased);
  const closed = () => CLOSED.has(receipt?.request?.status);
  const draftUnavailable = () => closed() || Date.now() >= current.expiresAt;
  const ownsThread = threadId =>
    Boolean(
      current &&
      current.threadId === threadId &&
      !(current.clientTurnId && isTurnSettled(threadId, current.clientTurnId)) &&
      !receipt?.execution?.executionSettled &&
      !closed(),
    );
  const selected = () => Boolean(current && readComposer().threadId === current.threadId);
  const submitted = () =>
    SENT.has(receipt?.request?.status) ||
    Boolean(receipt?.execution?.status && receipt.execution.status !== 'not-started');
  const canSubmit = () => {
    const composer = readComposer();
    return Boolean(
      selected() &&
      inputAssociated() &&
      !draftUnavailable() &&
      !submitted() &&
      !busy &&
      !installing &&
      !actionPending &&
      !dirty &&
      !revisionError &&
      composer.ready &&
      composer.prompt.trim() &&
      (!current.requiresUnknownConfirmation || newTask.checked),
    );
  };
  function composerAction(threadId, turnId) {
    if (!current || current.threadId !== threadId) return null;
    if (turnId && current.clientTurnId !== turnId) return null;
    if (ownsThread(threadId) && (busy || submitted()))
      return { type: 'stop', disabled: actionPending || stopPending === current.launchId };
    if (inputAssociated())
      return {
        type: 'send',
        disabled: !canSubmit(),
        label: current.result === 'final' ? 'webLaunchSendReturn' : 'webLaunchSendOnly',
      };
    return null;
  }
  function activity(threadId, turnId) {
    if (composerAction(threadId, turnId)?.type !== 'stop') return null;
    if (stopPending === current.launchId)
      return { stage: 'stopping', startedAt: submissionStartedAt };
    if (receipt?.execution?.status === 'unknown')
      return { stage: 'checking', startedAt: submissionStartedAt };
    if (busy || receipt?.request?.status === 'submitting')
      return { stage: 'sending', startedAt: submissionStartedAt };
    return null;
  }
  const actualInput = () => {
    const composer = readComposer();
    return {
      prompt: composer.prompt,
      ...(context.value ? { context: { text: context.value } } : {}),
      ...(modelChanged && composer.modelRef ? { modelRef: composer.modelRef } : {}),
      permissionMode: composer.permissionMode || 'ask',
    };
  };
  const fail = (code, launchId = current?.launchId) => {
    if (disposed || (launchId && (launchId !== current?.launchId || !selected()))) return;
    onError(
      t(`webLaunchError_${code}`) === `webLaunchError_${code}`
        ? t('webLaunchError_GENERIC')
        : t(`webLaunchError_${code}`),
    );
  };
  const request = async (type, params = {}) => {
    const result = await chrome.runtime.sendMessage({
      type,
      panelInstanceId,
      tabId,
      windowId,
      ...params,
    });
    if (!result || result.ok === false)
      throw Object.assign(new Error('Web launch request failed'), {
        code: result?.code || 'GENERIC',
      });
    return result;
  };
  const connection = createWebConnectionPanel({ document, chrome, request, onNotice: onError });
  function updateSelection() {
    const show = selected();
    const draft = show && inputAssociated() && !submitted() && !busy;
    const editable = draft && !draftUnavailable();
    const canRecover = draft && !editable;
    const canAbandon = show && receipt?.execution?.status === 'unknown';
    const showRecipient = editable && current.result === 'final';
    const showContext = editable && current.contextText !== undefined;
    const showUnknownConfirmation = editable && current.requiresUnknownConfirmation;
    const launch = show ? current.launchId : '';
    if (launch !== visibleLaunch || !showContext) contextDetails.open = false;
    visibleLaunch = launch;
    root.hidden = !(
      showRecipient ||
      showContext ||
      showUnknownConfirmation ||
      canRecover ||
      canAbandon
    );
    recipient.hidden = !showRecipient;
    recipient.textContent = showRecipient
      ? t('webLaunchReturningTo', { origin: current.origin })
      : '';
    contextDetails.hidden = !showContext;
    context.disabled = !editable;
    newTaskLabel.hidden = !showUnknownConfirmation;
    actions.hidden = !(canRecover || canAbandon);
    ordinaryButton.hidden = !canRecover;
    ordinaryButton.disabled = actionPending;
    abandonButton.hidden = !canAbandon;
    abandonButton.disabled = busy || actionPending;
  }
  function render() {
    updateSelection();
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
      if (response.internal?.clientTurnId) current.clientTurnId = response.internal.clientTurnId;
      if (response.internal?.requiresSendConfirmation !== undefined) {
        current.automaticSendAllowed = !response.internal.requiresSendConfirmation;
        if (response.internal.requiresSendConfirmation) automaticDisarmed = true;
      }
      if (response.internal?.requiresResultConsent !== undefined)
        current.shareAllowed =
          current.result === 'final' && !response.internal.requiresResultConsent;
      if (next.request.status === 'awaiting-confirmation') automaticDisarmed = true;
      const intentionalCancel =
        next.error?.code === 'CANCELLED' &&
        (cancellation?.launchId === next.launchId || stopPending === next.launchId);
      if (next.error?.code && !intentionalCancel) fail(next.error.code);
      if (response.internal?.composeRevision !== undefined)
        current.composeRevision = response.internal.composeRevision;
      if (response.internal?.deadlineAt) current.expiresAt = response.internal.deadlineAt;
      if (next.request.status === 'submitted' || next.execution.status === 'running') {
        const original = readComposer().prompt;
        inputReleased = true;
        if (selected() && !dirty && original === current.lastSubmittedPrompt)
          installComposer({ clearPrompt: true });
      }
      onReceipt({ ...response, threadId: response.internal?.threadId || current.threadId });
      if (CLOSED.has(next.request.status) && cancellation?.launchId === next.launchId) {
        if (
          cancellation.hadInput &&
          selected() &&
          !cancellation.keepText &&
          inputVersion === cancellation.inputVersion &&
          readComposer().prompt === cancellation.prompt
        )
          installComposer({ clearPrompt: true });
        inputReleased = true;
        cancellation = null;
        current = null;
        receipt = null;
      }
    }
    render();
  }
  async function publishState(force = false) {
    if (disposed || registering || windowId === undefined) return;
    const composer = readComposer();
    try {
      const state = {
        composerBusy: Boolean(
          composer.prompt.trim() ||
          composer.attachments ||
          composer.attachmentReads ||
          composer.busy ||
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
  async function acceptEnvelope(envelope, internal) {
    if (disposed || !envelope || envelope.launchId === current?.launchId) return;
    const composer = readComposer();
    const alreadyDispatched =
      SENT.has(envelope.receipt?.request?.status) ||
      (envelope.receipt?.execution?.status && envelope.receipt.execution.status !== 'not-started');
    if (alreadyDispatched) {
      if (inputAssociated()) return;
      current = { ...envelope, clientTurnId: internal?.clientTurnId };
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
      composer.busy ||
      busy ||
      inputAssociated()
    ) {
      await request(WebLaunchPanelMessage.Cancel, {
        launchId: envelope.launchId,
        reason: 'composer-busy',
      }).catch(() => {});
      fail('COMPOSER_BUSY', null);
      return;
    }
    current = { ...envelope };
    receipt = envelope.receipt;
    submissionStartedAt = undefined;
    inputReleased = false;
    cancellation = null;
    dirty = false;
    revisionError = false;
    automaticDisarmed = envelope.restored === true;
    modelChanged = false;
    onClearError();
    installing = true;
    context.value = envelope.contextText || '';
    newTask.checked = false;
    installComposer({
      prompt: envelope.prompt,
      permissionMode: 'ask',
      includePage: false,
      threadId: envelope.threadId,
    });
    render();
    await refreshThread(envelope.threadId);
    if (current?.launchId !== envelope.launchId || disposed) return;
    installing = false;
    render();
    await publishState();
    if (current?.launchId !== envelope.launchId || disposed) return;
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
      while (dirty && current?.launchId === launchId && selected() && !closed() && !disposed) {
        const version = inputVersion;
        const input = actualInput();
        try {
          const result = await request(WebLaunchPanelMessage.Revise, {
            launchId,
            expectedComposeRevision: current.composeRevision,
            input,
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
          fail(failure.code, launchId);
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
    if (installing || !selected() || !inputAssociated() || draftUnavailable() || disposed) return;
    if (field === 'model') modelChanged = true;
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
    if (!canSubmit()) return;
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
    submissionStartedAt = Date.now();
    busy = true;
    onClearError();
    render();
    try {
      const result = await request(WebLaunchPanelMessage.Submit, {
        launchId,
        composeRevision: current.composeRevision,
        input,
        submission,
        shareResult: current.result === 'final',
        confirmNewTask: newTask.checked,
      });
      if (current?.launchId !== launchId || disposed) return;
      acceptReceipt(result);
      if (selected() && !receipt?.error) await refreshThread(current.threadId);
    } catch (failure) {
      if (current?.launchId === launchId && !disposed) {
        automaticDisarmed = true;
        fail(failure.code, launchId);
      }
    } finally {
      busy = false;
      render();
      void publishState();
    }
  }
  function recoverDraft() {
    if (selected() && inputAssociated() && !submitted() && !busy && draftUnavailable())
      return cancel(true);
  }
  async function cancel(keepText) {
    if (!selected() || actionPending) return;
    if (closed()) {
      if (!inputAssociated()) return;
      if (!keepText) installComposer({ clearPrompt: true });
      inputReleased = true;
      current = null;
      receipt = null;
      onClearError();
      render();
      return;
    }
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
      fail(failure.code, launchId);
    } finally {
      actionPending = false;
      render();
      void publishState();
    }
  }
  async function stop(turnId) {
    const action = composerAction(readComposer().threadId, turnId);
    if (action?.type !== 'stop' || action.disabled) return;
    const launchId = current.launchId;
    stopPending = launchId;
    render();
    try {
      acceptReceipt(await request(WebLaunchPanelMessage.Stop, { launchId }));
    } catch (failure) {
      fail(failure.code, launchId);
    } finally {
      if (stopPending === launchId) {
        stopPending = '';
        render();
      }
    }
  }
  async function abandon() {
    if (
      !selected() ||
      receipt?.execution?.status !== 'unknown' ||
      actionPending ||
      !confirm(t('webLaunchAbandonConfirm'))
    )
      return;
    const launchId = current.launchId;
    actionPending = true;
    render();
    try {
      const result = await request(WebLaunchPanelMessage.Abandon, {
        launchId,
        confirm: true,
      });
      if (disposed || current?.launchId !== launchId) return;
      acceptReceipt(result);
      inputReleased = true;
      current = null;
      receipt = null;
    } catch (failure) {
      fail(failure.code, launchId);
    } finally {
      actionPending = false;
      render();
      void publishState();
    }
  }
  context.addEventListener('input', edit);
  newTask.addEventListener('change', render);
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
      message.tabId !== tabId ||
      message.windowId !== windowId ||
      disposed
    )
      return;
    if (Object.hasOwn(message, 'connectionPending')) {
      connectionVersion += 1;
      connection.accept(message.connectionPending);
    }
    if (message.envelope && message.envelope.launchId !== current?.launchId)
      void acceptEnvelope(message.envelope, message.internal);
    else if (message.receipt) acceptReceipt(message);
    else if (message.code) fail(message.code, message.launchId ?? null);
  };
  chrome.runtime.onMessage?.addListener(listener);
  function leaveWindow() {
    connection.accept(null);
    clearTimeout(expiryTimer);
    if (inputAssociated()) {
      const attempted = current.lastSubmittedPrompt;
      if (attempted !== undefined) {
        if (selected() && readComposer().prompt === attempted)
          installComposer({ clearPrompt: true });
        onError(t('unknownSend'));
      } else if (!submitted()) {
        onError(t('webLaunchMovedDraft'));
      }
    }
    current = null;
    receipt = null;
    cancellation = null;
    installing = false;
    initialized = false;
    render();
  }
  function onTabDetached(id) {
    if (id !== tabId) return;
    tabScopeRevision += 1;
    windowId = undefined;
    registering = false;
    leaveWindow();
  }
  function onTabAttached(id) {
    if (id === tabId) void register();
  }
  chrome.tabs.onDetached?.addListener(onTabDetached);
  chrome.tabs.onAttached?.addListener(onTabAttached);

  async function register() {
    if (registering || disposed) return;
    registering = true;
    const scopeRevision = tabScopeRevision;
    let registered = false;
    let initialConnectionVersion = connectionVersion;
    try {
      const tab = await chrome.tabs.get(tabId);
      if (
        disposed ||
        scopeRevision !== tabScopeRevision ||
        !Number.isSafeInteger(tab?.windowId) ||
        tab.windowId < 0
      )
        return;
      const nextWindowId = tab.windowId;
      if (windowId !== undefined && windowId !== nextWindowId) {
        leaveWindow();
        initialConnectionVersion = connectionVersion;
      }
      windowId = nextWindowId;
      lastState = '';
      const composer = readComposer();
      const result = await request(WebLaunchPanelMessage.Register, {
        composerBusy: Boolean(
          composer.prompt.trim() ||
          composer.attachments ||
          composer.attachmentReads ||
          composer.busy,
        ),
      });
      // The tab can move to another window while registration is in flight.
      const registeredTab = disposed ? undefined : await chrome.tabs.get(tabId);
      if (
        disposed ||
        scopeRevision !== tabScopeRevision ||
        registeredTab?.windowId !== nextWindowId
      )
        return;
      initialized = true;
      registered = true;
      if (
        connectionVersion === initialConnectionVersion &&
        Object.hasOwn(result, 'connectionPending')
      )
        connection.accept(result.connectionPending);
      if (result.envelope) {
        const observed = result.observations?.find(
          item => item.receipt?.launchId === result.envelope.launchId,
        );
        await acceptEnvelope(result.envelope, observed?.internal);
      }
    } catch {
      /* Ordinary extension chat remains available when this bridge is unavailable. */
    } finally {
      if (scopeRevision === tabScopeRevision) {
        registering = false;
        if (registered) void publishState();
      }
    }
  }
  void register();
  const heartbeat = setInterval(() => {
    if (windowId === undefined) void register();
    else void publishState(true);
  }, 3000);
  return {
    inputAssociated,
    ownsThread,
    composerAction,
    activity,
    updateSelection,
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
      const currentThread = current.threadId;
      installComposer({ threadId: currentThread });
      if (!confirm(t('webLaunchSwitchConfirm'))) {
        return false;
      }
      await cancel(false);
      if (inputAssociated() || readComposer().threadId !== currentThread) return false;
      installComposer({ threadId });
      return true;
    },
    dispose: () => {
      disposed = true;
      clearTimeout(expiryTimer);
      clearInterval(heartbeat);
      chrome.runtime.onMessage?.removeListener(listener);
      chrome.tabs.onDetached?.removeListener(onTabDetached);
      chrome.tabs.onAttached?.removeListener(onTabAttached);
      connection.dispose();
    },
  };
}
