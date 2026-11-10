import {
  AutomaticErrorRetryDisposition,
  AutomaticErrorRetryPhase,
  type AutomaticErrorRetryPresentation,
} from '../../../../shared/cowork/automaticErrorRetry';
import type { SessionRunTiming } from '../../../../shared/cowork/sessionRun';

/** Durable associations affect display only; never reconstruct an active retry. */
export function buildRetryHistoryPresentations(
  sessionId: string,
  timings: SessionRunTiming[],
): AutomaticErrorRetryPresentation[] {
  const groups = new Map<string, AutomaticErrorRetryPresentation>();
  for (const timing of timings) {
    const metadata = timing.automaticErrorRetry;
    if (!metadata) continue;
    let group = groups.get(metadata.chainId);
    if (!group) {
      group = {
        sessionId,
        chainId: metadata.chainId,
        revision: 0,
        phase: AutomaticErrorRetryPhase.Failed,
        attempt: metadata.attempt,
        maxContinuations: metadata.maxContinuations,
        runs: [],
      };
      groups.set(metadata.chainId, group);
    }
    group.attempt = Math.max(group.attempt, metadata.attempt);
    group.runs.push({
      ...metadata,
      // An interrupted process cannot prove that a pending continuation was admitted.
      disposition:
        metadata.disposition === AutomaticErrorRetryDisposition.Superseded
          ? metadata.disposition
          : AutomaticErrorRetryDisposition.Final,
      runId: timing.rootRunId ?? timing.clientTurnId,
      clientTurnId: timing.clientTurnId,
    });
  }
  return [...groups.values()];
}
