// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { sessionStorageTranslations } from '@/services/i18n/sessionStorageTranslations';

import DataDirectoryCard from './DataDirectoryCard';

vi.mock('@/services/i18n', () => ({
  i18nService: { t: (key: string) => (sessionStorageTranslations.zh as Record<string, string>)[key] ?? (key === 'cancel' ? '取消' : key) },
}));
const api = {
  info: vi.fn(), open: vi.fn(), scan: vi.fn(), clearBrowserCache: vi.fn(), cleanupStatus: vi.fn(),
  upgradeBackupStatus: vi.fn(), deleteUpgradeBackup: vi.fn(),
};
const usage = {
  complete: true, scannedAt: 1, totalBytes: 1024, skippedEntries: 0, fileCount: 1,
  categories: [{ id: 'cache', bytes: 1024 }, { id: 'backups', bytes: 0 }],
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
beforeEach(() => {
  vi.resetAllMocks();
  Object.defineProperty(window, 'electron', { configurable: true, value: { storageDirectory: api } });
  api.info.mockResolvedValue({ success: true, value: { path: 'D:\\data' } });
  api.scan.mockResolvedValue({ success: true, value: usage });
  api.cleanupStatus.mockResolvedValue({ success: true, value: null });
  api.upgradeBackupStatus.mockResolvedValue({ success: true, value: { exists: false, canDelete: false } });
  api.clearBrowserCache.mockResolvedValue({ success: true, value: null });
});
afterEach(cleanup);

async function showCacheRow() {
  const view = render(<DataDirectoryCard />);
  expect(screen.queryByRole('button', { name: '清理浏览器缓存' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '统计空间占用' }));
  const button = await screen.findByRole('button', { name: '清理浏览器缓存' });
  await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
  const row = screen.getByText('浏览器缓存').closest('div')!;
  expect(within(row).getByRole('button', { name: '清理浏览器缓存' })).toBe(button);
  expect(button.textContent).toBe('');
  api.scan.mockClear();
  return { view, button };
}
function confirmCache(button: HTMLElement) {
  fireEvent.click(button);
  const dialog = screen.getByRole('dialog', { name: '清理浏览器缓存' });
  const confirm = within(dialog).getByRole('button', { name: '清理', exact: true });
  fireEvent.click(confirm);
  return dialog;
}

test('opens one cache confirmation and cancellation performs no cleanup or rescan', async () => {
  const { button } = await showCacheRow();
  fireEvent.click(button);
  const dialog = screen.getByRole('dialog', { name: '清理浏览器缓存' });
  expect(within(dialog).getByText(/保留登录状态和网站数据/)).toBeTruthy();
  expect(api.clearBrowserCache).not.toHaveBeenCalled();
  await waitFor(() => expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: '取消' })));

  fireEvent.click(within(dialog).getByRole('button', { name: '取消' }));

  expect(screen.queryByRole('dialog')).toBeNull();
  expect(api.clearBrowserCache).not.toHaveBeenCalled();
  expect(api.scan).not.toHaveBeenCalled();
});

test('confirms once and keeps the same dialog through actual rescan and success', async () => {
  const pending = deferred<unknown>();
  const rescan = deferred<unknown>();
  api.clearBrowserCache.mockReturnValue(pending.promise);
  api.cleanupStatus.mockResolvedValue({ success: true, value: {
    operationId: 'current', kind: 'cache', phase: 'clearing', sessionsCompleted: 1, sessionsTotal: 3,
  } });
  const { button } = await showCacheRow();
  api.scan.mockReturnValueOnce(rescan.promise);
  const dialog = confirmCache(button);
  fireEvent.click(button);
  expect(api.clearBrowserCache).toHaveBeenCalledExactlyOnceWith();
  expect((screen.getByRole('button', { name: '重新统计' }) as HTMLButtonElement).disabled).toBe(true);
  expect(await within(dialog).findByText('已处理 1 / 3 份浏览器资料')).toBeTruthy();
  expect(within(dialog).getByRole('progressbar').hasAttribute('aria-valuenow')).toBe(false);

  await act(async () => pending.resolve({ success: true, value: null }));
  expect(screen.getByRole('dialog')).toBe(dialog);
  expect(within(dialog).getByText('正在重新统计空间…')).toBeTruthy();
  expect(screen.queryByText('缓存已清理，使用过程中可能重新生成。')).toBeNull();
  await act(async () => rescan.resolve({ success: true, value: { ...usage, totalBytes: 0 } }));

  expect(screen.getByRole('dialog')).toBe(dialog);
  expect(within(dialog).getByText('缓存已清理，使用过程中可能重新生成。')).toBeTruthy();
  expect(screen.queryByRole('progressbar')).toBeNull();
  expect(api.scan).toHaveBeenCalledOnce();

  fireEvent.click(within(dialog).getByRole('button', { name: '完成' }));
  expect(screen.getByText('缓存已清理，使用过程中可能重新生成。')).toBeTruthy();
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '重新统计' })); });
  expect(screen.queryByText('缓存已清理，使用过程中可能重新生成。')).toBeNull();
  expect(api.scan).toHaveBeenCalledTimes(2);
});

test('does not interpret an old terminal snapshot as this invocation succeeding', async () => {
  const pending = deferred<unknown>();
  api.clearBrowserCache.mockReturnValue(pending.promise);
  api.cleanupStatus.mockResolvedValue({ success: true, value: { operationId: 'old', kind: 'cache', phase: 'completed' } });
  const { button } = await showCacheRow();
  const dialog = confirmCache(button);
  await waitFor(() => expect(api.cleanupStatus).toHaveBeenCalledOnce());

  expect(screen.getByRole('progressbar')).toBeTruthy();
  expect(screen.queryByText('缓存已清理，使用过程中可能重新生成。')).toBeNull();
  expect(api.scan).not.toHaveBeenCalled();
  api.scan.mockRejectedValueOnce(new Error('rescan failed'));
  await act(async () => pending.reject(new Error('Transport lost after dispatch.')));

  expect((await within(dialog).findByRole('alert')).textContent).toContain('部分缓存可能已清理');
  expect(screen.getByText(/暂时无法确认结果/)).toBeTruthy();
  expect(screen.getByText('空间统计暂不可用。')).toBeTruthy();
  expect(screen.queryByRole('button', { name: /重试/ })).toBeNull();
  fireEvent(window, new Event('focus'));
  expect(api.clearBrowserCache).toHaveBeenCalledOnce();
  expect(api.scan).toHaveBeenCalledOnce();
});

test('cache and backup mutations remain mutually excluded', async () => {
  api.scan.mockResolvedValue({ success: true, value: { ...usage, totalBytes: 2048,
    categories: [{ id: 'cache', bytes: 1024 }, { id: 'backups', bytes: 1024 }],
  } });
  api.upgradeBackupStatus.mockResolvedValue({ success: true, value: { exists: true, canDelete: true } });
  const pending = deferred<unknown>();
  api.clearBrowserCache.mockReturnValue(pending.promise);
  const { button } = await showCacheRow();
  confirmCache(button);
  expect((screen.getByRole('button', { name: '删除' }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: '删除' }));
  expect(api.deleteUpgradeBackup).not.toHaveBeenCalled();
  await act(async () => pending.resolve({ success: true, value: null }));
  fireEvent.click(screen.getByRole('button', { name: '完成' }));
  const backup = deferred<unknown>();
  api.deleteUpgradeBackup.mockReturnValue(backup.promise);

  fireEvent.click(screen.getByRole('button', { name: '删除' }));

  expect((screen.getByRole('button', { name: '清理浏览器缓存' }) as HTMLButtonElement).disabled).toBe(true);
  await act(async () => backup.resolve({ success: false, code: 'cancelled' }));
});

test('late mutation and progress replies after unmount do not rescan or resubmit', async () => {
  const pending = deferred<unknown>();
  const progress = deferred<unknown>();
  api.clearBrowserCache.mockReturnValue(pending.promise);
  api.cleanupStatus.mockReturnValue(progress.promise);
  const { view, button } = await showCacheRow();
  confirmCache(button);
  await waitFor(() => expect(api.cleanupStatus).toHaveBeenCalledOnce());
  view.unmount();

  await act(async () => {
    progress.resolve({ success: true, value: { operationId: 'late', kind: 'cache', phase: 'clearing', sessionsCompleted: 1 } });
    pending.resolve({ success: true, value: null });
  });

  expect(api.clearBrowserCache).toHaveBeenCalledOnce();
  expect(api.scan).not.toHaveBeenCalled();
  expect(screen.queryByRole('dialog')).toBeNull();
});
