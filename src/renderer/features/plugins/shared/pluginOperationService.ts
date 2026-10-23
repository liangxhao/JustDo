import { redactLogText } from '@shared/diagnostics/redaction';
import { PluginKind } from '@shared/plugins/marketplace';
import {
  type PluginOperationAction,
  type PluginOperationContext,
  type PluginOperationProgress,
  PluginOperationStage,
  toPluginOperationStage,
} from '@shared/plugins/pluginOperation';

export interface ActivePluginOperation extends PluginOperationProgress {
  label: string;
  startedAt: number;
}

type ProgressBridge = {
  plugins?: {
    onOperationProgress: (callback: (progress: PluginOperationProgress) => void) => () => void;
  };
};

export type PluginOperationOptions = {
  kind: PluginKind;
  action: PluginOperationAction;
  label: string;
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
  items?: PluginOperationFailureInput['items'];
};

const FAILURE_HISTORY_LIMIT = 100;
const safeText = (value: string, limit: number) => redactLogText(value).slice(0, limit);

class PluginOperationOwner {
  private operations: readonly ActivePluginOperation[] = [];
  private failures: readonly PluginOperationFailure[] = [];
  private readonly listeners = new Set<() => void>();
  private readonly failureListeners = new Set<() => void>();
  private stopProgress: (() => void) | undefined;

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
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private publish(operations: readonly ActivePluginOperation[]) {
    this.operations = operations;
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
    for (const listener of this.failureListeners) {
      try {
        listener();
      } catch {
        // A result view cannot change the outcome or release a mutation lock.
      }
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
                })),
              }
            : {}),
        };
      },
      finish: () => {
        if (finished) return;
        finished = true;
        this.publish(
          this.operations.filter(operation => operation.requestId !== context.requestId),
        );
        if (failure) {
          // Keep the currently displayed result when bounding settled presentation data.
          const retained =
            this.failures.length >= FAILURE_HISTORY_LIMIT
              ? [this.failures[0], ...this.failures.slice(-(FAILURE_HISTORY_LIMIT - 2))]
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
