import { describe, expect, it } from 'vitest';

import type { SessionTurn } from '../../engine/gateway/types';
import { GoalEventAdmission } from './goalEventAdmission';

const event = { sessionKey: 'agent:main:justdo:session-1', runId: 'run-1',
  sessionId: 'native-1', lifecycleGeneration: 'generation-1', agentSeq: 1 };

function fixture() {
  let active: SessionTurn | undefined = {
    sessionId: 'session-1', sessionKey: event.sessionKey, runId: event.runId,
    gatewaySessionId: event.sessionId, lifecycleGeneration: event.lifecycleGeneration,
    lastAgentSeq: 0, status: 'running', turnToken: 1, stopRequested: false,
    knownRunIds: new Set([event.runId]),
  };
  const admission = new GoalEventAdmission(() => active);
  return { admission, setActive: (value: SessionTurn | undefined) => { active = value; },
    getActive: () => active! };
}

describe('Goal event admission', () => {
  it.each([
    { sessionId: 'old-native' }, { lifecycleGeneration: 'old-generation' },
    { runId: 'old-run' }, { sessionKey: 'agent:other:justdo:session-1' },
    { agentSeq: 0 }, { agentSeq: -1 }, { sessionId: null },
    { agentSeq: undefined },
  ])('rejects stale or incomplete identity %j before changing state', patch => {
    const f = fixture();
    expect(f.admission.admit('session-1', { ...event, ...patch })).toBe(false);
    expect(f.admission.admit('session-1', event)).toBe(true);
  });

  it('admits native public events without the internal lifecycle generation', () => {
    const f = fixture();
    f.setActive({ ...f.getActive(), lifecycleGeneration: null });
    const wireEvent = { ...event, lifecycleGeneration: undefined };
    expect(f.admission.admit('session-1', wireEvent)).toBe(true);
    f.setActive(undefined);
    expect(f.admission.admit('session-1', { ...wireEvent, agentSeq: 2 })).toBe(true);
    expect(f.admission.admit('session-1', { ...wireEvent, agentSeq: 3, sessionId: 'old-native' })).toBe(false);
  });

  it('retains exact late events after chat final, rejecting duplicates and other incarnations', () => {
    const f = fixture();
    expect(f.admission.admit('session-1', event)).toBe(true);
    f.setActive(undefined);
    expect(f.admission.admit('session-1', event)).toBe(false);
    expect(f.admission.admit('session-1', { ...event, agentSeq: 2, sessionId: 'old-native' })).toBe(false);
    expect(f.admission.admit('session-1', { ...event, agentSeq: 2, lifecycleGeneration: 'old' })).toBe(false);
    expect(f.admission.admit('session-1', { ...event, agentSeq: 2 })).toBe(true);
  });

  it('only replaces the retained run when Main owns the exact successor', () => {
    const f = fixture();
    expect(f.admission.admit('session-1', event)).toBe(true);
    const successor = { ...event, runId: 'run-2', sessionId: 'native-2', agentSeq: 1 };
    expect(f.admission.admit('session-1', successor)).toBe(false);
    f.setActive({ ...f.getActive(), runId: successor.runId, gatewaySessionId: successor.sessionId });
    expect(f.admission.admit('session-1', successor)).toBe(true);
    expect(f.admission.admit('session-1', { ...event, agentSeq: 2 })).toBe(false);
  });

  it.each(['clear', 'clearSession'] as const)('forgets retired runs on %s', method => {
    const f = fixture();
    expect(f.admission.admit('session-1', event)).toBe(true);
    f.admission[method]('session-1');
    f.setActive(undefined);
    expect(f.admission.admit('session-1', { ...event, agentSeq: 2 })).toBe(false);
  });
});
