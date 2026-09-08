import { describe, expect, test } from 'vitest';

import { formatAskUserCountdown } from './AskUserWaitPolicyNotice';

describe('AskUserWaitPolicyNotice', () => {
  test('formats the remaining timeout as minutes and seconds', () => {
    expect(formatAskUserCountdown(670_000, 10_000)).toBe('11:00');
    expect(formatAskUserCountdown(10_000, 10_001)).toBe('00:00');
  });
});
