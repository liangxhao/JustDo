import { describe, expect, test, vi } from 'vitest';

import { persistSettingsInOrder } from '@/features/settings/settingsPersistence';

describe('settings persistence order', () => {
  test('keeps committed app config when runtime settings fail', async () => {
    const calls: string[] = [];
    const onAppConfigCommitted = vi.fn();

    await expect(
      persistSettingsInOrder({
        saveRuntimeSettings: async () => {
          calls.push('runtime');
          throw new Error('runtime failed');
        },
        saveAppConfig: async () => {
          calls.push('config');
        },
        onAppConfigCommitted: () => {
          calls.push('committed');
          onAppConfigCommitted();
        },
      }),
    ).rejects.toThrow('runtime failed');

    expect(calls).toEqual(['config', 'committed', 'runtime']);
    expect(onAppConfigCommitted).toHaveBeenCalledOnce();
  });

  test('marks the draft committed after app config and before runtime sync', async () => {
    const calls: string[] = [];

    await persistSettingsInOrder({
      saveRuntimeSettings: async () => {
        calls.push('runtime');
      },
      saveAppConfig: async () => {
        calls.push('config');
      },
      onAppConfigCommitted: () => {
        calls.push('committed');
      },
    });

    expect(calls).toEqual(['config', 'committed', 'runtime']);
  });

  test('does not mark the draft committed when app config persistence fails', async () => {
    const onAppConfigCommitted = vi.fn();
    const saveRuntimeSettings = vi.fn(async () => undefined);

    await expect(
      persistSettingsInOrder({
        saveRuntimeSettings,
        saveAppConfig: async () => {
          throw new Error('config failed');
        },
        onAppConfigCommitted,
      }),
    ).rejects.toThrow('config failed');

    expect(onAppConfigCommitted).not.toHaveBeenCalled();
    expect(saveRuntimeSettings).not.toHaveBeenCalled();
  });
});
