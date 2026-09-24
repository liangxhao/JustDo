import { randomBytes } from 'crypto';
import fs from 'fs';
import path from 'path';

import { type BrowserAgentProfile, BrowserIpc } from '../../shared/browser/browser';
import {
  armBrowserAgentDownload,
  beginBrowserAgentDownload,
  reserveBrowserAgentOutputPath,
} from './browserAgentDownloadCoordinator';
import {
  ACT_DOWNLOAD_EVENT_GRACE_MS,
  ACT_DOWNLOAD_MAX_DRAIN_MS,
  AgentBrowserCommand,
  ARMED_INTERACTION_TIMEOUT_MS,
  asRecord,
  boundedJson,
  BrowserDialogResponse,
  BrowserDialogState,
  BrowserLogEntry,
  browserScopeId,
  BrowserSnapshot,
  BrowserUploadResponse,
  DEVICE_DESCRIPTORS,
  LONG_COMMAND_TIMEOUT_MS,
  MAX_ACT_DOWNLOADS,
  MAX_BATCH_ACTIONS,
  MAX_TOOL_TEXT_CHARS,
  normalizeInputModifiers,
  normalizeKeyChord,
  normalizeNavigationUrl,
  readDeviceDescriptor,
  RegisteredTab,
  sanitizeErrorForModel,
  wrapBrowserContent,
} from './browserAgentProtocol';
import { sanitizeBrowserUrl as sanitizeUrlForModel } from './browserDataSanitizers';
export interface BrowserAgentActionsContext {
  readonly resolveTab: (sessionId: string, targetReference?: string) => RegisteredTab | null;
  readonly navigationGenerations: Map<number, number>;
  readonly executeAct: (
    request: Record<string, unknown>,
    tab: RegisteredTab,
    guest: Electron.WebContents,
    sessionId: string,
    profile: BrowserAgentProfile,
    preserveSnapshot?: boolean,
    assertActive?: () => void,
  ) => Promise<Record<string, unknown>>;
  readonly blockedDialogResult: (webContentsId: number) => Record<string, unknown> | null;
  readonly waitForPossibleNavigation: (
    guest: Electron.WebContents,
    beforeGeneration: number,
    beforeUrl?: string,
    assertActive?: () => void,
  ) => Promise<'navigation' | 'closed' | 'dialog' | null>;
  readonly snapshots: Map<number, BrowserSnapshot>;
  readonly resolveActElement: (
    request: Record<string, unknown>,
    tab: RegisteredTab,
    guest: Electron.WebContents,
    refKey?: string,
    selectorKey?: string,
  ) => { expression: string; label: string; frameSelector: string };
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
  readonly waitWhileActive: (milliseconds: number, assertActive: () => void) => Promise<void>;
  readonly focusGuestForKeyboardInput: (guest: Electron.WebContents) => void;
  readonly enableDebuggerDomains: (
    tab: RegisteredTab,
    guest: Electron.WebContents,
  ) => Promise<Electron.Debugger>;
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
  readonly executeInBrowserWorld: <T>(guest: Electron.WebContents, code: string) => Promise<T>;
  readonly evaluateWithDebugger: (
    tab: RegisteredTab,
    guest: Electron.WebContents,
    fn: string,
    timeoutMs: number,
    ref?: { expression: string; frameSelector: string; worldFrameSelector: string; aria: boolean },
    assertActive?: () => void,
  ) => Promise<unknown>;
  readonly pendingNetworkRequests: Map<number, Set<string>>;
  readonly lastNetworkActivity: Map<number, number>;
  readonly sendToRenderer: (channel: string, payload: unknown) => void;
  readonly discardTabRuntime: (tab: RegisteredTab) => void;
  readonly removeRegisteredTab: (sessionId: string, targetId: string) => string | null;
  readonly armUpload: (
    tab: RegisteredTab,
    guest: Electron.WebContents,
    files: string[],
  ) => Promise<{ completion: Promise<void> }>;
  readonly clearArmedUpload: (
    webContentsId: number,
    guest?: Electron.WebContents,
    error?: Error,
  ) => BrowserUploadResponse | undefined;
  readonly resolveUploadPaths: (sessionId: string, requestedPaths: unknown) => string[];
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
  readonly captureScreenshot: (
    command: AgentBrowserCommand,
    tab: RegisteredTab,
    guest: Electron.WebContents,
  ) => Promise<Record<string, unknown>>;
  readonly consoleLogs: Map<number, BrowserLogEntry[]>;
  readonly requestLogs: Map<number, BrowserLogEntry[]>;
  readonly errorLogs: Map<number, BrowserLogEntry[]>;
  readonly resolveManagedOutputPath: (
    sessionId: string,
    requestedPath: string | undefined,
    defaultName: string,
  ) => string;
  readonly assertManagedOutputPath: (sessionId: string, outputPath: string) => void;
  readonly setFileInputFiles: (
    command: AgentBrowserCommand,
    tab: RegisteredTab,
    guest: Electron.WebContents,
    files: string[],
    sessionId: string,
    profile: BrowserAgentProfile,
    assertActive: () => void,
  ) => Promise<void>;
  readonly dialogs: Map<number, BrowserDialogState>;
  readonly clearArmedDialog: (webContentsId: number) => BrowserDialogResponse | undefined;
  readonly armedDialogs: Map<number, BrowserDialogResponse>;
  readonly readActRequest: (command: AgentBrowserCommand) => Record<string, unknown>;
}

export async function executeAct(
  this: BrowserAgentActionsContext,
  request: Record<string, unknown>,
  tab: RegisteredTab,
  guest: Electron.WebContents,
  sessionId: string,
  profile: BrowserAgentProfile,
  preserveSnapshot = false,
  assertActive: () => void = () => undefined,
): Promise<Record<string, unknown>> {
  const kind = typeof request.kind === 'string' ? request.kind : '';
  const beforeUrl = guest.getURL();
  const scopeId = browserScopeId(sessionId, profile);
  if (request.targetId && request.targetId !== tab.targetId) {
    const requested = this.resolveTab(scopeId, String(request.targetId));
    if (!requested || requested.targetId !== tab.targetId) {
      throw new Error('Nested act targetId does not match the selected tab.');
    }
  }
  if (kind === 'batch') {
    const actions = Array.isArray(request.actions) ? request.actions : [];
    if (!actions.length || actions.length > MAX_BATCH_ACTIONS) {
      throw new Error(`actions must contain between 1 and ${MAX_BATCH_ACTIONS} entries.`);
    }
    const results: Array<Record<string, unknown>> = [];
    let mutated = false;
    for (let index = 0; index < actions.length; index += 1) {
      const nested = asRecord(actions[index]);
      if (!nested || nested.kind === 'batch') throw new Error('Nested batch actions are invalid.');
      try {
        const actionBeforeUrl = guest.getURL();
        const beforeGeneration = this.navigationGenerations.get(guest.id) ?? 0;
        await this.executeAct(nested, tab, guest, sessionId, profile, true, assertActive);
        const blockedByDialog = this.blockedDialogResult(tab.webContentsId);
        if (blockedByDialog) return blockedByDialog;
        if (nested.kind === 'close') {
          results.push({ ok: true });
          return {
            results,
            aborted: {
              reason: 'closed',
              afterAction: index + 1,
              url: sanitizeUrlForModel(beforeUrl),
              skipped: actions.length - index - 1,
            },
          };
        }
        const stateChange = new Set([
          'click',
          'clickCoords',
          'type',
          'press',
          'drag',
          'select',
          'fill',
          'resize',
          'evaluate',
        ]).has(String(nested.kind));
        mutated ||= stateChange;
        const navigation = stateChange
          ? await this.waitForPossibleNavigation(
              guest,
              beforeGeneration,
              actionBeforeUrl,
              assertActive,
            )
          : null;
        if (navigation === 'dialog') {
          return this.blockedDialogResult(tab.webContentsId)!;
        }
        if (navigation === 'closed') {
          results.push({ ok: true });
          return {
            results,
            aborted: {
              reason: 'closed',
              afterAction: index + 1,
              url: sanitizeUrlForModel(actionBeforeUrl),
              skipped: actions.length - index - 1,
            },
          };
        }
        const navigated = navigation === 'navigation';
        results.push({
          ok: true,
          ...(navigated ? { navigated: true, url: sanitizeUrlForModel(guest.getURL()) } : {}),
        });
        if (navigated) {
          return {
            results,
            aborted: {
              reason: 'navigation',
              afterAction: index + 1,
              url: sanitizeUrlForModel(guest.getURL()),
              skipped: actions.length - index - 1,
            },
          };
        }
      } catch (error) {
        results.push({ ok: false, error: sanitizeErrorForModel(error) });
        if (request.stopOnError !== false) break;
      }
    }
    if (mutated && !preserveSnapshot) this.snapshots.delete(tab.webContentsId);
    return { results };
  }
  if (kind === 'click' || kind === 'type' || kind === 'hover' || kind === 'scrollIntoView') {
    const target = this.resolveActElement(request, tab, guest);
    if (kind === 'type' && typeof request.text !== 'string') throw new Error('text is required.');
    const clickButton =
      request.button === 'right' || request.button === 'middle' ? request.button : 'left';
    const clickModifiers = normalizeInputModifiers(request.modifiers);
    const prepared = await this.executeInTargetWorld<{
      x: number;
      y: number;
      disabled: boolean;
      editable: boolean;
      receivesPointer: boolean;
    } | null>(
      tab,
      guest,
      target.frameSelector,
      `(() => {
          const element = ${target.expression};
          if (!element?.isConnected) return null;
          element.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
          const rect = element.getBoundingClientRect();
          if (rect.width <= 0 || rect.height <= 0) return null;
          let x = rect.left + rect.width / 2;
          let y = rect.top + rect.height / 2;
          let currentDocument = element.ownerDocument;
          let receivesPointer = true;
          const hitRoot = element.getRootNode?.() ?? currentDocument;
          if (typeof hitRoot.elementFromPoint === 'function') {
            const hit = hitRoot.elementFromPoint(x, y);
            if (!hit || (hit !== element && !element.contains(hit))) receivesPointer = false;
          }
          while (currentDocument && currentDocument !== document) {
            const frameElement = currentDocument.defaultView?.frameElement;
            if (!(frameElement instanceof Element)) return null;
            const frameRect = frameElement.getBoundingClientRect();
            x += frameRect.left + frameElement.clientLeft;
            y += frameRect.top + frameElement.clientTop;
            currentDocument = frameElement.ownerDocument;
            if (typeof currentDocument.elementFromPoint === 'function') {
              const hit = currentDocument.elementFromPoint(x, y);
              if (!hit || (hit !== frameElement && !frameElement.contains(hit))) receivesPointer = false;
            }
          }
          const tag = String(element.tagName || '').toLowerCase();
          const inputType = tag === 'input' ? String(element.type || '').toLowerCase() : '';
          const editable =
            (tag === 'input' && !['hidden', 'file', 'button', 'submit', 'reset', 'checkbox', 'radio'].includes(inputType)) ||
            tag === 'textarea' || element.isContentEditable;
          if (${JSON.stringify(kind)} === 'type') element.focus({ preventScroll: true });
          return {
            x,
            y,
            disabled: Boolean(element.disabled || element.getAttribute('aria-disabled') === 'true'),
            editable,
            receivesPointer,
          };
        })()`,
    );
    if (!prepared) throw new Error('The element ref is stale. Take a new snapshot.');
    const frameOffset = await this.resolveTargetFrameOffset(tab, guest, target.frameSelector);
    prepared.x += frameOffset.x;
    prepared.y += frameOffset.y;
    assertActive();
    if (kind === 'scrollIntoView') return { scrolled: target.label };
    if (kind === 'hover') {
      guest.sendInputEvent({ type: 'mouseMove', x: prepared.x, y: prepared.y });
      return { hovered: target.label };
    }
    if (kind === 'click') {
      if (prepared.disabled) throw new Error('The selected element is disabled.');
      if (prepared.receivesPointer === false) {
        throw new Error('The selected element is obscured. Take a new snapshot.');
      }
      await this.waitWhileActive(
        Math.max(0, Math.min(1_000, Number(request.delayMs) || 0)),
        assertActive,
      );
      guest.sendInputEvent({
        type: 'mouseMove',
        x: prepared.x,
        y: prepared.y,
        modifiers: clickModifiers,
      });
      const clickCount = request.doubleClick === true ? 2 : 1;
      for (let count = 1; count <= clickCount; count += 1) {
        assertActive();
        guest.sendInputEvent({
          type: 'mouseDown',
          x: prepared.x,
          y: prepared.y,
          button: clickButton,
          clickCount: count,
          modifiers: clickModifiers,
        });
        guest.sendInputEvent({
          type: 'mouseUp',
          x: prepared.x,
          y: prepared.y,
          button: clickButton,
          clickCount: count,
          modifiers: clickModifiers,
        });
      }
    } else {
      if (!prepared.editable) throw new Error('The selected element is not editable.');
      const text = request.text as string;
      const applyText = async (
        value: string,
        data: string | null,
        inputType: 'deleteContentBackward' | 'insertText',
      ): Promise<boolean> =>
        this.executeInTargetWorld<boolean>(
          tab,
          guest,
          target.frameSelector,
          `(() => {
              const element = ${target.expression};
              if (!element?.isConnected) return false;
              const tag = String(element.tagName || '').toLowerCase();
              const value = ${JSON.stringify(value)};
              if (tag === 'input') {
                const Input = element.ownerDocument.defaultView?.HTMLInputElement;
                const setter = Object.getOwnPropertyDescriptor(Input?.prototype ?? {}, 'value')?.set;
                if (!setter) return false;
                setter.call(element, value);
              } else if (tag === 'textarea') {
                const Textarea = element.ownerDocument.defaultView?.HTMLTextAreaElement;
                const setter = Object.getOwnPropertyDescriptor(Textarea?.prototype ?? {}, 'value')?.set;
                if (!setter) return false;
                setter.call(element, value);
              } else if (element.isContentEditable) {
                element.textContent = value;
              } else return false;
              element.focus({ preventScroll: true });
              const view = element.ownerDocument.defaultView;
              const eventInit = {
                bubbles: true,
                composed: true,
                inputType: ${JSON.stringify(inputType)},
                data: ${JSON.stringify(data)},
              };
              const inputEvent = typeof view?.InputEvent === 'function'
                ? new view.InputEvent('input', eventInit)
                : new view.Event('input', { bubbles: true, composed: true });
              element.dispatchEvent(inputEvent);
              return true;
            })()`,
        );
      if (request.slowly === true) {
        const delayMs = Math.max(0, Math.min(1_000, Number(request.delayMs) || 50));
        if (!(await applyText('', null, 'deleteContentBackward'))) {
          throw new Error('Browser text input did not reach the selected element.');
        }
        let value = '';
        for (const character of text) {
          assertActive();
          value += character;
          if (!(await applyText(value, character, 'insertText'))) {
            throw new Error('Browser text input did not reach the selected element.');
          }
          await this.waitWhileActive(delayMs, assertActive);
        }
      } else if (!(await applyText(text, text, 'insertText'))) {
        throw new Error('Browser text input did not reach the selected element.');
      }
      assertActive();
      const typedIntoTarget = await this.executeInTargetWorld<boolean>(
        tab,
        guest,
        target.frameSelector,
        `(() => {
            const element = ${target.expression};
            if (!element?.isConnected) return false;
            const tag = String(element.tagName || '').toLowerCase();
            const actualText = tag === 'input' || tag === 'textarea'
              ? String(element.value ?? '')
              : element.isContentEditable
                ? String(element.textContent ?? '')
                : null;
            return actualText === ${JSON.stringify(text)};
          })()`,
      );
      if (!typedIntoTarget) {
        throw new Error('Browser text input did not reach the selected element.');
      }
      if (request.submit === true) {
        this.focusGuestForKeyboardInput(guest);
        guest.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
        guest.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });
      }
    }
    if (!preserveSnapshot && (kind === 'click' || request.submit === true)) {
      this.snapshots.delete(tab.webContentsId);
    }
    return { [kind === 'click' ? 'clicked' : 'typed']: target.label };
  }
  if (kind === 'clickCoords') {
    const x = Number(request.x);
    const y = Number(request.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('x and y are required.');
    const clickCount = request.doubleClick === true ? 2 : 1;
    const button =
      request.button === 'right' || request.button === 'middle' ? request.button : 'left';
    const modifiers = normalizeInputModifiers(request.modifiers);
    guest.sendInputEvent({ type: 'mouseDown', x, y, button, clickCount, modifiers });
    try {
      const delayMs = Math.max(0, Math.min(1_000, Number(request.delayMs) || 0));
      if (delayMs > 0) await this.waitWhileActive(delayMs, assertActive);
    } finally {
      if (!guest.isDestroyed()) {
        guest.sendInputEvent({ type: 'mouseUp', x, y, button, clickCount, modifiers });
      }
    }
    if (!preserveSnapshot) this.snapshots.delete(tab.webContentsId);
    return { clicked: { x, y } };
  }
  if (kind === 'press') {
    const key = typeof request.key === 'string' ? request.key.trim() : '';
    if (!key || key.length > 64) throw new Error('key is required.');
    const { keyCode, modifiers } = normalizeKeyChord(key);
    this.focusGuestForKeyboardInput(guest);
    guest.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
    try {
      const delayMs = Math.max(0, Math.min(1_000, Number(request.delayMs) || 0));
      if (delayMs > 0) await this.waitWhileActive(delayMs, assertActive);
    } finally {
      if (!guest.isDestroyed()) guest.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
    }
    if (!preserveSnapshot) this.snapshots.delete(tab.webContentsId);
    return { pressed: key };
  }
  if (kind === 'drag') {
    const start = this.resolveActElement(request, tab, guest, 'startRef', 'startSelector');
    const end = this.resolveActElement(request, tab, guest, 'endRef', 'endSelector');
    if (start.frameSelector !== end.frameSelector) {
      throw new Error('Drag refs must belong to the same frame.');
    }
    const points = await this.executeInTargetWorld<{
      start: { x: number; y: number };
      end: { x: number; y: number };
    } | null>(
      tab,
      guest,
      start.frameSelector,
      `(() => {
          const source = ${start.expression};
          const destination = ${end.expression};
          if (!source?.isConnected || !destination?.isConnected) return null;
          source.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
          destination.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
          const topLevelCenter = element => {
            const rect = element.getBoundingClientRect();
            if (rect.width <= 0 || rect.height <= 0) return null;
            let x = rect.left;
            let y = rect.top;
            let currentDocument = element.ownerDocument;
            while (currentDocument && currentDocument !== document) {
              const frameElement = currentDocument.defaultView?.frameElement;
              if (!(frameElement instanceof Element)) return null;
              const frameRect = frameElement.getBoundingClientRect();
              x += frameRect.left + frameElement.clientLeft;
              y += frameRect.top + frameElement.clientTop;
              currentDocument = frameElement.ownerDocument;
            }
            return { x: x + rect.width / 2, y: y + rect.height / 2 };
          };
          const start = topLevelCenter(source);
          const end = topLevelCenter(destination);
          if (!start || !end) return null;
          return {
            start,
            end,
          };
        })()`,
    );
    if (!points) throw new Error('The element ref is stale. Take a new snapshot.');
    const frameOffset = await this.resolveTargetFrameOffset(tab, guest, start.frameSelector);
    points.start.x += frameOffset.x;
    points.start.y += frameOffset.y;
    points.end.x += frameOffset.x;
    points.end.y += frameOffset.y;
    const guestDebugger = await this.enableDebuggerDomains(tab, guest);
    await guestDebugger.sendCommand('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: points.start.x,
      y: points.start.y,
      button: 'none',
    });
    await guestDebugger.sendCommand('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: points.start.x,
      y: points.start.y,
      button: 'left',
      buttons: 1,
      clickCount: 1,
    });
    let lastPoint = points.start;
    try {
      await this.waitWhileActive(50, assertActive);
      for (let step = 1; step <= 10; step += 1) {
        const progress = step / 10;
        lastPoint = {
          x: points.start.x + (points.end.x - points.start.x) * progress,
          y: points.start.y + (points.end.y - points.start.y) * progress,
        };
        await guestDebugger.sendCommand('Input.dispatchMouseEvent', {
          type: 'mouseMoved',
          x: lastPoint.x,
          y: lastPoint.y,
          button: 'left',
          buttons: 1,
        });
        await this.waitWhileActive(16, assertActive);
      }
    } finally {
      await guestDebugger
        .sendCommand('Input.dispatchMouseEvent', {
          type: 'mouseReleased',
          x: lastPoint.x,
          y: lastPoint.y,
          button: 'left',
          buttons: 0,
          clickCount: 1,
        })
        .catch((): void => undefined);
    }
    if (!preserveSnapshot) this.snapshots.delete(tab.webContentsId);
    return { dragged: { from: start.label, to: end.label } };
  }
  if (kind === 'select') {
    const target = this.resolveActElement(request, tab, guest);
    const values = Array.isArray(request.values) ? request.values.map(String) : [];
    if (!values.length) throw new Error('values required.');
    const selected = await this.executeInTargetWorld<boolean>(
      tab,
      guest,
      target.frameSelector,
      `(() => {
          const element = ${target.expression};
          if (!element?.isConnected || element.tagName?.toLowerCase() !== 'select') return false;
          const values = new Set(${JSON.stringify(values)});
          for (const option of element.options) option.selected = values.has(option.value);
          element.dispatchEvent(new Event('input', { bubbles: true }));
          element.dispatchEvent(new Event('change', { bubbles: true }));
          return true;
        })()`,
    );
    if (!selected) throw new Error('The selected element is not a select control.');
    return { selected: values };
  }
  if (kind === 'fill') {
    const fields = Array.isArray(request.fields) ? request.fields : [];
    if (!fields.length) throw new Error('fields required.');
    const normalized = fields.map(field => {
      const candidate = asRecord(field);
      if (!candidate || typeof candidate.ref !== 'string') throw new Error('Invalid fill field.');
      const current = this.assertCurrentRef(candidate, tab, guest);
      const fieldType =
        typeof candidate.type === 'string' ? candidate.type.trim().toLowerCase() : 'text';
      return {
        index: current.index,
        ref: current.ref,
        aria: current.aria,
        frameSelector: current.worldFrameSelector,
        type: fieldType,
        value: candidate.value ?? '',
      };
    });
    const snapshot = this.snapshots.get(tab.webContentsId);
    const fillFrameSelectors = new Set(normalized.map(field => field.frameSelector));
    if (fillFrameSelectors.size !== 1) throw new Error('Fill refs must belong to the same frame.');
    const filled = await this.executeInTargetWorld<boolean>(
      tab,
      guest,
      normalized[0]!.frameSelector,
      `(() => {
          const state = globalThis.__justdoBrowserAgentState;
          const ariaRegistry = globalThis.__justdoBrowserAgentAriaRegistry;
          const fields = ${JSON.stringify(normalized)};
          for (const field of fields) {
            const element = field.aria
              ? ariaRegistry?.elements?.get(field.ref)
              : state?.snapshotId === ${JSON.stringify(snapshot?.id ?? '')}
                ? state.elements[field.index]
                : null;
            if (!element?.isConnected) return false;
            const tag = String(element.tagName || '').toLowerCase();
            if (field.type === 'checkbox' || field.type === 'radio') {
              if (tag !== 'input') return false;
              element.checked = Boolean(field.value);
              element.dispatchEvent(new Event('input', { bubbles: true }));
              element.dispatchEvent(new Event('change', { bubbles: true }));
              continue;
            }
            if (field.type === 'select') {
              if (tag !== 'select') return false;
              const values = new Set(Array.isArray(field.value) ? field.value.map(String) : [String(field.value)]);
              for (const option of element.options) option.selected = values.has(option.value);
              element.dispatchEvent(new Event('input', { bubbles: true }));
              element.dispatchEvent(new Event('change', { bubbles: true }));
              continue;
            }
            const value = String(field.value ?? '');
            if (tag === 'input') {
              const autocompleteTokens = (element.getAttribute('autocomplete') || '')
                .toLowerCase()
                .split(/\\s+/)
                .filter(Boolean);
              if (
                element.type === 'password' ||
                element.type === 'hidden' ||
                element.type === 'file' ||
                autocompleteTokens.some(token =>
                  ['current-password', 'new-password', 'one-time-code'].includes(token),
                )
              ) return false;
              const Input = element.ownerDocument.defaultView?.HTMLInputElement;
              Object.getOwnPropertyDescriptor(Input?.prototype ?? {}, 'value')?.set?.call(element, value);
            } else if (tag === 'textarea') {
              const Textarea = element.ownerDocument.defaultView?.HTMLTextAreaElement;
              Object.getOwnPropertyDescriptor(Textarea?.prototype ?? {}, 'value')?.set?.call(element, value);
            } else if (element.isContentEditable) element.textContent = value;
            else return false;
            element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
            element.dispatchEvent(new Event('change', { bubbles: true }));
          }
          return true;
        })()`,
    );
    if (!filled) throw new Error('A fill field is stale or not editable.');
    return { filled: normalized.map(field => field.ref) };
  }
  if (kind === 'resize') {
    const width = Number(request.width);
    const height = Number(request.height);
    if (
      !Number.isInteger(width) ||
      !Number.isInteger(height) ||
      width < 1 ||
      height < 1 ||
      width > 8192 ||
      height > 8192
    ) {
      throw new Error('width and height must be integers between 1 and 8192.');
    }
    const guestDebugger = await this.enableDebuggerDomains(tab, guest);
    await guestDebugger.sendCommand('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: false,
    });
    if (!preserveSnapshot) this.snapshots.delete(tab.webContentsId);
    return { resized: { width, height } };
  }
  if (kind === 'wait') {
    const timeoutMs = Math.max(
      1,
      Math.min(LONG_COMMAND_TIMEOUT_MS, Number(request.timeoutMs) || 30_000),
    );
    const timeMs = Math.max(0, Math.min(timeoutMs, Number(request.timeMs) || 0));
    if (timeMs > 0) {
      await this.waitWhileActive(timeMs, assertActive);
    }
    const text = typeof request.text === 'string' ? request.text : '';
    const textGone = typeof request.textGone === 'string' ? request.textGone : '';
    const selector = typeof request.selector === 'string' ? request.selector.trim() : '';
    const url = typeof request.url === 'string' ? request.url.trim() : '';
    const loadState = typeof request.loadState === 'string' ? request.loadState.trim() : '';
    const fn = typeof request.fn === 'string' ? request.fn.trim() : '';
    if (loadState && !['load', 'domcontentloaded', 'networkidle'].includes(loadState)) {
      throw new Error('loadState must be load, domcontentloaded, or networkidle.');
    }
    if (fn.length > 20_000) throw new Error('fn is too long.');
    if (!text && !textGone && !selector && !url && !loadState && !fn) {
      if (timeMs > 0) return { waited: timeMs };
      throw new Error(
        'wait requires at least one of: timeMs, text, textGone, selector, url, loadState, fn.',
      );
    }
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const documentMatched = await this.executeInBrowserWorld<boolean>(
        guest,
        `(() => {
            const text = ${JSON.stringify(text)};
            const textGone = ${JSON.stringify(textGone)};
            const selector = ${JSON.stringify(selector)};
            const url = ${JSON.stringify(url)};
            const loadState = ${JSON.stringify(loadState)};
            if (text && !(document.body?.innerText || '').includes(text)) return false;
            if (textGone && (document.body?.innerText || '').includes(textGone)) return false;
            if (selector) {
              try {
                const element = document.querySelector(selector);
                if (!element || !element.checkVisibility({ visibilityProperty: true })) return false;
              } catch { return false; }
            }
            if (url && !location.href.includes(url)) return false;
            if (loadState === 'load' && document.readyState !== 'complete') return false;
            if (loadState === 'domcontentloaded' && !['interactive', 'complete'].includes(document.readyState)) return false;
            return true;
          })()`,
      );
      const fnMatched = fn
        ? Boolean(
            await this.evaluateWithDebugger(
              tab,
              guest,
              fn,
              Math.max(1, Math.min(1_000, deadline - Date.now())),
              undefined,
              assertActive,
            ),
          )
        : true;
      const networkIdle =
        loadState !== 'networkidle' ||
        ((this.pendingNetworkRequests.get(tab.webContentsId)?.size ?? 0) === 0 &&
          Date.now() - (this.lastNetworkActivity.get(tab.webContentsId) ?? 0) >= 500);
      if (documentMatched && fnMatched && networkIdle)
        return { matched: true, ...(timeMs ? { waited: timeMs } : {}) };
      await this.waitWhileActive(100, assertActive);
    }
    throw new Error('Timed out waiting for the requested page state.');
  }
  if (kind === 'evaluate') {
    const fn = typeof request.fn === 'string' ? request.fn.trim() : '';
    if (!fn || fn.length > 20_000) throw new Error('fn is required.');
    const ref = typeof request.ref === 'string' ? this.assertCurrentRef(request, tab, guest) : null;
    const evaluated = await this.evaluateWithDebugger(
      tab,
      guest,
      fn,
      Math.max(1, Math.min(LONG_COMMAND_TIMEOUT_MS, Number(request.timeoutMs) || 30_000)),
      ref ?? undefined,
      assertActive,
    );
    if (!preserveSnapshot) this.snapshots.delete(tab.webContentsId);
    return { result: boundedJson(evaluated) };
  }
  if (kind === 'close') {
    this.sendToRenderer(BrowserIpc.AgentCloseTab, {
      sessionId,
      targetId: tab.targetId,
    });
    this.discardTabRuntime(tab);
    this.removeRegisteredTab(scopeId, tab.targetId);
    return { closed: true };
  }
  throw new Error(`Unsupported browser act kind: ${kind}`);
}

export async function setFileInputFiles(
  this: BrowserAgentActionsContext,
  command: AgentBrowserCommand,
  tab: RegisteredTab,
  guest: Electron.WebContents,
  files: string[],
  sessionId: string,
  profile: BrowserAgentProfile,
  assertActive: () => void,
): Promise<void> {
  const inputRef = typeof command.inputRef === 'string' ? command.inputRef.trim() : '';
  const ref = typeof command.ref === 'string' ? command.ref.trim() : '';
  const elementSelector = typeof command.element === 'string' ? command.element.trim() : '';
  if (ref && (inputRef || elementSelector)) {
    throw new Error('ref cannot be combined with inputRef/element.');
  }
  if (inputRef && elementSelector) {
    throw new Error('inputRef and element are mutually exclusive.');
  }
  const guestDebugger = await this.enableDebuggerDomains(tab, guest);
  const reference = inputRef || ref;
  if (!reference && !elementSelector) {
    await this.armUpload(tab, guest, files);
    return;
  }
  this.clearArmedUpload(
    tab.webContentsId,
    guest,
    new Error('The pending file chooser was replaced by a direct upload.'),
  );
  const marker = `justdo-upload-${randomBytes(12).toString('hex')}`;
  let referenceExpression = '';
  let referenceWorldFrameSelector = typeof command.frame === 'string' ? command.frame.trim() : '';
  if (reference) {
    const current = this.assertCurrentRef({ ref: reference }, tab, guest);
    referenceExpression = current.expression;
    referenceWorldFrameSelector = current.worldFrameSelector;
    const targetType = await this.executeInTargetWorld<'input' | 'trigger' | null>(
      tab,
      guest,
      referenceWorldFrameSelector,
      `(() => {
          let element = ${current.expression};
          if (!element?.isConnected) return false;
          if (element?.tagName?.toLowerCase() !== 'input' || element.type !== 'file') {
            const associated = element?.closest('label')?.control || element?.closest('form')?.querySelector('input[type="file"]');
            if (associated?.tagName?.toLowerCase() === 'input' && associated.type === 'file') element = associated;
            else return 'trigger';
          }
          if (element?.tagName?.toLowerCase() !== 'input' || element.type !== 'file') return null;
          element.setAttribute('data-justdo-upload-marker', ${JSON.stringify(marker)});
          return 'input';
        })()`,
    );
    if (!targetType) throw new Error('The selected upload element is stale.');
    if (targetType === 'trigger') {
      if (inputRef) throw new Error('inputRef must identify a file input.');
      const armed = await this.armUpload(tab, guest, files);
      try {
        await this.executeAct(
          { kind: 'click', ref: reference },
          tab,
          guest,
          sessionId,
          profile,
          false,
          assertActive,
        );
        await armed.completion;
      } catch (error) {
        this.clearArmedUpload(tab.webContentsId, guest);
        throw error;
      }
      return;
    }
  }
  if (!reference) {
    const marked = await this.executeInTargetWorld<boolean>(
      tab,
      guest,
      referenceWorldFrameSelector,
      `(() => {
          const selector = ${JSON.stringify(elementSelector)};
          const findInOpenRoots = root => {
            const direct = root.querySelector(selector);
            if (direct) return direct;
            for (const candidate of root.querySelectorAll('*')) {
              if (!candidate.shadowRoot) continue;
              const nested = findInOpenRoots(candidate.shadowRoot);
              if (nested) return nested;
            }
            return null;
          };
          const element = findInOpenRoots(document);
          if (!element?.isConnected) return false;
          if (element.tagName?.toLowerCase() !== 'input' || element.type !== 'file') {
            throw new Error('The selected element is not a file input.');
          }
          element.setAttribute('data-justdo-upload-marker', ${JSON.stringify(marker)});
          return true;
        })()`,
    );
    if (!marked) throw new Error('The file input was not found.');
  }
  try {
    const selector = `[data-justdo-upload-marker="${marker}"]`;
    let nodeId: number | undefined;
    const search = (await guestDebugger.sendCommand('DOM.performSearch', {
      query: selector,
      includeUserAgentShadowDOM: true,
    })) as { searchId?: string; resultCount?: number };
    try {
      if (search.searchId && (search.resultCount ?? 0) > 0) {
        const results = (await guestDebugger.sendCommand('DOM.getSearchResults', {
          searchId: search.searchId,
          fromIndex: 0,
          toIndex: 1,
        })) as { nodeIds?: number[] };
        nodeId = results.nodeIds?.[0];
      }
    } finally {
      if (search.searchId) {
        await guestDebugger
          .sendCommand('DOM.discardSearchResults', { searchId: search.searchId })
          .catch((): void => undefined);
      }
    }
    if (!nodeId) throw new Error('The file input was not found.');
    const verifiedFiles = this.resolveUploadPaths(sessionId, files);
    await guestDebugger.sendCommand('DOM.setFileInputFiles', {
      files: verifiedFiles,
      nodeId,
    });
  } finally {
    if (reference) {
      await this.executeInTargetWorld(
        tab,
        guest,
        referenceWorldFrameSelector,
        `(${referenceExpression || 'null'})?.removeAttribute('data-justdo-upload-marker')`,
      ).catch((): void => undefined);
    } else {
      await this.executeInTargetWorld(
        tab,
        guest,
        referenceWorldFrameSelector,
        `(() => {
            const visit = root => {
              const marked = root.querySelector(${JSON.stringify(`[data-justdo-upload-marker="${marker}"]`)});
              if (marked) return marked;
              for (const candidate of root.querySelectorAll('*')) {
                if (!candidate.shadowRoot) continue;
                const nested = visit(candidate.shadowRoot);
                if (nested) return nested;
              }
              return null;
            };
            visit(document)?.removeAttribute('data-justdo-upload-marker');
          })()`,
      ).catch((): void => undefined);
    }
  }
}

export async function executeOnGuest(
  this: BrowserAgentActionsContext,
  command: AgentBrowserCommand,
  tab: RegisteredTab,
  guest: Electron.WebContents,
  assertActive: () => void,
  sessionId: string,
  profile: BrowserAgentProfile,
  signal?: AbortSignal,
): Promise<unknown> {
  assertActive();
  if (command.action === 'navigate') {
    const url = normalizeNavigationUrl(command.targetUrl ?? command.url);
    this.snapshots.delete(tab.webContentsId);
    assertActive();
    await guest.loadURL(url);
    assertActive();
    const pageState = await this.captureSnapshot(command, tab, guest);
    return {
      content: pageState.content,
      details: {
        ok: true,
        targetId: tab.targetId,
        title: guest.getTitle(),
        url: sanitizeUrlForModel(guest.getURL()),
        pageState: pageState.details,
      },
    };
  }
  if (command.action === 'snapshot') {
    return this.captureSnapshot(command, tab, guest);
  }
  if (command.action === 'text') {
    const maxChars = Math.max(0, Math.min(MAX_TOOL_TEXT_CHARS, command.maxChars ?? 20_000));
    const result = await this.executeInBrowserWorld<{ text: string; url: string; title: string }>(
      guest,
      `(() => {
          const selector = ${JSON.stringify(command.selector?.trim() ?? '')};
          let root = null;
          if (selector) {
            try { root = document.querySelector(selector); } catch { throw new Error('Invalid selector.'); }
          }
          root ||= document.querySelector('article') || document.querySelector('main') || document.body;
          return {
            text: (root?.innerText || '').trim().replace(/\\n{3,}/g, '\\n\\n'),
            url: location.href,
            title: document.title,
          };
        })()`,
    );
    const truncated = result.text.length > maxChars;
    const text = result.text.slice(0, maxChars);
    return {
      content: [{ type: 'text', text: wrapBrowserContent(text) }],
      details: {
        ok: true,
        targetId: tab.targetId,
        url: sanitizeUrlForModel(result.url),
        title: result.title,
        chars: text.length,
        truncated,
      },
    };
  }
  if (command.action === 'screenshot') {
    return this.captureScreenshot(command, tab, guest);
  }
  if (
    command.action === 'console' ||
    command.action === 'requests' ||
    command.action === 'errors'
  ) {
    if (command.action !== 'console') await this.enableDebuggerDomains(tab, guest);
    const store =
      command.action === 'console'
        ? this.consoleLogs
        : command.action === 'requests'
          ? this.requestLogs
          : this.errorLogs;
    const filter = command.filter?.trim().toLowerCase() ?? '';
    const level = command.level?.trim().toLowerCase() ?? '';
    const limit = Math.max(1, Math.min(200, command.limit ?? 50));
    const entries = (store.get(tab.webContentsId) ?? [])
      .filter(
        entry =>
          !filter ||
          `${entry.level} ${entry.text} ${entry.url ?? ''}`.toLowerCase().includes(filter),
      )
      .filter(entry => !level || entry.level.toLowerCase() === level)
      .slice(-limit);
    if (command.clear) store.set(tab.webContentsId, []);
    return {
      content: [{ type: 'text', text: wrapBrowserContent(JSON.stringify(entries, null, 2)) }],
      details: {
        ok: true,
        targetId: tab.targetId,
        url: sanitizeUrlForModel(guest.getURL()),
        [`${command.action === 'console' ? 'message' : command.action.slice(0, -1)}Count`]:
          entries.length,
      },
    };
  }
  if (command.action === 'emulate') {
    const applied: string[] = [];
    if (!command.device && !command.colorScheme && !command.timezoneId && !command.locale) {
      throw new Error('At least one emulation setting is required.');
    }
    const resolvedDeviceDescriptor = command.device
      ? (readDeviceDescriptor(command.deviceDescriptor) ?? DEVICE_DESCRIPTORS[command.device])
      : undefined;
    if (command.device && !resolvedDeviceDescriptor) {
      throw new Error(
        `Unsupported device preset: ${command.device}. The bundled OpenClaw device catalog did not contain this name.`,
      );
    }
    if (command.timezoneId) {
      try {
        new Intl.DateTimeFormat('en-US', { timeZone: command.timezoneId }).format();
      } catch {
        throw new Error(`Unsupported timezone: ${command.timezoneId}`);
      }
    }
    if (command.locale) {
      try {
        Intl.getCanonicalLocales(command.locale);
      } catch {
        throw new Error(`Unsupported locale: ${command.locale}`);
      }
    }
    const guestDebugger = await this.enableDebuggerDomains(tab, guest);
    if (command.device) {
      const descriptor = resolvedDeviceDescriptor!;
      const screen = descriptor.screen ?? descriptor.viewport;
      const landscape = descriptor.viewport.width > descriptor.viewport.height;
      if (descriptor.userAgent) {
        await guestDebugger.sendCommand('Emulation.setUserAgentOverride', {
          userAgent: descriptor.userAgent,
        });
      }
      await guestDebugger.sendCommand('Emulation.setDeviceMetricsOverride', {
        mobile: descriptor.isMobile,
        width: descriptor.viewport.width,
        height: descriptor.viewport.height,
        deviceScaleFactor: descriptor.deviceScaleFactor,
        screenWidth: screen.width,
        screenHeight: screen.height,
        screenOrientation: {
          angle: descriptor.isMobile && landscape ? 90 : 0,
          type: descriptor.isMobile && !landscape ? 'portraitPrimary' : 'landscapePrimary',
        },
      });
      await guestDebugger.sendCommand('Emulation.setTouchEmulationEnabled', {
        enabled: descriptor.hasTouch,
      });
      applied.push('device');
    }
    if (command.colorScheme) {
      await guestDebugger.sendCommand('Emulation.setEmulatedMedia', {
        features:
          command.colorScheme === 'none'
            ? []
            : [{ name: 'prefers-color-scheme', value: command.colorScheme }],
      });
      applied.push('colorScheme');
    }
    if (command.timezoneId) {
      await guestDebugger.sendCommand('Emulation.setTimezoneOverride', {
        timezoneId: command.timezoneId,
      });
      applied.push('timezoneId');
    }
    if (command.locale) {
      await guestDebugger.sendCommand('Emulation.setLocaleOverride', { locale: command.locale });
      applied.push('locale');
    }
    this.snapshots.delete(tab.webContentsId);
    return { ok: true, targetId: tab.targetId, applied };
  }
  if (command.action === 'pdf') {
    const outputPath = this.resolveManagedOutputPath(
      sessionId,
      command.path,
      `page-${Date.now()}-${randomBytes(4).toString('hex')}.pdf`,
    );
    const outputReservation = reserveBrowserAgentOutputPath(outputPath);
    try {
      this.assertManagedOutputPath(sessionId, outputReservation.path);
      const pdf = await guest.printToPDF({ printBackground: true });
      this.assertManagedOutputPath(sessionId, outputReservation.path);
      fs.writeFileSync(outputReservation.path, pdf, { flag: 'wx' });
      return {
        content: [{ type: 'text', text: `FILE:${outputReservation.path}` }],
        details: {
          ok: true,
          path: outputReservation.path,
          targetId: tab.targetId,
          url: sanitizeUrlForModel(guest.getURL()),
        },
      };
    } finally {
      outputReservation.release();
    }
  }
  if (command.action === 'download' || command.action === 'waitfordownload') {
    const requestedName = command.path?.trim();
    if (command.action === 'download' && !requestedName) throw new Error('path required.');
    const outputPath = this.resolveManagedOutputPath(
      sessionId,
      requestedName,
      `download-${Date.now()}-${randomBytes(4).toString('hex')}`,
    );
    const result = await armBrowserAgentDownload(
      guest.session,
      guest.id,
      () => {
        this.assertManagedOutputPath(sessionId, outputPath);
        return outputPath;
      },
      Math.max(
        1,
        Math.min(LONG_COMMAND_TIMEOUT_MS, Number(command.timeoutMs) || LONG_COMMAND_TIMEOUT_MS),
      ),
      async () => {
        if (command.action === 'download') {
          const request = { kind: 'click', ref: command.ref };
          await this.executeAct(request, tab, guest, sessionId, profile, false, assertActive);
        }
      },
      signal,
    );
    const download = {
      url: result.sourceUrl,
      suggestedFilename: result.fileName,
      path: result.path,
    };
    return {
      content: [{ type: 'text', text: wrapBrowserContent(JSON.stringify(download, null, 2)) }],
      details: { ok: result.state === 'completed', targetId: tab.targetId, download },
    };
  }
  if (command.action === 'upload') {
    const uploadPaths = this.resolveUploadPaths(sessionId, command.paths);
    await this.setFileInputFiles(
      command,
      tab,
      guest,
      uploadPaths,
      sessionId,
      profile,
      assertActive,
    );
    return {
      ok: true,
      targetId: tab.targetId,
      paths: uploadPaths.map(filePath => path.basename(filePath)),
    };
  }
  if (command.action === 'dialog') {
    if (typeof command.accept !== 'boolean') throw new Error('accept is required.');
    const pending = this.dialogs.get(tab.webContentsId);
    if (!pending) {
      this.clearArmedDialog(tab.webContentsId);
      const timer = setTimeout(
        () => this.clearArmedDialog(tab.webContentsId),
        Math.max(
          500,
          Math.min(
            LONG_COMMAND_TIMEOUT_MS,
            Number(command.timeoutMs) || ARMED_INTERACTION_TIMEOUT_MS,
          ),
        ),
      );
      timer.unref?.();
      this.armedDialogs.set(tab.webContentsId, {
        accept: command.accept === true,
        ...(command.promptText !== undefined ? { promptText: command.promptText } : {}),
        timer,
        leaseOwner: 'current',
      });
      return { ok: true, targetId: tab.targetId, armed: true };
    }
    if (command.dialogId && command.dialogId !== pending.id) {
      throw new Error('The browser dialog is stale.');
    }
    const guestDebugger = await this.enableDebuggerDomains(tab, guest);
    await guestDebugger.sendCommand('Page.handleJavaScriptDialog', {
      accept: command.accept === true,
      ...(command.accept === true && pending.type === 'prompt' && command.promptText !== undefined
        ? { promptText: command.promptText }
        : {}),
    });
    this.dialogs.delete(tab.webContentsId);
    return { ok: true, targetId: tab.targetId, dialogId: pending.id };
  }
  if (command.action === 'act') {
    const request = this.readActRequest(command);
    const beforeUrl = guest.getURL();
    const beforeGeneration = this.navigationGenerations.get(guest.id) ?? 0;
    const requestsBeforeAct = new Set(this.pendingNetworkRequests.get(tab.webContentsId) ?? []);
    const downloadCaptures = Array.from({ length: MAX_ACT_DOWNLOADS }, () =>
      beginBrowserAgentDownload(
        guest.session,
        guest.id,
        item =>
          this.resolveManagedOutputPath(
            sessionId,
            undefined,
            `download-${Date.now()}-${randomBytes(4).toString('hex')}-${path.basename(item.getFilename()) || 'download.bin'}`,
          ),
        LONG_COMMAND_TIMEOUT_MS + 1_000,
        signal,
      ),
    );
    let details: Record<string, unknown>;
    try {
      details = await this.executeAct(request, tab, guest, sessionId, profile, false, assertActive);
    } catch (error) {
      for (const capture of downloadCaptures) {
        capture.fail(error instanceof Error ? error : new Error(String(error)));
      }
      throw error;
    }
    assertActive();
    const closedByAct = details.closed === true || asRecord(details.aborted)?.reason === 'closed';
    if (!closedByAct && !guest.isDestroyed()) {
      const observedRequestIds = new Set<string>();
      const drainDeadline = Date.now() + ACT_DOWNLOAD_MAX_DRAIN_MS;
      let settleAfter = Date.now() + ACT_DOWNLOAD_EVENT_GRACE_MS;
      while (Date.now() < Math.min(settleAfter, drainDeadline)) {
        assertActive();
        if (guest.isDestroyed() || this.dialogs.has(tab.webContentsId)) break;
        const currentRequests = this.pendingNetworkRequests.get(tab.webContentsId) ?? new Set();
        for (const requestId of currentRequests) {
          if (!requestsBeforeAct.has(requestId)) observedRequestIds.add(requestId);
        }
        const hasOutstandingActRequest = [...observedRequestIds].some(requestId =>
          currentRequests.has(requestId),
        );
        if (hasOutstandingActRequest) {
          settleAfter = Math.min(drainDeadline, Date.now() + ACT_DOWNLOAD_EVENT_GRACE_MS);
        }
        await this.waitWhileActive(25, assertActive);
      }
    }
    downloadCaptures.forEach(capture => capture.finishIfUnclaimed());
    const capturedDownloads = (await Promise.all(downloadCaptures.map(capture => capture.result)))
      .filter(result => result !== null)
      .map(result => ({
        url: result.sourceUrl,
        suggestedFilename: result.fileName,
        path: result.path,
      }));
    const downloads = capturedDownloads.length ? capturedDownloads : undefined;
    const dialogResult = this.blockedDialogResult(tab.webContentsId);
    if (dialogResult) {
      return {
        content: [
          { type: 'text', text: wrapBrowserContent(JSON.stringify(dialogResult, null, 2)) },
        ],
        details: {
          ok: true,
          targetId: tab.targetId,
          ...dialogResult,
          ...(downloads ? { downloads } : {}),
        },
      };
    }
    if (closedByAct) {
      return {
        content: [{ type: 'text', text: wrapBrowserContent(JSON.stringify(details, null, 2)) }],
        details: {
          ok: true,
          targetId: tab.targetId,
          ...details,
          ...(downloads ? { downloads } : {}),
        },
      };
    }
    const kind = typeof request.kind === 'string' ? request.kind : '';
    const navigation = new Set(['click', 'clickCoords', 'type', 'press', 'batch']).has(kind)
      ? await this.waitForPossibleNavigation(guest, beforeGeneration, beforeUrl, assertActive)
      : null;
    const navigated =
      navigation === 'navigation' || asRecord(details.aborted)?.reason === 'navigation';
    if (navigated && !guest.isDestroyed()) {
      const pageState = await this.captureSnapshot(command, tab, guest);
      return {
        content: [
          {
            type: 'text',
            text: wrapBrowserContent(JSON.stringify(details, null, 2)),
          },
          ...pageState.content,
        ],
        details: {
          ok: true,
          targetId: tab.targetId,
          url: sanitizeUrlForModel(guest.getURL()),
          ...details,
          ...(downloads ? { downloads } : {}),
          pageState: pageState.details,
        },
      };
    }
    return {
      content: [{ type: 'text', text: wrapBrowserContent(JSON.stringify(details, null, 2)) }],
      details: {
        ok: true,
        targetId: tab.targetId,
        url: sanitizeUrlForModel(guest.getURL()),
        ...details,
        ...(downloads ? { downloads } : {}),
      },
    };
  }
  throw new Error(`Unsupported browser action: ${command.action}`);
}

export async function waitWhileActive(
  this: BrowserAgentActionsContext,
  milliseconds: number,
  assertActive: () => void,
): Promise<void> {
  const deadline = Date.now() + Math.max(0, milliseconds);
  while (Date.now() < deadline) {
    assertActive();
    await new Promise(resolve => setTimeout(resolve, Math.min(25, deadline - Date.now())));
  }
  assertActive();
}

export async function waitForPossibleNavigation(
  this: BrowserAgentActionsContext,
  guest: Electron.WebContents,
  beforeGeneration: number,
  beforeUrl = guest.getURL(),
  assertActive: () => void = () => undefined,
): Promise<'navigation' | 'closed' | 'dialog' | null> {
  for (let attempt = 0; attempt < 24; attempt += 1) {
    assertActive();
    if (guest.isDestroyed()) return 'closed';
    if (this.dialogs.has(guest.id)) return 'dialog';
    const navigationStarted =
      (this.navigationGenerations.get(guest.id) ?? 0) !== beforeGeneration ||
      guest.getURL() !== beforeUrl;
    if (navigationStarted) {
      for (let settleAttempt = 0; settleAttempt < 1_200; settleAttempt += 1) {
        assertActive();
        if (guest.isDestroyed()) return 'closed';
        if (this.dialogs.has(guest.id)) return 'dialog';
        if (typeof guest.isLoadingMainFrame !== 'function' || !guest.isLoadingMainFrame()) break;
        await this.waitWhileActive(25, assertActive);
      }
      return 'navigation';
    }
    await this.waitWhileActive(25, assertActive);
  }
  return null;
}
