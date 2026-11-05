// @vitest-environment jsdom
import type { ExtensionDataInfoResult } from '@shared/plugins/extensions';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';

import ExtensionDataCleanup from './ExtensionDataCleanup';

vi.mock('@/services/i18n', () => ({
  i18nService: { t: (key: string) => key === 'extensionDataSize' ? 'Free {size}' : key },
}));
afterEach(cleanup);

function bridge(dataInfo: (request: { extensionId: string }) => Promise<ExtensionDataInfoResult>) {
  Object.defineProperty(window, 'electron', {
    configurable: true, value: { extensions: { dataInfo } },
  });
}

test('keeps data by default and offers its estimated size for explicit selection', async () => {
  const dataInfo = vi.fn(async () => ({ success: true, exists: true, canDelete: true, bytes: 2 ** 30 }));
  bridge(dataInfo);
  const onChange = vi.fn();
  render(<ExtensionDataCleanup extensionId="sample" checked={false} disabled={false} onChange={onChange} />);
  await screen.findByText('Free 1.0 GiB');
  const checkbox = screen.getByRole('checkbox') as HTMLInputElement;
  expect(checkbox.checked).toBe(false);
  expect(checkbox.disabled).toBe(false);
  expect(dataInfo).toHaveBeenCalledExactlyOnceWith({ extensionId: 'sample' });
  fireEvent.click(checkbox);
  expect(onChange).toHaveBeenLastCalledWith(true);
});

test('hides the entire data section while inspecting and when no directory exists', async () => {
  let finish!: (result: ExtensionDataInfoResult) => void;
  bridge(() => new Promise(resolve => { finish = resolve; }));
  const onChange = vi.fn();
  const { container } = render(
    <ExtensionDataCleanup extensionId="sample" checked={false} disabled={false} onChange={onChange} />,
  );
  expect(container.innerHTML).toBe('');

  await act(async () => finish({ success: true, exists: false, canDelete: true, bytes: 0 }));

  expect(container.innerHTML).toBe('');
  expect(onChange).not.toHaveBeenCalledWith(true);
});

test.each([
  { success: false },
  { success: true, exists: false, canDelete: false, bytes: 0 },
])('does not mistake a failed inspection for an absent directory: %j', async result => {
  bridge(async () => result);
  render(<ExtensionDataCleanup extensionId="sample" checked={false} disabled={false} onChange={vi.fn()} />);

  await screen.findByText('extensionDataCleanupUnavailable');
  expect((screen.getByRole('checkbox') as HTMLInputElement).disabled).toBe(true);
});

test('unreadable data cannot be selected for deletion', async () => {
  bridge(async () => ({ success: true, exists: true, canDelete: false, bytes: 0 }));
  const onChange = vi.fn();
  render(<ExtensionDataCleanup extensionId="sample" checked={false} disabled={false} onChange={onChange} />);
  await screen.findByText('extensionDataCleanupUnavailable');
  expect((screen.getByRole('checkbox') as HTMLInputElement).disabled).toBe(true);
  expect(onChange).not.toHaveBeenCalledWith(true);
});

test('retained execution records show their retention policy instead of a temporary failure', async () => {
  bridge(async () => ({ success: true, exists: true, canDelete: false, bytes: 1024, retained: true }));
  const onChange = vi.fn();
  render(<ExtensionDataCleanup extensionId="sample" checked={false} disabled={false} onChange={onChange} />);
  await screen.findByText('extensionDataRetained');
  expect(screen.queryByText('extensionDataCleanupUnavailable')).toBeNull();
  expect((screen.getByRole('checkbox') as HTMLInputElement).disabled).toBe(true);
  expect(onChange).not.toHaveBeenCalledWith(true);
});

test('a late estimate from the previous plugin cannot enable the new deletion choice', async () => {
  let finishOld!: (result: ExtensionDataInfoResult) => void;
  bridge(({ extensionId }) => extensionId === 'old'
    ? new Promise(resolve => { finishOld = resolve; })
    : Promise.resolve({ success: false }));
  const onChange = vi.fn();
  const view = render(<ExtensionDataCleanup extensionId="old" checked={false} disabled={false} onChange={onChange} />);
  view.rerender(<ExtensionDataCleanup extensionId="new" checked={false} disabled={false} onChange={onChange} />);
  await screen.findByText('extensionDataCleanupUnavailable');
  await act(async () => finishOld({ success: true, exists: true, canDelete: true, bytes: 2 ** 30 }));
  expect(screen.queryByText('Free 1.0 GiB')).toBeNull();
  expect((screen.getByRole('checkbox') as HTMLInputElement).disabled).toBe(true);
});
