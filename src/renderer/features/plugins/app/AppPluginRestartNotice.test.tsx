// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';

import type { AppPluginSnapshot } from '../../../../../packages/app-plugin-sdk/contracts';

vi.mock('@/services/i18n', () => ({ i18nService: { t: (key: string) => key } }));

import AppPluginRestartNotice from './AppPluginRestartNotice';

afterEach(cleanup);

const snapshots = (restartRequired: boolean): AppPluginSnapshot[] => [
  {
    id: 'example',
    version: '1.0.0',
    hash: 'artifact',
    epoch: 'epoch',
    state: restartRequired ? 'blocked' : 'active',
    restartRequired,
  },
];

function bridge(read: () => Promise<AppPluginSnapshot[]>) {
  const listeners = new Set<(value: AppPluginSnapshot[]) => void>();
  const release = vi.fn();
  Object.defineProperty(window, 'electron', {
    configurable: true,
    value: {
      appPlugins: {
        snapshot: vi.fn(read),
        onChanged: (listener: (value: AppPluginSnapshot[]) => void) => {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
            release();
          };
        },
      },
    },
  });
  return {
    publish: (restartRequired: boolean) => {
      listeners.forEach(listener => listener(snapshots(restartRequired)));
    },
    release,
  };
}

test('clears the pending notice after the Gateway reload completes', async () => {
  const api = bridge(async () => snapshots(true));
  const view = render(<AppPluginRestartNotice />);
  expect(await screen.findByRole('status')).toBeTruthy();

  act(() => api.publish(false));
  expect(screen.queryByRole('status')).toBeNull();
  act(() => api.publish(true));
  expect(screen.getByRole('status')).toBeTruthy();

  view.unmount();
  expect(api.release).toHaveBeenCalledOnce();
});

test.each([true, false])(
  'ignores the older initial snapshot after a live Gateway state update: %s',
  async required => {
    let finish!: (value: AppPluginSnapshot[]) => void;
    const api = bridge(
      () =>
        new Promise(resolve => {
          finish = resolve;
        }),
    );
    render(<AppPluginRestartNotice />);
    await waitFor(() => expect(window.electron.appPlugins.snapshot).toHaveBeenCalledOnce());

    act(() => api.publish(required));
    await act(async () => finish(snapshots(!required)));

    expect(Boolean(screen.queryByRole('status'))).toBe(required);
  },
);
