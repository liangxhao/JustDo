import { randomUUID } from 'node:crypto';

import { getSessionEntry } from 'openclaw/plugin-sdk/session-store-runtime';

import { AgentTeamLaunchLedger } from './agent-team-launch-ledger';
import type { ExecutionAdmissionSnapshot } from '@runtime-services/sdk/admission';

export const NAMESPACE = 'agent-team-launch';
const OWNER_KEY = Symbol.for('agent-team.launch.owner');
const OPERATIONS_KEY = Symbol.for('agent-team.launch.operations');
const processState = globalThis as typeof globalThis & {
  [OWNER_KEY]?: string;
  [OPERATIONS_KEY]?: {
    locks: Map<string, Promise<unknown>>;
    revoked: Map<string, string>;
    uncertain: Set<string>;
  };
};
// Scoped hook registrations share a process owner. A fresh process never trusts
// a persisted verification from its predecessor.
export const OWNER = (processState[OWNER_KEY] ??= randomUUID());
export const OPERATIONS = (processState[OPERATIONS_KEY] ??= {
  locks: new Map(),
  revoked: new Map(),
  uncertain: new Set(),
});
export const MAX_CORRECTIONS = 2;
export const managed = (key: unknown): key is string =>
  typeof key === 'string' && key.length <= 1024 && /^agent:[^:]+:justdo:[^:]+$/.test(key);
export type RecordValue = Record<string, unknown>;
export const record = (value: unknown): value is RecordValue =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

export type LaunchState =
  'pending' | 'verified' | 'attempted' | 'launched' | 'cancelled' | 'released';
export type Launch = {
  generation: number;
  sessionKey: string;
  nativeSessionId: string;
  lifecycleRevision: string | null;
  clientTurnId: string;
  promptSha256: string;
  mode: 'collaboration' | 'discussion';
  owner: string;
  state: LaunchState;
  corrections: number;
  executionAdmission?: { id: string; generation: number };
  entryId?: string;
  transcriptGeneration?: string;
  wholeSettled?: {
    runId: string;
    nativeSessionId: string;
    phase: 'end' | 'error';
    seq: number;
  };
};
export type Identity = { sessionKey?: string; sessionId?: string; runId?: string };

export function parseLaunch(value: unknown): Launch | undefined {
  if (
    !record(value) ||
    !Number.isSafeInteger(value.generation) ||
    Number(value.generation) < 1 ||
    !managed(value.sessionKey) ||
    typeof value.nativeSessionId !== 'string' ||
    !value.nativeSessionId ||
    value.nativeSessionId.length > 256 ||
    typeof value.clientTurnId !== 'string' ||
    !value.clientTurnId ||
    value.clientTurnId.length > 256 ||
    typeof value.promptSha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.promptSha256) ||
    !['collaboration', 'discussion'].includes(String(value.mode)) ||
    !(
      value.lifecycleRevision === null ||
      (typeof value.lifecycleRevision === 'string' && value.lifecycleRevision.length <= 256)
    ) ||
    typeof value.owner !== 'string' ||
    !/^[a-f0-9-]{36}$/.test(value.owner) ||
    !['pending', 'verified', 'attempted', 'launched', 'cancelled', 'released'].includes(
      String(value.state),
    ) ||
    !Number.isInteger(value.corrections) ||
    Number(value.corrections) < 0 ||
    Number(value.corrections) > MAX_CORRECTIONS ||
    (value.executionAdmission !== undefined && (!record(value.executionAdmission) ||
      typeof value.executionAdmission.id !== 'string' || !value.executionAdmission.id ||
      !Number.isSafeInteger(value.executionAdmission.generation) || Number(value.executionAdmission.generation) < 1)) ||
    [value.entryId, value.transcriptGeneration].some(
      item => item !== undefined && (typeof item !== 'string' || !item || item.length > 256),
    ) ||
    (value.wholeSettled !== undefined &&
      (!record(value.wholeSettled) ||
        value.wholeSettled.runId !== value.clientTurnId ||
        value.wholeSettled.nativeSessionId !== value.nativeSessionId ||
        !['end', 'error'].includes(String(value.wholeSettled.phase)) ||
        !Number.isSafeInteger(value.wholeSettled.seq) ||
        Number(value.wholeSettled.seq) < 0))
  )
    return undefined;
  // Project closed metadata. Gateway parameters, text, and arbitrary sibling
  // extension data must never be mirrored into this native namespace.
  return {
    generation: Number(value.generation),
    sessionKey: value.sessionKey,
    nativeSessionId: value.nativeSessionId,
    lifecycleRevision: value.lifecycleRevision,
    clientTurnId: value.clientTurnId,
    promptSha256: value.promptSha256,
    mode: value.mode as Launch['mode'],
    owner: value.owner,
    state: value.state as LaunchState,
    corrections: Number(value.corrections),
    ...(value.executionAdmission === undefined ? {} : { executionAdmission: value.executionAdmission as Launch['executionAdmission'] }),
    ...(value.entryId === undefined ? {} : { entryId: value.entryId as string }),
    ...(value.transcriptGeneration === undefined
      ? {}
      : { transcriptGeneration: value.transcriptGeneration as string }),
    ...(value.wholeSettled === undefined
      ? {}
      : {
          wholeSettled: {
            runId: value.clientTurnId,
            nativeSessionId: value.nativeSessionId,
            phase: (value.wholeSettled as RecordValue).phase as 'end' | 'error',
            seq: Number((value.wholeSettled as RecordValue).seq),
          },
        }),
  };
}

export function nativeEntry(sessionKey: string): RecordValue | undefined {
  return getSessionEntry({ sessionKey, readConsistency: 'latest' }) as RecordValue | undefined;
}
export function readLaunch(
  sessionKey: string,
  ledger: AgentTeamLaunchLedger,
): { raw?: unknown; launch?: Launch } {
  const raw = ledger.read(sessionKey);
  if (raw !== undefined) {
    const launch = parseLaunch(raw);
    return { raw, launch: launch?.sessionKey === sessionKey ? launch : undefined };
  }
  const entry = nativeEntry(sessionKey);
  const extensions = record(entry?.pluginExtensions) ? entry.pluginExtensions : undefined;
  const state = record(extensions?.['agent-team'])
    ? extensions['agent-team']
    : undefined;
  const projected = state?.[NAMESPACE];
  const launch = parseLaunch(projected);
  // Native forks may copy extension metadata. A locator for another source is
  // not an intent for this conversation. Same-key incarnation drift stays unknown.
  return projected === undefined || (launch && launch.sessionKey !== sessionKey)
    ? {}
    : { raw: { unconfirmedProjection: true } };
}
export function assertNativeIdentity(launch: Launch, ctx?: Identity): void {
  const entry = nativeEntry(launch.sessionKey);
  if (
    entry?.sessionId !== launch.nativeSessionId ||
    (entry.lifecycleRevision ?? null) !== launch.lifecycleRevision ||
    (ctx &&
      (ctx.sessionKey !== launch.sessionKey ||
        ctx.sessionId !== launch.nativeSessionId ||
        ctx.runId !== launch.clientTurnId))
  )
    throw new Error('Agent Team launch identity is unconfirmed.');
}
export type TeamLaunchCatalogMode = Launch['mode'] | 'blocked' | undefined;

/** A synchronous catalog hint only; the trusted tool policy still checks the exact run. */
export function readTeamLaunchCatalogMode(
  stateDir: string,
  source: { sessionKey: string; sessionId?: string },
  admission?: ExecutionAdmissionSnapshot,
): TeamLaunchCatalogMode {
  if (!managed(source.sessionKey)) return;
  try {
    const ledger = new AgentTeamLaunchLedger(stateDir);
    const key = `${ledger.directory}:${source.sessionKey}`;
    if (OPERATIONS.uncertain.has(key)) return 'blocked';
    const state = readLaunch(source.sessionKey, ledger);
    if (admission && admission.state !== 'clear' &&
        (admission.state !== 'held' || !state.launch?.executionAdmission ||
          admission.receipt.id !== state.launch.executionAdmission.id ||
          admission.receipt.generation !== state.launch.executionAdmission.generation)) return 'blocked';
    if (state.raw === undefined || state.launch?.state === 'released') return;
    const launch = state.launch;
    if (launch?.executionAdmission && admission !== undefined) {
      if (admission?.state === 'clear' && admission.receipt?.id === launch.executionAdmission.id &&
          admission.receipt.generation === launch.executionAdmission.generation && admission.receipt.state === 'released') return;
      if (admission?.state !== 'held' || admission.receipt.id !== launch.executionAdmission.id ||
          admission.receipt.generation !== launch.executionAdmission.generation) return 'blocked';
    }
    if (
      !launch ||
      launch.owner !== OWNER ||
      launch.state === 'cancelled' ||
      source.sessionId !== launch.nativeSessionId ||
      OPERATIONS.revoked.get(key) === `${launch.nativeSessionId}:${launch.clientTurnId}`
    )
      return 'blocked';
    assertNativeIdentity(launch);
    // Factories have no run ID. A proven settled launch can expose the tool to
    // later native work; calls from the original run remain denied by policy.
    if (
      launch.state === 'launched' &&
      launch.wholeSettled?.runId === launch.clientTurnId &&
      launch.wholeSettled?.nativeSessionId === launch.nativeSessionId
    )
      return;
    return launch.mode;
  } catch {
    return 'blocked';
  }
}

export function blocksWorkflowStartDuringTeamLaunch(
  stateDir: string,
  source: { sessionKey: string; sessionId?: string },
): boolean {
  return readTeamLaunchCatalogMode(stateDir, source) !== undefined;
}
