import { randomUUID } from 'node:crypto';

import { PRODUCT_NAME } from '../../../shared/productMetadata';
import type { CodexAppServerBackend } from './codexAppServerBackend';
import { CodexAppServerProgress } from './codexAppServerProgress';
import {
  ExternalAgentCancelledError,
  ExternalAgentOutcomeUnknownError,
  ExternalAgentStreamError,
  type ExternalAgentThread,
} from './externalAgentTypes';

export type { CodexAppServerBackend } from './codexAppServerBackend';

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const string = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined;

const optionalString = (params: Record<string, unknown>, key: string): string | undefined => {
  const value = params[key];
  if (value == null) return undefined;
  if (typeof value !== 'string') throw new Error(`Invalid ${key}.`);
  return value;
};

const rejectOverrides = (params: Record<string, unknown>, keys: readonly string[]): void => {
  if (keys.some(key => params[key] != null))
    throw new Error('Execution settings are managed in the desktop app.');
};

/** One authenticated stdio client, with no transcript persistence. */
export class CodexAppServerSession {
  private initialized = false;
  private thread: ExternalAgentThread | null = null;
  private opening = false;
  private active: { id: string; controller: AbortController; done: Promise<void> } | null = null;
  private unknown: { id: string; controller: AbortController } | null = null;
  private closed = false;

  constructor(
    private readonly backend: CodexAppServerBackend,
    private readonly send: (message: unknown) => void,
  ) {}

  async receive(raw: unknown): Promise<void> {
    const request = record(raw);
    const id = request.id;
    if (this.closed) return;
    if (id === undefined) {
      // Codex initialized is a notification and never receives a response.
      return;
    }
    if (typeof id !== 'string' && typeof id !== 'number') {
      this.send({ id: null, error: { code: -32600, message: 'Invalid request ID.' } });
      return;
    }
    try {
      const result = await this.dispatch(string(request.method) ?? '', record(request.params));
      this.send({ id, result });
    } catch (error) {
      this.send({
        id,
        error: {
          code: -32000,
          message: error instanceof Error ? error.message : 'Request failed.',
        },
      });
    }
  }

  async close(reason?: Error): Promise<void> {
    this.closed = true;
    this.active?.controller.abort(reason);
    this.unknown?.controller.abort(reason);
    await this.active?.done;
  }

  private notify(method: string, params: Record<string, unknown>): void {
    if (!this.closed) this.send({ method, params });
  }

  private requireThread(id: unknown): ExternalAgentThread {
    if (!this.thread || id !== this.thread.id)
      throw new Error('Thread is not owned by this connection.');
    return this.thread;
  }

  private async dispatch(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (method === 'initialize') {
      if (this.initialized) throw new Error('Connection is already initialized.');
      this.initialized = true;
      return { userAgent: `${PRODUCT_NAME}/codex-compatible`, platformOs: process.platform };
    }
    if (!this.initialized) throw new Error('Initialize the connection first.');
    if (method === 'model/list') {
      return {
        data: this.backend.models().map(model => ({
          id: model.id,
          model: model.id,
          displayName: model.name,
          isDefault: model.isDefault,
          supportedReasoningEfforts: [] as string[],
          defaultReasoningEffort: null as string | null,
        })),
        nextCursor: null,
      };
    }
    if (method === 'thread/start' || method === 'thread/resume') {
      if (this.active || this.unknown || this.opening || this.thread)
        throw new Error('This connection already owns a thread.');
      rejectOverrides(params, [
        'serviceTier',
        'approvalPolicy',
        'sandbox',
        'modelProvider',
        'profile',
        'baseInstructions',
        'developerInstructions',
        'compactPrompt',
        'includeApplyPatchTool',
      ]);
      if (
        params.config != null &&
        (typeof params.config !== 'object' ||
          Array.isArray(params.config) ||
          Object.keys(params.config).length)
      )
        throw new Error('Execution settings are managed in the desktop app.');
      this.opening = true;
      try {
        const options = {
          cwd: optionalString(params, 'cwd'),
          model: optionalString(params, 'model'),
        };
        this.thread =
          method === 'thread/start'
            ? await this.backend.start(options)
            : await this.backend.resume(string(params.threadId) ?? '', options);
        return {
          thread: { id: this.thread.id, cwd: this.thread.cwd, turns: [] },
          model: this.thread.modelRef ?? null,
        };
      } finally {
        this.opening = false;
      }
    }
    if (method === 'thread/name/set') {
      this.requireThread(params.threadId);
      // The product title remains owned by its session lifecycle.
      return {};
    }
    if (method === 'turn/start') {
      const thread = this.requireThread(params.threadId);
      if (this.active || this.unknown)
        throw new Error('This thread has an active or unconfirmed turn.');
      rejectOverrides(params, [
        'effort',
        'serviceTier',
        'model',
        'cwd',
        'approvalPolicy',
        'sandboxPolicy',
        'outputSchema',
      ]);
      if (
        !Array.isArray(params.input) ||
        params.input.some(
          item => record(item).type !== 'text' || typeof record(item).text !== 'string',
        )
      )
        throw new Error('Only text input is supported by this runtime.');
      const text = params.input.map(item => string(record(item).text) ?? '').join('\n');
      if (!text.trim() || Buffer.byteLength(text) > 8 * 1024 * 1024)
        throw new Error('Invalid turn input.');
      const id = randomUUID();
      const controller = new AbortController();
      const active = { id, controller, done: Promise.resolve() };
      this.active = active;
      // Start after the RPC response so very short tasks cannot race admission.
      active.done = new Promise<void>(resolve => setImmediate(resolve)).then(async () => {
        const base = { threadId: thread.id, turnId: id };
        const startedTools = new Set<string>();
        const completedTools = new Set<string>();
        let streamError: ExternalAgentStreamError | undefined;
        const failStream = (message: string): void => {
          streamError ??= new ExternalAgentStreamError(message);
          controller.abort(streamError);
        };
        const notify = (method: string, params: Record<string, unknown>): void => {
          try {
            this.notify(method, { ...base, ...params });
          } catch (error) {
            failStream(error instanceof Error ? error.message : 'Protocol output failed.');
          }
        };
        const progress = new CodexAppServerProgress(text, notify, failStream);
        try {
          notify('turn/started', { turn: { id, status: 'inProgress' } });
          const finalText = await this.backend.run(
            thread,
            id,
            text,
            event => {
              if (controller.signal.aborted) return;
              progress.accept(event);
              if (controller.signal.aborted) return;
              const data = event.data;
              if (event.stream !== 'tool') return;
              const callId = string(data.toolCallId);
              if (!callId) return;
              const item = {
                id: callId,
                type: 'mcpToolCall',
                server: PRODUCT_NAME,
                tool: string(data.name) ?? 'tool',
                arguments: data.args ?? {},
                status: data.isError === true ? 'failed' : 'completed',
                ...(data.isError === true ? { error: { message: 'Tool execution failed.' } } : {}),
              };
              if (data.phase === 'start' && !startedTools.has(callId)) {
                if (startedTools.size >= 10000) {
                  failStream('Tool output exceeded the event limit.');
                  return;
                }
                startedTools.add(callId);
                progress.beforeTool();
                notify('item/started', { item: { ...item, status: 'inProgress' } });
              }
              if (data.phase === 'result' && !completedTools.has(callId)) {
                if (completedTools.size >= 10000) {
                  failStream('Tool output exceeded the event limit.');
                  return;
                }
                completedTools.add(callId);
                notify('item/completed', { item });
              }
            },
            controller.signal,
          );
          if (streamError) throw streamError;
          if (controller.signal.reason instanceof ExternalAgentStreamError)
            throw controller.signal.reason;
          progress.finish(finalText);
          if (streamError) throw streamError;
          notify('turn/completed', {
            turn: { id, status: 'completed' },
          });
        } catch (error) {
          progress.finish();
          const failure = streamError ?? error;
          const unknown = error instanceof ExternalAgentOutcomeUnknownError;
          if (unknown) this.unknown = { id, controller };
          const cancelled =
            failure instanceof ExternalAgentCancelledError &&
            !(controller.signal.reason instanceof ExternalAgentStreamError);
          notify('turn/completed', {
            turn: {
              id,
              status: cancelled ? 'interrupted' : 'failed',
              error: cancelled
                ? null
                : {
                    message: `${unknown ? 'EXECUTION_UNKNOWN: ' : ''}${failure instanceof Error ? failure.message : 'Task failed.'}`,
                  },
            },
          });
        } finally {
          if (this.active === active) this.active = null;
        }
      });
      return { turn: { id, status: 'inProgress', items: [] } };
    }
    if (method === 'turn/interrupt') {
      this.requireThread(params.threadId);
      const owned = this.active ?? this.unknown;
      if (!owned || params.turnId !== owned.id) throw new Error('Turn is not active.');
      owned.controller.abort();
      return {};
    }
    throw new Error('Method not found.');
  }
}
