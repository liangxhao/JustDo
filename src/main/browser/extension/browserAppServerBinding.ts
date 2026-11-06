import { createHash, randomUUID } from 'node:crypto';

import type { CoworkAttachmentPayload } from '../../../shared/cowork/attachments';
import type { PermissionMode } from '../../../shared/security/approvals';
import { assertCodexHistoryFullSize, paginateCodexHistoryItems, paginateCodexHistoryTurns, projectCodexHistory } from '../../appServer/appServerHistory';
import { prepareAppServerInput } from '../../appServer/appServerInput';
import { invalidParams, optionalBoolean, optionalString, paginateIds, paginateThreads } from '../../appServer/appServerPagination';
import {
  type AppServerBinding,
  type AppServerConnectionContext,
  AppServerErrorCode,
  AppServerErrorStyle,
  AppServerNotificationMethod,
  type AppServerOperation,
  type AppServerParams,
  type AppServerResult,
  AppServerRpcError,
} from '../../appServer/appServerProtocol';
import { codexInitializeResult, codexModel, codexThread, codexThreadOpen, codexTurn, CodexTurnStatus } from '../../appServer/appServerWire';
import { ExternalApprovalSessionScope } from '../../openclaw/permissions/externalApprovalSessionScope';
import { BrowserAppServerLiveProjection } from './browserAppServerLiveProjection';
import { toAppServerMetadata, toAppServerThread, toBrowserDisplay } from './browserAppServerProjection';
import { BrowserAppServerMethod, BrowserAppServerNotificationMethod, browserWebLaunchMethods, wrapBrowserWebLaunchOperation } from './browserAppServerProtocol';
import type {
  BrowserExtensionChatApi,
  BrowserExtensionMessage,
  BrowserExtensionPageContext,
  BrowserExtensionThread,
  BrowserExtensionTurnState,
} from './browserAppServerTypes';
import { readThreadImage } from './browserExtensionImage';
import type { BrowserWebLaunchService } from './browserWebLaunchService';

const POLL_INTERVAL_MS = 500;
const FULL_SNAPSHOT_POLL_INTERVAL = 20;
const TERMINAL_SETTLE_POLLS = 3;
const TERMINAL_MAX_POLLS = 20;
const MAX_LOADED_THREADS = 32;
const MAX_OBSERVED_TURNS = 256;
const HubPhase = { Active: 'active', Paused: 'paused', Stopped: 'stopped' } as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const messageFingerprint = (messages: BrowserExtensionMessage[]): string =>
  createHash('sha256').update(JSON.stringify(messages)).digest('hex');

const hasFinalAssistantAfterLastUser = (messages: BrowserExtensionMessage[]): boolean => {
  const lastUserIndex = messages.findLastIndex(
    message => message.role === 'user' && !message.pendingInput,
  );
  return messages
    .slice(lastUserIndex + 1)
    .some(message => message.role === 'assistant' && Boolean(message.text));
};

interface BrowserPeer {
  context: AppServerConnectionContext;
  controller: AbortController;
  subscriptions: Set<string>;
  generation: number;
  models: Map<string, string>;
  subscriptionTokens: Map<string, symbol>;
  unloadTokens: Map<string, symbol>;
  approvals: Map<string, { controller: AbortController; scope: ExternalApprovalSessionScope }>;
  opening: number;
}

/** Chrome domain observations outlive a socket; disconnect only detaches that viewer. */
export class BrowserAppServerHub {
  private phase: (typeof HubPhase)[keyof typeof HubPhase] = HubPhase.Stopped;
  // Full stop retires pending requests; pause only retires in-flight observers.
  private generation = 0;
  private observationEpoch = 0;
  private browserPairingPromise: Promise<{ pairingString: string }> | null = null;
  private readonly peers = new Set<BrowserPeer>();
  private readonly streamSubscriptions = new Map<string, Promise<() => void>>();
  private readonly projections = new Map<string, BrowserAppServerLiveProjection>();
  private readonly pendingTurns = new Map<string, { threadId: string; leases: Set<symbol> }>();
  private readonly pendingStartResponses = new Map<string, symbol>();
  private readonly observedStatuses = new Map<string, string>();
  private readonly pollStates = new Map<
    string,
    {
      threadId: string;
      errors: number;
      baselineFingerprint: string;
      missing: number;
      paused: boolean;
      poll: () => void;
      polls: number;
      runtimeConfirmedActive: boolean;
      terminal: number;
      timer: NodeJS.Timeout | null;
      turnId: string;
    }
  >();

  constructor(
    private readonly api: BrowserExtensionChatApi,
    _appVersion: string,
    private readonly createBrowserPairing?: () => Promise<{ pairingString: string }>,
    private readonly webLaunch?: BrowserWebLaunchService,
    private readonly home = process.cwd(),
  ) {}

  connect(context: AppServerConnectionContext): AppServerBinding {
    if (this.phase !== HubPhase.Active) throw new Error('Browser app-server is not active.');
    const peer: BrowserPeer = {
      context, controller: new AbortController(), subscriptions: new Set(), generation: this.generation,
      models: new Map(), subscriptionTokens: new Map(),
      unloadTokens: new Map(), approvals: new Map(),
      opening: 0,
    };
    this.peers.add(peer);
    const operation =
      (run: AppServerOperation): AppServerOperation =>
      params => {
        this.assertPeerActive(peer);
        return run(params);
      };
    const webLaunchOperations = this.webLaunch?.getOperations();
    return {
      initialization: {
        result: codexInitializeResult(this.home),
        requireInitializedNotification: true,
        executeNotifications: false,
        errorStyle: AppServerErrorStyle.Codex,
      },
      threads: {
        start: operation(params => this.withOpening(peer, undefined, () => this.startThread(peer, params))),
        resume: operation(params => this.withOpening(peer, this.threadId(params), () => this.resumeThread(peer, params))),
        list: operation(params => this.listThreads(peer, params)),
        read: operation(params => this.readThread(peer, params)),
        unsubscribe: operation(params => this.unsubscribeThread(peer, params)),
        loadedList: operation(params => paginateIds(this.loadedIds(), params, 'browser-loaded', id => id)),
        turnsList: operation(async params => paginateCodexHistoryTurns(await this.history(this.threadId(params)), params)),
        itemsList: operation(async params => paginateCodexHistoryItems(await this.history(this.threadId(params)), params)),
        setName: operation(params => this.setName(peer, params)),
      },
      models: { list: operation(params => this.listModels(peer, params)) },
      turns: {
        start: operation(params => this.startTurn(peer, params)),
        interrupt: operation(params => this.interruptTurn(peer, params)),
      },
      extensions: {
        [BrowserAppServerMethod.ComposerOptions]: operation(params => this.composerOptions(peer, params)),
        [BrowserAppServerMethod.ThreadImage]: operation(params => this.readImage(peer, params)),
        [BrowserAppServerMethod.BrowserPair]: operation(params => this.pairBrowser(peer, params)),
        ...Object.fromEntries(browserWebLaunchMethods.flatMap(method => {
          const run = webLaunchOperations?.[method];
          return run ? [[method, wrapBrowserWebLaunchOperation(operation(run))]] : [];
        })),
      },
      onDisconnect: () => this.detach(peer),
    };
  }

  private canObserve(generation: number): boolean {
    // A detached viewer can leave an accepted run under background observation.
    return generation === this.generation && this.phase !== HubPhase.Stopped;
  }

  private assertPeerActive(peer: BrowserPeer): void {
    if (
      this.phase !== HubPhase.Active ||
      peer.generation !== this.generation ||
      !this.peers.has(peer) ||
      peer.context.isClosed()
    )
      throw new Error('Connection closed.');
  }

  private threadId(params: AppServerParams): string {
    const id = optionalString(params, 'threadId');
    if (!id) invalidParams('threadId is required.');
    return id;
  }

  private browserParams(params: AppServerParams): AppServerParams {
    if (params.browser == null) return {};
    if (!isRecord(params.browser)) invalidParams('browser must be an object.');
    return params.browser;
  }

  private rejectOverrides(params: AppServerParams, keys: readonly string[]): void {
    if (keys.some(key => params[key] != null)) invalidParams('Execution settings are managed in the desktop app.');
  }

  private validateThreadSettings(params: AppServerParams): void {
    this.rejectOverrides(params, ['serviceTier', 'approvalPolicy', 'sandbox', 'modelProvider', 'profile',
      'baseInstructions', 'developerInstructions', 'compactPrompt', 'includeApplyPatchTool', 'dynamicTools',
      'personality', 'collaborationMode', 'approvalsReviewer', 'serviceName', 'sessionStartSource', 'threadSource', 'title']);
    if (optionalBoolean(params, 'ephemeral')) invalidParams('Ephemeral threads are unavailable.');
    if (params.historyMode != null && params.historyMode !== 'legacy') invalidParams('Unsupported historyMode.');
    if (params.config != null && (!isRecord(params.config) || Object.keys(params.config).length))
      invalidParams('Execution settings are managed in the desktop app.');
  }

  private unsupported(method: string): never {
    throw new AppServerRpcError(AppServerErrorCode.MethodNotFound, `${method} is unavailable.`);
  }

  private loadedIds(): string[] {
    return [...new Set([
      ...[...this.peers].flatMap(peer => peer.context.isClosed() ? [] : [...peer.subscriptions]),
      ...[...this.pollStates.values()].map(state => state.threadId),
      ...[...this.pendingTurns.values()].map(state => state.threadId),
    ])].sort();
  }

  private pollKey(threadId: string, turnId: string): string {
    return JSON.stringify([threadId, turnId]);
  }

  private reservePollSlot(threadId: string, turnId: string): () => void {
    const key = this.pollKey(threadId, turnId);
    if (this.pollStates.has(key)) return () => {};
    let pending = this.pendingTurns.get(key);
    if (!pending) {
      if (this.pollStates.size + this.pendingTurns.size >= MAX_OBSERVED_TURNS)
        invalidParams('Too many browser turns are still under observation.');
      pending = { threadId, leases: new Set() };
      this.pendingTurns.set(key, pending);
    }
    const lease = Symbol();
    pending.leases.add(lease);
    return () => {
      if (this.pendingTurns.get(key) !== pending) return;
      pending.leases.delete(lease);
      if (!pending.leases.size) this.pendingTurns.delete(key);
    };
  }

  private publishStatus(threadId: string, status: AppServerResult, generation: number): void {
    const fingerprint = JSON.stringify(status);
    if (this.observedStatuses.get(threadId) === fingerprint) return;
    this.observedStatuses.set(threadId, fingerprint);
    this.broadcast(AppServerNotificationMethod.ThreadStatusChanged, { threadId, status }, threadId, generation);
  }

  /** A thread observation is never evidence that an execution has settled. */
  private async publishObservedStatus(threadId: string, generation: number, valid: () => boolean, expectedTurnId?: string): Promise<void> {
    const current = await this.api.getTurnState(threadId);
    if (!valid() || (expectedTurnId && current && current.id !== expectedTurnId)) return;
    if (current && !current.executionSettled) {
      this.publishStatus(threadId, current.status === 'inProgress'
        ? { type: 'active', activeFlags: [] } : { type: 'systemError' }, generation);
      return;
    }
    const runtime = await this.api.getThreadRuntimeStatus(threadId);
    if (!valid()) return;
    const after = await this.api.getTurnState(threadId);
    if (!valid() || (expectedTurnId && after && after.id !== expectedTurnId)) return;
    if (after && !after.executionSettled) {
      this.publishStatus(threadId, after.status === 'inProgress'
        ? { type: 'active', activeFlags: [] } : { type: 'systemError' }, generation);
    } else if (runtime.known) {
      this.publishStatus(threadId, runtime.running ? { type: 'active', activeFlags: [] } : { type: 'idle' }, generation);
    }
  }

  private selectedThread(peer: BrowserPeer, thread: BrowserExtensionThread): BrowserExtensionThread {
    const modelRef = peer.models.get(thread.id);
    return modelRef ? { ...thread, modelRef } : thread;
  }

  private async withOpening(peer: BrowserPeer, threadId: string | undefined, run: () => Promise<AppServerResult>): Promise<AppServerResult> {
    const reserved = !threadId || !peer.subscriptions.has(threadId);
    if (reserved && peer.subscriptions.size + peer.opening >= MAX_LOADED_THREADS)
      invalidParams(`This connection can load at most ${MAX_LOADED_THREADS} threads.`);
    if (reserved) peer.opening += 1;
    try { return await run(); }
    finally { if (reserved) peer.opening -= 1; }
  }

  private deliver(peer: BrowserPeer, method: string, params: AppServerParams): void {
    try {
      peer.context.notify(method, params);
    } catch {
      this.detach(peer);
      try { peer.context.fail?.(new Error('Browser app-server output failed.')); } catch { /* retired */ }
    }
  }

  private afterResponse(run: () => void, generation = this.generation): void {
    setImmediate(() => {
      if (this.canObserve(generation)) run();
    });
  }

  private projection(threadId: string): BrowserAppServerLiveProjection {
    let projection = this.projections.get(threadId);
    if (!projection) {
      const generation = this.generation;
      projection = new BrowserAppServerLiveProjection(threadId,
        (method, params) => this.broadcast(method, params, threadId, generation),
        error => {
          for (const peer of [...this.peers]) if (peer.subscriptions.has(threadId)) {
            this.detach(peer);
            try { peer.context.fail?.(error); } catch { /* retired */ }
          }
        });
      this.projections.set(threadId, projection);
    }
    return projection;
  }

  private async history(threadId: string) {
    await this.requireThread(threadId);
    if (!this.api.getHistory) return this.unsupported('thread/turns/list');
    const history = await this.api.getHistory(threadId);
    if (history.threadId !== threadId) throw new Error('The history thread identity changed.');
    await this.requireThread(threadId);
    return projectCodexHistory(history);
  }

  private async listModels(peer: BrowserPeer, params: AppServerParams): Promise<AppServerResult> {
    optionalBoolean(params, 'includeHidden');
    if (!this.api.getModels) return this.unsupported('model/list');
    const models = await this.api.getModels();
    this.assertPeerActive(peer);
    const page = paginateIds(models, params, 'browser-models', model => model.id);
    return { ...page, data: page.data.map(codexModel) };
  }

  private async setName(peer: BrowserPeer, params: AppServerParams): Promise<AppServerResult> {
    const threadId = this.threadId(params);
    const name = optionalString(params, 'name');
    if (!name?.trim() || name.trim().length > 500) invalidParams('name must contain 1 to 500 characters.');
    if (!this.api.setThreadName) return this.unsupported('thread/name/set');
    const thread = this.api.setThreadName(threadId, name);
    this.afterResponse(() => {
      this.broadcast(AppServerNotificationMethod.ThreadNameUpdated,
        { threadId, threadName: thread.title }, threadId, peer.generation);
      if (this.peers.has(peer) && !peer.subscriptions.has(threadId))
        this.deliver(peer, AppServerNotificationMethod.ThreadNameUpdated, { threadId, threadName: thread.title });
    }, peer.generation);
    return {};
  }

  private detach(peer: BrowserPeer): void {
    this.peers.delete(peer);
    peer.controller.abort();
    for (const approval of peer.approvals.values()) {
      approval.controller.abort();
      approval.scope.close();
    }
    peer.approvals.clear();
    const threads = [...peer.subscriptions];
    peer.subscriptions.clear();
    peer.subscriptionTokens.clear();
    peer.unloadTokens.clear();
    peer.models.clear();
    for (const threadId of threads) this.releaseStream(threadId);
  }

  async stop(options: { preserveActiveTurns?: boolean } = {}): Promise<void> {
    const preserve = options.preserveActiveTurns === true && this.phase !== HubPhase.Stopped;
    this.phase = preserve ? HubPhase.Paused : HubPhase.Stopped;
    this.observationEpoch += 1;
    if (!preserve) this.generation += 1;
    for (const peer of [...this.peers]) this.detach(peer);
    const streams = [...this.streamSubscriptions.values()];
    this.streamSubscriptions.clear();
    for (const state of this.pollStates.values()) {
      if (state.timer) clearTimeout(state.timer);
      state.timer = null;
      state.paused = true;
    }
    if (!preserve) {
      this.pollStates.clear();
      this.pendingTurns.clear();
      this.pendingStartResponses.clear();
      this.observedStatuses.clear();
      for (const projection of this.projections.values()) projection.clear();
      this.projections.clear();
    }
    if (!preserve) this.webLaunch?.close();
    await Promise.all(
      streams.map(stream =>
        stream.then(
          dispose => dispose(),
          (): void => {},
        ),
      ),
    );
  }

  activate(): void {
    if (this.phase === HubPhase.Active) return;
    this.phase = HubPhase.Active;
    for (const state of this.pollStates.values()) {
      state.paused = false;
      state.poll();
    }
  }

  notifyWebLaunchChanged(): void {
    if (this.phase !== HubPhase.Active) return;
    for (const peer of this.peers) if (peer.generation === this.generation && !peer.context.isClosed()) {
      this.deliver(peer, BrowserAppServerNotificationMethod.WebLaunchChanged, {});
    }
  }

  private broadcast(
    method: string,
    params: AppServerParams,
    threadId: string,
    generation: number,
  ): void {
    if (this.phase !== HubPhase.Active || generation !== this.generation) return;
    for (const peer of this.peers) {
      if (
        peer.generation === generation &&
        !peer.context.isClosed() &&
        peer.subscriptions.has(threadId)
      )
        this.deliver(peer, method, params);
    }
  }

  private async subscribeStream(peer: BrowserPeer, threadId: string): Promise<void> {
    this.assertPeerActive(peer);
    const epoch = this.observationEpoch;
    const subscriptions = peer.subscriptions;
    if (!subscriptions.has(threadId) && subscriptions.size >= MAX_LOADED_THREADS)
      invalidParams(`This connection can load at most ${MAX_LOADED_THREADS} threads.`);
    const token = peer.subscriptionTokens.get(threadId) ?? Symbol();
    peer.subscriptionTokens.set(threadId, token);
    peer.unloadTokens.delete(threadId);
    subscriptions.add(threadId);

    let stream = this.streamSubscriptions.get(threadId);
    if (!stream) {
      stream = this.api.subscribeThreadEvents(threadId, event => {
        if (epoch === this.observationEpoch) {
          this.broadcast(
            BrowserAppServerNotificationMethod.ThreadStream,
            { threadId, ...event },
            threadId,
            peer.generation,
          );
          this.projection(threadId).accept(event);
        }
      });
      this.streamSubscriptions.set(threadId, stream);
    }
    try {
      await stream;
    } catch (error) {
      if (this.streamSubscriptions.get(threadId) === stream)
        this.streamSubscriptions.delete(threadId);
      if (peer.subscriptionTokens.get(threadId) === token) {
        subscriptions.delete(threadId);
        peer.subscriptionTokens.delete(threadId);
      }
      throw error;
    }
    if (
      peer.context.isClosed() ||
      !this.peers.has(peer) ||
      !this.canObserve(peer.generation) ||
      epoch !== this.observationEpoch ||
      peer.subscriptionTokens.get(threadId) !== token || !subscriptions.has(threadId)
    ) {
      if (peer.subscriptionTokens.get(threadId) === token) {
        subscriptions.delete(threadId);
        peer.subscriptionTokens.delete(threadId);
      }
      this.releaseStream(threadId);
      throw new Error('Connection closed.');
    }
  }

  private releaseStream(threadId: string): void {
    const stream = this.streamSubscriptions.get(threadId);
    if (!stream) return;
    void stream.then(
      dispose => {
        if (this.streamSubscriptions.get(threadId) !== stream) return;
        if (
          [...this.peers].some(peer => !peer.context.isClosed() && peer.subscriptions.has(threadId))
        )
          return;
        this.streamSubscriptions.delete(threadId);
        dispose();
      },
      () => {},
    );
  }

  private async requireThread(threadId: string) {
    if (this.api.getThread) return this.api.getThread(threadId);
    const thread = (await this.api.listSessions()).find(candidate => candidate.id === threadId);
    if (!thread) throw new Error('Thread not found.');
    return thread;
  }

  private async pairBrowser(
    _peer: BrowserPeer,
    _params: AppServerParams,
  ): Promise<AppServerResult> {
    if (!this.createBrowserPairing) throw new Error('Browser extension pairing is unavailable.');
    try {
      if (!this.browserPairingPromise) {
        this.browserPairingPromise = this.createBrowserPairing().finally(() => {
          this.browserPairingPromise = null;
        });
      }
      const { pairingString } = await this.browserPairingPromise;
      return { pairingString };
    } catch {
      // Pairing/CLI errors can carry credential-bearing output.
      throw new Error('Browser extension pairing is unavailable.');
    }
  }

  private async listThreads(_peer: BrowserPeer, params: AppServerParams): Promise<AppServerResult> {
    const threads = await this.api.listSessions();
    this.assertPeerActive(_peer);
    const page = paginateThreads(threads.map(thread => toAppServerMetadata(this.selectedThread(_peer, thread))), params);
    return { ...page, data: page.data.map(metadata => codexThread(metadata, this.loadedIds().includes(metadata.id))) };
  }

  private async readImage(_peer: BrowserPeer, params: AppServerParams): Promise<AppServerResult> {
    const threadId = typeof params.threadId === 'string' ? params.threadId : '';
    const source = typeof params.source === 'string' ? params.source : '';
    const thread = await this.requireThread(threadId);
    if (/^media:/i.test(source) || source.startsWith('/api/chat/media/outgoing/')) {
      if (!this.api.readManagedImage) throw new Error('Gateway image reader is unavailable.');
      const dataUrl = await this.api.readManagedImage(threadId, source);
      await this.requireThread(threadId);
      return { dataUrl };
    }
    const messages = await this.api.getMessages(threadId);
    const dataUrl = await readThreadImage(source, thread.cwd, messages);
    await this.requireThread(threadId);
    return { dataUrl };
  }

  private async readThread(peer: BrowserPeer, params: AppServerParams): Promise<AppServerResult> {
    const threadId = this.threadId(params);
    const thread = this.selectedThread(peer, await this.requireThread(threadId));
    this.assertPeerActive(peer);
    const includeTurns = optionalBoolean(params, 'includeTurns') ?? false;
    const browser = this.browserParams(params);
    const messages =
      optionalBoolean(browser, 'includeDisplay') === true
        ? await this.api.getMessages(threadId, { forceFullSnapshot: true })
        : undefined;
    this.assertPeerActive(peer);
    const turnId = optionalString(browser, 'turnId');
    const activeTurn = await this.api.getTurnState(threadId, turnId);
    this.assertPeerActive(peer);
    const projected = toAppServerThread(thread, messages, activeTurn, this.loadedIds().includes(threadId));
    if (includeTurns) {
      const history = await this.history(threadId);
      this.assertPeerActive(peer);
      assertCodexHistoryFullSize(history.turns);
      projected.turns = history.turns;
    }
    return { thread: projected };
  }

  private async startThread(peer: BrowserPeer, params: AppServerParams): Promise<AppServerResult> {
    this.validateThreadSettings(params);
    if (peer.subscriptions.size >= MAX_LOADED_THREADS)
      invalidParams(`This connection can load at most ${MAX_LOADED_THREADS} threads.`);
    const browser = this.browserParams(params);
    const title = optionalString(browser, 'title');
    const model = optionalString(params, 'model');
    const cwd = optionalString(params, 'cwd');
    const thread = await this.api.startThread(title, { model, cwd });
    this.assertPeerActive(peer);
    const result = await this.openResult(peer, thread);
    await this.subscribeStream(peer, thread.id);
    this.afterResponse(() => this.broadcast(AppServerNotificationMethod.ThreadStarted,
      { thread: result.thread }, thread.id, peer.generation), peer.generation);
    const token = peer.subscriptionTokens.get(thread.id);
    this.afterResponse(() => {
      void this.publishObservedStatus(thread.id, peer.generation, () => this.canObserve(peer.generation) &&
        this.peers.has(peer) && peer.subscriptionTokens.get(thread.id) === token).catch(() => {});
    }, peer.generation);
    return result;
  }

  private async openResult(peer: BrowserPeer, thread: BrowserExtensionThread): Promise<AppServerResult> {
    let selected = this.selectedThread(peer, thread);
    if (!selected.modelRef) {
      if (!this.api.getModels) return this.unsupported('model/list');
      const model = (await this.api.getModels()).find(candidate => candidate.isDefault);
      this.assertPeerActive(peer);
      if (!model) throw new Error('The selected model is unavailable.');
      selected = { ...selected, modelRef: model.id };
    }
    return {
      ...codexThreadOpen(toAppServerMetadata(selected), toAppServerMetadata(selected),
        this.api.supportsClientApprovals === true && Boolean(peer.context.request)),
      thread: toAppServerThread(selected, undefined, null, true),
    };
  }

  private async resumeThread(peer: BrowserPeer, params: AppServerParams): Promise<AppServerResult> {
    this.validateThreadSettings(params);
    const threadId = this.threadId(params);
    const thread = await this.requireThread(threadId);
    this.assertPeerActive(peer);
    const cwd = optionalString(params, 'cwd');
    if (cwd !== undefined && (process.platform === 'win32' ? cwd.toLowerCase() !== thread.cwd.toLowerCase() : cwd !== thread.cwd))
      invalidParams('A resumed conversation cannot change its task directory.');
    const model = optionalString(params, 'model');
    if (model !== undefined) {
      const active = await this.api.getTurnState(threadId);
      this.assertPeerActive(peer);
      if (model !== thread.modelRef && active && !active.executionSettled)
        invalidParams('An active or unconfirmed thread cannot change its model.');
      if (!this.api.getModels || !(await this.api.getModels()).some(candidate => candidate.id === model))
        invalidParams('The selected model is unavailable.');
      this.assertPeerActive(peer);
      peer.models.set(threadId, model);
    }
    const result = await this.openResult(peer, thread);
    const read = await this.readThread(peer, {
      threadId, includeTurns: !(optionalBoolean(params, 'excludeTurns') ?? false), browser: this.browserParams(params),
    });
    result.thread = read.thread;
    const activeTurn = ((read.thread as AppServerResult).browser as { activeTurn?: BrowserExtensionTurnState }).activeTurn;
    const needsPoll = activeTurn && !activeTurn.executionSettled;
    const release = needsPoll ? this.reservePollSlot(threadId, activeTurn.id) : () => {};
    try {
      await this.subscribeStream(peer, threadId);
      const currentThread = await this.requireThread(threadId);
      this.assertPeerActive(peer);
      (result.thread as AppServerResult).status = codexThread(toAppServerMetadata(currentThread), true).status;
      if (needsPoll)
        this.afterResponse(() => this.startPollingTurn(threadId, activeTurn.id, '', peer.generation), peer.generation);
      const token = peer.subscriptionTokens.get(threadId);
      this.afterResponse(() => {
        void this.publishObservedStatus(threadId, peer.generation, () => this.canObserve(peer.generation) &&
          this.peers.has(peer) && peer.subscriptionTokens.get(threadId) === token).catch(() => {});
      }, peer.generation);
      return result;
    } catch (error) {
      release();
      throw error;
    }
  }

  private async composerOptions(
    _peer: BrowserPeer,
    params: AppServerParams,
  ): Promise<AppServerResult> {
    const threadId = typeof params.threadId === 'string' ? params.threadId : undefined;
    return { ...(await this.api.getComposerOptions(threadId)) };
  }

  private async unsubscribeThread(
    peer: BrowserPeer,
    params: AppServerParams,
  ): Promise<AppServerResult> {
    const threadId = this.threadId(params);
    const subscriptions = peer.subscriptions;
    peer.subscriptionTokens.delete(threadId);
    peer.models.delete(threadId);
    const approval = peer.approvals.get(threadId);
    approval?.controller.abort();
    approval?.scope.close();
    peer.approvals.delete(threadId);
    const removed = threadId ? subscriptions?.delete(threadId) === true : false;
    if (threadId) this.releaseStream(threadId);
    if (removed) {
      const token = Symbol();
      peer.unloadTokens.set(threadId, token);
      this.afterResponse(() => {
        if (peer.unloadTokens.get(threadId) !== token) return;
        peer.unloadTokens.delete(threadId);
        const unloaded = () => this.peers.has(peer) && !peer.context.isClosed() &&
          !peer.subscriptions.has(threadId) && !this.loadedIds().includes(threadId);
        if (!unloaded()) return;
        this.observedStatuses.delete(threadId);
        this.deliver(peer, AppServerNotificationMethod.ThreadStatusChanged, { threadId, status: { type: 'notLoaded' } });
        if (unloaded()) this.deliver(peer, AppServerNotificationMethod.ThreadClosed, { threadId });
      }, peer.generation);
    }
    return { status: removed ? 'unsubscribed' : this.loadedIds().includes(threadId) ? 'notSubscribed' : 'notLoaded' };
  }

  private async startTurn(peer: BrowserPeer, params: AppServerParams): Promise<AppServerResult> {
    const admission = { dispatchStarted: false };
    try {
      return await this.prepareAndStartTurn(peer, params, admission);
    } catch (error) {
      const failure = error instanceof Error ? error : new Error('Unable to prepare the browser turn.');
      if (!admission.dispatchStarted) Object.assign(failure, { requestSent: false });
      throw failure;
    }
  }

  private async prepareAndStartTurn(
    peer: BrowserPeer,
    params: AppServerParams,
    admission: { dispatchStarted: boolean },
  ): Promise<AppServerResult> {
    const invalidInput = (message: string): never => {
      throw Object.assign(new AppServerRpcError(AppServerErrorCode.InvalidParams, message), { requestSent: false });
    };
    const browser = this.browserParams(params);
    this.rejectOverrides(params, ['effort', 'serviceTier', 'cwd', 'approvalPolicy', 'sandboxPolicy',
      'outputSchema', 'collaborationMode', 'personality', 'approvalsReviewer', 'toolOutput', 'disabledPluginIds',
      'serviceTierForTurn', 'parentTurnId', 'rootTurnId', 'clientUserMessageId', 'turnTrigger', 'summary',
      'message', 'modelRef', 'clientTurnId', 'attachments', 'pageContext', 'permissionMode']);
    if (
      browser.clientTurnId !== undefined &&
      (typeof browser.clientTurnId !== 'string' ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
          browser.clientTurnId,
        ))
    ) {
      invalidInput('Invalid client turn identity.');
    }
    const threadId = this.threadId(params);
    const pageContext = isRecord(browser.pageContext)
      ? (browser.pageContext as BrowserExtensionPageContext)
      : undefined;
    if (browser.pageContext != null && !isRecord(browser.pageContext)) invalidInput('Invalid page context.');
    if (browser.attachments !== undefined && !Array.isArray(browser.attachments)) {
      invalidInput('Invalid attachment payload.');
    }
    const extraAttachments = browser.attachments as CoworkAttachmentPayload[] | undefined;
    if (
      browser.permissionMode !== undefined &&
      browser.permissionMode !== 'ask' &&
      browser.permissionMode !== 'auto' &&
      browser.permissionMode !== 'full'
    ) {
      invalidInput('Invalid permission mode.');
    }
    const permissionMode = browser.permissionMode as PermissionMode | undefined;
    const modelRef = optionalString(params, 'model') ?? peer.models.get(threadId);
    const clientTurnId = typeof browser.clientTurnId === 'string' ? browser.clientTurnId : randomUUID();
    const sourceThread = await this.requireThread(threadId);
    this.assertPeerActive(peer);
    const preparedInput = await prepareAppServerInput(params.input, {
      cwd: sourceThread.cwd,
      allowEmptyForAttachments: Boolean(extraAttachments?.length),
      signal: peer.controller.signal,
    });
    this.assertPeerActive(peer);
    const currentThread = await this.requireThread(threadId);
    this.assertPeerActive(peer);
    if (currentThread.cwd !== sourceThread.cwd)
      invalidInput('The conversation directory changed while preparing its input.');
    const message = preparedInput.message;
    if (message.length > 32_000) invalidInput('Turn text must contain at most 32000 characters.');
    const attachments = [...preparedInput.attachments, ...(extraAttachments ?? [])];
    let baselineMessages: BrowserExtensionMessage[];
    try {
      await this.requireThread(threadId);
      await this.subscribeStream(peer, threadId);
      baselineMessages = await this.api.getMessages(threadId);
      this.assertPeerActive(peer);
    } catch (error) {
      throw Object.assign(error instanceof Error ? error : new Error(String(error)), {
        requestSent: false,
      });
    }
    const startedAt = Date.now();
    const release = this.reservePollSlot(threadId, clientTurnId);
    const key = this.pollKey(threadId, clientTurnId);
    if (this.pendingStartResponses.has(key)) {
      release();
      invalidInput('This browser turn is already awaiting admission.');
    }
    const responseToken = Symbol();
    this.pendingStartResponses.set(key, responseToken);
    const releaseResponse = () => {
      if (this.pendingStartResponses.get(key) === responseToken) this.pendingStartResponses.delete(key);
    };
    const projection = this.projection(threadId);
    projection.prepareTurn(clientTurnId, preparedInput.content, startedAt);
    let approval = peer.approvals.get(threadId);
    if (!approval) {
      const controller = new AbortController();
      approval = { controller, scope: new ExternalApprovalSessionScope(controller.signal) };
      peer.approvals.set(threadId, approval);
    }
    const subscriptionToken = peer.subscriptionTokens.get(threadId);
    const assertCurrent = () => {
      this.assertPeerActive(peer);
      if (approval.controller.signal.aborted || !peer.subscriptions.has(threadId) ||
        peer.subscriptionTokens.get(threadId) !== subscriptionToken)
        throw Object.assign(new Error('Browser send ownership changed before admission.'), { requestSent: false });
    };
    let turn;
    try {
      admission.dispatchStarted = true;
      turn = await this.api.sendMessage({
        clientTurnId, attachments, message, modelRef, pageContext, permissionMode, sessionId: threadId,
      }, { assertCurrent, ...(this.api.supportsClientApprovals === true && peer.context.request ? {
        approvals: { context: peer.context, signal: approval.controller.signal, scope: approval.scope },
      } : {}) });
      if (turn.sessionId !== threadId || turn.runId !== clientTurnId)
        throw new Error('The accepted turn identity changed.');
    } catch (error) {
      projection.discardTurn(clientTurnId);
      releaseResponse();
      if (!(error instanceof Error) || (error as Error & { requestSent?: boolean }).requestSent !== false)
        this.afterResponse(() => this.startPollingTurn(threadId, clientTurnId, '', peer.generation), peer.generation);
      else release();
      throw error;
    }
    if (modelRef !== undefined) peer.models.set(threadId, modelRef);
    const turnPayload = codexTurn(turn.runId, CodexTurnStatus.InProgress, { startedAt });
    const activeTurn: BrowserExtensionTurnState = {
      id: turn.runId, ...(turn.nativeRunId ? { nativeRunId: turn.nativeRunId } : {}),
      status: 'inProgress', executionSettled: false, startedAt,
    };
    this.afterResponse(() => {
      this.broadcast(AppServerNotificationMethod.TurnStarted,
        { threadId, turnId: turn.runId, turn: turnPayload }, threadId, peer.generation);
      projection.admitTurn(turn.runId);
      releaseResponse();
      this.startPollingTurn(threadId, turn.runId,
        messageFingerprint(baselineMessages.filter(message => !message.pendingInput)), peer.generation);
    }, peer.generation);
    return { turn: turnPayload, browser: { activeTurn } };
  }

  private async interruptTurn(
    peer: BrowserPeer,
    params: AppServerParams,
  ): Promise<AppServerResult> {
    const threadId = this.threadId(params);
    const turnId = optionalString(params, 'turnId');
    if (!turnId) invalidParams('turnId is required.');
    await this.requireThread(threadId);
    const current = await this.api.getTurnState(threadId);
    this.assertPeerActive(peer);
    if (!current || current.id !== turnId || current.executionSettled)
      throw new Error('The active turn has changed or is already settled.');
    const state = this.pollStates.get(this.pollKey(threadId, turnId));
    const release = this.reservePollSlot(threadId, turnId);
    try { await this.api.interruptThread(threadId, turnId); }
    catch (error) { release(); throw error; }
    if (!state) this.afterResponse(() => this.startPollingTurn(threadId, turnId, '', peer.generation), peer.generation);
    return {};
  }

  private startPollingTurn(
    threadId: string,
    turnId: string,
    baselineFingerprint: string,
    generation: number,
  ): void {
    if (!this.canObserve(generation)) return;
    const key = this.pollKey(threadId, turnId);
    this.pendingTurns.delete(key);
    if (this.pollStates.has(key)) return;
    // All callers reserve a unique pair before their asynchronous admission.
    // Moving that reservation into this map cannot exceed the shared bound.
    const state = {
      threadId,
      errors: 0,
      baselineFingerprint,
      missing: 0,
      paused: this.phase === HubPhase.Paused,
      poll: () => {},
      polls: 0,
      runtimeConfirmedActive: false,
      terminal: 0,
      timer: null as NodeJS.Timeout | null,
      turnId,
    };
    this.pollStates.set(key, state);
    let previousMessages = '';
    const poll = async () => {
      const epoch = this.observationEpoch;
      const current = () =>
        !state.paused &&
        this.phase === HubPhase.Active &&
        generation === this.generation &&
        epoch === this.observationEpoch &&
        this.pollStates.get(key) === state;
      if (!current()) return;
      state.timer = null;
      try {
        const threads = await this.api.listSessions();
        if (!current()) return;
        const thread = threads.find(candidate => candidate.id === threadId);
        state.missing = thread ? 0 : state.missing + 1;
        if (state.missing >= 3) {
          this.pollStates.delete(key);
          return;
        }
        if (!thread) {
          state.timer = setTimeout(() => void poll(), POLL_INTERVAL_MS);
          return;
        }
        const runtimeStatus = await this.api.getThreadRuntimeStatus(threadId, {
          forceRefresh: thread.status === 'error' && !state.runtimeConfirmedActive,
        });
        if (!current()) return;
        const turnState = await this.api.getTurnState(threadId, turnId);
        if (!current()) return;
        if (turnState && !turnState.executionSettled) {
          await this.publishObservedStatus(threadId, generation, current, turnId);
          if (!current()) return;
        }
        const executionSettled =
          turnState?.id === turnId &&
          turnState.executionSettled === true &&
          ['completed', 'failed', 'interrupted'].includes(turnState.status);
        const runtimeRunning = runtimeStatus.known
          ? runtimeStatus.running
          : thread.status === 'running';
        if (runtimeRunning) state.runtimeConfirmedActive = true;
        const forceFullSnapshot =
          executionSettled || !runtimeRunning || state.polls % FULL_SNAPSHOT_POLL_INTERVAL === 0;
        state.polls += 1;
        const messages = await this.api.getMessages(threadId, { forceFullSnapshot });
        if (!current()) return;
        state.errors = 0;
        const fingerprint = createHash('sha256').update(JSON.stringify([messages, turnState])).digest('hex');
        const historyChanged = fingerprint !== previousMessages;
        if (historyChanged) {
          previousMessages = fingerprint;
          state.terminal = 0;
          this.broadcast(
            BrowserAppServerNotificationMethod.ThreadUpdated,
            { threadId, display: toBrowserDisplay(threadId, messages), activeTurn: turnState },
            threadId,
            generation,
          );
        }
        if (executionSettled) {
          state.terminal += 1;
        } else {
          state.terminal = 0;
        }
        // OpenClaw can publish the terminal session status just before the final
        // assistant message becomes visible through sessions.history. Keep the
        // poller alive for a short settling window so that the extension receives
        // that final history update before turn/completed stops polling.
        const hasNewHistory =
          messageFingerprint(messages.filter(message => !message.pendingInput)) !==
          state.baselineFingerprint;
        const hasFinalAssistant = hasNewHistory && hasFinalAssistantAfterLastUser(messages);
        const recordedError =
          turnState?.error?.message ??
          (state.terminal >= TERMINAL_SETTLE_POLLS
            ? this.api.consumeTurnError(threadId, turnId)
            : undefined);
        const terminalHistoryReady =
          turnState?.status === 'failed' ||
          turnState?.status === 'interrupted' ||
          Boolean(recordedError) ||
          hasFinalAssistant;
        if (
          executionSettled &&
          !this.pendingStartResponses.has(key) &&
          state.terminal >= TERMINAL_SETTLE_POLLS &&
          (terminalHistoryReady || state.terminal >= TERMINAL_MAX_POLLS)
        ) {
          const failed = turnState.status === 'failed';
          let finalText: string | undefined;
          if (this.api.getHistory) {
            try {
              const history = await this.history(threadId);
              if (!current()) return;
              const items = history.turns.find(turn => turn.id === turnId)?.items ?? [];
              const final = [...items].reverse().find(item => item.type === 'agentMessage' &&
                item.phase === 'final_answer' && typeof item.text === 'string');
              if (typeof final?.text === 'string') finalText = final.text;
            } catch {
              // The exact terminal remains valid even when rich native history
              // cannot be projected as standard items. Do not invent final text.
            }
          }
          if (!current()) return;
          this.projection(threadId).finishTurn(turnId, finalText);
          this.broadcast(
            AppServerNotificationMethod.TurnCompleted,
            {
              threadId,
              turnId,
              turn: codexTurn(turnId, turnState.status === 'interrupted'
                ? CodexTurnStatus.Interrupted : failed ? CodexTurnStatus.Failed : CodexTurnStatus.Completed, {
                startedAt: turnState.startedAt, completedAt: turnState.completedAt,
                ...(failed && recordedError ? { error: recordedError } : {}),
              }),
            },
            threadId,
            generation,
          );
          try { await this.publishObservedStatus(threadId, generation, current, turnId); }
          catch { /* The exact terminal remains valid when the live status is unavailable. */ }
          if (this.pollStates.get(key) === state) this.pollStates.delete(key);
          return;
        }
      } catch {
        state.errors += 1;
      }
      if (current()) {
        state.timer = setTimeout(() => void poll(), state.errors >= 120 ? 5_000 : POLL_INTERVAL_MS);
      }
    };
    state.poll = () => void poll();
    state.poll();
  }
}
