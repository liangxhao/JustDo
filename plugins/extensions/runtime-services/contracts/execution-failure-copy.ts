const MAX_FAILURE_COPY_LENGTH = 4_096;
const NATIVE_ERROR_PREFIXES = /^(?:Error: |Your request couldn't be completed: |⚠️ ){1,3}/u;
const CONTEXT_OVERFLOW_COPY =
  'Context overflow: prompt too large for the model. Try /reset (or /new) to start a fresh session, or use a larger-context model.';
// The locked native auto-reply context-overflow recovery has this alternate display copy.
const CONTEXT_OVERFLOW_RECOVERY_COPY =
  'Auto-compaction could not recover this turn. I kept this conversation mapped to the current session. Please try again, use /compact, or use /new to start a fresh session.' +
  '\n\nTry starting a fresh session or using a model with a larger context window.';

export function normalizeExecutionFailureCopy(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > MAX_FAILURE_COPY_LENGTH) return;
  const copy = value.trim().replace(NATIVE_ERROR_PREFIXES, '');
  return copy === CONTEXT_OVERFLOW_RECOVERY_COPY ? CONTEXT_OVERFLOW_COPY : copy || undefined;
}
