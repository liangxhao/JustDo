import type { SessionRuntimeSnapshot } from '@shared/cowork/sessionRun';

import type { CoworkSession } from '@/features/cowork/coworkTypes';

type RuntimePollingSession = Pick<CoworkSession, 'id' | 'status'>;

export const resolveBackgroundRuntimeSessionIds = (
  sessions: readonly RuntimePollingSession[],
  currentSessionId: string | null,
  runtimeActivity: Readonly<Record<string, boolean>>,
): string[] =>
  [
    ...new Set([
      ...sessions.filter(session => session.status === 'running').map(session => session.id),
      // Managed Team members are intentionally absent from the sidebar list.
      // Their admitted/unknown user turns still need normal receipt reconciliation.
      ...Object.keys(runtimeActivity).filter(sessionId => runtimeActivity[sessionId] === true),
    ]),
  ].filter(sessionId => sessionId !== currentSessionId && !sessionId.startsWith('temp-'));

export const resolveBackgroundRuntimeDiscoverySessionIds = (
  sessions: readonly RuntimePollingSession[],
  currentSessionId: string | null,
): string[] =>
  sessions
    .filter(session => session.id !== currentSessionId && !session.id.startsWith('temp-'))
    .map(session => session.id);

export const shouldContinueFullRuntimeScan = (
  status: Pick<SessionRuntimeSnapshot, 'known' | 'mainRunning' | 'subagentRunning' | 'running'>,
): boolean => !status.known || (status.running && !status.mainRunning && !status.subagentRunning);
