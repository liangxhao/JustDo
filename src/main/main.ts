import { randomBytes } from 'node:crypto';

import type { WebContents } from 'electron';
import {
  app,
  BrowserWindow,
  Menu,
  nativeTheme,
  powerMonitor,
  powerSaveBlocker,
  session,
} from 'electron';
import fs from 'fs';
import os from 'os';
import path from 'path';

import packageJson from '../../package.json';
import { ACTIVITY_REPORTING_CONFIG } from '../config/activityReporting';
import { APP_UPDATE_CONFIG } from '../config/appUpdate';
import { BUILTIN_MODEL_PROVIDER_CONFIG } from '../config/builtinModels';
import { normalizeBrowserDownloadSettings, normalizeBrowserMode } from '../shared/browser/browser';
import { CoworkSubagentDetailsIpc } from '../shared/cowork/subagentDetails';
import type { ProxySettings } from '../shared/network/proxy';
import { EmbeddedBrowserGateway } from '../shared/openclaw/extensions';
import { WorkboardIpc } from '../shared/openclaw/workboard';
import { HOME_WORKSPACE_SESSION_ID } from '../shared/preview/filePreview';
import {
  DEFAULT_WORKSPACE_DIRECTORY_NAME,
  USER_DATA_DIRECTORY_NAME,
} from '../shared/productMetadata';
import {
  buildCustomProviderRenameAliases,
  listRetiredOpenClawProviderIds,
  ProviderName,
} from '../shared/providers';
import { BuiltinModelIpc, BuiltinModelSyncReason } from '../shared/providers/builtinModels';
import { LocalSpeechModelIpc } from '../shared/speech/localSpeechModels';
import { normalizeLocalSpeechSettings } from '../shared/speech/localSpeechSettings';
import { BrowserAgentBridge } from './browser/browserAgentBridge';
import { BrowserExtensionChatController } from './browser/browserExtensionChatController';
import { BrowserExtensionChatServer } from './browser/browserExtensionChatServer';
import {
  BROWSER_EXTENSION_RESTART_SWITCH,
  clearBrowserExtensionAppServer,
  publishBrowserExtensionAppServer,
  registerBrowserExtensionNativeHost,
} from './browser/browserExtensionNativeMessaging';
import { registerAppShutdown } from './core/app/appShutdown';
import { isAutoLaunched } from './core/app/autoLaunchManager';
import { AutoUpdateService } from './core/app/autoUpdateService';
import { CustomerRegistrationService } from './core/app/customerRegistrationService';
import { isNsisInstalledApp } from './core/app/installedApp';
import { createTray, destroyTray, updateTrayMenu } from './core/app/trayManager';
import { APP_NAME, DEV_SERVER_URL_SWITCH, INSTALLER_QUIT_SWITCH } from './core/appConstants';
import { resolveDevelopmentDataDirectory } from './core/development/developmentDataDirectory';
import { getDevServerUrlFromCommandLine } from './core/development/devServerHandoff';
import { createDevSessionLifecycle } from './core/development/devSessionLifecycle';
import { ManagedDirectoryOperationCoordinator } from './core/filesystem/managedDirectoryOperations';
import { setLanguage } from './core/i18n';
import { initLogger } from './core/logger';
import { mainProcessFetch, mainProcessTitleFetch } from './core/network/mainProcessFetch';
import {
  resolveOutboundHeaderUserInfoPath,
  updateOutboundHeaderUserInfoCache,
} from './core/network/outboundHeaderPolicyConfig';
import { OutboundHeaderPolicyService } from './core/network/outboundHeaderPolicyService';
import { OutboundHeaderProxy } from './core/network/outboundHeaderProxy';
import { isLoopbackBaseUrl, setProcessProxyRouting } from './core/network/systemProxy';
import {
  applySystemProxyPreference,
  getProxyPreferenceSignature,
} from './core/network/systemProxyPreference';
import { enableSystemCaForCurrentProcess } from './core/network/trustedCertificates';
import { applyDependencyManagerConfigEnv } from './core/runtime/dependencyManagerConfig';
import { ensurePythonRuntimeReady } from './core/runtime/pythonRuntime';
import { registerContentSecurityPolicy } from './core/window/contentSecurityPolicy';
import { registerLocalFileProtocol } from './core/window/localFileProtocol';
import { createMainWindow } from './core/window/mainWindowFactory';
import { CoworkStore } from './data/coworkStore';
import { GroupStore } from './data/groupStore';
import { SqliteStore } from './data/sqliteStore';
import { CoworkEngineService } from './engine';
import { bindCoworkRuntimeForwarder } from './engine/cowork/coworkRuntimeForwarder';
import { runMulticaBridgeClient } from './integrations/multica/multicaBridgeClient';
import {
  MULTICA_DEV_BRIDGE_SWITCH,
  parseMulticaBridgeArgv,
} from './integrations/multica/multicaBridgeProtocol';
import { MulticaBridgeServer } from './integrations/multica/multicaBridgeServer';
import { resolvePackagedMulticaTargetPath } from './integrations/multica/multicaCommandLauncher';
import { MulticaCommandService } from './integrations/multica/multicaCommandService';
import {
  resolveMulticaDevAgentExecutable,
  resolvePackagedMulticaAgentExecutable,
} from './integrations/multica/multicaDevAgent';
import { MulticaExternalSessionStore } from './integrations/multica/multicaExternalSessionStore';
import { MulticaIntegrationService } from './integrations/multica/multicaIntegrationService';
import { runMulticaOpenClaw } from './integrations/multica/multicaOpenClawRunner';
import {
  applyBrowserModeChange,
  registerAppHandlers,
  registerAutoUpdateHandlers,
  registerBrowserHandlers,
  registerCalendarPermissionHandlers,
  registerDialogHandlers,
  registerImagePreviewHandlers,
  registerLocalAsrHandlers,
  registerLocalFileHandlers,
  registerLocalSpeechModelHandlers,
  registerLogHandlers,
  registerNetworkHandlers,
  registerShellHandlers,
  registerStoreHandlers,
  registerTerminalHandlers,
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
  registerWindowsSandboxHandlers,
  waitForCoworkConfigUpdates,
} from './ipc/cowork';
import { registerCollaborationHandlers } from './ipc/cowork/collaboration';
import { registerMulticaIntegrationHandlers } from './ipc/multica';
import {
  registerExtensionHandlers,
  registerHookHandlers,
  registerLocalTtsHandlers,
  registerMarketplaceHandlers,
  registerMcpHandlers,
  registerMediaGenerationModelHandlers,
  registerOnlineAsrHandlers,
  registerOnlineTtsHandlers,
  registerOpenClawApprovalHandlers,
  registerOpenClawEngineHandlers,
  registerOpenClawHistoryHandlers,
  registerOpenClawMemoryHandlers,
  registerOpenClawModelHandlers,
  registerOpenClawUsageHandlers,
  registerOpenClawWorkboardHandlers,
  registerSkillHandlers,
  registerSlashCommandHandlers,
  registerSpeechSynthesisHandlers,
} from './ipc/openclaw';
import { readOpenClawAssistantMedia } from './ipc/openclaw/engine';
import {
  getCronJobService,
  getScheduledTaskResultStore,
  getScheduledTaskResultSyncService,
  initCronJobServiceManager,
  registerScheduledTaskHandlers,
} from './ipc/scheduledTask';
import { buildManagedLocalSttConfig } from './openclaw/config/localSttConfig';
import { buildManagedLocalTtsConfig } from './openclaw/config/localTtsConfig';
import { NativeAssistantCreation } from './openclaw/config/nativeAssistantCreation';
import {
  buildProviderSelection,
  listManagedOpenClawPluginIds,
} from './openclaw/config/openclawConfigSync';
import { OpenClawConfigSyncService } from './openclaw/config/openclawConfigSyncService';
import { resolveQualifiedAgentModelRef } from './openclaw/models/openclawAgentModels';
import { SessionPermissionModeCoordinator } from './openclaw/permissions/sessionPermissionModeCoordinator';
import {
  OpenClawEngineManager,
  type OpenClawEngineStatus,
} from './openclaw/runtime/openclawEngineManager';
import { acquireOpenClawRuntimeDevLease } from './openclaw/runtime/openclawRuntimeDevLease';
import { justDoSlashCommandPolicy } from './openclaw/slashCommands/slashCommandPolicies';
import {
  createPluginMarketplaceService,
  discoverExtensionMcpServers,
  discoverOpenClawManagedMcpServers,
  McpServices,
  OpenClawExtensionImportService,
  OpenClawHookServices,
  OpenClawSkillFileService,
  OpenClawSkillService,
  PluginInstallationService,
  PluginManager,
} from './plugins';
import {
  getBuiltinModelAuthConfig,
  resolveBuiltinModelDevelopmentApiKey,
} from './providers/builtinModelAuthConfig';
import { BuiltinModelAuthCoordinator } from './providers/builtinModelAuthCoordinator';
import {
  type BuiltinModelCredential,
  clearActiveBuiltinModelCredential,
  getActiveBuiltinModelCredential,
} from './providers/builtinModelCredential';
import { BuiltinModelCredentialMonitor } from './providers/builtinModelCredentialMonitor';
import { BuiltinModelLifecycle } from './providers/builtinModelLifecycle';
import { BuiltinModelAccess, syncBuiltinModelProvider } from './providers/builtinModelProvider';
import { BuiltinModelTokenExchange } from './providers/builtinModelTokenExchange';
import {
  resolveAllEnabledProviderConfigs,
  resolveRawApiConfig,
  setStoreGetter,
  validateConfiguredOpenClawProviderNames,
} from './providers/providerApiConfig';
import { WindowsSandboxService } from './security/windowsSandboxService';
import { LocalSpeechModelService } from './speech/localSpeechModelService';

let outboundHeaderProxy: OutboundHeaderProxy | null = null;
const getOutboundHeaderProxy = (): OutboundHeaderProxy => {
  outboundHeaderProxy ??= new OutboundHeaderProxy();
  return outboundHeaderProxy;
};
const builtinModelForcedProxyBaseUrls =
  BUILTIN_MODEL_PROVIDER_CONFIG.enabled && isLoopbackBaseUrl(BUILTIN_MODEL_PROVIDER_CONFIG.baseUrl)
    ? [BUILTIN_MODEL_PROVIDER_CONFIG.baseUrl]
    : [];

// 设置应用程序名称
app.setName(APP_NAME);

const ENGINE_NOT_READY_CODE = 'ENGINE_NOT_READY';

const resolveDefaultAgentModelRef = (): string => {
  if (!validateConfiguredOpenClawProviderNames().ok) {
    return '';
  }
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
    displayName: apiResolution.providerMetadata?.displayName,
  }).primaryModel;
};

const buildAvailableOpenClawProviders = (): Record<string, { models: Array<{ id: string }> }> => {
  const providerMap: Record<string, { models: Array<{ id: string }> }> = {};
  if (!validateConfiguredOpenClawProviderNames().ok) {
    return providerMap;
  }

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
        displayName: provider.displayName,
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
    if (agent.deletedAt) continue;
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
  const developmentDirectory = resolveDevelopmentDataDirectory({
    isPackaged: app.isPackaged,
    nodeEnv: process.env.NODE_ENV,
    directory: process.env.JUSTDO_DEV_USER_DATA_DIR,
  });
  const preferredUserDataPath =
    developmentDirectory ?? path.join(appDataPath, USER_DATA_DIRECTORY_NAME);
  if (developmentDirectory) {
    fs.mkdirSync(developmentDirectory, { recursive: true });
    process.env.JUSTDO_DEV_WORKSPACE_DIR = path.join(developmentDirectory, 'project');
  }
  const currentUserDataPath = app.getPath('userData');

  if (currentUserDataPath !== preferredUserDataPath) {
    app.setPath('userData', preferredUserDataPath);
    console.log(`[Main] userData path updated: ${currentUserDataPath} -> ${preferredUserDataPath}`);
  }
};

configureUserDataPath();
const multicaBridgeArgv = parseMulticaBridgeArgv(process.argv);
if (multicaBridgeArgv) {
  console.log = () => undefined;
  console.info = () => undefined;
  console.warn = () => undefined;
  console.error = () => undefined;
} else {
  applyDependencyManagerConfigEnv(process.env);
  initLogger();
  enableSystemCaForCurrentProcess();
}

const isDev = process.env.NODE_ENV === 'development';
const isLinux = process.platform === 'linux';
const isMac = process.platform === 'darwin';
const isWindows = process.platform === 'win32';
let devServerUrl =
  process.env.ELECTRON_START_URL ||
  `http://localhost:${process.env.JUSTDO_DEV_SERVER_PORT || packageJson.devServer.port}`;
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
const pluginManager = new PluginManager(
  createPluginMarketplaceService(pluginInstallationService, () => {
    if (!store) throw new Error('Store is not initialized');
    return store;
  }),
);
let openClawSkillFileService: OpenClawSkillFileService | null = null;
let mcpServices: McpServices | null = null;
let openClawHookServices: OpenClawHookServices | null = null;
let openClawConfigSyncService: OpenClawConfigSyncService | null = null;
let localSpeechModelService: LocalSpeechModelService | null = null;
let builtinModelLifecycle: BuiltinModelLifecycle | null = null;
let customerRegistrationService: CustomerRegistrationService | null = null;
let builtinModelCredentialMonitor: BuiltinModelCredentialMonitor | null = null;
let builtinModelTokenExchange: BuiltinModelTokenExchange | null = null;
let builtinModelAuthCoordinator: BuiltinModelAuthCoordinator | null = null;
let windowsSandboxService: WindowsSandboxService | null = null;
let browserExtensionChatServer: BrowserExtensionChatServer | null = null;
let browserExtensionChatServerRestartPromise: Promise<void> | null = null;
let storeInitPromise: Promise<SqliteStore> | null = null;
let openClawEngineManager: OpenClawEngineManager | null = null;
let openClawDirectoryOperations: ManagedDirectoryOperationCoordinator | null = null;
let outboundHeaderPolicyService: OutboundHeaderPolicyService | null = null;
let openClawExtensionImportService: OpenClawExtensionImportService | null = null;
let activeOutboundHeaderPolicyDigest: string | null = null;
let openClawStatusForwarderBound = false;
let openClawGatewayPortProxyBypassBound = false;
let preventSleepBlockerId: number | null = null;
let multicaExternalSessionStore: MulticaExternalSessionStore | null = null;
let multicaCommandService: MulticaCommandService | null = null;
let multicaBridgeServer: MulticaBridgeServer | null = null;
let multicaBridgeStartPromise: Promise<void> | null = null;
let multicaIntegrationService: MulticaIntegrationService | null = null;

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

const getOutboundHeaderPolicyService = (): OutboundHeaderPolicyService => {
  outboundHeaderPolicyService ??= new OutboundHeaderPolicyService({
    listInstalledExtensions: () =>
      openClawExtensionImportService?.listInstalled() ??
      new OpenClawExtensionImportService({ getOpenClawEngineManager }).listInstalled(),
  });
  return outboundHeaderPolicyService;
};

const prepareOutboundHeaderNetworkGeneration = async (): Promise<void> => {
  const snapshot = getOutboundHeaderPolicyService().reconcile();
  if (activeOutboundHeaderPolicyDigest === snapshot.digest) return;
  const proxy = getOutboundHeaderProxy();
  proxy.stop();
  await proxy.start();
  activeOutboundHeaderPolicyDigest = snapshot.digest;
};

const getOpenClawEngineManager = (): OpenClawEngineManager => {
  if (!openClawEngineManager) {
    openClawEngineManager = new OpenClawEngineManager({
      beginNetworkGeneration: () => getOutboundHeaderProxy().rotateGatewayCapability(),
      prepareNetworkGeneration: prepareOutboundHeaderNetworkGeneration,
      buildNetworkEnvironment: baseEnv => getOutboundHeaderProxy().buildGatewayEnvironment(baseEnv),
    });
  }
  return openClawEngineManager;
};

const getOpenClawDirectoryOperations = (): ManagedDirectoryOperationCoordinator => {
  if (!openClawDirectoryOperations) {
    openClawDirectoryOperations = new ManagedDirectoryOperationCoordinator({
      ownsAppProcess: pid => app.getAppMetrics().some(metric => metric.pid === pid),
      runtime: {
        isRunning: () => {
          const phase = getOpenClawEngineManager().getStatus().phase;
          return phase === 'running' || phase === 'starting';
        },
        ownsProcess: pid => getOpenClawEngineManager().getGatewayProcessId() === pid,
        prepareStop: () =>
          getOpenClawConfigSyncService().prepareGatewayStopAfterExclusiveMutation(
            'managed-directory-lock',
          ),
        stop: token => getOpenClawConfigSyncService().stopGatewayAfterExclusiveMutation(token),
        start: token => getOpenClawConfigSyncService().startGatewayAfterExclusiveMutation(token),
      },
    });
  }
  return openClawDirectoryOperations;
};

const getOpenClawExtensionImportService = (): OpenClawExtensionImportService => {
  openClawExtensionImportService ??= new OpenClawExtensionImportService({
    getOpenClawEngineManager,
    getManagedPluginIds: listManagedOpenClawPluginIds,
    requestGateway: <T>(method: string, params?: unknown) =>
      getCoworkEngineService().requestGateway<T>(method, params),
    runConfigMutationExclusive: operation =>
      getOpenClawConfigSyncService().runConfigMutationExclusive(operation),
    restartGatewayAfterMutation: reason => {
      const desiredDigest = getOutboundHeaderPolicyService().getSnapshot().digest;
      return getOpenClawConfigSyncService().restartGatewayAfterExclusiveMutation(
        activeOutboundHeaderPolicyDigest !== desiredDigest
          ? 'extension-network-policy-change'
          : reason,
      );
    },
    directoryOperations: getOpenClawDirectoryOperations(),
    outboundHeaderPolicy: {
      inspectExtension: extensionRoot =>
        getOutboundHeaderPolicyService().inspectExtension(extensionRoot),
      reconcile: () => getOutboundHeaderPolicyService().reconcile(),
    },
  });
  return openClawExtensionImportService;
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
      getOutboundHeaderProxy().setProxyBypassEntries(bypassEntries);
      return;
    }
    setProcessProxyRouting({
      bypassEntries: [],
      forcedBaseUrls: builtinModelForcedProxyBaseUrls,
    });
    getOutboundHeaderProxy().setProxyBypassEntries([]);
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

  const syncResult = await syncOpenClawConfig({
    reason: 'ensureRunning',
  });
  if (!syncResult.success) {
    console.error('[OpenClaw] ensureRunning: config sync failed:', syncResult.error);
    return (
      syncResult.status ??
      manager.setExternalError(syncResult.error || 'OpenClaw configuration could not be verified.')
    );
  }

  const status = manager.getStatus();
  if (status.phase === 'running') {
    if (syncResult.hostPolicyVerified) return status;

    const verification = await getOpenClawConfigSyncService().verifyActivePermissionPolicy();
    return verification.success
      ? status
      : manager.setExternalError(
          verification.error || 'The active Gateway permission policy is unavailable.',
        );
  }

  // Reuse an in-flight start when the Gateway is already starting. Calling
  // startGateway() is intentional: the manager deduplicates concurrent starts.
  const started = await manager.startGateway();
  if (started.phase !== 'running') return started;
  const verification = await getOpenClawConfigSyncService().verifyActivePermissionPolicy();
  return verification.success
    ? started
    : manager.setExternalError(
        verification.error || 'The active Gateway permission policy is unavailable.',
      );
};

const getCoworkStore = () => {
  if (!coworkStore) {
    const sqliteStore = getStore();
    coworkStore = new CoworkStore(sqliteStore.getDatabase());
  }
  return coworkStore;
};

const getWindowsSandboxService = (): WindowsSandboxService => {
  if (!windowsSandboxService) {
    windowsSandboxService = new WindowsSandboxService();
  }
  return windowsSandboxService;
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
      getMcpStore,
      getHookStore,
      disconnectGatewayClient: () => getCoworkEngineService().disconnectGatewayClient(),
      connectGatewayClient: () => getCoworkEngineService().connectGatewayClient(),
      requestGateway: <T>(method: string, params?: unknown) =>
        getCoworkEngineService().requestGateway<T>(method, params),
      getBrowserMode: () =>
        normalizeBrowserMode(getStore().get<{ browserMode?: unknown }>('app_config')?.browserMode),
      getLocalSttConfig: () => {
        const appConfig = getStore().get<AppConfigSettings>('app_config');
        return buildManagedLocalSttConfig(
          normalizeLocalSpeechSettings(appConfig?.voice),
          appConfig?.language === 'en' ? 'en' : 'zh',
        );
      },
      getLocalTtsConfig: () =>
        buildManagedLocalTtsConfig(
          undefined,
          normalizeLocalSpeechSettings(getStore().get<AppConfigSettings>('app_config')?.voice),
        ),
      getSpeechOutputState: () => {
        const settings = normalizeLocalSpeechSettings(
          getStore().get<AppConfigSettings>('app_config')?.voice,
        );
        return { enabled: settings.outputEnabled, mode: settings.synthesisMode };
      },
      getWindowsSandboxStatus: () => getWindowsSandboxService().getStatus(),
      getWindowsSandboxEnvironment: () => getWindowsSandboxService().getGatewayEnvironment(),
    });
  }
  return openClawConfigSyncService;
};

const syncOpenClawConfig = (
  options: {
    reason: string;
    restartGatewayIfRunning?: boolean;
    discoverExternalMcpServers?: boolean;
    retiredProviderIds?: readonly string[];
  } = { reason: 'unknown' },
) => getOpenClawConfigSyncService().syncConfig(options);

const getLocalSpeechModelService = (): LocalSpeechModelService => {
  if (!localSpeechModelService) {
    localSpeechModelService = new LocalSpeechModelService({
      userDataPath: app.getPath('userData'),
      fetch: (url, init) => session.defaultSession.fetch(url, init),
      notify: status => {
        for (const window of BrowserWindow.getAllWindows()) {
          if (!window.isDestroyed()) window.webContents.send(LocalSpeechModelIpc.Changed, status);
        }
      },
      syncOpenClawConfig: async reason => {
        const result = await syncOpenClawConfig({ reason });
        if (!result.success) throw new Error(result.error || 'Failed to apply speech model.');
      },
    });
  }
  return localSpeechModelService;
};

const notifyBuiltinModelsChanged = (): void => {
  for (const window of BrowserWindow.getAllWindows()) {
    if (window.isDestroyed()) {
      continue;
    }
    try {
      window.webContents.send(BuiltinModelIpc.Changed);
    } catch (error) {
      console.error('[BuiltinModelLifecycle] Failed to notify Renderer:', error);
    }
  }
};

const getBuiltinModelLifecycle = (): BuiltinModelLifecycle => {
  if (!builtinModelLifecycle) {
    builtinModelLifecycle = new BuiltinModelLifecycle({
      getStore,
      syncOpenClawConfig,
      notifyModelsChanged: notifyBuiltinModelsChanged,
    });
  }
  return builtinModelLifecycle;
};

const getBuiltinModelTokenExchange = (): BuiltinModelTokenExchange => {
  builtinModelTokenExchange ??= new BuiltinModelTokenExchange({
    userInfoPath: resolveOutboundHeaderUserInfoPath(),
    deviceIdPath: path.join(app.getPath('userData'), 'huawei', 'model-device.json'),
    getConfig: getBuiltinModelAuthConfig,
    getDevelopmentApiKey: () => resolveBuiltinModelDevelopmentApiKey(
      getBuiltinModelAuthConfig(),
      app.isPackaged,
    ),
    fetch: (url, init) => mainProcessFetch(url, init, { maxResponseBytes: 32_768 }),
  });
  return builtinModelTokenExchange;
};

const getBuiltinModelAuthCoordinator = (): BuiltinModelAuthCoordinator => {
  builtinModelAuthCoordinator ??= new BuiltinModelAuthCoordinator({
    exchange: () => getBuiltinModelTokenExchange().refresh(),
    getActive: getActiveBuiltinModelCredential,
    login: () => getBuiltinModelLifecycle().refreshAfterLogin(),
    logout: () => getBuiltinModelLifecycle().refreshAfterLogout(),
  });
  return builtinModelAuthCoordinator;
};

const refreshBuiltinModelCredentialFromLoginFile = async (refreshCatalog = false) => {
  updateOutboundHeaderUserInfoCache();
  return getBuiltinModelAuthCoordinator().refresh(refreshCatalog);
};

// Authentication handlers should call these only after the Main process has
// committed the corresponding authenticated/logged-out state.
export const refreshAfterLogin = async (): Promise<void> => {
  getBuiltinModelTokenExchange().resume();
  await refreshBuiltinModelCredentialFromLoginFile(true);
  customerRegistrationService?.start();
  void customerRegistrationService?.sync();
};

export const refreshAfterLogout = (): Promise<void> => {
  customerRegistrationService?.stop();
  updateOutboundHeaderUserInfoCache();
  builtinModelTokenExchange?.suspend();
  clearActiveBuiltinModelCredential();
  return getBuiltinModelAuthCoordinator().logout();
};

const getCoworkEngineService = (): CoworkEngineService => {
  if (!coworkEngineService) {
    coworkEngineService = new CoworkEngineService({
      getCoworkStore,
      getOpenClawEngineManager,
      fetchSessionTitle: mainProcessTitleFetch,
      getUserDataPath: () => app.getPath('userData'),
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

const notifyCoworkSessionsChanged = (): void => {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send('cowork:sessions:changed');
  }
};

const getMulticaExternalSessionStore = (): MulticaExternalSessionStore => {
  multicaExternalSessionStore ??= new MulticaExternalSessionStore(getStore().getDatabase());
  return multicaExternalSessionStore;
};

const ensureMulticaBridgeRunning = async (): Promise<void> => {
  if (multicaBridgeServer?.running) return;
  if (multicaBridgeStartPromise) return multicaBridgeStartPromise;
  const candidate = new MulticaBridgeServer({
    userDataPath: app.getPath('userData'),
    commandService: getMulticaCommandService(),
  });
  multicaBridgeStartPromise = candidate
    .start()
    .then(() => {
      multicaBridgeServer = candidate;
    })
    .finally(() => {
      multicaBridgeStartPromise = null;
    });
  return multicaBridgeStartPromise;
};

const getMulticaIntegrationService = (): MulticaIntegrationService => {
  multicaIntegrationService ??= new MulticaIntegrationService({
    getStore,
    getBridgeState: () => ({
      running: multicaBridgeServer?.running === true,
      activeTaskCount: multicaBridgeServer?.activeTaskCount ?? 0,
    }),
    ensureBridgeRunning: ensureMulticaBridgeRunning,
    getOpenClawVersion: () => getOpenClawEngineManager().getStatus().version,
    getLauncherTarget: () => {
      if (process.platform === 'win32') {
        return {
          path: app.isPackaged
            ? resolvePackagedMulticaAgentExecutable(process.execPath)
            : resolveMulticaDevAgentExecutable(app.getAppPath(), app.getPath('userData')),
          args: [],
        };
      }
      return {
        path: app.isPackaged
          ? resolvePackagedMulticaTargetPath(process.execPath)
          : process.execPath,
        args: app.isPackaged
          ? [MULTICA_DEV_BRIDGE_SWITCH]
          : [app.getAppPath(), MULTICA_DEV_BRIDGE_SWITCH],
      };
    },
  });
  return multicaIntegrationService;
};

const getMulticaCommandService = (): MulticaCommandService => {
  multicaCommandService ??= new MulticaCommandService({
    getCoworkStore,
    getExternalSessionStore: getMulticaExternalSessionStore,
    getConfigPath: () => getOpenClawEngineManager().getConfigPath(),
    getOpenClawVersion: () => getOpenClawEngineManager().getStatus().version,
    runOpenClaw: (argv, cwd, taskEnv, signal) =>
      runMulticaOpenClaw(
        { buildCliEnvironment: () => getOpenClawEngineManager().buildCliEnvironment() },
        argv,
        cwd,
        taskEnv,
        signal,
      ),
    waitForConfigUpdates: waitForCoworkConfigUpdates,
    isEnabled: () => getMulticaIntegrationService().isEnabled(),
    onSessionsChanged: notifyCoworkSessionsChanged,
  });
  return multicaCommandService;
};

const getOpenClawSkillFiles = () => {
  if (!openClawSkillFileService) {
    openClawSkillFileService = new OpenClawSkillFileService({
      getOpenClawEngineManager,
      directoryOperations: getOpenClawDirectoryOperations(),
      runConfigMutationExclusive: operation =>
        getOpenClawConfigSyncService().runConfigMutationExclusive(operation),
    });
  }
  return openClawSkillFileService;
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
const IMAGE_PREVIEW_PRELOAD_PATH = app.isPackaged
  ? path.join(__dirname, 'imagePreviewPreload.js')
  : path.join(__dirname, '../dist-electron/imagePreviewPreload.js');
const BROWSER_GUEST_PRELOAD_PATH = app.isPackaged
  ? path.join(__dirname, 'browserGuestPreload.js')
  : path.join(__dirname, '../dist-electron/browserGuestPreload.js');

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
const browserAgentBridge = new BrowserAgentBridge(
  (channel, payload) => {
    if (!mainWindow?.isDestroyed() && !mainWindow?.webContents.isDestroyed()) {
      mainWindow.webContents.send(channel, payload);
    }
  },
  webContentsId => mainWindow?.webContents.id === webContentsId,
  sessionId => getCoworkStore().getSession(sessionId)?.cwd ?? null,
  true,
);
const embeddedBrowserRequests = new Map<
  string,
  { controller: AbortController; sessionKey: string }
>();
const completedEmbeddedBrowserRequests = new Set<string>();
let embeddedBrowserGatewayBound = false;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const rememberEmbeddedBrowserRequest = (requestId: string): void => {
  completedEmbeddedBrowserRequests.add(requestId);
  if (completedEmbeddedBrowserRequests.size <= 1_024) return;
  const oldestRequestId = completedEmbeddedBrowserRequests.values().next().value;
  if (oldestRequestId) completedEmbeddedBrowserRequests.delete(oldestRequestId);
};

const bindEmbeddedBrowserGateway = (): void => {
  if (embeddedBrowserGatewayBound) return;
  const runtimeAdapter = getOpenClawRuntimeAdapter();
  if (!runtimeAdapter) {
    throw new Error('OpenClaw runtime adapter was not initialized with the Cowork router.');
  }
  runtimeAdapter.on('gatewayEvent', event => {
    if (event.event === EmbeddedBrowserGateway.CANCELLED_EVENT) {
      const payload = isRecord(event.payload) ? event.payload : {};
      const requestId = typeof payload.requestId === 'string' ? payload.requestId.trim() : '';
      const sessionKey = typeof payload.sessionKey === 'string' ? payload.sessionKey.trim() : '';
      const pending = requestId ? embeddedBrowserRequests.get(requestId) : undefined;
      if (pending && pending.sessionKey === sessionKey) {
        pending.controller.abort();
        embeddedBrowserRequests.delete(requestId);
      }
      return;
    }
    if (event.event !== EmbeddedBrowserGateway.REQUESTED_EVENT) return;

    const payload = isRecord(event.payload) ? event.payload : {};
    const requestId = typeof payload.requestId === 'string' ? payload.requestId.trim() : '';
    const sessionKey = typeof payload.sessionKey === 'string' ? payload.sessionKey.trim() : '';
    const command = isRecord(payload.command) ? payload.command : null;
    const resolve = (response: Record<string, unknown>): Promise<unknown> =>
      runtimeAdapter.requestGateway(EmbeddedBrowserGateway.RESOLVE, {
        requestId,
        ...response,
      });

    if (
      !requestId ||
      embeddedBrowserRequests.has(requestId) ||
      completedEmbeddedBrowserRequests.has(requestId)
    ) {
      return;
    }
    if (!sessionKey || !command) {
      rememberEmbeddedBrowserRequest(requestId);
      if (requestId) {
        void resolve({ ok: false, error: 'Invalid embedded browser request.' }).catch(error => {
          console.warn('[BrowserAgentBridge] Failed to reject an invalid request:', String(error));
        });
      }
      return;
    }

    const controller = new AbortController();
    embeddedBrowserRequests.set(requestId, { controller, sessionKey });
    void browserAgentBridge
      .executeCommand(sessionKey, command, controller.signal)
      .then(result => {
        if (!controller.signal.aborted) return resolve({ ok: true, result });
        return undefined;
      })
      .catch(error => {
        if (controller.signal.aborted) return undefined;
        return resolve({
          ok: false,
          error: error instanceof Error ? error.message : 'Browser action failed.',
        });
      })
      .catch(error => {
        console.warn('[BrowserAgentBridge] Failed to resolve a browser request:', String(error));
      })
      .finally(() => {
        if (embeddedBrowserRequests.get(requestId)?.controller === controller) {
          embeddedBrowserRequests.delete(requestId);
        }
        rememberEmbeddedBrowserRequest(requestId);
      });
  });
  embeddedBrowserGatewayBound = true;
};

let lastReloadAt = 0;
const MIN_RELOAD_INTERVAL_MS = 5000;
const APP_UPDATE_CHECK_FREQUENCY_KEY = 'app_update_check_frequency';
const APP_UPDATE_LAST_AUTOMATIC_CHECK_AT_KEY = 'app_update_last_automatic_check_at';
type AppConfigSettings = {
  api?: unknown;
  browserMode?: unknown;
  browserDownloadDirectory?: unknown;
  browserAskDownloadLocation?: unknown;
  model?: unknown;
  theme?: string;
  language?: string;
  useSystemProxy?: boolean;
  proxy?: Partial<ProxySettings>;
  providers?: unknown;
  voice?: unknown;
};

const getOpenClawAppConfigSignature = (config: unknown): string => {
  const appConfig = (config ?? {}) as AppConfigSettings;
  const voice = normalizeLocalSpeechSettings(appConfig.voice);
  return JSON.stringify({
    api: appConfig.api,
    browserMode: appConfig.browserMode,
    model: appConfig.model,
    providers: appConfig.providers,
    voice: {
      outputEnabled: voice.outputEnabled,
      synthesisMode: voice.synthesisMode,
      ttsModelId: voice.ttsModelId,
      voiceId: voice.voiceId,
      speechRate: voice.speechRate,
      synthesisThreads: voice.synthesisThreads,
    },
  });
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

// Bridge subprocesses never join the UI singleton.
const gotTheLock = multicaBridgeArgv ? true : app.requestSingleInstanceLock();

if (multicaBridgeArgv) {
  void (async () => {
    let code = 70;
    try {
      code = await runMulticaBridgeClient(app.getPath('userData'), multicaBridgeArgv);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`${message}\n`);
    } finally {
      process.exitCode = code;
      setImmediate(() => app.exit(code));
    }
  })();
} else if (!gotTheLock) {
  app.quit();
} else {
  const releaseRuntimeDevLease = acquireOpenClawRuntimeDevLease({
    appPath: app.getAppPath(),
    isPackaged: app.isPackaged,
  });
  process.once('exit', releaseRuntimeDevLease);

  registerStoreHandlers({
    getStore,
    onAppConfigChanged: async (nextConfig, previousConfig) => {
      if (
        getOpenClawAppConfigSignature(nextConfig) === getOpenClawAppConfigSignature(previousConfig)
      ) {
        return;
      }
      const syncResult = await syncOpenClawConfig({
        reason: 'app-config-change',
        retiredProviderIds: listRetiredOpenClawProviderIds(
          (previousConfig as AppConfigSettings | undefined)?.providers,
          (nextConfig as AppConfigSettings | undefined)?.providers,
        ),
      });
      if (!syncResult.success) {
        console.error(
          '[OpenClaw] Failed to sync config after app_config update:',
          syncResult.error,
        );
        throw new Error(syncResult.error || 'Failed to apply OpenClaw configuration.');
      }
    },
    refreshBuiltinModels: async () => {
      const appConfig = getStore().get<{
        providers?: Record<string, unknown>;
      }>('app_config');
      if (!appConfig?.providers?.[ProviderName.BuiltinModels]) {
        console.warn(
          '[BuiltinModelLifecycle] Ignoring manual refresh because built-in model access is disabled.',
        );
        return;
      }
      await refreshAfterLogin();
    },
  });

  registerNetworkHandlers();
  registerLogHandlers();
  registerMulticaIntegrationHandlers(getMulticaIntegrationService);
  registerBrowserHandlers({
    getGatewayClient: () => getOpenClawRuntimeAdapter()?.getGatewayClient() ?? null,
    buildCliEnvironment: () => getOpenClawEngineManager().buildCliEnvironment(),
    hasActiveSessions: () => getCoworkEngineService().hasActiveSessions(),
    setBrowserMode: mode => {
      const store = getStore();
      return applyBrowserModeChange(mode, {
        readAppConfig: () => store.get<Record<string, unknown>>('app_config') ?? {},
        writeAppConfig: config => store.set('app_config', config),
        hasActiveSessions: () => getCoworkEngineService().hasActiveSessions(),
        syncConfig: reason => syncOpenClawConfig({ reason }),
        logError: (message, error) => console.error(`[BrowserSettings] ${message}`, error ?? ''),
      });
    },
  });
  browserAgentBridge.registerIpc();

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
  registerImagePreviewHandlers({
    devServerUrl,
    getIconPath: getAppIconPath,
    isDev,
    preloadPath: IMAGE_PREVIEW_PRELOAD_PATH,
  });

  registerOpenClawHistoryHandlers({
    requestGateway: <T>(method: string, params?: unknown) =>
      getCoworkEngineService().requestGateway<T>(method, params),
  });
  registerLocalTtsHandlers();
  registerOpenClawUsageHandlers({ getRuntime: getOpenClawRuntimeAdapter });
  registerOpenClawWorkboardHandlers({ getRuntime: getOpenClawRuntimeAdapter });
  registerOpenClawApprovalHandlers({ getRuntime: getOpenClawRuntimeAdapter });
  registerOpenClawMemoryHandlers({
    getManager: getOpenClawEngineManager,
    requestGateway: <T>(method: string, params?: unknown) =>
      getCoworkEngineService().requestGateway<T>(method, params),
  });
  registerOpenClawModelHandlers({ getRuntime: getOpenClawRuntimeAdapter });
  registerOnlineAsrHandlers({
    getRuntime: getOpenClawRuntimeAdapter,
    requestGateway: <T>(method: string, params?: unknown) =>
      getCoworkEngineService().requestGateway<T>(method, params),
    runConfigMutationExclusive: operation =>
      getOpenClawConfigSyncService().runConfigMutationExclusive(operation),
  });
  registerOnlineTtsHandlers({
    getRuntime: getOpenClawRuntimeAdapter,
    requestGateway: <T>(method: string, params?: unknown) =>
      getCoworkEngineService().requestGateway<T>(method, params),
    runConfigMutationExclusive: operation =>
      getOpenClawConfigSyncService().runConfigMutationExclusive(operation),
  });
  registerSpeechSynthesisHandlers({
    getSettings: () => normalizeLocalSpeechSettings(
      getStore().get<AppConfigSettings>('app_config')?.voice,
    ),
    requestGateway: <T>(method: string, params?: unknown) =>
      getCoworkEngineService().requestGateway<T>(method, params),
  });
  registerMediaGenerationModelHandlers({
    getRuntime: getOpenClawRuntimeAdapter,
    requestGateway: <T>(method: string, params?: unknown) =>
      getCoworkEngineService().requestGateway<T>(method, params),
    runConfigMutationExclusive: operation =>
      getOpenClawConfigSyncService().runConfigMutationExclusive(operation),
  });

  registerSlashCommandHandlers({
    getGatewayClient: () => getOpenClawRuntimeAdapter()?.getGatewayClient() ?? null,
    policies: [justDoSlashCommandPolicy],
  });
  registerSkillHandlers({
    skillService: openClawSkillService,
    skillFileService: getOpenClawSkillFiles(),
    installationService: pluginInstallationService,
    getOpenClawEngineManager,
    onMarketplacePluginDeleted: (kind, runtimeId, installPath) =>
      pluginManager.forgetMarketplaceInstallation(kind, runtimeId, installPath),
  });
  registerMarketplaceHandlers(pluginManager);
  registerExtensionHandlers({
    extensionImportService: getOpenClawExtensionImportService(),
    installationService: pluginInstallationService,
    onMarketplacePluginDeleted: (kind, runtimeId) =>
      pluginManager.forgetMarketplaceInstallation(kind, runtimeId),
  });
  registerHookHandlers({
    getStore: getHookStore,
    requestGateway: <T>(method: string, params?: unknown) =>
      getCoworkEngineService().requestGateway<T>(method, params),
    syncConfig: syncHookConfig,
    installationService: pluginInstallationService,
  });

  registerOpenClawEngineHandlers({
    getManager: getOpenClawEngineManager,
    requestGateway: <T>(method: string, params?: unknown) =>
      getCoworkEngineService().requestGateway<T>(method, params),
    reconnectGatewayClient: () => getCoworkEngineService().reconnectGatewayClient(),
  });

  registerMcpHandlers({
    getStore: getMcpStore,
    syncConfig: syncMcpConfig,
    probeServer: probeMcpServer,
    readResource: readMcpResource,
    listExtensionServers: () => discoverExtensionMcpServers(getOpenClawEngineManager()),
    discoverExternalServers: () => {
      const discovered = discoverOpenClawManagedMcpServers(
        getOpenClawEngineManager().getConfigPath(),
        getMcpStore(),
      );
      if (discovered > 0) {
        console.log(`[OpenClawMcp] discovered ${discovered} externally installed server(s)`);
      }
    },
    installationService: pluginInstallationService,
    onMarketplacePluginDeleted: (kind, runtimeId) =>
      pluginManager.forgetMarketplaceInstallation(kind, runtimeId),
  });

  const sessionPermissionModeCoordinator = new SessionPermissionModeCoordinator({
    getCoworkStore,
    isSessionActive: sessionId => getCoworkEngineRouter().isSessionActive(sessionId),
    prepareSession: async options => {
      await getCoworkEngineRouter().prepareSession(options.sessionId, options);
    },
  });
  const applyDeferredSessionPermissionMode = (sessionId: string): void => {
    void sessionPermissionModeCoordinator
      .applyPendingSessionMode(sessionId)
      .then(result => {
        if (!result.success || result.deferred) {
          const errorSuffix = 'error' in result ? `: ${result.error}` : '.';
          console.warn(
            `[OpenClaw] Failed to apply the deferred permission mode for session ${sessionId}${errorSuffix}`,
          );
        }
      })
      .catch(error => {
        console.warn(
          `[OpenClaw] Failed to read the deferred permission mode for session ${sessionId}: ${String(error)}`,
        );
      });
  };
  let sessionPermissionModeRuntimeBound = false;
  const bindSessionPermissionModeRuntime = (): void => {
    if (sessionPermissionModeRuntimeBound) return;
    const router = getCoworkEngineRouter();
    const runtimeAdapter = getOpenClawRuntimeAdapter();
    if (!runtimeAdapter) {
      throw new Error('OpenClaw runtime adapter was not initialized with the Cowork router.');
    }
    runtimeAdapter.setContinuationPermissionPreparer(async sessionId => {
      const result = await sessionPermissionModeCoordinator.prepareSessionForRun(sessionId);
      if (!result.success) {
        throw new Error(
          'error' in result ? result.error : 'Failed to prepare session permissions.',
        );
      }
    });
    router.on('complete', applyDeferredSessionPermissionMode);
    router.on('error', applyDeferredSessionPermissionMode);
    router.on('sessionStopped', applyDeferredSessionPermissionMode);
    sessionPermissionModeRuntimeBound = true;
  };

  registerCoworkSessionExecutionHandlers({
    ensureEngineRunning: ensureOpenClawRunningForCowork,
    getCoworkStore,
    getCoworkEngineRouter,
    waitForConfigUpdates: waitForCoworkConfigUpdates,
    getEngineNotReadyResponse,
  });

  registerCoworkSessionHandlers({
    getCollaboration: () => bindCollaboration.coordinator(),
    getCoworkStore,
    getCoworkEngineRouter,
    requestGateway: <T>(method: string, params?: unknown) =>
      getCoworkEngineService().requestGateway<T>(method, params),
    setSessionPermissionMode: (sessionId, permissionMode, options) =>
      sessionPermissionModeCoordinator.setSessionMode(sessionId, permissionMode, options),
  });

  registerCoworkSessionRuntimeHandlers({
    getCoworkStore,
    getCoworkEngineRouter,
    getRuntime: getOpenClawRuntimeAdapter,
  });

  registerSessionGroupHandlers(getGroupStore);

  registerCoworkSubtaskHandlers({
    getRuntime: getOpenClawRuntimeAdapter,
  });

  const nativeAssistantCreation = new NativeAssistantCreation({
    getDatabase: () => getStore().getDatabase(),
    getStore: getCoworkStore,
    getStateDir: () => getOpenClawEngineManager().getStateDir(),
    exclusive: operation => getOpenClawConfigSyncService().runConfigMutationExclusive(operation),
    requestGateway: <T>(method: string, params?: unknown) =>
      getCoworkEngineService().requestGateway<T>(method, params),
    onChanged: notifyCoworkSessionsChanged,
  });
  const bindCollaboration = registerCollaborationHandlers({
    createAssistant: (input, identity, assertActive) => nativeAssistantCreation.create(input, identity, assertActive),
    onSessionsChanged: notifyCoworkSessionsChanged,
    getDatabase: () => getStore().getDatabase(),
    getStore: getCoworkStore,
    getRouter: getCoworkEngineRouter,
    getRuntime: getOpenClawRuntimeAdapter,
    requestGateway: <T>(method: string, params?: unknown) =>
      getCoworkEngineService().requestGateway<T>(method, params),
  });

  registerAgentHandlers({
    getStore: getCoworkStore,
    syncConfig: () => syncOpenClawConfig({ reason: 'agent-profile-change' }),
    requestGateway: <T>(method: string, params?: unknown) =>
      getCoworkEngineService().requestGateway<T>(method, params),
  });

  registerCoworkInteractionHandlers({
    getRuntime: getOpenClawRuntimeAdapter,
  });

  registerCoworkConfigHandlers({
    getCoworkStore,
    getCoworkEngineRouter,
    getEngineManager: getOpenClawEngineManager,
    syncOpenClawConfig,
    ensureEngineRunning: ensureOpenClawRunningForCowork,
    requestGateway: <T>(method: string, params?: unknown) =>
      getCoworkEngineService().requestGateway<T>(method, params),
    getWindowsSandboxService,
    engineNotReadyCode: ENGINE_NOT_READY_CODE,
  });

  registerWindowsSandboxHandlers({
    getCoworkStore,
    getWindowsSandboxService,
  });

  registerDefaultModelHandlers({
    getStore,
    getCoworkStore,
    syncOpenClawConfig,
  });

  // ==================== Scheduled Task IPC Handlers (OpenClaw) ====================

  initCronJobServiceManager({
    getOpenClawRuntimeAdapter,
    getDatabase: () => getStore().getDatabase(),
    getOpenClawStateDir: () => getOpenClawEngineManager().getStateDir(),
  });
  registerScheduledTaskHandlers({
    getCronJobService,
    getOpenClawRuntimeAdapter,
    getResultStore: getScheduledTaskResultStore,
    getResultSyncService: getScheduledTaskResultSyncService,
  });

  registerCalendarPermissionHandlers(isDev);

  registerCoworkUtilityHandlers({
    getTitleGenerator: getCoworkEngineRouter,
    listRecentCwds: limit => getCoworkStore().listRecentCwds(limit),
  });

  registerDialogHandlers();
  registerLocalFileHandlers();
  registerLocalAsrHandlers();
  registerLocalSpeechModelHandlers({ getService: getLocalSpeechModelService });

  registerShellHandlers({
    resolveWorkspaceRoot: sessionId =>
      sessionId === HOME_WORKSPACE_SESSION_ID
        ? getCoworkStore().getConfig().workingDirectory
        : getCoworkStore().getSession(sessionId)?.cwd,
  });
  registerTerminalHandlers({
    buildEnvironment: async () => (await getOpenClawEngineManager().buildCliEnvironment()).env,
  });

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
      devServerUrl,
      getBackgroundColor: () =>
        getInitialTheme() === 'dark' ? TITLEBAR_COLORS.dark.color : '#F8F9FB',
      getIconPath: getAppIconPath,
      browserGuestPreloadPath: BROWSER_GUEST_PRELOAD_PATH,
      getBrowserDownloadSettings: () => {
        const config = getStore().get<AppConfigSettings>('app_config');
        return normalizeBrowserDownloadSettings({
          directory: config?.browserDownloadDirectory,
          askWhereToSave: config?.browserAskDownloadLocation,
        });
      },
      getProxyCredentials: () => {
        const proxy = getStore().get<AppConfigSettings>('app_config')?.proxy;
        const custom = proxy?.custom;
        const port = Number(custom?.port);
        if (
          proxy?.mode !== 'custom' ||
          !custom?.host?.trim() ||
          !custom.username?.trim() ||
          !Number.isInteger(port) ||
          port < 1 ||
          port > 65_535
        ) {
          return null;
        }
        return {
          host: custom.host.trim(),
          port,
          username: custom.username.trim(),
          password: custom.password ?? '',
        };
      },
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
    devSessionLifecycle?.stop();
    console.log('[Main] App is quitting, starting cleanup...');
    builtinModelCredentialMonitor?.stop();
    customerRegistrationService?.stop();
    builtinModelTokenExchange?.invalidate();
    builtinModelAuthCoordinator?.initialize(null);
    clearActiveBuiltinModelCredential();
    await clearBrowserExtensionAppServer(app.getPath('userData')).catch(error => {
      console.warn('[BrowserExtensionChat] Failed to clear app-server rendezvous:', error);
    });
    await browserExtensionChatServer?.stop();
    browserExtensionChatServer = null;
    destroyTray();
    if (multicaBridgeServer) {
      await multicaBridgeServer.stop().catch(error => {
        console.error('[MulticaBridge] Failed to stop:', error);
      });
      multicaBridgeServer = null;
    }
    // Prevent scheduled work from starting while dependent runtimes are draining.
    try {
      getCronJobService().stopPolling();
    } catch {
      // CronJobService may not have been initialized — safe to ignore.
    }
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
    await browserAgentBridge.stop();

    outboundHeaderProxy?.stop();

    // Close the SQLite database to flush the WAL and release the file lock.
    try {
      getStore().close();
    } catch {
      // Store may not have been initialized — safe to ignore.
    }
  };

  const appShutdown = registerAppShutdown({
    cleanup: runAppCleanup,
    cleanupTimeoutMs: isDev && !app.isPackaged ? 10_000 : undefined,
    onCleanupTimeout: async () => {
      await openClawEngineManager?.stopGateway();
    },
  });
  const devSessionLifecycle =
    isDev && !app.isPackaged
      ? createDevSessionLifecycle(() => {
          console.log('[Main] Development server stopped; quitting application.');
          app.quit();
        })
      : null;
  devSessionLifecycle?.follow(devServerUrl);
  app.on('second-instance', (_event, commandLine) => {
    if (commandLine.includes(INSTALLER_QUIT_SWITCH)) {
      console.log('[Main] Installer requested a graceful shutdown.');
      app.quit();
      return;
    }
    if (commandLine.includes(BROWSER_EXTENSION_RESTART_SWITCH)) {
      const server = browserExtensionChatServer;
      if (server && !browserExtensionChatServerRestartPromise) {
        const restartPromise = (async () => {
          try {
            await server.restart();
            await publishBrowserExtensionAppServer(app.getPath('userData'), server.getCapability());
          } catch (error) {
            console.error('[BrowserExtensionChat] Failed to restart app-server:', error);
          }
        })();
        browserExtensionChatServerRestartPromise = restartPromise;
        void restartPromise.finally(() => {
          if (browserExtensionChatServerRestartPromise === restartPromise) {
            browserExtensionChatServerRestartPromise = null;
          }
        });
      }
      return;
    }

    const handedOffDevServerUrl = isDev ? getDevServerUrlFromCommandLine(commandLine) : null;
    if (handedOffDevServerUrl) {
      const existingWindow = mainWindow;
      devServerUrl = handedOffDevServerUrl;
      devSessionLifecycle?.follow(handedOffDevServerUrl);
      console.log(`[Main] Switching existing development window to ${handedOffDevServerUrl}`);
      createWindow();
      if (existingWindow && mainWindow && !mainWindow.isDestroyed()) {
        void mainWindow.webContents.loadURL(handedOffDevServerUrl).catch(error => {
          console.error('[Main] Failed to load handed-off development server:', error);
        });
      }
      return;
    }
    if (isDev && commandLine.some(value => value.startsWith(`${DEV_SERVER_URL_SWITCH}=`))) {
      console.warn('[Main] Ignored an invalid development server handoff URL.');
    }
    createWindow();
  });
  const autoUpdateService = new AutoUpdateService({
    currentVersion: app.getVersion(),
    enabled: isNsisInstalledApp({
      isPackaged: app.isPackaged,
      platform: process.platform,
      resourcesPath: process.resourcesPath,
    }),
    getWindows: () => BrowserWindow.getAllWindows(),
    installAfterCleanup: installUpdate => appShutdown.quitAndInstall(installUpdate),
    recoverAfterInstallFailure: () => {
      console.error('[AutoUpdate] Restarting the app after update installation failure.');
      app.relaunch();
      app.exit(1);
    },
    getCheckFrequency: () => getStore().get(APP_UPDATE_CHECK_FREQUENCY_KEY),
    setCheckFrequency: frequency => getStore().set(APP_UPDATE_CHECK_FREQUENCY_KEY, frequency),
    getLastAutomaticCheckAt: () => getStore().get(APP_UPDATE_LAST_AUTOMATIC_CHECK_AT_KEY),
    setLastAutomaticCheckAt: checkedAt =>
      getStore().set(APP_UPDATE_LAST_AUTOMATIC_CHECK_AT_KEY, checkedAt),
    releaseHistoryUrl: new URL(
      'release-history.json',
      `${APP_UPDATE_CONFIG.feedUrl.replace(/\/+$/, '')}/`,
    ).toString(),
    fetchReleaseHistory: (requestUrl, init) =>
      mainProcessFetch(requestUrl, init, {
        maxResponseBytes: APP_UPDATE_CONFIG.releaseHistory.maxBytes,
      }),
  });
  registerAutoUpdateHandlers(autoUpdateService);

  // 初始化应用
  const initApp = async () => {
    await app.whenReady();

    store = await initStore();
    const browserExtensionChatToken = randomBytes(32).toString('hex');
    const extensionChatServer = new BrowserExtensionChatServer(
      new BrowserExtensionChatController({
        ensureEngineRunning: ensureOpenClawRunningForCowork,
        getStore: getCoworkStore,
        getRouter: getCoworkEngineRouter,
        getRuntime: getOpenClawRuntimeAdapter,
        getDefaultModelRef: resolveDefaultAgentModelRef,
        readAssistantMedia: request =>
          readOpenClawAssistantMedia(getOpenClawEngineManager(), request),
      }),
      browserExtensionChatToken,
      packageJson.version,
    );
    try {
      await extensionChatServer.start();
      browserExtensionChatServer = extensionChatServer;
      await publishBrowserExtensionAppServer(
        app.getPath('userData'),
        extensionChatServer.getCapability(),
      );
      if (app.isPackaged) {
        await registerBrowserExtensionNativeHost(
          app.getPath('userData'),
          process.execPath,
          path.join(
            process.resourcesPath,
            'browser-extension',
            'native-host',
            'justdo-browser-extension-native-host-v2.exe',
          ),
        );
      }
      console.info('[BrowserExtensionChat] WebSocket app-server is listening on loopback.');
    } catch (error) {
      console.error('[BrowserExtensionChat] Failed to start loopback service:', error);
    }
    const initialOutboundHeaderPolicy = getOutboundHeaderPolicyService().reconcile();
    await getOutboundHeaderProxy().start();
    activeOutboundHeaderPolicyDigest = initialOutboundHeaderPolicy.digest;


    // Note: Calendar permission is checked on-demand when calendar operations are requested
    // We don't trigger permission dialogs at startup to avoid annoying users

    // Ensure default working directory exists
    const defaultProjectDir = path.join(os.homedir(), DEFAULT_WORKSPACE_DIRECTORY_NAME, 'project');
    if (!fs.existsSync(defaultProjectDir)) {
      fs.mkdirSync(defaultProjectDir, { recursive: true });
      console.log('Created default project directory:', defaultProjectDir);
    }

    // 注册 localfile:// 自定义协议，用于安全加载本地文件（图片等）
    registerLocalFileProtocol();

    // Open receipts belong to the previous app process. Checkpoint them as
    // interrupted so startup does not present stale work as running. Runtime
    // reconciliation reopens a checkpoint if Gateway still reports active work.
    const interruptedRunCount = getCoworkStore().interruptOpenSessionRuns(Date.now());
    if (interruptedRunCount > 0) {
      console.log(`[Main] Interrupted ${interruptedRunCount} stale cowork run receipt(s)`);
    }
    // Defensive recovery: app may be force-closed during execution and leave
    // stale running flags in DB. Normalize them on startup.
    const resetCount = getCoworkStore().resetRunningSessions();
    if (resetCount > 0) {
      console.log(`[Main] Reset ${resetCount} stuck cowork session(s) from running -> idle`);
    }
    const resetExternalCount = getMulticaExternalSessionStore().resetRunning();
    if (resetExternalCount > 0) {
      console.log(
        `[MulticaBridge] Reset ${resetExternalCount} interrupted external session(s) to cancelled`,
      );
    }
    // Inject store getter into providerApiConfig
    setStoreGetter(() => store);

    // Restore proxy routing before refreshing the built-in provider. Its model
    // endpoint may require the saved system/custom proxy to be reachable.
    bindOpenClawGatewayPortProxyBypass();
    const appConfig = getStore().get<AppConfigSettings>('app_config');
    await applySystemProxyPreference(appConfig);

    let builtinModelCredential: BuiltinModelCredential | null = null;
    try {
      builtinModelCredential = await getBuiltinModelTokenExchange().refresh();
    } catch {
      console.warn('[BuiltinModelTokenExchange] Startup exchange failed; retrying in background.');
    }

    await syncBuiltinModelProvider(store, {
      access: builtinModelCredential ? BuiltinModelAccess.Enabled : BuiltinModelAccess.Disabled,
    });

    const coworkEngineRouter = getCoworkEngineRouter();
    bindEmbeddedBrowserGateway();
    bindCollaboration();
    bindSessionPermissionModeRuntime();
    bindCoworkRuntimeForwarder(coworkEngineRouter, getCoworkStore);
    coworkEngineRouter.on('cronChanged', payload => {
      void getCronJobService()
        .reconcileGatewayChange(payload)
        .catch(error => {
          console.warn('[CronJobService] Failed to reconcile OpenClaw cron change:', error);
        });
    });
    coworkEngineRouter.on('workboardChanged', payload => {
      BrowserWindow.getAllWindows().forEach(window => {
        if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
          window.webContents.send(WorkboardIpc.Changed, payload);
        }
      });
    });
    coworkEngineRouter.on('taskChanged', event => {
      BrowserWindow.getAllWindows().forEach(window => {
        if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
          window.webContents.send(CoworkSubagentDetailsIpc.Changed, event);
        }
      });
    });
    bindOpenClawStatusForwarder();

    // Empty agent models intentionally inherit the application default.
    const qualifiedAgentModels = migrateAgentModelRefs();
    if (qualifiedAgentModels > 0) {
      console.log(`[Main] migrated agent model bindings: qualified=${qualifiedAgentModels}`);
    }

    let startupSync = await syncOpenClawConfig({
      reason: 'startup',
    });
    if (startupSync.success && !builtinModelCredential) {
      startupSync = await syncOpenClawConfig({
        reason: BuiltinModelSyncReason.AuthLogout,
      });
    }
    if (!startupSync.success) {
      console.error('[OpenClaw] Startup config sync failed:', startupSync.error);
    }

    await ensureMulticaBridgeRunning().catch(error => {
      console.error('[MulticaBridge] Failed to start:', error);
      multicaBridgeServer = null;
    });

    if (startupSync.success) {
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

    builtinModelCredentialMonitor = new BuiltinModelCredentialMonitor({
      userInfoPath: resolveOutboundHeaderUserInfoPath(),
      refresh: refreshBuiltinModelCredentialFromLoginFile,
      onError: error => {
        console.error('[BuiltinModelCredentialMonitor] Credential refresh failed:', error);
      },
    });
    getBuiltinModelAuthCoordinator().initialize(startupSync.success ? builtinModelCredential : null);
    builtinModelCredentialMonitor.start(builtinModelCredential);
    if (BUILTIN_MODEL_PROVIDER_CONFIG.enabled && ACTIVITY_REPORTING_CONFIG.enabled) {
      customerRegistrationService = new CustomerRegistrationService({
        getCredential: getActiveBuiltinModelCredential,
        baseUrl: BUILTIN_MODEL_PROVIDER_CONFIG.baseUrl,
        productName: APP_NAME,
        version: app.getVersion(),
        userInfoPath: resolveOutboundHeaderUserInfoPath(),
      });
      customerRegistrationService.start();
    }

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
      devServerPort: Number(process.env.JUSTDO_DEV_SERVER_PORT || packageJson.devServer.port),
    });

    // 创建窗口
    createWindow();
    autoUpdateService.scheduleAutomaticChecks();

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

      const providerRenameAliases = buildCustomProviderRenameAliases(
        oldConfig?.providers,
        newConfig?.providers,
      );
      if (Object.keys(providerRenameAliases).length > 0) {
        const renamed = getCoworkStore().renameCurrentModelProviderRefs(providerRenameAliases);
        console.info(
          `[OpenClaw] Updated current model refs after provider rename: agents=${renamed.agents}, sessions=${renamed.sessions}, runtimeSettings=${renamed.runtimeSettings}`,
        );
      }

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
        void applySystemProxyPreference(newConfig).then(isLatest => {
          if (!isLatest) return;
          const manager = getOpenClawEngineManager();
          const phase = manager.getStatus().phase;
          if (phase === 'running' || phase === 'starting') {
            void getOpenClawConfigSyncService()
              .restartGatewayWhenIdle('proxy-change')
              .catch(async error => {
                console.error('[OpenClaw] Failed to restart Gateway after proxy change:', error);
                await getOpenClawEngineManager()
                  .stopGateway()
                  .catch(stopError => {
                    console.error(
                      '[OpenClaw] Failed to stop Gateway after runtime adapter reconnect failure:',
                      stopError,
                    );
                  });
              });
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
