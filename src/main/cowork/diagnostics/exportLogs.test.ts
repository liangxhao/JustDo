import { describe, expect, it } from 'vitest';

import { DiagnosticExportLogs, redactDiagnosticLog } from './exportLogs';

const logTime = '2026-09-28T10:00:00.000Z';
const logTimestamp = Date.parse(logTime);
const localLogTime = (timestamp: number) => {
  const date = new Date(timestamp);
  return new Date(timestamp - date.getTimezoneOffset() * 60_000)
    .toISOString()
    .slice(0, -1)
    .replace('T', ' ');
};

describe('local diagnostic log text export', () => {
  it('keeps the error and stack while masking common credential formats', () => {
    const text =
      'Error: ENOENT missing executable\n  at run (worker.js:12)\nAuthorization: Bearer SECRET_TOKEN\nCookie: session=SECRET_SESSION; other=SECRET_COOKIE\npassword="SECRET_PASSWORD"\nhttps://user:SECRET_PASS@example.test/path?api_key=SECRET_QUERY';
    const safe = redactDiagnosticLog(text);
    expect(safe).toContain('ENOENT missing executable');
    expect(safe).toContain('worker.js:12');
    expect(safe).not.toContain('SECRET');
  });

  it('masks JSON credentials, including serialized logger arguments, without removing error detail', () => {
    const safe = redactDiagnosticLog(
      JSON.stringify({
        message: 'Tool validation failed: missing required path',
        token: 'SECRET_TOKEN',
        headers: { authorization: 'SECRET_AUTH', cookie: 'SECRET_COOKIE' },
        '1': JSON.stringify({ apiKey: 'SECRET_KEY', error: 'ECONNREFUSED' }),
      }),
    );
    expect(safe).toContain('missing required path');
    expect(safe).toContain('ECONNREFUSED');
    expect(safe).not.toContain('SECRET');
  });

  it('normalizes verified source times in place and preserves differing times and native metadata', () => {
    const capture = new DiagnosticExportLogs();
    const original = '2026-09-28T18:00:00.000+08:00';
    const differentTime = '2026-09-28T10:00:00.012+00:00';
    capture.append('main', `[${localLogTime(logTimestamp)}] [info] started`, 'run', {
      id: 'log-main-1',
      timestamp: logTimestamp,
      level: 'info',
    });
    capture.append(
      'cowork',
      `[${original}] [INFO] using original payload time ${original}`,
      'run',
      {
        id: 'log-cowork-1',
        timestamp: logTimestamp,
        level: 'info',
      },
    );
    capture.append('gateway', `[${original}] [stdout] independent time`, 'run', {
      id: 'log-gateway-1',
      timestamp: logTimestamp + 12,
      level: 'info',
    });
    const nativeRecord = {
      time: original,
      hostname: 'host',
      0: 'a native message',
      message: 'a native message',
      _meta: {
        date: logTime,
        hostname: 'host',
        logLevelName: 'INFO',
        path: { fileName: 'log.ts' },
      },
      context: { time: original },
    };
    capture.append('native', JSON.stringify(nativeRecord), 'run', {
      id: 'log-native-1',
      timestamp: logTimestamp,
      level: 'info',
    });
    const distinctRecord = {
      ...nativeRecord,
      _meta: { ...nativeRecord._meta, date: differentTime, hostname: 'worker' },
      message: 'a different message',
    };
    capture.append('native', JSON.stringify(distinctRecord), 'run', {
      id: 'log-native-2',
      timestamp: logTimestamp,
      level: 'info',
    });
    const metaOnly = {
      ...nativeRecord,
      time: undefined,
      _meta: { ...nativeRecord._meta, date: original },
    };
    capture.append('native', JSON.stringify(metaOnly), 'run', {
      id: 'log-native-3',
      timestamp: logTimestamp,
      level: 'info',
    });

    const result = capture.finish();

    expect(result.entries['logs/main.log']).toBe(`[${logTime}] [info] started\n`);
    expect(result.entries['logs/cowork.log']).toBe(
      `[${logTime}] [INFO] using original payload time ${original}\n`,
    );
    expect(result.entries['logs/gateway.log']).toBe(`[${original}] [stdout] independent time\n`);
    expect(
      result.entries['logs/native.log']
        .trimEnd()
        .split('\n')
        .map(line => JSON.parse(line)),
    ).toEqual([
      {
        time: logTime,
        hostname: 'host',
        0: 'a native message',
        context: { time: original },
        _meta: { logLevelName: 'INFO', path: { fileName: 'log.ts' } },
      },
      { ...distinctRecord, time: logTime },
      {
        hostname: 'host',
        0: 'a native message',
        context: { time: original },
        _meta: { date: logTime, logLevelName: 'INFO', path: { fileName: 'log.ts' } },
      },
    ]);
  });

  it('omits only one matching console copy per retained Gateway row and preserves forwarded errors', () => {
    const capture = new DiagnosticExportLogs();
    const gateway = (
      id: number,
      stream: string,
      body: string,
      association: 'run' | 'time_window' = 'run',
    ) =>
      capture.append('gateway', `[${logTime}] [${stream}] ${body}`, association, {
        id: `log-gateway-${id}`,
        timestamp: logTimestamp,
        level: 'unknown',
      });
    const main = (id: number, stream: string, body: string, delay: number) => {
      const timestamp = logTimestamp + delay;
      const level = stream === 'stderr' ? 'error' : 'info';
      capture.append(
        'main',
        `[${localLogTime(timestamp)}] [${level}] [OpenClaw ${stream}] ${body}`,
        'run',
        {
          id: `log-main-${id}`,
          timestamp,
          level,
        },
      );
    };
    const date = new Date(logTimestamp);
    const offset = -date.getTimezoneOffset();
    const hours = String(Math.floor(Math.abs(offset) / 60)).padStart(2, '0');
    const minutes = String(Math.abs(offset) % 60).padStart(2, '0');
    const forwardedTime = `${localLogTime(logTimestamp).replace(' ', 'T')}${offset >= 0 ? '+' : '-'}${hours}:${minutes}`;
    gateway(1, 'stdout', `nearby ${logTime}`);
    gateway(2, 'stderr', 'Error: provider timed out');
    gateway(3, 'stdout', 'two redactions token=FIRST');
    gateway(4, 'stdout', 'wrong stream');
    gateway(5, 'stdout', 'weaker association', 'time_window');
    main(1, 'stdout', `nearby ${forwardedTime}`, 1);
    main(2, 'stdout', `nearby ${forwardedTime}`, 2);
    main(3, 'stderr', 'Error: provider timed out', 2);
    main(4, 'stderr', 'wrong stream', 3);
    main(5, 'stdout', 'two redactions token=SECOND', 5);
    main(6, 'stdout', 'weaker association', 6);
    main(7, 'stdout', `nearby ${forwardedTime}`, 101);

    const result = capture.finish();

    expect(result.coverage[0]).toMatchObject({
      seenRecords: 7,
      records: 5,
      omitted: 0,
      duplicateRecords: 2,
    });
    expect(result.entries['logs/main.log'].match(/nearby/g)).toHaveLength(2);
    expect(result.entries['logs/main.log']).toContain('two redactions token=[REDACTED]');
    expect(result.entries['logs/main.log']).toContain('weaker association');
    expect(result.entries['logs/gateway.log']).not.toContain('provider timed out');
    expect(result.entries['errors.log']).toBe(
      `[${logTime}] [stderr] Error: provider timed out\n[${new Date(logTimestamp + 3).toISOString()}] [error] [OpenClaw stderr] wrong stream\n`,
    );
    expect(result.index).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'log-main-1' })]),
    );
    expect(result.index?.find(record => record.id === 'log-gateway-2')).toMatchObject({
      file: 'errors.log',
      line: 1,
      endLine: 1,
      level: 'error',
      source: 'gateway',
    });
    expect(result.coverage[0].bytes).toBe(
      Buffer.byteLength(result.entries['logs/main.log']) +
        Buffer.byteLength(result.entries['errors.log'].split('\n')[1] + '\n'),
    );
  });

  it('retains the Main error if the corresponding Gateway line was evicted', () => {
    const capture = new DiagnosticExportLogs();
    capture.append('gateway', `[${logTime}] [stderr] Error: fallback`, 'time_window', {
      id: 'log-gateway-1',
      timestamp: logTimestamp,
      level: 'unknown',
    });
    for (let index = 2; index <= 2049; index++) {
      capture.append('gateway', `record ${index}`, 'run', {
        id: `log-gateway-${index}`,
        timestamp: logTimestamp,
        level: 'info',
      });
    }
    capture.append(
      'main',
      `[${localLogTime(logTimestamp)}] [error] [OpenClaw stderr] Error: fallback`,
      'time_window',
      {
        id: 'log-main-1',
        timestamp: logTimestamp,
        level: 'error',
      },
    );

    const result = capture.finish();

    expect(result.entries['errors.log']).toBe(
      `[${logTime}] [error] [OpenClaw stderr] Error: fallback\n`,
    );
    expect(result.coverage[0]).not.toHaveProperty('duplicateRecords');
    expect(result.coverage[2].omitted).toBe(1);
  });

  it('keeps more than the UI preview limit and reports source byte omissions', () => {
    const capture = new DiagnosticExportLogs();
    for (let index = 0; index < 500; index++) capture.append('main', `record ${index}`, 'run');
    expect(capture.finish().coverage[0].records).toBe(500);
    for (let index = 0; index < 40; index++)
      capture.append('main', 'x'.repeat(65536), 'time_window');
    const result = capture.finish();
    expect(result.coverage[0].omitted).toBeGreaterThan(0);
    expect(result.coverage[0].bytes).toBeLessThanOrEqual(2 * 1024 * 1024);
    expect(result.entries['logs/main.log']).toContain('record 499');
    expect(result.entries['logs/native.log']).toBe('');
  });

  it('retains late exact-run failures and their whole stack after noisy context fills the source', () => {
    const capture = new DiagnosticExportLogs();
    for (let index = 1; index <= 80; index++)
      capture.append('main', `context ${index} ${'x'.repeat(60000)}`, 'time_window', {
        id: `log-main-${index}`,
        timestamp: index,
        level: 'info',
      });
    capture.append('main', 'Error: native failure\n  at worker.js:12\npassword=PRIVATE', 'run', {
      id: 'log-main-81',
      timestamp: 81,
      level: 'error',
    });
    const result = capture.finish();
    expect(result.entries['errors.log']).toContain('native failure\n  at worker.js:12');
    expect(result.entries['errors.log']).not.toContain('PRIVATE');
    expect(result.entries['logs/main.log']).not.toContain('native failure');
    expect(result.entries['logs/main.log']).toContain('context 80');
    expect(result.coverage[0]).toMatchObject({
      seenRecords: 81,
      selection: 'evidence_priority_with_recent_context',
    });
    expect(result.coverage[0].omitted).toBeGreaterThan(0);
    expect(result.coverage[0].omittedBytes).toBeGreaterThan(0);
  });

  it('retains a run recovery exhaustion even when later same-run errors fill the source', () => {
    const capture = new DiagnosticExportLogs();
    capture.append('native', 'exhausted response recovery', 'run', {
      id: 'log-native-1',
      timestamp: 1,
      level: 'info',
      isError: true,
      recoveryExhausted: true,
    });
    for (let index = 2; index <= 2050; index++) {
      capture.append('native', `routine error ${index}`, 'run', {
        id: `log-native-${index}`,
        timestamp: index,
        level: 'error',
      });
    }
    const result = capture.finish();
    expect(result.entries['errors.log']).toContain('exhausted response recovery');
    expect(result.coverage.find(source => source.source === 'native')).toMatchObject({
      records: 2048,
      omitted: 2,
    });
  });

  it('preserves exact-run context ahead of unrelated errors and keeps sources isolated', () => {
    const capture = new DiagnosticExportLogs();
    capture.append('gateway', 'exact run preparation', 'run', {
      id: 'log-gateway-1',
      timestamp: 1,
      level: 'info',
    });
    capture.append('gateway', 'exact run failure', 'run', {
      id: 'log-gateway-2',
      timestamp: 2,
      level: 'error',
    });
    for (let index = 3; index < 100; index++)
      capture.append('gateway', `unrelated ${index} ${'x'.repeat(60000)}`, 'time_window', {
        id: `log-gateway-${index}`,
        timestamp: index,
        level: 'error',
      });
    capture.append('native', 'independent native evidence', 'run', {
      id: 'log-native-1',
      timestamp: 1,
      level: 'error',
    });
    const result = capture.finish();
    expect(result.entries['logs/gateway.log']).toContain('exact run preparation');
    expect(result.entries['errors.log']).toContain(
      'independent native evidence\nexact run failure',
    );
    expect(result.entries['logs/native.log']).toBe('');
    expect(result.coverage.find(source => source.source === 'native')?.omitted).toBe(0);
  });

  it('orders known times chronologically and unknown times afterward in stable scan order', () => {
    const capture = new DiagnosticExportLogs();
    capture.append('main', 'late\nstack', 'run', {
      id: 'log-main-1',
      timestamp: 100,
      level: 'error',
    });
    capture.append('main', 'unknown first', 'run', { id: 'log-main-2', level: 'error' });
    capture.append('main', 'early', 'run', { id: 'log-main-3', timestamp: 50, level: 'error' });
    capture.append('main', 'unknown second', 'run', { id: 'log-main-4', level: 'error' });
    const result = capture.finish();
    expect(result.index?.map(record => record.id)).toEqual([
      'log-main-3',
      'log-main-1',
      'log-main-2',
      'log-main-4',
    ]);
    expect(result.entries['errors.log']).toBe(
      'early\nlate\nstack\nunknown first\nunknown second\n',
    );
    expect(result.index?.find(record => record.id === 'log-main-1')).toMatchObject({
      file: 'errors.log',
      line: 2,
      endLine: 3,
    });
  });

  it('bounds tiny-record indexes and deterministically evicts unknown-time records first at equal priority', () => {
    const capture = new DiagnosticExportLogs();
    capture.append('main', 'unknown', 'run', { id: 'log-main-1', level: 'error' });
    for (let index = 2; index <= 2050; index++)
      capture.append('main', `record ${index}`, 'run', {
        id: `log-main-${index}`,
        timestamp: index,
        level: 'error',
      });
    const result = capture.finish();
    expect(result.coverage[0]).toMatchObject({
      records: 2048,
      recordLimit: 2048,
      omitted: 2,
      seenRecords: 2050,
    });
    expect(result.index?.[0].id).toBe('log-main-3');
    expect(result.entries['errors.log']).not.toContain('unknown');
  });
});
