import path from 'node:path';

import { app, BrowserWindow, dialog, ipcMain, type IpcMainInvokeEvent } from 'electron';

import {
  type DiagnosticFailure,
  type DiagnosticQuery,
  SessionDiagnosticsIpc,
} from '../../../shared/cowork/diagnostics/sessionDiagnostics';
import { PRODUCT_NAME } from '../../../shared/productMetadata';
import { getLanguage, t } from '../../core/i18n';
import { buildDiagnosticArchive, writeDiagnosticArchive } from '../../cowork/diagnostics/exporter';
import {
  DiagnosticServiceError,
  type SessionDiagnosticsService,
} from '../../cowork/diagnostics/service';

export function registerSessionDiagnosticsHandlers(
  getService: () => SessionDiagnosticsService,
): void {
  const exporting = new Set<number>();
  const collecting = new Map<number, { snapshotId: string; controller: AbortController }>();
  const windowFor = (event: IpcMainInvokeEvent) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (
      !window ||
      window.isDestroyed() ||
      event.sender.isDestroyed() ||
      event.sender.getType() !== 'window' ||
      event.senderFrame !== event.sender.mainFrame
    ) {
      throw new DiagnosticServiceError('invalid');
    }
    return window;
  };
  const failure = (error: unknown): DiagnosticFailure => ({
    success: false,
    reason: error instanceof DiagnosticServiceError ? error.reason : 'unavailable',
  });
  ipcMain.handle(
    SessionDiagnosticsIpc.List,
    (event, query: { sessionId: string; cursor?: string }) => {
      try {
        windowFor(event);
        return { success: true, ...getService().list(query) };
      } catch (error) {
        return failure(error);
      }
    },
  );
  ipcMain.handle(SessionDiagnosticsIpc.Read, (event, query: DiagnosticQuery) => {
    try {
      windowFor(event);
      return { success: true, report: getService().read(query, event.sender.id) };
    } catch (error) {
      return failure(error);
    }
  });
  ipcMain.handle(
    SessionDiagnosticsIpc.Refresh,
    async (event, query: DiagnosticQuery & { snapshotId: string }) => {
      try {
        windowFor(event);
        const report = await getService().refresh(query, event.sender.id);
        windowFor(event);
        return { success: true, report };
      } catch (error) {
        return failure(error);
      }
    },
  );
  ipcMain.handle(
    SessionDiagnosticsIpc.Cancel,
    (event, query: DiagnosticQuery & { snapshotId: string }) => {
      try {
        windowFor(event);
        const job = collecting.get(event.sender.id);
        if (job && typeof query?.snapshotId === 'string' && job.snapshotId === query.snapshotId)
          job.controller.abort();
        return { success: true };
      } catch (error) {
        return failure(error);
      }
    },
  );
  ipcMain.handle(
    SessionDiagnosticsIpc.Collect,
    async (event, query: DiagnosticQuery & { snapshotId: string }) => {
      let controller: AbortController | undefined;
      const destroyed = () => controller?.abort();
      try {
        windowFor(event);
        if (collecting.has(event.sender.id)) throw new DiagnosticServiceError('busy');
        controller = new AbortController();
        collecting.set(event.sender.id, { snapshotId: query?.snapshotId, controller });
        event.sender.once('destroyed', destroyed);
        let lastProgress = 0;
        const report = await getService().collect(query, event.sender.id, {
          signal: controller.signal,
          onProgress: progress => {
            if (Date.now() - lastProgress < 100 || event.sender.isDestroyed()) return;
            lastProgress = Date.now();
            event.sender.send(SessionDiagnosticsIpc.Progress, progress);
          },
        });
        windowFor(event);
        return { success: true, report };
      } catch (error) {
        return failure(error);
      } finally {
        if (controller) {
          event.sender.removeListener('destroyed', destroyed);
          collecting.delete(event.sender.id);
        }
      }
    },
  );
  ipcMain.handle(
    SessionDiagnosticsIpc.Export,
    async (event, query: DiagnosticQuery & { snapshotId: string }) => {
      const owner = event.sender.id;
      let acquired = false;
      let exportController: AbortController | undefined;
      const destroyed = () => exportController?.abort();
      try {
        const window = windowFor(event);
        if (exporting.has(owner)) throw new DiagnosticServiceError('busy');
        const service = getService();
        service.snapshot(query, owner);
        exporting.add(owner);
        acquired = true;
        const result = await dialog.showSaveDialog(window, {
          title: t('sessionDiagnosticsExport'),
          defaultPath: path.join(
            app.getPath('downloads'),
            `${PRODUCT_NAME}-diagnostics-${Date.now()}.zip`,
          ),
          filters: [{ name: 'ZIP', extensions: ['zip'] }],
        });
        if (result.canceled || !result.filePath) return { success: true, canceled: true };
        const destination = result.filePath.toLowerCase().endsWith('.zip')
          ? result.filePath
          : `${result.filePath}.zip`;
        // Appending an extension changes the selected destination; never silently overwrite it.
        if (destination !== result.filePath) {
          const fs = await import('node:fs/promises');
          try {
            await fs.access(destination);
            return { success: false, reason: 'export_failed' };
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          }
        }
        const assertCurrent = () => {
          windowFor(event);
          service.snapshot(query, owner);
        };
        assertCurrent();
        exportController = new AbortController();
        event.sender.once('destroyed', destroyed);
        const collected = await service.exportLogs(query, owner, exportController.signal);
        const assertExportCurrent = () => {
          windowFor(event);
          service.snapshot({ ...query, snapshotId: collected.report.snapshotId }, owner);
        };
        assertExportCurrent();
        await writeDiagnosticArchive(
          destination,
          buildDiagnosticArchive(collected.report, app.getVersion(), getLanguage(), collected.logs),
          assertExportCurrent,
        );
        return { success: true, canceled: false, path: destination };
      } catch (error) {
        return error instanceof DiagnosticServiceError
          ? failure(error)
          : { success: false, reason: 'export_failed' };
      } finally {
        if (exportController) event.sender.removeListener('destroyed', destroyed);
        if (acquired) exporting.delete(owner);
      }
    },
  );
}
