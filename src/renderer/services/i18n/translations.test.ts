import { describe, expect, test } from 'vitest';

import { translations } from './translations';

describe('user-facing translations', () => {
  test('does not expose the runtime implementation name in user-facing copy', () => {
    for (const languageTranslations of Object.values(translations)) {
      for (const value of Object.values(languageTranslations)) {
        expect(value).not.toMatch(/openclaw/i);
      }
    }
  });

  test('do not expose gateway jargon', () => {
    for (const languageTranslations of Object.values(translations)) {
      for (const value of Object.values(languageTranslations)) {
        expect(value).not.toMatch(/gateway|网关/i);
      }
    }
  });
});
