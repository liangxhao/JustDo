import { initializeAppearance } from './modules/appearance.js';
import { AppServerClient } from './modules/conversation-client.js';
import {
  isCurrentThreadRunning,
  mergePendingUserMessage,
  messagesFromThread,
  shouldShowTurnError,
  toolInputSummary,
} from './modules/sidepanel-state.js';
import {
  pendingInputLabel,
  renderRichContent,
  retryRichImages,
} from './modules/sidepanel-rich-content.js';
import { BrowserExtensionStream } from './modules/sidepanel-stream.js';

void initializeAppearance();

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
let sending = false;
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

function renderHistory(thread) {
  const view = streamView(thread.id);
  view.setHistory(thread);
  renderThreadMessages(messagesFromThread(view.project()), thread.id);
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
          renderThreadMessages(messagesFromThread(streamView(threadId).project()), threadId);
      }, 40);
    }
  }
  if (method === 'connection/closed') {
    refreshGeneration += 1;
    setRunningTurn('', '');
    setComposerReady(false);
    errorLine.textContent = 'Disconnected from __PRODUCT_NAME__. Reconnecting…';
    errorLine.classList.remove('hidden');
  }
  if (method === 'connection/reconnected') {
    // Completion may have happened while disconnected. Rehydrate from Gateway
    // rather than carrying an old running turn into the next run.
    streamViews.clear();
    pendingCompletions.clear();
    void refreshAll(sessionSelect.value);
  }
  if (method === 'turn/started' && params?.threadId === sessionSelect.value) {
    setRunningTurn(params.threadId, params?.turn?.id);
  }
  if (method === 'thread/updated' && params?.threadId === sessionSelect.value) {
    renderHistory(params.thread);
  }
  if (method === 'turn/completed' && params?.threadId !== sessionSelect.value) {
    streamViews.get(params?.threadId)?.finish();
  }
  if (method === 'turn/completed' && params?.threadId === sessionSelect.value) {
    const completedThreadId = params.threadId;
    pendingCompletions.set(completedThreadId, params.turn);
    setRunningTurn('', '');
    void refreshAll(completedThreadId);
  }
});

function setRunningTurn(threadId, turnId) {
  activeThreadId = typeof threadId === 'string' ? threadId : '';
  activeTurnId = typeof turnId === 'string' ? turnId : '';
  send.classList.toggle('stop', Boolean(activeThreadId));
  send.title = activeThreadId ? 'Stop' : 'Send';
  send.setAttribute('aria-label', send.title);
  updateComposerDisabledState();
}

function updateComposerDisabledState() {
  const currentThreadRunning = isCurrentThreadRunning(activeThreadId, sessionSelect.value);
  sessionSelect.disabled = sending;
  attachButton.disabled = sending || attachmentReadsInFlight > 0;
  fileInput.disabled = sending || attachmentReadsInFlight > 0;
  includePage.disabled = sending;
  permissionSelect.disabled = !composerReady || sending;
  modelSelect.disabled = !composerReady || sending;
  send.disabled =
    sending ||
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
  const wasEmpty = messages.childElementCount === 0;
  const wasNearBottom = messages.scrollHeight - messages.scrollTop - messages.clientHeight < 48;
  const previousScrollTop = messages.scrollTop;
  const processPreferences = new Map(
    [...messages.querySelectorAll('details.process-cluster')]
      .filter(element => element.dataset.userOpen !== undefined)
      .map(element => [element.dataset.processKey, element.dataset.userOpen]),
  );
  const openToolIds = new Set(
    [...messages.querySelectorAll('details.process-tool[open]')]
      .map(element => element.dataset.toolId)
      .filter(Boolean),
  );
  const previousNodes = [...messages.children];
  const nextNodes = [];
  if (!entries.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    const logo = document.createElement('img');
    logo.src = 'icons/icon128.png';
    logo.alt = '';
    const title = document.createElement('h1');
    title.textContent = 'What can I help with?';
    empty.append(logo, title);
    messages.replaceChildren(empty);
    return;
  }
  for (const entry of entries) {
    const index = nextNodes.length;
    const signature = JSON.stringify(entry);
    if (previousNodes[index]?.renderSignature === signature) {
      retryRichImages(previousNodes[index]);
      nextNodes.push(previousNodes[index]);
      continue;
    }
    if (entry.role === 'process') {
      const details = document.createElement('details');
      details.className = 'message process-cluster';
      details.dataset.processKey = entry.key;
      const preference = processPreferences.get(entry.key);
      if (preference !== undefined) details.dataset.userOpen = preference;
      details.open = preference === undefined ? entry.running === true : preference === 'true';
      const summary = document.createElement('summary');
      summary.className = 'process-cluster-title';
      summary.addEventListener('click', event => {
        event.preventDefault();
        details.open = !details.open;
        details.dataset.userOpen = String(details.open);
      });
      const icon = document.createElement('span');
      icon.className = 'process-cluster-icon';
      icon.textContent = '⌁';
      const label = document.createElement('span');
      label.textContent = entry.title;
      summary.append(icon, label);
      details.append(summary);
      const list = document.createElement('ol');
      list.className = 'process-items';
      for (const process of entry.items) {
        const row = document.createElement('li');
        row.className = `process-item ${process.type}${process.isError ? ' error-state' : ''}`;
        if (process.type === 'thinking') {
          const heading = document.createElement('strong');
          heading.textContent = process.title;
          const content = document.createElement('div');
          content.className = 'message-detail';
          content.textContent = process.text;
          row.append(heading, content);
        } else {
          const tool = document.createElement('details');
          tool.className = 'process-tool';
          if (process.id) {
            tool.dataset.toolId = process.id;
            tool.open = openToolIds.has(process.id);
          }
          const toolSummary = document.createElement('summary');
          toolSummary.className = 'process-tool-title';
          const status = document.createElement('span');
          const normalizedStatus = process.isError
            ? 'failed'
            : process.status === 'inProgress'
              ? 'running'
              : process.status || 'completed';
          status.className = `process-tool-status ${normalizedStatus}`;
          status.setAttribute('aria-label', normalizedStatus);
          const name = document.createElement('strong');
          name.textContent = process.title;
          const input = document.createElement('span');
          input.className = 'process-tool-input';
          input.textContent = toolInputSummary(process.input);
          toolSummary.append(status, name);
          if (input.textContent) toolSummary.append(input);
          tool.append(toolSummary);
          for (const [sectionLabel, value] of [
            ['Input', process.input],
            [process.isError ? 'Error' : 'Output', process.output],
          ]) {
            if (!value) continue;
            const section = document.createElement('section');
            const heading = document.createElement('strong');
            heading.textContent = sectionLabel;
            const content = document.createElement('pre');
            content.textContent = value;
            section.append(heading, content);
            tool.append(section);
          }
          row.append(tool);
        }
        list.append(row);
      }
      details.append(list);
      details.renderSignature = signature;
      nextNodes.push(details);
      continue;
    }
    const item = document.createElement('div');
    item.className = `message ${entry.role} markdown-content`;
    const threadId = sessionSelect.value;
    renderRichContent(item, entry, async source => {
      const result = await client.request('thread/image', { threadId, source });
      return result.dataUrl;
    });
    if (entry.pendingInput) {
      const label = document.createElement('small');
      label.className = 'pending-input-status';
      label.textContent = pendingInputLabel(
        entry.pendingInput.state,
        entry.pendingInput.incomplete,
      );
      item.append(label);
    }
    if (!item.childElementCount) continue;
    item.renderSignature = signature;
    nextNodes.push(item);
  }
  for (const [index, node] of nextNodes.entries()) {
    if (messages.children[index] !== node)
      messages.insertBefore(node, messages.children[index] ?? null);
  }
  while (messages.children.length > nextNodes.length) messages.lastElementChild.remove();
  messages.scrollTop = wasEmpty || wasNearBottom ? messages.scrollHeight : previousScrollTop;
}

function renderThreadMessages(entries, threadId = sessionSelect.value) {
  currentEntries = entries;
  const projected = mergePendingUserMessage(entries, pendingUserMessage, threadId);
  if (projected === entries && pendingUserMessage?.threadId === threadId) {
    pendingUserMessage = null;
  }
  renderMessages(projected);
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
  createOption.textContent = 'New chat';
  sessionSelect.append(createOption);
  for (const entry of result.data ?? []) {
    const option = document.createElement('option');
    option.value = entry.id;
    const title = entry.name ?? entry.preview ?? 'Untitled conversation';
    option.textContent = entry.status?.type === 'active' ? `${title} · working` : title;
    sessionSelect.append(option);
  }
  if ([...sessionSelect.options].some(option => option.value === current)) {
    sessionSelect.value = current;
  }
  const selectedThread = (result.data ?? []).find(entry => entry.id === sessionSelect.value);
  setRunningTurn(selectedThread?.status?.type === 'active' ? selectedThread.id : '', '');
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
    placeholder.textContent = models.length ? 'Select model' : 'Default model';
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
  const result = await client.request('thread/read', { includeTurns: true, threadId });
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
  const completed = pendingCompletions.get(threadId);
  if (completed) {
    const view = streamView(threadId);
    view.setHistory(result.thread, true);
    view.finish(completed.status === 'interrupted');
    pendingCompletions.delete(threadId);
    renderThreadMessages(messagesFromThread(view.project()), threadId);
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
      setComposerReady(true);
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
    remove.title = `Remove ${attachment.name}`;
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
    showError(`Attach at most ${MAX_ATTACHMENT_COUNT} files.`);
    return;
  }
  const existingBytes = pendingAttachments.reduce((total, item) => total + item.size, 0);
  const selectedBytes = selected.reduce((total, file) => total + file.size, 0);
  if (existingBytes + selectedBytes > MAX_ATTACHMENT_BYTES) {
    showError('Attachments must be 4 MB or less in total.');
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
      showError(`Attach at most ${MAX_ATTACHMENT_COUNT} files.`);
      return;
    }
    if (
      pendingAttachments.reduce((total, item) => total + item.size, 0) + selectedBytes >
      MAX_ATTACHMENT_BYTES
    ) {
      showError('Attachments must be 4 MB or less in total.');
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
  if (!message || sending || !composerReady || attachmentReadsInFlight > 0) return;
  const attachments = pendingAttachments.map(({ base64Data, mimeType, name }) => ({
    base64Data,
    mimeType,
    name,
  }));
  const modelRef = modelSelect.value;
  const permissionMode = permissionSelect.value;
  const includePageContext = includePage.checked;
  let createdThreadId = '';
  sending = true;
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
    renderThreadMessages(messagesFromThread(streamView(threadId).project()), threadId);
    const startedTurn = await client.request('turn/start', {
      threadId,
      input: [{ type: 'text', text: message }],
      ...(attachments.length ? { attachments } : {}),
      ...(modelRef ? { modelRef } : {}),
      permissionMode,
      ...(pageContext ? { pageContext } : {}),
    });
    setRunningTurn(threadId, startedTurn?.turn?.id);
    clearAttachments();
    await refreshAll(threadId);
  } catch (error) {
    const threadId = createdThreadId || sessionSelect.value;
    if (threadId) streamView(threadId).cancelStart();
    clearPendingUserMessage();
    if (threadId && threadId === sessionSelect.value) {
      renderThreadMessages(messagesFromThread(streamView(threadId).project()), threadId);
    }
    if (!prompt.value) {
      prompt.value = message;
      prompt.dispatchEvent(new Event('input'));
    }
    if (createdThreadId) await refreshAll(createdThreadId);
    showError(error);
  } finally {
    sending = false;
    updateComposerDisabledState();
    prompt.focus();
  }
}

async function stopCurrentTurn() {
  if (!activeThreadId || sending) return;
  sending = true;
  updateComposerDisabledState();
  clearError();
  try {
    await client.request('turn/interrupt', {
      threadId: activeThreadId,
      ...(activeTurnId ? { turnId: activeTurnId } : {}),
    });
    setRunningTurn('', '');
    await refreshAll(sessionSelect.value);
  } catch (error) {
    showError(error);
  } finally {
    sending = false;
    updateComposerDisabledState();
  }
}

sessionSelect.addEventListener('change', () => {
  streamViews.delete(sessionSelect.value);
  pendingCompletions.delete(sessionSelect.value);
  clearAttachments();
  void refreshAll(sessionSelect.value);
});
permissionSelect.addEventListener('change', () => {
  if (
    permissionSelect.value === 'full' &&
    lastPermissionMode !== 'full' &&
    !globalThis.confirm(
      'This conversation can access files outside the task folder and run host commands without approval. Enable full access?',
    )
  ) {
    permissionSelect.value = lastPermissionMode;
    return;
  }
  lastPermissionMode = permissionSelect.value;
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
window.addEventListener('unload', () => client.disconnect());

void refreshAll();
