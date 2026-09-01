const MANAGED_SUBAGENT_TERMINAL_HANDOFF_PERSISTENCE_ERROR =
  'Managed subagent terminal handoff could not be persisted.';

/**
 * This is a fail-safe emitted while the runtime retains ownership of a live
 * managed session. It is useful for diagnostics, but is not an actionable
 * user-facing run failure.
 */
export function isInternalManagedSubagentHandoffError(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const normalized = value.trim().replace(/^Error:\s*/i, '');
  return normalized === MANAGED_SUBAGENT_TERMINAL_HANDOFF_PERSISTENCE_ERROR;
}
