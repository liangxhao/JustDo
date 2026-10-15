import fs from 'fs';
import JSON5 from 'json5';

import { getExtensionManagement, PluginHubScope } from '../../../shared/plugins/management';
import type { ExtensionProvidedMcpServer } from '../../../shared/plugins/mcp';
import type { OpenClawEngineManager } from '../../openclaw/runtime/openclawEngineManager';
import { type ExtensionMcpCommandRunner, runExtensionMcpOperation } from './extensionMcpRuntime';

type PluginInspectEntry = {
  plugin?: {
    id?: unknown;
    name?: unknown;
    description?: unknown;
    enabled?: unknown;
    status?: unknown;
    format?: unknown;
    origin?: unknown;
  };
  mcpServers?: unknown;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

export const parseExtensionMcpInventory = (value: unknown): ExtensionProvidedMcpServer[] => {
  if (!Array.isArray(value)) return [];

  return value.flatMap(rawEntry => {
    if (!isRecord(rawEntry)) return [];
    const entry = rawEntry as PluginInspectEntry;
    const plugin = entry.plugin;
    if (
      !plugin ||
      (plugin.format !== 'bundle' && plugin.format !== 'openclaw') ||
      typeof plugin.id !== 'string' ||
      !plugin.id.trim() ||
      !Array.isArray(entry.mcpServers)
    ) {
      return [];
    }

    const providerId = plugin.id.trim();
    const providerName =
      typeof plugin.name === 'string' && plugin.name.trim() ? plugin.name.trim() : providerId;
    const providerDescription =
      typeof plugin.description === 'string' ? plugin.description.trim() : '';

    return entry.mcpServers.flatMap(rawServer => {
      if (!isRecord(rawServer) || typeof rawServer.name !== 'string' || !rawServer.name.trim()) {
        return [];
      }
      const name = rawServer.name.trim();
      return [
        {
          id: `extension:${providerId}:${name}`,
          name,
          providerId,
          providerName,
          providerDescription,
          enabled:
            typeof rawServer.enabled === 'boolean'
              ? rawServer.enabled
              : plugin.enabled === true && plugin.status !== 'error',
          // Native inspection supports both stdio and HTTP; only this flag means unsupported.
          supported: rawServer.unsupported !== true,
          ...(typeof rawServer.toggleable === 'boolean'
            ? { toggleable: rawServer.toggleable }
            : {}),
          ...(typeof rawServer.configurable === 'boolean'
            ? { configurable: rawServer.configurable }
            : {}),
          ...(['stdio', 'sse', 'http'].includes(String(rawServer.transportType))
            ? { transportType: rawServer.transportType as 'stdio' | 'sse' | 'http' }
            : {}),
          ...(typeof rawServer.connectionSummary === 'string'
            ? { connectionSummary: rawServer.connectionSummary }
            : {}),
          ...(typeof rawServer.connectionTimeoutMs === 'number' &&
          Number.isFinite(rawServer.connectionTimeoutMs)
            ? { connectionTimeoutMs: rawServer.connectionTimeoutMs }
            : {}),
          ...(typeof rawServer.requestTimeoutMs === 'number' &&
          Number.isFinite(rawServer.requestTimeoutMs)
            ? { requestTimeoutMs: rawServer.requestTimeoutMs }
            : {}),
          scope:
            typeof plugin.origin === 'string'
              ? getExtensionManagement({ origin: plugin.origin }).scope
              : PluginHubScope.EXTENSION,
        },
      ];
    });
  });
};

export const discoverExtensionMcpServers = async (
  manager: OpenClawEngineManager,
  commandRunner?: ExtensionMcpCommandRunner,
): Promise<ExtensionProvidedMcpServer[]> => {
  return parseExtensionMcpInventory(
    await runExtensionMcpOperation(manager, 'list', '', '', commandRunner),
  );
};

export const readNativeMcpServerNames = (configPath: string): ReadonlySet<string> => {
  if (!fs.existsSync(configPath)) return new Set();
  let config: unknown;
  try {
    config = JSON5.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (error) {
    // Preserve the existing configuration recovery path for syntactically damaged files.
    if (error instanceof SyntaxError) return new Set();
    throw new Error('Native MCP configuration could not be read for ownership discovery');
  }
  const servers =
    isRecord(config) && isRecord(config.mcp) && isRecord(config.mcp.servers)
      ? config.mcp.servers
      : {};
  return new Set(Object.keys(servers));
};

/** Only resolve extension ownership when native configuration has non-product entries to preserve. */
export const discoverExtensionMcpOverrideNames = async (
  manager: OpenClawEngineManager,
  userNames: ReadonlySet<string>,
  discover: typeof discoverExtensionMcpServers = discoverExtensionMcpServers,
): Promise<ReadonlySet<string>> => {
  const names = readNativeMcpServerNames(manager.getConfigPath());
  if (![...names].some(name => !userNames.has(name))) return new Set();
  return new Set((await discover(manager)).map(server => server.name));
};
