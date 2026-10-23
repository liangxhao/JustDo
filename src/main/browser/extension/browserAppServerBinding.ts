import { createHash } from 'node:crypto';

import type { CoworkAttachmentPayload } from '../../../shared/cowork/attachments';
import { PRODUCT_NAME } from '../../../shared/productMetadata';
import type { PermissionMode } from '../../../shared/security/approvals';
import {
  type AppServerBinding,
  type AppServerConnectionContext,
  AppServerErrorStyle,
  AppServerNotificationMethod,
  type AppServerNotificationMethod as NotificationMethod,
  type AppServerOperation,
  type AppServerParams,
  type AppServerResult,
} from '../../appServer/appServerProtocol';
import { toAppServerThread } from './browserAppServerProjection';
import type {
  BrowserExtensionChatApi,
  BrowserExtensionMessage,
  BrowserExtensionPageContext,
} from './browserAppServerTypes';
import { readThreadImage } from './browserExtensionImage';

const POLL_INTERVAL_MS = 500;
const FULL_SNAPSHOT_POLL_INTERVAL = 20;
const TERMINAL_SETTLE_POLLS = 3;
const TERMINAL_MAX_POLLS = 20;
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

const extractTurnText = (params: Record<string, unknown>): string => {
  if (typeof params.message === 'string') return params.message;
  if (!Array.isArray(params.input)) return '';
  return params.input
    .filter(isRecord)
    .filter(item => item.type === 'text' || item.type === 'input_text')
    .map(item => (typeof item.text === 'string' ? item.text : ''))
    .filter(Boolean)
    .join('\n');
};

interface BrowserPeer {
  context: AppServerConnectionContext;
  subscriptions: Set<string>;
  generation: number;
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
  private readonly pollStates = new Map<
    string,
    {
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
    private readonly appVersion: string,
    private readonly createBrowserPairing?: () => Promise<{ pairingString: string }>,
  ) {}

  connect(context: AppServerConnectionContext): AppServerBinding {
    if (this.phase !== HubPhase.Active) throw new Error('Browser app-server is not active.');
    const peer: BrowserPeer = { context, subscriptions: new Set(), generation: this.generation };
    this.peers.add(peer);
    const operation =
      (run: AppServerOperation): AppServerOperation =>
      params => {
        this.assertPeerActive(peer);
        return run(params);
      };
    return {
      initialization: {
        result: {
          platformFamily:
            process.platform === 'win32'
              ? 'windows'
              : process.platform === 'darwin'
                ? 'macos'
                : 'linux',
          userAgent: PRODUCT_NAME + '/' + this.appVersion,
          platformOs: process.platform,
        },
        requireInitializedNotification: true,
        executeNotifications: true,
        errorStyle: AppServerErrorStyle.Standard,
      },
      threads: {
        start: operation(params => this.startThread(peer, params)),
        list: operation(params => this.listThreads(peer, params)),
        read: operation(params => this.readThread(peer, params)),
        unsubscribe: operation(params => this.unsubscribeThread(peer, params)),
      },
      turns: {
        start: operation(params => this.startTurn(peer, params)),
        interrupt: operation(params => this.interruptTurn(peer, params)),
      },
      composer: { options: operation(params => this.composerOptions(peer, params)) },
      images: { read: operation(params => this.readImage(peer, params)) },
      browserPairing: { create: operation(params => this.pairBrowser(peer, params)) },
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

  private detach(peer: BrowserPeer): void {
    this.peers.delete(peer);
    const threads = [...peer.subscriptions];
    peer.subscriptions.clear();
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
    if (!preserve) this.pollStates.clear();
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

  private broadcast(
    method: NotificationMethod,
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
        peer.context.notify(method, params);
    }
  }

  private async subscribeStream(peer: BrowserPeer, threadId: string): Promise<void> {
    this.assertPeerActive(peer);
    const epoch = this.observationEpoch;
    const subscriptions = peer.subscriptions;
    subscriptions.add(threadId);

    let stream = this.streamSubscriptions.get(threadId);
    if (!stream) {
      stream = this.api.subscribeThreadEvents(threadId, event => {
        if (epoch === this.observationEpoch)
          this.broadcast(
            AppServerNotificationMethod.ThreadStream,
            { threadId, ...event },
            threadId,
            peer.generation,
          );
      });
      this.streamSubscriptions.set(threadId, stream);
    }
    try {
      await stream;
    } catch (error) {
      if (this.streamSubscriptions.get(threadId) === stream)
        this.streamSubscriptions.delete(threadId);
      subscriptions.delete(threadId);
      throw error;
    }
    if (
      peer.context.isClosed() ||
      !this.peers.has(peer) ||
      !this.canObserve(peer.generation) ||
      epoch !== this.observationEpoch
    ) {
      subscriptions.delete(threadId);
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
    const cursor = typeof params.cursor === 'string' ? Number.parseInt(params.cursor, 10) : 0;
    const offset = Number.isSafeInteger(cursor) && cursor >= 0 ? cursor : 0;
    const requestedLimit = typeof params.limit === 'number' ? Math.floor(params.limit) : 50;
    const limit = Math.max(1, Math.min(requestedLimit, 100));
    const page = threads.slice(offset, offset + limit);
    return {
      data: page.map(thread => toAppServerThread(thread)),
      nextCursor: offset + page.length < threads.length ? String(offset + page.length) : null,
    };
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
    const threadId = typeof params.threadId === 'string' ? params.threadId : '';
    if (!threadId) throw new Error('threadId is required.');
    const thread = (await this.api.listSessions()).find(candidate => candidate.id === threadId);
    if (!thread) throw new Error('Thread not found.');
    await this.subscribeStream(peer, threadId);
    const messages =
      params.includeTurns === true
        ? await this.api.getMessages(threadId, { forceFullSnapshot: true })
        : undefined;
    const turnId = typeof params.turnId === 'string' ? params.turnId : undefined;
    const activeTurn = await this.api.getTurnState(threadId, turnId);
    if (this.canObserve(peer.generation)) {
      await this.requireThread(threadId);
      if (activeTurn && !activeTurn.executionSettled && !this.pollStates.has(threadId)) {
        this.startPollingTurn(
          threadId,
          activeTurn.id,
          messageFingerprint(messages ?? []),
          peer.generation,
        );
      }
    }
    return { thread: toAppServerThread(thread, messages), activeTurn };
  }

  private async startThread(peer: BrowserPeer, params: AppServerParams): Promise<AppServerResult> {
    const title = typeof params.title === 'string' ? params.title : undefined;
    const thread = await this.api.startThread(title);
    const appServerThread = toAppServerThread(thread);
    await this.subscribeStream(peer, thread.id);
    this.broadcast(
      AppServerNotificationMethod.ThreadStarted,
      { thread: appServerThread },
      thread.id,
      peer.generation,
    );
    return { instructionSources: [], thread: appServerThread };
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
    const threadId = typeof params.threadId === 'string' ? params.threadId : '';
    const subscriptions = peer.subscriptions;
    const removed = threadId ? subscriptions?.delete(threadId) === true : false;
    if (threadId) this.releaseStream(threadId);
    return { status: removed ? 'unsubscribed' : 'notSubscribed' };
  }

  private async startTurn(peer: BrowserPeer, params: AppServerParams): Promise<AppServerResult> {
    const invalidInput = (message: string): never => {
      throw Object.assign(new Error(message), { requestSent: false });
    };
    if (
      params.clientTurnId !== undefined &&
      (typeof params.clientTurnId !== 'string' ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
          params.clientTurnId,
        ))
    ) {
      invalidInput('Invalid client turn identity.');
    }
    let threadId = typeof params.threadId === 'string' ? params.threadId : undefined;
    const message = extractTurnText(params);
    const pageContext = isRecord(params.pageContext)
      ? (params.pageContext as BrowserExtensionPageContext)
      : undefined;
    if (params.attachments !== undefined && !Array.isArray(params.attachments)) {
      invalidInput('Invalid attachment payload.');
    }
    const attachments = params.attachments as CoworkAttachmentPayload[] | undefined;
    if (
      params.permissionMode !== undefined &&
      params.permissionMode !== 'ask' &&
      params.permissionMode !== 'auto' &&
      params.permissionMode !== 'full'
    ) {
      invalidInput('Invalid permission mode.');
    }
    const permissionMode = params.permissionMode as PermissionMode | undefined;
    const modelRef = typeof params.modelRef === 'string' ? params.modelRef : undefined;
    if (!message.trim()) invalidInput('Turn input is required.');
    let baselineMessages: BrowserExtensionMessage[];
    try {
      if (!threadId) threadId = (await this.api.startThread(message.slice(0, 50))).id;
      await this.subscribeStream(peer, threadId);
      baselineMessages = await this.api.getMessages(threadId);
      if (!this.canObserve(peer.generation)) throw new Error('Connection closed.');
    } catch (error) {
      throw Object.assign(error instanceof Error ? error : new Error(String(error)), {
        requestSent: false,
      });
    }
    const turn = await this.api.sendMessage({
      ...(typeof params.clientTurnId === 'string' ? { clientTurnId: params.clientTurnId } : {}),
      attachments,
      message,
      modelRef,
      pageContext,
      permissionMode,
      sessionId: threadId,
    });
    const turnPayload: Record<string, unknown> = {
      completedAt: null,
      durationMs: null,
      error: null,
      id: turn.runId,
      ...(turn.nativeRunId ? { nativeRunId: turn.nativeRunId } : {}),
      items: [],
      itemsView: 'full',
      startedAt: Math.floor(Date.now() / 1000),
      status: 'inProgress',
      executionSettled: false,
    };
    if (!this.canObserve(peer.generation)) return { turn: turnPayload };
    if (this.peers.has(peer) && !peer.context.isClosed()) peer.subscriptions.add(turn.sessionId);
    this.broadcast(
      AppServerNotificationMethod.TurnStarted,
      { threadId: turn.sessionId, turn: turnPayload },
      turn.sessionId,
      peer.generation,
    );
    this.startPollingTurn(
      turn.sessionId,
      turn.runId,
      messageFingerprint(baselineMessages.filter(message => !message.pendingInput)),
      peer.generation,
    );
    return { turn: turnPayload };
  }

  private async interruptTurn(
    peer: BrowserPeer,
    params: AppServerParams,
  ): Promise<AppServerResult> {
    const threadId = typeof params.threadId === 'string' ? params.threadId : '';
    if (!threadId) throw new Error('threadId is required.');
    const turnId = typeof params.turnId === 'string' ? params.turnId : '';
    if (!turnId) throw new Error('turnId is required.');
    const state = this.pollStates.get(threadId);
    if (state && state.turnId !== turnId) throw new Error('The active turn has changed.');
    await this.api.interruptThread(threadId, turnId);
    if (!state) this.startPollingTurn(threadId, turnId, '', peer.generation);
    return { status: 'requested', executionSettled: false };
  }

  private startPollingTurn(
    threadId: string,
    turnId: string,
    baselineFingerprint: string,
    generation: number,
  ): void {
    if (!this.canObserve(generation)) return;
    const previousState = this.pollStates.get(threadId);
    if (previousState?.timer) clearTimeout(previousState.timer);
    const state = {
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
    this.pollStates.set(threadId, state);
    let previousMessages = '';
    const poll = async () => {
      const epoch = this.observationEpoch;
      const current = () =>
        !state.paused &&
        this.phase === HubPhase.Active &&
        generation === this.generation &&
        epoch === this.observationEpoch &&
        this.pollStates.get(threadId) === state;
      if (!current()) return;
      state.timer = null;
      try {
        const threads = await this.api.listSessions();
        if (!current()) return;
        const thread = threads.find(candidate => candidate.id === threadId);
        state.missing = thread ? 0 : state.missing + 1;
        if (state.missing >= 3) {
          this.pollStates.delete(threadId);
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
        const fingerprint = messageFingerprint(messages);
        const historyChanged = fingerprint !== previousMessages;
        if (historyChanged) {
          previousMessages = fingerprint;
          state.terminal = 0;
          this.broadcast(
            AppServerNotificationMethod.ThreadUpdated,
            { thread: toAppServerThread(thread, messages), threadId },
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
          state.terminal >= TERMINAL_SETTLE_POLLS &&
          (terminalHistoryReady || state.terminal >= TERMINAL_MAX_POLLS)
        ) {
          const failed = turnState.status === 'failed';
          this.pollStates.delete(threadId);
          this.broadcast(
            AppServerNotificationMethod.TurnCompleted,
            {
              threadId,
              turn: {
                completedAt: Math.floor(Date.now() / 1000),
                durationMs: null,
                error: failed
                  ? {
                      message: recordedError ?? 'The agent run failed before producing a reply.',
                    }
                  : null,
                id: turnId,
                items: [],
                itemsView: 'full',
                startedAt: null,
                status: turnState.status,
                executionSettled: true,
              },
            },
            threadId,
            generation,
          );
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
