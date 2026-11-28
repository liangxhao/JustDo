import { createHash } from 'node:crypto';

import { getSessionEntry, getSessionEntryAsync } from 'openclaw/plugin-sdk/session-store-runtime';
import { readVisibleSessionTranscriptMessageEntries } from 'openclaw/plugin-sdk/session-transcript-runtime';
import { describe, expect, it, vi } from 'vitest';

vi.mock('openclaw/plugin-sdk/session-store-runtime', () => ({ getSessionEntry: vi.fn(), getSessionEntryAsync: vi.fn() }));
vi.mock('openclaw/plugin-sdk/session-transcript-runtime', () => ({ readVisibleSessionTranscriptMessageEntries: vi.fn() }));

import { normalizeExecutionFailureCopy } from '../../contracts/execution-failure-copy';
import { readExecutionFailureObservation, registerExecutionFailureObservation } from '../../execution/failure-observation';

const identity = { sessionKey: 'agent:main:justdo:app', sessionId: 'native', lifecycleRevision: 'revision', runId: 'run' };
const entry = { sessionId: 'native', lifecycleRevision: 'revision' };
const failed = { message: { role: 'assistant', stopReason: 'error', errorCode: 'openclaw_repeated_tool_error',
  errorMessage: 'secret provider body', content: ['private'], __openclaw: { runId: 'run' } } };
const endedAt = 2500;
const settledError = { phase: 'error', executionSettled: true, stopReason: 'error', endedAt, error: 'secret provider body' };
const contextOverflow = { livenessState: 'blocked', errorObservation: { failoverReason: 'context_overflow' } };
const { lifecycleRevision: _revision, ...eventIdentity } = identity;
const nativeLifecycle = { ...eventIdentity, stream: 'lifecycle', seq: 2, lifecycleGeneration: 'native-generation' };
const digest = (value: string) => createHash('sha256').update(normalizeExecutionFailureCopy(value) ?? '').digest('hex');

function registeredObservation() {
  vi.mocked(getSessionEntry).mockReturnValue(entry as ReturnType<typeof getSessionEntry>);
  vi.mocked(getSessionEntryAsync).mockResolvedValue(entry as Awaited<ReturnType<typeof getSessionEntryAsync>>);
  vi.mocked(readVisibleSessionTranscriptMessageEntries).mockClear().mockResolvedValue([]);
  let handler!: (value: { params: unknown; respond: ReturnType<typeof vi.fn> }) => Promise<void>;
  let emit!: (event: typeof nativeLifecycle & { data: Record<string, unknown> }) => void;
  let dispose!: () => void;
  const stopEvents = vi.fn();
  const registerGatewayMethod = vi.fn((_method, invoke, _options) => { handler = invoke; });
  const onAgentEvent = (listener: typeof emit) => { emit = listener; return stopEvents; };
  const onDispose = (callback: () => void) => { dispose = callback; };
  const api = { registerGatewayMethod, runtime: { events: { onAgentEvent } }, lifecycle: { onDispose } };
  registerExecutionFailureObservation(api as unknown as Parameters<typeof registerExecutionFailureObservation>[0]);
  return {
    registerGatewayMethod,
    emit,
    dispose,
    stopEvents,
    async request(params: unknown) {
      const respond = vi.fn();
      await handler({ params, respond });
      return respond;
    },
  };
}

describe('narrow native execution failure observation', () => {
  it('projects only exact identity and native code, without error body or task content', async () => {
    const readEntry = vi.fn(async () => entry);
    const result = await readExecutionFailureObservation(identity, { readEntry, readMessages: async () => [failed] });
    expect(result).toEqual({ ...identity, identityMatched: true, errorCode: 'openclaw_repeated_tool_error' });
    expect(JSON.stringify(result)).not.toContain('secret');
    expect(readEntry).toHaveBeenCalledTimes(2);
  });

  it('refuses a replaced incarnation before or during the asynchronous read', async () => {
    const readEntry = vi.fn(async () => ({ ...entry, sessionId: 'replacement' }));
    const readMessages = vi.fn(async () => [failed]);
    expect(await readExecutionFailureObservation(identity, { readEntry, readMessages }))
      .toEqual({ ...identity, identityMatched: false, errorCode: null });
    expect(readMessages).not.toHaveBeenCalled();
    readEntry.mockResolvedValueOnce(entry).mockResolvedValueOnce({ ...entry, lifecycleRevision: 'replacement' });
    expect(await readExecutionFailureObservation(identity, { readEntry, readMessages }))
      .toEqual({ ...identity, identityMatched: false, errorCode: null });
  });

  it('does not select an older or foreign error over the final run outcome', async () => {
    const dependencies = { readEntry: async () => entry, readMessages: async () => [failed,
      { message: { role: 'assistant', stopReason: 'stop', __openclaw: { runId: 'run' } } }] };
    expect((await readExecutionFailureObservation(identity, dependencies)).errorCode).toBeNull();
    dependencies.readMessages = async () => [{ ...failed, message: { ...failed.message, __openclaw: { runId: 'foreign' } } }];
    expect((await readExecutionFailureObservation(identity, dependencies)).errorCode).toBeNull();
  });

  it('rejects incomplete identities without reading native state', async () => {
    const readEntry = vi.fn();
    await expect(readExecutionFailureObservation({ ...identity, lifecycleRevision: undefined },
      { readEntry, readMessages: async () => [] })).rejects.toThrow();
    expect(readEntry).not.toHaveBeenCalled();
  });

  it('registers a read-scoped RPC and reads the source through the public async SDK', async () => {
    const observation = registeredObservation();
    vi.mocked(readVisibleSessionTranscriptMessageEntries).mockResolvedValue([failed] as unknown as Awaited<ReturnType<typeof readVisibleSessionTranscriptMessageEntries>>);
    expect(observation.registerGatewayMethod).toHaveBeenCalledWith('runtimeServices.executionFailure', expect.any(Function), { scope: 'operator.read' });
    const respond = await observation.request(identity);
    expect(readVisibleSessionTranscriptMessageEntries).toHaveBeenCalledExactlyOnceWith({ sessionKey: identity.sessionKey, sessionId: identity.sessionId });
    expect(respond).toHaveBeenCalledExactlyOnceWith(true, { ...identity, identityMatched: true, errorCode: 'openclaw_repeated_tool_error' });
  });

  it.each([
    ['reply_generation_exhausted', { replyGenerationExhausted: true }],
    ['context_overflow', contextOverflow],
  ] as const)('returns the exact %s terminal classification without depending on a readable transcript', async (code, fields) => {
    const observation = registeredObservation();
    vi.mocked(readVisibleSessionTranscriptMessageEntries).mockRejectedValue(new Error('Transcript unavailable'));
    observation.emit({ ...nativeLifecycle, data: { ...settledError, ...fields } });
    expect(await observation.request({ ...identity, endedAt })).toHaveBeenCalledExactlyOnceWith(true, {
      ...identity, identityMatched: true, errorCode: null, terminalFailureCode: code,
    });
    expect(await observation.request({ ...identity, endedAt: endedAt + 1, stopReason: 'error' })).toHaveBeenCalledExactlyOnceWith(true, {
      ...identity, identityMatched: true, errorCode: null, terminalFailureCode: code,
    });
    const errorFingerprint = digest(`Error: Your request couldn't be completed: ⚠️ ${settledError.error}`);
    expect(await observation.request({ ...identity, endedAt: endedAt + 1, errorFingerprint })).toHaveBeenCalledExactlyOnceWith(true, {
      ...identity, identityMatched: true, errorCode: null, terminalFailureCode: code,
    });
    expect(readVisibleSessionTranscriptMessageEntries).not.toHaveBeenCalled();
    vi.mocked(readVisibleSessionTranscriptMessageEntries).mockResolvedValue([]);
    for (const params of [identity, { ...identity, endedAt: endedAt - 1, stopReason: 'error' },
      { ...identity, endedAt: endedAt + 1 }, { ...identity, runId: 'foreign', endedAt },
      { ...identity, endedAt: endedAt + 1, errorFingerprint: digest('Failed to persist completion') },
      { ...identity, sessionKey: 'agent:main:justdo:foreign', endedAt }]) {
      const response = (await observation.request(params)).mock.calls[0]?.[1];
      expect(response).not.toHaveProperty('terminalFailureCode');
    }
    expect(await observation.request({ ...identity, endedAt: 0 })).toHaveBeenCalledWith(false, undefined, expect.anything());
    expect(await observation.request({ ...identity, endedAt, stopReason: 'timeout' })).toHaveBeenCalledWith(false, undefined, expect.anything());
    expect(await observation.request({ ...identity, endedAt, errorFingerprint: 'invalid' })).toHaveBeenCalledWith(false, undefined, expect.anything());
  });

  it('ignores attempts and plugin-emitted events and clears proof on reused runs, generation change, expiry or disposal', async () => {
    const observation = registeredObservation();
    const nativeError = { ...nativeLifecycle, data: { ...settledError, ...contextOverflow } };
    const lookup = async () => (await observation.request({ ...identity, endedAt })).mock.calls[0]?.[1];
    for (const invalid of [{ executionSettled: false }, { aborted: true }, { yielded: true }, { timeoutPhase: 'execution' },
      { stopReason: 'superseded' }, { pluginId: 'another-plugin' }]) {
      observation.emit({ ...nativeError, data: { ...nativeError.data, ...invalid } });
      expect(await lookup()).not.toHaveProperty('terminalFailureCode');
    }

    observation.emit(nativeError);
    expect(await lookup()).toHaveProperty('terminalFailureCode', 'context_overflow');
    observation.emit({ ...nativeLifecycle, data: { phase: 'start' } });
    expect(await lookup()).not.toHaveProperty('terminalFailureCode');

    observation.emit(nativeError);
    observation.emit({ ...nativeLifecycle, data: { phase: 'end', executionSettled: true, endedAt } });
    expect(await lookup()).not.toHaveProperty('terminalFailureCode');

    observation.emit(nativeError);
    observation.emit({ ...nativeLifecycle, runId: 'new-run', lifecycleGeneration: 'new-generation', data: { phase: 'start' } });
    expect(await lookup()).not.toHaveProperty('terminalFailureCode');

    const clock = vi.spyOn(Date, 'now').mockReturnValue(0);
    try {
      observation.emit({ ...nativeError, lifecycleGeneration: 'new-generation' });
      clock.mockReturnValue(60_001);
      expect(await lookup()).not.toHaveProperty('terminalFailureCode');
      observation.emit({ ...nativeError, lifecycleGeneration: 'new-generation' });
      observation.dispose();
      expect(observation.stopEvents).toHaveBeenCalledOnce();
      expect(await lookup()).not.toHaveProperty('terminalFailureCode');
    } finally { clock.mockRestore(); }
  });

  it('correlates the exact late native context recovery copy with the typed original terminal', async () => {
    const observation = registeredObservation();
    const recoveryCopy = "⚠️ Auto-compaction could not recover this turn. I kept this conversation mapped to the current session. Please try again, use /compact, or use /new to start a fresh session.\n\nTry starting a fresh session or using a model with a larger context window.";
    const request = { ...identity, endedAt: endedAt + 1, errorFingerprint: digest(recoveryCopy) };
    expect((await observation.request(request)).mock.calls[0]?.[1]).not.toHaveProperty('terminalFailureCode');
    observation.emit({ ...nativeLifecycle, data: { ...settledError, ...contextOverflow,
      error: 'Context overflow: prompt too large for the model. Try /reset (or /new) to start a fresh session, or use a larger-context model.',
    } });
    expect(await observation.request(request)).toHaveBeenCalledExactlyOnceWith(true, {
      ...identity, identityMatched: true, errorCode: null, terminalFailureCode: 'context_overflow',
    });
    const modified = { ...request, errorFingerprint: digest(`${recoveryCopy} Publication failed.`) };
    expect((await observation.request(modified)).mock.calls[0]?.[1]).not.toHaveProperty('terminalFailureCode');
  });

  it('cannot attach an earlier event to a new native revision or session', async () => {
    const observation = registeredObservation();
    observation.emit({ ...nativeLifecycle, data: { ...settledError, ...contextOverflow } });
    const replacement = { sessionId: identity.sessionId, lifecycleRevision: 'replacement' };
    vi.mocked(getSessionEntryAsync).mockResolvedValue(replacement as Awaited<ReturnType<typeof getSessionEntryAsync>>);
    const request = { ...identity, endedAt, lifecycleRevision: replacement.lifecycleRevision };
    expect((await observation.request(request)).mock.calls[0]?.[1]).toEqual({
      ...identity, lifecycleRevision: replacement.lifecycleRevision, identityMatched: true, errorCode: null,
    });
    vi.mocked(getSessionEntry).mockReturnValue({ ...replacement, sessionId: 'different' } as ReturnType<typeof getSessionEntry>);
    observation.emit({ ...nativeLifecycle, data: { ...settledError, ...contextOverflow } });
    expect((await observation.request(request)).mock.calls[0]?.[1]).not.toHaveProperty('terminalFailureCode');
  });
});
