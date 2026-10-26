import { afterEach, expect, test, vi } from 'vitest';

import { resolveComposerSubmissionStartedAt } from './composerSubmissionTiming';

afterEach(() => vi.restoreAllMocks());

test('preserves the click timestamp across model preparation', () => {
  const metadata = { startedAt: 1_000 };
  vi.spyOn(Date, 'now').mockReturnValue(9_000);
  expect(resolveComposerSubmissionStartedAt(metadata)).toBe(1_000);
});

test('keeps the current timing for callers without click metadata', () => {
  vi.spyOn(Date, 'now').mockReturnValue(9_000);
  expect(resolveComposerSubmissionStartedAt()).toBe(9_000);
  expect(resolveComposerSubmissionStartedAt({ startedAt: Number.NaN })).toBe(9_000);
});
