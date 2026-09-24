import { randomBytes } from 'crypto';
import { nativeImage } from 'electron';

import {
  AgentBrowserCommand,
  asRecord,
  BrowserDialogState,
  BrowserLabelAnnotation,
  BrowserSnapshot,
  FRAME_PATH_SEPARATOR,
  INTERACTIVE_SELECTOR,
  MAX_SCREENSHOT_BYTES,
  MAX_SCREENSHOT_DIMENSION,
  MAX_TOOL_TEXT_CHARS,
  parseRefIndex,
  RegisteredTab,
  serializeError,
  wrapBrowserContent,
} from './browserAgentProtocol';
import { sanitizeBrowserUrl as sanitizeUrlForModel } from './browserDataSanitizers';
export interface BrowserAgentSnapshotsContext {
  readonly enableDebuggerDomains: (
    tab: RegisteredTab,
    guest: Electron.WebContents,
  ) => Promise<Electron.Debugger>;
  readonly resolveBrowserFrameContext: (
    guestDebugger: Electron.Debugger,
    frameSelector?: string,
    requireDocumentNode?: boolean,
  ) => Promise<{ frameId: string; documentNodeId: number; offsetX: number; offsetY: number }>;
  readonly ariaRefState: Map<
    number,
    {
      next: number;
      byNodeKey: Map<string, string>;
      refs: Set<string>;
      frameSelectors: Map<string, string>;
      worldFrameSelectors: Map<string, string>;
    }
  >;
  readonly executeInDebuggerWorld: <T>(
    guestDebugger: Electron.Debugger,
    frameId: string,
    code: string,
  ) => Promise<T>;
  readonly executeInBrowserWorld: <T>(guest: Electron.WebContents, code: string) => Promise<T>;
  readonly snapshots: Map<number, BrowserSnapshot>;
  readonly dialogs: Map<number, BrowserDialogState>;
  readonly snapshotLabelAnnotations: Map<
    number,
    { snapshotId: string; visibleRefs: string[]; annotations: BrowserLabelAnnotation[] }
  >;
  readonly captureAriaSnapshot: (
    command: AgentBrowserCommand,
    tab: RegisteredTab,
    guest: Electron.WebContents,
    snapshotId: string,
  ) => Promise<{
    content: Array<{ type: 'text'; text: string }>;
    details: Record<string, unknown>;
  }>;
  readonly executeInTargetWorld: <T>(
    tab: RegisteredTab,
    guest: Electron.WebContents,
    frameSelector: string,
    code: string,
  ) => Promise<T>;
  readonly resolveTargetFrameOffset: (
    tab: RegisteredTab,
    guest: Electron.WebContents,
    frameSelector: string,
  ) => Promise<{ x: number; y: number }>;
  readonly snapshotDeltaState: Map<number, Map<string, { url: string; keys: Set<string> }>>;
  readonly navigationGenerations: Map<number, number>;
  readonly captureScreenshot: (
    command: AgentBrowserCommand,
    tab: RegisteredTab,
    guest: Electron.WebContents,
  ) => Promise<Record<string, unknown>>;
  readonly captureSnapshot: (
    command: AgentBrowserCommand,
    tab: RegisteredTab,
    guest: Electron.WebContents,
  ) => Promise<{
    content: Array<
      { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }
    >;
    details: Record<string, unknown>;
  }>;
  readonly assertCurrentRef: (
    request: Record<string, unknown>,
    tab: RegisteredTab,
    guest: Electron.WebContents,
    key?: string,
  ) => {
    ref: string;
    index: number;
    snapshotId: string;
    expression: string;
    aria: boolean;
    frameSelector: string;
    worldFrameSelector: string;
  };
  readonly normalizeScreenshotData: (
    data: string,
    imageType: 'png' | 'jpeg',
  ) => { data: string; width: number; height: number };
}

export async function captureAriaSnapshot(
  this: BrowserAgentSnapshotsContext,
  command: AgentBrowserCommand,
  tab: RegisteredTab,
  guest: Electron.WebContents,
  snapshotId: string,
): Promise<{ content: Array<{ type: 'text'; text: string }>; details: Record<string, unknown> }> {
  const guestDebugger = await this.enableDebuggerDomains(tab, guest);
  const frameSelector = command.frame?.trim() ?? '';
  const frameContext = frameSelector
    ? await this.resolveBrowserFrameContext(guestDebugger, frameSelector)
    : null;
  const response = (await (frameContext
    ? guestDebugger.sendCommand('Accessibility.getFullAXTree', {
        frameId: frameContext.frameId,
      })
    : guestDebugger.sendCommand('Accessibility.getFullAXTree'))) as {
    nodes?: Array<{
      nodeId?: string;
      parentId?: string;
      ignored?: boolean;
      backendDOMNodeId?: number;
      role?: { value?: unknown };
      name?: { value?: unknown };
      value?: { value?: unknown };
      description?: { value?: unknown };
    }>;
  };
  const rawNodes = Array.isArray(response.nodes) ? response.nodes : [];
  const depths = new Map<string, number>();
  const byId = new Map(rawNodes.map(node => [node.nodeId, node]));
  const readDepth = (node: (typeof rawNodes)[number]): number => {
    if (!node.nodeId) return 0;
    const cached = depths.get(node.nodeId);
    if (cached !== undefined) return cached;
    let depth = 0;
    let parentId = node.parentId;
    const seen = new Set<string>();
    while (parentId && !seen.has(parentId)) {
      seen.add(parentId);
      depth += 1;
      parentId = byId.get(parentId)?.parentId;
    }
    depths.set(node.nodeId, depth);
    return depth;
  };
  const valueText = (value: unknown): string =>
    typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
      ? String(value)
      : '';
  const interactiveRoles = new Set([
    'button',
    'checkbox',
    'combobox',
    'link',
    'listbox',
    'menuitem',
    'option',
    'radio',
    'searchbox',
    'slider',
    'spinbutton',
    'switch',
    'tab',
    'textbox',
    'treeitem',
  ]);
  const structuralRoles = new Set(['generic', 'group', 'none', 'presentation']);
  const privateValueRoles = new Set(['combobox', 'searchbox', 'spinbutton', 'textbox']);
  const maximumDepth = Math.max(0, Math.min(100, command.depth ?? 100));
  const limit = Math.max(1, Math.min(2_000, command.limit ?? 500));
  const candidates = rawNodes
    .filter(node => node.ignored !== true)
    .map(node => ({
      source: node,
      role: valueText(node.role?.value).toLowerCase() || 'generic',
      name: valueText(node.name?.value).slice(0, 1_000),
      value: privateValueRoles.has(valueText(node.role?.value).toLowerCase())
        ? ''
        : valueText(node.value?.value).slice(0, 1_000),
      description: valueText(node.description?.value).slice(0, 1_000),
      depth: readDepth(node),
    }))
    .filter(node => node.depth <= maximumDepth)
    .filter(node => command.interactive !== true || interactiveRoles.has(node.role))
    .filter(node => command.compact !== true || !structuralRoles.has(node.role) || node.name)
    .slice(0, limit);
  const refPrefix = 'ax';
  const ariaState = this.ariaRefState.get(tab.webContentsId) ?? {
    next: 1,
    byNodeKey: new Map<string, string>(),
    refs: new Set<string>(),
    frameSelectors: new Map<string, string>(),
    worldFrameSelectors: new Map<string, string>(),
  };
  this.ariaRefState.set(tab.webContentsId, ariaState);
  const nodes = candidates.map((node, index) => ({
    ref: (() => {
      const nodeKey =
        typeof node.source.backendDOMNodeId === 'number'
          ? `backend:${node.source.backendDOMNodeId}`
          : `ax:${node.source.nodeId ?? index}`;
      const existing = ariaState.byNodeKey.get(nodeKey);
      if (existing) return existing;
      const created = `ax${ariaState.next++}`;
      ariaState.byNodeKey.set(nodeKey, created);
      return created;
    })(),
    role: node.role,
    name: node.name,
    ...(node.value ? { value: node.value } : {}),
    ...(node.description ? { description: node.description } : {}),
    ...(typeof node.source.backendDOMNodeId === 'number'
      ? { backendDOMNodeId: node.source.backendDOMNodeId }
      : {}),
    depth: node.depth,
  }));

  const markerName = 'data-browser-agent-ax-ref';
  const markerPrefix = `${snapshotId}:`;
  const backendEntries = candidates.flatMap((node, index) =>
    typeof node.source.backendDOMNodeId === 'number'
      ? [{ backendDOMNodeId: node.source.backendDOMNodeId, index }]
      : [],
  );
  if (backendEntries.length) {
    await guestDebugger.sendCommand('DOM.getDocument', { depth: 0, pierce: true });
    const pushed = (await guestDebugger.sendCommand('DOM.pushNodesByBackendIdsToFrontend', {
      backendNodeIds: backendEntries.map(entry => entry.backendDOMNodeId),
    })) as { nodeIds?: number[] };
    for (let offset = 0; offset < backendEntries.length; offset += 20) {
      await Promise.all(
        backendEntries.slice(offset, offset + 20).map(async (entry, batchIndex) => {
          const nodeId = pushed.nodeIds?.[offset + batchIndex];
          if (!nodeId) return;
          await guestDebugger
            .sendCommand('DOM.setAttributeValue', {
              nodeId,
              name: markerName,
              value: `${markerPrefix}${entry.index}`,
            })
            .catch((): void => undefined);
        }),
      );
    }
  }
  const collectElementsScript = `(() => {
        const elements = new Array(${nodes.length});
        const refs = ${JSON.stringify(nodes.map(node => node.ref))};
        const ariaRegistry = globalThis.__justdoBrowserAgentAriaRegistry ||= {
          next: 1,
          refs: new WeakMap(),
          elements: new Map(),
        };
        const sensitiveIndices = [];
        const confirmedSafeIndices = [];
        const sensitiveAutocompleteTokens = new Set(['current-password', 'new-password', 'one-time-code']);
        const sensitive = element => {
          const autocompleteTokens = (element.getAttribute('autocomplete') || '').toLowerCase().split(/\\s+/).filter(Boolean);
          return element.matches('input[type="password"], input[type="hidden"]') || autocompleteTokens.some(token => sensitiveAutocompleteTokens.has(token));
        };
        const markedElements = [];
        const collectMarkedElements = root => {
          for (const element of root.querySelectorAll('[${markerName}^=${JSON.stringify(markerPrefix)}]')) {
            markedElements.push(element);
          }
          for (const element of root.querySelectorAll('*')) {
            if (element.shadowRoot) collectMarkedElements(element.shadowRoot);
          }
        };
        collectMarkedElements(document);
        for (const element of markedElements) {
          const marker = element.getAttribute(${JSON.stringify(markerName)}) || '';
          const index = Number(marker.slice(${JSON.stringify(markerPrefix)}.length));
          if (Number.isInteger(index) && index >= 0 && index < elements.length) {
            if (sensitive(element)) sensitiveIndices.push(index);
            else {
              confirmedSafeIndices.push(index);
              elements[index] = element;
              ariaRegistry.elements.set(refs[index], element);
            }
          }
          element.removeAttribute(${JSON.stringify(markerName)});
        }
        globalThis.__justdoBrowserAgentState = {
          snapshotId: ${JSON.stringify(snapshotId)},
          refPrefix: ${JSON.stringify(refPrefix)},
          elements,
          refs,
          metadata: ${JSON.stringify(nodes.map(node => ({ role: node.role, name: node.name })))},
        };
        return { sensitiveIndices, confirmedSafeIndices };
      })()`;
  const safetyResult = frameContext
    ? await this.executeInDebuggerWorld<{
        sensitiveIndices?: number[];
        confirmedSafeIndices?: number[];
      }>(guestDebugger, frameContext.frameId, collectElementsScript)
    : await this.executeInBrowserWorld<{
        sensitiveIndices?: number[];
        confirmedSafeIndices?: number[];
      }>(guest, collectElementsScript);
  const safetyRecord = asRecord(safetyResult);
  const sensitiveIndexSet = new Set(
    Array.isArray(safetyRecord?.sensitiveIndices) ? safetyRecord.sensitiveIndices : [],
  );
  const confirmedSafeIndexSet = new Set(
    Array.isArray(safetyRecord?.confirmedSafeIndices) ? safetyRecord.confirmedSafeIndices : [],
  );
  const safeNodeEntries = nodes.flatMap((node, index) =>
    !sensitiveIndexSet.has(index) && confirmedSafeIndexSet.has(index) ? [{ node, index }] : [],
  );
  const safeNodes = safeNodeEntries.map(entry => entry.node);
  safeNodes.forEach(node => ariaState.refs.add(node.ref));
  safeNodes.forEach(node => ariaState.frameSelectors.set(node.ref, frameSelector));
  safeNodes.forEach(node => ariaState.worldFrameSelectors.set(node.ref, frameSelector));
  this.snapshots.set(tab.webContentsId, {
    id: snapshotId,
    url: guest.getURL(),
    refPrefix,
    ...(frameSelector ? { frameSelector } : {}),
    refIndices: new Map(safeNodeEntries.map(entry => [entry.node.ref, entry.index] as const)),
  });

  const queryTokens = command.query?.toLowerCase().split(/\s+/).filter(Boolean) ?? [];
  const matchedNodes = queryTokens.length
    ? safeNodes.filter(node => {
        const text =
          `${node.role} ${node.name} ${node.value ?? ''} ${node.description ?? ''}`.toLowerCase();
        return queryTokens.every(token => text.includes(token));
      })
    : safeNodes;
  const nodeLines = matchedNodes.map(
    node =>
      `- ${node.role} ${JSON.stringify(node.name)} [ref=${node.ref}]${node.value ? ` value=${JSON.stringify(node.value)}` : ''}${node.description ? ` description=${JSON.stringify(node.description)}` : ''}`,
  );
  const maximumChars = Math.max(
    1,
    Math.min(
      MAX_TOOL_TEXT_CHARS,
      command.maxChars && command.maxChars > 0 ? command.maxChars : MAX_TOOL_TEXT_CHARS,
    ),
  );
  const visibleLines: string[] = [];
  let usedChars = 0;
  for (const line of nodeLines) {
    const added = line.length + (visibleLines.length ? 1 : 0);
    if (usedChars + added > maximumChars) break;
    visibleLines.push(line);
    usedChars += added;
  }
  const visibleRefs = new Set(
    visibleLines.flatMap(line => [...line.matchAll(/\[ref=([^\]]+)\]/gu)].map(match => match[1]!)),
  );
  const visibleNodes = matchedNodes.filter(node => visibleRefs.has(node.ref));
  const snapshot = visibleLines.join('\n');
  const pendingDialog = this.dialogs.get(tab.webContentsId);
  return {
    content: [{ type: 'text', text: wrapBrowserContent(snapshot) }],
    details: {
      ok: true,
      format: 'aria',
      targetId: tab.targetId,
      url: sanitizeUrlForModel(guest.getURL()),
      nodes: visibleNodes,
      refs: visibleNodes.length,
      nodeCount: visibleNodes.length,
      truncated: candidates.length < rawNodes.length || visibleNodes.length < matchedNodes.length,
      ...(pendingDialog
        ? {
            blockedByDialog: true,
            dialog: { id: pendingDialog.id, type: pendingDialog.type },
          }
        : {}),
      externalContent: {
        untrusted: true,
        source: 'browser',
        kind: 'snapshot',
        format: 'aria',
        wrapped: true,
      },
    },
  };
}

export async function captureSnapshot(
  this: BrowserAgentSnapshotsContext,
  command: AgentBrowserCommand,
  tab: RegisteredTab,
  guest: Electron.WebContents,
): Promise<{
  content: Array<
    { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }
  >;
  details: Record<string, unknown>;
}> {
  const interactiveSelector = JSON.stringify(INTERACTIVE_SELECTOR);
  const snapshotId = randomBytes(16).toString('hex');
  this.snapshotLabelAnnotations.delete(tab.webContentsId);
  const ariaMode = command.snapshotFormat === 'aria';
  if (ariaMode && command.labels) {
    throw new Error('labels require snapshotFormat="ai".');
  }
  if (ariaMode) return this.captureAriaSnapshot(command, tab, guest, snapshotId);
  const refPrefix = command.refs === 'aria' ? 'ax' : 'e';
  const ariaStateForSnapshot =
    command.refs === 'aria'
      ? (this.ariaRefState.get(tab.webContentsId) ?? {
          next: 1,
          byNodeKey: new Map<string, string>(),
          refs: new Set<string>(),
          frameSelectors: new Map<string, string>(),
          worldFrameSelectors: new Map<string, string>(),
        })
      : null;
  if (ariaStateForSnapshot) this.ariaRefState.set(tab.webContentsId, ariaStateForSnapshot);
  const efficient = command.mode === 'efficient';
  const depth = Math.max(0, Math.min(100, command.depth ?? (efficient ? 6 : 100)));
  const limit = Math.max(1, Math.min(2_000, command.limit ?? 500));
  const captureAiSnapshot = () =>
    this.executeInBrowserWorld<{
      title: string;
      url: string;
      text: string;
      ariaNext: number;
      crossOriginFrames: Array<{ selector: string }>;
      elements: Array<{
        ref: string;
        tag: string;
        role: string;
        name: string;
        href: string;
        type: string;
        editable: boolean;
        box: { x: number; y: number; width: number; height: number };
      }>;
    }>(
      guest,
      `(() => {
        const frameSelector = ${JSON.stringify(command.frame?.trim() ?? '')};
        const scopeSelector = ${JSON.stringify(command.selector?.trim() ?? '')};
        let rootDocument = document;
        if (frameSelector) {
          let frameElement;
          try { frameElement = document.querySelector(frameSelector); } catch { throw new Error('Invalid frame selector.'); }
          if (!(frameElement instanceof HTMLIFrameElement) || !frameElement.contentDocument) {
            throw new Error('Frame was unavailable while its browser snapshot was being captured.');
          }
          rootDocument = frameElement.contentDocument;
        }
        let scope = rootDocument.documentElement;
        if (scopeSelector) {
          try { scope = rootDocument.querySelector(scopeSelector); } catch { throw new Error('Invalid selector.'); }
          if (!scope) throw new Error('Snapshot selector did not match an element.');
        }
        const frameSelectorFor = element => {
          if (element.id) return '#' + CSS.escape(element.id);
          const parts = [];
          let current = element;
          while (current && current !== document.documentElement) {
            const tag = String(current.tagName || '').toLowerCase();
            if (!tag) break;
            const siblings = current.parentElement
              ? [...current.parentElement.children].filter(candidate => candidate.tagName === current.tagName)
              : [];
            const position = siblings.indexOf(current) + 1;
            parts.unshift(tag + (siblings.length > 1 ? ':nth-of-type(' + position + ')' : ''));
            current = current.parentElement;
          }
          return parts.join(' > ');
        };
        const scopes = [scope];
        const crossOriginFrames = [];
        if (!frameSelector && !scopeSelector) {
          const visitedDocuments = new Set([document]);
          const visitFrames = (currentDocument, parentPath = []) => {
            for (const frameElement of currentDocument.querySelectorAll('iframe, frame')) {
              const selector = frameSelectorFor(frameElement);
              const framePath = selector ? [...parentPath, selector] : parentPath;
              let childDocument = null;
              try { childDocument = frameElement.contentDocument; } catch {}
              if (childDocument?.documentElement && !visitedDocuments.has(childDocument)) {
                visitedDocuments.add(childDocument);
                scopes.push(childDocument.documentElement);
                visitFrames(childDocument, framePath);
              } else if (framePath.length) {
                crossOriginFrames.push({ selector: framePath.join(${JSON.stringify(FRAME_PATH_SEPARATOR)}) });
              }
            }
          };
          visitFrames(document);
        }
        const visible = element => {
          const rect = element.getBoundingClientRect();
          const style = element.ownerDocument.defaultView?.getComputedStyle(element);
          if (!style) return false;
          return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
        };
        const absoluteRect = element => {
          const rect = element.getBoundingClientRect();
          let x = rect.x;
          let y = rect.y;
          let currentDocument = element.ownerDocument;
          while (currentDocument && currentDocument !== document) {
            const frameElement = currentDocument.defaultView?.frameElement;
            if (!(frameElement instanceof Element)) break;
            const frameRect = frameElement.getBoundingClientRect();
            x += frameRect.x;
            y += frameRect.y;
            currentDocument = frameElement.ownerDocument;
          }
          return { x, y, width: rect.width, height: rect.height };
        };
        const sensitiveAutocompleteTokens = new Set(['current-password', 'new-password', 'one-time-code']);
        const sensitive = element => {
          const autocompleteTokens = (element.getAttribute('autocomplete') || '').toLowerCase().split(/\\s+/).filter(Boolean);
          return element.matches('input[type="password"], input[type="hidden"]') || autocompleteTokens.some(token => sensitiveAutocompleteTokens.has(token));
        };
        const safeHref = element => {
          if (!(element instanceof HTMLAnchorElement)) return '';
          try {
            const url = new URL(element.href);
            url.username = '';
            url.password = '';
            url.search = '';
            url.hash = '';
            return url.toString().slice(0, 500);
          } catch { return ''; }
        };
        const implicitRole = element => {
          const tag = String(element.tagName || '').toLowerCase();
          if (/^h[1-6]$/.test(tag)) return 'heading';
          if (tag === 'input') {
            const type = String(element.type || 'text').toLowerCase();
            if (['button', 'submit', 'reset', 'image', 'file', 'color'].includes(type)) return 'button';
            if (type === 'checkbox') return 'checkbox';
            if (type === 'radio') return 'radio';
            if (type === 'range') return 'slider';
            if (type === 'number') return 'spinbutton';
            if (type === 'search') return element.hasAttribute('list') ? 'combobox' : 'searchbox';
            return element.hasAttribute('list') ? 'combobox' : 'textbox';
          }
          if (tag === 'select') return element.multiple || element.size > 1 ? 'listbox' : 'combobox';
          return ({
            a: element.hasAttribute('href') ? 'link' : '', button: 'button',
            textarea: 'textbox', img: 'img', nav: 'navigation', main: 'main',
            form: 'form', table: 'table', tr: 'row', th: 'columnheader', td: 'cell', ul: 'list',
            ol: 'list', li: 'listitem', p: 'paragraph', label: 'label', summary: 'button',
            dialog: 'dialog', article: 'article', aside: 'complementary', details: 'group',
            fieldset: 'group', figure: 'figure', footer: 'contentinfo', header: 'banner',
            menu: 'list', meter: 'meter', option: 'option', output: 'status', progress: 'progressbar',
          })[tag] || '';
        };
        const accessibleName = element => {
          const ownerDocument = element.ownerDocument;
          const nameRoot = element.getRootNode?.();
          const lookupLabel = id => nameRoot?.getElementById?.(id) || ownerDocument.getElementById(id);
          const labelledBy = (element.getAttribute('aria-labelledby') || '').split(/\\s+/).filter(Boolean)
            .map(id => lookupLabel(id)?.textContent || '').join(' ');
          const labels = element.labels
            ? [...element.labels].map(label => label.textContent || '').join(' ')
            : '';
          const tag = String(element.tagName || '').toLowerCase();
          const nativeCaption =
            tag === 'fieldset'
              ? element.querySelector(':scope > legend')?.textContent || ''
              : tag === 'table'
                ? element.querySelector(':scope > caption')?.textContent || ''
                : tag === 'figure'
                  ? element.querySelector(':scope > figcaption')?.textContent || ''
                  : '';
          const inputValue =
            tag === 'input' && ['button', 'submit', 'reset'].includes(String(element.type || '').toLowerCase())
              ? element.value || ''
              : '';
          return (labelledBy || element.getAttribute('aria-label') || labels || element.getAttribute('alt') || inputValue || nativeCaption || element.getAttribute('title') || element.innerText || element.getAttribute('placeholder') || '').trim().replace(/\\s+/g, ' ').slice(0, 240);
        };
        const ariaRefs = ${command.refs === 'aria'};
        const ariaRegistry = globalThis.__justdoBrowserAgentAriaRegistry ||= {
          next: 1,
          refs: new WeakMap(),
          elements: new Map(),
        };
        if (ariaRefs) ariaRegistry.next = Math.max(ariaRegistry.next, ${ariaStateForSnapshot?.next ?? 1});
        const describe = (element, index) => {
          const rect = absoluteRect(element);
          const tag = String(element.tagName || '').toLowerCase();
          const inputType = tag === 'input' ? String(element.type || '').toLowerCase() : '';
          const textInput = tag === 'input' && ['text', 'search', 'email', 'url', 'tel', 'number', 'date', 'datetime-local', 'month', 'time', 'week'].includes(inputType);
          const editable = element.getAttribute('aria-disabled') !== 'true' && !element.disabled && !element.readOnly && (textInput || tag === 'textarea' || element.isContentEditable);
          const ref = ariaRefs
              ? (() => {
                  const existing = ariaRegistry.refs.get(element);
                  if (existing) return existing;
                  const created = 'ax' + ariaRegistry.next++;
                  ariaRegistry.refs.set(element, created);
                  return created;
                })()
              : ${JSON.stringify(refPrefix)} + (index + 1);
          if (ariaRefs) ariaRegistry.elements.set(ref, element);
          return {
            ref,
            tag,
            role: element.getAttribute('role') || implicitRole(element),
            name: accessibleName(element),
            href: safeHref(element),
            type: inputType,
            editable,
            box: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
          };
        };
        const composedParent = element =>
          element.parentElement || element.getRootNode?.()?.host || null;
        const withinDepth = (element, currentScope) => {
          let current = element;
          let currentDepth = 0;
          while (current && current !== currentScope) {
            current = composedParent(current);
            currentDepth += 1;
          }
          return current === currentScope && currentDepth <= ${depth};
        };
        const interactiveOnly = ${command.interactive === true};
        const elements = [];
        const scanBudget = Math.min(20_000, Math.max(1_000, ${limit} * 40));
        let scanned = 0;
        for (const currentScope of scopes) {
          if (elements.length >= ${limit} || scanned >= scanBudget) break;
          const currentDocument = currentScope.ownerDocument;
          const scanRoot = root => {
            if (elements.length >= ${limit} || scanned >= scanBudget) return;
            const walker = currentDocument.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
            let element = root instanceof Element ? root : walker.nextNode();
            while (element && elements.length < ${limit} && scanned < scanBudget) {
              scanned += 1;
              const interactive = element.matches(${interactiveSelector});
              const semantic = interactive || element.hasAttribute('role') || Boolean(implicitRole(element));
              if (
                semantic &&
                visible(element) &&
                !sensitive(element) &&
                withinDepth(element, currentScope) &&
                (!interactiveOnly || interactive)
              ) {
                elements.push(element);
              }
              if (element.shadowRoot) scanRoot(element.shadowRoot);
              element = walker.nextNode();
            }
          };
          scanRoot(currentScope);
        }
        const textParts = [];
        let textChars = 0;
        let textNodes = 0;
        for (const currentScope of scopes) {
          if (textChars >= ${MAX_TOOL_TEXT_CHARS} || textNodes >= 20_000) break;
          const currentDocument = currentScope.ownerDocument;
          const scanTextRoot = root => {
            if (textChars >= ${MAX_TOOL_TEXT_CHARS} || textNodes >= 20_000) return;
            const textWalker = currentDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT);
            let textNode = textWalker.nextNode();
            while (textNode && textChars < ${MAX_TOOL_TEXT_CHARS} && textNodes < 20_000) {
              textNodes += 1;
              const parent = textNode.parentElement;
              if (parent && !parent.closest('script, style, template, noscript') && visible(parent)) {
                const value = (textNode.nodeValue || '').trim().replace(/\\s+/g, ' ');
                if (value) {
                  const remaining = ${MAX_TOOL_TEXT_CHARS} - textChars;
                  const bounded = value.slice(0, remaining);
                  textParts.push(bounded);
                  textChars += bounded.length + 1;
                }
              }
              textNode = textWalker.nextNode();
            }
            const elementWalker = currentDocument.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
            let element = elementWalker.nextNode();
            while (element) {
              if (element.shadowRoot) scanTextRoot(element.shadowRoot);
              element = elementWalker.nextNode();
            }
          };
          scanTextRoot(currentScope);
        }
        const describedElements = elements.map(describe);
        globalThis.__justdoBrowserAgentState = {
          snapshotId: ${JSON.stringify(snapshotId)},
          refPrefix: ${JSON.stringify(refPrefix)},
          elements,
          refs: describedElements.map(element => element.ref),
          metadata: describedElements.map(element => ({ role: element.role || element.tag, name: element.name })),
        };
        return {
          title: document.title,
          url: location.href,
          text: textParts.join('\\n').slice(0, ${MAX_TOOL_TEXT_CHARS}),
          ariaNext: ariaRegistry.next,
          crossOriginFrames,
          elements: describedElements,
        };
      })()`,
    );
  let result: Awaited<ReturnType<typeof captureAiSnapshot>>;
  try {
    result = await captureAiSnapshot();
  } catch (error) {
    if (
      command.frame?.trim() &&
      /frame was unavailable|blocked a frame|cross-origin|permission denied/i.test(
        serializeError(error),
      )
    ) {
      if (command.labels) {
        throw new Error(
          'Snapshot labels are unavailable for an explicitly selected cross-origin frame.',
        );
      }
      return this.captureAriaSnapshot(command, tab, guest, snapshotId);
    }
    throw error;
  }
  const rootSnapshot: BrowserSnapshot = {
    id: snapshotId,
    url: result.url,
    refPrefix,
    ...(command.frame?.trim() ? { frameSelector: command.frame.trim() } : {}),
    ...(command.refs === 'aria'
      ? { refIndices: new Map(result.elements.map((element, index) => [element.ref, index])) }
      : {}),
  };
  this.snapshots.set(tab.webContentsId, rootSnapshot);
  if (command.refs === 'aria') {
    const ariaState = ariaStateForSnapshot!;
    ariaState.next = Math.max(ariaState.next, result.ariaNext);
    result.elements.forEach(element => {
      ariaState.refs.add(element.ref);
      ariaState.frameSelectors.set(element.ref, command.frame?.trim() ?? '');
      ariaState.worldFrameSelectors.set(element.ref, '');
    });
    this.ariaRefState.set(tab.webContentsId, ariaState);
  }
  const crossFrameNodes: Array<{
    selector: string;
    nodes: Array<{
      ref: string;
      role: string;
      name: string;
      value?: string;
      description?: string;
    }>;
  }> = [];
  let remainingFrameNodes = Math.max(0, limit - result.elements.length);
  for (const frame of (result.crossOriginFrames ?? []).slice(0, 8)) {
    if (remainingFrameNodes <= 0) break;
    try {
      const frameResult = await this.captureAriaSnapshot(
        {
          ...command,
          frame: frame.selector,
          snapshotFormat: 'aria',
          labels: false,
          query: undefined,
          limit: remainingFrameNodes,
          maxChars: MAX_TOOL_TEXT_CHARS,
        },
        tab,
        guest,
        randomBytes(16).toString('hex'),
      );
      const nodes = Array.isArray(frameResult.details.nodes)
        ? (
            frameResult.details.nodes as Array<{
              ref: string;
              role: string;
              name: string;
              value?: string;
              description?: string;
            }>
          ).slice(0, remainingFrameNodes)
        : [];
      if (nodes.length) {
        crossFrameNodes.push({ selector: frame.selector, nodes });
        remainingFrameNodes -= nodes.length;
      }
    } catch {
      // Frames can detach between discovery and AX capture. Keep the rest of the snapshot usable.
    } finally {
      this.snapshots.set(tab.webContentsId, rootSnapshot);
    }
  }
  const crossFrameLabelAnnotations: BrowserLabelAnnotation[] = [];
  for (const frame of crossFrameNodes) {
    try {
      const frameAnnotations = await this.executeInTargetWorld<BrowserLabelAnnotation[]>(
        tab,
        guest,
        frame.selector,
        `(() => {
              const entries = ${JSON.stringify(
                frame.nodes.map(node => ({ ref: node.ref, role: node.role, name: node.name })),
              )};
              return entries.flatMap(entry => {
                const element = globalThis.__justdoBrowserAgentAriaRegistry?.elements?.get(entry.ref);
                if (!element?.isConnected) return [];
                const rect = element.getBoundingClientRect();
                if (rect.width <= 0 || rect.height <= 0) return [];
                return [{ ...entry, box: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } }];
              });
            })()`,
      );
      const frameOffset = await this.resolveTargetFrameOffset(tab, guest, frame.selector);
      frameAnnotations.forEach(annotation =>
        crossFrameLabelAnnotations.push({
          ...annotation,
          box: {
            ...annotation.box,
            x: annotation.box.x + frameOffset.x,
            y: annotation.box.y + frameOffset.y,
          },
        }),
      );
    } catch {
      // A detached frame is reported through labelsSkipped while the text snapshot stays useful.
    }
  }
  this.snapshots.set(tab.webContentsId, rootSnapshot);
  const includeUrls = command.urls === true;
  const deltaMode = command.refs === 'aria' ? 'aria' : 'role';
  const requestedMaxChars = command.maxChars && command.maxChars > 0 ? command.maxChars : undefined;
  const maxChars = Math.max(
    1,
    Math.min(MAX_TOOL_TEXT_CHARS, requestedMaxChars ?? (efficient ? 8_000 : 40_000)),
  );
  const deltaFamilyKey = JSON.stringify({
    identity: deltaMode,
    interactive: command.interactive ?? (efficient ? true : undefined),
    compact: command.compact ?? (efficient ? true : undefined),
    depth,
    selector: command.selector?.trim() || undefined,
    frame: command.frame?.trim() || undefined,
    urls: command.urls,
    maxChars,
  });
  const refIdentityKeys = new Map<string, string>();
  const duplicateCounts = new Map<string, number>();
  const identify = (ref: string, role: string, name: string): void => {
    if (deltaMode === 'aria') {
      refIdentityKeys.set(ref, ref);
      return;
    }
    const base = `${role}\0${name}`;
    const nth = duplicateCounts.get(base) ?? 0;
    duplicateCounts.set(base, nth + 1);
    refIdentityKeys.set(ref, `${base}\0${nth}`);
  };
  result.elements.forEach(element =>
    identify(element.ref, element.role || element.tag, element.name),
  );
  crossFrameNodes.forEach(frame =>
    frame.nodes.forEach(node => identify(node.ref, node.role, node.name)),
  );
  const deltaFamilies = this.snapshotDeltaState.get(tab.webContentsId) ?? new Map();
  const previousDelta = deltaFamilies.get(deltaFamilyKey);
  const documentIdentity = `${result.url}\0${this.navigationGenerations.get(tab.webContentsId) ?? 0}`;
  const previousDeltaKeys =
    previousDelta?.url === documentIdentity ? previousDelta.keys : undefined;
  const newRefs = new Set(
    previousDeltaKeys
      ? [...refIdentityKeys].flatMap(([ref, key]) => (previousDeltaKeys.has(key) ? [] : [ref]))
      : [],
  );
  const elementLines = result.elements.map(element => {
    const role = element.role || element.tag;
    const name = element.name ? ` ${JSON.stringify(element.name)}` : '';
    const href = includeUrls && element.href ? ` url=${JSON.stringify(element.href)}` : '';
    return `- ${role}${name} [ref=${element.ref}]${href}${newRefs.has(element.ref) ? ' [new]' : ''}`;
  });
  const crossFrameLines = crossFrameNodes.flatMap(frame => [
    `frame: ${JSON.stringify(frame.selector)}`,
    ...frame.nodes.map(
      node =>
        `- ${node.role} ${JSON.stringify(node.name)} [ref=${node.ref}]${node.value ? ` value=${JSON.stringify(node.value)}` : ''}${node.description ? ` description=${JSON.stringify(node.description)}` : ''}${newRefs.has(node.ref) ? ' [new]' : ''}`,
    ),
  ]);
  const pendingDialog = this.dialogs.get(tab.webContentsId);
  const unfilteredLines = [
    `title: ${result.title}`,
    `url: ${sanitizeUrlForModel(result.url)}`,
    ...(pendingDialog
      ? [
          `dialog: ${pendingDialog.type} ${JSON.stringify(pendingDialog.message)} id=${pendingDialog.id}`,
        ]
      : []),
    ...elementLines,
    ...crossFrameLines,
    ...(newRefs.size ? [`${newRefs.size} new element(s) since last snapshot`] : []),
    ...(command.compact === true || command.interactive === true || efficient
      ? []
      : ['', result.text]),
  ];
  const baselineSnapshot = unfilteredLines.join('\n').slice(0, maxChars);
  const baselineVisibleRefs = new Set(
    [...baselineSnapshot.matchAll(/\[ref=([^\]]+)\]/gu)].map(match => match[1]!),
  );
  const baselineKeys = new Set(
    [...baselineVisibleRefs].flatMap(ref => {
      const key = refIdentityKeys.get(ref);
      return key ? [key] : [];
    }),
  );
  deltaFamilies.delete(deltaFamilyKey);
  deltaFamilies.set(deltaFamilyKey, { url: documentIdentity, keys: baselineKeys });
  while (deltaFamilies.size > 32) {
    const oldest = deltaFamilies.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    deltaFamilies.delete(oldest);
  }
  this.snapshotDeltaState.set(tab.webContentsId, deltaFamilies);
  let lines = unfilteredLines;
  const queryTokens = command.query?.toLowerCase().split(/\s+/).filter(Boolean) ?? [];
  if (queryTokens.length) {
    lines = lines.filter(line => queryTokens.every(token => line.toLowerCase().includes(token)));
  }
  const rawSnapshot = lines.join('\n');
  const snapshot = rawSnapshot.slice(0, maxChars);
  const visibleRefs = new Set([...snapshot.matchAll(/\[ref=([^\]]+)\]/gu)].map(match => match[1]!));
  const visibleElements = result.elements.filter(element => visibleRefs.has(element.ref));
  const visibleFrameNodes = crossFrameNodes.flatMap(frame =>
    frame.nodes.filter(node => visibleRefs.has(node.ref)),
  );
  const visibleRefCount = visibleElements.length + visibleFrameNodes.length;
  const visibleNewElements = [...visibleRefs].filter(ref => newRefs.has(ref)).length;
  this.snapshotLabelAnnotations.set(tab.webContentsId, {
    snapshotId,
    visibleRefs: [...visibleRefs],
    annotations: crossFrameLabelAnnotations.filter(annotation => visibleRefs.has(annotation.ref)),
  });
  const response: {
    content: Array<
      { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }
    >;
    details: Record<string, unknown>;
  } = {
    content: [{ type: 'text', text: wrapBrowserContent(snapshot) }],
    details: {
      ok: true,
      targetId: tab.targetId,
      url: sanitizeUrlForModel(result.url),
      format: ariaMode ? 'aria' : 'ai',
      refs: visibleRefCount,
      ...(previousDeltaKeys ? { newElements: visibleNewElements } : {}),
      stats: {
        lines: snapshot ? snapshot.split('\n').length : 0,
        chars: snapshot.length,
        refs: visibleRefCount,
        interactive:
          visibleElements.filter(
            element => element.editable || element.role === 'button' || element.role === 'link',
          ).length +
          visibleFrameNodes.filter(node =>
            ['button', 'link', 'textbox', 'checkbox', 'radio', 'combobox'].includes(node.role),
          ).length,
      },
      ...(ariaMode ? { nodeCount: visibleElements.length } : {}),
      truncated: rawSnapshot.length > snapshot.length,
      ...(command.labels
        ? {
            annotations: visibleElements.map((element, index) => ({
              ref: element.ref,
              number: index + 1,
              role: element.role || element.tag,
              box: element.box,
            })),
          }
        : {}),
      ...(pendingDialog
        ? {
            blockedByDialog: true,
            dialog: { id: pendingDialog.id, type: pendingDialog.type },
          }
        : {}),
      externalContent: {
        untrusted: true,
        source: 'browser',
        kind: 'snapshot',
        format: ariaMode ? 'aria' : 'ai',
        wrapped: true,
      },
    },
  };
  if (command.labels) {
    const labeledScreenshot = await this.captureScreenshot(
      { ...command, action: 'screenshot', labels: true },
      tab,
      guest,
    );
    const screenshotContent = Array.isArray(labeledScreenshot.content)
      ? labeledScreenshot.content
      : [];
    const image = screenshotContent.find(item => asRecord(item)?.type === 'image') as
      { type: 'image'; data: string; mimeType: string } | undefined;
    const screenshotDetails = asRecord(labeledScreenshot.details);
    if (image) response.content.push(image);
    response.details = {
      ...response.details,
      labels: true,
      labelsCount: Array.isArray(screenshotDetails?.annotations)
        ? screenshotDetails.annotations.length
        : 0,
      labelsSkipped: Math.max(
        0,
        visibleRefCount -
          (Array.isArray(screenshotDetails?.annotations)
            ? screenshotDetails.annotations.length
            : 0),
      ),
      ...(Array.isArray(screenshotDetails?.annotations)
        ? { annotations: screenshotDetails.annotations }
        : {}),
      media: { outbound: false },
    };
  }
  return response;
}

export function normalizeScreenshotData(
  this: BrowserAgentSnapshotsContext,
  data: string,
  imageType: 'png' | 'jpeg',
): { data: string; width: number; height: number } {
  let image = nativeImage.createFromBuffer(Buffer.from(data, 'base64'));
  let encoded = imageType === 'jpeg' ? image.toJPEG(80) : image.toPNG({ scaleFactor: 1 });
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const size = image.getSize();
    if (
      size.width <= MAX_SCREENSHOT_DIMENSION &&
      size.height <= MAX_SCREENSHOT_DIMENSION &&
      encoded.byteLength <= MAX_SCREENSHOT_BYTES
    ) {
      break;
    }
    const dimensionScale = Math.min(
      1,
      MAX_SCREENSHOT_DIMENSION / Math.max(1, size.width),
      MAX_SCREENSHOT_DIMENSION / Math.max(1, size.height),
    );
    const byteScale = encoded.byteLength > MAX_SCREENSHOT_BYTES ? 0.75 : 1;
    const scale = Math.min(dimensionScale, byteScale);
    image = image.resize({
      width: Math.max(1, Math.floor(size.width * scale)),
      height: Math.max(1, Math.floor(size.height * scale)),
      quality: 'best',
    });
    encoded = imageType === 'jpeg' ? image.toJPEG(75) : image.toPNG({ scaleFactor: 1 });
  }
  if (encoded.byteLength > MAX_SCREENSHOT_BYTES) {
    throw new Error('The screenshot is too large. Retry without fullPage or capture one element.');
  }
  const size = image.getSize();
  return { data: encoded.toString('base64'), width: size.width, height: size.height };
}

export async function captureScreenshot(
  this: BrowserAgentSnapshotsContext,
  command: AgentBrowserCommand,
  tab: RegisteredTab,
  guest: Electron.WebContents,
): Promise<Record<string, unknown>> {
  const imageType = command.type === 'jpeg' ? 'jpeg' : 'png';
  const currentSnapshot = this.snapshots.get(tab.webContentsId);
  if (command.labels && (!currentSnapshot || currentSnapshot.url !== guest.getURL())) {
    await this.captureSnapshot({ ...command, labels: false }, tab, guest);
  }
  let data: string;
  let labelClip: { x: number; y: number; width: number; height: number } | null = null;
  if (command.fullPage) {
    const guestDebugger = await this.enableDebuggerDomains(tab, guest);
    const captured = (await guestDebugger.sendCommand('Page.captureScreenshot', {
      format: imageType,
      ...(imageType === 'jpeg' ? { quality: 80 } : {}),
      captureBeyondViewport: true,
      fromSurface: true,
    })) as { data?: unknown };
    if (typeof captured.data !== 'string') throw new Error('Browser screenshot failed.');
    data = captured.data;
  } else {
    let clip: Electron.Rectangle | undefined;
    if (command.ref || command.element) {
      const currentRef = command.ref
        ? this.assertCurrentRef({ ref: command.ref }, tab, guest)
        : null;
      const rect = await this.executeInTargetWorld<{
        x: number;
        y: number;
        width: number;
        height: number;
      } | null>(
        tab,
        guest,
        currentRef?.worldFrameSelector ?? '',
        `(() => {
            let element = null;
            if (${JSON.stringify(command.element ?? '')}) {
              try { element = document.querySelector(${JSON.stringify(command.element ?? '')}); } catch { return null; }
            } else {
              element = ${currentRef?.expression ?? 'null'};
            }
            if (!element?.isConnected) return null;
            element.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
            const rect = element.getBoundingClientRect();
            let x = rect.x;
            let y = rect.y;
            let currentDocument = element.ownerDocument;
            while (currentDocument && currentDocument !== document) {
              const frameElement = currentDocument.defaultView?.frameElement;
              if (!(frameElement instanceof Element)) break;
              const frameRect = frameElement.getBoundingClientRect();
              x += frameRect.x;
              y += frameRect.y;
              currentDocument = frameElement.ownerDocument;
            }
            return { x, y, width: rect.width, height: rect.height };
          })()`,
      );
      if (!rect || rect.width <= 0 || rect.height <= 0) throw new Error('Element not found.');
      const frameOffset = await this.resolveTargetFrameOffset(
        tab,
        guest,
        currentRef?.worldFrameSelector ?? '',
      );
      rect.x += frameOffset.x;
      rect.y += frameOffset.y;
      const guestDebugger = await this.enableDebuggerDomains(tab, guest);
      const metrics = (await guestDebugger.sendCommand('Page.getLayoutMetrics')) as {
        cssVisualViewport?: { pageX?: number; pageY?: number };
        visualViewport?: { pageX?: number; pageY?: number };
      };
      const viewport = metrics.cssVisualViewport ?? metrics.visualViewport;
      clip = {
        x: Math.max(0, Math.floor(rect.x + (viewport?.pageX ?? 0))),
        y: Math.max(0, Math.floor(rect.y + (viewport?.pageY ?? 0))),
        width: Math.max(1, Math.ceil(rect.width)),
        height: Math.max(1, Math.ceil(rect.height)),
      };
      labelClip = { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
      const captured = (await guestDebugger.sendCommand('Page.captureScreenshot', {
        format: imageType,
        ...(imageType === 'jpeg' ? { quality: 80 } : {}),
        clip: { ...clip, scale: 1 },
        captureBeyondViewport: true,
        fromSurface: true,
      })) as { data?: unknown };
      if (typeof captured.data !== 'string') throw new Error('Browser screenshot failed.');
      data = captured.data;
    } else {
      const image = await guest.capturePage();
      data =
        imageType === 'jpeg'
          ? image.toJPEG(80).toString('base64')
          : image.toPNG().toString('base64');
    }
  }
  const firstNormalization = this.normalizeScreenshotData(data, imageType);
  data = firstNormalization.data;
  let annotations: BrowserLabelAnnotation[] | undefined;
  if (command.labels) {
    const projection =
      currentSnapshot &&
      this.snapshotLabelAnnotations.get(tab.webContentsId)?.snapshotId === currentSnapshot.id
        ? this.snapshotLabelAnnotations.get(tab.webContentsId)
        : undefined;
    const labeled = await this.executeInBrowserWorld<{
      data: string;
      annotations: BrowserLabelAnnotation[];
    }>(
      guest,
      `(async () => {
          const response = await fetch(${JSON.stringify(
            `data:${imageType === 'jpeg' ? 'image/jpeg' : 'image/png'};base64,${data}`,
          )});
          const bitmap = await createImageBitmap(await response.blob());
          const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
          const context = canvas.getContext('2d');
          if (!context) throw new Error('Screenshot labeling is unavailable.');
          context.drawImage(bitmap, 0, 0);
          const fullPage = ${command.fullPage === true};
          const labelClip = ${JSON.stringify(labelClip)};
          const scaleX = bitmap.width / Math.max(1, labelClip?.width ?? (fullPage ? document.documentElement.scrollWidth : innerWidth));
          const scaleY = bitmap.height / Math.max(1, labelClip?.height ?? (fullPage ? document.documentElement.scrollHeight : innerHeight));
          const state = globalThis.__justdoBrowserAgentState;
          const stateRefs = state?.refs || [];
          const stateMetadata = state?.metadata || [];
          const restrictRefs = ${Boolean(projection)};
          const visibleRefs = new Set(${JSON.stringify(projection?.visibleRefs ?? [])});
          const extraAnnotations = ${JSON.stringify(projection?.annotations ?? [])};
          let nextNumber = 1;
          const drawAnnotation = (ref, role, name, sourceBox) => {
            if (restrictRefs && !visibleRefs.has(ref)) return [];
            const captureX = labelClip?.x ?? 0;
            const captureY = labelClip?.y ?? 0;
            const captureWidth = labelClip?.width ?? (fullPage ? document.documentElement.scrollWidth : innerWidth);
            const captureHeight = labelClip?.height ?? (fullPage ? document.documentElement.scrollHeight : innerHeight);
            const sourceX = sourceBox.x + (fullPage ? scrollX : 0);
            const sourceY = sourceBox.y + (fullPage ? scrollY : 0);
            if (
              sourceBox.width <= 0 || sourceBox.height <= 0 ||
              sourceX + sourceBox.width <= captureX || sourceY + sourceBox.height <= captureY ||
              sourceX >= captureX + captureWidth || sourceY >= captureY + captureHeight
            ) return [];
            const x = (sourceX - captureX) * scaleX;
            const y = (sourceY - captureY) * scaleY;
            const width = sourceBox.width * scaleX;
            const height = sourceBox.height * scaleY;
            const number = nextNumber++;
            context.strokeStyle = '#ff2d55';
            context.lineWidth = Math.max(2, 2 * scaleX);
            context.strokeRect(x, y, width, height);
            const radius = Math.max(10, 10 * scaleX);
            context.fillStyle = '#ff2d55';
            context.beginPath();
            context.arc(x + radius, y + radius, radius, 0, Math.PI * 2);
            context.fill();
            context.fillStyle = '#ffffff';
            context.font = 'bold ' + Math.max(12, 12 * scaleX) + 'px sans-serif';
            context.textAlign = 'center';
            context.textBaseline = 'middle';
            context.fillText(String(number), x + radius, y + radius);
            return [{ ref, number, role, name, box: { x, y, width, height } }];
          };
          const annotations = (state?.elements || []).flatMap((element, index) => {
            if (!element?.isConnected) return [];
            const rect = element.getBoundingClientRect();
            let documentOffsetX = 0;
            let documentOffsetY = 0;
            let currentDocument = element.ownerDocument;
            while (currentDocument && currentDocument !== document) {
              const frameElement = currentDocument.defaultView?.frameElement;
              if (!(frameElement instanceof Element)) break;
              const frameRect = frameElement.getBoundingClientRect();
              documentOffsetX += frameRect.x;
              documentOffsetY += frameRect.y;
              currentDocument = frameElement.ownerDocument;
            }
            const ref = stateRefs[index] || (state?.refPrefix || 'e') + (index + 1);
            const metadata = stateMetadata[index] || {};
            return drawAnnotation(ref, metadata.role, metadata.name, {
              x: rect.x + documentOffsetX,
              y: rect.y + documentOffsetY,
              width: rect.width,
              height: rect.height,
            });
          });
          for (const annotation of extraAnnotations) {
            annotations.push(...drawAnnotation(
              annotation.ref,
              annotation.role,
              annotation.name,
              annotation.box,
            ));
          }
          const blob = await canvas.convertToBlob({
            type: ${JSON.stringify(imageType === 'jpeg' ? 'image/jpeg' : 'image/png')},
            quality: 0.8,
          });
          const bytes = new Uint8Array(await blob.arrayBuffer());
          let binary = '';
          for (let offset = 0; offset < bytes.length; offset += 0x8000) {
            binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
          }
          return { data: btoa(binary), annotations };
        })()`,
    );
    data = labeled.data;
    annotations = labeled.annotations;
  }
  const finalNormalization = this.normalizeScreenshotData(data, imageType);
  data = finalNormalization.data;
  if (
    annotations &&
    (finalNormalization.width !== firstNormalization.width ||
      finalNormalization.height !== firstNormalization.height)
  ) {
    const scaleX = finalNormalization.width / Math.max(1, firstNormalization.width);
    const scaleY = finalNormalization.height / Math.max(1, firstNormalization.height);
    annotations = annotations.map(annotation => ({
      ...annotation,
      box: {
        x: annotation.box.x * scaleX,
        y: annotation.box.y * scaleY,
        width: annotation.box.width * scaleX,
        height: annotation.box.height * scaleY,
      },
    }));
  }
  return {
    content: [
      { type: 'image', data, mimeType: imageType === 'jpeg' ? 'image/jpeg' : 'image/png' },
      {
        type: 'text',
        text: 'Browser screenshot captured for Agent observation. The user-facing browser remains live.',
      },
    ],
    details: {
      ok: true,
      targetId: tab.targetId,
      url: sanitizeUrlForModel(guest.getURL()),
      type: imageType,
      ...(annotations ? { annotations } : {}),
      media: { outbound: false },
    },
  };
}

export function assertCurrentRef(
  this: BrowserAgentSnapshotsContext,
  request: Record<string, unknown>,
  tab: RegisteredTab,
  guest: Electron.WebContents,
  key = 'ref',
): {
  ref: string;
  index: number;
  snapshotId: string;
  expression: string;
  aria: boolean;
  frameSelector: string;
  worldFrameSelector: string;
} {
  const ref = typeof request[key] === 'string' ? request[key].trim() : '';
  const ariaState = this.ariaRefState.get(tab.webContentsId);
  if (ref.startsWith('ax') && ariaState?.refs.has(ref)) {
    return {
      ref,
      index: -1,
      snapshotId: '',
      expression: `globalThis.__justdoBrowserAgentAriaRegistry?.elements?.get(${JSON.stringify(ref)}) ?? null`,
      aria: true,
      frameSelector: ariaState.frameSelectors.get(ref) ?? '',
      worldFrameSelector: ariaState.worldFrameSelectors.get(ref) ?? '',
    };
  }
  const snapshot = this.snapshots.get(tab.webContentsId);
  const index = snapshot?.refIndices?.get(ref) ?? parseRefIndex(ref, snapshot?.refPrefix);
  if (
    index === null ||
    index === undefined ||
    !snapshot ||
    snapshot.url !== guest.getURL() ||
    !ref.startsWith(snapshot.refPrefix)
  ) {
    throw new Error('The element ref is stale. Take a new snapshot.');
  }
  return {
    ref,
    index,
    snapshotId: snapshot.id,
    expression: `(() => {
        const state = globalThis.__justdoBrowserAgentState;
        return state?.snapshotId === ${JSON.stringify(snapshot.id)}
          ? state.elements[${index}]
          : null;
      })()`,
    aria: false,
    frameSelector: snapshot.frameSelector ?? '',
    worldFrameSelector: '',
  };
}

export function resolveActElement(
  this: BrowserAgentSnapshotsContext,
  request: Record<string, unknown>,
  tab: RegisteredTab,
  guest: Electron.WebContents,
  refKey = 'ref',
  selectorKey = 'selector',
): { expression: string; label: string; frameSelector: string } {
  if (typeof request[refKey] === 'string' && request[refKey].trim()) {
    const current = this.assertCurrentRef(request, tab, guest, refKey);
    return {
      expression: current.expression,
      label: current.ref,
      frameSelector: current.worldFrameSelector,
    };
  }
  const selector = typeof request[selectorKey] === 'string' ? request[selectorKey].trim() : '';
  if (!selector) throw new Error(`${refKey} or ${selectorKey} is required.`);
  if (selector.length > 2_000) throw new Error(`${selectorKey} is too long.`);
  return {
    expression: `(() => {
        try { return document.querySelector(${JSON.stringify(selector)}); }
        catch { throw new Error('Invalid selector.'); }
      })()`,
    label: selector,
    frameSelector: '',
  };
}
