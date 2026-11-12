import { getSessionEntryAsync } from 'openclaw/plugin-sdk/session-store-runtime';
import { readVisibleSessionTranscriptMessageEntries } from 'openclaw/plugin-sdk/session-transcript-runtime';
import { describe, expect, it, vi } from 'vitest';

vi.mock('openclaw/plugin-sdk/session-store-runtime', () => ({ getSessionEntryAsync: vi.fn() }));
vi.mock('openclaw/plugin-sdk/session-transcript-runtime', () => ({ readVisibleSessionTranscriptMessageEntries: vi.fn() }));

import { readExecutionFailureObservation, registerExecutionFailureObservation } from '../../execution/failure-observation';

const identity = { sessionKey: 'agent:main:justdo:app', sessionId: 'native', lifecycleRevision: 'revision', runId: 'run' };
const entry = { sessionId: 'native', lifecycleRevision: 'revision' };
const failed = { message: { role: 'assistant', stopReason: 'error', errorCode: 'openclaw_repeated_tool_error',
  errorMessage: 'secret provider body', content: ['private'], __openclaw: { runId: 'run' } } };

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
    vi.mocked(getSessionEntryAsync).mockResolvedValue(entry as Awaited<ReturnType<typeof getSessionEntryAsync>>);
    vi.mocked(readVisibleSessionTranscriptMessageEntries).mockResolvedValue([failed] as unknown as Awaited<ReturnType<typeof readVisibleSessionTranscriptMessageEntries>>);
    let handler!: (value: { params: unknown; respond: ReturnType<typeof vi.fn> }) => Promise<void>;
    const registerGatewayMethod = vi.fn((_method, invoke, _options) => { handler = invoke; });
    registerExecutionFailureObservation({ registerGatewayMethod } as unknown as Parameters<typeof registerExecutionFailureObservation>[0]);
    expect(registerGatewayMethod).toHaveBeenCalledWith('runtimeServices.executionFailure', expect.any(Function), { scope: 'operator.read' });
    const respond = vi.fn();
    await handler({ params: identity, respond });
    expect(readVisibleSessionTranscriptMessageEntries).toHaveBeenCalledExactlyOnceWith({ sessionKey: identity.sessionKey, sessionId: identity.sessionId });
    expect(respond).toHaveBeenCalledExactlyOnceWith(true, { ...identity, identityMatched: true, errorCode: 'openclaw_repeated_tool_error' });
  });
});
