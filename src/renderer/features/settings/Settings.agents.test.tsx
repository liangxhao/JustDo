// @vitest-environment jsdom
import { configureStore } from '@reduxjs/toolkit';
import { createDefaultAgentRuntimeSettings } from '@shared/agents/agentRuntimeSettings';
import { createDefaultExternalAgentSettings } from '@shared/integrations/externalAgents';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Provider } from 'react-redux';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import type { AgentLeaveGuard } from '@/features/agents/AgentManager';

import Settings from './Settings';

const guardState = vi.hoisted(() => ({
  defer: false,
  pending: [] as Array<() => void>,
}));

vi.mock('@/features/agents/AgentManager', async () => {
  const { useEffect } = await import('react');
  return {
    default: function AssistantEditor({
      leaveGuard,
    }: {
      leaveGuard: { current: AgentLeaveGuard | null };
    }) {
      useEffect(() => {
        leaveGuard.current = proceed => {
          if (guardState.defer) guardState.pending.push(proceed);
          else proceed();
        };
        return () => {
          leaveGuard.current = null;
        };
      }, [leaveGuard]);
      return <p>Assistant editor</p>;
    },
  };
});
vi.mock('@/app/shell/window/WindowHeader', () => ({ default: () => null }));
vi.mock('./preferences/GeneralSettingsPage', () => ({
  GeneralSettingsPage: () => <p>General preferences</p>,
}));
vi.mock('./preferences/AppearancePreferences', () => ({
  AppearancePreferences: () => <p>Appearance preferences</p>,
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
  guardState.defer = false;
  guardState.pending = [];
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
    },
    autoLaunch: { get: vi.fn().mockResolvedValue({ enabled: false }) },
    preventSleep: { get: vi.fn().mockResolvedValue({ enabled: false }) },
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderSettings(onClose = vi.fn()) {
  const store = configureStore({ reducer: () => ({}) });
  const content = (initialTab: 'agents' | 'general' | 'appearance') => (
    <Provider store={store}>
      <Settings initialTab={initialTab} onClose={onClose} />
    </Provider>
  );
  const view = render(content('agents'));
  return {
    ...view,
    changeInitialTab: (tab: 'agents' | 'general' | 'appearance') => view.rerender(content(tab)),
  };
}

test('navigates and closes immediately when the assistant editor allows leaving', () => {
  const onClose = vi.fn();
  renderSettings(onClose);
  fireEvent.click(screen.getByRole('button', { name: 'general' }));
  expect(screen.getByText('General preferences')).toBeTruthy();
  expect(screen.queryByText('Assistant editor')).toBeNull();

  fireEvent.click(screen.getByRole('button', { name: 'agentManager' }));
  expect(screen.getByText('Assistant editor')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'back' }));
  expect(onClose).toHaveBeenCalledOnce();
});

test('waits for the assistant discard decision before changing categories', () => {
  renderSettings();
  guardState.defer = true;
  fireEvent.click(screen.getByRole('button', { name: 'general' }));
  expect(guardState.pending).toHaveLength(1);
  expect(screen.getByText('Assistant editor')).toBeTruthy();
  expect(screen.queryByText('General preferences')).toBeNull();

  // Cancelling drops the requested navigation and keeps the editor mounted.
  guardState.pending.shift();
  expect(screen.getByRole('button', { name: 'agentManager' }).getAttribute('aria-current')).toBe(
    'page',
  );
  fireEvent.click(screen.getByRole('button', { name: 'general' }));
  act(() => guardState.pending.shift()!());
  expect(screen.getByText('General preferences')).toBeTruthy();
  expect(screen.queryByText('Assistant editor')).toBeNull();
});

test('keeps settings open until the assistant editor approves closing', () => {
  const onClose = vi.fn();
  renderSettings(onClose);
  guardState.defer = true;
  fireEvent.click(screen.getByRole('button', { name: 'back' }));
  expect(onClose).not.toHaveBeenCalled();
  expect(guardState.pending).toHaveLength(1);

  guardState.pending.shift();
  expect(screen.getByText('Assistant editor')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'back' }));
  act(() => guardState.pending.shift()!());
  expect(onClose).toHaveBeenCalledOnce();
});

test('ignores a superseded initial category request after its discard approval arrives', () => {
  const view = renderSettings();
  guardState.defer = true;
  view.changeInitialTab('general');
  view.changeInitialTab('appearance');
  expect(guardState.pending).toHaveLength(2);

  act(() => guardState.pending.shift()!());
  expect(screen.getByText('Assistant editor')).toBeTruthy();
  expect(screen.queryByText('General preferences')).toBeNull();
  act(() => guardState.pending.shift()!());
  expect(screen.getByText('Appearance preferences')).toBeTruthy();
  expect(screen.queryByText('Assistant editor')).toBeNull();
});
