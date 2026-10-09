import { ipcRenderer } from 'electron';

import {
  BROWSER_GUEST_COMMAND_CHANNEL,
  BROWSER_GUEST_CREDENTIALS_FILL_CHANNEL,
  BROWSER_GUEST_CREDENTIALS_GET_CHANNEL,
  BROWSER_GUEST_CREDENTIALS_OFFER_CHANNEL,
  BROWSER_GUEST_ZOOM_CHANNEL,
  type BrowserImportedCredential,
  isBrowserGuestCommand,
  resolveBrowserGuestWheelZoomDirection,
} from '../shared/browser/browser';
import { installBrowserRecordingGuest } from './browser/recording/browserRecordingGuest';

installBrowserRecordingGuest();

type InspectionPoint = { x: number; y: number };
const MAX_SIBLINGS_SCANNED = 512;
const MAX_TEXT_NODES_SCANNED = 64;
const MAX_ELEMENT_NAME_LENGTH = 120;
const bounded = (value: string | null | undefined, maxLength: number): string =>
  (value ?? '').slice(0, maxLength);

const boundedElementText = (element: Element): string => {
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  let content = '';
  let visited = 0;
  while (visited < MAX_TEXT_NODES_SCANNED && content.length < MAX_ELEMENT_NAME_LENGTH * 2) {
    const node = walker.nextNode();
    if (!node) break;
    visited += 1;
    content += ` ${node.nodeValue?.slice(0, MAX_ELEMENT_NAME_LENGTH) ?? ''}`;
  }
  return content.replace(/\s+/g, ' ').trim().slice(0, MAX_ELEMENT_NAME_LENGTH);
};

ipcRenderer.on(BROWSER_GUEST_COMMAND_CHANNEL, (_event, command: unknown) => {
  if (!isBrowserGuestCommand(command)) return;
  ipcRenderer.sendToHost(BROWSER_GUEST_COMMAND_CHANNEL, command);
});

window.addEventListener(
  'wheel',
  event => {
    const direction = resolveBrowserGuestWheelZoomDirection(event);
    if (!direction) return;
    event.preventDefault();
    event.stopPropagation();
    ipcRenderer.sendToHost(BROWSER_GUEST_ZOOM_CHANNEL, direction);
  },
  { capture: true, passive: false },
);

const describeAtPoints = (points: InspectionPoint[]): unknown[] => {
  const seen = new Set<string>();
  const pathFor = (element: Element): string => {
    const parts: string[] = [];
    let node: Element | null = element;
    while (node && parts.length < 6) {
      let part = node.tagName.toLowerCase();
      const nodeId = bounded(node.id, 120);
      if (nodeId) {
        part += `#${CSS.escape(nodeId)}`;
        parts.unshift(part);
        break;
      }
      const parent: Element | null = node.parentElement;
      if (parent) {
        let matchingIndex = 0;
        let scanned = 0;
        for (const child of parent.children) {
          scanned += 1;
          if (scanned > MAX_SIBLINGS_SCANNED) break;
          if (child.tagName === node.tagName) matchingIndex += 1;
          if (child === node) {
            part += `:nth-of-type(${matchingIndex})`;
            break;
          }
        }
      }
      parts.unshift(part);
      node = parent;
    }
    return parts.join(' > ').slice(0, 800);
  };
  const result: unknown[] = [];
  for (const point of points) {
    for (const element of document.elementsFromPoint(point.x, point.y)) {
      const cssPath = pathFor(element);
      if (!cssPath || seen.has(cssPath)) continue;
      seen.add(cssPath);
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      const label =
        bounded(element.getAttribute('aria-label'), MAX_ELEMENT_NAME_LENGTH) ||
        bounded(element.getAttribute('alt'), MAX_ELEMENT_NAME_LENGTH) ||
        bounded(element.getAttribute('title'), MAX_ELEMENT_NAME_LENGTH) ||
        '';
      const content = boundedElementText(element);
      result.push({
        tag: element.tagName.toLowerCase(),
        id: bounded(element.id, 120),
        classes: Array.from({ length: Math.min(element.classList.length, 6) }, (_, index) =>
          bounded(element.classList.item(index), 80),
        ).filter((value): value is string => value !== null),
        role: bounded(element.getAttribute('role'), 60),
        name: (label || content).slice(0, MAX_ELEMENT_NAME_LENGTH),
        rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        focusable: (element as HTMLElement).tabIndex >= 0,
        cssPath,
        computedStyle: {
          color: bounded(style.color, 160),
          backgroundColor: bounded(style.backgroundColor, 160),
          opacity: bounded(style.opacity, 32),
          fontFamily: bounded(style.fontFamily, 240),
          fontSize: bounded(style.fontSize, 64),
          fontWeight: bounded(style.fontWeight, 64),
          lineHeight: bounded(style.lineHeight, 64),
          display: bounded(style.display, 64),
          position: bounded(style.position, 64),
          zIndex: bounded(style.zIndex, 64),
          borderRadius: bounded(style.borderRadius, 160),
        },
      });
      if (result.length >= 12) return result;
    }
  }
  return result;
};

ipcRenderer.on('justdo-browser-inspect', (_event, requestId: unknown, rawPoints: unknown) => {
  if (typeof requestId !== 'string' || !Array.isArray(rawPoints)) return;
  const points = rawPoints.slice(0, 12).flatMap(value => {
    if (!value || typeof value !== 'object') return [];
    const point = value as Record<string, unknown>;
    if (
      typeof point.x !== 'number' ||
      !Number.isFinite(point.x) ||
      typeof point.y !== 'number' ||
      !Number.isFinite(point.y)
    )
      return [];
    return [{ x: Math.max(0, point.x), y: Math.max(0, point.y) }];
  });
  ipcRenderer.sendToHost('justdo-browser-inspect-result', requestId, describeAtPoints(points));
});

let invalidationTimer: ReturnType<typeof setTimeout> | null = null;
const reportViewportChange = (): void => {
  if (invalidationTimer) clearTimeout(invalidationTimer);
  invalidationTimer = setTimeout(() => {
    invalidationTimer = null;
    ipcRenderer.sendToHost('justdo-browser-viewport-changed');
  }, 80);
};
window.addEventListener('scroll', reportViewportChange, true);
window.addEventListener('resize', reportViewportChange);

const setNativeInputValue = (input: HTMLInputElement, value: string): void => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
};

const requestedPasswordInputs = new WeakSet<HTMLInputElement>();
let pendingPasswordInput: HTMLInputElement | null = null;
const tryAutofillImportedCredential = async (passwordInput: HTMLInputElement): Promise<void> => {
  if (requestedPasswordInputs.has(passwordInput) || !/^https?:$/.test(location.protocol)) return;
  if (!passwordInput || passwordInput.value) return;
  requestedPasswordInputs.add(passwordInput);
  try {
    const credentials = (await ipcRenderer.invoke(
      BROWSER_GUEST_CREDENTIALS_GET_CHANNEL,
    )) as BrowserImportedCredential[];
    // Multiple accounts require a picker; never guess which credential the user wants.
    if (credentials.length !== 1) return;
    const credential = credentials[0]!;
    const usernameInput = passwordInput.form?.querySelector<HTMLInputElement>(
      'input[autocomplete="username"], input[type="email"], input[type="text"]',
    );
    if (usernameInput && !usernameInput.value)
      setNativeInputValue(usernameInput, credential.username);
    setNativeInputValue(passwordInput, credential.password);
  } catch {
    // Autofill is best-effort and never blocks page interaction.
  }
};

ipcRenderer.on(BROWSER_GUEST_CREDENTIALS_FILL_CHANNEL, () => {
  const passwordInput = pendingPasswordInput;
  pendingPasswordInput = null;
  if (!passwordInput?.isConnected || passwordInput.disabled || passwordInput.readOnly) return;
  void tryAutofillImportedCredential(passwordInput);
});

// A page click may only request that the host shows its own trusted confirmation UI. The
// credential is not requested from Main until the user confirms outside the guest contents.
document.addEventListener(
  'pointerdown',
  event => {
    if (!event.isTrusted || event.button !== 0) return;
    const target = event.target;
    if (
      target instanceof HTMLInputElement &&
      target.type === 'password' &&
      !target.disabled &&
      !target.readOnly
    ) {
      pendingPasswordInput = target;
      ipcRenderer.sendToHost(BROWSER_GUEST_CREDENTIALS_OFFER_CHANNEL);
    }
  },
  true,
);
