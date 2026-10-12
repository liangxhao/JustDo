import type { MarketplacePluginKind } from '@shared/plugins/marketplace';

import { i18nService } from '@/services/i18n';

import type { MarketplaceOperation } from './usePluginMarketplace';

// Renderer-session ownership: navigation must not release an in-flight mutation.
// No inventory, credentials or provider payloads are retained here.
class MarketplaceOperationOwner {
  operations: Record<string, MarketplaceOperation> = {};
  readonly locks = new Set<string>();
  private readonly listeners = new Set<() => void>();
  private readonly refreshers = new Set<() => Promise<void>>();
  private readonly pendingRefresh = new Set<string>();
  private readonly observedInstalled = new Set<string>();

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  snapshot = () => this.operations;
  update = (
    change: (current: Record<string, MarketplaceOperation>) => Record<string, MarketplaceOperation>,
  ) => {
    this.operations = change(this.operations);
    // Bound settled session feedback; active mutations are never evicted.
    const settled = Object.keys(this.operations).filter(key => !this.operations[key].busy);
    for (const key of settled.slice(0, Math.max(0, settled.length - 100))) {
      delete this.operations[key];
      this.pendingRefresh.delete(key);
      this.observedInstalled.delete(key);
    }
    for (const listener of this.listeners) listener();
  };
  reconcile = (installedKeys: Set<string>) => {
    const retired: string[] = [];
    for (const [key, operation] of Object.entries(this.operations)) {
      if (!operation.committed) continue;
      if (installedKeys.has(key)) this.observedInstalled.add(key);
      else if (!operation.busy && this.observedInstalled.has(key)) retired.push(key);
    }
    if (!retired.length) return;
    this.update(current => {
      const next = { ...current };
      for (const key of retired) {
        delete next[key];
        this.observedInstalled.delete(key);
        this.pendingRefresh.delete(key);
      }
      return next;
    });
  };
  attachRefresh = (refresh: () => Promise<void>) => {
    this.refreshers.add(refresh);
    if (this.pendingRefresh.size) void this.refreshPending().catch(() => undefined);
    return () => {
      this.refreshers.delete(refresh);
    };
  };
  refresh = async (key: string) => {
    this.pendingRefresh.add(key);
    await this.refreshPending();
  };
  private refreshPending = async () => {
    const refreshers = [...this.refreshers];
    const refresh = refreshers[refreshers.length - 1];
    if (!refresh) return;
    const keys = [...this.pendingRefresh];
    try {
      await refresh();
    } catch (error) {
      this.update(current => {
        const next = { ...current };
        for (const key of keys)
          if (next[key])
            next[key] = {
              ...next[key],
              warning: i18nService.t('marketplaceRefreshAfterInstallFailed'),
            };
        return next;
      });
      throw error;
    }
    // A callback may finish after its view unmounts; keep reconciliation pending.
    if (!this.refreshers.has(refresh)) return;
    for (const key of keys) this.pendingRefresh.delete(key);
    this.update(current => {
      const next = { ...current };
      for (const key of keys) if (next[key]) next[key] = { ...next[key], warning: undefined };
      return next;
    });
  };
}

const owners = new WeakMap<object, Map<MarketplacePluginKind, MarketplaceOperationOwner>>();
export function getMarketplaceOperationOwner(bridge: object, kind: MarketplacePluginKind) {
  let kinds = owners.get(bridge);
  if (!kinds) {
    kinds = new Map();
    owners.set(bridge, kinds);
  }
  let owner = kinds.get(kind);
  if (!owner) {
    owner = new MarketplaceOperationOwner();
    kinds.set(kind, owner);
  }
  return owner;
}
