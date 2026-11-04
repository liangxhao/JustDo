import fs from 'fs';
import JSON5 from 'json5';
import os from 'os';
import path from 'path';
import * as tar from 'tar';

import { redactLogText } from '../../../shared/diagnostics/redaction';
import {
  type ExtensionDataInfoResult,
  type ExtensionDeleteResult,
  type ExtensionImportResult,
  type ExtensionImportStage,
  type ExtensionInstallProgress,
  type ExtensionSetEnabledResult,
  ExtensionState,
  type InstalledOpenClawExtension,
  type OpenClawExtensionConfigurationField,
  type OpenClawPluginCapabilityReview,
} from '../../../shared/plugins/extensions';
import {
  PluginOperationStage,
  toPluginOperationStage,
} from '../../../shared/plugins/pluginOperation';
import {
  managedDirectoryFailure,
  managedDirectoryFailureFromMessage,
  ManagedDirectoryOperationCoordinator,
  managedDirectorySuccess,
} from '../../core/filesystem/managedDirectoryOperations';
import { extractZipSafely } from '../../core/filesystem/safeZipExtractor';
import { t } from '../../core/i18n';
import type { EffectiveOutboundHeaderPolicySnapshot } from '../../core/network/outboundHeaderPolicyService';
import type { GatewayClientLike } from '../../engine/gateway/types';
import type { GatewayRequestOptions } from '../../engine/types';
import { restrictCredentialFile } from '../../openclaw/config/models/providerSecretFile';
import { requireOpenClawCliExecutable } from '../../openclaw/runtime/launch/cliNodeRuntime';
import type { OpenClawEngineManager } from '../../openclaw/runtime/openclawEngineManager';
import {
  inspectPluginData,
  preparePluginDataRemoval,
  removePluginData,
} from '../data/pluginDataService';
import { sanitizeInstallationFailureReason } from '../installation/installationFailureReason';
import {
  type CommandOptions,
  type CommandResult,
  runExtensionCommand as runCommand,
} from './extensionCommand';
import {
  deleteNestedValue,
  getNestedValue,
  getTextConfigurationFields,
  isSafeConfigPath,
  isValidTextConfigurationValue,
  setNestedValue,
} from './extensionConfigurationFields';
import { prepareExtensionForInstall } from './extensionConversion';
import {
  prepareExtensionInstallArchive,
  prepareExtensionInstallSource,
} from './extensionInstallSource';
import { installExtensionPackage, removeExtensionPackage } from './extensionMutation';
import type { ExtensionNetworkPolicyInspection } from './extensionNetworkPolicyManifest';
import {
  type ApplyExtensionPackageMutation,
  ExtensionPackageLifecycleMode,
} from './extensionPackageLifecycle';
import {
  type ExtensionPackageOwnership,
  readExtensionArtifactPluginIds,
  readExtensionPackageOwnership,
} from './extensionPackageOwnership';
import { isExtensionSecretReferenceField, saveExtensionSecrets } from './extensionSecretFile';
import {
  isNativePluginAdmissionBusy,
  type NativePluginAdmissionProgress,
  type NativePluginMutationMethod,
  requestNativePluginMutation,
} from './nativePluginMutation';

const OPENCLAW_PLUGIN_MANIFEST = 'openclaw.plugin.json';
const PLUGIN_RUNTIME_SERVICE_FAILED = 'service-failed';
const AGENT_PLUGIN_MANIFEST_SCHEMA = 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json';
const SUPPORTED_ARCHIVE_EXTENSIONS = ['.zip', '.tar', '.tar.gz', '.tgz'];
const PLUGIN_ARCHIVE_ROOT_MARKERS = [
  'package.json',
  OPENCLAW_PLUGIN_MANIFEST,
  '.codex-plugin/plugin.json',
  '.claude-plugin/plugin.json',
  '.cursor-plugin/plugin.json',
  'plugin.json',
];
const GATEWAY_INSTALL_TIMEOUT_MS = 600_000;
const appendRecoveryFailure = (primary: string, recovery?: string): string =>
  recovery && recovery !== primary
    ? `${primary}\n${t('extensionPackageRecoveryFailed')}\n${recovery}`
    : primary;
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

// The CLI can print "Installed plugin" before runtime application finishes.
// Only its final lifecycle receipt is safe to treat as command completion.
const createInstallSuccessPattern = (
  extensionId: string | undefined,
  appliedOnly = false,
): RegExp | undefined => {
  if (!extensionId) return undefined;
  const escapedId = extensionId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const receipt = appliedOnly
    ? 'Applied in Gateway generation \\d+\\.'
    : '(?:Applied in Gateway generation \\d+\\.|Saved for the next Gateway start\\.)';
  return new RegExp(
    `(?:^|\\r?\\n)Installed plugin:[ \\t]*${escapedId}[ \\t]*\\r?\\n${receipt}(?:\\r?\\n|$)`,
  );
};

export type { ExtensionImportResult, ExtensionImportStage, ExtensionInstallProgress };

/** Additional Main-only installation identity and source location evidence. */
type CommittedExtensionImportResult = ExtensionImportResult & {
  installationCommitted?: true;
  installSourceInUse?: true;
  installPath?: string;
  operationFailedStage?: PluginOperationStage;
};

type ExtensionImportOptions = {
  trustMarketplaceSource?: boolean;
  preserveActivation?: boolean;
  autoAcceptCapabilities?: true;
  onOperationProgress?: OperationProgress;
  applyPackageMutation?: ApplyExtensionPackageMutation;
  onInstalled?: (
    result: CommittedExtensionImportResult,
    mode: ExtensionPackageLifecycleMode,
  ) => Promise<CommittedExtensionImportResult>;
};

export type { InstalledOpenClawExtension };

type OperationProgress = (stage: PluginOperationStage) => void;
type ExtensionCatalogProjection = () => InstalledOpenClawExtension[];

type OpenClawExtensionImportServiceDeps = {
  getOpenClawEngineManager: () => OpenClawEngineManager;
  getManagedPluginIds?: () => string[];
  getNativeSkillIds?: (extensionId: string) => string[];
  requiresHotToggle?: (extensionId: string) => boolean;
  getConnectedGatewayClient?: () => Pick<GatewayClientLike, 'request'> | null;
  requestGateway?: <T>(
    method: string,
    params?: unknown,
    options?: GatewayRequestOptions,
  ) => Promise<T>;
  runConfigMutationExclusive?: <T>(operation: () => Promise<T>) => Promise<T>;
  restartGatewayAfterMutation?: (reason: string, options?: { networkPolicyChanged?: true }) => Promise<{
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
  outboundHeaderPolicy?: {
    inspectExtension: (extensionRoot: string) => ExtensionNetworkPolicyInspection | null;
    reconcile: () => EffectiveOutboundHeaderPolicySnapshot;
  };
  readPackageOwnership?: typeof readExtensionPackageOwnership;
  pluginData?: {
    inspect: typeof inspectPluginData;
    prepareRemoval: typeof preparePluginDataRemoval;
    remove: typeof removePluginData;
  };
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
  const files = fs.readdirSync(dist).filter(name => name.startsWith(prefix) && /\.m?js$/u.test(name));
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
  // Match the native archive installer's packed-root selection exactly. A root
  // manifest cannot hide the package/ directory that Native will actually use.
  const packed = path.join(extractDir, 'package');
  try {
    if (fs.statSync(packed).isDirectory()) return packed;
  } catch {
    // A missing package/ directory permits the remaining native layout rules.
  }
  if (PLUGIN_ARCHIVE_ROOT_MARKERS.some(marker => fs.existsSync(path.join(extractDir, marker))))
    return extractDir;
  const directories = fs.readdirSync(extractDir, { withFileTypes: true })
    .filter(entry => entry.isDirectory());
  if (directories.length !== 1) throw new Error(t('extensionImportArchiveLayoutInvalid'));
  return path.join(extractDir, directories[0].name);
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

const isSymbolicLinkCreationError = (error: unknown): boolean => {
  let current = error;
  const visited = new Set<unknown>();
  while ((current instanceof Error || isRecord(current)) && !visited.has(current)) {
    visited.add(current);
    const record = current as { syscall?: unknown; message?: unknown; cause?: unknown };
    const syscall =
      typeof record.syscall === 'string'
        ? record.syscall.toLowerCase()
        : managedDirectoryFailureFromMessage(
            typeof record.message === 'string' ? record.message : '',
            '',
          ).syscall;
    if (syscall === 'symlink') return true;
    current = record.cause;
  }
  return false;
};

const isGatewayUnavailableError = (error: unknown): boolean => {
  if (isSymbolicLinkCreationError(error)) return false;
  if (!isRecord(error) && !(error instanceof Error)) return false;
  const code = 'code' in error && typeof error.code === 'string' ? error.code : '';
  if (['CLIENT_TIMEOUT', 'CLIENT_CLOSED', 'ECONNREFUSED', 'ECONNRESET'].includes(code)) return true;
  const message = error instanceof Error ? error.message : '';
  return /not connected|gateway(?: client)? is unavailable|runtime adapter is unavailable|gateway request timed out|gateway client connect timeout|gateway client stopped|gateway closed|openclaw engine is not running|failed to start (?:the )?(?:openclaw )?(?:engine|gateway)|ECONNREFUSED|ECONNRESET/i.test(
    message,
  );
};

const isGatewayMutationNotSent = (error: unknown): boolean => {
  if (!isRecord(error) && !(error instanceof Error)) return false;
  // A native rejection is authoritative; its diagnostic text cannot establish
  // that the requested mutation never reached the Gateway.
  if ('gatewayCode' in error) return false;
  if ('requestSent' in error) return error.requestSent === false;
  const message = error instanceof Error ? error.message : '';
  // These exact errors originate before requestGateway invokes client.request.
  // Generic closed/reset/unavailable errors can also occur after dispatch.
  return /^(?:OpenClaw runtime adapter is unavailable\.|OpenClaw gateway client is unavailable\.|OpenClaw engine is not running\.|OpenClaw gateway client connect timeout after \d+ms\.?)$/i.test(
    message,
  );
};

const readNativePluginBusyMessage = (error: unknown): string | undefined => {
  if (isNativePluginAdmissionBusy(error)) {
    return t('extensionOperationBusy');
  }
  return undefined;
};

const isDirectoryLockError = (error: unknown): boolean => {
  // A native preparation failure must take precedence over a generic outer code.
  if (isSymbolicLinkCreationError(error)) return false;
  let current = error;
  const visited = new Set<unknown>();
  while ((current instanceof Error || isRecord(current)) && !visited.has(current)) {
    visited.add(current);
    const record = current as { code?: unknown; message?: unknown; cause?: unknown };
    const code = typeof record.code === 'string' ? record.code.toUpperCase() : '';
    const message = typeof record.message === 'string' ? record.message : '';
    if (code === 'EACCES' || code === 'EPERM' || code === 'EBUSY') return true;
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

const hasMultipleRuntimeEntries = (directory: string): boolean => {
  const manifest = readJsonRecord(path.join(directory, 'package.json'));
  return (
    isRecord(manifest.openclaw) &&
    Array.isArray(manifest.openclaw.extensions) &&
    manifest.openclaw.extensions.length > 1
  );
};

const sameInstallPath = (left: string, right: string): boolean => {
  const normalize = (value: string) =>
    process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
  return normalize(left) === normalize(right);
};

const normalizeMetadataText = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined;

const resolveExtensionDescription = (
  manifest: Record<string, unknown>,
  packageJson?: Record<string, unknown>,
): string => {
  const interfaceMetadata = isRecord(manifest.interface) ? manifest.interface : undefined;
  return (
    normalizeMetadataText(manifest.description) ??
    normalizeMetadataText(manifest.shortDescription) ??
    normalizeMetadataText(interfaceMetadata?.shortDescription) ??
    normalizeMetadataText(packageJson?.description) ??
    ''
  );
};

const readExtensionDescriptionFromDirectory = (pluginDirectory: string): string => {
  const manifestPath = findSupportedPluginManifestPath(pluginDirectory);
  const manifest = manifestPath ? readJsonRecord(manifestPath) : {};
  const packagePath = path.join(pluginDirectory, 'package.json');
  const packageJson = fs.existsSync(packagePath) ? readJsonRecord(packagePath) : undefined;
  return resolveExtensionDescription(manifest, packageJson);
};

const findBundledExtensionDirectory = (
  manager: OpenClawEngineManager,
  extensionId: string,
): string | undefined => {
  const runtimeRoot = manager.getRuntimeRoot?.();
  if (!runtimeRoot) return undefined;
  const extensionsRoot = path.resolve(runtimeRoot, 'dist', 'extensions');
  const pluginDirectory = path.resolve(extensionsRoot, extensionId);
  if (path.dirname(pluginDirectory) !== extensionsRoot || !fs.existsSync(pluginDirectory)) {
    return undefined;
  }
  return pluginDirectory;
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

const collectProviderEnvGroups = (manifest: Record<string, unknown>): string[][] => {
  const groups: string[][] = [];
  const addEnvVars = (envVars: unknown): void => {
    if (!Array.isArray(envVars)) return;
    const names = [
      ...new Set(
        envVars.filter(
          (envVar): envVar is string =>
            typeof envVar === 'string' &&
            /^[A-Za-z_][A-Za-z0-9_]*$/.test(envVar) &&
            isSafeConfigPath(envVar),
        ),
      ),
    ];
    if (names.length && !groups.some(group => JSON.stringify(group) === JSON.stringify(names)))
      groups.push(names);
  };
  const setup = isRecord(manifest.setup) ? manifest.setup : {};
  const providers = Array.isArray(setup.providers) ? setup.providers : [];
  providers.forEach(provider => {
    if (isRecord(provider)) addEnvVars(provider.envVars);
  });
  return groups;
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
  const envGroups = collectProviderEnvGroups(manifest);
  const requiredEnvVars = [...new Set(envGroups.flat())];
  const uiHints = isRecord(manifest.uiHints) ? manifest.uiHints : {};
  const sensitiveHints = Object.entries(uiHints).filter(
    (entry): entry is [string, Record<string, unknown>] =>
      isSafeConfigPath(entry[0]) && isRecord(entry[1]) && entry[1].sensitive === true,
  );
  const properties =
    isRecord(manifest.configSchema) && isRecord(manifest.configSchema.properties)
      ? manifest.configSchema.properties
      : {};
  const numericHints = Object.entries(uiHints).filter(
    ([key, hint]) =>
      isSafeConfigPath(key) &&
      isRecord(hint) &&
      hint.configurable === true &&
      isRecord(properties[key]) &&
      ['integer', 'number'].includes(String(properties[key].type)),
  );
  const config = readJsonRecord(manager.getConfigPath());
  const pluginsConfig = isRecord(config.plugins) ? config.plugins : {};
  const pluginEntries = isRecord(pluginsConfig.entries) ? pluginsConfig.entries : {};
  const pluginEntry = isRecord(pluginEntries[extensionId]) ? pluginEntries[extensionId] : {};
  const pluginConfig = pluginEntry.config;
  const textFields = getTextConfigurationFields(manifest, pluginConfig);
  if (
    !requiredEnvVars.length &&
    !sensitiveHints.length &&
    !numericHints.length &&
    !textFields.length
  )
    return { fields: [], missingRequirements: [] };
  const configuredEnv = isRecord(config.env) ? config.env : {};
  const configuredEnvVars = isRecord(configuredEnv.vars) ? configuredEnv.vars : {};
  const dotenvKeys = new Set<string>();
  for (const envPath of [
    path.join(manager.getBaseDir(), '.env'),
    path.join(manager.getStateDir(), '.env'),
  ]) {
    for (const key of readDotEnvKeys(envPath)) dotenvKeys.add(key);
  }
  const isEnvConfigured = (name: string): boolean =>
    hasConfiguredValue(process.env[name]) ||
    hasConfiguredValue(configuredEnvVars[name]) ||
    hasConfiguredValue(configuredEnv[name]) ||
    dotenvKeys.has(name);
  const hasResolvedConfiguredValue = (value: unknown): boolean => {
    if (typeof value === 'string') {
      const envReference = value.trim().match(/^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/)?.[1];
      return envReference ? isEnvConfigured(envReference) : hasConfiguredValue(value);
    }
    return hasConfiguredValue(value);
  };
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
  for (const [configPath, rawHint] of numericHints) {
    const hint = rawHint as Record<string, unknown>;
    const schema = properties[configPath] as Record<string, unknown>;
    const value = getNestedValue(pluginConfig, configPath);
    fields.push({
      path: configPath,
      label: typeof hint.label === 'string' ? hint.label : configPath,
      labelKey: typeof hint.labelKey === 'string' ? hint.labelKey : undefined,
      helpKey: typeof hint.helpKey === 'string' ? hint.helpKey : undefined,
      help: typeof hint.help === 'string' ? hint.help : undefined,
      type: schema.type as 'integer' | 'number',
      sensitive: false,
      configured: typeof value === 'number',
      minimum: typeof schema.minimum === 'number' ? schema.minimum : undefined,
      maximum: typeof schema.maximum === 'number' ? schema.maximum : undefined,
      defaultValue: typeof schema.default === 'number' ? schema.default : undefined,
      value: typeof value === 'number' && Number.isFinite(value) ? value : undefined,
    });
  }
  fields.push(...textFields);
  const configContracts = isRecord(manifest.configContracts) ? manifest.configContracts : {};
  const compatibilityPaths = Array.isArray(configContracts.compatibilityRuntimePaths)
    ? configContracts.compatibilityRuntimePaths
    : [];
  const hasCompatibilityConfig = compatibilityPaths.some(
    configPath =>
      typeof configPath === 'string' &&
      hasResolvedConfiguredValue(getNestedValue(config, configPath)),
  );
  const missingRequirements: string[] = [];
  for (const candidates of envGroups) {
    const matchingFields = fields.filter(
      field => field.requirement && candidates.includes(field.requirement),
    );
    const configured =
      hasCompatibilityConfig ||
      candidates.some(isEnvConfigured) ||
      matchingFields.some(field => field.configured);
    if (!configured) missingRequirements.push(...candidates);
    if (matchingFields.length === 0) {
      fields.push({
        path: `env.vars.${candidates[0]}`,
        label: candidates[0],
        requirement: candidates[0],
        environmentVariables: candidates,
        configuredEnvironmentVariables: candidates.filter(isEnvConfigured),
        inheritedEnvironmentVariables: candidates.filter(name =>
          hasConfiguredValue(process.env[name]),
        ),
        sensitive: true,
        configured,
      });
    } else if (configured) {
      matchingFields.forEach(field => {
        field.configured = true;
      });
    }
  }
  return { fields, missingRequirements: [...new Set(missingRequirements)] };
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

const sanitizeCommandOutput = (output: string): string =>
  redactLogText(output.replace(/\u001b\[[0-9;]*m/g, ''))
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1***:***@')
    .replace(/(_authToken\s*[=:]\s*)[^\s]+/gi, '$1***')
    .trim();

const formatCommandError = (result: CommandResult): string => {
  if (result.timedOut) {
    return t('extensionCommandTimedOutUnconfirmed');
  }
  const output = sanitizeCommandOutput(result.stderr || result.stdout);
  const packagingError = output.match(
    /package install requires compiled runtime output[\s\S]*?(?=\s*Also not a valid hook pack:|$)/i,
  )?.[0];
  if (packagingError) return packagingError.trim().slice(-1200);
  return output
    ? output.slice(-1200)
    : `OpenClaw extension command exited with code ${result.exitCode}`;
};

const inferInstallerFailureStage = (result: CommandResult): ExtensionImportStage | undefined => {
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
  return undefined;
};

export class OpenClawExtensionImportService {
  private readonly runCommand: NonNullable<OpenClawExtensionImportServiceDeps['runCommand']>;
  private readonly directoryOperations: ManagedDirectoryOperationCoordinator;
  private mutationTail: Promise<void> = Promise.resolve();
  private catalogRead: Promise<ExtensionCatalogProjection> | undefined;
  // A failed config write or restart must not make a credential retry a no-op.
  // This state is process-local: a fresh Gateway startup reads the saved secret file.
  private readonly pendingCredentialRefresh = new Set<string>();
  private readonly pendingNumericRefresh = new Set<string>();

  constructor(private readonly deps: OpenClawExtensionImportServiceDeps) {
    this.runCommand = deps.runCommand ?? runCommand;
    this.directoryOperations =
      deps.directoryOperations ?? new ManagedDirectoryOperationCoordinator();
  }

  private requestPluginMutation<T>(
    method: NativePluginMutationMethod,
    params: unknown,
    options?: GatewayRequestOptions,
    progress?: NativePluginAdmissionProgress,
    requestGateway = this.deps.requestGateway,
  ): Promise<T> {
    if (!requestGateway) throw new Error('The native plugin Gateway is unavailable.');
    const manager = this.deps.getOpenClawEngineManager();
    const pid = manager.getGatewayProcessId?.();
    const generation = manager.getGatewayProcessGeneration?.();
    const ownerKnown =
      manager.getStatus?.().phase === 'running' &&
      typeof pid === 'number' &&
      Number.isSafeInteger(pid) &&
      pid > 0 &&
      typeof generation === 'number' &&
      Number.isSafeInteger(generation);
    return requestNativePluginMutation(
      requestOptions =>
        requestOptions
          ? requestGateway<T>(method, params, requestOptions)
          : requestGateway<T>(method, params),
      options,
      () =>
        ownerKnown &&
        manager.getStatus().phase === 'running' &&
        manager.getGatewayProcessId?.() === pid &&
        manager.getGatewayProcessGeneration?.() === generation,
      progress,
    );
  }

  private runConfigMutationExclusive<T>(operation: () => Promise<T>): Promise<T> {
    return this.deps.runConfigMutationExclusive
      ? this.deps.runConfigMutationExclusive(operation)
      : operation();
  }

  private runMutationExclusive<T>(
    operation: () => Promise<T>,
    configMutation = true,
  ): Promise<T> {
    const run = async (): Promise<T> => {
      // Concurrent readers may share discovery only within the same mutation
      // epoch. A pre-mutation request must never supply a post-mutation refresh.
      this.catalogRead = undefined;
      try {
        return await (configMutation ? this.runConfigMutationExclusive(operation) : operation());
      } finally {
        this.catalogRead = undefined;
      }
    };
    const result = this.mutationTail.then(run, run);
    this.mutationTail = result.then(
      (): void => undefined,
      (): void => undefined,
    );
    return result;
  }

  private restartGatewayAfterMutation(reason: string, options?: { networkPolicyChanged?: true }): Promise<{
    phase: string;
    message?: string;
    deferred?: boolean;
  }> {
    const manager = this.deps.getOpenClawEngineManager();
    if (manager.isGatewayMutationInProgress?.())
      return Promise.resolve({ phase: manager.getStatus().phase, deferred: true });
    if (!this.deps.restartGatewayAfterMutation) {
      throw new Error('The safe Gateway restart coordinator is unavailable.');
    }
    return options
      ? this.deps.restartGatewayAfterMutation(reason, options)
      : this.deps.restartGatewayAfterMutation(reason);
  }

  /** Apply a CLI mutation through the native plugin lifecycle when the Gateway is live. */
  private async reloadPluginAfterCliMutation(
    method: 'plugins.reload' | 'plugins.refresh',
    extensionId?: string,
  ): Promise<boolean> {
    if (
      !this.deps.requestGateway ||
      this.deps.getOpenClawEngineManager().getStatus().phase !== 'running' ||
      (method === 'plugins.reload' && !extensionId)
    ) {
      return false;
    }
    try {
      const result = await this.requestPluginMutation<{ ok: boolean; restartRequired: boolean }>(
        method,
        method === 'plugins.reload' ? { plugins: [{ pluginId: extensionId }] } : {},
      );
      return result.ok === true && result.restartRequired === false;
    } catch (error) {
      console.warn(
        `[OpenClawExtensionImportService] Native plugin reload failed; requesting Gateway restart: ${String(error)}`,
      );
      return false;
    }
  }

  private async syncExtensionSkills(
    extensionId: string,
    enabled: boolean,
    viaGateway: boolean,
    requestGateway = this.deps.requestGateway,
  ): Promise<void> {
    for (const skillId of this.deps.getNativeSkillIds?.(extensionId) ?? []) {
      try {
        if (viaGateway && requestGateway) {
          const result = await requestGateway<{ ok: boolean }>('skills.update', {
            skillKey: skillId,
            enabled,
          });
          if (!result.ok) throw new Error('Skill update rejected');
          continue;
        }
        const manager = this.deps.getOpenClawEngineManager();
        const cli = await manager.buildCliEnvironment();
        const result = await this.runCommand(
          requireOpenClawCliExecutable(cli.env),
          [
            cli.openclawEntry,
            'config',
            'set',
            `skills.entries.${skillId}.enabled`,
            String(enabled),
            '--strict-json',
          ],
          {
            cwd: cli.runtimeRoot,
            env: { ...cli.env, OPENCLAW_HOME: manager.getBaseDir(), ELECTRON_RUN_AS_NODE: '1' },
          },
        );
        if (result.exitCode !== 0) throw new Error('Skill update rejected');
        const config = readJsonRecord(manager.getConfigPath());
        const skills = isRecord(config.skills) ? config.skills : {};
        const entries = isRecord(skills.entries) ? skills.entries : {};
        const entry = entries[skillId];
        if (!isRecord(entry) || entry.enabled !== enabled)
          throw new Error('Skill update not persisted');
      } catch {
        // The plugin write may already have committed. Report the skill failure
        // without replaying the plugin mutation.
        throw new Error(t('appPluginSkillSyncFailed'));
      }
    }
  }

  private captureConnectedGatewayRequest(): OpenClawExtensionImportServiceDeps['requestGateway'] {
    const client = this.deps.getConnectedGatewayClient?.();
    const manager = this.deps.getOpenClawEngineManager();
    const pid = manager.getGatewayProcessId();
    if (!client || !pid || manager.getStatus().phase !== 'running') return undefined;
    const generation = manager.getGatewayProcessGeneration();
    return <T>(method: string, params?: unknown, options?: GatewayRequestOptions): Promise<T> => {
      if (manager !== this.deps.getOpenClawEngineManager() ||
          client !== this.deps.getConnectedGatewayClient?.() ||
          pid !== manager.getGatewayProcessId() || generation !== manager.getGatewayProcessGeneration() ||
          manager.getStatus().phase !== 'running')
        return Promise.reject(Object.assign(new Error('OpenClaw gateway client is unavailable.'), {
          code: 'CLIENT_CLOSED', requestSent: false,
        }));
      options?.assertBeforeSend?.();
      if (client !== this.deps.getConnectedGatewayClient?.() ||
          pid !== manager.getGatewayProcessId() || generation !== manager.getGatewayProcessGeneration() ||
          manager.getStatus().phase !== 'running')
        return Promise.reject(Object.assign(new Error('OpenClaw gateway client is unavailable.'), {
          code: 'CLIENT_CLOSED', requestSent: false,
        }));
      return options
        ? client.request<T>(method, params, { timeoutMs: options.timeoutMs })
        : client.request<T>(method, params);
    };
  }

  private async waitForHotSkillApplication(
    skillIds: string[],
    enabled: boolean,
    requestGateway: NonNullable<OpenClawExtensionImportServiceDeps['requestGateway']>,
  ): Promise<void> {
    for (const delay of [0, 100, 250, 500, 1000, 2000, 5000]) {
      if (delay) await new Promise(resolve => setTimeout(resolve, delay));
      const snapshot = await requestGateway<{
        valid?: boolean;
        configRevisionHash?: string;
        appliedConfigHash?: string;
        config?: { skills?: { entries?: Record<string, { enabled?: boolean }> } };
      }>('config.get', {});
      if (
        snapshot.valid === true &&
        typeof snapshot.configRevisionHash === 'string' && snapshot.configRevisionHash.length > 0 &&
        snapshot.configRevisionHash === snapshot.appliedConfigHash &&
        skillIds.every(id => snapshot.config?.skills?.entries?.[id]?.enabled === enabled)
      )
        return;
    }
    throw new Error('Native skill configuration has not been applied.');
  }

  private async inspectCapabilityReview(params: {
    cli: Awaited<ReturnType<OpenClawEngineManager['buildCliEnvironment']>>;
    pluginDirectory: string;
    sourcePath: string;
    extensionId?: string;
  }): Promise<{ extensionId: string; review: OpenClawPluginCapabilityReview }> {
    if (this.deps.inspectCapabilityReview) {
      return this.deps.inspectCapabilityReview(params);
    }

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
        requireOpenClawCliExecutable(params.cli.env),
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
    options: { preflightLockCheck?: boolean } = {},
  ): Promise<{ result: CommandResult; runtimeRestarted: boolean; error?: string }> {
    let lastResult: CommandResult | null = null;
    let nativeCommandError: string | undefined;
    const operation = await this.directoryOperations.execute({
      resourceName: t('extensionDirectoryResource'),
      targetPath,
      manageRuntimeOnLock: false,
      // Recursive uninstall retains its preflight. Native installation owns a
      // staged update; an open directory handle alone cannot prove it will fail.
      preflightLockCheck: options.preflightLockCheck ?? true,
      operation: async () => {
        try {
          lastResult = await command();
        } catch (error) {
          const rawMessage = error instanceof Error ? error.message : String(error);
          const message = sanitizeCommandOutput(rawMessage);
          // Only an explicit native filesystem rejection can become a diagnosed
          // command failure. Transport uncertainty must keep its original evidence.
          if (options.preflightLockCheck !== false || !isRecord(error) ||
              typeof error.gatewayCode !== 'string' || !isDirectoryLockError({ message, cause: error }) ||
              !/\b(?:EACCES|EPERM|EBUSY|rename|rmdir|unlink)\b/i.test(message)) throw error;
          nativeCommandError = sanitizeInstallationFailureReason(rawMessage, [], { preserveLocalPaths: true }) ??
            t('extensionFollowupFailureReasonUnavailable');
          lastResult = { exitCode: 1, stdout: '', stderr: nativeCommandError };
          return managedDirectoryFailure(managedDirectoryFailureFromMessage(nativeCommandError, targetPath));
        }
        if (lastResult.exitCode === 0) return managedDirectorySuccess(lastResult);
        return managedDirectoryFailure(
          managedDirectoryFailureFromMessage(formatCommandError(lastResult), targetPath),
        );
      },
    });
    if (!('failure' in operation)) {
      return { result: operation.value, runtimeRestarted: operation.runtimeRestarted };
    }
    const commandError = nativeCommandError ?? (lastResult ? formatCommandError(lastResult) : undefined);
    return {
      result:
        lastResult ??
        ({ exitCode: 1, stdout: '', stderr: operation.failure.message } satisfies CommandResult),
      runtimeRestarted: operation.runtimeRestarted,
      error: commandError && !operation.failure.message.includes(commandError)
        ? `${commandError}\n\n${operation.failure.message}`
        : operation.failure.message,
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
              description: resolveExtensionDescription(manifest, packageJson),
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

  private async readPackageOwnership(
    local: InstalledOpenClawExtension[],
  ): Promise<ExtensionPackageOwnership[]> {
    const multiple = local.filter(entry => hasMultipleRuntimeEntries(entry.installPath));
    if (!multiple.length) return [];
    const packages = await (this.deps.readPackageOwnership ?? readExtensionPackageOwnership)(
      this.deps.getOpenClawEngineManager(),
    );
    const verified = packages.filter(owner =>
      local.some(
        entry =>
          entry.id === owner.ownerId && sameInstallPath(entry.installPath, owner.installPath),
      ),
    );
    if (multiple.some(entry => !verified.some(owner => owner.ownerId === entry.id)))
      throw new Error(t('extensionPackageOwnershipUnconfirmed'));
    return verified;
  }

  private projectPackageEntry(
    local: InstalledOpenClawExtension,
    pluginId: string,
  ): InstalledOpenClawExtension {
    const manager = this.deps.getOpenClawEngineManager();
    const manifestPath = findSupportedPluginManifestPath(local.installPath);
    const configuration = getExtensionConfigurationState(
      manager,
      pluginId,
      manifestPath ? readJsonRecord(manifestPath) : {},
    );
    return {
      ...local,
      id: pluginId,
      enabled: isExtensionEnabled(manager, pluginId),
      configurationFields: configuration.fields,
      missingRequirements: configuration.missingRequirements,
    };
  }

  private async resolveInstalledExtension(
    extensionId: string,
  ): Promise<InstalledOpenClawExtension | undefined> {
    const local = this.listInstalled();
    const direct = local.find(entry => entry.id === extensionId);
    if (direct) return direct;
    const packages = await this.readPackageOwnership(local);
    const owners = packages.filter(owner => owner.pluginIds.includes(extensionId));
    if (owners.length !== 1) return undefined;
    const installed = local.find(
      entry =>
        entry.id === owners[0].ownerId && sameInstallPath(entry.installPath, owners[0].installPath),
    );
    return installed ? this.projectPackageEntry(installed, extensionId) : undefined;
  }

  listCatalog(): Promise<InstalledOpenClawExtension[]> {
    return this.prepareCatalog().then(project => project());
  }

  /** Discover native inventory without holding the application's settings queue. */
  prepareCatalog(): Promise<ExtensionCatalogProjection> {
    if (this.catalogRead) return this.catalogRead;
    const read = this.readCatalog();
    this.catalogRead = read;
    void read.then(
      () => {
        if (this.catalogRead === read) this.catalogRead = undefined;
      },
      () => {
        if (this.catalogRead === read) this.catalogRead = undefined;
      },
    );
    return read;
  }

  private async readCatalog(): Promise<ExtensionCatalogProjection> {
    // Inventory is observational, including notification and Renderer refetches
    // after a hot toggle. Never recover a disconnected Gateway from this path.
    const connectedOnly = this.deps.getConnectedGatewayClient !== undefined;
    const requestGateway = connectedOnly
      ? this.captureConnectedGatewayRequest()
      : this.deps.requestGateway;
    if (!requestGateway) {
      if (connectedOnly) throw new Error(t('extensionCatalogUnavailable'));
      return () => this.listInstalled();
    }
    const manager = this.deps.getOpenClawEngineManager();

    type PluginCatalogEntry = {
      id: string;
      name: string;
      description?: string;
      version?: string;
      kind?: string[];
      origin?: string;
      installed: boolean;
      enabled: boolean;
      state: ExtensionState | 'not-installed';
      error?: string;
      runtime?: {
        state: 'unloaded' | 'disabled' | 'active' | typeof PLUGIN_RUNTIME_SERVICE_FAILED;
        error?: string;
      };
      category?: string;
      removable?: boolean;
    };
    let result: {
      plugins: PluginCatalogEntry[];
      diagnostics: unknown[];
      mutationAllowed: boolean;
    };
    try {
      result = await requestGateway('plugins.list', {});
    } catch (error) {
      // A partial local inventory would erase bundled cards and publish false
      // disabled states. Consumers retain their last successful catalog instead.
      if (connectedOnly) throw error;
      if (!isGatewayUnavailableError(error)) throw error;
      return () => this.listInstalled().map(extension => ({
        ...extension,
        origin: extension.origin ?? 'local-recovery',
        removable: !this.deps.getManagedPluginIds?.().includes(extension.id),
        canToggle: !this.deps.getManagedPluginIds?.().includes(extension.id),
      }));
    }
    const localExtensions = this.listInstalled();
    const packages = await this.readPackageOwnership(localExtensions);
    if (
      !connectedOnly &&
      localExtensions.some(extension => {
        const owner = packages.find(owner => owner.ownerId === extension.id);
        const pluginIds = owner?.pluginIds ?? [extension.id];
        return pluginIds.some(pluginId => {
          const gatewayEntry = result.plugins.find(plugin => plugin.id === pluginId);
          return (
            !gatewayEntry?.installed ||
            (extension.version !== undefined &&
              gatewayEntry.version !== undefined &&
              extension.version !== gatewayEntry.version)
          );
        });
      })
    ) {
      try {
        await this.requestPluginMutation('plugins.refresh', {});
        result = await requestGateway('plugins.list', {});
      } catch (error) {
        console.warn(
          '[OpenClawExtensionImportService] Failed to refresh externally changed plugin inventory:',
          error instanceof Error ? error.message : String(error),
        );
      }
    }
    // Each caller projects current local configuration separately. IPC callers
    // can run this synchronous read after settings application or rollback;
    // mutation notifications already holding that queue project directly.
    return () => {
      const localById = new Map(localExtensions.map(extension => [
        extension.id, this.projectPackageEntry(extension, extension.id),
      ]));
      for (const owner of packages) {
        const local = localById.get(owner.ownerId);
        if (!local) continue;
        for (const pluginId of owner.pluginIds)
          localById.set(pluginId, this.projectPackageEntry(local, pluginId));
      }
      const managedIds = new Set(this.deps.getManagedPluginIds?.() ?? []);

      return result.plugins
        .filter(plugin => plugin.installed)
        .map(plugin => {
          const local = localById.get(plugin.id);
          const managed = managedIds.has(plugin.id);
          const bundledDirectory =
            plugin.origin === 'bundled'
              ? findBundledExtensionDirectory(manager, plugin.id)
              : undefined;
          const bundledConfiguration = bundledDirectory
            ? getExtensionConfigurationState(
                manager,
                plugin.id,
                readJsonRecord(path.join(bundledDirectory, OPENCLAW_PLUGIN_MANIFEST)),
              )
            : undefined;
          const description =
            normalizeMetadataText(plugin.description) ??
            normalizeMetadataText(local?.description) ??
            (bundledDirectory ? readExtensionDescriptionFromDirectory(bundledDirectory) : '');
          // Desired enablement is independent of registration/service health in
          // the observed Gateway generation. An unloaded entry alone is not a failure.
          const runtimeError =
            plugin.runtime?.error ||
            (plugin.runtime?.state === PLUGIN_RUNTIME_SERVICE_FAILED
              ? t('extensionRuntimeServiceFailed')
              : undefined);
          return {
            id: plugin.id,
            name: plugin.name || plugin.id,
            description,
            version: plugin.version ?? local?.version,
            installPath: local?.installPath ?? bundledDirectory,
            enabled: plugin.enabled,
            state: runtimeError
              ? ExtensionState.ERROR
              : plugin.state === 'not-installed'
                ? ExtensionState.DISABLED
                : plugin.state,
            origin: plugin.origin,
            category: plugin.category,
            kinds: plugin.kind ? [...plugin.kind] : undefined,
            error: plugin.error || runtimeError,
            removable: result.mutationAllowed && plugin.removable === true && !managed,
            canToggle: result.mutationAllowed && !managed,
            managed,
            missingRequirements:
              local?.missingRequirements ?? bundledConfiguration?.missingRequirements ?? [],
            configurationFields: local?.configurationFields ?? bundledConfiguration?.fields ?? [],
          } satisfies InstalledOpenClawExtension;
        })
        .sort((a, b) => a.name.localeCompare(b.name));
    };
  }

  async updateConfiguration(
    extensionId: string,
    values: Record<string, string>,
    onProgress?: OperationProgress,
  ): Promise<{ success: boolean; error?: string; pending?: boolean }> {
    onProgress?.(PluginOperationStage.QUEUED);
    return this.runMutationExclusive(() =>
      this.updateConfigurationExclusive(extensionId, values, onProgress),
    );
  }

  private async updateConfigurationExclusive(
    extensionId: string,
    values: Record<string, string>,
    onProgress?: OperationProgress,
  ): Promise<{ success: boolean; error?: string; pending?: boolean }> {
    onProgress?.(PluginOperationStage.VALIDATING);
    if (this.deps.getManagedPluginIds?.().includes(extensionId)) {
      return { success: false, error: 'Managed extensions cannot be reconfigured here.' };
    }
    const installed = await this.resolveInstalledExtension(extensionId);
    const manager = this.deps.getOpenClawEngineManager();
    const pluginDirectory =
      installed?.installPath ?? findBundledExtensionDirectory(manager, extensionId);
    if (!pluginDirectory) return { success: false, error: 'Extension is not installed.' };
    const manifestPath = findSupportedPluginManifestPath(pluginDirectory);
    const manifest = manifestPath ? readJsonRecord(manifestPath) : {};
    const fields = getExtensionConfigurationState(manager, extensionId, manifest).fields;
    const fieldsByPath = new Map<string, OpenClawExtensionConfigurationField>();
    for (const field of fields) {
      const paths = field.environmentVariables?.map(name => `env.vars.${name}`) ?? [field.path];
      for (const fieldPath of paths) fieldsByPath.set(fieldPath, field);
    }
    const updates = Object.entries(values).filter(
      ([configPath, value]) =>
        typeof value === 'string' &&
        isSafeConfigPath(configPath) &&
        fieldsByPath.has(configPath) &&
        ((fieldsByPath.get(configPath)?.type === 'string' &&
          !fieldsByPath.get(configPath)?.sensitive) ||
          value.trim().length > 0),
    );
    if (updates.length === 0) {
      return { success: false, error: 'Enter at least one supported configuration value.' };
    }
    for (const [fieldPath, value] of updates) {
      const field = fieldsByPath.get(fieldPath)!;
      if (
        field.type === 'string' &&
        !field.sensitive &&
        !isValidTextConfigurationValue(field, value)
      ) {
        return { success: false, error: t('extensionConfigurationTextInvalid') };
      }
      if (field.type === 'integer' || field.type === 'number') {
        const number = Number(value);
        if (
          !Number.isFinite(number) ||
          (field.type === 'integer' && !Number.isSafeInteger(number)) ||
          (field.minimum !== undefined && number < field.minimum) ||
          (field.maximum !== undefined && number > field.maximum)
        )
          return { success: false, error: t('extensionConfigurationNumberInvalid') };
      }
    }
    const numericOnly = updates.every(([fieldPath]) =>
      ['integer', 'number'].includes(fieldsByPath.get(fieldPath)?.type ?? ''),
    );
    const statusMethod =
      isRecord(manifest.configContracts) &&
      typeof manifest.configContracts.configurationStatusMethod === 'string' &&
      /^[a-zA-Z][a-zA-Z0-9_.-]{0,100}$/.test(manifest.configContracts.configurationStatusMethod)
        ? manifest.configContracts.configurationStatusMethod
        : undefined;
    const confirmNumeric = async (acknowledged: boolean): Promise<boolean> => {
      if (!statusMethod) return acknowledged;
      try {
        const reply = await this.deps.requestGateway?.<{
          ready?: boolean;
          configuration?: unknown;
        }>(statusMethod, {});
        return (
          reply?.ready === true &&
          isRecord(reply.configuration) &&
          updates.every(
            ([fieldPath, value]) =>
              getNestedValue(reply.configuration, fieldPath) === Number(value),
          )
        );
      } catch {
        return false;
      }
    };
    if (
      updates.some(([fieldPath]) => {
        const field = fieldsByPath.get(fieldPath);
        return (
          field?.environmentVariables &&
          field.inheritedEnvironmentVariables?.includes(fieldPath.slice('env.vars.'.length))
        );
      })
    ) {
      return { success: false, error: t('extensionCredentialInherited') };
    }

    const configPath = manager.getConfigPath();
    const temporaryPath = `${configPath}.tmp-extension-${Date.now()}`;
    let temporaryCreated = false;
    let initialPhase = manager.getStatus().phase;
    const wasRuntimeActive = initialPhase === 'running' || initialPhase === 'starting';
    try {
      if (initialPhase === 'starting') {
        initialPhase = (await manager.startGateway()).phase;
      }
      let config: Record<string, unknown> = {};
      if (fs.existsSync(configPath)) {
        const parsed = JSON5.parse(fs.readFileSync(configPath, 'utf8')) as unknown;
        if (!isRecord(parsed)) throw new Error('OpenClaw configuration is not an object.');
        config = parsed;
      }
      const previousConfig = JSON.stringify(config);
      const plugins = isRecord(config.plugins) ? config.plugins : {};
      const entries = isRecord(plugins.entries) ? plugins.entries : {};
      const entry = isRecord(entries[extensionId]) ? entries[extensionId] : {};
      const pluginConfig = isRecord(entry.config) ? entry.config : {};
      const secretValues = Object.fromEntries(
        updates.filter(
          ([fieldPath]) =>
            !fieldsByPath.get(fieldPath)?.environmentVariables &&
            isExtensionSecretReferenceField(manifest, fieldPath),
        ),
      );
      onProgress?.(PluginOperationStage.SAVING_CONFIGURATION);
      const secretUpdate = saveExtensionSecrets(
        config,
        manager.getStateDir(),
        extensionId,
        secretValues,
      );
      if (secretUpdate.changed && wasRuntimeActive) {
        this.pendingCredentialRefresh.add(extensionId);
      }
      const needsCredentialRefresh = this.pendingCredentialRefresh.has(extensionId);
      updates.forEach(([fieldPath, value]) => {
        const environmentVariables = fieldsByPath.get(fieldPath)?.environmentVariables;
        if (environmentVariables?.length) {
          const env = isRecord(config.env) ? config.env : {};
          const vars = isRecord(env.vars) ? env.vars : {};
          const name = fieldPath.slice('env.vars.'.length);
          vars[name] = value;
          if (typeof env[name] === 'string') delete env[name];
          env.vars = vars;
          config.env = env;
        } else {
          const field = fieldsByPath.get(fieldPath)!;
          if (field.type === 'string' && !field.sensitive && value === '') {
            deleteNestedValue(pluginConfig, fieldPath);
          } else {
            setNestedValue(
              pluginConfig,
              fieldPath,
              field.type === 'integer' || field.type === 'number'
                ? Number(value)
                : (secretUpdate.references[fieldPath] ?? value),
            );
          }
          entry.config = pluginConfig;
          entries[extensionId] = entry;
          plugins.entries = entries;
          config.plugins = plugins;
        }
      });

      if (
        JSON.stringify(config) === previousConfig &&
        !secretUpdate.changed &&
        !needsCredentialRefresh
      ) {
        if (numericOnly && this.pendingNumericRefresh.has(extensionId)) {
          const applied = initialPhase === 'running' && (await confirmNumeric(false));
          if (applied) this.pendingNumericRefresh.delete(extensionId);
          return { success: true, pending: !applied };
        }
        return { success: true };
      }
      const reloadGeneration =
        initialPhase === 'running' && !secretUpdate.changed && !needsCredentialRefresh
          ? manager.getGatewayConfigReloadGeneration()
          : null;

      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      fs.writeFileSync(temporaryPath, '', { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      temporaryCreated = true;
      restrictCredentialFile(temporaryPath);
      fs.writeFileSync(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
      fs.renameSync(temporaryPath, configPath);
      // Retain application state until the runtime acknowledges the persisted config.
      if (wasRuntimeActive && !numericOnly) this.pendingCredentialRefresh.add(extensionId);

      if (numericOnly) {
        onProgress?.(PluginOperationStage.CONFIRMING);
        this.pendingNumericRefresh.add(extensionId);
        let acknowledged = false;
        try {
          acknowledged =
            reloadGeneration !== null &&
            (await manager.waitForGatewayConfigReload(reloadGeneration));
        } catch {
          /* Saved; never restart long-running work for an acknowledgement failure. */
        }
        const applied = initialPhase === 'running' && (await confirmNumeric(acknowledged));
        if (applied) this.pendingNumericRefresh.delete(extensionId);
        return { success: true, pending: !applied };
      }

      if (wasRuntimeActive || needsCredentialRefresh) {
        onProgress?.(PluginOperationStage.APPLYING_CONFIGURATION);
        if (
          reloadGeneration !== null &&
          (await manager.waitForGatewayConfigReload(reloadGeneration))
        ) {
          this.pendingCredentialRefresh.delete(extensionId);
          return { success: true };
        }
        if (
          initialPhase === 'running' &&
          this.deps.requestGateway &&
          updates.every(([fieldPath]) => !fieldsByPath.get(fieldPath)?.environmentVariables)
        ) {
          if (Object.keys(secretValues).length > 0) {
            // Rotation can leave the SecretRef and config file unchanged. Refresh
            // native prepared secrets before reloading the capturing plugin.
            const refreshed = await this.deps.requestGateway<{ ok?: boolean }>(
              'secrets.reload',
              {},
            );
            if (refreshed.ok !== true) throw new Error(t('extensionCredentialRefreshUnconfirmed'));
          }
          if (await this.reloadPluginAfterCliMutation('plugins.reload', extensionId)) {
            this.pendingCredentialRefresh.delete(extensionId);
            return { success: true };
          }
        }
        onProgress?.(PluginOperationStage.RESTARTING_GATEWAY);
        const status = await this.restartGatewayAfterMutation('extension-config-change');
        if (status.phase !== 'running' && !status.deferred) {
          return {
            success: false,
            error:
              status.message ||
              'Extension configuration was saved, but the OpenClaw Gateway failed to restart.',
          };
        }
        this.pendingCredentialRefresh.clear();
      }
      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to update extension configuration',
      };
    } finally {
      try {
        if (temporaryCreated && fs.existsSync(temporaryPath))
          fs.rmSync(temporaryPath, { force: true });
      } catch {
        // Best-effort cleanup for an interrupted atomic write.
      }
    }
  }

  private async resolveRemovalTarget(extensionId: string) {
    const managedIds = this.deps.getManagedPluginIds?.() ?? [];
    if (managedIds.includes(extensionId)) throw new Error('Managed extensions cannot be deleted.');
    const local = this.listInstalled();
    const direct = local.find(entry => entry.id === extensionId);
    const packages = await this.readPackageOwnership(direct ? [direct] : local);
    const owners = packages.filter(owner =>
      owner.ownerId === extensionId || owner.pluginIds.includes(extensionId));
    if (owners.length > 1) throw new Error(t('extensionPackageOwnershipUnconfirmed'));
    const owner = owners[0];
    const installed = direct ?? (owner && local.find(entry =>
      entry.id === owner.ownerId && sameInstallPath(entry.installPath, owner.installPath)));
    const nativePluginIds = [...new Set([
      extensionId,
      ...(installed ? [installed.id] : []),
      ...(owner ? [owner.ownerId, ...owner.pluginIds] : []),
    ])];
    if (nativePluginIds.some(id => managedIds.includes(id)))
      throw new Error('Managed extensions cannot be deleted.');
    return { installed, owner, nativePluginIds };
  }

  /** Read package-owned data without starting Gateway or executing plugin code. */
  async getDataInfo(extensionId: string): Promise<ExtensionDataInfoResult> {
    try {
      const { installed, owner, nativePluginIds } = await this.resolveRemovalTarget(extensionId);
      if (!installed && !owner) throw new Error(t('extensionPackageOwnershipUnconfirmed'));
      const info = await (this.deps.pluginData?.inspect ?? inspectPluginData)(
        this.deps.getOpenClawEngineManager().getStateDir(), nativePluginIds,
      );
      return {
        success: true, exists: info.exists, bytes: info.bytes, canDelete: info.canDelete,
        ...(info.retained ? { retained: true as const } : {}),
        ...(info.reason ? { error: sanitizeInstallationFailureReason(info.reason) } : {}),
      };
    } catch (error) {
      return {
        success: false,
        error: sanitizeInstallationFailureReason(error instanceof Error ? error.message : error) ??
          t('extensionDataInspectionFailed'),
      };
    }
  }

  async delete(
    extensionId: string,
    onProgress?: OperationProgress,
    applyPackageMutation?: ApplyExtensionPackageMutation,
    options: { deleteData?: boolean } = {},
  ): Promise<ExtensionDeleteResult> {
    onProgress?.(PluginOperationStage.QUEUED);
    return this.runMutationExclusive(async () => {
      onProgress?.(PluginOperationStage.VALIDATING);
      // Resolve package ownership after earlier extension mutations complete.
      // A child entry removes its entire package, including any App companion.
      let target: Awaited<ReturnType<OpenClawExtensionImportService['resolveRemovalTarget']>>;
      try { target = await this.resolveRemovalTarget(extensionId); }
      catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) };
      }
      const { installed, owner, nativePluginIds } = target;
      if (options.deleteData && (!applyPackageMutation || (!installed && !owner)))
        return { success: false, error: t('extensionDataRemovalUnavailable') };
      let mode: ExtensionPackageLifecycleMode = ExtensionPackageLifecycleMode.HOT;
      return removeExtensionPackage(
        () => this.runConfigMutationExclusive(async () => {
          if (options.deleteData && mode !== ExtensionPackageLifecycleMode.STOPPED)
            return { success: false, error: t('extensionDataRemovalUnavailable') };
          // Freeze all package-owned paths only after Main drained and Native stopped.
          // Unsafe or changed data prevents admission before uninstall is sent.
          const removal = options.deleteData
            ? await (this.deps.pluginData?.prepareRemoval ?? preparePluginDataRemoval)(
                this.deps.getOpenClawEngineManager().getStateDir(), nativePluginIds,
              )
            : undefined;
          const result = await this.deleteExclusive(
            extensionId, onProgress, installed, mode, !!applyPackageMutation,
          );
          if (!removal || !result.success || result.operationUnconfirmed) return result;
          onProgress?.(PluginOperationStage.CLEANING_UP);
          try {
            await (this.deps.pluginData?.remove ?? removePluginData)(removal);
            return result;
          } catch (error) {
            const detail = sanitizeInstallationFailureReason(
              error instanceof Error ? error.message : error, [], { preserveLocalPaths: true },
            );
            return {
              ...result,
              refreshWarning: true as const,
              failedStage: result.failedStage ?? PluginOperationStage.CLEANING_UP,
              error: [result.error, t('extensionDataRemovalFailed'), detail].filter(Boolean).join('\n'),
            };
          }
        }),
        applyPackageMutation
          ? operation => applyPackageMutation({
              nativePluginIds,
              ...(options.deleteData ? { requireStopped: true as const } : {}),
              ...(owner?.installPath || installed?.installPath
                ? { installPath: owner?.installPath ?? installed?.installPath }
                : {}),
            }, selectedMode => {
              mode = selectedMode;
              return operation();
            })
          : undefined,
      );
    }, false);
  }

  private async deleteExclusive(
    extensionId: string,
    reportProgress?: OperationProgress,
    installedBeforeGateway?: InstalledOpenClawExtension,
    mode: ExtensionPackageLifecycleMode = ExtensionPackageLifecycleMode.HOT,
    routed = false,
  ): Promise<ExtensionDeleteResult> {
    let currentStage: PluginOperationStage = PluginOperationStage.VALIDATING;
    const onProgress: OperationProgress = stage => {
      currentStage = stage;
      reportProgress?.(stage);
    };
    onProgress(PluginOperationStage.VALIDATING);
    if (this.deps.getManagedPluginIds?.().includes(extensionId)) {
      return { success: false, error: 'Managed extensions cannot be deleted.' };
    }
    const manager = this.deps.getOpenClawEngineManager();
    const initialPhase = manager.getStatus().phase;
    const wasRuntimeActive = initialPhase === 'running' || initialPhase === 'starting';
    const requestGateway = mode === ExtensionPackageLifecycleMode.STOPPED
      ? undefined
      : this.deps.getConnectedGatewayClient
        ? this.captureConnectedGatewayRequest()
        : routed ? undefined : this.deps.requestGateway;
    if (routed && mode === ExtensionPackageLifecycleMode.HOT && !requestGateway)
      return { success: false, error: t('extensionHotToggleUnavailable') };
    if (mode === ExtensionPackageLifecycleMode.STOPPED && !manager.isGatewayMutationInProgress?.())
      return { success: false, error: 'The stopped Gateway package mutation lease is unavailable.' };
    const gatewayClient = this.deps.getConnectedGatewayClient?.();
    const gatewayProcessId = manager.getGatewayProcessId?.();
    const gatewayGeneration = manager.getGatewayProcessGeneration?.();
    const ownsGateway = (): boolean =>
      !this.deps.getConnectedGatewayClient ||
        (manager === this.deps.getOpenClawEngineManager() &&
          gatewayClient === this.deps.getConnectedGatewayClient() &&
          gatewayProcessId === manager.getGatewayProcessId?.() &&
          gatewayGeneration === manager.getGatewayProcessGeneration?.());
    const policyDigestBefore = this.deps.outboundHeaderPolicy?.reconcile().digest;
    type FollowupFailure = { error: string; failedStage: PluginOperationStage };
    let removalConfirmed = false;
    const completedRemoval = (
      failure?: FollowupFailure,
      warnings?: string[],
    ): ExtensionDeleteResult => ({
      success: true,
      ...(warnings ? { warnings } : {}),
      ...(failure
        ? {
            refreshWarning: true,
            failedStage: failure.failedStage,
            error: `${t(
              failure.failedStage === PluginOperationStage.APPLYING_CONFIGURATION
                ? 'extensionRemovalPolicyCleanupFailed'
                : failure.failedStage === PluginOperationStage.SAVING_CONFIGURATION
                  ? 'extensionRemovalAllowlistCleanupFailed'
                  : failure.failedStage === PluginOperationStage.CONFIRMING
                    ? 'extensionRemovalCommandCleanupFailed'
                  : 'extensionRemovalSavedRecoveryFailed',
            )}\n${failure.error}`,
          }
        : {}),
    });
    const convergePolicy = async (
      forceRestart = false,
      allowNativeRefresh = false,
    ): Promise<FollowupFailure | undefined> => {
      let failedStage: PluginOperationStage = PluginOperationStage.APPLYING_CONFIGURATION;
      try {
        if (this.deps.outboundHeaderPolicy) onProgress(failedStage);
        const policyDigestAfter = this.deps.outboundHeaderPolicy?.reconcile().digest;
        if (manager.isGatewayMutationInProgress?.()) return undefined;
        if (!forceRestart && (!wasRuntimeActive || policyDigestAfter === policyDigestBefore)) {
          return undefined;
        }
        if (!ownsGateway()) throw new Error('The OpenClaw Gateway changed during extension removal.');
        let nativeRestartRequired = forceRestart &&
          (allowNativeRefresh || policyDigestAfter === policyDigestBefore);
        if (forceRestart && allowNativeRefresh && requestGateway &&
            manager.getStatus().phase === 'running') {
          onProgress(failedStage);
          try {
            const refreshed = await this.requestPluginMutation<{
              ok?: boolean;
              restartRequired?: boolean;
            }>('plugins.refresh', {}, undefined, undefined, requestGateway);
            nativeRestartRequired = refreshed?.ok !== true || refreshed.restartRequired !== false;
          } catch {
            // The confirmed uninstall still owns its required runtime recovery.
            // Never repeat the uninstall when refresh cannot be confirmed.
          }
        }
        if (!nativeRestartRequired &&
            (!wasRuntimeActive || policyDigestAfter === policyDigestBefore)) return undefined;
        if (!ownsGateway()) throw new Error('The OpenClaw Gateway changed during extension removal.');
        failedStage = PluginOperationStage.RESTARTING_GATEWAY;
        onProgress(failedStage);
        const status = await this.restartGatewayAfterMutation(
          nativeRestartRequired ? 'extension-delete' : 'extension-network-policy-change',
          nativeRestartRequired && policyDigestAfter !== policyDigestBefore
            ? { networkPolicyChanged: true } : undefined,
        );
        return status.phase === 'running' || status.deferred
          ? undefined
          : {
              failedStage,
              error: status.message ||
                'Extension state changed, but the OpenClaw Gateway failed to restart.',
            };
      } catch (error) {
        return {
          failedStage,
          error: error instanceof Error
            ? error.message
            : 'Extension state changed, but the OpenClaw Gateway failed to restart.',
        };
      }
    };
    // The local queue captured the exact path before lifecycle selection. A failed
    // recursive removal may erase its manifest; never guess a new target afterwards.
    let gatewayMutationError: unknown;
    // Package mutations deliberately hold the Gateway stopped. Dispatching an
    // RPC here would attempt startup under that lease and fail before uninstall.
    // No request has been sent, so use the native offline CLI once; the package
    // mutation owner alone restores the Gateway after releasing the lease.
    if (requestGateway && !manager.isGatewayMutationInProgress?.()) {
      try {
        onProgress?.(PluginOperationStage.UNINSTALLING);
        const result = await this.requestPluginMutation<{
          ok: true;
          restartRequired: boolean;
          warnings?: string[];
        }>('plugins.uninstall', { pluginId: extensionId }, undefined, {
          onAdmissionWait: () => onProgress?.(PluginOperationStage.QUEUED),
          onAdmissionResume: () => onProgress?.(PluginOperationStage.UNINSTALLING),
        }, requestGateway);
        if (result?.ok !== true || typeof result.restartRequired !== 'boolean') {
          onProgress(PluginOperationStage.CONFIRMING);
          return {
            success: false,
            operationUnconfirmed: true,
            failedStage: PluginOperationStage.CONFIRMING,
            error: t('extensionUninstallReceiptInvalid'),
          };
        }
        removalConfirmed = true;
        return completedRemoval(await convergePolicy(result.restartRequired, true), result.warnings);
      } catch (error) {
        const failedStage = currentStage;
        if (removalConfirmed) {
          return completedRemoval({
            failedStage,
            error: error instanceof Error ? error.message : t('extensionRemovalConfirmationFailed'),
          });
        }
        gatewayMutationError = error;
        if (
          isDirectoryLockError(error) &&
          (!isGatewayUnavailableError(error) || (isRecord(error) && 'gatewayCode' in error))
        ) {
          let gatewayReportsInstalled: boolean | undefined;
          try {
            onProgress?.(PluginOperationStage.CONFIRMING);
            const catalog = await requestGateway<{
              plugins: Array<{ id: string; installed: boolean }>;
            }>('plugins.list', {});
            gatewayReportsInstalled = catalog.plugins.some(
              plugin => plugin.id === extensionId && plugin.installed,
            );
          } catch {
            // A failed confirmation never permits replaying a destructive command.
          }
          if (
            gatewayReportsInstalled === false &&
            installedBeforeGateway && !fs.existsSync(installedBeforeGateway.installPath)
          ) {
            // The uninstall committed and only its response was lost. Do not
            // repeat the destructive mutation; only converge the live runtime.
            return completedRemoval(await convergePolicy(true, true));
          }
          return {
            success: false,
            failedStage,
            error: readNativePluginBusyMessage(error) ??
              (error instanceof Error ? error.message : 'Failed to delete plugin'),
          };
        } else if (isGatewayUnavailableError(error) && isGatewayMutationNotSent(error)) {
          if (routed) return {
            success: false,
            failedStage,
            error: t('extensionHotToggleUnavailable'),
          };
          // Offline recovery is safe only with evidence that this mutation was
          // not dispatched. A timeout or closed socket may leave it in progress.
        } else if (
          isGatewayUnavailableError(error) &&
          (!isRecord(error) || !('gatewayCode' in error))
        ) {
          let absentFromInventory = false;
          try {
            onProgress?.(PluginOperationStage.CONFIRMING);
            const catalog = await requestGateway<{
              plugins: Array<{ id: string; installed: boolean }>;
            }>('plugins.list', {});
            absentFromInventory = !catalog.plugins.some(
              plugin => plugin.id === extensionId && plugin.installed,
            );
          } catch {
            // Transport failure cannot be turned into a removal receipt.
          }
          if (
            absentFromInventory &&
            installedBeforeGateway &&
            !fs.existsSync(installedBeforeGateway.installPath)
          ) {
            return completedRemoval(await convergePolicy(true, true));
          }
          return {
            success: false,
            error: t('extensionUninstallUnconfirmed'),
            operationUnconfirmed: true,
          };
        } else {
          const convergenceError = await convergePolicy();
          return {
            success: false,
            failedStage,
            error: appendRecoveryFailure(
              readNativePluginBusyMessage(error) ??
              (error instanceof Error ? error.message : 'Failed to delete plugin'),
              convergenceError?.error,
            ),
          };
        }
      }
    }
    const gatewayMayNeedRestore =
      wasRuntimeActive && !!gatewayMutationError && isGatewayUnavailableError(gatewayMutationError);
    const installed = installedBeforeGateway;
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
      onProgress(PluginOperationStage.PREPARING_RUNTIME);
      const cli = await manager.buildCliEnvironment();
      let allowlistError = '';
      const command = await this.runDirectoryCommand(installed.installPath, async () => {
        onProgress?.(PluginOperationStage.UNINSTALLING);
        const result = await this.runCommand(
          requireOpenClawCliExecutable(cli.env),
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
        if (result.exitCode === 0 && !fs.existsSync(installed.installPath)) {
          removalConfirmed = true;
          try {
            onProgress(PluginOperationStage.SAVING_CONFIGURATION);
            updateExtensionAllowlist(manager.getConfigPath(), extensionId, 'remove');
          } catch (error) {
            allowlistError = error instanceof Error ? error.message : String(error);
          }
        }
        return result;
      });
      const result = command.result;
      if (result.exitCode !== 0) {
        const failedStage = currentStage;
        const error = command.error ?? formatCommandError(result);
        console.error('[OpenClawExtensionImportService] OpenClaw uninstaller failed:', error);
        const convergenceError = await convergePolicy(gatewayMayNeedRestore);
        if (result.nativeReceiptObserved && !fs.existsSync(installed.installPath)) {
          return completedRemoval({
            failedStage: PluginOperationStage.CONFIRMING,
            error: appendRecoveryFailure(error, convergenceError?.error),
          });
        }
        return {
          success: false,
          failedStage,
          ...(result.timedOut ? { operationUnconfirmed: true as const } : {}),
          error: appendRecoveryFailure(error, convergenceError?.error),
        };
      }

      if (fs.existsSync(installed.installPath)) {
        const convergenceError = await convergePolicy(gatewayMayNeedRestore);
        return {
          success: false,
          failedStage: PluginOperationStage.UNINSTALLING,
          error: appendRecoveryFailure(
            'OpenClaw reported success, but the extension is still installed.',
            convergenceError?.error,
          ),
        };
      }

      const convergenceError = await convergePolicy(
        wasRuntimeActive && !command.runtimeRestarted,
        wasRuntimeActive && !command.runtimeRestarted,
      );
      if (allowlistError) {
        return completedRemoval({
          failedStage: PluginOperationStage.SAVING_CONFIGURATION,
          error: appendRecoveryFailure(allowlistError, convergenceError?.error),
        });
      }
      return completedRemoval(convergenceError);
    } catch (error) {
      const failedStage = currentStage;
      const convergenceError = await convergePolicy(gatewayMayNeedRestore);
      const failure = {
        error: appendRecoveryFailure(
          error instanceof Error ? error.message : 'Failed to delete extension',
          convergenceError?.error,
        ),
        failedStage,
      };
      return removalConfirmed ? completedRemoval(failure) : { success: false, ...failure };
    }
  }

  async setEnabled(
    extensionId: string,
    enabled: boolean,
    reviewToken?: string,
    onProgress?: OperationProgress,
  ): Promise<ExtensionSetEnabledResult> {
    onProgress?.(PluginOperationStage.QUEUED);
    return this.runMutationExclusive(() =>
      this.setEnabledExclusive(extensionId, enabled, reviewToken, onProgress),
    );
  }

  private async readToggleState(extensionId: string): Promise<boolean | undefined> {
    const installed = await this.resolveInstalledExtension(extensionId);
    if (installed) return installed.enabled;
    const manager = this.deps.getOpenClawEngineManager();
    const bundled = findBundledExtensionDirectory(manager, extensionId);
    return bundled && readExtensionId(bundled) === extensionId
      ? isExtensionEnabled(manager, extensionId)
      : undefined;
  }

  private async setEnabledExclusive(
    extensionId: string,
    enabled: boolean,
    reviewToken?: string,
    reportProgress?: OperationProgress,
    options?: {
      stoppedPackageInstall?: true;
      connectedGatewayRequest?: NonNullable<OpenClawExtensionImportServiceDeps['requestGateway']>;
      deferRuntimeConvergence?: (receipt: { restartRequired: boolean }) => void;
    },
  ): Promise<ExtensionSetEnabledResult> {
    let currentStage: PluginOperationStage = PluginOperationStage.VALIDATING;
    const onProgress: OperationProgress = stage => {
      currentStage = stage;
      reportProgress?.(stage);
    };
    onProgress?.(PluginOperationStage.VALIDATING);
    if (this.deps.getManagedPluginIds?.().includes(extensionId)) {
      return { success: false, error: 'Managed extensions cannot be changed here.' };
    }
    const manager = this.deps.getOpenClawEngineManager();
    const stoppedPackageInstall = options?.stoppedPackageInstall === true &&
      manager.isGatewayMutationInProgress?.() === true;
    // Only the private activation after a verified plain-package install may use
    // this stopped lease. Public app-companion toggles remain hot-only.
    const hotToggle = !stoppedPackageInstall && this.deps.requiresHotToggle?.(extensionId) === true;
    const requestGateway = hotToggle
      ? this.captureConnectedGatewayRequest()
      : stoppedPackageInstall ? undefined
        : options?.connectedGatewayRequest ?? this.deps.requestGateway;
    if (hotToggle && !requestGateway)
      return { success: false, error: t('extensionHotToggleUnavailable') };
    const initialPhase = manager.getStatus().phase;
    const wasRuntimeActive = initialPhase === 'running' || initialPhase === 'starting';
    const nativeSkills = this.deps.getNativeSkillIds?.(extensionId) ?? [];
    const policyDigestBefore = this.deps.outboundHeaderPolicy?.reconcile().digest;
    let gatewayMayNeedRestore = false;
    const convergeColdState = async (
      forceRestart = false,
      nativeMutationConfirmed = false,
    ): Promise<string | undefined> => {
      try {
        const policyDigestAfter = this.deps.outboundHeaderPolicy?.reconcile().digest;
        if (!wasRuntimeActive || (!forceRestart && policyDigestAfter === policyDigestBefore)) {
          return undefined;
        }
        let nativeRestartRequired = forceRestart &&
          (nativeMutationConfirmed || policyDigestAfter === policyDigestBefore);
        if (nativeRestartRequired) {
          onProgress?.(PluginOperationStage.APPLYING_CONFIGURATION);
          if (await this.reloadPluginAfterCliMutation('plugins.refresh')) nativeRestartRequired = false;
        }
        if (!nativeRestartRequired && policyDigestAfter === policyDigestBefore) return undefined;
        onProgress?.(PluginOperationStage.RESTARTING_GATEWAY);
        const status = await this.restartGatewayAfterMutation(
          nativeRestartRequired ? 'extension-status-change' : 'extension-network-policy-change',
          nativeRestartRequired && policyDigestAfter !== policyDigestBefore
            ? { networkPolicyChanged: true } : undefined,
        );
        return status.phase === 'running' || status.deferred
          ? undefined
          : status.message ||
              'Extension status changed, but the OpenClaw Gateway failed to restart.';
      } catch (error) {
        return error instanceof Error
          ? error.message
          : 'Extension status changed, but the OpenClaw Gateway failed to restart.';
      }
    };
    if (requestGateway) {
      try {
        onProgress?.(enabled ? PluginOperationStage.ENABLING : PluginOperationStage.DISABLING);
        const result = await this.requestPluginMutation<{
          ok: true;
          restartRequired: boolean;
          warnings?: string[];
        }>(
          'plugins.setEnabled',
          {
            pluginId: extensionId,
            enabled,
            ...(reviewToken ? { acknowledgeCapabilities: { reviewToken } } : {}),
          },
          undefined,
          {
            onAdmissionWait: () => onProgress?.(PluginOperationStage.QUEUED),
            onAdmissionResume: () =>
              onProgress?.(
                enabled ? PluginOperationStage.ENABLING : PluginOperationStage.DISABLING,
              ),
          },
          requestGateway,
        );
        if (hotToggle && result.restartRequired)
          return { success: false, error: t('extensionHotToggleRestartRequired') };
        if (options?.deferRuntimeConvergence) {
          if (result?.ok !== true || typeof result.restartRequired !== 'boolean')
            return {
              success: false, operationUnconfirmed: true, error: t('extensionToggleUnconfirmed'),
            };
          options.deferRuntimeConvergence({ restartRequired: result.restartRequired });
        }
        let skillSyncError: string | undefined;
        if ((this.deps.getNativeSkillIds?.(extensionId)?.length ?? 0) > 0) {
          // A skills.* mutation invalidates persisted session skill snapshots even
          // when native filesystem watching is disabled. The extension owns this skill.
          try {
            await this.syncExtensionSkills(extensionId, enabled, true, requestGateway);
            if (hotToggle) await this.waitForHotSkillApplication(nativeSkills, enabled, requestGateway);
          } catch {
            skillSyncError = t('extensionSkillSyncFailed');
          }
        }
        const policyDigestAfter = this.deps.outboundHeaderPolicy?.reconcile().digest;
        if (hotToggle && policyDigestAfter !== policyDigestBefore &&
            !manager.canReuseGatewayNetworkEnvironment?.())
          return { success: false, error: t('extensionHotToggleRestartRequired') };
        if (!hotToggle && !options?.deferRuntimeConvergence && (
          result.restartRequired ||
          policyDigestAfter !== policyDigestBefore
        )) {
          onProgress?.(PluginOperationStage.RESTARTING_GATEWAY);
          const status = await this.restartGatewayAfterMutation(
            result.restartRequired ? 'extension-status-change' : 'extension-network-policy-change',
            result.restartRequired && policyDigestAfter !== policyDigestBefore
              ? { networkPolicyChanged: true } : undefined,
          );
          if (status.phase !== 'running' && !status.deferred) {
            return {
              success: false,
              error:
                status.message ||
                'Plugin status changed, but the OpenClaw Gateway failed to restart.',
            };
          }
        }
        return skillSyncError
          ? { success: false, error: skillSyncError }
          : { success: true, warnings: result.warnings };
      } catch (error) {
        if (isGatewayUnavailableError(error)) {
          if (isRecord(error) && 'gatewayCode' in error)
            return {
              success: false,
              error: error instanceof Error ? error.message : 'Failed to update plugin status',
            };
          if (!isGatewayMutationNotSent(error))
            return {
              success: false,
              error: error instanceof Error ? error.message : t('extensionToggleUnconfirmed'),
              operationUnconfirmed: true,
            };
          if (hotToggle || options?.connectedGatewayRequest)
            return { success: false, error: t('extensionHotToggleUnavailable') };
          // Only proof that dispatch never started permits the offline mutation.
          gatewayMayNeedRestore = wasRuntimeActive;
        } else {
          const consent = enabled ? readCapabilityConsentDetails(error) : null;
          if (consent) {
            try {
              const inspected = await requestGateway<{
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
            error:
              readNativePluginBusyMessage(error) ??
              (error instanceof Error ? error.message : 'Failed to update plugin status'),
          };
        }
      }
    }
    const previous = await this.readToggleState(extensionId);
    if (previous === undefined) return { success: false, error: 'Extension is not installed.' };
    if (previous === enabled) {
      if ((this.deps.getNativeSkillIds?.(extensionId)?.length ?? 0) > 0) {
        try {
          await this.syncExtensionSkills(extensionId, enabled, false);
        } catch {
          return { success: false, error: t('extensionSkillSyncFailed') };
        }
      }
      const convergenceError = await convergeColdState(gatewayMayNeedRestore);
      return convergenceError ? { success: false, error: convergenceError } : { success: true };
    }
    try {
      onProgress(PluginOperationStage.PREPARING_RUNTIME);
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
      onProgress?.(enabled ? PluginOperationStage.ENABLING : PluginOperationStage.DISABLING);
      const result = await this.runCommand(
        requireOpenClawCliExecutable(cli.env),
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
        const convergenceError = await convergeColdState(gatewayMayNeedRestore);
        return {
          success: false,
          failedStage: enabled ? PluginOperationStage.ENABLING : PluginOperationStage.DISABLING,
          ...(result.timedOut ? { operationUnconfirmed: true as const } : {}),
          error: appendRecoveryFailure(error, convergenceError),
        };
      }

      onProgress?.(PluginOperationStage.CONFIRMING);
      const updated = await this.readToggleState(extensionId);
      if (updated !== enabled) {
        const convergenceError = await convergeColdState(gatewayMayNeedRestore);
        return {
          success: false,
          failedStage: PluginOperationStage.CONFIRMING,
          error: appendRecoveryFailure(
            `OpenClaw did not ${enabled ? 'enable' : 'disable'} the extension. Check the global plugin policy, allowlist, and denylist.`,
            convergenceError,
          ),
        };
      }

      if (nativeSkills.length > 0) await this.syncExtensionSkills(extensionId, enabled, false);
      const convergenceError = await convergeColdState(wasRuntimeActive, true);
      return convergenceError ? { success: false, error: convergenceError } : { success: true };
    } catch (error) {
      const failedStage = currentStage;
      const convergenceError = await convergeColdState(gatewayMayNeedRestore);
      return {
        success: false,
        failedStage,
        error: appendRecoveryFailure(
          error instanceof Error ? error.message : 'Failed to update extension status',
          convergenceError,
        ),
      };
    }
  }

  async importPath(
    sourcePath: string,
    onProgress?: (progress: ExtensionInstallProgress) => void,
    reviewToken?: string,
    options?: ExtensionImportOptions,
  ): Promise<CommittedExtensionImportResult> {
    options?.onOperationProgress?.(PluginOperationStage.QUEUED);
    return this.runMutationExclusive(() =>
      this.importPathExclusive(sourcePath, onProgress, reviewToken, options),
      !options?.applyPackageMutation,
    );
  }

  private async importPathExclusive(
    sourcePath: string,
    onProgress?: (progress: ExtensionInstallProgress) => void,
    reviewToken?: string,
    options?: ExtensionImportOptions,
  ): Promise<CommittedExtensionImportResult> {
    let temporaryDirectory: string | null = null;
    let cleanupInstallSource: (() => Promise<void>) | undefined;
    let cleanupArchiveSource: (() => Promise<void>) | undefined;
    let frozenArchivePath: string | undefined;
    let installSourceInFlight = false;
    let retainedInstallSourcePath: string | undefined;
    let extensionId: string | undefined;
    let installationAttempted = false;
    let installationCommitted = false;
    let installationPath: string | undefined;
    let rejectedCapabilityReview: OpenClawPluginCapabilityReview | undefined;
    let currentStage: ExtensionImportStage = 'preparing';
    let currentOperationStage: PluginOperationStage | undefined;
    const reportOperationProgress = (stage: PluginOperationStage): void => {
      currentOperationStage = stage;
      options?.onOperationProgress?.(stage);
    };
    const committedOperationFailure = (): Pick<
      CommittedExtensionImportResult,
      'operationFailedStage'
    > =>
      installationCommitted &&
      currentOperationStage &&
      currentOperationStage !== toPluginOperationStage(currentStage)
        ? { operationFailedStage: currentOperationStage }
        : {};
    const reportProgress = (stage: ExtensionImportStage, percent: number): void => {
      currentStage = stage;
      currentOperationStage = toPluginOperationStage(stage) ?? currentOperationStage;
      onProgress?.({ stage, percent });
    };
    const failedImport = (error: unknown): CommittedExtensionImportResult => ({
      success: false,
      ...(installationAttempted ? { extensionId } : {}),
      ...(installationCommitted ? { installationCommitted: true as const } : {}),
      ...(installationPath ? { installPath: installationPath } : {}),
      ...(installSourceInFlight ? { installSourceInUse: true as const } : {}),
      ...(rejectedCapabilityReview ? { capabilityReview: rejectedCapabilityReview } : {}),
      error:
        readNativePluginBusyMessage(error) ??
        (error instanceof Error ? error.message : 'Failed to import extension'),
      failedStage: currentStage,
      ...committedOperationFailure(),
    });
    try {
      reportProgress('preparing', 5);
      const normalizedSourcePath = path.resolve(sourcePath);
      const stats = fs.statSync(normalizedSourcePath);
      let pluginDirectory: string;

      if (stats.isDirectory()) {
        reportProgress('validating', 25);
        pluginDirectory = normalizedSourcePath;
      } else if (stats.isFile() && isSupportedArchive(normalizedSourcePath)) {
        reportProgress('extracting', 15);
        if (options?.applyPackageMutation) {
          const archive = await prepareExtensionInstallArchive(normalizedSourcePath);
          frozenArchivePath = archive.file;
          cleanupArchiveSource = archive.cleanup;
        }
        const archivePath = frozenArchivePath ?? normalizedSourcePath;
        temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-extension-import-'));
        const lowerPath = archivePath.toLowerCase();
        if (lowerPath.endsWith('.zip')) {
          await extractZipSafely(archivePath, temporaryDirectory);
        } else {
          await tar.extract({
            file: archivePath,
            cwd: temporaryDirectory,
            preservePaths: false,
            strict: true,
          });
        }
        assertNoSymbolicLinks(temporaryDirectory);
        reportProgress('validating', 25);
        pluginDirectory = resolveExtractedPluginDirectory(temporaryDirectory);
      } else {
        return {
          success: false,
          error:
            'Select an OpenClaw extension folder or a supported archive (.zip, .tar, .tar.gz, .tgz).',
          failedStage: currentStage,
        };
      }

      const prepared = await prepareExtensionForInstall({
        sourcePath: frozenArchivePath ?? normalizedSourcePath,
        pluginDirectory,
      });
      pluginDirectory = prepared.pluginDirectory;
      extensionId = validateNativePluginDirectory(pluginDirectory);
      this.deps.outboundHeaderPolicy?.inspectExtension(pluginDirectory);

      reportProgress('preparing_runtime', 35);
      const manager = this.deps.getOpenClawEngineManager();
      const cli = await manager.buildCliEnvironment();
      let installSourcePath = prepared.sourcePath;
      if (stats.isDirectory() || options?.applyPackageMutation) {
        const installSource = await prepareExtensionInstallSource(pluginDirectory, cli.runtimeRoot,
          options?.applyPackageMutation ? {
            snapshot: true,
            ...(temporaryDirectory ? { reuseOwnedDirectory: true } : {}),
          } : undefined);
        cleanupInstallSource = installSource.cleanup;
        if (installSource.directory !== pluginDirectory || options?.applyPackageMutation) {
          pluginDirectory = installSource.directory;
          installSourcePath = frozenArchivePath ?? installSource.directory;
          retainedInstallSourcePath = installSourcePath;
          extensionId = validateNativePluginDirectory(pluginDirectory);
          this.deps.outboundHeaderPolicy?.inspectExtension(pluginDirectory);
        }
      }
      // Discovery can name a multi-entry package's children differently from
      // its on-disk manifest owner. Keep the exact owner for directory checks.
      const installOwnerId = extensionId;
      const multipleRuntimeEntries = hasMultipleRuntimeEntries(pluginDirectory);
      if (
        this.deps.requestGateway && !options?.trustMarketplaceSource &&
        !options?.autoAcceptCapabilities
      ) {
        const inspected = await this.inspectCapabilityReview({
          cli,
          pluginDirectory,
          sourcePath: installSourcePath,
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
      let artifactPluginIds = extensionId ? [extensionId] : [];
      if (
        multipleRuntimeEntries &&
        (!this.deps.requestGateway || options?.trustMarketplaceSource || options?.autoAcceptCapabilities)
      ) {
        artifactPluginIds = await readExtensionArtifactPluginIds(manager, pluginDirectory);
        extensionId = artifactPluginIds[0];
      }
      const appCompanion = fs.existsSync(path.join(pluginDirectory, 'app', 'app.artifact.json'));
      const installArgs = [
        cli.openclawEntry,
        'plugins',
        'install',
        installSourcePath,
        '--force',
        ...(options?.preserveActivation || appCompanion ? ['--no-enable'] : []),
        ...(options?.autoAcceptCapabilities || this.deps.requestGateway || options?.trustMarketplaceSource
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
      const stateDir =
        typeof cli.env.OPENCLAW_STATE_DIR === 'string' && cli.env.OPENCLAW_STATE_DIR
          ? cli.env.OPENCLAW_STATE_DIR
          : typeof manager.getStateDir === 'function'
            ? manager.getStateDir()
            : manager.getBaseDir();
      const extensionsRoot = path.join(stateDir, 'extensions');
      const installedPath = installOwnerId
        ? findInstalledExtensionPath(extensionsRoot, installOwnerId)
        : undefined;
      const defaultTargetPath = installOwnerId
        ? path.join(extensionsRoot, installOwnerId)
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
      const performInstall = async (
        mode: ExtensionPackageLifecycleMode,
      ): Promise<CommittedExtensionImportResult> => {
        try {
          const stopped = manager.isGatewayMutationInProgress?.() === true;
          const hotRequest = options?.applyPackageMutation && mode === ExtensionPackageLifecycleMode.HOT
            ? this.captureConnectedGatewayRequest() : undefined;
          if (options?.autoAcceptCapabilities && !stopped && !hotRequest)
            throw new Error(t('extensionInstallMutationUnavailable'));
          if (options?.applyPackageMutation &&
              ((mode === ExtensionPackageLifecycleMode.STOPPED && !stopped) ||
               (mode === ExtensionPackageLifecycleMode.HOT && (!hotRequest || appCompanion))))
            throw new Error(t('extensionInstallMutationUnavailable'));
          const requestGateway = options?.applyPackageMutation
            ? hotRequest
            : !stopped && !options?.trustMarketplaceSource && reviewToken && !options?.autoAcceptCapabilities
              ? this.deps.requestGateway : undefined;
          const initialPhase = manager.getStatus().phase;
          const wasRuntimeActive = initialPhase === 'running' || initialPhase === 'starting';
          const networkPolicyDigestBeforeInstall = this.deps.outboundHeaderPolicy?.reconcile().digest;
          const convergeNetworkPolicyFailClosed = async (): Promise<void> => {
            if (!this.deps.outboundHeaderPolicy) return;
            const snapshot = this.deps.outboundHeaderPolicy.reconcile();
            const phase = manager.getStatus().phase;
            if (
              (wasRuntimeActive || phase === 'running' || phase === 'starting') &&
              snapshot.digest !== networkPolicyDigestBeforeInstall
            ) {
              reportOperationProgress(PluginOperationStage.RESTARTING_GATEWAY);
              const status = await this.restartGatewayAfterMutation('extension-network-policy-change');
              if (status.phase !== 'running' && !status.deferred) {
                throw new Error(
                  status.message ||
                    'Extension network policy changed, but the Gateway failed to restart.',
                );
              }
            }
          };
          if (appCompanion && extensionId) {
            // Native execution waits for companion validation and explicit activation.
            updateExtensionAllowlist(
              manager.getConfigPath(), extensionId, 'add',
              this.deps.getManagedPluginIds?.() ?? [], true,
            );
          }
          let allowlistError = '';
          let gatewayAppliedRuntime = false;
          let gatewayRestartRequired = false;
          const confirmInstalledIdentity = async (): Promise<void> => {
            reportOperationProgress(PluginOperationStage.CONFIRMING);
            if (installOwnerId)
              installationPath = findInstalledExtensionPath(extensionsRoot, installOwnerId);
            if (!multipleRuntimeEntries) return;
            if (!gatewayAppliedRuntime) extensionId = undefined;
            // The successful native receipt names a child; persistence errors and
            // cold CLI installs can name the package owner. Normalize only through
            // the native package resolver, never a child-ID naming convention.
            const local = this.listInstalled();
            const packages = await this.readPackageOwnership(local);
            const owner = packages.find(
              owner =>
                owner.ownerId === installOwnerId &&
                installationPath &&
                sameInstallPath(owner.installPath, installationPath),
            );
            if (!owner) {
              if (!gatewayAppliedRuntime) extensionId = undefined;
              throw new Error(t('extensionPackageOwnershipUnconfirmed'));
            }
            extensionId = owner.pluginIds[0];
          };
          reportProgress('installing', 45);
          if (hasRuntimeDependencies(pluginDirectory)) {
            reportProgress('installing_dependencies', 55);
          }
          installationAttempted = true;
          const command = await this.runDirectoryCommand(targetPath, async () => {
            installSourceInFlight = true;
            if (requestGateway) {
              try {
                // Bind the human-reviewed surface to native staging. The CLI's
                // --accept-capabilities would approve whatever source it reads later.
                const installed = await this.requestPluginMutation<{
                  ok: boolean;
                  plugin: { id: string };
                  restartRequired: boolean;
                  runtime?: { generation: number; pluginIds: string[] };
                }>(
                  'plugins.install',
                  {
                    source: 'local',
                    path: installSourcePath,
                    mode: 'update',
                    ...(reviewToken && !options?.autoAcceptCapabilities
                      ? { acknowledgeCapabilities: { reviewToken } } : {}),
                    ...(options?.preserveActivation || appCompanion ? { enable: false } : {}),
                  },
                  { timeoutMs: GATEWAY_INSTALL_TIMEOUT_MS },
                  {
                    onAdmissionWait: () => reportOperationProgress(PluginOperationStage.QUEUED),
                    onAdmissionResume: () => reportOperationProgress(PluginOperationStage.INSTALLING),
                  },
                  requestGateway,
                );
                if (installed?.ok !== true) {
                  throw new Error(t('extensionInstallUnconfirmed'));
                }
                installSourceInFlight = false;
                installationCommitted = true;
                reportOperationProgress(PluginOperationStage.CONFIRMING);
                if (
                  typeof installed.plugin?.id !== 'string' ||
                  !installed.plugin.id ||
                  typeof installed.restartRequired !== 'boolean' ||
                  !Number.isInteger(installed.runtime?.generation) ||
                  !Array.isArray(installed.runtime?.pluginIds) ||
                  !installed.runtime.pluginIds.includes(installed.plugin.id)
                ) {
                  throw new Error(t('extensionInstallReceiptIncomplete'));
                }
                extensionId = installed.plugin.id;
                gatewayAppliedRuntime = true;
                gatewayRestartRequired = installed.restartRequired;
                return { exitCode: 0, stdout: '', stderr: '' };
              } catch (error) {
                const details = isRecord(error) && isRecord(error.details) ? error.details : undefined;
                const persistence =
                  details && isRecord(details.persistence) ? details.persistence : undefined;
                if (persistence?.operation === 'install' && typeof persistence.pluginId === 'string') {
                  installationCommitted = true;
                  extensionId = persistence.pluginId;
                  installSourceInFlight = false;
                  await confirmInstalledIdentity();
                } else if (
                  isGatewayMutationNotSent(error) ||
                  (isRecord(error) && typeof error.gatewayCode === 'string') ||
                  details?.pluginInstallRejected === true
                ) {
                  installSourceInFlight = false;
                }
                if (readCapabilityConsentDetails(error)) {
                  installSourceInFlight = false;
                  reportProgress('validating', 25);
                  rejectedCapabilityReview = (
                    await this.inspectCapabilityReview({
                      cli,
                      pluginDirectory,
                      sourcePath: installSourcePath,
                      extensionId,
                    })
                  ).review;
                }
                // A lost reply can follow a committed installation. Never repeat it
                // through the CLI or infer completion from the requested state.
                throw error;
              }
            }
            const result = await this.runCommand(requireOpenClawCliExecutable(cli.env), installArgs, {
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
            // A failed/terminated CLI can have lost the Gateway's response while its
            // native lifecycle is still reading this source. Retain that one-shot
            // copy on unknown outcomes; never remove it or replay the install.
            installSourceInFlight = !result.nativeReceiptObserved &&
              (result.exitCode !== 0 || result.timedOut === true);
            if (
              result.exitCode === 0 &&
              extensionId &&
              !this.deps.requestGateway &&
              !options?.preserveActivation &&
              !appCompanion
            ) {
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
          }, { preflightLockCheck: false });
          const result = command.result;
          if (result.exitCode !== 0) {
            let error = command.error ?? formatCommandError(result);
            const classifiedFailureStage = inferInstallerFailureStage(result);
            const failedStage = classifiedFailureStage ?? currentStage;
            if (result.nativeReceiptObserved) installationCommitted = true;
            if (installationCommitted) {
              try {
                await confirmInstalledIdentity();
              } catch (confirmationError) {
                error = appendRecoveryFailure(error,
                  confirmationError instanceof Error ? confirmationError.message :
                    t('extensionFollowupFailureReasonUnavailable'));
              }
            }
            // Explicit native packaging/dependency diagnostics take precedence over
            // later confirmation; otherwise retain the actual post-commit phase.
            const operationFailure = classifiedFailureStage ? {} : committedOperationFailure();
            try {
              await convergeNetworkPolicyFailClosed();
            } catch (recoveryError) {
              error = appendRecoveryFailure(error,
                recoveryError instanceof Error ? recoveryError.message :
                  t('extensionFollowupFailureReasonUnavailable'));
            }
            console.error(
              '[OpenClawExtensionImportService] OpenClaw installer failed:',
              error,
            );
            return {
              success: false,
              extensionId,
              error,
              failedStage,
              ...(installationCommitted ? { installationCommitted: true as const } : {}),
              ...(installationPath ? { installPath: installationPath } : {}),
              ...(installSourceInFlight ? { installSourceInUse: true as const } : {}),
              ...(rejectedCapabilityReview ? { capabilityReview: rejectedCapabilityReview } : {}),
              ...operationFailure,
            };
          }
          installationCommitted = true;
          await confirmInstalledIdentity();

          let runtimeConvergence: Promise<void> | undefined;
          const convergeInstalledRuntime = (): Promise<void> => {
            runtimeConvergence ??= (async () => {
              const networkPolicyChanged = this.deps.outboundHeaderPolicy
                ? this.deps.outboundHeaderPolicy.reconcile().digest !== networkPolicyDigestBeforeInstall
                : false;
              const cliAppliedRuntime = gatewayAppliedRuntime ||
                createInstallSuccessPattern(extensionId, true)?.test(result.stdout);
              const phase = manager.getStatus().phase;
              if (!(wasRuntimeActive || phase === 'running' || phase === 'starting') ||
                  (command.runtimeRestarted && !networkPolicyChanged)) return;
              let reloaded = !networkPolicyChanged && !gatewayRestartRequired && cliAppliedRuntime;
              if (!reloaded && !networkPolicyChanged && !gatewayRestartRequired &&
                  !command.runtimeRestarted && extensionId) {
                reportOperationProgress(PluginOperationStage.APPLYING_CONFIGURATION);
                reloaded = await this.reloadPluginAfterCliMutation('plugins.reload', extensionId);
              }
              if (reloaded) return;
              reportProgress('restarting_gateway', 90);
              const reason = gatewayRestartRequired ? 'extension-import'
                : networkPolicyChanged ? 'extension-network-policy-change' : 'extension-import';
              const status = await (gatewayRestartRequired && networkPolicyChanged
                ? this.restartGatewayAfterMutation(reason, { networkPolicyChanged: true })
                : this.restartGatewayAfterMutation(reason));
              if (status.phase !== 'running' && !status.deferred) throw new Error(
                status.message || 'Extension installed, but the OpenClaw Gateway failed to restart.',
              );
            })();
            return runtimeConvergence;
          };
          if (extensionId && this.deps.outboundHeaderPolicy) {
            if (!installationPath) {
              await convergeInstalledRuntime();
              return {
                success: false,
                extensionId,
                error: 'Extension installed, but its canonical install path could not be verified.',
                installationCommitted: true,
                failedStage: currentStage,
                operationFailedStage: PluginOperationStage.CONFIRMING,
              };
            }
            reportOperationProgress(PluginOperationStage.VALIDATING);
            try {
              this.deps.outboundHeaderPolicy.inspectExtension(installationPath);
            } catch (error) {
              await convergeInstalledRuntime();
              return {
                success: false,
                extensionId,
                error:
                  error instanceof Error
                    ? error.message
                    : 'The installed Extension network policy is invalid.',
                installationCommitted: true,
                installPath: installationPath,
                failedStage: currentStage,
                operationFailedStage: PluginOperationStage.VALIDATING,
              };
            }
          }

          // A native install may preserve an earlier disable or save a new disable
          // because required setup is missing. Submit the fresh market activation
          // intent through native validation so either condition is reported honestly.
          const activateInstalledPluginIds =
            options?.trustMarketplaceSource && !options.preserveActivation && !appCompanion
              ? artifactPluginIds : [];
          for (const pluginId of activateInstalledPluginIds) {
            const savedConfig = readJsonRecord(configPath);
            const plugins = isRecord(savedConfig.plugins) ? savedConfig.plugins : {};
            const entries = isRecord(plugins.entries) ? plugins.entries : {};
            const entry = entries[pluginId];
            if (!isRecord(entry) || entry.enabled !== false) continue;
            const activated = await this.setEnabledExclusive(
              pluginId,
              true,
              undefined,
              reportOperationProgress,
              {
                stoppedPackageInstall: true,
                ...(options?.applyPackageMutation && requestGateway
                  ? {
                      connectedGatewayRequest: requestGateway,
                      deferRuntimeConvergence: (receipt: { restartRequired: boolean }) => {
                        gatewayRestartRequired ||= receipt.restartRequired;
                      },
                    } : {}),
              },
            );
            if (!activated.success) {
              const failedOperation = committedOperationFailure();
              const failedStage = currentStage;
              let error = activated.error || 'Extension installed, but it could not be enabled.';
              try {
                await convergeInstalledRuntime();
              } catch (recoveryError) {
                error = recoveryError instanceof Error
                  ? appendRecoveryFailure(error, recoveryError.message)
                  : `${error}\n${t('extensionPackageRecoveryFailed')}`;
              }
              return {
                success: false,
                extensionId,
                error,
                installationCommitted: true,
                ...(activated.operationUnconfirmed ? { operationUnconfirmed: true as const } : {}),
                ...(installationPath ? { installPath: installationPath } : {}),
                failedStage,
                ...failedOperation,
                ...(activated.failedStage ? { operationFailedStage: activated.failedStage } : {}),
              };
            }
          }
          await convergeInstalledRuntime();

          if (allowlistError) {
            return {
              success: false,
              extensionId,
              error: `Extension installed, but it could not be added to the plugin allowlist: ${allowlistError}`,
              installationCommitted: true,
              ...(installationPath ? { installPath: installationPath } : {}),
              failedStage: currentStage,
              operationFailedStage: PluginOperationStage.SAVING_CONFIGURATION,
            };
          }

          reportProgress('completed', 100);
          return {
            success: true,
            extensionId,
            ...(installationPath ? { installPath: installationPath } : {}),
          };
        } catch (error) {
          return failedImport(error);
        }
      };
      if (!options?.applyPackageMutation) {
        return await performInstall(manager.isGatewayMutationInProgress?.()
          ? ExtensionPackageLifecycleMode.STOPPED : ExtensionPackageLifecycleMode.HOT);
      }
      const installedPackages = installedPath
        ? await this.readPackageOwnership(this.listInstalled()) : [];
      const existingPackage = installedPackages.find(owner =>
        owner.ownerId === installOwnerId && installedPath &&
          sameInstallPath(owner.installPath, installedPath));
      const nativePluginIds = [...new Set([
        ...artifactPluginIds,
        ...(installOwnerId ? [installOwnerId] : []),
        ...(existingPackage?.pluginIds ?? []),
      ])];
      let mode: ExtensionPackageLifecycleMode = ExtensionPackageLifecycleMode.HOT;
      return await installExtensionPackage(async () => {
        const result = await performInstall(mode);
        return options.onInstalled ? options.onInstalled(result, mode) : result;
      }, operation => options.applyPackageMutation!({
        nativePluginIds,
        ...(targetPath !== extensionsRoot ? { installPath: targetPath } : {}),
        sourceDirectory: pluginDirectory,
      }, selectedMode => {
        mode = selectedMode;
        return this.runConfigMutationExclusive(operation);
      }));
    } catch (error) {
      return failedImport(error);
    } finally {
      try {
        if (installSourceInFlight && retainedInstallSourcePath) {
          console.warn(
            '[OpenClawExtensionImportService] Retaining install source after an unconfirmed native outcome:',
            retainedInstallSourcePath,
          );
        } else {
          const cleanup = await Promise.allSettled([
            cleanupInstallSource?.(), cleanupArchiveSource?.(),
          ]);
          for (const result of cleanup) {
            if (result.status === 'rejected') console.warn(
              '[OpenClawExtensionImportService] Failed to clean temporary install source:',
              result.reason,
            );
          }
        }
      } catch (error) {
        console.warn(
          '[OpenClawExtensionImportService] Failed to clean temporary install source:',
          error,
        );
      }
      if (temporaryDirectory && !installSourceInFlight) {
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
  createInstallSuccessPattern,
  isDirectoryLockError,
  isGatewayUnavailableError,
  isSupportedArchive,
  resolveExtractedPluginDirectory,
  runCommand,
  validateNativePluginDirectory,
};
