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
    service.collect.mockImplementation((_query, _owner, options) => {
      signal = options.signal;
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

  it('exports freshly collected log text only after the user selects a destination', async () => {
    await invoke(SessionDiagnosticsIpc.Export);
    expect(service.exportLogs).not.toHaveBeenCalled();
    mocks.save.mockResolvedValue({ canceled: false, filePath: 'C:/downloads/test.zip' });
    expect(await invoke(SessionDiagnosticsIpc.Export)).toMatchObject({
      success: true,
      canceled: false,
    });
    expect(service.exportLogs).toHaveBeenCalledWith(query, 42, expect.any(AbortSignal));
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
