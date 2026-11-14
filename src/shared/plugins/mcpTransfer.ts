import type { McpServerConfig, McpTransportType } from './mcp';
import type { PluginOperationFeedback } from './pluginOperation';

export const McpTransferIpc = {
  PreviewImport: 'mcp:transfer:previewImport',
  CommitImport: 'mcp:transfer:commitImport',
  ListExport: 'mcp:transfer:listExport',
  PreviewExport: 'mcp:transfer:previewExport',
  SaveExport: 'mcp:transfer:saveExport',
} as const;

export const MCP_TRANSFER_MAX_BYTES = 1024 * 1024;
export const MCP_TRANSFER_MAX_ROWS = 500;

export type McpTransferError =
  | 'cancelled'
  | 'invalid'
  | 'unsupported-format'
  | 'empty'
  | 'too-large'
  | 'read-failed'
  | 'expired'
  | 'conflict'
  | 'unavailable'
  | 'apply-failed'
  | 'write-failed'
  | 'forbidden';

export type McpImportRowIssue =
  | 'invalid-name'
  | 'duplicate-name'
  | 'invalid-config'
  | 'invalid-transport'
  | 'missing-command'
  | 'invalid-url'
  | 'invalid-arguments'
  | 'invalid-credentials'
  | 'unsupported-fields';

export type McpExportRowIssue = 'unsupported-fields' | 'invalid-config' | 'sensitive-connection';
export type McpImportFormat = 'mcpServers' | 'servers';
export type McpImportSource = { kind: 'file' } | { kind: 'text'; text: string };

export interface McpImportPreviewRow {
  index: number;
  name: string;
  description?: string;
  /** An otherwise valid row without a type requires an explicit HTTP/SSE choice. */
  transportType?: McpTransportType;
  connectionSummary?: string;
  missingCredentials?: string[];
  issue?: McpImportRowIssue;
  conflict?: true;
}

export interface McpImportPreview {
  token: string;
  sourceLabel?: string;
  format: McpImportFormat;
  rows: McpImportPreviewRow[];
}

export interface McpImportSelection {
  index: number;
  name?: string;
  transportType?: 'http' | 'sse';
}

export interface McpImportCommitInput {
  token: string;
  selection: McpImportSelection[];
}

export interface McpImportCommitReceipt {
  imported: { id: string; name: string; missingCredentials?: string[] }[];
  skipped: number;
  servers?: McpServerConfig[];
  refreshWarning?: true;
}

export interface McpExportRow {
  id: string;
  name: string;
  description?: string;
  transportType: McpTransportType;
  connectionSummary?: string;
  issue?: McpExportRowIssue;
}

export interface McpExportOptions {
  includeEnvValues?: boolean;
  includeHeaderValues?: boolean;
}

export interface McpExportPreviewInput extends McpExportOptions {
  ids: string[];
}

export interface McpExportPreview {
  token: string;
  /** Opted-in values are masked here. The token refers to the exact file to save. */
  json: string;
}

export interface McpExportSaveReceipt {
  filePath: string;
  count: number;
}

export type McpTransferResult<T> =
  | { success: true; value: T }
  | ({
      success: false;
      code: McpTransferError;
      preview?: McpImportPreview;
      conflictingIndices?: number[];
    } & PluginOperationFeedback);

const controls = /[\x00-\x1f\x7f]/u;

export function isMcpTransferName(name: unknown): name is string {
  return (
    typeof name === 'string' &&
    name.length > 0 &&
    name.trim() === name &&
    name !== '__proto__' &&
    !controls.test(name)
  );
}
