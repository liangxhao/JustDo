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
import path from 'path';

import packageJson from '../../package.json';
import { ACTIVITY_REPORTING_CONFIG } from '../config/activityReporting';
import { APP_UPDATE_CONFIG } from '../config/appUpdate';
import { BUILTIN_MODEL_PROVIDER_CONFIG } from '../config/builtinModels';
import { AuthIpc } from '../shared/app/auth';
import {
  AppInitializationActivity,
  AppInitializationIpc,
  AppInitializationPhase,
  AppInitializationStep,
  AppInitializationTask,
  AppInitializationTaskStatus,
} from '../shared/app/initialization';
import { SHUTDOWN_BUDGET_MS } from '../shared/app/shutdownPolicy';
import { StartupRoute } from '../shared/app/startup/routing';
import { BrowserMode, normalizeBrowserDownloadSettings, normalizeBrowserMode } from '../shared/browser/browser';
import { EmbeddedBrowserGateway } from '../shared/browser/embeddedBrowser';
import { buildCoworkSessionKey } from '../shared/cowork/sessionKey';
import { CoworkSubagentDetailsIpc } from '../shared/cowork/subagentDetails';
import { SwarmWorkflowIpc } from '../shared/cowork/swarm-workflow';
import {
  WORKSPACE_WINDOW_BOUNDS_KEY,
  type WorkspaceWindowBounds,
} from '../shared/cowork/workspaceWindow';
import type { ProxySettings } from '../shared/network/proxy';
import { EnginePhase } from '../shared/openclaw/engineStatus';
import { WorkboardIpc } from '../shared/openclaw/workboard';
import { OpenClawExtensionId } from '../shared/plugins/nativeIds';
import { HOME_WORKSPACE_SESSION_ID } from '../shared/preview/filePreview';
import { USER_DATA_DIRECTORY_NAME } from '../shared/productMetadata';
import {
  buildCustomProviderRenameAliases,
  listRetiredOpenClawProviderIds,
  ProviderName,
} from '../shared/providers';
import { BuiltinModelIpc, BuiltinModelSyncReason } from '../shared/providers/builtinModels';
import { normalizeLocalSpeechExtensionSettings } from '../shared/speech/localSpeechExtensionSettings';
import { LocalSpeechModelIpc } from '../shared/speech/localSpeechModels';
import { normalizeLocalSpeechSettings } from '../shared/speech/localSpeechSettings';
import { AppServerIntegrationService } from './appServer/appServerIntegrationService';
import { waitForAppServerShutdown } from './appServer/appServerShutdown';
import { BrowserAgentBridge } from './browser/browserAgentBridge';
import { EmbeddedBrowserGatewayBridge } from './browser/embeddedBrowserGatewayBridge';
import { BrowserExtensionChatController } from './browser/extension/browserExtensionChatController';
import { BrowserExtensionChatServer } from './browser/extension/browserExtensionChatServer';
import {
  BROWSER_EXTENSION_RESTART_SWITCH,
  clearBrowserExtensionAppServer,
  publishBrowserExtensionAppServer,
  registerBrowserExtensionNativeHost,
} from './browser/extension/browserExtensionNativeMessaging';
import { readAutomaticBrowserExtensionPairing } from './browser/extension/browserExtensionPairing';
import { captureWebpageEmbedConnection } from './chat/embed/webpageEmbedConnection';
import { AppInitialization } from './core/app/appInitialization';
import { registerAppShutdown } from './core/app/appShutdown';
import { createLoginSdkAdapter } from './core/app/auth/loginSdkAdapter';
import { LoginService } from './core/app/auth/loginService';
import { LoginUserInfoStore } from './core/app/auth/loginUserInfoStore';
import { isAutoLaunched } from './core/app/autoLaunchManager';
import { AutoUpdateService } from './core/app/autoUpdateService';
import { runApplicationCleanup, settleCleanupTasks } from './core/app/cleanupPhases';
import { CustomerRegistrationService } from './core/app/customerRegistrationService';
import { isNsisInstalledApp } from './core/app/installedApp';
import { createTray, destroyTray, updateTrayMenu } from './core/app/trayManager';
import { resolveAppUpdateResourceUrl } from './core/app/updateResourceUrl';
import { APP_NAME, DEV_SERVER_URL_SWITCH, INSTALLER_QUIT_SWITCH } from './core/appConstants';
import { resolveDevelopmentDataDirectory } from './core/development/developmentDataDirectory';
import { getDevServerUrlFromCommandLine } from './core/development/devServerHandoff';
import {
  bindDevelopmentParentShutdown,
  createDevSessionLifecycle,
} from './core/development/devSessionLifecycle';
import { ManagedDirectoryOperationCoordinator } from './core/filesystem/managedDirectoryOperations';
import { setLanguage, t } from './core/i18n';
import { getLogFilePath, getRecentMainLogEntries, initLogger } from './core/logger';
import { mainProcessFetch, mainProcessTitleFetch } from './core/network/mainProcessFetch';
import {
  resolveOutboundHeaderUserInfoPath,
  updateOutboundHeaderUserInfoCache,
} from './core/network/outboundHeaderPolicyConfig';
import { OutboundHeaderPolicyService } from './core/network/outboundHeaderPolicyService';
import { OutboundHeaderProxy } from './core/network/outboundHeaderProxy';
import { isLoopbackBaseUrl, setProcessProxyRouting } from './core/network/systemProxy';
import {
  applyBrowserProxyPreference,
  applySystemProxyPreference,
  getBrowserProxyPreferenceSignature,
  getProxyPreferenceSignature,
} from './core/network/systemProxyPreference';
import { enableSystemCaForCurrentProcess } from './core/network/trustedCertificates';
import { applyDependencyManagerConfigEnv } from './core/runtime/dependencyManagerConfig';
import { ensurePythonRuntimeReady } from './core/runtime/pythonRuntime';
import { bindComputerOverlay } from './core/window/computer/bindComputerOverlay';
import { registerContentSecurityPolicy } from './core/window/contentSecurityPolicy';
import {
  createInitializationWindow,
  type InitializationWindow,
} from './core/window/initializationWindow';
import {
  registerLocalFileProtocol,
  registerLocalFileScheme,
} from './core/window/localFileProtocol';
import { createMainWindow } from './core/window/mainWindowFactory';
import { createStartupBootstrapWindow } from './core/window/startupBootstrapWindow';
import { StartupWindowHandoff } from './core/window/startupWindowHandoff';
import {
  getWorkspaceWindowManager,
  isWorkspaceBrowserHost,
} from './core/window/workspaceWindowManager';
import { AgentTeamLaunchCoordinator } from './cowork/agent-team/agentTeamLaunchCoordinator';
import { orderDiagnosticMainLogs } from './cowork/diagnostics/logSources';
import { readDiagnosticRuntimeArtifact } from './cowork/diagnostics/runtimeInfo';
import { SessionDiagnosticsService } from './cowork/diagnostics/service';
import { CoworkStore, getDefaultWorkingDirectory } from './data/coworkStore';
import { GroupStore } from './data/groupStore';
import { SessionDiagnosticsStore } from './data/sessionDiagnosticsStore';
import { SqliteStore } from './data/sqliteStore';
import { CoworkEngineService } from './engine';
import { bindCoworkRuntimeForwarder } from './engine/cowork/coworkRuntimeForwarder';
import type { GatewayRequestOptions } from './engine/types';
import {
  resolveDevelopmentAgentCliExecutable,
  resolvePackagedAgentCliExecutable,
} from './integrations/externalAgent/agentCliDevLauncher';
import { AgentCliIntegrationService } from './integrations/externalAgent/agentCliIntegrationService';
import {
  buildAgentCliBridgeArguments,
  ensureAgentCliCommandLauncher,
  resolvePackagedAgentCliTargetPath,
} from './integrations/externalAgent/agentCliLauncher';
import { AgentCommandService } from './integrations/externalAgent/agentCommandService';
import { ExternalAgentBackendFactory } from './integrations/externalAgent/externalAgentBackend';
import { createExternalAgentExecution } from './integrations/externalAgent/externalAgentExecution';
import { getExternalAgentModelCatalog } from './integrations/externalAgent/externalAgentModelCatalog';
import { ExternalAgentResources } from './integrations/externalAgent/externalAgentResources';
import { ExternalSessionStore } from './integrations/externalAgent/externalSessionStore';
import { runAgentBridgeClient } from './integrations/externalAgent/transport/agentBridgeClient';
import {
  parseAgentBridgeArgv,
  resolveAgentBridgeProfile,
} from './integrations/externalAgent/transport/agentBridgeProtocol';
import { AgentBridgeServer } from './integrations/externalAgent/transport/agentBridgeServer';
import { registerAgentCliIntegrationHandlers } from './ipc/agentCli';
import {
  applyBrowserModeChange,
  registerAppHandlers,
  registerAuthHandlers,
  registerAutoUpdateHandlers,
  registerBrowserHandlers,
  registerCalendarPermissionHandlers,
  registerDialogHandlers,
  registerImagePreviewHandlers,
  registerLocalFileHandlers,
  registerLogHandlers,
  registerNetworkHandlers,
  registerShellHandlers,
  registerStoreHandlers,
  registerTerminalHandlers,
  registerWindowHandlers,
  registerWorkspaceWindowHandlers,
} from './ipc/app';
import { registerAppInitializationHandlers } from './ipc/app/initialization';
import { registerAppServerIntegrationHandlers } from './ipc/appServer';
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
  registerSwarmWorkflowHandlers,
  registerWindowsSandboxHandlers,
  waitForCoworkConfigUpdates,
} from './ipc/cowork';
import { registerAgentTeamSettingsHandlers } from './ipc/cowork/agent-team/agentTeamSettings';
import { registerCollaborationHandlers } from './ipc/cowork/agent-team/collaboration';
import { registerTeamDiscussionHandlers } from './ipc/cowork/agent-team/teamDiscussion';
import { registerSessionDiagnosticsHandlers } from './ipc/cowork/sessionDiagnostics';
import { registerSessionReviewHandlers } from './ipc/cowork/sessionReview';
import {
  registerOpenClawEngineHandlers,
  registerOpenClawHistoryHandlers,
  registerOpenClawMemoryHandlers,
  registerOpenClawModelHandlers,
  registerOpenClawUsageHandlers,
  registerSlashCommandHandlers,
} from './ipc/openclaw';
import { readOpenClawAssistantMedia } from './ipc/openclaw/engine';
import { registerEngineDiagnosticsHandlers } from './ipc/openclaw/engineDiagnostics';
import {
  authorizeManagedMediaPlaybackRequest,
  handleManagedMediaPlaybackRequest,
  registerManagedMediaPlaybackHandlers,
} from './ipc/openclaw/managedMediaPlayback';
import {
  registerExtensionHandlers,
  registerHookHandlers,
  registerMarketplaceHandlers,
  registerMcpHandlers,
  registerOpenClawWorkboardHandlers,
  registerSkillHandlers,
  registerSkillWorkshopHandlers,
} from './ipc/plugins';
import { registerMediaGenerationModelHandlers } from './ipc/providers/mediaGenerationModels';
import {
  getCronJobService,
  getScheduledTaskResultStore,
  getScheduledTaskResultSyncService,
  initCronJobServiceManager,
  registerScheduledTaskHandlers,
} from './ipc/scheduledTask';
import { registerComputerControlHandlers, registerOpenClawApprovalHandlers } from './ipc/security';
import {
  registerLocalAsrHandlers,
  registerLocalSpeechModelHandlers,
  registerLocalTtsHandlers,
  registerOnlineAsrHandlers,
  registerOnlineTtsHandlers,
  registerSpeechSynthesisHandlers,
} from './ipc/speech';
import { NativeAssistantCreation } from './openclaw/config/agents/nativeAssistantCreation';
import { revokeBuiltinCredentialFile } from './openclaw/config/models/builtinCredentialFile';
import { isDecisionModelManaged } from './openclaw/config/models/decisionModelConfig';
import { resolveNativeVideoSelection } from './openclaw/config/models/nativeVideoModelConfig';
import {
  buildProviderSelection,
  listManagedOpenClawPluginIds,
} from './openclaw/config/openclawConfigSync';
import { OpenClawConfigSyncService } from './openclaw/config/openclawConfigSyncService';
import {
  buildLocalSpeechExtensionSttConfig,
  buildLocalSpeechExtensionTtsConfig,
} from './openclaw/config/speech/localSpeechExtensionConfig';
import { buildManagedLocalTtsConfig } from './openclaw/config/speech/localTtsConfig';
import { resolveQualifiedAgentModelRef } from './openclaw/models/openclawAgentModels';
import { SessionPermissionModeCoordinator } from './openclaw/permissions/sessionPermissionModeCoordinator';
import { createEngineDiagnosticsCollector } from './openclaw/runtime/engineDiagnostics';
import { ensureExecutionReady } from './openclaw/runtime/executionReadiness';
import { acquireOpenClawRuntimeDevLease } from './openclaw/runtime/launch/openclawRuntimeDevLease';
import {
  OpenClawEngineManager,
  type OpenClawEngineStatus,
} from './openclaw/runtime/openclawEngineManager';
import { justDoSlashCommandPolicy } from './openclaw/slashCommands/slashCommandPolicies';
import {
  createPluginMarketplaceService,
  discoverExtensionMcpOverrideNames,
  discoverExtensionMcpServers,
  discoverOpenClawManagedMcpServers,
  McpServices,
  OpenClawExtensionImportService,
  OpenClawHookServices,
  OpenClawSkillFileService,
  OpenClawSkillService,
  PluginInstallationService,
  PluginManager,
  readNativeMcpServerNames,
} from './plugins';
import { WorkspaceAppSessions } from './plugins/mcp/workspaceAppSession';
import { SkillWorkshopService } from './plugins/skills/skillWorkshopService';
import {
  getBuiltinModelAuthConfig,
  resolveBuiltinModelDevelopmentApiKey,
} from './providers/builtinModelAuthConfig';
import { BuiltinModelAuthCoordinator } from './providers/builtinModelAuthCoordinator';
import {
  type BuiltinModelCredential,
  clearActiveBuiltinModelCredential,
  getActiveBuiltinModelCredential,
  getActiveBuiltinModelCredentialSessionId,
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
import { registerHistoryRecoveryHandlers } from './startup/history/historyRecovery';
import { NativeHistoryRuntime } from './startup/history/nativeHistoryRuntime';
import { StartupEnginePreparation } from './startup/initialization/startupEnginePreparation';
import { registerStartupSupportHandlers } from './startup/initialization/startupSupport';
import { StartupCoordinator } from './startup/routing/startupCoordinator';
import { NativeDatabaseUpgradeRuntime } from './startup/upgrade/nativeDatabaseUpgradeRuntime';

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

const configureUserDataPath = (bridgeProfile?: string): void => {
  const appDataPath = app.getPath('appData');
  const developmentDirectory = bridgeProfile
    ? undefined
    : resolveDevelopmentDataDirectory({
        isPackaged: app.isPackaged,
        nodeEnv: process.env.NODE_ENV,
        directory: process.env.JUSTDO_DEV_USER_DATA_DIR,
      });
  const preferredUserDataPath =
    bridgeProfile ?? developmentDirectory ?? path.join(appDataPath, USER_DATA_DIRECTORY_NAME);
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

const agentBridgeArgv = parseAgentBridgeArgv(process.argv);
if (agentBridgeArgv) {
  console.log = () => undefined;
  console.info = () => undefined;
  console.warn = () => undefined;
  console.error = () => undefined;
}
let startupPreparationError: unknown;
try {
  configureUserDataPath(agentBridgeArgv ? resolveAgentBridgeProfile(process.argv) : undefined);
} catch (error) {
  if (agentBridgeArgv) throw error;
  startupPreparationError = error;
}
if (!agentBridgeArgv) {
  try {
    initLogger();
  } catch (error) {
    console.warn('[AppInitialization] Logging is unavailable; continuing startup:', error);
  }
  try {
    applyDependencyManagerConfigEnv(process.env);
  } catch (error) {
    console.error(
      '[AppInitialization] Dependency configuration unavailable; continuing startup:',
      error,
    );
  }
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
  () => coworkEngineService?.getRuntimeAdapter()?.getGatewayClient() ?? null,
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
let loginService: LoginService | null = null;
let builtinModelCredentialMonitor: BuiltinModelCredentialMonitor | null = null;
let builtinModelTokenExchange: BuiltinModelTokenExchange | null = null;
let builtinModelAuthCoordinator: BuiltinModelAuthCoordinator | null = null;
let windowsSandboxService: WindowsSandboxService | null = null;
let browserExtensionChatServer: BrowserExtensionChatServer | null = null;
let storeInitPromise: Promise<SqliteStore> | null = null;
let openClawEngineManager: OpenClawEngineManager | null = null;
let startupHistoryAdmissionReady = false;
let startupEnginePreparationController: StartupEnginePreparation | undefined;
let openClawDirectoryOperations: ManagedDirectoryOperationCoordinator | null = null;
let outboundHeaderPolicyService: OutboundHeaderPolicyService | null = null;
let openClawExtensionImportService: OpenClawExtensionImportService | null = null;
let activeOutboundHeaderPolicyDigest: string | null = null;
let openClawStatusForwarderBound = false;
let openClawGatewayPortProxyBypassBound = false;
let preventSleepBlockerId: number | null = null;
let agentBridgeServer: AgentBridgeServer | null = null;
let agentBridgeStartPromise: Promise<void> | null = null;
let agentCliIntegrationService: AgentCliIntegrationService | null = null;
let appServerIntegrationService: AppServerIntegrationService | null = null;
let agentCommandService: AgentCommandService | null = null;
let cliExternalSessionStore: ExternalSessionStore | null = null;

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
  if (!store) throw new Error('Application data preparation has not completed.');
  if (!openClawEngineManager) {
    openClawEngineManager = new OpenClawEngineManager({
      canStartGateway: () => startupHistoryAdmissionReady,
      beginNetworkGeneration: () => getOutboundHeaderProxy().rotateGatewayCapability(),
      prepareNetworkGeneration: prepareOutboundHeaderNetworkGeneration,
      buildNetworkEnvironment: baseEnv => getOutboundHeaderProxy().buildGatewayEnvironment(baseEnv),
      isNetworkEnvironmentReusable: env =>
        getOutboundHeaderProxy().isGatewayEnvironmentReusable(env),
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

const getApplicationManagedPluginIds = (): string[] => {
  const managed = listManagedOpenClawPluginIds();
  const decision = getStore().get<AppConfigSettings>('app_config')?.onlineModelProviders?.decision;
  let videoProviderId: string | undefined;
  try {
    videoProviderId = resolveNativeVideoSelection(
      getStore().get<AppConfigSettings>('app_config')?.onlineModelProviders?.video,
    )?.providerId;
  } catch {
    /* Invalid draft settings do not change plugin ownership. */
  }
  return [
    ...managed,
    ...(isDecisionModelManaged(decision) ? [OpenClawExtensionId.TYPESAFE] : []),
    ...(videoProviderId ? [videoProviderId] : []),
  ];
};

const getOpenClawExtensionImportService = (): OpenClawExtensionImportService => {
  openClawExtensionImportService ??= new OpenClawExtensionImportService({
    getOpenClawEngineManager,
    getManagedPluginIds: getApplicationManagedPluginIds,
    requestGateway: <T>(method: string, params?: unknown, options?: GatewayRequestOptions) =>
      getCoworkEngineService().requestGateway<T>(method, params, options),
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
    startupEnginePreparationController?.observe(status);
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

const prepareOpenClawExecution = async (
  options: { prepareComputerForSend?: boolean } = {},
) => {
  bindOpenClawGatewayPortProxyBypass();
  return ensureExecutionReady({
    manager: getOpenClawEngineManager(),
    startWithPermissionPolicy: () =>
      getOpenClawConfigSyncService().startGatewayWithExecutionPolicy(options),
    verifyPermissionPolicy: () =>
      getOpenClawConfigSyncService().verifyExecutionPermissionPolicy(options),
  });
};

const ensureOpenClawRunningForCowork = (
  options: { prepareComputerForSend?: boolean } = {},
): Promise<OpenClawEngineStatus> => startupEnginePreparationController
  ? startupEnginePreparationController.run(() => prepareOpenClawExecution(options))
  : prepareOpenClawExecution(options);

const getStartupEngineNotReadyResponse = () =>
  startupEnginePreparationController && !startupEnginePreparationController.isReady()
    ? getEngineNotReadyResponse({ ...getOpenClawEngineManager().getStatus(),
      message: t('enginePreparationPending') })
    : undefined;

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
      getExtensionMcpServerNames: () =>
        discoverExtensionMcpOverrideNames(
          getOpenClawEngineManager(),
          new Set(
            getMcpStore()
              .listServers()
              .map(server => server.name),
          ),
        ),
      getHookStore,
      disconnectGatewayClient: () => getCoworkEngineService().disconnectGatewayClient(),
      connectGatewayClient: () => getCoworkEngineService().connectGatewayClient(),
      requestGateway: <T>(method: string, params?: unknown) =>
        getCoworkEngineService().requestGateway<T>(method, params),
      getGatewayClient: () => getOpenClawRuntimeAdapter()?.getGatewayClient() ?? null,
      getModelAuthSessionId: getActiveBuiltinModelCredentialSessionId,
      getBrowserMode: () =>
        normalizeBrowserMode(getStore().get<{ browserMode?: unknown }>('app_config')?.browserMode),
      getControlUiEnabled: () => {
        const config = getStore().get<AppConfigSettings>('app_config');
        return config?.developerMode === true && config.controlUiEnabled === true;
      },
      getDecisionModelCategory: () =>
        getStore().get<AppConfigSettings>('app_config')?.onlineModelProviders?.decision,
      getNativeVideoCategory: () =>
        getStore().get<AppConfigSettings>('app_config')?.onlineModelProviders?.video,
      getSpeechModelSettings: () => {
        const config = getStore().get<AppConfigSettings>('app_config');
        return {
          extensions: config?.localSpeechExtensions,
          voice: config?.voice,
          recognitionModels: config?.onlineModelProviders?.['speech-recognition'],
          synthesisModels: config?.onlineModelProviders?.['speech-synthesis'],
          language: config?.language === 'en' ? 'en' : 'zh',
        };
      },
      getLocalSttConfig: () => {
        const appConfig = getStore().get<AppConfigSettings>('app_config');
        return buildLocalSpeechExtensionSttConfig(
          appConfig?.localSpeechExtensions,
          appConfig?.language === 'en' ? 'en' : 'zh',
        );
      },
      getLocalTtsConfig: () =>
        buildManagedLocalTtsConfig(
          undefined,
          normalizeLocalSpeechSettings(getStore().get<AppConfigSettings>('app_config')?.voice),
        ),
      getLocalSpeechExtensionTtsConfig: () =>
        buildLocalSpeechExtensionTtsConfig(
          getStore().get<AppConfigSettings>('app_config')?.localSpeechExtensions,
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
    getConfig: getBuiltinModelAuthConfig,
    getDevelopmentApiKey: () =>
      resolveBuiltinModelDevelopmentApiKey(getBuiltinModelAuthConfig(), app.isPackaged),
    fetch: (url, init) => mainProcessFetch(url, init, { maxResponseBytes: 32_768 }),
    onInvalidated: () => revokeBuiltinCredentialFile(getOpenClawEngineManager().getStateDir()),
  });
  return builtinModelTokenExchange;
};

const getBuiltinModelAuthCoordinator = (): BuiltinModelAuthCoordinator => {
  builtinModelAuthCoordinator ??= new BuiltinModelAuthCoordinator({
    exchange: () => getBuiltinModelTokenExchange().refresh(),
    getActive: getActiveBuiltinModelCredential,
    getAuthSessionId: getActiveBuiltinModelCredentialSessionId,
    login: () => getBuiltinModelLifecycle().refreshAfterLogin(),
    rotate: () => getBuiltinModelLifecycle().refreshAfterCredentialRotation(),
    invalidate: () => {
      try {
        builtinModelTokenExchange?.suspend();
      } finally {
        clearActiveBuiltinModelCredential();
      }
    },
    logout: () => getBuiltinModelLifecycle().refreshAfterLogout(),
  });
  return builtinModelAuthCoordinator;
};

const refreshBuiltinModelCredentialFromLoginFile = async (refreshCatalog = false) => {
  return getBuiltinModelAuthCoordinator().refresh(refreshCatalog);
};

// Authentication handlers should call these only after the Main process has
// committed the corresponding authenticated/logged-out state.
export const refreshAfterLogin = async (): Promise<void> => {
  updateOutboundHeaderUserInfoCache();
  getBuiltinModelTokenExchange().resume();
  await refreshBuiltinModelCredentialFromLoginFile(true);
  customerRegistrationService?.start();
  void customerRegistrationService?.sync();
};

export const refreshAfterLogout = (): Promise<void> => {
  customerRegistrationService?.stop();
  updateOutboundHeaderUserInfoCache();
  return getBuiltinModelAuthCoordinator().logout();
};

const getLoginService = (): LoginService => {
  loginService ??= new LoginService({
    store: new LoginUserInfoStore(resolveOutboundHeaderUserInfoPath()),
    adapter: createLoginSdkAdapter({ getParentWindow: () => mainWindow }),
    onLoginCommitted: refreshAfterLogin,
    onLogoutCommitted: refreshAfterLogout,
    onHeadersCommitted: () => {
      updateOutboundHeaderUserInfoCache();
    },
    onStateChanged: state => {
      if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
        try {
          mainWindow.webContents.send(AuthIpc.StateChanged, state);
        } catch {
          console.warn('[LoginService] Failed to notify the account view.');
        }
      }
    },
  });
  return loginService;
};

const getCoworkEngineService = (): CoworkEngineService => {
  if (!coworkEngineService) {
    coworkEngineService = new CoworkEngineService({
      getCoworkStore,
      getOpenClawEngineManager,
      fetchSessionTitle: mainProcessTitleFetch,
      getUserDataPath: () => app.getPath('userData'),
      onRuntimeCreated: runtime => {
        const diagnostics = getSessionDiagnosticsService();
        runtime.on('gatewayEvent', event => diagnostics.observe(event));
        runtime.on('diagnosticCancellation', event => diagnostics.recordCancellation(event));
        runtime.on('diagnosticConnection', event => diagnostics.recordConnection(event));
      },
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

let sessionDiagnosticsService: SessionDiagnosticsService | undefined;
const getSessionDiagnosticsService = (): SessionDiagnosticsService => {
  sessionDiagnosticsService ??= new SessionDiagnosticsService({
    store: new SessionDiagnosticsStore(getStore().getDatabase()),
    hasSession: id => Boolean(getCoworkStore().getSession(id)),
    getNativeSessionKey: id => {
      const session = getCoworkStore().getSession(id);
      return session
        ? session.nativeSessionKey || buildCoworkSessionKey(session.id, session.agentId)
        : null;
    },
    getRuntime: getOpenClawRuntimeAdapter,
    getRuntimeArtifact: signal =>
      readDiagnosticRuntimeArtifact(openClawEngineManager?.getRuntimeRoot() ?? null, signal),
    logSources: {
      main: report => orderDiagnosticMainLogs(getRecentMainLogEntries(true), report),
      cowork: () =>
        ['cowork.log', 'cowork.log.old'].map(name =>
          path.join(app.getPath('userData'), 'logs', name),
        ),
      gateway: () => [path.join(app.getPath('userData'), 'openclaw', 'logs', 'gateway.log')],
    },
  });
  return sessionDiagnosticsService;
};

const notifyCoworkSessionsChanged = (): void => {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send('cowork:sessions:changed');
  }
};

const ensureAgentBridgeRunning = async (): Promise<void> => {
  if (agentBridgeServer?.running) return;
  if (agentBridgeStartPromise) return agentBridgeStartPromise;
  const candidate = new AgentBridgeServer({
    userDataPath: app.getPath('userData'),
    commandService: getAgentCommandService(),
  });
  agentBridgeStartPromise = candidate
    .start()
    .then(() => {
      agentBridgeServer = candidate;
    })
    .finally(() => {
      agentBridgeStartPromise = null;
    });
  return agentBridgeStartPromise;
};

const getAgentCliIntegrationService = (): AgentCliIntegrationService => {
  agentCliIntegrationService ??= new AgentCliIntegrationService({
    getBridgeState: () => ({
      running: agentBridgeServer?.running === true,
      activeTaskCount: agentCommandService?.activeTaskCount ?? 0,
    }),
    getGatewayPhase: () => getOpenClawEngineManager().getStatus().phase,
    prepareLauncher: () => {
      if (process.platform === 'win32')
        return ensureAgentCliCommandLauncher({
          targetPath: app.isPackaged
            ? resolvePackagedAgentCliExecutable(process.execPath)
            : resolveDevelopmentAgentCliExecutable(app.getAppPath(), app.getPath('userData')),
        });
      return ensureAgentCliCommandLauncher({
        profileDirectory: app.getPath('userData'),
        targetPath: app.isPackaged
          ? resolvePackagedAgentCliTargetPath(process.execPath)
          : process.execPath,
        targetArgs: buildAgentCliBridgeArguments(
          app.getPath('userData'),
          app.isPackaged ? undefined : app.getAppPath(),
        ),
      });
    },
  });
  return agentCliIntegrationService;
};

const getAgentCommandService = (): AgentCommandService => {
  agentCommandService ??= new AgentCommandService({
    backend: new ExternalAgentBackendFactory({
      getCoworkStore,
      getExternalSessionStore: () => {
        cliExternalSessionStore ??= new ExternalSessionStore(getStore().getDatabase());
        return cliExternalSessionStore;
      },
      getModels: () => getExternalAgentModelCatalog(resolveDefaultAgentModelRef()),
      onSessionsChanged: notifyCoworkSessionsChanged,
      execute: createExternalAgentExecution({
        getStore: getCoworkStore,
        getRouter: getCoworkEngineRouter,
        getRuntime: getOpenClawRuntimeAdapter,
        ensureReady: ensureOpenClawRunningForCowork,
      }),
    }),
    createResources: () => new ExternalAgentResources(getOpenClawRuntimeAdapter),
    getStatus: () => getAgentCliIntegrationService().getStatus(),
  });
  return agentCommandService;
};

const getAppServerIntegrationService = (): AppServerIntegrationService => {
  appServerIntegrationService ??= new AppServerIntegrationService({
    commandService: getAgentCommandService(),
    getDefaultCwd: () => getCoworkStore().getConfig().workingDirectory,
  });
  return appServerIntegrationService;
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
      getManager: getOpenClawEngineManager,
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
const MEDIA_PLAYBACK_PRELOAD_PATH = app.isPackaged
  ? path.join(__dirname, 'mediaPlaybackPreload.js')
  : path.join(__dirname, '../dist-electron/mediaPlaybackPreload.js');
const BROWSER_GUEST_PRELOAD_PATH = app.isPackaged
  ? path.join(__dirname, 'browserGuestPreload.js')
  : path.join(__dirname, '../dist-electron/browserGuestPreload.js');
const WIDGET_VIEWER_PRELOAD_PATH = app.isPackaged
  ? path.join(__dirname, 'widgetViewerPreload.js')
  : path.join(__dirname, '../dist-electron/widgetViewerPreload.js');
const WEBPAGE_EMBED_PRELOAD_PATH = app.isPackaged
  ? path.join(__dirname, 'webpageEmbedPreload.js')
  : path.join(__dirname, '../dist-electron/webpageEmbedPreload.js');

// 获取应用图标路径（Windows 使用 .ico，其他平台使用 .png）
const getAppIconPath = (): string | undefined => {
  if (process.platform !== 'win32' && process.platform !== 'linux') return undefined;
  const basePath = app.isPackaged
    ? path.join(process.resourcesPath, 'tray')
    : path.join(__dirname, '..', 'resources', 'icons', 'tray');
  return process.platform === 'win32'
    ? path.join(basePath, 'tray-icon.ico')
    : path.join(basePath, 'tray-icon.png');
};

// 保存对主窗口的引用
let mainWindow: BrowserWindow | null = null;
let disposeComputerOverlay: (() => void) | undefined;
const browserAgentBridge = new BrowserAgentBridge(
  (channel, payload) => {
    if (!mainWindow?.isDestroyed() && !mainWindow?.webContents.isDestroyed()) {
      mainWindow.webContents.send(channel, payload);
    }
  },
  webContentsId => mainWindow?.webContents.id === webContentsId,
  sessionId => getCoworkStore().getSession(sessionId)?.cwd ?? null,
  true,
  isWorkspaceBrowserHost,
  () => getStore().get<AppConfigSettings>('app_config')?.browserTabLimit,
);
let embeddedBrowserGatewayBridge: EmbeddedBrowserGatewayBridge | null = null;

const bindEmbeddedBrowserGateway = (): void => {
  if (embeddedBrowserGatewayBridge) return;
  const runtimeAdapter = getOpenClawRuntimeAdapter();
  if (!runtimeAdapter) {
    throw new Error('OpenClaw runtime adapter was not initialized with the Cowork router.');
  }
  const bridge = new EmbeddedBrowserGatewayBridge({
    isEnabled: () => normalizeBrowserMode(getStore().get<AppConfigSettings>('app_config')?.browserMode) === BrowserMode.Embedded,
    getDesktopSession: sessionKey => getCoworkStore().getSessionByNativeKey(sessionKey),
    getScheduledTask: jobId => getCronJobService().getJob(jobId),
    execute: (sessionKey, command, signal, scope) => browserAgentBridge.executeCommand(sessionKey, command, signal, scope),
    releaseScope: (sessionId, closePages) => browserAgentBridge.releaseExecutionScope(sessionId, closePages),
    revokeAll: () => browserAgentBridge.revokeBackgroundPages(),
    resolve: (requestId, response) => runtimeAdapter.requestGateway(EmbeddedBrowserGateway.RESOLVE, { requestId, ...response }),
  });
  runtimeAdapter.on('gatewayEvent', event => bridge.handleEvent(event));
  runtimeAdapter.on('gatewayDisconnected', () => bridge.revoke());
  runtimeAdapter.on('sessionDeleted', sessionId => bridge.deleteSession(sessionId));
  embeddedBrowserGatewayBridge = bridge;
};

let lastReloadAt = 0;
const MIN_RELOAD_INTERVAL_MS = 5000;
const APP_UPDATE_CHECK_FREQUENCY_KEY = 'app_update_check_frequency';
const APP_UPDATE_LAST_AUTOMATIC_CHECK_AT_KEY = 'app_update_last_automatic_check_at';
type AppConfigSettings = {
  api?: unknown;
  developerMode?: unknown;
  controlUiEnabled?: unknown;
  browserMode?: unknown;
  browserTabLimit?: unknown;
  browserDownloadDirectory?: unknown;
  browserAskDownloadLocation?: unknown;
  model?: unknown;
  theme?: string;
  language?: string;
  useSystemProxy?: boolean;
  proxy?: Partial<ProxySettings>;
  browserProxy?: Partial<ProxySettings>;
  providers?: unknown;
  onlineModelProviders?: { decision?: unknown; video?: unknown; 'speech-recognition'?: unknown; 'speech-synthesis'?: unknown };
  voice?: unknown;
  localSpeechExtensions?: unknown;
};

const getOpenClawAppConfigSignature = (config: unknown): string => {
  const appConfig = (config ?? {}) as AppConfigSettings;
  const voice = normalizeLocalSpeechSettings(appConfig.voice);
  return JSON.stringify({
    api: appConfig.api,
    controlUiEnabled: appConfig.developerMode === true && appConfig.controlUiEnabled === true,
    browserMode: appConfig.browserMode,
    model: appConfig.model,
    providers: appConfig.providers,
    decisionModels: appConfig.onlineModelProviders?.decision,
    nativeVideoModels: appConfig.onlineModelProviders?.video,
    recognitionModels: appConfig.onlineModelProviders?.['speech-recognition'],
    synthesisModels: appConfig.onlineModelProviders?.['speech-synthesis'],
    localSpeechExtensions: normalizeLocalSpeechExtensionSettings(appConfig.localSpeechExtensions),
    language: appConfig.language,
    voice: {
      outputEnabled: voice.outputEnabled,
      synthesisMode: voice.synthesisMode,
      ttsModelId: voice.ttsModelId,
      voiceId: voice.voiceId,
      speechRate: voice.speechRate,
      synthesisThreads: voice.synthesisThreads,
      onlineAsrModelRef: voice.onlineAsrModelRef,
      onlineTtsModelRef: voice.onlineTtsModelRef,
      onlineTtsVoice: voice.onlineTtsVoice,
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
  getWorkspaceWindowManager(mainWindow.webContents.id)?.updateAppearance();
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

const showSystemMenu = (position?: { x?: number; y?: number }, targetWindow = mainWindow) => {
  if (!isWindows) return;
  if (!targetWindow || targetWindow.isDestroyed()) return;

  const window = targetWindow;
  const isMaximized = window.isMaximized();
  const menu = Menu.buildFromTemplate([
    { label: t('windowRestore'), enabled: isMaximized, click: () => window.restore() },
    { label: t('windowMinimize'), click: () => window.minimize() },
    { label: t('windowMaximize'), enabled: !isMaximized, click: () => window.maximize() },
    { type: 'separator' },
    { label: t('windowClose'), click: () => window.close() },
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
const gotTheLock = agentBridgeArgv ? true : app.requestSingleInstanceLock();

if (agentBridgeArgv) {
  void (async () => {
    let code = 70;
    try {
      code = await runAgentBridgeClient(app.getPath('userData'), agentBridgeArgv);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`${message}\n`);
    } finally {
      process.exitCode = code;
      setImmediate(() => app.exit(code));
    }
  })();
} else if (!gotTheLock) {
  if (isDev && !app.isPackaged) {
    console.warn(
      '[Main] Another application instance is already running. Quit it from the tray and restart this command to keep development logs in this terminal.',
    );
  }
  app.quit();
} else {
  const releaseRuntimeDevLease = acquireOpenClawRuntimeDevLease({
    appPath: app.getAppPath(),
    isPackaged: app.isPackaged,
  });
  process.once('exit', releaseRuntimeDevLease);

  registerStoreHandlers({
    getStore,
    onAppConfigChanged: async (nextConfig, previousConfig, context) => {
      if (
        getOpenClawAppConfigSignature(nextConfig) === getOpenClawAppConfigSignature(previousConfig)
      ) {
        return;
      }
      const syncResult = await syncOpenClawConfig({
        reason: 'app-config-change',
        ...(context?.rollback ? { restoreDecisionModelSnapshot: true } : {}),
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
      await refreshBuiltinModelCredentialFromLoginFile(true);
    },
  });

  registerNetworkHandlers();
  registerLogHandlers();
  registerAgentCliIntegrationHandlers({
    getService: getAgentCliIntegrationService,
    getMainWindow: () => mainWindow,
  });
  registerAppServerIntegrationHandlers({
    getService: getAppServerIntegrationService,
    getMainWindow: () => mainWindow,
    isQuitting: () => appShutdown.isQuitting(),
  });
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
  registerAuthHandlers({ getService: getLoginService, getMainWindow: () => mainWindow });
  registerWindowHandlers({
    getMainWindow: () => mainWindow,
    showSystemMenu,
  });
  registerWorkspaceWindowHandlers();
  registerImagePreviewHandlers({
    devServerUrl,
    getIconPath: getAppIconPath,
    getMainWindow: () => mainWindow,
    isDev,
    preloadPath: IMAGE_PREVIEW_PRELOAD_PATH,
  });

  registerOpenClawHistoryHandlers({
    requestGateway: <T>(method: string, params?: unknown) =>
      getCoworkEngineService().requestGateway<T>(method, params),
  });
  registerComputerControlHandlers({
    getRuntimeRoot: () => getOpenClawEngineManager().getRuntimeRoot(),
    requestGateway: <T>(method: string, params?: unknown) =>
      getCoworkEngineService().requestGateway<T>(method, params),
    runConfigMutationExclusive: operation =>
      getOpenClawConfigSyncService().runConfigMutationExclusive(operation),
  });
  registerLocalTtsHandlers();
  registerOpenClawUsageHandlers({ getRuntime: getOpenClawRuntimeAdapter });
  registerOpenClawWorkboardHandlers({ getRuntime: getOpenClawRuntimeAdapter });
  registerOpenClawApprovalHandlers({ getRuntime: getOpenClawRuntimeAdapter });
  registerOpenClawMemoryHandlers({
    isAgentAvailable: agentId => {
      const agent = getCoworkStore().getAgent(agentId);
      return Boolean(agent && !agent.deletedAt);
    },
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
    getModelCategory: () => getStore().get<AppConfigSettings>('app_config')?.onlineModelProviders?.['speech-synthesis'],
    getStateDir: () => getOpenClawEngineManager().getStateDir(),
    requestGateway: <T>(method: string, params?: unknown) =>
      getCoworkEngineService().requestGateway<T>(method, params),
    runConfigMutationExclusive: operation =>
      getOpenClawConfigSyncService().runConfigMutationExclusive(operation),
  });
  registerSpeechSynthesisHandlers({
    getSettings: () =>
      normalizeLocalSpeechSettings(getStore().get<AppConfigSettings>('app_config')?.voice),
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
  const skillWorkshopService = new SkillWorkshopService(<T>(method: string, params?: unknown) =>
    getCoworkEngineService().requestGateway<T>(method, params),
  );
  registerSkillWorkshopHandlers(skillWorkshopService);
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
    beforeAgentTeamDisable: () => getTeamDiscussionCoordinator().cancelPendingForDisable(),
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
    runConfigMutationExclusive: operation =>
      getOpenClawConfigSyncService().runConfigMutationExclusive(({ syncConfig }) =>
        operation(() => getOpenClawHookServices().syncConfigAfterExclusiveMutation(syncConfig)),
      ),
    installationService: pluginInstallationService,
  });

  registerEngineDiagnosticsHandlers({
    getMainWindow: () => mainWindow,
    getDiagnosticId: () => getOpenClawEngineManager().getDiagnosticContext().id,
    collect: createEngineDiagnosticsCollector({
      getManager: getOpenClawEngineManager,
      getGatewayClient: () => getOpenClawRuntimeAdapter()?.getGatewayClient() ?? null,
    }),
  });
  registerManagedMediaPlaybackHandlers({
    getMainWindow: () => mainWindow,
    getManager: getOpenClawEngineManager,
  });
  registerOpenClawEngineHandlers({
    ensureEngineRunning: ensureOpenClawRunningForCowork,
    runConfigMutationExclusive: operation =>
      getOpenClawConfigSyncService().runConfigMutationExclusive(operation),
    getManager: getOpenClawEngineManager,
    getCoworkStore,
    requestGateway: <T>(method: string, params?: unknown) =>
      getCoworkEngineService().requestGateway<T>(method, params),
    reconnectGatewayClient: () => getCoworkEngineService().reconnectGatewayClient(),
  });

  registerMcpHandlers({
    getStore: getMcpStore,
    getManagedPluginIds: getApplicationManagedPluginIds,
    requestGateway: <T>(method: string, params?: unknown) =>
      getCoworkEngineService().requestGateway<T>(method, params),
    runConfigMutationExclusive: operation =>
      getOpenClawConfigSyncService().runConfigMutationExclusive(({ syncConfig }) =>
        operation((retiredMcpServerNames, context) =>
          getMcpServices().syncConfigAfterExclusiveMutation(
            options => syncConfig({ ...options, retiredMcpServerNames }),
            context,
          ),
        ),
      ),
    probeServer: probeMcpServer,
    readResource: readMcpResource,
    listExtensionServers: () => discoverExtensionMcpServers(getOpenClawEngineManager()),
    readExtensionDefinition: id => getMcpServices().readExtensionDefinition(id),
    getNativeMcpServerNames: () =>
      readNativeMcpServerNames(getOpenClawEngineManager().getConfigPath()),
    discoverExternalServers: async () => {
      const extensionNames = await discoverExtensionMcpOverrideNames(
        getOpenClawEngineManager(),
        new Set(
          getMcpStore()
            .listServers()
            .map(server => server.name),
        ),
      );
      const discovered = discoverOpenClawManagedMcpServers(
        getOpenClawEngineManager().getConfigPath(),
        getMcpStore(),
        extensionNames,
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

  let agentTeamLaunch: AgentTeamLaunchCoordinator | undefined;
  const getAgentTeamLaunch = () =>
    (agentTeamLaunch ??= new AgentTeamLaunchCoordinator({
      getStore: getCoworkStore,
      getDatabase: () => getStore().getDatabase(),
      getRouter: getCoworkEngineRouter,
      requestGateway: <T>(method: string, params?: unknown) =>
        getCoworkEngineService().requestGateway<T>(method, params),
    }));
  const workspaceAppSessions = new WorkspaceAppSessions({
    getStore: getCoworkStore,
    request: <T>(method: string, params?: unknown, options?: GatewayRequestOptions) =>
      getCoworkEngineService().requestGateway<T>(method, params, options),
    captureResponseContext: async () => {
      const service = getCoworkEngineService();
      await service.connectGatewayClient();
      const adapter = service.getRuntimeAdapter();
      const router = service.getCurrentRouter();
      const manager = openClawEngineManager;
      const context = adapter?.captureGatewayResponseContext();
      if (!context || !adapter || !router || !manager) return null;
      return {
        isResponseError: context.isResponseError,
        isCurrent: () => !appShutdown.isQuitting() && coworkEngineService === service &&
          openClawEngineManager === manager && service.getCurrentRouter() === router &&
          service.getRuntimeAdapter() === adapter && context.isCurrent(),
      };
    },
  });
  registerCoworkSessionExecutionHandlers({
    getStartupEngineNotReadyResponse,
    workspaceAppSessions,
    getMainWindow: () => mainWindow,
    getAgentTeamLaunch,
    ensureEngineRunning: () => ensureOpenClawRunningForCowork({ prepareComputerForSend: true }),
    getCoworkStore,
    getCoworkEngineRouter,
    waitForConfigUpdates: waitForCoworkConfigUpdates,
    getEngineNotReadyResponse,
    requestGateway: <T>(method: string, params?: unknown) =>
      getCoworkEngineService().requestGateway<T>(method, params),
  });

  registerCoworkSessionHandlers({
    getStartupEngineNotReadyResponse,
    onSessionsChanged: notifyCoworkSessionsChanged,
    workspaceAppSessions,
    getAgentTeamLaunch,
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

  registerSessionGroupHandlers(getGroupStore, getCoworkStore);

  registerSessionReviewHandlers({
    getRuntime: getOpenClawRuntimeAdapter,
    getSession: sessionId => getCoworkStore().getSession(sessionId),
  });

  registerSessionDiagnosticsHandlers(getSessionDiagnosticsService);

  registerCoworkSubtaskHandlers({
    getRuntime: getOpenClawRuntimeAdapter,
    hasSession: sessionId => Boolean(getCoworkStore().getSession(sessionId)),
  });
  registerSwarmWorkflowHandlers({
    getRuntime: getOpenClawRuntimeAdapter,
    hasSession: sessionId => Boolean(getCoworkStore().getSession(sessionId)),
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
    onExecution: payload => getAgentTeamLaunch().observeExecution(payload),
    onLaunchAccepted: receipt => getAgentTeamLaunch().confirm(receipt),
    stopDiscussions: (sessionId, requireSettled) =>
      getTeamDiscussionCoordinator().stopForSource(sessionId, requireSettled),
    discussion: (sessionId, input, identity, assertActive) =>
      getTeamDiscussionCoordinator().fromAgent(sessionId, input, identity, assertActive),
    createAssistant: (input, identity, assertActive) =>
      nativeAssistantCreation.create(input, identity, assertActive),
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

  registerAgentTeamSettingsHandlers(() => getStore().getDatabase());
  const getTeamDiscussionCoordinator = registerTeamDiscussionHandlers({
    isExtensionEnabled: () => {
      try {
        const config = JSON.parse(
          fs.readFileSync(getOpenClawEngineManager().getConfigPath(), 'utf8'),
        );
        const plugins = config.plugins;
        return (
          plugins?.enabled !== false &&
          plugins?.entries?.[OpenClawExtensionId.AGENT_TEAM]?.enabled === true &&
          !plugins?.deny?.includes(OpenClawExtensionId.AGENT_TEAM) &&
          (!plugins?.allow?.length || plugins.allow.includes(OpenClawExtensionId.AGENT_TEAM))
        );
      } catch {
        return false;
      }
    },
    isSourceDeleting: sessionId => bindCollaboration.coordinator().isSourceDeleting(sessionId),
    getDatabase: () => getStore().getDatabase(),
    getStore: getCoworkStore,
    ensureReady: ensureOpenClawRunningForCowork,
    requestConnectedGateway: async <T>(method: string, params?: unknown) => {
      const client = getOpenClawRuntimeAdapter()?.getGatewayClient();
      if (!client) throw new Error('teamDiscussionUnavailable');
      return client.request<T>(method, params);
    },
    requestGateway: <T>(method: string, params?: unknown) =>
      getCoworkEngineService().requestGateway<T>(method, params),
    onChanged: notifyCoworkSessionsChanged,
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
    ensureRunning: async () => {
      const status = await ensureOpenClawRunningForCowork();
      if (status.phase !== 'running') throw new Error(status.message || 'OpenClaw is unavailable');
    },
    getRuntime: () => {
      getCoworkEngineService();
      const runtime = getOpenClawRuntimeAdapter();
      if (!runtime) throw new Error('OpenClaw is unavailable');
      return runtime;
    },
    getSession: id => getCoworkStore().getSession(id),
  });

  const startupWindowHandoff = new StartupWindowHandoff({
    canShow: () => !isAutoLaunched(),
    isQuitting: () => appShutdown.isQuitting(),
    onCancelled: () => app.quit(),
  });

  // 创建主窗口
  const createWindow = () => {
    if (appShutdown.isQuitting()) return;
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      if (!mainWindow.isVisible()) mainWindow.show();
      if (!mainWindow.isFocused()) mainWindow.focus();
      return;
    }
    if (!store) {
      startupWindowHandoff.showCurrent();
      return;
    }

    mainWindow = createMainWindow({
      appName: APP_NAME,
      firstLaunch: initialization.getState().firstLaunch,
      getEntryStartedAt: startupWindowHandoff.getEntryStartedAt,
      startupPresentation: {
        route: startupCoordinator.route,
      },
      readWorkspaceWindowBounds: () =>
        getStore().get<WorkspaceWindowBounds>(WORKSPACE_WINDOW_BOUNDS_KEY),
      saveWorkspaceWindowBounds: bounds => getStore().set(WORKSPACE_WINDOW_BOUNDS_KEY, bounds),
      devServerUrl,
      getBackgroundColor: () =>
        getInitialTheme() === 'dark' ? TITLEBAR_COLORS.dark.color : '#F8F9FB',
      getIconPath: getAppIconPath,
      getRendererPreferenceStore: getStore,
      browserGuestPreloadPath: BROWSER_GUEST_PRELOAD_PATH,
      mediaPlaybackPreloadPath: MEDIA_PLAYBACK_PRELOAD_PATH,
      widgetViewerPreloadPath: WIDGET_VIEWER_PRELOAD_PATH,
      webpageEmbedPreloadPath: WEBPAGE_EMBED_PRELOAD_PATH,
      getWebpageEmbedConnection: () => captureWebpageEmbedConnection(getOpenClawRuntimeAdapter, getOpenClawEngineManager()),
      runConfigMutationExclusive: operation => getOpenClawConfigSyncService().runConfigMutationExclusive(operation),
      getBrowserDownloadSettings: () => {
        const config = getStore().get<AppConfigSettings>('app_config');
        return normalizeBrowserDownloadSettings({
          directory: config?.browserDownloadDirectory,
          askWhereToSave: config?.browserAskDownloadLocation,
        });
      },
      getProxyCredentials: () => {
        const proxy = getStore().get<AppConfigSettings>('app_config')?.browserProxy;
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
      showSystemMenu: (window, position) => showSystemMenu(position, window),
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
        if (appShutdown.isQuitting()) return;
        emitWindowState(window);
        startupWindowHandoff.present(window);
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
    startupWindowHandoff.prepare(mainWindow);

    mainWindow.on('closed', () => {
      mainWindow = null;
      // Cached invisible presentation windows must not keep the app alive.
      disposeComputerOverlay?.();
      disposeComputerOverlay = undefined;
    });
  };

  const runAppCleanup = async (): Promise<void> => {
    startupHistoryAdmissionReady = false;
    const admissionErrors: unknown[] = [];
    for (const revokeAdmission of [
      () => openClawEngineManager?.beginApplicationShutdown(),
      () => startupCoordinator?.stop(),
    ]) {
      try { revokeAdmission(); } catch (error) { admissionErrors.push(error); }
    }
    const appServerStopped = Promise.resolve().then(() => appServerIntegrationService?.stop());
    // Observe immediately while startup owners join; preserve the original rejection.
    void appServerStopped.catch(error => console.error('[AppServer] Failed to stop local WebSocket service:', error));
    await runApplicationCleanup({
      retireStartup: () => settleCleanupTasks([
        () => startupHistoryRuntime.stop(), () => startupDatabaseRuntime.stop(),
        () => startupIntegrationPreparation,
        () => { if (admissionErrors.length) throw new AggregateError(admissionErrors, 'Startup admission revocation failed.'); },
      ]),
      retireServices: () => settleCleanupTasks([
        () => { disposeComputerOverlay?.(); disposeComputerOverlay = undefined; },
        () => devSessionLifecycle?.stop(),
        () => detachDevelopmentParent?.(),
        () => { if (store) getTeamDiscussionCoordinator().dispose(); },
        () => builtinModelCredentialMonitor?.stop(),
        () => loginService?.dispose(),
        () => customerRegistrationService?.stop(),
        () => builtinModelTokenExchange?.invalidate(),
        () => builtinModelAuthCoordinator?.initialize(null),
        () => clearActiveBuiltinModelCredential(),
        () => clearBrowserExtensionAppServer(app.getPath('userData')),
        async () => {
          const server = browserExtensionChatServer;
          await server?.stop();
          if (browserExtensionChatServer === server) browserExtensionChatServer = null;
        },
        () => appServerStopped,
        () => destroyTray(),
        async () => {
          const server = agentBridgeServer;
          await server?.stop();
          if (agentBridgeServer === server) agentBridgeServer = null;
        },
        async () => {
          // Prevent scheduled work while the native runtime drains existing work.
          try { getCronJobService().stopPolling(); } catch { /* Not initialized. */ }
          await coworkEngineService?.getCurrentRouter()?.stopAllSessions();
        },
      ]),
      retireGateway: () => openClawEngineManager?.stopGateway(),
      retireRemainingServices: () => settleCleanupTasks([
        () => startupEnginePreparationController?.settle(),
        () => embeddedBrowserGatewayBridge?.revoke(),
        () => browserAgentBridge.stop(), () => outboundHeaderProxy?.stop(),
      ]),
      // Never initialize a Store during shutdown, or close it underneath an unjoined owner.
      closeStore: () => store?.close(),
    });
  };

  const appShutdown = registerAppShutdown({
    cleanup: runAppCleanup,
    cleanupTimeoutMs: SHUTDOWN_BUDGET_MS.applicationExit,
    onBeginCleanup: () => {
      startupWindowHandoff.stop();
      // Retire the visible shell immediately while native owners close safely.
      for (const window of BrowserWindow.getAllWindows()) {
        if (!window.isDestroyed()) window.hide();
      }
      destroyTray();
    },
  });
  const developmentParentServerUrl = devServerUrl;
  const detachDevelopmentParent = !app.isPackaged
    ? bindDevelopmentParentShutdown(
        () => app.quit(),
        process,
        () => !isDev || new URL(devServerUrl).href === new URL(developmentParentServerUrl).href,
      )
    : null;
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
      console.warn(
        '[BrowserExtensionChat] Ignored extension restart request; restart the app manually.',
      );
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
    releaseHistoryUrl: resolveAppUpdateResourceUrl('release-history.json'),
    fetchReleaseHistory: (requestUrl, init) =>
      mainProcessFetch(requestUrl, init, {
        maxResponseBytes: APP_UPDATE_CONFIG.releaseHistory.maxBytes,
      }),
  });
  registerAutoUpdateHandlers(autoUpdateService);

  let startupCoordinator: StartupCoordinator;
  const startupStartedAt = Date.now();
  const startupNativeStateDir = path.join(app.getPath('userData'), 'openclaw', 'state');
  const startupDatabaseRuntime = new NativeDatabaseUpgradeRuntime({
    getRuntimeRoot: () => (app.isPackaged
      ? [path.join(process.resourcesPath, 'cfmind')]
      : [path.join(app.getAppPath(), 'vendor', 'openclaw-runtime', 'current'),
        path.join(process.cwd(), 'vendor', 'openclaw-runtime', 'current')])
      .find(candidate => fs.existsSync(candidate)) ?? null,
    stateDir: startupNativeStateDir,
    configPath: path.join(startupNativeStateDir, 'openclaw.json'),
    gatewayStopped: () => !openClawEngineManager ||
      (!openClawEngineManager.getGatewayProcessId() &&
        !['running', 'starting'].includes(openClawEngineManager.getStatus().phase)),
  });
  const startupHistoryRuntime = new NativeHistoryRuntime({
    getEnvironment: () => getOpenClawEngineManager().buildCliEnvironment(),
    gatewayStopped: () =>
      !getOpenClawEngineManager().getGatewayProcessId() &&
      !['running', 'starting'].includes(getOpenClawEngineManager().getStatus().phase),
    stateDir: () => getOpenClawEngineManager().getStateDir(),
  });
  let initialization: AppInitialization;
  const prepareStartup = async (): Promise<void> => {
    startupCoordinator = await StartupCoordinator.prepare(app.getPath('userData'), {
      appVersion: packageJson.version,
      native: startupDatabaseRuntime,
      startedAt: startupStartedAt,
    });
    initialization = new AppInitialization(
      app.getPath('userData'),
      startupCoordinator.route,
      state => {
        if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
          try {
            mainWindow.webContents.send(AppInitializationIpc.Changed, state);
          } catch (error) {
            console.warn('[AppInitialization] Failed to publish progress; startup continues:', error);
          }
        }
      },
      () => ({ logPath: getLogFilePath() }),
      startupCoordinator.stage,
      startupCoordinator.startedAt,
    );
    initialization.setDowngradeConfirmation(startupCoordinator.getDowngradeConfirmation());
    registerAppInitializationHandlers(initialization, {
      getWindow: () => mainWindow,
      canConfirm: () => !appShutdown.isQuitting(),
      confirm: requestId => startupCoordinator.confirmDowngrade(requestId),
    });
    registerStartupSupportHandlers({
      getWindow: () => mainWindow,
      getState: () => initialization.getState(),
      getBackupDirectory: () => startupCoordinator.getHistoryBackupDirectory(),
    });
    registerHistoryRecoveryHandlers({
      getWindow: () => mainWindow,
      isReady: () =>
        !appShutdown.isQuitting() && initialization.getState().phase === AppInitializationPhase.Ready,
      getStore,
      getCoworkStore,
    });
  };

  const createStartupWindow = (): InitializationWindow => {
    const startup = createInitializationWindow({
      appName: APP_NAME,
      firstLaunch: initialization.getState().firstLaunch,
      getEntryStartedAt: startupWindowHandoff.getEntryStartedAt,
      startupPresentation: {
        route: startupCoordinator.route,
      },
      preloadPath: PRELOAD_PATH,
      isWindows,
      isDev,
      devServerUrl,
      devServerPort: Number(process.env.JUSTDO_DEV_SERVER_PORT || packageJson.devServer.port),
      onReady: window => {
        emitWindowState(window);
        startupWindowHandoff.present(window);
      },
    });
    const initializationWindow = startup.window;
    startupWindowHandoff.prepare(initializationWindow, false);
    mainWindow = initializationWindow;
    initializationWindow.on('closed', () => {
      if (startupCoordinator.getDowngradeConfirmation()) {
        startupCoordinator.stop();
        app.quit();
      }
      if (mainWindow === initializationWindow) mainWindow = null;
    });
    return startup;
  };

  // 初始化应用
  let startupEnginePreparation: Promise<void> | undefined;
  let startupIntegrationPreparation: Promise<void> | undefined;
  let startupExecutionGeneration: number | undefined;
  const completeEnginePreparation = () => {
    if (appShutdown.isQuitting() || initialization.getState().phase === AppInitializationPhase.Failed)
      return;
    const manager = getOpenClawEngineManager();
    const phase = manager.getStatus().phase;
    if (phase !== EnginePhase.Error && (startupExecutionGeneration === undefined ||
        startupExecutionGeneration !== manager.getGatewayProcessGeneration() || phase !== EnginePhase.Running))
      throw new Error(t('runtimeNodeUnavailable'), {
        cause: new Error('Startup execution readiness was not confirmed for the current Gateway process.'),
      });
    initialization.setEnginePreparationPending(false);
  };
  const initApp = async () => {
    registerLocalFileScheme();
    await app.whenReady();
    if (appShutdown.isQuitting()) return;
    try {
      const startupBootstrap = createStartupBootstrapWindow({
        appName: APP_NAME,
        isDev,
        isWindows,
        devServerUrl,
        onReady: window => {
          startupWindowHandoff.showBootstrap(window);
        },
      });
      startupWindowHandoff.setBootstrap(startupBootstrap.window);
    } catch (error) {
      console.warn('[StartupBootstrap] Could not create first paint:', error);
    }
    await prepareStartup();
    if (appShutdown.isQuitting()) return;

    const startup = initialization.getState().firstLaunch ? createStartupWindow() : null;
    // The packaged HTTP host starts asynchronously; wait for its actual navigation.
    // Load failures are logged by the window and do not block real data preparation.
    if (startup) await startup.loaded;
    if (appShutdown.isQuitting()) return;
    if (startupPreparationError) throw startupPreparationError;
    initialization.setTaskStatus(AppInitializationTask.UserData, AppInitializationTaskStatus.Running);
    await startupCoordinator.prepareBeforeStore(initialization);
    await initialization.prepareUserData();
    if (appShutdown.isQuitting()) return;
    initialization.reportActivity(AppInitializationActivity.Database);
    store = await initStore();
    if (appShutdown.isQuitting()) return;
    // Engine construction requires the admitted Store. Keep startup state IPC
    // available before this point so preparation failures remain readable.
    if (startupCoordinator.route === StartupRoute.Normal) {
      startupEnginePreparationController = new StartupEnginePreparation({
        initialization,
        manager: getOpenClawEngineManager(),
        isQuitting: () => appShutdown.isQuitting(),
        prepare: prepareOpenClawExecution,
      });
    }
    initialization.setTaskStatus(AppInitializationTask.UserData, AppInitializationTaskStatus.Complete);
    mainWindow = null;
    registerContentSecurityPolicy({
      isDev,
      devServerPort: Number(process.env.JUSTDO_DEV_SERVER_PORT || packageJson.devServer.port),
    });
    createWindow();
    if (startupCoordinator.route !== StartupRoute.Normal) {
      initialization.advance(AppInitializationStep.Runtime, 1);
      await initialization.runOptionalTask('prepare Python runtime', async () => {
        const runtimeResult = await ensurePythonRuntimeReady();
        if (!runtimeResult.success) {
          console.error(
            '[AppInitialization] Python runtime preparation failed; continuing:',
            runtimeResult.error,
          );
        }
      });
    }
    if (appShutdown.isQuitting()) return;
    initialization.advance(AppInitializationStep.Configuration, 2);
    initialization.setTaskStatus(AppInitializationTask.Configuration, AppInitializationTaskStatus.Running);
    initialization.reportActivity(AppInitializationActivity.LocalServices);
    const startBrowserExtensionIngress = async (): Promise<boolean> => {
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
        0,
        () =>
          readAutomaticBrowserExtensionPairing(ensureOpenClawRunningForCowork, () =>
            getOpenClawEngineManager().buildCliEnvironment(),
          ),
      );
      try {
        await extensionChatServer.start();
        if (appShutdown.isQuitting()) {
          await extensionChatServer.stop();
          return false;
        }
        browserExtensionChatServer = extensionChatServer;
        await publishBrowserExtensionAppServer(
          app.getPath('userData'),
          extensionChatServer.getCapability(),
        );
        if (appShutdown.isQuitting()) {
          await clearBrowserExtensionAppServer(app.getPath('userData')).catch(error => {
            console.warn(
              '[BrowserExtensionChat] Failed to clear startup rendezvous during shutdown:',
              error,
            );
          });
          return false;
        }
        if (app.isPackaged) {
          await registerBrowserExtensionNativeHost(
            app.getPath('userData'),
            path.join(
              process.resourcesPath,
              'browser-extension',
              'native-host',
              `${APP_NAME}-browser-extension-native-host.exe`,
            ),
          );
        }
        console.info('[BrowserExtensionChat] WebSocket app-server is listening on loopback.');
        return true;
      } catch (error) {
        console.error('[BrowserExtensionChat] Failed to start loopback service:', error);
        return false;
      }
    };
    if (appShutdown.isQuitting()) return;
    initialization.reportActivity(AppInitializationActivity.Network);
    const initialOutboundHeaderPolicy = getOutboundHeaderPolicyService().reconcile();
    await getOutboundHeaderProxy().start();
    if (appShutdown.isQuitting()) {
      outboundHeaderProxy?.stop();
      return;
    }
    activeOutboundHeaderPolicyDigest = initialOutboundHeaderPolicy.digest;

    // Note: Calendar permission is checked on-demand when calendar operations are requested
    // We don't trigger permission dialogs at startup to avoid annoying users

    // Ensure default working directory exists
    const defaultProjectDir = getDefaultWorkingDirectory();
    initialization.reportActivity(AppInitializationActivity.Workspace);
    await initialization.runOptionalTask('prepare default project directory', async () => {
      await fs.promises.mkdir(defaultProjectDir, { recursive: true });
    });
    if (appShutdown.isQuitting()) return;

    // 注册 localfile:// 自定义协议，用于安全加载本地文件（图片等）
    registerLocalFileProtocol({
      authorize: authorizeManagedMediaPlaybackRequest,
      respond: handleManagedMediaPlaybackRequest,
    });

    // Checkpoint previous desktop receipts; unresolved CLI executions keep
    // their open receipt and reservation until exact native settlement is known.
    // Runtime reconciliation can reopen ordinary desktop checkpoints.
    const interruptedRunCount = getCoworkStore().interruptOpenSessionRuns(Date.now());
    if (interruptedRunCount > 0) {
      console.log(`[Main] Interrupted ${interruptedRunCount} stale cowork run receipt(s)`);
    }
    // Defensive recovery: app may be force-closed during execution and leave
    // stale running flags in DB. Unresolved external execution flags retain their evidence.
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
    initialization.reportActivity(AppInitializationActivity.Network);
    await applySystemProxyPreference(appConfig);
    if (appShutdown.isQuitting()) return;
    await applyBrowserProxyPreference(appConfig);
    if (appShutdown.isQuitting()) return;

    initialization.reportActivity(AppInitializationActivity.ModelAccess);
    let builtinModelCredential: BuiltinModelCredential | null = null;
    try {
      builtinModelCredential = await getBuiltinModelTokenExchange().refresh();
    } catch (error) {
      console.warn(
        '[BuiltinModelTokenExchange] Startup exchange failed; retrying in background:',
        error,
      );
    }
    if (appShutdown.isQuitting()) return;

    await syncBuiltinModelProvider(store, {
      access: builtinModelCredential ? BuiltinModelAccess.Enabled : BuiltinModelAccess.Disabled,
    });
    if (appShutdown.isQuitting()) return;

    const coworkEngineRouter = getCoworkEngineRouter();
    bindEmbeddedBrowserGateway();
    disposeComputerOverlay = bindComputerOverlay(
      getOpenClawRuntimeAdapter()!,
      () =>
        getStore().get<{ computerOverlayRemotePreview?: unknown }>('app_config')
          ?.computerOverlayRemotePreview === true,
    );
    bindCollaboration();
    getTeamDiscussionCoordinator().startReconciliation();
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
    coworkEngineRouter.on('swarmWorkflowChanged', event => {
      BrowserWindow.getAllWindows().forEach(window => {
        if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
          window.webContents.send(SwarmWorkflowIpc.Changed, event);
        }
      });
    });
    bindOpenClawStatusForwarder();

    // Empty agent models intentionally inherit the application default.
    const qualifiedAgentModels = migrateAgentModelRefs();
    if (qualifiedAgentModels > 0) {
      console.log(`[Main] migrated agent model bindings: qualified=${qualifiedAgentModels}`);
    }

    let startupSync: Awaited<ReturnType<typeof syncOpenClawConfig>> | undefined;
    initialization.reportActivity(AppInitializationActivity.DefaultFiles);
    await initialization.runOptionalTask('synchronize assistant configuration', async () => {
      const result = await syncOpenClawConfig({
        reason: 'startup',
      });
      // Publish success only after the final credential projection completes.
      startupSync =
        result.success && !builtinModelCredential
          ? await syncOpenClawConfig({ reason: BuiltinModelSyncReason.AuthLogout })
          : result;
    });
    if (startupSync && !startupSync.success) {
      console.error('[OpenClaw] Startup config sync failed:', startupSync.error);
    }
    if (appShutdown.isQuitting()) return;

    await startupCoordinator.restoreHistory(
      getStore().getDatabase(),
      getOpenClawEngineManager().getStateDir(),
      initialization,
      (mode, planFile) => startupHistoryRuntime.run(mode, planFile),
    );
    if (appShutdown.isQuitting()) return;
    if (initialization.getState().historySummary) {
      const result = await syncOpenClawConfig({ reason: 'startup-history' });
      if (!result.success)
        throw new Error(`Historical assistant identities could not be prepared: ${result.error}`);
    }
    initialization.setTaskStatus(AppInitializationTask.Configuration, startupSync?.success
      ? AppInitializationTaskStatus.Complete : AppInitializationTaskStatus.Failed);
    initialization.advance(AppInitializationStep.Engine, 3);
    startupHistoryAdmissionReady = await startupCoordinator.verifyNativeReady(activity => initialization.reportActivity(activity));
    if (appShutdown.isQuitting()) return;
    const normalStartup = startupCoordinator.route === StartupRoute.Normal;
    const startStartupEngine = async (): Promise<void> => {
      if (appShutdown.isQuitting()) return;
      if (!startupSync?.success || !startupHistoryAdmissionReady) {
        if (normalStartup) initialization.failEnginePreparation(
          new Error(startupSync?.error || t('enginePreparationFailed')));
        return;
      }
      initialization.reportActivity(AppInitializationActivity.EngineStart);
      const startEngine = initialization.runOptionalTask('start assistant engine', async () => {
        const status = await ensureOpenClawRunningForCowork();
        if (status.phase !== 'running') {
          console.error('[OpenClaw] Startup engine unavailable; settings remain accessible:', status);
          return;
        }
        if (appShutdown.isQuitting() || initialization.getState().phase === AppInitializationPhase.Failed)
          return;
        startupExecutionGeneration = getOpenClawEngineManager().getGatewayProcessGeneration();
        getCronJobService().startPolling();
      });
      startupEnginePreparation = startEngine;
      if (!normalStartup) await startEngine;
    };
    // Start the ordinary Gateway immediately after its real configuration is
    // loaded; local integration setup can overlap its native startup.
    if (normalStartup) await startStartupEngine();
    if (appShutdown.isQuitting()) return;
    const prepareStartupIntegrations = async (): Promise<void> => {
      if (appShutdown.isQuitting()) return;
      initialization.reportActivity(AppInitializationActivity.Integrations);
      initialization.setTaskStatus(AppInitializationTask.Integrations, AppInitializationTaskStatus.Running);
      let integrationsSucceeded = await startBrowserExtensionIngress();
      if (appShutdown.isQuitting()) return;
      try {
        getAgentCliIntegrationService().prepare();
      } catch (error) {
        integrationsSucceeded = false;
        console.warn('[AgentCli] Launcher preparation failed:', error instanceof Error ? error.message : String(error));
      }
      await ensureAgentBridgeRunning().catch(error => {
        integrationsSucceeded = false;
        console.error('[AgentBridge] Failed to start:', error);
        agentBridgeServer = null;
      });
      if (!appShutdown.isQuitting()) {
        await getAppServerIntegrationService().start().catch(() => {
          integrationsSucceeded = false;
          console.error('[AppServer] Failed to start local WebSocket service.');
        });
      }
      if (appShutdown.isQuitting()) {
        await waitForAppServerShutdown(appServerIntegrationService?.stop().catch(() => {
          console.error('[AppServer] Failed to stop local WebSocket service.');
        }));
        await agentBridgeServer?.stop();
        agentBridgeServer = null;
        return;
      }
      initialization.setTaskStatus(AppInitializationTask.Integrations, integrationsSucceeded
        ? AppInitializationTaskStatus.Complete : AppInitializationTaskStatus.Failed);
    };
    startupIntegrationPreparation = prepareStartupIntegrations();
    // Keep one cleanup owner and observe failures even while the core shell and
    // workspace mount independently of optional local integration connections.
    void startupIntegrationPreparation.catch(error => {
      console.error('[AppInitialization] Local integration preparation failed:', error);
      if (!appShutdown.isQuitting()) {
        initialization.setTaskStatus(AppInitializationTask.Integrations, AppInitializationTaskStatus.Failed);
        if (!normalStartup) initialization.fail(error);
      }
    });
    if (!normalStartup) await startupIntegrationPreparation;
    if (!normalStartup) await startStartupEngine();
    if (appShutdown.isQuitting()) return;

    initialization.reportActivity(AppInitializationActivity.Finalize);
    builtinModelCredentialMonitor = new BuiltinModelCredentialMonitor({
      userInfoPath: resolveOutboundHeaderUserInfoPath(),
      refresh: refreshBuiltinModelCredentialFromLoginFile,
      onError: error => {
        console.error('[BuiltinModelCredentialMonitor] Credential refresh failed:', error);
      },
    });
    getBuiltinModelAuthCoordinator().initialize(
      startupSync?.success ? builtinModelCredential : null,
    );
    builtinModelCredentialMonitor.start(builtinModelCredential);
    // This display restoration never gates or repeats the existing JWT/model startup flow.
    void getLoginService().restoreFromFile();
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

    createTray(() => mainWindow);
    autoUpdateService.scheduleAutomaticChecks({ skipMissedCheck: true });

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
      if (
        getBrowserProxyPreferenceSignature(newConfig) !==
        getBrowserProxyPreferenceSignature(oldConfig)
      ) {
        void applyBrowserProxyPreference(newConfig);
      }
    });

    // 在 macOS 上，当点击 dock 图标时显示已有窗口或重新创建
    app.on('activate', () => {
      if (appShutdown.isQuitting()) return;
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
  void initApp()
    .then(async () => {
      if (!appShutdown.isQuitting() && initialization.getState().phase !== AppInitializationPhase.Failed) {
        if (startupEnginePreparation && initialization.getState().firstLaunch)
          completeEnginePreparation();
        startupCoordinator.complete();
        await initialization.complete();
        // The same preparation remains owned by cleanup; its domain failure does not close the shell.
        if (startupEnginePreparation && !initialization.getState().firstLaunch)
          await startupEnginePreparation;
      }
    })
    .catch(error => {
      if (appShutdown.isQuitting()) {
        console.error(
          '[AppInitialization] Startup failed during shutdown:',
          initialization.getState(),
          error,
        );
        return;
      }
      initialization.fail(error);
      if (!mainWindow && app.isReady()) createStartupWindow();
    });

  // 当所有窗口关闭时退出应用
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });
}
