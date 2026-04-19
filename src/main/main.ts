import type { PermissionResult } from './libs/agentEngine/types';
import type { WebContents } from 'electron';
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  nativeTheme,
  net,
  powerMonitor,
  powerSaveBlocker,
  protocol,
  session,
  shell,
} from 'electron';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  migrateScheduledTaskRunsToOpenclaw,
  migrateScheduledTasksToOpenclaw,
} from '../scheduledTask/migrate';
import { PlatformRegistry } from '../shared/platform';
import { AgentManager } from './agentManager';
import { APP_NAME } from './appConstants';
import { getAutoLaunchEnabled, isAutoLaunched, setAutoLaunchEnabled } from './autoLaunchManager';
import { CoworkStore } from './coworkStore';
import { GroupStore } from './groupStore';
import { setLanguage, t } from './i18n';
import {
  getCronJobService,
  initCronJobServiceManager,
  registerScheduledTaskHandlers,
} from './ipcHandlers/scheduledTask';
import {
  type CoworkAgentEngine,
  CoworkEngineRouter,
  OpenClawRuntimeAdapter,
} from './libs/agentEngine';
import {
  clearServerModelMetadata,
  getCurrentApiConfig,
  resolveAllEnabledProviderConfigs,
  resolveCurrentApiConfig,
  resolveRawApiConfig,
  setStoreGetter,
  updateServerModelMetadata,
} from './libs/claudeSettings';
import {
  clearCopilotTokenState,
  initCopilotTokenManager,
  refreshCopilotTokenNow,
  setCopilotTokenState,
} from './libs/copilotTokenManager';
import { saveCoworkApiConfig } from './libs/coworkConfigStore';
import { getCoworkLogPath } from './libs/coworkLogger';
import {
  registerProxyTokenRefresher,
  startCoworkOpenAICompatProxy,
  stopCoworkOpenAICompatProxy,
} from './libs/coworkOpenAICompatProxy';
import { generateSessionTitle, probeCoworkModelReadiness } from './libs/coworkUtil';
import {
  mergeEnterpriseOpenclawConfig,
  resolveEnterpriseConfigPath,
  syncEnterpriseConfig,
} from './libs/enterpriseConfigSync';
import { exportLogsZip } from './libs/logExport';
import { McpBridgeServer } from './libs/mcpBridgeServer';
import { McpServerManager } from './libs/mcpServerManager';
import { resolveQualifiedAgentModelRef } from './libs/openclawAgentModels';
import {
  buildManagedSessionKey,
  DEFAULT_MANAGED_AGENT_ID,
  OpenClawChannelSessionSync,
} from './libs/openclawChannelSessionSync';
import type { McpBridgeConfig } from './libs/openclawConfigSync';
import { buildProviderSelection, OpenClawConfigSync } from './libs/openclawConfigSync';
import { OpenClawEngineManager, type OpenClawEngineStatus } from './libs/openclawEngineManager';
import {
  addMemoryEntry,
  deleteMemoryEntry,
  ensureDefaultIdentity,
  migrateSqliteToMemoryMd,
  readBootstrapFile,
  readMemoryEntries,
  resolveMemoryFilePath,
  searchMemoryEntries,
  syncMemoryFileOnWorkspaceChange,
  updateMemoryEntry,
  writeBootstrapFile,
} from './libs/openclawMemoryFile';
import { stopOpenClawTokenProxy } from './libs/openclawTokenProxy';
import { ensurePythonRuntimeReady } from './libs/pythonRuntime';
import {
  applySystemProxyEnv,
  resolveSystemProxyUrl,
  restoreOriginalProxyEnv,
  setSystemProxyEnabled,
} from './libs/systemProxy';
import { getLogFilePath, getRecentMainLogEntries, initLogger } from './logger';
import type { McpServerFormData } from './mcpStore';
import { McpStore } from './mcpStore';
import { SkillManager } from './skillManager';
import { getSkillServiceManager } from './skillServices';
import { SqliteStore } from './sqliteStore';
import { createTray, destroyTray, updateTrayMenu } from './trayManager';

// 设置应用程序名称
app.setName(APP_NAME);

const INVALID_FILE_NAME_PATTERN = /[<>:"/\\|?*\u0000-\u001F]/g;
const MIN_MEMORY_USER_MEMORIES_MAX_ITEMS = 1;
const MAX_MEMORY_USER_MEMORIES_MAX_ITEMS = 60;
const IPC_MESSAGE_CONTENT_MAX_CHARS = 120_000;
const IPC_UPDATE_CONTENT_MAX_CHARS = 120_000;
const IPC_STRING_MAX_CHARS = 4_000;
const IPC_MAX_DEPTH = 5;
const IPC_MAX_KEYS = 80;
const IPC_MAX_ITEMS = 40;
const MAX_INLINE_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const ENGINE_NOT_READY_CODE = 'ENGINE_NOT_READY';
const MIME_EXTENSION_MAP: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/bmp': '.bmp',
  'application/pdf': '.pdf',
  'text/plain': '.txt',
  'text/markdown': '.md',
  'application/json': '.json',
  'text/csv': '.csv',
};

const sanitizeExportFileName = (value: string): string => {
  const sanitized = value.replace(INVALID_FILE_NAME_PATTERN, ' ').replace(/\s+/g, ' ').trim();
  return sanitized || 'cowork-session';
};

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
    codingPlanEnabled: apiResolution.providerMetadata?.codingPlanEnabled,
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
        codingPlanEnabled: provider.codingPlanEnabled,
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

const sanitizeAttachmentFileName = (value?: string): string => {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return 'attachment';
  const fileName = path.basename(raw);
  const sanitized = fileName.replace(INVALID_FILE_NAME_PATTERN, ' ').replace(/\s+/g, ' ').trim();
  return sanitized || 'attachment';
};

const inferAttachmentExtension = (fileName: string, mimeType?: string): string => {
  const fromName = path.extname(fileName).toLowerCase();
  if (fromName) {
    return fromName;
  }
  if (typeof mimeType === 'string') {
    const normalized = mimeType.toLowerCase().split(';')[0].trim();
    return MIME_EXTENSION_MAP[normalized] ?? '';
  }
  return '';
};

const resolveInlineAttachmentDir = (cwd?: string): string => {
  const trimmed = typeof cwd === 'string' ? cwd.trim() : '';
  if (trimmed) {
    const resolved = path.resolve(trimmed);
    if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
      return path.join(resolved, '.cowork-temp', 'attachments', 'manual');
    }
  }
  return path.join(app.getPath('temp'), 'gucciai', 'attachments');
};

const ensurePngFileName = (value: string): string => {
  return value.toLowerCase().endsWith('.png') ? value : `${value}.png`;
};

const ensureZipFileName = (value: string): string => {
  return value.toLowerCase().endsWith('.zip') ? value : `${value}.zip`;
};

const padTwoDigits = (value: number): string => value.toString().padStart(2, '0');

const buildLogExportFileName = (): string => {
  const now = new Date();
  const datePart = `${now.getFullYear()}${padTwoDigits(now.getMonth() + 1)}${padTwoDigits(now.getDate())}`;
  const timePart = `${padTwoDigits(now.getHours())}${padTwoDigits(now.getMinutes())}${padTwoDigits(now.getSeconds())}`;
  return `gucciai-logs-${datePart}-${timePart}.zip`;
};

const truncateIpcString = (value: string, maxChars: number): string => {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}\n...[truncated in main IPC forwarding]`;
};

const sanitizeIpcPayload = (value: unknown, depth = 0, seen?: WeakSet<object>): unknown => {
  const localSeen = seen ?? new WeakSet<object>();
  if (
    value === null ||
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    typeof value === 'undefined'
  ) {
    return value;
  }
  if (typeof value === 'string') {
    return truncateIpcString(value, IPC_STRING_MAX_CHARS);
  }
  if (typeof value === 'bigint') {
    return value.toString();
  }
  if (typeof value === 'function') {
    return '[function]';
  }
  if (depth >= IPC_MAX_DEPTH) {
    return '[truncated-depth]';
  }
  if (Array.isArray(value)) {
    const result = value
      .slice(0, IPC_MAX_ITEMS)
      .map(entry => sanitizeIpcPayload(entry, depth + 1, localSeen));
    if (value.length > IPC_MAX_ITEMS) {
      result.push(`[truncated-items:${value.length - IPC_MAX_ITEMS}]`);
    }
    return result;
  }
  if (typeof value === 'object') {
    if (localSeen.has(value as object)) {
      return '[circular]';
    }
    localSeen.add(value as object);
    const entries = Object.entries(value as Record<string, unknown>);
    const result: Record<string, unknown> = {};
    for (const [key, entry] of entries.slice(0, IPC_MAX_KEYS)) {
      result[key] = sanitizeIpcPayload(entry, depth + 1, localSeen);
    }
    if (entries.length > IPC_MAX_KEYS) {
      result.__truncated_keys__ = entries.length - IPC_MAX_KEYS;
    }
    return result;
  }
  return String(value);
};

const sanitizeCoworkMessageForIpc = (message: unknown): unknown => {
  if (!message || typeof message !== 'object') {
    return message;
  }
  const messageRecord = message as {
    metadata?: unknown;
    content?: unknown;
    thinkingContent?: unknown;
  };

  // Preserve imageAttachments in metadata as-is (base64 data can be very large
  // and must not be truncated by the generic sanitizer).
  let sanitizedMetadata: unknown;
  if (messageRecord.metadata && typeof messageRecord.metadata === 'object') {
    const { imageAttachments, ...rest } = messageRecord.metadata as Record<string, unknown>;
    const sanitizedRest = sanitizeIpcPayload(rest) as Record<string, unknown> | undefined;
    sanitizedMetadata = {
      ...(sanitizedRest && typeof sanitizedRest === 'object' ? sanitizedRest : {}),
      ...(Array.isArray(imageAttachments) && imageAttachments.length > 0
        ? { imageAttachments }
        : {}),
    };
  } else {
    sanitizedMetadata = undefined;
  }

  // Preserve thinkingContent (truncate if needed for IPC safety)
  const sanitizedThinkingContent =
    typeof messageRecord.thinkingContent === 'string'
      ? truncateIpcString(messageRecord.thinkingContent, IPC_MESSAGE_CONTENT_MAX_CHARS)
      : undefined;

  return {
    ...message,
    content:
      typeof messageRecord.content === 'string'
        ? truncateIpcString(messageRecord.content, IPC_MESSAGE_CONTENT_MAX_CHARS)
        : '',
    metadata: sanitizedMetadata,
    ...(sanitizedThinkingContent ? { thinkingContent: sanitizedThinkingContent } : {}),
  };
};

const sanitizePermissionRequestForIpc = (request: unknown): unknown => {
  if (!request || typeof request !== 'object') {
    return request;
  }
  const requestRecord = request as { toolInput?: unknown };
  return {
    ...request,
    toolInput: sanitizeIpcPayload(requestRecord.toolInput ?? {}),
  };
};

type CaptureRect = { x: number; y: number; width: number; height: number };

const normalizeCaptureRect = (rect?: Partial<CaptureRect> | null): CaptureRect | null => {
  if (!rect) return null;
  const normalized = {
    x: Math.max(0, Math.round(typeof rect.x === 'number' ? rect.x : 0)),
    y: Math.max(0, Math.round(typeof rect.y === 'number' ? rect.y : 0)),
    width: Math.max(0, Math.round(typeof rect.width === 'number' ? rect.width : 0)),
    height: Math.max(0, Math.round(typeof rect.height === 'number' ? rect.height : 0)),
  };
  return normalized.width > 0 && normalized.height > 0 ? normalized : null;
};

const resolveTaskWorkingDirectory = (workspaceRoot: string): string => {
  const resolvedWorkspaceRoot = path.resolve(workspaceRoot);
  // Reject bare Windows drive roots (e.g. "D:\") — mkdir on drive roots causes EPERM,
  // and some agent engines (OpenClaw) also fail when given a drive root as workspace.
  if (process.platform === 'win32' && /^[a-zA-Z]:\\?$/.test(resolvedWorkspaceRoot)) {
    throw new Error(
      `Cannot use a drive root as the working directory (${resolvedWorkspaceRoot}). Please select a subfolder instead, for example: ${resolvedWorkspaceRoot}Projects`,
    );
  }
  if (!fs.existsSync(resolvedWorkspaceRoot)) {
    fs.mkdirSync(resolvedWorkspaceRoot, { recursive: true });
  }
  if (!fs.statSync(resolvedWorkspaceRoot).isDirectory()) {
    throw new Error(`Selected workspace is not a directory: ${resolvedWorkspaceRoot}`);
  }
  return resolvedWorkspaceRoot;
};

const getDefaultExportImageName = (defaultFileName?: string): string => {
  const normalized =
    typeof defaultFileName === 'string' && defaultFileName.trim()
      ? defaultFileName.trim()
      : `cowork-session-${Date.now()}`;
  return ensurePngFileName(sanitizeExportFileName(normalized));
};

const savePngWithDialog = async (
  webContents: WebContents,
  pngData: Buffer,
  defaultFileName?: string,
): Promise<{ success: boolean; canceled?: boolean; path?: string; error?: string }> => {
  const defaultName = getDefaultExportImageName(defaultFileName);
  const ownerWindow = BrowserWindow.fromWebContents(webContents);
  const saveOptions = {
    title: 'Export Session Image',
    defaultPath: path.join(app.getPath('downloads'), defaultName),
    filters: [{ name: 'PNG Image', extensions: ['png'] }],
  };
  const saveResult = ownerWindow
    ? await dialog.showSaveDialog(ownerWindow, saveOptions)
    : await dialog.showSaveDialog(saveOptions);

  if (saveResult.canceled || !saveResult.filePath) {
    return { success: true, canceled: true };
  }

  const outputPath = ensurePngFileName(saveResult.filePath);
  await fs.promises.writeFile(outputPath, pngData);
  return { success: true, canceled: false, path: outputPath };
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
const DEV_SERVER_URL = process.env.ELECTRON_START_URL || 'http://localhost:5175';
const enableVerboseLogging =
  process.env.ELECTRON_ENABLE_LOGGING === '1' || process.env.ELECTRON_ENABLE_LOGGING === 'true';
const disableGpu =
  process.env.GUCCIAI_DISABLE_GPU === '1' ||
  process.env.GUCCIAI_DISABLE_GPU === 'true' ||
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

const safeDecodeURIComponent = (value: string): string => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

const normalizeWindowsShellPath = (inputPath: string): string => {
  if (!isWindows) return inputPath;

  const trimmed = inputPath.trim();
  if (!trimmed) return inputPath;

  let normalized = trimmed;
  if (/^file:\/\//i.test(normalized)) {
    normalized = safeDecodeURIComponent(normalized.replace(/^file:\/\//i, ''));
  }

  if (/^\/[A-Za-z]:/.test(normalized)) {
    normalized = normalized.slice(1);
  }

  const unixDriveMatch = normalized.match(/^[/\\]([A-Za-z])[/\\](.+)$/);
  if (unixDriveMatch) {
    const drive = unixDriveMatch[1].toUpperCase();
    const rest = unixDriveMatch[2].replace(/[/\\]+/g, '\\');
    return `${drive}:\\${rest}`;
  }

  if (/^[A-Za-z]:[/\\]/.test(normalized)) {
    const drive = normalized[0].toUpperCase();
    const rest = normalized.slice(1).replace(/\//g, '\\');
    return `${drive}${rest}`;
  }

  return normalized;
};

// ==================== macOS Permissions ====================

/**
 * Check calendar permission on macOS by attempting to access Calendar app
 * Returns: 'authorized' | 'denied' | 'restricted' | 'not-determined'
 * On Windows, checks if Outlook is available
 * On Linux, returns 'not-supported'
 */
const checkCalendarPermission = async (): Promise<string> => {
  if (process.platform === 'darwin') {
    try {
      // Try to access Calendar to check permission
      const { exec } = require('child_process');
      const util = require('util');
      const execAsync = util.promisify(exec);

      // Quick test to see if we can access Calendar
      await execAsync('osascript -l JavaScript -e \'Application("Calendar").name()\'', {
        timeout: 5000,
      });
      console.log('[Permissions] macOS Calendar access: authorized');
      return 'authorized';
    } catch (error: unknown) {
      const stderr =
        typeof error === 'object' && error && 'stderr' in error
          ? String((error as { stderr?: unknown }).stderr ?? '')
          : '';
      // Check if it's a permission error
      if (
        stderr.includes('不能获取对象') ||
        stderr.includes('not authorized') ||
        stderr.includes('Permission denied')
      ) {
        console.log('[Permissions] macOS Calendar access: not-determined (needs permission)');
        return 'not-determined';
      }
      console.warn('[Permissions] Failed to check macOS calendar permission:', error);
      return 'not-determined';
    }
  }

  if (process.platform === 'win32') {
    // Windows doesn't have a system-level calendar permission like macOS
    // Instead, we check if Outlook is available
    try {
      const { exec } = require('child_process');
      const util = require('util');
      const execAsync = util.promisify(exec);

      // Check if Outlook COM object is accessible
      const checkScript = `
        try {
          $Outlook = New-Object -ComObject Outlook.Application
          $Outlook.Version
        } catch { exit 1 }
      `;
      await execAsync('powershell -Command "' + checkScript + '"', { timeout: 10000 });
      console.log('[Permissions] Windows Outlook is available');
      return 'authorized';
    } catch {
      console.log('[Permissions] Windows Outlook not available or not accessible');
      return 'not-determined';
    }
  }

  return 'not-supported';
};

/**
 * Request calendar permission on macOS
 * On Windows, attempts to initialize Outlook COM object
 */
const requestCalendarPermission = async (): Promise<boolean> => {
  if (process.platform === 'darwin') {
    try {
      // On macOS, we trigger permission by trying to access Calendar
      // The system will show permission dialog if needed
      const { exec } = require('child_process');
      const util = require('util');
      const execAsync = util.promisify(exec);

      await execAsync(
        'osascript -l JavaScript -e \'Application("Calendar").calendars()[0].name()\'',
        { timeout: 10000 },
      );
      return true;
    } catch (error) {
      console.warn('[Permissions] Failed to request macOS calendar permission:', error);
      return false;
    }
  }

  if (process.platform === 'win32') {
    // Windows doesn't have a permission dialog for COM objects
    // We just check if Outlook is available
    const status = await checkCalendarPermission();
    return status === 'authorized';
  }

  return false;
};

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
let coworkEngineRouter: CoworkEngineRouter | null = null;
let skillManager: SkillManager | null = null;
let mcpStore: McpStore | null = null;
let mcpServerManager: McpServerManager | null = null;
let mcpBridgeServer: McpBridgeServer | null = null;
let mcpBridgeSecret: string | null = null;
let mcpBridgeStartPromise: Promise<McpBridgeConfig | null> | null = null;
let storeInitPromise: Promise<SqliteStore> | null = null;
let openClawEngineManager: OpenClawEngineManager | null = null;
let openClawConfigSync: OpenClawConfigSync | null = null;
let openClawBootstrapPromise: Promise<OpenClawEngineStatus> | null = null;
let openClawStatusForwarderBound = false;
let coworkRuntimeForwarderBound = false;
let memoryMigrationDone = false;
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
        `[OpenClaw] bootstrap: mcpBridgeServer=${mcpBridgeServer?.callbackUrl || 'null'}, mcpServerManager.tools=${mcpServerManager?.toolManifest?.length ?? 'null'}, secret=${mcpBridgeSecret ? 'set' : 'null'}`,
      );

      // Ensure IDENTITY.md has default content in the current workspace
      try {
        ensureDefaultIdentity(getCoworkStore().getConfig().workingDirectory);
      } catch (err) {
        console.warn('[OpenClaw] bootstrap: ensureDefaultIdentity failed (non-fatal):', err);
      }

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
    const cleaned = coworkStore.autoDeleteNonPersonalMemories();
    if (cleaned > 0) {
      console.info(`[cowork-memory] Auto-deleted ${cleaned} non-personal/procedural memories`);
    }
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
      isEnterprise: () => !!getStore().get('enterprise_config'),
      getSkillsList: () =>
        getSkillManager()
          .listSkills()
          .map(s => ({ id: s.id, enabled: s.enabled })),
      getMcpBridgeConfig: (): McpBridgeConfig | null => {
        if (
          !mcpBridgeServer?.callbackUrl ||
          !mcpBridgeServer?.askUserCallbackUrl ||
          !mcpBridgeSecret
        ) {
          return null;
        }
        return {
          callbackUrl: mcpBridgeServer.callbackUrl,
          askUserCallbackUrl: mcpBridgeServer.askUserCallbackUrl,
          secret: mcpBridgeSecret,
          tools: mcpServerManager?.toolManifest ?? [],
        };
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
  try {
    if (getCronJobService()?.hasRunningJobs()) return true;
  } catch {
    // CronJobService may not be initialized yet.
  }
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

  // After every successful config sync, merge enterprise openclaw.json
  // fields into the generated runtime config. Enterprise values win.
  try {
    mergeEnterpriseOpenclawConfig(getOpenClawEngineManager().getConfigPath());
  } catch {
    /* non-critical */
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
    console.log(
      '[CoworkForwarder] forwarding message: sessionId=',
      sessionId,
      'type=',
      messageType,
      'windowCount=',
      windows.length,
    );
    windows.forEach(win => {
      if (win.isDestroyed()) return;
      try {
        win.webContents.send('cowork:stream:message', { sessionId, message: safeMessage });
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
    (sessionId: string, messageId: string, metadata: Record<string, unknown>) => {
      const windows = BrowserWindow.getAllWindows();
      windows.forEach(win => {
        if (win.isDestroyed()) return;
        try {
          win.webContents.send('cowork:stream:messageMetadataUpdate', {
            sessionId,
            messageId,
            metadata,
          });
        } catch (error) {
          console.error('Failed to forward cowork message metadata update:', error);
        }
      });
    },
  );

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

  runtime.on('complete', (sessionId: string, claudeSessionId: string | null) => {
    const windows = BrowserWindow.getAllWindows();
    windows.forEach(win => {
      if (win.isDestroyed()) return;
      win.webContents.send('cowork:stream:complete', { sessionId, claudeSessionId });
    });
    // If session used a server model, notify renderer to refresh quota
    try {
      const apiConfig = resolveCurrentApiConfig();
      if (apiConfig.providerMetadata?.providerName === 'gucciai-server') {
        const windows = BrowserWindow.getAllWindows();
        windows.forEach(win => {
          if (win.isDestroyed()) return;
          win.webContents.send('auth:quotaChanged');
        });
      }
    } catch {
      // ignore
    }
  });

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
      getCurrentEngine: resolveCoworkAgentEngine,
      openclawRuntime: openClawRuntimeAdapter,
    });
  }
  return coworkEngineRouter;
};

const getSkillManager = () => {
  if (!skillManager) {
    skillManager = new SkillManager(getStore);
  }
  return skillManager;
};

const getMcpStore = () => {
  if (!mcpStore) {
    const sqliteStore = getStore();
    mcpStore = new McpStore(sqliteStore.getDatabase());
  }
  return mcpStore;
};

/**
 * Start the MCP Bridge: server manager + HTTP callback.
 * Called during OpenClaw bootstrap before config sync.
 * Returns the bridge config to be written into openclaw.json.
 *
 * The HTTP callback server is always started (even without MCP servers)
 * because the AskUserQuestion plugin also uses it for user confirmation dialogs.
 */
const startMcpBridge = (): Promise<McpBridgeConfig | null> => {
  // Deduplicate concurrent calls — only one initialization at a time
  if (mcpBridgeStartPromise) {
    return mcpBridgeStartPromise;
  }
  mcpBridgeStartPromise = (async (): Promise<McpBridgeConfig | null> => {
    try {
      console.log('[McpBridge] startMcpBridge called');

      // Generate a per-session secret for bridge auth
      if (!mcpBridgeSecret) {
        const crypto = await import('crypto');
        mcpBridgeSecret = crypto.randomUUID();
      }

      // Discover MCP tools (may be empty if no servers configured)
      const enabledServers = getMcpStore().getEnabledServers();
      console.log(
        `[McpBridge] enabledServers: ${enabledServers.length} (${enabledServers.map(s => s.name).join(', ')})`,
      );

      let tools: Awaited<ReturnType<McpServerManager['startServers']>> = [];
      if (enabledServers.length > 0) {
        if (!mcpServerManager) {
          mcpServerManager = new McpServerManager();
        }
        console.log('[McpBridge] starting MCP servers...');
        tools = await mcpServerManager.startServers(enabledServers);
        console.log(`[McpBridge] tools discovered: ${tools.length}`);
      }

      // Always start HTTP callback server (serves both MCP Bridge and AskUserQuestion)
      if (!mcpServerManager) {
        mcpServerManager = new McpServerManager();
      }
      if (!mcpBridgeServer) {
        mcpBridgeServer = new McpBridgeServer(mcpServerManager, mcpBridgeSecret);
      }
      if (!mcpBridgeServer.port) {
        console.log('[McpBridge] starting HTTP callback server...');
        await mcpBridgeServer.start();
      }

      // Register AskUserQuestion callback — shows a permission modal when the
      // ask-user-question OpenClaw plugin sends a request via HTTP.
      mcpBridgeServer.onAskUser(request => {
        const windows = BrowserWindow.getAllWindows();
        windows.forEach(win => {
          if (win.isDestroyed()) return;
          try {
            win.webContents.send('cowork:stream:permission', {
              sessionId: '__askuser__',
              request: {
                requestId: request.requestId,
                toolName: 'AskUserQuestion',
                toolInput: { questions: request.questions },
              },
            });
          } catch (error) {
            console.error('[AskUser] failed to send permission request to window:', error);
          }
        });
      });

      // Dismiss the AskUser modal when timeout or resolved from server side.
      // Simulate a deny response to remove it from the renderer's pending queue.
      mcpBridgeServer.onAskUserDismiss(requestId => {
        const windows = BrowserWindow.getAllWindows();
        windows.forEach(win => {
          if (win.isDestroyed()) return;
          try {
            win.webContents.send('cowork:stream:permissionDismiss', { requestId });
          } catch {
            // ignore
          }
        });
      });

      const callbackUrl = mcpBridgeServer.callbackUrl;
      const askUserCallbackUrl = mcpBridgeServer.askUserCallbackUrl;
      if (!callbackUrl || !askUserCallbackUrl) {
        console.error('[McpBridge] failed to get callback URL');
        return null;
      }

      console.log(`[McpBridge] started: ${tools.length} MCP tools, callback=${callbackUrl}`);
      return { callbackUrl, askUserCallbackUrl, secret: mcpBridgeSecret, tools };
    } catch (error) {
      console.error(
        '[McpBridge] startup error:',
        error instanceof Error ? error.stack || error.message : String(error),
      );
      return null;
    }
  })().finally(() => {
    mcpBridgeStartPromise = null;
  });
  return mcpBridgeStartPromise;
};

/**
 * Stop the MCP Bridge: server manager + HTTP callback.
 */
const _stopMcpBridge = async (): Promise<void> => {
  try {
    if (mcpServerManager) {
      await mcpServerManager.stopServers();
    }
    if (mcpBridgeServer) {
      await mcpBridgeServer.stop();
    }
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

      // 1. Stop existing MCP servers (but keep HTTP callback server alive — port stays the same)
      if (mcpServerManager) {
        await mcpServerManager.stopServers();
      }

      // 2. Re-discover tools from the new set of enabled servers
      const bridgeConfig = await startMcpBridge();
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

let isQuitting = false;

// 存储活跃的流式请求控制器
const activeStreamControllers = new Map<string, AbortController>();
let lastReloadAt = 0;
const MIN_RELOAD_INTERVAL_MS = 5000;
type AppConfigSettings = {
  theme?: string;
  language?: string;
  useSystemProxy?: boolean;
};

const getUseSystemProxyFromConfig = (config?: { useSystemProxy?: boolean }): boolean => {
  return config?.useSystemProxy === true;
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

const applyProxyPreference = async (useSystemProxy: boolean): Promise<void> => {
  try {
    await session.defaultSession.setProxy({ mode: useSystemProxy ? 'system' : 'direct' });
  } catch (error) {
    console.error('[Main] Failed to apply session proxy mode:', error);
  }

  setSystemProxyEnabled(useSystemProxy);

  if (!useSystemProxy) {
    restoreOriginalProxyEnv();
    console.log('[Main] System proxy disabled (direct mode).');
    return;
  }

  const proxyUrl = await resolveSystemProxyUrl('https://openrouter.ai');
  applySystemProxyEnv(proxyUrl);

  if (proxyUrl) {
    console.log('[Main] System proxy enabled for process env:', proxyUrl);
  } else {
    console.warn('[Main] System proxy mode enabled, but no proxy endpoint was resolved (DIRECT).');
  }
};

const emitWindowState = () => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.webContents.isDestroyed()) return;
  mainWindow.webContents.send('window:state-changed', {
    isMaximized: mainWindow.isMaximized(),
    isFullscreen: mainWindow.isFullScreen(),
    isFocused: mainWindow.isFocused(),
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
  // IPC 处理程序
  ipcMain.handle('store:get', (_event, key) => {
    return getStore().get(key);
  });

  ipcMain.handle('store:set', async (_event, key, value) => {
    getStore().set(key, value);
    if (key === 'app_config') {
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
    }
  });

  ipcMain.handle('store:remove', (_event, key) => {
    getStore().delete(key);
  });

  ipcMain.handle('enterprise:getConfig', async () => {
    try {
      return getStore().get('enterprise_config') ?? null;
    } catch {
      return null;
    }
  });

  // Network status change handler
  // Remove any existing listener first to avoid duplicate registrations
  ipcMain.removeAllListeners('network:status-change');
  ipcMain.on('network:status-change', (_event, status: 'online' | 'offline') => {
    console.log(`[Main] Network status changed: ${status}`);
  });

  // Log IPC handlers
  ipcMain.handle('log:getPath', () => {
    return getLogFilePath();
  });

  ipcMain.handle('log:openFolder', () => {
    const logPath = getLogFilePath();
    if (logPath) {
      shell.showItemInFolder(logPath);
    }
  });

  ipcMain.handle('log:exportZip', async event => {
    try {
      const ownerWindow = BrowserWindow.fromWebContents(event.sender);
      if (!ownerWindow || ownerWindow.isDestroyed()) {
        return { success: false, error: 'Window is not available' };
      }

      const saveOptions = {
        title: 'Export Logs',
        defaultPath: path.join(app.getPath('downloads'), buildLogExportFileName()),
        filters: [{ name: 'Zip Archive', extensions: ['zip'] }],
      };

      const saveResult = await dialog.showSaveDialog(ownerWindow, saveOptions);

      if (saveResult.canceled || !saveResult.filePath) {
        return { success: true, canceled: true };
      }

      const outputPath = ensureZipFileName(saveResult.filePath);
      const archiveResult = await exportLogsZip({
        outputPath,
        entries: [
          ...getRecentMainLogEntries(),
          { archiveName: 'cowork.log', filePath: getCoworkLogPath() },
        ],
      });

      return {
        success: true,
        canceled: false,
        path: outputPath,
        missingEntries: archiveResult.missingEntries,
      };
    } catch (error) {
      console.error('[LogExport] export failed:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to export logs',
      };
    }
  });

  // Auto-launch IPC handlers
  // Use SQLite store as the source of truth for UI state, because
  // app.getLoginItemSettings() returns unreliable values on macOS and
  // requires matching args on Windows.
  ipcMain.handle('app:getAutoLaunch', () => {
    const stored = getStore().get<boolean>('auto_launch_enabled');
    // Fall back to OS API if SQLite has no record yet (e.g. upgraded from older version)
    const enabled = stored ?? getAutoLaunchEnabled();
    return { enabled };
  });

  ipcMain.handle('app:setAutoLaunch', (_event, enabled: unknown) => {
    if (typeof enabled !== 'boolean') {
      return { success: false, error: 'Invalid parameter: enabled must be boolean' };
    }
    try {
      setAutoLaunchEnabled(enabled);
      getStore().set('auto_launch_enabled', enabled);
      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to set auto-launch',
      };
    }
  });

  ipcMain.handle('app:getPreventSleep', () => {
    const enabled = getStore().get<boolean>('prevent_sleep_enabled') ?? false;
    return { enabled };
  });

  ipcMain.handle('app:setPreventSleep', (_event, enabled: unknown) => {
    if (typeof enabled !== 'boolean') {
      return { success: false, error: 'Invalid parameter: enabled must be boolean' };
    }
    try {
      if (enabled) {
        if (preventSleepBlockerId === null || !powerSaveBlocker.isStarted(preventSleepBlockerId)) {
          preventSleepBlockerId = powerSaveBlocker.start('prevent-app-suspension');
        }
      } else {
        if (preventSleepBlockerId !== null && powerSaveBlocker.isStarted(preventSleepBlockerId)) {
          powerSaveBlocker.stop(preventSleepBlockerId);
          preventSleepBlockerId = null;
        }
      }
      getStore().set('prevent_sleep_enabled', enabled);
      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to set prevent-sleep',
      };
    }
  });

  // Window control IPC handlers
  ipcMain.on('window-minimize', () => {
    mainWindow?.minimize();
  });

  ipcMain.on('window-maximize', () => {
    if (mainWindow?.isMaximized()) {
      mainWindow.unmaximize();
    } else {
      mainWindow?.maximize();
    }
  });

  ipcMain.on('window-close', () => {
    mainWindow?.close();
  });

  ipcMain.handle('window:isMaximized', () => {
    return mainWindow?.isMaximized() ?? false;
  });

  ipcMain.on(
    'window:showSystemMenu',
    (_event, position: { x?: number; y?: number } | undefined) => {
      showSystemMenu(position);
    },
  );

  ipcMain.handle('app:getVersion', () => app.getVersion());
  ipcMain.handle('app:getSystemLocale', () => app.getLocale());

  // Skills IPC handlers - Gateway RPC based
  // All skill operations go through OpenClaw Gateway.
  // Gateway offline = skills unavailable, UI locked.

  ipcMain.handle('skills:list', async () => {
    try {
      const adapter = openClawRuntimeAdapter;
      if (!adapter) {
        return {
          success: false,
          error: 'Gateway not connected',
          gatewayOffline: true,
        };
      }
      const status = await adapter.getSkillsStatus();
      const skills = status.skills.map(entry => ({
        id: entry.skillKey,
        name: entry.name,
        description: entry.description,
        enabled: !entry.disabled,
        isOfficial: entry.bundled,
        isBuiltIn: entry.bundled,
        updatedAt: Date.now(),
        prompt: '',
        skillPath: entry.filePath,
        version: undefined as string | undefined,
        // Gateway extended fields
        source: entry.source,
        eligible: entry.eligible,
        missing: entry.missing,
        install: entry.install,
        emoji: entry.emoji,
        homepage: entry.homepage,
      }));
      return { success: true, skills, workspaceDir: status.workspaceDir };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Failed to load skills';
      console.error('[Skills] skills:list error:', errorMsg);
      return {
        success: false,
        error: errorMsg,
        gatewayOffline: errorMsg.includes('not connected'),
      };
    }
  });

  ipcMain.handle('skills:setEnabled', async (_event, options: { id: string; enabled: boolean }) => {
    try {
      const adapter = openClawRuntimeAdapter;
      if (!adapter) {
        return {
          success: false,
          error: 'Gateway not connected',
          gatewayOffline: true,
        };
      }
      const result = await adapter.updateSkillConfig({
        skillKey: options.id,
        enabled: options.enabled,
      });
      if (!result.ok) {
        return { success: false, error: result.error || 'Failed to update skill' };
      }
      // Refetch skill list after update
      const status = await adapter.getSkillsStatus();
      const skills = status.skills.map(entry => ({
        id: entry.skillKey,
        name: entry.name,
        description: entry.description,
        enabled: !entry.disabled,
        isOfficial: entry.bundled,
        isBuiltIn: entry.bundled,
        updatedAt: Date.now(),
        prompt: '',
        skillPath: entry.filePath,
        version: undefined as string | undefined,
        source: entry.source,
        eligible: entry.eligible,
        missing: entry.missing,
        install: entry.install,
        emoji: entry.emoji,
        homepage: entry.homepage,
      }));
      return { success: true, skills };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Failed to update skill';
      return {
        success: false,
        error: errorMsg,
        gatewayOffline: errorMsg.includes('not connected'),
      };
    }
  });

  ipcMain.handle(
    'skills:install',
    async (_event, params: import('./libs/agentEngine/types').SkillInstallParams) => {
      try {
        const adapter = openClawRuntimeAdapter;
        if (!adapter) {
          return {
            success: false,
            error: 'Gateway not connected',
            gatewayOffline: true,
          };
        }
        const result = await adapter.installSkill(params);
        return { success: result.ok, error: result.error };
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : 'Failed to install skill';
        return {
          success: false,
          error: errorMsg,
          gatewayOffline: errorMsg.includes('not connected'),
        };
      }
    },
  );

  ipcMain.handle('skills:search', async (_event, options: { query?: string; limit?: number }) => {
    try {
      const adapter = openClawRuntimeAdapter;
      if (!adapter) {
        return {
          success: false,
          error: 'Gateway not connected',
          gatewayOffline: true,
        };
      }
      const results = await adapter.searchClawHubSkills(options.query, options.limit);
      return { success: true, results };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Failed to search skills';
      return {
        success: false,
        error: errorMsg,
        gatewayOffline: errorMsg.includes('not connected'),
      };
    }
  });

  ipcMain.handle('skills:detail', async (_event, options: { slug: string }) => {
    try {
      const adapter = openClawRuntimeAdapter;
      if (!adapter) {
        return {
          success: false,
          error: 'Gateway not connected',
          gatewayOffline: true,
        };
      }
      const detail = await adapter.getClawHubSkillDetail(options.slug);
      return { success: true, detail };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Failed to get skill detail';
      return {
        success: false,
        error: errorMsg,
        gatewayOffline: errorMsg.includes('not connected'),
      };
    }
  });

  // Deprecated handlers - no longer needed, Gateway manages everything
  // skills:delete - Gateway doesn't support delete via RPC, use file system directly or disable
  ipcMain.handle('skills:delete', async (_event, id: string) => {
    // Skills delete not supported via Gateway RPC
    // User should disable skill instead
    return {
      success: false,
      error: 'Skill deletion not supported. Please disable the skill instead.',
    };
  });

  // skills:getRoot - No longer needed, Gateway manages skill locations
  ipcMain.handle('skills:getRoot', () => {
    return { success: false, error: 'Local skill root no longer used. Gateway manages skills.' };
  });

  // skills:autoRoutingPrompt - No longer needed, Gateway handles skill routing
  ipcMain.handle('skills:autoRoutingPrompt', () => {
    return { success: false, prompt: '' };
  });

  // skills:getConfig / skills:setConfig - No longer needed, use Gateway skills.update
  ipcMain.handle('skills:getConfig', (_event, skillId: string) => {
    return null;
  });

  ipcMain.handle('skills:setConfig', (_event, skillId: string, config: Record<string, string>) => {
    return null;
  });

  ipcMain.handle(
    'skills:testEmailConnectivity',
    async (_event, skillId: string, config: Record<string, string>) => {
      // No longer supported - Gateway manages skill connectivity
      return null;
    },
  );

  ipcMain.handle('openclaw:engine:getStatus', async () => {
    try {
      const manager = getOpenClawEngineManager();
      return {
        success: true,
        status: manager.getStatus(),
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to get OpenClaw engine status',
      };
    }
  });

  ipcMain.handle('openclaw:engine:install', async () => {
    try {
      const status = await bootstrapOpenClawEngine({
        forceReinstall: false,
        reason: 'manual-install',
      });
      return {
        success: status.phase === 'running' || status.phase === 'ready',
        status,
      };
    } catch (error) {
      const manager = getOpenClawEngineManager();
      return {
        success: false,
        status: manager.getStatus(),
        error: error instanceof Error ? error.message : 'Failed to install OpenClaw engine',
      };
    }
  });

  ipcMain.handle('openclaw:engine:retryInstall', async () => {
    try {
      const status = await bootstrapOpenClawEngine({
        forceReinstall: true,
        reason: 'manual-retry',
      });
      return {
        success: status.phase === 'running' || status.phase === 'ready',
        status,
      };
    } catch (error) {
      const manager = getOpenClawEngineManager();
      return {
        success: false,
        status: manager.getStatus(),
        error: error instanceof Error ? error.message : 'Failed to retry OpenClaw engine install',
      };
    }
  });

  let restartGatewayPromise: Promise<OpenClawEngineStatus> | null = null;
  ipcMain.handle('openclaw:engine:restartGateway', async () => {
    if (restartGatewayPromise) {
      const status = await restartGatewayPromise;
      return { success: status.phase === 'running' || status.phase === 'ready', status };
    }
    try {
      const manager = getOpenClawEngineManager();
      restartGatewayPromise = manager.restartGateway();
      const status = await restartGatewayPromise;
      return {
        success: status.phase === 'running' || status.phase === 'ready',
        status,
      };
    } catch (error) {
      const manager = getOpenClawEngineManager();
      return {
        success: false,
        status: manager.getStatus(),
        error: error instanceof Error ? error.message : 'Failed to restart OpenClaw gateway',
      };
    } finally {
      restartGatewayPromise = null;
    }
  });

  ipcMain.handle('openclaw:engine:getPort', () => {
    try {
      const port = getOpenClawEngineManager().getGatewayPort();
      return { success: true, port };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to get OpenClaw gateway port',
      };
    }
  });

  ipcMain.handle('openclaw:engine:getToken', () => {
    try {
      const manager = getOpenClawEngineManager();
      let token = manager.getGatewayToken();
      const status = manager.getStatus();

      // If gateway is running but token is null, try to ensure it exists
      if (token === null && status.phase === 'running') {
        console.log('[Main] Gateway running but token is null, checking token file...');
        // Gateway should have created the token during startup
        // If missing, the gateway process might have failed to write it
        // Try one more time to read it (could be a timing issue)
        const connectionInfo = manager.getGatewayConnectionInfo();
        if (connectionInfo.token) {
          token = connectionInfo.token;
          console.log('[Main] Got token from connection info');
        }
      }

      if (token === null) {
        if (status.phase !== 'running') {
          return {
            success: false,
            error: 'Gateway not running',
          };
        }
        // Gateway is running but token is unavailable - unusual state
        console.warn('[Main] Gateway is running but token is unavailable');
        return {
          success: false,
          error: 'Gateway token not available. Try restarting the gateway.',
        };
      }

      return { success: true, token };
    } catch (error) {
      console.error('[Main] Error getting gateway token:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to get OpenClaw gateway token',
      };
    }
  });

  ipcMain.handle('openclaw:engine:setPort', (_event, port: number) => {
    try {
      const result = getOpenClawEngineManager().setGatewayPort(port);
      return result;
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to set OpenClaw gateway port',
      };
    }
  });

  // MCP Server IPC handlers
  ipcMain.handle('mcp:list', () => {
    try {
      const servers = getMcpStore().listServers();
      return { success: true, servers };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to list MCP servers',
      };
    }
  });

  ipcMain.handle(
    'mcp:create',
    async (
      _event,
      data: {
        name: string;
        description: string;
        transportType: string;
        command?: string;
        args?: string[];
        env?: Record<string, string>;
        url?: string;
        headers?: Record<string, string>;
      },
    ) => {
      try {
        getMcpStore().createServer(data as McpServerFormData);
        const servers = getMcpStore().listServers();
        // Trigger async MCP bridge refresh (don't await — let UI show DB result immediately)
        refreshMcpBridge().catch(err =>
          console.error('[McpBridge] background refresh error:', err),
        );
        return { success: true, servers };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to create MCP server',
        };
      }
    },
  );

  ipcMain.handle(
    'mcp:update',
    async (
      _event,
      id: string,
      data: {
        name?: string;
        description?: string;
        transportType?: string;
        command?: string;
        args?: string[];
        env?: Record<string, string>;
        url?: string;
        headers?: Record<string, string>;
      },
    ) => {
      try {
        getMcpStore().updateServer(id, data as Partial<McpServerFormData>);
        const servers = getMcpStore().listServers();
        refreshMcpBridge().catch(err =>
          console.error('[McpBridge] background refresh error:', err),
        );
        return { success: true, servers };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to update MCP server',
        };
      }
    },
  );

  ipcMain.handle('mcp:delete', async (_event, id: string) => {
    try {
      getMcpStore().deleteServer(id);
      const servers = getMcpStore().listServers();
      refreshMcpBridge().catch(err => console.error('[McpBridge] background refresh error:', err));
      return { success: true, servers };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to delete MCP server',
      };
    }
  });

  ipcMain.handle('mcp:setEnabled', async (_event, options: { id: string; enabled: boolean }) => {
    try {
      getMcpStore().setEnabled(options.id, options.enabled);
      const servers = getMcpStore().listServers();
      refreshMcpBridge().catch(err => console.error('[McpBridge] background refresh error:', err));
      return { success: true, servers };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to update MCP server',
      };
    }
  });

  // Explicit bridge refresh — renderer can await this for loading state
  ipcMain.handle('mcp:refreshBridge', async () => {
    try {
      const result = await refreshMcpBridge();
      return { success: true, tools: result.tools, error: result.error };
    } catch (error) {
      return {
        success: false,
        tools: 0,
        error: error instanceof Error ? error.message : 'Failed to refresh MCP bridge',
      };
    }
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

        // Update session status to 'running' before starting async task
        // This ensures the frontend receives the correct status immediately
        coworkStoreInstance.updateSession(session.id, { status: 'running' });

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

  // Session Group IPC handlers
  ipcMain.handle('sessionGroup:list', async () => {
    try {
      const groups = getGroupStore().listGroups();
      return { success: true, groups };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to list groups',
      };
    }
  });

  ipcMain.handle('sessionGroup:create', async (_event, input: { name: string; color?: string }) => {
    try {
      const group = getGroupStore().createGroup(input);
      return { success: true, group };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to create group',
      };
    }
  });

  ipcMain.handle(
    'sessionGroup:update',
    async (_event, id: string, input: { name?: string; color?: string; sortOrder?: number }) => {
      try {
        const group = getGroupStore().updateGroup(id, input);
        return { success: true, group };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to update group',
        };
      }
    },
  );

  ipcMain.handle('sessionGroup:delete', async (_event, id: string) => {
    try {
      const deleted = getGroupStore().deleteGroup(id);
      return { success: deleted };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to delete group',
      };
    }
  });

  ipcMain.handle(
    'sessionGroup:moveSession',
    async (_event, sessionId: string, groupId: string | null) => {
      try {
        const moved = getGroupStore().moveSessionToGroup(sessionId, groupId);
        return { success: moved };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to move session',
        };
      }
    },
  );

  ipcMain.handle('sessionGroup:reorder', async (_event, groupIds: string[]) => {
    try {
      getGroupStore().reorderGroups(groupIds);
      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to reorder groups',
      };
    }
  });

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
        return { success: true, statuses: {}, displayLabels: {} };
      }
      const result = (openClawRuntimeAdapter as any).getSubagentStatuses(sessionId);
      return {
        success: true,
        statuses: result.statuses || {},
        displayLabels: result.displayLabels || {},
      };
    } catch (error) {
      return { success: false, statuses: {}, displayLabels: {} };
    }
  });

  ipcMain.handle(
    'cowork:subTask:history',
    async (_event, options: { parentSessionId: string; agentId: string; sessionKey?: string }) => {
      try {
        if (!openClawRuntimeAdapter) {
          return {
            success: false,
            error: 'Sub-task history is only available with the OpenClaw engine.',
          };
        }
        const messages = await openClawRuntimeAdapter.getSubTaskHistory(
          options.parentSessionId,
          options.agentId,
          options.sessionKey,
        );
        return { success: true, messages };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to get sub-task history',
        };
      }
    },
  );

  // ========== Agent IPC Handlers ==========

  ipcMain.handle('agents:list', async () => {
    try {
      const agents = getAgentManager().listAgents();
      return { success: true, agents };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to list agents',
      };
    }
  });

  ipcMain.handle('agents:get', async (_event, id: string) => {
    try {
      const agent = getAgentManager().getAgent(id);
      return { success: true, agent };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to get agent',
      };
    }
  });

  ipcMain.handle(
    'agents:create',
    async (_event, request: import('./coworkStore').CreateAgentRequest) => {
      try {
        const agent = getAgentManager().createAgent(request, resolveDefaultAgentModelRef());
        // Sync config so workspace files (SOUL.md, IDENTITY.md) are written
        // before OpenClaw scaffolds default templates for the new agent.
        syncOpenClawConfig({ reason: 'agent-created' }).catch(() => {});
        return { success: true, agent };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to create agent',
        };
      }
    },
  );

  ipcMain.handle(
    'agents:update',
    async (_event, id: string, updates: import('./coworkStore').UpdateAgentRequest) => {
      try {
        const agent = getAgentManager().updateAgent(id, updates);
        syncOpenClawConfig({ reason: 'agent-updated' }).catch(() => {});
        return { success: true, agent };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to update agent',
        };
      }
    },
  );

  ipcMain.handle('agents:delete', async (_event, id: string) => {
    try {
      const result = getAgentManager().deleteAgent(id);

      syncOpenClawConfig({ reason: 'agent-deleted' }).catch(() => {});
      return { success: true, deleted: result };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to delete agent',
      };
    }
  });

  ipcMain.handle('agents:presets', async () => {
    try {
      const presets = getAgentManager().getPresetAgents();
      return { success: true, presets };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to get presets',
      };
    }
  });

  ipcMain.handle('agents:addPreset', async (_event, presetId: string) => {
    try {
      const agent = getAgentManager().addPresetAgent(presetId, resolveDefaultAgentModelRef());
      syncOpenClawConfig({ reason: 'agent-preset-added' }).catch(() => {});
      return { success: true, agent };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to add preset agent',
      };
    }
  });

  ipcMain.handle(
    'cowork:session:exportResultImage',
    async (
      event,
      options: {
        rect: { x: number; y: number; width: number; height: number };
        defaultFileName?: string;
      },
    ) => {
      try {
        const { rect, defaultFileName } = options || {};
        const captureRect = normalizeCaptureRect(rect);
        if (!captureRect) {
          return { success: false, error: 'Capture rect is required' };
        }

        const image = await event.sender.capturePage(captureRect);
        return savePngWithDialog(event.sender, image.toPNG(), defaultFileName);
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to export session image',
        };
      }
    },
  );

  ipcMain.handle(
    'cowork:session:captureImageChunk',
    async (
      event,
      options: {
        rect: { x: number; y: number; width: number; height: number };
      },
    ) => {
      try {
        const captureRect = normalizeCaptureRect(options?.rect);
        if (!captureRect) {
          return { success: false, error: 'Capture rect is required' };
        }

        const image = await event.sender.capturePage(captureRect);
        const pngBuffer = image.toPNG();

        return {
          success: true,
          width: captureRect.width,
          height: captureRect.height,
          pngBase64: pngBuffer.toString('base64'),
        };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to capture session image chunk',
        };
      }
    },
  );

  ipcMain.handle(
    'cowork:session:saveResultImage',
    async (
      event,
      options: {
        pngBase64: string;
        defaultFileName?: string;
      },
    ) => {
      try {
        const base64 = typeof options?.pngBase64 === 'string' ? options.pngBase64.trim() : '';
        if (!base64) {
          return { success: false, error: 'Image data is required' };
        }

        const pngBuffer = Buffer.from(base64, 'base64');
        if (pngBuffer.length <= 0) {
          return { success: false, error: 'Invalid image data' };
        }

        return savePngWithDialog(event.sender, pngBuffer, options?.defaultFileName);
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to save session image',
        };
      }
    },
  );

  ipcMain.handle(
    'cowork:session:exportText',
    async (
      event,
      options: {
        content: string;
        defaultFileName?: string;
        fileExtension?: string;
      },
    ) => {
      try {
        const content = typeof options?.content === 'string' ? options.content : '';
        if (!content) {
          return { success: false, error: 'Export content is empty' };
        }

        const ext = options?.fileExtension || 'md';
        const filterName = ext === 'json' ? 'JSON' : 'Markdown';
        const defaultName = options?.defaultFileName || `session-export.${ext}`;
        const ownerWindow = BrowserWindow.fromWebContents(event.sender);
        const saveOptions = {
          title: 'Export Session',
          defaultPath: path.join(app.getPath('downloads'), defaultName),
          filters: [{ name: filterName, extensions: [ext] }],
        };
        const saveResult = ownerWindow
          ? await dialog.showSaveDialog(ownerWindow, saveOptions)
          : await dialog.showSaveDialog(saveOptions);

        if (saveResult.canceled || !saveResult.filePath) {
          return { success: true, canceled: true };
        }

        await fs.promises.writeFile(saveResult.filePath, content, 'utf-8');
        return { success: true, canceled: false, path: saveResult.filePath };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to export session',
        };
      }
    },
  );

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
        if (mcpBridgeServer && options.requestId) {
          const result = options.result;
          const askUserResponse: import('./libs/mcpBridgeServer').AskUserResponse = {
            behavior: result.behavior === 'allow' ? 'allow' : 'deny',
            answers:
              result.behavior === 'allow' &&
              result.updatedInput &&
              typeof result.updatedInput === 'object'
                ? ((result.updatedInput as Record<string, unknown>).answers as
                    | Record<string, string>
                    | undefined)
                : undefined,
          };
          mcpBridgeServer.resolveAskUser(options.requestId, askUserResponse);
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
    'cowork:memory:listEntries',
    async (
      _event,
      input: {
        query?: string;
        status?: 'created' | 'stale' | 'deleted' | 'all';
        includeDeleted?: boolean;
        limit?: number;
        offset?: number;
      },
    ) => {
      try {
        const config = getCoworkStore().getConfig();
        const filePath = resolveMemoryFilePath(config.workingDirectory);

        // Lazy migration: SQLite → MEMORY.md (one-time, cached in memory)
        if (!memoryMigrationDone) {
          migrateSqliteToMemoryMd(filePath, {
            isMigrationDone: () =>
              getStore().get<string>('openclawMemory.migration.v1.completed') === '1',
            markMigrationDone: () => {
              getStore().set('openclawMemory.migration.v1.completed', '1');
              memoryMigrationDone = true;
            },
            getActiveMemoryTexts: () => {
              return getCoworkStore()
                .listUserMemories({ status: 'all', includeDeleted: false, limit: 200 })
                .map(m => m.text);
            },
          });
          // Even if migration found nothing, skip future checks this session
          memoryMigrationDone = true;
        }

        const query = input?.query?.trim() || '';
        const entries = query ? searchMemoryEntries(filePath, query) : readMemoryEntries(filePath);
        return { success: true, entries };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to list memory entries',
        };
      }
    },
  );
  ipcMain.handle(
    'cowork:memory:createEntry',
    async (
      _event,
      input: {
        text: string;
        confidence?: number;
        isExplicit?: boolean;
      },
    ) => {
      try {
        const config = getCoworkStore().getConfig();
        const filePath = resolveMemoryFilePath(config.workingDirectory);
        const entry = addMemoryEntry(filePath, input.text);
        return { success: true, entry };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to create memory entry',
        };
      }
    },
  );
  ipcMain.handle(
    'cowork:memory:updateEntry',
    async (
      _event,
      input: {
        id: string;
        text?: string;
        confidence?: number;
        status?: 'created' | 'stale' | 'deleted';
        isExplicit?: boolean;
      },
    ) => {
      try {
        const config = getCoworkStore().getConfig();
        const filePath = resolveMemoryFilePath(config.workingDirectory);
        if (!input.text) {
          return { success: false, error: 'Memory text is required' };
        }
        const entry = updateMemoryEntry(filePath, input.id, input.text);
        if (!entry) {
          return { success: false, error: 'Memory entry not found' };
        }
        return { success: true, entry };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to update memory entry',
        };
      }
    },
  );
  ipcMain.handle(
    'cowork:memory:deleteEntry',
    async (
      _event,
      input: {
        id: string;
      },
    ) => {
      try {
        const config = getCoworkStore().getConfig();
        const filePath = resolveMemoryFilePath(config.workingDirectory);
        const success = deleteMemoryEntry(filePath, input.id);
        return success ? { success: true } : { success: false, error: 'Memory entry not found' };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to delete memory entry',
        };
      }
    },
  );
  ipcMain.handle('cowork:memory:getStats', async () => {
    try {
      const config = getCoworkStore().getConfig();
      const filePath = resolveMemoryFilePath(config.workingDirectory);
      const entries = readMemoryEntries(filePath);
      return {
        success: true,
        stats: {
          total: entries.length,
          created: entries.length,
          stale: 0,
          deleted: 0,
          explicit: entries.length,
          implicit: 0,
        },
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to get memory stats',
      };
    }
  });
  ipcMain.handle('cowork:bootstrap:read', async (_event, filename: string) => {
    try {
      const config = getCoworkStore().getConfig();
      const content = readBootstrapFile(config.workingDirectory, filename);
      return { success: true, content };
    } catch (error) {
      return {
        success: false,
        content: '',
        error: error instanceof Error ? error.message : 'Failed to read bootstrap file',
      };
    }
  });
  ipcMain.handle('cowork:bootstrap:write', async (_event, filename: string, content: string) => {
    try {
      const config = getCoworkStore().getConfig();
      writeBootstrapFile(config.workingDirectory, filename, content);
      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to write bootstrap file',
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
        memoryEnabled?: boolean;
        memoryImplicitUpdateEnabled?: boolean;
        memoryLlmJudgeEnabled?: boolean;
        memoryGuardLevel?: 'strict' | 'standard' | 'relaxed';
        memoryUserMemoriesMaxItems?: number;
      },
    ) => {
      try {
        const normalizedExecutionMode =
          config.executionMode && String(config.executionMode) === 'container'
            ? 'local'
            : config.executionMode;
        const normalizedAgentEngine = config.agentEngine === 'openclaw' ? 'openclaw' : undefined;
        const normalizedMemoryEnabled =
          typeof config.memoryEnabled === 'boolean' ? config.memoryEnabled : undefined;
        const normalizedMemoryImplicitUpdateEnabled =
          typeof config.memoryImplicitUpdateEnabled === 'boolean'
            ? config.memoryImplicitUpdateEnabled
            : undefined;
        const normalizedMemoryLlmJudgeEnabled =
          typeof config.memoryLlmJudgeEnabled === 'boolean'
            ? config.memoryLlmJudgeEnabled
            : undefined;
        const normalizedMemoryGuardLevel =
          config.memoryGuardLevel === 'strict' ||
          config.memoryGuardLevel === 'standard' ||
          config.memoryGuardLevel === 'relaxed'
            ? config.memoryGuardLevel
            : undefined;
        const normalizedMemoryUserMemoriesMaxItems =
          typeof config.memoryUserMemoriesMaxItems === 'number' &&
          Number.isFinite(config.memoryUserMemoriesMaxItems)
            ? Math.max(
                MIN_MEMORY_USER_MEMORIES_MAX_ITEMS,
                Math.min(
                  MAX_MEMORY_USER_MEMORIES_MAX_ITEMS,
                  Math.floor(config.memoryUserMemoriesMaxItems),
                ),
              )
            : undefined;
        const normalizedConfig: Parameters<CoworkStore['setConfig']>[0] = {
          ...config,
          executionMode: normalizedExecutionMode,
          agentEngine: normalizedAgentEngine,
          memoryEnabled: normalizedMemoryEnabled,
          memoryImplicitUpdateEnabled: normalizedMemoryImplicitUpdateEnabled,
          memoryLlmJudgeEnabled: normalizedMemoryLlmJudgeEnabled,
          memoryGuardLevel: normalizedMemoryGuardLevel,
          memoryUserMemoriesMaxItems: normalizedMemoryUserMemoriesMaxItems,
        };
        const previousConfig = getCoworkStore().getConfig();
        const previousWorkingDir = previousConfig.workingDirectory;
        getCoworkStore().setConfig(normalizedConfig);
        if (
          normalizedConfig.workingDirectory !== undefined &&
          normalizedConfig.workingDirectory !== previousWorkingDir
        ) {
          getSkillManager().handleWorkingDirectoryChange();
          // Sync MEMORY.md to new workspace directory
          const syncResult = syncMemoryFileOnWorkspaceChange(
            previousWorkingDir,
            normalizedConfig.workingDirectory,
          );
          if (syncResult.error) {
            console.warn('[OpenClaw Memory] Workspace sync failed:', syncResult.error);
          }
          // Ensure IDENTITY.md has default content in the new workspace
          try {
            ensureDefaultIdentity(normalizedConfig.workingDirectory);
          } catch (err) {
            console.warn('[OpenClaw] ensureDefaultIdentity failed (non-fatal):', err);
          }
        }

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

  // Set default model in app_config (used when no agent/session exists)
  ipcMain.handle(
    'config:setDefaultModel',
    async (_event, options: { modelId: string; providerKey?: string }) => {
      try {
        type AppConfigWithModel = {
          model?: {
            defaultModel?: string;
            defaultModelProvider?: string;
          };
          providers?: Record<string, unknown>;
          theme?: string;
          language?: string;
          useSystemProxy?: boolean;
        };
        const currentConfig = getStore().get<AppConfigWithModel>('app_config') || {};
        const updatedConfig = {
          ...currentConfig,
          model: {
            ...currentConfig.model,
            defaultModel: options.modelId,
            defaultModelProvider: options.providerKey || currentConfig.model?.defaultModelProvider,
          },
        };
        getStore().set('app_config', updatedConfig);

        // Also update main agent's model in the database so agents.list reflects the new model
        const modelRef = options.providerKey
          ? `${options.providerKey}/${options.modelId}`
          : options.modelId;
        try {
          const mainAgent = getCoworkStore().getAgent('main');
          if (mainAgent && mainAgent.model !== modelRef) {
            getCoworkStore().updateAgent('main', { model: modelRef });
          }
        } catch {
          // Non-fatal: agent update failed, config sync will still proceed
        }

        // syncOpenClawConfig will pick up the updated agent model
        const syncResult = await syncOpenClawConfig({
          reason: 'default-model-change',
          restartGatewayIfRunning: false,
        });
        if (!syncResult.success) {
          console.error(
            '[Main] Failed to sync OpenClaw config after default model update:',
            syncResult.error,
          );
        }
        return { success: true };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to set default model',
        };
      }
    },
  );

  // ==================== Scheduled Task IPC Handlers (OpenClaw) ====================

  initCronJobServiceManager({
    getOpenClawRuntimeAdapter: () => openClawRuntimeAdapter,
  });
  registerScheduledTaskHandlers({
    getCronJobService,
    getOpenClawRuntimeAdapter: () => openClawRuntimeAdapter,
  });

  // ==================== Permissions IPC Handlers ====================

  ipcMain.handle('permissions:checkCalendar', async () => {
    try {
      const status = await checkCalendarPermission();

      // Development mode: Auto-request permission if not determined
      // This provides a better dev experience without affecting production
      if (isDev && status === 'not-determined' && process.platform === 'darwin') {
        console.log('[Permissions] Development mode: Auto-requesting calendar permission...');
        try {
          await requestCalendarPermission();
          const newStatus = await checkCalendarPermission();
          console.log(
            '[Permissions] Development mode: Permission status after request:',
            newStatus,
          );
          return { success: true, status: newStatus, autoRequested: true };
        } catch (requestError) {
          console.warn('[Permissions] Development mode: Auto-request failed:', requestError);
        }
      }

      return { success: true, status };
    } catch (error) {
      console.error('[Main] Error checking calendar permission:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to check permission',
      };
    }
  });

  ipcMain.handle('permissions:requestCalendar', async () => {
    try {
      // Request permission and check status
      const granted = await requestCalendarPermission();
      const status = await checkCalendarPermission();
      return { success: true, granted, status };
    } catch (error) {
      console.error('[Main] Error requesting calendar permission:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to request permission',
      };
    }
  });

  // GitHub Copilot device code authentication handlers
  ipcMain.handle('github-copilot:request-device-code', async () => {
    const { requestDeviceCode } = await import('./libs/githubCopilotAuth');
    try {
      const result = await requestDeviceCode();
      return {
        userCode: result.user_code,
        verificationUri: result.verification_uri,
        deviceCode: result.device_code,
        interval: result.interval,
        expiresIn: result.expires_in,
      };
    } catch (error) {
      throw new Error(error instanceof Error ? error.message : 'Failed to request device code');
    }
  });

  ipcMain.handle(
    'github-copilot:poll-for-token',
    async (
      _event,
      {
        deviceCode,
        interval,
        expiresIn,
      }: { deviceCode: string; interval: number; expiresIn: number },
    ) => {
      const { pollForAccessToken, getCopilotToken, getGitHubUser } =
        await import('./libs/githubCopilotAuth');
      try {
        const githubAccessToken = await pollForAccessToken(deviceCode, interval, expiresIn);
        const githubUser = await getGitHubUser(githubAccessToken);
        const {
          token: copilotToken,
          expiresAt,
          baseUrl,
        } = await getCopilotToken(githubAccessToken);
        // Store the GitHub access token for later token refresh
        getStore().set('github_copilot_github_token', githubAccessToken);
        // Register with the token manager for automatic refresh
        setCopilotTokenState({ copilotToken, baseUrl, expiresAt, githubToken: githubAccessToken });
        return { success: true, token: copilotToken, githubUser, baseUrl };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Authentication failed',
        };
      }
    },
  );

  ipcMain.handle('github-copilot:cancel-polling', async () => {
    const { cancelPolling } = await import('./libs/githubCopilotAuth');
    cancelPolling();
  });

  ipcMain.handle('github-copilot:sign-out', async () => {
    getStore().delete('github_copilot_github_token');
    clearCopilotTokenState();
  });

  ipcMain.handle('github-copilot:refresh-token', async () => {
    try {
      const state = await refreshCopilotTokenNow();
      return { success: true, token: state.copilotToken, baseUrl: state.baseUrl };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Token refresh failed',
      };
    }
  });

  ipcMain.handle('generate-session-title', async (_event, userInput: string | null) => {
    // Use Gateway-based title generation (reuses session authentication)
    console.log('[main] generate-session-title: attempting Gateway-based generation...');
    try {
      const router = getCoworkEngineRouter();
      console.log(
        '[main] generate-session-title: router exists, hasGenerateTitle=',
        !!router.generateTitle,
      );
      if (router.generateTitle) {
        console.log('[main] generate-session-title: calling router.generateTitle...');
        const title = await router.generateTitle(userInput);
        console.log('[main] generate-session-title: Gateway result=', title);
        return title;
      }
      console.warn(
        '[main] generate-session-title: router.generateTitle not available, using simple fallback',
      );
    } catch (error) {
      console.warn('[main] Gateway-based title generation failed:', error);
    }
    // Simple fallback when Gateway is completely unavailable (no HTTP method)
    const fallback = 'New Session';
    const normalizedInput = typeof userInput === 'string' ? userInput.trim() : '';
    if (!normalizedInput) return fallback;
    const firstLine =
      normalizedInput
        .split(/\r?\n/)
        .map(l => l.trim())
        .find(Boolean) || '';
    return firstLine.slice(0, 50).trim() || fallback;
  });

  ipcMain.handle('get-recent-cwds', async (_event, limit?: number) => {
    const boundedLimit = limit ? Math.min(Math.max(limit, 1), 20) : 8;
    return getCoworkStore().listRecentCwds(boundedLimit);
  });

  ipcMain.handle('get-api-config', async () => {
    return getCurrentApiConfig();
  });

  ipcMain.handle('check-api-config', async (_event, options?: { probeModel?: boolean }) => {
    const { config, error } = resolveCurrentApiConfig();
    if (config && options?.probeModel) {
      const probe = await probeCoworkModelReadiness();
      if (probe.ok === false) {
        return { hasConfig: false, config: null, error: probe.error };
      }
    }
    return { hasConfig: config !== null, config, error };
  });

  ipcMain.handle(
    'save-api-config',
    async (
      _event,
      config: {
        apiKey: string;
        baseURL: string;
        model: string;
        apiType?: 'anthropic' | 'openai';
      },
    ) => {
      try {
        saveCoworkApiConfig(config);
        return { success: true };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to save API config',
        };
      }
    },
  );

  // Dialog handlers
  ipcMain.handle('dialog:selectDirectory', async event => {
    const ownerWindow = BrowserWindow.fromWebContents(event.sender);
    const dialogOptions = {
      properties: ['openDirectory', 'createDirectory'] as ('openDirectory' | 'createDirectory')[],
    };
    const result = ownerWindow
      ? await dialog.showOpenDialog(ownerWindow, dialogOptions)
      : await dialog.showOpenDialog(dialogOptions);
    if (result.canceled || result.filePaths.length === 0) {
      return { success: true, path: null };
    }
    return { success: true, path: result.filePaths[0] };
  });

  ipcMain.handle(
    'dialog:selectFile',
    async (
      event,
      options?: { title?: string; filters?: { name: string; extensions: string[] }[] },
    ) => {
      const ownerWindow = BrowserWindow.fromWebContents(event.sender);
      const dialogOptions = {
        properties: ['openFile'] as 'openFile'[],
        title: options?.title,
        filters: options?.filters,
      };
      const result = ownerWindow
        ? await dialog.showOpenDialog(ownerWindow, dialogOptions)
        : await dialog.showOpenDialog(dialogOptions);
      if (result.canceled || result.filePaths.length === 0) {
        return { success: true, path: null };
      }
      return { success: true, path: result.filePaths[0] };
    },
  );

  ipcMain.handle(
    'dialog:selectFiles',
    async (
      event,
      options?: { title?: string; filters?: { name: string; extensions: string[] }[] },
    ) => {
      const ownerWindow = BrowserWindow.fromWebContents(event.sender);
      const dialogOptions = {
        properties: ['openFile', 'multiSelections'] as ('openFile' | 'multiSelections')[],
        title: options?.title,
        filters: options?.filters,
      };
      const result = ownerWindow
        ? await dialog.showOpenDialog(ownerWindow, dialogOptions)
        : await dialog.showOpenDialog(dialogOptions);
      if (result.canceled || result.filePaths.length === 0) {
        return { success: true, paths: [] };
      }
      return { success: true, paths: result.filePaths };
    },
  );

  ipcMain.handle(
    'dialog:saveInlineFile',
    async (
      _event,
      options?: { dataBase64?: string; fileName?: string; mimeType?: string; cwd?: string },
    ) => {
      try {
        const dataBase64 = typeof options?.dataBase64 === 'string' ? options.dataBase64.trim() : '';
        if (!dataBase64) {
          return { success: false, path: null, error: 'Missing file data' };
        }

        const buffer = Buffer.from(dataBase64, 'base64');
        if (!buffer.length) {
          return { success: false, path: null, error: 'Invalid file data' };
        }
        if (buffer.length > MAX_INLINE_ATTACHMENT_BYTES) {
          return {
            success: false,
            path: null,
            error: `File too large (max ${Math.floor(MAX_INLINE_ATTACHMENT_BYTES / (1024 * 1024))}MB)`,
          };
        }

        const dir = resolveInlineAttachmentDir(options?.cwd);
        await fs.promises.mkdir(dir, { recursive: true });

        const safeFileName = sanitizeAttachmentFileName(options?.fileName);
        const extension = inferAttachmentExtension(safeFileName, options?.mimeType);
        const baseName = extension ? safeFileName.slice(0, -extension.length) : safeFileName;
        const uniqueSuffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const finalName = `${baseName || 'attachment'}-${uniqueSuffix}${extension}`;
        const outputPath = path.join(dir, finalName);

        await fs.promises.writeFile(outputPath, buffer);
        return { success: true, path: outputPath };
      } catch (error) {
        return {
          success: false,
          path: null,
          error: error instanceof Error ? error.message : 'Failed to save inline file',
        };
      }
    },
  );

  // Read a local file as a data URL (data:<mime>;base64,...)
  const MAX_READ_AS_DATA_URL_BYTES = 20 * 1024 * 1024;
  const MIME_BY_EXT: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.bmp': 'image/bmp',
    '.svg': 'image/svg+xml',
    '.tiff': 'image/tiff',
    '.tif': 'image/tiff',
    '.ico': 'image/x-icon',
    '.avif': 'image/avif',
  };
  ipcMain.handle(
    'dialog:readFileAsDataUrl',
    async (
      _event,
      filePath?: string,
    ): Promise<{ success: boolean; dataUrl?: string; error?: string }> => {
      try {
        if (typeof filePath !== 'string' || !filePath.trim()) {
          return { success: false, error: 'Missing file path' };
        }
        const resolvedPath = path.resolve(filePath.trim());
        const stat = await fs.promises.stat(resolvedPath);
        if (!stat.isFile()) {
          return { success: false, error: 'Not a file' };
        }
        if (stat.size > MAX_READ_AS_DATA_URL_BYTES) {
          return {
            success: false,
            error: `File too large (max ${Math.floor(MAX_READ_AS_DATA_URL_BYTES / (1024 * 1024))}MB)`,
          };
        }
        const buffer = await fs.promises.readFile(resolvedPath);
        const ext = path.extname(resolvedPath).toLowerCase();
        const mimeType = MIME_BY_EXT[ext] || 'application/octet-stream';
        const base64 = buffer.toString('base64');
        return { success: true, dataUrl: `data:${mimeType};base64,${base64}` };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to read file',
        };
      }
    },
  );

  // Shell handlers - 打开文件/文件夹
  ipcMain.handle('shell:openPath', async (_event, filePath: string) => {
    try {
      const normalizedPath = normalizeWindowsShellPath(filePath);
      const result = await shell.openPath(normalizedPath);
      if (result) {
        // 如果返回非空字符串，表示打开失败
        return { success: false, error: result };
      }
      return { success: true };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  });

  ipcMain.handle('shell:showItemInFolder', async (_event, filePath: string) => {
    try {
      const normalizedPath = normalizeWindowsShellPath(filePath);
      shell.showItemInFolder(normalizedPath);
      return { success: true };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  });

  ipcMain.handle('shell:openExternal', async (_event, url: string) => {
    try {
      await shell.openExternal(url);
      return { success: true };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  });

  // Helper: detect if a URL belongs to GitHub Copilot and apply token refresh on 401.
  const isCopilotUrl = (url: string) => url.includes('githubcopilot.com');
  const retryCopilotWithRefreshedToken = async (opts: {
    url: string;
    method: string;
    headers: Record<string, string>;
    body?: string;
  }): Promise<{ headers: Record<string, string>; retried: boolean }> => {
    try {
      const state = await refreshCopilotTokenNow();
      const refreshedHeaders = { ...opts.headers, Authorization: `Bearer ${state.copilotToken}` };
      console.log('[CopilotRetry] token refreshed, retrying request');
      return { headers: refreshedHeaders, retried: true };
    } catch (err) {
      console.warn('[CopilotRetry] token refresh failed, not retrying:', err);
      return { headers: opts.headers, retried: false };
    }
  };

  // API 代理处理程序 - 解决 CORS 问题
  ipcMain.handle(
    'api:fetch',
    async (
      _event,
      options: {
        url: string;
        method: string;
        headers: Record<string, string>;
        body?: string;
      },
    ) => {
      console.log(
        `[api:fetch] ${options.method} ${options.url}, headers: ${JSON.stringify(options.headers)}, body: ${options.body}`,
      );

      const doFetch = async (headers: Record<string, string>) => {
        const response = await session.defaultSession.fetch(options.url, {
          method: options.method,
          headers,
          body: options.body,
        });

        const contentType = response.headers.get('content-type') || '';
        let data: string | object;

        if (contentType.includes('text/event-stream')) {
          data = await response.text();
        } else if (contentType.includes('application/json')) {
          data = await response.json();
        } else {
          data = await response.text();
        }

        return {
          ok: response.ok,
          status: response.status,
          statusText: response.statusText,
          headers: Object.fromEntries(response.headers.entries()),
          data,
        };
      };

      try {
        let result = await doFetch(options.headers);
        console.log(
          `[api:fetch] ${options.method} ${options.url} -> ${result.status} ${result.statusText}`,
          typeof result.data === 'object' ? JSON.stringify(result.data) : result.data,
        );

        // Auto-retry once for Copilot 401/403
        if (
          !result.ok &&
          (result.status === 401 || result.status === 403) &&
          isCopilotUrl(options.url)
        ) {
          console.log('[api:fetch] Copilot auth error, attempting token refresh and retry');
          const { headers: refreshedHeaders, retried } =
            await retryCopilotWithRefreshedToken(options);
          if (retried) {
            result = await doFetch(refreshedHeaders);
            console.log(`[api:fetch] retry -> ${result.status} ${result.statusText}`);
          }
        }

        return result;
      } catch (error) {
        console.error(
          `[api:fetch] ${options.method} ${options.url} -> ERROR:`,
          error instanceof Error ? error.message : error,
        );
        return {
          ok: false,
          status: 0,
          statusText: error instanceof Error ? error.message : 'Network error',
          headers: {},
          data: null,
          error: error instanceof Error ? error.message : 'Unknown error',
        };
      }
    },
  );

  // SSE 流式 API 代理
  ipcMain.handle(
    'api:stream',
    async (
      event,
      options: {
        url: string;
        method: string;
        headers: Record<string, string>;
        body?: string;
        requestId: string;
      },
    ) => {
      const controller = new AbortController();

      // 存储 controller 以便后续取消
      activeStreamControllers.set(options.requestId, controller);

      try {
        let response = await session.defaultSession.fetch(options.url, {
          method: options.method,
          headers: options.headers,
          body: options.body,
          signal: controller.signal,
        });

        // Auto-retry once for Copilot 401/403
        if (
          !response.ok &&
          (response.status === 401 || response.status === 403) &&
          isCopilotUrl(options.url)
        ) {
          console.log('[api:stream] Copilot auth error, attempting token refresh and retry');
          const { headers: refreshedHeaders, retried } =
            await retryCopilotWithRefreshedToken(options);
          if (retried) {
            response = await session.defaultSession.fetch(options.url, {
              method: options.method,
              headers: refreshedHeaders,
              body: options.body,
              signal: controller.signal,
            });
            console.log(`[api:stream] retry -> ${response.status} ${response.statusText}`);
          }
        }

        if (!response.ok) {
          const errorData = await response.text();
          activeStreamControllers.delete(options.requestId);
          return {
            ok: false,
            status: response.status,
            statusText: response.statusText,
            error: errorData,
          };
        }

        if (!response.body) {
          activeStreamControllers.delete(options.requestId);
          return {
            ok: false,
            status: response.status,
            statusText: 'No response body',
          };
        }

        // 读取流式响应并通过 IPC 发送
        const reader = response.body.getReader();
        const decoder = new TextDecoder();

        const readStream = async () => {
          try {
            while (true) {
              const { value, done } = await reader.read();
              if (done) {
                event.sender.send(`api:stream:${options.requestId}:done`);
                break;
              }
              const chunk = decoder.decode(value);
              event.sender.send(`api:stream:${options.requestId}:data`, chunk);
            }
          } catch (error) {
            if (error instanceof Error && error.name === 'AbortError') {
              event.sender.send(`api:stream:${options.requestId}:abort`);
            } else {
              event.sender.send(
                `api:stream:${options.requestId}:error`,
                error instanceof Error ? error.message : 'Stream error',
              );
            }
          } finally {
            activeStreamControllers.delete(options.requestId);
          }
        };

        // 异步读取流，立即返回成功状态
        readStream();

        return {
          ok: true,
          status: response.status,
          statusText: response.statusText,
        };
      } catch (error) {
        activeStreamControllers.delete(options.requestId);
        return {
          ok: false,
          status: 0,
          statusText: error instanceof Error ? error.message : 'Network error',
          error: error instanceof Error ? error.message : 'Unknown error',
        };
      }
    },
  );

  // 取消流式请求
  ipcMain.handle('api:stream:cancel', (_event, requestId: string) => {
    const controller = activeStreamControllers.get(requestId);
    if (controller) {
      controller.abort();
      activeStreamControllers.delete(requestId);
      return true;
    }
    return false;
  });

  // Qwen OAuth 登录
  ipcMain.handle('qwen:oauth:login', async event => {
    const { startQwenOAuth } = await import('./libs/qwenOAuth');

    const progressCallback = {
      update: (message: string) => {
        event.sender.send('qwen:oauth:progress', message);
      },
      stop: (message?: string) => {
        if (message) {
          event.sender.send('qwen:oauth:progress', message);
        }
      },
    };

    try {
      const oauthToken = await startQwenOAuth(progressCallback);
      return {
        success: true,
        data: oauthToken,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'OAuth login failed',
      };
    }
  });

  // Qwen OAuth 刷新 token
  ipcMain.handle('qwen:oauth:refresh', async (_event, refreshToken: string) => {
    const { refreshQwenOAuthToken } = await import('./libs/qwenOAuth');

    try {
      const oauthToken = await refreshQwenOAuthToken(refreshToken);
      return {
        success: true,
        data: oauthToken,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Token refresh failed',
      };
    }
  });

  // 设置 Content Security Policy
  const setContentSecurityPolicy = () => {
    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
      const devPort = process.env.ELECTRON_START_URL?.match(/:(\d+)/)?.[1] || '5175';
      const cspDirectives = [
        "default-src 'self'",
        isDev
          ? `script-src 'self' 'unsafe-inline' http://localhost:${devPort} ws://localhost:${devPort}`
          : "script-src 'self'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: https: http: localfile:",
        // 允许连接到所有域名，不做限制
        'connect-src *',
        "font-src 'self' data:",
        "media-src 'self'",
        "worker-src 'self' blob:",
        "frame-src 'self'",
      ];

      callback({
        responseHeaders: {
          ...details.responseHeaders,
          'Content-Security-Policy': cspDirectives.join('; '),
        },
      });
    });
  };

  // 创建主窗口
  const createWindow = () => {
    // 如果窗口已经存在，就不再创建新窗口
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      if (!mainWindow.isVisible()) mainWindow.show();
      if (!mainWindow.isFocused()) mainWindow.focus();
      return;
    }

    mainWindow = new BrowserWindow({
      width: 1200,
      height: 800,
      title: APP_NAME,
      icon: getAppIconPath(),
      ...(isMac
        ? {
            titleBarStyle: 'hiddenInset' as const,
            trafficLightPosition: { x: 12, y: 20 },
          }
        : isWindows
          ? {
              frame: false,
              titleBarStyle: 'hidden' as const,
            }
          : {
              titleBarStyle: 'hidden' as const,
              titleBarOverlay: getTitleBarOverlayOptions(),
            }),
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
        preload: PRELOAD_PATH,
        backgroundThrottling: false,
        devTools: isDev,
        spellcheck: false,
        enableWebSQL: false,
        autoplayPolicy: 'document-user-activation-required',
        disableDialogs: true,
        navigateOnDragDrop: false,
      },
      backgroundColor: getInitialTheme() === 'dark' ? '#0F1117' : '#F8F9FB',
      show: false,
      autoHideMenuBar: true,
      enableLargerThanScreen: false,
    });

    // 设置 macOS Dock 图标（开发模式下 Electron 默认图标不是应用 Logo）
    if (isMac && isDev) {
      const iconPath = path.join(__dirname, '../build/icons/png/512x512.png');
      if (fs.existsSync(iconPath)) {
        app.dock.setIcon(nativeImage.createFromPath(iconPath));
      }
    }

    // 禁用窗口菜单
    mainWindow.setMenu(null);

    // 处理 window.open 请求 - 打开外部链接
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
      shell.openExternal(url);
      return { action: 'deny' };
    });

    // 设置窗口的最小尺寸
    mainWindow.setMinimumSize(800, 600);

    // 设置窗口加载超时
    const loadTimeout = setTimeout(() => {
      if (mainWindow && mainWindow.webContents.isLoadingMainFrame()) {
        console.log('Window load timed out, attempting to reload...');
        scheduleReload('load-timeout');
      }
    }, 30000);

    // 清除超时
    mainWindow.webContents.once('did-finish-load', () => {
      clearTimeout(loadTimeout);
    });
    mainWindow.webContents.on('did-finish-load', () => {
      emitWindowState();
      if (openClawEngineManager && !mainWindow?.isDestroyed()) {
        mainWindow.webContents.send(
          'openclaw:engine:onProgress',
          openClawEngineManager.getStatus(),
        );
      }
    });

    // 处理窗口关闭
    mainWindow.on('close', e => {
      // In development, close should actually quit so `npm run electron:dev`
      // restarts from a clean process. In production we keep tray behavior.
      if (mainWindow && !isQuitting && !isDev) {
        e.preventDefault();
        mainWindow.hide();
      }
    });

    // 处理渲染进程崩溃或退出
    mainWindow.webContents.on('render-process-gone', (_event, details) => {
      console.error('Window render process gone:', details);
      scheduleReload('webContents-crashed');
    });

    if (isDev) {
      // 开发环境
      const maxRetries = 3;
      let retryCount = 0;

      const tryLoadURL = () => {
        mainWindow?.loadURL(DEV_SERVER_URL).catch(err => {
          console.error('Failed to load URL:', err);
          retryCount++;

          if (retryCount < maxRetries) {
            console.log(`Retrying to load URL (${retryCount}/${maxRetries})...`);
            setTimeout(tryLoadURL, 3000);
          } else {
            console.error('Failed to load URL after maximum retries');
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.loadFile(path.join(__dirname, '../resources/error.html'));
            }
          }
        });
      };

      tryLoadURL();

      // 打开开发者工具
      mainWindow.webContents.openDevTools();
    } else {
      // 生产环境
      mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
    }

    // 添加错误处理
    mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription) => {
      console.error('Page failed to load:', errorCode, errorDescription);
      // 如果加载失败，尝试重新加载
      if (isDev) {
        setTimeout(() => {
          scheduleReload('did-fail-load');
        }, 3000);
      }
    });

    // 当窗口关闭时，清除引用
    mainWindow.on('closed', () => {
      mainWindow = null;
    });

    const forwardWindowState = () => emitWindowState();
    mainWindow.on('maximize', forwardWindowState);
    mainWindow.on('unmaximize', forwardWindowState);
    mainWindow.on('enter-full-screen', forwardWindowState);
    mainWindow.on('leave-full-screen', forwardWindowState);
    mainWindow.on('focus', forwardWindowState);
    mainWindow.on('blur', forwardWindowState);

    // 等待内容加载完成后再显示窗口
    mainWindow.once('ready-to-show', () => {
      emitWindowState();
      // 开机自启时不显示窗口，仅显示托盘图标
      if (!isAutoLaunched()) {
        mainWindow?.show();
      }
      // Initialize main-process i18n from stored language before creating UI elements.
      const initLang = getStore().get<{ language?: string }>('app_config')?.language;
      setLanguage(initLang === 'en' ? 'en' : 'zh');
      // 窗口就绪后创建系统托盘
      createTray(() => mainWindow);

      // Start cron polling after the window is ready.
      (async () => {
        try {
          getCronJobService().startPolling();
        } catch (err) {
          console.warn(
            '[Main] CronJobService not available yet, will start polling when OpenClaw is ready:',
            err,
          );
        }

        // One-time migration: move tasks from legacy SQLite tables to OpenClaw gateway.
        migrateScheduledTasksToOpenclaw({
          db: getStore().getDatabase(),
          getKv: key => getStore().get(key),
          setKv: (key, value) => getStore().set(key, value),
          cronJobService: getCronJobService(),
        }).catch(err => {
          console.warn('[Main] Scheduled tasks migration failed:', err);
        });

        // One-time migration: copy legacy run history to OpenClaw cron/runs/ JSONL files.
        migrateScheduledTaskRunsToOpenclaw({
          db: getStore().getDatabase(),
          getKv: key => getStore().get(key),
          setKv: (key, value) => getStore().set(key, value),
          openclawStateDir: getOpenClawEngineManager().getStateDir(),
        }).catch(err => {
          console.warn('[Main] Scheduled task run history migration failed:', err);
        });
      })();
    });
  };

  let isCleanupFinished = false;
  let isCleanupInProgress = false;

  const runAppCleanup = async (): Promise<void> => {
    console.log('[Main] App is quitting, starting cleanup...');
    destroyTray();
    skillManager?.stopWatching();

    // Stop Cowork sessions without blocking shutdown.
    if (coworkEngineRouter) {
      console.log('[Main] Stopping cowork sessions...');
      coworkEngineRouter.stopAllSessions();
    }

    await stopCoworkOpenAICompatProxy().catch(error => {
      console.error('Failed to stop OpenAI compatibility proxy:', error);
    });

    stopOpenClawTokenProxy();

    // Stop skill services.
    const skillServices = getSkillServiceManager();
    await skillServices.stopAll();

    if (openClawEngineManager) {
      await openClawEngineManager.stopGateway().catch(error => {
        console.error('[OpenClaw] Failed to stop gateway on quit:', error);
      });
    }

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

  app.on('before-quit', e => {
    if (isCleanupFinished) return;

    e.preventDefault();
    if (isCleanupInProgress) {
      return;
    }

    isCleanupInProgress = true;
    isQuitting = true;

    void runAppCleanup()
      .catch(error => {
        console.error('[Main] Cleanup error:', error);
      })
      .finally(() => {
        isCleanupFinished = true;
        isCleanupInProgress = false;
        app.exit(0);
      });
  });

  const handleTerminationSignal = (signal: NodeJS.Signals) => {
    if (isCleanupFinished || isCleanupInProgress) {
      return;
    }
    console.log(`[Main] Received ${signal}, running cleanup before exit...`);
    isCleanupInProgress = true;
    isQuitting = true;
    void runAppCleanup()
      .catch(error => {
        console.error(`[Main] Cleanup error during ${signal}:`, error);
      })
      .finally(() => {
        isCleanupFinished = true;
        isCleanupInProgress = false;
        app.exit(0);
      });
  };

  process.once('SIGINT', () => handleTerminationSignal('SIGINT'));
  process.once('SIGTERM', () => handleTerminationSignal('SIGTERM'));

  // 初始化应用
  const initApp = async () => {
    console.log('[Main] initApp: waiting for app.whenReady()');
    await app.whenReady();
    console.log('[Main] initApp: app is ready');

    // Note: Calendar permission is checked on-demand when calendar operations are requested
    // We don't trigger permission dialogs at startup to avoid annoying users

    // Ensure default working directory exists
    const defaultProjectDir = path.join(os.homedir(), 'gucciai', 'project');
    if (!fs.existsSync(defaultProjectDir)) {
      fs.mkdirSync(defaultProjectDir, { recursive: true });
      console.log('Created default project directory:', defaultProjectDir);
    }
    console.log('[Main] initApp: default project dir ensured');

    // 注册 localfile:// 自定义协议，用于安全加载本地文件（图片等）
    protocol.handle('localfile', request => {
      const url = new URL(request.url);
      const filePath = decodeURIComponent(url.pathname);
      return net.fetch(`file://${filePath}`);
    });

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
    // Inject store getter into claudeSettings
    setStoreGetter(() => store);

    // Initialize Copilot token manager and restore token state if available
    initCopilotTokenManager(getStore);
    const storedGithubToken = getStore().get('github_copilot_github_token') as string | undefined;
    if (storedGithubToken) {
      import('./libs/githubCopilotAuth')
        .then(({ getCopilotToken }) =>
          getCopilotToken(storedGithubToken).then(({ token, expiresAt, baseUrl }) => {
            setCopilotTokenState({
              copilotToken: token,
              baseUrl,
              expiresAt,
              githubToken: storedGithubToken,
            });
            console.log('[Main] restored Copilot token state from stored GitHub token');
          }),
        )
        .catch(err => {
          console.warn('[Main] failed to restore Copilot token on startup:', err);
        });
    }

    registerProxyTokenRefresher('github-copilot', async () => {
      try {
        const { refreshCopilotTokenNow } = await import('./libs/copilotTokenManager');
        const refreshed = await refreshCopilotTokenNow();
        return refreshed.copilotToken;
      } catch (err) {
        console.warn('[Auth] Copilot proxy token refresh failed:', err);
        return null;
      }
    });

    // Enterprise config sync — must run before openclawConfigSync
    // so enterprise data is in SQLite when the config is generated.
    const enterpriseConfigPath = resolveEnterpriseConfigPath();
    if (enterpriseConfigPath) {
      try {
        const mcpStoreInstance = getMcpStore();
        syncEnterpriseConfig(
          enterpriseConfigPath,
          store,
          server => {
            const existing = mcpStoreInstance.listServers().find(s => s.name === server.name);
            if (existing) {
              mcpStoreInstance.updateServer(existing.id, {
                name: server.name,
                description: server.description,
                transportType: server.transportType as 'stdio' | 'sse' | 'http',
                command: server.command,
                args: server.args,
                env: server.env,
              });
            } else {
              mcpStoreInstance.createServer({
                name: server.name,
                description: server.description,
                transportType: server.transportType as 'stdio' | 'sse' | 'http',
                command: server.command,
                args: server.args,
                env: server.env,
              });
            }
          },
          () => {
            // Clear all MCP servers (for overwrite mode)
            for (const s of mcpStoreInstance.listServers()) {
              mcpStoreInstance.deleteServer(s.id);
            }
          },
          config => {
            const cs = getCoworkStore();
            cs.setConfig(config);
          },
          () => {
            const cs = getCoworkStore();
            return cs.getConfig().workingDirectory;
          },
        );
      } catch (error) {
        console.error('[Enterprise] config sync failed:', error);
      }
    } else {
      // No enterprise config package found — clear any previously stored config
      // so the app exits enterprise mode after the package is removed.
      const hadEnterprise = store.get('enterprise_config');
      if (hadEnterprise) {
        store.delete('enterprise_config');
        // Reset executionMode to default so sandbox mode reverts to "off".
        const cs = getCoworkStore();
        cs.setConfig({ executionMode: 'local' });
        console.log(
          '[Enterprise] config package removed, cleared enterprise mode and reset executionMode',
        );
      }
    }

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
          // Start cron polling once the gateway is confirmed running.
          try {
            getCronJobService().startPolling();
          } catch (err) {
            console.warn('[Main] CronJobService not available after OpenClaw startup:', err);
          }
        })
        .catch(error => {
          console.error('[OpenClaw] Failed to auto-start gateway on app startup:', error);
        });
    }

    console.log('[Main] initApp: setStoreGetter done');
    const manager = getSkillManager();
    console.log('[Main] initApp: getSkillManager done');

    // When skills change (install/enable/disable/delete), re-sync AGENTS.md
    // so OpenClaw's agents pick up the latest skill list.
    manager.onSkillsChanged(() => {
      syncOpenClawConfig({ reason: 'skills-changed' }).catch(error => {
        console.warn('[Main] Failed to sync OpenClaw config after skills change:', error);
      });
    });

    // Non-critical: sync bundled skills to user data.
    // Wrapped in try-catch so a failure here does not block window creation.
    try {
      manager.syncBundledSkillsToUserData();
      console.log('[Main] initApp: syncBundledSkillsToUserData done');
    } catch (error) {
      console.error('[Main] initApp: syncBundledSkillsToUserData failed:', error);
    }

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

    try {
      manager.startWatching();
      console.log('[Main] initApp: startWatching done');
    } catch (error) {
      console.error('[Main] initApp: startWatching failed:', error);
    }

    // Start skill services (non-critical)
    try {
      const skillServices = getSkillServiceManager();
      console.log('[Main] initApp: getSkillServiceManager done');
      await skillServices.startAll();
      console.log('[Main] initApp: skill services started');
    } catch (error) {
      console.error('[Main] initApp: skill services failed:', error);
    }

    const appConfig = getStore().get<AppConfigSettings>('app_config');
    await applyProxyPreference(getUseSystemProxyFromConfig(appConfig));

    await startCoworkOpenAICompatProxy().catch(error => {
      console.error('Failed to start OpenAI compatibility proxy:', error);
    });

    // Re-sync OpenClaw config after proxy is ready so that providers that route
    // through the proxy (e.g. github-copilot) get the correct baseUrl.
    if (resolveCoworkAgentEngine() === 'openclaw') {
      const proxyResync = await syncOpenClawConfig({
        reason: 'proxy-ready',
      });
      if (proxyResync.changed) {
        console.log(
          '[Main] OpenClaw config updated after proxy ready, gateway will restart to pick up new config',
        );
      }
    }

    // 设置安全策略
    setContentSecurityPolicy();

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
    let lastUseSystemProxy = getUseSystemProxyFromConfig(
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
        ? getUseSystemProxyFromConfig(oldConfig)
        : lastUseSystemProxy;
      const currentUseSystemProxy = getUseSystemProxyFromConfig(newConfig);
      if (currentUseSystemProxy !== previousUseSystemProxy) {
        void applyProxyPreference(currentUseSystemProxy).then(() => {
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
