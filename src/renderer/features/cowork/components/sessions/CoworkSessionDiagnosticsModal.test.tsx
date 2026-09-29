// @vitest-environment jsdom
import type { DiagnosticReport } from '@shared/cowork/sessionDiagnostics';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { i18nService } from '@/services/i18n';

import CoworkSessionDiagnosticsModal from './CoworkSessionDiagnosticsModal';

const report = (overrides: Partial<DiagnosticReport> = {}): DiagnosticReport => ({
  version: 1,
  snapshotId: 'snapshot-1',
  sessionId: 'target',
  collectedAt: 100,
  run: { id: 'run-1', startedAt: 1, state: 'completed' },
  conclusion: { reason: 'completed', confidence: 'confirmed', evidenceIds: [], toolFailures: 0 },
  events: [],
  coverage: { partial: true, dropped: 2, storageFailed: false },
  connection: 'offline',
  environment: { status: 'not_requested' },
  ...overrides,
});
const bridge = {
  list: vi.fn(),
  read: vi.fn(),
  refresh: vi.fn(),
  collect: vi.fn(),
  export: vi.fn(),
  onProgress: vi.fn(),
  cancel: vi.fn(),
};
beforeEach(() => {
  vi.resetAllMocks();
  i18nService.setLanguage('en', { persist: false });
  bridge.cancel.mockResolvedValue({ success: true });
  bridge.onProgress.mockReturnValue(vi.fn());
  bridge.list.mockResolvedValue({ success: true, runs: [report().run] });
  bridge.read.mockResolvedValue({ success: true, report: report() });
  bridge.collect.mockImplementation(
    async () => bridge.read.mock.results[bridge.read.mock.results.length - 1]?.value,
  );
  bridge.export.mockResolvedValue({ success: true, canceled: false });
  Object.defineProperty(window, 'electron', {
    configurable: true,
    value: { cowork: { diagnostics: bridge } },
  });
});
afterEach(cleanup);
const open = () =>
  render(
    <CoworkSessionDiagnosticsModal
      sessionId="target"
      sessionTitle="Other conversation"
      onClose={vi.fn()}
    />,
  );

describe('session diagnostics', () => {
  it('shows the stored tool error instead of repeating the missing-cause fallback', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    bridge.read.mockResolvedValue({
      success: true,
      report: report({
        events: [
          {
            id: 'failed',
            runId: 'run-1',
            epoch: 'epoch',
            observedAt: 10,
            kind: 'tool',
            phase: 'end',
            toolFailed: true,
          },
        ],
        history: {
          status: 'scanned',
          messagesScanned: 300,
          omitted: 0,
          failures: [
            {
              timestamp: 10,
              kind: 'tool',
              tool: 'read',
              excerpt: 'ENOENT: report.csv missing',
              clipped: false,
              association: 'run_window',
            },
          ],
        },
      }),
    });
    open();
    expect(await screen.findByText('ENOENT: report.csv missing')).toBeTruthy();
    expect(screen.getByText(/Read 300 stored conversation records/)).toBeTruthy();
    expect(screen.queryByText('A tool step failed; the cause was not recorded')).toBeNull();
    await waitFor(() =>
      expect(
        (screen.getByRole('button', { name: 'Copy summary' }) as HTMLButtonElement).disabled,
      ).toBe(false),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Copy summary' }));
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    expect(writeText.mock.calls[0][0]).toContain('ENOENT: report.csv missing');
    expect(writeText.mock.calls[0][0]).toContain('Stored conversation · within run time range');
    expect(writeText.mock.calls[0][0]).not.toContain(
      'A tool step failed; the cause was not recorded',
    );
  });
  it('shows tool failures before metrics even when the whole run completed normally', async () => {
    bridge.read.mockResolvedValue({
      success: true,
      report: report({
        events: [
          {
            id: 'tool-failure',
            runId: 'run-1',
            epoch: 'epoch',
            observedAt: 10,
            kind: 'tool',
            phase: 'end',
            toolFailed: true,
          },
        ],
      }),
    });
    open();
    const heading = await screen.findByText('Findings for this run');
    expect(screen.getByText('Observed in this run')).toBeTruthy();
    expect(screen.getByText('A tool step failed; the cause was not recorded')).toBeTruthy();
    expect(screen.getByText(/Open the failed step near these times/)).toBeTruthy();
    expect(screen.queryByText('The runtime marked a tool result as failed.')).toBeNull();
    expect(screen.queryByText(/Supporting records/)).toBeNull();
    expect(
      heading.compareDocumentPosition(screen.getByText('Matching diagnostic records')) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      screen
        .getByText(
          'Execution ended normally. This does not confirm that the task goal was achieved.',
        )
        .closest('details')?.open,
    ).toBe(false);
  });

  it('labels nearby log problems as potentially unrelated instead of confirmed failures', async () => {
    bridge.read.mockResolvedValue({
      success: true,
      report: report({
        logs: {
          collectedAt: 100,
          window: { from: 0, to: 100 },
          localTimezoneOffsetMinutes: 0,
          partial: true,
          sources: [],
          records: [
            {
              id: 'hint',
              source: 'native',
              level: 'error',
              signal: 'auth',
              association: 'time_window',
              inferred: true,
              metrics: {},
            },
          ],
        },
      }),
    });
    open();
    await screen.findByText('Nearby in time; may be unrelated');
    expect(screen.queryByText('Observed in this run')).toBeNull();
    expect(
      screen.getByText(/Other log clues · not attributed to this run/).closest('details')?.open,
    ).toBe(false);
    expect(screen.queryByText(/Check the selected provider credentials/)).toBeNull();
    expect(screen.getByText('Collection details and timeline').closest('details')?.open).toBe(
      false,
    );
  });

  it('groups repeated evidence and explains HTTP failures instead of listing only source and level', async () => {
    bridge.read.mockResolvedValue({
      success: true,
      report: report({
        logs: {
          collectedAt: 100,
          window: { from: 0, to: 100 },
          localTimezoneOffsetMinutes: 0,
          partial: true,
          sources: [],
          records: ['main', 'native'].map((source, index) => ({
            id: `http-${index}`,
            source: source as 'main' | 'native',
            timestamp: 10,
            level: 'info',
            signal: 'auth',
            basis: 'http_status',
            association: 'time_window',
            inferred: true,
            metrics: { statusCode: 401 },
          })),
        },
      }),
    });
    open();
    await screen.findByText(/An HTTP error status was recorded.*Status code: 401/);
    expect(screen.getByText(/2 records have the same time and description/)).toBeTruthy();
    expect(screen.getByText(/They cannot establish a problem in this run/)).toBeTruthy();
  });
  it('shows historical application state and blocks export until automatic collection completes', async () => {
    const historical = report({
      run: { id: 'run-1', startedAt: 1, endedAt: 50, state: 'failed' },
      conclusion: { reason: 'unknown', confidence: 'unknown', evidenceIds: [], toolFailures: 0 },
    });
    bridge.read.mockResolvedValue({ success: true, report: historical });
    let finish!: (value: unknown) => void;
    bridge.collect.mockImplementation(
      () =>
        new Promise(resolve => {
          finish = resolve;
        }),
    );
    open();
    await screen.findByText('Collecting application and runtime log evidence…');
    expect(screen.getByText('Application run record (does not establish the cause)')).toBeTruthy();
    expect(screen.getByText('Failed')).toBeTruthy();
    const exportButton = screen.getByRole('button', { name: 'Export diagnostic report' });
    expect((exportButton as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(exportButton);
    expect(bridge.export).not.toHaveBeenCalled();
    finish({ success: true, report: { ...historical, snapshotId: 'collected' } });
    await waitFor(() => expect((exportButton as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(exportButton);
    await waitFor(() =>
      expect(bridge.export).toHaveBeenCalledWith(
        expect.objectContaining({ snapshotId: 'collected' }),
      ),
    );
  });

  it('shows scan progress, ignores another snapshot and cancels the active scan', async () => {
    let progress!: (value: unknown) => void;
    bridge.onProgress.mockImplementation(callback => {
      progress = callback;
      return vi.fn();
    });
    let finish!: (value: unknown) => void;
    bridge.collect.mockImplementation(
      () =>
        new Promise(resolve => {
          finish = resolve;
        }),
    );
    open();
    await screen.findByRole('button', { name: 'Cancel scan' });
    const update = {
      snapshotId: 'snapshot-1',
      source: 'main',
      filesCompleted: 2,
      bytesRead: 1048576,
      fileBytesRead: 1048576,
      fileBytesTotal: 2097152,
    };
    progress({ ...update, snapshotId: 'other', filesCompleted: 999 });
    expect(screen.queryByText(/999/)).toBeNull();
    progress(update);
    await screen.findByText(/Files scanned \/ bytes read: 2/);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel scan' }));
    expect(bridge.cancel).toHaveBeenCalledWith(
      expect.objectContaining({ snapshotId: 'snapshot-1' }),
    );
    finish({ success: true, report: report() });
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Cancel scan' })).toBeNull());
  });

  it.each([false, true])(
    'keeps keyboard focus inside during a pending action (shift=%s)',
    async shiftKey => {
      bridge.collect
        .mockResolvedValueOnce({ success: true, report: report() })
        .mockReturnValue(new Promise(() => {}));
      open();
      await screen.findByText(
        'Log evidence has not been collected. You can still export the event metadata.',
      );
      const initiatingButton = screen.getByRole('button', { name: 'Collect log evidence' });
      await waitFor(() => expect((initiatingButton as HTMLButtonElement).disabled).toBe(false));
      initiatingButton.focus();
      fireEvent.click(initiatingButton);
      expect((initiatingButton as HTMLButtonElement).disabled).toBe(true);
      expect(document.activeElement).toBe(initiatingButton);
      const tab = new KeyboardEvent('keydown', {
        key: 'Tab',
        shiftKey,
        bubbles: true,
        cancelable: true,
      });
      document.dispatchEvent(tab);
      expect(tab.defaultPrevented).toBe(true);
      expect(document.activeElement).toBe(
        shiftKey
          ? screen.getByText('Technical details').closest('summary')
          : screen.getByRole('button', { name: 'Close' }),
      );
    },
  );

  it('collects bounded logs offline, previews partial sources and exports the collected snapshot', async () => {
    bridge.collect.mockResolvedValue({
      success: true,
      report: report({
        snapshotId: 'with-logs',
        logs: {
          collectedAt: 200,
          window: { from: 0, to: 200 },
          localTimezoneOffsetMinutes: -480,
          partial: true,
          sources: [
            {
              source: 'main',
              status: 'partial',
              filesRead: 1,
              bytesRead: 100,
              recordsRead: 4,
              emitted: 1,
              suppressed: 3,
              parseFailures: 1,
              truncated: true,
              reasons: ['limit', 'malformed'],
            },
            {
              source: 'native',
              status: 'unavailable',
              filesRead: 0,
              bytesRead: 0,
              recordsRead: 0,
              emitted: 0,
              suppressed: 0,
              parseFailures: 0,
              truncated: false,
              reasons: ['native_unavailable'],
            },
          ],
          records: [
            {
              id: 'log-1',
              source: 'main',
              level: 'warn',
              association: 'time_window',
              signal: 'retry',
              inferred: true,
              metrics: { attempt: 2 },
            },
          ],
        },
      }),
    });
    open();
    await screen.findByText('Application main process · Partial');
    expect(bridge.collect).toHaveBeenCalledOnce();
    expect(
      screen.getByText(
        'No execution events were recorded for this run. Available logs may still provide evidence.',
      ),
    ).toBeTruthy();
    expect(screen.queryByText('No diagnostic evidence was collected for this run.')).toBeNull();
    expect(bridge.collect).toHaveBeenCalledWith({
      sessionId: 'target',
      sessionRunId: 'run-1',
      snapshotId: 'snapshot-1',
    });
    expect(screen.getByText('Native runtime logs · Unavailable')).toBeTruthy();
    expect(
      screen.getByText(
        'The source was truncated by collection limits; earlier records may be absent.',
      ),
    ).toBeTruthy();
    expect(
      screen.getByText('Collector timezone for timestamps without an offset: UTC+08:00'),
    ).toBeTruthy();
    expect(screen.getByText(/Time window only; unconfirmed association/)).toBeTruthy();
    expect(screen.getByText(/Inferred hint; not a confirmed cause/)).toBeTruthy();
    expect(screen.getByText('Attempt: 2')).toBeTruthy();
    await waitFor(() =>
      expect(
        (screen.getByRole('button', { name: 'Export diagnostic report' }) as HTMLButtonElement)
          .disabled,
      ).toBe(false),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Export diagnostic report' }));
    await waitFor(() =>
      expect(bridge.export).toHaveBeenCalledWith({
        sessionId: 'target',
        sessionRunId: 'run-1',
        snapshotId: 'with-logs',
      }),
    );
  });

  it('preserves the displayed snapshot after log collection fails', async () => {
    bridge.collect.mockRejectedValue(new Error('sensitive log path'));
    open();
    await screen.findByText(
      'Log evidence has not been collected. You can still export the event metadata.',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Collect log evidence' }));
    await screen.findByRole('alert');
    expect(screen.queryByText('sensitive log path')).toBeNull();
    await waitFor(() =>
      expect(
        (screen.getByRole('button', { name: 'Export diagnostic report' }) as HTMLButtonElement)
          .disabled,
      ).toBe(false),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Export diagnostic report' }));
    await waitFor(() =>
      expect(bridge.export).toHaveBeenCalledWith(
        expect.objectContaining({ snapshotId: 'snapshot-1' }),
      ),
    );
  });

  it('shows categorized errors and distinguishes attempts from run terminals without technical details', async () => {
    bridge.read.mockResolvedValue({
      success: true,
      report: report({
        events: [
          {
            id: 'attempt',
            runId: 'run-1',
            epoch: 'epoch',
            observedAt: 1,
            kind: 'lifecycle',
            phase: 'error',
            errorCategory: 'auth',
          },
          {
            id: 'terminal',
            runId: 'run-1',
            epoch: 'epoch',
            observedAt: 2,
            kind: 'lifecycle',
            phase: 'error',
            errorCategory: 'provider',
            executionSettled: true,
          },
        ],
      }),
    });
    open();
    await screen.findByText('Authentication or authorization error');
    expect(screen.getByText('Model service error')).toBeTruthy();
    expect(screen.getAllByText('Attempt observation; run end unconfirmed')).toHaveLength(1);
    expect(screen.getAllByText('Run terminal')).toHaveLength(1);
    expect(screen.getByText('Technical details').closest('details')?.open).toBe(false);
  });

  it('labels collector losses as global unassociated evidence in the report and copied summary', async () => {
    bridge.read.mockResolvedValue({
      success: true,
      report: report({
        coverage: { partial: true, dropped: 0, storageFailed: false, collectorDropped: 7 },
      }),
    });
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    open();
    await screen.findByText(
      'Global collector losses (unassociated events; not proven missing evidence for this conversation): 7',
    );
    await waitFor(() =>
      expect(
        (screen.getByRole('button', { name: 'Copy summary' }) as HTMLButtonElement).disabled,
      ).toBe(false),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Copy summary' }));
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith(
        expect.stringContaining(
          'Global collector losses (unassociated events; not proven missing evidence for this conversation): 7',
        ),
      ),
    );
  });

  it('returns focus to the surviving list container when its session row was removed', () => {
    const container = document.createElement('div');
    const origin = document.createElement('button');
    container.append(origin);
    document.body.append(container);
    const view = render(
      <CoworkSessionDiagnosticsModal
        sessionId="target"
        sessionTitle="Other conversation"
        returnFocusRef={{ current: origin }}
        onClose={vi.fn()}
      />,
    );
    origin.remove();
    view.unmount();
    expect(document.activeElement).toBe(container);
    expect(container.hasAttribute('tabindex')).toBe(false);
    container.remove();
  });

  it('loads local evidence without querying online context and exports the displayed snapshot while offline', async () => {
    open();
    await screen.findByText(
      'Execution ended normally. This does not confirm that the task goal was achieved.',
    );
    expect(bridge.read).toHaveBeenCalledWith({ sessionId: 'target' });
    expect(bridge.refresh).not.toHaveBeenCalled();
    expect(
      (screen.getByRole('button', { name: 'Collect online context' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    await waitFor(() =>
      expect(
        (screen.getByRole('button', { name: 'Export diagnostic report' }) as HTMLButtonElement)
          .disabled,
      ).toBe(false),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Export diagnostic report' }));
    await waitFor(() =>
      expect(bridge.export).toHaveBeenCalledWith({
        sessionId: 'target',
        sessionRunId: 'run-1',
        snapshotId: 'snapshot-1',
      }),
    );
  });

  it.each(['refresh', 'collect'] as const)(
    'ignores an old %s response after selecting another run',
    async action => {
      bridge.list.mockResolvedValue({
        success: true,
        runs: [report().run, { id: 'run-2', startedAt: 2, state: 'failed' }],
      });
      bridge.read
        .mockResolvedValueOnce({ success: true, report: report({ connection: 'connected' }) })
        .mockResolvedValueOnce({
          success: true,
          report: report({
            snapshotId: 'snapshot-2',
            run: { id: 'run-2', startedAt: 2, state: 'failed' },
            conclusion: {
              reason: 'failed',
              confidence: 'confirmed',
              evidenceIds: [],
              toolFailures: 0,
            },
          }),
        });
      let resolve!: (value: unknown) => void;
      bridge[action].mockImplementation(
        () =>
          new Promise(done => {
            resolve = done;
          }),
      );
      if (action === 'collect')
        bridge.collect.mockImplementationOnce(
          async () => bridge.read.mock.results[bridge.read.mock.results.length - 1]?.value,
        );
      open();
      await screen.findByText(
        'Execution ended normally. This does not confirm that the task goal was achieved.',
      );
      await waitFor(() =>
        expect(
          (screen.getByRole('button', { name: 'Export diagnostic report' }) as HTMLButtonElement)
            .disabled,
        ).toBe(false),
      );
      fireEvent.click(
        screen.getByRole('button', {
          name: action === 'refresh' ? 'Collect online context' : 'Collect log evidence',
        }),
      );
      await waitFor(() => expect(resolve).toBeTypeOf('function'));
      if (action === 'collect')
        bridge.collect.mockImplementationOnce(
          async () => bridge.read.mock.results[bridge.read.mock.results.length - 1]?.value,
        );
      fireEvent.change(screen.getByRole('combobox'), { target: { value: 'run-2' } });
      await screen.findByText('Execution failed.');
      resolve({ success: true, report: report({ snapshotId: 'stale' }) });
      await waitFor(() =>
        expect(
          screen.queryByText(
            'Execution ended normally. This does not confirm that the task goal was achieved.',
          ),
        ).toBeNull(),
      );
      await waitFor(() =>
        expect(
          (screen.getByRole('button', { name: 'Export diagnostic report' }) as HTMLButtonElement)
            .disabled,
        ).toBe(false),
      );
      fireEvent.click(screen.getByRole('button', { name: 'Export diagnostic report' }));
      await waitFor(() =>
        expect(bridge.export).toHaveBeenCalledWith({
          sessionId: 'target',
          sessionRunId: 'run-2',
          snapshotId: 'snapshot-2',
        }),
      );
    },
  );

  it('removes a deleted session snapshot and disables further exports', async () => {
    bridge.export.mockResolvedValue({ success: false, reason: 'missing' });
    open();
    await screen.findByText(
      'Execution ended normally. This does not confirm that the task goal was achieved.',
    );
    await waitFor(() =>
      expect(
        (screen.getByRole('button', { name: 'Export diagnostic report' }) as HTMLButtonElement)
          .disabled,
      ).toBe(false),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Export diagnostic report' }));
    await screen.findByRole('alert');
    expect(
      screen.queryByText(
        'Execution ended normally. This does not confirm that the task goal was achieved.',
      ),
    ).toBeNull();
    expect(
      (screen.getByRole('button', { name: 'Export diagnostic report' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it('preserves local evidence when online context fails and shows collection as optional global context', async () => {
    bridge.read.mockResolvedValue({
      success: true,
      report: report({
        connection: 'connected',
        coverage: { partial: true, dropped: 2, storageFailed: true },
      }),
    });
    bridge.refresh.mockRejectedValue(new Error('sensitive provider response'));
    open();
    await screen.findByText(
      'Execution ended normally. This does not confirm that the task goal was achieved.',
    );
    await waitFor(() =>
      expect(
        (screen.getByRole('button', { name: 'Collect online context' }) as HTMLButtonElement)
          .disabled,
      ).toBe(false),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Collect online context' }));
    await screen.findByText(
      'Diagnostics are temporarily unavailable. Try refreshing local evidence.',
    );
    expect(
      screen.getByText(
        'Execution ended normally. This does not confirm that the task goal was achieved.',
      ),
    ).toBeTruthy();
    expect(
      screen.getByText(
        'Global environment context; these counts do not establish the cause of this run.',
      ),
    ).toBeTruthy();
    expect(screen.queryByText('sensitive provider response')).toBeNull();
  });

  it('supports paged history, keyboard trapping and focus restoration', async () => {
    bridge.list
      .mockResolvedValueOnce({ success: true, runs: [report().run], nextCursor: 'older' })
      .mockResolvedValueOnce({
        success: true,
        runs: [{ id: 'older-run', startedAt: 0, state: 'completed' }],
      });
    const origin = document.createElement('button');
    document.body.append(origin);
    origin.focus();
    const onClose = vi.fn();
    const view = render(
      <CoworkSessionDiagnosticsModal
        sessionId="target"
        sessionTitle="Other conversation"
        returnFocusRef={{ current: origin }}
        onClose={onClose}
      />,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Load older runs' }));
    await waitFor(() =>
      expect(bridge.list).toHaveBeenLastCalledWith({ sessionId: 'target', cursor: 'older' }),
    );
    await waitFor(() => expect(screen.getAllByRole('option')).toHaveLength(3));
    screen.getByRole('button', { name: 'Close' }).focus();
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: 'Export diagnostic report' }),
    );
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledOnce();
    view.unmount();
    expect(document.activeElement).toBe(origin);
    origin.remove();
  });
});
