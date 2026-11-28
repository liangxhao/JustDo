import { sidePanelText as t, sidePanelWebConnectionError } from './sidepanel-i18n.js';
import { createWebConnectionPanel } from './web-connection-panel.js';
import { createWebLaunchContext } from './web-launch-context.js';
import { WebLaunchLimits } from '../../contracts/webLaunch.ts';

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
const SEND_CONFIRMATION = new Set(['CONFIRMATION_REQUIRED', 'RESULT_CONSENT_REQUIRED']);
const noop = () => {};

/** Owns only the external composer presentation; Main remains the execution owner. */
export function createWebLaunchPanel({
  document,
  chrome = globalThis.chrome,
  tabId,
  readComposer,
  installComposer,
  refreshThread = async () => {},
  onSubmitInput = noop,
  onWithdrawSubmitInput = noop,
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
      closeContext: noop,
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
  const releasedDrafts = new Set();
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
  let refreshedReceipt = '';
  let deferredDraft = null;
  let submissionNotice = '';
  const make = (tag, key, parent = root) => {
    const node = document.createElement(tag);
    if (key) node.textContent = t(key);
    parent.append(node);
    return node;
  };
  const context = createWebLaunchContext({
    document,
    onEdit: edit,
    canOpen: () => selected() && !draftUnavailable() && !readComposer().busy,
  });
  root.append(context.trigger);
  const waiting = make('p', 'webLaunchWaitingComposer');
  waiting.className = 'web-launch-waiting';
  waiting.setAttribute('role', 'status');
  const inputSharing = make('p');
  inputSharing.className = 'web-launch-input-sharing';
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
  const canShareInput = () => current?.supportsInputSharing === true && current.result === 'final';
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
      composer.prompt.trim(),
    );
  };
  function composerAction(threadId, turnId) {
    if (!current || current.threadId !== threadId) return null;
    if (turnId && current.clientTurnId !== turnId) return null;
    if (ownsThread(threadId) && (busy || submitted()))
      return { type: 'stop', disabled: actionPending || stopPending === current.launchId };
    if (inputAssociated()) return { type: 'send', disabled: !canSubmit() };
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
    onError(sidePanelWebConnectionError('webLaunchError', code));
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
        ...(type === WebLaunchPanelMessage.Submit && result?.requestSent === false
          ? { requestSent: false }
          : {}),
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
    const showContext = editable && !installing && current.contextText !== undefined;
    const launch = show ? current.launchId : '';
    if (launch !== visibleLaunch) context.close();
    visibleLaunch = launch;
    const notice = editable ? submissionNotice : '';
    const showInputSharing = editable && canShareInput();
    waiting.textContent = notice || t('webLaunchWaitingComposer');
    waiting.hidden = !(deferredDraft || notice);
    inputSharing.hidden = !showInputSharing;
    inputSharing.textContent = showInputSharing
      ? t('webLaunchInputSharing').replace('{origin}', () => current.origin)
      : '';
    root.hidden = !(showContext || canRecover || canAbandon || deferredDraft || notice || showInputSharing);
    context.setAvailable(showContext);
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
  function scheduleExpiry() {
    clearTimeout(expiryTimer);
    const launchId = current.launchId;
    expiryTimer = setTimeout(
      () => {
        if (!disposed && current?.launchId === launchId) render();
      },
      Math.max(0, current.expiresAt - Date.now()) + 1,
    );
  }
  function withdrawSubmissionInput() {
    const { launchId, threadId } = current;
    current.submissionInput = undefined;
    current.lastSubmittedPrompt = undefined;
    onWithdrawSubmitInput({ launchId, threadId });
  }
  function refreshReceiptThread(response, visibleError) {
    const { clientTurnId, nativeRunId } = response.internal ?? {};
    const { execution, request, receiptRevision } = response.receipt;
    const phase = execution.executionSettled
      ? 'settled'
      : nativeRunId && request.status === 'submitted' && execution.status === 'running'
        ? 'accepted'
        : '';
    if (!phase || !clientTurnId || !selected()) return;
    const { launchId, threadId } = current;
    const key = `${launchId}/${clientTurnId}/${phase}`;
    if (key === refreshedReceipt) return;
    refreshedReceipt = key;
    void Promise.resolve()
      .then(async () => {
        if (key !== refreshedReceipt) return;
        if (disposed || current?.launchId !== launchId || !selected()) {
          refreshedReceipt = '';
          return;
        }
        try {
          await refreshThread(threadId);
        } finally {
          if (visibleError && receipt?.receiptRevision === receiptRevision)
            fail(visibleError, launchId);
        }
      })
      .catch(() => {});
  }
  function rememberReleasedLaunch(launchId) {
    releasedDrafts.add(launchId);
    if (releasedDrafts.size > WebLaunchLimits.activeReceipts)
      releasedDrafts.delete(releasedDrafts.values().next().value);
    if (deferredDraft?.launchId === launchId) {
      deferredDraft = null;
      render();
    }
  }
  function acceptAbandonment(launchId) {
    rememberReleasedLaunch(launchId);
    if (current?.launchId !== launchId || !inputAssociated() || submitted() || busy || current.submissionInput)
      return;
    if (selected() && !cancellation?.keepText && readComposer().prompt === current.prompt)
      installComposer({ clearPrompt: true });
    inputReleased = true;
    current = null;
    receipt = null;
    cancellation = null;
    installing = false;
    render();
    void publishState();
  }
  function rememberReleasedDraft(value) {
    if (value?.request.status === 'submitted' || value?.execution.executionSettled === true ||
        CLOSED.has(value?.request.status)) rememberReleasedLaunch(value.launchId);
  }
  function acceptReceipt(response) {
    if (disposed) return;
    const next = response.receipt;
    rememberReleasedDraft(next);
    if (!current || next?.launchId !== current.launchId) {
      const threadId = response.internal?.threadId;
      if (threadId && response.internal.clientTurnId &&
          (next?.request.status === 'submitted' || next?.execution.executionSettled === true))
        onReceipt({ ...response, threadId, matchesSubmission: false, isCurrentLaunch: false });
      return;
    }
    if (
      next &&
      (!response.internal?.threadId || response.internal.threadId === current.threadId) &&
      (!receipt || next.receiptRevision > receipt.receiptRevision)
    ) {
      const hadInput = inputAssociated();
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
      const intentionalCancel = next.error?.code === 'EXECUTION_INTERRUPTED' ||
        (next.error?.code === 'CANCELLED' &&
          (cancellation?.launchId === next.launchId || stopPending === next.launchId));
      if (next.error?.code && !intentionalCancel) fail(next.error.code);
      if (response.internal?.composeRevision !== undefined)
        current.composeRevision = response.internal.composeRevision;
      if (response.internal?.deadlineAt && response.internal.deadlineAt !== current.expiresAt) {
        current.expiresAt = response.internal.deadlineAt;
        scheduleExpiry();
      }
      if (next.request.status === 'submitted' || next.execution.status === 'running') {
        const original = readComposer().prompt;
        inputReleased = true;
        if (selected() && !dirty && original === current.lastSubmittedPrompt)
          installComposer({ clearPrompt: true });
      }
      const attempt = current.submissionInput;
      const { clientTurnId, notSent } = response.internal ?? {};
      const matchesSubmission = Boolean(
        attempt &&
        (attempt.clientTurnId
          ? clientTurnId === attempt.clientTurnId
          : clientTurnId
            ? clientTurnId !== attempt.precedingClientTurnId
            : !attempt.precedingClientTurnId && notSent === true),
      );
      if (matchesSubmission) {
        if (notSent === true && next.execution.status === 'not-started') withdrawSubmissionInput();
        else attempt.clientTurnId = clientTurnId;
      }
      onReceipt({ ...response, threadId: current.threadId, matchesSubmission });
      refreshReceiptThread(response, intentionalCancel ? undefined : next.error?.code);
      const replacedDraft = hadInput && next.request.status === 'cancelled' &&
        response.internal?.replacedDraft === true;
      const localCancellation = cancellation?.launchId === next.launchId ? cancellation : null;
      if (CLOSED.has(next.request.status) && (replacedDraft || localCancellation)) {
        const clearInput = localCancellation
          ? localCancellation.hadInput && !localCancellation.keepText &&
            inputVersion === localCancellation.inputVersion &&
            readComposer().prompt === localCancellation.prompt
          : replacedDraft;
        if (selected() && clearInput) installComposer({ clearPrompt: true });
        inputReleased = true;
        cancellation = null;
        current = null;
        receipt = null;
      }
      if (hadInput && !inputAssociated()) void publishState();
    }
    render();
  }
  async function publishState(force = false) {
    if (disposed || registering || windowId === undefined) return;
    const composer = readComposer();
    try {
      const canReplace = inputAssociated() && selected() && !current.automaticSendAllowed &&
        !busy && !installing && !submitted() && !current.submissionInput && !actionPending &&
        !composer.busy && !composer.attachments && !composer.attachmentReads;
      const state = {
        composerBusy: Boolean(
          composer.prompt.trim() ||
          composer.attachments ||
          composer.attachmentReads ||
          composer.busy ||
          busy ||
          actionPending ||
          inputAssociated(),
        ),
        ...(composer.scopeBusy ? { scopeBusy: true } : {}),
        ...(canReplace ? { replaceableDraftLaunchId: current.launchId } : {}),
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
  const composerHasWork = composer => Boolean(
    composer.prompt.trim() ||
    composer.attachments ||
    composer.attachmentReads ||
    composer.busy ||
    busy ||
    actionPending,
  );
  async function restoreDispatched() {
    if (!current || disposed || inputAssociated() || !submitted() || composerHasWork(readComposer()))
      return;
    const { threadId } = current;
    if (!selected()) installComposer({ threadId });
    render();
    await refreshThread(threadId);
  }
  async function resumeCurrentEnvelope(envelope) {
    if (!current || envelope?.launchId !== current.launchId || envelope.threadId !== current.threadId)
      return;
    automaticDisarmed = true;
    if (!selected()) await restoreDispatched();
  }
  async function acceptEnvelope(envelope, internal, resume = false) {
    if (disposed || !envelope) return;
    if (envelope.launchId === current?.launchId) {
      if (resume) await resumeCurrentEnvelope(envelope);
      return;
    }
    const restored = resume || envelope.restored === true;
    const composer = readComposer();
    const alreadyDispatched =
      SENT.has(envelope.receipt?.request?.status) ||
      (envelope.receipt?.execution?.status && envelope.receipt.execution.status !== 'not-started');
    if (alreadyDispatched) {
      rememberReleasedDraft(envelope.receipt);
      if (inputAssociated() || (current && !resume)) return;
      current = { ...envelope, clientTurnId: internal?.clientTurnId };
      receipt = envelope.receipt;
      inputReleased = true;
      automaticDisarmed = true;
      submissionStartedAt = undefined;
      render();
      if (resume) await restoreDispatched();
      return;
    }
    if (releasedDrafts.has(envelope.launchId)) return;
    const sameDeferredDraft = deferredDraft?.launchId === envelope.launchId;
    const revision = envelope.receipt?.receiptRevision ?? 0;
    if (sameDeferredDraft && revision < deferredDraft.revision) return;
    if (composerHasWork(composer) || inputAssociated()) {
      if (!deferredDraft || sameDeferredDraft) {
        deferredDraft = { launchId: envelope.launchId, revision };
        render();
      }
      return;
    }
    if (sameDeferredDraft) {
      deferredDraft = null;
      if (Date.now() >= envelope.expiresAt) {
        render();
        return;
      }
    }
    current = { ...envelope, restored, clientTurnId: internal?.clientTurnId };
    receipt = envelope.receipt;
    submissionStartedAt = undefined;
    inputReleased = false;
    cancellation = null;
    dirty = false;
    revisionError = false;
    automaticDisarmed = restored;
    modelChanged = false;
    submissionNotice = '';
    onClearError();
    installing = true;
    context.value = envelope.contextText || '';
    const permissionMode = envelope.permissionMode ?? internal?.permissionMode;
    installComposer({
      prompt: envelope.prompt,
      permissionMode:
        permissionMode === 'full' || permissionMode === 'auto' ? permissionMode : 'ask',
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
    scheduleExpiry();
    if (current.restored === true) {
      automaticDisarmed = true;
      edit();
    } else await submit('automatic');
  }
  async function revise() {
    if (revisePromise || !current || !inputAssociated()) return revisePromise;
    const launchId = current.launchId;
    revisePromise = (async () => {
      while (
        dirty &&
        current?.launchId === launchId &&
        selected() &&
        !closed() &&
        !disposed &&
        !actionPending &&
        readComposer().prompt.trim()
      ) {
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
          if (current?.launchId !== launchId || disposed || actionPending) return;
          revisionError = true;
          fail(failure.code === 'COMPOSE_CHANGED' ? 'COMPOSE_CONFLICT' : failure.code, launchId);
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
    if (installing || !selected() || !inputAssociated() || disposed) return;
    if (actionPending) {
      if (field === 'prompt') inputVersion += 1;
      return;
    }
    if (!readComposer().prompt.trim()) {
      automaticDisarmed = true;
      if (field === 'prompt' && !busy && !submitted() && !current.submissionInput) void cancel(false);
      return;
    }
    if (draftUnavailable()) return;
    if (field === 'model') modelChanged = true;
    automaticDisarmed = true;
    dirty = true;
    inputVersion += 1;
    revisionError = false;
    render();
    void revise();
  }
  async function submit(submission = 'confirmed') {
    if (!canSubmit()) return;
    if (
      submission === 'automatic' &&
      (!initialized ||
        automaticDisarmed ||
        current.mode !== 'send' ||
        !current.automaticSendAllowed ||
        current.requiresUnknownConfirmation ||
        (current.result === 'final' && !current.shareAllowed))
    )
      return;
    const { launchId, threadId } = current;
    const input = actualInput();
    current.lastSubmittedPrompt = input.prompt;
    const newAttempt = !current.submissionInput;
    const attempt = (current.submissionInput ??= { precedingClientTurnId: current.clientTurnId });
    submissionStartedAt = Date.now();
    busy = true;
    submissionNotice = '';
    onClearError();
    render();
    try {
      onSubmitInput({ launchId, threadId, prompt: input.prompt });
      const result = await request(WebLaunchPanelMessage.Submit, {
        launchId,
        composeRevision: current.composeRevision,
        input,
        submission,
        shareResult: current.result === 'final',
        ...(submission === 'confirmed' && canShareInput() ? { shareInput: true } : {}),
        confirmNewTask: submission === 'confirmed',
      });
      if (current?.launchId !== launchId || disposed) return;
      acceptReceipt(result);
    } catch (failure) {
      if (current?.launchId === launchId && !disposed) {
        automaticDisarmed = true;
        if (
          failure.requestSent === false &&
          newAttempt &&
          current.submissionInput === attempt &&
          !attempt.clientTurnId
        )
          withdrawSubmissionInput();
        if (SEND_CONFIRMATION.has(failure.code)) submissionNotice = t(`webLaunchAction_${failure.code}`);
        else fail(failure.code, launchId);
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
    if (message.abandonedLaunchId) acceptAbandonment(message.abandonedLaunchId);
    const resume = message.resume === true;
    if (message.envelope && message.envelope.launchId !== current?.launchId) {
      void acceptEnvelope(message.envelope, message.internal, resume);
    } else {
      if (message.receipt) acceptReceipt(message);
      else if (message.code) fail(message.code, message.launchId ?? null);
      if (resume) void resumeCurrentEnvelope(message.envelope);
    }
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
    releasedDrafts.clear();
    receipt = null;
    cancellation = null;
    deferredDraft = null;
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
      const previousLaunchId = current?.launchId;
      const previousDeferredLaunchId = deferredDraft?.launchId;
      const result = await request(WebLaunchPanelMessage.Register, {
        composerBusy: Boolean(
          composer.prompt.trim() ||
          composer.attachments ||
          composer.attachmentReads ||
          composer.busy,
        ),
        ...(composer.scopeBusy ? { scopeBusy: true } : {}),
      });
      // The tab can move to another window while registration is in flight.
      const registeredTab = disposed ? undefined : await chrome.tabs.get(tabId);
      if (
        disposed ||
        scopeRevision !== tabScopeRevision ||
        registeredTab?.windowId !== nextWindowId
      )
        return;
      const firstRegistration = !initialized;
      initialized = true;
      registered = true;
      if (previousDeferredLaunchId && previousDeferredLaunchId === deferredDraft?.launchId &&
          Array.isArray(result.observations) && !result.observations.some(
            response => response.receipt?.launchId === previousDeferredLaunchId &&
              !CLOSED.has(response.receipt.request.status) && response.receipt.request.status !== 'submitted',
          )) rememberReleasedLaunch(previousDeferredLaunchId);
      if (
        connectionVersion === initialConnectionVersion &&
        Object.hasOwn(result, 'connectionPending')
      )
        connection.accept(result.connectionPending);
      if (result.envelope &&
          (current?.launchId === previousLaunchId || current?.launchId === result.envelope.launchId)) {
        const observed = result.observations?.find(
          item => item.receipt?.launchId === result.envelope.launchId,
        );
        await acceptEnvelope(
          result.envelope,
          observed?.internal,
          firstRegistration && result.envelope.restored === true,
        );
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
    closeContext: context.close,
    updateSelection,
    edit,
    publishState,
    ready: () => {
      render();
      void submit('automatic');
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
      context.dispose();
    },
  };
}
