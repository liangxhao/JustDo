import { execFile } from 'child_process';
import { promisify } from 'util';

import type { ExtensionProvidedMcpServer } from '../../../shared/openclaw/mcp';
import type { OpenClawEngineManager } from '../../openclaw/runtime/openclawEngineManager';

const DISCOVERY_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_CHARS = 4_000_000;

type CommandResult = {
  stdout: string;
};

type PluginInspectEntry = {
  plugin?: {
    id?: unknown;
    name?: unknown;
    description?: unknown;
    enabled?: unknown;
    status?: unknown;
    format?: unknown;
  };
  mcpServers?: unknown;
};

type RunCommand = (
  executable: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
) => Promise<CommandResult>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const execFileAsync = promisify(execFile);

const runCommand: RunCommand = async (executable, args, options) => {
  const result = await execFileAsync(executable, args, {
    ...options,
    encoding: 'utf8',
    maxBuffer: MAX_OUTPUT_CHARS,
    timeout: DISCOVERY_TIMEOUT_MS,
    windowsHide: true,
  });
  return { stdout: result.stdout };
};

export const parseExtensionMcpInventory = (value: unknown): ExtensionProvidedMcpServer[] => {
  if (!Array.isArray(value)) return [];

  return value.flatMap(rawEntry => {
    if (!isRecord(rawEntry)) return [];
    const entry = rawEntry as PluginInspectEntry;
    const plugin = entry.plugin;
    if (
      !plugin ||
      plugin.format !== 'bundle' ||
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
          enabled: plugin.enabled === true && plugin.status !== 'error',
          supported: rawServer.hasStdioTransport !== false,
        },
      ];
    });
  });
};

export const discoverExtensionMcpServers = async (
  manager: OpenClawEngineManager,
  commandRunner: RunCommand = runCommand,
): Promise<ExtensionProvidedMcpServer[]> => {
  const cli = await manager.buildCliEnvironment();
  const electronNodeRuntime = cli.env.JUSTDO_ELECTRON_PATH?.trim() || process.execPath;
  const result = await commandRunner(
    electronNodeRuntime,
    [cli.openclawEntry, 'plugins', 'inspect', '--all', '--json'],
    {
      cwd: cli.runtimeRoot,
      env: { ...cli.env, ELECTRON_RUN_AS_NODE: '1' },
    },
  );
  return parseExtensionMcpInventory(JSON.parse(result.stdout) as unknown);
};
