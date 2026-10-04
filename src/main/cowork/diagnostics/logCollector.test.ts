import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { DiagnosticReport } from '../../../shared/cowork/sessionDiagnostics';
import { collectDiagnosticLogs } from './logCollector';

const time = Date.parse('2026-09-28T10:00:00Z');
const report = (): DiagnosticReport => ({
  version: 1,
  snapshotId: 'snapshot',
  sessionId: 'secret-session',
  collectedAt: time,
  run: { id: 'secret-run', startedAt: time - 1000, state: 'running' },
  conclusion: { reason: 'running', confidence: 'confirmed', evidenceIds: [], toolFailures: 0 },
  events: [
    {
      id: 'event',
      runId: 'secret-run',
      nativeRunId: 'native-run',
      epoch: 'epoch',
      observedAt: time,
      kind: 'lifecycle',
      phase: 'start',
    },
  ],
  coverage: { dropped: 0, storageFailed: false, partial: true },
  connection: 'offline',
  environment: { status: 'not_requested' },
});
const empty = () => ({ main: [] as string[], cowork: [] as string[], gateway: [] as string[] });
const line = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    time: new Date(time).toISOString(),
    level: 'error',
    runId: 'native-run',
    errorCategory: 'timeout',
    ...extra,
  });

describe('payload-free bounded diagnostic log collection', () => {
  it('collects native exhausted reasoning-only recovery as closed model evidence', async () => {
    const result = await collectDiagnosticLogs(report(), empty(), {
      lines: [
        line({
          errorCategory: undefined,
          event: 'model_fallback_decision',
          decision: 'candidate_failed',
          code: 'reasoning_only_result',
          fallbackStepFinalOutcome: 'chain_exhausted',
          message: 'SECRET',
        }),
      ],
    });
    expect(result.records[0]).toMatchObject({
      signal: 'provider',
      stage: 'model',
      association: 'run',
      responseIssue: 'reasoning_only',
      responseRecovery: 'exhausted',
    });
    expect(JSON.stringify(result)).not.toContain('SECRET');
  });
  it('keeps error codes extracted from message text labeled as text-derived hints', async () => {
    const result = await collectDiagnosticLogs(report(), empty(), {
      lines: [line({ errorCategory: undefined, message: 'request failed with ENOTFOUND: SECRET' })],
    });
    expect(result.records[0]).toMatchObject({
      signal: 'network',
      basis: 'error_text',
      errorCode: 'ENOTFOUND',
    });
    expect(JSON.stringify(result)).not.toContain('SECRET');
  });

  it('recognizes native failed command outcomes without exit codes and model transport failure kinds', async () => {
    const result = await collectDiagnosticLogs(report(), empty(), {
      lines: [
        line({
          errorCategory: undefined,
          type: 'exec.process.completed',
          level: 'info',
          outcome: 'failed',
          failureKind: 'runtime-error',
        }),
        line({
          errorCategory: undefined,
          type: 'model.call.error',
          level: 'info',
          failureKind: 'connection_reset',
        }),
      ],
    });
    expect(result.records).toEqual([
      expect.objectContaining({ signal: 'tool', basis: 'command_error', stage: 'command' }),
      expect.objectContaining({ signal: 'network', basis: 'error_category', stage: 'model' }),
    ]);
  });

  it('does not diagnose explicit successful commands from incidental error text or codes', async () => {
    const result = await collectDiagnosticLogs(report(), empty(), {
      lines: [
        line({
          errorCategory: undefined,
          type: 'exec.process.completed',
          level: 'warn',
          exitCode: 0,
          timedOut: false,
          outcome: 'completed',
          code: 'ETIMEDOUT',
          message: 'handled ETIMEDOUT',
        }),
      ],
    });
    expect(result.records[0]).toMatchObject({ signal: 'unknown', metrics: { exitCode: 0 } });
    expect(result.records[0].basis).toBe('routine');
    expect(result.records[0].errorCode).toBeUndefined();
  });

  it('discards malformed machine metrics while retaining valid durations and HTTP aliases', async () => {
    const result = await collectDiagnosticLogs(report(), empty(), {
      lines: [
        line({
          statusCode: 401.5,
          exitCode: 1.5,
          attempt: -1,
          durationMs: -1,
          queueDepth: 2.2,
          requestPayloadBytes: -3,
          responseStreamBytes: 0.5,
          waitMs: -5,
        }),
        line({ httpStatus: 503, durationMs: 0.25, requestBytes: 10, responseBytes: 20 }),
      ],
    });
    expect(result.records.map(record => record.metrics)).toEqual([
      {},
      { statusCode: 503, durationMs: 0.25, requestPayloadBytes: 10, responseStreamBytes: 20 },
    ]);
  });

  it('locates command exits, command timeouts and DNS failures without retaining content', async () => {
    const result = await collectDiagnosticLogs(report(), empty(), {
      lines: [
        line({
          errorCategory: undefined,
          type: 'exec.process.completed',
          exitCode: 2,
          durationMs: 42,
          command: 'SECRET',
        }),
        line({
          errorCategory: undefined,
          type: 'exec.process.completed',
          timedOut: true,
          exitCode: 0,
        }),
        line({
          errorCategory: undefined,
          type: 'model.call.error',
          code: 'ENOTFOUND',
          error: 'SECRET',
        }),
        line({
          errorCategory: undefined,
          level: 'info',
          type: 'exec.process.completed',
          exitCode: 0,
        }),
        line({
          errorCategory: undefined,
          type: 'model.call.completed',
          code: 'ENOTFOUND',
          durationMs: 1,
        }),
      ],
    });
    expect(result.records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          stage: 'command',
          signal: 'tool',
          basis: 'command_exit',
          metrics: { exitCode: 2, durationMs: 42 },
        }),
        expect.objectContaining({ stage: 'command', signal: 'timeout', basis: 'command_timeout' }),
        expect.objectContaining({ stage: 'model', signal: 'network', errorCode: 'ENOTFOUND' }),
      ]),
    );
    const successes = result.records.filter(
      record =>
        (record.metrics.exitCode === 0 && record.basis !== 'command_timeout') ||
        record.metrics.durationMs === 1,
    );
    expect(
      successes.every(record => record.signal === 'unknown' && record.errorCode === undefined),
    ).toBe(true);
    expect(JSON.stringify(result)).not.toContain('SECRET');
  });

  it('retains exact-run machine failures when unrelated error logs exhaust preview capacity', async () => {
    const result = await collectDiagnosticLogs(
      report(),
      empty(),
      {
        lines: [
          ...Array.from({ length: 110 }, () => line({ runId: undefined, errorCategory: 'auth' })),
          line({
            errorCategory: undefined,
            level: 'info',
            type: 'exec.process.completed',
            exitCode: 2,
          }),
        ],
      },
      { fullScan: true },
    );
    expect(result.records).toHaveLength(100);
    expect(result.records).toContainEqual(
      expect.objectContaining({ association: 'run', basis: 'command_exit' }),
    );
    expect(result.sources.find(source => source.source === 'native')?.matched).toBe(111);
  });

  it('does not classify routine authentication and context window announcements as failures', async () => {
    const target = await file(
      [
        '[2026-09-28T10:00:00Z] [info] authentication initialized',
        '[2026-09-28T10:00:00Z] [debug] context window 200000 tokens',
        '[2026-09-28T10:00:00Z] [info] context limit configured',
      ].join('\n'),
    );
    const result = await collectDiagnosticLogs(report(), { ...empty(), main: [target] });
    expect(result.records).toEqual([]);
  });

  it('retains a finite classification basis and HTTP code without including unrelated JSON fields', async () => {
    const result = await collectDiagnosticLogs(report(), empty(), {
      lines: [
        line({
          errorCategory: undefined,
          level: 'info',
          message: 'HTTP 401',
          toolArgs: 'context_overflow SECRET',
        }),
        line({
          errorCategory: undefined,
          level: 'info',
          config: { authentication: 'SECRET', message: 'context_overflow' },
        }),
      ],
    });
    expect(result.records).toHaveLength(1);
    expect(result.records[0]).toMatchObject({
      signal: 'auth',
      basis: 'http_status',
      metrics: { statusCode: 401 },
    });
    expect(JSON.stringify(result)).not.toContain('SECRET');
  });
  it('recognizes native failure contracts without copying private tool or model content', async () => {
    const result = await collectDiagnosticLogs(report(), empty(), {
      lines: [
        line({
          errorCategory: 'tool_result_error',
          type: 'tool.execution.error',
          paramsSummary: 'SECRET',
        }),
        line({ errorCategory: undefined, type: 'tool.execution.blocked', deniedReason: 'SECRET' }),
        line({
          errorCategory: 'context_overflow',
          type: 'model.call.error',
          errorMessage: 'SECRET',
        }),
        line({ errorCategory: undefined, type: 'model.call.error' }),
        line({ errorCategory: 'auth_permanent' }),
      ],
    });
    expect(result.records.map(record => record.signal)).toEqual([
      'tool',
      'permission',
      'context',
      'provider',
      'auth',
    ]);
    expect(JSON.stringify(result)).not.toContain('SECRET');
  });

  it('does not turn successful native calls into errors', async () => {
    const result = await collectDiagnosticLogs(report(), empty(), {
      lines: [
        line({
          errorCategory: undefined,
          level: 'info',
          type: 'tool.execution.completed',
          toolName: 'authentication',
          paramsSummary: 'HTTP 401',
        }),
        line({
          errorCategory: undefined,
          level: 'info',
          type: 'model.call.completed',
          message: 'context_overflow',
        }),
      ],
    });
    expect(result.records).toEqual([]);
  });

  it('does not let incidental payload words hide structured native failures', async () => {
    const result = await collectDiagnosticLogs(report(), empty(), {
      lines: [
        line({
          errorCategory: undefined,
          type: 'tool.execution.blocked',
          paramsSummary: 'queue',
          deniedReason: 'SECRET',
        }),
        line({
          errorCategory: undefined,
          type: 'model.call.error',
          errorMessage: 'reconnecting SECRET',
        }),
      ],
    });
    expect(result.records.map(record => record.signal)).toEqual(['permission', 'provider']);
    expect(JSON.stringify(result)).not.toContain('SECRET');
  });

  it('reads native logger argument objects and prefers HTTP evidence over generic model failures', async () => {
    const result = await collectDiagnosticLogs(report(), empty(), {
      lines: [
        JSON.stringify({
          '0': { subsystem: 'diagnostic' },
          '1': { runId: 'native-run', type: 'model.call.error', statusCode: 429 },
          '2': 'SECRET',
          _meta: { date: new Date(time).toISOString(), logLevelName: 'ERROR' },
        }),
      ],
    });
    expect(result.records[0]).toMatchObject({
      signal: 'rate_limit',
      association: 'run',
      metrics: { statusCode: 429 },
    });
    expect(JSON.stringify(result)).not.toContain('SECRET');
  });

  it('recognizes tool failure and context-overflow text without treating textual identities as exact matches', async () => {
    const target = await file(
      [
        '[2026-09-28T10:00:00Z] [error] [tools] exec failed: SECRET runId=native-run',
        '[2026-09-28T10:00:00Z] [error] context_overflow SECRET',
        '[2026-09-28T10:00:00Z] [error] fetch failed SECRET',
      ].join('\n'),
    );
    const result = await collectDiagnosticLogs(report(), { ...empty(), main: [target] });
    expect(result.records.map(record => record.signal)).toEqual(['tool', 'context', 'network']);
    expect(result.records.every(record => record.association === 'time_window')).toBe(true);
    expect(JSON.stringify(result)).not.toContain('SECRET');
  });
  const directories: string[] = [];
  const file = async (text: string) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'diagnostic-logs-'));
    directories.push(directory);
    const target = path.join(directory, '中文 logs.log');
    await fs.writeFile(target, text);
    return target;
  };
  afterEach(async () => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    await Promise.all(
      directories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })),
    );
  });

  it('finds historical failures before the ordinary file tail', async () => {
    const historical = report();
    historical.run!.endedAt = time;
    historical.run!.state = 'failed';
    historical.events = [];
    const earlier = `[2026-09-28T10:00:00Z] [error] HTTP 503\n`;
    const later = '[2026-09-28T18:00:00Z] [info] poll completed\n'.repeat(16000);
    const target = await file(earlier + later);
    const result = await collectDiagnosticLogs(historical, { ...empty(), main: [target] });
    expect(result.records).toContainEqual(
      expect.objectContaining({ signal: 'provider', association: 'time_window' }),
    );
    expect(result.sources[0].bytesRead).toBeGreaterThan(512 * 1024);
    expect(result.sources[0].bytesRead).toBeLessThanOrEqual(4 * 1024 * 1024);
    expect(historical.events).toEqual([]);
  });

  it('preserves native run evidence with native transcript identities and never calls them product sessions', async () => {
    const result = await collectDiagnosticLogs(report(), empty(), {
      lines: [
        line({ sessionId: 'native-transcript-id' }),
        line({ runId: undefined, sessionId: 'native-transcript-id' }),
      ],
    });
    expect(result.records.map(record => record.association)).toEqual(['run', 'time_window']);
  });

  it('keeps final fatal evidence after noisy retries and sorts selected records by time', async () => {
    const target = await file(
      [
        ...Array.from({ length: 150 }, (_, index) =>
          line({ time: new Date(time + index).toISOString(), errorCategory: 'retry' }),
        ),
        line({ time: new Date(time + 200).toISOString(), errorCategory: 'storage' }),
      ].join('\n'),
    );
    const result = await collectDiagnosticLogs(report(), { ...empty(), main: [target] });
    expect(result.records).toHaveLength(100);
    expect(result.records.at(-1)).toMatchObject({ signal: 'storage', id: 'log-main-1' });
    expect(result.records[0].timestamp).toBe(time + 51);
  });

  it('uses the same numeric ceiling as export', async () => {
    const result = await collectDiagnosticLogs(report(), empty(), {
      lines: [line({ attempt: 1e12, durationMs: 1e12 + 1 })],
    });
    expect(result.records[0].metrics).toEqual({ attempt: 1e12 });
  });

  it('never mistakes timestamp milliseconds or unrelated numeric counts for HTTP failures', async () => {
    const codes = [401, 403, 429, 502, 503, 504];
    const target = await file(
      codes
        .map(code => `[2026-09-28T10:00:00.${code}+00:00] [info] completed ${code} tokens`)
        .join('\n'),
    );
    const result = await collectDiagnosticLogs(report(), { ...empty(), main: [target] });
    expect(result.records).toEqual([]);
    expect(result.sources[0].reasons).toContain('no_safe_fields');
  });

  it('recognizes contextual HTTP statuses and structured status codes without bare-number guessing', async () => {
    const target = await file(
      ['HTTP 401', 'HTTP/1.1 403', 'status=429', 'status code: 503']
        .map(message => `[2026-09-28T10:00:00Z] [info] ${message}`)
        .join('\n'),
    );
    const result = await collectDiagnosticLogs(
      report(),
      { ...empty(), main: [target] },
      {
        lines: [line({ errorCategory: undefined, statusCode: 504 })],
      },
    );
    expect(result.records.map(record => record.signal)).toEqual([
      'auth',
      'permission',
      'rate_limit',
      'provider',
      'provider',
    ]);
  });

  it('retains the latest native fatal record when separator bytes exceed the tail budget', async () => {
    const padded = (errorCategory: string) => {
      const base = line({ errorCategory, padding: '' });
      return line({ errorCategory, padding: 'x'.repeat(65536 - Buffer.byteLength(base)) });
    };
    const result = await collectDiagnosticLogs(report(), empty(), {
      lines: [...Array.from({ length: 7 }, () => padded('retry')), padded('storage')],
    });
    expect(result.sources[3]).toMatchObject({ truncated: true, emitted: 7 });
    expect(result.sources[3].bytesRead).toBeLessThanOrEqual(524288);
    expect(result.records.at(-1)?.signal).toBe('storage');
  });

  it('returns on deadline while closing a delayed read handle and never publishes late records', async () => {
    vi.useFakeTimers();
    let finishRead: ((result: { bytesRead: number }) => void) | undefined;
    const close = vi.fn(async () => {});
    const stat = { isSymbolicLink: () => false, isFile: () => true, size: 10, dev: 1, ino: 1 };
    vi.spyOn(fs, 'lstat').mockResolvedValue(stat as Awaited<ReturnType<typeof fs.lstat>>);
    vi.spyOn(fs, 'open').mockResolvedValue({
      stat: async () => stat,
      close,
      read: () =>
        new Promise(resolve => {
          finishRead = resolve;
        }),
    } as unknown as Awaited<ReturnType<typeof fs.open>>);
    const pending = collectDiagnosticLogs(report(), {
      ...empty(),
      main: [path.resolve('mock.log')],
    });
    await vi.advanceTimersByTimeAsync(5001);
    const result = await pending;
    expect(result.sources[0].reasons).toContain('limit');
    expect(result.records).toEqual([]);
    finishRead?.({ bytesRead: 0 });
    await vi.advanceTimersByTimeAsync(1);
    expect(close).toHaveBeenCalledOnce();
    expect(result.records).toEqual([]);
  });

  it('does not open a file after a delayed ancestor check finishes past the deadline', async () => {
    vi.useFakeTimers();
    let finishStat: ((value: Awaited<ReturnType<typeof fs.lstat>>) => void) | undefined;
    const stat = { isSymbolicLink: () => false } as Awaited<ReturnType<typeof fs.lstat>>;
    vi.spyOn(fs, 'lstat').mockImplementation(
      () =>
        new Promise(resolve => {
          finishStat = resolve;
        }),
    );
    const open = vi.spyOn(fs, 'open');
    const pending = collectDiagnosticLogs(report(), {
      ...empty(),
      main: [path.resolve('mock.log')],
    });
    await vi.advanceTimersByTimeAsync(5001);
    expect((await pending).sources[0].reasons).toContain('limit');
    finishStat?.(stat);
    await vi.advanceTimersByTimeAsync(1);
    expect(open).not.toHaveBeenCalled();
  });

  it('associates native structured arguments and only exposes finite evidence', async () => {
    const result = await collectDiagnosticLogs(report(), empty(), {
      lines: [
        JSON.stringify({
          time: new Date(time).toISOString(),
          _meta: { logLevelName: 'ERROR' },
          0: JSON.stringify({
            runId: 'native-run',
            errorCategory: 'network',
            attempt: 2,
            statusCode: 503,
          }),
          1: 'Authorization: Bearer CANARY-SECRET https://private.test?token=CANARY-SECRET',
          prompt: 'CANARY-PROMPT',
          error: 'CANARY-ERROR',
        }),
      ],
    });
    expect(result.records).toMatchObject([
      {
        association: 'run',
        signal: 'network',
        inferred: true,
        metrics: { attempt: 2, statusCode: 503 },
      },
    ]);
    expect(JSON.stringify(result)).not.toMatch(/CANARY|native-run|private\.test/);
  });

  it('never promotes free-text identity claims or nested prompt objects to exact association', async () => {
    const target = await file(
      `[2026-09-28T10:00:00Z] [ERROR] timeout runId=native-run sessionId=secret-session\n`,
    );
    const result = await collectDiagnosticLogs(
      report(),
      { ...empty(), main: [target] },
      { lines: [line({ runId: undefined, prompt: { runId: 'native-run' } })] },
    );
    expect(result.records).toHaveLength(2);
    expect(result.records.every(record => record.association === 'time_window')).toBe(true);
    expect(result.records[0].inferred).toBe(true);
  });

  it('excludes other or conflicting identities despite matching timestamps', async () => {
    const target = await file(
      [
        line({ runId: 'native-run-other' }),
        line({ sessionId: 'other-session' }),
        line({ 0: { runId: 'other-run' } }),
        line(),
      ].join('\n'),
    );
    const result = await collectDiagnosticLogs(report(), { ...empty(), main: [target] });
    expect(result.records).toHaveLength(1);
    expect(result.sources[0].suppressed).toBe(3);
  });

  it('includes exact run evidence without timestamps but rejects uncorrelated old records', async () => {
    const result = await collectDiagnosticLogs(report(), empty(), {
      lines: [
        line({ time: undefined }),
        line({ runId: undefined, time: '2020-01-01T00:00:00Z' }),
        line({ runId: undefined, sessionId: 'secret-session', time: undefined }),
      ],
    });
    expect(result.records).toHaveLength(1);
    expect(result.records[0].timestamp).toBeUndefined();
  });

  it('reports unavailable sources independently while collecting a valid source', async () => {
    const target = await file(line());
    const result = await collectDiagnosticLogs(report(), {
      main: [target],
      cowork: [`${target}.missing`],
      gateway: [path.dirname(target)],
    });
    expect(result.records).toHaveLength(1);
    expect(result.sources.map(source => source.reasons)).toEqual([
      [],
      ['missing'],
      ['unsafe_file'],
      ['native_unavailable'],
    ]);
    expect(JSON.stringify(result)).not.toContain(path.dirname(target));
  });

  it('discards malformed JSON, invalid encoding and oversized records with explicit losses', async () => {
    const target = await file(`${line()}\n`);
    await fs.appendFile(target, Buffer.from([0xff, 0xfe, 10]));
    const result = await collectDiagnosticLogs(
      report(),
      { ...empty(), main: [target] },
      {
        lines: ['{"time":', line({ prompt: 'x'.repeat(70 * 1024) }), line()],
      },
    );
    expect(result.sources[0].parseFailures).toBe(1);
    expect(result.sources[3]).toMatchObject({ parseFailures: 1, suppressed: 2, truncated: true });
    expect(result.records).toHaveLength(1);
  });

  it('bounds huge files and marks clipping instead of claiming complete time coverage', async () => {
    const target = await file(`${'x'.repeat(600 * 1024)}\n${line()}\n`);
    const result = await collectDiagnosticLogs(report(), { ...empty(), gateway: [target] });
    expect(result.sources[2]).toMatchObject({
      bytesRead: 512 * 1024,
      truncated: true,
      status: 'partial',
    });
    expect(result.records).toHaveLength(1);
  });

  it('caps emitted records and ignores prototype and nonfinite numeric fields', async () => {
    const result = await collectDiagnosticLogs(report(), empty(), {
      lines: Array.from({ length: 500 }, () =>
        line({
          attempt: -1,
          durationMs: 'CANARY',
          statusCode: 429,
          ['__proto__']: { runId: 'other' },
        }),
      ),
    });
    expect(result.records).toHaveLength(100);
    expect(result.records[0].metrics).toEqual({ statusCode: 429 });
    expect(result.sources[3]).toMatchObject({ truncated: true, suppressed: 400 });
  });

  it('treats multiline stack text as one record and preserves only an inferred finite hint', async () => {
    const target = await file(
      '[2026-09-28T10:00:00Z] [ERROR] request failed\n  at CANARY-PATH\n  caused by ETIMEDOUT\n',
    );
    const result = await collectDiagnosticLogs(report(), { ...empty(), cowork: [target] });
    expect(result.records).toMatchObject([
      { signal: 'timeout', inferred: true, association: 'time_window' },
    ]);
    expect(result.sources[1].recordsRead).toBe(1);
    expect(JSON.stringify(result)).not.toContain('CANARY');
  });

  it('rejects directory junctions and network paths without exposing their names', async () => {
    const target = await file(line());
    const linked = path.join(path.dirname(target), 'linked');
    await fs.symlink(path.dirname(target), linked, 'junction');
    const result = await collectDiagnosticLogs(report(), {
      ...empty(),
      main: [path.join(linked, path.basename(target)), '\\\\CANARY-HOST\\share\\secret.log'],
    });
    expect(result.sources[0]).toMatchObject({ status: 'unavailable', reasons: ['unsafe_file'] });
    expect(JSON.stringify(result)).not.toContain('CANARY');
  });

  it('caps attempted files even if every file is missing', async () => {
    const target = await file('');
    const result = await collectDiagnosticLogs(report(), {
      ...empty(),
      main: Array.from({ length: 30 }, (_, index) => `${target}.${index}`),
    });
    expect(result.sources[0]).toMatchObject({
      truncated: true,
      filesRead: 0,
      reasons: ['missing', 'limit'],
    });
  });

  it('interprets offset-less main records in local time with the assumption recorded', async () => {
    const date = new Date(time);
    const pad = (value: number) => String(value).padStart(2, '0');
    const local = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.000`;
    const target = await file(`[${local}] [error] timeout\n`);
    const result = await collectDiagnosticLogs(report(), { ...empty(), main: [target] });
    expect(result.records[0].timestamp).toBe(time);
    expect(result.localTimezoneOffsetMinutes).toBe(new Date().getTimezoneOffset());
  });

  it('reserves output capacity for every source when main logs are noisy', async () => {
    const noisy = await file(Array.from({ length: 500 }, () => line()).join('\n'));
    const small = await file(line());
    const result = await collectDiagnosticLogs(
      report(),
      { main: [noisy], cowork: [small], gateway: [small] },
      { lines: [line()] },
    );
    expect(result.sources.map(source => source.emitted)).toEqual([100, 1, 1, 1]);
    expect(result.sources[0].truncated).toBe(true);
  });

  it('records application crash and navigation hints only as uncertain time context', async () => {
    const target = await file(
      ['render-process-gone', 'did-fail-load', 'uncaughtException', 'unhandledRejection']
        .map(message => `[2026-09-28T10:00:00Z] [info] ${message} CANARY\n`)
        .join(''),
    );
    const result = await collectDiagnosticLogs(report(), { ...empty(), main: [target] });
    expect(result.records.map(record => record.signal)).toEqual([
      'process_exit',
      'network',
      'unknown',
      'unknown',
    ]);
    expect(
      result.records.every(record => record.inferred && record.association === 'time_window'),
    ).toBe(true);
    expect(JSON.stringify(result)).not.toContain('CANARY');
  });
});
