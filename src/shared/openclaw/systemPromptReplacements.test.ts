import { describe, expect, it } from 'vitest';

import {
  normalizeSystemPromptReplacementRules,
  SYSTEM_PROMPT_REPLACEMENT_DEFAULT_FLAGS,
} from './systemPromptReplacements';

describe('normalizeSystemPromptReplacementRules', () => {
  it('normalizes an ordered list and defaults to global replacement', () => {
    expect(
      normalizeSystemPromptReplacementRules([
        {
          id: 'remove-runtime',
          pattern: '## Runtime[\\s\\S]*$',
          replacement: '',
        },
      ]),
    ).toEqual([
      {
        id: 'remove-runtime',
        pattern: '## Runtime[\\s\\S]*$',
        flags: SYSTEM_PROMPT_REPLACEMENT_DEFAULT_FLAGS,
        replacement: '',
        enabled: true,
      },
    ]);
  });

  it('rejects invalid regular expressions and duplicate ids', () => {
    expect(() =>
      normalizeSystemPromptReplacementRules([
        { id: 'broken', pattern: '(', flags: 'g', replacement: '' },
      ]),
    ).toThrow(/broken is invalid/i);

    expect(() =>
      normalizeSystemPromptReplacementRules([
        { id: 'same', pattern: 'one', replacement: '' },
        { id: 'same', pattern: 'two', replacement: '' },
      ]),
    ).toThrow(/duplicate/i);
  });

  it('rejects invalid optional fields and oversized ids', () => {
    expect(() =>
      normalizeSystemPromptReplacementRules([
        { id: 'bad-flags', pattern: 'old', flags: false, replacement: 'new' },
      ]),
    ).toThrow(/flags must be a string/i);

    expect(() =>
      normalizeSystemPromptReplacementRules([
        { id: 'bad-enabled', pattern: 'old', replacement: 'new', enabled: 1 },
      ]),
    ).toThrow(/enabled must be a boolean/i);

    expect(() =>
      normalizeSystemPromptReplacementRules([
        { id: 'x'.repeat(129), pattern: 'old', replacement: 'new' },
      ]),
    ).toThrow(/id is too long/i);
  });
});
