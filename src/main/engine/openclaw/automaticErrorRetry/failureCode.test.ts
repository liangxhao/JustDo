import { describe, expect, it, vi } from 'vitest';

import type { NativeRunTerminalReceipt } from '../../gateway/types';
import type { AutomaticErrorRetryBinding, AutomaticErrorRetrySettledReceipt } from './coordinator';
import { readAutomaticErrorRetryFailureCode, readNativeRetryFailureCode } from './failureCode';
import {
  CONTEXT_OVERFLOW_ERROR_CODE, REPLY_GENERATION_EXHAUSTED_CODE, SESSION_READER_FAILURE_CODE,
  TRANSCRIPT_PROJECTION_REBUILDING_CODE,
} from './rules';

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
    const request = vi.fn(async (): Promise<Record<string, unknown>> => ({
      ...observation, lifecycleRevision: null as string | null, errorCode: null as string | null,
    }));
    expect(await readAutomaticErrorRetryFailureCode({ request }, binding, terminal)).toBe(CONTEXT_OVERFLOW_ERROR_CODE);
    expect(request).toHaveBeenCalledWith('runtimeServices.executionFailure', {
      sessionKey: binding.sessionKey, sessionId: 'native', lifecycleRevision: null, runId: 'run', endedAt: 1,
    }, expect.any(Object));

    request.mockResolvedValue({ ...observation, errorCode: 'context_length_exceeded' });
    expect(await readAutomaticErrorRetryFailureCode({ request }, binding, terminal)).toBe(CONTEXT_OVERFLOW_ERROR_CODE);
    expect(await readAutomaticErrorRetryFailureCode({ request }, binding, receipt)).toBe('context_length_exceeded');

    request.mockResolvedValue(observation);
    expect(await readAutomaticErrorRetryFailureCode({ request }, binding, terminal)).toBe(observation.errorCode);

    request.mockResolvedValue({ ...observation, errorCode: null, terminalFailureCode: REPLY_GENERATION_EXHAUSTED_CODE });
    expect(await readAutomaticErrorRetryFailureCode({ request }, binding, terminal)).toBeNull();
    request.mockResolvedValue({ ...observation, errorCode: null, identityMatched: false });
    expect(await readAutomaticErrorRetryFailureCode({ request }, binding, terminal)).toBeNull();
  });

  it('requires a blocked lifecycle observation even when the transcript contains the overflow code', async () => {
    const request = vi.fn(async () => ({ ...observation, errorCode: CONTEXT_OVERFLOW_ERROR_CODE }));
    expect(await readAutomaticErrorRetryFailureCode({ request }, binding, receipt)).toBeNull();
  });

  it.each([CONTEXT_OVERFLOW_ERROR_CODE, REPLY_GENERATION_EXHAUSTED_CODE])(
    'recovers %s after a matching settled wait when Runtime Services observed the native terminal', async code => {
      const { agentSeq: _agentSeq, ...remaining } = receipt;
      const settled = { ...remaining, source: 'agent.wait' as const, stopReason: 'error' };
      const request = vi.fn(async () => ({ ...observation, errorCode: null as string | null, terminalFailureCode: code }));

      expect(await readAutomaticErrorRetryFailureCode({ request }, binding, settled)).toBe(code);
      expect(request).toHaveBeenCalledWith('runtimeServices.executionFailure', {
        sessionKey: binding.sessionKey, sessionId: 'native', lifecycleRevision: null, runId: 'run', endedAt: 1, stopReason: 'error',
      }, expect.any(Object));
      expect(await readAutomaticErrorRetryFailureCode({ request }, binding, { ...settled, endedAt: undefined })).toBeNull();
      expect(await readAutomaticErrorRetryFailureCode({ request }, binding, { ...settled, stopReason: 'timeout' })).toBeNull();
      expect(await readAutomaticErrorRetryFailureCode({ request }, binding, receipt)).toBeNull();
      request.mockResolvedValue({ ...observation, terminalFailureCode: code });
      expect(await readAutomaticErrorRetryFailureCode({ request }, binding, settled)).toBe(observation.errorCode);
    },
  );

  it('correlates a wrapped wait error without treating its copy as a failure code', async () => {
    const { agentSeq: _agentSeq, ...remaining } = receipt;
    const settled = {
      ...remaining, source: 'agent.wait' as const,
      error: "Your request couldn't be completed: ⚠️ Agent couldn't generate a response. Please try again.",
    };
    const request = vi.fn(async (): Promise<Record<string, unknown>> => ({ ...observation, errorCode: null }));

    expect(await readAutomaticErrorRetryFailureCode({ request }, binding, settled)).toBeNull();
    expect(request.mock.calls).toHaveLength(1);
    expect(request).toHaveBeenCalledWith('runtimeServices.executionFailure', {
      sessionKey: binding.sessionKey, sessionId: 'native', lifecycleRevision: null, runId: 'run',
      endedAt: 1, errorFingerprint: '6a0fdaa542d689fb0422afd91a5900d526be6ad3e0cf052109f641aa25a68fd7',
    }, expect.any(Object));
    request.mockResolvedValue({ ...observation, errorCode: null, terminalFailureCode: REPLY_GENERATION_EXHAUSTED_CODE });
    expect(await readAutomaticErrorRetryFailureCode({ request }, binding, settled)).toBe(REPLY_GENERATION_EXHAUSTED_CODE);
  });

  it('recognizes rebuilding only from the exact native settled error for this session', async () => {
    const error = `Session transcript projection is rebuilding: ${binding.nativeSessionId}`;
    const terminal = { phase: 'error', executionSettled: true, error };
    const read = (overrides = {}) => readNativeRetryFailureCode({ ...terminal, ...overrides }, binding.nativeSessionId);

    expect(read()).toBe(TRANSCRIPT_PROJECTION_REBUILDING_CODE);
    expect(read({ error: `${error}-other` })).toBeUndefined();
    expect(read({ error: `Session transcript history window changed: ${binding.nativeSessionId}` })).toBeUndefined();
    expect(read({ executionSettled: false })).toBeUndefined();
    expect(read({ stopReason: 'superseded' })).toBeUndefined();

    const request = vi.fn(async () => ({ ...observation, errorCode: TRANSCRIPT_PROJECTION_REBUILDING_CODE }));
    expect(await readAutomaticErrorRetryFailureCode({ request }, binding, {
      ...receipt, error, observedFailureCode: read(),
    })).toBe(TRANSCRIPT_PROJECTION_REBUILDING_CODE);
    expect(request).not.toHaveBeenCalled();
    expect(await readAutomaticErrorRetryFailureCode({ request }, binding, { ...receipt, error })).toBeNull();
  });

  it('selects reply recovery only from a settled native error marked as exhausted', async () => {
    const error = "Your request couldn't be completed: Agent couldn't generate a response. Please try again.";
    const native = { phase: 'error', executionSettled: true, stopReason: 'error', error };
    const observedFailureCode = readNativeRetryFailureCode({ ...native, replyGenerationExhausted: true }, binding.nativeSessionId);
    expect(observedFailureCode).toBe(REPLY_GENERATION_EXHAUSTED_CODE);
    expect(readNativeRetryFailureCode(native, binding.nativeSessionId)).toBeUndefined();
    for (const nonTerminal of [
      { executionSettled: false }, { executionStarted: false }, { phase: 'end' }, { aborted: true }, { yielded: true },
      { stopReason: 'superseded' }, { stopReason: 'timeout' }, { timeoutPhase: 'model_response' }, { status: 'timeout' },
    ]) {
      expect(readNativeRetryFailureCode({ ...native, replyGenerationExhausted: true, ...nonTerminal }, binding.nativeSessionId))
        .toBeUndefined();
    }

    const request = vi.fn(async () => ({ ...observation, errorCode: REPLY_GENERATION_EXHAUSTED_CODE }));
    expect(await readAutomaticErrorRetryFailureCode({ request }, binding, { ...receipt, error, observedFailureCode }))
      .toBe(REPLY_GENERATION_EXHAUSTED_CODE);
    expect(request).not.toHaveBeenCalled();
    expect(await readAutomaticErrorRetryFailureCode({ request }, binding, { ...receipt, error })).toBeNull();
    const { agentSeq: _agentSeq, ...waitReceipt } = receipt;
    expect(await readAutomaticErrorRetryFailureCode({ request }, binding, { ...waitReceipt, source: 'agent.wait', error }))
      .toBeNull();
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
