import { type ChildProcess,spawn } from 'child_process';
import crypto from 'crypto';
import { app, type UtilityProcess, utilityProcess } from 'electron';
import { EventEmitter } from 'events';
import fs from 'fs';
import net from 'net';
import path from 'path';

import { DEFAULT_OPENCLAW_GATEWAY_PORT } from '../../../shared/openclaw/constants';
import {
  GatewayPortSetErrorCode,
  validateGatewayPortNumber,
} from '../../../shared/openclaw/gatewayPort';
import type { SystemPromptReplacementRule } from '../../../shared/openclaw/systemPromptReplacements';
import { applyDependencyManagerConfigEnv } from '../../core/dependencyManagerConfig';
import { applyPortableGitRuntimeEnv } from '../../core/portableGitRuntime';
import { appendPythonRuntimeToEnv } from '../../core/pythonRuntime';
import {
  applyTrustedCertificateEnv,
  buildTrustedCaBundle,
} from '../../core/trustedCertificates';
import { syncLocalOpenClawExtensionsIntoRuntime } from '../../plugins/extensions';
import {
  appendNodeRequireOption,
  ensureElectronNodeShim,
  getElectronNodeRuntimePath,
  resolvePackagedNpmBinDir,
} from './electronNodeRuntime';
import { GatewayConfigReloadMonitor } from './gatewayConfigReloadMonitor';
import { GatewayStdoutLogFilter } from './gatewayLogFilter';
import { findAvailableLoopbackPort, isLoopbackPortAvailable } from './loopbackPort';
import { ensureOpenClawGatewayBundleLauncher } from './openclawGatewayBundleLauncher.cjs';
import { OPENCLAW_LAUNCHER_KEEP_ALIVE_SOURCE } from './openclawLauncher';
import {
  mergeRegisteredSystemPromptReplacementRules,
  normalizePersistedSystemPromptReplacementRules,
} from './systemPromptReplacementRegistry';

type GatewayProcess = UtilityProcess | ChildProcess;
type GatewayExitListener = (code: number | null, signal: NodeJS.Signals | null) => void;

const GATEWAY_PORT_SCAN_LIMIT = 80;
const GATEWAY_BOOT_TIMEOUT_MS = 300 * 1000;
const GATEWAY_MAX_RESTART_ATTEMPTS = 5;
const GATEWAY_RESTART_DELAYS = [3_000, 5_000, 10_000, 20_000, 30_000];

export type OpenClawEnginePhase =
  | 'ready'
  | 'starting'
  | 'running'
  | 'error';

export interface OpenClawEngineStatus {
  phase: OpenClawEnginePhase;
  version: string | null;
  progressPercent?: number;
  message?: string;
  canRetry: boolean;
}

export interface OpenClawGatewayConnectionInfo {
  version: string | null;
  port: number | null;
  token: string | null;
  url: string | null;
  clientEntryPath: string | null;
}

export interface OpenClawCliEnvironment {
  env: NodeJS.ProcessEnv;
  runtimeRoot: string;
  openclawEntry: string;
  port: number;
  token: string;
}

interface OpenClawEngineManagerEvents {
  status: (status: OpenClawEngineStatus) => void;
}

export type OpenClawEngineManagerOptions = {
  beginNetworkGeneration?: () => void;
  buildNetworkEnvironment?: (baseEnv: NodeJS.ProcessEnv) => NodeJS.ProcessEnv;
};

type RuntimeMetadata = {
  root: string | null;
  version: string | null;
  expectedPathHint: string;
};

const parseJsonFile = <T>(filePath: string): T | null => {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
};

const ensureDir = (dirPath: string): void => {
  fs.mkdirSync(dirPath, { recursive: true });
};

const findPath = (candidates: string[]): string | null => {
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
};

const isPortReachable = (host: string, port: number, timeoutMs = 1200): Promise<boolean> => {
  return new Promise(resolve => {
    const socket = new net.Socket();
    let settled = false;

    const done = (result: boolean) => {
      if (settled) return;
      settled = true;
      try {
        socket.destroy();
      } catch {
        // ignore
      }
      resolve(result);
    };

    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
    socket.connect(port, host);
  });
};

const isGatewayProcessAlive = (child: GatewayProcess | null): child is GatewayProcess => {
  if (!child) return false;
  if ('pid' in child && typeof child.pid === 'number') {
    // For ChildProcess, also check it hasn't already exited.
    if ('exitCode' in child && child.exitCode !== null) return false;
    return true;
  }
  return false;
};

const fetchWithTimeout = async (url: string, timeoutMs: number): Promise<Response> => {
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  try {
    return await fetch(url, {
      method: 'GET',
      signal: controller.signal,
      cache: 'no-store',
    });
  } finally {
    clearTimeout(timeout);
  }
};

export class OpenClawEngineManager extends EventEmitter {
  private readonly baseDir: string;
  private readonly logsDir: string;
  private readonly stateDir: string;
  private readonly gatewayTokenPath: string;
  private readonly gatewayPortPath: string;
  private readonly gatewayLogPath: string;
  private readonly configPath: string;
  private readonly systemPromptReplacementRulesPath: string;

  private desiredVersion: string | null;
  private status: OpenClawEngineStatus;
  private gatewayProcess: GatewayProcess | null = null;
  private readonly expectedGatewayExits = new WeakSet<object>();
  private gatewayRestartTimer: NodeJS.Timeout | null = null;
  private gatewayRestartAttempt = 0;
  private shutdownRequested = false;
  private gatewayPort: number | null = null;
  private startGatewayPromise: Promise<OpenClawEngineStatus> | null = null;
  private gatewayProcessGeneration = 0;
  private secretEnvVars: Record<string, string> = {};
  private gatewayPortListener: ((port: number | null) => void) | null = null;
  private readonly gatewayConfigReloadMonitor = new GatewayConfigReloadMonitor();
  private readonly buildNetworkEnvironment: (
    baseEnv: NodeJS.ProcessEnv,
  ) => NodeJS.ProcessEnv;
  private readonly beginNetworkGeneration: () => void;

  constructor(options: OpenClawEngineManagerOptions = {}) {
    super();

    this.buildNetworkEnvironment =
      options.buildNetworkEnvironment ?? (baseEnv => ({ ...baseEnv }));
    this.beginNetworkGeneration = options.beginNetworkGeneration ?? (() => undefined);

    const userDataPath = app.getPath('userData');
    this.baseDir = path.join(userDataPath, 'openclaw');
    this.logsDir = path.join(this.baseDir, 'logs');
    this.stateDir = path.join(this.baseDir, 'state');

    this.gatewayTokenPath = path.join(this.stateDir, 'gateway-token');
    this.gatewayPortPath = path.join(this.stateDir, 'gateway-port.json');
    this.gatewayLogPath = path.join(this.logsDir, 'gateway.log');
    this.configPath = path.join(this.stateDir, 'openclaw.json');
    this.systemPromptReplacementRulesPath = path.join(
      this.stateDir,
      'system-prompt-replacements.json',
    );

    ensureDir(this.baseDir);
    ensureDir(this.logsDir);
    ensureDir(this.stateDir);
    this.synchronizeRegisteredSystemPromptReplacementRules();

    const runtime = this.resolveRuntimeMetadata();
    this.desiredVersion = runtime.version;

    this.status = runtime.root && runtime.version
      ? {
          phase: 'ready',
          version: this.desiredVersion,
          message: 'OpenClaw runtime is ready.',
          canRetry: false,
        }
      : runtime.root
        ? {
            phase: 'error',
            version: null,
            message: `OpenClaw runtime version metadata is missing or invalid: ${runtime.root}`,
            canRetry: true,
          }
        : {
          phase: 'error',
          version: null,
          message: `Bundled OpenClaw runtime is missing. Expected: ${runtime.expectedPathHint}`,
          canRetry: true,
        };
  }

  /**
   * Set secret environment variables to inject into the gateway process.
   * These contain the plaintext values for `${VAR}` placeholders in openclaw.json.
   */
  setSecretEnvVars(vars: Record<string, string>): void {
    this.secretEnvVars = vars;
  }

  /** Return the current secret env vars snapshot (for change detection). */
  getSecretEnvVars(): Record<string, string> {
    return this.secretEnvVars;
  }

  /**
   * Return built-in registrations followed by ordered persisted replacements
   * applied only to the final system prompt.
   */
  getSystemPromptReplacementRules(): SystemPromptReplacementRule[] {
    if (!fs.existsSync(this.systemPromptReplacementRulesPath)) {
      return mergeRegisteredSystemPromptReplacementRules([]);
    }
    const parsed = parseJsonFile<unknown>(this.systemPromptReplacementRulesPath);
    if (parsed === null) {
      throw new Error('Failed to parse system prompt replacement rules');
    }
    return mergeRegisteredSystemPromptReplacementRules(
      normalizePersistedSystemPromptReplacementRules(parsed),
    );
  }

  /**
   * Validate and persist final system-prompt replacements. The Gateway reloads
   * this file at the next model turn, so a restart is not required.
   */
  setSystemPromptReplacementRules(rules: unknown): SystemPromptReplacementRule[] {
    const normalized = mergeRegisteredSystemPromptReplacementRules(
      normalizePersistedSystemPromptReplacementRules(rules),
    );
    this.writeSystemPromptReplacementRules(normalized);
    console.log(
      `[OpenClaw] Updated final system prompt replacement rules: count=${normalized.length}`,
    );
    return normalized;
  }

  private writeSystemPromptReplacementRules(
    rules: readonly SystemPromptReplacementRule[],
  ): void {
    fs.writeFileSync(
      this.systemPromptReplacementRulesPath,
      `${JSON.stringify(rules, null, 2)}\n`,
      'utf8',
    );
  }

  private synchronizeRegisteredSystemPromptReplacementRules(): void {
    try {
      const existing = fs.existsSync(this.systemPromptReplacementRulesPath)
        ? parseJsonFile<unknown>(this.systemPromptReplacementRulesPath)
        : [];
      if (existing === null) {
        console.warn(
          '[OpenClaw] Could not synchronize registered system prompt replacement rules: persisted rules are invalid JSON',
        );
        return;
      }
      const normalized = normalizePersistedSystemPromptReplacementRules(existing);
      const merged = mergeRegisteredSystemPromptReplacementRules(normalized);
      if (JSON.stringify(merged) !== JSON.stringify(normalized)) {
        this.writeSystemPromptReplacementRules(merged);
      }
    } catch (error) {
      console.warn(
        `[OpenClaw] Could not synchronize registered system prompt replacement rules: ${String(error)}`,
      );
    }
  }

  override on<U extends keyof OpenClawEngineManagerEvents>(
    event: U,
    listener: OpenClawEngineManagerEvents[U],
  ): this {
    return super.on(event, listener);
  }

  override emit<U extends keyof OpenClawEngineManagerEvents>(
    event: U,
    ...args: Parameters<OpenClawEngineManagerEvents[U]>
  ): boolean {
    return super.emit(event, ...args);
  }

  getStatus(): OpenClawEngineStatus {
    return { ...this.status };
  }

  getGatewayConfigReloadGeneration(): number {
    return this.gatewayConfigReloadMonitor.getGeneration();
  }

  waitForGatewayConfigReload(generation: number, timeoutMs?: number): Promise<boolean> {
    return this.gatewayConfigReloadMonitor.waitForReloadAfter(generation, timeoutMs);
  }

  getGatewayProcessGeneration(): number {
    return this.gatewayProcessGeneration;
  }

  getGatewayProcessId(): number | null {
    return this.gatewayProcess && 'pid' in this.gatewayProcess
      ? (this.gatewayProcess.pid ?? null)
      : null;
  }

  setExternalError(message: string): OpenClawEngineStatus {
    const runtime = this.resolveRuntimeMetadata();
    this.setStatus({
      phase: 'error',
      version: runtime.version || this.status.version || null,
      message: message.slice(0, 500),
      canRetry: true,
    });
    return this.getStatus();
  }

  getDesiredVersion(): string | null {
    return this.desiredVersion;
  }

  getBaseDir(): string {
    return this.baseDir;
  }

  getStateDir(): string {
    return this.stateDir;
  }

  getConfigPath(): string {
    return this.configPath;
  }

  getGatewayConnectionInfo(): OpenClawGatewayConnectionInfo {
    const runtime = this.resolveRuntimeMetadata();
    const port = this.gatewayPort ?? this.readGatewayPort();
    const token = this.readGatewayToken();
    const clientEntryPath = runtime.root ? this.resolveGatewayClientEntry(runtime.root) : null;

    return {
      version: runtime.version,
      port,
      token,
      url: port ? `ws://127.0.0.1:${port}` : null,
      clientEntryPath,
    };
  }

  async ensureReady(): Promise<OpenClawEngineStatus> {
    const runtime = this.resolveRuntimeMetadata();
    this.desiredVersion = runtime.version;

    if (!runtime.root) {
      this.setStatus({
        phase: 'error',
        version: null,
        message: `Bundled OpenClaw runtime is missing. Expected: ${runtime.expectedPathHint}`,
        canRetry: true,
      });
      return this.getStatus();
    }

    if (!runtime.version) {
      this.setStatus({
        phase: 'error',
        version: null,
        message: `OpenClaw runtime version metadata is missing or invalid: ${runtime.root}`,
        canRetry: true,
      });
      return this.getStatus();
    }

    const localExtensionSync = syncLocalOpenClawExtensionsIntoRuntime(runtime.root);
    if (localExtensionSync.copied.length > 0) {
      console.log(`[OpenClaw] synced local extensions: ${localExtensionSync.copied.join(', ')}`);
    }

    if (this.status.phase === 'running') {
      return this.getStatus();
    }

    this.setStatus({
      phase: 'ready',
      version: this.desiredVersion,
      message: 'OpenClaw runtime is ready.',
      canRetry: false,
    });
    return this.getStatus();
  }

  async startGateway(): Promise<OpenClawEngineStatus> {
    if (this.startGatewayPromise) {
      console.log('[OpenClaw] startGateway: already in progress, reusing existing promise');
      return this.startGatewayPromise;
    }
    this.startGatewayPromise = this.doStartGateway().finally(() => {
      this.startGatewayPromise = null;
    });
    return this.startGatewayPromise;
  }

  setGatewayPortListener(listener: ((port: number | null) => void) | null): void {
    this.gatewayPortListener = listener;
    listener?.(this.gatewayPort ?? this.readGatewayPort());
  }

  async buildCliEnvironment(): Promise<OpenClawCliEnvironment> {
    const ensured = await this.ensureReady();
    if (ensured.phase !== 'ready' && ensured.phase !== 'running') {
      throw new Error(ensured.message || 'OpenClaw runtime is not ready');
    }

    const runtime = this.resolveRuntimeMetadata();
    if (!runtime.root) {
      throw new Error(`Bundled OpenClaw runtime is missing. Expected: ${runtime.expectedPathHint}`);
    }
    if (!runtime.version) {
      throw new Error(`OpenClaw runtime version metadata is missing or invalid: ${runtime.root}`);
    }

    this.ensureBareEntryFiles(runtime.root);
    const openclawEntry = this.resolveOpenClawEntry(runtime.root);
    if (!openclawEntry) {
      throw new Error(`OpenClaw entry file is missing in runtime: ${runtime.root}.`);
    }

    const token = this.ensureGatewayToken();
    const port =
      this.status.phase === 'running'
        ? (this.gatewayPort ?? this.readGatewayPort() ?? DEFAULT_OPENCLAW_GATEWAY_PORT)
        : await this.resolveGatewayPort();
    this.gatewayPort = port;
    this.writeGatewayPort(port);
    // Update the parent proxy environment before copying it into the Gateway
    // environment below. Updating it only after the Gateway becomes healthy is
    // too late: the already-spawned process keeps its original NO_PROXY value.
    this.gatewayPortListener?.(port);
    this.ensureConfigFile();

    const compileCacheDir = path.join(this.stateDir, '.compile-cache');
    const electronNodeRuntimePath = getElectronNodeRuntimePath();
    const cliShimDir = this.ensureBundledCliShims();
    const userSkillsDir = path.join(this.stateDir, 'skills').replace(/\\/g, '/');
    const bundledSkillsDir = path.join(runtime.root, 'skills').replace(/\\/g, '/');

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      SKILLS_ROOT: userSkillsDir,
      JUSTDO_SKILLS_ROOT: userSkillsDir,
      OPENCLAW_BUNDLED_SKILLS_DIR: bundledSkillsDir,
      OPENCLAW_STATE_DIR: this.stateDir,
      OPENCLAW_CONFIG_PATH: this.configPath,
      OPENCLAW_GATEWAY_TOKEN: token,
      OPENCLAW_GATEWAY_PORT: String(port),
      OPENCLAW_NO_RESPAWN: '1',
      OPENCLAW_NO_AUTO_UPDATE: '1',
      OPENCLAW_OFFLINE: '1',
      OPENCLAW_ENGINE_VERSION: runtime.version,
      OPENCLAW_BUNDLED_PLUGINS_DIR: path.join(runtime.root, 'extensions'),
      OPENCLAW_LOG_LEVEL: app.isPackaged ? 'info' : 'debug',
      NODE_COMPILE_CACHE: compileCacheDir,
      JUSTDO_ELECTRON_PATH: electronNodeRuntimePath.replace(/\\/g, '/'),
      JUSTDO_OPENCLAW_ENTRY: openclawEntry.replace(/\\/g, '/'),
      ...this.secretEnvVars,
      JUSTDO_SYSTEM_PROMPT_REPLACEMENTS_PATH: this.systemPromptReplacementRulesPath,
    };

    if (!env.TZ) {
      const hostTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      if (hostTimezone) {
        env.TZ = hostTimezone;
      }
    }

    if (cliShimDir) {
      const currentPath = env.PATH || env.Path || '';
      env.PATH = [cliShimDir, currentPath].filter(Boolean).join(path.delimiter);
      if (process.platform === 'win32') {
        env.Path = env.PATH;
      }
    }

    appendPythonRuntimeToEnv(env as Record<string, string | undefined>);
    applyPortableGitRuntimeEnv(env as Record<string, string | undefined>);
    applyDependencyManagerConfigEnv(env, app.getPath('userData'));
    applyTrustedCertificateEnv(
      env,
      env.NODE_EXTRA_CA_CERTS || buildTrustedCaBundle(app.getPath('userData')),
    );

    const npmBinDir = app.isPackaged
      ? resolvePackagedNpmBinDir(process.resourcesPath)
      : (() => {
          const npmExecPath = process.env.npm_execpath?.trim();
          if (npmExecPath) {
            return path.dirname(npmExecPath);
          }
          const projectNpmBin = path.join(app.getAppPath(), 'node_modules', 'npm', 'bin');
          return fs.existsSync(projectNpmBin) ? projectNpmBin : undefined;
        })();
    const nodeShimDir = ensureElectronNodeShim(electronNodeRuntimePath, npmBinDir);
    if (nodeShimDir) {
      const curPath = env.PATH || env.Path || '';
      env.PATH = [nodeShimDir, curPath].filter(Boolean).join(path.delimiter);
      if (process.platform === 'win32') {
        env.Path = env.PATH;
        const windowsHidePreload = path.join(
          nodeShimDir,
          'hide-child-process-windows.cjs',
        ).replace(/\\/g, '/');
        env.JUSTDO_WINDOWS_HIDE_PRELOAD = windowsHidePreload;
        // Load this before OpenClaw imports child_process so direct Gateway
        // launches are covered. The Windows MCP package-runner patch also
        // restores this exact preload after the MCP environment sanitizer.
        env.NODE_OPTIONS = appendNodeRequireOption(env.NODE_OPTIONS, windowsHidePreload);
      }
      env.JUSTDO_NPM_BIN_DIR = npmBinDir || '';
    }

    return {
      env,
      runtimeRoot: runtime.root,
      openclawEntry,
      port,
      token,
    };
  }

  private async doStartGateway(): Promise<OpenClawEngineStatus> {
    this.shutdownRequested = false;
    const t0 = Date.now();
    const elapsed = () => `${Date.now() - t0}ms`;

    const ensured = await this.ensureReady();
    console.log(`[OpenClaw] startGateway: ensureReady done (${elapsed()}), phase=${ensured.phase}`);
    if (ensured.phase !== 'ready' && ensured.phase !== 'running') {
      return ensured;
    }

    if (isGatewayProcessAlive(this.gatewayProcess)) {
      const port = this.gatewayPort ?? this.readGatewayPort();
      if (port) {
        const healthy = await this.isGatewayHealthy(port);
        console.log(
          `[OpenClaw] startGateway: existing process health check (${elapsed()}), healthy=${healthy}`,
        );
        if (healthy) {
          if (this.status.phase !== 'running') {
            this.setStatus({
              phase: 'running',
              version: this.desiredVersion,
              message: `OpenClaw gateway is running on loopback:${port}.`,
              canRetry: false,
            });
          }
          return this.getStatus();
        }
      }

      await this.stopGatewayProcess(this.gatewayProcess);
      this.gatewayProcess = null;
    }

    const runtime = this.resolveRuntimeMetadata();
    console.log(
      `[OpenClaw] startGateway: resolveRuntimeMetadata done (${elapsed()}), root=${runtime.root ? 'found' : 'missing'}`,
    );
    if (!runtime.root) {
      this.setStatus({
        phase: 'error',
        version: null,
        message: `Bundled OpenClaw runtime is missing. Expected: ${runtime.expectedPathHint}`,
        canRetry: true,
      });
      return this.getStatus();
    }

    if (!runtime.version) {
      this.setStatus({
        phase: 'error',
        version: null,
        message: `OpenClaw runtime version metadata is missing or invalid: ${runtime.root}`,
        canRetry: true,
      });
      return this.getStatus();
    }

    this.beginNetworkGeneration();
    const cliEnvironment = await this.buildCliEnvironment();
    console.log(`[OpenClaw] buildCliEnvironment done (${elapsed()})`);
    const openclawEntry = cliEnvironment.openclawEntry;
    console.log(
      `[OpenClaw] startGateway: resolveOpenClawEntry done (${elapsed()}), entry=${openclawEntry}`,
    );
    const token = cliEnvironment.token;
    const port = cliEnvironment.port;
    const env = this.buildNetworkEnvironment(cliEnvironment.env);
    const gatewayEnv = {
      ...env,
      // Keep Gateway stdout stable across terminals and developer machines.
      // The log filter also strips control sequences as a defensive fallback.
      NO_COLOR: '1',
      FORCE_COLOR: '0',
    };
    console.log(`[OpenClaw] startGateway: pre-fork setup done (${elapsed()})`);

    this.setStatus({
      phase: 'starting',
      version: runtime.version,
      progressPercent: 10,
      message: 'Starting OpenClaw gateway...',
      canRetry: false,
    });

    // Debug: Log skills-related environment variables passed to Gateway
    console.log('[OpenClaw] Skills env vars passed to Gateway:', {
      OPENCLAW_STATE_DIR: this.stateDir,
      OPENCLAW_BUNDLED_SKILLS_DIR: env.OPENCLAW_BUNDLED_SKILLS_DIR,
      // OPENCLAW_HOME and OPENCLAW_USER_HOME are inherited from process.env (default user home)
      userSkillsDir: env.JUSTDO_SKILLS_ROOT,
      runtimeRoot: runtime.root,
      isPackaged: app.isPackaged,
    });

    const forkArgs = [
      'gateway',
      '--bind',
      'loopback',
      '--port',
      String(port),
      '--token',
      token,
      '--verbose',
    ];
    console.log(
      `[OpenClaw] forking gateway: entry=${openclawEntry}, cwd=${runtime.root}, port=${port}, args=${JSON.stringify(forkArgs)}`,
    );

    // On Windows, use child_process.spawn with ELECTRON_RUN_AS_NODE=1 instead of
    // utilityProcess.fork(). Benchmark shows utilityProcess has ~5x overhead for
    // cold ESM compilation on Windows (163s vs 34s for a 28MB bundle).
    let child: GatewayProcess;
    if (process.platform === 'win32') {
      child = spawn(process.execPath, [openclawEntry, ...forkArgs], {
        cwd: runtime.root,
        env: { ...gatewayEnv, ELECTRON_RUN_AS_NODE: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } else {
      child = utilityProcess.fork(openclawEntry, forkArgs, {
        cwd: runtime.root,
        env: gatewayEnv,
        stdio: 'pipe',
        serviceName: 'OpenClaw Gateway',
      });
    }
    console.log(
      `[OpenClaw] startGateway: gateway process created (${elapsed()}), platform=${process.platform}`,
    );

    this.gatewayProcess = child;
    this.gatewayProcessGeneration += 1;
    this.attachGatewayProcessLogs(child);
    this.attachGatewayExitHandlers(child);

    // Wait for the spawn event to confirm the process started (pid becomes available).
    child.once('spawn', () => {
      console.log(`[OpenClaw] gateway process spawned (${elapsed()}), pid=${child.pid}`);
    });

    const ready = await this.waitForGatewayReady(port, GATEWAY_BOOT_TIMEOUT_MS);
    console.log(
      `[OpenClaw] startGateway: waitForGatewayReady returned (${elapsed()}), ready=${ready}`,
    );
    if (!ready) {
      this.setStatus({
        phase: 'error',
        version: runtime.version,
        message: 'OpenClaw gateway failed to become healthy in time.',
        canRetry: true,
      });
      this.stopGatewayProcess(child);
      return this.getStatus();
    }

    console.log(`[OpenClaw] startGateway: gateway is running, total startup time: ${elapsed()}`);
    // Reset restart counter on successful start — gateway is healthy
    this.gatewayRestartAttempt = 0;
    this.setStatus({
      phase: 'running',
      version: runtime.version,
      progressPercent: 100,
      message: `OpenClaw gateway is running on loopback:${port}.`,
      canRetry: false,
    });
    this.gatewayPortListener?.(port);

    return this.getStatus();
  }

  async stopGateway(): Promise<void> {
    this.shutdownRequested = true;

    if (this.gatewayRestartTimer) {
      clearTimeout(this.gatewayRestartTimer);
      this.gatewayRestartTimer = null;
    }

    if (this.gatewayProcess) {
      console.log('[OpenClaw] stopping gateway process...');
      await this.stopGatewayProcess(this.gatewayProcess);
      console.log('[OpenClaw] gateway process stopped');
      this.gatewayProcess = null;
    }

    const runtime = this.resolveRuntimeMetadata();
    this.setStatus({
      phase: runtime.root && runtime.version ? 'ready' : 'error',
      version: runtime.version,
      message:
        runtime.root && !runtime.version
          ? `OpenClaw runtime version metadata is missing or invalid: ${runtime.root}`
          : runtime.root
        ? 'OpenClaw runtime is ready. Gateway is stopped.'
        : `Bundled OpenClaw runtime is missing. Expected: ${runtime.expectedPathHint}`,
      canRetry: !runtime.root || !runtime.version,
    });
    this.gatewayPortListener?.(null);
  }

  async restartGateway(): Promise<OpenClawEngineStatus> {
    console.log('[OpenClaw] restartGateway: stopping existing gateway...');
    await this.stopGateway();
    // Reset restart counter on manual restart so user can always retry
    this.gatewayRestartAttempt = 0;
    console.log('[OpenClaw] restartGateway: starting gateway with new env...');
    return this.startGateway();
  }

  private resolveRuntimeMetadata(): RuntimeMetadata {
    const candidateRoots = app.isPackaged
      ? [path.join(process.resourcesPath, 'cfmind')]
      : [
          path.join(app.getAppPath(), 'vendor', 'openclaw-runtime', 'current'),
          path.join(process.cwd(), 'vendor', 'openclaw-runtime', 'current'),
        ];

    const runtimeRoot = findPath(candidateRoots);
    const expectedPathHint = app.isPackaged
      ? path.join(process.resourcesPath, 'cfmind')
      : path.join(app.getAppPath(), 'vendor', 'openclaw-runtime', 'current');

    if (!runtimeRoot) {
      return {
        root: null,
        version: null,
        expectedPathHint,
      };
    }

    return {
      root: runtimeRoot,
      version: this.readRuntimeVersion(runtimeRoot),
      expectedPathHint,
    };
  }

  private readRuntimeVersion(runtimeRoot: string): string | null {
    const fromRootPackage = parseJsonFile<{ version?: string }>(
      path.join(runtimeRoot, 'package.json'),
    )?.version;
    if (typeof fromRootPackage === 'string' && fromRootPackage.trim()) {
      return fromRootPackage.trim();
    }

    const fromOpenClawPackage = parseJsonFile<{ version?: string }>(
      path.join(runtimeRoot, 'node_modules', 'openclaw', 'package.json'),
    )?.version;
    if (typeof fromOpenClawPackage === 'string' && fromOpenClawPackage.trim()) {
      return fromOpenClawPackage.trim();
    }

    const fromBuildInfo = parseJsonFile<{ version?: string }>(
      path.join(runtimeRoot, 'runtime-build-info.json'),
    )?.version;
    if (typeof fromBuildInfo === 'string' && fromBuildInfo.trim()) {
      return fromBuildInfo.trim();
    }

    return null;
  }

  private ensureBareEntryFiles(runtimeRoot: string): void {
    const t0 = Date.now();

    // Fast path: if gateway-bundle.mjs exists, skip full dist extraction.
    // The bundle is the primary entry; dist/ modules are only needed as fallback.
    const bundlePath = path.join(runtimeRoot, 'gateway-bundle.mjs');
    if (fs.existsSync(bundlePath)) {
      console.log('[OpenClaw] ensureBareEntryFiles: bundle exists, skipping dist extraction');
      this.ensureControlUiFiles(runtimeRoot);
      console.log(`[OpenClaw] ensureBareEntryFiles: completed in ${Date.now() - t0}ms`);
      return;
    }

    console.log('[OpenClaw] ensureBareEntryFiles: no bundle found, checking bare files');
    const bareEntry = path.join(runtimeRoot, 'openclaw.mjs');
    const bareDistEntry = path.join(runtimeRoot, 'dist', 'entry.js');

    if (fs.existsSync(bareEntry) && fs.existsSync(bareDistEntry)) {
      return;
    }

    const asarRoot = path.join(runtimeRoot, 'gateway.asar');
    const asarEntry = path.join(asarRoot, 'openclaw.mjs');
    if (!fs.existsSync(asarEntry)) {
      return;
    }

    console.log('[OpenClaw] ensureBareEntryFiles: extracting from gateway.asar (no bundle)');

    try {
      if (!fs.existsSync(bareEntry)) {
        fs.writeFileSync(bareEntry, fs.readFileSync(asarEntry));
        console.log('[OpenClaw] Extracted openclaw.mjs');
      }

      const asarDist = path.join(asarRoot, 'dist');
      const bareDist = path.join(runtimeRoot, 'dist');
      if (fs.existsSync(asarDist) && !fs.existsSync(bareDistEntry)) {
        this.copyDirFromAsar(asarDist, bareDist);
        console.log('[OpenClaw] Extracted dist/');
      }

      console.log('[OpenClaw] Entry files extracted successfully.');
    } catch (err) {
      console.error('[OpenClaw] Failed to extract entry files from gateway.asar:', err);
    }
  }

  /**
   * Extract only dist/control-ui/ from gateway.asar if not already on disk.
   * The control-ui directory contains static HTML/CSS/JS assets served by the
   * gateway's admin UI and must exist as bare files on the filesystem.
   */
  private ensureControlUiFiles(runtimeRoot: string): void {
    const controlUiIndex = path.join(runtimeRoot, 'dist', 'control-ui', 'index.html');
    if (fs.existsSync(controlUiIndex)) {
      return;
    }

    const asarControlUi = path.join(runtimeRoot, 'gateway.asar', 'dist', 'control-ui');
    if (!fs.existsSync(asarControlUi)) {
      // control-ui may already exist as bare files from the runtime install (see install-openclaw-runtime.cjs)
      return;
    }

    console.log('[OpenClaw] Extracting dist/control-ui/ from gateway.asar...');
    try {
      this.copyDirFromAsar(asarControlUi, path.join(runtimeRoot, 'dist', 'control-ui'));
      console.log('[OpenClaw] Extracted dist/control-ui/');
    } catch (err) {
      console.error('[OpenClaw] Failed to extract dist/control-ui/ from gateway.asar:', err);
    }
  }

  private ensureBundledCliShims(): string | null {
    const shimDir = path.join(this.stateDir, 'bin');
    const shellWrapper = [
      '#!/usr/bin/env bash',
      'if [ -z "${JUSTDO_OPENCLAW_ENTRY:-}" ]; then',
      '  echo "JUSTDO_OPENCLAW_ENTRY is not set" >&2',
      '  exit 127',
      'fi',
      'if [ -n "${JUSTDO_ELECTRON_PATH:-}" ]; then',
      '  exec env ELECTRON_RUN_AS_NODE=1 "${JUSTDO_ELECTRON_PATH}" "${JUSTDO_OPENCLAW_ENTRY}" "$@"',
      'fi',
      'if command -v node >/dev/null 2>&1; then',
      '  exec node "${JUSTDO_OPENCLAW_ENTRY}" "$@"',
      'fi',
      'echo "Neither JUSTDO_ELECTRON_PATH nor node is available for OpenClaw CLI." >&2',
      'exit 127',
      '',
    ].join('\n');
    const windowsWrapper = [
      '@echo off',
      'if "%JUSTDO_OPENCLAW_ENTRY%"=="" (',
      '  echo JUSTDO_OPENCLAW_ENTRY is not set 1>&2',
      '  exit /b 127',
      ')',
      'for /f "delims=" %%N in (\'where.exe node.exe 2^>nul\') do (',
      '  "%%N" "%JUSTDO_OPENCLAW_ENTRY%" %*',
      '  exit /b %ERRORLEVEL%',
      ')',
      'if not "%JUSTDO_ELECTRON_PATH%"=="" (',
      '  set ELECTRON_RUN_AS_NODE=1',
      '  "%JUSTDO_ELECTRON_PATH%" "%JUSTDO_OPENCLAW_ENTRY%" %*',
      '  exit /b %ERRORLEVEL%',
      ')',
      'echo Neither node.exe nor JUSTDO_ELECTRON_PATH is available for OpenClaw CLI. 1>&2',
      'exit /b 127',
      '',
    ].join('\r\n');

    try {
      ensureDir(shimDir);
      for (const commandName of ['openclaw', 'claw']) {
        const shellPath = path.join(shimDir, commandName);
        const existingShell = fs.existsSync(shellPath) ? fs.readFileSync(shellPath, 'utf8') : '';
        if (existingShell !== shellWrapper) {
          fs.writeFileSync(shellPath, shellWrapper, 'utf8');
          fs.chmodSync(shellPath, 0o755);
        }

        if (process.platform === 'win32') {
          const cmdPath = path.join(shimDir, `${commandName}.cmd`);
          const existingCmd = fs.existsSync(cmdPath) ? fs.readFileSync(cmdPath, 'utf8') : '';
          if (existingCmd !== windowsWrapper) {
            fs.writeFileSync(cmdPath, windowsWrapper, 'utf8');
          }
        }
      }

      return shimDir;
    } catch (error) {
      console.error('[OpenClaw] Failed to prepare CLI shims:', error);
      return null;
    }
  }

  private copyDirFromAsar(srcDir: string, destDir: string): void {
    fs.mkdirSync(destDir, { recursive: true });
    const entries = fs.readdirSync(srcDir, { withFileTypes: true });
    for (const entry of entries) {
      const srcPath = path.join(srcDir, entry.name);
      const destPath = path.join(destDir, entry.name);
      if (entry.isDirectory()) {
        this.copyDirFromAsar(srcPath, destPath);
      } else {
        fs.writeFileSync(destPath, fs.readFileSync(srcPath));
      }
    }
  }

  private resolveOpenClawEntry(runtimeRoot: string): string | null {
    // Bundle fast-path via CJS launcher is only needed on Windows where
    // utilityProcess.fork() cannot load ESM directly. On macOS/Linux,
    // ensureBareEntryFiles already skips extraction when bundle exists,
    // but this method falls through to gateway.asar/openclaw.mjs which
    // ESM loads directly without a CJS wrapper.
    if (process.platform === 'win32') {
      const bundlePath = path.join(runtimeRoot, 'gateway-bundle.mjs');
      if (fs.existsSync(bundlePath)) {
        console.log('[OpenClaw] resolveOpenClawEntry: using bundle fast path');
        return this.ensureGatewayLauncherCjsForBundle(runtimeRoot);
      }
    }

    const esmEntry = findPath([
      path.join(runtimeRoot, 'openclaw.mjs'),
      path.join(runtimeRoot, 'dist', 'entry.js'),
      path.join(runtimeRoot, 'dist', 'entry.mjs'),
      path.join(runtimeRoot, 'gateway.asar', 'openclaw.mjs'),
    ]);
    if (!esmEntry) return null;

    // On Windows, utilityProcess.fork() cannot load ESM modules directly because
    // the ESM loader misinterprets the drive letter (e.g. "D:") as a URL scheme.
    // Work around this by generating a CJS wrapper that imports the ESM entry via file:// URL.
    if (process.platform === 'win32') {
      return this.ensureGatewayLauncherCjs(runtimeRoot, esmEntry);
    }
    return esmEntry;
  }

  private ensureGatewayLauncherCjs(runtimeRoot: string, esmEntry: string): string {
    const launcherPath = path.join(runtimeRoot, 'gateway-launcher.cjs');
    const esmBasename = path.basename(esmEntry);
    const expectedContent =
      `// Auto-generated CJS wrapper for Windows ESM compatibility.\n` +
      `// On Windows, Electron utilityProcess.fork() cannot load ESM modules directly\n` +
      `// because the drive letter (e.g. "D:") is misinterpreted as a URL scheme.\n` +
      `const { pathToFileURL } = require('node:url');\n` +
      `const path = require('node:path');\n` +
      `const fs = require('node:fs');\n` +
      `// Enable V8 compile cache to speed up subsequent startups.\n` +
      `// Cache is stored per-user so it survives app restarts and reboots.\n` +
      `try {\n` +
      `  const { enableCompileCache } = require('node:module');\n` +
      `  const ccDir = path.join(process.env.OPENCLAW_STATE_DIR || __dirname, '.compile-cache');\n` +
      `  enableCompileCache(ccDir);\n` +
      `  process.stderr.write('[openclaw-launcher] compile-cache dir=' + require('node:module').getCompileCacheDir() + '\\n');\n` +
      `} catch (_) {}\n` +
      `const esmEntry = path.join(__dirname, '${esmBasename}');\n` +
      `// Patch argv so openclaw's isMainModule() recognizes this as the main entry.\n` +
      `// In standard Node.js: process.argv = [execPath, scriptPath, ...args]\n` +
      `// In Electron utilityProcess: process.argv = [execPath, ...args] (no scriptPath)\n` +
      `// We must detect which layout we have to avoid overwriting the 'gateway' command arg.\n` +
      `// Use fs.realpathSync to resolve symlinks/junctions so that e.g.\n` +
      `// "...current/gateway-launcher.cjs" (junction) matches "...win-x64/gateway-launcher.cjs".\n` +
      `const _realpath = (p) => { try { return fs.realpathSync(path.resolve(p)); } catch { return path.resolve(p); } };\n` +
      `const _launcherInArgv = process.argv[1] &&\n` +
      `  _realpath(process.argv[1]).toLowerCase() === _realpath(__filename).toLowerCase();\n` +
      `if (_launcherInArgv) {\n` +
      `  process.argv[1] = esmEntry;\n` +
      `} else {\n` +
      `  process.argv.splice(1, 0, esmEntry);\n` +
      `}\n` +
      `process.stderr.write('[openclaw-launcher] argv=' + JSON.stringify(process.argv) + '\\n');\n` +
      `process.stderr.write('[openclaw-launcher] node=' + process.versions.node + '\\n');\n` +
      `// Only the long-running gateway command needs an explicit event-loop handle.\n` +
      `// One-shot CLI commands (for example memory search/index/status) must be\n` +
      `// allowed to exit after their asynchronous work completes.\n` +
      OPENCLAW_LAUNCHER_KEEP_ALIVE_SOURCE +
      `const t0 = Date.now();\n` +
      `// Strategy 1: Try the esbuild single-file bundle via dynamic import().\n` +
      `// The bundle collapses ~1100 ESM modules into one file, eliminating the\n` +
      `// expensive ESM module resolution overhead in Electron's utilityProcess.\n` +
      `// We use import() (not require()) to avoid the ESM loader re-entrancy lock\n` +
      `// that causes microtask deadlocks when require(esm) is used.\n` +
      `const bundlePath = path.join(__dirname, 'gateway-bundle.mjs');\n` +
      `if (fs.existsSync(bundlePath)) {\n` +
      `  // Patch argv[1] to the bundle path so openclaw's isMainModule() matches.\n` +
      `  // isMainModule compares basename(import.meta.url) with basename(argv[1]);\n` +
      `  // both will be "gateway-bundle.mjs", satisfying the basename equality check.\n` +
      `  // argv[1] was already patched to esmEntry above; just overwrite it.\n` +
      `  process.argv[1] = bundlePath;\n` +
      `  process.stderr.write('[openclaw-launcher] argv(patched for bundle)=' + JSON.stringify(process.argv) + '\\n');\n` +
      `  const bundleUrl = pathToFileURL(bundlePath).href;\n` +
      `  process.stderr.write('[openclaw-launcher] loading bundle via import(): ' + bundleUrl + '\\n');\n` +
      `  import(bundleUrl).then(() => {\n` +
      `    process.stderr.write('[openclaw-launcher] import(gateway-bundle.mjs) ok (' + (Date.now() - t0) + 'ms)\\n');\n` +
      `    try { require('node:module').flushCompileCache(); } catch (_) {}\n` +
      `  }).catch((err) => {\n` +
      `    process.stderr.write('[openclaw-launcher] import(gateway-bundle.mjs) failed (' + (Date.now() - t0) + 'ms): ' + (err.stack || err) + '\\n');\n` +
      `    process.stderr.write('[openclaw-launcher] Falling back to multi-file dist...\\n');\n` +
      `    return _loadFallback();\n` +
      `  });\n` +
      `} else {\n` +
      `  _loadFallback();\n` +
      `}\n` +
      `// Fallback: load the original multi-file dist.\n` +
      `function _loadFallback() {\n` +
      `  try {\n` +
      `    try {\n` +
      `      const wf = require('./dist/warning-filter.js');\n` +
      `      if (typeof wf.installProcessWarningFilter === 'function') {\n` +
      `        wf.installProcessWarningFilter();\n` +
      `      }\n` +
      `    } catch (_) {}\n` +
      `    require('./dist/entry.js');\n` +
      `    process.stderr.write('[openclaw-launcher] require(entry.js) ok (' + (Date.now() - t0) + 'ms)\\n');\n` +
      `    try { require('node:module').flushCompileCache(); } catch (_) {}\n` +
      `  } catch (err) {\n` +
      `    process.stderr.write('[openclaw-launcher] require(entry.js) failed (' + (Date.now() - t0) + 'ms): ' + err.message + '\\n');\n` +
      `    const entryPath = path.join(__dirname, 'dist', 'entry.js');\n` +
      `    const importUrl = pathToFileURL(entryPath).href;\n` +
      `    process.stderr.write('[openclaw-launcher] falling back to import(): ' + importUrl + '\\n');\n` +
      `    import(importUrl).then(() => {\n` +
      `      process.stderr.write('[openclaw-launcher] import() ok (' + (Date.now() - t0) + 'ms)\\n');\n` +
      `    }).catch((err2) => {\n` +
      `      process.stderr.write('[openclaw-launcher] ERROR (' + (Date.now() - t0) + 'ms): ' + (err2.stack || err2) + '\\n');\n` +
      `      process.exit(1);\n` +
      `    });\n` +
      `  }\n` +
      `}\n`;

    try {
      const existing = fs.existsSync(launcherPath) ? fs.readFileSync(launcherPath, 'utf8') : '';
      if (existing !== expectedContent) {
        fs.writeFileSync(launcherPath, expectedContent, 'utf8');
        console.log(`[OpenClaw] Generated gateway-launcher.cjs for Windows ESM compat`);
      }
    } catch (err) {
      console.error('[OpenClaw] Failed to write gateway-launcher.cjs:', err);
      return esmEntry;
    }
    return launcherPath;
  }

  /**
   * Generate a simplified CJS launcher that loads gateway-bundle.mjs directly.
   * Unlike ensureGatewayLauncherCjs(), this version does not include a fallback
   * to dist/entry.js because the bundle is guaranteed to exist.
   */
  private ensureGatewayLauncherCjsForBundle(runtimeRoot: string): string {
    try {
      const result = ensureOpenClawGatewayBundleLauncher(runtimeRoot);
      if (result.changed) {
        if (result.replaced) {
          console.log(
            '[OpenClaw] Overwriting existing gateway-launcher.cjs (switching to bundle-only mode)',
          );
        }
        console.log('[OpenClaw] Generated gateway-launcher.cjs for bundle-only mode');
      }
      return result.launcherPath;
    } catch (err) {
      console.error('[OpenClaw] Failed to write gateway-launcher.cjs:', err);
      // Fall back to the legacy launcher generation
      const esmEntry = findPath([
        path.join(runtimeRoot, 'openclaw.mjs'),
        path.join(runtimeRoot, 'gateway.asar', 'openclaw.mjs'),
      ]);
      if (esmEntry) return this.ensureGatewayLauncherCjs(runtimeRoot, esmEntry);
      return path.join(runtimeRoot, 'gateway-launcher.cjs');
    }
  }

  private resolveGatewayClientEntry(runtimeRoot: string): string | null {
    const distRoots = [
      path.join(runtimeRoot, 'dist'),
      path.join(runtimeRoot, 'gateway.asar', 'dist'),
    ];

    for (const distRoot of distRoots) {
      const clientEntry = this.findGatewayClientEntryFromDistRoot(distRoot);
      if (clientEntry) {
        return clientEntry;
      }
    }

    return null;
  }

  private findGatewayClientEntryFromDistRoot(distRoot: string): string | null {
    const gatewayClient = path.join(distRoot, 'gateway', 'client.js');
    if (fs.existsSync(gatewayClient)) {
      return gatewayClient;
    }

    const directClient = path.join(distRoot, 'client.js');
    if (fs.existsSync(directClient)) {
      return directClient;
    }

    try {
      if (!fs.existsSync(distRoot) || !fs.statSync(distRoot).isDirectory()) {
        return null;
      }

      const candidates = fs
        .readdirSync(distRoot)
        .filter(name => /^client(?:-.*)?\.js$/i.test(name))
        .sort();

      // v2026.4.11+ bundles multiple client modules (Slack, Gateway, etc.)
      // with hashed filenames. We need to find the one that actually exports
      // GatewayClient by checking each candidate's exports.
      for (const candidate of candidates) {
        const fullPath = path.join(distRoot, candidate);
        try {
           
          const loaded = require(fullPath) as Record<string, unknown>;
          // Check if GatewayClient is directly exported or exported as 't' (minified)
          if (typeof loaded.GatewayClient === 'function') {
            return fullPath;
          }
          // In minified builds, GatewayClient might be exported as 't'
          const ctor = loaded.t;
          if (typeof ctor === 'function' && ctor.name === 'GatewayClient') {
            return fullPath;
          }
          // Fallback: check prototype methods
          if (
            typeof ctor === 'function' &&
            ctor.prototype &&
            typeof ctor.prototype.start === 'function' &&
            typeof ctor.prototype.stop === 'function' &&
            typeof ctor.prototype.request === 'function'
          ) {
            return fullPath;
          }
        } catch {
          // Skip modules that fail to load
          continue;
        }
      }
    } catch {
      // ignore
    }

    return null;
  }

  private ensureGatewayToken(): string {
    try {
      const existing = fs.readFileSync(this.gatewayTokenPath, 'utf8').trim();
      if (existing) {
        return existing;
      }
    } catch {
      // ignore
    }

    const token = crypto.randomBytes(24).toString('hex');
    ensureDir(path.dirname(this.gatewayTokenPath));
    fs.writeFileSync(this.gatewayTokenPath, token, 'utf8');
    return token;
  }

  getGatewayToken(): string | null {
    return this.readGatewayToken();
  }

  getGatewayPort(): number {
    return this.gatewayPort ?? this.readGatewayPort() ?? DEFAULT_OPENCLAW_GATEWAY_PORT;
  }

  getConfiguredGatewayPort(): number {
    return this.readGatewayPort() ?? this.gatewayPort ?? DEFAULT_OPENCLAW_GATEWAY_PORT;
  }

  async setGatewayPort(port: number): Promise<{
    success: boolean;
    error?: string;
    errorCode?: GatewayPortSetErrorCode;
    requiresRestart?: boolean;
  }> {
    const validation = validateGatewayPortNumber(port);
    if (validation.valid === false) {
      return {
        success: false,
        errorCode: GatewayPortSetErrorCode.Invalid,
        error: validation.code,
      };
    }
    if (this.status.phase === 'starting') {
      return {
        success: false,
        errorCode: GatewayPortSetErrorCode.Busy,
        error: 'The gateway is starting. Try again after startup completes.',
      };
    }

    const activePort = this.gatewayPort;
    const isCurrentRunningPort = this.status.phase === 'running' && port === activePort;
    if (!isCurrentRunningPort && !(await isLoopbackPortAvailable(port))) {
      return {
        success: false,
        errorCode: GatewayPortSetErrorCode.Unavailable,
        error: `Loopback port ${port} is already in use or reserved.`,
      };
    }

    try {
      this.writeGatewayPort(port);
      const requiresRestart = this.status.phase === 'running' && port !== activePort;
      if (!requiresRestart) {
        this.gatewayPort = port;
        this.gatewayPortListener?.(port);
      }
      return { success: true, requiresRestart };
    } catch (err) {
      return {
        success: false,
        errorCode: GatewayPortSetErrorCode.SaveFailed,
        error: err instanceof Error ? err.message : 'Failed to save port setting',
      };
    }
  }

  private readGatewayToken(): string | null {
    try {
      const token = fs.readFileSync(this.gatewayTokenPath, 'utf8').trim();
      return token || null;
    } catch {
      return null;
    }
  }

  private ensureConfigFile(): void {
    ensureDir(path.dirname(this.configPath));
    // Gateway managed skills directory is stateDir/skills (userData/openclaw/state/skills)
    // This is where user-imported skills are stored.
    const userSkillsDir = path.join(this.stateDir, 'skills').replace(/\\/g, '/');

    if (!fs.existsSync(this.configPath)) {
      fs.writeFileSync(
        this.configPath,
        JSON.stringify(
          {
            gateway: { mode: 'local' },
            skills: {
              load: {
                extraDirs: [userSkillsDir],
              },
            },
          },
          null,
          2,
        ) + '\n',
        'utf8',
      );
      return;
    }
    // Ensure gateway.mode is set and skills.load.extraDirs includes user skills
    try {
      const raw = fs.readFileSync(this.configPath, 'utf8');
      const config = JSON.parse(raw);
      if (!config.gateway?.mode) {
        config.gateway = { ...config.gateway, mode: 'local' };
      }
      // Ensure user skills directory (stateDir/skills) is in extraDirs
      if (!config.skills?.load?.extraDirs) {
        config.skills = {
          ...config.skills,
          load: {
            ...config.skills?.load,
            extraDirs: [userSkillsDir],
          },
        };
      } else if (!config.skills.load.extraDirs.includes(userSkillsDir)) {
        config.skills.load.extraDirs = [...config.skills.load.extraDirs, userSkillsDir];
      }
      fs.writeFileSync(this.configPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
    } catch {
      // ignore parse errors
    }
  }

  private writeGatewayPort(port: number): void {
    fs.writeFileSync(
      this.gatewayPortPath,
      JSON.stringify({ port, updatedAt: Date.now() }, null, 2),
      'utf8',
    );
  }

  private readGatewayPort(): number | null {
    const payload = parseJsonFile<{ port?: number }>(this.gatewayPortPath);
    if (!payload) return null;
    const validation = validateGatewayPortNumber(payload.port);
    return validation.valid === true ? validation.port : null;
  }

  private async resolveGatewayPort(): Promise<number> {
    const preferredPorts: number[] = [];

    const persisted = this.readGatewayPort();
    if (persisted) preferredPorts.push(persisted);
    if (this.gatewayPort) preferredPorts.push(this.gatewayPort);
    preferredPorts.push(DEFAULT_OPENCLAW_GATEWAY_PORT);
    preferredPorts.push(
      ...Array.from(
        { length: GATEWAY_PORT_SCAN_LIMIT },
        (_, index) => DEFAULT_OPENCLAW_GATEWAY_PORT + index + 1,
      ),
    );

    const availablePort = await findAvailableLoopbackPort(preferredPorts);
    if (availablePort !== null) return availablePort;

    throw new Error('No available loopback port for OpenClaw gateway.');
  }

  private async isGatewayHealthy(port: number, verbose = false): Promise<boolean> {
    const probeUrls = [
      `http://127.0.0.1:${port}/health`,
      `http://127.0.0.1:${port}/healthz`,
      `http://127.0.0.1:${port}/ready`,
      `http://127.0.0.1:${port}/`,
    ];

    // Run all HTTP probes in parallel and resolve as soon as any succeeds.
    // Previously these ran sequentially, costing up to 4*1200ms per tick.
    const httpResults: string[] = [];
    const httpProbes = probeUrls.map(async (url, i) => {
      try {
        const response = await fetchWithTimeout(url, 1500);
        if (verbose) httpResults[i] = `${url} -> ${response.status}`;
        if (response.status < 500) return true;
      } catch (err) {
        if (verbose) httpResults[i] = `${url} -> ${(err as Error).message || err}`;
      }
      return false;
    });

    const results = await Promise.all(httpProbes);
    const healthy = results.some(Boolean);
    if (verbose && !healthy) {
      const tcpResult = (await isPortReachable('127.0.0.1', port, 1500))
        ? 'reachable'
        : 'unreachable';
      console.log(`[OpenClaw] health probe details: http=not-ready, tcp=${tcpResult}, ${httpResults.join(', ')}`);
    }
    return healthy;
  }

  private waitForGatewayReady(port: number, timeoutMs: number): Promise<boolean> {
    const startedAt = Date.now();
    let pollCount = 0;
    return new Promise(resolve => {
      const tick = async () => {
        if (this.shutdownRequested) {
          console.log('[OpenClaw] waitForGatewayReady: shutdown requested, giving up');
          resolve(false);
          return;
        }

        if (!this.gatewayProcess) {
          console.log(
            '[OpenClaw] waitForGatewayReady: gateway process is gone (exited early), giving up',
          );
          resolve(false);
          return;
        }

        pollCount += 1;
        const elapsedMs = Date.now() - startedAt;

        // Log verbose probe details every 10 polls (~6s) to diagnose health check failures.
        const verboseProbe = pollCount % 10 === 0;
        const healthy = await this.isGatewayHealthy(port, verboseProbe);
        if (healthy) {
          console.log(
            `[OpenClaw] waitForGatewayReady: gateway healthy after ${elapsedMs}ms (${pollCount} polls)`,
          );
          resolve(true);
          return;
        }

        if (elapsedMs >= timeoutMs) {
          console.log(
            `[OpenClaw] waitForGatewayReady: timed out after ${timeoutMs}ms (${pollCount} polls)`,
          );
          resolve(false);
          return;
        }

        // Update progress from 10% → 90% during the wait, so the UI shows meaningful feedback.
        const progress = Math.min(90, 10 + Math.round((elapsedMs / timeoutMs) * 80));
        this.setStatus({
          phase: 'starting',
          version: this.status.version,
          progressPercent: progress,
          message: `Starting OpenClaw gateway... (${Math.round(elapsedMs / 1000)}s)`,
          canRetry: false,
        });

        if (pollCount % 5 === 0) {
          console.log(
            `[OpenClaw] waitForGatewayReady: poll #${pollCount}, elapsed=${elapsedMs}ms, progress=${progress}%`,
          );
        }

        setTimeout(() => {
          void tick();
        }, 600);
      };

      void tick();
    });
  }

  private stopGatewayProcess(child: GatewayProcess): Promise<void> {
    this.expectedGatewayExits.add(child);

    return new Promise<void>(resolve => {
      // Already exited — resolve immediately.
      if ('exitCode' in child && child.exitCode !== null) {
        resolve();
        return;
      }

      const timeoutMs = 5_000;
      let settled = false;

      const done = () => {
        if (settled) return;
        settled = true;
        clearTimeout(forceTimer);
        resolve();
      };

      // Listen for exit (ChildProcess) or exit (UtilityProcess).
      child.once('exit', done);

      // First attempt: graceful kill.
      try {
        child.kill();
      } catch {
        // ignore
      }

      // Fallback: force-kill after 1.2s if still alive, then hard-timeout at 5s.
      const forceTimer = setTimeout(() => {
        try {
          if ('pid' in child && typeof child.pid === 'number') {
            child.kill();
          }
        } catch {
          // ignore
        }
        // Guarantee we don't block shutdown forever.
        setTimeout(done, 2_000);
      }, 1_200);

      // Hard timeout: always resolve within timeoutMs.
      setTimeout(done, timeoutMs);
    });
  }

  // Workaround: Electron utilityProcess V8 isolate reports getTimezoneOffset()=0.
  private static rewriteUtcTimestamps(text: string): string {
    return text.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g, utc => {
      const d = new Date(utc);
      if (Number.isNaN(d.getTime())) return utc;
      const pad = (n: number) => String(n).padStart(2, '0');
      const ms = String(d.getMilliseconds()).padStart(3, '0');
      const offsetMin = -d.getTimezoneOffset();
      const sign = offsetMin >= 0 ? '+' : '-';
      const absH = Math.floor(Math.abs(offsetMin) / 60);
      const absM = Math.abs(offsetMin) % 60;
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${ms}${sign}${pad(absH)}:${pad(absM)}`;
    });
  }

  private attachGatewayProcessLogs(child: GatewayProcess): void {
    ensureDir(path.dirname(this.gatewayLogPath));
    const stdoutLogFilter = new GatewayStdoutLogFilter();
    let stderrPartialLine = '';
    const appendLog = (chunk: Buffer | string, stream: 'stdout' | 'stderr') => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString();
      const line = `[${new Date().toISOString()}] [${stream}] ${text}`;
      fs.appendFile(this.gatewayLogPath, line, () => {
        // best-effort log append
      });
    };
    const emitLines = (text: string, stream: 'stdout' | 'stderr') => {
      for (const line of text.split(/\r?\n/)) {
        if (!line) continue;
        this.gatewayConfigReloadMonitor.observeLine(line);
        appendLog(`${line}\n`, stream);
        const renderedLine = OpenClawEngineManager.rewriteUtcTimestamps(line);
        if (stream === 'stdout') {
          console.log(`[OpenClaw stdout] ${renderedLine}`);
        } else {
          console.error(`[OpenClaw stderr] ${renderedLine}`);
        }
      }
    };

    child.stdout?.on('data', chunk => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString();
      // OpenClaw's config.get schema walk logs one debug line for every path
      // whose name looks sensitive. These are schema classifications, not
      // leaked values or actionable warnings, and can produce hundreds of
      // lines whenever the Control UI connects. Thinking, assistant, and item
      // stream websocket events are similarly high-volume transport metadata,
      // so retain only the first and last event for each run and stream.
      // The filter also removes individual plugin loading lines while
      // preserving load summaries and websocket polling diagnostics.
      const filteredText = stdoutLogFilter.push(text);
      if (!filteredText) return;
      emitLines(filteredText, 'stdout');
    });
    child.stdout?.on('end', () => {
      const tail = stdoutLogFilter.flush();
      if (!tail) return;
      emitLines(tail, 'stdout');
    });
    child.stderr?.on('data', chunk => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString();
      const combined = stderrPartialLine + text;
      const lastNewlineIndex = combined.lastIndexOf('\n');
      if (lastNewlineIndex < 0) {
        stderrPartialLine = combined;
        return;
      }
      emitLines(combined.slice(0, lastNewlineIndex + 1), 'stderr');
      stderrPartialLine = combined.slice(lastNewlineIndex + 1);
    });
    child.stderr?.on('end', () => {
      if (!stderrPartialLine) return;
      emitLines(stderrPartialLine, 'stderr');
      stderrPartialLine = '';
    });
  }

  private attachGatewayExitHandlers(child: GatewayProcess): void {
    child.once('error', (...args: unknown[]) => {
      // UtilityProcess error: (type: string, location: string)
      // ChildProcess error: (err: Error)
      const errorMsg =
        args[0] instanceof Error ? args[0].message : `${args[0]}${args[1] ? ` (${args[1]})` : ''}`;
      console.error(`[OpenClaw] gateway process error event: ${errorMsg}`);
      // Don't delete from expectedGatewayExits here — the 'exit' event always
      // follows and handles cleanup. Deleting here would cause 'exit' to miss
      // the expected-exit guard, triggering a spurious restart.
      if (this.expectedGatewayExits.has(child)) return;
      if (this.shutdownRequested) return;
      this.setStatus({
        phase: 'error',
        version: this.status.version,
        message: `OpenClaw gateway process error: ${errorMsg}`,
        canRetry: true,
      });
    });

    const onExit: GatewayExitListener = (code, signal) => {
      console.log(`[OpenClaw] gateway process exited with code=${code}, signal=${signal ?? 'null'}`);
      if (this.gatewayProcess === child) {
        this.gatewayProcess = null;
      }
      if (this.expectedGatewayExits.has(child)) {
        this.expectedGatewayExits.delete(child);
        return;
      }
      if (this.shutdownRequested) return;

      this.setStatus({
        phase: 'error',
        version: this.status.version,
        message: `OpenClaw gateway exited unexpectedly (code=${code ?? 'null'}).`,
        canRetry: true,
      });
      this.scheduleGatewayRestart();
    };
    (child as ChildProcess).once('exit', onExit);
  }

  private scheduleGatewayRestart(): void {
    if (this.shutdownRequested) return;
    if (this.gatewayRestartTimer) return;

    if (this.gatewayRestartAttempt >= GATEWAY_MAX_RESTART_ATTEMPTS) {
      console.error(
        `[OpenClaw] gateway auto-restart limit reached (${GATEWAY_MAX_RESTART_ATTEMPTS} attempts), giving up`,
      );
      this.setStatus({
        phase: 'error',
        version: this.status.version,
        message: `OpenClaw gateway failed to start after ${GATEWAY_MAX_RESTART_ATTEMPTS} attempts. Check model configuration or restart manually.`,
        canRetry: true,
      });
      return;
    }

    const delay =
      GATEWAY_RESTART_DELAYS[
        Math.min(this.gatewayRestartAttempt, GATEWAY_RESTART_DELAYS.length - 1)
      ];
    this.gatewayRestartAttempt++;
    console.log(
      `[OpenClaw] scheduling gateway restart attempt ${this.gatewayRestartAttempt}/${GATEWAY_MAX_RESTART_ATTEMPTS} in ${delay}ms`,
    );

    this.gatewayRestartTimer = setTimeout(() => {
      this.gatewayRestartTimer = null;
      if (this.shutdownRequested) return;
      void this.startGateway();
    }, delay);
  }

  private setStatus(next: OpenClawEngineStatus): void {
    this.status = {
      ...next,
      message: next.message ? next.message.slice(0, 500) : undefined,
    };
    this.emit('status', this.getStatus());
  }
}
