// @vitest-environment jsdom
import type {
  EngineDiagnosticReport,
  EngineDiagnosticResult,
} from '@shared/openclaw/engineDiagnostics';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import EngineDiagnosticsModal from './EngineDiagnosticsModal';

vi.mock('@/services/i18n', () => ({ i18nService: { t: (key: string) => key } }));
const report: EngineDiagnosticReport = {
  context: {
    id: 'e05834ef-8035-45cc-a3f8-545ee4a75e30',
    startedAt: 1000,
    failedAt: 2000,
    processGeneration: 2,
    status: { phase: 'error', version: 'test', canRetry: true, message: 'Startup timed out' },
  },
  collectedAt: 2500,
  window: { from: 1000, to: 2500 },
  engineChanged: false,
  evidence: [
    {
      id: 'gateway-1',
      source: 'gateway',
      timestamp: 1500,
      level: 'error',
      category: 'port',
      text: 'listen EADDRINUSE\n  at gateway.js:23',
      truncated: false,
    },
  ],
  findings: ['gateway-1'],
  coverage: [
    { source: 'main', files: 1, scannedFiles: 1, matched: 0, omitted: 0, issues: [] },
    { source: 'gateway', files: 1, scannedFiles: 1, matched: 1, omitted: 0, issues: [] },
    { source: 'native', files: 0, scannedFiles: 0, matched: 0, omitted: 0, issues: ['offline'] },
  ],
};
describe('engine diagnostics modal', () => {
  const collect = vi.fn();
  const cancel = vi.fn();
  const clipboard = vi.fn();
  const props = {
    status: { ...report.context.status, diagnosticId: report.context.id },
    commandError: null,
    onClose: vi.fn(),
    onStart: vi.fn(),
  };
  beforeEach(() => {
    vi.clearAllMocks();
    collect.mockResolvedValue({ success: true, report });
    cancel.mockResolvedValue({ success: false, reason: 'canceled' });
    clipboard.mockResolvedValue(undefined);
    Object.defineProperty(window, 'electron', {
      configurable: true,
      value: { openclaw: { engine: { collectDiagnostics: collect, cancelDiagnostics: cancel } } },
    });
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: clipboard },
    });
  });
  afterEach(() => cleanup());

  it('automatically collects on open and copies the displayed evidence and gaps', async () => {
    render(
      <StrictMode>
        <EngineDiagnosticsModal {...props} />
      </StrictMode>,
    );
    expect(
      (screen.getByRole('button', { name: 'engineDiagnosticsCopy' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(await screen.findByText('engineDiagnosticsCause_port')).toBeTruthy();
    expect(collect).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: 'engineDiagnosticsCopy' }));
    await waitFor(() => expect(clipboard).toHaveBeenCalledOnce());
    expect(clipboard.mock.calls[0][0]).toContain('EADDRINUSE');
    expect(clipboard.mock.calls[0][0]).toContain('gateway.js:23');
    expect(clipboard.mock.calls[0][0]).toContain('engineDiagnosticsIssue_offline');
    expect(await screen.findByText('engineDiagnosticsCopied')).toBeTruthy();
  });

  it('cancels an active scan on close and ignores late results', async () => {
    let finish!: (result: EngineDiagnosticResult) => void;
    collect.mockReturnValue(
      new Promise<EngineDiagnosticResult>(resolve => {
        finish = resolve;
      }),
    );
    const view = render(<EngineDiagnosticsModal {...props} />);
    await waitFor(() => expect(collect).toHaveBeenCalledOnce());
    view.unmount();
    expect(cancel).toHaveBeenCalledWith(collect.mock.calls[0][0]);
    await act(async () => finish({ success: true, report }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('waits for a canceled scan to release its slot when immediately reopened', async () => {
    let finish!: (result: EngineDiagnosticResult) => void;
    const pending = new Promise<EngineDiagnosticResult>(resolve => { finish = resolve; });
    collect.mockReturnValueOnce(pending);
    const first = render(<EngineDiagnosticsModal {...props} />);
    await waitFor(() => expect(collect).toHaveBeenCalledOnce());
    const oldQuery = collect.mock.calls[0][0];

    first.unmount();
    render(<EngineDiagnosticsModal {...props} />);
    expect(cancel).toHaveBeenCalledWith(oldQuery);
    await act(async () => {});
    expect(collect).toHaveBeenCalledOnce();
    expect(screen.queryByRole('alert')).toBeNull();

    await act(async () => finish({ success: false, reason: 'canceled' }));
    expect(await screen.findByText('engineDiagnosticsCause_port')).toBeTruthy();
    expect(collect).toHaveBeenCalledTimes(2);
    expect(collect.mock.calls[1][0].requestId).not.toBe(oldQuery.requestId);
  });

  it('serializes a new failure modal after an old diagnostic identity is unmounted', async () => {
    let finish!: (result: EngineDiagnosticResult) => void;
    const pending = new Promise<EngineDiagnosticResult>(resolve => { finish = resolve; });
    const nextId = 'f05834ef-8035-45cc-a3f8-545ee4a75e30';
    const nextReport = {
      ...report,
      context: { ...report.context, id: nextId },
      evidence: [{ ...report.evidence[0], category: 'config', text: 'Invalid new config' }],
    } as EngineDiagnosticReport;
    collect
      .mockReturnValueOnce(pending)
      .mockResolvedValueOnce({ success: true, report: nextReport });
    const view = render(<EngineDiagnosticsModal key={props.status.diagnosticId} {...props} />);
    await waitFor(() => expect(collect).toHaveBeenCalledOnce());
    const oldQuery = collect.mock.calls[0][0];

    view.rerender(
      <EngineDiagnosticsModal
        key={nextId}
        {...props}
        status={{ ...props.status, diagnosticId: nextId }}
      />,
    );
    expect(cancel).toHaveBeenCalledWith(oldQuery);
    await act(async () => {});
    expect(collect).toHaveBeenCalledOnce();

    // Even a successful late response belongs only to the unmounted modal.
    await act(async () => finish({ success: true, report }));
    expect(await screen.findByText('engineDiagnosticsCause_config')).toBeTruthy();
    expect(screen.queryByText('engineDiagnosticsCause_port')).toBeNull();
    expect(collect).toHaveBeenCalledTimes(2);
    expect(collect.mock.calls[1][0].diagnosticId).toBe(nextId);
    expect(collect.mock.calls[1][0].requestId).not.toBe(oldQuery.requestId);
  });

  it('retains the failure summary when collection fails and can collect again', async () => {
    collect.mockRejectedValueOnce(new Error('Read failed'));
    render(<EngineDiagnosticsModal {...props} />);
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getByText('Startup timed out')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'engineDiagnosticsRefresh' }));
    expect(await screen.findByText('engineDiagnosticsCause_port')).toBeTruthy();
    expect(collect).toHaveBeenCalledTimes(2);
  });

  it('reports copy failure and supports closing with Escape', async () => {
    clipboard.mockRejectedValueOnce(new Error('denied'));
    render(<EngineDiagnosticsModal {...props} />);
    await screen.findByText('engineDiagnosticsCause_port');
    fireEvent.click(screen.getByRole('button', { name: 'engineDiagnosticsCopy' }));
    expect(await screen.findByText('engineDiagnosticsCopyFailed')).toBeTruthy();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(props.onClose).toHaveBeenCalledOnce();
  });
});
