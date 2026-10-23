import {
  type MarketplaceCategory,
  MarketplaceErrorCode,
  type MarketplaceInstallationIdentity,
  MarketplaceInstallOperation,
  type MarketplaceInstallResponse,
  MarketplaceInstallState,
  type MarketplacePlugin,
  type MarketplacePluginKind,
  type MarketplaceSource,
} from '@shared/plugins/marketplace';
import { PluginOperationAction, PluginOperationStage } from '@shared/plugins/pluginOperation';
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';

import {
  reportPluginOperationFailure,
  startPluginOperation,
} from '@/features/plugins/shared/pluginOperationService';
import { i18nService } from '@/services/i18n';

import { getMarketplaceOperationOwner } from './marketplaceOperationOwner';

export const MarketplaceFilter = {
  ALL: 'all',
  INSTALLED: 'installed',
  UPDATES: 'updates',
} as const;

const preparationFailureKeys: Partial<Record<PluginOperationStage, string>> = {
  [PluginOperationStage.FETCHING_METADATA]: 'marketplacePreparationFailure.fetching_metadata',
  [PluginOperationStage.DOWNLOADING]: 'marketplacePreparationFailure.downloading',
  [PluginOperationStage.EXTRACTING]: 'marketplacePreparationFailure.extracting',
};

const installFailurePresentation = (response: MarketplaceInstallResponse) => {
  const key =
    !response.success &&
    response.installationCommitted === true &&
    response.errorCode === MarketplaceErrorCode.INTERNAL &&
    response.error === 'Marketplace installation failed' &&
    response.failedStage === PluginOperationStage.ENABLING
      ? 'marketplaceActivationIncomplete'
      : response.errorCode === MarketplaceErrorCode.PROVIDER_FAILURE &&
          response.error === 'Marketplace provider failed to prepare installation' &&
          response.failedStage
        ? preparationFailureKeys[response.failedStage]
        : undefined;
  return {
    message: key ? i18nService.t(key) : response.error || i18nService.t('marketplaceInstallFailed'),
    ...(key && response.error ? { details: response.error } : {}),
  };
};
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
  unconfirmed?: boolean;
  error?: string;
  warning?: string;
  message?: string;
  version?: string;
  restartRequired?: boolean;
}
export const marketplaceKey = (item: Pick<MarketplacePlugin, 'sourceId' | 'id'>) =>
  JSON.stringify([item.sourceId, item.id]);

export function usePluginMarketplace(options: MarketplaceOptions) {
  const { kind, searchQuery, readOnly, runtimeUnavailable } = options;
  // Enable switches and native status notifications often replace the complete
  // inventory. Only catalog-relevant changes need new identity/update requests.
  const inventorySignature = JSON.stringify(options.installed);
  const installedSnapshot = useRef({ signature: inventorySignature, items: options.installed });
  if (installedSnapshot.current.signature !== inventorySignature) {
    installedSnapshot.current = { signature: inventorySignature, items: options.installed };
  }
  const installed = installedSnapshot.current.items;
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
  // Search results keep newly installed cards in place until the query changes.
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
    if (!inventoryReady || !identityReady) return;
    const expired = [...recentlyUpdated].filter(id => {
      const identity = identities.find(entry => entry.runtimeId === id);
      const operation = identity
        ? operations[marketplaceKey({ sourceId: identity.sourceId, id: identity.pluginId })]
        : undefined;
      // Keep updated cards until the session owner retires their success feedback.
      // Warnings and unconfirmed inventory must remain available across refreshes.
      return (
        !operation ||
        (!operation.busy &&
          !operation.message &&
          !operation.error &&
          !operation.warning &&
          !operation.restartRequired)
      );
    });
    if (!expired.length) return;
    setRecentlyUpdated(current => {
      const next = new Set(current);
      for (const id of expired) next.delete(id);
      return next;
    });
  }, [recentlyUpdated, identities, operations, inventoryReady, identityReady]);

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
        !operations[key]?.unconfirmed &&
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
  const operationFor = (id: string) => {
    const identity = identities.find(entry => entry.runtimeId === id);
    return identity
      ? operations[marketplaceKey({ sourceId: identity.sourceId, id: identity.pluginId })]
      : undefined;
  };
  const matchesInstalled = (id: string, textMatches: boolean) => {
    const operation = operationFor(id);
    const needsAttention = Boolean(
      (operation?.committed || operation?.unconfirmed) &&
      (operation.error || operation.warning || operation.restartRequired),
    );
    return (
      !(query && filter === MarketplaceFilter.ALL && pinnedIds.has(id)) &&
      (filter !== MarketplaceFilter.UPDATES ||
        updateById.has(id) ||
        recentlyUpdated.has(id) ||
        needsAttention) &&
      (textMatches || matchedIds.has(id))
    );
  };
  const localFor = (item: MarketplacePlugin) => mapped.get(marketplaceKey(item));
  // Same-name local/bundled items are not market installations. Prevent accidental overwrite.
  const conflicts = (item: MarketplacePlugin) =>
    !localFor(item) && installed.some(local => local.id === (item.runtimeId || item.id));
  const visibleItems =
    filter === MarketplaceFilter.ALL
      ? items.filter(item => discovering || !localFor(item) || pinnedKeys.has(marketplaceKey(item)))
      : [];
  const refreshInventory = async (
    key: string,
    operation?: ReturnType<typeof startPluginOperation>,
  ) => {
    try {
      await owner.refresh(key);
      return Boolean(optionsRef.current.onInstalled) && !owner.hasPendingRefresh(key);
    } catch {
      const failure = {
        message: i18nService.t('marketplaceRefreshAfterInstallFailed'),
        failedStage: PluginOperationStage.REFRESHING_INVENTORY,
        state: 'refresh_failed' as const,
      };
      if (operation) operation.fail(failure);
      else
        reportPluginOperationFailure(
          {
            kind,
            action: PluginOperationAction.SYNC,
            label:
              items.find(item => marketplaceKey(item) === key)?.name || i18nService.t('plugins'),
          },
          failure,
        );
      setOperations(current => ({
        ...current,
        [key]: {
          ...current[key],
          warning: i18nService.t('marketplaceRefreshAfterInstallFailed'),
        },
      }));
      return false;
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
      operations[key]?.unconfirmed ||
      (operations[key]?.committed && (!local || operations[key]?.version === candidate.version)) ||
      (!local && item.installState === MarketplaceInstallState.UNAVAILABLE)
    )
      return;
    locks.add(key);
    setOperations(current => ({ ...current, [key]: { busy: true } }));
    const operation = startPluginOperation({
      kind,
      action: local ? PluginOperationAction.UPDATE : PluginOperationAction.INSTALL,
      label: item.name,
    });
    let responseReceived = false;
    try {
      const response = await window.electron.marketplace.install(
        {
          sourceId: candidate.sourceId,
          pluginId: candidate.id,
          kind,
          version: candidate.version,
          operation: local
            ? MarketplaceInstallOperation.UPDATE
            : MarketplaceInstallOperation.INSTALL,
        },
        operation.context,
      );
      responseReceived = true;
      const failure = installFailurePresentation(response);
      if (!response.success) {
        operation.fail({
          ...failure,
          failedStage: response.failedStage,
          installationCommitted: response.installationCommitted,
          installSourceInUse: response.installSourceInUse,
          operationUnconfirmed: response.operationUnconfirmed,
        });
      }
      const failureMessage = response.failedStage
        ? `${i18nService
            .t('pluginOperationFailedAt')
            .replace(
              '{stage}',
              i18nService.t(`pluginOperationStage.${response.failedStage}`).replace(/…$/, ''),
            )}\n${failure.message}`
        : failure.message;
      if (!response.success && (response.installSourceInUse || response.operationUnconfirmed)) {
        setOperations(current => ({
          ...current,
          [key]: { ...current[key], unconfirmed: true, version: candidate.version },
        }));
      }
      if (!response.success && !response.installationCommitted) throw new Error(failureMessage);
      if (mounted.current && !local) setPinnedKeys(current => new Set(current).add(key));
      if (mounted.current && local && response.success) {
        setRecentlyUpdated(current => new Set(current).add(local.id));
      }
      setOperations(current => ({
        ...current,
        [key]: {
          ...current[key],
          busy: true,
          committed: true,
          version: candidate.version,
          restartRequired: response.restartRequired,
          ...(response.success
            ? {
                message: i18nService
                  .t(
                    response.restartRequired
                      ? 'marketplaceRestartRequired'
                      : local
                        ? 'marketplaceUpdateSucceeded'
                        : 'marketplaceInstallSucceeded',
                  )
                  .replace('{name}', item.name),
              }
            : { error: failureMessage }),
        },
      }));
      operation.stage(PluginOperationStage.REFRESHING_INVENTORY);
      const refreshed = await refreshInventory(key, operation);
      if (response.refreshWarning && !refreshed) {
        const message = i18nService.t('marketplaceRefreshAfterInstallFailed');
        operation.fail({
          message,
          failedStage: PluginOperationStage.REFRESHING_INVENTORY,
          state: 'refresh_failed',
        });
        setOperations(current => ({ ...current, [key]: { ...current[key], warning: message } }));
      }
    } catch (error) {
      const unconfirmed = !responseReceived;
      operation.fail({
        message: error instanceof Error ? error.message : i18nService.t('marketplaceInstallFailed'),
        ...(unconfirmed ? { operationUnconfirmed: true as const } : {}),
      });
      setOperations(current => ({
        ...current,
        [key]: {
          ...current[key],
          ...(unconfirmed ? { unconfirmed: true, version: candidate.version } : {}),
          error: error instanceof Error ? error.message : i18nService.t('marketplaceInstallFailed'),
        },
      }));
      if (unconfirmed || (responseReceived && owner.operations[key]?.unconfirmed)) {
        operation.stage(PluginOperationStage.REFRESHING_INVENTORY);
        await refreshInventory(key, operation);
      }
    } finally {
      operation.finish();
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
