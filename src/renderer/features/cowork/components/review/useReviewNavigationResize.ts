import {
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  useEffect,
  useRef,
  useState,
} from 'react';

import { useOwnerWindow } from '@/shared/dom/ownerDocument';

const DEFAULT_WIDTH = 240;
const MIN_WIDTH = 160;
const MIN_CONTENT_WIDTH = 320;
const HANDLE_WIDTH = 6;
const WIDE_PANEL_WIDTH = 760;
const KEYBOARD_STEP = 24;

export function useReviewNavigationResize(visible: boolean) {
  const ownerWindow = useOwnerWindow();
  const bodyRef = useRef<HTMLDivElement>(null);
  const cleanupRef = useRef<(() => void) | null>(null);
  const [bodyWidth, setBodyWidth] = useState(0);
  const [requestedWidth, setRequestedWidth] = useState(DEFAULT_WIDTH);
  const maxWidth = bodyWidth
    ? Math.max(MIN_WIDTH, bodyWidth - MIN_CONTENT_WIDTH - HANDLE_WIDTH)
    : DEFAULT_WIDTH;
  const width = Math.min(requestedWidth, maxWidth);
  const wide = bodyWidth >= WIDE_PANEL_WIDTH;

  useEffect(() => {
    if (!visible) return;
    const body = bodyRef.current;
    const measure = () => setBodyWidth(body?.getBoundingClientRect().width ?? 0);
    measure();
    const observer = ownerWindow.ResizeObserver ? new ownerWindow.ResizeObserver(measure) : null;
    if (body) observer?.observe(body);
    ownerWindow.addEventListener('resize', measure);
    return () => {
      observer?.disconnect();
      ownerWindow.removeEventListener('resize', measure);
      cleanupRef.current?.();
    };
  }, [ownerWindow, visible]);

  useEffect(() => {
    if (!wide || !visible) cleanupRef.current?.();
  }, [wide, visible]);

  const beginResize = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !wide || !visible) return;
    event.preventDefault();
    cleanupRef.current?.();
    const handle = event.currentTarget;
    const resizeDocument = handle.ownerDocument;
    const resizeWindow = resizeDocument.defaultView ?? ownerWindow;
    const pointerId = event.pointerId;
    const startX = event.clientX;
    const initialWidth = width;
    const previousCursor = resizeDocument.body.style.cursor;
    const previousUserSelect = resizeDocument.body.style.userSelect;

    const move = (moveEvent: globalThis.PointerEvent) => {
      if (moveEvent.pointerId !== pointerId) return;
      const availableWidth = bodyRef.current?.getBoundingClientRect().width ?? 0;
      if (availableWidth < WIDE_PANEL_WIDTH) {
        cleanupRef.current?.();
        return;
      }
      const maximum = availableWidth - MIN_CONTENT_WIDTH - HANDLE_WIDTH;
      setRequestedWidth(
        Math.min(Math.max(initialWidth + startX - moveEvent.clientX, MIN_WIDTH), maximum),
      );
    };
    const stop = (stopEvent: globalThis.PointerEvent) => {
      if (stopEvent.pointerId === pointerId) cleanupRef.current?.();
    };
    const cleanup = () => {
      cleanupRef.current = null;
      resizeWindow.removeEventListener('pointermove', move);
      resizeWindow.removeEventListener('pointerup', stop);
      resizeWindow.removeEventListener('pointercancel', stop);
      resizeWindow.removeEventListener('blur', cleanup);
      handle.removeEventListener('lostpointercapture', stop);
      if (handle.hasPointerCapture?.(pointerId)) handle.releasePointerCapture(pointerId);
      resizeDocument.body.style.cursor = previousCursor;
      resizeDocument.body.style.userSelect = previousUserSelect;
    };

    cleanupRef.current = cleanup;
    resizeDocument.body.style.cursor = 'col-resize';
    resizeDocument.body.style.userSelect = 'none';
    handle.setPointerCapture?.(pointerId);
    resizeWindow.addEventListener('pointermove', move);
    resizeWindow.addEventListener('pointerup', stop);
    resizeWindow.addEventListener('pointercancel', stop);
    resizeWindow.addEventListener('blur', cleanup);
    handle.addEventListener('lostpointercapture', stop);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!wide || !visible || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key))
      return;
    event.preventDefault();
    const next =
      event.key === 'Home'
        ? MIN_WIDTH
        : event.key === 'End'
          ? maxWidth
          : width + (event.key === 'ArrowLeft' ? KEYBOARD_STEP : -KEYBOARD_STEP);
    setRequestedWidth(Math.min(Math.max(next, MIN_WIDTH), maxWidth));
  };

  return {
    bodyRef,
    style: { '--review-navigation-width': `${width}px` } as CSSProperties,
    width,
    minWidth: MIN_WIDTH,
    maxWidth,
    tabIndex: visible && wide ? 0 : -1,
    beginResize,
    handleKeyDown,
  };
}
