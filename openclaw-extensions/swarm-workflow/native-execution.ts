import type { OpenClawPluginApi } from 'openclaw/plugin-sdk/core';

type Subagent = OpenClawPluginApi['runtime']['subagent'];
/** Trusted local proof: preparation failed before invoking the native run API. */
export class NativeLaunchNotInvokedError extends Error {
  constructor(cause: unknown) {
    super(String(cause), { cause });
    this.name = 'NativeLaunchNotInvokedError';
  }
}
export type ManagedRunState = {
  runId: string;
  sessionKey?: string;
  state: 'unknown' | 'accepted' | 'running' | 'settled';
  executionSettled: boolean;
  cleanupSettled: boolean;
  executionStartedAt?: number;
  executionEndedAt?: number;
  outcome?: 'ok' | 'error' | 'cancelled';
};
// The new SDK capability is supplied by the locked runtime patch. Keeping its
// contract explicit here also permits building against the pristine upstream SDK.
export type ManagedSubagent = Omit<Subagent, 'run'> & {
  run(
    params: Parameters<Subagent['run']>[0] & {
      timeoutSeconds?: number;
      managedToolsLifetime: 'run';
    },
  ): ReturnType<Subagent['run']>;
  describeRun(params: { runId: string }): Promise<ManagedRunState>;
  cancelRun(params: { runId: string }): Promise<{ accepted: boolean }>;
};
export function managedSubagent(api: OpenClawPluginApi): ManagedSubagent {
  const runtime = api.runtime.subagent as ManagedSubagent;
  if (typeof runtime.describeRun !== 'function' || typeof runtime.cancelRun !== 'function')
    throw new Error(
      'Managed Swarm Workflow execution requires the current prepared OpenClaw runtime. Rebuild from the locked pristine package.',
    );
  return runtime;
}
