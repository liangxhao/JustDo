import { describe, expect, it, vi } from 'vitest';

import type { NativeRunTerminalReceipt } from '../../gateway/types';
import type { AutomaticErrorRetryBinding, AutomaticErrorRetrySettledReceipt } from './coordinator';
import { readAutomaticErrorRetryFailureCode } from './failureCode';
import { CONTEXT_OVERFLOW_ERROR_CODE, SESSION_READER_FAILURE_CODE } from './rules';

const binding: AutomaticErrorRetryBinding = {
  sessionId: 'app', sessionKey: 'agent:main:justdo:app', nativeSessionId: 'native',
  lifecycleRevision: null, clientGeneration: 1, clientTurnId: 'input', runId: 'run',
};
const receipt: NativeRunTerminalReceipt = {
  runId: 'run', sessionKey: binding.sessionKey, sessionId: 'native', lifecycleGeneration: null,
  clientGeneration: 1, executionSettled: true, status: 'failed', agentSeq: 1, endedAt: 1,
};
const observation = {
  sessionKey: binding.sessionKey, sessionId: 'native', lifecycleRevision: null,
  runId: 'run', identityMatched: true, errorCode: 'openclaw_repeated_tool_error',
};

describe('exact native retry error code reader', () => {
  it('requests narrow metadata and accepts only the exact response identity', async () => {
    const request = vi.fn(async (): Promise<Record<string, unknown>> => observation);
    expect(await readAutomaticErrorRetryFailureCode({ request }, binding, receipt)).toBe(observation.errorCode);
    expect(request).toHaveBeenCalledWith('runtimeServices.executionFailure', {
      sessionKey: binding.sessionKey, sessionId: 'native', lifecycleRevision: null, runId: 'run',
    }, expect.objectContaining({ timeoutMs: 10_000 }));
    request.mockResolvedValue({ ...observation, runId: 'foreign' });
    expect(await readAutomaticErrorRetryFailureCode({ request }, binding, receipt)).toBeNull();
    request.mockResolvedValue({ ...observation, identityMatched: undefined });
    expect(await readAutomaticErrorRetryFailureCode({ request }, binding, receipt)).toBeNull();
  });

  it('never infers a code from error text, malformed payloads or an unsettled foreign source', async () => {
    const request = vi.fn(async () => ({ ...observation, errorCode: null, error: 'openclaw_repeated_tool_error' }));
    expect(await readAutomaticErrorRetryFailureCode({ request }, binding, receipt)).toBeNull();
    expect(await readAutomaticErrorRetryFailureCode({ request }, binding, { ...receipt, sessionId: 'foreign' })).toBeNull();
    expect(request).toHaveBeenCalledOnce();
  });

  it('uses a native overflow observation with an exact matching provider code or no transcript code', async () => {
    const terminal: NativeRunTerminalReceipt = { ...receipt, observedFailureCode: CONTEXT_OVERFLOW_ERROR_CODE };
    const request = vi.fn(async () => ({
      ...observation, lifecycleRevision: null as string | null, errorCode: null as string | null,
    }));
    expect(await readAutomaticErrorRetryFailureCode({ request }, binding, terminal)).toBe(CONTEXT_OVERFLOW_ERROR_CODE);

    request.mockResolvedValue({ ...observation, errorCode: 'context_length_exceeded' });
    expect(await readAutomaticErrorRetryFailureCode({ request }, binding, terminal)).toBe(CONTEXT_OVERFLOW_ERROR_CODE);
    expect(await readAutomaticErrorRetryFailureCode({ request }, binding, receipt)).toBe('context_length_exceeded');

    request.mockResolvedValue(observation);
    expect(await readAutomaticErrorRetryFailureCode({ request }, binding, terminal)).toBe(observation.errorCode);

    request.mockResolvedValue({ ...observation, errorCode: null, identityMatched: false });
    expect(await readAutomaticErrorRetryFailureCode({ request }, binding, terminal)).toBeNull();
  });

  it('requires a blocked lifecycle observation even when the transcript contains the overflow code', async () => {
    const request = vi.fn(async () => ({ ...observation, errorCode: CONTEXT_OVERFLOW_ERROR_CODE }));
    expect(await readAutomaticErrorRetryFailureCode({ request }, binding, receipt)).toBeNull();
  });

  it('requires the native reader failure report and its exact saved user input on the current branch', async () => {
    const error = 'SessionWorkStartChangedError: Session reader operation is no longer current';
    const terminal = { ...receipt, error };
    const user = { role: 'user', __openclaw: { idempotencyKey: 'run:user' } };
    const failure = { role: 'custom', customType: 'run-failed-before-reply',
      __openclaw: { runId: 'run' }, content: `Your request couldn't be completed: ${error}` };
    const history = { sessionKey: binding.sessionKey, sessionId: binding.nativeSessionId,
      sessionInfo: { sessionId: binding.nativeSessionId } };
    const check = (messages: unknown[], errorCode: string | null = null,
      settled: AutomaticErrorRetrySettledReceipt = terminal) => {
      const request = vi.fn(async (method: string) => method === 'chat.history'
        ? { ...history, messages }
        : { ...observation, errorCode });
      return readAutomaticErrorRetryFailureCode({ request }, binding, settled);
    };
    expect(await check([user, failure])).toBe(SESSION_READER_FAILURE_CODE);
    expect(await check([user, { ...failure, role: 'assistant' }])).toBeNull();
    expect(await check([user, { ...failure, __openclaw: { runId: 'foreign' } }])).toBeNull();
    expect(await check([{ ...user, __openclaw: { ...user.__openclaw, steerTargetRunId: 'other' } }, failure])).toBeNull();
    expect(await check([failure, user])).toBeNull();
    expect(await check([user, failure, { role: 'user', idempotencyKey: 'new:user' }])).toBeNull();
    expect(await check([user, failure], SESSION_READER_FAILURE_CODE)).toBeNull();
    const { agentSeq: _agentSeq, ...wait } = terminal;
    expect(await check([user, failure], null, { ...wait, source: 'agent.wait', endedAt: undefined })).toBeNull();
    expect(await check([user, failure], null, { ...wait, source: 'agent.wait', stopReason: 'superseded' })).toBeNull();
  });

  it('rejects a result that arrives after cancellation', async () => {
    const controller = new AbortController();
    const request = vi.fn(async () => { controller.abort(); return observation; });
    await expect(readAutomaticErrorRetryFailureCode({ request }, binding, receipt, controller.signal)).rejects.toThrow();
  });

  it('matches the original saved input and the exact successor failure when the retry prompt was not persisted', async () => {
    const error = 'Session reader operation is no longer current';
    const successor = { ...receipt, runId: 'successor', error };
    const user = { role: 'user', __openclaw: { idempotencyKey: 'run:user' } };
    const failure = { role: 'custom', customType: 'run-failed-before-reply',
      __openclaw: { runId: successor.runId }, content: `Your request couldn't be completed: ${error}` };
    const request = vi.fn(async (method: string) => method === 'chat.history'
      ? { sessionKey: binding.sessionKey, sessionId: binding.nativeSessionId,
          sessionInfo: { sessionId: binding.nativeSessionId }, messages: [user, failure] }
      : { ...observation, runId: successor.runId, errorCode: null });
    expect(await readAutomaticErrorRetryFailureCode({ request }, binding, successor, undefined,
      { userInputRunId: 'run' })).toBe(SESSION_READER_FAILURE_CODE);
    expect(await readAutomaticErrorRetryFailureCode({ request }, binding, successor)).toBeNull();
  });
});
