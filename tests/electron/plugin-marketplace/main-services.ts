import fs from 'node:fs';
import path from 'node:path';

import Database from 'better-sqlite3';
import { app, ipcMain } from 'electron';

import { ManagedDirectoryOperationCoordinator } from '../../../src/main/core/filesystem/managedDirectoryOperations';
import { registerExtensionHandlers } from '../../../src/main/ipc/plugins/extensions';
import { registerMarketplaceHandlers } from '../../../src/main/ipc/plugins/marketplace';
import { registerMcpHandlers } from '../../../src/main/ipc/plugins/mcp';
import { registerSkillHandlers } from '../../../src/main/ipc/plugins/skills';
import { buildOpenClawMcpServers } from '../../../src/main/openclaw/config/plugins/mcpProjection';
import { OpenClawExtensionImportService } from '../../../src/main/plugins/extensions/openclawExtensionImportService';
import { PluginInstallationService } from '../../../src/main/plugins/installation/pluginInstallationService';
import { createPluginMarketplaceService } from '../../../src/main/plugins/marketplace';
import { discoverExtensionMcpServers } from '../../../src/main/plugins/mcp/extensionMcpDiscovery';
import { runExtensionMcpOperation } from '../../../src/main/plugins/mcp/extensionMcpRuntime';
import { McpConfigSyncService } from '../../../src/main/plugins/mcp/mcpConfigSyncService';
import { McpStore } from '../../../src/main/plugins/mcp/mcpStore';
import { PluginManager } from '../../../src/main/plugins/pluginManager';
import { OpenClawSkillFileService } from '../../../src/main/plugins/skills/openclawSkillFileService';
import { isGatewaySkillEnabled,OpenClawSkillService } from '../../../src/main/plugins/skills/openclawSkillService';
import { ExtensionIpc } from '../../../src/shared/plugins/extensions';
import { MarketplaceIpc, type MarketplacePluginKind } from '../../../src/shared/plugins/marketplace';
import { PluginOperationIpc } from '../../../src/shared/plugins/pluginOperation';
import { LocalSpeechModelIpc } from '../../../src/shared/speech/localSpeechModels';
import { createLoopbackMarket, type MarketScenario } from './loopback-market';

// The native fixture is a test lifecycle adapter, not a replacement installer.
type NativeFixture = {
  manager: ConstructorParameters<typeof OpenClawExtensionImportService>[0]['getOpenClawEngineManager'] extends () => infer T ? T : never;
  gateway: {
    requestGateway<T>(method: string, params?: unknown, options?: { timeoutMs?: number }): Promise<T>;
  };
  connectedGateway: ConstructorParameters<typeof OpenClawSkillService>[1] extends (() => infer T) | undefined ? NonNullable<T> : never;
  applyConfigPatch(patch: Record<string, unknown>, options?: { replacePaths?: string[] }): Promise<unknown>;
  evidence: { gatewayPid?: number | null; brokerPid?: number | null };
};

export async function createProbeServices(options: {
  fixtureRoot: string;
  nodeExecutable: string;
  mcpServer: string;
  native: NativeFixture;
}) {
  const { native, fixtureRoot } = options;
  const market = await createLoopbackMarket(options);
  const db = new Database(path.join(fixtureRoot, 'plugin-fixture.sqlite'));
  // Only the product tables exercised here; no real profile, credentials or transcript.
  db.exec(`
    CREATE TABLE mcp_servers (
      id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, description TEXT NOT NULL DEFAULT '',
      enabled INTEGER NOT NULL DEFAULT 1, transport_type TEXT NOT NULL DEFAULT 'stdio',
      config_json TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE fixture_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);
  const store = new McpStore(db);
  const registryStore = {
    get<T>(key: string): T | undefined {
      const row = db.prepare('SELECT value FROM fixture_kv WHERE key = ?').get(key) as { value: string } | undefined;
      return row ? JSON.parse(row.value) as T : undefined;
    },
    set<T>(key: string, value: T) {
      db.prepare('INSERT INTO fixture_kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
        .run(key, JSON.stringify(value));
    },
  };
  const installationService = new PluginInstallationService();
  const manager = new PluginManager(createPluginMarketplaceService(installationService, () => registryStore, market.provider));
  const skillService = new OpenClawSkillService(() => native.gateway, () => native.connectedGateway);
  const skillFileService = new OpenClawSkillFileService({ getOpenClawEngineManager: () => native.manager });
  const extensionService = new OpenClawExtensionImportService({
    getOpenClawEngineManager: () => native.manager,
    requestGateway: (method, params, options) => {
      // The fixture is already connected. Keep Main's admission guard local and
      // pass only the remaining native request deadline across the broker IPC.
      options?.assertBeforeSend?.();
      return options?.timeoutMs !== undefined
        ? native.gateway.requestGateway(method, params, { timeoutMs: options.timeoutMs })
        : native.gateway.requestGateway(method, params);
    },
    getManagedPluginIds: () => [],
    restartGatewayAfterMutation: () => native.manager.restartGateway(),
    directoryOperations: new ManagedDirectoryOperationCoordinator({
      // Match the application's ownership classification, using only processes
      // created by this fixture. Native mutations retain their no-replay policy.
      ownsAppProcess: pid => pid === native.evidence.gatewayPid || pid === native.evidence.brokerPid ||
        app.getAppMetrics().some(metric => metric.pid === pid),
    }),
  });
  const syncNativeMcpConfig = async () => {
    const saved = JSON.parse(fs.readFileSync(native.manager.getConfigPath(), 'utf8'));
    const servers = buildOpenClawMcpServers(store.listServers(), 30, null);
    const retired = Object.keys(saved.mcp?.servers ?? {}).filter(name => !(name in servers));
    const replacePaths = retired.filter(name => Array.isArray(saved.mcp.servers[name]?.args))
      .map(name => `mcp.servers.${name}.args`);
    await native.applyConfigPatch({ mcp: { servers: {
      ...Object.fromEntries(retired.map((name): [string, null] => [name, null])), ...servers,
    } } }, { replacePaths });
    return { success: true, changed: true };
  };
  const mcpSync = new McpConfigSyncService({ getMcpStore: () => store, syncOpenClawConfig: syncNativeMcpConfig });
  let configTail = Promise.resolve();
  const runExclusive = <T>(operation: () => Promise<T>): Promise<T> => {
    const pending = configTail.then(operation);
    configTail = pending.then((): void => {}, (): void => {});
    return pending;
  };
  const installRequests: Record<string, number> = {};
  const results: Array<{ pluginId: string; result: unknown }> = [];
  const operationResults: Array<{ channel: string; request: unknown; result: unknown }> = [];
  const operationProgress: unknown[] = [];
  const extensionMutationChannels = new Set<string>([ExtensionIpc.Import, ExtensionIpc.SetEnabled, ExtensionIpc.Delete]);
  const observedWindows = new WeakSet<Electron.WebContents>();
  const originalHandle = ipcMain.handle.bind(ipcMain);
  // Observe real handler calls and results without replacing their implementation.
  ipcMain.handle = (channel, handler) => originalHandle(channel, async (event: Electron.IpcMainInvokeEvent, ...args: unknown[]) => {
    if (!observedWindows.has(event.sender)) {
      observedWindows.add(event.sender);
      const send = event.sender.send.bind(event.sender);
      event.sender.send = (name, ...payload) => {
        if (name === PluginOperationIpc.Progress) operationProgress.push(payload[0]);
        send(name, ...payload);
      };
    }
    if (extensionMutationChannels.has(channel)) {
      const result = await handler(event, ...args);
      operationResults.push({ channel, request: args[0], result });
      return result;
    }
    if (channel === MarketplaceIpc.Install) {
      const id = (args[0] as { pluginId: string }).pluginId;
      installRequests[id] = (installRequests[id] ?? 0) + 1;
      const result = await handler(event, ...args);
      results.push({ pluginId: id, result });
      return result;
    }
    return handler(event, ...args);
  });
  try {
    registerSkillHandlers({
      skillService, skillFileService, installationService,
      getOpenClawEngineManager: () => native.manager,
      onMarketplacePluginDeleted: (kind, id, installPath) => manager.forgetMarketplaceInstallation(kind, id, installPath),
    });
    registerExtensionHandlers({
      extensionImportService: extensionService, installationService,
      onMarketplacePluginDeleted: (kind, id) => manager.forgetMarketplaceInstallation(kind, id),
    });
    registerMcpHandlers({
      getStore: () => store, installationService,
      runConfigMutationExclusive: operation => runExclusive(() => operation((_retired, context) =>
        mcpSync.syncConfigAfterExclusiveMutation(syncNativeMcpConfig, context))),
      probeServer: id => runExtensionMcpOperation(native.manager, 'probe', id),
      readResource: (id, uri) => runExtensionMcpOperation(native.manager, 'read', id, uri),
      listExtensionServers: () => discoverExtensionMcpServers(native.manager),
      readExtensionDefinition: id => runExtensionMcpOperation(native.manager, 'settings', id),
      requestGateway: (method, params) => native.gateway.requestGateway(method, params),
      getManagedPluginIds: () => [],
      discoverExternalServers: () => {},
      onMarketplacePluginDeleted: (kind, id) => manager.forgetMarketplaceInstallation(kind, id),
    });
    registerMarketplaceHandlers(manager);
  } finally {
    ipcMain.handle = originalHandle;
  }
  const inventory = async (kind: MarketplacePluginKind) => {
    if (kind === 'skill') {
      const status = await skillService.getStatus(undefined, { connectedOnly: true });
      return status.skills.filter(entry => entry.source === 'openclaw-managed' && entry.name.startsWith('fixture-market-'))
        .map(entry => ({
          id: entry.skillKey, enabled: isGatewaySkillEnabled(entry), installPath: entry.baseDir,
          // Version comes from the installed fixture body, not the catalog or registry.
          version: fs.existsSync(entry.filePath)
            ? fs.readFileSync(entry.filePath, 'utf8').match(/Version ([\d.]+)\./)?.[1] : undefined,
        }));
    }
    if (kind === 'extension') {
      return (await extensionService.listCatalog()).filter(entry => entry.id.startsWith('fixture-market-'))
        .map(entry => ({ id: entry.id, enabled: entry.enabled, version: entry.version, installPath: entry.installPath }));
    }
    return store.listServers().map(entry => ({ id: entry.id, enabled: entry.enabled }));
  };
  ipcMain.handle('marketplace-probe:scenario', (_event, next: MarketScenario) => {
    market.setScenario(next);
    return { success: true };
  });
  ipcMain.handle('marketplace-probe:inventory', async (_event, kind: MarketplacePluginKind) => {
    if (market.scenario.failure === 'refresh') throw new Error('Fixture inventory temporarily unavailable');
    return { installed: await inventory(kind) };
  });
  let selectedInputs: string[] = [];
  ipcMain.handle('marketplace-probe:queue-inputs', (_event, paths: unknown) => {
    if (!Array.isArray(paths) || !paths.every(value => typeof value === 'string' && path.isAbsolute(value) && fs.existsSync(value)))
      throw new Error('The fixture selection must contain existing absolute paths');
    selectedInputs = [...paths];
    return { success: true };
  });
  ipcMain.handle('marketplace-probe:select-inputs', () => {
    const paths = selectedInputs;
    selectedInputs = [];
    return { success: true, paths };
  });
  ipcMain.handle('marketplace-probe:native-inventory', async () => {
    const [extensions, skills, mcp, hooks] = await Promise.all([
      extensionService.listCatalog(),
      skillService.getStatus(undefined, { connectedOnly: true }),
      discoverExtensionMcpServers(native.manager),
      native.gateway.requestGateway<{ hooks: Array<Record<string, unknown>> }>('hooks.status', { agentId: 'main' }),
    ]);
    return {
      extensions: extensions.filter(entry => entry.id.startsWith('import-probe-')),
      skills: skills.skills.filter(entry => entry.name.startsWith('import-probe-')),
      mcp: mcp.filter(entry => entry.providerId.startsWith('import-probe-')),
      hooks: hooks.hooks.filter(entry => typeof entry.pluginId === 'string' && entry.pluginId.startsWith('import-probe-')),
    };
  });
  // Bundled speech cards may be present in the native catalog. This disposable
  // plugin fixture has no speech model service and never prepares/downloads one.
  ipcMain.handle(LocalSpeechModelIpc.List, () => ({ supported: false, models: [] }));
  ipcMain.handle('marketplace-probe:evidence', async () => ({
    ...(await market.evidence()), installRequests: { ...installRequests }, results: [...results],
    operationResults: [...operationResults], operationProgress: [...operationProgress],
    native: native.evidence,
    config: (() => {
      const { skills, plugins, mcp, hooks } = JSON.parse(fs.readFileSync(native.manager.getConfigPath(), 'utf8'));
      return { skills, plugins, mcp, hooks };
    })(),
    mcpServers: store.listServers(),
  }));
  return {
    inventory, manager,
    async close() { await market.close(); db.close(); },
  };
}
