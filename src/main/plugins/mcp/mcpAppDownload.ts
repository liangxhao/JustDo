import { writeFile } from 'node:fs/promises';
import path from 'node:path';

import { dialog, type IpcMainInvokeEvent } from 'electron';

import {
  MCP_APP_DOWNLOAD_MAX_BYTES,
  type McpAppDownloadInput,
  validMcpAppDownloadBase64,
  validMcpAppDownloadName,
} from '../../../shared/plugins/mcpAppDownload';
import { getWorkspaceDialogOwner } from '../../core/window/workspaceWindowManager';

export function decodeMcpAppDownload(input: unknown): {
  fileName: string;
  mimeType: string;
  data: Buffer;
  cwd?: string;
} {
  const value = input as Partial<McpAppDownloadInput> | null;
  if (
    !value ||
    !validMcpAppDownloadName(value.fileName, value.mimeType) ||
    !validMcpAppDownloadBase64(value.dataBase64) ||
    (value.cwd !== undefined &&
      (typeof value.cwd !== 'string' ||
        value.cwd.length > 4096 ||
        value.cwd.includes('\0') ||
        !path.isAbsolute(value.cwd)))
  )
    throw new Error('Invalid App download');
  const data = Buffer.from(value.dataBase64, 'base64');
  if (!data.length || data.byteLength > MCP_APP_DOWNLOAD_MAX_BYTES)
    throw new Error('Invalid App download size');
  return { fileName: value.fileName!, mimeType: value.mimeType!, data, cwd: value.cwd };
}

/** Every write requires a native, owner-bound Save dialog; the App cannot choose a path. */
export async function saveMcpAppDownload(
  event: IpcMainInvokeEvent,
  input: unknown,
): Promise<{ canceled: boolean }> {
  const { fileName, data, cwd } = decodeMcpAppDownload(input);
  const owner = getWorkspaceDialogOwner(event.sender);
  if (!owner || owner.isDestroyed()) throw new Error('App window is unavailable');
  const extension = fileName.split('.').pop()!;
  const result = await dialog.showSaveDialog(owner, {
    defaultPath: cwd ? path.join(cwd, fileName) : fileName,
    filters: [{ name: extension.toUpperCase(), extensions: [extension] }],
  });
  if (result.canceled || !result.filePath) return { canceled: true };
  await writeFile(result.filePath, data);
  return { canceled: false };
}
