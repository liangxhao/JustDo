import { randomUUID } from 'node:crypto';

import {
  type AppServerBinding,
  type AppServerConnectionContext,
  AppServerErrorCode as ErrorCode,
  AppServerErrorStyle,
  AppServerMethod,
  AppServerNotificationMethod,
  type AppServerNotify,
  type AppServerOperation,
  type AppServerParams,
  type AppServerRequestMethod,
  AppServerRpcError,
  isAppServerRecord,
} from './appServerProtocol';
import { validateCodexInitialize } from './appServerValidation';

const MAX_SERVER_REQUESTS = 64;
const DEFAULT_SERVER_REQUEST_TIMEOUT_MS = 60_000;
const MAX_SERVER_REQUEST_TIMEOUT_MS = 2_147_483_647;
const STANDARD_METHODS = new Set<string>(Object.values(AppServerMethod));

interface PendingServerRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  threadId?: string;
  timer?: ReturnType<typeof setTimeout>;
  signal?: AbortSignal;
  abort?: () => void;
}

/** A single protocol state machine for authenticated WebSocket and stdio peers. */
export class AppServerConnection {
  private initializeRequested = false;
  private initialized = false;
  private closed = false;
  private disconnecting: Promise<void> | undefined;
  private experimentalApi = false;
  private readonly pendingServerRequests = new Map<string, PendingServerRequest>();
  private readonly optOut = new Set<string>();
  private readonly binding: AppServerBinding;

  constructor(
    createBinding: (context: AppServerConnectionContext) => AppServerBinding,
    private readonly send: (message: unknown) => void,
  ) {
    this.binding = createBinding({
      notify: this.notify,
      isClosed: () => this.closed,
      fail: reason => {
        // Revoke new work before cleanup yields, and observe detached cleanup rejection.
        void this.close(reason).catch(() => {});
      },
      request: (method, params, options) => this.request(method, params, options),
      isExperimentalApiEnabled: () => !this.closed && this.initialized && this.experimentalApi,
    });
  }

  readonly notify: AppServerNotify = (method, params) => {
    if (!this.closed && !this.optOut.has(method)) this.send({ method, params });
  };

  async receiveRaw(raw: string): Promise<void> {
    if (this.closed) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.respondError(null, ErrorCode.Parse, 'Parse error.');
      return;
    }
    await this.receive(parsed);
  }

  async receive(raw: unknown): Promise<void> {
    if (this.closed) return;
    if (!isAppServerRecord(raw)) {
      this.respondError(null, ErrorCode.InvalidRequest, 'Invalid request.');
      return;
    }
    const policy = this.binding.initialization;
    const codex = policy.errorStyle === AppServerErrorStyle.Codex;
    if (codex && raw.method === undefined && ('result' in raw || 'error' in raw)) {
      this.receiveResponse(raw);
      return;
    }
    const id = typeof raw.id === 'string' || typeof raw.id === 'number' ? raw.id : undefined;
    const { method } = raw;
    if (
      (raw.id !== undefined && id === undefined) ||
      (typeof id === 'number' && !(codex ? Number.isSafeInteger(id) : Number.isFinite(id))) ||
      typeof method !== 'string'
    ) {
      this.respondError(null, ErrorCode.InvalidRequest, 'Invalid request.');
      return;
    }
    const initializedNotification = id === undefined && method === AppServerMethod.Initialized;
    if (
      codex && raw.params !== undefined && !isAppServerRecord(raw.params) &&
      !(initializedNotification && raw.params === null)
    ) {
      this.respondError(id ?? null, ErrorCode.InvalidRequest, 'Request params must be an object.');
      return;
    }
    if (initializedNotification) {
      if (this.initializeRequested) this.initialized = true;
      return;
    }
    // Extensions always require RPC admission, independently of legacy core notification policy.
    if (id === undefined && (!policy.executeNotifications || !STANDARD_METHODS.has(method))) return;
    const params = isAppServerRecord(raw.params) ? raw.params : {};
    if (method === AppServerMethod.Initialize) {
      if (this.initializeRequested) {
        if (id !== undefined) this.respondError(id, ErrorCode.InvalidRequest, 'Already initialized.');
        return;
      }
      if (codex) {
        try {
          validateCodexInitialize(params);
        } catch (error) {
          if (id !== undefined && error instanceof AppServerRpcError)
            this.respondError(id, error.code, error.message);
          return;
        }
      }
      this.initializeRequested = true;
      this.initialized = !policy.requireInitializedNotification;
      const capabilities = isAppServerRecord(params.capabilities) ? params.capabilities : {};
      this.experimentalApi = codex && capabilities.experimentalApi === true;
      if (Array.isArray(capabilities.optOutNotificationMethods)) {
        for (const value of capabilities.optOutNotificationMethods)
          if (typeof value === 'string') this.optOut.add(value);
      }
      if (id !== undefined) this.respond({ id, result: policy.result });
      return;
    }
    if (!this.initialized) {
      if (id !== undefined)
        this.respondError(
          id,
          codex ? ErrorCode.InvalidRequest : ErrorCode.NotInitialized,
          codex ? 'Not initialized' : 'Connection is not initialized.',
        );
      return;
    }
    const operation = this.operation(method);
    if (!operation) {
      if (id !== undefined) this.respondError(id, ErrorCode.MethodNotFound, 'Method not found.');
      return;
    }
    let result: unknown;
    try {
      // Await only operation admission, never the lifetime of a native run.
      // Interrupts and subsequent requests remain independently processable.
      result = await operation(params);
    } catch (error) {
      if (id !== undefined) {
        const requestSent = error instanceof Error
          ? (error as Error & { requestSent?: boolean }).requestSent
          : undefined;
        const publicData = error instanceof AppServerRpcError ? error.data : undefined;
        this.respondError(
          id,
          codex
            ? error instanceof AppServerRpcError ? error.code : ErrorCode.Console
            : ErrorCode.Internal,
          error instanceof Error ? error.message : 'Internal error.',
          method === AppServerMethod.TurnStart && typeof requestSent === 'boolean'
            ? { ...publicData, requestSent }
            : publicData,
        );
      }
      return;
    }
    if (id !== undefined) this.respond({ id, result });
  }

  close(reason?: Error): Promise<void> {
    if (this.disconnecting) return this.disconnecting;
    this.closed = true;
    for (const id of this.pendingServerRequests.keys())
      this.finishServerRequest(id, undefined, reason ?? new Error('App-server connection closed.'));
    // The binding owns disconnect semantics and its exact active or unknown runs.
    // The shared protocol never infers an execution outcome.
    this.disconnecting = Promise.resolve().then(() => this.binding.onDisconnect(reason));
    return this.disconnecting;
  }

  private request(
    method: AppServerRequestMethod,
    params: AppServerParams,
    options: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<unknown> {
    if (this.closed || !this.initialized || this.binding.initialization.errorStyle !== AppServerErrorStyle.Codex)
      return Promise.reject(new Error('Client requests are unavailable on this connection.'));
    if (options.signal?.aborted) return Promise.reject(new Error('Client request cancelled.'));
    if (this.pendingServerRequests.size >= MAX_SERVER_REQUESTS)
      return Promise.reject(new Error('Too many unanswered client requests.'));
    const timeoutMs = options.timeoutMs ?? DEFAULT_SERVER_REQUEST_TIMEOUT_MS;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_SERVER_REQUEST_TIMEOUT_MS)
      return Promise.reject(new Error('Invalid client request timeout.'));
    const id = `server-request:${randomUUID()}`;
    return new Promise((resolve, reject) => {
      const pending: PendingServerRequest = {
        resolve,
        reject,
        ...(typeof params.threadId === 'string' ? { threadId: params.threadId } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
      };
      this.pendingServerRequests.set(id, pending);
      pending.timer = setTimeout(() => {
        this.finishServerRequest(id, undefined, new Error('Client request timed out.'));
      }, timeoutMs);
      if (options.signal) {
        pending.abort = () => this.finishServerRequest(id, undefined, new Error('Client request cancelled.'));
        options.signal.addEventListener('abort', pending.abort, { once: true });
        if (options.signal.aborted) {
          pending.abort();
          return;
        }
      }
      try {
        this.send({ id, method, params });
      } catch {
        // The owning binding classifies this output failure for native cleanup.
        void this.close(new Error('App-server request output failed.')).catch(() => {});
      }
    });
  }

  private receiveResponse(raw: Record<string, unknown>): void {
    const id = raw.id;
    if (typeof id !== 'string' || !this.pendingServerRequests.has(id)) return;
    const hasResult = Object.prototype.hasOwnProperty.call(raw, 'result');
    const hasError = Object.prototype.hasOwnProperty.call(raw, 'error');
    if (hasResult === hasError) {
      this.finishServerRequest(id, undefined, new Error('Invalid client response.'));
    } else if (hasError) {
      const error = raw.error;
      this.finishServerRequest(id, undefined,
        isAppServerRecord(error) && Number.isSafeInteger(error.code) && typeof error.message === 'string'
          ? new AppServerRpcError(error.code as number, error.message)
          : new Error('Invalid client response error.'));
    } else {
      this.finishServerRequest(id, raw.result);
    }
  }

  private finishServerRequest(id: string, value?: unknown, error?: Error): void {
    const pending = this.pendingServerRequests.get(id);
    if (!pending) return;
    this.pendingServerRequests.delete(id);
    if (pending.timer) clearTimeout(pending.timer);
    if (pending.abort) pending.signal?.removeEventListener('abort', pending.abort);
    if (!this.closed && pending.threadId !== undefined) {
      try {
        this.notify(AppServerNotificationMethod.ServerRequestResolved, { requestId: id, threadId: pending.threadId });
      } catch {
        void this.close(new Error('App-server request resolution output failed.')).catch(() => {});
      }
    }
    if (error) pending.reject(error);
    else pending.resolve(value);
  }

  private respond(message: unknown): void {
    if (!this.closed) this.send(message);
  }

  private respondError(
    id: string | number | null,
    code: number,
    message: string,
    data?: AppServerParams,
  ): void {
    const style = this.binding.initialization.errorStyle;
    const responseCode = style === AppServerErrorStyle.Console &&
        code !== ErrorCode.Parse && code !== ErrorCode.InvalidRequest
      ? ErrorCode.Console
      : code;
    this.respond({
      id,
      error: {
        code: responseCode,
        message,
        ...(data ? { data } : {}),
      },
    });
  }

  private operation(method: string): AppServerOperation | undefined {
    const { threads, turns, models, extensions } = this.binding;
    switch (method) {
      case AppServerMethod.ModelList: return models?.list;
      case AppServerMethod.ThreadList: return threads.list;
      case AppServerMethod.ThreadLoadedList: return threads.loadedList;
      case AppServerMethod.ThreadRead: return threads.read;
      case AppServerMethod.ThreadTurnsList: return threads.turnsList;
      case AppServerMethod.ThreadItemsList: return threads.itemsList;
      case AppServerMethod.ThreadStart: return threads.start;
      case AppServerMethod.ThreadResume: return threads.resume;
      case AppServerMethod.ThreadNameSet: return threads.setName;
      case AppServerMethod.ThreadUnsubscribe: return threads.unsubscribe;
      case AppServerMethod.TurnStart: return turns.start;
      case AppServerMethod.TurnInterrupt: return turns.interrupt;
      default: {
        if (STANDARD_METHODS.has(method) || !extensions || !Object.hasOwn(extensions, method)) return undefined;
        const operation = extensions[method];
        return typeof operation === 'function' ? operation : undefined;
      }
    }
  }
}
