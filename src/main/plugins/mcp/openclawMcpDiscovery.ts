import fs from 'fs';
import JSON5 from 'json5';

import { isValidMcpRequestTimeoutSeconds } from '../../../shared/openclaw/mcp';
import type { McpServerFormData, McpStore } from './mcpStore';

type DiscoveryStore = Pick<McpStore, 'listServers' | 'createDiscoveredServer'>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const stringRecord = (value: unknown): Record<string, string> | undefined => {
  if (!isRecord(value)) return undefined;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, String(item)]),
  );
};

const parseServer = (
  name: string,
  raw: Record<string, unknown>,
): (McpServerFormData & { enabled: boolean }) | null => {
  const command = typeof raw.command === 'string' && raw.command.trim() ? raw.command : undefined;
  const url = typeof raw.url === 'string' && raw.url.trim() ? raw.url : undefined;
  if (!command && !url) return null;

  const timeoutSeconds =
    typeof raw.requestTimeoutMs === 'number' &&
    Number.isInteger(raw.requestTimeoutMs / 1_000) &&
    isValidMcpRequestTimeoutSeconds(raw.requestTimeoutMs / 1_000)
      ? raw.requestTimeoutMs / 1_000
      : undefined;
  const transportType = command ? 'stdio' : raw.transport === 'sse' ? 'sse' : 'http';
  return {
    name,
    description: '',
    enabled: raw.enabled !== false,
    transportType,
    command,
    args: Array.isArray(raw.args)
      ? raw.args.filter((item): item is string => typeof item === 'string')
      : undefined,
    env: stringRecord(raw.env),
    url,
    headers: stringRecord(raw.headers),
    requestTimeoutSeconds: timeoutSeconds,
    openClawConfig: { ...raw },
  };
};

export const discoverOpenClawManagedMcpServers = (
  configPath: string,
  store: DiscoveryStore,
): number => {
  if (!fs.existsSync(configPath)) return 0;
  const parsed = JSON5.parse(fs.readFileSync(configPath, 'utf8')) as unknown;
  if (!isRecord(parsed) || !isRecord(parsed.mcp) || !isRecord(parsed.mcp.servers)) return 0;

  const knownNames = new Set(store.listServers().map(server => server.name));
  let discovered = 0;
  for (const [name, raw] of Object.entries(parsed.mcp.servers)) {
    if (!name.trim() || knownNames.has(name) || !isRecord(raw)) continue;
    const server = parseServer(name, raw);
    if (!server) continue;
    if (store.createDiscoveredServer(server)) {
      knownNames.add(name);
      discovered += 1;
    }
  }
  return discovered;
};
