// @vitest-environment jsdom
import { fireEvent, screen, within } from '@testing-library/dom';
import { afterEach, expect, test, vi } from 'vitest';

import { StorageMaintenancePhase, type StorageMaintenanceStatus } from '../shared/storage/storageRelocation';
import template from './storage-maintenance.html?raw';

const waiting: StorageMaintenanceStatus = {
  language: 'zh', canRetry: false, canCancel: false,
};

async function openMaintenance(status: Promise<StorageMaintenanceStatus>) {
  document.body.innerHTML = template.match(/<body>([\s\S]*)<\/body>/u)![1];
  let render!: (progress: StorageMaintenanceStatus) => void;
  const cancel = vi.fn(async () => {});
  Object.defineProperty(window, 'storageMaintenance', {
    configurable: true,
    value: {
      status: () => status,
      onChanged: (listener: typeof render) => { render = listener; },
      retry: vi.fn(async () => {}),
      cancel,
    },
  });
  await import('./storageMaintenance');
  return { render, cancel };
}

afterEach(() => {
  document.body.replaceChildren();
  Reflect.deleteProperty(window, 'storageMaintenance');
  vi.resetModules();
});

test('renders the current migration stage when the window opens during copying and advances on updates', async () => {
  const { render } = await openMaintenance(Promise.resolve({
    ...waiting,
    phase: StorageMaintenancePhase.CopyingData,
  }));
  const progress = within(await screen.findByRole('list', { name: '迁移进度' }));
  expect(progress.getByText('复制数据').closest('li')?.getAttribute('aria-current')).toBe('step');
  expect(screen.getByRole('status').textContent).toBe('正在将数据复制到目标文件夹。');

  render({ ...waiting, phase: StorageMaintenancePhase.SwitchingLocation });
  expect(progress.getByText('切换与清理').closest('li')?.getAttribute('aria-current')).toBe('step');
  expect(progress.getByText('复制数据').closest('li')?.hasAttribute('aria-current')).toBe(false);
  expect(screen.getByRole('status').textContent).toContain('完成后会自动重启');
});

test('shows identified file owners by name and PID and offers to return to the original location', async () => {
  let resolveStatus!: (progress: StorageMaintenanceStatus) => void;
  const status = new Promise<StorageMaintenanceStatus>(resolve => { resolveStatus = resolve; });
  const { render, cancel } = await openMaintenance(status);
  const failure = { ...waiting, error: 'failed' as const, errorPath: 'D:\\data\\profile.db', canCancel: true };
  render({ ...failure, blocking: { kind: 'file', checking: true, processes: [] } });
  expect(screen.getByText('正在查找相关进程…')).toBeTruthy();

  const name = '<img src=x onerror=alert(1)>.exe';
  render({ ...failure, blocking: { kind: 'file', processes: [
    { pid: 81, name, appOwned: false },
    { pid: 82, name: 'node.exe', appOwned: true },
  ] } });
  resolveStatus(waiting);
  await status;

  const processes = within(screen.getByRole('list', { name: '占用该位置的进程' }));
  expect(processes.getByText(name)).toBeTruthy();
  expect(processes.queryByRole('img')).toBeNull();
  expect(processes.getByText('PID 81 · 其他程序')).toBeTruthy();
  expect(processes.getByText('node.exe')).toBeTruthy();
  expect(processes.getByText('PID 82 · 应用相关进程')).toBeTruthy();
  expect(screen.getByText('D:\\data\\profile.db')).toBeTruthy();
  expect(screen.getByText(/保留迁移窗口及其进程/)).toBeTruthy();
  expect(screen.getByText(/可在设置中重新迁移/)).toBeTruthy();
  expect(screen.queryByRole('button', { name: '重试' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '返回原位置' }));
  expect(cancel).toHaveBeenCalledOnce();
  render(waiting);
  expect(screen.queryByRole('list')).toBeNull();
});

test('gives wait guidance for an application process and reports an unidentified result', async () => {
  const { render } = await openMaintenance(Promise.resolve(waiting));
  const failure = { ...waiting, language: 'en' as const, error: 'failed' as const };
  render({ ...failure, blocking: { kind: 'retirement', processes: [{ pid: 93, name: 'node.exe', appOwned: true }] } });
  expect(screen.getByRole('list', { name: 'Processes still running' })).toBeTruthy();
  expect(screen.getByText('PID 93 · Application-related process')).toBeTruthy();
  expect(screen.getByText('Once those processes exit, close the migration window and reopen the app.')).toBeTruthy();
  expect(screen.queryByRole('button')).toBeNull();

  render({ ...failure, blocking: { kind: 'retirement', processes: [] } });
  expect(screen.getByText(/Could not identify the related processes/)).toBeTruthy();
  expect(screen.queryByRole('list')).toBeNull();
});
