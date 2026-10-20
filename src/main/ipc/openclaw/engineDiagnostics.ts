import { BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron';

import {
  type EngineDiagnosticReport,
  type EngineDiagnosticResult,
  EngineDiagnosticsIpc,
  type EngineDiagnosticsQuery,
} from '../../../shared/openclaw/engineDiagnostics';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function registerEngineDiagnosticsHandlers(deps: {
  getMainWindow: () => BrowserWindow | null;
  getDiagnosticId: () => string;
  collect: (signal: AbortSignal) => Promise<EngineDiagnosticReport>;
}) {
  const jobs = new Map<number, {
    requestId: string;
    controller: AbortController;
    settled: Promise<void>;
  }>();
  const valid = (event: IpcMainInvokeEvent, input: unknown): input is EngineDiagnosticsQuery => {
    const window = deps.getMainWindow();
    if (
      !window ||
      window.isDestroyed() ||
      event.sender.isDestroyed() ||
      BrowserWindow.fromWebContents(event.sender) !== window ||
      event.sender !== window.webContents ||
      event.senderFrame !== event.sender.mainFrame
    )
      return false;
    if (!input || typeof input !== 'object' || Array.isArray(input)) return false;
    const query = input as Record<string, unknown>;
    return (
      Object.keys(query).every(key => ['requestId', 'diagnosticId'].includes(key)) &&
      typeof query.requestId === 'string' &&
      UUID.test(query.requestId) &&
      (query.diagnosticId === undefined ||
        (typeof query.diagnosticId === 'string' && UUID.test(query.diagnosticId)))
    );
  };
  ipcMain.handle(EngineDiagnosticsIpc.Cancel, (event, query: unknown): EngineDiagnosticResult => {
    if (!valid(event, query)) return { success: false, reason: 'invalid' };
    const job = jobs.get(event.sender.id);
    if (job?.requestId === query.requestId) job.controller.abort();
    return { success: false, reason: 'canceled' };
  });
  ipcMain.handle(
    EngineDiagnosticsIpc.Collect,
    async (event, query: unknown): Promise<EngineDiagnosticResult> => {
      if (!valid(event, query)) return { success: false, reason: 'invalid' };
      if (query.diagnosticId && query.diagnosticId !== deps.getDiagnosticId())
        return { success: false, reason: 'stale' };
      const previous = jobs.get(event.sender.id);
      if (previous && !previous.controller.signal.aborted)
        return { success: false, reason: 'busy' };
      const settlement = Promise.withResolvers<void>();
      const job = {
        requestId: query.requestId,
        controller: new AbortController(),
        settled: settlement.promise,
      };
      // Reserve the next slot before awaiting cleanup, including across Renderer
      // reloads. Other requests must not race to launch after the same old job.
      jobs.set(event.sender.id, job);
      const cancel = () => job.controller.abort();
      event.sender.once('destroyed', cancel);
      event.sender.once('render-process-gone', cancel);
      event.sender.once('will-navigate', cancel);
      try {
        if (previous) await previous.settled;
        if (job.controller.signal.aborted) return { success: false, reason: 'canceled' };
        if (!valid(event, query)) return { success: false, reason: 'invalid' };
        if (query.diagnosticId && query.diagnosticId !== deps.getDiagnosticId())
          return { success: false, reason: 'stale' };
        const report = await deps.collect(job.controller.signal);
        if (job.controller.signal.aborted) return { success: false, reason: 'canceled' };
        if (!valid(event, query)) return { success: false, reason: 'invalid' };
        return { success: true, report };
      } catch {
        return {
          success: false,
          reason: job.controller.signal.aborted ? 'canceled' : 'unavailable',
        };
      } finally {
        job.controller.abort();
        if (jobs.get(event.sender.id) === job) jobs.delete(event.sender.id);
        event.sender.removeListener('destroyed', cancel);
        event.sender.removeListener('render-process-gone', cancel);
        event.sender.removeListener('will-navigate', cancel);
        settlement.resolve();
      }
    },
  );
}
