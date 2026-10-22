import type { IpcMainInvokeEvent } from 'electron';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { SessionDiagnosticsIpc } from '../../../shared/cowork/diagnostics/sessionDiagnostics';
import {
  DiagnosticServiceError,
  type SessionDiagnosticsService,
} from '../../cowork/diagnostics/service';
import { registerSessionDiagnosticsHandlers } from './sessionDiagnostics';

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  window: { isDestroyed: vi.fn(() => false) },
  save: vi.fn(),
  write: vi.fn(),
  archive: vi.fn(() => ({})),
}));
vi.mock('electron', () => ({
  app: { getPath: () => 'C:/downloads', getVersion: () => '2026.8.27' },
  BrowserWindow: { fromWebContents: () => mocks.window },
  dialog: { showSaveDialog: mocks.save },
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) =>
      mocks.handlers.set(channel, handler),
  },
}));
vi.mock('../../core/i18n', () => ({ t: (key: string) => key, getLanguage: () => 'en' }));
vi.mock('../../../shared/productMetadata', () => ({ PRODUCT_NAME: 'ExampleProduct' }));
vi.mock('../../cowork/diagnostics/exporter', () => ({
  buildDiagnosticArchive: mocks.archive,
  writeDiagnosticArchive: mocks.write,
}));

describe('diagnostics IPC', () => {
  const query = { sessionId: 'session', snapshotId: 'snapshot' };
  let event: IpcMainInvokeEvent;
  let service: {
    list: ReturnType<typeof vi.fn>;
    read: ReturnType<typeof vi.fn>;
    refresh: ReturnType<typeof vi.fn>;
    collect: ReturnType<typeof vi.fn>;
    snapshot: ReturnType<typeof vi.fn>;
    exportLogs: ReturnType<typeof vi.fn>;
  };
  const invoke = (channel: string, input: unknown = query) =>
    mocks.handlers.get(channel)!(event, input);
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.handlers.clear();
    mocks.window.isDestroyed.mockReturnValue(false);
    mocks.save.mockResolvedValue({ canceled: true });
    mocks.write.mockResolvedValue(undefined);
    const mainFrame = {};
    event = {
      sender: {
        once: vi.fn(),
        removeListener: vi.fn(),
        send: vi.fn(),
        id: 42,
        isDestroyed: () => false,
        getType: () => 'window',
        mainFrame,
      },
      senderFrame: mainFrame,
    } as unknown as IpcMainInvokeEvent;
    service = {
      list: vi.fn(() => ({ runs: [] })),
      read: vi.fn(() => ({})),
      refresh: vi.fn().mockResolvedValue({}),
      collect: vi.fn().mockResolvedValue({}),
      snapshot: vi.fn(() => ({})),
      exportLogs: vi.fn().mockResolvedValue({
        report: { snapshotId: 'export-snapshot' },
        logs: { entries: {}, coverage: [] },
      }),
    };
    registerSessionDiagnosticsHandlers(() => service as unknown as SessionDiagnosticsService);
  });

  it('rejects subframes before accessing the service', () => {
    event = { ...event, senderFrame: {} } as IpcMainInvokeEvent;
    expect(invoke(SessionDiagnosticsIpc.Read)).toEqual({ success: false, reason: 'invalid' });
    expect(service.read).not.toHaveBeenCalled();
  });

  it('uses the configured productName as the archive filename prefix', async () => {
    await invoke(SessionDiagnosticsIpc.Export);
    expect(mocks.save).toHaveBeenCalledWith(
      mocks.window,
      expect.objectContaining({
        defaultPath: expect.stringMatching(/ExampleProduct-diagnostics-\d+\.zip$/),
      }),
    );
  });

  it('collects under the trusted window owner and rejects a window closed during collection', async () => {
    expect(await invoke(SessionDiagnosticsIpc.Collect)).toEqual({ success: true, report: {} });
    expect(service.collect).toHaveBeenCalledWith(
      query,
      42,
      expect.objectContaining({
        signal: expect.any(AbortSignal),
        onProgress: expect.any(Function),
      }),
    );
    service.collect.mockImplementation(async () => {
      mocks.window.isDestroyed.mockReturnValue(true);
      return {};
    });
    expect(await invoke(SessionDiagnosticsIpc.Collect)).toEqual({
      success: false,
      reason: 'invalid',
    });
  });

  it('isolates cancellation by owner and snapshot and sends progress only to the requesting window', async () => {
    let finish!: (value: unknown) => void;
    let signal!: AbortSignal;
    let publish!: () => void;
    service.collect.mockImplementation((_query, _owner, options) => {
      signal = options.signal;
      publish = () =>
        options.onHistory({ snapshotId: 'snapshot', history: { status: 'scanned', failures: [] } });
      publish();
      options.onProgress({
        snapshotId: 'snapshot',
        source: 'main',
        filesCompleted: 1,
        bytesRead: 1024,
        fileBytesRead: 1024,
        fileBytesTotal: 1024,
      });
      return new Promise(resolve => {
        finish = resolve;
      });
    });
    const pending = invoke(SessionDiagnosticsIpc.Collect);
    expect(event.sender.send).toHaveBeenCalledWith(
      SessionDiagnosticsIpc.History,
      expect.objectContaining({ snapshotId: 'snapshot' }),
    );
    expect(event.sender.send).toHaveBeenCalledWith(
      SessionDiagnosticsIpc.Progress,
      expect.objectContaining({ snapshotId: 'snapshot', bytesRead: 1024 }),
    );
    await invoke(SessionDiagnosticsIpc.Cancel, { ...query, snapshotId: 'other' });
    expect(signal.aborted).toBe(false);
    const original = event;
    event = { ...event, sender: { ...event.sender, id: 99 } } as IpcMainInvokeEvent;
    await invoke(SessionDiagnosticsIpc.Cancel);
    expect(signal.aborted).toBe(false);
    event = original;
    await invoke(SessionDiagnosticsIpc.Cancel);
    expect(signal.aborted).toBe(true);
    vi.mocked(event.sender.send).mockClear();
    publish();
    expect(event.sender.send).not.toHaveBeenCalled();
    finish({});
    await pending;
  });

  it('preserves invalid-query errors and passes the trusted window id as snapshot owner', () => {
    service.read.mockImplementation(() => {
      throw new DiagnosticServiceError('invalid');
    });
    expect(invoke(SessionDiagnosticsIpc.Read, null)).toEqual({ success: false, reason: 'invalid' });
    expect(service.read).toHaveBeenCalledWith(null, 42);
  });

  it('treats save cancellation as success without writing and releases the busy guard', async () => {
    expect(await invoke(SessionDiagnosticsIpc.Export)).toEqual({ success: true, canceled: true });
    expect(service.snapshot).toHaveBeenCalledWith(query, 42);
    expect(mocks.write).not.toHaveBeenCalled();
    expect(await invoke(SessionDiagnosticsIpc.Export)).toEqual({ success: true, canceled: true });
  });

  it('rejects concurrent exports without releasing the first export guard', async () => {
    let finish!: (value: unknown) => void;
    mocks.save.mockReturnValue(
      new Promise(resolve => {
        finish = resolve;
      }),
    );
    const first = invoke(SessionDiagnosticsIpc.Export);
    expect(await invoke(SessionDiagnosticsIpc.Export)).toEqual({ success: false, reason: 'busy' });
    expect(await invoke(SessionDiagnosticsIpc.Export)).toEqual({ success: false, reason: 'busy' });
    finish({ canceled: true });
    await first;
    mocks.save.mockResolvedValue({ canceled: true });
    expect(await invoke(SessionDiagnosticsIpc.Export)).toEqual({ success: true, canceled: true });
  });

  it('honors cancellation while the save dialog is open without collecting old log text', async () => {
    let select!: (value: unknown) => void;
    mocks.save.mockReturnValue(
      new Promise(resolve => {
        select = resolve;
      }),
    );
    const pending = invoke(SessionDiagnosticsIpc.Export);
    await invoke(SessionDiagnosticsIpc.Cancel);
    select({ canceled: false, filePath: 'C:/downloads/test.zip' });
    expect(await pending).toEqual({ success: true, canceled: true });
    expect(service.exportLogs).not.toHaveBeenCalled();
    expect(mocks.write).not.toHaveBeenCalled();
  });

  it('exports freshly collected log text only after the user selects a destination', async () => {
    await invoke(SessionDiagnosticsIpc.Export);
    expect(service.exportLogs).not.toHaveBeenCalled();
    mocks.save.mockResolvedValue({ canceled: false, filePath: 'C:/downloads/test.zip' });
    expect(await invoke(SessionDiagnosticsIpc.Export)).toMatchObject({
      success: true,
      canceled: false,
    });
    expect(service.exportLogs).toHaveBeenCalledWith(query, 42, expect.any(AbortSignal), {
      onProgress: expect.any(Function),
    });
    expect(mocks.archive).toHaveBeenCalledWith(
      { snapshotId: 'export-snapshot' },
      '2026.8.27',
      'en',
      { entries: {}, coverage: [] },
    );
    expect(service.snapshot).toHaveBeenCalledWith({ ...query, snapshotId: 'export-snapshot' }, 42);
  });

  it('reports write failure without retaining the busy guard', async () => {
    mocks.save.mockResolvedValue({ canceled: false, filePath: 'C:/downloads/test.zip' });
    mocks.write.mockRejectedValue(new Error('disk full'));
    expect(await invoke(SessionDiagnosticsIpc.Export)).toEqual({
      success: false,
      reason: 'export_failed',
    });
    mocks.save.mockResolvedValue({ canceled: true });
    expect(await invoke(SessionDiagnosticsIpc.Export)).toEqual({ success: true, canceled: true });
  });

  it('reports actual exported counts and read gaps without returning log text', async () => {
    mocks.save.mockResolvedValue({ canceled: false, filePath: 'C:/downloads/test.zip' });
    service.exportLogs.mockResolvedValue({
      report: {
        snapshotId: 'export-snapshot',
        collectedAt: 10,
        logs: {
          collectedAt: 20,
          sources: [
            { source: 'native', status: 'unavailable', reasons: ['native_unavailable'] },
            {
              source: 'main',
              status: 'partial',
              scanComplete: true,
              parseFailures: 2,
              reasons: ['malformed'],
            },
            {
              source: 'gateway',
              status: 'partial',
              scanComplete: true,
              parseFailures: 0,
              reasons: ['output_limit'],
            },
          ],
        },
      },
      logs: {
        entries: { 'logs/main.log': 'private task text' },
        coverage: [
          { source: 'main', records: 12, omitted: 3 },
          { source: 'gateway', records: 8, omitted: 0 },
        ],
      },
    });
    const result = await invoke(SessionDiagnosticsIpc.Export);
    expect(result).toMatchObject({
      success: true,
      canceled: false,
      summary: {
        collectedAt: 20,
        logRecords: 20,
        omittedLogRecords: 3,
        unavailableSources: ['native'],
        partialSources: ['main'],
      },
    });
    expect(JSON.stringify(result)).not.toContain('private task text');
  });

  it('allows only the matching owner and query to cancel export collection', async () => {
    mocks.save.mockResolvedValue({ canceled: false, filePath: 'C:/downloads/test.zip' });
    let finish!: (value: unknown) => void;
    let signal!: AbortSignal;
    let publish!: () => void;
    service.exportLogs.mockImplementation((_query, _owner, currentSignal, options) => {
      signal = currentSignal;
      publish = () =>
        options.onProgress({ snapshotId: 'snapshot', source: 'main', bytesRead: 1024 });
      publish();
      return new Promise(resolve => {
        finish = resolve;
      });
    });
    const pending = invoke(SessionDiagnosticsIpc.Export);
    await vi.waitFor(() => expect(service.exportLogs).toHaveBeenCalled());
    expect(event.sender.send).toHaveBeenCalledWith(
      SessionDiagnosticsIpc.Progress,
      expect.objectContaining({ snapshotId: 'snapshot' }),
    );
    expect(await invoke(SessionDiagnosticsIpc.Collect)).toMatchObject({
      success: false,
      reason: 'busy',
    });
    await invoke(SessionDiagnosticsIpc.Cancel, { ...query, sessionId: 'other' });
    expect(signal.aborted).toBe(false);
    await invoke(SessionDiagnosticsIpc.Cancel, { ...query, snapshotId: 'other' });
    expect(signal.aborted).toBe(false);
    const original = event;
    event = { ...event, sender: { ...event.sender, id: 99 } } as IpcMainInvokeEvent;
    await invoke(SessionDiagnosticsIpc.Cancel);
    expect(signal.aborted).toBe(false);
    event = original;
    await invoke(SessionDiagnosticsIpc.Cancel);
    expect(signal.aborted).toBe(true);
    vi.mocked(event.sender.send).mockClear();
    publish();
    expect(event.sender.send).not.toHaveBeenCalled();
    finish({ report: {}, logs: {} });
    expect(await pending).toEqual({ success: true, canceled: true });
    expect(mocks.write).not.toHaveBeenCalled();
    mocks.save.mockResolvedValue({ canceled: true });
    expect(await invoke(SessionDiagnosticsIpc.Export)).toEqual({ success: true, canceled: true });
  });

  it('revalidates the snapshot after save selection before writing', async () => {
    mocks.save.mockResolvedValue({ canceled: false, filePath: 'C:/downloads/test.zip' });
    service.snapshot
      .mockImplementationOnce(() => ({}))
      .mockImplementation(() => {
        throw new DiagnosticServiceError('expired');
      });
    expect(await invoke(SessionDiagnosticsIpc.Export)).toEqual({
      success: false,
      reason: 'expired',
    });
    expect(mocks.write).not.toHaveBeenCalled();
  });
});
