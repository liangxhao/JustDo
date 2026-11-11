// @vitest-environment jsdom
import type { StorageRelocationPlan, StorageRelocationResult } from '@shared/storage/storageRelocation';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import StorageRelocationControls from './StorageRelocationControls';

vi.mock('@/services/i18n', () => ({ i18nService: { t: (key: string) => key } }));
const api = { status: vi.fn(), prepare: vi.fn(), commit: vi.fn(), discard: vi.fn() };
const plan: StorageRelocationPlan = {
  planId: 'd81ef858-ff79-44f1-9214-bf9a274d3e62',
  sourcePath: 'C:\\AppData\\profile',
  targetPath: 'D:\\中文 data',
};
const showModal = vi.fn(function (this: HTMLDialogElement) { this.setAttribute('open', ''); });
const originalShowModal = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'showModal');
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.clearAllMocks();
  api.status.mockReset().mockResolvedValue({ success: true, value: { available: true, pending: false } });
  api.prepare.mockReset().mockResolvedValue({ success: true, value: plan });
  api.commit.mockReset().mockResolvedValue({ success: true, value: null });
  api.discard.mockReset().mockResolvedValue({ success: true, value: null });
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value: showModal });
  Object.defineProperty(window, 'electron', { configurable: true, value: { storageRelocation: api } });
});
afterEach(cleanup);
afterAll(() => {
  if (originalShowModal) Object.defineProperty(HTMLDialogElement.prototype, 'showModal', originalShowModal);
  else Reflect.deleteProperty(HTMLDialogElement.prototype, 'showModal');
});

async function prepareDialog() {
  fireEvent.click(await screen.findByRole('button', { name: 'storageRelocationChange' }));
  return screen.findByRole('dialog', { name: 'storageRelocationConfirm' });
}

describe('storage relocation confirmation', () => {
  it('discards the owned plan on Escape and closes the dialog without committing', async () => {
    render(<StorageRelocationControls />);
    const dialog = await prepareDialog();
    const cancellation = new Event('cancel', { bubbles: true, cancelable: true });

    fireEvent(dialog, cancellation);

    expect(cancellation.defaultPrevented).toBe(true);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(api.discard).toHaveBeenCalledExactlyOnceWith(plan.planId);
    expect(api.commit).not.toHaveBeenCalled();
  });

  it('submits confirmation once and keeps all migration actions disabled while its result is pending', async () => {
    const pending = deferred<StorageRelocationResult<null>>();
    api.commit.mockReturnValue(pending.promise);
    render(<StorageRelocationControls />);
    const dialog = await prepareDialog();
    expect(showModal).toHaveBeenCalledOnce();
    expect((dialog as HTMLDialogElement).open).toBe(true);
    expect(screen.getByText(plan.sourcePath)).toBeTruthy();
    expect(screen.getByText(plan.targetPath)).toBeTruthy();
    expect(api.commit).not.toHaveBeenCalled();
    const confirm = screen.getByRole('button', { name: 'storageRelocationStart' });

    fireEvent.click(confirm);
    fireEvent.click(confirm);

    expect(api.commit).toHaveBeenCalledExactlyOnceWith(plan.planId);
    expect((screen.getByRole('button', { name: 'cancel' }) as HTMLButtonElement).disabled).toBe(true);
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    await act(async () => pending.resolve({ success: true, value: null }));
    expect(screen.getByText('storageRelocationPending')).toBeTruthy();
    expect(api.commit).toHaveBeenCalledTimes(1);
  });

  it('reports an unknown confirmation result without automatically replaying the mutation', async () => {
    const pending = deferred<StorageRelocationResult<null>>();
    api.commit.mockReturnValue(pending.promise);
    const view = render(<StorageRelocationControls />);
    await prepareDialog();
    fireEvent.click(screen.getByRole('button', { name: 'storageRelocationStart' }));

    await act(async () => pending.reject(new Error('Transport lost after request delivery.')));
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'storageRelocationError_unavailable');
    view.rerender(<StorageRelocationControls />);
    fireEvent(window, new Event('focus'));
    await act(async () => Promise.resolve());

    expect(api.commit).toHaveBeenCalledTimes(1);
    expect(api.prepare).toHaveBeenCalledTimes(1);
    expect(api.discard).not.toHaveBeenCalled();
  });

  it('retains the confirmation when discard fails so the user can see the failure', async () => {
    api.discard.mockResolvedValue({ success: false, code: 'busy' });
    render(<StorageRelocationControls />);
    await prepareDialog();

    fireEvent.click(screen.getByRole('button', { name: 'cancel' }));

    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'storageRelocationError_busy');
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(api.commit).not.toHaveBeenCalled();
  });

  it('ignores a late prepared plan after unmount and never opens its dialog or submits it', async () => {
    const pending = deferred<StorageRelocationResult<StorageRelocationPlan>>();
    api.prepare.mockReturnValue(pending.promise);
    const view = render(<StorageRelocationControls />);
    fireEvent.click(await screen.findByRole('button', { name: 'storageRelocationChange' }));
    view.unmount();

    await act(async () => pending.resolve({ success: true, value: plan }));

    expect(showModal).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(api.commit).not.toHaveBeenCalled();
  });

});
