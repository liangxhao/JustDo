import { mergeLocalSpeechExtensionSettingsPatch } from '@shared/speech/localSpeechExtensionSettings';
import { afterEach, expect, test, vi } from 'vitest';

import { defaultConfig } from '@/app/config';

const store = vi.hoisted(() => ({ getItem: vi.fn(), patchAppConfig: vi.fn() }));
vi.mock('@/services/store', () => ({ localStore: { getItem: store.getItem } }));
import { ConfigService } from './config';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

test('persists a sparse independent model selection and restores it without changing voice preferences', async () => {
  let saved = { ...defaultConfig };
  store.getItem.mockImplementation(async () => saved);
  store.patchAppConfig.mockImplementation(async patch => {
    saved = {
      ...saved,
      ...patch,
      localSpeechExtensions: mergeLocalSpeechExtensionSettingsPatch(
        saved.localSpeechExtensions,
        patch.localSpeechExtensions,
      ),
    };
    return saved;
  });
  vi.stubGlobal('window', {
    dispatchEvent: vi.fn(),
    electron: { store: { patchAppConfig: store.patchAppConfig } },
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
  expect(restarted.getConfig().localSpeechExtensions.ttsVoiceId).toBe(0);
  expect(restarted.getConfig().voice.ttsModelId).toBe(defaultConfig.voice.ttsModelId);
});

test('saves and restores a sparse plugin voice using its selected model while reply reading stays independent', async () => {
  let saved: typeof defaultConfig = {
    ...defaultConfig,
    localSpeechExtensions: {
      ...defaultConfig.localSpeechExtensions,
      ttsModelId: 'vits-icefall-zh-aishell3' as const,
      ttsVoiceId: 0,
    },
  };
  store.getItem.mockImplementation(async () => saved);
  store.patchAppConfig.mockImplementation(async patch => {
    saved = {
      ...saved,
      ...patch,
      localSpeechExtensions: mergeLocalSpeechExtensionSettingsPatch(
        saved.localSpeechExtensions,
        patch.localSpeechExtensions,
      ),
    };
    return saved;
  });
  vi.stubGlobal('window', {
    dispatchEvent: vi.fn(),
    electron: { store: { patchAppConfig: store.patchAppConfig } },
  });
  const service = new ConfigService();
  await service.init();

  await service.updateConfig({ localSpeechExtensions: { ttsVoiceId: 173 } });

  expect(store.patchAppConfig).toHaveBeenLastCalledWith({
    localSpeechExtensions: { ttsVoiceId: 173 },
  });
  expect(saved.voice).toEqual(defaultConfig.voice);
  const restarted = new ConfigService();
  await restarted.init();
  expect(restarted.getConfig().localSpeechExtensions.ttsVoiceId).toBe(173);
  store.patchAppConfig.mockClear();
  await expect(
    service.updateConfig({ localSpeechExtensions: { ttsVoiceId: 174 } }),
  ).rejects.toThrow();
  expect(store.patchAppConfig).not.toHaveBeenCalled();
});
