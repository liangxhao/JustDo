import { parseAskUserQuestions } from '@shared/openclaw/extensions';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type {
  CoworkInteractionRequest,
  CoworkInteractionResult,
} from '@/features/cowork/coworkTypes';

import CoworkInteractionModal from './CoworkInteractionModal';
import CoworkQuestionWizard from './CoworkQuestionWizard';

interface CoworkQuestionFloatingWindowProps {
  interaction: CoworkInteractionRequest;
  isVisible: boolean;
  onRespond: (result: CoworkInteractionResult) => Promise<boolean>;
}

type WindowOffset = {
  x: number;
  y: number;
};

type DragState = {
  pointerId: number;
  startX: number;
  startY: number;
  origin: WindowOffset;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
};

const VIEWPORT_MARGIN_PX = 8;
const INTERACTIVE_SELECTOR = 'button, input, textarea, select, a, [role="button"]';

export const hasMultipleAskUserQuestions = (interaction: CoworkInteractionRequest): boolean => {
  const questions = parseAskUserQuestions(interaction.toolInput.questions);
  return (questions?.length ?? 0) > 1;
};

export const shouldShowCoworkQuestionWindow = (
  interactionSessionId: string,
  currentSessionId: string | null,
  isCoworkViewVisible: boolean,
): boolean => isCoworkViewVisible && interactionSessionId === currentSessionId;

export const clampQuestionWindowOffset = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

export const resolveQuestionWindowOffsetCorrection = (
  rect: Pick<DOMRect, 'bottom' | 'left' | 'right' | 'top'>,
  viewport: { height: number; width: number },
  margin = VIEWPORT_MARGIN_PX,
): WindowOffset => ({
  x:
    rect.left < margin
      ? margin - rect.left
      : rect.right > viewport.width - margin
        ? viewport.width - margin - rect.right
        : 0,
  y:
    rect.top < margin
      ? margin - rect.top
      : rect.bottom > viewport.height - margin
        ? viewport.height - margin - rect.bottom
        : 0,
});

const CoworkQuestionFloatingWindow: React.FC<CoworkQuestionFloatingWindowProps> = ({
  interaction,
  isVisible,
  onRespond,
}) => {
  const [offset, setOffset] = useState<WindowOffset>({ x: 0, y: 0 });
  const panelRef = useRef<HTMLElement>(null);
  const dragStateRef = useRef<DragState | null>(null);
  const hasMultipleQuestions = useMemo(
    () => hasMultipleAskUserQuestions(interaction),
    [interaction],
  );

  const cancelActiveDrag = useCallback((pointerId?: number) => {
    const dragState = dragStateRef.current;
    if (!dragState || (pointerId !== undefined && dragState.pointerId !== pointerId)) return;
    dragStateRef.current = null;
    if (panelRef.current?.hasPointerCapture(dragState.pointerId)) {
      panelRef.current.releasePointerCapture(dragState.pointerId);
    }
  }, []);

  const keepPanelInViewport = useCallback(() => {
    if (!isVisible) return;
    const panel = panelRef.current;
    if (!panel) return;
    const correction = resolveQuestionWindowOffsetCorrection(panel.getBoundingClientRect(), {
      width: window.innerWidth,
      height: window.innerHeight,
    });
    if (correction.x === 0 && correction.y === 0) return;
    setOffset(current => ({
      x: current.x + correction.x,
      y: current.y + correction.y,
    }));
  }, [isVisible]);

  useEffect(() => {
    const handleResize = () => {
      cancelActiveDrag();
      setOffset({ x: 0, y: 0 });
    };
    window.addEventListener('resize', handleResize);
    return () => {
      window.removeEventListener('resize', handleResize);
      cancelActiveDrag();
    };
  }, [cancelActiveDrag]);

  useEffect(() => {
    if (isVisible) return;
    cancelActiveDrag();
    const activeElement = document.activeElement;
    if (activeElement instanceof HTMLElement && panelRef.current?.contains(activeElement)) {
      activeElement.blur();
    }
  }, [cancelActiveDrag, isVisible]);

  useEffect(() => {
    const panel = panelRef.current;
    if (!panel || typeof ResizeObserver === 'undefined') return;
    let frameId: number | null = null;
    const observer = new ResizeObserver(() => {
      if (frameId !== null) window.cancelAnimationFrame(frameId);
      frameId = window.requestAnimationFrame(() => {
        frameId = null;
        keepPanelInViewport();
      });
    });
    observer.observe(panel);
    return () => {
      observer.disconnect();
      if (frameId !== null) window.cancelAnimationFrame(frameId);
    };
  }, [keepPanelInViewport]);

  const handlePointerDown = (event: React.PointerEvent<HTMLElement>) => {
    if (event.button !== 0 || !panelRef.current) return;
    const target = event.target;
    if (!(target instanceof Element) || !target.closest('[data-question-drag-handle]')) return;
    if (target.closest(INTERACTIVE_SELECTOR)) return;

    event.preventDefault();
    const rect = panelRef.current.getBoundingClientRect();
    dragStateRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      origin: offset,
      minX: offset.x + VIEWPORT_MARGIN_PX - rect.left,
      maxX: offset.x + window.innerWidth - VIEWPORT_MARGIN_PX - rect.right,
      minY: offset.y + VIEWPORT_MARGIN_PX - rect.top,
      maxY: offset.y + window.innerHeight - VIEWPORT_MARGIN_PX - rect.bottom,
    };
    panelRef.current.setPointerCapture(event.pointerId);
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLElement>) => {
    const dragState = dragStateRef.current;
    if (!dragState || dragState.pointerId !== event.pointerId) return;

    setOffset({
      x: clampQuestionWindowOffset(
        dragState.origin.x + event.clientX - dragState.startX,
        dragState.minX,
        dragState.maxX,
      ),
      y: clampQuestionWindowOffset(
        dragState.origin.y + event.clientY - dragState.startY,
        dragState.minY,
        dragState.maxY,
      ),
    });
  };

  const endDrag = (event: React.PointerEvent<HTMLElement>) => {
    cancelActiveDrag(event.pointerId);
  };

  const handleLostPointerCapture = (event: React.PointerEvent<HTMLElement>) => {
    const dragState = dragStateRef.current;
    if (dragState?.pointerId === event.pointerId) dragStateRef.current = null;
  };

  return (
    <div
      className={`pointer-events-none fixed inset-0 z-50 items-center justify-center p-4 ${
        isVisible ? 'flex' : 'hidden'
      }`}
      data-cowork-question-floating-window
      aria-hidden={!isVisible}
    >
      <aside
        ref={panelRef}
        className={`pointer-events-auto max-h-[80vh] w-full overflow-hidden rounded-2xl bg-surface shadow-modal will-change-transform ${
          hasMultipleQuestions ? 'max-w-2xl' : 'max-w-lg'
        }`}
        style={{ transform: `translate3d(${offset.x}px, ${offset.y}px, 0)` }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onLostPointerCapture={handleLostPointerCapture}
      >
        {hasMultipleQuestions ? (
          <CoworkQuestionWizard
            interaction={interaction}
            onRespond={onRespond}
            presentation="floating"
            isActive={isVisible}
          />
        ) : (
          <CoworkInteractionModal
            interaction={interaction}
            onRespond={onRespond}
            presentation="floating"
            isActive={isVisible}
          />
        )}
      </aside>
    </div>
  );
};

export default CoworkQuestionFloatingWindow;
