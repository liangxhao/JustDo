import {
  type MarketplacePlugin,
  type MarketplacePluginDetail,
  type MarketplacePluginKind,
} from '@shared/plugins/marketplace';
import React, { useEffect, useRef, useState } from 'react';

import { getPluginArtworkTone } from '@/features/plugins/shared/pluginArtwork';
import PluginCard, { PluginCardGrid } from '@/features/plugins/shared/PluginCard';
import PluginOperationFeedback from '@/features/plugins/shared/PluginOperationFeedback';
import { i18nService } from '@/services/i18n';

import { MarketplaceAction } from './MarketplaceActions';
import MarketplaceDetail from './MarketplaceDetail';
import MarketplaceOperationFeedback from './MarketplaceOperationFeedback';
import MarketplaceUnconfiguredNotice from './MarketplaceUnconfiguredNotice';
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
    <div className="space-y-2.5" aria-busy={c.loading || c.source === undefined}>
      {!c.query && (
        <h3 className="text-sm font-semibold text-foreground">
          {i18nService.t('marketplaceDiscoverTitle')}
        </h3>
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
        <MarketplaceUnconfiguredNotice className="py-4 text-sm text-secondary" />
      )}
      <PluginCardGrid>
        {c.visibleItems.map((item, index) => {
          const local = c.localFor(item);
          if (c.query && local && renderInstalled)
            return (
              <React.Fragment key={marketplaceKey(item)}>
                {renderInstalled(local.id, index)}
              </React.Fragment>
            );
          return (
            <PluginCard
              key={marketplaceKey(item)}
              icon={icon}
              artworkTone={getPluginArtworkTone('marketplace', index)}
              title={item.name}
              version={item.version}
              description={item.description}
              openLabel={`${i18nService.t('subtaskShowInfo')}: ${item.name}`}
              onOpen={c.source?.supportsDetail ? () => void openDetail(item) : undefined}
              actions={<MarketplaceAction controller={c} item={item} installOnly />}
            />
          );
        })}
      </PluginCardGrid>
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
      <MarketplaceOperationFeedback controller={controller} />
      <MarketplaceResults controller={controller} icon={props.icon} />
      <PluginOperationFeedback />
    </>
  );
}
