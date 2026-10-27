// @vitest-environment jsdom
import { configureStore } from '@reduxjs/toolkit';
import { createDefaultAgentRuntimeSettings } from '@shared/agents/agentRuntimeSettings';
import { createDefaultExternalAgentSettings } from '@shared/integrations/externalAgents';
import { LocalSpeechModelKind } from '@shared/speech/localSpeechModels';
import type { LocalSpeechSettings } from '@shared/speech/localSpeechSettings';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Provider } from 'react-redux';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import Settings from './Settings';

const { updateConfig } = vi.hoisted(() => ({ updateConfig: vi.fn() }));

vi.mock('@/app/shell/window/WindowHeader', () => ({ default: () => null }));
vi.mock('@/services/config', async () => {
  const { defaultConfig } = await import('@/app/config');
  return { configService: { getConfig: () => structuredClone(defaultConfig), updateConfig } };
});
vi.mock('@/services/theme', () => ({
  themeService: {
    getTheme: () => 'light',
    getThemeId: () => 'classic-light',
    restoreTheme: vi.fn(),
  },
}));
vi.mock('@/services/i18n', () => ({
  i18nService: {
    t: (key: string) => key,
    getLanguage: () => 'zh',
    setLanguage: vi.fn(),
    subscribe: () => () => {},
  },
}));
vi.mock('./models/ModelSettingsTab', () => ({
  default: ({
    activeKind,
    initialBuiltinModels,
    initialProviderId,
  }: {
    activeKind: string;
    initialBuiltinModels?: boolean;
    initialProviderId?: string;
  }) => (
    <div
      data-testid="model-target"
      data-provider={initialProviderId}
    >{`${activeKind}:${Boolean(initialBuiltinModels)}`}</div>
  ),
}));
vi.mock('./speech/VoiceSettingsTab', () => ({
  default: ({
    value,
    onChange,
    onManageModels,
  }: {
    value: LocalSpeechSettings;
    onChange: (value: LocalSpeechSettings) => void;
    onManageModels: (
      kind: LocalSpeechModelKind,
      target?: { source: 'online' | 'builtin'; providerId?: string },
    ) => void;
  }) => (
    <>
      <button
        type="button"
        onClick={() => onChange({ ...value, inputEnabled: !value.inputEnabled })}
      >
        {value.inputEnabled ? 'input-on' : 'input-off'}
      </button>
      <button type="button" onClick={() => onManageModels('asr')}>
        manage-asr
      </button>
      <button type="button" onClick={() => onManageModels('tts')}>
        manage-tts
      </button>
      <button
        type="button"
        onClick={() => onManageModels('tts', { source: 'online', providerId: 'office' })}
      >
        manage-online-tts
      </button>
    </>
  ),
}));

beforeEach(() => {
  updateConfig.mockClear();
  vi.stubGlobal('electron', {
    cowork: {
      getAgentRuntimeSettings: vi
        .fn()
        .mockResolvedValue({ success: true, settings: createDefaultAgentRuntimeSettings() }),
      getConfig: vi.fn().mockResolvedValue({ success: true, config: {} }),
    },
    openclaw: {
      externalAgents: {
        getSettings: vi
          .fn()
          .mockResolvedValue({ success: true, settings: createDefaultExternalAgentSettings() }),
      },
      engine: { getPort: vi.fn().mockResolvedValue({ success: true, port: 18789 }) },
    },
    extensions: { onChanged: () => () => {} },
    autoLaunch: { get: vi.fn().mockResolvedValue({ enabled: false }) },
    preventSleep: { get: vi.fn().mockResolvedValue({ enabled: false }) },
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

test.each([
  [LocalSpeechModelKind.Asr, 'speech-recognition'],
  [LocalSpeechModelKind.Tts, 'speech-synthesis'],
] as const)('opens the built-in %s catalog from a plugin request', (kind, category) => {
  const store = configureStore({ reducer: () => ({}) });
  render(
    <Provider store={store}>
      <Settings initialTab="model" speechModels={kind} onClose={vi.fn()} />
    </Provider>,
  );

  expect(screen.getByTestId('model-target').textContent).toBe(`${category}:true`);
  expect(updateConfig).not.toHaveBeenCalled();
});

test('opens the selected online speech provider from a plugin request', () => {
  const store = configureStore({ reducer: () => ({}) });
  render(
    <Provider store={store}>
      <Settings
        initialTab="model"
        speechModels="tts"
        speechModelTarget={{ source: 'online', providerId: 'office' }}
        onClose={vi.fn()}
      />
    </Provider>,
  );
  expect(screen.getByTestId('model-target').textContent).toBe('speech-synthesis:false');
  expect(screen.getByTestId('model-target').getAttribute('data-provider')).toBe('office');
  expect(updateConfig).not.toHaveBeenCalled();
});

test('keeps the Voice draft when opening its online provider', () => {
  const store = configureStore({ reducer: () => ({}) });
  render(
    <Provider store={store}>
      <Settings initialTab="voice" onClose={vi.fn()} />
    </Provider>,
  );
  fireEvent.click(screen.getByRole('button', { name: 'input-off' }));
  fireEvent.click(screen.getByRole('button', { name: 'manage-online-tts' }));
  expect(screen.getByTestId('model-target').textContent).toBe('speech-synthesis:false');
  expect(screen.getByTestId('model-target').getAttribute('data-provider')).toBe('office');
  fireEvent.click(screen.getByRole('button', { name: 'voiceSettings' }));
  expect(screen.getByRole('button', { name: 'input-on' })).toBeTruthy();
  expect(updateConfig).not.toHaveBeenCalled();
});

test.each([
  ['manage-asr', 'speech-recognition'],
  ['manage-tts', 'speech-synthesis'],
])('navigates through %s without saving or discarding the voice draft', (button, category) => {
  const store = configureStore({ reducer: () => ({}) });
  render(
    <Provider store={store}>
      <Settings initialTab="voice" onClose={vi.fn()} />
    </Provider>,
  );
  fireEvent.click(screen.getByRole('button', { name: 'input-off' }));
  fireEvent.click(screen.getByRole('button', { name: button }));

  expect(screen.getByTestId('model-target').textContent).toBe(`${category}:true`);
  fireEvent.click(screen.getByRole('button', { name: 'voiceSettings' }));
  expect(screen.getByRole('button', { name: 'input-on' })).toBeTruthy();
  expect(updateConfig).not.toHaveBeenCalled();
});
