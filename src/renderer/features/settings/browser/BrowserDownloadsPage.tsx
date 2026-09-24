import {
  ArrowDownTrayIcon,
  ArrowLeftIcon,
  DocumentIcon,
  FolderOpenIcon,
  MagnifyingGlassIcon,
  PlayIcon,
  TrashIcon,
} from '@heroicons/react/24/outline';
import type { BrowserDownloadEntry } from '@shared/browser/browser';
import { useCallback, useEffect, useRef, useState } from 'react';

import { i18nService } from '@/services/i18n';

const formatBytes = (value: number): string => {
  if (!Number.isFinite(value) || value <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  const amount = value / 1024 ** index;
  return `${amount >= 10 || index === 0 ? Math.round(amount) : amount.toFixed(1)} ${units[index]}`;
};

const displaySource = (url: string): string => {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
};

const stateLabel = (state: BrowserDownloadEntry['state']): string => {
  switch (state) {
    case 'queued':
      return i18nService.t('browserDownloadState_queued');
    case 'progressing':
      return i18nService.t('browserDownloadState_progressing');
    case 'completed':
      return i18nService.t('browserDownloadState_completed');
    case 'cancelled':
      return i18nService.t('browserDownloadState_cancelled');
    case 'interrupted':
      return i18nService.t('browserDownloadState_interrupted');
  }
};

export default function BrowserDownloadsPage({ onBack }: { onBack: () => void }) {
  const [entries, setEntries] = useState<BrowserDownloadEntry[]>([]);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const loadEpoch = useRef(0);

  const load = useCallback(async (search: string, silent = false) => {
    const epoch = ++loadEpoch.current;
    if (!silent) setLoading(true);
    const result = await window.electron.browser.listDownloads(search);
    if (epoch !== loadEpoch.current) return;
    if (result.success) {
      setEntries(result.entries ?? []);
      setError(null);
    } else {
      setError(result.error || i18nService.t('browserDownloadsLoadFailed'));
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => void load(query), 180);
    return () => clearTimeout(timer);
  }, [load, query]);

  useEffect(() => {
    if (!entries.some(entry => entry.state === 'queued' || entry.state === 'progressing')) return;
    const timer = setInterval(() => void load(query, true), 1_000);
    return () => clearInterval(timer);
  }, [entries, load, query]);

  const runEntryAction = async (
    action: (id: string) => Promise<{ success: boolean; error?: string }>,
    id: string,
  ) => {
    const result = await action(id);
    if (!result.success) setError(result.error || i18nService.t('browserDownloadsActionFailed'));
  };

  const remove = async (id: string) => {
    const result = await window.electron.browser.deleteDownloads([id]);
    if (!result.success) {
      setError(result.error || i18nService.t('browserDownloadsDeleteFailed'));
      return;
    }
    await load(query);
  };

  const clear = async () => {
    if (!confirmClear) {
      setConfirmClear(true);
      return;
    }
    const result = await window.electron.browser.clearDownloads();
    setConfirmClear(false);
    if (!result.success) {
      setError(result.error || i18nService.t('browserDownloadsDeleteFailed'));
      return;
    }
    await load(query);
  };

  return (
    <div className="mx-auto w-full max-w-5xl space-y-6 pb-8">
      <div className="flex items-center gap-2 text-sm text-secondary">
        <button
          type="button"
          className="rounded-md p-1.5 hover:bg-surface-raised"
          onClick={onBack}
          aria-label={i18nService.t('back')}
        >
          <ArrowLeftIcon className="h-4 w-4" />
        </button>
        <span>{i18nService.t('settings')}</span>
        <span>›</span>
        <button type="button" className="hover:text-foreground" onClick={onBack}>
          {i18nService.t('browserSettings')}
        </button>
        <span>›</span>
        <span className="text-foreground">{i18nService.t('browserDownloadsTitle')}</span>
      </div>

      <h2 className="text-center text-2xl font-semibold text-foreground">
        {i18nService.t('browserDownloadsTitle')}
      </h2>

      <div className="relative">
        <MagnifyingGlassIcon className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-secondary" />
        <input
          value={query}
          onChange={event => setQuery(event.target.value)}
          className="h-9 w-full rounded-full border border-border bg-surface-raised pl-9 pr-4 text-sm text-foreground outline-none focus:border-primary"
          placeholder={i18nService.t('browserDownloadsSearch')}
          aria-label={i18nService.t('browserDownloadsSearch')}
        />
      </div>

      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold text-foreground">
          {i18nService.t('browserDownloadsAll')}
        </h3>
        <button
          type="button"
          disabled={!entries.length}
          className={`rounded-lg px-3 py-1.5 text-xs disabled:cursor-not-allowed disabled:opacity-35 ${confirmClear ? 'bg-red-500 text-white' : 'bg-surface-raised hover:text-red-500'}`}
          onBlur={() => setConfirmClear(false)}
          onClick={() => void clear()}
        >
          {i18nService.t(confirmClear ? 'browserDownloadsConfirmClear' : 'browserDownloadsClear')}
        </button>
      </div>

      {error && (
        <div role="alert" className="rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-500">
          {error}
        </div>
      )}
      {loading ? (
        <div className="py-16 text-center text-sm text-secondary">{i18nService.t('loading')}</div>
      ) : !entries.length ? (
        <div className="flex min-h-40 flex-col items-center justify-center rounded-2xl border border-border bg-surface-raised/30 px-6 py-12 text-center">
          <ArrowDownTrayIcon className="h-8 w-8 text-secondary" />
          <div className="mt-3 text-base font-semibold text-foreground">
            {i18nService.t(query ? 'browserDownloadsNoResults' : 'browserDownloadsEmpty')}
          </div>
          {!query && (
            <p className="mt-1 text-sm text-secondary">
              {i18nService.t('browserDownloadsEmptyDescription')}
            </p>
          )}
        </div>
      ) : (
        <div className="overflow-hidden rounded-2xl border border-border bg-surface-raised/25">
          <div className="divide-y divide-border px-4">
            {entries.map(entry => {
              const inProgress = entry.state === 'queued' || entry.state === 'progressing';
              const percent =
                entry.totalBytes > 0
                  ? Math.min(100, Math.round((entry.receivedBytes / entry.totalBytes) * 100))
                  : 0;
              return (
                <div key={entry.id} className="group flex items-center gap-3 py-3.5">
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
                    <DocumentIcon className="h-5 w-5" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium text-foreground">
                      {entry.fileName}
                    </div>
                    <div className="mt-0.5 flex min-w-0 items-center gap-2 text-xs text-secondary">
                      <span className="truncate">{displaySource(entry.sourceUrl)}</span>
                      <span>·</span>
                      <span className="shrink-0">
                        {stateLabel(entry.state)}
                        {inProgress
                          ? ` · ${formatBytes(entry.receivedBytes)}${entry.totalBytes ? ` / ${formatBytes(entry.totalBytes)}` : ''}`
                          : ''}
                      </span>
                    </div>
                    {inProgress && (
                      <div className="mt-2 h-1 overflow-hidden rounded-full bg-border">
                        <div
                          className="h-full rounded-full bg-primary transition-[width]"
                          style={{ width: entry.totalBytes ? `${percent}%` : '18%' }}
                        />
                      </div>
                    )}
                  </div>
                  <time className="hidden shrink-0 text-xs tabular-nums text-secondary sm:block">
                    {new Intl.DateTimeFormat(
                      i18nService.getLanguage() === 'zh' ? 'zh-CN' : 'en-US',
                      { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' },
                    ).format(new Date(entry.updatedAt))}
                  </time>
                  {entry.state === 'completed' && (
                    <>
                      <button
                        type="button"
                        className="rounded-md p-1.5 text-secondary hover:bg-surface hover:text-primary"
                        title={i18nService.t('browserDownloadsOpen')}
                        aria-label={i18nService.t('browserDownloadsOpen')}
                        onClick={() =>
                          void runEntryAction(window.electron.browser.openDownload, entry.id)
                        }
                      >
                        <PlayIcon className="h-4 w-4" />
                      </button>
                      <button
                        type="button"
                        className="rounded-md p-1.5 text-secondary hover:bg-surface hover:text-primary"
                        title={i18nService.t('browserDownloadsReveal')}
                        aria-label={i18nService.t('browserDownloadsReveal')}
                        onClick={() =>
                          void runEntryAction(window.electron.browser.revealDownload, entry.id)
                        }
                      >
                        <FolderOpenIcon className="h-4 w-4" />
                      </button>
                    </>
                  )}
                  <button
                    type="button"
                    className="rounded-md p-1.5 text-secondary opacity-0 hover:bg-surface hover:text-red-500 group-hover:opacity-100 focus:opacity-100"
                    title={i18nService.t('browserDownloadsDeleteOne')}
                    aria-label={i18nService.t('browserDownloadsDeleteOne')}
                    onClick={() => void remove(entry.id)}
                  >
                    <TrashIcon className="h-4 w-4" />
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
