// @vitest-environment jsdom
import {
  type AuthActionResult,
  type AuthApi,
  AuthErrorCode,
  AuthOperation,
  type AuthState,
  AuthStatus,
  AuthSyncStatus,
  INITIAL_AUTH_STATE,
} from '@shared/app/auth';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';

import AuthEntry from './AuthEntry';

vi.mock('@/services/i18n', () => ({ i18nService: { t: (key: string) => key } }));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function setup(initial: AuthState = INITIAL_AUTH_STATE) {
  let receive!: (state: AuthState) => void;
  const stop = vi.fn();
  const api: AuthApi = {
    getState: vi.fn(async () => initial),
    login: vi.fn(async () => ({
      success: false,
      errorCode: AuthErrorCode.SdkUnavailable,
      state: initial,
    })),
    logout: vi.fn(async () => ({ success: true, state: { ...INITIAL_AUTH_STATE, revision: 3 } })),
    retrySync: vi.fn(async () => ({
      success: true,
      state: { ...initial, revision: 3, syncStatus: AuthSyncStatus.Completed },
    })),
    onStateChanged: callback => {
      receive = callback;
      return stop;
    },
  };
  vi.stubGlobal('electron', { auth: api });
  return { api, stop, send: (state: AuthState) => receive(state) };
}

const imported: AuthState = {
  ...INITIAL_AUTH_STATE,
  revision: 2,
  status: AuthStatus.LocalCredentials,
  profile: { account: 'alice', displayName: 'Alice' },
};

test('clicking the signed-out avatar reports an unavailable SDK without displaying a fake login form', async () => {
  const { api } = setup();
  render(<AuthEntry />);
  const button = await screen.findByRole('button', { name: 'authLogin' });
  await waitFor(() => expect(button.hasAttribute('disabled')).toBe(false));
  fireEvent.click(button);
  await screen.findByText('authSdkUnavailable');
  expect(api.login).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole('textbox')).toBeNull();
});

test('a signed-out click invokes the SDK directly and successful login displays a username initial', async () => {
  const initial = { ...INITIAL_AUTH_STATE, sdkAvailable: true };
  const context = setup(initial);
  let complete!: (result: AuthActionResult) => void;
  vi.mocked(context.api.login).mockImplementationOnce(
    () =>
      new Promise(resolve => {
        complete = resolve;
      }),
  );
  const { container } = render(<AuthEntry compact />);
  const avatar = screen.getByRole('button', { name: 'authLogin' });
  await waitFor(() => expect(avatar.hasAttribute('disabled')).toBe(false));
  fireEvent.click(avatar);
  expect(context.api.login).toHaveBeenCalledOnce();
  act(() => context.send({ ...initial, revision: 1, operation: AuthOperation.Login }));
  expect(screen.queryByRole('region')).toBeNull();
  expect(avatar.hasAttribute('disabled')).toBe(true);
  await act(async () =>
    complete({
      success: true,
      state: {
        ...initial,
        revision: 2,
        status: AuthStatus.SignedIn,
        profile: {
          account: 'alice',
          displayName: 'Alice',
          avatarUrl: 'https://example.test/avatar.png',
        },
      },
    }),
  );
  const account = screen.getByRole('button', { name: 'authAccountMenu' });
  expect(account.contains(screen.getByText('A'))).toBe(true);
  expect(container.querySelector('img')).toBeNull();
  expect(screen.queryByRole('region')).toBeNull();
  fireEvent.click(account);
  expect(screen.getByRole('region', { name: 'authAccountMenu' })).toBeTruthy();
});

test('canceling the SDK popup leaves the product account panel closed', async () => {
  const initial = { ...INITIAL_AUTH_STATE, sdkAvailable: true };
  const context = setup(initial);
  vi.mocked(context.api.login).mockResolvedValueOnce({
    success: true,
    canceled: true,
    state: { ...initial, revision: 1 },
  });
  render(<AuthEntry compact />);
  const avatar = screen.getByRole('button', { name: 'authLogin' });
  await waitFor(() => expect(avatar.hasAttribute('disabled')).toBe(false));
  await act(async () => fireEvent.click(avatar));
  expect(context.api.login).toHaveBeenCalledOnce();
  expect(screen.queryByRole('region')).toBeNull();
  expect(screen.queryByRole('alert')).toBeNull();
});

test.each([
  ['Alice', 'A'],
  [' 张三 ', '张'],
  ['😀User', '😀'],
  ['A\u0301lice', 'A\u0301'],
  ['🇨🇳用户', '🇨🇳'],
  ['👩‍💻User', '👩‍💻'],
  ['', 'a'],
])(
  'the account badge uses the first character of %s with account fallback',
  async (name, initial) => {
    setup({
      ...imported,
      status: AuthStatus.SignedIn,
      profile: { account: 'alice', displayName: name },
    });
    render(<AuthEntry compact />);
    const account = await screen.findByRole('button', { name: 'authAccountMenu' });
    expect(account.contains(screen.getByText(initial))).toBe(true);
  },
);

test('an obsolete SDK failure cannot reopen the account panel after a newer login notification', async () => {
  const context = setup({ ...INITIAL_AUTH_STATE, sdkAvailable: true });
  let complete!: (result: AuthActionResult) => void;
  vi.mocked(context.api.login).mockImplementationOnce(
    () =>
      new Promise(resolve => {
        complete = resolve;
      }),
  );
  render(<AuthEntry compact />);
  const avatar = screen.getByRole('button', { name: 'authLogin' });
  await waitFor(() => expect(avatar.hasAttribute('disabled')).toBe(false));
  fireEvent.click(avatar);
  act(() =>
    context.send({
      ...imported,
      revision: 3,
      status: AuthStatus.SignedIn,
      profile: { account: 'bob', displayName: 'Bob' },
    }),
  );
  await act(async () =>
    complete({
      success: false,
      errorCode: AuthErrorCode.LoginFailed,
      state: { ...INITIAL_AUTH_STATE, revision: 1 },
    }),
  );
  expect(screen.getByText('B')).toBeTruthy();
  expect(screen.queryByRole('region')).toBeNull();
  expect(screen.queryByRole('alert')).toBeNull();
});

test('an invocation failure shows a generic account hint without exposing the SDK error', async () => {
  const context = setup();
  vi.mocked(context.api.login).mockRejectedValueOnce(new Error('sensitive-sdk-detail'));
  render(<AuthEntry compact />);
  const avatar = screen.getByRole('button', { name: 'authLogin' });
  await waitFor(() => expect(avatar.hasAttribute('disabled')).toBe(false));
  fireEvent.click(avatar);
  await screen.findByText('authUnavailable');
  expect(screen.queryByText('sensitive-sdk-detail')).toBeNull();
});

test('an obsolete rejected invocation cannot show an error after a newer signed-in notification', async () => {
  const context = setup({ ...INITIAL_AUTH_STATE, sdkAvailable: true });
  let reject!: (error: Error) => void;
  vi.mocked(context.api.login).mockImplementationOnce(
    () =>
      new Promise((_resolve, fail) => {
        reject = fail;
      }),
  );
  render(<AuthEntry compact />);
  const avatar = screen.getByRole('button', { name: 'authLogin' });
  await waitFor(() => expect(avatar.hasAttribute('disabled')).toBe(false));
  fireEvent.click(avatar);
  act(() =>
    context.send({
      ...imported,
      revision: 3,
      status: AuthStatus.SignedIn,
      profile: { account: 'bob', displayName: 'Bob' },
    }),
  );
  await act(async () => reject(new Error('obsolete-transport-detail')));
  expect(screen.getByText('B')).toBeTruthy();
  expect(screen.queryByRole('region')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'authAccountMenu' }));
  expect(screen.queryByRole('alert')).toBeNull();
  expect(screen.queryByText('authUnavailable')).toBeNull();
});

test('imported credentials show their source and allow local sign-out with the SDK absent', async () => {
  const { api, stop } = setup(imported);
  const { unmount } = render(<AuthEntry />);
  await screen.findByText('authLocalCredentials');
  fireEvent.click(screen.getByRole('button', { name: 'authAccountMenu' }));
  fireEvent.click(screen.getByRole('button', { name: 'authLogout' }));
  await waitFor(() => expect(api.logout).toHaveBeenCalledTimes(1));
  await screen.findAllByRole('button', { name: 'authLogin' });
  expect(screen.queryByText('Alice')).toBeNull();
  unmount();
  expect(stop).toHaveBeenCalledTimes(1);
});

test('an old initial query cannot undo a newer account notification', async () => {
  const context = setup();
  let resolve!: (value: AuthState) => void;
  context.api.getState = () =>
    new Promise(complete => {
      resolve = complete;
    });
  render(<AuthEntry />);
  act(() => context.send(imported));
  await screen.findByText('Alice');
  await act(async () => resolve(INITIAL_AUTH_STATE));
  expect(screen.getByText('Alice')).toBeTruthy();
});

test('failed service synchronization remains separate from the account and offers a retry', async () => {
  const context = setup({
    ...imported,
    status: AuthStatus.SignedIn,
    syncStatus: AuthSyncStatus.Failed,
    errorCode: 'sync-failed',
  });
  render(<AuthEntry />);
  await screen.findByText('authSignedIn');
  fireEvent.click(screen.getByRole('button', { name: 'authAccountMenu' }));
  await screen.findByText('authSyncFailed');
  fireEvent.click(screen.getByRole('button', { name: 'authRetrySync' }));
  await waitFor(() => expect(context.api.retrySync).toHaveBeenCalledTimes(1));
  expect(screen.getAllByText('Alice')).toHaveLength(2);
});

test('Escape closes the account panel and restores focus to the avatar', async () => {
  setup(imported);
  render(<AuthEntry />);
  await screen.findByText('Alice');
  const button = screen.getByRole('button', { name: 'authAccountMenu' });
  fireEvent.click(button);
  expect(screen.getByRole('region', { name: 'authAccountMenu' })).toBeTruthy();
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(screen.queryByRole('region', { name: 'authAccountMenu' })).toBeNull();
  expect(document.activeElement).toBe(button);
});

test('the compact avatar opens a portal beside the rail and keeps account actions usable', async () => {
  const { api } = setup(imported);
  const { container } = render(<AuthEntry compact />);
  const button = await screen.findByRole('button', { name: 'authAccountMenu' });
  vi.spyOn(button, 'getBoundingClientRect').mockReturnValue({
    x: 4,
    y: 724,
    left: 4,
    top: 724,
    right: 40,
    bottom: 760,
    width: 36,
    height: 36,
    toJSON: () => ({}),
  });
  fireEvent.click(button);
  const panel = screen.getByRole('region', { name: 'authAccountMenu' });
  expect(container.contains(panel)).toBe(false);
  expect(panel.parentElement).toBe(document.body);
  expect(panel.style.left).toBe('50px');
  expect(panel.style.top).toBe('632px');
  fireEvent.mouseDown(panel);
  expect(screen.getByRole('region', { name: 'authAccountMenu' })).toBe(panel);
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(screen.queryByRole('region')).toBeNull();
  expect(document.activeElement).toBe(button);
  fireEvent.click(button);
  fireEvent.mouseDown(document.body);
  expect(screen.queryByRole('region')).toBeNull();
  fireEvent.click(button);
  fireEvent.click(screen.getByRole('button', { name: 'authLogout' }));
  await waitFor(() => expect(api.logout).toHaveBeenCalledOnce());
});
