import { describe, expect, test } from 'vitest';

import { buildSystemTaskSettingsPatch, readSystemTaskSettings } from './systemTaskSettings';

describe('native system task settings', () => {
  test('reads native defaults and preserves proposals mode', () => {
    expect(readSystemTaskSettings({})).toEqual({
      memoryDreamingEnabled: true,
      memoryAvailable: true,
      skillMode: 'off',
    });
    expect(
      readSystemTaskSettings({ skills: { workshop: { autonomous: { mode: 'propose' } } } })
        .skillMode,
    ).toBe('propose');
  });
  test('writes only requested native config fields without overriding unrelated plugin settings', () => {
    expect(buildSystemTaskSettingsPatch({ memoryDreamingEnabled: false }, {})).toEqual({
      plugins: { entries: { 'memory-core': { config: { dreaming: { enabled: false } } } } },
    });
    expect(buildSystemTaskSettingsPatch({ skillMode: 'off' }, {})).toEqual({
      skills: { workshop: { autonomous: { mode: 'off' } } },
    });
    expect(buildSystemTaskSettingsPatch({}, {})).toEqual({});
  });
  test('rejects arbitrary fields, invalid modes and disabled memory plugins or slots', () => {
    expect(() => buildSystemTaskSettingsPatch({ skillMode: 'invalid' } as never, {})).toThrow();
    expect(() => buildSystemTaskSettingsPatch({ tools: {} } as never, {})).toThrow();
    for (const plugins of [
      { enabled: false },
      { allow: ['runtime-services'] },
      { slots: { memory: 'none' } },
      { slots: { memory: 'custom' } },
      { deny: ['memory-core'] },
      { entries: { 'memory-core': { enabled: false } } },
    ]) {
      expect(readSystemTaskSettings({ plugins }).memoryAvailable).toBe(false);
      expect(() =>
        buildSystemTaskSettingsPatch({ memoryDreamingEnabled: true }, { plugins }),
      ).toThrow();
    }
  });
});
