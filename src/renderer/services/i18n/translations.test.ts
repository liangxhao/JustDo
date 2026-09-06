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

  test('do not expose gateway jargon', () => {
    for (const languageTranslations of Object.values(translations)) {
      for (const value of Object.values(languageTranslations)) {
        expect(value).not.toMatch(/gateway|网关/i);
      }
    }
  });

  test('keeps thinking effort labels aligned in both languages', () => {
    const keys = [
      'agentRuntimeThinkingOff',
      'agentRuntimeThinkingMinimal',
      'agentRuntimeThinkingLow',
      'agentRuntimeThinkingMedium',
      'agentRuntimeThinkingHigh',
      'agentRuntimeThinkingXHigh',
      'agentRuntimeThinkingAdaptive',
      'agentRuntimeThinkingMax',
      'agentRuntimeThinkingUltra',
    ];
    const expected = [
      'Off',
      'Minimal',
      'Low',
      'Medium',
      'High',
      'Extra high',
      'Adaptive',
      'Maximum',
      'Ultra',
    ];

    for (const languageTranslations of Object.values(translations)) {
      expect(keys.map(key => languageTranslations[key])).toEqual(expected);
    }
  });
});
