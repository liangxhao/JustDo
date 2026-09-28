// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import ThemedSelect from './ThemedSelect';

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    top: 100,
    bottom: 132,
    left: 20,
    right: 220,
    width: 200,
    height: 32,
    x: 20,
    y: 100,
    toJSON: () => ({}),
  });
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    value: vi.fn(),
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const options = [
  { value: 'off', label: 'Off' },
  { value: 'auto', label: 'Automatic', disabled: true },
  { value: 'on', label: 'On' },
];

test('blocks disabled option clicks and skips them with keyboard navigation', () => {
  const onChange = vi.fn();
  render(<ThemedSelect id="mode" value="off" options={options} onChange={onChange} />);
  const button = screen.getByRole('combobox');
  fireEvent.click(button);
  const automatic = screen.getByRole('option', { name: 'Automatic' });
  expect(automatic.getAttribute('aria-disabled')).toBe('true');
  fireEvent.click(automatic);
  expect(onChange).not.toHaveBeenCalled();
  fireEvent.keyDown(button, { key: 'ArrowDown' });
  fireEvent.keyDown(button, { key: 'Enter' });
  expect(onChange).toHaveBeenCalledWith('on');
});

test('shows a previously saved disabled value but selects an enabled option on opening', () => {
  const onChange = vi.fn();
  render(<ThemedSelect id="mode" value="auto" options={options} onChange={onChange} />);
  const button = screen.getByRole('combobox');
  expect(button.textContent).toContain('Automatic');
  fireEvent.keyDown(button, { key: 'ArrowDown' });
  fireEvent.keyDown(button, { key: 'Enter' });
  expect(onChange).toHaveBeenCalledWith('off');
});
