import { describe, expect, it } from 'vitest';

import {
  createResultBudgetTracker,
  resultBudgetAttempt,
} from '../../service/result-budget';

const sessionKey = 'agent:main:subagent:swarm-workflow-work';
const traceId = 'a'.repeat(32);
const spanId = 'b'.repeat(16);
const modelTrace = { traceId, parentSpanId: spanId, spanId: 'c'.repeat(16) };
const attempt = resultBudgetAttempt({ traceId, spanId })!;

describe('Workflow result budgets from public native model-call events', () => {
  it('uses the actual resolved cap instead of the model catalog window', () => {
    const tracker = createResultBudgetTracker();
    expect(tracker.read(sessionKey, 'run', attempt)).toBe(2000);
    tracker.observe({ sessionKey, runId: 'run', contextTokenBudget: 8000 }, modelTrace);
    expect(tracker.read(sessionKey, 'run', attempt)).toBe(4000);
    expect(tracker.read(sessionKey, 'other', attempt)).toBe(2000);
    expect(tracker.read(sessionKey + '-other', 'run', attempt)).toBe(2000);
  });
  it.each([2000, 3999, 4000, 32768, 131072])(
    'honors a native cap of %s without inflating it',
    contextTokenBudget => {
      const tracker = createResultBudgetTracker();
      tracker.observe({ sessionKey, runId: 'run', contextTokenBudget }, modelTrace);
      expect(tracker.read(sessionKey, 'run', attempt)).toBe(
        Math.min(12000, Math.floor(contextTokenBudget / 2)),
      );
    },
  );
  it('cannot widen a lower cap through delayed observations and falls back on missing evidence', () => {
    const tracker = createResultBudgetTracker();
    tracker.observe({ sessionKey, runId: 'run', contextTokenBudget: 32768 }, modelTrace);
    tracker.observe({ sessionKey, runId: 'run', contextTokenBudget: 4000 }, modelTrace);
    tracker.observe({ sessionKey, runId: 'run', contextTokenBudget: 32768 }, modelTrace);
    expect(tracker.read(sessionKey, 'run', attempt)).toBe(2000);
    tracker.observe({ sessionKey, runId: 'run', contextTokenBudget: 1000 }, modelTrace);
    expect(tracker.read(sessionKey, 'run', attempt)).toBe(500);
    tracker.observe({ sessionKey, runId: 'other', contextTokenBudget: NaN }, modelTrace);
    expect(tracker.read(sessionKey, 'other', attempt)).toBe(2000);
  });
  it('ignores unrelated sessions and clears metadata when runs or the service end', () => {
    const tracker = createResultBudgetTracker();
    tracker.observe(
      {
        sessionKey: 'agent:main:justdo:parent',
        runId: 'run',
        contextTokenBudget: 32768,
      },
      modelTrace,
    );
    expect(tracker.read(sessionKey, 'run', attempt)).toBe(2000);
    tracker.observe({ sessionKey, runId: 'run', contextTokenBudget: 32768 }, modelTrace);
    tracker.release(sessionKey, 'run');
    expect(tracker.read(sessionKey, 'run', attempt)).toBe(2000);
    tracker.observe({ sessionKey, runId: 'run', contextTokenBudget: 32768 }, modelTrace);
    tracker.clear();
    expect(tracker.read(sessionKey, 'run', attempt)).toBe(2000);
  });
  it('bounds retained metadata without making evicted entries appear authoritative', () => {
    const tracker = createResultBudgetTracker();
    for (let i = 0; i < 600; i++)
      tracker.observe({ sessionKey, runId: String(i), contextTokenBudget: 32768 }, modelTrace);
    expect(tracker.read(sessionKey, '0', attempt)).toBe(2000);
    expect(tracker.read(sessionKey, '599', attempt)).toBe(12000);
  });
  it('cannot apply a delayed old high-budget event to the next attempt of the same run', () => {
    const tracker = createResultBudgetTracker();
    const next = { traceId, spanId: 'd'.repeat(16) };
    tracker.observe({ sessionKey, runId: 'run', contextTokenBudget: 32768 }, modelTrace);
    tracker.release(sessionKey, 'run');
    // A callback queued before release arrives while the next callback is still queued.
    tracker.observe({ sessionKey, runId: 'run', contextTokenBudget: 32768 }, modelTrace);
    expect(tracker.read(sessionKey, 'run', next)).toBe(2000);
    tracker.observe(
      { sessionKey, runId: 'run', contextTokenBudget: 1000 },
      { traceId, parentSpanId: next.spanId },
    );
    expect(tracker.read(sessionKey, 'run', next)).toBe(500);
    expect(tracker.read(sessionKey, 'run', { ...attempt, traceId: 'e'.repeat(32) })).toBe(2000);
    tracker.release(sessionKey, 'run');
    expect(tracker.read(sessionKey, 'run', next)).toBe(2000);
    expect(tracker.read(sessionKey, 'run', attempt)).toBe(2000);
  });
  it('uses the conservative fallback when model or tool attempt identity is missing', () => {
    const tracker = createResultBudgetTracker();
    tracker.observe({ sessionKey, runId: 'run', contextTokenBudget: 32768 });
    expect(tracker.read(sessionKey, 'run', attempt)).toBe(2000);
    tracker.observe({ sessionKey, runId: 'run', contextTokenBudget: 32768 }, modelTrace);
    expect(tracker.read(sessionKey, 'run')).toBe(2000);
    expect(resultBudgetAttempt({ traceId: '0'.repeat(32), spanId })).toBeUndefined();
    expect(resultBudgetAttempt({ traceId, spanId: '0'.repeat(16) })).toBeUndefined();
    expect(resultBudgetAttempt({ traceId, spanId: 'unknown' })).toBeUndefined();
  });
});
