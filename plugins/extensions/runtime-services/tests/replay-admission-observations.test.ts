import type { OpenClawPluginApi } from 'openclaw/plugin-sdk/core';
import { describe, expect, it, vi } from 'vitest';

import { registerReplayAdmissionObservations } from '../replay-admission-observations';

const error = 'Persisted user turn changed before replay admission';
const context = {
  runId: 'native-run',
  sessionKey: 'agent:main:justdo:product-session',
  sessionId: 'native-session',
  trace: { traceId: '1'.repeat(32), spanId: '2'.repeat(16), privateData: 'secret' },
  workspaceDir: 'private-workspace',
};

function fixture() {
  const hooks = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  const logger = { info: vi.fn(), warn: vi.fn() };
  const getChildLogger = vi.fn(() => logger);
  registerReplayAdmissionObservations({
    on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) =>
      hooks.set(name, handler),
    runtime: { logging: { getChildLogger } },
  } as unknown as OpenClawPluginApi);
  return {
    logger,
    getChildLogger,
    invoke: (name: string, event: unknown, ctx: unknown = context) => hooks.get(name)!(event, ctx),
  };
}

describe('native replay admission hook observations', () => {
  it('logs only the current hook identity, without reading prompt or messages', () => {
    const f = fixture();
    const event = {
      get prompt() {
        throw new Error('Prompt must not be read');
      },
      get messages() {
        throw new Error('Messages must not be read');
      },
    };
    expect(f.invoke('before_prompt_build', event)).toBeUndefined();
    expect(f.logger.info).toHaveBeenCalledExactlyOnceWith(
      '[runtime-services] Prompt build hook reached',
      {
        source: 'before_prompt_build',
        runId: context.runId,
        sessionKey: context.sessionKey,
        sessionId: context.sessionId,
        traceId: context.trace.traceId,
        spanId: context.trace.spanId,
      },
    );
    expect(f.logger.warn).not.toHaveBeenCalled();
  });

  it.each([
    error,
    `Error: ${error}`,
    `Your request couldn't be completed: ${error}`,
    `Your request couldn't be completed: Error: ${error}`,
  ])('records exact failure: %s', message => {
    const f = fixture();
    f.invoke('agent_end', {
      success: false,
      error: ` ${message} `,
      runId: context.runId,
      get messages() {
        throw new Error('Messages must not be read');
      },
    });
    expect(f.logger.warn).toHaveBeenCalledExactlyOnceWith(
      '[runtime-services] Replay admission rejection observed',
      {
        source: 'agent_end',
        runId: context.runId,
        sessionKey: context.sessionKey,
        sessionId: context.sessionId,
        traceId: context.trace.traceId,
        spanId: context.trace.spanId,
        runtimeFailure: 'replay_admission_rejected',
        site: 'not_exposed',
      },
    );
  });

  it('ignores successful turns, quoted errors, partial errors and conflicting run identities', () => {
    const f = fixture();
    for (const event of [
      { success: true, error },
      { error },
      { success: false, error: `Quoted: ${error}` },
      { success: false, error: `${error} extra` },
      { success: false, error: error.slice(0, -1) },
      { success: false, error: { message: error } },
      { success: false, error, runId: 'foreign-run' },
      { success: false, messages: [{ text: error }] },
    ])
      f.invoke('agent_end', event);
    expect(f.getChildLogger).not.toHaveBeenCalled();
  });

  it('never reuses a previous attempt trace or manufactures missing metadata', () => {
    const f = fixture();
    f.invoke('before_prompt_build', {});
    const missingTrace = { runId: context.runId, sessionKey: context.sessionKey };
    f.invoke('agent_end', { success: false, error }, missingTrace);
    expect(f.logger.warn.mock.calls[0][1]).toEqual({
      ...missingTrace,
      source: 'agent_end',
      runtimeFailure: 'replay_admission_rejected',
      site: 'not_exposed',
    });
    f.invoke(
      'before_prompt_build',
      {},
      {
        ...context,
        trace: { traceId: '0'.repeat(32), spanId: '2'.repeat(16), privateData: 'secret' },
      },
    );
    expect(f.logger.info.mock.calls[1][1]).not.toHaveProperty('traceId');
    expect(f.logger.info.mock.calls[1][1]).not.toHaveProperty('spanId');
  });

  it('does not log unrelated, missing or malformed identities', () => {
    const f = fixture();
    for (const ctx of [
      { ...context, sessionKey: 'agent:main:subagent:child' },
      { ...context, sessionKey: `${context.sessionKey}:child` },
      { ...context, runId: '' },
      { ...context, runId: 'x'.repeat(257) },
      { ...context, sessionKey: `${context.sessionKey}\nsecret` },
    ])
      f.invoke('before_prompt_build', {}, ctx);
    expect(f.getChildLogger).not.toHaveBeenCalled();
  });

  it('keeps hooks observational when logger creation or writing fails', () => {
    const f = fixture();
    f.getChildLogger.mockImplementationOnce(() => {
      throw new Error('Logger unavailable');
    });
    expect(() => f.invoke('before_prompt_build', {})).not.toThrow();
    f.logger.warn.mockImplementationOnce(() => {
      throw new Error('Disk full');
    });
    expect(() => f.invoke('agent_end', { success: false, error })).not.toThrow();
  });
});
