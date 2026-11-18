import { redactLogText } from '@shared/diagnostics/redaction';
import type { ExtensionRemovalConfirmedEvent } from '@shared/plugins/extensions';
import { PluginKind } from '@shared/plugins/marketplace';
import {
  PluginOperationAction,
  type PluginOperationContext,
  type PluginOperationProgress,
  PluginOperationStage,
  toPluginOperationStage,
} from '@shared/plugins/pluginOperation';

export interface ActivePluginOperation extends PluginOperationProgress {
  label: string;
  startedAt: number;
  targetId?: string;
}

type ProgressBridge = {
  extensions?: {
    onRemovalConfirmed?: (callback: (event: ExtensionRemovalConfirmedEvent) => void) => () => void;
  };
  plugins?: {
    onOperationProgress: (callback: (progress: PluginOperationProgress) => void) => () => void;
  };
};

export type PluginOperationOptions = {
  kind: PluginKind;
  action: PluginOperationAction;
  label: string;
  targetId?: string;
};

export const PluginOperationFailureState = {
  FAILED: 'failed',
  COMMITTED: 'committed',
  UNCONFIRMED: 'unconfirmed',
  REFRESH_FAILED: 'refresh_failed',
} as const;

export type PluginOperationFailureItem = {
  label: string;
  message: string;
  type?: 'success' | 'error';
  failedStage?: PluginOperationStage;
  installationCommitted?: true;
  installSourceInUse?: true;
  operationUnconfirmed?: true;
  mutationCompleted?: true;
  runtimeRecoveryPending?: true;
};

export type PluginOperationFailureInput = {
  message: string;
  details?: string;
  /** Measured by a batch coordinator when it owns several individual requests. */
  elapsedMs?: number;
  failedStage?: PluginOperationStage;
  installationCommitted?: true;
  installSourceInUse?: true;
  operationUnconfirmed?: true;
  mutationCompleted?: true;
  runtimeRecoveryPending?: true;
  /** A successful mutation was followed only by an unavailable inventory read. */
  inventoryRefreshOnly?: true;
  state?: (typeof PluginOperationFailureState)[keyof typeof PluginOperationFailureState];
  items?: PluginOperationFailureItem[];
};

export type PluginOperationFailure = PluginOperationOptions & {
  requestId: string;
  message: string;
  details?: string;
  failedStage?: PluginOperationStage;
  elapsedMs: number;
  state: (typeof PluginOperationFailureState)[keyof typeof PluginOperationFailureState];
  installationCommitted?: true;
  installSourceInUse?: true;
  operationUnconfirmed?: true;
  mutationCompleted?: true;
  runtimeRecoveryPending?: true;
  inventoryRefreshOnly?: true;
  /** Presentation-only confirmation of current engine admission; original receipt flags stay intact. */
  runtimeRecovered?: true;
  /** Later authoritative confirmation; the original unknown receipt remains intact. */
  removalConfirmed?: true;
  items?: PluginOperationFailureInput['items'];
};

export const isPluginOperationRecoveryPending = (
  operation: Pick<
    PluginOperationFailure,
    | 'state'
    | 'mutationCompleted'
    | 'runtimeRecoveryPending'
    | 'operationUnconfirmed'
    | 'installSourceInUse'
    | 'items'
  >,
) =>
  operation.mutationCompleted === true &&
  operation.runtimeRecoveryPending === true &&
  (operation.state === PluginOperationFailureState.REFRESH_FAILED ||
    operation.state === PluginOperationFailureState.COMMITTED) &&
  !operation.operationUnconfirmed &&
  !operation.installSourceInUse &&
  !(operation.items ?? []).some(
    item =>
      !item.mutationCompleted ||
      item.operationUnconfirmed ||
      item.installSourceInUse ||
      (item.failedStage && !item.runtimeRecoveryPending) ||
      (item.type !== 'success' && !item.runtimeRecoveryPending),
  );

export const isPluginOperationCompletedRefreshFailure = (
  operation: Pick<PluginOperationFailure,
    'state' | 'failedStage' | 'inventoryRefreshOnly' | 'runtimeRecoveryPending' |
    'operationUnconfirmed' | 'installSourceInUse' | 'items'>,
) =>
  operation.state === PluginOperationFailureState.REFRESH_FAILED &&
  operation.failedStage === PluginOperationStage.REFRESHING_INVENTORY &&
  operation.inventoryRefreshOnly === true &&
  !operation.runtimeRecoveryPending &&
  !operation.operationUnconfirmed &&
  !operation.installSourceInUse &&
  !operation.items?.length;

export const isPluginOperationNotice = (operation: PluginOperationFailure) =>
  (operation.kind === PluginKind.EXTENSION &&
    (operation.action === PluginOperationAction.REMOVE ||
      operation.action === PluginOperationAction.ENABLE ||
      operation.action === PluginOperationAction.DISABLE) &&
    (operation.state === PluginOperationFailureState.UNCONFIRMED ||
      operation.operationUnconfirmed === true ||
      operation.installSourceInUse === true)) ||
  isPluginOperationRecoveryPending(operation) ||
  isPluginOperationCompletedRefreshFailure(operation) ||
  (operation.action === PluginOperationAction.REMOVE &&
    operation.state === PluginOperationFailureState.REFRESH_FAILED &&
    operation.failedStage === PluginOperationStage.CLEANING_PLUGIN_DATA &&
    !operation.operationUnconfirmed &&
    !operation.installSourceInUse);

const FAILURE_HISTORY_LIMIT = 100;
const safeText = (value: string, limit: number) => redactLogText(value).slice(0, limit);

class PluginOperationOwner {
  private operations: readonly ActivePluginOperation[] = [];
  private failures: readonly PluginOperationFailure[] = [];
  private readonly listeners = new Set<() => void>();
  private readonly failureListeners = new Set<() => void>();
  private stopProgress: (() => void) | undefined;
  private stopRemovalConfirmation: (() => void) | undefined;
  private readonly earlyRemovalConfirmations = new Set<string>();

  constructor(private readonly bridge: ProgressBridge) {}

  snapshot = () => this.operations;
  failureSnapshot = () => this.failures;
  subscribeFailures = (listener: () => void) => {
    this.failureListeners.add(listener);
    return () => {
      this.failureListeners.delete(listener);
    };
  };
  dismissFailure = (requestId: string) => {
    this.publishFailures(this.failures.filter(failure => failure.requestId !== requestId));
  };
  confirmRemoval = (event: ExtensionRemovalConfirmedEvent) => {
    const matches = (operation: PluginOperationOptions & { requestId: string }) =>
      operation.kind === PluginKind.EXTENSION &&
      operation.action === PluginOperationAction.REMOVE &&
      operation.requestId === event.requestId && operation.targetId === event.extensionId;
    if (this.operations.some(matches)) this.earlyRemovalConfirmations.add(event.requestId);
    let changed = false;
    const failures = this.failures.map(failure => {
      if (!matches(failure) || failure.removalConfirmed ||
          (!failure.operationUnconfirmed && failure.state !== PluginOperationFailureState.UNCONFIRMED))
        return failure;
      changed = true;
      return { ...failure, removalConfirmed: true as const };
    });
    if (changed) this.publishFailures(failures);
  };
  confirmRuntimeRecovery = (requestIds: readonly string[]) => {
    const confirmed = new Set(requestIds);
    let changed = false;
    const failures = this.failures.map(failure => {
      if (
        !confirmed.has(failure.requestId) ||
        failure.runtimeRecovered ||
        !isPluginOperationRecoveryPending(failure)
      )
        return failure;
      changed = true;
      return { ...failure, runtimeRecovered: true as const };
    });
    if (changed) this.publishFailures(failures);
  };
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private publish(operations: readonly ActivePluginOperation[]) {
    this.operations = operations;
    this.updateRemovalSubscription();
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        // Presentation observers cannot prevent or change a plugin mutation.
      }
    }
  }

  private publishFailures(failures: readonly PluginOperationFailure[]) {
    this.failures = failures;
    this.updateRemovalSubscription();
    for (const listener of this.failureListeners) {
      try {
        listener();
      } catch {
        // A result view cannot change the outcome or release a mutation lock.
      }
    }
  }

  private updateRemovalSubscription() {
    const active = this.operations.some(operation =>
      operation.kind === PluginKind.EXTENSION && operation.action === PluginOperationAction.REMOVE &&
      Boolean(operation.targetId));
    const pending = this.failures.some(operation =>
      operation.kind === PluginKind.EXTENSION && operation.action === PluginOperationAction.REMOVE &&
      !operation.removalConfirmed && Boolean(operation.targetId) &&
      (operation.operationUnconfirmed || operation.state === PluginOperationFailureState.UNCONFIRMED));
    try {
      if (!active && !pending) {
        const stop = this.stopRemovalConfirmation;
        this.stopRemovalConfirmation = undefined;
        stop?.();
      } else if (!this.stopRemovalConfirmation && this.bridge.extensions?.onRemovalConfirmed) {
        this.stopRemovalConfirmation = this.bridge.extensions.onRemovalConfirmed(this.confirmRemoval);
      }
    } catch {
      // Observing a later confirmation cannot prevent the original mutation.
    }
  }

  start(options: PluginOperationOptions) {
    if (!this.stopProgress && this.bridge.plugins?.onOperationProgress) {
      try {
        this.stopProgress = this.bridge.plugins.onOperationProgress(progress => {
          const current = this.operations.find(
            operation => operation.requestId === progress.requestId,
          );
          // Notifications are presentation only. Completed requests cannot be revived,
          // and a different operation can never borrow an existing request's state.
          if (
            !current ||
            current.kind !== progress.kind ||
            current.action !== progress.action ||
            !toPluginOperationStage(progress.stage) ||
            !Number.isFinite(progress.elapsedMs) ||
            progress.elapsedMs < 0
          )
            return;
          this.publish(
            this.operations.map(operation =>
              operation === current
                ? {
                    ...operation,
                    ...progress,
                    startedAt: Math.min(operation.startedAt, Date.now() - progress.elapsedMs),
                  }
                : operation,
            ),
          );
        });
      } catch {
        // Retain local elapsed feedback if the notification subscription fails.
      }
    }
    const context: PluginOperationContext = { requestId: crypto.randomUUID() };
    const startedAt = Date.now();
    let failure: PluginOperationFailure | undefined;
    let finished = false;
    this.publish([
      ...this.operations,
      {
        ...options,
        ...context,
        stage: PluginOperationStage.QUEUED,
        elapsedMs: 0,
        startedAt,
      },
    ]);
    return {
      context,
      stage: (stage: PluginOperationStage) => {
        if (finished) return;
        this.publish(
          this.operations.map(operation =>
            operation.requestId === context.requestId ? { ...operation, stage } : operation,
          ),
        );
      },
      fail: (input: PluginOperationFailureInput) => {
        if (finished) return;
        if (failure) {
          if (input.state === PluginOperationFailureState.REFRESH_FAILED) {
            const note = safeText(input.message, 4000);
            if (!failure.details?.includes(note)) {
              failure = {
                ...failure,
                details: [failure.details, note].filter(Boolean).join('\n\n').slice(0, 16000),
              };
            }
          }
          return;
        }
        const current = this.operations.find(
          operation => operation.requestId === context.requestId,
        );
        // Only explicit response metadata establishes a failed stage or a committed /
        // uncertain result. The last progress event may already describe rollback.
        failure = {
          ...options,
          ...context,
          label: safeText(options.label, 300),
          message: safeText(input.message, 4000),
          ...(input.details ? { details: safeText(input.details, 16000) } : {}),
          ...(input.failedStage && toPluginOperationStage(input.failedStage)
            ? { failedStage: input.failedStage }
            : {}),
          elapsedMs: Math.max(
            0,
            input.elapsedMs !== undefined && Number.isFinite(input.elapsedMs)
              ? input.elapsedMs
              : Date.now() - (current?.startedAt ?? startedAt),
          ),
          state:
            input.state ??
            (input.installationCommitted
              ? PluginOperationFailureState.COMMITTED
              : input.installSourceInUse || input.operationUnconfirmed
                ? PluginOperationFailureState.UNCONFIRMED
                : PluginOperationFailureState.FAILED),
          ...(input.installationCommitted ? { installationCommitted: true as const } : {}),
          ...(input.installSourceInUse ? { installSourceInUse: true as const } : {}),
          ...(input.operationUnconfirmed ? { operationUnconfirmed: true as const } : {}),
          ...(input.mutationCompleted ? { mutationCompleted: true as const } : {}),
          ...(input.runtimeRecoveryPending ? { runtimeRecoveryPending: true as const } : {}),
          ...(input.inventoryRefreshOnly ? { inventoryRefreshOnly: true as const } : {}),
          ...(input.items?.length
            ? {
                items: input.items.slice(0, 100).map(item => ({
                  label: safeText(item.label, 300),
                  message: safeText(item.message, 4000),
                  ...(item.type ? { type: item.type } : {}),
                  ...(item.failedStage && toPluginOperationStage(item.failedStage)
                    ? { failedStage: item.failedStage }
                    : {}),
                  ...(item.installationCommitted ? { installationCommitted: true as const } : {}),
                  ...(item.installSourceInUse ? { installSourceInUse: true as const } : {}),
                  ...(item.operationUnconfirmed ? { operationUnconfirmed: true as const } : {}),
                  ...(item.mutationCompleted ? { mutationCompleted: true as const } : {}),
                  ...(item.runtimeRecoveryPending ? { runtimeRecoveryPending: true as const } : {}),
                })),
              }
            : {}),
        };
      },
      finish: () => {
        if (finished) return;
        finished = true;
        if (failure && this.earlyRemovalConfirmations.has(context.requestId) &&
            (failure.operationUnconfirmed || failure.state === PluginOperationFailureState.UNCONFIRMED))
          failure = { ...failure, removalConfirmed: true };
        this.earlyRemovalConfirmations.delete(context.requestId);
        this.publish(
          this.operations.filter(operation => operation.requestId !== context.requestId),
        );
        if (failure) {
          // Keep the currently displayed result when bounding settled presentation data.
          const displayed =
            this.failures.find(result => !isPluginOperationNotice(result)) ??
            this.failures[0];
          const retained =
            this.failures.length >= FAILURE_HISTORY_LIMIT
              ? [
                  displayed,
                  ...this.failures
                    .filter(result => result !== displayed)
                    .slice(-(FAILURE_HISTORY_LIMIT - 2)),
                ]
              : this.failures;
          this.publishFailures([...retained, failure]);
        }
        if (!this.operations.length) {
          const stopProgress = this.stopProgress;
          this.stopProgress = undefined;
          try {
            stopProgress?.();
          } catch {
            // Feedback cleanup must not replace the actual operation result.
          }
        }
      },
    };
  }
}

const owners = new WeakMap<object, PluginOperationOwner>();

export function getPluginOperationOwner(bridge: ProgressBridge = window.electron) {
  let owner = owners.get(bridge);
  if (!owner) {
    owner = new PluginOperationOwner(bridge);
    owners.set(bridge, owner);
  }
  return owner;
}

export function startPluginOperation(options: PluginOperationOptions) {
  return getPluginOperationOwner().start(options);
}

export function reportPluginOperationFailure(
  options: PluginOperationOptions,
  failure: PluginOperationFailureInput,
) {
  const operation = startPluginOperation(options);
  operation.fail(failure);
  operation.finish();
}

export async function runPluginOperation<T>(
  options: PluginOperationOptions,
  run: (context: PluginOperationContext) => Promise<T>,
): Promise<T> {
  const operation = startPluginOperation(options);
  try {
    return await run(operation.context);
  } finally {
    operation.finish();
  }
}

export const pluginSourceLabel = (sourcePath: string) =>
  sourcePath.split(/[/\\]/).filter(Boolean).pop() || sourcePath;
