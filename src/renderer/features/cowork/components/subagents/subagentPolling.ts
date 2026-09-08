export const ACTIVE_SUBAGENT_POLL_INTERVAL_MS = 5_000;
export const IDLE_SUBAGENT_POLL_INTERVAL_MS = 30_000;

export const isActiveSubagentStatus = (status?: string): boolean =>
  status === 'pending' || status === 'running';

export const resolveSubagentPollInterval = (
  parentRunning: boolean,
  statuses: readonly string[],
): number =>
  parentRunning || statuses.some(isActiveSubagentStatus)
    ? ACTIVE_SUBAGENT_POLL_INTERVAL_MS
    : IDLE_SUBAGENT_POLL_INTERVAL_MS;
