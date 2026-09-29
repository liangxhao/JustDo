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
});
