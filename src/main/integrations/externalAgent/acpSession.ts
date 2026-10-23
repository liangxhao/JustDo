import { randomUUID } from 'node:crypto';
import path from 'node:path';

import {
  agent,
  type AgentConnection,
  type AgentContext,
  type AnyMessage,
  type ContentBlock,
  type McpServer,
  PROTOCOL_VERSION,
  RequestError,
  type RequestPermissionResponse,
  type SessionConfigOption,
  type SessionUpdate,
} from '@agentclientprotocol/sdk';

import { version } from '../../../../package.json';
import {
  type ExternalMcpServer,
  isExternalMcpPlatformSupported,
} from '../../../../plugins/extensions/runtime-services/contracts/external-mcp';
import { PRODUCT_NAME } from '../../../shared/productMetadata';
import { t } from '../../core/i18n';
import type { ExternalPermissionPresenter } from '../../openclaw/permissions/externalApprovalRouting';
import { AcpProgress } from './acpProgress';
import type { ExternalAgentBackend, ExternalAgentThread } from './externalAgentBackend';
import {
  ExternalAgentCancelledError,
  ExternalAgentOutcomeUnknownError,
  ExternalAgentStreamError,
} from './externalAgentBackend';
import type { ExternalAgentRunHooks } from './externalAgentExecution';

export interface AcpSessionResources {
  prepare(
    thread: ExternalAgentThread,
    servers: ExternalMcpServer[],
    binding: Parameters<NonNullable<ExternalAgentRunHooks['onPrepared']>>[0],
    present: ExternalPermissionPresenter,
    signal?: AbortSignal,
  ): Promise<() => void | Promise<void>>;
  close(sessionId: string): Promise<void>;
}

interface Session {
  thread: ExternalAgentThread;
  servers: ExternalMcpServer[];
  active?: { controller: AbortController; done: Promise<void> };
  unknown?: AbortController;
  changing?: boolean;
  closing?: boolean;
}

const MAX_PROMPT_CHARS = 2 * 1024 * 1024;

export function acpPromptText(blocks: ContentBlock[]): string {
  if (!blocks.length) throw RequestError.invalidParams(undefined, 'A prompt is required.');
  const text = blocks
    .map(block => {
      if (block.type === 'text') return block.text;
      if (block.type === 'resource_link') {
        // Preserve the reference as supplied. Reading it is a permission-checked
        // native tool operation, never an implicit fetch in this protocol adapter.
        return JSON.stringify({
          type: 'resource_link',
          uri: block.uri,
          name: block.name,
          ...(block.description ? { description: block.description } : {}),
          ...(block.mimeType ? { mimeType: block.mimeType } : {}),
        });
      }
      throw RequestError.invalidParams(undefined, `Unsupported prompt content: ${block.type}.`);
    })
    .join('\n');
  if (!text.trim() || text.length > MAX_PROMPT_CHARS)
    throw RequestError.invalidParams(undefined, 'Invalid prompt length.');
  return text;
}

export function acpStdioServers(
  servers: McpServer[],
  platform: string = process.platform,
): ExternalMcpServer[] {
  if (servers.length && !isExternalMcpPlatformSupported(platform))
    throw RequestError.invalidParams(
      undefined,
      'Session stdio MCP is unavailable on this platform: process-tree cleanup cannot be confirmed.',
    );
  if (servers.length > 16) throw RequestError.invalidParams(undefined, 'Too many MCP servers.');
  const names = new Set<string>();
  return servers.map(server => {
    if ('type' in server && server.type !== undefined) {
      throw RequestError.invalidParams(undefined, 'Only stdio MCP servers are supported.');
    }
    if (
      !('command' in server) ||
      !server.command.trim() ||
      server.command.includes('\0') ||
      names.has(server.name)
    ) {
      throw RequestError.invalidParams(
        undefined,
        'MCP commands must be valid executable names and server names unique.',
      );
    }
    names.add(server.name);
    return { name: server.name, command: server.command, args: server.args, env: server.env };
  });
}

/** One stdio connection, with independent sessions and nonblocking RPC dispatch. */
export class AcpSession {
  private initialized = false;
  private closed = false;
  private opening = 0;
  private readonly sessions = new Map<string, Session>();
  private readonly pendingRequests = new Set<string>();
  private pendingPermissions = 0;
  private readonly input: ReadableStreamDefaultController<AnyMessage>;
  private readonly connection: AgentConnection;
  private readonly transportClosure: Promise<void>;
  private resolveTransportClosure!: () => void;
  private cleanupPromise?: Promise<void>;

  constructor(
    private readonly backend: ExternalAgentBackend,
    send: (message: unknown) => void,
    private readonly resources: AcpSessionResources,
  ) {
    this.transportClosure = new Promise<void>(resolve => {
      this.resolveTransportClosure = resolve;
    });
    let input!: ReadableStreamDefaultController<AnyMessage>;
    const readable = new ReadableStream<AnyMessage>({
      start: controller => {
        input = controller;
      },
    });
    this.input = input;
    const app = agent({ name: 'external-agent' })
      .onRequest('initialize', () => {
        if (this.initialized)
          throw RequestError.invalidRequest('The connection is already initialized.');
        this.initialized = true;
        return {
          protocolVersion: PROTOCOL_VERSION,
          agentInfo: { name: 'desktop-agent', title: PRODUCT_NAME, version },
          agentCapabilities: {
            loadSession: false,
            promptCapabilities: { image: false, audio: false, embeddedContext: false },
            mcpCapabilities: { http: false, sse: false },
            sessionCapabilities: { close: {} },
          },
          authMethods: [],
        };
      })
      .onRequest('session/new', async ({ params }) => {
        this.requireInitialized();
        if (!path.isAbsolute(params.cwd) || params.additionalDirectories?.length) {
          throw RequestError.invalidParams(
            undefined,
            'An absolute session cwd is required; additional roots are unsupported.',
          );
        }
        if (this.sessions.size + this.opening >= 32)
          throw RequestError.invalidParams(undefined, 'Too many sessions.');
        const servers = acpStdioServers(params.mcpServers);
        this.opening += 1;
        try {
          const thread = await this.backend.start({ cwd: params.cwd });
          if (this.closed) throw RequestError.requestCancelled();
          this.sessions.set(thread.id, { thread, servers });
          return { sessionId: thread.id, configOptions: this.modelOptions(thread) };
        } finally {
          this.opening -= 1;
        }
      })
      .onRequest('session/set_config_option', async ({ params }) => {
        const session = this.requireSession(params.sessionId);
        if (
          session.active ||
          session.unknown ||
          session.changing ||
          session.closing ||
          params.configId !== 'model' ||
          typeof params.value !== 'string'
        ) {
          throw RequestError.invalidParams(
            undefined,
            'Only an idle session model can be selected.',
          );
        }
        session.changing = true;
        try {
          const thread = await this.backend.resume(session.thread.id, {
            cwd: session.thread.cwd,
            model: params.value,
          });
          if (session.closing || this.closed) throw RequestError.requestCancelled();
          session.thread = thread;
          return { configOptions: this.modelOptions(thread) };
        } finally {
          session.changing = false;
        }
      })
      .onRequest('session/prompt', async ({ params, client, signal }) => {
        const session = this.requireSession(params.sessionId);
        if (session.active || session.unknown || session.changing || session.closing)
          throw RequestError.invalidParams(undefined, 'The session is busy.');
        const text = acpPromptText(params.prompt);
        const controller = new AbortController();
        const abort = () => controller.abort();
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
        let resolveDone!: () => void;
        const done = new Promise<void>(resolve => {
          resolveDone = resolve;
        });
        session.active = { controller, done };
        // Every update and the final response share the SDK's ordered writer.
        let output = Promise.resolve();
        let outputError: Error | undefined;
        const progress = new AcpProgress(update => {
          output = output
            .then(() =>
              client.notify('session/update', {
                sessionId: session.thread.id,
                update: update as SessionUpdate,
              }),
            )
            .catch(error => {
              outputError = new ExternalAgentStreamError(
                error instanceof Error ? error.message : 'ACP output failed.',
              );
              controller.abort(outputError);
            });
        });
        try {
          const finalText = await this.backend.run(
            session.thread,
            randomUUID(),
            text,
            event => {
              if (controller.signal.aborted) return;
              try {
                progress.accept(event);
              } catch (error) {
                controller.abort(
                  new ExternalAgentStreamError(
                    error instanceof Error ? error.message : 'ACP projection failed.',
                  ),
                );
              }
            },
            controller.signal,
            {
              interactiveApprovals: true,
              onPrepared: binding =>
                this.resources.prepare(
                  session.thread,
                  session.servers,
                  binding,
                  (request, approvalSignal) =>
                    this.presentPermission(client, session.thread.id, request, approvalSignal),
                  controller.signal,
                ),
            },
          );
          if (controller.signal.reason instanceof ExternalAgentStreamError)
            throw controller.signal.reason;
          progress.finish(finalText);
          await output;
          if (outputError) throw outputError;
          return { stopReason: 'end_turn' as const };
        } catch (error) {
          await output;
          if (
            error instanceof ExternalAgentCancelledError &&
            !outputError &&
            !(controller.signal.reason instanceof ExternalAgentStreamError)
          )
            return { stopReason: 'cancelled' as const };
          if (error instanceof ExternalAgentOutcomeUnknownError) session.unknown = controller;
          throw RequestError.internalError(
            {
              code:
                error instanceof ExternalAgentOutcomeUnknownError
                  ? 'EXECUTION_UNKNOWN'
                  : 'EXECUTION_FAILED',
            },
            error instanceof Error ? error.message : 'Native execution failed.',
          );
        } finally {
          signal.removeEventListener('abort', abort);
          session.active = undefined;
          resolveDone();
        }
      })
      .onNotification('session/cancel', ({ params }) => {
        const session = this.requireSession(params.sessionId);
        session.active?.controller.abort();
        session.unknown?.abort();
      })
      .onRequest('session/close', async ({ params }) => {
        const session = this.requireSession(params.sessionId);
        if (session.closing)
          throw RequestError.invalidParams(undefined, 'The session is already closing.');
        session.closing = true;
        session.active?.controller.abort();
        session.unknown?.abort();
        await session.active?.done;
        await this.resources.close(params.sessionId);
        this.sessions.delete(params.sessionId);
        return {};
      });
    this.connection = app.connect({
      readable,
      writable: new WritableStream<AnyMessage>({
        write: message => {
          if ('id' in message && !('method' in message))
            this.pendingRequests.delete(`${typeof message.id}:${message.id}`);
          if (!this.closed) {
            try {
              send(message);
            } catch (error) {
              void this.close(
                new ExternalAgentStreamError(
                  error instanceof Error ? error.message : 'ACP output failed.',
                ),
              );
              throw error;
            }
          }
        },
      }),
    });
    const closed = () => {
      void this.close();
    };
    this.connection.signal.addEventListener('abort', closed, { once: true });
    if (this.connection.signal.aborted) closed();
    void this.connection.closed.then(() => this.close());
  }

  get transportClosed(): Promise<void> {
    return this.transportClosure;
  }

  async receive(raw: unknown): Promise<void> {
    if (this.closed) return;
    if (raw && typeof raw === 'object' && 'method' in raw && 'id' in raw) {
      const id = (raw as { id: unknown }).id;
      const key = `${typeof id}:${id}`;
      if (this.pendingRequests.has(key) || this.pendingRequests.size >= 128) {
        void this.close(new Error('Too many or duplicate pending ACP requests.'));
        throw new Error('ACP request limit exceeded.');
      }
      this.pendingRequests.add(key);
    }
    this.input.enqueue(raw as AnyMessage);
  }

  close(reason?: Error): Promise<void> {
    if (this.cleanupPromise) return this.cleanupPromise;
    this.closed = true;
    const sessions = [...this.sessions.values()];
    // Publish the shared drain before SDK closure can reenter this method.
    this.cleanupPromise = Promise.resolve().then(async () => {
      await Promise.allSettled(
        sessions.flatMap(session => [
          Promise.resolve().then(() => this.resources.close(session.thread.id)),
          session.active?.done,
        ]),
      );
      this.sessions.clear();
      this.pendingRequests.clear();
    });
    // Native settlement/cleanup can remain pending after the SDK stops sending.
    // Let the transport owner close stdio without inferring an execution outcome.
    this.resolveTransportClosure();
    for (const session of sessions) {
      session.active?.controller.abort(reason);
      session.unknown?.abort(reason);
    }
    this.connection.close();
    return this.cleanupPromise;
  }

  private requireInitialized(): void {
    if (!this.initialized) throw RequestError.invalidRequest('Initialize the connection first.');
  }

  private requireSession(id: string): Session {
    this.requireInitialized();
    const session = this.sessions.get(id);
    if (!session)
      throw RequestError.invalidParams(undefined, 'The session is not owned by this connection.');
    return session;
  }

  private modelOptions(thread: ExternalAgentThread): SessionConfigOption[] {
    return [
      {
        id: 'model',
        type: 'select',
        category: 'model',
        name: t('externalAgentModel'),
        currentValue: thread.modelRef ?? '',
        options: this.backend.models().map(model => ({ value: model.id, name: model.name })),
      },
    ];
  }

  private async presentPermission(
    client: AgentContext,
    sessionId: string,
    request: Parameters<ExternalPermissionPresenter>[0],
    signal: AbortSignal,
  ): Promise<'allow-once' | 'deny'> {
    if (signal.aborted || this.closed) return 'deny';
    if (this.pendingPermissions >= 64) {
      void this.close(new Error('Too many unanswered permission requests.'));
      return 'deny';
    }
    const command = request.kind === 'exec' ? request.request.command : request.request.description;
    const options = [
      ...(request.request.allowedDecisions &&
      !request.request.allowedDecisions.includes('allow-once')
        ? []
        : [
            {
              optionId: 'allow-once',
              kind: 'allow_once' as const,
              name: t('externalAgentAllowOnce'),
            },
          ]),
      { optionId: 'deny', kind: 'reject_once' as const, name: t('externalAgentReject') },
    ];
    this.pendingPermissions += 1;
    const decision = client
      .request<RequestPermissionResponse>(
        'session/request_permission',
        {
          sessionId,
          toolCall: {
            toolCallId:
              request.kind === 'plugin' && request.request.toolCallId
                ? request.request.toolCallId
                : request.id,
            title: command || t('externalAgentToolPermission'),
            status: 'pending',
          },
          options,
        },
        { cancellationSignal: signal },
      )
      .finally(() => {
        this.pendingPermissions -= 1;
      });
    let abort!: () => void;
    const cancelled = new Promise<null>(resolve => {
      abort = () => resolve(null);
      signal.addEventListener('abort', abort, { once: true });
    });
    try {
      const response = await Promise.race([decision, cancelled]);
      return !signal.aborted &&
        response?.outcome.outcome === 'selected' &&
        response.outcome.optionId === 'allow-once' &&
        options.some(option => option.optionId === 'allow-once')
        ? 'allow-once'
        : 'deny';
    } catch {
      return 'deny';
    } finally {
      signal.removeEventListener('abort', abort);
    }
  }
}
