import { randomUUID } from 'node:crypto';

import { ExternalSessionStatus } from '../../../shared/integrations/externalSession';
import {
  type AppServerBinding,
  type AppServerConnectionContext,
  AppServerErrorCode,
  AppServerErrorStyle,
  AppServerNotificationMethod,
  type AppServerNotify,
  type AppServerParams,
  type AppServerResult,
  AppServerRpcError,
  isAppServerRecord,
} from '../../appServer/appServerProtocol';
import type { AcpSessionResources } from './acpSession';
import { createCodexApprovalPresenter } from './codexAppServerApprovals';
import type { CodexAppServerBackend } from './codexAppServerBackend';
import { assertCodexHistoryFullSize, paginateCodexHistoryItems, paginateCodexHistoryTurns, projectCodexHistory } from './codexAppServerHistory';
import { invalidParams, optionalBoolean, optionalString, paginateIds, paginateThreads } from './codexAppServerPagination';
import { CodexAppServerProgress } from './codexAppServerProgress';
import { CodexAppServerToolProgress } from './codexAppServerToolProgress';
import { codexInitializeResult, codexModel, codexThread, codexThreadOpen, codexTurn, CodexTurnStatus } from './codexAppServerWire';
import {
  ExternalAgentBusyError,
  ExternalAgentCancelledError,
  ExternalAgentOutcomeUnknownError,
  type ExternalAgentRunHooks,
  ExternalAgentStreamError,
  type ExternalAgentThread,
  type ExternalAgentThreadMetadata,
} from './externalAgentTypes';
import { ExternalExecutionState } from './externalSessionStore';

const MAX_LOADED_THREADS = 32;
const MAX_RESOURCE_THREADS = 10_000;

interface OwnedTurn {
  id: string;
  controller: AbortController;
  done: Promise<void>;
  failure?: ExternalAgentStreamError;
}

interface ThreadState {
  thread: ExternalAgentThread;
  active?: OwnedTurn;
  unknown?: Pick<OwnedTurn, 'id' | 'controller'>;
  changing?: boolean;
  subscribed: boolean;
  subscriptionGeneration: number;
  unsubscribe?: () => void;
}

const record = (value: unknown): AppServerParams => isAppServerRecord(value) ? value : {};
const string = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined;

const rejectOverrides = (params: AppServerParams, keys: readonly string[]): void => {
  if (keys.some(key => params[key] != null))
    invalidParams('Execution settings are managed in the desktop app.');
};

export interface CliAppServerOptions {
  home?: string;
  getLoadedThreadIds?: () => readonly string[];
  hub?: {
    subscribe(threadId: string, listener: AppServerNotify): () => void;
    publish: AppServerNotify;
  };
  resources?: AcpSessionResources;
}

/** CLI ownership and execution semantics; the shared connection owns the protocol. */
export class CliAppServerBinding implements AppServerBinding {
  readonly initialization: AppServerBinding['initialization'];

  readonly threads = {
    start: (params: AppServerParams) => this.openThread(params, false),
    resume: (params: AppServerParams) => this.openThread(params, true),
    list: (params: AppServerParams): AppServerResult => {
      this.assertOpen();
      if (!this.backend.list) return this.unsupported('thread/list');
      const page = paginateThreads(this.backend.list().map(metadata => this.selectedMetadata(metadata)), params);
      return { ...page, data: page.data.map(metadata => this.projectMetadata(metadata)) };
    },
    read: async (params: AppServerParams): Promise<AppServerResult> => {
      this.assertOpen();
      const id = this.threadId(params);
      const thread = this.projectMetadata(this.describe(id));
      if (optionalBoolean(params, 'includeTurns')) {
        const history = await this.history(id);
        this.assertOpen();
        assertCodexHistoryFullSize(history.turns);
        thread.turns = history.turns;
      }
      return { thread };
    },
    turnsList: async (params: AppServerParams): Promise<AppServerResult> => {
      const history = await this.history(this.threadId(params));
      this.assertOpen();
      return paginateCodexHistoryTurns(history, params);
    },
    itemsList: async (params: AppServerParams): Promise<AppServerResult> => {
      const history = await this.history(this.threadId(params));
      this.assertOpen();
      return paginateCodexHistoryItems(history, params);
    },
    loadedList: (params: AppServerParams): AppServerResult => {
      this.assertOpen();
      return paginateIds(this.loadedThreadIds(), params, 'loaded', id => id);
    },
    setName: (params: AppServerParams): AppServerResult => {
      this.assertOpen();
      if (!this.backend.setName) return this.unsupported('thread/name/set');
      const threadId = this.threadId(params);
      const name = optionalString(params, 'name');
      if (!name?.trim() || name.trim().length > 500) invalidParams('name must contain 1 to 500 characters.');
      this.backend.setName(threadId, name);
      this.notifyAfterResponse(AppServerNotificationMethod.ThreadNameUpdated, {
        threadId, threadName: this.describe(threadId).name,
      }, undefined, true);
      return {};
    },
    unsubscribe: (params: AppServerParams): AppServerResult => {
      this.assertOpen();
      const id = this.threadId(params);
      const state = this.states.get(id);
      if (!state?.subscribed) {
        return { status: this.loadedThreadIds().includes(id) ? 'notSubscribed' : 'notLoaded' };
      }
      this.detach(state);
      this.unloadIdle(state);
      return { status: 'unsubscribed' };
    },
  };

  readonly turns = {
    start: (params: AppServerParams) => this.startTurn(params),
    interrupt: (params: AppServerParams): AppServerResult => {
      const state = this.requireThread(params.threadId);
      const owned = state.active ?? state.unknown;
      if (!owned || params.turnId !== owned.id) throw new Error('Turn is not active.');
      owned.controller.abort();
      return {};
    },
  };

  readonly models = {
    list: (params: AppServerParams): AppServerResult => {
      this.assertOpen();
      optionalBoolean(params, 'includeHidden');
      const page = paginateIds(this.backend.models(), params, 'models', model => model.id);
      return { ...page, data: page.data.map(codexModel) };
    },
  };

  private readonly states = new Map<string, ThreadState>();
  private readonly openingThreadIds = new Set<string>();
  private readonly resourceThreadIds = new Set<string>();
  private readonly unloaded = new Map<string, ThreadState>();
  private opening = 0;
  private closed = false;
  private disconnecting?: Promise<void>;

  constructor(
    private readonly backend: CodexAppServerBackend,
    private readonly context: AppServerConnectionContext,
    private readonly options: CliAppServerOptions = {},
  ) {
    this.initialization = {
      result: codexInitializeResult(options.home ?? process.cwd()),
      requireInitializedNotification: true,
      executeNotifications: false,
      errorStyle: AppServerErrorStyle.Codex,
    };
  }

  readonly ownedThreadIds = (): string[] => this.closed ? [] : [...this.states.keys()];

  private get interactiveApprovals(): boolean {
    return Boolean(this.options.resources && this.context.request);
  }

  private loadedThreadIds(): string[] {
    return [...new Set(this.options.getLoadedThreadIds?.() ?? this.ownedThreadIds())].sort();
  }

  private unsupported(method: string): never {
    throw new AppServerRpcError(AppServerErrorCode.MethodNotFound, `${method} is unavailable.`);
  }

  private assertOpen(): void {
    if (this.closed || this.context.isClosed()) throw new Error('Connection closed.');
  }

  private threadId(params: AppServerParams): string {
    const id = optionalString(params, 'threadId');
    if (!id) invalidParams('threadId is required.');
    return id;
  }

  private describe(id: string): ExternalAgentThreadMetadata {
    this.assertOpen();
    if (!this.backend.describe) return this.unsupported('thread/read');
    return this.backend.describe(id);
  }

  private async history(id: string): Promise<ReturnType<typeof projectCodexHistory>> {
    this.assertOpen();
    if (!this.backend.history) return this.unsupported('thread/turns/list');
    const history = await this.backend.history(id);
    this.assertOpen();
    return projectCodexHistory(history);
  }

  private selectedMetadata(metadata: ExternalAgentThreadMetadata): ExternalAgentThreadMetadata {
    const thread = this.states.get(metadata.id)?.thread;
    return thread?.modelRef ? { ...metadata, modelRef: thread.modelRef } : metadata;
  }

  private projectMetadata(metadata: ExternalAgentThreadMetadata): AppServerResult {
    const selected = this.selectedMetadata(metadata);
    const projected = codexThread(selected, this.loadedThreadIds().includes(metadata.id));
    const state = this.states.get(metadata.id);
    if (state?.unknown) projected.status = { type: 'systemError' };
    else if (state?.active) projected.status = { type: 'active', activeFlags: [] };
    return projected;
  }

  private deliver(method: AppServerNotificationMethod, params: AppServerParams): void {
    if (this.closed || this.context.isClosed()) return;
    try {
      this.context.notify(method, params);
    } catch {
      this.retireOutput(new ExternalAgentStreamError('Protocol output failed.'));
    }
  }

  private subscribe(state: ThreadState): void {
    this.unloaded.delete(state.thread.id);
    if (state.subscribed) return;
    state.subscribed = true;
    const generation = ++state.subscriptionGeneration;
    if (this.options.hub) state.unsubscribe = this.options.hub.subscribe(state.thread.id, (method, params) => {
      if (state.subscribed && state.subscriptionGeneration === generation && this.states.get(state.thread.id) === state)
        this.deliver(method, params);
    });
  }

  private detach(state: ThreadState): void {
    state.subscribed = false;
    state.subscriptionGeneration++;
    state.unsubscribe?.();
    state.unsubscribe = undefined;
  }

  private unloadIdle(state: ThreadState): void {
    if (state.subscribed || state.active || state.unknown || state.changing || this.closed) return;
    if (this.states.get(state.thread.id) !== state) return;
    this.states.delete(state.thread.id);
    this.unloaded.set(state.thread.id, state);
    setImmediate(() => {
      if (this.unloaded.get(state.thread.id) !== state) return;
      this.unloaded.delete(state.thread.id);
      const stillUnloaded = () => !this.closed && !this.context.isClosed() &&
        !this.states.has(state.thread.id) && !this.loadedThreadIds().includes(state.thread.id);
      if (stillUnloaded()) this.deliver(AppServerNotificationMethod.ThreadStatusChanged, {
        threadId: state.thread.id, status: { type: 'notLoaded' },
      });
      if (stillUnloaded()) this.deliver(AppServerNotificationMethod.ThreadClosed, { threadId: state.thread.id });
    });
  }

  private notifyAfterResponse(method: AppServerNotificationMethod, params: AppServerParams, state?: ThreadState, broadcast = false): void {
    const generation = state?.subscriptionGeneration;
    setImmediate(() => {
      if (this.closed || this.context.isClosed()) return;
      if (state && (!state.subscribed || state.subscriptionGeneration !== generation || this.states.get(state.thread.id) !== state)) return;
      if (broadcast && this.options.hub) {
        const subscribed = typeof params.threadId === 'string' && this.states.get(params.threadId)?.subscribed;
        try {
          this.options.hub.publish(method, params);
        } catch {
          this.retireOutput(new ExternalAgentStreamError('Protocol output failed.'));
          return;
        }
        if (subscribed) return;
      }
      this.deliver(method, params);
    });
  }

  private retireOutput(failure: ExternalAgentStreamError): void {
    this.closed = true;
    this.context.fail?.(failure);
    void this.onDisconnect(failure).catch(() => {});
  }

  readonly onDisconnect = (reason?: Error): Promise<void> => {
    if (this.disconnecting) return this.disconnecting;
    this.closed = true;
    const failure = reason instanceof ExternalAgentStreamError || !reason
      ? reason : new ExternalAgentStreamError(reason.message);
    const states = [...this.states.values()];
    const active = states.flatMap(state => state.active ? [state.active] : []);
    // Publish the drain before abort listeners or reverse requests can reenter cleanup.
    this.disconnecting = Promise.resolve().then(async () => {
      await Promise.allSettled([
        ...active.map(run => run.done),
        ...[...this.resourceThreadIds].map(id => Promise.resolve().then(() => this.options.resources?.close(id))),
      ]);
      this.states.clear();
      this.unloaded.clear();
      this.resourceThreadIds.clear();
    });
    for (const state of states) {
      this.detach(state);
      if (state.active) {
        if (failure) state.active.failure = failure;
        state.active.controller.abort(failure);
      }
      state.unknown?.controller.abort(failure);
    }
    return this.disconnecting;
  };

  private requireThread(id: unknown): ThreadState {
    this.assertOpen();
    const state = typeof id === 'string' ? this.states.get(id) : undefined;
    if (!state)
      throw new Error('Thread is not owned by this connection.');
    return state;
  }

  private async openThread(params: AppServerParams, resume: boolean): Promise<AppServerResult> {
    this.assertOpen();
    if (!this.backend.describe) return this.unsupported('thread/read');
    const requestedId = resume ? this.threadId(params) : undefined;
    const existing = requestedId ? this.states.get(requestedId) : undefined;
    if (existing?.changing || (requestedId && this.openingThreadIds.has(requestedId)))
      throw new Error('This thread is already opening.');
    if (!existing && this.states.size + this.opening >= MAX_LOADED_THREADS)
      invalidParams(`This connection can load at most ${MAX_LOADED_THREADS} threads.`);
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
      'dynamicTools',
      'personality',
      'collaborationMode',
      'approvalsReviewer',
      'serviceName',
      'sessionStartSource',
      'threadSource',
    ]);
    const excludeTurns = optionalBoolean(params, 'excludeTurns') ?? false;
    if (resume && !excludeTurns && !this.backend.history) return this.unsupported('thread/turns/list');
    if (optionalBoolean(params, 'ephemeral')) invalidParams('Ephemeral threads are unavailable.');
    if (params.historyMode != null && params.historyMode !== 'legacy') invalidParams('Paginated native history is unavailable.');
    if (
      params.config != null &&
      (!isAppServerRecord(params.config) || Object.keys(params.config).length)
    )
      invalidParams('Execution settings are managed in the desktop app.');
    const model = optionalString(params, 'model');
    if (existing && (existing.active || existing.unknown) && model !== undefined && model !== existing.thread.modelRef)
      invalidParams('An active or unconfirmed thread cannot change its model.');
    const generation = existing?.subscriptionGeneration;
    this.opening++;
    if (requestedId) this.openingThreadIds.add(requestedId);
    if (existing) existing.changing = true;
    try {
      const options = {
        cwd: optionalString(params, 'cwd'),
        model: model ?? existing?.thread.modelRef,
      };
      const thread = resume
        ? await this.backend.resume(requestedId!, options)
        : await this.backend.start(options);
      this.assertOpen();
      if (resume && thread.id !== requestedId) throw new Error('The resumed thread identity changed.');
      const result = codexThreadOpen(thread, this.describe(thread.id), this.interactiveApprovals);
      if (resume && !excludeTurns) {
        const history = await this.history(thread.id);
        assertCodexHistoryFullSize(history.turns);
        (result.thread as AppServerResult).turns = history.turns;
      }
      this.assertOpen();
      if (existing && (this.states.get(thread.id) !== existing || existing.subscriptionGeneration !== generation))
        throw new Error('The thread subscription changed while reopening.');
      if (!existing && this.states.has(thread.id)) throw new Error('This connection already loaded the thread.');
      const state: ThreadState = existing ?? {
        thread, subscribed: false, subscriptionGeneration: 0,
      };
      state.thread = thread;
      this.states.set(thread.id, state);
      this.subscribe(state);
      if (state.unknown) (result.thread as AppServerResult).status = { type: 'systemError' };
      else if (state.active) (result.thread as AppServerResult).status = { type: 'active', activeFlags: [] };
      if (!resume) this.notifyAfterResponse(AppServerNotificationMethod.ThreadStarted, { thread: result.thread }, state);
      return result;
    } finally {
      this.opening--;
      if (requestedId) this.openingThreadIds.delete(requestedId);
      if (existing) {
        existing.changing = false;
        this.unloadIdle(existing);
      }
    }
  }

  private startTurn(params: AppServerParams): AppServerResult {
    const state = this.requireThread(params.threadId);
    if (state.active || state.unknown || state.changing)
      throw new Error('This thread has an active or unconfirmed turn.');
    const metadata = this.describe(state.thread.id);
    if (metadata.status === ExternalSessionStatus.Running || metadata.executionState === ExternalExecutionState.Unknown)
      throw new ExternalAgentBusyError('This thread has an active or unconfirmed turn.');
    rejectOverrides(params, [
      'effort',
      'serviceTier',
      'cwd',
      'approvalPolicy',
      'sandboxPolicy',
      'outputSchema',
      'collaborationMode',
      'personality',
      'approvalsReviewer',
      'toolOutput',
      'disabledPluginIds',
      'serviceTierForTurn',
      'parentTurnId',
      'rootTurnId',
      'clientUserMessageId',
      'turnTrigger',
      'summary',
    ]);
    if (
      !Array.isArray(params.input) ||
      params.input.some(
        item => record(item).type !== 'text' || typeof record(item).text !== 'string',
      )
    )
      invalidParams('Only text input is supported by this runtime.');
    const text = params.input.map(item => string(record(item).text) ?? '').join('\n');
    if (!text.trim() || Buffer.byteLength(text) > 8 * 1024 * 1024)
      invalidParams('Invalid turn input.');
    const model = optionalString(params, 'model');
    if (model !== undefined && !this.backend.models().some(candidate => candidate.id === model))
      invalidParams('The selected model is unavailable. Refresh the runtime model catalog.');
    if (this.interactiveApprovals && !this.resourceThreadIds.has(state.thread.id)) {
      if (this.resourceThreadIds.size >= MAX_RESOURCE_THREADS)
        invalidParams('This connection prepared too many threads; reconnect before starting another thread.');
      this.resourceThreadIds.add(state.thread.id);
    }
    const thread: ExternalAgentThread = { ...state.thread, ...(model !== undefined ? { modelRef: model } : {}) };
    state.thread = thread;
    const id = randomUUID();
    const startedAt = Date.now();
    const controller = new AbortController();
    const active: OwnedTurn = { id, controller, done: Promise.resolve() };
    state.active = active;
    // Admission returns immediately. Native work starts after its RPC response,
    // leaving the shared receive loop free to accept exact-turn interrupts.
    active.done = new Promise<void>(resolve => setImmediate(resolve)).then(async () => {
      const base = { threadId: thread.id, turnId: id };
      let streamError: ExternalAgentStreamError | undefined;
      const failStream = (message: string): void => {
        streamError ??= new ExternalAgentStreamError(message);
        controller.abort(streamError);
      };
      const publish = (method: AppServerNotificationMethod, params: AppServerParams, terminal = false): void => {
        if (state.active !== active && state.unknown?.id !== id) return;
        if ((this.closed || this.context.isClosed()) && !terminal) return;
        const envelope = { ...base, ...params };
        try {
          if (this.options.hub) this.options.hub.publish(method, envelope);
          else if (state.subscribed) this.deliver(method, envelope);
        } catch (error) {
          failStream(error instanceof Error ? error.message : 'Protocol output failed.');
          if (streamError) this.retireOutput(streamError);
        }
      };
      const notify: AppServerNotify = (method, params) => publish(method, params);
      const terminal: AppServerNotify = (method, params) => publish(method, params, true);
      const progress = new CodexAppServerProgress(text, notify, failStream);
      const tools = new CodexAppServerToolProgress(notify, failStream, () => progress.beforeTool());
      try {
        if (this.closed || this.context.isClosed()) return;
        notify(AppServerNotificationMethod.TurnStarted, { turn: codexTurn(id, CodexTurnStatus.InProgress, { startedAt }) });
        notify(AppServerNotificationMethod.ThreadStatusChanged, { status: { type: 'active', activeFlags: [] } });
        if (streamError) throw streamError;
        if (this.closed || this.context.isClosed())
          throw active.failure ?? new ExternalAgentCancelledError('The connection closed before native admission.');
        const hooks: ExternalAgentRunHooks | undefined = this.interactiveApprovals ? {
          interactiveApprovals: true,
          onPrepared: binding => {
            if (this.closed || this.context.isClosed() || controller.signal.aborted)
              throw new ExternalAgentCancelledError('The connection closed before native admission.');
            return this.options.resources!.prepare(
              thread, [], binding,
              createCodexApprovalPresenter(this.context, thread.id, id, controller.signal, () => controller.abort()),
              controller.signal,
            );
          },
        } : undefined;
        const finalText = await this.backend.run(
          thread,
          id,
          text,
          event => {
            if (controller.signal.aborted) return;
            progress.accept(event);
            if (controller.signal.aborted) return;
            tools.accept(event);
          },
          controller.signal,
          hooks,
        );
        if (streamError) throw streamError;
        if (active.failure) throw active.failure;
        if (controller.signal.reason instanceof ExternalAgentStreamError)
          throw controller.signal.reason;
        progress.finish(finalText);
        if (streamError) throw streamError;
        terminal(AppServerNotificationMethod.TurnCompleted, {
          turn: codexTurn(id, CodexTurnStatus.Completed, { startedAt, completedAt: Date.now() }),
        });
        terminal(AppServerNotificationMethod.ThreadStatusChanged, { status: { type: 'idle' } });
      } catch (error) {
        progress.finish();
        const failure = streamError ?? active.failure ?? error;
        const unknown = error instanceof ExternalAgentOutcomeUnknownError;
        if (unknown) state.unknown = { id, controller };
        const cancelled =
          failure instanceof ExternalAgentCancelledError &&
          !(controller.signal.reason instanceof ExternalAgentStreamError);
        terminal(AppServerNotificationMethod.TurnCompleted, {
          turn: codexTurn(id, cancelled ? CodexTurnStatus.Interrupted : CodexTurnStatus.Failed, {
            startedAt, completedAt: Date.now(),
            ...(cancelled ? {} : { error: `${unknown ? 'EXECUTION_UNKNOWN: ' : ''}${failure instanceof Error ? failure.message : 'Task failed.'}` }),
          }),
        });
        // A competing connection can acquire the native reservation after our
        // metadata check. Close this admitted turn without replacing its owner's
        // actual thread status.
        if (!(error instanceof ExternalAgentBusyError)) {
          terminal(AppServerNotificationMethod.ThreadStatusChanged, {
            status: cancelled ? { type: 'idle' } : { type: 'systemError' },
          });
        }
      } finally {
        if (state.active === active) state.active = undefined;
        this.unloadIdle(state);
      }
    });
    return { turn: codexTurn(id, CodexTurnStatus.InProgress, { startedAt }) };
  }
}
