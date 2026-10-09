// @vitest-environment jsdom
import { configureStore } from '@reduxjs/toolkit';
import { createDefaultAgentRuntimeSettings } from '@shared/agents/agentRuntimeSettings';
import { createDefaultExternalAgentSettings } from '@shared/integrations/externalAgents';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Provider } from 'react-redux';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import Settings from './Settings';

vi.mock('@/app/shell/window/WindowHeader', () => ({ default: () => null }));
vi.mock('./preferences/GeneralSettingsPage', () => ({
  GeneralSettingsPage: () => <p>General preferences</p>,
}));
vi.mock('@/services/config', async () => {
  const { defaultConfig } = await import('@/app/config');
  return { configService: { getConfig: () => structuredClone(defaultConfig) } };
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

beforeEach(() => {
  vi.stubGlobal('electron', {
    cowork: {
      getAgentRuntimeSettings: vi.fn().mockResolvedValue({
        success: true,
        settings: createDefaultAgentRuntimeSettings(),
      }),
      getConfig: vi.fn().mockResolvedValue({ success: true, config: {} }),
    },
    openclaw: {
      externalAgents: {
        getSettings: vi.fn().mockResolvedValue({
          success: true,
          settings: createDefaultExternalAgentSettings(),
        }),
      },
      engine: { getPort: vi.fn().mockResolvedValue({ success: true, port: 18789 }) },
      computerControl: {
        get: vi.fn().mockResolvedValue({ success: true, enabled: false }),
      },
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

function renderSettings(initialTab: 'computer' | 'general', onClose = vi.fn()) {
  const store = configureStore({ reducer: () => ({}) });
  return render(
    <Provider store={store}>
      <Settings initialTab={initialTab} onClose={onClose} />
    </Provider>,
  );
}

test('computer control has one autosaving switch and a close action without a save submit', async () => {
  const onClose = vi.fn();
  const view = renderSettings('computer', onClose);
  await waitFor(() =>
    expect((screen.getByRole('switch') as HTMLButtonElement).disabled).toBe(false),
  );

  expect(screen.getAllByRole('switch')).toHaveLength(1);
  expect(screen.queryByText('save')).toBeNull();
  expect(view.container.querySelector('button[type="submit"]')).toBeNull();
  expect(screen.queryByRole('button', { name: 'cancel' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'close' }));
  expect(onClose).toHaveBeenCalledOnce();
});

test('navigation retains the general save action and removes it on the autosaving computer page', async () => {
  const view = renderSettings('general');
  expect((screen.getByRole('button', { name: 'save' }) as HTMLButtonElement).type).toBe('submit');
  expect(screen.getByRole('button', { name: 'cancel' })).toBeTruthy();

  fireEvent.click(screen.getByRole('button', { name: 'computerControlTitle' }));
  await screen.findByRole('switch');
  expect(screen.queryByText('save')).toBeNull();
  expect(view.container.querySelector('button[type="submit"]')).toBeNull();
  expect(screen.getByRole('button', { name: 'close' })).toBeTruthy();

  fireEvent.click(screen.getByRole('button', { name: 'general' }));
  expect((screen.getByRole('button', { name: 'save' }) as HTMLButtonElement).type).toBe('submit');
  expect(screen.getByRole('button', { name: 'cancel' })).toBeTruthy();
});
