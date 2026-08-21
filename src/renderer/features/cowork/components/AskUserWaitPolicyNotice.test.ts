import { describe, expect, it } from 'vitest';

import { formatAskUserCountdown } from './AskUserWaitPolicyNotice';

describe('formatAskUserCountdown', () => {
  it('formats the remaining duration as zero-padded minutes and seconds', () => {
    expect(formatAskUserCountdown(601_000, 1_000)).toBe('10:00');
    expect(formatAskUserCountdown(62_000, 1_000)).toBe('01:01');
  });

  it('rounds partial seconds up and never displays a negative duration', () => {
    expect(formatAskUserCountdown(1_001, 1_000)).toBe('00:01');
    expect(formatAskUserCountdown(1_000, 1_001)).toBe('00:00');
  });
});
