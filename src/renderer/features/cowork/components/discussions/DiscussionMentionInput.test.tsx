// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, expect, it, vi } from 'vitest';

import { OwnerDocumentContext } from '@/shared/dom/ownerDocument';

import DiscussionMentionInput from './DiscussionMentionInput';

vi.mock('@/services/i18n', () => ({ i18nService: { t: (key: string) => key } }));
afterEach(() => {
  cleanup();
  document.querySelectorAll('iframe').forEach(frame => frame.remove());
});
function Draft() {
  const [value, setValue] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  return (
    <DiscussionMentionInput
      value={value}
      onChange={setValue}
      selected={selected}
      onSelected={setSelected}
      disabled={false}
      recipientsDisabled={false}
      className=""
      members={[
        { agentId: 'alice', name: '设计助手' },
        { agentId: 'bob', name: 'Bob' },
        { agentId: 'deleted', name: 'Deleted', deleted: true },
      ]}
    />
  );
}

it('shows no roster until typing @ and binds a filtered assistant without inserting an ambiguous name', () => {
  render(<Draft />);
  const input = screen.getByRole('textbox');
  expect(screen.queryByRole('listbox')).toBeNull();
  expect(screen.queryByRole('button')).toBeNull();
  fireEvent.change(input, { target: { value: 'Please ask @bo' } });
  expect(screen.getAllByRole('option')).toHaveLength(1);
  fireEvent.click(screen.getByRole('option', { name: /Bob/ }));
  expect(input).toHaveProperty('value', 'Please ask ');
  expect(screen.queryByRole('listbox')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'teamMentionRemove Bob' }));
  expect(screen.queryByRole('button')).toBeNull();
});

it('reveals keyboard suggestions and restores the caret using the detached host', () => {
  const frame = document.createElement('iframe');
  document.body.append(frame);
  const ownerDocument = frame.contentDocument!;
  const ownerWindow = frame.contentWindow! as Window & typeof globalThis;
  const container = ownerDocument.createElement('div');
  ownerDocument.body.append(container);
  const scroll = vi.fn();
  Object.defineProperty(ownerWindow.Element.prototype, 'scrollIntoView', {
    configurable: true,
    value: scroll,
  });
  let focusFrame!: FrameRequestCallback;
  const raf = vi.fn((callback: FrameRequestCallback) => {
    focusFrame = callback;
    return 1;
  });
  Object.defineProperty(ownerWindow, 'requestAnimationFrame', { configurable: true, value: raf });
  render(
    <OwnerDocumentContext.Provider value={ownerDocument}>
      <Draft />
    </OwnerDocumentContext.Provider>,
    { container },
  );
  const host = within(ownerDocument.body);
  const input = host.getByRole('textbox') as HTMLTextAreaElement;
  fireEvent.change(input, { target: { value: '@' } });
  scroll.mockClear();
  fireEvent.keyDown(input, { key: 'ArrowDown' });
  const bob = host.getByRole('option', { name: /Bob/ });
  expect(scroll).toHaveBeenCalledOnce();
  expect(scroll.mock.instances[0]).toBe(bob);
  fireEvent.keyDown(input, { key: 'Enter' });
  expect(raf).toHaveBeenCalledOnce();
  act(() => focusFrame(0));
  expect(ownerDocument.activeElement).toBe(input);
  expect(input.selectionStart).toBe(0);
  expect(host.getByRole('button', { name: 'teamMentionRemove Bob' })).toBeTruthy();
});

it('supports keyboard selection and Escape, excludes deleted members and already selected recipients', () => {
  render(<Draft />);
  const input = screen.getByRole('textbox');
  fireEvent.change(input, { target: { value: '@' } });
  expect(screen.getAllByRole('option')).toHaveLength(2);
  fireEvent.keyDown(input, { key: 'ArrowDown' });
  fireEvent.keyDown(input, { key: 'Enter' });
  expect(screen.getByRole('button', { name: 'teamMentionRemove Bob' })).toBeTruthy();
  fireEvent.change(input, { target: { value: '@' } });
  expect(screen.getAllByRole('option')).toHaveLength(1);
  fireEvent.keyDown(input, { key: 'Escape' });
  expect(screen.queryByRole('listbox')).toBeNull();
});

it('does not treat emails as mentions or select a candidate during IME composition', () => {
  render(<Draft />);
  const input = screen.getByRole('textbox');
  fireEvent.change(input, { target: { value: 'me@example.com' } });
  expect(screen.queryByRole('listbox')).toBeNull();
  fireEvent.change(input, { target: { value: '@设计' } });
  fireEvent.keyDown(input, { key: 'Enter', keyCode: 229, isComposing: true });
  expect(input).toHaveProperty('value', '@设计');
  fireEvent.keyDown(input, { key: 'Tab' });
  expect(screen.getByRole('button', { name: 'teamMentionRemove 设计助手' })).toBeTruthy();
});

it('supports an @ after Chinese text and preserves text after the caret', () => {
  render(<Draft />);
  const input = screen.getByRole('textbox') as HTMLTextAreaElement;
  fireEvent.change(input, { target: { value: '请@bo 检查方案' } });
  input.setSelectionRange(4, 4);
  fireEvent.click(input);
  fireEvent.click(screen.getByRole('option', { name: /Bob/ }));
  expect(input.value).toBe('请 检查方案');
  expect(screen.getByRole('button', { name: 'teamMentionRemove Bob' })).toBeTruthy();
});
