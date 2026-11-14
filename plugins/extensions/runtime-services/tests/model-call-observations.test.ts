import { expect, it, vi } from 'vitest';

import { registerModelCallObservations } from '../model-call-observations';

it('logs a content-free observation for the exact native model call', () => {
  const hooks = new Map<string, (event: unknown, context: unknown) => void>();
  const info = vi.fn();
  registerModelCallObservations({
    on: (name: string, hook: (event: unknown, context: unknown) => void) => hooks.set(name, hook),
    runtime: { logging: { getChildLogger: () => ({ info }) } },
  } as never);
  const context = {
    runId: 'run',
    sessionKey: 'agent:main:justdo:session',
    sessionId: 'physical',
    trace: { traceId: 'a'.repeat(32), spanId: 'b'.repeat(16) },
  };
  const event = {
    runId: context.runId,
    sessionKey: context.sessionKey,
    sessionId: context.sessionId,
    callId: 'run:model:1',
    provider: 'provider',
    model: 'model',
    durationMs: 300,
    outcome: 'error',
    requestPayloadBytes: 500,
    timeToFirstByteMs: 125,
    upstreamRequestIdHash: 'sha256:0123456789ab',
    failureKind: 'timeout',
    headers: { Authorization: 'private credential' },
    prompt: 'private prompt',
  };
  hooks.get('model_call_started')!(event, { ...context, sessionId: 'different' });
  hooks.get('model_call_ended')!(event, context);
  expect(info).toHaveBeenCalledOnce();
  expect(JSON.parse(info.mock.calls[0][0])).toEqual({
    type: 'runtime_services.model_call',
    phase: 'ended',
    runId: 'run',
    sessionKey: 'agent:main:justdo:session',
    sessionId: 'physical',
    callId: 'run:model:1',
    traceId: 'a'.repeat(32),
    spanId: 'b'.repeat(16),
    provider: 'provider',
    model: 'model',
    durationMs: 300,
    outcome: 'error',
    requestPayloadBytes: 500,
    timeToFirstByteMs: 125,
    upstreamRequestIdHash: 'sha256:0123456789ab',
    failureKind: 'timeout',
  });
});
