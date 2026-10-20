import {
  type MarketplacePlugin,
  type MarketplacePluginDetail,
  type MarketplacePluginKind,
} from '@shared/plugins/marketplace';
import React, { useEffect, useRef, useState } from 'react';

import { getPluginArtworkTone } from '@/features/plugins/shared/pluginArtwork';
import { i18nService } from '@/services/i18n';

import { MarketplaceAction, MarketplaceFeedback } from './MarketplaceActions';
import MarketplaceDetail from './MarketplaceDetail';
import {
  type InstalledMarketplacePlugin,
  MarketplaceFilter,
  marketplaceKey,
  type PluginMarketplaceController,
  usePluginMarketplace,
} from './usePluginMarketplace';
export type { InstalledMarketplacePlugin } from './usePluginMarketplace';

export interface MarketplaceViewProps {
  controller: PluginMarketplaceController;
  icon: React.ReactNode;
  hasLocalMatches?: boolean;
  renderInstalled?: (id: string, index: number) => React.ReactNode;
}

export function MarketplaceResults({
  controller: c,
  icon,
  renderInstalled,
  hasLocalMatches = false,
}: MarketplaceViewProps) {
  const [detail, setDetail] = useState<MarketplacePluginDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState('');
  const generation = useRef(0);
  useEffect(
    () => () => {
      generation.current += 1;
    },
    [],
  );
  const openDetail = async (item: MarketplacePlugin) => {
    if (!c.source?.supportsDetail) return;
    const current = ++generation.current;
    setDetail({ ...item });
    setDetailLoading(true);
    setDetailError('');
    try {
      const response = await window.electron.marketplace.detail({
        kind: item.kind,
        sourceId: item.sourceId,
        pluginId: item.id,
      });
      if (current !== generation.current) return;
      if (!response.success) throw new Error(response.error);
      setDetail({
        ...item,
        ...response.detail,
        id: item.id,
        sourceId: item.sourceId,
        kind: item.kind,
      });
    } catch {
      if (current === generation.current) {
        setDetail(null);
        setDetailError(i18nService.t('marketplaceDetailFailed'));
      }
    } finally {
      if (current === generation.current) setDetailLoading(false);
    }
  };
  if (c.filter !== MarketplaceFilter.ALL) return null;
  return (
    <div className="space-y-3">
      {!c.query && (
        <h3 className="text-sm font-medium">{i18nService.t('marketplaceDiscoverTitle')}</h3>
      )}
      {!c.query && c.categories.length > 0 && (
        <div
          className="flex gap-2 overflow-x-auto"
          aria-label={i18nService.t('marketplaceCategories')}
        >
          {c.categories.map(category => (
            <button
              key={category.id}
              type="button"
              aria-pressed={c.category === category.id}
              onClick={() => c.setCategory(c.category === category.id ? '' : category.id)}
              className="shrink-0 rounded-full border border-border px-3 py-1 text-xs"
            >
              {category.name}
            </button>
          ))}
        </div>
      )}
      {(c.sourceError || c.searchError || detailError) && (
        <div role="alert" className="text-sm text-red-600 dark:text-red-400">
          {c.sourceError || c.searchError || detailError}
          <button type="button" onClick={c.retry} className="ml-2 underline">
            {i18nService.t('marketplaceRetry')}
          </button>
        </div>
      )}
      {c.source === null && !c.sourceError && (
        <p className="py-4 text-sm text-secondary">{i18nService.t('marketplaceNotConfigured')}</p>
      )}
      {(c.loading || c.source === undefined) && (
        <p role="status" className="text-sm text-secondary">
          {i18nService.t('marketplaceLoading')}
        </p>
      )}
      <div className="grid min-w-0 grid-cols-[repeat(auto-fill,minmax(min(100%,20rem),1fr))] gap-1 gap-x-4">
        {c.visibleItems.map((item, index) => {
          const local = c.localFor(item);
          if (local && renderInstalled)
            return (
              <React.Fragment key={marketplaceKey(item)}>
                {renderInstalled(local.id, index)}
              </React.Fragment>
            );
          return (
            <article
              key={marketplaceKey(item)}
              className="group relative min-w-0 rounded-xl border border-transparent px-2 py-2 hover:border-border/70 hover:bg-surface-raised/70"
            >
              <div className="flex items-start gap-2">
                <div
                  className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br ${getPluginArtworkTone('marketplace', index)}`}
                >
                  {icon}
                </div>
                <button
                  type="button"
                  disabled={!c.source?.supportsDetail}
                  onClick={() => void openDetail(item)}
                  className="min-w-0 flex-1 text-left disabled:cursor-default"
                  aria-label={`${i18nService.t('subtaskShowInfo')}: ${item.name}`}
                >
                  <span className="block truncate text-sm font-medium">{item.name}</span>
                  <span className="block truncate text-xs text-secondary" title={item.description}>
                    {item.description}
                  </span>
                  {item.version && <span className="text-xs text-secondary">{item.version}</span>}
                </button>
                <MarketplaceAction controller={c} item={item} />
              </div>
              <MarketplaceFeedback controller={c} item={item} />
            </article>
          );
        })}
      </div>
      {!c.loading &&
        c.source &&
        !c.searchError &&
        !c.visibleItems.length &&
        (!c.query || !hasLocalMatches) && (
          <p className="py-3 text-sm text-secondary">
            {i18nService.t(c.query ? 'marketplaceSearchEmpty' : 'marketplaceEmpty')}
          </p>
        )}
      {c.cursor && (
        <button
          type="button"
          disabled={c.loadingMore}
          onClick={() => void c.loadMore()}
          className="rounded-lg border border-border px-3 py-2 text-sm"
        >
          {i18nService.t(c.loadingMore ? 'marketplaceLoadingMore' : 'marketplaceLoadMore')}
        </button>
      )}
      {detail && (
        <MarketplaceDetail
          selectedDetail={detail}
          detailLoading={detailLoading}
          controller={c}
          onClose={() => {
            generation.current += 1;
            setDetail(null);
          }}
        />
      )}
    </div>
  );
}

const EMPTY: InstalledMarketplacePlugin[] = [];
interface StandaloneProps {
  kind: MarketplacePluginKind;
  icon: React.ReactNode;
  installed?: InstalledMarketplacePlugin[];
  searchQuery?: string;
  readOnly?: boolean;
  runtimeUnavailable?: boolean;
  onInstalled?: () => void | Promise<void>;
  availableOnly?: boolean;
  onUpdateIdsChange?: (ids: Set<string>) => void;
}
// Standalone catalog entry point; plugin managers share their controller with local cards.
export default function MarketplaceView(props: StandaloneProps) {
  const [query, setQuery] = useState('');
  const controller = usePluginMarketplace({
    ...props,
    installed: props.installed ?? EMPTY,
    searchQuery: props.searchQuery ?? query,
  });
  const { onUpdateIdsChange } = props;
  useEffect(() => {
    onUpdateIdsChange?.(new Set(controller.updateById.keys()));
  }, [controller.updateById, onUpdateIdsChange]);
  return (
    <>
      {props.searchQuery === undefined && (
        <input
          type="search"
          value={query}
          onChange={event => setQuery(event.target.value)}
          placeholder={i18nService.t('marketplaceSearchPlaceholder')}
        />
      )}
      <MarketplaceResults controller={controller} icon={props.icon} />
    </>
  );
}
