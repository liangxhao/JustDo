import { AdjustmentsHorizontalIcon, ArrowUpIcon, XMarkIcon } from '@heroicons/react/24/outline';
import type { BrowserInspectedElement } from '@shared/browser/browser';
import type { CSSProperties } from 'react';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import BrowserElementInspectorCard from '@/features/browser/annotation/BrowserElementInspectorCard';
import { LocalSpeechInputButton } from '@/features/cowork/components/composer/LocalSpeechInputButton';
import { i18nService } from '@/services/i18n';

export default function BrowserAnnotationComposer({
  element,
  value,
  disabled,
  position,
  placement,
  anchorOffset,
  onChange,
  onSubmit,
  onDismiss,
  onEscape = onDismiss,
}: {
  element: BrowserInspectedElement | null;
  value: string;
  disabled: boolean;
  position: CSSProperties;
  placement: 'above' | 'below';
  anchorOffset: number;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onDismiss: () => void;
  onEscape?: () => void;
}) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [detailsPosition, setDetailsPosition] = useState<CSSProperties>({});
  const inputRef = useRef<HTMLInputElement>(null);
  const composerRef = useRef<HTMLDivElement>(null);
  const canSubmit = value.trim().length > 0 && !disabled;

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!detailsOpen) return;
    const updatePosition = () => {
      const bounds = composerRef.current?.getBoundingClientRect();
      if (!bounds) return;
      const cardHeight = Math.min(360, window.innerHeight - 16);
      const top =
        bounds.bottom + cardHeight + 8 <= window.innerHeight
          ? bounds.bottom + 8
          : Math.max(8, bounds.top - cardHeight - 8);
      setDetailsPosition({
        left: Math.max(8, Math.min(bounds.left, window.innerWidth - 348)),
        top,
      });
    };
    updatePosition();
    window.addEventListener('resize', updatePosition);
    const observer =
      typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(updatePosition);
    if (composerRef.current) observer?.observe(composerRef.current);
    return () => {
      window.removeEventListener('resize', updatePosition);
      observer?.disconnect();
    };
  }, [detailsOpen, position.left, position.top, position.width]);

  return (
    <div
      data-testid="browser-annotation-composer"
      className="pointer-events-none absolute z-40"
      style={position}
    >
      <div className="pointer-events-auto relative w-full">
        {detailsOpen &&
          element &&
          createPortal(
            <div
              className="fixed z-[130] w-[340px] max-w-[calc(100vw-16px)]"
              style={detailsPosition}
            >
              <BrowserElementInspectorCard element={element} locked embedded style={{}} />
            </div>,
            document.body,
          )}

        <span
          className={`pointer-events-none absolute z-10 h-3 w-3 rotate-45 border-white/10 bg-neutral-900/95 ${
            placement === 'below' ? '-top-1.5 border-l border-t' : '-bottom-1.5 border-b border-r'
          }`}
          style={{ left: anchorOffset - 6 }}
        />

        <div
          ref={composerRef}
          className="flex min-h-11 items-center gap-1.5 rounded-2xl border border-white/10 bg-neutral-900/95 px-1.5 py-1.5 text-white shadow-2xl backdrop-blur-xl"
        >
          <button
            type="button"
            onClick={() => element && setDetailsOpen(open => !open)}
            disabled={!element}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-white/55 transition-colors hover:bg-white/10 hover:text-white disabled:cursor-default disabled:opacity-70"
            aria-label={i18nService.t('browserAnnotationElementDetails')}
            aria-expanded={detailsOpen}
          >
            <AdjustmentsHorizontalIcon className="h-[18px] w-[18px]" strokeWidth={1.7} />
          </button>
          <input
            ref={inputRef}
            value={value}
            onChange={event => onChange(event.target.value)}
            onKeyDown={event => {
              if (event.key === 'Escape') {
                event.preventDefault();
                onEscape();
              } else if (event.key === 'Enter' && !event.nativeEvent.isComposing && canSubmit) {
                event.preventDefault();
                onSubmit();
              }
            }}
            maxLength={2_000}
            className="h-8 min-w-20 flex-1 bg-transparent px-1 text-sm text-white outline-none placeholder:text-white/35"
            placeholder={i18nService.t('browserAnnotationCommentPlaceholder')}
            aria-label={i18nService.t('browserAnnotationCommentPlaceholder')}
            disabled={disabled}
          />
          <LocalSpeechInputButton
            disabled={disabled}
            onTranscript={transcript => {
              const clean = transcript.replace(/\s+/g, ' ').trim();
              if (!clean) return;
              onChange(`${value.trimEnd()}${value.trim() ? ' ' : ''}${clean}`.slice(0, 2_000));
              requestAnimationFrame(() => inputRef.current?.focus());
            }}
          />
          <button
            type="button"
            onClick={onSubmit}
            disabled={!canSubmit}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-white text-neutral-900 transition-transform hover:scale-105 disabled:scale-100 disabled:bg-white/15 disabled:text-white/35"
            aria-label={i18nService.t('browserAnnotationCommentSubmit')}
          >
            {disabled ? (
              <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />
            ) : (
              <ArrowUpIcon className="h-4 w-4" />
            )}
          </button>
          <button
            type="button"
            onClick={onDismiss}
            disabled={disabled}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-white/45 transition-colors hover:bg-white/10 hover:text-white"
            aria-label={i18nService.t('browserAnnotationCommentDismiss')}
          >
            <XMarkIcon className="h-4 w-4" />
          </button>
        </div>
      </div>
    </div>
  );
}
