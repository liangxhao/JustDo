import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

import {
  EXTERNAL_AGENT_IDS,
  type ExternalAgentDiagnostic,
  type ExternalAgentDiagnosticCode,
  type ExternalAgentDiagnosticsResult,
  type ExternalAgentId,
} from '../../../shared/openclaw/externalAgents';
import type {
  OpenClawCliEnvironment,
  OpenClawEngineManager,
} from '../runtime/openclawEngineManager';

const CONNECTION_TEST_TIMEOUT_MS = 60_000;
const CONNECTION_TEST_AGENT_TIMEOUT_SECONDS = 45;
const CONNECTION_TEST_SESSION_PREFIX = 'justdo-connection-test';
const MAX_OUTPUT_CHARS = 64 * 1024;

type CommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
};

type CommandEnvironment = Record<string, string | undefined>;

const ADAPTER_PACKAGE_BY_AGENT: Partial<Record<ExternalAgentId, string>> = {
  claude: '@agentclientprotocol/claude-agent-acp',
  codex: '@zed-industries/codex-acp',
};

export const resolveAcpxCliPath = (cli: OpenClawCliEnvironment): string =>
  path.join(
    path.dirname(cli.openclawEntry),
    'dist',
    'extensions',
    'acpx',
    'node_modules',
    'acpx',
    'dist',
    'cli.js',
  );

const resolveAdapterBinPath = (
  cli: OpenClawCliEnvironment,
  agentId: ExternalAgentId,
): string | null => {
  const packageName = ADAPTER_PACKAGE_BY_AGENT[agentId];
  if (!packageName) return null;
  const packageRoot = path.dirname(resolveAdapterPackagePath(cli, agentId) ?? '');
  if (agentId === 'codex') return path.join(packageRoot, 'bin', 'codex-acp.js');
  if (agentId === 'claude') return path.join(packageRoot, 'dist', 'index.js');
  return null;
};

const quoteAgentCommandPart = (value: string): string =>
  JSON.stringify(value.replace(/\\/g, '/'));

export const buildBundledAdapterCommand = (
  cli: OpenClawCliEnvironment,
  agentId: ExternalAgentId,
): string | null => {
  const adapterBinPath = resolveAdapterBinPath(cli, agentId);
  if (!adapterBinPath || !fs.existsSync(adapterBinPath)) return null;
  const executable = cli.env.JUSTDO_ELECTRON_PATH || process.execPath;
  const parts = [quoteAgentCommandPart(executable), quoteAgentCommandPart(adapterBinPath)];
  if (agentId === 'codex') {
    // The pinned Codex ACP adapter predates the `priority` service tier accepted by
    // newer Codex CLIs. Override only this compatibility field while retaining the
    // user's existing CODEX_HOME and authentication state.
    parts.push('-c', quoteAgentCommandPart('service_tier="fast"'));
  }
  return parts.join(' ');
};

export const resolveInstalledClaudeExecutable = (
  env: CommandEnvironment,
  platform = process.platform,
): string | null => {
  const configured = env.CLAUDE_CODE_EXECUTABLE?.trim();
  if (configured && fs.existsSync(configured)) return configured;

  const pathValue = env.PATH || env.Path;
  if (!pathValue) return null;
  const executableNames = platform === 'win32' ? ['claude.exe'] : ['claude'];
  for (const directory of pathValue.split(path.delimiter)) {
    const normalizedDirectory = directory.trim().replace(/^"|"$/g, '');
    if (!normalizedDirectory) continue;
    for (const executableName of executableNames) {
      const candidate = path.join(normalizedDirectory, executableName);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return null;
};

const resolveAdapterPackagePath = (
  cli: OpenClawCliEnvironment,
  agentId: ExternalAgentId,
): string | null => {
  const packageName = ADAPTER_PACKAGE_BY_AGENT[agentId];
  if (!packageName) return null;
  return path.join(
    path.dirname(cli.openclawEntry),
    'dist',
    'extensions',
    'acpx',
    'node_modules',
    ...packageName.split('/'),
    'package.json',
  );
};

export const buildExternalAgentConnectionTestArgs = (
  acpxCliPath: string,
  agentId: ExternalAgentId,
  workspaceDir: string,
  sessionName = `${CONNECTION_TEST_SESSION_PREFIX}-${process.pid}-${Date.now()}`,
  adapterCommand?: string | null,
): string[] => [
  acpxCliPath,
  '--cwd',
  workspaceDir,
  '--auth-policy',
  'skip',
  '--deny-all',
  '--non-interactive-permissions',
  'deny',
  '--no-terminal',
  '--timeout',
  String(CONNECTION_TEST_AGENT_TIMEOUT_SECONDS),
  '--format',
  'json',
  '--json-strict',
  ...(adapterCommand ? ['--agent', adapterCommand] : [agentId]),
  'sessions',
  'new',
  '--name',
  sessionName,
];

const buildExternalAgentConnectionCleanupArgs = (
  acpxCliPath: string,
  agentId: ExternalAgentId,
  workspaceDir: string,
  sessionName: string,
  adapterCommand?: string | null,
): string[] => [
  acpxCliPath,
  '--cwd',
  workspaceDir,
  '--format',
  'quiet',
  ...(adapterCommand ? ['--agent', adapterCommand] : [agentId]),
  'sessions',
  'close',
  sessionName,
];

const terminateProcess = (child: ReturnType<typeof spawn>): void => {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    });
  } else {
    child.kill('SIGKILL');
  }
};

const runCommand = (
  cli: OpenClawCliEnvironment,
  args: string[],
  cwd: string,
  timeoutMs = CONNECTION_TEST_TIMEOUT_MS,
  additionalEnv: CommandEnvironment = {},
): Promise<CommandResult> =>
  new Promise((resolve, reject) => {
    const executable = cli.env.JUSTDO_ELECTRON_PATH || process.execPath;
    const child = spawn(executable, args, {
      cwd,
      env: {
        ...cli.env,
        ELECTRON_RUN_AS_NODE: '1',
        ACPX_CLAUDE_INCLUDE_USER_SETTINGS: '1',
        ...additionalEnv,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (result: CommandResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(result);
    };
    child.stdout?.on('data', chunk => {
      stdout = `${stdout}${String(chunk)}`.slice(-MAX_OUTPUT_CHARS);
    });
    child.stderr?.on('data', chunk => {
      stderr = `${stderr}${String(chunk)}`.slice(-MAX_OUTPUT_CHARS);
    });
    child.once('error', error => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(error);
    });
    child.once('close', code => {
      finish({ exitCode: code ?? 1, stdout, stderr, timedOut: false });
    });
    const timeout = setTimeout(() => {
      terminateProcess(child);
      finish({ exitCode: 124, stdout, stderr, timedOut: true });
    }, timeoutMs);
  });

export const sanitizeExternalAgentDiagnostic = (value: string, workspaceDir: string): string =>
  value
    .replace(/\u001b\[[0-9;]*m/g, '')
    .replace(new RegExp(workspaceDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), '<workspace>')
    .replace(/((?:api[_-]?key|access[_-]?token|token|secret|password)\s*[=:]\s*)\S+/gi, '$1***')
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1***:***@')
    .trim()
    .slice(-1_500);

const classifyFailure = (detail: string, timedOut: boolean): ExternalAgentDiagnosticCode => {
  if (timedOut) return 'timeout';
  if (/auth|authenticate|authentication|login|log in|credential|api key/i.test(detail)) {
    return 'authentication-required';
  }
  return 'connection-failed';
};

export class ExternalAgentDiagnosticsService {
  private readonly results = new Map<ExternalAgentId, ExternalAgentDiagnostic>();
  private readonly inFlight = new Map<ExternalAgentId, Promise<ExternalAgentDiagnostic>>();

  constructor(private readonly getManager: () => OpenClawEngineManager) {}

  async list(): Promise<ExternalAgentDiagnosticsResult> {
    const cli = await this.getManager().buildCliEnvironment();
    const acpxCliPath = resolveAcpxCliPath(cli);
    const backendAvailable = fs.existsSync(acpxCliPath);
    return {
      success: true,
      backendAvailable,
      agents: EXTERNAL_AGENT_IDS.map(id => {
        const adapterPackagePath = resolveAdapterPackagePath(cli, id);
        const adapterAvailable =
          backendAvailable && (adapterPackagePath === null || fs.existsSync(adapterPackagePath));
        return (
          this.results.get(id) ?? {
            id,
            enabled: true,
            adapterAvailable,
            state: adapterAvailable ? 'not-tested' : 'unavailable',
            ...(backendAvailable
              ? adapterAvailable
                ? {}
                : { code: 'adapter-missing' as const }
              : { code: 'backend-missing' as const }),
          }
        );
      }),
    };
  }

  async test(agentId: ExternalAgentId): Promise<ExternalAgentDiagnostic> {
    const existing = this.inFlight.get(agentId);
    if (existing) return existing;
    const operation = this.runTest(agentId).finally(() => this.inFlight.delete(agentId));
    this.inFlight.set(agentId, operation);
    return operation;
  }

  private async runTest(agentId: ExternalAgentId): Promise<ExternalAgentDiagnostic> {
    const startedAt = Date.now();
    const manager = this.getManager();
    const cli = await manager.buildCliEnvironment();
    const acpxCliPath = resolveAcpxCliPath(cli);
    const adapterPackagePath = resolveAdapterPackagePath(cli, agentId);
    const adapterAvailable =
      fs.existsSync(acpxCliPath) &&
      (adapterPackagePath === null || fs.existsSync(adapterPackagePath));
    if (!fs.existsSync(acpxCliPath) || !adapterAvailable) {
      const diagnostic: ExternalAgentDiagnostic = {
        id: agentId,
        enabled: true,
        adapterAvailable,
        state: 'unavailable',
        code: fs.existsSync(acpxCliPath) ? 'adapter-missing' : 'backend-missing',
        testedAt: Date.now(),
        durationMs: Date.now() - startedAt,
      };
      this.results.set(agentId, diagnostic);
      return diagnostic;
    }

    const workspaceDir = path.join(manager.getStateDir(), 'workspace');
    fs.mkdirSync(workspaceDir, { recursive: true });
    const sessionName = `${CONNECTION_TEST_SESSION_PREFIX}-${process.pid}-${Date.now()}`;
    const adapterCommand = buildBundledAdapterCommand(cli, agentId);
    const installedClaudeExecutable =
      agentId === 'claude' ? resolveInstalledClaudeExecutable(cli.env) : null;
    const adapterEnv = installedClaudeExecutable
      ? { CLAUDE_CODE_EXECUTABLE: installedClaudeExecutable }
      : {};
    try {
      const result = await runCommand(
        cli,
        buildExternalAgentConnectionTestArgs(
          acpxCliPath,
          agentId,
          workspaceDir,
          sessionName,
          adapterCommand,
        ),
        workspaceDir,
        CONNECTION_TEST_TIMEOUT_MS,
        adapterEnv,
      );
      const output = `${result.stdout}\n${result.stderr}`;
      const connected = result.exitCode === 0 && output.trim().length > 0;
      const detail = connected ? '' : sanitizeExternalAgentDiagnostic(output, workspaceDir);
      const diagnostic: ExternalAgentDiagnostic = {
        id: agentId,
        enabled: true,
        adapterAvailable: true,
        state: connected ? 'connected' : 'failed',
        code: connected ? 'ok' : classifyFailure(detail, result.timedOut),
        ...(detail ? { detail } : {}),
        testedAt: Date.now(),
        durationMs: Date.now() - startedAt,
      };
      this.results.set(agentId, diagnostic);
      if (connected) {
        void runCommand(
          cli,
          buildExternalAgentConnectionCleanupArgs(
            acpxCliPath,
            agentId,
            workspaceDir,
            sessionName,
            adapterCommand,
          ),
          workspaceDir,
          10_000,
          adapterEnv,
        ).catch((): void => undefined);
      }
      return diagnostic;
    } catch (error) {
      const detail = sanitizeExternalAgentDiagnostic(
        error instanceof Error ? error.message : String(error),
        workspaceDir,
      );
      const diagnostic: ExternalAgentDiagnostic = {
        id: agentId,
        enabled: true,
        adapterAvailable: true,
        state: 'failed',
        code: classifyFailure(detail, false),
        ...(detail ? { detail } : {}),
        testedAt: Date.now(),
        durationMs: Date.now() - startedAt,
      };
      this.results.set(agentId, diagnostic);
      return diagnostic;
    }
  }
}
