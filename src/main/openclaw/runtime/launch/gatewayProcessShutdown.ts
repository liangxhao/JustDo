import type { ChildProcess } from 'node:child_process';

import type { UtilityProcess } from 'electron';

import { SHUTDOWN_BUDGET_MS } from '../../../../shared/app/shutdownPolicy';
import { OPENCLAW_GATEWAY_SHUTDOWN_MESSAGE } from './openclawLauncher';

type GatewayProcess = ChildProcess | UtilityProcess;
type StopRecord = {
  exited: boolean;
  closed: boolean;
  code: number | null;
  signal: string | null;
  processError?: Error;
  promise?: Promise<void>;
  finish?: () => void;
};

/** Retains one stop deadline and its failure even after the process handle retires. */
export class GatewayProcessShutdown {
  private readonly records = new WeakMap<GatewayProcess, StopRecord>();
  private readonly active = new Set<Promise<void>>();
  private failureValue: Error | null = null;

  constructor(private readonly onFailure: (failure: Error) => void) {}

  get failure(): Error | null { return this.failureValue; }

  async waitForStops(): Promise<void> {
    await Promise.allSettled(this.active);
    if (this.failureValue) throw this.failureValue;
  }

  observe(child: GatewayProcess): void { this.recordFor(child); }

  private recordFor(child: GatewayProcess): StopRecord {
    const previous = this.records.get(child);
    if (previous) return previous;
    const isChildProcess = 'exitCode' in child;
    const record: StopRecord = {
      exited: isChildProcess && (child.exitCode != null || child.signalCode != null),
      closed: false,
      code: isChildProcess ? child.exitCode ?? null : null,
      signal: isChildProcess ? child.signalCode ?? null : null,
    };
    this.records.set(child, record);
    const onExit = (code: number | null, signal?: string | null): void => {
      record.exited = true;
      record.code = code;
      record.signal = signal ?? null;
      if (!isChildProcess) {
        record.closed = true;
        child.removeListener('error', onError);
        record.finish?.();
      }
    };
    const onError = (error: unknown): void => {
      record.processError = error instanceof Error ? error : new Error('Gateway process failed.');
    };
    const onClose = (code: number | null, signal?: string | null): void => {
      record.exited = true;
      record.closed = true;
      record.code = code;
      record.signal = signal ?? null;
      child.removeListener('exit', onExit);
      child.removeListener('error', onError);
      record.finish?.();
    };
    child.once('exit', onExit);
    child.once('error', onError);
    if (isChildProcess) child.once('close', onClose);
    return record;
  }

  stop(child: GatewayProcess): Promise<void> {
    const record = this.recordFor(child);
    if (record.promise) return record.promise;
    let resolve!: () => void;
    let reject!: (failure: Error) => void;
    record.promise = new Promise<void>((accept, decline) => { resolve = accept; reject = decline; });
    this.active.add(record.promise);
    let settled = false;
    let failure: Error | undefined;
    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    let observationTimer: ReturnType<typeof setTimeout> | undefined;
    const fail = (error: Error): void => {
      failure ??= error;
      if (!this.failureValue) {
        this.failureValue = failure;
        try { this.onFailure(failure); }
        catch (projectionError) {
          // Status observers do not own retirement or its original deadline.
          console.error('[GatewayShutdown] Failed to publish retirement failure:', projectionError);
        }
      }
    };
    const finish = (): void => {
      if (!record.closed) return;
      this.active.delete(record.promise!);
      clearTimeout(graceTimer);
      clearTimeout(observationTimer);
      if (settled) return;
      settled = true;
      if (record.processError || record.code !== 0 || record.signal) {
        fail(record.processError ?? new Error(
          `Gateway did not close cleanly (code=${record.code ?? 'null'}, signal=${record.signal ?? 'null'}). Restart the application.`,
        ));
      }
      if (failure) reject(failure);
      else resolve();
    };
    record.finish = finish;
    if (record.closed) {
      finish();
      return record.promise;
    }
    graceTimer = setTimeout(() => {
      fail(new Error('Gateway shutdown exceeded its native grace period. Restart the application.'));
      // An exited child can still own open stdio. Never signal its retired PID.
      if (!record.exited) {
        try {
          if ('exitCode' in child) child.kill('SIGKILL');
          else child.kill();
        }
        catch { /* The close receipt remains mandatory even if signalling fails. */ }
      }
      if (settled) return;
      observationTimer = setTimeout(() => {
        if (settled) return;
        settled = true;
        fail(new Error('Gateway process retirement remains unconfirmed. Restart the application.'));
        reject(failure!);
        // Keep record.finish and native listeners: late close reclaims custody,
        // but cannot change this failed result or the permanent admission fence.
      }, SHUTDOWN_BUDGET_MS.forceExitObservation);
    }, SHUTDOWN_BUDGET_MS.gatewayGrace);
    if (!record.exited && 'send' in child && child.connected) {
      try {
        child.send(OPENCLAW_GATEWAY_SHUTDOWN_MESSAGE, () => {
          // A closing channel may already have invoked the preload's disconnect
          // handler. Neither send failure nor acknowledgement is an exit receipt.
        });
      } catch { /* Retain the same native grace and require actual close. */ }
    }
    return record.promise;
  }
}
