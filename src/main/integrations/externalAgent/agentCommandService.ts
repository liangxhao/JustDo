import { randomUUID } from 'node:crypto';
import path from 'node:path';

import { version } from '../../../../package.json';
import {
  AgentCliErrorCode,
  AgentCliExitCode,
  formatAgentCliHelp,
  parseAgentCliArguments,
  usesAgentCliMachineOutput,
} from '../../../shared/integrations/agentCli';
import type { AgentCliIntegrationStatus } from '../../../shared/integrations/agentCliIntegration';
import { PRODUCT_NAME } from '../../../shared/productMetadata';
import { getLanguage, t } from '../../core/i18n';
import type { AcpSessionResources } from './acpSession';
import { AcpSession } from './acpSession';
import { createCodexAppServerBackend } from './codexAppServerBackend';
import { CodexAppServerSession } from './codexAppServerSession';
import {
  ExternalAgentBackendFactory,
  ExternalAgentCancelledError,
  ExternalAgentOutcomeUnknownError,
  ExternalAgentStreamError,
} from './externalAgentBackend';

interface Options {
  backend: ExternalAgentBackendFactory;
  createResources: () => AcpSessionResources;
  getStatus: () => AgentCliIntegrationStatus;
}

export interface AgentCommandResult {
  stdout?: string;
  stderr?: string;
  exitCode: number;
}

export class AgentCommandService {
  private readonly sessions = new Set<AcpSession | CodexAppServerSession>();
  private readonly executions = new Set<AbortController>();

  constructor(private readonly options: Options) {}

  get activeTaskCount(): number {
    return this.options.backend.activeTaskCount;
  }

  connectAppServer(cwd: string, send: (message: unknown) => void): {
    receiveRaw: CodexAppServerSession['receiveRaw'];
    close: CodexAppServerSession['close'];
  } {
    return this.openAppServer(cwd, {}, send);
  }

  private openAppServer(cwd: string, env: Record<string, string>, send: (message: unknown) => void) {
    const session = new CodexAppServerSession(
      createCodexAppServerBackend(this.options.backend.connect(), { cwd, codexHome: env.CODEX_HOME }),
      send,
    );
    this.sessions.add(session);
    return {
      receiveRaw: session.receiveRaw,
      receive: session.receive,
      close: (reason?: Error) => {
        this.sessions.delete(session);
        return session.close(reason);
      },
    };
  }

  connect(
    cwd: string,
    env: Record<string, string>,
    send: (message: unknown) => void,
    argv = ['app-server'],
  ): {
    receive(raw: unknown): Promise<void>;
    close(reason?: Error): Promise<void>;
    transportClosed?: Promise<void>;
  } {
    if (argv[0] === 'app-server') return this.openAppServer(cwd, env, send);
    if (argv[0] !== 'acp') throw new Error('Unsupported stdio protocol.');
    const backend = this.options.backend.connect();
    const session = new AcpSession(backend, send, this.options.createResources());
    this.sessions.add(session);
    return {
      ...(session instanceof AcpSession ? { transportClosed: session.transportClosed } : {}),
      receive: raw => session.receive(raw),
      close: reason => {
        this.sessions.delete(session);
        return session.close(reason);
      },
    };
  }

  stopExternal(): void {
    for (const controller of this.executions) controller.abort();
    for (const session of this.sessions) void session.close().catch(() => {});
    this.sessions.clear();
  }

  async execute(
    argv: string[],
    cwd = process.cwd(),
    _env: Record<string, string> = {},
    signal = new AbortController().signal,
    emit?: (type: 'stdout' | 'stderr', data: string) => void,
  ): Promise<AgentCommandResult> {
    const command = parseAgentCliArguments(argv);
    const machine = usesAgentCliMachineOutput(argv);
    let executionIdentity: { sessionId: string; runId: string } | undefined;
    const failure = (
      error: unknown,
      exitCode: number = AgentCliExitCode.BridgeError,
    ): AgentCommandResult => {
      const message = error instanceof Error ? error.message : 'CLI request failed.';
      return {
        exitCode,
        ...(machine
          ? {
              stdout: `${JSON.stringify({
                type: 'error',
                error: {
                  code:
                    error instanceof ExternalAgentOutcomeUnknownError
                      ? AgentCliErrorCode.ExecutionUnknown
                      : exitCode === AgentCliExitCode.InvalidArguments
                        ? AgentCliErrorCode.InvalidArguments
                        : AgentCliErrorCode.BridgeError,
                  message,
                },
                ...executionIdentity,
              })}\n`,
            }
          : { stderr: `${message}\n` }),
      };
    };
    if (!command)
      return failure(
        new Error('Invalid CLI arguments. Use --help.'),
        AgentCliExitCode.InvalidArguments,
      );
    if (command.kind === 'help')
      return { stdout: formatAgentCliHelp(PRODUCT_NAME, getLanguage()), exitCode: 0 };
    if (command.kind === 'version') return { stdout: `${PRODUCT_NAME} ${version}\n`, exitCode: 0 };
    if (command.kind === 'status') {
      const status = this.options.getStatus();
      return {
        stdout:
          command.format === 'json'
            ? `${JSON.stringify(status)}\n`
            : `${PRODUCT_NAME}: bridge: ${status.bridgeRunning ? 'running' : 'stopped'}; gateway: ${status.gatewayPhase}\n`,
        exitCode: 0,
      };
    }
    if (command.kind === 'acp' || command.kind === 'app-server')
      return failure(new Error('This protocol requires the stdio transport.'));
    if (command.kind === 'codex-models') {
      try {
        const models = this.options.backend.models().map(model => ({
          slug: model.id,
          display_name: model.name,
          visibility: 'list',
          default_reasoning_level: null as string | null,
          supported_reasoning_levels: [] as string[],
          service_tiers: [] as string[],
        }));
        return { stdout: `${JSON.stringify({ models })}\n`, exitCode: AgentCliExitCode.Success };
      } catch (error) {
        return failure(error);
      }
    }
    if (command.kind === 'models') {
      try {
        const models = this.options.backend.models();
        return {
          stdout:
            command.format === 'json'
              ? `${JSON.stringify({ models })}\n`
              : `${models.map(model => `${model.id}${model.isDefault ? ' *' : ''}\t${model.name}`).join('\n')}\n`,
          exitCode: 0,
        };
      } catch (error) {
        return failure(error);
      }
    }
    if (command.kind !== 'exec') return failure(new Error('Unsupported CLI command.'));
    const controller = new AbortController();
    let unknown = false;
    this.executions.add(controller);
    const abort = () => controller.abort(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    try {
      const backend = this.options.backend.connect();
      const directory = path.resolve(cwd, command.cwd ?? '.');
      const thread = command.sessionId
        ? await backend.resume(command.sessionId, {
            ...(command.cwd ? { cwd: directory } : {}),
            model: command.modelRef,
          })
        : await backend.start({ cwd: directory, model: command.modelRef });
      const runId = randomUUID();
      executionIdentity = { sessionId: thread.id, runId };
      const text = await backend.run(
        thread,
        runId,
        command.prompt,
        event => {
          if (command.format === 'stream-json')
            emit?.(
              'stdout',
              `${JSON.stringify({
                type: 'event',
                sessionId: thread.id,
                runId,
                event,
              })}\n`,
            );
        },
        controller.signal,
      );
      if (controller.signal.reason instanceof ExternalAgentStreamError)
        throw controller.signal.reason;
      const result = {
        type: 'result',
        sessionId: thread.id,
        runId,
        status: 'completed',
        text,
      };
      return {
        stdout: machine ? `${JSON.stringify(result)}\n` : `${text}\n`,
        exitCode: AgentCliExitCode.Success,
      };
    } catch (error) {
      unknown = error instanceof ExternalAgentOutcomeUnknownError;
      const cancelled =
        error instanceof ExternalAgentCancelledError &&
        !(controller.signal.reason instanceof ExternalAgentStreamError);
      if (cancelled && executionIdentity)
        return {
          exitCode: AgentCliExitCode.Cancelled,
          ...(machine
            ? {
                stdout: `${JSON.stringify({ type: 'result', ...executionIdentity, status: 'cancelled', text: '' })}\n`,
              }
            : { stderr: `${t('externalAgentTaskCancelled')}\n` }),
        };
      // Unconfirmed execution is an error, never a completed or cancelled task.
      const result = failure(
        error,
        cancelled ? AgentCliExitCode.Cancelled : AgentCliExitCode.BridgeError,
      );
      return result;
    } finally {
      const release = () => {
        signal.removeEventListener('abort', abort);
        this.executions.delete(controller);
      };
      if (!unknown || controller.signal.aborted) release();
      else controller.signal.addEventListener('abort', release, { once: true });
    }
  }
}
