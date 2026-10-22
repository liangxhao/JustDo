// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, expect, test, vi } from 'vitest';

import FeatureTextarea from './FeatureTextarea';

afterEach(cleanup);
test('renders the adapter icon without coupling the atomic tag to any plugin', () => {
  render(
    <FeatureTextarea
      featureLabel="Another capability"
      featureIcon={<svg data-testid="plugin-icon" />}
      removeLabel="Remove capability"
      onRemoveFeature={vi.fn()}
    />,
  );
  expect(screen.getByRole('button').contains(screen.getByTestId('plugin-icon'))).toBe(true);
  expect(screen.getByRole('textbox').getAttribute('featureIcon')).toBeNull();
});

function Draft() {
  const [feature, setFeature] = useState(true);
  const [value, setValue] = useState('Hello');
  return (
    <FeatureTextarea
      value={value}
      featureLabel={feature ? 'Swarm' : undefined}
      removeLabel="Remove Swarm"
      onRemoveFeature={() => setFeature(false)}
      onChange={event => setValue(event.target.value)}
    />
  );
}
test('the feature is atomic and never becomes part of the editable message', () => {
  render(<Draft />);
  const input = screen.getByRole('textbox') as HTMLTextAreaElement;
  expect(input.value).toBe('Hello');
  fireEvent.change(input, { target: { value: '你好啊' } });
  expect(screen.getByRole('button', { name: 'Remove Swarm' }).textContent).toBe('Swarm');
  fireEvent.click(screen.getByRole('button', { name: 'Remove Swarm' }));
  expect(screen.queryByRole('button')).toBeNull();
  expect(input.value).toBe('你好啊');
});

test('partial editing after select-all keeps the feature when the native selection moved', () => {
  render(<Draft />);
  const input = screen.getByRole('textbox') as HTMLTextAreaElement;
  fireEvent.keyDown(input, { key: 'a', ctrlKey: true });
  input.setSelectionRange(2, 2);
  fireEvent.select(input);
  fireEvent.keyDown(input, { key: 'Backspace' });
  fireEvent.change(input, { target: { value: 'Hllo' } });
  expect(screen.getByRole('button')).toBeTruthy();
});

test('programmatic or pointer full selection supports atomic deletion without a Ctrl+A key', () => {
  render(<Draft />);
  const input = screen.getByRole('textbox') as HTMLTextAreaElement;
  input.setSelectionRange(0, input.value.length);
  fireEvent.select(input);
  fireEvent.keyDown(input, { key: 'Delete' });
  expect(screen.queryByRole('button')).toBeNull();
});

test('IME replacement of a whole selected draft removes the feature only after composition commits', () => {
  render(<Draft />);
  const input = screen.getByRole('textbox') as HTMLTextAreaElement;
  fireEvent.keyDown(input, { key: 'a', ctrlKey: true });
  input.setSelectionRange(0, input.value.length);
  fireEvent.compositionStart(input);
  fireEvent.change(input, { target: { value: '你好' } });
  expect(screen.getByRole('button')).toBeTruthy();
  fireEvent.compositionEnd(input, { data: '你好' });
  expect(screen.queryByRole('button')).toBeNull();
  expect(input.value).toBe('你好');
});

test('notifies the owner after applying and removing prefix indentation', () => {
  const changed = vi.fn((input: HTMLTextAreaElement) => input.style.textIndent);
  const props = { removeLabel: 'Remove Swarm', onRemoveFeature: vi.fn(), onLayoutChange: changed };
  const view = render(<FeatureTextarea {...props} featureLabel="Swarm" />);
  expect(changed.mock.results[changed.mock.results.length - 1]?.value).toBe('6px');
  view.rerender(<FeatureTextarea {...props} />);
  expect(changed.mock.results[changed.mock.results.length - 1]?.value).toBe('');
});

test('read-only drafts cannot remove the feature', () => {
  const remove = vi.fn();
  render(
    <FeatureTextarea
      featureLabel="Swarm"
      readOnly
      onRemoveFeature={remove}
      removeLabel="Remove Swarm"
    />,
  );
  fireEvent.click(screen.getByRole('button'));
  fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Backspace' });
  expect(remove).not.toHaveBeenCalled();
});
test('Backspace at the start cancels the feature without deleting message text', () => {
  render(<Draft />);
  const input = screen.getByRole('textbox') as HTMLTextAreaElement;
  input.setSelectionRange(0, 0);
  fireEvent.keyDown(input, { key: 'Backspace' });
  expect(screen.queryByRole('button')).toBeNull();
  expect(input.value).toBe('Hello');
});
test('editing within the message and IME composition do not remove the feature', () => {
  render(<Draft />);
  const input = screen.getByRole('textbox') as HTMLTextAreaElement;
  input.setSelectionRange(3, 3);
  fireEvent.keyDown(input, { key: 'Backspace' });
  input.setSelectionRange(0, 0);
  fireEvent.keyDown(input, { key: 'Backspace', isComposing: true, keyCode: 229 });
  expect(screen.getByRole('button')).toBeTruthy();
});
test('select all then replacing the draft also cancels the feature', () => {
  render(<Draft />);
  const input = screen.getByRole('textbox') as HTMLTextAreaElement;
  fireEvent.keyDown(input, { key: 'a', ctrlKey: true });
  input.setSelectionRange(0, input.value.length);
  fireEvent.change(input, { target: { value: 'New message' } });
  expect(screen.queryByRole('button')).toBeNull();
  expect(input.value).toBe('New message');
});
test('keyboard arrows can select the complete feature and return to the message', () => {
  render(<Draft />);
  const input = screen.getByRole('textbox') as HTMLTextAreaElement;
  input.setSelectionRange(0, 0);
  fireEvent.keyDown(input, { key: 'ArrowLeft' });
  const token = screen.getByRole('button');
  expect(document.activeElement).toBe(token);
  fireEvent.keyDown(token, { key: 'ArrowRight' });
  expect(document.activeElement).toBe(input);
  expect(input.selectionStart).toBe(0);
});
