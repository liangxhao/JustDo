import {
  ArrowDownTrayIcon,
  ArrowPathIcon,
  ChevronRightIcon,
  TrashIcon,
} from '@heroicons/react/24/outline';
import type {
  LocalSpeechModelKind,
  LocalSpeechModelStatus,
} from '@shared/speech/localSpeechModels';
import { useState } from 'react';

import {
  getLocalSpeechModelCatalog,
  type LocalSpeechModelCatalogEntry,
} from '@/features/speech/localSpeechModelCatalog';
import { useLocalSpeechModels } from '@/features/speech/useLocalSpeechModels';
import { i18nService } from '@/services/i18n';

import BuiltinSpeechModelDetails from './BuiltinSpeechModelDetails';

const LANGUAGE_KEYS: Record<string, string> = {
  zh: 'chinese',
  en: 'english',
  ja: 'japanese',
  ko: 'korean',
  yue: 'cantonese',
};

const modelSummary = (model: LocalSpeechModelCatalogEntry, status?: LocalSpeechModelStatus) => {
  const languages = model.languages
    .map(language => i18nService.t(LANGUAGE_KEYS[language] ?? language))
    .join(' / ');
  const voiceCount = model.voices.length;
  return [
    languages,
    voiceCount ? i18nService.t('speechModelVoiceCount').replace('{count}', String(voiceCount)) : '',
    status?.downloadBytes
      ? `${status.downloadBytesExact === false ? '≈' : ''}${(status.downloadBytes / 1024 / 1024).toFixed(1)} MiB`
      : '',
  ]
    .filter(Boolean)
    .join(' · ');
};

export default function BuiltinSpeechModelCatalog({ kind }: { kind: LocalSpeechModelKind }) {
  const models = useLocalSpeechModels();
  const [detailModel, setDetailModel] = useState<LocalSpeechModelCatalogEntry | null>(null);
  const canManage = models.supported && !models.loading && !models.error;
  const detailStatus = models.statuses.find(status => status.id === detailModel?.id);

  return (
    <div className="space-y-3">
      <h3 className="flex h-8 items-center text-sm font-medium text-foreground">
        {i18nService.t('builtinModelsProvider')}
      </h3>
      {!models.loading && !models.supported && (
        <p role="alert" className="text-xs text-secondary">
          {i18nService.t('voiceModelUnavailable')}
        </p>
      )}
      {models.error && (
        <div role="alert" className="flex items-center gap-2 text-xs text-red-500">
          <span>{models.error}</span>
          <button
            type="button"
            onClick={models.retry}
            title={i18nService.t('retry')}
            aria-label={i18nService.t('retry')}
            className="rounded-lg p-1.5 text-primary hover:bg-primary-muted"
          >
            <ArrowPathIcon className="h-4 w-4" />
          </button>
        </div>
      )}
      <div className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-surface">
        {getLocalSpeechModelCatalog(kind).map(model => {
          const status = models.statuses.find(
            candidate => candidate.kind === kind && candidate.id === model.id,
          );
          const downloading = status?.phase === 'downloading';
          const busy = downloading || status?.phase === 'installing';
          const ready = status?.phase === 'ready';
          const failed = status?.phase === 'error';
          const action = ready ? 'voiceModelRemove' : failed ? 'retry' : 'voiceModelDownload';
          const label = `${i18nService.t(action)}: ${model.name}`;
          const progress = Math.min(100, Math.max(0, status?.downloadPercent ?? 0));
          return (
            <article
              key={model.id}
              aria-label={model.name}
              className="group grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 pr-3 transition-colors hover:bg-surface-raised/50"
            >
              <button
                type="button"
                aria-label={model.name}
                onClick={() => setDetailModel(model)}
                className="flex min-w-0 items-center gap-3 px-4 py-3.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/40"
              >
                <span className="min-w-0 flex-1 space-y-1">
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="truncate text-sm font-medium text-foreground">
                      {model.name}
                    </span>
                    {model.quantization && (
                      <span className="shrink-0 rounded bg-surface-raised px-1.5 py-0.5 text-[10px] font-medium text-secondary">
                        {model.quantization}
                      </span>
                    )}
                  </span>
                  <span
                    className={`block truncate text-xs leading-5 ${failed ? 'text-red-500' : 'text-secondary'}`}
                    title={failed ? status?.error : undefined}
                  >
                    {failed
                      ? status?.error || i18nService.t('voiceModelDownloadFailed')
                      : modelSummary(model, status)}
                  </span>
                </span>
                <ChevronRightIcon
                  aria-hidden="true"
                  className="h-3.5 w-3.5 shrink-0 text-muted opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"
                />
              </button>
              {models.loading || busy ? (
                <span
                  role={downloading ? 'progressbar' : 'status'}
                  aria-label={i18nService.t(
                    downloading
                      ? 'voiceModelDownloading'
                      : models.loading
                        ? 'voiceModelChecking'
                        : 'speechModelInstalling',
                  )}
                  aria-valuemin={downloading ? 0 : undefined}
                  aria-valuemax={downloading ? 100 : undefined}
                  aria-valuenow={downloading ? progress : undefined}
                  className="flex items-center gap-1.5 px-1 text-xs tabular-nums text-secondary"
                >
                  <ArrowPathIcon className="h-4 w-4 animate-spin motion-reduce:animate-spin" />
                  {downloading ? `${progress}%` : null}
                </span>
              ) : (
                <button
                  type="button"
                  title={label}
                  aria-label={label}
                  disabled={!canManage || !status}
                  onClick={() =>
                    ready ? models.remove(kind, model.id) : models.install(kind, model.id)
                  }
                  className={`rounded-lg p-2 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 disabled:cursor-not-allowed disabled:opacity-40 ${ready ? 'text-muted hover:bg-red-500/10 hover:text-red-500' : 'text-primary hover:bg-primary-muted'}`}
                >
                  {ready ? (
                    <TrashIcon className="h-4 w-4" />
                  ) : failed ? (
                    <ArrowPathIcon className="h-4 w-4" />
                  ) : (
                    <ArrowDownTrayIcon className="h-4 w-4" />
                  )}
                </button>
              )}
            </article>
          );
        })}
      </div>
      {detailModel && (
        <BuiltinSpeechModelDetails
          model={detailModel}
          downloadBytes={detailStatus?.downloadBytes}
          downloadBytesExact={detailStatus?.downloadBytesExact}
          previewAvailable={canManage && detailStatus?.phase === 'ready'}
          onClose={() => setDetailModel(null)}
        />
      )}
    </div>
  );
}
