import { afterEach, expect, test, vi } from 'vitest';

import { defaultConfig } from '@/app/config';

const store = vi.hoisted(() => ({ getItem: vi.fn(), patchAppConfig: vi.fn() }));
vi.mock('@/services/store', () => ({ localStore: { getItem: store.getItem } }));
import { ConfigService } from './config';

afterEach(() => vi.unstubAllGlobals());

test('persists a sparse independent model selection and restores it without changing voice preferences', async () => {
  let saved = { ...defaultConfig };
  store.getItem.mockImplementation(async () => saved);
  store.patchAppConfig.mockImplementation(async patch => {
    saved = {
      ...saved, ...patch,
      localSpeechExtensions: { ...saved.localSpeechExtensions, ...patch.localSpeechExtensions },
    };
    return saved;
  });
  vi.stubGlobal('window', {
    dispatchEvent: vi.fn(), electron: { store: { patchAppConfig: store.patchAppConfig } },
  });
  const service = new ConfigService();
  await service.init();

  await service.updateConfig({ localSpeechExtensions: { ttsModelId: 'vits-icefall-zh-aishell3' } });

  expect(store.patchAppConfig).toHaveBeenLastCalledWith({
    localSpeechExtensions: { ttsModelId: 'vits-icefall-zh-aishell3' },
  });
  expect(saved.voice).toEqual(defaultConfig.voice);
  const restarted = new ConfigService();
  await restarted.init();
  expect(restarted.getConfig().localSpeechExtensions.ttsModelId).toBe('vits-icefall-zh-aishell3');
  expect(restarted.getConfig().voice.ttsModelId).toBe(defaultConfig.voice.ttsModelId);
});
