// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createPortal } from 'react-dom';
import { afterEach, expect, test, vi } from 'vitest';

import EngineInteractionBoundary from './EngineInteractionBoundary';

afterEach(cleanup);

test('blocks portal actions and preserves its draft until execution admission returns', () => {
  const onAction = vi.fn();
  const onKeyDown = vi.fn();
  const onPointerDown = vi.fn();
  const onSubmit = vi.fn(event => event.preventDefault());
  const onDrop = vi.fn();
  const onPaste = vi.fn();
  const onChange = vi.fn();
  const onInput = vi.fn();
  const content = createPortal(
    <form onSubmit={onSubmit} aria-label="portal-form">
      <input
        aria-label="draft"
        defaultValue="Saved draft"
        onKeyDown={onKeyDown}
        onPaste={onPaste}
      />
      <input aria-label="auto-save" defaultValue="" onChange={onChange} onInput={onInput} />
      <button type="button" onClick={onAction} onPointerDown={onPointerDown} onDrop={onDrop}>
        Apply
      </button>
    </form>,
    document.body,
  );
  const { container, rerender } = render(
    <EngineInteractionBoundary disabled>{content}</EngineInteractionBoundary>,
  );
  const input = screen.getByRole('textbox', { name: 'draft' }) as HTMLInputElement;
  const action = screen.getByRole('button', { name: 'Apply' });
  const form = screen.getByRole('form', { name: 'portal-form' });
  expect(container.querySelector('[inert]')).toBeTruthy();
  expect(input.closest('[inert]')).toBeNull();
  fireEvent.click(action);
  fireEvent.pointerDown(action);
  fireEvent.keyDown(input, { key: 'Enter' });
  fireEvent.submit(form);
  fireEvent.drop(action);
  fireEvent.paste(input);
  fireEvent.change(screen.getByRole('textbox', { name: 'auto-save' }), {
    target: { value: 'pending' },
  });
  fireEvent.input(screen.getByRole('textbox', { name: 'auto-save' }), {
    target: { value: 'pending input' },
  });
  for (const handler of [
    onAction,
    onKeyDown,
    onPointerDown,
    onSubmit,
    onDrop,
    onPaste,
    onChange,
    onInput,
  ]) {
    expect(handler).not.toHaveBeenCalled();
  }

  rerender(<EngineInteractionBoundary disabled={false}>{content}</EngineInteractionBoundary>);
  expect(screen.getByRole('textbox', { name: 'draft' })).toBe(input);
  expect(input.value).toBe('Saved draft');
  expect(container.querySelector('[inert]')).toBeNull();
  fireEvent.click(action);
  fireEvent.keyDown(input, { key: 'Enter' });
  fireEvent.submit(form);
  fireEvent.change(screen.getByRole('textbox', { name: 'auto-save' }), {
    target: { value: 'confirmed' },
  });
  expect(onAction).toHaveBeenCalledOnce();
  expect(onKeyDown).toHaveBeenCalledOnce();
  expect(onSubmit).toHaveBeenCalledOnce();
  expect(onChange).toHaveBeenCalledOnce();
});
