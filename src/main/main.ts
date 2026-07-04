import type { WebContents } from 'electron';
import {
  app,
  BrowserWindow,
  ipcMain,
  Menu,
  nativeTheme,
  powerMonitor,
  powerSaveBlocker,
} from 'electron';
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
import {
  applySystemProxyPreference,
  isSystemProxyEnabled,
} from './core/systemProxyPreference';
import { resolveTaskWorkingDirectory } from './core/taskWorkspace';
import { createTray, destroyTray, updateTrayMenu } from './core/trayManager';
import type { CoworkMessage } from './coworkStore';
import { CoworkStore } from './coworkStore';
import { SqliteStore } from './data/sqliteStore';
import { AgentManager } from './features/agentManager';
import { GroupStore } from './groupStore';
import { setLanguage, t } from './i18n';
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
import {
  sanitizeCoworkMessageForIpc,
  sanitizePermissionRequestForIpc,
  truncateIpcString,
} from './ipcPayloadSanitizer';
import {
  type CoworkAgentEngine,
  CoworkEngineRouter,
  OpenClawRuntimeAdapter,
} from './libs/agentEngine';
import type { PermissionResult } from './libs/agentEngine/types';
import { syncBuiltinModelProvider } from './libs/cowork/builtinModelProvider';
import {
  resolveAllEnabledProviderConfigs,
  resolveCurrentApiConfig,
  resolveRawApiConfig,
  setStoreGetter,
} from './libs/cowork/providerApiConfig';
import { OutboundHeaderProxy } from './libs/infra/outboundHeaderProxy';
import { ensurePythonRuntimeReady } from './libs/infra/pythonRuntime';
import type { McpBridgeConfig } from './libs/openclaw/config/openclawConfigSync';
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
import {
  buildManagedSessionKey,
  DEFAULT_MANAGED_AGENT_ID,
  parseManagedSessionKey,
} from './libs/openclaw/sessions/openclawChannelSessionSync';
import { OpenClawSkillFiles } from './libs/openclaw/skills/openclawSkillFiles';
import { createSkillMarketplaceService } from './libs/skillMarketplace';
import { McpStore } from './mcpStore';

const outboundHeaderProxy = new OutboundHeaderProxy();

// 设置应用程序名称
app.setName(APP_NAME);

const IPC_UPDATE_CONTENT_MAX_CHARS = 120_000;
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
  const agents = getAgentManager().listAgents();
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

const formatAskUserAnswerValue = (value: string): string => {
  return value
    .split('|||')
    .map(item => item.trim())
    .filter(Boolean)
    .join(', ');
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

// 开发环境启用远程调试端口，用于 MCP 连接 (chrome-devtools-mcp)
if (isDev) {
  app.commandLine.appendSwitch('remote-debugging-port', '9222');
}

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
const skillMarketplaceService = createSkillMarketplaceService(() => openClawRuntimeAdapter);
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
let coworkRuntimeForwarderBound = false;
let preventSleepBlockerId: number | null = null;

const initStore = async (): Promise<SqliteStore> => {
  if (!storeInitPromise) {
    if (!app.isReady()) {
      throw new Error('Store accessed before app is ready.');
    }
    // better-sqlite3 opens the database synchronously, so Promise.resolve() resolves
    // immediately. The timeout acts as a safety net for future async changes or
    // unexpected OS-level blocking (e.g., file lock on startup).
    storeInitPromise = Promise.race([
      Promise.resolve(SqliteStore.create(app.getPath('userData'))),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Store initialization timed out after 15s')), 15_000),
      ),
    ]);
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

const bootstrapOpenClawEngine = async (
  options: { forceReinstall?: boolean; reason?: string } = {},
) => {
  if (openClawBootstrapPromise) {
    return openClawBootstrapPromise;
  }

  const manager = getOpenClawEngineManager();
  bindOpenClawStatusForwarder();

  const task = async (): Promise<OpenClawEngineStatus> => {
    const reason = options.reason || 'unknown';
    const t0 = Date.now();
    const elapsed = () => `${Date.now() - t0}ms`;
    try {
      console.log(`[OpenClaw] bootstrap starting (reason=${reason})`);

      // Start MCP Bridge before config sync so mcpBridge tools are included in openclaw.json
      const bridgeResult = await startMcpBridge().catch((err: unknown) => {
        console.error(`[OpenClaw] bootstrap: MCP bridge startup failed (non-fatal):`, err);
        return null as McpBridgeConfig | null;
      });
      console.log(
        `[OpenClaw] bootstrap: MCP bridge setup done (${elapsed()}), result=${bridgeResult ? `${bridgeResult.tools.length} tools` : 'null'}`,
      );
      console.log(
        `[OpenClaw] bootstrap: extensionHost=${extensionHostController?.config ? 'ready' : 'not-ready'}, tools=${extensionHostController?.config?.tools.length ?? 0}`,
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
      if (options.forceReinstall) {
        await manager.stopGateway();
        console.log(`[OpenClaw] bootstrap: stopGateway done (${elapsed()})`);
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

  // Ensure MCP bridge is started and config is synced before launching the gateway,
  // so that mcpBridge tools are available in openclaw.json when the gateway loads.
  await startMcpBridge().catch((err: unknown) => {
    console.error('[OpenClaw] ensureRunning: MCP bridge startup failed (non-fatal):', err);
  });
  const syncResult = await syncOpenClawConfig({
    reason: 'ensureRunning:mcpBridge',
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

let agentManager: AgentManager | null = null;
const getAgentManager = () => {
  if (!agentManager) {
    agentManager = new AgentManager(getCoworkStore());
  }
  return agentManager;
};

const resolveCoworkAgentEngine = (): CoworkAgentEngine => {
  return 'openclaw';
};

const getOpenClawConfigSync = (): OpenClawConfigSync => {
  if (!openClawConfigSync) {
    openClawConfigSync = new OpenClawConfigSync({
      engineManager: getOpenClawEngineManager(),
      getCoworkConfig: () => getCoworkStore().getConfig(),
      getMcpBridgeConfig: (): McpBridgeConfig | null => {
        return extensionHostController?.config ?? null;
      },
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

const bindCoworkRuntimeForwarder = (): void => {
  if (coworkRuntimeForwarderBound) return;
  const runtime = getCoworkEngineRouter();

  runtime.on('message', (sessionId: string, message: unknown) => {
    const safeMessage = sanitizeCoworkMessageForIpc(message);
    const windows = BrowserWindow.getAllWindows();
    const messageType =
      typeof message === 'object' && message && 'type' in message
        ? (message as { type?: unknown }).type
        : undefined;
    const messageId = (message as CoworkMessage)?.id;
    console.log(
      '[CoworkForwarder] forwarding message: sessionId=',
      sessionId,
      'type=',
      messageType,
      'id=',
      messageId,
      'windowCount=',
      windows.length,
    );

    // Add modelName to assistant messages (look up from session's agent)
    const isRecord = (value: unknown): value is Record<string, unknown> =>
      value !== null && typeof value === 'object' && !Array.isArray(value);
    const enrichedMessage =
      messageType === 'assistant' && isRecord(message)
        ? (() => {
            const session = getCoworkStore().getSession(sessionId);
            const agentId = session?.agentId || 'main';
            const agent = getCoworkStore().getAgent(agentId);
            const rawModel = agent?.model || '';
            const modelName = rawModel.includes('/')
              ? rawModel.slice(rawModel.indexOf('/') + 1)
              : rawModel;
            return {
              ...(message as Record<string, unknown>),
              ...(modelName ? { modelName } : {}),
            } as CoworkMessage;
          })()
        : (message as CoworkMessage);

    // Persist message to CoworkStore so it survives session reloads
    // Only persist certain message types (not streaming intermediate messages)
    if (
      messageType === 'subagent_completion' ||
      messageType === 'assistant' ||
      messageType === 'system' ||
      messageType === 'user'
    ) {
      try {
        getCoworkStore().insertMessageWithId(sessionId, enrichedMessage);
      } catch (err) {
        console.error('[CoworkForwarder] failed to persist message:', err);
      }
    }

    windows.forEach(win => {
      if (win.isDestroyed()) return;
      try {
        win.webContents.send('cowork:stream:message', {
          sessionId,
          message: {
            ...(safeMessage as Record<string, unknown>),
            ...(enrichedMessage.modelName ? { modelName: enrichedMessage.modelName } : {}),
          },
        });
      } catch (error) {
        console.error('Failed to forward cowork message:', error);
      }
    });
  });

  runtime.on('messageUpdate', (sessionId: string, messageId: string, content: string) => {
    const safeContent = truncateIpcString(content, IPC_UPDATE_CONTENT_MAX_CHARS);
    const windows = BrowserWindow.getAllWindows();
    windows.forEach(win => {
      if (win.isDestroyed()) return;
      try {
        win.webContents.send('cowork:stream:messageUpdate', {
          sessionId,
          messageId,
          content: safeContent,
        });
      } catch (error) {
        console.error('Failed to forward cowork message update:', error);
      }
    });
  });

  runtime.on('thinkingUpdate', (sessionId: string, messageId: string, thinkingDelta: string) => {
    const safeDelta = truncateIpcString(thinkingDelta, IPC_UPDATE_CONTENT_MAX_CHARS);
    const windows = BrowserWindow.getAllWindows();
    windows.forEach(win => {
      if (win.isDestroyed()) return;
      try {
        win.webContents.send('cowork:stream:thinkingUpdate', {
          sessionId,
          messageId,
          thinkingDelta: safeDelta,
        });
      } catch (error) {
        console.error('Failed to forward cowork thinking update:', error);
      }
    });
  });

  runtime.on(
    'messageMetadataUpdate',
    (
      sessionId: string,
      messageId: string,
      metadata: Record<string, unknown>,
      extra?: {
        usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
      },
    ) => {
      const windows = BrowserWindow.getAllWindows();
      windows.forEach(win => {
        if (win.isDestroyed()) return;
        try {
          win.webContents.send('cowork:stream:messageMetadataUpdate', {
            sessionId,
            messageId,
            metadata,
            ...extra,
          });
        } catch (error) {
          console.error('Failed to forward cowork message metadata update:', error);
        }
      });
    },
  );

  runtime.on('messageDelete', (sessionId: string, messageId: string) => {
    const windows = BrowserWindow.getAllWindows();
    windows.forEach(win => {
      if (win.isDestroyed()) return;
      try {
        win.webContents.send('cowork:stream:messageDelete', {
          sessionId,
          messageId,
        });
      } catch (error) {
        console.error('Failed to forward cowork message delete:', error);
      }
    });
  });

  runtime.on('permissionRequest', (sessionId: string, request: unknown) => {
    if (runtime.getSessionConfirmationMode(sessionId) === 'text') {
      return;
    }
    const safeRequest = sanitizePermissionRequestForIpc(request);
    const windows = BrowserWindow.getAllWindows();
    windows.forEach(win => {
      if (win.isDestroyed()) return;
      try {
        win.webContents.send('cowork:stream:permission', { sessionId, request: safeRequest });
      } catch (error) {
        console.error('Failed to forward cowork permission request:', error);
      }
    });
  });

  runtime.on(
    'complete',
    (sessionId: string, claudeSessionId: string | null, finalStatus?: string) => {
      const windows = BrowserWindow.getAllWindows();
      windows.forEach(win => {
        if (win.isDestroyed()) return;
        win.webContents.send('cowork:stream:complete', { sessionId, claudeSessionId, finalStatus });
      });
      // If session used a server model, notify renderer to refresh quota
      try {
        const apiConfig = resolveCurrentApiConfig();
        if (apiConfig.providerMetadata?.providerName === 'justdo-server') {
          const windows = BrowserWindow.getAllWindows();
          windows.forEach(win => {
            if (win.isDestroyed()) return;
            win.webContents.send('auth:quotaChanged');
          });
        }
      } catch {
        // ignore
      }
    },
  );

  runtime.on('error', (sessionId: string, error: string) => {
    // Mark session as error in store so the .catch() fallback can detect duplicates.
    try {
      getCoworkStore().updateSession(sessionId, { status: 'error' });
    } catch {
      /* ignore */
    }
    const windows = BrowserWindow.getAllWindows();
    windows.forEach(win => {
      if (win.isDestroyed()) return;
      win.webContents.send('cowork:stream:error', { sessionId, error });
    });
  });

  coworkRuntimeForwarderBound = true;
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
      getEnabledMcpServers: () => getMcpStore().getEnabledServers(),
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

const startMcpBridge = (): Promise<McpBridgeConfig | null> => {
  return getExtensionHostController().start();
};

/**
 * Stop the MCP Bridge: server manager + HTTP callback.
 */
const stopMcpBridge = async (): Promise<void> => {
  try {
    await extensionHostController?.stop();
  } catch (error) {
    console.error(
      '[McpBridge] shutdown error:',
      error instanceof Error ? error.message : String(error),
    );
  }
};

/**
 * Refresh the MCP Bridge after server config changes:
 * stop existing MCP servers → restart with new config → sync openclaw.json → restart gateway.
 * Returns a summary for the renderer to display.
 */
let mcpBridgeRefreshPromise: Promise<{ tools: number; error?: string }> | null = null;

const broadcastMcpBridgeSync = (channel: string, data?: Record<string, unknown>): void => {
  const windows = BrowserWindow.getAllWindows();
  windows.forEach(win => {
    if (win.isDestroyed()) return;
    try {
      win.webContents.send(channel, data ?? {});
    } catch (error) {
      console.error(`[McpBridge] Failed to broadcast ${channel}:`, error);
    }
  });
};

const refreshMcpBridge = (): Promise<{ tools: number; error?: string }> => {
  if (mcpBridgeRefreshPromise) {
    return mcpBridgeRefreshPromise;
  }
  mcpBridgeRefreshPromise = (async () => {
    try {
      console.log('[McpBridge] refreshing after config change...');
      broadcastMcpBridgeSync('mcp:bridge:syncStart');

      // Restart MCP processes while keeping the callback endpoint stable.
      const bridgeConfig = await getExtensionHostController().restartMcpServers();
      const toolCount = bridgeConfig?.tools.length ?? 0;
      console.log(`[McpBridge] refresh: ${toolCount} tools discovered`);

      // 3. Sync openclaw.json — OpenClaw's file watcher will hot-reload;
      // hard restart only happens when secret env vars change.
      const syncResult = await syncOpenClawConfig({
        reason: 'mcp-server-changed',
      });
      if (!syncResult.success) {
        console.error('[McpBridge] refresh: config sync failed:', syncResult.error);
        return { tools: toolCount, error: syncResult.error };
      }

      console.log(
        `[McpBridge] refresh complete: ${toolCount} tools, gateway restarted=${syncResult.changed}`,
      );
      return { tools: toolCount };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error('[McpBridge] refresh error:', msg);
      return { tools: 0, error: msg };
    }
  })()
    .then(result => {
      broadcastMcpBridgeSync('mcp:bridge:syncDone', { tools: result.tools, error: result.error });
      return result;
    })
    .catch(err => {
      const error = err instanceof Error ? err.message : String(err);
      broadcastMcpBridgeSync('mcp:bridge:syncDone', { tools: 0, error });
      return { tools: 0, error };
    })
    .finally(() => {
      mcpBridgeRefreshPromise = null;
    });
  return mcpBridgeRefreshPromise;
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
  });
  registerSkillHandlers({
    getRuntimeAdapter: () => openClawRuntimeAdapter,
    getSkillFiles: getOpenClawSkillFiles,
    marketplaceService: skillMarketplaceService,
  });

  registerOpenClawEngineHandlers({
    getManager: getOpenClawEngineManager,
    bootstrap: bootstrapOpenClawEngine,
  });

  registerMcpHandlers({
    getStore: getMcpStore,
    refreshBridge: refreshMcpBridge,
  });

  // Cowork IPC handlers
  ipcMain.handle(
    'cowork:session:start',
    async (
      _event,
      options: {
        prompt: string;
        cwd?: string;
        title?: string;
        activeSkillIds?: string[];
        imageAttachments?: Array<{ name: string; mimeType: string; base64Data: string }>;
        agentId?: string;
      },
    ) => {
      try {
        const activeEngine = resolveCoworkAgentEngine();
        if (activeEngine === 'openclaw') {
          const engineStatus = await ensureOpenClawRunningForCowork();
          if (engineStatus.phase !== 'running') {
            return getEngineNotReadyResponse(engineStatus);
          }
        }

        const coworkStoreInstance = getCoworkStore();
        const config = coworkStoreInstance.getConfig();
        const selectedWorkspaceRoot = (options.cwd || config.workingDirectory || '').trim();

        if (!selectedWorkspaceRoot) {
          return {
            success: false,
            error: 'Please select a task folder before submitting.',
          };
        }

        // Generate title from first line of prompt
        const fallbackTitle = options.prompt.split('\n')[0].slice(0, 50) || 'New Session';
        const title = options.title?.trim() || fallbackTitle;
        const taskWorkingDirectory = resolveTaskWorkingDirectory(selectedWorkspaceRoot);

        const session = coworkStoreInstance.createSession(
          title,
          taskWorkingDirectory,
          config.executionMode || 'local',
          options.activeSkillIds || [],
          options.agentId || 'main',
        );

        // Update session status to 'running' before starting async task
        // This ensures the frontend receives the correct status immediately
        coworkStoreInstance.updateSession(session.id, { status: 'running' });

        // Build metadata, include imageAttachments if present
        const messageMetadata: Record<string, unknown> = {};
        if (options.activeSkillIds?.length) {
          messageMetadata.skillIds = options.activeSkillIds;
        }
        if (options.imageAttachments?.length) {
          messageMetadata.imageAttachments = options.imageAttachments;
        }
        coworkStoreInstance.addMessage(session.id, {
          type: 'user',
          content: options.prompt,
          metadata: Object.keys(messageMetadata).length > 0 ? messageMetadata : undefined,
        });

        // Start the session asynchronously (skip initial user message since we already added it)
        const runtime = getCoworkEngineRouter();
        runtime
          .startSession(session.id, options.prompt, {
            skipInitialUserMessage: true,
            skillIds: options.activeSkillIds,
            workspaceRoot: selectedWorkspaceRoot,
            confirmationMode: 'modal',
            imageAttachments: options.imageAttachments,
            agentId: options.agentId,
          })
          .catch(error => {
            console.error('[Cowork] session error:', error);
            try {
              // The engine router already emits an 'error' event (handled at line ~990)
              // which sends cowork:stream:error to the renderer. Only send here if the
              // session hasn't been marked as error yet, to avoid duplicate messages.
              const existing = coworkStoreInstance.getSession(session.id);
              if (existing?.status === 'error') return;
              const errorMessage = error instanceof Error ? error.message : String(error);
              const windows = BrowserWindow.getAllWindows();
              windows.forEach(win => {
                if (win.isDestroyed()) return;
                win.webContents.send('cowork:stream:error', {
                  sessionId: session.id,
                  error: errorMessage,
                });
              });
            } catch (handlerError) {
              console.error(
                '[Cowork] failed to send error notification to renderer:',
                handlerError,
              );
            }
          });

        const sessionWithMessages = coworkStoreInstance.getSession(session.id) || {
          ...session,
          status: 'running' as const,
        };
        return { success: true, session: sessionWithMessages };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to start session',
        };
      }
    },
  );

  ipcMain.handle(
    'cowork:session:continue',
    async (
      _event,
      options: {
        sessionId: string;
        prompt: string;
        activeSkillIds?: string[];
        imageAttachments?: Array<{ name: string; mimeType: string; base64Data: string }>;
      },
    ) => {
      try {
        const activeEngine = resolveCoworkAgentEngine();
        if (activeEngine === 'openclaw') {
          const engineStatus = await ensureOpenClawRunningForCowork();
          if (engineStatus.phase !== 'running') {
            return getEngineNotReadyResponse(engineStatus);
          }
        }

        const runtime = getCoworkEngineRouter();
        runtime
          .continueSession(options.sessionId, options.prompt, {
            skillIds: options.activeSkillIds,
            imageAttachments: options.imageAttachments,
          })
          .catch(error => {
            console.error('[Cowork] continue error:', error);
            try {
              // The engine router already emits an 'error' event (handled at line ~990)
              // which sends cowork:stream:error to the renderer. Only send here if the
              // session hasn't been marked as error yet, to avoid duplicate messages.
              const existing = getCoworkStore().getSession(options.sessionId);
              if (existing?.status === 'error') return;
              const errorMessage = error instanceof Error ? error.message : String(error);
              const windows = BrowserWindow.getAllWindows();
              windows.forEach(win => {
                if (win.isDestroyed()) return;
                win.webContents.send('cowork:stream:error', {
                  sessionId: options.sessionId,
                  error: errorMessage,
                });
              });
            } catch (handlerError) {
              console.error(
                '[Cowork] failed to send error notification to renderer:',
                handlerError,
              );
            }
          });

        const session = getCoworkStore().getSession(options.sessionId);
        return { success: true, session };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to continue session',
        };
      }
    },
  );

  ipcMain.handle('cowork:session:stop', async (_event, sessionId: string) => {
    try {
      const runtime = getCoworkEngineRouter();
      runtime.stopSession(sessionId);
      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to stop session',
      };
    }
  });

  ipcMain.handle('cowork:session:delete', async (_event, sessionId: string) => {
    try {
      getCoworkEngineRouter().stopSession(sessionId);
      const coworkStoreInstance = getCoworkStore();
      // Get session info BEFORE deleting from SQLite (for OpenClaw sync)
      const session = coworkStoreInstance.getSession(sessionId);
      const agentId = session?.agentId || 'main';
      coworkStoreInstance.deleteSession(sessionId);
      // Notify runtime to purge in-memory caches for this session
      // so that channel messages can create a fresh session.
      try {
        getCoworkEngineRouter().onSessionDeleted(sessionId, agentId);
      } catch {
        // Router may not be initialised yet; safe to ignore.
      }
      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to delete session',
      };
    }
  });

  ipcMain.handle('cowork:message:delete', async (_event, sessionId: string, messageId: string) => {
    try {
      const coworkStoreInstance = getCoworkStore();
      const deleted = coworkStoreInstance.deleteMessage(sessionId, messageId);
      return { success: deleted };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to delete message',
      };
    }
  });

  ipcMain.handle(
    'cowork:message:deleteFrom',
    async (_event, sessionId: string, messageId: string) => {
      try {
        const coworkStoreInstance = getCoworkStore();
        const deleted = coworkStoreInstance.deleteMessagesFrom(sessionId, messageId);
        return { success: deleted };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to delete messages',
        };
      }
    },
  );

  ipcMain.handle('cowork:session:deleteBatch', async (_event, sessionIds: string[]) => {
    try {
      const runtime = getCoworkEngineRouter();
      sessionIds.forEach(sessionId => {
        runtime.stopSession(sessionId);
      });
      const coworkStoreInstance = getCoworkStore();
      // Get session info BEFORE deleting (for OpenClaw sync)
      const sessionAgentIds: Map<string, string> = new Map();
      for (const sessionId of sessionIds) {
        const session = coworkStoreInstance.getSession(sessionId);
        if (session) {
          sessionAgentIds.set(sessionId, session.agentId || 'main');
        }
      }
      coworkStoreInstance.deleteSessions(sessionIds);
      const router = getCoworkEngineRouter();
      for (const sessionId of sessionIds) {
        try {
          const agentId = sessionAgentIds.get(sessionId) || 'main';
          router.onSessionDeleted(sessionId, agentId);
        } catch {
          // Router may not be initialised yet; safe to ignore.
        }
      }
      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to batch delete sessions',
      };
    }
  });

  ipcMain.handle(
    'cowork:session:pin',
    async (_event, options: { sessionId: string; pinned: boolean }) => {
      try {
        const coworkStoreInstance = getCoworkStore();
        coworkStoreInstance.setSessionPinned(options.sessionId, options.pinned);
        return { success: true };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to update session pin',
        };
      }
    },
  );

  ipcMain.handle(
    'cowork:session:rename',
    async (_event, options: { sessionId: string; title: string }) => {
      try {
        const title = options.title.trim();
        if (!title) {
          return { success: false, error: 'Title is required' };
        }
        const coworkStoreInstance = getCoworkStore();
        coworkStoreInstance.updateSession(options.sessionId, { title });
        return { success: true };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to rename session',
        };
      }
    },
  );

  ipcMain.handle('cowork:session:get', async (_event, sessionId: string) => {
    try {
      const session = getCoworkStore().getSession(sessionId);
      return { success: true, session };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to get session',
      };
    }
  });

  ipcMain.handle('cowork:session:list', async (_event, agentId?: string) => {
    try {
      const sessions = getCoworkStore().listSessions(agentId);
      return { success: true, sessions };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to list sessions',
      };
    }
  });

  ipcMain.handle('cowork:session:remoteManaged', async (_event, sessionId: string) => {
    try {
      const session = getCoworkStore().getSession(sessionId);
      // A session is remote-managed if its agentId is not the default 'main'
      const remoteManaged = session?.agentId && session.agentId !== 'main';
      return { success: true, remoteManaged: !!remoteManaged };
    } catch (error) {
      return {
        success: false,
        remoteManaged: false,
        error: error instanceof Error ? error.message : 'Failed to check remote managed status',
      };
    }
  });

  ipcMain.handle('cowork:session:runtimeStatus', async (_event, sessionId: string) => {
    try {
      const status = await getCoworkEngineRouter().getSessionRuntimeStatus(sessionId);
      return { success: true, ...status };
    } catch (error) {
      return {
        success: false,
        mainRunning: false,
        subagentRunning: false,
        running: false,
        error: error instanceof Error ? error.message : 'Failed to get session runtime status',
      };
    }
  });

  ipcMain.handle('cowork:session:contextUsage', async (_event, sessionId: string) => {
    try {
      if (!openClawRuntimeAdapter) {
        return { success: false, error: 'OpenClaw runtime adapter not available' };
      }
      if (openClawRuntimeAdapter.isSessionActive(sessionId)) {
        return { success: false, error: 'Context usage is unavailable while a session is running' };
      }
      const gatewayClient = openClawRuntimeAdapter.getGatewayClient();
      if (!gatewayClient) {
        return { success: false, error: 'Gateway client not connected' };
      }
      const localSession = getCoworkStore().getSession(sessionId);
      const effectiveAgentId = localSession?.agentId || DEFAULT_MANAGED_AGENT_ID;
      const sessionKeys = new Set<string>([
        ...openClawRuntimeAdapter.getSessionKeysForSession(sessionId),
        buildManagedSessionKey(sessionId, effectiveAgentId),
        buildManagedSessionKey(sessionId, DEFAULT_MANAGED_AGENT_ID),
      ]);
      const readNumber = (value: unknown): number | undefined =>
        typeof value === 'number' && Number.isFinite(value) ? value : undefined;
      const readSessionTokens = (session: Record<string, unknown>) => {
        const budgetStatus =
          session.contextBudgetStatus && typeof session.contextBudgetStatus === 'object'
            ? (session.contextBudgetStatus as Record<string, unknown>)
            : undefined;
        const totalTokens =
          readNumber(session.totalTokens) ??
          readNumber(session.usedTokens) ??
          readNumber(session.contextUsedTokens) ??
          readNumber(session.currentTokens) ??
          readNumber(budgetStatus?.estimatedPromptTokens) ??
          0;
        const contextTokens =
          readNumber(session.contextTokens) ??
          readNumber(session.contextWindow) ??
          readNumber(session.contextLength) ??
          readNumber(session.maxContextTokens) ??
          readNumber(session.totalContextTokens) ??
          readNumber(budgetStatus?.contextTokenBudget) ??
          0;

        return {
          totalTokens,
          contextTokens,
          totalTokensFresh:
            typeof session.totalTokensFresh === 'boolean'
              ? session.totalTokensFresh ||
                readNumber(budgetStatus?.estimatedPromptTokens) !== undefined
              : true,
        };
      };
      const result = await gatewayClient.request<{
        sessions?: Array<
          {
            key: string;
            totalTokens?: number;
            contextTokens?: number;
            totalTokensFresh?: boolean;
          } & Record<string, unknown>
        >;
      }>('sessions.list', { agentId: effectiveAgentId, limit: 100 });
      let session = result.sessions?.find(s => sessionKeys.has(s.key));
      if (!session && effectiveAgentId !== DEFAULT_MANAGED_AGENT_ID) {
        const fallbackResult = await gatewayClient.request<{
          sessions?: Array<{ key: string } & Record<string, unknown>>;
        }>('sessions.list', { limit: 100 });
        session = fallbackResult.sessions?.find(s => sessionKeys.has(s.key));
      }
      if (!session) {
        console.warn('[CoworkContextUsage] session not found in gateway', {
          sessionId,
          effectiveAgentId,
          sessionKeys: Array.from(sessionKeys),
          returnedKeys: result.sessions?.map(s => s.key).slice(0, 10) ?? [],
        });
        return { success: false, error: 'Session not found in gateway' };
      }
      const usage = readSessionTokens(session);
      if (usage.totalTokens <= 0 || usage.contextTokens <= 0) {
        return {
          success: false,
          error: 'Context usage is not available from OpenClaw session state',
        };
      }
      return {
        success: true,
        ...usage,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to get context usage',
      };
    }
  });

  registerSessionGroupHandlers(getGroupStore);

  ipcMain.handle(
    'cowork:session:patchModel',
    async (_event, options: { sessionId: string; model: string; agentId?: string }) => {
      try {
        const runtime = getCoworkEngineRouter();
        const result = await runtime.patchSessionModel(
          options.sessionId,
          options.model,
          options.agentId,
        );
        return { success: result.ok, error: result.error };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to patch session model',
        };
      }
    },
  );

  // ========== Sub-task IPC Handlers ==========

  ipcMain.handle('cowork:subTask:status', async (_event, sessionId?: string) => {
    try {
      if (!openClawRuntimeAdapter) {
        return { success: true, subagents: [] };
      }
      const result = await openClawRuntimeAdapter.getSubagentStatuses(sessionId);
      return {
        success: true,
        subagents: result.subagents || [],
      };
    } catch {
      return { success: false, subagents: [] };
    }
  });

  ipcMain.handle('cowork:subTask:session', async (_event, sessionKey: string) => {
    try {
      if (!openClawRuntimeAdapter) {
        return { success: false, session: null, error: 'OpenClaw runtime is not ready' };
      }
      if (!sessionKey || typeof sessionKey !== 'string') {
        return { success: false, session: null, error: 'Session key is required' };
      }
      const session = await openClawRuntimeAdapter.fetchSessionByKey(sessionKey);
      return { success: true, session };
    } catch (error) {
      return {
        success: false,
        session: null,
        error: error instanceof Error ? error.message : 'Failed to get subagent session',
      };
    }
  });

  registerAgentHandlers({
    getManager: getAgentManager,
    resolveDefaultModelRef: resolveDefaultAgentModelRef,
    syncConfig: reason => syncOpenClawConfig({ reason }),
  });

  ipcMain.handle(
    'cowork:permission:respond',
    async (
      _event,
      options: {
        requestId: string;
        result: PermissionResult;
      },
    ) => {
      try {
        // Dual-dispatch pattern: permission responses arrive through one IPC channel
        // but may target either of two independent subsystems.
        //
        // - resolveAskUser() handles AskUserQuestion plugin requests routed through
        //   the McpBridgeServer HTTP callback. It is a no-op when the requestId does
        //   not match a pending bridge request (i.e. for normal SDK permission requests).
        //
        // - respondToPermission() handles standard Claude Agent SDK permission requests
        //   managed by the CoworkEngineRouter. It is a no-op when the requestId does
        //   not match a pending SDK permission (i.e. for bridge plugin requests).
        //
        // Both calls are safe to invoke unconditionally; exactly one will match.

        // AskUserQuestion plugin responses go to the bridge server, not the runtime
        if (extensionHostController && options.requestId) {
          const result = options.result;
          const updatedInput =
            result.behavior === 'allow' &&
            result.updatedInput &&
            typeof result.updatedInput === 'object'
              ? (result.updatedInput as Record<string, unknown>)
              : undefined;
          const extensionResponse = extensionHostController.respondToInteraction(
            options.requestId,
            {
              behavior: result.behavior === 'allow' ? 'allow' : 'deny',
              updatedInput,
            },
          );
          const answers = extensionResponse.answers;

          const sessionId = extensionResponse.handled
            ? typeof updatedInput?.sessionId === 'string'
              ? updatedInput.sessionId.trim()
              : (askUserSessionByRequestId.get(options.requestId) ?? '')
            : '';
          if (sessionId && sessionId !== '__askuser__') {
            const content =
              result.behavior === 'allow' && answers && Object.keys(answers).length > 0
                ? Object.entries(answers)
                    .map(
                      ([question, answer]) =>
                        `${question}\n${t('askUserAnswerLabel')}：${formatAskUserAnswerValue(answer)}`,
                    )
                    .join('\n\n')
                : t(
                    result.behavior === 'allow' ? 'askUserApprovedMessage' : 'askUserDeniedMessage',
                  );
            const message = getCoworkStore().addMessage(sessionId, {
              type: 'user',
              content,
              metadata: {
                source: 'AskUserQuestion',
                requestId: options.requestId,
                answers: answers ?? null,
              },
            });
            const safeMessage = sanitizeCoworkMessageForIpc(message);
            BrowserWindow.getAllWindows().forEach(win => {
              if (win.isDestroyed()) return;
              win.webContents.send('cowork:stream:message', {
                sessionId,
                message: safeMessage,
              });
            });
          }
          askUserSessionByRequestId.delete(options.requestId);
        }

        const runtime = getCoworkEngineRouter();
        runtime.respondToPermission(options.requestId, options.result);
        return { success: true };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to respond to permission',
        };
      }
    },
  );

  ipcMain.handle('cowork:config:get', async () => {
    try {
      const config = getCoworkStore().getConfig();
      return { success: true, config };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to get config',
      };
    }
  });

  ipcMain.handle(
    'cowork:config:set',
    async (
      _event,
      config: {
        workingDirectory?: string;
        executionMode?: 'auto' | 'local' | 'sandbox';
        agentEngine?: CoworkAgentEngine;
      },
    ) => {
      try {
        const normalizedExecutionMode =
          config.executionMode && String(config.executionMode) === 'container'
            ? 'local'
            : config.executionMode;
        const normalizedAgentEngine = config.agentEngine === 'openclaw' ? 'openclaw' : undefined;
        const normalizedConfig: Parameters<CoworkStore['setConfig']>[0] = {
          workingDirectory: config.workingDirectory,
          executionMode: normalizedExecutionMode,
          agentEngine: normalizedAgentEngine,
        };
        const previousConfig = getCoworkStore().getConfig();
        const previousWorkingDir = previousConfig.workingDirectory;
        getCoworkStore().setConfig(normalizedConfig);
        const nextConfig = getCoworkStore().getConfig();
        if (
          normalizedAgentEngine !== undefined &&
          normalizedAgentEngine !== previousConfig.agentEngine
        ) {
          getCoworkEngineRouter().handleEngineConfigChanged(normalizedAgentEngine);
        }
        const switchedToOpenClaw =
          normalizedAgentEngine === 'openclaw' && previousConfig.agentEngine !== 'openclaw';

        const shouldSyncOpenClawConfig =
          normalizedExecutionMode !== undefined ||
          normalizedAgentEngine !== undefined ||
          (normalizedConfig.workingDirectory !== undefined &&
            normalizedConfig.workingDirectory !== previousWorkingDir);
        if (shouldSyncOpenClawConfig) {
          const syncResult = await syncOpenClawConfig({
            reason: 'cowork-config-change',
          });
          if (!syncResult.success && nextConfig.agentEngine === 'openclaw') {
            return {
              success: false,
              code: ENGINE_NOT_READY_CODE,
              error: syncResult.error || 'OpenClaw config sync failed.',
              engineStatus: syncResult.status || getOpenClawEngineManager().getStatus(),
            };
          }
        }

        if (switchedToOpenClaw) {
          void ensureOpenClawRunningForCowork().catch(error => {
            console.error('[OpenClaw] Failed to auto-start gateway after engine switch:', error);
          });
        }
        return { success: true };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to set config',
        };
      }
    },
  );

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
          window.webContents.send(
            'openclaw:engine:onProgress',
            openClawEngineManager.getStatus(),
          );
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
    await stopMcpBridge();

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

    bindCoworkRuntimeForwarder();
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
    if (resolveCoworkAgentEngine() === 'openclaw') {
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
    }

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
    let lastUseSystemProxy = isSystemProxyEnabled(
      getStore().get<AppConfigSettings>('app_config'),
    );
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
