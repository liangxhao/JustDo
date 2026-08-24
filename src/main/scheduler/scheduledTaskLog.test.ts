import { describe, expect, test } from 'vitest';

import { stringifyScheduledTaskLog } from './scheduledTaskLog';

describe('stringifyScheduledTaskLog', () => {
  test('writes compact single-line JSON', () => {
    const output = stringifyScheduledTaskLog({
      name: 'Summary',
      schedule: { kind: 'at', at: '2026-08-24T10:00:00.000Z' },
    });

    expect(output).toBe(
      '{"name":"Summary","schedule":{"kind":"at","at":"2026-08-24T10:00:00.000Z"}}',
    );
    expect(output).not.toMatch(/[\r\n]/);
  });

  test('keeps only the first 30 characters of nested message fields', () => {
    const visible = '123456789012345678901234567890';
    const sensitiveSuffix = 'sensitive-content';

    const output = stringifyScheduledTaskLog({
      payload: { kind: 'agentTurn', message: `${visible}${sensitiveSuffix}` },
    });

    expect(JSON.parse(output)).toEqual({
      payload: { kind: 'agentTurn', message: `${visible}…` },
    });
    expect(output).not.toContain(sensitiveSuffix);
  });

  test('counts Unicode code points instead of splitting surrogate pairs', () => {
    const output = stringifyScheduledTaskLog({ message: `${'你'.repeat(29)}😀secret` });

    expect(JSON.parse(output).message).toBe(`${'你'.repeat(29)}😀…`);
    expect(output).not.toContain('secret');
  });
});
