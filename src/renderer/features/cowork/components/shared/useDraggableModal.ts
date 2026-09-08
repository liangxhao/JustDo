import type React from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';

interface DragPosition {
  x: number;
  y: number;
}

interface DragStart extends DragPosition {
  pointerId: number;
  clientX: number;
  clientY: number;
  rect: DOMRect;
  captureTarget: HTMLDivElement;
}

const VIEWPORT_MARGIN = 12;
const INTERACTIVE_SELECTOR =
  'button, a, input, select, textarea, [role="button"], [contenteditable="true"]';

const clamp = (value: number, minimum: number, maximum: number): number =>
  Math.min(Math.max(value, minimum), maximum);

export const useDraggableModal = (
  dialogRef: React.RefObject<HTMLElement | null>,
  resetKey: unknown,
) => {
  const [position, setPosition] = useState<DragPosition>({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const dragStartRef = useRef<DragStart>();

  const clearDrag = useCallback((pointerId?: number, releaseCapture = true) => {
    const start = dragStartRef.current;
    if (!start || (pointerId !== undefined && start.pointerId !== pointerId)) return;
    dragStartRef.current = undefined;
    if (releaseCapture && start.captureTarget.hasPointerCapture?.(start.pointerId)) {
      start.captureTarget.releasePointerCapture(start.pointerId);
    }
    setIsDragging(false);
  }, []);

  const keepInViewport = useCallback(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const rect = dialog.getBoundingClientRect();
    const correctionX =
      rect.left < VIEWPORT_MARGIN
        ? VIEWPORT_MARGIN - rect.left
        : rect.right > window.innerWidth - VIEWPORT_MARGIN
          ? window.innerWidth - VIEWPORT_MARGIN - rect.right
          : 0;
    const correctionY =
      rect.top < VIEWPORT_MARGIN
        ? VIEWPORT_MARGIN - rect.top
        : rect.bottom > window.innerHeight - VIEWPORT_MARGIN
          ? window.innerHeight - VIEWPORT_MARGIN - rect.bottom
          : 0;
    if (correctionX === 0 && correctionY === 0) return;
    setPosition(current => ({ x: current.x + correctionX, y: current.y + correctionY }));
  }, [dialogRef]);

  useEffect(() => {
    clearDrag();
    setPosition({ x: 0, y: 0 });
  }, [clearDrag, resetKey]);

  useEffect(() => {
    const handleResize = () => {
      clearDrag();
      keepInViewport();
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [clearDrag, keepInViewport]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog || typeof ResizeObserver === 'undefined') return;
    let frameId: number | undefined;
    const observer = new ResizeObserver(() => {
      if (frameId !== undefined) window.cancelAnimationFrame(frameId);
      frameId = window.requestAnimationFrame(() => {
        frameId = undefined;
        clearDrag();
        keepInViewport();
      });
    });
    observer.observe(dialog);
    return () => {
      observer.disconnect();
      if (frameId !== undefined) window.cancelAnimationFrame(frameId);
      clearDrag();
    };
  }, [clearDrag, dialogRef, keepInViewport, resetKey]);

  const onPointerDown = useCallback<React.PointerEventHandler<HTMLDivElement>>(
    event => {
      if (event.button !== 0) return;
      if ((event.target as HTMLElement).closest(INTERACTIVE_SELECTOR)) return;
      const dialog = dialogRef.current;
      if (!dialog) return;
      dragStartRef.current = {
        pointerId: event.pointerId,
        clientX: event.clientX,
        clientY: event.clientY,
        x: position.x,
        y: position.y,
        rect: dialog.getBoundingClientRect(),
        captureTarget: event.currentTarget,
      };
      event.currentTarget.setPointerCapture?.(event.pointerId);
      event.preventDefault();
      setIsDragging(true);
    },
    [dialogRef, position.x, position.y],
  );

  const onPointerMove = useCallback<React.PointerEventHandler<HTMLDivElement>>(event => {
    const start = dragStartRef.current;
    if (!start || start.pointerId !== event.pointerId) return;
    const minimumX = VIEWPORT_MARGIN - start.rect.left;
    const maximumX = window.innerWidth - VIEWPORT_MARGIN - start.rect.right;
    const minimumY = VIEWPORT_MARGIN - start.rect.top;
    const maximumY = window.innerHeight - VIEWPORT_MARGIN - start.rect.bottom;
    setPosition({
      x: start.x + clamp(event.clientX - start.clientX, minimumX, maximumX),
      y: start.y + clamp(event.clientY - start.clientY, minimumY, maximumY),
    });
  }, []);

  const stopDragging = useCallback<React.PointerEventHandler<HTMLDivElement>>(event => {
    clearDrag(event.pointerId);
  }, [clearDrag]);

  const handleLostPointerCapture = useCallback<React.PointerEventHandler<HTMLDivElement>>(
    event => clearDrag(event.pointerId, false),
    [clearDrag],
  );

  return {
    dialogStyle: {
      position: 'relative',
      left: `${position.x}px`,
      top: `${position.y}px`,
      willChange: isDragging ? 'left, top' : undefined,
    } satisfies React.CSSProperties,
    dragHandleProps: {
      onPointerDown,
      onPointerMove,
      onPointerUp: stopDragging,
      onPointerCancel: stopDragging,
      onLostPointerCapture: handleLostPointerCapture,
      style: { touchAction: 'none' },
    } satisfies React.HTMLAttributes<HTMLDivElement>,
    isDragging,
  };
};
