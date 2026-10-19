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

test('uses viewport space for the portaled menu inside a short scrollable dialog body', () => {
  render(
    <div data-testid="dialog-body" style={{ overflowY: 'auto' }}>
      <ThemedSelect id="model" value="off" options={options} onChange={vi.fn()} />
    </div>,
  );
  const body = screen.getByTestId('dialog-body');
  let buttonTop = 100;
  vi.mocked(HTMLElement.prototype.getBoundingClientRect).mockImplementation(function (
    this: HTMLElement,
  ) {
    const top = this === body ? 80 : buttonTop;
    const height = this === body ? 100 : 32;
    return {
      top,
      bottom: top + height,
      left: 20,
      right: 220,
      width: 200,
      height,
      x: 20,
      y: top,
      toJSON: () => ({}),
    };
  });

  fireEvent.click(screen.getByRole('combobox'));

  const menu = screen.getByRole('listbox').parentElement!;
  expect(menu.parentElement).toBe(document.body);
  expect(menu.style.maxHeight).toBe('240px');
  expect(menu.style.top).toBe('136px');

  // A portaled menu still closes when its trigger scrolls out of the dialog body.
  buttonTop = 40;
  fireEvent.scroll(body);
  expect(screen.queryByRole('listbox')).toBeNull();
});

test('opens upward near the viewport bottom and stays inside the viewport', () => {
  render(<ThemedSelect id="model" value="off" options={options} onChange={vi.fn()} />);
  const button = screen.getByRole('combobox');
  vi.spyOn(button, 'getBoundingClientRect').mockReturnValue({
    top: window.innerHeight - 64,
    bottom: window.innerHeight - 32,
    left: 20,
    right: 220,
    width: 200,
    height: 32,
    x: 20,
    y: window.innerHeight - 64,
    toJSON: () => ({}),
  });

  fireEvent.click(button);

  const menu = screen.getByRole('listbox').parentElement!;
  expect(menu.style.bottom).toBe('68px');
  expect(menu.style.top).toBe('');
  expect(menu.style.maxHeight).toBe('240px');
});
