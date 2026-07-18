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
  InstalledOpenClawExtension,
} from '../../../shared/openclaw/extensions';
import type { OpenClawEngineManager } from '../../openclaw/runtime/openclawEngineManager';

const OPENCLAW_PLUGIN_MANIFEST = 'openclaw.plugin.json';
const SUPPORTED_ARCHIVE_EXTENSIONS = ['.zip', '.tar', '.tar.gz', '.tgz'];
const INSTALL_TIMEOUT_MS = 300_000;
const MAX_COMMAND_OUTPUT_CHARS = 64_000;
const OPENCLAW_UNINSTALL_SUCCESS_PATTERN = /(?:^|\r?\n)Uninstalled plugin\s+['"][^'"\r\n]+['"]/i;
const OPENCLAW_TOGGLE_SUCCESS_PATTERN =
  /(?:^|\r?\n)(?:Enabled|Disabled) plugin\s+['"][^'"\r\n]+['"]/i;

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
  runCommand?: (
    executable: string,
    args: string[],
    options: CommandOptions,
  ) => Promise<CommandResult>;
};

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

const validateNativePluginDirectory = (pluginDir: string): string | undefined => {
  if (!fs.existsSync(path.join(pluginDir, OPENCLAW_PLUGIN_MANIFEST))) {
    throw new Error(
      `Only native OpenClaw extensions are supported. The selected extension must contain ${OPENCLAW_PLUGIN_MANIFEST}.`,
    );
  }
  return readExtensionId(pluginDir);
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

const readJsonRecord = (filePath: string): Record<string, unknown> => {
  try {
    const value = JSON5.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
    return isRecord(value) ? value : {};
  } catch {
    return {};
  }
};

const getNestedValue = (value: unknown, dottedPath: string): unknown =>
  dottedPath.split('.').reduce<unknown>((current, segment) => {
    return isRecord(current) ? current[segment] : undefined;
  }, value);

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

const findMissingRequirements = (
  manager: OpenClawEngineManager,
  extensionId: string,
  manifest: Record<string, unknown>,
): string[] => {
  const setup = isRecord(manifest.setup) ? manifest.setup : {};
  const providers = Array.isArray(setup.providers) ? setup.providers : [];
  const requiredEnvVars = new Set<string>();
  for (const provider of providers) {
    if (!isRecord(provider) || !Array.isArray(provider.envVars)) continue;
    for (const envVar of provider.envVars) {
      if (typeof envVar === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(envVar)) {
        requiredEnvVars.add(envVar);
      }
    }
  }
  const legacyProviderEnvVars = isRecord(manifest.providerAuthEnvVars)
    ? manifest.providerAuthEnvVars
    : {};
  for (const envVars of Object.values(legacyProviderEnvVars)) {
    if (!Array.isArray(envVars)) continue;
    for (const envVar of envVars) {
      if (typeof envVar === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(envVar)) {
        requiredEnvVars.add(envVar);
      }
    }
  }
  if (requiredEnvVars.size === 0) return [];

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
  const hasSensitivePluginConfig = Object.entries(uiHints).some(
    ([configPath, hint]) =>
      isRecord(hint) &&
      hint.sensitive === true &&
      hasResolvedConfiguredValue(getNestedValue(pluginConfig, configPath)),
  );
  const configContracts = isRecord(manifest.configContracts) ? manifest.configContracts : {};
  const compatibilityPaths = Array.isArray(configContracts.compatibilityRuntimePaths)
    ? configContracts.compatibilityRuntimePaths
    : [];
  const hasCompatibilityConfig = compatibilityPaths.some(
    configPath =>
      typeof configPath === 'string' &&
      hasResolvedConfiguredValue(getNestedValue(config, configPath)),
  );
  if (hasSensitivePluginConfig || hasCompatibilityConfig) return [];

  return [...requiredEnvVars].filter(name => !isEnvConfigured(name));
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

  constructor(private readonly deps: OpenClawExtensionImportServiceDeps) {
    this.runCommand = deps.runCommand ?? runCommand;
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
        const manifestPath = path.join(installPath, OPENCLAW_PLUGIN_MANIFEST);
        if (!fs.existsSync(manifestPath)) return [];
        try {
          const manifest = readJsonRecord(manifestPath);
          const packagePath = path.join(installPath, 'package.json');
          const packageJson = fs.existsSync(packagePath) ? readJsonRecord(packagePath) : undefined;
          const id =
            typeof manifest.id === 'string' && manifest.id.trim() ? manifest.id.trim() : entry.name;
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
              missingRequirements: findMissingRequirements(manager, id, manifest),
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

  async delete(extensionId: string): Promise<{ success: boolean; error?: string }> {
    const installed = this.listInstalled().find(extension => extension.id === extensionId);
    if (!installed) return { success: false, error: 'Extension is not installed.' };

    const manager = this.deps.getOpenClawEngineManager();
    const wasRunning = manager.getStatus().phase === 'running';
    try {
      const cli = await manager.buildCliEnvironment();
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
      if (result.exitCode !== 0) {
        const error = formatCommandError(result);
        console.error('[OpenClawExtensionImportService] OpenClaw uninstaller failed:', error);
        return { success: false, error };
      }

      if (this.listInstalled().some(extension => extension.id === extensionId)) {
        return {
          success: false,
          error: 'OpenClaw reported success, but the extension is still installed.',
        };
      }

      if (wasRunning) {
        const status = await manager.restartGateway();
        if (status.phase !== 'running') {
          return {
            success: false,
            error:
              status.message || 'Extension removed, but the OpenClaw Gateway failed to restart.',
          };
        }
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
  ): Promise<{ success: boolean; error?: string }> {
    const installed = this.listInstalled().find(extension => extension.id === extensionId);
    if (!installed) return { success: false, error: 'Extension is not installed.' };
    if (installed.enabled === enabled) return { success: true };

    const manager = this.deps.getOpenClawEngineManager();
    const wasRunning = manager.getStatus().phase === 'running';
    try {
      const cli = await manager.buildCliEnvironment();
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

      if (wasRunning) {
        const status = await manager.restartGateway();
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
      const wasRunning = manager.getStatus().phase === 'running';
      const cli = await manager.buildCliEnvironment();
      const installArgs = [
        cli.openclawEntry,
        'plugins',
        'install',
        normalizedSourcePath,
        '--force',
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
      if (result.exitCode !== 0) {
        const failedStage = inferInstallerFailureStage(result, currentStage);
        console.error(
          '[OpenClawExtensionImportService] OpenClaw installer failed:',
          formatCommandError(result),
        );
        return {
          success: false,
          error: formatCommandError(result),
          failedStage,
        };
      }

      if (wasRunning) {
        reportProgress('restarting_gateway', 90);
        const status = await manager.restartGateway();
        if (status.phase !== 'running') {
          return {
            success: false,
            error:
              status.message || 'Extension installed, but the OpenClaw Gateway failed to restart.',
            failedStage: currentStage,
          };
        }
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
  isSupportedArchive,
  resolveExtractedPluginDirectory,
  runCommand,
  validateNativePluginDirectory,
};
