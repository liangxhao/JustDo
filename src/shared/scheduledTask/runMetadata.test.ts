import { describe, expect, test } from 'vitest';

import { normalizeScheduledTaskRunMetadata } from './runMetadata';

describe('native scheduled task receipt metadata', () => {
  test('keeps independent completion and actual model facts while dropping arbitrary details', () => {
    expect(
      normalizeScheduledTaskRunMetadata({
        completionStatus: 'unknown',
        model: 'actual-model',
        provider: 'internal',
        usage: { input_tokens: 0, output_tokens: 12, secret: 'hidden', total_tokens: Infinity },
        diagnostics: {
          summary: 'Delivery could not be confirmed',
          entries: [
            {
              ts: 10,
              source: 'delivery',
              severity: 'warn',
              message: 'Timed out',
              details: { url: 'secret' },
            },
          ],
        },
        details: { html: '<script />' },
      }),
    ).toEqual({
      completionStatus: 'unknown',
      model: 'actual-model',
      provider: 'internal',
      usage: { input_tokens: 0, output_tokens: 12 },
      diagnostics: {
        summary: 'Delivery could not be confirmed',
        entries: [{ ts: 10, source: 'delivery', severity: 'warn', message: 'Timed out' }],
      },
    });
  });

  test('bounds diagnostics and rejects unrecognized sources and malformed values', () => {
    const metadata = normalizeScheduledTaskRunMetadata({
      completionStatus: 'ok',
      diagnostics: {
        summary: 's'.repeat(5000),
        entries: [
          { ts: 1, source: 'untrusted', severity: 'error', message: 'invalid' },
          ...Array.from({ length: 40 }, () => ({
            ts: 1,
            source: 'exec',
            severity: 'error',
            message: 'm'.repeat(3000),
            exitCode: 1,
          })),
        ],
      },
    });
    expect(metadata.completionStatus).toBeUndefined();
    expect(metadata.diagnostics?.summary).toHaveLength(4096);
    expect(metadata.diagnostics?.entries).toHaveLength(32);
    expect(metadata.diagnostics?.entries[0]).toMatchObject({
      message: 'm'.repeat(2048),
      truncated: true,
      exitCode: 1,
    });
    expect(normalizeScheduledTaskRunMetadata(undefined)).toEqual({});
  });
});
