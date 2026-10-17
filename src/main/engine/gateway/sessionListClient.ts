import type { GatewayClientLike } from './types';

// Other RPCs conservatively end the sharing window: a mutation may become
// visible before its sessions.changed notification reaches this connection.
const SESSION_LIST_OBSERVERS = new Set([
  'sessions.list', 'sessions.describe', 'models.list', 'config.get',
  'exec.approvals.get', 'chat.history',
]);

function requestKey(params: unknown): string | null {
  if (!params || typeof params !== 'object' || Array.isArray(params)) return null;
  const entries = Object.entries(params).filter(([, value]) => value !== undefined);
  if (entries.some(([, value]) => value !== null && !['string', 'number', 'boolean'].includes(typeof value))) return null;
  return JSON.stringify(entries.sort(([a], [b]) => a.localeCompare(b)));
}

/** Share identical in-flight reads only; never retain a settled session row. */
export class SessionListClient implements GatewayClientLike {
  private readonly pending = new Map<string, { task: Promise<unknown>; joins: number }>();
  private revision = 0;

  constructor(private readonly client: GatewayClientLike) {}

  invalidateSessionLists(): void { this.revision += 1; this.pending.clear(); }
  start(): void { this.invalidateSessionLists(); this.client.start(); }
  stop(): void { this.invalidateSessionLists(); this.client.stop(); }

  request<T = Record<string, unknown>>(
    method: string,
    params?: unknown,
    options?: Parameters<GatewayClientLike['request']>[2],
  ): Promise<T> {
    if (!SESSION_LIST_OBSERVERS.has(method)) {
      this.invalidateSessionLists();
      return this.client.request<T>(method, params, options)
        .finally(() => this.invalidateSessionLists());
    }
    const paramsKey = method === 'sessions.list' && !options?.signal && !options?.expectFinal
      ? requestKey(params) : null;
    if (paramsKey === null) return this.client.request<T>(method, params, options);
    const key = `${paramsKey}:${options?.timeoutMs ?? 'default'}`;
    const pending = this.pending.get(key);
    if (pending) {
      pending.joins += 1;
      return pending.task as Promise<T>;
    }
    const revision = this.revision;
    const task = this.client.request<T>(method, params, options).finally(() => {
      if (this.pending.get(key) === entry) this.pending.delete(key);
      try {
        if (entry.joins) console.info('[SessionListClient] Coalesced concurrent reads', {
          avoidedRequests: entry.joins,
          rowMode: (params as { rowMode?: string }).rowMode === 'compact' ? 'compact' : 'full',
        });
      } catch { /* Diagnostics must not change the read outcome. */ }
    });
    const entry = { task, joins: 0 };
    if (this.revision === revision) this.pending.set(key, entry);
    return task;
  }
}

export function invalidateSessionListRequests(client: GatewayClientLike | null): void {
  if (client instanceof SessionListClient) client.invalidateSessionLists();
}
