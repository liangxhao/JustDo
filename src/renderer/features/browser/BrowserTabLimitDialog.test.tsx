// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';

import { configService } from '@/services/config';
import { i18nService } from '@/services/i18n';
import { OwnerDocumentContext } from '@/shared/dom/ownerDocument';

import BrowserHttpAuthModal from './BrowserHttpAuthModal';
import { reportBrowserTabCapacity } from './browserTabCapacity';
import BrowserTabLimitDialog from './BrowserTabLimitDialog';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

test('explains capacity without closing pages, and lets the user close or select an existing page', async () => {
  i18nService.setLanguage('en', { persist: false });
  const close = vi.fn();
  const select = vi.fn();
  const config = configService.getConfig();
  vi.spyOn(configService, 'getConfig').mockReturnValue({ ...config, browserTabLimit: 1 });
  const tabs = [{ id: 'browser:one', label: 'Report', onClose: close, onSelect: select }];
  render(<BrowserTabLimitDialog sessionKey="session" tabs={tabs} />);

  act(() => {
    reportBrowserTabCapacity('session');
    reportBrowserTabCapacity('session');
  });

  expect(screen.getAllByRole('dialog')).toHaveLength(1);
  expect(screen.getByText(/up to 1 browser tabs/)).toBeTruthy();
  expect(close).not.toHaveBeenCalled();
  expect(select).not.toHaveBeenCalled();
  await act(async () =>
    fireEvent.click(screen.getByRole('button', { name: 'Close page: Report' })),
  );
  expect(close).toHaveBeenCalledOnce();
  expect(screen.getByRole('dialog')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Report' }));
  expect(select).toHaveBeenCalledOnce();
  expect(screen.queryByRole('dialog')).toBeNull();
});

test('dismisses on conversation changes and does not accept a different conversation request', () => {
  const { rerender } = render(<BrowserTabLimitDialog sessionKey="one" tabs={[]} />);
  act(() => reportBrowserTabCapacity('one'));
  expect(screen.getByRole('dialog')).toBeTruthy();
  rerender(<BrowserTabLimitDialog sessionKey="two" tabs={[]} />);
  const dispatch = vi.spyOn(window, 'dispatchEvent');
  act(() => reportBrowserTabCapacity('one'));
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(dispatch.mock.calls.some(([event]) => event.type === 'app:showToast')).toBe(false);
  rerender(<BrowserTabLimitDialog sessionKey="one" tabs={[]} />);
  expect(screen.queryByRole('dialog')).toBeNull();
});

test('keeps focus in the dialog when closing a page removes its button or the browser takes focus', async () => {
  i18nService.setLanguage('en', { persist: false });
  const { rerender } = render(
    <>
      <button>Underlying page</button>
      <BrowserTabLimitDialog
        sessionKey="session"
        tabs={[{ id: 'one', label: 'Report', onSelect: vi.fn(), onClose: vi.fn() }]}
      />
    </>,
  );
  act(() => reportBrowserTabCapacity('session'));
  const closePage = screen.getByRole('button', { name: 'Close page: Report' });
  closePage.focus();
  await act(async () => fireEvent.click(closePage));
  rerender(
    <>
      <button>Underlying page</button>
      <BrowserTabLimitDialog sessionKey="session" tabs={[]} />
    </>,
  );
  const dismiss = screen.getByRole('button', { name: 'Close' });
  expect(document.activeElement).toBe(dismiss);
  screen.getByRole('button', { name: 'Underlying page' }).focus();
  expect(document.activeElement).toBe(dismiss);
});

test('ignores a late close failure after switching conversations', async () => {
  let rejectClose!: (reason: Error) => void;
  const closing = new Promise<void>((_, reject) => {
    rejectClose = reject;
  });
  const { rerender } = render(
    <BrowserTabLimitDialog
      sessionKey="one"
      tabs={[
        {
          id: 'one',
          label: 'Report',
          onSelect: vi.fn(),
          onClose: () => closing,
        },
      ]}
    />,
  );
  act(() => reportBrowserTabCapacity('one'));
  fireEvent.click(screen.getByRole('button', { name: 'Close page: Report' }));
  rerender(<BrowserTabLimitDialog sessionKey="two" tabs={[]} />);
  act(() => reportBrowserTabCapacity('two'));
  await act(async () => rejectClose(new Error('closed old session')));
  expect(screen.queryByRole('alert')).toBeNull();
});

test('renders in the workspace owner document, traps focus, and supports Escape', () => {
  i18nService.setLanguage('en', { persist: false });
  const frame = document.createElement('iframe');
  document.body.appendChild(frame);
  const workspaceDocument = frame.contentDocument!;
  render(
    <OwnerDocumentContext.Provider value={workspaceDocument}>
      <BrowserTabLimitDialog sessionKey="session" tabs={[]} />
    </OwnerDocumentContext.Provider>,
  );
  act(() => reportBrowserTabCapacity('session'));
  expect(screen.queryByRole('dialog')).toBeNull();
  const workspace = within(workspaceDocument.body);
  const dismiss = workspace.getByRole('button', { name: 'Close' });
  const done = workspace.getByRole('button', { name: 'Done' });
  expect(workspaceDocument.activeElement).toBe(dismiss);
  fireEvent.keyDown(dismiss, { key: 'Tab', shiftKey: true });
  expect(workspaceDocument.activeElement).toBe(done);
  fireEvent.keyDown(done, { key: 'Tab' });
  expect(workspaceDocument.activeElement).toBe(dismiss);
  fireEvent.keyDown(dismiss, { key: 'Escape' });
  expect(workspace.queryByRole('dialog')).toBeNull();
  cleanup();
  frame.remove();
});

test('falls back to an explanatory notification before the workspace is mounted', () => {
  i18nService.setLanguage('en', { persist: false });
  const showToast = vi.fn();
  window.addEventListener('app:showToast', showToast);
  reportBrowserTabCapacity('session');
  expect(showToast).toHaveBeenCalledWith(
    expect.objectContaining({
      detail: expect.objectContaining({
        message: expect.stringContaining('Close browser tabs'),
        tone: 'warning',
      }),
    }),
  );
  window.removeEventListener('app:showToast', showToast);
});

test('keeps workspace shortcuts out of the capacity dialog', () => {
  i18nService.setLanguage('en', { persist: false });
  const shortcut = vi.fn();
  document.addEventListener('keydown', shortcut);
  try {
    render(<BrowserTabLimitDialog sessionKey="session" tabs={[]} />);
    act(() => reportBrowserTabCapacity('session'));
    fireEvent.keyDown(screen.getByRole('button', { name: 'Done' }), {
      key: 'b',
      ctrlKey: true,
      shiftKey: true,
    });
    expect(shortcut).not.toHaveBeenCalled();
  } finally {
    document.removeEventListener('keydown', shortcut);
  }
});

test('yields to a website authentication dialog without taking its input focus', () => {
  i18nService.setLanguage('en', { persist: false });
  const capacity = <BrowserTabLimitDialog sessionKey="session" tabs={[]} />;
  const { rerender } = render(<>{capacity}</>);
  act(() => reportBrowserTabCapacity('session'));
  rerender(
    <>
      {capacity}
      <BrowserHttpAuthModal
        request={{
          id: 'auth',
          guestId: 7,
          host: 'intranet.example',
          port: 443,
          realm: 'Private',
          scheme: 'basic',
        }}
        onRespond={vi.fn()}
      />
    </>,
  );
  const username = screen.getByRole('textbox');
  expect(document.activeElement).toBe(username);
  expect(screen.queryByRole('dialog', { name: 'Browser tab limit reached' })).toBeNull();
  act(() => reportBrowserTabCapacity('session'));
  expect(document.activeElement).toBe(username);
  expect(screen.queryByRole('dialog', { name: 'Browser tab limit reached' })).toBeNull();
});
