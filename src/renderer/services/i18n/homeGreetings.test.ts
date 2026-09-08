import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  getGreetingPeriod,
  getHomeGreetingTranslations,
  HOME_GREETINGS,
  pickHomeGreeting,
} from './homeGreetings';

afterEach(() => vi.restoreAllMocks());

describe('home greetings', () => {
  it.each([
    [0, 'Night'],
    [4, 'Night'],
    [5, 'Morning'],
    [10, 'Morning'],
    [11, 'Noon'],
    [13, 'Noon'],
    [14, 'Afternoon'],
    [17, 'Afternoon'],
    [18, 'Evening'],
    [22, 'Evening'],
    [23, 'Night'],
  ] as const)('uses the appropriate period at hour %i', (hour, period) => {
    expect(getGreetingPeriod(hour)).toBe(period);
  });

  it('avoids repeating the previous greeting at either end of the random range', () => {
    for (const random of [0, 0.999999]) {
      vi.spyOn(Math, 'random').mockReturnValue(random);
      for (const period of Object.keys(HOME_GREETINGS) as (keyof typeof HOME_GREETINGS)[]) {
        for (const previous of HOME_GREETINGS[period]) {
          const key = pickHomeGreeting(period, previous.key);
          expect(key).not.toBe(previous.key);
          expect(HOME_GREETINGS[period].some(item => item.key === key)).toBe(true);
        }
      }
    }
  });

  it('registers every unique greeting in both languages', () => {
    const entries = Object.values(HOME_GREETINGS).flat();
    expect(new Set(entries.map(item => item.key)).size).toBe(entries.length);
    for (const language of ['zh', 'en'] as const) {
      const translations = getHomeGreetingTranslations(language);
      for (const entry of entries) {
        expect(translations[entry.key]).toBe(entry[language]);
        expect(translations[entry.key].trim()).not.toBe('');
      }
    }
  });
});
