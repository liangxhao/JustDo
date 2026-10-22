import { initializeAppearance } from './modules/appearance.js';
import { AppServerClient } from './modules/conversation-client.js';
import {
  isCurrentThreadRunning,
  mergePendingUserMessage,
  messagesFromThread,
  shouldShowTurnError,
} from './modules/sidepanel-state.js';
import { BrowserExtensionStream } from './modules/sidepanel-stream.js';
import { createMessageRenderer } from './modules/sidepanel-messages.js';
import { createRunActivityView } from './modules/sidepanel-activity.js';
import {
  localizeSidePanel,
  sidePanelConnectionError,
  sidePanelText as t,
} from './modules/sidepanel-i18n.js';

void initializeAppearance();
localizeSidePanel(document);

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
const activityView = createRunActivityView(document.getElementById('runActivity'));
const messageRenderer = createMessageRenderer(messages, {
  latestButton: document.getElementById('latest'),
  processDetailsButton: document.getElementById('processDetails'),
  readImage: async (threadId, source) =>
    (await client.request('thread/image', { threadId, source })).dataUrl,
});
let sending = false;
let transportReady = false;
let sendingStartedAt = 0;
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

function streamView(threadId) {
  if (!streamViews.has(threadId)) {
    // Keep only a bounded set of temporary UI projections.
    if (streamViews.size >= 8) {
      const oldest = streamViews.keys().next().value;
      streamViews.delete(oldest);
      pendingCompletions.delete(oldest);
    }
    streamViews.set(threadId, new BrowserExtensionStream(threadId));
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
  const view = streamView(thread.id);
  view.setHistory(thread);
  renderThreadMessages(projectThreadMessages(view.project()), thread.id);
  updateActivity();
}

const MAX_ATTACHMENT_COUNT = 5;
const MAX_ATTACHMENT_BYTES = 4 * 1024 * 1024;

const client = new AppServerClient((method, params) => {
  if (method === 'thread/stream') {
    if (!streamView(params.threadId).accept(params)) return;
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
    refreshGeneration += 1;
    transportReady = false;
    setComposerReady(false);
    errorLine.textContent = t('reconnecting');
    errorLine.classList.remove('hidden');
    updateActivity();
  }
  if (method === 'connection/failed') {
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
    setRunningTurn(params.threadId, params?.turn?.id, params?.turn?.nativeRunId, true);
  }
  if (method === 'thread/updated' && params?.threadId === sessionSelect.value) {
    renderHistory(params.thread);
  }
  if (method === 'turn/completed' && params?.threadId !== sessionSelect.value) {
    if (params?.turn?.executionSettled !== true || !params.turn.id) return;
    const expectedId =
      knownTurns.get(params.threadId)?.id ||
      pendingSubmissions.get(params.threadId)?.clientTurnId ||
      streamViews.get(params.threadId)?.project().activity?.runId;
    if (!expectedId || expectedId !== params.turn.id) return;
    pendingSubmissions.delete(params.threadId);
    knownTurns.delete(params.threadId);
    rememberSettledTurn(params.threadId, params.turn.id);
    pendingCompletions.set(params.threadId, params.turn);
    streamViews.get(params?.threadId)?.finish(true);
  }
  if (method === 'turn/completed' && params?.threadId === sessionSelect.value) {
    if (params?.turn?.executionSettled !== true || !params.turn.id) return;
    const pending = pendingSubmissions.get(params.threadId);
    const expectedId =
      knownTurns.get(params.threadId)?.id ||
      pending?.clientTurnId ||
      streamViews.get(params.threadId)?.project().activity?.runId;
    if (!expectedId || params.turn.id !== expectedId) return;
    const completedThreadId = params.threadId;
    pendingSubmissions.delete(completedThreadId);
    knownTurns.delete(completedThreadId);
    rememberSettledTurn(completedThreadId, params.turn.id);
    if (stoppingThreadId === completedThreadId) stoppingThreadId = '';
    pendingCompletions.set(completedThreadId, params.turn);
    setRunningTurn('', '');
    void refreshAll(completedThreadId);
  }
});

function rememberSettledTurn(threadId, turnId) {
  settledTurns.add(`${threadId}/${turnId}`);
  if (settledTurns.size > 48) settledTurns.delete(settledTurns.values().next().value);
}

function setRunningTurn(threadId, turnId, nativeRunId, confirmed = false) {
  activeThreadId = typeof threadId === 'string' ? threadId : '';
  activeTurnId = typeof turnId === 'string' ? turnId : '';
  send.classList.toggle('stop', Boolean(activeThreadId));
  send.title = t(activeThreadId ? 'stop' : 'send');
  send.setAttribute('aria-label', send.title);
  if (activeThreadId && activeTurnId) {
    const previous = knownTurns.get(activeThreadId);
    knownTurns.set(activeThreadId, {
      id: activeTurnId,
      nativeRunId:
        nativeRunId || (previous?.id === activeTurnId ? previous.nativeRunId : undefined),
      uncertain: !confirmed && previous?.id === activeTurnId && previous.uncertain === true,
      startedAt: previous?.id === activeTurnId ? previous.startedAt : Date.now(),
    });
    const known = knownTurns.get(activeThreadId);
    if (known.nativeRunId && !known.uncertain) {
      const view = streamView(activeThreadId);
      if (view.bindRun(known.nativeRunId) && activeThreadId === sessionSelect.value) {
        renderThreadMessages(projectThreadMessages(view.project()), activeThreadId);
      }
    }
  }
  updateComposerDisabledState();
  updateActivity();
}

function updateActivity() {
  const threadId = sessionSelect.value;
  const activity = streamViews.get(threadId)?.project().activity ?? null;
  let fallback = null;
  if (pendingSubmissions.get(threadId)?.uncertain)
    fallback = { stage: 'checking', startedAt: pendingSubmissions.get(threadId).startedAt };
  else if (knownTurns.get(threadId)?.uncertain)
    fallback = { stage: 'checking', startedAt: knownTurns.get(threadId).startedAt };
  else if (stoppingThreadId === threadId && threadId) fallback = { stage: 'stopping' };
  else if (sending && !activeThreadId) fallback = { stage: 'sending', startedAt: sendingStartedAt };
  else if (isCurrentThreadRunning(activeThreadId, threadId) && !activity)
    fallback = { stage: 'starting' };
  if (!transportReady && (activity || fallback)) fallback = { ...fallback, stage: 'checking' };
  activityView.render(activity, fallback);
}

function updateComposerDisabledState() {
  const currentThreadRunning = isCurrentThreadRunning(activeThreadId, sessionSelect.value);
  const pending =
    pendingSubmissions.get(sessionSelect.value)?.uncertain === true ||
    knownTurns.get(sessionSelect.value)?.uncertain === true;
  sessionSelect.disabled = sending;
  attachButton.disabled = sending || pending || attachmentReadsInFlight > 0;
  fileInput.disabled = sending || pending || attachmentReadsInFlight > 0;
  includePage.disabled = sending || pending;
  permissionSelect.disabled = !composerReady || sending || pending;
  modelSelect.disabled = !composerReady || sending || pending;
  send.disabled =
    sending ||
    !transportReady ||
    pending ||
    (currentThreadRunning && !activeTurnId) ||
    (stoppingThreadId === sessionSelect.value && Boolean(stoppingThreadId)) ||
    attachmentReadsInFlight > 0 ||
    (!currentThreadRunning && (!composerReady || !prompt.value.trim()));
}

function setComposerReady(ready) {
  composerReady = ready;
  updateComposerDisabledState();
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
  const projected = mergePendingUserMessage(entries, pendingUserMessage, threadId);
  if (projected === entries && pendingUserMessage?.threadId === threadId) {
    pendingUserMessage = null;
  }
  renderMessages(projected);
  updateActivity();
}

function showPendingUserMessage(threadId, text) {
  pendingUserMessage = {
    threadId,
    text,
    persistedMatches: currentEntries.filter(entry => entry.role === 'user' && entry.text === text)
      .length,
  };
  renderThreadMessages(currentEntries, threadId);
}

function clearPendingUserMessage() {
  pendingUserMessage = null;
  renderMessages(currentEntries);
}

async function refreshSessions(preferredSessionId, generation) {
  const current = preferredSessionId ?? sessionSelect.value;
  const result = await client.request('thread/list');
  if (generation !== refreshGeneration) return false;
  sessionSelect.replaceChildren();
  const createOption = document.createElement('option');
  createOption.value = '';
  createOption.textContent = t('newChat');
  sessionSelect.append(createOption);
  for (const entry of result.data ?? []) {
    const option = document.createElement('option');
    option.value = entry.id;
    const title = entry.name ?? entry.preview ?? t('untitled');
    option.textContent = entry.status?.type === 'active' ? `${title} · ${t('working')}` : title;
    sessionSelect.append(option);
  }
  if ([...sessionSelect.options].some(option => option.value === current)) {
    sessionSelect.value = current;
  }
  const selectedThread = (result.data ?? []).find(entry => entry.id === sessionSelect.value);
  if (selectedThread?.status?.type === 'active') {
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

async function refreshComposerOptions(threadId, generation) {
  const result = await client.request('composer/options', {
    ...(threadId ? { threadId } : {}),
  });
  if (generation !== refreshGeneration || sessionSelect.value !== threadId) return;
  permissionSelect.value = result.permissionMode ?? 'full';
  lastPermissionMode = permissionSelect.value;
  modelSelect.replaceChildren();
  const models = Array.isArray(result.models) ? result.models : [];
  if (!result.modelRef) {
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = t(models.length ? 'selectModel' : 'defaultModel');
    placeholder.disabled = models.length > 0;
    modelSelect.append(placeholder);
  }
  for (const entry of models) {
    const option = document.createElement('option');
    option.value = entry.id;
    option.textContent = entry.name || entry.id;
    option.title = entry.id;
    modelSelect.append(option);
  }
  modelSelect.value = result.modelRef ?? '';
  modelSelect.title = modelSelect.selectedOptions[0]?.textContent || '';
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
  const result = await client.request('thread/read', {
    includeTurns: true,
    threadId,
    ...(expectedTurnId ? { turnId: expectedTurnId } : {}),
  });
  if (generation !== refreshGeneration || sessionSelect.value !== threadId) {
    if (sessionSelect.value !== threadId && subscribedThreadId !== threadId) {
      void client.request('thread/unsubscribe', { threadId }).catch(() => {});
    }
    return;
  }
  const previousThreadId = subscribedThreadId;
  subscribedThreadId = threadId;
  if (previousThreadId && previousThreadId !== threadId) {
    void client.request('thread/unsubscribe', { threadId: previousThreadId }).catch(() => {});
  }
  const observation = result.activeTurn ?? result.thread?.activeTurn;
  if (observation?.id && (!expectedTurnId || observation.id === expectedTurnId)) {
    if (observation.executionSettled === true) {
      pendingSubmissions.delete(threadId);
      knownTurns.delete(threadId);
      rememberSettledTurn(threadId, observation.id);
      if (stoppingThreadId === threadId) stoppingThreadId = '';
      setRunningTurn('', '');
      pendingCompletions.set(threadId, observation);
    } else if (observation.status === 'inProgress') {
      if (pendingSubmissions.has(threadId)) clearAttachments();
      pendingSubmissions.delete(threadId);
      setRunningTurn(threadId, observation.id, observation.nativeRunId, true);
    } else if (observation.status === 'unknown') {
      const previous = knownTurns.get(threadId);
      knownTurns.set(threadId, {
        id: observation.id,
        nativeRunId: observation.nativeRunId,
        uncertain: true,
        startedAt: previous?.id === observation.id ? previous.startedAt : Date.now(),
      });
      updateComposerDisabledState();
      updateActivity();
    }
  }
  const completed = pendingCompletions.get(threadId);
  if (completed) {
    const view = streamView(threadId);
    view.setHistory(result.thread, true);
    view.finish(completed.status === 'interrupted');
    pendingCompletions.delete(threadId);
    renderThreadMessages(projectThreadMessages(view.project()), threadId);
    if (completed.error?.message && shouldShowTurnError(threadId, sessionSelect.value, true)) {
      showError(completed.error.message);
    }
  } else {
    renderHistory(result.thread);
  }
}

async function refreshAll(preferredSessionId) {
  const generation = ++refreshGeneration;
  setComposerReady(false);
  clearError();
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
    if (generation === refreshGeneration) showError(error);
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

async function collectPageContext() {
  if (!includePage.checked) return undefined;
  try {
    await chrome.permissions.request({ origins: ['http://*/*', 'https://*/*'] });
  } catch {
    // The title and URL remain available if the user declines page-text access.
  }
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return undefined;
  let selectedText = '';
  let pageText = '';
  try {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => ({
        selectedText: globalThis.getSelection?.()?.toString() ?? '',
        pageText: (document.querySelector('main')?.innerText || document.body?.innerText || '')
          .replace(/[\t ]+/gu, ' ')
          .replace(/\n{3,}/gu, '\n\n'),
      }),
    });
    selectedText =
      typeof result?.result?.selectedText === 'string'
        ? result.result.selectedText.slice(0, 16000)
        : '';
    pageText =
      typeof result?.result?.pageText === 'string' ? result.result.pageText.slice(0, 24000) : '';
  } catch {
    // Restricted browser pages still contribute their visible title and URL.
  }
  return { title: tab.title ?? '', url: tab.url ?? '', selectedText, pageText };
}

async function submit() {
  const message = prompt.value.trim();
  if (
    !message ||
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
  const modelRef = modelSelect.value;
  const permissionMode = permissionSelect.value;
  const includePageContext = includePage.checked;
  let createdThreadId = '';
  let preparedThreadId = '';
  let turnRequestStarted = false;
  const clientTurnId = crypto.randomUUID();
  sending = true;
  sendingStartedAt = Date.now();
  updateComposerDisabledState();
  clearError();
  showPendingUserMessage(sessionSelect.value, message);
  if (prompt.value.trim() === message) prompt.value = '';
  prompt.style.height = 'auto';
  try {
    const pageContext = includePageContext ? await collectPageContext() : undefined;
    let threadId = sessionSelect.value;
    if (!threadId) {
      const started = await client.request('thread/start', { title: message.split(/\r?\n/u)[0] });
      threadId = started.thread.id;
      createdThreadId = threadId;
    }
    preparedThreadId = threadId;
    streamView(threadId).start(message, {
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
    });
    // Once the thread exists, its stream owns the optimistic user bubble.
    // The pre-thread placeholder must not be merged into that projection again.
    pendingUserMessage = null;
    renderThreadMessages(projectThreadMessages(streamView(threadId).project()), threadId);
    const turnRequest = {
      threadId,
      clientTurnId,
      input: [{ type: 'text', text: message }],
      ...(attachments.length ? { attachments } : {}),
      ...(modelRef ? { modelRef } : {}),
      permissionMode,
      ...(pageContext ? { pageContext } : {}),
    };
    pendingSubmissions.set(threadId, {
      clientTurnId,
      startedAt: sendingStartedAt,
      request: turnRequest,
      uncertain: false,
    });
    turnRequestStarted = true;
    const startedTurn = await client.request('turn/start', turnRequest);
    pendingSubmissions.delete(threadId);
    if (!settledTurns.has(`${threadId}/${startedTurn?.turn?.id}`)) {
      setRunningTurn(threadId, startedTurn?.turn?.id, startedTurn?.turn?.nativeRunId, true);
    }
    clearAttachments();
    await refreshAll(threadId);
  } catch (error) {
    const threadId = preparedThreadId || createdThreadId || sessionSelect.value;
    if (turnRequestStarted && error?.requestSent !== false) {
      const pending = pendingSubmissions.get(threadId);
      // Native acceptance can race the transport failure. Keep that exact run
      // available for Stop; otherwise freeze the original submission to read it.
      if (pending) pending.uncertain = true;
      if (createdThreadId) await refreshAll(createdThreadId);
      showError(t('unknownSend'));
    } else {
      pendingSubmissions.delete(threadId);
      if (threadId) streamView(threadId).cancelStart();
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
    updateComposerDisabledState();
    updateActivity();
    prompt.focus();
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
  clearAttachments();
  void refreshAll(sessionSelect.value);
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
});
modelSelect.addEventListener('change', () => {
  modelSelect.title = modelSelect.selectedOptions[0]?.textContent || '';
});
attachButton.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => {
  void addAttachments(fileInput.files ?? [])
    .catch(showError)
    .finally(() => {
      fileInput.value = '';
    });
});
send.addEventListener('click', () => {
  if (isCurrentThreadRunning(activeThreadId, sessionSelect.value)) void stopCurrentTurn();
  else void submit();
});
prompt.addEventListener('keydown', event => {
  if (event.isComposing) return;
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    if (isCurrentThreadRunning(activeThreadId, sessionSelect.value)) return;
    void submit();
  }
});
prompt.addEventListener('input', () => {
  prompt.style.height = 'auto';
  prompt.style.height = `${Math.min(prompt.scrollHeight, 180)}px`;
  updateComposerDisabledState();
});
refreshButton.addEventListener('click', () => void refreshAll());
settingsButton.addEventListener('click', () => chrome.runtime.openOptionsPage());
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) void refreshAll();
});
window.addEventListener('unload', () => {
  client.disconnect();
  activityView.dispose();
  messageRenderer.dispose();
  if (streamRenderTimer !== null) clearTimeout(streamRenderTimer);
});

void refreshAll();
