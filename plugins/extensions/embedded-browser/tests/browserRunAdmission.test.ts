import { describe, expect, it, vi } from 'vitest';

import { type BrowserExecutionRun } from '../browserExecutionContract';
import { BrowserRunAdmission, isBrowserSessionCandidate } from '../browserRunAdmission';

const desktop: BrowserExecutionRun = {
  sessionKey: 'agent:main:justdo:product-session',
  sessionId: 'native-session',
  runId: 'native-run',
  workspaceDir: 'E:\\workspace\\task',
  trigger: 'user',
};
const cron: BrowserExecutionRun = {
  ...desktop,
  sessionKey: 'agent:main:cron:job:run:native-session',
  trigger: 'cron',
  jobId: 'job',
};

function fixture(identity = desktop) {
  let entry: { sessionId: string; lifecycleRevision?: string } | undefined = {
    sessionId: identity.sessionId,
    lifecycleRevision: 'generation-one',
  };
  const readEntry = vi.fn(() => entry);
  const released = vi.fn();
  const revoked = vi.fn();
  const admission = new BrowserRunAdmission(readEntry, released, revoked);
  const assertInvocationCurrent = vi.fn();
  const authority = { allows: vi.fn(() => true), assertActive: vi.fn() };
  const signal = new AbortController();
  const toolContext = { ...identity, toolCallId: 'call', abortSignal: signal.signal };
  admission.activate();
  return {
    admission,
    authority,
    released,
    revoked,
    readEntry,
    signal,
    toolContext,
    assertInvocationCurrent,
    setEntry: (value: typeof entry) => {
      entry = value;
    },
    observe: (overrides = {}) =>
      admission.observeRun({ ...identity, toolAuthority: authority, ...overrides }),
    prepare: () => admission.prepareToolCall(toolContext),
    claim: () =>
      admission.claimToolCall(
        identity.sessionKey,
        identity.sessionId,
        'call',
        assertInvocationCurrent,
      ),
  };
}

describe('embedded browser native run admission', () => {
  it.each([desktop, cron])('binds the trusted $trigger run and its exact tool call', identity => {
    const f = fixture(identity);
    f.observe();
    f.prepare();
    const call = f.claim();
    expect(call.run).toEqual(identity);
    expect(call.signal).toBe(f.signal.signal);
    expect(f.authority.allows).toHaveBeenCalledExactlyOnceWith('browser');
    expect(f.assertInvocationCurrent).toHaveBeenCalledOnce();
    call.assertCurrent();
    expect(f.assertInvocationCurrent).toHaveBeenCalledTimes(2);
    expect(() => f.claim()).toThrow('authority');
    call.release();
    expect(() => call.assertCurrent()).toThrow('authority');
  });

  it('treats cron key shapes as directory candidates without granting execution', () => {
    const f = fixture(cron);
    expect(isBrowserSessionCandidate(cron.sessionKey)).toBe(true);
    expect(() => f.prepare()).toThrow('authority');
    f.observe({ trigger: 'user', jobId: undefined });
    expect(() => f.prepare()).toThrow('authority');
    f.observe({ trigger: 'cron', jobId: undefined });
    expect(() => f.prepare()).toThrow('authority');
  });

  it.each([
    { trigger: undefined },
    { trigger: 'heartbeat' },
    { runId: undefined },
    { sessionId: 'foreign-incarnation' },
    { workspaceDir: undefined },
    { toolAuthority: undefined },
  ])('rejects missing or mismatched trusted run context %j', overrides => {
    const f = fixture();
    f.observe(overrides);
    expect(() => f.prepare()).toThrow('authority');
  });

  it('requires finalized browser authority and does not retain the hook capability', () => {
    const f = fixture();
    f.authority.allows.mockReturnValue(false);
    f.observe();
    expect(() => f.prepare()).toThrow('authority');
    f.authority.allows.mockReturnValue(true);
    f.observe();
    f.authority.assertActive.mockImplementation(() => {
      throw new Error('hook has returned');
    });
    f.prepare();
    expect(() => f.claim()).not.toThrow();
  });

  it('revokes a previously admitted run if its final tool surface changes', () => {
    const f = fixture();
    f.observe();
    f.authority.allows.mockReturnValue(false);
    f.observe();
    expect(() => f.prepare()).toThrow('authority');
    expect(f.released).toHaveBeenCalledExactlyOnceWith({
      run: desktop,
      reason: 'revoked',
      discardPages: true,
    });
  });

  it.each([
    { sessionId: 'replacement', lifecycleRevision: 'generation-one' },
    { sessionId: desktop.sessionId, lifecycleRevision: 'generation-two' },
    undefined,
  ])('checks native incarnation and lifecycle generation again at execution', replacement => {
    const f = fixture();
    f.observe();
    f.prepare();
    f.setEntry(replacement);
    expect(() => f.claim()).toThrow('authority');
    expect(f.released).toHaveBeenCalledWith({
      run: desktop,
      reason: 'revoked',
      discardPages: true,
    });
  });

  it('rejects mismatched, duplicate, finished and aborted tool calls', () => {
    const f = fixture();
    f.observe();
    expect(() => f.admission.prepareToolCall({ ...f.toolContext, runId: 'other-run' })).toThrow();
    expect(() =>
      f.admission.prepareToolCall({ ...f.toolContext, sessionId: 'other-session' }),
    ).toThrow();
    f.prepare();
    expect(() => f.prepare()).toThrow();
    expect(() =>
      f.admission.claimToolCall(desktop.sessionKey, desktop.sessionId, 'other-call', vi.fn()),
    ).toThrow();
    f.admission.finishToolCall({ ...f.toolContext, runId: 'other-run' });
    const call = f.claim();
    f.signal.abort();
    expect(() => call.assertCurrent()).toThrow();
    f.admission.finishToolCall(f.toolContext);
    expect(() => f.claim()).toThrow();
  });

  it('checks the native final-effect guard and rejects retained invocations', () => {
    const f = fixture();
    f.observe();
    f.prepare();
    const call = f.claim();
    f.assertInvocationCurrent.mockImplementation(() => {
      throw new Error('native dispatch closed');
    });
    expect(() => call.assertCurrent()).toThrow('native dispatch closed');
  });

  it('revokes effects after the tool result without requiring a settled terminal', () => {
    const f = fixture();
    f.observe();
    f.prepare();
    const call = f.claim();
    call.release();
    f.admission.finishToolCall(f.toolContext);
    expect(f.released).not.toHaveBeenCalled();

    f.signal.abort();

    expect(f.revoked).toHaveBeenCalledExactlyOnceWith({ run: desktop });
    expect(f.released).not.toHaveBeenCalled();
    expect(() => f.prepare()).toThrow('authority');
    f.observe();
    expect(() => f.prepare()).toThrow('authority');
  });

  it('retains concurrent native cancellation sources and removes all on revocation', () => {
    const f = fixture();
    f.observe();
    const second = new AbortController();
    const executeSource = new AbortController();
    const removeFirst = vi.spyOn(f.signal.signal, 'removeEventListener');
    const removeSecond = vi.spyOn(second.signal, 'removeEventListener');
    const removeExecute = vi.spyOn(executeSource.signal, 'removeEventListener');
    f.prepare();
    const firstCall = f.claim();
    firstCall.retainCancellation(f.signal.signal);
    firstCall.retainCancellation(executeSource.signal);
    f.admission.prepareToolCall({
      ...f.toolContext,
      toolCallId: 'second',
      abortSignal: second.signal,
    });
    firstCall.release();

    executeSource.abort();

    expect(f.revoked).toHaveBeenCalledExactlyOnceWith({ run: desktop });
    expect(f.released).not.toHaveBeenCalled();
    expect(removeFirst).toHaveBeenCalledTimes(1);
    expect(removeSecond).toHaveBeenCalledTimes(1);
    expect(removeExecute).toHaveBeenCalledTimes(1);
    f.signal.abort();
    second.abort();
    expect(f.revoked).toHaveBeenCalledTimes(1);
    expect(f.released).not.toHaveBeenCalled();
  });

  it.each(['settled', 'stopped'] as const)(
    'removes cancellation listeners when the run is %s',
    reason => {
      const f = fixture();
      f.observe();
      const remove = vi.spyOn(f.signal.signal, 'removeEventListener');
      f.prepare();
      f.claim().release();
      if (reason === 'stopped') f.admission.revokeAll();
      else
        f.admission.observeLifecycle({
          ...desktop,
          stream: 'lifecycle',
          data: { phase: 'end', executionSettled: true },
        });
      expect(remove).toHaveBeenCalledTimes(1);
      const newRun = { ...desktop, runId: 'replacement-run' };
      f.admission.activate();
      f.admission.observeRun({ ...newRun, toolAuthority: f.authority });
      f.released.mockClear();

      f.signal.abort();

      expect(f.released).not.toHaveBeenCalled();
      expect(() =>
        f.admission.prepareToolCall({ ...newRun, toolCallId: 'replacement-call' }),
      ).not.toThrow();
    },
  );

  it('revokes an already-aborted native source before admitting any browser call', () => {
    const f = fixture();
    f.observe();
    f.signal.abort();

    expect(() => f.prepare()).toThrow();

    expect(f.revoked).toHaveBeenCalledExactlyOnceWith({ run: desktop });
    expect(f.released).not.toHaveBeenCalled();
    expect(() => f.claim()).toThrow('authority');
  });

  it('releases only an exact whole-run settled terminal, never agent final or attempt end', () => {
    const f = fixture(cron);
    f.observe();
    const terminal = {
      ...cron,
      stream: 'lifecycle',
      data: { phase: 'end', executionSettled: true },
    };
    for (const event of [
      { ...terminal, stream: 'assistant' },
      { ...terminal, data: { phase: 'end' } },
      { ...terminal, data: { phase: 'end', executionSettled: false } },
      { ...terminal, runId: 'other-run' },
      { ...terminal, sessionId: 'other-session' },
      { ...terminal, sessionKey: desktop.sessionKey },
      { ...terminal, data: { phase: 'progress', executionSettled: true } },
    ])
      f.admission.observeLifecycle(event);
    expect(f.released).not.toHaveBeenCalled();
    f.admission.observeLifecycle(terminal);
    expect(f.released).toHaveBeenCalledExactlyOnceWith({
      run: cron,
      reason: 'settled',
      discardPages: false,
    });
    f.observe();
    expect(() => f.prepare()).toThrow();
    f.admission.observeLifecycle(terminal);
    expect(f.released).toHaveBeenCalledTimes(1);
  });

  it('service revocation closes admission and all retained calls without claiming settlement', () => {
    const f = fixture();
    f.observe();
    f.prepare();
    const call = f.claim();
    f.admission.revokeAll();
    expect(f.released).toHaveBeenCalledExactlyOnceWith({
      run: desktop,
      reason: 'revoked',
      discardPages: true,
    });
    expect(() => call.assertCurrent()).toThrow();
    f.observe();
    expect(() => f.prepare()).toThrow();
  });

  it.each([
    [{ phase: 'end', executionSettled: true, aborted: false }, false],
    [{ phase: 'end', executionSettled: true, aborted: true }, true],
    [{ phase: 'error', executionSettled: true, aborted: false }, true],
  ])('retains revoked run identity until exact terminal %j', (data, discardPages) => {
    const f = fixture();
    f.observe();
    f.prepare();
    f.claim().release();

    // The real native runtime also aborts tool signals during normal completion.
    f.signal.abort();

    expect(f.revoked).toHaveBeenCalledExactlyOnceWith({ run: desktop });
    expect(f.released).not.toHaveBeenCalled();
    f.observe();
    expect(() => f.prepare()).toThrow('authority');
    f.admission.observeLifecycle({ ...desktop, stream: 'lifecycle', data: { phase: 'end' } });
    expect(f.released).not.toHaveBeenCalled();
    f.admission.observeLifecycle({
      ...desktop,
      runId: 'foreign-run',
      stream: 'lifecycle',
      data,
    });
    expect(f.released).not.toHaveBeenCalled();

    f.admission.observeLifecycle({ ...desktop, stream: 'lifecycle', data });

    expect(f.released).toHaveBeenCalledExactlyOnceWith({
      run: desktop,
      reason: 'settled',
      discardPages,
    });
    f.observe();
    expect(() => f.prepare()).toThrow('authority');
  });

  it('finally releases an already source-revoked run when its service stops', () => {
    const f = fixture();
    f.observe();
    f.prepare();
    f.signal.abort();

    f.admission.revokeAll();

    expect(f.revoked).toHaveBeenCalledExactlyOnceWith({ run: desktop });
    expect(f.released).toHaveBeenCalledExactlyOnceWith({
      run: desktop,
      reason: 'revoked',
      discardPages: true,
    });
    f.admission.observeLifecycle({
      ...desktop,
      stream: 'lifecycle',
      data: { phase: 'end', executionSettled: true },
    });
    expect(f.released).toHaveBeenCalledTimes(1);
  });
});
