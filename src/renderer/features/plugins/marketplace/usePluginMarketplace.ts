import {
  type MarketplaceCategory,
  type MarketplaceInstallationIdentity,
  MarketplaceInstallOperation,
  MarketplaceInstallState,
  type MarketplacePlugin,
  type MarketplacePluginKind,
  type MarketplaceSource,
} from '@shared/plugins/marketplace';
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';

import { i18nService } from '@/services/i18n';

import { getMarketplaceOperationOwner } from './marketplaceOperationOwner';

export const MarketplaceFilter = {
  ALL: 'all',
  INSTALLED: 'installed',
  UPDATES: 'updates',
} as const;
export type MarketplaceFilter = (typeof MarketplaceFilter)[keyof typeof MarketplaceFilter];
export interface InstalledMarketplacePlugin {
  id: string;
  version?: string;
  installPath?: string;
  updateEligible?: boolean;
}
export interface MarketplaceOptions {
  kind: MarketplacePluginKind;
  installed: InstalledMarketplacePlugin[];
  searchQuery: string;
  readOnly?: boolean;
  runtimeUnavailable?: boolean;
  inventoryReady?: boolean;
  onInstalled?: () => void | Promise<void>;
}
export interface MarketplaceOperation {
  busy?: boolean;
  committed?: boolean;
  error?: string;
  warning?: string;
  message?: string;
  version?: string;
  restartRequired?: boolean;
}
export const marketplaceKey = (item: Pick<MarketplacePlugin, 'sourceId' | 'id'>) =>
  JSON.stringify([item.sourceId, item.id]);

export function usePluginMarketplace(options: MarketplaceOptions) {
  const { kind, installed, searchQuery, readOnly, runtimeUnavailable } = options;
  const inventoryReady = options.inventoryReady !== false;
  const query = searchQuery.trim();
  const discovering = !query;
  const [filter, setFilter] = useState<MarketplaceFilter>(MarketplaceFilter.ALL);
  const [source, setSource] = useState<MarketplaceSource | null | undefined>();
  const [sourceError, setSourceError] = useState('');
  const [items, setItems] = useState<MarketplacePlugin[]>([]);
  const [categories, setCategories] = useState<MarketplaceCategory[]>([]);
  const [category, setCategory] = useState('');
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [searchError, setSearchError] = useState('');
  const [cursor, setCursor] = useState<string>();
  const [revision, setRevision] = useState(0);
  const [checkRevision, setCheckRevision] = useState(0);
  const [identities, setIdentities] = useState<MarketplaceInstallationIdentity[]>([]);
  const [identityReady, setIdentityReady] = useState(false);
  const [updates, setUpdates] = useState<MarketplacePlugin[]>([]);
  const [checking, setChecking] = useState(false);
  const [updateError, setUpdateError] = useState('');
  const owner = getMarketplaceOperationOwner(window.electron.marketplace, kind);
  const operations = useSyncExternalStore(owner.subscribe, owner.snapshot);
  const setOperations = owner.update;
  // Keep newly installed cards in their original location until the query changes.
  const [pinnedKeys, setPinnedKeys] = useState<Set<string>>(() => new Set());
  const [recentlyUpdated, setRecentlyUpdated] = useState<Set<string>>(() => new Set());
  const locks = owner.locks;
  const mounted = useRef(true);
  const searchGeneration = useRef(0);
  const optionsRef = useRef(options);
  optionsRef.current = options;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(
    () =>
      owner.attachRefresh(async () => {
        await optionsRef.current.onInstalled?.();
        if (mounted.current) setCheckRevision(value => value + 1);
      }),
    [owner],
  );

  useEffect(() => {
    const timers: number[] = [];
    for (const id of recentlyUpdated) {
      const identity = identities.find(entry => entry.runtimeId === id);
      if (!identity) continue;
      const operation =
        operations[marketplaceKey({ sourceId: identity.sourceId, id: identity.pluginId })];
      // Start the success grace period only after inventory refresh settles.
      // Actionable warnings must remain visible until the user resolves them.
      if (!operation || operation.busy || operation.warning || operation.restartRequired) continue;
      timers.push(
        window.setTimeout(() => {
          setRecentlyUpdated(current => {
            const next = new Set(current);
            next.delete(id);
            return next;
          });
        }, 1800),
      );
    }
    return () => timers.forEach(timer => window.clearTimeout(timer));
  }, [recentlyUpdated, identities, operations]);

  useEffect(() => {
    let active = true;
    setSource(undefined);
    setSourceError('');
    void window.electron.marketplace
      .listSources(kind)
      .then(response => {
        if (!active) return;
        if (!response.success) throw new Error(response.error);
        // The product integrates one market. There is deliberately no source selector.
        setSource(response.sources?.[0] ?? null);
      })
      .catch(() => {
        if (active) {
          setSource(null);
          setSourceError(i18nService.t('marketplaceLoadFailed'));
        }
      });
    return () => {
      active = false;
    };
  }, [kind, revision]);

  useEffect(() => {
    let active = true;
    setIdentityReady(false);
    if (!inventoryReady) return;
    const resolve = async () => {
      const result: MarketplaceInstallationIdentity[] = [];
      for (let start = 0; start < installed.length; start += 200) {
        const response = await window.electron.marketplace.resolveInstalled({
          kind,
          installed: installed
            .slice(start, start + 200)
            .map(({ id, installPath }) => ({ id, installPath })),
        });
        if (!response.success) throw new Error(response.error);
        result.push(...(response.installations ?? []));
      }
      if (active) {
        setIdentities(result);
        setIdentityReady(true);
      }
    };
    void resolve().catch(() => {
      if (active) setUpdateError(i18nService.t('marketplaceCheckFailed'));
    });
    return () => {
      active = false;
    };
  }, [kind, installed, checkRevision, inventoryReady]);

  const mapped = useMemo(() => {
    const result = new Map<string, InstalledMarketplacePlugin>();
    for (const identity of identities) {
      const local = installed.filter(item => item.id === identity.runtimeId);
      if (local.length === 1)
        result.set(
          marketplaceKey({ sourceId: identity.sourceId, id: identity.pluginId }),
          local[0],
        );
    }
    return result;
  }, [identities, installed]);

  useEffect(() => {
    if (inventoryReady && identityReady) owner.reconcile(new Set(mapped.keys()));
  }, [owner, mapped, identityReady, inventoryReady, operations]);

  useEffect(() => {
    let active = true;
    setCategories([]);
    setCategory('');
    if (source?.supportsCategories && discovering) {
      void window.electron.marketplace
        .listCategories({ kind, sourceId: source.id })
        .then(response => {
          if (active && response.success) setCategories(response.result?.categories ?? []);
        })
        .catch(() => undefined);
    }
    return () => {
      active = false;
    };
  }, [kind, source, discovering]);

  useEffect(() => {
    const generation = ++searchGeneration.current;
    setItems([]);
    setCursor(undefined);
    setPinnedKeys(new Set());
    setSearchError('');
    setLoadingMore(false);
    if (!source) {
      setLoading(false);
      return;
    }
    setLoading(true);
    const timer = window.setTimeout(() => {
      void window.electron.marketplace
        .search({
          kind,
          sourceId: source.id,
          query: query || undefined,
          ...(!query && category ? { categoryId: category } : {}),
          limit: query ? 60 : 8,
        })
        .then(response => {
          if (!mounted.current || generation !== searchGeneration.current) return;
          if (!response.success) throw new Error(response.error);
          setItems(response.result?.items ?? []);
          setCursor(response.result?.nextCursor);
        })
        .catch(() => {
          if (mounted.current && generation === searchGeneration.current)
            setSearchError(i18nService.t('marketplaceLoadFailed'));
        })
        .finally(() => {
          if (mounted.current && generation === searchGeneration.current) setLoading(false);
        });
    }, 300);
    return () => {
      window.clearTimeout(timer);
      searchGeneration.current += 1;
    };
  }, [kind, source, query, category]);

  useEffect(() => {
    let active = true;
    setUpdates([]);
    setChecking(false);
    if (!identityReady || !source) return;
    setUpdateError('');
    if (!source.supportsUpdates) {
      setChecking(false);
      return;
    }
    const eligible = [...mapped.values()].filter(item => item.updateEligible !== false);
    if (!eligible.length) {
      setChecking(false);
      return;
    }
    setChecking(true);
    const check = async () => {
      const candidates: MarketplacePlugin[] = [];
      for (let start = 0; start < eligible.length; start += 200) {
        const response = await window.electron.marketplace.checkUpdates({
          kind,
          installed: eligible.slice(start, start + 200).map(({ id, version }) => ({ id, version })),
        });
        if (!response.success) throw new Error(response.error);
        candidates.push(...(response.result?.updates ?? []));
      }
      if (active) setUpdates(candidates);
    };
    void check()
      .catch(() => {
        if (active) setUpdateError(i18nService.t('marketplaceCheckFailed'));
      })
      .finally(() => {
        if (active) setChecking(false);
      });
    return () => {
      active = false;
    };
  }, [kind, source, mapped, identityReady]);

  const updateById = useMemo(() => {
    const result = new Map<string, MarketplacePlugin>();
    // Bulk candidates take precedence over less complete search metadata.
    for (const item of [...items, ...updates]) {
      const key = marketplaceKey(item);
      const local = mapped.get(key);
      if (
        local &&
        local.updateEligible !== false &&
        item.installState === MarketplaceInstallState.UPDATE_AVAILABLE &&
        !(operations[key]?.committed && operations[key]?.version === item.version)
      ) {
        result.set(local.id, item);
      }
    }
    return result;
  }, [items, updates, mapped, operations]);
  const matchedIds = new Set(
    items.flatMap(item => {
      const local = mapped.get(marketplaceKey(item));
      return local ? [local.id] : [];
    }),
  );
  const pinnedIds = new Set(
    items.flatMap(item => {
      const key = marketplaceKey(item);
      const local = mapped.get(key);
      return pinnedKeys.has(key) && local ? [local.id] : [];
    }),
  );
  const matchesInstalled = (id: string, textMatches: boolean) =>
    !(filter === MarketplaceFilter.ALL && pinnedIds.has(id)) &&
    (filter !== MarketplaceFilter.UPDATES || updateById.has(id) || recentlyUpdated.has(id)) &&
    (textMatches || matchedIds.has(id));
  const operationFor = (id: string) => {
    const identity = identities.find(entry => entry.runtimeId === id);
    return identity
      ? operations[marketplaceKey({ sourceId: identity.sourceId, id: identity.pluginId })]
      : undefined;
  };
  const localFor = (item: MarketplacePlugin) => mapped.get(marketplaceKey(item));
  // Same-name local/bundled items are not market installations. Prevent accidental overwrite.
  const conflicts = (item: MarketplacePlugin) =>
    !localFor(item) && installed.some(local => local.id === (item.runtimeId || item.id));
  const visibleItems =
    filter === MarketplaceFilter.ALL
      ? items.filter(item => !localFor(item) || pinnedKeys.has(marketplaceKey(item)))
      : [];
  const refreshInventory = async (key: string) => {
    try {
      await owner.refresh(key);
    } catch {
      setOperations(current => ({
        ...current,
        [key]: {
          ...current[key],
          warning: i18nService.t('marketplaceRefreshAfterInstallFailed'),
        },
      }));
    }
  };
  const install = async (item: MarketplacePlugin) => {
    const local = localFor(item);
    const candidate = local ? updateById.get(local.id) : item;
    if (
      !candidate ||
      !inventoryReady ||
      !identityReady ||
      readOnly ||
      runtimeUnavailable ||
      conflicts(item)
    )
      return;
    const key = marketplaceKey(candidate);
    if (
      locks.has(key) ||
      (operations[key]?.committed && (!local || operations[key]?.version === candidate.version)) ||
      (!local && item.installState === MarketplaceInstallState.UNAVAILABLE)
    )
      return;
    locks.add(key);
    setOperations(current => ({ ...current, [key]: { busy: true } }));
    try {
      const response = await window.electron.marketplace.install({
        sourceId: candidate.sourceId,
        pluginId: candidate.id,
        kind,
        version: candidate.version,
        operation: local ? MarketplaceInstallOperation.UPDATE : MarketplaceInstallOperation.INSTALL,
      });
      if (!response.success)
        throw new Error(response.error || i18nService.t('marketplaceInstallFailed'));
      if (mounted.current && !local) setPinnedKeys(current => new Set(current).add(key));
      if (mounted.current && local) {
        setRecentlyUpdated(current => new Set(current).add(local.id));
      }
      setOperations(current => ({
        ...current,
        [key]: {
          busy: true,
          committed: true,
          version: candidate.version,
          restartRequired: response.restartRequired,
          message: i18nService
            .t(
              response.restartRequired
                ? 'marketplaceRestartRequired'
                : local
                  ? 'marketplaceUpdateSucceeded'
                  : 'marketplaceInstallSucceeded',
            )
            .replace('{name}', item.name),
        },
      }));
      await refreshInventory(key);
    } catch (error) {
      setOperations(current => ({
        ...current,
        [key]: {
          error: error instanceof Error ? error.message : i18nService.t('marketplaceInstallFailed'),
        },
      }));
    } finally {
      locks.delete(key);
      setOperations(current => ({ ...current, [key]: { ...current[key], busy: false } }));
    }
  };
  const loadMore = async () => {
    if (!source || !cursor || loadingMore) return;
    const generation = searchGeneration.current;
    setLoadingMore(true);
    setSearchError('');
    try {
      const response = await window.electron.marketplace.search({
        kind,
        sourceId: source.id,
        query: query || undefined,
        ...(!query && category ? { categoryId: category } : {}),
        limit: 60,
        cursor,
      });
      if (!mounted.current || generation !== searchGeneration.current) return;
      if (!response.success) throw new Error(response.error);
      setItems(current => [
        ...new Map(
          [...current, ...(response.result?.items ?? [])].map(item => [marketplaceKey(item), item]),
        ).values(),
      ]);
      setCursor(response.result?.nextCursor);
    } catch {
      if (mounted.current && generation === searchGeneration.current)
        setSearchError(i18nService.t('marketplaceLoadFailed'));
    } finally {
      if (mounted.current && generation === searchGeneration.current) setLoadingMore(false);
    }
  };
  return {
    kind,
    query,
    filter,
    setFilter,
    source,
    sourceError,
    categories,
    category,
    setCategory,
    loading,
    loadingMore,
    searchError,
    cursor,
    loadMore,
    visibleItems,
    updateById,
    updateError,
    checking,
    recentlyUpdated,
    localFor,
    conflicts,
    matchesInstalled,
    operationFor,
    operations,
    install,
    refreshInventory,
    readOnly,
    runtimeUnavailable,
    identityReady: inventoryReady && identityReady,
    retry: () => setRevision(value => value + 1),
    checkUpdates: () => setCheckRevision(value => value + 1),
  };
}

export type PluginMarketplaceController = ReturnType<typeof usePluginMarketplace>;
