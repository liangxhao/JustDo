import { describe, expect, test } from 'vitest';

import { translations } from './translations';

describe('user-facing translations', () => {
  test('do not expose the runtime implementation name', () => {
    for (const languageTranslations of Object.values(translations)) {
      for (const value of Object.values(languageTranslations)) {
        expect(value).not.toMatch(/openclaw/i);
      }
    }
  });
});
