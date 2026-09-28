import { expect, test } from 'vitest';

import { hasComposerContent } from './composerContent';

test('allows a quote-only message but still requires text for goal feedback', () => {
  expect(hasComposerContent('', 0, 0, false, false, 1)).toBe(true);
  expect(hasComposerContent('', 0, 0, false, true, 1)).toBe(false);
});

test('requires a written objective when continuing a completed goal', () => {
  expect(hasComposerContent('', 1, 0, false, true)).toBe(false);
  expect(hasComposerContent(' ', 0, 1, true, true)).toBe(false);
  expect(hasComposerContent('Fix the attached issue', 1, 0, false, true)).toBe(true);
});

test.each([
  [' ', 0, 0, false, false],
  ['hello', 0, 0, false, true],
  ['', 1, 0, false, true],
  ['', 0, 1, false, true],
  ['', 0, 0, true, true],
  [' ', 2, 1, true, true],
] as const)(
  'checks all composer content: %j %i %i %j',
  (text, files, annotations, recording, expected) => {
    expect(hasComposerContent(text, files, annotations, recording)).toBe(expected);
  },
);
