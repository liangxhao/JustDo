const NEUTRAL_GOAL_PHASES = new Set(['waiting', 'stopped']);

/** A host snapshot can describe an ordinary session without owning a Goal. */
export function hasBlockingGoalExecution(value: unknown): boolean {
  if (value == null) return false;
  if (typeof value !== 'object' || Array.isArray(value)) return true;
  const snapshot = value as Record<string, unknown>;
  return (
    snapshot.goalId != null ||
    typeof snapshot.phase !== 'string' ||
    !NEUTRAL_GOAL_PHASES.has(snapshot.phase) ||
    (snapshot.identityPending !== undefined && snapshot.identityPending !== false)
  );
}
