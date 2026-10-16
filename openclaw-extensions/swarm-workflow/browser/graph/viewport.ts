import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

const MIN_ZOOM = 0.2;
const MAX_ZOOM = 3;
const INITIAL_VIEW = { x: 0, y: 0, zoom: 1 };

export function zoomGraphAt(
  view: typeof INITIAL_VIEW,
  zoom: number,
  point: { x: number; y: number },
) {
  const nextZoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
  const ratio = nextZoom / view.zoom;
  return {
    zoom: nextZoom,
    x: point.x - (point.x - view.x) * ratio,
    y: point.y - (point.y - view.y) * ratio,
  };
}

/** Canvas navigation is independent of workflow state and node/edge selection. */
export function useSwarmWorkflowGraphViewport(graph?: {
  key: string;
  width: number;
  height: number;
  active: boolean;
}) {
  const [element, setElement] = useState<HTMLDivElement | null>(null);
  const [view, setView] = useState(INITIAL_VIEW);
  const [autoFit, setAutoFit] = useState(true);
  const [dragging, setDragging] = useState(false);
  const gesture = useRef<{
    pointerId: number;
    x: number;
    y: number;
    view: typeof INITIAL_VIEW;
    moved: boolean;
  }>();
  const suppressClick = useRef(false);
  useEffect(() => {
    setDragging(false);
    if (!element) return;
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      if (gesture.current) return;
      const rect = element.getBoundingClientRect();
      // Normalize pixel, line and page wheels before applying bounded zoom steps.
      const delta =
        event.deltaY *
        (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? element.clientHeight : 1);
      const factor = Math.exp(-Math.max(-300, Math.min(300, delta)) * 0.002);
      setAutoFit(false);
      setView(current =>
        zoomGraphAt(current, current.zoom * factor, {
          x: event.clientX - rect.left,
          y: event.clientY - rect.top,
        }),
      );
    };
    element.addEventListener('wheel', wheel, { passive: false });
    return () => {
      element.removeEventListener('wheel', wheel);
      gesture.current = undefined;
      suppressClick.current = false;
    };
  }, [element]);
  const reset = useCallback(() => {
    gesture.current = undefined;
    suppressClick.current = false;
    setDragging(false);
    setAutoFit(true);
    setView(INITIAL_VIEW);
  }, []);
  const fit = useCallback(
    (width: number, height: number) => {
      if (!element || !element.clientWidth || !element.clientHeight || width <= 0 || height <= 0)
        return;
      const baseWidth = Math.max(360, element.clientWidth);
      const baseHeight = (baseWidth * height) / width;
      const zoom = Math.min(element.clientWidth / baseWidth, element.clientHeight / baseHeight);
      setAutoFit(true);
      setView({
        zoom,
        x: (element.clientWidth - baseWidth * zoom) / 2,
        y: (element.clientHeight - baseHeight * zoom) / 2,
      });
    },
    [element],
  );
  const graphKey = graph?.key;
  const width = graph?.width;
  const height = graph?.height;
  const active = graph?.active;
  useLayoutEffect(reset, [graphKey, reset]);
  useLayoutEffect(() => {
    if (!element || !active || !autoFit || !width || !height) return;
    const fitGraph = () => fit(width, height);
    fitGraph();
    const ResizeObserver = element.ownerDocument.defaultView?.ResizeObserver;
    if (!ResizeObserver) return;
    const observer = new ResizeObserver(fitGraph);
    observer.observe(element);
    return () => observer.disconnect();
  }, [element, active, autoFit, graphKey, width, height, fit]);
  const zoomBy = (factor: number) => {
    if (!element) return;
    setAutoFit(false);
    setView(current =>
      zoomGraphAt(current, current.zoom * factor, {
        x: element.clientWidth / 2,
        y: element.clientHeight / 2,
      }),
    );
  };
  const finish = (event: ReactPointerEvent<HTMLDivElement>, cancelled = false) => {
    if (gesture.current?.pointerId !== event.pointerId) return;
    suppressClick.current = !cancelled && gesture.current.moved;
    gesture.current = undefined;
    setDragging(false);
    if (event.currentTarget.hasPointerCapture?.(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
  };
  return {
    ref: setElement,
    reset,
    zoomIn: () => zoomBy(1.2),
    zoomOut: () => zoomBy(1 / 1.2),
    fit,
    svgStyle: {
      width: '100%',
      minWidth: 360,
      transformOrigin: '0 0',
      transform: `translate(${view.x}px, ${view.y}px) scale(${view.zoom})`,
    } satisfies CSSProperties,
    canvasStyle: {
      touchAction: 'none',
      cursor: dragging ? 'grabbing' : 'grab',
      userSelect: 'none',
    } satisfies CSSProperties,
    handlers: {
      onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => {
        if (event.button !== 0 || gesture.current) return;
        suppressClick.current = false;
        gesture.current = {
          pointerId: event.pointerId,
          x: event.clientX,
          y: event.clientY,
          view,
          moved: false,
        };
      },
      onPointerMove: (event: ReactPointerEvent<HTMLDivElement>) => {
        const current = gesture.current;
        if (!current || current.pointerId !== event.pointerId) return;
        if (!current.moved && Math.hypot(event.clientX - current.x, event.clientY - current.y) < 6)
          return;
        if (!current.moved) {
          current.moved = true;
          setAutoFit(false);
          event.currentTarget.setPointerCapture?.(event.pointerId);
          setDragging(true);
        }
        setView({
          ...current.view,
          x: current.view.x + event.clientX - current.x,
          y: current.view.y + event.clientY - current.y,
        });
      },
      onPointerUp: (event: ReactPointerEvent<HTMLDivElement>) => finish(event),
      onPointerCancel: (event: ReactPointerEvent<HTMLDivElement>) => finish(event, true),
      onLostPointerCapture: (event: ReactPointerEvent<HTMLDivElement>) => finish(event),
      onPointerLeave: (event: ReactPointerEvent<HTMLDivElement>) => {
        if (gesture.current && !gesture.current.moved) finish(event, true);
      },
      onClickCapture: (event: React.MouseEvent<HTMLDivElement>) => {
        if (!suppressClick.current) return;
        suppressClick.current = false;
        event.preventDefault();
        event.stopPropagation();
      },
    },
  };
}
