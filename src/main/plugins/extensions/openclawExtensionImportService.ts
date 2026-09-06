import { spawn } from 'child_process';
import extractZip from 'extract-zip';
import fs from 'fs';
import JSON5 from 'json5';
import os from 'os';
import path from 'path';
import * as tar from 'tar';

import type {
  ExtensionImportProgress,
  ExtensionImportResult,
  ExtensionImportStage,
  ExtensionSetEnabledResult,
  InstalledOpenClawExtension,
  OpenClawExtensionConfigurationField,
  OpenClawPluginCapabilityReview,
} from '../../../shared/openclaw/extensions';
import { t } from '../../core/i18n';
import {
  managedDirectoryFailure,
  managedDirectoryFailureFromMessage,
  ManagedDirectoryOperationCoordinator,
  managedDirectorySuccess,
} from '../../core/managedDirectoryOperations';
import type { OpenClawEngineManager } from '../../openclaw/runtime/openclawEngineManager';

const OPENCLAW_PLUGIN_MANIFEST = 'openclaw.plugin.json';
const AGENT_PLUGIN_MANIFEST_SCHEMA = 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json';
const SUPPORTED_ARCHIVE_EXTENSIONS = ['.zip', '.tar', '.tar.gz', '.tgz'];
const INSTALL_TIMEOUT_MS = 300_000;
const MAX_COMMAND_OUTPUT_CHARS = 64_000;
const OPENCLAW_UNINSTALL_SUCCESS_PATTERN = /(?:^|\r?\n)Uninstalled plugin\s+['"][^'"\r\n]+['"]/i;
const OPENCLAW_TOGGLE_SUCCESS_PATTERN =
  /(?:^|\r?\n)(?:Enabled|Disabled) plugin\s+['"][^'"\r\n]+['"]/i;
const isPathWithinDirectory = (rootDirectory: string, candidatePath: string): boolean => {
  const relativePath = path.relative(path.resolve(rootDirectory), path.resolve(candidatePath));
  return (
    relativePath === '' ||
    (!relativePath.startsWith(`..${path.sep}`) &&
      relativePath !== '..' &&
      !path.isAbsolute(relativePath))
  );
};

const createInstallSuccessPattern = (extensionId: string | undefined): RegExp | undefined =>
  extensionId
    ? new RegExp(
        `(?:^|\\r?\\n)Installed plugin:\\s*${extensionId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*(?:\\r?\\n|$)`,
        'i',
      )
    : undefined;

export type { ExtensionImportProgress, ExtensionImportResult, ExtensionImportStage };

export type { InstalledOpenClawExtension };

type CommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
};

type CommandOptions = {
  cwd: string;
  env: NodeJS.ProcessEnv;
  onOutput?: (output: string) => void;
  successPattern?: RegExp;
};

type OpenClawExtensionImportServiceDeps = {
  getOpenClawEngineManager: () => OpenClawEngineManager;
  getManagedPluginIds?: () => string[];
  requestGateway?: <T>(method: string, params?: unknown) => Promise<T>;
  runConfigMutationExclusive?: <T>(operation: () => Promise<T>) => Promise<T>;
  restartGatewayAfterMutation?: (reason: string) => Promise<{
    phase: string;
    message?: string;
  }>;
  directoryOperations?: ManagedDirectoryOperationCoordinator;
  runCommand?: (
    executable: string,
    args: string[],
    options: CommandOptions,
  ) => Promise<CommandResult>;
  inspectCapabilityReview?: (params: {
    cli: Awaited<ReturnType<OpenClawEngineManager['buildCliEnvironment']>>;
    pluginDirectory: string;
    sourcePath: string;
    extensionId?: string;
  }) => Promise<{ extensionId: string; review: OpenClawPluginCapabilityReview }>;
};

const CAPABILITY_REVIEW_OUTPUT_PREFIX = 'JUSTDO_PLUGIN_CAPABILITY_REVIEW=';
const CAPABILITY_REVIEW_SCRIPT = String.raw`
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const runtimeRoot = process.env.JUSTDO_PLUGIN_REVIEW_RUNTIME_ROOT;
const pluginDirectory = process.env.JUSTDO_PLUGIN_REVIEW_DIRECTORY;
const sourcePath = process.env.JUSTDO_PLUGIN_REVIEW_SOURCE;
const fallbackId = process.env.JUSTDO_PLUGIN_REVIEW_FALLBACK_ID;
const configSnapshotPath = process.env.JUSTDO_PLUGIN_REVIEW_CONFIG_PATH;
if (!runtimeRoot || !pluginDirectory || !sourcePath || !configSnapshotPath) throw new Error('Missing capability review input.');
const config = JSON.parse(fs.readFileSync(configSnapshotPath, 'utf8'));
const dist = path.join(runtimeRoot, 'dist');
const loadChunk = async (prefix, functionName) => {
  const files = fs.readdirSync(dist).filter(name => name.startsWith(prefix) && name.endsWith('.js'));
  if (files.length === 0) throw new Error('OpenClaw capability review module is missing: ' + prefix);
  for (const file of files) {
    const module = await import(pathToFileURL(path.join(dist, file)).href);
    const fn = Object.values(module).find(value => typeof value === 'function' && value.name === functionName);
    if (fn) return fn;
  }
  throw new Error('OpenClaw capability review export is missing: ' + functionName);
};
const inspect = await loadChunk('capability-artifact-', 'inspectPluginCapabilityArtifact');
const buildReview = await loadChunk('capability-summary-', 'buildPluginCapabilityConsentReview');
const inspected = inspect(pluginDirectory, process.env, { config });
const pluginId = inspected.manifest?.id || fallbackId;
if (!pluginId) throw new Error('OpenClaw capability review did not identify the plugin.');
const review = buildReview({
  pluginId,
  manifest: inspected.manifest,
  record: {
    source: 'path',
    installPath: pluginDirectory,
    spec: sourcePath,
  },
  config,
  declared: inspected.declared,
});
process.stdout.write('${CAPABILITY_REVIEW_OUTPUT_PREFIX}' + JSON.stringify(review));
`;

const isSupportedArchive = (filePath: string): boolean => {
  const lowerPath = filePath.toLowerCase();
  return SUPPORTED_ARCHIVE_EXTENSIONS.some(extension => lowerPath.endsWith(extension));
};

const resolveExtractedPluginDirectory = (extractDir: string): string => {
  if (fs.existsSync(path.join(extractDir, OPENCLAW_PLUGIN_MANIFEST))) {
    return extractDir;
  }

  const entries = fs
    .readdirSync(extractDir, { withFileTypes: true })
    .filter(entry => entry.name !== '__MACOSX' && entry.name !== '.DS_Store');
  if (entries.length === 1 && entries[0].isDirectory()) {
    return path.join(extractDir, entries[0].name);
  }
  return extractDir;
};

const assertNoSymbolicLinks = (directory: string): void => {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error('Extension archives cannot contain symbolic links.');
    }
    if (entry.isDirectory()) {
      assertNoSymbolicLinks(entryPath);
    }
  }
};

const readExtensionId = (pluginDir: string): string | undefined => {
  try {
    const content = fs.readFileSync(path.join(pluginDir, OPENCLAW_PLUGIN_MANIFEST), 'utf8');
    try {
      const manifest = JSON5.parse(content) as { id?: unknown };
      if (typeof manifest.id === 'string' && manifest.id.trim()) return manifest.id.trim();
    } catch {
      // Use a narrow fallback only for the result label. The OpenClaw installer remains
      // the authority for full manifest validation.
      const match = content.match(/(?:^|[,\s{])['"]?id['"]?\s*:\s*['"]([^'"]+)['"]/m);
      if (match?.[1]?.trim()) return match[1].trim();
    }
  } catch {
    // The caller reports the missing/invalid manifest through the installer.
  }
  return undefined;
};

const findSupportedPluginManifestPath = (pluginDir: string): string | undefined => {
  const manifestPath = [
    OPENCLAW_PLUGIN_MANIFEST,
    path.join('.codex-plugin', 'plugin.json'),
    path.join('.cursor-plugin', 'plugin.json'),
    path.join('.claude-plugin', 'plugin.json'),
  ]
    .map(candidate => path.join(pluginDir, candidate))
    .find(candidate => fs.existsSync(candidate));
  if (manifestPath) return manifestPath;

  const agentManifestPath = path.join(pluginDir, 'plugin.json');
  if (!fs.existsSync(agentManifestPath)) return undefined;
  try {
    const agentManifest = JSON.parse(fs.readFileSync(agentManifestPath, 'utf8')) as unknown;
    return isRecord(agentManifest) && agentManifest.$schema === AGENT_PLUGIN_MANIFEST_SCHEMA
      ? agentManifestPath
      : undefined;
  } catch {
    return undefined;
  }
};

const validateNativePluginDirectory = (pluginDir: string): string | undefined => {
  const manifestPath = findSupportedPluginManifestPath(pluginDir);
  if (!manifestPath) {
    const hasManifestlessBundleMarker = [
      'skills',
      'commands',
      'agents',
      path.join('hooks', 'hooks.json'),
      '.mcp.json',
      '.lsp.json',
      'settings.json',
    ].some(candidate => fs.existsSync(path.join(pluginDir, candidate)));
    if (hasManifestlessBundleMarker) {
      return (
        path
          .basename(pluginDir)
          .trim()
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/-+/g, '-')
          .replace(/^-+|-+$/g, '') || 'bundle-plugin'
      );
    }
    throw new Error(
      'The selected directory is not an OpenClaw plugin. Select a code plugin or a supported bundle plugin directory.',
    );
  }
  if (path.basename(manifestPath) === OPENCLAW_PLUGIN_MANIFEST) return readExtensionId(pluginDir);
  const manifest = readJsonRecord(manifestPath);
  const rawId =
    typeof manifest.name === 'string' && manifest.name.trim()
      ? manifest.name
      : path.basename(pluginDir);
  return (
    rawId
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-+|-+$/g, '') || 'bundle-plugin'
  );
};

const hasRuntimeDependencies = (pluginDir: string): boolean => {
  const packagePath = path.join(pluginDir, 'package.json');
  if (!fs.existsSync(packagePath)) return false;
  try {
    const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8')) as {
      dependencies?: unknown;
      optionalDependencies?: unknown;
    };
    return [packageJson.dependencies, packageJson.optionalDependencies].some(
      dependencies =>
        dependencies !== null &&
        typeof dependencies === 'object' &&
        !Array.isArray(dependencies) &&
        Object.keys(dependencies).length > 0,
    );
  } catch {
    return false;
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const isGatewayUnavailableError = (error: unknown): boolean => {
  if (!isRecord(error) && !(error instanceof Error)) return false;
  const code = 'code' in error && typeof error.code === 'string' ? error.code : '';
  if (['CLIENT_TIMEOUT', 'CLIENT_CLOSED', 'ECONNREFUSED', 'ECONNRESET'].includes(code)) return true;
  const message = error instanceof Error ? error.message : '';
  return /not connected|gateway(?: client)? is unavailable|runtime adapter is unavailable|gateway request timed out|gateway client connect timeout|gateway client stopped|gateway closed|openclaw engine is not running|failed to start (?:the )?(?:openclaw )?(?:engine|gateway)|ECONNREFUSED|ECONNRESET/i.test(
    message,
  );
};

const isDirectoryLockError = (error: unknown): boolean => {
  let current = error;
  const visited = new Set<unknown>();
  while ((current instanceof Error || isRecord(current)) && !visited.has(current)) {
    visited.add(current);
    const record = current as { code?: unknown; message?: unknown; cause?: unknown };
    const code = typeof record.code === 'string' ? record.code.toUpperCase() : '';
    if (code === 'EACCES' || code === 'EPERM' || code === 'EBUSY') return true;
    const message = typeof record.message === 'string' ? record.message : '';
    if (
      /failed to remove plugin directory .+; the plugin remains disabled and tracked so uninstall can be retried|\b(?:EACCES|EPERM|EBUSY)\b|resource busy|busy or locked|being used by another process|process cannot access|permission denied|access (?:is )?denied|operation not permitted/i.test(
        message,
      )
    ) {
      return true;
    }
    current = record.cause;
  }
  return false;
};

const readCapabilityConsentDetails = (
  error: unknown,
): { reviewToken: string; widened?: OpenClawPluginCapabilityReview['widened'] } | null => {
  if (!isRecord(error) || !isRecord(error.details)) return null;
  const details = error.details;
  if (
    details.capabilityConsentCode !== 'PLUGIN_CAPABILITY_CONSENT_REQUIRED' ||
    typeof details.reviewToken !== 'string' ||
    !details.reviewToken
  ) {
    return null;
  }
  return {
    reviewToken: details.reviewToken,
    ...(isRecord(details.widened)
      ? { widened: details.widened as OpenClawPluginCapabilityReview['widened'] }
      : {}),
  };
};

const readJsonRecord = (filePath: string): Record<string, unknown> => {
  try {
    const value = JSON5.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
    return isRecord(value) ? value : {};
  } catch {
    return {};
  }
};

const findInstalledExtensionPath = (
  extensionsRoot: string,
  extensionId: string,
): string | undefined => {
  if (!fs.existsSync(extensionsRoot)) return undefined;
  for (const entry of fs.readdirSync(extensionsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const installPath = path.join(extensionsRoot, entry.name);
    try {
      const installedId = validateNativePluginDirectory(installPath);
      if (installedId === extensionId && isPathWithinDirectory(extensionsRoot, installPath)) {
        return installPath;
      }
    } catch {
      // Ignore unrelated directories in the OpenClaw extensions root.
    }
  }
  return undefined;
};

const getNestedValue = (value: unknown, dottedPath: string): unknown =>
  dottedPath.split('.').reduce<unknown>((current, segment) => {
    return isRecord(current) ? current[segment] : undefined;
  }, value);

const FORBIDDEN_CONFIG_PATH_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor']);
const isSafeConfigPath = (dottedPath: string): boolean => {
  if (!dottedPath || dottedPath.length > 256) return false;
  const segments = dottedPath.split('.');
  return segments.every(
    segment =>
      /^[A-Za-z_][A-Za-z0-9_-]*$/.test(segment) && !FORBIDDEN_CONFIG_PATH_SEGMENTS.has(segment),
  );
};

const setNestedValue = (
  target: Record<string, unknown>,
  dottedPath: string,
  value: string,
): void => {
  if (!isSafeConfigPath(dottedPath)) throw new Error('Unsupported extension configuration path.');
  const segments = dottedPath.split('.');
  let current = target;
  segments.forEach((segment, index) => {
    if (index === segments.length - 1) {
      current[segment] = value;
      return;
    }
    const next = isRecord(current[segment]) ? current[segment] : {};
    current[segment] = next;
    current = next;
  });
};

const hasConfiguredValue = (value: unknown): boolean => {
  if (typeof value === 'string') return value.trim().length > 0;
  return isRecord(value) && Object.keys(value).length > 0;
};

const readDotEnvKeys = (filePath: string): Set<string> => {
  const keys = new Set<string>();
  try {
    for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
      const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      const value = match?.[2]?.trim();
      if (match && value && value !== "''" && value !== '""') keys.add(match[1]);
    }
  } catch {
    // Missing .env files are expected.
  }
  return keys;
};

const collectRequiredEnvVars = (manifest: Record<string, unknown>): string[] => {
  const requiredEnvVars = new Set<string>();
  const addEnvVars = (envVars: unknown): void => {
    if (!Array.isArray(envVars)) return;
    for (const envVar of envVars) {
      if (typeof envVar === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(envVar)) {
        requiredEnvVars.add(envVar);
      }
    }
  };
  const setup = isRecord(manifest.setup) ? manifest.setup : {};
  const providers = Array.isArray(setup.providers) ? setup.providers : [];
  providers.forEach(provider => {
    if (isRecord(provider)) addEnvVars(provider.envVars);
  });
  const legacyProviderEnvVars = isRecord(manifest.providerAuthEnvVars)
    ? manifest.providerAuthEnvVars
    : {};
  Object.values(legacyProviderEnvVars).forEach(addEnvVars);
  return [...requiredEnvVars];
};

type ExtensionConfigurationState = {
  fields: OpenClawExtensionConfigurationField[];
  missingRequirements: string[];
};

const getExtensionConfigurationState = (
  manager: OpenClawEngineManager,
  extensionId: string,
  manifest: Record<string, unknown>,
): ExtensionConfigurationState => {
  const requiredEnvVars = collectRequiredEnvVars(manifest);
  const config = readJsonRecord(manager.getConfigPath());
  const pluginsConfig = isRecord(config.plugins) ? config.plugins : {};
  const pluginEntries = isRecord(pluginsConfig.entries) ? pluginsConfig.entries : {};
  const pluginEntry = isRecord(pluginEntries[extensionId]) ? pluginEntries[extensionId] : {};
  const pluginConfig = pluginEntry.config;
  const configuredEnv = isRecord(config.env) ? config.env : {};
  const dotenvKeys = new Set<string>();
  for (const envPath of [
    path.join(manager.getBaseDir(), '.env'),
    path.join(manager.getStateDir(), '.env'),
  ]) {
    for (const key of readDotEnvKeys(envPath)) dotenvKeys.add(key);
  }
  const isEnvConfigured = (name: string): boolean =>
    hasConfiguredValue(process.env[name]) ||
    hasConfiguredValue(configuredEnv[name]) ||
    dotenvKeys.has(name);
  const hasResolvedConfiguredValue = (value: unknown): boolean => {
    if (typeof value === 'string') {
      const envReference = value.trim().match(/^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/)?.[1];
      return envReference ? isEnvConfigured(envReference) : hasConfiguredValue(value);
    }
    return hasConfiguredValue(value);
  };
  const uiHints = isRecord(manifest.uiHints) ? manifest.uiHints : {};
  const sensitiveHints = Object.entries(uiHints).filter(
    (entry): entry is [string, Record<string, unknown>] =>
      isSafeConfigPath(entry[0]) && isRecord(entry[1]) && entry[1].sensitive === true,
  );
  const resolveRequirement = (configPath: string): string | undefined => {
    const leafName = configPath.split('.').at(-1) || '';
    const normalizedLeaf = leafName.replace(/([a-z])([A-Z])/g, '$1_$2').toUpperCase();
    const matches = requiredEnvVars.filter(envVar => envVar.endsWith(normalizedLeaf));
    if (matches.length === 1) return matches[0];
    return requiredEnvVars.length === 1 && sensitiveHints.length === 1
      ? requiredEnvVars[0]
      : undefined;
  };
  const fields = sensitiveHints.map<OpenClawExtensionConfigurationField>(([configPath, hint]) => {
    const requirement = resolveRequirement(configPath);
    return {
      path: configPath,
      label: typeof hint.label === 'string' && hint.label.trim() ? hint.label.trim() : configPath,
      help: typeof hint.help === 'string' && hint.help.trim() ? hint.help.trim() : undefined,
      requirement,
      sensitive: true,
      configured:
        hasResolvedConfiguredValue(getNestedValue(pluginConfig, configPath)) ||
        Boolean(requirement && isEnvConfigured(requirement)),
    };
  });
  const configContracts = isRecord(manifest.configContracts) ? manifest.configContracts : {};
  const compatibilityPaths = Array.isArray(configContracts.compatibilityRuntimePaths)
    ? configContracts.compatibilityRuntimePaths
    : [];
  const hasCompatibilityConfig = compatibilityPaths.some(
    configPath =>
      typeof configPath === 'string' &&
      hasResolvedConfiguredValue(getNestedValue(config, configPath)),
  );
  const missingRequirements = requiredEnvVars.filter(requirement => {
    if (isEnvConfigured(requirement) || hasCompatibilityConfig) return false;
    return !fields.some(field => field.requirement === requirement && field.configured);
  });
  return { fields, missingRequirements };
};

const isExtensionEnabled = (manager: OpenClawEngineManager, extensionId: string): boolean => {
  const config = readJsonRecord(manager.getConfigPath());
  const pluginsConfig = isRecord(config.plugins) ? config.plugins : {};
  const pluginEntries = isRecord(pluginsConfig.entries) ? pluginsConfig.entries : {};
  const pluginEntry = isRecord(pluginEntries[extensionId]) ? pluginEntries[extensionId] : {};
  const allow = Array.isArray(pluginsConfig.allow)
    ? pluginsConfig.allow.filter((id): id is string => typeof id === 'string')
    : [];
  const deny = Array.isArray(pluginsConfig.deny)
    ? pluginsConfig.deny.filter((id): id is string => typeof id === 'string')
    : [];
  return (
    pluginsConfig.enabled !== false &&
    pluginEntry.enabled !== false &&
    !deny.includes(extensionId) &&
    (allow.length === 0 || allow.includes(extensionId))
  );
};

const updateExtensionAllowlist = (
  configPath: string,
  extensionId: string,
  operation: 'add' | 'remove',
  managedPluginIds: string[] = [],
  disableBeforeEnable = false,
): void => {
  let config: Record<string, unknown> = {};
  if (fs.existsSync(configPath)) {
    const parsed = JSON5.parse(fs.readFileSync(configPath, 'utf8')) as unknown;
    if (!isRecord(parsed)) throw new Error('OpenClaw configuration is not an object.');
    config = parsed;
  }

  const plugins = isRecord(config.plugins) ? config.plugins : {};
  const existingAllow = Array.isArray(plugins.allow)
    ? plugins.allow.filter((id): id is string => typeof id === 'string')
    : [];
  const managedIds = operation === 'add' && existingAllow.length === 0 ? managedPluginIds : [];
  const allow =
    operation === 'add'
      ? [...new Set([...existingAllow, ...managedIds, extensionId])]
      : existingAllow.filter(id => id !== extensionId);
  const entries = isRecord(plugins.entries) ? plugins.entries : {};
  const extensionEntry = isRecord(entries[extensionId]) ? entries[extensionId] : {};
  const shouldDisableEntry = disableBeforeEnable && extensionEntry.enabled !== false;
  if (
    !shouldDisableEntry &&
    allow.length === existingAllow.length &&
    allow.every((id, index) => id === existingAllow[index])
  ) {
    return;
  }

  plugins.allow = allow;
  if (shouldDisableEntry) {
    entries[extensionId] = { ...extensionEntry, enabled: false };
    plugins.entries = entries;
  }
  config.plugins = plugins;

  const temporaryPath = `${configPath}.tmp-extension-allowlist-${process.pid}-${Date.now()}`;
  try {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
    fs.renameSync(temporaryPath, configPath);
  } finally {
    try {
      if (fs.existsSync(temporaryPath)) fs.rmSync(temporaryPath, { force: true });
    } catch {
      // Best-effort cleanup for an interrupted atomic write.
    }
  }
};

const runCommand = (
  executable: string,
  args: string[],
  options: CommandOptions,
): Promise<CommandResult> =>
  new Promise((resolve, reject) => {
    const { onOutput, successPattern, ...spawnOptions } = options;
    const child = spawn(executable, args, {
      ...spawnOptions,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let successObserved = false;
    let successTerminationTimer: NodeJS.Timeout | undefined;
    let forcedFinishTimer: NodeJS.Timeout | undefined;
    const finish = (result: CommandResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (successTerminationTimer) clearTimeout(successTerminationTimer);
      if (forcedFinishTimer) clearTimeout(forcedFinishTimer);
      resolve(result);
    };
    const terminateSuccessfulCommand = () => {
      if (successObserved) return;
      successObserved = true;
      // OpenClaw can leave shared-state handles active after reporting a successful
      // install. Give it a moment to flush trailing output, then stop the CLI tree.
      successTerminationTimer = setTimeout(() => {
        if (settled || !child.pid) {
          finish({ exitCode: 0, stdout, stderr });
          return;
        }
        forcedFinishTimer = setTimeout(() => {
          if (settled) return;
          if (process.platform !== 'win32') child.kill('SIGKILL');
          finish({ exitCode: 0, stdout, stderr });
        }, 2_000);
        if (process.platform === 'win32') {
          const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
            stdio: 'ignore',
            windowsHide: true,
          });
          killer.once('error', () => finish({ exitCode: 0, stdout, stderr }));
          killer.once('exit', () => finish({ exitCode: 0, stdout, stderr }));
        } else {
          child.kill('SIGTERM');
        }
      }, 250);
    };
    const inspectSuccessfulOutput = () => {
      if (successPattern?.test(`${stdout}\n${stderr}`)) terminateSuccessfulCommand();
    };
    child.stdout?.on('data', chunk => {
      const output = String(chunk);
      stdout = `${stdout}${output}`.slice(-MAX_COMMAND_OUTPUT_CHARS);
      onOutput?.(output);
      inspectSuccessfulOutput();
    });
    child.stderr?.on('data', chunk => {
      const output = String(chunk);
      stderr = `${stderr}${output}`.slice(-MAX_COMMAND_OUTPUT_CHARS);
      onOutput?.(output);
      inspectSuccessfulOutput();
    });
    child.once('error', error => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(error);
    });
    // Use `exit`, not `close`: npm descendants may inherit the CLI's output pipes and
    // keep `close` pending forever after the OpenClaw process has already exited.
    child.once('exit', code => {
      setTimeout(() => finish({ exitCode: successObserved ? 0 : (code ?? 1), stdout, stderr }), 50);
    });
    const timeout = setTimeout(() => {
      if (child.pid) {
        if (process.platform === 'win32') {
          spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
            stdio: 'ignore',
            windowsHide: true,
          });
        } else {
          child.kill('SIGKILL');
        }
      }
      finish({ exitCode: 124, stdout, stderr, timedOut: true });
    }, INSTALL_TIMEOUT_MS);
  });

const formatCommandError = (result: CommandResult): string => {
  if (result.timedOut) {
    return 'The OpenClaw extension command did not finish within 5 minutes. Check the last reported stage and logs, then try again.';
  }
  const output = (result.stderr || result.stdout)
    .replace(/\u001b\[[0-9;]*m/g, '')
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1***:***@')
    .replace(/(_authToken\s*[=:]\s*)[^\s]+/gi, '$1***')
    .trim();
  const packagingError = output.match(
    /package install requires compiled runtime output[\s\S]*?(?=\s*Also not a valid hook pack:|$)/i,
  )?.[0];
  if (packagingError) return packagingError.trim().slice(-1200);
  return output
    ? output.slice(-1200)
    : `OpenClaw extension command exited with code ${result.exitCode}`;
};

const inferInstallerFailureStage = (
  result: CommandResult,
  currentStage: ExtensionImportStage,
): ExtensionImportStage => {
  const output = `${result.stderr}\n${result.stdout}`;
  if (
    /compiled runtime output|TypeScript entry|plugin packaging issue|invalid plugin manifest|openclaw\.plugin\.json/i.test(
      output,
    )
  ) {
    return 'validating';
  }
  if (/npm (?:error|ERR!)|E404|ETARGET|ERESOLVE|node_modules/i.test(output)) {
    return 'installing_dependencies';
  }
  return currentStage;
};

export class OpenClawExtensionImportService {
  private readonly runCommand: NonNullable<OpenClawExtensionImportServiceDeps['runCommand']>;
  private readonly directoryOperations: ManagedDirectoryOperationCoordinator;
  private mutationTail: Promise<void> = Promise.resolve();

  constructor(private readonly deps: OpenClawExtensionImportServiceDeps) {
    this.runCommand = deps.runCommand ?? runCommand;
    this.directoryOperations =
      deps.directoryOperations ?? new ManagedDirectoryOperationCoordinator();
  }

  private runMutationExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const run = (): Promise<T> =>
      this.deps.runConfigMutationExclusive
        ? this.deps.runConfigMutationExclusive(operation)
        : operation();
    const result = this.mutationTail.then(run, run);
    this.mutationTail = result.then(
      (): void => undefined,
      (): void => undefined,
    );
    return result;
  }

  private restartGatewayAfterMutation(reason: string): Promise<{
    phase: string;
    message?: string;
  }> {
    if (!this.deps.restartGatewayAfterMutation) {
      throw new Error('The safe Gateway restart coordinator is unavailable.');
    }
    return this.deps.restartGatewayAfterMutation(reason);
  }

  private async inspectCapabilityReview(params: {
    cli: Awaited<ReturnType<OpenClawEngineManager['buildCliEnvironment']>>;
    pluginDirectory: string;
    sourcePath: string;
    extensionId?: string;
  }): Promise<{ extensionId: string; review: OpenClawPluginCapabilityReview }> {
    if (this.deps.inspectCapabilityReview) return this.deps.inspectCapabilityReview(params);

    const manager = this.deps.getOpenClawEngineManager();
    const configPath = manager.getConfigPath();
    const config = fs.existsSync(configPath)
      ? JSON5.parse(fs.readFileSync(configPath, 'utf8'))
      : {};
    const snapshotDirectory = fs.mkdtempSync(
      path.join(os.tmpdir(), 'justdo-extension-capability-review-'),
    );
    const configSnapshotPath = path.join(snapshotDirectory, 'openclaw-config.json');
    try {
      fs.writeFileSync(configSnapshotPath, JSON.stringify(config), {
        encoding: 'utf8',
        mode: 0o600,
      });
      const result = await this.runCommand(
        process.execPath,
        ['--input-type=module', '--eval', CAPABILITY_REVIEW_SCRIPT],
        {
          cwd: params.cli.runtimeRoot,
          env: {
            ...params.cli.env,
            ELECTRON_RUN_AS_NODE: '1',
            JUSTDO_PLUGIN_REVIEW_RUNTIME_ROOT: params.cli.runtimeRoot,
            JUSTDO_PLUGIN_REVIEW_DIRECTORY: params.pluginDirectory,
            JUSTDO_PLUGIN_REVIEW_SOURCE: params.sourcePath,
            JUSTDO_PLUGIN_REVIEW_FALLBACK_ID: params.extensionId ?? '',
            JUSTDO_PLUGIN_REVIEW_CONFIG_PATH: configSnapshotPath,
          },
        },
      );
      if (result.exitCode !== 0) {
        throw new Error(
          `OpenClaw could not inspect the extension capabilities: ${formatCommandError(result)}`,
        );
      }
      const marker = result.stdout.lastIndexOf(CAPABILITY_REVIEW_OUTPUT_PREFIX);
      if (marker < 0) throw new Error('OpenClaw returned an invalid extension capability review.');
      const raw = JSON.parse(
        result.stdout.slice(marker + CAPABILITY_REVIEW_OUTPUT_PREFIX.length),
      ) as unknown;
      if (!isRecord(raw) || typeof raw.pluginId !== 'string' || !isRecord(raw.declared)) {
        throw new Error('OpenClaw returned an invalid extension capability review.');
      }
      if (typeof raw.reviewToken !== 'string' || !raw.reviewToken || !isRecord(raw.grants)) {
        throw new Error('OpenClaw returned an incomplete extension capability review.');
      }
      return {
        extensionId: raw.pluginId,
        review: raw as unknown as OpenClawPluginCapabilityReview,
      };
    } finally {
      fs.rmSync(snapshotDirectory, {
        recursive: true,
        force: true,
        maxRetries: process.platform === 'win32' ? 3 : 0,
        retryDelay: process.platform === 'win32' ? 100 : 0,
      });
    }
  }

  private async runDirectoryCommand(
    targetPath: string,
    command: () => Promise<CommandResult>,
  ): Promise<{ result: CommandResult; runtimeRestarted: boolean; error?: string }> {
    let lastResult: CommandResult | null = null;
    const operation = await this.directoryOperations.execute({
      resourceName: t('extensionDirectoryResource'),
      targetPath,
      manageRuntimeOnLock: true,
      // OpenClaw's CLI owns the internal directory mutation. Detect external
      // owners before invoking it so a failed recursive uninstall/update cannot
      // leave the live extension directory only partially modified.
      preflightLockCheck: true,
      operation: async () => {
        lastResult = await command();
        if (lastResult.exitCode === 0) return managedDirectorySuccess(lastResult);
        return managedDirectoryFailure(
          managedDirectoryFailureFromMessage(formatCommandError(lastResult), targetPath),
        );
      },
    });
    if (!('failure' in operation)) {
      return { result: operation.value, runtimeRestarted: operation.runtimeRestarted };
    }
    return {
      result:
        lastResult ??
        ({ exitCode: 1, stdout: '', stderr: operation.failure.message } satisfies CommandResult),
      runtimeRestarted: operation.runtimeRestarted,
      error: operation.failure.message,
    };
  }

  listInstalled(): InstalledOpenClawExtension[] {
    const manager = this.deps.getOpenClawEngineManager();
    const extensionsDir = path.join(manager.getStateDir(), 'extensions');
    if (!fs.existsSync(extensionsDir)) return [];

    return fs
      .readdirSync(extensionsDir, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
      .flatMap(entry => {
        const installPath = path.join(extensionsDir, entry.name);
        try {
          const id = validateNativePluginDirectory(installPath);
          if (!id) return [];
          const manifestPath = findSupportedPluginManifestPath(installPath);
          const manifest = manifestPath ? readJsonRecord(manifestPath) : {};
          const packagePath = path.join(installPath, 'package.json');
          const packageJson = fs.existsSync(packagePath) ? readJsonRecord(packagePath) : undefined;
          const configurationState = getExtensionConfigurationState(manager, id, manifest);
          return [
            {
              id,
              name:
                typeof manifest.name === 'string' && manifest.name.trim()
                  ? manifest.name.trim()
                  : id,
              description:
                typeof manifest.description === 'string' ? manifest.description.trim() : '',
              version:
                typeof manifest.version === 'string'
                  ? manifest.version
                  : typeof packageJson?.version === 'string'
                    ? packageJson.version
                    : undefined,
              installPath,
              enabled: isExtensionEnabled(manager, id),
              missingRequirements: configurationState.missingRequirements,
              configurationFields: configurationState.fields,
            },
          ];
        } catch (error) {
          console.warn(
            `[OpenClawExtensionImportService] Failed to read installed extension ${entry.name}:`,
            error instanceof Error ? error.message : String(error),
          );
          return [];
        }
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async listCatalog(): Promise<InstalledOpenClawExtension[]> {
    if (!this.deps.requestGateway) return this.listInstalled();

    type PluginCatalogEntry = {
      id: string;
      name: string;
      description?: string;
      version?: string;
      kind?: string[];
      origin?: string;
      installed: boolean;
      enabled: boolean;
      state: 'enabled' | 'disabled' | 'not-installed' | 'error';
      error?: string;
      category?: string;
      removable?: boolean;
    };
    let result: {
      plugins: PluginCatalogEntry[];
      diagnostics: unknown[];
      mutationAllowed: boolean;
    };
    try {
      result = await this.deps.requestGateway('plugins.list', {});
    } catch (error) {
      if (!isGatewayUnavailableError(error)) throw error;
      return this.listInstalled().map(extension => ({
        ...extension,
        origin: extension.origin ?? 'local-recovery',
        removable: !this.deps.getManagedPluginIds?.().includes(extension.id),
        canToggle: !this.deps.getManagedPluginIds?.().includes(extension.id),
      }));
    }
    const localExtensions = this.listInstalled();
    if (
      localExtensions.some(extension => {
        const gatewayEntry = result.plugins.find(plugin => plugin.id === extension.id);
        return (
          !gatewayEntry?.installed ||
          (extension.version !== undefined &&
            gatewayEntry.version !== undefined &&
            extension.version !== gatewayEntry.version)
        );
      })
    ) {
      try {
        await this.deps.requestGateway('plugins.refresh', {});
        result = await this.deps.requestGateway('plugins.list', {});
      } catch (error) {
        console.warn(
          '[OpenClawExtensionImportService] Failed to refresh externally changed plugin inventory:',
          error instanceof Error ? error.message : String(error),
        );
      }
    }
    const localById = new Map(localExtensions.map(extension => [extension.id, extension]));
    const managedIds = new Set(this.deps.getManagedPluginIds?.() ?? []);

    return result.plugins
      .filter(plugin => plugin.installed)
      .map(plugin => {
        const local = localById.get(plugin.id);
        const managed = managedIds.has(plugin.id);
        return {
          id: plugin.id,
          name: plugin.name || plugin.id,
          description: plugin.description ?? local?.description ?? '',
          version: plugin.version ?? local?.version,
          installPath: local?.installPath,
          enabled: plugin.enabled,
          state: plugin.state === 'not-installed' ? 'disabled' : plugin.state,
          origin: plugin.origin,
          category: plugin.category,
          kinds: plugin.kind ? [...plugin.kind] : undefined,
          error: plugin.error,
          removable: result.mutationAllowed && plugin.removable === true && !managed,
          canToggle: result.mutationAllowed && !managed,
          managed,
          missingRequirements: local?.missingRequirements ?? [],
          configurationFields: local?.configurationFields ?? [],
        } satisfies InstalledOpenClawExtension;
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async updateConfiguration(
    extensionId: string,
    values: Record<string, string>,
  ): Promise<{ success: boolean; error?: string }> {
    return this.runMutationExclusive(() => this.updateConfigurationExclusive(extensionId, values));
  }

  private async updateConfigurationExclusive(
    extensionId: string,
    values: Record<string, string>,
  ): Promise<{ success: boolean; error?: string }> {
    if (this.deps.getManagedPluginIds?.().includes(extensionId)) {
      return { success: false, error: 'Managed extensions cannot be reconfigured here.' };
    }
    const installed = this.listInstalled().find(extension => extension.id === extensionId);
    if (!installed) return { success: false, error: 'Extension is not installed.' };

    const allowedPaths = new Set(installed.configurationFields.map(field => field.path));
    const updates = Object.entries(values).filter(
      ([configPath, value]) =>
        value.trim().length > 0 && isSafeConfigPath(configPath) && allowedPaths.has(configPath),
    );
    if (updates.length === 0) {
      return { success: false, error: 'Enter at least one supported configuration value.' };
    }

    const manager = this.deps.getOpenClawEngineManager();
    const configPath = manager.getConfigPath();
    const temporaryPath = `${configPath}.tmp-extension-${Date.now()}`;
    const initialPhase = manager.getStatus().phase;
    const wasRuntimeActive = initialPhase === 'running' || initialPhase === 'starting';
    try {
      let config: Record<string, unknown> = {};
      if (fs.existsSync(configPath)) {
        const parsed = JSON5.parse(fs.readFileSync(configPath, 'utf8')) as unknown;
        if (!isRecord(parsed)) throw new Error('OpenClaw configuration is not an object.');
        config = parsed;
      }
      const plugins = isRecord(config.plugins) ? config.plugins : {};
      const entries = isRecord(plugins.entries) ? plugins.entries : {};
      const entry = isRecord(entries[extensionId]) ? entries[extensionId] : {};
      const pluginConfig = isRecord(entry.config) ? entry.config : {};
      updates.forEach(([fieldPath, value]) => setNestedValue(pluginConfig, fieldPath, value));
      entry.config = pluginConfig;
      entries[extensionId] = entry;
      plugins.entries = entries;
      config.plugins = plugins;

      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      fs.writeFileSync(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
      fs.renameSync(temporaryPath, configPath);

      if (wasRuntimeActive) {
        const status = await this.restartGatewayAfterMutation('extension-config-change');
        if (status.phase !== 'running') {
          return {
            success: false,
            error:
              status.message ||
              'Extension configuration was saved, but the OpenClaw Gateway failed to restart.',
          };
        }
      }
      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to update extension configuration',
      };
    } finally {
      try {
        if (fs.existsSync(temporaryPath)) fs.rmSync(temporaryPath, { force: true });
      } catch {
        // Best-effort cleanup for an interrupted atomic write.
      }
    }
  }

  async delete(
    extensionId: string,
  ): Promise<{ success: boolean; error?: string; warnings?: string[] }> {
    return this.runMutationExclusive(() => this.deleteExclusive(extensionId));
  }

  private async deleteExclusive(
    extensionId: string,
  ): Promise<{ success: boolean; error?: string; warnings?: string[] }> {
    if (this.deps.getManagedPluginIds?.().includes(extensionId)) {
      return { success: false, error: 'Managed extensions cannot be deleted.' };
    }
    const manager = this.deps.getOpenClawEngineManager();
    const initialPhase = manager.getStatus().phase;
    const wasRuntimeActive = initialPhase === 'running' || initialPhase === 'starting';
    // Capture the verified local path before the Gateway mutates anything. A failed
    // recursive removal can delete the manifest before reporting a Windows lock,
    // making a post-failure inventory scan unable to locate the retry target.
    const installedBeforeGateway = this.listInstalled().find(
      extension => extension.id === extensionId,
    );
    let gatewayMutationError: unknown;
    if (this.deps.requestGateway) {
      try {
        const result = await this.deps.requestGateway<{
          ok: true;
          restartRequired: true;
          warnings?: string[];
        }>('plugins.uninstall', { pluginId: extensionId });
        if (result.restartRequired) {
          const status = await this.restartGatewayAfterMutation('extension-delete');
          if (status.phase !== 'running') {
            return {
              success: false,
              error:
                status.message || 'Plugin removed, but the OpenClaw Gateway failed to restart.',
            };
          }
        }
        return { success: true, warnings: result.warnings };
      } catch (error) {
        gatewayMutationError = error;
        if (isDirectoryLockError(error)) {
          let gatewayReportsInstalled: boolean | undefined;
          try {
            const catalog = await this.deps.requestGateway<{
              plugins: Array<{ id: string; installed: boolean }>;
            }>('plugins.list', {});
            gatewayReportsInstalled = catalog.plugins.some(
              plugin => plugin.id === extensionId && plugin.installed,
            );
          } catch {
            // Inventory confirmation is best effort. The pre-mutation path below
            // remains the safe target for a lock-aware cold retry.
          }
          if (
            gatewayReportsInstalled === false &&
            (!installedBeforeGateway || !fs.existsSync(installedBeforeGateway.installPath))
          ) {
            try {
              // The uninstall committed and only its response was lost. Do not
              // repeat the destructive mutation; only converge the live runtime.
              const status = await this.restartGatewayAfterMutation('extension-delete');
              if (status.phase !== 'running') {
                return {
                  success: false,
                  error:
                    status.message || 'Plugin removed, but the OpenClaw Gateway failed to restart.',
                };
              }
              return { success: true };
            } catch (restartError) {
              return {
                success: false,
                error:
                  restartError instanceof Error
                    ? restartError.message
                    : 'Plugin removed, but the OpenClaw Gateway failed to restart.',
              };
            }
          }
        } else if (isGatewayUnavailableError(error)) {
          // A broken plugin can prevent the Gateway from starting. Continue to
          // the cold CLI path so the plugin page remains a recovery surface.
        } else {
          return {
            success: false,
            error: error instanceof Error ? error.message : 'Failed to delete plugin',
          };
        }
      }
    }
    const installed =
      installedBeforeGateway ??
      this.listInstalled().find(extension => extension.id === extensionId);
    if (!installed) {
      return {
        success: false,
        error:
          gatewayMutationError instanceof Error
            ? gatewayMutationError.message
            : 'Extension is not installed.',
      };
    }

    try {
      const cli = await manager.buildCliEnvironment();
      let allowlistError = '';
      const command = await this.runDirectoryCommand(installed.installPath, async () => {
        const result = await this.runCommand(
          process.execPath,
          [cli.openclawEntry, 'plugins', 'uninstall', extensionId, '--force'],
          {
            cwd: cli.runtimeRoot,
            env: {
              ...cli.env,
              OPENCLAW_HOME: manager.getBaseDir(),
              ELECTRON_RUN_AS_NODE: '1',
            },
            successPattern: OPENCLAW_UNINSTALL_SUCCESS_PATTERN,
          },
        );
        if (
          result.exitCode === 0 &&
          !this.listInstalled().some(extension => extension.id === extensionId)
        ) {
          try {
            updateExtensionAllowlist(manager.getConfigPath(), extensionId, 'remove');
          } catch (error) {
            allowlistError = error instanceof Error ? error.message : String(error);
          }
        }
        return result;
      });
      const result = command.result;
      if (result.exitCode !== 0) {
        const error = command.error ?? formatCommandError(result);
        console.error('[OpenClawExtensionImportService] OpenClaw uninstaller failed:', error);
        return { success: false, error };
      }

      if (this.listInstalled().some(extension => extension.id === extensionId)) {
        return {
          success: false,
          error: 'OpenClaw reported success, but the extension is still installed.',
        };
      }

      if (wasRuntimeActive && !command.runtimeRestarted) {
        const status = await this.restartGatewayAfterMutation('extension-delete');
        if (status.phase !== 'running') {
          return {
            success: false,
            error:
              status.message || 'Extension removed, but the OpenClaw Gateway failed to restart.',
          };
        }
      }
      if (allowlistError) {
        return {
          success: false,
          error: `Extension removed, but its allowlist entry could not be cleaned up: ${allowlistError}`,
        };
      }
      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to delete extension',
      };
    }
  }

  async setEnabled(
    extensionId: string,
    enabled: boolean,
    reviewToken?: string,
  ): Promise<ExtensionSetEnabledResult> {
    return this.runMutationExclusive(() =>
      this.setEnabledExclusive(extensionId, enabled, reviewToken),
    );
  }

  private async setEnabledExclusive(
    extensionId: string,
    enabled: boolean,
    reviewToken?: string,
  ): Promise<ExtensionSetEnabledResult> {
    if (!enabled && this.deps.getManagedPluginIds?.().includes(extensionId)) {
      return { success: false, error: 'Managed extensions cannot be disabled.' };
    }
    if (this.deps.requestGateway) {
      try {
        const result = await this.deps.requestGateway<{
          ok: true;
          restartRequired: boolean;
          warnings?: string[];
        }>('plugins.setEnabled', {
          pluginId: extensionId,
          enabled,
          ...(reviewToken ? { acknowledgeCapabilities: { reviewToken } } : {}),
        });
        if (result.restartRequired) {
          const status = await this.restartGatewayAfterMutation('extension-status-change');
          if (status.phase !== 'running') {
            return {
              success: false,
              error:
                status.message ||
                'Plugin status changed, but the OpenClaw Gateway failed to restart.',
            };
          }
        }
        return { success: true, warnings: result.warnings };
      } catch (error) {
        if (isGatewayUnavailableError(error)) {
          // Fall through to the cold CLI path for offline recovery only.
        } else {
          const consent = enabled ? readCapabilityConsentDetails(error) : null;
          if (consent) {
            try {
              const inspected = await this.deps.requestGateway<{
                ok: true;
                reviewToken: string;
                declared: OpenClawPluginCapabilityReview['declared'];
                source?: OpenClawPluginCapabilityReview['source'];
                grants: OpenClawPluginCapabilityReview['grants'];
                trust?: OpenClawPluginCapabilityReview['trust'];
              }>('plugins.inspect', { pluginId: extensionId });
              return {
                success: false,
                error: error instanceof Error ? error.message : 'Capability consent is required',
                capabilityReview: {
                  reviewToken: inspected.reviewToken,
                  declared: inspected.declared,
                  widened: consent.widened,
                  source: inspected.source,
                  grants: inspected.grants,
                  trust: inspected.trust,
                },
              };
            } catch {
              // Preserve the original authoritative mutation error below.
            }
          }
          return {
            success: false,
            error: error instanceof Error ? error.message : 'Failed to update plugin status',
          };
        }
      }
    }
    const installed = this.listInstalled().find(extension => extension.id === extensionId);
    if (!installed) return { success: false, error: 'Extension is not installed.' };
    if (installed.enabled === enabled) return { success: true };

    const manager = this.deps.getOpenClawEngineManager();
    const initialPhase = manager.getStatus().phase;
    const wasRuntimeActive = initialPhase === 'running' || initialPhase === 'starting';
    try {
      const cli = await manager.buildCliEnvironment();
      if (enabled) {
        updateExtensionAllowlist(
          manager.getConfigPath(),
          extensionId,
          'add',
          this.deps.getManagedPluginIds?.() ?? [],
          true,
        );
      }
      const result = await this.runCommand(
        process.execPath,
        [cli.openclawEntry, 'plugins', enabled ? 'enable' : 'disable', extensionId],
        {
          cwd: cli.runtimeRoot,
          env: {
            ...cli.env,
            OPENCLAW_HOME: manager.getBaseDir(),
            ELECTRON_RUN_AS_NODE: '1',
          },
          successPattern: OPENCLAW_TOGGLE_SUCCESS_PATTERN,
        },
      );
      if (result.exitCode !== 0) {
        const error = formatCommandError(result);
        console.error('[OpenClawExtensionImportService] Plugin status update failed:', error);
        return { success: false, error };
      }

      const updated = this.listInstalled().find(extension => extension.id === extensionId);
      if (!updated || updated.enabled !== enabled) {
        return {
          success: false,
          error: `OpenClaw did not ${enabled ? 'enable' : 'disable'} the extension. Check the global plugin policy, allowlist, and denylist.`,
        };
      }

      if (wasRuntimeActive) {
        const status = await this.restartGatewayAfterMutation('extension-status-change');
        if (status.phase !== 'running') {
          return {
            success: false,
            error:
              status.message ||
              'Extension status changed, but the OpenClaw Gateway failed to restart.',
          };
        }
      }
      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to update extension status',
      };
    }
  }

  async importPath(
    sourcePath: string,
    onProgress?: (progress: Omit<ExtensionImportProgress, 'requestId' | 'sourcePath'>) => void,
    reviewToken?: string,
    options?: { trustMarketplaceSource?: boolean },
  ): Promise<ExtensionImportResult> {
    return this.runMutationExclusive(() =>
      this.importPathExclusive(sourcePath, onProgress, reviewToken, options),
    );
  }

  private async importPathExclusive(
    sourcePath: string,
    onProgress?: (progress: Omit<ExtensionImportProgress, 'requestId' | 'sourcePath'>) => void,
    reviewToken?: string,
    options?: { trustMarketplaceSource?: boolean },
  ): Promise<ExtensionImportResult> {
    let temporaryDirectory: string | null = null;
    let currentStage: ExtensionImportStage = 'preparing';
    const reportProgress = (stage: ExtensionImportStage, percent: number): void => {
      currentStage = stage;
      onProgress?.({ stage, percent });
    };
    try {
      reportProgress('preparing', 5);
      const normalizedSourcePath = path.resolve(sourcePath);
      const stats = fs.statSync(normalizedSourcePath);
      let extensionId: string | undefined;
      let pluginDirectory: string;

      if (stats.isDirectory()) {
        reportProgress('validating', 25);
        pluginDirectory = normalizedSourcePath;
        extensionId = validateNativePluginDirectory(pluginDirectory);
      } else if (stats.isFile() && isSupportedArchive(normalizedSourcePath)) {
        reportProgress('extracting', 15);
        temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-extension-import-'));
        const lowerPath = normalizedSourcePath.toLowerCase();
        if (lowerPath.endsWith('.zip')) {
          await extractZip(normalizedSourcePath, { dir: temporaryDirectory });
        } else {
          await tar.extract({
            file: normalizedSourcePath,
            cwd: temporaryDirectory,
            preservePaths: false,
            strict: true,
          });
        }
        assertNoSymbolicLinks(temporaryDirectory);
        reportProgress('validating', 25);
        pluginDirectory = resolveExtractedPluginDirectory(temporaryDirectory);
        extensionId = validateNativePluginDirectory(pluginDirectory);
      } else {
        return {
          success: false,
          error:
            'Select an OpenClaw extension folder or a supported archive (.zip, .tar, .tar.gz, .tgz).',
          failedStage: currentStage,
        };
      }

      reportProgress('preparing_runtime', 35);
      const manager = this.deps.getOpenClawEngineManager();
      const initialPhase = manager.getStatus().phase;
      const wasRuntimeActive = initialPhase === 'running' || initialPhase === 'starting';
      const cli = await manager.buildCliEnvironment();
      if (this.deps.requestGateway && !options?.trustMarketplaceSource) {
        const inspected = await this.inspectCapabilityReview({
          cli,
          pluginDirectory,
          sourcePath: normalizedSourcePath,
          extensionId,
        });
        extensionId = inspected.extensionId;
        if (!reviewToken || reviewToken !== inspected.review.reviewToken) {
          return {
            success: false,
            extensionId,
            capabilityReview: inspected.review,
            failedStage: 'validating',
          };
        }
      }
      const installArgs = [
        cli.openclawEntry,
        'plugins',
        'install',
        normalizedSourcePath,
        '--force',
        ...(this.deps.requestGateway || options?.trustMarketplaceSource
          ? ['--accept-capabilities']
          : []),
      ];
      const installEnv = {
        ...cli.env,
        // Keep OpenClaw's one-time legacy migration isolated from a standalone
        // OpenClaw installation in the user's home directory.
        OPENCLAW_HOME: manager.getBaseDir(),
        ELECTRON_RUN_AS_NODE: '1',
        NPM_CONFIG_FETCH_RETRIES: '0',
        NPM_CONFIG_FETCH_TIMEOUT: '15000',
        npm_config_fetch_retries: '0',
        npm_config_fetch_timeout: '15000',
      };
      reportProgress('installing', 45);
      if (hasRuntimeDependencies(pluginDirectory)) {
        reportProgress('installing_dependencies', 55);
      }
      const stateDir =
        typeof cli.env.OPENCLAW_STATE_DIR === 'string' && cli.env.OPENCLAW_STATE_DIR
          ? cli.env.OPENCLAW_STATE_DIR
          : typeof manager.getStateDir === 'function'
            ? manager.getStateDir()
            : manager.getBaseDir();
      const extensionsRoot = path.join(stateDir, 'extensions');
      const installedPath = extensionId
        ? findInstalledExtensionPath(extensionsRoot, extensionId)
        : undefined;
      const defaultTargetPath = extensionId
        ? path.join(extensionsRoot, extensionId)
        : extensionsRoot;
      const targetPath =
        installedPath && isPathWithinDirectory(extensionsRoot, installedPath)
          ? installedPath
          : isPathWithinDirectory(extensionsRoot, defaultTargetPath)
            ? defaultTargetPath
            : extensionsRoot;
      const configPath =
        typeof manager.getConfigPath === 'function'
          ? manager.getConfigPath()
          : path.join(stateDir, 'openclaw.json');
      let allowlistError = '';
      const command = await this.runDirectoryCommand(targetPath, async () => {
        const result = await this.runCommand(process.execPath, installArgs, {
          cwd: cli.runtimeRoot,
          env: installEnv,
          successPattern: createInstallSuccessPattern(extensionId),
          onOutput: output => {
            if (
              currentStage === 'installing' &&
              /installing plugin dependencies|npm (?:install|exec)|omit=dev|node_modules/i.test(
                output,
              )
            ) {
              reportProgress('installing_dependencies', 65);
            }
          },
        });
        if (result.exitCode === 0 && extensionId && !this.deps.requestGateway) {
          try {
            updateExtensionAllowlist(
              configPath,
              extensionId,
              'add',
              this.deps.getManagedPluginIds?.() ?? [],
            );
          } catch (error) {
            allowlistError = error instanceof Error ? error.message : String(error);
          }
        }
        return result;
      });
      const result = command.result;
      if (result.exitCode !== 0) {
        const failedStage = inferInstallerFailureStage(result, currentStage);
        console.error(
          '[OpenClawExtensionImportService] OpenClaw installer failed:',
          command.error ?? formatCommandError(result),
        );
        return {
          success: false,
          error: command.error ?? formatCommandError(result),
          failedStage,
        };
      }

      if (wasRuntimeActive && !command.runtimeRestarted) {
        reportProgress('restarting_gateway', 90);
        const status = await this.restartGatewayAfterMutation('extension-import');
        if (status.phase !== 'running') {
          return {
            success: false,
            error:
              status.message || 'Extension installed, but the OpenClaw Gateway failed to restart.',
            failedStage: currentStage,
          };
        }
      }

      if (allowlistError) {
        return {
          success: false,
          extensionId,
          error: `Extension installed, but it could not be added to the plugin allowlist: ${allowlistError}`,
          failedStage: currentStage,
        };
      }

      reportProgress('completed', 100);
      return { success: true, extensionId };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to import extension',
        failedStage: currentStage,
      };
    } finally {
      if (temporaryDirectory) {
        try {
          fs.rmSync(temporaryDirectory, {
            recursive: true,
            force: true,
            maxRetries: process.platform === 'win32' ? 5 : 0,
            retryDelay: process.platform === 'win32' ? 200 : 0,
          });
        } catch (error) {
          console.warn(
            '[OpenClawExtensionImportService] Failed to clean temporary directory:',
            error instanceof Error ? error.message : String(error),
          );
        }
      }
    }
  }
}

export const __openClawExtensionImportTestUtils = {
  isDirectoryLockError,
  isGatewayUnavailableError,
  isSupportedArchive,
  resolveExtractedPluginDirectory,
  runCommand,
  validateNativePluginDirectory,
};
