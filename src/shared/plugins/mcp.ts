export const DEFAULT_MCP_REQUEST_TIMEOUT_SECONDS = 60;
export const MCP_NAME_CONFLICT_ERROR = 'mcpNameExists';

export const ExtensionMcpIpc = {
  SetEnabled: 'mcp:extension:setEnabled',
  ReadSettings: 'mcp:extension:readSettings',
} as const;

export type ExtensionMcpEnabledInput = { id: string; enabled: boolean };
export type ExtensionMcpSettingsSnapshot = {
  server: ExtensionProvidedMcpServer;
  revision: string;
  /** Complete selected connection, redacted by native configuration helpers. */
  definition: Record<string, unknown> | null;
  /** Scoped Gateway config.get value, with native redaction placeholders preserved. */
  override: Record<string, unknown> | null;
};
export type ExtensionMcpSettingsResult =
  | { success: true; value: ExtensionMcpSettingsSnapshot }
  | { success: false; code: ExtensionMcpMutationError };
export type ExtensionMcpMutationError =
  'invalid' | 'forbidden' | 'conflict' | 'unavailable' | 'apply-failed' | 'unknown';
export type ExtensionMcpMutationResult =
  | { success: true; extensionServers: ExtensionProvidedMcpServer[] }
  | { success: false; code: ExtensionMcpMutationError };

export const MCP_REQUEST_TIMEOUT_LIMITS = {
  min: 1,
  max: 24 * 60 * 60,
} as const;

export const isValidMcpRequestTimeoutSeconds = (value: unknown): value is number =>
  Number.isInteger(value) &&
  Number(value) >= MCP_REQUEST_TIMEOUT_LIMITS.min &&
  Number(value) <= MCP_REQUEST_TIMEOUT_LIMITS.max;

export type ExtensionProvidedMcpServer = {
  id: string;
  name: string;
  providerId: string;
  providerName: string;
  providerDescription: string;
  enabled: boolean;
  supported: boolean;
  /** Reviewed bundled declaration. Live tool metadata supersedes this hint after a probe. */
  supportsApps?: boolean;
  /** Native ownership and transport admission; Main also checks application protection. */
  toggleable?: boolean;
  configurable?: boolean;
  transportType?: 'stdio' | 'sse' | 'http';
  /** Native redacted launch summary; never contains environment or headers. */
  connectionSummary?: string;
  connectionTimeoutMs?: number;
  requestTimeoutMs?: number;
  scope?: PluginHubScope;
  management?: PluginManagementCapabilities;
};
import type { PluginHubScope, PluginManagementCapabilities } from './management';
