import { describe, expect, test, vi } from 'vitest';

import {
  persistSettingsInOrder,
  resolveSubagentModelAfterProviderChange,
} from '@/features/settings/settingsPersistence';

describe('subagent model persistence', () => {
  test('keeps the main-process rename when the renderer draft still has the previous ref', () => {
    const available = new Set(['newproxy/model-a']);

    expect(
      resolveSubagentModelAfterProviderChange('acmeproxy/model-a', 'newproxy/model-a', available),
    ).toBe('newproxy/model-a');
  });

  test('clears a model whose provider was removed', () => {
    expect(
      resolveSubagentModelAfterProviderChange('acmeproxy/model-a', 'acmeproxy/model-a', new Set()),
    ).toBeNull();
  });

  test('preserves an explicit choice to inherit the parent model', () => {
    expect(
      resolveSubagentModelAfterProviderChange(
        null,
        'newproxy/model-a',
        new Set(['newproxy/model-a']),
      ),
    ).toBeNull();
  });
});

describe('settings persistence order', () => {
  test('keeps committed app config when runtime settings fail', async () => {
    const calls: string[] = [];
    const onAppConfigCommitted = vi.fn();

    await expect(
      persistSettingsInOrder({
        saveCoworkConfig: async () => {
          calls.push('cowork');
        },
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

    expect(calls).toEqual(['config', 'committed', 'cowork', 'runtime']);
    expect(onAppConfigCommitted).toHaveBeenCalledOnce();
  });

  test('marks the draft committed after app config and before runtime sync', async () => {
    const calls: string[] = [];

    await persistSettingsInOrder({
      saveCoworkConfig: async () => {
        calls.push('cowork');
      },
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

    expect(calls).toEqual(['config', 'committed', 'cowork', 'runtime']);
  });

  test('does not mark the draft committed when app config persistence fails', async () => {
    const onAppConfigCommitted = vi.fn();
    const saveRuntimeSettings = vi.fn(async () => undefined);

    await expect(
      persistSettingsInOrder({
        saveCoworkConfig: async () => undefined,
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
