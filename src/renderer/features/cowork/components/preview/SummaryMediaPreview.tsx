import '@/libs/openclaw-chat/components/message/message-media';

import { XMarkIcon } from '@heroicons/react/24/outline';
import { useEffect, useRef } from 'react';

import type { MessageMedia } from '@/libs/openclaw-chat/components/message/message-media';
import { i18nService } from '@/services/i18n';
import Modal from '@/shared/components/ui/Modal';

import { useDialogFocusTrap } from '../shared/useDialogFocusTrap';

export interface SummaryMediaPreviewSource {
  url: string;
  label: string;
  kind: 'audio' | 'video';
  sessionKey: string;
}

/** Reuses the same session-bound streaming reader as the inline delivery. */
export function SummaryMediaPreview({
  source,
  onClose,
}: {
  source: SummaryMediaPreviewSource;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDivElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  const container = useRef<HTMLDivElement>(null);
  useDialogFocusTrap(dialog, close, source.url);
  useEffect(() => {
    const root = container.current;
    if (!root) return;
    const reader = root.ownerDocument.createElement('justdo-message-media') as MessageMedia;
    reader.src = source.url;
    reader.kind = source.kind;
    reader.label = source.label;
    reader.sessionKey = source.sessionKey;
    root.append(reader);
    return () => reader.remove();
  }, [source]);
  return (
    <Modal
      onClose={onClose}
      className="mx-4 w-full max-w-2xl rounded-2xl border border-border bg-surface p-5 text-foreground shadow-xl"
    >
      <div
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-label={source.label}
        onKeyDown={event => {
          if (event.key === 'Escape') {
            event.stopPropagation();
            onClose();
          }
        }}
      >
        <div className="mb-4 flex items-center justify-between gap-4">
          <h2 className="min-w-0 truncate text-base font-semibold">{source.label}</h2>
          <button
            ref={close}
            type="button"
            onClick={onClose}
            aria-label={i18nService.t('close')}
            className="shrink-0 rounded-lg p-2 text-secondary hover:bg-surface-raised"
          >
            <XMarkIcon className="h-5 w-5" />
          </button>
        </div>
        <div
          ref={container}
          className="[&_figure]:m-0 [&_figcaption]:hidden [&_audio]:w-full [&_video]:max-h-[65vh] [&_video]:w-full"
        />
      </div>
    </Modal>
  );
}
