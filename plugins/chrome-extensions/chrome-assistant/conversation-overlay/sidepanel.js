import { initializeAppearance } from './modules/appearance.js';
import { AppServerClient } from './modules/conversation-client.js';
import {
  GLOBAL_SIDE_PANEL_PATH,
  SidePanelMessage,
  supportsGlobalSidePanel,
  tabIdFromSidePanelUrl,
} from './modules/tab-side-panel.js';
import { createWebLaunchPanel } from './modules/web-launch-panel.js';
import {
  chromeDisplayThread,
  isCurrentThreadRunning,
  isSettledTurnNotification,
  messagesFromThread,
  shouldShowTurnError,
} from './modules/sidepanel-state.js';
import { ChromeExtensionStream } from './modules/sidepanel-stream.js';
import { createMessageRenderer } from './modules/sidepanel-messages.js';
import { createRunActivityView } from './modules/sidepanel-activity.js';
import { createApprovalPanel } from './modules/sidepanel-approvals.js';
import { createQuestionPanel } from './modules/sidepanel-questions.js';
import { createWorkspacePicker } from './modules/sidepanel-workspace.js';
import { createComposerAddMenu } from './modules/sidepanel-add-menu.js';
import {
  localizeSidePanel,
  sidePanelConnectionError,
  sidePanelText as t,
} from './modules/sidepanel-i18n.js';

void initializeAppearance();
localizeSidePanel(document);

const boundTabId = tabIdFromSidePanelUrl(document.URL, globalThis.chrome);
const globalPanel = document.URL === globalThis.chrome?.runtime?.getURL?.(GLOBAL_SIDE_PANEL_PATH);
const contextTabs = globalThis.chrome?.tabs;
const scopeButton = document.getElementById('panelScope');
const sessionSelect = document.getElementById('session');
const messages = document.getElementById('messages');
const prompt = document.getElementById('prompt');
const send = document.getElementById('send');
const refreshButton = document.getElementById('refresh');
const settingsButton = document.getElementById('settings');
const includePage = document.getElementById('includePage');
const attachButton = document.getElementById('attach');
const fileInput = document.getElementById('fileInput');
const attachmentList = document.getElementById('attachments');
const permissionSelect = document.getElementById('permission');
const modelSelect = document.getElementById('model');
const errorLine = document.getElementById('error');
const decisionDialog = document.getElementById('decisionDialog');
const approvalRoot = document.getElementById('approvals');
const webConnectionCard = document.getElementById('webConnectionCard');
const activityView = createRunActivityView(document.getElementById('runActivity'));
const messageRenderer = createMessageRenderer(messages, {
  latestButton: document.getElementById('latest'),
  processDetailsButton: document.getElementById('processDetails'),
  readImage: async (threadId, source) =>
    (await client.request('chrome/thread/image', { threadId, source })).dataUrl,
  openDelivery: (threadId, source) =>
    openThreadFile('chrome/thread/openDelivery', { threadId, source }),
  openMessageFile: (threadId, link) =>
    openThreadFile('chrome/thread/openMessageFile', { threadId, link }),
});

async function openThreadFile(method, params) {
  const { threadId } = params;
  const isCurrentThread = () => threadId && threadId === sessionSelect.value && threadId === subscribedThreadId;
  if (!isCurrentThread()) return;
  try {
    const result = await client.request(method, params);
    if (result?.opened !== true) throw new Error('Unable to open conversation file');
  } catch (error) {
    if (isCurrentThread()) throw error;
  }
}

let webLaunchPanel;
let sending = false;
let transportReady = false;
let sendingStartedAt = 0;
let submissionScopeThreadId = '';
let stoppingThreadId = '';
const pendingSubmissions = new Map();
const knownTurns = new Map();
const settledTurns = new Set();
let activeThreadId = '';
let activeTurnId = '';
let pendingAttachments = [];
let attachmentDraftGeneration = 0;
let attachmentReadsInFlight = 0;
let composerReady = false;
let lastPermissionMode = '';
let refreshGeneration = 0;
let currentEntries = [];
let pendingUserMessage = null;
let subscribedThreadId = '';
const streamViews = new Map();
const pendingCompletions = new Map();
let streamRenderTimer = null;
let draftId = crypto.randomUUID();
let draftPermissionSelection = null;
let draftWorkspaceSelection = null;
let currentCwd = '';
let recentCwds = [];
let choosingWorkspace = false;
let questionGeneration = 0;
let questionsReady = false;
let refreshingQuestions = false;
let pageContextGeneration = 0;
let panelWindowId;
let activePanelTabId = boundTabId;
let switchingScope = false;
let scopeSelection;
let lastGlobalDraftState;

const questions = createQuestionPanel(document.getElementById('questions'), {
  respond: async (threadId, requestId, response) => {
    if (!transportReady || sessionSelect.value !== threadId || stoppingThreadId === threadId)
      throw new Error(t('reconnecting'));
    await client.request('chrome/questions/respond', { threadId, requestId, ...response });
    void refreshQuestions(threadId);
  },
  onError: showError,
});
const workspace = createWorkspacePicker(document.getElementById('workspace'), {
  anchor: attachButton,
  request: (method, params) => client.request(method, params),
  onSelected: selection => {
    currentCwd = selection.cwd;
    if (!sessionSelect.value) draftWorkspaceSelection = selection;
    updateComposerDisabledState();
    if (sessionSelect.value) void refreshAll(sessionSelect.value);
  },
  onBusyChange: busy => { choosingWorkspace = busy; updateComposerDisabledState(); },
  onError: showError,
});
const addMenu = createComposerAddMenu(attachButton, document.getElementById('addMenu'), {
  onAttach: () => fileInput.click(),
});

function clearQuestions() {
  questionGeneration += 1;
  questionsReady = false;
  refreshingQuestions = false;
  questions.clear();
  syncQuestionVisibility();
}

const approvalPending = () => !approvalRoot.classList.contains('hidden');
const questionPending = () => (questionsReady || refreshingQuestions) && questions.hasPending;

function syncQuestionVisibility() {
  publishGlobalDraftState();
  void webLaunchPanel?.publishState();
  const hasApproval = approvalPending();
  const hasQuestion = questionPending();
  const showConnection = !webConnectionCard.classList.contains('hidden') && !hasQuestion;
  if (hasApproval || hasQuestion || showConnection) webLaunchPanel?.closeContext?.();
  if (!hasApproval && !showConnection) {
    if (decisionDialog.open) decisionDialog.close();
    questions.setSuspended(!questionsReady);
    return;
  }
  questions.setSuspended(true);
  const section = hasApproval ? approvalRoot : webConnectionCard;
  decisionDialog.dataset.owner = hasApproval ? 'approval' : 'website';
  decisionDialog.setAttribute('aria-label', t(hasApproval ? 'approvalRegion' : 'webConnectionTitle'));
  const opening = !decisionDialog.open;
  if (opening) decisionDialog.showModal();
  if (opening || !section.contains(document.activeElement)) section.focus({ preventScroll: true });
}

async function refreshQuestions(threadId) {
  const generation = ++questionGeneration;
  questionsReady = false;
  refreshingQuestions = Boolean(threadId && stoppingThreadId !== threadId);
  if (!refreshingQuestions) questions.clear();
  syncQuestionVisibility();
  if (!refreshingQuestions) return;
  try {
    const result = await client.request('chrome/questions/list', { threadId });
    if (generation === questionGeneration && threadId === sessionSelect.value && stoppingThreadId !== threadId) {
      questions.setQuestions(threadId, result.questions);
      questionsReady = true;
    }
  } catch (error) {
    if (generation === questionGeneration && threadId === sessionSelect.value && transportReady)
      showError(error);
  } finally {
    if (generation === questionGeneration) {
      refreshingQuestions = false;
      syncQuestionVisibility();
    }
  }
}

const decisionObserver = new MutationObserver(syncQuestionVisibility);
decisionObserver.observe(approvalRoot, { childList: true, attributes: true, attributeFilter: ['class'] });
decisionObserver.observe(webConnectionCard, { attributes: true, attributeFilter: ['class'] });
// Dismissing the browser dialog must not silently resolve an authorization request.
decisionDialog.addEventListener('cancel', event => event.preventDefault());

function streamView(threadId) {
  if (!streamViews.has(threadId)) {
    // Keep only a bounded set of temporary UI projections.
    if (streamViews.size >= 8) {
      const oldest = streamViews.keys().next().value;
      streamViews.delete(oldest);
      pendingCompletions.delete(oldest);
    }
    streamViews.set(threadId, new ChromeExtensionStream(threadId));
  }
  return streamViews.get(threadId);
}

function projectThreadMessages(thread, threadId = thread.id) {
  return messagesFromThread(thread, {
    protectTrailingTurn: Boolean(
      pendingSubmissions.has(threadId) ||
      knownTurns.has(threadId) ||
      (threadId && activeThreadId === threadId) ||
      (threadId && stoppingThreadId === threadId) ||
      (sending && sessionSelect.value === threadId) ||
      thread.status?.type === 'active',
    ),
  });
}

function renderHistory(thread) {
  renderDisplayHistory(chromeDisplayThread(thread));
}

function renderDisplayHistory(display) {
  if (!display || typeof display.id !== 'string' || !Array.isArray(display.turns)) return;
  const thread = display;
  const view = streamView(thread.id);
  view.setHistory(thread);
  renderThreadMessages(projectThreadMessages(view.project()), thread.id);
  updateActivity();
}

const MAX_ATTACHMENT_COUNT = 5;
const MAX_ATTACHMENT_BYTES = 4 * 1024 * 1024;
const MAX_MODEL_PAGES = 32;
const approvals = createApprovalPanel(approvalRoot, {
  isCurrent: request => {
    const { threadId, turnId } = request.params ?? {};
    const pending = pendingSubmissions.get(threadId);
    const known = knownTurns.get(threadId);
    return (threadId === sessionSelect.value || (sending && threadId === submissionScopeThreadId)) &&
      stoppingThreadId !== threadId &&
      !pending?.uncertain && !known?.uncertain &&
      (pending?.clientTurnId || known?.id) === turnId &&
      !settledTurns.has(`${threadId}/${turnId}`);
  },
});

const client = new AppServerClient((method, params) => {
  if (method === 'chrome/thread/workspace/changed' && params?.threadId === sessionSelect.value)
    void refreshAll(params.threadId);
  if (method === 'chrome/questions/changed' && params?.threadId === sessionSelect.value)
    void refreshQuestions(params.threadId);
  // Standard item notifications serve the protocol's core history. This rich
  // viewer consumes its explicit browser lane once, without appending both.
  if (method === 'chrome/thread/stream') {
    if (typeof params?.threadId !== 'string' || !params.threadId) return;
    if (params.turnId && settledTurns.has(`${params.threadId}/${params.turnId}`)) return;
    const known = knownTurns.get(params.threadId);
    if (params.retryAttempt > 0 && (!known || known.id !== params.turnId || known.uncertain)) return;
    if (!streamView(params.threadId).accept(params)) return;
    if (known && params.retryAttempt > (known.retryAttempt ?? 0)) {
      knownTurns.set(params.threadId, { ...known, nativeRunId: params.event.runId,
        retryAttempt: params.retryAttempt, retryWaiting: false });
    }
    if (params.threadId !== sessionSelect.value) return;
    if (streamRenderTimer === null) {
      streamRenderTimer = setTimeout(() => {
        streamRenderTimer = null;
        const threadId = sessionSelect.value;
        if (threadId)
          renderThreadMessages(projectThreadMessages(streamView(threadId).project()), threadId);
      }, 40);
    }
  }
  if (method === 'connection/closed') {
    clearQuestions();
    workspace.invalidate();
    draftWorkspaceSelection = null;
    approvals.cancelAll();
    refreshGeneration += 1;
    transportReady = false;
    setComposerReady(false);
    errorLine.textContent = t('reconnecting');
    errorLine.classList.remove('hidden');
    updateActivity();
  }
  if (method === 'connection/failed') {
    clearQuestions();
    workspace.invalidate();
    draftWorkspaceSelection = null;
    approvals.cancelAll();
    transportReady = false;
    setComposerReady(false);
    errorLine.textContent = sidePanelConnectionError(params?.code);
    errorLine.classList.remove('hidden');
  }
  if (method === 'connection/reconnected') {
    // Completion may have happened while disconnected. Rehydrate from Gateway
    // rather than carrying an old running turn into the next run.
    void refreshAll(sessionSelect.value);
  }
  if (method === 'turn/started' && params?.threadId === sessionSelect.value) {
    if (settledTurns.has(`${params.threadId}/${params?.turn?.id}`)) return;
    const pending = pendingSubmissions.get(params.threadId);
    if (pending && pending.clientTurnId !== params?.turn?.id) return;
    if (pending?.uncertain || knownTurns.get(params.threadId)?.uncertain) clearError();
    if (pending) {
      pendingSubmissions.delete(params.threadId);
      clearAttachments();
    }
    setRunningTurn(params.threadId, params?.turn?.id, undefined, true);
  }
  if (method === 'chrome/thread/updated' && params?.threadId === sessionSelect.value) {
    const expectedTurnId =
      pendingSubmissions.get(params.threadId)?.clientTurnId || knownTurns.get(params.threadId)?.id;
    const settled = applyTurnObservation(params.threadId, params.activeTurn, expectedTurnId);
    if (params.display?.id === params.threadId) renderDisplayHistory(params.display);
    if (settled) void refreshAll(params.threadId);
  }
  if (method === 'turn/completed') {
    if (!isSettledTurnNotification(params)) return;
    const expectedId =
      knownTurns.get(params.threadId)?.id ||
      pendingSubmissions.get(params.threadId)?.clientTurnId;
    if (!expectedId || expectedId !== params.turn.id) {
      approvals.cancelTurn(params.threadId, params.turn.id);
      return;
    }
    recordTurnCompletion(params.threadId, params.turn);
    if (params.threadId === sessionSelect.value) void refreshAll(params.threadId);
  }
}, { requestHandler: (request, options) => approvals.request(request, options) });

function rememberSettledTurn(threadId, turnId) {
  settledTurns.add(`${threadId}/${turnId}`);
  if (settledTurns.size > 48) settledTurns.delete(settledTurns.values().next().value);
}

function recordTurnCompletion(threadId, turn) {
  const known = knownTurns.get(threadId);
  const nativeRunId = turn.nativeRunId ?? (known?.id === turn.id ? known.nativeRunId : undefined);
  approvals.cancelTurn(threadId, turn.id);
  pendingSubmissions.delete(threadId);
  knownTurns.delete(threadId);
  rememberSettledTurn(threadId, turn.id);
  pendingCompletions.set(threadId, turn);
  if (stoppingThreadId === threadId) stoppingThreadId = '';
  const selected = threadId === sessionSelect.value;
  const view = streamViews.get(threadId);
  if (turn.status === 'failed') view?.markFailed(nativeRunId);
  if (!selected || turn.status === 'interrupted') view?.finish(true);
  if (selected) {
    setRunningTurn('', '');
    if (view && (turn.status === 'interrupted' || turn.status === 'failed'))
      renderThreadMessages(projectThreadMessages(view.project()), threadId);
    if (turn.status === 'failed' && turn.error?.message) showError(turn.error.message);
  }
}

function setRunningTurn(threadId, turnId, nativeRunId, confirmed = false, retry = {}) {
  activeThreadId = typeof threadId === 'string' ? threadId : '';
  activeTurnId = typeof turnId === 'string' ? turnId : '';
  if (activeThreadId && activeTurnId) {
    const previous = knownTurns.get(activeThreadId);
    knownTurns.set(activeThreadId, {
      id: activeTurnId,
      nativeRunId:
        nativeRunId || (previous?.id === activeTurnId ? previous.nativeRunId : undefined),
      retryAttempt: retry.retryAttempt ?? (previous?.id === activeTurnId ? previous.retryAttempt : undefined),
      retryWaiting: retry.retryWaiting ?? (previous?.id === activeTurnId && previous.retryWaiting === true),
      uncertain: !confirmed && previous?.id === activeTurnId && previous.uncertain === true,
      startedAt: previous?.id === activeTurnId ? previous.startedAt : Date.now(),
    });
    const known = knownTurns.get(activeThreadId);
    if (known.nativeRunId && !known.uncertain) {
      const view = streamView(activeThreadId);
      if (view.bindRun(known.nativeRunId, known.startedAt, known.retryAttempt) && activeThreadId === sessionSelect.value) {
        renderThreadMessages(projectThreadMessages(view.project()), activeThreadId);
      }
    }
  }
  updateComposerDisabledState();
  updateActivity();
}

function selectedWebAction() {
  const threadId = sessionSelect.value;
  return webLaunchPanel?.composerAction(threadId, activeThreadId === threadId ? activeTurnId : '');
}

function updateActivity() {
  const threadId = sessionSelect.value;
  if (pendingCompletions.has(threadId) && !knownTurns.has(threadId)) {
    activityView.render(null);
    return;
  }
  const activity = streamViews.get(threadId)?.project().activity ?? null;
  const webActivity = webLaunchPanel?.activity(threadId, activeThreadId === threadId ? activeTurnId : '');
  let fallback = null;
  if (webActivity) fallback = webActivity;
  else if (pendingSubmissions.get(threadId)?.uncertain)
    fallback = { stage: 'checking', startedAt: pendingSubmissions.get(threadId).startedAt };
  else if (knownTurns.get(threadId)?.uncertain)
    fallback = { stage: 'checking', startedAt: knownTurns.get(threadId).startedAt };
  else if (stoppingThreadId === threadId && threadId) fallback = { stage: 'stopping' };
  else if (knownTurns.get(threadId)?.retryWaiting)
    fallback = { stage: 'continuingAfterError', startedAt: knownTurns.get(threadId).startedAt };
  else if (sending && !activeThreadId) fallback = { stage: 'sending', startedAt: sendingStartedAt };
  else if (isCurrentThreadRunning(activeThreadId, threadId) && !activity)
    fallback = { stage: 'starting' };
  if (!transportReady && (activity || fallback)) fallback = { ...fallback, stage: 'checking' };
  activityView.render(knownTurns.get(threadId)?.retryWaiting ? null : activity, fallback);
}

function updateComposerDisabledState() {
  const currentThreadRunning = isCurrentThreadRunning(activeThreadId, sessionSelect.value);
  const inputLocked = sending || switchingScope;
  const pending =
    pendingSubmissions.get(sessionSelect.value)?.uncertain === true ||
    knownTurns.get(sessionSelect.value)?.uncertain === true;
  sessionSelect.disabled = inputLocked || choosingWorkspace;
  prompt.readOnly = switchingScope;
  const externalInput = webLaunchPanel?.inputAssociated() === true;
  const webAction = selectedWebAction();
  const stopping = webAction ? webAction.type === 'stop' : currentThreadRunning;
  send.classList.toggle('stop', stopping);
  send.title = t(stopping ? 'stop' : 'send');
  send.setAttribute('aria-label', send.title);
  workspace.update({
    threadId: sessionSelect.value, draftId, cwd: currentCwd, recentCwds,
    disabled: !composerReady || !transportReady || inputLocked || pending || externalInput ||
      currentThreadRunning || Boolean(stoppingThreadId && stoppingThreadId === sessionSelect.value),
  });
  attachButton.disabled = externalInput || inputLocked || pending || attachmentReadsInFlight > 0;
  addMenu.update();
  fileInput.disabled = externalInput || inputLocked || pending || attachmentReadsInFlight > 0;
  includePage.disabled = externalInput || inputLocked || pending;
  permissionSelect.disabled = !composerReady || inputLocked || pending;
  modelSelect.disabled = !composerReady || inputLocked || pending;
  send.disabled = switchingScope || (webAction ? webAction.disabled : (
    choosingWorkspace ||
    sending ||
    !transportReady ||
    pending ||
    (currentThreadRunning && !activeTurnId) ||
    (stoppingThreadId === sessionSelect.value && Boolean(stoppingThreadId)) ||
    attachmentReadsInFlight > 0 ||
    (!currentThreadRunning && (!composerReady || (!prompt.value.trim() && pendingAttachments.length === 0)))
  ));
  publishGlobalDraftState();
  void webLaunchPanel?.publishState();
}

function setComposerReady(ready) {
  composerReady = ready;
  updateComposerDisabledState();
  webLaunchPanel?.ready();
}

function showError(error) {
  errorLine.textContent = error instanceof Error ? error.message : String(error);
  errorLine.classList.remove('hidden');
}

function clearError() {
  errorLine.textContent = '';
  errorLine.classList.add('hidden');
}

function renderMessages(entries) {
  messageRenderer.render(entries, sessionSelect.value);
}

function renderThreadMessages(entries, threadId = sessionSelect.value) {
  currentEntries = entries;
  renderMessages(pendingUserMessage?.threadId === threadId
    ? [...entries, pendingUserMessage.entry]
    : entries);
  updateActivity();
}

function showPendingUserMessage(threadId, text, rawMessage) {
  pendingUserMessage = {
    threadId,
    entry: { role: 'user', text, rawMessage },
  };
  renderThreadMessages(currentEntries, threadId);
}

function clearPendingUserMessage() {
  pendingUserMessage = null;
  renderMessages(currentEntries);
}

async function refreshSessions(preferredSessionId, generation) {
  const previousSelection = sessionSelect.value;
  const result = await client.request('thread/list', { chrome: { excludePendingFirstSend: true } });
  const restoredSelection = scopeSelection ? await scopeSelection : undefined;
  if (generation !== refreshGeneration) return false;
  const current = preferredSessionId ?? (previousSelection || restoredSelection || '');
  scopeSelection = undefined;
  const conversations = result.data ?? [];
  const selectedThread = conversations.find(entry => entry.id === current);
  const draftOption = sessionSelect.querySelector('option[hidden]');
  const keepDraft = !selectedThread && draftOption?.value === current;
  // Keep the native select's compact label while refreshing its choices.
  sessionSelect.options.length = 0;
  const createOption = document.createElement('option');
  createOption.value = '';
  createOption.textContent = t('newChat');
  sessionSelect.append(createOption);
  for (const entry of conversations) {
    const option = document.createElement('option');
    option.value = entry.id;
    option.textContent = entry.name ?? entry.preview ?? t('untitled');
    sessionSelect.append(option);
  }
  if (keepDraft) sessionSelect.append(draftOption);
  sessionSelect.value = selectedThread || keepDraft ? current : '';
  if (previousSelection !== sessionSelect.value) {
    draftPermissionSelection = null;
    approvals.cancelAll();
    clearQuestions();
  }
  webLaunchPanel?.updateSelection();
  if (selectedThread?.status?.type === 'active' && !pendingCompletions.has(selectedThread.id)) {
    setRunningTurn(
      selectedThread.id,
      knownTurns.get(selectedThread.id)?.id ||
        (activeThreadId === selectedThread.id ? activeTurnId : ''),
      knownTurns.get(selectedThread.id)?.nativeRunId,
    );
  } else if (knownTurns.has(sessionSelect.value)) {
    const known = knownTurns.get(sessionSelect.value);
    setRunningTurn(sessionSelect.value, known.id, known.nativeRunId);
  } else if (activeThreadId !== sessionSelect.value || !activeTurnId) {
    setRunningTurn('', '');
  }
  return true;
}

async function readModelCatalog(generation) {
  const entries = [];
  const cursors = new Set();
  let cursor;
  for (let page = 0; page < MAX_MODEL_PAGES; page += 1) {
    const result = await client.request('model/list', { limit: 200, ...(cursor ? { cursor } : {}) });
    if (generation !== refreshGeneration) return [];
    if (!Array.isArray(result.data) || result.data.length > 200)
      throw new Error(t('modelCatalogUnavailable'));
    entries.push(...result.data);
    if (result.nextCursor == null) return entries;
    if (typeof result.nextCursor !== 'string' || !result.nextCursor || cursors.has(result.nextCursor))
      throw new Error(t('modelCatalogUnavailable'));
    cursor = result.nextCursor;
    cursors.add(cursor);
  }
  throw new Error(t('modelCatalogUnavailable'));
}

async function refreshComposerOptions(threadId, generation) {
  // The browser capability completes the existing host preparation before the
  // standard catalog performs its read-only access to the connected runtime.
  const result = await client.request('chrome/composer/options', { ...(threadId ? { threadId } : {}) });
  if (generation !== refreshGeneration || sessionSelect.value !== threadId) return;
  currentCwd = (!threadId && draftWorkspaceSelection?.cwd) || result.cwd || '';
  recentCwds = result.recentCwds ?? [];
  const models = await readModelCatalog(generation);
  if (generation !== refreshGeneration || sessionSelect.value !== threadId) return;
  permissionSelect.value = webLaunchPanel?.inputAssociated()
    ? permissionSelect.value || 'ask'
    : (selectedDraftPermission(threadId) ?? result.permissionMode ?? 'full');
  lastPermissionMode = permissionSelect.value;
  const localModel = webLaunchPanel?.inputAssociated() ? modelSelect.value : '';
  modelSelect.replaceChildren();
  if (!result.modelRef) {
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = t(models.length ? 'selectModel' : 'defaultModel');
    placeholder.disabled = models.length > 0;
    modelSelect.append(placeholder);
  }
  const providerGroups = new Map();
  for (const entry of models) {
    const [provider] = entry.id.split('/', 1);
    const prefix = `${provider}/`;
    let group = providerGroups.get(provider);
    if (!group) {
      group = document.createElement('optgroup');
      group.label = provider;
      providerGroups.set(provider, group);
      modelSelect.append(group);
    }

    const option = document.createElement('option');
    const label = entry.displayName || entry.id;
    option.value = entry.id;
    option.textContent = label.startsWith(prefix) ? label.slice(prefix.length) : label;
    option.title = entry.id;
    group.append(option);
  }
  modelSelect.value =
    localModel && models.some(entry => entry.id === localModel)
      ? localModel
      : (result.modelRef ?? '');
  modelSelect.title = modelSelect.selectedOptions[0]?.textContent || '';
}

function selectedDraftPermission(threadId) {
  return draftPermissionSelection?.threadId === threadId && draftPermissionSelection.draftId === draftId
    ? draftPermissionSelection.mode
    : undefined;
}

async function refreshMessages(threadId, generation) {
  if (!threadId) {
    const previousThreadId = subscribedThreadId;
    subscribedThreadId = '';
    if (previousThreadId) {
      void client.request('thread/unsubscribe', { threadId: previousThreadId }).catch(() => {});
    }
    if (generation === refreshGeneration && sessionSelect.value === threadId) {
      renderThreadMessages([], threadId);
    }
    return;
  }
  const expectedTurnId =
    pendingSubmissions.get(threadId)?.clientTurnId ||
    knownTurns.get(threadId)?.id ||
    (activeThreadId === threadId ? activeTurnId : '');
  const result = await client.request('thread/resume', {
    excludeTurns: true,
    threadId,
    chrome: { includeDisplay: true, ...(expectedTurnId ? { turnId: expectedTurnId } : {}) },
  });
  if (generation !== refreshGeneration || sessionSelect.value !== threadId) {
    if (sessionSelect.value !== threadId && subscribedThreadId !== threadId) {
      void client.request('thread/unsubscribe', { threadId }).catch(() => {});
    }
    return;
  }
  const previousThreadId = subscribedThreadId;
  subscribedThreadId = threadId;
  void refreshQuestions(threadId);
  if (previousThreadId && previousThreadId !== threadId) {
    void client.request('thread/unsubscribe', { threadId: previousThreadId }).catch(() => {});
  }
  const observation = result.thread?.chrome?.activeTurn;
  const observedTurnId = pendingSubmissions.get(threadId)?.clientTurnId ||
    knownTurns.get(threadId)?.id || expectedTurnId;
  const previousCompletion = pendingCompletions.get(threadId);
  const nextRun = previousCompletion && observation?.status === 'inProgress' &&
    observation.id && observation.id !== previousCompletion.id &&
    (!observedTurnId || observation.id === observedTurnId) &&
    !settledTurns.has(`${threadId}/${observation.id}`);
  // Reconcile the previous run before the snapshot can bind its successor.
  if (!nextRun) applyTurnObservation(threadId, observation, observedTurnId);
  const completed = pendingCompletions.get(threadId);
  pendingCompletions.delete(threadId);
  const currentTurnId = knownTurns.get(threadId)?.id || pendingSubmissions.get(threadId)?.clientTurnId;
  if (completed && (!currentTurnId || currentTurnId === completed.id)) {
    const view = streamView(threadId);
    const display = chromeDisplayThread(result.thread);
    if (completed.status === 'failed') view.markFailed(completed.nativeRunId);
    view.setHistory(display, true);
    view.finish((completed.status === 'interrupted' || completed.status === 'failed') && !nextRun);
    renderThreadMessages(projectThreadMessages(view.project()), threadId);
    const message = completed.error?.message;
    if (message) {
      if (shouldShowTurnError(threadId, sessionSelect.value, true, display, message)) showError(message);
      else if (errorLine.textContent === message) clearError();
    }
  } else {
    renderHistory(result.thread);
  }
  if (nextRun) applyTurnObservation(threadId, observation, observedTurnId);
}

function applyTurnObservation(threadId, observation, expectedTurnId) {
  if (observation?.id && (!expectedTurnId || observation.id === expectedTurnId)) {
    if (settledTurns.has(`${threadId}/${observation.id}`)) {
      // A stale thread-list status cannot override the already observed terminal.
      if (activeThreadId === threadId && (!activeTurnId || activeTurnId === observation.id)) setRunningTurn('', '');
      return false;
    }
    if (observation.executionSettled === true) {
      recordTurnCompletion(threadId, observation);
      return true;
    } else if (observation.status === 'inProgress') {
      if (pendingSubmissions.has(threadId)) clearAttachments();
      pendingSubmissions.delete(threadId);
      setRunningTurn(threadId, observation.id, observation.nativeRunId, true, {
        retryAttempt: observation.retryAttempt,
        retryWaiting: observation.retryWaiting === true,
      });
    } else if (observation.status === 'unknown') {
      const previous = knownTurns.get(threadId);
      knownTurns.set(threadId, {
        id: observation.id,
        nativeRunId: observation.nativeRunId,
        retryAttempt: observation.retryAttempt,
        uncertain: true,
        startedAt: previous?.id === observation.id ? previous.startedAt : Date.now(),
      });
      updateComposerDisabledState();
      updateActivity();
    }
  }
  return false;
}

async function refreshAll(preferredSessionId) {
  const generation = ++refreshGeneration;
  setComposerReady(false);
  const pendingFailure = () => {
    if (preferredSessionId !== sessionSelect.value) return undefined;
    const completion = pendingCompletions.get(preferredSessionId);
    return completion?.status === 'failed' ? completion.error?.message : undefined;
  };
  if (errorLine.textContent !== pendingFailure()) clearError();
  try {
    if (!(await refreshSessions(preferredSessionId, generation))) return false;
    const threadId = sessionSelect.value;
    await Promise.all([
      refreshMessages(threadId, generation),
      refreshComposerOptions(threadId, generation),
    ]);
    if (generation === refreshGeneration && sessionSelect.value === threadId) {
      transportReady = true;
      setComposerReady(true);
      if (pendingSubmissions.get(threadId)?.uncertain) showError(t('unknownSend'));
      else if (knownTurns.get(threadId)?.uncertain) showError(t('unknownExecution'));
      updateActivity();
      return true;
    }
  } catch (error) {
    if (generation === refreshGeneration) showError(pendingFailure() ?? error);
  }
  return false;
}

function clearAttachments() {
  attachmentDraftGeneration += 1;
  pendingAttachments = [];
  renderAttachments();
}

function renderAttachments() {
  attachmentList.replaceChildren();
  attachmentList.classList.toggle('hidden', pendingAttachments.length === 0);
  pendingAttachments.forEach((attachment, index) => {
    const chip = document.createElement('span');
    chip.className = 'attachment-chip';
    const name = document.createElement('span');
    name.className = 'attachment-name';
    name.textContent = attachment.name;
    name.title = attachment.name;
    const remove = document.createElement('button');
    remove.className = 'attachment-remove';
    remove.type = 'button';
    remove.textContent = '×';
    remove.title = t('removeAttachment', { name: attachment.name });
    remove.setAttribute('aria-label', remove.title);
    remove.addEventListener('click', () => {
      pendingAttachments.splice(index, 1);
      renderAttachments();
    });
    chip.append(name, remove);
    attachmentList.append(chip);
  });
}

function bytesToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

async function addAttachments(files) {
  if (webLaunchPanel?.inputAssociated()) return;
  clearError();
  const draftGeneration = attachmentDraftGeneration;
  const selected = [...files];
  if (pendingAttachments.length + selected.length > MAX_ATTACHMENT_COUNT) {
    showError(t('attachmentCount', { count: MAX_ATTACHMENT_COUNT }));
    return;
  }
  const existingBytes = pendingAttachments.reduce((total, item) => total + item.size, 0);
  const selectedBytes = selected.reduce((total, file) => total + file.size, 0);
  if (existingBytes + selectedBytes > MAX_ATTACHMENT_BYTES) {
    showError(t('attachmentSize'));
    return;
  }
  attachmentReadsInFlight += 1;
  updateComposerDisabledState();
  try {
    const next = await Promise.all(
      selected.map(async file => ({
        base64Data: bytesToBase64(await file.arrayBuffer()),
        mimeType: file.type || 'application/octet-stream',
        name: file.name,
        size: file.size,
      })),
    );
    if (draftGeneration !== attachmentDraftGeneration) return;
    if (pendingAttachments.length + next.length > MAX_ATTACHMENT_COUNT) {
      showError(t('attachmentCount', { count: MAX_ATTACHMENT_COUNT }));
      return;
    }
    if (
      pendingAttachments.reduce((total, item) => total + item.size, 0) + selectedBytes >
      MAX_ATTACHMENT_BYTES
    ) {
      showError(t('attachmentSize'));
      return;
    }
    pendingAttachments.push(...next);
    renderAttachments();
  } finally {
    attachmentReadsInFlight -= 1;
    updateComposerDisabledState();
  }
}

function invalidatePageContext(tabId) {
  if (tabId === activePanelTabId) pageContextGeneration += 1;
}

function onPageTabUpdated(tabId, change) {
  if (change.status === 'loading' || typeof change.url === 'string') invalidatePageContext(tabId);
}

async function readPageTab(generation, previousTab) {
  if (generation !== pageContextGeneration) return undefined;
  try {
    const tab = boundTabId !== null
      ? await contextTabs.get(boundTabId)
      : (await contextTabs.query({ active: true, windowId: panelWindowId }))[0];
    if (
      generation === pageContextGeneration &&
      tab?.id === activePanelTabId &&
      (boundTabId !== null || tab.windowId === panelWindowId) &&
      !tab.pendingUrl &&
      (!previousTab ||
        (tab.id === previousTab.id && tab.windowId === previousTab.windowId &&
          (!previousTab.url || tab.url === previousTab.url)))
    ) {
      return tab;
    }
  } catch {
    // The tab may have closed before optional context could be collected.
  }
  return undefined;
}

async function collectPageContext(generation) {
  if (activePanelTabId === null || (globalPanel && panelWindowId === undefined)) return undefined;
  // Start the identity read without delaying the permission prompt past the click gesture.
  const tabBeforePermission = readPageTab(generation);
  try {
    await chrome.permissions.request({ origins: ['http://*/*', 'https://*/*'] });
  } catch {
    // The title and URL remain available if the user declines page-text access.
  }
  const previousTab = await tabBeforePermission;
  const tab = previousTab && (await readPageTab(generation, previousTab));
  if (!tab) return undefined;
  let snapshot;
  let documentId;
  try {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => ({
        title: document.title,
        url: globalThis.location.href,
        selectedText: globalThis.getSelection?.()?.toString() ?? '',
        pageText: (document.querySelector('main')?.innerText || document.body?.innerText || '')
          .replace(/[\t ]+/gu, ' ')
          .replace(/\n{3,}/gu, '\n\n'),
      }),
    });
    if (result?.documentId && result.result) {
      snapshot = result.result;
      documentId = result.documentId;
    }
  } catch {
    // Restricted browser pages still contribute their visible title and URL.
  }
  if (generation !== pageContextGeneration || (snapshot && tab.url && snapshot.url !== tab.url))
    return undefined;
  return {
    tab,
    documentId,
    context: {
      title: snapshot?.title ?? tab.title ?? '',
      url: snapshot?.url ?? tab.url ?? '',
      selectedText:
        typeof snapshot?.selectedText === 'string' ? snapshot.selectedText.slice(0, 16000) : '',
      pageText: typeof snapshot?.pageText === 'string' ? snapshot.pageText.slice(0, 24000) : '',
    },
  };
}

async function pageContextForTurn(generation, snapshot) {
  if (!(await readPageTab(generation, snapshot.tab))) return undefined;
  if (snapshot.documentId) {
    try {
      // Recheck the active document of this tab even when it reloads to the same URL.
      const [current] = await chrome.scripting.executeScript({
        target: { tabId: snapshot.tab.id },
        injectImmediately: true,
        func: () => globalThis.location.href,
      });
      if (current?.documentId !== snapshot.documentId || current.result !== snapshot.context.url)
        return undefined;
    } catch {
      return undefined;
    }
  }
  return snapshot.context;
}

async function submit() {
  if (decisionDialog.open || switchingScope) return;
  if (webLaunchPanel?.inputAssociated()) {
    await webLaunchPanel.submit('confirmed');
    return;
  }
  const message = prompt.value.trim();
  if (
    (!message && pendingAttachments.length === 0) ||
    choosingWorkspace ||
    sending ||
    !composerReady ||
    !transportReady ||
    pendingSubmissions.get(sessionSelect.value)?.uncertain ||
    knownTurns.get(sessionSelect.value)?.uncertain ||
    attachmentReadsInFlight > 0
  )
    return;
  const attachments = pendingAttachments.map(({ base64Data, mimeType, name }) => ({
    base64Data,
    mimeType,
    name,
  }));
  const rawUserMessage = {
    role: 'user',
    content: [
      { type: 'text', text: message },
      ...attachments.map(attachment => ({
        type: 'attachment',
        attachment: {
          kind: attachment.mimeType.startsWith('image/') ? 'image' : 'document',
          label: attachment.name,
          url: `data:${attachment.mimeType};base64,${attachment.base64Data}`,
        },
      })),
    ],
  };
  const modelRef = modelSelect.value;
  const permissionMode = permissionSelect.value;
  const selectedThreadId = sessionSelect.value;
  const explicitPermissionMode = selectedDraftPermission(selectedThreadId);
  const selectedWorkspace = draftWorkspaceSelection;
  const selectedDraftId = draftId;
  const includePageContext = includePage.checked;
  const contextGeneration = pageContextGeneration;
  let createdThreadId = '';
  let preparedThreadId = '';
  let turnRequestStarted = false;
  const clientTurnId = crypto.randomUUID();
  sending = true;
  sendingStartedAt = Date.now();
  updateComposerDisabledState();
  clearError();
  showPendingUserMessage(selectedThreadId, message, rawUserMessage);
  if (prompt.value.trim() === message) prompt.value = '';
  prompt.style.height = 'auto';
  try {
    const pageSnapshot = includePageContext ? await collectPageContext(contextGeneration) : undefined;
    let threadId = selectedThreadId;
    if (!threadId) {
      const started = await client.request('thread/start', {
        ...(selectedWorkspace ? { cwd: selectedWorkspace.cwd } : {}),
        chrome: {
          title: message.split(/\r?\n/u)[0] || attachments[0]?.name || t('untitled'),
          ...(selectedWorkspace ? { workspaceSelectionToken: selectedWorkspace.selectionToken, draftId: selectedDraftId } : {}),
        },
      });
      threadId = started.thread.id;
      createdThreadId = threadId;
      currentCwd = started.thread.cwd || currentCwd;
      draftWorkspaceSelection = null;
      draftId = crypto.randomUUID();
      if (explicitPermissionMode)
        draftPermissionSelection = { threadId, draftId, mode: explicitPermissionMode };
      const option = document.createElement('option');
      option.value = threadId;
      option.textContent = started.thread.name || message.split(/\r?\n/u)[0] || t('untitled');
      sessionSelect.append(option);
      sessionSelect.value = threadId;
      pendingUserMessage.threadId = threadId;
      renderThreadMessages(projectThreadMessages(streamView(threadId).project()), threadId);
      webLaunchPanel?.updateSelection();
    }
    preparedThreadId = threadId;
    const pageContext = pageSnapshot
      ? await pageContextForTurn(contextGeneration, pageSnapshot)
      : undefined;
    submissionScopeThreadId = threadId;
    streamView(threadId).start(message, rawUserMessage, clientTurnId);
    // Once the thread exists, its stream owns the optimistic user bubble.
    // The pre-thread placeholder must not be merged into that projection again.
    pendingUserMessage = null;
    renderThreadMessages(projectThreadMessages(streamView(threadId).project()), threadId);
    const turnRequest = {
      threadId,
      input: [
        ...(message ? [{ type: 'text', text: message }] : []),
        ...attachments.filter(attachment => attachment.mimeType.startsWith('image/'))
          .map(attachment => ({ type: 'image', url: `data:${attachment.mimeType};base64,${attachment.base64Data}` })),
      ],
      ...(modelRef ? { model: modelRef } : {}),
      chrome: {
        clientTurnId,
        ...(attachments.some(attachment => !attachment.mimeType.startsWith('image/'))
          ? { attachments: attachments.filter(attachment => !attachment.mimeType.startsWith('image/')) } : {}),
        permissionMode,
        ...(pageContext && contextGeneration === pageContextGeneration ? { pageContext } : {}),
      },
    };
    pendingSubmissions.set(threadId, {
      clientTurnId,
      startedAt: sendingStartedAt,
      request: turnRequest,
      uncertain: false,
    });
    turnRequestStarted = true;
    const startedTurn = await client.request('turn/start', turnRequest);
    if (selectedDraftPermission(threadId) === permissionMode) draftPermissionSelection = null;
    pendingSubmissions.delete(threadId);
    if (!settledTurns.has(`${threadId}/${startedTurn?.turn?.id}`)) {
      setRunningTurn(threadId, startedTurn?.turn?.id, undefined, true);
      applyTurnObservation(threadId, startedTurn?.chrome?.activeTurn, startedTurn?.turn?.id);
    }
    clearAttachments();
    await refreshAll(threadId);
  } catch (error) {
    const threadId = preparedThreadId || createdThreadId || selectedThreadId;
    if (turnRequestStarted && error?.requestSent !== false) {
      approvals.cancelTurn(threadId, clientTurnId);
      const pending = pendingSubmissions.get(threadId);
      // Native acceptance can race the transport failure. Keep that exact run
      // available for Stop; otherwise freeze the original submission to read it.
      if (pending) pending.uncertain = true;
      if (createdThreadId) await refreshAll(createdThreadId);
      showError(t('unknownSend'));
    } else {
      pendingSubmissions.delete(threadId);
      if (threadId) streamView(threadId).cancelStart(clientTurnId);
      clearPendingUserMessage();
      if (threadId && threadId === sessionSelect.value)
        renderThreadMessages(projectThreadMessages(streamView(threadId).project()), threadId);
      if (!prompt.value) {
        prompt.value = message;
        prompt.dispatchEvent(new Event('input'));
      }
      if (createdThreadId) await refreshAll(createdThreadId);
      showError(error);
    }
  } finally {
    sending = false;
    submissionScopeThreadId = '';
    updateComposerDisabledState();
    updateActivity();
    // A server request can arrive before admission returns. Keep subsequent
    // typing inside its answer field, especially when the answer is secret.
    if (!decisionDialog.open && !questions.hasPending && !approvalPending()) prompt.focus();
  }
}

async function stopCurrentTurn() {
  if (
    !activeThreadId ||
    !activeTurnId ||
    knownTurns.get(activeThreadId)?.uncertain ||
    sending ||
    !transportReady
  )
    return;
  const threadId = activeThreadId;
  approvals.cancelTurn(threadId, activeTurnId);
  clearQuestions();
  stoppingThreadId = threadId;
  sending = true;
  updateComposerDisabledState();
  clearError();
  updateActivity();
  try {
    await client.request('turn/interrupt', {
      threadId: activeThreadId,
      ...(activeTurnId ? { turnId: activeTurnId } : {}),
    });
    await refreshAll(sessionSelect.value);
  } catch (error) {
    if (error?.requestSent === false) stoppingThreadId = '';
    showError(error?.requestSent === false ? error : t('unknownStop'));
  } finally {
    sending = false;
    updateComposerDisabledState();
    updateActivity();
  }
}

sessionSelect.addEventListener('change', () => {
  approvals.cancelAll();
  clearQuestions();
  workspace.invalidate();
  draftWorkspaceSelection = null;
  draftId = crypto.randomUUID();
  draftPermissionSelection = null;
  const nextThread = sessionSelect.value;
  webLaunchPanel.updateSelection();
  if (!webLaunchPanel.inputAssociated()) {
    clearAttachments();
    updateActivity();
    void refreshAll(nextThread);
    return;
  }
  void (async () => {
    if (!(await webLaunchPanel.beforeSwitch(nextThread))) {
      updateComposerDisabledState();
      return;
    }
    clearAttachments();
    await refreshAll(nextThread);
  })();
});
permissionSelect.addEventListener('change', () => {
  if (
    permissionSelect.value === 'full' &&
    lastPermissionMode !== 'full' &&
    !globalThis.confirm(t('fullConfirm'))
  ) {
    permissionSelect.value = lastPermissionMode;
    return;
  }
  lastPermissionMode = permissionSelect.value;
  if (!webLaunchPanel?.inputAssociated())
    draftPermissionSelection = { threadId: sessionSelect.value, draftId, mode: permissionSelect.value };
  updateComposerDisabledState();
  webLaunchPanel?.edit();
});
modelSelect.addEventListener('change', () => {
  modelSelect.title = modelSelect.selectedOptions[0]?.textContent || '';
  webLaunchPanel?.edit('model');
});
fileInput.addEventListener('change', () => {
  void addAttachments(fileInput.files ?? [])
    .catch(showError)
    .finally(() => {
      fileInput.value = '';
    });
});
send.addEventListener('click', () => {
  if (decisionDialog.open || switchingScope) return;
  const webAction = selectedWebAction();
  if (webAction?.type === 'stop')
    void webLaunchPanel.stop(activeThreadId === sessionSelect.value ? activeTurnId : '');
  else if (webAction?.type === 'send') void webLaunchPanel.submit('confirmed');
  else if (isCurrentThreadRunning(activeThreadId, sessionSelect.value)) void stopCurrentTurn();
  else void submit();
});
prompt.addEventListener('keydown', event => {
  if (event.isComposing) return;
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    if (selectedWebAction()?.type === 'stop' || isCurrentThreadRunning(activeThreadId, sessionSelect.value)) return;
    void submit();
  }
});
prompt.addEventListener('input', event => {
  webLaunchPanel?.edit(event.isComposing ? undefined : 'prompt');
  prompt.style.height = 'auto';
  prompt.style.height = `${Math.min(prompt.scrollHeight, 180)}px`;
  updateComposerDisabledState();
});
refreshButton.addEventListener('click', () => void refreshAll());
settingsButton.addEventListener('click', () => chrome.runtime.openOptionsPage());

function onPanelTabActivated({ tabId, windowId }) {
  if (!globalPanel || windowId !== panelWindowId) return;
  pageContextGeneration += 1;
  activePanelTabId = tabId;
  scopeButton.disabled = switchingScope;
}

function onPanelTabReplaced(addedTabId, removedTabId) {
  if (!globalPanel || activePanelTabId !== removedTabId) return;
  pageContextGeneration += 1;
  activePanelTabId = addedTabId;
}

function onPanelTabAttached(tabId, { newWindowId }) {
  if (tabId !== boundTabId) return;
  panelWindowId = newWindowId;
  scopeButton.disabled = switchingScope;
}

function onPanelTabDetached(tabId) {
  invalidatePageContext(tabId);
  if (tabId !== boundTabId) return;
  panelWindowId = undefined;
  scopeButton.disabled = true;
}

function composerWorkPending() {
  return sending || Boolean(stoppingThreadId) || pendingSubmissions.size > 0 || choosingWorkspace ||
    [...knownTurns.values()].some(turn => turn.uncertain);
}

function scopeHasUnfinishedWork() {
  return composerWorkPending() || approvalPending() || questionPending() ||
    attachmentReadsInFlight > 0 || pendingAttachments.length > 0 || Boolean(prompt.value.trim()) ||
    hasDraftSettings();
}

function hasDraftSettings() {
  return Boolean(draftWorkspaceSelection || selectedDraftPermission(sessionSelect.value));
}

function publishGlobalDraftState() {
  if (!globalPanel || panelWindowId === undefined) return;
  const busy = scopeHasUnfinishedWork();
  if (busy === lastGlobalDraftState) return;
  lastGlobalDraftState = busy;
  void chrome.runtime.sendMessage({ type: SidePanelMessage.GlobalDraftState, windowId: panelWindowId, busy })
    .then(result => {
      if (!result?.ok && lastGlobalDraftState === busy) lastGlobalDraftState = undefined;
    }, () => {
      if (lastGlobalDraftState === busy) lastGlobalDraftState = undefined;
    });
}

function initializePanelScope() {
  if ((!globalPanel && boundTabId === null) || !supportsGlobalSidePanel(globalThis.chrome)) return;
  scopeButton.hidden = false;
  scopeButton.setAttribute('aria-pressed', String(globalPanel));
  scopeButton.title = t(globalPanel ? 'panelScopeGlobal' : 'panelScopeTab');
  scopeButton.addEventListener('click', async () => {
    if (switchingScope || activePanelTabId === null || panelWindowId === undefined) return;
    if (scopeHasUnfinishedWork() || webLaunchPanel?.inputAssociated()) {
      showError(t('panelScopeBusy'));
      return;
    }
    switchingScope = true;
    scopeButton.disabled = true;
    updateComposerDisabledState();
    try {
      const result = await chrome.runtime.sendMessage({
        type: SidePanelMessage.SwitchScope,
        windowId: panelWindowId,
        tabId: activePanelTabId,
        selection: sessionSelect.value,
      });
      if (!result?.ok) {
        showError(t(result?.otherWindowBusy ? 'panelScopeOtherWindowBusy'
          : result?.panelBusy ? 'panelScopeBusy' : 'panelScopeFailed'));
      }
    } catch {
      showError(t('panelScopeFailed'));
    } finally {
      switchingScope = false;
      scopeButton.disabled = panelWindowId === undefined;
      updateComposerDisabledState();
    }
  });
  scopeSelection = (async () => {
    if (globalPanel) {
      panelWindowId = (await chrome.windows.getCurrent()).id;
      const [tab] = await contextTabs.query({ active: true, windowId: panelWindowId });
      activePanelTabId ??= tab?.id ?? null;
    } else {
      const tab = await contextTabs.get(boundTabId);
      panelWindowId = tab.windowId;
    }
    if (panelWindowId === undefined) return undefined;
    scopeButton.disabled = activePanelTabId === null;
    publishGlobalDraftState();
    const result = await chrome.runtime.sendMessage({
      type: SidePanelMessage.RestoreSelection,
      windowId: panelWindowId,
      tabId: boundTabId,
    });
    return result?.selection;
  })().catch(() => undefined);
}

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) void refreshAll();
});
if (boundTabId !== null || globalPanel) {
  contextTabs?.onUpdated?.addListener(onPageTabUpdated);
  contextTabs?.onDetached?.addListener(onPanelTabDetached);
  contextTabs?.onAttached?.addListener(onPanelTabAttached);
  contextTabs?.onActivated?.addListener(onPanelTabActivated);
  contextTabs?.onReplaced?.addListener(onPanelTabReplaced);
  contextTabs?.onRemoved?.addListener(invalidatePageContext);
}
window.addEventListener('unload', () => {
  if (boundTabId !== null || globalPanel) {
    pageContextGeneration += 1;
    contextTabs?.onUpdated?.removeListener(onPageTabUpdated);
    contextTabs?.onDetached?.removeListener(onPanelTabDetached);
    contextTabs?.onAttached?.removeListener(onPanelTabAttached);
    contextTabs?.onActivated?.removeListener(onPanelTabActivated);
    contextTabs?.onReplaced?.removeListener(onPanelTabReplaced);
    contextTabs?.onRemoved?.removeListener(invalidatePageContext);
  }
  addMenu.dispose();
  decisionObserver.disconnect();
  if (decisionDialog.open) decisionDialog.close();
  workspace.dispose();
  questions.dispose();
  approvals.dispose();
  webLaunchPanel?.dispose();
  client.disconnect();
  activityView.dispose();
  messageRenderer.dispose();
  if (streamRenderTimer !== null) clearTimeout(streamRenderTimer);
}, { once: true });

webLaunchPanel = createWebLaunchPanel({
  document,
  tabId: boundTabId,
  readComposer: () => ({
    prompt: prompt.value,
    threadId: sessionSelect.value,
    modelRef: modelSelect.value,
    permissionMode: permissionSelect.value,
    attachments: pendingAttachments.length,
    attachmentReads: attachmentReadsInFlight,
    ready: composerReady && transportReady,
    busy: sending || approvalPending() || questionPending(),
    scopeBusy: composerWorkPending() || hasDraftSettings(),
  }),
  installComposer: input => {
    if (input.threadId !== undefined && input.threadId !== sessionSelect.value) {
      clearQuestions();
      workspace.invalidate();
      draftWorkspaceSelection = null;
      draftId = crypto.randomUUID();
      draftPermissionSelection = null;
    }
    if (input.threadId !== undefined && input.threadId !== sessionSelect.value) approvals.cancelAll();
    if (input.clearPrompt) prompt.value = '';
    if (typeof input.prompt === 'string') prompt.value = input.prompt;
    if (input.permissionMode) {
      permissionSelect.value = input.permissionMode;
      lastPermissionMode = input.permissionMode;
      modelSelect.value = '';
    }
    if (input.includePage !== undefined) includePage.checked = input.includePage;
    if (
      input.threadId &&
      ![...sessionSelect.options].some(option => option.value === input.threadId)
    ) {
      const option = sessionSelect.querySelector('option[hidden]') ?? document.createElement('option');
      option.value = input.threadId;
      option.textContent = t('newChat');
      // Keep the draft selected without adding it to the conversation picker.
      option.hidden = true;
      option.disabled = true;
      sessionSelect.append(option);
    }
    if (input.threadId !== undefined) {
      sessionSelect.value = input.threadId;
      webLaunchPanel?.updateSelection();
    }
    prompt.style.height = 'auto';
    prompt.style.height = `${Math.min(prompt.scrollHeight, 180)}px`;
  },
  refreshThread: threadId => refreshAll(threadId),
  onSubmitInput: ({ launchId, threadId, prompt: submittedPrompt }) => {
    if (threadId !== sessionSelect.value || threadId !== subscribedThreadId) return;
    const view = streamView(threadId);
    view.start(submittedPrompt.trim(), undefined, launchId);
    renderThreadMessages(projectThreadMessages(view.project()), threadId);
  },
  onWithdrawSubmitInput: ({ launchId, threadId }) => {
    const view = streamViews.get(threadId);
    if (!view) return;
    view.cancelStart(launchId);
    if (threadId === sessionSelect.value && threadId === subscribedThreadId)
      renderThreadMessages(projectThreadMessages(view.project()), threadId);
  },
  onReceipt: response => {
    const threadId = response.threadId;
    const turnId = response.internal?.clientTurnId;
    const execution = response.receipt?.execution;
    const launchId = response.receipt?.launchId;
    const view = threadId && streamViews.get(threadId);
    if (view && launchId && turnId && response.matchesSubmission && response.internal?.notSent !== true) {
      let changed = view.identifyInput(launchId, turnId);
      if (execution?.executionSettled === true)
        changed = view.finishSubmission(launchId, response.internal?.nativeRunId) || changed;
      if (changed && threadId === sessionSelect.value && threadId === subscribedThreadId)
        renderThreadMessages(projectThreadMessages(view.project()), threadId);
    }
    const expectedTurnId = pendingSubmissions.get(threadId)?.clientTurnId || knownTurns.get(threadId)?.id;
    if (
      threadId &&
      turnId &&
      execution?.status === 'running' &&
      !settledTurns.has(`${threadId}/${turnId}`) &&
      (!expectedTurnId || expectedTurnId === turnId)
    ) {
      if (threadId === sessionSelect.value)
        setRunningTurn(threadId, turnId, response.internal?.nativeRunId, true);
      else
        knownTurns.set(threadId, {
          id: turnId,
          nativeRunId: response.internal?.nativeRunId,
          uncertain: false,
          startedAt: knownTurns.get(threadId)?.startedAt || Date.now(),
        });
    }
    if (
      threadId &&
      turnId &&
      execution?.executionSettled === true &&
      ['completed', 'failed', 'interrupted'].includes(execution.status) &&
      expectedTurnId === turnId &&
      knownTurns.get(threadId)?.id === turnId
    ) {
      recordTurnCompletion(threadId, { id: turnId, status: execution.status });
      if (response.isCurrentLaunch === false && threadId === sessionSelect.value)
        void refreshAll(threadId);
    }
  },
  onChange: () => {
    updateComposerDisabledState();
    updateActivity();
  },
  onError: showError,
  onClearError: clearError,
  isTurnSettled: (threadId, turnId) => settledTurns.has(`${threadId}/${turnId}`),
});
initializePanelScope();
void refreshAll();
