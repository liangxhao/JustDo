import { describe, expect, it, vi } from 'vitest';

import type { NativeRunTerminalReceipt } from '../../gateway/types';
import type { AutomaticErrorRetryBinding } from './coordinator';
import { readAutomaticErrorRetryFailureCode } from './failureCode';

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
  runId: 'run', errorCode: 'openclaw_repeated_tool_error',
};

describe('exact native retry error code reader', () => {
  it('requests narrow metadata and accepts only the exact response identity', async () => {
    const request = vi.fn(async () => observation);
    expect(await readAutomaticErrorRetryFailureCode({ request }, binding, receipt)).toBe(observation.errorCode);
    expect(request).toHaveBeenCalledWith('runtimeServices.executionFailure', {
      sessionKey: binding.sessionKey, sessionId: 'native', lifecycleRevision: null, runId: 'run',
    }, expect.objectContaining({ timeoutMs: 10_000 }));
    request.mockResolvedValue({ ...observation, runId: 'foreign' });
    expect(await readAutomaticErrorRetryFailureCode({ request }, binding, receipt)).toBeNull();
  });

  it('never infers a code from error text, malformed payloads or an unsettled foreign source', async () => {
    const request = vi.fn(async () => ({ ...observation, errorCode: null, error: 'openclaw_repeated_tool_error' }));
    expect(await readAutomaticErrorRetryFailureCode({ request }, binding, receipt)).toBeNull();
    expect(await readAutomaticErrorRetryFailureCode({ request }, binding, { ...receipt, sessionId: 'foreign' })).toBeNull();
    expect(request).toHaveBeenCalledOnce();
  });

  it('rejects a result that arrives after cancellation', async () => {
    const controller = new AbortController();
    const request = vi.fn(async () => { controller.abort(); return observation; });
    await expect(readAutomaticErrorRetryFailureCode({ request }, binding, receipt, controller.signal)).rejects.toThrow();
  });
});
