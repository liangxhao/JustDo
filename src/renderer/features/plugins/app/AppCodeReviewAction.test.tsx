// @vitest-environment jsdom
import type { ExtensionChangedEvent } from '@shared/plugins/extensions';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, expect, test, vi } from 'vitest';

import type { AppPluginReview } from '../../../../../plugins/sdk/app-plugin-sdk/contracts';

vi.mock('@/services/i18n', () => ({ i18nService: { t: (key: string) => key } }));
vi.mock('@/shared/dom/ownerDocument', () => ({ useOwnerDocument: () => document }));
vi.mock('@/shared/components/ui/Modal', () => ({
  default: ({ children }: { children: ReactNode }) => <section>{children}</section>,
}));
import AppCodeReviewAction from './AppCodeReviewAction';

afterEach(cleanup);
const review = (hash: string, approved: boolean): AppPluginReview => ({
  id: 'example',
  hash,
  approved,
  version: '1.0.0',
  capabilities: [],
  token: hash,
  restartRequired: true,
});
function bridge(read: () => Promise<AppPluginReview | null>) {
  const listeners = new Set<(event: ExtensionChangedEvent) => void>();
  const release = vi.fn();
  Object.defineProperty(window, 'electron', {
    configurable: true,
    value: {
      appPlugins: { review: vi.fn(read), approve: vi.fn(async () => ({ success: true })) },
      extensions: {
        onChanged: (listener: (event: ExtensionChangedEvent) => void) => {
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
    publish: (extensionId = 'example') =>
      listeners.forEach(listener => listener({ extensionId, enabled: false })),
    release,
  };
}

test('offers review for a same-ID replacement after the old artifact was already approved', async () => {
  let current = review('old', true);
  const api = bridge(async () => current);
  const view = render(<AppCodeReviewAction extensionId="example" />);
  await waitFor(() => expect(window.electron.appPlugins.review).toHaveBeenCalledTimes(1));
  expect(screen.queryByText('appPluginReview')).toBeNull();
  current = review('new', false);
  act(() => api.publish('unrelated'));
  expect(window.electron.appPlugins.review).toHaveBeenCalledTimes(1);
  act(() => api.publish());
  fireEvent.click(await screen.findByText('appPluginReview'));
  expect(await screen.findByText('new')).toBeTruthy();
  current = review('newest', false);
  act(() => api.publish());
  await waitFor(() => expect(screen.queryByText('new')).toBeNull());
  fireEvent.click(await screen.findByText('appPluginReview'));
  expect(await screen.findByText('newest')).toBeTruthy();
  view.unmount();
  expect(api.release).toHaveBeenCalledOnce();
});

test('ignores an older approved response arriving after a replacement review', async () => {
  let finish!: (value: AppPluginReview) => void;
  let calls = 0;
  const api = bridge(() =>
    ++calls === 1
      ? new Promise(resolve => {
          finish = resolve;
        })
      : Promise.resolve(review('new', false)),
  );
  render(<AppCodeReviewAction extensionId="example" />);
  act(() => api.publish());
  expect(await screen.findByText('appPluginReview')).toBeTruthy();
  await act(async () => finish(review('old', true)));
  expect(screen.getByText('appPluginReview')).toBeTruthy();
});

test.each([
  { success: true, outcome: 'appPluginApproved' },
  { success: true, restartRequired: true, outcome: 'appPluginRestartRequired' },
  { success: false, outcome: 'appPluginReviewChanged' },
])('reports approval outcome without requiring an application restart: $outcome', async result => {
  bridge(async () => review('current', false));
  vi.mocked(window.electron.appPlugins.approve!).mockResolvedValue(result);
  render(<AppCodeReviewAction extensionId="example" />);

  fireEvent.click(await screen.findByText('appPluginReview'));
  fireEvent.click(await screen.findByText('appPluginApprove'));

  expect((await screen.findByRole('status')).textContent).toBe(result.outcome);
  if (!result.restartRequired) expect(screen.queryByText('appPluginRestartRequired')).toBeNull();
});
