import type { WebContents } from 'electron';
import { app, BrowserWindow, Menu, nativeTheme, powerMonitor, powerSaveBlocker } from 'electron';
import fs from 'fs';
import os from 'os';
import path from 'path';

import packageJson from '../../package.json';
import type { ProxySettings } from '../shared/proxy';
import { APP_NAME } from './core/appConstants';
import { registerAppShutdown } from './core/appShutdown';
import { isAutoLaunched } from './core/autoLaunchManager';
import { registerContentSecurityPolicy } from './core/contentSecurityPolicy';
import { applyDependencyManagerConfigEnv } from './core/dependencyManagerConfig';
import { setLanguage } from './core/i18n';
import { registerLocalFileProtocol } from './core/localFileProtocol';
import { initLogger } from './core/logger';
import { createMainWindow } from './core/mainWindowFactory';
import { OutboundHeaderProxy } from './core/outboundHeaderProxy';
import { ensurePythonRuntimeReady } from './core/pythonRuntime';
import { isLoopbackBaseUrl, setProcessProxyRouting } from './core/systemProxy';
import {
  applySystemProxyPreference,
  getProxyPreferenceSignature,
} from './core/systemProxyPreference';
import { createTray, destroyTray, updateTrayMenu } from './core/trayManager';
import { enableSystemCaForCurrentProcess } from './core/trustedCertificates';
import { syncBuiltinModelProvider } from './cowork/builtinModelProvider';
import { BUILTIN_MODEL_PROVIDER_CONFIG } from './cowork/builtinModelProviderConfig';
import {
  resolveAllEnabledProviderConfigs,
  resolveRawApiConfig,
  setStoreGetter,
} from './cowork/providerApiConfig';
import { CoworkStore } from './data/coworkStore';
import { GroupStore } from './data/groupStore';
import { SqliteStore } from './data/sqliteStore';
import { CoworkEngineService } from './engine';
import { bindCoworkRuntimeForwarder } from './engine/cowork/coworkRuntimeForwarder';
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
} from './ipc/app';
import {
  registerAgentHandlers,
  registerCoworkConfigHandlers,
  registerCoworkInteractionHandlers,
  registerCoworkSessionExecutionHandlers,
  registerCoworkSessionHandlers,
  registerCoworkSessionRuntimeHandlers,
  registerCoworkSubtaskHandlers,
  registerCoworkUtilityHandlers,
  registerDefaultModelHandlers,
  registerSessionGroupHandlers,
} from './ipc/cowork';
import {
  registerExtensionHandlers,
  registerHookHandlers,
  registerMarketplaceHandlers,
  registerMcpHandlers,
  registerOpenClawEngineHandlers,
  registerOpenClawHistoryHandlers,
  registerOpenClawMemoryHandlers,
  registerOpenClawUsageHandlers,
  registerSkillHandlers,
  registerSlashCommandHandlers,
} from './ipc/openclaw';
import {
  getCronJobService,
  initCronJobServiceManager,
  registerScheduledTaskHandlers,
} from './ipc/scheduledTask';
import type { AskUserExtensionConfig } from './openclaw/config/openclawConfigSync';
import { buildProviderSelection } from './openclaw/config/openclawConfigSync';
import { OpenClawConfigSyncService } from './openclaw/config/openclawConfigSyncService';
import { resolveQualifiedAgentModelRef } from './openclaw/models/openclawAgentModels';
import {
  OpenClawEngineManager,
  type OpenClawEngineStatus,
} from './openclaw/runtime/openclawEngineManager';
import { justDoSlashCommandPolicy } from './openclaw/slashCommands/slashCommandPolicies';
import {
  createPluginMarketplaceService,
  McpServices,
  OpenClawExtensionHostLifecycle,
  OpenClawExtensionImportService,
  OpenClawHookServices,
  OpenClawSkillFileService,
  OpenClawSkillService,
  PluginInstallationService,
  PluginManager,
} from './plugins';

const outboundHeaderProxy = new OutboundHeaderProxy();
const builtinModelForcedProxyBaseUrls =
  BUILTIN_MODEL_PROVIDER_CONFIG.enabled && isLoopbackBaseUrl(BUILTIN_MODEL_PROVIDER_CONFIG.baseUrl)
    ? [BUILTIN_MODEL_PROVIDER_CONFIG.baseUrl]
    : [];

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
applyDependencyManagerConfigEnv(process.env, app.getPath('userData'));
initLogger();
enableSystemCaForCurrentProcess();

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
let coworkEngineService: CoworkEngineService | null = null;
const openClawSkillService = new OpenClawSkillService(
  () => coworkEngineService?.getRuntimeAdapter() ?? null,
);
const pluginInstallationService = new PluginInstallationService();
const pluginManager = new PluginManager(createPluginMarketplaceService(pluginInstallationService));
const askUserSessionByRequestId = new Map<string, string>();
const extensionHostLifecycle = new OpenClawExtensionHostLifecycle({
  askUserSessionByRequestId,
});
let openClawSkillFileService: OpenClawSkillFileService | null = null;
let mcpServices: McpServices | null = null;
let openClawHookServices: OpenClawHookServices | null = null;
let openClawConfigSyncService: OpenClawConfigSyncService | null = null;
let storeInitPromise: Promise<SqliteStore> | null = null;
let openClawEngineManager: OpenClawEngineManager | null = null;
let openClawStatusForwarderBound = false;
let openClawGatewayPortProxyBypassBound = false;
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

const bindOpenClawGatewayPortProxyBypass = (): void => {
  if (openClawGatewayPortProxyBypassBound) return;
  const manager = getOpenClawEngineManager();
  manager.setGatewayPortListener(port => {
    if (port) {
      const bypassEntries = [`127.0.0.1:${port}`];
      setProcessProxyRouting({
        bypassEntries,
        forcedBaseUrls: builtinModelForcedProxyBaseUrls,
      });
      outboundHeaderProxy.setProxyBypassEntries(bypassEntries);
      return;
    }
    setProcessProxyRouting({
      bypassEntries: [],
      forcedBaseUrls: builtinModelForcedProxyBaseUrls,
    });
    outboundHeaderProxy.setProxyBypassEntries([]);
  });
  openClawGatewayPortProxyBypassBound = true;
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

const ensureOpenClawRunningForCowork = async () => {
  bindOpenClawGatewayPortProxyBypass();
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

const getOpenClawConfigSyncService = (): OpenClawConfigSyncService => {
  if (!openClawConfigSyncService) {
    openClawConfigSyncService = new OpenClawConfigSyncService({
      getCoworkStore,
      getOpenClawEngineManager,
      getAskUserExtensionConfig: () => extensionHostLifecycle.config,
      getMcpStore,
      getHookStore,
      hasActiveGatewayWorkloads: () => getCoworkEngineService().hasActiveSessions(),
      disconnectGatewayClient: () => getCoworkEngineService().disconnectGatewayClient(),
    });
  }
  return openClawConfigSyncService;
};

const syncOpenClawConfig = (
  options: { reason: string; restartGatewayIfRunning?: boolean } = { reason: 'unknown' },
) => getOpenClawConfigSyncService().syncConfig(options);

const getCoworkEngineService = (): CoworkEngineService => {
  if (!coworkEngineService) {
    coworkEngineService = new CoworkEngineService({
      getCoworkStore,
      getOpenClawEngineManager,
      fetchSessionTitle: (requestUrl, init) => outboundHeaderProxy.fetch(requestUrl, init),
    });
  }
  return coworkEngineService;
};

const getCoworkEngineRouter = () => {
  return getCoworkEngineService().getRouter();
};

const getOpenClawRuntimeAdapter = () => {
  return coworkEngineService?.getRuntimeAdapter() ?? null;
};

const getOpenClawSkillFiles = () => {
  if (!openClawSkillFileService) {
    openClawSkillFileService = new OpenClawSkillFileService({
      getOpenClawEngineManager,
    });
  }
  return openClawSkillFileService.getSkillFiles();
};

const getMcpServices = (): McpServices => {
  if (!mcpServices) {
    mcpServices = new McpServices({
      getDatabase: () => getStore().getDatabase(),
      syncOpenClawConfig,
    });
  }
  return mcpServices;
};

const getMcpStore = () => {
  return getMcpServices().getStore();
};

const getOpenClawHookServices = (): OpenClawHookServices => {
  if (!openClawHookServices) {
    openClawHookServices = new OpenClawHookServices({
      getDatabase: () => getStore().getDatabase(),
      syncOpenClawConfig,
    });
  }
  return openClawHookServices;
};

const getHookStore = () => {
  return getOpenClawHookServices().getStore();
};

const startExtensionHost = (): Promise<AskUserExtensionConfig | null> => {
  return extensionHostLifecycle.start();
};

const stopExtensionHost = (): Promise<void> => {
  return extensionHostLifecycle.stop();
};

const syncMcpConfig = (): Promise<{ tools: number; error?: string }> => {
  return getMcpServices().syncConfig();
};

const syncHookConfig = (): Promise<{ hooks: number; error?: string }> => {
  return getOpenClawHookServices().syncConfig();
};

const probeMcpServer = (id: string) => {
  return getMcpServices().probeServer(id);
};

const readMcpResource = (id: string, uri: string) => {
  return getMcpServices().readResource(id, uri);
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
  proxy?: Partial<ProxySettings>;
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

  const window = mainWindow;
  const isMaximized = window.isMaximized();
  const menu = Menu.buildFromTemplate([
    { label: 'Restore', enabled: isMaximized, click: () => window.restore() },
    { role: 'minimize' },
    { label: 'Maximize', enabled: !isMaximized, click: () => window.maximize() },
    { type: 'separator' },
    { role: 'close' },
  ]);

  menu.popup({
    window,
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

  registerOpenClawHistoryHandlers(
    () => getOpenClawEngineManager().getStateDir(),
    () => {
      const manager = getOpenClawEngineManager();
      const connectionInfo = manager.getGatewayConnectionInfo();
      return {
        port: manager.getGatewayPort(),
        token: manager.getGatewayToken() ?? connectionInfo.token,
      };
    },
  );
  registerOpenClawUsageHandlers({ getRuntime: getOpenClawRuntimeAdapter });
  registerOpenClawMemoryHandlers({ getManager: getOpenClawEngineManager });

  registerSlashCommandHandlers({
    getGatewayClient: () => getOpenClawRuntimeAdapter()?.getGatewayClient() ?? null,
    policies: [justDoSlashCommandPolicy],
  });
  registerSkillHandlers({
    skillService: openClawSkillService,
    getSkillFiles: getOpenClawSkillFiles,
    installationService: pluginInstallationService,
  });
  registerMarketplaceHandlers(pluginManager);
  registerExtensionHandlers({
    extensionImportService: new OpenClawExtensionImportService({
      getOpenClawEngineManager,
    }),
    installationService: pluginInstallationService,
  });
  registerHookHandlers({
    getManager: getOpenClawEngineManager,
    getStore: getHookStore,
    syncConfig: syncHookConfig,
    installationService: pluginInstallationService,
  });

  registerOpenClawEngineHandlers({
    getManager: getOpenClawEngineManager,
  });

  registerMcpHandlers({
    getStore: getMcpStore,
    syncConfig: syncMcpConfig,
    probeServer: probeMcpServer,
    readResource: readMcpResource,
    installationService: pluginInstallationService,
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
    getRuntime: getOpenClawRuntimeAdapter,
  });

  registerSessionGroupHandlers(getGroupStore);

  registerCoworkSubtaskHandlers(getOpenClawRuntimeAdapter);

  registerAgentHandlers({
    getStore: getCoworkStore,
  });

  registerCoworkInteractionHandlers({
    getCoworkStore,
    getExtensionHostController: () => extensionHostLifecycle.currentController,
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
    getOpenClawRuntimeAdapter,
  });
  registerScheduledTaskHandlers({
    getCronJobService,
    getOpenClawRuntimeAdapter,
  });

  registerCalendarPermissionHandlers(isDev);

  registerCoworkUtilityHandlers({
    getTitleGenerator: getCoworkEngineRouter,
    listRecentCwds: limit => getCoworkStore().listRecentCwds(limit),
  });

  registerDialogHandlers();
  registerLocalFileHandlers();

  registerShellHandlers();

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
    // Stop Cowork sessions before the Gateway and database are closed.
    const coworkRouter = coworkEngineService?.getCurrentRouter();
    if (coworkRouter) {
      console.log('[Main] Stopping cowork sessions...');
      await coworkRouter.stopAllSessions();
    }

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
    await app.whenReady();

    await outboundHeaderProxy.start();

    // Note: Calendar permission is checked on-demand when calendar operations are requested
    // We don't trigger permission dialogs at startup to avoid annoying users

    // Ensure default working directory exists
    const defaultProjectDir = path.join(os.homedir(), 'justdo', 'project');
    if (!fs.existsSync(defaultProjectDir)) {
      fs.mkdirSync(defaultProjectDir, { recursive: true });
      console.log('Created default project directory:', defaultProjectDir);
    }

    // 注册 localfile:// 自定义协议，用于安全加载本地文件（图片等）
    registerLocalFileProtocol();

    store = await initStore();

    // Defensive recovery: app may be force-closed during execution and leave
    // stale running flags in DB. Normalize them on startup.
    const resetCount = getCoworkStore().resetRunningSessions();
    if (resetCount > 0) {
      console.log(`[Main] Reset ${resetCount} stuck cowork session(s) from running -> idle`);
    }
    // Inject store getter into providerApiConfig
    setStoreGetter(() => store);

    // Restore proxy routing before refreshing the built-in provider. Its model
    // endpoint may require the saved system/custom proxy to be reachable.
    bindOpenClawGatewayPortProxyBypass();
    const appConfig = getStore().get<AppConfigSettings>('app_config');
    await applySystemProxyPreference(appConfig, outboundHeaderProxy);

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

    try {
      const runtimeResult = await ensurePythonRuntimeReady();
      if (!runtimeResult.success) {
        console.error('[Main] initApp: ensurePythonRuntimeReady failed:', runtimeResult.error);
      }
    } catch (error) {
      console.error('[Main] initApp: ensurePythonRuntimeReady threw:', error);
    }

    // 设置安全策略
    registerContentSecurityPolicy({
      isDev,
      devServerPort: packageJson.devServer.port,
    });

    // 创建窗口
    createWindow();

    // Reconnect OpenClaw gateway WS after system wake from sleep/suspend
    powerMonitor.on('resume', () => {
      getOpenClawRuntimeAdapter()?.onSystemResume();
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
    let lastProxyPreference = getProxyPreferenceSignature(
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

      const previousProxyPreference = oldConfig
        ? getProxyPreferenceSignature(oldConfig)
        : lastProxyPreference;
      const currentProxyPreference = getProxyPreferenceSignature(newConfig);
      if (currentProxyPreference !== previousProxyPreference) {
        void applySystemProxyPreference(newConfig, outboundHeaderProxy).then(isLatest => {
          if (!isLatest) return;
          if (getOpenClawEngineManager().getStatus().phase === 'running') {
            // Dispose the adapter's client before restarting the Gateway. Otherwise the
            // old socket closes asynchronously and leaves gatewayReadyPromise rejected,
            // so requests made during the restart can observe a permanently stale client.
            getOpenClawRuntimeAdapter()?.disconnectGatewayClient();
            void getOpenClawEngineManager().restartGateway();
          }
        });
      }
      lastProxyPreference = currentProxyPreference;
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
