// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { type BrowserPanelFocusBinding, retainBrowserPanelFocus } from './browserPanelFocus';

const bindings: BrowserPanelFocusBinding[] = [];
const field = (doc = document) => {
  const input = doc.createElement('input');
  input.value = 'Keep the user draft';
  doc.body.append(input);
  Object.defineProperty(input, 'getClientRects', { value: () => [new DOMRect(0, 0, 120, 24)] });
  return input;
};
const guest = (doc = document, tag = 'webview') => {
  const element = doc.createElement(tag);
  element.tabIndex = -1;
  doc.body.append(element);
  Object.defineProperty(element, 'getClientRects', { value: () => [new DOMRect(0, 0, 400, 300)] });
  return element;
};
const workspace = () => {
  const frame = document.createElement('iframe');
  document.body.append(frame);
  return frame.contentDocument!;
};
const retain = (owner = document) => {
  const binding = retainBrowserPanelFocus(document, owner);
  bindings.push(binding);
  return binding;
};

beforeEach(() => document.body.replaceChildren());
afterEach(() => {
  bindings.splice(0).forEach(binding => binding.release());
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

test('synchronously preserves the user draft and caret when an inactive guest receives native focus', () => {
  const input = field();
  input.focus();
  input.setSelectionRange(4, 8);
  const binding = retain();
  const background = guest();
  binding.registerGuest(background, () => false);
  const restore = vi.spyOn(input, 'focus');

  background.focus();

  expect(document.activeElement).toBe(input);
  expect(input.selectionStart).toBe(4);
  expect(input.selectionEnd).toBe(8);
  expect(input.value).toBe('Keep the user draft');
  expect(restore).toHaveBeenCalledWith({ preventScroll: true });
});

test('permits the selected guest and prevents a sibling from replacing its focus', () => {
  const binding = retain();
  const selected = guest();
  const background = guest();
  let allowed = true;
  binding.registerGuest(selected, () => allowed);
  binding.registerGuest(background, () => false);
  selected.focus();
  expect(document.activeElement).toBe(selected);

  background.focus();
  expect(document.activeElement).toBe(selected);

  const input = field();
  input.focus();
  allowed = false;
  selected.focus();
  expect(document.activeElement).toBe(input);
});

test('withdraws existing guest focus when Agent control starts without another focus event', () => {
  const binding = retain();
  const current = guest();
  let busy = false;
  binding.registerGuest(current, () => !busy);
  current.focus();
  expect(document.activeElement).toBe(current);

  busy = true;
  binding.refresh();

  expect(document.activeElement).not.toBe(current);
  busy = false;
  current.focus();
  expect(document.activeElement).toBe(current);
});

test('withdraws an already focused guest shadow control before Agent control', () => {
  const binding = retain();
  // jsdom lacks Electron's webview and navigable iframe focus chain. A shadow
  // input exercises the same ownership traversal; the real iframe is covered
  // by tests/browser-background-electron/sidebar-tabs.cjs.
  const current = guest(document, 'section');
  const shadow = current.attachShadow({ mode: 'open' });
  const internalControl = document.createElement('input');
  shadow.append(internalControl);
  let busy = false;
  binding.registerGuest(current, () => !busy);
  internalControl.focus();
  expect(document.activeElement).toBe(current);
  expect(shadow.activeElement).toBe(internalControl);
  const blur = vi.spyOn(internalControl, 'blur');

  busy = true;
  binding.refresh();

  expect(blur).toHaveBeenCalled();
  expect(shadow.activeElement).not.toBe(internalControl);
  expect(document.activeElement).not.toBe(current);
});

test('resolves shadow focus events to the registered background guest', () => {
  const binding = retain();
  const input = field();
  input.focus();
  const background = guest(document, 'section');
  const internalControl = document.createElement('input');
  background.attachShadow({ mode: 'open' }).append(internalControl);
  binding.registerGuest(background, () => false);

  internalControl.focus();
  // Electron also delivers a direct, non-bubbling webview focus event.
  background.dispatchEvent(new FocusEvent('focus'));

  expect(document.activeElement).toBe(input);
  expect(background.shadowRoot!.activeElement).not.toBe(internalControl);
});

test('withdraws a hidden source guest without disturbing a peer document current focus', () => {
  const owner = workspace();
  const binding = retain(owner);
  const current = guest(owner);
  let visible = true;
  binding.registerGuest(current, () => visible);
  current.focus();
  expect(owner.activeElement).toBe(current);
  visible = false;
  binding.refresh();
  expect(owner.activeElement).not.toBe(current);
  const composer = field();
  composer.focus();
  const restore = vi.spyOn(composer, 'focus');

  binding.refresh();

  expect(owner.activeElement).not.toBe(current);
  expect(document.activeElement).toBe(composer);
  expect(restore).not.toHaveBeenCalled();
});

test('uses one current bookmark across retained panels and their workspace documents', () => {
  const firstDocument = workspace();
  const secondDocument = workspace();
  const first = retain(firstDocument);
  const second = retain(secondDocument);
  const sourceInput = field(firstDocument);
  sourceInput.focus();
  const composer = field();
  composer.focus();
  const background = guest(secondDocument);
  second.registerGuest(background, () => false);

  background.focus();
  expect(document.activeElement).toBe(composer);

  sourceInput.focus();
  background.focus();
  expect(firstDocument.activeElement).toBe(sourceInput);
  expect(document.activeElement).toBe(firstDocument.defaultView!.frameElement);
  first.release();
});

test.each(['removed', 'opacity', 'inert', 'aria-hidden'] as const)(
  'does not restore a stale %s bookmark after source cleanup',
  hiddenBy => {
    const binding = retain();
    const input = field();
    input.focus();
    const background = guest();
    binding.registerGuest(background, () => false);
    const restore = vi.spyOn(input, 'focus');
    if (hiddenBy === 'removed') input.remove();
    else if (hiddenBy === 'opacity') input.style.opacity = '0';
    else input.setAttribute(hiddenBy, 'true');

    background.focus();

    expect(restore).not.toHaveBeenCalled();
    expect(document.activeElement).not.toBe(background);
  },
);

test('recognizes source hiding through shadow ancestors', () => {
  const binding = retain();
  const container = document.createElement('section');
  document.body.append(container);
  const shadow = container.attachShadow({ mode: 'open' });
  const input = field();
  shadow.append(input);
  input.focus();
  const restore = vi.spyOn(input, 'focus');
  container.style.display = 'none';
  const background = guest();
  binding.registerGuest(background, () => false);

  background.focus();
  expect(restore).not.toHaveBeenCalled();
});

test('withdraws exact guest and document listeners on release without affecting a peer binding', () => {
  const owner = workspace();
  const first = retain(owner);
  const second = retain(owner);
  const input = field();
  input.focus();
  const retired = guest(owner);
  const live = guest(owner);
  first.registerGuest(retired, () => false);
  second.registerGuest(live, () => false);
  first.unregisterGuest(retired);
  retired.focus();
  expect(owner.activeElement).toBe(retired);
  input.focus();
  first.release();
  first.release();
  live.focus();
  expect(document.activeElement).toBe(input);
  second.release();
  live.focus();
  expect(owner.activeElement).toBe(live);
});
