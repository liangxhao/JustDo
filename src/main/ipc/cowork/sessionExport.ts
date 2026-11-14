import path from 'node:path';

import { app, dialog, ipcMain, type IpcMainInvokeEvent } from 'electron';

import {
  buildSessionExportFileName,
  CoworkSessionExportFailure,
  type CoworkSessionExportInput,
  CoworkSessionExportIpc,
  type CoworkSessionExportResult,
} from '../../../shared/cowork/sessionExport';
import { buildCoworkSessionKey } from '../../../shared/cowork/sessionKey';
import { t } from '../../core/i18n';
import { getWorkspaceDialogOwner } from '../../core/window/workspaceWindowManager';
import { writeSessionExportFile } from '../../cowork/sessions/sessionExportFile';
import {
  readSessionExportHistory,
  SessionExportHistoryError,
} from '../../cowork/sessions/sessionExportHistory';
import type { CoworkSession } from '../../data/coworkStore';
import type { OpenClawRuntimeAdapter } from '../../engine';

type Dependencies = {
  isAllowedSender: (event: IpcMainInvokeEvent) => boolean;
  getSession: (sessionId: string) => CoworkSession | undefined | null;
  getRuntime: () => Pick<OpenClawRuntimeAdapter, 'getGatewayClient' | 'getGatewayClientGeneration' | 'getAutomaticErrorRetryActivity'> | null;
  isExternalSessionExecuting: (sessionId: string) => boolean;
};

function parseInput(value: unknown): CoworkSessionExportInput | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const { sessionId, includeRawData } = value as Partial<CoworkSessionExportInput>;
  if (
    typeof sessionId === 'string' && sessionId && sessionId.length <= 512 &&
    sessionId === sessionId.trim() && typeof includeRawData === 'boolean'
  ) {
    return { sessionId, includeRawData };
  }
}

function getBinding(session: CoworkSession) {
  const keys = new Set([
    session.nativeSessionKey,
    session.external?.sessionKey,
    session.historyBinding?.sessionKey,
  ].filter(Boolean));
  if (keys.size > 1) return;
  const [savedKey] = keys;
  const sessionKey = savedKey ||
    (!session.external && buildCoworkSessionKey(session.id, session.agentId || undefined));
  if (sessionKey) return { sessionKey, nativeSessionId: session.historyBinding?.nativeSessionId };
}

export function registerCoworkSessionExport({
  isAllowedSender,
  getSession,
  getRuntime,
  isExternalSessionExecuting,
}: Dependencies): void {
  const exporting = new Set<number>();
  ipcMain.handle(CoworkSessionExportIpc.Export, async (event, value: unknown): Promise<CoworkSessionExportResult> => {
    const input = parseInput(value);
    const { sender } = event;
    if (!input || !isAllowedSender(event) || exporting.has(sender.id))
      return { success: false, reason: CoworkSessionExportFailure.Unavailable };

    const controller = new AbortController();
    const destroyed = () => controller.abort();
    exporting.add(sender.id);
    sender.once('destroyed', destroyed);
    try {
      const session = getSession(input.sessionId);
      const binding = session && getBinding(session);
      const runtime = getRuntime();
      const client = runtime?.getGatewayClient();
      if (!session || !binding || !runtime || !client)
        return { success: false, reason: CoworkSessionExportFailure.Unavailable };
      const generation = runtime.getGatewayClientGeneration();
      const assertCurrent = () => {
        controller.signal.throwIfAborted();
        const current = getSession(input.sessionId);
        const currentBinding = current && getBinding(current);
        if (!isAllowedSender(event) || currentBinding?.sessionKey !== binding.sessionKey ||
          currentBinding.nativeSessionId !== binding.nativeSessionId || getRuntime() !== runtime ||
          runtime.getGatewayClient() !== client || runtime.getGatewayClientGeneration() !== generation)
          throw new SessionExportHistoryError('history_changed');
        if (runtime.getAutomaticErrorRetryActivity().sessionIds.includes(session.id) ||
          isExternalSessionExecuting(session.id))
          throw new SessionExportHistoryError('running');
      };
      assertCurrent();
      const owner = getWorkspaceDialogOwner(sender);
      const options = {
        title: t('sessionExportMain'),
        defaultPath: path.join(app.getPath('downloads'), buildSessionExportFileName(session.title)),
        filters: [{ name: 'JSON', extensions: ['json'] }],
      };
      const result = owner
        ? await dialog.showSaveDialog(owner, options)
        : await dialog.showSaveDialog(options);
      if (result.canceled || !result.filePath || controller.signal.aborted)
        return { success: true, canceled: true };

      await writeSessionExportFile({
        destination: result.filePath,
        document: {
          session,
          sessionKey: binding.sessionKey,
          includeRawData: input.includeRawData,
          model: session.modelRef,
        },
        readHistory: onPage => readSessionExportHistory({
          ...binding,
          signal: controller.signal,
          onPage,
          request: async (method, params) => {
            assertCurrent();
            let response;
            try {
              response = await client.request<unknown>(method, params, {
                timeoutMs: 30_000,
                signal: controller.signal,
              });
            } catch (error) {
              assertCurrent();
              throw error;
            }
            assertCurrent();
            return response;
          },
        }),
        assertCurrent,
        signal: controller.signal,
      });
      return { success: true, canceled: false };
    } catch (error) {
      if (controller.signal.aborted) return { success: true, canceled: true };
      if (error instanceof SessionExportHistoryError) {
        const reason = error.reason === 'history_changed' ? CoworkSessionExportFailure.Changed
          : error.reason === 'running' ? CoworkSessionExportFailure.Running : CoworkSessionExportFailure.Unavailable;
        return { success: false, reason };
      }
      return { success: false, reason: CoworkSessionExportFailure.Failed };
    } finally {
      sender.removeListener('destroyed', destroyed);
      exporting.delete(sender.id);
    }
  });
}
