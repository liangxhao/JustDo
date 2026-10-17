import { spawn } from 'child_process';
import fs from 'fs';
import JSON5 from 'json5';
import os from 'os';
import path from 'path';
import * as tar from 'tar';

import {
  type ExtensionImportProgress,
  type ExtensionImportResult,
  type ExtensionImportStage,
  type ExtensionSetEnabledResult,
  ExtensionState,
  type InstalledOpenClawExtension,
  type OpenClawExtensionConfigurationField,
  type OpenClawPluginCapabilityReview,
} from '../../../shared/plugins/extensions';
import { OpenClawExtensionId } from '../../../shared/plugins/nativeIds';
import {
  managedDirectoryFailure,
  managedDirectoryFailureFromMessage,
  ManagedDirectoryOperationCoordinator,
  managedDirectorySuccess,
} from '../../core/filesystem/managedDirectoryOperations';
import { extractZipSafely } from '../../core/filesystem/safeZipExtractor';
import { t } from '../../core/i18n';
import type { EffectiveOutboundHeaderPolicySnapshot } from '../../core/network/outboundHeaderPolicyService';
import { restrictCredentialFile } from '../../openclaw/config/providerSecretFile';
import type { OpenClawEngineManager } from '../../openclaw/runtime/openclawEngineManager';
import { prepareExtensionForInstall } from './extensionConversion';
import { prepareExtensionInstallSource } from './extensionInstallSource';
import type { ExtensionNetworkPolicyInspection } from './extensionNetworkPolicyManifest';
import {
  type ExtensionPackageOwnership,
  readExtensionArtifactPluginIds,
  readExtensionPackageOwnership,
} from './extensionPackageOwnership';
import { isExtensionSecretReferenceField, saveExtensionSecrets } from './extensionSecretFile';

const OPENCLAW_PLUGIN_MANIFEST = 'openclaw.plugin.json';
const PLUGIN_RUNTIME_SERVICE_FAILED = 'service-failed';
const AGENT_PLUGIN_MANIFEST_SCHEMA = 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json';
const SUPPORTED_ARCHIVE_EXTENSIONS = ['.zip', '.tar', '.tar.gz', '.tgz'];
const INSTALL_TIMEOUT_MS = 300_000;
const GATEWAY_INSTALL_TIMEOUT_MS = 600_000;
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

export type { ExtensionImportProgress, ExtensionImportResult, ExtensionImportStage };

/** Main-only evidence for settling installation identity and temporary source ownership. */
type CommittedExtensionImportResult = ExtensionImportResult & {
  installationCommitted?: true;
  installSourceInUse?: true;
  installPath?: string;
};

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
  requestGateway?: <T>(
    method: string,
    params?: unknown,
    options?: { timeoutMs?: number },
  ) => Promise<T>;
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
  outboundHeaderPolicy?: {
    inspectExtension: (extensionRoot: string) => ExtensionNetworkPolicyInspection | null;
    reconcile: () => EffectiveOutboundHeaderPolicySnapshot;
  };
  readPackageOwnership?: typeof readExtensionPackageOwnership;
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
  value: unknown,
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
  const legacyProviderEnvVars = isRecord(manifest.providerAuthEnvVars)
    ? manifest.providerAuthEnvVars
    : {};
  Object.values(legacyProviderEnvVars).forEach(addEnvVars);
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
  if (!requiredEnvVars.length && !sensitiveHints.length && !numericHints.length)
    return { fields: [], missingRequirements: [] };
  const config = readJsonRecord(manager.getConfigPath());
  const pluginsConfig = isRecord(config.plugins) ? config.plugins : {};
  const pluginEntries = isRecord(pluginsConfig.entries) ? pluginsConfig.entries : {};
  const pluginEntry = isRecord(pluginEntries[extensionId]) ? pluginEntries[extensionId] : {};
  const pluginConfig = pluginEntry.config;
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
    let successTerminationRequested = false;
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
        successTerminationRequested = true;
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
      if (successPattern?.test(stdout)) terminateSuccessfulCommand();
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
      if (successTerminationTimer) clearTimeout(successTerminationTimer);
      const exitCode = successTerminationRequested ? 0 : (code ?? 1);
      setTimeout(() => finish({ exitCode, stdout, stderr }), 50);
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
  // A failed config write or restart must not make a credential retry a no-op.
  // This state is process-local: a fresh Gateway startup reads the saved secret file.
  private readonly pendingCredentialRefresh = new Set<string>();
  private readonly pendingNumericRefresh = new Set<string>();

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
      const result = await this.deps.requestGateway<{ ok: boolean; restartRequired: boolean }>(
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

  private async syncAgentTeamSkill(enabled: boolean, viaGateway: boolean): Promise<void> {
    try {
      if (viaGateway && this.deps.requestGateway) {
        const result = await this.deps.requestGateway<{ ok: boolean }>('skills.update', {
          skillKey: OpenClawExtensionId.AGENT_TEAM,
          enabled,
        });
        if (!result.ok) throw new Error('Skill update rejected');
        return;
      }
      const manager = this.deps.getOpenClawEngineManager();
      const cli = await manager.buildCliEnvironment();
      const result = await this.runCommand(
        process.execPath,
        [
          cli.openclawEntry,
          'config',
          'set',
          'skills.entries.agent-team.enabled',
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
      const entry = entries[OpenClawExtensionId.AGENT_TEAM];
      if (!isRecord(entry) || entry.enabled !== enabled)
        throw new Error('Skill update not persisted');
    } catch {
      // The plugin write may already have committed. The same toggle is safe to
      // retry and must repair the skill even if the plugin already has that state.
      throw new Error(t('agentTeamSkillSyncFailed'));
    }
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
      manageRuntimeOnLock: false,
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

  async listCatalog(): Promise<InstalledOpenClawExtension[]> {
    if (!this.deps.requestGateway) return this.listInstalled();
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
    const packages = await this.readPackageOwnership(localExtensions);
    const localById = new Map(localExtensions.map(extension => [extension.id, extension]));
    for (const owner of packages) {
      const local = localById.get(owner.ownerId);
      if (!local) continue;
      for (const pluginId of owner.pluginIds)
        localById.set(pluginId, this.projectPackageEntry(local, pluginId));
    }
    if (
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
        await this.deps.requestGateway('plugins.refresh', {});
        result = await this.deps.requestGateway('plugins.list', {});
      } catch (error) {
        console.warn(
          '[OpenClawExtensionImportService] Failed to refresh externally changed plugin inventory:',
          error instanceof Error ? error.message : String(error),
        );
      }
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
  }

  async updateConfiguration(
    extensionId: string,
    values: Record<string, string>,
  ): Promise<{ success: boolean; error?: string; pending?: boolean }> {
    return this.runMutationExclusive(() => this.updateConfigurationExclusive(extensionId, values));
  }

  private async updateConfigurationExclusive(
    extensionId: string,
    values: Record<string, string>,
  ): Promise<{ success: boolean; error?: string; pending?: boolean }> {
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
        value.trim().length > 0 && isSafeConfigPath(configPath) && fieldsByPath.has(configPath),
    );
    if (updates.length === 0) {
      return { success: false, error: 'Enter at least one supported configuration value.' };
    }
    for (const [fieldPath, value] of updates) {
      const field = fieldsByPath.get(fieldPath)!;
      if (field.type) {
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
    const numericOnly = updates.every(([fieldPath]) => Boolean(fieldsByPath.get(fieldPath)?.type));
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
          setNestedValue(
            pluginConfig,
            fieldPath,
            fieldsByPath.get(fieldPath)?.type
              ? Number(value)
              : (secretUpdate.references[fieldPath] ?? value),
          );
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
        if (
          reloadGeneration !== null &&
          (await manager.waitForGatewayConfigReload(reloadGeneration))
        ) {
          this.pendingCredentialRefresh.delete(extensionId);
          return { success: true };
        }
        const status = await this.restartGatewayAfterMutation('extension-config-change');
        if (status.phase !== 'running') {
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
    const policyDigestBefore = this.deps.outboundHeaderPolicy?.reconcile().digest;
    const convergePolicy = async (
      forceRestart = false,
      allowNativeRefresh = false,
    ): Promise<string | undefined> => {
      const policyDigestAfter = this.deps.outboundHeaderPolicy?.reconcile().digest;
      if (!forceRestart && (!wasRuntimeActive || policyDigestAfter === policyDigestBefore)) {
        return undefined;
      }
      if (
        allowNativeRefresh &&
        policyDigestAfter === policyDigestBefore &&
        (await this.reloadPluginAfterCliMutation('plugins.refresh'))
      ) {
        return undefined;
      }
      try {
        const status = await this.restartGatewayAfterMutation(
          policyDigestAfter !== policyDigestBefore
            ? 'extension-network-policy-change'
            : 'extension-delete',
        );
        return status.phase === 'running'
          ? undefined
          : status.message ||
              'Extension state changed, but the OpenClaw Gateway failed to restart.';
      } catch (error) {
        return error instanceof Error
          ? error.message
          : 'Extension state changed, but the OpenClaw Gateway failed to restart.';
      }
    };
    // Capture the verified local path before the Gateway mutates anything. A failed
    // recursive removal can delete the manifest before reporting a Windows lock,
    // making a post-failure inventory scan unable to locate the retry target.
    const installedBeforeGateway = await this.resolveInstalledExtension(extensionId);
    let gatewayMutationError: unknown;
    if (this.deps.requestGateway) {
      try {
        const result = await this.deps.requestGateway<{
          ok: true;
          restartRequired: boolean;
          warnings?: string[];
        }>('plugins.uninstall', { pluginId: extensionId });
        const convergenceError = await convergePolicy(result.restartRequired, true);
        if (convergenceError) {
          return { success: false, error: convergenceError };
        }
        return { success: true, warnings: result.warnings };
      } catch (error) {
        gatewayMutationError = error;
        if (
          isDirectoryLockError(error) &&
          (!isGatewayUnavailableError(error) || (isRecord(error) && 'gatewayCode' in error))
        ) {
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
              const convergenceError = await convergePolicy(true, true);
              if (convergenceError) return { success: false, error: convergenceError };
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
        } else if (isGatewayUnavailableError(error) && isGatewayMutationNotSent(error)) {
          // Offline recovery is safe only with evidence that this mutation was
          // not dispatched. A timeout or closed socket may leave it in progress.
        } else if (
          isGatewayUnavailableError(error) &&
          (!isRecord(error) || !('gatewayCode' in error))
        ) {
          let absentFromInventory = false;
          try {
            const catalog = await this.deps.requestGateway<{
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
            const convergenceError = await convergePolicy(true, true);
            return convergenceError
              ? { success: false, error: convergenceError }
              : { success: true };
          }
          return { success: false, error: t('extensionUninstallUnconfirmed') };
        } else {
          const convergenceError = await convergePolicy();
          return {
            success: false,
            error:
              convergenceError ??
              (error instanceof Error ? error.message : 'Failed to delete plugin'),
          };
        }
      }
    }
    const installedAfterGateway =
      installedBeforeGateway ?? (await this.resolveInstalledExtension(extensionId));
    const gatewayMayNeedRestore =
      wasRuntimeActive && !!gatewayMutationError && isGatewayUnavailableError(gatewayMutationError);
    if (
      gatewayMutationError &&
      isGatewayUnavailableError(gatewayMutationError) &&
      (!installedAfterGateway || !fs.existsSync(installedAfterGateway.installPath))
    ) {
      const convergenceError = await convergePolicy(wasRuntimeActive);
      return convergenceError ? { success: false, error: convergenceError } : { success: true };
    }
    const installed = installedBeforeGateway ?? installedAfterGateway;
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
        if (result.exitCode === 0 && !fs.existsSync(installed.installPath)) {
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
        const convergenceError = await convergePolicy(gatewayMayNeedRestore);
        return { success: false, error: convergenceError ?? error };
      }

      if (fs.existsSync(installed.installPath)) {
        const convergenceError = await convergePolicy(gatewayMayNeedRestore);
        return {
          success: false,
          error:
            convergenceError ?? 'OpenClaw reported success, but the extension is still installed.',
        };
      }

      const convergenceError = await convergePolicy(
        wasRuntimeActive && !command.runtimeRestarted,
        wasRuntimeActive && !command.runtimeRestarted,
      );
      if (convergenceError) {
        return { success: false, error: convergenceError };
      }
      if (allowlistError) {
        return {
          success: false,
          error: `Extension removed, but its allowlist entry could not be cleaned up: ${allowlistError}`,
        };
      }
      return { success: true };
    } catch (error) {
      const convergenceError = await convergePolicy(gatewayMayNeedRestore);
      return {
        success: false,
        error:
          convergenceError ??
          (error instanceof Error ? error.message : 'Failed to delete extension'),
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
    if (this.deps.getManagedPluginIds?.().includes(extensionId)) {
      return { success: false, error: 'Managed extensions cannot be changed here.' };
    }
    const manager = this.deps.getOpenClawEngineManager();
    const initialPhase = manager.getStatus().phase;
    const wasRuntimeActive = initialPhase === 'running' || initialPhase === 'starting';
    // Native 9.8 skill refresh retains pre-toggle discovery configurations. A
    // later watcher event can publish that old configuration and remove the new
    // plugin skill junction. Reset the native discovery lifetime after the Team
    // and skill writes; never copy skills or rewrite the model's read arguments.
    const restartTeamDiscovery = extensionId === OpenClawExtensionId.AGENT_TEAM && wasRuntimeActive;
    const policyDigestBefore = this.deps.outboundHeaderPolicy?.reconcile().digest;
    let gatewayMayNeedRestore = false;
    const convergeColdState = async (forceRestart = false): Promise<string | undefined> => {
      const policyDigestAfter = this.deps.outboundHeaderPolicy?.reconcile().digest;
      if (
        !wasRuntimeActive ||
        (!forceRestart && !restartTeamDiscovery && policyDigestAfter === policyDigestBefore)
      ) {
        return undefined;
      }
      if (
        forceRestart &&
        !restartTeamDiscovery &&
        policyDigestAfter === policyDigestBefore &&
        (await this.reloadPluginAfterCliMutation('plugins.refresh'))
      ) {
        return undefined;
      }
      try {
        const status = await this.restartGatewayAfterMutation(
          policyDigestAfter !== policyDigestBefore
            ? 'extension-network-policy-change'
            : 'extension-status-change',
        );
        return status.phase === 'running'
          ? undefined
          : status.message ||
              'Extension status changed, but the OpenClaw Gateway failed to restart.';
      } catch (error) {
        return error instanceof Error
          ? error.message
          : 'Extension status changed, but the OpenClaw Gateway failed to restart.';
      }
    };
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
        let skillSyncError: string | undefined;
        if (extensionId === OpenClawExtensionId.AGENT_TEAM) {
          // A skills.* mutation invalidates persisted session skill snapshots even
          // when native filesystem watching is disabled. The extension owns this skill.
          try {
            await this.syncAgentTeamSkill(enabled, true);
          } catch {
            skillSyncError = t('agentTeamSkillSyncFailed');
          }
        }
        const policyDigestAfter = this.deps.outboundHeaderPolicy?.reconcile().digest;
        if (
          result.restartRequired ||
          restartTeamDiscovery ||
          policyDigestAfter !== policyDigestBefore
        ) {
          const status = await this.restartGatewayAfterMutation(
            policyDigestAfter !== policyDigestBefore
              ? 'extension-network-policy-change'
              : 'extension-status-change',
          );
          if (status.phase !== 'running') {
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
          // Fall through to the cold CLI path for offline recovery only.
          gatewayMayNeedRestore = wasRuntimeActive;
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
    const installed = await this.resolveInstalledExtension(extensionId);
    if (!installed) return { success: false, error: 'Extension is not installed.' };
    if (installed.enabled === enabled) {
      if (extensionId === OpenClawExtensionId.AGENT_TEAM) {
        try {
          await this.syncAgentTeamSkill(enabled, false);
        } catch {
          return { success: false, error: t('agentTeamSkillSyncFailed') };
        }
      }
      const convergenceError = await convergeColdState(gatewayMayNeedRestore);
      return convergenceError ? { success: false, error: convergenceError } : { success: true };
    }
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
        const convergenceError = await convergeColdState(gatewayMayNeedRestore);
        return { success: false, error: convergenceError ?? error };
      }

      const updated = await this.resolveInstalledExtension(extensionId);
      if (!updated || updated.enabled !== enabled) {
        const convergenceError = await convergeColdState(gatewayMayNeedRestore);
        return {
          success: false,
          error:
            convergenceError ??
            `OpenClaw did not ${enabled ? 'enable' : 'disable'} the extension. Check the global plugin policy, allowlist, and denylist.`,
        };
      }

      if (extensionId === OpenClawExtensionId.AGENT_TEAM)
        await this.syncAgentTeamSkill(enabled, false);
      const convergenceError = await convergeColdState(wasRuntimeActive);
      return convergenceError ? { success: false, error: convergenceError } : { success: true };
    } catch (error) {
      const convergenceError = await convergeColdState(gatewayMayNeedRestore);
      return {
        success: false,
        error:
          convergenceError ??
          (error instanceof Error ? error.message : 'Failed to update extension status'),
      };
    }
  }

  async importPath(
    sourcePath: string,
    onProgress?: (progress: Omit<ExtensionImportProgress, 'requestId' | 'sourcePath'>) => void,
    reviewToken?: string,
    options?: { trustMarketplaceSource?: boolean; preserveActivation?: boolean },
  ): Promise<CommittedExtensionImportResult> {
    return this.runMutationExclusive(() =>
      this.importPathExclusive(sourcePath, onProgress, reviewToken, options),
    );
  }

  private async importPathExclusive(
    sourcePath: string,
    onProgress?: (progress: Omit<ExtensionImportProgress, 'requestId' | 'sourcePath'>) => void,
    reviewToken?: string,
    options?: { trustMarketplaceSource?: boolean; preserveActivation?: boolean },
  ): Promise<CommittedExtensionImportResult> {
    let temporaryDirectory: string | null = null;
    let cleanupInstallSource: (() => Promise<void>) | undefined;
    let installSourceInFlight = false;
    let retainedInstallSourcePath: string | undefined;
    let extensionId: string | undefined;
    let installationAttempted = false;
    let installationCommitted = false;
    let installationPath: string | undefined;
    let rejectedCapabilityReview: OpenClawPluginCapabilityReview | undefined;
    let currentStage: ExtensionImportStage = 'preparing';
    const reportProgress = (stage: ExtensionImportStage, percent: number): void => {
      currentStage = stage;
      onProgress?.({ stage, percent });
    };
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
        temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-extension-import-'));
        const lowerPath = normalizedSourcePath.toLowerCase();
        if (lowerPath.endsWith('.zip')) {
          await extractZipSafely(normalizedSourcePath, temporaryDirectory);
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
      } else {
        return {
          success: false,
          error:
            'Select an OpenClaw extension folder or a supported archive (.zip, .tar, .tar.gz, .tgz).',
          failedStage: currentStage,
        };
      }

      const prepared = await prepareExtensionForInstall({
        sourcePath: normalizedSourcePath,
        pluginDirectory,
      });
      pluginDirectory = prepared.pluginDirectory;
      extensionId = validateNativePluginDirectory(pluginDirectory);
      this.deps.outboundHeaderPolicy?.inspectExtension(pluginDirectory);

      reportProgress('preparing_runtime', 35);
      const manager = this.deps.getOpenClawEngineManager();
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
          const status = await this.restartGatewayAfterMutation('extension-network-policy-change');
          if (status.phase !== 'running') {
            throw new Error(
              status.message ||
                'Extension network policy changed, but the Gateway failed to restart.',
            );
          }
        }
      };
      const cli = await manager.buildCliEnvironment();
      let installSourcePath = prepared.sourcePath;
      if (stats.isDirectory()) {
        const installSource = await prepareExtensionInstallSource(pluginDirectory, cli.runtimeRoot);
        cleanupInstallSource = installSource.cleanup;
        if (installSource.directory !== pluginDirectory) {
          pluginDirectory = installSource.directory;
          installSourcePath = installSource.directory;
          retainedInstallSourcePath = installSourcePath;
          extensionId = validateNativePluginDirectory(pluginDirectory);
          this.deps.outboundHeaderPolicy?.inspectExtension(pluginDirectory);
        }
      }
      // Discovery can name a multi-entry package's children differently from
      // its on-disk manifest owner. Keep the exact owner for directory checks.
      const installOwnerId = extensionId;
      const multipleRuntimeEntries = hasMultipleRuntimeEntries(pluginDirectory);
      if (this.deps.requestGateway && !options?.trustMarketplaceSource) {
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
      if (multipleRuntimeEntries && (!this.deps.requestGateway || options?.trustMarketplaceSource))
        extensionId = (await readExtensionArtifactPluginIds(manager, pluginDirectory))[0];
      const installArgs = [
        cli.openclawEntry,
        'plugins',
        'install',
        installSourcePath,
        '--force',
        ...(options?.preserveActivation ? ['--no-enable'] : []),
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
      let allowlistError = '';
      let gatewayAppliedRuntime = false;
      let gatewayRestartRequired = false;
      const confirmInstalledIdentity = async (): Promise<void> => {
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
      installationAttempted = true;
      const command = await this.runDirectoryCommand(targetPath, async () => {
        installSourceInFlight = true;
        if (this.deps.requestGateway && !options?.trustMarketplaceSource && reviewToken) {
          try {
            // Bind the human-reviewed surface to native staging. The CLI's
            // --accept-capabilities would approve whatever source it reads later.
            const installed = await this.deps.requestGateway<{
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
                acknowledgeCapabilities: { reviewToken },
                ...(options?.preserveActivation ? { enable: false } : {}),
              },
              { timeoutMs: GATEWAY_INSTALL_TIMEOUT_MS },
            );
            if (installed?.ok !== true) {
              throw new Error(t('extensionInstallUnconfirmed'));
            }
            installSourceInFlight = false;
            installationCommitted = true;
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
              currentStage = 'validating';
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
        // A failed/terminated CLI can have lost the Gateway's response while its
        // native lifecycle is still reading this source. Retain that one-shot
        // copy on unknown outcomes; never remove it or replay the install.
        installSourceInFlight = result.exitCode !== 0 || result.timedOut === true;
        if (
          result.exitCode === 0 &&
          extensionId &&
          !this.deps.requestGateway &&
          !options?.preserveActivation
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
      });
      const result = command.result;
      if (result.exitCode !== 0) {
        if (installationCommitted) await confirmInstalledIdentity();
        await convergeNetworkPolicyFailClosed();
        const failedStage = inferInstallerFailureStage(result, currentStage);
        console.error(
          '[OpenClawExtensionImportService] OpenClaw installer failed:',
          command.error ?? formatCommandError(result),
        );
        return {
          success: false,
          extensionId,
          error: command.error ?? formatCommandError(result),
          failedStage,
          ...(installationCommitted ? { installationCommitted: true as const } : {}),
          ...(installationPath ? { installPath: installationPath } : {}),
          ...(installSourceInFlight ? { installSourceInUse: true as const } : {}),
          ...(rejectedCapabilityReview ? { capabilityReview: rejectedCapabilityReview } : {}),
        };
      }
      installationCommitted = true;
      await confirmInstalledIdentity();

      let networkPolicyChanged = false;
      if (extensionId && this.deps.outboundHeaderPolicy) {
        if (!installationPath) {
          await convergeNetworkPolicyFailClosed();
          return {
            success: false,
            extensionId,
            error: 'Extension installed, but its canonical install path could not be verified.',
            installationCommitted: true,
            failedStage: currentStage,
          };
        }
        try {
          this.deps.outboundHeaderPolicy.inspectExtension(installationPath);
        } catch (error) {
          await convergeNetworkPolicyFailClosed();
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
          };
        }
        const snapshot = this.deps.outboundHeaderPolicy.reconcile();
        networkPolicyChanged = snapshot.digest !== networkPolicyDigestBeforeInstall;
      }

      const cliAppliedRuntime =
        gatewayAppliedRuntime ||
        createInstallSuccessPattern(extensionId, true)?.test(result.stdout);
      const phaseAfterInstall = manager.getStatus().phase;
      if (
        (wasRuntimeActive || phaseAfterInstall === 'running' || phaseAfterInstall === 'starting') &&
        (!command.runtimeRestarted || networkPolicyChanged)
      ) {
        const reloaded =
          !networkPolicyChanged &&
          !gatewayRestartRequired &&
          (cliAppliedRuntime ||
            (!command.runtimeRestarted &&
              extensionId &&
              (await this.reloadPluginAfterCliMutation('plugins.reload', extensionId))));
        if (!reloaded) {
          reportProgress('restarting_gateway', 90);
          const status = await this.restartGatewayAfterMutation(
            networkPolicyChanged ? 'extension-network-policy-change' : 'extension-import',
          );
          if (status.phase !== 'running') {
            return {
              success: false,
              extensionId,
              error:
                status.message ||
                'Extension installed, but the OpenClaw Gateway failed to restart.',
              installationCommitted: true,
              ...(installationPath ? { installPath: installationPath } : {}),
              failedStage: currentStage,
            };
          }
        }
      }

      if (allowlistError) {
        return {
          success: false,
          extensionId,
          error: `Extension installed, but it could not be added to the plugin allowlist: ${allowlistError}`,
          installationCommitted: true,
          ...(installationPath ? { installPath: installationPath } : {}),
          failedStage: currentStage,
        };
      }

      reportProgress('completed', 100);
      return {
        success: true,
        extensionId,
        ...(installationPath ? { installPath: installationPath } : {}),
      };
    } catch (error) {
      return {
        success: false,
        ...(installationAttempted ? { extensionId } : {}),
        ...(installationCommitted ? { installationCommitted: true as const } : {}),
        ...(installationPath ? { installPath: installationPath } : {}),
        ...(installSourceInFlight ? { installSourceInUse: true as const } : {}),
        ...(rejectedCapabilityReview ? { capabilityReview: rejectedCapabilityReview } : {}),
        error: error instanceof Error ? error.message : 'Failed to import extension',
        failedStage: currentStage,
      };
    } finally {
      try {
        if (installSourceInFlight && retainedInstallSourcePath) {
          console.warn(
            '[OpenClawExtensionImportService] Retaining install source after an unconfirmed native outcome:',
            retainedInstallSourcePath,
          );
        } else await cleanupInstallSource?.();
      } catch (error) {
        console.warn(
          '[OpenClawExtensionImportService] Failed to clean temporary install source:',
          error,
        );
      }
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
  createInstallSuccessPattern,
  isDirectoryLockError,
  isGatewayUnavailableError,
  isSupportedArchive,
  resolveExtractedPluginDirectory,
  runCommand,
  validateNativePluginDirectory,
};
