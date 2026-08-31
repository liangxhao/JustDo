import type { SessionRuntimeSnapshot } from '@shared/cowork/sessionRun';

import type { CoworkSession } from '@/features/cowork/coworkTypes';

type RuntimePollingSession = Pick<CoworkSession, 'id' | 'status'>;

export const resolveBackgroundRuntimeSessionIds = (
  sessions: readonly RuntimePollingSession[],
  currentSessionId: string | null,
  runtimeActivity: Readonly<Record<string, boolean>>,
): string[] =>
  sessions
    .filter(
      session =>
        session.id !== currentSessionId &&
        !session.id.startsWith('temp-') &&
        (session.status === 'running' || runtimeActivity[session.id] === true),
    )
    .map(session => session.id);

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
