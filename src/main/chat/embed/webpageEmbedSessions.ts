import type { GatewayClientLike } from '../../engine/gateway/types';

interface SessionLease {
  key: string;
  sessionId?: string;
  owner?: string;
  current: boolean;
  retire: () => void;
}
const leases = new WeakMap<GatewayClientLike, Set<SessionLease>>();
const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

/** Ephemeral display ownership only; no session rows or transcript snapshots. */
export function captureWebpageEmbedSession(
  client: GatewayClientLike,
  key: string,
  expectedSessionId?: string,
) {
  let entries = leases.get(client);
  if (!entries) {
    entries = new Set();
    leases.set(client, entries);
  }
  const listeners = new Set<() => void>();
  const lease: SessionLease = {
    key,
    sessionId: expectedSessionId,
    current: true,
    retire: () => {
      if (!lease.current) return;
      lease.current = false;
      entries!.delete(lease);
      for (const listener of listeners) {
        try {
          listener();
        } catch {
          /* One display cannot prevent other leases from retiring. */
        }
      }
      listeners.clear();
    },
  };
  entries.add(lease);
  return {
    isCurrent: () => lease.current,
    bind(row: unknown): boolean {
      const value = record(row);
      if (
        !lease.current ||
        !value ||
        value.key !== key ||
        typeof value.sessionId !== 'string' ||
        !value.sessionId ||
        (lease.sessionId && value.sessionId !== lease.sessionId)
      ) {
        lease.retire();
        return false;
      }
      lease.sessionId = value.sessionId;
      if (value.owner !== undefined) lease.owner = JSON.stringify(value.owner);
      return true;
    },
    onRetired(listener: () => void): () => void {
      if (!lease.current) {
        listener();
        return () => {};
      }
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    release: lease.retire,
  };
}

export function retireWebpageEmbedSessions(client: GatewayClientLike | null): void {
  if (!client) return;
  for (const lease of [...(leases.get(client) ?? [])]) lease.retire();
  leases.delete(client);
}

export function observeWebpageEmbedSessionEvent(
  client: GatewayClientLike | null,
  event: string,
  payload: unknown,
): void {
  if (!client || !['sessions.changed', 'session.operation'].includes(event)) return;
  const value = record(payload);
  if (!value) return;
  const row = record(value.session) ?? value;
  const key =
    typeof row.key === 'string'
      ? row.key
      : typeof value.sessionKey === 'string'
        ? value.sessionKey
        : undefined;
  const reason = String(value.reason ?? value.operation ?? '').toLowerCase();
  const boundary = ['reset', 'delete', 'new'].includes(reason);
  for (const lease of [...(leases.get(client) ?? [])]) {
    if (key && key !== lease.key) continue;
    if (
      boundary ||
      (key &&
        typeof row.sessionId === 'string' &&
        lease.sessionId &&
        row.sessionId !== lease.sessionId) ||
      (key &&
        row.owner !== undefined &&
        lease.owner !== undefined &&
        JSON.stringify(row.owner) !== lease.owner)
    )
      lease.retire();
  }
}
