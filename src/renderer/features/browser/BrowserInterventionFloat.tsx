import { ArrowsPointingOutIcon } from '@heroicons/react/24/outline';
import { type ReactNode, useEffect, useRef, useState } from 'react';

import { i18nService } from '@/services/i18n';

export function BrowserInterventionFloat({ children }: { children: ReactNode }) {
  const panel = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ x: 12, y: 12 });
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{ id: number; x: number; y: number; left: number; top: number } | null>(null);
  const clamp = (x: number, y: number) => {
    const element = panel.current;
    const host = element?.parentElement;
    return {
      x: Math.max(
        8,
        Math.min(x, Math.max(8, (host?.clientWidth ?? 0) - (element?.offsetWidth ?? 0) - 8)),
      ),
      y: Math.max(
        8,
        Math.min(y, Math.max(8, (host?.clientHeight ?? 0) - (element?.offsetHeight ?? 0) - 8)),
      ),
    };
  };
  useEffect(() => {
    if (typeof ResizeObserver === 'undefined' || !panel.current?.parentElement) return;
    const observer = new ResizeObserver(() => setPosition(current => clamp(current.x, current.y)));
    observer.observe(panel.current);
    observer.observe(panel.current.parentElement);
    return () => observer.disconnect();
  }, []);

  return (
    <>
      {dragging && <div className="pointer-events-auto absolute inset-0" aria-hidden="true" />}
      <div
        ref={panel}
        data-browser-intervention
        data-testid="browser-intervention-float"
        className="pointer-events-auto absolute flex w-80 max-w-[calc(100%-16px)] flex-col overflow-hidden rounded-xl border border-border bg-surface shadow-lg"
        style={{ left: position.x, top: position.y, maxHeight: 'calc(100% - 16px)' }}
      >
        <button
          type="button"
          className="flex shrink-0 touch-none items-center gap-2 border-b border-border px-3 py-2 text-left text-xs font-medium text-secondary cursor-move focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/40"
          aria-label={i18nService.t('browserInterventionMove')}
          title={i18nService.t('browserInterventionMove')}
          onPointerDown={event => {
            if (event.button !== 0 || drag.current) return;
            event.preventDefault();
            event.currentTarget.focus();
            drag.current = {
              id: event.pointerId,
              x: event.clientX,
              y: event.clientY,
              left: position.x,
              top: position.y,
            };
            event.currentTarget.setPointerCapture?.(event.pointerId);
            setDragging(true);
          }}
          onPointerMove={event => {
            const current = drag.current;
            if (!current || current.id !== event.pointerId) return;
            setPosition(
              clamp(
                current.left + event.clientX - current.x,
                current.top + event.clientY - current.y,
              ),
            );
          }}
          onPointerUp={event => {
            if (drag.current?.id !== event.pointerId) return;
            drag.current = null;
            setDragging(false);
            event.currentTarget.releasePointerCapture?.(event.pointerId);
          }}
          onPointerCancel={() => {
            drag.current = null;
            setDragging(false);
          }}
          onLostPointerCapture={() => {
            drag.current = null;
            setDragging(false);
          }}
          onKeyDown={event => {
            const delta = {
              ArrowLeft: [-16, 0],
              ArrowRight: [16, 0],
              ArrowUp: [0, -16],
              ArrowDown: [0, 16],
            }[event.key];
            if (!delta) return;
            event.preventDefault();
            setPosition(current => clamp(current.x + delta[0], current.y + delta[1]));
          }}
        >
          <ArrowsPointingOutIcon className="h-4 w-4" aria-hidden="true" />
          {i18nService.t('browserInterventionFloatTitle')}
        </button>
        <div className="flex min-h-0 flex-col gap-2 overflow-auto p-3 text-xs">{children}</div>
      </div>
    </>
  );
}
