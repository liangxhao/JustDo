import type { NormalizedAgentEvent } from '../../../shared/openclaw/agentEvent';
import type { GatewayClientLike } from '../../engine/gateway/types';
import { ExternalAgentStreamError } from './externalAgentTypes';

const MAX_PENDING_FRAMES = 1024;
const MAX_PENDING_BYTES = 8 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 5000;

interface Options {
  isCurrent: (sourceClient: GatewayClientLike) => boolean;
  verify: (
    sourceClient: GatewayClientLike,
    unstampedEvents: NormalizedAgentEvent[],
  ) => Promise<string>;
  deliver: (event: NormalizedAgentEvent) => void;
  fail: (error: ExternalAgentStreamError) => void;
  timeoutMs?: number;
}

interface PendingEvent {
  event: NormalizedAgentEvent;
  sourceClient: GatewayClientLike;
  bytes: number;
  retained: boolean;
}

interface FlushWaiter {
  resolve: () => void;
  reject: (error: ExternalAgentStreamError) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** Bounded display delivery only. Execution owns identity admission and terminal evidence. */
export class ExternalAgentProgress {
  private readonly timeoutMs: number;
  private readonly waiters = new Set<FlushWaiter>();
  private queue: PendingEvent[] = [];
  private activeBatch: PendingEvent[] = [];
  private pendingFrames = 0;
  private pendingBytes = 0;
  private scheduled = false;
  private running = false;
  private closed = false;
  private error?: ExternalAgentStreamError;
  private cancelProof?: () => void;

  constructor(private readonly options: Options) {
    const timeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.timeoutMs = Number.isFinite(timeout) && timeout > 0
      ? Math.max(1, Math.min(timeout, DEFAULT_TIMEOUT_MS))
      : DEFAULT_TIMEOUT_MS;
  }

  enqueue(event: NormalizedAgentEvent, sourceClient: GatewayClientLike): void {
    if (this.closed) return;
    try {
      // Freeze the observed wire data across the asynchronous identity read.
      const serialized = JSON.stringify(event);
      const bytes = Buffer.byteLength(serialized);
      if (
        this.pendingFrames >= MAX_PENDING_FRAMES ||
        this.pendingBytes + bytes > MAX_PENDING_BYTES
      ) {
        throw new ExternalAgentStreamError('Native progress exceeded the pending output limit.');
      }
      const snapshot = JSON.parse(serialized) as NormalizedAgentEvent;
      this.queue.push({ event: snapshot, sourceClient, bytes, retained: true });
      this.pendingFrames += 1;
      this.pendingBytes += bytes;
      this.schedule();
    } catch (error) {
      this.stop(this.streamError(error, 'Native progress could not be queued.'));
    }
  }

  flush(): Promise<void> {
    if (this.error) return Promise.reject(this.error);
    if (this.closed || this.pendingFrames === 0) return Promise.resolve();
    this.schedule();
    return new Promise<void>((resolve, reject) => {
      const waiter: FlushWaiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          this.stop(new ExternalAgentStreamError('Native progress output drain timed out.'));
        }, this.timeoutMs),
      };
      this.waiters.add(waiter);
    });
  }

  close(): void {
    this.stop();
  }

  private schedule(): void {
    if (this.closed || this.running || this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      if (this.closed || this.running) return;
      this.running = true;
      void this.drain().then(
        () => this.finishDrain(),
        error => {
          this.stop(this.streamError(error, 'Native progress could not be delivered.'));
          this.finishDrain();
        },
      );
    });
  }

  private finishDrain(): void {
    this.running = false;
    if (!this.closed && this.pendingFrames === 0) this.finishWaiters();
    if (this.queue.length) this.schedule();
  }

  private assertCurrent(sourceClient: GatewayClientLike): void {
    if (!this.options.isCurrent(sourceClient)) {
      throw new ExternalAgentStreamError('The native progress connection changed.');
    }
  }

  private async drain(): Promise<void> {
    while (!this.closed && this.queue.length) {
      const batch = this.queue.splice(0);
      this.activeBatch = batch;
      try {
        const sourceClient = batch[0].sourceClient;
        if (batch.some(item => item.sourceClient !== sourceClient)) {
          throw new ExternalAgentStreamError('Native progress crossed connection owners.');
        }
        this.assertCurrent(sourceClient);
        const unstamped = batch.filter(item => !item.event.sessionId).map(item => item.event);
        const sessionId = unstamped.length ? await this.verify(sourceClient, unstamped) : undefined;
        if (this.closed) return;
        this.assertCurrent(sourceClient);
        if (unstamped.length && (typeof sessionId !== 'string' || !sessionId.trim())) {
          throw new ExternalAgentStreamError('Native progress identity could not be verified.');
        }
        for (const item of batch) {
          if (this.closed) return;
          this.assertCurrent(item.sourceClient);
          if (this.closed) return;
          this.options.deliver(item.event.sessionId
            ? item.event
            : { ...item.event, sessionId: sessionId! });
          this.release(item);
        }
      } finally {
        batch.forEach(item => this.release(item));
        this.activeBatch = [];
      }
    }
  }

  private verify(
    sourceClient: GatewayClientLike,
    unstampedEvents: NormalizedAgentEvent[],
  ): Promise<string | undefined> {
    return new Promise((resolve, reject) => {
      let finished = false;
      const finish = (result?: string, error?: unknown) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        if (this.cancelProof === cancel) this.cancelProof = undefined;
        if (error !== undefined) reject(error);
        else resolve(result);
      };
      const cancel = () => finish();
      const timer = setTimeout(() => finish(undefined, new ExternalAgentStreamError(
        'Native progress identity verification timed out.',
      )), this.timeoutMs);
      this.cancelProof = cancel;
      // Both continuations consume late settlement after close or timeout.
      Promise.resolve().then(() => {
        if (this.closed) return undefined;
        this.assertCurrent(sourceClient);
        if (this.closed) return undefined;
        return this.options.verify(sourceClient, unstampedEvents);
      }).then(
        result => finish(result),
        error => finish(undefined, this.streamError(error, 'Native progress identity could not be verified.')),
      );
    });
  }

  private release(item: PendingEvent): void {
    if (!item.retained) return;
    item.retained = false;
    this.pendingFrames -= 1;
    this.pendingBytes -= item.bytes;
  }

  private streamError(error: unknown, fallback: string): ExternalAgentStreamError {
    return error instanceof ExternalAgentStreamError ? error : new ExternalAgentStreamError(fallback);
  }

  private finishWaiters(): void {
    for (const waiter of this.waiters) {
      clearTimeout(waiter.timer);
      if (this.error) waiter.reject(this.error);
      else waiter.resolve();
    }
    this.waiters.clear();
  }

  private stop(error?: ExternalAgentStreamError): void {
    if (this.closed) return;
    this.closed = true;
    this.error = error;
    this.queue.forEach(item => this.release(item));
    this.activeBatch.forEach(item => this.release(item));
    this.queue = [];
    this.activeBatch = [];
    this.cancelProof?.();
    this.finishWaiters();
    if (error) {
      try { this.options.fail(error); } catch { /* Output failure reporting cannot reopen delivery. */ }
    }
  }
}
