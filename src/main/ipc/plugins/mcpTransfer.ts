import { type BrowserWindow, ipcMain, type IpcMainInvokeEvent, type WebContents } from 'electron';

import {
  type McpImportCommitReceipt,
  McpTransferIpc,
  type McpTransferResult,
} from '../../../shared/plugins/mcpTransfer';
import { toMcpExportRow } from '../../../shared/plugins/mcpTransferFormat';
import type { PluginOperationContext } from '../../../shared/plugins/pluginOperation';
import type { McpServerRecord } from '../../plugins/mcp';
import { type McpTransferOwner, McpTransferService } from '../../plugins/mcp/mcpTransferService';

interface TransferDependencies {
  getMainWindow: () => BrowserWindow | null;
  readNames: () => Promise<ReadonlySet<string>>;
  readServers: () => Promise<McpServerRecord[]>;
  commit: (
    event: IpcMainInvokeEvent,
    owner: McpTransferOwner,
    input: unknown,
    context?: PluginOperationContext,
  ) => Promise<McpTransferResult<McpImportCommitReceipt>>;
  service: McpTransferService;
}

export function registerMcpTransferHandlers(deps: TransferDependencies): void {
  const contentsGeneration = new WeakMap<WebContents, number>();
  const getOwner = (event: IpcMainInvokeEvent): McpTransferOwner | undefined => {
    const window = deps.getMainWindow();
    const frame = event.senderFrame;
    const sender = event.sender;
    if (!window || !frame) return undefined;
    const isMainFrame = () =>
      window === deps.getMainWindow() &&
      !window.isDestroyed() &&
      !sender.isDestroyed() &&
      window.webContents === sender &&
      sender.mainFrame === frame;
    if (!isMainFrame()) return undefined;
    if (!contentsGeneration.has(sender)) {
      contentsGeneration.set(sender, 0);
      const invalidate = () => {
        contentsGeneration.set(sender, (contentsGeneration.get(sender) ?? 0) + 1);
        if (deps.getMainWindow() === window) deps.service.invalidatePreviews();
      };
      sender.on('did-start-navigation', (_event, _url, inPlace, mainFrame) => {
        if (mainFrame && !inPlace) invalidate();
      });
      sender.on('render-process-gone', invalidate);
      sender.once('destroyed', invalidate);
    }
    const generation = contentsGeneration.get(sender);
    const isCurrent = () => isMainFrame() && contentsGeneration.get(sender) === generation;
    return { window, frame, isCurrent };
  };

  const register = <T>(
    channel: string,
    action: (
      owner: McpTransferOwner,
      event: IpcMainInvokeEvent,
      input: unknown,
      context?: PluginOperationContext,
    ) => Promise<McpTransferResult<T>>,
  ) => {
    ipcMain.handle(channel, async (event, input: unknown, context?: PluginOperationContext) => {
      try {
        const owner = getOwner(event);
        if (!owner) return { success: false, code: 'forbidden' };
        return await action(owner, event, input, context);
      } catch {
        return { success: false, code: 'unavailable' };
      }
    });
  };

  register(McpTransferIpc.PreviewImport, (owner, _event, input) =>
    deps.service.previewImport(owner, input, deps.readNames),
  );
  register(McpTransferIpc.CommitImport, (owner, event, input, context) =>
    deps.commit(event, owner, input, context),
  );
  register(McpTransferIpc.ListExport, async owner => {
    const servers = await deps.readServers();
    if (!owner.isCurrent()) return { success: false, code: 'expired' };
    return { success: true, value: servers.map(toMcpExportRow) };
  });
  register(McpTransferIpc.PreviewExport, async (owner, _event, input) => {
    const servers = await deps.readServers();
    if (!owner.isCurrent()) return { success: false, code: 'expired' };
    return deps.service.previewExport(owner, input, servers);
  });
  register(McpTransferIpc.SaveExport, (owner, _event, input) =>
    deps.service.saveExport(owner, input),
  );
}
