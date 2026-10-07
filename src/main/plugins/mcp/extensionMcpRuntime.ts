import { execFile } from 'child_process';
import { promisify } from 'util';

import type { OpenClawEngineManager } from '../../openclaw/runtime/openclawEngineManager';

const OUTPUT_PREFIX = 'JUSTDO_EXTENSION_MCP=';

// Use native metadata, ownership and transports without loading plugin entry modules.
export const EXTENSION_MCP_SCRIPT = String.raw`
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const dist = path.join(process.cwd(), 'dist');
const load = async (prefix, name) => {
  for (const file of fs.readdirSync(dist).filter(file => file.startsWith(prefix) && /\.m?js$/.test(file))) {
    const module = await import(pathToFileURL(path.join(dist, file)).href);
    const fn = Object.values(module).find(value => typeof value === 'function' && value.name === name);
    if (fn) return fn;
  }
  throw new Error('Native MCP export unavailable: ' + name);
};
const getConfig = await load('io.runtime-', 'getRuntimeConfig');
const resolveWorkspace = await load('control-plane-workspace-', 'resolvePluginControlPlaneWorkspace');
const loadRegistry = await load('manifest-registry-', 'loadPluginManifestRegistryCore');
const loadMcp = await load('bundle-mcp-', 'loadEnabledBundleMcpConfig');
const mergeMcp = await load('bundle-mcp-config-', 'loadMergedBundleMcpConfig');
const resolveTransport = await load('mcp-transport-config-', 'resolveMcpTransportConfig');
const redactError = await load('mcp-error-', 'redactMcpDiagnosticError');
const cfg = getConfig();
const { workspaceDir } = resolveWorkspace({ config: cfg });
const manifestRegistry = loadRegistry({ config: cfg, workspaceDir });
const bundle = loadMcp({ cfg, manifestRegistry, workspaceDir });
const loaded = mergeMcp({ cfg, manifestRegistry, workspaceDir });
const mode = process.env.JUSTDO_EXTENSION_MCP_MODE;
if (mode === 'list') {
  const inspectBundle = await load('bundle-mcp-', 'inspectBundleMcpRuntimeSupport');
  const inspectNative = await load('bundle-mcp-', 'inspectNativePluginMcpRuntimeSupport');
  const inventory = manifestRegistry.plugins.flatMap(plugin => {
    const support = plugin.format === 'bundle' && plugin.bundleFormat
      ? inspectBundle({ pluginId: plugin.id, rootDir: plugin.rootDir, bundleFormat: plugin.bundleFormat })
      : plugin.mcpServers ? inspectNative({ rootDir: plugin.rootDir, mcpServers: plugin.mcpServers }) : null;
    if (!support) return [];
    const stdio = new Set(support.stdioServerNames);
    return [{ plugin: { id: plugin.id, name: plugin.name, description: plugin.description,
      format: plugin.format, origin: plugin.origin },
      mcpServers: [...support.supportedServerNames, ...support.unsupportedServerNames].map(name => {
        const owned = bundle.pluginIdsByServer[name] === plugin.id;
        const effective = owned && Object.hasOwn(loaded.config.mcpServers, name);
        const transport = effective ? resolveTransport(name, loaded.config.mcpServers[name], { logWarnings: false }) : null;
        return { name, hasStdioTransport: stdio.has(name), unsupported: effective ? !transport : support.unsupportedServerNames.includes(name),
          enabled: effective && loaded.config.mcpServers[name]?.enabled !== false,
          transportType: transport?.transportType === 'streamable-http' ? 'http' : transport?.transportType,
          connectionSummary: transport?.description,
        };
      }) }];
  });
  process.stdout.write('${OUTPUT_PREFIX}' + JSON.stringify(inventory));
} else {
  const id = process.env.JUSTDO_EXTENSION_MCP_ID;
  const match = manifestRegistry.plugins.flatMap(plugin => Object.entries(bundle.pluginIdsByServer)
    .filter(([name, owner]) => owner === plugin.id && 'extension:' + owner + ':' + name === id)
    .map(([name]) => ({ name, plugin })))[0];
  if (!match || !Object.hasOwn(loaded.config.mcpServers, match.name) || loaded.config.mcpServers[match.name]?.enabled === false) throw new Error('Extension MCP server is unavailable or disabled');
  const { name } = match;
  if (!resolveTransport(name, loaded.config.mcpServers[name], { logWarnings: false })) throw new Error('Extension MCP transport is unsupported');
  const { createSessionMcpRuntime } = await import(pathToFileURL(path.join(dist, 'agents/agent-bundle-mcp-runtime.js')).href);
  const runtime = createSessionMcpRuntime({ sessionId: 'justdo-extension-mcp-probe', workspaceDir, cfg,
    loaded: { mcpServers: { [name]: { ...loaded.config.mcpServers[name], connectionTimeoutMs: 8000, requestTimeoutMs: 3000 } },
      diagnostics: [], prepareDataDirsByServer: loaded.prepareDataDirsByServer },
  });
  const startedAt = Date.now();
  // Retire the native runtime before the outer process timeout can interrupt cleanup.
  const deadline = setTimeout(() => { void runtime.dispose().catch(() => undefined); }, 15000);
  let result;
  try {
    const catalog = await runtime.getCatalog();
    const server = catalog.servers[name];
    if (!server) throw new Error(catalog.diagnostics?.[0]?.message || 'MCP connection failed');
    if (mode === 'read') result = await runtime.readResource(name, process.env.JUSTDO_EXTENSION_MCP_URI);
    else {
      const resources = server.resources ? await runtime.listResources(name) : [];
      const prompts = server.prompts ? await runtime.listPrompts(name) : [];
      result = { available: true, latencyMs: Date.now() - startedAt,
        tools: catalog.tools.filter(tool => tool.serverName === name).map(tool => ({
          name: tool.toolName, title: tool.title, description: tool.description,
          inputSchema: tool.inputSchema, outputSchema: tool.outputSchema,
        })), resources, prompts,
        capabilities: { tools: Boolean(server.tools), resources: Boolean(server.resources), prompts: Boolean(server.prompts) },
      };
    }
  } catch (error) {
    if (mode === 'read') throw error;
    result = { available: false, tools: [], resources: [], prompts: [], latencyMs: Date.now() - startedAt, error: redactError(error) };
  } finally {
    clearTimeout(deadline);
    await runtime.dispose();
    await runtime.joinCleanup?.();
  }
  process.stdout.write('${OUTPUT_PREFIX}' + JSON.stringify(result));
}
`;

const execFileAsync = promisify(execFile);
export type ExtensionMcpCommandRunner = (
  executable: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
) => Promise<{ stdout: string }>;

const runCommand: ExtensionMcpCommandRunner = async (executable, args, options) => {
  try {
    const result = await execFileAsync(executable, args, {
      ...options,
      encoding: 'utf8',
      maxBuffer: 4_000_000,
      timeout: 30_000,
      windowsHide: true,
    });
    return { stdout: result.stdout };
  } catch {
    // Child process errors include its environment and stderr; never expose credentials.
    throw new Error('Native extension MCP operation failed');
  }
};

export const runExtensionMcpOperation = async <T>(
  manager: OpenClawEngineManager,
  mode: 'list' | 'probe' | 'read',
  id = '',
  uri = '',
  runner: ExtensionMcpCommandRunner = runCommand,
): Promise<T> => {
  const cli = await manager.buildCliEnvironment();
  const result = await runner(
    cli.env.JUSTDO_ELECTRON_PATH?.trim() || process.execPath,
    ['--input-type=module', '-e', EXTENSION_MCP_SCRIPT],
    {
      cwd: cli.runtimeRoot,
      env: {
        ...cli.env,
        ELECTRON_RUN_AS_NODE: '1',
        JUSTDO_EXTENSION_MCP_MODE: mode,
        JUSTDO_EXTENSION_MCP_ID: id,
        JUSTDO_EXTENSION_MCP_URI: uri,
      },
    },
  );
  const offset = result.stdout.lastIndexOf(OUTPUT_PREFIX);
  if (offset < 0) throw new Error('Native extension MCP returned no result');
  return JSON.parse(result.stdout.slice(offset + OUTPUT_PREFIX.length)) as T;
};
