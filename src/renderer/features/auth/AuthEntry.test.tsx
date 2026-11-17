// @vitest-environment jsdom
import {
  type AuthActionResult,
  type AuthApi,
  AuthErrorCode,
  AuthLoginPhase,
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

test.each([
  { state: INITIAL_AUTH_STATE, label: 'authLogin' },
  { state: { ...imported, status: AuthStatus.SignedIn }, label: 'authAccountMenu' },
])('the initial read shows a spinner before revealing $label', async ({ state, label }) => {
  const { api } = setup();
  let finishRead!: (state: AuthState) => void;
  vi.mocked(api.getState).mockImplementationOnce(() => new Promise(resolve => {
    finishRead = resolve;
  }));
  render(<AuthEntry compact />);

  const button = screen.getByRole('button', { name: 'authLoading' });
  expect(button.hasAttribute('disabled')).toBe(true);
  expect(button.querySelector('.auth-entry-button__spinner')).toBeTruthy();
  expect(screen.getByRole('status').textContent).toBe('authLoading');
  expect(screen.queryByText('authLogin')).toBeNull();

  await act(async () => finishRead(state));
  expect(screen.getByRole('button', { name: label })).toBe(button);
  expect(button.hasAttribute('disabled')).toBe(false);
  expect(button.querySelector('.auth-entry-button__spinner')).toBeNull();
  expect(button.querySelector('.auth-entry-button__avatar')?.textContent ?? null).toBe(
    state.profile ? 'A' : null,
  );
});

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

test('a signed-out click shows both login phases before displaying the username initial', async () => {
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
  const avatar = await screen.findByRole('button', { name: 'authLogin' });
  fireEvent.click(avatar);
  expect(context.api.login).toHaveBeenCalledOnce();
  const dialog: AuthState = {
    ...initial,
    revision: 1,
    operation: AuthOperation.Login,
    loginPhase: AuthLoginPhase.Dialog,
  };
  act(() => context.send(dialog));
  expect(screen.queryByRole('region')).toBeNull();
  expect(avatar.textContent).toContain('authLogin');
  expect(avatar.hasAttribute('disabled')).toBe(true);
  expect(avatar.getAttribute('data-login-phase')).toBe(AuthLoginPhase.Dialog);
  expect(screen.getByRole('status').textContent).toBe('authAwaitingLogin');
  expect(avatar.querySelector('.auth-entry-button__spinner')).toBeNull();

  act(() => context.send({ ...dialog, revision: 2, loginPhase: AuthLoginPhase.Completing }));
  expect(avatar.hasAttribute('disabled')).toBe(true);
  expect(screen.getByRole('status').textContent).toBe('authSigningIn');
  expect(avatar.querySelector('.auth-entry-button__spinner')).toBeTruthy();

  const signedIn: AuthState = {
    ...initial,
    revision: 3,
    status: AuthStatus.SignedIn,
    profile: {
      account: 'alice',
      displayName: 'Alice',
      avatarUrl: 'https://example.test/avatar.png',
    },
  };
  act(() =>
    context.send({ ...signedIn, operation: AuthOperation.Login, syncStatus: AuthSyncStatus.Pending }),
  );
  const account = screen.getByRole('button', { name: 'authAccountMenu' });
  expect(account.querySelector('.auth-entry-button__avatar')?.textContent).toBe('A');
  expect(account.hasAttribute('data-login-phase')).toBe(false);
  expect(account.querySelector('.auth-entry-button__spinner')).toBeNull();
  expect(screen.getByRole('status').textContent).toBe('');

  await act(async () =>
    complete({
      success: true,
      state: { ...signedIn, revision: 4, syncStatus: AuthSyncStatus.Completed },
    }),
  );
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
  const avatar = await screen.findByRole('button', { name: 'authLogin' });
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
  const avatar = await screen.findByRole('button', { name: 'authLogin' });
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
  const avatar = await screen.findByRole('button', { name: 'authLogin' });
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
  const avatar = await screen.findByRole('button', { name: 'authLogin' });
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

test.each([null, AuthErrorCode.LogoutFailed])(
  'sign-out keeps its spinner through cleanup and shows a warning only on failure (%s)',
  async errorCode => {
    const signedIn = { ...imported, status: AuthStatus.SignedIn };
    const context = setup(signedIn);
    let complete!: (result: AuthActionResult) => void;
    vi.mocked(context.api.logout).mockImplementationOnce(
      () => new Promise(resolve => {
        complete = resolve;
      }),
    );
    render(<AuthEntry compact />);
    const avatar = await screen.findByRole('button', { name: 'authAccountMenu' });
    fireEvent.click(avatar);
    fireEvent.click(screen.getByRole('button', { name: 'authLogout' }));
    expect(screen.queryByRole('region')).toBeNull();

    act(() => context.send({ ...signedIn, revision: 3, operation: AuthOperation.Logout }));
    const progress = screen.getByRole('button', { name: 'authSigningOut' });
    expect(progress.hasAttribute('disabled')).toBe(true);
    expect(progress.querySelector('.auth-entry-button__spinner + svg')).toBeTruthy();
    expect(screen.getByRole('status').textContent).toBe('authSigningOut');

    const localSignOut = { ...INITIAL_AUTH_STATE, revision: 4, operation: AuthOperation.Logout };
    act(() => context.send(localSignOut));
    expect(screen.queryByRole('button', { name: 'authLogin' })).toBeNull();
    expect(progress.querySelector('.auth-entry-button__spinner')).toBeTruthy();

    await act(async () => complete({
      success: !errorCode,
      ...(errorCode ? { errorCode } : {}),
      state: { ...localSignOut, revision: 5, operation: AuthOperation.Idle, errorCode },
    }));
    expect(avatar.getAttribute('aria-label')).toBe('authLogin');
    expect(avatar.hasAttribute('disabled')).toBe(false);
    expect(avatar.querySelector('.auth-entry-button__spinner')).toBeNull();
    expect(screen.queryByRole('alert')?.textContent ?? null).toBe(errorCode ? 'authLogoutFailed' : null);
  },
);

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
