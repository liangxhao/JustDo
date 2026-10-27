import {
  boardReferenceIsRealtime,
  isNativeBoardWidgetReference,
  nativeBoardReferenceOrder,
  type NativeBoardWidgetReference,
} from '../../pipeline/native-board';
import type { NativeWidgetContext } from '../native-widget/host';
import {
  type BoardRead,
  boardScope,
  readBoardHtml,
  readCurrentBoard,
  record,
  sameBoardIdentity,
  UnsupportedBoardWidgetError,
} from './loader';

export type BoardWidgetStatus =
  'idle' | 'loading' | 'unsupported' | 'missing' | 'failed' | 'stopped' | 'running';
export type PreparedBoardView = { html: string; url: string };
export type BoardWidgetState = {
  status: BoardWidgetStatus;
};
const started = new WeakMap<object, Set<string>>();
const executions = new WeakMap<object, Set<string>>();

function failureStatus(error: unknown): BoardWidgetStatus {
  return error instanceof UnsupportedBoardWidgetError ? 'unsupported' : 'failed';
}

function withinRound<T>(work: Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Native check timed out')), 15_000);
    work.then(
      value => {
        clearTimeout(timer);
        resolve(value);
      },
      error => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/** Runtime memory only; an anchor remount cannot replay a previously admitted result. */
function claimLive(reference: NativeBoardWidgetReference, context: NativeWidgetContext): boolean {
  if (
    !context.sessionId ||
    !boardReferenceIsRealtime(reference, { ...context, sessionId: context.sessionId })
  )
    return false;
  const owner = context.boardExecutionOwner ?? context.client;
  let claims = started.get(owner);
  if (!claims) {
    claims = new Set();
    started.set(owner, claims);
  }
  const key = JSON.stringify([
    context.generation,
    context.sessionKey,
    context.sessionId,
    reference.name,
    reference.toolCallId,
  ]);
  if (claims.has(key)) return false;
  claims.add(key);
  return true;
}

/** This controller never exports the board frame URL or ticket to its generated document. */
export class NativeBoardWidgetController {
  state: BoardWidgetState = { status: 'idle' };
  private active = true;
  private operation = 0;
  private read?: BoardRead;
  private abort?: AbortController;
  private renewal?: ReturnType<typeof setInterval>;
  private busyRenewal = false;
  private unsubscribe?: () => void;
  private latestOrder = 0;
  private incoming?: NativeBoardWidgetReference;
  private accepting = false;

  constructor(
    readonly reference: NativeBoardWidgetReference,
    private readonly context: NativeWidgetContext,
    private readonly hostOrigin: string,
    private readonly isCurrent: () => boolean,
    private readonly publish: (state: BoardWidgetState, view?: PreparedBoardView) => void,
    private readonly destroyGuest: () => void,
  ) {
    if (!isNativeBoardWidgetReference(reference)) throw new Error('Unadmitted native board');
    this.latestOrder = nativeBoardReferenceOrder(reference);
    this.unsubscribe = context.client.subscribeEvents?.(event => {
      if (event.event !== 'board.changed' || !this.current()) return;
      const payload = record(event.payload);
      // Native board.changed carries the stored key, whereas snapshots project the observer scope.
      if (
        !payload ||
        (payload.sessionKey !== context.sessionKey && payload.sessionKey !== boardScope(context)) ||
        (payload.widget !== undefined && payload.widget !== reference.name)
      )
        return;
      void this.boardChanged(payload.widget === undefined);
    });
    void this.inspect(claimLive(reference, context));
  }

  private current(): boolean {
    return (
      this.active &&
      this.isCurrent() &&
      this.context.isCurrent() &&
      this.context.client.generation === this.context.generation
    );
  }
  private async boardChanged(wholeBoard: boolean): Promise<void> {
    const operation = this.operation;
    if (
      wholeBoard &&
      this.read &&
      (this.state.status === 'running' || (this.state.status === 'loading' && this.abort))
    ) {
      try {
        const read = await this.check();
        if (!this.current() || operation !== this.operation) return;
        if (sameBoardIdentity(this.read, read)) return;
      } catch {
        if (!this.current() || operation !== this.operation) return;
      }
    }
    this.stop(false);
    await this.inspect(false);
  }
  private update(status: BoardWidgetStatus, view?: PreparedBoardView): void {
    if (!this.active) return;
    this.state = { status };
    this.publish(this.state, view);
    if (status !== 'loading' && this.incoming) queueMicrotask(() => void this.acceptIncoming());
  }

  receiveReference(reference: NativeBoardWidgetReference): boolean {
    if (
      !this.current() ||
      reference.name !== this.reference.name ||
      !this.context.sessionId ||
      !boardReferenceIsRealtime(reference, {
        ...this.context,
        sessionId: this.context.sessionId,
      }) ||
      nativeBoardReferenceOrder(reference) <= this.latestOrder
    )
      return false;
    this.latestOrder = nativeBoardReferenceOrder(reference);
    this.incoming = reference;
    void this.acceptIncoming();
    return true;
  }

  private async acceptIncoming(): Promise<void> {
    if (this.accepting || !this.incoming || this.state.status === 'loading' || !this.current())
      return;
    const reference = this.incoming;
    this.incoming = undefined;
    if (!claimLive(reference, this.context)) return;
    this.accepting = true;
    const operation = this.operation;
    try {
      const read = await this.check();
      if (!this.current() || operation !== this.operation) return;
      if (this.read && sameBoardIdentity(this.read, read) && this.state.status === 'running')
        return;
      this.stop();
      this.read = read;
      this.update(read.widget ? 'idle' : 'missing');
      if (read.widget) await this.start(false);
    } catch (error) {
      if (this.current() && operation === this.operation) {
        this.stop();
        this.update(failureStatus(error));
      }
    } finally {
      this.accepting = false;
      if (this.incoming) void this.acceptIncoming();
    }
  }
  private async check(): Promise<BoardRead> {
    return withinRound(
      readCurrentBoard(
        this.context,
        this.reference.name,
        this.hostOrigin,
        () => this.current(),
        this.read?.lifecycleRevision,
      ),
    );
  }
  private async inspect(auto: boolean): Promise<void> {
    const operation = ++this.operation;
    this.update('loading');
    const timer = setTimeout(() => {
      if (this.operation === operation) {
        this.operation++;
        this.update('failed');
      }
    }, 15_000);
    try {
      const read = await this.check();
      if (!this.current() || operation !== this.operation) return;
      this.read = read;
      this.update(read.widget ? 'idle' : 'missing');
      if (auto && read.widget) void this.start(false);
    } catch (error) {
      if (this.current() && operation === this.operation) this.update(failureStatus(error));
    } finally {
      clearTimeout(timer);
    }
  }

  async start(manual = true): Promise<void> {
    if (
      !this.current() ||
      this.state.status === 'loading' ||
      this.state.status === 'running' ||
      this.state.status === 'unsupported' ||
      this.state.status === 'missing'
    )
      return;
    const operation = ++this.operation;
    if (manual && (this.state.status === 'stopped' || this.state.status === 'failed'))
      this.read = undefined;
    this.release();
    this.update('loading');
    this.abort = new AbortController();
    const abort = this.abort;
    const timer = setTimeout(() => {
      abort.abort();
      if (operation === this.operation) {
        this.operation++;
        this.release();
        this.update('failed');
      }
    }, 30_000);
    try {
      const roundStarted = performance.now();
      let read = await this.check();
      if (!this.current() || operation !== this.operation) return;
      this.read = read;
      const widget = read.widget;
      if (!widget) {
        this.update('missing');
        return;
      }
      if (performance.now() - roundStarted > 15_000) throw new Error('Native check timed out');
      if (!widget.frameUrl || !widget.sandboxUrl || !widget.viewGeneration)
        throw new Error('Native document unavailable');
      const owner = this.context.boardExecutionOwner ?? this.context.client;
      let seen = executions.get(owner);
      if (!seen) {
        seen = new Set();
        executions.set(owner, seen);
      }
      const execution = JSON.stringify([
        this.context.generation,
        this.context.sessionKey,
        this.context.sessionId,
        read.lifecycleRevision,
        widget.name,
        widget.instanceId,
        widget.revision,
        widget.viewGeneration,
        widget.grantState,
      ]);
      if (!manual && seen.has(execution)) {
        this.update('idle');
        return;
      }
      seen.add(execution);
      const fetchHtml = async () => readBoardHtml(read.widget!.frameUrl!, abort.signal);
      let html: string;
      try {
        html = await fetchHtml();
      } catch (error) {
        if ((error as { status?: number }).status !== 401 || abort.signal.aborted) throw error;
        const refreshed = await this.check();
        if (!sameBoardIdentity(read, refreshed)) throw new Error('Native document changed');
        read = refreshed;
        html = await fetchHtml();
      }
      if (!this.current() || operation !== this.operation || abort.signal.aborted) return;
      this.read = read;
      this.update('running', { html, url: read.widget!.sandboxUrl! });
      // Loading HTML must not postpone the next native identity check.
      this.renewal = setTimeout(
        () => {
          if (!this.current() || operation !== this.operation) return;
          void this.renew();
          this.renewal = setInterval(() => void this.renew(), 30_000);
        },
        Math.max(0, 30_000 - (performance.now() - roundStarted)),
      );
    } catch (error) {
      if (this.current() && operation === this.operation) {
        this.release();
        this.update(failureStatus(error));
      }
    } finally {
      clearTimeout(timer);
    }
  }

  private async renew(): Promise<void> {
    if (!this.current()) {
      this.stop();
      return;
    }
    if (!this.read || this.state.status !== 'running' || this.busyRenewal) return;
    this.busyRenewal = true;
    const operation = this.operation;
    const startedAt = performance.now();
    try {
      const read = await this.check();
      if (!this.current() || operation !== this.operation) return;
      if (performance.now() - startedAt > 15_000 || !sameBoardIdentity(this.read, read)) {
        this.stop();
        return;
      }
    } catch (error) {
      if (operation === this.operation) {
        this.stop();
        if (error instanceof UnsupportedBoardWidgetError) this.update('unsupported');
      }
    } finally {
      this.busyRenewal = false;
    }
  }

  stop(cancelIncoming = true): void {
    if (cancelIncoming) this.incoming = undefined;
    ++this.operation;
    this.release();
    this.update('stopped');
  }
  private release(): void {
    this.abort?.abort();
    this.abort = undefined;
    clearInterval(this.renewal);
    this.renewal = undefined;
    this.destroyGuest();
  }
  dispose(): void {
    if (!this.active) return;
    this.active = false;
    ++this.operation;
    this.incoming = undefined;
    this.release();
    this.unsubscribe?.();
  }
}
