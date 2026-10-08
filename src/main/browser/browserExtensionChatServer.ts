import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, type Server } from 'node:http';

import { WebSocket, WebSocketServer } from 'ws';

import {
  BROWSER_EXTENSION_STREAM_METHOD,
  type BrowserExtensionStreamEvent,
} from '../../shared/browser/browserExtensionStream';
import type { CoworkAttachmentPayload } from '../../shared/cowork/attachments';
import type { PermissionMode } from '../../shared/openclaw/approvals';
import { PRODUCT_NAME } from '../../shared/productMetadata';
import { readThreadImage } from './browserExtensionImage';

export const BROWSER_EXTENSION_ID = 'jboajogplelmaahjbomgflnfngpolgcb';
export const BROWSER_EXTENSION_NATIVE_HOST = 'com.justdo.browserextension';
export const BROWSER_EXTENSION_PAIR_METHOD = 'browser/extension/pair';
const MAX_MESSAGE_BYTES = 8 * 1024 * 1024;
const POLL_INTERVAL_MS = 500;
const FULL_SNAPSHOT_POLL_INTERVAL = 20;
const TERMINAL_SETTLE_POLLS = 3;
const TERMINAL_MAX_POLLS = 20;

export interface BrowserExtensionPageContext {
  title?: string;
  url?: string;
  selectedText?: string;
  pageText?: string;
}

export interface BrowserExtensionChatRequest {
  attachments?: CoworkAttachmentPayload[];
  message: string;
  modelRef?: string;
  permissionMode?: PermissionMode;
  sessionId?: string;
  pageContext?: BrowserExtensionPageContext;
}

export interface BrowserExtensionThread {
  id: string;
  title: string;
  status: string;
  createdAt: number;
  updatedAt: number;
  cwd: string;
  modelRef?: string;
  permissionMode: PermissionMode;
}

export interface BrowserExtensionMessage {
  pendingInput?: { id: string; state: string; runId?: string; incomplete?: boolean };
  rawMessage?: Record<string, unknown>;
  role: string;
  text: string;
  thinking?: string;
  modelName?: string;
  toolName?: string;
  toolUseId?: string;
  toolInput?: unknown;
  isError?: boolean;
}

export interface BrowserExtensionTurnResult {
  sessionId: string;
  runId: string;
}

export interface BrowserExtensionChatApi {
  subscribeThreadEvents: (
    sessionId: string,
    listener: (event: BrowserExtensionStreamEvent) => void,
  ) => Promise<() => void>;
  listSessions: () => Promise<BrowserExtensionThread[]> | BrowserExtensionThread[];
  getMessages: (
    sessionId: string,
    options?: { forceFullSnapshot?: boolean },
  ) => Promise<BrowserExtensionMessage[]>;
  readManagedImage?: (sessionId: string, source: string) => Promise<string>;
  startThread: (title?: string) => Promise<BrowserExtensionThread>;
  getComposerOptions: (sessionId?: string) => Promise<BrowserExtensionComposerOptions>;
  sendMessage: (request: BrowserExtensionChatRequest) => Promise<BrowserExtensionTurnResult>;
  getThreadRuntimeStatus: (
    sessionId: string,
    options?: { forceRefresh?: boolean },
  ) => Promise<{ known: boolean; running: boolean }>;
  consumeTurnError: (sessionId: string, runId: string) => string | undefined;
  interruptThread: (sessionId: string) => Promise<void>;
}

export interface BrowserExtensionComposerOptions {
  modelRef?: string;
  models: Array<{ id: string; name: string }>;
  permissionMode: PermissionMode;
}

export interface BrowserExtensionAppServerCapability {
  localAppServerUrl: string;
}

type RpcRequest = { id?: unknown; method?: unknown; params?: unknown };

type AppServerThreadStatus =
  { type: 'active'; activeFlags: string[] } | { type: 'idle' | 'systemError' };

type AppServerTurn = {
  id: string;
  status: 'completed';
  items: Array<Record<string, unknown>>;
  error: { message: string } | null;
  itemsView: 'full';
  startedAt: null;
  completedAt: null;
  durationMs: null;
};

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

const isAuthorizedToken = (supplied: string, expectedToken: string): boolean => {
  const suppliedBuffer = Buffer.from(supplied, 'utf8');
  const expectedBuffer = Buffer.from(expectedToken, 'utf8');
  return (
    suppliedBuffer.length === expectedBuffer.length &&
    timingSafeEqual(suppliedBuffer, expectedBuffer)
  );
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

const toAppServerStatus = (status: string): AppServerThreadStatus => {
  if (status === 'running') return { type: 'active', activeFlags: [] };
  if (status === 'error') return { type: 'systemError' };
  return { type: 'idle' };
};

const toAppServerTurns = (
  threadId: string,
  messages: BrowserExtensionMessage[],
): AppServerTurn[] => {
  const turns: AppServerTurn[] = [];
  let items: Array<Record<string, unknown>> = [];
  let itemOrdinal = 0;
  const nextItemId = () => `${threadId}-item-${++itemOrdinal}`;
  const flush = () => {
    if (!items.length) return;
    turns.push({
      error: null,
      completedAt: null,
      durationMs: null,
      id: `${threadId}-history-${turns.length + 1}`,
      items,
      itemsView: 'full',
      startedAt: null,
      status: 'completed',
    });
    items = [];
  };
  messages.forEach(message => {
    if (message.role === 'user' && items.length) flush();
    if (message.role === 'user') {
      items.push({
        content: [{ text: message.text, type: 'text' }],
        ...(message.rawMessage ? { rawMessage: message.rawMessage } : {}),
        ...(message.pendingInput ? { pendingInput: message.pendingInput } : {}),
        id: nextItemId(),
        type: 'userMessage',
      });
      return;
    }
    if (message.role === 'assistant') {
      if (message.thinking) {
        items.push({
          content: [message.thinking],
          id: nextItemId(),
          summary: [],
          type: 'reasoning',
        });
      }
      if (message.text || message.rawMessage) {
        items.push({
          ...(message.rawMessage ? { rawMessage: message.rawMessage } : {}),
          id: nextItemId(),
          phase: 'final_answer',
          text: message.text,
          type: 'agentMessage',
        });
      }
      return;
    }
    if (message.role === 'tool_use') {
      items.push({
        id: nextItemId(),
        input: message.toolInput ?? message.text,
        isError: false,
        output: null,
        status: 'inProgress',
        toolName: message.toolName ?? 'tool',
        toolUseId: message.toolUseId ?? null,
        type: 'toolCall',
      });
      return;
    }
    if (message.role === 'tool_result') {
      const matchingTool = [...items]
        .reverse()
        .find(
          item =>
            item.type === 'toolCall' && message.toolUseId && item.toolUseId === message.toolUseId,
        );
      if (matchingTool) {
        matchingTool.output = message.text;
        matchingTool.isError = message.isError === true;
        matchingTool.status = message.isError === true ? 'failed' : 'completed';
      } else {
        items.push({
          id: nextItemId(),
          input: message.toolInput ?? null,
          isError: message.isError === true,
          output: message.text,
          status: message.isError === true ? 'failed' : 'completed',
          toolName: message.toolName ?? 'tool',
          toolUseId: message.toolUseId ?? null,
          type: 'toolCall',
        });
      }
      return;
    }
    if (message.text) {
      items.push({ id: nextItemId(), text: message.text, type: 'systemMessage' });
    }
  });
  flush();
  return turns;
};

const toAppServerThread = (
  thread: BrowserExtensionThread,
  messages?: BrowserExtensionMessage[],
): Record<string, unknown> => ({
  agentNickname: null,
  agentRole: null,
  canAcceptDirectInput: true,
  cliVersion: PRODUCT_NAME,
  createdAt: Math.floor(thread.createdAt / 1000),
  cwd: thread.cwd,
  daybreakEnabled: null,
  ephemeral: false,
  environments: null,
  extra: null,
  forkedFromId: null,
  gitInfo: null,
  historyMode: 'legacy',
  id: thread.id,
  isPinned: false,
  model: thread.modelRef ?? null,
  modelProvider: thread.modelRef?.split('/')[0] || 'justdo',
  permissionMode: thread.permissionMode,
  name: thread.title,
  originator: 'justdo-chrome-extension',
  parentThreadId: null,
  path: null,
  preview: thread.title,
  projectId: null,
  reasoningEffort: null,
  recencyAt: Math.floor(thread.updatedAt / 1000),
  section: null,
  sectionEnteredAt: null,
  sessionId: thread.id,
  source: 'appServer',
  status: toAppServerStatus(thread.status),
  threadSource: 'user',
  turns: messages ? toAppServerTurns(thread.id, messages) : [],
  updatedAt: Math.floor(thread.updatedAt / 1000),
});

export class BrowserExtensionChatServer {
  private server: Server | null = null;
  private webSocketServer: WebSocketServer | null = null;
  private boundPort: number | null = null;
  private browserPairingPromise: Promise<{ pairingString: string }> | null = null;
  private readonly initializedConnections = new WeakSet<WebSocket>();
  private readonly initializeRequestedConnections = new WeakSet<WebSocket>();
  private readonly notificationOptOut = new WeakMap<WebSocket, Set<string>>();
  private readonly subscriptions = new WeakMap<WebSocket, Set<string>>();
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
    private readonly token: string,
    private readonly appVersion: string,
    private readonly port = 0,
    private readonly createBrowserPairing?: () => Promise<{ pairingString: string }>,
  ) {}

  getCapability(): BrowserExtensionAppServerCapability {
    if (this.boundPort === null) throw new Error('Browser extension app-server is not running.');
    return {
      localAppServerUrl: `ws://127.0.0.1:${this.boundPort}/app-server?token=${this.token}`,
    };
  }

  async start(): Promise<void> {
    if (this.server) return;
    const server = createServer((_request, response) => {
      response.writeHead(404, { 'Cache-Control': 'no-store' });
      response.end();
    });
    const webSocketServer = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });
    server.on('upgrade', (request, socket, head) => {
      const origin = request.headers.origin;
      let url: URL;
      try {
        url = new URL(request.url ?? '/', 'http://127.0.0.1');
      } catch {
        socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
      const suppliedToken = url.searchParams.get('token') ?? '';
      if (
        origin !== `chrome-extension://${BROWSER_EXTENSION_ID}` ||
        url.pathname !== '/app-server' ||
        !isAuthorizedToken(suppliedToken, this.token)
      ) {
        socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
      webSocketServer.handleUpgrade(request, socket, head, connection => {
        webSocketServer.emit('connection', connection, request);
      });
    });
    webSocketServer.on('connection', connection => {
      connection.on('close', () => {
        const threads = this.subscriptions.get(connection);
        this.subscriptions.delete(connection);
        for (const threadId of threads ?? []) this.releaseStream(threadId);
      });
      connection.on('error', () => {
        // Invalid frames and abrupt local disconnects must not become uncaught Main errors.
      });
      connection.on('message', data => {
        void this.handleMessage(connection, data.toString('utf8'));
      });
    });
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        server.off('listening', onListening);
        reject(error);
      };
      const onListening = () => {
        server.off('error', onError);
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(this.port, '127.0.0.1');
    });
    this.server = server;
    this.webSocketServer = webSocketServer;
    const address = server.address();
    this.boundPort = address && typeof address === 'object' ? address.port : this.port;
  }

  async stop(options: { preserveActiveTurns?: boolean } = {}): Promise<void> {
    const webSocketServer = this.webSocketServer;
    const server = this.server;
    this.webSocketServer = null;
    this.server = null;
    this.boundPort = null;
    webSocketServer?.clients.forEach(client => client.terminate());
    const streams = [...this.streamSubscriptions.values()];
    this.streamSubscriptions.clear();
    for (const state of this.pollStates.values()) {
      if (state.timer) clearTimeout(state.timer);
      state.timer = null;
      state.paused = options.preserveActiveTurns === true;
    }
    if (!options.preserveActiveTurns) {
      this.pollStates.clear();
    }
    await Promise.all(
      streams.map(stream =>
        stream.then(
          dispose => dispose(),
          (): void => {},
        ),
      ),
    );
    await new Promise<void>(resolve => webSocketServer?.close(() => resolve()) ?? resolve());
    await new Promise<void>(resolve => server?.close(() => resolve()) ?? resolve());
  }

  async restart(): Promise<void> {
    await this.stop({ preserveActiveTurns: true });
    await this.start();
    for (const state of this.pollStates.values()) {
      state.paused = false;
      state.poll();
    }
  }

  private send(connection: WebSocket, payload: unknown): void {
    if (connection.readyState === WebSocket.OPEN) connection.send(JSON.stringify(payload));
  }

  private broadcast(method: string, params: unknown, threadId?: string): void {
    this.webSocketServer?.clients.forEach(connection => {
      const subscribed = !threadId || this.subscriptions.get(connection)?.has(threadId);
      if (subscribed && !this.notificationOptOut.get(connection)?.has(method)) {
        this.send(connection, { method, params });
      }
    });
  }

  private async subscribeStream(connection: WebSocket, threadId: string): Promise<void> {
    if (!this.webSocketServer || connection.readyState !== WebSocket.OPEN)
      throw new Error('Connection closed.');
    const subscriptions = this.subscriptions.get(connection) ?? new Set<string>();
    subscriptions.add(threadId);
    this.subscriptions.set(connection, subscriptions);
    let stream = this.streamSubscriptions.get(threadId);
    if (!stream) {
      stream = this.api.subscribeThreadEvents(threadId, event => {
        this.broadcast(BROWSER_EXTENSION_STREAM_METHOD, { threadId, ...event }, threadId);
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
    if (connection.readyState !== WebSocket.OPEN) {
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
          [...(this.webSocketServer?.clients ?? [])].some(
            connection =>
              connection.readyState === WebSocket.OPEN &&
              this.subscriptions.get(connection)?.has(threadId),
          )
        )
          return;
        this.streamSubscriptions.delete(threadId);
        dispose();
      },
      () => {},
    );
  }

  private async handleMessage(connection: WebSocket, raw: string): Promise<void> {
    let request: RpcRequest;
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!isRecord(parsed)) throw new Error('Invalid request.');
      request = parsed;
    } catch {
      this.send(connection, { error: { code: -32700, message: 'Parse error.' }, id: null });
      return;
    }
    const id = request.id;
    if (typeof request.method !== 'string') {
      this.send(connection, {
        error: { code: -32600, message: 'Invalid request.' },
        id: id ?? null,
      });
      return;
    }
    if (request.method === 'initialized' && id === undefined) {
      if (this.initializeRequestedConnections.has(connection)) {
        this.initializedConnections.add(connection);
      }
      return;
    }
    if (request.method === 'initialize') {
      if (this.initializeRequestedConnections.has(connection)) {
        this.send(connection, {
          error: { code: -32600, message: 'Already initialized.' },
          id: id ?? null,
        });
        return;
      }
      this.initializeRequestedConnections.add(connection);
      const params = isRecord(request.params) ? request.params : {};
      const capabilities = isRecord(params.capabilities) ? params.capabilities : {};
      const methods = Array.isArray(capabilities.optOutNotificationMethods)
        ? capabilities.optOutNotificationMethods.filter(
            (method): method is string => typeof method === 'string',
          )
        : [];
      this.notificationOptOut.set(connection, new Set(methods));
    }
    if (request.method !== 'initialize' && !this.initializedConnections.has(connection)) {
      if (id !== undefined) {
        this.send(connection, {
          error: { code: -32002, message: 'Connection is not initialized.' },
          id,
        });
      }
      return;
    }
    if (id === undefined) {
      try {
        await this.dispatch(connection, request.method, request.params);
      } catch {
        // JSON-RPC notifications do not receive a response, including failures.
      }
      return;
    }
    try {
      const result = await this.dispatch(connection, request.method, request.params);
      this.send(connection, { id, result });
    } catch (error) {
      const methodNotFound = error instanceof Error && error.message === 'Method not found.';
      this.send(connection, {
        error: {
          code: methodNotFound ? -32601 : -32603,
          message: error instanceof Error ? error.message : 'Internal error.',
        },
        id,
      });
    }
  }

  private async dispatch(
    connection: WebSocket,
    method: string,
    rawParams: unknown,
  ): Promise<unknown> {
    const params = isRecord(rawParams) ? rawParams : {};
    switch (method) {
      case BROWSER_EXTENSION_PAIR_METHOD: {
        if (!this.createBrowserPairing)
          throw new Error('Browser extension pairing is unavailable.');
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
      case 'initialize':
        return {
          platformFamily:
            process.platform === 'win32'
              ? 'windows'
              : process.platform === 'darwin'
                ? 'macos'
                : 'linux',
          userAgent: `${PRODUCT_NAME}/${this.appVersion}`,
          platformOs: process.platform,
        };
      case 'thread/list': {
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
      case 'thread/image': {
        const threadId = typeof params.threadId === 'string' ? params.threadId : '';
        const source = typeof params.source === 'string' ? params.source : '';
        const thread = (await this.api.listSessions()).find(candidate => candidate.id === threadId);
        if (!thread) throw new Error('Thread not found.');
        if (/^media:/i.test(source) || source.startsWith('/api/chat/media/outgoing/')) {
          if (!this.api.readManagedImage) throw new Error('Gateway image reader is unavailable.');
          return { dataUrl: await this.api.readManagedImage(threadId, source) };
        }
        const messages = await this.api.getMessages(threadId);
        return { dataUrl: await readThreadImage(source, thread.cwd, messages) };
      }
      case 'thread/read': {
        const threadId = typeof params.threadId === 'string' ? params.threadId : '';
        if (!threadId) throw new Error('threadId is required.');
        const thread = (await this.api.listSessions()).find(candidate => candidate.id === threadId);
        if (!thread) throw new Error('Thread not found.');
        await this.subscribeStream(connection, threadId);
        const messages =
          params.includeTurns === true
            ? await this.api.getMessages(threadId, { forceFullSnapshot: true })
            : undefined;
        return { thread: toAppServerThread(thread, messages) };
      }
      case 'thread/start': {
        const title = typeof params.title === 'string' ? params.title : undefined;
        const thread = await this.api.startThread(title);
        const appServerThread = toAppServerThread(thread);
        await this.subscribeStream(connection, thread.id);
        this.broadcast('thread/started', { thread: appServerThread }, thread.id);
        return { instructionSources: [], thread: appServerThread };
      }
      case 'composer/options': {
        const threadId = typeof params.threadId === 'string' ? params.threadId : undefined;
        return this.api.getComposerOptions(threadId);
      }
      case 'thread/unsubscribe': {
        const threadId = typeof params.threadId === 'string' ? params.threadId : '';
        const subscriptions = this.subscriptions.get(connection);
        const removed = threadId ? subscriptions?.delete(threadId) === true : false;
        if (threadId) this.releaseStream(threadId);
        return { status: removed ? 'unsubscribed' : 'notSubscribed' };
      }
      case 'turn/start': {
        let threadId = typeof params.threadId === 'string' ? params.threadId : undefined;
        const message = extractTurnText(params);
        const pageContext = isRecord(params.pageContext)
          ? (params.pageContext as BrowserExtensionPageContext)
          : undefined;
        if (params.attachments !== undefined && !Array.isArray(params.attachments)) {
          throw new Error('Invalid attachment payload.');
        }
        const attachments = params.attachments as CoworkAttachmentPayload[] | undefined;
        if (
          params.permissionMode !== undefined &&
          params.permissionMode !== 'ask' &&
          params.permissionMode !== 'auto' &&
          params.permissionMode !== 'full'
        ) {
          throw new Error('Invalid permission mode.');
        }
        const permissionMode = params.permissionMode as PermissionMode | undefined;
        const modelRef = typeof params.modelRef === 'string' ? params.modelRef : undefined;
        if (!message.trim()) throw new Error('Turn input is required.');
        if (!threadId) threadId = (await this.api.startThread(message.slice(0, 50))).id;
        await this.subscribeStream(connection, threadId);
        const baselineMessages = threadId ? await this.api.getMessages(threadId) : [];
        const turn = await this.api.sendMessage({
          attachments,
          message,
          modelRef,
          pageContext,
          permissionMode,
          sessionId: threadId,
        });
        const subscriptions = this.subscriptions.get(connection) ?? new Set<string>();
        subscriptions.add(turn.sessionId);
        this.subscriptions.set(connection, subscriptions);
        const turnPayload: Record<string, unknown> = {
          completedAt: null,
          durationMs: null,
          error: null,
          id: turn.runId,
          items: [],
          itemsView: 'full',
          startedAt: Math.floor(Date.now() / 1000),
          status: 'inProgress',
        };
        this.broadcast(
          'turn/started',
          { threadId: turn.sessionId, turn: turnPayload },
          turn.sessionId,
        );
        this.startPollingTurn(
          turn.sessionId,
          turn.runId,
          messageFingerprint(baselineMessages.filter(message => !message.pendingInput)),
        );
        return { turn: turnPayload };
      }
      case 'turn/interrupt': {
        const threadId = typeof params.threadId === 'string' ? params.threadId : '';
        if (!threadId) throw new Error('threadId is required.');
        const state = this.pollStates.get(threadId);
        if (state?.timer) clearTimeout(state.timer);
        this.pollStates.delete(threadId);
        try {
          await this.api.interruptThread(threadId);
        } catch (error) {
          if (state) {
            this.startPollingTurn(threadId, state.turnId, state.baselineFingerprint);
          }
          throw error;
        }
        this.broadcast(
          'turn/completed',
          {
            threadId,
            turn: {
              completedAt: Math.floor(Date.now() / 1000),
              durationMs: null,
              error: null,
              id: typeof params.turnId === 'string' ? params.turnId : '',
              items: [],
              itemsView: 'full',
              startedAt: null,
              status: 'interrupted',
            },
          },
          threadId,
        );
        return {};
      }
      default:
        throw new Error('Method not found.');
    }
  }

  private startPollingTurn(threadId: string, turnId: string, baselineFingerprint: string): void {
    const previousState = this.pollStates.get(threadId);
    if (previousState?.timer) clearTimeout(previousState.timer);
    const state = {
      errors: 0,
      baselineFingerprint,
      missing: 0,
      paused: false,
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
      if (state.paused || this.pollStates.get(threadId) !== state) return;
      try {
        const threads = await this.api.listSessions();
        if (state.paused || this.pollStates.get(threadId) !== state) return;
        const thread = threads.find(candidate => candidate.id === threadId);
        state.missing = thread ? 0 : state.missing + 1;
        if (state.missing >= 3) {
          this.pollStates.delete(threadId);
          this.broadcast(
            'turn/completed',
            {
              threadId,
              turn: {
                completedAt: Math.floor(Date.now() / 1000),
                durationMs: null,
                error: { message: 'Thread is no longer available.' },
                id: turnId,
                items: [],
                itemsView: 'full',
                startedAt: null,
                status: 'failed',
              },
            },
            threadId,
          );
          return;
        }
        if (!thread) {
          state.timer = setTimeout(() => void poll(), POLL_INTERVAL_MS);
          return;
        }
        const runtimeStatus = await this.api.getThreadRuntimeStatus(threadId, {
          forceRefresh: thread.status === 'error' && !state.runtimeConfirmedActive,
        });
        if (state.paused || this.pollStates.get(threadId) !== state) return;
        const runtimeRunning = runtimeStatus.known
          ? runtimeStatus.running
          : thread.status === 'running';
        if (runtimeRunning) state.runtimeConfirmedActive = true;
        const forceFullSnapshot =
          !runtimeRunning || state.polls % FULL_SNAPSHOT_POLL_INTERVAL === 0;
        state.polls += 1;
        const messages = await this.api.getMessages(threadId, { forceFullSnapshot });
        if (state.paused || this.pollStates.get(threadId) !== state) return;
        state.errors = 0;
        const fingerprint = messageFingerprint(messages);
        const historyChanged = fingerprint !== previousMessages;
        if (historyChanged) {
          previousMessages = fingerprint;
          state.terminal = 0;
          this.broadcast(
            'thread/updated',
            { thread: toAppServerThread(thread, messages), threadId },
            threadId,
          );
        }
        if (runtimeRunning) {
          state.terminal = 0;
        } else {
          state.terminal += 1;
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
          state.terminal >= TERMINAL_SETTLE_POLLS
            ? this.api.consumeTurnError(threadId, turnId)
            : undefined;
        const terminalHistoryReady = Boolean(recordedError) || hasFinalAssistant;
        if (
          state.terminal >= TERMINAL_SETTLE_POLLS &&
          (terminalHistoryReady || state.terminal >= TERMINAL_MAX_POLLS)
        ) {
          const failed =
            Boolean(recordedError) || (thread.status === 'error' && !hasFinalAssistant);
          this.pollStates.delete(threadId);
          this.broadcast(
            'turn/completed',
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
                status: failed ? 'failed' : 'completed',
              },
            },
            threadId,
          );
          return;
        }
      } catch {
        state.errors += 1;
        if (state.errors >= 120 && this.pollStates.get(threadId) === state) {
          this.pollStates.delete(threadId);
          this.broadcast(
            'turn/completed',
            {
              threadId,
              turn: {
                completedAt: Math.floor(Date.now() / 1000),
                durationMs: null,
                error: { message: 'Unable to refresh the thread.' },
                id: turnId,
                items: [],
                itemsView: 'full',
                startedAt: null,
                status: 'failed',
              },
            },
            threadId,
          );
          return;
        }
      }
      if (!state.paused && this.pollStates.get(threadId) === state) {
        state.timer = setTimeout(() => void poll(), POLL_INTERVAL_MS);
      }
    };
    state.poll = () => void poll();
    state.poll();
  }
}
