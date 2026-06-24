import type { GatewayClientLike } from '../gateway/types';

export type SubagentStatus = 'pending' | 'running' | 'done' | 'failed';

export type PersistedSubagentCacheRow = {
  toolCallId: string;
  parentSessionId: string;
  childSessionKey: string | null;
  label: string;
  status: SubagentStatus;
};

export type GatewaySubagent = {
  id: string;
  sessionKey: string;
  label: string;
  status: SubagentStatus;
  toolCallId?: string;
};

export type SubagentStatusView = {
  statuses: Record<string, SubagentStatus>;
  displayLabels: Record<string, string>;
  sessionKeys: Record<string, string>;
  subagents: Array<{
    id: string;
    sessionKey: string;
    label: string;
    status: SubagentStatus;
  }>;
};

export const normalizeSubagentSessionKey = (sessionKey: string): string => {
  const key = sessionKey.trim();
  if (!key) return '';
  if (key.startsWith('subagent:')) return `agent:main:${key}`;
  if (!key.includes(':subagent:')) return '';
  return key;
};

export const normalizeGatewaySubagentStatus = (
  row: Record<string, unknown>,
): SubagentStatus => {
  const status = typeof row.status === 'string' ? row.status.toLowerCase() : '';
  const runState =
    typeof row.subagentRunState === 'string' ? row.subagentRunState.toLowerCase() : '';
  const active = row.hasActiveSubagentRun === true;
  const endedAt =
    (typeof row.endedAt === 'number' && Number.isFinite(row.endedAt)) ||
    (typeof row.endedAt === 'string' && row.endedAt.trim() !== '');
  const startedAt =
    (typeof row.startedAt === 'number' && Number.isFinite(row.startedAt)) ||
    (typeof row.startedAt === 'string' && row.startedAt.trim() !== '');

  if (active || runState === 'active') return 'running';
  if (
    endedAt &&
    ['failed', 'error', 'killed', 'timeout', 'timed_out', 'cancelled'].includes(status)
  ) {
    return 'failed';
  }
  if (
    endedAt ||
    ['done', 'ok', 'completed', 'complete'].includes(status) ||
    runState === 'historical'
  ) {
    return 'done';
  }
  if (status === 'running') return 'running';
  return startedAt ? 'running' : 'pending';
};

export const buildSubagentStatusView = (
  subagents: GatewaySubagent[],
): SubagentStatusView => {
  const statuses: Record<string, SubagentStatus> = {};
  const displayLabels: Record<string, string> = {};
  const sessionKeys: Record<string, string> = {};
  const byId = new Map<
    string,
    {
      id: string;
      sessionKey: string;
      label: string;
      status: SubagentStatus;
    }
  >();

  const addAlias = (id: string, subagent: GatewaySubagent) => {
    if (!id) return;
    statuses[id] = subagent.status;
    displayLabels[id] = subagent.label;
    if (subagent.sessionKey) sessionKeys[id] = subagent.sessionKey;
  };

  for (const subagent of subagents) {
    const normalizedSessionKey =
      normalizeSubagentSessionKey(subagent.sessionKey) || subagent.sessionKey;
    const primaryId = normalizedSessionKey || subagent.id;
    byId.set(primaryId, {
      id: primaryId,
      sessionKey: subagent.sessionKey,
      label: subagent.label,
      status: subagent.status,
    });

    addAlias(primaryId, subagent);
    addAlias(subagent.id, subagent);
    addAlias(subagent.sessionKey, subagent);
    addAlias(normalizedSessionKey, subagent);
    if (subagent.toolCallId) addAlias(subagent.toolCallId, subagent);
  }

  return {
    statuses,
    displayLabels,
    sessionKeys,
    subagents: Array.from(byId.values()),
  };
};

export const listGatewaySubagents = async (options: {
  client: GatewayClientLike;
  parentKeys: string[];
  persistedRows: PersistedSubagentCacheRow[];
  getLabel: (sessionKey: string, persisted?: PersistedSubagentCacheRow) => string;
}): Promise<GatewaySubagent[]> => {
  const byKey = new Map<string, GatewaySubagent>();

  for (const parentKey of options.parentKeys) {
    const result = await options.client.request<{
      sessions?: Array<Record<string, unknown>>;
    }>('sessions.list', {
      spawnedBy: parentKey,
      limit: 100,
      includeLastMessage: true,
    });

    for (const row of result.sessions ?? []) {
      const sessionKey = typeof row.key === 'string' ? row.key : '';
      if (!sessionKey) continue;
      const normalizedSessionKey = normalizeSubagentSessionKey(sessionKey) || sessionKey;
      const persisted = options.persistedRows.find(cacheRow => {
        const childSessionKey = cacheRow.childSessionKey || '';
        return (
          childSessionKey === sessionKey ||
          normalizeSubagentSessionKey(childSessionKey) === normalizedSessionKey
        );
      });

      byKey.set(sessionKey, {
        id: normalizedSessionKey,
        sessionKey,
        label: options.getLabel(sessionKey, persisted),
        status: normalizeGatewaySubagentStatus(row),
        toolCallId: persisted?.toolCallId,
      });
    }
  }

  return Array.from(byKey.values());
};
