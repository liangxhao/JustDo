import { describe, expect, it } from 'vitest';

import { DiagnosticExportLogs, redactDiagnosticLog } from './exportLogs';

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
    expect(result.entries['logs/main.log']).toContain('native failure\n  at worker.js:12');
    expect(result.entries['logs/main.log']).not.toContain('PRIVATE');
    expect(result.entries['logs/main.log']).toContain('context 80');
    expect(result.coverage[0]).toMatchObject({
      seenRecords: 81,
      selection: 'evidence_priority_with_recent_context',
    });
    expect(result.coverage[0].omitted).toBeGreaterThan(0);
    expect(result.coverage[0].omittedBytes).toBeGreaterThan(0);
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
    expect(result.entries['logs/gateway.log']).toContain('exact run failure');
    expect(result.entries['logs/native.log']).toContain('independent native evidence');
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
    const lines = result.entries['logs/main.log'].split('\n');
    for (const record of result.index ?? []) {
      expect(lines[record.line - 1]).toContain(`record=${record.id}`);
      expect(lines[record.endLine - 1]).not.toBe('');
    }
    expect(result.index?.find(record => record.id === 'log-main-1')).toMatchObject({
      line: 4,
      endLine: 6,
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
    expect(result.entries['logs/main.log']).not.toContain('unknown');
  });
});
