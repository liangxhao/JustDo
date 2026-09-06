import { ArrowPathIcon, CheckIcon, PlusIcon, XMarkIcon } from '@heroicons/react/24/outline';
import {
  MarketplaceInstallOperation,
  MarketplaceInstallState,
  type MarketplacePlugin,
  type MarketplacePluginDetail,
  type MarketplacePluginKind,
  type MarketplaceSource,
} from '@shared/plugins/marketplace';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { i18nService } from '@/services/i18n';
import Modal from '@/shared/components/common/Modal';
import ErrorMessage from '@/shared/components/ErrorMessage';
import SearchIcon from '@/shared/components/icons/SearchIcon';
import Tooltip from '@/shared/components/ui/Tooltip';

export interface InstalledMarketplacePlugin {
  id: string;
  version?: string;
}

interface MarketplaceViewProps {
  kind: MarketplacePluginKind;
  installed?: InstalledMarketplacePlugin[];
  icon: React.ReactNode;
  readOnly?: boolean;
  onInstalled?: () => void | Promise<void>;
}

const MarketplaceView: React.FC<MarketplaceViewProps> = ({
  kind,
  installed = [],
  icon,
  readOnly = false,
  onInstalled,
}) => {
  const [query, setQuery] = useState('');
  const [items, setItems] = useState<MarketplacePlugin[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [sources, setSources] = useState<MarketplaceSource[]>([]);
  const [selectedSourceId, setSelectedSourceId] = useState('');
  const [nextCursor, setNextCursor] = useState<string | undefined>();
  const [error, setError] = useState('');
  const [installingKeys, setInstallingKeys] = useState<Set<string>>(() => new Set());
  const [selectedDetail, setSelectedDetail] = useState<MarketplacePluginDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const searchGeneration = useRef(0);
  const installedById = useMemo(
    () => new Map(installed.map(item => [item.id.toLowerCase(), item])),
    [installed],
  );

  useEffect(() => {
    let active = true;
    setConfigured(null);
    setSources([]);
    setSelectedSourceId('');
    setNextCursor(undefined);
    setLoading(true);
    setError('');
    void window.electron.marketplace
      .listSources(kind)
      .then(response => {
        if (!active) return;
        if (!response.success) {
          throw new Error(response.error || i18nService.t('marketplaceLoadFailed'));
        }
        const hasSource = (response.sources?.length ?? 0) > 0;
        const availableSources = response.sources ?? [];
        setSources(availableSources);
        setSelectedSourceId(availableSources[0]?.id ?? '');
        setConfigured(hasSource);
        if (!hasSource) {
          setItems([]);
          setLoading(false);
        }
      })
      .catch(sourceError => {
        if (!active) return;
        setConfigured(false);
        setLoading(false);
        setError(
          sourceError instanceof Error
            ? sourceError.message
            : i18nService.t('marketplaceLoadFailed'),
        );
      });
    return () => {
      active = false;
    };
  }, [kind]);

  useEffect(() => {
    if (configured !== true || !selectedSourceId) return;
    const generation = ++searchGeneration.current;
    let active = true;
    const timer = window.setTimeout(async () => {
      setLoading(true);
      setError('');
      try {
        const response = await window.electron.marketplace.search({
          kind,
          query: query.trim() || undefined,
          limit: 60,
          sourceId: selectedSourceId,
        });
        if (!response.success) {
          throw new Error(response.error || i18nService.t('marketplaceLoadFailed'));
        }
        if (!active || generation !== searchGeneration.current) return;
        setItems(response.result?.items ?? []);
        setNextCursor(response.result?.nextCursor);
      } catch (loadError) {
        if (!active || generation !== searchGeneration.current) return;
        setItems([]);
        setError(
          loadError instanceof Error ? loadError.message : i18nService.t('marketplaceLoadFailed'),
        );
      } finally {
        if (active && generation === searchGeneration.current) setLoading(false);
      }
    }, 250);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [configured, kind, query, selectedSourceId]);

  const handleLoadMore = async () => {
    if (!nextCursor || loadingMore) return;
    const generation = searchGeneration.current;
    setLoadingMore(true);
    setError('');
    try {
      const response = await window.electron.marketplace.search({
        kind,
        query: query.trim() || undefined,
        limit: 60,
        cursor: nextCursor,
        sourceId: selectedSourceId,
      });
      if (!response.success) {
        throw new Error(response.error || i18nService.t('marketplaceLoadFailed'));
      }
      if (generation !== searchGeneration.current) return;
      setItems(current => {
        const existing = new Set(current.map(item => `${item.sourceId}:${item.id.toLowerCase()}`));
        return [
          ...current,
          ...(response.result?.items ?? []).filter(
            item => !existing.has(`${item.sourceId}:${item.id.toLowerCase()}`),
          ),
        ];
      });
      setNextCursor(response.result?.nextCursor);
    } catch (loadError) {
      if (generation !== searchGeneration.current) return;
      setError(
        loadError instanceof Error ? loadError.message : i18nService.t('marketplaceLoadFailed'),
      );
    } finally {
      setLoadingMore(false);
    }
  };

  const handleSourceChange = (sourceId: string) => {
    searchGeneration.current += 1;
    setItems([]);
    setNextCursor(undefined);
    setLoading(true);
    setError('');
    setSelectedSourceId(sourceId);
  };

  const getState = (item: MarketplacePlugin) => {
    if (item.installState === MarketplaceInstallState.UPDATE_AVAILABLE) {
      return MarketplaceInstallState.UPDATE_AVAILABLE;
    }
    if (item.installState === MarketplaceInstallState.UNAVAILABLE) {
      return MarketplaceInstallState.UNAVAILABLE;
    }
    return installedById.has((item.runtimeId || item.id).toLowerCase())
      ? MarketplaceInstallState.INSTALLED
      : MarketplaceInstallState.AVAILABLE;
  };

  const handleInstall = async (item: MarketplacePlugin) => {
    const state = getState(item);
    if (
      readOnly ||
      state === MarketplaceInstallState.INSTALLED ||
      state === MarketplaceInstallState.UNAVAILABLE
    ) {
      return;
    }
    const key = `${item.sourceId}:${item.id}`;
    if (installingKeys.has(key)) return;
    setInstallingKeys(current => new Set(current).add(key));
    setError('');
    try {
      const response = await window.electron.marketplace.install({
        sourceId: item.sourceId,
        pluginId: item.id,
        kind: item.kind,
        version: item.version,
        operation:
          state === MarketplaceInstallState.UPDATE_AVAILABLE
            ? MarketplaceInstallOperation.UPDATE
            : MarketplaceInstallOperation.INSTALL,
      });
      if (!response.success) {
        throw new Error(response.error || i18nService.t('marketplaceInstallFailed'));
      }
      await onInstalled?.();
    } catch (installError) {
      setError(
        installError instanceof Error
          ? installError.message
          : i18nService.t('marketplaceInstallFailed'),
      );
    } finally {
      setInstallingKeys(current => {
        const next = new Set(current);
        next.delete(key);
        return next;
      });
    }
  };

  const openDetail = async (item: MarketplacePlugin) => {
    setSelectedDetail({ ...item });
    setDetailLoading(true);
    setError('');
    try {
      const response = await window.electron.marketplace.detail({
        sourceId: item.sourceId,
        pluginId: item.id,
        kind: item.kind,
      });
      if (!response.success) {
        throw new Error(response.error || i18nService.t('marketplaceDetailFailed'));
      }
      if (response.detail) setSelectedDetail(response.detail);
    } catch (detailError) {
      setSelectedDetail(null);
      setError(
        detailError instanceof Error
          ? detailError.message
          : i18nService.t('marketplaceDetailFailed'),
      );
    } finally {
      setDetailLoading(false);
    }
  };

  const action = (item: MarketplacePlugin) => {
    const key = `${item.sourceId}:${item.id}`;
    const installing = installingKeys.has(key);
    const state = getState(item);
    const label = installing
      ? i18nService.t('marketplaceInstalling')
      : state === MarketplaceInstallState.UPDATE_AVAILABLE
        ? i18nService.t('marketplaceUpdate')
        : state === MarketplaceInstallState.INSTALLED
          ? i18nService.t('marketplaceInstalled')
          : state === MarketplaceInstallState.UNAVAILABLE
            ? i18nService.t('marketplaceUnavailable')
            : i18nService.t('marketplaceInstall');
    const disabled =
      readOnly ||
      installing ||
      state === MarketplaceInstallState.INSTALLED ||
      state === MarketplaceInstallState.UNAVAILABLE;

    return (
      <Tooltip content={label} position="bottom">
        <button
          type="button"
          aria-label={label}
          title={label}
          disabled={disabled}
          onClick={event => {
            event.stopPropagation();
            void handleInstall(item);
          }}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-border bg-background text-secondary transition-colors hover:border-primary hover:text-primary disabled:cursor-default disabled:opacity-60"
        >
          {installing ? (
            <ArrowPathIcon className="h-4 w-4 animate-spin" />
          ) : state === MarketplaceInstallState.UPDATE_AVAILABLE ? (
            <ArrowPathIcon className="h-4 w-4" />
          ) : state === MarketplaceInstallState.INSTALLED ? (
            <CheckIcon className="h-4 w-4" />
          ) : (
            <PlusIcon className="h-4 w-4" />
          )}
        </button>
      </Tooltip>
    );
  };

  return (
    <div className="space-y-4">
      {configured === true && (
        <div className="flex max-w-2xl gap-3">
          <div className="relative min-w-0 flex-1">
            <SearchIcon className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-secondary" />
            <input
              type="text"
              value={query}
              onChange={event => setQuery(event.target.value)}
              placeholder={i18nService.t('marketplaceSearchPlaceholder')}
              className="w-full rounded-xl border border-border bg-surface py-2 pl-9 pr-3 text-sm text-foreground placeholder-secondary focus:outline-none focus:ring-2 focus:ring-primary"
            />
          </div>
          {sources.length > 1 && (
            <select
              value={selectedSourceId}
              onChange={event => handleSourceChange(event.target.value)}
              aria-label={i18nService.t('marketplaceSource')}
              className="rounded-xl border border-border bg-surface px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary"
            >
              {sources.map(source => (
                <option key={source.id} value={source.id}>
                  {source.name}
                </option>
              ))}
            </select>
          )}
        </div>
      )}

      {error && <ErrorMessage message={error} />}
      {loading || configured === null ? (
        <div className="py-12 text-center text-sm text-secondary">
          {i18nService.t('marketplaceLoading')}
        </div>
      ) : configured === false ? (
        error ? null : (
          <div className="rounded-xl border border-dashed border-border bg-surface px-6 py-12 text-center">
            <div className="text-sm font-medium text-foreground">
              {i18nService.t('marketplaceNotConfigured')}
            </div>
          </div>
        )
      ) : items.length === 0 ? (
        <div className="py-12 text-center text-sm text-secondary">
          {i18nService.t('marketplaceEmpty')}
        </div>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(min(16rem,100%),1fr))] items-start gap-3">
          {items.map(item => (
            <article
              key={`${item.sourceId}:${item.id}`}
              role="button"
              tabIndex={0}
              onClick={() => void openDetail(item)}
              onKeyDown={event => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  void openDetail(item);
                }
              }}
              className="cursor-pointer rounded-xl border border-border bg-surface p-3 transition-colors hover:border-primary focus:outline-none focus:ring-2 focus:ring-primary"
            >
              <div className="mb-2 flex items-start justify-between gap-2">
                <div className="flex min-w-0 items-center gap-2">
                  <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-background text-secondary">
                    {icon}
                  </div>
                  <span className="truncate text-sm font-medium text-foreground">{item.name}</span>
                </div>
                {action(item)}
              </div>
              <p className="line-clamp-2 min-h-8 text-xs text-secondary">{item.description}</p>
              <div className="mt-3 flex min-w-0 flex-wrap items-center gap-1.5 text-[10px] text-secondary">
                {item.version && (
                  <span className="rounded bg-surface-raised px-1.5 py-0.5 font-medium">
                    v{item.version}
                  </span>
                )}
                {item.author && <span className="truncate">{item.author}</span>}
                {item.tags?.slice(0, 2).map(tag => (
                  <span key={tag} className="rounded bg-surface-raised px-1.5 py-0.5">
                    {tag}
                  </span>
                ))}
              </div>
            </article>
          ))}
          {nextCursor && (
            <div className="col-span-full flex justify-center pt-2">
              <button
                type="button"
                disabled={loadingMore}
                onClick={() => void handleLoadMore()}
                className="rounded-xl border border-border bg-surface px-4 py-2 text-sm text-secondary transition-colors hover:border-primary hover:text-primary disabled:cursor-wait disabled:opacity-60"
              >
                {loadingMore
                  ? i18nService.t('marketplaceLoadingMore')
                  : i18nService.t('marketplaceLoadMore')}
              </button>
            </div>
          )}
        </div>
      )}

      {selectedDetail &&
        createPortal(
          <Modal
            onClose={() => {
              if (!detailLoading) setSelectedDetail(null);
            }}
            overlayClassName="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
            className="mx-4 max-h-[80vh] w-full max-w-2xl overflow-y-auto rounded-2xl border border-border bg-surface p-5 shadow-2xl"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <h2 className="truncate text-lg font-semibold text-foreground">
                    {selectedDetail.name}
                  </h2>
                  {selectedDetail.version && (
                    <span className="shrink-0 text-xs text-secondary">
                      v{selectedDetail.version}
                    </span>
                  )}
                </div>
                {selectedDetail.author && (
                  <p className="mt-1 text-xs text-secondary">{selectedDetail.author}</p>
                )}
              </div>
              <button
                type="button"
                onClick={() => setSelectedDetail(null)}
                disabled={detailLoading}
                className="rounded-lg p-1.5 text-secondary transition-colors hover:bg-surface-raised hover:text-foreground disabled:opacity-50"
                aria-label={i18nService.t('close')}
              >
                <XMarkIcon className="h-5 w-5" />
              </button>
            </div>
            <p className="mt-3 text-sm leading-6 text-secondary">{selectedDetail.description}</p>
            {detailLoading ? (
              <div className="py-8 text-center text-sm text-secondary">
                {i18nService.t('marketplaceLoading')}
              </div>
            ) : (
              <>
                {(selectedDetail.requirements?.bins?.length ||
                  selectedDetail.requirements?.env?.length) && (
                  <div className="mt-4 rounded-xl border border-border bg-background p-3">
                    <div className="text-xs font-semibold text-foreground">
                      {i18nService.t('marketplaceRequirements')}
                    </div>
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {[
                        ...(selectedDetail.requirements.bins ?? []),
                        ...(selectedDetail.requirements.env ?? []),
                      ].map(requirement => (
                        <code
                          key={requirement}
                          className="rounded-md bg-surface-raised px-2 py-1 text-xs text-foreground"
                        >
                          {requirement}
                        </code>
                      ))}
                    </div>
                  </div>
                )}
                {selectedDetail.readme && (
                  <div className="mt-4">
                    <div className="text-xs font-semibold text-foreground">
                      {i18nService.t('marketplaceReadme')}
                    </div>
                    <pre className="mt-2 whitespace-pre-wrap break-words rounded-xl border border-border bg-background p-3 font-sans text-xs leading-5 text-secondary">
                      {selectedDetail.readme}
                    </pre>
                  </div>
                )}
                <div className="mt-5 flex justify-end">{action(selectedDetail)}</div>
              </>
            )}
          </Modal>,
          document.body,
        )}
    </div>
  );
};

export default MarketplaceView;
