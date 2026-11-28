import {
  isIncompleteFileLinkSource,
  messageCopyText,
  pendingInputLabel,
  processDetailLabels,
  renderRichContent,
  renderThinkingMarkdown,
  retryRichImages,
} from './sidepanel-rich-content.js';
import { createCopyController } from './sidepanel-copy.js';
import { sidePanelText as t } from './sidepanel-i18n.js';
import { toolDisplayTitle, toolInputSummary } from './sidepanel-state.js';

const THINKING_PREVIEW_LINES = 10;
let nextThinkingBodyId = 0;

function reconcileChildren(parent, nodes) {
  const retained = new Set(nodes);
  for (const child of [...parent.children]) if (!retained.has(child)) child.remove();
  for (const [index, node] of nodes.entries()) {
    if (parent.children[index] === node) continue;
    const before = parent.children[index] ?? null;
    // Modern Chromium preserves focus, selection and reader state during
    // connected moves. Detached lazy groups use ordinary insertion.
    if (parent.isConnected && node.isConnected && typeof parent.moveBefore === 'function')
      parent.moveBefore(node, before);
    else parent.insertBefore(node, before);
  }
}

function toolStatus(process) {
  return process.isError
    ? 'failed'
    : process.status === 'inProgress'
      ? 'running'
      : process.status || 'completed';
}

/** A keyed DOM view with temporary, scoped disclosure and reading preferences. */
export function createMessageRenderer(
  container,
  { readImage, openDelivery, openMessageFile, latestButton, processDetailsButton },
) {
  const document = container.ownerDocument;
  const copyController = createCopyController(container);
  const processLabels = processDetailLabels();
  const scopes = new Map();
  let currentScope = '';
  let scopeState = null;
  let following = true;
  let expectedScrollTop = null;
  let touchY = null;
  let currentEntries = [];
  let processSummariesExpanded = false;
  let entryNodes = new Map();
  let processRows = new Map();
  let interactionAnchor = null;

  function renderContent(host, entry) {
    const scope = currentScope;
    const isCurrent = () => scope === currentScope && container.contains(host);
    return renderRichContent(
      host,
      entry,
      source => readImage(scope, source),
      openDelivery && (async source => {
        if (isCurrent()) await openDelivery(scope, source);
      }),
      openMessageFile && (async link => {
        if (isCurrent()) await openMessageFile(scope, link);
      }),
    );
  }

  function updateProcessDetailsButton() {
    const label = t(
      processSummariesExpanded ? 'collapseAllProcessDetails' : 'expandAllProcessDetails',
    );
    processDetailsButton.title = label;
    processDetailsButton.setAttribute('aria-label', label);
    processDetailsButton.setAttribute('aria-pressed', String(processSummariesExpanded));
  }

  function disclosureOpen(key, kind) {
    if (kind === 'summary' && !processSummariesExpanded) return scopeState.openSummaryKey === key;
    return scopeState.preferences.get(key)?.open ?? (kind !== 'tool' && processSummariesExpanded);
  }

  function rememberDisclosure(details, scope) {
    scope.preferences.set(details.dataset.disclosureKey, {
      open: details.open,
      kind: details.disclosureKind,
    });
    if (details.disclosureKind === 'summary') {
      if (details.open) scope.openSummaryKey = details.dataset.disclosureKey;
      else if (scope.openSummaryKey === details.dataset.disclosureKey) scope.openSummaryKey = null;
    }
  }

  function setDisclosureOpen(details, open) {
    details.open = open;
    details.renderedOpen = open;
    details.firstElementChild?.setAttribute('aria-expanded', String(open));
  }

  function getScope(scope) {
    if (!scopes.has(scope)) {
      if (scopes.size >= 8) scopes.delete(scopes.keys().next().value);
      scopes.set(scope, {
        preferences: new Map(),
        openSummaryKey: null,
        scrollTop: 0,
        following: true,
      });
    }
    return scopes.get(scope);
  }

  function nearBottom() {
    return container.scrollHeight - container.scrollTop - container.clientHeight <= 48;
  }

  function showLatestButton() {
    latestButton.classList.toggle(
      'hidden',
      following || container.scrollHeight <= container.clientHeight,
    );
  }

  function setScroll(top) {
    container.scrollTop = top;
    expectedScrollTop = container.scrollTop;
  }

  function rememberDisclosures() {
    if (!scopeState) return;
    for (const details of container.querySelectorAll('details[data-disclosure-key]')) {
      // Read synchronously: the native toggle event can be queued behind a frame.
      // Renderer defaults and bulk choices must not become individual choices.
      if (details.open !== details.renderedOpen) {
        rememberDisclosure(details, scopeState);
        details.renderedOpen = details.open;
      }
    }
  }

  function captureReadingAnchor() {
    const top = container.getBoundingClientRect().top;
    for (const child of container.children) {
      const bounds = child.getBoundingClientRect();
      if (bounds.bottom > top) return { node: child, offset: bounds.top - top };
    }
    return null;
  }

  function isDisclosureTargetVisible(target) {
    for (
      let parent = target.parentElement;
      parent && parent !== container;
      parent = parent.parentElement
    ) {
      if (
        parent.tagName === 'DETAILS' &&
        !parent.open &&
        !parent.firstElementChild?.contains(target)
      )
        return false;
    }
    return true;
  }

  function hasNestedScrollRoom(target, deltaY) {
    for (
      let node = target instanceof Element ? target : null;
      node && node !== container;
      node = node.parentElement
    ) {
      if (node.scrollHeight <= node.clientHeight) continue;
      const overflow = document.defaultView.getComputedStyle(node).overflowY;
      if (overflow !== 'auto' && overflow !== 'scroll') continue;
      if (
        (deltaY < 0 && node.scrollTop > 0) ||
        (deltaY > 0 && node.scrollTop + node.clientHeight < node.scrollHeight - 1)
      )
        return true;
    }
    return false;
  }

  function pauseFollowing() {
    following = false;
    if (scopeState) scopeState.following = false;
    showLatestButton();
  }

  const onWheel = event => {
    if (!event.ctrlKey && event.deltaY < 0 && !hasNestedScrollRoom(event.target, event.deltaY))
      pauseFollowing();
  };
  const onTouchStart = event => {
    touchY = event.touches[0]?.clientY ?? null;
  };
  const onTouchMove = event => {
    const y = event.touches[0]?.clientY;
    if (touchY !== null && y !== undefined && y > touchY && !hasNestedScrollRoom(event.target, -1))
      pauseFollowing();
    touchY = y ?? null;
  };
  const onKeyDown = event => {
    const target = event.target;
    if (event.key === 'Escape' && !processSummariesExpanded && scopeState?.openSummaryKey) {
      const key = scopeState.openSummaryKey;
      const summary = [...container.querySelectorAll('[data-process-summary-key]')].find(
        element => element.dataset.processSummaryKey === key,
      );
      event.preventDefault();
      scopeState.openSummaryKey = null;
      view.render(currentEntries, currentScope);
      summary?.focus({ preventScroll: true });
      return;
    }
    if (
      target instanceof Element &&
      target.closest('input, textarea, select, [contenteditable="true"]')
    )
      return;
    if (['ArrowUp', 'PageUp', 'Home'].includes(event.key) && !hasNestedScrollRoom(target, -1))
      pauseFollowing();
  };
  const onScroll = () => {
    if (expectedScrollTop !== null && Math.abs(expectedScrollTop - container.scrollTop) < 1) {
      expectedScrollTop = null;
      return;
    }
    expectedScrollTop = null;
    const wasFollowing = following;
    following = following
      ? nearBottom()
      : container.scrollHeight - container.scrollTop - container.clientHeight <= 2;
    if (scopeState) {
      scopeState.following = following;
      scopeState.scrollTop = container.scrollTop;
    }
    if (following && !wasFollowing) refreshLiveThinking();
    showLatestButton();
  };
  const onLatest = () => {
    following = true;
    if (scopeState) scopeState.following = true;
    refreshLiveThinking();
    setScroll(container.scrollHeight);
    showLatestButton();
  };
  const onProcessDetails = () => {
    if (!scopeState) return;
    rememberDisclosures();
    processSummariesExpanded = !processSummariesExpanded;
    // Match desktop bulk controls: reset process choices, retain raw tool
    // readers, and keep current live feedback visible in the collapsed mode.
    for (const [key, choice] of scopeState.preferences) {
      if (choice.kind !== 'tool') scopeState.preferences.delete(key);
    }
    scopeState.openSummaryKey = null;
    view.render(currentEntries, currentScope);
  };
  container.addEventListener('wheel', onWheel, { passive: true });
  container.addEventListener('touchstart', onTouchStart, { passive: true });
  container.addEventListener('touchmove', onTouchMove, { passive: true });
  container.addEventListener('keydown', onKeyDown);
  container.addEventListener('scroll', onScroll, { passive: true });
  latestButton.addEventListener('click', onLatest);
  processDetailsButton.addEventListener('click', onProcessDetails);
  updateProcessDetailsButton();
  const resizeObserver =
    typeof ResizeObserver === 'function'
      ? new ResizeObserver(() => {
          if (following) setScroll(container.scrollHeight);
          showLatestButton();
        })
      : null;
  const thinkingResizeObserver =
    typeof ResizeObserver === 'function'
      ? new ResizeObserver(entries => {
          for (const { target } of entries) updateThinkingPreview(target);
        })
      : null;

  function createDisclosure(className, key, kind) {
    const details = document.createElement('details');
    details.className = className;
    details.dataset.disclosureKey = key;
    details.disclosureKind = kind;
    details.open = disclosureOpen(key, kind);
    details.renderedOpen = details.open;
    const summary = document.createElement('summary');
    summary.setAttribute('aria-expanded', String(details.open));
    const scope = scopeState;
    summary.addEventListener('click', event => {
      event.preventDefault();
      if (scope !== scopeState || !container.contains(details)) return;
      const bounds = summary.getBoundingClientRect();
      interactionAnchor = {
        node: summary,
        offset: bounds.top - container.getBoundingClientRect().top,
      };
      pauseFollowing();
      setDisclosureOpen(details, !details.open);
      rememberDisclosure(details, scope);
      details.onDisclosureOpen?.();
      view.render(currentEntries, currentScope);
    });
    details.addEventListener('toggle', () => {
      summary.setAttribute('aria-expanded', String(details.open));
      if (details.open && scope === scopeState && container.contains(details))
        details.onDisclosureOpen?.();
    });
    const chevron = document.createElement('span');
    chevron.className = 'disclosure-chevron';
    chevron.setAttribute('aria-hidden', 'true');
    chevron.textContent = '›';
    summary.append(chevron);
    details.append(summary);
    return details;
  }

  function updateThinkingPreview(content) {
    if (!container.contains(content) || !content.getBoundingClientRect().width) return;
    const viewport = content.parentElement;
    const toggle = viewport.nextElementSibling;
    const thinking = content.closest('.process-thinking');
    const preview = content.preview;
    const lineHeight = Number.parseFloat(document.defaultView.getComputedStyle(content).lineHeight);
    if (!Number.isFinite(lineHeight) || lineHeight <= 0) return;
    const overflow = Math.max(0, content.scrollHeight - lineHeight * THINKING_PREVIEW_LINES);
    toggle.hidden = overflow <= 1 && !preview.expanded;
    if (!preview.expanded && preview.tail &&
      (preview.settleTail || (following && thinking.dataset.status === 'running'))) {
      preview.offset = overflow;
    }
    preview.settleTail = false;
    preview.offset = Math.min(preview.offset, overflow);
    viewport.scrollTop = preview.expanded ? 0 : preview.offset;
    viewport.classList.toggle('has-hidden-prefix', !preview.expanded && preview.offset > 0);
  }

  function refreshLiveThinking() {
    for (const content of container.querySelectorAll(
      '.process-live .process-thinking[data-status="running"] .message-detail',
    )) {
      updateThinkingPreview(content);
    }
  }

  function patchThinkingDisclosure(content, expanded) {
    const viewport = content.parentElement;
    const toggle = viewport.nextElementSibling;
    content.preview.expanded = expanded;
    viewport.classList.toggle('is-expanded', expanded);
    const label = expanded ? processLabels.thinkingCollapse : processLabels.thinkingExpand;
    toggle.setAttribute('aria-expanded', String(expanded));
    toggle.setAttribute('aria-label', label);
    toggle.title = label;
  }

  function setThinkingExpanded(content, expanded) {
    const viewport = content.parentElement;
    const bubble = viewport.parentElement;
    const toggle = viewport.nextElementSibling;
    const preview = content.preview;
    if (preview.expanded === expanded) return;
    const anchor = expanded ? bubble : toggle;
    const previousTop = anchor.getBoundingClientRect().top;
    pauseFollowing();
    preview.settleTail = !expanded && preview.tail;
    patchThinkingDisclosure(content, expanded);
    updateThinkingPreview(content);
    setScroll(container.scrollTop + anchor.getBoundingClientRect().top - previousTop);
    showLatestButton();
  }

  function patchThinking(row, process) {
    let thinking = row.firstElementChild;
    if (!thinking) {
      thinking = document.createElement('div');
      thinking.className = 'process-thinking';
      const headingRow = document.createElement('div');
      headingRow.className = 'process-thinking-title';
      const marker = document.createElement('span');
      marker.className = 'process-thinking-marker';
      marker.setAttribute('aria-hidden', 'true');
      const heading = document.createElement('strong');
      headingRow.append(marker, heading);
      const bubble = document.createElement('div');
      bubble.className = 'process-thinking-bubble';
      const viewport = document.createElement('div');
      viewport.className = 'process-thinking-viewport';
      viewport.style.setProperty('--thinking-preview-lines', String(THINKING_PREVIEW_LINES));
      const content = document.createElement('div');
      content.className = 'message-detail markdown-content';
      content.id = `thinking-body-${++nextThinkingBodyId}`;
      content.preview = { expanded: false, tail: false, settleTail: false, offset: 0 };
      const toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'process-thinking-toggle';
      toggle.hidden = true;
      toggle.setAttribute('aria-controls', content.id);
      toggle.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 6 4 4 4-4"/></svg>';
      toggle.addEventListener('click', () => setThinkingExpanded(content, !content.preview.expanded));
      viewport.addEventListener('focusin', () => {
        if (!toggle.hidden) setThinkingExpanded(content, true);
      });
      viewport.append(content);
      bubble.append(viewport, toggle);
      thinking.append(headingRow, bubble);
      row.append(thinking);
      thinkingResizeObserver?.observe(content);
    }
    thinking.querySelector('strong').textContent = process.title;
    const content = thinking.querySelector('.message-detail');
    const status = toolStatus(process);
    const previousStatus = thinking.dataset.status;
    const text = process.text || '';
    const textChanged = content.sourceText !== text;
    thinking.dataset.status = status;
    if (textChanged) {
      if (content.sourceText === undefined || !text.startsWith(content.sourceText)) {
        content.preview.tail = status === 'running';
        content.preview.settleTail = content.preview.tail;
        content.preview.offset = 0;
        patchThinkingDisclosure(content, false);
      }
      copyController.invalidate(content);
      renderThinkingMarkdown(content, text);
      content.sourceText = text;
    }
    if (previousStatus === 'running' && status !== 'running' && following) {
      content.preview.settleTail = true;
    }
    if (textChanged || previousStatus !== status) updateThinkingPreview(content);
  }

  function patchTool(row, process, key) {
    let tool = row.firstElementChild;
    if (!tool) {
      tool = createDisclosure('process-tool', key, 'tool');
      if (process.id) tool.dataset.toolId = process.id;
      const summary = tool.firstElementChild;
      summary.className = 'process-tool-title';
      const status = document.createElement('span');
      status.className = 'process-tool-status';
      status.setAttribute('role', 'img');
      const name = document.createElement('strong');
      const input = document.createElement('span');
      input.className = 'process-tool-input';
      summary.prepend(status, name, input);
      const progress = document.createElement('div');
      progress.className = 'process-tool-progress';
      tool.append(progress);
      for (const name of ['input', 'output']) {
        const section = document.createElement('section');
        section.dataset.section = name;
        section.append(document.createElement('strong'), document.createElement('pre'));
        tool.append(section);
      }
      row.append(tool);
    }
    setDisclosureOpen(tool, disclosureOpen(key, 'tool'));
    const normalizedStatus = toolStatus(process);
    const status = tool.querySelector('.process-tool-status');
    status.className = `process-tool-status ${normalizedStatus}`;
    status.setAttribute('aria-label', t(normalizedStatus));
    status.title = t(normalizedStatus);
    const name = tool.querySelector('summary > strong');
    name.textContent = process.title;
    name.title = name.textContent;
    const input = tool.querySelector('.process-tool-input');
    const inputPreview =
      normalizedStatus === 'running' && process.progressText
        ? process.progressText
        : process.input;
    input.textContent = toolInputSummary(process.inputTitle ?? inputPreview);
    input.title = input.textContent;
    const progress = tool.querySelector('.process-tool-progress');
    progress.textContent = normalizedStatus === 'running' ? process.progressText || '' : '';
    progress.hidden = !progress.textContent;
    for (const [name, heading, value] of [
      ['input', processLabels.toolInput, process.input],
      ['output', processLabels.toolResult, process.output],
    ]) {
      const section = tool.querySelector(`[data-section="${name}"]`);
      section.hidden = !value;
      section.firstElementChild.textContent = heading;
      const pre = section.lastElementChild;
      if (pre.textContent !== (value || '')) pre.textContent = value || '';
    }
  }

  function processKey(process, parentKey, index = 0) {
    return process.key || `${parentKey}/${process.type}:${process.id || index}`;
  }

  function renderProcessRow(process, parentKey, index) {
    const key = processKey(process, parentKey, index);
    let row = processRows.get(key);
    if (!row) {
      row = document.createElement('li');
      row.dataset.itemKey = key;
      processRows.set(key, row);
    }
    row.className = `process-item ${process.type}${process.isError ? ' error-state' : ''}`;
    if (process.type === 'thinking') patchThinking(row, process);
    else patchTool(row, process, `tool:${key}`);
    return row;
  }

  function summaryLabel(thinkingCount, toolCount) {
    return thinkingCount && toolCount
      ? t('thinkingToolsSummary', { thinkingCount, toolCount })
      : t(thinkingCount ? 'thinkingSummary' : 'toolSummary', { count: thinkingCount || toolCount });
  }

  function createProcessSummary(key) {
    const node = createDisclosure('message process-summary-group', key, 'summary');
    const summary = node.firstElementChild;
    summary.className = 'process-summary';
    summary.dataset.processSummaryKey = key;
    const metrics = document.createElement('span');
    metrics.className = 'process-summary-metrics';
    metrics.setAttribute('aria-hidden', 'true');
    for (const kind of ['thinking', 'tool']) {
      const metric = document.createElement('span');
      metric.className = 'process-summary-metric';
      const count = document.createElement('span');
      count.className = 'process-summary-count';
      metric.append(kind === 'thinking' ? t('thinking') : toolDisplayTitle('tool'), count);
      metrics.append(metric);
    }
    summary.prepend(metrics);
    const list = document.createElement('ol');
    list.className = 'process-items';
    node.append(list);
    return node;
  }

  function patchProcessSummary(node, entry, key) {
    setDisclosureOpen(node, disclosureOpen(key, 'summary'));
    const summary = node.firstElementChild;
    const thinkingCount =
      entry.thinkingCount ?? entry.items.filter(item => item.type === 'thinking').length;
    const toolCount = entry.toolCount ?? entry.items.filter(item => item.type === 'tool').length;
    const metrics = summary.firstElementChild.children;
    for (const [index, count] of [thinkingCount, toolCount].entries()) {
      const metric = metrics[index];
      metric.hidden = !count;
      metric.lastElementChild.textContent = count || '';
    }
    const label = summaryLabel(thinkingCount, toolCount);
    summary.setAttribute(
      'aria-label',
      `${label} · ${t(node.open ? 'closeProcessDetails' : 'openProcessDetails')}`,
    );
    const updateItems = () => {
      reconcileChildren(
        node.lastElementChild,
        entry.items.map((item, index) => renderProcessRow(item, key, index)),
      );
      node.dataset.mounted = 'true';
    };
    node.onDisclosureOpen = updateItems;
    if (node.open || node.dataset.mounted === 'true') updateItems();
  }

  function historyIcon() {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    svg.classList.add('completed-process-icon');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', 'M3 10a9 9 0 1 1 2.6 8.4M3 4v6h6M12 7v5l3 2');
    svg.append(path);
    return svg;
  }

  function createCompletedProcess(key) {
    const node = createDisclosure('message completed-process', key, 'completed');
    node.dataset.completedProcessKey = key;
    const summary = node.firstElementChild;
    summary.className = 'completed-process-title';
    const collapsed = document.createElement('span');
    collapsed.className = 'completed-process-label-collapsed';
    collapsed.textContent = t('expandProcessHistory');
    const expanded = document.createElement('span');
    expanded.className = 'completed-process-label-expanded';
    expanded.textContent = t('collapseProcessHistory');
    summary.prepend(historyIcon(), collapsed, expanded);
    const list = document.createElement('div');
    list.className = 'completed-process-items';
    node.append(list);
    return node;
  }

  function patchCompletedProcess(node, entry, key) {
    setDisclosureOpen(node, disclosureOpen(key, 'completed'));
    node.firstElementChild.setAttribute(
      'aria-label',
      t(node.open ? 'collapseProcessHistory' : 'expandProcessHistory'),
    );
    const updateItems = () => {
      reconcileChildren(
        node.lastElementChild,
        entry.items.map((item, index) => renderEntry(item, `${key}/${index}`)),
      );
      node.dataset.mounted = 'true';
    };
    node.onDisclosureOpen = updateItems;
    if (node.open || node.dataset.mounted === 'true') updateItems();
  }

  function entryKey(entry, index) {
    return entry.key || `${entry.role}:${entry.id || index}`;
  }

  function patchUserMessage(node, entry) {
    node.className = 'user-message';
    let bubble = node.querySelector(':scope > .message.user');
    if (!bubble) {
      bubble = document.createElement('div');
      bubble.className = 'message user markdown-content';
      node.prepend(bubble);
    }
    // Pending metadata changes independently of the native message content.
    // Keep text selection, image loading and rich-content nodes through those updates.
    const { pendingInput, ...content } = entry;
    const signature = JSON.stringify(content);
    if (signature !== node.renderSignature) {
      copyController.invalidate(bubble);
      bubble.replaceChildren();
      renderContent(bubble, content);
      bubble.hidden = !bubble.hasChildNodes();
      node.renderSignature = signature;
    } else retryRichImages(bubble);

    let label = node.querySelector(':scope > .pending-input-status');
    if (pendingInput) {
      if (!label) {
        label = document.createElement('small');
        label.className = 'pending-input-status';
        node.append(label);
      }
      const status = pendingInputLabel(pendingInput.state, pendingInput.incomplete);
      label.textContent = status.label;
      label.title = status.description;
      label.setAttribute('aria-label', status.description);
    } else label?.remove();
  }

  function patchAssistantMessage(node, entry, showAnswerCopy) {
    node.className = 'message assistant';
    let content = node.querySelector(':scope > .assistant-content');
    if (!content) {
      content = document.createElement('div');
      content.className = 'assistant-content markdown-content';
      const actions = document.createElement('div');
      actions.className = 'message-actions';
      const copy = document.createElement('button');
      copy.className = 'message-copy';
      copy.type = 'button';
      copy.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/></svg>';
      copy.title = t('copyAnswer');
      copy.setAttribute('aria-label', t('copyAnswer'));
      const status = document.createElement('span');
      status.className = 'message-copy-status';
      status.setAttribute('role', 'status');
      status.setAttribute('aria-live', 'polite');
      const metadata = document.createElement('div');
      metadata.className = 'message-metadata';
      const model = document.createElement('span');
      model.className = 'message-model';
      const time = document.createElement('time');
      time.className = 'message-time';
      metadata.append(model, time);
      actions.append(copy, metadata, status);
      node.append(content, actions);
    }
    const copy = node.querySelector(':scope > .message-actions > .message-copy');
    // Footer enrichment must preserve body selection and in-flight copy feedback.
    const signature = JSON.stringify({
      text: entry.text,
      rawMessage: entry.rawMessage,
      incompleteFileLinkSource: openMessageFile && isIncompleteFileLinkSource(entry),
    });
    if (signature !== node.renderSignature) {
      copyController.invalidate(node);
      content.replaceChildren();
      const omittedInvalidDelivery = renderContent(content, entry);
      node.hidden = omittedInvalidDelivery === true && !content.hasChildNodes();
      copy.copyText = messageCopyText(entry);
      node.renderSignature = signature;
    } else retryRichImages(content);
    const hideCopy = !showAnswerCopy || !copy.copyText.trim();
    if (hideCopy && !copy.hidden) copyController.invalidate(copy);
    copy.hidden = hideCopy;
    patchMessageMetadata(node, showAnswerCopy ? entry.display : undefined);
  }

  function patchMessageMetadata(node, display) {
    const metadata = node.querySelector('.message-metadata');
    const model = metadata.querySelector('.message-model');
    const modelName = typeof display?.modelName === 'string' ? display.modelName.trim() : '';
    model.textContent = modelName;
    model.title = modelName ? `${t('responseModel')}: ${modelName}` : '';
    if (modelName) model.setAttribute('aria-label', model.title);
    else model.removeAttribute('aria-label');
    model.hidden = !modelName;
    const time = metadata.querySelector('.message-time');
    const timestamp = display?.timestampMs;
    const date = typeof timestamp === 'number' && Number.isFinite(timestamp) && timestamp > 0
      ? new Date(timestamp) : null;
    const validTime = Boolean(date && Number.isFinite(date.getTime()));
    time.hidden = !validTime;
    if (validTime) {
      const language = document.defaultView.navigator.language;
      time.dateTime = date.toISOString();
      time.textContent = date.toLocaleTimeString(language, { hour: '2-digit', minute: '2-digit', hour12: false });
      time.title = `${t('messageTime')}: ${date.toLocaleString(language, {
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
      })}`;
      time.setAttribute('aria-label', time.title);
    } else {
      time.textContent = '';
      time.removeAttribute('datetime');
      time.removeAttribute('title');
      time.removeAttribute('aria-label');
    }
    metadata.hidden = model.hidden && time.hidden;
    const actions = metadata.parentElement;
    actions.hidden = actions.querySelector('.message-copy').hidden && metadata.hidden;
  }

  function renderEntry(entry, index, showAnswerCopy = false) {
    const key = entryKey(entry, index);
    let node = entryNodes.get(key);
    if (!node || node.entryRole !== entry.role) {
      node =
        entry.role === 'completed-process'
          ? createCompletedProcess(key)
          : entry.role === 'process'
            ? createProcessSummary(key)
            : document.createElement('div');
      node.entryRole = entry.role;
      node.dataset.renderKey = key;
      entryNodes.set(key, node);
    }
    if (entry.role === 'completed-process') patchCompletedProcess(node, entry, key);
    else if (entry.role === 'process') patchProcessSummary(node, entry, key);
    else if (entry.role === 'user') patchUserMessage(node, entry);
    else if (entry.role === 'assistant') patchAssistantMessage(node, entry, showAnswerCopy);
    else if (entry.role === 'live-process') {
      node.className = `message process-live process-live-${entry.item.type}`;
      let list = node.firstElementChild;
      if (!list) {
        list = document.createElement('ol');
        list.className = 'process-items process-live-items';
        node.append(list);
      }
      reconcileChildren(list, [renderProcessRow(entry.item, key, 0)]);
    } else {
      node.className = `message ${entry.role} markdown-content`;
      const signature = JSON.stringify(entry);
      if (signature !== node.renderSignature) {
        copyController.invalidate(node);
        // Compaction uses the App's Lit renderer. Keep its host and render
        // anchors so native enrichment patches the same disclosure in place.
        if (entry.role !== 'compaction' && entry.role !== 'question-presentation') node.replaceChildren();
        renderContent(node, entry);
        node.renderSignature = signature;
      } else retryRichImages(node);
    }
    return node;
  }

  function retainKeys(entries, entryKeys, itemKeys, prefix = '') {
    entries.forEach((entry, index) => {
      const key = entryKey(entry, `${prefix}${index}`);
      entryKeys.add(key);
      if (entry.role === 'completed-process')
        retainKeys(entry.items, entryKeys, itemKeys, `${key}/`);
      else if (entry.role === 'process')
        entry.items.forEach((item, itemIndex) => itemKeys.add(processKey(item, key, itemIndex)));
      else if (entry.role === 'live-process') itemKeys.add(processKey(entry.item, key));
    });
  }

  function foldedProcessTrigger(entries, itemKey, prefix = '', collapsedTrigger = null) {
    for (const [index, entry] of entries.entries()) {
      const key = entryKey(entry, `${prefix}${index}`);
      if (
        entry.role === 'process' &&
        entry.items.some((item, itemIndex) => processKey(item, key, itemIndex) === itemKey)
      ) return collapsedTrigger ?? entryNodes.get(key)?.firstElementChild;
      if (entry.role !== 'completed-process') continue;
      const details = entryNodes.get(key);
      // A closed history wrapper may never have mounted its inner disclosures.
      const trigger = foldedProcessTrigger(
        entry.items, itemKey, `${key}/`,
        collapsedTrigger ?? (details?.open ? null : details?.firstElementChild),
      );
      if (trigger) return trigger;
    }
    return null;
  }

  const view = {
    render(entries, scope) {
      rememberDisclosures();
      const changedScope = scope !== currentScope || !scopeState;
      if (changedScope) {
        copyController.invalidate();
        if (scopeState) {
          scopeState.scrollTop = container.scrollTop;
          scopeState.following = following;
        }
        currentScope = scope;
        scopeState = getScope(scope);
        following = scopeState.following;
        processSummariesExpanded = false;
        entryNodes = new Map();
        processRows = new Map();
        thinkingResizeObserver?.disconnect();
        interactionAnchor = null;
        container.replaceChildren();
      }
      currentEntries = entries;
      updateProcessDetailsButton();
      const focused =
        !changedScope && container.contains(document.activeElement) ? document.activeElement : null;
      const focusedLiveItem = focused?.closest('.process-live [data-item-key]')?.dataset.itemKey;
      const anchor = interactionAnchor ?? (following ? null : captureReadingAnchor());
      interactionAnchor = null;
      const previousScrollTop = container.scrollTop;
      const previousKeys = new Set(entryNodes.keys());
      const nodes = [];
      const lastAnswers = new Map();
      for (let index = entries.length - 1; index >= 0; index -= 1) {
        const entry = entries[index];
        if (entry.role === 'assistant' && entry.turnIndex !== undefined &&
          !lastAnswers.has(entry.turnIndex) && messageCopyText(entry).trim()) {
          lastAnswers.set(entry.turnIndex, entry);
        }
      }
      if (!entries.length) {
        const empty = document.createElement('div');
        empty.className = 'empty';
        const logo = document.createElement('img');
        logo.src = 'icons/icon128.png';
        logo.alt = '';
        const title = document.createElement('h1');
        title.textContent = t('welcome');
        empty.append(logo, title);
        nodes.push(empty);
      }
      for (const [index, entry] of entries.entries()) {
        const showAnswerCopy = entry.turnIndex === undefined || lastAnswers.get(entry.turnIndex) === entry;
        const node = renderEntry(entry, index, showAnswerCopy);
        // Play an entrance once for new live rows. Existing streaming rows keep
        // their identity and do not restart animations on every token.
        if (!previousKeys.has(node.dataset.renderKey) && !changedScope && previousKeys.size)
          node.classList.add('message-enter');
        nodes.push(node);
      }
      reconcileChildren(container, nodes);
      copyController.prune();
      const entryKeys = new Set();
      const itemKeys = new Set();
      retainKeys(entries, entryKeys, itemKeys);
      for (const key of entryNodes.keys()) if (!entryKeys.has(key)) entryNodes.delete(key);
      for (const [key, row] of processRows) {
        if (itemKeys.has(key)) continue;
        const thinkingContent = row.querySelector('.process-thinking .message-detail');
        if (thinkingContent) thinkingResizeObserver?.unobserve(thinkingContent);
        processRows.delete(key);
      }
      // A retained node may move from the live lane into a newly mounted
      // history wrapper. Preserve keyboard reading when it stays visible.
      if (focused?.isConnected && isDisclosureTargetVisible(focused)) {
        if (document.activeElement !== focused) focused.focus({ preventScroll: true });
      } else if (focusedLiveItem &&
        (document.activeElement === document.body || document.activeElement === focused)) {
        foldedProcessTrigger(entries, focusedLiveItem)?.focus({ preventScroll: true });
      }
      resizeObserver?.disconnect();
      for (const node of nodes) resizeObserver?.observe(node);
      if (following) setScroll(container.scrollHeight);
      else if (changedScope) setScroll(scopeState.scrollTop);
      else if (anchor?.node.isConnected) {
        setScroll(
          container.scrollTop +
            anchor.node.getBoundingClientRect().top -
            container.getBoundingClientRect().top -
            anchor.offset,
        );
      } else setScroll(previousScrollTop);
      showLatestButton();
    },
    dispose() {
      currentScope = '';
      copyController.dispose();
      resizeObserver?.disconnect();
      thinkingResizeObserver?.disconnect();
      container.removeEventListener('wheel', onWheel);
      container.removeEventListener('touchstart', onTouchStart);
      container.removeEventListener('touchmove', onTouchMove);
      container.removeEventListener('keydown', onKeyDown);
      container.removeEventListener('scroll', onScroll);
      latestButton.removeEventListener('click', onLatest);
      processDetailsButton.removeEventListener('click', onProcessDetails);
      scopes.clear();
      entryNodes.clear();
      processRows.clear();
      currentEntries = [];
      scopeState = null;
    },
  };
  return view;
}
