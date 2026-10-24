import { SESSION_LIST_WIDTH_PREFERENCE_KEY } from '@shared/app/rendererPreferences';
import {
  type KeyboardEvent,
  type PointerEvent,
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';

import { rendererPreferences } from '@/services/rendererPreferences';
import { useOwnerWindow } from '@/shared/dom/ownerDocument';

const DEFAULT_WIDTH = 240;
const MIN_WIDTH = 180;
const MAX_WIDTH = 480;
const MIN_CONTENT_WIDTH = 320;
const CONTENT_INSET = 6;
const KEYBOARD_STEP = 24;

const clampWidth = (width: number, maximum: number) =>
  Math.min(Math.max(width, Math.min(MIN_WIDTH, maximum)), maximum);

export function useSessionListResize(visible: boolean) {
  const ownerWindow = useOwnerWindow();
  const panelRef = useRef<HTMLElement>(null);
  const cleanupRef = useRef<(() => void) | null>(null);
  const [requestedWidth, setRequestedWidth] = useState(() => {
    const saved = Number(rendererPreferences.getItem(SESSION_LIST_WIDTH_PREFERENCE_KEY));
    return Number.isFinite(saved) && saved > 0 ? clampWidth(saved, MAX_WIDTH) : DEFAULT_WIDTH;
  });
  const [maxWidth, setMaxWidth] = useState(MAX_WIDTH);
  const minWidth = Math.min(MIN_WIDTH, maxWidth);
  const width = clampWidth(requestedWidth, maxWidth);

  const measureMaxWidth = useCallback(() => {
    const panel = panelRef.current;
    const bounds = panel?.parentElement?.getBoundingClientRect();
    if (!panel || !bounds?.width) return MAX_WIDTH;
    return Math.max(
      0,
      Math.min(
        MAX_WIDTH,
        bounds.right - panel.getBoundingClientRect().left - MIN_CONTENT_WIDTH - CONTENT_INSET,
      ),
    );
  }, []);

  useLayoutEffect(() => {
    if (!visible) return;
    const measure = () => setMaxWidth(measureMaxWidth());
    measure();
    const observer = ownerWindow.ResizeObserver ? new ownerWindow.ResizeObserver(measure) : null;
    const parent = panelRef.current?.parentElement;
    if (parent) observer?.observe(parent);
    ownerWindow.addEventListener('resize', measure);
    return () => {
      observer?.disconnect();
      ownerWindow.removeEventListener('resize', measure);
      cleanupRef.current?.();
    };
  }, [measureMaxWidth, ownerWindow, visible]);

  const persistWidth = (next: number) =>
    rendererPreferences.setItem(SESSION_LIST_WIDTH_PREFERENCE_KEY, String(next));

  const beginResize = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !visible) return;
    event.preventDefault();
    cleanupRef.current?.();
    const handle = event.currentTarget;
    const resizeDocument = handle.ownerDocument;
    const resizeWindow = resizeDocument.defaultView ?? ownerWindow;
    const pointerId = event.pointerId;
    const startX = event.clientX;
    let nextWidth = width;
    let changed = false;
    const previousCursor = resizeDocument.body.style.cursor;
    const previousUserSelect = resizeDocument.body.style.userSelect;

    const move = (moveEvent: globalThis.PointerEvent) => {
      if (moveEvent.pointerId !== pointerId) return;
      nextWidth = clampWidth(width + moveEvent.clientX - startX, measureMaxWidth());
      changed = true;
      setRequestedWidth(nextWidth);
    };
    const stop = (stopEvent: globalThis.PointerEvent) => {
      if (stopEvent.pointerId !== pointerId) return;
      if (changed) persistWidth(nextWidth);
      cleanupRef.current?.();
    };
    const cancel = (cancelEvent: globalThis.PointerEvent) => {
      if (cancelEvent.pointerId === pointerId) cleanupRef.current?.();
    };
    const cleanup = () => {
      cleanupRef.current = null;
      resizeWindow.removeEventListener('pointermove', move);
      resizeWindow.removeEventListener('pointerup', stop);
      resizeWindow.removeEventListener('pointercancel', cancel);
      resizeWindow.removeEventListener('blur', cleanup);
      handle.removeEventListener('lostpointercapture', cancel);
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
    resizeWindow.addEventListener('pointercancel', cancel);
    resizeWindow.addEventListener('blur', cleanup);
    handle.addEventListener('lostpointercapture', cancel);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!visible || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const next = clampWidth(
      event.key === 'Home'
        ? minWidth
        : event.key === 'End'
          ? maxWidth
          : width + (event.key === 'ArrowRight' ? KEYBOARD_STEP : -KEYBOARD_STEP),
      maxWidth,
    );
    setRequestedWidth(next);
    persistWidth(next);
  };

  return { panelRef, width, minWidth, maxWidth, beginResize, handleKeyDown };
}
