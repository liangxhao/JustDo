// @vitest-environment jsdom
import {
  AppInitializationPhase,
  type AppInitializationState,
  AppInitializationStep,
} from '@shared/app/initialization';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';

import { i18nService } from '@/services/i18n';

import AppInitializationGate from './AppInitializationGate';

vi.mock('@/app/shell/window/WindowHeader', () => ({ default: () => <div>window controls</div> }));
vi.mock('@/app/shell/StartupLoading', () => ({ default: () => <div>loading</div> }));
vi.mock('./InitializationScreen', () => ({ default: () => <div>initializing</div> }));
vi.mock('@/services/i18n', () => ({
  i18nService: {
    setLanguage: vi.fn(),
    subscribe: () => vi.fn(),
    t: (key: string) => key,
  },
}));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});
const preparing: AppInitializationState = {
  phase: AppInitializationPhase.Preparing,
  step: AppInitializationStep.UserData,
  completedSteps: 0,
  totalSteps: 4,
  firstLaunch: true,
  userDataPath: 'C:\\用户 数据',
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function bridge(getState: Promise<AppInitializationState>, locale = Promise.resolve('zh-CN')) {
  let emit!: (state: AppInitializationState) => void;
  const unsubscribe = vi.fn();
  Object.defineProperty(window, 'electron', {
    configurable: true,
    value: {
      platform: 'win32',
      initialization: {
        getState: () => getState,
        onChanged: (handler: typeof emit) => {
          emit = handler;
          return unsubscribe;
        },
      },
      appInfo: { getSystemLocale: () => locale },
    },
  });
  return { emit: (state: AppInitializationState) => act(() => emit(state)), unsubscribe };
}

test('recovers from a failed initial snapshot when a valid progress event arrives', async () => {
  const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const read = deferred<AppInitializationState>();
  const api = bridge(read.promise);
  render(
    <AppInitializationGate>
      <div>home</div>
    </AppInitializationGate>,
  );
  read.reject(new Error('IPC unavailable during reload'));
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('IPC unavailable'));
  expect(log).toHaveBeenCalled();
  api.emit({ ...preparing, phase: AppInitializationPhase.Ready });
  expect(screen.getByText('home')).toBeTruthy();
  expect(screen.queryByRole('alert')).toBeNull();
});

test('ignores a stale snapshot and late system locale after the shell becomes ready', async () => {
  const read = deferred<AppInitializationState>();
  const locale = deferred<string>();
  const api = bridge(read.promise, locale.promise);
  const view = render(
    <AppInitializationGate>
      <div>home</div>
    </AppInitializationGate>,
  );
  api.emit({ ...preparing, phase: AppInitializationPhase.Ready });
  await act(async () => {
    read.resolve(preparing);
    locale.resolve('zh-CN');
  });
  expect(screen.getByText('home')).toBeTruthy();
  expect(screen.queryByText('initializing')).toBeNull();
  expect(i18nService.setLanguage).not.toHaveBeenCalled();
  view.unmount();
  expect(api.unsubscribe).toHaveBeenCalledOnce();
});
