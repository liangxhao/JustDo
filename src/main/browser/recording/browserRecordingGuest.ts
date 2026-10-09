import { ipcRenderer } from 'electron';

import {
  BrowserRecordingChannel,
  type BrowserRecordingEvent,
  isSensitiveRecordingField,
  RecordingAction,
  recordingPageTitle,
  recordingText,
  recordingUrl,
} from '../../../shared/browser/browserRecording';
import { createRecordingElementDescriber } from './browserRecordingElement';

/** Passive observation only. Never exposes privileged APIs to the page. */
export function installBrowserRecordingGuest(): void {
  const documentId = crypto.randomUUID();
  let recordingId = '';
  let active = false;
  let sequence = 0;
  let revision = 0;
  let controlEpoch = 0;
  const watchedRoots = new Map<Node, MutationObserver>();
  const rootScanners = new Map<Node, () => void>();
  const knownScanners = new WeakMap<Node, () => void>();
  let scanTimer: ReturnType<typeof setTimeout> | undefined;
  const observeOptions = {
    subtree: true,
    childList: true,
    attributes: true,
    attributeOldValue: true,
  };
  const watchRoot = (root: Node) => {
    if (watchedRoots.has(root)) return;
    const containsPassword = (node: Node): boolean => {
      if (node.nodeType !== 1) return false;
      const element = node as Element;
      return (
        sensitive(element) ||
        Array.from(element.querySelectorAll('input,textarea,[contenteditable]')).some(sensitive)
      );
    };
    const observer = new MutationObserver(records => {
      // A reveal toggle can happen before the field itself was interacted with.
      // Retain its previous password identity, not only the screenshot revision.
      for (const record of records) {
        if (
          record.type === 'attributes' &&
          ['type', 'id', 'name', 'autocomplete', 'aria-label', 'placeholder'].includes(
            record.attributeName ?? '',
          ) &&
          isSensitiveRecordingField(record.oldValue ?? '')
        )
          passwordElements.add(record.target as Element);
      }
      if (records.some(record => record.type === 'childList') && !scanTimer) {
        scanTimer = setTimeout(() => {
          scanTimer = undefined;
          if (active)
            for (const [root, scan] of rootScanners) {
              const connected =
                root.nodeType === 9
                  ? root === document ||
                    Boolean((root as Document).defaultView?.frameElement?.isConnected)
                  : Boolean((root as ShadowRoot).host?.isConnected);
              if (!connected) {
                watchedRoots.get(root)?.disconnect();
                watchedRoots.delete(root);
                rootScanners.delete(root);
              } else scan();
            }
        }, 100);
      }
      // Ordinary animations/ad updates must not invalidate every screenshot. Retain
      // the race guard for password-related changes, including insertion/removal.
      if (
        records.some(
          record =>
            (record.type === 'attributes' &&
              (sensitive(record.target as Element) ||
                (['style', 'class', 'hidden', 'open'].includes(record.attributeName ?? '') &&
                  containsPassword(record.target)) ||
                isSensitiveRecordingField(record.oldValue ?? ''))) ||
            [...record.addedNodes, ...record.removedNodes].some(containsPassword),
        )
      )
        revision += 1;
    });
    watchedRoots.set(root, observer);
    if (active) observer.observe(root, observeOptions);
  };
  watchRoot(document);
  let composing = false;
  let scrollIntentAt = 0;
  let pending: Element | null = null;
  let scrollTimer: ReturnType<typeof setTimeout> | undefined;
  let pendingScroll: (() => void) | undefined;
  const flushScroll = () => {
    clearTimeout(scrollTimer);
    const finish = pendingScroll;
    pendingScroll = undefined;
    finish?.();
  };
  const passwordElements = new WeakSet<Element>();
  const sensitive = (element: Element): boolean => {
    const editable = element.closest('input,textarea,[contenteditable]');
    if (editable && editable !== element && sensitive(editable)) return true;
    if (passwordElements.has(element)) return true;
    const input = element as HTMLInputElement;
    const password = isSensitiveRecordingField(
      [
        element.getAttribute('type'),
        element.id,
        element.getAttribute('name'),
        element.getAttribute('autocomplete'),
        element.getAttribute('aria-label'),
        element.getAttribute('placeholder'),
        input.labels?.[0]?.textContent,
      ].join(' '),
    );
    if (password) passwordElements.add(element);
    return password;
  };
  const { describe, selector, state, safeText } = createRecordingElementDescriber(sensitive);
  let finishObservation: (() => void) | undefined;
  let observationTimer: ReturnType<typeof setTimeout> | undefined;
  const flushObservation = () => {
    clearTimeout(observationTimer);
    const finish = finishObservation;
    finishObservation = undefined;
    finish?.();
  };
  const notices = (doc: Document): string[] =>
    Array.from(
      doc.querySelectorAll('[role=alert],[role=status],[role=dialog],dialog[open],[role=menu]'),
    )
      .slice(0, 30)
      .filter(el => el.getClientRects().length > 0 && !sensitive(el))
      .map(el => safeText(el))
      .filter(Boolean)
      .slice(0, 5);
  const emit = (
    event: Omit<BrowserRecordingEvent, 'recordingId' | 'documentId' | 'sequence'>,
  ): void => {
    if (!active) return;
    if (event.action !== RecordingAction.Scroll && event.action !== RecordingAction.Observe)
      flushScroll();
    if (event.action !== RecordingAction.Observe) flushObservation();
    ipcRenderer.sendToHost(BrowserRecordingChannel.Event, {
      ...event,
      url: recordingUrl(location.href),
      title: recordingPageTitle(document.title),
      time: Date.now(),
      recordingId,
      documentId,
      sequence: ++sequence,
    });
  };
  const observeOutcome = (
    element: Element,
    before: Record<string, string | boolean>,
    beforeMessages: string[],
    beforeUrl: string,
  ) => {
    const relatedSequence = sequence;
    finishObservation = () => {
      if (!active || sensitive(element)) return;
      const after = element.isConnected ? state(element) : {};
      const changedState = Object.fromEntries(
        Object.entries(after).filter(([key, value]) => before[key] !== value),
      );
      const messages = notices(element.ownerDocument).filter(
        value => !beforeMessages.includes(value),
      );
      const url = recordingUrl(element.ownerDocument.URL);
      if (Object.keys(changedState).length || messages.length || url !== beforeUrl)
        emit({
          action: RecordingAction.Observe,
          relatedSequence,
          interaction: {
            observed: {
              ...(Object.keys(changedState).length ? { state: changedState } : {}),
              ...(messages.length ? { messages } : {}),
              ...(url !== beforeUrl ? { url } : {}),
            },
          },
        });
    };
    observationTimer = setTimeout(flushObservation, 450);
  };
  const flush = (): void => {
    const element = pending;
    if (!element || composing) return;
    pending = null;
    const hidden = sensitive(element);
    emit({
      action: RecordingAction.Input,
      target: hidden
        ? { tag: element.localName, role: '', name: '', selector: '' }
        : describe(element),
      ...(hidden
        ? { sensitive: true }
        : {
            value: recordingText((element as HTMLInputElement).value ?? element.textContent, 2000),
          }),
    });
  };
  ipcRenderer.on(BrowserRecordingChannel.Control, (_event, command: unknown) => {
    if (!command || typeof command !== 'object') return;
    const control = command as { recordingId?: unknown; active?: unknown; requestId?: unknown };
    if (typeof control.recordingId !== 'string' || typeof control.active !== 'boolean') return;
    if (control.recordingId !== recordingId) {
      clearTimeout(observationTimer);
      finishObservation = undefined;
      pending = null;
      pendingScroll = undefined;
      clearTimeout(scrollTimer);
      sequence = 0;
    }
    if (!control.active) {
      flush();
      flushScroll();
      flushObservation();
      clearTimeout(scrollTimer);
      clearTimeout(scanTimer);
      scanTimer = undefined;
    }
    controlEpoch++;
    recordingId = control.recordingId;
    if (active !== control.active) {
      revision += 1;
      for (const [root, observer] of watchedRoots) {
        if (control.active) observer.observe(root, observeOptions);
        else observer.disconnect();
      }
    }
    active = control.active;
    if (active) for (const scan of rootScanners.values()) scan();
    ipcRenderer.sendToHost(BrowserRecordingChannel.Ready, {
      recordingId,
      documentId,
      active,
      ...(typeof control.requestId === 'string' ? { requestId: control.requestId } : {}),
    });
  });
  ipcRenderer.on(BrowserRecordingChannel.Capture, (_event, requestId: unknown) => {
    if (typeof requestId !== 'string' || !active) return;
    // Only visible password fields block a screenshot. Embedded media, ordinary
    // form fields and hidden login forms no longer suppress the whole page.
    const unsafeRoot = (root: Document | ShadowRoot, depth = 0): boolean => {
      watchRoot(root);
      if (depth > 8) return false;
      if (
        Array.from(root.querySelectorAll('input,textarea,[contenteditable]')).some(
          element => sensitive(element) && element.getClientRects().length > 0,
        )
      )
        return true;
      const elements = root.querySelectorAll('*');
      return Array.from(elements).some(
        element =>
          (element.shadowRoot && unsafeRoot(element.shadowRoot, depth + 1)) ||
          (element.localName === 'iframe' &&
            element.getClientRects().length > 0 &&
            (element as HTMLIFrameElement).contentDocument &&
            unsafeRoot((element as HTMLIFrameElement).contentDocument!, depth + 1)),
      );
    };
    const unsafe = unsafeRoot(document);
    ipcRenderer.sendToHost(BrowserRecordingChannel.Capture, {
      requestId,
      documentId,
      safe: !unsafe,
      revision,
    });
  });
  const observed = new WeakSet<Node>();
  const handledEvents = new WeakSet<Event>();
  const observe = (doc: Document, eventRoot: Document | ShadowRoot = doc): void => {
    if (observed.has(eventRoot)) {
      const scan = knownScanners.get(eventRoot);
      if (scan && !rootScanners.has(eventRoot)) {
        watchRoot(eventRoot);
        rootScanners.set(eventRoot, scan);
      }
      return;
    }
    observed.add(eventRoot);
    watchRoot(eventRoot);
    const listen = <K extends keyof DocumentEventMap>(
      name: K,
      handler: (event: DocumentEventMap[K]) => void,
      options?: boolean | AddEventListenerOptions,
    ) => {
      eventRoot.addEventListener(
        name,
        ((event: Event) => {
          if (handledEvents.has(event)) return;
          handledEvents.add(event);
          handler(event as DocumentEventMap[K]);
        }) as EventListener,
        options,
      );
    };
    const elementFor = (event: Event): Element | null => {
      const target = event.composedPath()[0];
      return target && (target as Node).nodeType === 1 ? (target as Element) : null;
    };
    listen(
      'compositionstart',
      () => {
        composing = true;
      },
      true,
    );
    listen(
      'compositionend',
      () => {
        composing = false;
      },
      true,
    );
    listen(
      'input',
      event => {
        if (!active || !event.isTrusted) return;
        const element = elementFor(event);
        if (
          !element ||
          element.tagName === 'SELECT' ||
          ['checkbox', 'radio', 'file'].includes((element as HTMLInputElement).type)
        )
          return;
        if (pending && pending !== element) flush();
        pending = element;
      },
      true,
    );
    listen('focusout', flush, true);
    listen(
      'pointerdown',
      event => {
        if (active && event.isTrusted && pending !== elementFor(event)) flush();
      },
      true,
    );
    listen(
      'click',
      event => {
        if (!active || !event.isTrusted) return;
        let element = elementFor(event);
        if (!element) return;
        element = element.closest('button,a,input,select,[role="button"],[role="link"]') ?? element;
        const input = element as HTMLInputElement;
        if (element.tagName === 'SELECT' || ['checkbox', 'radio'].includes(input.type)) return;
        flush();
        const hidden = sensitive(element);
        const before = state(element);
        const beforeMessages = notices(element.ownerDocument);
        const beforeUrl = recordingUrl(element.ownerDocument.URL);
        const rect = element.getBoundingClientRect();
        const raw = elementFor(event);
        emit({
          action: event.detail >= 2 ? RecordingAction.DoubleClick : RecordingAction.Click,
          target: hidden
            ? { tag: element.localName, role: '', name: '', selector: '' }
            : describe(element),
          ...(hidden ? { sensitive: true } : {}),
          ...(!hidden
            ? {
                interaction: {
                  origin: raw && !sensitive(raw) ? selector(raw) : '',
                  pointer: {
                    x: event.clientX,
                    y: event.clientY,
                    offsetX: Math.round(event.clientX - rect.left),
                    offsetY: Math.round(event.clientY - rect.top),
                    button: event.button,
                  },
                  modifiers: [
                    event.ctrlKey && 'Control',
                    event.altKey && 'Alt',
                    event.shiftKey && 'Shift',
                    event.metaKey && 'Meta',
                  ].filter(Boolean) as string[],
                },
              }
            : {}),
        });
        if (!hidden) observeOutcome(element, before, beforeMessages, beforeUrl);
      },
      true,
    );
    listen(
      'change',
      event => {
        if (!active || !event.isTrusted) return;
        const element = elementFor(event);
        if (!element) return;
        const input = element as HTMLInputElement;
        if (input.type === 'file') return;
        if (element.tagName !== 'SELECT' && !['checkbox', 'radio'].includes(input.type)) return;
        flush();
        const hidden = sensitive(element);
        emit({
          action: RecordingAction.Select,
          target: hidden
            ? { tag: element.localName, role: '', name: '', selector: '' }
            : describe(element),
          ...(hidden
            ? { sensitive: true }
            : {
                interaction:
                  element.tagName === 'SELECT'
                    ? {
                        options: Array.from((element as HTMLSelectElement).selectedOptions)
                          .slice(0, 32)
                          .map(o => ({
                            label: recordingText(o.label),
                            value: recordingText(o.value, 2000),
                            index: o.index,
                          })),
                      }
                    : undefined,
                value:
                  element.tagName === 'SELECT'
                    ? Array.from((element as HTMLSelectElement).selectedOptions)
                        .map(o => recordingText(o.label))
                        .join(', ')
                    : String(input.checked),
              }),
        });
      },
      true,
    );
    listen(
      'keydown',
      event => {
        if (event.isTrusted) scrollIntentAt = Date.now();
        if (
          !active ||
          !event.isTrusted ||
          event.isComposing ||
          ['Control', 'Alt', 'Shift', 'Meta', 'AltGraph'].includes(event.key) ||
          (![
            'Enter',
            'Tab',
            'Escape',
            'ArrowUp',
            'ArrowDown',
            'ArrowLeft',
            'ArrowRight',
            'Home',
            'End',
            'PageUp',
            'PageDown',
          ].includes(event.key) &&
            !(event.ctrlKey || event.altKey || event.metaKey))
        )
          return;
        flush();
        const element = elementFor(event) ?? doc.activeElement;
        const hidden = element ? sensitive(element) : false;
        const before = element ? state(element) : {};
        const beforeMessages = notices(doc);
        const beforeUrl = recordingUrl(doc.URL);
        const modifiers = [
          event.ctrlKey && 'Control',
          event.altKey && 'Alt',
          event.shiftKey && 'Shift',
          event.metaKey && 'Meta',
        ].filter(Boolean) as string[];
        emit({
          action: RecordingAction.Key,
          ...(element ? { target: describe(element) } : {}),
          ...(hidden
            ? { sensitive: true }
            : { value: [...modifiers, event.key].join('+'), interaction: { modifiers } }),
        });
        if (element && !hidden) observeOutcome(element, before, beforeMessages, beforeUrl);
      },
      true,
    );
    for (const name of ['wheel', 'touchmove', 'pointermove'] as const) {
      listen(
        name,
        event => {
          if (event.isTrusted) scrollIntentAt = Date.now();
        },
        { capture: true, passive: true },
      );
    }
    listen(
      'scroll',
      event => {
        if (!active || !event.isTrusted || Date.now() - scrollIntentAt > 1000) return;
        clearTimeout(scrollTimer);
        const element = elementFor(event) ?? doc.scrollingElement;
        const epoch = controlEpoch;
        pendingScroll = () => {
          if (!element || epoch !== controlEpoch) return;
          emit({
            action: RecordingAction.Scroll,
            target: { ...describe(element), name: '' },
            value: `${Math.round(element.scrollLeft)},${Math.round(element.scrollTop)}`,
            interaction: {
              scroll: {
                scope: element === doc.scrollingElement ? 'page' : 'element',
                x: Math.round(element.scrollLeft),
                y: Math.round(element.scrollTop),
              },
            },
          });
        };
        scrollTimer = setTimeout(flushScroll, 250);
      },
      true,
    );
    doc.defaultView?.addEventListener('pagehide', () => {
      flush();
      flushScroll();
      flushObservation();
    });
    listen(
      'contextmenu',
      event => {
        if (!active || !event.isTrusted) return;
        const element = elementFor(event);
        if (!element) return;
        flush();
        const hidden = sensitive(element);
        emit({
          action: RecordingAction.ContextMenu,
          target: describe(element),
          ...(hidden ? { sensitive: true } : {}),
        });
      },
      true,
    );
    let dragSource: Element | null = null;
    let dragEpoch = 0;
    listen(
      'dragstart',
      event => {
        if (!active || !event.isTrusted) return;
        flush();
        dragSource = elementFor(event);
        dragEpoch = controlEpoch;
      },
      true,
    );
    listen(
      'drop',
      event => {
        if (!active || !event.isTrusted || !dragSource || dragEpoch !== controlEpoch) return;
        const destination = elementFor(event);
        const hidden = sensitive(dragSource) || Boolean(destination && sensitive(destination));
        emit({
          action: RecordingAction.Drag,
          target: describe(dragSource),
          ...(hidden
            ? { sensitive: true }
            : {
                interaction: {
                  origin: selector(dragSource),
                  destination: destination ? selector(destination) : '',
                  destinationElement: destination ? describe(destination) : undefined,
                },
              }),
        });
        dragSource = null;
      },
      true,
    );
    listen(
      'dragend',
      () => {
        dragSource = null;
      },
      true,
    );
    let hoverTimer: ReturnType<typeof setTimeout> | undefined;
    listen(
      'pointerover',
      event => {
        clearTimeout(hoverTimer);
        if (!active || !event.isTrusted) return;
        const element = elementFor(event)?.closest(
          '[aria-haspopup],[aria-expanded],[role=menuitem]',
        );
        if (!element || sensitive(element)) return;
        const before = notices(doc);
        const epoch = controlEpoch;
        const expanded = element.getAttribute('aria-expanded');
        hoverTimer = setTimeout(() => {
          if (!active || epoch !== controlEpoch || !element.isConnected || sensitive(element))
            return;
          const messages = notices(doc).filter(value => !before.includes(value));
          if (messages.length || expanded !== element.getAttribute('aria-expanded')) {
            flush();
            emit({
              action: RecordingAction.Hover,
              target: describe(element),
              interaction: { observed: { state: state(element), messages } },
            });
          }
        }, 350);
      },
      true,
    );
    listen('pointerout', () => clearTimeout(hoverTimer), true);
    // Same-origin frames only; cross-origin access is deliberately not elevated.
    const scan = (): void => {
      for (const frame of Array.from(eventRoot.querySelectorAll('iframe')).slice(0, 32)) {
        try {
          if (frame.contentDocument) observe(frame.contentDocument);
        } catch {
          /* isolated frame */
        }
      }
    };
    const originalScan = scan;
    const scanRoots = () => {
      originalScan();
      for (const element of Array.from(eventRoot.querySelectorAll('*')).slice(0, 2000)) {
        if (element.shadowRoot) observe(doc, element.shadowRoot);
      }
    };
    rootScanners.set(eventRoot, scanRoots);
    knownScanners.set(eventRoot, scanRoots);
    listen('load', scanRoots, true);
    scanRoots();
  };
  observe(document);
}
