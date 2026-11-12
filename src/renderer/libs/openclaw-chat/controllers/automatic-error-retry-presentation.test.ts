import {
  AutomaticErrorRetryDisposition as Disposition,
  AutomaticErrorRetryPhase as Phase,
  type AutomaticErrorRetryPresentation,
} from '@shared/cowork/automaticErrorRetry';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AutomaticErrorRetryPresentationController } from './automatic-error-retry-presentation';

const binding = { sessionKey: 'agent:main:justdo:session', nativeSessionId: 'native' };
const failure = { role: 'assistant', content: [{ type: 'text', text: 'terminal failure' }],
  runId: 'run', stopReason: 'error', errorMessage: 'terminal failure' };
const snapshot = (overrides: Partial<AutomaticErrorRetryPresentation> = {}): AutomaticErrorRetryPresentation => ({
  sessionId: 'session', chainId: 'chain', revision: 1, phase: Phase.Preparing,
  attempt: 1, maxContinuations: 2,
  runs: [{ ...binding, lifecycleRevision: 'revision', chainId: 'chain', attempt: 0,
    maxContinuations: 2, disposition: Disposition.Pending, runId: 'run', clientTurnId: 'turn' }],
  ...overrides,
});
async function fixture(initial = snapshot()) {
  let changed!: (value: AutomaticErrorRetryPresentation) => void;
  const remove = vi.fn();
  const notify = vi.fn();
  const controller = new AutomaticErrorRetryPresentationController(notify, () => ({
    getAutomaticErrorRetry: vi.fn(async () => ({ success: true, presentations: [initial] })),
    onAutomaticErrorRetryChanged: listener => { changed = listener; return remove; },
  }));
  controller.selectSession('session');
  await Promise.resolve();
  await Promise.resolve();
  return { controller, changed, remove, notify };
}
afterEach(() => vi.useRealTimers());

describe('automatic error retry presentation subscription', () => {
  it('selects hidden runs only for the exact native session binding', async () => {
    const f = await fixture();
    const input = [failure];
    const hidden = f.controller.hiddenRuns(binding, input, null);
    expect([...hidden]).toEqual(['run']);
    expect(f.controller.hiddenRuns({ ...binding, nativeSessionId: 'foreign' }, input, null).size).toBe(0);
    f.controller.dispose();
  });

  it('holds an exact candidate until the Main decision even after the old display timeout', async () => {
    vi.useFakeTimers();
    const candidate = snapshot({ phase: Phase.Eligible });
    candidate.runs[0].disposition = Disposition.Candidate;
    const f = await fixture(candidate);
    const hidden = f.controller.hiddenRuns(binding, [failure], null);
    expect(hidden.has('run')).toBe(true);
    expect(f.controller.progress(binding, hidden)?.phase).toBe(Phase.Eligible);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(f.controller.hiddenRuns(binding, [failure], null).has('run')).toBe(true);
    f.changed(snapshot({ revision: 2, phase: Phase.Failed, runs: [{ ...candidate.runs[0], disposition: Disposition.Final }] }));
    expect(f.controller.hiddenRuns(binding, [failure], null).size).toBe(0);
    f.controller.dispose();
  });

  it('hydrates historical associations and keeps a pending unknown outcome hidden', async () => {
    const f = await fixture(snapshot({ phase: Phase.Completed }));
    f.changed(snapshot({ revision: 3, phase: Phase.Running }));
    f.changed(snapshot({ revision: 2, phase: Phase.Unknown }));
    expect(f.controller.hiddenRuns(binding, [failure], null).has('run')).toBe(true);
    f.changed(snapshot({ revision: 4, phase: Phase.Unknown }));
    const hidden = f.controller.hiddenRuns(binding, [failure], null);
    expect(hidden.has('run')).toBe(true);
    expect(f.controller.progress(binding, hidden)?.phase).toBe(Phase.Unknown);
    f.controller.dispose();
    expect(f.remove).toHaveBeenCalledOnce();
  });

});
