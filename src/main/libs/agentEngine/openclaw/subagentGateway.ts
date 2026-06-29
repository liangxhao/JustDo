import type { GatewayClientLike } from '../gateway/types';

export const SUBAGENT_STATUSES = {
  RUNNING: 'running',
  DONE: 'done',
  FAILED: 'failed',
  KILLED: 'killed',
  TIMEOUT: 'timeout',
} as const;

export type SubagentStatus =
  (typeof SUBAGENT_STATUSES)[keyof typeof SUBAGENT_STATUSES];

export type GatewaySubagent = {
  id: string;
  sessionKey: string;
  label: string;
  status: SubagentStatus;
};

export const normalizeSubagentSessionKey = (sessionKey: string): string => {
  const key = sessionKey.trim();
  if (key.startsWith('subagent:')) return `agent:main:${key}`;
  return key.includes(':subagent:') ? key : '';
};

const isSubagentStatus = (value: unknown): value is SubagentStatus =>
  Object.values(SUBAGENT_STATUSES).includes(value as SubagentStatus);

const resolveStatus = (row: Record<string, unknown>): SubagentStatus => {
  if (row.hasActiveSubagentRun === true || row.subagentRunState === 'active') {
    return SUBAGENT_STATUSES.RUNNING;
  }
  if (isSubagentStatus(row.status)) return row.status;
  if (row.subagentRunState === 'interrupted') return SUBAGENT_STATUSES.FAILED;
  return SUBAGENT_STATUSES.DONE;
};

const resolveLabel = (row: Record<string, unknown>, sessionKey: string): string => {
  // OpenClaw's registry naming semantics first; session-derived fields are
  // fallbacks because older Gateway versions do not project taskName/task.
  for (const value of [
    row.label,
    row.taskName,
    row.task,
    row.derivedTitle,
    row.displayName,
  ]) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return sessionKey.split(':').at(-1) || 'Subagent';
};

/**
 * Mirrors OpenClaw's `/subagents` data source through the public Gateway API.
 * `sessions.list({ spawnedBy })` projects the same subagent run registry used by
 * `listControlledSubagentRuns`, including its authoritative runtime status.
 */
export const listGatewaySubagents = async (options: {
  client: GatewayClientLike;
  parentKeys: string[];
}): Promise<GatewaySubagent[]> => {
  const bySessionKey = new Map<string, GatewaySubagent>();

  for (const parentKey of options.parentKeys) {
    const result = await options.client.request<{
      sessions?: Array<Record<string, unknown>>;
    }>('sessions.list', {
      spawnedBy: parentKey,
      limit: 100,
      includeDerivedTitles: true,
    });

    for (const row of result.sessions ?? []) {
      const sessionKey = typeof row.key === 'string' ? row.key.trim() : '';
      if (!sessionKey || !sessionKey.includes(':subagent:')) continue;
      bySessionKey.set(sessionKey, {
        id: sessionKey,
        sessionKey,
        label: resolveLabel(row, sessionKey),
        status: resolveStatus(row),
      });
    }
  }

  return [...bySessionKey.values()];
};
