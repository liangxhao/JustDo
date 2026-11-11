// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { sessionStorageTranslations } from '@/services/i18n/sessionStorageTranslations';

import DataDirectoryCard from './DataDirectoryCard';

vi.mock('@/services/i18n', () => ({
  i18nService: { t: (key: string) => (sessionStorageTranslations.zh as Record<string, string>)[key] ?? key },
}));
const api = { info: vi.fn(), open: vi.fn(), scan: vi.fn(), cleanupStatus: vi.fn(), upgradeBackupStatus: vi.fn(), deleteUpgradeBackup: vi.fn() };
const usage = { complete: true, scannedAt: 1, totalBytes: 1024, categories: [{ id: 'backups', bytes: 1024 }], skippedEntries: 0, fileCount: 1 };
beforeEach(() => {
  vi.resetAllMocks();
  Object.defineProperty(window, 'electron', { configurable: true, value: { storageDirectory: api } });
  api.info.mockResolvedValue({ success: true, value: { path: 'D:\\data' } });
  api.upgradeBackupStatus.mockResolvedValue({ success: true, value: { exists: true, canDelete: true } });
  api.deleteUpgradeBackup.mockResolvedValue({ success: true, value: null });
  api.scan.mockResolvedValue({ success: true, value: usage });
  api.cleanupStatus.mockResolvedValue({ success: true, value: null });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

async function showBackupRow() {
  const view = render(<DataDirectoryCard />);
  expect(screen.queryByRole('button', { name: '删除' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '统计空间占用' }));
  const button = await screen.findByRole('button', { name: '删除' });
  const row = screen.getByText('升级备份').closest('div')!;
  expect(within(row).getByRole('button', { name: '删除' })).toBe(button);
  await waitFor(() => expect((screen.getByRole('button', { name: '重新统计' }) as HTMLButtonElement).disabled).toBe(false));
  api.scan.mockClear();
  return { view, button };
}

test('removes the backup from the chart and dismisses the success notice after refreshing', async () => {
  let finish!: (result: unknown) => void;
  let finishScan!: (result: unknown) => void;
  api.deleteUpgradeBackup.mockReturnValue(new Promise(resolve => { finish = resolve; }));
  api.scan.mockResolvedValueOnce({ success: true, value: { ...usage, totalBytes: 2048,
    categories: [...usage.categories, { id: 'other', bytes: 1024 }],
  } });
  const { button } = await showBackupRow();
  expect(screen.getByRole('img').getAttribute('aria-label')).toContain('升级备份');
  api.scan.mockReturnValueOnce(new Promise(resolve => { finishScan = resolve; }));

  fireEvent.click(button);
  fireEvent.click(button);

  expect(api.deleteUpgradeBackup).toHaveBeenCalledExactlyOnceWith();
  expect(api.scan).not.toHaveBeenCalled();
  expect((screen.getByRole('button', { name: '重新统计' }) as HTMLButtonElement).disabled).toBe(true);
  api.upgradeBackupStatus.mockResolvedValueOnce({ success: true, value: { exists: false, canDelete: false } });
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  await act(async () => { finish({ success: true, value: null }); });
  expect(screen.getByText('升级备份已删除。')).toBeTruthy();
  expect(screen.queryByText('升级备份')).toBeNull();
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(screen.getByRole('img').getAttribute('aria-label')).toBe('配置与其他数据: 1.0 KiB');
  expect((screen.getByRole('img').firstElementChild as HTMLElement).style.width).toBe('100%');
  expect((screen.getByRole('button', { name: '正在统计…' }) as HTMLButtonElement).disabled).toBe(true);

  await act(async () => { finishScan({ success: true, value: { ...usage,
    categories: [{ id: 'backups', bytes: 0 }, { id: 'other', bytes: 1024 }],
  } }); });

  expect(api.scan).toHaveBeenCalledOnce();
  expect(screen.queryByRole('button', { name: '删除' })).toBeNull();
  expect((screen.getByRole('button', { name: '重新统计' }) as HTMLButtonElement).disabled).toBe(false);

  act(() => vi.advanceTimersByTime(2999));
  expect(screen.getByText('升级备份已删除。')).toBeTruthy();
  act(() => vi.advanceTimersByTime(1));
  expect(screen.queryByText('升级备份已删除。')).toBeNull();
});

test('refreshes deletion readiness after startup even when the byte count is zero', async () => {
  api.scan.mockResolvedValue({ success: true, value: {
    ...usage, complete: false, totalBytes: 0, categories: [{ id: 'backups', bytes: 0 }],
  } });
  api.upgradeBackupStatus.mockResolvedValue({ success: true, value: { exists: true, canDelete: false } });
  const { button } = await showBackupRow();
  expect((button as HTMLButtonElement).disabled).toBe(true);
  expect(button.title).toContain('该备份目录正在使用中');
  expect(within(screen.getByText('升级备份').closest('div')!).queryByText('0 B')).toBeNull();
  expect(screen.getByRole('img').getAttribute('aria-label')).not.toContain('升级备份');
  fireEvent.click(button);
  api.upgradeBackupStatus.mockResolvedValue({ success: true, value: { exists: true, canDelete: true } });

  fireEvent.click(screen.getByRole('button', { name: '重新统计' }));

  await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
  expect(api.deleteUpgradeBackup).not.toHaveBeenCalled();
});

test('does not restore a deleted backup from an older pending status read', async () => {
  let finishStatus!: (value: unknown) => void;
  api.upgradeBackupStatus.mockReturnValueOnce(new Promise(resolve => { finishStatus = resolve; }));
  const { button } = await showBackupRow();
  api.upgradeBackupStatus.mockResolvedValueOnce({ success: true, value: { exists: false, canDelete: false } });

  fireEvent.click(button);
  await screen.findByText('升级备份已删除。');
  await act(async () => { finishStatus({ success: true, value: { exists: true, canDelete: true } }); });

  expect(screen.queryByRole('button', { name: '删除' })).toBeNull();
  expect(api.deleteUpgradeBackup).toHaveBeenCalledOnce();
});

test('reports a failure or unknown result without replaying deletion', async () => {
  api.deleteUpgradeBackup.mockRejectedValue(new Error('Connection lost after delivery.'));
  const { view, button } = await showBackupRow();

  fireEvent.click(button);
  expect((await screen.findByRole('alert')).textContent).toContain('备份可能只删除了一部分');
  view.rerender(<DataDirectoryCard />);
  fireEvent(window, new Event('focus'));

  expect(api.deleteUpgradeBackup).toHaveBeenCalledOnce();
  expect(api.scan).toHaveBeenCalledOnce();
  expect(screen.getByText(/暂时无法确认结果/)).toBeTruthy();
});

test('uses only native confirmation and cancellation leaves the backup row available', async () => {
  let finish!: (value: unknown) => void;
  api.deleteUpgradeBackup.mockReturnValue(new Promise(resolve => { finish = resolve; }));
  const { button } = await showBackupRow();

  fireEvent.click(button);
  expect(screen.queryByRole('dialog')).toBeNull();
  expect((screen.getByRole('button', { name: '删除中…' }) as HTMLButtonElement).disabled).toBe(true);
  expect(api.cleanupStatus).not.toHaveBeenCalled();

  await act(async () => finish({ success: false, code: 'cancelled' }));

  expect(screen.queryByRole('dialog')).toBeNull();
  expect(api.deleteUpgradeBackup).toHaveBeenCalledOnce();
  expect(api.scan).not.toHaveBeenCalled();
  expect((screen.getByRole('button', { name: '删除' }) as HTMLButtonElement).disabled).toBe(false);
});

test('explains a locked backup in the page', async () => {
  api.deleteUpgradeBackup.mockResolvedValue({ success: false, code: 'locked' });
  const { button } = await showBackupRow();

  fireEvent.click(button);

  expect((await screen.findByRole('alert')).textContent).toContain('文件正在被占用');
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(api.deleteUpgradeBackup).toHaveBeenCalledOnce();
  expect(api.scan).toHaveBeenCalledOnce();
});

test('keeps deletion feedback visible when the following statistics scan fails', async () => {
  const { button } = await showBackupRow();
  api.scan.mockRejectedValueOnce(new Error('scan failed'));

  fireEvent.click(button);

  expect(await screen.findByText('升级备份已删除。')).toBeTruthy();
  await screen.findByRole('alert');
  expect(screen.queryByText('升级备份')).toBeNull();
  expect(screen.getByRole('img').getAttribute('aria-label')).not.toContain('升级备份');
  expect(api.deleteUpgradeBackup).toHaveBeenCalledOnce();
  expect(api.upgradeBackupStatus).toHaveBeenCalledTimes(2);
});
