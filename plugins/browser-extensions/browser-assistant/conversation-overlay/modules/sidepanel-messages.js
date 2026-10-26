import { pendingInputLabel, renderRichContent, retryRichImages } from './sidepanel-rich-content.js';
import { sidePanelText as t } from './sidepanel-i18n.js';
import { toolInputSummary } from './sidepanel-state.js';
import { renderMarkdownHtml } from './sidepanel-markdown.js';

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
  { readImage, latestButton, processDetailsButton },
) {
  const document = container.ownerDocument;
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
    following = following
      ? nearBottom()
      : container.scrollHeight - container.scrollTop - container.clientHeight <= 2;
    if (scopeState) {
      scopeState.following = following;
      scopeState.scrollTop = container.scrollTop;
    }
    showLatestButton();
  };
  const onLatest = () => {
    following = true;
    if (scopeState) scopeState.following = true;
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
      const content = document.createElement('div');
      content.className = 'message-detail markdown-content';
      thinking.append(headingRow, content);
      row.append(thinking);
    }
    thinking.querySelector('strong').textContent = process.title;
    const content = thinking.querySelector('.message-detail');
    if (content.sourceText !== process.text) {
      content.innerHTML = renderMarkdownHtml(process.text || '');
      content.sourceText = process.text;
    }
    thinking.dataset.status = toolStatus(process);
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
      const name = document.createElement('strong');
      const input = document.createElement('span');
      input.className = 'process-tool-input';
      summary.append(status, name, input);
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
    tool.querySelector('summary strong').textContent = process.title;
    const input = tool.querySelector('.process-tool-input');
    input.textContent =
      normalizedStatus === 'running' && process.progressText
        ? toolInputSummary(process.progressText)
        : toolInputSummary(process.input);
    input.title = input.textContent;
    const progress = tool.querySelector('.process-tool-progress');
    progress.textContent = normalizedStatus === 'running' ? process.progressText || '' : '';
    progress.hidden = !progress.textContent;
    for (const [name, heading, value] of [
      ['input', t('input'), process.input],
      ['output', t(process.isError ? 'error' : 'output'), process.output],
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

  function summaryLabel(entry) {
    const thinkingCount =
      entry.thinkingCount ?? entry.items.filter(item => item.type === 'thinking').length;
    const toolCount = entry.toolCount ?? entry.items.filter(item => item.type === 'tool').length;
    return thinkingCount && toolCount
      ? t('thinkingToolsSummary', { thinkingCount, toolCount })
      : t(thinkingCount ? 'thinkingSummary' : 'toolSummary', { count: thinkingCount || toolCount });
  }

  function createProcessSummary(key) {
    const node = createDisclosure('message process-summary-group', key, 'summary');
    const summary = node.firstElementChild;
    summary.className = 'process-summary';
    summary.dataset.processSummaryKey = key;
    const icon = document.createElement('span');
    icon.className = 'process-summary-icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = '⌁';
    const label = document.createElement('span');
    label.className = 'process-summary-label';
    summary.prepend(icon, label);
    const list = document.createElement('ol');
    list.className = 'process-items';
    node.append(list);
    return node;
  }

  function patchProcessSummary(node, entry, key) {
    setDisclosureOpen(node, disclosureOpen(key, 'summary'));
    const summary = node.firstElementChild;
    const label = summaryLabel(entry);
    summary.querySelector('.process-summary-label').textContent = label;
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

  function renderEntry(entry, index) {
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
        // Compaction uses the App's Lit renderer. Keep its host and render
        // anchors so native enrichment patches the same disclosure in place.
        if (entry.role !== 'compaction' && entry.role !== 'question-presentation') node.replaceChildren();
        const scope = currentScope;
        renderRichContent(node, entry, source => readImage(scope, source));
        if (entry.pendingInput) {
          const label = document.createElement('small');
          label.className = 'pending-input-status';
          label.textContent = pendingInputLabel(
            entry.pendingInput.state,
            entry.pendingInput.incomplete,
          );
          node.append(label);
        }
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

  const view = {
    render(entries, scope) {
      rememberDisclosures();
      const changedScope = scope !== currentScope || !scopeState;
      if (changedScope) {
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
        interactionAnchor = null;
        container.replaceChildren();
      }
      currentEntries = entries;
      updateProcessDetailsButton();
      const focused =
        !changedScope && container.contains(document.activeElement) ? document.activeElement : null;
      const anchor = interactionAnchor ?? (following ? null : captureReadingAnchor());
      interactionAnchor = null;
      const previousScrollTop = container.scrollTop;
      const previousKeys = new Set(entryNodes.keys());
      const nodes = [];
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
        const node = renderEntry(entry, index);
        // Play an entrance once for new live rows. Existing streaming rows keep
        // their identity and do not restart animations on every token.
        if (!previousKeys.has(node.dataset.renderKey) && !changedScope && previousKeys.size)
          node.classList.add('message-enter');
        nodes.push(node);
      }
      reconcileChildren(container, nodes);
      const entryKeys = new Set();
      const itemKeys = new Set();
      retainKeys(entries, entryKeys, itemKeys);
      for (const key of entryNodes.keys()) if (!entryKeys.has(key)) entryNodes.delete(key);
      for (const key of processRows.keys()) if (!itemKeys.has(key)) processRows.delete(key);
      // A retained node may move from the live lane into a newly mounted
      // history wrapper. Preserve keyboard reading when it stays visible.
      if (
        focused?.isConnected &&
        document.activeElement !== focused &&
        isDisclosureTargetVisible(focused)
      )
        focused.focus({ preventScroll: true });
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
      resizeObserver?.disconnect();
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
