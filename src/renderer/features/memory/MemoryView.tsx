import {
  ArrowPathIcon,
  BookOpenIcon,
  CalendarDaysIcon,
  CheckCircleIcon,
  CircleStackIcon,
  ClockIcon,
  DocumentTextIcon,
  ExclamationTriangleIcon,
  FolderOpenIcon,
  MagnifyingGlassIcon,
  SparklesIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline';
import type {
  MemoryDocument,
  MemoryDocumentKind,
  MemoryDocumentSummary,
  MemoryOverview,
  MemorySearchHit,
} from '@shared/openclaw/memory';
import React, { useCallback, useEffect, useMemo, useState } from 'react';

import { toSanitizedMarkdownHtml } from '@/libs/openclaw-chat/components/markdown';
import { i18nService } from '@/services/i18n';

type MemoryTab = 'overview' | 'search' | 'timeline' | 'files';

const MEMORY_TABS: MemoryTab[] = ['overview', 'search', 'timeline', 'files'];

const kindOrder: MemoryDocumentKind[] = ['longTerm', 'daily', 'dream', 'dreaming'];

const formatBytes = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
};

const MemoryView: React.FC = () => {
  const [activeTab, setActiveTab] = useState<MemoryTab>('overview');
  const [overview, setOverview] = useState<MemoryOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedDocument, setSelectedDocument] = useState<MemoryDocument | null>(null);
  const [documentLoading, setDocumentLoading] = useState(false);
  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [searchHits, setSearchHits] = useState<MemorySearchHit[]>([]);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [hasSearched, setHasSearched] = useState(false);
  const [rebuilding, setRebuilding] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const locale = i18nService.getLanguage() === 'zh' ? 'zh-CN' : 'en-US';

  const loadOverview = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await window.electron.openclaw.memory.getOverview();
      if (!result.success || !result.overview) {
        setError(result.error || i18nService.t('memoryLoadFailed'));
        return;
      }
      setOverview(result.overview);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : i18nService.t('memoryLoadFailed'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadOverview();
  }, [loadOverview]);

  const openDocument = useCallback(async (relativePath: string) => {
    setDocumentLoading(true);
    setError(null);
    try {
      const result = await window.electron.openclaw.memory.getDocument(relativePath);
      if (!result.success || !result.document) {
        setError(result.error || i18nService.t('memoryDocumentLoadFailed'));
        return;
      }
      setSelectedDocument(result.document);
    } catch (loadError) {
      setError(
        loadError instanceof Error ? loadError.message : i18nService.t('memoryDocumentLoadFailed'),
      );
    } finally {
      setDocumentLoading(false);
    }
  }, []);

  const handleSearch = async (event?: React.FormEvent) => {
    event?.preventDefault();
    const normalizedQuery = query.trim();
    if (!normalizedQuery || searching || rebuilding) return;
    setSearching(true);
    setHasSearched(true);
    setSearchError(null);
    try {
      const result = await window.electron.openclaw.memory.search(normalizedQuery);
      if (!result.success) {
        setSearchHits([]);
        setSearchError(result.error || i18nService.t('memorySearchFailed'));
        return;
      }
      setSearchHits(result.hits || []);
    } catch (searchFailure) {
      setSearchHits([]);
      setSearchError(
        searchFailure instanceof Error
          ? searchFailure.message
          : i18nService.t('memorySearchFailed'),
      );
    } finally {
      setSearching(false);
    }
  };

  const handleRebuild = async () => {
    if (rebuilding || searching) return;
    setRebuilding(true);
    setNotice(null);
    setError(null);
    try {
      const result = await window.electron.openclaw.memory.rebuildIndex();
      if (!result.success) {
        setError(result.error || i18nService.t('memoryRebuildFailed'));
        return;
      }
      setNotice(i18nService.t('memoryRebuildSucceeded'));
      await loadOverview();
    } catch (rebuildError) {
      setError(
        rebuildError instanceof Error ? rebuildError.message : i18nService.t('memoryRebuildFailed'),
      );
    } finally {
      setRebuilding(false);
    }
  };

  const tabLabels: Record<MemoryTab, string> = {
    overview: i18nService.t('memoryOverviewTab'),
    search: i18nService.t('memorySearchTab'),
    timeline: i18nService.t('memoryTimelineTab'),
    files: i18nService.t('memoryFilesTab'),
  };

  const kindLabels: Record<MemoryDocumentKind, string> = {
    longTerm: i18nService.t('memoryKindLongTerm'),
    daily: i18nService.t('memoryKindDaily'),
    dream: i18nService.t('memoryKindDream'),
    dreaming: i18nService.t('memoryKindDreaming'),
  };

  const dateFormatter = useMemo(
    () => new Intl.DateTimeFormat(locale, { year: 'numeric', month: 'short', day: 'numeric' }),
    [locale],
  );
  const dateTimeFormatter = useMemo(
    () =>
      new Intl.DateTimeFormat(locale, {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      }),
    [locale],
  );

  const longTermMemory = overview?.documents.find(document => document.kind === 'longTerm');
  const recentDocuments =
    overview?.documents.filter(document => document.kind !== 'longTerm').slice(0, 5) || [];
  const timelineGroups = useMemo(() => {
    const groups = new Map<string, MemoryDocumentSummary[]>();
    for (const document of overview?.documents || []) {
      if (document.kind === 'longTerm') continue;
      const sourceDate = document.date
        ? new Date(`${document.date}T00:00:00`)
        : new Date(document.modifiedAt);
      const key = new Intl.DateTimeFormat(locale, { year: 'numeric', month: 'long' }).format(
        sourceDate,
      );
      groups.set(key, [...(groups.get(key) || []), document]);
    }
    return Array.from(groups.entries());
  }, [locale, overview]);

  const markdownHtml = useMemo(
    () => toSanitizedMarkdownHtml(selectedDocument?.content || ''),
    [selectedDocument],
  );

  const documentCard = (document: MemoryDocumentSummary, compact = false) => (
    <button
      key={document.id}
      type="button"
      onClick={() => void openDocument(document.relativePath)}
      className="group w-full rounded-xl border border-border bg-surface px-4 py-3 text-left transition-all hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-md"
    >
      <div className="flex items-start gap-3">
        <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
          {document.kind === 'dream' || document.kind === 'dreaming' ? (
            <SparklesIcon className="h-[18px] w-[18px]" />
          ) : (
            <DocumentTextIcon className="h-[18px] w-[18px]" />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-3">
            <h3 className="truncate text-sm font-semibold text-foreground group-hover:text-primary">
              {document.title}
            </h3>
            <span className="shrink-0 rounded-full bg-surface-raised px-2 py-0.5 text-[10px] font-medium text-muted">
              {kindLabels[document.kind]}
            </span>
          </div>
          {!compact && document.preview && (
            <p className="mt-1.5 line-clamp-2 text-xs leading-5 text-secondary">
              {document.preview}
            </p>
          )}
          <div className="mt-2 flex items-center gap-2 text-[11px] text-muted">
            <span>{document.date || dateFormatter.format(document.modifiedAt)}</span>
            <span>·</span>
            <span className="truncate">{document.relativePath}</span>
          </div>
        </div>
      </div>
    </button>
  );

  const renderEmpty = (title: string, description: string, compact = false) => (
    <div
      className={`flex ${compact ? 'min-h-44' : 'min-h-52'} flex-col items-center justify-center rounded-2xl border border-dashed border-border bg-surface/40 px-6 text-center`}
    >
      <BookOpenIcon className="mb-3 h-9 w-9 text-muted" />
      <h3 className="text-sm font-semibold text-foreground">{title}</h3>
      <p className="mt-1 max-w-md text-xs leading-5 text-secondary">{description}</p>
    </div>
  );

  const renderOverview = () => {
    if (!overview) return null;
    const stats = [
      {
        label: i18nService.t('memoryStatDocuments'),
        value: overview.counts.total,
        detail: i18nService.t('memoryStatDocumentsDetail'),
        icon: DocumentTextIcon,
      },
      {
        label: i18nService.t('memoryStatChunks'),
        value: overview.index.chunks,
        detail: i18nService.t('memoryStatChunksDetail'),
        icon: CircleStackIcon,
      },
      {
        label: i18nService.t('memoryStatDaily'),
        value: overview.counts.daily,
        detail: i18nService.t('memoryStatDailyDetail'),
        icon: CalendarDaysIcon,
      },
      {
        label: i18nService.t('memoryStatLongTerm'),
        value: overview.counts.longTerm,
        detail: i18nService.t('memoryStatLongTermDetail'),
        icon: BookOpenIcon,
      },
    ];
    const indexStatusDetail = overview.index.available
      ? overview.index.dirty
        ? i18nService.t('memoryIndexNeedsRefresh')
        : i18nService.t('memoryIndexReady')
      : i18nService.t('memoryIndexUnavailable');
    return (
      <div className="space-y-5">
        <section className="grid grid-cols-2 gap-2.5 md:grid-cols-5">
          {stats.map(stat => (
            <div
              key={stat.label}
              className="flex min-w-0 items-center gap-3 rounded-xl border border-border bg-surface px-3 py-2.5 shadow-sm"
            >
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/[0.08] text-primary">
                <stat.icon className="h-4 w-4" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2">
                  <span className="text-xl font-semibold leading-none tracking-tight text-foreground">
                    {stat.value}
                  </span>
                  <span className="truncate text-xs font-medium text-secondary">{stat.label}</span>
                </div>
                <p className="mt-1 truncate text-[10px] leading-3 text-muted" title={stat.detail}>
                  {stat.detail}
                </p>
              </div>
            </div>
          ))}
          <div className="flex min-w-0 items-center gap-3 rounded-xl border border-border bg-surface px-3 py-2.5 shadow-sm">
            <div
              className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${
                overview.index.available
                  ? 'bg-emerald-500/10 text-emerald-500'
                  : 'bg-amber-500/10 text-amber-500'
              }`}
            >
              {overview.index.available ? (
                <CheckCircleIcon className="h-4 w-4" />
              ) : (
                <ExclamationTriangleIcon className="h-4 w-4" />
              )}
            </div>
            <div className="min-w-0 flex-1">
              <h2 className="truncate text-xs font-semibold text-foreground">
                {i18nService.t('memoryIndexHealth')}
              </h2>
              <p
                className="mt-1 truncate text-[10px] leading-3 text-muted"
                title={indexStatusDetail}
              >
                {indexStatusDetail}
              </p>
            </div>
          </div>
        </section>

        <section>
          <div>
            <div className="mb-3 flex items-center justify-between">
              <div>
                <h2 className="text-base font-semibold text-foreground">
                  {i18nService.t('memoryLongTermTitle')}
                </h2>
                <p className="mt-0.5 text-xs text-secondary">
                  {i18nService.t('memoryLongTermDescription')}
                </p>
              </div>
            </div>
            {longTermMemory
              ? documentCard(longTermMemory)
              : renderEmpty(
                  i18nService.t('memoryLongTermEmpty'),
                  i18nService.t('memoryLongTermEmptyDescription'),
                  true,
                )}
          </div>
        </section>

        <section>
          <div className="mb-3 flex items-end justify-between">
            <div>
              <h2 className="text-base font-semibold text-foreground">
                {i18nService.t('memoryRecentTitle')}
              </h2>
              <p className="mt-0.5 text-xs text-secondary">
                {i18nService.t('memoryRecentDescription')}
              </p>
            </div>
            {recentDocuments.length > 0 && (
              <button
                type="button"
                onClick={() => setActiveTab('timeline')}
                className="text-xs font-medium text-primary hover:underline"
              >
                {i18nService.t('memoryViewAll')}
              </button>
            )}
          </div>
          {recentDocuments.length > 0 ? (
            <div className="grid gap-3 lg:grid-cols-2">
              {recentDocuments.map(item => documentCard(item))}
            </div>
          ) : (
            renderEmpty(i18nService.t('memoryEmpty'), i18nService.t('memoryEmptyDescription'))
          )}
        </section>
      </div>
    );
  };

  const renderSearch = () => (
    <div className="mx-auto max-w-4xl">
      <div className="rounded-2xl border border-border bg-surface p-5 shadow-sm">
        <div className="flex items-center gap-2 text-primary">
          <SparklesIcon className="h-5 w-5" />
          <h2 className="text-sm font-semibold text-foreground">
            {i18nService.t('memorySemanticSearchTitle')}
          </h2>
        </div>
        <p className="mt-1 text-xs leading-5 text-secondary">
          {i18nService.t('memorySemanticSearchDescription')}
        </p>
        <form onSubmit={handleSearch} className="mt-4 flex gap-2">
          <div className="relative min-w-0 flex-1">
            <MagnifyingGlassIcon className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
            <input
              value={query}
              onChange={event => setQuery(event.target.value)}
              placeholder={i18nService.t('memorySearchPlaceholder')}
              className="h-10 w-full rounded-xl border border-border bg-background pl-9 pr-3 text-sm text-foreground outline-none transition-colors placeholder:text-muted focus:border-primary focus:ring-2 focus:ring-primary/15"
            />
          </div>
          <button
            type="submit"
            disabled={!query.trim() || searching || rebuilding}
            className="inline-flex h-10 items-center gap-2 rounded-xl bg-primary px-4 text-sm font-medium text-white transition-colors hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-50"
          >
            {searching && <ArrowPathIcon className="h-4 w-4 animate-spin" />}
            {i18nService.t('memorySearchAction')}
          </button>
        </form>
      </div>

      <div className="mt-5 space-y-3">
        {searchError && (
          <div className="rounded-xl border border-danger/30 bg-danger/5 px-4 py-3 text-sm text-danger">
            {searchError}
          </div>
        )}
        {searchHits.map(hit => (
          <button
            key={`${hit.path}:${hit.startLine}:${hit.endLine}`}
            type="button"
            onClick={() => void openDocument(hit.path)}
            className="group w-full rounded-2xl border border-border bg-surface p-4 text-left shadow-sm transition-all hover:border-primary/40 hover:shadow-md"
          >
            <div className="flex items-center justify-between gap-3">
              <div className="flex min-w-0 items-center gap-2">
                <DocumentTextIcon className="h-4 w-4 shrink-0 text-primary" />
                <span className="truncate text-xs font-semibold text-foreground group-hover:text-primary">
                  {hit.path}
                </span>
                <span className="shrink-0 text-[10px] text-muted">
                  {hit.startLine > 0 ? `L${hit.startLine}–${hit.endLine}` : ''}
                </span>
              </div>
              <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-semibold text-primary">
                {Math.round(hit.score * 100)}%
              </span>
            </div>
            <p className="mt-3 whitespace-pre-line text-sm leading-6 text-secondary">
              {hit.snippet}
            </p>
          </button>
        ))}
        {hasSearched &&
          !searching &&
          !searchError &&
          searchHits.length === 0 &&
          renderEmpty(
            i18nService.t('memorySearchEmpty'),
            i18nService.t('memorySearchEmptyDescription'),
          )}
        {!hasSearched && (
          <div className="grid gap-3 sm:grid-cols-3">
            {[
              'memorySearchIdeaPreference',
              'memorySearchIdeaDecision',
              'memorySearchIdeaProject',
            ].map(key => (
              <button
                key={key}
                type="button"
                onClick={() => setQuery(i18nService.t(key))}
                className="rounded-xl border border-border bg-surface/60 px-4 py-4 text-left text-xs text-secondary transition-colors hover:border-primary/30 hover:bg-surface"
              >
                <MagnifyingGlassIcon className="mb-2 h-4 w-4 text-primary" />
                {i18nService.t(key)}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );

  const renderTimeline = () =>
    timelineGroups.length > 0 ? (
      <div className="mx-auto max-w-4xl space-y-8">
        {timelineGroups.map(([month, documents]) => (
          <section key={month} className="relative pl-7">
            <div className="absolute bottom-0 left-[7px] top-7 w-px bg-border" />
            <div className="mb-3 flex items-center gap-3">
              <span className="absolute left-0 h-3.5 w-3.5 rounded-full border-2 border-primary bg-background" />
              <h2 className="text-sm font-semibold text-foreground">{month}</h2>
              <span className="text-xs text-muted">{documents.length}</span>
            </div>
            <div className="space-y-3">{documents.map(item => documentCard(item))}</div>
          </section>
        ))}
      </div>
    ) : (
      renderEmpty(i18nService.t('memoryTimelineEmpty'), i18nService.t('memoryEmptyDescription'))
    );

  const renderFiles = () => (
    <div className="mx-auto max-w-4xl space-y-4">
      {kindOrder.map(kind => {
        const documents = overview?.documents.filter(document => document.kind === kind) || [];
        if (documents.length === 0) return null;
        return (
          <section
            key={kind}
            className="overflow-hidden rounded-2xl border border-border bg-surface shadow-sm"
          >
            <div className="flex items-center justify-between border-b border-border bg-surface-raised/50 px-4 py-3">
              <div className="flex items-center gap-2">
                <FolderOpenIcon className="h-4 w-4 text-primary" />
                <h2 className="text-sm font-semibold text-foreground">{kindLabels[kind]}</h2>
              </div>
              <span className="text-xs text-muted">{documents.length}</span>
            </div>
            <div className="divide-y divide-border">
              {documents.map(document => (
                <button
                  key={document.id}
                  type="button"
                  onClick={() => void openDocument(document.relativePath)}
                  className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-surface-raised/60"
                >
                  <DocumentTextIcon className="h-4 w-4 shrink-0 text-muted" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium text-foreground">
                      {document.fileName}
                    </div>
                    <div className="mt-0.5 truncate text-[11px] text-muted">
                      {document.relativePath}
                    </div>
                  </div>
                  <div className="hidden shrink-0 text-right text-[11px] text-muted sm:block">
                    <div>{formatBytes(document.size)}</div>
                    <div className="mt-0.5">{dateTimeFormatter.format(document.modifiedAt)}</div>
                  </div>
                </button>
              ))}
            </div>
          </section>
        );
      })}
      {overview?.counts.total === 0 &&
        renderEmpty(i18nService.t('memoryFilesEmpty'), i18nService.t('memoryEmptyDescription'))}
    </div>
  );

  return (
    <div className="relative flex h-full min-h-0 flex-col">
      <header className="shrink-0 border-b border-border bg-gradient-to-b from-primary/[0.05] to-transparent px-6 pb-0 pt-2">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <p className="pt-2 text-xs text-secondary">{i18nService.t('memoryDescription')}</p>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void loadOverview()}
              disabled={loading || rebuilding || searching}
              className="inline-flex h-9 items-center gap-2 rounded-xl border border-border bg-surface px-3 text-xs font-medium text-secondary transition-colors hover:bg-surface-raised hover:text-foreground disabled:opacity-50"
            >
              <ArrowPathIcon className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
              {i18nService.t('memoryRefresh')}
            </button>
            <button
              type="button"
              onClick={() => void handleRebuild()}
              disabled={loading || rebuilding || searching}
              className="inline-flex h-9 items-center gap-2 rounded-xl bg-primary px-3.5 text-xs font-semibold text-white shadow-sm transition-colors hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-60"
            >
              <CircleStackIcon className={`h-4 w-4 ${rebuilding ? 'animate-pulse' : ''}`} />
              {rebuilding ? i18nService.t('memoryRebuilding') : i18nService.t('memoryRebuild')}
            </button>
          </div>
        </div>
        <nav className="mt-5 flex gap-5" aria-label={i18nService.t('memoryTitle')}>
          {MEMORY_TABS.map(tab => (
            <button
              key={tab}
              type="button"
              onClick={() => setActiveTab(tab)}
              className={`border-b-2 pb-3 text-sm font-medium transition-colors ${
                activeTab === tab
                  ? 'border-primary text-primary'
                  : 'border-transparent text-secondary hover:text-foreground'
              }`}
            >
              {tabLabels[tab]}
            </button>
          ))}
        </nav>
      </header>

      <main className="min-h-0 flex-1 overflow-y-auto px-6 py-6">
        {notice && (
          <div className="mb-4 flex items-center gap-2 rounded-xl border border-emerald-500/25 bg-emerald-500/5 px-4 py-3 text-xs text-emerald-600 dark:text-emerald-400">
            <CheckCircleIcon className="h-4 w-4" />
            {notice}
          </div>
        )}
        {error && (
          <div className="mb-4 flex items-start gap-2 rounded-xl border border-danger/30 bg-danger/5 px-4 py-3 text-xs text-danger">
            <ExclamationTriangleIcon className="mt-0.5 h-4 w-4 shrink-0" />
            <span className="min-w-0 break-words">{error}</span>
          </div>
        )}
        {loading && !overview ? (
          <div className="grid grid-cols-2 gap-2.5 md:grid-cols-5">
            {[0, 1, 2, 3, 4].map(item => (
              <div
                key={item}
                className="h-[53px] animate-pulse rounded-xl border border-border bg-surface"
              />
            ))}
          </div>
        ) : activeTab === 'overview' ? (
          renderOverview()
        ) : activeTab === 'search' ? (
          renderSearch()
        ) : activeTab === 'timeline' ? (
          renderTimeline()
        ) : (
          renderFiles()
        )}
      </main>

      {documentLoading && !selectedDocument && (
        <div className="absolute inset-0 z-30 flex items-center justify-center bg-background/50 backdrop-blur-sm">
          <ArrowPathIcon className="h-6 w-6 animate-spin text-primary" />
        </div>
      )}

      {selectedDocument && (
        <>
          <button
            type="button"
            className="absolute inset-0 z-40 cursor-default bg-black/15"
            onClick={() => setSelectedDocument(null)}
            aria-label={i18nService.t('close')}
          />
          <aside className="absolute bottom-2 right-0 top-2 z-50 flex w-[min(680px,88%)] flex-col overflow-hidden rounded-l-2xl border border-r-0 border-border bg-background shadow-2xl">
            <div className="flex shrink-0 items-start justify-between gap-4 border-b border-border bg-surface px-5 py-4">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-semibold text-primary">
                    {kindLabels[selectedDocument.kind]}
                  </span>
                  <span className="text-[11px] text-muted">
                    {formatBytes(selectedDocument.size)}
                  </span>
                </div>
                <h2 className="mt-2 truncate text-base font-semibold text-foreground">
                  {selectedDocument.title}
                </h2>
                <p
                  className="mt-0.5 truncate text-[11px] text-muted"
                  title={selectedDocument.relativePath}
                >
                  {selectedDocument.relativePath}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setSelectedDocument(null)}
                className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-secondary transition-colors hover:bg-surface-raised hover:text-foreground"
                aria-label={i18nService.t('close')}
              >
                <XMarkIcon className="h-5 w-5" />
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-7 py-6">
              <article
                className="mx-auto max-w-3xl text-[14px] leading-7 text-foreground [&_a]:text-primary [&_a]:underline [&_blockquote]:my-4 [&_blockquote]:border-l-4 [&_blockquote]:border-border [&_blockquote]:pl-4 [&_blockquote]:text-secondary [&_code]:rounded [&_code]:bg-surface-raised [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:font-mono [&_h1]:mb-4 [&_h1]:border-b [&_h1]:border-border [&_h1]:pb-2 [&_h1]:text-2xl [&_h1]:font-bold [&_h2]:mb-3 [&_h2]:mt-7 [&_h2]:text-xl [&_h2]:font-semibold [&_h3]:mb-2 [&_h3]:mt-5 [&_h3]:text-lg [&_h3]:font-semibold [&_hr]:my-6 [&_hr]:border-border [&_li]:my-1 [&_li]:ml-6 [&_ol]:my-4 [&_ol]:list-decimal [&_p]:my-3 [&_pre]:my-4 [&_pre]:overflow-auto [&_pre]:rounded-xl [&_pre]:bg-surface-raised [&_pre]:p-4 [&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_strong]:font-semibold [&_table]:my-5 [&_table]:w-full [&_td]:border [&_td]:border-border [&_td]:p-2 [&_th]:border [&_th]:border-border [&_th]:bg-surface-raised [&_th]:p-2 [&_ul]:my-4 [&_ul]:list-disc"
                dangerouslySetInnerHTML={{ __html: markdownHtml }}
              />
            </div>
            <div className="flex shrink-0 items-center gap-2 border-t border-border bg-surface/70 px-5 py-2.5 text-[11px] text-muted">
              <ClockIcon className="h-3.5 w-3.5" />
              {i18nService.t('memoryLastModified')}{' '}
              {dateTimeFormatter.format(selectedDocument.modifiedAt)}
            </div>
          </aside>
        </>
      )}
    </div>
  );
};

export default MemoryView;
