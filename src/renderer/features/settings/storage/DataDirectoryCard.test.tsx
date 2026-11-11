// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { sessionStorageTranslations } from '@/services/i18n/sessionStorageTranslations';

import DataDirectoryCard from './DataDirectoryCard';

vi.mock('@/services/i18n', () => ({
  i18nService: {
    t: (key: string) => (sessionStorageTranslations.zh as Record<string, string>)[key] ?? key,
  },
}));
const api = { info: vi.fn(), open: vi.fn(), openConfig: vi.fn(), scan: vi.fn() };
const writeText = vi.fn();
const usage = {
  complete: true,
  scannedAt: 1,
  totalBytes: 1024,
  categories: [{ id: 'backups', bytes: 1024 }],
  skippedEntries: 0,
  fileCount: 1,
};
beforeEach(() => {
  vi.resetAllMocks();
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  writeText.mockResolvedValue(undefined);
  Object.defineProperty(window, 'electron', {
    configurable: true,
    value: { storageDirectory: api },
  });
  api.info.mockResolvedValue({
    success: true,
    value: { path: 'D:\\data', bootstrapPath: 'C:\\Users\\user\\AppData\\Roaming\\Profile' },
  });
  api.open.mockResolvedValue({ success: true, value: null });
  api.openConfig.mockResolvedValue({ success: true, value: null });
  api.scan.mockResolvedValue({ success: true, value: usage });
});
afterEach(cleanup);

it('loads both locations without scanning and opens them while a scan is pending', async () => {
  api.scan.mockReturnValueOnce(new Promise(() => {}));
  render(<DataDirectoryCard />);
  await screen.findByText('D:\\data');
  expect(screen.getByText('C:\\Users\\user\\AppData\\Roaming\\Profile').title).toBe(
    'C:\\Users\\user\\AppData\\Roaming\\Profile',
  );
  expect(screen.getByText('配置路径')).toBeTruthy();
  expect(screen.getByText('数据路径')).toBeTruthy();
  expect(api.scan).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '统计空间占用' }));
  expect((screen.getByRole('button', { name: '正在统计…' }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: '打开配置目录' }));
  await waitFor(() => expect(api.openConfig).toHaveBeenCalledExactlyOnceWith());
  expect(api.open).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '打开数据目录' }));
  await waitFor(() => expect(api.open).toHaveBeenCalledOnce());
});

it('counts on demand and preserves stale values if a later scan fails', async () => {
  render(<DataDirectoryCard />);
  fireEvent.click(screen.getByRole('button', { name: '统计空间占用' }));
  await screen.findByText('数据目录占用');
  expect(screen.getByText('升级备份').hasAttribute('title')).toBe(false);
  api.scan.mockRejectedValueOnce(new Error('unavailable'));
  fireEvent.click(screen.getByRole('button', { name: '重新统计' }));
  expect((await screen.findByRole('alert')).textContent).toContain('上次成功');
  expect(screen.getAllByText('1.0 KiB')).toHaveLength(2);
});

it('shows speech-model usage in the chart and aligned rows, then hides it when a rescan finds no bytes', async () => {
  api.scan.mockResolvedValueOnce({
    success: true,
    value: { ...usage, totalBytes: 4096, categories: [
      { id: 'backups', bytes: 1024 },
      { id: 'speech-models', bytes: 2048 },
      { id: 'other', bytes: 1024 },
    ] },
  });
  render(<DataDirectoryCard />);
  fireEvent.click(screen.getByRole('button', { name: '统计空间占用' }));

  const label = await screen.findByText('本地语音模型');
  expect(label.title).toContain('local-speech-models/');
  expect(label.title).toContain('下载、解压暂存');
  const row = label.closest('div')!;
  expect(within(row).getByText('2.0 KiB')).toBeTruthy();
  expect(within(row).queryByRole('button')).toBeNull();
  const chart = screen.getByRole('img');
  expect(chart.getAttribute('aria-label')).toContain('本地语音模型: 2.0 KiB');
  expect(chart.children).toHaveLength(3);
  expect((chart.children[1] as HTMLElement).style.width).toBe('50%');

  api.scan.mockResolvedValueOnce({
    success: true,
    value: { ...usage, categories: [
      { id: 'speech-models', bytes: 0 }, { id: 'other', bytes: 1024 }, { id: 'cache', bytes: 0 },
    ] },
  });
  await waitFor(() => expect((screen.getByRole('button', { name: '重新统计' }) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByRole('button', { name: '重新统计' }));

  await waitFor(() => expect(screen.queryByText('本地语音模型')).toBeNull());
  expect(screen.getByText('配置与其他数据')).toBeTruthy();
  expect(screen.getByText('浏览器缓存')).toBeTruthy();
  expect(screen.getByRole('img').getAttribute('aria-label')).toBe('配置与其他数据: 1.0 KiB · 浏览器缓存: 0 B');
  expect(screen.getByRole('img').children).toHaveLength(2);
});

it('omits the backup row and chart segment when the scan finds no backup bytes', async () => {
  api.scan.mockResolvedValueOnce({ success: true, value: { ...usage,
    categories: [{ id: 'backups', bytes: 0 }, { id: 'other', bytes: 1024 }],
  } });
  render(<DataDirectoryCard />);
  fireEvent.click(screen.getByRole('button', { name: '统计空间占用' }));

  const chart = await screen.findByRole('img');
  expect(screen.queryByText('升级备份')).toBeNull();
  expect(chart.getAttribute('aria-label')).toBe('配置与其他数据: 1.0 KiB');
  expect(chart.children).toHaveLength(1);
});

it('labels skipped or bounded scan results as incomplete rather than an empty total', async () => {
  api.scan.mockResolvedValue({
    success: true,
    value: { ...usage, complete: false, totalBytes: 0, categories: [], skippedEntries: 1 },
  });
  render(<DataDirectoryCard />);
  fireEvent.click(screen.getByRole('button', { name: '统计空间占用' }));
  await screen.findByText('已统计占用（非完整结果）');
  expect(screen.queryByText(/实际占用可能更大/)).toBeNull();
  expect(screen.queryByText('数据目录占用')).toBeNull();
});

it('copies each full path from its own copy button and handles clipboard failures', async () => {
  render(<DataDirectoryCard />);
  await screen.findByText('D:\\data');

  fireEvent.click(screen.getByRole('button', { name: '复制配置路径' }));
  await waitFor(() => expect(writeText).toHaveBeenCalledWith('C:\\Users\\user\\AppData\\Roaming\\Profile'));
  expect((screen.getByRole('button', { name: '复制配置路径' }) as HTMLButtonElement).title).toBe('路径已复制');
  expect((screen.getByRole('button', { name: '复制数据路径' }) as HTMLButtonElement).title).toBe('复制数据路径');

  writeText.mockRejectedValueOnce(new Error('clipboard denied'));
  fireEvent.click(screen.getByRole('button', { name: '复制数据路径' }));
  expect((await screen.findByRole('alert')).textContent).toBe('复制失败，请重试。');
  expect(writeText).toHaveBeenLastCalledWith('D:\\data');
});
