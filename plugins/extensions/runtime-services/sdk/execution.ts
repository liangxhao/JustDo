/** Negotiated behavior guarantees. This declaration grants no native execution authority. */
export interface ManagedExecutionDescriptor {
  version: 1;
  semantics: 'caller-bound-run-v1';
  wholeRunSettlement: true;
  runToolCleanup: true;
  preciseDescribeCancel: true;
}

export const MANAGED_EXECUTION_DESCRIPTOR: Readonly<ManagedExecutionDescriptor> = Object.freeze({
  version: 1,
  semantics: 'caller-bound-run-v1',
  wholeRunSettlement: true,
  runToolCleanup: true,
  preciseDescribeCancel: true,
});

export function isManagedExecutionDescriptor(value: unknown): value is ManagedExecutionDescriptor {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return Object.keys(item).sort().join(',') ===
    'preciseDescribeCancel,runToolCleanup,semantics,version,wholeRunSettlement' &&
    item.version === 1 && item.semantics === 'caller-bound-run-v1' &&
    item.wholeRunSettlement === true && item.runToolCleanup === true &&
    item.preciseDescribeCancel === true;
}

/** A handle is fixed to one successful Runtime Services binding, never a provider lookup. */
export interface ManagedExecutionCapabilities {
  isCurrent(): boolean;
  getManagedExecutionDescriptor(): ManagedExecutionDescriptor | undefined;
}

export interface ManagedRunState {
  runId: string;
  sessionKey?: string;
  state: 'unknown' | 'accepted' | 'running' | 'settled';
  executionSettled: boolean;
  cleanupSettled: boolean;
  executionStartedAt?: number;
  executionEndedAt?: number;
  outcome?: 'ok' | 'error' | 'cancelled';
}

export interface ManagedRunInput {
  sessionKey: string;
  message: string;
  assertCurrent?: () => void;
  cwd?: string;
  idempotencyKey?: string;
  disableTools?: boolean;
  deliver?: boolean;
  extraSystemPrompt?: string;
}

type NativeRunInput<Executor> = Executor extends { run(params: infer Input): unknown }
  ? Input : ManagedRunInput;
type NativeRunResult<Executor> = Executor extends { run(...args: never[]): infer Result }
  ? Result : Promise<{ runId: string; sessionKey?: string }>;

/** Public managed protocol; all other methods retain the consumer SDK's own precise types. */
export type ManagedSubagent<Executor extends object = object> = Omit<Executor, 'run'> & {
  run(params: NativeRunInput<Executor> & {
    assertCurrent?: () => void;
    timeoutSeconds?: number;
    managedToolsLifetime: 'run';
  }): NativeRunResult<Executor>;
  describeRun(params: { runId: string }): Promise<ManagedRunState>;
  cancelRun(params: { runId: string }): Promise<{ accepted: boolean }>;
};

/** All effects still use the consumer's original scoped executor and original receiver. */
export function managedSubagent<Executor extends object>(
  api: { runtime: { subagent: Executor }; lifecycle: { signal?: AbortSignal } },
  capability: ManagedExecutionCapabilities | undefined,
): ManagedSubagent<Executor> {
  const assertCurrent = () => {
    if (!api.lifecycle.signal || api.lifecycle.signal.aborted || !capability?.isCurrent() ||
        !isManagedExecutionDescriptor(capability.getManagedExecutionDescriptor()))
      throw new Error('Managed execution capability is unavailable or retired.');
  };
  assertCurrent();
  const executor = api.runtime.subagent;
  const extended = executor as unknown as Record<string, unknown>;
  for (const method of ['run', 'describeRun', 'cancelRun'])
    if (typeof extended[method] !== 'function')
      throw new Error('The native executor does not implement managed execution.');
  const methods = new Map<PropertyKey, (...args: unknown[]) => unknown>();
  return new Proxy(executor, {
    get(target, key) {
      const value: unknown = Reflect.get(target, key, target);
      if (typeof value !== 'function') return value;
      let method = methods.get(key);
      if (!method) {
        method = (...args: unknown[]) => {
          assertCurrent();
          if (key === 'run' && args[0] && typeof args[0] === 'object') {
            const input = args[0] as Record<string, unknown>;
            const callerAssertCurrent = input.assertCurrent;
            args = [{
              ...input,
              assertCurrent() {
                // Native admission may await preparation before invoking this fence.
                assertCurrent();
                if (typeof callerAssertCurrent === 'function')
                  Reflect.apply(callerAssertCurrent, input, []);
              },
            }, ...args.slice(1)];
          }
          // This is the effect boundary. Synchronous failures and rejected promises
          // propagate without retry or any claim that invocation did not occur.
          return Reflect.apply(value, target, args);
        };
        methods.set(key, method);
      }
      return method;
    },
  }) as ManagedSubagent<Executor>;
}
