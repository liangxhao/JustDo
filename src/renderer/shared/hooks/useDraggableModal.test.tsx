// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useRef } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useDraggableModal } from './useDraggableModal';

class TestPointerEvent extends MouseEvent {
  readonly pointerId: number;

  constructor(type: string, init: MouseEventInit & { pointerId?: number } = {}) {
    super(type, init);
    this.pointerId = init.pointerId ?? 0;
  }
}

let resizeObserverCallback: ResizeObserverCallback | undefined;

class TestResizeObserver implements ResizeObserver {
  constructor(callback: ResizeObserverCallback) {
    resizeObserverCallback = callback;
  }

  disconnect = vi.fn();
  observe = vi.fn();
  unobserve = vi.fn();
}

const Harness = () => {
  const dialogRef = useRef<HTMLDivElement>(null);
  const { dialogStyle, dragHandleProps, isDragging } = useDraggableModal(dialogRef, 'dialog-1');
  return (
    <div
      ref={dialogRef}
      data-testid="dialog"
      data-dragging={String(isDragging)}
      style={dialogStyle}
    >
      <div data-testid="handle" {...dragHandleProps}>
        <span>Title</span>
        <button type="button">Close</button>
      </div>
    </div>
  );
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  resizeObserverCallback = undefined;
});

describe('useDraggableModal', () => {
  it('moves from the title bar and keeps the dialog inside the viewport', () => {
    vi.stubGlobal('PointerEvent', TestPointerEvent);
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      left: 200,
      top: 100,
      right: 600,
      bottom: 500,
      width: 400,
      height: 400,
      x: 200,
      y: 100,
      toJSON: () => ({}),
    });
    render(<Harness />);
    const handle = screen.getByTestId('handle');
    const dialog = screen.getByTestId('dialog');

    fireEvent.pointerDown(handle, { button: 0, pointerId: 1, clientX: 250, clientY: 150 });
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 350, clientY: 250 });
    expect(dialog.style.left).toBe('100px');
    expect(dialog.style.top).toBe('100px');

    fireEvent.pointerMove(handle, { pointerId: 1, clientX: -1000, clientY: -1000 });
    expect(dialog.style.left).toBe('-188px');
    expect(dialog.style.top).toBe('-88px');
  });

  it('does not start dragging from a header button', () => {
    vi.stubGlobal('PointerEvent', TestPointerEvent);
    render(<Harness />);
    const handle = screen.getByTestId('handle');
    const dialog = screen.getByTestId('dialog');

    fireEvent.pointerDown(screen.getByRole('button', { name: 'Close' }), {
      button: 0,
      pointerId: 1,
      clientX: 10,
      clientY: 10,
    });
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 100, clientY: 100 });
    expect(dialog.style.left).toBe('0px');
    expect(dialog.style.top).toBe('0px');
  });

  it('ends dragging safely when pointer capture is lost', () => {
    vi.stubGlobal('PointerEvent', TestPointerEvent);
    render(<Harness />);
    const handle = screen.getByTestId('handle');
    const setPointerCapture = vi.fn();
    const releasePointerCapture = vi.fn();
    Object.defineProperties(handle, {
      setPointerCapture: { value: setPointerCapture },
      hasPointerCapture: { value: vi.fn(() => false) },
      releasePointerCapture: { value: releasePointerCapture },
    });

    fireEvent.pointerDown(handle, { button: 0, pointerId: 1, clientX: 10, clientY: 10 });
    expect(screen.getByTestId('dialog').getAttribute('data-dragging')).toBe('true');
    fireEvent.lostPointerCapture(handle, { pointerId: 1 });

    expect(setPointerCapture).toHaveBeenCalledWith(1);
    expect(releasePointerCapture).not.toHaveBeenCalled();
    expect(screen.getByTestId('dialog').getAttribute('data-dragging')).toBe('false');
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 100, clientY: 100 });
    expect(screen.getByTestId('dialog').style.left).toBe('0px');
  });

  it('keeps the dialog visible after its content size changes', () => {
    vi.stubGlobal('PointerEvent', TestPointerEvent);
    vi.stubGlobal('ResizeObserver', TestResizeObserver);
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => {
      callback(0);
      return 1;
    });
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      left: 100,
      top: -40,
      right: 500,
      bottom: 560,
      width: 400,
      height: 600,
      x: 100,
      y: -40,
      toJSON: () => ({}),
    });
    render(<Harness />);
    const handle = screen.getByTestId('handle');
    fireEvent.pointerDown(handle, { button: 0, pointerId: 1, clientX: 120, clientY: 20 });
    expect(screen.getByTestId('dialog').getAttribute('data-dragging')).toBe('true');

    act(() => resizeObserverCallback?.([], {} as ResizeObserver));

    expect(screen.getByTestId('dialog').style.top).toBe('52px');
    expect(screen.getByTestId('dialog').getAttribute('data-dragging')).toBe('false');
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 120, clientY: -100 });
    expect(screen.getByTestId('dialog').style.top).toBe('52px');
  });
});
