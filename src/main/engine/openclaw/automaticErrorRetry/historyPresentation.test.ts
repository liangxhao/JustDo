import { expect, it } from 'vitest';

import type { SessionRunTiming } from '../../../../shared/cowork/sessionRun';
import { buildRetryHistoryPresentations } from './historyPresentation';

it('restores handled failures without restoring pending decisions or execution', () => {
  for (const disposition of ['candidate', 'pending', 'superseded'] as const) {
    const timing: SessionRunTiming = {
      id: 'receipt',
      sessionId: 'product',
      clientTurnId: 'input',
      rootRunId: 'native-run',
      startedAt: 1,
      state: 'failed',
      endedAt: 2,
      automaticErrorRetry: {
        chainId: 'chain',
        attempt: 0,
        maxContinuations: 1,
        sessionKey: 'agent:main:justdo:product',
        nativeSessionId: 'physical',
        lifecycleRevision: 'revision',
        disposition,
      },
    };

    const [result] = buildRetryHistoryPresentations('product', [timing]);

    expect(result.phase).toBe('failed');
    expect(result.runs[0]).toMatchObject({
      runId: 'native-run',
      nativeSessionId: 'physical',
      disposition: disposition === 'superseded' ? 'superseded' : 'final',
    });
  }
});
