// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useEffect, useRef, useState } from 'react';
import { afterEach, expect, it, vi } from 'vitest';

import { useAppendComposerDraft } from './useAppendComposerDraft';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
it('appends to unflushed local input and cancels its old debounce write', () => {
  vi.useFakeTimers();
  const persist = vi.fn();
  function Composer() {
    const [value, setValue] = useState('Existing draft');
    const latestValueRef = useRef(value);
    latestValueRef.current = value;
    useAppendComposerDraft({
      draftKey: 'source',
      isSideChat: false,
      latestValueRef,
      setValue,
      persist,
      focus: () => {},
    });
    useEffect(() => {
      const timer = setTimeout(() => persist(value), 300);
      return () => clearTimeout(timer);
    }, [value]);
    return (
      <textarea aria-label="draft" value={value} onChange={event => setValue(event.target.value)} />
    );
  }
  render(<Composer />);
  fireEvent.change(screen.getByLabelText('draft'), { target: { value: 'Fresh user edit' } });
  const append = () =>
    window.dispatchEvent(
      new CustomEvent('cowork:append-draft', {
        cancelable: true,
        detail: { sessionId: 'source', text: 'Read exact batch' },
      }),
    );
  act(() => {
    expect(append()).toBe(false);
  });
  expect(screen.getByLabelText('draft')).toHaveProperty(
    'value',
    'Fresh user edit\n\nRead exact batch',
  );
  act(() => {
    append();
    vi.advanceTimersByTime(400);
  });
  expect(persist.mock.calls.every(([text]) => text === 'Fresh user edit\n\nRead exact batch')).toBe(
    true,
  );
  cleanup();
  expect(append()).toBe(true);
});
