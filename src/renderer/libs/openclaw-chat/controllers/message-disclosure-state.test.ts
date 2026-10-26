/** @vitest-environment jsdom */
import { afterEach, expect, test, vi } from 'vitest';

import { MessageDisclosureState } from './message-disclosure-state';

const disclosure = (open = false) =>
  `<details class="markdown-disclosure"${open ? ' open' : ''}><summary tabindex="0">Details</summary><p>Extra information</p></details>`;
const body = (owner: string, content: string) =>
  `<div data-message-disclosure-owner="${owner}">${content}</div>`;

function setup(content: string) {
  const state = new MessageDisclosureState();
  state.reset('physical-session:history-1');
  const root = document.createElement('div');
  root.innerHTML = content;
  document.body.append(root);
  return { state, root };
}

afterEach(() => {
  document.getSelection()?.removeAllRanges();
  document.body.replaceChildren();
});

test('keeps initial defaults and user open or closed choices across replacement', () => {
  const markup = body('message-a', disclosure(true)) + body('message-b', disclosure());
  const { state, root } = setup(markup);
  state.restore(root);
  const initial = root.querySelectorAll('details');
  expect([...initial].map(details => details.open)).toEqual([true, false]);

  initial[0]!.open = false;
  initial[1]!.open = true;
  state.capture(root);
  root.innerHTML = markup;
  state.restore(root);
  expect([...root.querySelectorAll('details')].map(details => details.open)).toEqual([false, true]);

  // Capturing a programmatic restore must preserve the same choices.
  state.capture(root);
  root.innerHTML = markup;
  state.restore(root);
  expect([...root.querySelectorAll('details')].map(details => details.open)).toEqual([false, true]);
});

test('restores independent parent, child and sibling choices by tree path', () => {
  const markup = body(
    'message',
    `<details class="markdown-disclosure"><summary>Parent</summary>${disclosure()}${disclosure(true)}</details>${disclosure()}`,
  );
  const { state, root } = setup(markup);
  const initial = root.querySelectorAll('details');
  initial[0]!.open = true;
  initial[1]!.open = true;
  initial[2]!.open = false;
  initial[3]!.open = true;
  state.capture(root);
  root.innerHTML = markup;
  state.restore(root);
  expect([...root.querySelectorAll('details')].map(details => details.open)).toEqual([
    true,
    true,
    false,
    true,
  ]);
});

test('separates identical text by exact body owner and preserves choices after paging away', () => {
  const markup = body('message-a:body-0', disclosure()) + body('message-a:body-1', disclosure());
  const { state, root } = setup(markup);
  root.querySelector('details')!.open = true;
  state.capture(root);
  root.replaceChildren();
  state.capture(root);
  root.innerHTML = markup;
  state.restore(root);
  expect([...root.querySelectorAll('details')].map(details => details.open)).toEqual([true, false]);
});

test('keeps programmatic search expansion in later renders', () => {
  const markup = body('message', disclosure());
  const { state, root } = setup(markup);
  state.capture(root);
  // Search exposes a hit by opening its disclosure ancestors.
  root.querySelector('details')!.open = true;
  state.capture(root);
  root.innerHTML = markup;
  state.restore(root);
  expect(root.querySelector('details')!.open).toBe(true);
});

test('clears choices and focus on history identity replacement or unmount', () => {
  const markup = body('message', disclosure());
  const { state, root } = setup(markup);
  root.querySelector('details')!.open = true;
  root.querySelector('summary')!.focus();
  state.capture(root);
  state.reset('physical-session:history-2');
  root.innerHTML = markup;
  state.restore(root);
  expect(root.querySelector('details')!.open).toBe(false);
  expect(document.activeElement).not.toBe(root.querySelector('summary'));

  root.querySelector('details')!.open = true;
  state.capture(root);
  state.clear();
  root.innerHTML = markup;
  state.restore(root);
  expect(root.querySelector('details')!.open).toBe(false);

  state.reset(null);
  root.querySelector('details')!.open = true;
  state.capture(root);
  state.reset('physical-session:history-2');
  root.innerHTML = markup;
  state.restore(root);
  expect(root.querySelector('details')!.open).toBe(false);
});

test('restores only the previously focused summary once without scrolling', () => {
  const markup = body('message', disclosure());
  const { state, root } = setup(markup);
  root.querySelector('summary')!.focus();
  state.capture(root);
  root.innerHTML = markup;
  const summary = root.querySelector('summary')!;
  const focus = vi.spyOn(summary, 'focus');
  state.restore(root);
  expect(focus).toHaveBeenCalledWith({ preventScroll: true });
  expect(document.activeElement).toBe(summary);

  const input = document.createElement('input');
  document.body.append(input);
  input.focus();
  state.restore(root);
  expect(focus).toHaveBeenCalledTimes(1);
  expect(document.activeElement).toBe(input);
});

test('does not restore summary focus while the user has a text selection', () => {
  const markup = body('message', disclosure(true));
  const { state, root } = setup(markup);
  root.querySelector('summary')!.focus();
  const range = document.createRange();
  range.selectNodeContents(root.querySelector('p')!);
  document.getSelection()!.removeAllRanges();
  document.getSelection()!.addRange(range);
  expect(document.getSelection()!.isCollapsed).toBe(false);
  state.capture(root);
  root.innerHTML = markup;
  const focus = vi.spyOn(root.querySelector('summary')!, 'focus');
  state.restore(root);
  expect(focus).not.toHaveBeenCalled();
});

test('never transfers focus to another body or from a separate control', () => {
  const { state, root } = setup(body('message-a', disclosure()));
  root.querySelector('summary')!.focus();
  state.capture(root);
  root.innerHTML = body('message-b', disclosure());
  const focus = vi.spyOn(root.querySelector('summary')!, 'focus');
  state.restore(root);
  expect(focus).not.toHaveBeenCalled();

  const input = document.createElement('input');
  document.body.append(input);
  input.focus();
  state.capture(root);
  root.innerHTML = body('message-b', disclosure());
  state.restore(root);
  expect(document.activeElement).toBe(input);
});

test('uses a shadow root focus scope and works across document realms', () => {
  const state = new MessageDisclosureState();
  state.reset('physical-session:history-1');
  const host = document.createElement('div');
  document.body.append(host);
  const root = host.attachShadow({ mode: 'open' });
  const markup = body('message', disclosure());
  root.innerHTML = markup;
  root.querySelector('details')!.open = true;
  root.querySelector('summary')!.focus();
  state.capture(root);
  root.innerHTML = markup;
  state.restore(root);
  expect(root.querySelector('details')!.open).toBe(true);
  expect(root.activeElement).toBe(root.querySelector('summary'));

  const iframe = document.createElement('iframe');
  document.body.append(iframe);
  const otherRoot = iframe.contentDocument!.createElement('div');
  iframe.contentDocument!.body.append(otherRoot);
  otherRoot.innerHTML = markup;
  state.capture(root);
  const focus = vi.spyOn(otherRoot.querySelector('summary')!, 'focus');
  state.restore(otherRoot);
  expect(otherRoot.querySelector('details')!.open).toBe(true);
  expect(focus).not.toHaveBeenCalled();
});

test('ignores unowned and other feature disclosures', () => {
  const markup =
    disclosure() + body('message', '<details><summary>Process</summary></details>') +
    body('', disclosure());
  const { state, root } = setup(markup);
  root.querySelectorAll('details').forEach(details => { details.open = true; });
  state.capture(root);
  root.innerHTML = markup;
  state.restore(root);
  expect([...root.querySelectorAll('details')].map(details => details.open)).toEqual([
    false,
    false,
    false,
  ]);
});

test('bounds retained choices and keeps the most recently captured entries', () => {
  const state = new MessageDisclosureState(2);
  state.reset('physical-session:history-1');
  const root = document.createElement('div');
  const markup = ['a', 'b', 'c'].map(owner => body(owner, disclosure())).join('');
  root.innerHTML = markup;
  root.querySelectorAll('details').forEach(details => { details.open = true; });
  state.capture(root);
  root.innerHTML = markup;
  state.restore(root);
  expect([...root.querySelectorAll('details')].map(details => details.open)).toEqual([
    false,
    true,
    true,
  ]);
});
