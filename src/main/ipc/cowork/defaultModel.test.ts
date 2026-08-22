import { beforeEach, describe, expect, test, vi } from 'vitest';

const handlers = new Map<string, (...args: unknown[]) => unknown>();

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(channel, handler);
    }),
  },
}));

import { registerDefaultModelHandlers } from './defaultModel';

describe('default model IPC', () => {
  const updateAgent = vi.fn();
  const syncOpenClawConfig = vi.fn();
  let appConfig: Record<string, unknown>;

  beforeEach(() => {
    handlers.clear();
    updateAgent.mockReset();
    syncOpenClawConfig.mockReset();
    syncOpenClawConfig.mockResolvedValue({ success: true });
    appConfig = {};

    registerDefaultModelHandlers({
      getStore: () =>
        ({
          get: () => appConfig,
          set: (_key: string, value: Record<string, unknown>) => {
            appConfig = value;
          },
        }) as never,
      getCoworkStore: () =>
        ({
          getAgent: () => ({ id: 'main', model: 'custom_0/old-model' }),
          updateAgent,
        }) as never,
      syncOpenClawConfig,
    });
  });

  test('persists the renderer canonical model reference for the selected agent', async () => {
    const result = await handlers.get('config:setDefaultModel')?.(
      {},
      {
        modelId: 'custom-model',
        providerKey: 'custom_0',
        modelRef: 'acme/custom-model',
        agentId: 'main',
      },
    );

    expect(result).toEqual({ success: true });
    expect(updateAgent).toHaveBeenCalledWith('main', { model: 'acme/custom-model' });
    expect(appConfig).toMatchObject({
      model: {
        defaultModel: 'custom-model',
        defaultModelProvider: 'custom_0',
      },
    });
  });

  test('keeps the provider-key fallback for callers without a canonical reference', async () => {
    await handlers.get('config:setDefaultModel')?.(
      {},
      {
        modelId: 'custom-model',
        providerKey: 'custom_0',
        agentId: 'main',
      },
    );

    expect(updateAgent).toHaveBeenCalledWith('main', { model: 'custom_0/custom-model' });
  });
});
