import { describe, expect, test } from 'vitest';

import { stringifyScheduledTaskLog } from './scheduledTaskLog';

describe('stringifyScheduledTaskLog', () => {
  test('writes compact single-line JSON', () => {
    const output = stringifyScheduledTaskLog({
      name: 'Summary',
      schedule: { kind: 'at', at: '2026-08-24T10:00:00.000Z' },
    });

    expect(output).toBe(
      '{"name":"[redacted]","schedule":{"kind":"at","at":"2026-08-24T10:00:00.000Z"}}',
    );
    expect(output).not.toMatch(/[\r\n]/);
  });

  test('redacts task content instead of logging previews', () => {
    const output = stringifyScheduledTaskLog({
      name: 'Sensitive name',
      payload: { kind: 'agentTurn', message: 'sensitive-content' },
      delivery: { to: 'https://example.test/hook?token=secret', accountId: 'private' },
    });

    expect(JSON.parse(output)).toEqual({
      name: '[redacted]',
      payload: { kind: 'agentTurn', message: '[redacted]' },
      delivery: { to: '[redacted]', accountId: '[redacted]' },
    });
    expect(output).not.toContain('sensitive-content');
    expect(output).not.toContain('token=secret');
  });

  test('redacts command execution context', () => {
    const output = stringifyScheduledTaskLog({
      payload: { kind: 'command', argv: ['tool', '--token', 'secret'], env: { TOKEN: 'x' } },
    });

    expect(JSON.parse(output).payload).toEqual({
      kind: 'command',
      argv: '[redacted]',
      env: '[redacted]',
    });
    expect(output).not.toContain('secret');
  });
});
