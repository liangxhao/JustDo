import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { open, rename, rm } from 'node:fs/promises';
import path from 'node:path';

import { type BrowserWindow, dialog, type WebFrameMain } from 'electron';

import type { McpServerFormData } from '../../../shared/plugins/mcp';
import {
  isMcpTransferName,
  MCP_TRANSFER_MAX_BYTES,
  MCP_TRANSFER_MAX_ROWS,
  type McpExportPreview,
  type McpExportSaveReceipt,
  type McpImportFormat,
  type McpImportPreview,
  type McpTransferResult,
} from '../../../shared/plugins/mcpTransfer';
import {
  type ParsedMcpImportRow,
  parseMcpImport,
  serializeMcpExport,
  toMcpExportRow,
} from '../../../shared/plugins/mcpTransferFormat';
import type { McpServerRecord } from './mcpStore';

const PREVIEW_LIFETIME_MS = 10 * 60 * 1000;
const JSON_FILTER = { name: 'JSON', extensions: ['json', 'jsonc'] };

export type McpTransferOwner = {
  window: BrowserWindow;
  frame: WebFrameMain;
  isCurrent: () => boolean;
};

type Preview<T> = {
  owner: McpTransferOwner;
  token: string;
  value: T;
  expiresAt: number;
};

type ImportPreview = {
  format: McpImportFormat;
  sourceLabel?: string;
  rows: ParsedMcpImportRow[];
};

type PlannedServer = {
  index: number;
  config: McpServerFormData;
  missingCredentials?: string[];
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

async function readImportFile(filePath: string): Promise<McpTransferResult<string>> {
  const file = await open(filePath, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
  try {
    const stat = await file.stat();
    if (!stat.isFile()) return { success: false, code: 'read-failed' };
    if (stat.size > MCP_TRANSFER_MAX_BYTES) return { success: false, code: 'too-large' };

    const buffer = Buffer.allocUnsafe(MCP_TRANSFER_MAX_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > MCP_TRANSFER_MAX_BYTES) return { success: false, code: 'too-large' };
    const text = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length));
    return { success: true, value: text };
  } finally {
    await file.close();
  }
}

async function writeExportFile(filePath: string, json: string): Promise<void> {
  const temporary = path.join(path.dirname(filePath), `.mcp-export-${randomUUID()}.tmp`);
  const file = await open(temporary, 'wx', 0o600);
  try {
    try {
      await file.writeFile(json, 'utf8');
    } finally {
      await file.close();
    }
    await rename(temporary, filePath);
  } catch (error) {
    await rm(temporary, { force: true }).catch((): void => undefined);
    throw error;
  }
}

function canUse<T>(preview: Preview<T>, owner: McpTransferOwner, token: unknown): boolean {
  return (
    preview.owner.window === owner.window &&
    preview.owner.frame === owner.frame &&
    preview.token === token &&
    preview.expiresAt > Date.now() &&
    owner.isCurrent()
  );
}

export class McpTransferService {
  private importPreview?: Preview<ImportPreview>;
  private exportPreview?: Preview<{ json: string; count: number }>;
  private importRequest?: object;
  private exportSaving = false;
  private importExpiry?: ReturnType<typeof setTimeout>;
  private exportExpiry?: ReturnType<typeof setTimeout>;

  invalidatePreviews(): void {
    this.importRequest = undefined;
    this.importPreview = undefined;
    this.exportPreview = undefined;
    clearTimeout(this.importExpiry);
    clearTimeout(this.exportExpiry);
  }

  private describeImport(
    preview: Preview<ImportPreview>,
    names: ReadonlySet<string>,
    conflicts: ReadonlySet<number> = new Set(),
  ): McpImportPreview {
    return {
      token: preview.token,
      format: preview.value.format,
      sourceLabel: preview.value.sourceLabel,
      rows: preview.value.rows.map(row => ({
        ...row.preview,
        ...(row.config && (names.has(row.preview.name) || conflicts.has(row.preview.index))
          ? { conflict: true as const }
          : {}),
      })),
    };
  }

  async previewImport(
    owner: McpTransferOwner,
    source: unknown,
    readNames: () => Promise<ReadonlySet<string>>,
  ): Promise<McpTransferResult<McpImportPreview>> {
    if (!isRecord(source) || (source.kind !== 'file' && source.kind !== 'text')) {
      return { success: false, code: 'invalid' };
    }
    this.importPreview = undefined;
    clearTimeout(this.importExpiry);
    const request = {};
    this.importRequest = request;
    let text: unknown;
    let sourceLabel: string | undefined;
    if (source.kind === 'file') {
      try {
        const selected = await dialog.showOpenDialog(owner.window, {
          properties: ['openFile'],
          filters: [JSON_FILTER],
        });
        const filePath = selected.filePaths[0];
        if (selected.canceled || !filePath) return { success: false, code: 'cancelled' };
        if (!owner.isCurrent() || this.importRequest !== request) {
          return { success: false, code: 'expired' };
        }
        const result = await readImportFile(filePath);
        if (result.success === false) return result;
        text = result.value;
        sourceLabel = path.basename(filePath);
      } catch {
        return { success: false, code: 'read-failed' };
      }
    } else {
      text = source.text;
    }
    if (typeof text !== 'string') return { success: false, code: 'invalid' };
    if (Buffer.byteLength(text, 'utf8') > MCP_TRANSFER_MAX_BYTES) {
      return { success: false, code: 'too-large' };
    }
    const parsed = parseMcpImport(text);
    if (parsed.success === false) return parsed;
    let names: ReadonlySet<string>;
    try {
      names = await readNames();
    } catch {
      return { success: false, code: 'unavailable' };
    }
    if (!owner.isCurrent() || this.importRequest !== request) {
      return { success: false, code: 'expired' };
    }
    const preview = {
      owner,
      token: randomUUID(),
      value: { ...parsed.value, sourceLabel },
      expiresAt: Date.now() + PREVIEW_LIFETIME_MS,
    };
    this.importPreview = preview;
    this.importExpiry = setTimeout(() => {
      if (this.importPreview === preview) this.importPreview = undefined;
    }, PREVIEW_LIFETIME_MS);
    this.importExpiry.unref();
    return { success: true, value: this.describeImport(preview, names) };
  }

  async planImport(
    owner: McpTransferOwner,
    input: unknown,
    readNames: () => Promise<ReadonlySet<string>>,
  ): Promise<McpTransferResult<{ servers: PlannedServer[]; skipped: number }>> {
    if (!isRecord(input) || typeof input.token !== 'string' || !Array.isArray(input.selection)) {
      return { success: false, code: 'invalid' };
    }
    const preview = this.importPreview;
    if (!preview || !canUse(preview, owner, input.token)) {
      return { success: false, code: 'expired' };
    }
    if (!input.selection.length || input.selection.length > preview.value.rows.length) {
      return { success: false, code: 'invalid' };
    }
    const indices = new Set<number>();
    const selectedNames = new Set<string>();
    const servers: PlannedServer[] = [];
    for (const selection of input.selection) {
      if (
        !isRecord(selection) ||
        typeof selection.index !== 'number' ||
        !Number.isSafeInteger(selection.index) ||
        indices.has(selection.index)
      ) {
        return { success: false, code: 'invalid' };
      }
      const row = preview.value.rows[selection.index];
      if (!row?.config || row.preview.issue) return { success: false, code: 'invalid' };
      const name = selection.name === undefined ? row.config.name : selection.name;
      const choice = selection.transportType;
      if (
        !isMcpTransferName(name) ||
        selectedNames.has(name) ||
        (choice !== undefined && choice !== 'http' && choice !== 'sse') ||
        (choice !== undefined &&
          row.config.transportType !== undefined &&
          choice !== row.config.transportType)
      ) {
        return { success: false, code: 'invalid' };
      }
      const selectedTransport = choice === 'http' || choice === 'sse' ? choice : undefined;
      const transportType = row.config.transportType ?? selectedTransport;
      if (!transportType) return { success: false, code: 'invalid' };
      indices.add(selection.index);
      selectedNames.add(name);
      servers.push({
        index: selection.index,
        config: { ...row.config, name, transportType },
        missingCredentials: row.preview.missingCredentials,
      });
    }
    let names: ReadonlySet<string>;
    try {
      names = await readNames();
    } catch {
      return { success: false, code: 'unavailable' };
    }
    if (this.importPreview !== preview || !canUse(preview, owner, input.token)) {
      return { success: false, code: 'expired' };
    }
    const conflictingIndices = servers
      .filter(server => names.has(server.config.name))
      .map(server => server.index);
    if (conflictingIndices.length) {
      return {
        success: false,
        code: 'conflict',
        preview: this.describeImport(preview, names, new Set(conflictingIndices)),
        conflictingIndices,
      };
    }
    this.importPreview = undefined;
    clearTimeout(this.importExpiry);
    return {
      success: true,
      value: { servers, skipped: preview.value.rows.length - servers.length },
    };
  }

  previewExport(
    owner: McpTransferOwner,
    input: unknown,
    servers: readonly McpServerRecord[],
  ): McpTransferResult<McpExportPreview> {
    this.exportPreview = undefined;
    clearTimeout(this.exportExpiry);
    if (!isRecord(input)) return { success: false, code: 'invalid' };
    const { ids, includeEnvValues, includeHeaderValues } = input;
    if (
      (includeEnvValues !== undefined && typeof includeEnvValues !== 'boolean') ||
      (includeHeaderValues !== undefined && typeof includeHeaderValues !== 'boolean')
    ) {
      return { success: false, code: 'invalid' };
    }
    if (Array.isArray(ids) && ids.length > MCP_TRANSFER_MAX_ROWS) {
      return { success: false, code: 'too-large' };
    }
    if (
      !Array.isArray(ids) ||
      !ids.length ||
      ids.length > servers.length ||
      ids.some(id => typeof id !== 'string') ||
      new Set(ids).size !== ids.length
    ) {
      return { success: false, code: 'invalid' };
    }
    const serversById = new Map(servers.map(server => [server.id, server]));
    const selected: McpServerRecord[] = [];
    for (const id of ids) {
      const server = serversById.get(id);
      if (!server || toMcpExportRow(server).issue) return { success: false, code: 'invalid' };
      selected.push(server);
    }
    const options = {
      includeEnvValues: includeEnvValues === true,
      includeHeaderValues: includeHeaderValues === true,
    };
    const json = serializeMcpExport(selected, options);
    if (Buffer.byteLength(json, 'utf8') > MCP_TRANSFER_MAX_BYTES) {
      return { success: false, code: 'too-large' };
    }
    const preview = {
      owner,
      token: randomUUID(),
      value: { json, count: selected.length },
      expiresAt: Date.now() + PREVIEW_LIFETIME_MS,
    };
    this.exportPreview = preview;
    this.exportExpiry = setTimeout(() => {
      if (this.exportPreview === preview) this.exportPreview = undefined;
    }, PREVIEW_LIFETIME_MS);
    this.exportExpiry.unref();
    return {
      success: true,
      value: {
        token: preview.token,
        json:
          options.includeEnvValues || options.includeHeaderValues
            ? serializeMcpExport(selected, options, true)
            : json,
      },
    };
  }

  async saveExport(
    owner: McpTransferOwner,
    token: unknown,
  ): Promise<McpTransferResult<McpExportSaveReceipt>> {
    if (typeof token !== 'string') return { success: false, code: 'invalid' };
    const preview = this.exportPreview;
    if (!preview || !canUse(preview, owner, token)) return { success: false, code: 'expired' };
    if (this.exportSaving) return { success: false, code: 'unavailable' };
    this.exportSaving = true;
    try {
      const result = await dialog.showSaveDialog(owner.window, {
        defaultPath: 'mcp.json',
        filters: [{ name: 'JSON', extensions: ['json'] }],
      });
      if (result.canceled || !result.filePath) return { success: false, code: 'cancelled' };
      if (this.exportPreview !== preview || !canUse(preview, owner, token)) {
        return { success: false, code: 'expired' };
      }
      await writeExportFile(result.filePath, preview.value.json);
      if (this.exportPreview === preview) {
        this.exportPreview = undefined;
        clearTimeout(this.exportExpiry);
      }
      return { success: true, value: { filePath: result.filePath, count: preview.value.count } };
    } catch {
      return { success: false, code: 'write-failed' };
    } finally {
      this.exportSaving = false;
    }
  }
}
