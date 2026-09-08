/** Model-backed compaction can run longer than ordinary Gateway requests. */
export const OPENCLAW_COMPACTION_TIMEOUT_SECONDS = 30 * 60;

/** Native manual preflight uses ok:false even for these benign no-op outcomes. */
export function isBenignCompactionNoopReason(reason: unknown): boolean {
  return reason === 'Already compacted' || reason === 'Nothing to compact (session too small)';
}
