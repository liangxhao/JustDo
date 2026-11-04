import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  BuiltinModelAuthDiagnosticEvent,
  BuiltinModelAuthDiagnosticReason,
  getBuiltinModelAuthErrorCode,
  writeBuiltinModelAuthDiagnostic,
} from './builtinModelAuthDiagnostics';

afterEach(() => vi.restoreAllMocks());

describe('builtin auth diagnostics', () => {
  it('writes one physical line and rejects arbitrary properties, objects and nonfinite numbers', () => {
    const output = vi.spyOn(console, 'warn').mockImplementation(() => {});

    writeBuiltinModelAuthDiagnostic('warn', BuiltinModelAuthDiagnosticEvent.ExchangeFailed, {
      reason: BuiltinModelAuthDiagnosticReason.NetworkFailure, errorCode: 'ECONNRESET',
      elapsedMs: Infinity, generation: 2,
      password: 'synthetic-private-secret', cause: { message: 'synthetic-private-secret' },
    } as never);

    expect(output).toHaveBeenCalledOnce();
    expect(output.mock.calls[0]).toHaveLength(1);
    const line = output.mock.calls[0][0] as string;
    expect(line).not.toMatch(/[\r\n]|synthetic-private-secret|Infinity/);
    expect(JSON.parse(line.slice('[BuiltinModelAuth] '.length))).toEqual({
      event: 'exchange.failed', reason: 'network-failure', errorCode: 'ECONNRESET', generation: 2,
    });
  });

  it('bounds traversal and returns only closed codes, including nested and hostile errors', () => {
    const inner = Object.assign(new Error('synthetic-private-secret'), { code: 'EPERM' });
    expect(getBuiltinModelAuthErrorCode(new AggregateError([inner]))).toBe('EPERM');
    const cycle: { cause?: unknown; code: string } = { code: 'synthetic-private-secret' };
    cycle.cause = cycle;
    expect(getBuiltinModelAuthErrorCode(cycle)).toBe('unknown');
    expect(getBuiltinModelAuthErrorCode(new Proxy({}, { get: () => { throw inner; } }))).toBe('unknown');
  });

  it('does not turn console or projection failures into authentication failures', () => {
    vi.spyOn(console, 'info').mockImplementation(() => { throw new Error('log sink unavailable'); });
    expect(() => writeBuiltinModelAuthDiagnostic('info', BuiltinModelAuthDiagnosticEvent.ExchangeSucceeded))
      .not.toThrow();
    expect(() => writeBuiltinModelAuthDiagnostic('info', BuiltinModelAuthDiagnosticEvent.ExchangeSucceeded,
      new Proxy({}, { ownKeys: () => { throw new Error('invalid diagnostic'); } }))).not.toThrow();
  });
});
