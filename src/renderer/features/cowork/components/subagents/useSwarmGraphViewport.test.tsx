// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { useSwarmGraphViewport, zoomGraphAt } from './useSwarmGraphViewport';

beforeEach(() => {
  class Pointer extends MouseEvent {
    pointerId: number;
    constructor(type: string, options: PointerEventInit = {}) {
      super(type, options);
      this.pointerId = options.pointerId ?? 1;
    }
  }
  vi.stubGlobal('PointerEvent', Pointer);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
function Canvas({ select = vi.fn() }: { select?: () => void }) {
  const viewport = useSwarmGraphViewport();
  return (
    <>
      <div
        ref={viewport.ref}
        {...viewport.handlers}
        style={viewport.canvasStyle}
        data-testid="canvas"
      >
        <svg style={viewport.svgStyle} data-testid="graph" />
        <button onClick={select}>Node</button>
      </div>
      <button onClick={viewport.zoomIn}>Zoom</button>
      <button onClick={() => viewport.fit(400, 800)}>Fit</button>
      <button onClick={viewport.reset}>Reset</button>
    </>
  );
}
function graphTransform() {
  return screen.getByTestId('graph').style.transform;
}
test('zooms around the pointer while retaining its graph coordinate, including clamped zoom', () => {
  const view = { x: 40, y: -20, zoom: 1 };
  const point = { x: 200, y: 150 };
  for (const scale of [0.01, 2, 100]) {
    const next = zoomGraphAt(view, scale, point);
    expect((point.x - next.x) / next.zoom).toBeCloseTo((point.x - view.x) / view.zoom);
    expect((point.y - next.y) / next.zoom).toBeCloseTo((point.y - view.y) / view.zoom);
  }
});
test('cancels outer scrolling and zooms at the local mouse position', () => {
  render(<Canvas />);
  const canvas = screen.getByTestId('canvas');
  vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue({ left: 100, top: 50 } as DOMRect);
  const event = new WheelEvent('wheel', {
    deltaY: -100,
    clientX: 200,
    clientY: 150,
    bubbles: true,
    cancelable: true,
  });
  act(() => {
    expect(canvas.dispatchEvent(event)).toBe(false);
  });
  const match = graphTransform().match(/translate\(([-\d.]+)px, ([-\d.]+)px\) scale\(([-\d.]+)\)/)!;
  const [, x, y, scale] = match.map(Number);
  expect(scale).toBeGreaterThan(1);
  expect((100 - x) / scale).toBeCloseTo(100);
  expect((100 - y) / scale).toBeCloseTo(100);
});
test('preserves short node clicks and suppresses detail opening after a drag', () => {
  const select = vi.fn();
  render(<Canvas select={select} />);
  const node = screen.getByText('Node');
  const canvas = screen.getByTestId('canvas');
  fireEvent.pointerDown(node, { pointerId: 1, button: 0, clientX: 20, clientY: 20 });
  fireEvent.pointerMove(canvas, { pointerId: 1, clientX: 22, clientY: 22 });
  fireEvent.pointerUp(node, { pointerId: 1 });
  fireEvent.click(node);
  expect(select).toHaveBeenCalledTimes(1);
  fireEvent.pointerDown(node, { pointerId: 2, button: 0, clientX: 20, clientY: 20 });
  fireEvent.pointerMove(canvas, { pointerId: 2, clientX: 100, clientY: 70 });
  expect(graphTransform()).toBe('translate(80px, 50px) scale(1)');
  fireEvent.pointerUp(canvas, { pointerId: 2 });
  fireEvent.click(node);
  expect(select).toHaveBeenCalledTimes(1);
  fireEvent.pointerDown(node, { pointerId: 3, button: 0 });
  fireEvent.pointerUp(node, { pointerId: 3 });
  fireEvent.click(node);
  expect(select).toHaveBeenCalledTimes(2);
});
test('fits the entire tall graph and resets navigation', () => {
  render(<Canvas />);
  const canvas = screen.getByTestId('canvas');
  Object.defineProperties(canvas, { clientWidth: { value: 400 }, clientHeight: { value: 400 } });
  fireEvent.click(screen.getByText('Fit'));
  expect(graphTransform()).toBe('translate(100px, 0px) scale(0.5)');
  fireEvent.click(screen.getByText('Reset'));
  expect(graphTransform()).toBe('translate(0px, 0px) scale(1)');
});
test('ignores non-primary buttons and releases a cancelled gesture without swallowing the next click', () => {
  const select = vi.fn();
  render(<Canvas select={select} />);
  const canvas = screen.getByTestId('canvas');
  fireEvent.pointerDown(canvas, { pointerId: 1, button: 2 });
  fireEvent.pointerMove(canvas, { pointerId: 1, clientX: 100 });
  expect(graphTransform()).toBe('translate(0px, 0px) scale(1)');
  fireEvent.pointerDown(canvas, { pointerId: 2, button: 0, clientX: 0, clientY: 0 });
  fireEvent.pointerMove(canvas, { pointerId: 2, clientX: 100, clientY: 0 });
  fireEvent.pointerCancel(canvas, { pointerId: 2 });
  fireEvent.click(screen.getByText('Node'));
  expect(select).toHaveBeenCalledTimes(1);
  expect(canvas.style.cursor).toBe('grab');
});
