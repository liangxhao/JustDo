import type { WebContents } from 'electron';
import { app, BrowserWindow, Menu, nativeTheme, powerMonitor, powerSaveBlocker } from 'electron';
import fs from 'fs';
import os from 'os';
import path from 'path';

import packageJson from '../../package.json';
import { CoworkInteractionKind, OpenClawToolName } from '../shared/openclawExtensions';
import { APP_NAME } from './core/appConstants';
import { registerAppShutdown } from './core/appShutdown';
import { isAutoLaunched } from './core/autoLaunchManager';
import { registerContentSecurityPolicy } from './core/contentSecurityPolicy';
import { registerLocalFileProtocol } from './core/localFileProtocol';
import { initLogger } from './core/logger';
import { createMainWindow } from './core/mainWindowFactory';
import { applySystemProxyPreference, isSystemProxyEnabled } from './core/systemProxyPreference';
import { createTray, destroyTray, updateTrayMenu } from './core/trayManager';
import { CoworkStore } from './coworkStore';
import { SqliteStore } from './data/sqliteStore';
import { GroupStore } from './groupStore';
import { setLanguage } from './i18n';
import {
  registerAppHandlers,
  registerCalendarPermissionHandlers,
  registerDialogHandlers,
  registerLocalFileHandlers,
  registerLogHandlers,
  registerNetworkHandlers,
  registerShellHandlers,
  registerStoreHandlers,
  registerWindowHandlers,
} from './ipcHandlers/app';
import {
  registerAgentHandlers,
  registerCoworkConfigHandlers,
  registerCoworkPermissionHandlers,
  registerCoworkSessionExecutionHandlers,
  registerCoworkSessionHandlers,
  registerCoworkSessionRuntimeHandlers,
  registerCoworkSubtaskHandlers,
  registerCoworkUtilityHandlers,
  registerDefaultModelHandlers,
  registerSessionGroupHandlers,
} from './ipcHandlers/cowork';
import { registerApiProxyHandlers, registerMcpHandlers } from './ipcHandlers/integrations';
import {
  registerOpenClawEngineHandlers,
  registerOpenClawHistoryHandlers,
  registerSkillHandlers,
  registerSlashCommandHandlers,
} from './ipcHandlers/openclaw';
import {
  getCronJobService,
  initCronJobServiceManager,
  registerScheduledTaskHandlers,
} from './ipcHandlers/scheduledTask';
import { CoworkEngineRouter, OpenClawRuntimeAdapter } from './libs/agentEngine';
import { bindCoworkRuntimeForwarder } from './libs/agentEngine/coworkRuntimeForwarder';
import { syncBuiltinModelProvider } from './libs/cowork/builtinModelProvider';
import {
  resolveAllEnabledProviderConfigs,
  resolveRawApiConfig,
  setStoreGetter,
} from './libs/cowork/providerApiConfig';
import { OutboundHeaderProxy } from './libs/infra/outboundHeaderProxy';
import { ensurePythonRuntimeReady } from './libs/infra/pythonRuntime';
import { McpStore } from './libs/mcp/mcpStore';
import type { AskUserExtensionConfig } from './libs/openclaw/config/openclawConfigSync';
import {
  buildProviderSelection,
  OpenClawConfigSync,
} from './libs/openclaw/config/openclawConfigSync';
import { OpenClawExtensionHostController } from './libs/openclaw/extensions/openclawExtensionHostController';
import { resolveQualifiedAgentModelRef } from './libs/openclaw/models/openclawAgentModels';
import {
  OpenClawEngineManager,
  type OpenClawEngineStatus,
} from './libs/openclaw/runtime/openclawEngineManager';
import { stopOpenClawTokenProxy } from './libs/openclaw/runtime/openclawTokenProxy';
import { parseManagedSessionKey } from './libs/openclaw/sessions/openclawChannelSessionSync';
import { OpenClawSkillFiles } from './libs/openclaw/skills/openclawSkillFiles';
import { OpenClawSkillService } from './libs/openclaw/skills/openclawSkillService';
import { createPluginMarketplaceService, PluginManager } from './libs/plugin';
import { justDoSlashCommandPolicy } from './libs/slashCommands/slashCommandPolicies';

const outboundHeaderProxy = new OutboundHeaderProxy();

// 设置应用程序名称
app.setName(APP_NAME);

const ENGINE_NOT_READY_CODE = 'ENGINE_NOT_READY';

const resolveDefaultAgentModelRef = (): string => {
  const apiResolution = resolveRawApiConfig();
  const config = apiResolution.config;
  if (!config?.model?.trim()) {
    return '';
  }

  return buildProviderSelection({
    apiKey: config.apiKey,
    baseURL: config.baseURL,
    modelId: config.model.trim(),
    apiType: config.apiType,
    providerName: apiResolution.providerMetadata?.providerName,
    supportsImage: apiResolution.providerMetadata?.supportsImage,
    modelName: apiResolution.providerMetadata?.modelName,
  }).primaryModel;
};

const buildAvailableOpenClawProviders = (): Record<string, { models: Array<{ id: string }> }> => {
  const providerMap: Record<string, { models: Array<{ id: string }> }> = {};

  for (const provider of resolveAllEnabledProviderConfigs()) {
    for (const model of provider.models) {
      const selection = buildProviderSelection({
        apiKey: provider.apiKey,
        baseURL: provider.baseURL,
        modelId: model.id,
        apiType: provider.apiType,
        providerName: provider.providerName,
        supportsImage: model.supportsImage,
        modelName: model.name,
      });

      if (!providerMap[selection.providerId]) {
        providerMap[selection.providerId] = { models: [] };
      }
      if (
        !providerMap[selection.providerId].models.some(
          entry => entry.id === selection.sessionModelId,
        )
      ) {
        providerMap[selection.providerId].models.push({ id: selection.sessionModelId });
      }
    }
  }

  return providerMap;
};

const migrateAgentModelRefs = (): number => {
  const defaultModelRef = resolveDefaultAgentModelRef();
  if (!defaultModelRef) return 0;

  const availableProviders = buildAvailableOpenClawProviders();
  const agents = getCoworkStore().listAgents();
  let changed = 0;

  for (const agent of agents) {
    const normalizedModel = agent.model.trim();
    if (!normalizedModel) continue;

    const qualification = resolveQualifiedAgentModelRef({
      agentModel: normalizedModel,
      availableProviders,
    });

    if (qualification.status === 'ambiguous') {
      console.warn(
        `[Main] Skipped ambiguous agent model migration for "${agent.id}" because "${qualification.modelId}" matches multiple providers: ${qualification.providerIds.join(', ')}`,
      );
      continue;
    }

    if (qualification.status !== 'qualified' || qualification.primaryModel === normalizedModel) {
      continue;
    }

    getCoworkStore().updateAgent(agent.id, { model: qualification.primaryModel });
    changed += 1;
  }

  return changed;
};

const configureUserDataPath = (): void => {
  const appDataPath = app.getPath('appData');
  const preferredUserDataPath = path.join(appDataPath, APP_NAME);
  const currentUserDataPath = app.getPath('userData');

  if (currentUserDataPath !== preferredUserDataPath) {
    app.setPath('userData', preferredUserDataPath);
    console.log(`[Main] userData path updated: ${currentUserDataPath} -> ${preferredUserDataPath}`);
  }
};

configureUserDataPath();
initLogger();

const isDev = process.env.NODE_ENV === 'development';
const isLinux = process.platform === 'linux';
const isMac = process.platform === 'darwin';
const isWindows = process.platform === 'win32';
const DEV_SERVER_URL =
  process.env.ELECTRON_START_URL || `http://localhost:${packageJson.devServer.port}`;
const enableVerboseLogging =
  process.env.ELECTRON_ENABLE_LOGGING === '1' || process.env.ELECTRON_ENABLE_LOGGING === 'true';
const disableGpu =
  process.env.JUSTDO_DISABLE_GPU === '1' ||
  process.env.JUSTDO_DISABLE_GPU === 'true' ||
  process.env.ELECTRON_DISABLE_GPU === '1' ||
  process.env.ELECTRON_DISABLE_GPU === 'true';
const reloadOnChildProcessGone =
  process.env.ELECTRON_RELOAD_ON_CHILD_PROCESS_GONE === '1' ||
  process.env.ELECTRON_RELOAD_ON_CHILD_PROCESS_GONE === 'true';

const TITLEBAR_HEIGHT = 48;
const TITLEBAR_COLORS = {
  dark: { color: '#0F1117', symbolColor: '#E4E5E9' },
  // Align light title bar with app light surface-muted tone to reduce visual contrast.
  light: { color: '#F3F4F6', symbolColor: '#1A1D23' },
} as const;

// 配置应用
// Linux/Windows 禁用 Chromium 沙箱：桌面应用渲染自有代码，风险可控；
// Windows 下以管理员运行时沙箱无法降权会导致 GPU 进程启动失败 (error_code=18)
if (isLinux || isWindows) {
  app.commandLine.appendSwitch('no-sandbox');
}
if (isLinux) {
  app.commandLine.appendSwitch('disable-dev-shm-usage');
}
if (disableGpu) {
  app.commandLine.appendSwitch('disable-gpu');
  app.commandLine.appendSwitch('disable-software-rasterizer');
  // 禁用硬件加速
  app.disableHardwareAcceleration();
}
if (enableVerboseLogging) {
  app.commandLine.appendSwitch('enable-logging');
  app.commandLine.appendSwitch('v', '1');
}

// 配置网络服务
app.on('ready', () => {
  // 配置网络服务重启策略
  app.configureHostResolver({
    enableBuiltInResolver: true,
    secureDnsMode: 'off',
  });
});

// 添加错误处理
app.on('render-process-gone', (_event, webContents, details) => {
  console.error('Render process gone:', details);
  const shouldReload =
    details.reason === 'crashed' ||
    details.reason === 'killed' ||
    details.reason === 'oom' ||
    details.reason === 'launch-failed' ||
    details.reason === 'integrity-failure';
  if (shouldReload) {
    scheduleReload(`render-process-gone (${details.reason})`, webContents);
  }
});

app.on('child-process-gone', (_event, details) => {
  console.error('Child process gone:', details);
  if (reloadOnChildProcessGone && (details.type === 'GPU' || details.type === 'Utility')) {
    scheduleReload(`child-process-gone (${details.type}/${details.reason})`);
  }
});

// 处理未捕获的异常
process.on('uncaughtException', error => {
  console.error('Uncaught Exception:', error);
});

process.on('unhandledRejection', error => {
  console.error('Unhandled Rejection:', error);
});

process.on('exit', code => {
  console.log(`[Main] Process exiting with code: ${code}`);
});

let store: SqliteStore | null = null;
let coworkStore: CoworkStore | null = null;
let groupStore: GroupStore | null = null;
let openClawRuntimeAdapter: OpenClawRuntimeAdapter | null = null;
const openClawSkillService = new OpenClawSkillService(() => openClawRuntimeAdapter);
const pluginManager = new PluginManager(createPluginMarketplaceService(openClawSkillService));
let coworkEngineRouter: CoworkEngineRouter | null = null;
let openClawSkillFiles: OpenClawSkillFiles | null = null;
let mcpStore: McpStore | null = null;
let extensionHostController: OpenClawExtensionHostController | null = null;
const askUserSessionByRequestId = new Map<string, string>();
let storeInitPromise: Promise<SqliteStore> | null = null;
let openClawEngineManager: OpenClawEngineManager | null = null;
let openClawConfigSync: OpenClawConfigSync | null = null;
let openClawBootstrapPromise: Promise<OpenClawEngineStatus> | null = null;
let openClawStatusForwarderBound = false;
let preventSleepBlockerId: number | null = null;

const initStore = async (): Promise<SqliteStore> => {
  if (!storeInitPromise) {
    if (!app.isReady()) {
      throw new Error('Store accessed before app is ready.');
    }
    storeInitPromise = Promise.resolve(SqliteStore.create(app.getPath('userData')));
  }
  return storeInitPromise;
};

const getStore = (): SqliteStore => {
  if (!store) {
    throw new Error('Store not initialized. Call initStore() first.');
  }
  return store;
};

const getOpenClawEngineManager = (): OpenClawEngineManager => {
  if (!openClawEngineManager) {
    openClawEngineManager = new OpenClawEngineManager();
  }
  return openClawEngineManager;
};

const forwardOpenClawStatus = (status: OpenClawEngineStatus): void => {
  const windows = BrowserWindow.getAllWindows();
  windows.forEach(win => {
    if (win.isDestroyed()) return;
    try {
      win.webContents.send('openclaw:engine:onProgress', status);
    } catch (error) {
      console.error('Failed to forward OpenClaw engine status:', error);
    }
  });
};

const bindOpenClawStatusForwarder = (): void => {
  if (openClawStatusForwarderBound) return;
  const manager = getOpenClawEngineManager();
  manager.on('status', status => {
    forwardOpenClawStatus(status);
  });
  openClawStatusForwarderBound = true;
  forwardOpenClawStatus(manager.getStatus());
};

const getEngineNotReadyResponse = (status: OpenClawEngineStatus) => {
  const fallbackMessage = 'AI engine is initializing. Please try again in a moment.';
  return {
    success: false,
    code: ENGINE_NOT_READY_CODE,
    error: status.message || fallbackMessage,
    engineStatus: status,
  };
};

const bootstrapOpenClawEngine = async (options: { reason?: string } = {}) => {
  if (openClawBootstrapPromise) {
    return openClawBootstrapPromise;
  }

  const manager = getOpenClawEngineManager();
  manager.setGatewayPortListener(port => {
    if (port) {
      outboundHeaderProxy.setProxyBypassEntries([`127.0.0.1:${port}`]);
      return;
    }
    outboundHeaderProxy.setProxyBypassEntries([]);
  });
  bindOpenClawStatusForwarder();

  const task = async (): Promise<OpenClawEngineStatus> => {
    const reason = options.reason || 'unknown';
    const t0 = Date.now();
    const elapsed = () => `${Date.now() - t0}ms`;
    try {
      console.log(`[OpenClaw] bootstrap starting (reason=${reason})`);

      const extensionConfig = await startExtensionHost().catch(
        (err: unknown): AskUserExtensionConfig | null => {
          console.error(`[OpenClaw] bootstrap: extension host startup failed (non-fatal):`, err);
          return null;
        },
      );
      console.log(
        `[OpenClaw] bootstrap: extension host setup done (${elapsed()}), result=${extensionConfig ? 'ready' : 'null'}`,
      );

      const syncResult = await syncOpenClawConfig({
        reason: `bootstrap:${reason}`,
        restartGatewayIfRunning: false,
      });
      console.log(
        `[OpenClaw] bootstrap: syncOpenClawConfig done (${elapsed()}), success=${syncResult.success}`,
      );
      if (!syncResult.success) {
        return syncResult.status || manager.getStatus();
      }
      const ensuredStatus = await manager.ensureReady();
      console.log(
        `[OpenClaw] bootstrap: ensureReady done (${elapsed()}), phase=${ensuredStatus.phase}`,
      );
      if (ensuredStatus.phase !== 'ready' && ensuredStatus.phase !== 'running') {
        return ensuredStatus;
      }
      const result = await manager.startGateway();
      console.log(`[OpenClaw] bootstrap completed (${elapsed()}), phase=${result.phase}`);
      return result;
    } catch (error) {
      console.error(`[OpenClaw] bootstrap failed (${reason}, ${elapsed()}):`, error);
      return manager.getStatus();
    }
  };

  const promise = task().finally(() => {
    if (openClawBootstrapPromise === promise) {
      openClawBootstrapPromise = null;
    }
  });
  openClawBootstrapPromise = promise;
  return promise;
};

const ensureOpenClawRunningForCowork = async () => {
  const manager = getOpenClawEngineManager();
  const status = manager.getStatus();
  if (status.phase === 'running' || status.phase === 'starting') {
    return manager.getStatus();
  }

  await startExtensionHost().catch((err: unknown) => {
    console.error('[OpenClaw] ensureRunning: extension host startup failed (non-fatal):', err);
  });
  const syncResult = await syncOpenClawConfig({
    reason: 'ensureRunning',
    restartGatewayIfRunning: false,
  });
  if (!syncResult.success) {
    console.error('[OpenClaw] ensureRunning: config sync failed:', syncResult.error);
  }

  return await manager.startGateway();
};

const getCoworkStore = () => {
  if (!coworkStore) {
    const sqliteStore = getStore();
    coworkStore = new CoworkStore(sqliteStore.getDatabase());
  }
  return coworkStore;
};

const getGroupStore = () => {
  if (!groupStore) {
    const sqliteStore = getStore();
    groupStore = new GroupStore(sqliteStore.getDatabase());
  }
  return groupStore;
};

const getOpenClawConfigSync = (): OpenClawConfigSync => {
  if (!openClawConfigSync) {
    openClawConfigSync = new OpenClawConfigSync({
      engineManager: getOpenClawEngineManager(),
      getCoworkConfig: () => getCoworkStore().getConfig(),
      getAskUserExtensionConfig: () => {
        return extensionHostController?.config ?? null;
      },
      getMcpServers: () => getMcpStore().listServers(),
      getAgents: () => getCoworkStore().listAgents(),
    });
  }
  return openClawConfigSync;
};

// Deferred gateway restart: when a config change requires a gateway restart
// but active cowork sessions or cron jobs exist, we defer the restart until
// all workloads complete.  A polling interval checks periodically; a hard
// timeout ensures the restart eventually happens even if a session hangs.
let deferredRestartTimer: ReturnType<typeof setInterval> | null = null;
let deferredRestartTimeout: ReturnType<typeof setTimeout> | null = null;
const DEFERRED_RESTART_POLL_MS = 3_000;
const DEFERRED_RESTART_MAX_WAIT_MS = 5 * 60_000; // 5 minutes hard cap

const hasActiveGatewayWorkloads = (): boolean => {
  if (openClawRuntimeAdapter?.hasActiveSessions()) return true;
  return false;
};

const clearDeferredRestart = () => {
  if (deferredRestartTimer) {
    clearInterval(deferredRestartTimer);
    deferredRestartTimer = null;
  }
  if (deferredRestartTimeout) {
    clearTimeout(deferredRestartTimeout);
    deferredRestartTimeout = null;
  }
};

const executeDeferredGatewayRestart = async (reason: string) => {
  clearDeferredRestart();
  console.log(
    `[OpenClaw] executeDeferredGatewayRestart: performing deferred restart (reason: ${reason})`,
  );
  await syncOpenClawConfig({ reason: `deferred:${reason}` });
};

const scheduleDeferredGatewayRestart = (reason: string) => {
  // If already scheduled, the latest config is already on disk — just let
  // the existing timer handle the restart.
  if (deferredRestartTimer) {
    console.log(
      `[OpenClaw] scheduleDeferredGatewayRestart: already scheduled, skipping (reason: ${reason})`,
    );
    return;
  }

  deferredRestartTimer = setInterval(() => {
    if (!hasActiveGatewayWorkloads()) {
      void executeDeferredGatewayRestart(reason);
    }
  }, DEFERRED_RESTART_POLL_MS);

  // Hard timeout: restart anyway after max wait to avoid config drift.
  deferredRestartTimeout = setTimeout(() => {
    console.warn(
      `[OpenClaw] scheduleDeferredGatewayRestart: max wait exceeded, forcing restart (reason: ${reason})`,
    );
    void executeDeferredGatewayRestart(reason);
  }, DEFERRED_RESTART_MAX_WAIT_MS);
};

const syncOpenClawConfig = async (
  options: { reason: string; restartGatewayIfRunning?: boolean } = { reason: 'unknown' },
): Promise<{
  success: boolean;
  changed: boolean;
  status?: OpenClawEngineStatus;
  error?: string;
}> => {
  console.log(
    `[OpenClaw] syncOpenClawConfig: called (reason: ${options.reason}, restart gateway if running: ${options.restartGatewayIfRunning ? 'yes' : 'no'})`,
  );
  // Always write openclaw.json immediately. OpenClaw's built-in file-watcher
  // will detect the change and gracefully reload (waiting for active tasks to
  // complete before restarting, up to a 30s drain timeout).  Previous versions
  // deferred the file write when active workloads existed, but that caused
  // stale config (e.g. model switches not taking effect for new sessions).

  const syncResult = getOpenClawConfigSync().sync(options.reason);
  if (!syncResult.ok) {
    const status = getOpenClawEngineManager().setExternalError(
      `OpenClaw config sync failed: ${syncResult.error || 'unknown error'}`,
    );
    return {
      success: false,
      changed: false,
      status,
      error: syncResult.error,
    };
  }

  // Update secret env vars so the gateway process receives the latest
  // plaintext credentials via environment variables (openclaw.json only
  // contains ${VAR} placeholders, never plaintext secrets).
  const nextSecretEnvVars = getOpenClawConfigSync().collectSecretEnvVars();
  const prevSecretEnvVars = getOpenClawEngineManager().getSecretEnvVars();
  const secretEnvVarsChanged =
    JSON.stringify(nextSecretEnvVars) !== JSON.stringify(prevSecretEnvVars);
  getOpenClawEngineManager().setSecretEnvVars(nextSecretEnvVars);

  // When secret env vars change, the running gateway must be restarted even if
  // the caller didn't request it — the ${VAR} placeholders in openclaw.json
  // resolve from the process environment which is fixed at spawn time.
  const needsHardRestart =
    secretEnvVarsChanged || (syncResult.changed && options.restartGatewayIfRunning);

  if (!needsHardRestart) {
    // Config file was written; OpenClaw's file-watcher will handle the reload.
    return {
      success: true,
      changed: syncResult.changed,
    };
  }

  const manager = getOpenClawEngineManager();
  const status = manager.getStatus();
  if (status.phase !== 'running') {
    return {
      success: true,
      changed: true,
      status,
    };
  }

  // Hard restart required (e.g. secret env vars changed) but active workloads
  // exist — defer the restart to avoid killing in-flight sessions.
  if (hasActiveGatewayWorkloads()) {
    console.log(
      `[OpenClaw] syncOpenClawConfig: deferring hard restart because active workloads exist (reason: ${options.reason})`,
    );
    scheduleDeferredGatewayRestart(options.reason);
    return {
      success: true,
      changed: true,
      status,
    };
  }

  // Tear down the runtime adapter's WebSocket client BEFORE killing the gateway process.
  // This prevents a race where the old client's async `onClose` fires after a new client
  // has already been created, destroying the new connection.
  if (openClawRuntimeAdapter) {
    console.log(
      `[OpenClaw] syncOpenClawConfig: pre-emptively disconnecting runtime adapter before gateway restart (reason: ${options.reason})`,
    );
    openClawRuntimeAdapter.disconnectGatewayClient();
  }

  await manager.stopGateway();
  const restarted = await manager.startGateway();
  if (restarted.phase !== 'running') {
    return {
      success: false,
      changed: true,
      status: restarted,
      error: restarted.message || 'Failed to restart OpenClaw gateway after config sync.',
    };
  }
  return {
    success: true,
    changed: true,
    status: restarted,
  };
};

const getCoworkEngineRouter = () => {
  if (!coworkEngineRouter) {
    if (!openClawRuntimeAdapter) {
      openClawRuntimeAdapter = new OpenClawRuntimeAdapter(
        getCoworkStore(),
        getOpenClawEngineManager(),
      );
    }
    coworkEngineRouter = new CoworkEngineRouter({
      openclawRuntime: openClawRuntimeAdapter,
    });
  }
  return coworkEngineRouter;
};

const getOpenClawSkillFiles = () => {
  if (!openClawSkillFiles) {
    const managedSkillsDir = path.join(getOpenClawEngineManager().getStateDir(), 'skills');
    openClawSkillFiles = new OpenClawSkillFiles(managedSkillsDir);
  }
  return openClawSkillFiles;
};

const getMcpStore = () => {
  if (!mcpStore) {
    const sqliteStore = getStore();
    mcpStore = new McpStore(sqliteStore.getDatabase());
  }
  return mcpStore;
};

const getExtensionHostController = (): OpenClawExtensionHostController => {
  if (!extensionHostController) {
    extensionHostController = new OpenClawExtensionHostController({
      onAskUser: request => {
        const managedSession = parseManagedSessionKey(request.sessionKey);
        const requestSessionId = managedSession?.sessionId ?? '__askuser__';
        askUserSessionByRequestId.set(request.requestId, requestSessionId);
        BrowserWindow.getAllWindows().forEach(win => {
          if (win.isDestroyed()) return;
          win.webContents.send('cowork:stream:permission', {
            sessionId: requestSessionId,
            request: {
              requestId: request.requestId,
              toolName: OpenClawToolName.ASK_USER_QUESTION,
              interactionKind: CoworkInteractionKind.STRUCTURED_QUESTION,
              toolInput: {
                questions: request.questions,
                sessionKey: request.sessionKey,
                sessionId: requestSessionId,
              },
            },
          });
        });
      },
      onAskUserDismiss: requestId => {
        askUserSessionByRequestId.delete(requestId);
        BrowserWindow.getAllWindows().forEach(win => {
          if (!win.isDestroyed()) {
            win.webContents.send('cowork:stream:permissionDismiss', { requestId });
          }
        });
      },
    });
  }
  return extensionHostController;
};

const startExtensionHost = (): Promise<AskUserExtensionConfig | null> => {
  return getExtensionHostController().start();
};

const stopExtensionHost = async (): Promise<void> => {
  try {
    await extensionHostController?.stop();
  } catch (error) {
    console.error(
      '[OpenClawExtensionHost] shutdown error:',
      error instanceof Error ? error.message : String(error),
    );
  }
};

/**
 * Sync MCP server configuration into OpenClaw. OpenClaw owns transport
 * lifecycle, tool discovery, execution, and hot reload.
 */
let mcpConfigSyncPromise: Promise<{ tools: number; error?: string }> | null = null;

const broadcastMcpConfigSync = (channel: string, data?: Record<string, unknown>): void => {
  const windows = BrowserWindow.getAllWindows();
  windows.forEach(win => {
    if (win.isDestroyed()) return;
    try {
      win.webContents.send(channel, data ?? {});
    } catch (error) {
      console.error(`[OpenClawMcp] Failed to broadcast ${channel}:`, error);
    }
  });
};

const syncMcpConfig = (): Promise<{ tools: number; error?: string }> => {
  if (mcpConfigSyncPromise) {
    return mcpConfigSyncPromise;
  }
  mcpConfigSyncPromise = (async () => {
    try {
      console.log('[OpenClawMcp] syncing configuration...');
      broadcastMcpConfigSync('mcp:config:syncStart');
      const syncResult = await syncOpenClawConfig({
        reason: 'mcp-server-changed',
      });
      if (!syncResult.success) {
        console.error('[OpenClawMcp] config sync failed:', syncResult.error);
        return { tools: 0, error: syncResult.error };
      }
      console.log(`[OpenClawMcp] sync complete, changed=${syncResult.changed}`);
      return { tools: getMcpStore().getEnabledServers().length };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error('[OpenClawMcp] sync error:', msg);
      return { tools: 0, error: msg };
    }
  })()
    .then(result => {
      broadcastMcpConfigSync('mcp:config:syncDone', { tools: result.tools, error: result.error });
      return result;
    })
    .catch(err => {
      const error = err instanceof Error ? err.message : String(err);
      broadcastMcpConfigSync('mcp:config:syncDone', { tools: 0, error });
      return { tools: 0, error };
    })
    .finally(() => {
      mcpConfigSyncPromise = null;
    });
  return mcpConfigSyncPromise;
};

// 获取正确的预加载脚本路径
const PRELOAD_PATH = app.isPackaged
  ? path.join(__dirname, 'preload.js')
  : path.join(__dirname, '../dist-electron/preload.js');

// 获取应用图标路径（Windows 使用 .ico，其他平台使用 .png）
const getAppIconPath = (): string | undefined => {
  if (process.platform !== 'win32' && process.platform !== 'linux') return undefined;
  const basePath = app.isPackaged
    ? path.join(process.resourcesPath, 'tray')
    : path.join(__dirname, '..', 'resources', 'tray');
  return process.platform === 'win32'
    ? path.join(basePath, 'tray-icon.ico')
    : path.join(basePath, 'tray-icon.png');
};

// 保存对主窗口的引用
let mainWindow: BrowserWindow | null = null;

let lastReloadAt = 0;
const MIN_RELOAD_INTERVAL_MS = 5000;
type AppConfigSettings = {
  theme?: string;
  language?: string;
  useSystemProxy?: boolean;
};

const resolveThemeFromConfig = (config?: AppConfigSettings): 'light' | 'dark' => {
  if (config?.theme === 'dark') {
    return 'dark';
  }
  if (config?.theme === 'light') {
    return 'light';
  }
  return nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
};

const getInitialTheme = (): 'light' | 'dark' => {
  const config = getStore().get<AppConfigSettings>('app_config');
  return resolveThemeFromConfig(config);
};

const getTitleBarOverlayOptions = () => {
  const config = getStore().get<AppConfigSettings>('app_config');
  const theme = resolveThemeFromConfig(config);
  return {
    color: TITLEBAR_COLORS[theme].color,
    symbolColor: TITLEBAR_COLORS[theme].symbolColor,
    height: TITLEBAR_HEIGHT,
  };
};

const updateTitleBarOverlay = () => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (!isMac && !isWindows) {
    mainWindow.setTitleBarOverlay(getTitleBarOverlayOptions());
  }
  // Also update the window background color to match the theme
  const config = getStore().get<AppConfigSettings>('app_config');
  const theme = resolveThemeFromConfig(config);
  mainWindow.setBackgroundColor(theme === 'dark' ? '#0F1117' : '#F8F9FB');
};

const emitWindowState = (window = mainWindow) => {
  if (!window || window.isDestroyed()) return;
  if (window.webContents.isDestroyed()) return;
  window.webContents.send('window:state-changed', {
    isMaximized: window.isMaximized(),
    isFullscreen: window.isFullScreen(),
    isFocused: window.isFocused(),
  });
};

const showSystemMenu = (position?: { x?: number; y?: number }) => {
  if (!isWindows) return;
  if (!mainWindow || mainWindow.isDestroyed()) return;

  const isMaximized = mainWindow.isMaximized();
  const menu = Menu.buildFromTemplate([
    { label: 'Restore', enabled: isMaximized, click: () => mainWindow.restore() },
    { role: 'minimize' },
    { label: 'Maximize', enabled: !isMaximized, click: () => mainWindow.maximize() },
    { type: 'separator' },
    { role: 'close' },
  ]);

  menu.popup({
    window: mainWindow,
    x: Math.max(0, Math.round(position?.x ?? 0)),
    y: Math.max(0, Math.round(position?.y ?? 0)),
  });
};

const scheduleReload = (reason: string, webContents?: WebContents) => {
  const target = webContents ?? mainWindow?.webContents;
  if (!target || target.isDestroyed()) {
    return;
  }
  const now = Date.now();
  if (now - lastReloadAt < MIN_RELOAD_INTERVAL_MS) {
    console.warn(`Skipping reload (${reason}); last reload was ${now - lastReloadAt}ms ago.`);
    return;
  }
  lastReloadAt = now;
  console.warn(`Reloading window due to ${reason}`);
  target.reloadIgnoringCache();
};

// 确保应用程序只有一个实例
const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  app.quit();
} else {
  registerStoreHandlers({
    getStore,
    onAppConfigChanged: async () => {
      const syncResult = await syncOpenClawConfig({
        reason: 'app-config-change',
        restartGatewayIfRunning: false,
      });
      if (!syncResult.success) {
        console.error(
          '[OpenClaw] Failed to sync config after app_config update:',
          syncResult.error,
        );
      }
    },
    refreshBuiltinModels: () => syncBuiltinModelProvider(getStore()),
  });

  registerNetworkHandlers();
  registerLogHandlers();

  registerAppHandlers({
    getStore,
    getPreventSleepBlockerId: () => preventSleepBlockerId,
    setPreventSleepBlockerId: blockerId => {
      preventSleepBlockerId = blockerId;
    },
  });
  registerWindowHandlers({
    getMainWindow: () => mainWindow,
    showSystemMenu,
  });

  registerOpenClawHistoryHandlers(() => getOpenClawEngineManager().getStateDir());

  registerSlashCommandHandlers({
    getGatewayClient: () => openClawRuntimeAdapter?.getGatewayClient() ?? null,
    policies: [justDoSlashCommandPolicy],
  });
  registerSkillHandlers({
    skillService: openClawSkillService,
    getSkillFiles: getOpenClawSkillFiles,
    pluginManager,
  });

  registerOpenClawEngineHandlers({
    getManager: getOpenClawEngineManager,
  });

  registerMcpHandlers({
    getStore: getMcpStore,
    syncConfig: syncMcpConfig,
  });
  registerCoworkSessionExecutionHandlers({
    ensureEngineRunning: ensureOpenClawRunningForCowork,
    getCoworkStore,
    getCoworkEngineRouter,
    getEngineNotReadyResponse,
  });

  registerCoworkSessionHandlers({
    getCoworkStore,
    getCoworkEngineRouter,
  });

  registerCoworkSessionRuntimeHandlers({
    getCoworkStore,
    getCoworkEngineRouter,
    getRuntime: () => openClawRuntimeAdapter,
  });

  registerSessionGroupHandlers(getGroupStore);

  registerCoworkSubtaskHandlers(() => openClawRuntimeAdapter);

  registerAgentHandlers({
    getStore: getCoworkStore,
    resolveDefaultModelRef: resolveDefaultAgentModelRef,
    syncConfig: reason => syncOpenClawConfig({ reason }),
  });

  registerCoworkPermissionHandlers({
    getCoworkStore,
    getCoworkEngineRouter,
    getExtensionHostController: () => extensionHostController,
    askUserSessionByRequestId,
  });

  registerCoworkConfigHandlers({
    getCoworkStore,
    getCoworkEngineRouter,
    getEngineManager: getOpenClawEngineManager,
    syncOpenClawConfig,
    ensureEngineRunning: ensureOpenClawRunningForCowork,
    engineNotReadyCode: ENGINE_NOT_READY_CODE,
  });

  registerDefaultModelHandlers({
    getStore,
    getCoworkStore,
    syncOpenClawConfig,
  });

  // ==================== Scheduled Task IPC Handlers (OpenClaw) ====================

  initCronJobServiceManager({
    getOpenClawRuntimeAdapter: () => openClawRuntimeAdapter,
  });
  registerScheduledTaskHandlers({
    getCronJobService,
    getOpenClawRuntimeAdapter: () => openClawRuntimeAdapter,
  });

  registerCalendarPermissionHandlers(isDev);

  registerCoworkUtilityHandlers({
    getTitleGenerator: getCoworkEngineRouter,
    listRecentCwds: limit => getCoworkStore().listRecentCwds(limit),
  });

  registerDialogHandlers();
  registerLocalFileHandlers();

  registerShellHandlers();

  registerApiProxyHandlers();

  // 创建主窗口
  const createWindow = () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      if (!mainWindow.isVisible()) mainWindow.show();
      if (!mainWindow.isFocused()) mainWindow.focus();
      return;
    }

    mainWindow = createMainWindow({
      appName: APP_NAME,
      devServerUrl: DEV_SERVER_URL,
      getBackgroundColor: () =>
        getInitialTheme() === 'dark' ? TITLEBAR_COLORS.dark.color : '#F8F9FB',
      getIconPath: getAppIconPath,
      getTitleBarOverlay: getTitleBarOverlayOptions,
      isDev,
      isMac,
      isQuitting: appShutdown.isQuitting,
      isWindows,
      onDidFinishLoad: window => {
        emitWindowState(window);
        if (openClawEngineManager && !window.isDestroyed()) {
          window.webContents.send('openclaw:engine:onProgress', openClawEngineManager.getStatus());
        }
      },
      onReadyToShow: window => {
        emitWindowState(window);
        if (!isAutoLaunched()) {
          window.show();
        }
        const initLang = getStore().get<{ language?: string }>('app_config')?.language;
        setLanguage(initLang === 'en' ? 'en' : 'zh');
        createTray(() => mainWindow);
        try {
          getCronJobService().startPolling();
        } catch {
          // CronJobService not available yet, will start when OpenClaw is ready.
        }
      },
      onWindowStateChanged: emitWindowState,
      preloadPath: PRELOAD_PATH,
      scheduleReload,
    });

    mainWindow.on('closed', () => {
      mainWindow = null;
    });
  };

  const runAppCleanup = async (): Promise<void> => {
    outboundHeaderProxy.stop();
    console.log('[Main] App is quitting, starting cleanup...');
    destroyTray();
    // Stop Cowork sessions without blocking shutdown.
    if (coworkEngineRouter) {
      console.log('[Main] Stopping cowork sessions...');
      coworkEngineRouter.stopAllSessions();
    }

    stopOpenClawTokenProxy();

    if (openClawEngineManager) {
      await openClawEngineManager.stopGateway().catch(error => {
        console.error('[OpenClaw] Failed to stop gateway on quit:', error);
      });
    }

    // The extension host owns MCP client transports/stdio child processes and
    // the local callback server. Stop it after the Gateway can no longer issue
    // tool calls, and before closing application storage.
    await stopExtensionHost();

    // Stop the cron job polling
    try {
      getCronJobService().stopPolling();
    } catch {
      // CronJobService may not have been initialized — safe to ignore.
    }

    // Close the SQLite database to flush the WAL and release the file lock.
    try {
      getStore().close();
    } catch {
      // Store may not have been initialized — safe to ignore.
    }
  };

  const appShutdown = registerAppShutdown({ cleanup: runAppCleanup });

  // 初始化应用
  const initApp = async () => {
    console.log('[Main] initApp: waiting for app.whenReady()');
    await app.whenReady();
    console.log('[Main] initApp: app is ready');

    await outboundHeaderProxy.start();

    // Note: Calendar permission is checked on-demand when calendar operations are requested
    // We don't trigger permission dialogs at startup to avoid annoying users

    // Ensure default working directory exists
    const defaultProjectDir = path.join(os.homedir(), 'justdo', 'project');
    if (!fs.existsSync(defaultProjectDir)) {
      fs.mkdirSync(defaultProjectDir, { recursive: true });
      console.log('Created default project directory:', defaultProjectDir);
    }
    console.log('[Main] initApp: default project dir ensured');

    // 注册 localfile:// 自定义协议，用于安全加载本地文件（图片等）
    registerLocalFileProtocol();

    console.log('[Main] initApp: starting initStore()');
    store = await initStore();
    console.log('[Main] initApp: store initialized');

    // Defensive recovery: app may be force-closed during execution and leave
    // stale running flags in DB. Normalize them on startup.
    const resetCount = getCoworkStore().resetRunningSessions();
    console.log('[Main] initApp: resetRunningSessions done, count:', resetCount);
    if (resetCount > 0) {
      console.log(`[Main] Reset ${resetCount} stuck cowork session(s) from running -> idle`);
    }
    // Inject store getter into providerApiConfig
    setStoreGetter(() => store);

    await syncBuiltinModelProvider(store);

    bindCoworkRuntimeForwarder(getCoworkEngineRouter(), getCoworkStore);
    bindOpenClawStatusForwarder();

    const defaultAgentModelRef = resolveDefaultAgentModelRef();
    const backfilledAgentModels = getCoworkStore().backfillEmptyAgentModels(defaultAgentModelRef);
    const qualifiedAgentModels = migrateAgentModelRefs();
    if (backfilledAgentModels > 0 || qualifiedAgentModels > 0) {
      console.log(
        `[Main] migrated agent model bindings: backfilled=${backfilledAgentModels}, qualified=${qualifiedAgentModels}`,
      );
    }

    const startupSync = await syncOpenClawConfig({
      reason: 'startup',
      restartGatewayIfRunning: false,
    });
    if (!startupSync.success) {
      console.error('[OpenClaw] Startup config sync failed:', startupSync.error);
    }
    void ensureOpenClawRunningForCowork()
      .then(() => {
        try {
          getCronJobService().startPolling();
        } catch {
          // CronJobService not available after OpenClaw startup.
        }
      })
      .catch(error => {
        console.error('[OpenClaw] Failed to auto-start gateway on app startup:', error);
      });

    console.log('[Main] initApp: setStoreGetter done');

    try {
      const runtimeResult = await ensurePythonRuntimeReady();
      if (!runtimeResult.success) {
        console.error('[Main] initApp: ensurePythonRuntimeReady failed:', runtimeResult.error);
      } else {
        console.log('[Main] initApp: ensurePythonRuntimeReady done');
      }
    } catch (error) {
      console.error('[Main] initApp: ensurePythonRuntimeReady threw:', error);
    }

    const appConfig = getStore().get<AppConfigSettings>('app_config');
    await applySystemProxyPreference(isSystemProxyEnabled(appConfig), outboundHeaderProxy);

    // 设置安全策略
    registerContentSecurityPolicy({
      isDev,
      devServerPort: packageJson.devServer.port,
    });

    // 创建窗口
    console.log('[Main] initApp: creating window');
    createWindow();
    console.log('[Main] initApp: window created');

    // Reconnect OpenClaw gateway WS after system wake from sleep/suspend
    powerMonitor.on('resume', () => {
      if (openClawRuntimeAdapter) {
        openClawRuntimeAdapter.onSystemResume();
      }
    });

    // 首次启动时默认关闭开机自启动（先写标记再设置，避免崩溃后重复设置）
    if (!getStore().get('auto_launch_initialized')) {
      getStore().set('auto_launch_initialized', true);
      getStore().set('auto_launch_enabled', false);
      // No need to call setAutoLaunchEnabled(false) since it's already disabled by default
    }

    // Restore prevent-sleep setting
    const preventSleepEnabled = getStore().get<boolean>('prevent_sleep_enabled');
    if (preventSleepEnabled) {
      try {
        preventSleepBlockerId = powerSaveBlocker.start('prevent-display-sleep');
      } catch (err) {
        console.error('[Main] Failed to start prevent-sleep blocker:', err);
      }
    }

    let lastLanguage = getStore().get<AppConfigSettings>('app_config')?.language;
    let lastUseSystemProxy = isSystemProxyEnabled(getStore().get<AppConfigSettings>('app_config'));
    getStore().onDidChange<AppConfigSettings>('app_config', (newConfig, oldConfig) => {
      updateTitleBarOverlay();
      // 仅在语言变更时刷新托盘菜单文本
      const currentLanguage = newConfig?.language;
      if (currentLanguage !== lastLanguage) {
        lastLanguage = currentLanguage;
        setLanguage(currentLanguage === 'en' ? 'en' : 'zh');
        updateTrayMenu(() => mainWindow);
      }

      const previousUseSystemProxy = oldConfig
        ? isSystemProxyEnabled(oldConfig)
        : lastUseSystemProxy;
      const currentUseSystemProxy = isSystemProxyEnabled(newConfig);
      if (currentUseSystemProxy !== previousUseSystemProxy) {
        void applySystemProxyPreference(currentUseSystemProxy, outboundHeaderProxy).then(() => {
          if (getOpenClawEngineManager().getStatus().phase === 'running') {
            // Dispose the adapter's client before restarting the Gateway. Otherwise the
            // old socket closes asynchronously and leaves gatewayReadyPromise rejected,
            // so requests made during the restart can observe a permanently stale client.
            openClawRuntimeAdapter?.disconnectGatewayClient();
            void getOpenClawEngineManager().restartGateway();
          }
        });
      }
      lastUseSystemProxy = currentUseSystemProxy;
    });

    // 在 macOS 上，当点击 dock 图标时显示已有窗口或重新创建
    app.on('activate', () => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        if (!mainWindow.isVisible()) mainWindow.show();
        if (!mainWindow.isFocused()) mainWindow.focus();
        return;
      }
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
      }
    });
  };

  // 启动应用
  initApp().catch(console.error);

  // 当所有窗口关闭时退出应用
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });
}
