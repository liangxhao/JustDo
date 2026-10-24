// @vitest-environment jsdom
import { SESSION_LIST_WIDTH_PREFERENCE_KEY } from '@shared/app/rendererPreferences';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { rendererPreferences } from '@/services/rendererPreferences';

import { useSessionListResize } from './useSessionListResize';

function Shell({ visible = true }: { visible?: boolean }) {
  const resize = useSessionListResize(visible);
  return (
    <div>
      <aside ref={resize.panelRef} hidden={!visible} style={{ width: resize.width }}>
        <div
          role="separator"
          aria-valuenow={resize.width}
          aria-valuemin={resize.minWidth}
          aria-valuemax={resize.maxWidth}
          onPointerDown={resize.beginResize}
          onKeyDown={resize.handleKeyDown}
        />
      </aside>
    </div>
  );
}

let shellWidth = 1000;
let measure = () => {};

beforeEach(() => {
  shellWidth = 1000;
  rendererPreferences.removeItem(SESSION_LIST_WIDTH_PREFERENCE_KEY);
  vi.stubGlobal(
    'PointerEvent',
    class extends MouseEvent {
      readonly pointerId: number;
      constructor(type: string, options: PointerEventInit = {}) {
        super(type, options);
        this.pointerId = options.pointerId ?? 1;
      }
    },
  );
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: () => void) {
        measure = callback;
      }
      observe() {}
      disconnect() {}
    },
  );
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement,
  ) {
    return (
      this.tagName === 'ASIDE'
        ? { left: 44, right: 284, width: 240 }
        : { left: 0, right: shellWidth, width: shellWidth }
    ) as DOMRect;
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.style.cursor = '';
  document.body.style.userSelect = '';
});

it('drags in both directions, limits width and restores the completed choice on remount', () => {
  const view = render(<Shell />);
  const divider = screen.getByRole('separator');
  const panel = screen.getByRole('complementary');
  const setPointerCapture = vi.fn();
  const releasePointerCapture = vi.fn();
  Object.assign(divider, {
    setPointerCapture,
    releasePointerCapture,
    hasPointerCapture: () => true,
  });
  expect(panel.style.width).toBe('240px');
  fireEvent.pointerDown(divider, { button: 0, pointerId: 7, clientX: 284 });
  expect(setPointerCapture).toHaveBeenCalledWith(7);
  fireEvent.pointerMove(window, { pointerId: 7, clientX: 400 });
  expect(panel.style.width).toBe('356px');
  fireEvent.pointerMove(window, { pointerId: 8, clientX: 100 });
  fireEvent.pointerUp(window, { pointerId: 8 });
  expect(panel.style.width).toBe('356px');
  fireEvent.pointerMove(window, { pointerId: 7, clientX: 2000 });
  expect(panel.style.width).toBe('480px');
  fireEvent.pointerMove(window, { pointerId: 7, clientX: -1000 });
  expect(panel.style.width).toBe('180px');
  fireEvent.pointerMove(window, { pointerId: 7, clientX: 344 });
  expect(rendererPreferences.getItem(SESSION_LIST_WIDTH_PREFERENCE_KEY)).toBeNull();
  fireEvent.pointerUp(window, { pointerId: 7 });
  expect(releasePointerCapture).toHaveBeenCalledWith(7);
  fireEvent.pointerMove(window, { pointerId: 7, clientX: 500 });
  expect(panel.style.width).toBe('300px');
  expect(document.body.style.cursor).toBe('');
  expect(document.body.style.userSelect).toBe('');
  view.unmount();
  render(<Shell />);
  expect(screen.getByRole('complementary').style.width).toBe('300px');
});

it('adjusts by keyboard and preserves preferred width across window sizing and hiding', () => {
  const view = render(<Shell />);
  const divider = screen.getByRole('separator');
  fireEvent.keyDown(divider, { key: 'ArrowLeft' });
  expect(divider.getAttribute('aria-valuenow')).toBe('216');
  fireEvent.keyDown(divider, { key: 'ArrowRight' });
  expect(divider.getAttribute('aria-valuenow')).toBe('240');
  fireEvent.keyDown(divider, { key: 'End' });
  expect(divider.getAttribute('aria-valuenow')).toBe('480');
  shellWidth = 600;
  act(() => measure());
  expect(divider.getAttribute('aria-valuenow')).toBe('230');
  expect(divider.getAttribute('aria-valuemax')).toBe('230');
  expect(rendererPreferences.getItem(SESSION_LIST_WIDTH_PREFERENCE_KEY)).toBe('480');
  shellWidth = 500;
  act(() => measure());
  expect(divider.getAttribute('aria-valuenow')).toBe('130');
  expect(divider.getAttribute('aria-valuemin')).toBe('130');
  shellWidth = 1000;
  act(() => measure());
  expect(divider.getAttribute('aria-valuenow')).toBe('480');
  view.rerender(<Shell visible={false} />);
  expect(screen.queryByRole('separator')).toBeNull();
  view.rerender(<Shell />);
  expect(divider.getAttribute('aria-valuenow')).toBe('480');
  fireEvent.keyDown(divider, { key: 'Home' });
  expect(divider.getAttribute('aria-valuenow')).toBe('180');
});

it.each(['pointercancel', 'lostpointercapture', 'blur', 'hide', 'unmount'])(
  'releases drag state on %s without saving an incomplete gesture',
  action => {
    document.body.style.cursor = 'default';
    document.body.style.userSelect = 'text';
    const view = render(<Shell />);
    const divider = screen.getByRole('separator');
    fireEvent.pointerDown(divider, { button: 0, pointerId: 7, clientX: 284 });
    fireEvent.pointerMove(window, { pointerId: 7, clientX: 344 });
    expect(document.body.style.cursor).toBe('col-resize');
    if (action === 'hide') view.rerender(<Shell visible={false} />);
    else if (action === 'unmount') view.unmount();
    else if (action === 'blur') fireEvent(window, new Event('blur'));
    else
      fireEvent(
        action === 'lostpointercapture' ? divider : window,
        new PointerEvent(action, { pointerId: 7 }),
      );
    expect(document.body.style.cursor).toBe('default');
    expect(document.body.style.userSelect).toBe('text');
    fireEvent.pointerMove(window, { pointerId: 7, clientX: 500 });
    expect(divider.getAttribute('aria-valuenow')).toBe('300');
    expect(rendererPreferences.getItem(SESSION_LIST_WIDTH_PREFERENCE_KEY)).toBeNull();
  },
);
