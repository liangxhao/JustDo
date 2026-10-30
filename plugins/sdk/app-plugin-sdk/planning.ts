export const PlanningConstraint = {
  Unrestricted: 'unrestricted',
  Planning: 'planning',
  Review: 'review',
  Unknown: 'unknown',
} as const;
export type PlanningConstraint = (typeof PlanningConstraint)[keyof typeof PlanningConstraint];

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const PLAN_PLUGIN_ID = 'plan-mode';
export interface PlanningSessionIdentity {
  sessionKey: string;
  nativeSessionId: string;
  lifecycleRevision: string | null;
}
export interface PlanningSnapshot extends PlanningSessionIdentity {
  planning: PlanningConstraint;
}

export function hasUnrestrictedPlanningSnapshot(
  value: unknown,
  expected: PlanningSessionIdentity,
): value is PlanningSnapshot {
  return record(value) && value.sessionKey === expected.sessionKey &&
    value.nativeSessionId === expected.nativeSessionId &&
    value.lifecycleRevision === expected.lifecycleRevision &&
    value.planning === PlanningConstraint.Unrestricted;
}

export interface PlanningNamespaceReadInput extends PlanningSessionIdentity {
  pluginId: string;
  namespace: string;
}
export type PlanningNamespaceReader = (input: PlanningNamespaceReadInput) => Promise<unknown>;

/**
 * The caller supplies an authenticated exact-native namespace reader. A public
 * sessions.describe projection can omit failed namespaces and cannot prove absence.
 * No Runtime Services implementation or transport is imported by this pure codec.
 */
export async function readPlanningSnapshot(
  readNamespace: PlanningNamespaceReader,
  identity: PlanningSessionIdentity,
): Promise<PlanningSnapshot> {
  const snapshot = await readNamespace({ ...identity, pluginId: PLAN_PLUGIN_ID, namespace: 'state' });
  let planning: PlanningConstraint = PlanningConstraint.Unknown;
  if (record(snapshot) && snapshot.sessionKey === identity.sessionKey &&
      snapshot.nativeSessionId === identity.nativeSessionId &&
      snapshot.lifecycleRevision === identity.lifecycleRevision &&
      snapshot.pluginId === PLAN_PLUGIN_ID && snapshot.namespace === 'state') {
    if (snapshot.present === false && !Object.hasOwn(snapshot, 'value'))
      planning = PlanningConstraint.Unrestricted;
    else if (snapshot.present === true && Object.hasOwn(snapshot, 'value') && snapshot.value !== undefined)
      planning = readPlanningState(snapshot.value);
  }
  return { ...identity, planning };
}

/** Only call after a successful, identity-checked native snapshot read. */
export function readPlanningState(value: unknown): PlanningConstraint {
  if (value === undefined) return PlanningConstraint.Unrestricted;
  if (!record(value) || typeof value.enabled !== 'boolean') return PlanningConstraint.Unknown;
  if (value.awaitingReview != null) return PlanningConstraint.Review;
  return value.enabled ? PlanningConstraint.Planning : PlanningConstraint.Unrestricted;
}

/** Display hint only: native projections can omit an unavailable namespace. */
export function describePlanningConstraint(extensions: unknown): PlanningConstraint {
  if (extensions === undefined) return PlanningConstraint.Unrestricted;
  if (!Array.isArray(extensions)) return PlanningConstraint.Unknown;
  const states = extensions.filter(value =>
    record(value) && value.pluginId === PLAN_PLUGIN_ID && value.namespace === 'state',
  );
  if (states.length === 0) return PlanningConstraint.Unrestricted;
  if (states.length !== 1 || !record(states[0]) || !('value' in states[0]))
    return PlanningConstraint.Unknown;
  // An existing namespace without a readable value cannot establish absence.
  return states[0].value === undefined
    ? PlanningConstraint.Unknown
    : readPlanningState(states[0].value);
}

/** getSessionEntry({readConsistency:'latest'}) returns persisted native namespaces. */
export function nativePlanningConstraint(entry: unknown): PlanningConstraint {
  if (!record(entry)) return PlanningConstraint.Unknown;
  const extensions = entry.pluginExtensions;
  if (extensions === undefined) return PlanningConstraint.Unrestricted;
  if (!record(extensions)) return PlanningConstraint.Unknown;
  if (!Object.hasOwn(extensions, PLAN_PLUGIN_ID)) return PlanningConstraint.Unrestricted;
  const plan = extensions[PLAN_PLUGIN_ID];
  if (!record(plan) || !Object.hasOwn(plan, 'state') || plan.state === undefined)
    return PlanningConstraint.Unknown;
  return readPlanningState(plan.state);
}
