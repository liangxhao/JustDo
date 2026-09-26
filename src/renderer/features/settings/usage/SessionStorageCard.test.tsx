// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { sessionStorageTranslations } from '@/services/i18n/sessionStorageTranslations';

import SessionStorageCard, { totalSessionStorageBytes } from './SessionStorageCard';

vi.mock('react-redux', () => ({ useSelector: () => [{ id: 'main', name: 'Main assistant' }] }));
vi.mock('@/services/i18n', () => ({ i18nService: { t: (key: string) => key } }));
const status = {
  agents: [
    {
      agentId: 'unknown-peer',
      databaseBytes: 10,
      walBytes: 2,
      archiveBytes: 3,
      embeddedArchiveBytes: 4,
      hotTranscripts: 1,
      coldTranscripts: 1,
    },
  ],
  maintenance: {
    running: false,
    lastStartedAt: null,
    lastCompletedAt: null,
    lastError: null,
    archivedTranscripts: 0,
    externalizedTranscripts: 0,
  },
};
const policy = { enabled: true, afterDays: 47, revision: 'a', applied: true };
const api = { getStatus: vi.fn(), getPolicy: vi.fn(), savePolicy: vi.fn(), run: vi.fn() };
beforeEach(() => {
  vi.resetAllMocks();
  Object.defineProperty(document, 'hidden', { configurable: true, value: false });
  Object.defineProperty(window, 'electron', {
    configurable: true,
    value: { cowork: { sessionStorage: api } },
  });
  api.getStatus.mockResolvedValue({ success: true, value: status });
  api.getPolicy.mockResolvedValue({ success: true, value: policy });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
it('counts external files once and has matching translations', () => {
  expect(totalSessionStorageBytes(status)).toBe(15);
  expect(Object.keys(sessionStorageTranslations.zh).sort()).toEqual(
    Object.keys(sessionStorageTranslations.en).sort(),
  );
});
it('shows unknown agents and preserves custom input through polling', async () => {
  render(<SessionStorageCard />);
  const days = await screen.findByRole('spinbutton');
  await waitFor(() => expect((days as HTMLInputElement).value).toBe('47'));
  expect(screen.getByText('unknown-peer')).toBeTruthy();
  fireEvent.change(days, { target: { value: '65' } });
  fireEvent.click(screen.getByText('storageRefresh'));
  await waitFor(() => expect(api.getPolicy).toHaveBeenCalledTimes(2));
  expect((days as HTMLInputElement).value).toBe('65');
  expect((screen.getByText('storageRun') as HTMLButtonElement).disabled).toBe(true);
});
it('requires enabled native policy and never silently enables for a manual run', async () => {
  api.getPolicy.mockResolvedValue({ success: true, value: { ...policy, enabled: false } });
  render(<SessionStorageCard />);
  await screen.findByText('unknown-peer');
  expect((screen.getByText('storageRun') as HTMLButtonElement).disabled).toBe(true);
  expect(api.savePolicy).not.toHaveBeenCalled();
});
it('reconciles a conflicting save without replaying it', async () => {
  api.savePolicy.mockResolvedValue({ success: false, code: 'conflict' });
  render(<SessionStorageCard />);
  await screen.findByText('unknown-peer');
  fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '60' } });
  fireEvent.click(screen.getByText('storageSave'));
  await screen.findByText(/storageError_conflict/);
  await waitFor(() =>
    expect((screen.getByRole('spinbutton') as HTMLInputElement).value).toBe('47'),
  );
  expect(api.savePolicy).toHaveBeenCalledTimes(1);
});
it('retains previous statistics on a read failure', async () => {
  render(<SessionStorageCard />);
  await screen.findByText('unknown-peer');
  api.getStatus.mockResolvedValue({ success: false, code: 'unavailable' });
  fireEvent.click(screen.getByText('storageRefresh'));
  await screen.findByText(/storageStale/);
  expect(screen.getByText('unknown-peer')).toBeTruthy();
});
it('releases polling and focus listeners after unmount', async () => {
  vi.useFakeTimers();
  const view = render(<SessionStorageCard />);
  await act(async () => {
    await Promise.resolve();
  });
  view.unmount();
  const count = api.getStatus.mock.calls.length;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(60000);
    window.dispatchEvent(new Event('focus'));
  });
  expect(api.getStatus).toHaveBeenCalledTimes(count);
});

it('polls a running pass every two seconds and stops while hidden', async () => {
  vi.useFakeTimers();
  api.getStatus.mockResolvedValue({
    success: true,
    value: { ...status, maintenance: { ...status.maintenance, running: true } },
  });
  render(<SessionStorageCard />);
  await act(async () => {
    await Promise.resolve();
  });
  expect((screen.getByText('storageRun') as HTMLButtonElement).disabled).toBe(true);
  const count = api.getStatus.mock.calls.length;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2000);
  });
  expect(api.getStatus).toHaveBeenCalledTimes(count + 1);
  Object.defineProperty(document, 'hidden', { configurable: true, value: true });
  document.dispatchEvent(new Event('visibilitychange'));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(60000);
  });
  expect(api.getStatus).toHaveBeenCalledTimes(count + 1);
  Object.defineProperty(document, 'hidden', { configurable: true, value: false });
  await act(async () => {
    document.dispatchEvent(new Event('visibilitychange'));
  });
  expect(api.getStatus).toHaveBeenCalledTimes(count + 2);
});

it('never replays a timed-out archive request during reconnection', async () => {
  api.run.mockResolvedValue({ success: false, code: 'unavailable' });
  render(<SessionStorageCard />);
  await screen.findByText('unknown-peer');
  fireEvent.click(screen.getByText('storageRun'));
  await screen.findByText(/storageWriteNotReplayed/);
  fireEvent.click(screen.getByText('storageRefresh'));
  await waitFor(() => expect(api.getStatus.mock.calls.length).toBeGreaterThan(2));
  expect(api.run).toHaveBeenCalledTimes(1);
});

it('refreshes immediately after a StrictMode lifecycle discards the first response', async () => {
  let resolveRead!: (value: unknown) => void;
  api.getStatus.mockImplementationOnce(
    () =>
      new Promise(resolve => {
        resolveRead = resolve;
      }),
  );
  render(
    <StrictMode>
      <SessionStorageCard />
    </StrictMode>,
  );
  expect(api.getStatus).toHaveBeenCalledTimes(1);
  await act(async () => resolveRead({ success: true, value: status }));
  await screen.findByText('unknown-peer');
  expect(api.getStatus).toHaveBeenCalledTimes(2);
});

it('does not execute a manual check with invalid input equal to the saved numeric value', async () => {
  render(<SessionStorageCard />);
  await screen.findByText('unknown-peer');
  fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '47.0' } });
  expect(screen.getByText('storageError_invalid')).toBeTruthy();
  expect((screen.getByText('storageRun') as HTMLButtonElement).disabled).toBe(true);
  expect(api.run).not.toHaveBeenCalled();
});

it('does not overlap polling when reads take longer than a polling interval', async () => {
  vi.useFakeTimers();
  let resolveRead!: (value: unknown) => void;
  api.getStatus.mockImplementationOnce(
    () =>
      new Promise(resolve => {
        resolveRead = resolve;
      }),
  );
  render(<SessionStorageCard />);
  await act(async () => {
    window.dispatchEvent(new Event('focus'));
    await vi.advanceTimersByTimeAsync(45000);
  });
  expect(api.getStatus).toHaveBeenCalledTimes(1);
  await act(async () => resolveRead({ success: true, value: status }));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(15000);
  });
  expect(api.getStatus).toHaveBeenCalledTimes(2);
});

it('tracks a requested pass until native completion and accepts zero processed records', async () => {
  vi.useFakeTimers();
  const running = { ...status, maintenance: { ...status.maintenance, running: true } };
  api.run.mockResolvedValue({ success: true, value: running });
  render(<SessionStorageCard />);
  await act(async () => {
    await Promise.resolve();
  });
  api.getStatus.mockResolvedValue({ success: true, value: running });
  await act(async () => {
    fireEvent.click(screen.getByText('storageRun'));
    fireEvent.click(screen.getByText('storageRun'));
  });
  expect(api.run).toHaveBeenCalledTimes(1);
  expect(screen.getByText('storageRunning')).toBeTruthy();
  expect(screen.queryByText(/storageCompleted/)).toBeNull();
  api.getStatus.mockResolvedValue({
    success: true,
    value: { ...status, maintenance: { ...status.maintenance, lastCompletedAt: Date.now() } },
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2000);
  });
  expect(screen.queryByText('storageRunning')).toBeNull();
  expect(screen.getByText(/storageArchivedCount.*0/)).toBeTruthy();
  expect((screen.getByText('storageRun') as HTMLButtonElement).disabled).toBe(false);
});

it('requires authoritative readback after a save before enabling a manual check', async () => {
  api.getPolicy.mockResolvedValue({ success: true, value: { ...policy, enabled: false } });
  api.savePolicy.mockResolvedValue({ success: true, value: policy });
  render(<SessionStorageCard />);
  await screen.findByText('unknown-peer');
  let resolveRead!: (value: unknown) => void;
  api.getPolicy.mockImplementationOnce(
    () =>
      new Promise(resolve => {
        resolveRead = resolve;
      }),
  );
  fireEvent.click(screen.getByRole('checkbox'));
  fireEvent.click(screen.getByText('storageSave'));
  await waitFor(() => expect(api.getPolicy).toHaveBeenCalledTimes(2));
  expect(screen.getByText('storageConfirming')).toBeTruthy();
  expect((screen.getByText('storageRun') as HTMLButtonElement).disabled).toBe(true);
  await act(async () => resolveRead({ success: true, value: policy }));
  expect((screen.getByText('storageRun') as HTMLButtonElement).disabled).toBe(false);
  expect(api.savePolicy).toHaveBeenCalledTimes(1);
});

it('keeps fresh statistics and editable settings while native application is pending', async () => {
  api.getPolicy.mockResolvedValue({ success: true, value: { ...policy, applied: false } });
  api.savePolicy.mockResolvedValue({
    success: true,
    value: { ...policy, applied: false, afterDays: 60 },
  });
  render(<SessionStorageCard />);
  await screen.findByText('storageError_pending');
  expect(screen.queryByText(/storageStale/)).toBeNull();
  expect(screen.queryByText(/storageError_unavailable/)).toBeNull();
  expect((screen.getByRole('spinbutton') as HTMLInputElement).disabled).toBe(false);
  fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '60' } });
  expect((screen.getByText('storageSave') as HTMLButtonElement).disabled).toBe(false);
  expect((screen.getByText('storageRun') as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByText('storageSave'));
  await waitFor(() => expect(api.savePolicy).toHaveBeenCalledTimes(1));
  await waitFor(() =>
    expect((screen.getByText('storageRefresh') as HTMLButtonElement).disabled).toBe(false),
  );
  fireEvent.click(screen.getByText('storageRefresh'));
  await waitFor(() => expect(api.getStatus.mock.calls.length).toBeGreaterThan(2));
});

it('does not mark freshly loaded statistics stale when only the policy read fails', async () => {
  api.getPolicy.mockResolvedValue({ success: false, code: 'configuration' });
  render(<SessionStorageCard />);
  await screen.findByText(/storagePolicyReadFailed/);
  expect(screen.getByText('unknown-peer')).toBeTruthy();
  expect(screen.queryByText(/storageStale/)).toBeNull();
  expect((screen.getByText('storageRefresh') as HTMLButtonElement).disabled).toBe(false);
});
