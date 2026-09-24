import {
  ArrowLeftIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  GlobeAltIcon,
  MagnifyingGlassIcon,
  TrashIcon,
} from '@heroicons/react/24/outline';
import type { BrowserHistoryEntry } from '@shared/browser/browser';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { i18nService } from '@/services/i18n';

export const browserHistoryDateKey = (timestamp: number): string => {
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return 'unknown';
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

const displayHost = (url: string): string => {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
};

export default function BrowserHistoryPage({ onBack }: { onBack: () => void }) {
  const [entries, setEntries] = useState<BrowserHistoryEntry[]>([]);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [confirmClear, setConfirmClear] = useState(false);
  const loadEpoch = useRef(0);

  const load = useCallback(async (search: string) => {
    const epoch = ++loadEpoch.current;
    setLoading(true);
    setError(null);
    try {
      const result = await window.electron.browser.listHistory(search);
      if (epoch !== loadEpoch.current) return;
      if (result.success) setEntries(result.entries ?? []);
      else setError(i18nService.t('browserHistoryLoadFailed'));
    } catch {
      if (epoch === loadEpoch.current) setError(i18nService.t('browserHistoryLoadFailed'));
    } finally {
      if (epoch === loadEpoch.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => void load(query), 180);
    return () => clearTimeout(timer);
  }, [load, query]);

  const groups = useMemo(() => {
    const result = new Map<string, BrowserHistoryEntry[]>();
    for (const entry of entries) {
      const key = browserHistoryDateKey(entry.lastVisitAt);
      result.set(key, [...(result.get(key) ?? []), entry]);
    }
    return [...result.entries()];
  }, [entries]);

  const remove = async (urls: string[]) => {
    const result = await window.electron.browser.deleteHistory(urls);
    if (!result.success) {
      setError(result.error || i18nService.t('browserHistoryDeleteFailed'));
      return;
    }
    setSelected(current => {
      const next = new Set(current);
      urls.forEach(url => next.delete(url));
      return next;
    });
    await load(query);
  };

  const clear = async () => {
    if (!confirmClear) {
      setConfirmClear(true);
      return;
    }
    const result = await window.electron.browser.clearHistory();
    setConfirmClear(false);
    if (!result.success) {
      setError(result.error || i18nService.t('browserHistoryDeleteFailed'));
      return;
    }
    setSelected(new Set());
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
        <span className="text-foreground">{i18nService.t('browserHistoryTitle')}</span>
      </div>

      <h2 className="text-center text-2xl font-semibold text-foreground">
        {i18nService.t('browserHistoryTitle')}
      </h2>

      <div className="relative">
        <MagnifyingGlassIcon className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-secondary" />
        <input
          value={query}
          onChange={event => setQuery(event.target.value)}
          className="h-9 w-full rounded-full border border-border bg-surface-raised pl-9 pr-4 text-sm text-foreground outline-none focus:border-primary"
          placeholder={i18nService.t('browserHistorySearch')}
          aria-label={i18nService.t('browserHistorySearch')}
        />
      </div>

      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold text-foreground">
          {i18nService.t('browserHistoryAll')}
        </h3>
        <div className="flex items-center gap-2">
          {selected.size > 0 && (
            <button
              type="button"
              className="rounded-lg bg-surface-raised px-3 py-1.5 text-xs hover:text-primary"
              onClick={() => void remove([...selected])}
            >
              {i18nService
                .t('browserHistoryDeleteSelected')
                .replace('{count}', String(selected.size))}
            </button>
          )}
          <button
            type="button"
            className={`rounded-lg px-3 py-1.5 text-xs ${confirmClear ? 'bg-red-500 text-white' : 'bg-surface-raised hover:text-red-500'}`}
            onBlur={() => setConfirmClear(false)}
            onClick={() => void clear()}
          >
            {i18nService.t(confirmClear ? 'browserHistoryConfirmClear' : 'browserHistoryClear')}
          </button>
        </div>
      </div>

      {error && (
        <div role="alert" className="rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-500">
          {error}
        </div>
      )}
      {loading ? (
        <div className="py-16 text-center text-sm text-secondary">{i18nService.t('loading')}</div>
      ) : !groups.length ? (
        <div className="rounded-xl border border-border bg-surface-raised/30 py-16 text-center text-sm text-secondary">
          {i18nService.t(query ? 'browserHistoryNoResults' : 'browserHistoryEmpty')}
        </div>
      ) : (
        <div className="space-y-2">
          {groups.map(([day, items]) => {
            const isCollapsed = collapsed.has(day);
            const label =
              day === 'unknown'
                ? i18nService.t('browserHistoryUnknownDate')
                : new Intl.DateTimeFormat(i18nService.getLanguage() === 'zh' ? 'zh-CN' : 'en-US', {
                    dateStyle: 'long',
                  }).format(new Date(`${day}T12:00:00`));
            return (
              <section
                key={day}
                className="overflow-hidden rounded-xl border border-border bg-surface-raised/25"
              >
                <button
                  type="button"
                  className="flex w-full items-center justify-between px-4 py-3 text-sm font-semibold text-foreground"
                  onClick={() =>
                    setCollapsed(current => {
                      const next = new Set(current);
                      if (next.has(day)) next.delete(day);
                      else next.add(day);
                      return next;
                    })
                  }
                  aria-expanded={!isCollapsed}
                >
                  {label}
                  {isCollapsed ? (
                    <ChevronDownIcon className="h-4 w-4 text-secondary" />
                  ) : (
                    <ChevronUpIcon className="h-4 w-4 text-secondary" />
                  )}
                </button>
                {!isCollapsed && (
                  <div className="divide-y divide-border border-t border-border px-4">
                    {items.map(entry => (
                      <div key={entry.url} className="group flex items-center gap-3 py-3">
                        <input
                          type="checkbox"
                          checked={selected.has(entry.url)}
                          aria-label={i18nService
                            .t('browserHistorySelect')
                            .replace('{title}', entry.title || entry.url)}
                          className="h-4 w-4 rounded border-border accent-primary"
                          onChange={event =>
                            setSelected(current => {
                              const next = new Set(current);
                              if (event.target.checked) next.add(entry.url);
                              else next.delete(entry.url);
                              return next;
                            })
                          }
                        />
                        <GlobeAltIcon className="h-5 w-5 shrink-0 text-secondary" />
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-sm text-foreground">
                            {entry.title || entry.url}
                          </div>
                          <div className="truncate text-xs text-secondary">
                            {displayHost(entry.url)}
                          </div>
                        </div>
                        <time className="text-xs tabular-nums text-secondary">
                          {new Intl.DateTimeFormat(
                            i18nService.getLanguage() === 'zh' ? 'zh-CN' : 'en-US',
                            { hour: '2-digit', minute: '2-digit' },
                          ).format(new Date(entry.lastVisitAt))}
                        </time>
                        <button
                          type="button"
                          className="rounded-md p-1.5 text-secondary opacity-0 hover:bg-surface hover:text-red-500 group-hover:opacity-100 focus:opacity-100"
                          aria-label={i18nService.t('browserHistoryDeleteOne')}
                          onClick={() => void remove([entry.url])}
                        >
                          <TrashIcon className="h-4 w-4" />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}
