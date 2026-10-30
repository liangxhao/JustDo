import { describe, expect, test } from 'vitest';

import { buildSystemTaskSettingsPatch, readSystemTaskSettings } from './systemTaskSettings';

describe('native system task settings', () => {
  test('reads memory defaults without exposing retired skill automation settings', () => {
    expect(readSystemTaskSettings({})).toEqual({
      memoryDreamingEnabled: true,
      memoryAvailable: true,
    });
    expect(readSystemTaskSettings({ skills: { workshop: { autonomous: { mode: 'propose' } } } }))
      .toEqual(readSystemTaskSettings({}));
  });
  test('writes only requested native config fields without overriding unrelated plugin settings', () => {
    expect(buildSystemTaskSettingsPatch({ memoryDreamingEnabled: false }, {})).toEqual({
      plugins: { entries: { 'memory-core': { config: { dreaming: { enabled: false } } } } },
    });
    expect(buildSystemTaskSettingsPatch({}, {})).toEqual({});
  });
  test('rejects retired skill mutations without changing their existing config', () => {
    const config = { skills: { workshop: { autonomous: { mode: 'propose' } } } };
    const original = structuredClone(config);
    for (const skillMode of ['off', 'propose', 'auto']) {
      expect(() => buildSystemTaskSettingsPatch({ skillMode } as never, config)).toThrow(
        'Invalid system task settings',
      );
    }
    expect(buildSystemTaskSettingsPatch({ memoryDreamingEnabled: false }, config)).toEqual({
      plugins: { entries: { 'memory-core': { config: { dreaming: { enabled: false } } } } },
    });
    expect(config).toEqual(original);
  });
  test('rejects arbitrary fields and disabled memory plugins or slots', () => {
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
