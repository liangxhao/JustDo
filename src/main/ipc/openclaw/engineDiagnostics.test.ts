import { EventEmitter } from 'node:events';

import type { BrowserWindow, IpcMainInvokeEvent } from 'electron';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  type EngineDiagnosticReport,
  EngineDiagnosticsIpc,
} from '../../../shared/openclaw/engineDiagnostics';
import { registerEngineDiagnosticsHandlers } from './engineDiagnostics';

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  owner: null as unknown,
}));
vi.mock('electron', () => ({
  BrowserWindow: { fromWebContents: () => mocks.owner },
  ipcMain: {
    handle: (name: string, handler: (...args: unknown[]) => unknown) =>
      mocks.handlers.set(name, handler),
  },
}));

describe('engine diagnostics IPC', () => {
  const query = {
    requestId: 'bdb2f8dd-3ceb-481b-a9fc-d2e7085c05cb',
    diagnosticId: 'e05834ef-8035-45cc-a3f8-545ee4a75e30',
  };
  let event: IpcMainInvokeEvent;
  let sender: EventEmitter;
  let collect: ReturnType<typeof vi.fn>;
  let diagnosticId: string;
  const invoke = (channel = EngineDiagnosticsIpc.Collect, input: unknown = query) =>
    mocks.handlers.get(channel)!(event, input);
  beforeEach(() => {
    mocks.handlers.clear();
    sender = new EventEmitter();
    Object.assign(sender, { id: 8, isDestroyed: () => false, mainFrame: {} });
    const window = { isDestroyed: () => false, webContents: sender } as unknown as BrowserWindow;
    mocks.owner = window;
    event = {
      sender,
      senderFrame: (sender as unknown as { mainFrame: unknown }).mainFrame,
    } as IpcMainInvokeEvent;
    collect = vi.fn().mockResolvedValue({ context: { id: query.diagnosticId } });
    diagnosticId = query.diagnosticId;
    registerEngineDiagnosticsHandlers({
      getMainWindow: () => window,
      getDiagnosticId: () => diagnosticId,
      collect,
    });
  });

  it('rejects subframes before reading any files', async () => {
    event = { ...event, senderFrame: {} } as IpcMainInvokeEvent;
    expect(await invoke()).toEqual({ success: false, reason: 'invalid' });
    expect(collect).not.toHaveBeenCalled();
  });
  it('rejects other windows and arbitrary file path parameters', async () => {
    expect(await invoke(undefined, { ...query, path: 'C:/private.log' })).toEqual({
      success: false,
      reason: 'invalid',
    });
    mocks.owner = {};
    expect(await invoke()).toEqual({ success: false, reason: 'invalid' });
    expect(collect).not.toHaveBeenCalled();
  });
  it('rejects a stale failure identity before starting collection', async () => {
    expect(await invoke(undefined, { ...query, diagnosticId: query.requestId })).toEqual({
      success: false,
      reason: 'stale',
    });
    expect(collect).not.toHaveBeenCalled();
  });
  it('returns the collected snapshot', async () => {
    expect(await invoke()).toMatchObject({
      success: true,
      report: { context: { id: query.diagnosticId } },
    });
    expect(collect).toHaveBeenCalledOnce();
  });
  it('limits concurrent work, cancels only the matching request and discards canceled results', async () => {
    const pending = Promise.withResolvers<EngineDiagnosticReport>();
    collect.mockReturnValue(pending.promise);
    const first = invoke();
    expect(await invoke()).toEqual({ success: false, reason: 'busy' });
    await invoke(EngineDiagnosticsIpc.Cancel, { ...query, requestId: query.diagnosticId });
    expect(collect.mock.calls[0][0].aborted).toBe(false);
    await invoke(EngineDiagnosticsIpc.Cancel);
    expect(collect.mock.calls[0][0].aborted).toBe(true);
    pending.resolve({} as EngineDiagnosticReport);
    expect(await first).toEqual({ success: false, reason: 'canceled' });
    expect(sender.listenerCount('destroyed')).toBe(0);
  });
  it('waits for canceled cleanup across Renderer reloads and reserves only one successor', async () => {
    const pending = Promise.withResolvers<EngineDiagnosticReport>();
    collect.mockReturnValueOnce(pending.promise);
    const first = invoke();
    sender.emit('will-navigate');
    const nextQuery = { ...query, requestId: query.diagnosticId };
    const next = invoke(undefined, nextQuery);
    expect(collect).toHaveBeenCalledOnce();
    expect(await invoke()).toEqual({ success: false, reason: 'busy' });

    pending.resolve({} as EngineDiagnosticReport);
    expect(await first).toMatchObject({ reason: 'canceled' });
    expect(await next).toMatchObject({ success: true });
    expect(collect).toHaveBeenCalledTimes(2);
    expect(sender.listenerCount('will-navigate')).toBe(0);
  });
  it.each(['stale', 'frame', 'window', 'navigation', 'cancel'] as const)(
    'revalidates a successor after canceled cleanup: %s',
    async change => {
      const pending = Promise.withResolvers<EngineDiagnosticReport>();
      collect.mockReturnValueOnce(pending.promise);
      const first = invoke();
      await invoke(EngineDiagnosticsIpc.Cancel);
      const nextQuery = { ...query, requestId: query.diagnosticId };
      const next = invoke(undefined, nextQuery);
      if (change === 'stale') diagnosticId = query.requestId;
      if (change === 'frame') Object.assign(sender, { mainFrame: {} });
      if (change === 'window') mocks.owner = {};
      if (change === 'navigation') sender.emit('will-navigate');
      if (change === 'cancel') await invoke(EngineDiagnosticsIpc.Cancel, nextQuery);

      pending.resolve({} as EngineDiagnosticReport);
      expect(await first).toMatchObject({ reason: 'canceled' });
      expect(await next).toEqual({
        success: false,
        reason: change === 'stale' ? 'stale' :
          change === 'navigation' || change === 'cancel' ? 'canceled' : 'invalid',
      });
      expect(collect).toHaveBeenCalledOnce();
      expect(sender.listenerCount('will-navigate')).toBe(0);
    },
  );
  it('preserves cleanup ordering through a canceled queued successor', async () => {
    const pending = Promise.withResolvers<EngineDiagnosticReport>();
    collect.mockReturnValueOnce(pending.promise);
    const first = invoke();
    await invoke(EngineDiagnosticsIpc.Cancel);
    const nextQuery = { ...query, requestId: query.diagnosticId };
    const next = invoke(undefined, nextQuery);
    await invoke(EngineDiagnosticsIpc.Cancel, nextQuery);
    const third = invoke();
    expect(collect).toHaveBeenCalledOnce();

    pending.resolve({} as EngineDiagnosticReport);
    expect(await first).toMatchObject({ reason: 'canceled' });
    expect(await next).toMatchObject({ reason: 'canceled' });
    expect(await third).toMatchObject({ success: true });
    expect(collect).toHaveBeenCalledTimes(2);
  });
  it.each(['destroyed', 'render-process-gone', 'will-navigate'])(
    'cancels when the owning document emits %s',
    async eventName => {
      const pending = Promise.withResolvers<EngineDiagnosticReport>();
      collect.mockReturnValue(pending.promise);
      const first = invoke();
      sender.emit(eventName);
      expect(collect.mock.calls[0][0].aborted).toBe(true);
      pending.resolve({} as EngineDiagnosticReport);
      expect(await first).toMatchObject({ reason: 'canceled' });
    },
  );
});
