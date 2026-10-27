import { XMarkIcon } from '@heroicons/react/24/outline';
import { useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';

import type { LocalSpeechModelCatalogEntry } from '@/features/speech/localSpeechModelCatalog';
import { i18nService } from '@/services/i18n';
import Modal from '@/shared/components/ui/Modal';
import { useOwnerDocument } from '@/shared/dom/ownerDocument';

import BuiltinSpeechVoiceList from './BuiltinSpeechVoiceList';

const LANGUAGE_LABEL_KEYS: Record<string, string> = {
  zh: 'chinese',
  en: 'english',
  ja: 'japanese',
  ko: 'korean',
  yue: 'cantonese',
};

export default function BuiltinSpeechModelDetails({
  model,
  downloadBytes,
  downloadBytesExact = true,
  previewAvailable = false,
  onClose,
}: {
  model: LocalSpeechModelCatalogEntry;
  downloadBytes?: number;
  downloadBytesExact?: boolean;
  previewAvailable?: boolean;
  onClose: () => void;
}) {
  const ownerDocument = useOwnerDocument();
  const dialog = useRef<HTMLDivElement>(null);
  const titleId = useId();

  useEffect(() => {
    const previous = ownerDocument.activeElement as HTMLElement | null;
    dialog.current?.focus();
    return () => {
      if (previous?.isConnected) previous.focus();
    };
  }, [ownerDocument]);

  return createPortal(
    <Modal
      onClose={onClose}
      className="mx-4 w-full max-w-[680px] overflow-hidden rounded-2xl border border-border bg-surface text-foreground shadow-2xl"
    >
      <div
        ref={dialog}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="flex max-h-[calc(100dvh-2rem)] flex-col outline-none"
        onKeyDown={event => {
          if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            onClose();
          } else if (event.key === 'Tab') {
            const fields = Array.from(
              dialog.current?.querySelectorAll<HTMLElement>(
                'button:not(:disabled), input:not(:disabled), select:not(:disabled), [href], [tabindex]',
              ) ?? [],
            ).filter(field => field.tabIndex >= 0);
            if (!fields.length) {
              event.preventDefault();
              dialog.current?.focus();
              return;
            }
            const current = fields.indexOf(ownerDocument.activeElement as HTMLElement);
            const next = event.shiftKey
              ? current <= 0
                ? fields.length - 1
                : current - 1
              : current < 0 || current === fields.length - 1
                ? 0
                : current + 1;
            event.preventDefault();
            fields[next]?.focus();
          }
        }}
      >
        <header className="flex shrink-0 items-start gap-3 border-b border-border px-5 py-4">
          <div className="min-w-0 flex-1">
            <p className="text-xs text-secondary">{i18nService.t('speechModelDetails')}</p>
            <h2 id={titleId} className="mt-1 text-base font-semibold">
              {model.name}
            </h2>
          </div>
          <button
            type="button"
            aria-label={i18nService.t('close')}
            title={i18nService.t('close')}
            onClick={onClose}
            className="rounded-lg p-1.5 text-secondary hover:bg-surface-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30"
          >
            <XMarkIcon className="h-4 w-4" aria-hidden="true" />
          </button>
        </header>
        <div className="min-h-0 space-y-5 overflow-y-auto px-5 py-4">
          <p className="text-sm leading-6 text-secondary">{i18nService.t(model.descriptionKey)}</p>
          <dl className="grid grid-cols-1 gap-x-6 gap-y-3 text-xs sm:grid-cols-2">
            <div>
              <dt className="text-secondary">{i18nService.t('speechModelLanguages')}</dt>
              <dd className="mt-1 text-foreground">
                {model.languages
                  .map(language =>
                    LANGUAGE_LABEL_KEYS[language]
                      ? i18nService.t(LANGUAGE_LABEL_KEYS[language])
                      : language,
                  )
                  .join(' · ')}
              </dd>
            </div>
            <div>
              <dt className="text-secondary">{i18nService.t('speechModelEngine')}</dt>
              <dd className="mt-1 text-foreground">
                {[model.engine, model.quantization].filter(Boolean).join(' · ')}
              </dd>
            </div>
            <div className="min-w-0 sm:col-span-2">
              <dt className="text-secondary">{i18nService.t('modelId')}</dt>
              <dd className="mt-1 break-all font-mono text-[11px] text-foreground">{model.id}</dd>
            </div>
            {typeof downloadBytes === 'number' && downloadBytes > 0 && (
              <div>
                <dt className="text-secondary">{i18nService.t('speechModelDownloadSize')}</dt>
                <dd className="mt-1 text-foreground">
                  {`${downloadBytesExact ? '' : '≈'}${(downloadBytes / 1024 / 1024).toFixed(1)} MiB`}
                </dd>
              </div>
            )}
          </dl>
          {model.voices.length > 0 && (
            <BuiltinSpeechVoiceList
              key={model.id}
              model={model}
              previewAvailable={previewAvailable}
            />
          )}
        </div>
      </div>
    </Modal>,
    ownerDocument.body,
  );
}
