import {
  type AppServerBinding,
  type AppServerConnectionContext,
  AppServerErrorStyle,
  AppServerMethod,
  type AppServerNotify,
  type AppServerOperation,
  type AppServerParams,
  isAppServerRecord,
} from './appServerProtocol';

const ErrorCode = {
  Parse: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  NotInitialized: -32002,
  Internal: -32603,
  Console: -32000,
} as const;

/** A single protocol state machine for authenticated WebSocket and stdio peers. */
export class AppServerConnection {
  private initializeRequested = false;
  private initialized = false;
  private closed = false;
  private disconnecting: Promise<void> | undefined;
  private readonly optOut = new Set<string>();
  private readonly binding: AppServerBinding;

  constructor(
    createBinding: (context: AppServerConnectionContext) => AppServerBinding,
    private readonly send: (message: unknown) => void,
  ) {
    this.binding = createBinding({ notify: this.notify, isClosed: () => this.closed });
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
    const id = typeof raw.id === 'string' || typeof raw.id === 'number' ? raw.id : undefined;
    const { method } = raw;
    if (
      (raw.id !== undefined && id === undefined) ||
      (typeof id === 'number' && !Number.isFinite(id)) ||
      typeof method !== 'string'
    ) {
      this.respondError(null, ErrorCode.InvalidRequest, 'Invalid request.');
      return;
    }
    const policy = this.binding.initialization;
    if (id === undefined && method === AppServerMethod.Initialized) {
      if (this.initializeRequested) this.initialized = true;
      return;
    }
    // Console notifications have never dispatched work. In particular, a
    // notification cannot open a thread or start a task without a response.
    if (id === undefined && !policy.executeNotifications) return;
    const params = isAppServerRecord(raw.params) ? raw.params : {};
    if (method === AppServerMethod.Initialize) {
      if (this.initializeRequested) {
        if (id !== undefined) this.respondError(id, ErrorCode.InvalidRequest, 'Already initialized.');
        return;
      }
      this.initializeRequested = true;
      this.initialized = !policy.requireInitializedNotification;
      const capabilities = isAppServerRecord(params.capabilities) ? params.capabilities : {};
      if (Array.isArray(capabilities.optOutNotificationMethods)) {
        for (const value of capabilities.optOutNotificationMethods)
          if (typeof value === 'string') this.optOut.add(value);
      }
      if (id !== undefined) this.respond({ id, result: policy.result });
      return;
    }
    if (!this.initialized) {
      if (id !== undefined)
        this.respondError(id, ErrorCode.NotInitialized, 'Connection is not initialized.');
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
        this.respondError(
          id,
          ErrorCode.Internal,
          error instanceof Error ? error.message : 'Internal error.',
          method === AppServerMethod.TurnStart && policy.errorStyle === AppServerErrorStyle.Standard
            ? { requestSent: requestSent !== false }
            : undefined,
        );
      }
      return;
    }
    if (id !== undefined) this.respond({ id, result });
  }

  close(reason?: Error): Promise<void> {
    if (this.disconnecting) return this.disconnecting;
    this.closed = true;
    // The binding owns disconnect semantics: Chrome detaches; console cancels
    // its exact active or unknown run. A shared protocol never infers outcome.
    this.disconnecting = Promise.resolve().then(() => this.binding.onDisconnect(reason));
    return this.disconnecting;
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
    const consoleError = this.binding.initialization.errorStyle === AppServerErrorStyle.Console;
    this.respond({
      id,
      error: {
        code: consoleError && code !== ErrorCode.Parse && code !== ErrorCode.InvalidRequest
          ? ErrorCode.Console
          : code,
        message,
        ...(data ? { data } : {}),
      },
    });
  }

  private operation(method: string): AppServerOperation | undefined {
    const { threads, turns, models, composer, images, browserPairing } = this.binding;
    switch (method) {
      case AppServerMethod.ModelList: return models?.list;
      case AppServerMethod.ThreadList: return threads.list;
      case AppServerMethod.ThreadRead: return threads.read;
      case AppServerMethod.ThreadStart: return threads.start;
      case AppServerMethod.ThreadResume: return threads.resume;
      case AppServerMethod.ThreadNameSet: return threads.setName;
      case AppServerMethod.ThreadUnsubscribe: return threads.unsubscribe;
      case AppServerMethod.ThreadImage: return images?.read;
      case AppServerMethod.ComposerOptions: return composer?.options;
      case AppServerMethod.BrowserPair: return browserPairing?.create;
      case AppServerMethod.TurnStart: return turns.start;
      case AppServerMethod.TurnInterrupt: return turns.interrupt;
      default: return undefined;
    }
  }
}
