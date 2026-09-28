import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { setLanguage } from '../../core/i18n';

const handlers = new Map<string, (...args: unknown[]) => unknown>();
const credential = vi.hoisted(() => vi.fn());
vi.mock('../../providers/builtinModelCredential', () => ({
  getActiveBuiltinModelCredential: credential,
}));

const providers = {
  custom_0: {
    enabled: true,
    apiKey: 'test-key',
    baseUrl: 'https://example.test',
    displayName: 'acme',
    models: [{ id: 'custom-model' }],
  },
  openai: {
    enabled: true,
    apiKey: 'test-key',
    baseUrl: 'https://example.test',
    models: [{ id: 'new-model' }, { id: 'review-model' }],
  },
};

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
  afterEach(() => setLanguage('zh'));

  beforeEach(() => {
    handlers.clear();
    setLanguage('zh');
    updateAgent.mockReset();
    syncOpenClawConfig.mockReset();
    syncOpenClawConfig.mockResolvedValue({ success: true });
    credential.mockReset();
    appConfig = { providers: structuredClone(providers) };

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

  test('persists main selection in app config and clears its legacy profile override', async () => {
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
    expect(updateAgent).toHaveBeenCalledWith('main', { model: '' });
    expect(appConfig).toMatchObject({
      model: {
        defaultModel: 'custom-model',
        defaultModelProvider: 'custom_0',
      },
    });
  });

  test('restores app selection and legacy metadata if Gateway rejects the change', async () => {
    appConfig = {
      providers,
      model: { defaultModel: 'old-model', defaultModelProvider: 'custom_0' },
      theme: 'dark',
    };
    syncOpenClawConfig.mockResolvedValueOnce({ success: false, error: 'sync rejected' });
    const result = await handlers.get('config:setDefaultModel')?.(
      {},
      { modelId: 'new-model', providerKey: 'openai', agentId: 'main' },
    );
    expect(result).toEqual({ success: false, error: 'sync rejected' });
    expect(appConfig).toEqual({
      providers,
      model: { defaultModel: 'old-model', defaultModelProvider: 'custom_0' },
      theme: 'dark',
    });
    expect(updateAgent).toHaveBeenNthCalledWith(1, 'main', { model: '' });
    expect(updateAgent).toHaveBeenNthCalledWith(2, 'main', { model: 'custom_0/old-model' });
    expect(syncOpenClawConfig).toHaveBeenLastCalledWith({
      reason: 'default-model-change-rollback',
    });
  });

  test('clears main profile overrides for callers without a canonical reference', async () => {
    await handlers.get('config:setDefaultModel')?.(
      {},
      {
        modelId: 'custom-model',
        providerKey: 'custom_0',
        agentId: 'main',
      },
    );

    expect(updateAgent).toHaveBeenCalledWith('main', { model: '' });
  });

  test.each(['disabled-provider', 'disabled-model', 'missing-credential', 'stale-route'])(
    'rejects %s without silently selecting a fallback',
    async failure => {
      const configured = (appConfig.providers as typeof providers).custom_0;
      if (failure === 'disabled-provider') configured.enabled = false;
      if (failure === 'disabled-model') Object.assign(configured.models[0], { enabled: false });
      if (failure === 'missing-credential') configured.apiKey = '';
      const before = structuredClone(appConfig);
      const result = await handlers.get('config:setDefaultModel')?.(
        {},
        {
          modelId: 'custom-model',
          providerKey: 'custom_0',
          modelRef: failure === 'stale-route' ? 'old/custom-model' : 'acme/custom-model',
        },
      );
      expect(result).toMatchObject({ success: false });
      expect(appConfig).toEqual(before);
      expect(updateAgent).not.toHaveBeenCalled();
      expect(syncOpenClawConfig).not.toHaveBeenCalled();
    },
  );

  test.each([
    ['zh', '所选模型已停用或移除，请重新选择可用模型。'],
    ['en', 'The selected model is no longer enabled. Please select an available model.'],
  ] as const)('reports an unavailable selection in %s', async (language, error) => {
    setLanguage(language);
    expect(
      await handlers.get('config:setDefaultModel')?.(
        {},
        {
          modelId: 'removed',
          providerKey: 'custom_0',
        },
      ),
    ).toEqual({ success: false, error });
  });

  test('uses active built-in authentication instead of the provider API key', async () => {
    appConfig = {
      providers: {
        builtin_models: {
          enabled: true,
          baseUrl: 'https://example.test',
          models: [{ id: 'hdp/model' }],
        },
      },
    };
    const select = () =>
      handlers.get('config:setDefaultModel')?.(
        {},
        { modelId: 'hdp/model', providerKey: 'builtin_models', modelRef: 'hdp/model' },
      );
    expect(await select()).toMatchObject({ success: false });
    credential.mockReturnValue({ accessToken: 'test-token' });
    expect(await select()).toEqual({ success: true });
  });
});

test('changing a specialist model does not replace the application default', async () => {
  const set = vi.fn();
  const updateAgent = vi.fn();
  registerDefaultModelHandlers({
    getStore: () =>
      ({ get: () => ({ providers, model: { defaultModel: 'original' } }), set }) as never,
    getCoworkStore: () => ({ getAgent: () => ({ id: 'review', model: '' }), updateAgent }) as never,
    syncOpenClawConfig: async () => ({ success: true }),
  });
  await handlers.get('config:setDefaultModel')?.(
    {},
    { agentId: 'review', providerKey: 'openai', modelId: 'review-model' },
  );
  expect(set).not.toHaveBeenCalled();
  expect(updateAgent).toHaveBeenCalledWith('review', { model: 'openai/review-model' });
});
