import {
  ArrowDownTrayIcon,
  ArrowPathIcon,
  ArrowUpCircleIcon,
  CheckIcon,
  PlusIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline';
import {
  type MarketplaceCategory,
  MarketplaceInstallOperation,
  MarketplaceInstallState,
  type MarketplacePlugin,
  type MarketplacePluginDetail,
  type MarketplacePluginKind,
  type MarketplaceSource,
} from '@shared/plugins/marketplace';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { getPluginArtworkTone } from '@/features/plugins/shared/pluginArtwork';
import PluginMarkdownDescription from '@/features/plugins/shared/PluginMarkdownDescription';
import PluginSectionHeader from '@/features/plugins/shared/PluginSectionHeader';
import { i18nService } from '@/services/i18n';
import Modal from '@/shared/components/common/Modal';
import ErrorMessage from '@/shared/components/ErrorMessage';
import SearchIcon from '@/shared/components/icons/SearchIcon';
import Tooltip from '@/shared/components/ui/Tooltip';

export interface InstalledMarketplacePlugin {
  id: string;
  version?: string;
  /** System-managed items count as installed but must not be updated from the marketplace. */
  updateEligible?: boolean;
}

const EMPTY_INSTALLED_PLUGINS: InstalledMarketplacePlugin[] = [];

interface MarketplaceViewProps {
  kind: MarketplacePluginKind;
  installed?: InstalledMarketplacePlugin[];
  icon: React.ReactNode;
  readOnly?: boolean;
  onInstalled?: () => void | Promise<void>;
  searchQuery?: string;
  availableOnly?: boolean;
  runtimeUnavailable?: boolean;
  onUpdateIdsChange?: (installedIds: Set<string>) => void;
}

const formatDownloadCount = (count: number): string =>
  new Intl.NumberFormat(i18nService.getLanguage(), {
    notation: 'compact',
    maximumFractionDigits: 1,
  }).format(count);

const MarketplaceView: React.FC<MarketplaceViewProps> = ({
  kind,
  installed = EMPTY_INSTALLED_PLUGINS,
  icon,
  readOnly = false,
  onInstalled,
  searchQuery,
  availableOnly = false,
  runtimeUnavailable = false,
  onUpdateIdsChange,
}) => {
  const [localQuery, setLocalQuery] = useState('');
  const query = searchQuery ?? localQuery;
  const discovering = !query.trim();
  const [items, setItems] = useState<MarketplacePlugin[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [sources, setSources] = useState<MarketplaceSource[]>([]);
  const [selectedSourceId, setSelectedSourceId] = useState('');
  const [categories, setCategories] = useState<MarketplaceCategory[]>([]);
  const [selectedCategoryId, setSelectedCategoryId] = useState('');
  const [nextCursor, setNextCursor] = useState<string | undefined>();
  const [error, setError] = useState('');
  const [successMessage, setSuccessMessage] = useState('');
  const [refreshWarning, setRefreshWarning] = useState('');
  const [installingKeys, setInstallingKeys] = useState<Set<string>>(() => new Set());
  const [committedKeys, setCommittedKeys] = useState<Set<string>>(() => new Set());
  const [checkedUpdatesById, setCheckedUpdatesById] = useState<Map<string, MarketplacePlugin>>(
    () => new Map(),
  );
  const [selectedDetail, setSelectedDetail] = useState<MarketplacePluginDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const searchGeneration = useRef(0);
  const installedById = useMemo(() => {
    const result = new Map<string, InstalledMarketplacePlugin>();
    for (const item of installed) {
      const id = item.id.toLowerCase();
      const current = result.get(id);
      if (!current || (current.updateEligible === false && item.updateEligible !== false)) {
        result.set(id, item);
      }
    }
    return result;
  }, [installed]);
  const selectedSourceSupportsDetail =
    sources.find(source => source.id === selectedSourceId)?.supportsDetail !== false;
  const selectedSourceSupportsCategories =
    sources.find(source => source.id === selectedSourceId)?.supportsCategories === true;

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
    setCategories([]);
    setSelectedCategoryId('');
    const listCategories = window.electron.marketplace.listCategories;
    if (
      configured !== true ||
      !selectedSourceId ||
      !discovering ||
      !selectedSourceSupportsCategories ||
      typeof listCategories !== 'function'
    ) {
      return;
    }
    let active = true;
    void listCategories({ kind, sourceId: selectedSourceId })
      .then(response => {
        if (!active || !response.success) return;
        setCategories(response.result?.categories ?? []);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [configured, discovering, kind, selectedSourceId, selectedSourceSupportsCategories]);

  useEffect(() => {
    if (configured !== true || !selectedSourceId) return;
    const generation = ++searchGeneration.current;
    let active = true;
    setSuccessMessage('');
    const timer = window.setTimeout(async () => {
      setLoading(true);
      setError('');
      try {
        const response = await window.electron.marketplace.search({
          kind,
          query: query.trim() || undefined,
          ...(discovering && selectedCategoryId ? { categoryId: selectedCategoryId } : {}),
          limit: query.trim() ? 60 : 8,
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
  }, [configured, discovering, kind, query, selectedCategoryId, selectedSourceId]);

  useEffect(() => {
    const eligible = installed.filter(item => item.updateEligible !== false);
    const checkUpdates = window.electron.marketplace.checkUpdates;
    if (configured !== true || eligible.length === 0 || typeof checkUpdates !== 'function') {
      setCheckedUpdatesById(new Map());
      return;
    }
    let active = true;
    void checkUpdates({
      kind,
      installed: eligible.map(({ id, version }) => ({ id, version })),
    })
      .then(response => {
        if (!active) return;
        if (!response.success) {
          setCheckedUpdatesById(new Map());
          return;
        }
        const updates = new Map<string, MarketplacePlugin>();
        for (const item of response.result?.updates ?? []) {
          const installedId = (item.runtimeId || item.id).toLowerCase();
          if (installedById.has(installedId)) updates.set(installedId, item);
        }
        setCheckedUpdatesById(updates);
      })
      .catch(() => {
        if (active) setCheckedUpdatesById(new Map());
      });
    return () => {
      active = false;
    };
  }, [configured, installed, installedById, kind]);

  const handleLoadMore = async () => {
    if (!nextCursor || loadingMore) return;
    const generation = searchGeneration.current;
    setLoadingMore(true);
    setError('');
    try {
      const response = await window.electron.marketplace.search({
        kind,
        query: query.trim() || undefined,
        ...(discovering && selectedCategoryId ? { categoryId: selectedCategoryId } : {}),
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
    setSuccessMessage('');
    setCategories([]);
    setSelectedCategoryId('');
    setSelectedSourceId(sourceId);
  };

  const getCheckedUpdate = (item: MarketplacePlugin): MarketplacePlugin | undefined => {
    const update = checkedUpdatesById.get((item.runtimeId || item.id).toLowerCase());
    return update?.sourceId === item.sourceId && update.id.toLowerCase() === item.id.toLowerCase()
      ? update
      : undefined;
  };

  useEffect(() => {
    setCommittedKeys(current => {
      if (current.size === 0) return current;
      const next = new Set(current);
      for (const item of items) {
        if (installedById.has((item.runtimeId || item.id).toLowerCase())) {
          next.delete(`${item.sourceId}:${item.id.toLowerCase()}`);
        }
      }
      return next.size === current.size ? current : next;
    });
  }, [installedById, items]);

  const getState = (item: MarketplacePlugin) => {
    if (committedKeys.has(`${item.sourceId}:${item.id.toLowerCase()}`)) {
      return MarketplaceInstallState.INSTALLED;
    }
    const installed = installedById.get((item.runtimeId || item.id).toLowerCase());
    if (installed) {
      return installed.updateEligible !== false &&
        (item.installState === MarketplaceInstallState.UPDATE_AVAILABLE ||
          Boolean(getCheckedUpdate(item)))
        ? MarketplaceInstallState.UPDATE_AVAILABLE
        : MarketplaceInstallState.INSTALLED;
    }
    if (item.installState === MarketplaceInstallState.UNAVAILABLE) {
      return MarketplaceInstallState.UNAVAILABLE;
    }
    return MarketplaceInstallState.AVAILABLE;
  };

  useEffect(() => {
    if (!onUpdateIdsChange) return;
    const updateIds = new Set(checkedUpdatesById.keys());
    for (const item of items) {
      const installedId = (item.runtimeId || item.id).toLowerCase();
      const installed = installedById.get(installedId);
      if (
        installed &&
        installed.updateEligible !== false &&
        item.installState === MarketplaceInstallState.UPDATE_AVAILABLE
      ) {
        updateIds.add(installed.id.toLowerCase());
      }
    }
    onUpdateIdsChange(updateIds);
  }, [checkedUpdatesById, installedById, items, onUpdateIdsChange]);

  const visibleItems = availableOnly
    ? items.filter(item => getState(item) !== MarketplaceInstallState.INSTALLED)
    : items;

  const handleInstall = async (item: MarketplacePlugin) => {
    const state = getState(item);
    const installItem = getCheckedUpdate(item) ?? item;
    if (
      readOnly ||
      runtimeUnavailable ||
      state === MarketplaceInstallState.INSTALLED ||
      state === MarketplaceInstallState.UNAVAILABLE
    ) {
      return;
    }
    const key = `${installItem.sourceId}:${installItem.id}`;
    if (installingKeys.has(key)) return;
    setInstallingKeys(current => new Set(current).add(key));
    setError('');
    setSuccessMessage('');
    setRefreshWarning('');
    try {
      const response = await window.electron.marketplace.install({
        sourceId: installItem.sourceId,
        pluginId: installItem.id,
        kind: installItem.kind,
        version: installItem.version,
        operation:
          state === MarketplaceInstallState.UPDATE_AVAILABLE
            ? MarketplaceInstallOperation.UPDATE
            : MarketplaceInstallOperation.INSTALL,
      });
      if (!response.success) {
        throw new Error(response.error || i18nService.t('marketplaceInstallFailed'));
      }
      setCommittedKeys(current =>
        new Set(current).add(`${item.sourceId}:${item.id.toLowerCase()}`),
      );
      setItems(current =>
        current.map(candidate =>
          candidate.sourceId === item.sourceId && candidate.id === item.id
            ? {
                ...candidate,
                installState: MarketplaceInstallState.INSTALLED,
                installedVersion: installItem.version,
              }
            : candidate,
        ),
      );
      setSelectedDetail(current =>
        current?.sourceId === item.sourceId && current.id === item.id
          ? {
              ...current,
              installState: MarketplaceInstallState.INSTALLED,
              installedVersion: installItem.version,
            }
          : current,
      );
      setCheckedUpdatesById(current => {
        const next = new Map(current);
        next.delete((item.runtimeId || item.id).toLowerCase());
        return next;
      });
      setSuccessMessage(
        i18nService
          .t(
            state === MarketplaceInstallState.UPDATE_AVAILABLE
              ? 'marketplaceUpdateSucceeded'
              : 'marketplaceInstallSucceeded',
          )
          .replace('{name}', item.name),
      );
      try {
        await onInstalled?.();
      } catch {
        setRefreshWarning(i18nService.t('marketplaceRefreshAfterInstallFailed'));
      }
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
      if (response.detail) {
        setSelectedDetail({
          ...item,
          ...response.detail,
          id: item.id,
          kind: item.kind,
          sourceId: item.sourceId,
          runtimeId: response.detail.runtimeId ?? item.runtimeId,
          installState: response.detail.installState ?? item.installState,
        });
      }
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
    const installItem = getCheckedUpdate(item) ?? item;
    const key = `${installItem.sourceId}:${installItem.id}`;
    const installing = installingKeys.has(key);
    const state = getState(item);
    const label = runtimeUnavailable
      ? i18nService.t('marketplaceRuntimeUnavailable')
      : installing
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
      runtimeUnavailable ||
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
          className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-xs font-medium transition-colors disabled:cursor-default disabled:opacity-60 ${
            state === MarketplaceInstallState.UPDATE_AVAILABLE
              ? 'text-amber-600 hover:bg-surface-raised dark:text-amber-400'
              : state === MarketplaceInstallState.INSTALLED
                ? 'text-emerald-600 dark:text-emerald-400'
                : state === MarketplaceInstallState.UNAVAILABLE
                  ? 'text-secondary'
                  : 'bg-primary text-white hover:bg-primary-hover'
          }`}
        >
          {installing ? (
            <ArrowPathIcon className="h-4 w-4 animate-spin" />
          ) : state === MarketplaceInstallState.UPDATE_AVAILABLE ? (
            <ArrowUpCircleIcon className="h-4 w-4" />
          ) : state === MarketplaceInstallState.INSTALLED ? (
            <CheckIcon className="h-4 w-4" />
          ) : state === MarketplaceInstallState.UNAVAILABLE ? (
            <XMarkIcon className="h-4 w-4" />
          ) : (
            <PlusIcon className="h-4 w-4" />
          )}
          <span className="sr-only">{label}</span>
        </button>
      </Tooltip>
    );
  };

  return (
    <div className="space-y-4">
      <PluginSectionHeader
        title={i18nService.t(query.trim() ? 'marketplaceResultsTitle' : 'marketplaceDiscoverTitle')}
      />
      {configured === true && (searchQuery === undefined || sources.length > 1) && (
        <div className="flex gap-3 rounded-2xl border border-border bg-surface p-2 shadow-sm">
          {searchQuery === undefined && (
            <div className="relative min-w-0 flex-1">
              <SearchIcon className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-secondary" />
              <input
                type="text"
                value={query}
                onChange={event => setLocalQuery(event.target.value)}
                placeholder={i18nService.t('marketplaceSearchPlaceholder')}
                className="w-full rounded-xl border-0 bg-background py-2.5 pl-9 pr-3 text-sm text-foreground placeholder-secondary focus:outline-none focus:ring-2 focus:ring-primary"
              />
            </div>
          )}
          {sources.length > 1 && (
            <select
              value={selectedSourceId}
              onChange={event => handleSourceChange(event.target.value)}
              aria-label={i18nService.t('marketplaceSource')}
              className="rounded-xl border-0 bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary"
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

      {configured === true && discovering && categories.length > 0 && (
        <div
          className="flex min-w-0 gap-2 overflow-x-auto pb-1"
          aria-label={i18nService.t('marketplaceCategories')}
        >
          {categories.map(category => {
            const selected = selectedCategoryId === category.id;
            return (
              <button
                type="button"
                key={category.id}
                aria-pressed={selected}
                onClick={() => setSelectedCategoryId(selected ? '' : category.id)}
                className={`shrink-0 rounded-full border px-3 py-1 text-xs transition-colors ${
                  selected
                    ? 'border-primary text-primary'
                    : 'border-border text-secondary hover:border-primary/60 hover:text-foreground'
                }`}
              >
                {category.name}
              </button>
            );
          })}
        </div>
      )}

      {error && <ErrorMessage message={error} />}
      {successMessage && (
        <div
          role="status"
          aria-live="polite"
          className="rounded-xl border border-emerald-500/30 px-3 py-2 text-sm text-emerald-700 dark:text-emerald-300"
        >
          {successMessage}
        </div>
      )}
      {refreshWarning && (
        <div
          role="status"
          aria-live="polite"
          className="rounded-xl border border-amber-500/40 px-3 py-2 text-sm text-amber-700 dark:text-amber-300"
        >
          {refreshWarning}
        </div>
      )}
      {loading || configured === null ? (
        <div
          className="grid min-w-0 grid-cols-[repeat(auto-fit,minmax(min(100%,20rem),1fr))] gap-1 gap-x-4"
          aria-busy="true"
          aria-live="polite"
        >
          <span className="sr-only" role="status">
            {i18nService.t('marketplaceLoading')}
          </span>
          {[0, 1, 2].map(item => (
            <div key={item} className="h-16 animate-pulse rounded-xl bg-surface-raised/70" />
          ))}
        </div>
      ) : configured === false ? (
        error ? null : (
          <div className="rounded-2xl border border-dashed border-border bg-surface px-6 py-8 text-center">
            <div className="text-sm font-medium text-foreground">
              {i18nService.t('marketplaceNotConfigured')}
            </div>
          </div>
        )
      ) : visibleItems.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-border py-10 text-center text-sm text-secondary">
          {i18nService.t('marketplaceEmpty')}
        </div>
      ) : (
        <div
          className={
            query.trim()
              ? 'grid min-w-0 grid-cols-[repeat(auto-fit,minmax(min(100%,20rem),1fr))] gap-1 gap-x-4'
              : 'flex min-w-0 gap-2 overflow-x-auto pb-1'
          }
        >
          {visibleItems.map((item, visualIndex) => (
            <article
              key={`${item.sourceId}:${item.id}`}
              onClick={selectedSourceSupportsDetail ? () => void openDetail(item) : undefined}
              className={`group relative flex min-h-16 min-w-0 items-center gap-3 rounded-xl border border-transparent px-2 py-2 transition-colors hover:border-border/70 hover:bg-surface-raised/70 ${
                query.trim() ? '' : 'w-80 shrink-0'
              } ${selectedSourceSupportsDetail ? 'cursor-pointer' : ''}`}
            >
              {selectedSourceSupportsDetail && (
                <button
                  type="button"
                  className="absolute inset-0 z-0 rounded-xl focus:outline-none focus:ring-2 focus:ring-primary"
                  aria-label={`${i18nService.t('subtaskShowInfo')}: ${item.name}`}
                  onClick={event => {
                    event.stopPropagation();
                    void openDetail(item);
                  }}
                />
              )}
              <div
                className={`pointer-events-none relative z-10 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br ${getPluginArtworkTone(`marketplace:${item.sourceId}`, visualIndex)}`}
              >
                {icon}
              </div>
              <div className="pointer-events-none relative z-10 min-w-0 flex-1">
                <div className="flex min-w-0 items-center gap-2">
                  <span className="truncate text-sm font-semibold text-foreground">
                    {item.name}
                  </span>
                  {getState(item) === MarketplaceInstallState.UPDATE_AVAILABLE && (
                    <Tooltip
                      content={i18nService.t('marketplaceUpdateAvailable')}
                      position="bottom"
                    >
                      <ArrowUpCircleIcon
                        className="h-3.5 w-3.5 shrink-0 text-amber-600 dark:text-amber-400"
                        aria-label={i18nService.t('marketplaceUpdateAvailable')}
                      />
                    </Tooltip>
                  )}
                  {item.downloadCount !== undefined && (
                    <span className="inline-flex shrink-0 items-center gap-0.5 text-[10px] text-secondary">
                      <ArrowDownTrayIcon className="h-3 w-3" />
                      {formatDownloadCount(item.downloadCount)}
                    </span>
                  )}
                </div>
                <p className="mt-0.5 truncate text-xs text-secondary">{item.description}</p>
                {(item.author || item.version) && (
                  <span className="mt-0.5 block truncate text-[10px] text-secondary/80">
                    {item.author || item.id}
                    {item.version ? ` · v${item.version}` : ''}
                  </span>
                )}
              </div>
              <div className="pointer-events-auto relative z-10 shrink-0">{action(item)}</div>
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
                  {getState(selectedDetail) === MarketplaceInstallState.UPDATE_AVAILABLE && (
                    <span className="inline-flex shrink-0 items-center gap-1 text-[10px] font-medium text-amber-600 dark:text-amber-400">
                      <ArrowUpCircleIcon className="h-3.5 w-3.5" />
                      {i18nService.t('marketplaceUpdateAvailable')}
                    </span>
                  )}
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
            <PluginMarkdownDescription className="mt-3" content={selectedDetail.description} />
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
                    <PluginMarkdownDescription
                      className="mt-2 rounded-xl border border-border bg-background p-3"
                      content={selectedDetail.readme}
                    />
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
